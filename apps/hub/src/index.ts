import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import cors from "cors";
import express from "express";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  canSendToControlAgent,
  isHostSessionControlMessageType,
  isControlProtocolVersion,
  isTerminalTaskStatus,
  isTerminalWorkspaceLeaseStatus,
  orchestratorClientHeartbeatSeconds,
  supportsControlCapability,
  threadOrchestrator,
  threadOwnerAgentId,
  validateProjectProfile,
  validateNodeCapabilityReport,
  validateInstanceControlMessage,
  validateHostSessionControlMessage,
  validateOrchestrationControlAgentMessage,
  type Agent,
  type ComputeNode,
  type ControlAgentToHub,
  type ControlProtocolVersion,
  type HostSessionControlMessage,
  type HubToControlAgent,
  type InstanceHubMessage,
  type Run,
  type RunTranscriptResponse
} from "@coffee-shop/protocol";
import { createConfiguredAgent, markDisconnectedNodesOffline, updateConfiguredAgent } from "./agentConfiguration.js";
import { createAgentTemplate, deleteAgentTemplate, updateAgentTemplate } from "./agentTemplateConfiguration.js";
import { ControlConnectionRegistry, type ControlConnection } from "./controlConnections.js";
import { clearComponentInventory, receiveComponentInventory } from "./componentInventories.js";
import { forgetCapabilityPackReadiness, getCapabilityPackReadiness, matchesCapabilityPackExpectation, receiveCapabilityPackReadiness } from "./capabilityPackReadiness.js";
import { acceptedTransportSelection, applyRunLifecycle, cancelPersistedRun, coalesceAsync, failLostTaskAttempts, isReportedByOwningNode, queuedRunsForNode, retryAsync, serializeAsync } from "./lifecycle.js";
import { CoordinationError } from "./coordination.js";
import { reconsiderLegacyAgentImport } from "./agentTemplates.js";
import { detachEveryAttachmentInState, postOperatorMessageInState, type OperatorMessage } from "./externalOrchestrators.js";
import { createHubToolHandler, hubToolError } from "./hubTools.js";
import {
  applyInstanceLifecycle,
  applyNodeHeartbeatInState,
  applyNodeResidencyInState,
  classifyInstanceResidentEvidence,
  classifyReportedInstanceCount,
  currentAllocationInState,
  flushPendingInstanceDeliveries,
  instanceDeliveryBarrier,
  listThreadInstances,
  maintainInstanceLifecycle,
  operatorInstanceCreator,
  receiveInstanceLifecycleReport,
  rejectInstanceAllocationProofInState,
  reconcileNodeInstancesInState,
  type InstanceLifecycleEvidence
} from "./instances.js";
import { TaskEventWaiters } from "./mailbox.js";
import { claimArtifactUploadGrant } from "./artifactUploadGrants.js";
import { forgetNodeCapabilityReport, getNodeCapabilityReport, recordNodeCapabilityReport } from "./nodeCapabilities.js";
import { registeredComputeNode } from "./nodeRegistration.js";
import { createOrchestratorClientRevocations, operatorCredentialGuard, registerOrchestratorClientRoutes } from "./orchestratorClients.js";
import { createOrchestratorClientGateway, orchestratorClientCloseCode } from "./orchestratorClientGateway.js";
import { loadProjectProfilesFromFile } from "./projectProfiles.js";
import { computeNodeProjectReadiness } from "./projectReadiness.js";
import { ArtifactIngestionError, ingestArtifactContent, recoverPreviewPreparation } from "./previewPreparation.js";
import { PreviewStorage } from "./previewStorage.js";
import {
  createMainPreviewHostGuard,
  createPreviewDeliveryApp,
  listenPreviewTopology,
  parsePreviewDeliveryConfig,
  previewRetryJsonErrorHandler,
  registerPreviewOperatorRoutes,
  requestTargetsPreviewAuthority,
  runPreviewExpiryMaintenance
} from "./previewDelivery.js";
import { retainedHarnessEvents } from "./harnessEvents.js";
import { HostSessionHistoryAuthority } from "./hostSessionHistory.js";
import { HostSessionHistoryRefresher } from "./hostSessionHistoryRefresh.js";
import {
  hostSessionOutcomeChangesClientSnapshot,
  hostSessionOutcomeRequiresResync,
  HostSessionInventoryAuthority,
  projectNodeHostSessionsOffline,
  type HostSessionInventoryConnection,
  type HostSessionInventoryOutcome
} from "./hostSessionInventory.js";
import { registerHostSessionReadRoutes } from "./hostSessionReadRoutes.js";
import { expireDueApprovals, receiveApprovalUndeliverable, receiveHarnessEvent, reconcileApprovals, resolveApproval } from "./harnessGateway.js";
import { createRedactor } from "./redaction.js";
import { dispatchMessageFor, runSchedulingPass, type SchedulingContext, type SchedulingPassResult } from "./scheduler.js";
import { runContinuationPass, type ContinuationPassResult } from "./orchestratorInbox.js";
import { createHostedThread } from "./hostedThreads.js";
import { receiveSessionBinding } from "./sessionBindings.js";
import { newEvent, newId, newMessage, Store } from "./store.js";
import { newThread, updateThreadByOperator, updateThreadForRun } from "./threads.js";
import { runTranscriptFor } from "./runTranscripts.js";
import { cleanupWorkspaceLeaseByOperator, receiveWorkspaceLeaseUpdate, reconcileWorkspaceLeases, workspaceLeaseConfirmation } from "./workspaceLeases.js";

