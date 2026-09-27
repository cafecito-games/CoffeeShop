import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  agentAvatarColors,
  agentAvatarShapes,
  artifactPreviewAccessState,
  artifactPreviewTtlPolicy,
  canTransitionSessionBinding,
  harnessEventStreamStatuses,
  isApprovalDeliveryStatus,
  isApprovalStatus,
  isArtifactPreviewFailureCode,
  isTaskDependencyPolicy,
  isTimestamp,
  isTaskStatus,
  isWorkspaceCleanupPolicy,
  isWorkspaceIsolationPolicy,
  isWorkspaceLeaseStatus,
  isOrchestratorAttachmentStatus,
  isOrchestratorClientScope,
  orchestrationCollections,
  previewBundleArtifactKind,
  previewBundleLimits,
  previewBundleMediaType,
  runSourceKey,
  validateArtifactPreviewRecord,
  validateProjectProfile,
  withOrchestrationDefaults,
  type ArtifactPreviewFailureCode,
  type ArtifactPreviewRecord,
  type ChatMessage,
  type OrchestratorClient,
  type ProjectProfile,
  type Run,
  type Snapshot,
  type Thread,
  type TimelineEvent
} from "@coffee-shop/protocol";
import { assertPersistedActor, type ActorKeyed } from "./actors.js";
import { assertPersistedTemplateState, importLegacyAgentTemplates, type LegacyTemplateImport } from "./agentTemplates.js";
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
  /** Version-5 attribution: the resident instance and allocation that submitted the batch. */
  creatorInstanceId?: string;
  creatorAllocationId?: string;
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
  /** Compatibility attribution; absent when the updating attempt was instance-keyed. */
  agentId?: string;
  /** Version-5 attribution: the resident instance and allocation of the updating attempt. */
  instanceId?: string;
  allocationId?: string;
  idempotencyKey: string;
  /** SHA-256 of the normalized update and its source run. */
  digest: string;
  createdAt: string;
}

/** One durable source-scoped decision to create an artifact and its lifecycle record. */
export interface PreviewRegistrationReceipt {
  id: string;
  sourceKey: string;
  idempotencyKey: string;
  /** SHA-256 of the normalized semantic request and its complete caller identity. */
  digest: string;
  /** The normalized requested TTL, retained so load can verify the semantic digest after renewal. */
  ttlSeconds: number;
  artifactId: string;
  previewId: string;
  createdAt: string;
}

/** One normalized terminal result for a single preview processing generation. */
export interface PreviewProcessingReceipt {
  id: string;
  previewId: string;
  artifactId: string;
  artifactSha256: string;
  processingGeneration: number;
  outcome: "ready" | "failed";
  failureCode?: ArtifactPreviewFailureCode;
  /** SHA-256 of semantic identity/outcome fields; producer timestamps are deliberately excluded. */
  digest: string;
  settledAt: string;
}

export interface PreviewRegistrationDigestInput {
  sourceKey: string;
  threadId: string;
  runId: string;
  agentId?: string;
  instanceId?: string;
  allocationId?: string;
  idempotencyKey: string;
  relativePath: string;
  title: string;
  kind: string;
  mediaType: string;
  summary: string;
  size: number;
  sha256: string;
  entrypoint: string;
  ttlSeconds: number;
}

export interface PreviewProcessingDigestInput {
  previewId: string;
  artifactId: string;
  artifactSha256: string;
  processingGeneration: number;
  outcome: "ready" | "failed";
  failureCode?: ArtifactPreviewFailureCode;
}

const semanticDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const previewActorDigest = (input: { agentId?: string; instanceId?: string; allocationId?: string }) =>
  input.agentId !== undefined ? ["agent", input.agentId] : ["instance", input.instanceId, input.allocationId];

/** Canonical digest for one source-scoped registration; generated ids and timestamps are excluded. */
export const previewRegistrationDigest = (input: PreviewRegistrationDigestInput) => semanticDigest([
  "preview-registration-v1", input.sourceKey, input.threadId, input.runId, previewActorDigest(input), input.idempotencyKey,
  [input.relativePath, input.title, input.kind, input.mediaType, input.summary, input.size, input.sha256],
  [input.entrypoint, input.ttlSeconds]
]);

