import { artifactKinds, type Agent, type Artifact, type Delegation, type Run, type Snapshot } from "@coffee-shop/protocol";
import { newEvent, newId, newMessage, type Store } from "./store.js";

const maxDelegationDepth = 3;
const maxChildrenPerRun = 4;

export class CoordinationError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CoordinationError("invalid_arguments", "Tool arguments must be an object");
  return value as Record<string, unknown>;
}

function requiredString(values: Record<string, unknown>, key: string, maximum: number) {
  const value = typeof values[key] === "string" ? values[key].trim() : "";
  if (!value) throw new CoordinationError("invalid_arguments", `${key} is required`);
  if (value.length > maximum) throw new CoordinationError("invalid_arguments", `${key} must be at most ${maximum} characters`);
  return value;
}

function stringArray(values: Record<string, unknown>, key: string, maximum: number) {
  if (values[key] === undefined) return [];
  if (!Array.isArray(values[key]) || values[key].length > maximum || !values[key].every((item) => typeof item === "string" && item.trim())) {
    throw new CoordinationError("invalid_arguments", `${key} must be an array of at most ${maximum} non-empty strings`);
  }
  return values[key].map((item) => (item as string).trim());
}

function relatedRun(snapshot: Snapshot, sourceRunId: string, requestedRunId: string) {
  if (sourceRunId === requestedRunId) return true;
  const parents = new Map(snapshot.runs.map((run) => [run.id, run.parentRunId]));
  let cursor: string | undefined = requestedRunId;
  while (cursor) {
    if (cursor === sourceRunId) return true;
    cursor = parents.get(cursor);
  }
  cursor = sourceRunId;
  while (cursor) {
    if (cursor === requestedRunId) return true;
    cursor = parents.get(cursor);
  }
  return false;
}

export function taskContext(snapshot: Snapshot, sourceRunId: string, argumentsValue: unknown) {
  const values = record(argumentsValue);
  const requestedRunId = typeof values.taskId === "string" && values.taskId.trim() ? values.taskId.trim() : sourceRunId;
  if (!relatedRun(snapshot, sourceRunId, requestedRunId)) throw new CoordinationError("forbidden", "Only the current task and its lineage are visible");
  const run = snapshot.runs.find((item) => item.id === requestedRunId);
  if (!run) throw new CoordinationError("not_found", "Task not found");
  const source = snapshot.runs.find((item) => item.id === sourceRunId);
  const sourceAgent = source && snapshot.agents.find((agent) => agent.id === source.agentId);
  const thread = source?.threadId ? snapshot.threads?.find((item) => item.id === source.threadId) : undefined;
  const children = snapshot.runs.filter((item) => item.parentRunId === run.id);
  const delegations = (snapshot.delegations ?? []).filter((item) => item.parentRunId === run.id);
  const delegationByChild = new Map(delegations.map((item) => [item.childRunId, item]));
  return {
    thread: thread ? {
      id: thread.id,
      title: thread.title,
      objective: thread.objective,
      summary: thread.summary,
      status: thread.status,
      ownerAgentId: thread.ownerAgentId,
      updatedAt: thread.updatedAt
    } : undefined,
    task: {
      id: run.id,
      status: run.status,
      agentId: run.agentId,
      objective: run.prompt,
      depth: run.depth,
      parentTaskId: run.parentRunId,
      output: run.status === "completed" ? run.output.slice(0, 8_000) : undefined,
      error: run.error
    },
    delegations: children.map((child) => ({
      taskId: child.id,
      delegationId: delegationByChild.get(child.id)?.id,
      agentId: child.agentId,
      status: child.status,
      summary: child.status === "completed" ? child.output.slice(0, 2_000) : child.error
    })),
    artifacts: (snapshot.artifacts ?? [])
      .filter((artifact) => artifact.uploaded && Boolean(source?.threadId) && artifact.threadId === source?.threadId)
      .slice(0, 16),
    availableAgents: sourceAgent?.canDelegate ? snapshot.agents
      .filter((agent) => agent.id !== sourceAgent.id)
      .map((agent) => ({ id: agent.id, title: agent.title, state: agent.state })) : [],
    limits: {
      maxDepth: maxDelegationDepth,
      remainingDepth: Math.max(0, maxDelegationDepth - run.depth),
      maxChildren: maxChildrenPerRun,
      remainingChildren: Math.max(0, maxChildrenPerRun - children.length)
    },
    version: snapshot.generatedAt
  };
}

