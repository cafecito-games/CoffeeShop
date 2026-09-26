import { createHash } from "node:crypto";
import {
  artifactKinds,
  isTerminalTaskStatus,
  orchestrationToolLimits,
  type Artifact,
  type PlacementOverride,
  type Run,
  type Task,
  type TaskProgress
} from "@coffee-shop/protocol";
import { CoordinationError } from "./coordinationError.js";
import { listThreadInstances } from "./instances.js";
import {
  assertVisibleArtifacts,
  callerAgent,
  callerAttribution,
  callerCanDelegate,
  callerInstance,
  mailboxSummary,
  notVisible,
  requireCallerRun,
  resolveCaller,
  resolveCallerFor,
  runSource,
  taskVisibility,
  type CallerSource
} from "./mailbox.js";
import { staticPlacementFailures } from "./scheduler.js";
import { newEvent, newId, type State, type Store, type TaskUpdateRecord } from "./store.js";
import { submitTaskBatchForSource, taskContextProjection, type TaskBatchResult } from "./tasks.js";
import { threadTitleFromObjective } from "./threads.js";

export { CoordinationError } from "./coordinationError.js";

export const maxDelegationDepth = 3;
export const maxChildrenPerRun = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new CoordinationError("invalid_arguments", "Tool arguments must be an object");
  return value;
}

function onlyKeys(values: Record<string, unknown>, keys: readonly string[], context: string) {
  if (Object.keys(values).some((key) => !keys.includes(key))) throw new CoordinationError("invalid_arguments", `${context} contains an unknown field`);
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

function relatedRun(state: Readonly<State>, sourceRunId: string, requestedRunId: string) {
  if (sourceRunId === requestedRunId) return true;
  const parents = new Map(state.runs.map((run) => [run.id, run.parentRunId]));
  const reaches = (from: string, target: string) => {
    const seen = new Set<string>();
    for (let cursor: string | undefined = from; cursor && !seen.has(cursor); cursor = parents.get(cursor)) {
      if (cursor === target) return true;
      seen.add(cursor);
    }
    return false;
  };
  return reaches(requestedRunId, sourceRunId) || reaches(sourceRunId, requestedRunId);
}

/** Source tasks and legacy delegations a run has created, the quantity fan-out limits bound. */
function createdBy(state: Readonly<State>, runId: string) {
  return (state.tasks ?? []).filter((task) => task.sourceRunId === runId).length
    + (state.delegations ?? []).filter((delegation) => delegation.parentRunId === runId).length;
}

/** A bounded summary of one task for graphs and child lists. */
function taskSummary(state: Readonly<State>, task: Task) {
  const source = task.sourceRunId === undefined ? undefined : state.runs.find((run) => run.id === task.sourceRunId);
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    ...(source?.taskId !== undefined ? { parentTaskId: source.taskId } : {}),
    dependencies: task.dependencies.map((dependency) => ({ ...dependency })),
    ...(task.assignment ? {
      ...(task.assignment.agentId === undefined ? {} : { assignedAgentId: task.assignment.agentId }),
      ...(task.assignment.instanceId === undefined ? {} : { assignedInstanceId: task.assignment.instanceId }),
      assignedNodeId: task.assignment.nodeId
    } : {}),
    attempts: task.attemptRunIds.length,
    ...(task.progress?.summary !== undefined ? { progress: task.progress.summary } : {}),
    ...(task.progress?.blockedReason !== undefined ? { blockedReason: task.progress.blockedReason } : {}),
    ...(task.placement?.unsatisfied.length ? { unsatisfiedRequirements: task.placement.unsatisfied.length } : {}),
    updatedAt: task.updatedAt
  };
}

/**
 * The durable context visible to the calling run. With no arguments it describes the caller; with
 * a `taskId` it describes a durable task the caller may read, or, for older callers, a run in the
 * caller's run lineage. Anything outside that scope is reported as not found, whether or not it
 * exists.
 */
