import {
  isActiveRunStatus,
  isHarnessTransport,
  isTerminalTaskStatus,
  resolveNodeCapability,
  satisfiesMinimumQuantity,
  supportsControlCapability,
  validateInstanceHubMessage,
  workspaceLeaseGrant,
  type Agent,
  type AgentInstance,
  type AgentTemplate,
  type ComputeNode,
  type ControlProtocolVersion,
  type DispatchExecution,
  type ExecutionRequirements,
  type HarnessId,
  type HarnessProfile,
  type HarnessTransport,
  type HubToControlAgent,
  type InstanceAllocation,
  type InstanceRun,
  type NodeCapabilityReport,
  type PlacementDiagnostic,
  type PlacementOverride,
  type PlacementRequirementKind,
  type ProjectProfile,
  type ProjectReadiness,
  type ResolvedNodeCapability,
  type Run,
  type Task,
  type UnsatisfiedRequirement,
  type WorkspaceLease
} from "@coffee-shop/protocol";
import { isWorkspaceWithinRoot } from "./agentConfiguration.js";
import {
  acceptInstanceWorkInState,
  appendInstanceDispatchInState,
  convergeInstanceActivityInState,
  nodeResidencyInState,
  nonTerminalInstanceStatuses,
  occupyingAllocationStatuses,
  placeInstanceInState,
  releaseUnneededInstanceInState,
  reserveInstanceAllocationInState,
  residentInstanceUsage,
  terminalInstanceStatuses,
  type AllocationCandidate,
  type InstancePlacementResult,
  type ResidentInstanceUsage
} from "./instances.js";
import { computeNodeProjectReadiness, defaultEvidenceTTLMilliseconds } from "./projectReadiness.js";
import { sessionDispatchFor, type SessionDispatchSource } from "./sessionBindings.js";
import { newEvent, newId, type State } from "./store.js";
import { assignTaskAttempt, readyTasks, taskReadiness } from "./tasks.js";
import { dispatchableLease, exclusiveWorkspaceHolder, leasedIsolation, planWorkspaceLease } from "./workspaceLeases.js";

/*
 * Task placement.
 *
 * The candidate set is the live execution offerings of the fleet: one offering per connected,
 * replay-synchronized, protocol-v5 node × available harness × advertised model × advertised
 * transport, admitted against fresh capability evidence, the project profile, workspace
 * authorization, run concurrency, and resident-instance capacity. An offering needs no configured
 * agent and no configured template: a task may ask for Claude/Fable/macOS and be placed on whatever
 * node currently offers it.
 *
 * Hard machine facts stay hard. Operating system, architecture, labels and toolchains, memory,
 * harness, model, transport, project profile, and workspace are offering constraints that a
 * preference can never override. Role defaults — skills, instructions, avatars — live in
 * `AgentTemplate`, which is discovery metadata: a task naming a template may be placed only through
 * that template, and a task naming none needs no template at all.
 *
 * A placed task gets a thread-scoped resident instance, not a node binding. A compatible ready or
 * idle instance in the same thread is reused; otherwise one is requested and its best eligible
 * offering reserved through #75, in the same transaction that records the task's placement intent,
 * so two concurrent passes can neither duplicate an instance nor overbook resident capacity. No run
 * exists until `instance.ready` arrives: provisioning is a visible scheduling wait.
 *
 * Preferences never exclude an offering; they only rank the offerings that already satisfy every
 * hard requirement. The ranking, compared in order, is:
 *
 *   1. position of the node in `preferences.nodeIds` (unlisted nodes rank after every listed one);
 *   2. position of the harness in `preferences.harnessIds`;
 *   3. position of the model in `preferences.models`;
 *   4. number of `preferences.labels` the node does not report (fewer first);
 *   5. number of unmet project-profile preferences (fewer first);
 *   6. position of the transport in `transportPreference`;
 *   7. run utilization, reserved run slots divided by concurrency (lower first);
 *   8. resident utilization, held resident slots divided by instance capacity (lower first);
 *   9. node ID, then harness ID, then model, then transport, by code-unit order.
 *
 * Nothing depends on input array order, timestamps, or randomness, so the same inventory always
 * yields the same placement.
 *
 * Configured agents remain a candidate set of last resort, used only for a task no offering can
 * serve — notably a task whose project profile demands an isolated workspace lease, because a v5
 * instance dispatch carries no lease grant for Barista to honor. That path, and the legacy
 * `agentId` placement override that reaches it, are the compatibility surface #78 removes when run,
 * thread, session, and mailbox authority migrate off agents; everything else here is offering-first.
 */

/** Hub-observed state of a node's current control socket. */
export interface NodeConnection {
  protocolVersion: ControlProtocolVersion;
  /** Whether the socket has completed its reconnect barrier (`sync.complete`). */
  synced: boolean;
}

export interface PlacementEnvironment {
  /** Compatibility-only candidate set; see the module comment. */
  agents: readonly Agent[];
  nodes: readonly ComputeNode[];
  runs: readonly Run[];
  connection(nodeId: string): NodeConnection | undefined;
  capabilityReport(nodeId: string): NodeCapabilityReport | undefined;
  projectProfile(projectId: string): ProjectProfile | undefined;
  workspaceLeases?: readonly WorkspaceLease[];
  /** Thread-scoped resident instances; the reuse and pin candidates. */
  instances?: readonly AgentInstance[];
  allocations?: readonly InstanceAllocation[];
  /** Reusable role defaults; the only source of skill evidence. */
  templates?: readonly AgentTemplate[];
  /** Each node's own latest resident report, so resident capacity is read from node evidence. */
  residentUsage?(node: ComputeNode): ResidentInstanceUsage;
  now: string;
  evidenceTTLMilliseconds?: number;
}

/**
 * One live execution offering: a node's available harness, one model it advertises, one transport it
 * advertises for that harness, and the workspace an allocation on it would own. An offering is
 * derived wholly from node-reported inventory; nothing about it comes from a configured agent.
 */
export interface ExecutionOffering {
  nodeId: string;
  harnessId: HarnessId;
  model: string;
  transport: HarnessTransport;
  /** `native-cli` when this `acp-v1` offering may fall back to the native CLI before its prompt. */
  fallbackTransport?: HarnessTransport;
  /** Canonical absolute path; Barista re-validates it against its own WORKSPACE_ROOTS. */
  workspace: string;
}

export interface PlacementCandidate {
  agentId: string;
  nodeId: string;
  harnessId: HarnessId;
  model: string;
  transport: HarnessTransport;
  /** `native-cli` when an `acp-v1` placement may fall back to the native CLI before its prompt. */
  fallbackTransport?: HarnessTransport;
  workspace: string;
}

/**
 * The models a harness offers. An empty advertised list means the harness exposes only its
 * provider default, which is offered under the reserved name `default`; a harness that advertises
 * models offers exactly those and never a provider default it did not name.
 */
export const offeredModels = (harness: HarnessProfile): readonly string[] =>
  harness.models.length ? [...harness.models].sort(compareText) : ["default"];

/**
 * The workspace an allocation on this node would own: the path the task asked for when it named
 * one, otherwise the node's least advertised root by code-unit order, so the same inventory always
 * produces the same workspace. The reservation re-checks the result against the node's roots.
 */
export const offeredWorkspace = (node: ComputeNode, requestedPath: string | undefined): string | undefined => {
  const roots = [...node.workspaceRoots].sort(compareText);
  if (requestedPath === undefined) return roots[0];
  return roots.some((root) => isWorkspaceWithinRoot(requestedPath, root)) ? requestedPath : undefined;
};

/**
 * Every offering one node currently publishes, in the stable order node × harness × model ×
 * transport. Only an available harness is offered, and only the transports it actually advertises:
 * a transport the node did not name is never substituted.
 */
export function nodeOfferings(node: ComputeNode, requestedPath?: string): ExecutionOffering[] {
  const workspace = offeredWorkspace(node, requestedPath);
  if (workspace === undefined) return [];
  const offerings: ExecutionOffering[] = [];
  for (const harness of [...node.harnesses].sort((left, right) => compareText(left.id, right.id))) {
    if (harness.available !== true) continue;
    const transports = [...new Set((harness.transports ?? ["native-cli"]).filter(isHarnessTransport))];
    for (const model of offeredModels(harness)) {
      for (const transport of transportPreference.filter((item) => transports.includes(item))) {
        offerings.push({
          nodeId: node.id,
          harnessId: harness.id,
          model,
          transport,
          ...(transport === "acp-v1" && transports.includes("native-cli") ? { fallbackTransport: "native-cli" as const } : {}),
          workspace
        });
      }
    }
  }
  return offerings;
}

/**
 * Transport preference among those a harness advertises and the requirements accept. Barista
 * advertises `acp-v1` only for a harness whose verified adapter passed its startup probe, so ACP is
 * preferred exactly when it is installed, verified, and capable; the native CLI remains the
 * alternative, and the only possible fallback.
 */
export const transportPreference: readonly HarnessTransport[] = ["acp-v1", "native-cli"];

