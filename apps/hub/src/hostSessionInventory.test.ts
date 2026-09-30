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
  HostHarnessSessionObservation
} from "@coffee-shop/protocol";
import {
  discardHostSessionConnectionBeforeRelease,
  hasReconciledHostSessionInventory,
  receiveHostSessionInventory
} from "./hostSessionInventory.js";
import { Store } from "./store.js";

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
  const path = join(await mkdtemp(join(tmpdir(), "coffee-shop-host-inventory-")), "state.json");
  const store = new Store(path);
  await store.load();
  await store.transact((state) => { state.nodes.push(node); });
  let current = true;
  const connection = {
    nodeId: node.id,
    connectionGeneration: 7,
    supportsCapability: true,
    barrierPassed: true,
    isCurrent: () => current
  };
  return { store, path, connection, supersede: () => { current = false; } };
}

function nextObservation(previous: HostHarnessSessionObservation, overrides: Partial<HostHarnessSessionObservation> = {}) {
  return {
    ...previous,
    status: "running" as const,
    revision: previous.revision + 1,
    updatedAt: "2026-09-30T12:01:00Z",
    ...overrides
  };
}

test("real protocol fixtures stage privately and commit one complete generation atomically", async () => {
  const { store, connection } = await context();
  const page = await loadFixture<HostHarnessSessionInventoryPage>("inventory-page");
  const complete = await loadFixture<HostHarnessSessionInventoryComplete>("inventory-complete");
  let commits = 0;
  store.onCommit(() => { commits += 1; });

  assert.deepEqual(await receiveHostSessionInventory(store, connection, page), { kind: "staged", changed: false });
  assert.deepEqual(store.snapshot().hostHarnessSessions, [], "incomplete evidence is never published");
  assert.equal(commits, 0);

  assert.deepEqual(await receiveHostSessionInventory(store, connection, complete), { kind: "accepted", changed: true });
  assert.equal(store.snapshot().hostHarnessSessions?.[0]?.hostHarnessSessionId, "host-session-one");
  assert.equal(store.snapshot().hostHarnessSessions?.[0]?.attachmentEpoch, 0);
  assert.equal(commits, 1);
  assert.equal(hasReconciledHostSessionInventory(store, connection), true);

  assert.deepEqual(await receiveHostSessionInventory(store, connection, { ...page, at: "2026-09-30T13:00:00+01:00" }), { kind: "staged", changed: false });
  assert.deepEqual(await receiveHostSessionInventory(store, connection, { ...complete, at: "2026-09-30T13:00:00+01:00" }), { kind: "replayed", changed: false });
  assert.equal(commits, 1, "an exact generation replay neither persists nor republishes");
});

test("generation ordering, replay conflicts, incomplete replacement, restart, and stale sockets fail closed", async () => {
  const { store, path, connection, supersede } = await context();
  const page = await loadFixture<HostHarnessSessionInventoryPage>("inventory-page");
  const complete = await loadFixture<HostHarnessSessionInventoryComplete>("inventory-complete");
  assert.equal((await receiveHostSessionInventory(store, connection, page)).kind, "staged");
  assert.equal((await receiveHostSessionInventory(store, connection, complete)).kind, "accepted");
  const before = store.snapshot().hostHarnessSessions;

  const generationFive = { ...page, generation: 5, pageIndex: 1 };
  assert.equal((await receiveHostSessionInventory(store, connection, generationFive)).kind, "rejected", "a generation starts at page zero");
  assert.deepEqual(store.snapshot().hostHarnessSessions, before);

  assert.equal((await receiveHostSessionInventory(store, connection, { ...page, generation: 5 })).kind, "staged");
  const conflicting = structuredClone({ ...page, generation: 5 });
  conflicting.sessions[0]!.summary = "changed replay";
  assert.equal((await receiveHostSessionInventory(store, connection, conflicting)).kind, "rejected");
  assert.deepEqual(store.snapshot().hostHarnessSessions, before, "changed page replay discards only staging");

  assert.equal((await receiveHostSessionInventory(store, connection, { ...page, generation: 5 })).kind, "staged");
  const restarted = new Store(path);
  await restarted.load();
  assert.deepEqual(restarted.snapshot().hostHarnessSessions, before, "restart publishes only the last complete generation");
  assert.equal((await receiveHostSessionInventory(restarted, connection, { ...complete, generation: 5 })).kind, "rejected",
    "restart discards partial generation staging");
  assert.equal(discardHostSessionConnectionBeforeRelease(store, connection, () => false), false,
    "a superseded socket still discards its private staging when registry release is stale");
  assert.equal(hasReconciledHostSessionInventory(store, connection), false);
  assert.equal((await receiveHostSessionInventory(store, connection, { ...complete, generation: 5 })).kind, "rejected");
  assert.deepEqual(store.snapshot().hostHarnessSessions, before, "disconnect leaves last complete authority intact");

  supersede();
  assert.equal((await receiveHostSessionInventory(store, connection, { ...page, generation: 5 })).kind, "ignored");
  assert.deepEqual(store.snapshot().hostHarnessSessions, before);
});