const isHostSessionControlMessage = (message: ControlAgentToHub): message is HostSessionControlMessage =>
  isHostSessionControlMessageType(message.type);

const previewDeliveryConfiguration = parsePreviewDeliveryConfig(process.env);
const app = express();
const server = createServer(app);
const controlAgents = new ControlConnectionRegistry<WebSocket>(WebSocket.OPEN);
const controlKeepaliveMilliseconds = 15_000;
const liveControlAgents = { has: (nodeId: string) => controlAgents.has(nodeId) };
const clients = new Set<WebSocket>();
const store = new Store();
const hostSessionHistory = new HostSessionHistoryAuthority(store);
const artifactStorage = new PreviewStorage(store.storageRootDirectory());
const token = process.env.COFFEE_SHOP_TOKEN;
const port = Number(process.env.PORT ?? 8787);
const redactor = createRedactor([token]);
const orchestratorClientRevocations = createOrchestratorClientRevocations();

if (process.env.NODE_ENV === "production" && !token) {
  throw new Error("COFFEE_SHOP_TOKEN is required in production");
}

app.use(createMainPreviewHostGuard(previewDeliveryConfiguration));
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(previewRetryJsonErrorHandler);
app.use(operatorCredentialGuard(token));

const broadcast = () => {
  const payload = JSON.stringify({ type: "snapshot", data: store.clientSnapshot() });
  for (const socket of clients) if (socket.readyState === WebSocket.OPEN) socket.send(payload);
};
const hostSessionInventory = new HostSessionInventoryAuthority(store, {
  onUpdateBatchCommitted: broadcast,
  onDeferredCapacityMayFit: (nodeId) => {
    controlAgents.current(nodeId)?.socket.close(1011, "host-session resync required");
  },
  onPostCommitError: (error) => console.error("host-session post-commit callback failed", error)
});
const previewServer = previewDeliveryConfiguration.enabled
  ? createServer(createPreviewDeliveryApp({
    store,
    storage: artifactStorage,
    configuration: previewDeliveryConfiguration
  }))
  : undefined;

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
const interactiveConnection = (connection: ControlConnection<WebSocket>): HostSessionInventoryConnection => ({
  supportsCapability: supportsControlCapability(connection.protocolVersion, "interactive-sessions"),
  isCurrent: () => controlAgents.isCurrent(connection),
  nodeId: connection.nodeId,
  generation: connection.generation
});
/** Instance commands reach only the node's current, synced, protocol-v5 connection. */
const sendInstanceCommand = (nodeId: string, message: InstanceHubMessage) => controlAgents.sendInstanceCommand(nodeId, message);
/** Lease cleanup requests wait for the reconnect barrier so Barista's replayed reports land first. */
const sendAfterBarrier = (nodeId: string, message: HubToControlAgent) => {
  const connection = controlAgents.current(nodeId);
  return connection !== undefined && controlAgents.barrierPassed(connection) && controlAgents.send(nodeId, message);
};

/**
 * Expires idle instance leases, converges draining instances, prunes audit records, and writes any
 * persisted instance command whose node now has a current synced v5 connection. Bursts collapse
 * into one pass and passes never overlap.
 */
const runInstanceMaintenance = coalesceAsync(async () => {
  const changed = await maintainInstanceLifecycle(store);
  const delivered = await flushPendingInstanceDeliveries(store, sendInstanceCommand);
  if (changed || delivered) broadcast();
  /*
   * A lifecycle change can release a task's placement — an expired lease drains the instance it was
   * waiting on — so the scheduler is re-entered to place that task afresh. Only the lifecycle half
   * triggers it: a delivery is a send, and re-entering on every send would alternate the two passes.
   */
  if (changed) requestScheduling();
}, (error) => console.error("instance lifecycle maintenance failed", error));

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
    // Only a legacy agent run is delivered this way; an instance run's dispatch is a persisted
    // command in the instance outbox, which `runInstanceMaintenance` flushes instead.
    const run = state.runs.find((item) => item.id === runId && item.status === "queued" && item.dispatchedAt !== undefined && item.instanceId === undefined);
    const agent = run && run.agentId !== undefined && state.agents.find((item) => item.id === run.agentId);
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
      capabilityPackReadiness: getCapabilityPackReadiness,
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
  /*
   * An instance-keyed attempt and a reserved allocation are both persisted commands in the instance
   * outbox, never direct sends, so the pass ends by flushing that outbox instead of writing a socket
   * itself. Doing it whenever the pass changed state also covers the provision commands a fresh
   * reservation wrote, so a newly placed task starts provisioning without waiting for the next beat.
   */
  /*
   * An instance-keyed attempt or continuation and a reserved allocation are all persisted commands in
   * the instance outbox, never direct sends, so the pass ends by flushing that outbox. Doing it
   * whenever either pass changed state also covers the provision commands a fresh reservation wrote —
   * including the one a thread promotion reserved — so newly placed work starts provisioning without
   * waiting for the next beat.
   */
  if (result.changed || continuations.changed) await runInstanceMaintenance();
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

