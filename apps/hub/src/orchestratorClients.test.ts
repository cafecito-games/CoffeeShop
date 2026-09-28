import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import { orchestratorClientScopes } from "@coffee-shop/protocol";
import {
  createOrchestratorClientRevocations,
  listOrchestratorClients,
  mintOrchestratorClient,
  type MintedOrchestratorClient,
  operatorCredentialGuard,
  parseOrchestratorClientInput,
  parseOrchestratorClientScopes,
  registerOrchestratorClientRoutes,
  revokeOrchestratorClient,
  touchOrchestratorClient,
  updateOrchestratorClientScopes,
  verifyOrchestratorClient
} from "./orchestratorClients.js";
import { createRedactor } from "./redaction.js";
import { Store, type State } from "./store.js";

const at = "2026-09-22T12:00:00.000Z";
const later = "2026-09-22T13:00:00.000Z";

const emptyState = (): State => ({
  agents: [], nodes: [], runs: [], events: [], messages: [], threads: [], orchestratorClients: []
} as unknown as State);

async function temporaryStore() {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-orchestrator-clients-"));
  const path = join(directory, "state.json");
  const store = new Store(path);
  await store.load();
  return { store, path };
}

test("mints a credential that returns its secret once and persists only a hash", () => {
  const state = emptyState();

  const { client, secret } = mintOrchestratorClient(state, { name: "Christian's laptop", scopes: ["orchestrate"] }, at);

  assert.equal(client.name, "Christian's laptop");
  assert.deepEqual(client.scopes, ["orchestrate"]);
  assert.equal(client.createdAt, at);
  assert.equal(client.revokedAt, undefined);
  assert.ok(secret.startsWith(`csoc_${client.id}_`), `secret names its client: ${secret}`);
  assert.ok(!JSON.stringify(client).includes("secretHash"), "the public view never carries the hash");
  const stored = state.orchestratorClients![0];
  assert.equal(stored.id, client.id);
  assert.ok(stored.secretHash.startsWith("sha256:"));
  assert.ok(!JSON.stringify(state).includes(secret), "the plaintext secret is never stored");
});

test("always grants the orchestrate scope and keeps scopes in their declared order without repeats", () => {
  const state = emptyState();

  const withoutOrchestrate = mintOrchestratorClient(state, { name: "Reviewer", scopes: ["resolve-approvals"] }, at);
  const repeated = mintOrchestratorClient(state, { name: "Repeater", scopes: ["resolve-approvals", "orchestrate", "resolve-approvals"] }, at);

  assert.deepEqual(withoutOrchestrate.client.scopes, ["orchestrate", "resolve-approvals"]);
  assert.deepEqual(repeated.client.scopes, ["orchestrate", "resolve-approvals"]);
});

test("mints, verifies, and lists every declared scope", () => {
  for (const scope of orchestratorClientScopes) {
    const state = emptyState();
    const { client, secret } = mintOrchestratorClient(state, { name: `Holder of ${scope}`, scopes: [scope] }, at);
    const verification = verifyOrchestratorClient(state, client.id, secret);

    assert.ok(verification.ok, `${scope} verifies`);
    assert.ok(verification.client.scopes.includes(scope), `${scope} survives the round trip`);
    assert.deepEqual(listOrchestratorClients(state), [verification.client]);
  }
});

