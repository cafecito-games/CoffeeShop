import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";
import { bridgeEnvironmentVariableNames } from "./configuration.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const pluginRoot = `${repositoryRoot}/plugins/coffeeshop-orchestrator`;
const bundledBridge = `${pluginRoot}/server/index.mjs`;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function readJson(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
}

test("Claude plugin maps secure user configuration into the bridge environment", async () => {
  const manifest = await readJson(`${pluginRoot}/.claude-plugin/plugin.json`);
  const mcp = await readJson(`${pluginRoot}/.mcp.json`);
  const packageJson = await readJson(`${repositoryRoot}/apps/orchestrator-bridge/package.json`);

  assert.equal(manifest.name, "coffeeshop-orchestrator");
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.defaultEnabled, false);
  assert.deepEqual(manifest.channels, [{ server: "coffeeshop" }]);
  assert.equal(manifest.userConfig.client_secret.sensitive, true);
  assert.equal(manifest.userConfig.client_secret.required, true);

  const server = mcp.mcpServers.coffeeshop;
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/server/index.mjs"]);
  assert.deepEqual(server.env, {
    [bridgeEnvironmentVariableNames.hubUrl]: "${user_config.hub_url}",
    [bridgeEnvironmentVariableNames.clientId]: "${user_config.client_id}",
    [bridgeEnvironmentVariableNames.clientSecret]: "${user_config.client_secret}"
  });
});

test("marketplace resolves the installable plugin inside its sparse checkout", async () => {
  const marketplace = await readJson(`${repositoryRoot}/.claude-plugin/marketplace.json`);
  assert.equal(marketplace.name, "cafecito-games");
  assert.deepEqual(marketplace.plugins.map((plugin: Record<string, unknown>) => ({
    name: plugin.name,
    source: plugin.source
  })), [{ name: "coffeeshop-orchestrator", source: "./plugins/coffeeshop-orchestrator" }]);
});

test("committed plugin bundle is the deterministic bridge build", async () => {
  const generated = await build({
    absWorkingDir: `${repositoryRoot}/apps/orchestrator-bridge`,
    entryPoints: ["src/index.ts"],
    bundle: true,
    minify: true,
    platform: "node",
    format: "esm",
    target: "node18",
    banner: { js: "import { createRequire } from \"node:module\"; const require = createRequire(import.meta.url);" },
    outfile: bundledBridge,
    write: false,
    logLevel: "silent"
  });
  assert.equal(generated.outputFiles.length, 1);
  assert.equal(
    digest(generated.outputFiles[0].contents),
    digest(await readFile(bundledBridge)),
    "the committed plugin bundle is stale; run pnpm --filter @coffee-shop/orchestrator-bridge build:plugin"
  );
});

test("bundled plugin bridge starts without workspace dependencies", async () => {
  const bundle = await readFile(bundledBridge, "utf8");
  assert.ok(bundle.length > 100_000, "the generated bridge bundle is unexpectedly small");
  assert.doesNotMatch(bundle, /^import .* from ["']@coffee-shop\//m);
  assert.doesNotMatch(bundle, /^import .* from ["']@modelcontextprotocol\//m);

  const child = spawn(process.execPath, [bundledBridge], {
    cwd: pluginRoot,
    env: {
      ...process.env,
      [bridgeEnvironmentVariableNames.hubUrl]: "",
      [bridgeEnvironmentVariableNames.clientId]: "",
      [bridgeEnvironmentVariableNames.clientSecret]: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const [code] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];

  assert.equal(code, 1);
  assert.equal(Buffer.concat(stdout).toString("utf8"), "");
  assert.match(Buffer.concat(stderr).toString("utf8"), /COFFEE_SHOP_HUB_URL is required/);
});