export function taskContext(state: Readonly<State>, sourceRunId: string, argumentsValue: unknown, at = new Date().toISOString()) {
  const values = record(argumentsValue);
  onlyKeys(values, ["taskId"], "get_task_context arguments");
  const caller = resolveCaller(state, sourceRunId);
  const { run: callingRun } = requireCallerRun(caller, "get_task_context is served only to a hub-hosted run");
  const callerDelegates = callerCanDelegate(caller);
  const callingAgent = callerAgent(caller);
  const callingInstance = callerInstance(caller);
  const visibility = taskVisibility(state, caller);
  const runs = new Map(state.runs.map((run) => [run.id, run]));
  let focusRun: Run | undefined = callingRun;
  let focusTask: Task | undefined = caller.task;
  if (values.taskId !== undefined) {
    const requested = requiredString(values, "taskId", orchestrationToolLimits.idempotencyKeyLength);
    const task = state.tasks?.find((item) => item.id === requested && item.threadId === caller.thread.id && visibility.readable.has(item.id));
    if (task) {
      focusTask = task;
      const attemptRunId = task.assignment?.runId ?? task.attemptRunIds.at(-1);
      focusRun = attemptRunId === undefined ? undefined : runs.get(attemptRunId);
    } else {
      const run = runs.get(requested);
      if (!run || run.threadId !== caller.thread.id || !relatedRun(state, callingRun.id, run.id)) throw notVisible();
      focusRun = run;
      focusTask = run.taskId === undefined ? undefined : state.tasks?.find((item) => item.id === run.taskId && visibility.readable.has(item.id));
    }
  }
  const children = focusRun ? state.runs.filter((item) => item.parentRunId === focusRun!.id && item.taskId === undefined) : [];
  const delegationByChild = new Map((state.delegations ?? []).filter((item) => item.parentRunId === focusRun?.id).map((item) => [item.childRunId, item]));
  const ownRunIds = new Set(focusTask ? focusTask.attemptRunIds : focusRun ? [focusRun.id] : []);
  const visibleTasks = (state.tasks ?? []).filter((task) => task.threadId === caller.thread.id && visibility.readable.has(task.id));
  const limitRun = focusRun ?? callingRun;
  const createdByLimitRun = createdBy(state, limitRun.id);
  return {
    thread: {
      id: caller.thread.id,
      title: caller.thread.title,
      objective: caller.thread.objective,
      summary: caller.thread.summary,
      status: caller.thread.status,
      ownerAgentId: caller.thread.ownerAgentId,
      updatedAt: caller.thread.updatedAt
    },
    caller: {
      runId: callingRun.id,
      ...(caller.task ? { taskId: caller.task.id } : {}),
      role: caller.participant?.type ?? "run",
      canDelegate: callerDelegates
    },
    task: focusRun ? {
      id: focusRun.id,
      status: focusRun.status,
      // Mixed history stays interpretable: whichever identity the run carries is the one reported.
      ...(focusRun.agentId === undefined ? {} : { agentId: focusRun.agentId }),
      ...(focusRun.instanceId === undefined ? {} : { instanceId: focusRun.instanceId }),
      objective: focusRun.prompt,
      depth: focusRun.depth,
      parentTaskId: focusRun.parentRunId,
      output: focusRun.status === "completed" ? focusRun.output.slice(0, 8_000) : undefined,
      error: focusRun.error
    } : {
      id: focusTask!.id,
      status: focusTask!.status,
      objective: focusTask!.instructions,
      output: focusTask!.result?.slice(0, 8_000),
      error: focusTask!.error
    },
    ...(focusTask ? { durableTask: taskContextProjection(state, caller.thread.id, focusTask.id) } : {}),
    childTasks: visibleTasks
      .filter((task) => task.sourceRunId !== undefined && ownRunIds.has(task.sourceRunId))
      .slice(0, orchestrationToolLimits.contextTasks)
      .map((task) => taskSummary(state, task)),
    taskGraph: visibleTasks.slice(0, orchestrationToolLimits.contextTasks).map((task) => taskSummary(state, task)),
    taskGraphTruncated: visibleTasks.length > orchestrationToolLimits.contextTasks,
    delegations: children.map((child) => ({
      taskId: child.id,
      delegationId: delegationByChild.get(child.id)?.id,
      ...(child.agentId === undefined ? {} : { agentId: child.agentId }),
      ...(child.instanceId === undefined ? {} : { instanceId: child.instanceId }),
      status: child.status,
      summary: child.status === "completed" ? child.output.slice(0, 2_000) : child.error
    })),
    mailbox: mailboxSummary(state, caller),
    artifacts: (state.artifacts ?? [])
      .filter((artifact) => artifact.uploaded && artifact.threadId === caller.thread.id)
      .slice(0, 16),
    /*
     * The teammate directory. An instance caller sees only the live residents of its own thread — the
     * principals it may actually coordinate with — and never the global configured roster. A legacy
     * agent caller keeps seeing the configured roster it has always seen.
     */
    availableAgents: callerDelegates && callingAgent !== undefined ? state.agents
      .filter((agent) => agent.id !== callingAgent.id)
      .map((agent) => ({ id: agent.id, title: agent.title, state: agent.state })) : [],
    availableInstances: callerDelegates && callingInstance !== undefined
      ? listThreadInstances(state, caller.thread.id, false).instances
        .filter((instance) => instance.id !== callingInstance.instance.id)
        .map((instance) => ({ id: instance.id, title: instance.purpose?.title ?? instance.purpose?.name ?? instance.id, status: instance.status }))
      : [],
    limits: {
      maxDepth: maxDelegationDepth,
      remainingDepth: Math.max(0, maxDelegationDepth - limitRun.depth),
      maxChildren: maxChildrenPerRun,
      remainingChildren: Math.max(0, maxChildrenPerRun - createdByLimitRun),
      maxTasksPerRun: orchestrationToolLimits.tasksPerSourceRun,
      remainingTasks: Math.max(0, orchestrationToolLimits.tasksPerSourceRun - createdByLimitRun),
      maximumWaitMilliseconds: orchestrationToolLimits.maximumWaitMilliseconds,
      maximumEventsPerWait: orchestrationToolLimits.maximumEventsPerWait,
      messageBodyLength: orchestrationToolLimits.messageBodyLength
    },
    version: at
  };
}

