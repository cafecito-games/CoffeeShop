import { createHash } from "node:crypto";
import {
  isTaskMessageKind,
  orchestrationToolLimits as limits,
  type Agent,
  type Run,
  type Task,
  type TaskMailboxEvent,
  type TaskMessage,
  type TaskMessageKind,
  type TaskMessageParticipant,
  type TaskMessageView,
  type Thread
} from "@coffee-shop/protocol";
import { CoordinationError } from "./coordinationError.js";
import { newId, type State, type Store } from "./store.js";
import { participantKey, taskEventsAfter, taskEventStream } from "./taskEvents.js";

/*
 * Task mailboxes and event waiting.
 *
 * This module is the single authority for who a run is within its thread, which tasks it may see
 * or message, how mailbox messages are ordered, and how event cursors are scoped. Identity always
 * comes from the authenticated source run: tool arguments never name a thread, sender, node, or
 * workspace. Every rejection of a task, message, or artifact outside the caller's scope uses the
 * same code and wording whether or not the target exists.
 */

export interface Caller {
  run: Run;
  thread: Thread;
  agent: Agent;
  /** The task this run is an attempt of. */
  task?: Task;
  /** Mailbox identity; absent for a run that is neither a task attempt nor a thread-owner run. */
  participant?: TaskMessageParticipant;
  /** The scope event cursors are bound to. */
  scopeKey: string;
}

export const notVisible = () => new CoordinationError("not_found", "Task not found in the current task lineage");
const messageNotVisible = () => new CoordinationError("not_found", "Message not found in the current mailbox");
const invalid = (message: string) => new CoordinationError("invalid_arguments", message);

/** Resolves the authenticated caller of a hub tool; only a running run attached to a thread qualifies. */
export function resolveCaller(state: Readonly<State>, sourceRunId: string): Caller {
  const run = state.runs.find((item) => item.id === sourceRunId);
  if (!run || run.status !== "running") throw new CoordinationError("run_not_active", "The source task is not running");
  const thread = run.threadId ? state.threads?.find((item) => item.id === run.threadId) : undefined;
  if (!thread) throw new CoordinationError("not_found", "The source task is not attached to a thread");
  const agent = state.agents.find((item) => item.id === run.agentId);
  if (!agent) throw new CoordinationError("forbidden", "The source agent is not configured");
  if (run.taskId !== undefined) {
    const task = state.tasks?.find((item) => item.id === run.taskId && item.threadId === thread.id && item.attemptRunIds.includes(run.id));
    if (!task) throw new CoordinationError("forbidden", "The source run's task is unavailable");
    const participant: TaskMessageParticipant = { type: "task", taskId: task.id };
    return { run, thread, agent, task, participant, scopeKey: participantKey(participant) };
  }
  if (agent.id === thread.ownerAgentId) {
    const participant: TaskMessageParticipant = { type: "orchestrator" };
    return { run, thread, agent, participant, scopeKey: participantKey(participant) };
  }
  return { run, thread, agent, scopeKey: `run:${run.id}` };
}

interface Lineage {
  tasks: Map<string, Task>;
  parentOf(task: Task): Task | undefined;
}

function lineage(state: Readonly<State>, threadId: string): Lineage {
  const tasks = new Map((state.tasks ?? []).filter((task) => task.threadId === threadId).map((task) => [task.id, task]));
  const runs = new Map(state.runs.map((run) => [run.id, run]));
  return {
    tasks,
    parentOf: (task) => {
      const source = task.sourceRunId === undefined ? undefined : runs.get(task.sourceRunId);
      return source?.taskId === undefined ? undefined : tasks.get(source.taskId);
    }
  };
}

function ancestorsOf(graph: Lineage, task: Task) {
  const ancestors: Task[] = [];
  const seen = new Set([task.id]);
  for (let parent = graph.parentOf(task); parent && !seen.has(parent.id); parent = graph.parentOf(parent)) {
    seen.add(parent.id);
    ancestors.push(parent);
  }
  return ancestors;
}

