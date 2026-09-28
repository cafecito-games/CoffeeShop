import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { createInflateRaw } from "node:zlib";
import {
  previewBundleArtifactKind,
  previewBundleAllowedEntryTypes,
  previewBundleContract,
  previewBundleMediaType,
  previewBundlePathCollisionKey,
  validatePreviewBundlePath,
  type Artifact,
  type ArtifactPreview,
  type ArtifactPreviewFailureCode,
  type ArtifactPreviewRecord
} from "@coffee-shop/protocol";
import { beginProcessing, failPreview, settleProcessing } from "./artifactPreviews.js";
import { CoordinationError } from "./coordinationError.js";
import {
  PreviewStorage,
  PreviewStorageError,
  type PreparationWorkspace,
  type PreparedPreviewFile,
  type PreparedPreviewIdentity,
  type PreparedPreviewManifest
} from "./previewStorage.js";
import type { Store } from "./store.js";

export type ArtifactIngestionErrorCode =
  | "not-found"
  | "invalid-type"
  | "upload-invalid"
  | "limit-exceeded"
  | "storage-conflict"
  | "processing-cancelled"
  | "processing-failed";

/** A bounded route/recovery diagnostic. No archive-controlled value is included in its message. */
export class ArtifactIngestionError extends Error {
  constructor(
    readonly code: ArtifactIngestionErrorCode,
    readonly failureCode: ArtifactPreviewFailureCode | undefined,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }

  get httpStatus() {
    switch (this.code) {
      case "not-found": return 404;
      case "invalid-type": return 400;
      case "upload-invalid":
      case "limit-exceeded": return 422;
      case "storage-conflict": return 409;
      case "processing-cancelled": return 409;
      case "processing-failed": return 500;
    }
  }
}

interface PreparePreviewInput extends PreparedPreviewIdentity {
  processingGeneration: number;
  compressedSize: number;
  signal?: AbortSignal;
}

interface UploadInput {
  artifactId: string;
  contentType: string | undefined;
  body: AsyncIterable<Uint8Array>;
  complete?: () => boolean;
  now?: () => string;
  signal?: AbortSignal;
}

class ArchiveFailure extends Error {
  constructor(readonly failureCode: ArtifactPreviewFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

const fixedFailureMessage: Record<ArtifactPreviewFailureCode, string> = {
  "upload-failed": "The preview upload did not match its registration",
  "bundle-invalid": "The preview bundle is malformed or unsupported",
  "path-invalid": "The preview bundle contains an unsafe or conflicting path",
  "entrypoint-invalid": "The preview entrypoint is not an exact regular file",
  "limit-exceeded": "The preview bundle exceeds a shared contract limit",
  "storage-conflict": "Immutable preview storage conflicts with its registered identity",
  "processing-cancelled": "Preview processing no longer owns the current generation",
  "processing-failed": "Preview processing failed locally"
};

const digestPattern = /^[a-f0-9]{64}$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function updateCrc32(value: number, bytes: Uint8Array) {
  let crc = value;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return crc >>> 0;
}

function gzipHeaderLength(bytes: Buffer) {
  if (bytes.length < 10 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8) {
    throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
  }
  const flags = bytes[3]!;
  if ((flags & 0xe0) !== 0) throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
  let offset = 10;
  const requireBytes = (length: number) => {
    if (offset + length > bytes.length) throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
  };
  if ((flags & 0x04) !== 0) {
    requireBytes(2);
    const length = bytes.readUInt16LE(offset);
    offset += 2;
    requireBytes(length);
    offset += length;
  }
  for (const flag of [0x08, 0x10]) {
    if ((flags & flag) === 0) continue;
    const ending = bytes.indexOf(0, offset);
    if (ending < 0) throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
    offset = ending + 1;
  }
  if ((flags & 0x02) !== 0) {
    requireBytes(2);
    const expected = bytes.readUInt16LE(offset);
    const actual = (updateCrc32(0xffffffff, bytes.subarray(0, offset)) ^ 0xffffffff) & 0xffff;
    if (actual !== expected) throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
    offset += 2;
  }
  return offset;
}

async function* inflateSingleGzip(bytes: Buffer, signal?: AbortSignal) {
  const headerLength = gzipHeaderLength(bytes);
  const inflater = createInflateRaw();
  let inflatedBytes = 0;
  let crc = 0xffffffff;
  let completed = false;
  inflater.end(bytes.subarray(headerLength));
  try {
    for await (const value of inflater) {
      if (signal?.aborted) throw new ArchiveFailure("processing-cancelled", fixedFailureMessage["processing-cancelled"]);
      const chunk = Buffer.from(value);
      inflatedBytes += chunk.length;
      if (!Number.isSafeInteger(inflatedBytes)
        || inflatedBytes > previewBundleContract.maximumCompressedBytes * previewBundleContract.maximumExpansionRatio) {
        throw new ArchiveFailure("limit-exceeded", fixedFailureMessage["limit-exceeded"]);
      }
      crc = updateCrc32(crc, chunk);
      yield chunk;
    }
    completed = true;
  } catch (error) {
    if (error instanceof ArchiveFailure) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "Z_DATA_ERROR" || code === "Z_BUF_ERROR" || code === "Z_NEED_DICT") {
      throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"], { cause: error });
    }
    throw new ArchiveFailure("processing-failed", fixedFailureMessage["processing-failed"], { cause: error });
  } finally {
    if (!completed) inflater.destroy();
  }
  const trailerOffset = headerLength + inflater.bytesWritten;
  if (trailerOffset + 8 > bytes.length) throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
  const expectedCrc = bytes.readUInt32LE(trailerOffset);
  const expectedSize = bytes.readUInt32LE(trailerOffset + 4);
  if (((crc ^ 0xffffffff) >>> 0) !== expectedCrc || (inflatedBytes >>> 0) !== expectedSize) {
    throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
  }
  for (const trailing of bytes.subarray(trailerOffset + 8)) {
    if (trailing !== 0) throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
  }
}

class StreamReader {
  private current = Buffer.alloc(0);
  private offset = 0;
  private done = false;

