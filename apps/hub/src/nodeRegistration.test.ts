import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ComputeNode, HarnessProfile } from "@coffee-shop/protocol";
import { registeredComputeNode } from "./nodeRegistration.js";
import { Store } from "./store.js";

const at = "2026-09-22T12:00:00.000Z";

function harness(id: HarnessProfile["id"], overrides: Partial<HarnessProfile> = {}): HarnessProfile {
  return { id, label: id, description: "", available: true, authMode: "local-account", models: ["default"], ...overrides };
}

function reportedNode(harnesses: HarnessProfile[]): ComputeNode {
  return {
    id: "node-one", name: "Node one", kind: "local", platform: "linux · amd64", status: "offline", lastSeen: "2026-09-01T00:00:00.000Z",
    activeRuns: 0, concurrency: 2, workspaceRoots: ["/workspace"], harnesses, version: "test"
  };
}

test("registration records each harness's reported approval policy and marks the node online", () => {
  const node = registeredComputeNode(reportedNode([
    harness("claude-cli", { approvalPolicy: "bypass" }),
    harness("codex-cli", { approvalPolicy: "auto" }),
    harness("shell")
  ]), at);
  assert.equal(node.status, "online");
  assert.equal(node.lastSeen, at);
  assert.deepEqual(node.harnesses.map((item) => item.approvalPolicy), ["bypass", "auto", undefined]);
  assert.equal(Object.hasOwn(node.harnesses[2], "approvalPolicy"), false, "an older Barista's profile stays unchanged");
});

test("registration marks an approval policy this hub does not recognize instead of showing manual", () => {
  const unrecognized = { ...harness("codex-cli"), approvalPolicy: "yolo" } as unknown as HarnessProfile;
  const node = registeredComputeNode(reportedNode([unrecognized]), at);
  assert.equal(Object.hasOwn(node.harnesses[0], "approvalPolicy"), false);
  assert.equal(node.harnesses[0].approvalPolicyUnrecognized, true);
  assert.equal(node.harnesses[0].id, "codex-cli");
});

test("registration ignores an unrecognized-policy marker reported by Barista", () => {
  const node = registeredComputeNode(reportedNode([harness("claude-cli", { approvalPolicyUnrecognized: true })]), at);
  assert.equal(Object.hasOwn(node.harnesses[0], "approvalPolicyUnrecognized"), false);
});

test("a registered approval policy persists and loads again", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "coffee-shop-registration-")), "state.json");
  const first = new Store(path);
  await first.load();
  await first.transact((state) => {
    state.nodes.push(registeredComputeNode(reportedNode([harness("claude-cli", { approvalPolicy: "bypass" })]), at));
  });
  const second = new Store(path);
  await second.load();
  assert.equal(second.snapshot().nodes[0].harnesses[0].approvalPolicy, "bypass");
});
