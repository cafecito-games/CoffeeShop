import assert from "node:assert/strict";
import test from "node:test";
import type { Agent, ComputeNode, HarnessEvent, Run } from "@coffee-shop/protocol";
import {
  acceptHarnessEvent,
  harnessEventStorageLimits,
  retainedHarnessEvents,
  settleHarnessStateForTerminalRun,
  truncationMarker
} from "./harnessEvents.js";
import { approvalLifetimeMilliseconds } from "./approvals.js";
import { createRedactor } from "./redaction.js";
import type { State } from "./store.js";

const at = "2026-09-21T12:00:00.000Z";
const limits = harnessEventStorageLimits;
const redactor = createRedactor(["hub-enrollment-secret"]);
const source = { nodeId: "node-one", receivedAt: at, redactor };
const byteLength = (value: string) => Buffer.byteLength(value);

function agent(): Agent {
  return {
    id: "agent-one", name: "Milo", title: "Builder", summary: "Builds", glyph: "M",
    avatarShape: "cup", avatarColor: "amber", state: "working", currentAction: "Working",
    harnessId: "codex-cli", model: "gpt-5", computeNodeId: "node-one", workspace: "/workspace",
    systemPrompt: "Build", unread: 0, updatedAt: at
  };
}

function node(): ComputeNode {
  return {
    id: "node-one", name: "Desk", kind: "local", platform: "darwin", status: "online", lastSeen: at,
    activeRuns: 1, concurrency: 2, workspaceRoots: ["/workspace"], harnesses: [], version: "test"
  };
}

function run(status: Run["status"], id = "run-one"): Run {
  return {
    id, threadId: "thread-one", agentId: "agent-one", nodeId: "node-one", harnessId: "codex-cli", model: "gpt-5",
    workspace: "/workspace", prompt: "Build it", status, output: "", depth: 0, createdAt: at
  };
}

function state(status: Run["status"] = "running"): State {
  return { agents: [agent()], nodes: [node()], runs: [run(status)], events: [], messages: [] };
}

const accept = (current: State, event: HarnessEvent, from = source) => acceptHarnessEvent(current, from, event);

const messageDelta = (sequence: number, text: string, runId = "run-one"): HarnessEvent =>
  ({ type: "message.delta", runId, sequence, at, text });
const thoughtDelta = (sequence: number, text: string): HarnessEvent =>
  ({ type: "thought.delta", runId: "run-one", sequence, at, text });
const planUpdated = (sequence: number, entries: Array<{ content: string; status: "pending" | "in-progress" | "completed"; priority: "high" | "medium" | "low" }>): HarnessEvent =>
  ({ type: "plan.updated", runId: "run-one", sequence, at, entries });
const toolCall = (sequence: number, toolCallId: string, overrides: { status?: "pending" | "in-progress" | "completed" | "failed"; kind?: "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other"; title?: string; detail?: string } = {}): HarnessEvent =>
  ({ type: "tool.call", runId: "run-one", sequence, at, toolCallId, status: overrides.status ?? "in-progress", kind: overrides.kind ?? "edit", title: overrides.title ?? "Edit file", ...(overrides.detail !== undefined ? { detail: overrides.detail } : {}) });
const diffEvent = (sequence: number, path: string, newText: string, toolCallId?: string, oldText?: string): HarnessEvent =>
  ({ type: "diff", runId: "run-one", sequence, at, path, newText, ...(toolCallId !== undefined ? { toolCallId } : {}), ...(oldText !== undefined ? { oldText } : {}) });
const terminalOutput = (sequence: number, terminalId: string, stream: "stdout" | "stderr", text: string): HarnessEvent =>
  ({ type: "terminal.output", runId: "run-one", sequence, at, terminalId, stream, text });
const usageEvent = (sequence: number, fields: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; costUsd?: number }): HarnessEvent =>
  ({ type: "usage", runId: "run-one", sequence, at, ...fields });
const warningEvent = (sequence: number, code: string, message: string): HarnessEvent =>
  ({ type: "warning", runId: "run-one", sequence, at, code, message });
const unknownEvent = (sequence: number, sourceType: string): HarnessEvent =>
  ({ type: "unknown", runId: "run-one", sequence, at, sourceType });