  constructor(private readonly iterator: AsyncIterator<Buffer>) {}

  private async nextChunk() {
    while (this.offset >= this.current.length && !this.done) {
      const next = await this.iterator.next();
      if (next.done) {
        this.done = true;
        this.current = Buffer.alloc(0);
        this.offset = 0;
      } else {
        this.current = Buffer.from(next.value);
        this.offset = 0;
      }
    }
  }

  async consume(length: number, consumer: (chunk: Buffer) => Promise<void> | void) {
    let remaining = length;
    while (remaining > 0) {
      await this.nextChunk();
      if (this.done) throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
      const available = Math.min(remaining, this.current.length - this.offset);
      const chunk = this.current.subarray(this.offset, this.offset + available);
      await consumer(chunk);
      this.offset += available;
      remaining -= available;
    }
  }

  async exact(length: number) {
    const result = Buffer.allocUnsafe(length);
    let offset = 0;
    await this.consume(length, (chunk) => {
      chunk.copy(result, offset);
      offset += chunk.length;
    });
    return result;
  }

  async requireZero(length: number) {
    await this.consume(length, (chunk) => {
      if (chunk.some((byte) => byte !== 0)) throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
    });
  }

  async drainZeros() {
    if (this.offset < this.current.length && this.current.subarray(this.offset).some((byte) => byte !== 0)) {
      throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
    }
    this.offset = this.current.length;
    while (!this.done) {
      const next = await this.iterator.next();
      if (next.done) {
        this.done = true;
        break;
      }
      if (Buffer.from(next.value).some((byte) => byte !== 0)) {
        throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
      }
    }
  }

