import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  canAcceptFromControlAgent,
  capabilityEvidenceLimits,
  capabilityEvidenceSources,
  compareVersions,
  computeEvidenceFingerprint,
  computeProjectProfileFingerprint,
  containsSecretLikeValue,
  evaluateProjectReadiness,
  isNormalizedVersion,
  parseVersionConstraint,
  projectProfileSchemaVersion,
  readinessRequirementKinds,
  satisfiesVersionConstraint,
  validateNodeCapabilityEvidence,
  validateNodeCapabilityReport,
  validateProjectProfile,
  versionComparators
} from "../dist/index.js";

const fixtureDirectory = new URL("./fixtures/project-readiness/", import.meta.url);
const readFixture = (name) => JSON.parse(readFileSync(new URL(name, fixtureDirectory), "utf8"));
const nowIso = "2026-09-21T12:00:00Z";
const observedAt = "2026-09-21T11:59:00Z";
const evidenceTTL = 10 * 60 * 1000;

test("version grammar accepts normalized dotted integers and rejects malformed input", () => {
  for (const accepted of ["0", "1", "0.2", "1.24.0", "16.4", "2026.9.21", "1.0.0.0"]) {
    assert.equal(isNormalizedVersion(accepted), true, `${accepted} must be normalized`);
  }
  for (const rejected of ["", "01.2", "1.02", "1.2.3.4.5", "20260921", "1.x.2", "1..2", ".1", "1.", "v1.2", "1-2", 12, null, undefined]) {
    assert.equal(isNormalizedVersion(rejected), false, `${rejected} must not be normalized`);
  }
  assert.equal(isNormalizedVersion("1".repeat(33)), false, "version beyond 32 bytes must be rejected");
  assert.equal(isNormalizedVersion("12345.1"), false, "segment beyond four digits must be rejected");
});

test("parseVersionConstraint accepts every comparator and defaults to equality", () => {
  const expectations = [
    [">=1.24.0", ">=", "1.24.0"],
    ["<=1.24.0", "<=", "1.24.0"],
    [">1.24.0", ">", "1.24.0"],
    ["<1.24.0", "<", "1.24.0"],
    ["=1.24.0", "=", "1.24.0"],
    ["1.24.0", "=", "1.24.0"]
  ];
  for (const [raw, comparator, version] of expectations) {
    const result = parseVersionConstraint(raw);
    assert.equal(result.ok, true, `${raw} must parse: ${result.ok ? "" : result.reason}`);
    assert.deepEqual(result.value, { comparator, version });
  }
  for (const rejected of ["01.2", "", ">=", "<= (empty)", "1.2.3.4.5", "1.x.2", 12, null, undefined, "x".repeat(41)]) {
    assert.equal(parseVersionConstraint(rejected).ok, false, `${rejected} must be rejected`);
  }
});

test("compareVersions pads the shorter segment list and orders numerically", () => {
  assert.equal(compareVersions("1.24.0", "1.24.0"), 0);
  assert.equal(compareVersions("1.24.0", "1.30.0"), -1);
  assert.equal(compareVersions("1.30.0", "1.24.0"), 1);
  assert.equal(compareVersions("1.2", "1.2.0"), 0);
  assert.equal(compareVersions("1.2", "1.2.1"), -1);
  assert.equal(compareVersions("1.2.1", "1.2"), 1);
  assert.equal(compareVersions("1.10", "1.9"), 1);
  assert.equal(compareVersions("2.0", "1.9.9"), 1);
  assert.equal(compareVersions("0.0.1", "0.1"), -1);
});

test("satisfiesVersionConstraint interprets every comparator and fails closed", () => {
  const expectations = [
    ["1.24.0", "=", "1.24.0", true],
    ["1.24.0", "=", "1.23", false],
    ["1.24.0", ">=", "1.24.0", true],
    ["1.24.0", ">=", "1.24.1", false],
    ["1.24.0", ">", "1.24.0", false],
    ["1.24.1", ">", "1.24.0", true],
    ["1.24.0", "<=", "1.24.0", true],
    ["1.24.1", "<=", "1.24.0", false],
    ["1.24.0", "<", "1.24.0", false],
    ["1.23", "<", "1.24.0", true],
    ["1.2", ">=", "1.2.0", true]
  ];
  for (const [version, comparator, constraintVersion, expected] of expectations) {
    assert.equal(
      satisfiesVersionConstraint(version, { comparator, version: constraintVersion }),
      expected,
      `${version} ${comparator} ${constraintVersion}`
    );
  }
  assert.equal(satisfiesVersionConstraint("01.2", { comparator: ">=", version: "1.0" }), false);
  assert.equal(satisfiesVersionConstraint("not-a-version", { comparator: "=", version: "1.0" }), false);
  assert.equal(versionComparators.includes("="), true);
});

