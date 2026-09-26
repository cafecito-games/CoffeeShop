import { createHash } from "node:crypto";
import {
  canTransitionAllocation,
  canTransitionInstance,
  defaultInstanceIdleTimeoutSeconds,
  instanceLifecycleOperations,
  instanceLimits,
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
  type ExecutionRequirements,
  type HarnessId,
  type HarnessTransport,
  type InstanceAllocation,
  type InstanceControlMessage,
  type InstanceCreator,
  type InstanceHubMessage,
  type InstanceLifecycleRequest,
  type InstanceLifecycleResult,
  type InstancePurpose,
  type InstanceReleaseMode,
  type InstanceRun,
  type InstanceStatus,
  type Run
} from "@coffee-shop/protocol";
import { CoordinationError } from "./coordinationError.js";
import { newEvent, newId, type State, type Store } from "./store.js";
import { appendInitialTaskInState, initialTaskOrigin } from "./tasks.js";

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
  /**
   * The receipt budget of one instance. Receipts are never dropped while their instance is retained,
   * because dropping one silently invalidates an accepted idempotency key: an exact replay would run
   * as a new operation and a differing digest would be accepted instead of conflicting. The
   * collection is bounded by refusing a *new* key beyond the budget instead, so the bound is visible
   * to the caller rather than paid for by a broken guarantee. A replay of an existing key is never
   * refused, and an instance that exhausts its budget still converges through idle expiry.
   */
  retainedReceiptsPerInstance: 50,
  /**
   * Budget reserved for release requests, so an instance whose renewal budget is exhausted can still
   * be released explicitly: one drain plus its cancel escalation.
   */
  releaseReceiptHeadroom: 2
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
  /**
   * `dispatch` carries one task attempt to a ready resident. It is persisted before its send exactly
   * like the other two, so a crash between the attempt's commit and its socket write replays the
   * dispatch instead of stranding a queued run, and it is retired once the run has left `queued`.
   */
  kind: "provision" | "release" | "dispatch";
  nodeId: string;
  message: InstanceHubMessage;
  createdAt: string;
  /**
   * Position of this command in its allocation's command order, assigned when the record is written.
   * Release mode escalates monotonically (drain then cancel), so the peer must never end up holding a
   * weaker mode than the hub's persisted intent: only the highest-sequence release record of an
   * allocation is ever sent or re-armed, and the records it supersedes are retired.
   */
  sequence: number;
  /** When a socket write was accepted for this command; evidence of a send, never of receipt. */
  deliveredAt?: string;
}

/**
 * A release requested for a resident the hub does not own; never adopted as hub state. It is a
 * command and nothing else: it carries no occupancy, so delivering it cannot change a node's resident
 * capacity — `nodeInstanceResidency` is the only record of who is resident.
 *
 * `deliveredAt` is a send record, exactly as on `InstanceDeliveryRecord`: an accepted socket write
 * does not retire the request, because the hub holds no allocation the node could acknowledge. The
 * node's own later authoritative snapshot settles it — it retires the request by no longer reporting
 * the resident, and re-arms it for replay while it still does. Deduplicated by node and instance, one
 * node's requests are therefore bounded by one snapshot's resident set
 * (`instanceLimits.collectionEntries`) however often the node reconnects, and no audit bound prunes
 * them.
 */
export interface RemoteReleaseRequest {
  nodeId: string;
  instanceId: string;
  requestedAt: string;
  /** When a socket write was accepted for this request; evidence of a send, never of receipt. */
  deliveredAt?: string;
}

/**
 * The resident set of one node, replaced wholesale by each report that carries resident identities —
 * every heartbeat as well as the `sync.complete` behind the replay barrier (#114). It is the hub's
 * single record of who is resident on a node, and — beside the hub's own occupying allocations — the
 * only source of resident occupancy.
 *
 * Wholesale replacement is what makes it authoritative: a report that names nothing supersedes every
 * earlier claim about that node, the `activeInstances` scalar included. Arriving on every beat is
 * what makes it *current*: an identity the node has stopped hosting disappears within one heartbeat
 * interval, so the hub never has to infer vacancy from its own local status.
 */
