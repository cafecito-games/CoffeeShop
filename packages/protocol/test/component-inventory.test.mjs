import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  canAcceptFromControlAgent, componentDiagnosticCodes, componentKinds, componentProvenances,
  componentReadinesses, validateComponentInventoryEntry, validateComponentInventoryReport
} from "../dist/index.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/component-inventory/report.json", import.meta.url), "utf8"));
const invalidFixtures = JSON.parse(readFileSync(new URL("./fixtures/component-inventory/invalid-reports.json", import.meta.url), "utf8"));

test("component inventory fixture validates with closed vocabularies and v5 capability", () => {
  assert.deepEqual(componentKinds, ["harness", "acp-adapter", "capability-pack"]);
  assert.deepEqual(componentProvenances, ["managed", "external", "none", "rejected"]);
  assert.deepEqual(componentReadinesses, ["ready", "inactive", "unavailable", "rejected", "unhealthy", "not-applicable"]);
  assert.equal(new Set(componentDiagnosticCodes).size, componentDiagnosticCodes.length);
  assert.equal(validateComponentInventoryReport(fixture.report).ok, true);
  for (const version of ["1", "2", "3", "4", "5"]) {
    assert.equal(canAcceptFromControlAgent(fixture, version), version === "5");
  }
});

test("component inventory rejects every structural ambiguity as one whole report", () => {
  const report = fixture.report;
  const first = report.components[0];
  for (const changed of [
    { ...report, extra: true },
    { ...report, nodeId: "Bad Node" },
    { ...report, observedAt: "today" },
    { ...report, components: [first, first] },
    { ...report, components: [...report.components].reverse() },
    { ...report, components: [{ ...first, unknown: true }] },
    { ...report, components: [{ ...first, installedVersions: ["2.0.0", "1.0.0"] }] },
    { ...report, components: [{ ...first, installedVersions: ["1.0.0", "1.0.0"] }] },
    { ...report, components: [{ ...first, diagnosticCodes: ["raw-error"] }] },
    { ...report, components: [{ ...first, rollbackAvailable: false }] }
  ]) assert.equal(validateComponentInventoryReport(changed).ok, false);
  for (const key of ["kind", "id", "declaredVersion", "installedVersions", "provenance", "readiness", "rollbackAvailable", "diagnosticCodes"]) {
    const entry = structuredClone(first);
    delete entry[key];
    assert.equal(validateComponentInventoryReport({ ...report, components: [entry] }).ok, false, key);
  }
  assert.equal(validateComponentInventoryEntry({ ...first, kind: "capability-pack", harnessId: undefined, readiness: "ready" }).ok, false);
});

test("TypeScript rejects the shared language-neutral invalid report fixtures", () => {
  for (const fixture of invalidFixtures) {
    assert.equal(canAcceptFromControlAgent(fixture.message, "5"), false, fixture.name);
    assert.equal(validateComponentInventoryReport(fixture.message.report).ok, false, fixture.name);
  }
});

test("component inventory enforces exact count and byte boundaries", () => {
  const entry = fixture.report.components[2];
  assert.equal(validateComponentInventoryEntry({ ...entry, id: "a".repeat(128) }).ok, true);
  assert.equal(validateComponentInventoryEntry({ ...entry, id: "a".repeat(129) }).ok, false);
  assert.equal(validateComponentInventoryEntry({ ...entry, declaredVersion: "1111.1111.1111.1111" }).ok, true);
  assert.equal(validateComponentInventoryEntry({ ...entry, declaredVersion: "11111.1" }).ok, false);
  assert.equal(validateComponentInventoryEntry({ ...entry, installedVersions: Array.from({ length: 32 }, (_, index) => `1.${index}`) }).ok, false,
    "lexical ordering remains mandatory at the count boundary");
  const normalized = Array.from({ length: 32 }, (_, index) => `1.${index}`).sort();
  assert.equal(validateComponentInventoryEntry({ ...entry, installedVersions: normalized }).ok, true);
  assert.equal(validateComponentInventoryEntry({ ...entry, installedVersions: [...normalized, "99.0"] }).ok, false);
  const components = Array.from({ length: 64 }, (_, index) => ({
    ...entry, id: `component-${String(index).padStart(2, "0")}`, harnessId: `component-${String(index).padStart(2, "0")}`
  }));
  assert.equal(validateComponentInventoryReport({ ...fixture.report, components }).ok, true);
  assert.equal(validateComponentInventoryReport({ ...fixture.report, components: [...components, { ...entry, id: "overflow", harnessId: "overflow" }] }).ok, false);
});
