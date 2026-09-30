import { createHash } from "node:crypto";
import {
  isActiveRunStatus,
  isTerminalRunStatus,
  isTerminalTaskStatus,
  orchestratorContinuationLimits as limits,
  threadOrchestrator,
  type Agent,
  type HarnessSessionBinding,
  type OrchestratorInbox,
  type OrchestratorSessionOutcome,
  type OrchestratorWake,
  type Run,
  type Task,
  type Thread
} from "@coffee-shop/protocol";
import { isThreadOrchestratorActor, recordActor } from "./actors.js";
import {
  acceptInstanceWorkInState,
  appendInstanceDispatchInState,
  currentAllocationInState
} from "./instances.js";
import { placementEnvironmentFor, promoteThreadToInstanceInState } from "./legacyPromotion.js";
import { cancelRunInState } from "./lifecycle.js";
import { decodeTaskEventCursor, resolveCaller, resolveExternalCaller } from "./mailbox.js";
import { continuationPrompts } from "./orchestratorContext.js";
import { dispatchMessageFor, instanceDispatchIsEncodable, instanceRunFor, placeTask, type SchedulingContext } from "./scheduler.js";
import { bindingActorMatches, hasResumeCapability, nodeAdvertisesResume, sessionResumeUnavailableReason } from "./sessionBindings.js";
import { newEvent, type State, type Store } from "./store.js";
import { taskEventsAfter, taskEventStream, type TaskEventEntry } from "./taskEvents.js";

/*
 * Orchestrator wake and delivery.
 *
 * The hub mailbox, not any provider session, owns what a thread's orchestrator still has to
 * handle. Each scheduling pass first reconciles every wake with the durable state of its run, then,
 * for each active thread whose orchestrator has no active run, creates at most one continuation run
 * for the oldest contiguous range of unacknowledged relevant events. An active orchestrator run,
 * including one blocked in `wait_for_task_events`, always takes precedence: events are coalesced
 * for it instead of starting a second orchestrator. Everything here runs inside the scheduling
 * transaction, so a restarted hub reconciles from persisted runs, bindings, and cursors before it
 * creates any work, and an exact retry of a pass converges on the same wake and run identities.
 *
 * Delivery and processing are separate: a wake's range is delivered once its run started (the
 * prompt was handed to the session), and processed only when the orchestrator acknowledges a cursor.
 * An unacknowledged range is redelivered a bounded number of times; failures back off.
 */

export interface ScheduledContinuation {
  threadId: string;
  runId: string;
  nodeId: string;
  /**
   * The resident instance the continuation runs as, when the thread is instance-orchestrated. Its
   * dispatch is already persisted in the instance outbox, so the caller flushes that outbox instead
   * of sending the run.
   */
  instanceId?: string;
  /** Whether the pass recorded a delivery decision; the caller must send exactly these runs. */
  delivered: boolean;
}

export interface ContinuationPassResult {
  changed: boolean;
  continuations: ScheduledContinuation[];
}

/** The actor a record names, or `undefined` for none or a malformed half of one. */
const actorOf = (record: { agentId?: string; instanceId?: string; allocationId?: string; hostHarnessSessionId?: string }) => {
  try {
    return recordActor(record, "Record");
  } catch {
    return undefined;
  }
};

/** Whether a journal entry needs the orchestrator's attention. */
export function isOrchestratorRelevant(state: Readonly<State>, entry: TaskEventEntry) {
  if (entry.kind === "message") return entry.recipientKey === "orchestrator";
  if (entry.changes.includes("status") && isTerminalTaskStatus(entry.status)) return true;
  if (!entry.changes.includes("progress")) return false;
  return Boolean(state.tasks?.find((task) => task.id === entry.taskId)?.progress?.blockedReason);
}

const newInbox = (threadId: string, at: string): OrchestratorInbox => ({
  threadId, deliveredThrough: 0, processedThrough: 0, generation: 0, redeliveries: 0, consecutiveFailures: 0, wakes: [], updatedAt: at
});

