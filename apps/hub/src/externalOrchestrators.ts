import {
  isTerminalTaskStatus,
  orchestrationToolLimits,
  orchestratorClientHeartbeatExpirySeconds,
  threadOrchestrator,
  type OrchestratorAttachment,
  type OrchestratorAttachmentStatus,
  type OrchestratorHubToClient,
  type TaskMessage,
  type TaskMessageParticipant,
  type Thread,
  type ThreadStatus,
  type Validation
} from "@coffee-shop/protocol";
import { CoordinationError } from "./coordinationError.js";
import { inboxFor, pendingOrchestratorEvents } from "./orchestratorInbox.js";
import { newEvent, newId, type State } from "./store.js";
import { participantKey, type TaskEventEntry } from "./taskEvents.js";
import { newExternalThread, threadObjectiveLimit, threadTitleLimit } from "./threads.js";

/*
 * External orchestrator attachments.
 *
 * A bridge connection claims a thread by attaching to it, and the WebSocket is the lease: losing
 * the socket, missing heartbeats for `orchestratorClientHeartbeatExpirySeconds`, having the
 * credential revoked, or restarting the hub all end the attachment without touching the thread,
 * its tasks, or its runs. Every decision here is a pure function over `State` so that it can be
 * made inside one `Store.transact`: two connections racing to attach the same thread are ordered by
 * the store's transaction queue, and exactly one of them ends `attached`.
 *
 * Authority lives on the thread. A connection may only attach to a thread whose orchestrator is
 * this client, and a thread that does not exist is refused through the same answer as a thread
 * belonging to someone else, so an orchestrator cannot probe for thread ids it does not own.
 */

/** Ended attachments kept per thread, so a long-lived thread's reconnect history stays bounded. */
export const retainedEndedAttachmentsPerThread = 20;

const attachmentsOf = (state: State) => (state.orchestratorAttachments ??= []);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const endAttachment = (attachment: OrchestratorAttachment, status: Exclude<OrchestratorAttachmentStatus, "attached">, at: string) => {
  attachment.status = status;
  attachment.detachedAt = at;
};

/**
 * Drops the oldest ended attachments of a thread beyond the retention bound. Attachments are
 * appended in creation order, so the entries dropped first are always the oldest, and the
 * attachment that just ended is always kept.
 */
function pruneEndedAttachments(state: State, threadId: string) {
  const current = attachmentsOf(state);
  let excess = current.filter((attachment) => attachment.threadId === threadId && attachment.status !== "attached").length - retainedEndedAttachmentsPerThread;
  if (excess <= 0) return;
  state.orchestratorAttachments = current.filter((attachment) => {
    if (excess <= 0 || attachment.threadId !== threadId || attachment.status === "attached") return true;
    excess -= 1;
    return false;
  });
}

/** The single live attachment of a thread, if any. */
export const attachedAttachmentForThread = (state: Readonly<State>, threadId: string) =>
  (state.orchestratorAttachments ?? []).find((attachment) => attachment.threadId === threadId && attachment.status === "attached");

/** The threads this client orchestrates, oldest first, as persisted. */
export function externalThreadsForClient(state: Readonly<State>, clientId: string): Thread[] {
  return (state.threads ?? []).filter((thread) => {
    const orchestrator = threadOrchestrator(thread);
    return orchestrator?.kind === "external" && orchestrator.clientId === clientId;
  });
}

export interface ExternalThreadAttachmentView {
  id: string;
  connectionId: string;
  status: OrchestratorAttachmentStatus;
  attachedAt: string;
  lastHeartbeatAt: string;
}

/** What `create_thread`, `list_threads`, and `attach_thread` report about one thread. */
export interface ExternalThreadView {
  id: string;
  title: string;
  objective: string;
  summary: string;
  status: ThreadStatus;
  createdAt: string;
  updatedAt: string;
  /** The live attachment, or `null` when no connection currently holds this thread. */
  attachment: ExternalThreadAttachmentView | null;
  /** Journal entries this thread's orchestrator has not acknowledged yet. */
  unreadEvents: number;
}

