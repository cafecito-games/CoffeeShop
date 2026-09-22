import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  approvalDeliveryStatuses,
  canAcceptFromControlAgent,
  harnessEventLimits,
  harnessEventStreamStatuses,
  isApprovalDeliveryStatus,
  isOrchestrationControlAgentMessageType,
  isTimestamp,
  requiredCapabilityForControlAgentMessage,
  validateApprovalDecision,
  validateHarnessEvent,
  validateOrchestrationControlAgentMessage
} from "../dist/index.js";

const at = "2026-09-21T12:00:00Z";
const encoder = new TextEncoder();
const byteLength = (value) => encoder.encode(value).length;

test("isTimestamp accepts only strict RFC 3339 with a mandatory offset", () => {
  const accepted = [
    "2026-09-21T12:00:00Z",
    "2026-09-21T12:00:00.123456789Z",
    "2026-09-21T12:00:00+02:00",
    "2026-09-21T12:00:00.5-07:30"
  ];
  for (const value of accepted) {
    assert.equal(isTimestamp(value), true, `${value} must be accepted`);
  }

  const rejected = [
    "2026-09-21",
    "2026-09-21 12:00:00Z",
    "2026-09-21T12:00:00",
    "Mon, 21 Sep 2026 12:00:00 GMT",
    "1757000000",
    "2026-13-01T00:00:00Z",
    "2026-09-21T24:00:00Z",
    "2026-09-21T12:00:00.1234567890Z",
    ""
  ];
  for (const value of rejected) {
    assert.equal(isTimestamp(value), false, `${value} must be rejected`);
  }
  for (const value of [123, null, undefined, {}, [], true]) {
    assert.equal(isTimestamp(value), false, `${JSON.stringify(value)} must be rejected as a non-string`);
  }
});

test("harness events reject timestamps Date.parse would accept but RFC 3339 does not", () => {
  const loose = validateHarnessEvent({
    type: "message.delta", runId: "run-one", sequence: 1, at: "Sep 21 2026 12:00", text: "hello"
  });
  assert.equal(loose.ok, false, "a non-RFC 3339 timestamp must be rejected even though Date.parse accepts it");
});

test("approval decisions reject undeclared keys while accepting every terminal shape", () => {
  const accepted = {
    approved: { approvalId: "approval-one", runId: "run-one", status: "approved", selectedOptionId: "allow-once" },
    rejected: { approvalId: "approval-one", runId: "run-one", status: "rejected", selectedOptionId: "reject-once" },
    cancelled: { approvalId: "approval-one", runId: "run-one", status: "cancelled" },
    expired: { approvalId: "approval-one", runId: "run-one", status: "expired" }
  };
  for (const [status, decision] of Object.entries(accepted)) {
    const result = validateApprovalDecision(decision);
    assert.equal(result.ok, true, `${status} decision must be accepted: ${result.ok ? "" : result.reason}`);
  }
  const extraKey = validateApprovalDecision({
    approvalId: "approval-one", runId: "run-one", status: "approved", selectedOptionId: "allow-once", nodeId: "node-one"
  });
  assert.equal(extraKey.ok, false, "an undeclared key must be rejected");
});

const fixtureDirectory = new URL("./fixtures/control-v4/", import.meta.url);
const readFixture = (name) => JSON.parse(readFileSync(new URL(name, fixtureDirectory), "utf8"));

const undeliverable = () => ({ ...readFixture("approval-undeliverable.json") });

test("approval.undeliverable validates only on version 4", () => {
  const fixture = undeliverable();
  const accepted = validateOrchestrationControlAgentMessage(fixture, "4");
  assert.equal(accepted.ok, true, `fixture must validate for version 4: ${accepted.ok ? "" : accepted.reason}`);
  assert.deepEqual(JSON.parse(JSON.stringify(accepted.value)), fixture, "accepted value round-trips unchanged");
  for (const version of ["1", "2", "3"]) {
    assert.equal(validateOrchestrationControlAgentMessage(fixture, version).ok, false, `fixture must be rejected for version ${version}`);
  }
});

test("approval.undeliverable rejects malformed envelopes", () => {
  const negatives = [
    ["extra envelope key", { ...undeliverable(), activeRuns: 0 }],
    ["missing runId", (() => { const message = undeliverable(); delete message.runId; return message; })()],
    ["empty approvalId", { ...undeliverable(), approvalId: "" }],
    ["identifier over 256 bytes", { ...undeliverable(), approvalId: "a".repeat(harnessEventLimits.identifierBytes + 1) }],
    ["non-RFC3339 at", { ...undeliverable(), at: "Sep 21 2026 12:00" }],
    ["reason over 2048 bytes", { ...undeliverable(), reason: "a".repeat(2049) }],
    ["non-string reason", { ...undeliverable(), reason: 42 }]
  ];
  for (const [label, value] of negatives) {
    const result = validateOrchestrationControlAgentMessage(value, "4");
    assert.equal(result.ok, false, `${label} must be rejected`);
  }
  const atLimit = validateOrchestrationControlAgentMessage({ ...undeliverable(), reason: "a".repeat(2048) }, "4");
  assert.equal(atLimit.ok, true, `a reason of exactly 2048 bytes must be accepted: ${atLimit.ok ? "" : atLimit.reason}`);
});

