import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  previewBundleArtifactKind,
  previewBundleContract,
  previewBundleMediaType,
  type Agent,
  type ArtifactPreviewFailureCode,
  type Run
} from "@coffee-shop/protocol";
import { beginProcessing, registerPreview, registerPreviewForSource } from "./artifactPreviews.js";
import { claimArtifactUploadGrant } from "./artifactUploadGrants.js";
import { templateFromLegacyAgent } from "./agentTemplates.js";
import { createArtifact } from "./coordination.js";
import { createExternalThreadInState } from "./externalOrchestrators.js";
import { externalSource } from "./mailbox.js";
import { mintOrchestratorClient } from "./orchestratorClients.js";
import {
  ArtifactIngestionError,
  ingestArtifactContent,
  preparePreviewBundle,
  reconcileArtifactBlob,
  recoverPreviewPreparation,
  retryPreviewPreparation
} from "./previewPreparation.js";
import { PreviewStorage } from "./previewStorage.js";
import { Store } from "./store.js";

const at = "2026-09-27T12:00:00.000Z";
const after = (seconds: number) => new Date(Date.parse(at) + seconds * 1_000).toISOString();
const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const execFile = promisify(execFileCallback);
const bridgeBundleUrl = new URL("../test-fixtures/preview-v1/bridge-bundle.tar.gz", import.meta.url);
const bridgeRegistrationUrl = new URL("../test-fixtures/preview-v1/bridge-registration.json", import.meta.url);

interface TarEntry {
  name: string;
  body?: Buffer;
  type?: string;
  size?: number;
  linkName?: string;
}

function field(block: Buffer, offset: number, length: number, value: string) {
  const encoded = Buffer.from(value);
  encoded.copy(block, offset, 0, Math.min(encoded.length, length));
}

