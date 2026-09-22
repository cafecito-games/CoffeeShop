import { createHash } from "node:crypto";
import type {
  ApprovalRequest,
  BoundedText,
  HarnessEvent,
  HarnessEventStreamStatus,
  Run,
  RunActivity
} from "@coffee-shop/protocol";
import { applyHarnessResolution, cancelPendingApprovals, openApproval, settleApprovalsForTerminalRun } from "./approvals.js";
import type { Redactor } from "./redaction.js";
import { settleSessionBindingsForTerminalRun } from "./sessionBindings.js";
import { newEvent, type State } from "./store.js";

/*
 * Structured harness events.
 *
 * This module owns event ordering, deduplication, storage limits, and the run activity projection.
 * Events are accepted per run in strict `sequence` order starting at 1. An exact replay of an
 * accepted sequence is harmless; a conflicting replay, a replay too old to verify, or a gap stops
 * the stream, flags the run's activity, and cancels its pending approvals. Accepted events are
 * redacted, retained within per-run bounds, and projected in the same transaction, so the
 * projection is always consistent with the accepted stream.
 */
export const harnessEventStorageLimits = {
  /** Raw events retained per run; later events are still projected. */
  retainedEventsPerRun: 1000,
  retainedBytesPerRun: 1024 * 1024,
  /** Runs whose raw events are retained; older terminal runs keep only their projection. */
  retainedEventRuns: 20,
  /** Runs whose projection is retained; older terminal runs lose it entirely. */
  retainedActivityRuns: 100,
  /** Accepted sequences whose digests are kept to tell exact replays from conflicts. */
  digestWindow: 256,
  messageBytes: 256 * 1024,
  thoughtBytes: 64 * 1024,
  summaryBytes: 2 * 1024,
  planEntryBytes: 2 * 1024,
  toolCalls: 500,
  toolDetailBytes: 8 * 1024,
  diffs: 100,
  diffTextBytes: 64 * 1024,
  diffBudgetBytes: 1024 * 1024,
  terminals: 16,
  terminalBytes: 64 * 1024,
  warnings: 50
} as const;

/** Appended to a single display field the hub shortened. */
export const truncationMarker = " [truncated]";