const hostSessionHistoryRefresher = new HostSessionHistoryRefresher({
  store,
  authority: hostSessionHistory,
  connectionFor: (nodeId) => {
    const connection = controlAgents.current(nodeId);
    return connection && supportsControlCapability(connection.protocolVersion, "interactive-sessions")
      ? interactiveConnection(connection)
      : undefined;
  },
  send: sendToControlAgent,
  newId,
  wait: delay
});
registerHostSessionReadRoutes(app, store, {
  refreshHistory: async (hostHarnessSessionId) => { await hostSessionHistoryRefresher.refresh(hostHarnessSessionId); }
});
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "coffee-shop-control-plane", controlAgents: controlAgents.size }));
app.get("/api/snapshot", (_req, res) => res.json(store.clientSnapshot()));

/*
 * A run's chronological transcript, for conversation views. It is served per run rather than in
 * snapshots, which every UI receives on every commit; clients refetch when the run's activity
 * sequence advances.
 */
app.get("/api/runs/:id/transcript", (req, res) => {
  const response = store.read((state): RunTranscriptResponse | undefined => {
    if (!state.runs.some((run) => run.id === req.params.id)) return undefined;
    const transcript = runTranscriptFor(state, req.params.id);
    return { runId: req.params.id, ...(transcript ? { transcript } : {}) };
  });
  if (!response) return res.status(404).json({ error: "Run not found" });
  res.json(response);
});

