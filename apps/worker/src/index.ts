import { execFile } from "node:child_process";
import { hostname, platform, arch } from "node:os";
import { promisify } from "node:util";
import WebSocket from "ws";
import type { ComputeNode, HarnessProfile, HubToWorker, WorkerToHub } from "@coffee-shop/protocol";
import { assertWorkspaceAllowed, startHarness } from "./harnesses.js";

const exec = promisify(execFile);
const hub = process.env.HUB_URL ?? "http://localhost:8787";
const token = process.env.COFFEE_SHOP_TOKEN ?? "dev-coffee";
const nodeId = process.env.NODE_ID ?? hostname().toLowerCase().replace(/[^a-z0-9-]/g, "-");
const roots = (process.env.WORKSPACE_ROOTS ?? process.cwd()).split(",").map((value) => value.trim());
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 2);
const running = new Map<string, ReturnType<typeof startHarness>>();

async function inspectHarness(id: "claude-cli" | "codex-cli", binary: string, authMode: HarnessProfile["authMode"]): Promise<HarnessProfile> {
  try {
    const { stdout } = await exec(binary, ["--version"], { timeout: 5_000 });
    return { id, label: id === "claude-cli" ? "Claude Code" : "Codex", description: stdout.trim(), binary, available: true, authMode, models: id === "claude-cli" ? ["sonnet", "opus", "haiku"] : [] };
  } catch {
    return { id, label: id === "claude-cli" ? "Claude Code" : "Codex", description: "Not installed", binary, available: false, authMode, models: [] };
  }
}

const node: ComputeNode = {
  id: nodeId,
  name: process.env.NODE_NAME ?? hostname(),
  kind: (process.env.NODE_KIND as ComputeNode["kind"]) ?? "local",
  platform: `${platform()} · ${arch()}`,
  status: "online",
  lastSeen: new Date().toISOString(),
  activeRuns: 0,
  concurrency,
  workspaceRoots: roots,
  harnesses: await Promise.all([
    inspectHarness("claude-cli", "claude", "local-subscription"),
    inspectHarness("codex-cli", "codex", "local-account")
  ]),
  version: "0.1.0"
};

const wsUrl = new URL("/worker", hub.replace(/^http/, "ws"));
wsUrl.searchParams.set("token", token);
let retryMs = 1_000;
let activeSocket: WebSocket | undefined;
const outbox: string[] = [];

function send(message: WorkerToHub) {
  const payload = JSON.stringify(message);
  if (activeSocket?.readyState === WebSocket.OPEN) activeSocket.send(payload);
  else outbox.push(payload);
}

function connect() {
  const socket = new WebSocket(wsUrl);
  socket.on("open", () => {
    activeSocket = socket;
    retryMs = 1_000;
    send({ type: "register", node: { ...node, activeRuns: running.size, lastSeen: new Date().toISOString() } });
    while (outbox.length && socket.readyState === WebSocket.OPEN) socket.send(outbox.shift()!);
    console.log(`Worker ${node.name} connected to ${hub}`);
  });
  socket.on("message", async (raw) => {
    const message = JSON.parse(raw.toString()) as HubToWorker;
    if (message.type === "ping") return send({ type: "heartbeat", nodeId, activeRuns: running.size, at: new Date().toISOString() });
    if (message.type === "cancel") {
      running.get(message.runId)?.process.kill("SIGTERM");
      return;
    }
    if (message.type !== "dispatch") return;
    if (running.has(message.run.id)) return;
    if (running.size >= concurrency) return send({ type: "run.failed", runId: message.run.id, error: `Worker concurrency limit (${concurrency}) reached`, at: new Date().toISOString() });
    try {
      const cwd = await assertWorkspaceAllowed(message.run.workspace, roots);
      send({ type: "run.started", runId: message.run.id, at: new Date().toISOString() });
      const task = startHarness(message.run, message.agent, cwd, { output: (chunk) => send({ type: "run.output", runId: message.run.id, chunk, at: new Date().toISOString() }) });
      running.set(message.run.id, task);
      const output = await task.result;
      send({ type: "run.completed", runId: message.run.id, output, at: new Date().toISOString() });
    } catch (error) {
      send({ type: "run.failed", runId: message.run.id, error: error instanceof Error ? error.message : String(error), at: new Date().toISOString() });
    } finally {
      running.delete(message.run.id);
    }
  });
  const heartbeat = setInterval(() => send({ type: "heartbeat", nodeId, activeRuns: running.size, at: new Date().toISOString() }), 10_000);
  socket.on("close", () => { if (activeSocket === socket) activeSocket = undefined; clearInterval(heartbeat); console.warn(`Hub disconnected; retrying in ${retryMs}ms`); setTimeout(connect, retryMs); retryMs = Math.min(retryMs * 2, 30_000); });
  socket.on("error", () => socket.close());
}

connect();
