import { validateComponentInventoryReport, type ComponentInventoryReport } from "@coffee-shop/protocol";
import type { State, Store } from "./store.js";

export type ComponentInventoryOutcome =
  | { kind: "accepted"; changed: true }
  | { kind: "replayed" | "older"; changed: false }
  | { kind: "rejected"; changed: false; reason: string };

export type ComponentInventoryReceiveOutcome = ComponentInventoryOutcome | { kind: "ignored"; changed: false };

export interface ComponentInventoryConnection {
  supportsCapability: boolean;
  current: boolean;
  nodeId: string;
}

/** Normalization is explicit even though the wire validator requires sorted arrays. */
export function normalizeComponentInventory(report: ComponentInventoryReport): ComponentInventoryReport {
  return structuredClone({
    ...report,
    observedAt: new Date(report.observedAt).toISOString(),
    components: report.components.map((component) => ({
      ...component,
      installedVersions: [...component.installedVersions].sort(),
      diagnosticCodes: [...component.diagnosticCodes].sort()
    })).sort((left, right) => `${left.kind}\u0000${left.id}`.localeCompare(`${right.kind}\u0000${right.id}`))
  });
}

export function applyComponentInventory(state: State, candidate: ComponentInventoryReport): ComponentInventoryOutcome {
  const validated = validateComponentInventoryReport(candidate);
  if (!validated.ok) return { kind: "rejected", changed: false, reason: validated.reason };
  if (!state.nodes.some((node) => node.id === validated.value.nodeId)) {
    return { kind: "rejected", changed: false, reason: "component inventory names an unknown node" };
  }
  const normalized = normalizeComponentInventory(validated.value);
  const reports = state.componentInventories ??= [];
  const index = reports.findIndex((report) => report.nodeId === normalized.nodeId);
  if (index < 0) {
    reports.push(normalized);
    reports.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
    return { kind: "accepted", changed: true };
  }
  const current = reports[index]!;
  if (normalized.observedAt < current.observedAt) return { kind: "older", changed: false };
  const same = JSON.stringify(normalized) === JSON.stringify(normalizeComponentInventory(current));
  if (normalized.observedAt === current.observedAt) {
    return same ? { kind: "replayed", changed: false }
      : { kind: "rejected", changed: false, reason: "component inventory timestamp conflicts with accepted evidence" };
  }
  reports[index] = normalized;
  return { kind: "accepted", changed: true };
}

/** A fresh Barista process/socket cannot inherit the previous process's report as live evidence. */
export function clearComponentInventory(state: State, nodeId: string) {
  const reports = state.componentInventories ??= [];
  const next = reports.filter((report) => report.nodeId !== nodeId);
  if (next.length === reports.length) return false;
  state.componentInventories = next;
  return true;
}

/**
 * Applies the complete gateway authority boundary before opening a transaction. The only callback
 * this boundary owns is Store persistence: scheduling is deliberately not an input or side effect,
 * because retained operator inventory is informational rather than placement evidence.
 */
export async function receiveComponentInventory(
  store: Store,
  connection: ComponentInventoryConnection,
  candidate: unknown
): Promise<ComponentInventoryReceiveOutcome> {
  if (!connection.supportsCapability || !connection.current || connection.nodeId === "") {
    return { kind: "ignored", changed: false };
  }
  const validated = validateComponentInventoryReport(candidate);
  if (!validated.ok) return { kind: "rejected", changed: false, reason: validated.reason };
  if (validated.value.nodeId !== connection.nodeId) {
    return { kind: "rejected", changed: false, reason: "component inventory does not match the registered node" };
  }
  let outcome!: ComponentInventoryOutcome;
  await store.transact((state) => {
    outcome = applyComponentInventory(state, validated.value);
    return outcome.changed;
  });
  return outcome;
}
