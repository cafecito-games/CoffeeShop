import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as protocol from "../dist/index.js";
import { readInstanceFixture, instanceVocabularyFixture, invalidInstanceFixtures } from "./instance-fixture-producer.mjs";

const at = "2026-09-24T12:00:00Z";
export const instance = {
  id: "instance-one", threadId: "thread-one", creator: { kind: "operator", operatorId: "operator-one" },
  delegation: { canDelegate: false }, requirements: { harnessIds: ["claude-cli"] },
  lease: { idleTimeoutSeconds: 1800, expiresAt: "2026-09-24T12:30:00Z" }, status: "provisioning", createdAt: at, updatedAt: at
};
export const allocation = {
  id: "allocation-one", instanceId: instance.id, nodeId: "node-one", harnessId: "claude-cli", model: "fable",
  transport: "native-cli", workspace: "/workspace", lease: instance.lease, status: "provisioning", createdAt: at, updatedAt: at
};

test("v5 gates instance lifecycle and excludes every older version", () => {
  const value = { type: "instance.provision", instance, allocation };
  assert.equal(protocol.latestControlProtocolVersion, "5");
  for (const version of protocol.controlProtocolVersions) {
    assert.equal(protocol.validateInstanceHubMessage(value, version).ok, version === "5");
    assert.equal(protocol.canSendToControlAgent(value, version), version === "5");
  }
});

test("instance and allocation transitions enumerate terminal states and reject unknown values", () => {
  assert.deepEqual(protocol.terminalInstanceStatuses, ["released", "failed"]);
  assert.deepEqual(protocol.occupyingAllocationStatuses, ["reserved", "provisioning", "active"]);
  for (const status of protocol.instanceStatuses) {
    assert.equal(protocol.isTerminalInstanceStatus(status), ["released", "failed"].includes(status));
  }
  for (const status of protocol.allocationStatuses) {
    assert.equal(protocol.isOccupyingAllocationStatus(status), ["reserved", "provisioning", "active"].includes(status));
  }
  for (const [statuses, transition] of [[protocol.instanceStatuses, protocol.canTransitionInstance], [protocol.allocationStatuses, protocol.canTransitionAllocation]]) {
    for (const from of statuses) for (const to of statuses) {
      assert.equal(typeof transition(from, to), "boolean");
      if (["released", "failed"].includes(from) || from === to) assert.equal(transition(from, to), false);
    }
    assert.equal(transition("unknown", "ready"), false);
  }
});

test("instance records reject unknown fields, statuses, and unbounded input", () => {
  assert.equal(protocol.validateAgentInstance(instance).ok, true);
  for (const patch of [{ status: "unknown" }, { extra: true }, { id: "" }, { purpose: { instructions: "x".repeat(65537) } }, { lease: { ...instance.lease, idleTimeoutSeconds: 59 } }]) {
    assert.equal(protocol.validateAgentInstance({ ...instance, ...patch }).ok, false);
  }
  assert.equal(protocol.validateInstanceAllocation({ ...allocation, status: "unknown" }).ok, false);
});

test("skill-bound instance messages require the exact allocation pack expectation", () => {
  const skillInstance = { ...instance, requirements: { ...instance.requirements, skills: ["coffeeshop-preview"] } };
  const expectedCapabilityPack = {
    id: "coffeeshop-capability-pack", version: "1.1.0", requiredSkills: ["coffeeshop-preview"]
  };
  const provision = { type: "instance.provision", instance: skillInstance, allocation: { ...allocation, expectedCapabilityPack } };
  assert.equal(protocol.validateInstanceHubMessage(provision, "5").ok, true);
  assert.equal(protocol.validateInstanceHubMessage({ ...provision, allocation }, "5").ok, false);
  assert.equal(protocol.validateInstanceHubMessage({
    type: "instance.provision", instance, allocation: { ...allocation, expectedCapabilityPack }
  }, "5").ok, false);
});

test("resident evidence distinguishes absent, empty, duplicate, and malformed data", () => {
  const value = { type: "sync.complete", nodeId: "node-one", at };
  assert.equal(protocol.validateInstanceControlMessage(value, "5").ok, true);
  assert.equal(protocol.hasAuthoritativeInstanceEvidence(value), false);
  assert.equal(protocol.hasAuthoritativeInstanceEvidence({ ...value, activeInstanceIds: [] }), true);
  for (const ids of [null, ["same", "same"], [""], "none"]) {
    assert.equal(protocol.validateInstanceControlMessage({ ...value, activeInstanceIds: ids }, "5").ok, false);
  }
});

