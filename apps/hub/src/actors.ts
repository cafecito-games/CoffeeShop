import {
  threadOrchestrator,
  validateRuntimeActor,
  type AgentInstance,
  type InstanceAllocation,
  type Run,
  type RuntimeActor,
  type Thread
} from "@coffee-shop/protocol";
import { CoordinationError } from "./coordinationError.js";
import { nonTerminalInstanceStatuses } from "./instances.js";
import type { State } from "./store.js";

/*
 * Runtime actors.
 *
 * Two questions about "who did this" have different answers, and conflating them is an
 * authorization escalation. `describeHistoricalActor` answers *who was it* for display, and is
 * allowed to fall back to a legacy configured agent, because history must stay readable. The
 * `authorize*` helpers answer *who may write now*, and accept only a live instance of the record's
 * own thread or an external orchestrator principal. Nothing in this module lets the first answer
 * reach the second: the display helper returns a label, never a principal.
 *
 * A record that names half an instance identity — an instance without its allocation, or the other
 * way round — is malformed, not legacy. It is rejected with the field named rather than degrading to
 * the agent path, so a truncated or hand-edited record can never be read as "no instance".
 */

/** An actor identity carried by a persisted record. */
export type ActorKeyed = { agentId?: string; instanceId?: string; allocationId?: string };

/** The live instance and the exact allocation a record names. */
export interface InstancePrincipal {
  instance: AgentInstance;
  allocation: InstanceAllocation;
}

const malformed = (context: string, field: string) =>
  new CoordinationError("invalid_arguments", `${context} names ${field} without the other half of its instance identity`);

/**
 * The actor a record names, or `undefined` when it names none at all. Throws for a half-written
 * instance identity: a malformed actor is never treated as absent.
 */
export function recordActor(record: ActorKeyed, context: string): RuntimeActor | undefined {
  const { agentId, instanceId, allocationId } = record;
  if (instanceId !== undefined || allocationId !== undefined) {
    if (agentId !== undefined) {
      throw new CoordinationError("invalid_arguments", `${context} names both a configured agent and an instance actor`);
    }
    if (instanceId === undefined) throw malformed(context, "an allocation");
    if (allocationId === undefined) throw malformed(context, "an instance");
    const validated = validateRuntimeActor({ kind: "instance", instanceId, allocationId });
    if (!validated.ok) throw new CoordinationError("invalid_arguments", `${context} has an invalid instance actor: ${validated.reason}`);
    return validated.value;
  }
  if (agentId === undefined) return undefined;
  /*
   * A legacy agent identity is only required to be a non-empty string. Configured agent ids predate
   * the version-5 identifier grammar, so validating them against it would fail the load of a snapshot
   * this hub itself wrote. A version-5 instance actor above is held to the grammar exactly.
   */
  if (agentId.length === 0) throw new CoordinationError("invalid_arguments", `${context} has an empty agent actor`);
  return { kind: "agent", agentId };
}

/**
 * The load-time form of `recordActor`: it throws a plain `Error` naming the offending field, because a
 * persisted record the hub cannot interpret must fail the load rather than be coerced, defaulted, or
 * dropped. `required` is set for records that can never legitimately lack an actor, such as a run or a
 * session binding; an event or a chat message the hub itself authored carries none.
 */
export function assertPersistedActor(record: unknown, context: string, required: boolean) {
  if (typeof record !== "object" || record === null || Array.isArray(record)) throw new Error(`${context} is not an object`);
  const entry = record as ActorKeyed;
  try {
    const actor = recordActor(entry, context);
    if (actor === undefined && required) throw new Error(`${context} is missing its actor identity`);
  } catch (error) {
    throw error instanceof CoordinationError ? new Error(error.message) : error;
  }
}

/** Whether a record is instance-keyed at all, without resolving it. */
export const isInstanceKeyed = (record: ActorKeyed) => record.instanceId !== undefined || record.allocationId !== undefined;

/**
 * The instance and allocation a record names, resolved against committed state. `undefined` for a
 * record that names no instance, for one whose instance or allocation no longer exists, and for one
 * whose allocation belongs to another instance. It says nothing about authority: see
 * `authorizeInstance`.
 */
