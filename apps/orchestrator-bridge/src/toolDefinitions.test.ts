import assert from "node:assert/strict";
import { test } from "node:test";
import {
  externalOrchestratorToolNames,
  orchestratorClientLimits,
  requiredScopeForExternalOrchestratorTool,
  validateOrchestratorClientMessage
} from "@coffee-shop/protocol";
import { orderedToolDefinitions, toolDefinitions } from "./toolDefinitions.js";

test("every protocol tool name has exactly one definition and no definition is invented", () => {
  assert.deepEqual(Object.keys(toolDefinitions).sort(), [...externalOrchestratorToolNames].sort());
  assert.deepEqual(orderedToolDefinitions.map((definition) => definition.name), [...externalOrchestratorToolNames]);
});

for (const name of externalOrchestratorToolNames) {
  test(`${name} declares a usable object schema and a required scope`, () => {
    const definition = toolDefinitions[name];
    assert.equal(definition.name, name);
    assert.equal(definition.inputSchema.type, "object");
    assert.ok(definition.description.length > 0);
    assert.ok(definition.title.length > 0);
    for (const required of definition.inputSchema.required ?? []) {
      assert.ok(Object.hasOwn(definition.inputSchema.properties, required), `${name} requires undeclared property ${required}`);
    }
    assert.ok(["orchestrate", "resolve-approvals"].includes(requiredScopeForExternalOrchestratorTool(name)));
  });

  test(`${name} produces an rpc.request the hub contract accepts`, () => {
    const request = validateOrchestratorClientMessage({
      type: "rpc.request",
      requestId: "00000000-0000-4000-8000-000000000000",
      tool: name,
      arguments: { threadId: "thread-1" }
    });
    assert.equal(request.ok, true, request.ok ? "" : request.reason);
  });
}

test("only the approval tools are gated behind the resolve-approvals scope", () => {
  const gated = externalOrchestratorToolNames.filter((name) => requiredScopeForExternalOrchestratorTool(name) === "resolve-approvals");
  assert.deepEqual([...gated].sort(), ["list_approvals", "resolve_approval"]);
});

test("every tool schema stays far inside the hub's argument bound", () => {
  for (const definition of orderedToolDefinitions) {
    const encoded = JSON.stringify(definition.inputSchema);
    assert.ok(encoded.length < orchestratorClientLimits.argumentsBytes);
  }
});
