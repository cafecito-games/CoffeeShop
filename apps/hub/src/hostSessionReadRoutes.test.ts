import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import { HostSessionHistoryAuthority } from "./hostSessionHistory.js";
import { projectNodeHostSessionsOffline } from "./hostSessionInventory.js";
import { hostSessionList, registerHostSessionReadRoutes } from "./hostSessionReadRoutes.js";
import { operatorCredentialGuard } from "./orchestratorClients.js";
import type { State } from "./store.js";
import {
  hostSessionTestComplete,
  hostSessionTestFixture,
  hostSessionTestObservation,
  hostSessionTestPage
} from "./hostSessionTestSupport.js";

test("authenticated list detail and history routes are bounded, filterable, generic, and explicitly projected", async (t) => {
  const previousEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  t.after(() => {
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
  });
  const { store, authority, connection } = await hostSessionTestFixture();
  const second = hostSessionTestObservation({
    hostHarnessSessionId: "host-session-two", providerSessionId: "provider-thread-two", status: "active-elsewhere",
    workspace: "/workspace/secret-service", controlMode: "observe", operations: ["read-history"],
    createdAt: "2026-10-06T10:01:00Z", updatedAt: "2026-10-06T10:01:00Z"
  });
  await authority.receive(connection, hostSessionTestPage(1, [hostSessionTestObservation(), second]));
  await authority.receive(connection, hostSessionTestComplete(1, 2));
  const history = new HostSessionHistoryAuthority(store);
  assert.equal(history.expect(connection, "host-session-one", "history-request-one"), true);
  assert.equal((await history.receive(connection, {
    type: "host-session.history.page", nodeId: "node-one", hostHarnessSessionId: "host-session-one",
    requestId: "history-request-one", items: [{ id: "history-one", kind: "assistant", text: "Bounded history", truncated: false }],
    truncated: true, at: "2026-10-06T12:05:00Z"
  })).kind, "accepted");

  const app = express();
  app.use(operatorCredentialGuard("operator-token"));
  registerHostSessionReadRoutes(app, store);
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not bind TCP");
  const base = `http://127.0.0.1:${address.port}`;
  const authorized = { headers: { authorization: "Bearer operator-token" } };

  const unauthorized = await fetch(`${base}/api/host-sessions`);
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: "Unauthorized" });
  const queryAuthenticated = await fetch(`${base}/api/host-sessions?token=operator-token&limit=1`);
  assert.equal(queryAuthenticated.status, 200, "the supported query credential is ignored after authentication");

  const firstPage = await fetch(`${base}/api/host-sessions?limit=1&status=idle`, authorized);
  assert.equal(firstPage.status, 200);
  const list = await firstPage.json() as Record<string, unknown>;
  assert.equal(list.total, 1);
  assert.equal((list.sessions as Array<Record<string, unknown>>)[0]?.hostHarnessSessionId, "host-session-one");
  assert.ok(!("receipts" in (list.sessions as Array<Record<string, unknown>>)[0]!));
  assert.ok(!("items" in (list.sessions as Array<Record<string, unknown>>)[0]!));

  const filtered = await fetch(`${base}/api/host-sessions?harnessId=codex-cli&controlMode=observe`, authorized);
  const filteredBody = await filtered.json() as { sessions: Array<{ hostHarnessSessionId: string }> };
  assert.deepEqual(filteredBody.sessions.map((session) => session.hostHarnessSessionId), ["host-session-two"]);
  const workspaceFiltered = await fetch(`${base}/api/host-sessions?workspace=${encodeURIComponent("/workspace/secret-service")}`, authorized);
  assert.equal(workspaceFiltered.status, 200);
  const workspaceBody = await workspaceFiltered.json() as { sessions: Array<{ hostHarnessSessionId: string }> };
  assert.deepEqual(workspaceBody.sessions.map((session) => session.hostHarnessSessionId), ["host-session-two"]);
  const keysetFirst = await fetch(`${base}/api/host-sessions?limit=1`, authorized);
  const keysetFirstBody = await keysetFirst.json() as { nextCursor?: string; revision: number };
  assert.equal(keysetFirstBody.nextCursor, "host-session-one");
  await store.transact((state) => {
    state.hostHarnessSessions!.push({
      ...hostSessionTestObservation({
        hostHarnessSessionId: "host-session-aaa", providerSessionId: "provider-thread-aaa",
        createdAt: "2026-10-06T09:00:00Z", updatedAt: "2026-10-06T09:00:00Z"
      }),
      attachmentEpoch: 0
    });
    state.hostHarnessSessions!.sort((left, right) => left.hostHarnessSessionId < right.hostHarnessSessionId ? -1 : 1);
    state.hostSessionInventoryRevision = (state.hostSessionInventoryRevision ?? 0) + 1;
  });
  const changedWalk = await fetch(`${base}/api/host-sessions?limit=1&revision=${keysetFirstBody.revision}&cursor=${keysetFirstBody.nextCursor}`, authorized);
  assert.equal(changedWalk.status, 200, "immutable identity keysets keep progressing across inventory churn");
  const changedWalkBody = await changedWalk.json() as { sessions: Array<{ hostHarnessSessionId: string }>; revision: number };
  assert.deepEqual(changedWalkBody.sessions.map((session) => session.hostHarnessSessionId), ["host-session-two"]);
  assert.ok(changedWalkBody.revision > keysetFirstBody.revision);
  const restartedWalk = await fetch(`${base}/api/host-sessions?limit=2`, authorized);
  const restartedBody = await restartedWalk.json() as { nextCursor?: string; revision: number };
  assert.equal(restartedBody.nextCursor, "host-session-one");
  const keysetSecond = await fetch(`${base}/api/host-sessions?limit=1&revision=${restartedBody.revision}&cursor=${restartedBody.nextCursor}`, authorized);
  const keysetSecondBody = await keysetSecond.json() as { sessions: Array<{ hostHarnessSessionId: string }> };
  assert.deepEqual(keysetSecondBody.sessions.map((session) => session.hostHarnessSessionId), ["host-session-two"],
    "a revision-bound walk resumes without duplicates or gaps");
  assert.equal((await fetch(`${base}/api/host-sessions?cursor=host-session-one`, authorized)).status, 200);
  assert.equal((await fetch(`${base}/api/host-sessions?cursor=Authorization:%20Bearer%20SECRET_CANARY`, authorized)).status, 400);
  assert.equal((await fetch(`${base}/api/host-sessions?limit=65`, authorized)).status, 400);
  assert.equal((await fetch(`${base}/api/host-sessions?unknown=value`, authorized)).status, 400);

  const detailResponse = await fetch(`${base}/api/host-sessions/host-session-one`, authorized);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json() as Record<string, unknown>;
  assert.equal((detail.session as Record<string, unknown>).providerSessionId, "provider-thread-one");
  assert.deepEqual(detail.links, {});

  const historyResponse = await fetch(`${base}/api/host-sessions/host-session-one/history`, authorized);
  assert.equal(historyResponse.status, 200);
  const historyBody = await historyResponse.json() as Record<string, unknown>;
  assert.equal((historyBody.items as Array<Record<string, unknown>>)[0]?.text, "Bounded history");
  assert.equal(historyBody.truncated, true);
  assert.equal(historyBody.stale, false);
  assert.ok(!("receipts" in historyBody));

  assert.equal((await authority.receive(connection, {
    type: "host-session.update", nodeId: "node-one",
    session: hostSessionTestObservation({
      status: "running", revision: 2, providerTurnId: "turn-one", updatedAt: "2026-10-06T12:06:00Z"
    }),
    at: "2026-10-06T12:06:00Z"
  })).kind, "accepted");
  const staleHistoryResponse = await fetch(`${base}/api/host-sessions/host-session-one/history`, authorized);
  const staleHistory = await staleHistoryResponse.json() as Record<string, unknown>;
  assert.equal(staleHistory.revision, 1);
  assert.equal(staleHistory.stale, true);
  assert.equal((staleHistory.items as Array<Record<string, unknown>>)[0]?.text, "Bounded history");

  await store.transact((state) => projectNodeHostSessionsOffline(state, "node-one"));
  const offlineListResponse = await fetch(`${base}/api/host-sessions?status=offline`, authorized);
  const offlineList = await offlineListResponse.json() as { sessions: Array<Record<string, unknown>> };
  const offlineSummary = offlineList.sessions.find((session) => session.hostHarnessSessionId === "host-session-one")!;
  assert.equal(offlineSummary.status, "offline");
  assert.equal(offlineSummary.controlMode, "observe");
  assert.deepEqual(offlineSummary.operations, []);
  assert.ok(!("providerTurnId" in offlineSummary));
  const offlineDetailResponse = await fetch(`${base}/api/host-sessions/host-session-one`, authorized);
  const offlineDetail = await offlineDetailResponse.json() as { session: Record<string, unknown> };
  assert.equal(offlineDetail.session.controlMode, "observe");
  assert.deepEqual(offlineDetail.session.operations, []);
  assert.ok(!("providerTurnId" in offlineDetail.session));

  const unknown = await fetch(`${base}/api/host-sessions/provider-thread-one`, authorized);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: "Host session not found" });
  const malicious = await fetch(`${base}/api/host-sessions/Authorization:%20Bearer%20CANARY`, authorized);
  assert.equal(malicious.status, 404);
  assert.deepEqual(await malicious.json(), { error: "Host session not found" });
});

