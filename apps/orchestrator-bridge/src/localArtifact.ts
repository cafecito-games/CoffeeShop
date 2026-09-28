import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import {
  artifactMaximumBytes,
  ordinaryArtifactKinds,
  type Artifact,
  type OrdinaryArtifactKind
} from "@coffee-shop/protocol";
import { captureLocalPreview, type CapturedLocalPreview } from "./localPreview.js";

export interface ExternalPostArtifactArguments {
  threadId: string;
  relativePath: string;
  title: string;
  kind: OrdinaryArtifactKind;
  mediaType: string;
  summary?: string;
  idempotencyKey: string;
}

export interface ExternalArtifactRegistration extends Omit<ExternalPostArtifactArguments, "summary"> {
  summary: string;
  size: number;
  sha256: string;
}

export interface CapturedLocalArtifact {
  registration: ExternalArtifactRegistration;
  /** The exact retained bytes whose size and digest appear in `registration`. */
  bytes: Buffer;
}

export interface ArtifactUploadGrant {
  path: string;
  token: string;
  expiresAt: string;
}

/** The dependency BridgeServer needs; tests inject it without exposing local roots to the Hub. */
export interface LocalArtifactGateway {
  capture(value: unknown): Promise<CapturedLocalArtifact>;
  capturePreview?(value: unknown): Promise<CapturedLocalPreview>;
  upload(grant: ArtifactUploadGrant, bytes: Buffer): Promise<void>;
}

export interface CaptureLocalArtifactOptions {
  /** Test seam for the final-component replacement race immediately before `open(O_NOFOLLOW)`. */
  beforeOpen?: () => Promise<void>;
}

export class LocalArtifactError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalArtifactError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const byteLength = (value: string) => Buffer.byteLength(value, "utf8");

function boundedRequiredString(value: Record<string, unknown>, key: string, maximumBytes: number) {
  const candidate = typeof value[key] === "string" ? value[key].trim() : "";
  if (!candidate) throw new LocalArtifactError(`${key} is required in post_artifact arguments`);
  if (byteLength(candidate) > maximumBytes) throw new LocalArtifactError(`${key} exceeds the post_artifact argument limit`);
  return candidate;
}

function parseArguments(value: unknown): ExternalPostArtifactArguments & { summary: string } {
  if (!isRecord(value)) throw new LocalArtifactError("post_artifact arguments must be an object");
  const keys = ["threadId", "relativePath", "title", "kind", "mediaType", "summary", "idempotencyKey"];
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new LocalArtifactError("post_artifact arguments contain an unknown field");
  }
  const threadId = boundedRequiredString(value, "threadId", 200);
  const title = boundedRequiredString(value, "title", 256);
  const mediaType = boundedRequiredString(value, "mediaType", 128);
  const idempotencyKey = boundedRequiredString(value, "idempotencyKey", 128);
  const kind = value.kind;
  if (typeof kind !== "string" || !(ordinaryArtifactKinds as readonly string[]).includes(kind)) {
    throw new LocalArtifactError("kind must be an ordinary post_artifact kind");
  }
  if (value.summary !== undefined && typeof value.summary !== "string") {
    throw new LocalArtifactError("summary in post_artifact arguments must be a string");
  }
  const summary = (value.summary as string | undefined)?.trim() ?? "";
  if (byteLength(summary) > 2_000) throw new LocalArtifactError("summary exceeds the post_artifact argument limit");
  const requestedPath = boundedRequiredString(value, "relativePath", 1_024);
  const forwardPath = requestedPath.replaceAll("\\", "/");
  if (isAbsolute(requestedPath) || forwardPath.startsWith("/") || /^[A-Za-z]:/.test(forwardPath)) {
    throw new LocalArtifactError("relativePath must be relative to the bridge working root");
  }
  const relativePath = posix.normalize(forwardPath);
  if (/[\u0000-\u001f\u007f]/.test(relativePath) || relativePath === "." || relativePath === ".." || relativePath.startsWith("../")
    || relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new LocalArtifactError("relativePath escapes the bridge working root");
  }
  return { threadId, relativePath, title, kind: kind as OrdinaryArtifactKind, mediaType, summary, idempotencyKey };
}

const isContained = (root: string, candidate: string) => {
  const fromRoot = relative(root, candidate);
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
};

/** Canonicalizes the single startup root; no tool argument or environment value can select it. */
export async function canonicalWorkingRoot(root: string): Promise<string> {
  const canonical = await realpath(root);
  if (!(await stat(canonical)).isDirectory()) throw new LocalArtifactError("the bridge working root is not a directory");
  return canonical;
}

/**
 * Opens one ordinary file beneath the startup root and retains exactly the bounded bytes it hashes.
 * Intermediate symlinks may resolve inside the root; final symlinks and every escape are refused.
 */
