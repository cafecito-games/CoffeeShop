import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform, Writable } from "node:stream";
import { createGzip, constants as zlibConstants } from "node:zlib";
import {
  artifactPreviewTtlPolicy,
  previewBundleContract,
  previewBundlePathCollisionKey,
  validatePreviewBundlePath
} from "@coffee-shop/protocol";
import { LocalArtifactError } from "./localArtifact.js";

export interface ExternalPublishPreviewArguments {
  threadId: string;
  relativePath: string;
  entrypoint: string;
  title: string;
  summary?: string;
  ttlSeconds?: number;
  idempotencyKey: string;
}

export interface ExternalPreviewRegistration {
  threadId: string;
  relativePath: string;
  entrypoint: string;
  title: string;
  kind: typeof previewBundleContract.artifactKind;
  mediaType: typeof previewBundleContract.mediaType;
  summary: string;
  ttlSeconds: number;
  idempotencyKey: string;
  size: number;
  sha256: string;
}

export interface CapturedLocalPreview {
  registration: ExternalPreviewRegistration;
  /** The exact finalized gzip bytes whose size and digest are registered and later uploaded. */
  bytes: Buffer;
}

export interface CaptureLocalPreviewOptions {
  signal?: AbortSignal;
  /** Test seam after the first checked inventory and before any archive bytes are produced. */
  afterInitialInventory?: () => Promise<void>;
  /** Test seam after archive finalization and before the required source/inventory recheck. */
  afterArchive?: () => Promise<void>;
  /** Test seam for a compressor/write failure; production always uses the pinned gzip transform. */
  archiveTransform?: () => Transform;
}

interface FileIdentity {
  path: string;
  absolutePath: string;
  device: bigint;
  inode: bigint;
  size: bigint;
  mtimeNanoseconds: bigint;
  changeNanoseconds: bigint;
  sha256: string;
}

interface DirectoryIdentity {
  path: string;
  absolutePath: string;
  device: bigint;
  inode: bigint;
  mtimeNanoseconds: bigint;
  changeNanoseconds: bigint;
}

interface Inventory {
  files: FileIdentity[];
  directories: DirectoryIdentity[];
  expandedBytes: number;
}

const allowedArgumentKeys = [
  "threadId", "relativePath", "entrypoint", "title", "summary", "ttlSeconds", "idempotencyKey"
] as const;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const zeroBlock = Buffer.alloc(512);

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const byteLength = (value: string) => Buffer.byteLength(value, "utf8");
const contained = (root: string, candidate: string) => {
  const fromRoot = relative(root, candidate);
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
};

function fail(message: string): never {
  throw new LocalArtifactError(message);
}

function throwIfCancelled(signal: AbortSignal | undefined) {
  if (signal?.aborted) fail("preview packaging was cancelled");
}

function requiredText(input: Record<string, unknown>, key: string, maximumBytes: number, trim = true) {
  if (typeof input[key] !== "string") fail(`${key} is required in publish_preview arguments`);
  const value = trim ? (input[key] as string).trim() : input[key] as string;
  if (!value) fail(`${key} is required in publish_preview arguments`);
  if (byteLength(value) > maximumBytes) fail(`${key} exceeds the publish_preview argument limit`);
  return value;
}