test("rejects every failed verification identically, whatever failed", () => {
  const state = emptyState();
  const { client, secret } = mintOrchestratorClient(state, { name: "Laptop", scopes: ["orchestrate"] }, at);
  const other = mintOrchestratorClient(state, { name: "Other", scopes: ["orchestrate"] }, at);
  const unauthorized = { ok: false, reason: "unauthorized" } as const;

  assert.deepEqual(verifyOrchestratorClient(state, client.id, other.secret), unauthorized, "another client's secret");
  assert.deepEqual(verifyOrchestratorClient(state, "orchestrator-client-unknown", secret), unauthorized, "unknown client");
  assert.deepEqual(verifyOrchestratorClient(state, client.id, ""), unauthorized, "empty secret");
  assert.deepEqual(verifyOrchestratorClient(state, client.id, "not-a-credential"), unauthorized, "malformed secret");
  assert.deepEqual(verifyOrchestratorClient(state, client.id, `${secret}x`), unauthorized, "overlong secret");
  assert.deepEqual(verifyOrchestratorClient(state, client.id, secret.slice(0, -1)), unauthorized, "truncated secret");
  assert.deepEqual(verifyOrchestratorClient(state, client.id, `csoc_${other.client.id}_${secret.split("_")[2]}`), unauthorized, "secret naming another client");
  assert.deepEqual(verifyOrchestratorClient(state, client.id, secret.toUpperCase()), unauthorized, "case-folded secret");
  assert.ok(verifyOrchestratorClient(state, client.id, secret).ok, "the real secret still verifies");
});

test("compares a stored hash of any length without throwing", () => {
  const state = emptyState();
  const { client, secret } = mintOrchestratorClient(state, { name: "Laptop", scopes: ["orchestrate"] }, at);
  state.orchestratorClients![0].secretHash = "sha256:deadbeef";

  assert.deepEqual(verifyOrchestratorClient(state, client.id, secret), { ok: false, reason: "unauthorized" });
});

test("reports a revoked client only to the holder of its secret, and never un-revokes it", () => {
  const state = emptyState();
  const { client, secret } = mintOrchestratorClient(state, { name: "Laptop", scopes: ["orchestrate", "resolve-approvals"] }, at);

  const revocation = revokeOrchestratorClient(state, client.id, later);
  assert.equal(revocation.kind, "revoked");
  assert.deepEqual(verifyOrchestratorClient(state, client.id, secret), { ok: false, reason: "revoked" });
  assert.deepEqual(verifyOrchestratorClient(state, client.id, "not-a-credential"), { ok: false, reason: "unauthorized" }, "revocation is not disclosed to a stranger");

  const replay = revokeOrchestratorClient(state, client.id, "2026-09-23T13:00:00.000Z");
  assert.equal(replay.kind, "already-revoked");
  assert.equal(replay.kind === "already-revoked" ? replay.client.revokedAt : undefined, later, "the first revocation time stands");
  assert.equal(updateOrchestratorClientScopes(state, client.id, ["orchestrate"]).kind, "revoked", "a revoked credential cannot be re-scoped");
  assert.equal(touchOrchestratorClient(state, client.id, later), false, "a revoked credential is never touched");
  assert.equal(revokeOrchestratorClient(state, "orchestrator-client-unknown", later).kind, "not-found");
});

test("updates scopes on a live client and keeps orchestrate", () => {
  const state = emptyState();
  const { client } = mintOrchestratorClient(state, { name: "Laptop", scopes: ["orchestrate", "resolve-approvals"] }, at);

  const result = updateOrchestratorClientScopes(state, client.id, []);

  assert.equal(result.kind, "updated");
  assert.deepEqual(result.kind === "updated" ? result.client.scopes : [], ["orchestrate"]);
  assert.equal(updateOrchestratorClientScopes(state, "orchestrator-client-unknown", ["orchestrate"]).kind, "not-found");
});

test("records the last time a live client was seen", () => {
  const state = emptyState();
  const { client } = mintOrchestratorClient(state, { name: "Laptop", scopes: ["orchestrate"] }, at);

  assert.equal(touchOrchestratorClient(state, client.id, later), true);
  assert.equal(state.orchestratorClients![0].lastSeenAt, later);
  assert.equal(touchOrchestratorClient(state, client.id, later), false, "an unchanged timestamp is not a change");
  assert.equal(touchOrchestratorClient(state, "orchestrator-client-unknown", later), false);
});