test("harness.event envelopes reject undeclared fields such as activeRuns on version 4", () => {
  const message = {
    type: "harness.event",
    event: { type: "message.delta", runId: "run-one", sequence: 1, at, text: "hello" },
    activeRuns: 0
  };
  assert.equal(validateOrchestrationControlAgentMessage(message, "4").ok, false);
  const withoutExtras = { type: "harness.event", event: message.event };
  const accepted = validateOrchestrationControlAgentMessage(withoutExtras, "4");
  assert.equal(accepted.ok, true, `the dedicated envelope must be accepted: ${accepted.ok ? "" : accepted.reason}`);
});

test("approval.undeliverable requires the orchestration capability", () => {
  const message = { type: "approval.undeliverable", runId: "run-one", approvalId: "approval-one", reason: "no live request", at };
  assert.equal(requiredCapabilityForControlAgentMessage(message), "orchestration");
  for (const version of ["1", "2", "3"]) {
    assert.equal(canAcceptFromControlAgent(message, version), false, `version ${version} must not accept approval.undeliverable`);
  }
  assert.equal(canAcceptFromControlAgent(message, "4"), true);
});

test("orchestration message types are distinguished from lifecycle messages", () => {
  for (const type of ["harness.event", "session.binding", "workspace.lease", "approval.undeliverable"]) {
    assert.equal(isOrchestrationControlAgentMessageType(type), true, `${type} is an orchestration type`);
  }
  for (const type of ["run.output", "register", ""]) {
    assert.equal(isOrchestrationControlAgentMessageType(type), false, `${type} is not an orchestration type`);
  }
});

test("approval delivery and harness event stream vocabularies keep their exact contents", () => {
  assert.deepEqual(approvalDeliveryStatuses, ["pending", "sent", "applied", "not-applied"]);
  for (const status of approvalDeliveryStatuses) {
    assert.equal(isApprovalDeliveryStatus(status), true, `${status} is a delivery status`);
  }
  for (const status of ["delivered", "unknown", "", 3, null]) {
    assert.equal(isApprovalDeliveryStatus(status), false, `${JSON.stringify(status)} is not a delivery status`);
  }
  assert.deepEqual(harnessEventStreamStatuses, ["open", "closed", "failed"]);
});

const boundedEvent = (overrides) => ({
  type: "message.delta", runId: "run-one", sequence: 1, at, text: "hello", ...overrides
});