export interface DelegationResult {
  run: Run;
  agent: Agent;
  created: boolean;
  dispatched: boolean;
}

export async function delegateTask(
  store: Store,
  sourceRunId: string,
  argumentsValue: unknown,
  isNodeConnected: (nodeId: string) => boolean,
  at = new Date().toISOString()
): Promise<DelegationResult> {
  const values = record(argumentsValue);
  const targetAgentId = requiredString(values, "agentId", 128);
  const task = requiredString(values, "task", 8_000);
  const idempotencyKey = requiredString(values, "idempotencyKey", 128);
  const artifactIds = stringArray(values, "artifactIds", 16);
  let result: DelegationResult | undefined;

  await store.transact((state) => {
    state.delegations ??= [];
    const source = state.runs.find((run) => run.id === sourceRunId);
    if (!source || source.status !== "running") throw new CoordinationError("run_not_active", "The source task is not running");
    const thread = source.threadId && state.threads?.find((item) => item.id === source.threadId);
    if (!thread) throw new CoordinationError("not_found", "The source task is not attached to a thread");
    if (thread.status !== "active") throw new CoordinationError("thread_inactive", "Delegation requires an active thread");
    const sender = state.agents.find((agent) => agent.id === source.agentId);
    if (!sender?.canDelegate) throw new CoordinationError("forbidden", "This agent is not allowed to delegate tasks");
    const replay = state.delegations.find((item) => item.parentRunId === source.id && item.idempotencyKey === idempotencyKey);
    if (replay) {
      if (replay.toAgentId !== targetAgentId || replay.task !== task || JSON.stringify(replay.artifactIds ?? []) !== JSON.stringify(artifactIds)) {
        throw new CoordinationError("idempotency_conflict", "The idempotency key was already used with different arguments");
      }
      const child = state.runs.find((run) => run.id === replay.childRunId);
      const replayTarget = state.agents.find((agent) => agent.id === replay.toAgentId);
      if (!child) throw new CoordinationError("inconsistent_state", "The prior delegated task is unavailable", true);
      if (!replayTarget) throw new CoordinationError("inconsistent_state", "The prior delegated agent is unavailable", true);
      result = { run: child, agent: replayTarget, created: false, dispatched: Boolean(child.dispatchedAt) };
      return false;
    }
    const target = state.agents.find((agent) => agent.id === targetAgentId);
    if (!target) throw new CoordinationError("invalid_target", "The target agent does not exist");
    if (target.id === sender.id) throw new CoordinationError("invalid_target", "An agent cannot delegate to itself");
    const attachedArtifacts = artifactIds.map((id) => state.artifacts?.find((artifact) => artifact.id === id && artifact.runId === source.id && artifact.uploaded));
    if (attachedArtifacts.some((artifact) => !artifact)) throw new CoordinationError("invalid_artifact", "Every attached artifact must be uploaded by the source task");
    if (source.depth >= maxDelegationDepth) throw new CoordinationError("depth_limit", "The delegation depth limit has been reached");
    if (state.delegations.filter((item) => item.parentRunId === source.id).length >= maxChildrenPerRun) {
      throw new CoordinationError("fanout_limit", "The task delegation limit has been reached");
    }

    const dispatched = isNodeConnected(target.computeNodeId);
    const child: Run = {
      id: newId("run"), threadId: thread.id, agentId: target.id, nodeId: target.computeNodeId, harnessId: target.harnessId,
      model: target.model, workspace: target.workspace,
      prompt: `Delegated by ${sender.name}: ${task}${attachedArtifacts.length ? `\n\nRelevant artifacts: ${attachedArtifacts.map((artifact) => `${artifact!.title} (${artifact!.downloadPath})`).join(", ")}` : ""}`,
      status: "queued", output: "", depth: source.depth + 1, parentRunId: source.id,
      dispatchedAt: dispatched ? at : undefined, createdAt: at
    };
    const delegation: Delegation = {
      id: newId("dlg"), threadId: thread.id, parentRunId: source.id, childRunId: child.id, fromAgentId: sender.id,
      toAgentId: target.id, task, idempotencyKey, artifactIds, createdAt: at
    };
    state.runs.unshift(child);
    state.delegations.unshift(delegation);
    target.state = dispatched ? "thinking" : "waiting";
    target.currentAction = dispatched ? "Starting delegated work" : "Waiting for compute";
    target.updatedAt = at;
    thread.updatedAt = at;
    state.events.unshift(newEvent({ type: "handoff", title: `${sender.name} delegated to ${target.name}`, detail: task, threadId: thread.id, fromAgentId: sender.id, toAgentId: target.id, runId: child.id }));
    state.messages.push(newMessage({ agentId: target.id, author: "system", body: `Delegated by ${sender.name}: ${task}`, kind: "handoff", threadId: thread.id, runId: child.id }));
    result = { run: child, agent: target, created: true, dispatched };
  });
  if (!result) throw new CoordinationError("persistence_failed", "The delegated task was not created", true);
  return result;
}

