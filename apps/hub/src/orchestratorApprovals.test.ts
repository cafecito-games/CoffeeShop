import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  orchestratorClientProtocolVersion,
  validateOrchestratorClientMessage,
  validateOrchestratorHubMessage,
  type ExternalOrchestratorToolName,
  type HarnessEvent,
  type HubToControlAgent,
  type OrchestratorClientScope,
  type OrchestratorClientToHub,
  type OrchestratorHubToClient,
  type Run
} from "@coffee-shop/protocol";
import { resolveApproval } from "./harnessGateway.js";
import { receiveHarnessEvent } from "./harnessGateway.js";
import { fixtureAgent, fixtureNode, fixtureRun, fixtureTime } from "./hubToolsTestSupport.js";
import { TaskEventWaiters } from "./mailbox.js";
import { createOrchestratorClientGateway, type OrchestratorClientGateway } from "./orchestratorClientGateway.js";
import { mintOrchestratorClient, revokeOrchestratorClient } from "./orchestratorClients.js";
import { createRedactor } from "./redaction.js";
import { assignTaskAttempt } from "./tasks.js";
import { Store, type State } from "./store.js";

/*
 * Scoped approval resolution by an external orchestrator.
 *
 * Every approval below is opened by a real `permission.requested` event on a real task attempt, and
 * every call is a protocol-validated frame, so nothing here exercises a shape the bridge could not
 * send or a state the hub could not reach.
 */

const at = fixtureTime;
const redactor = createRedactor([]);

/** A store that commits one hook just before its next transaction, to land a write mid-call. */
class RacingStore extends Store {
  beforeNextTransaction?: () => Promise<void>;

  override async transact(change: (state: State) => unknown) {
    const hook = this.beforeNextTransaction;
    this.beforeNextTransaction = undefined;
    if (hook) await hook();
    return super.transact(change);
  }
}

function frame(message: OrchestratorClientToHub) {
  const validated = validateOrchestratorClientMessage(message);
  assert.equal(validated.ok, true, validated.ok ? "" : validated.reason);
  return JSON.stringify(message);
}

class FakeTransport {
  readonly frames: OrchestratorHubToClient[] = [];

  send(payload: string) {
    const validated = validateOrchestratorHubMessage(JSON.parse(payload));
    assert.equal(validated.ok, true, validated.ok ? "" : validated.reason);
    if (validated.ok) this.frames.push(validated.value);
  }

  close() {}

  responseTo(requestId: string) {
    const response = this.frames.find((message) => message.type === "rpc.response" && message.requestId === requestId);
    assert.ok(response, `no response for ${requestId}`);
    return response as Extract<OrchestratorHubToClient, { type: "rpc.response" }>;
  }
}

interface Harness {
  store: RacingStore;
  gateway: OrchestratorClientGateway;
  clientId: string;
  secret: string;
  sent: Array<{ nodeId: string; message: HubToControlAgent }>;
}

async function harness(scopes: OrchestratorClientScope[] = ["orchestrate", "resolve-approvals"]): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-orchestrator-approvals-"));
  const store = new RacingStore(join(directory, "state.json"));
  await store.load();
  let secret = "";
  let clientId = "";
  await store.transact((state) => {
    const minted = mintOrchestratorClient(state, { name: "Christian's laptop", scopes }, at);
    secret = minted.secret;
    clientId = minted.client.id;
    state.agents = [fixtureAgent("worker-a", false), fixtureAgent("worker-b", false)];
    state.nodes = state.agents.map((agent) => fixtureNode(agent.computeNodeId));
  });
  const sent: Array<{ nodeId: string; message: HubToControlAgent }> = [];
  const gateway = createOrchestratorClientGateway({
    store,
    broadcast: () => undefined,
    now: () => at,
    waiters: new TaskEventWaiters(store),
    sendToControlAgent: (nodeId, message) => { sent.push({ nodeId, message }); return true; }
  });
  return { store, gateway, clientId, secret, sent };
}

interface Connected {
  transport: FakeTransport;
  connection: { receive(raw: string): Promise<void>; closed(): Promise<void> };
  connectionId: string;
}