export type PlacementDecision =
  /** Dispatch now on the named resident instance: a reuse, a pin, or an allocation that became ready. */
  | { kind: "instance"; instanceId: string; diagnostic: PlacementDiagnostic }
  /**
   * Reserve this offering. `instanceId` names an instance that already exists and lost its
   * allocation, whose identity, requirements, and lease survive the loss (#73); otherwise a new
   * instance is requested with the reservation. Either way no run exists until the allocation is ready.
   */
  | { kind: "offering"; offering: ExecutionOffering; instanceId?: string; diagnostic: PlacementDiagnostic }
  /** An instance this task already owns is still provisioning; the task waits and is not re-offered. */
  | { kind: "waiting"; instanceId: string; diagnostic: PlacementDiagnostic }
  /** Compatibility-only: a configured agent, for a task no offering can serve. */
  | { kind: "assigned"; candidate: PlacementCandidate; diagnostic: PlacementDiagnostic }
  | { kind: "unsatisfied"; diagnostic: PlacementDiagnostic };

export const placementDiagnosticLimit = 200;

/** Stands in for the not-yet-issued run and lease identities when checking that a lease can be planned. */
const placementProbeIdentity = "placement";

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

const evidenceDetails: Readonly<Record<Exclude<ResolvedNodeCapability["state"], "ok">, string>> = {
  missing: "no worker-reported evidence",
  failed: "worker-reported evidence failed",
  stale: "worker-reported evidence is stale",
  ambiguous: "worker-reported evidence is ambiguous"
};

export interface NodeUsage {
  concurrency: number;
  /** Slots held by persisted active attempts or reported by the node's latest heartbeat, whichever is larger. */
  used: number;
}

/**
 * Persisted queued and running runs reserve a slot as soon as they are written, so two scheduling
 * passes cannot overbook a node before its next heartbeat. A malformed worker-reported concurrency
 * counts as zero slots and a malformed active-run count as a full node.
 */
export function nodeUsage(node: ComputeNode, runs: readonly Run[]): NodeUsage {
  const concurrency = Number.isSafeInteger(node.concurrency) && node.concurrency > 0 ? node.concurrency : 0;
  const reported = Number.isSafeInteger(node.activeRuns) && node.activeRuns >= 0 ? node.activeRuns : concurrency;
  const reserved = runs.filter((run) => run.nodeId === node.id && isActiveRunStatus(run.status)).length;
  return { concurrency, used: Math.max(reserved, reported) };
}

/**
 * Whether a persisted placement override is one the scheduler may act on. An `instanceId` pin and a
 * legacy `agentId` pin are mutually exclusive: the two name different candidate sets, so an override
 * carrying both is malformed rather than resolved in favor of either. A malformed or unauthorized
 * override is never treated as absent — `placeTask` refuses the task instead of placing it freely.
 */
export function isAuthorizedPlacementOverride(value: unknown): value is PlacementOverride {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const override = value as Record<string, unknown>;
  if (!Object.keys(override).every((key) => key === "instanceId" || key === "agentId" || key === "nodeId" || key === "authorizedBy")) return false;
  if (override.authorizedBy !== "operator" && override.authorizedBy !== "policy") return false;
  const optionalIdentity = (entry: unknown) => entry === undefined || (typeof entry === "string" && entry.length > 0);
  if (!["instanceId", "agentId", "nodeId"].every((key) => optionalIdentity(override[key]))) return false;
  if (override.instanceId !== undefined && override.agentId !== undefined) return false;
  return override.instanceId !== undefined || override.agentId !== undefined || override.nodeId !== undefined;
}

function repositoryAuthorized(profile: ProjectProfile | undefined, repository: string) {
  if (!profile) return false;
  if (profile.workspacePolicy.allowedRepositories !== undefined) return profile.workspacePolicy.allowedRepositories.includes(repository);
  return profile.repository?.url === repository;
}

type RequirementReporter = (kind: PlacementRequirementKind, requirement: string, detail: string) => void;

interface NodeEvidence {
  resolve(capabilityId: string): ResolvedNodeCapability;
  readiness?: ProjectReadiness;
}

/**
 * The hard machine requirements a node either proves or does not: operating system, architecture,
 * labels, configured memory, a writable workspace, and the project profile's own hard requirements.
 * Every one is decided from fresh worker-reported evidence, and evidence that is missing, failed,
 * ambiguous, or stale is a specific diagnostic rather than a pass. Shared by the offering evaluator
 * and the compatibility agent evaluator so the two can never drift apart.
 */
function evaluateNodeEvidence(
  task: Task,
  node: ComputeNode,
  profile: ProjectProfile | undefined,
  environment: PlacementEnvironment,
  add: RequirementReporter
): NodeEvidence {
  const requirements = task.requirements;
  const evidenceTTLMilliseconds = environment.evidenceTTLMilliseconds ?? defaultEvidenceTTLMilliseconds;
  const evidence = environment.capabilityReport(node.id)?.evidence ?? [];
  const resolve = (capabilityId: string) => resolveNodeCapability(evidence, capabilityId, environment.now, evidenceTTLMilliseconds);
  const evidenceFailure = (kind: PlacementRequirementKind, requirement: string, resolved: ResolvedNodeCapability, mismatch: string) => {
    if (resolved.state === "ok") add(kind, requirement, mismatch);
    else add(resolved.state === "stale" ? "inventory-stale" : kind, requirement, evidenceDetails[resolved.state]);
  };
  for (const [kind, capabilityId, accepted] of [
    ["operating-system", "os", requirements.operatingSystems],
    ["architecture", "architecture", requirements.architectures]
  ] as const) {
    if (accepted === undefined) continue;
    const resolved = resolve(capabilityId);
    const reported = (resolved.value ?? "").toLowerCase();
    if (resolved.state !== "ok" || !accepted.some((value) => value.toLowerCase() === reported)) {
      evidenceFailure(kind, accepted.join(", "), resolved, "worker-reported value does not match");
    }
  }
  for (const label of requirements.labels ?? []) {
    const resolved = resolve(`label:${label.toLowerCase()}`);
    if (resolved.state !== "ok") evidenceFailure("label", label, resolved, "");
  }
  if (requirements.minimumMemoryMegabytes !== undefined) {
    const resolved = resolve("configured-memory-megabytes");
    if (resolved.state !== "ok" || !satisfiesMinimumQuantity(resolved.value ?? "", requirements.minimumMemoryMegabytes)) {
      evidenceFailure("memory", `${requirements.minimumMemoryMegabytes} MiB`, resolved, "configured memory is below the minimum");
    }
  }
  if (requirements.workspace?.writable) {
    const resolved = resolve("workspace-writable");
    if (resolved.state !== "ok") evidenceFailure("workspace", "writable workspace", resolved, "");
  }
  let readiness: ProjectReadiness | undefined;
  if (profile) {
    readiness = computeNodeProjectReadiness(node, environment.capabilityReport(node.id), profile, environment.now, evidenceTTLMilliseconds);
    for (const unmet of readiness.unmetHardRequirements) add("project-profile", `${unmet.kind} ${unmet.requirement}`, unmet.detail);
  }
  return { resolve, readiness };
}

interface CandidateEvaluation {
  unsatisfied: UnsatisfiedRequirement[];
  candidate?: PlacementCandidate;
  ranks?: number[];
  usage?: NodeUsage;
}

const rankOf = (preferred: readonly string[] | undefined, value: string) => {
  if (!preferred?.length) return 0;
  const index = preferred.indexOf(value);
  return index < 0 ? preferred.length : index;
};

