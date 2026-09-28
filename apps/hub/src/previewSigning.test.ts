import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  createPreviewCapabilityUrl,
  signPreviewAccessToken,
  verifyPreviewAccessToken,
  type PreviewSigningConfiguration,
  type PreviewTokenPayload
} from "./previewSigning.js";

const keyOne = Buffer.from([...Array(32).keys()]);
const keyTwo = Buffer.from([...Array(32).keys()].map((value) => 255 - value));
const origin = "https://preview.example.test";
const configuration = (activeKeyId = "key-one", includePrior = true): PreviewSigningConfiguration => ({
  origin,
  activeKeyId,
  maximumTtlSeconds: 3_600,
  keys: new Map(activeKeyId === "key-two"
    ? [["key-two", keyTwo], ...(includePrior ? [["key-one", keyOne] as const] : [])]
    : [["key-one", keyOne], ...(includePrior ? [["key-two", keyTwo] as const] : [])])
});
const identity = {
  previewId: "preview-one",
  artifactId: "artifact-one",
  artifactSha256: "0123456789abcdef".repeat(4),
  processingGeneration: 3
};
const iat = 1_735_689_600;
const exp = iat + 900;

const canonicalPayload: PreviewTokenPayload = {
  v: 1,
  kid: "key-one",
  origin,
  ...identity,
  iat,
  exp
};

function signedRaw(value: string, key = keyOne) {
  const payload = Buffer.from(value).toString("base64url");
  const signature = createHmac("sha256", key)
    .update(`coffee-shop-preview-v1\0${payload}`, "utf8")
    .digest("base64url");
  return `${payload}.${signature}`;
}

test("signs the exact canonical v1 payload and HMAC byte vector", () => {
  const signed = signPreviewAccessToken(configuration(), identity, iat, exp);
  assert.equal(signed.payloadJson,
    "{\"v\":1,\"kid\":\"key-one\",\"origin\":\"https://preview.example.test\",\"previewId\":\"preview-one\",\"artifactId\":\"artifact-one\",\"artifactSha256\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\",\"processingGeneration\":3,\"iat\":1735689600,\"exp\":1735690500}");
  assert.equal(signed.token,
    "eyJ2IjoxLCJraWQiOiJrZXktb25lIiwib3JpZ2luIjoiaHR0cHM6Ly9wcmV2aWV3LmV4YW1wbGUudGVzdCIsInByZXZpZXdJZCI6InByZXZpZXctb25lIiwiYXJ0aWZhY3RJZCI6ImFydGlmYWN0LW9uZSIsImFydGlmYWN0U2hhMjU2IjoiMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZiIsInByb2Nlc3NpbmdHZW5lcmF0aW9uIjozLCJpYXQiOjE3MzU2ODk2MDAsImV4cCI6MTczNTY5MDUwMH0.OGxqXxS3mTf3v7xVKfs5ireJuT9qjTzWnJ2nF7k-QPE");
  assert.deepEqual(verifyPreviewAccessToken(configuration(), signed.token, iat), canonicalPayload);
  assert.equal(signPreviewAccessToken(configuration(), identity, iat, exp).token, signed.token,
    "identical semantic input at the same second is byte-identical");
});

test("encodes each entrypoint segment while keeping the capability in the path prefix", () => {
  const token = signPreviewAccessToken(configuration(), identity, iat, exp).token;
  assert.equal(
    createPreviewCapabilityUrl(origin, token, "café assets/index one.html"),
    `${origin}/_coffee-shop/preview/v1/${token}/caf%C3%A9%20assets/index%20one.html`
  );
});

