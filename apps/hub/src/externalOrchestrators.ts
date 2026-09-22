import {
  orchestratorClientHeartbeatExpirySeconds,
  threadOrchestrator,
  type OrchestratorAttachment,
  type OrchestratorAttachmentStatus,
  type Thread,
  type ThreadStatus,
  type Validation
} from "@coffee-shop/protocol";
import { inboxFor, pendingOrchestratorEvents } from "./orchestratorInbox.js";
import { newEvent, newId, type State } from "./store.js";
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