function parseArguments(value: unknown): Omit<ExternalPreviewRegistration, "size" | "sha256"> {
  if (!record(value)) fail("publish_preview arguments must be an object");
  if (Object.keys(value).some((key) => !(allowedArgumentKeys as readonly string[]).includes(key))) {
    fail("publish_preview arguments contain an unknown field");
  }
  const threadId = requiredText(value, "threadId", 200);
  const title = requiredText(value, "title", 256);
  const idempotencyKey = requiredText(value, "idempotencyKey", 128);
  if (value.summary !== undefined && typeof value.summary !== "string") {
    fail("summary in publish_preview arguments must be a string");
  }
  const summary = (value.summary as string | undefined)?.trim() ?? "";
  if (byteLength(summary) > 2_000) fail("summary exceeds the publish_preview argument limit");
  const relativePath = requiredText(value, "relativePath", previewBundleContract.maximumPathBytes, false);
  const entrypoint = requiredText(value, "entrypoint", previewBundleContract.maximumPathBytes, false);
  if (/^[A-Za-z]:/.test(relativePath) || !validatePreviewBundlePath(relativePath).ok) {
    fail("relativePath must name one normalized directory beneath the bridge working root");
  }
  if (/^[A-Za-z]:/.test(entrypoint) || !validatePreviewBundlePath(entrypoint, { entrypoint: true }).ok) {
    fail("entrypoint must name one normalized HTML file in the preview directory");
  }
  const ttlSeconds = value.ttlSeconds ?? artifactPreviewTtlPolicy.defaultSeconds;
  if (typeof ttlSeconds !== "number" || !Number.isSafeInteger(ttlSeconds)
    || ttlSeconds < artifactPreviewTtlPolicy.minimumSeconds
    || ttlSeconds > artifactPreviewTtlPolicy.maximumLifetimeSeconds) {
    fail("ttlSeconds is outside the preview TTL policy");
  }
  return {
    threadId,
    relativePath,
    entrypoint,
    title,
    kind: previewBundleContract.artifactKind,
    mediaType: previewBundleContract.mediaType,
    summary,
    ttlSeconds,
    idempotencyKey
  };
}

function sameMetadata(
  metadata: Awaited<ReturnType<typeof lstat>> & { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint },
  identity: Pick<FileIdentity, "device" | "inode" | "size" | "mtimeNanoseconds" | "changeNanoseconds">
) {
  return metadata.dev === identity.device && metadata.ino === identity.inode && metadata.size === identity.size
    && metadata.mtimeNs === identity.mtimeNanoseconds && metadata.ctimeNs === identity.changeNanoseconds;
}