test("complete replacement updates reported sessions, marks missing sessions offline, and preserves hub fields", async () => {
  const { store, connection } = await context();
  const firstPage = await loadFixture<HostHarnessSessionInventoryPage>("inventory-page");
  const firstComplete = await loadFixture<HostHarnessSessionInventoryComplete>("inventory-complete");
  await receiveHostSessionInventory(store, connection, firstPage);
  await receiveHostSessionInventory(store, connection, firstComplete);
  await store.transact((state) => {
    const session = state.hostHarnessSessions![0]!;
    session.attachedThreadId = "thread-one";
    session.activeRunId = "run-one";
    session.attachmentEpoch = 3;
  });

  const second = nextObservation(firstPage.sessions[0]!, { hostHarnessSessionId: "host-session-two", providerSessionId: "provider-two" });
  const secondPage: HostHarnessSessionInventoryPage = {
    ...firstPage, generation: 5, sessions: [second], at: "2026-09-30T12:02:00Z"
  };
  const secondComplete: HostHarnessSessionInventoryComplete = {
    ...firstComplete, generation: 5, at: "2026-09-30T12:02:00Z"
  };
  assert.equal((await receiveHostSessionInventory(store, connection, secondPage)).kind, "staged");
  assert.equal((await receiveHostSessionInventory(store, connection, secondComplete)).kind, "accepted");
  const sessions = store.snapshot().hostHarnessSessions!;
  assert.equal(sessions.find((session) => session.hostHarnessSessionId === "host-session-one")?.status, "offline");
  assert.deepEqual(
    sessions.find((session) => session.hostHarnessSessionId === "host-session-one") && {
      attachedThreadId: sessions.find((session) => session.hostHarnessSessionId === "host-session-one")!.attachedThreadId,
      activeRunId: sessions.find((session) => session.hostHarnessSessionId === "host-session-one")!.activeRunId,
      attachmentEpoch: sessions.find((session) => session.hostHarnessSessionId === "host-session-one")!.attachmentEpoch
    },
    { attachedThreadId: "thread-one", activeRunId: "run-one", attachmentEpoch: 3 }
  );
  assert.equal(sessions.find((session) => session.hostHarnessSessionId === "host-session-two")?.status, "running");

  const resurfaced = nextObservation(firstPage.sessions[0]!, { updatedAt: "2026-09-30T12:01:30Z" });
  assert.equal((await receiveHostSessionInventory(store, connection, {
    ...firstPage, generation: 6, sessions: [resurfaced], at: "2026-09-30T12:03:00Z"
  })).kind, "staged");
  assert.equal((await receiveHostSessionInventory(store, connection, {
    ...firstComplete, generation: 6, at: "2026-09-30T12:03:00Z"
  })).kind, "accepted");
  assert.equal(store.snapshot().hostHarnessSessions
    ?.find((session) => session.hostHarnessSessionId === "host-session-one")?.updatedAt, "2026-09-30T12:02:00Z",
  "resurfacing provider evidence cannot regress the Hub's committed projection timestamp");
});

test("session updates require the current synchronized v6 connection and an exact next revision", async () => {
  const { store, connection } = await context();
  const page = await loadFixture<HostHarnessSessionInventoryPage>("inventory-page");
  const complete = await loadFixture<HostHarnessSessionInventoryComplete>("inventory-complete");
  await receiveHostSessionInventory(store, connection, page);
  await receiveHostSessionInventory(store, connection, complete);
  const update = {
    type: "host-session.update" as const,
    nodeId: node.id,
    session: nextObservation(page.sessions[0]!),
    at: "2026-09-30T12:01:00Z"
  };
  let commits = 0;
  store.onCommit(() => { commits += 1; });

  assert.equal((await receiveHostSessionInventory(store, { ...connection, barrierPassed: false }, update)).kind, "ignored");
  assert.equal((await receiveHostSessionInventory(store, { ...connection, isCurrent: () => false }, update)).kind, "ignored");
  assert.equal((await receiveHostSessionInventory(store, connection, { ...update, nodeId: "wrong-node" })).kind, "rejected");
  assert.equal((await receiveHostSessionInventory(store, connection, {
    ...update,
    session: { ...update.session, hostHarnessSessionId: "unknown-session", providerSessionId: "unknown-provider" }
  })).kind, "rejected");
  assert.equal((await receiveHostSessionInventory(store, connection, {
    ...update,
    session: { ...update.session, workspace: "/workspaces/other" }
  })).kind, "rejected");
  assert.equal((await receiveHostSessionInventory(store, connection, {
    ...update,
    session: { ...update.session, status: "awaiting-approval" as const }
  })).kind, "rejected");
  assert.equal((await receiveHostSessionInventory(store, connection, { ...update, session: { ...update.session, revision: 3 } })).kind, "rejected");
  assert.equal(commits, 0);
  assert.equal((await receiveHostSessionInventory(store, connection, update)).kind, "accepted");
  assert.equal(store.snapshot().hostHarnessSessions?.[0]?.status, "running");
  assert.equal((await receiveHostSessionInventory(store, connection, update)).kind, "replayed");
  assert.equal(commits, 1);

  const conflict = { ...update, session: { ...update.session, summary: "different" } };
  assert.equal((await receiveHostSessionInventory(store, connection, conflict)).kind, "rejected");
  assert.equal(store.snapshot().hostHarnessSessions?.[0]?.summary, update.session.summary);
  assert.equal(commits, 1);
});

