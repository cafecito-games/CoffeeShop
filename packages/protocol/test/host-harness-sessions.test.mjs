import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import * as protocol from "../dist/index.js";

const at = "2026-09-30T12:00:00Z";
const later = "2026-09-30T12:01:00Z";
const digestPlaceholder = "0".repeat(64);

const observation = (overrides = {}) => ({
  hostHarnessSessionId: "host-session-one",
  nodeId: "node-one",
  harnessId: "codex-cli",
  providerSessionId: "provider-session-one",
  workspace: "/workspaces/coffee-shop",
  source: "provider-history",
  status: "idle",
  controlMode: "full",
  operations: ["attach", "close", "read-history", "start-turn"],
  revision: 1,
  summary: "Existing provider conversation",
  createdAt: at,
  updatedAt: at,
  ...overrides
});

const projectedSession = (overrides = {}) => ({
  ...observation(),
  attachedThreadId: "thread-one",
  activeRunId: "run-one",
  attachmentEpoch: 3,
  ...overrides
});

const seal = (command) => {
  const result = protocol.hostHarnessSessionCommandDigest(command);
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  return { ...command, commandDigest: result.value };
};

const existingCommand = (type, fields = {}) => seal({
  type,
  nodeId: "node-one",
  commandId: `command-${type}`,
  hostHarnessSessionId: "host-session-one",
  attachmentEpoch: 3,
  ...fields
});

test("protocol v6 and every host-session vocabulary are closed", () => {
  assert.deepEqual(protocol.controlProtocolVersions, ["1", "2", "3", "4", "5", "6"]);
  assert.equal(protocol.latestControlProtocolVersion, "6");
  assert.equal(protocol.supportsControlCapability("5", "interactive-sessions"), false);
  assert.equal(protocol.supportsControlCapability("6", "interactive-sessions"), true);

  const vocabularies = [
    [protocol.hostHarnessSessionSources, protocol.isHostHarnessSessionSource,
      ["coffee-shop-managed", "provider-history", "external-live"]],
    [protocol.hostHarnessSessionStatuses, protocol.isHostHarnessSessionStatus,
      ["idle", "running", "awaiting-approval", "active-elsewhere", "offline", "closed", "failed"]],
    [protocol.hostHarnessSessionControlModes, protocol.isHostHarnessSessionControlMode,
      ["observe", "resume", "full"]],
    [protocol.hostHarnessSessionOperations, protocol.isHostHarnessSessionOperation,
      ["read-history", "attach", "detach", "start-turn", "steer", "interrupt", "resolve-approval", "close"]],
    [protocol.hostHarnessDriverOperations, protocol.isHostHarnessDriverOperation,
      ["discover", "create", "adopt"]],
    [protocol.hostHarnessSessionCommandOperations, protocol.isHostHarnessSessionCommandOperation,
      ["create", "adopt", "attach", "detach", "start-turn", "steer", "interrupt", "resolve-approval", "close"]],
    [protocol.hostHarnessSessionCommandDispositions, protocol.isHostHarnessSessionCommandDisposition,
      ["recorded", "replayed"]],
    [protocol.hostHarnessSessionCommandOutcomes, protocol.isHostHarnessSessionCommandOutcome,
      ["succeeded", "rejected", "uncertain"]],
    [protocol.hostHarnessSessionHistoryKinds, protocol.isHostHarnessSessionHistoryKind,
      ["user", "assistant", "system", "summary"]]
  ];
  for (const [values, guard, expected] of vocabularies) {
    assert.deepEqual(values, expected);
    for (const value of values) assert.equal(guard(value), true, value);
    for (const value of ["unknown", "", 1, null]) assert.equal(guard(value), false, JSON.stringify(value));
  }
});

test("host-session limits and legal transitions match the language-neutral contract", () => {
  assert.deepEqual(protocol.hostHarnessSessionLimits, {
    identifierBytes: 256,
    workspaceBytes: 4096,
    diagnosticBytes: 2000,
    promptBytes: 65536,
    operationCapabilities: 16,
    sessionsPerInventoryPage: 64,
    pagesPerGeneration: 64,
    sessionsPerGeneration: 4096,
    historyItemsPerPage: 100,
    historyItemTextBytes: 32768,
    historyCursorBytes: 512
  });
  const expected = {
    idle: ["running", "active-elsewhere", "offline", "closed", "failed"],
    running: ["awaiting-approval", "idle", "active-elsewhere", "offline", "closed", "failed"],
    "awaiting-approval": ["running", "idle", "active-elsewhere", "offline", "closed", "failed"],
    "active-elsewhere": ["idle", "offline", "closed", "failed"],
    offline: ["idle", "running", "awaiting-approval", "active-elsewhere", "closed", "failed"],
    closed: [],
    failed: []
  };
  assert.deepEqual(protocol.hostHarnessSessionTransitions, expected);
  for (const from of protocol.hostHarnessSessionStatuses) {
    for (const to of protocol.hostHarnessSessionStatuses) {
      assert.equal(protocol.canTransitionHostHarnessSession(from, to), expected[from].includes(to), `${from} -> ${to}`);
    }
  }
});

