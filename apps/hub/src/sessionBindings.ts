import {
  canTransitionSessionBinding,
  containsSecretLikeValue,
  isTerminalSessionBindingStatus,
  type AcpAgentCapabilities,
  type ComputeNode,
  type DispatchExecution,
  type HarnessSessionBinding,
  type HarnessSessionBindingUpdate,
  type OrchestratorInbox,
  type Run
} from "@coffee-shop/protocol";
import { wakeForRun } from "./continuationRuns.js";
import { newEvent, newId, runAttribution, type State, type Store } from "./store.js";

/*
 * Harness session bindings.
 *
 * A binding records that an opaque provider session was created for one run's agent, node,
 * harness, transport, workspace (a lease's worktree for a leased run), and thread. Barista reports
 * a session exactly once per run, after the session exists and before its prompt; the hub alone
 * assigns binding identity, lineage, and lifecycle. A binding never moves: a continuation may ask
 * to resume one only on the same node, agent, harness, transport, workspace, and thread, and
 * anything else starts a new session whose binding replaces it. Provider session history is never
 * authoritative for Coffee Shop state.
 */

export type SessionBindingOutcome =
  | { kind: "created"; binding: HarnessSessionBinding; replacedBindingId?: string }
  | { kind: "resumed"; binding: HarnessSessionBinding }
  | { kind: "duplicate" }
  | { kind: "rejected"; reason: string };

export const hasResumeCapability = (capabilities: AcpAgentCapabilities | undefined) =>
  capabilities !== undefined && (capabilities.resumeSession || capabilities.loadSession);

/** Whether the node's current registered inventory advertises resume or load for the harness. */
export const nodeAdvertisesResume = (node: ComputeNode | undefined, harnessId: string) =>
  hasResumeCapability(node?.harnesses.find((harness) => harness.id === harnessId && harness.available)?.acp);

/**
 * The exact dispatch rejection Barista sends when its adapter did not negotiate resume or load;
 * mirrored by Barista's `protocol.SessionResumeUnavailableReason`.
 */
export const sessionResumeUnavailableReason = "unsupported execution: session resume not available for this harness on this Barista";

/** Only a thread owner's non-task run can be continued later; every other session ends with its run. */
const isContinuable = (state: Readonly<State>, run: Run) =>
  run.taskId === undefined && state.threads?.some((thread) => thread.id === run.threadId && thread.ownerAgentId === run.agentId) === true;

const sameContext = (left: HarnessSessionBinding, right: HarnessSessionBinding) =>
  left.threadId === right.threadId && left.agentId === right.agentId && left.nodeId === right.nodeId && left.harnessId === right.harnessId
  && left.transport === right.transport && left.workspace === right.workspace && left.workspaceLeaseId === right.workspaceLeaseId;

/** Whether a binding belongs to exactly the execution context of `run`. */
export function bindingMatchesRun(binding: HarnessSessionBinding, run: Run) {
  return binding.threadId === run.threadId
    && binding.agentId === run.agentId
    && binding.nodeId === run.nodeId
    && binding.harnessId === run.harnessId
    && binding.transport === (run.transport ?? "native-cli")
    && binding.workspace === run.workspace
    && binding.workspaceLeaseId === run.workspaceLeaseId;
}

/**
 * Whether `run` may ask Barista to resume `binding`: an ACP run in the binding's own context, a
 * binding whose recorded capabilities negotiated resume or load, and a session that is either idle
 * or already bound to this very run (a redispatch before the run started).
 */
export function isResumableFor(binding: HarnessSessionBinding, run: Run) {
  return run.transport === "acp-v1"
    && bindingMatchesRun(binding, run)
    && hasResumeCapability(binding.capabilities)
    && (binding.status === "idle" || (binding.status === "active" && binding.lastRunId === run.id));
}

export interface SessionDispatchSource {
  /** The nodes' current registered inventory; a binding is resumed only while its node advertises resume or load. */
  nodes?: readonly ComputeNode[];
  sessionBindings?: readonly HarnessSessionBinding[];
  orchestratorInboxes?: readonly OrchestratorInbox[];
}

/**
 * The run and session-binding execution a dispatch carries. A run naming a binding that can no
 * longer be resumed is dispatched without it, so Barista starts a new session with the run prompt,
 * which always carries the bounded durable context; the new session's report then records the
 * replacement. A resumable binding carries the delivery-only prompt of its wake, when it has one.
 */