export function externalThreadView(state: Readonly<State>, thread: Thread): ExternalThreadView {
  const attachment = attachedAttachmentForThread(state, thread.id);
  return {
    id: thread.id,
    title: thread.title,
    objective: thread.objective,
    summary: thread.summary,
    status: thread.status,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    attachment: attachment === undefined ? null : {
      id: attachment.id,
      connectionId: attachment.connectionId,
      status: attachment.status,
      attachedAt: attachment.attachedAt,
      lastHeartbeatAt: attachment.lastHeartbeatAt
    },
    unreadEvents: pendingOrchestratorEvents(state, thread.id, inboxFor(state, thread.id)?.processedThrough ?? 0).length
  };
}

export const externalThreadViewsForClient = (state: Readonly<State>, clientId: string) =>
  externalThreadsForClient(state, clientId).map((thread) => externalThreadView(state, thread));

export interface AttachmentRequest {
  threadId: string;
  clientId: string;
  connectionId: string;
}

export type AttachOutcome =
  | { kind: "attached"; attachment: OrchestratorAttachment; replaced?: OrchestratorAttachment }
  | { kind: "forbidden" };

/**
 * Attaches a connection to a thread it orchestrates. A thread that does not exist, is orchestrated
 * by an agent, or belongs to another client is refused identically, so refusal never discloses
 * whether the thread exists. Re-attaching the same connection is idempotent.
 */
export function attachThreadInState(state: State, request: AttachmentRequest, at: string): AttachOutcome {
  const thread = (state.threads ?? []).find((item) => item.id === request.threadId);
  const orchestrator = thread === undefined ? undefined : threadOrchestrator(thread);
  if (thread === undefined || orchestrator?.kind !== "external" || orchestrator.clientId !== request.clientId) return { kind: "forbidden" };
  const current = attachedAttachmentForThread(state, thread.id);
  if (current?.connectionId === request.connectionId) {
    current.lastHeartbeatAt = at;
    return { kind: "attached", attachment: current };
  }
  if (current !== undefined) endAttachment(current, "replaced", at);
  const attachment: OrchestratorAttachment = {
    id: newId("attachment"),
    threadId: thread.id,
    clientId: request.clientId,
    connectionId: request.connectionId,
    attachedAt: at,
    lastHeartbeatAt: at,
    status: "attached"
  };
  attachmentsOf(state).push(attachment);
  pruneEndedAttachments(state, thread.id);
  return { kind: "attached", attachment, ...(current === undefined ? {} : { replaced: current }) };
}

export type DetachOutcome =
  | { kind: "detached"; attachment: OrchestratorAttachment }
  | { kind: "not-attached" };

/** Releases the attachment this connection holds on a thread. */
export function detachThreadInState(state: State, request: Omit<AttachmentRequest, "clientId">, at: string): DetachOutcome {
  const attachment = attachmentsOf(state).find((item) =>
    item.threadId === request.threadId && item.connectionId === request.connectionId && item.status === "attached");
  if (attachment === undefined) return { kind: "not-attached" };
  endAttachment(attachment, "detached", at);
  pruneEndedAttachments(state, request.threadId);
  return { kind: "detached", attachment };
}

function detachMatching(state: State, matches: (attachment: OrchestratorAttachment) => boolean, at: string) {
  const detached = attachmentsOf(state).filter((attachment) => attachment.status === "attached" && matches(attachment));
  for (const attachment of detached) endAttachment(attachment, "detached", at);
  for (const threadId of new Set(detached.map((attachment) => attachment.threadId))) pruneEndedAttachments(state, threadId);
  return detached;
}

/** Ends every attachment a closed connection held. */
export const detachConnectionInState = (state: State, connectionId: string, at: string) =>
  detachMatching(state, (attachment) => attachment.connectionId === connectionId, at);

/** Ends every attachment of a revoked credential. */
export const detachClientInState = (state: State, clientId: string, at: string) =>
  detachMatching(state, (attachment) => attachment.clientId === clientId, at);

/** Startup reconciliation: no bridge connection survives a hub restart, so no attachment does. */
export const detachEveryAttachmentInState = (state: State, at: string) => detachMatching(state, () => true, at);

/**
 * Ends every attachment whose connection has been silent past the heartbeat expiry. A heartbeat
 * timestamp the hub cannot read is treated as expired rather than as fresh.
 */