test("interactive harness profiles and observations are strict, bounded, and secret-screened", () => {
  assert.equal(protocol.validateHostHarnessSessionInteractiveProfile({ operations: ["adopt", "create", "discover"] }).ok, true);
  for (const invalid of [
    { operations: ["discover", "create"] },
    { operations: ["discover", "discover"] },
    { operations: ["discover"], extra: true },
    { operations: ["teleport"] },
    { operations: Array.from({ length: 17 }, (_, index) => `operation-${index}`) }
  ]) assert.equal(protocol.validateHostHarnessSessionInteractiveProfile(invalid).ok, false, JSON.stringify(invalid));

  assert.equal(protocol.validateHostHarnessSessionObservation(observation()).ok, true);
  assert.equal(protocol.validateHostHarnessSession(projectedSession()).ok, true);
  const identifierOver = "é".repeat(128) + "a";
  const diagnosticOver = "é".repeat(1000) + "a";
  const invalidObservations = [
    { ...observation(), extra: true },
    { ...observation(), hostHarnessSessionId: "" },
    { ...observation(), hostHarnessSessionId: identifierOver },
    { ...observation(), providerSessionId: "sk-live_123456789012345" },
    { ...observation(), workspace: "relative/path" },
    { ...observation(), workspace: "/workspaces/../secret" },
    { ...observation(), operations: ["close", "attach"] },
    { ...observation(), operations: ["attach", "attach"] },
    { ...observation(), revision: 0 },
    { ...observation(), revision: 1.5 },
    { ...observation(), summary: diagnosticOver },
    { ...observation(), updatedAt: "yesterday" }
  ];
  for (const invalid of invalidObservations) {
    assert.equal(protocol.validateHostHarnessSessionObservation(invalid).ok, false, JSON.stringify(invalid).slice(0, 160));
  }
  for (const invalid of [
    { ...projectedSession(), attachmentEpoch: -1 },
    { ...projectedSession(), attachedThreadId: "" },
    { ...projectedSession(), extra: true }
  ]) assert.equal(protocol.validateHostHarnessSession(invalid).ok, false);
});

test("observation revisions are idempotent only for identical payloads and terminal statuses stay terminal", () => {
  const first = observation();
  assert.equal(protocol.validateHostHarnessSessionObservationTransition(first, structuredClone(first)).ok, true);
  assert.equal(protocol.validateHostHarnessSessionObservationTransition(first, { ...first, summary: "changed" }).ok, false);
  assert.equal(protocol.validateHostHarnessSessionObservationTransition(first, { ...first, revision: 0 }).ok, false);
  assert.equal(protocol.validateHostHarnessSessionObservationTransition(first, {
    ...first, revision: 2, status: "running", updatedAt: later
  }).ok, true);
  assert.equal(protocol.validateHostHarnessSessionObservationTransition(first, {
    ...first, revision: 2, status: "awaiting-approval", updatedAt: later
  }).ok, false);
  for (const terminal of ["closed", "failed"]) {
    const previous = observation({ status: terminal, revision: 2, updatedAt: later });
    assert.equal(protocol.validateHostHarnessSessionObservationTransition(previous, {
      ...previous, revision: 3, status: "idle"
    }).ok, false);
  }
  assert.equal(protocol.validateHostHarnessSessionObservationTransition(first, {
    ...first, revision: 2, status: "running", providerSessionId: "other", updatedAt: later
  }).ok, false);
});

test("host-session runtime actors, thread orchestrators, and Runs are mutually exclusive", () => {
  assert.deepEqual(protocol.validateRuntimeActor({ kind: "host-session", hostHarnessSessionId: "host-session-one" }), {
    ok: true, value: { kind: "host-session", hostHarnessSessionId: "host-session-one" }
  });
  assert.equal(protocol.validateThreadOrchestrator({ kind: "host-session", hostHarnessSessionId: "host-session-one" }).ok, true);
  for (const value of [
    { kind: "host-session" },
    { kind: "host-session", hostHarnessSessionId: "host-session-one", agentId: "agent-one" },
    { kind: "agent", agentId: "agent-one", hostHarnessSessionId: "host-session-one" }
  ]) {
    assert.equal(protocol.validateRuntimeActor(value).ok, false);
    assert.equal(protocol.validateThreadOrchestrator(value).ok, false);
  }

  const run = {
    id: "run-one", threadId: "thread-one", hostHarnessSessionId: "host-session-one",
    nodeId: "node-one", harnessId: "codex-cli", model: "gpt-5", workspace: "/workspaces/coffee-shop",
    prompt: "Continue", status: "queued", output: "", depth: 0, createdAt: at
  };
  const thread = { kind: "host-session", hostHarnessSessionId: "host-session-one" };
  assert.equal(protocol.validateHostHarnessSessionRun(run, thread).ok, true);
  for (const invalid of [
    [{ ...run, threadId: undefined }, thread],
    [{ ...run, agentId: "agent-one" }, thread],
    [{ ...run, instanceId: "instance-one", allocationId: "allocation-one" }, thread],
    [{ ...run, hostHarnessSessionId: "other" }, thread],
    [run, { kind: "host-session", hostHarnessSessionId: "other" }],
    [{ ...run, providerTurnId: "x".repeat(257) }, thread]
  ]) assert.equal(protocol.validateHostHarnessSessionRun(...invalid).ok, false);
  for (const invalid of [
    { ...run, extra: true },
    { ...run, agentId: "agent-one" },
    { ...run, status: "queued", providerTurnId: "provider-turn-one" },
    { ...run, output: "Bearer abcdefghijklmnopqrstuvwxyz" }
  ]) assert.equal(protocol.validateHostHarnessSessionRun(invalid, thread).ok, false);

  const accepted = { ...run, status: "running", providerTurnId: "provider-turn-one", startedAt: later };
  assert.equal(protocol.validateHostHarnessSessionRunTransition(run, accepted, thread).ok, true);
  assert.equal(protocol.validateHostHarnessSessionRunTransition(accepted, {
    ...accepted, providerTurnId: "provider-turn-two"
  }, thread).ok, false);
  assert.equal(protocol.validateHostHarnessSessionRunTransition(accepted, {
    ...accepted, providerTurnId: undefined
  }, thread).ok, false);
});

