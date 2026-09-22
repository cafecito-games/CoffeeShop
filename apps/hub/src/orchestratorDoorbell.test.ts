import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  orchestratorClientProtocolVersion,
  terminalTaskStatuses,
  validateOrchestratorClientMessage,
  validateOrchestratorHubMessage,
  type AcpAgentCapabilities,
  type ApprovalRequest,
  type ExternalOrchestratorToolName,
  type OrchestratorClientCloseReason,
  type OrchestratorClientToHub,
  type OrchestratorHubToClient,
  type Run
} from "@coffee-shop/protocol";
import {
  createExternalThreadInState,
  decideDoorbell,
  doorbellApprovalWarningMilliseconds,
  doorbellDebounceMilliseconds,
  doorbellEventKindFor,
  doorbellEventKinds,
  doorbellFactsFor,
  doorbellSummaryLimit,
  postOperatorMessageInState,
  type DoorbellFacts,
  type DoorbellRingRecord
} from "./externalOrchestrators.js";
import { createOrchestratorClientGateway, type OrchestratorClientTimers } from "./orchestratorClientGateway.js";
import { fixtureAgent, fixtureNode } from "./hubToolsTestSupport.js";
import { mintOrchestratorClient } from "./orchestratorClients.js";
import { pendingOrchestratorEvents, runContinuationPass } from "./orchestratorInbox.js";
import type { SchedulingContext } from "./scheduler.js";
import { Store } from "./store.js";
import { newThread } from "./threads.js";

const at = "2026-09-22T12:00:00.000Z";
const later = (seconds: number) => new Date(Date.parse(at) + seconds * 1000).toISOString();

async function emptyStore() {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-doorbell-"));
  const store = new Store(join(directory, "state.json"));
  await store.load();
  return store;
}

const facts = (overrides: Partial<DoorbellFacts> = {}): DoorbellFacts => ({
  threadId: "thread-one",
  title: "Auth refactor",
  pending: 1,
  throughSequence: 1,
  counts: { completed: 1, failed: 0, cancelled: 0, blocked: 0, message: 0 },
  approvals: [],
  ...overrides
});

/** Every doorbell a test observes is read back through the contract the bridge validates against. */
function ring(decision: ReturnType<typeof decideDoorbell>) {
  assert.equal(decision.kind, "ring", `expected a ring, got ${decision.kind}`);
  if (decision.kind !== "ring") throw new Error("unreachable");
  const validated = validateOrchestratorHubMessage(decision.doorbell);
  assert.equal(validated.ok, true, validated.ok ? "" : validated.reason);
  return decision;
}

test("rings an attaching orchestrator that has a backlog, from structured fields only", () => {
  const decision = ring(decideDoorbell(facts({ pending: 3, throughSequence: 7, counts: { completed: 2, failed: 0, cancelled: 0, blocked: 0, message: 1 } }), undefined, "attach", at));

  assert.equal(decision.doorbell.threadId, "thread-one");
  assert.equal(decision.doorbell.pending, 3);
  assert.equal(decision.doorbell.approvals, 0);
  assert.equal(decision.doorbell.urgent, false);
  assert.equal(decision.doorbell.summary, 'Thread "Auth refactor": 2 tasks completed, 1 message. Call get_thread_events.');
  assert.equal(decision.record.rungThroughSequence, 7);
  assert.equal(decision.record.rungAt, at);
});

test("stays quiet when a thread has neither pending events nor approvals", () => {
  const empty = facts({ pending: 0, throughSequence: 0, counts: { completed: 0, failed: 0, cancelled: 0, blocked: 0, message: 0 } });
  for (const trigger of ["attach", "change"] as const) assert.equal(decideDoorbell(empty, undefined, trigger, at).kind, "quiet");
});