test("verification enforces exact expiry, duration, and future-skew boundaries", () => {
  const acceptedAtSkew = signPreviewAccessToken(configuration(), identity, iat + 30, iat + 90).token;
  assert.ok(verifyPreviewAccessToken(configuration(), acceptedAtSkew, iat));
  const rejectedPastSkew = signPreviewAccessToken(configuration(), identity, iat + 31, iat + 91).token;
  assert.equal(verifyPreviewAccessToken(configuration(), rejectedPastSkew, iat), undefined);

  const token = signPreviewAccessToken(configuration(), identity, iat, exp).token;
  assert.ok(verifyPreviewAccessToken(configuration(), token, exp - 1));
  assert.equal(verifyPreviewAccessToken(configuration(), token, exp), undefined);

  const maximum = signPreviewAccessToken(configuration(), identity, iat, iat + 3_600).token;
  assert.ok(verifyPreviewAccessToken(configuration(), maximum, iat));
  const overMaximum = signedRaw(JSON.stringify({ ...canonicalPayload, exp: iat + 3_601 }));
  assert.equal(verifyPreviewAccessToken(configuration(), overMaximum, iat), undefined);
});

test("verification rejects malformed and noncanonical payloads before they can authorize state", () => {
  const exact = JSON.stringify(canonicalPayload);
  const cases: Array<[string, string]> = [
    ["field order", signedRaw(JSON.stringify({ kid: "key-one", v: 1, origin, ...identity, iat, exp }))],
    ["extra field", signedRaw(JSON.stringify({ ...canonicalPayload, extra: true }))],
    ["wrong version", signedRaw(JSON.stringify({ ...canonicalPayload, v: 2 }))],
    ["wrong origin", signedRaw(JSON.stringify({ ...canonicalPayload, origin: "https://other.example.test" }))],
    ["empty preview id", signedRaw(JSON.stringify({ ...canonicalPayload, previewId: "" }))],
    ["oversized artifact id", signedRaw(JSON.stringify({ ...canonicalPayload, artifactId: "a".repeat(257) }))],
    ["uppercase digest", signedRaw(JSON.stringify({ ...canonicalPayload, artifactSha256: "A".repeat(64) }))],
    ["zero generation", signedRaw(JSON.stringify({ ...canonicalPayload, processingGeneration: 0 }))],
    ["fractional issued time", signedRaw(JSON.stringify({ ...canonicalPayload, iat: iat + 0.5 }))],
    ["nonpositive duration", signedRaw(JSON.stringify({ ...canonicalPayload, exp: iat }))],
    ["unknown key", signedRaw(JSON.stringify({ ...canonicalPayload, kid: "missing" }))],
    ["bad signature", `${Buffer.from(exact).toString("base64url")}.${"A".repeat(43)}`],
    ["short signature", `${Buffer.from(exact).toString("base64url")}.AA`],
    ["padded payload", `${Buffer.from(exact).toString("base64url")}=.${"A".repeat(43)}`],
    ["extra component", `${signedRaw(exact)}.AA`],
    ["invalid UTF-8", signedRaw(Buffer.from([0xc3, 0x28]).toString("latin1"))]
  ];
  for (const [name, token] of cases) {
    assert.equal(verifyPreviewAccessToken(configuration(), token, iat), undefined, name);
  }
  assert.equal(verifyPreviewAccessToken(configuration(), "a".repeat(1_025), iat), undefined, "bounded token");
});

test("rotation issues only with the active key and validates only retained exact keys", () => {
  const original = signPreviewAccessToken(configuration("key-one"), identity, iat, exp).token;
  const rotated = signPreviewAccessToken(configuration("key-two"), identity, iat, exp).token;
  assert.notEqual(rotated, original);
  assert.equal(verifyPreviewAccessToken(configuration("key-two"), original, iat)?.kid, "key-one");
  assert.equal(verifyPreviewAccessToken(configuration("key-two"), rotated, iat)?.kid, "key-two");
  assert.equal(verifyPreviewAccessToken(configuration("key-two", false), original, iat), undefined,
    "removing the prior key immediately revokes its grants");
  assert.equal(verifyPreviewAccessToken(configuration("key-two", false), rotated, iat)?.kid, "key-two",
    "the same environmental key ring survives restart without persisted grants");
});