/** Hub-only stream state; never published in snapshots. */
export interface HarnessEventStream {
  runId: string;
  nodeId: string;
  sessionBindingId?: string;
  status: HarnessEventStreamStatus;
  lastSequence: number;
  failureReason?: string;
  recentDigests: Array<{ sequence: number; digest: string }>;
  retainedEvents: number;
  retainedBytes: number;
  retentionTruncated: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Hub-only retained event record, stored after redaction. */
export interface StoredHarnessEvent {
  runId: string;
  sequence: number;
  receivedAt: string;
  event: HarnessEvent;
}

export type HarnessEventOutcome =
  | { kind: "accepted"; deliveries: ApprovalRequest[] }
  | { kind: "duplicate" }
  | { kind: "rejected"; reason: string }
  | { kind: "stream-failed"; reason: string; deliveries: ApprovalRequest[] };

export interface HarnessEventSource {
  nodeId: string;
  receivedAt: string;
  redactor: Redactor;
}

const encoder = new TextEncoder();
const byteLength = (value: string) => encoder.encode(value).length;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const harnessEventDigest = (event: HarnessEvent) => createHash("sha256").update(canonicalJson(event)).digest("hex");

/** Keeps at most `limit` leading bytes without splitting a UTF-8 sequence. */
export function headBytes(value: string, limit: number) {
  const bytes = encoder.encode(value);
  if (bytes.length <= limit) return value;
  let cut = limit;
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut -= 1;
  return new TextDecoder().decode(bytes.subarray(0, cut));
}

/** Keeps at most `limit` trailing bytes without splitting a UTF-8 sequence. */
export function tailBytes(value: string, limit: number) {
  const bytes = encoder.encode(value);
  if (bytes.length <= limit) return value;
  let start = bytes.length - limit;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return new TextDecoder().decode(bytes.subarray(start));
}

function truncateField(value: string, limit: number) {
  if (byteLength(value) <= limit) return value;
  return headBytes(value, limit - byteLength(truncationMarker)) + truncationMarker;
}

function appendBounded(target: BoundedText, text: string, limit: number) {
  const combined = target.text + text;
  const kept = tailBytes(combined, limit);
  target.truncatedBytes += byteLength(combined) - byteLength(kept);
  target.text = kept;
}

const emptyText = (): BoundedText => ({ text: "", truncatedBytes: 0 });

function newActivity(run: Run, at: string): RunActivity {
  const activity: RunActivity = {
    runId: run.id, nodeId: run.nodeId, streamStatus: "open", lastSequence: 0, acceptedEvents: 0,
    message: emptyText(), thought: emptyText(), plan: [], toolCalls: [], diffs: [], terminals: [], warnings: [],
    unknownEvents: 0, omitted: { toolCalls: 0, diffs: 0, terminals: 0, warnings: 0 }, summary: "", updatedAt: at
  };
  if (run.threadId) activity.threadId = run.threadId;
  return activity;
}

function redactEvent(event: HarnessEvent, redactor: Redactor): HarnessEvent | string {
  const identities = [event.runId];
  if ("toolCallId" in event && event.toolCallId) identities.push(event.toolCallId);
  if ("approvalId" in event) identities.push(event.approvalId);
  if ("selectedOptionId" in event && event.selectedOptionId) identities.push(event.selectedOptionId);
  if (event.type === "terminal.output") identities.push(event.terminalId);
  if (event.type === "warning") identities.push(event.code);
  if (event.type === "unknown") identities.push(event.sourceType);
  if (event.type === "permission.requested") identities.push(...event.options.map((option) => option.id));
  if (identities.some((identity) => redactor.containsSecret(identity))) return `${event.type} identity contains a secret-like value`;

  const text = (value: string) => redactor.redact(value);
  const optional = (value: string | undefined) => value === undefined ? undefined : text(value);
  const redacted = structuredClone(event) as HarnessEvent & Record<string, unknown>;
  switch (redacted.type) {
    case "message.delta":
    case "thought.delta":
    case "terminal.output":
      redacted.text = text(redacted.text);
      break;
    case "plan.updated":
      redacted.entries = redacted.entries.map((entry) => ({ ...entry, content: text(entry.content) }));
      break;
    case "tool.call":
      redacted.title = text(redacted.title);
      if (redacted.detail !== undefined) redacted.detail = optional(redacted.detail);
      break;
    case "diff":
      redacted.path = text(redacted.path);
      redacted.newText = text(redacted.newText);
      if (redacted.oldText !== undefined) redacted.oldText = optional(redacted.oldText);
      break;
    case "permission.requested":
      redacted.title = text(redacted.title);
      if (redacted.detail !== undefined) redacted.detail = optional(redacted.detail);
      redacted.options = redacted.options.map((option) => ({ ...option, label: text(option.label) }));
      break;
    case "warning":
      redacted.message = text(redacted.message);
      break;
    case "unknown":
      if (redacted.detail !== undefined) redacted.detail = optional(redacted.detail);
      break;
    case "usage":
    case "permission.resolved":
      break;
  }
  return redacted;
}

function project(activity: RunActivity, event: HarnessEvent) {
  const limits = harnessEventStorageLimits;
  switch (event.type) {
    case "message.delta":
      appendBounded(activity.message, event.text, limits.messageBytes);
      activity.summary = tailBytes(activity.message.text, limits.summaryBytes).trim();
      break;
    case "thought.delta":
      appendBounded(activity.thought, event.text, limits.thoughtBytes);
      break;
    case "plan.updated":
      activity.plan = event.entries.map((entry) => ({ ...entry, content: truncateField(entry.content, limits.planEntryBytes) }));
      break;
    case "tool.call": {
      const existing = activity.toolCalls.find((call) => call.toolCallId === event.toolCallId);
      if (!existing && activity.toolCalls.length >= limits.toolCalls) {
        activity.omitted.toolCalls += 1;
        break;
      }
      const call = existing ?? { toolCallId: event.toolCallId, status: event.status, kind: event.kind, title: event.title, updatedAt: event.at };
      call.status = event.status;
      call.kind = event.kind;
      call.title = event.title;
      call.updatedAt = event.at;
      if (event.detail !== undefined) call.detail = truncateField(event.detail, limits.toolDetailBytes);
      if (!existing) activity.toolCalls.push(call);
      break;
    }
    case "diff": {
      const index = activity.diffs.findIndex((diff) => diff.path === event.path && diff.toolCallId === event.toolCallId);
      if (index < 0 && activity.diffs.length >= limits.diffs) {
        activity.omitted.diffs += 1;
        break;
      }
      const diffBytes = (diff: { oldText?: string; newText: string }) => byteLength(diff.newText) + byteLength(diff.oldText ?? "");
      const used = activity.diffs.reduce((total, diff, position) => position === index ? total : total + diffBytes(diff), 0);
      let newText = headBytes(event.newText, limits.diffTextBytes);
      let oldText = event.oldText === undefined ? undefined : headBytes(event.oldText, limits.diffTextBytes);
      let truncated = newText !== event.newText || oldText !== event.oldText;
      if (used + diffBytes({ newText, oldText }) > limits.diffBudgetBytes) {
        newText = "";
        oldText = undefined;
        truncated = true;
      }
      const diff = { path: event.path, newText, truncated, sequence: event.sequence, at: event.at } as RunActivity["diffs"][number];
      if (event.toolCallId !== undefined) diff.toolCallId = event.toolCallId;
      if (oldText !== undefined) diff.oldText = oldText;
      if (index >= 0) activity.diffs[index] = diff; else activity.diffs.push(diff);
      break;
    }
    case "terminal.output": {
      let terminal = activity.terminals.find((item) => item.terminalId === event.terminalId);
      if (!terminal) {
        if (activity.terminals.length >= limits.terminals) {
          activity.omitted.terminals += 1;
          break;
        }
        terminal = { terminalId: event.terminalId, stdout: emptyText(), stderr: emptyText(), updatedAt: event.at };
        activity.terminals.push(terminal);
      }
      appendBounded(event.stream === "stdout" ? terminal.stdout : terminal.stderr, event.text, limits.terminalBytes);
      terminal.updatedAt = event.at;
      break;
    }
    case "usage": {
      const usage = activity.usage ?? { updatedAt: event.at };
      if (event.inputTokens !== undefined) usage.inputTokens = event.inputTokens;
      if (event.outputTokens !== undefined) usage.outputTokens = event.outputTokens;
      if (event.cachedInputTokens !== undefined) usage.cachedInputTokens = event.cachedInputTokens;
      if (event.costUsd !== undefined) usage.costUsd = event.costUsd;
      usage.updatedAt = event.at;
      activity.usage = usage;
      break;
    }
    case "warning":
      activity.warnings.push({ code: event.code, message: event.message, sequence: event.sequence, at: event.at });
      if (activity.warnings.length > limits.warnings) {
        activity.omitted.warnings += activity.warnings.length - limits.warnings;
        activity.warnings = activity.warnings.slice(-limits.warnings);
      }
      break;
    case "unknown":
      activity.unknownEvents += 1;
      break;
    case "permission.requested":
    case "permission.resolved":
      break;
  }
}

function streamFor(state: State, runId: string) {
  return (state.harnessEventStreams ?? []).find((stream) => stream.runId === runId);
}

function activityFor(state: State, runId: string) {
  return (state.runActivity ?? []).find((activity) => activity.runId === runId);
}

function failStream(state: State, run: Run, stream: HarnessEventStream, activity: RunActivity, reason: string, at: string): HarnessEventOutcome {
  stream.status = "failed";
  stream.failureReason = reason;
  stream.updatedAt = at;
  activity.streamStatus = "failed";
  activity.streamFailure = reason;
  activity.updatedAt = at;
  state.events.unshift(newEvent({ type: "status", title: "Harness event stream stopped", detail: reason, threadId: run.threadId, agentId: run.agentId, runId: run.id }));
  return { kind: "stream-failed", reason, deliveries: cancelPendingApprovals(state, run.id, at) };
}

/** Drops retained history of the oldest terminal runs beyond the configured run counts. */
function pruneHistory(state: State) {
  const runs = new Map(state.runs.map((run) => [run.id, run]));
  const isFinished = (runId: string) => {
    const run = runs.get(runId);
    return !run || (run.status !== "running" && run.status !== "queued");
  };
  const streams = state.harnessEventStreams ?? [];
  const withEvents = streams.filter((stream) => stream.retainedEvents > 0);
  const excessEventRuns = new Set(withEvents
    .slice(0, Math.max(0, withEvents.length - harnessEventStorageLimits.retainedEventRuns))
    .filter((stream) => isFinished(stream.runId))
    .map((stream) => stream.runId));
  if (excessEventRuns.size) {
    state.harnessEvents = (state.harnessEvents ?? []).filter((record) => !excessEventRuns.has(record.runId));
    for (const stream of streams) {
      if (!excessEventRuns.has(stream.runId)) continue;
      stream.retainedEvents = 0;
      stream.retainedBytes = 0;
      stream.retentionTruncated = true;
    }
  }
  const activity = state.runActivity ?? [];
  const excessActivityRuns = new Set(activity
    .slice(0, Math.max(0, activity.length - harnessEventStorageLimits.retainedActivityRuns))
    .filter((item) => isFinished(item.runId))
    .map((item) => item.runId));
  if (excessActivityRuns.size) {
    state.runActivity = activity.filter((item) => !excessActivityRuns.has(item.runId));
    state.harnessEventStreams = streams.filter((stream) => !excessActivityRuns.has(stream.runId));
    state.harnessEvents = (state.harnessEvents ?? []).filter((record) => !excessActivityRuns.has(record.runId));
  }
}

/**
 * Validated events only: callers must pass the output of `validateOrchestrationControlAgentMessage`.
 * A `rejected` or `duplicate` outcome leaves state untouched and must not be persisted.
 */
export function acceptHarnessEvent(state: State, source: HarnessEventSource, event: HarnessEvent): HarnessEventOutcome {
  const run = state.runs.find((item) => item.id === event.runId);
  // The run identity is untrusted until it matches a hub run, so it never appears in a diagnostic.
  if (!run) return { kind: "rejected", reason: "harness event names an unknown run" };
  if (run.nodeId !== source.nodeId) return { kind: "rejected", reason: `run ${run.id} is not assigned to node ${source.nodeId}` };
  if (run.status !== "running") return { kind: "rejected", reason: `run ${run.id} is ${run.status}; its events are no longer accepted` };

  state.harnessEventStreams ??= [];
  state.runActivity ??= [];
  state.harnessEvents ??= [];
  let stream = streamFor(state, run.id);
  let activity = activityFor(state, run.id);
  if (!stream) {
    stream = {
      runId: run.id, nodeId: run.nodeId, status: "open", lastSequence: 0, recentDigests: [], retainedEvents: 0, retainedBytes: 0,
      retentionTruncated: false, createdAt: source.receivedAt, updatedAt: source.receivedAt
    };
    if (run.sessionBindingId) stream.sessionBindingId = run.sessionBindingId;
    state.harnessEventStreams.push(stream);
  }
  if (!activity) {
    activity = newActivity(run, source.receivedAt);
    state.runActivity.push(activity);
  }
  if (stream.nodeId !== source.nodeId || stream.sessionBindingId !== run.sessionBindingId) {
    return { kind: "rejected", reason: `harness event for run ${run.id} does not match its session` };
  }
  if (stream.status !== "open") return { kind: "rejected", reason: `harness event stream for run ${run.id} is ${stream.status}` };

  const digest = harnessEventDigest(event);
  if (event.sequence <= stream.lastSequence) {
    const accepted = stream.recentDigests.find((entry) => entry.sequence === event.sequence);
    if (accepted?.digest === digest) return { kind: "duplicate" };
    return failStream(state, run, stream, activity, accepted
      ? `sequence ${event.sequence} was replayed with a conflicting payload`
      : `sequence ${event.sequence} was replayed but is too old to verify`, source.receivedAt);
  }
  if (event.sequence !== stream.lastSequence + 1) {
    return failStream(state, run, stream, activity, `expected sequence ${stream.lastSequence + 1} but received ${event.sequence}`, source.receivedAt);
  }

  const redacted = redactEvent(event, source.redactor);
  if (typeof redacted === "string") return failStream(state, run, stream, activity, redacted, source.receivedAt);

  let conflict: string | undefined;
  if (redacted.type === "permission.requested") conflict = openApproval(state, run, redacted, source.receivedAt);
  if (redacted.type === "permission.resolved") conflict = applyHarnessResolution(state, run, redacted, source.receivedAt);
  if (conflict) return failStream(state, run, stream, activity, conflict, source.receivedAt);

  project(activity, redacted);
  stream.lastSequence = event.sequence;
  stream.updatedAt = source.receivedAt;
  stream.recentDigests.push({ sequence: event.sequence, digest });
  if (stream.recentDigests.length > harnessEventStorageLimits.digestWindow) stream.recentDigests.shift();
  const size = byteLength(JSON.stringify(redacted));
  if (!stream.retentionTruncated
    && stream.retainedEvents < harnessEventStorageLimits.retainedEventsPerRun
    && stream.retainedBytes + size <= harnessEventStorageLimits.retainedBytesPerRun) {
    state.harnessEvents.push({ runId: run.id, sequence: event.sequence, receivedAt: source.receivedAt, event: redacted });
    stream.retainedEvents += 1;
    stream.retainedBytes += size;
  } else {
    stream.retentionTruncated = true;
  }
  activity.lastSequence = event.sequence;
  activity.acceptedEvents += 1;
  activity.updatedAt = source.receivedAt;
  if (stream.lastSequence === 1) pruneHistory(state);
  return { kind: "accepted", deliveries: [] };
}

/** Closes a run's stream and settles its approvals and session bindings once the run reaches a terminal state. */
export function settleHarnessStateForTerminalRun(state: State, runId: string, at: string) {
  const stream = streamFor(state, runId);
  if (stream) {
    if (stream.status === "open") stream.status = "closed";
    stream.recentDigests = [];
    stream.updatedAt = at;
  }
  const activity = activityFor(state, runId);
  if (activity) {
    if (activity.streamStatus === "open") activity.streamStatus = "closed";
    activity.updatedAt = at;
  }
  settleApprovalsForTerminalRun(state, runId, at);
  settleSessionBindingsForTerminalRun(state, runId, at);
}

/** Retained, redacted events for a run after `afterSequence`, in sequence order. */
export function retainedHarnessEvents(state: Readonly<State>, runId: string, afterSequence = 0, limit = 200) {
  return (state.harnessEvents ?? [])
    .filter((record) => record.runId === runId && record.sequence > afterSequence)
    .sort((left, right) => left.sequence - right.sequence)
    .slice(0, limit);
}
