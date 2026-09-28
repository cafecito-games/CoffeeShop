import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  allocationStatuses,
  hasAuthoritativeInstanceEvidence,
  instanceLimits,
  instanceStatuses,
  validateInstanceHubMessage,
  type AgentInstance,
  type ComputeNode,
  type InstanceAllocation,
  type Run,
  type Task,
  type InstanceLifecycleRequest
} from "@coffee-shop/protocol";
import { CoordinationError } from "./coordinationError.js";
import {
  applyInstanceLifecycle,
  applyNodeHeartbeatInState,
  applyNodeResidencyInState,
  classifyInstanceResidentEvidence,
  classifyReportedInstanceCount,
  currentAllocationInState,
  flushPendingInstanceDeliveries,
  instanceAuditLimits,
  instanceDeliveryBarrier,
  listThreadInstances,
  maintainInstanceLifecycle,
  nodeResidencyInState,
  nonTerminalInstanceStatuses,
  occupyingAllocationStatuses,
  receiveInstanceLifecycleReport,
  rejectInstanceAllocationProofInState,
  reconcileNodeInstancesInState,
  reportedInstanceCountFitsNode,
  reserveInstanceAllocation,
  residentInstanceUsage,
  residentInstanceUsageInState,
  terminalInstanceStatuses,
  operatorInstanceCreator
} from "./instances.js";
import { Store, type State } from "./store.js";
import { submitTaskBatch } from "./tasks.js";

/*
 * Byte-faithful version-5 frames. The files are written by the Barista wire encoder itself
 * (apps/control-agent/internal/protocol/instances_test.go:46 marshals apps/control-agent/internal/
 * protocol/messages.go:88 `Outbound` into packages/protocol/test/fixtures/control-v5) and are read
 * here through the same path as the protocol suite's producer
 * (packages/protocol/test/instance-fixture-producer.mjs:4).
 */
const controlFixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../../../packages/protocol/test/fixtures/control-v5/${name}.json`, import.meta.url), "utf8"));

const operatorCaller = operatorInstanceCreator;
const at = (secondsFromEpoch: number) => new Date(secondsFromEpoch * 1000).toISOString();

const seedThread = (state: State, threadId = "thread-one") => {
  state.threads ??= [];
  state.threads.push({
    id: threadId, title: "Instance thread", objective: "Run instances", summary: "", status: "active",
    ownerAgentId: "agent-one", orchestrator: { kind: "agent", agentId: "agent-one" }, createdBy: "user",
    createdAt: at(1), updatedAt: at(1)
  });
};

const computeNode = (overrides: Partial<ComputeNode> = {}): ComputeNode => ({
  id: "node-one", name: "Node One", kind: "local", platform: "darwin", status: "online", lastSeen: at(1),
  activeRuns: 0, concurrency: 2, instanceCapacity: 1, activeInstances: 0, workspaceRoots: ["/work"],
  harnesses: [{ id: "claude-cli", label: "Claude", description: "", available: true, authMode: "local-subscription", models: ["fable"] }],
  version: "1", ...overrides
});

const seedNode = (state: State, overrides: Partial<ComputeNode> = {}) => {
  state.nodes.push(computeNode(overrides));
};

async function hubStore(seed?: (state: State) => void) {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-instances-"));
  const store = new Store(join(directory, "state.json"));
  await store.load();
  if (seed) await store.transact(seed);
  return store;
}

const createRequest = (threadId = "thread-one", overrides: Partial<Extract<InstanceLifecycleRequest, { operation: "create" }>> = {}): InstanceLifecycleRequest => ({
  operation: "create",
  threadId,
  idempotency: { caller: operatorCaller, key: "create-one" },
  requirements: { harnessIds: ["claude-cli"] },
  purpose: { name: "worker", summary: "General work", instructions: "Be careful." },
  ...overrides
});

const readyReport = (instanceId: string, allocationId: string, nodeId = "node-one") =>
  ({ type: "instance.ready" as const, nodeId, instanceId, allocationId, at: at(100) });

const releasedReport = (instanceId: string, allocationId: string, nodeId = "node-one") =>
  ({ type: "instance.released" as const, nodeId, instanceId, allocationId, at: at(100) });

const failedReport = (instanceId: string, allocationId: string, nodeId = "node-one", error = "harness crashed") =>
  ({ type: "instance.failed" as const, nodeId, instanceId, allocationId, at: at(100), error });

const releaseRequest = (instanceId: string, key: string, mode: "drain" | "cancel") => ({
  operation: "release" as const, threadId: "thread-one", instanceId,
  idempotency: { caller: operatorCaller, key }, mode
});

const renewRequest = (instanceId: string, key: string, idleTimeoutSeconds?: number) => ({
  operation: "renew" as const, threadId: "thread-one", instanceId,
  idempotency: { caller: operatorCaller, key }, ...(idleTimeoutSeconds === undefined ? {} : { idleTimeoutSeconds })
});

const candidate = (workspace: string) => ({
  nodeId: "node-one", harnessId: "claude-cli" as const, model: "fable", transport: "native-cli" as const, workspace
});

test("a mismatched run-start pack proof retries the task and cancels the allocation", () => {
  const instance: AgentInstance = {
    id: "instance-pack", threadId: "thread-one", creator: operatorCaller, delegation: { canDelegate: false },
    requirements: { skills: ["review"] }, lease: { idleTimeoutSeconds: 1800, expiresAt: at(2000) },
    status: "busy", createdAt: at(1), updatedAt: at(2)
  };
  const allocation: InstanceAllocation = {
    id: "allocation-pack", instanceId: instance.id, nodeId: "node-one", harnessId: "claude-cli", model: "fable",
    transport: "native-cli", workspace: "/work", expectedCapabilityPack: { id: "coffee-shop-core", version: "1.0.0", requiredSkills: ["review"] },
    lease: { ...instance.lease }, status: "active", createdAt: at(1), updatedAt: at(2)
  };
  const run: Run = {
    id: "run-pack", threadId: "thread-one", instanceId: instance.id, allocationId: allocation.id,
    nodeId: "node-one", harnessId: "claude-cli", model: "fable", transport: "native-cli", workspace: "/work",
    prompt: "Review", status: "queued", output: "", depth: 0, taskId: "task-pack", attempt: 1, createdAt: at(3)
  };
  const task: Task = {
    id: "task-pack", threadId: "thread-one", title: "Review", instructions: "Review", status: "assigned",
    requirements: { skills: ["review"] }, dependencies: [], idempotencyKey: "pack", attemptRunIds: [run.id],
    assignment: { runId: run.id, instanceId: instance.id, allocationId: allocation.id, nodeId: "node-one", harnessId: "claude-cli", transport: "native-cli", model: "fable", assignedAt: at(3) },
    placementInstanceId: instance.id, createdAt: at(1), updatedAt: at(3)
  };
  const state: State = { agents: [], nodes: [computeNode()], runs: [run], events: [], messages: [], instances: [instance], allocations: [allocation], tasks: [task] };
  assert.equal(rejectInstanceAllocationProofInState(state, run.id, "pack proof mismatch", at(4)), true);
  assert.equal(run.status, "failed");
  assert.equal(task.status, "ready");
  assert.equal(task.assignment, undefined);
  assert.equal(task.placementInstanceId, undefined);
  assert.equal(instance.status, "draining");
  assert.equal(state.instanceReleaseIntents?.[0]?.mode, "cancel");
  assert.equal(state.instanceDeliveries?.some((entry) => entry.kind === "release"), true);
});

/**
 * Applies one node heartbeat's resident identities the way the socket handler does: the frame is
 * Barista's own heartbeat bytes with the resident set substituted, read by the shared tri-state
 * classifier, and written only when that classifier calls it authoritative.
 */
const heartbeat = async (store: Store, residents: readonly string[], observedAt: string, nodeId = "node-one") => {
  const frame = { ...controlFixture("heartbeat"), nodeId, activeInstances: residents.length, activeInstanceIds: [...residents] };
  const evidence = classifyInstanceResidentEvidence(frame, "5", "heartbeat");
  assert.equal(evidence.kind, "authoritative", JSON.stringify(evidence));
  await store.transact((state) =>
    applyNodeResidencyInState(state, nodeId, (evidence as { residents: readonly string[] }).residents, observedAt));
};

/** Creates, reserves, and delivers one instance so its allocation reports `provisioning`. */
const provisionInstance = async (store: Store) => {
  const created = await applyInstanceLifecycle(store, operatorCaller, createRequest(), at(1));
  const reservation = await reserveInstanceAllocation(store, created.instance.id, candidate("/work/one"), at(2));
  assert.equal(reservation.kind, "reserved", `reservation failed: ${JSON.stringify(reservation)}`);
  await flushPendingInstanceDeliveries(store, () => true);
  return { created, reservation };
};

test("creates one requested instance with a caller-scoped idempotency receipt", async () => {
  const store = await hubStore((state) => { seedThread(state); seedNode(state); });
  const result = await applyInstanceLifecycle(store, operatorCaller, createRequest(), at(1));
  assert.equal(result.replayed, false);
  assert.equal(result.instance.status, "requested");
  assert.equal(result.instance.threadId, "thread-one");
  assert.equal(result.instance.lease.idleTimeoutSeconds, 1800);
  assert.equal(result.allocation, undefined);
  assert.equal(result.initialTaskId, undefined);
  store.read((state) => {
    assert.equal(state.instances?.length, 1);
    assert.equal(state.instanceLifecycleReceipts?.length, 1);
    assert.equal(state.instanceLifecycleReceipts?.[0].sourceKey, "operator:operator");
    assert.equal(state.events?.[0].threadId, "thread-one");
    // The audit event never carries instructions, workspace paths, or idempotency digests.
    const serialized = JSON.stringify(state.events?.[0]);
    assert.equal(serialized.includes("Be careful"), false);
    assert.equal(serialized.includes("/work"), false);
  });
});

test("an exact create replay returns the original instance without new writes", async () => {
  const store = await hubStore((state) => { seedThread(state); });
  const first = await applyInstanceLifecycle(store, operatorCaller, createRequest(), at(1));
  const second = await applyInstanceLifecycle(store, operatorCaller, createRequest(), at(2));
  assert.equal(second.replayed, true);
  assert.equal(second.instance.id, first.instance.id);
  store.read((state) => {
    assert.equal(state.instances?.length, 1);
    assert.equal(state.instanceLifecycleReceipts?.length, 1);
    assert.equal(state.instanceLifecycleReceipts?.[0].createdAt, at(1));
  });
});

test("create normalizes skill identity before storage and idempotency comparison", async () => {
  const store = await hubStore((state) => { seedThread(state); });
  const first = await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", {
    requirements: { skills: [" Review ", "preview", "REVIEW"] }
  }), at(1));
  assert.deepEqual(first.instance.requirements.skills, ["preview", "review"]);
  const replay = await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", {
    requirements: { skills: ["review", "PREVIEW"] }
  }), at(2));
  assert.equal(replay.replayed, true);
  await assert.rejects(applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", {
    requirements: { skills: ["review", "build"] }
  }), at(3)), /idempotency key was already used/);
});

test("create stores template-effective hard skills while descriptive skills remain metadata", async () => {
  const store = await hubStore((state) => {
    seedThread(state);
    state.templates = [{
      id: "template-review", name: "Review", skills: ["descriptive-only"], requirements: { skills: ["Review", "preview"] }
    }];
  });
  const created = await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", {
    requirements: { templateId: "template-review", skills: ["PREVIEW"] }
  }), at(1));
  assert.deepEqual(created.instance.requirements.skills, ["preview", "review"]);
  assert.equal(created.instance.requirements.skills?.includes("descriptive-only"), false);
});

test("a different digest under the same caller and key conflicts and preserves the original", async () => {
  const store = await hubStore((state) => { seedThread(state); });
  const first = await applyInstanceLifecycle(store, operatorCaller, createRequest(), at(1));
  await assert.rejects(
    applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", { requirements: { harnessIds: ["codex-cli"] } }), at(2)),
    /idempotency key was already used/
  );
  store.read((state) => {
    assert.equal(state.instances?.length, 1);
    assert.equal(state.instances?.[0].id, first.instance.id);
    assert.deepEqual(state.instances?.[0].requirements.harnessIds, ["claude-cli"]);
  });
});

test("rejects create for unknown, inactive threads and unauthorized callers before any write", async () => {
  const store = await hubStore((state) => {
    seedThread(state);
    seedThread(state, "thread-done");
    state.threads!.find((thread) => thread.id === "thread-done")!.status = "completed";
  });
  await assert.rejects(applyInstanceLifecycle(store, operatorCaller, createRequest("missing-thread"), at(1)), /Thread not found/);
  await assert.rejects(applyInstanceLifecycle(store, operatorCaller, createRequest("thread-done"), at(1)), /active thread/);
  await assert.rejects(
    applyInstanceLifecycle(store, { kind: "run", runId: "run-x", instanceId: "inst-x" }, createRequest("thread-one", { idempotency: { caller: { kind: "run", runId: "run-x", instanceId: "inst-x" }, key: "k" } }), at(1)),
    /Thread not found/
  );
  await assert.rejects(
    applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", { idleTimeoutSeconds: 10 }), at(1)),
    /invalid/
  );
  store.read((state) => {
    assert.equal(state.instances?.length, 0);
    assert.equal(state.instanceLifecycleReceipts?.length, 0);
    assert.equal(state.events?.length, 0);
  });
});

test("creates an instance and its initial task atomically", async () => {
  const store = await hubStore((state) => { seedThread(state); });
  const result = await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", {
    initialTask: { title: "First chore", instructions: "Be careful." }
  }), at(1));
  assert.notEqual(result.initialTaskId, undefined);
  store.read((state) => {
    const task = state.tasks?.find((item) => item.id === result.initialTaskId);
    assert.ok(task);
    assert.equal(task.threadId, "thread-one");
    assert.equal(task.status, "ready");
    assert.equal(task.sourceKey, "operator:operator");
    assert.deepEqual(task.placementOverride, { instanceId: result.instance.id, authorizedBy: "policy" });
  });
});

test("an invalid initial task rejects the whole create without leaving instance, task, receipt, or event", async () => {
  const store = await hubStore((state) => { seedThread(state); });
  await assert.rejects(
    applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", {
      initialTask: { title: "Chore", instructions: "x".repeat(70_000) }
    }), at(1)),
    /invalid/
  );
  store.read((state) => {
    assert.equal(state.instances?.length, 0);
    assert.equal(state.tasks?.length, 0);
    assert.equal(state.instanceLifecycleReceipts?.length, 0);
    assert.equal(state.events?.length, 0);
  });
});

test("an attached orchestrator client may create on its thread and nothing else", async () => {
  const client = { kind: "orchestrator-client", clientId: "client-one" } as const;
  const store = await hubStore((state) => {
    seedThread(state);
    seedThread(state, "thread-two");
    state.orchestratorAttachments = [{ id: "attach-one", threadId: "thread-one", clientId: "client-one", connectionId: "conn-one", attachedAt: at(1), lastHeartbeatAt: at(1), status: "attached" }];
    state.orchestratorClients = [{ id: "client-one", name: "Bridge", scopes: ["orchestrate"], createdAt: at(1), secretHash: "hash" }];
  });
  const attached = await applyInstanceLifecycle(store, client, createRequest("thread-one", { idempotency: { caller: client, key: "create-one" } }), at(1));
  assert.equal(attached.replayed, false);
  await assert.rejects(
    applyInstanceLifecycle(store, client, createRequest("thread-two", { idempotency: { caller: client, key: "k" } }), at(2)),
    /no attachment/
  );
  // A detached or revoked credential loses the authority without any state change.
  await store.transact((state) => { state.orchestratorAttachments![0].status = "detached"; });
  await assert.rejects(
    applyInstanceLifecycle(store, client, createRequest("thread-one", { idempotency: { caller: client, key: "other" } }), at(3)),
    /no attachment/
  );
  store.read((state) => assert.equal(state.instances?.length, 1));
});

test("concurrent duplicate creation with the same key produces exactly one instance", async () => {
  const store = await hubStore((state) => { seedThread(state); });
  const results = await Promise.all([
    applyInstanceLifecycle(store, operatorCaller, createRequest(), at(1)),
    applyInstanceLifecycle(store, operatorCaller, createRequest(), at(1)),
    applyInstanceLifecycle(store, operatorCaller, createRequest(), at(1))
  ]);
  const ids = new Set(results.map((result) => result.instance.id));
  assert.equal(ids.size, 1);
  assert.equal(results.filter((result) => result.replayed).length, 2);
  store.read((state) => assert.equal(state.instances?.length, 1));
});

/*
 * This replaces an earlier test named for a `Math.max` rule over the reported scalar and the
 * persisted identities. That rule is gone: an authoritative resident record supersedes the scalar
 * instead of being masked by it, so the scalar is only a floor for a node that has produced no
 * record yet. The assertions below cover every case the old test did — the scalar raising usage
 * above the persisted allocations, an absent scalar leaving persisted intent to reserve, and
 * non-occupying or foreign allocations never counting — and add the supersession cases.
 */
test("an authoritative resident record supersedes the reported scalar, which is unnamed residency without one", () => {
  const node = computeNode({ instanceCapacity: 8, activeInstances: 3 });
  const allocations = [
    { instanceId: "a", nodeId: "node-one", status: "reserved" },
    { instanceId: "b", nodeId: "node-one", status: "active" },
    { instanceId: "c", nodeId: "node-one", status: "lost" },
    { instanceId: "d", nodeId: "node-one", status: "released" },
    { instanceId: "e", nodeId: "node-two", status: "active" },
    { instanceId: "f", nodeId: "node-one", status: "failed" }
  ].map((entry) => entry as never);
  /*
   * With no record of its own the node has named nothing, so its count cannot be reconciled with the
   * two occupying allocations the hub persists: the residents may be the same two or three others
   * entirely. Usage is the upper bound of that union, because only the upper bound is safe to place a
   * reservation against. This replaces an assertion of `Math.max(owned, count)`, which was the lower
   * bound and let a node with disjoint sets be overbooked; the replacement still blocks every case
   * the maximum blocked, because the sum is never smaller.
   */
  assert.deepEqual(residentInstanceUsage(node, allocations), { capacity: 8, used: 5 });
  // Absent reported usage is unknown, not zero: persisted intent still reserves.
  const unknown = computeNode({ instanceCapacity: 8 });
  delete (unknown as Partial<ComputeNode>).activeInstances;
  assert.deepEqual(residentInstanceUsage(unknown, allocations), { capacity: 8, used: 2 });
  // A malformed count never reaches the node record, and a zero count costs nothing.
  assert.deepEqual(residentInstanceUsage(computeNode({ instanceCapacity: 8, activeInstances: 0 }), allocations), { capacity: 8, used: 2 });
  // An authoritative snapshot decides on identities, so a stale scalar no longer inflates usage.
  const residency = (instanceIds: string[]) => ({ nodeId: "node-one", instanceIds, observedAt: at(2) });
  assert.deepEqual(residentInstanceUsage(node, allocations, residency([])), { capacity: 8, used: 2 });
  // An identity in both sets is counted once; an unowned one adds a slot of its own.
  assert.deepEqual(residentInstanceUsage(node, allocations, residency(["a", "b"])), { capacity: 8, used: 2 });
  assert.deepEqual(residentInstanceUsage(node, allocations, residency(["a", "foreign"])), { capacity: 8, used: 3 });
  /*
   * No settled local status discounts an identity the node reports. The record is the node's own word
   * as of its latest heartbeat, so a `released`, `failed` or `lost` allocation of the hub's is older
   * evidence than the record rather than newer, and each of the three counts while the record names
   * the identity. This replaces three assertions that read those statuses back over the record — the
   * `released` discount, its `failed` sibling, and the vacancy statement that generalized them — each
   * of which freed a slot Barista still held. The node's next report is what drops the identity.
   */
  assert.deepEqual(residentInstanceUsage(node, allocations, residency(["d"])), { capacity: 8, used: 3 });
  assert.deepEqual(residentInstanceUsage(node, allocations, residency(["f"])), { capacity: 8, used: 3 });
  assert.deepEqual(residentInstanceUsage(node, allocations, residency(["c"])), { capacity: 8, used: 3 });
  // Another node's record never decides this node's usage, so the unnamed count still bounds it.
  assert.deepEqual(residentInstanceUsage(node, allocations, { nodeId: "node-two", instanceIds: [], observedAt: at(2) }), { capacity: 8, used: 5 });
});

test("a scalar-only node is never overbooked by reservations its count cannot name", async () => {
  /*
   * A protocol-v5 sync without `activeInstanceIds` is well formed: it opens instance delivery and
   * creates no residency record. The node then reports one resident as a bare count, and the hub
   * cannot tell whether that resident is one it owns or a pre-existing one it has no identity for. A
   * capacity-2 node must therefore accept one reservation and refuse the second: accepting both would
   * produce a provision Barista rejects and a lifecycle failure the hub already recorded.
   */
  const store = await hubStore((state) => { seedThread(state); seedNode(state, { instanceCapacity: 2, activeInstances: 1 }); });
  const first = await applyInstanceLifecycle(store, operatorCaller, createRequest(), at(1));
  const second = await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", {
    idempotency: { caller: operatorCaller, key: "create-two" }
  }), at(1));
  store.read((state) => assert.equal(nodeResidencyInState(state, "node-one"), undefined, "a sync without identities records nothing"));

  const reserved = await reserveInstanceAllocation(store, first.instance.id, candidate("/work/one"), at(2));
  assert.equal(reserved.kind, "reserved", JSON.stringify(reserved));
  const refused = await reserveInstanceAllocation(store, second.instance.id, candidate("/work/two"), at(3));
  assert.equal(refused.kind, "capacity", JSON.stringify(refused));
  store.read((state) => {
    assert.deepEqual(residentInstanceUsageInState(state, state.nodes[0]), { capacity: 2, used: 2 });
    assert.equal(state.allocations?.length, 1);
  });

  // The node's first authoritative snapshot names its residents, and the record supersedes the count:
  // the pre-existing resident turns out to be the one the hub owns, so the second slot is free.
  await store.transact((state) => { reconcileNodeInstancesInState(state, "node-one", [first.instance.id], at(4)); return true; });
  const admitted = await reserveInstanceAllocation(store, second.instance.id, candidate("/work/two"), at(5));
  assert.equal(admitted.kind, "reserved", JSON.stringify(admitted));
});

test("a released resident's slot frees on the node's next report, which the hub never edits", async () => {
  /*
   * The hub's copy of a node's resident set is the node's own snapshot and stays byte-faithful to it:
   * an acknowledged release does not edit it, and nothing derived from the hub's allocation statuses
   * is subtracted from it when it is read. What frees the slot is the node's next report, which no
   * longer names the resident — the release outbox and its load validation both depend on the record
   * saying only what the node said.
   */
  const store = await hubStore((state) => { seedThread(state); seedNode(state, { instanceCapacity: 1 }); });
  const { created, reservation } = await provisionInstance(store);
  await heartbeat(store, [created.instance.id], at(3));
  assert.equal((await receiveInstanceLifecycleReport(store, "node-one", readyReport(created.instance.id, reservation.allocation.id), at(4))).kind, "accepted");
  await applyInstanceLifecycle(store, operatorCaller, releaseRequest(created.instance.id, "release-one", "drain"), at(5));
  const released = await receiveInstanceLifecycleReport(store, "node-one", releasedReport(created.instance.id, reservation.allocation.id), at(6));
  assert.equal(released.kind, "accepted", JSON.stringify(released));

  const replacement = await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", {
    idempotency: { caller: operatorCaller, key: "create-two" }
  }), at(7));
  store.read((state) => {
    // The record still names the released resident: it is the node's report, not hub bookkeeping.
    assert.deepEqual(nodeResidencyInState(state, "node-one")?.instanceIds, [created.instance.id]);
    assert.deepEqual(residentInstanceUsageInState(state, state.nodes[0]), { capacity: 1, used: 1 });
  });
  await heartbeat(store, [], at(8));
  store.read((state) => assert.deepEqual(nodeResidencyInState(state, "node-one")?.instanceIds, []));
  const reserved = await reserveInstanceAllocation(store, replacement.instance.id, candidate("/work/two"), at(9));
  assert.equal(reserved.kind, "reserved", JSON.stringify(reserved));
  // A resident the node reports that the hub owns no occupying allocation for still holds a slot, so
  // occupancy follows the report rather than exempting anything the record happens to name.
  store.read((state) => {
    const withStranger = { nodeId: "node-one", instanceIds: [created.instance.id, "foreign-instance"], observedAt: at(10) };
    assert.deepEqual(residentInstanceUsage(state.nodes[0], state.allocations ?? [], withStranger), { capacity: 1, used: 3 });
  });
});

/*
 * A failed allocation is not proof the slot is free: Barista retains the resident in its table when
 * release cleanup fails and only then reports `instance.failed`
 * (apps/control-agent/internal/controlplane/instances.go). The slot stays occupied until the node's
 * own report stops naming the identity, and the hub asks the node to evict the resident it retained.
 */
test("an acknowledged failure keeps its slot until the node stops naming the resident", async () => {
  const store = await hubStore((state) => { seedThread(state); seedNode(state, { instanceCapacity: 1 }); });
  const { created, reservation } = await provisionInstance(store);
  await heartbeat(store, [created.instance.id], at(3));
  assert.equal((await receiveInstanceLifecycleReport(store, "node-one", failedReport(created.instance.id, reservation.allocation.id), at(4))).kind, "accepted");
  const replacement = await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", {
    idempotency: { caller: operatorCaller, key: "create-two" }
  }), at(5));
  store.read((state) => {
    assert.equal(state.allocations?.find((allocation) => allocation.id === reservation.allocation.id)?.status, "failed");
    assert.deepEqual(nodeResidencyInState(state, "node-one")?.instanceIds, [created.instance.id]);
    // A release-cleanup failure leaves the resident in Barista's table, so the identity still occupies.
    assert.deepEqual(residentInstanceUsageInState(state, state.nodes[0]), { capacity: 1, used: 1 });
  });
  const refused = await reserveInstanceAllocation(store, replacement.instance.id, candidate("/work/two"), at(6));
  assert.equal(refused.kind, "capacity", JSON.stringify(refused));

  /*
   * The failed allocation no longer occupies, so the node's next report names a resident the hub owns
   * nothing for: the hub asks the node to evict it, through the remote release outbox that addresses a
   * resident the hub holds no allocation for.
   */
  await heartbeat(store, [created.instance.id], at(7));
  store.read((state) => {
    assert.deepEqual(state.remoteReleaseRequests?.map((request) => request.instanceId), [created.instance.id]);
    assert.deepEqual(residentInstanceUsageInState(state, state.nodes[0]), { capacity: 1, used: 1 });
  });
  const sent: string[] = [];
  await flushPendingInstanceDeliveries(store, (_nodeId, message) => { sent.push(message.type); return true; });
  assert.deepEqual(sent, ["instance.release"]);

  // Only the node's own report dropping the identity frees the slot.
  await heartbeat(store, [], at(8));
  store.read((state) => {
    assert.deepEqual(state.remoteReleaseRequests, []);
    assert.deepEqual(residentInstanceUsageInState(state, state.nodes[0]), { capacity: 1, used: 0 });
  });
  assert.equal((await reserveInstanceAllocation(store, replacement.instance.id, candidate("/work/two"), at(9))).kind, "reserved");
});

/*
 * The setup: the node retains a resident after a release-cleanup failure, so the allocation and the
 * instance are terminal `failed` while the node's report still names the identity. A later retry then
 * succeeds, and its `instance.released` is not a legal transition for either record and never will be.
 * Lifecycle authority refuses it, and it carries no residency weight either — the node's next report
 * is what frees the slot.
 */
const retainedResidentAfterCleanupFailure = async (store: Store) => {
  const { created, reservation } = await provisionInstance(store);
  await heartbeat(store, [created.instance.id], at(3));
  assert.equal((await receiveInstanceLifecycleReport(store, "node-one", readyReport(created.instance.id, reservation.allocation.id), at(4))).kind, "accepted");
  await applyInstanceLifecycle(store, operatorCaller, releaseRequest(created.instance.id, "release-one", "drain"), at(5));
  const drained: string[] = [];
  await flushPendingInstanceDeliveries(store, (_nodeId, message) => { drained.push(message.type); return true; });
  assert.deepEqual(drained, ["instance.release"], "the drain reached the node before its cleanup failed");
  assert.equal((await receiveInstanceLifecycleReport(store, "node-one", failedReport(created.instance.id, reservation.allocation.id, "node-one", "cleanup failed"), at(6))).kind, "accepted");
  return { created, reservation };
};

test("a superseded, foreign, or mismatched acknowledgement frees no slot and changes nothing", async () => {
  /*
   * Acknowledgement authentication, all four parts of it: node, allocation, instance, and generation.
   * A lifecycle generation is the allocation identity itself, so an acknowledgement from a generation a
   * replacement has superseded says nothing about who is resident now, and neither does one from
   * another node or one whose instance and allocation do not belong together. Each is refused without
   * touching capacity.
   */
  const store = await hubStore((state) => { seedThread(state); seedNode(state, { instanceCapacity: 1 }); });
  const { created, reservation } = await provisionInstance(store);
  // The node's reconnect snapshot does not name the resident, so the first generation is lost and replaced.
  await store.transact((state) => { reconcileNodeInstancesInState(state, "node-one", [], at(3)); return true; });
  const replacementAllocation = await reserveInstanceAllocation(store, created.instance.id, candidate("/work/one"), at(4));
  assert.equal(replacementAllocation.kind, "reserved", JSON.stringify(replacementAllocation));
  assert.notEqual(replacementAllocation.allocation.id, reservation.allocation.id);

  const stale = await receiveInstanceLifecycleReport(store, "node-one", releasedReport(created.instance.id, reservation.allocation.id), at(5));
  assert.equal(stale.kind, "rejected", JSON.stringify(stale));
  assert.equal(stale.changed, false, "a superseded generation says nothing about current residency");
  store.read((state) => assert.deepEqual(residentInstanceUsageInState(state, state.nodes[0]), { capacity: 1, used: 1 }));
  const other = await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", {
    idempotency: { caller: operatorCaller, key: "create-two" }
  }), at(6));
  assert.equal((await reserveInstanceAllocation(store, other.instance.id, candidate("/work/two"), at(7))).kind, "capacity");

  // An acknowledgement the hub cannot attribute to an allocation of this node is not evidence at all.
  const foreign = await receiveInstanceLifecycleReport(store, "node-two", releasedReport(created.instance.id, replacementAllocation.allocation.id, "node-two"), at(8));
  assert.equal(foreign.kind, "rejected", JSON.stringify(foreign));
  assert.equal(foreign.changed, false);
  const mismatched = await receiveInstanceLifecycleReport(store, "node-one", releasedReport(other.instance.id, replacementAllocation.allocation.id), at(9));
  assert.equal(mismatched.kind, "rejected", JSON.stringify(mismatched));
  assert.equal(mismatched.changed, false);
  store.read((state) => assert.deepEqual(residentInstanceUsageInState(state, state.nodes[0]), { capacity: 1, used: 1 }));
});

test("an acknowledged failure frees no slot, whether the lifecycle takes it or ignores it", async () => {
  /*
   * Barista sets the resident to `residentCleanupFailed`, keeps it in `residentsTable`, and only then
   * reports `instance.failed`, so a failure is the node's evidence that the allocation is dead and none
   * at all that the slot is free. Neither the accepted failure nor its replay moves capacity, and the
   * node's own next report confirms it still hosts the resident.
   */
  const store = await hubStore((state) => { seedThread(state); seedNode(state, { instanceCapacity: 1 }); });
  const { created, reservation } = await retainedResidentAfterCleanupFailure(store);
  const replay = await receiveInstanceLifecycleReport(store, "node-one", failedReport(created.instance.id, reservation.allocation.id, "node-one", "cleanup failed"), at(7));
  assert.equal(replay.kind, "ignored", JSON.stringify(replay));
  assert.equal(replay.changed, false);
  await heartbeat(store, [created.instance.id], at(8));
  store.read((state) => assert.deepEqual(residentInstanceUsageInState(state, state.nodes[0]), { capacity: 1, used: 1 }));
  const replacement = await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", {
    idempotency: { caller: operatorCaller, key: "create-two" }
  }), at(9));
  assert.equal((await reserveInstanceAllocation(store, replacement.instance.id, candidate("/work/two"), at(10))).kind, "capacity");
});

test("reservation occupies capacity atomically and never overbooks across transactions", async () => {
  const store = await hubStore((state) => { seedThread(state); seedNode(state, { instanceCapacity: 1 }); });
  const first = await applyInstanceLifecycle(store, operatorCaller, createRequest(), at(1));
  const second = await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", { idempotency: { caller: operatorCaller, key: "create-two" } }), at(1));
  const reserved = await reserveInstanceAllocation(store, first.instance.id, candidate("/work/one"), at(2));
  assert.equal(reserved.kind, "reserved");
  const raced = await Promise.all([
    reserveInstanceAllocation(store, second.instance.id, candidate("/work/two"), at(3)),
    reserveInstanceAllocation(store, second.instance.id, candidate("/work/two"), at(3))
  ]);
  assert.ok(raced.every((result) => result.kind === "capacity"), JSON.stringify(raced));
  store.read((state) => {
    assert.equal(second.instance.status, "requested");
    assert.equal(currentAllocationInState(state, second.instance.id), undefined);
    assert.equal(state.instanceDeliveries?.length, 1);
    assert.equal(state.instanceDeliveries?.[0].kind, "provision");
    // The persisted provision command is wire-valid for a protocol-v5 Barista.
    assert.equal(validateInstanceHubMessage(state.instanceDeliveries![0].message, "5").ok, true);
  });
});

test("a reported resident count above persisted allocations also blocks reservation", async () => {
  const store = await hubStore((state) => { seedThread(state); seedNode(state, { instanceCapacity: 1, activeInstances: 1 }); });
  const created = await applyInstanceLifecycle(store, operatorCaller, createRequest(), at(1));
  const result = await reserveInstanceAllocation(store, created.instance.id, candidate("/work/one"), at(2));
  assert.equal(result.kind, "capacity");
});

test("reservation validates the candidate and leaves the instance requested on failure", async () => {
  const store = await hubStore((state) => { seedThread(state); seedNode(state); });
  const created = await applyInstanceLifecycle(store, operatorCaller, createRequest(), at(1));
  const cases = [
    { nodeId: "node-one", harnessId: "codex-cli" as const, model: "fable", transport: "native-cli" as const, workspace: "/work/a" },
    { nodeId: "node-one", harnessId: "claude-cli" as const, model: "other-model", transport: "native-cli" as const, workspace: "/work/a" },
    { nodeId: "node-one", harnessId: "claude-cli" as const, model: "fable", transport: "native-cli" as const, workspace: "/outside/a" }
  ];
  for (const entry of cases) {
    const result = await reserveInstanceAllocation(store, created.instance.id, entry, at(2));
    assert.notEqual(result.kind, "reserved");
  }
  const unknownNode = await reserveInstanceAllocation(store, created.instance.id, { ...candidate("/work/a"), nodeId: "node-gone" }, at(2));
  assert.equal(unknownNode.kind, "capacity");
  store.read((state) => {
    assert.equal(state.instances?.[0].status, "requested");
    assert.equal(state.allocations?.length ?? 0, 0);
  });
});

test("ready and released acknowledgements authenticate node, allocation, and current generation", async () => {
  const store = await hubStore((state) => { seedThread(state); seedNode(state); });
  const { created, reservation } = await provisionInstance(store);
  const instanceId = created.instance.id;
  const allocationId = reservation.allocation.id;

  const wrongNode = await receiveInstanceLifecycleReport(store, "node-two", readyReport(instanceId, allocationId, "node-two"), at(3));
  assert.equal(wrongNode.kind, "rejected");
  const wrongAllocation = await receiveInstanceLifecycleReport(store, "node-one", readyReport(instanceId, "alloc-other"), at(3));
  assert.equal(wrongAllocation.kind, "rejected");
  const wrongInstance = await receiveInstanceLifecycleReport(store, "node-one", readyReport("inst-other", allocationId), at(3));
  assert.equal(wrongInstance.kind, "rejected");

  const accepted = await receiveInstanceLifecycleReport(store, "node-one", readyReport(instanceId, allocationId), at(3));
  assert.equal(accepted.kind, "accepted");
  store.read((state) => {
    assert.equal(state.instances?.[0].status, "ready");
    assert.equal(state.allocations?.[0].status, "active");
  });

  // An exact acknowledgement replay is harmless.
  const replay = await receiveInstanceLifecycleReport(store, "node-one", readyReport(instanceId, allocationId), at(4));
  assert.equal(replay.kind, "ignored");

  await applyInstanceLifecycle(store, operatorCaller, releaseRequest(instanceId, "release-one", "drain"), at(4));
  const released = await receiveInstanceLifecycleReport(store, "node-one", releasedReport(instanceId, allocationId), at(5));
  assert.equal(released.kind, "accepted");
  // A terminal record cannot be reopened by a stale report.
  const lateFailure = await receiveInstanceLifecycleReport(store, "node-one", failedReport(instanceId, allocationId), at(6));
  assert.equal(lateFailure.kind, "rejected");
  const lateReady = await receiveInstanceLifecycleReport(store, "node-one", readyReport(instanceId, allocationId), at(6));
  assert.equal(lateReady.kind, "rejected");
  store.read((state) => {
    assert.equal(state.instances?.[0].status, "released");
    assert.equal(state.allocations?.[0].status, "released");
  });
});

test("a failed acknowledgement fails the instance and its allocation", async () => {
  const store = await hubStore((state) => { seedThread(state); seedNode(state); });
  const { created, reservation } = await provisionInstance(store);
  const outcome = await receiveInstanceLifecycleReport(store, "node-one", failedReport(created.instance.id, reservation.allocation.id), at(3));
  assert.equal(outcome.kind, "accepted");
  store.read((state) => {
    assert.equal(state.instances?.[0].status, "failed");
    assert.equal(state.allocations?.[0].status, "failed");
  });
  const replay = await receiveInstanceLifecycleReport(store, "node-one", failedReport(created.instance.id, reservation.allocation.id), at(4));
  assert.equal(replay.kind, "ignored");
});

test("release requests transition monotonically and converge to one released record", async () => {
  const store = await hubStore((state) => { seedThread(state); seedNode(state); });
  const { created, reservation } = await provisionInstance(store);
  const instanceId = created.instance.id;
  await receiveInstanceLifecycleReport(store, "node-one", readyReport(instanceId, reservation.allocation.id), at(3));

  const drain = await applyInstanceLifecycle(store, operatorCaller, releaseRequest(instanceId, "release-one", "drain"), at(4));
  assert.equal(drain.instance.status, "draining");
  // Drain then cancel escalates; cancel then drain cannot soften the intent.
  await applyInstanceLifecycle(store, operatorCaller, releaseRequest(instanceId, "release-two", "cancel"), at(5));
  store.read((state) => {
    assert.equal(state.instanceReleaseIntents?.find((intent) => intent.instanceId === instanceId)?.mode, "cancel");
    const pending = state.instanceDeliveries?.filter((record) => record.kind === "release") ?? [];
    assert.equal(pending.length, 1);
    assert.equal((pending[0].message as { mode: string }).mode, "cancel");
  });

  const outcome = await receiveInstanceLifecycleReport(store, "node-one", releasedReport(instanceId, reservation.allocation.id), at(6));
  assert.equal(outcome.kind, "accepted");
  store.read((state) => {
    assert.equal(state.instances?.[0].status, "released");
    assert.equal(state.allocations?.filter((allocation) => allocation.instanceId === instanceId).length, 1);
    assert.equal(state.allocations?.[0].status, "released");
  });

  // An exact release replay answers with the settled record.
  const replay = await applyInstanceLifecycle(store, operatorCaller, releaseRequest(instanceId, "release-one", "drain"), at(7));
  assert.equal(replay.replayed, true);
  assert.equal(replay.instance.status, "released");
});

test("a release under a new key on a terminal instance conflicts", async () => {
  const store = await hubStore((state) => { seedThread(state); });
  const created = await applyInstanceLifecycle(store, operatorCaller, createRequest(), at(1));
  await applyInstanceLifecycle(store, operatorCaller, releaseRequest(created.instance.id, "release-one", "drain"), at(2));
  await assert.rejects(applyInstanceLifecycle(store, operatorCaller, releaseRequest(created.instance.id, "release-other", "drain"), at(3)), /already/);
});

test("drain waits for active runs and releases an unallocated instance directly", async () => {
  const store = await hubStore((state) => { seedThread(state); });
  const created = await applyInstanceLifecycle(store, operatorCaller, createRequest(), at(1));
  await applyInstanceLifecycle(store, operatorCaller, releaseRequest(created.instance.id, "release-one", "drain"), at(2));
  // Nothing is resident and no runs are active, so the release settles in the same transaction.
  store.read((state) => assert.equal(state.instances?.[0].status, "released"));
  await maintainInstanceLifecycle(store, at(3));
  store.read((state) => assert.equal(state.instances?.[0].status, "released"));

  // With a resident allocation, draining persists the release command instead.
  const storeTwo = await hubStore((state) => { seedThread(state); seedNode(state); });
  const second = await applyInstanceLifecycle(storeTwo, operatorCaller, createRequest("thread-one", { idempotency: { caller: operatorCaller, key: "create-two" } }), at(1));
  await reserveInstanceAllocation(storeTwo, second.instance.id, candidate("/work/two"), at(2));
  await storeTwo.transact((state) => {
    state.runs.push({
      id: "run-one", threadId: "thread-one", instanceId: second.instance.id, agentId: "", nodeId: "node-one",
      harnessId: "claude-cli", model: "fable", workspace: "/work/two", prompt: "", status: "running", output: "",
      depth: 0, createdAt: at(2), transport: "native-cli"
    } as never);
  });
  await applyInstanceLifecycle(storeTwo, operatorCaller, releaseRequest(second.instance.id, "release-two", "drain"), at(3));
  await maintainInstanceLifecycle(storeTwo, at(4));
  storeTwo.read((state) => {
    assert.equal(state.instances?.[0].status, "draining");
    assert.equal(state.instanceDeliveries?.filter((record) => record.kind === "release").length, 0);
  });
  await storeTwo.transact((state) => { state.runs.find((run) => run.id === "run-one")!.status = "completed"; });
  await maintainInstanceLifecycle(storeTwo, at(5));
  storeTwo.read((state) => {
    assert.equal(state.instanceDeliveries?.filter((record) => record.kind === "release").length, 1);
    assert.equal(state.instances?.[0].status, "draining");
  });

  // Cancel is the operator's machine-local termination request. It must be enqueued while the run
  // is active; waiting for completion here would silently reduce cancel to drain.
  const storeThree = await hubStore((state) => { seedThread(state); seedNode(state); });
  const third = await applyInstanceLifecycle(storeThree, operatorCaller, createRequest("thread-one", {
    idempotency: { caller: operatorCaller, key: "create-three" }
  }), at(1));
  const thirdReservation = await reserveInstanceAllocation(storeThree, third.instance.id, candidate("/work/three"), at(2));
  assert.equal(thirdReservation.kind, "reserved");
  await storeThree.transact((state) => {
    state.runs.push({
      id: "run-cancel", threadId: "thread-one", instanceId: third.instance.id, allocationId: thirdReservation.allocation.id,
      nodeId: "node-one", harnessId: "claude-cli", model: "fable", workspace: "/work/three", prompt: "", status: "running",
      output: "", depth: 0, createdAt: at(2), transport: "native-cli"
    });
    return true;
  });
  await applyInstanceLifecycle(storeThree, operatorCaller, releaseRequest(third.instance.id, "release-three", "cancel"), at(3));
  storeThree.read((state) => {
    const releases = state.instanceDeliveries?.filter((record) => record.kind === "release") ?? [];
    assert.equal(releases.length, 1);
    assert.equal(releases[0].message.type === "instance.release" && releases[0].message.mode, "cancel");
    assert.equal(state.runs.find((run) => run.id === "run-cancel")?.status, "running", "Hub does not pretend the local cancellation already completed");
  });
  const cancelled = await receiveInstanceLifecycleReport(
    storeThree,
    "node-one",
    releasedReport(third.instance.id, thirdReservation.allocation.id),
    at(4)
  );
  assert.equal(cancelled.kind, "accepted");
  storeThree.read((state) => {
    assert.equal(state.runs.find((run) => run.id === "run-cancel")?.status, "cancelled",
      "the release acknowledgement converges even if it arrives before run.cancelled");
  });
});

test("an omitted renewal and an explicit default renewal never share an idempotency digest", async () => {
  const store = await hubStore((state) => { seedThread(state); seedNode(state); });
  const created = await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", {
    idleTimeoutSeconds: 3600, idempotency: { caller: operatorCaller, key: "create-one" }
  }), at(1));
  // An omitted timeout preserves the instance's existing timeout...
  const omitted = await applyInstanceLifecycle(store, operatorCaller, renewRequest(created.instance.id, "renew-one"), at(2));
  assert.equal(omitted.instance.lease.idleTimeoutSeconds, 3600);
  // ...so an explicit renewal of the same key with the global default must conflict, not replay.
  await assert.rejects(
    applyInstanceLifecycle(store, operatorCaller, renewRequest(created.instance.id, "renew-one", 1800), at(3)),
    /idempotency key was already used/
  );
  store.read((state) => {
    assert.equal(state.instances?.[0].lease.idleTimeoutSeconds, 3600);
    assert.equal(state.instanceLifecycleReceipts?.length, 2);
  });
});

test("a maximum-length idempotency key still creates its initial task", async () => {
  const store = await hubStore((state) => { seedThread(state); });
  const result = await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", {
    idempotency: { caller: operatorCaller, key: "k".repeat(128) },
    initialTask: { title: "First chore", instructions: "Be careful." }
  }), at(1));
  assert.notEqual(result.initialTaskId, undefined);
  store.read((state) => {
    assert.equal(state.tasks?.length, 1);
    assert.equal(state.tasks?.[0].threadId, "thread-one");
  });
});

test("renewal extends the lease on the instance and its current allocation only while active", async () => {
  const store = await hubStore((state) => { seedThread(state); seedNode(state); });
  const { created, reservation } = await provisionInstance(store);
  const renewed = await applyInstanceLifecycle(store, operatorCaller, renewRequest(created.instance.id, "renew-one", 3600), at(10));
  assert.equal(renewed.instance.lease.idleTimeoutSeconds, 3600);
  store.read((state) => {
    assert.equal(state.instances?.[0].lease.idleTimeoutSeconds, 3600);
    assert.equal(state.allocations?.[0].lease.idleTimeoutSeconds, 3600);
    assert.equal(Date.parse(state.instances?.[0].lease.expiresAt!), Date.parse(at(10 + 3600)));
    assert.equal(state.allocations?.[0].lease.expiresAt, state.instances?.[0].lease.expiresAt);
  });
  assert.equal(reservation.allocation.id, currentAllocationInState(store.read((state) => state), created.instance.id)!.id);

  await receiveInstanceLifecycleReport(store, "node-one", readyReport(created.instance.id, reservation.allocation.id), at(59));
  await applyInstanceLifecycle(store, operatorCaller, releaseRequest(created.instance.id, "release-one", "drain"), at(60));
  await receiveInstanceLifecycleReport(store, "node-one", releasedReport(created.instance.id, reservation.allocation.id), at(60));
  const renewedAgain = await applyInstanceLifecycle(store, operatorCaller, renewRequest(created.instance.id, "renew-one", 3600), at(61));
  assert.equal(renewedAgain.replayed, true);
  await assert.rejects(applyInstanceLifecycle(store, operatorCaller, renewRequest(created.instance.id, "renew-two"), at(62)), /released/);
});

test("idle expiry is bounded, race-safe, and auditable", async () => {
  const store = await hubStore((state) => { seedThread(state); });
  const created = await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", { idleTimeoutSeconds: 60 }), at(1));
  // A renewal before the pass keeps the instance alive; the pass must recheck timestamps.
  await applyInstanceLifecycle(store, operatorCaller, renewRequest(created.instance.id, "renew-one", 3600), at(100));
  await maintainInstanceLifecycle(store, at(200));
  store.read((state) => assert.equal(state.instances?.[0].status, "requested"));

  await store.transact((state) => { state.instances![0].lease.expiresAt = at(50); });
  await maintainInstanceLifecycle(store, at(300));
  store.read((state) => {
    // Expiry enters draining and, with nothing resident to acknowledge, settles to released in the
    // same transactional pass.
    assert.equal(state.instances?.[0].status, "released");
    assert.ok(state.events?.some((event) => event.title.includes("expired")));
  });
});

test("explicit sync reconciles exact, missing, and unknown residents without adopting", async () => {
  const store = await hubStore((state) => { seedThread(state); seedNode(state, { instanceCapacity: 3 }); });
  const { created } = await provisionInstance(store);
  // A second instance whose provision was never delivered stays reserved.
  const undelivered = await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", { idempotency: { caller: operatorCaller, key: "create-two" } }), at(1));
  await reserveInstanceAllocation(store, undelivered.instance.id, candidate("/work/two"), at(2));

  // Absent evidence is non-authoritative: no reconciliation runs at all.
  assert.equal(hasAuthoritativeInstanceEvidence({ type: "sync.complete", nodeId: "node-one", at: at(3) }), false);

  await store.transact((state) => {
    assert.equal(reconcileNodeInstancesInState(state, "node-one", [created.instance.id, "foreign-instance"], at(3)), true);
  });
  store.read((state) => {
    // Exact resident remains with its allocation intent untouched.
    assert.equal(state.instances?.find((instance) => instance.id === created.instance.id)!.status, "provisioning");
    // The undelivered reservation is left for outbox replay, not marked lost.
    assert.equal(state.allocations?.find((allocation) => allocation.instanceId === undelivered.instance.id)!.status, "reserved");
    // The unknown resident is never adopted: a remote release is requested instead.
    assert.deepEqual(state.remoteReleaseRequests, [{ nodeId: "node-one", instanceId: "foreign-instance", requestedAt: at(3) }]);
    assert.equal(state.instances?.some((instance) => instance.id === "foreign-instance"), false);
  });

  // Once the reserved allocation is delivered and then missing, it becomes lost exactly once.
  await store.transact((state) => {
    const allocation = state.allocations!.find((item) => item.instanceId === undelivered.instance.id)!;
    allocation.status = "provisioning";
  });
  await store.transact((state) => {
    assert.equal(reconcileNodeInstancesInState(state, "node-one", [], at(5)), true);
  });
  store.read((state) => {
    const lostAllocation = state.allocations!.find((item) => item.instanceId === undelivered.instance.id)!;
    assert.equal(lostAllocation.status, "lost");
    assert.equal(state.instances!.find((instance) => instance.id === undelivered.instance.id)!.status, "requested");
    assert.equal(state.instanceDeliveries?.some((record) => record.allocationId === lostAllocation.id), false);
  });
  // A second identical sync changes nothing: lost is recorded once.
  await store.transact((state) => {
    assert.equal(reconcileNodeInstancesInState(state, "node-one", [], at(6)), false);
  });
});

test("a draining instance whose allocation is lost settles to released without a release command", async () => {
  const store = await hubStore((state) => { seedThread(state); seedNode(state); });
  const { created, reservation } = await provisionInstance(store);
  await applyInstanceLifecycle(store, operatorCaller, releaseRequest(created.instance.id, "release-one", "drain"), at(3));
  await store.transact((state) => { reconcileNodeInstancesInState(state, "node-one", [], at(4)); });
  store.read((state) => assert.equal(state.allocations?.[0].status, "lost"));
  await maintainInstanceLifecycle(store, at(5));
  store.read((state) => {
    assert.equal(state.instances?.[0].status, "released");
    assert.equal(state.allocations?.[0].status, "released");
    assert.equal(reservation.allocation.id, state.allocations?.[0].id);
  });
});

test("a delayed acknowledgement from a lost allocation cannot mutate its replacement", async () => {
  const store = await hubStore((state) => { seedThread(state); seedNode(state, { instanceCapacity: 2 }); });
  const { created, reservation } = await provisionInstance(store);
  await store.transact((state) => { reconcileNodeInstancesInState(state, "node-one", [], at(3)); });
  const replacement = await reserveInstanceAllocation(store, created.instance.id, candidate("/work/replacement"), at(4));
  assert.equal(replacement.kind, "reserved");
  const delayed = await receiveInstanceLifecycleReport(store, "node-one", readyReport(created.instance.id, reservation.allocation.id), at(5));
  assert.equal(delayed.kind, "rejected");
  store.read((state) => {
    assert.equal(state.instances?.[0].status, "provisioning");
    assert.equal(state.allocations?.find((allocation) => allocation.id === reservation.allocation.id)!.status, "lost");
  });
});

test("delivery decisions are persisted before the send and replayed only after reconnect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-instances-"));
  const path = join(directory, "state.json");
  const store = new Store(path);
  await store.load();
  await store.transact((state) => { seedThread(state); seedNode(state, { instanceCapacity: 2 }); });
  const { created } = await provisionInstance(store);

  const sent: string[] = [];
  let changed = await flushPendingInstanceDeliveries(store, (nodeId, message) => {
    sent.push(`${nodeId}:${message.type}`);
    return true;
  });
  assert.equal(changed, false, "the provision command was already delivered by the helper");

  // An undelivered command survives a restart and replays only to a live connection.
  const second = await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", { idempotency: { caller: operatorCaller, key: "create-two" } }), at(5));
  await reserveInstanceAllocation(store, second.instance.id, candidate("/work/two"), at(6));
  const reloaded = new Store(path);
  await reloaded.load();
  let attempted = 0;
  changed = await flushPendingInstanceDeliveries(reloaded, () => { attempted += 1; return false; });
  assert.equal(changed, false);
  assert.equal(attempted, 1);
  changed = await flushPendingInstanceDeliveries(reloaded, () => true);
  assert.equal(changed, true);
  reloaded.read((state) => {
    assert.ok(state.instances?.find((instance) => instance.id === created.instance.id));
    assert.equal(state.instanceDeliveries?.every((record) => record.deliveredAt !== undefined), true);
    assert.equal(state.allocations?.find((allocation) => allocation.instanceId === second.instance.id)!.status, "provisioning");
  });
});

test("delivered commands are never resent", async () => {
  const store = await hubStore((state) => { seedThread(state); seedNode(state); });
  await provisionInstance(store);
  const sent: string[] = [];
  const changed = await flushPendingInstanceDeliveries(store, () => { sent.push("resent"); return true; });
  assert.equal(changed, false);
  assert.deepEqual(sent, []);
});

test("terminal audit records are retained under explicit pruning bounds", async () => {
  const store = await hubStore((state) => { seedThread(state); });
  const beyond = instanceAuditLimits.retainedTerminalInstances + 5;
  for (let index = 0; index < beyond; index += 1) {
    const created = await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", {
      idempotency: { caller: operatorCaller, key: `create-${index}` }
    }), at(index + 1));
    await applyInstanceLifecycle(store, operatorCaller, releaseRequest(created.instance.id, `release-${index}`, "drain"), at(index + 1));
    await maintainInstanceLifecycle(store, at(index + 2));
  }
  store.read((state) => {
    assert.equal(state.instances?.length, instanceAuditLimits.retainedTerminalInstances);
    assert.ok(state.instances!.every((instance) => instance.status === "released"));
    const instanceIds = new Set(state.instances!.map((instance) => instance.id));
    /*
     * The receipt collection is bounded by the instances the hub retains, not by a global count: a
     * receipt is retired only with its instance, so every retained receipt still names one. This
     * replaces an assertion against a global `retainedReceipts` ceiling, which was the bound that
     * dropped a live instance's receipts; the invariant below is strictly stronger, because it also
     * forbids a receipt whose instance is gone.
     */
    assert.ok(state.instanceLifecycleReceipts!.every((receipt) => instanceIds.has(receipt.instanceId)));
    assert.ok((state.instanceLifecycleReceipts?.length ?? 0) <= instanceIds.size * instanceAuditLimits.retainedReceiptsPerInstance);
    assert.ok(state.instanceReleaseIntents!.every((intent) => instanceIds.has(intent.instanceId)));
    /*
     * Every record derived from a pruned one is retired with its source, in either direction: no
     * allocation or command outlives its instance, and no lifecycle-origin task submission outlives
     * the receipt that derived it.
     */
    assert.ok((state.allocations ?? []).every((allocation) => instanceIds.has(allocation.instanceId)));
    assert.ok((state.instanceDeliveries ?? []).every((record) => (state.allocations ?? []).some((allocation) => allocation.id === record.allocationId)));
    assert.ok((state.remoteReleaseRequests ?? []).every((request) => nodeResidencyInState(state, request.nodeId)?.instanceIds.includes(request.instanceId) === true));
    assert.ok((state.taskSubmissions ?? []).every((submission) => submission.origin !== "instance-lifecycle"
      || state.instanceLifecycleReceipts!.some((receipt) => submission.tasks.some((entry) => entry.taskId === receipt.initialTaskId))));
  });
});

test("pruning holds the terminal bound exactly, and the next report restores occupancy", async () => {
  /*
   * Pruning used to pin every identity a node's record named, because the record refreshed only on
   * connection attachment: dropping the settled allocation left nothing to discount the identity, and
   * the resulting phantom occupancy was permanent for as long as the node stayed connected. The record
   * now refreshes every heartbeat, so nothing has to be preserved for the capacity derivation and the
   * terminal bound is exactly `retainedTerminalInstances` with no residency exemption above it. The
   * cost is one heartbeat interval of a record naming an identity the hub no longer retains.
   */
  const store = await hubStore((state) => { seedThread(state); seedNode(state, { instanceCapacity: 1 }); });
  const { created, reservation } = await provisionInstance(store);
  await heartbeat(store, [created.instance.id], at(3));
  assert.equal((await receiveInstanceLifecycleReport(store, "node-one", readyReport(created.instance.id, reservation.allocation.id), at(4))).kind, "accepted");
  await applyInstanceLifecycle(store, operatorCaller, releaseRequest(created.instance.id, "release-one", "drain"), at(5));
  assert.equal((await receiveInstanceLifecycleReport(store, "node-one", releasedReport(created.instance.id, reservation.allocation.id), at(6))).kind, "accepted");
  const usage = () => store.read((state) => residentInstanceUsageInState(state, state.nodes[0]));
  assert.deepEqual(usage(), { capacity: 1, used: 1 }, "the node still reports the resident it has not yet dropped");

  // Enough later terminal instances to push the released one past the retention bound; every filler
  // settles after it, so it is the oldest and is the first record pruning drops.
  const beyond = instanceAuditLimits.retainedTerminalInstances + 5;
  for (let index = 0; index < beyond; index += 1) {
    const filler = await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", {
      idempotency: { caller: operatorCaller, key: `filler-${index}` }
    }), at(100 + index));
    await applyInstanceLifecycle(store, operatorCaller, releaseRequest(filler.instance.id, `filler-release-${index}`, "drain"), at(100 + index));
  }
  await maintainInstanceLifecycle(store, at(1000));
  store.read((state) => {
    assert.equal(state.instances!.some((instance) => instance.id === created.instance.id), false, "no identity is exempt from the bound");
    assert.equal(state.instances!.length, instanceAuditLimits.retainedTerminalInstances, "the bound is exact");
    assert.equal(state.instances!.filter((instance) => terminalInstanceStatuses.includes(instance.status)).length, instanceAuditLimits.retainedTerminalInstances);
  });
  assert.deepEqual(usage(), { capacity: 1, used: 1 }, "the record still names the pruned identity until the node's next report");

  // One heartbeat interval later the node no longer names it, and the slot is free again.
  await heartbeat(store, [], at(1001));
  assert.deepEqual(usage(), { capacity: 1, used: 0 });
  const replacement = await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", {
    idempotency: { caller: operatorCaller, key: "create-replacement" }
  }), at(1002));
  assert.equal((await reserveInstanceAllocation(store, replacement.instance.id, candidate("/work/two"), at(1003))).kind, "reserved");
});

test("pruning retires the task submission a create receipt derived, not just the receipt", async () => {
  /*
   * Finding 3: retention has to be symmetric. The submission is what answers a replay of the derived
   * key, so a create receipt pruned without it leaves a new instance whose `initialTaskId` names the
   * previous instance's task, with no initial task scheduled for the new one.
   */
  const store = await hubStore((state) => { seedThread(state); });
  const created = await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", {
    initialTask: { title: "First chore", instructions: "Be careful." }
  }), at(1));
  assert.notEqual(created.initialTaskId, undefined);
  await applyInstanceLifecycle(store, operatorCaller, releaseRequest(created.instance.id, "release-one", "drain"), at(1));
  const beyond = instanceAuditLimits.retainedTerminalInstances + 5;
  for (let index = 0; index < beyond; index += 1) {
    const filler = await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", {
      idempotency: { caller: operatorCaller, key: `filler-${index}` }
    }), at(100 + index));
    await applyInstanceLifecycle(store, operatorCaller, releaseRequest(filler.instance.id, `filler-release-${index}`, "drain"), at(100 + index));
  }
  await maintainInstanceLifecycle(store, at(1000));
  store.read((state) => {
    assert.equal(state.instances!.some((instance) => instance.id === created.instance.id), false);
    assert.equal(state.instanceLifecycleReceipts!.some((receipt) => receipt.instanceId === created.instance.id), false);
    assert.equal(state.taskSubmissions!.some((submission) => submission.origin === "instance-lifecycle"), false, "the derived submission is retired with its receipt");
    // The task is thread work that may already have run; only the idempotency record is retired.
    assert.ok(state.tasks!.some((task) => task.id === created.initialTaskId));
  });

  const reused = await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", {
    initialTask: { title: "First chore", instructions: "Be careful." }
  }), at(2000));
  assert.equal(reused.replayed, false);
  assert.notEqual(reused.instance.id, created.instance.id);
  assert.notEqual(reused.initialTaskId, created.initialTaskId, "a new instance never inherits the pruned instance's task");
  store.read((state) => {
    assert.equal(state.tasks!.filter((task) => task.title === "First chore").length, 2, "the new instance got an initial task of its own");
    assert.equal(state.tasks!.find((task) => task.id === reused.initialTaskId)!.threadId, "thread-one");
  });
});

test("a remote release the node's residency record does not support is retired instead of sent", async () => {
  /*
   * Finding 4: absent evidence is not permission. The maintenance path treated a missing residency
   * record as permission to order an eviction, so a persisted request with nothing behind it could put
   * a cancel on the wire.
   */
  const store = await hubStore((state) => { seedThread(state); seedNode(state); });
  await store.transact((state) => {
    state.remoteReleaseRequests = [{ nodeId: "node-one", instanceId: "unsupported", requestedAt: at(1) }];
    return true;
  });
  const sent: string[] = [];
  await flushPendingInstanceDeliveries(store, (_nodeId, message) => { sent.push(message.type); return true; });
  // A copy is compared so the deep-equal assertion does not narrow `sent` for the stanzas below.
  assert.deepEqual([...sent], [], "no residency record is not permission to send a cancel");
  store.read((state) => assert.deepEqual(state.remoteReleaseRequests, []));

  // A record that exists but names other residents is the same failure with more to go on.
  await store.transact((state) => {
    state.nodeInstanceResidency = [{ nodeId: "node-one", instanceIds: ["resident-one"], observedAt: at(2) }];
    state.remoteReleaseRequests = [{ nodeId: "node-one", instanceId: "resident-two", requestedAt: at(2) }];
    return true;
  });
  await flushPendingInstanceDeliveries(store, (_nodeId, message) => { sent.push(message.type); return true; });
  assert.deepEqual([...sent], []);
  store.read((state) => assert.deepEqual(state.remoteReleaseRequests, []));

  // Supported evidence still sends, so the rule refuses only what no record reports.
  await store.transact((state) => {
    state.remoteReleaseRequests = [{ nodeId: "node-one", instanceId: "resident-one", requestedAt: at(3) }];
    return true;
  });
  await flushPendingInstanceDeliveries(store, (_nodeId, message) => { sent.push(message.type); return true; });
  assert.deepEqual(sent, ["instance.release"]);
  store.read((state) => assert.equal(state.remoteReleaseRequests?.[0].deliveredAt !== undefined, true));
});

test("pending remote release requests are retained until delivered, beyond any audit bound", async () => {
  const store = await hubStore((state) => { seedThread(state); seedNode(state); });
  // More unknown residents than the old retention bound, and deduplication keeps them stable.
  const unknownResidents = Array.from({ length: 505 }, (_, index) => `foreign-${index}`);
  await store.transact((state) => {
    assert.equal(reconcileNodeInstancesInState(state, "node-one", unknownResidents, at(1)), true);
  });
  // The maintenance pass prunes audit records; an actionable release request must survive it.
  await maintainInstanceLifecycle(store, at(2));
  store.read((state) => assert.equal(state.remoteReleaseRequests?.length, unknownResidents.length));
  let delivered = 0;
  await flushPendingInstanceDeliveries(store, () => { delivered += 1; return true; });
  assert.equal(delivered, unknownResidents.length);
  // A send is recorded, not a receipt: the requests stay until the node stops reporting the residents.
  store.read((state) => {
    assert.equal(state.remoteReleaseRequests?.length, unknownResidents.length);
    assert.ok(state.remoteReleaseRequests!.every((request) => request.deliveredAt !== undefined));
  });
  let resent = 0;
  await flushPendingInstanceDeliveries(store, () => { resent += 1; return true; });
  assert.equal(resent, 0, "a request already written to the socket is not resent without new evidence");
  await store.transact((state) => { reconcileNodeInstancesInState(state, "node-one", [], at(3)); return true; });
  store.read((state) => assert.deepEqual(state.remoteReleaseRequests, []));
});

test("a remote release replays once per reconnect and cannot loop against a refusing Barista", async () => {
  const store = await hubStore((state) => { seedThread(state); seedNode(state); });
  const sent: string[] = [];
  // A Barista that keeps reporting the resident has plainly not acted on the release. Each
  // authoritative snapshot re-arms the one request, so replay costs one send per reconnect and the
  // outbox never grows.
  for (let reconnect = 0; reconnect < 4; reconnect += 1) {
    await store.transact((state) => { reconcileNodeInstancesInState(state, "node-one", ["stubborn"], at(10 + reconnect)); return true; });
    await flushPendingInstanceDeliveries(store, (_nodeId, message) => { sent.push(message.type); return true; });
    store.read((state) => {
      assert.equal(state.remoteReleaseRequests?.length, 1, `after reconnect ${reconnect}`);
      assert.equal(state.remoteReleaseRequests?.[0].requestedAt, at(10), "the record is reused, never duplicated");
    });
  }
  assert.equal(sent.length, 4);
  // Replay writes nothing to the hub-wide timeline, so a refusing peer cannot grow it either.
  store.read((state) => assert.equal(state.events.filter((event) => event.title.includes("Instance")).length, 0));
});

test("every instance and allocation status is classified exactly once", () => {
  const instancePartition = [nonTerminalInstanceStatuses, ["draining"], ["released", "failed"]];
  assert.deepEqual([...instancePartition].flat().sort(), [...instanceStatuses].sort());
  const allocationPartition = [occupyingAllocationStatuses, ["lost"], ["released", "failed"]];
  assert.deepEqual([...allocationPartition].flat().sort(), [...allocationStatuses].sort());
});

test("thread listing isolates instances and allocations per thread", async () => {
  const store = await hubStore((state) => { seedThread(state); seedThread(state, "thread-two"); });
  await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one"), at(1));
  await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-two", { idempotency: { caller: operatorCaller, key: "create-two" } }), at(1));
  store.read((state) => {
    const one = listThreadInstances(state, "thread-one", true);
    assert.equal(one.instances.length, 1);
    assert.equal(one.instances[0].threadId, "thread-one");
    assert.deepEqual(listThreadInstances(state, "missing", true).instances, []);
  });
});

test("store load rejects malformed or duplicated instance state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-instances-"));
  const path = join(directory, "state.json");
  const baseInstance: AgentInstance = {
    id: "instance-one", threadId: "thread-one", creator: { kind: "operator", operatorId: "operator" },
    delegation: { canDelegate: false }, requirements: { harnessIds: ["claude-cli"] },
    lease: { idleTimeoutSeconds: 1800, expiresAt: at(1000) }, status: "requested", createdAt: at(1), updatedAt: at(1)
  };
  // Byte-faithful to what the hub itself persists: Store.save writes JSON.stringify of the state
  // (store.ts private save, the JSON branch), so these fixtures round-trip the real producer.
  const goodState = {
    agents: [], nodes: [], runs: [], events: [], messages: [],
    threads: [{ id: "thread-one", title: "t", objective: "", summary: "", status: "active", ownerAgentId: "agent-one", orchestrator: { kind: "agent", agentId: "agent-one" }, createdBy: "user", createdAt: at(1), updatedAt: at(1) }],
    instances: [baseInstance],
    allocations: []
  };
  await writeFile(path, JSON.stringify(goodState));
  const good = new Store(path);
  await good.load();
  good.read((state) => {
    assert.equal(state.instances?.length, 1);
    assert.deepEqual(state.instanceLifecycleReceipts, []);
    assert.deepEqual(state.remoteReleaseRequests, []);
  });

  const rejects = async (mutate: (state: Record<string, unknown>) => void, pattern: RegExp) => {
    const state = JSON.parse(JSON.stringify(goodState)) as Record<string, unknown>;
    mutate(state);
    await writeFile(path, JSON.stringify(state));
    const store = new Store(path);
    await assert.rejects(store.load(), pattern);
  };
  await rejects((state) => { ((state.instances as AgentInstance[])[0] as unknown as Record<string, unknown>).status = "imaginary"; }, /Persisted instance 0 is invalid/);
  await rejects((state) => { state.instances = [baseInstance, structuredClone(baseInstance)]; }, /repeats instance id/);
  await rejects((state) => { ((state.instances as AgentInstance[])[0] as unknown as Record<string, unknown>).threadId = "other-thread"; }, /unknown thread/);
  await rejects((state) => {
    state.allocations = [
      { ...allocationFor(baseInstance, "allocation-one"), status: "active" },
      { ...allocationFor(baseInstance, "allocation-two"), status: "reserved" }
    ] as unknown;
  }, /more than one current allocation/);
  await rejects((state) => {
    state.allocations = [allocationFor({ ...baseInstance, id: "ghost" }, "allocation-one")];
  }, /unknown instance/);
  await rejects((state) => {
    (state.instances as AgentInstance[])[0].requirements.skills = ["coffeeshop-preview"];
    state.allocations = [allocationFor(baseInstance, "allocation-one")];
  }, /Skill requirements require an admitted capability pack expectation/);
  await rejects((state) => {
    (state.instances as AgentInstance[])[0].status = "provisioning";
    state.allocations = [{
      ...allocationFor(baseInstance, "allocation-one"),
      expectedCapabilityPack: { id: "coffeeshop-capability-pack", version: "1.1.0", requiredSkills: ["coffeeshop-preview"] }
    }];
  }, /without skill requirements cannot carry a capability pack expectation/);
  // An explicit null is malformed persisted state, not an absent legacy collection.
  await rejects((state) => { state.instances = null; }, /Persisted instances collection is not an array/);
  await rejects((state) => { state.remoteReleaseRequests = null; }, /Persisted remoteReleaseRequests collection is not an array/);
  await rejects((state) => { state.instanceDeliveries = "no"; }, /Persisted instanceDeliveries collection is not an array/);
  await rejects((state) => { state.nodeInstanceResidency = null; }, /Persisted nodeInstanceResidency collection is not an array/);
  await rejects((state) => { state.nodeInstanceResidency = [{ nodeId: "node-one", instanceIds: ["a", "a"], observedAt: at(1) }]; }, /repeats a resident instance/);
  await rejects((state) => {
    state.nodeInstanceResidency = [
      { nodeId: "node-one", instanceIds: [], observedAt: at(1) },
      { nodeId: "node-one", instanceIds: ["b"], observedAt: at(2) }
    ];
  }, /repeats node node-one/);
  await rejects((state) => { state.nodeInstanceResidency = [{ nodeId: "node-one", instanceIds: [""], observedAt: at(1) }]; }, /residency 0 is malformed/);
  /*
   * The outbox carries commands, never occupancy, so a remote release may not outlive the residency
   * evidence that produced it. Both identifiers exist; the relationship between them is what fails.
   */
  await rejects((state) => {
    state.nodeInstanceResidency = [{ nodeId: "node-one", instanceIds: ["resident-one"], observedAt: at(1) }];
    state.remoteReleaseRequests = [{ nodeId: "node-one", instanceId: "resident-two", requestedAt: at(1) }];
  }, /names a resident node node-one no longer reports/);
  await rejects((state) => {
    state.nodeInstanceResidency = [{ nodeId: "node-one", instanceIds: ["resident-one"], observedAt: at(1) }];
    state.remoteReleaseRequests = [
      { nodeId: "node-one", instanceId: "resident-one", requestedAt: at(1) },
      { nodeId: "node-one", instanceId: "resident-one", requestedAt: at(2) }
    ];
  }, /repeats its node and instance/);
  /*
   * Absent evidence is not permission. A request with no residency record behind it at all is the same
   * failure as a mismatching one, with less to go on: reconciliation writes the node's record before it
   * writes any request against that node, so a request no record supports never came from evidence.
   */
  await rejects((state) => {
    state.remoteReleaseRequests = [{ nodeId: "node-one", instanceId: "resident-one", requestedAt: at(1) }];
  }, /has no residency record from node node-one to support it/);
});

const allocationFor = (instance: AgentInstance, allocationId: string) => ({
  id: allocationId, instanceId: instance.id, nodeId: "node-one", harnessId: "claude-cli" as const, model: "fable",
  transport: "native-cli" as const, workspace: "/work/instance", lease: { idleTimeoutSeconds: 1800, expiresAt: at(1000) },
  status: "reserved" as const, createdAt: at(1), updatedAt: at(1)
});

test("legacy snapshots load without inventing instance allocations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-instances-"));
  const path = join(directory, "state.json");
  await writeFile(path, JSON.stringify({ agents: [], nodes: [], runs: [], events: [], messages: [] }));
  const store = new Store(path);
  await store.load();
  const snapshot = store.snapshot();
  assert.deepEqual(snapshot.instances, []);
  assert.deepEqual(snapshot.allocations, []);
  assert.deepEqual(snapshot.templates, []);
  assert.equal("instanceLifecycleReceipts" in JSON.parse(JSON.stringify(snapshot)), false);
  assert.equal("instanceDeliveries" in JSON.parse(JSON.stringify(snapshot)), false);
  assert.equal("nodeInstanceResidency" in JSON.parse(JSON.stringify(snapshot)), false);
});

test("a reported resident the hub does not own occupies a slot beside new reservations", async () => {
  // A capacity-2 node reporting one unknown resident has one slot left, not two: reported residency
  // and persisted allocations are disjoint sets of identities, so their union is what is occupied.
  const store = await hubStore((state) => { seedThread(state); seedNode(state, { instanceCapacity: 2 }); });
  const first = await applyInstanceLifecycle(store, operatorCaller, createRequest(), at(1));
  const second = await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", {
    idempotency: { caller: operatorCaller, key: "create-two" }
  }), at(1));
  await store.transact((state) => { reconcileNodeInstancesInState(state, "node-one", ["foreign-instance"], at(2)); return true; });

  const reserved = await reserveInstanceAllocation(store, first.instance.id, candidate("/work/one"), at(3));
  assert.equal(reserved.kind, "reserved");
  const refused = await reserveInstanceAllocation(store, second.instance.id, candidate("/work/two"), at(4));
  assert.equal(refused.kind, "capacity", JSON.stringify(refused));
  store.read((state) => {
    const node = state.nodes[0];
    assert.deepEqual(residentInstanceUsageInState(state, node), { capacity: 2, used: 2 });
    // An identity in both sets is counted once, so an overlapping report cannot double-book.
    assert.deepEqual(
      residentInstanceUsage(node, state.allocations ?? [], { nodeId: "node-one", instanceIds: [first.instance.id], observedAt: at(2) }),
      { capacity: 2, used: 1 }
    );
    // Another node's reported residents never consume this node's capacity.
    assert.deepEqual(
      residentInstanceUsage(node, state.allocations ?? [], { nodeId: "node-two", instanceIds: ["foreign-instance"], observedAt: at(2) }),
      { capacity: 2, used: 1 }
    );
  });

  /*
   * Finding 1: the release the hub sends for that unknown resident is a command, not an occupancy
   * record. An accepted socket write must not free the slot — only the node's own later snapshot,
   * which no longer reports the resident, can.
   */
  const sent: string[] = [];
  await flushPendingInstanceDeliveries(store, (_nodeId, message) => { sent.push(message.type); return true; });
  assert.deepEqual(sent, ["instance.provision", "instance.release"]);
  store.read((state) => {
    assert.equal(state.remoteReleaseRequests?.length, 1, "the request is a send record, not a receipt");
    assert.notEqual(state.remoteReleaseRequests?.[0].deliveredAt, undefined);
    assert.deepEqual(nodeResidencyInState(state, "node-one")?.instanceIds, ["foreign-instance"]);
  });
  const stillFull = await reserveInstanceAllocation(store, second.instance.id, candidate("/work/two"), at(5));
  assert.equal(stillFull.kind, "capacity", JSON.stringify(stillFull));
  /*
   * What the hub guarantees is the emission and the retention asserted above, not the eviction: the
   * command addresses a resident the hub holds no allocation for, and Barista resolves a release by
   * allocation id until cafecito-games/CoffeeShop#90 adds the instance-id fallback. The step below is
   * the node's own later snapshot, whatever made it stop reporting the resident.
   */
  await store.transact((state) => { reconcileNodeInstancesInState(state, "node-one", [first.instance.id], at(6)); return true; });
  store.read((state) => assert.deepEqual(state.remoteReleaseRequests, []));
  const freed = await reserveInstanceAllocation(store, second.instance.id, candidate("/work/two"), at(7));
  assert.equal(freed.kind, "reserved", JSON.stringify(freed));
});

test("an authoritative empty snapshot clears a stale reported usage floor", async () => {
  // Finding 2: an older heartbeat count claimed one resident. A newer authoritative snapshot proves
  // the node has none, so it must supersede the count instead of being masked by it.
  const store = await hubStore((state) => { seedThread(state); seedNode(state, { instanceCapacity: 1, activeInstances: 1 }); });
  const created = await applyInstanceLifecycle(store, operatorCaller, createRequest(), at(1));
  assert.equal((await reserveInstanceAllocation(store, created.instance.id, candidate("/work/one"), at(2))).kind, "capacity");
  await store.transact((state) => { reconcileNodeInstancesInState(state, "node-one", [], at(3)); return true; });
  store.read((state) => {
    // The scalar is left exactly as the node reported it; the record is what decides.
    assert.equal(state.nodes[0].activeInstances, 1);
    assert.deepEqual(nodeResidencyInState(state, "node-one")?.instanceIds, []);
  });
  const reserved = await reserveInstanceAllocation(store, created.instance.id, candidate("/work/one"), at(4));
  assert.equal(reserved.kind, "reserved", JSON.stringify(reserved));
  // A later snapshot that reports a resident the hub does not own occupies the slot again.
  await store.transact((state) => {
    state.allocations!.find((allocation) => allocation.instanceId === created.instance.id)!.status = "released";
    state.instances!.find((instance) => instance.id === created.instance.id)!.status = "released";
    reconcileNodeInstancesInState(state, "node-one", ["foreign-instance"], at(5));
    return true;
  });
  store.read((state) => {
    assert.deepEqual(residentInstanceUsageInState(state, state.nodes[0]), { capacity: 1, used: 1 });
  });
});

test("resident evidence is validated before the delivery barrier is decided", () => {
  const authoritative = classifyInstanceResidentEvidence(controlFixture("sync"), "5", "sync.complete");
  assert.deepEqual(authoritative, { kind: "authoritative", residents: ["instance-one"] });
  assert.equal(instanceDeliveryBarrier(authoritative), "open-after-reconcile");
  // An explicitly empty resident set is a claim, not an omission.
  const empty = classifyInstanceResidentEvidence(controlFixture("sync-empty"), "5", "sync.complete");
  assert.deepEqual(empty, { kind: "authoritative", residents: [] });
  assert.equal(instanceDeliveryBarrier(empty), "open-after-reconcile");
  const absent = classifyInstanceResidentEvidence(controlFixture("sync-absent"), "5", "sync.complete");
  assert.deepEqual(absent, { kind: "absent" });
  assert.equal(instanceDeliveryBarrier(absent), "open-now");

  // The mutations the protocol suite treats as invalid resident evidence must fail closed here too.
  for (const residents of [null, ["same", "same"], [""], ["bad/id"], Array.from({ length: instanceLimits.collectionEntries + 1 }, (_, index) => `i-${index}`)]) {
    const frame = { ...controlFixture("sync"), activeInstanceIds: residents };
    const evidence = classifyInstanceResidentEvidence(frame, "5", "sync.complete");
    assert.equal(evidence.kind, "malformed", JSON.stringify(residents));
    assert.equal(instanceDeliveryBarrier(evidence), "stay-closed", JSON.stringify(residents));
    // The barrier cannot be decided from this predicate alone: it answers the same for a malformed
    // claim as for an omitted one, which is why validation has to precede the decision.
    assert.equal(hasAuthoritativeInstanceEvidence(frame), false);
    assert.equal(hasAuthoritativeInstanceEvidence(controlFixture("sync-absent")), false);
  }
  // A node that cannot host instances makes no resident claim at all.
  assert.deepEqual(classifyInstanceResidentEvidence(controlFixture("sync"), "4", "sync.complete"), { kind: "absent" });
});

test("the residency record is written from the producer's own sync bytes and replaced wholesale", async () => {
  /*
   * The writer is driven end to end from byte-faithful frames: Barista's encoder produced
   * packages/protocol/test/fixtures/control-v5/sync.json and sync-empty.json
   * (apps/control-agent/internal/protocol/instances_test.go:46 marshalling
   * apps/control-agent/internal/protocol/messages.go:88), classified by the same tri-state
   * classifier the socket handler uses (apps/hub/src/index.ts, the sync.complete branch).
   */
  const store = await hubStore((state) => { seedThread(state); seedNode(state, { instanceCapacity: 2, activeInstances: 2 }); });
  const applySync = async (fixture: string) => {
    const evidence = classifyInstanceResidentEvidence(controlFixture(fixture), "5", "sync.complete");
    assert.equal(evidence.kind, "authoritative", fixture);
    await store.transact((state) => {
      reconcileNodeInstancesInState(state, "node-one", (evidence as { residents: readonly string[] }).residents, at(3));
      return true;
    });
  };
  await applySync("sync");
  store.read((state) => assert.deepEqual(nodeResidencyInState(state, "node-one")?.instanceIds, ["instance-one"]));
  // The empty snapshot replaces the set wholesale rather than merging into it.
  await applySync("sync-empty");
  store.read((state) => {
    assert.deepEqual(nodeResidencyInState(state, "node-one")?.instanceIds, []);
    assert.equal(state.nodeInstanceResidency?.length, 1, "one record per node");
    assert.deepEqual(residentInstanceUsageInState(state, state.nodes[0]), { capacity: 2, used: 0 });
  });
  // Absent evidence reaches no writer at all, so the record stands; malformed evidence likewise.
  assert.deepEqual(classifyInstanceResidentEvidence(controlFixture("sync-absent"), "5", "sync.complete"), { kind: "absent" });
  assert.equal(classifyInstanceResidentEvidence({ ...controlFixture("sync"), activeInstanceIds: ["bad/id"] }, "5", "sync.complete").kind, "malformed");
  store.read((state) => assert.deepEqual(nodeResidencyInState(state, "node-one")?.instanceIds, []));
});

test("a reported instance count is validated before it reaches the node record", () => {
  assert.deepEqual(classifyReportedInstanceCount(controlFixture("heartbeat"), "5"), { kind: "reported", count: 1 });
  const omitted = controlFixture("heartbeat");
  delete omitted.activeInstances;
  assert.deepEqual(classifyReportedInstanceCount(omitted, "5"), { kind: "absent" });
  for (const count of [-1, 1.5, 65_536, null, "0"]) {
    const evidence = classifyReportedInstanceCount({ ...controlFixture("heartbeat"), activeInstances: count }, "5");
    assert.equal(evidence.kind, "malformed", JSON.stringify(count));
  }
  assert.deepEqual(classifyReportedInstanceCount(controlFixture("heartbeat"), "4"), { kind: "absent" });
  assert.equal(reportedInstanceCountFitsNode(computeNode({ instanceCapacity: 1 }), 1), true);
  assert.equal(reportedInstanceCountFitsNode(computeNode({ instanceCapacity: 1 }), 2), false);
  assert.equal(reportedInstanceCountFitsNode(computeNode({ instanceCapacity: undefined }), 65_535), true);
});

test("a heartbeat cannot make the Hub publish an invalid capacity projection", async () => {
  const store = await hubStore((state) => seedNode(state, { instanceCapacity: 1, activeInstances: 1 }));
  let update: ReturnType<typeof applyNodeHeartbeatInState> | undefined;
  await store.transact((state) => {
    update = applyNodeHeartbeatInState(state, "node-one", 2, 2, at(2));
  });
  assert.deepEqual(update, { capacityChanged: true, refusedReportedInstances: true });
  const projected = store.snapshot().nodes[0];
  assert.deepEqual(
    [projected.activeRuns, projected.activeInstances, projected.instanceCapacity, projected.lastSeen, projected.status],
    [2, 1, 1, at(2), "busy"]
  );
  assert.ok(projected.activeInstances! <= projected.instanceCapacity!);
});

test("a release the node never acted on replays after an authoritative reconnect", async () => {
  const store = await hubStore((state) => { seedThread(state); seedNode(state); });
  const { created, reservation } = await provisionInstance(store);
  await receiveInstanceLifecycleReport(store, "node-one", readyReport(created.instance.id, reservation.allocation.id), at(3));
  await applyInstanceLifecycle(store, operatorCaller, releaseRequest(created.instance.id, "release-one", "drain"), at(4));

  const sent: string[] = [];
  await flushPendingInstanceDeliveries(store, (_nodeId, message) => { sent.push(message.type); return true; });
  assert.deepEqual(sent, ["instance.release"]);

  // The socket write returned, but the connection dropped before Barista processed the frame: the
  // node reconnects still reporting the instance resident, which is proof it was never acted on.
  await store.transact((state) => { reconcileNodeInstancesInState(state, "node-one", [created.instance.id], at(5)); return true; });
  await maintainInstanceLifecycle(store, at(6));
  const replayed: string[] = [];
  await flushPendingInstanceDeliveries(store, (_nodeId, message) => { replayed.push(message.type); return true; });
  assert.deepEqual(replayed, ["instance.release"], "the unacknowledged release is reissued");
  store.read((state) => {
    // Replay reuses the record instead of duplicating it, so the outbox cannot grow per reconnect.
    assert.equal(state.instanceDeliveries?.filter((record) => record.kind === "release").length, 1);
    assert.equal(state.instances?.[0].status, "draining");
    assert.equal(currentAllocationInState(state, created.instance.id)?.id, reservation.allocation.id);
  });

  // Barista's own acknowledgement is what retires the command; after it nothing replays.
  const released = await receiveInstanceLifecycleReport(store, "node-one", releasedReport(created.instance.id, reservation.allocation.id), at(7));
  assert.equal(released.kind, "accepted");
  await maintainInstanceLifecycle(store, at(8));
  store.read((state) => assert.deepEqual(state.instanceDeliveries, []));
  const afterAcknowledgement: string[] = [];
  await flushPendingInstanceDeliveries(store, (_nodeId, message) => { afterAcknowledgement.push(message.type); return true; });
  assert.deepEqual(afterAcknowledgement, []);
});

test("a command removed before its delivery transaction is never sent", async () => {
  const store = await hubStore((state) => { seedThread(state); seedNode(state); });
  const created = await applyInstanceLifecycle(store, operatorCaller, createRequest(), at(1));
  const reservation = await reserveInstanceAllocation(store, created.instance.id, candidate("/work/one"), at(2));
  assert.equal(reservation.kind, "reserved");
  await store.transact((state) => {
    state.allocations!.find((allocation) => allocation.instanceId === created.instance.id)!.status = "provisioning";
  });
  let sends = 0;
  const changed = await flushPendingInstanceDeliveries(store, () => { sends += 1; return true; }, {
    beforeDelivery: async () => {
      await store.transact((state) => { reconcileNodeInstancesInState(state, "node-one", [], at(3)); return true; });
    }
  });
  assert.equal(sends, 0, "the reconciliation that removed the command committed before the send decision");
  assert.equal(changed, false);
  store.read((state) => assert.deepEqual(state.instanceDeliveries, []));
});

test("the derived initial-task key is caller-scoped and cannot be occupied by an ordinary batch", async () => {
  const client = { kind: "orchestrator-client", clientId: "client-one" } as const;
  const seed = (state: State) => {
    seedThread(state);
    state.agents.push({
      id: "agent-one", name: "Agent One", title: "Agent", summary: "", glyph: "A", avatarShape: "cup",
      avatarColor: "amber", state: "working", currentAction: "Working", harnessId: "claude-cli", model: "fable",
      computeNodeId: "node-one", workspace: "/work", systemPrompt: "Work", canDelegate: true, unread: 0, updatedAt: at(1)
    } as never);
    state.runs.push({
      id: "run-source", threadId: "thread-one", agentId: "agent-one", nodeId: "node-one", harnessId: "claude-cli",
      model: "fable", workspace: "/work", prompt: "Coordinate", status: "running", output: "", depth: 0, createdAt: at(1)
    } as never);
    state.orchestratorAttachments = [{ id: "attach-one", threadId: "thread-one", clientId: "client-one", connectionId: "conn-one", attachedAt: at(1), lastHeartbeatAt: at(1), status: "attached" }];
    state.orchestratorClients = [{ id: "client-one", name: "Bridge", scopes: ["orchestrate"], createdAt: at(1), secretHash: "hash" }];
  };
  const ordinaryBatch = (idempotencyKey: string) => ({
    idempotencyKey,
    tasks: [{ key: "ordinary", title: "Ordinary chore", instructions: "Unrelated work.", dependencies: [] }]
  });

  const store = await hubStore(seed);
  const created = await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", {
    initialTask: { title: "First chore", instructions: "Be careful." }
  }), at(2));
  assert.notEqual(created.initialTaskId, undefined);
  const derived = store.read((state) => state.taskSubmissions!.find((submission) => submission.origin === "instance-lifecycle")!.idempotencyKey);
  assert.ok(derived.length <= 128);

  // The derived key is deterministic, so an ordinary caller can submit exactly that string. It must
  // neither answer the lifecycle submission nor conflict with it.
  await submitTaskBatch(store, "run-source", ordinaryBatch(derived), at(3));
  store.read((state) => {
    assert.equal(state.tasks?.length, 2);
    assert.equal(state.tasks?.find((task) => task.id === created.initialTaskId)!.title, "First chore");
    assert.equal(state.taskSubmissions?.filter((submission) => submission.idempotencyKey === derived).length, 2);
    assert.deepEqual(state.taskSubmissions?.map((submission) => submission.origin).sort(), ["instance-lifecycle", undefined]);
  });

  // Lifecycle idempotency is caller-scoped, so another principal reusing the same lifecycle key on
  // the same thread creates its own instance and its own initial task instead of colliding.
  const byClient = await applyInstanceLifecycle(store, client, createRequest("thread-one", {
    idempotency: { caller: client, key: "create-one" },
    initialTask: { title: "Client chore", instructions: "Be careful." }
  }), at(4));
  assert.notEqual(byClient.instance.id, created.instance.id);
  assert.notEqual(byClient.initialTaskId, created.initialTaskId);
  // The same caller and key still replays exactly, with no second task.
  const replay = await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", {
    initialTask: { title: "First chore", instructions: "Be careful." }
  }), at(5));
  assert.equal(replay.replayed, true);
  assert.equal(replay.initialTaskId, created.initialTaskId);
  store.read((state) => assert.equal(state.tasks?.length, 3));

  // The same collision in the other order: the ordinary batch is submitted first, on a fresh hub.
  const occupied = await hubStore(seed);
  await submitTaskBatch(occupied, "run-source", ordinaryBatch(derived), at(2));
  const afterOrdinary = await applyInstanceLifecycle(occupied, operatorCaller, createRequest("thread-one", {
    initialTask: { title: "First chore", instructions: "Be careful." }
  }), at(3));
  assert.equal(afterOrdinary.replayed, false);
  occupied.read((state) => {
    assert.equal(state.tasks?.length, 2);
    assert.equal(state.tasks?.find((task) => task.id === afterOrdinary.initialTaskId)!.title, "First chore");
  });
});

test("remote release requests are retired by the node's later snapshots", async () => {
  const store = await hubStore((state) => { seedThread(state); seedNode(state); });
  // Every reconnect reports different unknown residents; retention must not accumulate them.
  for (let reconnect = 0; reconnect < 5; reconnect += 1) {
    await store.transact((state) => {
      reconcileNodeInstancesInState(state, "node-one", [`foreign-${reconnect}-a`, `foreign-${reconnect}-b`], at(10 + reconnect));
      return true;
    });
    store.read((state) => assert.equal(state.remoteReleaseRequests?.length, 2, `after reconnect ${reconnect}`));
  }
  // A resident the node keeps reporting keeps its original request, so nothing actionable is lost.
  await store.transact((state) => { reconcileNodeInstancesInState(state, "node-one", ["foreign-4-a"], at(20)); return true; });
  store.read((state) => assert.deepEqual(state.remoteReleaseRequests, [{ nodeId: "node-one", instanceId: "foreign-4-a", requestedAt: at(14) }]));
  // Another node's requests are outside this snapshot's authority.
  await store.transact((state) => { state.remoteReleaseRequests!.push({ nodeId: "node-two", instanceId: "foreign-elsewhere", requestedAt: at(21) }); });
  await store.transact((state) => { reconcileNodeInstancesInState(state, "node-one", [], at(22)); return true; });
  store.read((state) => assert.deepEqual(state.remoteReleaseRequests, [{ nodeId: "node-two", instanceId: "foreign-elsewhere", requestedAt: at(21) }]));
});

/*
 * This replaces an earlier test that asserted the per-instance bound dropped the oldest renewals of a
 * live instance (`renew-0` gone). That is exactly finding 3: dropping a live instance's receipt
 * silently invalidates an accepted idempotency key. The bound is now enforced by refusing a new key,
 * so the assertions below keep everything the old test covered — the collection stays bounded by
 * `retainedReceiptsPerInstance`, the create receipt survives, and an exact create replay still
 * answers — and add what the old behavior could not guarantee: no accepted key is ever invalidated.
 */
test("receipts are bounded by refusing a new key, never by invalidating a live instance's key", async () => {
  const store = await hubStore((state) => { seedThread(state); });
  const created = await applyInstanceLifecycle(store, operatorCaller, createRequest(), at(1));
  const budget = instanceAuditLimits.retainedReceiptsPerInstance - instanceAuditLimits.releaseReceiptHeadroom;
  // The create receipt already occupies one position in the instance's budget.
  for (let index = 0; index < budget - 1; index += 1) {
    await applyInstanceLifecycle(store, operatorCaller, renewRequest(created.instance.id, `renew-${index}`, 3600), at(100 + index));
  }
  store.read((state) => {
    const receipts = state.instanceLifecycleReceipts ?? [];
    assert.equal(receipts.length, budget);
    assert.ok(receipts.length <= instanceAuditLimits.retainedReceiptsPerInstance, `receipts grew to ${receipts.length}`);
    assert.equal(receipts.filter((receipt) => receipt.operation === "create").length, 1);
    // Every accepted key is still answerable, the oldest renewal included.
    assert.ok(receipts.some((receipt) => receipt.idempotencyKey === "renew-0"));
  });
  // A new key beyond the budget is refused with a bounded error rather than displacing an older one.
  await assert.rejects(
    applyInstanceLifecycle(store, operatorCaller, renewRequest(created.instance.id, "renew-over-budget", 3600), at(500)),
    (error: unknown) => error instanceof CoordinationError && error.code === "conflict" && /receipt idempotency budget/.test(error.message)
  );
  store.read((state) => {
    assert.equal(state.instanceLifecycleReceipts?.length, budget);
    assert.equal(state.instanceLifecycleReceipts?.some((receipt) => receipt.idempotencyKey === "renew-over-budget"), false);
  });

  // The oldest renewal's key still replays exactly instead of running as a new operation, and the
  // same key with a different digest still conflicts.
  const beforeReplay = store.read((state) => structuredClone(state.instances![0].lease));
  const replayedRenewal = await applyInstanceLifecycle(store, operatorCaller, renewRequest(created.instance.id, "renew-0", 3600), at(600));
  assert.equal(replayedRenewal.replayed, true);
  store.read((state) => assert.deepEqual(state.instances![0].lease, beforeReplay, "a replay never extends the lease a second time"));
  await assert.rejects(
    applyInstanceLifecycle(store, operatorCaller, renewRequest(created.instance.id, "renew-0", 900), at(601)),
    /idempotency key was already used/
  );
  // A create replay still answers, and release keeps its reserved headroom even at the budget.
  const replay = await applyInstanceLifecycle(store, operatorCaller, createRequest(), at(1000));
  assert.equal(replay.replayed, true);
  assert.equal(replay.instance.id, created.instance.id);
  // Nothing is resident, so the drain settles the instance directly; the point is that the request
  // was accepted at the budget rather than refused.
  const released = await applyInstanceLifecycle(store, operatorCaller, releaseRequest(created.instance.id, "release-at-budget", "drain"), at(1001));
  assert.equal(released.instance.status, "released");
  store.read((state) => assert.ok((state.instanceLifecycleReceipts?.length ?? 0) <= instanceAuditLimits.retainedReceiptsPerInstance));
});

test("pruning never drops a retained instance's renew or release receipt", async () => {
  /*
   * A snapshot already holding more receipts for one live instance than the per-instance bound — a
   * state an earlier bound produced, and the one it then pruned. Pruning must leave every receipt of a
   * retained instance alone: dropping one turns an exact replay into a second executed operation.
   */
  const store = await hubStore((state) => { seedThread(state); });
  const created = await applyInstanceLifecycle(store, operatorCaller, createRequest(), at(1));
  // A real renewal supplies the digest a renewal of this instance normalizes to, so the seeded
  // receipts are the ones the service itself would have written.
  await applyInstanceLifecycle(store, operatorCaller, renewRequest(created.instance.id, "renew-real"), at(50));
  const renewDigest = store.read((state) => state.instanceLifecycleReceipts!.find((receipt) => receipt.operation === "renew")!.digest);
  const overBound = instanceAuditLimits.retainedReceiptsPerInstance + 5;
  await store.transact((state) => {
    for (let index = 0; index < overBound; index += 1) {
      state.instanceLifecycleReceipts!.push({
        id: `instreceipt-seeded-${index}`, threadId: "thread-one", sourceKey: "operator:operator",
        idempotencyKey: `seeded-renew-${index}`, operation: "renew",
        digest: renewDigest, instanceId: created.instance.id, createdAt: at(100 + index)
      });
    }
    return true;
  });
  const lease = store.read((state) => structuredClone(state.instances![0].lease));
  await maintainInstanceLifecycle(store, at(300));
  store.read((state) => {
    assert.equal(state.instanceLifecycleReceipts?.length, overBound + 2);
    assert.ok(state.instanceLifecycleReceipts!.some((receipt) => receipt.idempotencyKey === "seeded-renew-0"));
  });
  // The oldest seeded key still answers as a replay instead of extending the lease a second time.
  const replayed = await applyInstanceLifecycle(store, operatorCaller, {
    operation: "renew", threadId: "thread-one", instanceId: created.instance.id,
    idempotency: { caller: operatorCaller, key: "seeded-renew-0" }
  }, at(400));
  assert.equal(replayed.replayed, true);
  store.read((state) => assert.deepEqual(state.instances![0].lease, lease));
  // A receipt whose instance the hub has stopped retaining is what pruning does retire.
  await store.transact((state) => { state.instances = []; return true; });
  await maintainInstanceLifecycle(store, at(500));
  store.read((state) => assert.deepEqual(state.instanceLifecycleReceipts, []));
});

test("a reconnect never resends a drain its cancel escalation superseded", async () => {
  // Finding 4: drain then cancel are a monotonic escalation. Once both have been written to the
  // socket, a reconnect that still reports the resident must re-arm only the cancel; resending the
  // drain would leave the peer holding the weaker, superseded mode.
  const store = await hubStore((state) => { seedThread(state); seedNode(state); });
  const { created, reservation } = await provisionInstance(store);
  await receiveInstanceLifecycleReport(store, "node-one", readyReport(created.instance.id, reservation.allocation.id), at(3));
  await applyInstanceLifecycle(store, operatorCaller, releaseRequest(created.instance.id, "release-drain", "drain"), at(4));
  const first: Array<string | undefined> = [];
  await flushPendingInstanceDeliveries(store, (_nodeId, message) => {
    first.push(message.type === "instance.release" ? message.mode : message.type);
    return true;
  });
  assert.deepEqual(first, ["drain"]);
  await applyInstanceLifecycle(store, operatorCaller, releaseRequest(created.instance.id, "release-cancel", "cancel"), at(5));
  const escalated: Array<string | undefined> = [];
  await flushPendingInstanceDeliveries(store, (_nodeId, message) => {
    escalated.push(message.type === "instance.release" ? message.mode : message.type);
    return true;
  });
  assert.deepEqual(escalated, ["cancel"]);
  store.read((state) => {
    const releases = state.instanceDeliveries!.filter((record) => record.kind === "release");
    assert.equal(releases.length, 1, "the superseded drain is retired, not kept beside its escalation");
    assert.equal(releases[0].message.type === "instance.release" && releases[0].message.mode, "cancel");
  });

  // Both commands have been written; the node reconnects still reporting the resident.
  await store.transact((state) => { reconcileNodeInstancesInState(state, "node-one", [created.instance.id], at(6)); return true; });
  const replayed: Array<string | undefined> = [];
  await flushPendingInstanceDeliveries(store, (_nodeId, message) => {
    replayed.push(message.type === "instance.release" ? message.mode : message.type);
    return true;
  });
  assert.deepEqual(replayed, ["cancel"], "only the strongest persisted mode replays");
  store.read((state) => assert.equal(state.instanceDeliveries!.filter((record) => record.kind === "release").length, 1));
});

test("a superseded release command is never sent even while both records are persisted", async () => {
  // The ordering rule holds on the record set itself, not only on what pruning happens to have
  // retired: a delivered drain beside a later cancel is ineligible however it re-enters the outbox.
  const store = await hubStore((state) => { seedThread(state); seedNode(state); });
  const { created, reservation } = await provisionInstance(store);
  await receiveInstanceLifecycleReport(store, "node-one", readyReport(created.instance.id, reservation.allocation.id), at(3));
  await applyInstanceLifecycle(store, operatorCaller, releaseRequest(created.instance.id, "release-drain", "drain"), at(4));
  await flushPendingInstanceDeliveries(store, () => true);
  await applyInstanceLifecycle(store, operatorCaller, releaseRequest(created.instance.id, "release-cancel", "cancel"), at(5));
  // Re-arm the superseded drain by hand, as a reconnect once did, and prove it still cannot be sent.
  await store.transact((state) => {
    const cancel = state.instanceDeliveries!.find((record) => record.kind === "release")!;
    state.instanceDeliveries!.push({
      allocationId: cancel.allocationId,
      kind: "release",
      nodeId: cancel.nodeId,
      message: { type: "instance.release", instanceId: created.instance.id, allocationId: cancel.allocationId, mode: "drain" },
      createdAt: at(6),
      sequence: cancel.sequence - 1
    });
    return true;
  });
  const sent: Array<string | undefined> = [];
  await flushPendingInstanceDeliveries(store, (_nodeId, message) => {
    sent.push(message.type === "instance.release" ? message.mode : message.type);
    return true;
  });
  assert.deepEqual(sent, ["cancel"]);
  await maintainInstanceLifecycle(store, at(7));
  store.read((state) => assert.equal(state.instanceDeliveries!.filter((record) => record.kind === "release").length, 1));
});

test("store load rejects persisted records whose identifiers exist but do not belong together", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-instances-"));
  const path = join(directory, "state.json");
  const store = new Store(path);
  await store.load();
  await store.transact((state) => { seedThread(state); seedThread(state, "thread-two"); seedNode(state); });
  const created = await applyInstanceLifecycle(store, operatorCaller, createRequest(), at(1));
  const reservation = await reserveInstanceAllocation(store, created.instance.id, candidate("/work/one"), at(2));
  assert.equal(reservation.kind, "reserved");
  await applyInstanceLifecycle(store, operatorCaller, releaseRequest(created.instance.id, "release-one", "drain"), at(3));
  // The hub's own persisted bytes are the fixture; Store.save wrote them (store.ts save, JSON branch).
  const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  assert.ok((persisted.instanceLifecycleReceipts as unknown[]).length >= 1);
  assert.ok((persisted.instanceDeliveries as unknown[]).length >= 1);
  assert.ok((persisted.instanceReleaseIntents as unknown[]).length >= 1);

  const rejects = async (mutate: (state: Record<string, unknown>) => void, pattern: RegExp) => {
    const copy = JSON.parse(JSON.stringify(persisted)) as Record<string, unknown>;
    mutate(copy);
    await writeFile(path, JSON.stringify(copy));
    const reloaded = new Store(path);
    await assert.rejects(reloaded.load(), pattern);
  };
  // Both thread-two and the instance exist; the instance simply is not in that thread.
  await rejects((state) => { (state.instanceLifecycleReceipts as Array<Record<string, unknown>>)[0].threadId = "thread-two"; }, /receipt 0 names instance .* from another thread/);
  await rejects((state) => { (state.instanceReleaseIntents as Array<Record<string, unknown>>)[0].threadId = "thread-two"; }, /intent 0 names instance .* from another thread/);
  await rejects((state) => { (state.instanceDeliveries as Array<Record<string, unknown>>)[0].allocationId = "allocation-elsewhere"; }, /names unknown allocation/);
  await rejects((state) => { (state.instanceDeliveries as Array<Record<string, unknown>>)[0].nodeId = "node-two"; }, /does not hold allocation/);
  await rejects((state) => { delete (state.instanceDeliveries as Array<Record<string, unknown>>)[0].sequence; }, /Persisted instance delivery 0 is malformed/);
  // Two release commands sharing a position would make one allocation's escalation order ambiguous.
  // The wording is the only thing that changed here: the check now spans kinds, so its message names
  // the command sequence rather than the release sequence, and the same state is still rejected.
  await rejects((state) => {
    const deliveries = state.instanceDeliveries as Array<Record<string, unknown>>;
    const release = deliveries.find((record) => record.kind === "release")!;
    deliveries.push(structuredClone(release));
  }, /repeats command sequence/);
  await rejects((state) => {
    const instances = state.instances as Array<Record<string, unknown>>;
    instances.push({ ...structuredClone(instances[0]), id: "instance-elsewhere", status: "requested" });
    // The release command names a real instance and a real allocation that belong to each other.
    const release = (state.instanceDeliveries as Array<Record<string, unknown>>).find((record) => record.kind === "release")!;
    (release.message as Record<string, unknown>).instanceId = "instance-elsewhere";
  }, /does not own allocation/);
});

test("a foreign instance stays hidden whether or not it has spent its receipt budget", async () => {
  /*
   * Thread isolation is an ordering property: nothing whose result a caller can observe may be
   * decided before the caller's authority over the named resource is established. The receipt budget
   * is a property of the instance, so checking it before the instance is known to belong to the
   * requested thread answers for a foreign instance — one at its budget conflicts while one below it
   * stays behind the not-found answer, which tells the caller both that it exists and how much of its
   * budget it has spent.
   */
  const store = await hubStore((state) => { seedThread(state); seedThread(state, "thread-two"); seedNode(state); });
  const { created } = await provisionInstance(store);
  const renewBudget = instanceAuditLimits.retainedReceiptsPerInstance - instanceAuditLimits.releaseReceiptHeadroom;
  for (let index = 0; index < renewBudget - 1; index += 1) {
    await applyInstanceLifecycle(store, operatorCaller, renewRequest(created.instance.id, `renew-${index}`, 3600), at(100 + index));
  }
  const hidden = (error: unknown) => error instanceof CoordinationError && error.code === "not_found" && /Instance not found/.test(error.message);
  const overBudget = (error: unknown) => error instanceof CoordinationError && error.code === "conflict" && /receipt idempotency budget/.test(error.message);

  await assert.rejects(applyInstanceLifecycle(store, operatorCaller, {
    ...renewRequest(created.instance.id, "probe-renew", 3600), threadId: "thread-two"
  }, at(500)), hidden);
  // The renewal budget is genuinely spent, so the owning thread does get the budget refusal.
  await assert.rejects(applyInstanceLifecycle(store, operatorCaller, renewRequest(created.instance.id, "owning-renew", 3600), at(501)), overBudget);

  // Release keeps reserved headroom, so spend that too and repeat the probe for the release path.
  await applyInstanceLifecycle(store, operatorCaller, releaseRequest(created.instance.id, "release-drain", "drain"), at(600));
  await applyInstanceLifecycle(store, operatorCaller, releaseRequest(created.instance.id, "release-cancel", "cancel"), at(601));
  store.read((state) => {
    assert.equal(state.instanceLifecycleReceipts?.length, instanceAuditLimits.retainedReceiptsPerInstance);
    assert.equal(state.instances?.find((instance) => instance.id === created.instance.id)?.status, "draining");
  });
  await assert.rejects(applyInstanceLifecycle(store, operatorCaller, {
    ...releaseRequest(created.instance.id, "probe-release", "cancel"), threadId: "thread-two"
  }, at(602)), hidden);
  await assert.rejects(applyInstanceLifecycle(store, operatorCaller, releaseRequest(created.instance.id, "owning-release", "cancel"), at(603)), overBudget);

  // No probe left a receipt, an event, or any other trace on the thread it named.
  store.read((state) => {
    assert.equal(state.instanceLifecycleReceipts?.some((receipt) => receipt.threadId === "thread-two"), false);
    assert.equal(state.instanceLifecycleReceipts?.some((receipt) => receipt.idempotencyKey.startsWith("probe-")), false);
    assert.equal(state.events.some((event) => event.threadId === "thread-two"), false);
  });
});

test("store load rejects a provision and a release at the same command position", async () => {
  /*
   * A sequence is a position in one allocation's command order across every kind of command: the
   * delivery pass finds a record by allocation and sequence without consulting kind, and the release
   * order decides which mode the peer ends up holding. A provision and a release sharing a position
   * therefore make both ambiguous, and no hub writer produces it — `nextDeliverySequence` already
   * counts every kind — so a snapshot carrying it is malformed and must be refused rather than loaded
   * into a state whose causal order depends on array order.
   */
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-instances-"));
  const path = join(directory, "state.json");
  const store = new Store(path);
  await store.load();
  await store.transact((state) => { seedThread(state); seedNode(state); });
  const created = await applyInstanceLifecycle(store, operatorCaller, createRequest(), at(1));
  assert.equal((await reserveInstanceAllocation(store, created.instance.id, candidate("/work/one"), at(2))).kind, "reserved");
  await applyInstanceLifecycle(store, operatorCaller, releaseRequest(created.instance.id, "release-one", "drain"), at(3));
  const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const deliveries = persisted.instanceDeliveries as Array<Record<string, unknown>>;
  const provision = deliveries.find((record) => record.kind === "provision")!;
  const release = deliveries.find((record) => record.kind === "release")!;
  assert.equal(release.allocationId, provision.allocationId, "both commands belong to the same allocation");
  assert.notEqual(release.sequence, provision.sequence, "the hub's own writer never reuses a position");
  release.sequence = provision.sequence;
  await writeFile(path, JSON.stringify(persisted));
  const reloaded = new Store(path);
  await assert.rejects(reloaded.load(), /repeats command sequence/);
});

test("every occupancy transition leaves the residency record and the derived usage agreeing", async () => {
  /*
   * The sweep behind findings 1 and 2: each transition that changes whether an identity occupies a
   * slot, walked in order, with the capacity derivation checked after every one. A transition the
   * residency model does not cover shows up here as a usage the allocations contradict.
   */
  const store = await hubStore((state) => { seedThread(state); seedNode(state, { instanceCapacity: 2, activeInstances: 0 }); });
  const usage = () => store.read((state) => residentInstanceUsageInState(state, state.nodes[0]));
  const snapshot = async (residents: string[], observedAt: string) => {
    await store.transact((state) => { reconcileNodeInstancesInState(state, "node-one", residents, observedAt); return true; });
  };

  const created = await applyInstanceLifecycle(store, operatorCaller, createRequest(), at(1));
  assert.deepEqual(usage(), { capacity: 2, used: 0 }, "a requested instance holds nothing");
  const reservation = await reserveInstanceAllocation(store, created.instance.id, candidate("/work/one"), at(2));
  assert.equal(reservation.kind, "reserved");
  assert.deepEqual(usage(), { capacity: 2, used: 1 }, "a reservation occupies before the node has heard of it");
  await flushPendingInstanceDeliveries(store, () => true);
  assert.deepEqual(usage(), { capacity: 2, used: 1 }, "a delivered provision still occupies exactly one slot");
  await snapshot([created.instance.id], at(3));
  assert.deepEqual(usage(), { capacity: 2, used: 1 }, "a report of an identity the hub owns is counted once, not twice");
  assert.equal((await receiveInstanceLifecycleReport(store, "node-one", readyReport(created.instance.id, reservation.allocation.id), at(4))).kind, "accepted");
  assert.deepEqual(usage(), { capacity: 2, used: 1 }, "an active allocation occupies");

  // Allocation loss: the same snapshot that declares it missing also rewrites the record.
  await snapshot([], at(5));
  store.read((state) => {
    assert.equal(state.allocations?.find((allocation) => allocation.id === reservation.allocation.id)?.status, "lost");
    assert.equal(state.instances?.find((instance) => instance.id === created.instance.id)?.status, "requested");
    assert.deepEqual(nodeResidencyInState(state, "node-one")?.instanceIds, []);
  });
  assert.deepEqual(usage(), { capacity: 2, used: 0 }, "a lost allocation frees its slot and is not named by the record");

  const replacement = await reserveInstanceAllocation(store, created.instance.id, candidate("/work/two"), at(6));
  assert.equal(replacement.kind, "reserved");
  await flushPendingInstanceDeliveries(store, () => true);
  assert.deepEqual(usage(), { capacity: 2, used: 1 }, "a replacement occupies one slot, never two");
  // The node reports the replacement, so the record names it for the rest of the walk: every step
  // below has to stay correct against a record the node has no reason to send again.
  await snapshot([created.instance.id], at(7));
  assert.deepEqual(usage(), { capacity: 2, used: 1 }, "a reported replacement is still one slot");

  // Idle expiry and drain are intents, not evictions: the instance stays resident until Barista says
  // otherwise, so the slot must stay occupied.
  await store.transact((state) => {
    const instance = state.instances!.find((item) => item.id === created.instance.id)!;
    instance.lease = { idleTimeoutSeconds: 60, expiresAt: at(8) };
    return true;
  });
  await maintainInstanceLifecycle(store, at(9));
  store.read((state) => assert.equal(state.instances?.find((instance) => instance.id === created.instance.id)?.status, "draining"));
  assert.deepEqual(usage(), { capacity: 2, used: 1 }, "a draining instance still occupies its slot");

  // Terminal settlement is lifecycle authority; the node's next report is what frees the slot.
  assert.equal((await receiveInstanceLifecycleReport(store, "node-one", releasedReport(created.instance.id, replacement.allocation.id), at(10))).kind, "accepted");
  store.read((state) => {
    assert.equal(state.instances?.find((instance) => instance.id === created.instance.id)?.status, "released");
    assert.ok((state.allocations ?? []).every((allocation) => !occupyingAllocationStatuses.includes(allocation.status)));
    assert.deepEqual(nodeResidencyInState(state, "node-one")?.instanceIds, [created.instance.id], "the record still names it: it is the node's report");
  });
  assert.deepEqual(usage(), { capacity: 2, used: 1 }, "an acknowledged release does not overrule the node's latest report");
  await heartbeat(store, [], at(11));
  assert.deepEqual(usage(), { capacity: 2, used: 0 }, "the node's next report frees the slot");
});

/*
 * The class-closure suite. Each test names the review round whose rule is gone and asserts the form
 * of the defect that rule was chasing cannot recur, now that the node reports its resident identities
 * on every heartbeat (#114) and the hub derives nothing.
 */

test("class closure: disjoint reported and owned residency never overbooks (rev-b2c736)", async () => {
  /*
   * `max(reported, persisted)` read one resident here and left a free slot that did not exist. The
   * union by identity is what capacity is, and it is now read from a set the node refreshes every
   * beat rather than from a count that could not be reconciled with identities at all.
   */
  const store = await hubStore((state) => { seedThread(state); seedNode(state, { instanceCapacity: 2, activeInstances: 1 }); });
  const { created } = await provisionInstance(store);
  await heartbeat(store, [created.instance.id, "foreign-instance"], at(3));
  store.read((state) => assert.deepEqual(residentInstanceUsageInState(state, state.nodes[0]), { capacity: 2, used: 2 },
    "one owned and one foreign resident fill a capacity-2 node"));
  const other = await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", {
    idempotency: { caller: operatorCaller, key: "create-two" }
  }), at(4));
  assert.equal((await reserveInstanceAllocation(store, other.instance.id, candidate("/work/two"), at(5))).kind, "capacity");
  // The foreign resident is asked to release, and the node's own next beat is what frees the slot.
  store.read((state) => assert.deepEqual(state.remoteReleaseRequests?.map((request) => request.instanceId), ["foreign-instance"]));
  await heartbeat(store, [created.instance.id], at(6));
  store.read((state) => assert.deepEqual(state.remoteReleaseRequests, [], "a request the node's report no longer supports is retired"));
  assert.equal((await reserveInstanceAllocation(store, other.instance.id, candidate("/work/two"), at(7))).kind, "reserved");
});

test("class closure: a cleanup-failure report frees no slot and the next heartbeat still names the resident (rev-acf810, rev-f4707a)", async () => {
  /*
   * Discounting every settled status, and later `released` plus `failed`, both freed a slot Barista
   * still held: on a release-cleanup failure Barista *retains* the resident and only then reports
   * `instance.failed`. The hub no longer reads allocation status against residency at all, so the
   * producer's own next beat is both the assertion and the authority.
   */
  const store = await hubStore((state) => { seedThread(state); seedNode(state, { instanceCapacity: 1 }); });
  const { created, reservation } = await provisionInstance(store);
  await heartbeat(store, [created.instance.id], at(3));
  assert.equal((await receiveInstanceLifecycleReport(store, "node-one", readyReport(created.instance.id, reservation.allocation.id), at(4))).kind, "accepted");
  await applyInstanceLifecycle(store, operatorCaller, releaseRequest(created.instance.id, "release-one", "drain"), at(5));
  await flushPendingInstanceDeliveries(store, () => true);
  const failure = await receiveInstanceLifecycleReport(store, "node-one", failedReport(created.instance.id, reservation.allocation.id, "node-one", "cleanup failed"), at(6));
  assert.equal(failure.kind, "accepted", JSON.stringify(failure));
  store.read((state) => {
    assert.equal(state.allocations?.find((allocation) => allocation.id === reservation.allocation.id)?.status, "failed");
    assert.deepEqual(residentInstanceUsageInState(state, state.nodes[0]), { capacity: 1, used: 1 },
      "a failure is evidence the allocation is dead and none at all that the slot is free");
  });
  await heartbeat(store, [created.instance.id], at(7));
  store.read((state) => assert.deepEqual(residentInstanceUsageInState(state, state.nodes[0]), { capacity: 1, used: 1 },
    "the node itself confirms it still hosts the resident"));
  const replacement = await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", {
    idempotency: { caller: operatorCaller, key: "create-two" }
  }), at(8));
  assert.equal((await reserveInstanceAllocation(store, replacement.instance.id, candidate("/work/two"), at(9))).kind, "capacity");
});

test("class closure: a released resident's slot is freed by the next heartbeat with no reconnect (rev-af8920)", async () => {
  /*
   * Pinning residency-named identities against pruning existed to preserve the `released` discount,
   * because the record refreshed only on attachment and the discount was the only thing that could
   * free the slot before the next one. A beat now carries the node's current resident set, so the
   * slot frees itself and no local evidence has to be preserved to make that happen.
   */
  const store = await hubStore((state) => { seedThread(state); seedNode(state, { instanceCapacity: 1 }); });
  const { created, reservation } = await provisionInstance(store);
  await heartbeat(store, [created.instance.id], at(3));
  assert.equal((await receiveInstanceLifecycleReport(store, "node-one", readyReport(created.instance.id, reservation.allocation.id), at(4))).kind, "accepted");
  await applyInstanceLifecycle(store, operatorCaller, releaseRequest(created.instance.id, "release-one", "drain"), at(5));
  assert.equal((await receiveInstanceLifecycleReport(store, "node-one", releasedReport(created.instance.id, reservation.allocation.id), at(6))).kind, "accepted");
  const replacement = await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", {
    idempotency: { caller: operatorCaller, key: "create-two" }
  }), at(7));
  // Staleness is bounded by one beat, not by the next reconnect, and the safe direction is to defer.
  store.read((state) => assert.deepEqual(residentInstanceUsageInState(state, state.nodes[0]), { capacity: 1, used: 1 }));
  await heartbeat(store, [], at(8));
  store.read((state) => {
    assert.deepEqual(nodeResidencyInState(state, "node-one")?.instanceIds, [], "an explicitly empty beat is an authoritative zero");
    assert.deepEqual(residentInstanceUsageInState(state, state.nodes[0]), { capacity: 1, used: 0 });
  });
  const reserved = await reserveInstanceAllocation(store, replacement.instance.id, candidate("/work/two"), at(9));
  assert.equal(reserved.kind, "reserved", `no reconnect was needed: ${JSON.stringify(reserved)}`);
});

test("class closure: a release retry after a cleanup failure frees the slot within one heartbeat (rev-aa9db2)", async () => {
  /*
   * Round 7's `high`. Vacancy statements accepted a lifecycle-rejected `instance.released` as evidence,
   * and the tombstone that kept a replay of it from freeing a slot twice also suppressed the next
   * genuine one for good. There is no statement and no tombstone now: the retry's acknowledgement is
   * refused as lifecycle and carries no residency weight either way, and the node's report decides.
   */
  const store = await hubStore((state) => { seedThread(state); seedNode(state, { instanceCapacity: 1 }); });
  const { created, reservation } = await provisionInstance(store);
  await heartbeat(store, [created.instance.id], at(3));
  assert.equal((await receiveInstanceLifecycleReport(store, "node-one", readyReport(created.instance.id, reservation.allocation.id), at(4))).kind, "accepted");
  await applyInstanceLifecycle(store, operatorCaller, releaseRequest(created.instance.id, "release-one", "drain"), at(5));
  await flushPendingInstanceDeliveries(store, () => true);
  assert.equal((await receiveInstanceLifecycleReport(store, "node-one", failedReport(created.instance.id, reservation.allocation.id, "node-one", "cleanup failed"), at(6))).kind, "accepted");

  // The hub asks the node to evict the resident its failed cleanup retained.
  await heartbeat(store, [created.instance.id], at(7));
  const sent: string[] = [];
  await flushPendingInstanceDeliveries(store, (_nodeId, message) => { sent.push(message.type); return true; });
  assert.deepEqual(sent, ["instance.release"], "the retained resident is addressed through the remote release outbox");

  // The retry succeeds on the node. Its acknowledgement is not a legal transition and never will be.
  const retry = await receiveInstanceLifecycleReport(store, "node-one", releasedReport(created.instance.id, reservation.allocation.id), at(8));
  assert.equal(retry.kind, "rejected", JSON.stringify(retry));
  assert.match(retry.reason ?? "", /legal transition/);
  assert.equal(retry.changed, false, "a refused acknowledgement writes nothing at all");
  store.read((state) => {
    assert.equal(state.allocations?.find((allocation) => allocation.id === reservation.allocation.id)?.status, "failed");
    assert.equal(state.instances?.find((instance) => instance.id === created.instance.id)?.status, "failed");
    assert.deepEqual(nodeResidencyInState(state, "node-one")?.instanceIds, [created.instance.id],
      "the record is the node's own report and the hub never edits it");
    assert.equal("nodeResidencyVacancies" in state, false, "there is no statement record to tombstone");
  });

  // A beat that raced the retry still names the resident, and that must not become permanent.
  await heartbeat(store, [created.instance.id], at(9));
  store.read((state) => assert.deepEqual(residentInstanceUsageInState(state, state.nodes[0]), { capacity: 1, used: 1 }));
  await heartbeat(store, [], at(10));
  store.read((state) => {
    assert.deepEqual(state.remoteReleaseRequests, [], "the eviction request is retired with the resident it named");
    assert.deepEqual(residentInstanceUsageInState(state, state.nodes[0]), { capacity: 1, used: 0 });
  });
  const replacement = await applyInstanceLifecycle(store, operatorCaller, createRequest("thread-one", {
    idempotency: { caller: operatorCaller, key: "create-two" }
  }), at(11));
  const reserved = await reserveInstanceAllocation(store, replacement.instance.id, candidate("/work/two"), at(12));
  assert.equal(reserved.kind, "reserved", `nothing may suppress the node's own word: ${JSON.stringify(reserved)}`);
});