async function connect(context: Harness): Promise<Connected> {
  const transport = new FakeTransport();
  const connection = context.gateway.accept(transport);
  await connection.receive(frame({ type: "client.hello", protocolVersion: orchestratorClientProtocolVersion, clientId: context.clientId, secret: context.secret }));
  const welcome = transport.frames.find((message) => message.type === "client.welcome");
  assert.ok(welcome && welcome.type === "client.welcome", "the hub welcomed the connection");
  return { transport, connection, connectionId: welcome.connectionId };
}

let requestCounter = 0;
async function call(peer: Connected, tool: ExternalOrchestratorToolName, argumentsValue: Record<string, unknown> = {}) {
  const requestId = `request-${requestCounter += 1}`;
  await peer.connection.receive(frame({ type: "rpc.request", requestId, tool, arguments: argumentsValue }));
  return peer.transport.responseTo(requestId);
}

const resultOf = (response: Extract<OrchestratorHubToClient, { type: "rpc.response" }>) => {
  assert.ok(!("error" in response), `unexpected error ${JSON.stringify((response as { error?: unknown }).error)}`);
  return (response as { result: any }).result;
};

const errorOf = (response: Extract<OrchestratorHubToClient, { type: "rpc.response" }>) => {
  assert.ok("error" in response, `expected an error, got ${JSON.stringify(response)}`);
  return (response as { error: { code: string; message: string } }).error;
};

const permissionRequested = (runId: string, approvalId: string, title = "Write to config.json"): HarnessEvent => ({
  type: "permission.requested",
  runId,
  sequence: 1,
  at,
  approvalId,
  toolCallId: "call-1",
  title,
  detail: "config.json, 14 lines changed",
  options: [{ id: "allow", label: "Allow once", kind: "allow-once" }, { id: "reject", label: "Reject", kind: "reject-once" }]
});

/** Starts a task's attempt as a running run of `agentId`, as the scheduler and lifecycle would. */
async function startAttempt(store: Store, taskId: string, threadId: string, agentId: string, runId: string) {
  await store.transact((state) => {
    const run: Run = fixtureRun(runId, threadId, agentId, { status: "queued", startedAt: undefined, depth: 1 });
    assignTaskAttempt(state, taskId, run, at);
    run.status = "running";
    run.startedAt = at;
  });
  return runId;
}

interface Scene {
  context: Harness;
  peer: Connected;
  threadId: string;
  taskId: string;
  runId: string;
  approvalId: string;
}

/** One external thread with one running task attempt that has raised one pending approval. */
async function scene(context = undefined as Harness | undefined, options: { key?: string } = {}): Promise<Scene> {
  const resolved = context ?? await harness();
  const peer = await connect(resolved);
  const threadId = resultOf(await call(peer, "create_thread", { objective: "Ship the auth refactor" })).thread.id as string;
  const submitted = resultOf(await call(peer, "submit_tasks", {
    threadId,
    idempotencyKey: options.key ?? "batch-1",
    tasks: [{ key: "one", title: "Write the migration", instructions: "Write the migration carefully" }]
  }));
  const taskId = submitted.taskIdsByKey.one as string;
  const runId = await startAttempt(resolved.store, taskId, threadId, "worker-a", `run-${taskId}`);
  const outcome = await receiveHarnessEvent(resolved.store, "node-worker-a", permissionRequested(runId, "acp-1"), redactor, () => true, at);
  assert.equal(outcome.kind, "accepted", "the permission request opened an approval");
  const approvalId = resolved.store.read((state) => state.approvals!.find((approval) => approval.runId === runId)!.id);
  return { context: resolved, peer, threadId, taskId, runId, approvalId };
}

const approvalIn = (store: Store, approvalId: string) =>
  store.read((state) => structuredClone((state.approvals ?? []).find((approval) => approval.id === approvalId)!));

test("list_approvals reports a thread's pending approvals with everything needed to decide", async () => {
  const { context, peer, threadId, taskId, runId, approvalId } = await scene();

  const result = resultOf(await call(peer, "list_approvals", { threadId }));

  assert.equal(result.threadId, threadId);
  assert.deepEqual(result.approvals.map((approval: { id: string }) => approval.id), [approvalId]);
  const [approval] = result.approvals;
  assert.equal(approval.taskId, taskId);
  assert.equal(approval.runId, runId);
  assert.equal(approval.title, "Write to config.json");
  assert.equal(approval.detail, "config.json, 14 lines changed");
  assert.deepEqual(approval.options.map((option: { id: string }) => option.id), ["allow", "reject"]);
  assert.equal(approval.status, "pending");
  assert.equal(approval.expiresAt, context.store.read((state) => state.approvals![0].expiresAt));
  assert.ok(!("nodeId" in approval) && !("harnessApprovalId" in approval), "hub and Barista identities stay hub-side");
});

