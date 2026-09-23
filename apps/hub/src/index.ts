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
  isTerminalTaskStatus,
  isTerminalWorkspaceLeaseStatus,
  orchestratorClientHeartbeatSeconds,
  supportsControlCapability,
  threadOrchestrator,
  validateProjectProfile,
  validateNodeCapabilityReport,
  validateOrchestrationControlAgentMessage,
  type Agent,
  type ComputeNode,
  type ControlAgentToHub,
  type ControlProtocolVersion,
  type HubToControlAgent,
  type Run
} from "@coffee-shop/protocol";
import { createConfiguredAgent, markDisconnectedNodesOffline, updateConfiguredAgent } from "./agentConfiguration.js";
import { ControlConnectionRegistry, type ControlConnection } from "./controlConnections.js";
import { applyRunLifecycle, cancelPersistedRun, coalesceAsync, failLostTaskAttempts, isReportedByOwningNode, queuedRunsForNode, retryAsync, serializeAsync } from "./lifecycle.js";
import { CoordinationError } from "./coordination.js";
import { detachEveryAttachmentInState, postOperatorMessageInState, type OperatorMessage } from "./externalOrchestrators.js";
import { createHubToolHandler, hubToolError } from "./hubTools.js";
import { TaskEventWaiters } from "./mailbox.js";
import { forgetNodeCapabilityReport, getNodeCapabilityReport, recordNodeCapabilityReport } from "./nodeCapabilities.js";
import { registeredComputeNode } from "./nodeRegistration.js";
import { createOrchestratorClientRevocations, operatorCredentialGuard, registerOrchestratorClientRoutes } from "./orchestratorClients.js";
import { createOrchestratorClientGateway, orchestratorClientCloseCode } from "./orchestratorClientGateway.js";
import { loadProjectProfilesFromFile } from "./projectProfiles.js";
import { computeNodeProjectReadiness } from "./projectReadiness.js";
import { retainedHarnessEvents } from "./harnessEvents.js";
import { expireDueApprovals, receiveApprovalUndeliverable, receiveHarnessEvent, reconcileApprovals, resolveApproval } from "./harnessGateway.js";
import { createRedactor } from "./redaction.js";
import { dispatchMessageFor, runSchedulingPass, type SchedulingContext, type SchedulingPassResult } from "./scheduler.js";
import { runContinuationPass, type ContinuationPassResult } from "./orchestratorInbox.js";
import { receiveSessionBinding } from "./sessionBindings.js";
import { newEvent, newId, newMessage, Store } from "./store.js";
import { newThread, updateThreadByOperator, updateThreadForRun } from "./threads.js";
import { cleanupWorkspaceLeaseByOperator, receiveWorkspaceLeaseUpdate, reconcileWorkspaceLeases, workspaceLeaseConfirmation } from "./workspaceLeases.js";

const app = express();
const server = createServer(app);
const controlAgents = new ControlConnectionRegistry<WebSocket>(WebSocket.OPEN);
const controlKeepaliveMilliseconds = 15_000;
const liveControlAgents = { has: (nodeId: string) => controlAgents.has(nodeId) };
const clients = new Set<WebSocket>();
const store = new Store();
const token = process.env.COFFEE_SHOP_TOKEN;
const port = Number(process.env.PORT ?? 8787);
const redactor = createRedactor([token]);
const orchestratorClientRevocations = createOrchestratorClientRevocations();

if (process.env.NODE_ENV === "production" && !token) {
  throw new Error("COFFEE_SHOP_TOKEN is required in production");
}

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(operatorCredentialGuard(token));

const broadcast = () => {
  const payload = JSON.stringify({ type: "snapshot", data: store.snapshot() });
  for (const socket of clients) if (socket.readyState === WebSocket.OPEN) socket.send(payload);
};

const taskEventWaiters = new TaskEventWaiters(store);
const orchestratorClients = createOrchestratorClientGateway({
  store,
  broadcast,
  waiters: taskEventWaiters,
  inventory: () => ({ connection: schedulingConnection, capabilityReport: getNodeCapabilityReport }),
  schedule: () => scheduleReadyTasks(),
  sendToControlAgent: (nodeId, message) => sendToControlAgent(nodeId, message)
});
orchestratorClientRevocations.onOrchestratorClientRevoked((clientId) => {
  void orchestratorClients.revokeClient(clientId).catch((error) => console.error("orchestrator client revocation could not be applied to live sockets", error));
});