test("class closure: absent, explicitly empty, and malformed heartbeat residency stay three outcomes", () => {
  /*
   * Collapsing malformed into absent is the failure this tri-state exists to prevent: an unreadable
   * claim would become "the node claimed nothing", which infers zero unowned residency by omission.
   * The heartbeat field is read by the same classifier, the same protocol validator, and the same
   * `instanceLimits.collectionEntries` bound as the reconnect barrier's, and the carrier is named so
   * one frame can never be read as the other.
   */
  assert.deepEqual(classifyInstanceResidentEvidence(controlFixture("heartbeat"), "5", "heartbeat"),
    { kind: "authoritative", residents: ["instance-one"] });
  assert.deepEqual(classifyInstanceResidentEvidence(controlFixture("heartbeat-empty"), "5", "heartbeat"),
    { kind: "authoritative", residents: [] }, "an explicit empty set is a claim, not an omission");
  const omitted = controlFixture("heartbeat");
  delete omitted.activeInstanceIds;
  assert.deepEqual(classifyInstanceResidentEvidence(omitted, "5", "heartbeat"), { kind: "absent" });
  for (const residents of [null, ["same", "same"], [""], ["bad/id"], Array.from({ length: instanceLimits.collectionEntries + 1 }, (_, index) => `i-${index}`)]) {
    const evidence = classifyInstanceResidentEvidence({ ...controlFixture("heartbeat"), activeInstanceIds: residents }, "5", "heartbeat");
    assert.equal(evidence.kind, "malformed", JSON.stringify(residents));
  }
  // Neither carrier is ever read as the other, and a node that cannot host instances claims nothing.
  assert.equal(classifyInstanceResidentEvidence(controlFixture("sync"), "5", "heartbeat").kind, "malformed");
  assert.equal(classifyInstanceResidentEvidence(controlFixture("heartbeat"), "5", "sync.complete").kind, "malformed");
  assert.deepEqual(classifyInstanceResidentEvidence(controlFixture("heartbeat"), "4", "heartbeat"), { kind: "absent" });
});
