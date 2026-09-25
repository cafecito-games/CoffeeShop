import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  agentAvatarColors,
  agentAvatarShapes,
  harnessEventStreamStatuses,
  isApprovalDeliveryStatus,
  isApprovalStatus,
  isTaskDependencyPolicy,
  isTaskStatus,
  isWorkspaceCleanupPolicy,
  isWorkspaceIsolationPolicy,
  isWorkspaceLeaseStatus,
  isOrchestratorAttachmentStatus,
  isOrchestratorClientScope,
  orchestrationCollections,
  validateProjectProfile,
  withOrchestrationDefaults,
  type ChatMessage,
  type OrchestratorClient,
  type ProjectProfile,
  type Snapshot,
  type Thread,
  type TimelineEvent
} from "@coffee-shop/protocol";
import type { HarnessEventStream, StoredHarnessEvent } from "./harnessEvents.js";
import {
  assertPersistedInstanceState,
  type InstanceDeliveryRecord,
  type InstanceLifecycleReceipt,
  type InstanceReleaseIntent,
  type NodeInstanceResidency,
  type RemoteReleaseRequest
} from "./instances.js";
import { assertPersistedSessionState } from "./persistedSessionState.js";
import { recordTaskEvents, type TaskEventEntry, type TaskEventStream } from "./taskEvents.js";

/** The hub's durable record of one accepted task batch, used to answer idempotent replays. */
export interface TaskSubmission {
  id: string;
  threadId: string;
  /** The submitting run; absent when an external orchestrator submitted the batch. */
  sourceRunId?: string;
  /** The submitting principal; written only when it is not the run named by `sourceRunId`. */
  sourceKey?: string;
  /** The agent the submitting run executes as; absent for an external orchestrator. */
  creatorAgentId?: string;
  idempotencyKey: string;
  /**
   * The key space the idempotency key belongs to. Absent for a caller-supplied batch; a batch the
   * hub derives on a caller's behalf names its own origin so the two spaces cannot collide even on
   * an identical key string.
   */
  origin?: "instance-lifecycle";
  /** SHA-256 of the normalized batch; see `taskBatchDigest`. */
  digest: string;
  tasks: Array<{ key: string; taskId: string }>;
  createdAt: string;
}

/** The hub's durable record of one accepted `update_task` call, used to answer idempotent replays. */
export interface TaskUpdateRecord {
  id: string;
  threadId: string;
  taskId: string;
  sourceRunId: string;
  agentId: string;
  idempotencyKey: string;
  /** SHA-256 of the normalized update and its source run. */
  digest: string;
  createdAt: string;
}

/**
 * The hub's own record of a minted orchestrator credential. It adds the secret hash, which is
 * stripped by `Store.snapshot()` and therefore never reaches a client.
 */
export interface StoredOrchestratorClient extends OrchestratorClient {
  secretHash: string;
}

/** Hub-internal collections that are persisted but never published in snapshots. */
interface HubOnlyState {
  taskSubmissions?: TaskSubmission[];
  taskUpdates?: TaskUpdateRecord[];
  taskEventJournal?: TaskEventEntry[];
  taskEventStreams?: TaskEventStream[];
  harnessEventStreams?: HarnessEventStream[];
  harnessEvents?: StoredHarnessEvent[];
  /** Version-5 instance lifecycle idempotency receipts, release intents, and delivery decisions. */
  instanceLifecycleReceipts?: InstanceLifecycleReceipt[];
  instanceReleaseIntents?: InstanceReleaseIntent[];
  instanceDeliveries?: InstanceDeliveryRecord[];
  remoteReleaseRequests?: RemoteReleaseRequest[];
  /**
   * The resident set of each node, replaced wholesale by its latest report of resident identities —
   * every heartbeat as well as its reconnect barrier. It is the hub's single record of residency.
   */
  nodeInstanceResidency?: NodeInstanceResidency[];
  /** Prevents a deliberately emptied catalog from re-importing the legacy profiles file. */
  projectProfilesImported?: boolean;
}

/** The persisted state. `orchestratorClients` holds the stored records, secret hash included. */
export type State = Omit<Snapshot, "generatedAt" | "orchestratorClients"> & HubOnlyState & {
  orchestratorClients?: StoredOrchestratorClient[];
};

