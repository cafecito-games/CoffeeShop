import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, symlink, truncate, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { previewBundleContract } from "@coffee-shop/protocol";
import { canonicalWorkingRoot } from "./localArtifact.js";
import { captureLocalPreview } from "./localPreview.js";

const fixtureContent = new URL("../../hub/test-fixtures/preview-v1/content/", import.meta.url);
const fixtureManifest = new URL("../../hub/test-fixtures/preview-v1/manifest.json", import.meta.url);
const fixtureBundle = new URL("../../hub/test-fixtures/preview-v1/bridge-bundle.tar.gz", import.meta.url);
const fixtureRegistration = new URL("../../hub/test-fixtures/preview-v1/bridge-registration.json", import.meta.url);

const argumentsValue = {
  threadId: "thread-one",
  relativePath: "site",
  entrypoint: "index.html",
  title: "Launch preview",
  summary: "Review the release",
  ttlSeconds: 3_600,
  idempotencyKey: "external-preview-one"
};

interface TarEntry {
  path: string;
  body: Buffer;
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
  type: string;
}

function octal(bytes: Buffer) {
  const value = bytes.toString("ascii").replace(/\0.*$/, "").trim();
  return value === "" ? 0 : Number.parseInt(value, 8);
}

function paxPath(body: Buffer) {
  let offset = 0;
  let result: string | undefined;
  while (offset < body.length) {
    const separator = body.indexOf(0x20, offset);
    assert.notEqual(separator, -1);
    const length = Number.parseInt(body.subarray(offset, separator).toString("ascii"), 10);
    const record = body.subarray(separator + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    assert.equal(record.slice(0, equals), "path");
    result = record.slice(equals + 1);
    offset += length;
  }
  return result;
}

function tarEntries(gzip: Buffer): TarEntry[] {
  assert.equal(gzip[0], 0x1f);
  assert.equal(gzip[1], 0x8b);
  assert.equal(gzip[3], 0, "gzip flags are pinned");
  assert.deepEqual([...gzip.subarray(4, 8)], [0, 0, 0, 0], "gzip mtime is epoch");
  assert.equal(gzip[9], 255, "gzip OS is pinned to unknown");
  const tar = gunzipSync(gzip);
  const entries: TarEntry[] = [];
  let offset = 0;
  let pendingPath: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header.subarray(124, 136));
    const type = header.subarray(156, 157).toString("ascii") || "0";
    const body = tar.subarray(offset + 512, offset + 512 + size);
    const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const path = prefix ? `${prefix}/${rawName}` : rawName;
    if (type === "x") pendingPath = paxPath(body);
    else {
      entries.push({
        path: pendingPath ?? path,
        body: Buffer.from(body),
        mode: octal(header.subarray(100, 108)),
        uid: octal(header.subarray(108, 116)),
        gid: octal(header.subarray(116, 124)),
        mtime: octal(header.subarray(136, 148)),
        type
      });
      pendingPath = undefined;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(tar.subarray(offset).every((byte) => byte === 0), "tar ends in zero blocks only");
  return entries;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "coffee-shop-local-preview-"));
  await mkdir(join(root, "site"));
  await writeFile(join(root, "site", "index.html"), await readFile(new URL("site/index.html", fixtureContent)));
  await writeFile(join(root, "site", "app.js"), await readFile(new URL("site/app.js", fixtureContent)));
  return { root, canonical: await canonicalWorkingRoot(root) };
}

test("packages the common producer fixture deterministically with fixed tar and gzip metadata", async () => {
  const { root, canonical } = await fixture();
  const first = await captureLocalPreview(canonical, argumentsValue);
  await chmod(join(root, "site", "index.html"), 0o700);
  await utimes(join(root, "site", "app.js"), new Date("2030-01-01T00:00:00Z"), new Date("2030-01-01T00:00:00Z"));
  const second = await captureLocalPreview(canonical, argumentsValue);
  assert.deepEqual(second.bytes, first.bytes);
  assert.equal(first.registration.kind, previewBundleContract.artifactKind);
  assert.equal(first.registration.mediaType, previewBundleContract.mediaType);
  assert.equal(first.registration.size, first.bytes.length);
  assert.equal(first.registration.sha256, createHash("sha256").update(first.bytes).digest("hex"));
  assert.equal(first.registration.entrypoint, "index.html");

  const checkedRegistration = JSON.parse(await readFile(fixtureRegistration, "utf8"));
  assert.deepEqual(first.bytes, await readFile(fixtureBundle), "the checked-in Bridge producer bytes are current");
  assert.deepEqual({
    ...first.registration,
    threadId: checkedRegistration.threadId,
    title: checkedRegistration.title,
    summary: checkedRegistration.summary,
    idempotencyKey: checkedRegistration.idempotencyKey
  }, checkedRegistration, "the checked-in Bridge registration is current apart from caller-facing fixture text");

  const entries = tarEntries(first.bytes);
  assert.deepEqual(entries.map((entry) => entry.path), ["app.js", "index.html"]);
  for (const entry of entries) {
    assert.deepEqual([entry.mode, entry.uid, entry.gid, entry.mtime, entry.type], [0o644, 0, 0, 0, "0"]);
  }
  const manifest = JSON.parse(await readFile(fixtureManifest, "utf8")) as { files: Array<{ path: string; size: number; sha256: string }> };
  assert.deepEqual(entries.map((entry) => ({
    path: `site/${entry.path}`,
    size: entry.body.length,
    sha256: createHash("sha256").update(entry.body).digest("hex")
  })), manifest.files);
});

