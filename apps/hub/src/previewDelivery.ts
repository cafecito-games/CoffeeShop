import { isIP } from "node:net";
import type { Server as HttpServer } from "node:http";
import express, {
  type Express,
  type Request,
  type RequestHandler,
  type Response
} from "express";
import {
  previewBundleArtifactKind,
  previewBundleMediaType,
  validatePreviewBundlePath,
  type Artifact,
  type ArtifactPreviewRecord
} from "@coffee-shop/protocol";
import { expireDuePreviews, renewPreview } from "./artifactPreviews.js";
import { CoordinationError } from "./coordinationError.js";
import {
  createPreviewCapabilityUrl,
  signPreviewAccessToken,
  verifyPreviewAccessToken,
  type PreviewSigningConfiguration,
  type PreviewTokenPayload
} from "./previewSigning.js";
import { PreviewStorage, PreviewStorageError, type PreparedPreviewIdentity } from "./previewStorage.js";
import type { State, Store } from "./store.js";

const configurationVariables = [
  "COFFEE_SHOP_PUBLIC_ORIGIN",
  "PREVIEW_PUBLIC_ORIGIN",
  "PREVIEW_BIND_HOST",
  "PREVIEW_PORT",
  "PREVIEW_SIGNING_KEYS",
  "PREVIEW_ACTIVE_SIGNING_KEY_ID",
  "PREVIEW_ACCESS_DEFAULT_TTL_SECONDS",
  "PREVIEW_ACCESS_MAX_TTL_SECONDS"
] as const;
const requiredConfigurationVariables = configurationVariables.slice(0, 6);
const keyIdPattern = /^[A-Za-z0-9_-]{1,32}$/;
const signingSecretPattern = /^[a-f0-9]{64}$/;
const bindHostnamePattern = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/;
const previewRoutePrefix = "/_coffee-shop/preview/v1/";
const denialBody = Buffer.from("Not Found\n", "utf8");
const misdirectedBody = Buffer.from("Misdirected Request\n", "utf8");
const methodBody = Buffer.from("Method Not Allowed\n", "utf8");
const unavailableBody = { error: "Preview access is unavailable" } as const;

export type DisabledPreviewDeliveryConfig = { readonly enabled: false };

export interface EnabledPreviewDeliveryConfig {
  readonly enabled: true;
  readonly hubOrigin: string;
  readonly previewOrigin: string;
  readonly previewAuthority: string;
  readonly previewProtocol: "http:" | "https:";
  readonly bindHost: string;
  readonly port: number;
  readonly defaultTtlSeconds: number;
  readonly maximumTtlSeconds: number;
  readonly signing: PreviewSigningConfiguration;
}

export type PreviewDeliveryConfig = DisabledPreviewDeliveryConfig | EnabledPreviewDeliveryConfig;

export class PreviewDeliveryConfigurationError extends Error {
  constructor(readonly variable: typeof configurationVariables[number], reason: string) {
    super(`${variable} ${reason}`);
  }
}

function configuredValue(
  environment: Record<string, string | undefined>,
  variable: typeof configurationVariables[number]
) {
  const value = environment[variable];
  if (value === undefined) throw new PreviewDeliveryConfigurationError(variable, "is required");
  return value;
}

function parseOrigin(variable: "COFFEE_SHOP_PUBLIC_ORIGIN" | "PREVIEW_PUBLIC_ORIGIN", value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PreviewDeliveryConfigurationError(variable, "must be an absolute HTTP(S) origin");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname
    || parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/"
    || parsed.search !== "" || parsed.hash !== "") {
    throw new PreviewDeliveryConfigurationError(variable, "must be an absolute HTTP(S) origin without credentials, path, query, or fragment");
  }
  if (value !== parsed.origin && value !== `${parsed.origin}/`) {
    throw new PreviewDeliveryConfigurationError(variable, "must use its canonical serialized origin");
  }
  return parsed;
}

function parseInteger(
  variable: "PREVIEW_PORT" | "PREVIEW_ACCESS_DEFAULT_TTL_SECONDS" | "PREVIEW_ACCESS_MAX_TTL_SECONDS",
  value: string,
  minimum: number,
  maximum: number
) {
  if (!/^\d+$/.test(value)) throw new PreviewDeliveryConfigurationError(variable, "must be an integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new PreviewDeliveryConfigurationError(variable, `must be in the range ${minimum}..${maximum}`);
  }
  return parsed;
}

