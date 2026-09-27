import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  artifactPreviewFailureCodes,
  previewBundleArtifactKind,
  previewBundleContract,
  previewBundleMediaType,
  type Agent,
  type Run
} from "@coffee-shop/protocol";
import {
  beginProcessing,
  expireDuePreviews,
  failPreview,
  registerPreview,
  renewPreview,
  settleProcessing
} from "./artifactPreviews.js";
import { templateFromLegacyAgent } from "./agentTemplates.js";
import { CoordinationError, createArtifact } from "./coordination.js";
import { addArtifactPreviewDefaults, Store, type State } from "./store.js";

const at = "2026-09-27T12:00:00.000Z";
const after = (seconds: number) => new Date(Date.parse(at) + seconds * 1_000).toISOString();

const agent: Agent = {
  id: "publisher", name: "Publisher", title: "Publisher", summary: "", glyph: "P",
  avatarShape: "cup", avatarColor: "amber", state: "working", currentAction: "Publishing",
  harnessId: "codex-cli", model: "default", computeNodeId: "node-one", workspace: "/workspace/publisher",
  systemPrompt: "Publish carefully", canDelegate: true, unread: 0, updatedAt: at
};

const sourceRun: Run = {
  id: "run-source", threadId: "thread-one", agentId: agent.id, nodeId: "node-one", harnessId: "codex-cli",
  model: "default", workspace: "/workspace/publisher", prompt: "Publish the preview", status: "running",
  output: "", depth: 0, createdAt: at, startedAt: at
};

const request = {
  relativePath: ".coffee-shop/previews/site.tar.gz",
  title: "Site preview",
  kind: previewBundleArtifactKind,
  mediaType: previewBundleMediaType,
  summary: "Static site",
  size: 512,
  sha256: "a".repeat(64),
  entrypoint: "site/index.html",
  ttlSeconds: 24 * 60 * 60,
  idempotencyKey: "preview-one"
};

type StoreKind = "json" | "sqlite";

async function previewStore(kind: StoreKind = "json") {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-preview-"));
  const path = join(directory, kind === "json" ? "state.json" : "coffee-shop.sqlite");
  const store = kind === "json"
    ? new Store(path)
    : new Store({ databasePath: path, legacyJsonPath: join(directory, "absent-legacy.json") });
  await store.load();
  await store.transact((state) => {
    const imported = templateFromLegacyAgent(agent);
    assert.equal(imported.ok, true);
    state.agents = [structuredClone(agent)];
    state.threads = [{
      id: "thread-one", title: "Preview", objective: "Publish the preview", summary: "", status: "active",
      ownerAgentId: agent.id, orchestrator: { kind: "agent", agentId: agent.id }, createdBy: "user",
      createdAt: at, updatedAt: at
    }];
    state.runs = [structuredClone(sourceRun)];
    state.templates = [structuredClone(imported.template)];
    state.legacyTemplateImports = [{ agentId: agent.id, templateId: imported.template.id, at }];
  });
  return { store, path, directory };
}

const errorCode = (code: string) => (error: unknown) => error instanceof CoordinationError && error.code === code;

async function markUploaded(store: Store, artifactId: string) {
  await store.transact((state) => {
    const artifact = state.artifacts?.find((item) => item.id === artifactId);
    assert.ok(artifact);
    artifact.uploaded = true;
  });
}

