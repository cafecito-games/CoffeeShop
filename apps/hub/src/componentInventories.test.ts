import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ComponentInventoryReport, ComputeNode } from "@coffee-shop/protocol";
import { applyComponentInventory, clearComponentInventory, receiveComponentInventory } from "./componentInventories.js";
import { Store } from "./store.js";

const node: ComputeNode = {
  id: "node-one", name: "Node", kind: "local", platform: "linux-amd64", status: "online",
  lastSeen: "2026-09-28T12:00:00Z", activeRuns: 0, concurrency: 1, workspaceRoots: ["/workspace"],
  harnesses: [], version: "test"
};

function report(observedAt = "2026-09-28T12:00:00Z"): ComponentInventoryReport {
  return { nodeId: node.id, observedAt, components: [{
    kind: "harness", id: "codex-cli", harnessId: "codex-cli", declaredVersion: "1.2.3",
    installedVersions: [], provenance: "external", readiness: "ready", rollbackAvailable: false, diagnosticCodes: []
  }] };
}

async function fixture() {
  const path = join(await mkdtemp(join(tmpdir(), "coffee-shop-components-")), "state.json");
  const store = new Store(path);
  await store.load();
  await store.transact((state) => { state.nodes.push(node); });
  return { store, path };
}

test("inventory replacement is transactional, monotonic, conflict-safe, and replay-idempotent", async () => {
  const { store } = await fixture();
  let commits = 0;
  store.onCommit(() => { commits += 1; });
  const apply = async (candidate: ComponentInventoryReport) => {
    let result!: ReturnType<typeof applyComponentInventory>;
    await store.transact((state) => { result = applyComponentInventory(state, candidate); return result.changed; });
    return result;
  };
  assert.equal((await apply(report())).kind, "accepted");
  assert.equal(commits, 1);
  assert.equal((await apply(report())).kind, "replayed");
  assert.equal((await apply(report("2026-09-28T14:00:00+02:00"))).kind, "replayed",
    "an equivalent timestamp offset normalizes to the accepted instant");
  assert.equal((await apply(report("2026-09-28T11:59:59Z"))).kind, "older");
  assert.equal(commits, 1, "replay and older evidence write nothing");
  const conflict = report();
  conflict.components[0]!.readiness = "unhealthy";
  assert.equal((await apply(conflict)).kind, "rejected");
  assert.equal(store.snapshot().componentInventories?.[0]?.components[0]?.readiness, "ready");
  assert.equal(commits, 1);
});

test("fresh registration clearing and offline retention are separate operations", async () => {
  const { store, path } = await fixture();
  await store.transact((state) => { assert.equal(applyComponentInventory(state, report()).changed, true); });
  await store.transact((state) => { state.nodes[0]!.status = "offline"; });
  assert.equal(store.snapshot().componentInventories?.length, 1, "disconnect retains last accepted evidence");
  const reopened = new Store(path);
  await reopened.load();
  assert.equal(reopened.snapshot().componentInventories?.length, 1, "accepted evidence persists across restart");
  await reopened.transact((state) => clearComponentInventory(state, node.id));
  assert.deepEqual(reopened.snapshot().componentInventories, []);
});

test("invalid or unknown-node inventory mutates nothing", async () => {
  const { store } = await fixture();
  await store.transact((state) => {
    assert.equal(applyComponentInventory(state, { ...report(), nodeId: "other-node" }).kind, "rejected");
    assert.equal(applyComponentInventory(state, { ...report(), components: [{ ...report().components[0]!, diagnosticCodes: ["raw-error" as never] }] }).kind, "rejected");
    return false;
  });
  assert.deepEqual(store.snapshot().componentInventories, []);
});

test("gateway accepts only the current capability-bearing matching connection", async () => {
  const { store } = await fixture();
  let commits = 0;
  store.onCommit(() => { commits += 1; });
  const connection = { supportsCapability: true, current: true, nodeId: node.id };
  for (const refused of [
    { ...connection, supportsCapability: false },
    { ...connection, current: false },
    { ...connection, nodeId: "" }
  ]) assert.equal((await receiveComponentInventory(store, refused, report())).kind, "ignored");
  assert.equal((await receiveComponentInventory(store, connection, { ...report(), nodeId: "other-node" })).kind, "rejected");
  assert.equal((await receiveComponentInventory(store, connection, { ...report(), extra: true })).kind, "rejected");
  assert.equal(commits, 0);
  assert.deepEqual(store.snapshot().componentInventories, []);

  assert.equal((await receiveComponentInventory(store, connection, report())).kind, "accepted");
  assert.equal(commits, 1);
  assert.equal((await receiveComponentInventory(store, connection, report())).kind, "replayed");
  assert.equal(commits, 1, "current-socket replay persists and broadcasts nothing");
});

test("store load defaults legacy absence and rejects malformed persisted inventories without rewriting", async () => {
  const { store, path } = await fixture();
  const current = store.snapshot() as unknown as Record<string, unknown>;
  delete current.generatedAt;
  delete current.componentInventories;
  await writeFile(path, JSON.stringify(current));
  const legacy = new Store(path);
  await legacy.load();
  assert.deepEqual(legacy.snapshot().componentInventories, []);

  const valid = legacy.snapshot() as unknown as Record<string, unknown>;
  delete valid.generatedAt;
  valid.componentInventories = [report()];
  const rejects = async (mutate: (state: Record<string, unknown>) => void, pattern: RegExp) => {
    const candidate = structuredClone(valid) as unknown as Record<string, unknown>;
    mutate(candidate);
    const bytes = JSON.stringify(candidate);
    await writeFile(path, bytes);
    await assert.rejects(new Store(path).load(), pattern);
    assert.equal(await readFile(path, "utf8"), bytes, "a refused state is never repaired or partially imported");
  };
  await rejects((state) => { state.componentInventories = null; }, /component inventory collection is malformed/);
  await rejects((state) => { state.componentInventories = [report(), report()]; }, /repeats node/);
  await rejects((state) => { state.componentInventories = [{ ...report(), nodeId: "unknown-node" }]; }, /unknown node/);
  await rejects((state) => {
    state.componentInventories = [{ ...report(), components: [{ ...report().components[0]!, componentPath: "/private/node/path" }] }];
  }, /only declared fields/);
});

test("reopening current SQLite component inventory performs no persistence write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-components-sqlite-"));
  const databasePath = join(directory, "coffee-shop.sqlite");
  const legacyJsonPath = join(directory, "absent.json");
  const first = new Store({ databasePath, legacyJsonPath });
  await first.load();
  await first.transact((state) => {
    state.nodes.push(node);
    assert.equal(applyComponentInventory(state, report()).changed, true);
  });
  const marker = "2000-01-01T00:00:00.000Z";
  const probe = new DatabaseSync(databasePath);
  const before = probe.prepare("SELECT state_json FROM hub_state WHERE singleton = 1").get() as { state_json: string };
  probe.prepare("UPDATE hub_state SET updated_at = ? WHERE singleton = 1").run(marker);
  probe.close();

  const reopened = new Store({ databasePath, legacyJsonPath });
  await reopened.load();
  assert.equal(reopened.snapshot().componentInventories?.[0]?.nodeId, node.id);
  const after = new DatabaseSync(databasePath);
  const row = after.prepare("SELECT state_json, updated_at FROM hub_state WHERE singleton = 1").get() as { state_json: string; updated_at: string };
  assert.equal(row.state_json, before.state_json);
  assert.equal(row.updated_at, marker);
  after.close();
});