const emptyState = (): State => withOrchestrationDefaults({
  agents: [],
  nodes: [],
  runs: [],
  events: [],
  messages: [],
  threads: [],
  delegations: [],
  artifacts: [],
  instances: [],
  allocations: [],
  templates: [],
  instanceLifecycleReceipts: [],
  instanceReleaseIntents: [],
  instanceDeliveries: [],
  remoteReleaseRequests: [],
  nodeInstanceResidency: [],
  taskSubmissions: [],
  taskUpdates: [],
  taskEventJournal: [],
  taskEventStreams: [],
  runActivity: [],
  harnessEventStreams: [],
  harnessEvents: [],
  orchestratorInboxes: [],
  orchestratorClients: [],
  orchestratorAttachments: [],
  projectProfiles: []
});

export function addOrchestrationDefaults(state: State) {
  const changed = orchestrationCollections.some((collection) => state[collection] == null) || state.taskSubmissions == null
    || state.taskUpdates == null || state.taskEventJournal == null || state.taskEventStreams == null
    || state.runActivity == null || state.harnessEventStreams == null || state.harnessEvents == null || state.orchestratorInboxes == null
    || state.orchestratorClients == null || state.orchestratorAttachments == null;
  withOrchestrationDefaults(state);
  state.taskSubmissions ??= [];
  state.taskUpdates ??= [];
  state.taskEventJournal ??= [];
  state.taskEventStreams ??= [];
  state.runActivity ??= [];
  state.harnessEventStreams ??= [];
  state.harnessEvents ??= [];
  state.orchestratorInboxes ??= [];
  state.orchestratorClients ??= [];
  state.orchestratorAttachments ??= [];
  return changed;
}

/**
 * Initializes the version-5 instance collections of a snapshot persisted before they existed. Empty
 * defaults are deterministic: no legacy record is migrated into an instance or allocation, and an
 * absent collection is not a migration, so a legacy file the hub loads is not rewritten for this —
 * the defaults reach disk with the next real transaction. Only a missing field is a legacy
 * snapshot: an explicitly present but malformed value (null, wrong type) is left for validation to
 * reject, never silently replaced with a default.
 */
export function addInstanceDefaults(state: State) {
  if (state.instances === undefined) state.instances = [];
  if (state.allocations === undefined) state.allocations = [];
  if (state.templates === undefined) state.templates = [];
  if (state.instanceLifecycleReceipts === undefined) state.instanceLifecycleReceipts = [];
  if (state.instanceReleaseIntents === undefined) state.instanceReleaseIntents = [];
  if (state.instanceDeliveries === undefined) state.instanceDeliveries = [];
  if (state.remoteReleaseRequests === undefined) state.remoteReleaseRequests = [];
  if (state.nodeInstanceResidency === undefined) state.nodeInstanceResidency = [];
}

/** Rejects malformed or duplicate persisted profiles before they can affect scheduling. */
export function assertPersistedProjectProfiles(state: State) {
  const ids = new Set<string>();
  for (const [index, profile] of (state.projectProfiles ?? []).entries()) {
    const validated = validateProjectProfile(profile);
    if (!validated.ok) throw new Error(`Persisted project profile ${index} is invalid: ${validated.reason}`);
    if (ids.has(validated.value.id)) throw new Error(`Persisted project profile ${index} repeats project id ${validated.value.id}`);
    ids.add(validated.value.id);
  }
}

/**
 * Derives `Thread.orchestrator` for threads persisted before external orchestrators existed. A
 * thread with neither an orchestrator nor an owner agent is left unchanged and is simply not
 * agent-orchestrated; inventing an owner would hand the thread to an arbitrary agent.
 *
 * `Store.load` runs this before the thread migrations that dereference each entry, so a persisted
 * thread that is not an object fails the load with a diagnosable reason rather than a TypeError.
 */
