import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Agent, ComputeNode, HarnessEvent, HubToControlAgent, Run } from "@coffee-shop/protocol";
import { deliverApprovalDecisions, expireDueApprovals, receiveApprovalUndeliverable, receiveHarnessEvent, reconcileApprovals, resolveApproval } from "./harnessGateway.js";
import { applyRunLifecycle, cancelPersistedRun } from "./lifecycle.js";
import { createRedactor } from "./redaction.js";
import { Store, type State } from "./store.js";

const at = "2026-09-21T12:00:00.000Z";
const later = (seconds: number) => new Date(Date.parse(at) + seconds * 1000).toISOString();
const redactor = createRedactor(["hub-enrollment-secret"]);

function agent(): Agent {
  return {
    id: "agent-one", name: "Milo", title: "Builder", summary: "Builds", glyph: "M", avatarShape: "cup", avatarColor: "amber",
    state: "working", currentAction: "Working", harnessId: "codex-cli", model: "gpt-5", computeNodeId: "node-one",
    workspace: "/workspace", systemPrompt: "Build", unread: 0, updatedAt: at
  };
}

function node(): ComputeNode {
  return {
    id: "node-one", name: "Desk", kind: "local", platform: "darwin", status: "online", lastSeen: at,
    activeRuns: 1, concurrency: 2, workspaceRoots: ["/workspace"], harnesses: [], version: "test"
  };
}

function run(): Run {
  return {
    id: "run-one", threadId: "thread-one", agentId: "agent-one", nodeId: "node-one", harnessId: "codex-cli", model: "gpt-5",
    workspace: "/workspace", prompt: "Build it", status: "running", output: "", depth: 0, createdAt: at, startedAt: at
  };
}

async function storeWithRunningRun() {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-harness-"));
  const store = new Store(join(directory, "state.json"));
  await store.load();
  await store.transact((state) => {
    state.agents.push(agent());
    state.nodes.push(node());
    state.runs.push(run());
  });
  return store;
}

function recordingSender(online = true) {
  const sent: Array<{ nodeId: string; message: HubToControlAgent }> = [];
  const sender = { online, sent, send: (nodeId: string, message: HubToControlAgent) => {
    if (!sender.online) return false;
    sent.push({ nodeId, message });
    return true;
  } };
  return sender;
}

const permissionRequested = (sequence: number, approvalId = "acp-permission-1"): HarnessEvent => ({
  type: "permission.requested", runId: "run-one", sequence, at, approvalId, toolCallId: "call-1", title: "Run tests",
  options: [{ id: "allow", label: "Allow once", kind: "allow-once" }, { id: "reject", label: "Reject", kind: "reject-once" }]
});

const permissionResolved = (sequence: number, status: "approved" | "rejected" | "cancelled" | "expired", selectedOptionId?: string): HarnessEvent => {
  const event: HarnessEvent = { type: "permission.resolved", runId: "run-one", sequence, at, approvalId: "acp-permission-1", status };
  if (selectedOptionId) event.selectedOptionId = selectedOptionId;
  return event;
};

const messageDelta = (sequence: number, text: string): HarnessEvent => ({ type: "message.delta", runId: "run-one", sequence, at, text });

const approvalOf = (store: Store) => store.read((state) => structuredClone(state.approvals![0]));

async function pendingApproval(store: Store, sender = recordingSender()) {
  const outcome = await receiveHarnessEvent(store, "node-one", permissionRequested(1), redactor, sender.send, at);
  assert.equal(outcome.kind, "accepted");
  return approvalOf(store);
}

test("a permission request becomes a pending approval bound to its run, node, and session", async () => {
  const store = await storeWithRunningRun();
  const approval = await pendingApproval(store);
  assert.equal(approval.status, "pending");
  assert.equal(approval.harnessApprovalId, "acp-permission-1");
  assert.notEqual(approval.id, approval.harnessApprovalId);
  assert.equal(approval.runId, "run-one");
  assert.equal(approval.nodeId, "node-one");
  assert.equal(approval.threadId, "thread-one");
  assert.equal(approval.toolCallId, "call-1");
  assert.equal(approval.expiresAt, later(9 * 60));
  assert.deepEqual(approval.options.map((option) => option.id), ["allow", "reject"]);
});

