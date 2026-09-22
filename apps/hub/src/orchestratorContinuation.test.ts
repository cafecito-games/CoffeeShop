import assert from "node:assert/strict";
import test from "node:test";
import type { AcpAgentCapabilities, HarnessSessionBinding, HubToControlAgent, Run, Task } from "@coffee-shop/protocol";
import { fixtureHandler, fixtureNode, fixtureRun, fixtureTime, orchestrationStore, rootRunId } from "./hubToolsTestSupport.js";
import { applyRunLifecycle } from "./lifecycle.js";
import { runContinuationPass } from "./orchestratorInbox.js";
import { dispatchMessageFor, type SchedulingContext } from "./scheduler.js";
import { acceptSessionBinding } from "./sessionBindings.js";
import type { Store } from "./store.js";
import { assignTaskAttempt } from "./tasks.js";

const later = (minutes: number) => new Date(Date.parse(fixtureTime) + minutes * 60_000).toISOString();

const resumable: AcpAgentCapabilities = {
  protocolVersion: 1, loadSession: false, resumeSession: true,
  prompt: { image: false, audio: false, embeddedContext: false }, mcp: { http: true, sse: false }
};

function context(delivered: HubToControlAgent[] = []): SchedulingContext {
  return {
    connection: () => ({ protocolVersion: "4", synced: true }),
    capabilityReport: () => undefined,
    projectProfile: () => undefined,
    canDeliver: (_nodeId, message) => {
      delivered.push(message);
      return true;
    }
  };
}

function workerTask(id: string): Task {
  return {
    id, threadId: "thread-one", title: `Task ${id}`, instructions: `Do ${id}`, status: "ready", requirements: {}, dependencies: [],
    sourceRunId: rootRunId, idempotencyKey: `key-${id}`, attemptRunIds: [], createdAt: fixtureTime, updatedAt: fixtureTime
  };
}

/** A thread whose orchestrator run finished after delegating one task, which is now running. */
async function idleOrchestrator(options: { acp?: boolean } = {}) {
  const store = await orchestrationStore();
  await store.transact((state) => {
    if (options.acp) {
      const node = state.nodes.find((item) => item.id === "node-orchestrator")!;
      node.harnesses = [{ ...fixtureNode("node-orchestrator").harnesses[0], transports: ["native-cli", "acp-v1"], acp: resumable }];
    }
    state.tasks = [workerTask("task-a")];
    const attempt: Run = fixtureRun("run-task-a", "thread-one", "worker-a", { status: "queued", startedAt: undefined, depth: 1, parentRunId: rootRunId });
    assignTaskAttempt(state, "task-a", attempt, fixtureTime);
    applyRunLifecycle(state, { type: "run.started", runId: attempt.id, at: fixtureTime });
    applyRunLifecycle(state, { type: "run.completed", runId: rootRunId, output: "Delegated", at: fixtureTime });
  });
  return store;
}

async function pass(store: Store, at: string, delivered: HubToControlAgent[] = []) {
  let result: ReturnType<typeof runContinuationPass> | undefined;
  await store.transact((state) => {
    result = runContinuationPass(state, context(delivered), at);
    return result.changed;
  });
  return result!;
}

const lifecycle = (store: Store, message: Parameters<typeof applyRunLifecycle>[1]) =>
  store.transact((state) => applyRunLifecycle(state, message));

const continuationRuns = (store: Store) => store.read((state) => state.runs.filter((run) => run.id.startsWith("run_wake_")));
const inbox = (store: Store) => store.read((state) => structuredClone(state.orchestratorInboxes?.find((item) => item.threadId === "thread-one")));

test("an idle orchestrator is woken exactly once for a completed task and acknowledges by cursor", async () => {
  const store = await idleOrchestrator();
  assert.equal((await pass(store, later(1))).continuations.length, 0, "a running task needs no attention");

  await lifecycle(store, { type: "run.completed", runId: "run-task-a", output: "Parser implemented", at: later(2) });
  const first = await pass(store, later(3));
  assert.equal(first.continuations.length, 1);
  assert.equal((await pass(store, later(4))).continuations.length, 0, "an active continuation coalesces later passes");

  const [run] = continuationRuns(store);
  assert.equal(run.status, "queued");
  assert.equal(run.transport, "native-cli");
  assert.equal(run.sessionBindingId, undefined);
  assert.match(run.prompt, /durable thread context/);
  assert.match(run.prompt, /task task-a "Task task-a" is completed/);
  assert.match(run.prompt, /Parser implemented/);
  const cursor = /"cursor":"([^"]+)"/.exec(run.prompt)?.[1];
  assert.ok(cursor, "the prompt carries the acknowledgement cursor");

  await lifecycle(store, { type: "run.started", runId: run.id, at: later(5) });
  await pass(store, later(5));
  const delivered = inbox(store)!;
  assert.equal(delivered.wakes.at(-1)?.status, "delivered");
  assert.equal(delivered.wakes.at(-1)?.sessionOutcome, "native");
  assert.ok(delivered.deliveredThrough >= delivered.wakes.at(-1)!.throughSequence);
  assert.equal(delivered.processedThrough, 0, "delivery alone never marks events processed");

  const hub = fixtureHandler(store);
  await hub.call("wait_for_task_events", run.id, { cursor, timeoutMilliseconds: 0 });
  assert.equal(inbox(store)!.processedThrough, delivered.wakes.at(-1)!.throughSequence);

  await lifecycle(store, { type: "run.completed", runId: run.id, output: "Handled", at: later(6) });
  await pass(store, later(7));
  assert.equal(inbox(store)!.wakes.at(-1)?.status, "completed");
  assert.equal((await pass(store, later(8))).continuations.length, 0, "acknowledged events never wake again");
  assert.equal(continuationRuns(store).length, 1);
});