function evaluateCandidate(task: Task, agent: Agent, profile: ProjectProfile | undefined, environment: PlacementEnvironment): CandidateEvaluation {
  const requirements = task.requirements;
  const unsatisfied: UnsatisfiedRequirement[] = [];
  const add = (kind: PlacementRequirementKind, requirement: string, detail: string) => {
    unsatisfied.push({ kind, requirement, nodeId: agent.computeNodeId, agentId: agent.id, detail });
  };

  const skills = new Set(agent.skills ?? []);
  for (const skill of requirements.skills ?? []) {
    if (!skills.has(skill.toLowerCase())) add("skill", skill, "agent does not declare this skill");
  }
  if (requirements.harnessIds !== undefined && !requirements.harnessIds.includes(agent.harnessId)) {
    add("harness", requirements.harnessIds.join(", "), "agent is configured with a different harness");
  }
  const profileHard = profile?.requirements.hard;
  if (profileHard?.harnessIds !== undefined && !profileHard.harnessIds.includes(agent.harnessId)) {
    add("project-profile", `harness ${profileHard.harnessIds.join(", ")}`, "agent is configured with a harness the project profile does not allow");
  }
  if (requirements.models !== undefined && !requirements.models.includes(agent.model)) {
    add("model", requirements.models.join(", "), "agent is configured with a different model");
  }

  const node = environment.nodes.find((item) => item.id === agent.computeNodeId);
  if (!node) {
    add("node-offline", agent.computeNodeId, "compute node has never registered");
    return { unsatisfied };
  }

  const connection = environment.connection(node.id);
  if (!connection) {
    add("node-offline", node.id, "compute node is not connected");
  } else {
    if (!supportsControlCapability(connection.protocolVersion, "orchestration")) {
      add("protocol-version", "control protocol version 4", "compute node registered a protocol version without task orchestration");
    }
    if (!connection.synced) add("node-offline", node.id, "compute node has not completed reconnect synchronization");
  }

  const harness = node.harnesses.find((item) => item.id === agent.harnessId);
  const harnessAvailable = harness?.available === true;
  if (!harnessAvailable) add("harness", agent.harnessId, "harness is not reported available on the compute node");
  if (harnessAvailable && !(harness.models.length ? harness.models.includes(agent.model) : agent.model === "default")) {
    add("model", agent.model, "the compute node's harness no longer advertises the agent's model");
  }
  const advertisedTransports = harnessAvailable ? (harness.transports ?? ["native-cli"]).filter(isHarnessTransport) : [];
  const acceptable = (item: HarnessTransport) => advertisedTransports.includes(item)
    && (requirements.transports === undefined || requirements.transports.includes(item))
    && (profileHard?.transports === undefined || profileHard.transports.includes(item));
  const transport = transportPreference.find(acceptable);
  const fallbackTransport = transport === "acp-v1" && acceptable("native-cli") ? "native-cli" as const : undefined;
  if (harnessAvailable && transport === undefined) {
    add("transport", (requirements.transports ?? profileHard?.transports ?? ["native-cli"]).join(", "), "no transport the harness reports satisfies the requirement");
  }

  const { resolve, readiness } = evaluateNodeEvidence(task, node, profile, environment, add);
  const evidenceFailure = (kind: PlacementRequirementKind, requirement: string, resolved: ResolvedNodeCapability, mismatch: string) => {
    if (resolved.state === "ok") add(kind, requirement, mismatch);
    else add(resolved.state === "stale" ? "inventory-stale" : kind, requirement, evidenceDetails[resolved.state]);
  };

  const usage = nodeUsage(node, environment.runs);
  if (requirements.minimumConcurrency !== undefined && usage.concurrency < requirements.minimumConcurrency) {
    add("concurrency", String(requirements.minimumConcurrency), "compute node reports lower concurrency");
  }

  const agentWorkspaceAuthorized = node.workspaceRoots.some((root) => isWorkspaceWithinRoot(agent.workspace, root));
  if (!agentWorkspaceAuthorized) add("workspace", "workspace beneath an advertised root", "agent workspace is not beneath a root the compute node advertises");
  const requestedPath = requirements.workspace?.path;
  if (requestedPath !== undefined && !(isWorkspaceWithinRoot(requestedPath, agent.workspace)
    && node.workspaceRoots.some((root) => isWorkspaceWithinRoot(requestedPath, root)))) {
    add("workspace", requestedPath, "requested path is not beneath the agent workspace and an advertised root");
  }
  const leases = environment.workspaceLeases ?? [];
  const isolation = leasedIsolation(profile);
  if (profile && isolation !== undefined) {
    const resolved = resolve(`workspace-lease:${isolation}`);
    if (resolved.state !== "ok") evidenceFailure("workspace", `${isolation} workspace lease`, resolved, "");
    const plan = planWorkspaceLease({ task, agent, node, profile, runId: placementProbeIdentity, leaseId: placementProbeIdentity, at: environment.now });
    if (!plan.ok) add("workspace", plan.requirement, plan.detail);
    else if (isolation === "exclusive-existing" && exclusiveWorkspaceHolder(leases, node.id, plan.lease.worktreePath)) {
      add("capacity", "exclusive workspace", "another workspace lease holds this workspace");
    }
  }

  if (usage.used >= usage.concurrency) add("capacity", `${usage.concurrency} slots`, `${usage.used} slots are reserved or reported active`);
  const sharesAgentWorkspace = (run: Run) => leases.find((lease) => lease.id === run.workspaceLeaseId)?.policy !== "git-worktree";
  if (isolation !== "git-worktree" && environment.runs.some((run) => run.agentId === agent.id && run.taskId !== undefined
    && isActiveRunStatus(run.status) && sharesAgentWorkspace(run))) {
    add("capacity", "idle agent", "agent already has an active task attempt in its workspace");
  }

  if (unsatisfied.length || transport === undefined) return { unsatisfied };
  const preferences = requirements.preferences;
  const missingPreferredLabels = (preferences?.labels ?? []).filter((label) => resolve(`label:${label.toLowerCase()}`).state !== "ok").length;
  return {
    unsatisfied,
    candidate: {
      agentId: agent.id, nodeId: node.id, harnessId: agent.harnessId, model: agent.model, transport,
      ...(fallbackTransport ? { fallbackTransport } : {}),
      workspace: requestedPath ?? agent.workspace
    },
    ranks: [
      rankOf(preferences?.nodeIds, node.id),
      rankOf(preferences?.harnessIds, agent.harnessId),
      rankOf(preferences?.models, agent.model),
      missingPreferredLabels,
      readiness?.unmetPreferences.length ?? 0
    ],
    usage
  };
}

/**
 * Requirement kinds decided by agent configuration and the node's registered inventory rather
 * than by momentary node state such as connectivity, capacity, or evidence freshness.
 */
export const staticPlacementRequirementKinds: readonly PlacementRequirementKind[] = ["skill", "harness", "model", "transport", "workspace"];

/**
 * The hard requirements `agent` can never satisfy for `task` until its configuration or its
 * node's registered harnesses change, from the same evaluation placement uses. Connectivity,
 * capacity, and capability evidence are transient and are never reported here.
 */
export function staticPlacementFailures(task: Task, agent: Agent, environment: PlacementEnvironment): UnsatisfiedRequirement[] {
  return evaluateCandidate(task, agent, undefined, environment).unsatisfied.filter((entry) => staticPlacementRequirementKinds.includes(entry.kind));
}

/* ---------------------------------------------------------------------------------------------
 * Offerings: the live candidate set.
 * ------------------------------------------------------------------------------------------- */

interface OfferingEvaluation {
  unsatisfied: UnsatisfiedRequirement[];
  offering?: ExecutionOffering;
  ranks?: number[];
  usage?: NodeUsage;
  resident?: ResidentInstanceUsage;
}

/** Whether an allocation status still holds its instance's resident slot. */
const occupyingAllocation = (status: InstanceAllocation["status"]) => occupyingAllocationStatuses.includes(status);

const residentUsageFor = (environment: PlacementEnvironment, node: ComputeNode): ResidentInstanceUsage =>
  environment.residentUsage?.(node) ?? residentInstanceUsage(node, environment.allocations ?? []);

/**
 * Whether a node publishes offerings at all. The claim is the node's own: `instanceCapacity` is a
 * version-5 field a node sets only when it supervises residents, so a version-4 node is not an
 * offering source and is never reported as a failed one. A node that declares the field but not a
 * usable positive capacity is a source, so its declaration produces a capacity diagnostic rather
 * than silently disappearing.
 */
export const offersInstances = (node: ComputeNode) => node.instanceCapacity !== undefined;

/** `true` when this task's workload can never run on a resident instance, with the reason. */
function residentExclusion(profile: ProjectProfile | undefined): string | undefined {
  const isolation = leasedIsolation(profile);
  if (isolation === undefined) return undefined;
  return `a ${isolation} workspace lease cannot be granted to a resident instance: a version-5 dispatch carries no lease grant`;
}

/**
 * Every hard requirement of `task` against one offering. Machine facts are proved from the node's
 * own fresh evidence; the harness, model, and transport are compared against what the offering
 * actually publishes, never against a provider default the node did not name. Preferences are read
 * only after every hard requirement has matched.
 */