test("list_approvals never shows a thread the connection does not hold", async () => {
  const first = await scene();
  const second = await scene(first.context, { key: "batch-2" });

  // The second connection holds only its own thread, so the first thread's approval is invisible.
  assert.equal(errorOf(await call(second.peer, "list_approvals", { threadId: first.threadId })).code, "not_attached");
  const own = resultOf(await call(second.peer, "list_approvals", { threadId: second.threadId }));
  assert.deepEqual(own.approvals.map((approval: { id: string }) => approval.id), [second.approvalId]);
});

test("a scoped orchestrator resolves an approval, and the decision reaches the run's Barista", async () => {
  const { context, peer, threadId, approvalId } = await scene();
  const attachmentId = context.store.read((state) => state.orchestratorAttachments!.find((item) => item.threadId === threadId)!.id);

  const result = resultOf(await call(peer, "resolve_approval", { approvalId, idempotencyKey: "orchestrator-1", optionId: "allow" }));

  assert.equal(result.approval.status, "approved");
  assert.equal(result.approval.selectedOptionId, "allow");
  assert.deepEqual(result.approval.resolvedBy, { kind: "orchestrator", clientId: context.clientId, attachmentId });
  const stored = approvalIn(context.store, approvalId);
  assert.deepEqual(stored.resolvedBy, { kind: "orchestrator", clientId: context.clientId, attachmentId });
  assert.equal(stored.resolutionIdempotencyKey, "orchestrator-1");
  assert.equal(stored.delivery?.status, "sent");
  assert.deepEqual(context.sent.map((entry) => entry.nodeId), ["node-worker-a"]);
  const [delivered] = context.sent;
  assert.equal(delivered.message.type, "approval.decision");
  assert.deepEqual(delivered.message.type === "approval.decision" ? delivered.message.decision : undefined, {
    approvalId: "acp-1",
    runId: stored.runId,
    status: "approved",
    selectedOptionId: "allow"
  });
});

test("an orchestrator cancellation resolves the approval as cancelled without selecting an option", async () => {
  const { context, peer, approvalId } = await scene();

  const result = resultOf(await call(peer, "resolve_approval", { approvalId, idempotencyKey: "orchestrator-1", cancel: true }));

  assert.equal(result.approval.status, "cancelled");
  assert.equal(result.approval.selectedOptionId, undefined);
  assert.equal(approvalIn(context.store, approvalId).resolvedBy!.kind, "orchestrator");
});

test("an exact replay returns the stored resolution and a different choice under the same key conflicts", async () => {
  const { context, peer, approvalId } = await scene();
  resultOf(await call(peer, "resolve_approval", { approvalId, idempotencyKey: "orchestrator-1", optionId: "allow" }));
  const resolvedAt = approvalIn(context.store, approvalId).resolvedAt;

  const replay = resultOf(await call(peer, "resolve_approval", { approvalId, idempotencyKey: "orchestrator-1", optionId: "allow" }));
  assert.equal(replay.approval.status, "approved");
  assert.equal(replay.approval.selectedOptionId, "allow");
  assert.equal(approvalIn(context.store, approvalId).resolvedAt, resolvedAt, "a replay never re-resolves");

  const contradiction = errorOf(await call(peer, "resolve_approval", { approvalId, idempotencyKey: "orchestrator-1", optionId: "reject" }));
  assert.equal(contradiction.code, "conflict");
  assert.equal(approvalIn(context.store, approvalId).selectedOptionId, "allow", "the stored choice is unchanged");
});