test("the valid project profile fixture is accepted and round-trips", () => {
  const fixture = readFixture("valid-profile.json");
  const result = validateProjectProfile(fixture);
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  assert.deepEqual(JSON.parse(JSON.stringify(result.value)), fixture);
  assert.equal(projectProfileSchemaVersion, 1);
  assert.equal(containsSecretLikeValue(fixture), false);
});

const withoutKey = (object, key) => Object.fromEntries(Object.entries(object).filter(([entry]) => entry !== key));

test("project profiles are rejected for every structural failure", () => {
  const valid = readFixture("valid-profile.json");
  const negatives = [
    ["unknown top-level field", { ...valid, extra: 1 }],
    ["unknown schema version", { ...valid, schemaVersion: 2 }],
    ["missing schema version", withoutKey(valid, "schemaVersion")],
    ["malformed id", { ...valid, id: "Cafecito_IOS" }],
    ["empty id", { ...valid, id: "" }],
    ["empty name", { ...valid, name: "" }],
    ["unknown workspacePolicy key", { ...valid, workspacePolicy: { ...valid.workspacePolicy, extra: true } }],
    ["unknown requirements key", { ...valid, requirements: { ...valid.requirements, extra: [] } }],
    ["unknown hard requirement set key", { ...valid, requirements: { ...valid.requirements, hard: { ...valid.requirements.hard, extra: [] } } }],
    ["duplicate toolchain capabilityId", {
      ...valid,
      requirements: {
        ...valid.requirements,
        hard: {
          ...valid.requirements.hard,
          toolchains: [...valid.requirements.hard.toolchains, { capabilityId: "toolchain:xcode", label: "Xcode again" }]
        }
      }
    }],
    ["unknown harnessIds entry", {
      ...valid,
      requirements: { ...valid.requirements, hard: { ...valid.requirements.hard, harnessIds: ["cursor-cli"] } }
    }],
    ["unknown transports entry", {
      ...valid,
      requirements: { ...valid.requirements, hard: { ...valid.requirements.hard, transports: ["acp-v2"] } }
    }],
    ["malformed toolchain versionConstraint", {
      ...valid,
      requirements: {
        ...valid.requirements,
        hard: {
          ...valid.requirements.hard,
          toolchains: [{ capabilityId: "toolchain:xcode", label: "Xcode", versionConstraint: ">=01.2" }]
        }
      }
    }],
    ["malformed toolchain capabilityId", {
      ...valid,
      requirements: {
        ...valid.requirements,
        hard: { ...valid.requirements.hard, toolchains: [{ capabilityId: "Xcode!", label: "Xcode" }] }
      }
    }],
    ["zero minimum cpu count", {
      ...valid,
      requirements: { ...valid.requirements, hard: { ...valid.requirements.hard, minimumLogicalCpuCount: 0 } }
    }],
    ["duplicate label", {
      ...valid,
      requirements: { ...valid.requirements, hard: { ...valid.requirements.hard, labels: ["ci", "ci"] } }
    }],
    ["empty operatingSystems array", {
      ...valid,
      requirements: { ...valid.requirements, hard: { ...valid.requirements.hard, operatingSystems: [] } }
    }],
    ["duplicate allowedRepositories entry", {
      ...valid,
      workspacePolicy: {
        ...valid.workspacePolicy,
        allowedRepositories: [...valid.workspacePolicy.allowedRepositories, valid.workspacePolicy.allowedRepositories[0]]
      }
    }],
    ["secret-like token in name", { ...valid, name: "sk-abcdef1234567890" }],
    ["secret-like token nested in requirements", {
      ...valid,
      requirements: { ...valid.requirements, hard: { ...valid.requirements.hard, labels: ["ghp-abcdef1234567890"] } }
    }],
    ["non-object", null],
    ["array", []]
  ];
  for (const [label, value] of negatives) {
    const result = validateProjectProfile(value);
    assert.equal(result.ok, false, `${label} must be rejected`);
  }
});