test("rings at most once per debounce window and reports when to re-evaluate", () => {
  const first = ring(decideDoorbell(facts(), undefined, "change", at));

  const burst = decideDoorbell(facts({ pending: 4, throughSequence: 5 }), first.record, "change", later(1));
  assert.equal(burst.kind, "wait");
  if (burst.kind === "wait") assert.equal(burst.retryAfterMilliseconds, doorbellDebounceMilliseconds - 1000);

  const coalesced = ring(decideDoorbell(facts({ pending: 4, throughSequence: 5, counts: { completed: 3, failed: 1, cancelled: 0, blocked: 0, message: 0 } }), first.record, "change", later(2)));
  assert.equal(coalesced.doorbell.pending, 4, "the burst is coalesced into one ring with the current counts");
  assert.match(coalesced.doorbell.summary, /3 tasks completed, 1 task failed/);
  assert.equal(coalesced.record.rungThroughSequence, 5);
});

test("does not ring again for events the last ring already covered", () => {
  const first = ring(decideDoorbell(facts({ throughSequence: 4 }), undefined, "change", at));
  assert.equal(decideDoorbell(facts({ throughSequence: 4 }), first.record, "change", later(30)).kind, "quiet");
  assert.equal(ring(decideDoorbell(facts({ throughSequence: 5 }), first.record, "change", later(30))).kind, "ring");
});

test("rings again once for an approval nearing expiry, and never twice for the same one", () => {
  const approval = { id: "approval-one", expiresAt: later(600) };
  const first = ring(decideDoorbell(facts({ approvals: [approval] }), undefined, "attach", at));
  assert.equal(first.doorbell.urgent, true, "a pending approval is always urgent");
  assert.equal(first.doorbell.approvals, 1);
  assert.deepEqual(first.record.rungApprovalIds, ["approval-one"]);
  assert.deepEqual(first.record.warnedApprovalIds, [], "an approval far from expiry is not warned about yet");

  const quiet = decideDoorbell(facts({ approvals: [approval] }), first.record, "change", later(300));
  assert.equal(quiet.kind, "quiet", "nothing new and no near expiry stays quiet");

  const warning = later(600 - doorbellApprovalWarningMilliseconds / 1000 + 10);
  const second = ring(decideDoorbell(facts({ approvals: [approval] }), first.record, "change", warning));
  assert.match(second.doorbell.summary, /1 approval pending \(earliest expires \d\d:\d\dZ\)/);
  assert.deepEqual(second.record.warnedApprovalIds, ["approval-one"]);

  assert.equal(decideDoorbell(facts({ approvals: [approval] }), second.record, "change", later(590)).kind, "quiet", "the same approval is warned about once");
});

test("an approval that opens rings once on its own, without any journal entry", () => {
  const quiet = facts({ pending: 0, throughSequence: 0, counts: { completed: 0, failed: 0, cancelled: 0, blocked: 0, message: 0 } });
  const opened = { ...quiet, approvals: [{ id: "approval-one", expiresAt: later(3_600) }] };
  const first = ring(decideDoorbell(opened, undefined, "change", at));
  assert.equal(first.doorbell.pending, 0);
  assert.equal(first.doorbell.urgent, true);
  assert.equal(first.doorbell.summary, 'Thread "Auth refactor": 1 approval pending (earliest expires 13:00Z). Call get_thread_events.');

  assert.equal(decideDoorbell(opened, first.record, "change", later(10)).kind, "quiet", "the same approval does not ring twice");
  const second = { ...quiet, approvals: [...opened.approvals, { id: "approval-two", expiresAt: later(3_600) }] };
  const next = ring(decideDoorbell(second, first.record, "change", later(10)));
  assert.equal(next.doorbell.approvals, 2);
  assert.deepEqual(next.record.rungApprovalIds, ["approval-one", "approval-two"]);

  const resolved = { ...quiet, approvals: [] };
  assert.equal(decideDoorbell(resolved, next.record, "change", later(20)).kind, "quiet", "a resolved approval rings nothing");
});