function parseSigningKeys(value: string) {
  const entries = value.split(",");
  if (entries.length < 1 || entries.length > 4 || entries.some((entry) => entry.length === 0)) {
    throw new PreviewDeliveryConfigurationError("PREVIEW_SIGNING_KEYS", "must contain 1..4 key entries");
  }
  const keys = new Map<string, Buffer>();
  for (const entry of entries) {
    const separator = entry.indexOf(":");
    if (separator < 1 || separator !== entry.lastIndexOf(":")) {
      throw new PreviewDeliveryConfigurationError("PREVIEW_SIGNING_KEYS", "contains a malformed key entry");
    }
    const keyId = entry.slice(0, separator);
    const secret = entry.slice(separator + 1);
    if (!keyIdPattern.test(keyId) || !signingSecretPattern.test(secret) || keys.has(keyId)) {
      throw new PreviewDeliveryConfigurationError("PREVIEW_SIGNING_KEYS", "contains a malformed or duplicate key entry");
    }
    keys.set(keyId, Buffer.from(secret, "hex"));
  }
  return keys;
}

function isLocalPreviewHostname(hostname: string) {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized.endsWith(".localhost")
    || normalized === "127.0.0.1" || normalized === "[::1]";
}

export function parsePreviewDeliveryConfig(
  environment: Record<string, string | undefined>
): PreviewDeliveryConfig {
  if (configurationVariables.every((variable) => environment[variable] === undefined)) return { enabled: false };
  for (const variable of requiredConfigurationVariables) configuredValue(environment, variable);

  const hub = parseOrigin("COFFEE_SHOP_PUBLIC_ORIGIN", configuredValue(environment, "COFFEE_SHOP_PUBLIC_ORIGIN"));
  const preview = parseOrigin("PREVIEW_PUBLIC_ORIGIN", configuredValue(environment, "PREVIEW_PUBLIC_ORIGIN"));
  if (hub.hostname.toLowerCase() === preview.hostname.toLowerCase()) {
    throw new PreviewDeliveryConfigurationError("PREVIEW_PUBLIC_ORIGIN", "must use a hostname distinct from COFFEE_SHOP_PUBLIC_ORIGIN");
  }
  if (preview.protocol === "http:" && !isLocalPreviewHostname(preview.hostname)) {
    throw new PreviewDeliveryConfigurationError("PREVIEW_PUBLIC_ORIGIN", "must use HTTPS outside the closed local-host set");
  }

  const bindHost = configuredValue(environment, "PREVIEW_BIND_HOST");
  if ((isIP(bindHost) === 0 && !bindHostnamePattern.test(bindHost)) || /[\s/:]/.test(bindHost)) {
    // A bare IPv6 address contains colons and is admitted by isIP before the unsafe-hostname check.
    if (isIP(bindHost) !== 6) throw new PreviewDeliveryConfigurationError("PREVIEW_BIND_HOST", "must be a bare socket bind address");
  }
  const port = parseInteger("PREVIEW_PORT", configuredValue(environment, "PREVIEW_PORT"), 1, 65_535);
  const keys = parseSigningKeys(configuredValue(environment, "PREVIEW_SIGNING_KEYS"));
  const activeKeyId = configuredValue(environment, "PREVIEW_ACTIVE_SIGNING_KEY_ID");
  if (!keyIdPattern.test(activeKeyId) || !keys.has(activeKeyId)) {
    throw new PreviewDeliveryConfigurationError("PREVIEW_ACTIVE_SIGNING_KEY_ID", "must name one configured signing key");
  }
  const defaultTtlSeconds = environment.PREVIEW_ACCESS_DEFAULT_TTL_SECONDS === undefined
    ? 900
    : parseInteger("PREVIEW_ACCESS_DEFAULT_TTL_SECONDS", environment.PREVIEW_ACCESS_DEFAULT_TTL_SECONDS, 60, 3_600);
  const maximumTtlSeconds = environment.PREVIEW_ACCESS_MAX_TTL_SECONDS === undefined
    ? 3_600
    : parseInteger("PREVIEW_ACCESS_MAX_TTL_SECONDS", environment.PREVIEW_ACCESS_MAX_TTL_SECONDS, 60, 3_600);
  if (defaultTtlSeconds > maximumTtlSeconds) {
    throw new PreviewDeliveryConfigurationError("PREVIEW_ACCESS_DEFAULT_TTL_SECONDS", "must not exceed PREVIEW_ACCESS_MAX_TTL_SECONDS");
  }

  const signing: PreviewSigningConfiguration = {
    origin: preview.origin,
    activeKeyId,
    maximumTtlSeconds,
    keys
  };
  return {
    enabled: true,
    hubOrigin: hub.origin,
    previewOrigin: preview.origin,
    previewAuthority: preview.host.toLowerCase(),
    previewProtocol: preview.protocol as "http:" | "https:",
    bindHost,
    port,
    defaultTtlSeconds,
    maximumTtlSeconds,
    signing
  };
}

