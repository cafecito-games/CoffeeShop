import type { NodeCapabilityReport } from "@coffee-shop/protocol";

/**
 * The most recent capability report received from each connected node, keyed by node ID. Reports
 * are worker-reported evidence, never attested; project readiness evaluation and the project
 * profile loader consume this map without reparsing or reinterpreting its contents.
 */
const reports = new Map<string, NodeCapabilityReport>();

export function recordNodeCapabilityReport(report: NodeCapabilityReport): void {
  reports.set(report.nodeId, report);
}

export function getNodeCapabilityReport(nodeId: string): NodeCapabilityReport | undefined {
  return reports.get(nodeId);
}

export function nodeCapabilityReportsSnapshot(): ReadonlyMap<string, NodeCapabilityReport> {
  return reports;
}