test("every hub command has a strict v6-only shape and a verified canonical SHA-256 digest", () => {
  const commands = [
    seal({ type: "host-session.create", nodeId: "node-one", requestId: "request-create", commandId: "command-create", harnessId: "codex-cli", workspace: "/workspaces/coffee-shop", model: "gpt-5" }),
    seal({ type: "host-session.adopt", nodeId: "node-one", requestId: "request-adopt", commandId: "command-adopt", harnessId: "claude-cli", providerSessionId: "provider-session-two", workspace: "/workspaces/coffee-shop" }),
    existingCommand("host-session.attach", { threadId: "thread-one", expectedStatus: "idle" }),
    existingCommand("host-session.detach", { threadId: "thread-one" }),
    existingCommand("host-session.history.read", { requestId: "request-history", limit: 100 }),
    existingCommand("host-session.turn.start", { runId: "run-one", prompt: "Continue the work" }),
    existingCommand("host-session.turn.steer", { runId: "run-one", providerTurnId: "provider-turn-one", text: "Focus on tests" }),
    existingCommand("host-session.turn.interrupt", { runId: "run-one", providerTurnId: "provider-turn-one" }),
    existingCommand("host-session.approval.decision", {
      runId: "run-one", providerTurnId: "provider-turn-one",
      decision: { approvalId: "approval-one", runId: "run-one", status: "approved", selectedOptionId: "allow-once" }
    }),
    existingCommand("host-session.close")
  ];
  assert.deepEqual(commands.map((message) => message.type), protocol.hostSessionHubMessageTypes);
  for (const command of commands) {
    const accepted = protocol.validateHostSessionHubMessage(command, "6");
    assert.equal(accepted.ok, true, `${command.type}: ${accepted.ok ? "" : accepted.reason}`);
    assert.equal(protocol.canSendToControlAgent(command, "6"), true, command.type);
    assert.equal(protocol.requiredCapabilityForHubMessage(command), "interactive-sessions");
    for (const version of ["1", "2", "3", "4", "5"]) {
      assert.equal(protocol.validateHostSessionHubMessage(command, version).ok, false, `${command.type}/${version}`);
      assert.equal(protocol.canSendToControlAgent(command, version), false, `${command.type}/${version}`);
    }
    assert.match(command.commandDigest, /^[0-9a-f]{64}$/);
    const digestInput = protocol.hostHarnessSessionCommandDigestInput(command);
    assert.equal(digestInput.ok, true);
    assert.equal(command.commandDigest, createHash("sha256").update(digestInput.value).digest("hex"));
    assert.equal(protocol.validateHostSessionHubMessage({ ...command, commandDigest: digestPlaceholder }, "6").ok, false);
    assert.equal(protocol.validateHostSessionHubMessage({ ...command, extra: true }, "6").ok, false);
  }
  const emptyPrompt = existingCommand("host-session.turn.start", { runId: "run-one", prompt: "" });
  assert.equal(protocol.validateHostSessionHubMessage(emptyPrompt, "6").ok, true);

  const unicodeDigestCases = [
    ["line\u2028separator", "8eee57d3f1a2c21da8f8bf30d833a7d3e74110e01fb979f5c59e8b089927fe0f"],
    ["line\\u2028separator", "cb9994acf757e1a376e7b24828e57f0b7afc7331b88c1a9b7253ee65e3bd1a4f"],
    ["paragraph\u2029separator", "c32a072210d400027e93fe2b25b4be0ce49e24577c142f28d1d0e48ffb6dcc33"],
    ["paragraph\\u2029separator", "dabc9357b0e28eb38e4d60140696623f83dd59051756c1b4b02102faba2c32f9"],
    ["line\\" + String.fromCodePoint(0x2028) + "separator", "1533b0a298ab90d535428bbb9bd2cda81363b56f95717ad76d6de2ca5c457822"]
  ];
  for (const [prompt, expected] of unicodeDigestCases) {
    const digest = protocol.hostHarnessSessionCommandDigest({
      type: "host-session.turn.start", nodeId: "node-one", commandId: "command-unicode",
      hostHarnessSessionId: "host-session-one", attachmentEpoch: 3, runId: "run-one", prompt
    });
    assert.deepEqual(digest, { ok: true, value: expected });
  }
  assert.notEqual(unicodeDigestCases[0][1], unicodeDigestCases[1][1], "a literal escape is distinct from a line separator");
  assert.notEqual(unicodeDigestCases[2][1], unicodeDigestCases[3][1], "a literal escape is distinct from a paragraph separator");
  assert.notEqual(unicodeDigestCases[1][1], unicodeDigestCases[4][1], "a literal escape is distinct from backslash plus a line separator");
});