export function rawRequestAuthority(request: Pick<Request, "rawHeaders"> | { rawHeaders: string[] }) {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "host") values.push(request.rawHeaders[index + 1] ?? "");
  }
  if (values.length !== 1 || values[0]!.length === 0 || values[0] !== values[0]!.trim() || values[0]!.includes(",")) return undefined;
  return values[0];
}

function hasPreviewAuthority(request: Pick<Request, "rawHeaders">, configuration: EnabledPreviewDeliveryConfig) {
  const authority = rawRequestAuthority(request);
  if (authority === undefined) return false;
  const exact = authority.toLowerCase();
  if (exact === configuration.previewAuthority) return true;
  const origin = new URL(configuration.previewOrigin);
  const defaultPort = configuration.previewProtocol === "https:" ? "443" : "80";
  return origin.port === "" && exact === `${configuration.previewAuthority}:${defaultPort}`;
}

export function requestTargetsPreviewAuthority(
  request: Pick<Request, "rawHeaders">,
  configuration: PreviewDeliveryConfig
) {
  return configuration.enabled && hasPreviewAuthority(request, configuration);
}

export function createMainPreviewHostGuard(configuration: PreviewDeliveryConfig): RequestHandler {
  return (request, response, next) => {
    if (requestTargetsPreviewAuthority(request, configuration)) {
      response.status(421).type("text/plain").send("Misdirected Request\n");
      return;
    }
    next();
  };
}

const mimeByExtension: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm"
};

export function previewContentType(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const extension = dot < 0 ? "" : name.slice(dot).toLowerCase();
  return mimeByExtension[extension] ?? "application/octet-stream";
}

function applyPreviewHeaders(response: Response, configuration: EnabledPreviewDeliveryConfig) {
  response.set({
    "Content-Security-Policy": `default-src 'none'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors ${configuration.hubOrigin}; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'self'; connect-src 'none'; worker-src 'self'; manifest-src 'self'`,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin"
  });
}

function fixedResponse(request: Request, response: Response, status: number, body: Buffer) {
  response.status(status);
  response.set("Content-Type", "text/plain; charset=utf-8");
  response.set("Content-Length", String(body.length));
  if (request.method === "HEAD") response.end();
  else response.end(body);
}

function exactActor(left: Artifact | ArtifactPreviewRecord, right: Artifact | ArtifactPreviewRecord) {
  return left.agentId === right.agentId && left.instanceId === right.instanceId && left.allocationId === right.allocationId;
}

interface ResolvedPreviewAccess {
  readonly preview: ArtifactPreviewRecord;
  readonly artifact: Artifact;
  readonly identity: PreparedPreviewIdentity;
}

type PreviewResolution =
  | { readonly kind: "not-found" }
  | { readonly kind: "unavailable" }
  | ({ readonly kind: "ready" } & ResolvedPreviewAccess);

