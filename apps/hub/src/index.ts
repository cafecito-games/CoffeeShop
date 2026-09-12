import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { agentAvatarColors, agentAvatarShapes, type Agent, type ComputeNode, type ControlAgentToHub, type HubToControlAgent, type Run } from "@coffee-shop/protocol";
import { newEvent, newId, newMessage, Store } from "./store.js";

const app = express();
const server = createServer(app);
const controlAgents = new Map<string, WebSocket>();
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
  socket.send(JSON.stringify(message));
  return true;
};

async function queueRun(agent: Agent, prompt: string, options: { parentRunId?: string; depth?: number } = {}) {
  const run: Run = {
    id: newId("run"), agentId: agent.id, nodeId: agent.computeNodeId, harnessId: agent.harnessId,
    model: agent.model, workspace: agent.workspace, prompt, status: "queued", output: "",
    depth: options.depth ?? 0, parentRunId: options.parentRunId, createdAt: new Date().toISOString()
  };
  const controlAgent = controlAgents.get(agent.computeNodeId);
  const dispatched = Boolean(controlAgent && controlAgent.readyState === WebSocket.OPEN);
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
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const node = store.snapshot().nodes.find((item) => item.id === req.body?.computeNodeId);
  const harnessId = req.body?.harnessId === "codex-cli" ? "codex-cli" : "claude-cli";
  const avatarShape = agentAvatarShapes.find((shape) => shape === req.body?.avatarShape) ?? "cup";
  const avatarColor = agentAvatarColors.find((color) => color === req.body?.avatarColor) ?? "amber";
  if (!name || !title || !node) return res.status(400).json({ error: "Name, title, and a valid compute node are required" });
  const baseId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
  const id = store.getAgent(baseId) ? `${baseId}-${Math.random().toString(36).slice(2, 6)}` : baseId;
  const agent: Agent = {
    id, name, title, summary: req.body?.summary?.trim() || `Purpose-built for ${title.toLowerCase()}.`, glyph: name[0].toUpperCase(), avatarShape, avatarColor,
    state: "idle", currentAction: "Available", harnessId, model: harnessId === "claude-cli" ? "sonnet" : "default",
    computeNodeId: node.id, workspace: req.body?.workspace?.trim() || node.workspaceRoots[0] || "/workspace",
    systemPrompt: req.body?.systemPrompt?.trim() || `You are ${name}, a ${title}. Work carefully, report evidence, and leave durable results.`,
    unread: 0, updatedAt: new Date().toISOString()
  };
  await store.transact((state) => {
    state.agents.push(agent);
    state.events.unshift(newEvent({ type: "status", title: `${agent.name} joined the roster`, detail: `${agent.title} · ${node.name}`, agentId: agent.id }));
  });
  broadcast();
  res.status(201).json(agent);
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
  const allowed = ["name", "title", "summary", "harnessId", "model", "computeNodeId", "workspace", "systemPrompt", "avatarShape", "avatarColor"] as const;
  let updated: Agent | undefined;
  await store.transact((state) => {
    updated = state.agents.find((agent) => agent.id === req.params.id);
    if (!updated) return;
    for (const key of allowed) {
      if (typeof req.body?.[key] !== "string") continue;
      if (key === "avatarShape" && !agentAvatarShapes.some((value) => value === req.body[key])) continue;
      if (key === "avatarColor" && !agentAvatarColors.some((value) => value === req.body[key])) continue;
      (updated as unknown as Record<string, string>)[key] = req.body[key];
    }
    updated.updatedAt = new Date().toISOString();
  });
  if (!updated) return res.status(404).json({ error: "Agent not found" });
  broadcast();
  res.json(updated);
});

app.post("/api/runs/:id/cancel", async (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "Run not found" });
  sendToControlAgent(run.nodeId, { type: "cancel", runId: run.id });
  await store.transact((state) => { const target = state.runs.find((item) => item.id === run.id); if (target) target.status = "cancelled"; });
  broadcast();
  res.status(202).json({ ok: true });
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
  socket.on("message", async (raw) => {
    const message = JSON.parse(raw.toString()) as ControlAgentToHub;
    if (message.type === "register") {
      if (message.protocolVersion && message.protocolVersion !== "1") return socket.close(1002, "unsupported control protocol");
      nodeId = message.node.id;
      controlAgents.set(nodeId, socket);
      await store.transact((state) => {
        const index = state.nodes.findIndex((node) => node.id === nodeId);
        const online: ComputeNode = { ...message.node, status: "online", lastSeen: new Date().toISOString() };
        if (index >= 0) state.nodes[index] = online; else state.nodes.push(online);
        state.events.unshift(newEvent({ type: "node", title: `${online.name} connected`, detail: `${online.platform} · ${online.harnesses.filter((h) => h.available).map((h) => h.label).join(" + ")}` }));
      });
      const queued = store.snapshot().runs.filter((run) => run.nodeId === nodeId && run.status === "queued");
      for (const run of queued) {
        const agent = store.getAgent(run.agentId);
        if (agent) sendToControlAgent(nodeId, { type: "dispatch", run, agent });
      }
      broadcast();
    } else if (message.type === "heartbeat") {
      await store.transact((state) => { const node = state.nodes.find((item) => item.id === message.nodeId); if (node) { node.lastSeen = message.at; node.activeRuns = message.activeRuns; node.status = message.activeRuns ? "busy" : "online"; } });
      broadcast();
    } else if (message.type.startsWith("run.")) {
      const runId = message.runId;
      const current = store.getRun(runId);
      if (!current) return;
      await store.transact((state) => {
        const run = state.runs.find((item) => item.id === runId)!;
        const agent = state.agents.find((item) => item.id === run.agentId)!;
        if (message.type === "run.started") { run.status = "running"; run.startedAt = message.at; agent.state = "working"; agent.currentAction = "Working"; }
        if (message.type === "run.output") { run.output += message.chunk; agent.currentAction = message.chunk.trim().slice(-90) || "Working"; }
        if (message.type === "run.completed") {
          run.status = "completed"; run.output = message.output; run.finishedAt = message.at; agent.state = "done"; agent.currentAction = "Completed just now";
          state.messages.push(newMessage({ agentId: agent.id, author: "agent", body: message.output || "Completed.", kind: "message", runId }));
          state.events.unshift(newEvent({ type: "status", title: `${agent.name} finished`, detail: run.prompt.slice(0, 120), agentId: agent.id, runId }));
        }
        if (message.type === "run.failed") {
          run.status = "failed"; run.error = message.error; run.finishedAt = message.at; agent.state = "blocked"; agent.currentAction = message.error.slice(0, 90);
          state.messages.push(newMessage({ agentId: agent.id, author: "system", body: `Run failed: ${message.error}`, kind: "status", runId }));
        }
        agent.updatedAt = message.at;
      });
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
  });
  socket.on("close", async () => {
    if (!nodeId) return;
    if (controlAgents.get(nodeId) !== socket) return;
    controlAgents.delete(nodeId);
    await store.transact((state) => { const node = state.nodes.find((item) => item.id === nodeId); if (node) { node.status = "offline"; node.activeRuns = 0; } });
    broadcast();
  });
});

await store.load();
server.listen(port, "0.0.0.0", () => console.log(`Coffee Shop hub listening on http://localhost:${port}`));