test("rejects credential input the hub cannot interpret", () => {
  const cases: Array<[string, unknown]> = [
    ["not an object", "Laptop"],
    ["unknown field", { name: "Laptop", scopes: ["orchestrate"], secret: "mine" }],
    ["missing name", { scopes: ["orchestrate"] }],
    ["empty name", { name: "", scopes: [] }],
    ["blank name", { name: "   ", scopes: [] }],
    ["overlong name", { name: "n".repeat(65), scopes: [] }],
    ["control character in name", { name: "Laptop\u0007", scopes: [] }],
    ["newline in name", { name: "Laptop\nReviewer", scopes: [] }],
    ["scopes not an array", { name: "Laptop", scopes: "orchestrate" }],
    ["unknown scope", { name: "Laptop", scopes: ["orchestrate", "administer"] }],
    ["non-string scope", { name: "Laptop", scopes: [1] }]
  ];
  for (const [reason, value] of cases) {
    assert.equal(parseOrchestratorClientInput(value).ok, false, reason);
  }

  const accepted = parseOrchestratorClientInput({ name: "Christian's laptop", scopes: ["resolve-approvals"] });
  assert.deepEqual(accepted, { ok: true, value: { name: "Christian's laptop", scopes: ["orchestrate", "resolve-approvals"] } });
  assert.deepEqual(parseOrchestratorClientInput({ name: "Laptop" }), { ok: true, value: { name: "Laptop", scopes: ["orchestrate"] } }, "absent scopes grant the least authority");
  assert.equal(parseOrchestratorClientScopes({ scopes: ["administer"] }).ok, false);
  assert.equal(parseOrchestratorClientScopes({ scopes: ["orchestrate"], name: "Laptop" }).ok, false, "a scope change carries only scopes");
  assert.deepEqual(parseOrchestratorClientScopes({ scopes: [] }), { ok: true, value: ["orchestrate"] });
});

test("notifies revocation listeners once per revocation and survives a failing listener", () => {
  const revocations = createOrchestratorClientRevocations();
  const seen: string[] = [];
  const unsubscribe = revocations.onOrchestratorClientRevoked(() => { throw new Error("listener failed"); });
  revocations.onOrchestratorClientRevoked((clientId) => seen.push(clientId));

  revocations.notifyOrchestratorClientRevoked("orchestrator-client-one");
  unsubscribe();
  revocations.notifyOrchestratorClientRevoked("orchestrator-client-two");

  assert.deepEqual(seen, ["orchestrator-client-one", "orchestrator-client-two"]);
});

test("redacts a minted secret from harness text", () => {
  const state = emptyState();
  const { secret } = mintOrchestratorClient(state, { name: "Laptop", scopes: ["orchestrate"] }, at);
  const redactor = createRedactor([]);

  const redacted = redactor.redact(`connecting with ${secret} now`);

  assert.equal(redacted, "connecting with [redacted] now");
  assert.ok(redactor.containsSecret(secret));
});

/*
 * The persisted state file is the hub's real external input: `apps/hub/src/store.ts:546`
 * (`private async save`) writes it, and `Store.load` reads it back. A credential minted through
 * this module must still verify after that byte-for-byte round trip, with no plaintext on disk.
 */
test("verifies a credential again after it is persisted and reloaded", async () => {
  const { store, path } = await temporaryStore();
  let minted: MintedOrchestratorClient | undefined;
  await store.transact((state) => {
    minted = mintOrchestratorClient(state, { name: "Christian's laptop", scopes: ["resolve-approvals"] }, at);
  });
  assert.ok(minted, "the credential was minted");
  const credential = minted;

  const persisted = await readFile(path, "utf8");
  assert.ok(!persisted.includes(credential.secret), "the persisted file never carries the plaintext secret");
  const reloaded = new Store(path);
  await reloaded.load();

  const verification = reloaded.read((state) => verifyOrchestratorClient(state, credential.client.id, credential.secret));
  assert.ok(verification.ok);
  assert.deepEqual(verification.client.scopes, ["orchestrate", "resolve-approvals"]);
  assert.ok(!JSON.stringify(reloaded.snapshot()).includes("secretHash"), "the snapshot never carries the hash");
});