function resolvePreviewAccessInState(state: State, previewId: string, nowMilliseconds: number): PreviewResolution {
  const previews = (state.artifactPreviews ?? []).filter((preview) => preview.id === previewId);
  if (previews.length === 0) return { kind: "not-found" };
  if (previews.length !== 1) return { kind: "unavailable" };
  const preview = previews[0]!;
  if ((state.artifactPreviews ?? []).filter((item) => item.artifactId === preview.artifactId).length !== 1) {
    return { kind: "unavailable" };
  }
  const artifacts = (state.artifacts ?? []).filter((artifact) => artifact.id === preview.artifactId);
  if (artifacts.length !== 1) return { kind: "unavailable" };
  const artifact = artifacts[0]!;
  if (preview.status !== "ready" || preview.processingGeneration < 1
    || !Number.isFinite(Date.parse(preview.expiresAt)) || nowMilliseconds >= Date.parse(preview.expiresAt)
    || !artifact.uploaded || artifact.kind !== previewBundleArtifactKind || artifact.mediaType !== previewBundleMediaType
    || !Number.isSafeInteger(artifact.size) || artifact.size <= 0
    || !/^[a-f0-9]{64}$/.test(preview.artifactSha256)
    || !validatePreviewBundlePath(preview.entrypoint, { entrypoint: true }).ok
    || artifact.sha256 !== preview.artifactSha256 || artifact.threadId !== preview.threadId
    || artifact.runId !== preview.runId || !exactActor(artifact, preview)) return { kind: "unavailable" };
  return {
    kind: "ready",
    preview: structuredClone(preview),
    artifact: structuredClone(artifact),
    identity: {
      previewId: preview.id,
      artifactId: artifact.id,
      artifactSha256: artifact.sha256,
      entrypoint: preview.entrypoint
    }
  };
}

function resolvePreviewAccess(store: Store, previewId: string, nowMilliseconds: number) {
  return store.read((state) => resolvePreviewAccessInState(state, previewId, nowMilliseconds));
}

function tokenMatches(payload: PreviewTokenPayload, resolved: ResolvedPreviewAccess) {
  return payload.previewId === resolved.preview.id
    && payload.artifactId === resolved.artifact.id
    && payload.artifactSha256 === resolved.artifact.sha256
    && payload.processingGeneration === resolved.preview.processingGeneration;
}

function sameResolution(left: ResolvedPreviewAccess, right: ResolvedPreviewAccess) {
  return left.preview.id === right.preview.id && left.artifact.id === right.artifact.id
    && left.artifact.sha256 === right.artifact.sha256
    && left.artifact.size === right.artifact.size
    && left.artifact.kind === right.artifact.kind && left.artifact.mediaType === right.artifact.mediaType
    && left.preview.threadId === right.preview.threadId && left.preview.runId === right.preview.runId
    && exactActor(left.preview, right.preview) && exactActor(left.artifact, right.artifact)
    && left.preview.entrypoint === right.preview.entrypoint
    && left.preview.processingGeneration === right.preview.processingGeneration
    && left.preview.expiresAt === right.preview.expiresAt;
}

function parseLogicalPath(rawPath: string) {
  const rawSegments = rawPath.split("/");
  if (rawSegments.some((segment) => segment.length === 0)) return undefined;
  const decoded: string[] = [];
  try {
    for (const segment of rawSegments) {
      const value = decodeURIComponent(segment);
      if (value === "" || value === "." || value === ".." || value.includes("/") || value.includes("\\")
        || value.normalize("NFC") !== value || /\p{Cc}/u.test(value)) return undefined;
      decoded.push(value);
    }
  } catch {
    return undefined;
  }
  const logicalPath = decoded.join("/");
  return validatePreviewBundlePath(logicalPath).ok ? logicalPath : undefined;
}

function requestCapability(request: Request) {
  const rawTarget = request.originalUrl || request.url;
  const query = rawTarget.indexOf("?");
  const rawPathname = query < 0 ? rawTarget : rawTarget.slice(0, query);
  if (!rawPathname.startsWith(previewRoutePrefix)) return undefined;
  const remainder = rawPathname.slice(previewRoutePrefix.length);
  const separator = remainder.indexOf("/");
  if (separator <= 0 || separator === remainder.length - 1) return undefined;
  return { token: remainder.slice(0, separator), rawPath: remainder.slice(separator + 1) };
}

export interface PreviewDeliveryLogEvent {
  readonly code: "storage-conflict" | "upload-invalid" | "limit-exceeded" | "processing-failed" | "unexpected";
  readonly previewId: string;
  readonly artifactId: string;
}

export interface PreviewDeliveryDependencies {
  readonly store: Store;
  readonly storage: PreviewStorage;
  readonly configuration: EnabledPreviewDeliveryConfig;
  readonly now?: () => number;
  readonly log?: (event: PreviewDeliveryLogEvent) => void;
}