function evaluateOffering(
  task: Task,
  offering: ExecutionOffering,
  node: ComputeNode,
  profile: ProjectProfile | undefined,
  environment: PlacementEnvironment
): OfferingEvaluation {
  const requirements = task.requirements;
  const unsatisfied: UnsatisfiedRequirement[] = [];
  const add = (kind: PlacementRequirementKind, requirement: string, detail: string) => {
    unsatisfied.push({ kind, requirement, nodeId: node.id, detail });
  };
  const connection = environment.connection(node.id);
  if (!connection) {
    add("node-offline", node.id, "compute node is not connected");
  } else {
    if (!supportsControlCapability(connection.protocolVersion, "instances")) {
      add("protocol-version", "control protocol version 5", "compute node registered a protocol version without ephemeral instances");
    }
    if (!connection.synced) add("node-offline", node.id, "compute node has not completed reconnect synchronization");
  }
  if (node.status !== "online" && node.status !== "busy") add("node-offline", node.id, `compute node is ${node.status}`);
  const profileHard = profile?.requirements.hard;
  if (requirements.harnessIds !== undefined && !requirements.harnessIds.includes(offering.harnessId)) {
    add("harness", requirements.harnessIds.join(", "), "the offering publishes a different harness");
  }
  if (profileHard?.harnessIds !== undefined && !profileHard.harnessIds.includes(offering.harnessId)) {
    add("project-profile", `harness ${profileHard.harnessIds.join(", ")}`, "the project profile does not allow the offering's harness");
  }
  if (requirements.models !== undefined && !requirements.models.includes(offering.model)) {
    add("model", requirements.models.join(", "), "the offering publishes a different model");
  }
  if (requirements.transports !== undefined && !requirements.transports.includes(offering.transport)) {
    add("transport", requirements.transports.join(", "), "the offering publishes a different transport");
  }
  if (profileHard?.transports !== undefined && !profileHard.transports.includes(offering.transport)) {
    add("project-profile", `transport ${profileHard.transports.join(", ")}`, "the project profile does not allow the offering's transport");
  }
  const { resolve, readiness } = evaluateNodeEvidence(task, node, profile, environment, add);
  const usage = nodeUsage(node, environment.runs);
  if (requirements.minimumConcurrency !== undefined && usage.concurrency < requirements.minimumConcurrency) {
    add("concurrency", String(requirements.minimumConcurrency), "compute node reports lower concurrency");
  }
  if (usage.used >= usage.concurrency) add("capacity", `${usage.concurrency} run slots`, `${usage.used} run slots are reserved or reported active`);
  const resident = residentUsageFor(environment, node);
  if (resident.capacity === 0) add("resident-capacity", "resident instance capacity", "compute node advertises no usable resident instance capacity");
  else if (resident.used >= resident.capacity) {
    add("resident-capacity", `${resident.capacity} resident slots`, `${resident.used} resident slots are held or reported resident`);
  }
  if (!node.workspaceRoots.some((root) => isWorkspaceWithinRoot(offering.workspace, root))) {
    add("workspace", "workspace beneath an advertised root", "the offering workspace is not beneath a root the compute node advertises");
  }
  const requestedPath = requirements.workspace?.path;
  if (requestedPath !== undefined && offering.workspace !== requestedPath) {
    add("workspace", requestedPath, "requested path is not beneath a root the compute node advertises");
  }
  const excluded = residentExclusion(profile);
  if (excluded !== undefined) add("workspace", `${leasedIsolation(profile)} workspace lease`, excluded);
  if (unsatisfied.length) return { unsatisfied };
  const preferences = requirements.preferences;
  const missingPreferredLabels = (preferences?.labels ?? []).filter((label) => resolve(`label:${label.toLowerCase()}`).state !== "ok").length;
  return {
    unsatisfied,
    offering,
    usage,
    resident,
    ranks: [
      rankOf(preferences?.nodeIds, node.id),
      rankOf(preferences?.harnessIds, offering.harnessId),
      rankOf(preferences?.models, offering.model),
      missingPreferredLabels,
      readiness?.unmetPreferences.length ?? 0,
      transportPreference.indexOf(offering.transport)
    ]
  };
}

/** The documented total order over eligible offerings; see the module comment. */
function compareOfferings(left: OfferingEvaluation, right: OfferingEvaluation) {
  const leftRanks = left.ranks!;
  const rightRanks = right.ranks!;
  for (let index = 0; index < leftRanks.length; index += 1) {
    if (leftRanks[index] !== rightRanks[index]) return leftRanks[index] - rightRanks[index];
  }
  const runs = left.usage!.used * right.usage!.concurrency - right.usage!.used * left.usage!.concurrency;
  if (runs !== 0) return runs;
  const residents = left.resident!.used * right.resident!.capacity - right.resident!.used * left.resident!.capacity;
  if (residents !== 0) return residents;
  return compareText(left.offering!.nodeId, right.offering!.nodeId)
    || compareText(left.offering!.harnessId, right.offering!.harnessId)
    || compareText(left.offering!.model, right.offering!.model)
    || compareText(left.offering!.transport, right.offering!.transport);
}

/* ---------------------------------------------------------------------------------------------
 * Templates: reusable role defaults, never asserted machine evidence.
 * ------------------------------------------------------------------------------------------- */

export type TemplateResolution =
  | { kind: "none" }
  | { kind: "template"; template: AgentTemplate }
  | { kind: "unsatisfied"; unsatisfied: UnsatisfiedRequirement };

const templateSkills = (template: AgentTemplate) => new Set((template.skills ?? []).map((skill) => skill.toLowerCase()));

/**
 * The template a task must be placed through, if any. A task naming `templateId` may use only that
 * template, and only when it declares every skill the task requires. A task that requires skills
 * without naming a template is placed through the least-identified template that declares them all,
 * which is the deterministic migration of a legacy skill requirement; a task that names neither
 * needs no configured template. There is never an arbitrary candidate: a skill or template
 * requirement nothing satisfies is an explicit diagnostic.
 */
export function resolveTaskTemplate(task: Task, templates: readonly AgentTemplate[]): TemplateResolution {
  const required = (task.requirements.skills ?? []).map((skill) => skill.toLowerCase());
  const named = task.requirements.templateId;
  const ordered = [...templates].sort((left, right) => compareText(left.id, right.id));
  if (named !== undefined) {
    const template = ordered.find((item) => item.id === named);
    if (!template) return { kind: "unsatisfied", unsatisfied: { kind: "template", requirement: named, detail: "no agent template with this identity is configured" } };
    const declared = templateSkills(template);
    const missing = required.filter((skill) => !declared.has(skill));
    if (missing.length) {
      return { kind: "unsatisfied", unsatisfied: { kind: "template", requirement: missing.join(", "), detail: `agent template ${named} does not declare this skill` } };
    }
    return { kind: "template", template };
  }
  if (required.length === 0) return { kind: "none" };
  const template = ordered.find((item) => {
    const declared = templateSkills(item);
    return required.every((skill) => declared.has(skill));
  });
  if (!template) {
    return { kind: "unsatisfied", unsatisfied: { kind: "template", requirement: required.join(", "), detail: "no agent template declares every required skill, so the legacy skill requirement has no deterministic template" } };
  }
  return { kind: "template", template };
}

const intersect = (left: readonly string[] | undefined, right: readonly string[] | undefined): string[] | undefined => {
  if (left === undefined) return right === undefined ? undefined : [...right];
  if (right === undefined) return [...left];
  return left.filter((value) => right.includes(value));
};

const union = (left: readonly string[] | undefined, right: readonly string[] | undefined): string[] | undefined => {
  if (left === undefined && right === undefined) return undefined;
  return [...new Set([...(left ?? []), ...(right ?? [])])];
};

/**
 * The hard requirements a task placed through a template must satisfy: the task's own, tightened by
 * the template's. A template can only narrow — accepted sets intersect, required label sets unite,
 * and minimums take the larger — so passing through a template never weakens a hard requirement.
 * Preferences merge field by field with the task's ranking winning, because a template's preference
 * is a default and the task's is a request.
 */
export function requirementsThroughTemplate(requirements: ExecutionRequirements, template: AgentTemplate | undefined): ExecutionRequirements {
  if (!template) return requirements;
  const extra = template.requirements ?? {};
  const merged: ExecutionRequirements = { ...requirements };
  const narrow = <K extends "harnessIds" | "models" | "transports" | "operatingSystems" | "architectures">(key: K) => {
    const value = intersect(requirements[key], extra[key]);
    if (value === undefined) delete merged[key];
    else merged[key] = value as ExecutionRequirements[K];
  };
  narrow("harnessIds");
  narrow("models");
  narrow("transports");
  narrow("operatingSystems");
  narrow("architectures");
  const labels = union(requirements.labels, extra.labels);
  if (labels === undefined) delete merged.labels;
  else merged.labels = labels;
  const skills = union(requirements.skills, extra.skills);
  if (skills === undefined) delete merged.skills;
  else merged.skills = skills;
  for (const key of ["minimumConcurrency", "minimumMemoryMegabytes"] as const) {
    const values = [requirements[key], extra[key]].filter((value): value is number => value !== undefined);
    if (values.length) merged[key] = Math.max(...values);
  }
  if (merged.projectProfileId === undefined && extra.projectProfileId !== undefined) merged.projectProfileId = extra.projectProfileId;
  if (merged.workspace === undefined && extra.workspace !== undefined) merged.workspace = { ...extra.workspace };
  const preferences = { ...(template.preferences ?? {}), ...(extra.preferences ?? {}), ...(requirements.preferences ?? {}) };
  if (Object.keys(preferences).length) merged.preferences = preferences;
  merged.templateId = template.id;
  return merged;
}

/* ---------------------------------------------------------------------------------------------
 * Instances: reuse and explicit pins.
 * ------------------------------------------------------------------------------------------- */

/** An instance the scheduler may still place work on, and the allocation it would be placed against. */
export interface InstanceCandidate {
  instance: AgentInstance;
  allocation: InstanceAllocation;
}

/**
 * Every reason `instance` cannot execute `task` now. A resident is usable only when it belongs to the
 * task's own thread, is ready or idle with an active allocation on a connected version-5 node, holds
 * no other active attempt, and its allocation's resolved harness, model, transport, workspace, and
 * the node's fresh evidence still satisfy every hard requirement of the task. An instance whose
 * immutable requirements were fixed for a different workload is never substituted.
 */
