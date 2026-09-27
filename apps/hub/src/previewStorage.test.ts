import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import {
  PreviewStorage,
  PreviewStorageError,
  type PreparedPreviewManifest
} from "./previewStorage.js";

const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

const identity = {
  previewId: "preview-one",
  artifactId: "artifact-one",
  artifactSha256: "a".repeat(64),
  entrypoint: "site/index.html"
};

test("streams an artifact into an immutable exclusive blob and converges exact replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-preview-storage-"));
  const storage = new PreviewStorage(directory);
  const body = Buffer.from("streamed artifact body");
  const expected = { id: "artifact-one", size: body.length, sha256: digest(body), maximumBytes: body.length };

  const first = await storage.ingestArtifact(Readable.from([body.subarray(0, 4), body.subarray(4)]), expected);
  assert.equal(first.replayed, false);
  assert.deepEqual(await storage.readArtifact(expected.id), body);
  assert.equal((await stat(join(directory, "artifacts", expected.id))).mode & 0o777, 0o600);

  const replay = await storage.ingestArtifact(Readable.from([body]), expected);
  assert.equal(replay.replayed, true);
  assert.deepEqual(await storage.readArtifact(expected.id), body);
  assert.deepEqual(await readFile(join(directory, "preview-staging")).catch((error) => error.code), "EISDIR");
});

test("invalid request bytes and an existing conflicting blob never overwrite immutable content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-preview-storage-"));
  const storage = new PreviewStorage(directory);
  const body = Buffer.from("expected");
  const expected = { id: "artifact-one", size: body.length, sha256: digest(body), maximumBytes: body.length };

  await assert.rejects(
    storage.ingestArtifact(Readable.from([Buffer.from("too-long!")]), expected),
    (error: unknown) => error instanceof PreviewStorageError && error.code === "limit-exceeded"
  );
  await assert.rejects(storage.readArtifact(expected.id), { code: "ENOENT" });

  await mkdir(join(directory, "artifacts"), { recursive: true });
  await writeFile(join(directory, "artifacts", expected.id), "conflict", { mode: 0o600 });
  await assert.rejects(
    storage.ingestArtifact(Readable.from([body]), expected),
    (error: unknown) => error instanceof PreviewStorageError && error.code === "storage-conflict"
  );
  assert.equal(await readFile(join(directory, "artifacts", expected.id), "utf8"), "conflict");
});

test("publishes and strictly re-verifies one canonical prepared tree without overwriting it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-preview-storage-"));
  const storage = new PreviewStorage(directory);
  const workspace = await storage.createPreparationWorkspace({ ...identity, processingGeneration: 1 });
  await mkdir(join(workspace.contentDirectory, "site"), { recursive: true, mode: 0o700 });
  await writeFile(join(workspace.contentDirectory, "site", "index.html"), "<h1>Hello</h1>", { mode: 0o600 });
  const content = Buffer.from("<h1>Hello</h1>");
  const manifest: PreparedPreviewManifest = {
    schemaVersion: 1,
    ...identity,
    files: [{ path: "site/index.html", size: content.length, sha256: digest(content) }]
  };

  const published = await storage.publishPrepared(workspace, manifest);
  assert.equal(published.replayed, false);
  assert.deepEqual(await storage.verifyPrepared(identity), manifest);
  assert.equal((await lstat(join(directory, "prepared-previews", identity.previewId, identity.artifactSha256, "content", "site", "index.html"))).mode & 0o777, 0o600);

  const replayWorkspace = await storage.createPreparationWorkspace({ ...identity, processingGeneration: 2 });
  await mkdir(join(replayWorkspace.contentDirectory, "site"), { recursive: true, mode: 0o700 });
  await writeFile(join(replayWorkspace.contentDirectory, "site", "index.html"), content, { mode: 0o600 });
  assert.equal((await storage.publishPrepared(replayWorkspace, manifest)).replayed, true);

  await writeFile(join(directory, "prepared-previews", identity.previewId, identity.artifactSha256, "content", "extra.txt"), "unexpected");
  await assert.rejects(
    storage.verifyPrepared(identity),
    (error: unknown) => error instanceof PreviewStorageError && error.code === "storage-conflict"
  );
});

test("startup cleanup removes only strictly marked owned staging and refuses unknown material", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-preview-storage-"));
  const storage = new PreviewStorage(directory);
  const owned = await storage.createPreparationWorkspace({ ...identity, processingGeneration: 3 });
  await writeFile(join(owned.contentDirectory, "partial"), "partial", { mode: 0o600 });
  await storage.cleanupOwnedStaging();
  await assert.rejects(lstat(owned.rootDirectory), { code: "ENOENT" });

  const uploadRoot = join(directory, "preview-staging", "upload-crash-window");
  await mkdir(uploadRoot, { mode: 0o700 });
  await writeFile(join(uploadRoot, ".coffee-shop-preview-staging.json"), `${JSON.stringify({
    schemaVersion: 1,
    kind: "upload",
    rootName: "upload-crash-window",
    artifactId: "artifact-one",
    artifactSha256: "a".repeat(64),
    artifactSize: 12
  })}\n`, { mode: 0o600 });
  await writeFile(join(uploadRoot, "content"), "partial", { mode: 0o600 });
  await storage.cleanupOwnedStaging();
  await assert.rejects(lstat(uploadRoot), { code: "ENOENT" });

  const unknown = join(directory, "preview-staging", "unknown-material");
  await mkdir(unknown, { recursive: true });
  await assert.rejects(
    storage.cleanupOwnedStaging(),
    (error: unknown) => error instanceof PreviewStorageError && error.code === "storage-conflict"
  );
  assert.equal((await lstat(unknown)).isDirectory(), true);
});

test("symlinked blobs and incomplete prepared targets are conflicts, never replay or overwrite candidates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-preview-storage-"));
  const storage = new PreviewStorage(directory);
  const body = Buffer.from("expected");
  const expected = { id: "artifact-one", size: body.length, sha256: digest(body), maximumBytes: body.length };
  await mkdir(join(directory, "artifacts"), { mode: 0o700 });
  await symlink("/etc/passwd", join(directory, "artifacts", expected.id));
  await assert.rejects(
    storage.ingestArtifact(Readable.from([body]), expected),
    (error: unknown) => error instanceof PreviewStorageError && error.code === "storage-conflict"
  );

  const target = join(directory, "prepared-previews", identity.previewId, identity.artifactSha256);
  await mkdir(target, { recursive: true, mode: 0o700 });
  await assert.rejects(
    storage.verifyPrepared(identity),
    (error: unknown) => error instanceof PreviewStorageError && error.code === "storage-conflict"
  );
  assert.equal((await lstat(target)).isDirectory(), true);
});