export function createPreviewDeliveryApp(dependencies: PreviewDeliveryDependencies) {
  const { store, storage, configuration } = dependencies;
  const now = dependencies.now ?? Date.now;
  const log = dependencies.log ?? ((event: PreviewDeliveryLogEvent) => console.error("preview delivery denied", event));
  const app = express();
  app.disable("x-powered-by");
  app.use(async (request, response) => {
    applyPreviewHeaders(response, configuration);
    if (!hasPreviewAuthority(request, configuration)) {
      fixedResponse(request, response, 421, misdirectedBody);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.set("Allow", "GET, HEAD");
      fixedResponse(request, response, 405, methodBody);
      return;
    }
    const capability = requestCapability(request);
    if (capability === undefined) {
      fixedResponse(request, response, 404, denialBody);
      return;
    }
    const initialNow = now();
    const payload = verifyPreviewAccessToken(configuration.signing, capability.token, Math.floor(initialNow / 1_000));
    if (payload === undefined) {
      fixedResponse(request, response, 404, denialBody);
      return;
    }
    const resolved = resolvePreviewAccess(store, payload.previewId, initialNow);
    if (resolved.kind !== "ready" || !tokenMatches(payload, resolved)) {
      fixedResponse(request, response, 404, denialBody);
      return;
    }
    const logicalPath = parseLogicalPath(capability.rawPath);
    if (logicalPath === undefined) {
      fixedResponse(request, response, 404, denialBody);
      return;
    }

    try {
      const result = await storage.readPreparedFile(resolved.identity, resolved.artifact.size, logicalPath);
      const finalNow = now();
      const finalPayload = verifyPreviewAccessToken(configuration.signing, capability.token, Math.floor(finalNow / 1_000));
      const finalResolved = finalPayload === undefined
        ? { kind: "unavailable" as const }
        : resolvePreviewAccess(store, finalPayload.previewId, finalNow);
      if (finalPayload === undefined || finalResolved.kind !== "ready"
        || !tokenMatches(finalPayload, finalResolved) || !sameResolution(resolved, finalResolved)) {
        fixedResponse(request, response, 404, denialBody);
        return;
      }
      const contentType = previewContentType(logicalPath);
      response.status(200);
      response.set("Content-Type", contentType);
      response.set("Content-Length", String(result.file.size));
      if (contentType === "application/octet-stream") response.set("Content-Disposition", "attachment");
      if (request.method === "HEAD") response.end();
      else response.end(result.bytes);
    } catch (error) {
      log({
        code: error instanceof PreviewStorageError ? error.code : "unexpected",
        previewId: resolved.preview.id,
        artifactId: resolved.artifact.id
      });
      if (!response.headersSent) fixedResponse(request, response, 404, denialBody);
    }
  });
  return app;
}

export interface PreviewOperatorRouteDependencies {
  readonly store: Store;
  readonly storage: PreviewStorage;
  readonly configuration: PreviewDeliveryConfig;
  readonly broadcast: () => void;
  readonly now?: () => number;
  readonly log?: (event: PreviewDeliveryLogEvent) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function accessTtl(body: unknown, configuration: EnabledPreviewDeliveryConfig) {
  const value = body === undefined ? {} : body;
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "ttlSeconds")) return undefined;
  const ttl = value.ttlSeconds === undefined ? configuration.defaultTtlSeconds : value.ttlSeconds;
  return typeof ttl === "number" && Number.isSafeInteger(ttl) && ttl >= 60 && ttl <= configuration.maximumTtlSeconds
    ? ttl
    : undefined;
}

function exactRenewalBody(body: unknown): body is { ttlSeconds: number } {
  return isRecord(body) && Object.keys(body).length === 1 && Object.keys(body)[0] === "ttlSeconds"
    && typeof body.ttlSeconds === "number" && Number.isSafeInteger(body.ttlSeconds);
}

function safeStorageLog(
  log: ((event: PreviewDeliveryLogEvent) => void) | undefined,
  error: unknown,
  resolved: ResolvedPreviewAccess
) {
  log?.({
    code: error instanceof PreviewStorageError ? error.code : "unexpected",
    previewId: resolved.preview.id,
    artifactId: resolved.artifact.id
  });
}