export function instanceUnsatisfied(
  task: Task,
  instance: AgentInstance,
  environment: PlacementEnvironment,
  profile: ProjectProfile | undefined,
  requiredNodeId?: string
): UnsatisfiedRequirement[] {
  const requirements = task.requirements;
  const unsatisfied: UnsatisfiedRequirement[] = [];
  const add = (kind: PlacementRequirementKind, requirement: string, detail: string, nodeId?: string) => {
    unsatisfied.push({ kind, requirement, ...(nodeId === undefined ? {} : { nodeId }), instanceId: instance.id, detail });
  };
  if (instance.threadId !== task.threadId) {
    add("instance", instance.id, "the instance belongs to another thread");
    return unsatisfied;
  }
  if (terminalInstanceStatuses.includes(instance.status)) add("instance", instance.id, `the instance is ${instance.status}`);
  else if (instance.status === "draining") add("instance", instance.id, "the instance is draining");
  else if (instance.status !== "ready" && instance.status !== "idle") add("instance", instance.id, `the instance is ${instance.status} and cannot accept work yet`);
  const allocation = (environment.allocations ?? []).find((item) => item.instanceId === instance.id && item.status === "active");
  if (!allocation) {
    add("instance", instance.id, "the instance holds no active allocation");
    return unsatisfied;
  }
  if (environment.runs.some((run) => run.instanceId === instance.id && isActiveRunStatus(run.status))) {
    add("instance", instance.id, "the instance already has an active run");
  }
  if (requiredNodeId !== undefined && allocation.nodeId !== requiredNodeId) {
    add("instance", requiredNodeId, "the instance is allocated to a node the placement override does not permit", allocation.nodeId);
  }
  const node = environment.nodes.find((item) => item.id === allocation.nodeId);
  if (!node) {
    add("node-offline", allocation.nodeId, "compute node has never registered", allocation.nodeId);
    return unsatisfied;
  }
  const connection = environment.connection(node.id);
  if (!connection) add("node-offline", node.id, "compute node is not connected", node.id);
  else {
    if (!supportsControlCapability(connection.protocolVersion, "instances")) {
      add("protocol-version", "control protocol version 5", "compute node registered a protocol version without ephemeral instances", node.id);
    }
    if (!connection.synced) add("node-offline", node.id, "compute node has not completed reconnect synchronization", node.id);
  }
  const profileHard = profile?.requirements.hard;
  if (requirements.harnessIds !== undefined && !requirements.harnessIds.includes(allocation.harnessId)) {
    add("harness", requirements.harnessIds.join(", "), "the instance is allocated to a different harness", node.id);
  }
  if (profileHard?.harnessIds !== undefined && !profileHard.harnessIds.includes(allocation.harnessId)) {
    add("project-profile", `harness ${profileHard.harnessIds.join(", ")}`, "the project profile does not allow the instance's harness", node.id);
  }
  if (requirements.models !== undefined && !requirements.models.includes(allocation.model)) {
    add("model", requirements.models.join(", "), "the instance is allocated to a different model", node.id);
  }
  if (requirements.transports !== undefined && !requirements.transports.includes(allocation.transport)) {
    add("transport", requirements.transports.join(", "), "the instance is allocated to a different transport", node.id);
  }
  if (profileHard?.transports !== undefined && !profileHard.transports.includes(allocation.transport)) {
    add("project-profile", `transport ${profileHard.transports.join(", ")}`, "the project profile does not allow the instance's transport", node.id);
  }
  if (requirements.projectProfileId !== instance.requirements.projectProfileId) {
    add("project-profile", requirements.projectProfileId ?? "none", "the instance was created for a different project policy", node.id);
  }
  if (requirements.templateId !== undefined && requirements.templateId !== instance.requirements.templateId) {
    add("template", requirements.templateId, "the instance was created for a different agent template", node.id);
  }
  evaluateNodeEvidence(task, node, profile, environment, (kind, requirement, detail) => add(kind, requirement, detail, node.id));
  const usage = nodeUsage(node, environment.runs);
  if (requirements.minimumConcurrency !== undefined && usage.concurrency < requirements.minimumConcurrency) {
    add("concurrency", String(requirements.minimumConcurrency), "compute node reports lower concurrency", node.id);
  }
  if (usage.used >= usage.concurrency) {
    add("capacity", `${usage.concurrency} run slots`, `${usage.used} run slots are reserved or reported active`, node.id);
  }
  const requestedPath = requirements.workspace?.path;
  if (requestedPath !== undefined && !isWorkspaceWithinRoot(requestedPath, allocation.workspace)) {
    add("workspace", requestedPath, "requested path is not beneath the instance's allocated workspace", node.id);
  }
  const excluded = residentExclusion(profile);
  if (excluded !== undefined) add("workspace", `${leasedIsolation(profile)} workspace lease`, excluded, node.id);
  return unsatisfied;
}

/** The same-thread instances a task may reuse, in a stable order. */
function reusableInstances(
  task: Task,
  environment: PlacementEnvironment,
  profile: ProjectProfile | undefined,
  requiredNodeId?: string
): InstanceCandidate[] {
  const candidates: InstanceCandidate[] = [];
  for (const instance of [...(environment.instances ?? [])].sort((left, right) => compareText(left.id, right.id))) {
    if (instance.threadId !== task.threadId) continue;
    if (instance.status !== "ready" && instance.status !== "idle") continue;
    if (instanceUnsatisfied(task, instance, environment, profile, requiredNodeId).length) continue;
    const allocation = (environment.allocations ?? []).find((item) => item.instanceId === instance.id && item.status === "active")!;
    candidates.push({ instance, allocation });
  }
  return candidates;
}

function compareEligible(left: CandidateEvaluation, right: CandidateEvaluation) {
  const leftRanks = left.ranks!;
  const rightRanks = right.ranks!;
  for (let index = 0; index < leftRanks.length; index += 1) {
    if (leftRanks[index] !== rightRanks[index]) return leftRanks[index] - rightRanks[index];
  }
  const utilization = left.usage!.used * right.usage!.concurrency - right.usage!.used * left.usage!.concurrency;
  if (utilization !== 0) return utilization;
  return compareText(left.candidate!.agentId, right.candidate!.agentId) || compareText(left.candidate!.nodeId, right.candidate!.nodeId);
}

const requirementIdentity = (entry: UnsatisfiedRequirement) =>
  JSON.stringify([entry.nodeId ?? "", entry.agentId ?? "", entry.instanceId ?? "", entry.kind, entry.requirement, entry.detail]);

function normalizeUnsatisfied(entries: readonly UnsatisfiedRequirement[]) {
  const unique = new Map(entries.map((entry) => [requirementIdentity(entry), entry]));
  return [...unique.entries()].sort(([left], [right]) => compareText(left, right)).map(([, entry]) => entry).slice(0, placementDiagnosticLimit);
}

/**
 * Chooses a deterministic placement for a ready task, or explains every hard requirement nothing
 * satisfies. Pure: it reads only `environment`.
 *
 * The decision order is fixed. An explicit instance pin is exact: it is authorized and validated
 * against that one instance and nothing else is ever substituted. A task that already owns a
 * requested or provisioning instance waits on it and is never offered again. Otherwise a compatible
 * ready or idle instance in the same thread is reused; failing that, a configured agent is used when
 * one is eligible — the compatibility path #78 removes — and failing that, the best eligible live
 * offering is reserved.
 */
