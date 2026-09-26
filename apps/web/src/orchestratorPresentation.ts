import {
  threadOrchestrator, type Agent, type AgentInstance, type ApprovalResolvedBy, type OrchestratorAttachment,
  type OrchestratorClient, type OrchestratorClientScope, type Thread
} from "@coffee-shop/protocol";

/**
 * Operator-facing names for what a credential is allowed to do. `resolve-approvals` is described in
 * terms of the consequence an operator is consenting to, not in terms of the protocol scope.
 */
export const orchestratorClientScopeLabels: Record<OrchestratorClientScope, string> = {
  orchestrate: "Orchestrate threads",
  "resolve-approvals": "Approve worker actions"
};

export const resolveApprovalsWarning =
  "This lets the Claude Code session approve or reject what your workers ask to do — file writes, "
  + "commands, network calls — without asking you first. Grant it only to a session you are running "
  + "yourself and watching.";

/** A short "how long ago" phrase for prose such as "Detached since 12m ago". */
export function sinceLabel(timestamp: string, now: number = Date.now()): string {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return "an unreported time";
  const seconds = Math.round((now - parsed) / 1000);
  if (seconds < 60) return "moments ago";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export type ThreadOrchestratorDescriptionKind = "agent" | "instance" | "external" | "unknown";

export interface ThreadOrchestratorDescription {
  kind: ThreadOrchestratorDescriptionKind;
  /** Who orchestrates: an instance name, an agent name, a client name, or a fallback identity. */
  name: string;
  /** The live state of an external orchestrator; empty for an agent thread. */
  detail: string;
  attached: boolean;
  clientId?: string;
}

export interface OrchestratorContext {
  agents: Agent[];
  clients: OrchestratorClient[];
  attachments: OrchestratorAttachment[];
  /** Absent in a snapshot from a hub that predates instance-orchestrated threads. */
  instances?: AgentInstance[];
  now?: number;
}

/**
 * Describes who drives a thread for display. A snapshot from a hub that predates external
 * orchestrators carries neither `orchestrator` nor the client collections, so every lookup degrades
 * to the identity the snapshot does carry rather than failing.
 */
export function describeThreadOrchestrator(
  thread: Pick<Thread, "id" | "orchestrator" | "ownerAgentId">,
  { agents, clients, attachments, instances, now }: OrchestratorContext
): ThreadOrchestratorDescription {
  const orchestrator = threadOrchestrator(thread);
  if (orchestrator === undefined) return { kind: "unknown", name: "Unassigned", detail: "", attached: false };
  if (orchestrator.kind === "agent") {
    const agent = agents.find((candidate) => candidate.id === orchestrator.agentId);
    return { kind: "agent", name: agent?.name ?? orchestrator.agentId, detail: "", attached: false };
  }
  if (orchestrator.kind === "instance") {
    const instance = (instances ?? []).find((candidate) => candidate.id === orchestrator.instanceId);
    return {
      kind: "instance",
      name: instance?.purpose?.name ?? orchestrator.instanceId,
      detail: instance === undefined ? "" : instance.status,
      attached: false
    };
  }
  const client = clients.find((candidate) => candidate.id === orchestrator.clientId);
  const threadAttachments = attachments.filter((attachment) => attachment.threadId === thread.id);
  const attached = threadAttachments.some((attachment) => attachment.status === "attached");
  const lastEnded = threadAttachments
    .filter((attachment) => attachment.status !== "attached")
    .map((attachment) => attachment.detachedAt ?? attachment.lastHeartbeatAt)
    .sort()
    .at(-1);
  const detail = attached
    ? "Attached"
    : lastEnded === undefined ? "Never attached" : `Detached since ${sinceLabel(lastEnded, now)}`;
  return {
    kind: "external",
    name: client?.name ?? `Unknown client ${orchestrator.clientId}`,
    detail,
    attached,
    clientId: orchestrator.clientId
  };
}

/**
 * Names who resolved an approval, so an operator can tell a decision they made themselves from one
 * a model made on their behalf. A resolver kind this build does not know is named as unrecognized
 * rather than silently shown as the operator's own decision.
 */
export function approvalResolverLabel(resolvedBy: ApprovalResolvedBy | undefined, clients: OrchestratorClient[]): string | undefined {
  if (resolvedBy === undefined) return undefined;
  switch (resolvedBy.kind) {
    case "operator":
      return "Resolved by you";
    case "policy":
      return "Resolved by an approval policy";
    case "system":
      return "Resolved by the system";
    case "orchestrator": {
      const client = clients.find((candidate) => candidate.id === resolvedBy.clientId);
      return `Resolved by orchestrator (${client?.name ?? resolvedBy.clientId})`;
    }
    default:
      return "Resolved by an unrecognized party";
  }
}

/** True when a resolution was made by a model rather than by the operator. */
export function isOrchestratorResolution(resolvedBy: ApprovalResolvedBy | undefined): boolean {
  return resolvedBy?.kind === "orchestrator";
}