const permissionRequested = (sequence: number, approvalId = "acp-approval-1", overrides: { title?: string; optionLabel?: string; detail?: string } = {}): HarnessEvent =>
  ({
    type: "permission.requested", runId: "run-one", sequence, at, approvalId, toolCallId: "call-1",
    title: overrides.title ?? "Run tests", ...(overrides.detail !== undefined ? { detail: overrides.detail } : {}),
    options: [{ id: "allow", label: overrides.optionLabel ?? "Allow once", kind: "allow-once" }, { id: "reject", label: "Reject", kind: "reject-once" }]
  });
const permissionResolved = (sequence: number, status: "approved" | "rejected" | "cancelled" | "expired", approvalId = "acp-approval-1", selectedOptionId?: string): HarnessEvent =>
  ({ type: "permission.resolved", runId: "run-one", sequence, at, approvalId, status, ...(selectedOptionId !== undefined ? { selectedOptionId } : {}) });

test("message deltas accumulate and the summary is the trimmed tail", () => {
  const current = state();
  assert.equal(accept(current, messageDelta(1, "  Hello ")).kind, "accepted");
  assert.equal(accept(current, messageDelta(2, "world  ")).kind, "accepted");
  const activity = current.runActivity![0];
  assert.equal(activity.message.text, "  Hello world  ");
  assert.equal(activity.message.truncatedBytes, 0);
  assert.equal(activity.summary, "Hello world");
});

test("thought deltas accumulate", () => {
  const current = state();
  accept(current, thoughtDelta(1, "Consider "));
  accept(current, thoughtDelta(2, "the options"));
  assert.equal(current.runActivity![0].thought.text, "Consider the options");
});

test("plan updates replace the plan wholesale", () => {
  const current = state();
  accept(current, planUpdated(1, [
    { content: "First", status: "completed", priority: "high" },
    { content: "Second", status: "pending", priority: "low" }
  ]));
  accept(current, planUpdated(2, [{ content: "Only", status: "in-progress", priority: "medium" }]));
  assert.deepEqual(current.runActivity![0].plan, [{ content: "Only", status: "in-progress", priority: "medium" }]);
});

test("tool calls upsert by toolCallId", () => {
  const current = state();
  accept(current, toolCall(1, "call-1", { status: "pending", detail: "starting" }));
  accept(current, toolCall(2, "call-1", { status: "completed", title: "Edited file" }));
  accept(current, toolCall(3, "call-2"));
  const activity = current.runActivity![0];
  assert.equal(activity.toolCalls.length, 2);
  assert.equal(activity.toolCalls[0].toolCallId, "call-1");
  assert.equal(activity.toolCalls[0].status, "completed");
  assert.equal(activity.toolCalls[0].title, "Edited file");
  assert.equal(activity.toolCalls[0].detail, "starting", "an update without detail keeps the earlier detail");
  assert.equal(activity.toolCalls[1].toolCallId, "call-2");
});

test("diffs upsert by path and toolCallId", () => {
  const current = state();
  accept(current, diffEvent(1, "src/one.ts", "first revision", "call-1"));
  accept(current, diffEvent(2, "src/one.ts", "second revision", "call-1"));
  accept(current, diffEvent(3, "src/two.ts", "other file", "call-1"));
  const activity = current.runActivity![0];
  assert.equal(activity.diffs.length, 2);
  assert.equal(activity.diffs[0].path, "src/one.ts");
  assert.equal(activity.diffs[0].newText, "second revision");
  assert.equal(activity.diffs[0].sequence, 2);
  assert.equal(activity.diffs[1].path, "src/two.ts");
});

test("terminal output accumulates per terminalId and stream", () => {
  const current = state();
  accept(current, terminalOutput(1, "term-1", "stdout", "hello "));
  accept(current, terminalOutput(2, "term-1", "stderr", "oops "));
  accept(current, terminalOutput(3, "term-1", "stdout", "world"));
  accept(current, terminalOutput(4, "term-2", "stdout", "other"));
  const activity = current.runActivity![0];
  assert.equal(activity.terminals.length, 2);
  assert.equal(activity.terminals[0].stdout.text, "hello world");
  assert.equal(activity.terminals[0].stderr.text, "oops ");
  assert.equal(activity.terminals[1].stdout.text, "other");
});

test("usage fields merge across events", () => {
  const current = state();
  accept(current, usageEvent(1, { inputTokens: 10, costUsd: 0.5 }));
  accept(current, usageEvent(2, { outputTokens: 20 }));
  const usageValue = current.runActivity![0].usage;
  assert.equal(usageValue?.inputTokens, 10);
  assert.equal(usageValue?.outputTokens, 20);
  assert.equal(usageValue?.costUsd, 0.5);
});

