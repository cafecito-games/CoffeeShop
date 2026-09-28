import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  artifactKinds,
  artifactPreviewAccessState,
  artifactPreviewAccessStates,
  artifactPreviewFailureCodes,
  artifactPreviewStatuses,
  canTransitionArtifactPreview,
  previewBundleAllowedEntryTypes,
  previewBundleArtifactKind,
  previewBundleContract,
  previewBundleMediaType,
  previewBundlePathCollisionKey,
  validateArtifactPreview,
  validateArtifactPreviewRecord,
  validatePreviewBundlePath
} from "../dist/index.js";

const createdAt = "2026-09-27T12:00:00.000Z";
const readyAt = "2026-09-27T12:01:00.000Z";
const expiresAt = "2026-09-28T12:00:00.000Z";

const baseRecord = {
  id: "preview-one",
  artifactId: "artifact-one",
  artifactSha256: "a".repeat(64),
  threadId: "thread-one",
  runId: "run-one",
  agentId: "agent-one",
  entrypoint: "site/index.html",
  createdAt,
  updatedAt: createdAt,
  expiresAt
};

const externalRecord = {
  ...baseRecord,
  runId: undefined,
  agentId: undefined,
  sourceKey: "orchestrator-client:client-one"
};

const recordFor = (status) => {
  switch (status) {
    case "upload-pending": return { ...baseRecord, status, processingGeneration: 0 };
    case "processing": return { ...baseRecord, status, processingGeneration: 1, updatedAt: readyAt };
    case "ready": return { ...baseRecord, status, processingGeneration: 1, readyAt, updatedAt: readyAt };
    case "failed": return {
      ...baseRecord, status, processingGeneration: 1, failedAt: readyAt,
      failureCode: "bundle-invalid", updatedAt: readyAt
    };
    case "expired": return {
      ...baseRecord, status, processingGeneration: 1, expiredAt: expiresAt, updatedAt: expiresAt
    };
    default: throw new Error(`Unhandled status ${status}`);
  }
};

test("preview vocabulary and language-neutral limits are exact", () => {
  assert.deepEqual(artifactKinds, ["patch", "report", "test-results", "log", "image", "other", "preview-bundle"]);
  assert.equal(previewBundleArtifactKind, "preview-bundle");
  assert.equal(previewBundleMediaType, "application/vnd.coffee-shop.preview-bundle+tar+gzip");
  assert.deepEqual(previewBundleAllowedEntryTypes, ["regular-file", "directory"]);
  assert.deepEqual(artifactPreviewStatuses, ["upload-pending", "processing", "ready", "failed", "expired"]);
  assert.deepEqual(artifactPreviewAccessStates, ["eligible", "unavailable"]);
  assert.deepEqual(artifactPreviewFailureCodes, [
    "upload-failed", "bundle-invalid", "path-invalid", "entrypoint-invalid", "limit-exceeded",
    "storage-conflict", "processing-cancelled", "processing-failed"
  ]);

  // Produced by test/preview-contract-fixture-producer.mjs:5 from the real exported contract.
  const bytes = readFileSync(new URL("./fixtures/preview-v1/limits.json", import.meta.url), "utf8");
  assert.equal(bytes, `${JSON.stringify(previewBundleContract, null, 2)}\n`);
  assert.deepEqual(JSON.parse(bytes), previewBundleContract);
});

test("every preview status transition is closed over the canonical vocabulary", () => {
  const expected = {
    "upload-pending": ["processing", "failed", "expired"],
    processing: ["ready", "failed", "expired"],
    ready: ["expired"],
    failed: ["processing", "expired"],
    expired: []
  };
  for (const from of artifactPreviewStatuses) {
    for (const to of artifactPreviewStatuses) {
      assert.equal(canTransitionArtifactPreview(from, to), expected[from].includes(to), `${from} -> ${to}`);
    }
  }
  assert.equal(canTransitionArtifactPreview("unknown", "ready"), false);
});