test("an operator and an orchestrator racing one approval produce exactly one resolution", async () => {
  const { context, peer, approvalId } = await scene();
  // The operator's resolution commits between the dispatcher's credential read and the handler's
  // transaction, so the orchestrator's call is decided against the operator's committed decision.
  context.store.beforeNextTransaction = async () => {
    const response = await resolveApproval(context.store, approvalId, { idempotencyKey: "operator-1", expectedStatus: "pending", optionId: "reject" }, () => true, at);
    assert.equal(response.status, 200);
  };

  const raced = errorOf(await call(peer, "resolve_approval", { approvalId, idempotencyKey: "orchestrator-1", optionId: "allow" }));

  assert.equal(raced.code, "conflict");
  const stored = approvalIn(context.store, approvalId);
  assert.equal(stored.status, "rejected");
  assert.deepEqual(stored.resolvedBy, { kind: "operator" });
  assert.equal(stored.resolutionIdempotencyKey, "operator-1");
  const resolutions = context.store.read((state) => state.events.filter((event) => event.title.startsWith("Approval ") && event.title !== "Approval requested"));
  assert.equal(resolutions.length, 1, "exactly one resolution was recorded");
});

test("a credential revoked between the dispatcher's read and the commit cannot resolve an approval", async () => {
  const { context, peer, approvalId } = await scene();
  context.store.beforeNextTransaction = async () => {
    await context.store.transact((state) => { revokeOrchestratorClient(state, context.clientId, at); });
  };

  const refused = errorOf(await call(peer, "resolve_approval", { approvalId, idempotencyKey: "orchestrator-1", optionId: "allow" }));

  assert.equal(refused.code, "forbidden");
  const stored = approvalIn(context.store, approvalId);
  assert.equal(stored.status, "pending", "a revoked credential never resolves an approval");
  assert.equal(stored.resolvedBy, undefined);
  assert.deepEqual(context.sent, [], "nothing was written to Barista");
});

test("a scope removed between the dispatcher's read and the commit cannot resolve an approval", async () => {
  const { context, peer, approvalId } = await scene();
  context.store.beforeNextTransaction = async () => {
    await context.store.transact((state) => {
      state.orchestratorClients!.find((client) => client.id === context.clientId)!.scopes = ["orchestrate"];
    });
  };

  const refused = errorOf(await call(peer, "resolve_approval", { approvalId, idempotencyKey: "orchestrator-1", optionId: "allow" }));

  assert.equal(refused.code, "forbidden");
  assert.equal(approvalIn(context.store, approvalId).status, "pending", "an unscoped credential never resolves an approval");
  assert.deepEqual(context.sent, [], "nothing was written to Barista");
});

test("a scope removed while attached is refused on the next call, with no cached permission", async () => {
  const { context, peer, threadId, approvalId } = await scene();
  resultOf(await call(peer, "list_approvals", { threadId }));

  await context.store.transact((state) => {
    state.orchestratorClients!.find((client) => client.id === context.clientId)!.scopes = ["orchestrate"];
  });

  assert.equal(errorOf(await call(peer, "list_approvals", { threadId })).code, "forbidden");
  assert.equal(errorOf(await call(peer, "resolve_approval", { approvalId, idempotencyKey: "orchestrator-1", optionId: "allow" })).code, "forbidden");
  assert.equal(approvalIn(context.store, approvalId).status, "pending");
});

test("the hub refuses an unscoped credential's approval calls however the bridge listed its tools", async () => {
  const context = await harness(["orchestrate"]);
  const { peer, threadId, approvalId } = await scene(context);

  assert.equal(errorOf(await call(peer, "list_approvals", { threadId })).code, "forbidden");
  assert.equal(errorOf(await call(peer, "resolve_approval", { approvalId, idempotencyKey: "orchestrator-1", optionId: "allow" })).code, "forbidden");
  assert.equal(approvalIn(context.store, approvalId).status, "pending");
});

test("an approval on another thread, on a non-task run, or on nothing at all answers not_found alike", async () => {
  const first = await scene();
  const second = await scene(first.context, { key: "batch-2" });
  await first.context.store.transact((state) => {
    state.runs.unshift(fixtureRun("run-loose", second.threadId, "worker-b", { nodeId: "node-worker-b" }));
  });
  const loose = await receiveHarnessEvent(first.context.store, "node-worker-b", permissionRequested("run-loose", "acp-loose"), redactor, () => true, at);
  assert.equal(loose.kind, "accepted");
  const looseApprovalId = first.context.store.read((state) => state.approvals!.find((approval) => approval.runId === "run-loose")!.id);

  const answers = [first.approvalId, looseApprovalId, "approval_nothing_here"].map((approvalId) => ({ approvalId }));
  const errors = [];
  for (const { approvalId } of answers) {
    errors.push(errorOf(await call(second.peer, "resolve_approval", { approvalId, idempotencyKey: `orchestrator-${approvalId}`, optionId: "allow" })));
  }

  assert.deepEqual(errors.map((error) => error.code), ["not_found", "not_found", "not_found"]);
  assert.equal(new Set(errors.map((error) => error.message)).size, 1, "no answer distinguishes an approval that exists");
  assert.equal(approvalIn(first.context.store, first.approvalId).status, "pending");
  assert.equal(approvalIn(first.context.store, looseApprovalId).status, "pending");
});