test("dedicated registration atomically creates one artifact, preview, event, and private receipt", async () => {
  const { store, path } = await previewStore();
  const result = await registerPreview(store, sourceRun.id, request, at);

  assert.equal(result.created, true);
  assert.equal(result.artifact.kind, previewBundleArtifactKind);
  assert.equal(result.artifact.mediaType, previewBundleMediaType);
  assert.equal(result.artifact.uploaded, false);
  assert.equal(result.preview.status, "upload-pending");
  assert.equal(result.preview.processingGeneration, 0);
  assert.equal(result.preview.entrypoint, request.entrypoint);
  assert.equal(result.preview.artifactId, result.artifact.id);
  assert.equal(result.preview.artifactSha256, result.artifact.sha256);
  assert.equal(result.preview.accessState, "unavailable");
  assert.equal(result.uploadPath, result.artifact.downloadPath);

  store.read((state) => {
    assert.equal(state.artifacts?.length, 1);
    assert.equal(state.artifactPreviews?.length, 1);
    assert.equal(state.previewRegistrationReceipts?.length, 1);
    assert.equal(state.previewProcessingReceipts?.length, 0);
    assert.equal(state.events.filter((event) => event.title === "Preview registered").length, 1);
    const receipt = state.previewRegistrationReceipts![0];
    assert.equal(receipt.artifactId, result.artifact.id);
    assert.equal(receipt.previewId, result.preview.id);
    assert.match(receipt.digest, /^[a-f0-9]{64}$/);
  });
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.artifactPreviews[0].accessState, undefined, "derived access is not persisted");
  assert.equal(persisted.artifactPreviews[0].signedUrl, undefined);

  const snapshot = store.snapshot(after(1));
  assert.equal(snapshot.artifactPreviews?.[0].accessState, "unavailable");
  assert.ok(!("previewRegistrationReceipts" in snapshot));
  assert.ok(!("previewProcessingReceipts" in snapshot));
  assert.doesNotMatch(JSON.stringify(snapshot), /signedUrl|bearer|token/i);
});

test("registration replays across JSON and SQLite restarts and conflicts without mutation", async () => {
  for (const kind of ["json", "sqlite"] as const) {
    const { store, path, directory } = await previewStore(kind);
    const first = await registerPreview(store, sourceRun.id, request, at);
    const restarted = kind === "json"
      ? new Store(path)
      : new Store({ databasePath: path, legacyJsonPath: join(directory, "absent-legacy.json") });
    await restarted.load();
    const before = kind === "json" ? await readFile(path) : undefined;

    const replay = await registerPreview(restarted, sourceRun.id, request, after(60));
    assert.equal(replay.created, false, kind);
    assert.equal(replay.artifact.id, first.artifact.id, kind);
    assert.equal(replay.preview.id, first.preview.id, kind);
    assert.equal(replay.preview.createdAt, at, kind);
    assert.equal(restarted.read((state) => state.previewRegistrationReceipts?.length), 1, kind);
    if (before) assert.deepEqual(await readFile(path), before, "an exact JSON replay writes nothing");

    for (const conflict of [
      { ...request, title: "Other title" },
      { ...request, summary: "Other summary" },
      { ...request, entrypoint: "other/index.html" },
      { ...request, ttlSeconds: 60 * 60 }
    ]) {
      await assert.rejects(registerPreview(restarted, sourceRun.id, conflict, after(120)), errorCode("idempotency_conflict"), kind);
    }
    assert.equal(restarted.snapshot().artifacts?.length, 1, kind);
    assert.equal(restarted.snapshot().artifactPreviews?.length, 1, kind);
  }
});

test("registration validates dedicated metadata, path, limits, TTL, and live caller authority before mutation", async () => {
  const invalid: Array<[string, Record<string, unknown>]> = [
    ["wrong kind", { ...request, kind: "report" }],
    ["wrong media", { ...request, mediaType: "application/gzip" }],
    ["empty bundle", { ...request, size: 0 }],
    ["compressed limit", { ...request, size: previewBundleContract.maximumCompressedBytes + 1 }],
    ["digest", { ...request, sha256: "A".repeat(64) }],
    ["artifact path", { ...request, relativePath: "../site.tar.gz" }],
    ["entrypoint traversal", { ...request, entrypoint: "../index.html" }],
    ["entrypoint extension", { ...request, entrypoint: "site/index.htm" }],
    ["entrypoint NFC", { ...request, entrypoint: "cafe\u0301/index.html" }],
    ["minimum TTL", { ...request, ttlSeconds: previewBundleContract.minimumTtlSeconds - 1 }],
    ["maximum TTL", { ...request, ttlSeconds: previewBundleContract.maximumLifetimeSeconds + 1 }],
    ["integer TTL", { ...request, ttlSeconds: 300.5 }],
    ["unknown field", { ...request, signedUrl: "https://preview.invalid/secret" }]
  ];
  for (const [name, input] of invalid) {
    const { store } = await previewStore();
    await assert.rejects(registerPreview(store, sourceRun.id, input, at), errorCode("invalid_arguments"), name);
    assert.equal(store.snapshot().artifacts?.length, 0, name);
    assert.equal(store.snapshot().artifactPreviews?.length, 0, name);
    assert.equal(store.read((state) => state.previewRegistrationReceipts?.length), 0, name);
  }

  for (const [name, mutate] of [
    ["inactive run", (state: State) => { state.runs[0].status = "completed"; }],
    ["inactive thread", (state: State) => { state.threads![0].status = "completed"; }],
    ["missing actor", (state: State) => { state.agents = []; }]
  ] as const) {
    const { store } = await previewStore();
    await store.transact(mutate);
    await assert.rejects(registerPreview(store, sourceRun.id, request, at), CoordinationError, name);
    assert.equal(store.snapshot().artifacts?.length, 0, name);
  }
});