test("uses a deterministic local PAX path only when USTAR cannot encode the name", async () => {
  const { root, canonical } = await fixture();
  const longDirectory = "segment".repeat(20);
  await mkdir(join(root, "site", longDirectory));
  const longPath = `${longDirectory}/${"x".repeat(90)}.html`;
  await writeFile(join(root, "site", longPath), "long path\n");
  const captured = await captureLocalPreview(canonical, { ...argumentsValue, entrypoint: longPath });
  assert.ok(tarEntries(captured.bytes).some((entry) => entry.path === longPath));
});

test("rejects symlinks, special files, collisions, traversal, and missing entrypoints before publication", async () => {
  const { root, canonical } = await fixture();
  for (const value of [
    { ...argumentsValue, relativePath: "../site" },
    { ...argumentsValue, relativePath: "/site" },
    { ...argumentsValue, relativePath: " site" },
    { ...argumentsValue, entrypoint: " index.html" },
    { ...argumentsValue, entrypoint: "missing.html" },
    { ...argumentsValue, entrypoint: "app.js" },
    { ...argumentsValue, extra: true }
  ]) await assert.rejects(captureLocalPreview(canonical, value));

  await symlink(join(root, "site"), join(root, "linked-site"), "dir");
  await assert.rejects(captureLocalPreview(canonical, { ...argumentsValue, relativePath: "linked-site" }), /symbolic/i);
  await symlink(join(root, "site", "app.js"), join(root, "site", "linked.js"));
  await assert.rejects(captureLocalPreview(canonical, argumentsValue), /symbolic/i);
  await unlink(join(root, "site", "linked.js"));
  execFileSync("mkfifo", [join(root, "site", "pipe")]);
  await assert.rejects(captureLocalPreview(canonical, argumentsValue), /special/i);
  await unlink(join(root, "site", "pipe"));

  await writeFile(join(root, "site", "App.js"), "collision");
  await assert.rejects(captureLocalPreview(canonical, argumentsValue), /collid/i);
});

test("rejects malformed or byte-overbound model arguments before reading a directory", async () => {
  const { canonical } = await fixture();
  for (const value of [
    { ...argumentsValue, title: "界".repeat(86) },
    { ...argumentsValue, summary: "界".repeat(667) },
    { ...argumentsValue, idempotencyKey: "界".repeat(43) },
    { ...argumentsValue, relativePath: "a".repeat(previewBundleContract.maximumPathBytes + 1) },
    { ...argumentsValue, entrypoint: `${"a".repeat(previewBundleContract.maximumPathBytes)}.html` },
    { ...argumentsValue, ttlSeconds: previewBundleContract.minimumTtlSeconds - 1 },
    { ...argumentsValue, ttlSeconds: previewBundleContract.maximumLifetimeSeconds + 1 },
    { ...argumentsValue, ttlSeconds: 3_600.5 },
    { ...argumentsValue, summary: 42 }
  ]) await assert.rejects(captureLocalPreview(canonical, value));
});

test("rejects non-NFC and non-UTF-8 names from the real directory producer", async () => {
  const { root, canonical } = await fixture();
  const decomposed = join(root, "site", "e\u0301.html");
  await writeFile(decomposed, "not normalized");
  await assert.rejects(captureLocalPreview(canonical, argumentsValue), /invalid archive path/i);
  await unlink(decomposed);

  const invalid = Buffer.concat([Buffer.from(join(root, "site")), Buffer.from("/"), Buffer.from([0xff])]);
  await writeFile(invalid, "not UTF-8");
  await assert.rejects(captureLocalPreview(canonical, argumentsValue), /UTF-8/i);
  await unlink(invalid);
});