export async function createArtifact(store: Store, sourceRunId: string, argumentsValue: unknown, at = new Date().toISOString()) {
  const values = record(argumentsValue);
  const relativePath = requiredString(values, "relativePath", 1_024);
  const title = requiredString(values, "title", 256);
  const kind = requiredString(values, "kind", 64);
  const mediaType = requiredString(values, "mediaType", 128);
  const summary = typeof values.summary === "string" ? values.summary.trim().slice(0, 2_000) : "";
  const sha256 = requiredString(values, "sha256", 64);
  const idempotencyKey = requiredString(values, "idempotencyKey", 128);
  const size = values.size;
  if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(relativePath) || relativePath.split(/[\\/]+/).includes("..")) {
    throw new CoordinationError("invalid_arguments", "relativePath must stay within the run workspace");
  }
  if (!(artifactKinds as readonly string[]).includes(kind)) throw new CoordinationError("invalid_arguments", "kind is not recognized");
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > 10 * 1024 * 1024) throw new CoordinationError("invalid_arguments", "size must be at most 10 MiB");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new CoordinationError("invalid_arguments", "sha256 must be a lowercase SHA-256 digest");
  let artifact: Artifact | undefined;
  await store.transact((state) => {
    state.artifacts ??= [];
    const source = state.runs.find((run) => run.id === sourceRunId);
    if (!source || source.status !== "running") throw new CoordinationError("run_not_active", "The source task is not running");
    const thread = source.threadId && state.threads?.find((item) => item.id === source.threadId);
    if (!thread) throw new CoordinationError("not_found", "The source task is not attached to a thread");
    if (thread.status !== "active") throw new CoordinationError("thread_inactive", "Artifacts require an active thread");
    artifact = state.artifacts.find((item) => item.runId === source.id && item.idempotencyKey === idempotencyKey);
    if (artifact) {
      if (artifact.relativePath !== relativePath || artifact.title !== title || artifact.kind !== kind || artifact.mediaType !== mediaType || artifact.size !== size || artifact.sha256 !== sha256) {
        throw new CoordinationError("idempotency_conflict", "The idempotency key was already used with different artifact metadata");
      }
      return false;
    }
    artifact = {
      id: newId("artifact"), threadId: thread.id, runId: source.id, agentId: source.agentId, relativePath, title,
      kind: kind as Artifact["kind"], mediaType, summary, size, sha256,
      downloadPath: "", uploaded: false, idempotencyKey, createdAt: at
    };
    artifact.downloadPath = `/api/artifacts/${encodeURIComponent(artifact.id)}/content`;
    state.artifacts.unshift(artifact);
    thread.updatedAt = at;
    state.events.unshift(newEvent({ type: "status", title: "Artifact registered", detail: `${title} · ${size} bytes`, threadId: thread.id, agentId: source.agentId, runId: source.id }));
  });
  if (!artifact) throw new CoordinationError("persistence_failed", "The artifact was not registered", true);
  return { artifact, uploadPath: artifact.downloadPath };
}
