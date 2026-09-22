import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  canSendToControlAgent,
  isControlProtocolVersion,
  supportsControlCapability,
  validateNodeCapabilityReport,
  validateOrchestrationControlAgentMessage,
  type Agent,
  type ComputeNode,
  type ControlAgentToHub,
  type ControlProtocolVersion,
  type HubToControlAgent,
  type Run
} from "@coffee-shop/protocol";
import { createConfiguredAgent, markDisconnectedNodesOffline, openConnectionLookup, updateConfiguredAgent } from "./agentConfiguration.js";
import { applyRunLifecycle, cancelPersistedRun, queuedRunsForNode, retryAsync, serializeAsync } from "./lifecycle.js";
import { CoordinationError, createArtifact, delegateTask, taskContext } from "./coordination.js";
import { recordNodeCapabilityReport } from "./nodeCapabilities.js";
import { loadProjectProfilesFromFile, ProjectProfileRegistry } from "./projectProfiles.js";
import { retainedHarnessEvents } from "./harnessEvents.js";
import { expireDueApprovals, receiveApprovalUndeliverable, receiveHarnessEvent, reconcileApprovals, resolveApproval } from "./harnessGateway.js";
import { createRedactor } from "./redaction.js";
import { newEvent, newId, newMessage, Store } from "./store.js";
import { newThread, updateThreadByOperator, updateThreadForRun } from "./threads.js";

const app = express();
const server = createServer(app);
const controlAgents = new Map<string, WebSocket>();
const controlAgentVersions = new WeakMap<WebSocket, ControlProtocolVersion>();
const liveControlAgents = openConnectionLookup(controlAgents, WebSocket.OPEN);
const clients = new Set<WebSocket>();
const store = new Store();
const token = process.env.COFFEE_SHOP_TOKEN;
const port = Number(process.env.PORT ?? 8787);
const redactor = createRedactor([token]);

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
  const version = controlAgentVersions.get(socket);
  if (!version || !canSendToControlAgent(message, version)) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
};

const dispatchRun = (run: Run, agent: Agent) => {
  const directory = store.snapshot().agents.filter((item) => item.id !== agent.id).map((item) => `${item.id} (${item.title})`).join(", ");
  const dispatchAgent = { ...agent, systemPrompt: `${agent.systemPrompt}\n\nAvailable teammates: ${directory || "none"}` };
  return sendToControlAgent(run.nodeId, { type: "dispatch", run, agent: dispatchAgent });
};

async function queueRun(agent: Agent, prompt: string, options: { threadId: string; parentRunId?: string; depth?: number }) {
  const run: Run = {
    id: newId("run"), threadId: options.threadId, agentId: agent.id, nodeId: agent.computeNodeId, harnessId: agent.harnessId,
    model: agent.model, workspace: agent.workspace, prompt, status: "queued", output: "",
    depth: options.depth ?? 0, parentRunId: options.parentRunId, createdAt: new Date().toISOString()
  };
  const controlAgent = controlAgents.get(agent.computeNodeId);
  const dispatched = Boolean(controlAgent && controlAgent.readyState === WebSocket.OPEN);
  if (dispatched) run.dispatchedAt = new Date().toISOString();
  await store.transact((state) => {
    const thread = state.threads?.find((item) => item.id === options.threadId);
    if (!thread) throw new CoordinationError("not_found", "Thread not found");
    if (thread.status !== "active") throw new CoordinationError("thread_inactive", "New work requires an active thread");
    state.runs.unshift(run);
    agent = state.agents.find((item) => item.id === agent.id)!;
    agent.state = dispatched ? "thinking" : "waiting";
    agent.currentAction = dispatched ? "Starting work" : "Waiting for compute";
    agent.updatedAt = new Date().toISOString();
    thread.updatedAt = run.createdAt;
    state.events.unshift(newEvent({ type: "run", title: `${agent.name} ${dispatched ? "received" : "queued"} a run`, detail: dispatched ? `Sent to ${agent.computeNodeId}` : `${agent.computeNodeId} is offline`, threadId: thread.id, agentId: agent.id, runId: run.id }));
  });
  if (dispatched) dispatchRun(run, agent);
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
  const requestedThreadId = typeof req.body?.threadId === "string" ? req.body.threadId.trim() : "";
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  if (!body) return res.status(400).json({ error: "Message is required" });
  try {
    let threadId = "";
    await store.transact((state) => {
      let thread = requestedThreadId ? state.threads?.find((item) => item.id === requestedThreadId) : undefined;
      if (requestedThreadId && !thread) throw new CoordinationError("not_found", "Thread not found");
      if (thread && thread.ownerAgentId !== agent.id) throw new CoordinationError("forbidden", "Continue this thread with its owner agent");
      if (thread?.status === "archived") throw new CoordinationError("thread_archived", "Archived threads are read-only");
      if (!thread) {
        thread = newThread(agent.id, body, "user");
        state.threads ??= [];
        state.threads.unshift(thread);
        state.events.unshift(newEvent({ type: "status", title: "Thread started", detail: thread.title, threadId: thread.id, agentId: agent.id }));
      } else if (thread.status === "completed") {
        thread.status = "active";
        thread.completedAt = undefined;
        thread.updatedAt = new Date().toISOString();
        state.events.unshift(newEvent({ type: "status", title: "Thread reopened", detail: thread.title, threadId: thread.id, agentId: agent.id }));
      }
      threadId = thread.id;
      state.messages.push(newMessage({ agentId: agent.id, author: "you", body, kind: "message", threadId }));
    });
    const run = await queueRun(agent, body, { threadId });
    res.status(202).json(run);
  } catch (error) {
    const failure = error instanceof CoordinationError ? error : new CoordinationError("internal_error", "The thread could not accept the message", true);
    res.status(failure.code === "not_found" ? 404 : failure.code === "thread_archived" ? 409 : 400).json({ error: failure.message });
  }
});