test("rejects every package numeric one-over boundary and compression-ratio bombs", async () => {
  const { root, canonical } = await fixture();
  await writeFile(join(root, "site", "large.bin"), Buffer.alloc(previewBundleContract.maximumFileBytes + 1, 1));
  await assert.rejects(captureLocalPreview(canonical, argumentsValue), /limit|large/i);

  const countRoot = await mkdtemp(join(tmpdir(), "coffee-shop-local-preview-count-"));
  await mkdir(join(countRoot, "site"));
  await writeFile(join(countRoot, "site", "index.html"), "ok");
  for (let index = 0; index < previewBundleContract.maximumRegularFiles; index += 1) {
    await writeFile(join(countRoot, "site", `file-${index.toString().padStart(4, "0")}.txt`), "");
  }
  await assert.rejects(
    captureLocalPreview(await canonicalWorkingRoot(countRoot), argumentsValue),
    /file-count/i
  );

  const directoryCountRoot = await mkdtemp(join(tmpdir(), "coffee-shop-local-preview-directory-count-"));
  await mkdir(join(directoryCountRoot, "site"));
  await writeFile(join(directoryCountRoot, "site", "index.html"), "ok");
  for (let index = 0; index < previewBundleContract.maximumRegularFiles; index += 1) {
    await mkdir(join(directoryCountRoot, "site", `directory-${index.toString().padStart(4, "0")}`));
  }
  const directoriesAtLimit = await captureLocalPreview(await canonicalWorkingRoot(directoryCountRoot), argumentsValue);
  assert.equal(directoriesAtLimit.registration.kind, previewBundleContract.artifactKind);
  await mkdir(join(directoryCountRoot, "site", "directory-overflow"));
  await assert.rejects(
    captureLocalPreview(await canonicalWorkingRoot(directoryCountRoot), argumentsValue),
    /directory-count/i
  );

  const expandedRoot = await mkdtemp(join(tmpdir(), "coffee-shop-local-preview-expanded-"));
  await mkdir(join(expandedRoot, "site"));
  await writeFile(join(expandedRoot, "site", "index.html"), "ok");
  for (let index = 0; index < 10; index += 1) {
    const path = join(expandedRoot, "site", `expanded-${index}.bin`);
    await writeFile(path, "");
    await truncate(path, previewBundleContract.maximumFileBytes);
  }
  await assert.rejects(
    captureLocalPreview(await canonicalWorkingRoot(expandedRoot), argumentsValue),
    /expanded-size/i
  );

  const compressedRoot = await mkdtemp(join(tmpdir(), "coffee-shop-local-preview-compressed-"));
  await mkdir(join(compressedRoot, "site"));
  await writeFile(join(compressedRoot, "site", "index.html"), "ok");
  await writeFile(join(compressedRoot, "site", "random-a.bin"), randomBytes(6 * 1024 * 1024));
  await writeFile(join(compressedRoot, "site", "random-b.bin"), randomBytes(6 * 1024 * 1024));
  await assert.rejects(
    captureLocalPreview(await canonicalWorkingRoot(compressedRoot), argumentsValue),
    /compressed-size/i
  );

  const pathRoot = await mkdtemp(join(tmpdir(), "coffee-shop-local-preview-path-"));
  await mkdir(join(pathRoot, "site"));
  await writeFile(join(pathRoot, "site", "index.html"), "ok");
  const segments = Array.from({ length: 5 }, (_, index) => `${index}${"x".repeat(249)}`);
  const overlongDirectory = join(pathRoot, "site", ...segments);
  await mkdir(overlongDirectory, { recursive: true });
  await writeFile(join(overlongDirectory, "asset.txt"), "too deep");
  await assert.rejects(
    captureLocalPreview(await canonicalWorkingRoot(pathRoot), argumentsValue),
    /invalid archive path/i
  );

  const ratioRoot = await mkdtemp(join(tmpdir(), "coffee-shop-local-preview-ratio-"));
  await mkdir(join(ratioRoot, "site"));
  await writeFile(join(ratioRoot, "site", "index.html"), Buffer.alloc(1024 * 1024, 0));
  await assert.rejects(captureLocalPreview(await canonicalWorkingRoot(ratioRoot), argumentsValue), /ratio|limit/i);
});

test("cancellation and archive finalization failures retain no successful package", async () => {
  const { canonical } = await fixture();
  const controller = new AbortController();
  await assert.rejects(captureLocalPreview(canonical, argumentsValue, {
    signal: controller.signal,
    afterInitialInventory: async () => controller.abort()
  }), /cancel/i);

  await assert.rejects(captureLocalPreview(canonical, argumentsValue, {
    archiveTransform: () => new Transform({
      transform(_chunk, _encoding, callback) {
        callback(new Error("injected compressor failure"));
      }
    })
  }), /finalized/i);
});

test("rechecks file bytes and inventory after archive construction", async () => {
  const { root, canonical } = await fixture();
  await assert.rejects(captureLocalPreview(canonical, argumentsValue, {
    afterArchive: async () => {
      await writeFile(join(root, "site", "app.js"), "same-size mutation".padEnd(53, "!"));
      await writeFile(join(root, "site", "added.css"), "body{}\n");
    }
  }), /changed|inventory/i);
});
