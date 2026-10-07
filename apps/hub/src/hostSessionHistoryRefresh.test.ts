import assert from "node:assert/strict";
import test from "node:test";
import { hostHarnessSessionLimits, type HostSessionControlMessage, type HostSessionHubMessage } from "@coffee-shop/protocol";
import { HostSessionHistoryAuthority } from "./hostSessionHistory.js";
import { HostSessionHistoryRefresher, type HostSessionHistoryRefreshOptions } from "./hostSessionHistoryRefresh.js";
import {
  hostSessionTestComplete as complete,
  hostSessionTestFixture as fixture,
  hostSessionTestObservation as observation,
  hostSessionTestPage as inventoryPage
} from "./hostSessionTestSupport.js";

const historyPage = (
  requestId: string,
  overrides: Partial<Extract<HostSessionControlMessage, { type: "host-session.history.page" }>> = {}
): Extract<HostSessionControlMessage, { type: "host-session.history.page" }> => ({
  type: "host-session.history.page", nodeId: "node-one", hostHarnessSessionId: "host-session-one", requestId,
  items: [{ id: `item-${requestId}`, kind: "assistant", text: "Provider history", truncated: false }],
  truncated: false, at: "2026-10-06T12:05:00Z", ...overrides
});

async function setup(overrides: Partial<HostSessionHistoryRefreshOptions> = {}) {
  const testFixture = await fixture();
  await testFixture.authority.receive(testFixture.connection, inventoryPage());
  await testFixture.authority.receive(testFixture.connection, complete());
  const history = new HostSessionHistoryAuthority(testFixture.store);
  let sequence = 0;
  const options: HostSessionHistoryRefreshOptions = {
    store: testFixture.store,
    authority: history,
    connectionFor: () => testFixture.connection,
    send: () => true,
    newId: () => `refresh-${++sequence}`,
    pollAttempts: 2,
    pollMilliseconds: 0,
    wait: async () => {},
    ...overrides
  };
  return { ...testFixture, history, options };
}

test("refresh correlates a successful page and continues from the committed cursor", async () => {
  const context = await setup();
  context.history.expect(context.connection, "host-session-one", "seed-request");
  assert.equal((await context.history.receive(context.connection, historyPage("seed-request", {
    items: [{ id: "seed-item", kind: "assistant", text: "First page", truncated: false }],
    nextCursor: "cursor-two"
  }))).kind, "accepted");
  let sent: Extract<HostSessionHubMessage, { type: "host-session.history.read" }> | undefined;
  context.options.send = (_nodeId, message) => {
    if (message.type === "host-session.history.read") {
      assert.equal(message.cursor, "cursor-two");
      assert.equal(message.limit, hostHarnessSessionLimits.historyItemsPerPage - 1);
      sent = message;
    }
    return true;
  };
  context.options.wait = async () => {
    if (!sent) return;
    const requestId = sent.requestId;
    sent = undefined;
    assert.equal((await context.history.receive(context.connection, historyPage(requestId, {
      items: [{ id: "continued-item", kind: "summary", text: "Second page", truncated: false }],
      nextCursor: undefined
    }))).kind, "accepted");
  };
  const refresher = new HostSessionHistoryRefresher(context.options);
  assert.equal(await refresher.refresh("host-session-one"), "received");
  assert.equal(context.store.read((state) => state.hostSessionHistories?.[0]?.items.length), 2);
  assert.equal(context.store.read((state) => state.hostSessionHistories?.[0]?.nextCursor), undefined);
  assert.equal(context.store.read((state) => state.hostSessionHistories?.[0]?.truncated), false);
});

test("send failure and timeout cancel authority and apply a bounded retry delay", async () => {
  let now = 1_000;
  let sends = 0;
  const failed = await setup({
    now: () => now,
    retryMilliseconds: 100,
    send: () => { sends += 1; return false; }
  });
  const sendFailure = new HostSessionHistoryRefresher(failed.options);
  assert.equal(await sendFailure.refresh("host-session-one"), "deferred");
  assert.equal(failed.history.connectionStateSize(), 0);
  assert.equal(await sendFailure.refresh("host-session-one"), "deferred");
  assert.equal(sends, 1, "the retry delay suppresses repeated sends");
  now += 101;
  assert.equal(await sendFailure.refresh("host-session-one"), "deferred");
  assert.equal(sends, 2);

  const timedOut = await setup({ pollAttempts: 1, wait: async () => {} });
  const timeout = new HostSessionHistoryRefresher(timedOut.options);
  assert.equal(await timeout.refresh("host-session-one"), "deferred");
  assert.equal(timedOut.history.connectionStateSize(), 0);
  assert.equal(timedOut.history.retiredSlotCount("node-one"), 1,
    "a timed-out provider read keeps its node capacity reservation");
  assert.equal((await timedOut.history.receive(timedOut.connection, historyPage("refresh-1"))).kind, "ignored");
  assert.equal(timedOut.history.retiredSlotCount("node-one"), 0);
});

test("a malformed correlated page releases the read without exhausting the poll budget", async () => {
  const context = await setup({ pollAttempts: 100 });
  let sent: Extract<HostSessionHubMessage, { type: "host-session.history.read" }> | undefined;
  let waits = 0;
  context.options.send = (_nodeId, message) => {
    if (message.type === "host-session.history.read") sent = message;
    return true;
  };
  context.options.wait = async () => {
    waits += 1;
    if (!sent) return;
    const request = sent;
    sent = undefined;
    assert.equal(context.history.rejectMalformed(context.connection, {
      ...historyPage(request.requestId),
      items: [{ id: "invalid-item", kind: "assistant", text: "Authorization: Bearer SECRET_CANARY", truncated: false }]
    }), true);
  };
  const refresher = new HostSessionHistoryRefresher(context.options);
  assert.equal(await refresher.refresh("host-session-one"), "deferred");
  assert.equal(waits, 1);
  assert.equal(context.history.connectionStateSize(), 0);
});