test("containsSecretLikeValue matches the narrow denylist without heuristic scanning", () => {
  for (const flagged of [
    "sk-abcdef1234567890",
    "pk_test_1234567890abcdef",
    "ghp_abcdefghij1234",
    "xoxb-1234567890abcdef",
    "AKIAIOSFODNN7EXAMPLE",
    "glpat-abcdefghij1234",
    "Bearer abcdefghijklmnop",
    "-----BEGIN RSA PRIVATE KEY-----",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END-----"
  ]) {
    assert.equal(containsSecretLikeValue(flagged), true, `${flagged} must be flagged`);
  }
  for (const clean of [
    "https://github.com/CafecitoGames/cafecito-ios.git",
    "feature/very-long-branch-name-2026",
    "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    "claude-cli",
    "Xcode 16.4",
    "BEGIN", "PRIVATE", "bearer token please"
  ]) {
    assert.equal(containsSecretLikeValue(clean), false, `${clean} must not be flagged`);
  }
  assert.equal(containsSecretLikeValue({ nested: { deeper: ["gho-abcdefghij1234"] } }), true);
  assert.equal(containsSecretLikeValue({ nested: { deeper: ["plain text"] } }), false);
  assert.equal(containsSecretLikeValue(42), false);
});

test("profile fingerprints ignore key order, array order, and out-of-scope fields", () => {
  const profile = readFixture("valid-profile.json");
  const hard = profile.requirements.hard;
  const reorderedKeys = {
    requirements: {
      preferred: profile.requirements.preferred,
      hard: {
        transports: [...hard.transports].reverse(),
        harnessIds: hard.harnessIds,
        toolchains: [...hard.toolchains].reverse(),
        labels: hard.labels,
        minimumConfiguredMemoryMegabytes: hard.minimumConfiguredMemoryMegabytes,
        minimumLogicalCpuCount: hard.minimumLogicalCpuCount,
        architectures: [...hard.architectures].reverse(),
        operatingSystems: [...hard.operatingSystems].reverse()
      }
    },
    workspacePolicy: {
      allowedRepositories: [...profile.workspacePolicy.allowedRepositories].reverse(),
      requireWritable: profile.workspacePolicy.requireWritable
    },
    repository: profile.repository,
    name: "A different display name",
    id: profile.id,
    schemaVersion: 1
  };

  assert.equal(computeProjectProfileFingerprint(profile), computeProjectProfileFingerprint(reorderedKeys));

  const fingerprint = computeProjectProfileFingerprint(profile);
  const semanticChanges = [
    { ...profile, id: "cafecito-ios-2" },
    { ...profile, repository: { ...profile.repository, defaultBranch: "develop" } },
    { ...profile, workspacePolicy: { ...profile.workspacePolicy, requireWritable: false } },
    { ...profile, requirements: { ...profile.requirements, hard: { ...profile.requirements.hard, labels: ["ci", "release"] } } },
    { ...profile, requirements: { ...profile.requirements, preferred: undefined } }
  ];
  for (const changed of semanticChanges) {
    assert.notEqual(computeProjectProfileFingerprint(changed), fingerprint);
  }

  const picked = { id: profile.id, repository: profile.repository, workspacePolicy: profile.workspacePolicy, requirements: profile.requirements };
  assert.equal(
    computeProjectProfileFingerprint(picked),
    computeProjectProfileFingerprint({ ...picked, name: "Different name", schemaVersion: 99 })
  );
  assert.match(fingerprint, /^[0-9a-f]{8}$/);
});