function normalizePin(value: unknown, context: string): PlacementOverride {
  if (!isRecord(value)) throw new CoordinationError("invalid_arguments", `${context} must be an object`);
  onlyKeys(value, ["agentId", "nodeId"], context);
  const pin: PlacementOverride = { authorizedBy: "policy" };
  if (value.agentId !== undefined) pin.agentId = requiredString(value, "agentId", orchestrationToolLimits.idempotencyKeyLength);
  if (value.nodeId !== undefined) pin.nodeId = requiredString(value, "nodeId", orchestrationToolLimits.idempotencyKeyLength);
  if (pin.agentId === undefined && pin.nodeId === undefined) throw new CoordinationError("invalid_arguments", `${context} must name an agentId or nodeId`);
  return pin;
}

/**
 * `submit_tasks`: an atomic task batch through the task graph. An optional per-task `pin` is the
 * separately authorized placement path: it is accepted only from an agent allowed to delegate,
 * becomes a policy-authorized placement override that narrows scheduler candidates without
 * bypassing any hard requirement, and is part of the batch's idempotency identity.
 */
export const submitTasks = (store: Store, sourceRunId: string, argumentsValue: unknown, at = new Date().toISOString()) =>
  submitTasksForSource(store, runSource(sourceRunId), argumentsValue, at);

/**
 * `submit_tasks` for either principal. An external orchestrator submits at the root of its own
 * thread: it has no run lineage, so the per-run depth and fan-out bounds that govern a delegating
 * worker do not apply to it, exactly as they do not apply across a hub orchestrator's successive
 * continuation runs.
 */
export async function submitTasksForSource(store: Store, source: CallerSource, argumentsValue: unknown, at = new Date().toISOString()): Promise<TaskBatchResult> {
  const values = record(argumentsValue);
  const placementOverrides: Record<string, PlacementOverride> = {};
  let batch: unknown = values;
  if (Array.isArray(values.tasks)) {
    batch = {
      ...values,
      tasks: values.tasks.map((item: unknown, index) => {
        if (!isRecord(item) || item.pin === undefined) return item;
        const { pin, ...task } = item;
        const override = normalizePin(pin, `tasks[${index}].pin`);
        if (typeof task.key === "string") placementOverrides[task.key.trim()] = override;
        return task;
      })
    };
  }
  return submitTaskBatchForSource(store, source, batch, at, {
    placementOverrides,
    ...(source.kind === "run" ? { maximumSourceTasks: orchestrationToolLimits.tasksPerSourceRun, maximumSourceDepth: maxDelegationDepth } : {})
  });
}

