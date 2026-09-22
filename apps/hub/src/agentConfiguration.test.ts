import assert from "node:assert/strict";
import test from "node:test";
import type { Agent, ComputeNode, Run } from "@coffee-shop/protocol";
import { createConfiguredAgent, markDisconnectedNodesOffline, openConnectionLookup, updateConfiguredAgent, type AgentConfigurationState } from "./agentConfiguration.js";

const node = (overrides: Partial<ComputeNode> = {}): ComputeNode => ({
  id: "node-one",
  name: "Desk",
  kind: "local",
  platform: "darwin",
  status: "online",
  lastSeen: "2026-01-01T00:00:00Z",
  activeRuns: 0,
  concurrency: 2,
  workspaceRoots: ["/workspace", "/srv/projects"],
  harnesses: [
    { id: "codex-cli", label: "Codex", description: "Codex", available: true, authMode: "local-account", models: ["gpt-5", "gpt-5-mini"] },
    { id: "claude-cli", label: "Claude", description: "Claude", available: false, authMode: "local-subscription", models: ["sonnet"] },
    { id: "shell", label: "Shell", description: "Shell", available: true, authMode: "none", models: [] }
  ],
  version: "test",
  ...overrides
});

const agent = (): Agent => ({
  id: "milo",
  name: "Milo",
  title: "Builder",
  summary: "Builds things",
  glyph: "M",
  avatarShape: "cup",
  avatarColor: "amber",
  state: "idle",
  currentAction: "Available",
  harnessId: "codex-cli",
  model: "gpt-5",
  computeNodeId: "node-one",
  workspace: "/workspace/project",
  systemPrompt: "Build carefully.",
  unread: 0,
  updatedAt: "2026-01-01T00:00:00Z"
});

const run = (status: Run["status"], id: string): Run => ({
  id,
  agentId: "milo",
  nodeId: "node-one",
  harnessId: "codex-cli",
  model: "gpt-5",
  workspace: "/workspace/project",
  prompt: "Original prompt",
  status,
  output: "Original output",
  depth: 0,
  createdAt: "2026-01-01T00:00:00Z"
});

function state(nodes = [node()]): AgentConfigurationState {
  return {
    agents: [agent()],
    nodes,
    runs: [run("queued", "queued"), run("running", "running"), run("completed", "completed")]
  };
}

function connected(current: AgentConfigurationState) {
  return new Set(current.nodes.filter((item) => item.status !== "offline").map((item) => item.id));
}

const createInput = {
  name: " Scout ",
  title: " Researcher ",
  summary: " Finds facts ",
  computeNodeId: "node-one",
  harnessId: "codex-cli",
  model: "gpt-5-mini",
  workspace: "/workspace/scout",
  systemPrompt: " Verify every claim. ",
  avatarShape: "bean",
  avatarColor: "sage",
  canDelegate: false
};

test("creates a normalized agent from a node-advertised configuration", () => {
  const current = state();
  const result = createConfiguredAgent(current, createInput, "2026-02-01T00:00:00Z", connected(current), () => "scout");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.agent, {
    id: "scout",
    name: "Scout",
    title: "Researcher",
    summary: "Finds facts",
    glyph: "S",
    avatarShape: "bean",
    avatarColor: "sage",
    canDelegate: false,
    skills: [],
    state: "idle",
    currentAction: "Available",
    harnessId: "codex-cli",
    model: "gpt-5-mini",
    computeNodeId: "node-one",
    workspace: "/workspace/scout",
    systemPrompt: "Verify every claim.",
    unread: 0,
    updatedAt: "2026-02-01T00:00:00Z"
  });
  assert.equal(current.agents.at(-1), result.agent);
});

test("fails closed for malformed or unadvertised creation fields", () => {
  const cases: [string, AgentConfigurationState, unknown][] = [
    ["unknown field", state(), { ...createInput, surprise: "value" }],
    ["non-string field", state(), { ...createInput, name: 42 }],
    ["empty name", state(), { ...createInput, name: "  " }],
    ["empty title", state(), { ...createInput, title: "" }],
    ["empty system prompt", state(), { ...createInput, systemPrompt: "\n" }],
    ["unknown node", state(), { ...createInput, computeNodeId: "gone" }],
    ["offline stale node", state([node({ status: "offline" })]), createInput],
    ["unavailable harness", state(), { ...createInput, harnessId: "claude-cli", model: "sonnet" }],
    ["unadvertised harness", state(), { ...createInput, harnessId: "ag-ui" }],
    ["unrecognized advertised harness", state([node({ harnesses: [{ ...node().harnesses[0], id: "future-harness" } as unknown as ComputeNode["harnesses"][number]] })]), { ...createInput, harnessId: "future-harness" }],
    ["unadvertised model", state(), { ...createInput, model: "gpt-4" }],
    ["non-default model for empty model list", state(), { ...createInput, harnessId: "shell", model: "shell-v1" }],
    ["relative workspace", state(), { ...createInput, workspace: "project" }],
    ["workspace outside roots", state(), { ...createInput, workspace: "/workspace-other/project" }],
    ["empty roots", state([node({ workspaceRoots: [] })]), createInput]
  ];

  for (const [label, current, input] of cases) {
    const before = structuredClone(current);
    const result = createConfiguredAgent(current, input, "2026-02-01T00:00:00Z", connected(current), () => "scout");
    assert.equal(result.ok, false, label);
    assert.deepEqual(current, before, label);
  }
});

