import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Artifact } from "@coffee-shop/protocol";
import {
  artifactUploadGrantLifetimeMilliseconds,
  claimArtifactUploadGrant,
  issueArtifactUploadGrantInState
} from "./artifactUploadGrants.js";
import { mintOrchestratorClient, revokeOrchestratorClient } from "./orchestratorClients.js";
import { Store } from "./store.js";

const at = "2026-09-28T12:00:00.000Z";
const later = (milliseconds: number) => new Date(Date.parse(at) + milliseconds).toISOString();

const artifact: Artifact = {
  id: "artifact-one",
  threadId: "thread-one",
  sourceKey: "orchestrator-client:client-one",
  relativePath: "reports/result.txt",
  title: "Result",
  kind: "report",
  mediaType: "text/plain",
  summary: "Ready",
  size: 5,
  sha256: "a".repeat(64),
  downloadPath: "/api/artifacts/artifact-one/content",
  uploaded: false,
  idempotencyKey: "result-one",
  createdAt: at
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-upload-grant-"));
  const path = join(directory, "state.json");
  const store = new Store(path);
  await store.load();
  let clientId = "";
  await store.transact((state) => {
    const minted = mintOrchestratorClient(state, { name: "Laptop", scopes: ["orchestrate"] }, at);
    clientId = minted.client.id;
    state.artifacts = [{ ...artifact, sourceKey: `orchestrator-client:${clientId}` }];
  });
  return { store, path, clientId };
}

test("issues a five-minute, 32-byte one-time bearer while persisting only its digest", async () => {
  const { store, path, clientId } = await fixture();
  let grant!: ReturnType<typeof issueArtifactUploadGrantInState>;
  await store.transact((state) => {
    grant = issueArtifactUploadGrantInState(state, state.artifacts![0]!, clientId, at, () => Buffer.alloc(32, 7));
  });
  assert.deepEqual(grant, {
    path: "/api/artifacts/artifact-one/content",
    token: Buffer.alloc(32, 7).toString("base64url"),
    expiresAt: later(artifactUploadGrantLifetimeMilliseconds)
  });
  const persisted = await readFile(path, "utf8");
  assert.doesNotMatch(persisted, new RegExp(grant.token));
  assert.doesNotMatch(JSON.stringify(store.snapshot()), new RegExp(grant.token));
  assert.equal("artifactUploadGrants" in store.snapshot(), false, "the hub-only collection is never published");
  const records = store.read((state) => structuredClone(state.artifactUploadGrants));
  assert.equal(records?.length, 1);
  assert.match(records![0]!.tokenDigest, /^[a-f0-9]{64}$/);
  assert.equal("token" in records![0]!, false);
  const reloaded = new Store(path);
  await reloaded.load();
  assert.equal(await readFile(path, "utf8"), persisted, "state from the grant producer loads byte-for-byte");
  assert.equal(await claimArtifactUploadGrant(reloaded, artifact.id, grant.token, later(1)), true);
  assert.equal(await claimArtifactUploadGrant(reloaded, artifact.id, grant.token, later(2)), false, "a bearer is consumed before body ingestion");
});

test("wrong-artifact, expiry, and revocation refusals are indistinguishable and do not mutate content truth", async () => {
  for (const scenario of ["wrong-artifact", "expired", "revoked"] as const) {
    const { store, clientId } = await fixture();
    let token = "";
    await store.transact((state) => {
      token = issueArtifactUploadGrantInState(state, state.artifacts![0]!, clientId, at, () => Buffer.alloc(32, 9)).token;
      if (scenario === "revoked") revokeOrchestratorClient(state, clientId, later(1));
    });
    const artifactId = scenario === "wrong-artifact" ? "artifact-another" : artifact.id;
    const claimAt = scenario === "expired" ? later(artifactUploadGrantLifetimeMilliseconds) : later(2);
    assert.equal(await claimArtifactUploadGrant(store, artifactId, token, claimAt), false, scenario);
    assert.equal(store.snapshot().artifacts![0]!.uploaded, false);
    const record = store.read((state) => state.artifactUploadGrants![0]!);
    assert.equal(record.consumedAt, undefined, scenario);
    if (scenario === "revoked") assert.equal(record.revokedAt, later(1));
  }
});

