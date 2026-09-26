import {
  isTerminalApprovalStatus,
  isTerminalRunStatus,
  type ApprovalDecision,
  type ApprovalOption,
  type ApprovalRequest,
  type ApprovalResolvedBy,
  type ApprovalStatus,
  type HarnessEvent,
  type OrchestratorAttachment,
  type Run,
  type Validation
} from "@coffee-shop/protocol";
import { newEvent, newId, runAttribution, type State } from "./store.js";

/*
 * Approval lifecycle.
 *
 * A `permission.requested` harness event opens a pending approval with a hub-generated identity
 * bound to the originating run, node, and session binding. It is resolved exactly once: by an
 * operator choosing an offered option (or cancelling), by expiry, by the run ending, or by the
 * harness itself timing out. The resolution is persisted before any decision is sent, and decision
 * delivery is tracked separately so an offline Barista never makes a decision look applied.
 *
 * An external orchestrator may also resolve an approval, but only through the authority decided by
 * `orchestratorApprovalAuthority` below: a live attachment on the approval's own thread whose
 * credential still carries the operator-granted `resolve-approvals` scope. Every resolution records
 * who made it in `resolvedBy`, so an orchestrator decision stays attributable after its attachment
 * ends.
 */

/** Settled approvals kept per run and in total; pending or still-undelivered approvals are never pruned. */
export const approvalRetentionLimits = { settledPerRun: 50, settled: 500 } as const;

/** Shorter than Barista's ten-minute permission timeout, so the hub never approves after Barista gave up. */
export const approvalLifetimeMilliseconds = 9 * 60 * 1000;
export const approvalIdempotencyKeyBytes = 256;

type PermissionRequestedEvent = Extract<HarnessEvent, { type: "permission.requested" }>;
type PermissionResolvedEvent = Extract<HarnessEvent, { type: "permission.resolved" }>;

const encoder = new TextEncoder();
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const decisionStatus = (kind: string): "approved" | "rejected" => kind.startsWith("allow") ? "approved" : "rejected";
const selectsOption = (status: ApprovalStatus) => status === "approved" || status === "rejected";

export function approvalDecision(approval: ApprovalRequest): ApprovalDecision {
  if (approval.status === "pending") throw new Error("A pending approval has no decision");
  const decision: ApprovalDecision = { approvalId: approval.harnessApprovalId, runId: approval.runId, status: approval.status };
  if (selectsOption(approval.status) && approval.selectedOptionId) decision.selectedOptionId = approval.selectedOptionId;
  return decision;
}

function approvalsForRun(state: State, runId: string) {
  return (state.approvals ?? []).filter((approval) => approval.runId === runId);
}

function findHarnessApproval(state: State, runId: string, harnessApprovalId: string) {
  return (state.approvals ?? []).find((approval) => approval.runId === runId && approval.harnessApprovalId === harnessApprovalId);
}

function recordApprovalEvent(state: State, approval: ApprovalRequest, title: string) {
  const run = state.runs.find((item) => item.id === approval.runId);
  state.events.unshift(newEvent({ type: "status", title, detail: approval.title, threadId: approval.threadId || undefined, ...runAttribution(state, run), runId: approval.runId }));
}

function resolve(approval: ApprovalRequest, status: Exclude<ApprovalStatus, "pending">, resolvedBy: ApprovalResolvedBy, at: string, needsDelivery: boolean) {
  approval.status = status;
  approval.resolvedAt = at;
  approval.resolvedBy = resolvedBy;
  if (needsDelivery) approval.delivery = { status: "pending", attempts: 0, updatedAt: at };
}

function markNotApplied(approval: ApprovalRequest, reason: string, at: string) {
  if (!approval.delivery || approval.delivery.status === "applied" || approval.delivery.status === "not-applied") return false;
  approval.delivery = { ...approval.delivery, status: "not-applied", reason, updatedAt: at };
  return true;
}

const isSettled = (approval: ApprovalRequest) => isTerminalApprovalStatus(approval.status)
  && (!approval.delivery || approval.delivery.status === "applied" || approval.delivery.status === "not-applied");

/**
 * Drops the oldest settled approvals beyond the per-run and total caps. Approvals are stored newest
 * first, so the most recent settled approvals are the ones kept.
 */
