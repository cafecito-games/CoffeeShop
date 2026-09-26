import { isActiveRunStatus, threadOwnerAgentId, threadStatuses, type Thread, type ThreadStatus } from "@coffee-shop/protocol";
import { CoordinationError } from "./coordinationError.js";
import { callerAttribution, resolveCaller, resolveExternalCaller } from "./mailbox.js";
import { newEvent, newId, type State, type Store } from "./store.js";

/** Bounds shared by every thread producer, including the external-orchestrator `create_thread`. */
export const threadTitleLimit = 120;
export const threadObjectiveLimit = 8_000;
const maximumTitleLength = threadTitleLimit;
const maximumObjectiveLength = threadObjectiveLimit;
const maximumSummaryLength = 4_000;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CoordinationError("invalid_arguments", "Thread changes must be an object");
  return value as Record<string, unknown>;
}

function optionalString(values: Record<string, unknown>, key: string, maximum: number) {
  if (values[key] === undefined) return undefined;
  if (typeof values[key] !== "string") throw new CoordinationError("invalid_arguments", `${key} must be a string`);
  const value = values[key].trim();
  if (!value) throw new CoordinationError("invalid_arguments", `${key} cannot be empty`);
  if (value.length > maximum) throw new CoordinationError("invalid_arguments", `${key} must be at most ${maximum} characters`);
  return value;
}

export function threadTitleFromObjective(objective: string) {
  const firstLine = objective.trim().split(/\r?\n/, 1)[0].replace(/\s+/g, " ");
  if (firstLine.length <= maximumTitleLength) return firstLine;
  return `${firstLine.slice(0, maximumTitleLength - 1).trimEnd()}…`;
}

export function newThread(ownerAgentId: string, objective: string, createdBy: Thread["createdBy"], at = new Date().toISOString()): Thread {
  return {
    id: newId("thread"),
    title: threadTitleFromObjective(objective),
    objective,
    summary: "",
    status: "active",
    ownerAgentId,
    orchestrator: { kind: "agent", agentId: ownerAgentId },
    createdBy,
    createdAt: at,
    updatedAt: at
  };
}

/**
 * A thread driven by an external orchestrator client. It has no owner agent, so no scheduling pass
 * can queue an orchestrator run against it, and `createdBy` stays `"agent"`: the thread was opened
 * by a model rather than by an operator acting in the PWA, which is the distinction every existing
 * reader of this field draws.
 */
export function newExternalThread(clientId: string, objective: string, title: string | undefined, at = new Date().toISOString()): Thread {
  return {
    id: newId("thread"),
    title: title ?? threadTitleFromObjective(objective),
    objective,
    summary: "",
    status: "active",
    orchestrator: { kind: "external", clientId },
    createdBy: "agent",
    createdAt: at,
    updatedAt: at
  };
}

function applyStatus(thread: Thread, status: ThreadStatus, at: string) {
  thread.status = status;
  if (status === "active") {
    thread.completedAt = undefined;
    thread.archivedAt = undefined;
  } else if (status === "completed") {
    thread.completedAt ??= at;
    thread.archivedAt = undefined;
  } else {
    thread.archivedAt = at;
  }
}

function requestedChanges(argumentsValue: unknown, allowArchive: boolean) {
  const values = record(argumentsValue);
  const unknown = Object.keys(values).find((key) => !["title", "objective", "summary", "status"].includes(key));
  if (unknown) throw new CoordinationError("invalid_arguments", "Thread changes contain an unknown field");
  const title = optionalString(values, "title", maximumTitleLength);
  const objective = optionalString(values, "objective", maximumObjectiveLength);
  let summary: string | undefined;
  if (values.summary !== undefined) {
    if (typeof values.summary !== "string") throw new CoordinationError("invalid_arguments", "summary must be a string");
    summary = values.summary.trim();
    if (summary.length > maximumSummaryLength) throw new CoordinationError("invalid_arguments", `summary must be at most ${maximumSummaryLength} characters`);
  }
  let status: ThreadStatus | undefined;
  if (values.status !== undefined) {
    if (!threadStatuses.includes(values.status as ThreadStatus)) throw new CoordinationError("invalid_arguments", "status must be active, completed, or archived");
    status = values.status as ThreadStatus;
    if (!allowArchive && status === "archived") throw new CoordinationError("forbidden", "Only an operator can archive a thread");
  }
  if (title === undefined && objective === undefined && summary === undefined && status === undefined) {
    throw new CoordinationError("invalid_arguments", "Provide at least one thread change");
  }
  return { title, objective, summary, status };
}

