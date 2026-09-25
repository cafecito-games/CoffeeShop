import { createHash } from "node:crypto";
import {
  canTransitionAllocation,
  canTransitionInstance,
  defaultInstanceIdleTimeoutSeconds,
  instanceLifecycleOperations,
  instanceLifecycleDigestInput,
  isActiveRunStatus,
  supportsControlCapability,
  validateAgentInstance,
  validateAgentTemplate,
  validateInstanceAllocation,
  validateInstanceControlMessage,
  validateInstanceHubMessage,
  validateInstanceLifecycleRequest,
  type AgentInstance,
  type AgentTemplate,
  type AllocationStatus,
  type ComputeNode,
  type ControlProtocolVersion,
  type HarnessId,
  type HarnessTransport,
  type InstanceAllocation,
  type InstanceControlMessage,
  type InstanceCreator,
  type InstanceHubMessage,
  type InstanceLifecycleRequest,
  type InstanceLifecycleResult,
  type InstanceReleaseMode,
  type InstanceStatus,
  type Run
} from "@coffee-shop/protocol";
import { CoordinationError } from "./coordinationError.js";
import { newEvent, newId, type State, type Store } from "./store.js";
import { appendInitialTaskInState } from "./tasks.js";

/*
 * Ephemeral instance lifecycle authority.
 *
 * This module is the only hub authority that assigns instance and allocation statuses, reserves
 * resident capacity, records lifecycle idempotency receipts, or decides when a provision or
 * release command is persisted for delivery. REST routes, the scheduler (#77), run-scoped and
 * external orchestrator adapters (#79), expiry, and reconciliation all call in here rather than
 * mutating instance state directly.
 *
 * A lifecycle generation is the allocation identity itself: a replacement always receives a new
 * allocation id (#73), so every command and acknowledgement names the exact allocation it belongs
 * to and a delayed response from a lost allocation can never mutate its replacement.
 */

/** The resident-intent statuses: an allocation in one of these holds a node slot. */
export const occupyingAllocationStatuses: readonly AllocationStatus[] = ["reserved", "provisioning", "active"];
/** Statuses from which an instance may still be placed, replaced, or released. */
export const nonTerminalInstanceStatuses: readonly InstanceStatus[] = ["requested", "provisioning", "ready", "busy", "idle"];
export const terminalInstanceStatuses: readonly InstanceStatus[] = ["released", "failed"];

/** The single operator principal behind the hub's bearer-authenticated REST surface. */
export const operatorInstanceCreator: InstanceCreator = { kind: "operator", operatorId: "operator" };

/** Bounds on retained audit records; pruning never touches a nonterminal record or an actionable outbox entry. */
export const instanceAuditLimits = {
  retainedTerminalInstances: 200,
  retainedReceipts: 1_000,
  /**
   * Receipts kept for one instance. A live instance may be renewed or released under a new key
   * without limit, so the per-instance bound is what keeps the collection — and the idempotency
   * lookup that scans it — finite while the instance itself is retained.
   */
  retainedReceiptsPerInstance: 50
} as const;

/** The hub's durable idempotency receipt for one accepted lifecycle request. */
export interface InstanceLifecycleReceipt {
  id: string;
  threadId: string;
  /** The canonical principal identity; see `instanceCreatorSourceKey`. */
  sourceKey: string;
  idempotencyKey: string;
  operation: (typeof instanceLifecycleOperations)[number];
  /** SHA-256 of the normalized request digest input; identity fields participate, timestamps do not. */
  digest: string;
  instanceId: string;
  initialTaskId?: string;
  createdAt: string;
}

/** The recorded release request for one instance; mode escalation is monotonic. */
export interface InstanceReleaseIntent {
  instanceId: string;
  threadId: string;
  mode: InstanceReleaseMode;
  requestedAt: string;
  updatedAt: string;
}

/**
 * A lifecycle command persisted before its socket write; replayed until the peer has demonstrably
 * acted on it. `deliveredAt` records only that a socket write was accepted locally, which is not
 * proof of receipt, so it never permanently suppresses a replay: the node's next authoritative
 * snapshot re-arms a release the node has plainly not acted on, and a provision whose allocation
 * that snapshot declares lost is removed with the allocation. A record is retired only once the
 * peer's own evidence — `instance.ready`, or an acknowledged terminal transition — has arrived.
 */
export interface InstanceDeliveryRecord {
  allocationId: string;
  kind: "provision" | "release";
  nodeId: string;
  message: InstanceHubMessage;
  createdAt: string;
  /** When a socket write was accepted for this command; evidence of a send, never of receipt. */
  deliveredAt?: string;
}

/**
 * A release requested for a resident the hub does not own; never adopted as hub state. Each request
 * is an actionable outbox entry retained until it is delivered — a v5 sync can report up to
 * `instanceLimits.collectionEntries` unknown residents at once and dropping any of them would leave
 * a resident supervised indefinitely — and it is never pruned by an audit bound. It is retired only
 * by the node's own later authoritative snapshot, which no longer reports that resident. With
 * deduplication by node and instance, the requests for one node are therefore bounded by one
 * snapshot's resident set however often the node reconnects.
 */
export interface RemoteReleaseRequest {
  nodeId: string;
  instanceId: string;
  requestedAt: string;
}

export type InstanceLifecycleEvidence = Extract<InstanceControlMessage, { type: "instance.ready" | "instance.failed" | "instance.released" }>;

/**
 * The three distinct states of the resident evidence a node may carry on a version-5 sync. They
 * stay distinct at every decision point: absent means the node made no claim, `authoritative` is a
 * complete resident set (an explicit empty set included), and `malformed` is a claim the hub cannot
 * read — never a claim it did not make.
 */
export type InstanceResidentEvidence =
  | { kind: "absent" }
  | { kind: "authoritative"; residents: readonly string[] }
  | { kind: "malformed"; reason: string };

/**
 * Classifies the resident evidence of a `sync.complete` frame. The protocol validator runs before
 * the classification, so no decision is ever taken on an unvalidated field: a present but malformed
 * `activeInstanceIds` is reported as malformed instead of collapsing into absent.
 */
export function classifyInstanceResidentEvidence(frame: unknown, version: ControlProtocolVersion): InstanceResidentEvidence {
  if (!supportsControlCapability(version, "instances")) return { kind: "absent" };
  const validated = validateInstanceControlMessage(frame, version);
  if (!validated.ok) return { kind: "malformed", reason: validated.reason };
  if (validated.value.type !== "sync.complete") return { kind: "malformed", reason: "the frame is not a reconciliation barrier" };
  const residents = validated.value.activeInstanceIds;
  return residents === undefined ? { kind: "absent" } : { kind: "authoritative", residents };
}

/**
 * When instance command delivery may open for the connection that carried this evidence. Absent
 * evidence has nothing to apply, authoritative evidence must be applied first, and malformed
 * evidence fails closed: delivery stays shut until an authoritative sync arrives.
 */
export const instanceDeliveryBarrier = (evidence: InstanceResidentEvidence): "open-now" | "open-after-reconcile" | "stay-closed" =>
  evidence.kind === "absent" ? "open-now" : evidence.kind === "authoritative" ? "open-after-reconcile" : "stay-closed";

