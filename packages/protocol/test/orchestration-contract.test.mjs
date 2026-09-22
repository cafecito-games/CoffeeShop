import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  approvalOptionKinds,
  approvalStatuses,
  canAcceptFromControlAgent,
  canSendToControlAgent,
  canTransitionApproval,
  canTransitionSessionBinding,
  canTransitionTask,
  canTransitionWorkspaceLease,
  controlProtocolCapabilities,
  controlProtocolVersions,
  dependencyOutcome,
  harnessEventLimits,
  harnessEventTypes,
  harnessTransports,
  isControlProtocolVersion,
  orchestrationCollections,
  planEntryPriorities,
  planEntryStatuses,
  placementRequirementKinds,
  sessionBindingStatuses,
  supportsControlCapability,
  taskDependencyPolicies,
  taskMessageKinds,
  taskStatuses,
  terminalApprovalStatuses,
  terminalSessionBindingStatuses,
  terminalTaskStatuses,
  terminalWorkspaceLeaseStatuses,
  toolCallKinds,
  toolCallStatuses,
  validateApprovalDecision,
  validateHarnessEvent,
  validateOrchestrationControlAgentMessage,
  validateSessionBindingUpdate,
  validateWorkspaceLeaseUpdate,
  withOrchestrationDefaults,
  workspaceLeaseStatuses,
  workspaceRetentionReasons
} from "../dist/index.js";

const at = "2026-09-21T12:00:00Z";
const versions = ["1", "2", "3", "4"];
const sendableVersions = (message) => versions.filter((version) => canSendToControlAgent(message, version));
const acceptableVersions = (message) => versions.filter((version) => canAcceptFromControlAgent(message, version));

const reachesTerminalStatus = (statuses, expectedTransitions, terminals) => (from) => {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift();
    if (terminals.includes(current)) return true;
    for (const next of expectedTransitions[current]) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return false;
};