function octal(block: Buffer, offset: number, length: number, value: number) {
  field(block, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function header(entry: TarEntry) {
  const block = Buffer.alloc(512);
  field(block, 0, 100, entry.name);
  octal(block, 100, 8, 0o644);
  octal(block, 108, 8, 0);
  octal(block, 116, 8, 0);
  octal(block, 124, 12, entry.size ?? entry.body?.length ?? 0);
  octal(block, 136, 12, 0);
  block.fill(0x20, 148, 156);
  field(block, 156, 1, entry.type ?? "0");
  field(block, 157, 100, entry.linkName ?? "");
  field(block, 257, 6, "ustar\0");
  field(block, 263, 2, "00");
  let checksum = 0;
  for (const byte of block) checksum += byte;
  field(block, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

function tar(entries: TarEntry[], options: { terminate?: boolean; trailer?: Buffer } = {}) {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const body = entry.body ?? Buffer.alloc(0);
    chunks.push(header(entry), body);
    const padding = (512 - (body.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  if (options.terminate !== false) chunks.push(Buffer.alloc(1024));
  if (options.trailer) chunks.push(options.trailer);
  return Buffer.concat(chunks);
}

function paxRecord(key: string, value: string) {
  const recordBody = `${key}=${value}\n`;
  let length = Buffer.byteLength(recordBody) + 2;
  while (Buffer.byteLength(`${length} ${recordBody}`) !== length) length = Buffer.byteLength(`${length} ${recordBody}`);
  return Buffer.from(`${length} ${recordBody}`);
}

const paxPath = (path: string) => paxRecord("path", path);

const bundle = (entries: TarEntry[], options?: Parameters<typeof tar>[1]) => gzipSync(tar(entries, options));
const validBundle = () => bundle([
  { name: "site", type: "5" },
  { name: "site/index.html", body: Buffer.from("<!doctype html><h1>Hello</h1>") },
  { name: "site/app.js", body: Buffer.from("console.log('safe');") }
]);

const agent: Agent = {
  id: "publisher", name: "Publisher", title: "Publisher", summary: "", glyph: "P",
  avatarShape: "cup", avatarColor: "amber", state: "working", currentAction: "Publishing",
  harnessId: "codex-cli", model: "default", computeNodeId: "node-one", workspace: "/workspace/publisher",
  systemPrompt: "Publish carefully", canDelegate: true, unread: 0, updatedAt: at
};
const sourceRun: Run = {
  id: "run-source", threadId: "thread-one", agentId: agent.id, nodeId: "node-one", harnessId: "codex-cli",
  model: "default", workspace: "/workspace/publisher", prompt: "Publish", status: "running", output: "",
  depth: 0, createdAt: at, startedAt: at
};

type StoreKind = "json" | "sqlite";
async function fixture(kind: StoreKind = "json") {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-preview-preparation-"));
  const statePath = join(directory, kind === "json" ? "state.json" : "coffee-shop.sqlite");
  const store = kind === "json"
    ? new Store(statePath)
    : new Store({ databasePath: statePath, legacyJsonPath: join(directory, "absent.json") });
  await store.load();
  await store.transact((state) => {
    const imported = templateFromLegacyAgent(agent);
    assert.equal(imported.ok, true);
    state.agents = [structuredClone(agent)];
    state.threads = [{
      id: "thread-one", title: "Preview", objective: "Publish", summary: "", status: "active",
      ownerAgentId: agent.id, orchestrator: { kind: "agent", agentId: agent.id }, createdBy: "user",
      createdAt: at, updatedAt: at
    }];
    state.runs = [structuredClone(sourceRun)];
    state.templates = [structuredClone(imported.template)];
    state.legacyTemplateImports = [{ agentId: agent.id, templateId: imported.template.id, at }];
  });
  return { directory, statePath, store, storage: new PreviewStorage(directory) };
}

async function register(
  store: Store,
  bytes: Buffer,
  entrypoint = "site/index.html",
  ttlSeconds = previewBundleContract.defaultTtlSeconds
) {
  return registerPreview(store, sourceRun.id, {
    relativePath: ".coffee-shop/previews/site.tar.gz",
    title: "Site preview",
    kind: previewBundleArtifactKind,
    mediaType: previewBundleMediaType,
    summary: "Static site",
    size: bytes.length,
    sha256: sha256(bytes),
    entrypoint,
    ttlSeconds,
    idempotencyKey: `preview-${sha256(bytes).slice(0, 12)}-${entrypoint}-${ttlSeconds}`
  }, at);
}

async function stageBundle(storage: PreviewStorage, bytes: Buffer, id = "artifact-one") {
  await storage.ingestArtifact(Readable.from([bytes]), {
    id, size: bytes.length, sha256: sha256(bytes), maximumBytes: previewBundleContract.maximumCompressedBytes
  });
}

async function prepareBytes(bytes: Buffer, entrypoint = "site/index.html", previewId = "preview-one") {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-preview-bytes-"));
  const storage = new PreviewStorage(directory);
  try {
    await stageBundle(storage, bytes);
    return await preparePreviewBundle(storage, {
      previewId, artifactId: "artifact-one", artifactSha256: sha256(bytes), entrypoint,
      processingGeneration: 1, compressedSize: bytes.length
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("independently validates USTAR, extracts fixed-permission files, and replays the immutable target", async () => {
  const { storage, directory } = await fixture();
  const bytes = validBundle();
  await stageBundle(storage, bytes);
  const input = {
    previewId: "preview-one", artifactId: "artifact-one", artifactSha256: sha256(bytes),
    entrypoint: "site/index.html", processingGeneration: 1, compressedSize: bytes.length
  };
  const first = await preparePreviewBundle(storage, input);
  assert.equal(first.replayed, false);
  assert.deepEqual(first.manifest.files.map((file) => file.path), ["site/app.js", "site/index.html"]);
  assert.equal(await readFile(join(directory, "prepared-previews", "preview-one", sha256(bytes), "content", "site", "index.html"), "utf8"), "<!doctype html><h1>Hello</h1>");
  const replay = await preparePreviewBundle(storage, { ...input, processingGeneration: 2 });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.manifest, first.manifest);
});

test("ingests immutable bytes from the real external Bridge producer through shared source lifecycle authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-external-preview-producer-"));
  const statePath = join(directory, "state.json");
  const store = new Store(statePath);
  const storage = new PreviewStorage(directory);
  await store.load();
  const connectionId = "connection-external-preview";
  let clientId = "";
  let threadId = "";
  await store.transact((state) => {
    const minted = mintOrchestratorClient(state, { name: "Fixture bridge", scopes: ["orchestrate"] }, at);
    clientId = minted.client.id;
    const creation = createExternalThreadInState(state, {
      clientId, connectionId, title: "External preview", objective: "Load Bridge-produced bytes"
    }, at);
    threadId = creation.thread.id;
  });

  const bytes = await readFile(bridgeBundleUrl);
  const registration = JSON.parse(await readFile(bridgeRegistrationUrl, "utf8")) as Record<string, unknown>;
  const { threadId: _fixtureThreadId, ...request } = registration;
  const registered = await registerPreviewForSource(
    store,
    externalSource(connectionId, threadId),
    request,
    at
  );
  assert.equal(registered.artifact.sourceKey, `orchestrator-client:${clientId}`);
  assert.equal(registered.preview.sourceKey, `orchestrator-client:${clientId}`);
  assert.ok(registered.uploadGrant);
  assert.equal(await claimArtifactUploadGrant(store, registered.artifact.id, registered.uploadGrant.token, after(1)), true);

  const times = [after(2), after(3)];
  const ingested = await ingestArtifactContent(store, storage, {
    artifactId: registered.artifact.id,
    contentType: "application/octet-stream",
    body: Readable.from([bytes]),
    now: () => times.shift() ?? after(3)
  });
  assert.equal(ingested.kind, "preview");
  const final = store.snapshot(after(4));
  assert.equal(final.artifacts?.[0].uploaded, true);
  assert.equal(final.artifactPreviews?.[0].status, "ready");
  assert.equal(final.artifactPreviews?.[0].sourceKey, `orchestrator-client:${clientId}`);
  assert.deepEqual(
    await readFile(join(directory, "prepared-previews", registered.preview.id, registered.artifact.sha256, "content", "index.html")),
    await readFile(new URL("../test-fixtures/preview-v1/content/site/index.html", import.meta.url))
  );

  const replayed = await registerPreviewForSource(
    store,
    externalSource(connectionId, threadId),
    request,
    after(4)
  );
  assert.equal(replayed.created, false);
  assert.equal(replayed.artifact.id, registered.artifact.id);
  assert.equal(replayed.preview.id, registered.preview.id);
  assert.equal(replayed.preview.status, "ready");
  assert.equal(replayed.uploadGrant, undefined, "an immutable uploaded artifact never widens authority again");

  const restarted = new Store(statePath);
  await restarted.load();
  assert.equal(restarted.snapshot(after(4)).artifactPreviews?.[0].sourceKey, `orchestrator-client:${clientId}`);
});

test("accepts only local PAX path metadata needed by the Go archive/tar producer", async () => {
  const { storage } = await fixture();
  // Byte provenance: apps/hub/test-fixtures/generate-preview-bundle.go:30-32.
  const longPath = `site/${"segment/".repeat(40)}index.html`;
  const bytes = await readFile(new URL("../test-fixtures/preview-v1/pax-bundle.tar.gz", import.meta.url));
  await stageBundle(storage, bytes);
  const result = await preparePreviewBundle(storage, {
    previewId: "preview-pax", artifactId: "artifact-one", artifactSha256: sha256(bytes), entrypoint: longPath,
    processingGeneration: 1, compressedSize: bytes.length
  });
  assert.equal(result.manifest.files[0]?.path, longPath);

  const forbidden = paxPath("site/index.html").toString().replace("path=", "uid=0\npath=");
  const bad = bundle([
    { name: "PaxHeaders/index", type: "x", body: Buffer.from(forbidden) },
    { name: "placeholder", body: Buffer.from("bad") }
  ]);
  const other = new PreviewStorage(join(storage.rootDirectory, "forbidden"));
  await stageBundle(other, bad);
  await assert.rejects(
    preparePreviewBundle(other, {
      previewId: "preview-bad", artifactId: "artifact-one", artifactSha256: sha256(bad), entrypoint: "site/index.html",
      processingGeneration: 1, compressedSize: bad.length
    }),
    (error: unknown) => error instanceof ArtifactIngestionError && error.failureCode === "bundle-invalid"
  );
});

test("maps malformed archives, unsafe paths, missing entrypoints, and crossed limits to closed codes", async () => {
  const checksum = tar([{ name: "site/index.html", body: Buffer.from("ok") }]);
  checksum[148] ^= 1;
  const badGzipCrc = validBundle();
  badGzipCrc[badGzipCrc.length - 8] ^= 1;
  const cases: Array<[string, Buffer, string, string]> = [
    ["gzip syntax", Buffer.from("not-gzip"), "site/index.html", "bundle-invalid"],
    ["gzip truncation", validBundle().subarray(0, -2), "site/index.html", "bundle-invalid"],
    ["gzip CRC", badGzipCrc, "site/index.html", "bundle-invalid"],
    ["multiple gzip members", Buffer.concat([validBundle(), validBundle()]), "site/index.html", "bundle-invalid"],
    ["gzip trailing data", Buffer.concat([validBundle(), Buffer.from("secret-name")]), "site/index.html", "bundle-invalid"],
    ["tar checksum", gzipSync(checksum), "site/index.html", "bundle-invalid"],
    ["tar truncation", gzipSync(tar([{ name: "site/index.html", body: Buffer.from("ok") }], { terminate: false })), "site/index.html", "bundle-invalid"],
    ["tar trailing archive", bundle([{ name: "site/index.html", body: Buffer.from("ok") }], { trailer: header({ name: "second", body: Buffer.alloc(0) }) }), "site/index.html", "bundle-invalid"],
    ["symlink", bundle([{ name: "site/index.html", type: "2", linkName: "target" }]), "site/index.html", "bundle-invalid"],
    ["hard link", bundle([{ name: "site/index.html", type: "1", linkName: "target" }]), "site/index.html", "bundle-invalid"],
    ["character device", bundle([{ name: "site/index.html", type: "3" }]), "site/index.html", "bundle-invalid"],
    ["block device", bundle([{ name: "site/index.html", type: "4" }]), "site/index.html", "bundle-invalid"],
    ["fifo", bundle([{ name: "site/index.html", type: "6" }]), "site/index.html", "bundle-invalid"],
    ["contiguous file", bundle([{ name: "site/index.html", type: "7" }]), "site/index.html", "bundle-invalid"],
    ["global pax", bundle([{ name: "pax", type: "g", body: Buffer.from("11 path=x\n") }]), "site/index.html", "bundle-invalid"],
    ["GNU long name", bundle([{ name: "long", type: "L", body: Buffer.from("site/index.html\0") }]), "site/index.html", "bundle-invalid"],
    ["GNU long link", bundle([{ name: "long", type: "K", body: Buffer.from("target\0") }]), "site/index.html", "bundle-invalid"],
    ["GNU sparse", bundle([{ name: "site/index.html", type: "S" }]), "site/index.html", "bundle-invalid"],
    ["absolute", bundle([{ name: "/site/index.html", body: Buffer.from("x") }]), "site/index.html", "path-invalid"],
    ["drive absolute", bundle([{ name: "C:/site/index.html", body: Buffer.from("x") }]), "site/index.html", "path-invalid"],
    ["traversal", bundle([{ name: "site/../index.html", body: Buffer.from("x") }]), "site/index.html", "path-invalid"],
    ["dot segment", bundle([{ name: "site/./index.html", body: Buffer.from("x") }]), "site/index.html", "path-invalid"],
    ["empty segment", bundle([{ name: "site//index.html", body: Buffer.from("x") }]), "site/index.html", "path-invalid"],
    ["backslash", bundle([{ name: "site\\index.html", body: Buffer.from("x") }]), "site/index.html", "path-invalid"],
    ["control", bundle([{ name: "site/\u0001.html", body: Buffer.from("x") }]), "site/index.html", "path-invalid"],
    ["non-NFC", bundle([{ name: "cafe\u0301/index.html", body: Buffer.from("x") }]), "site/index.html", "path-invalid"],
    ["duplicate", bundle([{ name: "site/index.html", body: Buffer.from("x") }, { name: "site/index.html", body: Buffer.from("y") }]), "site/index.html", "path-invalid"],
    ["case collision", bundle([{ name: "site/index.html", body: Buffer.from("x") }, { name: "SITE/INDEX.HTML", body: Buffer.from("y") }]), "site/index.html", "path-invalid"],
    ["ancestor case collision", bundle([{ name: "site/a.html", body: Buffer.from("x") }, { name: "SITE/b.html", body: Buffer.from("y") }]), "site/a.html", "path-invalid"],
    ["ancestor conflict", bundle([{ name: "site", body: Buffer.from("x") }, { name: "site/index.html", body: Buffer.from("y") }]), "site/index.html", "path-invalid"],
    ["reverse ancestor conflict", bundle([{ name: "site/index.html", body: Buffer.from("y") }, { name: "site", body: Buffer.from("x") }]), "site/index.html", "path-invalid"],
    ["missing entrypoint", bundle([{ name: "site/other.html", body: Buffer.from("x") }]), "site/index.html", "entrypoint-invalid"],
    ["case-mismatched entrypoint", bundle([{ name: "site/Index.html", body: Buffer.from("x") }]), "site/index.html", "entrypoint-invalid"],
    ["directory entrypoint", bundle([{ name: "site/index.html", type: "5" }]), "site/index.html", "entrypoint-invalid"],
    ["file limit", bundle([{ name: "site/index.html", size: previewBundleContract.maximumFileBytes + 1 }], { terminate: false }), "site/index.html", "limit-exceeded"],
    ["nonzero file padding", bundle([{ name: "site/index.html", body: Buffer.from("xy"), size: 1 }]), "site/index.html", "bundle-invalid"]
  ];

  for (const key of ["size", "linkpath", "GNU.sparse.map", "SCHILY.acl.access", "SCHILY.xattr.user.key", "uid", "mtime"]) {
    const metadata = Buffer.concat([paxPath("site/index.html"), paxRecord(key, "1")]);
    cases.push([
      `PAX ${key}`,
      bundle([{ name: "PaxHeaders/index", type: "x", body: metadata }, { name: "placeholder", body: Buffer.from("x") }]),
      "site/index.html",
      "bundle-invalid"
    ]);
  }
  const duplicatePax = Buffer.concat([paxPath("site/index.html"), paxPath("site/other.html")]);
  cases.push([
    "duplicate PAX path",
    bundle([{ name: "PaxHeaders/index", type: "x", body: duplicatePax }, { name: "placeholder", body: Buffer.from("x") }]),
    "site/index.html",
    "bundle-invalid"
  ]);
  for (const [name, bytes, entrypoint, code] of cases) {
    const directory = await mkdtemp(join(tmpdir(), "coffee-shop-preview-invalid-"));
    const storage = new PreviewStorage(directory);
    await stageBundle(storage, bytes);
    await assert.rejects(
      preparePreviewBundle(storage, {
        previewId: `preview-${cases.indexOf(cases.find((item) => item[0] === name)!)}`,
        artifactId: "artifact-one", artifactSha256: sha256(bytes), entrypoint,
        processingGeneration: 1, compressedSize: bytes.length
      }),
      (error: unknown) => error instanceof ArtifactIngestionError
        && error.failureCode === code
        && !error.message.includes("secret-name"),
      name
    );
  }
});

test("shared path, file-count, directory-count, file-size, expanded, ratio, compressed, and inflated budgets enforce exact boundaries", async () => {
  const pathAtLimit = `${"a".repeat(250)}/${"b".repeat(250)}/${"c".repeat(250)}/${"d".repeat(250)}/${"e".repeat(15)}.html`;
  assert.equal(Buffer.byteLength(pathAtLimit), previewBundleContract.maximumPathBytes);
  const paxAtLimit = bundle([
    { name: "PaxHeaders/index", type: "x", body: paxPath(pathAtLimit) },
    { name: "placeholder", body: Buffer.from("path boundary") }
  ]);
  assert.equal((await prepareBytes(paxAtLimit, pathAtLimit, "preview-path-limit")).manifest.files[0]?.path, pathAtLimit);
  const pathOverLimit = pathAtLimit.replace(".html", "x.html");
  const paxOverLimit = bundle([
    { name: "PaxHeaders/index", type: "x", body: paxPath(pathOverLimit) },
    { name: "placeholder", body: Buffer.from("path boundary") }
  ]);
  await assert.rejects(
    prepareBytes(paxOverLimit, pathAtLimit, "preview-path-over"),
    (error: unknown) => error instanceof ArtifactIngestionError && error.failureCode === "path-invalid"
  );

  const entriesAtCount: TarEntry[] = [{ name: "index.html", body: Buffer.from("count") }];
  for (let index = 1; index < previewBundleContract.maximumRegularFiles; index += 1) {
    entriesAtCount.push({ name: `files/${index.toString().padStart(4, "0")}.txt`, body: Buffer.alloc(0) });
  }
  const countAtLimit = bundle(entriesAtCount);
  assert.equal((await prepareBytes(countAtLimit, "index.html", "preview-count-limit")).manifest.files.length,
    previewBundleContract.maximumRegularFiles);
  const countOverLimit = bundle([...entriesAtCount, { name: "files/overflow.txt", body: Buffer.alloc(0) }]);
  await assert.rejects(
    prepareBytes(countOverLimit, "index.html", "preview-count-over"),
    (error: unknown) => error instanceof ArtifactIngestionError && error.failureCode === "limit-exceeded"
  );

  const directoryEntriesAtLimit: TarEntry[] = [
    { name: "index.html", body: Buffer.from("directory count") },
    ...Array.from({ length: previewBundleContract.maximumRegularFiles }, (_, index) => ({
      name: `directories/${index.toString().padStart(4, "0")}`,
      type: "5"
    }))
  ];
  const directoriesAtLimit = bundle(directoryEntriesAtLimit);
  assert.equal((await prepareBytes(directoriesAtLimit, "index.html", "preview-directory-count-limit")).manifest.files.length, 1);
  const directoriesOverLimit = bundle([...directoryEntriesAtLimit, { name: "directories/overflow", type: "5" }]);
  await assert.rejects(
    prepareBytes(directoriesOverLimit, "index.html", "preview-directory-count-over"),
    (error: unknown) => error instanceof ArtifactIngestionError && error.failureCode === "limit-exceeded"
  );

  const padCompressed = (bytes: Buffer, size: number) => {
    assert.ok(bytes.length <= size);
    return Buffer.concat([bytes, Buffer.alloc(size - bytes.length)]);
  };
  const maximumFile = Buffer.alloc(previewBundleContract.maximumFileBytes);
  const maximumFileBase = bundle([{ name: "index.html", body: maximumFile }]);
  const maximumFileBundle = padCompressed(
    maximumFileBase,
    previewBundleContract.maximumFileBytes / previewBundleContract.maximumExpansionRatio
  );
  assert.equal((await prepareBytes(maximumFileBundle, "index.html", "preview-file-limit")).manifest.files[0]?.size,
    previewBundleContract.maximumFileBytes);

  const ratioOverPayload = Buffer.alloc(1_000_001);
  const ratioOverBase = bundle([{ name: "index.html", body: ratioOverPayload }]);
  const ratioOverBundle = padCompressed(ratioOverBase, 50_000);
  await assert.rejects(
    prepareBytes(ratioOverBundle, "index.html", "preview-ratio-over"),
    (error: unknown) => error instanceof ArtifactIngestionError && error.failureCode === "limit-exceeded"
  );

  const totalEntries: TarEntry[] = Array.from({ length: 10 }, (_, index) => ({
    name: index === 0 ? "index.html" : `files/${index}.bin`,
    body: Buffer.alloc(previewBundleContract.maximumFileBytes)
  }));
  const totalBase = bundle(totalEntries);
  const totalAtLimit = padCompressed(
    totalBase,
    previewBundleContract.maximumExpandedBytes / previewBundleContract.maximumExpansionRatio
  );
  const totalManifest = await prepareBytes(totalAtLimit, "index.html", "preview-expanded-limit");
  assert.equal(totalManifest.manifest.files.reduce((sum, file) => sum + file.size, 0), previewBundleContract.maximumExpandedBytes);
  const totalOverBase = bundle([...totalEntries, { name: "overflow.bin", body: Buffer.from("x") }]);
  const totalOver = padCompressed(totalOverBase, Math.ceil((previewBundleContract.maximumExpandedBytes + 1)
    / previewBundleContract.maximumExpansionRatio));
  await assert.rejects(
    prepareBytes(totalOver, "index.html", "preview-expanded-over"),
    (error: unknown) => error instanceof ArtifactIngestionError && error.failureCode === "limit-exceeded"
  );

  const compressedAtLimit = padCompressed(validBundle(), previewBundleContract.maximumCompressedBytes);
  assert.equal((await prepareBytes(compressedAtLimit, "site/index.html", "preview-compressed-limit")).manifest.files.length, 2);

  const inflatedBudget = previewBundleContract.maximumCompressedBytes * previewBundleContract.maximumExpansionRatio;
  const tinyTar = tar([{ name: "index.html", body: Buffer.from("inflated boundary") }]);
  const inflatedAtLimit = gzipSync(Buffer.concat([tinyTar, Buffer.alloc(inflatedBudget - tinyTar.length)]));
  assert.equal((await prepareBytes(inflatedAtLimit, "index.html", "preview-inflated-limit")).manifest.files.length, 1);
  const inflatedOver = gzipSync(Buffer.concat([tinyTar, Buffer.alloc(inflatedBudget + 1 - tinyTar.length)]));
  await assert.rejects(
    prepareBytes(inflatedOver, "index.html", "preview-inflated-over"),
    (error: unknown) => error instanceof ArtifactIngestionError && error.failureCode === "limit-exceeded"
  );
});

test("the upload workflow streams exact bytes, settles ready, and preserves ordinary artifacts", async () => {
  const { store, storage } = await fixture();
  const bytes = validBundle();
  const registered = await register(store, bytes);
  const result = await ingestArtifactContent(store, storage, {
    artifactId: registered.artifact.id,
    contentType: "application/octet-stream",
    body: Readable.from([bytes.subarray(0, 5), bytes.subarray(5)]),
    now: (() => { const values = [after(1), after(2), after(3)]; return () => values.shift() ?? after(3); })()
  });
  assert.equal(result.kind, "preview");
  assert.equal(store.snapshot(after(4)).artifactPreviews?.[0].status, "ready");
  assert.equal(store.snapshot().artifacts?.[0].uploaded, true);
  assert.equal(store.read((state) => state.previewProcessingReceipts?.length), 1);

  const ordinaryBody = Buffer.from("ordinary report");
  const ordinary = await createArtifact(store, sourceRun.id, {
    relativePath: "report.txt", title: "Report", kind: "report", mediaType: "text/plain", summary: "",
    size: ordinaryBody.length, sha256: sha256(ordinaryBody), idempotencyKey: "ordinary"
  }, after(5));
  const ordinaryResult = await ingestArtifactContent(store, storage, {
    artifactId: ordinary.artifact.id, contentType: "application/octet-stream", body: Readable.from([ordinaryBody]),
    now: () => after(6)
  });
  assert.equal(ordinaryResult.kind, "ordinary");
  assert.deepEqual(await storage.readArtifact(ordinary.artifact.id), ordinaryBody);
});

test("operator retry owns one fresh generation and concurrent calls never start a second extraction", async () => {
  const { store, storage } = await fixture();
  const bytes = validBundle();
  const registered = await register(store, bytes);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(ingestArtifactContent(store, storage, {
    artifactId: registered.artifact.id, contentType: "application/octet-stream", body: Readable.from([bytes]),
    signal: abort.signal,
    now: (() => { const values = [after(1), after(2)]; return () => values.shift() ?? after(2); })()
  }));
  assert.equal(store.snapshot(after(3)).artifactPreviews?.[0].status, "failed");

  const originalRead = storage.readArtifact.bind(storage);
  let releaseRead!: () => void;
  const held = new Promise<void>((resolve) => { releaseRead = resolve; });
  let markRead!: () => void;
  const readStarted = new Promise<void>((resolve) => { markRead = resolve; });
  let reads = 0;
  storage.readArtifact = async (...args) => {
    reads += 1;
    markRead();
    await held;
    return originalRead(...args);
  };
  const broadcasts: string[] = [];
  const times = [after(4), after(5)];
  const first = retryPreviewPreparation(store, storage, registered.preview.id, {
    now: () => times.shift() ?? after(5),
    onCommitted: (value) => broadcasts.push(value.status)
  });
  await readStarted;
  const replay = await retryPreviewPreparation(store, storage, registered.preview.id, {
    now: () => after(4), onCommitted: () => broadcasts.push("unexpected")
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.preview.status, "processing");
  assert.equal(replay.preview.processingGeneration, 2);
  assert.equal(reads, 1);
  releaseRead();
  const accepted = await first;
  assert.equal(accepted.replayed, false);
  assert.equal(accepted.preview.status, "ready");
  assert.equal(accepted.preview.processingGeneration, 2);
  assert.deepEqual(broadcasts, ["processing", "ready"]);
  assert.equal(store.read((state) => state.previewProcessingReceipts?.length), 2);
});

test("operator retry rejects absent, unuploaded, mismatched, ready, and expired state before preparation", async () => {
  const bytes = validBundle();
  const { store, storage } = await fixture();
  const registered = await register(store, bytes);
  await assert.rejects(retryPreviewPreparation(store, storage, "missing"),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "not_found");
  await assert.rejects(retryPreviewPreparation(store, storage, registered.preview.id),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "artifact_mismatch");

  await stageBundle(storage, bytes, registered.artifact.id);
  await reconcileArtifactBlob(store, storage, registered.artifact.id);
  await store.transact((state) => {
    state.artifactPreviews = state.artifactPreviews?.map((preview) => ({ ...preview, artifactSha256: "b".repeat(64) }));
  });
  await assert.rejects(retryPreviewPreparation(store, storage, registered.preview.id),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "artifact_mismatch");
  await store.transact((state) => {
    state.artifactPreviews = state.artifactPreviews?.map((preview) => ({ ...preview, artifactSha256: sha256(bytes) }));
  });
  await assert.rejects(retryPreviewPreparation(store, storage, registered.preview.id),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_transition");

  await store.transact((state) => {
    const current = state.artifactPreviews![0]!;
    current.status = "failed"; current.processingGeneration = 1; current.updatedAt = after(2);
    current.failedAt = after(2); current.failureCode = "processing-failed";
  });
  await assert.rejects(retryPreviewPreparation(store, storage, registered.preview.id, {
    now: () => after(previewBundleContract.defaultTtlSeconds + 1)
  }), (error: unknown) => error instanceof Error && "code" in error && error.code === "preview_expired");
});

test("bad preview uploads fail only generation zero and never commit bytes", async () => {
  const { store, storage } = await fixture();
  const bytes = validBundle();
  const registered = await register(store, bytes);
  await assert.rejects(
    ingestArtifactContent(store, storage, {
      artifactId: registered.artifact.id, contentType: "application/octet-stream",
      body: Readable.from([Buffer.alloc(bytes.length, 1)]), now: () => after(1)
    }),
    (error: unknown) => error instanceof ArtifactIngestionError && error.code === "upload-invalid"
  );
  assert.equal(store.snapshot().artifacts?.[0].uploaded, false);
  assert.equal(store.snapshot(after(2)).artifactPreviews?.[0].status, "failed");
  assert.equal(store.snapshot(after(2)).artifactPreviews?.[0].failureCode, "upload-failed");
  assert.equal(await storage.verifyArtifact({ id: registered.artifact.id, size: bytes.length, sha256: sha256(bytes) }), "absent");

  const times = [after(2), after(3)];
  await ingestArtifactContent(store, storage, {
    artifactId: registered.artifact.id, contentType: "application/octet-stream", body: Readable.from([bytes]),
    now: () => times.shift() ?? after(3)
  });
  assert.equal(store.snapshot(after(4)).artifactPreviews?.[0].status, "ready");
  assert.equal(store.snapshot(after(4)).artifactPreviews?.[0].processingGeneration, 1);
  await ingestArtifactContent(store, storage, {
    artifactId: registered.artifact.id, contentType: "application/octet-stream", body: Readable.from([bytes]),
    now: () => after(4)
  });
  assert.equal(store.read((state) => state.previewProcessingReceipts?.length), 1, "terminal replay adds no receipt");
  assert.equal(store.snapshot(after(5)).artifactPreviews?.[0].processingGeneration, 1, "terminal replay adds no generation");
});

test("wrong type, short, long, digest-mismatched, disconnected, and unknown uploads create no forbidden storage", async () => {
  const bytes = validBundle();
  const attempts: Array<[string, string | undefined, () => AsyncIterable<Uint8Array>]> = [
    ["wrong type", "application/gzip", () => Readable.from([bytes])],
    ["short", "application/octet-stream", () => Readable.from([bytes.subarray(0, -1)])],
    ["long", "application/octet-stream", () => Readable.from([bytes, Buffer.from("x")])],
    ["digest", "application/octet-stream", () => Readable.from([Buffer.alloc(bytes.length, 1)])],
    ["disconnect", "application/octet-stream", () => (async function* () {
      yield bytes.subarray(0, 5);
      throw new Error("raw-client-secret-that-must-not-surface");
    })()]
  ];
  for (const [name, contentType, body] of attempts) {
    const { store, storage } = await fixture();
    const registered = await register(store, bytes);
    await assert.rejects(
      ingestArtifactContent(store, storage, {
        artifactId: registered.artifact.id, contentType, body: body(), now: () => after(1)
      }),
      (error: unknown) => error instanceof ArtifactIngestionError
        && error.failureCode === "upload-failed"
        && !error.message.includes("raw-client-secret"),
      name
    );
    assert.equal(store.snapshot().artifacts?.[0].uploaded, false, name);
    assert.equal(store.snapshot(after(2)).artifactPreviews?.[0].failureCode, "upload-failed", name);
    assert.equal(await storage.verifyArtifact({ id: registered.artifact.id, size: bytes.length, sha256: sha256(bytes) }), "absent", name);
  }

  const { store, storage, directory } = await fixture();
  await assert.rejects(
    ingestArtifactContent(store, storage, {
      artifactId: "artifact-unknown", contentType: "application/octet-stream", body: Readable.from([bytes])
    }),
    (error: unknown) => error instanceof ArtifactIngestionError && error.code === "not-found"
  );
  await assert.rejects(readFile(join(directory, "preview-staging", "anything")), { code: "ENOENT" });
});

test("preparation failures settle the exact generation with the closed failure vocabulary", async () => {
  const cases: Array<[ArtifactPreviewFailureCode, Buffer, string]> = [
    ["bundle-invalid", Buffer.from("not gzip"), "site/index.html"],
    ["path-invalid", bundle([{ name: "../index.html", body: Buffer.from("x") }]), "site/index.html"],
    ["entrypoint-invalid", bundle([{ name: "other.html", body: Buffer.from("x") }]), "site/index.html"],
    ["limit-exceeded", bundle([{ name: "site/index.html", size: previewBundleContract.maximumFileBytes + 1 }], { terminate: false }), "site/index.html"]
  ];
  for (const [failureCode, bytes, entrypoint] of cases) {
    const { store, storage } = await fixture();
    const registered = await register(store, bytes, entrypoint);
    await assert.rejects(ingestArtifactContent(store, storage, {
      artifactId: registered.artifact.id, contentType: "application/octet-stream", body: Readable.from([bytes]),
      now: (() => { const values = [after(1), after(2), after(3)]; return () => values.shift() ?? after(3); })()
    }), (error: unknown) => error instanceof ArtifactIngestionError && error.failureCode === failureCode);
    const preview = store.snapshot(after(4)).artifactPreviews?.[0];
    assert.equal(preview?.status, "failed", failureCode);
    assert.equal(preview?.failureCode, failureCode, failureCode);
    assert.equal(preview?.processingGeneration, 1, failureCode);
    assert.equal(store.read((state) => state.previewProcessingReceipts?.[0]?.failureCode), failureCode, failureCode);
  }
});

test("cancellation settles only the owned generation and expiry remains the authoritative winner", async () => {
  {
    const { store, storage } = await fixture();
    const bytes = validBundle();
    const registered = await register(store, bytes);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(ingestArtifactContent(store, storage, {
      artifactId: registered.artifact.id, contentType: "application/octet-stream", body: Readable.from([bytes]),
      signal: abort.signal,
      now: (() => { const values = [after(1), after(2)]; return () => values.shift() ?? after(2); })()
    }), (error: unknown) => error instanceof ArtifactIngestionError && error.failureCode === "processing-cancelled");
    const preview = store.snapshot(after(3)).artifactPreviews?.[0];
    assert.equal(preview?.status, "failed");
    assert.equal(preview?.failureCode, "processing-cancelled");
    assert.equal(preview?.processingGeneration, 1);
  }

  {
    const { store, storage } = await fixture();
    const bytes = validBundle();
    const registered = await register(store, bytes, "site/index.html", previewBundleContract.minimumTtlSeconds);
    await assert.rejects(ingestArtifactContent(store, storage, {
      artifactId: registered.artifact.id, contentType: "application/octet-stream", body: Readable.from([bytes]),
      now: (() => { const values = [after(1), after(previewBundleContract.minimumTtlSeconds + 1)]; return () => values.shift() ?? after(previewBundleContract.minimumTtlSeconds + 1); })()
    }), (error: unknown) => error instanceof ArtifactIngestionError && error.failureCode === "processing-cancelled");
    const preview = store.snapshot(after(previewBundleContract.minimumTtlSeconds + 2)).artifactPreviews?.[0];
    assert.equal(preview?.status, "expired");
    assert.equal(preview?.failureCode, undefined);
    assert.equal(store.read((state) => state.previewProcessingReceipts?.length), 0);
    assert.ok(await storage.verifyPrepared({
      previewId: registered.preview.id, artifactId: registered.artifact.id,
      artifactSha256: sha256(bytes), entrypoint: "site/index.html"
    }), "published immutable output remains verifiable but never makes the expired record ready");
  }
});

test("immutable blob and prepared-target conflicts settle only a currently processable preview", async () => {
  {
    const { store, storage, directory } = await fixture();
    const bytes = validBundle();
    const registered = await register(store, bytes);
    await stageBundle(storage, bytes, registered.artifact.id);
    await reconcileArtifactBlob(store, storage, registered.artifact.id);
    await writeFile(join(directory, "artifacts", registered.artifact.id), "corrupt immutable bytes");
    await assert.rejects(ingestArtifactContent(store, storage, {
      artifactId: registered.artifact.id, contentType: "application/octet-stream", body: Readable.from([bytes]),
      now: (() => { const values = [after(1), after(2)]; return () => values.shift() ?? after(2); })()
    }), (error: unknown) => error instanceof ArtifactIngestionError && error.failureCode === "storage-conflict");
    assert.equal(store.snapshot(after(3)).artifactPreviews?.[0].failureCode, "storage-conflict");
    assert.equal(store.snapshot(after(3)).artifactPreviews?.[0].processingGeneration, 1);
  }

  {
    const { store, storage, directory } = await fixture();
    const bytes = validBundle();
    const registered = await register(store, bytes);
    await mkdir(join(directory, "prepared-previews", registered.preview.id, sha256(bytes)), { recursive: true, mode: 0o700 });
    await assert.rejects(ingestArtifactContent(store, storage, {
      artifactId: registered.artifact.id, contentType: "application/octet-stream", body: Readable.from([bytes]),
      now: (() => { const values = [after(1), after(2)]; return () => values.shift() ?? after(2); })()
    }), (error: unknown) => error instanceof ArtifactIngestionError && error.failureCode === "storage-conflict");
    assert.equal(store.snapshot(after(3)).artifactPreviews?.[0].failureCode, "storage-conflict");
    assert.equal(store.read((state) => state.previewProcessingReceipts?.[0]?.failureCode), "storage-conflict");
  }
});

test("startup recovery covers committed blob, processing staging, published target, and ready verification", async () => {
  for (const kind of ["json", "sqlite"] as const) {
    const { store, storage, statePath, directory } = await fixture(kind);
    const bytes = validBundle();
    const registered = await register(store, bytes);
    await stageBundle(storage, bytes, registered.artifact.id); // crash after blob commit, before uploaded flag
    await recoverPreviewPreparation(store, storage, () => after(1));
    assert.equal(store.snapshot(after(2)).artifactPreviews?.[0].status, "ready", kind);

    const workspace = await storage.createPreparationWorkspace({
      previewId: registered.preview.id, artifactId: registered.artifact.id, artifactSha256: sha256(bytes),
      entrypoint: "site/index.html", processingGeneration: 99
    });
    await writeFile(join(workspace.contentDirectory, "partial"), "partial");
    await recoverPreviewPreparation(store, storage, () => after(3));
    await assert.rejects(readFile(join(workspace.contentDirectory, "partial")), { code: "ENOENT" });
    assert.equal(store.read((state) => state.previewProcessingReceipts?.length), 1, kind);

    const restarted = kind === "json"
      ? new Store(statePath)
      : new Store({ databasePath: statePath, legacyJsonPath: join(directory, "absent.json") });
    await restarted.load();
    await recoverPreviewPreparation(restarted, new PreviewStorage(directory), () => after(4));
    assert.equal(restarted.snapshot(after(5)).artifactPreviews?.[0].status, "ready", `${kind} ready restart`);
    assert.equal(restarted.read((state) => state.previewProcessingReceipts?.length), 1, `${kind} ready replay`);
  }
});

test("startup recovery migrates exact legacy blobs and bounds corrupt pre-upload conflicts", async () => {
  {
    const { store, storage, directory } = await fixture();
    const bytes = validBundle();
    const registered = await register(store, bytes);
    const artifactDirectory = join(directory, "artifacts");
    const artifactPath = join(artifactDirectory, registered.artifact.id);
    await mkdir(artifactDirectory, { mode: 0o700 });
    await writeFile(artifactPath, bytes);
    await chmod(artifactPath, 0o644);

    await recoverPreviewPreparation(store, storage, () => after(1));

    assert.equal((await stat(artifactPath)).mode & 0o777, 0o600);
    assert.equal(store.snapshot(after(2)).artifacts?.[0].uploaded, true);
    assert.equal(store.snapshot(after(2)).artifactPreviews?.[0].status, "ready");
  }

  {
    const { store, storage, directory } = await fixture();
    const bytes = validBundle();
    const registered = await register(store, bytes);
    await mkdir(join(directory, "artifacts"), { mode: 0o700 });
    await writeFile(join(directory, "artifacts", registered.artifact.id), Buffer.alloc(bytes.length, 1));

    await assert.rejects(
      recoverPreviewPreparation(store, storage, () => after(1)),
      (error: unknown) => error instanceof ArtifactIngestionError
        && error.code === "storage-conflict"
        && error.failureCode === "storage-conflict"
        && error.message === "Immutable preview storage conflicts with its registered identity"
    );
    assert.equal(store.snapshot(after(2)).artifacts?.[0].uploaded, false);
    assert.equal(store.snapshot(after(2)).artifactPreviews?.[0].status, "upload-pending");
    assert.equal(store.snapshot(after(2)).artifactPreviews?.[0].processingGeneration, 0);
  }
});

test("recovery resumes uploaded, processing-partial, and published-before-settlement crash windows", async () => {
  const setup = async () => {
    const context = await fixture();
    const bytes = validBundle();
    const registered = await register(context.store, bytes);
    await stageBundle(context.storage, bytes, registered.artifact.id);
    await reconcileArtifactBlob(context.store, context.storage, registered.artifact.id);
    return { ...context, bytes, registered };
  };

  {
    const { store, storage } = await setup(); // crash after uploaded, before beginProcessing
    await recoverPreviewPreparation(store, storage, () => after(1));
    assert.equal(store.snapshot(after(2)).artifactPreviews?.[0].status, "ready");
    assert.equal(store.snapshot(after(2)).artifactPreviews?.[0].processingGeneration, 1);
  }

  {
    const { store, storage, bytes, registered } = await setup();
    const processing = await beginProcessing(store, registered.preview.id, after(1));
    const partial = await storage.createPreparationWorkspace({
      previewId: registered.preview.id, artifactId: registered.artifact.id, artifactSha256: sha256(bytes),
      entrypoint: "site/index.html", processingGeneration: processing.generation
    });
    await writeFile(join(partial.contentDirectory, "partial"), "partial");
    await recoverPreviewPreparation(store, storage, () => after(2));
    assert.equal(store.snapshot(after(3)).artifactPreviews?.[0].status, "ready");
    await assert.rejects(readFile(join(partial.contentDirectory, "partial")), { code: "ENOENT" });
  }

  {
    const { store, storage, bytes, registered } = await setup();
    const processing = await beginProcessing(store, registered.preview.id, after(1));
    await preparePreviewBundle(storage, {
      previewId: registered.preview.id, artifactId: registered.artifact.id, artifactSha256: sha256(bytes),
      entrypoint: "site/index.html", processingGeneration: processing.generation, compressedSize: bytes.length
    });
    assert.equal(store.snapshot(after(2)).artifactPreviews?.[0].status, "processing");
    await recoverPreviewPreparation(store, storage, () => after(2));
    assert.equal(store.snapshot(after(3)).artifactPreviews?.[0].status, "ready");
    assert.equal(store.read((state) => state.previewProcessingReceipts?.length), 1);
  }
});

test("recovery refuses a durable ready record without an exact prepared tree", async () => {
  const { store, storage, directory } = await fixture();
  const bytes = validBundle();
  const registered = await register(store, bytes);
  await ingestArtifactContent(store, storage, {
    artifactId: registered.artifact.id, contentType: "application/octet-stream", body: Readable.from([bytes]),
    now: (() => { const values = [after(1), after(2), after(3)]; return () => values.shift() ?? after(3); })()
  });
  await rm(join(directory, "prepared-previews", registered.preview.id, sha256(bytes)), { recursive: true });
  await assert.rejects(
    recoverPreviewPreparation(store, storage, () => after(4)),
    (error: unknown) => error instanceof ArtifactIngestionError && error.failureCode === "storage-conflict"
  );
});

test("checked-in state, manifest, tree, and bytes reproduce from the Go archive/tar producer", async () => {
  // Byte provenance: apps/hub/test-fixtures/generate-preview-bundle.go:26-46.
  const hubDirectory = fileURLToPath(new URL("..", import.meta.url));
  const generator = fileURLToPath(new URL("../test-fixtures/generate-artifact-preview-fixtures.mts", import.meta.url));
  await execFile("pnpm", ["exec", "tsx", generator, "--check"], {
    cwd: hubDirectory,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024
  });
});