export function pruneSettledApprovals(state: State) {
  const perRun = new Map<string, number>();
  let total = 0;
  const before = (state.approvals ?? []).length;
  state.approvals = (state.approvals ?? []).filter((approval) => {
    if (!isSettled(approval)) return true;
    const runCount = (perRun.get(approval.runId) ?? 0) + 1;
    perRun.set(approval.runId, runCount);
    total += 1;
    return runCount <= approvalRetentionLimits.settledPerRun && total <= approvalRetentionLimits.settled;
  });
  return state.approvals.length !== before;
}

/** Opens a pending approval; returns a conflict reason when the request repeats a known approval. */
export function openApproval(state: State, run: Run, event: PermissionRequestedEvent, receivedAt: string): string | undefined {
  if (findHarnessApproval(state, run.id, event.approvalId)) return `permission request ${event.approvalId} was already raised for this run`;
  const approval: ApprovalRequest = {
    id: newId("approval"),
    harnessApprovalId: event.approvalId,
    threadId: run.threadId ?? "",
    runId: run.id,
    nodeId: run.nodeId,
    /*
     * Version-5 attribution. An approval carries no agent key at all — it is identified by its run —
     * so an instance run's approval records the resident and the exact allocation that raised it,
     * which is what lets a mixed approval audit stay interpretable.
     */
    ...(run.instanceId !== undefined && run.allocationId !== undefined
      ? { instanceId: run.instanceId, allocationId: run.allocationId }
      : {}),
    title: event.title,
    options: event.options.map((option) => ({ ...option })),
    status: "pending",
    requestedAt: event.at,
    expiresAt: new Date(Date.parse(receivedAt) + approvalLifetimeMilliseconds).toISOString()
  };
  if (run.taskId) approval.taskId = run.taskId;
  if (run.sessionBindingId) approval.sessionBindingId = run.sessionBindingId;
  if (event.toolCallId) approval.toolCallId = event.toolCallId;
  if (event.detail) approval.detail = event.detail;
  state.approvals ??= [];
  state.approvals.unshift(approval);
  pruneSettledApprovals(state);
  recordApprovalEvent(state, approval, "Approval requested");
  return undefined;
}

function harnessResultMatches(approval: ApprovalRequest, event: PermissionResolvedEvent) {
  if (selectsOption(approval.status)) return event.status === approval.status && event.selectedOptionId === approval.selectedOptionId;
  return event.status === "cancelled" || event.status === "expired";
}

/**
 * Applies the harness's own report of how a permission request ended. It confirms or refutes
 * delivery of a hub decision, and resolves a still-pending approval only as cancelled or expired:
 * a harness can never approve or reject on its own. Returns a conflict reason on contradiction.
 */
export function applyHarnessResolution(state: State, run: Run, event: PermissionResolvedEvent, at: string): string | undefined {
  const approval = findHarnessApproval(state, run.id, event.approvalId);
  if (!approval) return `permission.resolved names unknown approval ${event.approvalId}`;
  if (approval.status === "pending") {
    if (selectsOption(event.status)) return `harness reported ${event.status} for ${event.approvalId} without a hub decision`;
    resolve(approval, event.status as "cancelled" | "expired", { kind: "system" }, at, false);
    recordApprovalEvent(state, approval, event.status === "expired" ? "Approval expired" : "Approval cancelled");
    return undefined;
  }
  if (!approval.delivery || approval.delivery.status === "applied") return `approval ${event.approvalId} was already resolved by the harness`;
  const matches = harnessResultMatches(approval, event);
  if (!matches && selectsOption(event.status)) return `harness applied ${event.status} to ${event.approvalId}, which contradicts the hub decision`;
  approval.delivery = matches
    ? { status: "applied", attempts: approval.delivery.attempts, updatedAt: at }
    : { ...approval.delivery, status: "not-applied", reason: `the harness resolved the request as ${event.status} before the decision applied`, updatedAt: at };
  return undefined;
}

/**
 * Cancels every pending approval of a run whose stream can no longer be trusted, returning the
 * approvals whose cancellation must be delivered so Barista releases the waiting callbacks.
 */
export function cancelPendingApprovals(state: State, runId: string, at: string) {
  const cancelled: ApprovalRequest[] = [];
  for (const approval of approvalsForRun(state, runId)) {
    if (approval.status !== "pending") continue;
    resolve(approval, "cancelled", { kind: "system" }, at, true);
    recordApprovalEvent(state, approval, "Approval cancelled");
    cancelled.push(approval);
  }
  return cancelled;
}