test("node capability evidence validates its source pairing and bounds", () => {
  const validReport = readFixture("capability-report.json");
  const reportResult = validateNodeCapabilityReport(validReport);
  assert.equal(reportResult.ok, true, reportResult.ok ? "" : reportResult.reason);
  assert.deepEqual(JSON.parse(JSON.stringify(reportResult.value)), validReport);

  const runtimeEntry = { capabilityId: "os", source: "runtime", success: true, normalizedValue: "macos", observedAt };
  const configuredEntry = { capabilityId: "label:ci", source: "configured", success: true, observedAt };
  const probeEntry = {
    capabilityId: "toolchain:xcode", source: "probe", success: true, normalizedValue: "16.4",
    probeDefinitionVersion: "1", observedAt, diagnostic: "exit status 0"
  };
  for (const entry of [runtimeEntry, configuredEntry, probeEntry]) {
    const result = validateNodeCapabilityEvidence(entry);
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
  }

  const negatives = [
    ["probeDefinitionVersion without probe source", { ...runtimeEntry, probeDefinitionVersion: "1" }],
    ["probe source without probeDefinitionVersion", { ...probeEntry, probeDefinitionVersion: undefined }],
    ["unknown source", { ...runtimeEntry, source: "guessed" }],
    ["malformed capabilityId", { ...runtimeEntry, capabilityId: "Operating System!" }],
    ["empty capabilityId", { ...runtimeEntry, capabilityId: "" }],
    ["oversize rawValue", { ...runtimeEntry, rawValue: "a".repeat(capabilityEvidenceLimits.rawValueBytes + 1) }],
    ["empty normalizedValue", { ...runtimeEntry, normalizedValue: "" }],
    ["oversize normalizedValue", { ...runtimeEntry, normalizedValue: "1".repeat(capabilityEvidenceLimits.normalizedValueBytes + 1) }],
    ["oversize diagnostic", { ...runtimeEntry, diagnostic: "a".repeat(capabilityEvidenceLimits.diagnosticBytes + 1) }],
    ["non-timestamp observedAt", { ...runtimeEntry, observedAt: "yesterday" }],
    ["non-boolean success", { ...runtimeEntry, success: "yes" }],
    ["undeclared field", { ...runtimeEntry, extra: 1 }],
    ["non-object", null]
  ];
  for (const [label, value] of negatives) {
    const result = validateNodeCapabilityEvidence(value);
    assert.equal(result.ok, false, `${label} must be rejected`);
  }
});

test("node capability reports reject duplicate evidence and malformed allowlists", () => {
  const validReport = readFixture("capability-report.json");
  const evidence = validReport.evidence;
  const report = (overrides) => ({ ...validReport, ...overrides });

  const negatives = [
    ["duplicate capabilityId and source pair", report({ evidence: [...evidence, { ...evidence[0] }] })],
    ["duplicate pair across different sources", report({
      evidence: [
        evidence[0],
        { ...evidence[0], source: "configured" },
        { ...evidence[0], source: "configured", observedAt: "2026-09-21T11:58:00Z" }
      ]
    })],
    ["malformed project allowlist entry", report({ projectAllowlist: ["Cafecito"] })],
    ["duplicate project allowlist entry", report({ projectAllowlist: ["cafecito-ios", "cafecito-ios"] })],
    ["empty project allowlist", report({ projectAllowlist: [] })],
    ["missing nodeId", report({ nodeId: "" })],
    ["evidence beyond the entry limit", report({ evidence: Array.from(
      { length: capabilityEvidenceLimits.maxEvidenceEntries + 1 },
      (_, index) => ({ capabilityId: `capability-${index}`, source: "runtime", success: true, observedAt })
    ) })],
    ["invalid evidence entry", report({ evidence: [...evidence, { capabilityId: "os", source: "nope", success: true, observedAt }] })],
    ["non-timestamp at", report({ at: "soon" })],
    ["undeclared field", report({ extra: 1 })],
    ["non-object", null]
  ];
  for (const [label, value] of negatives) {
    const result = validateNodeCapabilityReport(value);
    assert.equal(result.ok, false, `${label} must be rejected`);
  }

  assert.equal(validateNodeCapabilityReport({ nodeId: "node-one", evidence: [], at: nowIso }).ok, true, "empty evidence is allowed");
  assert.equal(validateNodeCapabilityReport({
    nodeId: "node-one",
    evidence: [
      { capabilityId: "os", source: "runtime", success: true, normalizedValue: "macos", observedAt },
      { capabilityId: "os", source: "configured", success: true, normalizedValue: "macos", observedAt: "2026-09-21T11:58:00Z" }
    ],
    at: nowIso
  }).ok, true, "one capabilityId via two distinct sources is allowed");
  assert.deepEqual(capabilityEvidenceSources, ["runtime", "configured", "probe"]);
  assert.deepEqual(readinessRequirementKinds, [
    "operating-system", "architecture", "cpu", "memory", "accelerator", "label",
    "toolchain", "harness", "transport", "workspace", "project-allowlist"
  ]);
});

