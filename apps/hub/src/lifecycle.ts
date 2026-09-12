import {
  canTransitionRun,
  isActiveRunStatus,
  type ControlAgentToHub,
  type HubToControlAgent,
  type Run,
  type Snapshot
} from "@coffee-shop/protocol";
import { newEvent, newMessage, type State, type Store } from "./store.js";

type RunLifecycleMessage = Extract<ControlAgentToHub, { type: `run.${string}` }>;
const runLifecycleMessageTypes = new Set<string>([
  "run.started", "run.output", "run.completed", "run.failed", "run.cancelled"
]);

export interface CancellationResult {
  kind: "cancelled" | "already-cancelled" | "not-found" | "conflict";
  run?: Run;
}

export function serializeAsync<T>(handler: (value: T) => Promise<void>, onError: (error: unknown) => void) {
  let queue = Promise.resolve();
  return (value: T) => {
    queue = queue.then(() => handler(value)).catch(onError);
    return queue;
  };
}

export function queuedRunsForNode(snapshot: Snapshot, nodeId: string, activeRunIds: readonly string[]) {
  const active = new Set(activeRunIds);
  return snapshot.runs.filter((run) => run.nodeId === nodeId && run.status === "queued" && !active.has(run.id));
}

function activeRunForAgent(state: State, agentId: string, excludedRunId: string) {
  return state.runs
    .filter((run) => run.agentId === agentId && run.id !== excludedRunId && isActiveRunStatus(run.status))
    .sort((left, right) => {
      if (left.status !== right.status) return left.status === "running" ? -1 : 1;
      return right.createdAt.localeCompare(left.createdAt);
    })[0];
}

function updateAgentAfterCancellation(state: State, cancelledRun: Run, at: string) {
  const agent = state.agents.find((item) => item.id === cancelledRun.agentId);
  if (!agent) return;
  const active = activeRunForAgent(state, agent.id, cancelledRun.id);
  if (!active) {
    agent.state = "idle";
    agent.currentAction = "Available";
  } else if (active.status === "running") {
    agent.state = "working";
    agent.currentAction = active.output.trim().slice(-90) || "Working";
  } else {
    const node = state.nodes.find((item) => item.id === active.nodeId);
    const dispatched = node?.status === "online" || node?.status === "busy";
    agent.state = dispatched ? "thinking" : "waiting";
    agent.currentAction = dispatched ? "Starting work" : "Waiting for compute";
  }
  agent.updatedAt = at;
}

export function cancelRunInState(state: State, runId: string, at: string): CancellationResult {
  const run = state.runs.find((item) => item.id === runId);
  if (!run) return { kind: "not-found" };
  if (run.status === "cancelled") return { kind: "already-cancelled", run };
  if (!canTransitionRun(run.status, "cancelled")) return { kind: "conflict", run };

  run.status = "cancelled";
  run.finishedAt = at;
  state.events.unshift(newEvent({
    type: "status",
    title: "Run cancelled",
    detail: `Run ${run.id} was cancelled`,
    agentId: run.agentId,
    runId: run.id
  }));
  updateAgentAfterCancellation(state, run, at);
  return { kind: "cancelled", run };
}

export async function cancelPersistedRun(
  store: Store,
  runId: string,
  send: (nodeId: string, message: HubToControlAgent) => boolean,
  at = new Date().toISOString()
) {
  const existing = store.getRun(runId);
  if (!existing) return { kind: "not-found" } satisfies CancellationResult;
  if (existing.status === "cancelled") return { kind: "already-cancelled", run: existing } satisfies CancellationResult;
  if (!canTransitionRun(existing.status, "cancelled")) return { kind: "conflict", run: existing } satisfies CancellationResult;
  let result: CancellationResult = { kind: "not-found" };
  await store.transact((state) => {
    result = cancelRunInState(state, runId, at);
    return result.kind === "cancelled";
  });
  if (result.kind === "cancelled" && result.run) {
    send(result.run.nodeId, { type: "cancel", runId: result.run.id });
  }
  return result;
}

export function applyRunLifecycle(state: State, message: RunLifecycleMessage) {
  if (!runLifecycleMessageTypes.has(message.type)) return false;
  const run = state.runs.find((item) => item.id === message.runId);
  if (!run) return false;
  if (typeof message.at !== "string") return false;
  if (message.type === "run.output" && typeof message.chunk !== "string") return false;
  if (message.type === "run.completed" && typeof message.output !== "string") return false;
  if (message.type === "run.failed" && typeof message.error !== "string") return false;
  if (message.type === "run.cancelled") return false;
  if (run.status === "cancelled") return false;
  const agent = state.agents.find((item) => item.id === run.agentId);
  if (!agent) return false;

  if (message.type === "run.started") {
    if (!canTransitionRun(run.status, "running")) return false;
    run.status = "running";
    run.startedAt = message.at;
    agent.state = "working";
    agent.currentAction = "Working";
  } else if (message.type === "run.output") {
    if (run.status !== "running") return false;
    run.output += message.chunk;
    agent.currentAction = message.chunk.trim().slice(-90) || "Working";
  } else if (message.type === "run.completed") {
    if (!canTransitionRun(run.status, "completed")) return false;
    run.status = "completed";
    run.output = message.output;
    run.finishedAt = message.at;
    agent.state = "done";
    agent.currentAction = "Completed just now";
    state.messages.push(newMessage({ agentId: agent.id, author: "agent", body: message.output || "Completed.", kind: "message", runId: run.id }));
    state.events.unshift(newEvent({ type: "status", title: `${agent.name} finished`, detail: run.prompt.slice(0, 120), agentId: agent.id, runId: run.id }));
  } else {
    if (!canTransitionRun(run.status, "failed")) return false;
    run.status = "failed";
    run.error = message.error;
    run.finishedAt = message.at;
    agent.state = "blocked";
    agent.currentAction = message.error.slice(0, 90);
    state.messages.push(newMessage({ agentId: agent.id, author: "system", body: `Run failed: ${message.error}`, kind: "status", runId: run.id }));
  }
  agent.updatedAt = message.at;
  return true;
}
