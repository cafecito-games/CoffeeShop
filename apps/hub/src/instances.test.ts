import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  allocationStatuses,
  hasAuthoritativeInstanceEvidence,
  instanceStatuses,
  validateInstanceHubMessage,
  type AgentInstance,
  type ComputeNode,
  type InstanceLifecycleRequest
} from "@coffee-shop/protocol";
import {
  applyInstanceLifecycle,
  currentAllocationInState,
  flushPendingInstanceDeliveries,
  instanceAuditLimits,
  listThreadInstances,
  maintainInstanceLifecycle,
  nonTerminalInstanceStatuses,
  occupyingAllocationStatuses,
  receiveInstanceLifecycleReport,
  reconcileNodeInstancesInState,
  reserveInstanceAllocation,
  residentInstanceUsage,
  operatorInstanceCreator
} from "./instances.js";
import { Store, type State } from "./store.js";

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

test("resident usage is the maximum of reported and persisted nonterminal allocations", () => {
  const node = computeNode({ instanceCapacity: 4, activeInstances: 3 });
  const allocations = [
    { instanceId: "a", nodeId: "node-one", status: "reserved" },
    { instanceId: "b", nodeId: "node-one", status: "active" },
    { instanceId: "c", nodeId: "node-one", status: "lost" },
    { instanceId: "d", nodeId: "node-one", status: "released" },
    { instanceId: "e", nodeId: "node-two", status: "active" }
  ].map((entry) => entry as never);
  assert.deepEqual(residentInstanceUsage(node, allocations), { capacity: 4, used: 3 });
  // Absent reported usage is unknown, not zero: persisted intent still reserves.
  const unknown = computeNode({ instanceCapacity: 4 });
  delete (unknown as Partial<ComputeNode>).activeInstances;
  assert.deepEqual(residentInstanceUsage(unknown, allocations), { capacity: 4, used: 2 });
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
    assert.ok((state.instanceLifecycleReceipts?.length ?? 0) <= instanceAuditLimits.retainedReceipts);
    assert.ok(state.instanceReleaseIntents!.every((intent) => instanceIds.has(intent.instanceId)));
  });
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
});
