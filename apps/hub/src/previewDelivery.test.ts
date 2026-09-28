import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express, { type Express } from "express";
import type { PreparedPreviewManifest } from "./previewStorage.js";
import {
  createMainPreviewHostGuard,
  createPreviewDeliveryApp,
  listenPreviewTopology,
  parsePreviewDeliveryConfig,
  previewContentType,
  rawRequestAuthority,
  registerPreviewOperatorRoutes,
  requestTargetsPreviewAuthority,
  runPreviewExpiryMaintenance,
  type EnabledPreviewDeliveryConfig,
  type PreviewDeliveryConfig
} from "./previewDelivery.js";
import { operatorCredentialGuard } from "./orchestratorClients.js";
import { PreviewStorage } from "./previewStorage.js";
import { Store, type State } from "./store.js";

const producerStateUrl = new URL("../test-fixtures/state-with-artifact-preview.json", import.meta.url);
const producerManifestUrl = new URL("../test-fixtures/preview-v1/manifest.json", import.meta.url);
const producerContentUrl = new URL("../test-fixtures/preview-v1/content/", import.meta.url);
const nowIso = "2026-09-27T12:04:00.000Z";
const secretOne = "00".repeat(32);
const secretTwo = "11".repeat(32);

const validEnvironment = {
  COFFEE_SHOP_PUBLIC_ORIGIN: "http://hub.localhost:8787",
  PREVIEW_PUBLIC_ORIGIN: "http://preview.localhost:8788",
  PREVIEW_BIND_HOST: "0.0.0.0",
  PREVIEW_PORT: "8788",
  PREVIEW_SIGNING_KEYS: `current:${secretOne},prior:${secretTwo}`,
  PREVIEW_ACTIVE_SIGNING_KEY_ID: "current",
  PREVIEW_ACCESS_DEFAULT_TTL_SECONDS: "900",
  PREVIEW_ACCESS_MAX_TTL_SECONDS: "3600"
} as const;

function enabledConfig(environment: Record<string, string | undefined> = validEnvironment) {
  const configuration = parsePreviewDeliveryConfig(environment);
  assert.equal(configuration.enabled, true);
  return configuration as EnabledPreviewDeliveryConfig;
}

test("preview delivery is disabled only when every related variable is absent", () => {
  assert.deepEqual(parsePreviewDeliveryConfig({}), { enabled: false });
  for (const key of Object.keys(validEnvironment)) {
    assert.throws(
      () => parsePreviewDeliveryConfig({ [key]: validEnvironment[key as keyof typeof validEnvironment] }),
      /PREVIEW_|COFFEE_SHOP_PUBLIC_ORIGIN/,
      key
    );
  }
});

test("configuration canonicalizes a complete local topology without exposing key text", () => {
  const configuration = enabledConfig();
  assert.equal(configuration.hubOrigin, "http://hub.localhost:8787");
  assert.equal(configuration.previewOrigin, "http://preview.localhost:8788");
  assert.equal(configuration.previewAuthority, "preview.localhost:8788");
  assert.equal(configuration.bindHost, "0.0.0.0");
  assert.equal(configuration.port, 8788);
  assert.equal(configuration.defaultTtlSeconds, 900);
  assert.equal(configuration.maximumTtlSeconds, 3600);
  assert.deepEqual(configuration.signing.keys.get("current"), Buffer.alloc(32));
  assert.equal(configuration.signing.activeKeyId, "current");
});

