import { createHash } from "node:crypto";
import {
  isTaskMessageKind,
  orchestrationToolLimits as limits,
  orchestratorClientSourceKey,
  recordSourceKey,
  runSourceKey,
  type Agent,
  type OrchestratorAttachment,
  type OrchestratorClient,
  type AgentInstance,
  type InstanceAllocation,
  type Run,
  type RuntimeActor,
  type Task,
  type TaskMailboxEvent,
  type TaskMessage,
  type TaskMessageKind,
  type TaskMessageParticipant,
  type TaskMessageView,
  type Thread
} from "@coffee-shop/protocol";
import {
  authorizeInstance,
  isThreadOrchestratorActor,
  recordActor,
  type InstancePrincipal
} from "./actors.js";
import { CoordinationError } from "./coordinationError.js";
import { newId, publicOrchestratorClient, type State, type Store } from "./store.js";
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

/**
 * What a hub-hosted run executes as. A version-5 run executes as a live resident instance of its own
 * thread, named together with the exact allocation it was dispatched against. A legacy run executes
 * as a configured agent. Both are runtime principals; neither is derived from the other, and a
 * historical record's display attribution never produces one (see `describeHistoricalActor`).
 */
export type RunRuntime =
  | { runtime: "instance"; instance: AgentInstance; allocation: InstanceAllocation }
  | { runtime: "agent"; agent: Agent };

/**
 * Who is calling. A hub-hosted caller is a running run executing as an instance or as a legacy
 * configured agent; an external caller is a bridge connection holding a live attachment on the
 * thread. Everything a handler needs that is specific to one of them is reached through the helpers
 * below, never by assuming a `Run`.
 */
export type CallerPrincipal =
  | ({ kind: "run"; run: Run; actor: RuntimeActor } & RunRuntime)
  | { kind: "external"; client: OrchestratorClient; attachment: OrchestratorAttachment };

export interface Caller {
  principal: CallerPrincipal;
  thread: Thread;
  /** The task this run is an attempt of; an external orchestrator is never a task attempt. */
  task?: Task;
  /** Mailbox identity; absent for a run that is neither a task attempt nor a thread-owner run. */
  participant?: TaskMessageParticipant;
  /** The scope event cursors are bound to. */
  scopeKey: string;
  /** The stable lineage and idempotency identity of this caller; see `runSourceKey`. */
  sourceKey: string;
}

/** What names a caller to `resolveCallerFor`; a tool's arguments never widen either of them. */
export type CallerSource =
  | { kind: "run"; runId: string }
  | { kind: "external"; connectionId: string; threadId: string };

export const runSource = (runId: string): CallerSource => ({ kind: "run", runId });
export const externalSource = (connectionId: string, threadId: string): CallerSource => ({ kind: "external", connectionId, threadId });

/** The calling run, or `undefined` for an external orchestrator. */
export const callerRun = (caller: Caller) => (caller.principal.kind === "run" ? caller.principal.run : undefined);
/**
 * The legacy configured agent the calling run executes as. `undefined` for an external orchestrator
 * and for an instance run: it is a compatibility identity, never the answer to "may this caller
 * write".
 */
export const callerAgent = (caller: Caller): Agent | undefined =>
  caller.principal.kind === "run" && caller.principal.runtime === "agent" ? caller.principal.agent : undefined;
/** The live resident instance the calling run executes as, with its exact allocation. */
export const callerInstance = (caller: Caller): InstancePrincipal | undefined =>
  caller.principal.kind === "run" && caller.principal.runtime === "instance"
    ? { instance: caller.principal.instance, allocation: caller.principal.allocation }
    : undefined;
/** The caller's runtime actor, for attributing the records it writes. */
export const callerActor = (caller: Caller): RuntimeActor | undefined =>
  caller.principal.kind === "run" ? caller.principal.actor : undefined;