export const inboxFor = (state: Readonly<State>, threadId: string) => state.orchestratorInboxes?.find((inbox) => inbox.threadId === threadId);

/**
 * Whether a thread is driven by an operator's own session rather than by a hub-hosted agent run.
 * The orchestrator kind decides it, never the owner agent field: a thread that carries both is
 * still externally orchestrated, and the hub must never start a second orchestrator for it.
 */
export const isExternallyOrchestratedThread = (state: Readonly<State>, threadId: string) => {
  const thread = (state.threads ?? []).find((item) => item.id === threadId);
  return thread !== undefined && threadOrchestrator(thread)?.kind === "external";
};

function ensureInbox(state: State, threadId: string, at: string) {
  state.orchestratorInboxes ??= [];
  let inbox = state.orchestratorInboxes.find((item) => item.threadId === threadId);
  if (!inbox) {
    inbox = newInbox(threadId, at);
    state.orchestratorInboxes.push(inbox);
  }
  return inbox;
}

/**
 * An orchestrator run is a non-task run whose runtime actor is the thread's own orchestrator. The
 * thread's orchestrator record decides it, so an instance-orchestrated thread is recognized exactly
 * as an agent-orchestrated one was, and a worker resident of the same thread never counts.
 */
const isOrchestratorRun = (run: Run, thread: Thread) => {
  const actor = actorOf(run);
  return actor?.kind !== "host-session" && run.threadId === thread.id && run.taskId === undefined
    && isThreadOrchestratorActor(thread, actor);
};

export const activeOrchestratorRun = (state: Readonly<State>, thread: Thread) =>
  state.runs.find((run) => isOrchestratorRun(run, thread) && isActiveRunStatus(run.status));

/** Relevant retained entries the orchestrator has not acknowledged, in sequence order. */
export function pendingOrchestratorEvents(state: Readonly<State>, threadId: string, processedThrough: number) {
  return taskEventsAfter(state, threadId, processedThrough).filter((entry) => isOrchestratorRelevant(state, entry));
}

export function retryDelayMilliseconds(consecutiveFailures: number) {
  const exponent = Math.max(0, Math.min(consecutiveFailures - 1, 20));
  return Math.min(limits.retryMaximumMilliseconds, limits.retryBaseMilliseconds * 2 ** exponent);
}

const wakeDigest = (threadId: string, fromSequence: number, throughSequence: number, generation: number) =>
  createHash("sha256").update(`coffee-shop.orchestrator-wake.v1\u0000${threadId}\u0000${fromSequence}\u0000${throughSequence}\u0000${generation}`).digest("hex").slice(0, 24);

function sessionOutcomeFor(state: Readonly<State>, wake: OrchestratorWake, run: Run): OrchestratorSessionOutcome | undefined {
  if ((run.transportSelection?.selectedTransport ?? run.transport ?? "native-cli") === "native-cli") return "native";
  const binding = (state.sessionBindings ?? []).find((item) => item.lastRunId === run.id);
  if (!binding) return undefined;
  if (binding.id === wake.requestedSessionBindingId) return "resumed";
  return wake.requestedSessionBindingId === undefined ? "new" : "replaced";
}

function trimWakes(inbox: OrchestratorInbox) {
  const settled = (wake: OrchestratorWake) => wake.status === "completed" || wake.status === "failed";
  while (inbox.wakes.length > limits.retainedWakes) {
    const index = inbox.wakes.findIndex(settled);
    if (index < 0) break;
    inbox.wakes.splice(index, 1);
  }
}

/**
 * Brings every open wake in line with its run: a started run delivered its range, a finished run
 * settles its wake, and a continuation that was never dispatched within its claim is cancelled so
 * a later pass can retake the claim with current placement. Idempotent.
 */