export function expireOrchestratorAttachments(state: State, at: string) {
  const deadline = Date.parse(at) - orchestratorClientHeartbeatExpirySeconds * 1000;
  return detachMatching(state, (attachment) => !(Date.parse(attachment.lastHeartbeatAt) > deadline), at);
}

/** Records a connection's heartbeat against its attachments; returns whether anything changed. */
export function recordHeartbeatInState(state: State, connectionId: string, at: string) {
  let changed = false;
  for (const attachment of attachmentsOf(state)) {
    if (attachment.connectionId !== connectionId || attachment.status !== "attached" || attachment.lastHeartbeatAt === at) continue;
    attachment.lastHeartbeatAt = at;
    changed = true;
  }
  return changed;
}

export interface ExternalThreadInput {
  title?: string;
  objective: string;
}

const parseBoundedString = (values: Record<string, unknown>, key: string, limit: number): Validation<string> => {
  if (typeof values[key] !== "string") return { ok: false, reason: `${key} must be a string` };
  const value = values[key].trim();
  if (!value) return { ok: false, reason: `${key} cannot be empty` };
  if (value.length > limit) return { ok: false, reason: `${key} must be at most ${limit} characters` };
  return { ok: true, value };
};

/** Parses `create_thread` arguments. An unknown field is refused rather than ignored. */
export function parseExternalThreadInput(value: unknown): Validation<ExternalThreadInput> {
  if (!isRecord(value) || !Object.keys(value).every((key) => key === "title" || key === "objective")) {
    return { ok: false, reason: "create_thread accepts only title and objective" };
  }
  const objective = parseBoundedString(value, "objective", threadObjectiveLimit);
  if (!objective.ok) return objective;
  if (value.title === undefined) return { ok: true, value: { objective: objective.value } };
  const title = parseBoundedString(value, "title", threadTitleLimit);
  if (!title.ok) return title;
  return { ok: true, value: { title: title.value, objective: objective.value } };
}

/** Parses the arguments of `attach_thread` and `detach_thread`. */
export function parseThreadReference(value: unknown): Validation<string> {
  if (!isRecord(value) || !Object.keys(value).every((key) => key === "threadId")) return { ok: false, reason: "Provide only threadId" };
  return parseBoundedString(value, "threadId", 200);
}

export interface ExternalThreadCreation {
  thread: Thread;
  attachment: OrchestratorAttachment;
}

/**
 * Opens a thread for an external orchestrator and attaches the creating connection to it. No run is
 * queued: an external thread has no owner agent, and the orchestrator itself decides what work to
 * submit.
 */
export function createExternalThreadInState(
  state: State,
  request: { clientId: string; connectionId: string } & ExternalThreadInput,
  at: string
): ExternalThreadCreation {
  const thread = newExternalThread(request.clientId, request.objective, request.title, at);
  (state.threads ??= []).push(thread);
  state.events.unshift(newEvent({ type: "status", title: "Thread created", detail: thread.title, threadId: thread.id }));
  const outcome = attachThreadInState(state, { threadId: thread.id, clientId: request.clientId, connectionId: request.connectionId }, at);
  if (outcome.kind !== "attached") throw new Error("A newly created external thread could not be attached");
  return { thread, attachment: outcome.attachment };
}

/*
 * Doorbell policy.
 *
 * A doorbell is a push, never a delivery: it tells an attached session that its thread has
 * something waiting, and the orchestrator then pulls through `get_thread_events`. The
 * acknowledged cursor stays the only delivery truth, so nothing a ring decides is ever persisted;
 * losing one costs latency and never events.
 *
 * Everything a doorbell says is built from hub-owned structured fields — the thread's own title,
 * counts of unacknowledged journal entries by kind, and the earliest approval expiry. Worker
 * output reaches the model only through tool results it asked for, never through a summary pushed
 * into an operator's session without review.
 */

/** The doorbell frame, exactly as `@coffee-shop/protocol` declares it. */
export type Doorbell = Extract<OrchestratorHubToClient, { type: "doorbell" }>;

/** At most one ring per thread within this window. */
export const doorbellDebounceMilliseconds = 2_000;
/** A pending approval this close to expiry earns one further ring, once. */
export const doorbellApprovalWarningMilliseconds = 3 * 60_000;
/** The hard bound on a summary; the wire allows far more than an operator wants to read. */
export const doorbellSummaryLimit = 300;
/** How much of a summary a thread title may spend. */
export const doorbellTitleLimit = 60;