test("Barista frames are strict, v6-only, and preserve request/session/epoch domains", () => {
  const event = { type: "message.delta", runId: "run-one", sequence: 1, at, text: "hello" };
  const messages = [
    { type: "host-session.inventory.page", nodeId: "node-one", generation: 4, pageIndex: 0, sessions: [observation()], at },
    { type: "host-session.inventory.complete", nodeId: "node-one", generation: 4, pageCount: 1, sessionCount: 1, at },
    { type: "host-session.update", nodeId: "node-one", session: observation({ revision: 2, status: "running", updatedAt: later }), at: later },
    { type: "host-session.history.page", nodeId: "node-one", hostHarnessSessionId: "host-session-one", requestId: "request-history",
      items: [{ id: "history-one", kind: "assistant", text: "Prior answer", providerTurnId: "provider-turn-zero", at, truncated: false }],
      nextCursor: "cursor-two", truncated: true, at },
    { type: "host-session.harness-event", nodeId: "node-one", hostHarnessSessionId: "host-session-one",
      attachmentEpoch: 3, providerTurnId: "provider-turn-one", event },
    { type: "host-session.command.ack", nodeId: "node-one", operation: "start-turn", commandId: "command-host-session.turn.start",
      commandDigest: "a".repeat(64), hostHarnessSessionId: "host-session-one", attachmentEpoch: 3, disposition: "recorded", at },
    { type: "host-session.command.result", nodeId: "node-one", operation: "start-turn", commandId: "command-host-session.turn.start",
      commandDigest: "a".repeat(64), hostHarnessSessionId: "host-session-one", attachmentEpoch: 3, outcome: "succeeded",
      providerTurnId: "provider-turn-one", session: observation({ revision: 2, status: "running", providerTurnId: "provider-turn-one", updatedAt: later }), at: later }
  ];
  assert.deepEqual(messages.map((message) => message.type), protocol.hostSessionControlMessageTypes);
  for (const message of messages) {
    const accepted = protocol.validateHostSessionControlMessage(message, "6");
    assert.equal(accepted.ok, true, `${message.type}: ${accepted.ok ? "" : accepted.reason}`);
    assert.equal(protocol.canAcceptFromControlAgent(message, "6"), true, message.type);
    assert.equal(protocol.requiredCapabilityForControlAgentMessage(message), "interactive-sessions");
    for (const version of ["1", "2", "3", "4", "5"]) {
      assert.equal(protocol.validateHostSessionControlMessage(message, version).ok, false, `${message.type}/${version}`);
      assert.equal(protocol.canAcceptFromControlAgent(message, version), false, `${message.type}/${version}`);
    }
    assert.equal(protocol.validateHostSessionControlMessage({ ...message, extra: true }, "6").ok, false);
  }
  assert.equal(protocol.validateHostSessionControlMessage({
    ...messages[4], event: { ...event, text: "Bearer abcdefghijklmnopqrstuvwxyz" }
  }, "6").ok, false);
});

