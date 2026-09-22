import {
  canTransitionRun,
  isActiveRunStatus,
  isTerminalTaskStatus,
  supportsControlCapability,
  validateRunTransportSelection,
  type ControlAgentToHub,
  type ControlProtocolVersion,
  type HubToControlAgent,
  type Run,
  type RunTransportSelection,
  type Snapshot
} from "@coffee-shop/protocol";
import { isContinuationRun } from "./continuationRuns.js";
import { settleHarnessStateForTerminalRun } from "./harnessEvents.js";
import { newEvent, newMessage, type State, type Store } from "./store.js";
import { applyAttemptOutcome, cancelTaskInState, type TaskCancellationResult } from "./tasks.js";

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
  let stopped = false;
  return (value: T) => {
    queue = queue.then(async () => {
      if (!stopped) await handler(value);
    }).catch((error) => {
      stopped = true;
      onError(error);
    });
    return queue;
  };
}

/**
 * Runs `operation` for every request without overlapping itself: a request made while a run is in
 * progress schedules exactly one more run after it, so bursts of triggers collapse into one pass.
 * An error ends the current burst and is reported; the next request starts afresh.
 */
export function coalesceAsync(operation: () => Promise<void>, onError: (error: unknown) => void) {
  let running: Promise<void> | undefined;
  let requestedAgain = false;
  const loop = async () => {
    try {
      do {
        requestedAgain = false;
        await operation();
      } while (requestedAgain);
    } catch (error) {
      onError(error);
    } finally {
      running = undefined;
    }
  };
  return () => {
    if (running) {
      requestedAgain = true;
      return running;
    }
    running = loop();
    return running;
  };
}

export async function retryAsync<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let failure: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      failure = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  throw failure;
}

/**
 * Queued runs to redispatch after a reconnect barrier. A task attempt is included only while it is
 * still its task's current, non-terminal assignment, so a replay can never resurrect cancelled or
 * superseded work.
 */
export function queuedRunsForNode(snapshot: Snapshot, nodeId: string, activeRunIds: readonly string[], protocolVersion: ControlProtocolVersion) {
  if (!supportsControlCapability(protocolVersion, "replay-barrier")) return [];
  const active = new Set(activeRunIds);
  const currentAttempt = (run: Run) => run.taskId === undefined || (snapshot.tasks ?? []).some((task) =>
    task.id === run.taskId && task.assignment?.runId === run.id && !isTerminalTaskStatus(task.status));
  return snapshot.runs.filter((run) => run.nodeId === nodeId && run.status === "queued" && !active.has(run.id) && currentAttempt(run));
}

/** A task is failed rather than retried once this many attempts have been lost. */
export const maximumTaskAttempts = 3;
export const lostComputeError = "Compute lost: Barista no longer reports this attempt as active";

/**
 * Runs after a version-4 reconnect barrier, once Barista has replayed every queued lifecycle
 * message. A running task attempt that Barista no longer supervises can never report again, so it
 * fails and, within the attempt budget, its task returns to `ready` for a new attempt. A lost
 * orchestrator continuation fails the same way, and its unacknowledged inbox range is offered to
 * the next continuation. Queued runs are left for redispatch; they never started, so resending the
 * same run is safe.
 */
export function failLostTaskAttempts(state: State, nodeId: string, activeRunIds: readonly string[], at: string) {
  const active = new Set(activeRunIds);
  const lost: Run[] = [];
  for (const run of state.runs) {
    if (run.nodeId !== nodeId || (run.taskId === undefined && !isContinuationRun(state, run.id)) || run.status !== "running" || active.has(run.id)) continue;
    run.status = "failed";
    run.error = lostComputeError;
    run.finishedAt = at;
    const task = state.tasks?.find((item) => item.id === run.taskId);
    state.messages.push(newMessage({ agentId: run.agentId, author: "system", body: `Run failed: ${lostComputeError}`, kind: "status", threadId: run.threadId, runId: run.id }));
    state.events.unshift(newEvent({ type: "status", title: "Compute lost", detail: `Run ${run.id} was no longer active on ${nodeId}`, threadId: run.threadId, agentId: run.agentId, runId: run.id }));
    updateAgentAfterRunEnded(state, run, at);
    settleHarnessStateForTerminalRun(state, run.id, at);
    applyAttemptOutcome(state, run.id, at, { retryable: (task?.attemptRunIds.length ?? maximumTaskAttempts) < maximumTaskAttempts });
    lost.push(run);
  }
  return lost;
}

