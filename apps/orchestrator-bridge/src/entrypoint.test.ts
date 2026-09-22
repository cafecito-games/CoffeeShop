import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { bridgeEnvironmentVariableNames } from "./configuration.js";
import { FakeHub } from "./fakeHub.js";
import { pinnedProtocolRevision } from "./protocolRevision.js";

const entrypoint = fileURLToPath(new URL("./index.ts", import.meta.url));
const secret = "unmistakable-orchestrator-secret-4f2b9c";

interface RunningBridge {
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
  stop: () => void;
}

function startBridge(environment: Record<string, string>): RunningBridge {
  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
    env: { ...process.env, ...environment },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout.push(chunk));
  child.stderr.on("data", (chunk: string) => stderr.push(chunk));
  return { child, stdout, stderr, stop: () => child.kill("SIGKILL") };
}

const waitFor = async (predicate: () => boolean, description: string, timeoutMilliseconds = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test("refuses to start without configuration and says which variables are missing", async () => {
  const bridge = startBridge({
    [bridgeEnvironmentVariableNames.hubUrl]: "",
    [bridgeEnvironmentVariableNames.clientId]: "",
    [bridgeEnvironmentVariableNames.clientSecret]: ""
  });
  const [code] = (await once(bridge.child, "exit")) as [number | null, NodeJS.Signals | null];
  assert.equal(code, 1);
  const stderr = bridge.stderr.join("");
  for (const name of Object.values(bridgeEnvironmentVariableNames)) assert.ok(stderr.includes(name));
  assert.equal(bridge.stdout.join(""), "", "nothing may be written to the MCP stream before the bridge is configured");
});

test("refuses a hub URL that is not a WebSocket endpoint", async () => {
  const bridge = startBridge({
    [bridgeEnvironmentVariableNames.hubUrl]: "https://hub.example.com/orchestrator-client",
    [bridgeEnvironmentVariableNames.clientId]: "client-alpha",
    [bridgeEnvironmentVariableNames.clientSecret]: secret
  });
  const [code] = (await once(bridge.child, "exit")) as [number | null, NodeJS.Signals | null];
  assert.equal(code, 1);
  assert.ok(bridge.stderr.join("").includes("ws://"));
  assert.ok(!`${bridge.stdout.join("")}${bridge.stderr.join("")}`.includes(secret));
});

test("never prints the client secret, even while the hub rejects it and frames are malformed", async (t) => {
  const hub = await FakeHub.start({ closeReason: "unauthorized" });
  t.after(() => hub.stop());
  const bridge = startBridge({
    [bridgeEnvironmentVariableNames.hubUrl]: hub.url,
    [bridgeEnvironmentVariableNames.clientId]: "client-alpha",
    [bridgeEnvironmentVariableNames.clientSecret]: secret
  });
  t.after(() => bridge.stop());

  await waitFor(() => hub.connectionCount >= 1, "the rejected handshake");
  bridge.child.stdin.write("{not json at all}\n");
  bridge.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "fake", version: "0" } } })}\n`);
  await waitFor(() => bridge.stdout.join("").includes("protocolVersion"), "the initialize response");
  await waitFor(() => hub.connectionCount >= 2, "a reconnect attempt");

  const everything = `${bridge.stdout.join("")}${bridge.stderr.join("")}`;
  assert.ok(everything.length > 0, "the bridge produced no output to inspect");
  assert.ok(!everything.includes(secret), "the client secret must never reach stdout or stderr");

  const response = JSON.parse(bridge.stdout.join("").split("\n").find((line) => line.includes("protocolVersion")) ?? "{}") as {
    result?: { protocolVersion?: string; capabilities?: { experimental?: Record<string, unknown> } };
  };
  assert.equal(response.result?.protocolVersion, pinnedProtocolRevision);
  assert.deepEqual(response.result?.capabilities?.experimental?.["claude/channel"], {});
});