async function withIdleBinding(store: Store, overrides: Partial<HarnessSessionBinding> = {}) {
  await store.transact((state) => {
    state.sessionBindings = [{
      id: "session-previous", threadId: "thread-one", agentId: "orchestrator", nodeId: "node-orchestrator", harnessId: "codex-cli",
      transport: "acp-v1", workspace: "/workspace/orchestrator", providerSessionId: "provider-previous", status: "idle",
      createdByRunId: rootRunId, lastRunId: rootRunId, capabilities: resumable, createdAt: fixtureTime, updatedAt: fixtureTime, ...overrides
    }];
  });
}

test("a compatible idle ACP binding is resumed with the delivery-only prompt", async () => {
  const store = await idleOrchestrator({ acp: true });
  await withIdleBinding(store);
  await lifecycle(store, { type: "run.completed", runId: "run-task-a", output: "Done", at: later(2) });
  const sent: HubToControlAgent[] = [];
  assert.equal((await pass(store, later(3), sent)).continuations.length, 1);

  const [run] = continuationRuns(store);
  assert.equal(run.transport, "acp-v1");
  assert.equal(run.sessionBindingId, "session-previous");
  const dispatch = sent.find((message) => message.type === "dispatch" && message.run.id === run.id);
  assert.ok(dispatch && dispatch.type === "dispatch");
  assert.equal(dispatch.execution?.sessionBinding?.id, "session-previous");
  assert.equal(dispatch.execution?.sessionBinding?.providerSessionId, "provider-previous");
  assert.doesNotMatch(dispatch.execution?.sessionBinding?.resumePrompt ?? "", /durable thread context/);
  assert.match(dispatch.execution?.sessionBinding?.resumePrompt ?? "", /task task-a/);

  await store.transact((state) => {
    const outcome = acceptSessionBinding(state, "node-orchestrator", run.id, {
      bindingId: "session-previous", providerSessionId: "provider-previous", harnessId: "codex-cli", transport: "acp-v1", status: "active"
    }, later(4));
    assert.equal(outcome.kind, "resumed");
  });
  await lifecycle(store, { type: "run.started", runId: run.id, at: later(4), transport: { requestedTransport: "acp-v1", selectedTransport: "acp-v1", acp: resumable } });
  await pass(store, later(5));
  assert.equal(inbox(store)!.wakes.at(-1)?.sessionOutcome, "resumed");

  await lifecycle(store, { type: "run.completed", runId: run.id, output: "Handled", at: later(6) });
  const binding = store.read((state) => state.sessionBindings!.find((item) => item.id === "session-previous"));
  assert.equal(binding?.status, "idle", "a completed resumed turn leaves the session resumable");
  assert.equal(binding?.lastRunId, run.id);
});

test("a refused resume records a replacement binding and moves the run to it", async () => {
  const store = await idleOrchestrator({ acp: true });
  await withIdleBinding(store);
  await lifecycle(store, { type: "run.completed", runId: "run-task-a", output: "Done", at: later(2) });
  await pass(store, later(3));
  const [run] = continuationRuns(store);

  await store.transact((state) => {
    const outcome = acceptSessionBinding(state, "node-orchestrator", run.id, {
      providerSessionId: "provider-replacement", harnessId: "codex-cli", transport: "acp-v1", status: "active"
    }, later(4));
    assert.equal(outcome.kind, "created");
  });
  const bindings = store.read((state) => structuredClone(state.sessionBindings!));
  const previous = bindings.find((item) => item.id === "session-previous")!;
  const replacement = bindings.find((item) => item.providerSessionId === "provider-replacement")!;
  assert.equal(previous.status, "replaced");
  assert.equal(previous.replacedByBindingId, replacement.id);
  assert.equal(store.getRun(run.id)?.sessionBindingId, replacement.id);
  await lifecycle(store, { type: "run.started", runId: run.id, at: later(4) });
  await pass(store, later(5));
  assert.equal(inbox(store)!.wakes.at(-1)?.sessionOutcome, "replaced");
});

test("a binding from another node or workspace is never resumed", async () => {
  for (const overrides of [{ nodeId: "node-worker-a" }, { workspace: "/workspace/elsewhere" }, { harnessId: "claude-cli" as const }, { status: "active" as const }, { capabilities: undefined }]) {
    const store = await idleOrchestrator({ acp: true });
    await withIdleBinding(store, overrides);
    await lifecycle(store, { type: "run.completed", runId: "run-task-a", output: "Done", at: later(2) });
    await pass(store, later(3));
    const [run] = continuationRuns(store);
    assert.equal(run.sessionBindingId, undefined, JSON.stringify(overrides));
    const message = store.read((state) => dispatchMessageFor(run, state.agents[0], state.agents, state.workspaceLeases, state));
    assert.equal(message.execution?.sessionBinding, undefined);
  }
});