test("allows only provider default when a profile advertises no models", () => {
  const current = state();
  const result = createConfiguredAgent(current, { ...createInput, harnessId: "shell", model: "default" }, "2026-02-01T00:00:00Z", connected(current), () => "scout");
  assert.equal(result.ok, true);
});

test("validates the final combined PATCH atomically and preserves every run snapshot", () => {
  const current = state([
    node(),
    node({ id: "node-two", workspaceRoots: ["/other"], harnesses: [{ id: "shell", label: "Shell", description: "Shell", available: true, authMode: "none", models: [] }] })
  ]);
  const before = structuredClone(current);
  const result = updateConfiguredAgent(current, "milo", { computeNodeId: "node-two" }, "2026-02-01T00:00:00Z", connected(current));
  assert.equal(result.ok, false);
  assert.deepEqual(current, before);

  const runs = structuredClone(current.runs);
  const valid = updateConfiguredAgent(current, "milo", {
    name: " Nova ",
    title: "Operator",
    summary: "Coordinates work",
    computeNodeId: "node-two",
    harnessId: "shell",
    model: "default",
    workspace: "/other/project",
    systemPrompt: "Coordinate carefully."
  }, "2026-02-01T00:00:00Z", connected(current));
  assert.equal(valid.ok, true);
  if (!valid.ok) return;
  assert.equal(valid.changed, true);
  assert.equal(valid.agent.name, "Nova");
  assert.equal(valid.agent.glyph, "N");
  assert.deepEqual(current.runs, runs);
});

test("rejects unknown/non-string PATCH fields and treats a replay as a no-op", () => {
  for (const patch of [{ title: null }, { state: "working" }]) {
    const current = state();
    const before = structuredClone(current);
    const result = updateConfiguredAgent(current, "milo", patch, "2026-02-01T00:00:00Z", connected(current));
    assert.equal(result.ok, false);
    assert.deepEqual(current, before);
  }

  const current = state();
  const first = updateConfiguredAgent(current, "milo", { title: "Architect" }, "2026-02-01T00:00:00Z", connected(current));
  const afterFirst = structuredClone(current);
  const replay = updateConfiguredAgent(current, "milo", { title: "Architect" }, "2026-02-02T00:00:00Z", connected(current));
  assert.equal(first.ok && first.changed, true);
  assert.equal(replay.ok && replay.changed, false);
  assert.deepEqual(current, afterFirst);
});

test("distinguishes a missing agent without mutating state", () => {
  const current = state();
  const before = structuredClone(current);
  assert.deepEqual(updateConfiguredAgent(current, "gone", { title: "Nope" }, "now", connected(current)), { ok: false, kind: "not-found", error: "Agent not found" });
  assert.deepEqual(current, before);
});

test("fails closed after restart when persisted online nodes have no live connection", () => {
  const current = state([node({ status: "online", activeRuns: 2 })]);
  const runs = structuredClone(current.runs);
  assert.equal(markDisconnectedNodesOffline(current, new Set()), true);
  assert.equal(current.nodes[0].status, "offline");
  assert.equal(current.nodes[0].activeRuns, 0);

  const beforeCreate = structuredClone(current);
  const created = createConfiguredAgent(current, createInput, "later", new Set(), () => "scout");
  assert.equal(created.ok, false);
  assert.deepEqual(current, beforeCreate);
  const updated = updateConfiguredAgent(current, "milo", { title: "Changed" }, "later", new Set());
  assert.equal(updated.ok, false);
  assert.deepEqual(current.runs, runs);
  assert.equal(current.agents[0].title, "Builder");
});

test("treats mapped non-open sockets as disconnected for configuration saves", () => {
  const current = state([node({ status: "online" })]);
  const connections = new Map([["node-one", { readyState: 2 }]]);
  const liveNodes = openConnectionLookup(connections, 1);
  const before = structuredClone(current);

  assert.equal(createConfiguredAgent(current, createInput, "later", liveNodes, () => "scout").ok, false);
  assert.equal(updateConfiguredAgent(current, "milo", { title: "Changed" }, "later", liveNodes).ok, false);
  assert.deepEqual(current, before);
});

test("normalizes agent skills into a sorted set of lowercase identifiers", () => {
  const current = state();
  const result = createConfiguredAgent(current, { ...createInput, skills: [" Rust ", "review", "rust"] }, "2026-02-01T00:00:00Z", connected(current), () => "scout");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.agent.skills, ["review", "rust"]);
  const unchanged = updateConfiguredAgent(current, "scout", { skills: ["rust", "review"] }, "2026-02-02T00:00:00Z", connected(current));
  assert.equal(unchanged.ok && unchanged.changed, false);
  const changed = updateConfiguredAgent(current, "scout", { skills: [] }, "2026-02-02T00:00:00Z", connected(current));
  assert.equal(changed.ok && changed.changed, true);
  assert.deepEqual(current.agents.find((item) => item.id === "scout")?.skills, []);
});

test("rejects malformed agent skills without echoing the submitted value", () => {
  const current = state();
  for (const skills of ["rust", [42], ["has space"], ["sk-secret value"], ["a".repeat(65)], Array.from({ length: 33 }, (_, index) => `skill-${index}`)]) {
    const result = createConfiguredAgent(current, { ...createInput, skills }, "2026-02-01T00:00:00Z", connected(current), () => "scout");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.includes("secret"), false);
  }
});
