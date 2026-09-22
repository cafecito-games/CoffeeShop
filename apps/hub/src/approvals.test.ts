import assert from "node:assert/strict";
import test from "node:test";
import type { ApprovalDelivery, ApprovalRequest, HarnessEvent, Run } from "@coffee-shop/protocol";
import {
  approvalDecision,
  approvalLifetimeMilliseconds,
  approvalsAwaitingDelivery,
  applyHarnessResolution,
  cancelPendingApprovals,
  expireApprovals,
  parseApprovalResolution,
  reconcileApprovalsForNode,
  recordDeliveryAttempts,
  recordUndeliverable,
  resolveApprovalInState,
  settleApprovalsForTerminalRun,
  type ApprovalResolutionInput
} from "./approvals.js";
import type { State } from "./store.js";

const at = "2026-09-21T12:00:00.000Z";
const later = (seconds: number) => new Date(Date.parse(at) + seconds * 1000).toISOString();

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-one", threadId: "thread-one", agentId: "agent-one", nodeId: "node-one", harnessId: "codex-cli", model: "gpt-5",
    workspace: "/workspace", prompt: "Build it", status: "running", output: "", depth: 0, createdAt: at,
    sessionBindingId: "binding-one", ...overrides
  };
}

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "approval-one",
    harnessApprovalId: "acp-approval-1",
    threadId: "thread-one",
    runId: "run-one",
    nodeId: "node-one",
    sessionBindingId: "binding-one",
    title: "Run tests",
    options: [
      { id: "allow", label: "Allow once", kind: "allow-once" },
      { id: "always", label: "Allow always", kind: "allow-always" },
      { id: "reject", label: "Reject once", kind: "reject-once" }
    ],
    status: "pending",
    requestedAt: at,
    expiresAt: later(approvalLifetimeMilliseconds / 1000),
    ...overrides
  };
}

function state(approvals: ApprovalRequest[], runs: Run[] = [run()]): State {
  return { agents: [], nodes: [], runs, events: [], messages: [], approvals };
}

const operatorInput = (optionId: string, idempotencyKey = "operator-1"): ApprovalResolutionInput =>
  ({ idempotencyKey, expectedStatus: "pending", optionId });

const delivered = (status: ApprovalDelivery["status"], attempts: number): ApprovalDelivery =>
  ({ status, attempts, updatedAt: at });