test("configuration rejects partial, malformed, duplicate, and unsafe values with redacted errors", () => {
  const cases: Array<[string, Record<string, string | undefined>]> = [
    ["missing required", { ...validEnvironment, PREVIEW_PORT: undefined }],
    ["relative hub origin", { ...validEnvironment, COFFEE_SHOP_PUBLIC_ORIGIN: "/hub" }],
    ["origin credentials", { ...validEnvironment, PREVIEW_PUBLIC_ORIGIN: "https://user:secret@preview.example.test" }],
    ["origin path", { ...validEnvironment, PREVIEW_PUBLIC_ORIGIN: "https://preview.example.test/path" }],
    ["origin query", { ...validEnvironment, PREVIEW_PUBLIC_ORIGIN: "https://preview.example.test/?x=1" }],
    ["origin fragment", { ...validEnvironment, PREVIEW_PUBLIC_ORIGIN: "https://preview.example.test/#x" }],
    ["wrong scheme", { ...validEnvironment, PREVIEW_PUBLIC_ORIGIN: "ftp://preview.example.test" }],
    ["unsafe remote HTTP", { ...validEnvironment, PREVIEW_PUBLIC_ORIGIN: "http://preview.example.test" }],
    ["same hostname different port", { ...validEnvironment, PREVIEW_PUBLIC_ORIGIN: "http://hub.localhost:9999" }],
    ["zero port", { ...validEnvironment, PREVIEW_PORT: "0" }],
    ["large port", { ...validEnvironment, PREVIEW_PORT: "65536" }],
    ["fractional port", { ...validEnvironment, PREVIEW_PORT: "8788.5" }],
    ["unsafe bind", { ...validEnvironment, PREVIEW_BIND_HOST: "http://0.0.0.0" }],
    ["empty key entry", { ...validEnvironment, PREVIEW_SIGNING_KEYS: `current:${secretOne},` }],
    ["duplicate key id", { ...validEnvironment, PREVIEW_SIGNING_KEYS: `current:${secretOne},current:${secretTwo}` }],
    ["uppercase key", { ...validEnvironment, PREVIEW_SIGNING_KEYS: `current:${"AA".repeat(32)}` }],
    ["short key", { ...validEnvironment, PREVIEW_SIGNING_KEYS: `current:${"0".repeat(63)}` }],
    ["too many keys", { ...validEnvironment, PREVIEW_SIGNING_KEYS: [0, 1, 2, 3, 4].map((i) => `key${i}:${secretOne}`).join(",") }],
    ["unknown active key", { ...validEnvironment, PREVIEW_ACTIVE_SIGNING_KEY_ID: "missing" }],
    ["default below minimum", { ...validEnvironment, PREVIEW_ACCESS_DEFAULT_TTL_SECONDS: "59" }],
    ["maximum above hard limit", { ...validEnvironment, PREVIEW_ACCESS_MAX_TTL_SECONDS: "3601" }],
    ["default over maximum", { ...validEnvironment, PREVIEW_ACCESS_DEFAULT_TTL_SECONDS: "901", PREVIEW_ACCESS_MAX_TTL_SECONDS: "900" }]
  ];
  for (const [name, environment] of cases) {
    let error: unknown;
    try {
      parsePreviewDeliveryConfig(environment);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof Error, name);
    assert.match(error.message, /PREVIEW_|COFFEE_SHOP_PUBLIC_ORIGIN/, name);
    assert.doesNotMatch(error.message, new RegExp(secretOne), `${name} redacts key material`);
    assert.doesNotMatch(error.message, new RegExp(secretTwo), `${name} redacts key material`);
  }
});

test("configuration allows HTTPS production hosts and only the closed local HTTP set", () => {
  for (const origin of [
    "https://preview.example.test",
    "http://localhost:8788",
    "http://nested.preview.localhost:8788",
    "http://127.0.0.1:8788",
    "http://[::1]:8788"
  ]) {
    const configuration = enabledConfig({
      ...validEnvironment,
      COFFEE_SHOP_PUBLIC_ORIGIN: "https://hub.example.test",
      PREVIEW_PUBLIC_ORIGIN: origin
    });
    assert.equal(configuration.previewOrigin, new URL(origin).origin);
  }
});

