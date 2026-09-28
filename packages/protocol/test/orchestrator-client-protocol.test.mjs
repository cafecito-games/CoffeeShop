import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalResolverKinds,
  externalOrchestratorToolNames,
  isExternalOrchestratorToolName,
  isOrchestratorAttachmentStatus,
  isOrchestratorClientCloseReason,
  isOrchestratorClientErrorCode,
  isOrchestratorClientScope,
  isThreadOrchestratorKind,
  orchestratorAttachmentStatuses,
  orchestratorClientCloseReasons,
  orchestratorClientErrorCodes,
  orchestratorClientHeartbeatExpirySeconds,
  orchestratorClientHeartbeatSeconds,
  orchestratorClientLimits,
  orchestratorClientProtocolVersion,
  orchestratorClientScopes,
  requiredScopeForExternalOrchestratorTool,
  threadOrchestrator,
  threadOrchestratorKinds,
  threadOwnerAgentId,
  validateOrchestratorClientMessage,
  validateOrchestratorHubMessage
} from "../dist/index.js";

const encoder = new TextEncoder();
const byteLength = (value) => encoder.encode(value).length;
const oversize = (limit) => "x".repeat(limit + 1);

const clientMessages = {
  "client.hello": { type: "client.hello", protocolVersion: 1, clientId: "client-one", secret: "shhh" },
  "client.heartbeat": { type: "client.heartbeat" },
  "rpc.request": { type: "rpc.request", requestId: "request-one", tool: "attach_thread", arguments: { threadId: "thread-one" } }
};

const hubMessages = {
  "client.welcome": { type: "client.welcome", connectionId: "connection-one", heartbeatSeconds: 15, scopes: ["orchestrate"] },
  "rpc.response": { type: "rpc.response", requestId: "request-one", result: { attached: true } },
  doorbell: { type: "doorbell", threadId: "thread-one", pending: 2, approvals: 1, urgent: true, summary: "2 tasks completed" },
  "attachment.replaced": { type: "attachment.replaced", threadId: "thread-one", attachmentId: "attachment-one" },
  "client.revoked": { type: "client.revoked" }
};

test("the orchestrator-client protocol is version 1 with the documented heartbeat cadence", () => {
  assert.equal(orchestratorClientProtocolVersion, 1);
  assert.equal(orchestratorClientHeartbeatSeconds, 15);
  assert.equal(orchestratorClientHeartbeatExpirySeconds, 45);
  assert.ok(orchestratorClientHeartbeatExpirySeconds > orchestratorClientHeartbeatSeconds);
});

test("every orchestrator vocabulary has exactly one definition and a guard that closes over it", () => {
  const vocabularies = [
    [orchestratorClientScopes, isOrchestratorClientScope],
    [orchestratorAttachmentStatuses, isOrchestratorAttachmentStatus],
    [orchestratorClientCloseReasons, isOrchestratorClientCloseReason],
    [orchestratorClientErrorCodes, isOrchestratorClientErrorCode],
    [externalOrchestratorToolNames, isExternalOrchestratorToolName],
    [threadOrchestratorKinds, isThreadOrchestratorKind]
  ];
  for (const [values, guard] of vocabularies) {
    assert.equal(new Set(values).size, values.length, `${values.join(",")} repeats a value`);
    for (const value of values) assert.equal(guard(value), true, value);
    for (const rejected of ["", "unknown", "Orchestrate", 1, null, undefined, {}]) {
      assert.equal(guard(rejected), false, `${values.join(",")} accepted ${String(rejected)}`);
    }
  }
  assert.deepEqual([...orchestratorClientScopes], ["orchestrate", "resolve-approvals"]);
  assert.deepEqual([...orchestratorAttachmentStatuses], ["attached", "detached", "replaced"]);
  assert.deepEqual([...orchestratorClientCloseReasons], ["unauthorized", "revoked", "unsupported_version"]);
  assert.deepEqual([...orchestratorClientErrorCodes], [
    "not_attached", "forbidden", "revoked", "hub_unavailable", "conflict", "invalid_arguments", "not_found"
  ]);
  assert.deepEqual([...approvalResolverKinds], ["operator", "policy", "system", "orchestrator"]);
});