export interface DelegationResult {
  taskId: string;
  status: string;
  agentId: string;
  created: boolean;
  task?: Task;
}

const ineligibleTarget = () => new CoordinationError("target_ineligible", "The target agent cannot run delegated work with its current configuration");

/**
 * Rejects a legacy delegation target that could never be placed: a missing agent, the caller
 * itself, or an agent whose harness, model, transport, or workspace its node does not support.
 * A target that is only offline, busy, or awaiting fresh evidence stays eligible and is queued.
 */
function assertEligibleTarget(state: Readonly<State>, sourceRunId: string, targetAgentId: string, probe: Task) {
  const source = state.runs.find((run) => run.id === sourceRunId);
  const target = state.agents.find((agent) => agent.id === targetAgentId);
  if (!source || !target || target.id === source.agentId) throw ineligibleTarget();
  const failures = staticPlacementFailures(probe, target, {
    agents: state.agents,
    nodes: state.nodes,
    runs: state.runs,
    // Static requirement kinds never depend on the connection, evidence, or profiles.
    connection: () => undefined,
    capabilityReport: () => undefined,
    projectProfile: () => undefined,
    now: new Date().toISOString()
  });
  if (failures.length) throw ineligibleTarget();
}

const legacyIdempotencyKey = (key: string) => `delegate_task:${createHash("sha256").update(key).digest("hex").slice(0, 48)}`;

/**
 * Legacy `delegate_task`: one task pinned to the named agent, submitted through the same task
 * graph and scheduler as `submit_tasks`, under the historical depth and fan-out limits. It never
 * creates a run directly; the scheduler decides whether the pinned agent is currently eligible.
 */
