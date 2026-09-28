import assert from "node:assert/strict";
import test from "node:test";
import {
  forgetCapabilityPackReadiness,
  getCapabilityPackReadiness,
  matchesCapabilityPackExpectation,
  receiveCapabilityPackReadiness
} from "./capabilityPackReadiness.js";

const report = (observedAt = "2026-09-28T12:00:00Z") => ({
  nodeId: "node-one", observedAt, status: "available" as const,
  pack: { id: "coffee-shop-core", version: "1.0.0", skills: ["preview", "review"] },
  surfaces: [{ harnessId: "codex-cli" as const, transport: "native-cli" as const }]
});

test("run-start proof matches exact identity and a covering full skill set", () => {
  const expected = { id: "coffee-shop-core", version: "1.0.0", requiredSkills: ["review"] };
  const selection = { requestedTransport: "native-cli" as const, selectedTransport: "native-cli" as const,
    effectiveCapabilityPack: { id: "coffee-shop-core", version: "1.0.0", skills: ["preview", "review"] } };
  assert.equal(matchesCapabilityPackExpectation(expected, selection, report(), "codex-cli"), true);
  assert.equal(matchesCapabilityPackExpectation(expected, undefined, report(), "codex-cli"), false);
  assert.equal(matchesCapabilityPackExpectation(expected, selection, undefined, "codex-cli"), false);
  assert.equal(matchesCapabilityPackExpectation(expected, selection, report(), "claude-cli"), false);
  assert.equal(matchesCapabilityPackExpectation(expected, { ...selection, selectedTransport: "acp-v1" }, report(), "codex-cli"), false);
  assert.equal(matchesCapabilityPackExpectation(expected, { ...selection, effectiveCapabilityPack: { ...selection.effectiveCapabilityPack, version: "2.0.0" } }, report(), "codex-cli"), false);
  assert.equal(matchesCapabilityPackExpectation(expected, { ...selection, effectiveCapabilityPack: { ...selection.effectiveCapabilityPack, skills: ["preview"] } }, report(), "codex-cli"), false);
  assert.equal(matchesCapabilityPackExpectation(expected, selection, { ...report(), pack: { ...report().pack, skills: ["preview"] } }, "codex-cli"), false);
});

test("readiness belongs only to the current capable socket and clears explicitly", () => {
  forgetCapabilityPackReadiness("node-one");
  let current = true;
  const connection = { supportsCapability: true, isCurrent: () => current, nodeId: "node-one" };
  assert.deepEqual(receiveCapabilityPackReadiness(connection, report()), { kind: "accepted", changed: true });
  assert.deepEqual(getCapabilityPackReadiness("node-one"), report());
  assert.deepEqual(receiveCapabilityPackReadiness(connection, report()), { kind: "replayed", changed: false });
  assert.deepEqual(receiveCapabilityPackReadiness(connection, report("2026-09-28T11:59:59Z")), { kind: "older", changed: false });
  current = false;
  assert.deepEqual(receiveCapabilityPackReadiness(connection, report("2026-09-28T12:00:01Z")), { kind: "ignored", changed: false });
  assert.equal(forgetCapabilityPackReadiness("node-one"), true);
  assert.equal(getCapabilityPackReadiness("node-one"), undefined);
});

test("readiness fails closed for identity, capability, and conflicting evidence", () => {
  forgetCapabilityPackReadiness("node-one");
  const connection = { supportsCapability: true, isCurrent: () => true, nodeId: "node-one" };
  assert.equal(receiveCapabilityPackReadiness(connection, { ...report(), nodeId: "node-two" }).kind, "rejected");
  assert.equal(receiveCapabilityPackReadiness({ ...connection, supportsCapability: false }, report()).kind, "ignored");
  assert.equal(receiveCapabilityPackReadiness(connection, report()).kind, "accepted");
  assert.equal(receiveCapabilityPackReadiness(connection, { ...report(), status: "unavailable", pack: undefined }).kind, "rejected");
  assert.equal(getCapabilityPackReadiness("node-one")?.status, "available");
  forgetCapabilityPackReadiness("node-one");
});