const sendToControlAgent = (nodeId: string, message: HubToControlAgent) => controlAgents.send(nodeId, message);
/** Lease cleanup requests wait for the reconnect barrier so Barista's replayed reports land first. */
const sendAfterBarrier = (nodeId: string, message: HubToControlAgent) => {
  const connection = controlAgents.current(nodeId);
  return connection !== undefined && controlAgents.barrierPassed(connection) && controlAgents.send(nodeId, message);
};

type DispatchMessage = Extract<HubToControlAgent, { type: "dispatch" }>;
/** The connection a dispatch may be approved against now: current, past its barrier, and version-compatible. */
const deliveryConnection = (nodeId: string, message: DispatchMessage) => controlAgents.deliveryConnection(nodeId, message);

/**
 * Sends a queued run on the exact connection its delivery decision was approved against. When that
 * connection was replaced, closed, or refuses the send, the decision is withdrawn so the run is
 * never left marked dispatched; the new connection's reconnect barrier then dispatches it exactly
 * once, and no second attempt is created.
 */
const deliverRun = async (runId: string, connection: ControlConnection<WebSocket>) => {
  const message = store.read((state) => {
    const run = state.runs.find((item) => item.id === runId && item.status === "queued" && item.dispatchedAt !== undefined);
    const agent = run && state.agents.find((item) => item.id === run.agentId);
    return run && agent ? structuredClone(dispatchMessageFor(run, agent, state.agents, state.workspaceLeases, state)) : undefined;
  });
  if (!message || controlAgents.deliver(connection, message)) return;
  await store.transact((state) => {
    const run = state.runs.find((item) => item.id === runId);
    if (!run || run.status !== "queued" || run.dispatchedAt !== message.run.dispatchedAt) return false;
    delete run.dispatchedAt;
    const agent = state.agents.find((item) => item.id === run.agentId);
    if (agent?.state === "thinking") {
      agent.state = "waiting";
      agent.currentAction = "Waiting for compute";
      agent.updatedAt = new Date().toISOString();
    }
  });
};

const schedulingConnection = (nodeId: string) => {
  const connection = controlAgents.current(nodeId);
  return connection && { protocolVersion: connection.protocolVersion, synced: controlAgents.barrierPassed(connection) };
};

/**
 * Re-evaluates every ready task. Triggered by registration, reconnect barriers, capability
 * reports, heartbeats that change capacity, run lifecycle changes, and operator changes; bursts
 * collapse into one pass and passes never overlap.
 */
const scheduleReadyTasks = coalesceAsync(async () => {
  let result: SchedulingPassResult = { changed: false, attempts: [] };
  let continuations: ContinuationPassResult = { changed: false, continuations: [] };
  let approved = new Map<string, ControlConnection<WebSocket>>();
  await store.transact((state) => {
    approved = new Map();
    const context: SchedulingContext = {
      connection: schedulingConnection,
      capabilityReport: getNodeCapabilityReport,
      projectProfile: (projectId) => state.projectProfiles?.find((profile) => profile.id === projectId),
      canDeliver: (nodeId, message) => {
        const connection = message.type === "dispatch" ? deliveryConnection(nodeId, message) : undefined;
        if (connection && message.type === "dispatch") approved.set(message.run.id, connection);
        return connection !== undefined;
      }
    };
    const at = new Date().toISOString();
    result = runSchedulingPass(state, context, at);
    continuations = runContinuationPass(state, context, at);
    return result.changed || continuations.changed;
  });
  for (const attempt of [...result.attempts, ...continuations.continuations]) {
    const connection = approved.get(attempt.runId);
    if (attempt.delivered && connection) await deliverRun(attempt.runId, connection);
  }
  if (result.changed || continuations.changed) broadcast();
}, (error) => console.error("task scheduling failed", error));
const requestScheduling = () => { void scheduleReadyTasks(); };

const handleHubTool = createHubToolHandler({
  store,
  waiters: taskEventWaiters,
  inventory: () => ({ connection: schedulingConnection, capabilityReport: getNodeCapabilityReport }),
  schedule: () => scheduleReadyTasks(),
  broadcast
});