test("raw Host authority requires one header and ignores forwarded authority", () => {
  assert.equal(rawRequestAuthority({ rawHeaders: ["Host", "PREVIEW.LOCALHOST:8788"] }), "PREVIEW.LOCALHOST:8788");
  assert.equal(rawRequestAuthority({ rawHeaders: ["host", "preview.localhost:8788", "Host", "preview.localhost:8788"] }), undefined);
  assert.equal(rawRequestAuthority({ rawHeaders: ["X-Forwarded-Host", "preview.localhost:8788"] }), undefined);
  assert.equal(rawRequestAuthority({ rawHeaders: ["Host", "preview.localhost:8788,other"] }), undefined);

  const httpsConfiguration = enabledConfig({
    ...validEnvironment,
    COFFEE_SHOP_PUBLIC_ORIGIN: "https://hub.example.test",
    PREVIEW_PUBLIC_ORIGIN: "https://preview.example.test"
  });
  assert.equal(requestTargetsPreviewAuthority({ rawHeaders: ["Host", "PREVIEW.EXAMPLE.TEST"] }, httpsConfiguration), true);
  assert.equal(requestTargetsPreviewAuthority({ rawHeaders: ["Host", "preview.example.test:443"] }, httpsConfiguration), true,
    "an explicit default port is the only accepted serialization difference");
  assert.equal(requestTargetsPreviewAuthority({ rawHeaders: ["Host", "%70review.example.test"] }, httpsConfiguration), false,
    "URL-parser hostname rewrites are not Host normalization");
});

test("the fixed MIME table is extension-only and closed", () => {
  const cases: Record<string, string> = {
    "a.HTML": "text/html; charset=utf-8",
    "a.css": "text/css; charset=utf-8",
    "a.js": "text/javascript; charset=utf-8",
    "a.mjs": "text/javascript; charset=utf-8",
    "a.json": "application/json; charset=utf-8",
    "a.map": "application/json; charset=utf-8",
    "a.webmanifest": "application/manifest+json",
    "a.txt": "text/plain; charset=utf-8",
    "a.svg": "image/svg+xml",
    "a.png": "image/png",
    "a.jpg": "image/jpeg",
    "a.jpeg": "image/jpeg",
    "a.gif": "image/gif",
    "a.webp": "image/webp",
    "a.avif": "image/avif",
    "a.ico": "image/x-icon",
    "a.woff": "font/woff",
    "a.woff2": "font/woff2",
    "a.ttf": "font/ttf",
    "a.otf": "font/otf",
    "a.wasm": "application/wasm",
    "a.mp3": "audio/mpeg",
    "a.mp4": "video/mp4",
    "a.webm": "video/webm",
    "archive.tar.gz": "application/octet-stream"
  };
  for (const [path, expected] of Object.entries(cases)) assert.equal(previewContentType(path), expected, path);
});

test("checked-in container configuration declares both listeners without a real signing key", async () => {
  const environment = await readFile(new URL("../../../.env.example", import.meta.url), "utf8");
  const compose = await readFile(new URL("../../../compose.yaml", import.meta.url), "utf8");
  const dockerfile = await readFile(new URL("../../../Dockerfile", import.meta.url), "utf8");
  for (const variable of [
    "COFFEE_SHOP_PUBLIC_ORIGIN", "PREVIEW_PUBLIC_ORIGIN", "PREVIEW_BIND_HOST", "PREVIEW_PORT",
    "PREVIEW_SIGNING_KEYS", "PREVIEW_ACTIVE_SIGNING_KEY_ID", "PREVIEW_ACCESS_DEFAULT_TTL_SECONDS",
    "PREVIEW_ACCESS_MAX_TTL_SECONDS"
  ]) {
    assert.match(environment, new RegExp(`^# ${variable}=`, "m"), `${variable} is documented but opt-in`);
    assert.doesNotMatch(environment, new RegExp(`^${variable}=`, "m"), `${variable} does not partially enable delivery`);
    assert.match(compose, new RegExp(`${variable}:`), variable);
  }
  assert.match(compose, /8788/);
  assert.match(dockerfile, /EXPOSE 8787 8788/);
  assert.doesNotMatch(`${environment}\n${compose}`, /[A-Za-z0-9_-]+:[a-f0-9]{64}/,
    "deployment fixtures contain instructions/placeholders, never a usable key");
});

interface Fixture {
  directory: string;
  statePath: string;
  store: Store;
  storage: PreviewStorage;
  manifest: PreparedPreviewManifest;
}

