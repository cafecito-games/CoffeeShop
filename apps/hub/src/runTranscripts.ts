import type { HarnessEvent, Run, RunTranscript, RunTranscriptEntry } from "@coffee-shop/protocol";
import { headBytes, truncationMarker } from "./harnessEvents.js";
import type { State } from "./store.js";

/*
 * Run transcripts.
 *
 * This module owns the chronological projection of a run's accepted harness events that
 * conversation views read. It is updated in the same transaction that accepts each event, after
 * redaction, so it never holds text the run activity projection would not. Unlike the retained raw
 * events, which stop at a fixed count and would lose the end of a long streaming run, a transcript
 * coalesces deltas and evicts its oldest entries, so it always holds the most recent conversation.
 */
export const runTranscriptLimits = {
  bytesPerRun: 256 * 1024,
  entriesPerRun: 400,
  /** A coalesced text entry that would grow past this starts a new entry instead. */
  textBytesPerEntry: 32 * 1024,
  detailBytes: 4 * 1024,
  planEntryBytes: 2 * 1024,
  diffTextBytes: 16 * 1024,
  /** Runs whose transcript is retained; older finished runs lose it. */
  retainedRuns: 30
} as const;

/** Hub-only stored transcript. `entryBytes` parallels `entries`, so budgets cost O(1) per event. */
export interface StoredRunTranscript extends RunTranscript {
  entryBytes: number[];
  bytes: number;
}

const encoder = new TextEncoder();
const byteLength = (value: string) => encoder.encode(value).length;
const entrySize = (entry: RunTranscriptEntry) => byteLength(JSON.stringify(entry));

function truncateField(value: string, limit: number) {
  if (byteLength(value) <= limit) return value;
  return headBytes(value, limit - byteLength(truncationMarker)) + truncationMarker;
}

export function newRunTranscript(run: Pick<Run, "id" | "threadId">, at: string): StoredRunTranscript {
  return {
    runId: run.id,
    ...(run.threadId === undefined ? {} : { threadId: run.threadId }),
    lastSequence: 0,
    entries: [],
    omittedEntries: 0,
    updatedAt: at,
    entryBytes: [],
    bytes: 0
  };
}

function append(transcript: StoredRunTranscript, entry: RunTranscriptEntry) {
  const size = entrySize(entry);
  transcript.entries.push(entry);
  transcript.entryBytes.push(size);
  transcript.bytes += size;
}

function resized(transcript: StoredRunTranscript, index: number) {
  const size = entrySize(transcript.entries[index]!);
  transcript.bytes += size - transcript.entryBytes[index]!;
  transcript.entryBytes[index] = size;
}

function remove(transcript: StoredRunTranscript, index: number) {
  transcript.entries.splice(index, 1);
  transcript.bytes -= transcript.entryBytes.splice(index, 1)[0]!;
}

/** Evicts the oldest entries until the transcript fits; the newest entry always survives. */
function enforceBudget(transcript: StoredRunTranscript) {
  while (transcript.entries.length > 1
    && (transcript.bytes > runTranscriptLimits.bytesPerRun || transcript.entries.length > runTranscriptLimits.entriesPerRun)) {
    remove(transcript, 0);
    transcript.omittedEntries += 1;
  }
}

/** A single delta larger than an entry keeps its head and counts the bytes it dropped. */
function boundedText(text: string) {
  const kept = headBytes(text, runTranscriptLimits.textBytesPerEntry);
  return { text: kept, truncatedBytes: byteLength(text) - byteLength(kept) };
}

function appendText(transcript: StoredRunTranscript, event: Extract<HarnessEvent, { type: "message.delta" | "thought.delta" | "terminal.output" }>) {
  const lastIndex = transcript.entries.length - 1;
  const last = transcript.entries[lastIndex];
  const continues = event.type === "terminal.output"
    ? last?.kind === "terminal" && last.terminalId === event.terminalId && last.stream === event.stream
    : last?.kind === (event.type === "message.delta" ? "message" : "thought");
  if (continues && last && "text" in last
    && byteLength(last.text) + byteLength(event.text) <= runTranscriptLimits.textBytesPerEntry) {
    last.text += event.text;
    last.updatedAt = event.at;
    resized(transcript, lastIndex);
    return;
  }
  const base = { id: event.sequence, at: event.at, updatedAt: event.at, ...boundedText(event.text) };
  append(transcript, event.type === "message.delta" ? { ...base, kind: "message" }
    : event.type === "thought.delta" ? { ...base, kind: "thought" }
      : { ...base, kind: "terminal", terminalId: event.terminalId, stream: event.stream });
}