test("complete inventory generations validate atomically across page replay, gaps, counts, and identity", () => {
  const page0 = { type: "host-session.inventory.page", nodeId: "node-one", generation: 4, pageIndex: 0,
    sessions: [observation()], at };
  const page1 = { type: "host-session.inventory.page", nodeId: "node-one", generation: 4, pageIndex: 1,
    sessions: [observation({
      hostHarnessSessionId: "host-session-two", providerSessionId: "provider-session-two",
      source: "external-live"
    })], at };
  const complete = { type: "host-session.inventory.complete", nodeId: "node-one", generation: 4,
    pageCount: 2, sessionCount: 2, at };
  const assembled = protocol.validateHostHarnessSessionInventoryGeneration([page1, page0, structuredClone(page0)], complete);
  assert.equal(assembled.ok, true, assembled.ok ? "" : assembled.reason);
  assert.deepEqual(assembled.value.sessions.map((session) => session.hostHarnessSessionId), ["host-session-one", "host-session-two"]);

  const invalid = [
    [[page0], complete],
    [[page0, { ...page1, pageIndex: 2 }], complete],
    [[page0, { ...page1, nodeId: "node-two" }], complete],
    [[page0, { ...page1, generation: 5 }], complete],
    [[page0, { ...page1, sessions: [observation({ hostHarnessSessionId: "host-session-one" })] }], complete],
    [[page0, { ...page1, sessions: [observation({ hostHarnessSessionId: "host-session-two" })] }], complete],
    [[page0, page1], { ...complete, sessionCount: 1 }],
    [[page0, page1], { ...complete, pageCount: 1 }],
    [[page0, { ...page0, sessions: [] }], complete]
  ];
  for (const [pages, completion] of invalid) {
    assert.equal(protocol.validateHostHarnessSessionInventoryGeneration(pages, completion).ok, false);
  }
  assert.equal(protocol.validateHostHarnessSessionInventoryGeneration([page0], undefined).ok, false, "pages alone never commit");

  const previous = assembled.value;
  assert.equal(protocol.validateHostHarnessSessionInventoryTransition(previous, structuredClone(previous)).ok, true);
  assert.equal(protocol.validateHostHarnessSessionInventoryTransition(previous, { ...previous, generation: 3 }).ok, false);
  assert.equal(protocol.validateHostHarnessSessionInventoryTransition(previous, {
    ...previous, sessions: [observation({ summary: "changed" }), previous.sessions[1]]
  }).ok, false);
  const nextPage = { ...page0, generation: 5, sessions: [observation({ revision: 2, status: "running", updatedAt: later })], at: later };
  const nextComplete = { ...complete, generation: 5, pageCount: 1, sessionCount: 1, at: later };
  const next = protocol.validateHostHarnessSessionInventoryGeneration([nextPage], nextComplete);
  assert.equal(next.ok, true);
  assert.equal(protocol.validateHostHarnessSessionInventoryTransition(previous, next.value).ok, true);
  const gapPage = { ...nextPage, generation: 6 };
  const gapComplete = { ...nextComplete, generation: 6 };
  const gap = protocol.validateHostHarnessSessionInventoryGeneration([gapPage], gapComplete);
  assert.equal(gap.ok, true);
  assert.equal(protocol.validateHostHarnessSessionInventoryTransition(previous, gap.value).ok, false);
});

test("inventory and history collection limits accept the exact boundary and reject one over", () => {
  const sessions = Array.from({ length: protocol.hostHarnessSessionLimits.sessionsPerGeneration }, (_, index) => observation({
    hostHarnessSessionId: `host-session-${index.toString().padStart(4, "0")}`,
    providerSessionId: `provider-session-${index.toString().padStart(4, "0")}`
  }));
  const pages = Array.from({ length: protocol.hostHarnessSessionLimits.pagesPerGeneration }, (_, pageIndex) => ({
    type: "host-session.inventory.page", nodeId: "node-one", generation: 8, pageIndex,
    sessions: sessions.slice(pageIndex * protocol.hostHarnessSessionLimits.sessionsPerInventoryPage,
      (pageIndex + 1) * protocol.hostHarnessSessionLimits.sessionsPerInventoryPage), at
  }));
  const complete = {
    type: "host-session.inventory.complete", nodeId: "node-one", generation: 8,
    pageCount: protocol.hostHarnessSessionLimits.pagesPerGeneration,
    sessionCount: protocol.hostHarnessSessionLimits.sessionsPerGeneration, at
  };
  assert.equal(protocol.validateHostSessionControlMessage(pages.at(-1), "6").ok, true);
  assert.equal(protocol.validateHostSessionControlMessage(complete, "6").ok, true);
  const assembled = protocol.validateHostHarnessSessionInventoryGeneration(pages, complete);
  assert.equal(assembled.ok, true, assembled.ok ? "" : assembled.reason);
  assert.equal(assembled.value.sessions.length, protocol.hostHarnessSessionLimits.sessionsPerGeneration);

  const pageOver = { ...pages[0], sessions: sessions.slice(0, protocol.hostHarnessSessionLimits.sessionsPerInventoryPage + 1) };
  assert.equal(protocol.validateHostSessionControlMessage(pageOver, "6").ok, false);
  assert.equal(protocol.validateHostSessionControlMessage({ ...pages[0], pageIndex: protocol.hostHarnessSessionLimits.pagesPerGeneration }, "6").ok, false);
  assert.equal(protocol.validateHostSessionControlMessage({ ...complete, pageCount: protocol.hostHarnessSessionLimits.pagesPerGeneration + 1 }, "6").ok, false);
  assert.equal(protocol.validateHostSessionControlMessage({ ...complete, sessionCount: protocol.hostHarnessSessionLimits.sessionsPerGeneration + 1 }, "6").ok, false);

  const items = Array.from({ length: protocol.hostHarnessSessionLimits.historyItemsPerPage }, (_, index) => ({
    id: `history-${index}`, kind: "assistant", text: "bounded", truncated: false
  }));
  const history = { type: "host-session.history.page", nodeId: "node-one", hostHarnessSessionId: "host-session-one",
    requestId: "request-history", items, truncated: false, at };
  assert.equal(protocol.validateHostSessionControlMessage(history, "6").ok, true);
  assert.equal(protocol.validateHostSessionControlMessage({
    ...history, items: [...items, { id: "history-over", kind: "assistant", text: "bounded", truncated: false }]
  }, "6").ok, false);
});