export function sessionDispatchFor(run: Run, source: SessionDispatchSource): { run: Run; sessionBinding?: DispatchExecution["sessionBinding"] } {
  if (run.sessionBindingId === undefined) return { run };
  const binding = source.sessionBindings?.find((item) => item.id === run.sessionBindingId);
  const node = source.nodes?.find((item) => item.id === run.nodeId);
  if (!binding || !isResumableFor(binding, run) || !nodeAdvertisesResume(node, run.harnessId)) {
    const { sessionBindingId: _omitted, ...withoutBinding } = run;
    return { run: withoutBinding };
  }
  const wake = wakeForRun(source.orchestratorInboxes, run.id);
  return {
    run,
    sessionBinding: {
      id: binding.id,
      providerSessionId: binding.providerSessionId,
      ...(wake?.status === "scheduled" && wake.resumePrompt !== undefined ? { resumePrompt: wake.resumePrompt } : {})
    }
  };
}

const reject = (reason: string): SessionBindingOutcome => ({ kind: "rejected", reason });

/** Terminal bindings are diagnostic lineage only; beyond this many the oldest are pruned. */
export const retainedTerminalSessionBindings = 500;

function pruneSettledSessionBindings(state: State) {
  const bindings = state.sessionBindings ?? [];
  let excess = bindings.filter((binding) => isTerminalSessionBindingStatus(binding.status)).length - retainedTerminalSessionBindings;
  if (excess <= 0) return;
  state.sessionBindings = bindings.filter((binding) => {
    if (excess <= 0 || !isTerminalSessionBindingStatus(binding.status)) return true;
    excess -= 1;
    return false;
  });
}

/**
 * Applies one Barista session report inside a transaction. Only the node the run is assigned to may
 * report, only for a dispatched ACP run that has not started, and only an established (`active`)
 * session. A report naming a binding must be the resume the dispatch asked for; any other report
 * creates a new binding and replaces the one the run named. Exact replays are harmless. Rejection
 * reasons never include the reported values.
 */
export function acceptSessionBinding(state: State, nodeId: string, runId: string, update: HarnessSessionBindingUpdate, at: string): SessionBindingOutcome {
  if (containsSecretLikeValue(update.providerSessionId) || (update.bindingId !== undefined && containsSecretLikeValue(update.bindingId))) {
    return reject("session.binding identity looks like a credential");
  }
  const run = state.runs.find((item) => item.id === runId);
  if (!run) return reject("session.binding names an unknown run");
  if (run.nodeId !== nodeId) return reject(`run ${run.id} is not assigned to node ${nodeId}`);
  if (run.threadId === undefined) return reject(`run ${run.id} is not attached to a thread`);
  if (run.transport !== "acp-v1" || update.transport !== "acp-v1") return reject(`run ${run.id} is not an ACP run`);
  if (update.harnessId !== run.harnessId) return reject(`session.binding for run ${run.id} names a different harness`);
  if (update.status !== "active") return reject(`session.binding for run ${run.id} must report an established session`);
  const startable = run.status === "queued" && run.dispatchedAt !== undefined;
  if (!startable && run.status !== "running") return reject(`run ${run.id} is ${run.status}; its session can no longer be reported`);

  state.sessionBindings ??= [];
  const named = run.sessionBindingId === undefined ? undefined : state.sessionBindings.find((item) => item.id === run.sessionBindingId);
  if (update.bindingId !== undefined) {
    if (!named || update.bindingId !== named.id || named.providerSessionId !== update.providerSessionId || !bindingMatchesRun(named, run)) {
      return reject(`session.binding for run ${run.id} resumed a session its dispatch did not name`);
    }
    if (named.status === "active" && named.lastRunId === run.id) return { kind: "duplicate" };
    if (!startable || named.status !== "idle") return reject(`session.binding for run ${run.id} names a session that is not resumable`);
    named.status = "active";
    named.lastRunId = run.id;
    named.updatedAt = at;
    return { kind: "resumed", binding: named };
  }
  if (named?.status === "active" && named.lastRunId === run.id && named.createdByRunId === run.id && named.providerSessionId === update.providerSessionId) {
    return { kind: "duplicate" };
  }
  if (!startable) return reject(`run ${run.id} already started; its session must be reported before its prompt`);
  if (state.sessionBindings.some((item) => item.nodeId === run.nodeId && item.harnessId === run.harnessId && item.providerSessionId === update.providerSessionId)) {
    return reject(`session.binding for run ${run.id} reuses a provider session another binding already owns`);
  }
  const binding: HarnessSessionBinding = {
    id: newId("session"),
    threadId: run.threadId,
    agentId: run.agentId,
    nodeId: run.nodeId,
    harnessId: run.harnessId,
    transport: "acp-v1",
    workspace: run.workspace,
    ...(run.workspaceLeaseId !== undefined ? { workspaceLeaseId: run.workspaceLeaseId } : {}),
    providerSessionId: update.providerSessionId,
    status: "active",
    createdByRunId: run.id,
    lastRunId: run.id,
    createdAt: at,
    updatedAt: at
  };
  state.sessionBindings.push(binding);
  pruneSettledSessionBindings(state);
  let replacedBindingId: string | undefined;
  const replaceable = named && !isTerminalSessionBindingStatus(named.status) && (named.status === "idle" || named.lastRunId === run.id);
  if (named && replaceable && canTransitionSessionBinding(named.status, "replaced")) {
    named.status = "replaced";
    named.replacedByBindingId = binding.id;
    named.updatedAt = at;
    replacedBindingId = named.id;
  }
  run.sessionBindingId = binding.id;
  return { kind: "created", binding, ...(replacedBindingId !== undefined ? { replacedBindingId } : {}) };
}