test("same-generation page partition changes conflict and malformed canaries never reach authority", async () => {
  const { store, connection } = await context();
  const page = await loadFixture<HostHarnessSessionInventoryPage>("inventory-page");
  const complete = await loadFixture<HostHarnessSessionInventoryComplete>("inventory-complete");
  await receiveHostSessionInventory(store, connection, page);
  await receiveHostSessionInventory(store, connection, complete);
  const before = JSON.stringify(store.snapshot().hostHarnessSessions);

  assert.equal((await receiveHostSessionInventory(store, connection, page)).kind, "staged");
  assert.equal((await receiveHostSessionInventory(store, connection, { ...page, pageIndex: 1, sessions: [] })).kind, "staged");
  assert.equal((await receiveHostSessionInventory(store, connection, { ...complete, pageCount: 2 })).kind, "rejected");
  assert.equal(JSON.stringify(store.snapshot().hostHarnessSessions), before);

  const endpointCanary = structuredClone({ ...page, generation: 5 }) as unknown as Record<string, any>;
  endpointCanary.sessions[0].providerEndpoint = "https://credential.invalid";
  assert.equal((await receiveHostSessionInventory(store, connection, endpointCanary)).kind, "rejected");
  const promptCanary = structuredClone({ ...page, generation: 5 });
  promptCanary.sessions[0]!.summary = "Authorization: Bearer should-not-persist";
  assert.equal((await receiveHostSessionInventory(store, connection, promptCanary)).kind, "rejected");
  const unauthorizedWorkspace = structuredClone({ ...page, generation: 5 });
  unauthorizedWorkspace.sessions[0]!.hostHarnessSessionId = "unauthorized-workspace";
  unauthorizedWorkspace.sessions[0]!.providerSessionId = "unauthorized-provider";
  unauthorizedWorkspace.sessions[0]!.workspace = "/outside/advertised-roots";
  assert.equal((await receiveHostSessionInventory(store, connection, unauthorizedWorkspace)).kind, "staged");
  assert.equal((await receiveHostSessionInventory(store, connection, { ...complete, generation: 5 })).kind, "rejected");
  assert.doesNotMatch(JSON.stringify(store.snapshot()), /credential\.invalid|should-not-persist|outside\/advertised-roots/);
});

test("protected capacity rejects a new generation without evicting authority and old exact replay remains answerable", async () => {
  const { store, connection } = await context();
  const page = await loadFixture<HostHarnessSessionInventoryPage>("inventory-page");
  const complete = await loadFixture<HostHarnessSessionInventoryComplete>("inventory-complete");
  await receiveHostSessionInventory(store, connection, page);
  await receiveHostSessionInventory(store, connection, complete);
  await store.transact((state) => {
    const original = state.hostHarnessSessions![0]!;
    const observation = state.hostSessionLastObservations![0]!;
    original.attachedThreadId = "protected-thread";
    for (let index = 1; index < 4_096; index += 1) {
      const suffix = index.toString().padStart(4, "0");
      state.hostHarnessSessions!.push({
        ...original,
        hostHarnessSessionId: `protected-${suffix}`,
        providerSessionId: `provider-${suffix}`
      });
      state.hostSessionLastObservations!.push({
        ...observation,
        hostHarnessSessionId: `protected-${suffix}`,
        providerSessionId: `provider-${suffix}`
      });
    }
  });
  const candidate: HostHarnessSessionInventoryPage = {
    ...page,
    generation: 5,
    sessions: [{ ...page.sessions[0]!, hostHarnessSessionId: "new-session", providerSessionId: "new-provider" }]
  };
  assert.equal((await receiveHostSessionInventory(store, connection, candidate)).kind, "staged");
  const refused = await receiveHostSessionInventory(store, connection, { ...complete, generation: 5 });
  assert.equal(refused.kind, "rejected");
  assert.match(refused.kind === "rejected" ? refused.reason ?? "" : "", /capacity/);
  assert.equal(store.snapshot().hostHarnessSessions?.length, 4_096);
  assert.equal(store.snapshot().hostHarnessSessions?.some((session) => session.hostHarnessSessionId === "new-session"), false);

  assert.equal((await receiveHostSessionInventory(store, connection, page)).kind, "staged");
  assert.equal((await receiveHostSessionInventory(store, connection, complete)).kind, "replayed");
});
