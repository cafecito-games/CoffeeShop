import { createHash } from "node:crypto";
import {
  hostHarnessSessionLimits,
  validateHostSessionControlMessage,
  type HostHarnessSessionHistoryItem,
  type HostSessionControlMessage
} from "@coffee-shop/protocol";
import { hasReconciledHostSessionInventory, type HostSessionInventoryConnection } from "./hostSessionInventory.js";
import type { State, Store, StoredHostSessionHistory } from "./store.js";

type HistoryPage = Extract<HostSessionControlMessage, { type: "host-session.history.page" }>;

export type HostSessionHistoryOutcome =
  | { kind: "accepted"; changed: true }
  | { kind: "replayed" | "ignored"; changed: false }
  | { kind: "rejected"; changed: false; reason?: string };

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]));
};
const semanticDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
const historyPageDigest = (page: HistoryPage) => semanticDigest({
  nodeId: page.nodeId,
  hostHarnessSessionId: page.hostHarnessSessionId,
  requestId: page.requestId,
  items: page.items,
  nextCursor: page.nextCursor,
  truncated: page.truncated
});
const historyItemDigest = (item: HostHarnessSessionHistoryItem) => semanticDigest(item);

function applyHistoryPage(state: State, page: HistoryPage): HostSessionHistoryOutcome {
  const session = state.hostHarnessSessions?.find((item) => item.hostHarnessSessionId === page.hostHarnessSessionId);
  if (!session || session.nodeId !== page.nodeId) {
    return { kind: "rejected", changed: false, reason: "host session history names an unknown session" };
  }
  const histories = state.hostSessionHistories ??= [];
  const index = histories.findIndex((history) => history.hostHarnessSessionId === page.hostHarnessSessionId);
  const current = index < 0 ? undefined : histories[index];
  const digest = historyPageDigest(page);
  const receipt = current?.receipts.find((item) => item.requestId === page.requestId);
  if (receipt) {
    return receipt.digest === digest
      ? { kind: "replayed", changed: false }
      : { kind: "rejected", changed: false, reason: "host session history request replay changed payload" };
  }
  if (current && Date.parse(page.at) < Date.parse(current.observedAt)) {
    return { kind: "rejected", changed: false, reason: "host session history observation is stale" };
  }
  if (page.nextCursor !== undefined && current?.receipts.some((item) => item.cursor === page.nextCursor)) {
    return { kind: "rejected", changed: false, reason: "host session history cursor did not advance" };
  }
  if (current && current.receipts.length >= hostHarnessSessionLimits.sessionsPerGeneration) {
    return { kind: "rejected", changed: false, reason: "host session history replay capacity is exhausted" };
  }
  const byId = new Map((current?.items ?? []).map((item) => [item.id, item]));
  for (const item of page.items) {
    const prior = byId.get(item.id);
    if (prior && historyItemDigest(prior) !== historyItemDigest(item)) {
      return { kind: "rejected", changed: false, reason: "host session history item identity conflicts" };
    }
  }
  const appended = [...(current?.items ?? []), ...page.items.filter((item) => !byId.has(item.id))];
  const omitted = Math.max(0, appended.length - hostHarnessSessionLimits.historyItemsPerPage);
  const items = appended.slice(omitted);
  const history: StoredHostSessionHistory = {
    hostHarnessSessionId: page.hostHarnessSessionId,
    nodeId: page.nodeId,
    items: structuredClone(items),
    ...(page.nextCursor === undefined ? {} : { cursor: page.nextCursor }),
    truncated: page.truncated || (current?.truncated ?? false) || omitted > 0,
    omittedItems: (current?.omittedItems ?? 0) + omitted,
    observedAt: page.at,
    receipts: [...(current?.receipts ?? []), {
      requestId: page.requestId,
      digest,
      ...(page.nextCursor === undefined ? {} : { cursor: page.nextCursor }),
      acceptedAt: page.at
    }]
  };
  if (index < 0) histories.push(history); else histories[index] = history;
  histories.sort((left, right) => left.hostHarnessSessionId.localeCompare(right.hostHarnessSessionId));
  return { kind: "accepted", changed: true };
}

/** Persists bounded provider history without touching Run transcripts, activity, or approvals. */
export async function receiveHostSessionHistory(
  store: Store,
  connection: HostSessionInventoryConnection,
  candidate: unknown
): Promise<HostSessionHistoryOutcome> {
  if (!connection.supportsCapability || !connection.barrierPassed || !connection.isCurrent() || connection.nodeId === "") {
    return { kind: "ignored", changed: false };
  }
  const validated = validateHostSessionControlMessage(candidate, "6");
  if (!validated.ok || validated.value.type !== "host-session.history.page") {
    return { kind: "rejected", changed: false, reason: validated.ok ? "unsupported host session history message" : validated.reason };
  }
  if (validated.value.nodeId !== connection.nodeId) {
    return { kind: "rejected", changed: false, reason: "host session history does not match the registered node" };
  }
  if (!hasReconciledHostSessionInventory(store, connection)) return { kind: "ignored", changed: false };
  let outcome: HostSessionHistoryOutcome = { kind: "ignored", changed: false };
  await store.transact((state) => {
    if (!connection.isCurrent() || !connection.barrierPassed) {
      outcome = { kind: "ignored", changed: false };
      return false;
    }
    outcome = applyHistoryPage(state, validated.value as HistoryPage);
    return outcome.changed;
  });
  return outcome;
}

export function hostSessionHistoryFor(state: Readonly<State>, hostHarnessSessionId: string) {
  return state.hostSessionHistories?.find((history) => history.hostHarnessSessionId === hostHarnessSessionId);
}