test("command replay and responses keep command, request, session, digest, and epoch correlation independent", () => {
  const command = existingCommand("host-session.turn.start", { runId: "run-one", prompt: "Continue" });
  assert.equal(protocol.classifyHostHarnessSessionCommandReplay(undefined, command), "new");
  assert.equal(protocol.classifyHostHarnessSessionCommandReplay(command, structuredClone(command)), "replay");
  const changed = existingCommand("host-session.turn.start", { commandId: command.commandId, runId: "run-one", prompt: "Different" });
  assert.equal(protocol.classifyHostHarnessSessionCommandReplay(command, changed), "conflict");
  const differentCommand = existingCommand("host-session.turn.start", {
    commandId: "command-other", runId: "run-one", prompt: "Continue"
  });
  assert.equal(protocol.classifyHostHarnessSessionCommandReplay(command, differentCommand), "conflict",
    "a lookup collision on a different command ID must fail closed");

  const ack = { type: "host-session.command.ack", nodeId: command.nodeId, operation: "start-turn",
    commandId: command.commandId, commandDigest: command.commandDigest, hostHarnessSessionId: command.hostHarnessSessionId,
    attachmentEpoch: command.attachmentEpoch, disposition: "recorded", at };
  const result = { type: "host-session.command.result", nodeId: command.nodeId, operation: "start-turn",
    commandId: command.commandId, commandDigest: command.commandDigest, hostHarnessSessionId: command.hostHarnessSessionId,
    attachmentEpoch: command.attachmentEpoch, outcome: "succeeded", providerTurnId: "provider-turn-one", at: later };
  assert.equal(protocol.validateHostHarnessSessionCommandResponse(command, ack).ok, true);
  assert.equal(protocol.validateHostHarnessSessionCommandResponse(command, result).ok, true);
  for (const mismatch of [
    { ...ack, nodeId: "node-two" },
    { ...ack, operation: "steer" },
    { ...ack, commandId: "other" },
    { ...ack, commandDigest: "b".repeat(64) },
    { ...ack, hostHarnessSessionId: "other" },
    { ...ack, attachmentEpoch: 4 }
  ]) assert.equal(protocol.validateHostHarnessSessionCommandResponse(command, mismatch).ok, false);

  const create = seal({ type: "host-session.create", nodeId: "node-one", requestId: "request-create",
    commandId: "command-create", harnessId: "codex-cli", workspace: "/workspaces/coffee-shop" });
  const created = { type: "host-session.command.result", nodeId: "node-one", operation: "create",
    commandId: create.commandId, commandDigest: create.commandDigest, requestId: create.requestId, outcome: "succeeded",
    session: observation({ source: "coffee-shop-managed" }), at: later };
  assert.equal(protocol.validateHostHarnessSessionCommandResponse(create, created).ok, true);
  assert.equal(protocol.validateHostHarnessSessionCommandResponse(create, { ...created, requestId: "other" }).ok, false);
  assert.equal(protocol.validateHostHarnessSessionCommandResponse(create, {
    ...created, session: observation({ workspace: "/workspaces/other", source: "coffee-shop-managed" })
  }).ok, false);

  const history = existingCommand("host-session.history.read", { requestId: "request-history", limit: 50 });
  const historyPage = { type: "host-session.history.page", nodeId: "node-one", hostHarnessSessionId: "host-session-one",
    requestId: "request-history", items: [], truncated: false, at };
  assert.equal(protocol.validateHostHarnessSessionCommandResponse(history, historyPage).ok, true);
  assert.equal(protocol.validateHostHarnessSessionCommandResponse(history, { ...historyPage, requestId: "other" }).ok, false);
});

test("event correlation rejects foreign, queued, terminal, stale-epoch, and mismatched provider-turn Runs", () => {
  const session = projectedSession({ status: "running", providerTurnId: "provider-turn-one" });
  const run = {
    id: "run-one", threadId: "thread-one", hostHarnessSessionId: "host-session-one", providerTurnId: "provider-turn-one",
    nodeId: "node-one", harnessId: "codex-cli", model: "gpt-5", workspace: "/workspaces/coffee-shop",
    prompt: "Continue", status: "running", output: "", depth: 0, createdAt: at
  };
  const message = { type: "host-session.harness-event", nodeId: "node-one", hostHarnessSessionId: "host-session-one",
    attachmentEpoch: 3, providerTurnId: "provider-turn-one",
    event: { type: "message.delta", runId: "run-one", sequence: 1, at, text: "hello" } };
  assert.equal(protocol.validateHostHarnessSessionEventCorrelation(message, session, run).ok, true);
  for (const [candidateMessage, candidateSession, candidateRun] of [
    [{ ...message, nodeId: "node-two" }, session, run],
    [{ ...message, attachmentEpoch: 2 }, session, run],
    [{ ...message, providerTurnId: "other" }, session, run],
    [message, { ...session, activeRunId: "other" }, run],
    [message, session, { ...run, id: "other" }],
    [message, session, { ...run, status: "queued" }],
    [message, session, { ...run, status: "completed" }],
    [message, session, { ...run, threadId: "other" }],
    [message, session, { ...run, workspace: "/workspaces/other" }]
  ]) assert.equal(protocol.validateHostHarnessSessionEventCorrelation(candidateMessage, candidateSession, candidateRun).ok, false);
});

