import { createHash } from "node:crypto";
import {
  canTransitionTask,
  dependencyOutcome,
  harnessIds,
  harnessTransports,
  isTaskDependencyPolicy,
  isTerminalTaskStatus,
  recordSourceKey,
  type DependencyOutcome,
  type ExecutionPreferences,
  type ExecutionRequirements,
  type HarnessId,
  type HarnessTransport,
  type PlacementOverride,
  type Run,
  type RunTransportSelection,
  type Task,
  type TaskDependencyPolicy,
  type TaskStatus
} from "@coffee-shop/protocol";
import { CoordinationError } from "./coordinationError.js";
import { callerAgent, callerCanDelegate, callerRun, resolveCallerFor, runSource, type CallerSource } from "./mailbox.js";
import { newEvent, newId, type State, type Store, type TaskSubmission } from "./store.js";

export const taskBatchLimits = {
  tasks: 32,
  dependenciesPerTask: 32,
  keyLength: 64,
  idempotencyKeyLength: 128,
  titleLength: 200,
  instructionsLength: 16_000,
  requirementEntries: 32,
  requirementValueLength: 128,
  repositoryLength: 512,
  workspacePathLength: 1_024,
  maximumConcurrency: 1_024,
  maximumMemoryMegabytes: 16 * 1024 * 1024,
  resultLength: 16_000
} as const;

const localKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type NormalizedDependencyReference = { kind: "local"; key: string } | { kind: "existing"; taskId: string };

export interface NormalizedTaskDependency {
  reference: NormalizedDependencyReference;
  policy: TaskDependencyPolicy;
}

export interface NormalizedTaskInput {
  key: string;
  title: string;
  instructions: string;
  requirements: ExecutionRequirements;
  dependencies: NormalizedTaskDependency[];
}

/** A validated batch in canonical form; `tasks` keeps the submitted order so results mirror the request. */
export interface NormalizedTaskBatch {
  idempotencyKey: string;
  tasks: NormalizedTaskInput[];
}

export interface TaskBatchResult {
  created: boolean;
  submissionId: string;
  /** Tasks in the order the batch listed them. */
  tasks: Task[];
  taskIdsByKey: Record<string, string>;
}

const invalid = (message: string) => new CoordinationError("invalid_arguments", message);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], context: string) {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown !== undefined) throw invalid(`${context} contains an unknown field`);
}