app.post("/api/handoffs", async (req, res) => {
  const from = store.getAgent(req.body?.fromAgentId);
  const to = store.getAgent(req.body?.toAgentId);
  const task = typeof req.body?.task === "string" ? req.body.task.trim() : "";
  if (!from || !to || !task) return res.status(400).json({ error: "Valid fromAgentId, toAgentId, and task are required" });
  const thread = newThread(to.id, task, "user");
  await store.transact((state) => {
    state.threads ??= [];
    state.threads.unshift(thread);
    state.events.unshift(newEvent({ type: "handoff", title: `${from.name} → ${to.name}`, detail: task, threadId: thread.id, fromAgentId: from.id, toAgentId: to.id }));
    state.messages.push(newMessage({ agentId: to.id, author: "system", body: `Handoff from ${from.name}: ${task}`, kind: "handoff", threadId: thread.id }));
  });
  const run = await queueRun(to, `Handoff from ${from.name}: ${task}`, { threadId: thread.id, depth: 1 });
  res.status(202).json(run);
});

app.patch("/api/threads/:id", async (req, res) => {
  try {
    const thread = await updateThreadByOperator(store, req.params.id, req.body);
    broadcast();
    res.json(thread);
  } catch (error) {
    const failure = error instanceof CoordinationError ? error : new CoordinationError("internal_error", "The thread could not be updated", true);
    res.status(failure.code === "not_found" ? 404 : failure.code === "thread_in_use" ? 409 : 400).json({ error: failure.message });
  }
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

app.get("/api/approvals", (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const runId = typeof req.query.runId === "string" ? req.query.runId : undefined;
  const threadId = typeof req.query.threadId === "string" ? req.query.threadId : undefined;
  const approvals = (store.snapshot().approvals ?? []).filter((approval) =>
    (!status || approval.status === status) && (!runId || approval.runId === runId) && (!threadId || approval.threadId === threadId));
  res.json({ approvals });
});

app.get("/api/approvals/:id", (req, res) => {
  const approval = store.snapshot().approvals?.find((item) => item.id === req.params.id);
  if (!approval) return res.status(404).json({ error: "Approval not found" });
  res.json({ approval });
});

app.post("/api/approvals/:id/resolution", async (req, res) => {
  try {
    const response = await resolveApproval(store, req.params.id, req.body, sendToControlAgent);
    if (response.changed) broadcast();
    res.status(response.status).json(response.body);
  } catch (error) {
    console.error("approval resolution failed", error);
    if (!res.headersSent) res.status(500).json({ error: "The approval resolution failed" });
  }
});

app.get("/api/runs/:id/events", (req, res) => {
  if (!store.getRun(req.params.id)) return res.status(404).json({ error: "Run not found" });
  const after = Number(req.query.after ?? 0);
  if (!Number.isSafeInteger(after) || after < 0) return res.status(400).json({ error: "after must be a non-negative integer" });
  const events = store.read((state) => structuredClone(retainedHarnessEvents(state, req.params.id, after)));
  res.json({ events: events.map((record) => record.event), activity: store.snapshot().runActivity?.find((item) => item.runId === req.params.id) });
});

app.put("/api/artifacts/:id/content", express.raw({ type: "application/octet-stream", limit: "10mb" }), async (req, res) => {
  const artifact = store.snapshot().artifacts?.find((item) => item.id === req.params.id);
  if (!artifact) return res.status(404).json({ error: "Artifact not found" });
  if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: "Artifact content must be application/octet-stream" });
  if (req.body.length !== artifact.size || createHash("sha256").update(req.body).digest("hex") !== artifact.sha256) {
    return res.status(422).json({ error: "Artifact content does not match its registered size and digest" });
  }
  await store.writeArtifactContent(artifact.id, req.body);
  await store.transact((state) => {
    const current = state.artifacts?.find((item) => item.id === artifact.id);
    if (!current || current.uploaded) return false;
    current.uploaded = true;
  });
  broadcast();
  res.status(204).end();
});