/** The reported resident count of a heartbeat: a valid count, no claim, or a claim the hub cannot read. */
export type ReportedInstanceCount =
  | { kind: "absent" }
  | { kind: "reported"; count: number }
  | { kind: "malformed"; reason: string };

/**
 * Classifies the `activeInstances` count of a heartbeat after validating the frame, so a malformed
 * count never reaches the node record and is never mistaken for an omitted one. A malformed count
 * leaves the last known usage in place rather than lowering it, because usage the hub cannot read is
 * unknown, not zero.
 */
export function classifyReportedInstanceCount(frame: unknown, version: ControlProtocolVersion): ReportedInstanceCount {
  if (!supportsControlCapability(version, "instances")) return { kind: "absent" };
  const validated = validateInstanceControlMessage(frame, version);
  if (!validated.ok) return { kind: "malformed", reason: validated.reason };
  if (validated.value.type !== "heartbeat") return { kind: "malformed", reason: "the frame is not a heartbeat" };
  const count = validated.value.activeInstances;
  return count === undefined ? { kind: "absent" } : { kind: "reported", count };
}

/** The canonical principal identity of a lifecycle caller; the two namespaces never collide. */
export function instanceCreatorSourceKey(creator: InstanceCreator): string {
  switch (creator.kind) {
    case "operator": return `operator:${creator.operatorId}`;
    case "run": return `run:${creator.runId}`;
    case "orchestrator-client": return `orchestrator-client:${creator.clientId}`;
  }
}

/** The allocation currently holding the instance's resident slot, if any. */
export function currentAllocationInState(state: Readonly<State>, instanceId: string): InstanceAllocation | undefined {
  return (state.allocations ?? []).find((allocation) => allocation.instanceId === instanceId && occupyingAllocationStatuses.includes(allocation.status));
}

export interface ResidentInstanceUsage {
  capacity: number;
  /** Slots held by the union of persisted resident intent and reported residents the hub does not own. */
  used: number;
}

/**
 * Resident usage for one node. A node without `instanceCapacity` is incapable of hosting instances
 * (zero capacity).
 *
 * Residency is a set of identities, not a count, so the two sources of truth are unioned by
 * identity instead of compared as numbers:
 *
 * - every occupying allocation this hub persists for the node contributes its instance identity,
 *   whether or not the node has reported it yet, so reconnect lag cannot overbook;
 * - every resident the node reported that the hub does not own contributes its own identity. Those
 *   are exactly the node's `remoteReleaseRequests`, which reconciliation keeps in step with the
 *   node's latest authoritative snapshot; a requested remote release still occupies its slot until
 *   the node confirms it is gone.
 *
 * The union cannot undercount when the two sets are disjoint, because a reported resident the hub
 * does not own adds a slot of its own instead of being masked by a larger persisted count. It
 * cannot double-count when they overlap, because a reported identity that an occupying allocation
 * on this node already claims is excluded from the unowned set.
 *
 * `activeInstances` is a scalar the node reports without identities, so it can only raise the floor:
 * it covers residency whose identity the hub has not seen at all (a report that arrived before its
 * resident set did). Absent or malformed, it is unknown and contributes no floor, never a default.
 */
