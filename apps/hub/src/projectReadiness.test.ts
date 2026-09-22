import assert from "node:assert/strict";
import test from "node:test";
import type { ComputeNode, NodeCapabilityEvidence, NodeCapabilityReport, ProjectProfile } from "@coffee-shop/protocol";
import { computeNodeProjectReadiness, defaultEvidenceTTLMilliseconds, workspaceAuthorizedForProject } from "./projectReadiness.js";

const nowIso = "2026-03-01T12:00:00Z";

const node = (overrides: Partial<ComputeNode> = {}): ComputeNode => ({
  id: "node-one",
  name: "Desk",
  kind: "local",
  platform: "darwin",
  status: "online",
  lastSeen: nowIso,
  activeRuns: 0,
  concurrency: 2,
  workspaceRoots: ["/workspace"],
  harnesses: [],
  version: "test",
  ...overrides
});

const profile: ProjectProfile = {
  schemaVersion: 1,
  id: "coffee-shop-web",
  name: "Coffee Shop web app",
  workspacePolicy: { requireWritable: true },
  requirements: {
    hard: {
      operatingSystems: ["darwin"],
      toolchains: [{ capabilityId: "node", label: "Node.js", versionConstraint: ">=20.0.0" }]
    }
  }
};

const runtimeEvidence = (capabilityId: string, normalizedValue: string): NodeCapabilityEvidence => ({
  capabilityId,
  source: "runtime",
  success: true,
  normalizedValue,
  observedAt: nowIso
});

const probeEvidence = (capabilityId: string, version: string): NodeCapabilityEvidence => ({
  capabilityId,
  source: "probe",
  success: true,
  normalizedValue: version,
  probeDefinitionVersion: "1",
  observedAt: nowIso
});

const report = (evidence: NodeCapabilityEvidence[], overrides: Partial<NodeCapabilityReport> = {}): NodeCapabilityReport => ({
  nodeId: "node-one",
  evidence,
  at: nowIso,
  ...overrides
});

const satisfiedReport = (overrides: Partial<NodeCapabilityReport> = {}) => report([
  runtimeEvidence("os", "darwin"),
  runtimeEvidence("workspace-writable", "true"),
  probeEvidence("node", "22.11.0")
], overrides);

test("a node with zero workspace roots is never ready regardless of evidence", () => {
  const bareNode = node({ workspaceRoots: [] });
  assert.equal(workspaceAuthorizedForProject(bareNode, satisfiedReport(), profile, nowIso), false);
  const readiness = computeNodeProjectReadiness(bareNode, satisfiedReport(), profile, nowIso);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.unmetHardRequirements.some((unmet) => unmet.kind === "workspace"));
});

test("a workspace root without a report is not ready when the profile requires a writable workspace", () => {
  const readiness = computeNodeProjectReadiness(node(), undefined, profile, nowIso);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.unmetHardRequirements.some((unmet) => unmet.kind === "workspace"));
});

test("a node whose evidence satisfies every hard requirement and workspace policy is ready", () => {
  const readiness = computeNodeProjectReadiness(node(), satisfiedReport(), profile, nowIso);
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.unmetHardRequirements, []);
  assert.equal(readiness.nodeId, "node-one");
  assert.equal(readiness.projectId, "coffee-shop-web");
});

test("an allowlist that excludes the profile's id blocks readiness even when all else passes", () => {
  const restricted = satisfiedReport({ projectAllowlist: ["some-other-project"] });
  const readiness = computeNodeProjectReadiness(node(), restricted, profile, nowIso);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.unmetHardRequirements.some((unmet) => unmet.kind === "project-allowlist"));
});

test("stale workspace-writable evidence does not satisfy the requireWritable gate", () => {
  const staleReport = report([
    runtimeEvidence("os", "darwin"),
    { ...runtimeEvidence("workspace-writable", "true"), observedAt: "2020-01-01T00:00:00Z" },
    probeEvidence("node", "22.11.0")
  ]);
  assert.equal(workspaceAuthorizedForProject(node(), staleReport, profile, nowIso), false);
  const readiness = computeNodeProjectReadiness(node(), staleReport, profile, nowIso);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.unmetHardRequirements.some((unmet) => unmet.kind === "workspace"));
});

test("ambiguous workspace-writable evidence does not satisfy the requireWritable gate", () => {
  const ambiguousReport = report([
    runtimeEvidence("os", "darwin"),
    { ...runtimeEvidence("workspace-writable", "true"), source: "runtime" },
    { ...runtimeEvidence("workspace-writable", "true"), source: "configured", success: false, normalizedValue: undefined },
    probeEvidence("node", "22.11.0")
  ]);
  assert.equal(workspaceAuthorizedForProject(node(), ambiguousReport, profile, nowIso), false);
});

test("defaultEvidenceTTLMilliseconds is exported as a positive number", () => {
  assert.equal(typeof defaultEvidenceTTLMilliseconds, "number");
  assert.ok(defaultEvidenceTTLMilliseconds > 0);
});