export function placeTask(task: Task, environment: PlacementEnvironment): PlacementDecision {
  const global: UnsatisfiedRequirement[] = [];
  const diagnostic = (eligibleNodeIds: readonly string[], unsatisfied: readonly UnsatisfiedRequirement[]): PlacementDiagnostic => ({
    evaluatedAt: environment.now,
    eligibleNodeIds: [...new Set(eligibleNodeIds)].sort(compareText),
    unsatisfied: normalizeUnsatisfied(unsatisfied)
  });
  const override = task.placementOverride;
  const authorizedOverride = override === undefined || isAuthorizedPlacementOverride(override);
  if (!authorizedOverride) {
    global.push({ kind: "agent", requirement: "placement override", detail: "placement override is malformed or not authorized" });
  }
  /*
   * A template a task names explicitly is a global admission gate: naming one it cannot be placed
   * through leaves nothing to evaluate. A bare legacy skill requirement is not, because a configured
   * agent declares its own skills and the compatibility path still matches them directly; it only
   * closes the offering path, which has no skill evidence other than a template.
   */
  const templateResolution = resolveTaskTemplate(task, environment.templates ?? []);
  const namedTemplate = task.requirements.templateId !== undefined;
  if (templateResolution.kind === "unsatisfied" && namedTemplate) global.push(templateResolution.unsatisfied);
  const templateGap = templateResolution.kind === "unsatisfied" ? templateResolution.unsatisfied : undefined;
  const requirements = requirementsThroughTemplate(
    task.requirements,
    templateResolution.kind === "template" ? templateResolution.template : undefined
  );
  const effective: Task = { ...task, requirements };
  let profile: ProjectProfile | undefined;
  if (requirements.projectProfileId !== undefined) {
    profile = environment.projectProfile(requirements.projectProfileId);
    if (!profile) global.push({ kind: "project-profile", requirement: requirements.projectProfileId, detail: "project profile is not loaded" });
  }
  const repository = requirements.workspace?.repository;
  if (repository !== undefined && !repositoryAuthorized(profile, repository)) {
    global.push({ kind: "workspace", requirement: `repository ${repository}`, detail: "repository is not authorized by the task's project profile" });
  }
  if (global.length) return { kind: "unsatisfied", diagnostic: diagnostic([], global) };

  // A node the override names restricts every candidate set — instances, agents, and offerings alike.
  const requiredNodeId = override && authorizedOverride ? override.nodeId : undefined;
  /*
   * An agent pin names one configured agent, chosen for its identity, skills, and instructions. No
   * offering and no resident instance is that agent, so an agent pin closes both of those candidate
   * sets outright: the pinned task waits for its agent rather than being silently substituted onto an
   * anonymous resident with a different harness, model, node, or no system prompt at all.
   */
  const pinnedAgentId = override && authorizedOverride ? override.agentId : undefined;

  // An explicit pin is exact: no offering, reuse, or agent may stand in for the instance it names.
  const pinned = override && authorizedOverride ? override.instanceId : undefined;
  if (pinned !== undefined) {
    const instance = (environment.instances ?? []).find((item) => item.id === pinned);
    if (!instance) {
      return { kind: "unsatisfied", diagnostic: diagnostic([], [{ kind: "instance", requirement: pinned, detail: "no instance with this identity exists" }]) };
    }
    const failures = instanceUnsatisfied(effective, instance, environment, profile, requiredNodeId);
    if (failures.length === 0) {
      const allocation = (environment.allocations ?? []).find((item) => item.instanceId === instance.id && item.status === "active")!;
      return { kind: "instance", instanceId: instance.id, diagnostic: diagnostic([allocation.nodeId], []) };
    }
    // A pinned instance that is still coming up is a wait, not a failure: its allocation is already
    // reserved, so re-placing the task could only overbook the fleet with a second resident.
    if (instance.threadId === task.threadId && (instance.status === "requested" || instance.status === "provisioning")) {
      return { kind: "waiting", instanceId: instance.id, diagnostic: diagnostic([], failures) };
    }
    return { kind: "unsatisfied", diagnostic: diagnostic([], failures) };
  }

  // A task that already owns an instance waits on exactly that instance, so a second pass can
  // neither request a duplicate resident nor start a second attempt for the same allocation.
  const owned = task.placementInstanceId === undefined
    ? undefined
    : (environment.instances ?? []).find((item) => item.id === task.placementInstanceId);
  if (owned !== undefined && nonTerminalInstanceStatuses.includes(owned.status)) {
    const failures = instanceUnsatisfied(effective, owned, environment, profile, requiredNodeId);
    if (failures.length === 0) {
      const allocation = (environment.allocations ?? []).find((item) => item.instanceId === owned.id && item.status === "active")!;
      return { kind: "instance", instanceId: owned.id, diagnostic: diagnostic([allocation.nodeId], []) };
    }
    const awaitingReplacement = owned.status === "requested"
      && !(environment.allocations ?? []).some((item) => item.instanceId === owned.id && occupyingAllocation(item.status));
    if (!awaitingReplacement) return { kind: "waiting", instanceId: owned.id, diagnostic: diagnostic([], failures) };
  }

  const unsatisfied: UnsatisfiedRequirement[] = [];
  /*
   * An instance whose allocation was lost returns to `requested` and keeps its identity, so its
   * replacement allocates afresh against the same record rather than becoming a second resident.
   */
  const replacing = owned !== undefined && owned.status === "requested"
    && !(environment.allocations ?? []).some((item) => item.instanceId === owned.id && occupyingAllocation(item.status))
    ? owned
    : undefined;
  const reusable = replacing !== undefined || pinnedAgentId !== undefined
    ? []
    : reusableInstances(effective, environment, profile, requiredNodeId);
  if (reusable.length) {
    return {
      kind: "instance",
      instanceId: reusable[0].instance.id,
      diagnostic: diagnostic(reusable.map((candidate) => candidate.allocation.nodeId), [])
    };
  }
  /*
   * Only a ready or idle resident of this thread was ever a reuse candidate, so only those explain
   * why reuse failed. A resident another task is still provisioning is not a candidate and must not
   * appear in this task's diagnostics.
   */
  if (pinnedAgentId === undefined) {
    for (const instance of environment.instances ?? []) {
      if (instance.threadId !== task.threadId || (instance.status !== "ready" && instance.status !== "idle")) continue;
      unsatisfied.push(...instanceUnsatisfied(effective, instance, environment, profile, requiredNodeId));
    }
  }

  /*
   * Compatibility candidate set. It is consulted before offerings and only while a configured agent
   * is still eligible, because run, thread, session, and mailbox authority is agent-keyed until #78
   * migrates it; a leased task attempt in particular can be served only here. Everything an agent
   * cannot serve — including every workload on a fleet with no configured agents at all — is placed
   * from live offerings below.
   */
  const agents = [...environment.agents]
    .filter((agent) => (pinnedAgentId === undefined || agent.id === pinnedAgentId)
      && (requiredNodeId === undefined || agent.computeNodeId === requiredNodeId))
    .sort((left, right) => compareText(left.id, right.id));
  const agentEvaluations = agents.map((agent) => evaluateCandidate(effective, agent, profile, environment));
  const eligibleAgents = agentEvaluations.filter((evaluation) => evaluation.candidate !== undefined).sort(compareEligible);
  if (eligibleAgents.length) {
    return {
      kind: "assigned",
      candidate: eligibleAgents[0].candidate!,
      diagnostic: diagnostic(eligibleAgents.map((evaluation) => evaluation.candidate!.nodeId), [])
    };
  }
  unsatisfied.push(...agentEvaluations.flatMap((evaluation) => evaluation.unsatisfied));
  if (agents.length === 0 && pinnedAgentId !== undefined) {
    unsatisfied.push({ kind: "agent", requirement: "placement override", detail: "no configured agent is a candidate" });
  }

  // Live offerings. A node the override names restricts them exactly as it restricts agents; an agent
  // pin excludes them entirely, because no offering is the agent the operator named.
  const offeringNodes = pinnedAgentId !== undefined ? [] : [...environment.nodes]
    .filter((node) => offersInstances(node))
    .filter((node) => requiredNodeId === undefined || node.id === requiredNodeId)
    .sort((left, right) => compareText(left.id, right.id));
  /*
   * A legacy skill requirement with no covering template closes the offering path entirely: an
   * offering carries no skill evidence of its own, so there is no candidate to evaluate. A node that
   * publishes nothing for this workload still says why, because an unplaceable task must never end up
   * with an empty diagnostic.
   */
  const requestedPath = requirements.workspace?.path;
  const silentNodes: UnsatisfiedRequirement[] = [];
  const offeringEvaluations = templateGap !== undefined ? [] : offeringNodes.flatMap((node) => {
    const published = nodeOfferings(node, requestedPath);
    if (published.length === 0) {
      if (offeredWorkspace(node, requestedPath) === undefined) {
        silentNodes.push(requestedPath === undefined
          ? { kind: "workspace", requirement: "workspace beneath an advertised root", nodeId: node.id, detail: "the compute node advertises no workspace root" }
          : { kind: "workspace", requirement: requestedPath, nodeId: node.id, detail: "requested path is not beneath a root the compute node advertises" });
      } else {
        silentNodes.push({ kind: "offering", requirement: "available harness", nodeId: node.id, detail: "the compute node publishes no available harness offering" });
      }
    }
    return published.map((offering) => evaluateOffering(effective, offering, node, profile, environment));
  });
  const eligibleOfferings = offeringEvaluations.filter((evaluation) => evaluation.offering !== undefined).sort(compareOfferings);
  if (eligibleOfferings.length) {
    return {
      kind: "offering",
      offering: eligibleOfferings[0].offering!,
      ...(replacing === undefined ? {} : { instanceId: replacing.id }),
      diagnostic: diagnostic(eligibleOfferings.map((evaluation) => evaluation.offering!.nodeId), [])
    };
  }
  if (replacing !== undefined) {
    unsatisfied.push(...silentNodes, ...offeringEvaluations.flatMap((evaluation) => evaluation.unsatisfied));
    if (unsatisfied.length === 0) {
      unsatisfied.push({ kind: "offering", requirement: "live harness offering", instanceId: replacing.id, detail: "no compute node publishes an offering the lost allocation can be replaced on" });
    }
    return { kind: "waiting", instanceId: replacing.id, diagnostic: diagnostic([], unsatisfied) };
  }
  if (templateGap !== undefined) {
    if (offeringNodes.length) unsatisfied.push(templateGap);
  } else {
    unsatisfied.push(...silentNodes, ...offeringEvaluations.flatMap((evaluation) => evaluation.unsatisfied));
  }
  /*
   * Say so whenever the pin actually closed a candidate set that could otherwise have been tried, so
   * an operator reading the diagnostic is never left wondering why a healthy offering or an idle
   * resident went unused. A fleet that publishes neither needs no such explanation.
   */
  const pinClosedCandidates = pinnedAgentId !== undefined
    && (environment.nodes.some(offersInstances)
      || (environment.instances ?? []).some((item) => item.threadId === task.threadId && (item.status === "ready" || item.status === "idle")));
  if (pinClosedCandidates) {
    unsatisfied.push({
      kind: "agent",
      requirement: pinnedAgentId!,
      detail: "the task is pinned to a configured agent, so no live offering or resident instance may serve it"
    });
  }
  if (offeringNodes.length === 0 && agents.length === 0) {
    unsatisfied.push({
      kind: "agent",
      requirement: pinnedAgentId !== undefined ? "placement override" : "configured agent",
      detail: "no configured agent is a candidate"
    });
  } else if (offeringNodes.length === 0 && unsatisfied.length === 0) {
    unsatisfied.push({ kind: "offering", requirement: "live harness offering", detail: "no compute node publishes a resident instance offering" });
  }
  return { kind: "unsatisfied", diagnostic: diagnostic([], unsatisfied) };
}

