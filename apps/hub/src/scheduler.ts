import {
  harnessTransports,
  isActiveRunStatus,
  isHarnessTransport,
  resolveNodeCapability,
  satisfiesMinimumQuantity,
  supportsControlCapability,
  type Agent,
  type ComputeNode,
  type ControlProtocolVersion,
  type DispatchExecution,
  type HarnessId,
  type HarnessTransport,
  type HubToControlAgent,
  type NodeCapabilityReport,
  type PlacementDiagnostic,
  type PlacementOverride,
  type PlacementRequirementKind,
  type ProjectProfile,
  type ProjectReadiness,
  type ResolvedNodeCapability,
  type Run,
  type Task,
  type UnsatisfiedRequirement
} from "@coffee-shop/protocol";
import { isWorkspaceWithinRoot } from "./agentConfiguration.js";
import { computeNodeProjectReadiness, defaultEvidenceTTLMilliseconds } from "./projectReadiness.js";
import { newEvent, newId, type State } from "./store.js";
import { assignTaskAttempt, readyTasks, taskReadiness } from "./tasks.js";

/*
 * Task placement.
 *
 * A candidate is a configured agent on its configured compute node; the agent fixes the harness,
 * model, and workspace, and the scheduler never relocates it. Every hard requirement is evaluated
 * for every candidate and must match. Preferences never exclude a candidate; they only rank the
 * candidates that already satisfy every hard requirement. The ranking, compared in order, is:
 *
 *   1. position of the node in `preferences.nodeIds` (unlisted nodes rank after every listed one);
 *   2. position of the harness in `preferences.harnessIds`;
 *   3. position of the model in `preferences.models`;
 *   4. number of `preferences.labels` the node does not report (fewer first);
 *   5. number of unmet project-profile preferences (fewer first);
 *   6. node utilization, reserved slots divided by concurrency (lower first);
 *   7. agent ID, then node ID, by code-unit order.
 *
 * Nothing depends on input array order, timestamps, or randomness, so the same inventory always
 * yields the same placement.
 */

/** Hub-observed state of a node's current control socket. */
export interface NodeConnection {
  protocolVersion: ControlProtocolVersion;
  /** Whether the socket has completed its reconnect barrier (`sync.complete`). */
  synced: boolean;
}

export interface PlacementEnvironment {
  agents: readonly Agent[];
  nodes: readonly ComputeNode[];
  runs: readonly Run[];
  connection(nodeId: string): NodeConnection | undefined;
  capabilityReport(nodeId: string): NodeCapabilityReport | undefined;
  projectProfile(projectId: string): ProjectProfile | undefined;
  now: string;
  evidenceTTLMilliseconds?: number;
}

export interface PlacementCandidate {
  agentId: string;
  nodeId: string;
  harnessId: HarnessId;
  model: string;
  transport: HarnessTransport;
  workspace: string;
}

export type PlacementDecision =
  | { kind: "assigned"; candidate: PlacementCandidate; diagnostic: PlacementDiagnostic }
  | { kind: "unsatisfied"; diagnostic: PlacementDiagnostic };

export const placementDiagnosticLimit = 200;

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

export function isAuthorizedPlacementOverride(value: unknown): value is PlacementOverride {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const override = value as Record<string, unknown>;
  if (!Object.keys(override).every((key) => key === "agentId" || key === "nodeId" || key === "authorizedBy")) return false;
  if (override.authorizedBy !== "operator" && override.authorizedBy !== "policy") return false;
  const optionalIdentity = (entry: unknown) => entry === undefined || (typeof entry === "string" && entry.length > 0);
  if (!optionalIdentity(override.agentId) || !optionalIdentity(override.nodeId)) return false;
  return override.agentId !== undefined || override.nodeId !== undefined;
}