test("an approval whose expiry the hub cannot read never triggers an expiry ring", () => {
  const approval = { id: "approval-one", expiresAt: "whenever" };
  const first = ring(decideDoorbell(facts({ approvals: [approval] }), undefined, "attach", at));
  assert.equal(first.doorbell.summary, 'Thread "Auth refactor": 1 task completed, 1 approval pending. Call get_thread_events.');
  assert.equal(decideDoorbell(facts({ approvals: [approval] }), first.record, "change", later(30)).kind, "quiet");
});

test("bounds the summary and never carries text a worker wrote", () => {
  const decision = ring(decideDoorbell(facts({
    title: `${"A very long thread title ".repeat(20)}\u0000with control characters and "quotes"`,
    pending: 9,
    throughSequence: 9,
    counts: { completed: 3, failed: 2, cancelled: 1, blocked: 2, message: 1 },
    approvals: [{ id: "approval-one", expiresAt: later(60) }]
  }), undefined, "attach", at));

  assert.ok(decision.doorbell.summary.length <= doorbellSummaryLimit, `summary is ${decision.doorbell.summary.length} characters`);
  assert.ok(!decision.doorbell.summary.includes("\u0000"), "control characters are stripped");
  assert.match(decision.doorbell.summary, /3 tasks completed, 2 tasks failed, 1 task cancelled, 2 tasks blocked, 1 message/);
});

test("every terminal task status and every message has exactly one doorbell kind", () => {
  for (const status of terminalTaskStatuses) {
    const kind = doorbellEventKindFor({ threadId: "t", sequence: 1, at, kind: "task", taskId: "task-a", status, changes: ["status"] });
    assert.ok(doorbellEventKinds.includes(kind), `${status} has no doorbell kind`);
  }
  assert.equal(doorbellEventKindFor({ threadId: "t", sequence: 1, at, kind: "message", messageId: "m", recipientKey: "orchestrator" }), "message");
  assert.equal(
    doorbellEventKindFor({ threadId: "t", sequence: 1, at, kind: "task", taskId: "task-a", status: "running", changes: ["progress"] }),
    "blocked",
    "a task that reports itself blocked while running counts as blocked"
  );
});

/** An external thread with one operator message waiting for its orchestrator. */
async function externalThreadWithBacklog() {
  const store = await emptyStore();
  let threadId = "";
  await store.transact((state) => {
    threadId = createExternalThreadInState(state, { clientId: "client-one", connectionId: "connection-one", objective: "Ship the auth refactor" }, at).thread.id;
  });
  await store.transact((state) => {
    postOperatorMessageInState(state, { threadId, body: "Please prioritize the login path" }, later(1));
  });
  return { store, threadId };
}

test("an operator message to an external thread becomes an orchestrator event and queues no run", async () => {
  const { store, threadId } = await externalThreadWithBacklog();

  const pending = store.read((state) => pendingOrchestratorEvents(state, threadId, 0));
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.kind === "message" ? pending[0]!.recipientKey : "", "orchestrator");
  const message = store.snapshot().taskMessages!.find((item) => item.threadId === threadId)!;
  assert.deepEqual(message.sender, { type: "operator" });
  assert.deepEqual(message.recipient, { type: "orchestrator" });
  assert.equal(message.body, "Please prioritize the login path");
  assert.deepEqual(store.snapshot().runs, [], "an operator message never queues a run");
});

test("replaying an operator message returns the original, and a conflicting replay is refused", async () => {
  const { store, threadId } = await externalThreadWithBacklog();
  let replay: { created: boolean } | undefined;
  await store.transact((state) => {
    replay = postOperatorMessageInState(state, { threadId, body: "Once", idempotencyKey: "key-one" }, later(2));
  });
  assert.equal(replay!.created, true);
  await store.transact((state) => {
    replay = postOperatorMessageInState(state, { threadId, body: "Once", idempotencyKey: "key-one" }, later(3));
    return false;
  });
  assert.equal(replay!.created, false);
  await store.transact((state) => {
    assert.throws(() => postOperatorMessageInState(state, { threadId, body: "Twice", idempotencyKey: "key-one" }, later(4)), /idempotency/i);
    return false;
  });
});