export function reconcileOrchestratorInboxes(state: State, at: string) {
  let changed = false;
  for (const inbox of state.orchestratorInboxes ?? []) {
    // An external thread never has a hub-hosted wake to reconcile, and must never acquire one
    // through a resumed binding or a retaken claim.
    if (isExternallyOrchestratedThread(state, inbox.threadId)) continue;
    for (const wake of inbox.wakes) {
      if (wake.status !== "scheduled" && wake.status !== "delivered") continue;
      const run = state.runs.find((item) => item.id === wake.runId);
      if (!run) {
        wake.status = "failed";
        wake.failedAfterDelivery = false;
        delete wake.resumePrompt;
        wake.updatedAt = at;
        inbox.updatedAt = at;
        changed = true;
        continue;
      }
      if (wake.status === "scheduled" && run.status === "queued" && run.dispatchedAt === undefined
        && Date.parse(at) - Date.parse(wake.createdAt) >= limits.undispatchedClaimMilliseconds) {
        cancelRunInState(state, run.id, at);
      }
      if (wake.status === "scheduled" && run.startedAt !== undefined) {
        wake.status = "delivered";
        delete wake.resumePrompt;
        const outcome = sessionOutcomeFor(state, wake, run);
        if (outcome) wake.sessionOutcome = outcome;
        inbox.deliveredThrough = Math.max(inbox.deliveredThrough, wake.throughSequence);
        wake.updatedAt = at;
        inbox.updatedAt = at;
        changed = true;
      }
      if (!isTerminalRunStatus(run.status)) continue;
      delete wake.resumePrompt;
      if (run.status === "completed") {
        wake.status = "completed";
        inbox.consecutiveFailures = 0;
        delete inbox.retryAfter;
      } else if (run.status === "failed" && run.startedAt === undefined && wake.requestedSessionBindingId !== undefined
        && run.error === sessionResumeUnavailableReason) {
        wake.status = "failed";
        wake.failedAfterDelivery = false;
        wake.resumeRefused = true;
      } else {
        wake.status = "failed";
        wake.failedAfterDelivery = run.startedAt !== undefined;
        inbox.consecutiveFailures += 1;
        inbox.retryAfter = new Date(Date.parse(at) + retryDelayMilliseconds(inbox.consecutiveFailures)).toISOString();
      }
      wake.updatedAt = at;
      inbox.updatedAt = at;
      changed = true;
    }
    trimWakes(inbox);
  }
  return changed;
}

/**
 * The placement request for a continuation: the thread's own orchestrator, pinned exactly. An
 * instance-orchestrated thread continues on that one instance — never on a substitute resident, and
 * never on a configured agent.
 */
function continuationTask(thread: Thread, at: string): Task {
  const orchestrator = threadOrchestrator(thread);
  const placementOverride: Task["placementOverride"] = orchestrator?.kind === "instance"
    ? { instanceId: orchestrator.instanceId, authorizedBy: "policy" }
    : { agentId: thread.ownerAgentId, authorizedBy: "policy" };
  return {
    id: `orchestrator-continuation:${thread.id}`,
    threadId: thread.id,
    title: "Orchestrator continuation",
    instructions: "",
    status: "ready",
    requirements: {},
    dependencies: [],
    placementOverride,
    idempotencyKey: "",
    attemptRunIds: [],
    createdAt: at,
    updatedAt: at
  };
}


/**
 * The newest idle binding a continuation may resume: same thread, agent, node, harness, ACP
 * transport, and unleased workspace, negotiated with resume or load, still advertised as resumable
 * by the node, and in use by no active run. Anything else is never moved or reused.
 */
