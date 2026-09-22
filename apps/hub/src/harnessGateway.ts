import type { ApprovalRequest, HarnessEvent, HubToControlAgent } from "@coffee-shop/protocol";
import {
  approvalDecision,
  approvalsAwaitingDelivery,
  expireApprovals,
  parseApprovalResolution,
  reconcileApprovalsForNode,
  recordDeliveryAttempts,
  recordUndeliverable,
  resolveApprovalInState,
  type ApprovalResolutionResult
} from "./approvals.js";
import { acceptHarnessEvent, type HarnessEventOutcome } from "./harnessEvents.js";
import { retryAsync } from "./lifecycle.js";
import type { Redactor } from "./redaction.js";
import type { Store } from "./store.js";

/*
 * Store-level orchestration of structured harness state: every function persists its state change
 * before any approval decision is written to Barista, and only records a decision as sent after
 * the owning socket accepted it.
 */
export type ControlAgentSender = (nodeId: string, message: HubToControlAgent) => boolean;

/** Sends decisions to their originating node and records which were written. */
export async function deliverApprovalDecisions(store: Store, approvals: readonly ApprovalRequest[], send: ControlAgentSender, at = new Date().toISOString()) {
  const sent = approvals
    .filter((approval) => send(approval.nodeId, { type: "approval.decision", decision: approvalDecision(approval) }))
    .map((approval) => approval.id);
  if (sent.length) {
    try {
      await store.transact((state) => recordDeliveryAttempts(state, sent, at));
    } catch (error) {
      // The decisions were written; an unrecorded attempt only leaves them eligible for a
      // redelivery that Barista treats as an exact duplicate.
      console.error("recording approval delivery failed", error);
    }
  }
  return sent;
}

export async function receiveHarnessEvent(store: Store, nodeId: string, event: HarnessEvent, redactor: Redactor, send: ControlAgentSender, receivedAt = new Date().toISOString()) {
  let outcome: HarnessEventOutcome = { kind: "rejected", reason: "the event was not processed" };
  await retryAsync(async () => {
    await store.transact((state) => {
      outcome = acceptHarnessEvent(state, { nodeId, receivedAt, redactor }, event);
      return outcome.kind === "accepted" || outcome.kind === "stream-failed";
    });
  });
  const result = outcome as HarnessEventOutcome;
  if (result.kind === "accepted" || result.kind === "stream-failed") {
    await deliverApprovalDecisions(store, structuredClone(result.deliveries), send, receivedAt);
  }
  return result;
}

export async function receiveApprovalUndeliverable(store: Store, nodeId: string, runId: string, harnessApprovalId: string, reason: string, redactor: Redactor, at = new Date().toISOString()) {
  let changed = false;
  await store.transact((state) => {
    changed = recordUndeliverable(state, nodeId, runId, harnessApprovalId, redactor.redact(reason), at);
    return changed;
  });
  return changed;
}

/** Runs after a Barista replay barrier; `activeRunIds` is the set that Barista still supervises. */
export async function reconcileApprovals(store: Store, nodeId: string, activeRunIds: readonly string[], send: ControlAgentSender, at = new Date().toISOString()) {
  let deliverable: ApprovalRequest[] = [];
  let changed = false;
  await store.transact((state) => {
    const result = reconcileApprovalsForNode(state, nodeId, activeRunIds, at);
    deliverable = structuredClone(result.deliverable);
    changed = result.changed;
    return changed;
  });
  const sent = await deliverApprovalDecisions(store, deliverable, send, at);
  return changed || sent.length > 0;
}

export async function expireDueApprovals(store: Store, send: ControlAgentSender, at = new Date().toISOString()) {
  let deliverable: ApprovalRequest[] = [];
  let changed = false;
  await store.transact((state) => {
    const result = expireApprovals(state, at);
    deliverable = structuredClone(result.deliverable);
    changed = result.changed;
    return changed;
  });
  await deliverApprovalDecisions(store, deliverable, send, at);
  return changed;
}

export interface ApprovalResolutionResponse {
  status: 200 | 400 | 404 | 409 | 422 | 500;
  body: { approval: ApprovalRequest } | { error: string; approval?: ApprovalRequest };
  changed: boolean;
}

const latestApproval = (store: Store, approvalId: string) =>
  store.read((state) => structuredClone((state.approvals ?? []).find((approval) => approval.id === approvalId)));

/**
 * Delivers the decision a committed resolution produced, when one still needs delivering, and
 * returns whether any state changed. It never revisits the resolution itself: if delivery
 * bookkeeping fails, the resolution stays committed with a `delivery` that reconciliation or an
 * exact replay can still carry to Barista.
 */
export async function deliverApprovalResolution(store: Store, approvalId: string, resolution: ApprovalResolutionResult, send: ControlAgentSender, at: string) {
  const needed = resolution.kind === "resolved"
    || (resolution.kind === "replayed" && resolution.approval.delivery?.status === "pending")
    || (resolution.kind === "conflict" && resolution.changed);
  if (!needed) return false;
  let deliverable: ApprovalRequest[] = [];
  let changed = false;
  try {
    await store.transact((state) => {
      const approval = (state.approvals ?? []).find((item) => item.id === approvalId);
      if (!approval) return false;
      const before = JSON.stringify(approval.delivery);
      deliverable = structuredClone(approvalsAwaitingDelivery(state, [approval], at));
      changed = before !== JSON.stringify(approval.delivery);
      return changed;
    });
  } catch (error) {
    console.error("approval delivery could not be prepared", error);
    deliverable = [];
    changed = false;
  }
  return (await deliverApprovalDecisions(store, deliverable, send, at)).length > 0 || changed;
}

/**
 * Operator resolution of an approval. The resolution is committed first; a failed write returns
 * 500 and sends nothing. Delivery happens afterwards and never changes the committed resolution:
 * if delivery bookkeeping fails, the response still reports the committed approval, whose
 * `delivery` shows it has not been confirmed as sent.
 */
export async function resolveApproval(store: Store, approvalId: string, body: unknown, send: ControlAgentSender, at = new Date().toISOString()): Promise<ApprovalResolutionResponse> {
  const input = parseApprovalResolution(body);
  if (!input.ok) return { status: 400, body: { error: input.reason }, changed: false };
  let result: ApprovalResolutionResult = { kind: "not-found" };
  try {
    await store.transact((state) => {
      result = resolveApprovalInState(state, approvalId, input.value, at);
      return result.kind === "resolved" || (result.kind === "conflict" && result.changed);
    });
  } catch {
    return { status: 500, body: { error: "The approval resolution could not be persisted" }, changed: false };
  }
  const resolution = result as ApprovalResolutionResult;
  if (resolution.kind === "not-found") return { status: 404, body: { error: "Approval not found" }, changed: false };
  if (resolution.kind === "option-not-offered") return { status: 422, body: { error: "The selected option was not offered by this approval", approval: resolution.approval }, changed: false };

  const deliveryChanged = await deliverApprovalResolution(store, approvalId, resolution, send, at);
  const approval = latestApproval(store, approvalId)!;
  const changed = resolution.kind === "resolved" || (resolution.kind === "conflict" && resolution.changed) || deliveryChanged;
  if (resolution.kind === "conflict") return { status: 409, body: { error: resolution.reason, approval }, changed };
  return { status: 200, body: { approval }, changed };
}