test("an operator message is refused for a thread no external orchestrator drives", async () => {
  const store = await emptyStore();
  await store.transact((state) => {
    state.threads = [newThread("agent-one", "An agent thread", "user", at)];
  });
  const agentThreadId = store.read((state) => state.threads![0]!.id);
  await store.transact((state) => {
    assert.throws(() => postOperatorMessageInState(state, { threadId: agentThreadId, body: "Hello" }, later(1)), /not found/i);
    assert.throws(() => postOperatorMessageInState(state, { threadId: "thread-that-never-existed", body: "Hello" }, later(1)), /not found/i);
    return false;
  });
});

const resumable: AcpAgentCapabilities = {
  protocolVersion: 1,
  loadSession: false,
  resumeSession: true,
  prompt: { image: false, audio: false, embeddedContext: false },
  mcp: { http: true, sse: false }
};

const schedulingContext = (delivered: unknown[]): SchedulingContext => ({
  connection: () => ({ protocolVersion: "4", synced: true }),
  capabilityReport: () => undefined,
  projectProfile: () => undefined,
  canDeliver: (_nodeId, message) => { delivered.push(message); return true; }
});

test("an external thread never gets a continuation run, even with an attachment and a resumable binding", async () => {
  const { store, threadId } = await externalThreadWithBacklog();
  await store.transact((state) => {
    state.agents = [fixtureAgent("agent-one", true)];
    state.nodes = [fixtureNode("node-agent-one", { harnesses: [{ ...fixtureNode("node-agent-one").harnesses[0]!, transports: ["native-cli", "acp-v1"], acp: resumable }] })];
    state.sessionBindings = [{
      id: "binding-one",
      threadId,
      agentId: "agent-one",
      nodeId: "node-agent-one",
      harnessId: "codex-cli",
      transport: "acp-v1",
      workspace: "/workspace/agent-one",
      providerSessionId: "provider-session-one",
      status: "idle",
      createdByRunId: "run-earlier",
      lastRunId: "run-earlier",
      capabilities: resumable,
      createdAt: at,
      updatedAt: at
    }];
    // A thread that is externally orchestrated but also carries an owner agent must still be
    // skipped: the orchestrator kind, not the owner field, decides who drives a thread.
    state.threads!.find((thread) => thread.id === threadId)!.ownerAgentId = "agent-one";
    state.orchestratorAttachments = [{
      id: "attachment-one", threadId, clientId: "client-one", connectionId: "connection-one",
      attachedAt: at, lastHeartbeatAt: at, status: "attached"
    }];
  });

  const delivered: unknown[] = [];
  for (const moment of [later(10), later(120)]) {
    await store.transact((state) => runContinuationPass(state, schedulingContext(delivered), moment).changed);
  }
  assert.deepEqual(store.snapshot().runs, [], "no hub-hosted orchestrator run is ever created");
  assert.deepEqual(delivered, []);
  assert.deepEqual(store.snapshot().orchestratorInboxes ?? [], [], "no wake is claimed for an external thread");

  // The same backlog, on the same placement, does wake an agent-orchestrated thread: the skip is
  // what keeps the external one quiet, not a missing agent or an unplaceable run.
  await store.transact((state) => {
    state.threads!.find((thread) => thread.id === threadId)!.orchestrator = { kind: "agent", agentId: "agent-one" };
  });
  await store.transact((state) => runContinuationPass(state, schedulingContext(delivered), later(200)).changed);
  assert.equal(store.snapshot().runs.length, 1, "an agent-orchestrated thread is still woken");
});