export function resumableOrchestratorBinding(
  state: Readonly<State>,
  thread: Thread,
  run: Pick<Run, "agentId" | "instanceId" | "allocationId" | "nodeId" | "harnessId" | "transport" | "workspace">
) {
  if (run.transport !== "acp-v1") return undefined;
  const node = state.nodes.find((item) => item.id === run.nodeId);
  if (!nodeAdvertisesResume(node, run.harnessId)) return undefined;
  const refused = new Set((inboxFor(state, thread.id)?.wakes ?? []).filter((wake) => wake.resumeRefused).map((wake) => wake.requestedSessionBindingId));
  const inUse = new Set(state.runs.filter((item) => isActiveRunStatus(item.status) && item.sessionBindingId !== undefined).map((item) => item.sessionBindingId!));
  return (state.sessionBindings ?? [])
    .filter((binding: HarnessSessionBinding) => binding.threadId === thread.id && bindingActorMatches(binding, run) && binding.nodeId === run.nodeId
      && binding.harnessId === run.harnessId && binding.transport === "acp-v1" && binding.workspace === run.workspace
      && binding.workspaceLeaseId === undefined && binding.status === "idle" && hasResumeCapability(binding.capabilities) && !inUse.has(binding.id) && !refused.has(binding.id))
    .sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : left.id < right.id ? 1 : -1))[0];
}

/**
 * The range a thread's next continuation would carry, or `undefined` when it needs none. Everything
 * here is independent of who orchestrates the thread — an active orchestrator run, a back-off, an
 * open wake, an empty inbox, and the redelivery budget all gate any orchestrator alike.
 */
interface ContinuationWindow {
  events: TaskEventEntry[];
  processedThrough: number;
  throughSequence: number;
  redelivery: boolean;
}

function continuationWindow(state: Readonly<State>, thread: Thread, at: string): ContinuationWindow | undefined {
  if (activeOrchestratorRun(state, thread)) return undefined;
  const existing = inboxFor(state, thread.id);
  if (existing?.retryAfter !== undefined && Date.parse(at) < Date.parse(existing.retryAfter)) return undefined;
  if (existing?.wakes.some((wake) => wake.status === "scheduled" || wake.status === "delivered")) return undefined;
  const processedThrough = existing?.processedThrough ?? 0;
  const deliveredThrough = existing?.deliveredThrough ?? 0;
  const pending = pendingOrchestratorEvents(state, thread.id, processedThrough);
  if (!pending.length) return undefined;
  const events = pending.slice(0, limits.eventsPerWake);
  const redelivery = events.every((entry) => entry.sequence <= deliveredThrough);
  if (redelivery && (existing?.redeliveries ?? 0) >= limits.maximumRedeliveries) return undefined;
  const throughSequence = pending.length > events.length ? events.at(-1)!.sequence : taskEventStream(state, thread.id).head;
  return { events, processedThrough, throughSequence, redelivery };
}

/**
 * The continuation of an agent-orchestrated thread, on the compatibility path. It is reached only
 * while the thread still names a configured agent; a promoted thread continues through
 * `planInstanceContinuation` instead.
 */