test("warnings are appended with their sequence", () => {
  const current = state();
  accept(current, warningEvent(1, "warn-a", "first"));
  accept(current, warningEvent(2, "warn-b", "second"));
  const activity = current.runActivity![0];
  assert.deepEqual(activity.warnings.map((warning) => warning.code), ["warn-a", "warn-b"]);
  assert.equal(activity.warnings[1].sequence, 2);
  assert.equal(activity.warnings[1].message, "second");
});

test("unknown events only increment the diagnostic counter", () => {
  const current = state();
  accept(current, unknownEvent(1, "provider.custom"));
  accept(current, unknownEvent(2, "provider.custom"));
  const activity = current.runActivity![0];
  assert.equal(activity.unknownEvents, 2);
  assert.equal(activity.message.text, "");
});

test("permission requests open pending approvals and harness cancellations resolve them", () => {
  const current = state();
  assert.equal(accept(current, permissionRequested(1)).kind, "accepted");
  const approval = current.approvals![0];
  assert.equal(approval.status, "pending");
  assert.equal(approval.harnessApprovalId, "acp-approval-1");
  assert.equal(approval.runId, "run-one");
  assert.equal(approval.threadId, "thread-one");
  assert.equal(approval.expiresAt, new Date(Date.parse(at) + approvalLifetimeMilliseconds).toISOString());

  assert.equal(accept(current, permissionResolved(2, "cancelled")).kind, "accepted");
  assert.equal(current.approvals![0].status, "cancelled");
  assert.deepEqual(current.approvals![0].resolvedBy, { kind: "system" });
});

test("accepted events advance stream counters, are retained in order, and filter by sequence", () => {
  const current = state();
  const events = [
    messageDelta(1, "first"), thoughtDelta(2, "second"), toolCall(3, "call-1"),
    terminalOutput(4, "term-1", "stdout", "out"), usageEvent(5, { inputTokens: 3 })
  ];
  for (const event of events) assert.equal(accept(current, event).kind, "accepted");
  const stream = current.harnessEventStreams![0];
  assert.equal(stream.lastSequence, 5);
  assert.equal(stream.status, "open");
  const activity = current.runActivity![0];
  assert.equal(activity.lastSequence, 5);
  assert.equal(activity.acceptedEvents, 5);
  assert.deepEqual(current.harnessEvents!.map((record) => record.sequence), [1, 2, 3, 4, 5]);
  assert.equal(current.harnessEvents![0].receivedAt, at);
  assert.deepEqual(current.harnessEvents![0].event, messageDelta(1, "first"));
  assert.deepEqual(retainedHarnessEvents(current, "run-one").map((record) => record.sequence), [1, 2, 3, 4, 5]);
  assert.deepEqual(retainedHarnessEvents(current, "run-one", 2).map((record) => record.sequence), [3, 4, 5]);
  assert.deepEqual(retainedHarnessEvents(current, "run-missing"), []);
});

test("an exact replay of an accepted sequence is a duplicate and leaves state untouched", () => {
  const current = state();
  accept(current, messageDelta(1, "hello"));
  accept(current, messageDelta(2, "world"));
  const before = structuredClone(current);
  assert.equal(accept(current, messageDelta(1, "hello")).kind, "duplicate");
  assert.equal(accept(current, messageDelta(2, "world")).kind, "duplicate");
  assert.deepEqual(current, before);
});

test("a conflicting replay fails the stream and rejects everything after it", () => {
  const current = state();
  accept(current, messageDelta(1, "hello"));
  const outcome = accept(current, messageDelta(1, "tampered"));
  if (outcome.kind !== "stream-failed") assert.fail(outcome.kind);
  assert.match(outcome.reason, /conflicting/);
  const activity = current.runActivity![0];
  assert.equal(activity.streamStatus, "failed");
  assert.match(activity.streamFailure ?? "", /conflicting/);
  assert.equal(current.events[0].title, "Harness event stream stopped");
  assert.equal(current.events[0].runId, "run-one");
  assert.equal(accept(current, messageDelta(2, "next")).kind, "rejected");
});