async function checkedFileDigest(
  absolutePath: string,
  expected: Awaited<ReturnType<typeof lstat>> & { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint },
  signal: AbortSignal | undefined
) {
  let handle;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino
      || opened.size !== expected.size || opened.mtimeNs !== expected.mtimeNs || opened.ctimeNs !== expected.ctimeNs) {
      fail("a preview source file changed while it was opened");
    }
    if (opened.size > BigInt(previewBundleContract.maximumFileBytes)) fail("a preview source file exceeds its size limit");
    const hash = createHash("sha256");
    let read = 0;
    while (true) {
      throwIfCancelled(signal);
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const result = await handle.read(chunk, 0, chunk.length, null);
      if (result.bytesRead === 0) break;
      read += result.bytesRead;
      if (read > previewBundleContract.maximumFileBytes) fail("a preview source file exceeds its size limit");
      hash.update(chunk.subarray(0, result.bytesRead));
    }
    const closed = await handle.stat({ bigint: true });
    if (read !== Number(opened.size) || closed.dev !== opened.dev || closed.ino !== opened.ino
      || closed.size !== opened.size || closed.mtimeNs !== opened.mtimeNs || closed.ctimeNs !== opened.ctimeNs) {
      fail("a preview source file changed while it was read");
    }
    return hash.digest("hex");
  } catch (error) {
    if (error instanceof LocalArtifactError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new LocalArtifactError("preview source entries must not be symbolic links", { cause: error });
    }
    throw new LocalArtifactError("a preview source file could not be read safely", { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function decodeName(name: Buffer) {
  try {
    return utf8.decode(name);
  } catch (error) {
    throw new LocalArtifactError("preview source names must be valid UTF-8", { cause: error });
  }
}

async function scanInventory(sourceRoot: string, signal: AbortSignal | undefined): Promise<Inventory> {
  const files: FileIdentity[] = [];
  const directories: DirectoryIdentity[] = [];
  const collisionKeys = new Set<string>();
  let expandedBytes = 0;
  let directoryEntries = 0;

  const walk = async (absoluteDirectory: string, archiveDirectory: string): Promise<void> => {
    throwIfCancelled(signal);
    const before = await lstat(absoluteDirectory, { bigint: true }).catch((error) => {
      throw new LocalArtifactError("the preview source directory is unavailable", { cause: error });
    });
    if (before.isSymbolicLink() || !before.isDirectory()) fail("the preview source must contain only real directories and regular files");
    // Directory-only trees need their own bound; reuse the v1 entry ceiling without changing its wire contract.
    if (archiveDirectory !== "") {
      directoryEntries += 1;
      if (directoryEntries > previewBundleContract.maximumRegularFiles) {
        fail("the preview source exceeds its directory-count limit");
      }
    }
    directories.push({
      path: archiveDirectory,
      absolutePath: absoluteDirectory,
      device: before.dev,
      inode: before.ino,
      mtimeNanoseconds: before.mtimeNs,
      changeNanoseconds: before.ctimeNs
    });
    const entries = await readdir(absoluteDirectory, { withFileTypes: true, encoding: "buffer" });
    entries.sort((left, right) => Buffer.compare(left.name, right.name));
    for (const entry of entries) {
      throwIfCancelled(signal);
      const name = decodeName(entry.name);
      const archivePath = archiveDirectory ? `${archiveDirectory}/${name}` : name;
      if (!validatePreviewBundlePath(archivePath).ok) fail("a preview source entry has an invalid archive path");
      const collisionKey = previewBundlePathCollisionKey(archivePath);
      if (collisionKeys.has(collisionKey)) fail("preview source paths collide under the archive path policy");
      collisionKeys.add(collisionKey);
      const absolutePath = join(absoluteDirectory, name);
      const metadata = await lstat(absolutePath, { bigint: true }).catch((error) => {
        throw new LocalArtifactError("a preview source entry disappeared during the walk", { cause: error });
      });
      if (metadata.isSymbolicLink()) fail("preview source entries must not be symbolic links");
      if (metadata.isDirectory()) {
        await walk(absolutePath, archivePath);
        continue;
      }
      if (!metadata.isFile()) fail("the preview source contains an unsupported special file");
      if (files.length >= previewBundleContract.maximumRegularFiles) fail("the preview source exceeds its file-count limit");
      if (metadata.size > BigInt(previewBundleContract.maximumFileBytes)) fail("a preview source file exceeds its size limit");
      const nextExpanded = expandedBytes + Number(metadata.size);
      if (!Number.isSafeInteger(nextExpanded) || nextExpanded > previewBundleContract.maximumExpandedBytes) {
        fail("the preview source exceeds its expanded-size limit");
      }
      const sha256 = await checkedFileDigest(absolutePath, metadata, signal);
      const after = await lstat(absolutePath, { bigint: true });
      if (!sameMetadata(after, {
        device: metadata.dev, inode: metadata.ino, size: metadata.size,
        mtimeNanoseconds: metadata.mtimeNs, changeNanoseconds: metadata.ctimeNs
      })) fail("a preview source file changed during the walk");
      files.push({
        path: archivePath,
        absolutePath,
        device: metadata.dev,
        inode: metadata.ino,
        size: metadata.size,
        mtimeNanoseconds: metadata.mtimeNs,
        changeNanoseconds: metadata.ctimeNs,
        sha256
      });
      expandedBytes = nextExpanded;
    }
    const after = await lstat(absoluteDirectory, { bigint: true });
    if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      fail("the preview source directory inventory changed during the walk");
    }
  };

  await walk(sourceRoot, "");
  files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  directories.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return { files, directories, expandedBytes };
}

function octal(value: number | bigint, length: number) {
  const encoded = value.toString(8);
  if (encoded.length > length - 1) fail("preview archive metadata exceeds the POSIX tar numeric bound");
  return `${encoded.padStart(length - 1, "0")}\0`;
}

function writeField(header: Buffer, offset: number, length: number, value: string) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) fail("preview archive metadata exceeds a POSIX tar field");
  bytes.copy(header, offset);
}

