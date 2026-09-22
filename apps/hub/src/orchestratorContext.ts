import { orchestratorContinuationLimits as limits, type Task, type TaskMessage, type Thread } from "@coffee-shop/protocol";
import { headBytes } from "./harnessEvents.js";
import { encodeTaskEventCursor } from "./mailbox.js";
import type { State } from "./store.js";
import { participantKey, taskEventStream, type TaskEventEntry } from "./taskEvents.js";

/*
 * Continuation prompts.
 *
 * The single source of the text an orchestrator continuation receives, shared by resumed ACP
 * sessions, replacement ACP sessions, and native CLI runs. Rendering is deterministic: it depends
 * only on committed hub state and the wake range, never on time or randomness. Every bound is in
 * UTF-8 bytes; a field that is shortened says so, and every event in the range is listed by
 * sequence and identity even when its content no longer fits.
 */

export interface ContinuationRange {
  wakeId: string;
  generation: number;
  /** Exclusive lower bound: the last sequence the orchestrator acknowledged. */
  fromSequence: number;
  /** Inclusive upper bound; the acknowledgement cursor resumes after it. */
  throughSequence: number;
  /** The relevant journal entries in the range, in sequence order. */
  events: readonly TaskEventEntry[];
  /** Whether every event had already reached an earlier orchestrator session. */
  redelivery: boolean;
}

export interface ContinuationPrompts {
  /** Delivery only, for a session that resumed with its own history. */
  resumePrompt: string;
  /** Bounded durable context followed by the delivery, for any session without that history. */
  prompt: string;
}

const encoder = new TextEncoder();
const byteLength = (value: string) => encoder.encode(value).length;
const singleLine = (value: string) => value.replace(/\s+/g, " ").trim();

/** Shortens `value` to `limit` bytes, stating how much was kept; never splits a UTF-8 sequence. */
export function boundedField(value: string, limit: number) {
  const total = byteLength(value);
  if (total <= limit) return value;
  const marker = (kept: number) => ` [truncated: ${kept} of ${total} bytes shown]`;
  const kept = headBytes(value, Math.max(0, limit - byteLength(marker(limit))));
  return kept + marker(byteLength(kept));
}

const quoted = (value: string) => JSON.stringify(boundedField(singleLine(value), limits.contextFieldBytes));

function taskLine(task: Task) {
  const parts = [`- ${task.id} ${quoted(task.title)} · ${task.status}`];
  if (task.progress?.blockedReason) parts.push(`blocked: ${quoted(task.progress.blockedReason)}`);
  if (task.result) parts.push(`result: ${quoted(task.result)}`);
  if (task.error) parts.push(`error: ${quoted(task.error)}`);
  return parts.join(" · ");
}

