import {
  isActiveRunStatus,
  isTerminalInstanceStatus,
  occupyingAllocationStatuses,
  type AgentInstance,
  type ComputeNode,
  type InstanceAllocation,
  type Run,
  type Task
} from "@coffee-shop/protocol";

export type CurrentAllocation =
  | { kind: "current"; allocation: InstanceAllocation }
  | { kind: "unavailable" }
  | { kind: "inconsistent"; allocations: InstanceAllocation[] };

export function currentAllocationFor(instanceId: string, allocations: readonly InstanceAllocation[]): CurrentAllocation {
  const candidates = allocations.filter((allocation) => allocation.instanceId === instanceId
    && occupyingAllocationStatuses.includes(allocation.status));
  if (candidates.length === 0) return { kind: "unavailable" };
  if (candidates.length > 1) return { kind: "inconsistent", allocations: candidates };
  return { kind: "current", allocation: candidates[0] };
}

export function exactCurrentRuns(instanceId: string, current: CurrentAllocation, runs: readonly Run[]) {
  return runs.filter((run) => run.instanceId === instanceId && isActiveRunStatus(run.status)
    && (run.allocationId === undefined || (current.kind === "current" && run.allocationId === current.allocation.id)));
}

export function exactCurrentTasks(instanceId: string, current: CurrentAllocation, tasks: readonly Task[]) {
  return tasks.filter((task) => (task.placementInstanceId === instanceId || task.assignment?.instanceId === instanceId)
    && (task.assignment?.allocationId === undefined || (current.kind === "current" && task.assignment.allocationId === current.allocation.id)));
}

export function allocationHistory(instanceId: string, allocations: readonly InstanceAllocation[]) {
  return allocations.filter((allocation) => allocation.instanceId === instanceId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export type CapacityPresentation =
  | { kind: "unavailable" }
  | { kind: "incapable"; node: ComputeNode }
  | { kind: "unknown"; node: ComputeNode; capacity: number }
  | { kind: "reported"; node: ComputeNode; capacity: number; active: number };

export function capacityFor(current: CurrentAllocation, nodes: readonly ComputeNode[]): CapacityPresentation {
  if (current.kind !== "current") return { kind: "unavailable" };
  const node = nodes.find((candidate) => candidate.id === current.allocation.nodeId);
  if (!node) return { kind: "unavailable" };
  if (node.instanceCapacity === undefined) return { kind: "incapable", node };
  if (node.activeInstances === undefined) return { kind: "unknown", node, capacity: node.instanceCapacity };
  return { kind: "reported", node, capacity: node.instanceCapacity, active: node.activeInstances };
}

export function visibleInstances(instances: readonly AgentInstance[], includeHistory: boolean) {
  return instances.filter((instance) => includeHistory || !isTerminalInstanceStatus(instance.status));
}