/** Tasks submitted, directly or transitively, by the caller's run or by any attempt of its task. */
function descendantsOf(graph: Lineage, caller: Caller) {
  const ownRunIds = new Set(caller.task ? caller.task.attemptRunIds : [caller.run.id]);
  const descendants: Task[] = [];
  for (const task of graph.tasks.values()) {
    if (task.id === caller.task?.id) continue;
    const seen = new Set<string>();
    for (let current: Task | undefined = task; current && !seen.has(current.id); current = graph.parentOf(current)) {
      seen.add(current.id);
      if (current.sourceRunId !== undefined && ownRunIds.has(current.sourceRunId)) {
        descendants.push(task);
        break;
      }
    }
  }
  return descendants;
}

export interface TaskVisibility {
  /** Tasks the caller may read and observe events for. */
  readable: Set<string>;
  /** Tasks the caller may send messages to. */
  messageable: Set<string>;
}

/**
 * A thread-owner run sees and may message every task in its thread. A task attempt sees its own
 * task, its ancestors, its descendants, and the tasks it directly depends on, and may message its
 * ancestors and descendants. Any other run sees only the tasks it submitted and their descendants.
 * Sharing a node or an agent never widens visibility.
 */
export function taskVisibility(state: Readonly<State>, caller: Caller): TaskVisibility {
  const graph = lineage(state, caller.thread.id);
  if (caller.participant?.type === "orchestrator") {
    const all = new Set(graph.tasks.keys());
    return { readable: all, messageable: new Set(all) };
  }
  const descendants = descendantsOf(graph, caller).map((task) => task.id);
  if (!caller.task) return { readable: new Set(descendants), messageable: new Set() };
  const ancestors = ancestorsOf(graph, caller.task).map((task) => task.id);
  const dependencies = caller.task.dependencies.map((dependency) => dependency.taskId).filter((taskId) => graph.tasks.has(taskId));
  return {
    readable: new Set([caller.task.id, ...ancestors, ...descendants, ...dependencies]),
    messageable: new Set([...ancestors, ...descendants])
  };
}

/*
 * Event cursors are `tev1.<payload>.<checksum>`: the payload binds the thread, the caller's scope,
 * and the last journal sequence consumed, and the checksum detects corruption. A cursor is honored
 * only for the exact scope that received it, so a forged or copied cursor cannot widen what a
 * caller observes.
 */
const cursorPrefix = "tev1";
const cursorChecksum = (payload: string) => createHash("sha256").update(`coffee-shop.task-events.v1\u0000${payload}`).digest("base64url").slice(0, 22);

export function encodeTaskEventCursor(threadId: string, scopeKey: string, sequence: number) {
  const payload = Buffer.from(JSON.stringify([threadId, scopeKey, sequence]), "utf8").toString("base64url");
  return `${cursorPrefix}.${payload}.${cursorChecksum(payload)}`;
}

const invalidCursor = () => new CoordinationError("cursor_invalid", "The cursor is malformed or was not issued to this caller");

/** The journal sequence a cursor resumes after, or a typed cursor error; never the current head. */
export function decodeTaskEventCursor(state: Readonly<State>, caller: Caller, cursor: string) {
  const parts = cursor.split(".");
  if (cursor.length > limits.cursorLength || parts.length !== 3 || parts[0] !== cursorPrefix || cursorChecksum(parts[1]) !== parts[2]) throw invalidCursor();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  if (!Array.isArray(decoded) || decoded.length !== 3) throw invalidCursor();
  const [threadId, scopeKey, sequence] = decoded as unknown[];
  if (threadId !== caller.thread.id || scopeKey !== caller.scopeKey || typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) throw invalidCursor();
  const stream = taskEventStream(state, caller.thread.id);
  if (sequence > stream.head) throw invalidCursor();
  if (sequence < stream.floor) throw new CoordinationError("cursor_stale", "The cursor is older than the retained task events; call get_task_context for a current cursor");
  return sequence;
}

function acknowledgedIds(state: Readonly<State>, threadId: string) {
  return new Set((state.taskMessageAcknowledgements ?? []).filter((item) => item.threadId === threadId).map((item) => item.messageId));
}