test("interactive-session registration is admitted only on v6 with sorted driver operations", () => {
  const registration = {
    type: "register", protocolVersion: "6",
    node: {
      id: "node-one", name: "Local", kind: "local", platform: "linux", status: "online", lastSeen: at,
      activeRuns: 0, concurrency: 1, instanceCapacity: 1, activeInstances: 0,
      workspaceRoots: ["/workspaces"], version: "0.1.0",
      harnesses: [{ id: "codex-cli", label: "Codex", description: "Local Codex", available: true,
        authMode: "local-subscription", models: ["gpt-5"], interactiveSessions: { operations: ["adopt", "create", "discover"] } }]
    }
  };
  assert.equal(protocol.validateHostSessionRegistration(registration, "6").ok, true);
  assert.equal(protocol.canAcceptFromControlAgent(registration, "6"), true);
  assert.equal(protocol.canAcceptFromControlAgent({ ...registration, protocolVersion: "5" }, "5"), false);
  const malformed = structuredClone(registration);
  malformed.node.harnesses[0].interactiveSessions.operations = ["discover", "create"];
  assert.equal(protocol.canAcceptFromControlAgent(malformed, "6"), false);
});

test("the shared pre-v6 snapshot migration defaults only an absent host-session collection", () => {
  // This fixture is byte-for-byte Store output from the producer cited in apps/hub/src/store.test.ts:342.
  const legacy = JSON.parse(readFileSync(new URL("../../../apps/hub/test-fixtures/state-before-external-orchestrators.json", import.meta.url), "utf8"));
  const before = structuredClone(legacy);
  const migrated = protocol.withHostHarnessSessionDefaults(legacy);
  assert.deepEqual(migrated.hostHarnessSessions, []);
  delete migrated.hostHarnessSessions;
  assert.deepEqual(migrated, before, "migration must not synthesize or reclassify existing records");

  const existing = [projectedSession()];
  const current = protocol.withHostHarnessSessionDefaults({ ...structuredClone(before), hostHarnessSessions: existing });
  assert.equal(current.hostHarnessSessions, existing, "a valid present collection keeps its identity and contents");
  assert.throws(() => protocol.withHostHarnessSessionDefaults({ ...structuredClone(before), hostHarnessSessions: null }));
  assert.throws(() => protocol.withHostHarnessSessionDefaults({
    ...structuredClone(before), hostHarnessSessions: [{ ...projectedSession(), attachmentEpoch: -1 }]
  }));
  assert.throws(() => protocol.withHostHarnessSessionDefaults({
    ...structuredClone(before), hostHarnessSessions: [projectedSession(), projectedSession()]
  }), /duplicate/);
});

const fixtureDirectory = new URL("./fixtures/control-v6/", import.meta.url);
const readFixtureBytes = (name) => readFileSync(new URL(`${name}.json`, fixtureDirectory), "utf8");
const readFixture = (name) => JSON.parse(readFixtureBytes(name));
const hubFixtureNames = ["create", "adopt", "attach", "detach", "history-read", "turn-start", "turn-steer", "turn-interrupt", "approval-decision", "close"];
const controlFixtureNames = ["inventory-page", "inventory-complete", "update", "history-page", "harness-event", "command-ack", "command-result-start", "command-result-create", "command-result-close"];

test("checked-in v6 fixtures are exact language-neutral producer bytes", () => {
  for (const name of hubFixtureNames) {
    const bytes = readFixtureBytes(name);
    const fixture = JSON.parse(bytes);
    const valid = protocol.validateHostSessionHubMessage(fixture, "6");
    assert.equal(valid.ok, true, `${name}: ${valid.ok ? "" : valid.reason}`);
    assert.equal(JSON.stringify(valid.value, null, 2) + "\n", bytes, `${name} bytes`);
  }
  for (const name of controlFixtureNames) {
    const bytes = readFixtureBytes(name);
    const fixture = JSON.parse(bytes);
    const valid = protocol.validateHostSessionControlMessage(fixture, "6");
    assert.equal(valid.ok, true, `${name}: ${valid.ok ? "" : valid.reason}`);
    assert.equal(JSON.stringify(valid.value, null, 2) + "\n", bytes, `${name} bytes`);
  }
  const profileBytes = readFixtureBytes("interactive-profile");
  const profile = protocol.validateHostHarnessSessionInteractiveProfile(JSON.parse(profileBytes));
  assert.equal(profile.ok, true);
  assert.equal(JSON.stringify(profile.value, null, 2) + "\n", profileBytes);

  const vocabularyBytes = readFixtureBytes("vocabulary");
  const vocabulary = {
    controlProtocolVersions: protocol.controlProtocolVersions,
    hostHarnessSessionSources: protocol.hostHarnessSessionSources,
    hostHarnessSessionStatuses: protocol.hostHarnessSessionStatuses,
    hostHarnessSessionControlModes: protocol.hostHarnessSessionControlModes,
    hostHarnessSessionOperations: protocol.hostHarnessSessionOperations,
    hostHarnessDriverOperations: protocol.hostHarnessDriverOperations,
    hostHarnessSessionCommandOperations: protocol.hostHarnessSessionCommandOperations,
    hostHarnessSessionCommandDispositions: protocol.hostHarnessSessionCommandDispositions,
    hostHarnessSessionCommandOutcomes: protocol.hostHarnessSessionCommandOutcomes,
    hostHarnessSessionHistoryKinds: protocol.hostHarnessSessionHistoryKinds,
    runtimeActorKinds: protocol.runtimeActorKinds,
    threadOrchestratorKinds: protocol.threadOrchestratorKinds,
    hostSessionHubMessageTypes: protocol.hostSessionHubMessageTypes,
    hostSessionControlMessageTypes: protocol.hostSessionControlMessageTypes,
    hostHarnessSessionTransitions: protocol.hostHarnessSessionTransitions,
    hostHarnessSessionLimits: protocol.hostHarnessSessionLimits
  };
  assert.equal(JSON.stringify(vocabulary, null, 2) + "\n", vocabularyBytes);

  const actorBytes = readFixtureBytes("runtime-actor");
  const actor = protocol.validateRuntimeActor(JSON.parse(actorBytes));
  assert.equal(actor.ok, true);
  assert.equal(JSON.stringify(actor.value, null, 2) + "\n", actorBytes);
  const orchestratorBytes = readFixtureBytes("thread-orchestrator");
  const orchestrator = protocol.validateThreadOrchestrator(JSON.parse(orchestratorBytes));
  assert.equal(orchestrator.ok, true);
  assert.equal(JSON.stringify(orchestrator.value, null, 2) + "\n", orchestratorBytes);
  const runBytes = readFixtureBytes("runtime-run");
  const run = protocol.validateHostHarnessSessionRun(JSON.parse(runBytes), orchestrator.value);
  assert.equal(run.ok, true);
  assert.equal(JSON.stringify(run.value, null, 2) + "\n", runBytes);
});