interface ThreadChanges {
  title?: string;
  objective?: string;
  summary?: string;
  status?: ThreadStatus;
}

/**
 * Applies validated changes inside a transaction the caller already owns. `attribution` names the
 * actor whose call this is, when there is one; otherwise the event falls back to the thread's own
 * legacy owner agent, which is what every operator and external path has always recorded. A thread
 * orchestrated by an instance records no agent identity it does not have.
 */
function applyThreadChanges(
  state: State,
  threadId: string,
  changes: ThreadChanges,
  at: string,
  currentRunId?: string,
  attribution?: { agentId?: string; instanceId?: string; allocationId?: string }
) {
  const thread = state.threads?.find((item) => item.id === threadId);
  if (!thread) throw new CoordinationError("not_found", "Thread not found");
  if (thread.status === "archived" && changes.status !== "active") throw new CoordinationError("thread_archived", "Archived threads are read-only until reopened");
  if (changes.status === "completed" && state.runs.some((run) => run.threadId === thread.id && run.id !== currentRunId && isActiveRunStatus(run.status))) {
    throw new CoordinationError("thread_in_use", "A thread with other active runs cannot be completed");
  }
  if (changes.status === "archived" && state.runs.some((run) => run.threadId === thread.id && isActiveRunStatus(run.status))) {
    throw new CoordinationError("thread_in_use", "A thread with active runs cannot be archived");
  }
  if (changes.title !== undefined) thread.title = changes.title;
  if (changes.objective !== undefined) thread.objective = changes.objective;
  if (changes.summary !== undefined) thread.summary = changes.summary;
  if (changes.status !== undefined) applyStatus(thread, changes.status, at);
  thread.updatedAt = at;
  state.events.unshift(newEvent({
    type: "status",
    title: changes.status === "archived" ? "Thread archived" : changes.status === "completed" ? "Thread completed" : "Thread updated",
    detail: thread.title,
    ...(attribution ?? (threadOwnerAgentId(thread) === undefined ? {} : { agentId: threadOwnerAgentId(thread) })),
    threadId: thread.id
  }));
  return thread;
}

async function changeThread(store: Store, threadId: string, argumentsValue: unknown, allowArchive: boolean, at: string, currentRunId?: string) {
  const changes = requestedChanges(argumentsValue, allowArchive);
  let updated: Thread | undefined;
  await store.transact((state) => {
    updated = applyThreadChanges(state, threadId, changes, at, currentRunId);
  });
  if (!updated) throw new CoordinationError("persistence_failed", "The thread was not updated", true);
  return updated;
}

/**
 * `update_thread` for an attached external orchestrator. The attachment is re-resolved inside the
 * transaction that writes the change, so an attachment replaced or detached between the call and
 * the commit cannot have its change land. Archiving stays an operator decision.
 */
export async function updateThreadForExternalOrchestrator(
  store: Store,
  connectionId: string,
  threadId: string,
  argumentsValue: unknown,
  at = new Date().toISOString()
) {
  const changes = requestedChanges(argumentsValue, false);
  let updated: Thread | undefined;
  await store.transact((state) => {
    const caller = resolveExternalCaller(state, connectionId, threadId);
    updated = applyThreadChanges(state, caller.thread.id, changes, at);
  });
  if (!updated) throw new CoordinationError("persistence_failed", "The thread was not updated", true);
  return updated;
}

/**
 * `update_thread` for a hub-hosted run. Authority is the thread's own orchestrator, resolved against
 * the calling run's runtime actor inside the transaction that writes the change: a live instance that
 * the thread names, or the legacy agent it names. A worker resident of the same thread, a replacement
 * instance the thread has not been handed to, and a released resident are all refused alike.
 */
export async function updateThreadForRun(store: Store, sourceRunId: string, argumentsValue: unknown, at = new Date().toISOString()) {
  const changes = requestedChanges(argumentsValue, false);
  let updated: Thread | undefined;
  await store.transact((state) => {
    const caller = resolveCaller(state, sourceRunId);
    if (caller.participant?.type !== "orchestrator") {
      throw new CoordinationError("forbidden", "Only the thread owner agent can update the thread");
    }
    updated = applyThreadChanges(state, caller.thread.id, changes, at, sourceRunId, callerAttribution(caller));
  });
  if (!updated) throw new CoordinationError("persistence_failed", "The thread was not updated", true);
  return updated;
}

export async function updateThreadByOperator(store: Store, threadId: string, argumentsValue: unknown, at = new Date().toISOString()) {
  return changeThread(store, threadId, argumentsValue, true, at);
}