/** Canonical semantic settlement digest; the producer timestamp never changes replay identity. */
export const previewProcessingDigest = (input: PreviewProcessingDigestInput) => semanticDigest([
  "preview-processing-v1", input.previewId, input.artifactId, input.artifactSha256,
  input.processingGeneration, input.outcome, input.failureCode ?? null
]);

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
  /** One recorded decision per legacy agent; see `importLegacyAgentTemplates`. */
  legacyTemplateImports?: LegacyTemplateImport[];
  previewRegistrationReceipts?: PreviewRegistrationReceipt[];
  previewProcessingReceipts?: PreviewProcessingReceipt[];
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
  artifactPreviews: [],
  previewRegistrationReceipts: [],
  previewProcessingReceipts: [],
  instances: [],
  allocations: [],
  templates: [],
  instanceLifecycleReceipts: [],
  instanceReleaseIntents: [],
  instanceDeliveries: [],
  remoteReleaseRequests: [],
  nodeInstanceResidency: [],
  legacyTemplateImports: [],
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

/**
 * Adds preview collections only when they are absent from an older state. Explicit null or another
 * malformed value is preserved so validation can fail closed instead of treating corruption as an
 * empty collection.
 */
export function addArtifactPreviewDefaults(state: State) {
  let changed = false;
  if (state.artifactPreviews === undefined) { state.artifactPreviews = []; changed = true; }
  if (state.previewRegistrationReceipts === undefined) { state.previewRegistrationReceipts = []; changed = true; }
  if (state.previewProcessingReceipts === undefined) { state.previewProcessingReceipts = []; changed = true; }
  return changed;
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
    const identified = orchestrator.kind === "agent" ? isNonEmptyString(orchestrator.agentId)
      : orchestrator.kind === "instance" ? isNonEmptyString(orchestrator.instanceId)
        : orchestrator.kind === "external" ? isNonEmptyString(orchestrator.clientId) : false;
    if (!identified) throw new Error(`${context} has an unknown orchestrator`);
    /*
     * A leftover owner agent on a thread that is no longer agent-orchestrated would keep granting that
     * agent owner authority through any reader that still consults the field directly.
     */
    if (orchestrator.kind !== "agent" && thread.ownerAgentId !== undefined) {
      throw new Error(`${context} is ${orchestrator.kind}-orchestrated but still names an owner agent`);
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

/**
 * Migrates the borrowed agent key a version-5 instance record was persisted with before this change.
 *
 * Until #78 an instance record had nowhere to put its identity but the required agent key, and the
 * previous revision filled it with the instance id in two distinguishable shapes:
 *
 *  - *Both keys.* `apps/hub/src/scheduler.ts:1335` wrote `agentId: instance.id` beside
 *    `instanceId`/`allocationId` for every instance-keyed attempt, and `assignTaskAttempt`
 *    (`apps/hub/src/tasks.ts:663`) copied both onto `task.assignment`. Such a record names two actors
 *    at once, which `assertPersistedActorState` refuses.
 *  - *Agent only.* `apps/hub/src/sessionBindings.ts:170` wrote `agentId: run.agentId` — the instance id
 *    — with no instance half at all, and `apps/hub/src/coordination.ts:366,373` did the same for an
 *    instance run's artifact and its timeline event. Such a record loads, because it is a well-formed
 *    legacy agent record; it is simply attributed to an agent that does not exist. For a session
 *    binding that is not cosmetic: `bindingActorMatches` compares an agent actor to the run's instance
 *    actor, never matches, and the dispatch cold-starts the provider session while a later
 *    `session.binding` report naming the binding is rejected. Base `transportPreference` prefers
 *    `acp-v1`, so every base-revision ACP instance run wrote one.
 *
 * Both shapes are recognised without ever guessing between two actors:
 *
 *  - The both-keys shape is self-identifying: the agent key holds the *same* string as `instanceId`,
 *    and no configured agent id can equal an instance id (`newId("instance")` produces
 *    `instance_<base36>_…`, which the agent id slug generator cannot emit). Only that exact shape is
 *    stripped; a record naming a genuinely different agent and instance stays ambiguous and is left for
 *    the assertion to refuse.
 *  - The agent-only shape has no second key to compare against, so it is resolved against state: the
 *    agent key is borrowed exactly when it names no configured agent *and* does name a record in
 *    `state.instances`. An id that names a configured agent is a legacy record and is left alone even
 *    if an instance shares the id, because a valid legacy reading is never overwritten. An id that
 *    names neither is a legacy record whose agent was deleted — it keeps naming that agent and renders
 *    as the raw id, exactly as it did before this migration.
 *
 * A malformed identity is never read as an absent one: a record carrying an agent key beside a *half*
 * instance identity is left untouched in both shapes, so `assertPersistedActorState` still fails the
 * load with the missing field named.
 *
 * Setting the right actor needs the allocation the work ran under, and that is taken from the record's
 * own run rather than from the instance's current allocation: a session created under a lost allocation
 * lives in a process the replacement does not own, so inventing one would make a stale session
 * resumable by the wrong principal. When the run cannot supply it, an optional- or display-only record
 * is left as it was — the attribution degrades exactly as it already did — and a session binding is
 * closed and unlinked from its run, so the next dispatch cold-starts deliberately and the next report
 * creates a replacement instead of resuming a session nobody can address.
 */
export function dropBorrowedInstanceAgentKeys(state: State) {
  let changed = false;
  const agentIds = new Set(state.agents.map((item) => item.id));
  const instanceIds = new Set((state.instances ?? []).map((item) => item.id));
  const runsById = new Map(state.runs.map((run) => [run.id, run]));

  /** The both-keys shape: the agent key repeats `instanceId` and carries no information of its own. */
  const strip = (record: ActorKeyed | undefined) => {
    if (!record || record.agentId === undefined || record.instanceId === undefined) return;
    if (record.agentId !== record.instanceId) return;
    delete record.agentId;
    changed = true;
  };

  /** The instance the record's agent key borrowed, or `undefined` for every other shape. */
  const borrowedInstanceId = (record: ActorKeyed) => {
    const { agentId, instanceId, allocationId } = record;
    if (agentId === undefined || instanceId !== undefined || allocationId !== undefined) return undefined;
    if (agentIds.has(agentId)) return undefined;
    return instanceIds.has(agentId) ? agentId : undefined;
  };

  /** The allocation `instanceId` held when it produced the record, read from the record's own run. */
  const allocationOf = (instanceId: string, runIds: readonly (string | undefined)[]) => {
    for (const runId of runIds) {
      const run = runId === undefined ? undefined : runsById.get(runId);
      if (run?.instanceId === instanceId && run.allocationId !== undefined) return run.allocationId;
    }
    return undefined;
  };

  /**
   * Replaces a borrowed agent key with the instance identity its run recorded. Returns `"borrowed"`
   * when the shape was recognised but no allocation could be recovered, so the caller decides what a
   * record of its own kind does about it.
   */
  const adopt = (record: ActorKeyed | undefined, ...runIds: readonly (string | undefined)[]) => {
    if (!record) return "untouched" as const;
    const instanceId = borrowedInstanceId(record);
    if (instanceId === undefined) return "untouched" as const;
    const allocationId = allocationOf(instanceId, runIds);
    if (allocationId === undefined) return "borrowed" as const;
    delete record.agentId;
    record.instanceId = instanceId;
    record.allocationId = allocationId;
    changed = true;
    return "migrated" as const;
  };

  for (const run of state.runs) strip(run);
  for (const event of state.events) {
    strip(event);
    adopt(event, event.runId);
  }
  for (const message of state.messages) {
    strip(message);
    adopt(message, message.runId);
  }
  for (const artifact of state.artifacts ?? []) {
    strip(artifact);
    adopt(artifact, artifact.runId);
  }
  for (const update of state.taskUpdates ?? []) {
    strip(update);
    adopt(update, update.sourceRunId);
  }
  for (const approval of state.approvals ?? []) {
    strip(approval);
    adopt(approval, approval.runId);
  }
  for (const task of state.tasks ?? []) {
    strip(task.assignment);
    adopt(task.assignment, task.assignment?.runId);
  }
  for (const binding of state.sessionBindings ?? []) {
    strip(binding);
    if (adopt(binding, binding.createdByRunId, binding.lastRunId) !== "borrowed") continue;
    /*
     * The session's own allocation is unrecoverable, so the binding can never be matched to a run
     * again. It keeps the agent key it was written with — an actor-less binding would fail the load —
     * and is closed and unlinked, which is the honest outcome: the run cold-starts.
     */
    if (canTransitionSessionBinding(binding.status, "closed")) {
      binding.status = "closed";
      changed = true;
    }
    for (const run of state.runs) {
      if (run.sessionBindingId !== binding.id) continue;
      delete run.sessionBindingId;
      changed = true;
    }
  }
  return changed;
}

/**
 * Rejects persisted runtime records whose actor identity the hub cannot interpret. Every record that
 * names who produced it must name exactly one actor: a configured agent, or an instance together with
 * the exact allocation it ran under. A record naming both, or half an instance identity, fails the
 * load with the offending field named — it is never coerced to the legacy agent path, defaulted, or
 * dropped, because either would silently hand a record to the wrong principal.
 *
 * A record that names no actor at all is accepted only where the hub legitimately writes one: an
 * event or a chat message it authored itself, or a task update from a principal with no agent. A run,
 * a task assignment, and an artifact must always say whose work they are.
 */
export function assertPersistedActorState(state: State) {
  for (const [index, run] of state.runs.entries()) assertPersistedActor(run, `Persisted run ${index}`, true);
  for (const [index, event] of state.events.entries()) assertPersistedActor(event, `Persisted event ${index}`, false);
  for (const [index, message] of state.messages.entries()) assertPersistedActor(message, `Persisted message ${index}`, false);
  for (const [index, artifact] of (state.artifacts ?? []).entries()) assertPersistedActor(artifact, `Persisted artifact ${index}`, true);
  for (const [index, update] of (state.taskUpdates ?? []).entries()) assertPersistedActor(update, `Persisted task update ${index}`, false);
  for (const [index, task] of (state.tasks ?? []).entries()) {
    if (task.assignment !== undefined) assertPersistedActor(task.assignment, `Persisted task ${index} assignment`, true);
  }
  for (const [index, approval] of (state.approvals ?? []).entries()) {
    // An approval never carries an agent key; it is identified by its run. Only the instance half can
    // be half-written, and that must fail the load like any other truncated actor identity.
    assertPersistedActor(approval, `Persisted approval ${index}`, false);
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
const hasOnlyStoredKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const isDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

const previewArtifactKeys = [
  "id", "threadId", "runId", "agentId", "instanceId", "allocationId", "relativePath", "title", "kind",
  "mediaType", "summary", "size", "sha256", "downloadPath", "uploaded", "idempotencyKey", "createdAt"
] as const;
const registrationReceiptKeys = ["id", "sourceKey", "idempotencyKey", "digest", "ttlSeconds", "artifactId", "previewId", "createdAt"] as const;
const processingReceiptKeys = [
  "id", "previewId", "artifactId", "artifactSha256", "processingGeneration", "outcome", "failureCode", "digest", "settledAt"
] as const;

const sameActor = (
  left: { agentId?: string; instanceId?: string; allocationId?: string },
  right: { agentId?: string; instanceId?: string; allocationId?: string }
) => left.agentId === right.agentId && left.instanceId === right.instanceId && left.allocationId === right.allocationId;

/** Rejects every preview record or private receipt the lifecycle authority could not have written. */
export function assertPersistedArtifactPreviewState(state: State) {
  if (!Array.isArray(state.artifactPreviews)) throw new Error("Persisted artifact preview collection is malformed");
  if (!Array.isArray(state.previewRegistrationReceipts)) throw new Error("Persisted preview registration receipt collection is malformed");
  if (!Array.isArray(state.previewProcessingReceipts)) throw new Error("Persisted preview processing receipt collection is malformed");

  const previews: ArtifactPreviewRecord[] = [];
  const previewIds = new Set<string>();
  const artifactLinks = new Set<string>();
  for (const [index, value] of state.artifactPreviews.entries()) {
    const validated = validateArtifactPreviewRecord(value);
    if (!validated.ok) throw new Error(`Persisted artifact preview ${index} is invalid: ${validated.reason}`);
    const preview = validated.value;
    if (previewIds.has(preview.id)) throw new Error(`Persisted artifact preview ${index} repeats preview id ${preview.id}`);
    if (artifactLinks.has(preview.artifactId)) throw new Error(`Persisted artifact preview ${index} repeats artifact link ${preview.artifactId}`);
    previewIds.add(preview.id);
    artifactLinks.add(preview.artifactId);
    previews.push(preview);

    const artifacts = (state.artifacts ?? []).filter((artifact) => artifact.id === preview.artifactId);
    if (artifacts.length !== 1) throw new Error(`Persisted artifact preview ${index} names missing or duplicated artifact ${preview.artifactId}`);
    const artifact = artifacts[0];
    if (!isRecord(artifact) || !hasOnlyStoredKeys(artifact, previewArtifactKeys)
      || !isNonEmptyString(artifact.id) || !isNonEmptyString(artifact.threadId) || !isNonEmptyString(artifact.runId)
      || !isNonEmptyString(artifact.relativePath) || !isNonEmptyString(artifact.title) || typeof artifact.summary !== "string"
      || typeof artifact.size !== "number" || !Number.isSafeInteger(artifact.size) || artifact.size <= 0
      || artifact.size > previewBundleLimits.maximumCompressedBytes || !isDigest(artifact.sha256)
      || !isNonEmptyString(artifact.downloadPath) || typeof artifact.uploaded !== "boolean"
      || !isNonEmptyString(artifact.idempotencyKey) || !isTimestamp(artifact.createdAt)) {
      throw new Error(`Persisted artifact preview ${index} links a malformed artifact`);
    }
    if (artifact.kind !== previewBundleArtifactKind) throw new Error(`Persisted artifact preview ${index} artifact is not a preview bundle`);
    if (artifact.mediaType !== previewBundleMediaType) throw new Error(`Persisted artifact preview ${index} artifact has the wrong preview media type`);
    if (artifact.sha256 !== preview.artifactSha256) throw new Error(`Persisted artifact preview ${index} disagrees with its artifact digest`);
    if (artifact.threadId !== preview.threadId) throw new Error(`Persisted artifact preview ${index} disagrees with its artifact thread`);
    if (artifact.runId !== preview.runId) throw new Error(`Persisted artifact preview ${index} disagrees with its artifact run`);
    if (!sameActor(preview, artifact)) throw new Error(`Persisted artifact preview ${index} disagrees with its artifact actor`);
    if (artifact.createdAt !== preview.createdAt) throw new Error(`Persisted artifact preview ${index} disagrees with its artifact creation time`);
    if (artifact.downloadPath !== `/api/artifacts/${encodeURIComponent(artifact.id)}/content`) {
      throw new Error(`Persisted artifact preview ${index} has an unexpected artifact download path`);
    }

    const threads = (state.threads ?? []).filter((thread) => thread.id === preview.threadId);
    if (threads.length !== 1) throw new Error(`Persisted artifact preview ${index} names missing or duplicated thread ${preview.threadId}`);
    const runs = state.runs.filter((run) => run.id === preview.runId);
    if (runs.length !== 1 || runs[0].threadId !== preview.threadId) {
      throw new Error(`Persisted artifact preview ${index} names a missing, duplicated, or foreign run`);
    }
    if (!sameActor(preview, runs[0])) throw new Error(`Persisted artifact preview ${index} disagrees with its run actor`);
  }

  for (const [index, artifact] of (state.artifacts ?? []).entries()) {
    if (artifact.kind !== previewBundleArtifactKind) continue;
    if (previews.filter((preview) => preview.artifactId === artifact.id).length !== 1) {
      throw new Error(`Persisted preview bundle artifact ${index} has no lifecycle record`);
    }
  }

  const registrationIds = new Set<string>();
  const registrationScopes = new Set<string>();
  const registrationsByPreview = new Map<string, PreviewRegistrationReceipt[]>();
  for (const [index, value] of state.previewRegistrationReceipts.entries()) {
    if (!isRecord(value) || !hasOnlyStoredKeys(value, registrationReceiptKeys)
      || !["id", "sourceKey", "idempotencyKey", "artifactId", "previewId"].every((key) => isNonEmptyString(value[key]))
      || !isDigest(value.digest) || typeof value.ttlSeconds !== "number" || !Number.isSafeInteger(value.ttlSeconds)
      || value.ttlSeconds < artifactPreviewTtlPolicy.minimumSeconds
      || value.ttlSeconds > artifactPreviewTtlPolicy.maximumLifetimeSeconds || !isTimestamp(value.createdAt)) {
      throw new Error(`Persisted preview registration receipt ${index} is malformed`);
    }
    const receipt = value as unknown as PreviewRegistrationReceipt;
    if (registrationIds.has(receipt.id)) throw new Error(`Persisted preview registration receipt ${index} repeats receipt id ${receipt.id}`);
    registrationIds.add(receipt.id);
    const scope = `${receipt.sourceKey}\u0000${receipt.idempotencyKey}`;
    if (registrationScopes.has(scope)) throw new Error(`Persisted preview registration receipt ${index} repeats its source and idempotency key`);
    registrationScopes.add(scope);
    const preview = previews.find((item) => item.id === receipt.previewId);
    if (!preview) throw new Error(`Persisted preview registration receipt ${index} names an unknown preview`);
    if (receipt.artifactId !== preview.artifactId) throw new Error(`Persisted preview registration receipt ${index} disagrees with its preview artifact`);
    if (receipt.sourceKey !== runSourceKey(preview.runId)) throw new Error(`Persisted preview registration receipt ${index} disagrees with its preview source`);
    const artifact = (state.artifacts ?? []).find((item) => item.id === receipt.artifactId)!;
    if (receipt.idempotencyKey !== artifact.idempotencyKey) throw new Error(`Persisted preview registration receipt ${index} disagrees with its artifact key`);
    if (receipt.createdAt !== preview.createdAt) throw new Error(`Persisted preview registration receipt ${index} disagrees with its preview creation time`);
    const expectedDigest = previewRegistrationDigest({
      sourceKey: receipt.sourceKey, threadId: preview.threadId, runId: preview.runId,
      agentId: preview.agentId, instanceId: preview.instanceId, allocationId: preview.allocationId,
      idempotencyKey: receipt.idempotencyKey, relativePath: artifact.relativePath, title: artifact.title,
      kind: artifact.kind, mediaType: artifact.mediaType, summary: artifact.summary, size: artifact.size,
      sha256: artifact.sha256, entrypoint: preview.entrypoint, ttlSeconds: receipt.ttlSeconds
    });
    if (receipt.digest !== expectedDigest) throw new Error(`Persisted preview registration receipt ${index} has a corrupt digest`);
    const group = registrationsByPreview.get(preview.id) ?? [];
    group.push(receipt);
    registrationsByPreview.set(preview.id, group);
  }
  for (const [index, preview] of previews.entries()) {
    if (registrationsByPreview.get(preview.id)?.length !== 1) {
      throw new Error(`Persisted artifact preview ${index} has no registration receipt`);
    }
  }

  const processingIds = new Set<string>();
  const processingGenerations = new Set<string>();
  const processingByPreview = new Map<string, PreviewProcessingReceipt[]>();
  for (const [index, value] of state.previewProcessingReceipts.entries()) {
    const outcomeValid = isRecord(value) && (value.outcome === "ready" || value.outcome === "failed");
    const failureValid = outcomeValid && (value.outcome === "ready"
      ? value.failureCode === undefined
      : isArtifactPreviewFailureCode(value.failureCode));
    if (!isRecord(value) || !hasOnlyStoredKeys(value, processingReceiptKeys)
      || !["id", "previewId", "artifactId"].every((key) => isNonEmptyString(value[key]))
      || !isDigest(value.artifactSha256) || !Number.isSafeInteger(value.processingGeneration)
      || (value.processingGeneration as number) < 1 || !failureValid || !isDigest(value.digest) || !isTimestamp(value.settledAt)) {
      throw new Error(`Persisted preview processing receipt ${index} is malformed`);
    }
    const receipt = value as unknown as PreviewProcessingReceipt;
    if (processingIds.has(receipt.id)) throw new Error(`Persisted preview processing receipt ${index} repeats receipt id ${receipt.id}`);
    processingIds.add(receipt.id);
    const generationKey = `${receipt.previewId}\u0000${receipt.processingGeneration}`;
    if (processingGenerations.has(generationKey)) throw new Error(`Persisted preview processing receipt ${index} repeats its preview generation`);
    processingGenerations.add(generationKey);
    const preview = previews.find((item) => item.id === receipt.previewId);
    if (!preview) throw new Error(`Persisted preview processing receipt ${index} names an unknown preview`);
    if (receipt.artifactId !== preview.artifactId || receipt.artifactSha256 !== preview.artifactSha256) {
      throw new Error(`Persisted preview processing receipt ${index} disagrees with its preview artifact`);
    }
    if (receipt.processingGeneration > preview.processingGeneration) {
      throw new Error(`Persisted preview processing receipt ${index} exceeds its preview generation`);
    }
    const settled = Date.parse(receipt.settledAt);
    if (settled < Date.parse(preview.createdAt) || settled > Date.parse(preview.updatedAt) || settled >= Date.parse(preview.expiresAt)) {
      throw new Error(`Persisted preview processing receipt ${index} has an out-of-order settlement time`);
    }
    if (receipt.digest !== previewProcessingDigest(receipt)) {
      throw new Error(`Persisted preview processing receipt ${index} has a corrupt digest`);
    }
    const group = processingByPreview.get(preview.id) ?? [];
    group.push(receipt);
    processingByPreview.set(preview.id, group);
  }

  for (const [index, preview] of previews.entries()) {
    const current = (processingByPreview.get(preview.id) ?? [])
      .find((receipt) => receipt.processingGeneration === preview.processingGeneration);
    if ((preview.status === "ready" || (preview.status === "failed" && preview.processingGeneration > 0))
      && (current === undefined || current.outcome !== preview.status
        || (preview.status === "failed" && current.failureCode !== preview.failureCode))) {
      throw new Error(`Persisted artifact preview ${index} has no matching processing receipt`);
    }
    if (preview.status === "processing" && current !== undefined) {
      throw new Error(`Persisted artifact preview ${index} is processing a generation that already settled`);
    }
  }
}

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
    .filter((run) => legacyDemoRunIds.has(run.id) || agentIds.has(run.agentId ?? ""))
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
    !agentIds.has(message.agentId ?? "")
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
        objective, summary: "", status: "completed",
        ...(root.agentId === undefined ? {} : { ownerAgentId: root.agentId, orchestrator: { kind: "agent" as const, agentId: root.agentId } }),
        createdBy: "user",
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
    addArtifactPreviewDefaults(loaded);
    if (this.sqlite) loaded.projectProfiles ??= [];
    const addedApprovalResolvers = addApprovalResolverDefaults(loaded);
    assertPersistedTaskState(loaded);
    assertPersistedHarnessState(loaded);
    assertPersistedWorkspaceLeaseState(loaded);
    assertPersistedSessionState(loaded);
    assertPersistedOrchestratorClientState(loaded);
    assertPersistedProjectProfiles(loaded);
    assertPersistedInstanceState(loaded);
    assertPersistedTemplateState(loaded);
    /*
     * Runs before the actor assertion: a record the previous revision wrote with the borrowed agent
     * key is migrated, and only a genuinely ambiguous one is refused. It deliberately stays *after*
     * the session and instance assertions rather than ahead of them. Neither borrowed shape is refused
     * by an earlier assertion — the both-keys shape reaches only `assertPersistedActorState`, and the
     * agent-only shape is a well-formed legacy agent record until this migration reinterprets it — so
     * running earlier would buy nothing, while this migration resolves an agent key against
     * `state.instances`, `state.agents` and `state.runs` and so must run on an inventory
     * `assertPersistedInstanceState` has already validated.
     */
    const droppedBorrowedKeys = dropBorrowedInstanceAgentKeys(loaded);
    assertPersistedActorState(loaded);
    assertPersistedArtifactPreviewState(loaded);
    /*
     * The legacy import runs after every assertion, so it never writes on top of state the hub could
     * not interpret, and it is decided from its own persisted records rather than from a timestamp:
     * a restart finds every earlier decision and writes nothing.
     */
    const importedTemplates = importLegacyAgentTemplates(loaded, new Date().toISOString());
    if (this.sqlite || removedDemoRecords || addedAgentAvatars || addedCoordination || addedThreads || addedOrchestration
      || addedThreadOrchestrators || addedApprovalResolvers || droppedBorrowedKeys || importedTemplates) await this.save(loaded);
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

  snapshot(now = new Date().toISOString()): Snapshot {
    const {
      taskSubmissions: _taskSubmissions, taskUpdates: _taskUpdates, taskEventJournal: _taskEventJournal, taskEventStreams: _taskEventStreams,
      harnessEventStreams: _harnessEventStreams, harnessEvents: _harnessEvents,
      instanceLifecycleReceipts: _instanceLifecycleReceipts, instanceReleaseIntents: _instanceReleaseIntents,
      instanceDeliveries: _instanceDeliveries, remoteReleaseRequests: _remoteReleaseRequests,
      nodeInstanceResidency: _nodeInstanceResidency,
      previewRegistrationReceipts: _previewRegistrationReceipts, previewProcessingReceipts: _previewProcessingReceipts,
      projectProfilesImported: _projectProfilesImported, orchestratorClients, artifactPreviews, ...published
    } = this.state;
    return structuredClone({
      ...published,
      ...(orchestratorClients === undefined ? {} : { orchestratorClients: orchestratorClients.map(publicOrchestratorClient) }),
      ...(artifactPreviews === undefined ? {} : {
        artifactPreviews: artifactPreviews.map((preview) => ({
          ...preview,
          accessState: artifactPreviewAccessState(preview, now)
        }))
      }),
      generatedAt: now
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

/**
 * How an event or chat message names the actor behind a run. A version-5 instance run names both
 * halves of its identity — the instance and the exact allocation — and never an `agentId`, which is
 * typed as a configured-agent key. A legacy run names its configured agent, and only while that
 * agent is still configured, so no reader is pointed at a record that is not there. Every writer
 * that attributes a record to a run uses this, so the two run shapes can never drift apart one call
 * site at a time.
 */
export const runAttribution = (
  state: Readonly<State>,
  run: Pick<Run, "agentId" | "instanceId" | "allocationId"> | undefined
): { agentId?: string; instanceId?: string; allocationId?: string } => {
  if (run === undefined) return {};
  if (run.instanceId !== undefined && run.allocationId !== undefined) {
    return { instanceId: run.instanceId, allocationId: run.allocationId };
  }
  return run.agentId !== undefined && state.agents.some((item) => item.id === run.agentId) ? { agentId: run.agentId } : {};
};

/**
 * The actor keys a runtime *record* copies from its run. Unlike `runAttribution` this is record
 * identity rather than display attribution, so it does not require the named agent to still be
 * configured: a session binding, assignment, or artifact must record whose execution context it
 * belongs to even after that agent was deleted from the roster.
 */
export const runActorKeys = (
  run: Pick<Run, "agentId" | "instanceId" | "allocationId">
): { agentId?: string; instanceId?: string; allocationId?: string } => {
  if (run.instanceId !== undefined && run.allocationId !== undefined) {
    return { instanceId: run.instanceId, allocationId: run.allocationId };
  }
  return run.agentId === undefined ? {} : { agentId: run.agentId };
};

/** Whether an attribution names an actor at all; an unattributable run writes no chat message. */
export const hasAttribution = (attribution: { agentId?: string; instanceId?: string }) =>
  attribution.agentId !== undefined || attribution.instanceId !== undefined;