function repositoryAuthorized(profile: ProjectProfile | undefined, repository: string) {
  if (!profile) return false;
  if (profile.workspacePolicy.allowedRepositories !== undefined) return profile.workspacePolicy.allowedRepositories.includes(repository);
  return profile.repository?.url === repository;
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
  const evidenceTTLMilliseconds = environment.evidenceTTLMilliseconds ?? defaultEvidenceTTLMilliseconds;
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
  const transport = harnessTransports.find((item) => advertisedTransports.includes(item)
    && (requirements.transports === undefined || requirements.transports.includes(item))
    && (profileHard?.transports === undefined || profileHard.transports.includes(item)));
  if (harnessAvailable && transport === undefined) {
    add("transport", (requirements.transports ?? profileHard?.transports ?? ["native-cli"]).join(", "), "no transport the harness reports satisfies the requirement");
  }

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
  if (requirements.workspace?.writable) {
    const resolved = resolve("workspace-writable");
    if (resolved.state !== "ok") evidenceFailure("workspace", "writable workspace", resolved, "");
  }

  let readiness: ProjectReadiness | undefined;
  if (profile) {
    readiness = computeNodeProjectReadiness(node, environment.capabilityReport(node.id), profile, environment.now, evidenceTTLMilliseconds);
    for (const unmet of readiness.unmetHardRequirements) add("project-profile", `${unmet.kind} ${unmet.requirement}`, unmet.detail);
  }

  if (usage.used >= usage.concurrency) add("capacity", `${usage.concurrency} slots`, `${usage.used} slots are reserved or reported active`);
  if (environment.runs.some((run) => run.agentId === agent.id && run.taskId !== undefined && isActiveRunStatus(run.status))) {
    add("capacity", "idle agent", "agent already has an active task attempt in its workspace");
  }

  if (unsatisfied.length || transport === undefined) return { unsatisfied };
  const preferences = requirements.preferences;
  const missingPreferredLabels = (preferences?.labels ?? []).filter((label) => resolve(`label:${label.toLowerCase()}`).state !== "ok").length;
  return {
    unsatisfied,
    candidate: { agentId: agent.id, nodeId: node.id, harnessId: agent.harnessId, model: agent.model, transport, workspace: requestedPath ?? agent.workspace },
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
  JSON.stringify([entry.nodeId ?? "", entry.agentId ?? "", entry.kind, entry.requirement, entry.detail]);

function normalizeUnsatisfied(entries: readonly UnsatisfiedRequirement[]) {
  const unique = new Map(entries.map((entry) => [requirementIdentity(entry), entry]));
  return [...unique.entries()].sort(([left], [right]) => compareText(left, right)).map(([, entry]) => entry).slice(0, placementDiagnosticLimit);
}

/**
 * Chooses a deterministic placement for a ready task or explains, per candidate, every hard
 * requirement that no candidate satisfies. Pure: it reads only `environment`.
 */
export function placeTask(task: Task, environment: PlacementEnvironment): PlacementDecision {
  const requirements = task.requirements;
  const global: UnsatisfiedRequirement[] = [];
  const override = task.placementOverride;
  const authorizedOverride = override === undefined || isAuthorizedPlacementOverride(override);
  if (!authorizedOverride) global.push({ kind: "agent", requirement: "placement override", detail: "placement override is malformed or not authorized" });
  let profile: ProjectProfile | undefined;
  if (requirements.projectProfileId !== undefined) {
    profile = environment.projectProfile(requirements.projectProfileId);
    if (!profile) global.push({ kind: "project-profile", requirement: requirements.projectProfileId, detail: "project profile is not loaded" });
  }
  const repository = requirements.workspace?.repository;
  if (repository !== undefined && !repositoryAuthorized(profile, repository)) {
    global.push({ kind: "workspace", requirement: `repository ${repository}`, detail: "repository is not authorized by the task's project profile" });
  }
  const agents = [...environment.agents]
    .filter((agent) => !override || !authorizedOverride
      || ((override.agentId === undefined || agent.id === override.agentId) && (override.nodeId === undefined || agent.computeNodeId === override.nodeId)))
    .sort((left, right) => compareText(left.id, right.id));
  if (agents.length === 0) {
    global.push({ kind: "agent", requirement: override && authorizedOverride ? "placement override" : "configured agent", detail: "no configured agent is a candidate" });
  }
  const diagnostic = (eligibleNodeIds: string[], unsatisfied: UnsatisfiedRequirement[]): PlacementDiagnostic => ({
    evaluatedAt: environment.now,
    eligibleNodeIds: [...new Set(eligibleNodeIds)].sort(compareText),
    unsatisfied: normalizeUnsatisfied(unsatisfied)
  });
  if (global.length) return { kind: "unsatisfied", diagnostic: diagnostic([], global) };

  const evaluations = agents.map((agent) => evaluateCandidate(task, agent, profile, environment));
  const eligible = evaluations.filter((evaluation) => evaluation.candidate !== undefined).sort(compareEligible);
  if (eligible.length === 0) return { kind: "unsatisfied", diagnostic: diagnostic([], evaluations.flatMap((evaluation) => evaluation.unsatisfied)) };
  return {
    kind: "assigned",
    candidate: eligible[0].candidate!,
    diagnostic: diagnostic(eligible.map((evaluation) => evaluation.candidate!.nodeId), [])
  };
}

/** The dispatch message for a run; task attempts also carry their version-4 execution. */
export function dispatchMessageFor(run: Run, agent: Agent, agents: readonly Agent[]): Extract<HubToControlAgent, { type: "dispatch" }> {
  const directory = agents.filter((item) => item.id !== agent.id).map((item) => `${item.id} (${item.title})`).join(", ");
  const dispatchAgent = { ...agent, systemPrompt: `${agent.systemPrompt}\n\nAvailable teammates: ${directory || "none"}` };
  if (run.taskId === undefined) return { type: "dispatch", run, agent: dispatchAgent };
  const execution: DispatchExecution = { transport: run.transport ?? "native-cli", taskId: run.taskId, attempt: run.attempt };
  return { type: "dispatch", run, agent: dispatchAgent, execution };
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
  for (const task of [...readyTasks(state)]) {
    const thread = state.threads?.find((item) => item.id === task.threadId);
    if (thread?.status !== "active" || taskReadiness(state, task).outcome !== "satisfied") continue;
    const decision = placeTask(task, {
      agents: state.agents,
      nodes: state.nodes,
      runs: state.runs,
      connection: context.connection,
      capabilityReport: context.capabilityReport,
      projectProfile: context.projectProfile,
      evidenceTTLMilliseconds: context.evidenceTTLMilliseconds,
      now: at
    });
    if (decision.kind === "unsatisfied") {
      changed = recordPlacement(task, decision.diagnostic) || changed;
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
      transport: candidate.transport
    };
    assignTaskAttempt(state, task.id, run, at);
    task.placement = decision.diagnostic;
    const delivered = context.canDeliver(run.nodeId, dispatchMessageFor(run, agent, state.agents));
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