/** What a doorbell counts. Each unacknowledged journal entry has exactly one of these kinds. */
export const doorbellEventKinds = ["completed", "failed", "cancelled", "blocked", "message"] as const;
export type DoorbellEventKind = typeof doorbellEventKinds[number];
export type DoorbellCounts = Record<DoorbellEventKind, number>;

const doorbellKindForTerminalStatus: Readonly<Record<string, DoorbellEventKind>> = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  blocked: "blocked"
};

/**
 * The kind a pending journal entry counts as. A task entry that is relevant without a terminal
 * status is one that reported itself blocked, so an unrecognized status is counted as blocked
 * rather than dropped: a doorbell may undercount nothing.
 */
export function doorbellEventKindFor(entry: TaskEventEntry): DoorbellEventKind {
  if (entry.kind === "message") return "message";
  if (!entry.changes.includes("status") || !isTerminalTaskStatus(entry.status)) return "blocked";
  return doorbellKindForTerminalStatus[entry.status] ?? "blocked";
}

/** A pending approval, reduced to the fields a doorbell may report. */
export interface DoorbellApproval {
  id: string;
  expiresAt?: string;
}

/** The hub-owned facts one ring may report; by construction it holds no worker-authored text. */
export interface DoorbellFacts {
  threadId: string;
  title: string;
  /** Unacknowledged orchestrator-relevant journal entries. */
  pending: number;
  /** The highest unacknowledged sequence, or 0 when nothing is pending. */
  throughSequence: number;
  counts: DoorbellCounts;
  approvals: DoorbellApproval[];
}

const emptyDoorbellCounts = (): DoorbellCounts => ({ completed: 0, failed: 0, cancelled: 0, blocked: 0, message: 0 });

/**
 * Reads what a thread's attached orchestrator still has waiting. Returns `undefined` for a thread
 * that does not exist or is orchestrated by an agent, so no caller can ring a thread the hub drives
 * itself.
 */
export function doorbellFactsFor(state: Readonly<State>, threadId: string): DoorbellFacts | undefined {
  const thread = (state.threads ?? []).find((item) => item.id === threadId);
  if (thread === undefined || threadOrchestrator(thread)?.kind !== "external") return undefined;
  const entries = pendingOrchestratorEvents(state, threadId, inboxFor(state, threadId)?.processedThrough ?? 0);
  const counts = emptyDoorbellCounts();
  for (const entry of entries) counts[doorbellEventKindFor(entry)] += 1;
  const approvals = (state.approvals ?? [])
    .filter((approval) => {
      if (approval.status !== "pending") return false;
      const run = state.runs.find((item) => item.id === approval.runId);
      return (run?.threadId ?? approval.threadId) === threadId;
    })
    .map((approval) => ({ id: approval.id, ...(approval.expiresAt === undefined ? {} : { expiresAt: approval.expiresAt }) }));
  return {
    threadId,
    title: thread.title,
    pending: entries.length,
    throughSequence: entries.at(-1)?.sequence ?? 0,
    counts,
    approvals
  };
}

/**
 * What one attachment remembers about its own rings. It is in-memory by design: attaching rings the
 * backlog, so a hub restart costs at most one extra ring and never a missed one.
 */
export interface DoorbellRingRecord {
  rungAt: string;
  rungThroughSequence: number;
  /** Approvals a ring has already reported, so an approval earns exactly one ring when it opens. */
  rungApprovalIds: readonly string[];
  /** Approvals already rung because their expiry was near, so each earns exactly one such ring. */
  warnedApprovalIds: readonly string[];
}

/** `attach` rings a backlog immediately; `change` is every other re-evaluation. */
export type DoorbellTrigger = "attach" | "change";

export type DoorbellDecision =
  | { kind: "ring"; doorbell: Doorbell; record: DoorbellRingRecord }
  /** Suppressed by the debounce window; re-evaluate after this delay to coalesce the burst. */
  | { kind: "wait"; retryAfterMilliseconds: number }
  | { kind: "quiet" };

const singular: Readonly<Record<DoorbellEventKind, string>> = {
  completed: "task completed",
  failed: "task failed",
  cancelled: "task cancelled",
  blocked: "task blocked",
  message: "message"
};