/** Terminal run state outranks approval state: nothing pending or undelivered survives it. */
export function settleApprovalsForTerminalRun(state: State, runId: string, at: string) {
  for (const approval of approvalsForRun(state, runId)) {
    if (approval.status === "pending") {
      resolve(approval, "cancelled", { kind: "system" }, at, false);
      recordApprovalEvent(state, approval, "Approval cancelled");
    } else {
      markNotApplied(approval, "the run ended before the harness confirmed the decision", at);
    }
  }
}

function deliveryBlocker(state: State, approval: ApprovalRequest, at: string): string | undefined {
  const run = state.runs.find((item) => item.id === approval.runId);
  if (!run || run.status !== "running") return "the run is no longer active";
  if (run.nodeId !== approval.nodeId || run.sessionBindingId !== approval.sessionBindingId) return "the run's session was replaced";
  if (selectsOption(approval.status) && approval.expiresAt && Date.parse(approval.expiresAt) <= Date.parse(at)) return "the approval expired before its decision was delivered";
  return undefined;
}

/**
 * Returns the approvals whose decisions may be (re)sent now. A decision that can no longer reach
 * its original session is marked not-applied instead; it is never retargeted.
 */
export function approvalsAwaitingDelivery(state: State, approvals: readonly ApprovalRequest[], at: string) {
  const deliverable: ApprovalRequest[] = [];
  for (const approval of approvals) {
    if (!isTerminalApprovalStatus(approval.status) || !approval.delivery) continue;
    if (approval.delivery.status !== "pending" && approval.delivery.status !== "sent") continue;
    const blocker = deliveryBlocker(state, approval, at);
    if (!blocker) {
      deliverable.push(approval);
    } else if (approval.delivery.status === "pending" || !blocker.startsWith("the approval expired")) {
      // A decision already written before expiry may still be applied; its harness result settles it.
      markNotApplied(approval, blocker, at);
    }
  }
  return deliverable;
}

/** Expires pending approvals whose deadline passed; returns the expirations to deliver. */
export function expireApprovals(state: State, at: string) {
  const before = JSON.stringify(state.approvals ?? []);
  const expired: ApprovalRequest[] = [];
  const undelivered: ApprovalRequest[] = [];
  const now = Date.parse(at);
  for (const approval of state.approvals ?? []) {
    if (approval.status === "pending" && approval.expiresAt && Date.parse(approval.expiresAt) <= now) {
      resolve(approval, "expired", { kind: "system" }, at, true);
      recordApprovalEvent(state, approval, "Approval expired");
      expired.push(approval);
    } else if (approval.delivery?.status === "pending") {
      undelivered.push(approval);
    }
  }
  approvalsAwaitingDelivery(state, undelivered, at);
  const deliverable = approvalsAwaitingDelivery(state, expired, at);
  return { deliverable, changed: before !== JSON.stringify(state.approvals ?? []) };
}

/**
 * Reconciles approvals after a Barista reconnect barrier. Runs Barista no longer reports as active
 * lost their live session, so their approvals can never be applied; undelivered decisions for runs
 * still active on the same session are returned for redelivery.
 */
export function reconcileApprovalsForNode(state: State, nodeId: string, activeRunIds: readonly string[], at: string) {
  const active = new Set(activeRunIds);
  const candidates: ApprovalRequest[] = [];
  let changed = false;
  for (const approval of state.approvals ?? []) {
    if (approval.nodeId !== nodeId) continue;
    const run = state.runs.find((item) => item.id === approval.runId);
    if (!run || isTerminalRunStatus(run.status)) continue;
    if (!active.has(approval.runId)) {
      if (approval.status === "pending") {
        resolve(approval, "cancelled", { kind: "system" }, at, false);
        recordApprovalEvent(state, approval, "Approval cancelled");
        changed = true;
      } else {
        changed = markNotApplied(approval, "Barista no longer runs the session that raised this approval", at) || changed;
      }
      continue;
    }
    if (approval.delivery?.status === "pending" || approval.delivery?.status === "sent") candidates.push(approval);
  }
  const before = JSON.stringify(candidates.map((approval) => approval.delivery));
  const deliverable = approvalsAwaitingDelivery(state, candidates, at);
  changed ||= before !== JSON.stringify(candidates.map((approval) => approval.delivery));
  return { deliverable, changed };
}