/** The actor keys a record written by this caller carries; empty for an external orchestrator. */
export const callerAttribution = (caller: Caller): { agentId?: string; instanceId?: string; allocationId?: string } => {
  const actor = callerActor(caller);
  if (actor === undefined) return {};
  return actor.kind === "agent" ? { agentId: actor.agentId } : { instanceId: actor.instanceId, allocationId: actor.allocationId };
};

/** A run for a tool that can only be served to a hub-hosted caller. */
export function requireCallerRun(caller: Caller, message: string) {
  if (caller.principal.kind !== "run") throw new CoordinationError("forbidden", message);
  return { run: caller.principal.run, actor: caller.principal.actor };
}

/**
 * Whether the caller may submit work and inspect the execution inventory. An instance run carries the
 * hub-granted `delegation.canDelegate` of its own record — a model can never self-elevate it. A legacy
 * run needs its agent's `canDelegate`. An external orchestrator that reached a handler at all holds
 * the `orchestrate` scope, which is the same authority for its own thread.
 */
export const callerCanDelegate = (caller: Caller) => {
  if (caller.principal.kind !== "run") return true;
  return caller.principal.runtime === "instance"
    ? caller.principal.instance.delegation.canDelegate
    : caller.principal.agent.canDelegate === true;
};

export const notVisible = () => new CoordinationError("not_found", "Task not found in the current task lineage");
const messageNotVisible = () => new CoordinationError("not_found", "Message not found in the current mailbox");
const invalid = (message: string) => new CoordinationError("invalid_arguments", message);

/**
 * The single answer for every thread an external call may not act on: one this connection never
 * attached, one whose attachment was replaced or detached, one belonging to another credential, and
 * one that does not exist. They are indistinguishable so that a caller cannot probe for thread ids.
 */
export const notAttached = () => new CoordinationError("not_attached", "This connection holds no attachment on that thread");

/**
 * Resolves the external orchestrator behind a bridge connection. Authority comes from the committed
 * attachment and the credential's current scopes, never from the frame: a credential revoked or
 * narrowed since the welcome stops being able to act the moment the change commits.
 */
export function resolveExternalCaller(state: Readonly<State>, connectionId: string, threadId: string): Caller {
  const attachment = (state.orchestratorAttachments ?? [])
    .find((item) => item.threadId === threadId && item.connectionId === connectionId && item.status === "attached");
  if (!attachment) throw notAttached();
  const stored = (state.orchestratorClients ?? []).find((item) => item.id === attachment.clientId);
  if (!stored || stored.revokedAt !== undefined || !stored.scopes.includes("orchestrate")) throw notAttached();
  const thread = (state.threads ?? []).find((item) => item.id === attachment.threadId);
  if (!thread) throw notAttached();
  const participant: TaskMessageParticipant = { type: "orchestrator" };
  return {
    principal: { kind: "external", client: publicOrchestratorClient(stored), attachment },
    thread,
    participant,
    scopeKey: participantKey(participant),
    sourceKey: orchestratorClientSourceKey(stored.id)
  };
}

/** Resolves either principal; the authoritative check inside the transaction that commits a change. */
export const resolveCallerFor = (state: Readonly<State>, source: CallerSource): Caller =>
  source.kind === "run" ? resolveCaller(state, source.runId) : resolveExternalCaller(state, source.connectionId, source.threadId);

/**
 * The runtime principal of a running run. An instance run must still be a live resident of its own
 * thread with its exact allocation active: a released, drained, replaced, or foreign-thread instance
 * is not a principal and its run can authorize nothing. A malformed actor identity is rejected as
 * invalid by `recordActor` rather than falling through to the agent path.
 */