test("instance registration keeps the exact resident/allocation actor and a replaced allocation loses authority", async () => {
  const { store } = await previewStore();
  await store.transact((state) => {
    state.agents = [];
    delete state.threads![0].ownerAgentId;
    state.threads![0].orchestrator = { kind: "instance", instanceId: "instance-one" };
    delete state.runs[0].agentId;
    state.runs[0].instanceId = "instance-one";
    state.runs[0].allocationId = "allocation-one";
    state.instances = [{
      id: "instance-one", threadId: "thread-one", creator: { kind: "operator", operatorId: "operator" },
      delegation: { canDelegate: true }, requirements: {},
      lease: { idleTimeoutSeconds: 1_800, expiresAt: after(3_600) }, status: "busy", createdAt: at, updatedAt: at
    }];
    state.allocations = [{
      id: "allocation-one", instanceId: "instance-one", nodeId: "node-one", harnessId: "codex-cli",
      model: "default", transport: "native-cli", workspace: "/workspace/publisher",
      lease: { idleTimeoutSeconds: 1_800, expiresAt: after(3_600) }, status: "active", createdAt: at, updatedAt: at
    }];
  });

  const registered = await registerPreview(store, sourceRun.id, request, at);
  assert.equal(registered.artifact.agentId, undefined);
  assert.equal(registered.preview.agentId, undefined);
  assert.equal(registered.preview.instanceId, "instance-one");
  assert.equal(registered.preview.allocationId, "allocation-one");

  await store.transact((state) => { state.allocations![0].status = "lost"; });
  await assert.rejects(
    registerPreview(store, sourceRun.id, { ...request, idempotencyKey: "replaced-allocation" }, after(60)),
    errorCode("forbidden")
  );
  assert.equal(store.snapshot().artifacts?.length, 1);
});

test("ordinary artifact registration preserves its six kinds and cannot mint a preview bundle", async () => {
  const { store } = await previewStore();
  await assert.rejects(createArtifact(store, sourceRun.id, request, at), errorCode("invalid_arguments"));
  assert.equal(store.snapshot().artifacts?.length, 0);
  const ordinary = await createArtifact(store, sourceRun.id, {
    relativePath: "reports/result.json", title: "Results", kind: "report", mediaType: "application/json",
    size: 2, sha256: "b".repeat(64), idempotencyKey: "ordinary"
  }, at);
  assert.equal(ordinary.artifact.kind, "report");
  assert.equal(store.snapshot().artifactPreviews?.length, 0);
});