function planAgentContinuation(state: State, thread: Thread, owner: Agent, window: ContinuationWindow, context: SchedulingContext, at: string): ScheduledContinuation | undefined {
  const { events, processedThrough, throughSequence, redelivery } = window;
  const decision = placeTask(continuationTask(thread, at), placementEnvironmentFor(state, context, at));
  if (decision.kind !== "assigned") return undefined;
  const { candidate } = decision;

  const inbox = ensureInbox(state, thread.id, at);
  const generation = inbox.generation + 1;
  const digest = wakeDigest(thread.id, processedThrough, throughSequence, generation);
  const runId = `run_wake_${digest}`;
  if (state.runs.some((run) => run.id === runId)) return undefined;
  const binding = resumableOrchestratorBinding(state, thread, candidate);
  const wakeId = `wake_${digest}`;
  const prompts = continuationPrompts(state, thread, { wakeId, generation, fromSequence: processedThrough, throughSequence, events, redelivery });
  const run: Run = {
    id: runId,
    threadId: thread.id,
    agentId: owner.id,
    nodeId: candidate.nodeId,
    harnessId: candidate.harnessId,
    model: candidate.model,
    workspace: candidate.workspace,
    prompt: prompts.prompt,
    status: "queued",
    output: "",
    depth: 0,
    createdAt: at,
    transport: candidate.transport,
    ...(candidate.fallbackTransport ? { fallbackTransport: candidate.fallbackTransport } : {}),
    ...(binding ? { sessionBindingId: binding.id } : {})
  };
  state.runs.unshift(run);
  inbox.wakes.push({
    id: wakeId,
    generation,
    runId,
    fromSequence: processedThrough,
    throughSequence,
    eventSequences: events.map((entry) => entry.sequence),
    redelivery,
    ...(binding ? { requestedSessionBindingId: binding.id, resumePrompt: prompts.resumePrompt } : {}),
    status: "scheduled",
    createdAt: at,
    updatedAt: at
  });
  inbox.generation = generation;
  inbox.redeliveries = redelivery ? inbox.redeliveries + 1 : 0;
  inbox.updatedAt = at;
  trimWakes(inbox);

  const delivered = context.canDeliver(run.nodeId, dispatchMessageFor(run, owner, state.agents, state.workspaceLeases, state));
  if (delivered) run.dispatchedAt = at;
  owner.state = delivered ? "thinking" : "waiting";
  owner.currentAction = delivered ? "Reading its inbox" : "Waiting for compute";
  owner.updatedAt = at;
  thread.updatedAt = at;
  state.events.unshift(newEvent({
    type: "run",
    title: `${owner.name} was woken for ${events.length} inbox ${events.length === 1 ? "event" : "events"}`,
    detail: binding ? "Resuming its previous session" : "Starting a session with the thread's durable context",
    threadId: thread.id,
    agentId: owner.id,
    runId
  }));
  return { threadId: thread.id, runId, nodeId: run.nodeId, delivered };
}

/**
 * The continuation of an instance-orchestrated thread. The thread's own orchestrating instance is
 * pinned exactly, so the continuation is never substituted onto another resident, and the wake and
 * its run keep the same deterministic identities the agent path uses.
 *
 * It never asks to resume a provider session. A version-5 dispatch carries no session-binding grant
 * for Barista to honour — Barista rejects a v5 run that names one
 * (`apps/control-agent/internal/controlplane/instances.go` `instanceDispatchRun`) — so every instance
 * continuation starts a session with the thread's bounded durable context, which the continuation
 * prompt always carries. Closing that gap needs a control-agent protocol change, not a hub change.
 */
function planInstanceContinuation(state: State, thread: Thread, window: ContinuationWindow, context: SchedulingContext, at: string): ScheduledContinuation | undefined {
  const { events, processedThrough, throughSequence, redelivery } = window;
  const decision = placeTask(continuationTask(thread, at), placementEnvironmentFor(state, context, at));
  // `waiting` is a provisioning instance: the wake is planned by a later pass, once it is ready.
  if (decision.kind !== "instance") return undefined;

  const inbox = ensureInbox(state, thread.id, at);
  const generation = inbox.generation + 1;
  const digest = wakeDigest(thread.id, processedThrough, throughSequence, generation);
  const runId = `run_wake_${digest}`;
  if (state.runs.some((run) => run.id === runId)) return undefined;
  const wakeId = `wake_${digest}`;
  const prompts = continuationPrompts(state, thread, { wakeId, generation, fromSequence: processedThrough, throughSequence, events, redelivery });

  const current = currentAllocationInState(state, decision.instanceId);
  if (!current || current.status !== "active") return undefined;
  const run: Run = {
    id: runId,
    threadId: thread.id,
    instanceId: decision.instanceId,
    allocationId: current.id,
    nodeId: current.nodeId,
    harnessId: current.harnessId,
    model: current.model,
    workspace: current.workspace,
    prompt: prompts.prompt,
    status: "queued",
    output: "",
    depth: 0,
    createdAt: at,
    transport: current.transport
  };
  /*
   * The command is validated before anything is committed, so a wake this hub could not encode never
   * leaves a queued run and an open wake behind for a resident that will never be dispatched to.
   */
  if (!instanceDispatchIsEncodable(state, run).ok) return undefined;
  const accepted = acceptInstanceWorkInState(state, decision.instanceId, at);
  if (!accepted || accepted.allocation.id !== current.id) return undefined;
  const appended = appendInstanceDispatchInState(state, instanceRunFor(run), at);
  if (!appended.ok) return undefined;

  state.runs.unshift(run);
  inbox.wakes.push({
    id: wakeId,
    generation,
    runId,
    fromSequence: processedThrough,
    throughSequence,
    eventSequences: events.map((entry) => entry.sequence),
    redelivery,
    status: "scheduled",
    createdAt: at,
    updatedAt: at
  });
  inbox.generation = generation;
  inbox.redeliveries = redelivery ? inbox.redeliveries + 1 : 0;
  inbox.updatedAt = at;
  trimWakes(inbox);
  thread.updatedAt = at;
  const name = accepted.instance.purpose?.name ?? accepted.instance.id;
  state.events.unshift(newEvent({
    type: "run",
    title: `${name} was woken for ${events.length} inbox ${events.length === 1 ? "event" : "events"}`,
    detail: "Starting a session with the thread's durable context",
    threadId: thread.id,
    instanceId: accepted.instance.id,
    allocationId: accepted.allocation.id,
    runId
  }));
  // The dispatch is a persisted command in the instance outbox; the caller flushes it, never a socket.
  return { threadId: thread.id, runId, nodeId: run.nodeId, instanceId: accepted.instance.id, delivered: false };
}