test("replaying a sequence older than the digest window fails the stream", () => {
  const current = state();
  const total = limits.digestWindow + 2;
  for (let sequence = 1; sequence <= total; sequence += 1) accept(current, messageDelta(sequence, `text-${sequence}`));
  const outcome = accept(current, messageDelta(1, "text-1"));
  if (outcome.kind !== "stream-failed") assert.fail(outcome.kind);
  assert.match(outcome.reason, /too old to verify/);
});

test("a gap or a zero sequence fails the stream", () => {
  const gapped = state();
  const gapOutcome = accept(gapped, messageDelta(2, "skipped one"));
  if (gapOutcome.kind !== "stream-failed") assert.fail(gapOutcome.kind);
  assert.match(gapOutcome.reason, /expected sequence 1/);

  const zero = state();
  const zeroOutcome = accept(zero, messageDelta(0, "zero"));
  if (zeroOutcome.kind !== "stream-failed") assert.fail(zeroOutcome.kind);
  assert.match(zeroOutcome.reason, /too old to verify/);
});

test("events for unknown runs, other nodes, and non-running runs are rejected without mutation", () => {
  const cases: Array<{ label: string; state: State; event: HarnessEvent; nodeId?: string }> = [
    { label: "unknown run", state: state(), event: messageDelta(1, "hi", "run-missing") },
    { label: "another node", state: state(), event: messageDelta(1, "hi"), nodeId: "node-two" },
    { label: "queued run", state: state("queued"), event: messageDelta(1, "hi") },
    { label: "completed run", state: state("completed"), event: messageDelta(1, "hi") },
    { label: "failed run", state: state("failed"), event: messageDelta(1, "hi") },
    { label: "cancelled run", state: state("cancelled"), event: messageDelta(1, "hi") }
  ];
  for (const item of cases) {
    const before = structuredClone(item.state);
    const outcome = acceptHarnessEvent(item.state, { nodeId: item.nodeId ?? source.nodeId, receivedAt: at, redactor }, item.event);
    assert.equal(outcome.kind, "rejected", item.label);
    assert.deepEqual(item.state, before, item.label);
  }
});

test("a stream failure cancels pending approvals and returns them for delivery", () => {
  const current = state();
  accept(current, permissionRequested(1));
  const outcome = accept(current, messageDelta(3, "gap"));
  if (outcome.kind !== "stream-failed") assert.fail(outcome.kind);
  assert.equal(outcome.deliveries.length, 1);
  const approval = outcome.deliveries[0];
  assert.equal(approval.status, "cancelled");
  assert.equal(approval.delivery?.status, "pending");
  assert.equal(current.approvals![0].status, "cancelled");
});

test("secrets are redacted from the projection, retained events, and approvals", () => {
  const hubSecret = "hub-enrollment-secret";
  const openAiKey = "sk-abcdefghijklmnopqrstuvwxyz0123";
  const githubToken = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const bearerCredential = "abcdefghijklmnopqrstuvwxyz0123";
  const current = state();
  accept(current, messageDelta(1, `leaked ${hubSecret} ${openAiKey} ${githubToken} Authorization: Bearer ${bearerCredential}`));
  accept(current, toolCall(2, "call-1", { title: `title ${openAiKey}`, detail: `detail ${githubToken}` }));
  accept(current, diffEvent(3, `src/${hubSecret}.ts`, `new ${openAiKey}`, "call-1", `old Authorization: Bearer ${bearerCredential}`));
  accept(current, terminalOutput(4, "term-1", "stdout", `out ${hubSecret}`));
  accept(current, warningEvent(5, "warn-secret", `message ${openAiKey}`));
  accept(current, planUpdated(6, [{ content: `step ${githubToken}`, status: "pending", priority: "high" }]));
  accept(current, permissionRequested(7, "acp-1", { title: `approve ${hubSecret}`, optionLabel: `allow ${openAiKey}` }));

  const activity = current.runActivity![0];
  assert.ok(activity.message.text.includes("[redacted]"));
  assert.ok(activity.toolCalls[0].title.includes("[redacted]"));
  assert.ok(activity.toolCalls[0].detail?.includes("[redacted]"));
  assert.ok(activity.diffs[0].path.includes("[redacted]"));
  assert.ok(activity.diffs[0].newText.includes("[redacted]"));
  assert.ok(activity.diffs[0].oldText?.includes("[redacted]"));
  assert.ok(activity.terminals[0].stdout.text.includes("[redacted]"));
  assert.ok(activity.warnings[0].message.includes("[redacted]"));
  assert.ok(activity.plan[0].content.includes("[redacted]"));
  const approval = current.approvals![0];
  assert.ok(approval.title.includes("[redacted]"));
  const labelledOption = approval.options.find((option) => option.id === "allow")!;
  assert.ok(labelledOption.label.includes("[redacted]"));
  assert.ok(JSON.stringify(current.harnessEvents).includes("[redacted]"));

  for (const secret of [hubSecret, openAiKey, githubToken, bearerCredential]) {
    assert.ok(!JSON.stringify(current).includes(secret), `raw secret remains: ${secret}`);
  }
});