test("heartbeat residency evidence follows the sync.complete rule and capability gate", () => {
  const heartbeat = { type: "heartbeat", nodeId: "node-one", activeRuns: 0, at };
  assert.equal(protocol.validateInstanceControlMessage(heartbeat, "5").ok, true);
  assert.equal(protocol.hasAuthoritativeInstanceEvidence(heartbeat), false, "an omitted list is absent evidence");
  assert.equal(protocol.hasAuthoritativeInstanceEvidence({ ...heartbeat, activeInstanceIds: [] }), true, "an explicit empty array reports zero residents");
  for (const ids of [null, ["same", "same"], [""], ["bad/id"], "none"]) {
    assert.equal(protocol.validateInstanceControlMessage({ ...heartbeat, activeInstanceIds: ids }, "5").ok, false, `malformed list must reject: ${JSON.stringify(ids)}`);
  }
  for (const version of ["1", "2", "3", "4"]) {
    assert.equal(protocol.canAcceptFromControlAgent(heartbeat, version), true, `${version}: a heartbeat without instance fields stays unchanged`);
    assert.equal(protocol.canAcceptFromControlAgent({ ...heartbeat, activeInstances: 1 }, version), false, `${version}: the scalar count already requires the instances capability`);
    assert.equal(protocol.canAcceptFromControlAgent({ ...heartbeat, activeInstanceIds: [] }, version), false, `${version}: resident identities require the instances capability`);
  }
});

test("Go-produced fixtures validate and round-trip byte-for-byte through the TypeScript encoder", () => {
  for (const name of ["provision", "dispatch", "dispatch-resume", "release", "ready", "released", "failed", "register", "heartbeat", "heartbeat-empty", "sync", "sync-empty", "sync-absent", "create", "template"]) {
    const bytes = readFileSync(new URL(`./fixtures/control-v5/${name}.json`, import.meta.url), "utf8");
    const value = JSON.parse(bytes);
    const validate = ["provision", "dispatch", "dispatch-resume", "release"].includes(name) ? protocol.validateInstanceHubMessage
      : name === "create" ? protocol.validateInstanceLifecycleRequest : name === "template" ? protocol.validateAgentTemplate : protocol.validateInstanceControlMessage;
    const result = validate(value, "5");
    assert.equal(result.ok, true, `${name}: ${result.reason}`);
    assert.equal(JSON.stringify(result.value, null, 2) + "\n", bytes);
    if (["provision", "dispatch", "dispatch-resume", "release"].includes(name)) {
      for (const version of ["1", "2", "3", "4", "6", ""]) assert.equal(protocol.canSendToControlAgent(value, version), false);
    } else if (!["create", "template", "sync-absent"].includes(name)) {
      for (const version of ["1", "2", "3", "4", "6", ""]) assert.equal(protocol.canAcceptFromControlAgent(value, version), false, `${name}/${version}`);
    }
  }
});

test("shared TypeScript vocabulary and malformed fixture producers stay byte-compatible", () => {
  for (const [name, value] of [["vocabulary", instanceVocabularyFixture()], ["invalid", invalidInstanceFixtures()]]) {
    const bytes = readFileSync(new URL(`./fixtures/control-v5/${name}.json`, import.meta.url), "utf8");
    assert.equal(bytes, JSON.stringify(value, null, 2) + "\n", name);
  }
  const validators = { hub: protocol.validateInstanceHubMessage, control: protocol.validateInstanceControlMessage,
    lifecycle: protocol.validateInstanceLifecycleRequest, instance: protocol.validateAgentInstance, allocation: protocol.validateInstanceAllocation, template: protocol.validateAgentTemplate };
  for (const { name, kind, value } of readInstanceFixture("invalid")) assert.equal(validators[kind](value, "5").ok, false, name);
});