  async close() {
    await this.iterator.return?.();
  }
}

function tarString(field: Buffer) {
  const zero = field.indexOf(0);
  const end = zero < 0 ? field.length : zero;
  if (zero >= 0 && field.subarray(zero).some((byte) => byte !== 0)) {
    throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
  }
  try {
    return decoder.decode(field.subarray(0, end));
  } catch (error) {
    throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"], { cause: error });
  }
}

function tarNumber(field: Buffer, required = true) {
  if ((field[0]! & 0x80) !== 0) throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
  const text = field.toString("ascii").replace(/\0.*$/s, "").trim();
  if (text === "" && !required) return 0;
  if (!/^[0-7]+$/.test(text)) throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new ArchiveFailure("limit-exceeded", fixedFailureMessage["limit-exceeded"]);
  return value;
}

interface TarHeader {
  name: string;
  type: string;
  size: number;
  linkName: string;
}

function parseTarHeader(block: Buffer): TarHeader {
  if (block.length !== 512) throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
  const expectedChecksum = tarNumber(block.subarray(148, 156));
  let actualChecksum = 0;
  for (let index = 0; index < block.length; index += 1) {
    actualChecksum += index >= 148 && index < 156 ? 0x20 : block[index]!;
  }
  if (actualChecksum !== expectedChecksum
    || !block.subarray(257, 263).equals(Buffer.from("ustar\0"))
    || !block.subarray(263, 265).equals(Buffer.from("00"))) {
    throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
  }
  tarNumber(block.subarray(100, 108), false);
  tarNumber(block.subarray(108, 116), false);
  tarNumber(block.subarray(116, 124), false);
  tarNumber(block.subarray(136, 148), false);
  const name = tarString(block.subarray(0, 100));
  const prefix = tarString(block.subarray(345, 500));
  return {
    name: prefix ? `${prefix}/${name}` : name,
    type: block[156] === 0 ? "0" : String.fromCharCode(block[156]!),
    size: tarNumber(block.subarray(124, 136)),
    linkName: tarString(block.subarray(157, 257))
  };
}

function parsePaxPath(bytes: Buffer) {
  let offset = 0;
  let path: string | undefined;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space <= offset) throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
    const lengthText = bytes.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length <= space - offset + 2 || offset + length > bytes.length) {
      throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
    }
    const record = bytes.subarray(space + 1, offset + length);
    if (record.at(-1) !== 0x0a) throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
    const equals = record.indexOf(0x3d);
    if (equals <= 0) throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
    const key = record.subarray(0, equals).toString("ascii");
    if (key !== "path" || path !== undefined) throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
    try {
      path = decoder.decode(record.subarray(equals + 1, record.length - 1));
    } catch (error) {
      throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"], { cause: error });
    }
    offset += length;
  }
  if (path === undefined) throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
  return path;
}

async function ensureDirectory(root: string, segments: string[]) {
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
      await chmod(current, 0o700);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new ArchiveFailure("storage-conflict", fixedFailureMessage["storage-conflict"]);
      }
    }
  }
  return current;
}

function paddingFor(size: number) {
  return (512 - (size % 512)) % 512;
}

async function writeAll(handle: FileHandle, chunk: Buffer) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
    if (bytesWritten === 0) throw new ArchiveFailure("processing-failed", fixedFailureMessage["processing-failed"]);
    offset += bytesWritten;
  }
}