test("orchestration vocabularies keep their exact contents and order", () => {
  assert.deepEqual(controlProtocolVersions, ["1", "2", "3", "4"]);
  assert.deepEqual(controlProtocolCapabilities, ["replay-barrier", "hub-rpc", "orchestration"]);
  assert.deepEqual(harnessTransports, ["native-cli", "acp-v1"]);
  assert.deepEqual(taskStatuses, ["pending", "ready", "assigned", "running", "completed", "failed", "cancelled", "blocked"]);
  assert.deepEqual(terminalTaskStatuses, ["completed", "failed", "cancelled", "blocked"]);
  assert.deepEqual(taskDependencyPolicies, ["require-success", "allow-failure"]);
  assert.deepEqual(placementRequirementKinds, [
    "skill",
    "harness",
    "model",
    "transport",
    "operating-system",
    "architecture",
    "label",
    "concurrency",
    "memory",
    "project-profile",
    "workspace",
    "node-offline",
    "inventory-stale",
    "agent",
    "capacity",
    "protocol-version",
    "assignment"
  ]);
  assert.deepEqual(taskMessageKinds, ["question", "answer", "instruction", "progress", "result", "note"]);
  assert.deepEqual(sessionBindingStatuses, ["active", "idle", "closed", "replaced", "failed"]);
  assert.deepEqual(terminalSessionBindingStatuses, ["closed", "replaced", "failed"]);
  assert.deepEqual(harnessEventTypes, [
    "message.delta",
    "thought.delta",
    "plan.updated",
    "tool.call",
    "diff",
    "terminal.output",
    "usage",
    "permission.requested",
    "permission.resolved",
    "warning",
    "unknown"
  ]);
  assert.deepEqual(planEntryStatuses, ["pending", "in-progress", "completed"]);
  assert.deepEqual(planEntryPriorities, ["high", "medium", "low"]);
  assert.deepEqual(toolCallStatuses, ["pending", "in-progress", "completed", "failed"]);
  assert.deepEqual(toolCallKinds, ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"]);
  assert.deepEqual(approvalStatuses, ["pending", "approved", "rejected", "cancelled", "expired"]);
  assert.deepEqual(terminalApprovalStatuses, ["approved", "rejected", "cancelled", "expired"]);
  assert.deepEqual(approvalOptionKinds, ["allow-once", "allow-always", "reject-once", "reject-always"]);
  assert.deepEqual(workspaceLeaseStatuses, ["requested", "provisioning", "active", "released", "cleaning", "retained", "cleaned", "failed"]);
  assert.deepEqual(terminalWorkspaceLeaseStatuses, ["cleaned", "failed"]);
  assert.deepEqual(workspaceRetentionReasons, ["dirty", "untracked", "diverged", "locked", "unregistered", "identity-mismatch", "ambiguous", "operator-hold", "policy"]);
  assert.deepEqual(orchestrationCollections, [
    "tasks",
    "taskMessages",
    "taskMessageAcknowledgements",
    "sessionBindings",
    "approvals",
    "workspaceLeases"
  ]);
});

test("task status transitions match the canonical table and always admit an exit", () => {
  const expectedTransitions = {
    pending: ["ready", "blocked", "cancelled"],
    ready: ["assigned", "cancelled"],
    assigned: ["running", "ready", "failed", "cancelled"],
    running: ["completed", "failed", "ready", "cancelled"],
    completed: [],
    failed: [],
    cancelled: [],
    blocked: []
  };
  for (const from of taskStatuses) {
    for (const to of taskStatuses) {
      assert.equal(canTransitionTask(from, to), expectedTransitions[from].includes(to), `task ${from} -> ${to}`);
    }
  }
  for (const terminal of terminalTaskStatuses) {
    for (const to of taskStatuses) assert.equal(canTransitionTask(terminal, to), false, `terminal task ${terminal} -> ${to}`);
  }
  const reachesTerminal = reachesTerminalStatus(taskStatuses, expectedTransitions, terminalTaskStatuses);
  for (const status of taskStatuses) {
    if (!terminalTaskStatuses.includes(status)) {
      assert.equal(reachesTerminal(status), true, `task ${status} must reach a terminal status`);
    }
  }
});

test("session binding transitions match the canonical table and always admit an exit", () => {
  const expectedTransitions = {
    active: ["idle", "closed", "replaced", "failed"],
    idle: ["active", "closed", "replaced", "failed"],
    closed: [],
    replaced: [],
    failed: []
  };
  for (const from of sessionBindingStatuses) {
    for (const to of sessionBindingStatuses) {
      assert.equal(canTransitionSessionBinding(from, to), expectedTransitions[from].includes(to), `binding ${from} -> ${to}`);
    }
  }
  for (const terminal of terminalSessionBindingStatuses) {
    for (const to of sessionBindingStatuses) assert.equal(canTransitionSessionBinding(terminal, to), false, `terminal binding ${terminal} -> ${to}`);
  }
  const reachesTerminal = reachesTerminalStatus(sessionBindingStatuses, expectedTransitions, terminalSessionBindingStatuses);
  for (const status of sessionBindingStatuses) {
    if (!terminalSessionBindingStatuses.includes(status)) {
      assert.equal(reachesTerminal(status), true, `binding ${status} must reach a terminal status`);
    }
  }
});

test("approval transitions only leave pending toward a terminal status", () => {
  const expectedTransitions = {
    pending: ["approved", "rejected", "cancelled", "expired"],
    approved: [],
    rejected: [],
    cancelled: [],
    expired: []
  };
  for (const from of approvalStatuses) {
    for (const to of approvalStatuses) {
      assert.equal(canTransitionApproval(from, to), expectedTransitions[from].includes(to), `approval ${from} -> ${to}`);
    }
  }
  for (const terminal of terminalApprovalStatuses) {
    for (const to of approvalStatuses) assert.equal(canTransitionApproval(terminal, to), false, `terminal approval ${terminal} -> ${to}`);
  }
  const reachesTerminal = reachesTerminalStatus(approvalStatuses, expectedTransitions, terminalApprovalStatuses);
  for (const status of approvalStatuses) {
    if (!terminalApprovalStatuses.includes(status)) {
      assert.equal(reachesTerminal(status), true, `approval ${status} must reach a terminal status`);
    }
  }
});

test("workspace lease transitions match the canonical table and always admit an exit", () => {
  const expectedTransitions = {
    requested: ["provisioning", "failed"],
    provisioning: ["active", "released", "retained", "failed"],
    active: ["released", "retained"],
    released: ["cleaning", "retained"],
    cleaning: ["cleaned", "retained", "failed"],
    retained: ["cleaning"],
    cleaned: [],
    failed: []
  };
  for (const from of workspaceLeaseStatuses) {
    for (const to of workspaceLeaseStatuses) {
      assert.equal(canTransitionWorkspaceLease(from, to), expectedTransitions[from].includes(to), `lease ${from} -> ${to}`);
    }
  }
  for (const terminal of terminalWorkspaceLeaseStatuses) {
    for (const to of workspaceLeaseStatuses) assert.equal(canTransitionWorkspaceLease(terminal, to), false, `terminal lease ${terminal} -> ${to}`);
  }
  const reachesTerminal = reachesTerminalStatus(workspaceLeaseStatuses, expectedTransitions, terminalWorkspaceLeaseStatuses);
  for (const status of workspaceLeaseStatuses) {
    if (!terminalWorkspaceLeaseStatuses.includes(status)) {
      assert.equal(reachesTerminal(status), true, `lease ${status} must reach a terminal status`);
    }
  }
});

test("dependency outcomes cover every policy for every task status", () => {
  const expectedOutcomes = {
    "require-success": {
      pending: "waiting",
      ready: "waiting",
      assigned: "waiting",
      running: "waiting",
      completed: "satisfied",
      failed: "blocking",
      cancelled: "blocking",
      blocked: "blocking"
    },
    "allow-failure": {
      pending: "waiting",
      ready: "waiting",
      assigned: "waiting",
      running: "waiting",
      completed: "satisfied",
      failed: "satisfied",
      cancelled: "satisfied",
      blocked: "satisfied"
    }
  };
  for (const policy of taskDependencyPolicies) {
    for (const status of taskStatuses) {
      assert.equal(dependencyOutcome(policy, status), expectedOutcomes[policy][status], `${policy} x ${status}`);
    }
  }
});

test("capabilities are supported exactly from the version that introduced them", () => {
  const expectedSupport = {
    "1": { "replay-barrier": false, "hub-rpc": false, orchestration: false },
    "2": { "replay-barrier": true, "hub-rpc": false, orchestration: false },
    "3": { "replay-barrier": true, "hub-rpc": true, orchestration: false },
    "4": { "replay-barrier": true, "hub-rpc": true, orchestration: true }
  };
  for (const version of versions) {
    for (const capability of controlProtocolCapabilities) {
      assert.equal(supportsControlCapability(version, capability), expectedSupport[version][capability], `${version} x ${capability}`);
    }
  }
  for (const accepted of versions) assert.equal(isControlProtocolVersion(accepted), true);
  for (const rejected of ["5", "", 4, undefined]) assert.equal(isControlProtocolVersion(rejected), false);
});

const agent = () => ({
  id: "agent-one", name: "Milo", title: "Builder", summary: "Builds", glyph: "M",
  avatarShape: "cup", avatarColor: "amber", state: "working", currentAction: "Working",
  harnessId: "codex-cli", model: "gpt-5", computeNodeId: "node-one", workspace: "/workspace",
  systemPrompt: "Build", unread: 0, updatedAt: at
});

const plainRun = () => ({
  id: "run-one", agentId: "agent-one", nodeId: "node-one", harnessId: "codex-cli", model: "gpt-5",
  workspace: "/workspace", prompt: "Build it", status: "queued", output: "", depth: 0, createdAt: at
});

test("hub messages reach exactly the versions their capability requires", () => {
  const plainDispatch = { type: "dispatch", run: plainRun(), agent: agent() };
  assert.deepEqual(sendableVersions(plainDispatch), ["1", "2", "3", "4"]);

  const executionDispatch = { type: "dispatch", run: plainRun(), agent: agent(), execution: { transport: "native-cli" } };
  assert.deepEqual(sendableVersions(executionDispatch), ["4"]);

  const version4RunFieldValues = {
    taskId: "task-one",
    attempt: 1,
    transport: "acp-v1",
    sessionBindingId: "binding-one",
    workspaceLeaseId: "lease-one"
  };
  for (const [field, value] of Object.entries(version4RunFieldValues)) {
    const dispatch = { type: "dispatch", run: { ...plainRun(), [field]: value }, agent: agent() };
    assert.deepEqual(sendableVersions(dispatch), ["4"], `dispatch carrying ${field}`);
  }

  const approvalDecision = {
    type: "approval.decision",
    decision: { approvalId: "approval-one", runId: "run-one", status: "approved", selectedOptionId: "allow-once" }
  };
  assert.deepEqual(sendableVersions(approvalDecision), ["4"]);

  const hubRpcResponse = { type: "hub.rpc.response", requestId: "request-one", runId: "run-one", result: null };
  assert.deepEqual(sendableVersions(hubRpcResponse), ["3", "4"]);

  assert.deepEqual(sendableVersions({ type: "cancel", runId: "run-one" }), ["1", "2", "3", "4"]);
  assert.deepEqual(sendableVersions({ type: "ping" }), ["1", "2", "3", "4"]);
});

test("control agent messages are accepted exactly by the versions their capability requires", () => {
  const harnessEvent = {
    type: "harness.event",
    event: { type: "message.delta", runId: "run-one", sequence: 1, at, text: "hello" }
  };
  assert.deepEqual(acceptableVersions(harnessEvent), ["4"]);

  const sessionBinding = {
    type: "session.binding",
    runId: "run-one",
    binding: { providerSessionId: "provider-session-7", harnessId: "codex-cli", transport: "acp-v1", status: "active" },
    at
  };
  assert.deepEqual(acceptableVersions(sessionBinding), ["4"]);

  const workspaceLease = {
    type: "workspace.lease",
    runId: "run-one",
    lease: { leaseId: "lease-one", status: "active" },
    at
  };
  assert.deepEqual(acceptableVersions(workspaceLease), ["4"]);

  assert.deepEqual(acceptableVersions({ type: "sync.complete", nodeId: "node-one", at }), ["2", "3", "4"]);
  assert.deepEqual(acceptableVersions({
    type: "hub.rpc.request", requestId: "request-one", runId: "run-one", operation: "get_task_context", arguments: {}, at
  }), ["3", "4"]);

  const lifecycleMessages = [
    { type: "register", node: { id: "node-one" } },
    { type: "heartbeat", nodeId: "node-one", activeRuns: 0, at },
    { type: "run.started", runId: "run-one", at },
    { type: "run.output", runId: "run-one", chunk: "text", at },
    { type: "run.completed", runId: "run-one", output: "done", at },
    { type: "run.failed", runId: "run-one", error: "boom", at },
    { type: "run.cancelled", runId: "run-one", at }
  ];
  for (const message of lifecycleMessages) {
    assert.deepEqual(acceptableVersions(message), ["1", "2", "3", "4"], `${message.type} must reach every version`);
  }
});

const fixtureDirectory = new URL("./fixtures/control-v4/", import.meta.url);
const readFixture = (name) => JSON.parse(readFileSync(new URL(name, fixtureDirectory), "utf8"));
const fixtureNames = readdirSync(fixtureDirectory);

test("control-v4 fixtures validate as version-4 orchestration messages and are rejected earlier", () => {
  const orchestrationFixtureNames = fixtureNames.filter((name) =>
    name.startsWith("harness-event-") || name === "session-binding.json" || name === "workspace-lease.json");
  assert.ok(orchestrationFixtureNames.length >= 5, "expected several orchestration fixtures on disk");

  for (const name of orchestrationFixtureNames) {
    const fixture = readFixture(name);
    const accepted = validateOrchestrationControlAgentMessage(fixture, "4");
    assert.equal(accepted.ok, true, `${name} must validate for version 4: ${accepted.ok ? "" : accepted.reason}`);
    assert.deepEqual(JSON.parse(JSON.stringify(accepted.value)), fixture, `${name} round-trips unchanged`);
    assert.equal(validateOrchestrationControlAgentMessage(fixture, "3").ok, false, `${name} must be rejected for version 3`);
    assert.equal(validateOrchestrationControlAgentMessage({ ...fixture, extra: 1 }, "4").ok, false, `${name} envelope rejects undeclared fields`);
  }
  const binding = readFixture("session-binding.json");
  assert.equal(validateOrchestrationControlAgentMessage({ ...binding, binding: { ...binding.binding, extra: 1 } }, "4").ok, false);
  const lease = readFixture("workspace-lease.json");
  assert.equal(validateOrchestrationControlAgentMessage({ ...lease, lease: { ...lease.lease, extra: 1 } }, "4").ok, false);
});

test("control-v4 dispatch, approval, and register fixtures honor their version gates", () => {
  const approvalDecisionFixture = readFixture("approval-decision.json");
  const approvalResult = validateApprovalDecision(approvalDecisionFixture.decision);
  assert.equal(approvalResult.ok, true, approvalResult.ok ? "" : approvalResult.reason);

  for (const name of ["dispatch.json", "approval-decision.json"]) {
    const fixture = readFixture(name);
    assert.equal(canSendToControlAgent(fixture, "4"), true, `${name} must be sendable to version 4`);
    assert.equal(canSendToControlAgent(fixture, "3"), false, `${name} must not be sendable to version 3`);
  }

  const registerFixture = readFixture("register.json");
  assert.equal(isControlProtocolVersion(registerFixture.protocolVersion), true);
});

const baseHarnessEvent = () => ({ type: "message.delta", runId: "run-one", sequence: 1, at, text: "hello" });
const oversizeText = "é".repeat(harnessEventLimits.textBytes / 2 + 1);
const oversizeDiagnostic = "é".repeat(harnessEventLimits.diagnosticBytes / 2 + 1);

test("harness events reject malformed input", () => {
  const negatives = [
    ["non-object", null],
    ["missing type", { runId: "run-one", sequence: 1, at, text: "hello" }],
    ["unknown type", { ...baseHarnessEvent(), type: "session.teleport" }],
    ["missing runId", { type: "message.delta", sequence: 1, at, text: "hello" }],
    ["negative sequence", { ...baseHarnessEvent(), sequence: -1 }],
    ["non-integer sequence", { ...baseHarnessEvent(), sequence: 1.5 }],
    ["non-timestamp", { ...baseHarnessEvent(), at: "yesterday" }],
    ["text beyond textBytes counted in bytes", { ...baseHarnessEvent(), text: oversizeText }],
    ["undeclared extra field", { ...baseHarnessEvent(), surprise: "nope" }],
    ["plan entry with unknown status", {
      type: "plan.updated", runId: "run-one", sequence: 1, at,
      entries: [{ content: "Write", status: "done", priority: "high" }]
    }],
    ["plan beyond planEntries", {
      type: "plan.updated", runId: "run-one", sequence: 1, at,
      entries: Array.from({ length: harnessEventLimits.planEntries + 1 }, () => ({ content: "Write", status: "pending", priority: "low" }))
    }],
    ["permission request without options", {
      type: "permission.requested", runId: "run-one", sequence: 1, at,
      approvalId: "approval-one", title: "Run tests", options: []
    }],
    ["permission request with duplicate option ids", {
      type: "permission.requested", runId: "run-one", sequence: 1, at,
      approvalId: "approval-one", title: "Run tests",
      options: [
        { id: "allow-once", label: "Allow once", kind: "allow-once" },
        { id: "allow-once", label: "Allow again", kind: "allow-always" }
      ]
    }],
    ["permission request with ACP option spelling", {
      type: "permission.requested", runId: "run-one", sequence: 1, at,
      approvalId: "approval-one", title: "Run tests",
      options: [{ id: "allow-once", label: "Allow once", kind: "allow_once" }]
    }],
    ["permission request beyond approvalOptions", {
      type: "permission.requested", runId: "run-one", sequence: 1, at,
      approvalId: "approval-one", title: "Run tests",
      options: Array.from({ length: harnessEventLimits.approvalOptions + 1 }, (_, index) => ({
        id: `option-${index}`, label: `Option ${index}`, kind: "allow-once"
      }))
    }],
    ["permission resolved while still pending", {
      type: "permission.resolved", runId: "run-one", sequence: 1, at,
      approvalId: "approval-one", status: "pending", selectedOptionId: "allow-once"
    }],
    ["unknown diagnostic beyond diagnosticBytes", {
      type: "unknown", runId: "run-one", sequence: 1, at,
      sourceType: "provider_update", detail: oversizeDiagnostic
    }]
  ];
  for (const [label, value] of negatives) {
    const result = validateHarnessEvent(value);
    assert.equal(result.ok, false, `${label} must be rejected`);
  }
});

test("every harness event type has a validating representative", () => {
  const positives = {
    "message.delta": { type: "message.delta", runId: "run-one", sequence: 1, at, text: "hello" },
    "thought.delta": { type: "thought.delta", runId: "run-one", sequence: 2, at, text: "thinking" },
    "plan.updated": {
      type: "plan.updated", runId: "run-one", sequence: 3, at,
      entries: [
        { content: "Write failing test", status: "completed", priority: "high" },
        { content: "Implement parser", status: "in-progress", priority: "medium" }
      ]
    },
    "tool.call": {
      type: "tool.call", runId: "run-one", sequence: 4, at,
      toolCallId: "tool-1", status: "in-progress", kind: "edit", title: "Edit parser", detail: "src/parser.ts"
    },
    diff: { type: "diff", runId: "run-one", sequence: 5, at, toolCallId: "tool-1", path: "src/parser.ts", oldText: "-old", newText: "+new" },
    "terminal.output": { type: "terminal.output", runId: "run-one", sequence: 6, at, terminalId: "terminal-1", stream: "stdout", text: "line of output" },
    usage: { type: "usage", runId: "run-one", sequence: 7, at, inputTokens: 100, outputTokens: 200, cachedInputTokens: 50, costUsd: 0.01 },
    "permission.requested": {
      type: "permission.requested", runId: "run-one", sequence: 8, at,
      approvalId: "approval-one", toolCallId: "tool-1", title: "Run pnpm test",
      options: [
        { id: "allow-once", label: "Allow once", kind: "allow-once" },
        { id: "reject-once", label: "Reject once", kind: "reject-once" }
      ]
    },
    "permission.resolved": { type: "permission.resolved", runId: "run-one", sequence: 9, at, approvalId: "approval-one", status: "approved", selectedOptionId: "allow-once" },
    warning: { type: "warning", runId: "run-one", sequence: 10, at, code: "E_SLOW", message: "tool exceeded its budget" },
    unknown: { type: "unknown", runId: "run-one", sequence: 11, at, sourceType: "available_commands_update", detail: "ignored provider update" }
  };
  for (const type of harnessEventTypes) {
    const result = validateHarnessEvent(positives[type]);
    assert.equal(result.ok, true, `${type} representative must validate: ${result.ok ? "" : result.reason}`);
  }
});

test("approval decisions bind their option to their status", () => {
  const approved = validateApprovalDecision({ approvalId: "approval-one", runId: "run-one", status: "approved", selectedOptionId: "allow-once" });
  assert.equal(approved.ok, true);
  const rejected = validateApprovalDecision({ approvalId: "approval-one", runId: "run-one", status: "rejected", selectedOptionId: "reject-once" });
  assert.equal(rejected.ok, true);

  const negatives = [
    ["approved without a selected option", { approvalId: "approval-one", runId: "run-one", status: "approved" }],
    ["rejected without a selected option", { approvalId: "approval-one", runId: "run-one", status: "rejected" }],
    ["cancelled with a selected option", { approvalId: "approval-one", runId: "run-one", status: "cancelled", selectedOptionId: "allow-once" }],
    ["expired with a selected option", { approvalId: "approval-one", runId: "run-one", status: "expired", selectedOptionId: "allow-once" }],
    ["pending status", { approvalId: "approval-one", runId: "run-one", status: "pending", selectedOptionId: "allow-once" }],
    ["missing approvalId", { runId: "run-one", status: "approved", selectedOptionId: "allow-once" }],
    ["missing runId", { approvalId: "approval-one", status: "approved", selectedOptionId: "allow-once" }]
  ];
  for (const [label, value] of negatives) {
    const result = validateApprovalDecision(value);
    assert.equal(result.ok, false, `${label} must be rejected`);
  }
});

test("workspace lease updates bind their retention reason to their status", () => {
  const retained = validateWorkspaceLeaseUpdate({ leaseId: "lease-one", status: "retained", retentionReason: "dirty", detail: "2 modified files" });
  assert.equal(retained.ok, true);
  const active = validateWorkspaceLeaseUpdate({ leaseId: "lease-one", status: "active" });
  assert.equal(active.ok, true);

  const negatives = [
    ["retained without a retention reason", { leaseId: "lease-one", status: "retained" }],
    ["active with a retention reason", { leaseId: "lease-one", status: "active", retentionReason: "dirty" }],
    ["unknown status", { leaseId: "lease-one", status: "vanished" }],
    ["missing leaseId", { status: "active" }]
  ];
  for (const [label, value] of negatives) {
    const result = validateWorkspaceLeaseUpdate(value);
    assert.equal(result.ok, false, `${label} must be rejected`);
  }
});

test("session binding updates reject unknown transports, statuses, and harness ids", () => {
  const valid = validateSessionBindingUpdate({
    bindingId: "binding-one", providerSessionId: "provider-session-7", harnessId: "codex-cli", transport: "acp-v1", status: "active"
  });
  assert.equal(valid.ok, true);

  const negatives = [
    ["unknown transport", { providerSessionId: "provider-session-7", harnessId: "codex-cli", transport: "acp-v2", status: "active" }],
    ["unknown status", { providerSessionId: "provider-session-7", harnessId: "codex-cli", transport: "acp-v1", status: "dormant" }],
    ["unknown harness id", { providerSessionId: "provider-session-7", harnessId: "cursor-cli", transport: "acp-v1", status: "active" }],
    ["missing provider session", { harnessId: "codex-cli", transport: "acp-v1", status: "active" }]
  ];
  for (const [label, value] of negatives) {
    const result = validateSessionBindingUpdate(value);
    assert.equal(result.ok, false, `${label} must be rejected`);
  }
});

test("withOrchestrationDefaults backfills only the missing orchestration collections", () => {
  const legacy = { agents: [], nodes: [], runs: [], events: [], messages: [], threads: [] };
  const migrated = withOrchestrationDefaults(legacy);
  for (const collection of orchestrationCollections) {
    assert.deepEqual(migrated[collection], [], `${collection} must be added as an empty array`);
  }
  assert.equal(migrated.agents, legacy.agents, "existing collections keep their reference");
  assert.equal("generatedAt" in migrated, false, "defaults never invent unrelated snapshot fields");

  const existingTasks = [{ id: "task-one", status: "pending" }];
  const existingSessionBindings = [{ id: "binding-one", status: "active" }];
  const partial = {
    agents: [], nodes: [], runs: [], events: [], messages: [], threads: [],
    tasks: existingTasks,
    sessionBindings: existingSessionBindings
  };
  const completed = withOrchestrationDefaults(partial);
  assert.equal(completed.tasks, existingTasks, "existing tasks keep their array reference");
  assert.equal(completed.sessionBindings, existingSessionBindings, "existing session bindings keep their array reference");
  assert.deepEqual(completed.tasks, [{ id: "task-one", status: "pending" }]);
  assert.deepEqual(completed.sessionBindings, [{ id: "binding-one", status: "active" }]);
  assert.deepEqual(completed.approvals, []);
  assert.deepEqual(completed.workspaceLeases, []);
  assert.deepEqual(completed.taskMessages, []);
  assert.deepEqual(completed.taskMessageAcknowledgements, []);
});