test("every external orchestrator tool is named once and maps to exactly one required scope", () => {
  assert.deepEqual([...externalOrchestratorToolNames], [
    "create_thread", "list_threads", "attach_thread", "detach_thread", "get_thread_context", "get_thread_events",
    "submit_tasks", "update_task", "send_task_message", "post_artifact", "publish_preview", "update_thread", "get_execution_inventory",
    "spawn_instance", "get_instance", "renew_instance", "release_instance",
    "list_approvals", "resolve_approval"
  ]);
  for (const tool of externalOrchestratorToolNames) {
    const scope = requiredScopeForExternalOrchestratorTool(tool);
    assert.ok(orchestratorClientScopes.includes(scope), `${tool} requires an unknown scope`);
    const expected = tool === "list_approvals" || tool === "resolve_approval" ? "resolve-approvals" : "orchestrate";
    assert.equal(scope, expected, tool);
  }
  for (const absent of ["delegate_task", "get_task_context"]) {
    assert.equal(isExternalOrchestratorToolName(absent), false, `${absent} is not offered in version 1`);
  }
});

test("threadOrchestrator derives an agent orchestrator only from a persisted owner agent", () => {
  assert.deepEqual(threadOrchestrator({ ownerAgentId: "lead" }), { kind: "agent", agentId: "lead" });
  assert.equal(threadOwnerAgentId({ ownerAgentId: "lead" }), "lead");
  assert.deepEqual(threadOrchestrator({ orchestrator: { kind: "external", clientId: "client-one" } }), { kind: "external", clientId: "client-one" });
  assert.equal(threadOwnerAgentId({ orchestrator: { kind: "external", clientId: "client-one" } }), undefined);
  assert.equal(threadOrchestrator({}), undefined, "no owner agent means not agent-orchestrated");
  assert.equal(threadOwnerAgentId({}), undefined);
  assert.deepEqual(
    threadOrchestrator({ ownerAgentId: "lead", orchestrator: { kind: "external", clientId: "client-one" } }),
    { kind: "external", clientId: "client-one" },
    "an explicit orchestrator is never overridden by an owner agent"
  );
});

test("every bridge-to-hub message type round-trips through its parser", () => {
  for (const [type, message] of Object.entries(clientMessages)) {
    const result = validateOrchestratorClientMessage(message);
    assert.equal(result.ok, true, `${type}: ${result.ok ? "" : result.reason}`);
    assert.deepEqual(result.value, message);
  }
  assert.deepEqual(Object.keys(clientMessages).sort(), ["client.heartbeat", "client.hello", "rpc.request"]);
});

test("every hub-to-bridge message type round-trips through its parser", () => {
  for (const [type, message] of Object.entries(hubMessages)) {
    const result = validateOrchestratorHubMessage(message);
    assert.equal(result.ok, true, `${type}: ${result.ok ? "" : result.reason}`);
    assert.deepEqual(result.value, message);
  }
  const failed = { type: "rpc.response", requestId: "request-one", error: { code: "not_attached", message: "Call attach_thread first" } };
  assert.deepEqual(validateOrchestratorHubMessage(failed), { ok: true, value: failed });
  for (const scopes of [["orchestrate"], ["resolve-approvals"], ["orchestrate", "resolve-approvals"]]) {
    assert.equal(validateOrchestratorHubMessage({ ...hubMessages["client.welcome"], scopes }).ok, true, scopes.join(","));
  }
});

test("each parser rejects the other direction's messages", () => {
  for (const message of Object.values(hubMessages)) {
    assert.deepEqual(validateOrchestratorClientMessage(message), { ok: false, reason: "orchestrator client message type is missing or unknown" });
  }
  for (const message of Object.values(clientMessages)) {
    assert.deepEqual(validateOrchestratorHubMessage(message), { ok: false, reason: "orchestrator hub message type is missing or unknown" });
  }
});

test("both parsers reject anything that is not a typed object", () => {
  for (const value of [undefined, null, 1, "client.hello", [], [{ type: "client.heartbeat" }], { type: 1 }, { type: "" }, {}]) {
    assert.equal(validateOrchestratorClientMessage(value).ok, false, JSON.stringify(value ?? null));
    assert.equal(validateOrchestratorHubMessage(value).ok, false, JSON.stringify(value ?? null));
  }
});