test("the production wait window accepts a page arriving after the former two-second cutoff", async () => {
  const context = await setup({ pollAttempts: undefined, pollMilliseconds: 25 });
  let sent: Extract<HostSessionHubMessage, { type: "host-session.history.read" }> | undefined;
  let waits = 0;
  context.options.send = (_nodeId, message) => {
    if (message.type === "host-session.history.read") sent = message;
    return true;
  };
  context.options.wait = async () => {
    waits += 1;
    if (waits !== 81 || !sent) return;
    const requestId = sent.requestId;
    sent = undefined;
    assert.equal((await context.history.receive(context.connection, historyPage(requestId))).kind, "accepted");
  };
  const refresher = new HostSessionHistoryRefresher(context.options);
  assert.equal(await refresher.refresh("host-session-one"), "received");
  assert.equal(waits, 81);
});

test("a revision change retries immediately and never hides the earlier committed history", async () => {
  const context = await setup();
  let sent: Extract<HostSessionHubMessage, { type: "host-session.history.read" }> | undefined;
  let sends = 0;
  context.options.send = (_nodeId, message) => {
    if (message.type === "host-session.history.read") sent = message;
    sends += 1;
    return true;
  };
  context.options.wait = async () => {
    if (!sent) return;
    const command = sent;
    sent = undefined;
    if (sends === 1) {
      assert.equal((await context.authority.receive(context.connection, {
        type: "host-session.update", nodeId: "node-one",
        session: observation({
          status: "running", revision: 2, providerTurnId: "turn-one", updatedAt: "2026-10-06T12:06:00Z"
        }),
        at: "2026-10-06T12:06:00Z"
      })).kind, "accepted");
      assert.equal((await context.history.receive(context.connection, historyPage(command.requestId))).kind, "rejected");
      return;
    }
    assert.equal((await context.history.receive(context.connection, historyPage(command.requestId))).kind, "accepted");
  };
  const refresher = new HostSessionHistoryRefresher(context.options);
  assert.equal(await refresher.refresh("host-session-one"), "received");
  assert.equal(sends, 2);
  assert.equal(refresher.retryStateSize(), 0);
  assert.equal(context.store.read((state) => state.hostSessionHistories?.[0]?.revision), 2);
});

test("a connection replacement retries immediately on the new current socket", async () => {
  const context = await setup();
  const replacement = {
    ...context.connection,
    generation: context.connection.generation + 1,
    isCurrent: () => true
  };
  let currentConnection = context.connection;
  let sent: Extract<HostSessionHubMessage, { type: "host-session.history.read" }> | undefined;
  let sends = 0;
  context.options.connectionFor = () => currentConnection;
  context.options.send = (_nodeId, message) => {
    if (message.type === "host-session.history.read") sent = message;
    sends += 1;
    return true;
  };
  context.options.wait = async () => {
    if (!sent) return;
    const command = sent;
    sent = undefined;
    if (sends === 1) {
      context.setCurrent(false);
      context.history.discard(context.connection);
      currentConnection = replacement;
      return;
    }
    assert.equal((await context.history.receive(replacement, historyPage(command.requestId))).kind, "accepted");
  };
  const refresher = new HostSessionHistoryRefresher(context.options);
  assert.equal(await refresher.refresh("host-session-one"), "received");
  assert.equal(sends, 2);
  assert.equal(refresher.retryStateSize(), 0);
});

test("revision retries share one bounded polling budget", async () => {
  let waits = 0;
  const context = await setup({
    pollAttempts: 3,
    revisionRetries: 5,
    wait: async () => {
      waits += 1;
      const revision = waits + 1;
      const current = context.store.read((state) => state.hostHarnessSessions?.[0]);
      if (!current) return;
      const running = current.status === "idle";
      await context.authority.receive(context.connection, {
        type: "host-session.update", nodeId: "node-one",
        session: observation({
          status: running ? "running" : "idle", revision,
          ...(running ? { providerTurnId: `turn-${revision}` } : {}),
          updatedAt: `2026-10-06T12:0${revision}:00Z`
        }),
        at: `2026-10-06T12:0${revision}:00Z`
      });
      context.history.cancel(context.connection, `refresh-${waits * 2 - 1}`);
    }
  });
  const refresher = new HostSessionHistoryRefresher(context.options);
  assert.equal(await refresher.refresh("host-session-one"), "deferred");
  assert.ok(waits <= 3, `all revision attempts must share the three-poll budget, observed ${waits}`);
});

test("offline, unsupported and unconnected sessions are skipped without backoff", async () => {
  const context = await setup({ connectionFor: () => undefined });
  const refresher = new HostSessionHistoryRefresher(context.options);
  assert.equal(await refresher.refresh("host-session-one"), "skipped");
  assert.equal(refresher.retryStateSize(), 0);
  assert.equal((await context.authority.receive(context.connection, {
    type: "host-session.update", nodeId: "node-one",
    session: observation({ status: "offline", revision: 2, operations: [], updatedAt: "2026-10-06T12:06:00Z" }),
    at: "2026-10-06T12:06:00Z"
  })).kind, "accepted");
  context.options.connectionFor = () => context.connection;
  const offline = new HostSessionHistoryRefresher(context.options);
  assert.equal(await offline.refresh("host-session-one"), "skipped");
  assert.equal(offline.retryStateSize(), 0);
});