test("a secret-like identity fails the stream and is never stored", () => {
  const cases: Array<{ label: string; event: HarnessEvent; secret: string }> = [
    { label: "toolCallId", event: toolCall(1, "call-hub-enrollment-secret-1"), secret: "hub-enrollment-secret" },
    { label: "terminalId", event: terminalOutput(1, "term-sk-abcdefghijklmnopqrstuvwxyz0123", "stdout", "hi"), secret: "sk-abcdefghijklmnopqrstuvwxyz0123" }
  ];
  for (const item of cases) {
    const current = state();
    const outcome = accept(current, item.event);
    if (outcome.kind !== "stream-failed") assert.fail(`${item.label}: ${outcome.kind}`);
    assert.match(outcome.reason, /secret-like/);
    assert.ok(!JSON.stringify(current).includes(item.secret), item.label);
    assert.equal(current.harnessEvents?.length ?? 0, 0, item.label);
  }
});

test("message text truncates at the byte limit without splitting characters", () => {
  const exact = state();
  accept(exact, messageDelta(1, "a".repeat(limits.messageBytes)));
  assert.equal(exact.runActivity![0].message.truncatedBytes, 0);
  assert.equal(byteLength(exact.runActivity![0].message.text), limits.messageBytes);

  const over = state();
  accept(over, messageDelta(1, `${"a".repeat(limits.messageBytes)}b`));
  const bounded = over.runActivity![0].message;
  assert.equal(bounded.truncatedBytes, 1);
  assert.equal(byteLength(bounded.text), limits.messageBytes);

  for (const text of [`${"é".repeat(limits.messageBytes / 2)}a`, `${"😀".repeat(limits.messageBytes / 4)}aaa`]) {
    const multiByte = state();
    accept(multiByte, messageDelta(1, text));
    const kept = multiByte.runActivity![0].message;
    assert.ok(byteLength(kept.text) <= limits.messageBytes);
    assert.ok(!kept.text.includes("�"));
    assert.equal(Buffer.from(kept.text, "utf8").toString("utf8"), kept.text);
    assert.equal(kept.truncatedBytes, byteLength(text) - byteLength(kept.text));
    assert.ok(kept.truncatedBytes > 0);
  }
});

test("the summary stays within its byte bound", () => {
  const current = state();
  accept(current, messageDelta(1, "x".repeat(limits.summaryBytes * 2)));
  const activity = current.runActivity![0];
  assert.ok(byteLength(activity.summary) <= limits.summaryBytes);
  assert.equal(activity.summary, "x".repeat(limits.summaryBytes));
});

test("terminal output truncates at terminalBytes", () => {
  const exact = state();
  accept(exact, terminalOutput(1, "term-1", "stdout", "b".repeat(limits.terminalBytes)));
  assert.equal(exact.runActivity![0].terminals[0].stdout.truncatedBytes, 0);

  const over = state();
  accept(over, terminalOutput(1, "term-1", "stdout", `${"b".repeat(limits.terminalBytes)}c`));
  const bounded = over.runActivity![0].terminals[0].stdout;
  assert.equal(bounded.truncatedBytes, 1);
  assert.equal(byteLength(bounded.text), limits.terminalBytes);
});

test("tool call detail over its bound ends with the truncation marker", () => {
  const current = state();
  accept(current, toolCall(1, "call-1", { detail: `${"d".repeat(limits.toolDetailBytes)}x` }));
  const detail = current.runActivity![0].toolCalls[0].detail!;
  assert.ok(detail.endsWith(truncationMarker));
  assert.equal(byteLength(detail), limits.toolDetailBytes);
});

