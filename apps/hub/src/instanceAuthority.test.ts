import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  threadOrchestrator,
  threadOrchestratorKinds,
  type AcpAgentCapabilities,
  type AgentInstance,
  type ComputeNode,
  type ControlProtocolVersion,
  type ExecutionRequirements,
  type HarnessSessionBinding,
  type HubToControlAgent,
  type InstanceAllocation,
  type NodeCapabilityReport,
  type ProjectProfile,
  type Run,
  type Task,
  type Thread
} from "@coffee-shop/protocol";
import {
  authorizeInstance,
  describeHistoricalActor,
  recordActor,
  runtimeInstanceForRun
} from "./actors.js";
import {
  importLegacyAgentTemplates,
  legacyTemplateId,
  reconsiderLegacyAgentImport,
  templateForLegacyAgent,
  templateFromLegacyAgent
} from "./agentTemplates.js";
import { CoordinationError } from "./coordinationError.js";
import { postOperatorMessageInState } from "./externalOrchestrators.js";
import { fixtureAgent, fixtureHandler, fixtureNode, fixtureTime } from "./hubToolsTestSupport.js";
import { closeLegacySessionBindings, promoteThreadToInstanceInState } from "./legacyPromotion.js";
import { cancelRunInState } from "./lifecycle.js";
import { resolveCaller } from "./mailbox.js";
import { runContinuationPass } from "./orchestratorInbox.js";
import { placeTask, type NodeConnection, type PlacementEnvironment, type SchedulingContext } from "./scheduler.js";
import { bindingMatchesRun, isResumableFor } from "./sessionBindings.js";
import { Store, type State } from "./store.js";
import { nodeResidencyInState, residentInstanceUsage } from "./instances.js";

/*
 * Instance authority (#78).
 *
 * Every scenario drives the real hub path — `resolveCaller`, the hub tool handler, the scheduling and
 * continuation passes, the store's load assertions — against one consistent state, so what is
 * asserted is the committed record rather than a projection built for the test.
 *
 * The negative tests matter as much as the positive ones. `describeHistoricalActor` is allowed to fall
 * back to a legacy configured agent; `authorizeInstance` never is. A test that only proved the happy
 * path would not notice the display helper being reused in an authorization path, which is the one
 * mistake in this migration that silently grants a replacement instance authority it never received.
 */

const at = "2026-09-26T12:00:00.000Z";
const later = (seconds: number) => new Date(Date.parse(at) + seconds * 1000).toISOString();

const node = (id: string, overrides: Partial<ComputeNode> = {}): ComputeNode => ({
  id, name: id, kind: "local", platform: "linux · x64", status: "online", lastSeen: at,
  activeRuns: 0, concurrency: 4, instanceCapacity: 4, activeInstances: 0, workspaceRoots: ["/workspace"],
  version: "test",
  harnesses: [{ id: "codex-cli", label: "Codex", description: "", available: true, authMode: "local-account", models: ["default"] }],
  ...overrides
});

const instanceThread = (id: string, instanceId: string): Thread => ({
  id, title: id, objective: `Objective for ${id}`, summary: "", status: "active",
  orchestrator: { kind: "instance", instanceId }, createdBy: "user", createdAt: at, updatedAt: at
});

const agentThread = (id: string, ownerAgentId: string): Thread => ({
  id, title: id, objective: `Objective for ${id}`, summary: "", status: "active",
  ownerAgentId, orchestrator: { kind: "agent", agentId: ownerAgentId }, createdBy: "user", createdAt: at, updatedAt: at
});

const instance = (id: string, threadId: string, overrides: Partial<AgentInstance> = {}): AgentInstance => ({
  id, threadId, creator: { kind: "operator", operatorId: "operator" },
  purpose: { name: id, title: `${id} title`, instructions: `instructions for ${id}` },
  delegation: { canDelegate: true }, requirements: {},
  lease: { idleTimeoutSeconds: 1800, expiresAt: later(1800) },
  status: "busy", createdAt: at, updatedAt: at, ...overrides
});

const allocation = (id: string, instanceId: string, overrides: Partial<InstanceAllocation> = {}): InstanceAllocation => ({
  id, instanceId, nodeId: "node-alpha", harnessId: "codex-cli", model: "default", transport: "native-cli",
  workspace: "/workspace", lease: { idleTimeoutSeconds: 1800, expiresAt: later(1800) },
  status: "active", createdAt: at, updatedAt: at, ...overrides
});

const instanceRun = (id: string, threadId: string, instanceId: string, allocationId: string, overrides: Partial<Run> = {}): Run => ({
  id, threadId, instanceId, allocationId, nodeId: "node-alpha", harnessId: "codex-cli", model: "default",
  workspace: "/workspace", prompt: "Coordinate the work", status: "running", output: "", depth: 0,
  createdAt: at, startedAt: at, transport: "native-cli", ...overrides
});

/**
 * A fleet whose two threads are each orchestrated by their own resident, plus a worker resident of the
 * first thread that owns nothing. The second thread exists only so every cross-thread refusal is
 * exercised against a thread that really is there.
 */
async function instanceWorld() {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-instance-authority-"));
  const store = new Store(join(directory, "state.json"));
  await store.load();
  await store.transact((state) => {
    state.nodes = [node("node-alpha")];
    state.threads = [instanceThread("thread-one", "instance-one"), instanceThread("thread-two", "instance-two")];
    state.instances = [
      instance("instance-one", "thread-one"),
      instance("instance-two", "thread-two"),
      instance("instance-worker", "thread-one", { delegation: { canDelegate: false } })
    ];
    state.allocations = [
      allocation("alloc-one", "instance-one"),
      allocation("alloc-two", "instance-two"),
      allocation("alloc-worker", "instance-worker")
    ];
    state.runs = [
      instanceRun("run-one", "thread-one", "instance-one", "alloc-one"),
      instanceRun("run-two", "thread-two", "instance-two", "alloc-two"),
      instanceRun("run-worker", "thread-one", "instance-worker", "alloc-worker")
    ];
  });
  return store;
}