export function messageView(message: TaskMessage, acknowledged: boolean): TaskMessageView {
  return {
    id: message.id,
    sender: { ...message.sender },
    recipient: { ...message.recipient },
    sequence: message.sequence,
    kind: message.kind,
    body: message.body,
    ...(message.correlationId !== undefined ? { correlationId: message.correlationId } : {}),
    ...(message.inReplyToMessageId !== undefined ? { inReplyToMessageId: message.inReplyToMessageId } : {}),
    artifactIds: [...(message.artifactIds ?? [])],
    acknowledged,
    createdAt: message.createdAt
  };
}

const inboxOf = (state: Readonly<State>, caller: Caller) => caller.participant
  ? (state.taskMessages ?? []).filter((message) => message.threadId === caller.thread.id && participantKey(message.recipient) === caller.scopeKey)
  : [];

export interface TaskEventPage {
  events: TaskMailboxEvent[];
  cursor: string;
  hasMore: boolean;
}

/** Committed events after `after` that the caller may observe, bounded to `maximum`. */
export function collectTaskEvents(state: Readonly<State>, caller: Caller, after: number, maximum: number): TaskEventPage {
  const visibility = taskVisibility(state, caller);
  const messages = new Map((state.taskMessages ?? []).filter((message) => message.threadId === caller.thread.id).map((message) => [message.id, message]));
  const acknowledged = acknowledgedIds(state, caller.thread.id);
  const events: TaskMailboxEvent[] = [];
  let consumed = after;
  let hasMore = false;
  for (const entry of taskEventsAfter(state, caller.thread.id, after)) {
    const relevant = entry.kind === "message"
      ? caller.participant !== undefined && entry.recipientKey === caller.scopeKey && messages.has(entry.messageId)
      : visibility.readable.has(entry.taskId);
    if (relevant && events.length >= maximum) {
      hasMore = true;
      break;
    }
    consumed = entry.sequence;
    if (!relevant) continue;
    if (entry.kind === "message") {
      const message = messages.get(entry.messageId)!;
      events.push({ type: "message", sequence: entry.sequence, at: entry.at, message: messageView(message, acknowledged.has(message.id)) });
    } else {
      events.push({
        type: "task",
        sequence: entry.sequence,
        at: entry.at,
        taskId: entry.taskId,
        status: entry.status,
        ...(entry.previousStatus !== undefined ? { previousStatus: entry.previousStatus } : {}),
        changes: [...entry.changes],
        ...(entry.attemptRunId !== undefined && entry.attempt !== undefined ? { attempt: { runId: entry.attemptRunId, number: entry.attempt } } : {})
      });
    }
  }
  if (!hasMore) consumed = Math.max(consumed, taskEventStream(state, caller.thread.id).head);
  return { events, cursor: encodeTaskEventCursor(caller.thread.id, caller.scopeKey, consumed), hasMore };
}

/** Mailbox state for `get_task_context`, including a cursor at the current head. */
export function mailboxSummary(state: Readonly<State>, caller: Caller) {
  const inbox = inboxOf(state, caller);
  const acknowledged = acknowledgedIds(state, caller.thread.id);
  const unacknowledged = inbox.filter((message) => !acknowledged.has(message.id));
  return {
    participant: caller.participant ? { ...caller.participant } : undefined,
    cursor: encodeTaskEventCursor(caller.thread.id, caller.scopeKey, taskEventStream(state, caller.thread.id).head),
    messageCount: inbox.length,
    unacknowledgedCount: unacknowledged.length,
    latestSequence: inbox.reduce((latest, message) => Math.max(latest, message.sequence), 0),
    unacknowledgedMessages: unacknowledged.slice(0, limits.contextMessages).map((message) => messageView(message, false))
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], context: string) {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw invalid(`${context} contains an unknown field`);
}

