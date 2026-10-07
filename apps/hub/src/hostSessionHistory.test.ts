import assert from "node:assert/strict";
import test from "node:test";
import { hostHarnessSessionLimits, type HostSessionControlMessage } from "@coffee-shop/protocol";
import {
  enforceHostSessionHistoryRetention,
  HostSessionHistoryAuthority
} from "./hostSessionHistory.js";
import { hostSessionHistoryStorageLimits, type State, type StoredHostSessionHistory } from "./store.js";
import {
  hostSessionTestComplete as complete,
  hostSessionTestFixture as fixture,
  hostSessionTestObservation as observation,
  hostSessionTestPage as page
} from "./hostSessionTestSupport.js";

const historyPage = (overrides: Partial<Extract<HostSessionControlMessage, { type: "host-session.history.page" }>> = {}): Extract<HostSessionControlMessage, { type: "host-session.history.page" }> => ({
  type: "host-session.history.page", nodeId: "node-one", hostHarnessSessionId: "host-session-one",
  requestId: "history-request-one", items: [{ id: "history-one", kind: "assistant", text: "Bounded imported history", truncated: false }],
  nextCursor: "cursor-two", truncated: false, at: "2026-10-06T12:05:00Z", ...overrides
});

test("history requires exact current-connection request correlation and persists bounded provider-neutral projection", async () => {
  const { store, authority: inventory, connection } = await fixture();
  await inventory.receive(connection, page());
  await inventory.receive(connection, complete());
  const history = new HostSessionHistoryAuthority(store);
  assert.equal(history.expect(connection, "host-session-one", "history-request-one"), true);
  const runsBefore = JSON.stringify(store.snapshot().runs);
  const accepted = await history.receive(connection, historyPage());
  assert.equal(accepted.kind, "accepted");
  assert.equal(store.read((state) => state.hostSessionHistories?.[0]?.items[0]?.text), "Bounded imported history");
  assert.equal(JSON.stringify(store.snapshot().runs), runsBefore, "imported history never becomes Run authority");
  assert.ok(!("hostSessionHistories" in store.snapshot()), "history bodies never enter the global Snapshot");

  assert.equal((await history.receive(connection, historyPage())).kind, "replayed", "exact transport replay needs no new expectation");
  const conflict = historyPage({ items: [{ id: "history-one", kind: "assistant", text: "changed", truncated: false }] });
  assert.equal((await history.receive(connection, conflict)).kind, "rejected");
});

test("history rejects cursor gaps, wrong identity/socket, duplicates, and secret-like projected text", async () => {
  const { store, authority: inventory, connection } = await fixture();
  await inventory.receive(connection, page());
  await inventory.receive(connection, complete());
  const history = new HostSessionHistoryAuthority(store);

  assert.equal((await history.receive(connection, historyPage())).kind, "rejected", "unsolicited pages are not authority");
  assert.equal(history.expect(connection, "host-session-one", "history-request-one", "wrong-cursor"), false);
  assert.equal(history.expect(connection, "host-session-one", "history-request-one"), true);
  const secret = historyPage({ items: [{ id: "history-secret", kind: "assistant", text: "Authorization: Bearer SECRET_CANARY", truncated: false }] });
  assert.equal((await history.receive(connection, secret)).kind, "rejected");
  assert.deepEqual(store.read((state) => state.hostSessionHistories), []);

  history.expect(connection, "host-session-one", "history-request-two");
  const wrongNode = historyPage({ requestId: "history-request-two", nodeId: "node-other" });
  assert.equal((await history.receive(connection, wrongNode)).kind, "rejected");
  assert.deepEqual(store.read((state) => state.hostSessionHistories), []);
});

