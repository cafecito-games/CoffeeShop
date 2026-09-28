import { createHmac, timingSafeEqual } from "node:crypto";

export interface PreviewSigningConfiguration {
  readonly origin: string;
  readonly activeKeyId: string;
  readonly maximumTtlSeconds: number;
  readonly keys: ReadonlyMap<string, Buffer>;
}

export interface PreviewTokenIdentity {
  readonly previewId: string;
  readonly artifactId: string;
  readonly artifactSha256: string;
  readonly processingGeneration: number;
}

export interface PreviewTokenPayload extends PreviewTokenIdentity {
  readonly v: 1;
  readonly kid: string;
  readonly origin: string;
  readonly iat: number;
  readonly exp: number;
}

export interface SignedPreviewAccessToken {
  readonly token: string;
  readonly payloadJson: string;
  readonly payload: PreviewTokenPayload;
}

const tokenContext = "coffee-shop-preview-v1\0";
const payloadKeys = [
  "v", "kid", "origin", "previewId", "artifactId", "artifactSha256", "processingGeneration", "iat", "exp"
] as const;
const keyIdPattern = /^[A-Za-z0-9_-]{1,32}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const maximumTokenBytes = 1_024;
const futureSkewSeconds = 30;
const zeroKey = Buffer.alloc(32);
const zeroSignature = Buffer.alloc(32);
const utf8 = new TextDecoder("utf-8", { fatal: true });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function exactPayload(value: unknown, configuration: PreviewSigningConfiguration): PreviewTokenPayload | undefined {
  if (!isRecord(value) || Object.keys(value).length !== payloadKeys.length
    || !Object.keys(value).every((key, index) => key === payloadKeys[index])) return undefined;
  if (value.v !== 1 || typeof value.kid !== "string" || !keyIdPattern.test(value.kid)
    || value.origin !== configuration.origin
    || typeof value.previewId !== "string" || !identifierPattern.test(value.previewId)
    || typeof value.artifactId !== "string" || !identifierPattern.test(value.artifactId)
    || typeof value.artifactSha256 !== "string" || !digestPattern.test(value.artifactSha256)
    || typeof value.processingGeneration !== "number" || !Number.isSafeInteger(value.processingGeneration)
    || value.processingGeneration < 1
    || typeof value.iat !== "number" || !Number.isSafeInteger(value.iat) || value.iat < 0
    || typeof value.exp !== "number" || !Number.isSafeInteger(value.exp) || value.exp < 1
    || value.exp <= value.iat || value.exp - value.iat > configuration.maximumTtlSeconds) return undefined;
  return value as unknown as PreviewTokenPayload;
}

function canonicalPayload(configuration: PreviewSigningConfiguration, identity: PreviewTokenIdentity, iat: number, exp: number) {
  const payload: PreviewTokenPayload = {
    v: 1,
    kid: configuration.activeKeyId,
    origin: configuration.origin,
    previewId: identity.previewId,
    artifactId: identity.artifactId,
    artifactSha256: identity.artifactSha256,
    processingGeneration: identity.processingGeneration,
    iat,
    exp
  };
  if (exactPayload(payload, configuration) === undefined) throw new Error("Preview token input is invalid");
  return payload;
}

function hmac(key: Buffer, payload: string) {
  return createHmac("sha256", key).update(`${tokenContext}${payload}`, "utf8").digest();
}

export function signPreviewAccessToken(
  configuration: PreviewSigningConfiguration,
  identity: PreviewTokenIdentity,
  iat: number,
  exp: number
): SignedPreviewAccessToken {
  const key = configuration.keys.get(configuration.activeKeyId);
  if (key === undefined || key.length !== 32) throw new Error("Preview active signing key is unavailable");
  const payload = canonicalPayload(configuration, identity, iat, exp);
  const payloadJson = JSON.stringify(payload);
  const encodedPayload = Buffer.from(payloadJson, "utf8").toString("base64url");
  const signature = hmac(key, encodedPayload).toString("base64url");
  return { token: `${encodedPayload}.${signature}`, payloadJson, payload };
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!base64UrlPattern.test(value)) return undefined;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.toString("base64url") === value ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export function verifyPreviewAccessToken(
  configuration: PreviewSigningConfiguration,
  token: string,
  nowSeconds: number
): PreviewTokenPayload | undefined {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0 || !/^[\x00-\x7f]+$/.test(token)
    || Buffer.byteLength(token, "ascii") > maximumTokenBytes) return undefined;
  const components = token.split(".");
  if (components.length !== 2 || components.some((component) => component.length === 0)) return undefined;
  const payloadBytes = decodeBase64Url(components[0]!);
  const signatureBytes = decodeBase64Url(components[1]!);
  if (payloadBytes === undefined) return undefined;

  let payloadJson: string;
  let parsed: unknown;
  try {
    payloadJson = utf8.decode(payloadBytes);
    parsed = JSON.parse(payloadJson);
  } catch {
    return undefined;
  }
  const payload = exactPayload(parsed, configuration);
  if (payload === undefined || JSON.stringify(payload) !== payloadJson) return undefined;

  const key = configuration.keys.get(payload.kid);
  const expected = hmac(key?.length === 32 ? key : zeroKey, components[0]!);
  const supplied = signatureBytes?.length === 32 ? signatureBytes : zeroSignature;
  const signatureMatches = timingSafeEqual(expected, supplied);
  if (key === undefined || key.length !== 32 || signatureBytes?.length !== 32 || !signatureMatches) return undefined;
  if (payload.iat > nowSeconds + futureSkewSeconds || nowSeconds >= payload.exp) return undefined;
  return payload;
}

export function createPreviewCapabilityUrl(origin: string, token: string, entrypoint: string) {
  const encodedPath = entrypoint.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return `${origin}/_coffee-shop/preview/v1/${token}/${encodedPath}`;
}