test("an operator approval is persisted, delivered to the owning Barista, and confirmed by the harness", async () => {
  const store = await storeWithRunningRun();
  const sender = recordingSender();
  const approval = await pendingApproval(store, sender);

  const response = await resolveApproval(store, approval.id, { idempotencyKey: "operator-1", expectedStatus: "pending", optionId: "allow" }, sender.send, later(5));
  assert.equal(response.status, 200);
  assert.deepEqual(sender.sent, [{ nodeId: "node-one", message: { type: "approval.decision", decision: { approvalId: "acp-permission-1", runId: "run-one", status: "approved", selectedOptionId: "allow" } } }]);
  let current = approvalOf(store);
  assert.equal(current.status, "approved");
  assert.deepEqual(current.resolvedBy, { kind: "operator" });
  assert.equal(current.delivery?.status, "sent");
  assert.equal(current.delivery?.attempts, 1);

  const replay = await resolveApproval(store, approval.id, { idempotencyKey: "operator-1", expectedStatus: "pending", optionId: "allow" }, sender.send, later(6));
  assert.equal(replay.status, 200);
  assert.equal(sender.sent.length, 1, "an exact replay returns the existing resolution without resending");

  assert.equal((await receiveHarnessEvent(store, "node-one", permissionResolved(2, "approved", "allow"), redactor, sender.send, later(7))).kind, "accepted");
  current = approvalOf(store);
  assert.equal(current.delivery?.status, "applied");
});

test("conflicting resolutions and unoffered options never change the approval", async () => {
  const store = await storeWithRunningRun();
  const sender = recordingSender();
  const approval = await pendingApproval(store, sender);

  const notOffered = await resolveApproval(store, approval.id, { idempotencyKey: "operator-1", expectedStatus: "pending", optionId: "allow-always" }, sender.send, later(1));
  assert.equal(notOffered.status, 422);
  assert.equal(approvalOf(store).status, "pending");

  const wrongRun = await resolveApproval(store, approval.id, { idempotencyKey: "operator-1", expectedStatus: "pending", optionId: "allow", runId: "run-two" }, sender.send, later(1));
  assert.equal(wrongRun.status, 409);
  assert.equal(approvalOf(store).status, "pending");

  assert.equal((await resolveApproval(store, approval.id, { idempotencyKey: "operator-1", expectedStatus: "pending", optionId: "reject" }, sender.send, later(2))).status, 200);
  const sameKeyDifferentChoice = await resolveApproval(store, approval.id, { idempotencyKey: "operator-1", expectedStatus: "pending", optionId: "allow" }, sender.send, later(3));
  assert.equal(sameKeyDifferentChoice.status, 409);
  const differentKey = await resolveApproval(store, approval.id, { idempotencyKey: "operator-2", expectedStatus: "pending", optionId: "reject" }, sender.send, later(3));
  assert.equal(differentKey.status, 409);
  assert.equal(approvalOf(store).status, "rejected");
  assert.equal(approvalOf(store).selectedOptionId, "reject");
  assert.equal(sender.sent.length, 1);
});

test("a decision persisted while Barista is offline stays pending delivery and is redelivered only to the same live session", async () => {
  const store = await storeWithRunningRun();
  const sender = recordingSender(false);
  const approval = await pendingApproval(store, sender);
  const response = await resolveApproval(store, approval.id, { idempotencyKey: "operator-1", expectedStatus: "pending", optionId: "allow" }, sender.send, later(1));
  assert.equal(response.status, 200);
  assert.equal(approvalOf(store).status, "approved");
  assert.equal(approvalOf(store).delivery?.status, "pending", "an undelivered decision is never marked applied");

  sender.online = true;
  assert.equal(await reconcileApprovals(store, "node-one", ["run-one"], sender.send, later(30)), true);
  assert.equal(sender.sent.length, 1);
  assert.equal(approvalOf(store).delivery?.status, "sent");
});

test("a replacement Barista session never receives an earlier session's decision", async () => {
  const store = await storeWithRunningRun();
  const sender = recordingSender(false);
  const approval = await pendingApproval(store, sender);
  await resolveApproval(store, approval.id, { idempotencyKey: "operator-1", expectedStatus: "pending", optionId: "allow" }, sender.send, later(1));

  sender.online = true;
  await reconcileApprovals(store, "node-one", [], sender.send, later(30));
  assert.equal(sender.sent.length, 0);
  assert.equal(approvalOf(store).delivery?.status, "not-applied");
});

