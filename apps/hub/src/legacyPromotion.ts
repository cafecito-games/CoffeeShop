import {
  canTransitionSessionBinding,
  isActiveRunStatus,
  isTerminalSessionBindingStatus,
  threadOrchestrator,
  type AgentInstance,
  type InstanceAllocation,
  type Task,
  type Thread
} from "@coffee-shop/protocol";
import { templateForLegacyAgent } from "./agentTemplates.js";
import { nodeResidencyInState, operatorInstanceCreator, placeInstanceInState, residentInstanceUsage } from "./instances.js";
import { defaultEvidenceTTLMilliseconds } from "./projectReadiness.js";
import { placeTask, requirementsThroughTemplate, type PlacementEnvironment, type SchedulingContext } from "./scheduler.js";
import { newEvent, type State } from "./store.js";

/*
 * Legacy thread promotion.
 *
 * An agent-orchestrated thread keeps its history and its in-flight legacy run exactly as they are.
 * When it next needs a hub-hosted orchestrator and its configured agent can no longer serve one, the
 * thread promotes: one instance is requested from the template that agent was imported to, an
 * allocation is reserved for it, the thread's orchestrator becomes that instance, and every session
 * binding the legacy agent left behind is closed so nothing can be resumed across the boundary.
 *
 * All of that is one mutation of the caller's transaction. The instance request and its reservation
 * go through the scheduler's own single-transaction path (`placeInstanceInState`), so a replayed
 * promotion can neither create a second resident nor overbook a node. The marker that makes it
 * happen at most once is the thread's *current orchestrator*, never a timestamp: a thread already
 * naming an instance is refused as ineligible, which is exactly what a restart finds.
 *
 * A refusal writes nothing at all: no instance, no allocation, no orchestrator change, and no closed
 * binding. History is never rewritten, and no authority is invented for a thread whose legacy agent
 * had no representable template.
 */

export type ThreadPromotion =
  | { kind: "promoted"; instance: AgentInstance; allocation: InstanceAllocation }
  /** Nothing was written. `reason` is the operator-facing explanation. */
  | { kind: "not-eligible"; reason: string };

const ineligible = (reason: string): ThreadPromotion => ({ kind: "not-eligible", reason });

/** Whether any legacy agent-keyed run of the thread is still active. */
export const hasActiveLegacyRun = (state: Readonly<State>, threadId: string) =>
  state.runs.some((run) => run.threadId === threadId && run.instanceId === undefined && isActiveRunStatus(run.status));

/** The probe the reservation is placed against: the imported template, and nothing else. */
const promotionProbe = (thread: Thread, templateId: string, at: string): Task => ({
  id: `orchestrator-promotion:${thread.id}`,
  threadId: thread.id,
  title: "Orchestrator promotion",
  instructions: "",
  status: "ready",
  requirements: { templateId },
  dependencies: [],
  idempotencyKey: "",
  attemptRunIds: [],
  createdAt: at,
  updatedAt: at
});

export function placementEnvironmentFor(state: Readonly<State>, context: SchedulingContext, at: string): PlacementEnvironment {
  return {
    agents: state.agents,
    nodes: state.nodes,
    runs: state.runs,
    connection: context.connection,
    capabilityReport: context.capabilityReport,
    capabilityPackReadiness: context.capabilityPackReadiness,
    projectProfile: context.projectProfile,
    workspaceLeases: state.workspaceLeases,
    instances: state.instances,
    allocations: state.allocations,
    templates: state.templates,
    residentUsage: (node) => residentInstanceUsage(node, state.allocations ?? [], nodeResidencyInState(state, node.id)),
    evidenceTTLMilliseconds: context.evidenceTTLMilliseconds ?? defaultEvidenceTTLMilliseconds,
    now: at
  };
}

/**
 * Promotes one agent-orchestrated thread to an instance orchestrator, or explains why it cannot.
 * Called inside the caller's transaction; a `not-eligible` answer has written nothing.
 */
export function promoteThreadToInstanceInState(state: State, threadId: string, context: SchedulingContext, at: string): ThreadPromotion {
  const thread = (state.threads ?? []).find((item) => item.id === threadId);
  if (!thread) return ineligible("the thread does not exist");
  if (thread.status !== "active") return ineligible("promotion requires an active thread");
  const orchestrator = threadOrchestrator(thread);
  if (orchestrator === undefined) return ineligible("the thread names no orchestrator to promote");
  // The deterministic marker: a thread that already names an instance has been promoted exactly once.
  if (orchestrator.kind === "instance") return ineligible("the thread is already orchestrated by an instance");
  if (orchestrator.kind === "external") return ineligible("an externally orchestrated thread has no hub-hosted orchestrator");
  if (orchestrator.kind === "host-session") return ineligible("a host-session thread is not a legacy agent promotion candidate");
  if (hasActiveLegacyRun(state, thread.id)) return ineligible("an active legacy run must finish through its original path first");
  const template = templateForLegacyAgent(state, orchestrator.agentId);
  if (!template) return ineligible(`agent ${orchestrator.agentId} has no imported template, so no authority can be created for it`);

  const requirements = requirementsThroughTemplate({ templateId: template.id }, template);
  const decision = placeTask(promotionProbe(thread, template.id, at), placementEnvironmentFor(state, context, at));
  if (decision.kind !== "offering") {
    return ineligible(`no live offering can host an instance for template ${template.id}`);
  }
  const { offering } = decision;
  const placement = placeInstanceInState(state, {
    threadId: thread.id,
    requirements,
    ...(template.purpose ? { purpose: template.purpose } : {}),
    ...(template.delegation ? { delegation: { ...template.delegation } } : {}),
    creator: operatorInstanceCreator
  }, {
    nodeId: offering.nodeId,
    harnessId: offering.harnessId,
    model: offering.model,
    transport: offering.transport,
    workspace: offering.workspace,
    ...(offering.expectedCapabilityPack === undefined ? {} : { expectedCapabilityPack: offering.expectedCapabilityPack })
  }, at);
  if (placement.kind !== "placed") return ineligible(placement.reason);

  const previousAgentId = orchestrator.agentId;
  thread.orchestrator = { kind: "instance", instanceId: placement.instance.id };
  /*
   * The legacy owner field is removed, not kept beside the new orchestrator: a reader that still
   * consulted it directly would keep granting the old agent owner authority on a thread it no longer
   * orchestrates. The load assertion refuses that combination for the same reason.
   */
  delete thread.ownerAgentId;
  thread.updatedAt = at;
  closeLegacySessionBindings(state, thread.id, at);
  state.events.unshift(newEvent({
    type: "status",
    title: "Thread orchestrator promoted",
    detail: `${previousAgentId} → instance ${placement.instance.id} from template ${template.id}`,
    threadId: thread.id,
    instanceId: placement.instance.id,
    allocationId: placement.allocation.id
  }));
  return { kind: "promoted", instance: placement.instance, allocation: placement.allocation };
}

/**
 * Closes every live session binding the thread's legacy agent left behind. A provider session created
 * for a configured agent lives in a process the new allocation does not own, so it can never be
 * resumed across the boundary; closing it is what stops a later continuation from selecting it.
 */
export function closeLegacySessionBindings(state: State, threadId: string, at: string) {
  let closed = 0;
  for (const binding of state.sessionBindings ?? []) {
    if (binding.threadId !== threadId || binding.agentId === undefined) continue;
    if (isTerminalSessionBindingStatus(binding.status)) continue;
    if (!canTransitionSessionBinding(binding.status, "closed")) continue;
    binding.status = "closed";
    binding.updatedAt = at;
    closed += 1;
  }
  return closed;
}