test("capability reports require control protocol version 4", () => {
  const message = { type: "capability.report", report: readFixture("capability-report.json") };
  assert.equal(canAcceptFromControlAgent(message, "4"), true);
  assert.equal(canAcceptFromControlAgent(message, "3"), false);
});

test("evidence fingerprints ignore order and volatile fields", () => {
  const evidence = readFixture("capability-report.json").evidence;
  assert.equal(computeEvidenceFingerprint(evidence), computeEvidenceFingerprint([...evidence].reverse()));

  const fingerprint = computeEvidenceFingerprint(evidence);
  const semanticChanges = [
    evidence.map((entry) => entry.capabilityId === "os" ? { ...entry, normalizedValue: "linux" } : entry),
    evidence.map((entry) => entry.capabilityId === "os" ? { ...entry, success: false } : entry)
  ];
  for (const changed of semanticChanges) {
    assert.notEqual(computeEvidenceFingerprint(changed), fingerprint);
  }

  const volatileChanges = [
    evidence.map((entry) => ({ ...entry, observedAt: "2026-09-21T10:00:00Z" })),
    evidence.map((entry) => ({ ...entry, diagnostic: "different words" })),
    evidence.map((entry) => ({ ...entry, rawValue: "different raw text" }))
  ];
  for (const changed of volatileChanges) {
    assert.equal(computeEvidenceFingerprint(changed), fingerprint);
  }
});

const harness = (overrides = {}) => ({
  id: "claude-cli",
  label: "Claude",
  description: "Claude CLI",
  available: true,
  authMode: "local-subscription",
  models: ["claude-opus-5"],
  ...overrides
});

const readinessProfile = (overrides = {}) => ({
  schemaVersion: 1,
  id: "cafecito-ios",
  name: "Cafecito iOS app",
  workspacePolicy: { requireWritable: true },
  requirements: {
    hard: {
      operatingSystems: ["macos"],
      toolchains: [{ capabilityId: "toolchain:xcode", label: "Xcode", versionConstraint: ">=16.0" }],
      labels: ["ci"],
      harnessIds: ["claude-cli"],
      transports: ["acp-v1"]
    },
    preferred: { accelerators: ["metal"] },
    ...overrides.requirements
  },
  ...overrides
});

const readinessContext = (overrides = {}) => ({
  nodeId: "node-one",
  harnesses: [harness({ transports: ["native-cli", "acp-v1"] })],
  evidence: [
    { capabilityId: "os", source: "runtime", success: true, normalizedValue: "macos", observedAt },
    { capabilityId: "toolchain:xcode", source: "probe", success: true, normalizedValue: "16.4", probeDefinitionVersion: "1", observedAt },
    { capabilityId: "label:ci", source: "configured", success: true, observedAt }
  ],
  workspaceAuthorized: true,
  ...overrides
});

test("readiness reports satisfied hard requirements and unmet preferences separately", () => {
  const readiness = evaluateProjectReadiness(readinessProfile(), readinessContext(), evidenceTTL, nowIso);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.nodeId, "node-one");
  assert.equal(readiness.projectId, "cafecito-ios");
  assert.equal(readiness.evaluatedAt, nowIso);
  assert.deepEqual(readiness.unmetHardRequirements, []);
  assert.equal(readiness.unmetPreferences.length > 0, true);
  assert.equal(readiness.unmetPreferences[0].kind, "accelerator");
  assert.equal(readiness.profileFingerprint, computeProjectProfileFingerprint(readinessProfile()));
  assert.equal(readiness.evidenceFingerprint, computeEvidenceFingerprint(readinessContext().evidence));
});