/**
 * Whether the dispatch this attempt would produce can be encoded for the wire, decided before the
 * attempt is committed. `instanceRunFor` throws only for a run that is not instance-keyed, which this
 * path has already established, so the check reports rather than raises.
 */
function instanceDispatchIsEncodable(state: Readonly<State>, run: Run): { ok: true } | { ok: false; reason: string } {
  const instance = (state.instances ?? []).find((item) => item.id === run.instanceId);
  const allocation = (state.allocations ?? []).find((item) => item.id === run.allocationId);
  if (!instance || !allocation) return { ok: false, reason: "the attempt names no known instance allocation" };
  const wireValid = validateInstanceHubMessage({
    type: "dispatch",
    instance: structuredClone(instance),
    allocation: structuredClone(allocation),
    run: instanceRunFor(run)
  }, "5");
  return wireValid.ok ? { ok: true } : { ok: false, reason: `the dispatch command is not wire-valid: ${wireValid.reason}` };
}

/**
 * Reserves a replacement allocation for an instance that already exists, reported in the same shape
 * as a create-and-reserve so the scheduler has one code path for both. A missing instance is a
 * capacity refusal rather than a throw: the pass records a diagnostic and leaves the task placeable.
 */
function reservationAsPlacement(state: State, instanceId: string, candidate: AllocationCandidate, at: string): InstancePlacementResult {
  const reservation = reserveInstanceAllocationInState(state, instanceId, candidate, at);
  if (reservation.kind === "not-found") return { kind: "capacity", reason: `Instance ${instanceId} no longer exists` };
  if (reservation.kind !== "reserved") return reservation;
  const instance = (state.instances ?? []).find((item) => item.id === instanceId)!;
  return { kind: "placed", instance, allocation: reservation.allocation };
}

/**
 * The version-5 wire projection of a stored instance run: the same record without the compatibility
 * agent key, which the v5 contract forbids. It throws rather than guessing when the run is not
 * instance-keyed, so a legacy agent run can never be dispatched as a resident's work.
 */
export function instanceRunFor(run: Run): InstanceRun {
  if (run.instanceId === undefined || run.allocationId === undefined || run.threadId === undefined || run.transport === undefined) {
    throw new Error("an instance dispatch requires a thread, instance, allocation, and transport");
  }
  const { agentId, ...rest } = run;
  void agentId;
  return { ...rest, threadId: run.threadId, instanceId: run.instanceId, allocationId: run.allocationId, transport: run.transport };
}

/**
 * The dispatch message for a run; task attempts and orchestrator continuations also carry their
 * version-4 execution. A leased attempt carries its grant only while the lease may still be
 * provisioned, so a settled lease can never be resurrected by a replayed dispatch: Barista rejects
 * a run naming a lease without one. A run naming a session binding carries it only while that
 * binding may still be resumed by this run (see `sessionDispatchFor`).
 */
export function dispatchMessageFor(
  run: Run,
  agent: Agent,
  agents: readonly Agent[],
  leases: readonly WorkspaceLease[] = [],
  sessions: SessionDispatchSource = {}
): Extract<HubToControlAgent, { type: "dispatch" }> {
  const directory = agents.filter((item) => item.id !== agent.id).map((item) => `${item.id} (${item.title})`).join(", ");
  const dispatchAgent = { ...agent, systemPrompt: `${agent.systemPrompt}\n\nAvailable teammates: ${directory || "none"}` };
  if (run.taskId === undefined && run.transport === undefined && run.sessionBindingId === undefined) return { type: "dispatch", run, agent: dispatchAgent };
  const session = sessionDispatchFor(run, sessions);
  const execution: DispatchExecution = run.taskId === undefined
    ? { transport: run.transport ?? "native-cli" }
    : { transport: run.transport ?? "native-cli", taskId: run.taskId, attempt: run.attempt };
  if (run.transport === "acp-v1" && run.fallbackTransport === "native-cli") execution.fallbackTransport = "native-cli";
  if (session.sessionBinding) execution.sessionBinding = session.sessionBinding;
  const lease = dispatchableLease(leases, run.id, run.workspaceLeaseId);
  if (lease) execution.workspaceLease = workspaceLeaseGrant(lease);
  return { type: "dispatch", run: session.run, agent: dispatchAgent, execution };
}

export interface SchedulingContext {
  connection(nodeId: string): NodeConnection | undefined;
  capabilityReport(nodeId: string): NodeCapabilityReport | undefined;
  projectProfile(projectId: string): ProjectProfile | undefined;
  evidenceTTLMilliseconds?: number;
  /** Whether the node's current socket may receive `message`; only then is delivery recorded. */
  canDeliver(nodeId: string, message: HubToControlAgent): boolean;
}

export interface ScheduledAttempt {
  taskId: string;
  runId: string;
  nodeId: string;
  /**
   * The resident instance the attempt runs as, when it is instance-keyed. Its dispatch is already
   * persisted in the instance outbox, so the caller flushes that outbox instead of sending the run.
   */
  instanceId?: string;
  /** Whether the pass recorded a delivery decision; the caller must send exactly these runs. */
  delivered: boolean;
}

export interface SchedulingPassResult {
  changed: boolean;
  attempts: ScheduledAttempt[];
}

const diagnosticContent = (diagnostic: PlacementDiagnostic | undefined) =>
  diagnostic && JSON.stringify([diagnostic.eligibleNodeIds, diagnostic.unsatisfied]);

/** Records a diagnostic only when its content changed, so repeated passes do not rewrite state. */
function recordPlacement(task: Task, diagnostic: PlacementDiagnostic) {
  if (diagnosticContent(task.placement) === diagnosticContent(diagnostic)) return false;
  task.placement = diagnostic;
  return true;
}

function inconsistentAssignment(state: Readonly<State>, task: Task): string | undefined {
  if (task.status === "ready") return task.assignment ? "a ready task still records an assignment" : undefined;
  if (task.status !== "assigned" && task.status !== "running") return undefined;
  if (!task.assignment) return `an ${task.status} task has no assignment`;
  const run = state.runs.find((item) => item.id === task.assignment!.runId);
  if (!run || run.taskId !== task.id) return "the assigned attempt run is missing";
  if (!isActiveRunStatus(run.status)) return "the assigned attempt run already ended";
  return undefined;
}

/**
 * Places every ready task it can against one consistent state, inside the caller's transaction.
 * Each new attempt reserves its slot in `state.runs` before the next task is evaluated, so one pass
 * never overbooks, and a task that already has an attempt is never offered again. A task whose
 * persisted assignment cannot be interpreted is never dispatched; it is surfaced for an operator.
 */
