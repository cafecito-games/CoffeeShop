import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { type Agent, type ComputeNode, type ControlAgentToHub, type HubToControlAgent, type Run } from "@coffee-shop/protocol";
import { createConfiguredAgent, markDisconnectedNodesOffline, openConnectionLookup, updateConfiguredAgent } from "./agentConfiguration.js";
import { applyRunLifecycle, cancelPersistedRun, queuedRunsForNode, retryAsync, serializeAsync } from "./lifecycle.js";
import { newEvent, newId, newMessage, Store } from "./store.js";

const app = express();
const server = createServer(app);
const controlAgents = new Map<string, WebSocket>();
const liveControlAgents = openConnectionLookup(controlAgents, WebSocket.OPEN);
const clients = new Set<WebSocket>();
const store = new Store();
const token = process.env.COFFEE_SHOP_TOKEN;
const port = Number(process.env.PORT ?? 8787);

if (process.env.NODE_ENV === "production" && !token) {
  throw new Error("COFFEE_SHOP_TOKEN is required in production");
}

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/") || req.path === "/api/health" || process.env.NODE_ENV !== "production") return next();
  const supplied = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? req.query.token;
  if (!token || supplied !== token) return res.status(401).json({ error: "Unauthorized" });
  next();
});

const broadcast = () => {
  const payload = JSON.stringify({ type: "snapshot", data: store.snapshot() });
  for (const socket of clients) if (socket.readyState === WebSocket.OPEN) socket.send(payload);
};

const sendToControlAgent = (nodeId: string, message: HubToControlAgent) => {
  const socket = controlAgents.get(nodeId);
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
};

async function queueRun(agent: Agent, prompt: string, options: { parentRunId?: string; depth?: number } = {}) {
  const run: Run = {
    id: newId("run"), agentId: agent.id, nodeId: agent.computeNodeId, harnessId: agent.harnessId,
    model: agent.model, workspace: agent.workspace, prompt, status: "queued", output: "",
    depth: options.depth ?? 0, parentRunId: options.parentRunId, createdAt: new Date().toISOString()
  };
  const controlAgent = controlAgents.get(agent.computeNodeId);
  const dispatched = Boolean(controlAgent && controlAgent.readyState === WebSocket.OPEN);
  if (dispatched) run.dispatchedAt = new Date().toISOString();
  await store.transact((state) => {
    state.runs.unshift(run);
    agent = state.agents.find((item) => item.id === agent.id)!;
    agent.state = dispatched ? "thinking" : "waiting";
    agent.currentAction = dispatched ? "Starting work" : "Waiting for compute";
    agent.updatedAt = new Date().toISOString();
    state.events.unshift(newEvent({ type: "run", title: `${agent.name} ${dispatched ? "received" : "queued"} a run`, detail: dispatched ? `Sent to ${agent.computeNodeId}` : `${agent.computeNodeId} is offline`, agentId: agent.id, runId: run.id }));
  });
  if (dispatched) {
    const directory = store.snapshot().agents.filter((item) => item.id !== agent.id).map((item) => `${item.id} (${item.title})`).join(", ");
    const dispatchAgent = { ...agent, systemPrompt: `${agent.systemPrompt}\n\nAvailable teammates: ${directory || "none"}` };
    sendToControlAgent(agent.computeNodeId, { type: "dispatch", run, agent: dispatchAgent });
  }
  broadcast();
  return run;
}

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "coffee-shop-control-plane", controlAgents: controlAgents.size }));
app.get("/api/snapshot", (_req, res) => res.json(store.snapshot()));

app.post("/api/agents", async (req, res) => {
  let result: ReturnType<typeof createConfiguredAgent> | undefined;
  await store.transact((state) => {
    result = createConfiguredAgent(state, req.body, new Date().toISOString(), liveControlAgents, (name) => {
      const baseId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
      return state.agents.some((agent) => agent.id === baseId) ? `${baseId}-${Math.random().toString(36).slice(2, 6)}` : baseId;
    });
    if (!result.ok) return false;
    state.events.unshift(newEvent({ type: "status", title: `${result.agent.name} joined the roster`, detail: `${result.agent.title} · ${result.node.name}`, agentId: result.agent.id }));
  });
  if (!result?.ok) return res.status(400).json({ error: result?.error ?? "Invalid agent configuration" });
  broadcast();
  res.status(201).json(result.agent);
});