/** Records that decisions were written to Barista; confirmed or refuted deliveries are untouched. */
export function recordDeliveryAttempts(state: State, approvalIds: readonly string[], at: string) {
  let changed = false;
  for (const approval of state.approvals ?? []) {
    if (!approvalIds.includes(approval.id) || !approval.delivery) continue;
    if (approval.delivery.status !== "pending" && approval.delivery.status !== "sent") continue;
    approval.delivery = { status: "sent", attempts: approval.delivery.attempts + 1, updatedAt: at };
    changed = true;
  }
  return changed;
}

/** Barista refused a decision: it is not applied, whatever the hub believed about delivery. */
export function recordUndeliverable(state: State, nodeId: string, runId: string, harnessApprovalId: string, reason: string, at: string) {
  const approval = findHarnessApproval(state, runId, harnessApprovalId);
  if (!approval || approval.nodeId !== nodeId) return false;
  return markNotApplied(approval, `Barista refused the decision: ${reason}`, at);
}

export interface ApprovalResolutionInput {
  idempotencyKey: string;
  expectedStatus: "pending";
  optionId?: string;
  cancel?: true;
  runId?: string;
}

export function parseApprovalResolution(value: unknown): Validation<ApprovalResolutionInput> {
  const allowed = ["idempotencyKey", "expectedStatus", "optionId", "cancel", "runId"];
  if (!isRecord(value) || !Object.keys(value).every((key) => allowed.includes(key))) return { ok: false, reason: "Resolution must contain only idempotencyKey, expectedStatus, optionId, cancel, and runId" };
  const { idempotencyKey, expectedStatus, optionId, cancel, runId } = value;
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0 || encoder.encode(idempotencyKey).length > approvalIdempotencyKeyBytes) {
    return { ok: false, reason: `idempotencyKey must be a non-empty string of at most ${approvalIdempotencyKeyBytes} bytes` };
  }
  if (expectedStatus !== "pending") return { ok: false, reason: "expectedStatus must be \"pending\"" };
  if ((optionId === undefined) === (cancel === undefined)) return { ok: false, reason: "Provide exactly one of optionId or cancel" };
  if (optionId !== undefined && (typeof optionId !== "string" || optionId.length === 0)) return { ok: false, reason: "optionId must be a non-empty string" };
  if (cancel !== undefined && cancel !== true) return { ok: false, reason: "cancel must be true when provided" };
  if (runId !== undefined && (typeof runId !== "string" || runId.length === 0)) return { ok: false, reason: "runId must be a non-empty string" };
  const input: ApprovalResolutionInput = { idempotencyKey, expectedStatus };
  if (typeof optionId === "string") input.optionId = optionId;
  if (cancel === true) input.cancel = true;
  if (typeof runId === "string") input.runId = runId;
  return { ok: true, value: input };
}

export type ApprovalResolutionResult =
  | { kind: "resolved"; approval: ApprovalRequest }
  | { kind: "replayed"; approval: ApprovalRequest }
  | { kind: "not-found" }
  | { kind: "option-not-offered"; approval: ApprovalRequest }
  | { kind: "conflict"; reason: string; approval: ApprovalRequest; changed: boolean };

function sameResolution(approval: ApprovalRequest, input: ApprovalResolutionInput) {
  if (input.cancel) return approval.status === "cancelled" && approval.selectedOptionId === undefined;
  return selectsOption(approval.status) && approval.selectedOptionId === input.optionId;
}

/**
 * Applies a resolution. Only a pending approval of a live, unchanged session can be resolved, and
 * `resolvedBy` records who resolved it; the caller has already proved that authority. An expiry
 * discovered here is the hub's own, so it is always recorded as a system resolution.
 */