export function runSchedulingPass(state: State, context: SchedulingContext, at: string): SchedulingPassResult {
  let changed = false;
  const attempts: ScheduledAttempt[] = [];
  for (const task of state.tasks ?? []) {
    const problem = inconsistentAssignment(state, task);
    if (problem) changed = recordPlacement(task, {
      evaluatedAt: at,
      eligibleNodeIds: [],
      unsatisfied: [{ kind: "assignment", requirement: "consistent persisted assignment", detail: `${problem}; operator attention is required` }]
    }) || changed;
  }
  // A resident whose attempt has settled is available again; the scheduler must see that before it
  // decides whether to reuse it or request another.
  if (convergeInstanceActivityInState(state, at)) changed = true;
  /*
   * A placement intent survives only as long as the instance it names can still carry the task. A
   * released, failed, draining, or vanished instance is immutable history: the intent is dropped so
   * the retry policy places the task afresh — on a new instance with new identities — instead of
   * waiting forever on an allocation that will never be ready.
   */
  for (const task of state.tasks ?? []) {
    if (task.placementInstanceId === undefined) continue;
    const instance = (state.instances ?? []).find((item) => item.id === task.placementInstanceId);
    const unusable = !instance || !nonTerminalInstanceStatuses.includes(instance.status);
    // A task that will never be placed again — cancelled, failed, completed — releases its resident
    // promptly rather than leaving it to hold a node slot until its idle lease expires.
    const unwanted = isTerminalTaskStatus(task.status);
    if (!unusable && !unwanted) continue;
    state.events.unshift(newEvent({
      type: "status",
      title: "Task placement released",
      detail: unusable
        ? `Instance ${task.placementInstanceId} can no longer carry ${task.title.slice(0, 80)}`
        : `${task.title.slice(0, 80)} is ${task.status} and no longer needs instance ${task.placementInstanceId}`,
      threadId: task.threadId
    }));
    const released = task.placementInstanceId;
    delete task.placementInstanceId;
    task.updatedAt = at;
    if (!unusable) releaseUnneededInstanceInState(state, released, at);
    changed = true;
  }
  const environmentFor = (): PlacementEnvironment => ({
    agents: state.agents,
    nodes: state.nodes,
    runs: state.runs,
    connection: context.connection,
    capabilityReport: context.capabilityReport,
    projectProfile: context.projectProfile,
    workspaceLeases: state.workspaceLeases,
    instances: state.instances,
    allocations: state.allocations,
    templates: state.templates,
    residentUsage: (node) => residentInstanceUsage(node, state.allocations ?? [], nodeResidencyInState(state, node.id)),
    evidenceTTLMilliseconds: context.evidenceTTLMilliseconds,
    now: at
  });
  for (const task of [...readyTasks(state)]) {
    const thread = state.threads?.find((item) => item.id === task.threadId);
    if (thread?.status !== "active" || taskReadiness(state, task).outcome !== "satisfied") continue;
    const decision = placeTask(task, environmentFor());
    if (decision.kind === "unsatisfied" || decision.kind === "waiting") {
      changed = recordPlacement(task, decision.diagnostic) || changed;
      continue;
    }
    if (decision.kind === "offering") {
      const { offering } = decision;
      const templateResolution = resolveTaskTemplate(task, state.templates ?? []);
      const requirements = requirementsThroughTemplate(
        task.requirements,
        templateResolution.kind === "template" ? templateResolution.template : undefined
      );
      const template = templateResolution.kind === "template" ? templateResolution.template : undefined;
      const candidate = {
        nodeId: offering.nodeId,
        harnessId: offering.harnessId,
        model: offering.model,
        transport: offering.transport,
        workspace: offering.workspace
      };
      const placement: InstancePlacementResult = decision.instanceId === undefined
        ? placeInstanceInState(state, {
          threadId: task.threadId,
          requirements,
          ...(template?.purpose ? { purpose: template.purpose } : {})
        }, candidate, at)
        : reservationAsPlacement(state, decision.instanceId, candidate, at);
      if (placement.kind !== "placed") {
        /*
         * A refusal never throws out of the pass: one transaction decides every ready task, so an
         * exception here would roll back placements that have nothing to do with this task, and every
         * later pass would hit the same wall. It is recorded as this task's own diagnostic instead.
         */
        changed = recordPlacement(task, {
          evaluatedAt: at,
          eligibleNodeIds: [],
          unsatisfied: [{
            kind: placement.kind === "invalid" ? "instance" : "resident-capacity",
            requirement: offering.nodeId,
            nodeId: offering.nodeId,
            detail: placement.reason
          }]
        }) || changed;
        continue;
      }
      // Task intent, instance request, and reservation are now committed by the caller's one
      // transaction, so no second pass can offer this task or duplicate its resident.
      task.placementInstanceId = placement.instance.id;
      task.updatedAt = at;
      thread.updatedAt = at;
      /*
       * The provisioning wait is rendered by re-deciding against the now-committed state, so it is
       * byte-identical to what the next pass derives and repeated passes rewrite nothing.
       */
      recordPlacement(task, placeTask(task, environmentFor()).diagnostic);
      changed = true;
      continue;
    }
    if (decision.kind === "instance") {
      const accepted = acceptInstanceWorkInState(state, decision.instanceId, at);
      if (!accepted) {
        changed = recordPlacement(task, {
          evaluatedAt: at,
          eligibleNodeIds: [],
          unsatisfied: [{ kind: "instance", requirement: decision.instanceId, instanceId: decision.instanceId, detail: "the instance can no longer accept work" }]
        }) || changed;
        continue;
      }
      const { instance, allocation } = accepted;
      const source = task.sourceRunId === undefined ? undefined : state.runs.find((item) => item.id === task.sourceRunId);
      const run: Run = {
        id: newId("run"),
        threadId: task.threadId,
        // Compatibility: the instance identity also fills the required agent key until #78 migrates
        // run authority off agents. It never names a configured agent, so no agent-keyed lookup matches.
        agentId: instance.id,
        instanceId: instance.id,
        allocationId: allocation.id,
        nodeId: allocation.nodeId,
        harnessId: allocation.harnessId,
        model: allocation.model,
        workspace: allocation.workspace,
        prompt: `${task.title}\n\n${task.instructions}`,
        status: "queued",
        output: "",
        depth: source ? source.depth + 1 : 0,
        ...(source ? { parentRunId: source.id } : {}),
        createdAt: at,
        transport: allocation.transport
      };
      /*
       * The attempt's own identity is decided before the command is validated, because the wire
       * record carries it, and the command is validated before the attempt is committed, so a record
       * this hub cannot encode becomes this task's diagnostic rather than an exception that aborts the
       * whole pass.
       */
      run.taskId = task.id;
      run.attempt = task.attemptRunIds.length + 1;
      const command = instanceDispatchIsEncodable(state, run);
      if (!command.ok) {
        changed = recordPlacement(task, {
          evaluatedAt: at,
          eligibleNodeIds: [],
          unsatisfied: [{ kind: "instance", requirement: instance.id, nodeId: allocation.nodeId, instanceId: instance.id, detail: command.reason }]
        }) || changed;
        continue;
      }
      assignTaskAttempt(state, task.id, run, at);
      delete task.placementInstanceId;
      task.placement = decision.diagnostic;
      // The dispatch is persisted in #75's crash-safe outbox before any socket write, so a crash
      // between the attempt's commit and its send replays the command instead of stranding the run.
      appendInstanceDispatchInState(state, instanceRunFor(run), at);
      thread.updatedAt = at;
      state.events.unshift(newEvent({
        type: "run",
        title: `${instance.purpose?.name ?? instance.id} was assigned a task`,
        detail: task.title.slice(0, 120),
        threadId: task.threadId,
        runId: run.id
      }));
      attempts.push({ taskId: task.id, runId: run.id, nodeId: run.nodeId, instanceId: instance.id, delivered: false });
      changed = true;
      continue;
    }
    const { candidate } = decision;
    const agent = state.agents.find((item) => item.id === candidate.agentId)!;
    const source = task.sourceRunId === undefined ? undefined : state.runs.find((item) => item.id === task.sourceRunId);
    const run: Run = {
      id: newId("run"),
      threadId: task.threadId,
      agentId: candidate.agentId,
      nodeId: candidate.nodeId,
      harnessId: candidate.harnessId,
      model: candidate.model,
      workspace: candidate.workspace,
      prompt: `${task.title}\n\n${task.instructions}`,
      status: "queued",
      output: "",
      depth: source ? source.depth + 1 : 0,
      parentRunId: source?.id,
      createdAt: at,
      transport: candidate.transport,
      ...(candidate.fallbackTransport ? { fallbackTransport: candidate.fallbackTransport } : {})
    };
    const profile = task.requirements.projectProfileId === undefined ? undefined : context.projectProfile(task.requirements.projectProfileId);
    if (profile && leasedIsolation(profile) !== undefined) {
      const node = state.nodes.find((item) => item.id === candidate.nodeId)!;
      const plan = planWorkspaceLease({ task, agent, node, profile, runId: run.id, leaseId: newId("lease"), at });
      if (!plan.ok) {
        changed = recordPlacement(task, {
          evaluatedAt: at,
          eligibleNodeIds: [],
          unsatisfied: [{ kind: "workspace", requirement: plan.requirement, nodeId: candidate.nodeId, agentId: candidate.agentId, detail: plan.detail }]
        }) || changed;
        continue;
      }
      state.workspaceLeases ??= [];
      state.workspaceLeases.push(plan.lease);
      run.workspaceLeaseId = plan.lease.id;
      run.workspace = plan.lease.worktreePath;
    }
    assignTaskAttempt(state, task.id, run, at);
    // The compatibility path fulfils the task itself, so any instance intent it still held is
    // released here, and the resident it named is drained rather than left holding a node slot that
    // nothing will ever dispatch to.
    const abandoned = task.placementInstanceId;
    delete task.placementInstanceId;
    if (abandoned !== undefined) releaseUnneededInstanceInState(state, abandoned, at);
    task.placement = decision.diagnostic;
    const delivered = context.canDeliver(run.nodeId, dispatchMessageFor(run, agent, state.agents, state.workspaceLeases, state));
    if (delivered) run.dispatchedAt = at;
    agent.state = delivered ? "thinking" : "waiting";
    agent.currentAction = delivered ? "Starting task" : "Waiting for compute";
    agent.updatedAt = at;
    thread.updatedAt = at;
    state.events.unshift(newEvent({
      type: "run",
      title: `${agent.name} was assigned a task`,
      detail: task.title.slice(0, 120),
      threadId: task.threadId,
      agentId: agent.id,
      runId: run.id
    }));
    attempts.push({ taskId: task.id, runId: run.id, nodeId: run.nodeId, delivered });
    changed = true;
  }
  return { changed, attempts };
}