test("v1-v5 compatibility fixture bytes remain immutable", () => {
  const hashes = {
    "control-v4": "04911aa3dc42465902e6a7b08d77e9f0d48cfa28f8d6415175ef5004c4bc1c5b",
    "control-v5": "870333cefff5d85fcf4c538b7a91322500d338f80198ca0dfa8c1bce059021d8"
  };
  for (const [directory, expected] of Object.entries(hashes)) {
    const url = new URL(`./fixtures/${directory}/`, import.meta.url);
    const digest = createHash("sha256");
    for (const name of readdirSync(url).sort()) {
      digest.update(name);
      digest.update("\0");
      digest.update(readFileSync(new URL(name, url)));
    }
    assert.equal(digest.digest("hex"), expected, directory);
  }
});

test("every v6 fixture rejects missing, unknown, extra, oversized, and wrong-capability input", () => {
  for (const name of hubFixtureNames) {
    const fixture = readFixture(name);
    const missing = structuredClone(fixture);
    delete missing.nodeId;
    for (const invalid of [
      missing,
      { ...fixture, type: "host-session.teleport" },
      { ...fixture, extra: true },
      { ...fixture, commandId: "x".repeat(257) },
      { ...fixture, commandDigest: "A".repeat(64) }
    ]) assert.equal(protocol.validateHostSessionHubMessage(invalid, "6").ok, false, name);
    for (const version of ["1", "2", "3", "4", "5"]) {
      assert.equal(protocol.validateHostSessionHubMessage(fixture, version).ok, false, `${name}/${version}`);
    }
    if ("attachmentEpoch" in fixture) {
      assert.equal(protocol.validateHostSessionHubMessage({ ...fixture, attachmentEpoch: -1 }, "6").ok, false, `${name}/epoch`);
    }
  }
  for (const name of controlFixtureNames) {
    const fixture = readFixture(name);
    const missing = structuredClone(fixture);
    delete missing.nodeId;
    for (const invalid of [missing, { ...fixture, type: "host-session.teleport" }, { ...fixture, extra: true }]) {
      assert.equal(protocol.validateHostSessionControlMessage(invalid, "6").ok, false, name);
    }
    for (const version of ["1", "2", "3", "4", "5"]) {
      assert.equal(protocol.validateHostSessionControlMessage(fixture, version).ok, false, `${name}/${version}`);
    }
  }
});

test("unsupported, rejected, and uncertain close never manufacture a closed session", () => {
  const close = readFixture("close");
  const succeeded = readFixture("command-result-close");
  assert.equal(protocol.validateHostHarnessSessionCommandResponse(close, succeeded).ok, true);
  for (const outcome of ["rejected", "uncertain"]) {
    assert.equal(protocol.validateHostSessionControlMessage({ ...succeeded, outcome }, "6").ok, false, outcome);
  }
  const open = observation({ revision: 3, status: "offline", controlMode: "observe", operations: ["read-history"], updatedAt: later });
  assert.equal(protocol.validateHostSessionControlMessage({ ...succeeded, outcome: "uncertain", session: open }, "6").ok, true);
  assert.equal(protocol.canOperateHostHarnessSession(observation(), "close"), true);
  assert.equal(protocol.canOperateHostHarnessSession(observation({ operations: ["attach"] }), "close"), false);
  assert.equal(protocol.canOperateHostHarnessSession(observation({ status: "closed" }), "close"), false);
  assert.equal(protocol.canOperateHostHarnessSession(observation({ status: "failed" }), "close"), false);
});
