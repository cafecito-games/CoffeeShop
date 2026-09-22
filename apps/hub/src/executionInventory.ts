import {
  isHarnessTransport,
  orchestrationToolLimits as limits,
  resolveNodeCapability,
  supportsControlCapability,
  type NodeCapabilityReport,
  type ResolvedNodeCapabilityState
} from "@coffee-shop/protocol";
import { CoordinationError } from "./coordinationError.js";
import { resolveCaller } from "./mailbox.js";
import { defaultEvidenceTTLMilliseconds } from "./projectReadiness.js";
import { nodeUsage, type NodeConnection } from "./scheduler.js";
import type { State } from "./store.js";

export interface InventoryEnvironment {
  connection(nodeId: string): NodeConnection | undefined;
  capabilityReport(nodeId: string): NodeCapabilityReport | undefined;
  now: string;
  evidenceTTLMilliseconds?: number;
}

export interface InventoryCapability {
  capabilityId: string;
  state: ResolvedNodeCapabilityState;
  value?: string;
}

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * The scheduler-relevant view of configured agents and compute nodes for an orchestrator. It
 * carries identities, skills, harness availability, capacity, connection readiness, and resolved
 * worker-reported capabilities with their freshness; it never carries system prompts, workspace
 * paths, binary locations, raw evidence, or diagnostics. Every collection is bounded and reports
 * truncation.
 */
export function executionInventory(state: Readonly<State>, sourceRunId: string, argumentsValue: unknown, environment: InventoryEnvironment) {
  if (typeof argumentsValue !== "object" || argumentsValue === null || Array.isArray(argumentsValue) || Object.keys(argumentsValue).length) {
    throw new CoordinationError("invalid_arguments", "get_execution_inventory takes no arguments");
  }
  const caller = resolveCaller(state, sourceRunId);
  if (!caller.agent.canDelegate) throw new CoordinationError("forbidden", "This agent is not allowed to inspect execution inventory");
  const ttl = environment.evidenceTTLMilliseconds ?? defaultEvidenceTTLMilliseconds;
  const agents = [...state.agents].sort((left, right) => compareText(left.id, right.id));
  const nodes = [...state.nodes].sort((left, right) => compareText(left.id, right.id));
  return {
    generatedAt: environment.now,
    agents: agents.slice(0, limits.inventoryAgents).map((agent) => ({
      id: agent.id,
      name: agent.name,
      title: agent.title,
      self: agent.id === caller.agent.id,
      skills: [...(agent.skills ?? [])],
      harnessId: agent.harnessId,
      model: agent.model,
      nodeId: agent.computeNodeId,
      state: agent.state,
      activeTaskAttempt: state.runs.some((run) => run.agentId === agent.id && run.taskId !== undefined && (run.status === "queued" || run.status === "running"))
    })),
    nodes: nodes.slice(0, limits.inventoryNodes).map((node) => {
      const connection = environment.connection(node.id);
      const usage = nodeUsage(node, state.runs);
      const report = environment.capabilityReport(node.id);
      const capabilityIds = [...new Set((report?.evidence ?? []).map((entry) => entry.capabilityId))].sort(compareText);
      return {
        id: node.id,
        name: node.name,
        kind: node.kind,
        status: node.status,
        connected: connection !== undefined,
        acceptsTasks: connection !== undefined && connection.synced && supportsControlCapability(connection.protocolVersion, "orchestration"),
        concurrency: usage.concurrency,
        slotsInUse: usage.used,
        harnesses: node.harnesses.map((harness) => ({
          id: harness.id,
          available: harness.available,
          models: harness.models.slice(0, limits.inventoryModelsPerHarness),
          transports: (harness.transports ?? ["native-cli"]).filter(isHarnessTransport)
        })),
        capabilities: capabilityIds.slice(0, limits.inventoryCapabilitiesPerNode).map((capabilityId): InventoryCapability => {
          const resolved = resolveNodeCapability(report!.evidence, capabilityId, environment.now, ttl);
          return { capabilityId, state: resolved.state, ...(resolved.state === "ok" && resolved.value ? { value: resolved.value } : {}) };
        }),
        capabilitiesTruncated: capabilityIds.length > limits.inventoryCapabilitiesPerNode,
        ...(report ? { capabilitiesReportedAt: report.at } : {})
      };
    }),
    truncated: { agents: agents.length > limits.inventoryAgents, nodes: nodes.length > limits.inventoryNodes }
  };
}
