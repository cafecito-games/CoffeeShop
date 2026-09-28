import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  type FileHandle
} from "node:fs/promises";
import { basename, join } from "node:path";
import {
  previewBundleContract,
  previewBundlePathCollisionKey,
  validatePreviewBundlePath
} from "@coffee-shop/protocol";

export type PreviewStorageErrorCode =
  | "upload-invalid"
  | "limit-exceeded"
  | "storage-conflict"
  | "processing-failed";

/** A closed storage classification. Messages deliberately contain no archive-controlled text. */
export class PreviewStorageError extends Error {
  constructor(readonly code: PreviewStorageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export interface ArtifactBlobExpectation {
  id: string;
  size: number;
  sha256: string;
  maximumBytes: number;
}

export interface PreparedPreviewIdentity {
  previewId: string;
  artifactId: string;
  artifactSha256: string;
  entrypoint: string;
}

export interface PreparationIdentity extends PreparedPreviewIdentity {
  processingGeneration: number;
}

export interface PreparedPreviewFile {
  path: string;
  size: number;
  sha256: string;
}

export interface PreparedPreviewManifest extends PreparedPreviewIdentity {
  schemaVersion: 1;
  files: PreparedPreviewFile[];
}

export interface VerifiedPreparedPreviewFile {
  readonly bytes: Buffer;
  readonly file: PreparedPreviewFile;
  readonly manifest: PreparedPreviewManifest;
}

interface UploadMarker {
  schemaVersion: 1;
  kind: "upload";
  rootName: string;
  artifactId: string;
  artifactSha256: string;
  artifactSize: number;
}

interface PreparationMarker extends PreparationIdentity {
  schemaVersion: 1;
  kind: "preparation";
  rootName: string;
}

type StagingMarker = UploadMarker | PreparationMarker;

export interface PreparationWorkspace {
  readonly rootDirectory: string;
  readonly publicationDirectory: string;
  readonly contentDirectory: string;
  readonly identity: PreparationIdentity;
}

const markerName = ".coffee-shop-preview-staging.json";
const manifestName = "manifest.json";
const segmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const markerKeys = {
  upload: ["schemaVersion", "kind", "rootName", "artifactId", "artifactSha256", "artifactSize"],
  preparation: [
    "schemaVersion", "kind", "rootName", "previewId", "artifactId", "artifactSha256", "entrypoint",
    "processingGeneration"
  ]
} as const;
const manifestKeys = ["schemaVersion", "previewId", "artifactId", "artifactSha256", "entrypoint", "files"] as const;
const manifestFileKeys = ["path", "size", "sha256"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

function safeSegment(value: string, label: string) {
  if (!segmentPattern.test(value) || value === "." || value === "..") {
    throw new PreviewStorageError("storage-conflict", `${label} is not a safe storage identifier`);
  }
  return value;
}

function safeDigest(value: string) {
  if (!digestPattern.test(value)) {
    throw new PreviewStorageError("storage-conflict", "Artifact digest is not a storage identity");
  }
  return value;
}

function assertIdentity(identity: PreparedPreviewIdentity) {
  safeSegment(identity.previewId, "Preview id");
  safeSegment(identity.artifactId, "Artifact id");
  safeDigest(identity.artifactSha256);
  if (!validatePreviewBundlePath(identity.entrypoint, { entrypoint: true }).ok) {
    throw new PreviewStorageError("storage-conflict", "Prepared preview entrypoint is invalid");
  }
}

const canonicalJson = (value: unknown) => `${JSON.stringify(value)}\n`;

async function writeAll(handle: FileHandle, chunk: Buffer) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
    if (bytesWritten === 0) throw new PreviewStorageError("processing-failed", "Stored content could not be written");
    offset += bytesWritten;
  }
}

async function fsyncDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function hashRegularFile(path: string) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new PreviewStorageError("storage-conflict", "Stored content is not a regular file");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < metadata.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, metadata.size - position), position);
      if (bytesRead === 0) throw new PreviewStorageError("storage-conflict", "Stored content ended unexpectedly");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return {
      size: metadata.size,
      sha256: hash.digest("hex"),
      mode: metadata.mode & 0o777,
      device: metadata.dev,
      inode: metadata.ino
    };
  } catch (error) {
    if (error instanceof PreviewStorageError) throw error;
    throw new PreviewStorageError("storage-conflict", "Stored content could not be verified", { cause: error });
  } finally {
    await handle?.close();
  }
}