const approvedByOperator = (delivery: ApprovalDelivery, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest =>
  approval({
    status: "approved", selectedOptionId: "allow", resolvedBy: "operator", resolvedAt: at,
    resolutionIdempotencyKey: "operator-1", delivery, ...overrides
  });

const permissionResolved = (status: "approved" | "rejected" | "cancelled" | "expired", approvalId = "acp-approval-1", selectedOptionId?: string): Extract<HarnessEvent, { type: "permission.resolved" }> =>
  ({ type: "permission.resolved", runId: "run-one", sequence: 2, at, approvalId, status, ...(selectedOptionId !== undefined ? { selectedOptionId } : {}) });

test("parseApprovalResolution accepts the option and cancel forms with an optional runId", () => {
  const optionForm = parseApprovalResolution({ idempotencyKey: "operator-1", expectedStatus: "pending", optionId: "allow" });
  if (!optionForm.ok) assert.fail(optionForm.reason);
  assert.deepEqual(optionForm.value, { idempotencyKey: "operator-1", expectedStatus: "pending", optionId: "allow" });

  const cancelForm = parseApprovalResolution({ idempotencyKey: "operator-1", expectedStatus: "pending", cancel: true });
  if (!cancelForm.ok) assert.fail(cancelForm.reason);
  assert.deepEqual(cancelForm.value, { idempotencyKey: "operator-1", expectedStatus: "pending", cancel: true });

  const withRunId = parseApprovalResolution({ idempotencyKey: "operator-1", expectedStatus: "pending", optionId: "allow", runId: "run-one" });
  if (!withRunId.ok) assert.fail(withRunId.reason);
  assert.equal(withRunId.value.runId, "run-one");

  const maximalKey = parseApprovalResolution({ idempotencyKey: "k".repeat(256), expectedStatus: "pending", cancel: true });
  if (!maximalKey.ok) assert.fail(maximalKey.reason);
});

test("parseApprovalResolution rejects malformed input", () => {
  const cases: unknown[] = [
    null,
    "operator-1",
    [],
    { idempotencyKey: "operator-1", expectedStatus: "pending", optionId: "allow", extra: "no" },
    { expectedStatus: "pending", optionId: "allow" },
    { idempotencyKey: "", expectedStatus: "pending", optionId: "allow" },
    { idempotencyKey: "k".repeat(257), expectedStatus: "pending", optionId: "allow" },
    { idempotencyKey: "operator-1", expectedStatus: "approved", optionId: "allow" },
    { idempotencyKey: "operator-1", expectedStatus: "pending", optionId: "allow", cancel: true },
    { idempotencyKey: "operator-1", expectedStatus: "pending" },
    { idempotencyKey: "operator-1", expectedStatus: "pending", cancel: false },
    { idempotencyKey: "operator-1", expectedStatus: "pending", optionId: "" },
    { idempotencyKey: "operator-1", expectedStatus: "pending", optionId: "allow", runId: "" }
  ];
  for (const [index, value] of cases.entries()) {
    const parsed = parseApprovalResolution(value);
    if (parsed.ok) assert.fail(`case ${index} parsed unexpectedly`);
    assert.ok(parsed.reason.length > 0, `case ${index}`);
  }
});

test("operator resolutions approve, reject, and cancel with delivery pending", () => {
  const choices: Array<[string, ApprovalRequest["status"]]> = [["allow", "approved"], ["always", "approved"], ["reject", "rejected"]];
  for (const [optionId, expectedStatus] of choices) {
    const current = state([approval()]);
    const result = resolveApprovalInState(current, "approval-one", operatorInput(optionId), at);
    if (result.kind !== "resolved") assert.fail(`${optionId}: ${result.kind}`);
    assert.equal(result.approval.status, expectedStatus, optionId);
    assert.equal(result.approval.resolvedBy, "operator", optionId);
    assert.equal(result.approval.resolvedAt, at, optionId);
    assert.equal(result.approval.resolutionIdempotencyKey, "operator-1", optionId);
    assert.equal(result.approval.selectedOptionId, optionId, optionId);
    assert.deepEqual(result.approval.delivery, { status: "pending", attempts: 0, updatedAt: at }, optionId);
    assert.ok(current.events.some((event) => event.title === `Approval ${expectedStatus}`), optionId);
  }

  const cancelled = state([approval()]);
  const cancelResult = resolveApprovalInState(cancelled, "approval-one", { idempotencyKey: "operator-1", expectedStatus: "pending", cancel: true }, at);
  if (cancelResult.kind !== "resolved") assert.fail(cancelResult.kind);
  assert.equal(cancelResult.approval.status, "cancelled");
  assert.equal(cancelResult.approval.selectedOptionId, undefined);
  assert.equal(cancelResult.approval.resolvedBy, "operator");
  assert.deepEqual(cancelResult.approval.delivery, { status: "pending", attempts: 0, updatedAt: at });
});

test("resolveApprovalInState reports not-found and unoffered options without changing the approval", () => {
  const missing = state([approval()]);
  assert.equal(resolveApprovalInState(missing, "approval-missing", operatorInput("allow"), at).kind, "not-found");

  const unoffered = state([approval()]);
  const before = structuredClone(unoffered.approvals![0]);
  const unofferedResult = resolveApprovalInState(unoffered, "approval-one", operatorInput("nope"), at);
  assert.equal(unofferedResult.kind, "option-not-offered");
  assert.deepEqual(unoffered.approvals![0], before);
});

test("resolveApprovalInState replays exact idempotent resolutions and conflicts on divergent ones", () => {
  const current = state([approval()]);
  assert.equal(resolveApprovalInState(current, "approval-one", operatorInput("allow"), at).kind, "resolved");
  const replay = resolveApprovalInState(current, "approval-one", operatorInput("allow"), at);
  assert.equal(replay.kind, "replayed");
  assert.equal(replay.approval.status, "approved");

  const diverged = resolveApprovalInState(current, "approval-one", operatorInput("reject"), at);
  if (diverged.kind !== "conflict") assert.fail(diverged.kind);
  assert.match(diverged.reason, /idempotency key/);
  assert.equal(diverged.changed, false);
  assert.equal(current.approvals![0].status, "approved");

  const rekeyed = resolveApprovalInState(current, "approval-one", operatorInput("reject", "operator-2"), at);
  if (rekeyed.kind !== "conflict") assert.fail(rekeyed.kind);
  assert.match(rekeyed.reason, /already approved/);
  assert.equal(rekeyed.changed, false);
});

test("resolveApprovalInState conflicts when the run is missing, not running, or no longer the same session", () => {
  const cases: Array<{ label: string; state: State }> = [
    { label: "missing run", state: state([approval()], []) },
    { label: "completed run", state: state([approval()], [run({ status: "completed" })]) },
    { label: "changed node", state: state([approval()], [run({ nodeId: "node-two" })]) },
    { label: "changed session binding", state: state([approval()], [run({ sessionBindingId: "binding-two" })]) }
  ];
  for (const item of cases) {
    const result = resolveApprovalInState(item.state, "approval-one", operatorInput("allow"), at);
    if (result.kind !== "conflict") assert.fail(`${item.label}: ${result.kind}`);
    assert.equal(result.changed, false, item.label);
    assert.equal(result.approval.status, "pending", item.label);
  }
});

test("resolveApprovalInState expires an overdue approval instead of resolving it", () => {
  const current = state([approval({ expiresAt: later(-1) })]);
  const result = resolveApprovalInState(current, "approval-one", operatorInput("allow"), at);
  if (result.kind !== "conflict") assert.fail(result.kind);
  assert.match(result.reason, /expired/);
  assert.equal(result.changed, true);
  assert.equal(result.approval.status, "expired");
  assert.equal(result.approval.resolvedBy, "system");
  assert.equal(result.approval.delivery?.status, "pending");
});

test("resolveApprovalInState conflicts when the resolution names another run", () => {
  const current = state([approval()]);
  const result = resolveApprovalInState(current, "approval-one", { idempotencyKey: "operator-1", expectedStatus: "pending", optionId: "allow", runId: "run-two" }, at);
  if (result.kind !== "conflict") assert.fail(result.kind);
  assert.match(result.reason, /different run/);
  assert.equal(result.changed, false);
  assert.equal(current.approvals![0].status, "pending");
});

test("approvalDecision uses the harness identity and only carries options for choices", () => {
  assert.throws(() => approvalDecision(approval()), /pending approval/);
  assert.deepEqual(
    approvalDecision(approval({ status: "approved", selectedOptionId: "allow" })),
    { approvalId: "acp-approval-1", runId: "run-one", status: "approved", selectedOptionId: "allow" }
  );
  assert.deepEqual(
    approvalDecision(approval({ status: "rejected", selectedOptionId: "reject" })),
    { approvalId: "acp-approval-1", runId: "run-one", status: "rejected", selectedOptionId: "reject" }
  );
  assert.deepEqual(
    approvalDecision(approval({ status: "cancelled" })),
    { approvalId: "acp-approval-1", runId: "run-one", status: "cancelled" }
  );
  assert.equal("selectedOptionId" in approvalDecision(approval({ status: "expired" })), false);
});

test("applyHarnessResolution confirms or refutes a delivered operator decision", () => {
  const confirmed = state([approvedByOperator(delivered("sent", 1))]);
  assert.equal(applyHarnessResolution(confirmed, run(), permissionResolved("approved", "acp-approval-1", "allow"), later(10)), undefined);
  assert.deepEqual(confirmed.approvals![0].delivery, { status: "applied", attempts: 1, updatedAt: later(10) });

  for (const status of ["expired", "cancelled"] as const) {
    const refuted = state([approvedByOperator(delivered("sent", 1))]);
    assert.equal(applyHarnessResolution(refuted, run(), permissionResolved(status), later(10)), undefined);
    assert.equal(refuted.approvals![0].delivery?.status, "not-applied", status);
    assert.ok(refuted.approvals![0].delivery?.reason, status);
  }

  const contradicted = state([approvedByOperator(delivered("sent", 1))]);
  const contradiction = applyHarnessResolution(contradicted, run(), permissionResolved("approved", "acp-approval-1", "reject"), later(10));
  assert.ok(typeof contradiction === "string");
  assert.match(contradiction, /contradicts/);
  assert.equal(contradicted.approvals![0].delivery?.status, "sent");

  const refused = state([approvedByOperator(delivered("sent", 1))]);
  assert.ok(typeof applyHarnessResolution(refused, run(), permissionResolved("rejected", "acp-approval-1", "reject"), later(10)) === "string");
  assert.equal(refused.approvals![0].delivery?.status, "sent");

  const settled = state([approvedByOperator(delivered("sent", 1))]);
  assert.equal(applyHarnessResolution(settled, run(), permissionResolved("approved", "acp-approval-1", "allow"), later(10)), undefined);
  const second = applyHarnessResolution(settled, run(), permissionResolved("approved", "acp-approval-1", "allow"), later(11));
  assert.ok(typeof second === "string");
  assert.match(second, /already resolved/);
  assert.equal(settled.approvals![0].delivery?.status, "applied");
});

test("a harness resolution settles a still-pending approval only as cancelled or expired", () => {
  for (const status of ["cancelled", "expired"] as const) {
    const current = state([approval()]);
    assert.equal(applyHarnessResolution(current, run(), permissionResolved(status), later(10)), undefined, status);
    assert.equal(current.approvals![0].status, status, status);
    assert.equal(current.approvals![0].resolvedBy, "system", status);
    assert.equal(current.approvals![0].delivery, undefined, status);
  }
  assert.ok(typeof applyHarnessResolution(state([approval()]), run(), permissionResolved("approved", "acp-approval-1", "allow"), later(10)) === "string");
  assert.ok(typeof applyHarnessResolution(state([approval()]), run(), permissionResolved("rejected", "acp-approval-1", "reject"), later(10)) === "string");
  assert.ok(typeof applyHarnessResolution(state([approval()]), run(), permissionResolved("cancelled", "acp-unknown"), later(10)) === "string");

  for (const status of ["cancelled", "expired"] as const) {
    const operatorCancelled = state([approval({ status: "cancelled", resolvedBy: "operator", resolvedAt: at, delivery: delivered("sent", 1) })]);
    assert.equal(applyHarnessResolution(operatorCancelled, run(), permissionResolved(status), later(10)), undefined, status);
    assert.equal(operatorCancelled.approvals![0].delivery?.status, "applied", status);
  }
});

test("approvalsAwaitingDelivery returns deliverable decisions and retires unreachable ones", () => {
  const healthy = state([approvedByOperator(delivered("pending", 0))]);
  assert.deepEqual(approvalsAwaitingDelivery(healthy, healthy.approvals!, later(60)).map((item) => item.id), ["approval-one"]);
  assert.equal(healthy.approvals![0].delivery?.status, "pending");

  const blockers: Array<[string, Run[]]> = [
    ["terminal run", [run({ status: "completed" })]],
    ["changed node", [run({ nodeId: "node-two" })]],
    ["changed session binding", [run({ sessionBindingId: "binding-two" })]]
  ];
  for (const [label, runs] of blockers) {
    const current = state([approvedByOperator(delivered("pending", 0))], runs);
    assert.deepEqual(approvalsAwaitingDelivery(current, current.approvals!, later(60)), [], label);
    assert.equal(current.approvals![0].delivery?.status, "not-applied", label);
  }

  const expiredPending = state([approvedByOperator(delivered("pending", 0), { expiresAt: later(30) })]);
  assert.deepEqual(approvalsAwaitingDelivery(expiredPending, expiredPending.approvals!, later(60)), []);
  assert.equal(expiredPending.approvals![0].delivery?.status, "not-applied");

  const expiredSent = state([approvedByOperator(delivered("sent", 1), { expiresAt: later(30) })]);
  assert.deepEqual(approvalsAwaitingDelivery(expiredSent, expiredSent.approvals!, later(60)), []);
  assert.equal(expiredSent.approvals![0].delivery?.status, "sent");
});

test("expireApprovals expires due pending approvals and returns them for delivery", () => {
  const current = state([approval({ expiresAt: later(-1) }), approval({ id: "approval-fresh", harnessApprovalId: "acp-2", expiresAt: later(60) })]);
  const result = expireApprovals(current, at);
  assert.deepEqual(result.deliverable.map((item) => item.id), ["approval-one"]);
  assert.equal(result.changed, true);
  assert.equal(current.approvals![0].status, "expired");
  assert.equal(current.approvals![0].resolvedBy, "system");
  assert.equal(current.approvals![0].delivery?.status, "pending");
  assert.equal(current.approvals![1].status, "pending");

  const fresh = state([approval({ expiresAt: later(60) })]);
  const unchanged = expireApprovals(fresh, at);
  assert.deepEqual(unchanged.deliverable, []);
  assert.equal(unchanged.changed, false);
  assert.equal(fresh.approvals![0].status, "pending");
});

test("reconcileApprovalsForNode cancels inactive runs and redelivers active decisions", () => {
  const current = state([
    approval({ id: "approval-inactive", harnessApprovalId: "acp-1", runId: "run-two" }),
    approvedByOperator(delivered("sent", 1), { id: "approval-inactive-sent", harnessApprovalId: "acp-2", runId: "run-two" }),
    approvedByOperator(delivered("pending", 0), { id: "approval-active", harnessApprovalId: "acp-3" }),
    approval({ id: "approval-other-node", harnessApprovalId: "acp-4", nodeId: "node-two" }),
    approval({ id: "approval-terminal", harnessApprovalId: "acp-5", runId: "run-three" })
  ], [run(), run({ id: "run-two" }), run({ id: "run-three", status: "completed" })]);

  const result = reconcileApprovalsForNode(current, "node-one", ["run-one"], at);
  assert.deepEqual(result.deliverable.map((item) => item.id), ["approval-active"]);
  assert.equal(result.changed, true);
  assert.equal(current.approvals![0].status, "cancelled");
  assert.equal(current.approvals![0].resolvedBy, "system");
  assert.equal(current.approvals![1].delivery?.status, "not-applied");
  assert.equal(current.approvals![2].delivery?.status, "pending");
  assert.equal(current.approvals![3].status, "pending");
  assert.equal(current.approvals![4].status, "pending");
});

test("recordDeliveryAttempts moves pending and sent decisions to sent", () => {
  const current = state([
    approvedByOperator(delivered("pending", 0), { id: "approval-pending", harnessApprovalId: "acp-1" }),
    approvedByOperator(delivered("sent", 1), { id: "approval-sent", harnessApprovalId: "acp-2" }),
    approvedByOperator(delivered("applied", 1), { id: "approval-applied", harnessApprovalId: "acp-3" }),
    approvedByOperator(delivered("not-applied", 1), { id: "approval-refused", harnessApprovalId: "acp-4" })
  ]);
  const ids = ["approval-pending", "approval-sent", "approval-applied", "approval-refused", "approval-unknown"];
  assert.equal(recordDeliveryAttempts(current, ids, later(5)), true);
  assert.deepEqual(current.approvals![0].delivery, { status: "sent", attempts: 1, updatedAt: later(5) });
  assert.deepEqual(current.approvals![1].delivery, { status: "sent", attempts: 2, updatedAt: later(5) });
  assert.deepEqual(current.approvals![2].delivery, { status: "applied", attempts: 1, updatedAt: at });
  assert.deepEqual(current.approvals![3].delivery, { status: "not-applied", attempts: 1, updatedAt: at });
});

test("recordUndeliverable refuses mismatched nodes and never un-applies a decision", () => {
  const current = state([
    approvedByOperator(delivered("sent", 1)),
    approvedByOperator(delivered("applied", 1), { id: "approval-applied", harnessApprovalId: "acp-2" })
  ]);
  assert.equal(recordUndeliverable(current, "node-two", "run-one", "acp-approval-1", "session gone", later(5)), false);
  assert.equal(current.approvals![0].delivery?.status, "sent");
  assert.equal(recordUndeliverable(current, "node-one", "run-one", "acp-approval-1", "session gone", later(5)), true);
  assert.equal(current.approvals![0].delivery?.status, "not-applied");
  assert.match(current.approvals![0].delivery?.reason ?? "", /session gone/);
  assert.equal(recordUndeliverable(current, "node-one", "run-one", "acp-2", "late refusal", later(6)), false);
  assert.equal(current.approvals![1].delivery?.status, "applied");
  assert.equal(recordUndeliverable(current, "node-one", "run-one", "acp-unknown", "missing", later(6)), false);
});

test("terminal runs settle every approval and stream failures cancel pending ones for delivery", () => {
  const current = state([
    approval(),
    approvedByOperator(delivered("sent", 1), { id: "approval-sent", harnessApprovalId: "acp-2" }),
    approvedByOperator(delivered("applied", 1), { id: "approval-applied", harnessApprovalId: "acp-3" })
  ]);
  settleApprovalsForTerminalRun(current, "run-one", later(30));
  assert.equal(current.approvals![0].status, "cancelled");
  assert.equal(current.approvals![0].resolvedBy, "system");
  assert.equal(current.approvals![0].delivery, undefined);
  assert.equal(current.approvals![1].delivery?.status, "not-applied");
  assert.equal(current.approvals![2].delivery?.status, "applied");

  const stream = state([
    approval(),
    approval({ id: "approval-resolved", harnessApprovalId: "acp-2", status: "rejected", selectedOptionId: "reject", resolvedBy: "operator", delivery: delivered("pending", 0) }),
    approval({ id: "approval-other-run", harnessApprovalId: "acp-3", runId: "run-two" })
  ], [run(), run({ id: "run-two" })]);
  const cancelled = cancelPendingApprovals(stream, "run-one", later(30));
  assert.deepEqual(cancelled.map((item) => item.id), ["approval-one"]);
  assert.equal(stream.approvals![0].status, "cancelled");
  assert.equal(stream.approvals![0].resolvedBy, "system");
  assert.equal(stream.approvals![0].delivery?.status, "pending");
  assert.equal(stream.approvals![1].status, "rejected");
  assert.equal(stream.approvals![2].status, "pending");
});