/**
 * Reconciles wakes and creates at most one continuation per eligible thread, inside the scheduling
 * transaction. Placement uses the scheduler's own evaluation for the thread owner, so connectivity,
 * the reconnect barrier, protocol version, harness, transport, workspace, and capacity all apply.
 * An externally orchestrated thread is skipped entirely: its orchestrator is an operator's own
 * session, which the hub rings instead of replacing.
 */
export function runContinuationPass(state: State, context: SchedulingContext, at: string): ContinuationPassResult {
  let changed = reconcileOrchestratorInboxes(state, at);
  const continuations: ScheduledContinuation[] = [];
  for (const thread of state.threads ?? []) {
    if (thread.status !== "active") continue;
    const orchestrator = threadOrchestrator(thread);
    if (orchestrator === undefined || orchestrator.kind === "external" || orchestrator.kind === "host-session") continue;
    const window = continuationWindow(state, thread, at);
    if (!window) continue;
    if (orchestrator.kind === "instance") {
      const continuation = planInstanceContinuation(state, thread, window, context, at);
      if (continuation) {
        continuations.push(continuation);
        changed = true;
      }
      continue;
    }
    /*
     * A thread that still names a configured agent continues on it, exactly as it always did.
     *
     * Promotion is reached only when that agent is no longer configured at all — the one condition
     * that is permanent and cannot heal on its own. A *placement* failure must never promote: an
     * offline node, an unfinished reconnect barrier, stale capability evidence, or a harness not yet
     * re-reported all make the owner temporarily unplaceable, and promoting on any of them would
     * irreversibly take the thread away from a healthy agent seconds before it came back, closing its
     * live ACP sessions on the way. Such a thread simply waits for the next pass, which is what the
     * hub did before instances existed.
     */
    const owner = state.agents.find((agent) => agent.id === orchestrator.agentId);
    if (owner) {
      const continuation = planAgentContinuation(state, thread, owner, window, context, at);
      if (continuation) {
        continuations.push(continuation);
        changed = true;
      }
      continue;
    }
    // Promotion writes nothing when the template is missing, so an ambiguous migration leaves the
    // thread and its history untouched and surfaces through the import refusal instead.
    const promotion = promoteThreadToInstanceInState(state, thread.id, context, at);
    if (promotion.kind === "promoted") changed = true;
  }
  return { changed, continuations };
}