test("history continuation is cursor-ordered, duplicate-safe, explicitly truncated, and revision-correlated", async () => {
  const { store, authority: inventory, connection } = await fixture();
  await inventory.receive(connection, page());
  await inventory.receive(connection, complete());
  const history = new HostSessionHistoryAuthority(store);
  history.expect(connection, "host-session-one", "history-request-one");
  assert.equal((await history.receive(connection, historyPage({ nextCursor: "cursor-token-two", truncated: true }))).kind, "accepted");
  assert.equal(store.read((state) => state.hostSessionHistories?.[0]?.truncated), false,
    "a provider continuation marker is not durable content loss");
  const firstObservedAt = store.read((state) => state.hostSessionHistories?.[0]?.observedAt);

  assert.equal(history.expect(connection, "host-session-one", "history-request-two", "cursor-missing"), false);
  assert.equal(history.expect(connection, "host-session-one", "history-request-two", "cursor-token-two"), true);
  const continuation = historyPage({
    requestId: "history-request-two", items: [{ id: "history-two", kind: "summary", text: "Summary", truncated: false }],
    nextCursor: undefined, truncated: false, at: "2020-01-01T00:00:00Z"
  });
  assert.equal((await history.receive(connection, continuation)).kind, "accepted");
  const stored = store.read((state) => structuredClone(state.hostSessionHistories?.[0]));
  assert.deepEqual(stored?.items.map((item) => item.id), ["history-one", "history-two"]);
  assert.equal(stored?.truncated, false, "a consumed continuation is not itself truncation");
  assert.ok(Date.parse(stored?.observedAt ?? "") >= Date.parse(firstObservedAt ?? ""),
    "Hub observation time does not regress with Barista's clock");

  const update: HostSessionControlMessage = {
    type: "host-session.update", nodeId: "node-one",
    session: observation({ status: "running", revision: 2, providerTurnId: "turn-one", updatedAt: "2026-10-06T12:10:00Z" }),
    at: "2026-10-06T12:10:00Z"
  };
  assert.equal((await inventory.receive(connection, update)).kind, "accepted");
  assert.equal(history.expect(connection, "host-session-one", "history-request-three"), true);
  assert.equal((await history.receive(connection, historyPage({ requestId: "history-request-three", nextCursor: undefined }))).kind, "accepted",
    "a cursorless page replaces stale history at the newer revision");
  const refreshed = store.read((state) => state.hostSessionHistories?.[0]);
  assert.equal(refreshed?.revision, 2);
  assert.deepEqual(refreshed?.items.map((item) => item.id), ["history-one"]);
});

test("history permits one bounded in-flight request per session and cancellation frees it", async () => {
  const { store, authority: inventory, connection } = await fixture();
  await inventory.receive(connection, page());
  await inventory.receive(connection, complete());
  const history = new HostSessionHistoryAuthority(store);
  assert.equal(history.expect(connection, "host-session-one", "history-request-one"), true);
  assert.equal(history.expect(connection, "host-session-one", "history-request-two"), false);
  history.cancel(connection, "history-request-one");
  assert.equal(history.expect(connection, "host-session-one", "history-request-two"), true);
});

test("history rejects a provider page larger than the requested remaining extent", async () => {
  const { store, authority: inventory, connection } = await fixture();
  await inventory.receive(connection, page());
  await inventory.receive(connection, complete());
  const history = new HostSessionHistoryAuthority(store);
  assert.equal(history.expect(connection, "host-session-one", "history-limited", undefined, 1), true);
  assert.equal((await history.receive(connection, historyPage({
    requestId: "history-limited",
    items: [
      { id: "limited-one", kind: "assistant", text: "one", truncated: false },
      { id: "limited-two", kind: "assistant", text: "two", truncated: false }
    ]
  }))).kind, "rejected");
  assert.equal(history.connectionStateSize(), 0);
});

test("history admission never exceeds the Barista per-node read slots", async () => {
  const { store, authority: inventory, connection } = await fixture();
  await inventory.receive(connection, page());
  await inventory.receive(connection, complete());
  await store.transact((state) => {
    state.hostHarnessSessions = Array.from({ length: hostHarnessSessionLimits.historyReadsPerNode + 1 }, (_, index) => ({
        ...observation({
          hostHarnessSessionId: `host-session-${index}`, providerSessionId: `provider-thread-${index}`
        }),
        attachmentEpoch: 0
      }));
  });
  const history = new HostSessionHistoryAuthority(store);
  for (let index = 0; index < hostHarnessSessionLimits.historyReadsPerNode; index += 1) {
    assert.equal(history.expect(connection, `host-session-${index}`, `history-request-${index}`), true);
  }
  assert.equal(history.expect(connection, `host-session-${hostHarnessSessionLimits.historyReadsPerNode}`, "history-over-capacity"), false);
});

