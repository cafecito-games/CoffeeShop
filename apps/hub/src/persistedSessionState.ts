import { isHarnessTransport, isOrchestratorWakeStatus, isSessionBindingStatus } from "@coffee-shop/protocol";
import { assertPersistedActor } from "./actors.js";
import type { State } from "./store.js";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isSequence = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Rejects persisted session bindings and orchestrator inboxes the hub cannot interpret. A guessed
 * `idle` binding could be resumed and a guessed cursor could skip or replay inbox events, so
 * loading fails instead.
 */
export function assertPersistedSessionState(state: State) {
  const bindingIds = new Set<string>();
  for (const [index, binding] of (state.sessionBindings ?? []).entries()) {
    const context = `Persisted session binding ${index}`;
    if (!isRecord(binding) || !isNonEmptyString(binding.id) || !isNonEmptyString(binding.threadId)
      || !isNonEmptyString(binding.nodeId) || !isNonEmptyString(binding.providerSessionId) || !isNonEmptyString(binding.workspace)
      || !isNonEmptyString(binding.createdByRunId) || !isNonEmptyString(binding.lastRunId)) {
      throw new Error(`${context} is missing its identity`);
    }
    /*
     * A binding must name exactly one actor: the configured agent it was created for, or the instance
     * and the exact allocation it was created under. A half-written instance identity is refused with
     * the missing field named rather than being read as a legacy agent binding, which would otherwise
     * make a truncated record resumable by the wrong principal.
     */
    assertPersistedActor(binding, context, true);
    if (bindingIds.has(binding.id)) throw new Error(`${context} repeats its binding id`);
    bindingIds.add(binding.id);
    if (!isSessionBindingStatus(binding.status)) throw new Error(`${context} has an unknown status`);
    if (!isHarnessTransport(binding.transport)) throw new Error(`${context} has an unknown transport`);
  }
  const threadIds = new Set<string>();
  for (const [index, inbox] of (state.orchestratorInboxes ?? []).entries()) {
    const context = `Persisted orchestrator inbox ${index}`;
    if (!isRecord(inbox) || !isNonEmptyString(inbox.threadId) || threadIds.has(inbox.threadId)) throw new Error(`${context} is missing or repeats its thread`);
    threadIds.add(inbox.threadId);
    if (!isSequence(inbox.deliveredThrough) || !isSequence(inbox.processedThrough) || !isSequence(inbox.generation)
      || !isSequence(inbox.redeliveries) || !isSequence(inbox.consecutiveFailures) || !Array.isArray(inbox.wakes)) {
      throw new Error(`${context} is malformed`);
    }
    for (const [wakeIndex, wake] of inbox.wakes.entries()) {
      if (!isRecord(wake) || !isNonEmptyString(wake.id) || !isNonEmptyString(wake.runId) || !isOrchestratorWakeStatus(wake.status)
        || !isSequence(wake.fromSequence) || !isSequence(wake.throughSequence) || wake.fromSequence > wake.throughSequence
        || !Array.isArray(wake.eventSequences) || !wake.eventSequences.every(isSequence)) {
        throw new Error(`${context} wake ${wakeIndex} is malformed`);
      }
    }
  }
}