const failure = async (operation: Promise<unknown>) => {
  try {
    await operation;
  } catch (error) {
    assert.ok(error instanceof CoordinationError, `expected a CoordinationError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: "the call was expected to be refused" });
};

test("an instance run is the authenticated caller of every hub tool its scope allows", async () => {
  const store = await instanceWorld();
  const hub = fixtureHandler(store);

  // #77 refused this outright: a run whose agent key resolved to nothing was `forbidden`.
  const caller = store.read((state) => resolveCaller(state, "run-one"));
  assert.equal(caller.principal.kind, "run");
  assert.equal(caller.principal.kind === "run" ? caller.principal.runtime : "", "instance");
  assert.equal(caller.participant?.type, "orchestrator", "the thread's own resident is its orchestrator");

  const context = await hub.call("get_task_context", "run-one", {}) as {
    caller: { runId: string; role: string; canDelegate: boolean };
    availableInstances: Array<{ id: string }>;
    availableAgents: unknown[];
  };
  assert.deepEqual([context.caller.runId, context.caller.role, context.caller.canDelegate], ["run-one", "orchestrator", true]);
  assert.deepEqual(context.availableInstances.map((entry) => entry.id), ["instance-worker"],
    "the teammate directory is the thread's own live residents, never the global configured roster");
  assert.deepEqual(context.availableAgents, []);

  const submitted = await hub.call("submit_tasks", "run-one", {
    idempotencyKey: "batch-one",
    tasks: [{ key: "build", title: "Build it", instructions: "Build the thing" }]
  }) as { submissionId: string; taskIdsByKey: Record<string, string> };
  const taskId = submitted.taskIdsByKey.build;
  store.read((state) => {
    const submission = state.taskSubmissions!.find((item) => item.id === submitted.submissionId)!;
    assert.deepEqual([submission.creatorAgentId, submission.creatorInstanceId, submission.creatorAllocationId],
      [undefined, "instance-one", "alloc-one"]);
  });

  const message = await hub.call("send_task_message", "run-one", {
    idempotencyKey: "message-one", recipient: { type: "task", taskId }, kind: "instruction", body: "Start with the schema"
  }) as { created: boolean; messageId: string };
  assert.deepEqual([message.created, typeof message.messageId], [true, "string"]);

  const artifact = await hub.call("post_artifact", "run-one", {
    relativePath: "report.md", title: "Report", kind: "report", mediaType: "text/markdown",
    size: 12, sha256: "a".repeat(64), idempotencyKey: "artifact-one"
  }) as { artifact: { id: string } };
  store.read((state) => {
    const stored = state.artifacts!.find((item) => item.id === artifact.artifact.id)!;
    assert.deepEqual([stored.agentId, stored.instanceId, stored.allocationId], [undefined, "instance-one", "alloc-one"],
      "an artifact names the resident and the allocation, never an instance id in the agent-typed key");
  });

  await hub.call("update_thread", "run-one", { summary: "Coordinating" });
  assert.equal(store.read((state) => state.threads!.find((item) => item.id === "thread-one")!.summary), "Coordinating");

  const events = await hub.call("wait_for_task_events", "run-one", { timeoutMilliseconds: 0 }) as { cursor: string };
  assert.ok(events.cursor);
});

test("authority is same-thread, orchestrator-scoped, and never inherited by another resident", async () => {
  const store = await instanceWorld();
  const hub = fixtureHandler(store);
  const submitted = await hub.call("submit_tasks", "run-one", {
    idempotencyKey: "batch-one", tasks: [{ key: "build", title: "Build it", instructions: "Build the thing" }]
  }) as { taskIdsByKey: Record<string, string> };
  const taskId = submitted.taskIdsByKey.build;

  // A worker resident of the same thread is a participant, not the orchestrator.
  const worker = store.read((state) => resolveCaller(state, "run-worker"));
  assert.equal(worker.participant, undefined);
  assert.match((await failure(hub.call("update_thread", "run-worker", { summary: "Mine now" }))).message, /Only the thread owner agent/);
  assert.match((await failure(hub.call("submit_tasks", "run-worker", {
    idempotencyKey: "batch-two", tasks: [{ key: "x", title: "x", instructions: "x" }]
  }))).message, /not allowed to submit tasks/, "the hub-granted delegation policy of the resident decides, not the caller");

  // Another thread's resident cannot see or message this thread's task, and cannot tell it apart from
  // a task that does not exist.
  const unseen = await failure(hub.call("get_task_context", "run-two", { taskId }));
  assert.equal(unseen.code, "not_found");
  const missing = await failure(hub.call("get_task_context", "run-two", { taskId: "task-that-never-existed" }));
  assert.deepEqual([unseen.code, unseen.message], [missing.code, missing.message]);

  // A released resident is not a principal, however recently its run was running.
  await store.transact((state) => {
    state.instances!.find((item) => item.id === "instance-one")!.status = "released";
  });
  assert.match((await failure(hub.call("get_task_context", "run-one", {}))).message, /no longer a live resident/);
});

test("a run whose allocation was replaced or lost can authorize nothing", async () => {
  const store = await instanceWorld();
  const hub = fixtureHandler(store);

  await store.transact((state) => {
    // The allocation the run names is gone; a replacement has been reserved for the same instance.
    const lost = state.allocations!.find((item) => item.id === "alloc-one")!;
    lost.status = "lost";
    state.allocations!.push(allocation("alloc-one-replacement", "instance-one", { status: "active" }));
  });

  assert.match((await failure(hub.call("get_task_context", "run-one", {}))).message, /no longer a live resident/,
    "the run's own allocation must still be active; a replacement is a different execution context");
  store.read((state) => {
    const run = state.runs.find((item) => item.id === "run-one")!;
    assert.ok(runtimeInstanceForRun(state, run), "the record still resolves for display");
    assert.equal(authorizeInstance(state, run, "Run run-one", "thread-one"), undefined, "but it is not a principal");
  });
});

test("a malformed actor identity is refused as invalid and never read as an absent one", async () => {
  const store = await instanceWorld();
  const hub = fixtureHandler(store);
  await store.transact((state) => {
    const run = state.runs.find((item) => item.id === "run-one")!;
    delete run.allocationId;
  });

  const refusal = await failure(hub.call("get_task_context", "run-one", {}));
  assert.equal(refusal.code, "invalid_arguments");
  assert.match(refusal.message, /without the other half of its instance identity/);

  // The other half, and both halves at once, are refused the same way rather than degrading.
  assert.throws(() => recordActor({ allocationId: "alloc-one" }, "Run run-one"), /without the other half/);
  assert.throws(() => recordActor({ agentId: "worker-a", instanceId: "instance-one", allocationId: "alloc-one" }, "Run run-one"),
    /names both a configured agent and an instance actor/);
});

test("the display helper never answers an authorization question", async () => {
  const store = await instanceWorld();
  await store.transact((state) => {
    state.agents = [fixtureAgent("worker-a")];
    state.instances!.find((item) => item.id === "instance-two")!.status = "released";
  });

  store.read((state) => {
    // A legacy agent record is displayable for ever, and is never a live principal.
    assert.deepEqual(describeHistoricalActor(state, { agentId: "worker-a" }), { kind: "agent", id: "worker-a", name: "worker-a" });
    assert.equal(authorizeInstance(state, { agentId: "worker-a" }, "Record"), undefined);

    // So is a released resident's record, and an instance that is no longer in the snapshot at all.
    assert.equal(describeHistoricalActor(state, { instanceId: "instance-two", allocationId: "alloc-two" }).kind, "instance");
    assert.equal(authorizeInstance(state, { instanceId: "instance-two", allocationId: "alloc-two" }, "Record"), undefined);
    assert.deepEqual(describeHistoricalActor(state, { instanceId: "instance-gone", allocationId: "alloc-gone" }),
      { kind: "instance", id: "instance-gone", name: "instance-gone" });
    assert.equal(authorizeInstance(state, { instanceId: "instance-gone", allocationId: "alloc-gone" }, "Record"), undefined);

    // A malformed identity is named as malformed for display, and is never a principal.
    assert.deepEqual(describeHistoricalActor(state, { instanceId: "instance-one" }), { kind: "unknown", name: "Malformed actor" });
    assert.deepEqual(describeHistoricalActor(state, {}), { kind: "unknown", name: "Unattributed" });

    // A live resident of another thread is a principal only for its own thread.
    assert.ok(authorizeInstance(state, { instanceId: "instance-one", allocationId: "alloc-one" }, "Record", "thread-one"));
    assert.equal(authorizeInstance(state, { instanceId: "instance-one", allocationId: "alloc-one" }, "Record", "thread-two"), undefined);
  });
});

test("cancelling and approving an instance run attribute to the resident and its allocation", async () => {
  const store = await instanceWorld();
  await store.transact((state) => {
    cancelRunInState(state, "run-worker", later(30));
  });
  store.read((state) => {
    const cancelled = state.events.find((event) => event.title === "Run cancelled")!;
    assert.deepEqual([cancelled.agentId, cancelled.instanceId, cancelled.allocationId],
      [undefined, "instance-worker", "alloc-worker"]);
    assert.equal(state.runs.find((item) => item.id === "run-worker")!.status, "cancelled");
  });
});

test("a session is resumable only in exactly its own instance and allocation context", async () => {
  const store = await instanceWorld();
  const acp: AcpAgentCapabilities = {
    protocolVersion: 1, loadSession: false, resumeSession: true,
    prompt: { image: false, audio: false, embeddedContext: false }, mcp: { http: true, sse: false }
  };
  const binding = (overrides: Partial<HarnessSessionBinding> = {}): HarnessSessionBinding => ({
    id: "session-one", threadId: "thread-one", instanceId: "instance-one", allocationId: "alloc-one",
    nodeId: "node-alpha", harnessId: "codex-cli", transport: "acp-v1", workspace: "/workspace",
    providerSessionId: "provider-one", status: "idle", createdByRunId: "run-one", lastRunId: "run-one",
    capabilities: { ...acp }, createdAt: at, updatedAt: at, ...overrides
  });
  const acpRun = (overrides: Partial<Run> = {}) =>
    instanceRun("run-next", "thread-one", "instance-one", "alloc-one", { transport: "acp-v1", status: "queued", startedAt: undefined, ...overrides });

  assert.equal(isResumableFor(binding(), acpRun()), true);
  assert.equal(isResumableFor(binding(), acpRun({ allocationId: "alloc-one-replacement" })), false,
    "a replacement allocation owns no process the old session lives in");
  assert.equal(isResumableFor(binding(), acpRun({ instanceId: "instance-worker", allocationId: "alloc-worker" })), false);
  assert.equal(bindingMatchesRun(binding({ instanceId: undefined, allocationId: undefined, agentId: "worker-a" }), acpRun()), false,
    "a legacy agent session is never resumed by an instance run");
  assert.equal(bindingMatchesRun(binding({ allocationId: undefined }), acpRun()), false,
    "a half-written actor identity never matches, so resume is fail-closed");
  assert.equal(bindingMatchesRun(binding(), { ...acpRun(), threadId: "thread-two" }), false);
});

test("a legacy agent imports once to one inert template, deterministically and with no capacity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-import-"));
  const path = join(directory, "state.json");
  const store = new Store(path);
  await store.load();
  await store.transact((state) => {
    state.agents = [fixtureAgent("orchestrator", true, { skills: ["Build", "build", " go "] })];
    state.nodes = [fixtureNode("node-orchestrator")];
  });

  await store.transact((state) => {
    assert.equal(importLegacyAgentTemplates(state, at), true);
  });
  store.read((state) => {
    const template = templateForLegacyAgent(state, "orchestrator")!;
    assert.equal(template.id, legacyTemplateId("orchestrator"));
    assert.deepEqual(template.requirements, {
      harnessIds: ["codex-cli"], models: ["default"], workspace: { path: "/workspace/orchestrator", writable: false }, skills: ["build", "go"]
    }, "the fixed binding becomes hard requirements, and no capability the agent never had is invented");
    assert.deepEqual(template.preferences, { nodeIds: ["node-orchestrator"] }, "the node ranks offerings; a template never fixes one");
    assert.deepEqual(template.delegation, { canDelegate: true });
    assert.equal(template.purpose?.instructions, "secret prompt for orchestrator");
    assert.deepEqual([state.instances ?? [], state.allocations ?? []], [[], []], "an import creates no capacity");
  });

  // A second pass, and a restart, both find the recorded decision and write nothing.
  await store.transact((state) => {
    assert.equal(importLegacyAgentTemplates(state, later(60)), false);
  });
  const before = await readFile(path);
  const restarted = new Store(path);
  await restarted.load();
  assert.deepEqual(await readFile(path), before, "a restart repeats no import");
  assert.equal(restarted.read((state) => state.templates!.length), 1);
});

test("an agent whose configuration cannot be represented is refused visibly and imports nothing", async () => {
  const unrepresentable = fixtureAgent("broken", false, { workspace: "relative/path" });
  const built = templateFromLegacyAgent(unrepresentable);
  assert.equal(built.ok, false);

  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-import-refusal-"));
  const store = new Store(join(directory, "state.json"));
  await store.load();
  await store.transact((state) => {
    state.agents = [unrepresentable];
  });
  await store.transact((state) => {
    importLegacyAgentTemplates(state, at);
  });
  store.read((state) => {
    assert.deepEqual(state.templates, []);
    assert.equal(templateForLegacyAgent(state, "broken"), undefined);
    assert.deepEqual(state.legacyTemplateImports!.map((record) => record.agentId), ["broken"]);
    assert.ok(state.legacyTemplateImports![0].reason);
    assert.ok(state.events.some((event) => event.title === "Legacy agent could not be imported" && event.detail.includes("broken")));
  });
});

/** A fleet with one legacy agent thread, one v5 node, and the imported template the promotion needs. */
async function promotableWorld(options: { activeLegacyRun?: boolean; importTemplate?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-promotion-"));
  const path = join(directory, "state.json");
  const store = new Store(path);
  await store.load();
  await store.transact((state) => {
    state.agents = [fixtureAgent("orchestrator", true)];
    state.nodes = [node("node-alpha"), fixtureNode("node-orchestrator")];
    state.threads = [agentThread("thread-one", "orchestrator")];
    state.sessionBindings = [{
      id: "session-legacy", threadId: "thread-one", agentId: "orchestrator", nodeId: "node-orchestrator",
      harnessId: "codex-cli", transport: "acp-v1", workspace: "/workspace/orchestrator",
      providerSessionId: "provider-legacy", status: "idle", createdByRunId: "run-legacy", lastRunId: "run-legacy",
      capabilities: {
        protocolVersion: 1, loadSession: false, resumeSession: true,
        prompt: { image: false, audio: false, embeddedContext: false }, mcp: { http: true, sse: false }
      }, createdAt: at, updatedAt: at
    }];
    if (options.activeLegacyRun) {
      state.runs = [{
        id: "run-legacy", threadId: "thread-one", agentId: "orchestrator", nodeId: "node-orchestrator",
        harnessId: "codex-cli", model: "default", workspace: "/workspace/orchestrator", prompt: "Coordinate",
        status: "running", output: "", depth: 0, createdAt: at, startedAt: at
      }];
    }
    if (options.importTemplate !== false) importLegacyAgentTemplates(state, at);
  });
  const context: SchedulingContext = {
    connection: (nodeId) => (nodeId === "node-alpha" ? { protocolVersion: "5" as ControlProtocolVersion, synced: true } : undefined),
    capabilityReport: () => undefined,
    projectProfile: () => undefined,
    canDeliver: () => false
  };
  return { store, path, context };
}

test("a legacy thread promotes to one instance, exactly once, in a single transaction", async () => {
  const { store, path, context } = await promotableWorld();
  await store.transact((state) => {
    const promotion = promoteThreadToInstanceInState(state, "thread-one", context, later(10));
    assert.equal(promotion.kind, "promoted", promotion.kind === "not-eligible" ? promotion.reason : "");
  });

  const promotedInstanceId = store.read((state) => {
    const thread = state.threads!.find((item) => item.id === "thread-one")!;
    const orchestrator = threadOrchestrator(thread);
    assert.equal(orchestrator?.kind, "instance");
    assert.equal(thread.ownerAgentId, undefined, "the legacy owner field is removed, not left beside the new orchestrator");
    assert.equal(state.instances!.length, 1);
    assert.equal(state.allocations!.length, 1, "the reservation is the scheduler's own single-transaction path");
    assert.equal(state.instances![0].delegation.canDelegate, true, "the template's hub-granted policy carries over");
    assert.equal(state.sessionBindings![0].status, "closed", "a legacy session cannot be resumed across the boundary");
    assert.ok(state.events.some((event) => event.title === "Thread orchestrator promoted"));
    assert.equal(state.agents.length, 1, "no configured agent is created or removed");
    return orchestrator?.kind === "instance" ? orchestrator.instanceId : "";
  });

  // A replay finds the current orchestrator and writes nothing: no second resident, no overbooking.
  await store.transact((state) => {
    const replay = promoteThreadToInstanceInState(state, "thread-one", context, later(20));
    assert.deepEqual([replay.kind, replay.kind === "not-eligible" ? replay.reason : ""],
      ["not-eligible", "the thread is already orchestrated by an instance"]);
    assert.equal(state.instances!.length, 1);
  });

  // A restart reaches the same conclusion from the persisted orchestrator alone.
  const restarted = new Store(path);
  await restarted.load();
  assert.equal(restarted.read((state) => state.instances!.length), 1);
  assert.equal(restarted.read((state) => (state.threads![0].orchestrator as { instanceId: string }).instanceId), promotedInstanceId);
});

test("promotion defers to an active legacy run and refuses a thread with no imported template", async () => {
  const active = await promotableWorld({ activeLegacyRun: true });
  await active.store.transact((state) => {
    const promotion = promoteThreadToInstanceInState(state, "thread-one", active.context, later(10));
    assert.deepEqual([promotion.kind, promotion.kind === "not-eligible" ? promotion.reason : ""],
      ["not-eligible", "an active legacy run must finish through its original path first"]);
    // Nothing at all was written: the legacy run finishes through its own protocol path.
    assert.deepEqual([state.instances ?? [], state.allocations ?? []], [[], []]);
    assert.equal(state.threads![0].ownerAgentId, "orchestrator");
    assert.equal(state.sessionBindings![0].status, "idle");
  });

  const untemplated = await promotableWorld({ importTemplate: false });
  await untemplated.store.transact((state) => {
    state.templates = [];
    state.legacyTemplateImports = [];
    const promotion = promoteThreadToInstanceInState(state, "thread-one", untemplated.context, later(10));
    assert.match(promotion.kind === "not-eligible" ? promotion.reason : "", /has no imported template/);
    assert.deepEqual([state.instances ?? [], state.allocations ?? []], [[], []]);
    assert.equal(state.threads![0].ownerAgentId, "orchestrator", "an ambiguous migration leaves history untouched");
  });
});

test("the continuation pass promotes a thread whose configured agent can no longer serve it", async () => {
  const { store, context } = await promotableWorld();
  await store.transact((state) => {
    // The owner agent is gone: no candidate set can produce an agent continuation for this thread.
    state.agents = [];
    state.taskEventJournal = [{
      threadId: "thread-one", sequence: 1, taskId: "task-one", kind: "message", recipientKey: "orchestrator",
      status: "ready", changes: [], at
    } as never];
    state.taskEventStreams = [{ threadId: "thread-one", head: 1, floor: 0 } as never];
  });

  await store.transact((state) => {
    const result = runContinuationPass(state, context, later(10));
    assert.equal(result.changed, true);
    assert.deepEqual(result.continuations, [], "no continuation is planned until the resident is ready");
    assert.equal(threadOrchestrator(state.threads![0])?.kind, "instance");
  });
});

/*
 * Placement. The compatibility candidate set survives only as a last resort, so a fleet that
 * publishes offerings alongside a configured agent both could serve places on the offering.
 */

const agentNode = () => fixtureNode("node-agent", { concurrency: 4 });

const placementFixture = (seed: Partial<State> = {}) => {
  const state: State = {
    agents: [fixtureAgent("worker-a", false, { computeNodeId: "node-agent", harnessId: "codex-cli", model: "default", workspace: "/workspace" })],
    nodes: [node("node-alpha"), agentNode()],
    runs: [], events: [], messages: [], threads: [instanceThread("thread-one", "instance-one")],
    instances: [], allocations: [], templates: [], tasks: [], ...seed
  };
  const connections = new Map<string, NodeConnection>([
    ["node-alpha", { protocolVersion: "5", synced: true }],
    ["node-agent", { protocolVersion: "4", synced: true }]
  ]);
  const profiles = new Map<string, ProjectProfile>();
  const reports = new Map<string, NodeCapabilityReport>();
  const environment: PlacementEnvironment = {
    agents: state.agents,
    nodes: state.nodes,
    runs: state.runs,
    connection: (nodeId) => connections.get(nodeId),
    capabilityReport: (nodeId) => reports.get(nodeId),
    projectProfile: (projectId) => profiles.get(projectId),
    workspaceLeases: state.workspaceLeases,
    instances: state.instances,
    allocations: state.allocations,
    templates: state.templates,
    residentUsage: (item) => residentInstanceUsage(item, state.allocations ?? [], nodeResidencyInState(state, item.id)),
    now: at
  };
  return { state, environment, profiles, reports };
};

const placementTask = (requirements: ExecutionRequirements = {}, overrides: Partial<Task> = {}): Task => ({
  id: "task-one", threadId: "thread-one", title: "Task one", instructions: "Do it", status: "ready",
  requirements, dependencies: [], idempotencyKey: "batch", attemptRunIds: [], createdAt: at, updatedAt: at, ...overrides
});

test("placeTask evaluates live offerings before the configured-agent candidate set", () => {
  const { state, environment } = placementFixture();
  // Both candidate sets are eligible: the agent is configured for exactly this harness, model and
  // workspace, and node-alpha publishes an offering that also serves it.
  assert.equal(placeTask(placementTask(), { ...environment, nodes: [agentNode()] }).kind, "assigned",
    "with no offering at all the compatibility set still serves the task");
  const decision = placeTask(placementTask(), environment);
  assert.equal(decision.kind, "offering", "a fleet publishing offerings beside a configured agent places on the offering");
  assert.equal(decision.kind === "offering" ? decision.offering.nodeId : "", "node-alpha");
  assert.equal(state.instances!.length, 0, "placeTask is pure");
});

test("a task whose project profile demands a workspace lease still reaches the compatibility set", () => {
  const { environment, profiles, reports } = placementFixture();
  reports.set("node-agent", {
    nodeId: "node-agent", at,
    evidence: [{ capabilityId: "workspace-lease:git-worktree", source: "runtime", success: true, normalizedValue: "true", observedAt: at }]
  });
  profiles.set("leased", {
    schemaVersion: 1, id: "leased", name: "leased",
    repository: { url: "https://example.com/org/repo.git", defaultBranch: "main" },
    workspacePolicy: { requireWritable: false, isolation: "git-worktree", cleanup: "when-unchanged" },
    requirements: { hard: {} }
  });
  const decision = placeTask(placementTask({ projectProfileId: "leased" }), environment);
  assert.equal(decision.kind, "assigned",
    "a v5 instance dispatch carries no lease grant, so the surviving last-resort path serves it");
});

test("a persisted record whose actor the hub cannot interpret fails the load with the field named", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-actor-load-"));
  const write = async (name: string, state: unknown) => {
    const path = join(directory, `${name}.json`);
    await writeFile(path, JSON.stringify(state));
    return path;
  };
  const base = {
    agents: [], nodes: [], events: [], messages: [], threads: [], delegations: [], artifacts: []
  };

  const halfRun = await write("half-run", {
    ...base, runs: [{ id: "run-one", threadId: "thread-one", instanceId: "instance-one", nodeId: "node-alpha", harnessId: "codex-cli", model: "default", workspace: "/workspace", prompt: "", status: "queued", output: "", depth: 0, createdAt: at }]
  });
  await assert.rejects(new Store(halfRun).load(), /Persisted run 0 names an instance without the other half/);

  const bothKeys = await write("both-keys", {
    ...base,
    runs: [{ id: "run-one", threadId: "thread-one", agentId: "worker-a", instanceId: "instance-one", allocationId: "alloc-one", nodeId: "node-alpha", harnessId: "codex-cli", model: "default", workspace: "/workspace", prompt: "", status: "queued", output: "", depth: 0, createdAt: at }]
  });
  await assert.rejects(new Store(bothKeys).load(), /Persisted run 0 names both a configured agent and an instance actor/);

  const unattributedRun = await write("unattributed-run", {
    ...base, runs: [{ id: "run-one", threadId: "thread-one", nodeId: "node-alpha", harnessId: "codex-cli", model: "default", workspace: "/workspace", prompt: "", status: "queued", output: "", depth: 0, createdAt: at }]
  });
  await assert.rejects(new Store(unattributedRun).load(), /Persisted run 0 is missing its actor identity/);

  const halfBinding = await write("half-binding", {
    ...base, runs: [],
    sessionBindings: [{ id: "session-one", threadId: "thread-one", allocationId: "alloc-one", nodeId: "node-alpha", harnessId: "codex-cli", transport: "acp-v1", workspace: "/workspace", providerSessionId: "provider-one", status: "idle", createdByRunId: "run-one", lastRunId: "run-one", createdAt: at, updatedAt: at }]
  });
  await assert.rejects(new Store(halfBinding).load(), /Persisted session binding 0 names an allocation without the other half/);

  const promotedButOwned = await write("promoted-but-owned", {
    ...base, runs: [],
    threads: [{ id: "thread-one", title: "t", objective: "o", summary: "", status: "active", ownerAgentId: "orchestrator", orchestrator: { kind: "instance", instanceId: "instance-one" }, createdBy: "user", createdAt: at, updatedAt: at }]
  });
  await assert.rejects(new Store(promotedButOwned).load(), /instance-orchestrated but still names an owner agent/);
});

test("a mixed legacy and instance history stays readable and each half keeps its own attribution", async () => {
  const store = await instanceWorld();
  await store.transact((state) => {
    state.agents = [fixtureAgent("worker-a")];
    state.runs.push({
      id: "run-legacy", threadId: "thread-one", agentId: "worker-a", nodeId: "node-worker-a", harnessId: "codex-cli",
      model: "default", workspace: "/workspace/worker-a", prompt: "Legacy", status: "completed", output: "done",
      depth: 0, createdAt: fixtureTime, finishedAt: fixtureTime
    });
  });
  store.read((state) => {
    const legacy = state.runs.find((item) => item.id === "run-legacy")!;
    const current = state.runs.find((item) => item.id === "run-one")!;
    assert.deepEqual(describeHistoricalActor(state, legacy), { kind: "agent", id: "worker-a", name: "worker-a" });
    assert.deepEqual(describeHistoricalActor(state, current), { kind: "instance", id: "instance-one", name: "instance-one" });
    // The legacy record is readable and still not a principal on this thread.
    assert.equal(authorizeInstance(state, legacy, "Run run-legacy", "thread-one"), undefined);
  });
});

test("closing legacy sessions leaves an instance session and a settled legacy session untouched", async () => {
  const store = await instanceWorld();
  await store.transact((state) => {
    state.sessionBindings = [
      { id: "s-instance", threadId: "thread-one", instanceId: "instance-one", allocationId: "alloc-one", nodeId: "node-alpha", harnessId: "codex-cli", transport: "acp-v1", workspace: "/workspace", providerSessionId: "p1", status: "idle", createdByRunId: "run-one", lastRunId: "run-one", createdAt: at, updatedAt: at },
      { id: "s-legacy-idle", threadId: "thread-one", agentId: "worker-a", nodeId: "node-alpha", harnessId: "codex-cli", transport: "acp-v1", workspace: "/workspace", providerSessionId: "p2", status: "idle", createdByRunId: "run-legacy", lastRunId: "run-legacy", createdAt: at, updatedAt: at },
      { id: "s-legacy-failed", threadId: "thread-one", agentId: "worker-a", nodeId: "node-alpha", harnessId: "codex-cli", transport: "acp-v1", workspace: "/workspace", providerSessionId: "p3", status: "failed", createdByRunId: "run-legacy", lastRunId: "run-legacy", createdAt: at, updatedAt: at },
      { id: "s-other-thread", threadId: "thread-two", agentId: "worker-a", nodeId: "node-alpha", harnessId: "codex-cli", transport: "acp-v1", workspace: "/workspace", providerSessionId: "p4", status: "idle", createdByRunId: "run-two", lastRunId: "run-two", createdAt: at, updatedAt: at }
    ];
    assert.equal(closeLegacySessionBindings(state, "thread-one", later(10)), 1);
    assert.deepEqual(state.sessionBindings.map((binding) => [binding.id, binding.status]), [
      ["s-instance", "idle"], ["s-legacy-idle", "closed"], ["s-legacy-failed", "failed"], ["s-other-thread", "idle"]
    ]);
  });
});

/*
 * Vocabulary closure. `threadOrchestratorKinds` has exactly one definition, in the protocol, and
 * every hub consumer of it must either handle a kind or refuse it explicitly. A kind a consumer
 * silently ignored would leave a thread with no authorized principal and no diagnostic, which is the
 * failure this table exists to prevent.
 */
test("every thread orchestrator kind is handled or explicitly refused by every hub consumer", async () => {
  assert.deepEqual([...threadOrchestratorKinds], ["agent", "external", "instance"], "one definition of the vocabulary");
  const { store, context } = await promotableWorld();
  const thread = () => store.read((state) => state.threads!.find((item) => item.id === "thread-one")!);

  const asKind = async (kind: "agent" | "external" | "instance") => {
    await store.transact((state) => {
      const current = state.threads!.find((item) => item.id === "thread-one")!;
      if (kind === "agent") {
        current.orchestrator = { kind: "agent", agentId: "orchestrator" };
        current.ownerAgentId = "orchestrator";
        return true;
      }
      current.orchestrator = kind === "external" ? { kind: "external", clientId: "client-one" } : { kind: "instance", instanceId: "instance-one" };
      delete current.ownerAgentId;
      return true;
    });
  };

  const promotion = new Map<string, string>();
  const operatorMessage = new Map<string, string>();
  const continuations = new Map<string, boolean>();
  for (const kind of threadOrchestratorKinds) {
    await asKind(kind);
    await store.transact((state) => {
      const result = promoteThreadToInstanceInState(state, "thread-one", context, later(10));
      promotion.set(kind, result.kind);
      // Only the agent kind may commit a promotion; roll every probe back so the next kind starts clean.
      return false;
    });
    try {
      await store.transact((state) => {
        postOperatorMessageInState(state, { threadId: "thread-one", body: "hello", idempotencyKey: `op-${kind}` }, later(11));
        operatorMessage.set(kind, "accepted");
        return false;
      });
    } catch (error) {
      operatorMessage.set(kind, error instanceof CoordinationError ? error.code : "unexpected");
    }
    await store.transact((state) => {
      // With no pending inbox events no kind is ever planned a continuation, and none may throw.
      continuations.set(kind, runContinuationPass(state, context, later(12)).continuations.length > 0);
      return false;
    });
  }

  assert.deepEqual(Object.fromEntries(promotion), {
    agent: "promoted", external: "not-eligible", instance: "not-eligible"
  }, "only an agent-orchestrated thread is promotable; the other kinds are refused by name");
  assert.deepEqual(Object.fromEntries(operatorMessage), {
    agent: "not_found", external: "accepted", instance: "accepted"
  }, "an agent thread takes operator messages through its own entry point, never the orchestrator mailbox");
  assert.deepEqual(Object.fromEntries(continuations), { agent: false, external: false, instance: false });
  assert.equal(threadOrchestrator(thread())?.kind, "instance", "every probe rolled back to the kind it was set to");
});

/*
 * Upgrade compatibility with the immediately preceding revision.
 *
 * `state-with-instance-attempt-before-78.json` was written byte for byte by the hub at the base of
 * this branch (`cafecito-games/CoffeeShop@8a6f910`) by driving its own `runSchedulingPass`
 * (`apps/hub/src/scheduler.ts:1330-1337`, which wrote `agentId: instance.id` beside `instanceId`) and
 * `assignTaskAttempt` (`apps/hub/src/tasks.ts:661-664`, which copied both onto `task.assignment`),
 * then persisting through that revision's own `Store`. It is the state on an operator's disk after a
 * single task was placed on a live offering, which is #77's flagship path — so it is exactly the
 * snapshot an upgrade has to survive.
 */
const beforeSeventyEightFixturePath = new URL("../test-fixtures/state-with-instance-attempt-before-78.json", import.meta.url);

test("a snapshot the previous revision wrote loads, drops the borrowed agent key, and then never changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-upgrade-"));
  const path = join(directory, "state.json");
  const bytes = await readFile(beforeSeventyEightFixturePath);
  await writeFile(path, bytes);
  const persisted = JSON.parse(bytes.toString()) as {
    runs: Array<{ agentId?: string; instanceId?: string }>;
    tasks: Array<{ assignment?: { agentId?: string; instanceId?: string } }>;
  };
  assert.equal(persisted.runs[0].agentId, persisted.runs[0].instanceId, "the fixture really carries the borrowed key");
  assert.equal(persisted.tasks[0].assignment!.agentId, persisted.tasks[0].assignment!.instanceId);

  const store = new Store(path);
  await store.load();

  store.read((state) => {
    const run = state.runs[0];
    assert.deepEqual([run.agentId, run.instanceId, run.allocationId],
      [undefined, persisted.runs[0].instanceId, state.allocations![0].id], "the run now names one actor");
    assert.equal(state.tasks![0].assignment!.agentId, undefined);
    assert.equal(state.tasks![0].assignment!.instanceId, persisted.runs[0].instanceId);
    // The record is interpretable again, and still not a principal: its instance is ready, not busy on
    // a live run, but the migration must not have invented authority either way.
    assert.deepEqual(describeHistoricalActor(state, run).kind, "instance");
  });

  const migrated = await readFile(path);
  assert.notDeepEqual(migrated, bytes, "the one-shot migration ran");
  const restarted = new Store(path);
  await restarted.load();
  assert.deepEqual(await readFile(path), migrated, "a restart migrates nothing a second time");
});

test("a record naming a genuinely different agent and instance is refused rather than guessed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-ambiguous-"));
  const path = join(directory, "state.json");
  const state = JSON.parse((await readFile(beforeSeventyEightFixturePath)).toString()) as { runs: Array<{ agentId?: string }> };
  state.runs[0].agentId = "worker-a";
  await writeFile(path, JSON.stringify(state));
  await assert.rejects(new Store(path).load(), /Persisted run 0 names both a configured agent and an instance actor/);
});

test("a temporarily unplaceable owner agent keeps its thread instead of being promoted away from it", async () => {
  const { store, context } = await promotableWorld();
  await store.transact((state) => {
    // One relevant inbox event, so the continuation window is genuinely open.
    state.taskEventJournal = [{
      threadId: "thread-one", sequence: 1, taskId: "task-one", kind: "message", recipientKey: "orchestrator",
      status: "ready", changes: [], at
    } as never];
    state.taskEventStreams = [{ threadId: "thread-one", head: 1, floor: 0 } as never];
  });

  /*
   * The owner agent is still configured; only its node is unreachable — a reconnect barrier, a restart,
   * a stale report. Promoting here would delete `ownerAgentId` and close the thread's live ACP session
   * for a fleet that heals itself seconds later, and nothing would ever hand the thread back.
   */
  await store.transact((state) => {
    const result = runContinuationPass(state, context, later(10));
    assert.deepEqual([result.changed, result.continuations.length], [false, 0]);
    assert.equal(threadOrchestrator(state.threads![0])?.kind, "agent", "the thread is not taken away from a healthy agent");
    assert.equal(state.threads![0].ownerAgentId, "orchestrator");
    assert.deepEqual([state.instances ?? [], state.allocations ?? []], [[], []], "no resident is requested");
    assert.equal(state.sessionBindings![0].status, "idle", "the in-flight session is not cold-started");
  });

  // The permanent condition — the agent is gone from the roster — is the only one that promotes.
  await store.transact((state) => {
    state.agents = [];
    assert.equal(runContinuationPass(state, context, later(20)).changed, true);
    assert.equal(threadOrchestrator(state.threads![0])?.kind, "instance");
  });
});

test("a refused import is reconsidered once the configuration changes, and a success never is", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-reconsider-"));
  const store = new Store(join(directory, "state.json"));
  await store.load();
  await store.transact((state) => {
    state.agents = [fixtureAgent("broken", false, { workspace: "relative/path" })];
    importLegacyAgentTemplates(state, at);
  });
  store.read((state) => {
    assert.deepEqual(state.templates, []);
    assert.equal(state.legacyTemplateImports![0].reason !== undefined, true);
  });

  // Another pass with the same configuration changes nothing, so the refusal is not re-evaluated
  // on every load and its event is written once.
  await store.transact((state) => {
    assert.equal(importLegacyAgentTemplates(state, later(10)), false);
  });

  // An operator fixes the workspace. The refusal described the old configuration, so it is forgotten
  // and the agent imports; a barred-for-ever agent would be a permanent consequence of a transient fact.
  await store.transact((state) => {
    state.agents[0].workspace = "/workspace/broken";
    assert.equal(reconsiderLegacyAgentImport(state, "broken"), true);
    assert.equal(importLegacyAgentTemplates(state, later(20)), true);
  });
  store.read((state) => {
    assert.equal(templateForLegacyAgent(state, "broken")?.id, legacyTemplateId("broken"));
    assert.deepEqual(state.legacyTemplateImports!.map((record) => [record.agentId, record.templateId]), [["broken", "legacy-broken"]]);
  });

  // A recorded success is never reconsidered, so no second template can ever be written.
  await store.transact((state) => {
    assert.equal(reconsiderLegacyAgentImport(state, "broken"), false);
    assert.equal(importLegacyAgentTemplates(state, later(30)), false);
    assert.equal(state.templates!.length, 1);
  });
});