test("plan entry content over its bound ends with the truncation marker", () => {
  const current = state();
  accept(current, planUpdated(1, [{ content: `${"c".repeat(limits.planEntryBytes)}x`, status: "pending", priority: "high" }]));
  const content = current.runActivity![0].plan[0].content;
  assert.ok(content.endsWith(truncationMarker));
  assert.equal(byteLength(content), limits.planEntryBytes);
});

test("diff text is bounded per diff and cumulatively per run", () => {
  const exact = state();
  accept(exact, diffEvent(1, "src/exact.ts", "d".repeat(limits.diffTextBytes)));
  assert.equal(exact.runActivity![0].diffs[0].truncated, false);
  assert.equal(exact.runActivity![0].diffs[0].newText, "d".repeat(limits.diffTextBytes));

  const over = state();
  accept(over, diffEvent(1, "src/over.ts", `${"d".repeat(limits.diffTextBytes)}x`));
  const overDiff = over.runActivity![0].diffs[0];
  assert.equal(overDiff.truncated, true);
  assert.equal(byteLength(overDiff.newText), limits.diffTextBytes);

  const budget = state();
  const fits = limits.diffBudgetBytes / limits.diffTextBytes;
  for (let index = 0; index < fits; index += 1) {
    assert.equal(accept(budget, diffEvent(index + 1, `src/file-${index}.ts`, "e".repeat(limits.diffTextBytes))).kind, "accepted");
  }
  assert.equal(budget.runActivity![0].diffs.length, fits);
  assert.equal(accept(budget, diffEvent(fits + 1, "src/overflow.ts", "e".repeat(limits.diffTextBytes))).kind, "accepted");
  const overflow = budget.runActivity![0].diffs[fits];
  assert.equal(overflow.path, "src/overflow.ts");
  assert.equal(overflow.newText, "");
  assert.equal(overflow.truncated, true);
});

test("count limits omit new items but keep updating existing ones", () => {
  const current = state();
  let sequence = 0;
  for (let index = 0; index < limits.toolCalls; index += 1) accept(current, toolCall(sequence += 1, `call-${index}`));
  accept(current, toolCall(sequence += 1, "call-new"));
  let activity = current.runActivity![0];
  assert.equal(activity.toolCalls.length, limits.toolCalls);
  assert.equal(activity.omitted.toolCalls, 1);
  accept(current, toolCall(sequence += 1, "call-0", { title: "Updated" }));
  activity = current.runActivity![0];
  assert.equal(activity.omitted.toolCalls, 1);
  assert.equal(activity.toolCalls.find((call) => call.toolCallId === "call-0")?.title, "Updated");
  assert.equal(activity.toolCalls.some((call) => call.toolCallId === "call-new"), false);

  for (let index = 0; index < limits.diffs; index += 1) accept(current, diffEvent(sequence += 1, `count-${index}.txt`, "x"));
  accept(current, diffEvent(sequence += 1, "count-overflow.txt", "x"));
  activity = current.runActivity![0];
  assert.equal(activity.omitted.diffs, 1);
  assert.equal(activity.diffs.length, limits.diffs);
  assert.equal(activity.diffs.some((diff) => diff.path === "count-overflow.txt"), false);

  for (let index = 0; index < limits.terminals; index += 1) accept(current, terminalOutput(sequence += 1, `term-${index}`, "stdout", "x"));
  accept(current, terminalOutput(sequence += 1, "term-new", "stdout", "x"));
  activity = current.runActivity![0];
  assert.equal(activity.omitted.terminals, 1);
  assert.equal(activity.terminals.length, limits.terminals);
  assert.equal(activity.terminals.some((terminal) => terminal.terminalId === "term-new"), false);

  for (let index = 1; index <= limits.warnings + 2; index += 1) accept(current, warningEvent(sequence += 1, `warn-${index}`, `message ${index}`));
  activity = current.runActivity![0];
  assert.equal(activity.warnings.length, limits.warnings);
  assert.equal(activity.omitted.warnings, 2);
  assert.equal(activity.warnings[0].code, "warn-3");
  assert.equal(activity.warnings[limits.warnings - 1].code, `warn-${limits.warnings + 2}`);
});

