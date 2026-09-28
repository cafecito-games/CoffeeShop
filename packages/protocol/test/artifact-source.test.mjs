import assert from "node:assert/strict";
import test from "node:test";
import {
  artifactMaximumBytes,
  artifactSource,
  artifactSourceKey,
  ordinaryArtifactKinds,
  validateArtifact
} from "../dist/index.js";

const base = {
  id: "artifact-one",
  threadId: "thread-one",
  relativePath: "reports/result.txt",
  title: "Result",
  kind: "report",
  mediaType: "text/plain",
  summary: "Ready",
  size: 5,
  sha256: "a".repeat(64),
  downloadPath: "/api/artifacts/artifact-one/content",
  uploaded: true,
  idempotencyKey: "result-one",
  createdAt: "2026-09-28T12:00:00.000Z"
};

const runArtifact = { ...base, runId: "run-one", agentId: "agent-one" };
const externalArtifact = { ...base, sourceKey: "orchestrator-client:client-one" };

test("ordinary artifact kinds are closed and exclude preview bundles", () => {
  assert.deepEqual([...ordinaryArtifactKinds], ["patch", "report", "test-results", "log", "image", "other"]);
  assert.equal(artifactMaximumBytes, 10 * 1024 * 1024);
});

test("the shared artifact source helper accepts legacy run and canonical external identities", () => {
  assert.deepEqual(artifactSource(runArtifact), {
    ok: true,
    value: { kind: "run", sourceKey: "run:run-one", runId: "run-one", agentId: "agent-one" }
  });
  assert.equal(artifactSourceKey(runArtifact), "run:run-one");
  assert.equal(artifactSource({ ...runArtifact, sourceKey: "run:run-one" }).ok, true);
  assert.deepEqual(artifactSource(externalArtifact), {
    ok: true,
    value: { kind: "external", sourceKey: "orchestrator-client:client-one", clientId: "client-one" }
  });
  assert.equal(artifactSourceKey(externalArtifact), "orchestrator-client:client-one");
});

test("artifact producer identity fails closed for every missing, mixed, or malformed shape", () => {
  const rejected = [
    base,
    { ...base, sourceKey: "operator" },
    { ...base, sourceKey: "orchestrator-client:" },
    { ...base, sourceKey: "orchestrator-client:client:one" },
    { ...externalArtifact, runId: "run-one" },
    { ...externalArtifact, agentId: "agent-one" },
    { ...externalArtifact, instanceId: "instance-one", allocationId: "allocation-one" },
    { ...runArtifact, sourceKey: "run:another-run" },
    { ...runArtifact, sourceKey: "orchestrator-client:client-one" },
    { ...runArtifact, agentId: undefined },
    { ...runArtifact, instanceId: "instance-one", allocationId: "allocation-one" },
    { ...base, runId: "run-one", instanceId: "instance-one" },
    { ...base, runId: "run-one", allocationId: "allocation-one" }
  ];
  for (const value of rejected) {
    assert.equal(artifactSource(value).ok, false, JSON.stringify(value));
    assert.equal(artifactSourceKey(value), undefined, JSON.stringify(value));
    assert.equal(validateArtifact(value).ok, false, JSON.stringify(value));
  }
});

test("the shared artifact validator accepts both producer classes and rejects undeclared or preview-external records", () => {
  assert.equal(validateArtifact(runArtifact).ok, true);
  assert.equal(validateArtifact(externalArtifact).ok, true);
  assert.equal(validateArtifact({ ...externalArtifact, kind: "preview-bundle" }).ok, false);
  assert.equal(validateArtifact({ ...externalArtifact, extra: true }).ok, false);
  assert.equal(validateArtifact({ ...externalArtifact, size: artifactMaximumBytes + 1 }).ok, false);
  assert.equal(validateArtifact({ ...externalArtifact, sha256: "A".repeat(64) }).ok, false);
});