test("collects doorbell facts for an external thread only, counting its own pending approvals", async () => {
  const { store, threadId } = await externalThreadWithBacklog();
  await store.transact((state) => {
    const run: Run = {
      id: "run-worker", threadId, agentId: "agent-one", nodeId: "node-one", harnessId: "claude-cli", model: "sonnet",
      workspace: "/srv/work", prompt: "", status: "running", output: "", depth: 1, createdAt: at
    };
    state.runs = [run, { ...run, id: "run-elsewhere", threadId: "thread-elsewhere" }];
    const approval: ApprovalRequest = {
      id: "approval-one", harnessApprovalId: "perm-1", threadId: "", runId: "run-worker", nodeId: "node-one",
      title: "Run rm -rf /", options: [], status: "pending", requestedAt: at, expiresAt: later(120)
    };
    state.approvals = [approval, { ...approval, id: "approval-elsewhere", runId: "run-elsewhere", threadId: "thread-elsewhere" }];
    state.threads!.push(newThread("agent-one", "An agent thread", "user", at));
  });

  const collected = store.read((state) => doorbellFactsFor(state, threadId))!;
  assert.equal(collected.pending, 1);
  assert.equal(collected.counts.message, 1);
  assert.deepEqual(collected.approvals, [{ id: "approval-one", expiresAt: later(120) }], "an approval is matched through its run's thread");
  assert.ok(!JSON.stringify(collected).includes("rm -rf"), "no approval title reaches the facts");

  const agentThreadId = store.read((state) => state.threads!.find((thread) => thread.ownerAgentId === "agent-one")!.id);
  assert.equal(store.read((state) => doorbellFactsFor(state, agentThreadId)), undefined);
  assert.equal(store.read((state) => doorbellFactsFor(state, "thread-that-never-existed")), undefined);
});

class FakeTransport {
  readonly frames: OrchestratorHubToClient[] = [];
  closedWith: OrchestratorClientCloseReason | undefined;
  failing = false;

  send(payload: string) {
    if (this.failing) throw new Error("the socket is gone");
    const validated = validateOrchestratorHubMessage(JSON.parse(payload));
    assert.equal(validated.ok, true, validated.ok ? "" : validated.reason);
    if (validated.ok) this.frames.push(validated.value);
  }

  close(reason: OrchestratorClientCloseReason) {
    this.closedWith ??= reason;
  }

  doorbells() {
    return this.frames.filter((message): message is Extract<OrchestratorHubToClient, { type: "doorbell" }> => message.type === "doorbell");
  }
}

class ManualTimers implements OrchestratorClientTimers {
  private readonly pending = new Map<number, () => void>();
  private next = 1;

  setTimeout(handler: () => void) {
    const handle = this.next++;
    this.pending.set(handle, handler);
    return handle;
  }

  clearTimeout(handle: unknown) {
    this.pending.delete(handle as number);
  }

  fireAll() {
    for (const [handle, handler] of [...this.pending]) {
      this.pending.delete(handle);
      handler();
    }
  }
}

function frame(message: OrchestratorClientToHub) {
  const validated = validateOrchestratorClientMessage(message);
  assert.equal(validated.ok, true, validated.ok ? "" : validated.reason);
  return JSON.stringify(message);
}

async function gatewayHarness() {
  const store = await emptyStore();
  let secret = "";
  let clientId = "";
  await store.transact((state) => {
    const minted = mintOrchestratorClient(state, { name: "Christian's laptop", scopes: ["orchestrate"] }, at);
    secret = minted.secret;
    clientId = minted.client.id;
  });
  const timers = new ManualTimers();
  let clock = at;
  const gateway = createOrchestratorClientGateway({ store, broadcast: () => {}, now: () => clock, timers });
  store.onCommit(() => gateway.ringAttachedThreads());
  const connect = async () => {
    const transport = new FakeTransport();
    const connection = gateway.accept(transport);
    await connection.receive(frame({ type: "client.hello", protocolVersion: orchestratorClientProtocolVersion, clientId, secret }));
    return { transport, connection };
  };
  const call = async (
    connection: { receive(raw: string): Promise<void> },
    tool: ExternalOrchestratorToolName,
    argumentsValue: Record<string, unknown>
  ) => connection.receive(frame({ type: "rpc.request", requestId: `request-${Math.random().toString(36).slice(2)}`, tool, arguments: argumentsValue }));
  return { store, gateway, timers, connect, call, advance: (seconds: number) => { clock = later(seconds); } };
}