export async function captureLocalArtifact(
  workingRoot: string,
  value: unknown,
  options: CaptureLocalArtifactOptions = {}
): Promise<CapturedLocalArtifact> {
  const parsed = parseArguments(value);
  const lexical = resolve(workingRoot, ...parsed.relativePath.split("/"));
  if (!isContained(workingRoot, lexical)) throw new LocalArtifactError("relativePath escapes the bridge working root");

  let canonicalTarget: string;
  let expectedDevice = 0;
  let expectedInode = 0;
  try {
    canonicalTarget = await realpath(lexical);
    if (!isContained(workingRoot, canonicalTarget)) throw new LocalArtifactError("relativePath resolves outside the bridge working root");
    const finalComponent = await lstat(lexical);
    if (finalComponent.isSymbolicLink()) throw new LocalArtifactError("artifact must not be a final-component symbolic link");
    // Refuse FIFOs/devices/sockets before open: opening a FIFO read-only can block forever. The
    // opened-handle check below remains authoritative against a replacement race.
    if (!finalComponent.isFile()) throw new LocalArtifactError("artifact must be a regular file");
    expectedDevice = finalComponent.dev;
    expectedInode = finalComponent.ino;
  } catch (error) {
    if (error instanceof LocalArtifactError) throw error;
    throw new LocalArtifactError("artifact must exist beneath the bridge working root", { cause: error });
  }

  await options.beforeOpen?.();
  let handle;
  try {
    handle = await open(canonicalTarget, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new LocalArtifactError("artifact must be a regular file");
    if (metadata.dev !== expectedDevice || metadata.ino !== expectedInode) {
      throw new LocalArtifactError("artifact changed while it was being opened");
    }
    if (metadata.size > artifactMaximumBytes) throw new LocalArtifactError("artifact must be at most 10 MiB");
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= artifactMaximumBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, artifactMaximumBytes + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      size += bytesRead;
    }
    if (size > artifactMaximumBytes) throw new LocalArtifactError("artifact must be at most 10 MiB");
    const bytes = Buffer.concat(chunks, size);
    return {
      bytes,
      registration: {
        ...parsed,
        size,
        sha256: createHash("sha256").update(bytes).digest("hex")
      }
    };
  } catch (error) {
    if (error instanceof LocalArtifactError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new LocalArtifactError("artifact must not be a final-component symbolic link", { cause: error });
    }
    throw new LocalArtifactError("artifact could not be opened safely as a regular file", { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export type ArtifactFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Converts the configured WebSocket endpoint to its same-origin HTTP upload authority. */
export function createArtifactHttpUploader(hubUrl: string, fetchImpl: ArtifactFetch = fetch): LocalArtifactGateway["upload"] {
  const base = new URL(hubUrl);
  base.protocol = base.protocol === "wss:" ? "https:" : "http:";
  return async (grant, bytes) => {
    let target: URL;
    try {
      target = new URL(grant.path, base);
    } catch {
      throw new LocalArtifactError("the Hub returned an invalid artifact upload grant");
    }
    if (target.origin !== base.origin || target.search || target.hash || !grant.path.startsWith("/api/artifacts/")) {
      throw new LocalArtifactError("the Hub returned an invalid artifact upload grant");
    }
    const response = await fetchImpl(target, {
      method: "PUT",
      redirect: "error",
      headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/octet-stream" },
      // Node's fetch accepts Buffer, while the DOM declaration used by TypeScript does not name it.
      body: bytes as unknown as BodyInit
    }).catch((error) => { throw new LocalArtifactError("the artifact upload did not reach the Hub", { cause: error }); });
    if (!response.ok) throw new LocalArtifactError(`the Hub refused the artifact upload (${response.status})`);
  };
}

export class LocalArtifactService implements LocalArtifactGateway {
  constructor(
    private readonly workingRoot: string,
    private readonly uploadBytes: LocalArtifactGateway["upload"]
  ) {}

  capture(value: unknown) {
    return captureLocalArtifact(this.workingRoot, value);
  }

  capturePreview(value: unknown) {
    return captureLocalPreview(this.workingRoot, value);
  }

  upload(grant: ArtifactUploadGrant, bytes: Buffer) {
    return this.uploadBytes(grant, bytes);
  }
}

/** Runtime guard for the internal registration reply; plaintext grant fields never cross MCP. */
export function parseArtifactRegistrationResult(value: unknown):
  | { artifact: Artifact; uploadGrant?: ArtifactUploadGrant }
  | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "artifact" && key !== "uploadGrant") || !isRecord(value.artifact)) return undefined;
  const artifact = value.artifact as unknown as Artifact;
  if (value.uploadGrant === undefined) return { artifact };
  if (!isRecord(value.uploadGrant)
    || Object.keys(value.uploadGrant).some((key) => key !== "path" && key !== "token" && key !== "expiresAt")
    || typeof value.uploadGrant.path !== "string"
    || !/^\/api\/artifacts\/[^/]+\/content$/.test(value.uploadGrant.path)
    || typeof value.uploadGrant.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.uploadGrant.token)
    || typeof value.uploadGrant.expiresAt !== "string" || Number.isNaN(Date.parse(value.uploadGrant.expiresAt))) return undefined;
  return { artifact, uploadGrant: value.uploadGrant as unknown as ArtifactUploadGrant };
}