test("a pending decision is not delivered after the approval's deadline", async () => {
  const store = await storeWithRunningRun();
  const sender = recordingSender(false);
  const approval = await pendingApproval(store, sender);
  await resolveApproval(store, approval.id, { idempotencyKey: "operator-1", expectedStatus: "pending", optionId: "allow" }, sender.send, later(1));
  sender.online = true;
  await reconcileApprovals(store, "node-one", ["run-one"], sender.send, later(10 * 60));
  assert.equal(sender.sent.length, 0);
  assert.equal(approvalOf(store).delivery?.status, "not-applied");
});

test("expiry resolves a pending approval as expired and releases the Barista callback", async () => {
  const store = await storeWithRunningRun();
  const sender = recordingSender();
  const approval = await pendingApproval(store, sender);
  assert.equal(await expireDueApprovals(store, sender.send, later(60)), false);
  assert.equal(await expireDueApprovals(store, sender.send, later(9 * 60)), true);
  assert.equal(approvalOf(store).status, "expired");
  assert.deepEqual(approvalOf(store).resolvedBy, { kind: "system" });
  assert.deepEqual(sender.sent.map((entry) => entry.message), [{ type: "approval.decision", decision: { approvalId: "acp-permission-1", runId: "run-one", status: "expired" } }]);
  const late = await resolveApproval(store, approval.id, { idempotencyKey: "operator-1", expectedStatus: "pending", optionId: "allow" }, sender.send, later(9 * 60 + 1));
  assert.equal(late.status, 409);
});

test("run cancellation cancels pending approvals and late events cannot touch the terminal run", async () => {
  const store = await storeWithRunningRun();
  const sender = recordingSender();
  const approval = await pendingApproval(store, sender);
  await cancelPersistedRun(store, "run-one", sender.send, later(1));
  assert.equal(approvalOf(store).status, "cancelled");
  assert.deepEqual(approvalOf(store).resolvedBy, { kind: "system" });

  const before = store.read((state) => JSON.stringify(state));
  const late = await receiveHarnessEvent(store, "node-one", messageDelta(2, "late"), redactor, sender.send, later(2));
  assert.equal(late.kind, "rejected");
  const resolution = await resolveApproval(store, approval.id, { idempotencyKey: "operator-1", expectedStatus: "pending", optionId: "allow" }, sender.send, later(3));
  assert.equal(resolution.status, 409);
  assert.equal(store.read((state) => JSON.stringify(state)), before);
  assert.deepEqual(sender.sent.map((entry) => entry.message.type), ["cancel"]);
});

test("run completion marks unconfirmed decisions as not applied", async () => {
  const store = await storeWithRunningRun();
  const sender = recordingSender();
  const approval = await pendingApproval(store, sender);
  await resolveApproval(store, approval.id, { idempotencyKey: "operator-1", expectedStatus: "pending", optionId: "allow" }, sender.send, later(1));
  await store.transact((state: State) => applyRunLifecycle(state, { type: "run.completed", runId: "run-one", output: "done", at: later(2) }));
  assert.equal(approvalOf(store).status, "approved");
  assert.equal(approvalOf(store).delivery?.status, "not-applied");
});

test("a sequence gap stops the stream and cancels pending approvals through Barista", async () => {
  const store = await storeWithRunningRun();
  const sender = recordingSender();
  await pendingApproval(store, sender);
  const outcome = await receiveHarnessEvent(store, "node-one", messageDelta(3, "skipped two"), redactor, sender.send, later(1));
  assert.equal(outcome.kind, "stream-failed");
  assert.equal(approvalOf(store).status, "cancelled");
  assert.deepEqual(sender.sent.map((entry) => entry.message), [{ type: "approval.decision", decision: { approvalId: "acp-permission-1", runId: "run-one", status: "cancelled" } }]);
  const activity = store.snapshot().runActivity?.find((item) => item.runId === "run-one");
  assert.equal(activity?.streamStatus, "failed");
  assert.match(activity?.streamFailure ?? "", /expected sequence 2/);
  assert.equal((await receiveHarnessEvent(store, "node-one", messageDelta(2, "too late"), redactor, sender.send, later(2))).kind, "rejected");
});

test("Barista refusing a decision marks it not applied", async () => {
  const store = await storeWithRunningRun();
  const sender = recordingSender();
  const approval = await pendingApproval(store, sender);
  await resolveApproval(store, approval.id, { idempotencyKey: "operator-1", expectedStatus: "pending", optionId: "allow" }, sender.send, later(1));
  assert.equal(await receiveApprovalUndeliverable(store, "node-two", "run-one", "acp-permission-1", "no live permission request", redactor, later(2)), false);
  assert.equal(await receiveApprovalUndeliverable(store, "node-one", "run-one", "acp-permission-1", "no live permission request", redactor, later(2)), true);
  assert.equal(approvalOf(store).delivery?.status, "not-applied");
  assert.match(approvalOf(store).delivery?.reason ?? "", /no live permission request/);
});