function runPrincipal(state: Readonly<State>, run: Run, threadId: string): Extract<CallerPrincipal, { kind: "run" }> {
  const actor = recordActor(run, `Run ${run.id}`);
  if (actor === undefined) throw new CoordinationError("forbidden", "The source run names no runtime actor");
  if (actor.kind === "instance") {
    const principal = authorizeInstance(state, run, `Run ${run.id}`, threadId);
    if (!principal) throw new CoordinationError("forbidden", "The source run's instance is no longer a live resident of this thread");
    return { kind: "run", run, actor, runtime: "instance", instance: principal.instance, allocation: principal.allocation };
  }
  const agent = state.agents.find((item) => item.id === actor.agentId);
  if (!agent) throw new CoordinationError("forbidden", "The source agent is not configured");
  return { kind: "run", run, actor, runtime: "agent", agent };
}

/** Resolves the authenticated caller of a hub tool; only a running run attached to a thread qualifies. */
export function resolveCaller(state: Readonly<State>, sourceRunId: string): Caller {
  const run = state.runs.find((item) => item.id === sourceRunId);
  if (!run || run.status !== "running") throw new CoordinationError("run_not_active", "The source task is not running");
  const thread = run.threadId ? state.threads?.find((item) => item.id === run.threadId) : undefined;
  if (!thread) throw new CoordinationError("not_found", "The source task is not attached to a thread");
  const principal = runPrincipal(state, run, thread.id);
  const sourceKey = runSourceKey(run.id);
  if (run.taskId !== undefined) {
    const task = state.tasks?.find((item) => item.id === run.taskId && item.threadId === thread.id && item.attemptRunIds.includes(run.id));
    if (!task) throw new CoordinationError("forbidden", "The source run's task is unavailable");
    const participant: TaskMessageParticipant = { type: "task", taskId: task.id };
    return { principal, thread, task, participant, scopeKey: participantKey(participant), sourceKey };
  }
  // Orchestrator authority is the thread's own record, resolved against the caller's runtime actor:
  // a replacement instance is not the orchestrator until the thread names it.
  if (isThreadOrchestratorActor(thread, principal.actor)) {
    const participant: TaskMessageParticipant = { type: "orchestrator" };
    return { principal, thread, participant, scopeKey: participantKey(participant), sourceKey };
  }
  return { principal, thread, scopeKey: sourceKey, sourceKey };
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
  const run = callerRun(caller);
  const ownKeys = new Set((caller.task ? caller.task.attemptRunIds : run ? [run.id] : []).map(runSourceKey));
  const descendants: Task[] = [];
  for (const task of graph.tasks.values()) {
    if (task.id === caller.task?.id) continue;
    const seen = new Set<string>();
    for (let current: Task | undefined = task; current && !seen.has(current.id); current = graph.parentOf(current)) {
      seen.add(current.id);
      const sourceKey = recordSourceKey(current);
      if (sourceKey !== undefined && ownKeys.has(sourceKey)) {
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

const sameMessage = (message: TaskMessage, normalized: NormalizedMessage, sourceKey: string) =>
  recordSourceKey(message) === sourceKey
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
    if (!artifact || !artifact.uploaded || artifact.threadId !== threadId
      || (ownRunIds && (artifact.runId === undefined || !ownRunIds.has(artifact.runId)))) {
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
export const sendTaskMessage = (store: Store, sourceRunId: string, argumentsValue: unknown, at = new Date().toISOString()) =>
  sendTaskMessageForSource(store, runSource(sourceRunId), argumentsValue, at);

/** `sendTaskMessage` for either principal; the sender is always the resolved caller, never an argument. */
export async function sendTaskMessageForSource(store: Store, source: CallerSource, argumentsValue: unknown, at = new Date().toISOString()): Promise<SentMessage> {
  const normalized = normalizeMessage(argumentsValue);
  let result: SentMessage | undefined;
  await store.transact((state) => {
    const caller = resolveCallerFor(state, source);
    if (!caller.participant) throw new CoordinationError("forbidden", "This run has no task mailbox");
    state.taskMessages ??= [];
    const replay = state.taskMessages.find((message) => message.threadId === caller.thread.id
      && participantKey(message.sender) === caller.scopeKey && message.idempotencyKey === normalized.idempotencyKey);
    if (replay) {
      if (!sameMessage(replay, normalized, caller.sourceKey)) throw new CoordinationError("idempotency_conflict", "The idempotency key was already used with a different message");
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
      ...(caller.principal.kind === "run" ? { sourceRunId: caller.principal.run.id } : { sourceKey: caller.sourceKey }),
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
  if (!pending.length) return 0;
  // An acknowledgement record names the run that made it; an external orchestrator acknowledges
  // through its event cursor instead, and never reaches this path.
  const { run } = requireCallerRun(caller, "Only a hub-hosted run can acknowledge messages individually");
  for (const message of pending) {
    state.taskMessageAcknowledgements.push({ messageId: message.id, threadId: message.threadId, recipient: { ...message.recipient }, runId: run.id, acknowledgedAt: at });
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
 * The concurrency and displacement key of a wait. A run is one waiter; an external orchestrator is
 * one waiter per connection and thread, so long-polling two threads at once is not self-displacing.
 */
const waitKeyOf = (source: CallerSource) =>
  source.kind === "run" ? runSourceKey(source.runId) : `orchestrator-connection:${source.connectionId}:${source.threadId}`;

/** Whether the principal a pending wait belongs to can still receive events. */
const principalStillLive = (state: Readonly<State>, source: CallerSource) => source.kind === "run"
  ? state.runs.some((run) => run.id === source.runId && run.status === "running")
  : (state.orchestratorAttachments ?? []).some((attachment) =>
    attachment.connectionId === source.connectionId && attachment.threadId === source.threadId && attachment.status === "attached");

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

  /**
   * `accepted`, when given, runs once every argument, the cursor, and any acknowledgements have
   * been validated and applied, before the wait blocks; a call that fails validation never reaches
   * it. It may return a promise to await, or undefined to continue without yielding.
   */
  async wait(source: string | CallerSource, argumentsValue: unknown, signal?: AbortSignal, accepted?: () => Promise<unknown> | undefined): Promise<TaskEventWaitResult> {
    const callerSource = typeof source === "string" ? runSource(source) : source;
    const waitKey = waitKeyOf(callerSource);
    const request = normalizeWait(argumentsValue);
    const evaluate = (state: Readonly<State>) => {
      const caller = resolveCallerFor(state, callerSource);
      const after = request.cursor === undefined ? taskEventStream(state, caller.thread.id).floor : decodeTaskEventCursor(state, caller, request.cursor);
      return { page: collectTaskEvents(state, caller, after, request.maximumEvents), threadId: caller.thread.id };
    };
    if (request.acknowledgeMessageIds.length) {
      this.store.read(evaluate);
      await this.store.transact((state) => {
        const caller = resolveCallerFor(state, callerSource);
        if (caller.thread.status === "archived") throw new CoordinationError("thread_inactive", "Archived threads are read-only");
        return acknowledgeMessages(state, caller, request.acknowledgeMessageIds, new Date().toISOString()) > 0;
      });
    }
    let first = this.store.read(evaluate);
    const acceptance = accepted?.();
    if (acceptance) {
      await acceptance;
      first = this.store.read(evaluate);
    }
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
        const waits = (this.active.get(waitKey) ?? []).filter((item) => item !== entry);
        if (waits.length) this.active.set(waitKey, waits); else this.active.delete(waitKey);
        complete();
      };
      const unsubscribe = this.store.onCommit((state) => {
        const head = taskEventStream(state, first.threadId).head;
        if (head === observedHead && principalStillLive(state, callerSource)) return;
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
      const waits = [...(this.active.get(waitKey) ?? []), entry];
      this.active.set(waitKey, waits);
      if (waits.length > limits.concurrentWaitsPerRun) waits[0].finish();
    });
  }

  /** Ends every pending wait as a timeout. */
  cancelAll() {
    for (const waits of [...this.active.values()]) for (const wait of [...waits]) wait.finish();
  }
}