/** Persists one session report; returns the outcome for logging and broadcasting. */
export async function receiveSessionBinding(store: Store, nodeId: string, runId: string, update: HarnessSessionBindingUpdate, at = new Date().toISOString()) {
  let outcome: SessionBindingOutcome = reject("session.binding was not applied");
  await store.transact((state) => {
    outcome = acceptSessionBinding(state, nodeId, runId, update, at);
    if (outcome.kind === "created" && outcome.replacedBindingId !== undefined) {
      const run = state.runs.find((item) => item.id === runId)!;
      state.events.unshift(newEvent({
        type: "status", title: "Session replaced",
        detail: "The previous harness session could not be resumed; a new session received the bounded durable context.",
        threadId: run.threadId, ...runAttribution(state, run), runId: run.id
      }));
    }
    return outcome.kind === "created" || outcome.kind === "resumed";
  });
  return outcome;
}

/**
 * Settles session bindings when a run becomes terminal, in the same transaction. A session whose
 * thread-owner, non-task run completed its ACP turn becomes `idle` with the capabilities that run
 * negotiated, so a later continuation may resume it, and any older idle binding in the same context
 * is closed, keeping at most one resumable session per context. A session of any other run, such as
 * a task attempt, can never be continued and is `closed`; any other ending fails it. A binding a
 * run asked to resume but that failed before its prompt is failed too, so the next continuation
 * replaces it, except when Barista refused only because its adapter cannot resume: the session
 * itself is intact and stays idle.
 */
export function settleSessionBindingsForTerminalRun(state: State, runId: string, at: string) {
  const run = state.runs.find((item) => item.id === runId);
  if (!run) return;
  for (const binding of state.sessionBindings ?? []) {
    if (binding.lastRunId === runId && binding.status === "active") {
      const capabilities = run.transportSelection?.selectedTransport === "acp-v1" ? run.transportSelection.acp : undefined;
      if (run.status === "completed" && capabilities && isContinuable(state, run)) {
        binding.status = "idle";
        binding.capabilities = structuredClone(capabilities);
        for (const older of state.sessionBindings ?? []) {
          if (older !== binding && older.status === "idle" && sameContext(older, binding)) {
            older.status = "closed";
            older.updatedAt = at;
          }
        }
      } else if (run.status === "completed") {
        binding.status = "closed";
      } else {
        binding.status = "failed";
      }
      binding.updatedAt = at;
    } else if (binding.id === run.sessionBindingId && binding.status === "idle" && binding.lastRunId !== runId
      && run.status === "failed" && run.startedAt === undefined && run.error !== sessionResumeUnavailableReason) {
      binding.status = "failed";
      binding.updatedAt = at;
    }
  }
  pruneSettledSessionBindings(state);
}
