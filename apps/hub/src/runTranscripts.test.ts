import assert from "node:assert/strict";
import test from "node:test";
import type { HarnessEvent, Run, RunTranscriptEntry } from "@coffee-shop/protocol";
import { acceptHarnessEvent, harnessEventStorageLimits } from "./harnessEvents.js";
import { createRedactor } from "./redaction.js";
import { runTranscriptFor, runTranscriptLimits } from "./runTranscripts.js";
import type { State } from "./store.js";

const at = "2026-09-29T12:00:00.000Z";
const source = { nodeId: "node-one", receivedAt: at, redactor: createRedactor(["hub-enrollment-secret"]) };

function run(id = "run-one", status: Run["status"] = "running"): Run {
  return {
    id, threadId: "thread-one", agentId: "agent-one", nodeId: "node-one", harnessId: "claude-cli", model: "sonnet",
    workspace: "/workspace", prompt: "Build it", status, output: "", depth: 0, createdAt: at
  };
}

function state(...runs: Run[]): State {
  return { agents: [], nodes: [], runs: runs.length ? runs : [run()], events: [], messages: [] };
}

type EventInput = HarnessEvent extends infer Event ? Event extends HarnessEvent ? Omit<Event, "runId" | "sequence" | "at"> : never : never;

/** Feeds events in order, numbering them from the run's next sequence. */
function feed(current: State, events: EventInput[], runId = "run-one") {
  const next = () => (current.harnessEventStreams?.find((stream) => stream.runId === runId)?.lastSequence ?? 0) + 1;
  for (const event of events) {
    const outcome = acceptHarnessEvent(current, source, { ...event, runId, sequence: next(), at } as HarnessEvent);
    assert.equal(outcome.kind, "accepted", JSON.stringify(outcome));
  }
}

const kinds = (entries: RunTranscriptEntry[]) => entries.map((entry) => entry.kind);

test("a transcript keeps the order the harness produced and coalesces consecutive deltas", () => {
  const current = state();
  feed(current, [
    { type: "thought.delta", text: "Let me look " },
    { type: "thought.delta", text: "at the tests." },
    { type: "message.delta", text: "I'll run " },
    { type: "message.delta", text: "the suite." },
    { type: "tool.call", toolCallId: "call-1", status: "in-progress", kind: "execute", title: "pnpm test" },
    { type: "terminal.output", terminalId: "term-1", stream: "stdout", text: "ok 1\n" },
    { type: "terminal.output", terminalId: "term-1", stream: "stdout", text: "ok 2\n" },
    { type: "tool.call", toolCallId: "call-1", status: "completed", kind: "execute", title: "pnpm test", detail: "2 passed" },
    { type: "message.delta", text: "All green." },
    { type: "usage", inputTokens: 10 }
  ]);
  const transcript = runTranscriptFor(current, "run-one")!;
  assert.deepEqual(kinds(transcript.entries), ["thought", "message", "tool", "terminal", "message"]);
  assert.equal(transcript.lastSequence, 10);
  const [thought, message, tool, terminal, last] = transcript.entries;
  assert.equal(thought!.kind === "thought" && thought.text, "Let me look at the tests.");
  assert.equal(message!.kind === "message" && message.text, "I'll run the suite.");
  assert.equal(message!.id, 3, "an entry is identified by the sequence that opened it");
  assert.deepEqual(tool!.kind === "tool" && { status: tool.status, detail: tool.detail }, { status: "completed", detail: "2 passed" },
    "a tool call is updated in place rather than appended again");
  assert.equal(terminal!.kind === "terminal" && terminal.text, "ok 1\nok 2\n");
  assert.equal(last!.kind === "message" && last.text, "All green.");
  assert.equal(transcript.omittedEntries, 0);
  assert.equal("entryBytes" in transcript || "bytes" in transcript, false, "budget bookkeeping stays hub-internal");
});