function ustarPath(path: string): { name: string; prefix: string } | undefined {
  if (byteLength(path) <= 100) return { name: path, prefix: "" };
  const separators = [...path.matchAll(/\//g)].map((match) => match.index!).reverse();
  for (const separator of separators) {
    const prefix = path.slice(0, separator);
    const name = path.slice(separator + 1);
    if (byteLength(prefix) <= 155 && byteLength(name) <= 100) return { name, prefix };
  }
  return undefined;
}

function tarHeader(path: string, size: number, type: "0" | "x") {
  const split = ustarPath(path);
  if (split === undefined) fail("preview archive path requires an unsupported tar spelling");
  const header = Buffer.alloc(512);
  writeField(header, 0, 100, split.name);
  writeField(header, 100, 8, octal(0o644, 8));
  writeField(header, 108, 8, octal(0, 8));
  writeField(header, 116, 8, octal(0, 8));
  writeField(header, 124, 12, octal(size, 12));
  writeField(header, 136, 12, octal(0, 12));
  header.fill(0x20, 148, 156);
  writeField(header, 156, 1, type);
  writeField(header, 257, 6, "ustar\0");
  writeField(header, 263, 2, "00");
  writeField(header, 329, 8, octal(0, 8));
  writeField(header, 337, 8, octal(0, 8));
  writeField(header, 345, 155, split.prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeField(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function paxRecord(path: string) {
  const payload = `path=${path}\n`;
  let length = byteLength(payload) + 2;
  while (true) {
    const candidate = `${length} ${payload}`;
    const actual = byteLength(candidate);
    if (actual === length) return Buffer.from(candidate, "utf8");
    length = actual;
  }
}

function padding(size: number) {
  const remainder = size % 512;
  return remainder === 0 ? undefined : Buffer.alloc(512 - remainder);
}

async function* tarChunks(inventory: Inventory, signal: AbortSignal | undefined): AsyncGenerator<Buffer> {
  for (const file of inventory.files) {
    throwIfCancelled(signal);
    const split = ustarPath(file.path);
    let storedPath = file.path;
    if (split === undefined) {
      const digest = createHash("sha256").update(file.path).digest("hex").slice(0, 20);
      const pax = paxRecord(file.path);
      yield tarHeader(`PaxHeaders.0/${digest}`, pax.length, "x");
      yield pax;
      const paxPadding = padding(pax.length);
      if (paxPadding !== undefined) yield paxPadding;
      storedPath = `PaxFiles.0/${digest}`;
    }
    yield tarHeader(storedPath, Number(file.size), "0");
    let handle;
    try {
      handle = await open(file.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || !sameMetadata(before, file)) fail("a preview source file changed before archive construction");
      const hash = createHash("sha256");
      let remaining = Number(file.size);
      while (remaining > 0) {
        throwIfCancelled(signal);
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) fail("a preview source file changed during archive construction");
        const bytes = chunk.subarray(0, bytesRead);
        hash.update(bytes);
        remaining -= bytesRead;
        yield bytes;
      }
      const extra = Buffer.allocUnsafe(1);
      if ((await handle.read(extra, 0, 1, null)).bytesRead !== 0) fail("a preview source file grew during archive construction");
      const after = await handle.stat({ bigint: true });
      if (!sameMetadata(after, file) || hash.digest("hex") !== file.sha256) {
        fail("a preview source file changed during archive construction");
      }
    } catch (error) {
      if (error instanceof LocalArtifactError) throw error;
      throw new LocalArtifactError("a preview source file could not be archived safely", { cause: error });
    } finally {
      await handle?.close().catch(() => undefined);
    }
    const filePadding = padding(Number(file.size));
    if (filePadding !== undefined) yield filePadding;
  }
  yield zeroBlock;
  yield zeroBlock;
}

async function buildArchive(inventory: Inventory, options: CaptureLocalPreviewOptions) {
  const { signal } = options;
  const chunks: Buffer[] = [];
  let compressedBytes = 0;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      compressedBytes += chunk.length;
      if (compressedBytes > previewBundleContract.maximumCompressedBytes) {
        callback(new LocalArtifactError("the preview archive exceeds its compressed-size limit"));
        return;
      }
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
  const gzip = options.archiveTransform?.() ?? createGzip({ level: zlibConstants.Z_BEST_COMPRESSION });
  try {
    await pipeline(Readable.from(tarChunks(inventory, signal)), gzip, sink, { signal });
  } catch (error) {
    if (error instanceof LocalArtifactError) throw error;
    if (signal?.aborted) fail("preview packaging was cancelled");
    throw new LocalArtifactError("the preview archive could not be finalized", { cause: error });
  }
  const result = Buffer.concat(chunks, compressedBytes);
  if (result.length < 10 || result[0] !== 0x1f || result[1] !== 0x8b) fail("the preview archive gzip header is malformed");
  // Node pins MTIME to zero and has no filename/comment; the OS marker varies by zlib build, so
  // normalize that non-semantic header byte after finalization before hashing or upload.
  result[9] = 255;
  if (inventory.expandedBytes > result.length * previewBundleContract.maximumExpansionRatio) {
    fail("the preview archive exceeds its expansion-ratio limit");
  }
  return result;
}

function inventoriesMatch(expected: Inventory, actual: Inventory) {
  if (expected.expandedBytes !== actual.expandedBytes || expected.files.length !== actual.files.length
    || expected.directories.length !== actual.directories.length) return false;
  return expected.files.every((file, index) => {
    const other = actual.files[index];
    return other !== undefined && file.path === other.path && file.device === other.device && file.inode === other.inode
      && file.size === other.size && file.mtimeNanoseconds === other.mtimeNanoseconds
      && file.changeNanoseconds === other.changeNanoseconds && file.sha256 === other.sha256;
  }) && expected.directories.every((directory, index) => {
    const other = actual.directories[index];
    return other !== undefined && directory.path === other.path && directory.device === other.device
      && directory.inode === other.inode && directory.mtimeNanoseconds === other.mtimeNanoseconds
      && directory.changeNanoseconds === other.changeNanoseconds;
  });
}

async function checkedSourceRoot(workingRoot: string, requestedPath: string) {
  const lexical = resolve(workingRoot, ...requestedPath.split("/"));
  if (!contained(workingRoot, lexical)) fail("relativePath escapes the bridge working root");
  let current = workingRoot;
  for (const segment of requestedPath.split("/")) {
    current = join(current, segment);
    const metadata = await lstat(current, { bigint: true }).catch((error) => {
      throw new LocalArtifactError("the preview source directory is unavailable", { cause: error });
    });
    if (metadata.isSymbolicLink()) fail("the preview source directory path must not contain symbolic links");
    if (!metadata.isDirectory()) fail("relativePath must name a real preview source directory");
  }
  const canonical = await realpath(lexical).catch((error) => {
    throw new LocalArtifactError("the preview source directory is unavailable", { cause: error });
  });
  if (canonical !== lexical || !contained(workingRoot, canonical)) {
    fail("the preview source directory does not resolve directly beneath the bridge working root");
  }
  return canonical;
}

/** Safely packages one directory under the already-canonical #60 bridge startup root. */
export async function captureLocalPreview(
  workingRoot: string,
  value: unknown,
  options: CaptureLocalPreviewOptions = {}
): Promise<CapturedLocalPreview> {
  const parsed = parseArguments(value);
  throwIfCancelled(options.signal);
  const sourceRoot = await checkedSourceRoot(workingRoot, parsed.relativePath);
  const inventory = await scanInventory(sourceRoot, options.signal);
  if (!inventory.files.some((file) => file.path === parsed.entrypoint)) {
    fail("entrypoint must name one captured regular preview file");
  }
  await options.afterInitialInventory?.();
  throwIfCancelled(options.signal);
  const bytes = await buildArchive(inventory, options);
  await options.afterArchive?.();
  throwIfCancelled(options.signal);
  const verified = await scanInventory(sourceRoot, options.signal);
  if (!inventoriesMatch(inventory, verified)) fail("the preview source inventory changed during packaging");
  return {
    bytes,
    registration: {
      ...parsed,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    }
  };
}