export function resolveApprovalInState(
  state: State,
  approvalId: string,
  input: ApprovalResolutionInput,
  at: string,
  resolvedBy: ApprovalResolvedBy = { kind: "operator" }
): ApprovalResolutionResult {
  const approval = (state.approvals ?? []).find((item) => item.id === approvalId);
  if (!approval) return { kind: "not-found" };
  if (input.runId !== undefined && input.runId !== approval.runId) return { kind: "conflict", reason: "The approval belongs to a different run", approval, changed: false };
  if (approval.resolutionIdempotencyKey === input.idempotencyKey) {
    return sameResolution(approval, input)
      ? { kind: "replayed", approval }
      : { kind: "conflict", reason: "The idempotency key was already used for a different resolution", approval, changed: false };
  }
  if (approval.status !== input.expectedStatus) return { kind: "conflict", reason: `The approval is already ${approval.status}`, approval, changed: false };
  const run = state.runs.find((item) => item.id === approval.runId);
  if (!run || run.status !== "running") return { kind: "conflict", reason: "The approval's run is no longer active", approval, changed: false };
  if (run.nodeId !== approval.nodeId || run.sessionBindingId !== approval.sessionBindingId) return { kind: "conflict", reason: "The approval's session was replaced", approval, changed: false };
  if (approval.expiresAt && Date.parse(approval.expiresAt) <= Date.parse(at)) {
    resolve(approval, "expired", { kind: "system" }, at, true);
    recordApprovalEvent(state, approval, "Approval expired");
    return { kind: "conflict", reason: "The approval expired", approval, changed: true };
  }
  if (input.cancel) {
    resolve(approval, "cancelled", resolvedBy, at, true);
  } else {
    const option = approval.options.find((item) => item.id === input.optionId);
    if (!option) return { kind: "option-not-offered", approval };
    resolve(approval, decisionStatus(option.kind), resolvedBy, at, true);
    approval.selectedOptionId = option.id;
  }
  approval.resolutionIdempotencyKey = input.idempotencyKey;
  recordApprovalEvent(state, approval, `Approval ${approval.status}`);
  return { kind: "resolved", approval };
}

/*
 * External orchestrator access to approvals.
 *
 * `docs/architecture.md` records that nothing a harness reports can approve anything. This is the
 * one path that lets a caller other than an operator decide a worker approval, and it is narrow on
 * purpose: the credential must hold `resolve-approvals`, which only an operator can grant, and the
 * approval must belong to a task of a thread the calling connection is attached to right now.
 *
 * Nothing here reads a cached scope, a welcome frame, or anything the client sent: authority is
 * recomputed from committed state on every call, inside the transaction that commits a resolution,
 * so a scope removed or a credential revoked while the call was in flight refuses it.
 */

/** How many approvals of a thread one `list_approvals` call reports, newest first. */
export const orchestratorApprovalListLimits = { pending: 50, settled: 20 } as const;

export interface OrchestratorApprovalView {
  id: string;
  taskId: string;
  runId: string;
  title: string;
  detail?: string;
  options: ApprovalOption[];
  status: ApprovalStatus;
  requestedAt: string;
  expiresAt?: string;
  resolvedAt?: string;
  resolvedBy?: ApprovalResolvedBy;
  selectedOptionId?: string;
}

/**
 * The thread whose task attempt raised this approval. An approval whose run is not an attempt of a
 * known task belongs to no thread an orchestrator may act on, so it is invisible to these tools.
 */
function threadOfApprovedTask(state: Readonly<State>, approval: ApprovalRequest): string | undefined {
  if (approval.taskId === undefined) return undefined;
  const task = (state.tasks ?? []).find((item) => item.id === approval.taskId);
  return task !== undefined && task.attemptRunIds.includes(approval.runId) ? task.threadId : undefined;
}

export function orchestratorApprovalView(approval: ApprovalRequest, taskId: string): OrchestratorApprovalView {
  return {
    id: approval.id,
    taskId,
    runId: approval.runId,
    title: approval.title,
    ...(approval.detail === undefined ? {} : { detail: approval.detail }),
    options: approval.options.map((option) => ({ ...option })),
    status: approval.status,
    requestedAt: approval.requestedAt,
    ...(approval.expiresAt === undefined ? {} : { expiresAt: approval.expiresAt }),
    ...(approval.resolvedAt === undefined ? {} : { resolvedAt: approval.resolvedAt }),
    ...(approval.resolvedBy === undefined ? {} : { resolvedBy: { ...approval.resolvedBy } }),
    ...(approval.selectedOptionId === undefined ? {} : { selectedOptionId: approval.selectedOptionId })
  };
}

/**
 * A thread's approvals: every pending one first, then the most recently settled ones. Approvals are
 * stored newest first, so the settled tail is the recent history an orchestrator can learn from
 * without being handed the whole record.
 */