function parseMarker(value: unknown, expectedRootName: string): StagingMarker {
  if (!isRecord(value) || value.schemaVersion !== 1 || (value.kind !== "upload" && value.kind !== "preparation")
    || !hasExactKeys(value, markerKeys[value.kind]) || value.rootName !== expectedRootName) {
    throw new PreviewStorageError("storage-conflict", "Preview staging marker is malformed");
  }
  if (typeof value.artifactId !== "string" || typeof value.artifactSha256 !== "string") {
    throw new PreviewStorageError("storage-conflict", "Preview staging marker identity is malformed");
  }
  safeSegment(value.artifactId, "Artifact id");
  safeDigest(value.artifactSha256);
  if (value.kind === "upload") {
    if (!Number.isSafeInteger(value.artifactSize) || (value.artifactSize as number) < 0) {
      throw new PreviewStorageError("storage-conflict", "Upload staging marker size is malformed");
    }
    return value as unknown as UploadMarker;
  }
  if (typeof value.previewId !== "string" || typeof value.entrypoint !== "string"
    || !Number.isSafeInteger(value.processingGeneration) || (value.processingGeneration as number) < 1) {
    throw new PreviewStorageError("storage-conflict", "Preparation staging marker identity is malformed");
  }
  assertIdentity(value as unknown as PreparedPreviewIdentity);
  return value as unknown as PreparationMarker;
}

function normalizeManifest(value: unknown, identity: PreparedPreviewIdentity): PreparedPreviewManifest {
  if (!isRecord(value) || !hasExactKeys(value, manifestKeys) || value.schemaVersion !== 1
    || value.previewId !== identity.previewId || value.artifactId !== identity.artifactId
    || value.artifactSha256 !== identity.artifactSha256 || value.entrypoint !== identity.entrypoint
    || !Array.isArray(value.files)) {
    throw new PreviewStorageError("storage-conflict", "Prepared preview manifest identity is invalid");
  }
  const files: PreparedPreviewFile[] = [];
  const exactPaths = new Set<string>();
  const collisionKeys = new Set<string>();
  const ancestorSpellings = new Map<string, string>();
  let totalBytes = 0;
  if (value.files.length > previewBundleContract.maximumRegularFiles) {
    throw new PreviewStorageError("storage-conflict", "Prepared preview manifest exceeds its file limit");
  }
  for (const item of value.files) {
    if (!isRecord(item) || !hasExactKeys(item, manifestFileKeys) || typeof item.path !== "string"
      || !validatePreviewBundlePath(item.path).ok || !Number.isSafeInteger(item.size) || (item.size as number) < 0
      || typeof item.sha256 !== "string" || !digestPattern.test(item.sha256)) {
      throw new PreviewStorageError("storage-conflict", "Prepared preview manifest inventory is invalid");
    }
    if ((item.size as number) > previewBundleContract.maximumFileBytes) {
      throw new PreviewStorageError("storage-conflict", "Prepared preview manifest exceeds its file limit");
    }
    totalBytes += item.size as number;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > previewBundleContract.maximumExpandedBytes) {
      throw new PreviewStorageError("storage-conflict", "Prepared preview manifest exceeds its expanded limit");
    }
    const key = previewBundlePathCollisionKey(item.path);
    if (exactPaths.has(item.path) || collisionKeys.has(key)
      || [...collisionKeys].some((existing) => key.startsWith(`${existing}/`) || existing.startsWith(`${key}/`))) {
      throw new PreviewStorageError("storage-conflict", "Prepared preview manifest repeats a path");
    }
    exactPaths.add(item.path);
    collisionKeys.add(key);
    const segments = item.path.split("/");
    for (let count = 1; count <= segments.length; count += 1) {
      const spelling = segments.slice(0, count).join("/");
      const ancestorKey = previewBundlePathCollisionKey(spelling);
      const previous = ancestorSpellings.get(ancestorKey);
      if (previous !== undefined && previous !== spelling) {
        throw new PreviewStorageError("storage-conflict", "Prepared preview manifest has an ancestor collision");
      }
      ancestorSpellings.set(ancestorKey, spelling);
    }
    files.push({ path: item.path, size: item.size as number, sha256: item.sha256 });
  }
  const sorted = [...files].sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  if (files.some((file, index) => file.path !== sorted[index]?.path)
    || !files.some((file) => file.path === identity.entrypoint)) {
    throw new PreviewStorageError("storage-conflict", "Prepared preview manifest is not canonical");
  }
  return { schemaVersion: 1, ...identity, files };
}