test("history remains expected until its durable transaction settles", async () => {
  const { store, authority: inventory, connection } = await fixture();
  await inventory.receive(connection, page());
  await inventory.receive(connection, complete());
  const history = new HostSessionHistoryAuthority(store);
  assert.equal(history.expect(connection, "host-session-one", "history-request-one"), true);
  const originalTransact = store.transact.bind(store);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  store.transact = async (change) => {
    await gate;
    return originalTransact(change);
  };

  const receipt = history.receive(connection, historyPage());
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(history.isExpected(connection, "history-request-one"), true,
    "polling cannot infer failure while the accepted receipt is still committing");
  assert.equal(history.expect(connection, "host-session-one", "history-request-two"), false,
    "a second request cannot overtake the in-flight receipt");
  release();
  assert.equal((await receipt).kind, "accepted");
  assert.equal(history.isExpected(connection, "history-request-one"), false);
});

test("logical connection replacement discards old inventory staging and history expectations", async () => {
  const { store, authority: inventory, connection } = await fixture();
  await inventory.receive(connection, page());
  await inventory.receive(connection, complete());
  const history = new HostSessionHistoryAuthority(store);
  assert.equal(history.expect(connection, "host-session-one", "history-request-one"), true);
  assert.equal((await inventory.receive(connection, page(2))).kind, "staged");
  assert.equal(inventory.connectionStateSize(), 1);
  assert.equal(history.connectionStateSize(), 1);

  inventory.discard(connection);
  history.discard(connection);
  assert.equal(inventory.connectionStateSize(), 0);
  assert.equal(history.connectionStateSize(), 0);
  assert.equal(history.retiredSlotCount(connection.nodeId), 1,
    "the old provider read reserves its Barista slot until its timeout");
});

test("retired reads count against the node across reconnects until their shared timeout", async () => {
  const { store, authority: inventory, connection } = await fixture();
  await inventory.receive(connection, page());
  await inventory.receive(connection, complete());
  await store.transact((state) => {
    state.hostHarnessSessions = Array.from({ length: hostHarnessSessionLimits.historyReadsPerNode + 1 }, (_, index) => ({
      ...observation({
        hostHarnessSessionId: `reconnect-session-${index}`, providerSessionId: `reconnect-provider-${index}`
      }),
      attachmentEpoch: 0
    }));
  });
  let now = 1_000;
  const history = new HostSessionHistoryAuthority(store, () => now);
  for (let index = 0; index < hostHarnessSessionLimits.historyReadsPerNode; index += 1) {
    assert.equal(history.expect(connection, `reconnect-session-${index}`, `old-request-${index}`), true);
  }
  history.discard(connection);
  assert.equal(history.retiredSlotCount(connection.nodeId), hostHarnessSessionLimits.historyReadsPerNode);
  const replacement = { ...connection, generation: connection.generation + 1 };
  assert.equal(history.expect(replacement, `reconnect-session-${hostHarnessSessionLimits.historyReadsPerNode}`, "new-request"), false);
  now += hostHarnessSessionLimits.historyResponseWaitMilliseconds + 1;
  assert.equal(history.expect(replacement, `reconnect-session-${hostHarnessSessionLimits.historyReadsPerNode}`, "new-request"), true);
  assert.equal(history.retiredSlotCount(connection.nodeId), 0);
});

test("a full history page drops its continuation instead of fetching items that cannot be retained", async () => {
  const { store, authority: inventory, connection } = await fixture();
  await inventory.receive(connection, page());
  await inventory.receive(connection, complete());
  const history = new HostSessionHistoryAuthority(store);
  const fullPage = Array.from({ length: hostHarnessSessionLimits.historyItemsPerPage }, (_, index) => ({
    id: `history-${index}`, kind: "assistant" as const, text: `Item ${index}`, truncated: false
  }));
  history.expect(connection, "host-session-one", "history-full");
  assert.equal((await history.receive(connection, historyPage({ requestId: "history-full", items: fullPage, nextCursor: "cursor-more" }))).kind, "accepted");
  const stored = store.read((state) => state.hostSessionHistories?.[0]);
  assert.equal(stored?.items.length, hostHarnessSessionLimits.historyItemsPerPage);
  assert.equal(stored?.omitted, true);
  assert.equal(stored?.truncated, true);
  assert.equal(stored?.nextCursor, undefined);
  assert.equal(history.expect(connection, "host-session-one", "history-overflow", "cursor-more"), false);
});