test("attaching to a thread with a backlog rings the attaching connection at once", async () => {
  const harness = await gatewayHarness();
  const { threadId } = await (async () => {
    let id = "";
    await harness.store.transact((state) => {
      id = createExternalThreadInState(state, { clientId: state.orchestratorClients![0]!.id, connectionId: "bootstrap", objective: "Ship the auth refactor" }, at).thread.id;
    });
    await harness.store.transact((state) => { postOperatorMessageInState(state, { threadId: id, body: "Prioritize login" }, at); });
    return { threadId: id };
  })();

  const first = await harness.connect();
  harness.advance(10);
  await harness.call(first.connection, "attach_thread", { threadId });

  const doorbells = first.transport.doorbells();
  assert.equal(doorbells.length, 1, "the backlog rings on attach");
  assert.equal(doorbells[0]!.threadId, threadId);
  assert.equal(doorbells[0]!.pending, 1);

  const second = await harness.connect();
  harness.advance(20);
  await harness.call(second.connection, "attach_thread", { threadId });
  assert.equal(second.transport.doorbells().length, 1, "the replacing attachment rings for the same backlog");

  harness.advance(30);
  await harness.store.transact((state) => { postOperatorMessageInState(state, { threadId, body: "And the signup path" }, later(30)); });
  assert.equal(first.transport.doorbells().length, 1, "a replaced attachment receives no further rings");
  assert.equal(second.transport.doorbells().length, 2);
});

test("a detached thread is never rung, and a failed send is not recorded as rung", async () => {
  const harness = await gatewayHarness();
  let threadId = "";
  await harness.store.transact((state) => {
    threadId = createExternalThreadInState(state, { clientId: state.orchestratorClients![0]!.id, connectionId: "bootstrap", objective: "Ship the auth refactor" }, at).thread.id;
  });
  const { transport, connection } = await harness.connect();
  await harness.call(connection, "attach_thread", { threadId });
  assert.deepEqual(transport.doorbells(), [], "an attachment with no backlog is not rung");

  transport.failing = true;
  harness.advance(10);
  await harness.store.transact((state) => { postOperatorMessageInState(state, { threadId, body: "First" }, later(10)); });
  assert.deepEqual(transport.doorbells(), []);

  transport.failing = false;
  harness.advance(30);
  await harness.store.transact((state) => { postOperatorMessageInState(state, { threadId, body: "Second" }, later(30)); });
  assert.equal(transport.doorbells().length, 1, "the ring the failed send lost is rung again for the same backlog");
  assert.equal(transport.doorbells()[0]!.pending, 2);

  harness.advance(60);
  await harness.call(connection, "detach_thread", { threadId });
  await harness.store.transact((state) => { postOperatorMessageInState(state, { threadId, body: "Third" }, later(60)); });
  assert.equal(transport.doorbells().length, 1, "a detached connection is never rung");
});

test("a burst inside the debounce window is coalesced into one later ring", async () => {
  const harness = await gatewayHarness();
  let threadId = "";
  await harness.store.transact((state) => {
    threadId = createExternalThreadInState(state, { clientId: state.orchestratorClients![0]!.id, connectionId: "bootstrap", objective: "Ship the auth refactor" }, at).thread.id;
  });
  const { transport, connection } = await harness.connect();
  await harness.call(connection, "attach_thread", { threadId });

  harness.advance(10);
  await harness.store.transact((state) => { postOperatorMessageInState(state, { threadId, body: "First" }, later(10)); });
  assert.equal(transport.doorbells().length, 1);

  for (const [index, body] of ["Second", "Third"].entries()) {
    await harness.store.transact((state) => { postOperatorMessageInState(state, { threadId, body, idempotencyKey: `burst-${index}` }, later(10)); });
  }
  assert.equal(transport.doorbells().length, 1, "the burst is debounced");

  harness.advance(13);
  harness.timers.fireAll();
  assert.equal(transport.doorbells().length, 2, "the trailing re-evaluation rings once for the whole burst");
  assert.equal(transport.doorbells()[1]!.pending, 3);
});