async function withOperatorApi(run: (api: {
  request: (method: string, path: string, options?: { body?: unknown; token?: string | null }) => Promise<{ status: number; body: any }>;
  store: Store;
  revoked: string[];
  broadcasts: () => number;
}) => Promise<void>) {
  const previousEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const { store } = await temporaryStore();
  const revocations = createOrchestratorClientRevocations();
  const revoked: string[] = [];
  revocations.onOrchestratorClientRevoked((clientId) => revoked.push(clientId));
  let broadcasts = 0;
  const app = express();
  app.use(express.json());
  app.use(operatorCredentialGuard("operator-token"));
  registerOrchestratorClientRoutes(app, { store, broadcast: () => { broadcasts += 1; }, revocations });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const request = async (method: string, path: string, options: { body?: unknown; token?: string | null } = {}) => {
    const token = options.token === undefined ? "operator-token" : options.token;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(options.body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    });
    return { status: response.status, body: await response.json().catch(() => undefined) };
  };
  try {
    await run({ request, store, revoked, broadcasts: () => broadcasts });
  } finally {
    server.close();
    await once(server, "close");
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
  }
}

test("mints, lists, re-scopes, and revokes a credential over the operator API", async () => {
  await withOperatorApi(async ({ request, store, revoked, broadcasts }) => {
    const minted = await request("POST", "/api/orchestrator-clients", { body: { name: "Christian's laptop", scopes: ["resolve-approvals"] } });
    assert.equal(minted.status, 201);
    assert.deepEqual(minted.body.client.scopes, ["orchestrate", "resolve-approvals"]);
    assert.ok(minted.body.secret.startsWith(`csoc_${minted.body.client.id}_`));
    assert.equal(minted.body.client.secretHash, undefined);
    assert.equal(broadcasts(), 1, "operators watching the snapshot see the new credential");
    const clientId: string = minted.body.client.id;

    const listed = await request("GET", "/api/orchestrator-clients");
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.clients.map((client: any) => client.id), [clientId]);
    assert.ok(!JSON.stringify(listed.body).includes("secretHash"), "the list never carries the hash");
    assert.ok(!JSON.stringify(listed.body).includes("csoc_"), "the secret is returned exactly once");

    const rescoped = await request("PATCH", `/api/orchestrator-clients/${clientId}`, { body: { scopes: [] } });
    assert.equal(rescoped.status, 200);
    assert.deepEqual(rescoped.body.client.scopes, ["orchestrate"]);

    const revokedResponse = await request("POST", `/api/orchestrator-clients/${clientId}/revoke`);
    assert.equal(revokedResponse.status, 200);
    assert.equal(typeof revokedResponse.body.client.revokedAt, "string");
    assert.deepEqual(revoked, [clientId], "the gateway is told to close live sockets");

    const rescopedAfterRevocation = await request("PATCH", `/api/orchestrator-clients/${clientId}`, { body: { scopes: ["resolve-approvals"] } });
    assert.equal(rescopedAfterRevocation.status, 409);
    assert.deepEqual(
      store.read((state) => state.orchestratorClients!.map((client) => client.scopes)),
      [["orchestrate"]],
      "a revoked credential keeps the scopes it had"
    );

    const replayedRevocation = await request("POST", `/api/orchestrator-clients/${clientId}/revoke`);
    assert.equal(replayedRevocation.status, 200);
    assert.equal(replayedRevocation.body.client.revokedAt, revokedResponse.body.client.revokedAt);
  });
});

test("refuses operator requests the hub cannot interpret", async () => {
  await withOperatorApi(async ({ request }) => {
    for (const body of [{}, { name: "" }, { name: "Laptop", scopes: ["administer"] }, { name: "Laptop", secret: "mine" }, ["Laptop"]]) {
      const response = await request("POST", "/api/orchestrator-clients", { body });
      assert.equal(response.status, 422, JSON.stringify(body));
      assert.equal(typeof response.body.error, "string");
    }
    const minted = await request("POST", "/api/orchestrator-clients", { body: { name: "Laptop", scopes: [] } });
    const clientId: string = minted.body.client.id;

    assert.equal((await request("PATCH", `/api/orchestrator-clients/${clientId}`, { body: { scopes: ["administer"] } })).status, 422);
    assert.equal((await request("PATCH", `/api/orchestrator-clients/${clientId}`, { body: { name: "Renamed" } })).status, 422);
    assert.equal((await request("PATCH", "/api/orchestrator-clients/orchestrator-client-unknown", { body: { scopes: [] } })).status, 404);
    assert.equal((await request("POST", "/api/orchestrator-clients/orchestrator-client-unknown/revoke")).status, 404);
  });
});