const plural: Readonly<Record<DoorbellEventKind, string>> = {
  completed: "tasks completed",
  failed: "tasks failed",
  cancelled: "tasks cancelled",
  blocked: "tasks blocked",
  message: "messages"
};

/** A timestamp the hub wrote, in milliseconds, or `undefined` when it cannot be read. */
const readTime = (value: string | undefined) => {
  const parsed = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Collapses a title to one bounded single-line run, deterministically. */
function boundedTitle(title: string) {
  const flattened = title.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/"/g, "'").replace(/\s+/g, " ").trim();
  if (!flattened) return "untitled";
  return flattened.length <= doorbellTitleLimit ? flattened : `${flattened.slice(0, doorbellTitleLimit - 1)}…`;
}

/** Truncates to the summary bound at a fixed position, so the same facts always read the same. */
const boundedSummary = (summary: string) =>
  (summary.length <= doorbellSummaryLimit ? summary : `${summary.slice(0, doorbellSummaryLimit - 1)}…`);

/** The UTC `HH:MM` of an expiry the hub can read. */
const expiryClock = (milliseconds: number) => new Date(milliseconds).toISOString().slice(11, 16);

/** The one sentence a doorbell carries; built from `facts` alone and bounded. */
export function doorbellSummary(facts: DoorbellFacts): string {
  const parts = doorbellEventKinds
    .filter((kind) => facts.counts[kind] > 0)
    .map((kind) => `${facts.counts[kind]} ${(facts.counts[kind] === 1 ? singular : plural)[kind]}`);
  if (facts.approvals.length > 0) {
    const expiries = facts.approvals.map((approval) => readTime(approval.expiresAt)).filter((value): value is number => value !== undefined);
    const earliest = expiries.length > 0 ? Math.min(...expiries) : undefined;
    parts.push(`${facts.approvals.length} approval${facts.approvals.length === 1 ? "" : "s"} pending`
      + (earliest === undefined ? "" : ` (earliest expires ${expiryClock(earliest)}Z)`));
  }
  const body = parts.length > 0 ? parts.join(", ") : "new activity";
  return boundedSummary(`Thread "${boundedTitle(facts.title)}": ${body}. Call get_thread_events.`);
}

/**
 * Decides whether to ring, given what is waiting, what the last ring covered, and the clock. Pure:
 * the caller injects `now` and owns both the socket and the record, so the policy itself is
 * testable without waiting for a window to pass.
 */
export function decideDoorbell(
  facts: DoorbellFacts,
  previous: DoorbellRingRecord | undefined,
  trigger: DoorbellTrigger,
  now: string
): DoorbellDecision {
  if (facts.pending === 0 && facts.approvals.length === 0) return { kind: "quiet" };
  const at = readTime(now);
  const rung = new Set(previous?.rungApprovalIds ?? []);
  const warned = new Set(previous?.warnedApprovalIds ?? []);
  const expiringSoon = at === undefined ? [] : facts.approvals.filter((approval) => {
    const expiresAt = readTime(approval.expiresAt);
    return expiresAt !== undefined && expiresAt - at <= doorbellApprovalWarningMilliseconds;
  });
  const newEvents = facts.throughSequence > (previous?.rungThroughSequence ?? 0);
  // An approval opens no journal entry, so it is its own reason to ring, once when it opens and
  // once more as its expiry closes in.
  const newApprovals = facts.approvals.some((approval) => !rung.has(approval.id));
  const newlyExpiring = expiringSoon.some((approval) => !warned.has(approval.id));
  // Attaching rings the backlog at once, but only what the last ring for this attachment did not
  // already cover; an attachment that has just been rung is not rung twice for the same events.
  if (!newEvents && !newApprovals && !newlyExpiring) return { kind: "quiet" };
  if (trigger !== "attach" && previous !== undefined) {
    const since = at === undefined ? undefined : at - (readTime(previous.rungAt) ?? Number.NaN);
    // A clock the hub cannot read never shortens the window; it only ever suppresses a ring.
    if (since === undefined || Number.isNaN(since)) return { kind: "quiet" };
    if (since < doorbellDebounceMilliseconds) return { kind: "wait", retryAfterMilliseconds: doorbellDebounceMilliseconds - since };
  }
  const stillPending = new Set(facts.approvals.map((approval) => approval.id));
  return {
    kind: "ring",
    doorbell: {
      type: "doorbell",
      threadId: facts.threadId,
      pending: facts.pending,
      approvals: facts.approvals.length,
      urgent: facts.approvals.length > 0,
      summary: doorbellSummary(facts)
    },
    record: {
      rungAt: now,
      rungThroughSequence: Math.max(previous?.rungThroughSequence ?? 0, facts.throughSequence),
      // Only approvals still pending are remembered, so the record stays as small as the backlog.
      rungApprovalIds: [...stillPending].sort(),
      warnedApprovalIds: [...new Set([...[...warned].filter((id) => stillPending.has(id)), ...expiringSoon.map((approval) => approval.id)])].sort()
    }
  };
}

/*
 * Operator messages to an externally orchestrated thread.
 *
 * An external thread has no owner agent, so a message an operator posts to it cannot queue a run.
 * It is appended to the orchestrator's mailbox instead, which makes it one more unacknowledged
 * journal entry the orchestrator pulls and acknowledges like any other.
 */

const operatorParticipant: TaskMessageParticipant = { type: "operator" };
/** The sending principal recorded on an operator's message; it names no run and no credential. */
export const operatorSourceKey = "operator";

export interface OperatorMessageRequest {
  threadId: string;
  body: string;
  /** Supplied by the client to make a retry safe; one is generated when it is absent. */
  idempotencyKey?: string;
}

export interface OperatorMessage {
  created: boolean;
  message: TaskMessage;
}

/**
 * Records an operator's message to an external thread's orchestrator. A thread that does not exist
 * and one the hub orchestrates itself are refused identically, because neither can receive one.
 * Replaying an idempotency key with the same body returns the original message.
 */
export function postOperatorMessageInState(state: State, request: OperatorMessageRequest, at: string): OperatorMessage {
  const thread = (state.threads ?? []).find((item) => item.id === request.threadId);
  if (thread === undefined || threadOrchestrator(thread)?.kind !== "external") throw new CoordinationError("not_found", "Thread not found");
  const body = request.body.trim();
  if (!body) throw new CoordinationError("invalid_arguments", "A message needs a body");
  if (body.length > orchestrationToolLimits.messageBodyLength) {
    throw new CoordinationError("invalid_arguments", `A message body must be at most ${orchestrationToolLimits.messageBodyLength} characters`);
  }
  const idempotencyKey = request.idempotencyKey?.trim() || newId("opmsg");
  if (idempotencyKey.length > orchestrationToolLimits.idempotencyKeyLength) {
    throw new CoordinationError("invalid_arguments", `idempotencyKey must be at most ${orchestrationToolLimits.idempotencyKeyLength} characters`);
  }
  state.taskMessages ??= [];
  const threadMessages = state.taskMessages.filter((message) => message.threadId === thread.id);
  const fromOperator = threadMessages.filter((message) => participantKey(message.sender) === participantKey(operatorParticipant));
  const replay = fromOperator.find((message) => message.idempotencyKey === idempotencyKey);
  if (replay !== undefined) {
    if (replay.body !== body) throw new CoordinationError("idempotency_conflict", "The idempotency key was already used with a different message");
    return { created: false, message: replay };
  }
  if (thread.status !== "active") throw new CoordinationError("thread_inactive", "Messages require an active thread");
  if (threadMessages.length >= orchestrationToolLimits.messagesPerThread || fromOperator.length >= orchestrationToolLimits.messagesPerSender) {
    throw new CoordinationError("mailbox_full", "The thread's message limit has been reached");
  }
  const recipientKey = participantKey({ type: "orchestrator" });
  const sequence = 1 + threadMessages
    .filter((message) => participantKey(message.recipient) === recipientKey)
    .reduce((latest, message) => Math.max(latest, message.sequence), 0);
  const message: TaskMessage = {
    id: newId("taskmsg"),
    threadId: thread.id,
    sender: { ...operatorParticipant },
    recipient: { type: "orchestrator" },
    sequence,
    kind: "instruction",
    body,
    artifactIds: [],
    sourceKey: operatorSourceKey,
    idempotencyKey,
    createdAt: at
  };
  state.taskMessages.push(message);
  thread.updatedAt = at;
  return { created: true, message };
}
