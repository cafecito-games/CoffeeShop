import { orchestrationToolLimits, type TaskEventChange, type TaskMessageParticipant, type TaskStatus } from "@coffee-shop/protocol";
import type { State } from "./store.js";

/*
 * Task event journal.
 *
 * Every committed transaction is compared with the state it replaced, and each new task message
 * and each change to a task's status, current attempt, or progress is appended to a hub-only
 * journal under a sequence that increases monotonically within its thread. Recording happens in
 * `Store.transact` rather than at each mutation site, so no code path can change a task without
 * waking the callers waiting on it. Several transitions made by one transaction collapse into one
 * entry whose `previousStatus` is the committed status before it.
 */

export type TaskEventEntry =
  | { threadId: string; sequence: number; at: string; kind: "message"; messageId: string; recipientKey: string }
  | {
    threadId: string;
    sequence: number;
    at: string;
    kind: "task";
    taskId: string;
    status: TaskStatus;
    previousStatus?: TaskStatus;
    changes: TaskEventChange[];
    attemptRunId?: string;
    attempt?: number;
  };

/** Per-thread journal bounds: `head` is the last assigned sequence and `floor` the last pruned one. */
export interface TaskEventStream {
  threadId: string;
  head: number;
  floor: number;
}

/** The mailbox a participant owns within its thread. */
export function participantKey(participant: TaskMessageParticipant) {
  return participant.type === "task" ? `task:${participant.taskId}` : participant.type;
}

function stream(state: State, threadId: string) {
  state.taskEventStreams ??= [];
  let current = state.taskEventStreams.find((item) => item.threadId === threadId);
  if (!current) {
    current = { threadId, head: 0, floor: 0 };
    state.taskEventStreams.push(current);
  }
  return current;
}

type NewEntry = TaskEventEntry extends infer Entry ? Entry extends TaskEventEntry ? Omit<Entry, "sequence" | "at"> : never : never;

/** Appends journal entries describing how `next` differs from `previous`; returns whether it did. */
export function recordTaskEvents(previous: Readonly<State>, next: State, at: string) {
  const entries: NewEntry[] = [];
  const previousTasks = new Map((previous.tasks ?? []).map((task) => [task.id, task]));
  for (const task of next.tasks ?? []) {
    const before = previousTasks.get(task.id);
    const changes: TaskEventChange[] = [];
    if (before?.status !== task.status) changes.push("status");
    if (before && (before.assignment?.runId !== task.assignment?.runId || before.attemptRunIds.length !== task.attemptRunIds.length)) changes.push("attempt");
    if (before && JSON.stringify(before.progress) !== JSON.stringify(task.progress)) changes.push("progress");
    if (!changes.length) continue;
    const attemptRunId = task.assignment?.runId ?? task.attemptRunIds.at(-1);
    entries.push({
      threadId: task.threadId,
      kind: "task",
      taskId: task.id,
      status: task.status,
      previousStatus: before?.status,
      changes,
      attemptRunId,
      attempt: attemptRunId === undefined ? undefined : task.attemptRunIds.indexOf(attemptRunId) + 1
    });
  }
  const previousMessageIds = new Set((previous.taskMessages ?? []).map((message) => message.id));
  for (const message of next.taskMessages ?? []) {
    if (previousMessageIds.has(message.id)) continue;
    entries.push({ threadId: message.threadId, kind: "message", messageId: message.id, recipientKey: participantKey(message.recipient) });
  }
  if (!entries.length) return false;
  next.taskEventJournal ??= [];
  const touched = new Set<string>();
  for (const entry of entries) {
    const current = stream(next, entry.threadId);
    current.head += 1;
    next.taskEventJournal.push({ ...entry, sequence: current.head, at } as TaskEventEntry);
    touched.add(entry.threadId);
  }
  for (const threadId of touched) prune(next, threadId);
  return true;
}

function prune(state: State, threadId: string) {
  const journal = state.taskEventJournal ?? [];
  const count = journal.reduce((total, entry) => total + (entry.threadId === threadId ? 1 : 0), 0);
  let excess = count - orchestrationToolLimits.retainedEventsPerThread;
  if (excess <= 0) return;
  const current = stream(state, threadId);
  state.taskEventJournal = journal.filter((entry) => {
    if (excess <= 0 || entry.threadId !== threadId) return true;
    excess -= 1;
    current.floor = Math.max(current.floor, entry.sequence);
    return false;
  });
}

/** Journal bounds for a thread; a thread with no events has head and floor 0. */
export function taskEventStream(state: Readonly<State>, threadId: string): TaskEventStream {
  return state.taskEventStreams?.find((item) => item.threadId === threadId) ?? { threadId, head: 0, floor: 0 };
}

/** Retained entries of a thread after `sequence`, in order. */
export function taskEventsAfter(state: Readonly<State>, threadId: string, sequence: number) {
  return (state.taskEventJournal ?? []).filter((entry) => entry.threadId === threadId && entry.sequence > sequence);
}
