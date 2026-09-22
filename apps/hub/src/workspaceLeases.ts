import { posix } from "node:path";
import {
  canTransitionWorkspaceLease,
  isActiveRunStatus,
  isTerminalWorkspaceLeaseStatus,
  isWorkspaceLeaseIdentity,
  normalizeRepositoryIdentity,
  workspaceLeaseBaseRef,
  workspaceLeaseBranch,
  workspaceLeaseGrant,
  workspaceLeaseWorktreePath,
  type Agent,
  type ComputeNode,
  type HubToControlAgent,
  type ProjectProfile,
  type Task,
  type WorkspaceCleanupMode,
  type WorkspaceIsolationPolicy,
  type WorkspaceLease,
  type WorkspaceLeaseStatus,
  type WorkspaceLeaseUpdate
} from "@coffee-shop/protocol";
import { isWorkspaceWithinRoot } from "./agentConfiguration.js";
import type { Redactor } from "./redaction.js";
import { newEvent, type State, type Store } from "./store.js";

/*
 * Hub-authoritative workspace leases.
 *
 * A lease is planned and persisted in the same transaction that creates its task attempt, before
 * any dispatch is written, and every value in it is derived from the project profile, the agent's
 * operator-configured checkout, the node's advertised roots, and hub-issued identities — never from
 * task text. Barista reports what actually exists; the hub accepts a report only as one canonical
 * transition of the lease it owns. A terminal run does not by itself prove anything about the
 * workspace, so the hub never infers `cleaned` or `failed`: it asks Barista to reconcile.
 */

/** Statuses in which the lease's run may still be dispatched with its grant. */
export const dispatchableWorkspaceLeaseStatuses: readonly WorkspaceLeaseStatus[] = ["requested", "provisioning", "active"];

/** Statuses the hub asks Barista to reconcile once the lease's run is no longer active. */
const reconcilableWorkspaceLeaseStatuses: readonly WorkspaceLeaseStatus[] = ["requested", "provisioning", "active", "released", "cleaning"];

export const leasedIsolation = (profile: ProjectProfile | undefined): WorkspaceIsolationPolicy | undefined =>
  profile?.workspacePolicy.isolation;

const isNormalizedAbsolutePath = (path: string) =>
  posix.isAbsolute(path) && posix.normalize(path) === path && (path === "/" || !path.endsWith("/"));

/** The most specific advertised root containing the checkout, so nested roots bind deterministically. */
export function leaseRoot(node: Pick<ComputeNode, "workspaceRoots">, sourcePath: string) {
  return [...node.workspaceRoots]
    .filter((root) => isNormalizedAbsolutePath(root) && isWorkspaceWithinRoot(sourcePath, root))
    .sort((left, right) => right.length - left.length || (left < right ? -1 : left > right ? 1 : 0))[0];
}

export type LeasePlanResult =
  | { ok: true; lease: WorkspaceLease }
  | { ok: false; requirement: string; detail: string };

export interface LeasePlanInput {
  task: Task;
  agent: Agent;
  node: Pick<ComputeNode, "id" | "workspaceRoots">;
  profile: ProjectProfile;
  runId: string;
  leaseId: string;
  at: string;
}

/**
 * Derives the complete lease for one task attempt, or explains why no lease can be granted. The
 * checkout is always the agent's configured workspace: a task may not redirect a leased attempt to
 * another path or repository.
 */
export function planWorkspaceLease(input: LeasePlanInput): LeasePlanResult {
  const { task, agent, node, profile, runId, leaseId, at } = input;
  const policy = leasedIsolation(profile);
  const unsatisfied = (requirement: string, detail: string): LeasePlanResult => ({ ok: false, requirement, detail });
  if (policy === undefined) return unsatisfied("workspace lease", "the project profile does not request workspace isolation");
  const sourcePath = agent.workspace;
  if (!isNormalizedAbsolutePath(sourcePath)) return unsatisfied("workspace lease", "the agent workspace is not a normalized absolute path");
  const requested = task.requirements.workspace;
  if (requested?.path !== undefined && requested.path !== sourcePath) {
    return unsatisfied("workspace lease", "a leased task runs from its agent's configured checkout and cannot name another path");
  }
  const root = leaseRoot(node, sourcePath);
  if (root === undefined) return unsatisfied("workspace lease", "the agent workspace is not beneath a root the compute node advertises");
  if (![task.id, runId, leaseId].every(isWorkspaceLeaseIdentity)) {
    return unsatisfied("workspace lease", "task, run, or lease identity cannot name a workspace");
  }
  const lease: WorkspaceLease = {
    id: leaseId,
    threadId: task.threadId,
    taskId: task.id,
    runId,
    nodeId: node.id,
    projectProfileId: profile.id,
    policy,
    cleanup: profile.workspacePolicy.cleanup ?? "retain",
    root,
    sourcePath,
    worktreePath: sourcePath,
    status: "requested",
    createdAt: at,
    updatedAt: at
  };
  if (policy === "exclusive-existing") return { ok: true, lease };
  const repository = profile.repository;
  if (repository === undefined) return unsatisfied("workspace lease", "git-worktree isolation requires a project repository");
  const identity = normalizeRepositoryIdentity(repository.url);
  if (requested?.repository !== undefined && normalizeRepositoryIdentity(requested.repository) !== identity) {
    return unsatisfied("workspace lease", "a leased task cannot name a repository other than its project's");
  }
  const worktreePath = workspaceLeaseWorktreePath(root, leaseId);
  if (isWorkspaceWithinRoot(sourcePath, posix.join(root, ".coffee-shop"))) {
    return unsatisfied("workspace lease", "the agent workspace overlaps the managed worktree directory");
  }
  return {
    ok: true,
    lease: {
      ...lease,
      repository: identity,
      baseRevision: workspaceLeaseBaseRef(repository.defaultBranch),
      branch: workspaceLeaseBranch(task.id, runId),
      worktreePath
    }
  };
}