/** Hub-local immutable artifact and prepared-preview storage. */
export class PreviewStorage {
  readonly artifactDirectory: string;
  readonly stagingDirectory: string;
  readonly preparedDirectory: string;
  private publicationQueue: Promise<void> = Promise.resolve();

  constructor(readonly rootDirectory: string) {
    this.artifactDirectory = join(rootDirectory, "artifacts");
    this.stagingDirectory = join(rootDirectory, "preview-staging");
    this.preparedDirectory = join(rootDirectory, "prepared-previews");
  }

  private artifactPath(id: string) {
    return join(this.artifactDirectory, safeSegment(id, "Artifact id"));
  }

  private preparedPath(identity: PreparedPreviewIdentity) {
    assertIdentity(identity);
    return join(this.preparedDirectory, identity.previewId, identity.artifactSha256);
  }

  private async ensureRealDirectory(path: string, recursive = false) {
    try {
      await mkdir(path, { recursive, mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new PreviewStorageError("storage-conflict", "Storage directory is not an owned directory");
    }
    await chmod(path, 0o700);
  }

  private async requireRealDirectory(path: string) {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new PreviewStorageError("storage-conflict", "Storage directory is not an owned directory");
    }
  }

  private async createStage(prefix: "upload" | "prepare") {
    await this.ensureRealDirectory(this.rootDirectory, true);
    await this.ensureRealDirectory(this.stagingDirectory);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const rootName = `${prefix}-${randomUUID()}`;
      const path = join(this.stagingDirectory, rootName);
      try {
        await mkdir(path, { mode: 0o700 });
        return { path, rootName };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    throw new PreviewStorageError("processing-failed", "Could not allocate preview staging");
  }

  private async writeMarker(root: string, marker: StagingMarker) {
    const handle = await open(join(root, markerName), "wx", 0o600);
    try {
      await handle.writeFile(canonicalJson(marker));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsyncDirectory(root);
  }

  private async readMarker(root: string) {
    let metadata;
    try {
      metadata = await lstat(join(root, markerName));
    } catch (error) {
      throw new PreviewStorageError("storage-conflict", "Preview staging marker is missing", { cause: error });
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > previewBundleContract.maximumPathBytes * 4) {
      throw new PreviewStorageError("storage-conflict", "Preview staging marker is not a regular file");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(root, markerName), "utf8"));
    } catch (error) {
      throw new PreviewStorageError("storage-conflict", "Preview staging marker is malformed", { cause: error });
    }
    return parseMarker(parsed, basename(root));
  }

  private async removeOwnedStage(root: string, expected?: StagingMarker) {
    const rootMetadata = await lstat(root);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new PreviewStorageError("storage-conflict", "Preview staging root is not an owned directory");
    }
    const marker = await this.readMarker(root);
    if (expected !== undefined && canonicalJson(marker) !== canonicalJson(expected)) {
      throw new PreviewStorageError("storage-conflict", "Preview staging ownership changed");
    }
    await rm(root, { recursive: true });
    await fsyncDirectory(this.stagingDirectory);
  }