app.post("/api/threads", async (req, res) => {
  try {
    const result = await createHostedThread(store, "operator", req.body, {
      connection: schedulingConnection,
      capabilityReport: getNodeCapabilityReport,
      capabilityPackReadiness: getCapabilityPackReadiness,
      projectProfile: (projectId) => store.read((state) => state.projectProfiles?.find((profile) => profile.id === projectId)),
      canDeliver: () => false
    });
    if (!result.replayed) broadcast();
    // An exact retry may be the first request that survives long enough to flush the durable
    // provision outbox, so replay still drives maintenance and scheduling.
    await runInstanceMaintenance();
    requestScheduling();
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) {
    const failure = error instanceof CoordinationError ? error : new CoordinationError("internal_error", "The hosted thread could not be created", true);
    const status = failure.code === "idempotency_conflict" || failure.code === "unavailable" ? 409
      : failure.code === "invalid_arguments" ? 400 : 500;
    res.status(status).json({ error: failure.message });
  }
});

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
    let posted: OperatorMessage | undefined;
    await store.transact((state) => {
      let thread = requestedThreadId ? state.threads?.find((item) => item.id === requestedThreadId) : undefined;
      if (requestedThreadId && !thread) throw new CoordinationError("not_found", "Thread not found");
      if (thread && threadOrchestrator(thread)?.kind === "external") {
        throw new CoordinationError("forbidden", "An externally orchestrated thread takes messages at /api/threads/:id/messages");
      }
      /*
       * A thread this route may continue as an agent run is one the named agent still orchestrates. A
       * thread that has been promoted to an instance orchestrator is continued through its mailbox
       * instead — the operator's message becomes an inbox event the continuation pass wakes the
       * resident for — so the legacy entry point keeps working across the promotion boundary without
       * ever queueing a run for an agent that no longer orchestrates the thread.
       */
      if (thread && threadOrchestrator(thread)?.kind === "instance") {
        if (thread.status === "archived") throw new CoordinationError("thread_archived", "Archived threads are read-only");
        posted = postOperatorMessageInState(state, { threadId: thread.id, body }, new Date().toISOString());
        threadId = thread.id;
        return posted.created;
      }
      if (thread && threadOwnerAgentId(thread) !== agent.id) throw new CoordinationError("forbidden", "Continue this thread with its owner agent");
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
    if (posted) {
      broadcast();
      requestScheduling();
      return res.status(202).json({ threadId, messageId: posted.message.id, sequence: posted.message.sequence, created: posted.created });
    }
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
    /*
     * A refusal to import this agent described the configuration it had before this change, so it is
     * forgotten and the next import pass decides afresh; a now-representable agent must not stay barred
     * for ever. A recorded success is left alone, which is what keeps the import single-shot. The
     * import itself stays at load time: it changes how skill-requiring work is placed, so it is not
     * something an agent edit should re-route mid-flight.
     */
    reconsiderLegacyAgentImport(state, result.agent.id);
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
  const leases = store.read((state) => structuredClone((state.workspaceLeases ?? [])
    .filter((lease) => filters.every((key) => query[key] === undefined || lease[key] === query[key]))));
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

/*
 * Operator instance lifecycle endpoints. Every mutation goes through the shared instance service,
 * which is the single authority for statuses, receipts, and delivery decisions; a thread's
 * instances are visible only from that thread, and an unknown thread and a foreign instance are
 * indistinguishable to the caller.
 */
const instanceRequestFailure = (response: express.Response, error: unknown) => {
  const failure = error instanceof CoordinationError ? error : new CoordinationError("internal_error", "The instance request failed", true);
  const status = failure.code === "not_found" || failure.code === "not_attached" ? 404
    : failure.code === "forbidden" ? 403
      : failure.code === "idempotency_conflict" || failure.code === "thread_inactive" || failure.code === "conflict" ? 409
        : 400;
  response.status(status).json({ error: failure.message });
};

const operatorIdempotencyKey = (body: unknown): string | undefined => {
  const key = typeof (body as { idempotencyKey?: unknown } | undefined)?.idempotencyKey === "string"
    ? (body as { idempotencyKey: string }).idempotencyKey.trim()
    : "";
  return key ? key : undefined;
};

app.post("/api/threads/:threadId/instances", async (req, res) => {
  const idempotencyKey = operatorIdempotencyKey(req.body);
  if (!idempotencyKey) return res.status(400).json({ error: "idempotencyKey is required" });
  try {
    const result = await applyInstanceLifecycle(store, operatorInstanceCreator, {
      operation: "create",
      threadId: req.params.threadId,
      idempotency: { caller: operatorInstanceCreator, key: idempotencyKey },
      purpose: req.body?.purpose,
      requirements: req.body?.requirements,
      idleTimeoutSeconds: req.body?.idleTimeoutSeconds,
      initialTask: req.body?.initialTask
    });
    if (!result.replayed) {
      broadcast();
      requestScheduling();
    }
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) {
    instanceRequestFailure(res, error);
  }
});

app.get("/api/threads/:threadId/instances", (req, res) => {
  const threadId = req.params.threadId;
  const view = store.read((state) => ({
    exists: state.threads?.some((thread) => thread.id === threadId) ?? false,
    listing: listThreadInstances(state, threadId, req.query.includeTerminal === "true" || req.query.includeTerminal === "1")
  }));
  if (!view.exists) return res.status(404).json({ error: "Thread not found" });
  res.json(view.listing);
});

app.get("/api/threads/:threadId/instances/:instanceId", (req, res) => {
  const view = store.read((state) => {
    const instance = (state.instances ?? []).find((item) => item.id === req.params.instanceId && item.threadId === req.params.threadId);
    if (!instance) return undefined;
    const allocation = currentAllocationInState(state, instance.id);
    return { instance: structuredClone(instance), ...(allocation ? { allocation: structuredClone(allocation) } : {}) };
  });
  if (!view) return res.status(404).json({ error: "Instance not found" });
  res.json(view);
});

app.post("/api/threads/:threadId/instances/:instanceId/renew", async (req, res) => {
  const idempotencyKey = operatorIdempotencyKey(req.body);
  if (!idempotencyKey) return res.status(400).json({ error: "idempotencyKey is required" });
  try {
    const result = await applyInstanceLifecycle(store, operatorInstanceCreator, {
      operation: "renew",
      threadId: req.params.threadId,
      instanceId: req.params.instanceId,
      idempotency: { caller: operatorInstanceCreator, key: idempotencyKey },
      idleTimeoutSeconds: req.body?.idleTimeoutSeconds
    });
    if (result.replayed === false) broadcast();
    res.json(result);
  } catch (error) {
    instanceRequestFailure(res, error);
  }
});

app.post("/api/threads/:threadId/instances/:instanceId/release", async (req, res) => {
  const idempotencyKey = operatorIdempotencyKey(req.body);
  if (!idempotencyKey) return res.status(400).json({ error: "idempotencyKey is required" });
  if (req.body?.mode !== "drain" && req.body?.mode !== "cancel") return res.status(400).json({ error: "mode must be drain or cancel" });
  try {
    const result = await applyInstanceLifecycle(store, operatorInstanceCreator, {
      operation: "release",
      threadId: req.params.threadId,
      instanceId: req.params.instanceId,
      idempotency: { caller: operatorInstanceCreator, key: idempotencyKey },
      mode: req.body.mode
    });
    broadcast();
    requestScheduling();
    void runInstanceMaintenance();
    res.status(result.replayed ? 200 : 202).json(result);
  } catch (error) {
    instanceRequestFailure(res, error);
  }
});

const templateRequestFailure = (response: express.Response, error: unknown) => {
  const failure = error instanceof CoordinationError
    ? error
    : new CoordinationError("internal_error", "The template request failed", true);
  const status = failure.code === "not_found" ? 404
    : failure.code === "idempotency_conflict" || failure.code === "conflict" ? 409
      : failure.code === "invalid_arguments" ? 400 : 500;
  response.status(status).json({ error: failure.message });
};

const templateMutationBody = (body: unknown) => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new CoordinationError("invalid_arguments", "Template request must be an object");
  }
  const { idempotencyKey, ...changes } = body as Record<string, unknown>;
  if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
    throw new CoordinationError("invalid_arguments", "idempotencyKey is required");
  }
  return { idempotencyKey: idempotencyKey.trim(), changes };
};

app.get("/api/agent-templates", (_req, res) => {
  res.json({ templates: store.read((state) => structuredClone(state.templates ?? [])) });
});

app.post("/api/agent-templates", async (req, res) => {
  try {
    const request = templateMutationBody(req.body);
    const result = await createAgentTemplate(store, "operator", request.idempotencyKey, request.changes);
    if (!result.replayed) broadcast();
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) {
    templateRequestFailure(res, error);
  }
});