test("preview paths enforce POSIX, NFC, byte, segment, control, and entrypoint rules", () => {
  for (const path of ["index.html", "assets/app.js", "caf\u00e9/index.html"]) {
    assert.deepEqual(validatePreviewBundlePath(path), { ok: true, value: path });
  }
  assert.deepEqual(validatePreviewBundlePath("nested/index.html", { entrypoint: true }), { ok: true, value: "nested/index.html" });

  const boundary = "x".repeat(1024);
  assert.equal(new TextEncoder().encode(boundary).length, 1024);
  assert.equal(validatePreviewBundlePath(boundary).ok, true);

  const invalid = [
    "", "/index.html", "C:/index.html", "./index.html", "../index.html", "a/../index.html",
    "a//index.html", "a\\index.html", "a\u0000/index.html", "a\u0085/index.html",
    "cafe\u0301/index.html", `${boundary}x`
  ];
  for (const path of invalid) assert.equal(validatePreviewBundlePath(path).ok, false, JSON.stringify(path));
  for (const path of ["index.htm", "index.HTML", "directory", "site/app.js"]) {
    assert.equal(validatePreviewBundlePath(path, { entrypoint: true }).ok, false, path);
  }
  assert.equal(previewBundlePathCollisionKey("Assets/CAF\u00c9.HTML"), "assets/caf\u00c9.html");
  assert.equal(
    previewBundlePathCollisionKey("assets/App.js"),
    previewBundlePathCollisionKey("ASSETS/app.js"),
    "ASCII-case-fold collisions share one key"
  );
});

test("every preview status validates only its status-specific generation and fields", () => {
  for (const status of artifactPreviewStatuses) {
    const record = recordFor(status);
    assert.equal(validateArtifactPreviewRecord(record).ok, true, status);
    const projected = { ...record, accessState: artifactPreviewAccessState(record, readyAt) };
    assert.equal(validateArtifactPreview(projected, readyAt).ok, true, status);
  }

  assert.equal(artifactPreviewAccessState(recordFor("ready"), readyAt), "eligible");
  assert.equal(artifactPreviewAccessState(recordFor("ready"), expiresAt), "unavailable");
  assert.equal(artifactPreviewAccessState(recordFor("processing"), readyAt), "unavailable");

  const malformed = [
    { ...recordFor("upload-pending"), processingGeneration: 1 },
    { ...recordFor("processing"), processingGeneration: 0 },
    { ...recordFor("ready"), readyAt: undefined },
    { ...recordFor("ready"), failureCode: "bundle-invalid" },
    { ...recordFor("failed"), failureCode: "future-code" },
    { ...recordFor("failed"), failedAt: undefined },
    { ...recordFor("expired"), expiredAt: undefined },
    { ...recordFor("ready"), status: "published" },
    { ...recordFor("ready"), instanceId: "instance-one", allocationId: "allocation-one" },
    { ...recordFor("ready"), agentId: undefined },
    { ...recordFor("ready"), entrypoint: "../index.html" },
    { ...recordFor("ready"), artifactSha256: "A".repeat(64) },
    { ...recordFor("ready"), signedUrl: "https://preview.invalid/token" }
  ];
  for (const record of malformed) assert.equal(validateArtifactPreviewRecord(record).ok, false, JSON.stringify(record));

  const ready = recordFor("ready");
  assert.equal(validateArtifactPreview({ ...ready, accessState: "unavailable" }, readyAt).ok, false, "derived access cannot lie");
  assert.equal(validateArtifactPreview({ ...ready, accessState: "eligible", token: "secret" }, readyAt).ok, false, "public records reject undeclared authority");
});

test("preview lifecycle records reuse the exact run-or-external source invariant", () => {
  assert.equal(validateArtifactPreviewRecord({
    ...externalRecord,
    status: "upload-pending",
    processingGeneration: 0
  }).ok, true);
  assert.equal(validateArtifactPreview({
    ...externalRecord,
    status: "upload-pending",
    processingGeneration: 0,
    accessState: "unavailable"
  }, readyAt).ok, true);

  const rejected = [
    { ...externalRecord, sourceKey: undefined },
    { ...externalRecord, runId: "run-one" },
    { ...externalRecord, agentId: "agent-one" },
    { ...baseRecord, sourceKey: "orchestrator-client:client-one" },
    { ...baseRecord, sourceKey: "run:another-run" },
    { ...externalRecord, sourceKey: "orchestrator-client:client:one" }
  ];
  for (const record of rejected) {
    assert.equal(validateArtifactPreviewRecord({
      ...record,
      status: "upload-pending",
      processingGeneration: 0
    }).ok, false, JSON.stringify(record));
  }
});