test("processing requires exact uploaded bytes, advances generations, and settles idempotently", async () => {
  const { store, path } = await previewStore();
  const registered = await registerPreview(store, sourceRun.id, request, at);
  await assert.rejects(beginProcessing(store, registered.preview.id, after(30)), errorCode("artifact_not_uploaded"));
  assert.equal(store.snapshot().artifactPreviews?.[0].status, "upload-pending");

  await markUploaded(store, registered.artifact.id);
  const first = await beginProcessing(store, registered.preview.id, after(60));
  assert.equal(first.replayed, false);
  assert.equal(first.preview.status, "processing");
  assert.equal(first.preview.processingGeneration, 1);
  const processingBytes = await readFile(path);
  const beginReplay = await beginProcessing(store, registered.preview.id, after(90));
  assert.equal(beginReplay.replayed, true);
  assert.equal(beginReplay.preview.updatedAt, after(60));
  assert.deepEqual(await readFile(path), processingBytes, "begin replay writes nothing");

  const settlement = {
    previewId: registered.preview.id,
    artifactId: registered.artifact.id,
    artifactSha256: registered.artifact.sha256,
    processingGeneration: 1,
    outcome: "ready",
    at: after(120)
  };
  for (const [name, changed] of [
    ["artifact", { ...settlement, artifactId: "artifact-other" }],
    ["digest", { ...settlement, artifactSha256: "b".repeat(64) }],
    ["stale generation", { ...settlement, processingGeneration: 0 }],
    ["future generation", { ...settlement, processingGeneration: 2 }],
    ["ready failure code", { ...settlement, failureCode: "bundle-invalid" }],
    ["unknown outcome", { ...settlement, outcome: "published" }]
  ] as const) {
    await assert.rejects(settleProcessing(store, changed), CoordinationError, name);
    assert.equal(store.snapshot().artifactPreviews?.[0].status, "processing", name);
  }

  const settled = await settleProcessing(store, settlement);
  assert.equal(settled.replayed, false);
  assert.equal(settled.preview.status, "ready");
  assert.equal(settled.preview.readyAt, after(120));
  assert.equal(settled.preview.accessState, "eligible");
  assert.equal(store.read((state) => state.previewProcessingReceipts?.length), 1);
  const settledBytes = await readFile(path);
  const replay = await settleProcessing(store, { ...settlement, at: after(180) });
  assert.equal(replay.replayed, true, "timestamps are non-semantic replay metadata");
  assert.equal(replay.preview.readyAt, after(120), "the first settlement timestamp remains authoritative");
  assert.deepEqual(await readFile(path), settledBytes);
  await assert.rejects(settleProcessing(store, {
    ...settlement, outcome: "failed", failureCode: "bundle-invalid", at: after(180)
  }), errorCode("idempotency_conflict"));
});

test("failed previews retry with a fresh generation and stale or future results cannot alter it", async () => {
  const { store } = await previewStore();
  const registered = await registerPreview(store, sourceRun.id, request, at);
  await markUploaded(store, registered.artifact.id);
  await beginProcessing(store, registered.preview.id, after(60));
  const failed = await settleProcessing(store, {
    previewId: registered.preview.id, artifactId: registered.artifact.id,
    artifactSha256: registered.artifact.sha256, processingGeneration: 1,
    outcome: "failed", failureCode: "bundle-invalid", at: after(120)
  });
  assert.equal(failed.preview.status, "failed");

  const retried = await beginProcessing(store, registered.preview.id, after(180));
  assert.equal(retried.preview.status, "processing");
  assert.equal(retried.preview.processingGeneration, 2);
  assert.equal(retried.preview.failedAt, undefined);
  assert.equal(retried.preview.failureCode, undefined);

  const stateBefore = JSON.stringify(store.snapshot(after(181)));
  await assert.rejects(settleProcessing(store, {
    previewId: registered.preview.id, artifactId: registered.artifact.id,
    artifactSha256: registered.artifact.sha256, processingGeneration: 1,
    outcome: "ready", at: after(200)
  }), errorCode("idempotency_conflict"));
  await assert.rejects(settleProcessing(store, {
    previewId: registered.preview.id, artifactId: registered.artifact.id,
    artifactSha256: registered.artifact.sha256, processingGeneration: 3,
    outcome: "ready", at: after(200)
  }), errorCode("generation_mismatch"));
  assert.equal(JSON.stringify(store.snapshot(after(181))), stateBefore);

  const ready = await settleProcessing(store, {
    previewId: registered.preview.id, artifactId: registered.artifact.id,
    artifactSha256: registered.artifact.sha256, processingGeneration: 2,
    outcome: "ready", at: after(240)
  });
  assert.equal(ready.preview.status, "ready");
  assert.equal(store.read((state) => state.previewProcessingReceipts?.length), 2);
});