export function addThreadOrchestratorDefaults(state: State) {
  let changed = false;
  for (const [index, thread] of (state.threads ?? []).entries()) {
    if (!isRecord(thread)) throw new Error(`Persisted thread ${index} is not an object`);
    if (thread.orchestrator !== undefined || thread.ownerAgentId === undefined) continue;
    thread.orchestrator = { kind: "agent", agentId: thread.ownerAgentId };
    changed = true;
  }
  return changed;
}

/**
 * Rewrites the pre-union `resolvedBy` string of a persisted approval into `ApprovalResolvedBy`.
 * Only the three values the hub ever wrote are accepted; anything else fails the load.
 */
export function addApprovalResolverDefaults(state: State) {
  let changed = false;
  for (const [index, approval] of (state.approvals ?? []).entries()) {
    if (!isRecord(approval)) throw new Error(`Persisted approval ${index} is not an object`);
    const resolvedBy: unknown = approval.resolvedBy;
    if (typeof resolvedBy !== "string") continue;
    if (resolvedBy !== "operator" && resolvedBy !== "policy" && resolvedBy !== "system") {
      throw new Error(`Persisted approval ${index} has an unknown resolver`);
    }
    approval.resolvedBy = { kind: resolvedBy };
    changed = true;
  }
  return changed;
}

/**
 * Rejects persisted orchestrator credentials, attachments, and thread orchestrators the hub cannot
 * interpret. An unknown scope or status is never defaulted: a guessed scope could grant authority.
 */
export function assertPersistedOrchestratorClientState(state: State) {
  const clientIds = new Set<string>();
  for (const [index, client] of (state.orchestratorClients ?? []).entries()) {
    const context = `Persisted orchestrator client ${index}`;
    if (!isRecord(client) || !isNonEmptyString(client.id) || !isNonEmptyString(client.name) || !isNonEmptyString(client.secretHash) || !isNonEmptyString(client.createdAt)) {
      throw new Error(`${context} is missing its identity`);
    }
    if (clientIds.has(client.id)) throw new Error(`${context} repeats client id ${client.id}`);
    clientIds.add(client.id);
    if (!Array.isArray(client.scopes) || !client.scopes.every(isOrchestratorClientScope)) throw new Error(`${context} has an unknown scope`);
  }
  const attachmentIds = new Set<string>();
  for (const [index, attachment] of (state.orchestratorAttachments ?? []).entries()) {
    const context = `Persisted orchestrator attachment ${index}`;
    if (!isRecord(attachment) || !isNonEmptyString(attachment.id) || !isNonEmptyString(attachment.threadId)
      || !isNonEmptyString(attachment.clientId) || !isNonEmptyString(attachment.connectionId)) {
      throw new Error(`${context} is missing its identity`);
    }
    if (attachmentIds.has(attachment.id)) throw new Error(`${context} repeats attachment id ${attachment.id}`);
    attachmentIds.add(attachment.id);
    if (!isOrchestratorAttachmentStatus(attachment.status)) throw new Error(`${context} has an unknown status`);
  }
  const threadIds = new Set<string>();
  for (const [index, thread] of (state.threads ?? []).entries()) {
    const context = `Persisted thread ${index}`;
    if (!isRecord(thread)) throw new Error(`${context} is not an object`);
    if (isNonEmptyString(thread.id)) threadIds.add(thread.id);
    const orchestrator: unknown = thread.orchestrator;
    if (orchestrator === undefined) continue;
    if (!isRecord(orchestrator)) throw new Error(`${context} has a malformed orchestrator`);
    if (orchestrator.kind === "agent" ? !isNonEmptyString(orchestrator.agentId) : orchestrator.kind === "external" ? !isNonEmptyString(orchestrator.clientId) : true) {
      throw new Error(`${context} has an unknown orchestrator`);
    }
    // A leftover owner agent on an external thread would keep granting that agent owner authority.
    if (orchestrator.kind === "external" && thread.ownerAgentId !== undefined) {
      throw new Error(`${context} is externally orchestrated but still names an owner agent`);
    }
    if (orchestrator.kind === "agent" && thread.ownerAgentId !== orchestrator.agentId) {
      throw new Error(`${context} disagrees with its own owner agent`);
    }
  }
  /*
   * An attachment is a claim by one credential on one thread. A claim naming a credential or a
   * thread that is not in this snapshot cannot be interpreted, let alone released, so the load
   * fails rather than carrying a dangling attachment into a running hub.
   */
  for (const [index, attachment] of (state.orchestratorAttachments ?? []).entries()) {
    const context = `Persisted orchestrator attachment ${index}`;
    if (!clientIds.has(attachment.clientId)) throw new Error(`${context} names unknown orchestrator client ${attachment.clientId}`);
    if (!threadIds.has(attachment.threadId)) throw new Error(`${context} names unknown thread ${attachment.threadId}`);
  }
}