/** Deterministic, bounded summary of the thread's authoritative state for a session without history. */
export function durableThreadContext(state: Readonly<State>, thread: Thread) {
  const lines = [
    "[Coffee Shop durable thread context]",
    "This session has no earlier conversation history. The Coffee Shop hub state below is authoritative; provider history is not.",
    `Thread ${thread.id}: ${quoted(thread.title)} (${thread.status})`,
    `Objective: ${quoted(thread.objective)}`
  ];
  if (thread.summary.trim()) lines.push(`Summary: ${quoted(thread.summary)}`);
  const tasks = (state.tasks ?? [])
    .filter((task) => task.threadId === thread.id)
    .sort((left, right) => (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const shown = tasks.slice(-limits.contextTasks);
  lines.push(`Tasks (${shown.length} most recent of ${tasks.length}, oldest first):`);
  let used = byteLength(lines.join("\n"));
  let rendered = 0;
  for (const task of shown) {
    const line = taskLine(task);
    if (used + byteLength(line) + 1 > limits.contextBytes - 512) break;
    lines.push(line);
    used += byteLength(line) + 1;
    rendered += 1;
  }
  if (rendered < shown.length) lines.push(`- ${shown.length - rendered} more tasks did not fit in this context.`);
  const artifacts = (state.artifacts ?? []).filter((artifact) => artifact.threadId === thread.id && artifact.uploaded);
  if (artifacts.length) {
    const listed = artifacts.slice(-limits.contextArtifacts);
    lines.push(`Artifacts (${listed.length} most recent of ${artifacts.length}): ${listed.map((artifact) => `${artifact.id} ${quoted(artifact.title)}`).join(", ")}`);
  }
  lines.push("Call get_task_context for the complete, current task graph and unacknowledged messages.");
  return headBytes(lines.join("\n"), limits.contextBytes);
}

function describeMessage(message: TaskMessage | undefined, messageId: string) {
  if (!message) return { header: `message ${messageId} (no longer retained)`, body: "" };
  const sender = message.sender.type === "task" ? `task ${message.sender.taskId}` : message.sender.type;
  const header = [`message ${message.id} from ${sender}`, message.kind];
  if (message.correlationId) header.push(`correlation ${quoted(message.correlationId)}`);
  if (message.inReplyToMessageId) header.push(`in reply to ${message.inReplyToMessageId}`);
  if (message.artifactIds?.length) header.push(`artifacts ${message.artifactIds.join(", ")}`);
  return { header: header.join(" · "), body: boundedField(message.body, limits.eventBodyBytes) };
}

function describeTask(state: Readonly<State>, entry: Extract<TaskEventEntry, { kind: "task" }>) {
  const task = state.tasks?.find((item) => item.id === entry.taskId);
  const header = [`task ${entry.taskId}${task ? ` ${quoted(task.title)}` : ""} is ${entry.status}`];
  if (entry.previousStatus !== undefined && entry.previousStatus !== entry.status) header.push(`was ${entry.previousStatus}`);
  if (entry.attemptRunId !== undefined) header.push(`attempt ${entry.attempt ?? "?"} (run ${entry.attemptRunId})`);
  const details: string[] = [];
  if (task?.progress?.blockedReason) details.push(`Blocked: ${task.progress.blockedReason}`);
  if (task?.result && entry.status === "completed") details.push(`Result: ${task.result}`);
  if (task?.error && entry.status !== "completed") details.push(`Error: ${task.error}`);
  return { header: header.join(" · "), body: boundedField(details.join("\n"), limits.eventBodyBytes) };
}

/** The delivery prompt for one wake range. */
export function continuationDelivery(state: Readonly<State>, thread: Thread, range: ContinuationRange) {
  const messages = new Map((state.taskMessages ?? []).filter((message) => message.threadId === thread.id).map((message) => [message.id, message]));
  const floor = taskEventStream(state, thread.id).floor;
  const header = [
    "[Coffee Shop orchestrator continuation]",
    `Thread ${thread.id}: ${quoted(thread.title)}`,
    `Wake ${range.wakeId}, generation ${range.generation}.`,
    `Inbox range: journal sequences after ${range.fromSequence} through ${range.throughSequence}; ${range.events.length === 1 ? "1 event needs" : `${range.events.length} events need`} your attention.`
  ];
  if (range.redelivery) header.push("Every event below was already delivered to an earlier session that did not acknowledge it. Check current state before acting again.");
  if (range.fromSequence < floor) header.push(`Sequences after ${range.fromSequence} through ${floor} were pruned before you acknowledged them; call get_task_context for current task state and unacknowledged messages.`);
  const acknowledged = range.events.flatMap((entry) => (entry.kind === "message" && messages.has(entry.messageId) ? [entry.messageId] : []));
  const cursor = encodeTaskEventCursor(thread.id, participantKey({ type: "orchestrator" }), range.throughSequence);
  const footer = [
    "",
    `When you have acted on these events, acknowledge them by calling wait_for_task_events with ${JSON.stringify({ cursor, timeoutMilliseconds: 0, acknowledgeMessageIds: acknowledged })}.`,
    `Events after sequence ${range.throughSequence} are not part of this delivery; read them by continuing to call wait_for_task_events with the cursor each call returns.`,
    "Acting on an event twice must be harmless: reuse the same idempotency keys for any task submissions or messages you send in response."
  ].join("\n");
  const budget = limits.deliveryBytes - byteLength(header.join("\n")) - byteLength(footer) - 64;
  const lines = ["", "Events:"];
  let used = 0;
  for (const entry of range.events) {
    const described = entry.kind === "message" ? describeMessage(messages.get(entry.messageId), entry.messageId) : describeTask(state, entry);
    const compact = `- sequence ${entry.sequence} · ${described.header}`;
    const full = described.body ? `${compact}\n  ${described.body.replace(/\n/g, "\n  ")}` : compact;
    const remaining = range.events.length - lines.length + 2;
    const reserve = remaining * 160;
    const line = used + byteLength(full) + reserve <= budget ? full : headBytes(compact, 160);
    lines.push(line);
    used += byteLength(line) + 1;
  }
  return [...header, ...lines, footer].join("\n");
}

/** Both prompts for a wake: the delivery alone, and the delivery preceded by durable context. */
export function continuationPrompts(state: Readonly<State>, thread: Thread, range: ContinuationRange): ContinuationPrompts {
  const delivery = continuationDelivery(state, thread, range);
  return { resumePrompt: delivery, prompt: `${durableThreadContext(state, thread)}\n\n${delivery}` };
}
