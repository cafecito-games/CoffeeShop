import {
  isHarnessTransport,
  orchestrationToolLimits as limits,
  resolveNodeCapability,
  supportsControlCapability,
  type HarnessId,
  type HarnessTransport,
  type NodeCapabilityReport,
  type ResolvedNodeCapabilityState
} from "@coffee-shop/protocol";
import { CoordinationError } from "./coordinationError.js";
import { nodeResidencyInState, residentInstanceUsage, terminalInstanceStatuses } from "./instances.js";
import { callerAgent, callerCanDelegate, resolveCallerFor, runSource, type CallerSource } from "./mailbox.js";
import { defaultEvidenceTTLMilliseconds } from "./projectReadiness.js";
import { nodeOfferings, nodeUsage, offersInstances, type NodeConnection } from "./scheduler.js";
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

/** One schedulable offering, exactly as the scheduler derives it; no workspace path is published. */
export interface InventoryOffering {
  nodeId: string;
  harnessId: HarnessId;
  model: string;
  transport: HarnessTransport;
  fallbackTransport?: HarnessTransport;
}

/** One nonterminal resident instance, without its purpose instructions or workspace. */
export interface InventoryInstance {
  id: string;
  threadId: string;
  status: string;
  name?: string;
  nodeId?: string;
  harnessId?: HarnessId;
  model?: string;
  transport?: HarnessTransport;
  allocationStatus?: string;
}

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * The scheduler-relevant view of the fleet for an orchestrator. It carries the live offerings the
 * scheduler places against, the thread's resident instances, both capacity dimensions — run
 * concurrency and resident-instance capacity, which are enforced independently — harness
 * availability, connection readiness, and resolved worker-reported capabilities with their
 * freshness. Configured agents are still listed as a compatibility projection, marked as such, but
 * they are no longer the candidate set: `offerings` is. It never carries system prompts, workspace
 * paths, purpose instructions, binary locations, raw evidence, or diagnostics. Every collection is
 * bounded and reports truncation.
 */
export const executionInventory = (state: Readonly<State>, sourceRunId: string, argumentsValue: unknown, environment: InventoryEnvironment) =>
  executionInventoryForSource(state, runSource(sourceRunId), argumentsValue, environment);

/** `get_execution_inventory` for either principal; an external orchestrator is never one of the agents. */
export function executionInventoryForSource(state: Readonly<State>, source: CallerSource, argumentsValue: unknown, environment: InventoryEnvironment) {
  if (typeof argumentsValue !== "object" || argumentsValue === null || Array.isArray(argumentsValue) || Object.keys(argumentsValue).length) {
    throw new CoordinationError("invalid_arguments", "get_execution_inventory takes no arguments");
  }
  const caller = resolveCallerFor(state, source);
  if (!callerCanDelegate(caller)) throw new CoordinationError("forbidden", "This agent is not allowed to inspect execution inventory");
  const callingAgentId = callerAgent(caller)?.id;
  const ttl = environment.evidenceTTLMilliseconds ?? defaultEvidenceTTLMilliseconds;
  const agents = [...state.agents].sort((left, right) => compareText(left.id, right.id));
  const nodes = [...state.nodes].sort((left, right) => compareText(left.id, right.id));
  const allocations = state.allocations ?? [];
  // Instances are thread-scoped resources, so a caller sees only its own thread's residents.
  const threadId = caller.thread.id;
  const instances = (state.instances ?? [])
    .filter((instance) => !terminalInstanceStatuses.includes(instance.status) && (threadId === undefined || instance.threadId === threadId))
    .sort((left, right) => compareText(left.id, right.id));
  const offerings = nodes.filter(offersInstances).flatMap((node) => nodeOfferings(node).map((offering): InventoryOffering => ({
    nodeId: offering.nodeId,
    harnessId: offering.harnessId,
    model: offering.model,
    transport: offering.transport,
    ...(offering.fallbackTransport ? { fallbackTransport: offering.fallbackTransport } : {})
  })));
  return {
    generatedAt: environment.now,
    offerings: offerings.slice(0, limits.inventoryNodes * limits.inventoryModelsPerHarness),
    instances: instances.slice(0, limits.inventoryAgents).map((instance): InventoryInstance => {
      const allocation = allocations.find((item) => item.instanceId === instance.id
        && (item.status === "reserved" || item.status === "provisioning" || item.status === "active"));
      return {
        id: instance.id,
        threadId: instance.threadId,
        status: instance.status,
        ...(instance.purpose?.name === undefined ? {} : { name: instance.purpose.name }),
        ...(allocation === undefined ? {} : {
          nodeId: allocation.nodeId,
          harnessId: allocation.harnessId,
          model: allocation.model,
          transport: allocation.transport,
          allocationStatus: allocation.status
        })
      };
    }),
    agents: agents.slice(0, limits.inventoryAgents).map((agent) => ({
      id: agent.id,
      name: agent.name,
      title: agent.title,
      self: agent.id === callingAgentId,
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
      const resident = residentInstanceUsage(node, allocations, nodeResidencyInState(state, node.id));
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
        /** Resident-instance capacity, independent of run concurrency; zero means incapable. */
        instanceCapacity: resident.capacity,
        residentSlotsInUse: resident.used,
        offersInstances: offersInstances(node),
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
    truncated: {
      agents: agents.length > limits.inventoryAgents,
      nodes: nodes.length > limits.inventoryNodes,
      instances: instances.length > limits.inventoryAgents,
      offerings: offerings.length > limits.inventoryNodes * limits.inventoryModelsPerHarness
    }
  };
}