export async function delegateTask(store: Store, sourceRunId: string, argumentsValue: unknown, at = new Date().toISOString()): Promise<DelegationResult> {
  const values = record(argumentsValue);
  onlyKeys(values, ["agentId", "task", "idempotencyKey", "artifactIds"], "delegate_task arguments");
  const targetAgentId = requiredString(values, "agentId", 128);
  const instructions = requiredString(values, "task", 8_000);
  const idempotencyKey = requiredString(values, "idempotencyKey", 128);
  const artifactIds = stringArray(values, "artifactIds", 16);
  const preflight = store.read((state) => {
    const caller = resolveCaller(state, sourceRunId);
    const { run } = requireCallerRun(caller, "delegate_task is served only to a hub-hosted run");
    if (!callerCanDelegate(caller)) throw new CoordinationError("forbidden", "This agent is not allowed to delegate tasks");
    const legacy = (state.delegations ?? []).find((item) => item.parentRunId === run.id && item.idempotencyKey === idempotencyKey);
    if (legacy) {
      if (legacy.toAgentId !== targetAgentId || legacy.task !== instructions || JSON.stringify(legacy.artifactIds ?? []) !== JSON.stringify(artifactIds)) {
        throw new CoordinationError("idempotency_conflict", "The idempotency key was already used with different arguments");
      }
      const child = state.runs.find((run) => run.id === legacy.childRunId);
      if (!child) throw new CoordinationError("inconsistent_state", "The prior delegated task is unavailable", true);
      return { kind: "legacy" as const, result: { taskId: child.id, status: child.status, agentId: legacy.toAgentId, created: false } };
    }
    const attached = artifactIds.map((id) => state.artifacts?.find((artifact) => artifact.id === id && artifact.runId === run.id && artifact.uploaded));
    if (attached.some((artifact) => !artifact)) throw new CoordinationError("invalid_artifact", "Every attached artifact must be uploaded by the source task");
    return { kind: "submit" as const, attached: attached as Artifact[] };
  });
  if (preflight.kind === "legacy") return preflight.result;
  const references = preflight.attached.map((artifact) => `${artifact.title} (${artifact.downloadPath})`).join(", ");
  const delegated = { key: "delegated", title: threadTitleFromObjective(instructions), instructions: references ? `${instructions}\n\nRelevant artifacts: ${references}` : instructions };
  const placementOverride: PlacementOverride = { agentId: targetAgentId, authorizedBy: "policy" };
  const probe: Task = {
    id: "delegation-probe", threadId: "", title: delegated.title, instructions: delegated.instructions, status: "ready",
    requirements: {}, dependencies: [], placementOverride, idempotencyKey: "", attemptRunIds: [], createdAt: at, updatedAt: at
  };
  const submitted = await submitTaskBatchForSource(store, runSource(sourceRunId), {
    idempotencyKey: legacyIdempotencyKey(idempotencyKey),
    tasks: [delegated]
  }, at, {
    placementOverrides: { delegated: placementOverride },
    maximumSourceTasks: maxChildrenPerRun,
    maximumSourceDepth: maxDelegationDepth,
    assertAcceptable: (state, runId) => assertEligibleTarget(state, runId, targetAgentId, probe)
  });
  const task = submitted.tasks[0];
  return { taskId: task.id, status: task.status, agentId: targetAgentId, created: submitted.created, task };
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
    /*
     * Authority comes from the same resolution every other hub tool uses, so an instance run whose
     * resident was released, drained, or replaced cannot register an artifact, and a malformed actor
     * identity is rejected rather than read as "no instance".
     */
    const caller = resolveCaller(state, sourceRunId);
    const source = caller.principal.kind === "run" ? caller.principal.run : undefined;
    if (!source) throw new CoordinationError("forbidden", "create_artifact is served only to a hub-hosted run");
    const thread = caller.thread;
    if (thread.status !== "active") throw new CoordinationError("thread_inactive", "Artifacts require an active thread");
    artifact = state.artifacts.find((item) => item.runId === source.id && item.idempotencyKey === idempotencyKey);
    if (artifact) {
      if (artifact.relativePath !== relativePath || artifact.title !== title || artifact.kind !== kind || artifact.mediaType !== mediaType || artifact.size !== size || artifact.sha256 !== sha256) {
        throw new CoordinationError("idempotency_conflict", "The idempotency key was already used with different artifact metadata");
      }
      return false;
    }
    artifact = {
      id: newId("artifact"), threadId: thread.id, runId: source.id,
      // Record identity: an instance run's artifact names its instance and allocation, never an agent key.
      ...callerAttribution(caller), relativePath, title,
      kind: kind as Artifact["kind"], mediaType, summary, size, sha256,
      downloadPath: "", uploaded: false, idempotencyKey, createdAt: at
    };
    artifact.downloadPath = `/api/artifacts/${encodeURIComponent(artifact.id)}/content`;
    state.artifacts.unshift(artifact);
    thread.updatedAt = at;
    state.events.unshift(newEvent({ type: "status", title: "Artifact registered", detail: `${title} · ${size} bytes`, threadId: thread.id, ...callerAttribution(caller), runId: source.id }));
  });
  if (!artifact) throw new CoordinationError("persistence_failed", "The artifact was not registered", true);
  return { artifact, uploadPath: artifact.downloadPath };
}

interface NormalizedTaskUpdate {
  idempotencyKey: string;
  progress?: string;
  /** `null` clears a previously reported reason. */
  blockedReason?: string | null;
  completion?: { summary: string; artifactIds: string[] };
}

function normalizeTaskUpdate(value: unknown): NormalizedTaskUpdate {
  const values = record(value);
  onlyKeys(values, ["idempotencyKey", "progress", "blockedReason", "completion"], "update_task arguments");
  const update: NormalizedTaskUpdate = { idempotencyKey: requiredString(values, "idempotencyKey", orchestrationToolLimits.idempotencyKeyLength) };
  if (values.progress !== undefined) update.progress = requiredString(values, "progress", orchestrationToolLimits.progressSummaryLength);
  if (values.blockedReason === null) update.blockedReason = null;
  else if (values.blockedReason !== undefined) update.blockedReason = requiredString(values, "blockedReason", orchestrationToolLimits.blockedReasonLength);
  if (values.completion !== undefined) {
    const completion = record(values.completion);
    onlyKeys(completion, ["summary", "artifactIds"], "completion");
    update.completion = {
      summary: requiredString(completion, "summary", orchestrationToolLimits.completionSummaryLength),
      artifactIds: [...new Set(stringArray(completion, "artifactIds", orchestrationToolLimits.completionArtifacts))]
    };
  }
  if (update.progress === undefined && update.blockedReason === undefined && update.completion === undefined) {
    throw new CoordinationError("invalid_arguments", "Provide progress, blockedReason, or completion");
  }
  return update;
}

