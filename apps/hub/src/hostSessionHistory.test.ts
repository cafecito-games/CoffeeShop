import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type {
  ComputeNode,
  HostHarnessSessionInventoryComplete,
  HostHarnessSessionInventoryPage,
  HostSessionControlMessage
} from "@coffee-shop/protocol";
import { receiveHostSessionHistory } from "./hostSessionHistory.js";
import { receiveHostSessionInventory } from "./hostSessionInventory.js";
import { Store } from "./store.js";

type HistoryPage = Extract<HostSessionControlMessage, { type: "host-session.history.page" }>;
const fixtureDirectory = fileURLToPath(new URL("../../../packages/protocol/test/fixtures/control-v6/", import.meta.url));
const node: ComputeNode = {
  id: "node-one", name: "Node", kind: "local", platform: "linux-amd64", status: "online",
  lastSeen: "2026-09-30T12:00:00Z", activeRuns: 0, concurrency: 1,
  workspaceRoots: ["/workspaces"], harnesses: [], version: "test"
};

async function loadFixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(fixtureDirectory, `${name}.json`), "utf8")) as T;
}

async function context() {
  const path = join(await mkdtemp(join(tmpdir(), "coffee-shop-host-history-")), "state.json");
  const store = new Store(path);
  await store.load();
  await store.transact((state) => { state.nodes.push(node); });
  const connection = {
    nodeId: node.id, connectionGeneration: 2, supportsCapability: true,
    barrierPassed: true, isCurrent: () => true
  };
  const page = await loadFixture<HostHarnessSessionInventoryPage>("inventory-page");
  const complete = await loadFixture<HostHarnessSessionInventoryComplete>("inventory-complete");
  await receiveHostSessionInventory(store, connection, page);
  await receiveHostSessionInventory(store, connection, complete);
  return { store, path, connection };
}

test("real protocol history fixture persists a provider-neutral bounded projection with exact replay", async () => {
  const { store, connection } = await context();
  const page = await loadFixture<HistoryPage>("history-page");
  let commits = 0;
  store.onCommit(() => { commits += 1; });

  assert.deepEqual(await receiveHostSessionHistory(store, connection, page), { kind: "accepted", changed: true });
  assert.equal(commits, 1);
  const stored = store.read((state) => state.hostSessionHistories?.[0]);
  assert.deepEqual(stored?.items, page.items);
  assert.equal(stored?.cursor, "cursor-two");
  assert.equal(stored?.truncated, true);
  assert.equal(stored?.omittedItems, 0);

  assert.deepEqual(await receiveHostSessionHistory(store, connection, page), { kind: "replayed", changed: false });
  assert.equal(commits, 1);
  const changedReplay = structuredClone(page);
  changedReplay.items[0]!.text = "changed";
  assert.equal((await receiveHostSessionHistory(store, connection, changedReplay)).kind, "rejected");
  assert.deepEqual(store.read((state) => state.hostSessionHistories?.[0]?.items), page.items);
  assert.equal(commits, 1);
});

test("history rejects wrong session/node/socket and stale cursor without touching Run authority", async () => {
  const { store, connection } = await context();
  const page = await loadFixture<HistoryPage>("history-page");
  assert.equal((await receiveHostSessionHistory(store, connection, { ...page, hostHarnessSessionId: "unknown" })).kind, "rejected");
  assert.equal((await receiveHostSessionHistory(store, { ...connection, nodeId: "other" }, page)).kind, "rejected");
  assert.equal((await receiveHostSessionHistory(store, { ...connection, isCurrent: () => false }, page)).kind, "ignored");
  assert.equal((await receiveHostSessionHistory(store, connection, page)).kind, "accepted");

  const stale: HistoryPage = {
    ...page,
    requestId: "request-history-two",
    items: [{ ...page.items[0]!, id: "history-two", text: "Next" }],
    at: "2026-09-30T12:02:00Z"
  };
  assert.equal((await receiveHostSessionHistory(store, connection, stale)).kind, "rejected", "a new page must advance its opaque cursor");
  const forward: HistoryPage = {
    ...stale,
    requestId: "request-history-three",
    nextCursor: "cursor-three",
    at: "2026-09-30T12:03:00Z"
  };
  assert.equal((await receiveHostSessionHistory(store, connection, forward)).kind, "accepted");
  const rewind: HistoryPage = {
    ...stale,
    requestId: "request-history-four",
    items: [{ ...page.items[0]!, id: "history-four", text: "Rewound" }],
    nextCursor: "cursor-two",
    at: "2026-09-30T12:04:00Z"
  };
  assert.equal((await receiveHostSessionHistory(store, connection, rewind)).kind, "rejected",
    "a provider cursor may never rewind to any previously accepted cursor");
  assert.equal(store.read((state) => state.hostSessionHistories?.[0]?.cursor), "cursor-three");
  assert.equal(store.read((state) => state.runs.length), 0);
  assert.equal(store.read((state) => state.runActivity?.length), 0);
  assert.equal(store.read((state) => state.approvals?.length), 0);
});

test("history retention is deterministic, explicit, and never leaks into snapshots", async () => {
  const { store, connection } = await context();
  const page = await loadFixture<HistoryPage>("history-page");
  const full: HistoryPage = {
    ...page,
    items: Array.from({ length: 100 }, (_, index) => ({
      id: `history-${index.toString().padStart(3, "0")}`,
      kind: index % 2 === 0 ? "user" as const : "assistant" as const,
      text: `Item ${index}`,
      truncated: false
    }))
  };
  assert.equal((await receiveHostSessionHistory(store, connection, full)).kind, "accepted");
  const next: HistoryPage = {
    ...page,
    requestId: "request-history-next",
    items: [{ id: "history-100", kind: "summary", text: "Newest", truncated: false }],
    nextCursor: "cursor-three",
    truncated: false,
    at: "2026-09-30T12:03:00Z"
  };
  assert.equal((await receiveHostSessionHistory(store, connection, next)).kind, "accepted");
  const history = store.read((state) => state.hostSessionHistories?.[0]);
  assert.equal(history?.items.length, 100);
  assert.equal(history?.items[0]?.id, "history-001");
  assert.equal(history?.items.at(-1)?.id, "history-100");
  assert.equal(history?.omittedItems, 1);
  assert.equal(history?.truncated, true);
  const snapshot = store.snapshot() as unknown as Record<string, unknown>;
  assert.equal("hostSessionHistories" in snapshot, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /Newest/);
});