function boundedString(value: unknown, context: string, maximum: number) {
  if (typeof value !== "string") throw invalid(`${context} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw invalid(`${context} cannot be empty`);
  if (trimmed.length > maximum) throw invalid(`${context} must be at most ${maximum} characters`);
  return trimmed;
}

function identifierList(value: unknown, context: string, maximum: number) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) throw invalid(`${context} must be an array of at most ${maximum} identifiers`);
  const identifiers = value.map((item, index) => boundedString(item, `${context}[${index}]`, limits.idempotencyKeyLength));
  return [...new Set(identifiers)];
}

interface NormalizedMessage {
  idempotencyKey: string;
  recipient: TaskMessageParticipant;
  kind: TaskMessageKind;
  body: string;
  correlationId?: string;
  inReplyToMessageId?: string;
  artifactIds: string[];
}

function normalizeMessage(value: unknown): NormalizedMessage {
  if (!isRecord(value)) throw invalid("Message arguments must be an object");
  onlyKeys(value, ["idempotencyKey", "recipient", "kind", "body", "correlationId", "inReplyToMessageId", "artifactIds"], "Message arguments");
  const recipientValue = value.recipient;
  if (!isRecord(recipientValue)) throw invalid("recipient must be an object");
  let recipient: TaskMessageParticipant;
  if (recipientValue.type === "task") {
    onlyKeys(recipientValue, ["type", "taskId"], "recipient");
    recipient = { type: "task", taskId: boundedString(recipientValue.taskId, "recipient.taskId", limits.idempotencyKeyLength) };
  } else if (recipientValue.type === "orchestrator") {
    onlyKeys(recipientValue, ["type"], "recipient");
    recipient = { type: "orchestrator" };
  } else {
    throw invalid("recipient.type must be task or orchestrator");
  }
  if (!isTaskMessageKind(value.kind)) throw invalid("kind is not recognized");
  return {
    idempotencyKey: boundedString(value.idempotencyKey, "idempotencyKey", limits.idempotencyKeyLength),
    recipient,
    kind: value.kind,
    body: boundedString(value.body, "body", limits.messageBodyLength),
    ...(value.correlationId !== undefined ? { correlationId: boundedString(value.correlationId, "correlationId", limits.correlationIdLength) } : {}),
    ...(value.inReplyToMessageId !== undefined ? { inReplyToMessageId: boundedString(value.inReplyToMessageId, "inReplyToMessageId", limits.idempotencyKeyLength) } : {}),
    artifactIds: identifierList(value.artifactIds, "artifactIds", limits.messageArtifacts)
  };
}

const sameMessage = (message: TaskMessage, normalized: NormalizedMessage, sourceRunId: string) =>
  message.sourceRunId === sourceRunId
  && participantKey(message.recipient) === participantKey(normalized.recipient)
  && message.kind === normalized.kind
  && message.body === normalized.body
  && message.correlationId === normalized.correlationId
  && message.inReplyToMessageId === normalized.inReplyToMessageId
  && JSON.stringify([...(message.artifactIds ?? [])].sort()) === JSON.stringify([...normalized.artifactIds].sort());

/** Every artifact must be uploaded within the caller's thread; anything else is rejected alike. */
export function assertVisibleArtifacts(state: Readonly<State>, threadId: string, artifactIds: readonly string[], ownRunIds?: ReadonlySet<string>) {
  for (const artifactId of artifactIds) {
    const artifact = state.artifacts?.find((item) => item.id === artifactId);
    if (!artifact || !artifact.uploaded || artifact.threadId !== threadId || (ownRunIds && !ownRunIds.has(artifact.runId))) {
      throw new CoordinationError("invalid_artifact", "Every attached artifact must be uploaded and visible in this thread");
    }
  }
}

export interface SentMessage {
  created: boolean;
  message: TaskMessageView;
}

/**
 * Appends one immutable message to the recipient's mailbox. The sender is the authenticated
 * caller; the recipient must be within its messaging scope; the per-recipient sequence is
 * allocated inside the transaction, so concurrent sends never share a sequence. Replaying the
 * sender's idempotency key with the same content returns the original message.
 */
export async function sendTaskMessage(store: Store, sourceRunId: string, argumentsValue: unknown, at = new Date().toISOString()): Promise<SentMessage> {
  const normalized = normalizeMessage(argumentsValue);
  let result: SentMessage | undefined;
  await store.transact((state) => {
    const caller = resolveCaller(state, sourceRunId);
    if (!caller.participant) throw new CoordinationError("forbidden", "This run has no task mailbox");
    state.taskMessages ??= [];
    const replay = state.taskMessages.find((message) => message.threadId === caller.thread.id
      && participantKey(message.sender) === caller.scopeKey && message.idempotencyKey === normalized.idempotencyKey);
    if (replay) {
      if (!sameMessage(replay, normalized, caller.run.id)) throw new CoordinationError("idempotency_conflict", "The idempotency key was already used with a different message");
      result = { created: false, message: messageView(replay, false) };
      return false;
    }
    if (caller.thread.status !== "active") throw new CoordinationError("thread_inactive", "Messages require an active thread");
    const recipientKey = participantKey(normalized.recipient);
    if (recipientKey === caller.scopeKey) throw new CoordinationError("invalid_target", "A task cannot message its own mailbox");
    if (normalized.recipient.type === "task" && !taskVisibility(state, caller).messageable.has(normalized.recipient.taskId)) throw notVisible();
    if (normalized.inReplyToMessageId !== undefined) {
      const original = state.taskMessages.find((message) => message.id === normalized.inReplyToMessageId && message.threadId === caller.thread.id);
      if (!original || (participantKey(original.sender) !== caller.scopeKey && participantKey(original.recipient) !== caller.scopeKey)) throw messageNotVisible();
    }
    assertVisibleArtifacts(state, caller.thread.id, normalized.artifactIds);
    const threadMessages = state.taskMessages.filter((message) => message.threadId === caller.thread.id);
    if (threadMessages.length >= limits.messagesPerThread
      || threadMessages.filter((message) => participantKey(message.sender) === caller.scopeKey).length >= limits.messagesPerSender) {
      throw new CoordinationError("mailbox_full", "The thread's message limit has been reached");
    }
    const sequence = 1 + threadMessages
      .filter((message) => participantKey(message.recipient) === recipientKey)
      .reduce((latest, message) => Math.max(latest, message.sequence), 0);
    const message: TaskMessage = {
      id: newId("taskmsg"),
      threadId: caller.thread.id,
      sender: { ...caller.participant },
      recipient: normalized.recipient,
      sequence,
      kind: normalized.kind,
      body: normalized.body,
      ...(normalized.correlationId !== undefined ? { correlationId: normalized.correlationId } : {}),
      ...(normalized.inReplyToMessageId !== undefined ? { inReplyToMessageId: normalized.inReplyToMessageId } : {}),
      artifactIds: normalized.artifactIds,
      sourceRunId: caller.run.id,
      idempotencyKey: normalized.idempotencyKey,
      createdAt: at
    };
    state.taskMessages.push(message);
    caller.thread.updatedAt = at;
    result = { created: true, message: messageView(message, false) };
  });
  if (!result) throw new CoordinationError("persistence_failed", "The message was not sent", true);
  return result;
}

/**
 * Records acknowledgements of messages in the caller's own mailbox. Messages never change; each
 * acknowledgement is a separate record and acknowledging twice is a no-op. Returns how many
 * acknowledgements were new.
 */
export function acknowledgeMessages(state: State, caller: Caller, messageIds: readonly string[], at: string) {
  if (!caller.participant && messageIds.length) throw messageNotVisible();
  const acknowledged = acknowledgedIds(state, caller.thread.id);
  const pending: TaskMessage[] = [];
  for (const messageId of messageIds) {
    const message = state.taskMessages?.find((item) => item.id === messageId && item.threadId === caller.thread.id);
    if (!message || participantKey(message.recipient) !== caller.scopeKey) throw messageNotVisible();
    if (!acknowledged.has(message.id) && !pending.includes(message)) pending.push(message);
  }
  state.taskMessageAcknowledgements ??= [];
  for (const message of pending) {
    state.taskMessageAcknowledgements.push({ messageId: message.id, threadId: message.threadId, recipient: { ...message.recipient }, runId: caller.run.id, acknowledgedAt: at });
  }
  return pending.length;
}

interface NormalizedWait {
  cursor?: string;
  timeoutMilliseconds: number;
  maximumEvents: number;
  acknowledgeMessageIds: string[];
}

function boundedInteger(value: unknown, context: string, minimum: number, maximum: number, fallback: number) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalid(`${context} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

function normalizeWait(value: unknown): NormalizedWait {
  if (!isRecord(value)) throw invalid("Wait arguments must be an object");
  onlyKeys(value, ["cursor", "timeoutMilliseconds", "maximumEvents", "acknowledgeMessageIds"], "Wait arguments");
  if (value.cursor !== undefined && (typeof value.cursor !== "string" || !value.cursor)) throw invalid("cursor must be a cursor string");
  return {
    cursor: value.cursor as string | undefined,
    timeoutMilliseconds: boundedInteger(value.timeoutMilliseconds, "timeoutMilliseconds", 0, limits.maximumWaitMilliseconds, limits.defaultWaitMilliseconds),
    maximumEvents: boundedInteger(value.maximumEvents, "maximumEvents", 1, limits.maximumEventsPerWait, limits.maximumEventsPerWait),
    acknowledgeMessageIds: identifierList(value.acknowledgeMessageIds, "acknowledgeMessageIds", limits.acknowledgementsPerCall)
  };
}

export interface TaskEventWaitResult extends TaskEventPage {
  timedOut: boolean;
}

interface ActiveWait {
  finish(): void;
}

/**
 * Long-poll waits for task events. A wait observes only committed state, holds no transaction or
 * socket while pending, and always ends: when a relevant event commits, at its bounded timeout,
 * when its signal aborts, or when a newer wait from the same run displaces it. Ending a wait never
 * consumes events; only the cursor a caller passes decides what it sees next.
 */
export class TaskEventWaiters {
  private readonly active = new Map<string, ActiveWait[]>();

  constructor(private readonly store: Store) {}

  /** Pending waits, for diagnostics and tests. */
  get size() {
    let total = 0;
    for (const waits of this.active.values()) total += waits.length;
    return total;
  }

  async wait(sourceRunId: string, argumentsValue: unknown, signal?: AbortSignal): Promise<TaskEventWaitResult> {
    const request = normalizeWait(argumentsValue);
    const evaluate = (state: Readonly<State>) => {
      const caller = resolveCaller(state, sourceRunId);
      const after = request.cursor === undefined ? taskEventStream(state, caller.thread.id).floor : decodeTaskEventCursor(state, caller, request.cursor);
      return { page: collectTaskEvents(state, caller, after, request.maximumEvents), threadId: caller.thread.id };
    };
    if (request.acknowledgeMessageIds.length) {
      this.store.read(evaluate);
      await this.store.transact((state) => {
        const caller = resolveCaller(state, sourceRunId);
        if (caller.thread.status === "archived") throw new CoordinationError("thread_inactive", "Archived threads are read-only");
        return acknowledgeMessages(state, caller, request.acknowledgeMessageIds, new Date().toISOString()) > 0;
      });
    }
    const first = this.store.read(evaluate);
    if (first.page.events.length || request.timeoutMilliseconds === 0 || signal?.aborted) {
      return { ...first.page, timedOut: first.page.events.length === 0 };
    }
    return new Promise<TaskEventWaitResult>((resolve, reject) => {
      let latest = first.page;
      let observedHead = this.store.read((state) => taskEventStream(state, first.threadId).head);
      let settled = false;
      const entry: ActiveWait = { finish: () => settle(() => resolve({ ...latest, timedOut: true })) };
      const settle = (complete: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener("abort", entry.finish);
        const waits = (this.active.get(sourceRunId) ?? []).filter((item) => item !== entry);
        if (waits.length) this.active.set(sourceRunId, waits); else this.active.delete(sourceRunId);
        complete();
      };
      const unsubscribe = this.store.onCommit((state) => {
        const head = taskEventStream(state, first.threadId).head;
        const running = state.runs.some((run) => run.id === sourceRunId && run.status === "running");
        if (head === observedHead && running) return;
        observedHead = head;
        try {
          latest = evaluate(state).page;
          if (latest.events.length) settle(() => resolve({ ...latest, timedOut: false }));
        } catch (error) {
          settle(() => reject(error));
        }
      });
      const timer = setTimeout(entry.finish, request.timeoutMilliseconds);
      signal?.addEventListener("abort", entry.finish, { once: true });
      const waits = [...(this.active.get(sourceRunId) ?? []), entry];
      this.active.set(sourceRunId, waits);
      if (waits.length > limits.concurrentWaitsPerRun) waits[0].finish();
    });
  }

  /** Ends every pending wait as a timeout. */
  cancelAll() {
    for (const waits of [...this.active.values()]) for (const wait of [...waits]) wait.finish();
  }
}
