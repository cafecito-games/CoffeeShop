import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  placementRequirementKinds,
  validateInstanceHubMessage,
  validateInstanceRequirements,
  type AgentInstance,
  type AgentTemplate,
  type CapabilityPackReadinessReport,
  type ComputeNode,
  type ControlProtocolVersion,
  type ExecutionRequirements,
  type HubToControlAgent,
  type InstanceAllocation,
  type NodeCapabilityEvidence,
  type NodeCapabilityReport,
  type PlacementOverride,
  type ProjectProfile,
  type Run,
  type InstanceHubMessage,
  type Task,
  type Thread
} from "@coffee-shop/protocol";
import { applyRunLifecycle, failLostTaskAttempts } from "./lifecycle.js";
import { nodeOfferings, offeredWorkspace, placeTask, requirementsThroughTemplate, resolveTaskTemplate, runSchedulingPass, type NodeConnection, type PlacementEnvironment, type SchedulingContext } from "./scheduler.js";
import {
  assertPersistedInstanceState,
  flushPendingInstanceDeliveries,
  nodeResidencyInState,
  pruneInstanceAuditRecords,
  receiveInstanceLifecycleReport,
  reconcileNodeInstancesInState,
  residentInstanceUsage
} from "./instances.js";
import { Store, type State } from "./store.js";
import { receiveSessionBinding } from "./sessionBindings.js";
import { cancelTaskInState, normalizeRequirements, taskBatchLimits } from "./tasks.js";

/*
 * Offering-first placement (#77).
 *
 * Every scenario drives the real pass against one consistent state, exactly as the hub does inside
 * its transaction, so what is asserted is the committed record — instance, allocation, outbox
 * command, task intent — and never a projection built for the test.
 */

const at = "2026-09-25T12:00:00.000Z";
const later = (seconds: number) => new Date(Date.parse(at) + seconds * 1000).toISOString();

/*
 * Byte-faithful version-5 inventory. `register.json` is written by Barista's own wire encoder
 * (apps/control-agent/internal/protocol/instances_test.go:46 marshalling
 * apps/control-agent/internal/protocol/messages.go:88 `Outbound`), so the offering derivation is
 * exercised against the producer's bytes rather than a hand-written node.
 */
const controlFixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../../../packages/protocol/test/fixtures/control-v5/${name}.json`, import.meta.url), "utf8"));

function node(id: string, overrides: Partial<ComputeNode> = {}): ComputeNode {
  return {
    id, name: id, kind: "local", platform: "darwin · arm64", status: "online", lastSeen: at,
    activeRuns: 0, concurrency: 2, instanceCapacity: 2, activeInstances: 0, workspaceRoots: ["/workspace"],
    version: "test",
    harnesses: [{ id: "claude-cli", label: "Claude", description: "", available: true, authMode: "local-subscription", models: ["fable"] }],
    ...overrides
  };
}

const thread = (id = "thread-one"): Thread => ({
  id, title: id, objective: id, summary: "", status: "active", ownerAgentId: "orchestrator",
  createdBy: "user", createdAt: at, updatedAt: at
});

function task(id: string, requirements: ExecutionRequirements = {}, overrides: Partial<Task> = {}): Task {
  return {
    id, threadId: "thread-one", title: `Task ${id}`, instructions: `Do ${id}`, status: "ready", requirements,
    dependencies: [], idempotencyKey: "batch", attemptRunIds: [], createdAt: at, updatedAt: at, ...overrides
  };
}

const evidence = (capabilityId: string, normalizedValue: string, overrides: Partial<NodeCapabilityEvidence> = {}): NodeCapabilityEvidence =>
  ({ capabilityId, source: "runtime", success: true, normalizedValue, observedAt: at, ...overrides });

const report = (nodeId: string, entries: NodeCapabilityEvidence[]): NodeCapabilityReport => ({ nodeId, evidence: entries, at });

interface Fixture {
  state: State;
  connections: Map<string, NodeConnection>;
  reports: Map<string, NodeCapabilityReport>;
  profiles: Map<string, ProjectProfile>;
  packReadiness: Map<string, CapabilityPackReadinessReport>;
}

function fixture(nodes: ComputeNode[], tasks: Task[], seed: Partial<State> = {}): Fixture {
  return {
    state: {
      agents: [], nodes, runs: [], events: [], messages: [], threads: [thread()], tasks,
      instances: [], allocations: [], templates: [], ...seed
    },
    connections: new Map(nodes.map((item) => [item.id, { protocolVersion: "5" as ControlProtocolVersion, synced: true }])),
    reports: new Map(),
    profiles: new Map(),
    packReadiness: new Map()
  };
}

const context = (current: Fixture): SchedulingContext => ({
  connection: (nodeId) => current.connections.get(nodeId),
  capabilityReport: (nodeId) => current.reports.get(nodeId),
  capabilityPackReadiness: (nodeId) => current.packReadiness.get(nodeId),
  projectProfile: (projectId) => current.profiles.get(projectId),
  canDeliver: (_nodeId, message: HubToControlAgent) => message.type === "dispatch"
});

const environment = (current: Fixture): PlacementEnvironment => ({
  agents: current.state.agents,
  nodes: current.state.nodes,
  runs: current.state.runs,
  connection: (nodeId) => current.connections.get(nodeId),
  capabilityReport: (nodeId) => current.reports.get(nodeId),
  capabilityPackReadiness: (nodeId) => current.packReadiness.get(nodeId),
  projectProfile: (projectId) => current.profiles.get(projectId),
  instances: current.state.instances,
  allocations: current.state.allocations,
  templates: current.state.templates,
  residentUsage: (item) => residentInstanceUsage(item, current.state.allocations ?? [], nodeResidencyInState(current.state, item.id)),
  now: at
});

const taskById = (current: Fixture, id: string) => current.state.tasks!.find((item) => item.id === id)!;
const instances = (current: Fixture) => current.state.instances ?? [];
const allocations = (current: Fixture) => current.state.allocations ?? [];
const deliveries = (current: Fixture, kind: "provision" | "release" | "dispatch") =>
  (current.state.instanceDeliveries ?? []).filter((record) => record.kind === kind);
const kinds = (current: Fixture, id: string) => (taskById(current, id).placement?.unsatisfied ?? []).map((entry) => entry.kind);

/** Drives the acknowledgement Barista would send, so a run is only ever created from a ready resident. */
function markReady(current: Fixture, instanceId: string, when = later(10)) {
  const instance = instances(current).find((item) => item.id === instanceId)!;
  const allocation = allocations(current).find((item) => item.instanceId === instanceId)!;
  allocation.status = "active";
  allocation.updatedAt = when;
  instance.status = "ready";
  instance.updatedAt = when;
}

test("a ready task is placed on a live offering with no configured agents and no templates", () => {
  const current = fixture([node("node-alpha")], [task("one")]);
  const first = runSchedulingPass(current.state, context(current), at);

  assert.equal(first.changed, true);
  assert.deepEqual(first.attempts, []);
  assert.equal(current.state.runs.length, 0, "no run exists until the allocation is ready");
  assert.equal(taskById(current, "one").status, "ready");
  assert.equal(instances(current).length, 1);
  const instance = instances(current)[0];
  assert.equal(instance.threadId, "thread-one");
  assert.equal(instance.status, "provisioning");
  assert.equal(taskById(current, "one").placementInstanceId, instance.id);
  // The wait is visible: the resident is still provisioning and holds no active allocation yet.
  assert.deepEqual(kinds(current, "one"), ["instance", "instance"]);
  assert.deepEqual(taskById(current, "one").placement?.unsatisfied.map((entry) => entry.instanceId), [instance.id, instance.id]);
  const allocation = allocations(current)[0];
  assert.deepEqual(
    [allocation.instanceId, allocation.nodeId, allocation.harnessId, allocation.model, allocation.transport, allocation.workspace, allocation.status],
    [instance.id, "node-alpha", "claude-cli", "fable", "native-cli", "/workspace", "reserved"]
  );
  assert.equal(deliveries(current, "provision").length, 1);

  // A task with a pending provisioning instance is never offered again.
  const second = runSchedulingPass(current.state, context(current), later(1));
  assert.equal(second.changed, false);
  assert.equal(instances(current).length, 1);
  assert.equal(allocations(current).length, 1);
});

test("Claude with the Fable model on macOS selects the advertised offering without naming a node", () => {
  const linux = node("node-linux", { platform: "linux · amd64", harnesses: [
    { id: "claude-cli", label: "Claude", description: "", available: true, authMode: "local-subscription", models: ["fable"] }
  ] });
  const mac = node("node-mac");
  const current = fixture([linux, mac], [task("one", { harnessIds: ["claude-cli"], models: ["fable"], operatingSystems: ["darwin"] })]);
  current.reports.set("node-linux", report("node-linux", [evidence("os", "linux")]));
  current.reports.set("node-mac", report("node-mac", [evidence("os", "darwin")]));

  runSchedulingPass(current.state, context(current), at);
  assert.equal(allocations(current).length, 1);
  assert.deepEqual([allocations(current)[0].nodeId, allocations(current)[0].model], ["node-mac", "fable"]);
});

test("a harness that advertises no model offers only the reserved default, never a model it did not name", () => {
  const bare = node("node-bare", { harnesses: [
    { id: "codex-cli", label: "Codex", description: "", available: true, authMode: "local-account", models: [] }
  ] });
  assert.deepEqual(nodeOfferings(bare).map((offering) => offering.model), ["default"]);

  const current = fixture([bare], [task("one", { models: ["fable"] })]);
  runSchedulingPass(current.state, context(current), at);
  assert.equal(allocations(current).length, 0);
  assert.deepEqual(kinds(current, "one"), ["model"]);
});

test("an unavailable harness and an unadvertised transport publish no offering", () => {
  const offline = node("node-off", { harnesses: [
    { id: "claude-cli", label: "Claude", description: "", available: false, authMode: "local-subscription", models: ["fable"] }
  ] });
  assert.deepEqual(nodeOfferings(offline), []);

  const nativeOnly = node("node-native");
  const current = fixture([nativeOnly], [task("one", { transports: ["acp-v1"] })]);
  runSchedulingPass(current.state, context(current), at);
  assert.equal(allocations(current).length, 0);
  assert.deepEqual(kinds(current, "one"), ["transport"]);
});

test("an acp-v1 offering records its native fallback and ranks ahead of the native transport", () => {
  const dual = node("node-dual", { harnesses: [
    { id: "claude-cli", label: "Claude", description: "", available: true, authMode: "local-subscription", models: ["fable"], transports: ["native-cli", "acp-v1"] }
  ] });
  assert.deepEqual(nodeOfferings(dual).map((offering) => [offering.transport, offering.fallbackTransport]), [
    ["acp-v1", "native-cli"],
    ["native-cli", undefined]
  ]);
  const current = fixture([dual], [task("one")]);
  runSchedulingPass(current.state, context(current), at);
  assert.equal(allocations(current)[0].transport, "acp-v1");
});

test("run concurrency and resident capacity are enforced independently", () => {
  const busyRuns = fixture([node("node-alpha", { concurrency: 1, activeRuns: 1 })], [task("one")]);
  runSchedulingPass(busyRuns.state, context(busyRuns), at);
  assert.equal(allocations(busyRuns).length, 0, "a full run slot creates no reservation");
  assert.deepEqual(kinds(busyRuns, "one"), ["capacity"]);

  const busyResidents = fixture([node("node-alpha", { instanceCapacity: 1, activeInstances: 1 })], [task("one")]);
  runSchedulingPass(busyResidents.state, context(busyResidents), at);
  assert.equal(allocations(busyResidents).length, 0, "a full resident slot creates no reservation");
  assert.deepEqual(kinds(busyResidents, "one"), ["resident-capacity"]);

  const incapable = fixture([node("node-alpha", { instanceCapacity: 0 })], [task("one")]);
  runSchedulingPass(incapable.state, context(incapable), at);
  assert.deepEqual(kinds(incapable, "one"), ["resident-capacity"]);
});

test("one pass never overbooks resident capacity across parallel ready tasks", () => {
  const current = fixture([node("node-alpha", { instanceCapacity: 1 })], [task("one"), task("two")]);
  runSchedulingPass(current.state, context(current), at);
  assert.equal(instances(current).length, 1, "only one resident is requested");
  assert.equal(allocations(current).length, 1);
  assert.equal(taskById(current, "one").placementInstanceId, instances(current)[0].id);
  assert.equal(taskById(current, "two").placementInstanceId, undefined);
  assert.deepEqual(kinds(current, "two"), ["resident-capacity"]);
});

test("the first run is created and dispatched only once the allocation is ready, and never twice", () => {
  const current = fixture([node("node-alpha")], [task("one")]);
  runSchedulingPass(current.state, context(current), at);
  const instance = instances(current)[0];
  markReady(current, instance.id);

  const result = runSchedulingPass(current.state, context(current), later(20));
  assert.equal(result.attempts.length, 1);
  assert.deepEqual(result.attempts[0], { taskId: "one", runId: current.state.runs[0].id, nodeId: "node-alpha", instanceId: instance.id, delivered: false });
  const run = current.state.runs[0];
  assert.deepEqual([run.instanceId, run.allocationId, run.agentId, run.taskId, run.attempt, run.status, run.transport, run.workspace],
    [instance.id, allocations(current)[0].id, undefined, "one", 1, "queued", "native-cli", "/workspace"],
    "an instance run carries no agent key: an instance id is never written into an agent-typed field");
  assert.equal(taskById(current, "one").assignment?.agentId, undefined, "nor does its assignment");
  assert.equal(run.dispatchedAt, undefined, "the dispatch is a persisted command, not a direct send");
  assert.equal(taskById(current, "one").status, "assigned");
  assert.deepEqual([taskById(current, "one").assignment?.instanceId, taskById(current, "one").assignment?.allocationId],
    [instance.id, allocations(current)[0].id]);
  assert.equal(taskById(current, "one").placementInstanceId, undefined);
  assert.equal(instances(current)[0].status, "busy");

  const dispatches = deliveries(current, "dispatch");
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].nodeId, "node-alpha");
  assert.equal(validateInstanceHubMessage(dispatches[0].message, "5").ok, true, "the persisted dispatch is wire-valid");
  assert.equal(validateInstanceHubMessage(dispatches[0].message, "4").ok, false, "a version-4 node can never receive it");

  const again = runSchedulingPass(current.state, context(current), later(30));
  assert.deepEqual(again.attempts, []);
  assert.equal(current.state.runs.length, 1);
  assert.equal(deliveries(current, "dispatch").length, 1);
});

test("the persisted dispatch carries exactly the version-5 keys the producer's own fixture carries", () => {
  const current = fixture([node("node-alpha")], [task("one")]);
  runSchedulingPass(current.state, context(current), at);
  markReady(current, instances(current)[0].id);
  runSchedulingPass(current.state, context(current), later(20));
  const command = deliveries(current, "dispatch")[0].message as unknown as { run: Record<string, unknown> };
  const reference = controlFixture("dispatch").run as Record<string, unknown>;
  assert.equal(Object.hasOwn(command.run, "agentId"), false, "an instance run never carries the compatibility agent key on the wire");
  for (const key of Object.keys(reference)) assert.ok(Object.hasOwn(command.run, key), `the dispatch run is missing ${key}`);
});

test("a compatible same-thread resident is reused and a foreign or incompatible one never is", () => {
  const reusable: AgentInstance = {
    id: "instance-reuse", threadId: "thread-one", creator: { kind: "operator", operatorId: "operator" },
    delegation: { canDelegate: false }, requirements: {}, lease: { idleTimeoutSeconds: 1800, expiresAt: later(1800) },
    status: "idle", createdAt: at, updatedAt: at
  };
  const foreign: AgentInstance = { ...reusable, id: "instance-foreign", threadId: "thread-two" };
  const allocation = (instanceId: string, overrides: Partial<InstanceAllocation> = {}): InstanceAllocation => ({
    id: `allocation-${instanceId}`, instanceId, nodeId: "node-alpha", harnessId: "claude-cli", model: "fable",
    transport: "native-cli", workspace: "/workspace", lease: { idleTimeoutSeconds: 1800, expiresAt: later(1800) },
    status: "active", createdAt: at, updatedAt: at, ...overrides
  });
  const current = fixture([node("node-alpha")], [task("one")], {
    instances: [foreign, reusable],
    allocations: [allocation("instance-reuse"), allocation("instance-foreign", { id: "allocation-foreign" })],
    threads: [thread(), { ...thread("thread-two") }]
  });
  runSchedulingPass(current.state, context(current), at);
  assert.equal(instances(current).length, 2, "reuse requests no new resident");
  assert.equal(current.state.runs[0].instanceId, "instance-reuse");

  // A resident whose allocation cannot serve the task's hard requirements is never substituted.
  const incompatible = fixture([node("node-alpha")], [task("two", { models: ["sonnet"] })], {
    instances: [reusable], allocations: [allocation("instance-reuse")]
  });
  runSchedulingPass(incompatible.state, context(incompatible), at);
  assert.equal(incompatible.state.runs.length, 0);
  assert.ok(kinds(incompatible, "two").includes("model"));

  // A resident already carrying an active run is not available for a second attempt.
  const occupied = fixture([node("node-alpha")], [task("three")], {
    instances: [reusable],
    allocations: [allocation("instance-reuse")],
    runs: [{
      id: "run-busy", threadId: "thread-one", agentId: "instance-reuse", instanceId: "instance-reuse",
      allocationId: "allocation-instance-reuse", nodeId: "node-alpha", harnessId: "claude-cli", model: "fable",
      workspace: "/workspace", prompt: "", status: "running", output: "", depth: 0, createdAt: at, transport: "native-cli"
    } as Run]
  });
  runSchedulingPass(occupied.state, context(occupied), at);
  assert.equal(occupied.state.runs.length, 1, "no second attempt is created on the busy resident");
  assert.equal(instances(occupied).length, 2, "a fresh resident is requested instead of reusing the busy one");
  assert.equal(taskById(occupied, "three").placementInstanceId, instances(occupied).find((item) => item.id !== "instance-reuse")!.id);
});

test("an explicit instance pin is authorized and exact", () => {
  const ready: AgentInstance = {
    id: "instance-pin", threadId: "thread-one", creator: { kind: "operator", operatorId: "operator" },
    delegation: { canDelegate: false }, requirements: {}, lease: { idleTimeoutSeconds: 1800, expiresAt: later(1800) },
    status: "ready", createdAt: at, updatedAt: at
  };
  const other: AgentInstance = { ...ready, id: "instance-other" };
  const allocationFor = (instanceId: string): InstanceAllocation => ({
    id: `allocation-${instanceId}`, instanceId, nodeId: "node-alpha", harnessId: "claude-cli", model: "fable",
    transport: "native-cli", workspace: "/workspace", lease: { ...ready.lease }, status: "active", createdAt: at, updatedAt: at
  });
  const pin = (instanceId: string): PlacementOverride => ({ instanceId, authorizedBy: "operator" });

  const pinned = fixture([node("node-alpha")], [task("one", {}, { placementOverride: pin("instance-pin") })], {
    instances: [other, ready], allocations: [allocationFor("instance-other"), allocationFor("instance-pin")]
  });
  runSchedulingPass(pinned.state, context(pinned), at);
  assert.equal(pinned.state.runs[0].instanceId, "instance-pin", "the pin is honored exactly");

  const missing = fixture([node("node-alpha")], [task("one", {}, { placementOverride: pin("ghost") })]);
  runSchedulingPass(missing.state, context(missing), at);
  assert.equal(missing.state.runs.length, 0);
  assert.equal(instances(missing).length, 0, "a failed pin never substitutes an offering");
  assert.deepEqual(kinds(missing, "one"), ["instance"]);

  const draining = fixture([node("node-alpha")], [task("one", {}, { placementOverride: pin("instance-pin") })], {
    instances: [{ ...ready, status: "draining" }], allocations: [allocationFor("instance-pin")]
  });
  runSchedulingPass(draining.state, context(draining), at);
  assert.equal(draining.state.runs.length, 0);
  assert.equal(instances(draining).length, 1);
  assert.deepEqual(kinds(draining, "one"), ["instance"]);

  const foreign = fixture([node("node-alpha")], [task("one", {}, { placementOverride: pin("instance-pin") })], {
    instances: [{ ...ready, threadId: "thread-two" }], allocations: [allocationFor("instance-pin")]
  });
  runSchedulingPass(foreign.state, context(foreign), at);
  assert.equal(foreign.state.runs.length, 0);
  assert.deepEqual(kinds(foreign, "one"), ["instance"]);

  // A pin whose instance is still coming up waits on it rather than reserving a second resident.
  const waiting = fixture([node("node-alpha")], [task("one", {}, { placementOverride: pin("instance-pin") })], {
    instances: [{ ...ready, status: "provisioning" }], allocations: [allocationFor("instance-pin")]
  });
  runSchedulingPass(waiting.state, context(waiting), at);
  assert.equal(allocations(waiting).length, 1);
  assert.equal(waiting.state.runs.length, 0);

  // An override naming both candidate spaces is malformed, never resolved in favor of either.
  const ambiguous = fixture([node("node-alpha")], [
    task("one", {}, { placementOverride: { instanceId: "instance-pin", agentId: "alpha", authorizedBy: "operator" } })
  ], { instances: [ready], allocations: [allocationFor("instance-pin")] });
  runSchedulingPass(ambiguous.state, context(ambiguous), at);
  assert.equal(ambiguous.state.runs.length, 0);
  assert.deepEqual(kinds(ambiguous, "one"), ["agent"]);
});

test("a lifecycle-requested instance reserves an offering before its exact initial task runs", () => {
  const requested: AgentInstance = {
    id: "instance-requested", threadId: "thread-one", creator: { kind: "operator", operatorId: "operator" },
    delegation: { canDelegate: false }, requirements: { harnessIds: ["claude-cli"], models: ["fable"] },
    lease: { idleTimeoutSeconds: 1800, expiresAt: later(1800) }, status: "requested", createdAt: at, updatedAt: at
  };
  const current = fixture([node("node-alpha")], [task("initial", requested.requirements, {
    placementOverride: { instanceId: requested.id, authorizedBy: "policy" }
  })], { instances: [requested] });

  const first = runSchedulingPass(current.state, context(current), at);
  assert.equal(first.changed, true);
  assert.equal(instances(current).length, 1, "the lifecycle identity is reused rather than duplicated");
  assert.equal(instances(current)[0].status, "provisioning");
  assert.equal(allocations(current).length, 1);
  assert.equal(allocations(current)[0].instanceId, requested.id);
  assert.equal(deliveries(current, "provision").length, 1);
  assert.equal(current.state.runs.length, 0, "dispatch waits for the exact ready acknowledgement");
  assert.equal(taskById(current, "initial").placementOverride?.instanceId, requested.id);

  const second = runSchedulingPass(current.state, context(current), later(1));
  assert.equal(second.changed, false);
  assert.equal(allocations(current).length, 1, "a repeated pass cannot reserve twice");
});

test("a requested exact pin reports hard offering mismatch without agent fallback", () => {
  const requested: AgentInstance = {
    id: "instance-requested", threadId: "thread-one", creator: { kind: "operator", operatorId: "operator" },
    delegation: { canDelegate: false }, requirements: { models: ["other-model"] },
    lease: { idleTimeoutSeconds: 1800, expiresAt: later(1800) }, status: "requested", createdAt: at, updatedAt: at
  };
  const current = fixture([node("node-alpha")], [task("initial", requested.requirements, {
    placementOverride: { instanceId: requested.id, authorizedBy: "policy" }
  })], { instances: [requested] });

  runSchedulingPass(current.state, context(current), at);
  assert.equal(allocations(current).length, 0);
  assert.equal(current.state.runs.length, 0);
  assert.ok(kinds(current, "initial").includes("model"));
});

test("a standalone requested instance persists an actionable placement refusal", () => {
  const requested: AgentInstance = {
    id: "instance-requested", threadId: "thread-one", creator: { kind: "operator", operatorId: "operator" },
    delegation: { canDelegate: false }, requirements: { models: ["not-offered"] },
    lease: { idleTimeoutSeconds: 1800, expiresAt: later(1800) }, status: "requested", createdAt: at, updatedAt: at
  };
  const current = fixture([node("node-alpha")], [], { instances: [requested] });
  assert.equal(runSchedulingPass(current.state, context(current), at).changed, true);
  assert.equal(allocations(current).length, 0);
  const refusal = current.state.events.find((event) => event.instanceId === requested.id && event.title === "Instance placement waiting");
  assert.match(refusal?.detail ?? "", /not-offered|different model/);
  assert.equal(runSchedulingPass(current.state, context(current), later(1)).changed, false, "the same refusal is persisted once, not appended every pass");
  current.connections.delete("node-alpha");
  assert.equal(runSchedulingPass(current.state, context(current), later(2)).changed, true);
  current.connections.set("node-alpha", { protocolVersion: "5", synced: true });
  assert.equal(runSchedulingPass(current.state, context(current), later(3)).changed, true);
  assert.equal(current.state.events.filter((event) => event.instanceId === requested.id && event.title === "Instance placement waiting").length, 1,
    "alternating refusal details update one bounded projected diagnostic");
});

test("a requested template instance reserves from effective hard skills and carries their expectation", () => {
  const template: AgentTemplate = {
    id: "template-review", name: "Review", skills: ["descriptive-only"], requirements: { skills: ["review"] }
  };
  const requested: AgentInstance = {
    id: "instance-requested", threadId: "thread-one", creator: { kind: "operator", operatorId: "operator" },
    delegation: { canDelegate: false }, requirements: { templateId: template.id, skills: ["review"] },
    lease: { idleTimeoutSeconds: 1800, expiresAt: later(1800) }, status: "requested", createdAt: at, updatedAt: at
  };
  const current = fixture([node("node-alpha")], [], { instances: [requested], templates: [template] });
  current.state.allocations = [{
    id: "allocation-lost", instanceId: requested.id, nodeId: "node-alpha", harnessId: "claude-cli", model: "fable",
    transport: "native-cli", workspace: "/workspace", lease: { ...requested.lease }, status: "lost", createdAt: at, updatedAt: at
  }];
  current.packReadiness.set("node-alpha", {
    nodeId: "node-alpha", observedAt: at, status: "available", pack: { id: "coffee-shop-core", version: "1.0.0", skills: ["review"] },
    surfaces: [{ harnessId: "claude-cli", transport: "native-cli" }]
  });
  runSchedulingPass(current.state, context(current), at);
  assert.equal(instances(current)[0].id, requested.id);
  assert.equal(allocations(current).length, 2, "the lost generation is retained beside its replacement");
  assert.deepEqual(allocations(current).find((item) => item.status === "reserved")?.expectedCapabilityPack,
    { id: "coffee-shop-core", version: "1.0.0", requiredSkills: ["review"] });
});

test("a persisted pre-materialization template instance enforces every hard requirement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-legacy-template-"));
  const path = join(directory, "state.json");
  const persisted = new Store(path);
  await persisted.load();
  const template: AgentTemplate = {
    id: "template-review", name: "Review", skills: ["descriptive-only"],
    requirements: { harnessIds: ["codex-cli"], minimumConcurrency: 2, skills: ["review"] }
  };
  const requested: AgentInstance = {
    id: "instance-requested", threadId: "thread-one", creator: { kind: "operator", operatorId: "operator" },
    delegation: { canDelegate: false }, requirements: { templateId: template.id, skills: [" Preview ", "PREVIEW"] },
    lease: { idleTimeoutSeconds: 1800, expiresAt: later(1800) }, status: "requested", createdAt: at, updatedAt: at
  };
  await persisted.transact((state) => {
    state.threads = [thread()];
    state.nodes = [node("node-alpha")];
    state.templates = [template];
    state.instances = [requested];
    return true;
  });
  const legacyState = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  delete legacyState.instanceRequirementsVersion;
  await writeFile(path, JSON.stringify(legacyState));
  const reloaded = new Store(path);
  await reloaded.load();
  const state = reloaded.read((value) => structuredClone(value));
  const current = fixture(state.nodes, state.tasks ?? [], state);
  current.packReadiness.set("node-alpha", {
    nodeId: "node-alpha", observedAt: at, status: "available",
    pack: { id: "coffee-shop-core", version: "1.0.0", skills: ["preview", "review"] },
    surfaces: [{ harnessId: "codex-cli", transport: "native-cli" }]
  });
  runSchedulingPass(current.state, context(current), at);
  assert.equal(allocations(current).length, 0);
  assert.equal(current.state.events.some((event) => event.title === "Instance placement waiting" && event.detail.includes("harness")), true);

  current.state.nodes[0].harnesses = [{ id: "codex-cli", label: "Codex", description: "", available: true, authMode: "local-account", models: ["fable"] }];
  current.state.nodes[0].concurrency = 1;
  runSchedulingPass(current.state, context(current), later(1));
  assert.equal(allocations(current).length, 0);
  assert.equal(current.state.events.some((event) => event.title === "Instance placement waiting" && event.detail.includes("concurrency")), true);

  current.state.nodes[0].concurrency = 2;
  runSchedulingPass(current.state, context(current), later(2));
  assert.deepEqual(current.state.instances![0].requirements.skills, ["preview", "review"]);
  assert.deepEqual(allocations(current)[0].expectedCapabilityPack,
    { id: "coffee-shop-core", version: "1.0.0", requiredSkills: ["preview", "review"] });
  assert.equal(current.state.events.some((event) => event.title === "Instance placement waiting"), false);
});

test("a requested instance whose persisted template was deleted remains fail closed", () => {
  const requested: AgentInstance = {
    id: "instance-requested", threadId: "thread-one", creator: { kind: "operator", operatorId: "operator" },
    delegation: { canDelegate: false }, requirements: { templateId: "template-deleted" },
    lease: { idleTimeoutSeconds: 1800, expiresAt: later(1800) }, status: "requested", createdAt: at, updatedAt: at
  };
  const current = fixture([node("node-alpha")], [], { instances: [requested] });
  runSchedulingPass(current.state, context(current), at);
  assert.equal(allocations(current).length, 0);
  assert.equal(current.state.events.some((event) =>
    event.instanceId === requested.id && event.title === "Instance placement waiting" && event.detail.includes("template-deleted")), true);
});

test("lost-allocation re-reservation unions the task and instance hard skills", () => {
  const requested: AgentInstance = {
    id: "instance-requested", threadId: "thread-one", creator: { kind: "operator", operatorId: "operator" },
    delegation: { canDelegate: false }, requirements: { skills: ["review"] },
    lease: { idleTimeoutSeconds: 1800, expiresAt: later(1800) }, status: "requested", createdAt: at, updatedAt: at
  };
  const pinned = task("one", { skills: ["PREVIEW"] }, {
    placementInstanceId: requested.id,
    placementOverride: { instanceId: requested.id, authorizedBy: "policy" }
  });
  const current = fixture([node("node-alpha")], [pinned], {
    instances: [requested], allocations: [{
      id: "allocation-lost", instanceId: requested.id, nodeId: "node-alpha", harnessId: "claude-cli", model: "fable",
      transport: "native-cli", workspace: "/workspace", lease: { ...requested.lease }, status: "lost", createdAt: at, updatedAt: at
    }]
  });
  current.packReadiness.set("node-alpha", {
    nodeId: "node-alpha", observedAt: at, status: "available", pack: { id: "coffee-shop-core", version: "1.0.0", skills: ["preview", "review"] },
    surfaces: [{ harnessId: "claude-cli", transport: "native-cli" }]
  });
  runSchedulingPass(current.state, context(current), at);
  assert.deepEqual(allocations(current).find((item) => item.status === "reserved")?.expectedCapabilityPack,
    { id: "coffee-shop-core", version: "1.0.0", requiredSkills: ["preview", "review"] });

  const missing = fixture([node("node-alpha")], [structuredClone(pinned)], {
    instances: [{ ...structuredClone(requested), status: "requested" }],
    allocations: current.state.allocations!.filter((item) => item.status === "lost").map((item) => structuredClone(item))
  });
  missing.packReadiness.set("node-alpha", {
    nodeId: "node-alpha", observedAt: at, status: "available", pack: { id: "coffee-shop-core", version: "1.0.0", skills: ["preview"] },
    surfaces: [{ harnessId: "claude-cli", transport: "native-cli" }]
  });
  runSchedulingPass(missing.state, context(missing), at);
  assert.equal(allocations(missing).some((item) => item.status === "reserved"), false);
  assert.equal(taskById(missing, "one").placement?.unsatisfied.some((entry) => entry.kind === "skill" && entry.requirement.includes("review")), true);
  assert.equal(missing.state.events.filter((event) => event.instanceId === requested.id && event.title === "Instance placement waiting").length, 1);
  assert.equal(runSchedulingPass(missing.state, context(missing), later(1)).changed, false);
});

test("a failed or draining allocation releases the placement and the retry gets fresh identities", () => {
  const current = fixture([node("node-alpha", { instanceCapacity: 2 })], [task("one")]);
  runSchedulingPass(current.state, context(current), at);
  const first = instances(current)[0];
  const firstAllocation = allocations(current)[0];

  // Barista reported a provision failure: the records stay as immutable history.
  first.status = "failed";
  firstAllocation.status = "failed";
  const retry = runSchedulingPass(current.state, context(current), later(5));
  assert.equal(retry.changed, true);
  assert.equal(current.state.runs.length, 0, "no run was created for the failed allocation");
  assert.equal(instances(current).length, 2, "the retry received a new instance identity");
  assert.equal(allocations(current).length, 2, "the retry received a new allocation identity");
  const replacement = instances(current).find((item) => item.id !== first.id)!;
  assert.equal(taskById(current, "one").placementInstanceId, replacement.id);
  assert.equal(instances(current).find((item) => item.id === first.id)!.status, "failed");
});

test("an allocation lost before ready is replaced on the same instance identity", () => {
  const current = fixture([node("node-alpha")], [task("one")]);
  runSchedulingPass(current.state, context(current), at);
  const instance = instances(current)[0];
  const lost = allocations(current)[0];

  // Reconciliation marked the allocation lost and returned the instance to `requested` (#73/#75).
  lost.status = "lost";
  instance.status = "requested";
  const replaced = runSchedulingPass(current.state, context(current), later(5));
  assert.equal(replaced.changed, true);
  assert.equal(instances(current).length, 1, "instance identity survives allocation loss");
  assert.equal(allocations(current).length, 2);
  const current2 = allocations(current).find((item) => item.status === "reserved")!;
  assert.notEqual(current2.id, lost.id, "a replacement always has a new allocation id");
  assert.equal(current2.instanceId, instance.id);
  assert.equal(taskById(current, "one").placementInstanceId, instance.id);
});

test("a lost allocation with nowhere to go keeps waiting instead of abandoning the instance", () => {
  const current = fixture([node("node-alpha", { instanceCapacity: 1, activeInstances: 1 })], [task("one")], {
    instances: [{
      id: "instance-lost", threadId: "thread-one", creator: { kind: "operator", operatorId: "operator" },
      delegation: { canDelegate: false }, requirements: {}, lease: { idleTimeoutSeconds: 1800, expiresAt: later(1800) },
      status: "requested", createdAt: at, updatedAt: at
    }]
  });
  current.state.tasks![0].placementInstanceId = "instance-lost";
  runSchedulingPass(current.state, context(current), at);
  assert.equal(taskById(current, "one").placementInstanceId, "instance-lost");
  assert.equal(allocations(current).length, 0);
  assert.ok(kinds(current, "one").includes("resident-capacity"));
});

test("a disconnected, unsynchronized, version-4, or stale node publishes no eligible offering", () => {
  const cases: Array<{ label: string; prepare: (current: Fixture) => void; expected: string[] }> = [
    { label: "disconnected", prepare: (current) => current.connections.delete("node-alpha"), expected: ["node-offline"] },
    { label: "unsynchronized", prepare: (current) => current.connections.set("node-alpha", { protocolVersion: "5", synced: false }), expected: ["node-offline"] },
    { label: "version 4", prepare: (current) => current.connections.set("node-alpha", { protocolVersion: "4", synced: true }), expected: ["protocol-version"] },
    { label: "offline node record", prepare: (current) => { current.state.nodes[0].status = "offline"; }, expected: ["node-offline"] }
  ];
  for (const testCase of cases) {
    const current = fixture([node("node-alpha")], [task("one")]);
    testCase.prepare(current);
    runSchedulingPass(current.state, context(current), at);
    assert.equal(allocations(current).length, 0, testCase.label);
    assert.deepEqual(kinds(current, "one"), testCase.expected, testCase.label);
  }

  const realV4Shape = fixture([node("node-alpha", { instanceCapacity: undefined, activeInstances: undefined })], [task("one")]);
  realV4Shape.connections.set("node-alpha", { protocolVersion: "4", synced: true });
  runSchedulingPass(realV4Shape.state, context(realV4Shape), at);
  assert.equal(allocations(realV4Shape).length, 0);
  assert.ok(kinds(realV4Shape, "one").includes("protocol-version"), "an exact v4 node remains visible as an explicit exclusion");

  const stale = fixture([node("node-alpha")], [task("one", { operatingSystems: ["darwin"] })]);
  stale.reports.set("node-alpha", report("node-alpha", [evidence("os", "darwin", { observedAt: "2026-09-20T12:00:00.000Z" })]));
  runSchedulingPass(stale.state, context(stale), at);
  assert.equal(allocations(stale).length, 0);
  assert.deepEqual(kinds(stale, "one"), ["inventory-stale"]);
});

test("a project profile requesting workspace isolation is never placed on a resident instance", () => {
  const profile: ProjectProfile = {
    schemaVersion: 1, id: "project-one", name: "Project",
    repository: { url: "https://example.com/repo.git", defaultBranch: "main" },
    workspacePolicy: { isolation: "git-worktree", cleanup: "retain", requireWritable: true },
    requirements: { hard: {} }
  };
  const current = fixture([node("node-alpha")], [task("one", { projectProfileId: "project-one" })]);
  current.profiles.set("project-one", profile);
  runSchedulingPass(current.state, context(current), at);
  assert.equal(allocations(current).length, 0);
  assert.equal(instances(current).length, 0);
  assert.ok(kinds(current, "one").includes("workspace"), "the lease exclusion is reported as a workspace failure");
});

test("a workspace the node does not authorize yields a diagnostic and no reservation", () => {
  const current = fixture([node("node-alpha")], [task("one", { workspace: { path: "/elsewhere/project", writable: true } })]);
  assert.equal(offeredWorkspace(node("node-alpha"), "/elsewhere/project"), undefined);
  runSchedulingPass(current.state, context(current), at);
  assert.equal(instances(current).length, 0, "no instance or allocation side effect survives a workspace denial");
  assert.equal(allocations(current).length, 0);
  assert.deepEqual(kinds(current, "one"), ["workspace"]);
});

test("preferences only rank eligible offerings and never weaken a hard requirement", () => {
  const twoModels = (id: string) => node(id, { harnesses: [
    { id: "claude-cli", label: "Claude", description: "", available: true, authMode: "local-subscription", models: ["fable", "sonnet"] }
  ] });
  const preferred = fixture([twoModels("node-alpha"), twoModels("node-beta")], [
    task("one", { preferences: { nodeIds: ["node-beta"], models: ["sonnet"] } })
  ]);
  runSchedulingPass(preferred.state, context(preferred), at);
  assert.deepEqual([allocations(preferred)[0].nodeId, allocations(preferred)[0].model], ["node-beta", "sonnet"]);

  // A preference for a model the requirements exclude cannot resurrect it.
  const hard = fixture([twoModels("node-alpha")], [task("one", { models: ["fable"], preferences: { models: ["sonnet"] } })]);
  runSchedulingPass(hard.state, context(hard), at);
  assert.equal(allocations(hard)[0].model, "fable");
});

test("identical state yields identical placement and input order never decides it", () => {
  const build = (order: "forward" | "reverse") => {
    const nodes = [node("node-alpha"), node("node-beta")];
    return fixture(order === "forward" ? nodes : [...nodes].reverse(), [task("one")]);
  };
  const forward = placeTask(taskById(build("forward"), "one"), environment(build("forward")));
  const reverse = placeTask(taskById(build("reverse"), "one"), environment(build("reverse")));
  assert.equal(forward.kind, "offering");
  assert.deepEqual(forward, reverse);

  const repeated = build("forward");
  const first = placeTask(taskById(repeated, "one"), environment(repeated));
  const second = placeTask(taskById(repeated, "one"), environment(repeated));
  assert.deepEqual(first, second);
});

test("diagnostics for an unplaceable task are deterministic, deduplicated, and carry no workspace path", () => {
  const build = () => {
    const current = fixture([node("node-alpha"), node("node-beta")], [task("one", { models: ["ghost"], labels: ["gpu"] })]);
    return current;
  };
  const first = build();
  runSchedulingPass(first.state, context(first), at);
  const second = build();
  runSchedulingPass(second.state, context(second), at);
  assert.deepEqual(taskById(first, "one").placement, taskById(second, "one").placement);
  const entries = taskById(first, "one").placement!.unsatisfied;
  assert.deepEqual([...new Set(entries.map((entry) => entry.kind))].sort(), ["label", "model"]);
  assert.deepEqual([...entries].sort((left, right) => JSON.stringify(left) < JSON.stringify(right) ? -1 : 1), entries.slice().sort((left, right) => JSON.stringify(left) < JSON.stringify(right) ? -1 : 1));
  assert.equal(JSON.stringify(entries).includes("/workspace"), false);
});

test("a task naming a template may be placed only through that template, and the template only narrows", () => {
  const template: AgentTemplate = {
    id: "template-reviewer", name: "Reviewer", skills: ["rust"],
    purpose: { title: "Quality", summary: "Checks exact work" }, instructions: "Review carefully",
    requirements: { models: ["fable"], labels: ["gpu"] },
    preferences: { nodeIds: ["node-beta"] }, delegation: { canDelegate: true }
  };
  const merged = requirementsThroughTemplate({ models: ["fable", "sonnet"], minimumConcurrency: 1 }, template);
  assert.deepEqual(merged.models, ["fable"], "accepted sets intersect");
  assert.deepEqual(merged.labels, ["gpu"], "required labels unite");
  assert.equal(merged.minimumConcurrency, 1);
  assert.equal(merged.templateId, "template-reviewer");

  const placed = fixture([node("node-alpha")], [task("one", { templateId: "template-reviewer", skills: ["rust"] })], { templates: [template] });
  placed.reports.set("node-alpha", report("node-alpha", [evidence("label:gpu", "true")]));
  placed.packReadiness.set("node-alpha", {
    nodeId: "node-alpha", observedAt: at, status: "available", pack: { id: "coffee-shop-core", version: "1.0.0", skills: ["rust"] },
    surfaces: [{ harnessId: "claude-cli", transport: "native-cli" }]
  });
  runSchedulingPass(placed.state, context(placed), at);
  assert.equal(allocations(placed).length, 1);
  assert.equal(instances(placed)[0].requirements.templateId, "template-reviewer");
  assert.deepEqual(instances(placed)[0].requirements.models, ["fable"]);
  assert.deepEqual(instances(placed)[0].purpose, { title: "Quality", summary: "Checks exact work", instructions: "Review carefully" });
  assert.deepEqual(instances(placed)[0].delegation, { canDelegate: true });

  // The template's own hard requirement is not negotiable.
  const unmet = fixture([node("node-alpha")], [task("one", { templateId: "template-reviewer" })], { templates: [template] });
  unmet.packReadiness.set("node-alpha", placed.packReadiness.get("node-alpha")!);
  runSchedulingPass(unmet.state, context(unmet), at);
  assert.equal(allocations(unmet).length, 0);
  assert.deepEqual(kinds(unmet, "one"), ["label"]);

  const ghost = fixture([node("node-alpha")], [task("one", { templateId: "ghost" })], { templates: [template] });
  runSchedulingPass(ghost.state, context(ghost), at);
  assert.deepEqual(kinds(ghost, "one"), ["template"]);

  const wrongSkill = fixture([node("node-alpha")], [task("one", { templateId: "template-reviewer", skills: ["go"] })], { templates: [template] });
  runSchedulingPass(wrongSkill.state, context(wrongSkill), at);
  assert.deepEqual(kinds(wrongSkill, "one"), ["template"]);
});

test("template display skills never become hard readiness requirements", () => {
  const descriptive: AgentTemplate = {
    id: "template-descriptive", name: "Historian", skills: ["legacy-metadata"],
    requirements: { models: ["fable"] }
  };
  const current = fixture([node("node-alpha")], [task("one", { templateId: descriptive.id })], { templates: [descriptive] });
  runSchedulingPass(current.state, context(current), at);
  assert.equal(allocations(current).length, 1);
  assert.equal(allocations(current)[0].expectedCapabilityPack, undefined);
  assert.equal(instances(current)[0].requirements.skills, undefined);
});

test("effective skill requirements normalize once before template admission and readiness", () => {
  const template: AgentTemplate = {
    id: "template-review", name: "Reviewer", skills: ["review", "preview"],
    requirements: { skills: ["PREVIEW"] }
  };
  const current = fixture([node("node-alpha")], [task("one", { templateId: template.id, skills: [" Review ", "PREVIEW", "review"] })], { templates: [template] });
  current.packReadiness.set("node-alpha", {
    nodeId: "node-alpha", observedAt: at, status: "available",
    pack: { id: "coffee-shop-core", version: "1.0.0", skills: ["preview", "review"] },
    surfaces: [{ harnessId: "claude-cli", transport: "native-cli" }]
  });
  runSchedulingPass(current.state, context(current), at);
  assert.deepEqual(instances(current)[0].requirements.skills, ["preview", "review"]);
  assert.deepEqual(allocations(current)[0].expectedCapabilityPack?.requiredSkills, ["preview", "review"]);
});

test("bare skills use only live current-socket pack readiness and persist the exact expectation", () => {
  const rust: AgentTemplate = { id: "template-a-rust", name: "Rust", skills: ["rust"] };
  const alsoRust: AgentTemplate = { id: "template-b-rust", name: "Rust too", skills: ["rust", "go"] };
  assert.deepEqual(resolveTaskTemplate(task("one", { skills: ["rust"] }), [alsoRust, rust]), { kind: "none" });

  const placed = fixture([node("node-alpha")], [task("one", { skills: ["rust"] })], { templates: [alsoRust, rust] });
  placed.packReadiness.set("node-alpha", {
    nodeId: "node-alpha", observedAt: at, status: "available",
    pack: { id: "coffee-shop-core", version: "1.0.0", skills: ["go", "rust"] },
    surfaces: [{ harnessId: "claude-cli", transport: "native-cli" }]
  });
  runSchedulingPass(placed.state, context(placed), at);
  assert.equal(instances(placed)[0].requirements.templateId, undefined);
  assert.deepEqual(allocations(placed)[0].expectedCapabilityPack, {
    id: "coffee-shop-core", version: "1.0.0", requiredSkills: ["rust"]
  });

  const gap = fixture([node("node-alpha")], [task("one", { skills: ["cobol"] })], { templates: [rust] });
  runSchedulingPass(gap.state, context(gap), at);
  assert.equal(instances(gap).length, 0, "stored template or inventory metadata never substitutes for live readiness");
  assert.deepEqual(kinds(gap, "one"), ["skill"]);
});

test("resident reuse requires the same current pack identity and a covering admitted subset", () => {
  const resident: AgentInstance = {
    id: "instance-pack-v1", threadId: "thread-one", creator: { kind: "operator", operatorId: "operator" },
    delegation: { canDelegate: false }, requirements: { skills: ["rust"] },
    lease: { idleTimeoutSeconds: 1800, expiresAt: later(1800) }, status: "idle", createdAt: at, updatedAt: at
  };
  const allocation: InstanceAllocation = {
    id: "allocation-pack-v1", instanceId: resident.id, nodeId: "node-alpha", harnessId: "claude-cli", model: "fable",
    transport: "native-cli", workspace: "/workspace", expectedCapabilityPack: { id: "coffee-shop-core", version: "1.0.0", requiredSkills: ["rust"] },
    lease: { ...resident.lease }, status: "active", createdAt: at, updatedAt: at
  };
  const current = fixture([node("node-alpha")], [task("one", { skills: ["rust"] })], {
    instances: [resident], allocations: [allocation]
  });
  current.packReadiness.set("node-alpha", {
    nodeId: "node-alpha", observedAt: later(1), status: "available",
    pack: { id: "coffee-shop-core", version: "2.0.0", skills: ["rust"] },
    surfaces: [{ harnessId: "claude-cli", transport: "native-cli" }]
  });
  runSchedulingPass(current.state, context(current), later(1));
  assert.equal(current.state.runs.length, 0, "the old resident is never dispatched after readiness rotates");
  assert.equal(resident.status, "draining", "the stale allocation is retired instead of remaining reusable history");
  assert.equal(current.state.instanceDeliveries?.some((entry) => entry.kind === "release" && entry.allocationId === allocation.id), true);
  assert.equal(instances(current).length, 2, "placement requests a replacement resident");
  assert.deepEqual(allocations(current).find((item) => item.id !== allocation.id)?.expectedCapabilityPack, {
    id: "coffee-shop-core", version: "2.0.0", requiredSkills: ["rust"]
  });
});

test("offerings are derived from the producer's own registration bytes", () => {
  const registration = controlFixture("register") as { node: ComputeNode };
  const offerings = nodeOfferings(registration.node);
  assert.deepEqual(offerings, [{
    nodeId: "node-one", harnessId: "claude-cli", model: "fable", transport: "native-cli", workspace: "/workspace"
  }]);

  const current = fixture([registration.node], [task("one", { harnessIds: ["claude-cli"], models: ["fable"], operatingSystems: ["darwin"] })]);
  current.reports.set("node-one", report("node-one", [evidence("os", "darwin")]));
  runSchedulingPass(current.state, context(current), at);
  assert.equal(allocations(current).length, 1, "the producer's declared capacity of 4 with 1 resident admits a reservation");
  assert.deepEqual([allocations(current)[0].nodeId, allocations(current)[0].model], ["node-one", "fable"]);
});

test("a task in an inactive thread or with unsatisfied dependencies is never placed on an offering", () => {
  const inactive = fixture([node("node-alpha")], [task("one")], { threads: [{ ...thread(), status: "completed" }] });
  assert.equal(runSchedulingPass(inactive.state, context(inactive), at).changed, false);
  assert.equal(instances(inactive).length, 0);

  const waiting = fixture([node("node-alpha")], [
    task("one", {}, { status: "pending" }),
    task("two", {}, { dependencies: [{ taskId: "one", policy: "require-success" }] })
  ]);
  runSchedulingPass(waiting.state, context(waiting), at);
  assert.equal(instances(waiting).length, 0);
});

/*
 * The dispatch outbox. An instance-keyed attempt is a persisted command in #75's crash-safe outbox,
 * never a direct socket write, so these drive the real delivery pass and the real reconnect
 * reconciliation against a real store.
 */

async function outboxStore(current: Fixture) {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-offerings-"));
  const store = new Store(join(directory, "state.json"));
  await store.load();
  await store.transact((state) => {
    state.threads = current.state.threads;
    state.nodes = current.state.nodes;
    state.tasks = current.state.tasks;
    state.instances = current.state.instances;
    state.instanceRequirementsVersion = current.state.instanceRequirementsVersion;
    state.allocations = current.state.allocations;
    state.templates = current.state.templates;
    state.runs = current.state.runs;
    state.instanceDeliveries = current.state.instanceDeliveries;
    return true;
  });
  return store;
}

test("a persisted dispatch is sent once, records its send on the run, and is retired when the run starts", async () => {
  const current = fixture([node("node-alpha")], [task("one")]);
  runSchedulingPass(current.state, context(current), at);
  markReady(current, instances(current)[0].id);
  runSchedulingPass(current.state, context(current), later(20));
  const runId = current.state.runs[0].id;
  const store = await outboxStore(current);

  const sent: Array<{ nodeId: string; type: string }> = [];
  const deliver = (nodeId: string, message: InstanceHubMessage) => {
    sent.push({ nodeId, type: message.type });
    return true;
  };
  assert.equal(await flushPendingInstanceDeliveries(store, deliver), true);
  // Commands go out in their allocation's own command order: the provision was written first.
  assert.deepEqual(sent, [{ nodeId: "node-alpha", type: "instance.provision" }, { nodeId: "node-alpha", type: "dispatch" }]);
  assert.ok(store.read((state) => state.runs.find((item) => item.id === runId)!.dispatchedAt) !== undefined);

  // An accepted write is not proof of receipt, so the record is retained while the run stays queued.
  sent.length = 0;
  assert.equal(await flushPendingInstanceDeliveries(store, deliver), false);
  assert.deepEqual(sent, []);
  assert.equal(store.read((state) => (state.instanceDeliveries ?? []).filter((record) => record.kind === "dispatch").length), 1);

  // Barista's own `run.started` retires it: the command has demonstrably been acted on.
  await store.transact((state) => {
    state.runs.find((item) => item.id === runId)!.status = "running";
    return true;
  });
  await store.transact((state) => pruneInstanceAuditRecords(state));
  assert.equal(store.read((state) => (state.instanceDeliveries ?? []).filter((record) => record.kind === "dispatch").length), 0);
});

test("a reconnect re-arms a dispatch the node never acted on and never creates a second attempt", async () => {
  const current = fixture([node("node-alpha")], [task("one")]);
  runSchedulingPass(current.state, context(current), at);
  const instanceId = instances(current)[0].id;
  markReady(current, instanceId);
  runSchedulingPass(current.state, context(current), later(20));
  const store = await outboxStore(current);
  await flushPendingInstanceDeliveries(store, () => true);
  assert.ok(store.read((state) => (state.instanceDeliveries ?? [])[0].deliveredAt) !== undefined);

  // The node still reports the resident after a reconnect, so the run was never started there.
  await store.transact((state) => reconcileNodeInstancesInState(state, "node-alpha", [instanceId], later(30)));
  const record = store.read((state) => (state.instanceDeliveries ?? []).find((item) => item.kind === "dispatch"))!;
  assert.equal(record.deliveredAt, undefined, "the dispatch is re-armed for replay");
  assert.equal(store.read((state) => state.runs.length), 1, "re-arming resends the attempt, it never creates another");

  const sent: string[] = [];
  await flushPendingInstanceDeliveries(store, (_nodeId, message) => { sent.push(message.type); return true; });
  assert.deepEqual(sent, ["dispatch"]);
});

test("persisted state carrying a dispatch command survives a reload and a malformed one is refused", async () => {
  const current = fixture([node("node-alpha")], [task("one")]);
  runSchedulingPass(current.state, context(current), at);
  markReady(current, instances(current)[0].id);
  runSchedulingPass(current.state, context(current), later(20));
  const store = await outboxStore(current);
  store.read((state) => assertPersistedInstanceState(state as State));

  await store.transact((state) => {
    (state.instanceDeliveries ?? []).find((record) => record.kind === "dispatch")!.kind = "provision";
    return true;
  });
  assert.throws(() => store.read((state) => assertPersistedInstanceState(state as State)), /does not match its kind/);
});

test("task submission expresses an optional template reference and rejects anything else", () => {
  assert.deepEqual(normalizeRequirements({ templateId: "template-reviewer" }), { templateId: "template-reviewer" });
  assert.deepEqual(normalizeRequirements({}), {});
  assert.throws(() => normalizeRequirements({ templateId: 7 }), /requirements.templateId/);
  assert.throws(() => normalizeRequirements({ instanceId: "instance-one" }), /requirements/);

  // The same field must survive the wire validator, because an instance carries the task's own set.
  assert.equal(validateInstanceRequirements({ templateId: "template-reviewer" }).ok, true);
  assert.equal(validateInstanceRequirements({ templateId: "" }).ok, false);
  assert.equal(validateInstanceRequirements({ templateId: 7 }).ok, false);
});

test("the placement diagnostic vocabulary is closed and every kind reaches its only cross-package consumer", () => {
  assert.equal(new Set(placementRequirementKinds).size, placementRequirementKinds.length);
  for (const kind of ["offering", "template", "instance", "resident-capacity"] as const) {
    assert.ok((placementRequirementKinds as readonly string[]).includes(kind), kind);
  }
  /*
   * Two consumers exist outside the hub and both are closed over this same exported list: the
   * snapshot decoder accepts a kind only if it appears here (apps/web/src/hubConnection.ts:209), and
   * the operator label table is an exhaustive `Record<PlacementRequirementKind, string>`
   * (apps/web/src/orchestration/orchestrationLabels.ts:17) that the compiler refuses to leave
   * incomplete — adding a kind without labelling it fails `task typecheck`, which is how these four
   * were caught. Nothing branches on the kind; it is only decoded and rendered.
   */
  for (const kind of placementRequirementKinds) {
    assert.equal(typeof kind, "string");
    assert.notEqual(kind.length, 0);
  }
});

test("a resident returns to idle when its attempt settles and carries the thread's next task", () => {
  const current = fixture([node("node-alpha", { instanceCapacity: 1 })], [task("one"), task("two")]);
  runSchedulingPass(current.state, context(current), at);
  const instanceId = instances(current)[0].id;
  markReady(current, instanceId);
  runSchedulingPass(current.state, context(current), later(20));
  assert.equal(instances(current).find((item) => item.id === instanceId)!.status, "busy");
  assert.equal(current.state.runs.length, 1, "the busy resident carries only one attempt at a time");

  // Barista reported the first attempt complete; the resident is available again.
  const first = current.state.runs[0];
  first.status = "completed";
  first.finishedAt = later(40);
  taskById(current, "one").status = "completed";
  const next = runSchedulingPass(current.state, context(current), later(50));
  assert.equal(next.attempts.length, 1);
  assert.equal(instances(current).length, 1, "the thread's next task reuses the resident rather than overbooking");
  assert.equal(current.state.runs.find((run) => run.taskId === "two")!.instanceId, instanceId);
  assert.equal(instances(current)[0].status, "busy");
});

test("a reused ACP resident dispatch carries the exact resumable session grant", () => {
  const acp = { protocolVersion: 1 as const, loadSession: true, resumeSession: true,
    prompt: { image: false, audio: false, embeddedContext: false }, mcp: { http: false, sse: false } };
  const current = fixture([node("node-acp", { instanceCapacity: 1, harnesses: [{
    id: "claude-cli", label: "Claude", description: "", available: true, authMode: "local-subscription",
    models: ["fable"], transports: ["acp-v1"], acp
  }] })], [task("one"), task("two")]);
  runSchedulingPass(current.state, context(current), at);
  const instanceId = instances(current)[0].id;
  markReady(current, instanceId);
  runSchedulingPass(current.state, context(current), later(20));
  const first = current.state.runs[0];
  first.status = "completed";
  first.finishedAt = later(40);
  taskById(current, "one").status = "completed";
  current.state.sessionBindings = [{
    id: "binding-one", threadId: "thread-one", instanceId, allocationId: first.allocationId,
    nodeId: "node-acp", harnessId: "claude-cli", transport: "acp-v1", workspace: first.workspace,
    providerSessionId: "provider-session-one", status: "idle", createdByRunId: first.id, lastRunId: first.id,
    capabilities: acp, createdAt: later(21), updatedAt: later(40)
  }];

  runSchedulingPass(current.state, context(current), later(50));
  const second = current.state.runs.find((run) => run.taskId === "two")!;
  const delivery = deliveries(current, "dispatch").find((record) => record.message.type === "dispatch" && record.message.run.id === second.id)!;
  assert.equal(second.sessionBindingId, "binding-one");
  assert.deepEqual(delivery.message.type === "dispatch" ? delivery.message.sessionBinding : undefined, {
    id: "binding-one", providerSessionId: "provider-session-one"
  });
  assert.equal(validateInstanceHubMessage(delivery.message, "5").ok, true);
});

test("an instance run reports its whole lifecycle and settles its task", () => {
  const current = fixture([node("node-alpha")], [task("one")]);
  runSchedulingPass(current.state, context(current), at);
  const instanceId = instances(current)[0].id;
  markReady(current, instanceId);
  runSchedulingPass(current.state, context(current), later(20));
  const runId = current.state.runs[0].id;

  // Barista's reports name a run whose only actor is a resident instance; none may be dropped.
  assert.equal(applyRunLifecycle(current.state, { type: "run.started", runId, at: later(21) } as never), true);
  assert.equal(current.state.runs[0].status, "running");
  assert.equal(taskById(current, "one").status, "running");
  assert.equal(applyRunLifecycle(current.state, { type: "run.output", runId, chunk: "working", at: later(22) } as never), true);
  assert.equal(applyRunLifecycle(current.state, { type: "run.completed", runId, output: "done", at: later(23) } as never), true);
  assert.equal(current.state.runs[0].status, "completed");
  assert.equal(taskById(current, "one").status, "completed");
  assert.equal(taskById(current, "one").result, "done");

  // Attribution names the instance and its allocation, never an agent identity the fleet lacks.
  const allocationId = allocations(current)[0].id;
  assert.deepEqual(current.state.messages.map((message) => [message.agentId, message.instanceId, message.allocationId, message.body]),
    [[undefined, instanceId, allocationId, "done"]]);
  for (const event of current.state.events) assert.notEqual(event.agentId, instanceId);
  const finished = current.state.events.find((event) => event.title.includes("finished"))!;
  assert.deepEqual([finished.agentId, finished.instanceId, finished.allocationId], [undefined, instanceId, allocationId]);

  // The settled attempt returns the resident to idle for the thread's next task.
  assert.equal(runSchedulingPass(current.state, context(current), later(30)).changed, true);
  assert.equal(instances(current)[0].status, "idle");
});

test("a failed instance run fails its task and a lost one is retried without an agent identity", () => {
  const current = fixture([node("node-alpha")], [task("one")]);
  runSchedulingPass(current.state, context(current), at);
  markReady(current, instances(current)[0].id);
  runSchedulingPass(current.state, context(current), later(20));
  const runId = current.state.runs[0].id;
  assert.equal(applyRunLifecycle(current.state, { type: "run.started", runId, at: later(21) } as never), true);
  assert.equal(applyRunLifecycle(current.state, { type: "run.failed", runId, error: "harness exited", at: later(22) } as never), true);
  assert.equal(taskById(current, "one").status, "failed");
  assert.deepEqual(current.state.messages.map((message) => [message.agentId, message.instanceId, message.kind]),
    [[undefined, instances(current)[0].id, "status"]]);

  const lost = fixture([node("node-beta")], [task("two")]);
  runSchedulingPass(lost.state, context(lost), at);
  markReady(lost, instances(lost)[0].id);
  runSchedulingPass(lost.state, context(lost), later(20));
  const lostRunId = lost.state.runs[0].id;
  applyRunLifecycle(lost.state, { type: "run.started", runId: lostRunId, at: later(21) } as never);
  const failed = failLostTaskAttempts(lost.state, "node-beta", [], later(30));
  assert.deepEqual(failed.map((run) => run.id), [lostRunId]);
  assert.equal(taskById(lost, "two").status, "ready", "the attempt is retried under the existing policy");
  assert.deepEqual(lost.state.messages.map((message) => [message.agentId, message.instanceId, message.kind]),
    [[undefined, instances(lost)[0].id, "status"]], "no chat message is attributed to a nonexistent agent");
  for (const event of lost.state.events) assert.notEqual(event.agentId, instances(lost)[0].id);
});

test("a node named by a placement override restricts instance reuse and pins as well as offerings", () => {
  const ready: AgentInstance = {
    id: "instance-elsewhere", threadId: "thread-one", creator: { kind: "operator", operatorId: "operator" },
    delegation: { canDelegate: false }, requirements: {}, lease: { idleTimeoutSeconds: 1800, expiresAt: later(1800) },
    status: "ready", createdAt: at, updatedAt: at
  };
  const allocation: InstanceAllocation = {
    id: "allocation-elsewhere", instanceId: "instance-elsewhere", nodeId: "node-alpha", harnessId: "claude-cli",
    model: "fable", transport: "native-cli", workspace: "/workspace", lease: { ...ready.lease },
    status: "active", createdAt: at, updatedAt: at
  };

  // Reuse may not cross to a node the override excludes; the permitted node is used instead.
  const reuse = fixture([node("node-alpha"), node("node-beta")], [
    task("one", {}, { placementOverride: { nodeId: "node-beta", authorizedBy: "operator" } })
  ], { instances: [ready], allocations: [allocation] });
  runSchedulingPass(reuse.state, context(reuse), at);
  assert.equal(reuse.state.runs.length, 0, "the excluded resident is not reused");
  assert.equal(allocations(reuse).length, 2);
  assert.equal(allocations(reuse).find((item) => item.status === "reserved")!.nodeId, "node-beta");

  // A pin naming both an instance and a node it is not allocated to fails rather than being honored.
  const pinned = fixture([node("node-alpha"), node("node-beta")], [
    task("one", {}, { placementOverride: { instanceId: "instance-elsewhere", nodeId: "node-beta", authorizedBy: "operator" } })
  ], { instances: [ready], allocations: [allocation] });
  runSchedulingPass(pinned.state, context(pinned), at);
  assert.equal(pinned.state.runs.length, 0);
  assert.equal(instances(pinned).length, 1, "a failed pin never substitutes an offering");
  assert.deepEqual(kinds(pinned, "one"), ["instance"]);
});

/*
 * Executor loss after the attempt exists. These are the paths that stranded a `queued` instance run
 * for ever: nothing resends a dispatch whose allocation is gone, the version-4 reconnect sweep only
 * touches `running` runs, and a task that is no longer `ready` is never placed again.
 */

test("losing the allocation of a queued attempt fails it and returns the task to placement", async () => {
  const current = fixture([node("node-alpha", { instanceCapacity: 2 })], [task("one")]);
  runSchedulingPass(current.state, context(current), at);
  const instanceId = instances(current)[0].id;
  markReady(current, instanceId);
  runSchedulingPass(current.state, context(current), later(20));
  const runId = current.state.runs[0].id;
  assert.equal(taskById(current, "one").status, "assigned");
  const store = await outboxStore(current);
  await flushPendingInstanceDeliveries(store, () => true);

  // The node comes back without the resident: the allocation is lost and its dispatch goes with it.
  await store.transact((state) => reconcileNodeInstancesInState(state, "node-alpha", [], later(40)));
  const after = store.read((state) => ({
    run: state.runs.find((item) => item.id === runId)!,
    task: state.tasks!.find((item) => item.id === "one")!,
    dispatches: (state.instanceDeliveries ?? []).filter((record) => record.kind === "dispatch").length
  }));
  assert.equal(after.dispatches, 0, "the dispatch was removed with its allocation");
  assert.equal(after.run.status, "failed", "the attempt is not left queued for ever");
  assert.equal(after.task.status, "ready", "the task returns to placement under its retry policy");
  assert.equal(after.task.assignment, undefined);

  // And it is genuinely placeable again, on a fresh instance identity.
  const replaced = store.read((state) => structuredClone(state));
  const revived: Fixture = { ...current, state: replaced as State };
  revived.connections = current.connections;
  runSchedulingPass(revived.state, context(revived), later(50));
  assert.equal((revived.state.instances ?? []).length, 2, "the retry received a new instance identity");
  assert.equal((revived.state.allocations ?? []).some((item) => item.status === "reserved"), true);
});

test("an instance that fails while carrying a queued attempt settles that attempt", async () => {
  const current = fixture([node("node-alpha", { instanceCapacity: 2 })], [task("one")]);
  runSchedulingPass(current.state, context(current), at);
  const instanceId = instances(current)[0].id;
  markReady(current, instanceId);
  runSchedulingPass(current.state, context(current), later(20));
  const runId = current.state.runs[0].id;
  const allocationId = allocations(current)[0].id;
  const store = await outboxStore(current);

  const outcome = await receiveInstanceLifecycleReport(store, "node-alpha", {
    type: "instance.failed", nodeId: "node-alpha", at: later(40), instanceId, allocationId, error: "harness could not start"
  }, later(40));
  assert.equal(outcome.kind, "accepted");
  const after = store.read((state) => ({
    run: state.runs.find((item) => item.id === runId)!,
    task: state.tasks!.find((item) => item.id === "one")!,
    instance: (state.instances ?? []).find((item) => item.id === instanceId)!
  }));
  assert.equal(after.instance.status, "failed");
  assert.equal(after.run.status, "failed", "a failed resident never leaves its attempt queued");
  assert.equal(after.task.status, "ready", "the task returns to placement");
});

test("a task pinned to a configured agent is never substituted onto an offering or a resident", () => {
  const reusable: AgentInstance = {
    id: "instance-spare", threadId: "thread-one", creator: { kind: "operator", operatorId: "operator" },
    delegation: { canDelegate: false }, requirements: {}, lease: { idleTimeoutSeconds: 1800, expiresAt: later(1800) },
    status: "ready", createdAt: at, updatedAt: at
  };
  const allocation: InstanceAllocation = {
    id: "allocation-spare", instanceId: "instance-spare", nodeId: "node-alpha", harnessId: "claude-cli",
    model: "fable", transport: "native-cli", workspace: "/workspace", lease: { ...reusable.lease },
    status: "active", createdAt: at, updatedAt: at
  };
  // The pinned agent is ineligible: its own node is absent from the fleet entirely.
  const pinnedAgent = {
    id: "worker-b", name: "worker-b", title: "worker-b", summary: "", glyph: "W",
    avatarShape: "cup" as const, avatarColor: "amber" as const, state: "idle" as const, currentAction: "Available",
    harnessId: "codex-cli" as const, model: "default", computeNodeId: "node-gone", workspace: "/workspace/worker-b",
    systemPrompt: "Work carefully", unread: 0, updatedAt: at, skills: []
  };
  const current = fixture([node("node-alpha")], [
    task("one", {}, { placementOverride: { agentId: "worker-b", authorizedBy: "operator" } })
  ], { agents: [pinnedAgent], instances: [reusable], allocations: [allocation] });

  runSchedulingPass(current.state, context(current), at);
  assert.equal(current.state.runs.length, 0, "the pinned task waits for its agent");
  assert.equal(instances(current).length, 1, "no resident is requested for a pinned task");
  assert.equal(allocations(current).length, 1, "the spare resident is not reused either");
  const reported = kinds(current, "one");
  assert.ok(reported.includes("node-offline"), "the pinned agent's own failure is reported");
  assert.ok(reported.includes("agent"), "and so is the reason no offering may stand in");
  assert.equal(
    taskById(current, "one").placement!.unsatisfied.some((entry) => entry.detail.includes("pinned to a configured agent")),
    true
  );
});

test("a requirement the execution contract cannot carry is refused at submission, not inside the pass", () => {
  // 90 characters — inside the batch's character bound — but 270 UTF-8 bytes, outside the wire bound.
  const overlong = "ラベル".repeat(30);
  assert.equal(overlong.length <= taskBatchLimits.requirementValueLength, true);
  assert.equal(Buffer.byteLength(overlong, "utf8") > 256, true);
  assert.throws(() => normalizeRequirements({ preferences: { labels: [overlong] } }), /execution contract/);
  assert.throws(() => normalizeRequirements({ labels: [overlong] }), /execution contract/);

  // Defence in depth: a record that reached persistence anyway becomes this task's diagnostic and
  // never an exception that rolls back the placements of unrelated tasks in the same pass.
  const current = fixture([node("node-alpha", { instanceCapacity: 2 })], [
    task("one", { preferences: { labels: [overlong] } }),
    task("two")
  ]);
  const result = runSchedulingPass(current.state, context(current), at);
  assert.equal(result.changed, true);
  assert.equal(taskById(current, "two").placementInstanceId !== undefined, true, "the healthy task was still placed");
  assert.equal(taskById(current, "one").placementInstanceId, undefined);
  assert.deepEqual(kinds(current, "one"), ["instance"]);
  assert.equal(taskById(current, "one").placement!.unsatisfied[0].detail.includes("wire-valid"), true);
  assert.equal(instances(current).length, 1, "the refused task left no instance behind");
});

test("cancelling a task that is waiting on a resident releases the slot promptly", () => {
  const current = fixture([node("node-alpha", { instanceCapacity: 1 })], [task("one")]);
  runSchedulingPass(current.state, context(current), at);
  const instanceId = instances(current)[0].id;
  assert.equal(taskById(current, "one").placementInstanceId, instanceId);

  cancelTaskInState(current.state, "one", later(5));
  runSchedulingPass(current.state, context(current), later(6));
  assert.equal(taskById(current, "one").placementInstanceId, undefined);
  const instance = instances(current).find((item) => item.id === instanceId)!;
  assert.ok(["draining", "released"].includes(instance.status), `expected a drained instance, got ${instance.status}`);
  assert.equal((current.state.instanceReleaseIntents ?? []).some((intent) => intent.instanceId === instanceId), true);
});

test("a running instance attempt is failed when its allocation is lost, not left mid-flight", async () => {
  const current = fixture([node("node-alpha", { instanceCapacity: 2 })], [task("one")]);
  runSchedulingPass(current.state, context(current), at);
  const instanceId = instances(current)[0].id;
  markReady(current, instanceId);
  runSchedulingPass(current.state, context(current), later(20));
  const runId = current.state.runs[0].id;
  // The attempt actually started, so the loss must settle a `running` run, not only a queued one.
  assert.equal(applyRunLifecycle(current.state, { type: "run.started", runId, at: later(21) } as never), true);
  assert.equal(taskById(current, "one").status, "running");
  const store = await outboxStore(current);

  await store.transact((state) => reconcileNodeInstancesInState(state, "node-alpha", [], later(40)));
  const after = store.read((state) => ({
    run: state.runs.find((item) => item.id === runId)!,
    task: state.tasks!.find((item) => item.id === "one")!,
    instance: (state.instances ?? []).find((item) => item.id === instanceId)!
  }));
  assert.equal(after.run.status, "failed");
  assert.equal(after.run.error?.includes("allocation was lost"), true);
  assert.equal(after.task.status, "ready", "a running attempt is retried under the same policy as a queued one");
  assert.equal(after.instance.status, "requested", "the instance keeps its identity for a replacement");
});

test("an agent-only fleet reports no offering-exclusion entry for an ineligible agent pin", () => {
  // No node publishes an offering and the thread holds no resident, so the pin closed nothing and
  // the diagnostic must not claim it did.
  const pinnedAgent = {
    id: "worker-b", name: "worker-b", title: "worker-b", summary: "", glyph: "W",
    avatarShape: "cup" as const, avatarColor: "amber" as const, state: "idle" as const, currentAction: "Available",
    harnessId: "codex-cli" as const, model: "default", computeNodeId: "node-plain", workspace: "/workspace/worker-b",
    systemPrompt: "Work carefully", unread: 0, updatedAt: at, skills: []
  };
  const plain = node("node-plain", { instanceCapacity: undefined, status: "offline" });
  const current = fixture([plain], [
    task("one", {}, { placementOverride: { agentId: "worker-b", authorizedBy: "operator" } })
  ], { agents: [pinnedAgent] });
  current.connections.set("node-plain", { protocolVersion: "4", synced: true });

  runSchedulingPass(current.state, context(current), at);
  assert.equal(current.state.runs.length, 0);
  assert.equal(instances(current).length, 0);
  const entries = taskById(current, "one").placement!.unsatisfied;
  assert.equal(entries.some((entry) => entry.detail.includes("pinned to a configured agent")), false);
  assert.ok(entries.length > 0, "the pinned agent's own failure is still reported");
  assert.ok(entries.every((entry) => entry.kind !== "offering"));
});

test("an instance run's session replacement event carries no agent attribution", async () => {
  const acp = node("node-acp", { harnesses: [
    { id: "claude-cli", label: "Claude", description: "", available: true, authMode: "local-subscription", models: ["fable"], transports: ["acp-v1"] }
  ] });
  const current = fixture([acp], [task("one")]);
  runSchedulingPass(current.state, context(current), at);
  const instanceId = instances(current)[0].id;
  markReady(current, instanceId);
  runSchedulingPass(current.state, context(current), later(20));
  const run = current.state.runs[0];
  assert.equal(run.transport, "acp-v1");
  const store = await outboxStore(current);
  await flushPendingInstanceDeliveries(store, () => true);

  const binding = (providerSessionId: string) => ({
    transport: "acp-v1" as const, harnessId: "claude-cli" as const, providerSessionId, status: "active" as const
  });
  assert.equal((await receiveSessionBinding(store, "node-acp", run.id, binding("session-one"), later(30))).kind, "created");
  // A second binding with a different provider session replaces the first and writes the event.
  const replaced = await receiveSessionBinding(store, "node-acp", run.id, binding("session-two"), later(31));
  assert.equal(replaced.kind, "created");
  const event = store.read((state) => state.events.find((item) => item.title === "Session replaced"));
  assert.ok(event, "the replacement event was written");
  assert.equal(Object.hasOwn(event!, "agentId"), false, "an instance run names no configured agent");
});