/** Whether a lease still holds its workspace: anything but a settled tombstone does. */
export const holdsWorkspace = (lease: WorkspaceLease) => !isTerminalWorkspaceLeaseStatus(lease.status);

/**
 * The lease that already holds an exclusive-existing workspace on a node, if any. Two tasks
 * requesting the same exclusive workspace can therefore never both hold a lease.
 */
export function exclusiveWorkspaceHolder(leases: readonly WorkspaceLease[], nodeId: string, path: string) {
  return leases.find((lease) => lease.nodeId === nodeId && holdsWorkspace(lease) && lease.worktreePath === path);
}

/** A run's lease when it may still be dispatched with its grant. */
export function dispatchableLease(leases: readonly WorkspaceLease[], runId: string, leaseId: string | undefined) {
  if (leaseId === undefined) return undefined;
  const lease = leases.find((item) => item.id === leaseId);
  return lease && lease.runId === runId && dispatchableWorkspaceLeaseStatuses.includes(lease.status) ? lease : undefined;
}

export type LeaseUpdateResult =
  | { kind: "applied"; lease: WorkspaceLease }
  | { kind: "unchanged" }
  | { kind: "rejected"; reason: string };

/**
 * Applies one Barista report to the hub's lease. The report must come from the lease's node for
 * the lease's run and be exactly one canonical transition; an exact repeat is a no-op. A resolved
 * base revision, once recorded, can never change.
 */
export function applyWorkspaceLeaseUpdate(state: State, nodeId: string, runId: string, update: WorkspaceLeaseUpdate, at: string, redactor: Redactor): LeaseUpdateResult {
  const lease = state.workspaceLeases?.find((item) => item.id === update.leaseId);
  if (!lease) return { kind: "rejected", reason: "the lease does not exist" };
  if (lease.nodeId !== nodeId || lease.runId !== runId) return { kind: "rejected", reason: "the lease belongs to another node or run" };
  if (update.resolvedBaseRevision !== undefined) {
    if (lease.policy !== "git-worktree") return { kind: "rejected", reason: "only a worktree lease has a base revision" };
    if (lease.resolvedBaseRevision !== undefined && lease.resolvedBaseRevision !== update.resolvedBaseRevision) {
      return { kind: "rejected", reason: "the reported base revision conflicts with the recorded one" };
    }
  }
  if (update.status === lease.status) return { kind: "unchanged" };
  if (!canTransitionWorkspaceLease(lease.status, update.status)) {
    return { kind: "rejected", reason: `a ${lease.status} lease cannot become ${update.status}` };
  }
  if (update.status === "active" && lease.policy === "git-worktree" && (update.resolvedBaseRevision ?? lease.resolvedBaseRevision) === undefined) {
    return { kind: "rejected", reason: "an active worktree lease must report its resolved base revision" };
  }
  lease.status = update.status;
  if (update.resolvedBaseRevision !== undefined) lease.resolvedBaseRevision = update.resolvedBaseRevision;
  if (update.retentionReason !== undefined) lease.retentionReason = update.retentionReason;
  else delete lease.retentionReason;
  if (update.detail !== undefined) lease.detail = redactor.redact(update.detail);
  else delete lease.detail;
  lease.updatedAt = at;
  if (lease.status === "retained" || lease.status === "failed") {
    state.events.unshift(newEvent({
      type: "status",
      title: lease.status === "retained" ? "Workspace retained for attention" : "Workspace lease failed",
      detail: lease.status === "retained" ? `Lease ${lease.id} was retained: ${lease.retentionReason}` : `Lease ${lease.id} could not be provisioned`,
      threadId: lease.threadId,
      runId: lease.runId
    }));
  }
  return { kind: "applied", lease };
}