test("bridge-to-hub messages are rejected field by field, never partially accepted", () => {
  const rejected = [
    { ...clientMessages["client.hello"], protocolVersion: 2 },
    { ...clientMessages["client.hello"], protocolVersion: "1" },
    { ...clientMessages["client.hello"], clientId: "" },
    { ...clientMessages["client.hello"], secret: "" },
    { ...clientMessages["client.hello"], secret: oversize(orchestratorClientLimits.secretBytes) },
    { ...clientMessages["client.hello"], secret: 42 },
    { ...clientMessages["client.hello"], scopes: ["orchestrate"] },
    { type: "client.hello", clientId: "client-one", secret: "shhh" },
    { type: "client.heartbeat", at: "2026-09-22T12:00:00Z" },
    { ...clientMessages["rpc.request"], tool: "unknown_tool" },
    { ...clientMessages["rpc.request"], requestId: "" },
    { ...clientMessages["rpc.request"], arguments: undefined },
    { ...clientMessages["rpc.request"], arguments: null },
    { ...clientMessages["rpc.request"], arguments: [] },
    { ...clientMessages["rpc.request"], arguments: "threadId=thread-one" },
    { ...clientMessages["rpc.request"], arguments: { prompt: oversize(orchestratorClientLimits.argumentsBytes) } }
  ];
  for (const message of rejected) {
    const result = validateOrchestratorClientMessage(message);
    assert.equal(result.ok, false, JSON.stringify(message));
    assert.equal("value" in result, false, "a rejection never carries a partial object");
    assert.ok(result.reason.length > 0);
  }
});

test("hub-to-bridge messages are rejected field by field, never partially accepted", () => {
  const rejected = [
    { ...hubMessages["client.welcome"], connectionId: "" },
    { ...hubMessages["client.welcome"], heartbeatSeconds: 0 },
    { ...hubMessages["client.welcome"], heartbeatSeconds: -15 },
    { ...hubMessages["client.welcome"], heartbeatSeconds: 15.5 },
    { ...hubMessages["client.welcome"], heartbeatSeconds: orchestratorClientLimits.maximumHeartbeatSeconds + 1 },
    { ...hubMessages["client.welcome"], scopes: [] },
    { ...hubMessages["client.welcome"], scopes: ["orchestrate", "orchestrate"] },
    { ...hubMessages["client.welcome"], scopes: ["administer"] },
    { ...hubMessages["client.welcome"], scopes: "orchestrate" },
    { type: "rpc.response", requestId: "request-one" },
    { type: "rpc.response", requestId: "request-one", result: { ok: true }, error: { code: "conflict", message: "no" } },
    { type: "rpc.response", requestId: "request-one", result: undefined },
    { type: "rpc.response", requestId: "request-one", error: { code: "boom", message: "no" } },
    { type: "rpc.response", requestId: "request-one", error: { code: "conflict" } },
    { type: "rpc.response", requestId: "request-one", error: { code: "conflict", message: oversize(orchestratorClientLimits.errorMessageBytes) } },
    { type: "rpc.response", requestId: "request-one", error: { code: "conflict", message: "no", detail: "extra" } },
    { type: "rpc.response", requestId: "", result: 1 },
    { type: "rpc.response", requestId: "request-one", result: { text: oversize(orchestratorClientLimits.resultBytes) } },
    { ...hubMessages.doorbell, pending: -1 },
    { ...hubMessages.doorbell, pending: 1.5 },
    { ...hubMessages.doorbell, approvals: "1" },
    { ...hubMessages.doorbell, urgent: "true" },
    { ...hubMessages.doorbell, threadId: "" },
    { ...hubMessages.doorbell, summary: oversize(orchestratorClientLimits.doorbellSummaryBytes) },
    { type: "doorbell", threadId: "thread-one", pending: 1, approvals: 0, urgent: false },
    { ...hubMessages["attachment.replaced"], attachmentId: "" },
    { ...hubMessages["attachment.replaced"], reason: "taken over" },
    { type: "client.revoked", reason: "revoked" }
  ];
  for (const message of rejected) {
    const result = validateOrchestratorHubMessage(message);
    assert.equal(result.ok, false, JSON.stringify(message));
    assert.equal("value" in result, false, "a rejection never carries a partial object");
    assert.ok(result.reason.length > 0);
  }
});

test("payload bounds are measured in bytes, not code units", () => {
  const within = "é".repeat(orchestratorClientLimits.doorbellSummaryBytes / 2);
  assert.equal(byteLength(within), orchestratorClientLimits.doorbellSummaryBytes);
  assert.equal(validateOrchestratorHubMessage({ ...hubMessages.doorbell, summary: within }).ok, true);
  assert.equal(validateOrchestratorHubMessage({ ...hubMessages.doorbell, summary: `${within}é` }).ok, false);
});

test("a doorbell carries only hub-owned counters and a hub-generated summary", () => {
  const result = validateOrchestratorHubMessage(hubMessages.doorbell);
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.value).sort(), ["approvals", "pending", "summary", "threadId", "type", "urgent"]);
});