export interface NodeInstanceResidency {
  nodeId: string;
  /** Every instance identity the node reported resident in its latest report. */
  instanceIds: string[];
  observedAt: string;
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
 * The two control frames that carry a node's resident identities. `sync.complete` carries the set
 * once per connection, behind the replay barrier; `heartbeat` carries the same set on every beat
 * (#114), which is what makes the hub's residency record current truth rather than an attachment-time
 * observation.
 */
export type InstanceResidencyCarrier = "sync.complete" | "heartbeat";

/**
 * Classifies the resident evidence of a control frame. The protocol validator runs before the
 * classification, so no decision is ever taken on an unvalidated field: a present but malformed
 * `activeInstanceIds` is reported as malformed instead of collapsing into absent.
 *
 * Both carriers are classified here rather than by a second, parallel reader. The wire field, its
 * validator and its `instanceLimits.collectionEntries` bound are shared, so the evidence a heartbeat
 * carries is the same evidence with the same three outcomes, and the caller names the carrier it is
 * reading so a frame of the other kind can never be mistaken for it.
 */
export function classifyInstanceResidentEvidence(
  frame: unknown,
  version: ControlProtocolVersion,
  carrier: InstanceResidencyCarrier
): InstanceResidentEvidence {
  if (!supportsControlCapability(version, "instances")) return { kind: "absent" };
  const validated = validateInstanceControlMessage(frame, version);
  if (!validated.ok) return { kind: "malformed", reason: validated.reason };
  if (validated.value.type !== carrier) return { kind: "malformed", reason: `the frame is not ${carrier === "heartbeat" ? "a heartbeat" : "a reconciliation barrier"}` };
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
  /**
   * Slots held by the union of persisted resident intent and the residency the node itself reports;
   * where the node has reported only a count, the upper bound of that union, because a count and a
   * set of identities cannot be reconciled.
   */
  used: number;
}

/**
 * Resident usage for one node. A node without `instanceCapacity` is incapable of hosting instances
 * (zero capacity).
 *
 * Every residency state a node can be in is derived here, and each from evidence rather than a
 * default:
 *
 * - **A resident record exists.** Residency is a set of identities, and the record is the node's own
 *   complete resident set as of its latest report. Usage is the union, by identity, of the occupying
 *   allocations this hub persists for the node — whether or not the node has reported them yet, so a
 *   provision in flight cannot overbook — and the identities the record names that the hub does not
 *   own. An overlap is counted once.
 *
 *   Nothing the hub knows locally discounts an identity the record names. The node reports its
 *   residents on every heartbeat (#114), so the record is newer evidence than any allocation status
 *   the hub has settled against it, and reading that status back over the record is exactly what
 *   produced six successive wrong accounting rules: a `released` allocation whose pruning destroyed
 *   the discount, a `failed` one whose resident Barista had in fact retained, and an acknowledgement
 *   the lifecycle rejected being read as residency evidence. The cost of trusting the record is that
 *   a resident the node has just deleted keeps its slot until the node's next beat — bounded lag in
 *   the safe direction, where overbooking is not.
 * - **A resident record exists and is empty.** The union is the hub's own occupying allocations, so an
 *   empty record means zero unowned residency, authoritatively.
 * - **No resident record has ever arrived.** `activeInstanceIds` is optional on the wire, so a node
 *   may report only the `activeInstances` count, and a count cannot be reconciled with a set of
 *   identities: the hub cannot tell whether it names the instances it already owns or others
 *   entirely. Residency therefore lies between `max(owned, count)` and `owned + count`, and only the
 *   upper bound is safe to place a reservation against, so the count is added to the owned identities
 *   rather than maxed against them. Overbooking produces a provision Barista must reject; refusing a
 *   candidate only defers it until the node's first identity report, which supersedes the count
 *   entirely. A count of zero costs nothing, because the two bounds coincide there.
 * - **The count is absent or malformed.** It is unknown, never zero and never a default: it
 *   contributes nothing, and only the hub's own occupying allocations count.
 */
export function residentInstanceUsage(
  node: ComputeNode,
  allocations: readonly InstanceAllocation[],
  residency?: NodeInstanceResidency
): ResidentInstanceUsage {
  const capacity = Number.isSafeInteger(node.instanceCapacity) && node.instanceCapacity! > 0 ? node.instanceCapacity! : 0;
  const owned = new Set(allocations
    .filter((allocation) => allocation.nodeId === node.id && occupyingAllocationStatuses.includes(allocation.status))
    .map((allocation) => allocation.instanceId));
  if (residency !== undefined && residency.nodeId === node.id) {
    const unowned = new Set(residency.instanceIds.filter((instanceId) => !owned.has(instanceId)));
    return { capacity, used: owned.size + unowned.size };
  }
  const unnamedResidents = Number.isSafeInteger(node.activeInstances) && node.activeInstances! > 0 ? node.activeInstances! : 0;
  return { capacity, used: owned.size + unnamedResidents };
}

/** The node's resident set, if it has ever reported one. */
export function nodeResidencyInState(state: Readonly<State>, nodeId: string): NodeInstanceResidency | undefined {
  return (state.nodeInstanceResidency ?? []).find((record) => record.nodeId === nodeId);
}

/** Resident usage for one node: its own occupying allocations and the node's latest resident report. */
export function residentInstanceUsageInState(state: Readonly<State>, node: ComputeNode): ResidentInstanceUsage {
  return residentInstanceUsage(node, state.allocations ?? [], nodeResidencyInState(state, node.id));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isOptionalNonEmptyString = (value: unknown): boolean => value === undefined || isNonEmptyString(value);

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
 * Refuses a *new* idempotency key for an instance that has spent its receipt budget. The alternative
 * — accepting the key and dropping an older receipt of the same live instance — would silently
 * invalidate an accepted key, so a bounded, visible error is preferred to a broken guarantee. A
 * replay of an existing key never reaches this check, and release keeps reserved headroom so an
 * instance whose renewal budget is spent can still be released explicitly.
 */
function assertReceiptBudget(state: Readonly<State>, instanceId: string, operation: (typeof instanceLifecycleOperations)[number]) {
  const budget = instanceAuditLimits.retainedReceiptsPerInstance
    - (operation === "release" ? 0 : instanceAuditLimits.releaseReceiptHeadroom);
  const held = (state.instanceLifecycleReceipts ?? []).filter((receipt) => receipt.instanceId === instanceId).length;
  if (held < budget) return;
  throw new CoordinationError(
    "conflict",
    `Instance ${instanceId} has reached its ${instanceAuditLimits.retainedReceiptsPerInstance}-receipt idempotency budget; replay an existing key instead`
  );
}

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
      /*
       * Scope before anything observable. The receipt budget is a property of the named instance, so
       * checking it before the instance is known to belong to the requested thread would answer for a
       * foreign instance: one at its budget would conflict while one below it stayed hidden behind the
       * not-found answer, which is how a caller could probe another thread's instances.
       */
      assertReceiptBudget(state, instance.id, request.operation);
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

/** The next position in one allocation's command order; positions are never reused. */
const nextDeliverySequence = (state: Readonly<State>, allocationId: string): number =>
  1 + (state.instanceDeliveries ?? [])
    .filter((record) => record.allocationId === allocationId)
    .reduce((highest, record) => Math.max(highest, record.sequence), 0);

/** The highest-sequence release command of an allocation: the only one still eligible to be sent. */
const latestReleaseCommand = (state: Readonly<State>, allocationId: string): InstanceDeliveryRecord | undefined =>
  (state.instanceDeliveries ?? [])
    .filter((record) => record.kind === "release" && record.allocationId === allocationId)
    .reduce<InstanceDeliveryRecord | undefined>((latest, record) => (latest && latest.sequence >= record.sequence ? latest : record), undefined);

/**
 * Escalation of a drain request to cancel. An undelivered drain command is rewritten in place; a
 * delivered one is followed by a new persisted cancel command at the next position in the
 * allocation's command order, so Barista always hears the stronger mode while each command is still
 * persisted before its send. The superseded drain keeps a lower sequence and is therefore never sent
 * or re-armed again, which is what stops a reconnect from delivering the weaker mode last.
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
      createdAt: at,
      sequence: nextDeliverySequence(state, allocation.id)
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
    result = reserveInstanceAllocationInState(state, instanceId, candidate, at);
    return result.kind === "reserved";
  });
  return result;
}

/**
 * The reservation itself, inside the caller's transaction. It is the single authority for resident
 * admission: the scheduler (#77) calls it so that the task's placement intent, the instance request,
 * the allocation, and the persisted provision command all commit together, which is what stops two
 * concurrent passes from overbooking one node's resident capacity or creating duplicate instances.
 * `reserveInstanceAllocation` is the same decision wrapped in its own transaction for callers that
 * own no other writes.
 */
export function reserveInstanceAllocationInState(
  state: State,
  instanceId: string,
  candidate: AllocationCandidate,
  at: string
): ReservationResult {
  const instance = (state.instances ?? []).find((item) => item.id === instanceId);
  if (!instance) return { kind: "not-found" };
  const refusal = allocationRefusal(state, instance, candidate);
  if (refusal !== undefined) return { kind: "capacity", reason: refusal };
  const node = state.nodes.find((item) => item.id === candidate.nodeId)!;
  return { kind: "reserved", allocation: structuredClone(writeAllocationInState(state, instance, node, candidate, at)) };
}

/**
 * Why this candidate may not hold a resident slot for this instance, or `undefined` when it may. It
 * is the single admission rule, shared by the reservation of an existing instance and by the
 * scheduler's create-and-reserve, so neither path can admit what the other refuses. It reads state
 * and writes nothing, which is what lets the create-and-reserve refuse before any record exists.
 */
function allocationRefusal(state: Readonly<State>, instance: AgentInstance, candidate: AllocationCandidate): string | undefined {
  if (instance.status !== "requested" || currentAllocationInState(state, instance.id) !== undefined) {
    return `Instance ${instance.id} already holds an allocation`;
  }
  const node = state.nodes.find((item) => item.id === candidate.nodeId);
  if (!node || (node.status !== "online" && node.status !== "busy")) return `Compute node ${candidate.nodeId} is not available`;
  const usage = residentInstanceUsageInState(state, node);
  if (usage.used >= usage.capacity) {
    return `Compute node ${candidate.nodeId} has no resident instance capacity (${usage.used}/${usage.capacity})`;
  }
  const harness = node.harnesses.find((item) => item.id === candidate.harnessId);
  if (!harness || !harness.available) return `Harness ${candidate.harnessId} is not available on ${node.id}`;
  if (harness.models.length > 0 && !harness.models.includes(candidate.model)) {
    return `Model ${candidate.model} is not offered by ${candidate.harnessId} on ${node.id}`;
  }
  if (!(harness.transports ?? ["native-cli"]).includes(candidate.transport)) {
    return `Transport ${candidate.transport} is not offered by ${candidate.harnessId} on ${node.id}`;
  }
  if (!(node.workspaceRoots ?? []).some((root) => isUnderWorkspaceRoot(candidate.workspace, root))) {
    return `Workspace ${candidate.workspace} is outside an authorized root on ${node.id}`;
  }
  return undefined;
}

/** Writes the allocation, moves the instance to `provisioning`, and persists its provision command. */
function writeAllocationInState(state: State, instance: AgentInstance, node: ComputeNode, candidate: AllocationCandidate, at: string): InstanceAllocation {
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
  state.instanceDeliveries.push({ allocationId: allocation.id, kind: "provision", nodeId: node.id, message, createdAt: at, sequence: nextDeliverySequence(state, allocation.id) });
  state.events.unshift(newEvent({
    type: "status",
    title: "Instance allocation reserved",
    detail: `${instanceEventDetail(instance)} on ${node.id}`,
    threadId: instance.threadId
  }));
  return allocation;
}

/** The seed for a scheduler-requested instance; no lifecycle idempotency receipt is involved. */
export interface InstanceRequestSeed {
  threadId: string;
  requirements: ExecutionRequirements;
  purpose?: InstancePurpose;
  creator?: InstanceCreator;
  idleTimeoutSeconds?: number;
}

/** Builds and wire-validates a `requested` instance record without writing it. */
function buildRequestedInstance(threadId: string, seed: InstanceRequestSeed, at: string): AgentInstance {
  const idleTimeoutSeconds = seed.idleTimeoutSeconds ?? defaultInstanceIdleTimeoutSeconds;
  const instance: AgentInstance = {
    id: newId("instance"),
    threadId,
    creator: seed.creator ? { ...seed.creator } : { ...operatorInstanceCreator },
    ...(seed.purpose ? { purpose: structuredClone(seed.purpose) } : {}),
    delegation: { canDelegate: false },
    requirements: structuredClone(seed.requirements),
    lease: { idleTimeoutSeconds, expiresAt: leaseExpiry(at, idleTimeoutSeconds) },
    status: "requested",
    createdAt: at,
    updatedAt: at
  };
  const validated = validateAgentInstance(instance);
  if (!validated.ok) throw new CoordinationError("invalid_arguments", `The instance request is not wire-valid: ${validated.reason}`);
  return instance;
}

/**
 * Requests one instance inside the caller's transaction, in `requested` status and without an
 * allocation. The scheduler uses it for the ad-hoc placement path, where there is no external
 * idempotency key to receipt: the caller's own single-writer guard — the task's
 * `placementInstanceId`, committed in this same transaction — is what makes the request happen once.
 */
export function requestInstanceInState(state: State, seed: InstanceRequestSeed, at: string): AgentInstance {
  const thread = (state.threads ?? []).find((item) => item.id === seed.threadId);
  if (!thread) throw new CoordinationError("not_found", "Thread not found");
  if (thread.status !== "active") throw new CoordinationError("thread_inactive", "Instance creation requires an active thread");
  const instance = buildRequestedInstance(thread.id, seed, at);
  state.instances ??= [];
  state.instances.unshift(instance);
  state.events.unshift(newEvent({
    type: "status",
    title: "Instance requested",
    detail: instanceEventDetail(instance),
    threadId: thread.id
  }));
  return instance;
}

export type InstancePlacementResult =
  | { kind: "placed"; instance: AgentInstance; allocation: InstanceAllocation }
  | { kind: "capacity"; reason: string };

/**
 * Requests one instance and reserves its allocation as a single mutation, inside the caller's
 * transaction. This is how the scheduler (#77) commits task intent, instance request, and resident
 * reservation together: admission is decided before anything is written, so a refusal leaves no
 * instance, allocation, event, or outbox entry behind, and a parallel pass reading the same state can
 * neither duplicate the instance nor overbook the node's resident capacity.
 */
export function placeInstanceInState(state: State, seed: InstanceRequestSeed, candidate: AllocationCandidate, at: string): InstancePlacementResult {
  const thread = (state.threads ?? []).find((item) => item.id === seed.threadId);
  if (!thread) throw new CoordinationError("not_found", "Thread not found");
  if (thread.status !== "active") throw new CoordinationError("thread_inactive", "Instance creation requires an active thread");
  const instance = buildRequestedInstance(thread.id, seed, at);
  const refusal = allocationRefusal(state, instance, candidate);
  if (refusal !== undefined) return { kind: "capacity", reason: refusal };
  state.instances ??= [];
  state.instances.unshift(instance);
  state.events.unshift(newEvent({
    type: "status",
    title: "Instance requested",
    detail: instanceEventDetail(instance),
    threadId: thread.id
  }));
  const node = state.nodes.find((item) => item.id === candidate.nodeId)!;
  return { kind: "placed", instance, allocation: writeAllocationInState(state, instance, node, candidate, at) };
}

/**
 * Records that a ready or idle resident accepted work: it becomes `busy` and its idle lease is
 * refreshed on the instance and its current allocation together, because the wire contract requires
 * the two leases to agree. Returns the instance and the allocation the attempt must name, or
 * `undefined` when the resident can no longer accept work — the scheduler treats that as a placement
 * failure rather than dispatching against a stale generation.
 */
export function acceptInstanceWorkInState(state: State, instanceId: string, at: string):
  { instance: AgentInstance; allocation: InstanceAllocation } | undefined {
  const instance = (state.instances ?? []).find((item) => item.id === instanceId);
  if (!instance || (instance.status !== "ready" && instance.status !== "idle" && instance.status !== "busy")) return undefined;
  const allocation = currentAllocationInState(state, instanceId);
  if (!allocation || allocation.status !== "active") return undefined;
  if (instance.status !== "busy") {
    if (!canTransitionInstance(instance.status, "busy")) return undefined;
    instance.status = "busy";
  }
  instance.lease = { idleTimeoutSeconds: instance.lease.idleTimeoutSeconds, expiresAt: leaseExpiry(at, instance.lease.idleTimeoutSeconds) };
  instance.updatedAt = at;
  allocation.lease = { ...instance.lease };
  allocation.updatedAt = at;
  return { instance, allocation };
}

/**
 * Persists one task attempt for a ready resident as a `dispatch` command in the same crash-safe
 * outbox the provision and release commands use, inside the caller's transaction. The command is
 * wire-validated here, so an attempt whose resolved placement disagrees with its allocation is
 * refused before it can be committed rather than silently dropped at send time.
 */
export function appendInstanceDispatchInState(state: State, run: InstanceRun, at: string) {
  const instance = (state.instances ?? []).find((item) => item.id === run.instanceId);
  if (!instance) throw new CoordinationError("not_found", "Instance not found");
  const allocation = (state.allocations ?? []).find((item) => item.id === run.allocationId);
  if (!allocation || allocation.instanceId !== instance.id) throw new CoordinationError("not_found", "Instance allocation not found");
  const message: InstanceHubMessage = {
    type: "dispatch",
    instance: structuredClone(instance),
    allocation: structuredClone(allocation),
    run: structuredClone(run)
  };
  const wireValid = validateInstanceHubMessage(message, "5");
  if (!wireValid.ok) throw new CoordinationError("invalid_arguments", `The dispatch command is not wire-valid: ${wireValid.reason}`);
  state.instanceDeliveries ??= [];
  state.instanceDeliveries.push({
    allocationId: allocation.id,
    kind: "dispatch",
    nodeId: allocation.nodeId,
    message,
    createdAt: at,
    sequence: nextDeliverySequence(state, allocation.id)
  });
}

/** Test seams for the delivery pass; production callers pass none. */
export interface InstanceDeliveryHooks {
  /** Awaited after the outbox is read and before the transaction that decides one command. */
  beforeDelivery?: (record: { allocationId: string; kind: InstanceDeliveryRecord["kind"] }) => void | Promise<void>;
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
    /*
     * An acknowledgement is lifecycle authority only; it carries no residency weight of its own. Who
     * is resident on a node is the node's own report, which now arrives with every heartbeat, so a
     * report the transition table refuses is refused outright and writes nothing. Reading residency
     * out of an acknowledgement instead — which the hub had to do while the report refreshed only on
     * connection attachment — is what let a rejected frame free a slot, and what made the tombstone
     * guarding its replay able to suppress the next genuine report.
     */
    const rejected = (reason: string): boolean => {
      outcome = { kind: "rejected", changed: false, reason };
      return false;
    };
    const ignored = (): boolean => {
      outcome = { kind: "ignored", changed: false };
      return false;
    };
    if (message.type === "instance.ready") {
      if (allocation.status === "active" && nonTerminalInstanceStatuses.includes(instance.status)) return ignored();
      if (!isCurrentGeneration || !canTransitionAllocation(allocation.status, "active") || !canTransitionInstance(instance.status, "ready")) {
        return rejected("the ready report does not match the current allocation generation or a legal transition");
      }
      allocation.status = "active";
      allocation.updatedAt = at;
      instance.status = "ready";
      instance.updatedAt = at;
      outcome = { kind: "accepted", changed: true };
      return true;
    }
    if (message.type === "instance.failed") {
      if (allocation.status === "failed" && instance.status === "failed") return ignored();
      if (!isCurrentGeneration || !canTransitionAllocation(allocation.status, "failed") || !canTransitionInstance(instance.status, "failed")) {
        return rejected("the failure report does not match the current allocation generation or a legal transition");
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
    if (allocation.status === "released" && instance.status === "released") return ignored();
    if (!isCurrentGeneration || !canTransitionAllocation(allocation.status, "released") || instance.status !== "draining" || !canTransitionInstance(instance.status, "released")) {
      return rejected("the release report does not match the current allocation generation or a legal transition");
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
 * The residency record and the outbox it authorizes are written by `applyNodeResidencyInState`, which
 * a heartbeat carrying the same identities calls on its own. What stays here is what only a reconnect
 * can decide: which allocations the node has lost, and which already-written commands must replay
 * because the socket that carried them is gone.
 */
export function reconcileNodeInstancesInState(state: State, nodeId: string, activeInstanceIds: readonly string[], at: string): boolean {
  const reported = new Set(activeInstanceIds);
  const instancesById = new Map((state.instances ?? []).map((instance) => [instance.id, instance]));
  const expected = (state.allocations ?? []).filter((allocation) => allocation.nodeId === nodeId && occupyingAllocationStatuses.includes(allocation.status));
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
  if (applyNodeResidencyInState(state, nodeId, activeInstanceIds, at)) changed = true;
  /*
   * A resident the node still reports after an authoritative reconnect is proof it never acted on the
   * remote release the hub had already written to the previous socket, so the request is re-armed in
   * place and replays. Re-arming belongs to the reconnect and not to the heartbeats that carry the
   * same identities: a socket write is only in doubt when the connection that carried it is gone, and
   * re-arming per beat would resend the same release for as long as the node kept reporting the
   * resident. Reusing the record keeps the outbox from growing per reconnect, so a Barista that
   * legitimately refuses to release costs one resend per reconnect, exactly like an owned release.
   */
  for (const request of state.remoteReleaseRequests ?? []) {
    if (request.nodeId !== nodeId || !reported.has(request.instanceId) || request.deliveredAt === undefined) continue;
    delete request.deliveredAt;
    changed = true;
  }
  /*
   * A dispatch whose run is still `queued` after the socket that carried it is gone has no evidence
   * behind it either: the send was accepted locally, which is not proof of receipt, and Barista would
   * have reported `run.started` had it acted. It is re-armed in place — exactly like a release — so a
   * reconnect resends the same attempt rather than creating a second one.
   */
  for (const record of state.instanceDeliveries ?? []) {
    if (record.kind !== "dispatch" || record.nodeId !== nodeId || record.deliveredAt === undefined) continue;
    const message = record.message;
    if (message.type !== "dispatch") continue;
    const dispatched = state.runs.find((item) => item.id === message.run.id);
    if (!dispatched || dispatched.status !== "queued") continue;
    delete record.deliveredAt;
    changed = true;
  }
  return changed;
}

/**
 * Applies a node's own resident identity report: the record, and the release outbox that record
 * authorizes. Barista sends this set on every heartbeat as well as with its reconnect barrier (#114),
 * so the record is the node's current word about who is resident rather than an attachment-time
 * observation, and the capacity derivation reads nothing else about unowned residency.
 *
 * Three writes belong to the report itself, none of which depend on the connection being new. The
 * record is replaced wholesale, which is what makes it authoritative over every earlier claim about
 * the node, the `activeInstances` scalar included. A resident the hub holds no occupying allocation
 * for is asked to release, because the hub never adopts a resident it did not place. A request for a
 * resident the node no longer reports is retired, because the command has nothing left to act on —
 * which is what keeps the outbox finite and keeps every persisted request backed by residency
 * evidence, as the relationship load validation requires. Each node's requests are therefore bounded
 * by the resident set one report may carry (`instanceLimits.collectionEntries`).
 */
export function applyNodeResidencyInState(state: State, nodeId: string, activeInstanceIds: readonly string[], at: string): boolean {
  const reported = new Set(activeInstanceIds);
  const instancesById = new Map((state.instances ?? []).map((instance) => [instance.id, instance]));
  const expectedInstanceIds = new Set((state.allocations ?? [])
    .filter((allocation) => allocation.nodeId === nodeId && occupyingAllocationStatuses.includes(allocation.status))
    .flatMap((allocation) => {
      const instance = instancesById.get(allocation.instanceId);
      return instance ? [instance.id] : [];
    }));
  let changed = recordNodeResidency(state, nodeId, activeInstanceIds, at);
  for (const instanceId of reported) {
    if (expectedInstanceIds.has(instanceId)) continue;
    state.remoteReleaseRequests ??= [];
    if (state.remoteReleaseRequests.some((request) => request.nodeId === nodeId && request.instanceId === instanceId)) continue;
    state.remoteReleaseRequests.push({ nodeId, instanceId, requestedAt: at });
    changed = true;
  }
  const requests = state.remoteReleaseRequests ?? [];
  const retained = requests.filter((request) => request.nodeId !== nodeId || reported.has(request.instanceId));
  if (retained.length !== requests.length) {
    state.remoteReleaseRequests = retained;
    changed = true;
  }
  return changed;
}

/** Replaces the node's authoritative resident record with this snapshot's set. */
function recordNodeResidency(state: State, nodeId: string, activeInstanceIds: readonly string[], at: string): boolean {
  state.nodeInstanceResidency ??= [];
  const instanceIds = [...new Set(activeInstanceIds)];
  const existing = state.nodeInstanceResidency.find((record) => record.nodeId === nodeId);
  if (!existing) {
    state.nodeInstanceResidency.push({ nodeId, instanceIds, observedAt: at });
    return true;
  }
  // A snapshot that repeats the known resident set is not a change, so the record is left untouched
  // rather than rewritten: reconciliation reports a change only when the hub's state actually moved.
  if (existing.instanceIds.length === instanceIds.length && instanceIds.every((instanceId) => existing.instanceIds.includes(instanceId))) return false;
  existing.instanceIds = instanceIds;
  existing.observedAt = at;
  return true;
}

/**
 * Re-arms release commands this node has not acted on. A socket write that returned is not proof the
 * peer received the frame, so a release whose instance the node still reports resident after an
 * authoritative reconnect is marked undelivered again and replays. The record is reused rather than
 * duplicated, so replay cannot grow the outbox — one resend per authoritative reconnect, which is why
 * a Barista that legitimately refuses to release cannot make this loop.
 *
 * Only the highest-sequence release command of an allocation is ever re-armed. Release mode escalates
 * monotonically, so re-arming a command a later one supersedes could deliver the weaker mode after the
 * stronger one and leave the peer draining an instance the hub has already ordered cancelled. An
 * already-undelivered latest command needs no re-arming and is left for the next flush.
 */
function rearmUnacknowledgedReleases(state: State, nodeId: string, reported: ReadonlySet<string>, at: string): boolean {
  const allocationsById = new Map((state.allocations ?? []).map((allocation) => [allocation.id, allocation]));
  const latestByAllocation = new Map<string, InstanceDeliveryRecord>();
  for (const record of state.instanceDeliveries ?? []) {
    if (record.kind !== "release") continue;
    const latest = latestByAllocation.get(record.allocationId);
    if (!latest || record.sequence > latest.sequence) latestByAllocation.set(record.allocationId, record);
  }
  let changed = false;
  for (const record of latestByAllocation.values()) {
    if (record.nodeId !== nodeId || record.deliveredAt === undefined) continue;
    const allocation = allocationsById.get(record.allocationId);
    if (!allocation || !occupyingAllocationStatuses.includes(allocation.status) || !reported.has(allocation.instanceId)) continue;
    record.deliveredAt = undefined;
    record.createdAt = at;
    changed = true;
  }
  return changed;
}

/** Expires idle leases, converges instance activity and drains, and prunes terminal audit records. */
export async function maintainInstanceLifecycle(store: Store, at = new Date().toISOString()): Promise<boolean> {
  let changed = false;
  await store.transact((state) => {
    const converged = convergeInstanceActivityInState(state, at);
    const expired = expireIdleInstances(state, at);
    const settled = settleDrainingInstances(state, at);
    const pruned = pruneInstanceAuditRecords(state);
    changed = converged || expired || settled || pruned;
    return changed;
  });
  return changed;
}

/**
 * Returns a resident whose work has finished to `idle`, inside the caller's transaction. Accepting a
 * task attempt makes an instance `busy`, and nothing else would ever move it back, so without this a
 * resident would be unreusable for the thread's next task and would only ever leave `busy` through
 * idle-lease expiry. Its lease is not touched: expiry measures idleness from the last accepted work,
 * which is exactly when the lease was last refreshed.
 */
export function convergeInstanceActivityInState(state: State, at: string): boolean {
  let changed = false;
  for (const instance of state.instances ?? []) {
    if (instance.status !== "busy" || activeRunsForInstance(state, instance.id).length > 0) continue;
    if (!canTransitionInstance(instance.status, "idle")) continue;
    instance.status = "idle";
    instance.updatedAt = at;
    changed = true;
  }
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
        createdAt: at,
        sequence: nextDeliverySequence(state, allocation.id)
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
    .map((record) => ({ allocationId: record.allocationId, kind: record.kind, sequence: record.sequence }))
    // One allocation's commands are written in escalation order, so they are sent in that order.
    .sort((left, right) => left.sequence - right.sequence));
  for (const { allocationId, kind, sequence } of pending) {
    if (hooks.beforeDelivery) await hooks.beforeDelivery({ allocationId, kind });
    await store.transact((state) => {
      const target = (state.instanceDeliveries ?? []).find((item) => item.allocationId === allocationId && item.sequence === sequence && item.deliveredAt === undefined);
      // A release a later command supersedes is never written, whatever the outbox order: the peer must
      // never receive the weaker mode after the stronger one.
      if (target?.kind === "release" && latestReleaseCommand(state, allocationId)?.sequence !== sequence) return false;
      if (!target || !deliver(target.nodeId, target.message)) return false;
      target.deliveredAt = new Date().toISOString();
      if (target.kind === "provision") {
        const allocation = (state.allocations ?? []).find((item) => item.id === target.allocationId);
        if (allocation && allocation.status === "reserved" && canTransitionAllocation(allocation.status, "provisioning")) {
          allocation.status = "provisioning";
          allocation.updatedAt = target.deliveredAt;
        }
      }
      /*
       * A dispatch records the send on its run too, so an operator sees the same `dispatchedAt` an
       * agent run gets. It is only a send record: the run stays `queued` until Barista reports
       * `run.started`, which is what keeps the command eligible for replay after a reconnect.
       */
      const command = target.message;
      if (target.kind === "dispatch" && command.type === "dispatch") {
        const run = state.runs.find((item) => item.id === command.run.id);
        if (run && run.status === "queued") run.dispatchedAt = target.deliveredAt;
      }
      changed = true;
      return true;
    });
  }
  /*
   * A remote release names no allocation the hub owns, so the instance identity addresses it. The
   * accepted write records only that a send happened: it does not retire the request and it does not
   * free a slot, because the resident stays in the node's authoritative residency record until the node
   * itself stops reporting it. That record is the sole authority for sending too, and absence of it is
   * not permission: a request the node's own residency evidence does not support — whether the record
   * names other residents or the node has produced no record at all — has nothing to act on and is
   * retired instead of being sent.
   */
  const remote = store.read((state) => (state.remoteReleaseRequests ?? [])
    .filter((request) => request.deliveredAt === undefined)
    .map((request) => ({ nodeId: request.nodeId, instanceId: request.instanceId })));
  for (const request of remote) {
    await store.transact((state) => {
      const target = (state.remoteReleaseRequests ?? []).find((item) => item.nodeId === request.nodeId && item.instanceId === request.instanceId && item.deliveredAt === undefined);
      if (!target) return false;
      const residency = nodeResidencyInState(state, target.nodeId);
      if (residency === undefined || !residency.instanceIds.includes(target.instanceId)) {
        state.remoteReleaseRequests = (state.remoteReleaseRequests ?? []).filter((item) => item !== target);
        changed = true;
        return true;
      }
      /*
       * The hub knows only the instance identity of a resident it does not own — a node reports its
       * residents as instance ids — so the instance identity has to address the command in a field
       * the wire defines as an allocation id. Barista resolves a release by allocation id today, so
       * whether this command actually evicts the resident depends on the instance-id fallback tracked
       * by cafecito-games/CoffeeShop#90; the hub side deliberately keeps emitting it, and holds it
       * until the node's own snapshots stop reporting the resident, so the eviction happens as soon as
       * that gate lands without any protocol change here.
       */
      const message: InstanceHubMessage = { type: "instance.release", instanceId: target.instanceId, allocationId: target.instanceId, mode: "cancel" };
      if (!deliver(target.nodeId, message)) return false;
      target.deliveredAt = new Date().toISOString();
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
 * Prunes terminal audit records beyond their bounds, oldest first, together with the intents,
 * delivery records, receipts, and receipt-derived task submissions that reference them. Live records
 * are never touched, and an actionable outbox entry — an undelivered provision, release, or remote
 * release request — is never pruned; only a successful delivery removes it.
 *
 * Nothing is pinned against the bound by residency. A terminal record the node still names is pruned
 * like any other, and the record then names an identity the hub no longer owns, which reads as one
 * occupied slot until the node's next heartbeat stops naming it — bounded lag in the safe direction
 * rather than the permanent phantom occupancy an attachment-only snapshot would have left.
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
    state.instanceReleaseIntents = (state.instanceReleaseIntents ?? []).filter((intent) => !dropped.has(intent.instanceId));
    state.instanceDeliveries = (state.instanceDeliveries ?? []).filter((record) => !dropped.has(commandInstanceId(record.message)));
    changed = true;
  }
  // Receipts and the submissions derived from them are retired in one place, keyed off the instances
  // that survived above, so a receipt can never outlive its instance by one prune path or the other.
  if (pruneLifecycleReceipts(state)) changed = true;
  if (retireSettledDeliveries(state)) changed = true;
  return changed;
}

/**
 * Retires receipts that can no longer answer anything: a receipt whose instance the hub has stopped
 * retaining has no result to replay, because a replay resolves the instance it names. The task
 * submission a create receipt derived is retired in the same step, because retention has to be
 * symmetric: the submission is what answers a replay of the derived key, so keeping it after its
 * receipt is gone would let the same create idempotency key mint a *new* instance while
 * `appendInitialTaskInState` answered with the previous instance's task — a caller handed a new
 * instance whose `initialTaskId` names another instance's work, with no initial task scheduled. The
 * task itself is thread work that may already have run and is never dropped; only the idempotency
 * record derived from the receipt is.
 *
 * Nothing else is dropped. A receipt of a retained instance is the record that an idempotency key was
 * accepted with a given digest, and dropping one would silently invalidate that key — an exact replay
 * would run as a new operation and reuse with a different digest would be accepted instead of
 * conflicting. The collection is bounded at admission instead (`assertReceiptBudget`), so its maximum
 * is the retained instances times `retainedReceiptsPerInstance`, and terminal-instance pruning is what
 * ultimately retires a receipt.
 */
function pruneLifecycleReceipts(state: State): boolean {
  const receipts = state.instanceLifecycleReceipts ?? [];
  const instanceIds = new Set((state.instances ?? []).map((instance) => instance.id));
  const retained = receipts.filter((receipt) => instanceIds.has(receipt.instanceId));
  if (retained.length === receipts.length) return false;
  const retiredInitialTaskIds = new Set(receipts
    .filter((receipt) => !instanceIds.has(receipt.instanceId))
    .flatMap((receipt) => (receipt.initialTaskId === undefined ? [] : [receipt.initialTaskId])));
  state.instanceLifecycleReceipts = retained;
  if (retiredInitialTaskIds.size > 0) {
    state.taskSubmissions = (state.taskSubmissions ?? []).filter((submission) =>
      submission.origin !== initialTaskOrigin || !submission.tasks.some((entry) => retiredInitialTaskIds.has(entry.taskId)));
  }
  return true;
}

/**
 * Retires delivery records the peer has settled. A provision is settled when its allocation reaches
 * `active` — the `instance.ready` acknowledgement — and either kind is settled once its allocation
 * is gone or no longer holds a slot, because nothing can act on the command any more. A release a
 * later release command for the same allocation supersedes is settled too: escalation is monotonic, so
 * the superseded mode can never be sent again. An unacknowledged, unsuperseded record is never retired
 * here, so replay stays possible; at most one provision and one live release command are held per
 * allocation, which bounds the outbox by the allocations the hub retains.
 *
 * Retiring a release whose allocation has gone `failed` discards no eviction. A failed allocation is
 * not an occupying one, so it is absent from the expected set of the node's next authoritative
 * snapshot; an identity that snapshot still reports is therefore written as a remote release request
 * and cancelled through that outbox instead — which is the correct addressing for a resident the hub
 * no longer owns an allocation for, and the same path a release-cleanup failure leaves behind.
 */
function retireSettledDeliveries(state: State): boolean {
  const records = state.instanceDeliveries ?? [];
  const allocationsById = new Map((state.allocations ?? []).map((allocation) => [allocation.id, allocation]));
  const runsById = new Map(state.runs.map((run) => [run.id, run]));
  const latestReleaseSequence = new Map<string, number>();
  for (const record of records) {
    if (record.kind !== "release") continue;
    latestReleaseSequence.set(record.allocationId, Math.max(latestReleaseSequence.get(record.allocationId) ?? 0, record.sequence));
  }
  const retained = records.filter((record) => {
    const allocation = allocationsById.get(record.allocationId);
    if (!allocation) return false;
    if (!occupyingAllocationStatuses.includes(allocation.status)) return false;
    if (record.kind === "release" && record.sequence < (latestReleaseSequence.get(record.allocationId) ?? 0)) return false;
    /*
     * A dispatch is settled once its run has left `queued`: Barista's own `run.started` — or any
     * terminal report — is proof it acted on the command, and a run that no longer exists has
     * nothing to replay. A still-queued dispatch is retained so a reconnect can re-arm it.
     */
    if (record.kind === "dispatch") {
      const run = record.message.type === "dispatch" ? runsById.get(record.message.run.id) : undefined;
      return run !== undefined && run.status === "queued";
    }
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
    ["instanceDeliveries", state.instanceDeliveries], ["remoteReleaseRequests", state.remoteReleaseRequests],
    ["nodeInstanceResidency", state.nodeInstanceResidency]
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
  const commandSequences = new Map<string, Set<number>>();
  for (const [index, record] of (state.instanceDeliveries ?? []).entries()) {
    const context = `Persisted instance delivery ${index}`;
    if (!isRecord(record) || !isNonEmptyString(record.allocationId) || !isNonEmptyString(record.nodeId) || !isNonEmptyString(record.createdAt)
      || (record.kind !== "provision" && record.kind !== "release" && record.kind !== "dispatch") || !isRecord(record.message)
      || !Number.isSafeInteger(record.sequence) || (record.sequence as number) < 1) {
      throw new Error(`${context} is malformed`);
    }
    /*
     * A sequence is a position in one allocation's command order, across every kind of command: the
     * delivery pass looks a record up by allocation and sequence alone, and the order decides which
     * release mode the peer ends up holding. Two records of an allocation sharing a position — a
     * provision and a release included — would make both that lookup and that order ambiguous, so
     * uniqueness is checked over all kinds rather than among releases alone.
     */
    const seen = commandSequences.get(record.allocationId) ?? new Set<number>();
    if (seen.has(record.sequence as number)) {
      throw new Error(`${context} repeats command sequence ${record.sequence} for allocation ${record.allocationId}`);
    }
    seen.add(record.sequence as number);
    commandSequences.set(record.allocationId, seen);
    if (!validateInstanceHubMessage(record.message as InstanceHubMessage, "5").ok) throw new Error(`${context} holds a command that is not wire-valid`);
    const expectedType = record.kind === "provision" ? "instance.provision" : record.kind === "dispatch" ? "dispatch" : "instance.release";
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
  const residencyByNode = new Map<string, ReadonlySet<string>>();
  for (const [index, record] of (state.nodeInstanceResidency ?? []).entries()) {
    const context = `Persisted node instance residency ${index}`;
    if (!isRecord(record) || !isNonEmptyString(record.nodeId) || !isNonEmptyString(record.observedAt) || !Array.isArray(record.instanceIds)
      || record.instanceIds.length > instanceLimits.collectionEntries || !record.instanceIds.every(isNonEmptyString)) {
      throw new Error(`${context} is malformed`);
    }
    if (new Set(record.instanceIds).size !== record.instanceIds.length) throw new Error(`${context} repeats a resident instance`);
    if (residencyByNode.has(record.nodeId)) throw new Error(`${context} repeats node ${record.nodeId}`);
    residencyByNode.set(record.nodeId, new Set(record.instanceIds as string[]));
  }
  const remoteRequestKeys = new Set<string>();
  for (const [index, request] of (state.remoteReleaseRequests ?? []).entries()) {
    const context = `Persisted remote release request ${index}`;
    if (!isRecord(request) || !isNonEmptyString(request.nodeId) || !isNonEmptyString(request.instanceId) || !isNonEmptyString(request.requestedAt)
      || !isOptionalNonEmptyString(request.deliveredAt)) {
      throw new Error(`${context} is malformed`);
    }
    const key = `${request.nodeId}\u0000${request.instanceId}`;
    if (remoteRequestKeys.has(key)) throw new Error(`${context} repeats its node and instance`);
    remoteRequestKeys.add(key);
    /*
     * The outbox carries commands, never occupancy, so it may not outlive the evidence that produced
     * it: a request survives exactly while its node's authoritative residency record still reports the
     * resident. A request naming a resident that record does not report would be a command with
     * nothing to act on, and — before residency was unified — was how a delivered release came to free
     * a slot that was still occupied. A missing record is not a weaker version of that mismatch but
     * the same failure with no evidence at all, so it is rejected rather than admitted: reconciliation
     * writes the node's residency record before it writes any request against that node, so a request
     * with no record behind it cannot have come from evidence.
     */
    const residency = residencyByNode.get(request.nodeId);
    if (residency === undefined) {
      throw new Error(`${context} has no residency record from node ${request.nodeId} to support it`);
    }
    if (!residency.has(request.instanceId)) {
      throw new Error(`${context} names a resident node ${request.nodeId} no longer reports`);
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