/**
 * Leases on a node whose run is no longer active but that Barista has not settled. They are asked
 * to reconcile after the node's reconnect barrier, once every replayed report has been applied.
 */
export function leasesAwaitingReconciliation(state: Readonly<State>, nodeId: string, activeRunIds: readonly string[] = []) {
  const active = new Set(activeRunIds);
  return (state.workspaceLeases ?? []).filter((lease) => {
    if (lease.nodeId !== nodeId || !reconcilableWorkspaceLeaseStatuses.includes(lease.status) || active.has(lease.runId)) return false;
    const run = state.runs.find((item) => item.id === lease.runId);
    return !run || !isActiveRunStatus(run.status);
  });
}

/**
 * The confirmation that lets Barista start a leased run's harness. It is issued only from committed
 * state, for the lease's own node and run, while the lease is `active` and its run still active, so
 * a harness can never start on a lease the hub has not persisted or on a run it already ended.
 */
export function workspaceLeaseConfirmation(state: Readonly<State>, nodeId: string, runId: string, leaseId: string): Extract<HubToControlAgent, { type: "workspace.lease.confirmed" }> | undefined {
  const lease = state.workspaceLeases?.find((item) => item.id === leaseId);
  if (!lease || lease.nodeId !== nodeId || lease.runId !== runId || lease.status !== "active") return undefined;
  const run = state.runs.find((item) => item.id === runId);
  if (!run || run.nodeId !== nodeId || !isActiveRunStatus(run.status)) return undefined;
  return { type: "workspace.lease.confirmed", runId, leaseId, status: "active" };
}

export function workspaceCleanupMessage(lease: WorkspaceLease, mode: WorkspaceCleanupMode): Extract<HubToControlAgent, { type: "workspace.cleanup" }> {
  return { type: "workspace.cleanup", runId: lease.runId, lease: workspaceLeaseGrant(lease), mode };
}

export type OperatorCleanupResult =
  | { kind: "requested"; lease: WorkspaceLease }
  | { kind: "not-found" }
  | { kind: "conflict"; reason: string };

/**
 * Records an operator's request to clean up a retained lease. Only the request is recorded: the
 * lease stays `retained` until Barista itself reports `cleaning`, and Barista re-verifies that
 * nothing would be lost before removing anything.
 */
export function requestOperatorCleanup(state: State, leaseId: string, at: string): OperatorCleanupResult {
  const lease = state.workspaceLeases?.find((item) => item.id === leaseId);
  if (!lease) return { kind: "not-found" };
  if (lease.status !== "retained") return { kind: "conflict", reason: "Only a retained workspace lease can be cleaned up by an operator" };
  const run = state.runs.find((item) => item.id === lease.runId);
  if (run && isActiveRunStatus(run.status)) return { kind: "conflict", reason: "The lease's run is still active" };
  lease.cleanupRequestedAt = at;
  lease.updatedAt = at;
  return { kind: "requested", lease };
}

export type LeaseSender = (nodeId: string, message: HubToControlAgent) => boolean;

/** Persists one validated Barista report; a rejected report changes nothing. */
export async function receiveWorkspaceLeaseUpdate(store: Store, nodeId: string, runId: string, update: WorkspaceLeaseUpdate, redactor: Redactor, at = new Date().toISOString()) {
  let result: LeaseUpdateResult = { kind: "rejected", reason: "the report was not processed" };
  await store.transact((state) => {
    result = applyWorkspaceLeaseUpdate(state, nodeId, runId, update, at, redactor);
    return result.kind === "applied";
  });
  return result as LeaseUpdateResult;
}

/**
 * Asks Barista to reconcile every unsettled lease on a node whose run is no longer active. Nothing
 * is recorded: the lease changes only when Barista reports what it found.
 */
export function reconcileWorkspaceLeases(store: Store, nodeId: string, activeRunIds: readonly string[], send: LeaseSender) {
  const messages = store.read((state) => leasesAwaitingReconciliation(state, nodeId, activeRunIds).map((lease) => structuredClone(workspaceCleanupMessage(lease, "reconcile"))));
  return messages.filter((message) => send(nodeId, message)).length;
}

/** Records and sends an operator cleanup request; `sent` is false when the node could not receive it. */
export async function cleanupWorkspaceLeaseByOperator(store: Store, leaseId: string, send: LeaseSender, at = new Date().toISOString()) {
  let result: OperatorCleanupResult = { kind: "not-found" };
  await store.transact((state) => {
    result = requestOperatorCleanup(state, leaseId, at);
    return result.kind === "requested";
  });
  const outcome = result as OperatorCleanupResult;
  if (outcome.kind !== "requested") return { ...outcome, sent: false };
  const lease = structuredClone(outcome.lease);
  return { ...outcome, lease, sent: send(lease.nodeId, workspaceCleanupMessage(lease, "operator")) };
}