function activeRunForAgent(state: State, agentId: string, excludedRunId: string) {
  return state.runs
    .filter((run) => run.agentId === agentId && run.id !== excludedRunId && isActiveRunStatus(run.status))
    .sort((left, right) => {
      if (left.status !== right.status) return left.status === "running" ? -1 : 1;
      return right.createdAt.localeCompare(left.createdAt);
    })[0];
}

function updateAgentAfterRunEnded(state: State, endedRun: Run, at: string) {
  const agent = state.agents.find((item) => item.id === endedRun.agentId);
  if (!agent) return;
  const active = activeRunForAgent(state, agent.id, endedRun.id);
  if (!active) {
    agent.state = "idle";
    agent.currentAction = "Available";
  } else if (active.status === "running") {
    agent.state = "working";
    agent.currentAction = active.output.trim().slice(-90) || "Working";
  } else {
    const dispatched = Boolean(active.dispatchedAt);
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
    threadId: run.threadId,
    agentId: run.agentId,
    runId: run.id
  }));
  const thread = run.threadId ? state.threads?.find((item) => item.id === run.threadId) : undefined;
  if (thread) thread.updatedAt = at;
  updateAgentAfterRunEnded(state, run, at);
  settleHarnessStateForTerminalRun(state, run.id, at);
  applyAttemptOutcome(state, run.id, at);
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
  const cancelledRuns: Run[] = [];
  await store.transact((state) => {
    result = cancelRunInState(state, runId, at);
    if (result.kind !== "cancelled" || !result.run) return false;
    cancelledRuns.push(result.run);
    const pendingParents = [result.run.id];
    while (pendingParents.length) {
      const parentRunId = pendingParents.shift()!;
      for (const child of state.runs.filter((run) => run.parentRunId === parentRunId)) {
        pendingParents.push(child.id);
        if (!isActiveRunStatus(child.status)) continue;
        const childResult = cancelRunInState(state, child.id, at);
        if (childResult.kind === "cancelled" && childResult.run) cancelledRuns.push(childResult.run);
      }
    }
    return true;
  });
  for (const cancelled of cancelledRuns) {
    send(cancelled.nodeId, { type: "cancel", runId: cancelled.id });
  }
  return result;
}

/**
 * Cancels a task and, in the same transaction, its active attempt run. Cancel delivery to Barista
 * happens only after the terminal state is persisted.
 */
export async function cancelPersistedTask(
  store: Store,
  taskId: string,
  send: (nodeId: string, message: HubToControlAgent) => boolean,
  at = new Date().toISOString()
) {
  let result: TaskCancellationResult = { kind: "not-found" };
  const cancelledRuns: Run[] = [];
  await store.transact((state) => {
    result = cancelTaskInState(state, taskId, at);
    if (result.kind !== "cancelled") return false;
    if (result.activeAttemptRunId) {
      const attempt = cancelRunInState(state, result.activeAttemptRunId, at);
      if (attempt.kind === "cancelled" && attempt.run) cancelledRuns.push(attempt.run);
    }
    return true;
  });
  for (const cancelled of cancelledRuns) {
    send(cancelled.nodeId, { type: "cancel", runId: cancelled.id });
  }
  return result;
}

/**
 * The transport selection a `run.started` reports, when it is well formed and consistent with the
 * dispatch: it must name the run's requested transport, and may select another one only when the
 * run permitted that fallback.
 */
export function acceptedTransportSelection(run: Run, reported: unknown): RunTransportSelection | undefined {
  const validated = validateRunTransportSelection(reported);
  if (!validated.ok) return undefined;
  const selection = validated.value;
  if (selection.requestedTransport !== (run.transport ?? "native-cli")) return undefined;
  if (selection.selectedTransport !== selection.requestedTransport && run.fallbackTransport !== selection.selectedTransport) return undefined;
  return selection;
}

/**
 * Only the node a run was dispatched to may report its lifecycle; another socket could otherwise
 * rewrite its output or attach a provider session the operator is invited to resume.
 */
