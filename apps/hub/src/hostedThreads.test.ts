import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { threadOrchestrator, type ComputeNode, type ControlProtocolVersion } from "@coffee-shop/protocol";
import { CoordinationError } from "./coordinationError.js";
import { createHostedThread } from "./hostedThreads.js";
import { flushPendingInstanceDeliveries, receiveInstanceLifecycleReport } from "./instances.js";
import { runContinuationPass } from "./orchestratorInbox.js";
import { Store, type State } from "./store.js";

const at = "2026-09-29T12:00:00.000Z";
const node = (overrides: Partial<ComputeNode> = {}): ComputeNode => ({
  id: "node-one",
  name: "Node One",
  kind: "local",
  platform: "linux · x64",
  status: "online",
  lastSeen: at,
  activeRuns: 0,
  concurrency: 2,
  instanceCapacity: 2,
  activeInstances: 0,
  workspaceRoots: ["/workspace"],
  harnesses: [{
    id: "claude-cli",
    label: "Claude Code",
    description: "Claude Code CLI",
    available: true,
    authMode: "local-subscription",
    models: ["sonnet"]
  }],
  version: "test",
  ...overrides
});

async function world(seed?: (state: State) => void) {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-hosted-thread-"));
  const path = join(directory, "state.json");
  const store = new Store(path);
  await store.load();
  await store.transact((state) => {
    state.nodes = [node()];
    seed?.(state);
  });
  const context = {
    connection: (nodeId: string) => nodeId === "node-one" ? { protocolVersion: "5" as ControlProtocolVersion, synced: true } : undefined,
    capabilityReport: () => undefined,
    projectProfile: () => undefined,
    canDeliver: () => false
  };
  return { store, path, context };
}

const request = (overrides: Record<string, unknown> = {}) => ({
  idempotencyKey: "hosted-one",
  title: "Ship billing export",
  objective: "Plan and deliver the billing export with independent implementation and review.",
  orchestrator: {
    purpose: { name: "Billing lead", instructions: "Coordinate carefully and report blockers." },
    requirements: { harnessIds: ["claude-cli"], models: ["sonnet"] },
    idleTimeoutSeconds: 3600
  },
  ...overrides
});

test("creates a thread, delegating resident, allocation, and first inbox instruction atomically", async () => {
  const { store, path, context } = await world();
  const created = await createHostedThread(store, "operator", request(), context, at);
  assert.equal(created.replayed, false);
  assert.deepEqual(threadOrchestrator(created.thread), { kind: "instance", instanceId: created.instance.id });
  assert.equal(created.instance.delegation.canDelegate, true);
  assert.equal(created.instance.purpose?.name, "Billing lead");
  assert.deepEqual(created.instance.requirements, { harnessIds: ["claude-cli"], models: ["sonnet"] });
  assert.equal(created.allocation.nodeId, "node-one");
  assert.equal(created.allocation.harnessId, "claude-cli");
  assert.equal(created.allocation.model, "sonnet");

  store.read((state) => {
    assert.equal(state.threads?.length, 1);
    assert.equal(state.instances?.length, 1);
    assert.equal(state.allocations?.length, 1);
    assert.equal(state.instanceDeliveries?.filter((delivery) => delivery.kind === "provision").length, 1);
    assert.equal(state.taskMessages?.[0]?.body, request().objective);
    assert.deepEqual(state.taskMessages?.[0]?.recipient, { type: "orchestrator" });
    assert.equal(state.hostedThreadCreationReceipts?.length, 1);
  });
  assert.equal("hostedThreadCreationReceipts" in store.snapshot(), false, "private receipts never reach the PWA");

  const readyAt = "2026-09-29T12:00:01.000Z";
  assert.equal(await flushPendingInstanceDeliveries(store, () => true), true);
  const ready = await receiveInstanceLifecycleReport(store, "node-one", {
    type: "instance.ready",
    nodeId: "node-one",
    instanceId: created.instance.id,
    allocationId: created.allocation.id,
    at: readyAt
  }, readyAt);
  assert.equal(ready.kind, "accepted", JSON.stringify({ ready, state: store.read((state) => ({
    instance: state.instances?.find((item) => item.id === created.instance.id),
    allocation: state.allocations?.find((item) => item.id === created.allocation.id)
  })) }));
  await store.transact((state) => {
    const pass = runContinuationPass(state, context, "2026-09-29T12:00:02.000Z");
    assert.equal(pass.continuations.length, 1, "the initial objective wakes the resident orchestrator once it is ready");
    assert.equal(pass.continuations[0].instanceId, created.instance.id);
    assert.equal(state.runs.find((run) => run.id === pass.continuations[0].runId)?.status, "queued");
    return pass.changed;
  });

  const restarted = new Store(path);
  await restarted.load();
  const replay = await createHostedThread(restarted, "operator", request(), context, at);
  assert.deepEqual([replay.replayed, replay.thread.id, replay.instance.id, replay.allocation.id],
    [true, created.thread.id, created.instance.id, created.allocation.id]);
  assert.deepEqual(restarted.read((state) => [state.threads?.length, state.instances?.length, state.allocations?.length]), [1, 1, 1]);
});

test("conflicting retries and unavailable placement leave no partial thread", async () => {
  const available = await world();
  await createHostedThread(available.store, "operator", request(), available.context, at);
  await assert.rejects(
    () => createHostedThread(available.store, "operator", request({ title: "Different intent" }), available.context, at),
    (error: unknown) => error instanceof CoordinationError && error.code === "idempotency_conflict"
  );
  assert.deepEqual(available.store.read((state) => [state.threads?.length, state.instances?.length]), [1, 1]);

  const unavailable = await world((state) => { state.nodes = [node({ instanceCapacity: 0 })]; });
  await assert.rejects(
    () => createHostedThread(unavailable.store, "operator", request(), unavailable.context, at),
    (error: unknown) => error instanceof CoordinationError && error.code === "unavailable"
  );
  unavailable.store.read((state) => {
    assert.deepEqual([state.threads, state.instances, state.allocations, state.taskMessages], [[], [], [], []]);
    assert.equal(state.hostedThreadCreationReceipts?.length, 0);
  });
});

test("refuses a worker-only template before granting orchestration authority", async () => {
  const { store, context } = await world((state) => {
    state.templates = [{ id: "template-worker", name: "Worker", delegation: { canDelegate: false } }];
  });
  const withTemplate = request({
    orchestrator: { requirements: { templateId: "template-worker" } }
  });
  await assert.rejects(
    () => createHostedThread(store, "operator", withTemplate, context, at),
    /worker-only/
  );
  assert.deepEqual(store.read((state) => [state.threads?.length, state.instances?.length]), [0, 0]);
});

test("load rejects a malformed private creation receipt without rewriting persisted bytes", async () => {
  const { store, path, context } = await world();
  await createHostedThread(store, "operator", request(), context, at);
  const persisted = JSON.parse(await readFile(path, "utf8")) as State;
  persisted.hostedThreadCreationReceipts![0].digest = "not-a-digest";
  const corrupted = `${JSON.stringify(persisted, null, 2)}\n`;
  await writeFile(path, corrupted);

  await assert.rejects(() => new Store(path).load(), /hosted thread receipt 0 is invalid/);
  assert.equal(await readFile(path, "utf8"), corrupted);
});