test("a connection holding no attachment cannot reach approvals at all", async () => {
  const context = await harness();
  const { threadId, approvalId } = await scene(context);
  const bystander = await connect(context);

  assert.equal(errorOf(await call(bystander, "list_approvals", { threadId })).code, "not_attached");
  assert.equal(errorOf(await call(bystander, "resolve_approval", { approvalId, idempotencyKey: "orchestrator-1", optionId: "allow" })).code, "not_attached");
  assert.equal(approvalIn(context.store, approvalId).status, "pending");
});

test("an already settled approval, an expired one, and an ended run each conflict", async () => {
  const settled = await scene();
  resultOf(await call(settled.peer, "resolve_approval", { approvalId: settled.approvalId, idempotencyKey: "orchestrator-1", optionId: "allow" }));
  assert.equal(errorOf(await call(settled.peer, "resolve_approval", { approvalId: settled.approvalId, idempotencyKey: "orchestrator-2", optionId: "allow" })).code, "conflict");

  const expired = await scene();
  await expired.context.store.transact((state) => {
    state.approvals!.find((approval) => approval.id === expired.approvalId)!.expiresAt = at;
  });
  assert.equal(errorOf(await call(expired.peer, "resolve_approval", { approvalId: expired.approvalId, idempotencyKey: "orchestrator-1", optionId: "allow" })).code, "conflict");
  assert.equal(approvalIn(expired.context.store, expired.approvalId).status, "expired");

  const ended = await scene();
  await ended.context.store.transact((state) => {
    state.runs.find((run) => run.id === ended.runId)!.status = "completed";
  });
  assert.equal(errorOf(await call(ended.peer, "resolve_approval", { approvalId: ended.approvalId, idempotencyKey: "orchestrator-1", optionId: "allow" })).code, "conflict");
});

test("a malformed resolve_approval call is refused as an argument error, never as an absent approval", async () => {
  const { context, peer, threadId, approvalId } = await scene();
  const malformed: Array<Record<string, unknown>> = [
    { approvalId, idempotencyKey: "orchestrator-1" },
    { approvalId, idempotencyKey: "orchestrator-1", optionId: "allow", cancel: true },
    { approvalId, idempotencyKey: "orchestrator-1", optionId: "allow-never-offered" },
    { approvalId, idempotencyKey: "", optionId: "allow" },
    { approvalId: "", idempotencyKey: "orchestrator-1", optionId: "allow" },
    { approvalId, idempotencyKey: "orchestrator-1", optionId: "allow", expectedStatus: "pending" },
    { approvalId, idempotencyKey: "orchestrator-1", cancel: false },
    { approvalId, idempotencyKey: "orchestrator-1", optionId: "allow", threadId }
  ];

  for (const argumentsValue of malformed) {
    assert.equal(errorOf(await call(peer, "resolve_approval", argumentsValue)).code, "invalid_arguments", JSON.stringify(argumentsValue));
  }
  assert.equal(errorOf(await call(peer, "list_approvals", { threadId, status: "pending" })).code, "invalid_arguments");
  assert.equal(errorOf(await call(peer, "list_approvals", {})).code, "invalid_arguments");
  assert.equal(approvalIn(context.store, approvalId).status, "pending");
});

test("a settled approval stays listable as recent history with who resolved it", async () => {
  const { context, peer, threadId, approvalId } = await scene();
  resultOf(await call(peer, "resolve_approval", { approvalId, idempotencyKey: "orchestrator-1", optionId: "reject" }));

  const listed = resultOf(await call(peer, "list_approvals", { threadId })).approvals;

  assert.deepEqual(listed.map((approval: { id: string }) => approval.id), [approvalId]);
  assert.equal(listed[0].status, "rejected");
  assert.equal(listed[0].selectedOptionId, "reject");
  assert.equal(listed[0].resolvedBy.kind, "orchestrator");
  assert.equal(listed[0].resolvedBy.clientId, context.clientId);
});