export function residentInstanceUsage(
  node: ComputeNode,
  allocations: readonly InstanceAllocation[],
  remoteResidents: readonly RemoteReleaseRequest[] = []
): ResidentInstanceUsage {
  const capacity = Number.isSafeInteger(node.instanceCapacity) && node.instanceCapacity! > 0 ? node.instanceCapacity! : 0;
  const reportedFloor = Number.isSafeInteger(node.activeInstances) && node.activeInstances! >= 0 ? node.activeInstances! : 0;
  const owned = new Set(allocations
    .filter((allocation) => allocation.nodeId === node.id && occupyingAllocationStatuses.includes(allocation.status))
    .map((allocation) => allocation.instanceId));
  const unowned = new Set(remoteResidents
    .filter((request) => request.nodeId === node.id && !owned.has(request.instanceId))
    .map((request) => request.instanceId));
  return { capacity, used: Math.max(owned.size + unowned.size, reportedFloor) };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** An instance run carries `instanceId`; legacy agent runs never do. */
const runInstanceId = (run: Run): string | undefined => {
  const instanceId = (run as { instanceId?: unknown }).instanceId;
  return typeof instanceId === "string" ? instanceId : undefined;
};

const activeRunsForInstance = (state: Readonly<State>, instanceId: string): Run[] =>
  state.runs.filter((run) => runInstanceId(run) === instanceId && isActiveRunStatus(run.status));

const instanceEventDetail = (instance: AgentInstance): string => {
  const name = instance.purpose?.name ?? instance.purpose?.title;
  return name ? `${name} · ${instance.status}` : instance.status;
};

/**
 * Resolves the thread a lifecycle caller named and verifies the caller's authority over it. A
 * missing thread, an unknown caller, and a caller from another thread are indistinguishable to the
 * caller, matching the policy for hidden thread resources.
 */
function authorizeInstanceThread(state: Readonly<State>, creator: InstanceCreator, threadId: string) {
  const notFound = () => new CoordinationError("not_found", "Thread not found");
  const thread = (state.threads ?? []).find((item) => item.id === threadId);
  if (!thread) throw notFound();
  switch (creator.kind) {
    case "operator":
      if (!isNonEmptyString(creator.operatorId)) throw notFound();
      return thread;
    case "run": {
      const run = state.runs.find((item) => item.id === creator.runId);
      if (!run || run.threadId !== threadId) throw notFound();
      if (run.status !== "running") throw new CoordinationError("forbidden", "The creating run is not active");
      const named = state.instances?.find((item) => item.id === creator.instanceId);
      if (!named || named.threadId !== threadId) throw notFound();
      return thread;
    }
    case "orchestrator-client": {
      const attachment = (state.orchestratorAttachments ?? [])
        .find((item) => item.threadId === threadId && item.clientId === creator.clientId && item.status === "attached");
      if (!attachment) throw new CoordinationError("not_attached", "This client holds no attachment on that thread");
      const client = (state.orchestratorClients ?? []).find((item) => item.id === creator.clientId);
      if (!client || client.revokedAt !== undefined || !client.scopes.includes("orchestrate")) {
        throw new CoordinationError("not_attached", "This client holds no attachment on that thread");
      }
      return thread;
    }
  }
}

const instanceRequestDigest = (request: InstanceLifecycleRequest): string => {
  const digestInput = instanceLifecycleDigestInput(request);
  if (!digestInput.ok) throw new CoordinationError("invalid_arguments", digestInput.reason);
  return createHash("sha256").update(digestInput.value).digest("hex");
};

/*
 * The idempotency key of the task created with an instance. A lifecycle idempotency key may be 128
 * bytes and the task-batch key limit is also 128 characters, so the key cannot be carried verbatim
 * with its scope prefixed; it is derived through a digest instead, which keeps it inside that bound.
 *
 * The derivation carries the full scope lifecycle idempotency is defined over — caller principal,
 * thread, and operation — because the task-submission lookup is keyed by thread and key alone: two
 * principals reusing the same lifecycle key on one thread must not collide into one conflict. NUL
 * separators keep it injective, since neither a source key nor a thread id may contain one.
 *
 * The digest alone is not enough, because an ordinary task caller may submit any 128-character key
 * and could therefore occupy this string. The submission is written in its own namespace
 * (`origin: "instance-lifecycle"`), which no caller-supplied batch can enter, so the two key spaces
 * are disjoint by construction rather than by the unguessability of a hash.
 */
const initialTaskIdempotencyKey = (sourceKey: string, threadId: string, key: string) =>
  createHash("sha256").update(`instance-create\u0000${sourceKey}\u0000${threadId}\u0000${key}`).digest("hex");

const receiptKeyMatches = (receipt: InstanceLifecycleReceipt, threadId: string, sourceKey: string, idempotencyKey: string) =>
  receipt.threadId === threadId && receipt.sourceKey === sourceKey && receipt.idempotencyKey === idempotencyKey;

function replayResult(state: Readonly<State>, receipt: InstanceLifecycleReceipt): InstanceLifecycleResult {
  // The receipt is looked up by thread, so the instance it names must belong to that thread; a
  // replay never reaches outside the thread it was accepted on, whatever a snapshot claims.
  const instance = state.instances?.find((item) => item.id === receipt.instanceId && item.threadId === receipt.threadId);
  if (!instance) throw new CoordinationError("not_found", "Instance not found");
  const allocation = currentAllocationInState(state, instance.id);
  return {
    instance: structuredClone(instance),
    ...(allocation ? { allocation: structuredClone(allocation) } : {}),
    ...(receipt.initialTaskId === undefined ? {} : { initialTaskId: receipt.initialTaskId }),
    replayed: true
  };
}

const leaseExpiry = (at: string, idleTimeoutSeconds: number) => new Date(Date.parse(at) + idleTimeoutSeconds * 1000).toISOString();

/**
 * Applies one lifecycle request transactionally. An exact replay of a prior request returns its
 * original result without new writes; the same caller and key with a different normalized digest
 * conflicts. Create and create-with-initial-task are all-or-nothing: any validation or persistence
 * failure leaves no instance, task, receipt, event, or allocation behind.
 */
export async function applyInstanceLifecycle(
  store: Store,
  caller: InstanceCreator,
  request: InstanceLifecycleRequest,
  at = new Date().toISOString()
): Promise<InstanceLifecycleResult> {
  const validated = validateInstanceLifecycleRequest(request);
  if (!validated.ok) throw new CoordinationError("invalid_arguments", validated.reason);
  const digest = instanceRequestDigest(validated.value);
  const sourceKey = instanceCreatorSourceKey(caller);
  if (JSON.stringify(request.idempotency.caller) !== JSON.stringify(caller)) {
    throw new CoordinationError("forbidden", "The idempotency caller does not match the authenticated principal");
  }
  let result: InstanceLifecycleResult | undefined;
  await store.transact((state) => {
    const thread = authorizeInstanceThread(state, caller, request.threadId);
    const prior = (state.instanceLifecycleReceipts ?? []).find((receipt) => receiptKeyMatches(receipt, request.threadId, sourceKey, request.idempotency.key));
    if (prior) {
      if (prior.digest !== digest) {
        throw new CoordinationError("idempotency_conflict", "The idempotency key was already used with a different instance request");
      }
      result = replayResult(state, prior);
      return false;
    }
    if (request.operation === "create") {
      if (thread.status !== "active") throw new CoordinationError("thread_inactive", "Instance creation requires an active thread");
      const instance: AgentInstance = {
        id: newId("instance"),
        threadId: thread.id,
        creator: { ...caller },
        ...(request.purpose ? { purpose: structuredClone(request.purpose) } : {}),
        delegation: { canDelegate: false },
        requirements: structuredClone(request.requirements),
        lease: {
          idleTimeoutSeconds: request.idleTimeoutSeconds ?? defaultInstanceIdleTimeoutSeconds,
          expiresAt: leaseExpiry(at, request.idleTimeoutSeconds ?? defaultInstanceIdleTimeoutSeconds)
        },
        status: "requested",
        createdAt: at,
        updatedAt: at
      };
      let initialTaskId: string | undefined;
      if (request.initialTask) {
        initialTaskId = appendInitialTaskInState(state, thread.id, {
          title: request.initialTask.title,
          instructions: request.initialTask.instructions,
          requirements: structuredClone(request.requirements),
          idempotencyKey: initialTaskIdempotencyKey(sourceKey, thread.id, request.idempotency.key),
          sourceKey
        }, at).id;
      }
      state.instances ??= [];
      state.instances.unshift(instance);
      state.instanceLifecycleReceipts ??= [];
      state.instanceLifecycleReceipts.push({
        id: newId("instreceipt"),
        threadId: thread.id,
        sourceKey,
        idempotencyKey: request.idempotency.key,
        operation: "create",
        digest,
        instanceId: instance.id,
        ...(initialTaskId === undefined ? {} : { initialTaskId }),
        createdAt: at
      });
      state.events.unshift(newEvent({
        type: "status",
        title: "Instance requested",
        detail: instanceEventDetail(instance),
        threadId: thread.id
      }));
      result = {
        instance: structuredClone(instance),
        ...(initialTaskId === undefined ? {} : { initialTaskId }),
        replayed: false
      };
    } else {
      const instance = (state.instances ?? []).find((item) => item.id === request.instanceId && item.threadId === request.threadId);
      if (!instance) throw new CoordinationError("not_found", "Instance not found");
      if (request.operation === "renew") {
        if (instance.status === "released" || instance.status === "failed") {
          throw new CoordinationError("conflict", `A ${instance.status} instance cannot be renewed`);
        }
        if (instance.status === "draining") throw new CoordinationError("conflict", "A draining instance cannot be renewed");
        const idleTimeoutSeconds = request.idleTimeoutSeconds ?? instance.lease.idleTimeoutSeconds;
        instance.lease = { idleTimeoutSeconds, expiresAt: leaseExpiry(at, idleTimeoutSeconds) };
        instance.updatedAt = at;
        const allocation = currentAllocationInState(state, instance.id);
        if (allocation) allocation.lease = { ...instance.lease };
        state.instanceLifecycleReceipts ??= [];
        state.instanceLifecycleReceipts.push({
          id: newId("instreceipt"), threadId: thread.id, sourceKey, idempotencyKey: request.idempotency.key,
          operation: "renew", digest, instanceId: instance.id, createdAt: at
        });
        result = { instance: structuredClone(instance), replayed: false };
      } else {
        if (terminalInstanceStatuses.includes(instance.status)) {
          throw new CoordinationError("conflict", `The instance is already ${instance.status}`);
        }
        const intent = recordReleaseIntent(state, instance, request.mode, at);
        if (canTransitionInstance(instance.status, "draining")) {
          instance.status = "draining";
          instance.updatedAt = at;
        }
        state.instanceLifecycleReceipts ??= [];
        state.instanceLifecycleReceipts.push({
          id: newId("instreceipt"), threadId: thread.id, sourceKey, idempotencyKey: request.idempotency.key,
          operation: "release", digest, instanceId: instance.id, createdAt: at
        });
        state.events.unshift(newEvent({
          type: "status",
          title: `Instance release requested (${intent.mode})`,
          detail: instanceEventDetail(instance),
          threadId: thread.id
        }));
        settleDrainingInstances(state, at);
        result = { instance: structuredClone(instance), replayed: false };
      }
    }
    pruneInstanceAuditRecords(state);
    return true;
  });
  if (!result) throw new CoordinationError("persistence_failed", "The instance lifecycle request was not applied", true);
  return result;
}

/** Records the release intent, escalating monotonically: once cancel, always cancel. */
function recordReleaseIntent(state: State, instance: AgentInstance, mode: InstanceReleaseMode, at: string): InstanceReleaseIntent {
  state.instanceReleaseIntents ??= [];
  const existing = state.instanceReleaseIntents.find((intent) => intent.instanceId === instance.id);
  if (existing) {
    if (mode === "cancel" && existing.mode === "drain") {
      existing.mode = "cancel";
      existing.updatedAt = at;
      escalatePendingReleaseCommand(state, instance, "cancel", at);
    }
    return existing;
  }
  const intent: InstanceReleaseIntent = { instanceId: instance.id, threadId: instance.threadId, mode, requestedAt: at, updatedAt: at };
  state.instanceReleaseIntents.push(intent);
  return intent;
}

/**
 * Escalation of a drain request to cancel. An undelivered drain command is rewritten in place; a
 * delivered one is followed by a new persisted cancel command, so Barista always hears the stronger
 * mode while each command is still persisted before its send.
 */
function escalatePendingReleaseCommand(state: State, instance: AgentInstance, mode: InstanceReleaseMode, at: string) {
  let deliveredDrain: InstanceDeliveryRecord | undefined;
  for (const record of state.instanceDeliveries ?? []) {
    if (record.kind !== "release" || record.message.type !== "instance.release" || record.message.instanceId !== instance.id) continue;
    if (record.deliveredAt === undefined) {
      record.message = { ...record.message, mode };
      record.createdAt = at;
    } else if (record.message.mode === "drain") {
      deliveredDrain = record;
    }
  }
  const allocation = currentAllocationInState(state, instance.id);
  if (deliveredDrain && allocation) {
    state.instanceDeliveries ??= [];
    state.instanceDeliveries.push({
      allocationId: allocation.id,
      kind: "release",
      nodeId: allocation.nodeId,
      message: { type: "instance.release", instanceId: instance.id, allocationId: allocation.id, mode },
      createdAt: at
    });
  }
}

export interface AllocationCandidate {
  nodeId: string;
  harnessId: HarnessId;
  model: string;
  transport: HarnessTransport;
  /** Canonical absolute path; Barista re-validates it against its WORKSPACE_ROOTS. */
  workspace: string;
}

export type ReservationResult =
  | { kind: "reserved"; allocation: InstanceAllocation }
  | { kind: "not-found" }
  | { kind: "capacity"; reason: string };

const isUnderWorkspaceRoot = (workspace: string, root: string) =>
  workspace === root || workspace.startsWith(root.endsWith("/") ? root : `${root}/`);

/**
 * Reserves one resident slot and attaches exactly one current allocation to the instance, inside
 * the same transaction that persists the provision delivery decision. Placement selection is owned
 * by the scheduler (#77); this only decides reservation correctness for a candidate it supplies.
 * On any refusal the instance stays `requested` and a capacity diagnostic is returned.
 */
export async function reserveInstanceAllocation(
  store: Store,
  instanceId: string,
  candidate: AllocationCandidate,
  at = new Date().toISOString()
): Promise<ReservationResult> {
  let result: ReservationResult = { kind: "not-found" };
  await store.transact((state) => {
    const instance = (state.instances ?? []).find((item) => item.id === instanceId);
    if (!instance) {
      result = { kind: "not-found" };
      return false;
    }
    if (instance.status !== "requested" || currentAllocationInState(state, instanceId) !== undefined) {
      result = { kind: "capacity", reason: `Instance ${instanceId} already holds an allocation` };
      return false;
    }
    const node = state.nodes.find((item) => item.id === candidate.nodeId);
    if (!node || (node.status !== "online" && node.status !== "busy")) {
      result = { kind: "capacity", reason: `Compute node ${candidate.nodeId} is not available` };
      return false;
    }
    const usage = residentInstanceUsage(node, state.allocations ?? [], state.remoteReleaseRequests ?? []);
    if (usage.used >= usage.capacity) {
      result = { kind: "capacity", reason: `Compute node ${candidate.nodeId} has no resident instance capacity (${usage.used}/${usage.capacity})` };
      return false;
    }
    const harness = node.harnesses.find((item) => item.id === candidate.harnessId);
    if (!harness || !harness.available) {
      result = { kind: "capacity", reason: `Harness ${candidate.harnessId} is not available on ${node.id}` };
      return false;
    }
    if (harness.models.length > 0 && !harness.models.includes(candidate.model)) {
      result = { kind: "capacity", reason: `Model ${candidate.model} is not offered by ${candidate.harnessId} on ${node.id}` };
      return false;
    }
    if (!(node.workspaceRoots ?? []).some((root) => isUnderWorkspaceRoot(candidate.workspace, root))) {
      result = { kind: "capacity", reason: `Workspace ${candidate.workspace} is outside an authorized root on ${node.id}` };
      return false;
    }
    const allocation: InstanceAllocation = {
      id: newId("allocation"),
      instanceId: instance.id,
      nodeId: node.id,
      harnessId: candidate.harnessId,
      model: candidate.model,
      transport: candidate.transport,
      workspace: candidate.workspace,
      lease: { ...instance.lease },
      status: "reserved",
      createdAt: at,
      updatedAt: at
    };
    instance.status = "provisioning";
    instance.updatedAt = at;
    state.allocations ??= [];
    state.allocations.unshift(allocation);
    const message: InstanceHubMessage = { type: "instance.provision", instance: structuredClone(instance), allocation: structuredClone(allocation) };
    const wireValid = validateInstanceHubMessage(message, "5");
    if (!wireValid.ok) {
      throw new CoordinationError("invalid_arguments", `The provision command is not wire-valid: ${wireValid.reason}`);
    }
    state.instanceDeliveries ??= [];
    state.instanceDeliveries.push({ allocationId: allocation.id, kind: "provision", nodeId: node.id, message, createdAt: at });
    state.events.unshift(newEvent({
      type: "status",
      title: "Instance allocation reserved",
      detail: `${instanceEventDetail(instance)} on ${node.id}`,
      threadId: instance.threadId
    }));
    result = { kind: "reserved", allocation: structuredClone(allocation) };
    return true;
  });
  return result;
}

/** Test seams for the delivery pass; production callers pass none. */
export interface InstanceDeliveryHooks {
  /** Awaited after the outbox is read and before the transaction that decides one command. */
  beforeDelivery?: (record: { allocationId: string; kind: "provision" | "release" }) => void | Promise<void>;
}

export type InstanceReportKind = "accepted" | "ignored" | "rejected";

export interface InstanceReportOutcome {
  kind: InstanceReportKind;
  changed: boolean;
  reason?: string;
}

const rejectedReport = (reason: string): InstanceReportOutcome => ({ kind: "rejected", changed: false, reason });

/**
 * Applies a Barista lifecycle acknowledgement. It is accepted only from the allocation's node, for
 * the instance's current allocation, and along a protocol-legal transition; an exact replay of an
 * already-applied acknowledgement is ignored, and a report against a terminal record or a superseded
 * allocation is rejected without any state change.
 */
export async function receiveInstanceLifecycleReport(
  store: Store,
  nodeId: string,
  message: InstanceLifecycleEvidence,
  at = new Date().toISOString()
): Promise<InstanceReportOutcome> {
  let outcome: InstanceReportOutcome = rejectedReport("unhandled");
  await store.transact((state) => {
    const allocation = (state.allocations ?? []).find((item) => item.id === message.allocationId);
    if (!allocation || allocation.instanceId !== message.instanceId || allocation.nodeId !== nodeId) {
      outcome = rejectedReport("the acknowledgement does not name a known allocation on this node");
      return false;
    }
    const instance = (state.instances ?? []).find((item) => item.id === allocation.instanceId);
    if (!instance) {
      outcome = rejectedReport("the acknowledgement does not name a known instance");
      return false;
    }
    const current = currentAllocationInState(state, instance.id);
    const isCurrentGeneration = current !== undefined && current.id === allocation.id;
    if (message.type === "instance.ready") {
      if (allocation.status === "active" && nonTerminalInstanceStatuses.includes(instance.status)) {
        outcome = { kind: "ignored", changed: false };
        return false;
      }
      if (!isCurrentGeneration || !canTransitionAllocation(allocation.status, "active") || !canTransitionInstance(instance.status, "ready")) {
        outcome = rejectedReport("the ready report does not match the current allocation generation or a legal transition");
        return false;
      }
      allocation.status = "active";
      allocation.updatedAt = at;
      instance.status = "ready";
      instance.updatedAt = at;
      outcome = { kind: "accepted", changed: true };
      return true;
    }
    if (message.type === "instance.failed") {
      if (allocation.status === "failed" && instance.status === "failed") {
        outcome = { kind: "ignored", changed: false };
        return false;
      }
      if (!isCurrentGeneration || !canTransitionAllocation(allocation.status, "failed") || !canTransitionInstance(instance.status, "failed")) {
        outcome = rejectedReport("the failure report does not match the current allocation generation or a legal transition");
        return false;
      }
      allocation.status = "failed";
      allocation.updatedAt = at;
      instance.status = "failed";
      instance.updatedAt = at;
      settleTerminalInstance(state, instance, at);
      state.events.unshift(newEvent({
        type: "status",
        title: "Instance failed",
        detail: instanceEventDetail(instance),
        threadId: instance.threadId
      }));
      outcome = { kind: "accepted", changed: true };
      return true;
    }
    if (allocation.status === "released" && instance.status === "released") {
      outcome = { kind: "ignored", changed: false };
      return false;
    }
    if (!isCurrentGeneration || !canTransitionAllocation(allocation.status, "released") || instance.status !== "draining" || !canTransitionInstance(instance.status, "released")) {
      outcome = rejectedReport("the release report does not match the current allocation generation or a legal transition");
      return false;
    }
    allocation.status = "released";
    allocation.updatedAt = at;
    instance.status = "released";
    instance.updatedAt = at;
    settleTerminalInstance(state, instance, at);
    state.events.unshift(newEvent({
      type: "status",
      title: "Instance released",
      detail: instanceEventDetail(instance),
      threadId: instance.threadId
    }));
    outcome = { kind: "accepted", changed: true };
    return true;
  });
  return outcome;
}

/** Settles every remaining nonterminal allocation of a terminal instance to the same terminal status. */
function settleTerminalInstance(state: State, instance: AgentInstance, at: string) {
  const target = instance.status === "released" ? "released" : "failed";
  for (const allocation of state.allocations ?? []) {
    if (allocation.instanceId !== instance.id || !canTransitionAllocation(allocation.status, target)) continue;
    allocation.status = target;
    allocation.updatedAt = at;
  }
}

/**
 * Reconciles explicit resident evidence reported after a version-5 replay barrier. Residents the
 * hub expected but Barista no longer supervises become `lost` exactly once — never freed or reused
 * as active evidence — and their non-draining instances return to `requested` for replacement. A
 * still-undelivered reservation is left for outbox replay rather than judged missing. An unknown
 * resident is never adopted: the hub asks the node to release it. Absent evidence must never reach
 * this function; the caller classifies the sync with `classifyInstanceResidentEvidence` first.
 *
 * The snapshot is also the authority that retires outbox entries: a release for a resident the node
 * still reports is re-armed for replay, and a remote release request for a resident it no longer
 * reports is retired. Both directions are needed for the outbox to be finite as well as sufficient.
 */
export function reconcileNodeInstancesInState(state: State, nodeId: string, activeInstanceIds: readonly string[], at: string): boolean {
  const reported = new Set(activeInstanceIds);
  const instancesById = new Map((state.instances ?? []).map((instance) => [instance.id, instance]));
  const expected = (state.allocations ?? []).filter((allocation) => allocation.nodeId === nodeId && occupyingAllocationStatuses.includes(allocation.status));
  const expectedInstanceIds = new Set(expected.flatMap((allocation) => {
    const instance = instancesById.get(allocation.instanceId);
    return instance ? [instance.id] : [];
  }));
  let changed = false;
  for (const allocation of expected) {
    const instance = instancesById.get(allocation.instanceId);
    if (!instance || reported.has(instance.id)) continue;
    // A reservation whose provision command has not been written yet is pending, not lost.
    if (allocation.status === "reserved") continue;
    if (!canTransitionAllocation(allocation.status, "lost")) continue;
    allocation.status = "lost";
    allocation.updatedAt = at;
    state.instanceDeliveries = (state.instanceDeliveries ?? []).filter((record) => record.allocationId !== allocation.id);
    if (!terminalInstanceStatuses.includes(instance.status) && instance.status !== "draining") {
      /*
       * Replacement resets placement intent. The protocol's transition table has no edge back to
       * `requested`, but instance identity is defined to survive allocation loss (#73): the record
       * keeps its identity, requirements, and lease, and its replacement allocates afresh.
       */
      instance.status = "requested";
      instance.updatedAt = at;
    }
    state.events.unshift(newEvent({
      type: "status",
      title: "Instance allocation lost",
      detail: `Instance ${instance.id} was no longer resident on ${nodeId}`,
      threadId: instance.threadId
    }));
    changed = true;
  }
  changed = rearmUnacknowledgedReleases(state, nodeId, reported, at) || changed;
  for (const instanceId of activeInstanceIds) {
    if (expectedInstanceIds.has(instanceId)) continue;
    state.remoteReleaseRequests ??= [];
    if (state.remoteReleaseRequests.some((request) => request.nodeId === nodeId && request.instanceId === instanceId)) continue;
    state.remoteReleaseRequests.push({ nodeId, instanceId, requestedAt: at });
    changed = true;
  }
  /*
   * This snapshot is the complete resident set of the node, so a request for a resident it no longer
   * reports has nothing left to act on and is retired. Nothing actionable is discarded: only a
   * resident the node itself stopped reporting is dropped, and if it reappears in a later snapshot
   * the request is written again. Each node's requests are therefore bounded by the resident set a
   * snapshot may carry (`instanceLimits.collectionEntries`) and cannot grow across reconnects.
   */
  const requests = state.remoteReleaseRequests ?? [];
  const retained = requests.filter((request) => request.nodeId !== nodeId || reported.has(request.instanceId));
  if (retained.length !== requests.length) {
    state.remoteReleaseRequests = retained;
    changed = true;
  }
  return changed;
}

/**
 * Re-arms release commands this node has not acted on. A socket write that returned is not proof the
 * peer received the frame, so a release whose instance the node still reports resident after an
 * authoritative reconnect is marked undelivered again and replays. The record is reused rather than
 * duplicated, so replay cannot grow the outbox.
 */
function rearmUnacknowledgedReleases(state: State, nodeId: string, reported: ReadonlySet<string>, at: string): boolean {
  const allocationsById = new Map((state.allocations ?? []).map((allocation) => [allocation.id, allocation]));
  // An escalation already waiting to be written carries the stronger mode, so the superseded command
  // it replaced is not re-armed behind it.
  const awaitingRelease = new Set((state.instanceDeliveries ?? [])
    .filter((record) => record.kind === "release" && record.deliveredAt === undefined)
    .map((record) => record.allocationId));
  let changed = false;
  for (const record of state.instanceDeliveries ?? []) {
    if (record.kind !== "release" || record.nodeId !== nodeId || record.deliveredAt === undefined) continue;
    if (awaitingRelease.has(record.allocationId)) continue;
    const allocation = allocationsById.get(record.allocationId);
    if (!allocation || !occupyingAllocationStatuses.includes(allocation.status) || !reported.has(allocation.instanceId)) continue;
    record.deliveredAt = undefined;
    record.createdAt = at;
    changed = true;
  }
  return changed;
}

/** Expires idle leases, converges draining instances, and prunes terminal audit records. */
export async function maintainInstanceLifecycle(store: Store, at = new Date().toISOString()): Promise<boolean> {
  let changed = false;
  await store.transact((state) => {
    const expired = expireIdleInstances(state, at);
    const settled = settleDrainingInstances(state, at);
    const pruned = pruneInstanceAuditRecords(state);
    changed = expired || settled || pruned;
    return changed;
  });
  return changed;
}

function expireIdleInstances(state: State, at: string): boolean {
  const now = Date.parse(at);
  let changed = false;
  for (const instance of state.instances ?? []) {
    if (!nonTerminalInstanceStatuses.includes(instance.status)) continue;
    if (Date.parse(instance.lease.expiresAt) > now) continue;
    if (!canTransitionInstance(instance.status, "draining")) continue;
    instance.status = "draining";
    instance.updatedAt = at;
    state.events.unshift(newEvent({
      type: "status",
      title: "Instance idle lease expired",
      detail: instanceEventDetail(instance),
      threadId: instance.threadId
    }));
    changed = true;
  }
  return changed;
}

/**
 * Advances draining instances. Drain waits for active runs and then persists exactly one release
 * command for the current allocation, using the recorded intent's mode (an unrequested expiry
 * drains; only an explicit cancel intent ever cancels). A draining instance with nothing resident
 * settles to `released` directly — there is no Barista left to acknowledge.
 */
function settleDrainingInstances(state: State, at: string): boolean {
  let changed = false;
  for (const instance of state.instances ?? []) {
    if (instance.status !== "draining") continue;
    if (activeRunsForInstance(state, instance.id).length > 0) continue;
    const allocation = currentAllocationInState(state, instance.id);
    if (allocation) {
      /*
       * One command per allocation: an existing record already carries this release. If the node has
       * not acted on it, its next authoritative snapshot re-arms that record for replay, so a lost
       * frame is reissued without ever duplicating the command here.
       */
      const commanded = (state.instanceDeliveries ?? []).some((record) => record.kind === "release" && record.allocationId === allocation.id);
      if (commanded) continue;
      const mode = (state.instanceReleaseIntents ?? []).find((intent) => intent.instanceId === instance.id)?.mode ?? "drain";
      state.instanceDeliveries ??= [];
      state.instanceDeliveries.push({
        allocationId: allocation.id,
        kind: "release",
        nodeId: allocation.nodeId,
        message: { type: "instance.release", instanceId: instance.id, allocationId: allocation.id, mode },
        createdAt: at
      });
      changed = true;
      continue;
    }
    if (!canTransitionInstance(instance.status, "released")) continue;
    instance.status = "released";
    instance.updatedAt = at;
    settleTerminalInstance(state, instance, at);
    state.events.unshift(newEvent({
      type: "status",
      title: "Instance released",
      detail: instanceEventDetail(instance),
      threadId: instance.threadId
    }));
    changed = true;
  }
  return changed;
}

/**
 * Sends persisted instance commands. A record is written only after `deliver` confirms a current,
 * synced, protocol-v5 connection accepted the write; a refused or failed send records no delivery,
 * so the command replays after the node's next authoritative reconnect. The send decision and its
 * recording happen in one transaction, so a reconciliation that removed the record while this pass
 * was awaiting can never be raced by a stale send. A delivered provision command moves its
 * allocation to `provisioning`, which is what a later `instance.ready` requires.
 *
 * `hooks.beforeDelivery` is the seam that makes that ordering testable: it runs between the pass's
 * read of the outbox and the transaction that decides one command, which is exactly where a
 * concurrent reconciliation would interleave.
 */
export async function flushPendingInstanceDeliveries(
  store: Store,
  deliver: (nodeId: string, message: InstanceHubMessage) => boolean,
  hooks: InstanceDeliveryHooks = {}
): Promise<boolean> {
  let changed = false;
  const pending = store.read((state) => (state.instanceDeliveries ?? [])
    .filter((record) => record.deliveredAt === undefined)
    .map((record) => ({ allocationId: record.allocationId, kind: record.kind })));
  for (const { allocationId, kind } of pending) {
    if (hooks.beforeDelivery) await hooks.beforeDelivery({ allocationId, kind });
    await store.transact((state) => {
      const target = (state.instanceDeliveries ?? []).find((item) => item.allocationId === allocationId && item.kind === kind && item.deliveredAt === undefined);
      if (!target || !deliver(target.nodeId, target.message)) return false;
      target.deliveredAt = new Date().toISOString();
      if (target.kind === "provision") {
        const allocation = (state.allocations ?? []).find((item) => item.id === target.allocationId);
        if (allocation && allocation.status === "reserved" && canTransitionAllocation(allocation.status, "provisioning")) {
          allocation.status = "provisioning";
          allocation.updatedAt = target.deliveredAt;
        }
      }
      changed = true;
      return true;
    });
  }
  /*
   * A remote release names no allocation the hub owns, so the instance identity addresses it. The
   * request is removed once the write is accepted rather than on an acknowledgement, because the hub
   * holds no record to acknowledge: if the node still hosts that resident, its next authoritative
   * snapshot reports it again and the request is written again, which is the replay.
   */
  const remote = store.read((state) => structuredClone(state.remoteReleaseRequests ?? []));
  for (const request of remote) {
    await store.transact((state) => {
      const target = (state.remoteReleaseRequests ?? []).find((item) => item.nodeId === request.nodeId && item.instanceId === request.instanceId);
      if (!target) return false;
      const message: InstanceHubMessage = { type: "instance.release", instanceId: target.instanceId, allocationId: target.instanceId, mode: "cancel" };
      if (!deliver(target.nodeId, message)) return false;
      state.remoteReleaseRequests = (state.remoteReleaseRequests ?? []).filter((item) => item !== target);
      changed = true;
      return true;
    });
  }
  return changed;
}

/** Every instance in a thread with its allocations; terminal records only on request. */
export function listThreadInstances(state: Readonly<State>, threadId: string, includeTerminal: boolean): { instances: AgentInstance[]; allocations: InstanceAllocation[] } {
  const instances = (state.instances ?? []).filter((instance) =>
    instance.threadId === threadId && (includeTerminal || !terminalInstanceStatuses.includes(instance.status)));
  const ids = new Set(instances.map((instance) => instance.id));
  return {
    instances: instances.map((instance) => structuredClone(instance)),
    allocations: (state.allocations ?? []).filter((allocation) => ids.has(allocation.instanceId)).map((allocation) => structuredClone(allocation))
  };
}

/**
 * Prunes terminal audit records beyond their bounds, oldest first, together with the receipts,
 * intents, and delivery records that reference them. Live records are never touched, and an
 * actionable outbox entry — an undelivered provision, release, or remote release request — is
 * never pruned; only a successful delivery removes it.
 */
export function pruneInstanceAuditRecords(state: State): boolean {
  let changed = false;
  const terminal = (state.instances ?? [])
    .filter((instance) => terminalInstanceStatuses.includes(instance.status))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (terminal.length > instanceAuditLimits.retainedTerminalInstances) {
    const dropped = new Set(terminal.slice(instanceAuditLimits.retainedTerminalInstances).map((instance) => instance.id));
    state.instances = (state.instances ?? []).filter((instance) => !dropped.has(instance.id));
    state.allocations = (state.allocations ?? []).filter((allocation) => !dropped.has(allocation.instanceId));
    state.instanceLifecycleReceipts = (state.instanceLifecycleReceipts ?? []).filter((receipt) => !dropped.has(receipt.instanceId));
    state.instanceReleaseIntents = (state.instanceReleaseIntents ?? []).filter((intent) => !dropped.has(intent.instanceId));
    state.instanceDeliveries = (state.instanceDeliveries ?? []).filter((record) => !dropped.has(commandInstanceId(record.message)));
    changed = true;
  }
  if (pruneLifecycleReceipts(state)) changed = true;
  if (retireSettledDeliveries(state)) changed = true;
  return changed;
}

/**
 * Bounds retained receipts both per instance and overall, so no single live instance can grow the
 * collection without limit.
 *
 * Drop order is by how actionable a receipt is, oldest first within each rank: a receipt whose
 * instance is gone can answer nothing, a renew or release receipt replays an operation that is
 * re-derivable from the instance's own state, and a `create` receipt is the one that maps a caller's
 * key to an instance identity, so it is dropped last and never while its instance is retained and
 * the collection is inside its global bound. Losing a create receipt would turn a replay into a
 * second creation, which is why the per-instance bound never touches one.
 */
function pruneLifecycleReceipts(state: State): boolean {
  const receipts = state.instanceLifecycleReceipts ?? [];
  const instanceIds = new Set((state.instances ?? []).map((instance) => instance.id));
  const oldestFirst = (left: InstanceLifecycleReceipt, right: InstanceLifecycleReceipt) =>
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
  const drop = new Set<string>();
  const byInstance = new Map<string, InstanceLifecycleReceipt[]>();
  for (const receipt of receipts) {
    const group = byInstance.get(receipt.instanceId) ?? [];
    group.push(receipt);
    byInstance.set(receipt.instanceId, group);
  }
  for (const group of byInstance.values()) {
    if (group.length <= instanceAuditLimits.retainedReceiptsPerInstance) continue;
    const replaceable = group.filter((receipt) => receipt.operation !== "create" || !instanceIds.has(receipt.instanceId)).sort(oldestFirst);
    for (const receipt of replaceable.slice(0, group.length - instanceAuditLimits.retainedReceiptsPerInstance)) drop.add(receipt.id);
  }
  const overGlobalBound = () => receipts.length - drop.size - instanceAuditLimits.retainedReceipts;
  const rankedForGlobalBound = [
    (receipt: InstanceLifecycleReceipt) => !instanceIds.has(receipt.instanceId),
    (receipt: InstanceLifecycleReceipt) => receipt.operation !== "create",
    () => true
  ];
  for (const rank of rankedForGlobalBound) {
    if (overGlobalBound() <= 0) break;
    for (const receipt of receipts.filter((item) => !drop.has(item.id) && rank(item)).sort(oldestFirst)) {
      if (overGlobalBound() <= 0) break;
      drop.add(receipt.id);
    }
  }
  if (drop.size === 0) return false;
  state.instanceLifecycleReceipts = receipts.filter((receipt) => !drop.has(receipt.id));
  return true;
}

/**
 * Retires delivery records the peer has settled. A provision is settled when its allocation reaches
 * `active` — the `instance.ready` acknowledgement — and either kind is settled once its allocation
 * is gone or no longer holds a slot, because nothing can act on the command any more. An
 * unacknowledged record is never retired here, so replay stays possible; at most one provision and
 * the escalated release commands of one allocation are held at a time, which bounds the outbox by
 * the allocations the hub retains.
 */
function retireSettledDeliveries(state: State): boolean {
  const records = state.instanceDeliveries ?? [];
  const allocationsById = new Map((state.allocations ?? []).map((allocation) => [allocation.id, allocation]));
  const retained = records.filter((record) => {
    const allocation = allocationsById.get(record.allocationId);
    if (!allocation) return false;
    if (!occupyingAllocationStatuses.includes(allocation.status)) return false;
    return !(record.kind === "provision" && record.deliveredAt !== undefined && allocation.status === "active");
  });
  if (retained.length === records.length) return false;
  state.instanceDeliveries = retained;
  return true;
}

/** The instance a persisted lifecycle command concerns, regardless of its wire shape. */
const commandInstanceId = (message: InstanceHubMessage): string => {
  if (message.type === "instance.provision") return message.instance.id;
  if (message.type === "instance.release") return message.instanceId;
  return message.instance.id;
};

/** Rejects persisted instance state the hub cannot interpret; nothing is defaulted. */
export function assertPersistedInstanceState(state: State) {
  for (const [name, collection] of [
    ["instances", state.instances], ["allocations", state.allocations], ["templates", state.templates],
    ["instanceLifecycleReceipts", state.instanceLifecycleReceipts], ["instanceReleaseIntents", state.instanceReleaseIntents],
    ["instanceDeliveries", state.instanceDeliveries], ["remoteReleaseRequests", state.remoteReleaseRequests]
  ] as const) {
    if (!Array.isArray(collection)) throw new Error(`Persisted ${name} collection is not an array`);
  }
  const threadIds = new Set((state.threads ?? []).flatMap((thread) => (isRecord(thread) && isNonEmptyString(thread.id) ? [thread.id] : [])));
  const instanceIds = new Set<string>();
  for (const [index, instance] of (state.instances ?? []).entries()) {
    const context = `Persisted instance ${index}`;
    const validated = validateAgentInstance(instance);
    if (!validated.ok) throw new Error(`${context} is invalid: ${validated.reason}`);
    if (instanceIds.has(instance.id)) throw new Error(`${context} repeats instance id ${instance.id}`);
    instanceIds.add(instance.id);
    if (!threadIds.has(instance.threadId)) throw new Error(`${context} names unknown thread ${instance.threadId}`);
  }
  const instanceThreadIds = new Map((state.instances ?? []).map((instance) => [instance.id, instance.threadId]));
  const allocationIds = new Set<string>();
  const allocationsById = new Map<string, InstanceAllocation>();
  const occupying = new Map<string, number>();
  for (const [index, allocation] of (state.allocations ?? []).entries()) {
    const context = `Persisted instance allocation ${index}`;
    const validated = validateInstanceAllocation(allocation);
    if (!validated.ok) throw new Error(`${context} is invalid: ${validated.reason}`);
    if (allocationIds.has(allocation.id)) throw new Error(`${context} repeats allocation id ${allocation.id}`);
    allocationIds.add(allocation.id);
    if (!instanceIds.has(allocation.instanceId)) throw new Error(`${context} names unknown instance ${allocation.instanceId}`);
    allocationsById.set(allocation.id, allocation);
    if (occupyingAllocationStatuses.includes(allocation.status)) {
      const count = (occupying.get(allocation.instanceId) ?? 0) + 1;
      occupying.set(allocation.instanceId, count);
      if (count > 1) throw new Error(`${context} gives instance ${allocation.instanceId} more than one current allocation`);
    }
  }
  for (const [index, instance] of (state.instances ?? []).entries()) {
    if (instance.status === "requested" && (occupying.get(instance.id) ?? 0) > 0) {
      throw new Error(`Persisted instance ${index} is requested but holds a current allocation`);
    }
    if (terminalInstanceStatuses.includes(instance.status) && (occupying.get(instance.id) ?? 0) > 0) {
      throw new Error(`Persisted instance ${index} is ${instance.status} but still holds a current allocation`);
    }
  }
  const receiptKeys = new Set<string>();
  for (const [index, receipt] of (state.instanceLifecycleReceipts ?? []).entries()) {
    const context = `Persisted instance lifecycle receipt ${index}`;
    if (!isRecord(receipt) || !isNonEmptyString(receipt.id) || !isNonEmptyString(receipt.threadId) || !isNonEmptyString(receipt.sourceKey)
      || !isNonEmptyString(receipt.idempotencyKey) || !isNonEmptyString(receipt.digest) || !isNonEmptyString(receipt.instanceId)
      || !isNonEmptyString(receipt.createdAt)) {
      throw new Error(`${context} is malformed`);
    }
    if (!(instanceLifecycleOperations as readonly string[]).includes(receipt.operation)) throw new Error(`${context} has an unknown operation`);
    if (!threadIds.has(receipt.threadId)) throw new Error(`${context} names unknown thread ${receipt.threadId}`);
    if (!instanceIds.has(receipt.instanceId)) throw new Error(`${context} names unknown instance ${receipt.instanceId}`);
    // Both identifiers existing is not the invariant; the receipt must name the thread its instance
    // belongs to, or a thread-scoped replay could answer with an instance from another thread.
    if (instanceThreadIds.get(receipt.instanceId) !== receipt.threadId) {
      throw new Error(`${context} names instance ${receipt.instanceId} from another thread`);
    }
    const key = `${receipt.threadId}\u0000${receipt.sourceKey}\u0000${receipt.idempotencyKey}`;
    if (receiptKeys.has(key)) throw new Error(`${context} repeats its caller and idempotency key`);
    receiptKeys.add(key);
  }
  for (const [index, intent] of (state.instanceReleaseIntents ?? []).entries()) {
    const context = `Persisted instance release intent ${index}`;
    if (!isRecord(intent) || !isNonEmptyString(intent.instanceId) || !isNonEmptyString(intent.threadId)
      || (intent.mode !== "drain" && intent.mode !== "cancel")) {
      throw new Error(`${context} is malformed`);
    }
    if (!instanceIds.has(intent.instanceId)) throw new Error(`${context} names unknown instance ${intent.instanceId}`);
    if (instanceThreadIds.get(intent.instanceId) !== intent.threadId) {
      throw new Error(`${context} names instance ${intent.instanceId} from another thread`);
    }
  }
  for (const [index, record] of (state.instanceDeliveries ?? []).entries()) {
    const context = `Persisted instance delivery ${index}`;
    if (!isRecord(record) || !isNonEmptyString(record.allocationId) || !isNonEmptyString(record.nodeId) || !isNonEmptyString(record.createdAt)
      || (record.kind !== "provision" && record.kind !== "release") || !isRecord(record.message)) {
      throw new Error(`${context} is malformed`);
    }
    if (!validateInstanceHubMessage(record.message as InstanceHubMessage, "5").ok) throw new Error(`${context} holds a command that is not wire-valid`);
    const expectedType = record.kind === "provision" ? "instance.provision" : "instance.release";
    if (record.message.type !== expectedType) throw new Error(`${context} holds a command that does not match its kind`);
    /*
     * A command is addressed by allocation, so the allocation must exist and the record's node and
     * instance must be the ones that allocation names. Otherwise a snapshot could replay a command
     * to a node that never held the instance, or against a generation the allocation does not own.
     */
    const allocation = allocationsById.get(record.allocationId);
    if (!allocation) throw new Error(`${context} names unknown allocation ${record.allocationId}`);
    if (allocation.nodeId !== record.nodeId) throw new Error(`${context} names a node that does not hold allocation ${record.allocationId}`);
    if (commandInstanceId(record.message as InstanceHubMessage) !== allocation.instanceId) {
      throw new Error(`${context} holds a command for an instance that does not own allocation ${record.allocationId}`);
    }
  }
  for (const [index, request] of (state.remoteReleaseRequests ?? []).entries()) {
    const context = `Persisted remote release request ${index}`;
    if (!isRecord(request) || !isNonEmptyString(request.nodeId) || !isNonEmptyString(request.instanceId) || !isNonEmptyString(request.requestedAt)) {
      throw new Error(`${context} is malformed`);
    }
  }
  const templateIds = new Set<string>();
  for (const [index, template] of (state.templates ?? []).entries()) {
    const context = `Persisted agent template ${index}`;
    const validated = validateAgentTemplate(template);
    if (!validated.ok) throw new Error(`${context} is invalid: ${validated.reason}`);
    if (templateIds.has(template.id)) throw new Error(`${context} repeats template id ${template.id}`);
    templateIds.add(template.id);
  }
}
