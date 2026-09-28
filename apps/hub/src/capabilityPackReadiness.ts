import {
  validateCapabilityPackReadinessReport,
  type CapabilityPackReadinessReport,
  type ExpectedCapabilityPack,
  type RunTransportSelection
} from "@coffee-shop/protocol";

const reports = new Map<string, CapabilityPackReadinessReport>();

export interface CapabilityPackReadinessConnection {
  supportsCapability: boolean;
  isCurrent: () => boolean;
  nodeId: string;
}

export type CapabilityPackReadinessOutcome =
  | { kind: "accepted"; changed: true }
  | { kind: "replayed" | "older" | "ignored"; changed: false }
  | { kind: "rejected"; changed: false; reason: string };

export function getCapabilityPackReadiness(nodeId: string): CapabilityPackReadinessReport | undefined {
  return reports.get(nodeId);
}

export function forgetCapabilityPackReadiness(nodeId: string): boolean {
  return reports.delete(nodeId);
}

export function matchesCapabilityPackExpectation(
  expected: ExpectedCapabilityPack,
  selection: RunTransportSelection | undefined,
  readiness: CapabilityPackReadinessReport | undefined,
  harnessId: string
): boolean {
  const effective = selection?.effectiveCapabilityPack;
  const selectedTransport = selection?.selectedTransport;
  const ready = readiness?.status === "available" ? readiness.pack : undefined;
  const surfaces = readiness?.status === "available" ? readiness.surfaces : [];
  return effective !== undefined && ready !== undefined
    && effective.id === expected.id && effective.version === expected.version
    && ready.id === expected.id && ready.version === expected.version
    && expected.requiredSkills.every((skill) => effective.skills.includes(skill) && ready.skills.includes(skill))
    && surfaces.some((surface) => surface.harnessId === harnessId && surface.transport === selectedTransport);
}

export function receiveCapabilityPackReadiness(
  connection: CapabilityPackReadinessConnection,
  candidate: unknown
): CapabilityPackReadinessOutcome {
  if (!connection.supportsCapability || !connection.isCurrent() || connection.nodeId === "") {
    return { kind: "ignored", changed: false };
  }
  const validated = validateCapabilityPackReadinessReport(candidate);
  if (!validated.ok) return { kind: "rejected", changed: false, reason: validated.reason };
  if (validated.value.nodeId !== connection.nodeId) {
    return { kind: "rejected", changed: false, reason: "capability pack readiness does not match the registered node" };
  }
  const current = reports.get(connection.nodeId);
  if (current && validated.value.observedAt < current.observedAt) return { kind: "older", changed: false };
  if (current && validated.value.observedAt === current.observedAt) {
    return JSON.stringify(current) === JSON.stringify(validated.value)
      ? { kind: "replayed", changed: false }
      : { kind: "rejected", changed: false, reason: "capability pack readiness timestamp conflicts with current evidence" };
  }
  reports.set(connection.nodeId, structuredClone(validated.value));
  return { kind: "accepted", changed: true };
}