test("every bounded harness event field accepts its exact limit and rejects one more byte", () => {
  const identifierLimit = "a".repeat(harnessEventLimits.identifierBytes);
  const identifierOver = "a".repeat(harnessEventLimits.identifierBytes + 1);
  const textLimit = "a".repeat(harnessEventLimits.textBytes);
  const textOver = "a".repeat(harnessEventLimits.textBytes + 1);
  const diagnosticLimit = "a".repeat(harnessEventLimits.diagnosticBytes);
  const diagnosticOver = "a".repeat(harnessEventLimits.diagnosticBytes + 1);
  const diffLimit = "a".repeat(harnessEventLimits.diffBytes);
  const diffOver = "a".repeat(harnessEventLimits.diffBytes + 1);
  const option = (index) => ({ id: `option-${index}`, label: `Option ${index}`, kind: "allow-once" });
  const entries = (count) => Array.from({ length: count }, () => ({ content: "Write", status: "pending", priority: "low" }));

  const boundaries = [
    ["message.delta text at textBytes", boundedEvent({ text: textLimit }), boundedEvent({ text: textOver })],
    ["thought.delta text at textBytes", boundedEvent({ type: "thought.delta", text: textLimit }), boundedEvent({ type: "thought.delta", text: textOver })],
    ["plan.updated at planEntries", { type: "plan.updated", runId: "run-one", sequence: 1, at, entries: entries(harnessEventLimits.planEntries) },
      { type: "plan.updated", runId: "run-one", sequence: 1, at, entries: entries(harnessEventLimits.planEntries + 1) }],
    ["tool.call title at diagnosticBytes", { type: "tool.call", runId: "run-one", sequence: 1, at, toolCallId: "tool-1", status: "in-progress", kind: "edit", title: diagnosticLimit },
      { type: "tool.call", runId: "run-one", sequence: 1, at, toolCallId: "tool-1", status: "in-progress", kind: "edit", title: diagnosticOver }],
    ["tool.call detail at textBytes", { type: "tool.call", runId: "run-one", sequence: 1, at, toolCallId: "tool-1", status: "in-progress", kind: "edit", title: "Edit", detail: textLimit },
      { type: "tool.call", runId: "run-one", sequence: 1, at, toolCallId: "tool-1", status: "in-progress", kind: "edit", title: "Edit", detail: textOver }],
    ["diff newText at diffBytes", { type: "diff", runId: "run-one", sequence: 1, at, path: "src/parser.ts", newText: diffLimit },
      { type: "diff", runId: "run-one", sequence: 1, at, path: "src/parser.ts", newText: diffOver }],
    ["diff oldText at diffBytes", { type: "diff", runId: "run-one", sequence: 1, at, path: "src/parser.ts", oldText: diffLimit, newText: "+new" },
      { type: "diff", runId: "run-one", sequence: 1, at, path: "src/parser.ts", oldText: diffOver, newText: "+new" }],
    ["terminal.output text at textBytes", { type: "terminal.output", runId: "run-one", sequence: 1, at, terminalId: "terminal-1", stream: "stdout", text: textLimit },
      { type: "terminal.output", runId: "run-one", sequence: 1, at, terminalId: "terminal-1", stream: "stdout", text: textOver }],
    ["terminalId at identifierBytes", { type: "terminal.output", runId: "run-one", sequence: 1, at, terminalId: identifierLimit, stream: "stdout", text: "line" },
      { type: "terminal.output", runId: "run-one", sequence: 1, at, terminalId: identifierOver, stream: "stdout", text: "line" }],
    ["permission.requested title at diagnosticBytes", { type: "permission.requested", runId: "run-one", sequence: 1, at, approvalId: "approval-one", title: diagnosticLimit, options: [option(0)] },
      { type: "permission.requested", runId: "run-one", sequence: 1, at, approvalId: "approval-one", title: diagnosticOver, options: [option(0)] }],
    ["permission.requested options at approvalOptions", { type: "permission.requested", runId: "run-one", sequence: 1, at, approvalId: "approval-one", title: "Run tests", options: Array.from({ length: harnessEventLimits.approvalOptions }, (_, index) => option(index)) },
      { type: "permission.requested", runId: "run-one", sequence: 1, at, approvalId: "approval-one", title: "Run tests", options: Array.from({ length: harnessEventLimits.approvalOptions + 1 }, (_, index) => option(index)) }],
    ["permission.requested option label at diagnosticBytes", { type: "permission.requested", runId: "run-one", sequence: 1, at, approvalId: "approval-one", title: "Run tests", options: [{ id: "allow-once", label: diagnosticLimit, kind: "allow-once" }] },
      { type: "permission.requested", runId: "run-one", sequence: 1, at, approvalId: "approval-one", title: "Run tests", options: [{ id: "allow-once", label: diagnosticOver, kind: "allow-once" }] }],
    ["permission.resolved approvalId at identifierBytes", { type: "permission.resolved", runId: "run-one", sequence: 1, at, approvalId: identifierLimit, status: "approved", selectedOptionId: "allow-once" },
      { type: "permission.resolved", runId: "run-one", sequence: 1, at, approvalId: identifierOver, status: "approved", selectedOptionId: "allow-once" }],
    ["warning message at diagnosticBytes", { type: "warning", runId: "run-one", sequence: 1, at, code: "E_SLOW", message: diagnosticLimit },
      { type: "warning", runId: "run-one", sequence: 1, at, code: "E_SLOW", message: diagnosticOver }],
    ["unknown sourceType at identifierBytes", { type: "unknown", runId: "run-one", sequence: 1, at, sourceType: identifierLimit, detail: "ignored" },
      { type: "unknown", runId: "run-one", sequence: 1, at, sourceType: identifierOver, detail: "ignored" }],
    ["unknown detail at diagnosticBytes", { type: "unknown", runId: "run-one", sequence: 1, at, sourceType: "provider_update", detail: diagnosticLimit },
      { type: "unknown", runId: "run-one", sequence: 1, at, sourceType: "provider_update", detail: diagnosticOver }],
    ["runId at identifierBytes", boundedEvent({ runId: identifierLimit }), boundedEvent({ runId: identifierOver })]
  ];

  for (const [label, atLimit, overLimit] of boundaries) {
    const accepted = validateHarnessEvent(atLimit);
    assert.equal(accepted.ok, true, `${label} must be accepted: ${accepted.ok ? "" : accepted.reason}`);
    assert.equal(validateHarnessEvent(overLimit).ok, false, `${label} plus one byte must be rejected`);
  }
});

test("text bounds are counted in bytes, not characters", () => {
  const exactlyTextBytes = "é".repeat(harnessEventLimits.textBytes / 2);
  assert.equal(byteLength(exactlyTextBytes), harnessEventLimits.textBytes);
  const accepted = validateHarnessEvent(boundedEvent({ text: exactlyTextBytes }));
  assert.equal(accepted.ok, true, `multi-byte text of exactly textBytes must be accepted: ${accepted.ok ? "" : accepted.reason}`);

  const oneByteOver = "é".repeat(harnessEventLimits.textBytes / 2) + "a";
  assert.equal(validateHarnessEvent(boundedEvent({ text: oneByteOver })).ok, false, "textBytes plus one byte must be rejected");
  const twoBytesOver = "é".repeat(harnessEventLimits.textBytes / 2 + 1);
  assert.equal(validateHarnessEvent(boundedEvent({ text: twoBytesOver })).ok, false, "multi-byte text past textBytes must be rejected");
});
