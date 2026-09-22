import type { OrchestratorInbox, OrchestratorWake } from "@coffee-shop/protocol";

/** The wake a continuation run was created for, if `runId` is one. */
export function wakeForRun(inboxes: readonly OrchestratorInbox[] | undefined, runId: string): OrchestratorWake | undefined {
  for (const inbox of inboxes ?? []) {
    const wake = inbox.wakes.find((item) => item.runId === runId);
    if (wake) return wake;
  }
  return undefined;
}

export const isContinuationRun = (state: { orchestratorInboxes?: readonly OrchestratorInbox[] }, runId: string) =>
  wakeForRun(state.orchestratorInboxes, runId) !== undefined;