/** Applies one accepted, redacted event. Usage and unknown events advance the sequence only. */
export function applyRunTranscriptEvent(transcript: StoredRunTranscript, event: HarnessEvent) {
  const limits = runTranscriptLimits;
  switch (event.type) {
    case "message.delta":
    case "thought.delta":
    case "terminal.output":
      appendText(transcript, event);
      break;
    case "plan.updated": {
      const entries = event.entries.map((entry) => ({ ...entry, content: truncateField(entry.content, limits.planEntryBytes) }));
      const lastIndex = transcript.entries.length - 1;
      const last = transcript.entries[lastIndex];
      if (last?.kind === "plan") {
        last.entries = entries;
        last.updatedAt = event.at;
        resized(transcript, lastIndex);
        break;
      }
      // The latest plan moves to where it last changed, so a reader following the stream sees it.
      const previous = transcript.entries.findIndex((entry) => entry.kind === "plan");
      if (previous >= 0) remove(transcript, previous);
      append(transcript, { kind: "plan", id: event.sequence, at: event.at, updatedAt: event.at, entries });
      break;
    }
    case "tool.call": {
      const index = transcript.entries.findIndex((entry) => entry.kind === "tool" && entry.toolCallId === event.toolCallId);
      const existing = transcript.entries[index];
      if (existing?.kind === "tool") {
        existing.status = event.status;
        existing.toolKind = event.kind;
        existing.title = truncateField(event.title, limits.detailBytes);
        if (event.detail !== undefined) existing.detail = truncateField(event.detail, limits.detailBytes);
        existing.updatedAt = event.at;
        resized(transcript, index);
        break;
      }
      append(transcript, {
        kind: "tool", id: event.sequence, at: event.at, updatedAt: event.at, toolCallId: event.toolCallId, status: event.status,
        toolKind: event.kind, title: truncateField(event.title, limits.detailBytes),
        ...(event.detail === undefined ? {} : { detail: truncateField(event.detail, limits.detailBytes) })
      });
      break;
    }
    case "diff": {
      const newText = headBytes(event.newText, limits.diffTextBytes);
      const oldText = event.oldText === undefined ? undefined : headBytes(event.oldText, limits.diffTextBytes);
      append(transcript, {
        kind: "diff", id: event.sequence, at: event.at, updatedAt: event.at, path: truncateField(event.path, limits.detailBytes), newText,
        truncated: newText !== event.newText || oldText !== event.oldText,
        ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
        ...(oldText === undefined ? {} : { oldText })
      });
      break;
    }
    case "permission.requested":
      append(transcript, {
        kind: "approval", id: event.sequence, at: event.at, updatedAt: event.at, approvalId: event.approvalId, status: "pending",
        title: truncateField(event.title, limits.detailBytes),
        ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
        ...(event.detail === undefined ? {} : { detail: truncateField(event.detail, limits.detailBytes) })
      });
      break;
    case "permission.resolved": {
      const index = transcript.entries.findIndex((entry) => entry.kind === "approval" && entry.approvalId === event.approvalId);
      const existing = transcript.entries[index];
      if (existing?.kind === "approval") {
        existing.status = event.status;
        existing.updatedAt = event.at;
        resized(transcript, index);
      }
      break;
    }
    case "warning":
      append(transcript, {
        kind: "warning", id: event.sequence, at: event.at, updatedAt: event.at, code: event.code,
        message: truncateField(event.message, limits.detailBytes)
      });
      break;
    case "usage":
    case "unknown":
      break;
  }
  transcript.lastSequence = event.sequence;
  transcript.updatedAt = event.at;
  enforceBudget(transcript);
}

const isFinished = (run: Run | undefined) => !run || (run.status !== "running" && run.status !== "queued");

/** Drops the transcripts of the oldest finished runs beyond the retained run count. */
function pruneTranscripts(state: State) {
  const transcripts = state.runTranscripts ?? [];
  const excess = transcripts.length - runTranscriptLimits.retainedRuns;
  if (excess <= 0) return;
  const runs = new Map(state.runs.map((run) => [run.id, run]));
  const dropped = new Set(transcripts.slice(0, excess)
    .filter((transcript) => isFinished(runs.get(transcript.runId)))
    .map((transcript) => transcript.runId));
  if (dropped.size) state.runTranscripts = transcripts.filter((transcript) => !dropped.has(transcript.runId));
}

/** Records one accepted, redacted event inside the transaction that accepted it. */
export function recordRunTranscriptEvent(state: State, run: Run, event: HarnessEvent, at: string) {
  state.runTranscripts ??= [];
  let transcript = state.runTranscripts.find((item) => item.runId === run.id);
  if (!transcript) {
    transcript = newRunTranscript(run, at);
    state.runTranscripts.push(transcript);
    pruneTranscripts(state);
  }
  applyRunTranscriptEvent(transcript, event);
}

export function publicRunTranscript(transcript: StoredRunTranscript): RunTranscript {
  const { entryBytes: _entryBytes, bytes: _bytes, ...published } = transcript;
  return structuredClone(published);
}

/**
 * The transcript a conversation view reads. A run whose events were accepted before transcripts
 * existed is rebuilt from its retained raw events, but only when they are complete: a raw stream
 * that stopped retaining would silently lose the end of the conversation.
 */
export function runTranscriptFor(state: Readonly<State>, runId: string): RunTranscript | undefined {
  const stored = (state.runTranscripts ?? []).find((transcript) => transcript.runId === runId);
  if (stored) return publicRunTranscript(stored);
  const run = state.runs.find((item) => item.id === runId);
  const stream = (state.harnessEventStreams ?? []).find((item) => item.runId === runId);
  if (!run || !stream || stream.retentionTruncated) return undefined;
  const events = (state.harnessEvents ?? [])
    .filter((record) => record.runId === runId)
    .sort((left, right) => left.sequence - right.sequence);
  if (!events.length || events.length !== stream.lastSequence) return undefined;
  const rebuilt = newRunTranscript(run, events[0]!.receivedAt);
  for (const record of events) applyRunTranscriptEvent(rebuilt, record.event);
  return publicRunTranscript(rebuilt);
}