export function orchestratorApprovalViews(state: Readonly<State>, threadId: string): OrchestratorApprovalView[] {
  const owned = (state.approvals ?? [])
    .map((approval) => ({ approval, threadId: threadOfApprovedTask(state, approval) }))
    .filter((entry) => entry.threadId === threadId);
  const pending = owned.filter((entry) => entry.approval.status === "pending").slice(0, orchestratorApprovalListLimits.pending);
  const settled = owned.filter((entry) => entry.approval.status !== "pending").slice(0, orchestratorApprovalListLimits.settled);
  return [...pending, ...settled].map((entry) => orchestratorApprovalView(entry.approval, entry.approval.taskId!));
}

export type OrchestratorApprovalAuthority =
  | { kind: "authorized"; attachments: OrchestratorAttachment[] }
  | { kind: "not-attached" }
  | { kind: "forbidden" };

/**
 * Whether this connection may act on approvals, decided only from committed state. Naming a thread
 * narrows the answer to that thread's attachment; omitting it answers for every thread the
 * connection holds.
 */
export function orchestratorApprovalAuthority(state: Readonly<State>, connectionId: string, threadId?: string): OrchestratorApprovalAuthority {
  const held = (state.orchestratorAttachments ?? []).filter((attachment) =>
    attachment.connectionId === connectionId && attachment.status === "attached" && (threadId === undefined || attachment.threadId === threadId));
  if (held.length === 0) return { kind: "not-attached" };
  const attachments = held.filter((attachment) => {
    const client = (state.orchestratorClients ?? []).find((item) => item.id === attachment.clientId);
    return client !== undefined && client.revokedAt === undefined && client.scopes.includes("resolve-approvals");
  });
  return attachments.length === 0 ? { kind: "forbidden" } : { kind: "authorized", attachments };
}

export interface OrchestratorApprovalResolutionRequest {
  approvalId: string;
  resolution: ApprovalResolutionInput;
}

export type OrchestratorApprovalResolutionResult =
  | { kind: "not-attached" }
  | { kind: "forbidden" }
  | ApprovalResolutionResult;

/** Parses `resolve_approval` arguments; the resolution itself is validated by the operator parser. */
export function parseOrchestratorApprovalResolution(value: unknown): Validation<OrchestratorApprovalResolutionRequest> {
  const allowed = ["approvalId", "idempotencyKey", "optionId", "cancel"];
  if (!isRecord(value) || !Object.keys(value).every((key) => allowed.includes(key))) {
    return { ok: false, reason: "resolve_approval accepts only approvalId, idempotencyKey, optionId, and cancel" };
  }
  const { approvalId, ...rest } = value;
  if (typeof approvalId !== "string" || approvalId.length === 0) return { ok: false, reason: "approvalId must be a non-empty string" };
  const resolution = parseApprovalResolution({ ...rest, expectedStatus: "pending" });
  if (!resolution.ok) return resolution;
  return { ok: true, value: { approvalId, resolution: resolution.value } };
}

/**
 * Resolves one approval on behalf of an attached external orchestrator. Call it inside the store
 * transaction that commits the resolution: it re-reads the credential's scopes and revocation from
 * the state being committed, so no earlier read can authorize a decision.
 *
 * An approval this connection may not act on — another thread's, or one whose run is no attempt of
 * a known task — is reported exactly as an approval that does not exist, so the answer never leaks
 * which approvals the hub holds.
 */
export function resolveApprovalForOrchestrator(
  state: State,
  connectionId: string,
  request: OrchestratorApprovalResolutionRequest,
  at: string
): OrchestratorApprovalResolutionResult {
  const authority = orchestratorApprovalAuthority(state, connectionId);
  if (authority.kind !== "authorized") return authority;
  const approval = (state.approvals ?? []).find((item) => item.id === request.approvalId);
  const threadId = approval === undefined ? undefined : threadOfApprovedTask(state, approval);
  const attachment = threadId === undefined ? undefined : authority.attachments.find((item) => item.threadId === threadId);
  if (approval === undefined || attachment === undefined) return { kind: "not-found" };
  return resolveApprovalInState(state, approval.id, request.resolution, at, {
    kind: "orchestrator",
    clientId: attachment.clientId,
    attachmentId: attachment.id
  });
}
