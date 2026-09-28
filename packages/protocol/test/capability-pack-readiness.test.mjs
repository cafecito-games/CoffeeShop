import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  canAcceptFromControlAgent,
  validateCapabilityPackReadinessReport,
  validateExpectedCapabilityPack,
  validateRunTransportSelection
} from "../dist/index.js";

const report = {
  nodeId: "node-one",
  observedAt: "2026-09-28T12:00:00Z",
  status: "available",
  pack: {
    id: "coffeeshop-capability-pack",
    version: "1.2.0",
    skills: ["coffeeshop-artifacts", "coffeeshop-coordination", "coffeeshop-preview", "coffeeshop-task-reporting"]
  },
  surfaces: [
    { harnessId: "claude-cli", transport: "native-cli" },
    { harnessId: "codex-cli", transport: "native-cli" }
  ]
};

const producerMessage = JSON.parse(readFileSync(new URL("./fixtures/capability-pack-readiness/report.json", import.meta.url), "utf8"));

test("capability-pack readiness is an exact v5-only current-socket report", () => {
  assert.deepEqual(producerMessage.report, report);
  assert.equal(validateCapabilityPackReadinessReport(report).ok, true);
  const message = { type: "capability-pack.readiness", report };
  for (const version of ["1", "2", "3", "4", "5"]) {
    assert.equal(canAcceptFromControlAgent(message, version), version === "5");
  }
  for (const changed of [
    { ...report, extra: true },
    { ...report, status: "unavailable" },
    { ...report, reasonCode: "not-selected" },
    { ...report, surfaces: [...report.surfaces].reverse() },
    { ...report, surfaces: [report.surfaces[0], report.surfaces[0]] },
    { ...report, pack: { ...report.pack, skills: [...report.pack.skills].reverse() } }
  ]) assert.equal(validateCapabilityPackReadinessReport(changed).ok, false);
  assert.equal(validateCapabilityPackReadinessReport({
    nodeId: "node-one", observedAt: report.observedAt, status: "unavailable", surfaces: [], reasonCode: "not-selected"
  }).ok, true);
});

test("allocation expectations and effective proofs share exact normalized pack identity", () => {
  const expected = { id: "coffeeshop-capability-pack", version: "1.2.0", requiredSkills: ["coffeeshop-preview"] };
  assert.equal(validateExpectedCapabilityPack(expected).ok, true);
  assert.equal(validateExpectedCapabilityPack({ ...expected, requiredSkills: [] }).ok, false);
  assert.equal(validateExpectedCapabilityPack({ ...expected, requiredSkills: ["z", "a"] }).ok, false);
  assert.equal(validateExpectedCapabilityPack({ ...expected, id: "a".repeat(64) }).ok, true);
  assert.equal(validateExpectedCapabilityPack({ ...expected, id: "a".repeat(65) }).ok, false);
  assert.equal(validateExpectedCapabilityPack({ ...expected, id: "Mixed-Case" }).ok, false);
  assert.equal(validateExpectedCapabilityPack({ ...expected, requiredSkills: ["a".repeat(64)] }).ok, true);
  assert.equal(validateExpectedCapabilityPack({ ...expected, requiredSkills: ["a".repeat(65)] }).ok, false);
  assert.equal(validateExpectedCapabilityPack({ ...expected, requiredSkills: ["Mixed-Case"] }).ok, false);
  assert.equal(validateRunTransportSelection({
    requestedTransport: "native-cli",
    selectedTransport: "native-cli",
    effectiveCapabilityPack: { id: expected.id, version: expected.version, skills: ["coffeeshop-preview"] }
  }).ok, true);
  assert.equal(validateRunTransportSelection({
    requestedTransport: "native-cli", selectedTransport: "native-cli",
    effectiveCapabilityPack: { id: expected.id, version: expected.version, skills: [] }
  }).ok, false);
});