test("keeps the operator API behind the hub token", async () => {
  await withOperatorApi(async ({ request }) => {
    for (const token of [null, "wrong-token", ""]) {
      const response = await request("POST", "/api/orchestrator-clients", { body: { name: "Laptop", scopes: [] }, token });
      assert.equal(response.status, 401, `token ${JSON.stringify(token)}`);
    }
    assert.equal((await request("GET", "/api/orchestrator-clients", { token: null })).status, 401);
    assert.equal((await request("PATCH", "/api/orchestrator-clients/any", { body: { scopes: [] }, token: null })).status, 401);
    assert.equal((await request("POST", "/api/orchestrator-clients/any/revoke", { token: null })).status, 401);
  });
});

test("guards every api route but health, and only when the hub runs in production", async () => {
  const previousEnvironment = process.env.NODE_ENV;
  const app = express();
  app.use(operatorCredentialGuard("operator-token"));
  app.get("/api/health", (_request, response) => { response.json({ ok: true }); });
  app.get("/api/secrets", (_request, response) => { response.json({ ok: true }); });
  app.put("/api/artifacts/:id/content", (_request, response) => { response.status(204).end(); });
  app.get("/api/artifacts/:id/content", (_request, response) => { response.json({ ok: true }); });
  app.get("/public", (_request, response) => { response.json({ ok: true }); });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const status = async (path: string, headers: Record<string, string> = {}) => (await fetch(`http://127.0.0.1:${port}${path}`, { headers })).status;
  try {
    process.env.NODE_ENV = "production";
    assert.equal(await status("/api/health"), 200, "health stays reachable for liveness checks");
    assert.equal(await status("/public"), 200, "non-api routes are not guarded");
    assert.equal(await status("/api/secrets"), 401);
    assert.equal(await status("/api/secrets", { authorization: "Bearer operator-token" }), 200);
    assert.equal(await status("/api/secrets?token=operator-token"), 200, "the query token stays supported");
    assert.equal(await status("/api/artifacts/artifact-one/content", { authorization: "Bearer one-time-grant" }), 401,
      "a grant never authorizes artifact reads");
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/artifacts/artifact-one/content`, {
      method: "PUT", headers: { authorization: "Bearer one-time-grant" }
    })).status, 204, "only the exact upload route delegates bearer authorization to its handler");
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/artifacts/artifact-one/content?token=one-time-grant`, {
      method: "PUT"
    })).status, 401, "an upload grant in the query is refused before the route");
    process.env.NODE_ENV = "development";
    assert.equal(await status("/api/secrets"), 200, "development keeps working without a token");
  } finally {
    server.close();
    await once(server, "close");
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
  }
});

test("refuses every api request in production when no hub token is configured", async () => {
  const previousEnvironment = process.env.NODE_ENV;
  const app = express();
  app.use(operatorCredentialGuard(undefined));
  app.get("/api/secrets", (_request, response) => { response.json({ ok: true }); });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    process.env.NODE_ENV = "production";
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/secrets`);
    assert.equal(response.status, 401);
    assert.equal(port, (server.address() as AddressInfo).port);
  } finally {
    server.close();
    await once(server, "close");
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
  }
});

test("never publishes a scope the protocol does not declare", () => {
  const state = emptyState();
  const { client } = mintOrchestratorClient(state, { name: "Laptop", scopes: [...orchestratorClientScopes] }, at);
  assert.ok(client.scopes.every((scope) => orchestratorClientScopes.includes(scope)));
  assert.equal(new Set(client.scopes).size, client.scopes.length, "scopes are never repeated");
});