test("readiness fails closed for missing and failing hard toolchains", () => {
  const missing = evaluateProjectReadiness(
    readinessProfile(),
    readinessContext({ evidence: readinessContext().evidence.filter((entry) => entry.capabilityId !== "toolchain:xcode") }),
    evidenceTTL,
    nowIso
  );
  assert.equal(missing.ready, false);
  assert.deepEqual(missing.unmetHardRequirements.map((unmet) => unmet.kind), ["toolchain"]);
  assert.equal(missing.unmetHardRequirements[0].detail, "missing evidence");

  const failing = evaluateProjectReadiness(
    readinessProfile(),
    readinessContext({ evidence: readinessContext().evidence.map((entry) =>
      entry.capabilityId === "toolchain:xcode" ? { ...entry, success: false } : entry) }),
    evidenceTTL,
    nowIso
  );
  assert.equal(failing.ready, false);
  assert.equal(failing.unmetHardRequirements[0].detail, "evidence failed");
});

test("readiness rejects a toolchain version that fails the constraint", () => {
  const readiness = evaluateProjectReadiness(
    readinessProfile(),
    readinessContext({ evidence: readinessContext().evidence.map((entry) =>
      entry.capabilityId === "toolchain:xcode" ? { ...entry, normalizedValue: "15.0" } : entry) }),
    evidenceTTL,
    nowIso
  );
  assert.equal(readiness.ready, false);
  const unmet = readiness.unmetHardRequirements.find((entry) => entry.kind === "toolchain");
  assert.equal(unmet !== undefined, true);
  assert.equal(unmet.requirement, "Xcode >=16.0");
  assert.equal(unmet.detail, "version is unparseable or unreported");

  const unparseable = evaluateProjectReadiness(
    readinessProfile({ requirements: { hard: {
      ...readinessProfile().requirements.hard,
      toolchains: [{ capabilityId: "toolchain:xcode", label: "Xcode", versionConstraint: ">=16.0" }]
    }, preferred: { accelerators: ["metal"] } } }),
    readinessContext({ evidence: readinessContext().evidence.map((entry) =>
      entry.capabilityId === "toolchain:xcode" ? { ...entry, normalizedValue: undefined, rawValue: "Xcode 16.4" } : entry) }),
    evidenceTTL,
    nowIso
  );
  const rawUnmet = unparseable.unmetHardRequirements.find((entry) => entry.kind === "toolchain");
  assert.equal(rawUnmet.detail, "version is unparseable or unreported");
});

test("stale evidence is unmet even when a fresh identical entry would satisfy", () => {
  const staleAt = "2026-09-21T10:00:00Z";
  const withEvidenceAt = (at) => readinessContext({
    evidence: readinessContext().evidence.map((entry) => ({ ...entry, observedAt: at }))
  });

  const fresh = evaluateProjectReadiness(readinessProfile(), withEvidenceAt("2026-09-21T11:59:00Z"), evidenceTTL, nowIso);
  assert.equal(fresh.ready, true);

  const stale = evaluateProjectReadiness(readinessProfile(), withEvidenceAt(staleAt), evidenceTTL, nowIso);
  assert.equal(stale.ready, false);
  assert.deepEqual(stale.unmetHardRequirements.map((unmet) => unmet.kind), ["operating-system", "label", "toolchain"]);
  assert.ok(stale.unmetHardRequirements.every((unmet) => unmet.detail === "evidence is stale"));
});

test("disagreeing evidence for one capability is ambiguous, never a match", () => {
  const context = readinessContext({
    evidence: [
      ...readinessContext().evidence.filter((entry) => entry.capabilityId !== "toolchain:xcode"),
      { capabilityId: "toolchain:xcode", source: "runtime", success: true, normalizedValue: "16.4", observedAt },
      { capabilityId: "toolchain:xcode", source: "probe", success: true, normalizedValue: "15.0", probeDefinitionVersion: "1", observedAt }
    ]
  });
  const readiness = evaluateProjectReadiness(readinessProfile(), context, evidenceTTL, nowIso);
  assert.equal(readiness.ready, false);
  const unmet = readiness.unmetHardRequirements.find((entry) => entry.kind === "toolchain");
  assert.equal(unmet.detail, "ambiguous evidence");

  const agreeing = evaluateProjectReadiness(readinessProfile(), readinessContext({
    evidence: [
      ...readinessContext().evidence.filter((entry) => entry.capabilityId !== "toolchain:xcode"),
      { capabilityId: "toolchain:xcode", source: "runtime", success: true, normalizedValue: "16.4", observedAt: "2026-09-21T11:58:00Z" },
      { capabilityId: "toolchain:xcode", source: "probe", success: true, normalizedValue: "16.4", probeDefinitionVersion: "1", observedAt }
    ]
  }), evidenceTTL, nowIso);
  assert.equal(agreeing.ready, true, "agreeing entries resolve instead of staying ambiguous");
});