  async ingestArtifact(
    input: AsyncIterable<Uint8Array>,
    expectation: ArtifactBlobExpectation,
    complete: () => boolean = () => true
  ) {
    safeSegment(expectation.id, "Artifact id");
    safeDigest(expectation.sha256);
    if (!Number.isSafeInteger(expectation.size) || expectation.size < 0
      || !Number.isSafeInteger(expectation.maximumBytes) || expectation.maximumBytes < 0) {
      throw new PreviewStorageError("upload-invalid", "Artifact upload expectation is invalid");
    }
    if (expectation.size > expectation.maximumBytes) {
      throw new PreviewStorageError("limit-exceeded", "Artifact exceeds its upload limit");
    }

    const stage = await this.createStage("upload");
    const marker: UploadMarker = {
      schemaVersion: 1,
      kind: "upload",
      rootName: stage.rootName,
      artifactId: expectation.id,
      artifactSha256: expectation.sha256,
      artifactSize: expectation.size
    };
    await this.writeMarker(stage.path, marker);
    const stagedBlob = join(stage.path, "content");
    let handle;
    try {
      handle = await open(stagedBlob, "wx", 0o600);
      const hash = createHash("sha256");
      let size = 0;
      try {
        for await (const value of input) {
          const chunk = Buffer.from(value);
          size += chunk.length;
          if (!Number.isSafeInteger(size) || size > expectation.maximumBytes || size > expectation.size) {
            throw new PreviewStorageError("limit-exceeded", "Artifact upload exceeded its registered size");
          }
          hash.update(chunk);
          await writeAll(handle, chunk);
        }
      } catch (error) {
        if (error instanceof PreviewStorageError) throw error;
        throw new PreviewStorageError("upload-invalid", "Artifact upload stream did not complete", { cause: error });
      }
      if (!complete() || size !== expectation.size || hash.digest("hex") !== expectation.sha256) {
        throw new PreviewStorageError("upload-invalid", "Artifact upload does not match its registered identity");
      }
      await handle.sync();
      await handle.close();
      handle = undefined;

      await this.ensureRealDirectory(this.rootDirectory, true);
      await this.ensureRealDirectory(this.artifactDirectory);
      const destination = this.artifactPath(expectation.id);
      let replayed = false;
      try {
        await link(stagedBlob, destination);
        await fsyncDirectory(this.artifactDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.verifyArtifact(expectation);
        replayed = true;
      }
      await this.removeOwnedStage(stage.path, marker);
      return { replayed };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await this.removeOwnedStage(stage.path, marker).catch((cleanupError) => {
        throw new PreviewStorageError("storage-conflict", "Owned upload staging could not be cleaned", { cause: cleanupError });
      });
      if (error instanceof PreviewStorageError) throw error;
      throw new PreviewStorageError("processing-failed", "Artifact storage operation failed", { cause: error });
    }
  }

  async verifyArtifact(expectation: Omit<ArtifactBlobExpectation, "maximumBytes">): Promise<"exact" | "absent"> {
    safeSegment(expectation.id, "Artifact id");
    safeDigest(expectation.sha256);
    try {
      await this.requireRealDirectory(this.artifactDirectory);
      const path = this.artifactPath(expectation.id);
      const actual = await hashRegularFile(path);
      if (actual.size !== expectation.size || actual.sha256 !== expectation.sha256
        || (actual.mode !== 0o600 && actual.mode !== 0o644)) {
        throw new PreviewStorageError("storage-conflict", "Immutable artifact content conflicts with its registration");
      }
      if (actual.mode === 0o644) {
        let handle;
        try {
          handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          const metadata = await handle.stat();
          if (!metadata.isFile() || metadata.dev !== actual.device || metadata.ino !== actual.inode
            || (metadata.mode & 0o777) !== 0o644) {
            throw new PreviewStorageError("storage-conflict", "Legacy artifact content changed during permission migration");
          }
          await handle.chmod(0o600);
          await handle.sync();
        } finally {
          await handle?.close();
        }
        const normalized = await hashRegularFile(path);
        if (normalized.size !== expectation.size || normalized.sha256 !== expectation.sha256 || normalized.mode !== 0o600) {
          throw new PreviewStorageError("storage-conflict", "Legacy artifact content changed during permission migration");
        }
      }
      return "exact";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT"
        || (error instanceof PreviewStorageError && (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT")) {
        return "absent";
      }
      if (error instanceof PreviewStorageError) throw error;
      throw new PreviewStorageError("storage-conflict", "Immutable artifact content could not be verified", { cause: error });
    }
  }

  async readArtifact(id: string) {
    let handle;
    try {
      await this.requireRealDirectory(this.artifactDirectory);
      handle = await open(this.artifactPath(id), constants.O_RDONLY | constants.O_NOFOLLOW);
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new PreviewStorageError("storage-conflict", "Artifact content is not a regular file");
      return await handle.readFile();
    } finally {
      await handle?.close();
    }
  }

  async createPreparationWorkspace(identity: PreparationIdentity): Promise<PreparationWorkspace> {
    assertIdentity(identity);
    if (!Number.isSafeInteger(identity.processingGeneration) || identity.processingGeneration < 1) {
      throw new PreviewStorageError("storage-conflict", "Processing generation is invalid");
    }
    const stage = await this.createStage("prepare");
    const marker: PreparationMarker = {
      schemaVersion: 1,
      kind: "preparation",
      rootName: stage.rootName,
      ...identity
    };
    await this.writeMarker(stage.path, marker);
    const publicationDirectory = join(stage.path, "publication");
    const contentDirectory = join(publicationDirectory, "content");
    await mkdir(contentDirectory, { recursive: true, mode: 0o700 });
    await chmod(publicationDirectory, 0o700);
    await chmod(contentDirectory, 0o700);
    return { rootDirectory: stage.path, publicationDirectory, contentDirectory, identity: { ...identity } };
  }

  async cleanupPreparationWorkspace(workspace: PreparationWorkspace) {
    const expected: PreparationMarker = {
      schemaVersion: 1,
      kind: "preparation",
      rootName: basename(workspace.rootDirectory),
      ...workspace.identity
    };
    await this.removeOwnedStage(workspace.rootDirectory, expected);
  }

  private async normalizePublication(path: string) {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new PreviewStorageError("storage-conflict", "Prepared output contains a link");
    if (metadata.isDirectory()) {
      await chmod(path, 0o700);
      for (const entry of await readdir(path)) await this.normalizePublication(join(path, entry));
      return;
    }
    if (!metadata.isFile()) throw new PreviewStorageError("storage-conflict", "Prepared output contains a special object");
    await chmod(path, 0o600);
  }

  private async fsyncPublicationDirectories(path: string): Promise<void> {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new PreviewStorageError("storage-conflict", "Prepared output directory changed during publication");
    }
    for (const entry of await readdir(path)) {
      const child = join(path, entry);
      const childMetadata = await lstat(child);
      if (childMetadata.isDirectory() && !childMetadata.isSymbolicLink()) await this.fsyncPublicationDirectories(child);
    }
    await fsyncDirectory(path);
  }

  async publishPrepared(workspace: PreparationWorkspace, manifestValue: PreparedPreviewManifest, compressedSize?: number) {
    const identity: PreparedPreviewIdentity = {
      previewId: workspace.identity.previewId,
      artifactId: workspace.identity.artifactId,
      artifactSha256: workspace.identity.artifactSha256,
      entrypoint: workspace.identity.entrypoint
    };
    const manifest = normalizeManifest(manifestValue, identity);
    if (canonicalJson(manifest) !== canonicalJson(manifestValue)) {
      throw new PreviewStorageError("storage-conflict", "Prepared preview manifest is not canonical");
    }
    const expectedMarker: PreparationMarker = {
      schemaVersion: 1,
      kind: "preparation",
      rootName: basename(workspace.rootDirectory),
      ...workspace.identity
    };
    if (canonicalJson(await this.readMarker(workspace.rootDirectory)) !== canonicalJson(expectedMarker)) {
      throw new PreviewStorageError("storage-conflict", "Preparation workspace identity changed");
    }
    const manifestPath = join(workspace.publicationDirectory, manifestName);
    let manifestHandle: FileHandle;
    try {
      manifestHandle = await open(manifestPath, "wx", 0o600);
    } catch (error) {
      if (["EEXIST", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        throw new PreviewStorageError("storage-conflict", "Preparation workspace contains unexpected manifest content", { cause: error });
      }
      throw new PreviewStorageError("processing-failed", "Prepared preview manifest could not be created", { cause: error });
    }
    try {
      await manifestHandle.writeFile(canonicalJson(manifest));
      await manifestHandle.sync();
    } finally {
      await manifestHandle.close();
    }
    await this.normalizePublication(workspace.publicationDirectory);
    await this.fsyncPublicationDirectories(workspace.publicationDirectory);
    await this.verifyPreparedAt(workspace.publicationDirectory, identity, manifest, compressedSize);

    let release!: () => void;
    const predecessor = this.publicationQueue;
    this.publicationQueue = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try {
      const finalPath = this.preparedPath(identity);
      const existing = await this.verifyPrepared(identity, compressedSize);
      if (existing !== undefined) {
        if (canonicalJson(existing) !== canonicalJson(manifest)) {
          throw new PreviewStorageError("storage-conflict", "Published preview conflicts with prepared output");
        }
        await this.cleanupPreparationWorkspace(workspace);
        return { replayed: true, manifest: existing };
      }
      await this.ensureRealDirectory(this.rootDirectory, true);
      await this.ensureRealDirectory(this.preparedDirectory);
      const parent = join(this.preparedDirectory, identity.previewId);
      await this.ensureRealDirectory(parent);
      try {
        await rename(workspace.publicationDirectory, finalPath);
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        const raced = await this.verifyPrepared(identity, compressedSize);
        if (raced === undefined || canonicalJson(raced) !== canonicalJson(manifest)) {
          throw new PreviewStorageError("storage-conflict", "Published preview target already differs");
        }
        await this.cleanupPreparationWorkspace(workspace);
        return { replayed: true, manifest: raced };
      }
      await fsyncDirectory(parent);
      await this.cleanupPreparationWorkspace(workspace);
      return { replayed: false, manifest };
    } catch (error) {
      if (error instanceof PreviewStorageError) throw error;
      throw new PreviewStorageError("processing-failed", "Prepared preview publication failed", { cause: error });
    } finally {
      release();
    }
  }

  private async verifyPreparedAt(
    path: string,
    identity: PreparedPreviewIdentity,
    expected?: PreparedPreviewManifest,
    compressedSize?: number
  ) {
    if (path === this.preparedPath(identity)) {
      await this.requireRealDirectory(this.preparedDirectory);
      await this.requireRealDirectory(join(this.preparedDirectory, identity.previewId));
    }
    const rootMetadata = await lstat(path);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || (rootMetadata.mode & 0o777) !== 0o700) {
      throw new PreviewStorageError("storage-conflict", "Prepared preview target is not a fixed-permission directory");
    }
    const rootEntries = (await readdir(path)).sort();
    if (rootEntries.length !== 2 || rootEntries[0] !== "content" || rootEntries[1] !== manifestName) {
      throw new PreviewStorageError("storage-conflict", "Prepared preview target contains an extra object");
    }
    const manifestPath = join(path, manifestName);
    const manifestMetadata = await lstat(manifestPath);
    if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink() || (manifestMetadata.mode & 0o777) !== 0o600
      || manifestMetadata.size > previewBundleContract.maximumRegularFiles * (previewBundleContract.maximumPathBytes + 192)) {
      throw new PreviewStorageError("storage-conflict", "Prepared preview manifest has an invalid storage type");
    }
    const rawManifest = await readFile(manifestPath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawManifest);
    } catch (error) {
      throw new PreviewStorageError("storage-conflict", "Prepared preview manifest is malformed", { cause: error });
    }
    const manifest = normalizeManifest(parsed, identity);
    if (compressedSize !== undefined) {
      const expanded = manifest.files.reduce((total, file) => total + file.size, 0);
      if (!Number.isSafeInteger(compressedSize) || compressedSize <= 0
        || compressedSize > previewBundleContract.maximumCompressedBytes
        || expanded > compressedSize * previewBundleContract.maximumExpansionRatio) {
        throw new PreviewStorageError("storage-conflict", "Prepared preview manifest exceeds its expansion ratio");
      }
    }
    if (rawManifest !== canonicalJson(manifest)
      || (expected !== undefined && canonicalJson(manifest) !== canonicalJson(expected))) {
      throw new PreviewStorageError("storage-conflict", "Prepared preview manifest is not canonical");
    }
    const inventory: PreparedPreviewFile[] = [];
    const contentRoot = join(path, "content");
    const walk = async (directory: string, prefix: string): Promise<boolean> => {
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) {
        throw new PreviewStorageError("storage-conflict", "Prepared preview content has an invalid directory");
      }
      let containsFile = false;
      for (const name of await readdir(directory)) {
        const child = join(directory, name);
        const childMetadata = await lstat(child);
        const logicalPath = prefix ? `${prefix}/${name}` : name;
        if (!validatePreviewBundlePath(logicalPath).ok) {
          throw new PreviewStorageError("storage-conflict", "Prepared preview contains an invalid path");
        }
        if (childMetadata.isSymbolicLink()) {
          throw new PreviewStorageError("storage-conflict", "Prepared preview contains a link");
        }
        if (childMetadata.isDirectory()) {
          if (!(await walk(child, logicalPath))) {
            throw new PreviewStorageError("storage-conflict", "Prepared preview contains an extra directory");
          }
          containsFile = true;
          continue;
        }
        if (!childMetadata.isFile()) {
          throw new PreviewStorageError("storage-conflict", "Prepared preview contains a special object");
        }
        const hashed = await hashRegularFile(child);
        if (hashed.mode !== 0o600) {
          throw new PreviewStorageError("storage-conflict", "Prepared preview file permissions changed");
        }
        inventory.push({ path: logicalPath, size: hashed.size, sha256: hashed.sha256 });
        containsFile = true;
      }
      return containsFile;
    };
    await walk(contentRoot, "");
    inventory.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
    if (canonicalJson(inventory) !== canonicalJson(manifest.files)) {
      throw new PreviewStorageError("storage-conflict", "Prepared preview tree disagrees with its manifest");
    }
    return manifest;
  }

  async verifyPrepared(identity: PreparedPreviewIdentity, compressedSize?: number): Promise<PreparedPreviewManifest | undefined> {
    const path = this.preparedPath(identity);
    try {
      return await this.verifyPreparedAt(path, identity, undefined, compressedSize);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT"
        || (error instanceof PreviewStorageError && (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT")) {
        try {
          await lstat(path);
        } catch (targetError) {
          if ((targetError as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        }
        throw new PreviewStorageError("storage-conflict", "Prepared preview target is incomplete", { cause: error });
      }
      if (error instanceof PreviewStorageError) throw error;
      throw new PreviewStorageError("storage-conflict", "Prepared preview target could not be verified", { cause: error });
    }
  }

  /**
   * Reads one exact manifest member after re-verifying the complete immutable target. The returned
   * bytes are hashed from the same no-follow handle whose metadata is checked, so callers never
   * receive a local path or race a second pathname open.
   */
  async readPreparedFile(
    identity: PreparedPreviewIdentity,
    compressedSize: number,
    logicalPath: string
  ): Promise<VerifiedPreparedPreviewFile> {
    if (!validatePreviewBundlePath(logicalPath).ok) {
      throw new PreviewStorageError("storage-conflict", "Prepared preview file path is invalid");
    }
    const manifest = await this.verifyPrepared(identity, compressedSize);
    if (manifest === undefined) {
      throw new PreviewStorageError("storage-conflict", "Prepared preview target is unavailable");
    }
    const file = manifest.files.find((item) => item.path === logicalPath);
    if (file === undefined) {
      throw new PreviewStorageError("storage-conflict", "Prepared preview file is not in the manifest");
    }

    let handle: FileHandle | undefined;
    try {
      const path = join(this.preparedPath(identity), "content", ...logicalPath.split("/"));
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await handle.stat();
      if (!before.isFile() || (before.mode & 0o777) !== 0o600 || before.size !== file.size) {
        throw new PreviewStorageError("storage-conflict", "Prepared preview file metadata changed");
      }
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino
        || after.size !== before.size || (after.mode & 0o777) !== 0o600
        || bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
        throw new PreviewStorageError("storage-conflict", "Prepared preview file bytes changed");
      }
      return { bytes, file: { ...file }, manifest };
    } catch (error) {
      if (error instanceof PreviewStorageError) throw error;
      throw new PreviewStorageError("storage-conflict", "Prepared preview file could not be verified", { cause: error });
    } finally {
      await handle?.close();
    }
  }

  /** Startup-only cleanup: every object must prove ownership before recursive removal. */
  async cleanupOwnedStaging() {
    let entries;
    try {
      const stagingMetadata = await lstat(this.stagingDirectory);
      if (!stagingMetadata.isDirectory() || stagingMetadata.isSymbolicLink()) {
        throw new PreviewStorageError("storage-conflict", "Preview staging root is not an owned directory");
      }
      entries = await readdir(this.stagingDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const owned: string[] = [];
    for (const entry of entries) {
      const root = join(this.stagingDirectory, entry);
      const metadata = await lstat(root);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new PreviewStorageError("storage-conflict", "Unknown object exists in preview staging");
      }
      await this.readMarker(root);
      owned.push(root);
    }
    for (const root of owned) await this.removeOwnedStage(root);
  }
}