app.post("/api/agents/:id/messages", async (req, res) => {
  const agent = store.getAgent(req.params.id);
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  if (!body) return res.status(400).json({ error: "Message is required" });
  await store.transact((state) => state.messages.push(newMessage({ agentId: agent.id, author: "you", body, kind: "message" })));
  const run = await queueRun(agent, body);
  res.status(202).json(run);
});

app.post("/api/handoffs", async (req, res) => {
  const from = store.getAgent(req.body?.fromAgentId);
  const to = store.getAgent(req.body?.toAgentId);
  const task = typeof req.body?.task === "string" ? req.body.task.trim() : "";
  if (!from || !to || !task) return res.status(400).json({ error: "Valid fromAgentId, toAgentId, and task are required" });
  await store.transact((state) => {
    state.events.unshift(newEvent({ type: "handoff", title: `${from.name} → ${to.name}`, detail: task, fromAgentId: from.id, toAgentId: to.id }));
    state.messages.push(newMessage({ agentId: to.id, author: "system", body: `Handoff from ${from.name}: ${task}`, kind: "handoff" }));
  });
  const run = await queueRun(to, `Handoff from ${from.name}: ${task}`, { depth: 1 });
  res.status(202).json(run);
});

app.patch("/api/agents/:id", async (req, res) => {
  let result: ReturnType<typeof updateConfiguredAgent> | undefined;
  await store.transact((state) => {
    result = updateConfiguredAgent(state, req.params.id, req.body, new Date().toISOString(), liveControlAgents);
    if (!result.ok || !result.changed) return false;
  });
  if (!result?.ok) return res.status(result?.kind === "not-found" ? 404 : 400).json({ error: result?.error ?? "Invalid agent configuration" });
  if (result.changed) broadcast();
  res.json(result.agent);
});

app.post("/api/runs/:id/cancel", async (req, res) => {
  const result = await cancelPersistedRun(store, req.params.id, sendToControlAgent);
  if (result.kind === "not-found") return res.status(404).json({ error: "Run not found" });
  if (result.kind === "conflict") return res.status(409).json({ error: `A ${result.run?.status} run cannot be cancelled` });
  if (result.kind === "cancelled") broadcast();
  res.json(result.run);
});

const webDist = resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get("/{*path}", (_req, res) => res.sendFile(resolve(webDist, "index.html")));
}

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  const isControlAgent = url.pathname === "/control-agent" || url.pathname === "/worker";
  const suppliedToken = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token");
  if (isControlAgent && token && suppliedToken !== token) return socket.destroy();
  if (url.pathname === "/events" && process.env.NODE_ENV === "production" && url.searchParams.get("token") !== token) return socket.destroy();
  if (!isControlAgent && url.pathname !== "/events") return socket.destroy();
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
});