test("an already-full receipt window rotates the oldest correlation and seals the continuation", async () => {
  const { store, authority: inventory, connection } = await fixture();
  await inventory.receive(connection, page());
  await inventory.receive(connection, complete());
  const history = new HostSessionHistoryAuthority(store);
  history.expect(connection, "host-session-one", "history-first");
  assert.equal((await history.receive(connection, historyPage({ requestId: "history-first", nextCursor: "cursor-63" }))).kind, "accepted");
  await store.transact((state) => {
    const stored = state.hostSessionHistories![0]!;
    stored.receipts = Array.from({ length: 64 }, (_, index) => ({
      requestId: `receipt-${index}`, digest: index.toString(16).padStart(64, "0")
    }));
  });
  assert.equal(history.expect(connection, "host-session-one", "history-final", "cursor-63"), true);
  assert.equal((await history.receive(connection, historyPage({
    requestId: "history-final", items: [{ id: "history-final", kind: "summary", text: "Final retained item", truncated: false }],
    nextCursor: "cursor-unread"
  }))).kind, "accepted");
  const stored = store.read((state) => state.hostSessionHistories?.[0]);
  assert.equal(stored?.receipts.length, 64);
  assert.equal(stored?.receipts.some((receipt) => receipt.requestId === "history-final"), true);
  assert.equal(stored?.nextCursor, undefined);
  assert.equal(stored?.omitted, true);
  assert.equal(stored?.truncated, true);
  assert.equal((await history.receive(connection, historyPage({
    requestId: "history-final", items: [{ id: "history-final", kind: "summary", text: "Final retained item", truncated: false }],
    nextCursor: "cursor-unread"
  }))).kind, "replayed");
});

test("durable history retention evicts the oldest unattached records under its global byte budget", async () => {
  const { store } = await fixture();
  const state = store.read((current) => structuredClone(current) as State);
  const text = "x".repeat(hostHarnessSessionLimits.historyItemTextBytes);
  const itemCount = Math.max(1, Math.floor((hostSessionHistoryStorageLimits.bytes * 0.6)
    / hostHarnessSessionLimits.historyItemTextBytes));
  const makeHistory = (id: string, observedAt: string): StoredHostSessionHistory => ({
    hostHarnessSessionId: id, nodeId: "node-one", harnessId: "codex-cli",
    providerSessionId: `provider-${id}`, workspace: "/workspace/project", revision: 1,
    items: Array.from({ length: itemCount }, (_, index) => ({
      id: `${id}-${index}`, kind: "assistant", text, truncated: false
    })),
    truncated: false, omitted: false, observedAt, receipts: []
  });
  state.hostSessionHistories = [
    makeHistory("history-old", "2026-10-06T12:00:00Z"),
    makeHistory("history-current", "2026-10-06T12:01:00Z")
  ];
  assert.equal(enforceHostSessionHistoryRetention(state, "history-current"), true);
  assert.deepEqual(state.hostSessionHistories.map((history) => history.hostHarnessSessionId), ["history-current"]);
  assert.ok(Buffer.byteLength(JSON.stringify(state.hostSessionHistories), "utf8") <= hostSessionHistoryStorageLimits.bytes);
});

test("an escape-heavy provider page is truncated to the durable byte budget instead of rejected", async () => {
  const { store, authority: inventory, connection } = await fixture();
  await inventory.receive(connection, page());
  await inventory.receive(connection, complete());
  const history = new HostSessionHistoryAuthority(store);
  assert.equal(history.expect(connection, "host-session-one", "history-escaped"), true);
  const items = Array.from({ length: 30 }, (_, index) => ({
    id: `escaped-${index}`, kind: "assistant" as const,
    text: "\u0000".repeat(hostHarnessSessionLimits.historyItemTextBytes), truncated: false
  }));
  assert.equal((await history.receive(connection, historyPage({
    requestId: "history-escaped", items, nextCursor: "cursor-more"
  }))).kind, "accepted");
  const stored = store.read((state) => state.hostSessionHistories?.[0]);
  assert.equal(stored?.omitted, true);
  assert.equal(stored?.truncated, true);
  assert.equal(stored?.nextCursor, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(stored), "utf8") + 2 <= hostSessionHistoryStorageLimits.bytes);
});