test("every lifecycle vocabulary has a valid representative and terminals cannot reactivate", () => {
  const expectedInstances = {
    requested: ["provisioning", "draining", "failed"], provisioning: ["ready", "draining", "failed"],
    ready: ["busy", "idle", "provisioning", "draining", "failed"], busy: ["idle", "provisioning", "draining", "failed"],
    idle: ["busy", "provisioning", "draining", "failed"], draining: ["released", "failed"], released: [], failed: []
  };
  const expectedAllocations = {
    reserved: ["provisioning", "released", "failed"], provisioning: ["active", "lost", "released", "failed"],
    active: ["lost", "released", "failed"], lost: ["released", "failed"], released: [], failed: []
  };
  for (const from of protocol.instanceStatuses) {
    assert.equal(protocol.validateAgentInstance({ ...instance, status: from }).ok, true);
    for (const to of protocol.instanceStatuses) assert.equal(protocol.canTransitionInstance(from, to), expectedInstances[from].includes(to));
  }
  for (const from of protocol.allocationStatuses) {
    assert.equal(protocol.validateInstanceAllocation({ ...allocation, status: from }).ok, true);
    for (const to of protocol.allocationStatuses) assert.equal(protocol.canTransitionAllocation(from, to), expectedAllocations[from].includes(to));
  }
  for (const mode of protocol.instanceReleaseModes) assert.equal(protocol.validateInstanceHubMessage({ ...readInstanceFixture("release"), mode }, "5").ok, true);
  for (const creator of [{ kind: "operator", operatorId: "one" }, { kind: "run", runId: "run-one", instanceId: "instance-one" }, { kind: "orchestrator-client", clientId: "client-one" }]) {
    assert.equal(protocol.validateAgentInstance({ ...instance, creator }).ok, true);
  }
});

test("lifecycle digest preserves identity and normalizes only semantic defaults and sets", () => {
  const create = readInstanceFixture("create");
  const digest = (value) => {
    const result = protocol.instanceLifecycleDigestInput(value); assert.equal(result.ok, true); return result.value;
  };
  assert.equal(digest(create), digest({ ...create, idleTimeoutSeconds: 1800, idempotency: { ...create.idempotency, key: "replay" } }));
  assert.notEqual(digest(create), digest({ ...create, threadId: "another-thread" }));
  assert.notEqual(digest(create), digest({ ...create, idempotency: { ...create.idempotency, caller: { kind: "operator", operatorId: "other" } } }));
  assert.equal(digest({ ...create, requirements: { models: ["a", "b"] } }), digest({ ...create, requirements: { models: ["b", "a"] } }));
  assert.notEqual(digest({ ...create, requirements: { preferences: { models: ["a", "b"] } } }), digest({ ...create, requirements: { preferences: { models: ["b", "a"] } } }));
  for (const operation of ["release", "renew"]) {
    const request = { operation, threadId: create.threadId, instanceId: "instance-one", idempotency: create.idempotency, ...(operation === "release" ? { mode: "drain" } : {}) };
    assert.equal(protocol.validateInstanceLifecycleRequest(request).ok, true);
    assert.notEqual(digest(request), digest({ ...request, instanceId: "other" }));
  }
  // A renewal's omitted timeout preserves the instance's existing timeout, so it must digest
  // differently from an explicit value, even the global default.
  const renew = { operation: "renew", threadId: create.threadId, instanceId: "instance-one", idempotency: create.idempotency };
  assert.notEqual(digest(renew), digest({ ...renew, idleTimeoutSeconds: 1800 }));
  assert.notEqual(digest(renew), digest({ ...renew, idleTimeoutSeconds: 3600 }));
  assert.equal(digest({ ...renew, idleTimeoutSeconds: 1800 }), digest({ ...renew, idleTimeoutSeconds: 1800 }));
});

test("get-instance requests are a closed scoped query shape", () => {
  const request = { threadId: "thread-one", instanceId: "instance-one" };
  assert.deepEqual(protocol.validateGetInstanceRequest(request), { ok: true, value: request });
  for (const invalid of [
    { instanceId: "instance-one" },
    { ...request, instanceId: "bad/id" },
    { ...request, caller: { kind: "operator", operatorId: "operator" } },
    { ...request, includeTerminal: true }
  ]) assert.equal(protocol.validateGetInstanceRequest(invalid).ok, false);
});

test("legacy actor-only records remain readable but cannot become a v5 dispatch", () => {
  assert.deepEqual(protocol.validateRuntimeActor({ kind: "agent", agentId: "agent-one" }), { ok: true, value: { kind: "agent", agentId: "agent-one" } });
  assert.equal(protocol.validateRuntimeActor({ kind: "instance", instanceId: "i", allocationId: "a" }).ok, true);
  for (const actor of [{ kind: "instance", instanceId: "i" }, { kind: "instance", instanceId: "i", allocationId: "a", agentId: "legacy" }, { kind: "unknown" }]) assert.equal(protocol.validateRuntimeActor(actor).ok, false);
  const legacy = JSON.parse(readFileSync(new URL("./fixtures/control-v4/dispatch.json", import.meta.url), "utf8"));
  assert.equal(protocol.canSendToControlAgent(legacy, "4"), true);
  assert.equal(protocol.validateInstanceHubMessage(legacy, "5").ok, false);
});