app.get("/api/artifacts/:id/content", async (req, res) => {
  const artifact = store.snapshot().artifacts?.find((item) => item.id === req.params.id && item.uploaded);
  if (!artifact) return res.status(404).json({ error: "Artifact not found" });
  try {
    res.type(artifact.mediaType).send(await store.readArtifactContent(artifact.id));
  } catch {
    res.status(404).json({ error: "Artifact content not found" });
  }
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
  let protocolVersion: ControlProtocolVersion = "1";
  const dispatchQueuedRuns = async (activeRunIds: readonly string[] = []) => {
    const queued = queuedRunsForNode(store.snapshot(), nodeId, activeRunIds, protocolVersion);
    for (const run of queued) {
      let pendingRun: Run | undefined;
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
        pendingRun = target;
      });
      const agent = pendingRun && store.getAgent(pendingRun.agentId);
      if (agent && pendingRun) dispatchRun(pendingRun, agent);
    }
  };
  const respondToRpc = (requestId: string, runId: string, result?: unknown, error?: { code: string; message: string; retryable: boolean }) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ type: "hub.rpc.response", requestId, runId, result, error } satisfies HubToControlAgent));
    } catch {
      // The Barista will fail the pending MCP call when this socket closes.
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
      if (message.protocolVersion !== undefined && !isControlProtocolVersion(message.protocolVersion)) return socket.close(1002, "unsupported control protocol");
      nodeId = message.node.id;
      protocolVersion = message.protocolVersion ?? "1";
      controlAgentVersions.set(socket, protocolVersion);
      controlAgents.set(nodeId, socket);
      await store.transact((state) => {
        const index = state.nodes.findIndex((node) => node.id === nodeId);
        const online: ComputeNode = { ...message.node, status: "online", lastSeen: new Date().toISOString() };
        if (index >= 0) state.nodes[index] = online; else state.nodes.push(online);
        state.events.unshift(newEvent({ type: "node", title: `${online.name} connected`, detail: `${online.platform} · ${online.harnesses.filter((h) => h.available).map((h) => h.label).join(" + ")}` }));
      });
      broadcast();
    } else if (message.type === "sync.complete") {
      if (!supportsControlCapability(protocolVersion, "replay-barrier") || !nodeId || message.nodeId !== nodeId || typeof message.at !== "string" || (message.activeRunIds !== undefined && (!Array.isArray(message.activeRunIds) || !message.activeRunIds.every((id) => typeof id === "string")))) return;
      await dispatchQueuedRuns(message.activeRunIds ?? []);
      if (supportsControlCapability(protocolVersion, "orchestration") && message.activeRunIds !== undefined
        && await reconcileApprovals(store, nodeId, message.activeRunIds, sendToControlAgent)) broadcast();
    } else if (message.type === "heartbeat") {
      await store.transact((state) => { const node = state.nodes.find((item) => item.id === message.nodeId); if (node) { node.lastSeen = message.at; node.activeRuns = message.activeRuns; node.status = message.activeRuns ? "busy" : "online"; } });
      broadcast();
    } else if (message.type === "hub.rpc.request") {
      if (!supportsControlCapability(protocolVersion, "hub-rpc") || !nodeId || typeof message.requestId !== "string" || typeof message.runId !== "string") return;
      const source = store.getRun(message.runId);
      if (!source || source.nodeId !== nodeId || source.status !== "running") {
        respondToRpc(message.requestId, message.runId, undefined, { code: "run_not_active", message: "The calling run is not active on this node", retryable: false });
        return;
      }
      try {
        if (message.operation === "get_task_context") {
          respondToRpc(message.requestId, message.runId, taskContext(store.snapshot(), message.runId, message.arguments));
        } else if (message.operation === "delegate_task") {
          const delegated = await delegateTask(store, message.runId, message.arguments, (id) => liveControlAgents.has(id));
          if (delegated.created && delegated.dispatched) dispatchRun(delegated.run, delegated.agent);
          respondToRpc(message.requestId, message.runId, {
            taskId: delegated.run.id,
            status: delegated.run.status,
            agentId: delegated.run.agentId,
            created: delegated.created
          });
          if (delegated.created) broadcast();
        } else if (message.operation === "post_artifact") {
          const result = await createArtifact(store, message.runId, message.arguments);
          respondToRpc(message.requestId, message.runId, result);
          broadcast();
        } else if (message.operation === "update_thread") {
          const thread = await updateThreadForRun(store, message.runId, message.arguments);
          respondToRpc(message.requestId, message.runId, { thread });
          broadcast();
        } else {
          throw new CoordinationError("unknown_tool", "The requested hub tool is not supported");
        }
      } catch (error) {
        const failure = error instanceof CoordinationError ? error : new CoordinationError("internal_error", "The hub could not complete the tool call", true);
        respondToRpc(message.requestId, message.runId, undefined, { code: failure.code, message: failure.message, retryable: failure.retryable });
      }
    } else if (message.type === "harness.event" || message.type === "session.binding" || message.type === "workspace.lease" || message.type === "approval.undeliverable") {
      const validated = validateOrchestrationControlAgentMessage(decoded, protocolVersion);
      if (!validated.ok) {
        console.warn(redactor.redact(`rejected ${message.type} from ${nodeId || "an unregistered Barista"}: ${validated.reason}`));
        return;
      }
      if (!nodeId || controlAgents.get(nodeId) !== socket) return;
      const orchestration = validated.value;
      if (orchestration.type === "harness.event") {
        const outcome = await receiveHarnessEvent(store, nodeId, orchestration.event, redactor, sendToControlAgent);
        if (outcome.kind === "rejected") console.warn(redactor.redact(`rejected harness.event from ${nodeId}: ${outcome.reason}`));
        if (outcome.kind === "accepted" || outcome.kind === "stream-failed") broadcast();
      } else if (orchestration.type === "approval.undeliverable") {
        if (await receiveApprovalUndeliverable(store, nodeId, orchestration.runId, orchestration.approvalId, orchestration.reason, redactor, orchestration.at)) broadcast();
      }
      // Session bindings and workspace leases are not persisted yet, so they never change hub state.
    } else if (message.type === "capability.report") {
      if (!supportsControlCapability(protocolVersion, "orchestration") || !nodeId) return;
      const validated = validateNodeCapabilityReport(message.report);
      if (!validated.ok || validated.value.nodeId !== nodeId) return;
      recordNodeCapabilityReport(validated.value);
      return;
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
            state.events.unshift(newEvent({ type: "handoff", title: `${sender.name} → ${recipient.name}`, detail: task, threadId: current.threadId, fromAgentId: sender.id, toAgentId: recipient.id, runId: current.id }));
            state.messages.push(newMessage({ agentId: recipient.id, author: "system", body: `Handoff from ${sender.name}: ${task}`, kind: "handoff", threadId: current.threadId, runId: current.id }));
          });
          if (current.threadId) await queueRun(recipient, `Handoff from ${sender.name}: ${task}`, { threadId: current.threadId, parentRunId: current.id, depth: current.depth + 1 });
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