async function extractTar(reader: StreamReader, workspace: PreparationWorkspace, input: PreparePreviewInput) {
  const files: PreparedPreviewFile[] = [];
  const paths = new Map<string, "regular-file" | "directory">();
  const ancestorSpellings = new Map<string, string>();
  let pendingPaxPath: string | undefined;
  let expandedBytes = 0;
  let sawFirstZero = false;

  const recordPath = (path: string, type: "regular-file" | "directory") => {
    const validated = validatePreviewBundlePath(path);
    if (!validated.ok) throw new ArchiveFailure("path-invalid", fixedFailureMessage["path-invalid"]);
    const key = previewBundlePathCollisionKey(path);
    if (paths.has(key)) throw new ArchiveFailure("path-invalid", fixedFailureMessage["path-invalid"]);
    const segments = path.split("/");
    for (let count = 1; count <= segments.length; count += 1) {
      const spelling = segments.slice(0, count).join("/");
      const ancestorKey = previewBundlePathCollisionKey(spelling);
      const previousSpelling = ancestorSpellings.get(ancestorKey);
      if (previousSpelling !== undefined && previousSpelling !== spelling) {
        throw new ArchiveFailure("path-invalid", fixedFailureMessage["path-invalid"]);
      }
      ancestorSpellings.set(ancestorKey, spelling);
    }
    for (let count = 1; count < segments.length; count += 1) {
      if (paths.get(previewBundlePathCollisionKey(segments.slice(0, count).join("/"))) === "regular-file") {
        throw new ArchiveFailure("path-invalid", fixedFailureMessage["path-invalid"]);
      }
    }
    if (type === "regular-file") {
      for (const existing of paths.keys()) {
        if (existing.startsWith(`${key}/`)) throw new ArchiveFailure("path-invalid", fixedFailureMessage["path-invalid"]);
      }
    }
    paths.set(key, type);
    return validated.value;
  };

  for (;;) {
    if (input.signal?.aborted) throw new ArchiveFailure("processing-cancelled", fixedFailureMessage["processing-cancelled"]);
    const block = await reader.exact(512);
    if (block.every((byte) => byte === 0)) {
      if (sawFirstZero) break;
      sawFirstZero = true;
      continue;
    }
    if (sawFirstZero) throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
    const header = parseTarHeader(block);
    if (header.type === "x") {
      if (pendingPaxPath !== undefined || header.linkName !== ""
        || header.size > previewBundleContract.maximumPathBytes + 64) {
        throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
      }
      pendingPaxPath = parsePaxPath(await reader.exact(header.size));
      await reader.requireZero(paddingFor(header.size));
      continue;
    }
    if (header.type !== "0" && header.type !== "5") {
      throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
    }
    if (header.linkName !== "" || (header.type === "5" && header.size !== 0)) {
      throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
    }
    const logicalType = header.type === "0" ? "regular-file" : "directory";
    if (!(previewBundleAllowedEntryTypes as readonly string[]).includes(logicalType)) {
      throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
    }
    const resolvedPath = recordPath(pendingPaxPath ?? header.name, logicalType);
    pendingPaxPath = undefined;
    if (header.type === "5") continue;

    if (header.size > previewBundleContract.maximumFileBytes
      || files.length + 1 > previewBundleContract.maximumRegularFiles) {
      throw new ArchiveFailure("limit-exceeded", fixedFailureMessage["limit-exceeded"]);
    }
    const nextExpanded = expandedBytes + header.size;
    if (!Number.isSafeInteger(nextExpanded) || nextExpanded > previewBundleContract.maximumExpandedBytes
      || nextExpanded > input.compressedSize * previewBundleContract.maximumExpansionRatio) {
      throw new ArchiveFailure("limit-exceeded", fixedFailureMessage["limit-exceeded"]);
    }
    expandedBytes = nextExpanded;
    const segments = resolvedPath.split("/");
    const parent = await ensureDirectory(workspace.contentDirectory, segments.slice(0, -1));
    let handle;
    try {
      handle = await open(join(parent, segments.at(-1)!),
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      const hash = createHash("sha256");
      let actualSize = 0;
      await reader.consume(header.size, async (chunk) => {
        actualSize += chunk.length;
        hash.update(chunk);
        await writeAll(handle!, chunk);
      });
      if (actualSize !== header.size) throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(join(parent, segments.at(-1)!), 0o600);
      await reader.requireZero(paddingFor(header.size));
      files.push({ path: resolvedPath, size: actualSize, sha256: hash.digest("hex") });
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (error instanceof ArchiveFailure) throw error;
      if ((error as NodeJS.ErrnoException).code === "EEXIST" || (error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new ArchiveFailure("storage-conflict", fixedFailureMessage["storage-conflict"], { cause: error });
      }
      throw new ArchiveFailure("processing-failed", fixedFailureMessage["processing-failed"], { cause: error });
    }
  }
  if (pendingPaxPath !== undefined) throw new ArchiveFailure("bundle-invalid", fixedFailureMessage["bundle-invalid"]);
  await reader.drainZeros();
  if (!files.some((file) => file.path === input.entrypoint)) {
    throw new ArchiveFailure("entrypoint-invalid", fixedFailureMessage["entrypoint-invalid"]);
  }
  files.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  return files;
}

function preparationError(error: unknown): ArtifactIngestionError {
  if (error instanceof ArtifactIngestionError) return error;
  if (error instanceof CoordinationError) {
    if (["preview_expired", "generation_mismatch", "invalid_transition", "idempotency_conflict"].includes(error.code)) {
      return new ArtifactIngestionError(
        "processing-cancelled", "processing-cancelled", fixedFailureMessage["processing-cancelled"], { cause: error }
      );
    }
    if (["artifact_mismatch", "artifact_not_uploaded"].includes(error.code)) {
      return new ArtifactIngestionError("storage-conflict", "storage-conflict", fixedFailureMessage["storage-conflict"], { cause: error });
    }
    return new ArtifactIngestionError("processing-failed", "processing-failed", fixedFailureMessage["processing-failed"], { cause: error });
  }
  if (error instanceof ArchiveFailure) {
    const code: ArtifactIngestionErrorCode = error.failureCode === "storage-conflict"
      ? "storage-conflict"
      : error.failureCode === "processing-cancelled"
        ? "processing-cancelled"
        : error.failureCode === "limit-exceeded"
          ? "limit-exceeded"
          : error.failureCode === "processing-failed"
            ? "processing-failed"
            : "upload-invalid";
    return new ArtifactIngestionError(code, error.failureCode, fixedFailureMessage[error.failureCode], { cause: error });
  }
  if (error instanceof PreviewStorageError) {
    const failureCode: ArtifactPreviewFailureCode = error.code === "storage-conflict"
      ? "storage-conflict"
      : error.code === "limit-exceeded"
        ? "limit-exceeded"
        : "processing-failed";
    const code: ArtifactIngestionErrorCode = failureCode === "storage-conflict"
      ? "storage-conflict"
      : failureCode === "limit-exceeded"
        ? "limit-exceeded"
        : "processing-failed";
    return new ArtifactIngestionError(code, failureCode, fixedFailureMessage[failureCode], { cause: error });
  }
  return new ArtifactIngestionError("processing-failed", "processing-failed", fixedFailureMessage["processing-failed"], { cause: error });
}

export async function preparePreviewBundle(storage: PreviewStorage, input: PreparePreviewInput) {
  if (!Number.isSafeInteger(input.compressedSize) || input.compressedSize <= 0
    || input.compressedSize > previewBundleContract.maximumCompressedBytes
    || !Number.isSafeInteger(input.processingGeneration) || input.processingGeneration < 1
    || !digestPattern.test(input.artifactSha256)
    || !validatePreviewBundlePath(input.entrypoint, { entrypoint: true }).ok) {
    throw new ArtifactIngestionError("storage-conflict", "storage-conflict", fixedFailureMessage["storage-conflict"]);
  }
  const identity: PreparedPreviewIdentity = {
    previewId: input.previewId,
    artifactId: input.artifactId,
    artifactSha256: input.artifactSha256,
    entrypoint: input.entrypoint
  };
  try {
    if (await storage.verifyArtifact({ id: input.artifactId, size: input.compressedSize, sha256: input.artifactSha256 }) !== "exact") {
      throw new PreviewStorageError("storage-conflict", fixedFailureMessage["storage-conflict"]);
    }
    const existing = await storage.verifyPrepared(identity, input.compressedSize);
    if (existing !== undefined) return { replayed: true, manifest: existing };
    const compressed = await storage.readArtifact(input.artifactId);
    if (compressed.length !== input.compressedSize || createHash("sha256").update(compressed).digest("hex") !== input.artifactSha256) {
      throw new PreviewStorageError("storage-conflict", fixedFailureMessage["storage-conflict"]);
    }
    const workspace = await storage.createPreparationWorkspace({
      ...identity,
      processingGeneration: input.processingGeneration
    });
    try {
      const inflated = inflateSingleGzip(compressed, input.signal);
      const reader = new StreamReader(inflated[Symbol.asyncIterator]());
      let files: PreparedPreviewFile[];
      try {
        files = await extractTar(reader, workspace, input);
      } finally {
        await reader.close();
      }
      const manifest: PreparedPreviewManifest = { schemaVersion: 1, ...identity, files };
      return await storage.publishPrepared(workspace, manifest, input.compressedSize);
    } catch (error) {
      await storage.cleanupPreparationWorkspace(workspace).catch((cleanupError) => {
        throw new PreviewStorageError("storage-conflict", "Owned preparation staging could not be cleaned", { cause: cleanupError });
      });
      throw error;
    }
  } catch (error) {
    throw preparationError(error);
  }
}

function sameActor(left: Artifact | ArtifactPreviewRecord, right: Artifact | ArtifactPreviewRecord) {
  return left.agentId === right.agentId && left.instanceId === right.instanceId && left.allocationId === right.allocationId;
}

function resolveUpload(store: Store, artifactId: string) {
  return store.read((state) => {
    const artifacts = (state.artifacts ?? []).filter((item) => item.id === artifactId);
    if (artifacts.length !== 1) throw new ArtifactIngestionError("not-found", undefined, "Artifact not found");
    const artifact = structuredClone(artifacts[0]!);
    const linked = (state.artifactPreviews ?? []).filter((preview) => preview.artifactId === artifact.id);
    if (artifact.kind !== previewBundleArtifactKind) {
      if (linked.length !== 0) throw new ArtifactIngestionError("storage-conflict", "storage-conflict", fixedFailureMessage["storage-conflict"]);
      return { artifact };
    }
    const preview = linked[0];
    if (linked.length !== 1 || preview === undefined || artifact.mediaType !== previewBundleMediaType
      || preview.artifactSha256 !== artifact.sha256 || preview.threadId !== artifact.threadId
      || preview.runId !== artifact.runId || !sameActor(preview, artifact)) {
      throw new ArtifactIngestionError("storage-conflict", "storage-conflict", fixedFailureMessage["storage-conflict"]);
    }
    return { artifact, preview: structuredClone(preview) };
  });
}

async function recordUploadFailure(store: Store, preview: ArtifactPreviewRecord | undefined, at: string) {
  if (preview === undefined) return;
  const current = store.read((state) => state.artifactPreviews?.find((item) => item.id === preview.id));
  if (current?.processingGeneration !== 0 || (current.status !== "upload-pending" && current.status !== "failed")) return;
  try {
    await failPreview(store, preview.id, "upload-failed", at);
  } catch (error) {
    if (!(error instanceof CoordinationError && ["invalid_transition", "preview_expired"].includes(error.code))) throw error;
  }
}

async function markUploaded(store: Store, expected: Artifact) {
  let found = false;
  await store.transact((state) => {
    const artifact = state.artifacts?.find((item) => item.id === expected.id);
    if (!artifact || artifact.size !== expected.size || artifact.sha256 !== expected.sha256
      || artifact.kind !== expected.kind || artifact.mediaType !== expected.mediaType
      || artifact.threadId !== expected.threadId || artifact.runId !== expected.runId || !sameActor(artifact, expected)
      || artifact.relativePath !== expected.relativePath || artifact.title !== expected.title
      || artifact.summary !== expected.summary || artifact.downloadPath !== expected.downloadPath
      || artifact.idempotencyKey !== expected.idempotencyKey || artifact.createdAt !== expected.createdAt) {
      throw new ArtifactIngestionError("storage-conflict", "storage-conflict", fixedFailureMessage["storage-conflict"]);
    }
    found = true;
    if (artifact.uploaded) return false;
    artifact.uploaded = true;
  });
  if (!found) throw new ArtifactIngestionError("storage-conflict", "storage-conflict", fixedFailureMessage["storage-conflict"]);
}

/** Crash-recovery primitive: verifies an already committed immutable blob before persisting uploaded. */
export async function reconcileArtifactBlob(store: Store, storage: PreviewStorage, artifactId: string) {
  const resolved = resolveUpload(store, artifactId);
  try {
    const verified = await storage.verifyArtifact({
      id: resolved.artifact.id,
      size: resolved.artifact.size,
      sha256: resolved.artifact.sha256
    });
    if (verified !== "exact") {
      throw new ArtifactIngestionError("storage-conflict", "storage-conflict", fixedFailureMessage["storage-conflict"]);
    }
    await markUploaded(store, resolved.artifact);
    return resolved;
  } catch (error) {
    throw preparationError(error);
  }
}

async function processPreview(
  store: Store,
  storage: PreviewStorage,
  artifact: Artifact,
  preview: ArtifactPreviewRecord,
  now: () => string,
  signal?: AbortSignal
) {
  const current = store.read((state) => state.artifactPreviews?.find((item) => item.id === preview.id));
  if (current?.status === "ready") {
    const manifest = await storage.verifyPrepared({
      previewId: current.id, artifactId: artifact.id, artifactSha256: artifact.sha256, entrypoint: current.entrypoint
    }, artifact.size).catch((error) => { throw preparationError(error); });
    if (manifest === undefined) throw new ArtifactIngestionError("storage-conflict", "storage-conflict", fixedFailureMessage["storage-conflict"]);
    return { kind: "preview" as const, replayed: true, manifest };
  }
  let processing;
  try {
    processing = await beginProcessing(store, preview.id, now());
  } catch (error) {
    if (error instanceof CoordinationError && error.code === "preview_expired") {
      throw new ArtifactIngestionError("processing-cancelled", "processing-cancelled", fixedFailureMessage["processing-cancelled"]);
    }
    throw error;
  }
  try {
    const prepared = await preparePreviewBundle(storage, {
      previewId: preview.id,
      artifactId: artifact.id,
      artifactSha256: artifact.sha256,
      entrypoint: preview.entrypoint,
      processingGeneration: processing.generation,
      compressedSize: artifact.size,
      signal
    });
    await settleProcessing(store, {
      previewId: preview.id, artifactId: artifact.id, artifactSha256: artifact.sha256,
      processingGeneration: processing.generation, outcome: "ready", at: now()
    });
    return { kind: "preview" as const, replayed: processing.replayed || prepared.replayed, manifest: prepared.manifest };
  } catch (error) {
    const classified = preparationError(error);
    if (classified.failureCode !== undefined) {
      try {
        await settleProcessing(store, {
          previewId: preview.id, artifactId: artifact.id, artifactSha256: artifact.sha256,
          processingGeneration: processing.generation, outcome: "failed", failureCode: classified.failureCode, at: now()
        });
      } catch (settlementError) {
        if (!(settlementError instanceof CoordinationError
          && ["generation_mismatch", "invalid_transition", "preview_expired", "idempotency_conflict"].includes(settlementError.code))) {
          throw settlementError;
        }
      }
    }
    throw classified;
  }
}

function resolvePreviewRetry(store: Store, previewId: string) {
  return store.read((state) => {
    const previews = (state.artifactPreviews ?? []).filter((item) => item.id === previewId);
    if (previews.length === 0) throw new CoordinationError("not_found", "Preview not found");
    if (previews.length !== 1) throw new CoordinationError("artifact_mismatch", "The preview identity is inconsistent");
    const preview = previews[0]!;
    const linkedPreviews = (state.artifactPreviews ?? []).filter((item) => item.artifactId === preview.artifactId);
    const artifacts = (state.artifacts ?? []).filter((item) => item.id === preview.artifactId);
    const artifact = artifacts[0];
    if (linkedPreviews.length !== 1 || artifacts.length !== 1 || artifact === undefined
      || !artifact.uploaded || artifact.kind !== previewBundleArtifactKind || artifact.mediaType !== previewBundleMediaType
      || artifact.sha256 !== preview.artifactSha256 || artifact.threadId !== preview.threadId
      || artifact.runId !== preview.runId || !sameActor(artifact, preview)) {
      throw new CoordinationError("artifact_mismatch", "The preview artifact is unavailable");
    }
    if (preview.status !== "failed" && preview.status !== "processing") {
      throw new CoordinationError("invalid_transition", "The preview cannot be retried from its current status");
    }
    return { artifact: structuredClone(artifact), preview: structuredClone(preview) };
  });
}

export interface RetryPreviewPreparationOptions {
  readonly now?: () => string;
  readonly onCommitted?: (preview: ArtifactPreview) => void;
}

/** Retries preparation from the retained immutable artifact without accepting browser-owned identity. */
export async function retryPreviewPreparation(
  store: Store,
  storage: PreviewStorage,
  previewId: string,
  options: RetryPreviewPreparationOptions = {}
) {
  const now = options.now ?? (() => new Date().toISOString());
  const resolved = resolvePreviewRetry(store, previewId);
  const processing = await beginProcessing(store, resolved.preview.id, now());
  if (processing.replayed) return { preview: processing.preview, replayed: true } as const;
  options.onCommitted?.(processing.preview);
  let ready: ArtifactPreview;
  let readyCommitted = false;
  try {
    await preparePreviewBundle(storage, {
      previewId: resolved.preview.id,
      artifactId: resolved.artifact.id,
      artifactSha256: resolved.artifact.sha256,
      entrypoint: resolved.preview.entrypoint,
      processingGeneration: processing.generation,
      compressedSize: resolved.artifact.size
    });
    const settled = await settleProcessing(store, {
      previewId: resolved.preview.id,
      artifactId: resolved.artifact.id,
      artifactSha256: resolved.artifact.sha256,
      processingGeneration: processing.generation,
      outcome: "ready",
      at: now()
    });
    ready = settled.preview;
    readyCommitted = !settled.replayed;
  } catch (error) {
    const classified = preparationError(error);
    if (classified.failureCode !== undefined) {
      try {
        const settled = await settleProcessing(store, {
          previewId: resolved.preview.id,
          artifactId: resolved.artifact.id,
          artifactSha256: resolved.artifact.sha256,
          processingGeneration: processing.generation,
          outcome: "failed",
          failureCode: classified.failureCode,
          at: now()
        });
        if (!settled.replayed) options.onCommitted?.(settled.preview);
      } catch (settlementError) {
        if (!(settlementError instanceof CoordinationError
          && ["generation_mismatch", "invalid_transition", "preview_expired", "idempotency_conflict"].includes(settlementError.code))) {
          throw settlementError;
        }
      }
    }
    throw classified;
  }
  if (readyCommitted) options.onCommitted?.(ready);
  return { preview: ready, replayed: false } as const;
}

export async function ingestArtifactContent(store: Store, storage: PreviewStorage, input: UploadInput) {
  const now = input.now ?? (() => new Date().toISOString());
  const resolved = resolveUpload(store, input.artifactId);
  if (input.contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/octet-stream") {
    await recordUploadFailure(store, resolved.preview, now());
    throw new ArtifactIngestionError("invalid-type", "upload-failed", "Artifact content must be application/octet-stream");
  }
  let replayed = false;
  try {
    replayed = (await storage.ingestArtifact(input.body, {
      id: resolved.artifact.id,
      size: resolved.artifact.size,
      sha256: resolved.artifact.sha256,
      maximumBytes: previewBundleContract.maximumCompressedBytes
    }, input.complete)).replayed;
  } catch (error) {
    const classified = preparationError(error);
    if (error instanceof PreviewStorageError && (error.code === "upload-invalid" || error.code === "limit-exceeded")) {
      await recordUploadFailure(store, resolved.preview, now());
      throw new ArtifactIngestionError(error.code, "upload-failed", fixedFailureMessage["upload-failed"], { cause: error });
    }
    if (error instanceof PreviewStorageError && error.code === "storage-conflict" && resolved.preview !== undefined) {
      const current = store.read((state) => ({
        artifact: structuredClone(state.artifacts?.find((item) => item.id === resolved.artifact.id)),
        preview: structuredClone(state.artifactPreviews?.find((item) => item.id === resolved.preview!.id))
      }));
      if (current.artifact?.uploaded && current.preview
        && (current.preview.status === "upload-pending" || current.preview.status === "processing")) {
        await settleRecoveryFailure(store, current.artifact, current.preview, "storage-conflict", now());
      }
    }
    throw classified;
  }
  await markUploaded(store, resolved.artifact);
  if (resolved.preview === undefined) return { kind: "ordinary" as const, replayed };
  return processPreview(store, storage, resolved.artifact, resolved.preview, now, input.signal);
}

async function settleRecoveryFailure(
  store: Store,
  artifact: Artifact,
  preview: ArtifactPreviewRecord,
  failureCode: ArtifactPreviewFailureCode,
  at: string
) {
  try {
    const processing = await beginProcessing(store, preview.id, at);
    await settleProcessing(store, {
      previewId: preview.id, artifactId: artifact.id, artifactSha256: artifact.sha256,
      processingGeneration: processing.generation, outcome: "failed", failureCode, at
    });
  } catch (error) {
    if (!(error instanceof CoordinationError
      && ["preview_expired", "invalid_transition", "generation_mismatch", "idempotency_conflict"].includes(error.code))) {
      throw preparationError(error);
    }
  }
}

/** Reconciles durable lifecycle state and immutable local storage before the server listens. */
export async function recoverPreviewPreparation(
  store: Store,
  storage: PreviewStorage,
  now: () => string = () => new Date().toISOString()
) {
  try {
    await storage.cleanupOwnedStaging();
  } catch (error) {
    throw preparationError(error);
  }
  const previews = store.read((state) => structuredClone(state.artifactPreviews ?? []));
  for (const preview of previews) {
    if (preview.status === "failed" || preview.status === "expired") continue;
    const artifact = store.read((state) => structuredClone(state.artifacts?.find((item) => item.id === preview.artifactId)));
    if (!artifact) throw new ArtifactIngestionError("storage-conflict", "storage-conflict", fixedFailureMessage["storage-conflict"]);
    let blob: "exact" | "absent";
    try {
      blob = await storage.verifyArtifact({ id: artifact.id, size: artifact.size, sha256: artifact.sha256 });
    } catch (error) {
      if (preview.status === "ready") throw preparationError(error);
      await settleRecoveryFailure(store, artifact, preview, "storage-conflict", now());
      continue;
    }
    if (blob === "absent") {
      if (!artifact.uploaded) continue;
      if (preview.status === "ready") {
        throw new ArtifactIngestionError("storage-conflict", "storage-conflict", fixedFailureMessage["storage-conflict"]);
      }
      await settleRecoveryFailure(store, artifact, preview, "storage-conflict", now());
      continue;
    }
    if (!artifact.uploaded) await markUploaded(store, artifact);
    const current = store.read((state) => structuredClone(state.artifactPreviews?.find((item) => item.id === preview.id)));
    if (!current) throw new ArtifactIngestionError("storage-conflict", "storage-conflict", fixedFailureMessage["storage-conflict"]);
    if (current.status === "ready") {
      let prepared;
      try {
        prepared = await storage.verifyPrepared({
          previewId: current.id, artifactId: artifact.id, artifactSha256: artifact.sha256, entrypoint: current.entrypoint
        }, artifact.size);
      } catch (error) {
        throw preparationError(error);
      }
      if (prepared === undefined) {
        throw new ArtifactIngestionError("storage-conflict", "storage-conflict", fixedFailureMessage["storage-conflict"]);
      }
      continue;
    }
    if (current.status !== "upload-pending" && current.status !== "processing") continue;
    try {
      await processPreview(store, storage, artifact, current, now);
    } catch (error) {
      const classified = preparationError(error);
      if (classified.code === "storage-conflict" || classified.code === "processing-failed") continue;
      if (classified.code === "processing-cancelled") continue;
      continue;
    }
  }
}