const taskUpdateDigest = (update: NormalizedTaskUpdate, sourceRunId: string) => createHash("sha256").update(JSON.stringify([
  1,
  sourceRunId,
  update.progress ?? null,
  update.blockedReason === undefined ? { unchanged: true } : update.blockedReason,
  update.completion ? [update.completion.summary, [...update.completion.artifactIds].sort()] : null
])).digest("hex");

/**
 * `update_task`: progress, an advisory blocked reason, or completion fields reported by the task's
 * current assignee. It never changes task status; the attempt's run lifecycle does that.
 */
export const updateTask = (store: Store, sourceRunId: string, argumentsValue: unknown, at = new Date().toISOString()) =>
  updateTaskForSource(store, runSource(sourceRunId), argumentsValue, at);

/**
 * `update_task` for either principal. It stays assignee-only, and an external orchestrator is never
 * a task's assignee, so it is refused after its attachment has been checked — the refusal must not
 * tell it whether the thread it named is one it holds.
 */
export async function updateTaskForSource(store: Store, source: CallerSource, argumentsValue: unknown, at = new Date().toISOString()) {
  if (source.kind === "external") {
    // Resolved first, so a thread this connection does not hold answers exactly as a thread it does;
    // refused before its arguments are read, so the answer is the stable reason rather than whichever
    // field the caller got wrong on a call that could never succeed.
    store.read((state) => resolveCallerFor(state, source));
    throw new CoordinationError("forbidden", "Only the task's current assignee can update it");
  }
  const update = normalizeTaskUpdate(argumentsValue);
  let result: { created: boolean; updateId: string; task: ReturnType<typeof taskContextProjection> } | undefined;
  await store.transact((state) => {
    const caller = resolveCallerFor(state, source);
    const task = caller.task;
    if (!task) throw new CoordinationError("forbidden", "Only a task attempt can update a task");
    const { run: callingRun } = requireCallerRun(caller, "Only a task attempt can update a task");
    const digest = taskUpdateDigest(update, callingRun.id);
    state.taskUpdates ??= [];
    const replay = state.taskUpdates.find((item) => item.threadId === caller.thread.id && item.taskId === task.id && item.idempotencyKey === update.idempotencyKey);
    if (replay) {
      if (replay.digest !== digest) throw new CoordinationError("idempotency_conflict", "The idempotency key was already used with a different task update");
      result = { created: false, updateId: replay.id, task: taskContextProjection(state, caller.thread.id, task.id) };
      return false;
    }
    if (task.assignment?.runId !== callingRun.id || isTerminalTaskStatus(task.status)) throw new CoordinationError("forbidden", "Only the task's current assignee can update it");
    if (caller.thread.status !== "active") throw new CoordinationError("thread_inactive", "Task updates require an active thread");
    if (state.taskUpdates.filter((item) => item.taskId === task.id).length >= orchestrationToolLimits.updatesPerTask) {
      throw new CoordinationError("update_limit", "The task's update limit has been reached");
    }
    if (update.completion) assertVisibleArtifacts(state, caller.thread.id, update.completion.artifactIds, new Set(task.attemptRunIds));
    const progress: TaskProgress = { ...task.progress, runId: callingRun.id, updatedAt: at };
    if (update.progress !== undefined) progress.summary = update.progress;
    if (update.blockedReason === null) delete progress.blockedReason;
    else if (update.blockedReason !== undefined) progress.blockedReason = update.blockedReason;
    if (update.completion) progress.completion = { summary: update.completion.summary, artifactIds: [...update.completion.artifactIds] };
    task.progress = progress;
    task.updatedAt = at;
    const record: TaskUpdateRecord = {
      id: newId("taskupd"), threadId: caller.thread.id, taskId: task.id, sourceRunId: callingRun.id,
      // Record identity: an instance attempt names its instance and allocation, never an agent key.
      ...callerAttribution(caller),
      idempotencyKey: update.idempotencyKey, digest, createdAt: at
    };
    state.taskUpdates.push(record);
    result = { created: true, updateId: record.id, task: taskContextProjection(state, caller.thread.id, task.id) };
  });
  if (!result) throw new CoordinationError("persistence_failed", "The task update was not recorded", true);
  return result;
}