app.patch("/api/agent-templates/:templateId", async (req, res) => {
  try {
    const request = templateMutationBody(req.body);
    const result = await updateAgentTemplate(store, "operator", request.idempotencyKey, req.params.templateId, request.changes);
    if (!result.replayed) broadcast();
    res.json(result);
  } catch (error) {
    templateRequestFailure(res, error);
  }
});

app.delete("/api/agent-templates/:templateId", async (req, res) => {
  try {
    const request = templateMutationBody(req.body);
    if (Object.keys(request.changes).length !== 0) throw new CoordinationError("invalid_arguments", "Delete accepts only idempotencyKey");
    const result = await deleteAgentTemplate(store, "operator", request.idempotencyKey, req.params.templateId);
    if (!result.replayed) broadcast();
    res.json(result);
  } catch (error) {
    templateRequestFailure(res, error);
  }
});

app.get("/api/approvals", (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const runId = typeof req.query.runId === "string" ? req.query.runId : undefined;
  const threadId = typeof req.query.threadId === "string" ? req.query.threadId : undefined;
  const approvals = store.read((state) => structuredClone((state.approvals ?? []).filter((approval) =>
    (!status || approval.status === status) && (!runId || approval.runId === runId) && (!threadId || approval.threadId === threadId))));
  res.json({ approvals });
});