test("pending failure and every closed failure code remain explicit and retry only after upload", async () => {
  for (const [index, failureCode] of artifactPreviewFailureCodes.entries()) {
    const { store } = await previewStore();
    const registered = await registerPreview(store, sourceRun.id, { ...request, idempotencyKey: `failure-${index}` }, at);
    const failed = await failPreview(store, registered.preview.id, failureCode, after(30));
    assert.equal(failed.replayed, false, failureCode);
    assert.equal(failed.preview.status, "failed", failureCode);
    assert.equal(failed.preview.processingGeneration, 0, failureCode);
    assert.equal(failed.preview.failureCode, failureCode, failureCode);
    assert.equal((await failPreview(store, registered.preview.id, failureCode, after(60))).replayed, true, failureCode);
    await assert.rejects(beginProcessing(store, registered.preview.id, after(90)), errorCode("artifact_not_uploaded"), failureCode);
    await markUploaded(store, registered.artifact.id);
    assert.equal((await beginProcessing(store, registered.preview.id, after(120))).preview.processingGeneration, 1, failureCode);
  }
});

test("renewal and expiry are serialized, bounded, terminal-safe, and fail closed at exact boundaries", async () => {
  const { store } = await previewStore();
  const shortRequest = { ...request, ttlSeconds: 300 };
  const registered = await registerPreview(store, sourceRun.id, shortRequest, at);
  assert.equal(registered.preview.expiresAt, after(300));
  await assert.rejects(renewPreview(store, registered.preview.id, 300, at), errorCode("expiry_not_extended"));

  const pendingRenewal = await renewPreview(store, registered.preview.id, 300, after(60));
  assert.equal(pendingRenewal.expiresAt, after(360));
  assert.equal(pendingRenewal.status, "upload-pending");
  await markUploaded(store, registered.artifact.id);
  await beginProcessing(store, registered.preview.id, after(90));
  assert.equal((await renewPreview(store, registered.preview.id, 300, after(120))).status, "processing");
  await settleProcessing(store, {
    previewId: registered.preview.id, artifactId: registered.artifact.id,
    artifactSha256: registered.artifact.sha256, processingGeneration: 1,
    outcome: "ready", at: after(150)
  });
  const ready = await renewPreview(store, registered.preview.id, 300, after(180));
  assert.equal(ready.status, "ready");
  assert.equal(ready.expiresAt, after(480));
  assert.equal(store.snapshot(after(479)).artifactPreviews?.[0].accessState, "eligible");
  assert.equal(store.snapshot(after(480)).artifactPreviews?.[0].accessState, "unavailable", "wall clock gates access before maintenance");

  await assert.rejects(renewPreview(store, registered.preview.id, previewBundleContract.maximumLifetimeSeconds, after(300)), errorCode("ttl_out_of_bounds"));
  await assert.rejects(renewPreview(store, registered.preview.id, 299, after(300)), errorCode("invalid_arguments"));
  await assert.rejects(renewPreview(store, registered.preview.id, 300.5, after(300)), errorCode("invalid_arguments"));

  await assert.rejects(renewPreview(store, registered.preview.id, 300, after(480)), errorCode("preview_expired"));
  assert.equal(store.snapshot(after(480)).artifactPreviews?.[0].status, "expired", "boundary renewal commits expiry instead");
  assert.equal(await expireDuePreviews(store, after(480)), 0, "an expired preview is terminal");
  await assert.rejects(beginProcessing(store, registered.preview.id, after(481)), errorCode("preview_expired"));
});

test("a processing result at the expiry boundary loses the race and cannot reopen the preview", async () => {
  const { store } = await previewStore();
  const registered = await registerPreview(store, sourceRun.id, { ...request, ttlSeconds: 300 }, at);
  await markUploaded(store, registered.artifact.id);
  await beginProcessing(store, registered.preview.id, after(60));
  await assert.rejects(settleProcessing(store, {
    previewId: registered.preview.id, artifactId: registered.artifact.id,
    artifactSha256: registered.artifact.sha256, processingGeneration: 1,
    outcome: "ready", at: after(300)
  }), errorCode("preview_expired"));
  const preview = store.snapshot(after(300)).artifactPreviews![0];
  assert.equal(preview.status, "expired");
  assert.equal(preview.expiredAt, after(300));
  assert.equal(preview.readyAt, undefined);
  assert.equal(preview.accessState, "unavailable");
  assert.equal(store.read((state) => state.previewProcessingReceipts?.length), 0);
});