test("the project allowlist and workspace authorization gate readiness independently", () => {
  const allowlisted = evaluateProjectReadiness(
    readinessProfile(),
    readinessContext({ projectAllowlist: ["cafecito-ios"] }),
    evidenceTTL,
    nowIso
  );
  assert.equal(allowlisted.ready, true);

  const excluded = evaluateProjectReadiness(
    readinessProfile(),
    readinessContext({ projectAllowlist: ["another-project"] }),
    evidenceTTL,
    nowIso
  );
  assert.equal(excluded.ready, false);
  const allowlistUnmet = excluded.unmetHardRequirements.find((entry) => entry.kind === "project-allowlist");
  assert.deepEqual(allowlistUnmet, { kind: "project-allowlist", requirement: "cafecito-ios", detail: "node does not authorize this project" });

  const unauthorizedWorkspace = evaluateProjectReadiness(
    readinessProfile(),
    readinessContext({ workspaceAuthorized: false }),
    evidenceTTL,
    nowIso
  );
  assert.equal(unauthorizedWorkspace.ready, false);
  const workspaceUnmet = unauthorizedWorkspace.unmetHardRequirements.find((entry) => entry.kind === "workspace");
  assert.deepEqual(workspaceUnmet, { kind: "workspace", requirement: "writable workspace root", detail: "no authorized workspace root supports this project's workspace policy" });

  const readOnly = evaluateProjectReadiness(
    readinessProfile({ ...readinessProfile(), workspacePolicy: { requireWritable: false } }),
    readinessContext({ workspaceAuthorized: false }),
    evidenceTTL,
    nowIso
  );
  assert.equal(readOnly.unmetHardRequirements.find((entry) => entry.kind === "workspace").requirement, "workspace root");
});

test("readiness fails closed for missing harness and transport support", () => {
  const noHarness = evaluateProjectReadiness(
    readinessProfile(),
    readinessContext({ harnesses: [harness({ available: false, transports: ["native-cli", "acp-v1"] })] }),
    evidenceTTL,
    nowIso
  );
  assert.equal(noHarness.ready, false);
  assert.deepEqual(noHarness.unmetHardRequirements.map((unmet) => unmet.kind), ["harness", "transport"]);

  const noTransport = evaluateProjectReadiness(
    readinessProfile(),
    readinessContext({ harnesses: [harness({ transports: ["native-cli"] })] }),
    evidenceTTL,
    nowIso
  );
  assert.equal(noTransport.ready, false);
  assert.deepEqual(noTransport.unmetHardRequirements.map((unmet) => unmet.kind), ["transport"]);

  const defaultTransports = evaluateProjectReadiness(
    readinessProfile({ ...readinessProfile(), requirements: { ...readinessProfile().requirements, hard: {
      ...readinessProfile().requirements.hard, transports: ["native-cli"]
    } } }),
    readinessContext({ harnesses: [harness()] }),
    evidenceTTL,
    nowIso
  );
  assert.equal(defaultTransports.ready, true, "an absent transports field means native-cli only");
});

test("readiness is deterministic regardless of evidence order", () => {
  const context = readinessContext();
  const first = evaluateProjectReadiness(readinessProfile(), context, evidenceTTL, nowIso);
  const second = evaluateProjectReadiness(
    readinessProfile(),
    { ...context, evidence: [...context.evidence].reverse() },
    evidenceTTL,
    nowIso
  );
  assert.equal(JSON.stringify(second), JSON.stringify(first));

  const profileInput = readinessProfile();
  const contextInput = readinessContext();
  evaluateProjectReadiness(profileInput, contextInput, evidenceTTL, nowIso);
  assert.deepEqual(profileInput, readinessProfile(), "the profile is never mutated");
  assert.deepEqual(contextInput, readinessContext(), "the context is never mutated");
});