const defaultProjectProfilesPath = fileURLToPath(new URL("../../../config/project-profiles.json", import.meta.url));
const projectProfilesPath = process.env.PROJECT_PROFILES_PATH ?? defaultProjectProfilesPath;
const projectProfilesResult = await loadProjectProfilesFromFile(projectProfilesPath);
if (!projectProfilesResult.ok) {
  if (projectProfilesResult.kind === "not-found" && !process.env.PROJECT_PROFILES_PATH) {
    console.log("no project profiles configured; set PROJECT_PROFILES_PATH to enable project readiness");
  } else {
    throw new Error(`project profiles failed to load: ${projectProfilesResult.error}`);
  }
}
const projectProfiles = new ProjectProfileRegistry(projectProfilesResult.ok ? projectProfilesResult.profiles : []);
if (projectProfilesResult.ok) console.log(`loaded ${projectProfilesResult.profiles.length} project profile(s) from ${projectProfilesPath}`);

await store.load();
await store.transact((state) => markDisconnectedNodesOffline(state, liveControlAgents) || false);
setInterval(() => {
  void expireDueApprovals(store, sendToControlAgent)
    .then((changed) => { if (changed) broadcast(); })
    .catch((error) => console.error("approval expiry failed", error));
}, 15_000).unref();
server.listen(port, "0.0.0.0", () => console.log(`Coffee Shop hub listening on http://localhost:${port}`));