/** Rejects persisted approvals and event streams whose status the hub cannot interpret. */
export function assertPersistedHarnessState(state: State) {
  for (const [index, approval] of (state.approvals ?? []).entries()) {
    const context = `Persisted approval ${index}`;
    if (!isRecord(approval) || !isNonEmptyString(approval.id) || !isNonEmptyString(approval.runId) || !isNonEmptyString(approval.harnessApprovalId) || !isNonEmptyString(approval.nodeId)) {
      throw new Error(`${context} is missing its identity`);
    }
    if (!isApprovalStatus(approval.status)) throw new Error(`${context} has an unknown status`);
    if (approval.delivery !== undefined && (!isRecord(approval.delivery) || !isApprovalDeliveryStatus(approval.delivery.status))) throw new Error(`${context} has an unknown delivery status`);
    if (approval.resolvedBy !== undefined && (!isRecord(approval.resolvedBy) || !isApprovalResolvedBy(approval.resolvedBy))) throw new Error(`${context} has an unknown resolver`);
  }
  for (const [index, stream] of (state.harnessEventStreams ?? []).entries()) {
    if (!isRecord(stream) || !isNonEmptyString(stream.runId) || !(harnessEventStreamStatuses as readonly unknown[]).includes(stream.status)
      || !Number.isSafeInteger(stream.lastSequence) || !Array.isArray(stream.recentDigests)) {
      throw new Error(`Persisted harness event stream ${index} is malformed`);
    }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const isApprovalResolvedBy = (value: Record<string, unknown>) =>
  value.kind === "orchestrator"
    ? isNonEmptyString(value.clientId) && isNonEmptyString(value.attachmentId)
    : value.kind === "operator" || value.kind === "policy" || value.kind === "system";

/**
 * Rejects persisted orchestration records the hub cannot interpret. Loading fails rather than
 * defaulting an unknown status, because a guessed `pending` or `ready` could release work.
 */
export function assertPersistedTaskState(state: State) {
  const taskIds = new Set<string>();
  for (const [index, task] of (state.tasks ?? []).entries()) {
    const context = `Persisted task ${index}`;
    if (!isRecord(task) || !isNonEmptyString(task.id) || !isNonEmptyString(task.threadId)) throw new Error(`${context} is missing its identity`);
    if (taskIds.has(task.id)) throw new Error(`${context} repeats task id ${task.id}`);
    taskIds.add(task.id);
    if (!isTaskStatus(task.status)) throw new Error(`${context} has an unknown status`);
    if (!Array.isArray(task.dependencies) || !task.dependencies.every((dependency) => isRecord(dependency) && isNonEmptyString(dependency.taskId) && isTaskDependencyPolicy(dependency.policy))) {
      throw new Error(`${context} has malformed dependencies`);
    }
    if (!Array.isArray(task.attemptRunIds) || !task.attemptRunIds.every(isNonEmptyString)) throw new Error(`${context} has malformed attempts`);
    if (!isRecord(task.requirements) || typeof task.idempotencyKey !== "string") throw new Error(`${context} is missing requirements or its idempotency key`);
  }
  for (const [index, submission] of (state.taskSubmissions ?? []).entries()) {
    if (!isRecord(submission) || !isNonEmptyString(submission.id) || !isNonEmptyString(submission.threadId) || !isNonEmptyString(submission.idempotencyKey)
      || !isNonEmptyString(submission.digest) || !Array.isArray(submission.tasks)
      || !submission.tasks.every((entry) => isRecord(entry) && isNonEmptyString(entry.key) && isNonEmptyString(entry.taskId))
      || (submission.origin !== undefined && submission.origin !== "instance-lifecycle")) {
      throw new Error(`Persisted task submission ${index} is malformed`);
    }
  }
  const streams = new Map<string, { head: number; floor: number }>();
  for (const [index, stream] of (state.taskEventStreams ?? []).entries()) {
    if (!isRecord(stream) || !isNonEmptyString(stream.threadId) || !isSequence(stream.head) || !isSequence(stream.floor)
      || stream.floor > stream.head || streams.has(stream.threadId)) {
      throw new Error(`Persisted task event stream ${index} is malformed`);
    }
    streams.set(stream.threadId, { head: stream.head, floor: stream.floor });
  }
  for (const [index, entry] of (state.taskEventJournal ?? []).entries()) {
    const bounds = isRecord(entry) && isNonEmptyString(entry.threadId) ? streams.get(entry.threadId) : undefined;
    if (!bounds || !isSequence(entry.sequence) || entry.sequence <= bounds.floor || entry.sequence > bounds.head
      || (entry.kind !== "message" && entry.kind !== "task")) {
      throw new Error(`Persisted task event ${index} is malformed`);
    }
  }
  for (const [index, message] of (state.taskMessages ?? []).entries()) {
    if (!isRecord(message) || !isNonEmptyString(message.id) || !isNonEmptyString(message.threadId) || !isSequence(message.sequence)
      || !isRecord(message.sender) || !isRecord(message.recipient) || typeof message.idempotencyKey !== "string") {
      throw new Error(`Persisted task message ${index} is malformed`);
    }
  }
}

const isSequence = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Rejects persisted leases the hub cannot interpret instead of guessing a status or policy. */
export function assertPersistedWorkspaceLeaseState(state: State) {
  const ids = new Set<string>();
  for (const [index, lease] of (state.workspaceLeases ?? []).entries()) {
    const context = `Persisted workspace lease ${index}`;
    if (!isRecord(lease) || !isNonEmptyString(lease.id) || !isNonEmptyString(lease.runId) || !isNonEmptyString(lease.nodeId)
      || !isNonEmptyString(lease.root) || !isNonEmptyString(lease.sourcePath) || !isNonEmptyString(lease.worktreePath)) {
      throw new Error(`${context} is missing its identity`);
    }
    if (ids.has(lease.id)) throw new Error(`${context} repeats its lease id`);
    ids.add(lease.id);
    if (!isWorkspaceLeaseStatus(lease.status)) throw new Error(`${context} has an unknown status`);
    if (!isWorkspaceIsolationPolicy(lease.policy) || !isWorkspaceCleanupPolicy(lease.cleanup)) throw new Error(`${context} has an unknown policy`);
    if (lease.policy === "git-worktree" && (!isNonEmptyString(lease.branch) || !isNonEmptyString(lease.baseRevision) || !isNonEmptyString(lease.repository))) {
      throw new Error(`${context} is missing its worktree identity`);
    }
  }
}

const legacyDemoAgents = new Map([
  ["cpp-steward", "Ada"],
  ["product-engineer", "Lin"],
  ["release-sentinel", "Sable"],
  ["research-scout", "Mira"]
]);
const legacyDemoRunIds = new Set(["run-benchmark", "run-release"]);

function removeLegacyDemoRecords(state: State) {
  const agentIds = new Set(state.agents
    .filter((agent) => legacyDemoAgents.get(agent.id) === agent.name)
    .map((agent) => agent.id));
  const runIds = new Set(state.runs
    .filter((run) => legacyDemoRunIds.has(run.id) || agentIds.has(run.agentId))
    .map((run) => run.id));
  const before = [state.agents.length, state.nodes.length, state.runs.length, state.events.length, state.messages.length];

  state.agents = state.agents.filter((agent) => !agentIds.has(agent.id));
  state.runs = state.runs.filter((run) => !runIds.has(run.id));
  state.events = state.events.filter((event) =>
    !agentIds.has(event.agentId ?? "")
    && !agentIds.has(event.fromAgentId ?? "")
    && !agentIds.has(event.toAgentId ?? "")
    && !runIds.has(event.runId ?? ""));
  state.messages = state.messages.filter((message) =>
    !agentIds.has(message.agentId)
    && !runIds.has(message.runId ?? ""));

  const referencedNodeIds = new Set([
    ...state.agents.map((agent) => agent.computeNodeId),
    ...state.runs.map((run) => run.nodeId)
  ]);
  state.nodes = state.nodes.filter((node) => {
    const isDemoNode = (node.id === "local-macbook" && node.name === "This laptop" && node.workspaceRoots.includes("/Users/you/Projects"))
      || (node.id === "home-linux" && node.name === "Home server" && node.workspaceRoots.includes("/srv/workspaces"))
      || (node.id === "cloud-runner" && node.name === "Cloud runner" && node.workspaceRoots.includes("/workspace"));
    return !isDemoNode || referencedNodeIds.has(node.id);
  });

  const after = [state.agents.length, state.nodes.length, state.runs.length, state.events.length, state.messages.length];
  return before.some((length, index) => length !== after[index]);
}

function addMissingAgentAvatars(state: State) {
  let changed = false;
  for (const agent of state.agents) {
    if (!agentAvatarShapes.includes(agent.avatarShape)) {
      agent.avatarShape = "cup";
      changed = true;
    }
    if (!agentAvatarColors.includes(agent.avatarColor)) {
      agent.avatarColor = "amber";
      changed = true;
    }
  }
  return changed;
}

function addCoordinationDefaults(state: State) {
  let changed = false;
  if (!state.delegations) { state.delegations = []; changed = true; }
  if (!state.artifacts) { state.artifacts = []; changed = true; }
  if (!state.threads) { state.threads = []; changed = true; }
  for (const agent of state.agents) {
    if (agent.canDelegate === undefined) { agent.canDelegate = false; changed = true; }
  }
  return changed;
}

function addThreadDefaults(state: State) {
  let changed = false;
  state.threads ??= [];
  const runs = new Map(state.runs.map((run) => [run.id, run]));
  const threadIdsByRootRun = new Map<string, string>();
  const generatedThreadIds = new Set<string>();
  for (const run of state.runs) {
    if (run.threadId) {
      let cursor = run;
      const seen = new Set<string>();
      while (cursor.parentRunId && runs.has(cursor.parentRunId) && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        cursor = runs.get(cursor.parentRunId)!;
      }
      threadIdsByRootRun.set(cursor.id, run.threadId);
    }
  }
  for (const run of state.runs) {
    let root = run;
    const seen = new Set<string>();
    while (root.parentRunId && runs.has(root.parentRunId) && !seen.has(root.id)) {
      seen.add(root.id);
      root = runs.get(root.parentRunId)!;
    }
    let threadId = root.threadId ?? threadIdsByRootRun.get(root.id);
    if (!threadId) {
      const objective = typeof root.prompt === "string" && root.prompt.trim() ? root.prompt.trim() : `Recovered run ${root.id}`;
      const firstLine = objective.split(/\r?\n/, 1)[0].replace(/\s+/g, " ");
      const createdAt = typeof root.createdAt === "string" ? root.createdAt : new Date().toISOString();
      const thread: Thread = {
        id: newId("thread"), title: firstLine.length <= 120 ? firstLine : `${firstLine.slice(0, 119).trimEnd()}…`,
        objective, summary: "", status: "completed", ownerAgentId: root.agentId, orchestrator: { kind: "agent", agentId: root.agentId }, createdBy: "user",
        createdAt, updatedAt: root.finishedAt ?? createdAt, completedAt: root.finishedAt ?? createdAt
      };
      state.threads.push(thread);
      generatedThreadIds.add(thread.id);
      threadId = thread.id;
      threadIdsByRootRun.set(root.id, threadId);
      changed = true;
    }
    if (!run.threadId) { run.threadId = threadId; changed = true; }
  }
  for (const thread of state.threads.filter((item) => generatedThreadIds.has(item.id))) {
    if (state.runs.some((run) => run.threadId === thread.id && (run.status === "queued" || run.status === "running"))) {
      thread.status = "active";
      thread.completedAt = undefined;
    }
  }
  const threadIdForRun = new Map(state.runs.map((run) => [run.id, run.threadId]));
  for (const delegation of state.delegations ?? []) {
    const threadId = threadIdForRun.get(delegation.parentRunId);
    if (!delegation.threadId && threadId) { delegation.threadId = threadId; changed = true; }
  }
  for (const artifact of state.artifacts ?? []) {
    const threadId = threadIdForRun.get(artifact.runId);
    if (!artifact.threadId && threadId) { artifact.threadId = threadId; changed = true; }
  }
  for (const event of state.events) {
    const threadId = event.runId && threadIdForRun.get(event.runId);
    if (!event.threadId && threadId) { event.threadId = threadId; changed = true; }
  }
  for (const message of state.messages) {
    const threadId = message.runId && threadIdForRun.get(message.runId);
    if (!message.threadId && threadId) { message.threadId = threadId; changed = true; }
  }
  return changed;
}

/**
 * Projects a stored credential to its public view by naming every published field, so a field added
 * to the stored record is never published by accident.
 */
export const publicOrchestratorClient = (client: StoredOrchestratorClient): OrchestratorClient => ({
  id: client.id,
  name: client.name,
  scopes: client.scopes,
  createdAt: client.createdAt,
  ...(client.lastSeenAt === undefined ? {} : { lastSeenAt: client.lastSeenAt }),
  ...(client.revokedAt === undefined ? {} : { revokedAt: client.revokedAt })
});

export interface SqliteStoreOptions {
  databasePath: string;
  /** A legacy JSON snapshot imported only when the database has no state yet. */
  legacyJsonPath?: string;
}

export class Store {
  private state: State = emptyState();
  private readonly path: string;
  private readonly legacyJsonPath?: string;
  private readonly sqlite: boolean;
  private database?: DatabaseSync;
  private transactionQueue: Promise<void> = Promise.resolve();
  private readonly commitListeners = new Set<(state: Readonly<State>) => void>();

  constructor(location?: string | SqliteStoreOptions) {
    if (typeof location === "string") {
      // Kept for fixture compatibility; production uses the default SQLite configuration below.
      this.path = resolve(location);
      this.sqlite = false;
      return;
    }
    const defaultLegacyPath = process.env.COFFEE_SHOP_DATA
      ?? fileURLToPath(new URL("../../../data/state.json", import.meta.url));
    this.legacyJsonPath = resolve(location?.legacyJsonPath ?? defaultLegacyPath);
    this.path = resolve(location?.databasePath ?? process.env.COFFEE_SHOP_DATABASE
      ?? resolve(dirname(this.legacyJsonPath), "coffee-shop.sqlite"));
    this.sqlite = true;
  }

  async load() {
    let loaded: State;
    if (this.sqlite) {
      await mkdir(dirname(this.path), { recursive: true });
      this.database = new DatabaseSync(this.path);
      this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      this.database.exec(`CREATE TABLE IF NOT EXISTS hub_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      const row = this.database.prepare("SELECT state_json FROM hub_state WHERE singleton = 1").get() as { state_json: string } | undefined;
      if (row) {
        loaded = JSON.parse(row.state_json) as State;
      } else {
        loaded = await this.readLegacyState() ?? emptyState();
      }
    } else {
      try {
        loaded = JSON.parse(await readFile(this.path, "utf8")) as State;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await this.save();
        return;
      }
    }
    const removedDemoRecords = removeLegacyDemoRecords(loaded);
    const addedAgentAvatars = addMissingAgentAvatars(loaded);
    const addedCoordination = addCoordinationDefaults(loaded);
    const addedThreadOrchestrators = addThreadOrchestratorDefaults(loaded);
    const addedThreads = addThreadDefaults(loaded);
    const addedOrchestration = addOrchestrationDefaults(loaded);
    addInstanceDefaults(loaded);
    if (this.sqlite) loaded.projectProfiles ??= [];
    const addedApprovalResolvers = addApprovalResolverDefaults(loaded);
    assertPersistedTaskState(loaded);
    assertPersistedHarnessState(loaded);
    assertPersistedWorkspaceLeaseState(loaded);
    assertPersistedSessionState(loaded);
    assertPersistedOrchestratorClientState(loaded);
    assertPersistedProjectProfiles(loaded);
    assertPersistedInstanceState(loaded);
    if (this.sqlite || removedDemoRecords || addedAgentAvatars || addedCoordination || addedThreads || addedOrchestration
      || addedThreadOrchestrators || addedApprovalResolvers) await this.save(loaded);
    this.state = loaded;
  }

  private async readLegacyState(): Promise<State | undefined> {
    if (!this.legacyJsonPath) return undefined;
    try {
      return JSON.parse(await readFile(this.legacyJsonPath, "utf8")) as State;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  snapshot(): Snapshot {
    const {
      taskSubmissions: _taskSubmissions, taskUpdates: _taskUpdates, taskEventJournal: _taskEventJournal, taskEventStreams: _taskEventStreams,
      harnessEventStreams: _harnessEventStreams, harnessEvents: _harnessEvents,
      instanceLifecycleReceipts: _instanceLifecycleReceipts, instanceReleaseIntents: _instanceReleaseIntents,
      instanceDeliveries: _instanceDeliveries, remoteReleaseRequests: _remoteReleaseRequests,
      nodeInstanceResidency: _nodeInstanceResidency,
      projectProfilesImported: _projectProfilesImported, orchestratorClients, ...published
    } = this.state;
    return structuredClone({
      ...published,
      ...(orchestratorClients === undefined ? {} : { orchestratorClients: orchestratorClients.map(publicOrchestratorClient) }),
      generatedAt: new Date().toISOString()
    });
  }

  /** Synchronous read of committed state; the view must not retain or mutate what it receives. */
  read<T>(view: (state: Readonly<State>) => T): T {
    return view(this.state);
  }

  getAgent(id: string) { return this.state.agents.find((agent) => agent.id === id); }
  getRun(id: string) { return this.state.runs.find((run) => run.id === id); }
  getThread(id: string) { return this.state.threads?.find((thread) => thread.id === id); }
  getInstance(id: string) { return this.state.instances?.find((instance) => instance.id === id); }
  getInstanceAllocation(id: string) { return this.state.allocations?.find((allocation) => allocation.id === id); }

  async writeArtifactContent(id: string, content: Buffer) {
    const directory = resolve(dirname(this.path), "artifacts");
    await mkdir(directory, { recursive: true });
    const destination = resolve(directory, id);
    const temporary = `${destination}.${process.pid}.tmp`;
    await writeFile(temporary, content);
    await rename(temporary, destination);
  }

  async readArtifactContent(id: string) {
    return readFile(resolve(dirname(this.path), "artifacts", id));
  }

  /**
   * Registers a listener called synchronously after each committed transaction, with the new
   * state. Listeners must not mutate or retain it; returns the unsubscribe function.
   */
  onCommit(listener: (state: Readonly<State>) => void) {
    this.commitListeners.add(listener);
    return () => { this.commitListeners.delete(listener); };
  }

  async transact(change: (state: State) => unknown) {
    const transaction = this.transactionQueue.then(async () => {
      const next = structuredClone(this.state);
      if (change(next) === false) return;
      recordTaskEvents(this.state, next, new Date().toISOString());
      await this.save(next);
      this.state = next;
      for (const listener of [...this.commitListeners]) {
        try {
          listener(next);
        } catch (error) {
          console.error("commit listener failed", error);
        }
      }
    });
    this.transactionQueue = transaction.catch(() => undefined);
    return transaction;
  }

  private async save(state = this.state) {
    await mkdir(dirname(this.path), { recursive: true });
    if (this.sqlite) {
      if (!this.database) throw new Error("SQLite store has not been loaded");
      this.database.prepare(`INSERT INTO hub_state (singleton, state_json, updated_at)
        VALUES (1, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`)
        .run(JSON.stringify(state), new Date().toISOString());
      return;
    }
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2));
    await rename(temporary, this.path);
  }
}

export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
export const newMessage = (message: Omit<ChatMessage, "id" | "createdAt">): ChatMessage => ({ ...message, id: newId("msg"), createdAt: new Date().toISOString() });
export const newEvent = (event: Omit<TimelineEvent, "id" | "createdAt">): TimelineEvent => ({ ...event, id: newId("evt"), createdAt: new Date().toISOString() });