async function preparedFixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-preview-delivery-"));
  const statePath = join(directory, "state.json");
  await writeFile(statePath, await readFile(producerStateUrl));
  const store = new Store(statePath);
  await store.load();
  const storage = new PreviewStorage(directory);
  const manifest = JSON.parse(await readFile(producerManifestUrl, "utf8")) as PreparedPreviewManifest;
  const preview = store.read((state) => structuredClone(state.artifactPreviews![0]!));
  const workspace = await storage.createPreparationWorkspace({
    previewId: manifest.previewId,
    artifactId: manifest.artifactId,
    artifactSha256: manifest.artifactSha256,
    entrypoint: manifest.entrypoint,
    processingGeneration: preview.processingGeneration
  });
  for (const file of manifest.files) {
    const bytes = await readFile(new URL(file.path, producerContentUrl));
    const path = join(workspace.contentDirectory, ...file.path.split("/"));
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { mode: 0o600 });
  }
  await storage.publishPrepared(workspace, manifest, 239);
  return { directory, statePath, store, storage, manifest };
}

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

async function listen(app: Express) {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, port: address.port };
}

async function close(server: Server) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function httpRequest(
  port: number,
  method: string,
  path: string,
  host: string,
  options: { headers?: Record<string, string>; body?: unknown } = {}
): Promise<HttpResult> {
  const body = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
  return await new Promise<HttpResult>((resolve, reject) => {
    const pending = request({
      hostname: "127.0.0.1",
      port,
      method,
      path,
      headers: {
        Host: host,
        ...(body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": String(body.length) }),
        ...options.headers
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    pending.on("error", reject);
    if (body) pending.write(body);
    pending.end();
  });
}

test("a preview bind failure closes an otherwise successful Hub bind", async () => {
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  const blockerAddress = blocker.address();
  assert.ok(blockerAddress && typeof blockerAddress === "object");
  const main = createServer();
  const preview = createServer();
  try {
    await assert.rejects(listenPreviewTopology(
      { server: main, port: 0, host: "127.0.0.1" },
      { server: preview, port: blockerAddress.port, host: "127.0.0.1" }
    ));
    assert.equal(main.listening, false);
    assert.equal(preview.listening, false);
  } finally {
    if (main.listening) await close(main);
    if (preview.listening) await close(preview);
    await close(blocker);
  }
});

function operatorApp(
  fixture: Fixture,
  configuration: PreviewDeliveryConfig,
  now: () => number,
  broadcast: () => void = () => undefined
) {
  const app = express();
  app.use(createMainPreviewHostGuard(configuration));
  app.use(express.json({ limit: "1mb" }));
  app.use(operatorCredentialGuard("operator-secret"));
  registerPreviewOperatorRoutes(app, { ...fixture, configuration, now, broadcast });
  app.use((_request, response) => response.status(200).send("hub fallback"));
  return app;
}

test("operator issuance is authenticated, read-only, exact-schema, and fails closed", async () => {
  const fixture = await preparedFixture();
  const configuration = enabledConfig();
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const { server, port } = await listen(operatorApp(fixture, configuration, () => Date.parse(nowIso)));
  try {
    const previewId = fixture.manifest.previewId;
    assert.equal((await httpRequest(port, "POST", `/api/previews/${previewId}/access`, "hub.localhost:8787", { body: {} })).status, 401);
    assert.equal((await httpRequest(port, "POST", `/api/previews/${previewId}/renew`, "hub.localhost:8787", {
      body: { ttlSeconds: 86_400 }
    })).status, 401);
    assert.equal((await httpRequest(port, "POST", `/api/previews/${previewId}/access`, "preview.localhost:8788", { body: {} })).status, 421,
      "preview authority never reaches Hub auth or fallback");
    assert.equal((await httpRequest(port, "GET", "/ordinary-page", "hub.localhost:8787", {
      headers: { Authorization: "Bearer operator-secret" }
    })).status, 200, "the reciprocal guard does not narrow ordinary Hub hostnames");
    for (const body of [{ ttlSeconds: 59 }, { ttlSeconds: 3_601 }, { ttlSeconds: 60.5 }, { ttlSeconds: "60" }, { ttlSeconds: 60, extra: true }]) {
      assert.equal((await httpRequest(port, "POST", `/api/previews/${previewId}/access`, "hub.localhost:8787", {
        headers: { Authorization: "Bearer operator-secret" }, body
      })).status, 422, JSON.stringify(body));
    }
    assert.equal((await httpRequest(port, "POST", "/api/previews/missing/access", "hub.localhost:8787", {
      headers: { Authorization: "Bearer operator-secret" }, body: {}
    })).status, 404);

    const before = await readFile(fixture.statePath);
    const issued = await httpRequest(port, "POST", `/api/previews/${previewId}/access`, "hub.localhost:8787", {
      headers: { Authorization: "Bearer operator-secret" }, body: { ttlSeconds: 60 }
    });
    assert.equal(issued.status, 200);
    const response = JSON.parse(issued.body.toString("utf8"));
    assert.deepEqual(Object.keys(response), ["previewId", "url", "expiresAt"]);
    assert.equal(response.previewId, previewId);
    assert.equal(response.expiresAt, "2026-09-27T12:05:00.000Z");
    assert.match(response.url, /^http:\/\/preview\.localhost:8788\/_coffee-shop\/preview\/v1\//);
    assert.deepEqual(await readFile(fixture.statePath), before, "issuance persists no token, URL, or receipt");
    assert.doesNotMatch(JSON.stringify(fixture.store.snapshot(nowIso)), /_coffee-shop\/preview\/v1|signedUrl|bearer/i);

    const content = join(fixture.directory, "prepared-previews", fixture.manifest.previewId,
      fixture.manifest.artifactSha256, "content", "site", "index.html");
    await writeFile(content, "issuance drift", { mode: 0o600 });
    assert.equal((await httpRequest(port, "POST", `/api/previews/${previewId}/access`, "hub.localhost:8787", {
      headers: { Authorization: "Bearer operator-secret" }, body: {}
    })).status, 409, "storage drift never receives a capability");
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
    await close(server);
  }
});

test("operator issuance refuses every known but unavailable lifecycle or artifact state", async () => {
  const cases: Array<[string, ((state: State) => void) | undefined, number]> = [
    ["non-ready", (state) => {
      const preview = state.artifactPreviews![0]!;
      preview.status = "processing";
      delete preview.readyAt;
    }, Date.parse(nowIso)],
    ["wall-clock expired", undefined, Date.parse("2026-09-28T12:00:00.000Z")],
    ["artifact not uploaded", (state) => { state.artifacts![0]!.uploaded = false; }, Date.parse(nowIso)],
    ["artifact cross-link mismatch", (state) => { state.artifacts![0]!.runId = "another-run"; }, Date.parse(nowIso)]
  ];
  for (const [name, mutate, currentTime] of cases) {
    const fixture = await preparedFixture();
    if (mutate) await fixture.store.transact((state) => { mutate(state); });
    const { server, port } = await listen(operatorApp(fixture, enabledConfig(), () => currentTime));
    try {
      const result = await httpRequest(port, "POST", `/api/previews/${fixture.manifest.previewId}/access`,
        "hub.localhost:8787", { headers: { Authorization: "Bearer operator-secret" }, body: {} });
      assert.equal(result.status, 409, name);
      assert.deepEqual(JSON.parse(result.body.toString("utf8")), { error: "Preview access is unavailable" }, name);
    } finally {
      await close(server);
    }
  }
});

test("disabled delivery returns bounded 503 while renewal delegates and broadcasts only a commit", async () => {
  const fixture = await preparedFixture();
  let broadcasts = 0;
  const { server, port } = await listen(operatorApp(fixture, { enabled: false }, () => Date.parse(nowIso), () => { broadcasts += 1; }));
  try {
    const previewId = fixture.manifest.previewId;
    const access = await httpRequest(port, "POST", `/api/previews/${previewId}/access`, "hub.localhost:8787", { body: {} });
    assert.equal(access.status, 503);
    assert.ok(access.body.length < 256);

    for (const body of [{}, { ttlSeconds: 300, extra: true }, { ttlSeconds: "300" }]) {
      assert.equal((await httpRequest(port, "POST", `/api/previews/${previewId}/renew`, "hub.localhost:8787", { body })).status, 422);
    }
    assert.equal(broadcasts, 0);
    const renewed = await httpRequest(port, "POST", `/api/previews/${previewId}/renew`, "hub.localhost:8787", {
      body: { ttlSeconds: 86_400 }
    });
    assert.equal(renewed.status, 200);
    const response = JSON.parse(renewed.body.toString("utf8"));
    assert.equal(response.preview.id, previewId);
    assert.equal(response.preview.status, "ready");
    assert.equal(broadcasts, 1);
  } finally {
    await close(server);
  }
});

test("the isolated app serves producer bytes under one capability with fixed response policy", async () => {
  const fixture = await preparedFixture();
  const configuration = enabledConfig();
  let currentTime = Date.parse(nowIso);
  const operator = await listen(operatorApp(fixture, configuration, () => currentTime));
  const delivery = await listen(createPreviewDeliveryApp({ ...fixture, configuration, now: () => currentTime }));
  try {
    const issued = await httpRequest(operator.port, "POST", `/api/previews/${fixture.manifest.previewId}/access`, "hub.localhost:8787", {
      body: { ttlSeconds: 60 }
    });
    const issuedUrl = new URL(JSON.parse(issued.body.toString("utf8")).url);
    const entrypoint = await httpRequest(delivery.port, "GET", `${issuedUrl.pathname}?ignored=1`, "PREVIEW.LOCALHOST:8788", {
      headers: { Cookie: "session=ignored", Authorization: "Bearer ignored", Range: "bytes=0-3" }
    });
    assert.equal(entrypoint.status, 200);
    assert.deepEqual(entrypoint.body, await readFile(new URL("site/index.html", producerContentUrl)));
    assert.equal(entrypoint.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(entrypoint.headers["content-length"], "92");
    assert.equal(entrypoint.headers["content-range"], undefined);
    assert.equal(entrypoint.headers["content-security-policy"],
      "default-src 'none'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors http://hub.localhost:8787; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'self'; connect-src 'none'; worker-src 'self'; manifest-src 'self'");
    assert.equal(entrypoint.headers["x-content-type-options"], "nosniff");
    assert.equal(entrypoint.headers["referrer-policy"], "no-referrer");
    assert.equal(entrypoint.headers["permissions-policy"], "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()");
    assert.equal(entrypoint.headers["cache-control"], "private, no-store, max-age=0");
    assert.equal(entrypoint.headers.pragma, "no-cache");
    assert.equal(entrypoint.headers.expires, "0");
    assert.equal(entrypoint.headers["cross-origin-opener-policy"], "same-origin");
    assert.equal(entrypoint.headers["cross-origin-resource-policy"], "same-origin");
    assert.equal(entrypoint.headers["x-frame-options"], undefined);
    assert.equal(entrypoint.headers["set-cookie"], undefined);
    assert.equal(entrypoint.headers["access-control-allow-origin"], undefined);
    assert.equal(entrypoint.headers["access-control-allow-credentials"], undefined);

    const scriptPath = issuedUrl.pathname.replace(/site\/index\.html$/, "site/app.js");
    const script = await httpRequest(delivery.port, "GET", scriptPath, "preview.localhost:8788");
    assert.equal(script.status, 200);
    assert.deepEqual(script.body, await readFile(new URL("site/app.js", producerContentUrl)));
    assert.equal(script.headers["content-type"], "text/javascript; charset=utf-8");

    const opaqueBytes = Buffer.from("verified opaque bytes", "utf8");
    const opaquePath = "site/download.coffee";
    const opaqueStorage = {
      readPreparedFile: async () => ({
        bytes: opaqueBytes,
        file: { path: opaquePath, size: opaqueBytes.length, sha256: createHash("sha256").update(opaqueBytes).digest("hex") },
        manifest: fixture.manifest
      })
    } as unknown as PreviewStorage;
    const attachmentDelivery = await listen(createPreviewDeliveryApp({
      ...fixture,
      storage: opaqueStorage,
      configuration,
      now: () => currentTime
    }));
    try {
      const attachmentPath = issuedUrl.pathname.replace(/site\/index\.html$/, opaquePath);
      const attachment = await httpRequest(attachmentDelivery.port, "GET", attachmentPath, "preview.localhost:8788");
      assert.equal(attachment.status, 200);
      assert.deepEqual(attachment.body, opaqueBytes);
      assert.equal(attachment.headers["content-type"], "application/octet-stream");
      assert.equal(attachment.headers["content-disposition"], "attachment");
      assert.equal(attachment.headers["x-content-type-options"], "nosniff");
    } finally {
      await close(attachmentDelivery.server);
    }

    const head = await httpRequest(delivery.port, "HEAD", issuedUrl.pathname, "preview.localhost:8788");
    assert.equal(head.status, 200);
    assert.equal(head.headers["content-length"], "92");
    assert.equal(head.body.length, 0);
    const method = await httpRequest(delivery.port, "POST", issuedUrl.pathname, "preview.localhost:8788");
    assert.equal(method.status, 405);
    assert.equal(method.headers.allow, "GET, HEAD");

    const renewed = await httpRequest(operator.port, "POST", `/api/previews/${fixture.manifest.previewId}/renew`, "hub.localhost:8787", {
      body: { ttlSeconds: 86_400 }
    });
    assert.equal(renewed.status, 200);
    currentTime = Date.parse("2026-09-27T12:05:00.000Z");
    assert.equal((await httpRequest(delivery.port, "GET", issuedUrl.pathname, "preview.localhost:8788")).status, 404,
      "renewal never extends an already issued bearer");
  } finally {
    await close(delivery.server);
    await close(operator.server);
  }
});

test("host, token, state, path, and storage failures are generic and never consult state before signature", async () => {
  const fixture = await preparedFixture();
  const configuration = enabledConfig();
  let currentTime = Date.parse(nowIso);
  const logs: unknown[] = [];
  const operator = await listen(operatorApp(fixture, configuration, () => currentTime));
  const delivery = await listen(createPreviewDeliveryApp({
    ...fixture,
    configuration,
    now: () => currentTime,
    log: (event) => logs.push(event)
  }));
  try {
    const issued = await httpRequest(operator.port, "POST", `/api/previews/${fixture.manifest.previewId}/access`, "hub.localhost:8787", {
      body: { ttlSeconds: 60 }
    });
    const pathname = new URL(JSON.parse(issued.body.toString("utf8")).url).pathname;
    const [prefix, tokenAndPath] = pathname.split("/_coffee-shop/preview/v1/");
    assert.equal(prefix, "");
    const slash = tokenAndPath!.indexOf("/");
    const token = tokenAndPath!.slice(0, slash);
    const generic = await httpRequest(delivery.port, "GET", `${pathname.slice(0, -1)}x`, "preview.localhost:8788");
    assert.equal(generic.status, 404);
    for (const candidate of [
      `/_coffee-shop/preview/v1/${token.slice(0, -1)}A/site/index.html`,
      `/_coffee-shop/preview/v1/bad/site/index.html?token=${encodeURIComponent(token)}`,
      `/_coffee-shop/preview/v1/${token}/site/%2e%2e/index.html`,
      `/_coffee-shop/preview/v1/${token}/site%2Findex.html`,
      `/_coffee-shop/preview/v1/${token}/site%5Cindex.html`,
      `/_coffee-shop/preview/v1/${token}/site/%252Findex.html`,
      `/_coffee-shop/preview/v1/${token}/site//index.html`,
      `/_coffee-shop/preview/v1/${token}/cafe%CC%81/index.html`,
      `/_coffee-shop/preview/v1/${token}/site/%`,
      `/_coffee-shop/preview/v1/${token}/site`,
      "/api/health"
    ]) {
      const denied = await httpRequest(delivery.port, "GET", candidate, "preview.localhost:8788", {
        headers: { Cookie: `capability=${token}`, Authorization: "Bearer hub-token" }
      });
      assert.equal(denied.status, 404, candidate);
      assert.deepEqual(denied.body, generic.body, candidate);
      assert.equal(denied.headers["cache-control"], "private, no-store, max-age=0");
      assert.equal(denied.headers["content-security-policy"],
        "default-src 'none'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors http://hub.localhost:8787; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'self'; connect-src 'none'; worker-src 'self'; manifest-src 'self'");
      assert.equal(denied.headers["set-cookie"], undefined);
      assert.equal(denied.headers["access-control-allow-origin"], undefined);
    }
    const wrongHost = await httpRequest(delivery.port, "GET", pathname, "hub.localhost:8787", {
      headers: { "X-Forwarded-Host": "preview.localhost:8788" }
    });
    assert.equal(wrongHost.status, 421);

    const deniedHead = await httpRequest(delivery.port, "HEAD",
      `/_coffee-shop/preview/v1/${token.slice(0, -1)}A/site/index.html`, "preview.localhost:8788");
    assert.equal(deniedHead.status, 404);
    assert.equal(deniedHead.body.length, 0);
    assert.equal(deniedHead.headers["content-length"], generic.headers["content-length"]);
    assert.equal(deniedHead.headers["cache-control"], "private, no-store, max-age=0");
    assert.equal(deniedHead.headers["set-cookie"], undefined);
    assert.equal(deniedHead.headers["access-control-allow-origin"], undefined);

    currentTime = Date.parse("2026-09-27T12:05:00.000Z");
    assert.equal((await httpRequest(delivery.port, "GET", pathname, "preview.localhost:8788")).status, 404,
      "the signed expiry boundary is closed");

    currentTime = Date.parse(nowIso);
    const content = join(fixture.directory, "prepared-previews", fixture.manifest.previewId,
      fixture.manifest.artifactSha256, "content", "site", "index.html");
    await writeFile(content, "drift", { mode: 0o600 });
    assert.equal((await httpRequest(delivery.port, "GET", pathname, "preview.localhost:8788")).status, 404);
    const logged = JSON.stringify(logs);
    assert.doesNotMatch(logged, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(logged, /site|index\.html|drift|Cookie|Authorization|prepared-previews/);
    assert.match(logged, /storage-conflict/);
  } finally {
    await close(delivery.server);
    await close(operator.server);
  }

  let reads = 0;
  const noLookupApp = createPreviewDeliveryApp({
    store: { read: () => { reads += 1; throw new Error("state must not be read"); } } as unknown as Store,
    storage: {} as PreviewStorage,
    configuration,
    now: () => Date.parse(nowIso)
  });
  const noLookup = await listen(noLookupApp);
  try {
    assert.equal((await httpRequest(noLookup.port, "GET", "/_coffee-shop/preview/v1/bad/file.html", "preview.localhost:8788")).status, 404);
    assert.equal(reads, 0);
  } finally {
    await close(noLookup.server);
  }
});

test("expiry maintenance persists only due transitions and broadcasts only on change", async () => {
  const fixture = await preparedFixture();
  let broadcasts = 0;
  assert.equal(await runPreviewExpiryMaintenance(fixture.store, () => { broadcasts += 1; }, Date.parse(nowIso)), 0);
  assert.equal(broadcasts, 0);
  const boundary = Date.parse("2026-09-28T12:00:00.000Z");
  assert.equal(await runPreviewExpiryMaintenance(fixture.store, () => { broadcasts += 1; }, boundary), 1);
  assert.equal(broadcasts, 1);
  assert.equal(fixture.store.snapshot(new Date(boundary).toISOString()).artifactPreviews![0]!.status, "expired");
  assert.equal(await runPreviewExpiryMaintenance(fixture.store, () => { broadcasts += 1; }, boundary + 1_000), 0);
  assert.equal(broadcasts, 1);
});