test("raw events stop being retained past the per-run bounds while the projection continues", () => {
  const current = state();
  for (let sequence = 1; sequence <= limits.retainedEventsPerRun; sequence += 1) accept(current, messageDelta(sequence, "x"));
  assert.equal(current.harnessEvents!.length, limits.retainedEventsPerRun);
  accept(current, messageDelta(limits.retainedEventsPerRun + 1, "x"));
  assert.equal(current.harnessEvents!.length, limits.retainedEventsPerRun);
  assert.equal(current.harnessEventStreams![0].retentionTruncated, true);
  assert.equal(current.runActivity![0].acceptedEvents, limits.retainedEventsPerRun + 1);
  assert.equal(current.runActivity![0].lastSequence, limits.retainedEventsPerRun + 1);
});

test("an event larger than the remaining retained bytes is projected but not retained", () => {
  const current = state();
  accept(current, messageDelta(1, "a".repeat(limits.retainedBytesPerRun + 64)));
  assert.equal(current.harnessEvents!.length, 0);
  assert.equal(current.harnessEventStreams![0].retentionTruncated, true);
  assert.equal(current.runActivity![0].acceptedEvents, 1);
  assert.equal(byteLength(current.runActivity![0].message.text), limits.messageBytes);
});

test("history pruning drops retained events of the oldest terminal runs", () => {
  const current = state();
  current.runs = [];
  const total = limits.retainedEventRuns + 2;
  for (let index = 1; index <= total; index += 1) current.runs.push(run("running", `run-history-${index}`));
  for (let index = 1; index <= total; index += 1) {
    assert.equal(accept(current, messageDelta(1, `text-${index}`, `run-history-${index}`)).kind, "accepted");
  }
  for (let index = 1; index <= total; index += 1) {
    current.runs[index - 1].status = "completed";
    settleHarnessStateForTerminalRun(current, `run-history-${index}`, at);
  }
  current.runs.push(run("running", "run-history-new"));
  assert.equal(accept(current, messageDelta(1, "new", "run-history-new")).kind, "accepted");

  for (const pruned of ["run-history-1", "run-history-2", "run-history-3"]) {
    assert.deepEqual(retainedHarnessEvents(current, pruned), [], pruned);
    const stream = current.harnessEventStreams!.find((item) => item.runId === pruned);
    assert.equal(stream?.retainedEvents, 0, pruned);
    assert.equal(stream?.retentionTruncated, true, pruned);
  }
  assert.ok(retainedHarnessEvents(current, "run-history-22").length > 0);
  assert.ok(retainedHarnessEvents(current, "run-history-new").length > 0);
});

test("history pruning drops the activity of the oldest terminal runs", () => {
  const current = state();
  current.runs = [];
  const total = limits.retainedActivityRuns + 2;
  for (let index = 1; index <= total; index += 1) current.runs.push(run("running", `run-activity-${index}`));
  for (let index = 1; index <= total; index += 1) {
    assert.equal(accept(current, messageDelta(1, `text-${index}`, `run-activity-${index}`)).kind, "accepted");
  }
  for (let index = 1; index <= total; index += 1) {
    current.runs[index - 1].status = "completed";
    settleHarnessStateForTerminalRun(current, `run-activity-${index}`, at);
  }
  current.runs.push(run("running", "run-activity-new"));
  assert.equal(accept(current, messageDelta(1, "new", "run-activity-new")).kind, "accepted");

  const activityRunIds = current.runActivity!.map((activity) => activity.runId);
  for (const pruned of ["run-activity-1", "run-activity-2", "run-activity-3"]) {
    assert.ok(!activityRunIds.includes(pruned), pruned);
  }
  assert.ok(activityRunIds.includes("run-activity-4"));
  assert.ok(activityRunIds.includes("run-activity-new"));
  assert.equal(current.runActivity!.length, limits.retainedActivityRuns);
});

test("settling a terminal run closes its stream, empties digests, and cancels pending approvals", () => {
  const current = state();
  accept(current, messageDelta(1, "hello"));
  accept(current, permissionRequested(2));
  current.runs[0].status = "completed";
  settleHarnessStateForTerminalRun(current, "run-one", at);
  const stream = current.harnessEventStreams![0];
  assert.equal(stream.status, "closed");
  assert.deepEqual(stream.recentDigests, []);
  assert.equal(current.runActivity![0].streamStatus, "closed");
  assert.equal(current.approvals![0].status, "cancelled");
  assert.deepEqual(current.approvals![0].resolvedBy, { kind: "system" });
});