test("refreshing an unuploaded replay revokes the old grant, and concurrent claims have one winner", async () => {
  const { store, clientId } = await fixture();
  let first = "";
  let second = "";
  await store.transact((state) => {
    first = issueArtifactUploadGrantInState(state, state.artifacts![0]!, clientId, at, () => Buffer.alloc(32, 1)).token;
    second = issueArtifactUploadGrantInState(state, state.artifacts![0]!, clientId, later(1), () => Buffer.alloc(32, 2)).token;
  });
  assert.equal(store.read((state) => state.artifactUploadGrants?.length), 1, "an exact replay retains only its fresh authority");
  assert.equal(await claimArtifactUploadGrant(store, artifact.id, first, later(2)), false);
  const claims = await Promise.all(Array.from({ length: 8 }, () => claimArtifactUploadGrant(store, artifact.id, second, later(3))));
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(store.snapshot().artifacts![0]!.uploaded, false, "claiming transport authority never infers upload success");
});

test("issuance prunes consumed, revoked, and expired grants while retaining live unrelated authority", async () => {
  const { store, clientId } = await fixture();
  const token = async (fill: number, artifactId: string, atValue: string) => {
    let issued = "";
    await store.transact((state) => {
      const base = state.artifacts![0]!;
      const candidate = {
        ...base,
        id: artifactId,
        downloadPath: `/api/artifacts/${artifactId}/content`,
        idempotencyKey: artifactId,
        createdAt: atValue
      };
      state.artifacts!.push(candidate);
      issued = issueArtifactUploadGrantInState(state, candidate, clientId, atValue, () => Buffer.alloc(32, fill)).token;
    });
    return issued;
  };

  const consumed = await token(11, "artifact-consumed", at);
  assert.equal(await claimArtifactUploadGrant(store, "artifact-consumed", consumed, later(1)), true);
  await token(12, "artifact-revoked", later(2));
  await store.transact((state) => {
    const record = state.artifactUploadGrants!.find((grant) => grant.artifactId === "artifact-revoked")!;
    record.revokedAt = later(3);
  });
  await token(13, "artifact-expired", at);
  const live = await token(14, "artifact-live", later(artifactUploadGrantLifetimeMilliseconds - 1));
  await token(15, "artifact-new", later(artifactUploadGrantLifetimeMilliseconds));

  const records = store.read((state) => structuredClone(state.artifactUploadGrants));
  assert.deepEqual(records?.map((grant) => grant.artifactId).sort(), ["artifact-live", "artifact-new"]);
  assert.equal(await claimArtifactUploadGrant(store, "artifact-consumed", consumed, later(artifactUploadGrantLifetimeMilliseconds + 1)), false);
  assert.equal(await claimArtifactUploadGrant(store, "artifact-live", live, later(artifactUploadGrantLifetimeMilliseconds + 1)), true);
});

test("persisted grant state rejects plaintext, corrupt lifecycle, and duplicate active authority", async () => {
  const cases: Array<[string, (state: any) => void]> = [
    ["plaintext token", (state) => { state.artifactUploadGrants[0].token = "exposed"; }],
    ["wrong expiry", (state) => { state.artifactUploadGrants[0].expiresAt = later(1); }],
    ["duplicate active grant", (state) => {
      state.artifactUploadGrants.push({ ...state.artifactUploadGrants[0], tokenDigest: "b".repeat(64) });
    }]
  ];
  for (const [name, mutate] of cases) {
    const { store, path, clientId } = await fixture();
    await store.transact((state) => {
      issueArtifactUploadGrantInState(state, state.artifacts![0]!, clientId, at, () => Buffer.alloc(32, 3));
    });
    const persisted = JSON.parse(await readFile(path, "utf8"));
    mutate(persisted);
    const bytes = `${JSON.stringify(persisted, null, 2)}\n`;
    await writeFile(path, bytes);
    const reloaded = new Store(path);
    await assert.rejects(reloaded.load(), /artifact upload grant/i, name);
    assert.equal(await readFile(path, "utf8"), bytes, `${name} was not rewritten`);
  }
});