test("legacy defaults add only absent preview collections and are idempotent", () => {
  const state = { agents: [], nodes: [], runs: [], events: [], messages: [] } as State;
  assert.equal(addArtifactPreviewDefaults(state), true);
  assert.deepEqual(state.artifactPreviews, []);
  assert.deepEqual(state.previewRegistrationReceipts, []);
  assert.deepEqual(state.previewProcessingReceipts, []);
  assert.equal(addArtifactPreviewDefaults(state), false);

  const malformed = {
    agents: [], nodes: [], runs: [], events: [], messages: [],
    artifactPreviews: null, previewRegistrationReceipts: null, previewProcessingReceipts: null
  } as unknown as State;
  assert.equal(addArtifactPreviewDefaults(malformed), false);
  assert.equal(malformed.artifactPreviews, null, "null is malformed, not absent");
  assert.equal(malformed.previewRegistrationReceipts, null);
  assert.equal(malformed.previewProcessingReceipts, null);
});

test("JSON and SQLite imports of a real legacy state gain empty preview collections across restart", async () => {
  const legacyFixture = fileURLToPath(new URL("../test-fixtures/state-before-external-orchestrators.json", import.meta.url));
  for (const kind of ["json", "sqlite"] as const) {
    const directory = await mkdtemp(join(tmpdir(), `coffee-shop-preview-legacy-${kind}-`));
    const legacyPath = join(directory, "state.json");
    await writeFile(legacyPath, await readFile(legacyFixture));
    const databasePath = join(directory, "coffee-shop.sqlite");
    const first = kind === "json" ? new Store(legacyPath) : new Store({ databasePath, legacyJsonPath: legacyPath });
    await first.load();
    first.read((state) => {
      assert.deepEqual(state.artifactPreviews, [], kind);
      assert.deepEqual(state.previewRegistrationReceipts, [], kind);
      assert.deepEqual(state.previewProcessingReceipts, [], kind);
    });
    const second = kind === "json" ? new Store(legacyPath) : new Store({ databasePath, legacyJsonPath: legacyPath });
    await second.load();
    second.read((state) => {
      assert.deepEqual(state.artifactPreviews, [], `${kind} restart`);
      assert.deepEqual(state.previewRegistrationReceipts, [], `${kind} restart`);
      assert.deepEqual(state.previewProcessingReceipts, [], `${kind} restart`);
    });
  }
});

const previewFixturePath = fileURLToPath(new URL("../test-fixtures/state-with-artifact-preview.json", import.meta.url));

async function loadPreviewFixture(mutate: (state: Record<string, any>) => void = () => undefined) {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-preview-fixture-"));
  const path = join(directory, "state.json");
  const bytes = await readFile(previewFixturePath);
  const state = JSON.parse(bytes.toString("utf8"));
  mutate(state);
  await writeFile(path, JSON.stringify(state, null, 2));
  return { store: new Store(path), path, sourceBytes: bytes };
}

test("loads preview state emitted by the real lifecycle producer byte-for-byte", async () => {
  // Produced by registerPreview/beginProcessing/settleProcessing in apps/hub/src/artifactPreviews.ts.
  const { store, path, sourceBytes } = await loadPreviewFixture();
  await store.load();
  assert.deepEqual(await readFile(path), sourceBytes, "current producer state needs no migration or coercion");
  const snapshot = store.snapshot("2026-09-27T12:04:00.000Z");
  assert.equal(snapshot.artifactPreviews?.[0].status, "ready");
  assert.equal(snapshot.artifactPreviews?.[0].accessState, "eligible");
  assert.ok(!("previewRegistrationReceipts" in snapshot));
  assert.ok(!("previewProcessingReceipts" in snapshot));
});