test("settling a terminal run leaves a failed stream failed", () => {
  const current = state();
  accept(current, messageDelta(1, "hello"));
  accept(current, messageDelta(3, "gap"));
  current.runs[0].status = "completed";
  settleHarnessStateForTerminalRun(current, "run-one", at);
  assert.equal(current.harnessEventStreams![0].status, "failed");
  assert.equal(current.runActivity![0].streamStatus, "failed");
});

test("the projection can be rebuilt from the retained events", () => {
  let sequence = 0;
  const next = () => sequence += 1;
  const events: HarnessEvent[] = [
    messageDelta(next(), "alpha"), messageDelta(next(), " beta"), thoughtDelta(next(), "thinking"),
    thoughtDelta(next(), " more"), planUpdated(next(), [{ content: "Step", status: "pending", priority: "high" }]),
    toolCall(next(), "call-1", { status: "pending", detail: "starting" }),
    toolCall(next(), "call-1", { status: "completed" }),
    toolCall(next(), "call-2"),
    diffEvent(next(), "src/one.ts", "new text", "call-1", "old text"),
    diffEvent(next(), "src/two.ts", "other", "call-1"),
    terminalOutput(next(), "term-1", "stdout", "out "), terminalOutput(next(), "term-1", "stderr", "err"),
    terminalOutput(next(), "term-2", "stdout", "second"),
    usageEvent(next(), { inputTokens: 5, costUsd: 0.25 }), usageEvent(next(), { outputTokens: 9 }),
    warningEvent(next(), "warn-one", "careful"), warningEvent(next(), "warn-two", "again"),
    unknownEvent(next(), "provider.custom"), unknownEvent(next(), "provider.other"),
    permissionRequested(next(), "acp-rebuild"),
    permissionResolved(next(), "cancelled", "acp-rebuild"),
    messageDelta(next(), " gamma"), messageDelta(next(), " delta"), messageDelta(next(), " epsilon"),
    thoughtDelta(next(), " wrap-up"),
    toolCall(next(), "call-2", { status: "completed" }),
    terminalOutput(next(), "term-2", "stdout", " more"),
    usageEvent(next(), { cachedInputTokens: 4 }),
    unknownEvent(next(), "provider.third"),
    planUpdated(next(), [{ content: "Done", status: "completed", priority: "low" }]),
    messageDelta(next(), " zeta")
  ];
  assert.equal(events.length, 31);

  const first = state();
  for (const event of events) assert.equal(accept(first, event).kind, "accepted");
  const second = state();
  for (const record of retainedHarnessEvents(first, "run-one")) {
    assert.equal(accept(second, structuredClone(record.event)).kind, "accepted");
  }
  assert.equal(second.runActivity![0].lastSequence, first.runActivity![0].lastSequence);
  assert.deepEqual(second.runActivity![0], first.runActivity![0]);
});

test("permission events that contradict approval state fail the stream", () => {
  const repeated = state();
  accept(repeated, permissionRequested(1));
  const repeatedOutcome = accept(repeated, permissionRequested(2));
  if (repeatedOutcome.kind !== "stream-failed") assert.fail(repeatedOutcome.kind);
  assert.match(repeatedOutcome.reason, /already raised/);

  const unauthorized = state();
  accept(unauthorized, permissionRequested(1));
  const unauthorizedOutcome = accept(unauthorized, permissionResolved(2, "approved", "acp-approval-1", "allow"));
  if (unauthorizedOutcome.kind !== "stream-failed") assert.fail(unauthorizedOutcome.kind);
  assert.match(unauthorizedOutcome.reason, /without a hub decision/);
  assert.equal(unauthorized.approvals![0].status, "cancelled", "the failed stream cancels the pending approval");

  const missing = state();
  const missingOutcome = accept(missing, permissionResolved(1, "cancelled", "acp-unknown"));
  if (missingOutcome.kind !== "stream-failed") assert.fail(missingOutcome.kind);
  assert.match(missingOutcome.reason, /unknown approval/);
});

test("rejections never echo an unknown, token-shaped run identity", () => {
  const current = state();
  const secretRunId = `sk-proj-${"a".repeat(32)}`;
  const outcome = accept(current, messageDelta(1, "hello", secretRunId));
  assert.equal(outcome.kind, "rejected");
  assert.ok(outcome.kind === "rejected" && !outcome.reason.includes(secretRunId));
  assert.ok(!JSON.stringify(current).includes(secretRunId));
});