test("the latest plan moves to where it last changed and approvals follow their resolution", () => {
  const current = state();
  feed(current, [
    { type: "plan.updated", entries: [{ content: "Write tests", status: "pending", priority: "high" }] },
    { type: "plan.updated", entries: [{ content: "Write tests", status: "in-progress", priority: "high" }] },
    { type: "message.delta", text: "Starting." },
    { type: "permission.requested", approvalId: "acp-1", toolCallId: "call-1", title: "Run rm", options: [{ id: "allow", label: "Allow", kind: "allow-once" }] },
    { type: "permission.resolved", approvalId: "acp-1", status: "cancelled" },
    { type: "plan.updated", entries: [{ content: "Write tests", status: "completed", priority: "high" }] }
  ]);
  const { entries } = runTranscriptFor(current, "run-one")!;
  assert.deepEqual(kinds(entries), ["message", "approval", "plan"]);
  const approval = entries[1]!;
  assert.equal(approval.kind === "approval" && approval.status, "cancelled");
  assert.equal(approval.kind === "approval" && approval.approvalId, "acp-1");
  const plan = entries[2]!;
  assert.equal(plan.kind === "plan" && plan.entries[0]!.status, "completed");
});

test("text is redacted before it reaches the transcript", () => {
  const current = state();
  feed(current, [{ type: "message.delta", text: "token hub-enrollment-secret here" }]);
  const entry = runTranscriptFor(current, "run-one")!.entries[0]!;
  assert.equal(entry.kind === "message" && entry.text.includes("hub-enrollment-secret"), false);
});

test("a long message is split into bounded entries and the oldest entries are evicted past the budget", () => {
  const current = state();
  const chunk = "x".repeat(8 * 1024);
  const chunks = Math.ceil(runTranscriptLimits.bytesPerRun / chunk.length) + 8;
  feed(current, Array.from({ length: chunks }, () => ({ type: "message.delta", text: chunk })));
  const transcript = runTranscriptFor(current, "run-one")!;
  assert.ok(transcript.entries.every((entry) => entry.kind === "message" && Buffer.byteLength(entry.text) <= runTranscriptLimits.textBytesPerEntry));
  assert.ok(transcript.omittedEntries > 0, "the oldest entries were dropped");
  const kept = transcript.entries.reduce((total, entry) => total + (entry.kind === "message" ? entry.text.length : 0), 0);
  assert.ok(kept <= runTranscriptLimits.bytesPerRun);
  assert.equal(transcript.lastSequence, chunks, "the newest events are always kept");
});

test("a transcript outlives raw event retention for long streaming runs", () => {
  const current = state();
  const count = harnessEventStorageLimits.retainedEventsPerRun + 50;
  feed(current, Array.from({ length: count }, (_, index) => ({ type: "message.delta", text: `${index} ` })));
  assert.equal(current.harnessEventStreams![0]!.retentionTruncated, true);
  const transcript = runTranscriptFor(current, "run-one")!;
  const entry = transcript.entries.at(-1)!;
  assert.ok(entry.kind === "message" && entry.text.endsWith(`${count - 1} `));
});

test("a run with only retained raw events is rebuilt, and nothing is invented for a run without them", () => {
  const current = state();
  feed(current, [{ type: "message.delta", text: "Hello" }, { type: "tool.call", toolCallId: "c", status: "pending", kind: "read", title: "Read" }]);
  const recorded = runTranscriptFor(current, "run-one");
  delete current.runTranscripts;
  assert.deepEqual(runTranscriptFor(current, "run-one"), recorded);
  current.harnessEventStreams![0]!.retentionTruncated = true;
  assert.equal(runTranscriptFor(current, "run-one"), undefined, "an incomplete raw stream is never passed off as the conversation");
  assert.equal(runTranscriptFor(current, "missing"), undefined);
});

test("only the most recent finished runs keep their transcripts", () => {
  const runs = Array.from({ length: runTranscriptLimits.retainedRuns + 3 }, (_, index) => run(`run-${index}`));
  const current = state(...runs);
  runs.forEach((item, index) => {
    feed(current, [{ type: "message.delta", text: `turn ${index}` }], item.id);
    if (index === 1) return; // still running: never dropped
    item.status = "completed";
  });
  const retained = new Set(current.runTranscripts!.map((transcript) => transcript.runId));
  assert.equal(retained.has("run-0"), false);
  assert.equal(retained.has("run-1"), true, "a running run keeps its transcript");
  assert.equal(retained.has(`run-${runs.length - 1}`), true);
  assert.ok(current.runTranscripts!.length <= runTranscriptLimits.retainedRuns + 1);
});