export function isReportedByOwningNode(run: Pick<Run, "nodeId"> | undefined, reportingNodeId: string): run is Pick<Run, "nodeId"> {
  return run !== undefined && reportingNodeId !== "" && run.nodeId === reportingNodeId;
}

/** A vendor session identity as Claude and Codex issue them: short, opaque, and shell-safe. */
function isProviderSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

export function applyRunLifecycle(state: State, message: RunLifecycleMessage) {
  if (!runLifecycleMessageTypes.has(message.type)) return false;
  const run = state.runs.find((item) => item.id === message.runId);
  if (!run) return false;
  if (typeof message.at !== "string") return false;
  // A native run reports its provider session on a run.output that carries no text.
  if (message.type === "run.output" && !(typeof message.chunk === "string" || (message.chunk === undefined && message.providerSessionId !== undefined))) return false;
  if (message.type === "run.completed" && typeof message.output !== "string") return false;
  if (message.type === "run.failed" && typeof message.error !== "string") return false;
  if (message.type === "run.cancelled") return false;
  if (run.status === "cancelled") return false;
  const agent = state.agents.find((item) => item.id === run.agentId);
  if (!agent) return false;
  const thread = run.threadId ? state.threads?.find((item) => item.id === run.threadId) : undefined;

  if (message.type === "run.started") {
    if (!canTransitionRun(run.status, "running")) return false;
    run.status = "running";
    run.startedAt = message.at;
    agent.state = "working";
    agent.currentAction = "Working";
    if (message.transport !== undefined) {
      const selection = acceptedTransportSelection(run, message.transport);
      if (selection) {
        run.transportSelection = selection;
        if (selection.fallbackReason) {
          state.events.unshift(newEvent({
            type: "status", title: `${agent.name} fell back to the native CLI`,
            detail: `Requested ${selection.requestedTransport}; ${selection.fallbackReason} before the prompt was sent.`,
            threadId: run.threadId, agentId: agent.id, runId: run.id
          }));
        }
      } else {
        state.events.unshift(newEvent({
          type: "status", title: `${agent.name}'s compute reported an unexpected transport`,
          detail: "The transport selection was malformed or not permitted by the dispatch and was not recorded.",
          threadId: run.threadId, agentId: agent.id, runId: run.id
        }));
      }
    }
  } else if (message.type === "run.output") {
    if (run.status !== "running") return false;
    const chunk = message.chunk ?? "";
    run.output += chunk;
    if (chunk.trim()) agent.currentAction = chunk.trim().slice(-90);
    const selectedTransport = run.transportSelection?.selectedTransport ?? run.transport ?? "native-cli";
    if (selectedTransport === "native-cli" && run.providerSessionId === undefined && isProviderSessionId(message.providerSessionId)) {
      run.providerSessionId = message.providerSessionId;
    }
  } else if (message.type === "run.completed") {
    if (!canTransitionRun(run.status, "completed")) return false;
    run.status = "completed";
    run.output = message.output;
    run.finishedAt = message.at;
    agent.state = "done";
    agent.currentAction = "Completed just now";
    state.messages.push(newMessage({ agentId: agent.id, author: "agent", body: message.output || "Completed.", kind: "message", threadId: run.threadId, runId: run.id }));
    state.events.unshift(newEvent({ type: "status", title: `${agent.name} finished`, detail: run.prompt.slice(0, 120), threadId: run.threadId, agentId: agent.id, runId: run.id }));
  } else {
    if (!canTransitionRun(run.status, "failed")) return false;
    run.status = "failed";
    run.error = message.error;
    run.finishedAt = message.at;
    agent.state = "blocked";
    agent.currentAction = message.error.slice(0, 90);
    state.messages.push(newMessage({ agentId: agent.id, author: "system", body: `Run failed: ${message.error}`, kind: "status", threadId: run.threadId, runId: run.id }));
  }
  agent.updatedAt = message.at;
  if (thread) thread.updatedAt = message.at;
  if (message.type === "run.completed" || message.type === "run.failed") settleHarnessStateForTerminalRun(state, run.id, message.at);
  if (message.type !== "run.output") applyAttemptOutcome(state, run.id, message.at);
  return true;
}