test("load rejects malformed, duplicate, orphaned, or authority-bearing preview state without rewriting it", async () => {
  const cases: Array<[string, RegExp, (state: Record<string, any>) => void]> = [
    ["null public collection", /artifact preview collection/, (state) => { state.artifactPreviews = null; }],
    ["null registration receipts", /registration receipt collection/, (state) => { state.previewRegistrationReceipts = null; }],
    ["null processing receipts", /processing receipt collection/, (state) => { state.previewProcessingReceipts = null; }],
    ["unknown status", /artifact preview 0 is invalid/, (state) => { state.artifactPreviews[0].status = "published"; }],
    ["wrong generation", /artifact preview 0 is invalid/, (state) => { state.artifactPreviews[0].processingGeneration = 0; }],
    ["persisted access", /artifact preview 0 is invalid/, (state) => { state.artifactPreviews[0].accessState = "eligible"; }],
    ["signed URL", /artifact preview 0 is invalid/, (state) => { state.artifactPreviews[0].signedUrl = "https://preview.invalid/secret"; }],
    ["ambiguous actor", /artifact preview 0 is invalid/, (state) => { state.artifactPreviews[0].instanceId = "instance-one"; state.artifactPreviews[0].allocationId = "allocation-one"; }],
    ["timestamp order", /artifact preview 0 is invalid/, (state) => { state.artifactPreviews[0].updatedAt = "2026-09-26T12:00:00.000Z"; }],
    ["duplicate preview", /repeats preview id/, (state) => { state.artifactPreviews.push(structuredClone(state.artifactPreviews[0])); }],
    ["duplicate artifact link", /repeats artifact link/, (state) => { const copy = structuredClone(state.artifactPreviews[0]); copy.id = "preview-two"; state.artifactPreviews.push(copy); }],
    ["missing artifact", /names missing or duplicated artifact/, (state) => { state.artifacts = []; }],
    ["artifact digest mismatch", /disagrees with its artifact digest/, (state) => { state.artifactPreviews[0].artifactSha256 = "b".repeat(64); }],
    ["artifact thread mismatch", /disagrees with its artifact thread/, (state) => { state.artifacts[0].threadId = "thread-other"; }],
    ["artifact actor mismatch", /disagrees with its artifact actor/, (state) => { state.artifacts[0].agentId = "other"; }],
    ["artifact kind mismatch", /is not a preview bundle/, (state) => { state.artifacts[0].kind = "report"; }],
    ["artifact media mismatch", /has the wrong preview media type/, (state) => { state.artifacts[0].mediaType = "application/gzip"; }],
    ["orphan preview artifact", /has no lifecycle record/, (state) => { state.artifactPreviews = []; state.previewRegistrationReceipts = []; state.previewProcessingReceipts = []; }],
    ["missing registration receipt", /has no registration receipt/, (state) => { state.previewRegistrationReceipts = []; }],
    ["duplicate registration scope", /repeats its source and idempotency key/, (state) => { const copy = structuredClone(state.previewRegistrationReceipts[0]); copy.id = "preview-registration-two"; state.previewRegistrationReceipts.push(copy); }],
    ["registration source mismatch", /disagrees with its preview source/, (state) => { state.previewRegistrationReceipts[0].sourceKey = "run:other"; }],
    ["registration corrupt digest", /registration receipt 0 has a corrupt digest/, (state) => { state.previewRegistrationReceipts[0].digest = "0".repeat(64); }],
    ["registration invalid TTL", /registration receipt 0 is malformed/, (state) => { state.previewRegistrationReceipts[0].ttlSeconds = 299; }],
    ["processing future generation", /exceeds its preview generation/, (state) => { state.previewProcessingReceipts[0].processingGeneration = 2; }],
    ["processing unknown outcome", /processing receipt 0 is malformed/, (state) => { state.previewProcessingReceipts[0].outcome = "published"; }],
    ["processing corrupt digest", /processing receipt 0 has a corrupt digest/, (state) => { state.previewProcessingReceipts[0].digest = "0".repeat(64); }],
    ["processing leaked token", /processing receipt 0 is malformed/, (state) => { state.previewProcessingReceipts[0].token = "secret"; }],
    ["missing current terminal receipt", /has no matching processing receipt/, (state) => { state.previewProcessingReceipts = []; }]
  ];

  for (const [name, reason, mutate] of cases) {
    const { store, path } = await loadPreviewFixture(mutate);
    const before = await readFile(path);
    await assert.rejects(() => store.load(), reason, name);
    assert.deepEqual(await readFile(path), before, `${name} must fail before rewrite`);
  }
});