/**
 * What an orchestrator run's `wait_for_task_events` call proves: the cursor it passes acknowledges
 * every sequence up to it, and the page it receives delivers every sequence up to the returned
 * cursor. Returns the advance to apply, or undefined when nothing would change. Calls by any other
 * caller, and cursors that do not decode for this caller, prove nothing; the wait itself reports
 * those errors.
 */
function cursorAdvance(state: Readonly<State>, sourceRunId: string, cursor: unknown, kind: "processed" | "delivered") {
  if (typeof cursor !== "string" || !cursor) return undefined;
  try {
    const caller = resolveCaller(state, sourceRunId);
    if (caller.participant?.type !== "orchestrator") return undefined;
    const sequence = decodeTaskEventCursor(state, caller, cursor);
    const current = inboxFor(state, caller.thread.id);
    const through = kind === "processed" ? current?.processedThrough ?? 0 : current?.deliveredThrough ?? 0;
    return sequence > through ? { threadId: caller.thread.id, sequence } : undefined;
  } catch {
    return undefined;
  }
}

export function recordOrchestratorCursor(state: State, sourceRunId: string, cursor: unknown, kind: "processed" | "delivered", at: string) {
  const advance = cursorAdvance(state, sourceRunId, cursor, kind);
  return advance !== undefined && recordOrchestratorCursorForThread(state, advance.threadId, advance.sequence, kind, at);
}

/**
 * Advances a thread's orchestrator inbox to a sequence the caller has already proved it may
 * acknowledge. It is the thread-keyed half of `recordOrchestratorCursor`, for an orchestrator that
 * is not a run: the inbox belongs to the thread, so it outlives connections and attachments.
 */
export function recordOrchestratorCursorForThread(state: State, threadId: string, sequence: number, kind: "processed" | "delivered", at: string) {
  const current = inboxFor(state, threadId);
  if (sequence <= (kind === "processed" ? current?.processedThrough ?? 0 : current?.deliveredThrough ?? 0)) return false;
  const inbox = ensureInbox(state, threadId, at);
  if (kind === "processed") {
    inbox.processedThrough = sequence;
    inbox.redeliveries = 0;
  }
  inbox.deliveredThrough = Math.max(inbox.deliveredThrough, sequence);
  inbox.updatedAt = at;
  return true;
}

/**
 * Records an external orchestrator's acknowledgement. The attachment and the cursor are both
 * re-checked inside the transaction that advances the inbox, so a cursor that stopped being valid —
 * or an attachment that was replaced — cannot move a thread's acknowledged position.
 */
export async function persistExternalOrchestratorCursor(
  store: Store,
  connectionId: string,
  threadId: string,
  cursor: string,
  kind: "processed" | "delivered",
  at = new Date().toISOString()
) {
  let changed = false;
  await store.transact((state) => {
    const caller = resolveExternalCaller(state, connectionId, threadId);
    const sequence = decodeTaskEventCursor(state, caller, cursor);
    changed = recordOrchestratorCursorForThread(state, caller.thread.id, sequence, kind, at);
    return changed;
  });
  return changed;
}

/** Whether `recordOrchestratorCursor` would change the inbox; synchronous and read-only. */
export const orchestratorCursorAdvances = (state: Readonly<State>, sourceRunId: string, cursor: unknown, kind: "processed" | "delivered") =>
  cursorAdvance(state, sourceRunId, cursor, kind) !== undefined;

/** Persists `recordOrchestratorCursor`, opening a transaction only when it would change the inbox. */
export async function persistOrchestratorCursor(store: Store, sourceRunId: string, cursor: unknown, kind: "processed" | "delivered") {
  if (typeof cursor !== "string" || !store.read((state) => orchestratorCursorAdvances(state, sourceRunId, cursor, kind))) return false;
  let changed = false;
  await store.transact((state) => {
    changed = recordOrchestratorCursor(state, sourceRunId, cursor, kind, new Date().toISOString());
    return changed;
  });
  return changed;
}