async function queueRun(agent: Agent, prompt: string, options: { threadId: string; parentRunId?: string; depth?: number }) {
  const run: Run = {
    id: newId("run"), threadId: options.threadId, agentId: agent.id, nodeId: agent.computeNodeId, harnessId: agent.harnessId,
    model: agent.model, workspace: agent.workspace, prompt, status: "queued", output: "",
    depth: options.depth ?? 0, parentRunId: options.parentRunId, createdAt: new Date().toISOString()
  };
  let connection: ControlConnection<WebSocket> | undefined;
  await store.transact((state) => {
    const thread = state.threads?.find((item) => item.id === options.threadId);
    if (!thread) throw new CoordinationError("not_found", "Thread not found");
    if (thread.status !== "active") throw new CoordinationError("thread_inactive", "New work requires an active thread");
    agent = state.agents.find((item) => item.id === agent.id)!;
    connection = deliveryConnection(run.nodeId, dispatchMessageFor(run, agent, state.agents, state.workspaceLeases));
    const dispatched = connection !== undefined;
    if (dispatched) run.dispatchedAt = new Date().toISOString();
    state.runs.unshift(run);
    agent.state = dispatched ? "thinking" : "waiting";
    agent.currentAction = dispatched ? "Starting work" : "Waiting for compute";
    agent.updatedAt = new Date().toISOString();
    thread.updatedAt = run.createdAt;
    state.events.unshift(newEvent({ type: "run", title: `${agent.name} ${dispatched ? "received" : "queued"} a run`, detail: dispatched ? `Sent to ${agent.computeNodeId}` : `${agent.computeNodeId} is offline`, threadId: thread.id, agentId: agent.id, runId: run.id }));
  });
  if (connection) await deliverRun(run.id, connection);
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
  requestScheduling();
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
      if (thread && threadOrchestrator(thread)?.kind === "external") {
        throw new CoordinationError("forbidden", "An externally orchestrated thread takes messages at /api/threads/:id/messages");
      }
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

/*
 * An externally orchestrated thread has no owner agent, so an operator's message cannot start a
 * run. It is appended to the thread orchestrator's mailbox instead, which makes it one more
 * unacknowledged journal entry, and the doorbell policy rings the attached session about it.
 */
app.post("/api/threads/:id/messages", async (req, res) => {
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  const requestedKey = typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey.trim() : "";
  if (!body) return res.status(400).json({ error: "Message is required" });
  try {
    let posted: OperatorMessage | undefined;
    await store.transact((state) => {
      posted = postOperatorMessageInState(state, { threadId: req.params.id, body, ...(requestedKey ? { idempotencyKey: requestedKey } : {}) }, new Date().toISOString());
      return posted.created;
    });
    const message = posted!.message;
    if (posted!.created) broadcast();
    res.status(202).json({
      created: posted!.created,
      threadId: message.threadId,
      messageId: message.id,
      sequence: message.sequence,
      createdAt: message.createdAt
    });
  } catch (error) {
    const failure = error instanceof CoordinationError ? error : new CoordinationError("internal_error", "The thread could not accept the message", true);
    const status = failure.code === "not_found" ? 404
      : failure.code === "idempotency_conflict" || failure.code === "thread_inactive" || failure.code === "mailbox_full" ? 409
        : 400;
    res.status(status).json({ error: failure.message });
  }
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
  if (result.changed) {
    broadcast();
    requestScheduling();
  }
  res.json(result.agent);
});

app.post("/api/runs/:id/cancel", async (req, res) => {
  const result = await cancelPersistedRun(store, req.params.id, sendToControlAgent);
  if (result.kind === "not-found") return res.status(404).json({ error: "Run not found" });
  if (result.kind === "conflict") return res.status(409).json({ error: `A ${result.run?.status} run cannot be cancelled` });
  if (result.kind === "cancelled") {
    broadcast();
    requestScheduling();
    reconcileWorkspaceLeases(store, result.run!.nodeId, [], sendAfterBarrier);
  }
  res.json(result.run);
});

app.get("/api/workspace-leases", (req, res) => {
  const filters = ["status", "nodeId", "runId", "taskId"] as const;
  const query = Object.fromEntries(filters.map((key) => [key, typeof req.query[key] === "string" ? req.query[key] : undefined]));
  const leases = (store.snapshot().workspaceLeases ?? []).filter((lease) => filters.every((key) => query[key] === undefined || lease[key] === query[key]));
  res.json({ leases });
});

app.post("/api/workspace-leases/:id/cleanup", async (req, res) => {
  try {
    const result = await cleanupWorkspaceLeaseByOperator(store, req.params.id, sendAfterBarrier);
    if (result.kind === "not-found") return res.status(404).json({ error: "Workspace lease not found" });
    if (result.kind === "conflict") return res.status(409).json({ error: result.reason });
    broadcast();
    if (!result.sent) return res.status(503).json({ error: "The lease's compute node is not connected; retry once it reconnects", lease: result.lease });
    res.status(202).json({ lease: result.lease });
  } catch (error) {
    console.error("workspace lease cleanup request failed", error);
    if (!res.headersSent) res.status(500).json({ error: "The workspace lease cleanup request failed" });
  }
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

registerOrchestratorClientRoutes(app, { store, broadcast, revocations: orchestratorClientRevocations });

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

/**
 * Read-only project readiness for the PWA (#31): evaluates one project profile against every
 * currently known compute node using the same `computeNodeProjectReadiness` path the scheduler
 * uses, so the UI never re-derives readiness from raw evidence. Every field returned is already
 * fixed vocabulary, a hub-issued node id, or profile content that `validateProjectProfile`
 * screened for secret-like values at load time, so nothing further needs redaction here.
 * Registered ahead of the SPA fallback below so a project-readiness request is never swallowed
 * by the catch-all that serves `index.html` for unmatched routes.
 */
const projectProfileInUse = (state: Readonly<import("./store.js").State>, projectId: string) =>
  state.tasks?.some((task) => task.requirements.projectProfileId === projectId && !isTerminalTaskStatus(task.status))
  || state.workspaceLeases?.some((lease) => lease.projectProfileId === projectId && !isTerminalWorkspaceLeaseStatus(lease.status));

app.get("/api/project-profiles", (_req, res) => {
  res.json(store.read((state) => structuredClone(state.projectProfiles ?? [])));
});

app.post("/api/project-profiles", async (req, res) => {
  const validated = validateProjectProfile(req.body);
  if (!validated.ok) return res.status(400).json({ error: validated.reason });
  let exists = false;
  await store.transact((state) => {
    if (state.projectProfiles?.some((profile) => profile.id === validated.value.id)) {
      exists = true;
      return false;
    }
    (state.projectProfiles ??= []).push(validated.value);
    state.projectProfilesImported = true;
  });
  if (exists) return res.status(409).json({ error: "A project profile with this id already exists" });
  broadcast();
  requestScheduling();
  res.status(201).json(validated.value);
});

app.put("/api/project-profiles/:id", async (req, res) => {
  const id = String(req.params.id);
  const validated = validateProjectProfile(req.body);
  if (!validated.ok) return res.status(400).json({ error: validated.reason });
  if (validated.value.id !== id) return res.status(400).json({ error: "Project profile id cannot be changed" });
  let result: "updated" | "not-found" | "in-use" = "not-found";
  await store.transact((state) => {
    const index = state.projectProfiles!.findIndex((profile) => profile.id === id);
    if (index < 0) return false;
    if (projectProfileInUse(state, id)) {
      result = "in-use";
      return false;
    }
    state.projectProfiles![index] = validated.value;
    result = "updated";
  });
  if (result === "not-found") return res.status(404).json({ error: "Project profile not found" });
  if (result === "in-use") return res.status(409).json({ error: "Project profile is in use by active work" });
  broadcast();
  requestScheduling();
  res.json(validated.value);
});

app.delete("/api/project-profiles/:id", async (req, res) => {
  const id = String(req.params.id);
  let result: "deleted" | "not-found" | "in-use" = "not-found";
  await store.transact((state) => {
    if (!state.projectProfiles?.some((profile) => profile.id === id)) return false;
    if (projectProfileInUse(state, id)) {
      result = "in-use";
      return false;
    }
    state.projectProfiles = state.projectProfiles.filter((profile) => profile.id !== id);
    result = "deleted";
  });
  if (result === "not-found") return res.status(404).json({ error: "Project profile not found" });
  if (result === "in-use") return res.status(409).json({ error: "Project profile is in use by active work" });
  broadcast();
  requestScheduling();
  res.status(204).end();
});

app.get("/api/project-readiness", (req, res) => {
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
  if (!projectId) return res.status(400).json({ error: "projectId is required" });
  const profile = store.read((state) => state.projectProfiles?.find((item) => item.id === projectId));
  if (!profile) return res.status(404).json({ error: "Project profile not found" });
  const nowIso = new Date().toISOString();
  const readiness = store.snapshot().nodes.map((node) =>
    computeNodeProjectReadiness(node, getNodeCapabilityReport(node.id), profile, nowIso));
  res.json({ profile: { id: profile.id, name: profile.name }, readiness });
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
  // An orchestrator client presents its own credential in its first frame, never in the URL, so the
  // upgrade itself carries no secret and the operator token is not what authorizes it.
  if (!isControlAgent && url.pathname !== "/events" && url.pathname !== "/orchestrator-client") return socket.destroy();
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

  if (url.pathname === "/orchestrator-client") {
    const connection = orchestratorClients.accept({
      send: (payload) => socket.send(payload),
      close: (reason) => socket.close(orchestratorClientCloseCode, reason)
    });
    const receive = serializeAsync(
      (raw: RawData) => connection.receive(raw.toString()),
      (error) => console.error("orchestrator-client frame failed", error)
    );
    socket.on("message", (raw) => { void receive(raw); });
    socket.on("close", () => { void connection.closed().catch((error) => console.error("orchestrator-client close failed", error)); });
    return;
  }

  let nodeId = "";
  let protocolVersion: ControlProtocolVersion = "1";
  const socketClosed = new AbortController();
  // Keepalive: a socket that misses a pong is terminated, so an open connection is a live one and a
  // half-open socket never blocks its Barista's reconnect for long.
  let answeredPing = true;
  socket.on("pong", () => { answeredPing = true; });
  const keepalive = setInterval(() => {
    if (!answeredPing) return socket.terminate();
    answeredPing = false;
    socket.ping();
  }, controlKeepaliveMilliseconds);
  keepalive.unref();
  const isCurrentSocket = () => {
    const connection = controlAgents.connectionFor(socket);
    return connection !== undefined && controlAgents.isCurrent(connection);
  };
  const dispatchQueuedRuns = async (connection: ControlConnection<WebSocket>, activeRunIds: readonly string[] = []) => {
    const queued = queuedRunsForNode(store.snapshot(), nodeId, activeRunIds, protocolVersion);
    for (const run of queued) {
      if (connection.deliveredRunIds.has(run.id)) continue;
      let permitted = false;
      await store.transact((state) => {
        const target = state.runs.find((item) => item.id === run.id && item.status === "queued");
        if (!target) return false;
        if (target.taskId !== undefined) {
          const task = state.tasks?.find((item) => item.id === target.taskId);
          if (!task || task.assignment?.runId !== target.id || isTerminalTaskStatus(task.status)) return false;
        }
        const targetAgent = state.agents.find((item) => item.id === target.agentId);
        if (!targetAgent || deliveryConnection(target.nodeId, dispatchMessageFor(target, targetAgent, state.agents, state.workspaceLeases, state)) !== connection) return false;
        target.dispatchedAt = new Date().toISOString();
        targetAgent.state = "thinking";
        targetAgent.currentAction = "Starting work";
        targetAgent.updatedAt = target.dispatchedAt;
        permitted = true;
      });
      if (permitted) await deliverRun(run.id, connection);
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
      if (typeof message.node?.id !== "string" || !controlAgents.admits(message.node.id, socket)) {
        return socket.close(1008, "node is already connected");
      }
      nodeId = message.node.id;
      protocolVersion = message.protocolVersion ?? "1";
      controlAgents.register(nodeId, socket, protocolVersion);
      // Acknowledges the registration: Barista replays its queued lifecycle messages only after this,
      // so nothing it queued is ever written to a socket the hub refused.
      sendToControlAgent(nodeId, { type: "ping" });
      forgetNodeCapabilityReport(nodeId);
      await store.transact((state) => {
        const index = state.nodes.findIndex((node) => node.id === nodeId);
        const online: ComputeNode = registeredComputeNode(message.node, new Date().toISOString());
        if (index >= 0) state.nodes[index] = online; else state.nodes.push(online);
        state.events.unshift(newEvent({ type: "node", title: `${online.name} connected`, detail: `${online.platform} · ${online.harnesses.filter((h) => h.available).map((h) => h.label).join(" + ")}` }));
      });
      broadcast();
      requestScheduling();
    } else if (message.type === "sync.complete") {
      if (!supportsControlCapability(protocolVersion, "replay-barrier") || !nodeId || message.nodeId !== nodeId || typeof message.at !== "string" || (message.activeRunIds !== undefined && (!Array.isArray(message.activeRunIds) || !message.activeRunIds.every((id) => typeof id === "string")))) return;
      const connection = controlAgents.connectionFor(socket);
      if (!connection || !controlAgents.isCurrent(connection)) return;
      const activeRunIds = message.activeRunIds;
      if (supportsControlCapability(protocolVersion, "orchestration") && activeRunIds !== undefined) {
        let lostAttempts = 0;
        await store.transact((state) => {
          lostAttempts = failLostTaskAttempts(state, nodeId, activeRunIds, new Date().toISOString()).length;
          return lostAttempts > 0;
        });
        if (lostAttempts > 0) broadcast();
      }
      if (!controlAgents.markSynced(connection)) return;
      await dispatchQueuedRuns(connection, activeRunIds ?? []);
      if (supportsControlCapability(protocolVersion, "orchestration") && activeRunIds !== undefined) {
        reconcileWorkspaceLeases(store, nodeId, activeRunIds, sendAfterBarrier);
      }
      if (supportsControlCapability(protocolVersion, "orchestration") && activeRunIds !== undefined
        && await reconcileApprovals(store, nodeId, activeRunIds, sendToControlAgent)) broadcast();
      requestScheduling();
    } else if (message.type === "heartbeat") {
      let capacityChanged = false;
      await store.transact((state) => { const node = state.nodes.find((item) => item.id === message.nodeId); if (node) { capacityChanged = node.activeRuns !== message.activeRuns; node.lastSeen = message.at; node.activeRuns = message.activeRuns; node.status = message.activeRuns ? "busy" : "online"; } });
      broadcast();
      if (capacityChanged) requestScheduling();
    } else if (message.type === "hub.rpc.request") {
      if (!supportsControlCapability(protocolVersion, "hub-rpc") || !nodeId || typeof message.requestId !== "string" || typeof message.runId !== "string") return;
      const source = store.getRun(message.runId);
      if (!source || source.nodeId !== nodeId || source.status !== "running") {
        respondToRpc(message.requestId, message.runId, undefined, { code: "run_not_active", message: "The calling run is not active on this node", retryable: false });
        return;
      }
      const call = handleHubTool(message.operation, message.runId, message.arguments, socketClosed.signal).then(
        (result) => respondToRpc(message.requestId, message.runId, result),
        (error: unknown) => {
          if (!(error instanceof CoordinationError)) console.error("hub tool failed", error);
          respondToRpc(message.requestId, message.runId, undefined, hubToolError(error));
        }
      );
      // A long-poll wait must not hold this socket's serialized message handling.
      if (message.operation !== "wait_for_task_events") await call;
    } else if (message.type === "harness.event" || message.type === "session.binding" || message.type === "workspace.lease" || message.type === "approval.undeliverable") {
      const validated = validateOrchestrationControlAgentMessage(decoded, protocolVersion);
      if (!validated.ok) {
        console.warn(redactor.redact(`rejected ${message.type} from ${nodeId || "an unregistered Barista"}: ${validated.reason}`));
        return;
      }
      if (!nodeId || !isCurrentSocket()) return;
      const orchestration = validated.value;
      if (orchestration.type === "harness.event") {
        const outcome = await receiveHarnessEvent(store, nodeId, orchestration.event, redactor, sendToControlAgent);
        if (outcome.kind === "rejected") console.warn(redactor.redact(`rejected harness.event from ${nodeId}: ${outcome.reason}`));
        if (outcome.kind === "accepted" || outcome.kind === "stream-failed") broadcast();
      } else if (orchestration.type === "approval.undeliverable") {
        if (await receiveApprovalUndeliverable(store, nodeId, orchestration.runId, orchestration.approvalId, orchestration.reason, redactor, orchestration.at)) broadcast();
      } else if (orchestration.type === "workspace.lease") {
        const outcome = await receiveWorkspaceLeaseUpdate(store, nodeId, orchestration.runId, orchestration.lease, redactor, orchestration.at);
        if (outcome.kind === "rejected") console.warn(`rejected workspace.lease from ${nodeId}: ${outcome.reason}`);
        const confirmation = outcome.kind === "rejected" ? undefined
          : store.read((state) => workspaceLeaseConfirmation(state, nodeId, orchestration.runId, orchestration.lease.leaseId));
        if (confirmation) sendToControlAgent(nodeId, confirmation);
        if (outcome.kind === "applied") {
          broadcast();
          requestScheduling();
        }
      } else if (orchestration.type === "session.binding") {
        const outcome = await receiveSessionBinding(store, nodeId, orchestration.runId, orchestration.binding, orchestration.at);
        if (outcome.kind === "rejected") console.warn(`rejected session.binding from ${nodeId}: ${outcome.reason}`);
        if (outcome.kind === "created" || outcome.kind === "resumed") broadcast();
      }
    } else if (message.type === "capability.report") {
      if (!supportsControlCapability(protocolVersion, "orchestration") || !nodeId || !isCurrentSocket()) return;
      const validated = validateNodeCapabilityReport(message.report);
      if (!validated.ok || validated.value.nodeId !== nodeId) return;
      recordNodeCapabilityReport(validated.value);
      requestScheduling();
      return;
    } else if (message.type.startsWith("run.")) {
      const runId = message.runId;
      const current = store.getRun(runId);
      if (!current || !isReportedByOwningNode(current, nodeId)) return;
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
      if (message.type !== "run.output") requestScheduling();
    }
  }, (error) => console.error("control-agent message failed", error));
  socket.on("message", (raw) => { void handleMessage(raw); });
  socket.on("close", async () => {
    clearInterval(keepalive);
    socketClosed.abort();
    if (!nodeId) return;
    if (!controlAgents.release(socket)) return;
    await store.transact((state) => { const node = state.nodes.find((item) => item.id === nodeId); if (node) { node.status = "offline"; node.activeRuns = 0; } });
    broadcast();
    requestScheduling();
  });
});

await store.load();
// Compatibility bridge: import the old file exactly once, then manage profiles in SQLite/UI.
if (store.read((state) => !state.projectProfilesImported && (state.projectProfiles ?? []).length === 0)) {
  const defaultProjectProfilesPath = fileURLToPath(new URL("../../../config/project-profiles.json", import.meta.url));
  const projectProfilesPath = process.env.PROJECT_PROFILES_PATH ?? defaultProjectProfilesPath;
  const projectProfilesResult = await loadProjectProfilesFromFile(projectProfilesPath);
  if (!projectProfilesResult.ok) {
    if (projectProfilesResult.kind !== "not-found" || process.env.PROJECT_PROFILES_PATH) {
      throw new Error(`project profiles failed to import: ${projectProfilesResult.error}`);
    }
  } else {
    await store.transact((state) => {
      state.projectProfiles = projectProfilesResult.profiles;
      state.projectProfilesImported = true;
    });
    console.log(`imported ${projectProfilesResult.profiles.length} project profile(s) from ${projectProfilesPath}`);
  }
}
await store.transact((state) => markDisconnectedNodesOffline(state, liveControlAgents) || false);
// No bridge connection survives a restart, so no attachment persisted by the previous process may.
await store.transact((state) => detachEveryAttachmentInState(state, new Date().toISOString()).length > 0);
requestScheduling();
// Every commit may have added an event an attached orchestrator is waiting for; the policy itself
// decides whether that earns a ring.
store.onCommit(() => orchestratorClients.ringAttachedThreads());
setInterval(() => {
  requestScheduling();
  // A ring can also fall due without any commit, when a pending approval nears its expiry.
  orchestratorClients.ringAttachedThreads();
}, 30_000).unref();
setInterval(() => {
  void expireDueApprovals(store, sendToControlAgent)
    .then((changed) => { if (changed) broadcast(); })
    .catch((error) => console.error("approval expiry failed", error));
}, 15_000).unref();
setInterval(() => {
  void orchestratorClients.expireAttachments().catch((error) => console.error("orchestrator attachment expiry failed", error));
}, orchestratorClientHeartbeatSeconds * 1000).unref();
// PORT=0 asks the operating system for a free port; the log names the port actually bound.
server.listen(port, "0.0.0.0", () => {
  const address = server.address();
  console.log(`Coffee Shop hub listening on http://localhost:${typeof address === "object" && address ? address.port : port}`);
});