export function registerPreviewOperatorRoutes(app: Express, dependencies: PreviewOperatorRouteDependencies) {
  const { store, storage, configuration, broadcast } = dependencies;
  const now = dependencies.now ?? Date.now;

  app.post("/api/previews/:id/access", async (request, response) => {
    if (!configuration.enabled) return response.status(503).json(unavailableBody);
    const ttlSeconds = accessTtl(request.body, configuration);
    if (ttlSeconds === undefined) return response.status(422).json({ error: "ttlSeconds is outside the preview access policy" });
    const initialNow = now();
    const resolved = resolvePreviewAccess(store, request.params.id, initialNow);
    if (resolved.kind === "not-found") return response.status(404).json({ error: "Preview not found" });
    if (resolved.kind !== "ready") return response.status(409).json(unavailableBody);
    try {
      const manifest = await storage.verifyPrepared(resolved.identity, resolved.artifact.size);
      if (manifest === undefined) return response.status(409).json(unavailableBody);
      const finalNow = now();
      const finalResolved = resolvePreviewAccess(store, request.params.id, finalNow);
      if (finalResolved.kind !== "ready" || !sameResolution(resolved, finalResolved)) {
        return response.status(409).json(unavailableBody);
      }
      const iat = Math.floor(finalNow / 1_000);
      const lifecycleExpiry = Math.floor(Date.parse(finalResolved.preview.expiresAt) / 1_000);
      const exp = Math.min(iat + ttlSeconds, lifecycleExpiry);
      if (exp <= iat) return response.status(409).json(unavailableBody);
      const signed = signPreviewAccessToken(configuration.signing, {
        previewId: finalResolved.preview.id,
        artifactId: finalResolved.artifact.id,
        artifactSha256: finalResolved.artifact.sha256,
        processingGeneration: finalResolved.preview.processingGeneration
      }, iat, exp);
      return response.json({
        previewId: finalResolved.preview.id,
        url: createPreviewCapabilityUrl(configuration.previewOrigin, signed.token, finalResolved.preview.entrypoint),
        expiresAt: new Date(exp * 1_000).toISOString()
      });
    } catch (error) {
      safeStorageLog(dependencies.log, error, resolved);
      return response.status(error instanceof PreviewStorageError ? 409 : 500).json(unavailableBody);
    }
  });

  app.post("/api/previews/:id/renew", async (request, response) => {
    if (!exactRenewalBody(request.body)) return response.status(422).json({ error: "ttlSeconds is required" });
    try {
      const preview = await renewPreview(store, request.params.id, request.body.ttlSeconds, new Date(now()).toISOString());
      broadcast();
      return response.json({ preview });
    } catch (error) {
      if (!(error instanceof CoordinationError)) return response.status(500).json({ error: "Preview renewal failed" });
      if (error.code === "not_found") return response.status(404).json({ error: "Preview not found" });
      if (error.code === "invalid_arguments" || error.code === "ttl_out_of_bounds") {
        return response.status(422).json({ error: error.message });
      }
      return response.status(409).json({ error: error.message });
    }
  });
}

export async function runPreviewExpiryMaintenance(store: Store, broadcast: () => void, atMilliseconds = Date.now()) {
  const expired = await expireDuePreviews(store, new Date(atMilliseconds).toISOString());
  if (expired > 0) broadcast();
  return expired;
}

export interface HttpListenerTarget {
  readonly server: HttpServer;
  readonly port: number;
  readonly host: string;
}

const listenHttpServer = ({ server, port, host }: HttpListenerTarget) => new Promise<void>((resolve, reject) => {
  const failed = (error: Error) => reject(error);
  server.once("error", failed);
  server.listen(port, host, () => {
    server.off("error", failed);
    resolve();
  });
});

const closeListeningServer = (server: HttpServer) => new Promise<void>((resolve) => {
  if (!server.listening) return resolve();
  server.close(() => resolve());
});

/** Starts the complete topology or closes every successfully bound peer before rejecting. */
export async function listenPreviewTopology(main: HttpListenerTarget, preview?: HttpListenerTarget) {
  const targets = preview === undefined ? [main] : [main, preview];
  const results = await Promise.allSettled(targets.map(listenHttpServer));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) {
    await Promise.all(targets.map(({ server }) => closeListeningServer(server)));
    throw failure.reason;
  }
}