test("history route refreshes missing, continuation and stale evidence, re-reads commits, and handles disappearance", async (t) => {
  const { store, authority, connection } = await hostSessionTestFixture();
  await authority.receive(connection, hostSessionTestPage());
  await authority.receive(connection, hostSessionTestComplete());
  const historyAuthority = new HostSessionHistoryAuthority(store);
  let mode: "missing" | "continuation" | "stale" | "disappear" = "missing";
  let refreshes = 0;
  const app = express();
  registerHostSessionReadRoutes(app, store, {
    refreshHistory: async (hostHarnessSessionId) => {
      refreshes += 1;
      if (mode === "missing") {
        assert.equal(historyAuthority.expect(connection, hostHarnessSessionId, "route-refresh-one"), true);
        assert.equal((await historyAuthority.receive(connection, {
          type: "host-session.history.page", nodeId: "node-one", hostHarnessSessionId,
          requestId: "route-refresh-one", items: [{ id: "route-one", kind: "assistant", text: "Refreshed", truncated: false }],
          truncated: false, at: "2026-10-06T12:05:00Z"
        })).kind, "accepted");
      } else if (mode === "continuation") {
        await store.transact((state) => {
          const stored = state.hostSessionHistories![0]!;
          stored.items.push({ id: "route-two", kind: "summary", text: "Continued", truncated: false });
          delete stored.nextCursor;
        });
      } else if (mode === "disappear") {
        await store.transact((state) => {
          state.hostHarnessSessions = state.hostHarnessSessions!.filter((session) =>
            session.hostHarnessSessionId !== hostHarnessSessionId);
          state.hostSessionHistories = state.hostSessionHistories!.filter((history) =>
            history.hostHarnessSessionId !== hostHarnessSessionId);
        });
      }
    }
  });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not bind TCP");
  const url = `http://127.0.0.1:${address.port}/api/host-sessions/host-session-one/history`;

  let response = await fetch(url);
  let body = await response.json() as Record<string, unknown>;
  assert.equal(refreshes, 1);
  assert.equal((body.items as Array<Record<string, unknown>>)[0]?.text, "Refreshed",
    "the route re-reads history committed by the refresh");

  response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(refreshes, 1, "complete current history does not refresh");

  await store.transact((state) => {
    state.hostSessionHistories![0]!.nextCursor = "route-cursor";
    state.hostSessionHistories![0]!.truncated = true;
  });
  mode = "continuation";
  response = await fetch(url);
  body = await response.json() as Record<string, unknown>;
  assert.equal(refreshes, 2);
  assert.equal((body.items as Array<Record<string, unknown>>).length, 2);
  assert.equal(body.nextCursor, undefined);

  assert.equal((await authority.receive(connection, {
    type: "host-session.update", nodeId: "node-one",
    session: hostSessionTestObservation({
      status: "running", revision: 2, providerTurnId: "turn-one", updatedAt: "2026-10-06T12:06:00Z"
    }),
    at: "2026-10-06T12:06:00Z"
  })).kind, "accepted");
  mode = "stale";
  response = await fetch(url);
  body = await response.json() as Record<string, unknown>;
  assert.equal(refreshes, 3);
  assert.equal(body.stale, true);
  assert.equal(body.revision, 1);

  mode = "disappear";
  response = await fetch(url);
  assert.equal(refreshes, 4);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Host session not found" });
});