test("a store failure while resolving sends nothing", async () => {
  const store = await storeWithRunningRun();
  const sender = recordingSender();
  const approval = await pendingApproval(store, sender);
  const failing = Object.create(store) as Store;
  failing.transact = async () => { throw new Error("disk full"); };
  const response = await resolveApproval(failing, approval.id, { idempotencyKey: "operator-1", expectedStatus: "pending", optionId: "allow" }, sender.send, later(1));
  assert.equal(response.status, 500);
  assert.equal(sender.sent.length, 0);
  assert.equal(approvalOf(store).status, "pending");
});

test("delivery bookkeeping never downgrades a confirmed decision", async () => {
  const store = await storeWithRunningRun();
  const sender = recordingSender();
  const approval = await pendingApproval(store, sender);
  await resolveApproval(store, approval.id, { idempotencyKey: "operator-1", expectedStatus: "pending", optionId: "allow" }, sender.send, later(1));
  await receiveHarnessEvent(store, "node-one", permissionResolved(2, "approved", "allow"), redactor, sender.send, later(2));
  await deliverApprovalDecisions(store, [approvalOf(store)], sender.send, later(3));
  assert.equal(approvalOf(store).delivery?.status, "applied");
});

test("an exact replay retries delivery of a decision that is still pending", async () => {
  const store = await storeWithRunningRun();
  const sender = recordingSender(false);
  const approval = await pendingApproval(store, sender);
  const body = { idempotencyKey: "operator-1", expectedStatus: "pending", optionId: "allow" };
  await resolveApproval(store, approval.id, body, sender.send, later(1));
  assert.equal(approvalOf(store).delivery?.status, "pending");
  sender.online = true;
  const replay = await resolveApproval(store, approval.id, body, sender.send, later(2));
  assert.equal(replay.status, 200);
  assert.equal(sender.sent.length, 1);
  assert.equal(approvalOf(store).delivery?.status, "sent");
});

test("a harness-side timeout resolves a pending approval without any operator decision", async () => {
  const store = await storeWithRunningRun();
  const sender = recordingSender();
  const approval = await pendingApproval(store, sender);
  assert.equal((await receiveHarnessEvent(store, "node-one", permissionResolved(2, "expired"), redactor, sender.send, later(600))).kind, "accepted");
  assert.equal(approvalOf(store).status, "expired");
  assert.equal(approvalOf(store).delivery, undefined);
  const late = await resolveApproval(store, approval.id, { idempotencyKey: "operator-1", expectedStatus: "pending", optionId: "allow" }, sender.send, later(601));
  assert.equal(late.status, 409);
  assert.equal(sender.sent.length, 0);
});

test("delivery bookkeeping failures after a committed resolution still produce a defined response", async () => {
  const store = await storeWithRunningRun();
  const sender = recordingSender();
  const approval = await pendingApproval(store, sender);
  const flaky = Object.create(store) as Store;
  let transactions = 0;
  flaky.transact = async (change) => {
    transactions += 1;
    if (transactions > 1) throw new Error("disk full");
    return store.transact(change);
  };
  const response = await resolveApproval(flaky, approval.id, { idempotencyKey: "operator-1", expectedStatus: "pending", optionId: "allow" }, sender.send, later(1));
  assert.equal(response.status, 200);
  assert.equal(approvalOf(store).status, "approved");
  assert.equal(approvalOf(store).delivery?.status, "pending");
  assert.equal(sender.sent.length, 0);
});

test("recording a delivery attempt that fails does not reject", async () => {
  const store = await storeWithRunningRun();
  const sender = recordingSender();
  const approval = await pendingApproval(store, sender);
  await resolveApproval(store, approval.id, { idempotencyKey: "operator-1", expectedStatus: "pending", cancel: true }, recordingSender(false).send, later(1));
  const failing = Object.create(store) as Store;
  failing.transact = async () => { throw new Error("disk full"); };
  const sent = await deliverApprovalDecisions(failing, [approvalOf(store)], sender.send, later(2));
  assert.deepEqual(sent, [approval.id]);
  assert.equal(approvalOf(store).delivery?.status, "pending");
});