app.get("/api/approvals/:id", (req, res) => {
  const approval = store.read((state) => structuredClone(state.approvals?.find((item) => item.id === req.params.id)));
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
registerPreviewOperatorRoutes(app, {
  store,
  storage: artifactStorage,
  configuration: previewDeliveryConfiguration,
  broadcast
});

app.get("/api/runs/:id/events", (req, res) => {
  if (!store.getRun(req.params.id)) return res.status(404).json({ error: "Run not found" });
  const after = Number(req.query.after ?? 0);
  if (!Number.isSafeInteger(after) || after < 0) return res.status(400).json({ error: "after must be a non-negative integer" });
  const events = store.read((state) => structuredClone(retainedHarnessEvents(state, req.params.id, after)));
  const activity = store.read((state) => structuredClone(state.runActivity?.find((item) => item.runId === req.params.id)));
  res.json({ events: events.map((record) => record.event), activity });
});

app.put("/api/artifacts/:id/content", async (req, res) => {
  try {
    const authorization = req.header("authorization");
    const bearer = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
    const queryCredential = typeof req.query.token === "string" ? req.query.token : undefined;
    const needsGrant = authorization !== undefined && bearer !== token;
    // External upload capabilities are accepted only in the Authorization header and are consumed
    // before the request body reaches immutable storage. Operator credentials keep their existing
    // behavior; an explicit malformed/header-or-query capability is never treated as anonymous dev.
    if ((authorization !== undefined && bearer === undefined)
      || (queryCredential !== undefined && queryCredential !== token)
      || (needsGrant && (bearer === undefined || !await claimArtifactUploadGrant(store, req.params.id, bearer)))) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    await ingestArtifactContent(store, artifactStorage, {
      artifactId: req.params.id,
      contentType: req.headers["content-type"],
      body: req,
      complete: () => req.complete
    });
    broadcast();
    res.status(204).end();
  } catch (error) {
    if (!(error instanceof ArtifactIngestionError)) {
      console.error("artifact ingestion failed", { artifactId: req.params.id, code: "unexpected" });
      return res.status(500).json({ error: "Artifact ingestion failed" });
    }
    if (error.httpStatus >= 500) {
      console.error("artifact ingestion failed", { artifactId: req.params.id, code: error.code });
    }
    if (error.code !== "not-found") broadcast();
    const message = error.code === "not-found"
      ? "Artifact not found"
      : error.code === "invalid-type"
        ? "Artifact content must be application/octet-stream"
        : error.code === "storage-conflict"
          ? "Artifact content conflicts with immutable storage"
          : error.code === "processing-failed"
            ? "Artifact processing failed"
            : "Artifact content or preview bundle was rejected";
    res.status(error.httpStatus).json({ error: message });
  }
});

app.get("/api/artifacts/:id/content", async (req, res) => {
  const artifact = store.read((state) => structuredClone(state.artifacts?.find((item) => item.id === req.params.id && item.uploaded)));
  if (!artifact) return res.status(404).json({ error: "Artifact not found" });
  try {
    res.type(artifact.mediaType).send(await artifactStorage.readArtifact(artifact.id));
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
  const readiness = store.read((state) => state.nodes.map((node) =>
    computeNodeProjectReadiness(node, getNodeCapabilityReport(node.id), profile, nowIso)));
  res.json({ profile: { id: profile.id, name: profile.name }, readiness });
});

const webDist = resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get("/{*path}", (_req, res) => res.sendFile(resolve(webDist, "index.html")));
}

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  if (requestTargetsPreviewAuthority(request, previewDeliveryConfiguration)) {
    socket.end("HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }
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
    socket.send(JSON.stringify({ type: "snapshot", data: store.clientSnapshot() }));
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
    const queued = queuedRunsForNode(store.clientSnapshot(), nodeId, activeRunIds, protocolVersion);
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
    const decodedType = decoded.type;
    const message = decoded as ControlAgentToHub;
    if (message.type === "register") {
      if (message.protocolVersion !== undefined && !isControlProtocolVersion(message.protocolVersion)) return socket.close(1002, "unsupported control protocol");
      if (typeof message.node?.id !== "string" || !controlAgents.admits(message.node.id, socket)) {
        return socket.close(1008, "node is already connected");
      }
      protocolVersion = message.protocolVersion ?? "1";
      // A version-5 registration carries resident instance capacity, so it must be well formed
      // before the hub records the node as instance-capable.
      if (supportsControlCapability(protocolVersion, "instances")) {
        const registration = validateInstanceControlMessage(decoded, protocolVersion);
        if (!registration.ok) return socket.close(1002, "invalid v5 registration");
      }
      nodeId = message.node.id;
      const previousConnection = controlAgents.connectionFor(socket);
      if (previousConnection) {
        const previousInteractive = interactiveConnection(previousConnection);
        hostSessionInventory.discard(previousInteractive);
        hostSessionHistory.discard(previousInteractive);
      }
      controlAgents.register(nodeId, socket, protocolVersion);
      // Acknowledges the registration: Barista replays its queued lifecycle messages only after this,
      // so nothing it queued is ever written to a socket the hub refused.
      sendToControlAgent(nodeId, { type: "ping" });
      forgetNodeCapabilityReport(nodeId);
      forgetCapabilityPackReadiness(nodeId);
      await store.transact((state) => {
        const index = state.nodes.findIndex((node) => node.id === nodeId);
        const online: ComputeNode = registeredComputeNode(message.node, new Date().toISOString());
        if (index >= 0) state.nodes[index] = online; else state.nodes.push(online);
        clearComponentInventory(state, nodeId!);
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
      /*
       * Instance commands stay behind a second barrier: the resident set reported with this sync
       * must be applied before any pending provision or release may be written to the socket.
       * Without it, a maintenance pass could deliver a pending provision between the replay barrier
       * and reconciliation, and the pre-provision snapshot would then mark it lost, duplicating
       * residency. The evidence is validated before the barrier is decided, so absent, explicitly
       * empty, and malformed stay three distinct answers: only an absent claim opens the barrier
       * with nothing to apply, and a malformed one leaves it closed.
       */
      const residentEvidence = classifyInstanceResidentEvidence(decoded, protocolVersion, "sync.complete");
      const barrier = instanceDeliveryBarrier(residentEvidence);
      if (residentEvidence.kind === "malformed") {
        console.warn(redactor.redact(`refused resident evidence from ${nodeId}: ${residentEvidence.reason}`));
      }
      if (barrier === "open-now") controlAgents.openInstanceDelivery(connection);
      await dispatchQueuedRuns(connection, activeRunIds ?? []);
      if (supportsControlCapability(protocolVersion, "orchestration") && activeRunIds !== undefined) {
        reconcileWorkspaceLeases(store, nodeId, activeRunIds, sendAfterBarrier);
      }
      if (supportsControlCapability(protocolVersion, "orchestration") && activeRunIds !== undefined
        && await reconcileApprovals(store, nodeId, activeRunIds, sendToControlAgent)) broadcast();
      // Explicit resident evidence is authoritative: absent evidence (no valid activeInstanceIds)
      // changes nothing. Everything the node still reports stays, missing allocations become lost,
      // and unknown residents are asked to release without ever being adopted.
      if (residentEvidence.kind === "authoritative") {
        const residents = residentEvidence.residents;
        let reconciled = false;
        await store.transact((state) => {
          reconciled = reconcileNodeInstancesInState(state, nodeId, residents, new Date().toISOString());
          return reconciled;
        });
        if (reconciled) broadcast();
        if (barrier === "open-after-reconcile") controlAgents.openInstanceDelivery(connection);
      }
      await runInstanceMaintenance();
      requestScheduling();
    } else if (message.type === "heartbeat") {
      let capacityChanged = false;
      const ownHeartbeat = message.nodeId === nodeId && isCurrentSocket();
      // The reported resident count is validated before it is applied, so a malformed count neither
      // reaches the node record nor passes for an omitted one: the last known usage stands.
      const reportedCount = ownHeartbeat ? classifyReportedInstanceCount(decoded, protocolVersion) : { kind: "absent" as const };
      if (reportedCount.kind === "malformed") {
        console.warn(redactor.redact(`refused reported instance usage from ${nodeId}: ${reportedCount.reason}`));
      }
      const reportedInstances = reportedCount.kind === "reported" ? reportedCount.count : undefined;
      let refusedReportedInstances = false;
      await store.transact((state) => {
        ({ capacityChanged, refusedReportedInstances } = applyNodeHeartbeatInState(
          state, message.nodeId, message.activeRuns, reportedInstances, message.at
        ));
      });
      if (refusedReportedInstances) {
        console.warn(redactor.redact(`refused reported instance usage from ${nodeId}: count exceeds registered capacity`));
      }
      /*
       * A heartbeat carries the node's resident identities (#114), classified by the same tri-state
       * reader as the reconnect barrier's: absent infers nothing, an explicitly empty set is an
       * authoritative zero, and a malformed one is refused rather than read as an omission. Applying
       * it here is what makes the hub's residency record current truth — staleness is bounded by one
       * heartbeat interval — so the capacity derivation never has to infer vacancy from anything else.
       *
       * Only the residency record and the outbox it authorizes are written. Allocation loss and
       * command replay stay with the reconnect barrier: a beat that races a provision the node has not
       * applied yet would otherwise declare that allocation lost.
       */
      const residentEvidence = ownHeartbeat
        ? classifyInstanceResidentEvidence(decoded, protocolVersion, "heartbeat")
        : { kind: "absent" as const };
      if (residentEvidence.kind === "malformed") {
        console.warn(redactor.redact(`refused resident evidence from ${nodeId}: ${residentEvidence.reason}`));
      }
      if (residentEvidence.kind === "authoritative") {
        const residents = residentEvidence.residents;
        let residencyChanged = false;
        await store.transact((state) => {
          residencyChanged = applyNodeResidencyInState(state, message.nodeId, residents, message.at);
          return residencyChanged;
        });
        if (residencyChanged) {
          capacityChanged = true;
          await runInstanceMaintenance();
        }
      }
      broadcast();
      if (capacityChanged) requestScheduling();
    } else if (decodedType === "instance.ready" || decodedType === "instance.failed" || decodedType === "instance.released") {
      if (!supportsControlCapability(protocolVersion, "instances") || !nodeId || !isCurrentSocket()) return;
      const validated = validateInstanceControlMessage(decoded, protocolVersion);
      if (!validated.ok) {
        console.warn(redactor.redact(`rejected ${decodedType} from ${nodeId || "an unregistered Barista"}: ${validated.reason}`));
        return;
      }
      const outcome = await receiveInstanceLifecycleReport(store, nodeId, validated.value as InstanceLifecycleEvidence, new Date().toISOString());
      if (outcome.kind === "rejected") console.warn(`rejected ${decodedType} from ${nodeId}: ${outcome.reason}`);
      if (outcome.changed) {
        broadcast();
        requestScheduling();
        await runInstanceMaintenance();
      }
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
    } else if (message.type === "component.inventory") {
      const outcome = await receiveComponentInventory(store, {
        supportsCapability: supportsControlCapability(protocolVersion, "component-inventory"),
        isCurrent: isCurrentSocket, nodeId
      }, message.report);
      if (outcome.kind === "rejected") console.warn(`rejected component.inventory from ${nodeId}: ${outcome.reason}`);
      if (outcome.changed) broadcast();
      return;
    } else if (message.type === "capability-pack.readiness") {
      if (!nodeId) return;
      const outcome = receiveCapabilityPackReadiness({
        supportsCapability: supportsControlCapability(protocolVersion, "capability-pack-readiness"),
        isCurrent: isCurrentSocket,
        nodeId
      }, message.report);
      if (outcome.kind === "rejected") console.warn(`rejected capability-pack.readiness from ${nodeId}: ${outcome.reason}`);
      if (outcome.changed) requestScheduling();
      return;
    } else if (message.type === "capability.report") {
      if (!supportsControlCapability(protocolVersion, "orchestration") || !nodeId || !isCurrentSocket()) return;
      const validated = validateNodeCapabilityReport(message.report);
      if (!validated.ok || validated.value.nodeId !== nodeId) return;
      recordNodeCapabilityReport(validated.value);
      requestScheduling();
      return;
    } else if (isHostSessionControlMessage(message)) {
      if (!nodeId || !isCurrentSocket()) {
        console.warn(`withheld unauthenticated ${decodedType} frame`);
        return;
      }
      const current = controlAgents.connectionFor(socket);
      if (!current) {
        console.warn(`withheld unregistered ${decodedType} frame from ${nodeId}`);
        return;
      }
      const connection = interactiveConnection(current);
      const validated = validateHostSessionControlMessage(decoded, protocolVersion);
      if (!validated.ok) {
        hostSessionHistory.rejectMalformed(connection, decoded);
        console.warn(`withheld invalid ${decodedType} frame from ${nodeId}`);
        return;
      }
      if (validated.value.nodeId !== nodeId) {
        console.warn(`withheld mismatched ${decodedType} frame from ${nodeId}`);
        return;
      }
      const inventoryMessage = validated.value.type === "host-session.inventory.page"
        || validated.value.type === "host-session.inventory.complete"
        || validated.value.type === "host-session.update";
      const settleOutcome = (outcome: HostSessionInventoryOutcome) => {
        if (outcome.kind === "rejected") {
          console.warn(redactor.redact(`rejected ${decodedType} from ${nodeId}: ${outcome.reason}`));
          if (hostSessionOutcomeRequiresResync(validated.value, outcome)) {
            socket.close(1011, "host-session resync required");
          }
          return;
        }
        if (outcome.kind === "capacity") {
          console.warn(redactor.redact(`deferred ${decodedType} from ${nodeId}: ${outcome.reason}`));
          return;
        }
        if (outcome.kind === "older") console.warn(`ignored older ${decodedType} from ${nodeId}`);
        if (validated.value.type !== "host-session.update"
          && hostSessionOutcomeChangesClientSnapshot(validated.value, outcome)) broadcast();
      };
      if (validated.value.type === "host-session.update") {
        const immediate = hostSessionInventory.deferUpdate(
          connection,
          validated.value,
          settleOutcome,
          (error) => {
            if (isCurrentSocket()) socket.close(1011, "host-session resync required");
            console.error("host-session update persistence failed", error);
          }
        );
        settleOutcome(immediate);
        return;
      }
      let outcome: HostSessionInventoryOutcome | undefined;
      try {
        if (validated.value.type === "host-session.history.page") {
          outcome = await hostSessionHistory.receive(connection, validated.value);
        } else if (inventoryMessage) {
          outcome = await hostSessionInventory.receive(connection, validated.value);
        }
      } catch (error) {
        if (inventoryMessage) socket.close(1011, "host-session resync required");
        throw error;
      }
      if (!outcome) {
        // #160 owns command acknowledgements/results and host-session harness events.
        console.warn(`withheld ${decodedType} from ${nodeId}: host-session mutation authority is not enabled`);
        return;
      }
      settleOutcome(outcome);
      return;
    } else if (message.type.startsWith("run.")) {
      const runId = message.runId;
      const current = store.getRun(runId);
      if (!current || !isReportedByOwningNode(current, nodeId)) return;
      let accepted = false;
      await retryAsync(async () => {
        accepted = false;
        await store.transact((state) => {
          if (message.type === "run.started") {
            const candidate = state.runs.find((item) => item.id === message.runId);
            const allocation = candidate?.allocationId === undefined ? undefined
              : (state.allocations ?? []).find((item) => item.id === candidate.allocationId);
            const expected = allocation?.expectedCapabilityPack;
            if (candidate && expected !== undefined) {
              const matches = matchesCapabilityPackExpectation(
                expected,
                acceptedTransportSelection(candidate, message.transport),
                allocation === undefined ? undefined : getCapabilityPackReadiness(allocation.nodeId),
                allocation?.harnessId ?? ""
              );
              if (!matches) {
                accepted = rejectInstanceAllocationProofInState(
                  state,
                  candidate.id,
                  "Barista did not prove the allocation's expected capability pack before the prompt",
                  message.at
                );
                return accepted;
              }
            }
          }
          accepted = applyRunLifecycle(state, message);
          return accepted;
        });
      });
      if (!accepted) return;
      if (message.type === "run.completed" && current.depth < 3) {
        const directive = message.output.match(/<handoff\s+to=["']([^"']+)["']>([\s\S]*?)<\/handoff>/i);
        const recipient = directive && store.getAgent(directive[1]);
        // A handoff directive is agent-to-agent; an instance run names no configured sender, so the
        // directive is ignored rather than dereferenced through an agent lookup that returns nothing.
        const sender = current.agentId === undefined ? undefined : store.getAgent(current.agentId);
        if (directive && recipient && sender) {
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
    const closingConnection = controlAgents.connectionFor(socket);
    if (closingConnection) {
      const closingInteractive = interactiveConnection(closingConnection);
      hostSessionInventory.discard(closingInteractive);
      hostSessionHistory.discard(closingInteractive);
    }
    const released = controlAgents.release(socket);
    if (!released) return;
    forgetCapabilityPackReadiness(nodeId);
    await store.transact((state) => {
      const node = state.nodes.find((item) => item.id === nodeId);
      if (node) { node.status = "offline"; node.activeRuns = 0; }
      projectNodeHostSessionsOffline(state, nodeId);
    });
    broadcast();
    requestScheduling();
  });
});

await store.load();
await recoverPreviewPreparation(store, artifactStorage);
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
await store.transact((state) => {
  const nodesChanged = markDisconnectedNodesOffline(state, liveControlAgents);
  let sessionsChanged = false;
  for (const node of state.nodes) {
    if (node.status === "offline" && projectNodeHostSessionsOffline(state, node.id)) sessionsChanged = true;
  }
  return nodesChanged || sessionsChanged;
});
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
// Idle instance leases expire, draining instances converge, and persisted instance commands are
// written to any current synced v5 connection, all through the shared lifecycle service.
setInterval(() => {
  void runInstanceMaintenance();
}, 15_000).unref();
setInterval(() => {
  void expireDueApprovals(store, sendToControlAgent)
    .then((changed) => { if (changed) broadcast(); })
    .catch((error) => console.error("approval expiry failed", error));
}, 15_000).unref();
setInterval(() => {
  void runPreviewExpiryMaintenance(store, broadcast)
    .catch(() => console.error("preview expiry maintenance failed", { code: "unexpected" }));
}, 15_000).unref();
setInterval(() => {
  void orchestratorClients.expireAttachments().catch((error) => console.error("orchestrator attachment expiry failed", error));
}, orchestratorClientHeartbeatSeconds * 1000).unref();
// Both configured listeners must bind successfully; a partial topology is closed before startup fails.
await listenPreviewTopology(
  { server, port, host: "0.0.0.0" },
  previewServer && previewDeliveryConfiguration.enabled
    ? { server: previewServer, port: previewDeliveryConfiguration.port, host: previewDeliveryConfiguration.bindHost }
    : undefined
);

// PORT=0 asks the operating system for a free port; the log names the port actually bound.
const address = server.address();
console.log(`Coffee Shop hub listening on http://localhost:${typeof address === "object" && address ? address.port : port}`);
if (previewServer && previewDeliveryConfiguration.enabled) {
  console.log(`Coffee Shop preview delivery listening on ${previewDeliveryConfiguration.bindHost}:${previewDeliveryConfiguration.port}`);
}