function boundedString(value: unknown, context: string, maximum: number) {
  if (typeof value !== "string") throw invalid(`${context} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw invalid(`${context} cannot be empty`);
  if (trimmed.length > maximum) throw invalid(`${context} must be at most ${maximum} characters`);
  return trimmed;
}

function localKey(value: unknown, context: string) {
  const key = boundedString(value, context, taskBatchLimits.keyLength);
  if (!localKeyPattern.test(key)) throw invalid(`${context} must contain only letters, digits, '.', '_', or '-'`);
  return key;
}

function stringList(value: unknown, context: string, allowed?: readonly string[]) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid(`${context} must be an array`);
  if (value.length > taskBatchLimits.requirementEntries) throw invalid(`${context} must have at most ${taskBatchLimits.requirementEntries} entries`);
  const entries = value.map((item, index) => boundedString(item, `${context}[${index}]`, taskBatchLimits.requirementValueLength));
  if (allowed) {
    const unknown = entries.find((entry) => !allowed.includes(entry));
    if (unknown !== undefined) throw invalid(`${context} contains an unknown value`);
  }
  return entries;
}

/** Hard requirements are sets: order and repetition do not change their meaning. */
const setOf = (entries: string[]) => [...new Set(entries)].sort();
/** Preferences are ranked: the first occurrence keeps its position. */
const rankedOf = (entries: string[]) => [...new Set(entries)];

function positiveInteger(value: unknown, context: string, maximum: number) {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw invalid(`${context} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function normalizePreferences(value: unknown): ExecutionPreferences | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw invalid("requirements.preferences must be an object");
  onlyKeys(value, ["nodeIds", "harnessIds", "models", "labels"], "requirements.preferences");
  const preferences: ExecutionPreferences = {};
  const nodeIds = rankedOf(stringList(value.nodeIds, "requirements.preferences.nodeIds"));
  const preferredHarnessIds = rankedOf(stringList(value.harnessIds, "requirements.preferences.harnessIds", harnessIds)) as HarnessId[];
  const models = rankedOf(stringList(value.models, "requirements.preferences.models"));
  const labels = rankedOf(stringList(value.labels, "requirements.preferences.labels"));
  if (nodeIds.length) preferences.nodeIds = nodeIds;
  if (preferredHarnessIds.length) preferences.harnessIds = preferredHarnessIds;
  if (models.length) preferences.models = models;
  if (labels.length) preferences.labels = labels;
  return Object.keys(preferences).length ? preferences : undefined;
}

export function normalizeRequirements(value: unknown): ExecutionRequirements {
  if (value === undefined) return {};
  if (!isRecord(value)) throw invalid("requirements must be an object");
  onlyKeys(value, [
    "skills", "harnessIds", "models", "transports", "operatingSystems", "architectures", "labels",
    "minimumConcurrency", "minimumMemoryMegabytes", "projectProfileId", "templateId", "workspace", "preferences"
  ], "requirements");
  const requirements: ExecutionRequirements = {};
  const sets = {
    skills: setOf(stringList(value.skills, "requirements.skills")),
    harnessIds: setOf(stringList(value.harnessIds, "requirements.harnessIds", harnessIds)) as HarnessId[],
    models: setOf(stringList(value.models, "requirements.models")),
    transports: setOf(stringList(value.transports, "requirements.transports", harnessTransports)) as HarnessTransport[],
    operatingSystems: setOf(stringList(value.operatingSystems, "requirements.operatingSystems")),
    architectures: setOf(stringList(value.architectures, "requirements.architectures")),
    labels: setOf(stringList(value.labels, "requirements.labels"))
  };
  if (sets.skills.length) requirements.skills = sets.skills;
  if (sets.harnessIds.length) requirements.harnessIds = sets.harnessIds;
  if (sets.models.length) requirements.models = sets.models;
  if (sets.transports.length) requirements.transports = sets.transports;
  if (sets.operatingSystems.length) requirements.operatingSystems = sets.operatingSystems;
  if (sets.architectures.length) requirements.architectures = sets.architectures;
  if (sets.labels.length) requirements.labels = sets.labels;
  const minimumConcurrency = positiveInteger(value.minimumConcurrency, "requirements.minimumConcurrency", taskBatchLimits.maximumConcurrency);
  const minimumMemoryMegabytes = positiveInteger(value.minimumMemoryMegabytes, "requirements.minimumMemoryMegabytes", taskBatchLimits.maximumMemoryMegabytes);
  if (minimumConcurrency !== undefined) requirements.minimumConcurrency = minimumConcurrency;
  if (minimumMemoryMegabytes !== undefined) requirements.minimumMemoryMegabytes = minimumMemoryMegabytes;
  if (value.projectProfileId !== undefined) requirements.projectProfileId = boundedString(value.projectProfileId, "requirements.projectProfileId", taskBatchLimits.requirementValueLength);
  if (value.templateId !== undefined) requirements.templateId = boundedString(value.templateId, "requirements.templateId", taskBatchLimits.requirementValueLength);
  if (value.workspace !== undefined) {
    const workspace = value.workspace;
    if (!isRecord(workspace)) throw invalid("requirements.workspace must be an object");
    onlyKeys(workspace, ["repository", "path", "writable"], "requirements.workspace");
    if (typeof workspace.writable !== "boolean") throw invalid("requirements.workspace.writable must be a boolean");
    requirements.workspace = { writable: workspace.writable };
    if (workspace.repository !== undefined) requirements.workspace.repository = boundedString(workspace.repository, "requirements.workspace.repository", taskBatchLimits.repositoryLength);
    if (workspace.path !== undefined) requirements.workspace.path = boundedString(workspace.path, "requirements.workspace.path", taskBatchLimits.workspacePathLength);
  }
  const preferences = normalizePreferences(value.preferences);
  if (preferences) requirements.preferences = preferences;
  return requirements;
}

const referenceIdentity = (reference: NormalizedDependencyReference) =>
  reference.kind === "local" ? `local:${reference.key}` : `existing:${reference.taskId}`;

function normalizeDependencies(value: unknown, context: string): NormalizedTaskDependency[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid(`${context} must be an array`);
  if (value.length > taskBatchLimits.dependenciesPerTask) throw invalid(`${context} must have at most ${taskBatchLimits.dependenciesPerTask} entries`);
  const byTarget = new Map<string, NormalizedTaskDependency>();
  value.forEach((item, index) => {
    const itemContext = `${context}[${index}]`;
    if (!isRecord(item)) throw invalid(`${itemContext} must be an object`);
    onlyKeys(item, ["key", "taskId", "policy"], itemContext);
    if ((item.key === undefined) === (item.taskId === undefined)) throw invalid(`${itemContext} must reference exactly one of key or taskId`);
    const reference: NormalizedDependencyReference = item.key !== undefined
      ? { kind: "local", key: localKey(item.key, `${itemContext}.key`) }
      : { kind: "existing", taskId: boundedString(item.taskId, `${itemContext}.taskId`, taskBatchLimits.requirementValueLength) };
    if (item.policy !== undefined && !isTaskDependencyPolicy(item.policy)) throw invalid(`${itemContext}.policy is not recognized`);
    const policy: TaskDependencyPolicy = item.policy ?? "require-success";
    const identity = referenceIdentity(reference);
    const previous = byTarget.get(identity);
    if (previous && previous.policy !== policy) throw invalid(`${itemContext} repeats a dependency with a different policy`);
    byTarget.set(identity, { reference, policy });
  });
  return [...byTarget.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([, dependency]) => dependency);
}

/**
 * Validates and canonicalizes untrusted batch arguments without consulting hub state. Every
 * malformed element rejects the whole batch.
 */
export function normalizeTaskBatch(value: unknown): NormalizedTaskBatch {
  if (!isRecord(value)) throw invalid("Task batch must be an object");
  onlyKeys(value, ["idempotencyKey", "tasks"], "Task batch");
  const idempotencyKey = boundedString(value.idempotencyKey, "idempotencyKey", taskBatchLimits.idempotencyKeyLength);
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) throw invalid("tasks must be a non-empty array");
  if (value.tasks.length > taskBatchLimits.tasks) throw new CoordinationError("batch_too_large", `A batch may contain at most ${taskBatchLimits.tasks} tasks`);
  const keys = new Set<string>();
  const tasks = value.tasks.map((item, index): NormalizedTaskInput => {
    const context = `tasks[${index}]`;
    if (!isRecord(item)) throw invalid(`${context} must be an object`);
    onlyKeys(item, ["key", "title", "instructions", "requirements", "dependencies"], context);
    const key = localKey(item.key, `${context}.key`);
    if (keys.has(key)) throw new CoordinationError("duplicate_task_key", `Task key ${key} appears more than once`);
    keys.add(key);
    return {
      key,
      title: boundedString(item.title, `${context}.title`, taskBatchLimits.titleLength),
      instructions: boundedString(item.instructions, `${context}.instructions`, taskBatchLimits.instructionsLength),
      requirements: normalizeRequirements(item.requirements),
      dependencies: normalizeDependencies(item.dependencies, `${context}.dependencies`)
    };
  });
  return { idempotencyKey, tasks };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The batch identity. It covers the source thread and run, every normalized task, requirement set,
 * local key, dependency edge, and policy; it deliberately excludes timestamps. Task order does not
 * change identity because local keys, not positions, name tasks.
 */
export function taskBatchDigest(batch: NormalizedTaskBatch, threadId: string, sourceIdentity: string, placementOverrides?: Readonly<Record<string, PlacementOverride>>) {
  const tasks = [...batch.tasks].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  const overrides = placementOverrides && Object.keys(placementOverrides).length ? placementOverrides : undefined;
  return createHash("sha256").update(canonicalJson({ version: 1, threadId, sourceRunId: sourceIdentity, idempotencyKey: batch.idempotencyKey, tasks, placementOverrides: overrides })).digest("hex");
}

/** Hub-side policy applied to one submission; none of it can be supplied by tool arguments. */
export interface TaskBatchOptions {
  /** Separately authorized placement narrowing by task key. It is part of the batch identity. */
  placementOverrides?: Readonly<Record<string, PlacementOverride>>;
  /** Tasks and legacy delegations the source run may have created in total, including this batch. */
  maximumSourceTasks?: number;
  /** Source runs at or beyond this depth cannot submit. */
  maximumSourceDepth?: number;
  /**
   * Extra policy checked against the authoritative state before a new batch is created; never for a
   * replay. It names the submitting run, so it is only available to a hub-hosted submitter.
   */
  assertAcceptable?: (state: Readonly<State>, sourceRunId: string) => void;
}

function findLocalCycle(batch: NormalizedTaskBatch) {
  const edges = new Map(batch.tasks.map((task) => [task.key, task.dependencies
    .flatMap((dependency) => (dependency.reference.kind === "local" ? [dependency.reference.key] : []))]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    for (const next of edges.get(key) ?? []) if (visit(next)) return true;
    visiting.delete(key);
    visited.add(key);
    return false;
  };
  return batch.tasks.find((task) => visit(task.key))?.key;
}

/** Graph checks that need only the batch itself: missing sibling keys, self-edges, and cycles. */
export function validateTaskBatchGraph(batch: NormalizedTaskBatch) {
  const keys = new Set(batch.tasks.map((task) => task.key));
  for (const task of batch.tasks) {
    for (const dependency of task.dependencies) {
      if (dependency.reference.kind !== "local") continue;
      if (dependency.reference.key === task.key) throw new CoordinationError("dependency_cycle", `Task ${task.key} cannot depend on itself`);
      if (!keys.has(dependency.reference.key)) throw new CoordinationError("unknown_dependency", `Task ${task.key} depends on an unknown task key`);
    }
  }
  const cyclic = findLocalCycle(batch);
  if (cyclic !== undefined) throw new CoordinationError("dependency_cycle", `The batch contains a dependency cycle through ${cyclic}`);
}

interface SubmissionSource {
  /** The submitting run, or `undefined` when an external orchestrator submitted the batch. */
  run?: Run;
  threadId: string;
  agentId?: string;
  /** The lineage and idempotency identity of the submitter. */
  sourceKey: string;
  /**
   * What the batch digest binds. A run principal keeps binding its bare run id, because every batch
   * persisted before source keys existed was digested that way and a replay of one must still match.
   * The two forms cannot collide: a hub identifier never contains a colon.
   */
  digestIdentity: string;
}

function authorizeSource(state: Readonly<State>, source: CallerSource): SubmissionSource {
  const caller = resolveCallerFor(state, source);
  if (!callerCanDelegate(caller)) throw new CoordinationError("forbidden", "This agent is not allowed to submit tasks");
  const run = callerRun(caller);
  return {
    run,
    threadId: caller.thread.id,
    agentId: callerAgent(caller)?.id,
    sourceKey: caller.sourceKey,
    digestIdentity: run ? run.id : caller.sourceKey
  };
}

type BatchPlan =
  | { kind: "replay"; submission: TaskSubmission }
  | { kind: "create"; source: SubmissionSource; digest: string };

/**
 * Decides a submission against one consistent view of state. Called once as a fast preflight and
 * again inside the transaction, where its answer is authoritative.
 */
function planTaskBatch(state: Readonly<State>, callerSource: CallerSource, batch: NormalizedTaskBatch, options: TaskBatchOptions): BatchPlan {
  const source = authorizeSource(state, callerSource);
  const digest = taskBatchDigest(batch, source.threadId, source.digestIdentity, options.placementOverrides);
  // Caller-supplied keys live in their own space: a submission the hub derived for another caller's
  // operation never answers, and never conflicts with, a key an ordinary caller chose.
  const prior = state.taskSubmissions?.find((item) =>
    item.threadId === source.threadId && item.origin === undefined && item.idempotencyKey === batch.idempotencyKey);
  if (prior) {
    if (prior.digest !== digest) throw new CoordinationError("idempotency_conflict", "The idempotency key was already used with a different task batch");
    return { kind: "replay", submission: prior };
  }
  const thread = state.threads?.find((item) => item.id === source.threadId);
  if (thread?.status !== "active") throw new CoordinationError("thread_inactive", "Task submission requires an active thread");
  validateTaskBatchGraph(batch);
  const tasks = state.tasks ?? [];
  if (options.maximumSourceDepth !== undefined && (source.run?.depth ?? 0) >= options.maximumSourceDepth) {
    throw new CoordinationError("depth_limit", "The delegation depth limit has been reached");
  }
  if (options.maximumSourceTasks !== undefined) {
    const prior = tasks.filter((task) => recordSourceKey(task) === source.sourceKey).length
      + (source.run === undefined ? 0 : (state.delegations ?? []).filter((delegation) => delegation.parentRunId === source.run!.id).length);
    if (prior + batch.tasks.length > options.maximumSourceTasks) throw new CoordinationError("fanout_limit", "The task delegation limit has been reached");
  }
  if (options.assertAcceptable !== undefined) {
    if (source.run === undefined) throw new CoordinationError("forbidden", "This submission path requires a hub-hosted source run");
    options.assertAcceptable(state, source.run.id);
  }
  const keys = new Set(batch.tasks.map((task) => task.key));
  for (const [key, override] of Object.entries(options.placementOverrides ?? {})) {
    if (!keys.has(key)) throw invalid("A placement override names a task key outside the batch");
    if (override.agentId !== undefined && !state.agents.some((agent) => agent.id === override.agentId)) {
      throw new CoordinationError("invalid_target", "The pinned agent does not exist");
    }
    if (override.nodeId !== undefined && !state.nodes.some((node) => node.id === override.nodeId)) {
      throw new CoordinationError("invalid_target", "The pinned compute node does not exist");
    }
  }
  for (const task of batch.tasks) {
    for (const dependency of task.dependencies) {
      if (dependency.reference.kind !== "existing") continue;
      const { taskId } = dependency.reference;
      if (!tasks.some((item) => item.id === taskId && item.threadId === source.threadId)) {
        throw new CoordinationError("unknown_dependency", `Task ${task.key} depends on an unknown task`);
      }
    }
  }
  return { kind: "create", source, digest };
}

function replayResult(state: Readonly<State>, submission: TaskSubmission, order: readonly string[]): TaskBatchResult {
  const byId = new Map((state.tasks ?? []).map((task) => [task.id, task]));
  const idsByKey = new Map(submission.tasks.map((entry) => [entry.key, entry.taskId]));
  const tasks = order.map((key) => {
    const task = byId.get(idsByKey.get(key) ?? "");
    if (!task) throw new CoordinationError("inconsistent_state", "A previously submitted task is unavailable", true);
    return structuredClone(task);
  });
  return { created: false, submissionId: submission.id, tasks, taskIdsByKey: Object.fromEntries(idsByKey) };
}

function statusFromDependencies(state: Readonly<State>, task: Task): { status: TaskStatus; blockingTaskId?: string } {
  const byId = new Map((state.tasks ?? []).map((item) => [item.id, item]));
  let waiting = false;
  for (const dependency of task.dependencies) {
    const prerequisite = byId.get(dependency.taskId);
    const outcome: DependencyOutcome = prerequisite && prerequisite.threadId === task.threadId
      ? dependencyOutcome(dependency.policy, prerequisite.status)
      : "blocking";
    if (outcome === "blocking") return { status: "blocked", blockingTaskId: dependency.taskId };
    if (outcome === "waiting") waiting = true;
  }
  return { status: waiting ? "pending" : "ready" };
}

/**
 * Atomically submits a task batch on behalf of an authenticated running source run. Exact replays
 * return the original tasks and write nothing; conflicting replays and every invalid batch reject
 * without mutation. If persistence fails the in-memory state is unchanged.
 */
export const submitTaskBatch = (
  store: Store,
  sourceRunId: string,
  argumentsValue: unknown,
  at = new Date().toISOString(),
  options: TaskBatchOptions = {}
) => submitTaskBatchForSource(store, runSource(sourceRunId), argumentsValue, at, options);

/** `submitTaskBatch` for either principal; the source is resolved again inside the transaction. */
export async function submitTaskBatchForSource(
  store: Store,
  callerSource: CallerSource,
  argumentsValue: unknown,
  at = new Date().toISOString(),
  options: TaskBatchOptions = {}
): Promise<TaskBatchResult> {
  const batch = normalizeTaskBatch(argumentsValue);
  const order = batch.tasks.map((task) => task.key);
  store.read((state) => planTaskBatch(state, callerSource, batch, options));
  let result: TaskBatchResult | undefined;
  await store.transact((state) => {
    const plan = planTaskBatch(state, callerSource, batch, options);
    if (plan.kind === "replay") {
      result = replayResult(state, plan.submission, order);
      return false;
    }
    state.tasks ??= [];
    state.taskSubmissions ??= [];
    const idsByKey = new Map(batch.tasks.map((task) => [task.key, newId("task")]));
    const created = batch.tasks.map((input): Task => ({
      id: idsByKey.get(input.key)!,
      threadId: plan.source.threadId,
      title: input.title,
      instructions: input.instructions,
      status: "pending",
      requirements: structuredClone(input.requirements),
      dependencies: input.dependencies.map((dependency) => ({
        taskId: dependency.reference.kind === "local" ? idsByKey.get(dependency.reference.key)! : dependency.reference.taskId,
        policy: dependency.policy
      })),
      ...(options.placementOverrides?.[input.key] ? { placementOverride: { ...options.placementOverrides[input.key] } } : {}),
      ...(plan.source.run ? { sourceRunId: plan.source.run.id } : { sourceKey: plan.source.sourceKey }),
      idempotencyKey: batch.idempotencyKey,
      attemptRunIds: [],
      createdAt: at,
      updatedAt: at
    }));
    state.tasks.push(...created);
    const submission: TaskSubmission = {
      id: newId("tasksub"),
      threadId: plan.source.threadId,
      ...(plan.source.run ? { sourceRunId: plan.source.run.id } : { sourceKey: plan.source.sourceKey }),
      ...(plan.source.agentId === undefined ? {} : { creatorAgentId: plan.source.agentId }),
      idempotencyKey: batch.idempotencyKey,
      digest: plan.digest,
      tasks: batch.tasks.map((task) => ({ key: task.key, taskId: idsByKey.get(task.key)! })),
      createdAt: at
    };
    state.taskSubmissions.push(submission);
    settleDependents(state, at);
    const thread = state.threads?.find((item) => item.id === plan.source.threadId);
    if (thread) thread.updatedAt = at;
    state.events.unshift(newEvent({
      type: "status",
      title: `${created.length} task${created.length === 1 ? "" : "s"} submitted`,
      detail: created.map((task) => task.title).join(", ").slice(0, 240),
      threadId: plan.source.threadId,
      ...(plan.source.agentId === undefined ? {} : { agentId: plan.source.agentId }),
      ...(plan.source.run === undefined ? {} : { runId: plan.source.run.id })
    }));
    result = {
      created: true,
      submissionId: submission.id,
      tasks: created.map((task) => structuredClone(task)),
      taskIdsByKey: Object.fromEntries(idsByKey)
    };
  });
  if (!result) throw new CoordinationError("persistence_failed", "The task batch was not submitted", true);
  return result;
}

/**
 * The key space of a task the hub derives for an instance lifecycle request. No caller-supplied
 * batch can enter it, so a derived key and a caller-chosen key of the same string never meet.
 */
export const initialTaskOrigin = "instance-lifecycle" as const;

/** The seed for the atomic initial task created with an instance, in the instance lifecycle transaction. */
export interface InitialTaskSeed {
  title: string;
  instructions: string;
  requirements?: ExecutionRequirements;
  /** Derived over the caller principal, thread, and operation; see `initialTaskIdempotencyKey`. */
  idempotencyKey: string;
  /** The canonical principal identity of the instance lifecycle caller. */
  sourceKey: string;
}

/**
 * Appends one task inside the caller's transaction. It reuses the task-batch normalization, digest,
 * and submission records so the initial task is indistinguishable from any other task once created;
 * because it runs inside the instance lifecycle transaction, any failure rolls back both sides.
 */
export function appendInitialTaskInState(state: State, threadId: string, seed: InitialTaskSeed, at: string): Task {
  const thread = state.threads?.find((item) => item.id === threadId);
  if (!thread || thread.status !== "active") throw invalid("Task creation requires an active thread");
  const batch = normalizeTaskBatch({
    idempotencyKey: seed.idempotencyKey,
    tasks: [{
      key: "initial",
      title: seed.title,
      instructions: seed.instructions,
      requirements: seed.requirements ?? {},
      dependencies: []
    }]
  });
  const digest = taskBatchDigest(batch, threadId, seed.sourceKey);
  const prior = state.taskSubmissions?.find((item) =>
    item.threadId === threadId && item.origin === initialTaskOrigin && item.idempotencyKey === seed.idempotencyKey);
  if (prior) {
    if (prior.digest !== digest) throw new CoordinationError("idempotency_conflict", "The idempotency key was already used with a different task batch");
    const existing = state.tasks?.find((item) => prior.tasks.some((entry) => entry.taskId === item.id));
    if (!existing) throw new CoordinationError("inconsistent_state", "A previously submitted task is unavailable", true);
    return existing;
  }
  const task: Task = {
    id: newId("task"),
    threadId,
    title: batch.tasks[0].title,
    instructions: batch.tasks[0].instructions,
    status: "pending",
    requirements: structuredClone(batch.tasks[0].requirements),
    dependencies: [],
    sourceKey: seed.sourceKey,
    idempotencyKey: seed.idempotencyKey,
    attemptRunIds: [],
    createdAt: at,
    updatedAt: at
  };
  state.tasks ??= [];
  state.tasks.push(task);
  state.taskSubmissions ??= [];
  state.taskSubmissions.push({
    id: newId("tasksub"),
    threadId,
    sourceKey: seed.sourceKey,
    idempotencyKey: seed.idempotencyKey,
    origin: initialTaskOrigin,
    digest,
    tasks: [{ key: "initial", taskId: task.id }],
    createdAt: at
  });
  settleDependents(state, at);
  return task;
}

/** The only way task status changes; it enforces the protocol's monotonic transition table. */
export function transitionTask(task: Task, to: TaskStatus, at: string) {
  if (!canTransitionTask(task.status, to)) throw new CoordinationError("invalid_transition", `Task ${task.id} cannot move from ${task.status} to ${to}`);
  task.status = to;
  task.updatedAt = at;
  if (isTerminalTaskStatus(to)) task.finishedAt = at;
}

/**
 * Re-derives every pending task from its dependencies until nothing changes. A pending task becomes
 * ready only when all dependencies are satisfied; a blocking dependency (including one that is
 * missing or in another thread) blocks it, and blocking cascades. Returns the tasks that changed.
 */
export function settleDependents(state: State, at: string) {
  const changed: Task[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const task of state.tasks ?? []) {
      if (task.status !== "pending") continue;
      const derived = statusFromDependencies(state, task);
      if (derived.status === "pending") continue;
      transitionTask(task, derived.status, at);
      if (derived.status === "blocked") task.error = `Dependency ${derived.blockingTaskId} did not complete successfully`;
      changed.push(task);
      progressed = true;
    }
  }
  return changed;
}

export interface TaskReadiness {
  outcome: DependencyOutcome;
  waitingOn: string[];
  satisfiedBy: string[];
  blockedBy: string[];
}

/** Dependency readiness for one task; the scheduler consumes this rather than reimplementing it. */
export function taskReadiness(state: Readonly<State>, task: Task): TaskReadiness {
  const byId = new Map((state.tasks ?? []).map((item) => [item.id, item]));
  const readiness: TaskReadiness = { outcome: "satisfied", waitingOn: [], satisfiedBy: [], blockedBy: [] };
  for (const dependency of task.dependencies) {
    const prerequisite = byId.get(dependency.taskId);
    const outcome = prerequisite && prerequisite.threadId === task.threadId ? dependencyOutcome(dependency.policy, prerequisite.status) : "blocking";
    if (outcome === "waiting") readiness.waitingOn.push(dependency.taskId);
    else if (outcome === "satisfied") readiness.satisfiedBy.push(dependency.taskId);
    else readiness.blockedBy.push(dependency.taskId);
  }
  readiness.outcome = readiness.blockedBy.length ? "blocking" : readiness.waitingOn.length ? "waiting" : "satisfied";
  return readiness;
}

/** Ready tasks without an assignment, in stable submission order, optionally scoped to one thread. */
export function readyTasks(state: Readonly<State>, threadId?: string) {
  return (state.tasks ?? []).filter((task) => task.status === "ready" && !task.assignment && (threadId === undefined || task.threadId === threadId));
}

/**
 * Associates a new, not yet persisted queued run with a ready task as its next immutable attempt.
 * Prior attempts are never modified; the task keeps its identity across retries.
 */
export function assignTaskAttempt(state: State, taskId: string, run: Run, at: string) {
  const task = state.tasks?.find((item) => item.id === taskId);
  if (!task) throw new CoordinationError("not_found", "Task not found");
  if (task.status !== "ready" || task.assignment) throw new CoordinationError("task_not_ready", `Task ${task.id} is ${task.status} and cannot receive an attempt`);
  if (run.threadId !== task.threadId) throw new CoordinationError("invalid_attempt", "An attempt must belong to its task's thread");
  if (run.status !== "queued") throw new CoordinationError("invalid_attempt", "An attempt must start queued");
  if (state.runs.some((item) => item.id === run.id)) throw new CoordinationError("invalid_attempt", "An attempt run must be new");
  if (run.taskId !== undefined && run.taskId !== task.id) throw new CoordinationError("invalid_attempt", "The run belongs to another task");
  run.taskId = task.id;
  run.attempt = task.attemptRunIds.length + 1;
  state.runs.unshift(run);
  task.attemptRunIds.push(run.id);
  task.assignment = {
    runId: run.id,
    agentId: run.agentId,
    ...(run.instanceId === undefined ? {} : { instanceId: run.instanceId }),
    ...(run.allocationId === undefined ? {} : { allocationId: run.allocationId }),
    nodeId: run.nodeId,
    harnessId: run.harnessId,
    transport: run.transport ?? "native-cli",
    model: run.model,
    workspaceLeaseId: run.workspaceLeaseId,
    assignedAt: at
  };
  transitionTask(task, "assigned", at);
  return run;
}

export interface AttemptOutcomeOptions {
  /** A failure the hub may retry with a new attempt, such as lost compute. */
  retryable?: boolean;
}

/**
 * Projects the current status of an attempt run onto its task. Results from any run other than the
 * task's current assignment, or for a task that is already terminal, are ignored so late attempts
 * cannot overwrite a settled task. Returns whether the task changed.
 */
export function applyAttemptOutcome(state: State, runId: string, at: string, options: AttemptOutcomeOptions = {}) {
  const run = state.runs.find((item) => item.id === runId);
  if (!run?.taskId) return false;
  const task = state.tasks?.find((item) => item.id === run.taskId);
  if (!task || isTerminalTaskStatus(task.status) || task.assignment?.runId !== run.id) return false;
  if (run.status === "running") {
    if (task.status !== "assigned") return false;
    transitionTask(task, "running", at);
    return true;
  }
  if (run.status === "completed") {
    if (task.status !== "running") return false;
    transitionTask(task, "completed", at);
    task.result = run.output.slice(0, taskBatchLimits.resultLength);
  } else if (run.status === "failed") {
    if (options.retryable) {
      transitionTask(task, "ready", at);
      task.assignment = undefined;
      task.error = run.error;
      return true;
    }
    transitionTask(task, "failed", at);
    task.error = run.error;
  } else if (run.status === "cancelled") {
    transitionTask(task, "cancelled", at);
  } else {
    return false;
  }
  settleDependents(state, at);
  return true;
}

export interface TaskCancellationResult {
  kind: "cancelled" | "already-terminal" | "not-found";
  task?: Task;
  /** The active attempt the caller must cancel in the same transaction. */
  activeAttemptRunId?: string;
}

/**
 * Cancels a non-terminal task. Dependents are then re-derived: `require-success` dependents become
 * blocked and `allow-failure` dependents treat the cancellation as settled. Dependents are never
 * cancelled implicitly.
 */
export function cancelTaskInState(state: State, taskId: string, at: string): TaskCancellationResult {
  const task = state.tasks?.find((item) => item.id === taskId);
  if (!task) return { kind: "not-found" };
  if (isTerminalTaskStatus(task.status)) return { kind: "already-terminal", task };
  const activeAttemptRunId = task.assignment?.runId;
  transitionTask(task, "cancelled", at);
  settleDependents(state, at);
  return { kind: "cancelled", task, activeAttemptRunId };
}

export interface TaskAttemptProjection {
  runId: string;
  attempt?: number;
  status: Run["status"];
  agentId: string;
  /** Version-5: the resident instance that executed the attempt, when it was instance-keyed. */
  instanceId?: string;
  nodeId: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  /** The transport the hub dispatched the attempt with. */
  transport: HarnessTransport;
  /** The transport Barista selected and its provenance, once the attempt started. */
  transportSelection?: RunTransportSelection;
}

export interface TaskProjection {
  id: string;
  threadId: string;
  title: string;
  instructions: string;
  status: TaskStatus;
  requirements: ExecutionRequirements;
  dependencies: Array<{ taskId: string; policy: TaskDependencyPolicy; status?: TaskStatus }>;
  dependentTaskIds: string[];
  readiness: TaskReadiness;
  sourceRunId?: string;
  creatorAgentId?: string;
  placementOverride?: Task["placementOverride"];
  assignment?: Task["assignment"];
  placement?: Task["placement"];
  attempts: TaskAttemptProjection[];
  result?: string;
  error?: string;
  progress?: Task["progress"];
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

function projectTask(state: Readonly<State>, task: Task): TaskProjection {
  const byId = new Map((state.tasks ?? []).map((item) => [item.id, item]));
  const runs = new Map(state.runs.map((run) => [run.id, run]));
  const creator = state.taskSubmissions?.find((submission) => submission.tasks.some((entry) => entry.taskId === task.id));
  return {
    id: task.id,
    threadId: task.threadId,
    title: task.title,
    instructions: task.instructions,
    status: task.status,
    requirements: structuredClone(task.requirements),
    dependencies: task.dependencies.map((dependency) => {
      const prerequisite = byId.get(dependency.taskId);
      return { taskId: dependency.taskId, policy: dependency.policy, status: prerequisite?.threadId === task.threadId ? prerequisite.status : undefined };
    }),
    dependentTaskIds: (state.tasks ?? [])
      .filter((item) => item.threadId === task.threadId && item.dependencies.some((dependency) => dependency.taskId === task.id))
      .map((item) => item.id),
    readiness: taskReadiness(state, task),
    sourceRunId: task.sourceRunId,
    creatorAgentId: creator?.creatorAgentId,
    placementOverride: task.placementOverride && { ...task.placementOverride },
    assignment: task.assignment && { ...task.assignment },
    placement: task.placement && structuredClone(task.placement),
    attempts: task.attemptRunIds.flatMap((runId) => {
      const run = runs.get(runId);
      return run ? [{
        runId: run.id, attempt: run.attempt, status: run.status, agentId: run.agentId,
        ...(run.instanceId === undefined ? {} : { instanceId: run.instanceId }), nodeId: run.nodeId,
        createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt, error: run.error,
        transport: run.transport ?? "native-cli",
        ...(run.transportSelection ? { transportSelection: structuredClone(run.transportSelection) } : {})
      }] : [];
    }),
    result: task.result,
    error: task.error,
    progress: task.progress && structuredClone(task.progress),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    finishedAt: task.finishedAt
  };
}

/** A deterministic view of one task, visible only from within its own thread. */
export function taskContextProjection(state: Readonly<State>, threadId: string, taskId: string) {
  const task = state.tasks?.find((item) => item.id === taskId && item.threadId === threadId);
  if (!task) throw new CoordinationError("not_found", "Task not found");
  return projectTask(state, task);
}

/** Every task in a thread, in submission order. */
export function threadTaskGraph(state: Readonly<State>, threadId: string) {
  return (state.tasks ?? []).filter((task) => task.threadId === threadId).map((task) => projectTask(state, task));
}