export function runtimeInstanceForRecord(state: Readonly<State>, record: ActorKeyed, context: string): InstancePrincipal | undefined {
  const actor = recordActor(record, context);
  if (actor === undefined || actor.kind !== "instance") return undefined;
  const instance = (state.instances ?? []).find((item) => item.id === actor.instanceId);
  if (!instance) return undefined;
  const allocation = (state.allocations ?? []).find((item) => item.id === actor.allocationId && item.instanceId === instance.id);
  return allocation === undefined ? undefined : { instance, allocation };
}

/** `runtimeInstanceForRecord` for a run, with the run's identity in the diagnostic. */
export const runtimeInstanceForRun = (state: Readonly<State>, run: Pick<Run, "id" | "agentId" | "instanceId" | "allocationId">) =>
  runtimeInstanceForRecord(state, run, `Run ${run.id}`);

/**
 * The live instance principal a record may act as: its instance still exists and is non-terminal,
 * its allocation is the instance's current active one, and — when `threadId` is given — the instance
 * belongs to that thread. Anything else is not a principal, so the caller refuses the write.
 *
 * This is the only helper an authorization path may use. It has no legacy fallback by construction.
 */
export function authorizeInstance(state: Readonly<State>, record: ActorKeyed, context: string, threadId?: string): InstancePrincipal | undefined {
  const resolved = runtimeInstanceForRecord(state, record, context);
  if (!resolved) return undefined;
  const { instance, allocation } = resolved;
  if (!nonTerminalInstanceStatuses.includes(instance.status)) return undefined;
  if (allocation.status !== "active") return undefined;
  if (threadId !== undefined && instance.threadId !== threadId) return undefined;
  return resolved;
}

/**
 * Whether `actor` is the thread's current orchestrating principal. A legacy agent thread is matched
 * only by the agent it names, and an instance thread only by the exact instance: a replacement
 * instance of the same thread is not the orchestrator until the thread's own record says so.
 */
export function isThreadOrchestratorActor(thread: Pick<Thread, "orchestrator" | "ownerAgentId">, actor: RuntimeActor | undefined): boolean {
  if (actor === undefined) return false;
  const orchestrator = threadOrchestrator(thread);
  if (orchestrator === undefined) return false;
  if (orchestrator.kind === "agent") return actor.kind === "agent" && orchestrator.agentId === actor.agentId;
  if (orchestrator.kind === "instance") return actor.kind === "instance" && orchestrator.instanceId === actor.instanceId;
  return false;
}

/** The orchestrating instance of a thread, when it has one and that instance still exists. */
export function threadOrchestratorInstance(state: Readonly<State>, thread: Pick<Thread, "orchestrator" | "ownerAgentId">) {
  const orchestrator = threadOrchestrator(thread);
  if (orchestrator?.kind !== "instance") return undefined;
  return (state.instances ?? []).find((item) => item.id === orchestrator.instanceId);
}

/**
 * The live orchestrating instance of a thread, as a principal. Used where a write must come from the
 * thread's own orchestrator rather than from any resident of the thread.
 */
export function authorizeThreadInstance(state: Readonly<State>, thread: Thread, actor: RuntimeActor | undefined, context: string): InstancePrincipal | undefined {
  if (!isThreadOrchestratorActor(thread, actor) || actor?.kind !== "instance") return undefined;
  return authorizeInstance(state, { instanceId: actor.instanceId, allocationId: actor.allocationId }, context, thread.id);
}

/** How a record's actor is named to an operator. Display only; never an authorization answer. */
export interface HistoricalActor {
  kind: "instance" | "agent" | "unknown";
  id?: string;
  name: string;
}

/**
 * Names the actor behind a record for presentation. An instance is described first, then a legacy
 * configured agent, then the bare identity the record carries, so mixed history stays readable after
 * an instance is released or an agent is deleted. A malformed identity is named as such rather than
 * reported as no actor.
 */
export function describeHistoricalActor(state: Readonly<State>, record: ActorKeyed): HistoricalActor {
  let actor: RuntimeActor | undefined;
  try {
    actor = recordActor(record, "Record");
  } catch {
    return { kind: "unknown", name: "Malformed actor" };
  }
  if (actor === undefined) return { kind: "unknown", name: "Unattributed" };
  if (actor.kind === "instance") {
    const instance = (state.instances ?? []).find((item) => item.id === actor!.instanceId);
    return { kind: "instance", id: actor.instanceId, name: instance?.purpose?.name ?? actor.instanceId };
  }
  const agent = state.agents.find((item) => item.id === actor!.agentId);
  return { kind: "agent", id: actor.agentId, name: agent?.name ?? actor.agentId };
}