wss.on("connection", (socket, request) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  if (url.pathname === "/events") {
    clients.add(socket);
    socket.send(JSON.stringify({ type: "snapshot", data: store.snapshot() }));
    socket.on("close", () => clients.delete(socket));
    return;
  }

  let nodeId = "";
  let protocolVersion: "1" | "2" = "1";
  const dispatchQueuedRuns = async (activeRunIds: readonly string[] = []) => {
    const queued = queuedRunsForNode(store.snapshot(), nodeId, activeRunIds, protocolVersion);
    for (const run of queued) {
      let dispatchRun: Run | undefined;
      await store.transact((state) => {
        const target = state.runs.find((item) => item.id === run.id && item.status === "queued");
        if (!target) return false;
        target.dispatchedAt = new Date().toISOString();
        const targetAgent = state.agents.find((item) => item.id === target.agentId);
        if (targetAgent) {
          targetAgent.state = "thinking";
          targetAgent.currentAction = "Starting work";
          targetAgent.updatedAt = target.dispatchedAt;
        }
        dispatchRun = target;
      });
      const agent = dispatchRun && store.getAgent(dispatchRun.agentId);
      if (agent && dispatchRun) sendToControlAgent(nodeId, { type: "dispatch", run: dispatchRun, agent });
    }
  };
  const handleMessage = serializeAsync(async (raw: RawData) => {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (typeof decoded !== "object" || decoded === null || !("type" in decoded) || typeof decoded.type !== "string") return;
    const message = decoded as ControlAgentToHub;
    if (message.type === "register") {
      if (message.protocolVersion && message.protocolVersion !== "1" && message.protocolVersion !== "2") return socket.close(1002, "unsupported control protocol");
      nodeId = message.node.id;
      protocolVersion = message.protocolVersion ?? "1";
      controlAgents.set(nodeId, socket);
      await store.transact((state) => {
        const index = state.nodes.findIndex((node) => node.id === nodeId);
        const online: ComputeNode = { ...message.node, status: "online", lastSeen: new Date().toISOString() };
        if (index >= 0) state.nodes[index] = online; else state.nodes.push(online);
        state.events.unshift(newEvent({ type: "node", title: `${online.name} connected`, detail: `${online.platform} · ${online.harnesses.filter((h) => h.available).map((h) => h.label).join(" + ")}` }));
      });
      broadcast();
    } else if (message.type === "sync.complete") {
      if (protocolVersion !== "2" || !nodeId || message.nodeId !== nodeId || typeof message.at !== "string" || (message.activeRunIds !== undefined && (!Array.isArray(message.activeRunIds) || !message.activeRunIds.every((id) => typeof id === "string")))) return;
      await dispatchQueuedRuns(message.activeRunIds ?? []);
    } else if (message.type === "heartbeat") {
      await store.transact((state) => { const node = state.nodes.find((item) => item.id === message.nodeId); if (node) { node.lastSeen = message.at; node.activeRuns = message.activeRuns; node.status = message.activeRuns ? "busy" : "online"; } });
      broadcast();
    } else if (message.type.startsWith("run.")) {
      const runId = message.runId;
      const current = store.getRun(runId);
      if (!current) return;
      let accepted = false;
      await retryAsync(async () => {
        accepted = false;
        await store.transact((state) => {
          accepted = applyRunLifecycle(state, message);
          return accepted;
        });
      });
      if (!accepted) return;
      if (message.type === "run.completed" && current.depth < 3) {
        const directive = message.output.match(/<handoff\s+to=["']([^"']+)["']>([\s\S]*?)<\/handoff>/i);
        const recipient = directive && store.getAgent(directive[1]);
        if (directive && recipient) {
          const sender = store.getAgent(current.agentId)!;
          const task = directive[2].trim();
          await store.transact((state) => {
            state.events.unshift(newEvent({ type: "handoff", title: `${sender.name} → ${recipient.name}`, detail: task, fromAgentId: sender.id, toAgentId: recipient.id, runId: current.id }));
            state.messages.push(newMessage({ agentId: recipient.id, author: "system", body: `Handoff from ${sender.name}: ${task}`, kind: "handoff", runId: current.id }));
          });
          await queueRun(recipient, `Handoff from ${sender.name}: ${task}`, { parentRunId: current.id, depth: current.depth + 1 });
        }
      }
      broadcast();
    }
  }, (error) => console.error("control-agent message failed", error));
  socket.on("message", (raw) => { void handleMessage(raw); });
  socket.on("close", async () => {
    if (!nodeId) return;
    if (controlAgents.get(nodeId) !== socket) return;
    controlAgents.delete(nodeId);
    await store.transact((state) => { const node = state.nodes.find((item) => item.id === nodeId); if (node) { node.status = "offline"; node.activeRuns = 0; } });
    broadcast();
  });
});

await store.load();
await store.transact((state) => markDisconnectedNodesOffline(state, liveControlAgents) || false);
server.listen(port, "0.0.0.0", () => console.log(`Coffee Shop hub listening on http://localhost:${port}`));
