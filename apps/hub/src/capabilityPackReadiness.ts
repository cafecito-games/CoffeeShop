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
  const value = validated.value;
  const canonical: CapabilityPackReadinessReport = {
    nodeId: value.nodeId,
    observedAt: new Date(Date.parse(value.observedAt)).toISOString(),
    status: value.status,
    ...(value.pack === undefined ? {} : { pack: { id: value.pack.id, version: value.pack.version, skills: [...value.pack.skills] } }),
    surfaces: value.surfaces.map((surface) => ({ harnessId: surface.harnessId, transport: surface.transport })),
    ...(value.reasonCode === undefined ? {} : { reasonCode: value.reasonCode })
  };
  const current = reports.get(connection.nodeId);
  const candidateInstant = Date.parse(canonical.observedAt);
  const currentInstant = current === undefined ? undefined : Date.parse(current.observedAt);
  if (currentInstant !== undefined && candidateInstant < currentInstant) return { kind: "older", changed: false };
  if (currentInstant !== undefined && candidateInstant === currentInstant) {
    return JSON.stringify(current) === JSON.stringify(canonical)
      ? { kind: "replayed", changed: false }
      : { kind: "rejected", changed: false, reason: "capability pack readiness timestamp conflicts with current evidence" };
  }
  reports.set(connection.nodeId, canonical);
  return { kind: "accepted", changed: true };
}
