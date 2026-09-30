import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import express from "express";
import type {
  ComputeNode,
  HostHarnessSessionInventoryComplete,
  HostHarnessSessionInventoryPage,
  HostSessionControlMessage
} from "@coffee-shop/protocol";
import { receiveHostSessionHistory } from "./hostSessionHistory.js";
import { receiveHostSessionInventory } from "./hostSessionInventory.js";
import { registerHostSessionReadRoutes } from "./hostSessionReadRoutes.js";
import { operatorCredentialGuard } from "./orchestratorClients.js";
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

async function fixture() {
  const store = new Store(join(await mkdtemp(join(tmpdir(), "coffee-shop-host-routes-")), "state.json"));
  await store.load();
  await store.transact((state) => { state.nodes.push(node); });
  const connection = {
    nodeId: node.id, connectionGeneration: 1, supportsCapability: true,
    barrierPassed: true, isCurrent: () => true
  };
  const page = await loadFixture<HostHarnessSessionInventoryPage>("inventory-page");
  page.sessions.push({
    ...page.sessions[0]!, hostHarnessSessionId: "host-session-two", providerSessionId: "provider-session-two",
    status: "offline", revision: 2, updatedAt: "2026-09-30T12:01:00Z"
  });
  const complete = await loadFixture<HostHarnessSessionInventoryComplete>("inventory-complete");
  complete.sessionCount = 2;
  await receiveHostSessionInventory(store, connection, page);
  await receiveHostSessionInventory(store, connection, complete);
  const history = await loadFixture<HistoryPage>("history-page");
  history.items[0]!.text = "SAFE_HISTORY_BODY";
  await receiveHostSessionHistory(store, connection, history);

  const app = express();
  app.use(operatorCredentialGuard("operator-secret"));
  registerHostSessionReadRoutes(app, { store });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  const call = (path: string, token?: string) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const headers = token ? { authorization: `Bearer ${token}` } : undefined;
    const req = request({ host: "127.0.0.1", port: address.port, path, headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(body) }));
    });
    req.on("error", reject);
    req.end();
  });
  return { store, call, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("operator-authenticated host-session routes provide bounded list/detail/history projections", async (t) => {
  const previousEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  t.after(() => {
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
  });
  const { call, close } = await fixture();
  t.after(close);

  assert.deepEqual(await call("/api/host-sessions"), { status: 401, body: { error: "Unauthorized" } });
  const first = await call("/api/host-sessions?status=idle&limit=1", "operator-secret");
  assert.equal(first.status, 200);
  assert.equal(first.body.sessions.length, 1);
  assert.equal(first.body.sessions[0].hostHarnessSessionId, "host-session-one");
  assert.equal(first.body.sessions[0].providerSessionId, undefined, "list summaries omit provider identity");
  assert.equal(first.body.sessions[0].workspace, undefined, "list summaries omit local paths");

  const pageOne = await call("/api/host-sessions?limit=1", "operator-secret");
  assert.equal(pageOne.body.nextCursor, "host-session-one");
  const pageTwo = await call(`/api/host-sessions?limit=1&cursor=${pageOne.body.nextCursor}`, "operator-secret");
  assert.deepEqual(pageTwo.body.sessions.map((session: { hostHarnessSessionId: string }) => session.hostHarnessSessionId), ["host-session-two"]);
  assert.equal(pageTwo.body.nextCursor, undefined);

  const detail = await call("/api/host-sessions/host-session-one", "operator-secret");
  assert.equal(detail.status, 200);
  assert.equal(detail.body.session.providerSessionId, "provider-session-one");
  assert.equal(detail.body.session.workspace, "/workspaces/coffee-shop");
  assert.doesNotMatch(JSON.stringify(detail.body), /SAFE_HISTORY_BODY/);

  const history = await call("/api/host-sessions/host-session-one/history?limit=1", "operator-secret");
  assert.equal(history.status, 200);
  assert.equal(history.body.items[0].text, "SAFE_HISTORY_BODY");
  assert.equal(history.body.truncated, true);
  assert.equal(history.body.providerCursor, "cursor-two");
});

test("read routes reject invalid filters/cursors and use generic unknown-session responses", async (t) => {
  const previousEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  t.after(() => {
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
  });
  const { call, close } = await fixture();
  t.after(close);

  for (const path of [
    "/api/host-sessions?status=secret-status",
    "/api/host-sessions?limit=1000",
    `/api/host-sessions?nodeId=${"a".repeat(257)}`,
    "/api/host-sessions?cursor=missing",
    `/api/host-sessions/host-session-one/history?cursor=${"a".repeat(257)}`,
    "/api/host-sessions/host-session-one/history?cursor=missing"
  ]) assert.equal((await call(path, "operator-secret")).status, 400, path);

  const detail = await call("/api/host-sessions/missing", "operator-secret");
  const history = await call("/api/host-sessions/missing/history", "operator-secret");
  assert.deepEqual(detail, { status: 404, body: { error: "Host session not found" } });
  assert.deepEqual(history, { status: 404, body: { error: "Host session not found" } });
});