test("list keysets use exact code-unit order when Unicode identities tie under locale collation", async () => {
  const { store } = await hostSessionTestFixture();
  const decomposed = "host-e\u0301";
  const composed = "host-é";
  assert.equal(decomposed.localeCompare(composed), 0, "fixture must expose locale collation ambiguity");
  const state = store.read((current) => structuredClone(current) as State);
  state.hostHarnessSessions = [decomposed, composed].map((hostHarnessSessionId, index) => ({
    ...hostSessionTestObservation({
      hostHarnessSessionId, providerSessionId: `unicode-provider-${index}`,
      createdAt: "2026-10-06T10:00:00Z", updatedAt: "2026-10-06T10:00:00Z"
    }),
    attachmentEpoch: 0
  }));
  const first = hostSessionList(state, { limit: 1 });
  assert.equal(first.sessions[0]?.hostHarnessSessionId, decomposed);
  assert.equal(first.nextCursor, decomposed);
  const second = hostSessionList(state, { limit: 1, cursor: first.nextCursor });
  assert.equal(second.sessions[0]?.hostHarnessSessionId, composed);
});

test("an unfiltered continuation page touches only logarithmic inventory entries", async () => {
  const { store } = await hostSessionTestFixture();
  const state = store.read((current) => structuredClone(current) as State);
  const sessions = Array.from({ length: 1_024 }, (_, index) => ({
    ...hostSessionTestObservation({
      hostHarnessSessionId: `bounded-${String(index).padStart(4, "0")}`,
      providerSessionId: `bounded-provider-${index}`
    }),
    attachmentEpoch: 0
  }));
  let entryReads = 0;
  state.hostHarnessSessions = new Proxy(sessions, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) entryReads += 1;
      return Reflect.get(target, property, receiver);
    }
  });
  const result = hostSessionList(state, { limit: 4, cursor: "bounded-0999" });
  assert.equal(result.sessions.length, 4);
  assert.ok(entryReads < 32, `expected logarithmic lookup, read ${entryReads} entries`);
});
