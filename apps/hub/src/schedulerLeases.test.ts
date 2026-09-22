import assert from "node:assert/strict";
import test from "node:test";
import type {
  Agent,
  ComputeNode,
  ControlProtocolVersion,
  ExecutionRequirements,
  HubToControlAgent,
  NodeCapabilityEvidence,
  NodeCapabilityReport,
  ProjectProfile,
  Task,
  Thread
} from "@coffee-shop/protocol";
import { applyRunLifecycle } from "./lifecycle.js";
import { dispatchMessageFor, runSchedulingPass, type NodeConnection, type SchedulingContext } from "./scheduler.js";
import type { State } from "./store.js";

const at = "2026-09-21T12:00:00.000Z";
const staleObservedAt = "2026-09-21T11:29:00.000Z";

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id, name: id, title: id, summary: "", glyph: id[0].toUpperCase(),
    avatarShape: "cup", avatarColor: "amber", state: "idle", currentAction: "Available",
    harnessId: "codex-cli", model: "default", computeNodeId: `node-${id}`, workspace: `/workspace/${id}`,
    systemPrompt: "Work carefully", unread: 0, updatedAt: at, skills: [], ...overrides
  };
}

function node(id: string, overrides: Partial<ComputeNode> = {}): ComputeNode {
  return {
    id, name: id, kind: "local", platform: "linux · amd64", status: "online", lastSeen: at, activeRuns: 0,
    concurrency: 2, workspaceRoots: ["/workspace"], version: "test",
    harnesses: [{ id: "codex-cli", label: "Codex", description: "", available: true, authMode: "local-account", models: [] }],
    ...overrides
  };
}

function thread(id = "thread-one"): Thread {
  return { id, title: id, objective: id, summary: "", status: "active", ownerAgentId: "orchestrator", createdBy: "user", createdAt: at, updatedAt: at };
}

function task(id: string, requirements: ExecutionRequirements = {}, overrides: Partial<Task> = {}): Task {
  return {
    id, threadId: "thread-one", title: `Task ${id}`, instructions: `Do ${id}`, status: "ready", requirements,
    dependencies: [], idempotencyKey: "batch", attemptRunIds: [], createdAt: at, updatedAt: at, ...overrides
  };
}

function evidence(capabilityId: string, normalizedValue: string, overrides: Partial<NodeCapabilityEvidence> = {}): NodeCapabilityEvidence {
  return { capabilityId, source: "runtime", success: true, normalizedValue, observedAt: at, ...overrides };
}

function report(nodeId: string, entries: NodeCapabilityEvidence[]): NodeCapabilityReport {
  return { nodeId, evidence: entries, at };
}

function profile(id: string, overrides: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    schemaVersion: 1, id, name: id,
    repository: { url: "https://example.com/org/repo.git", defaultBranch: "main" },
    workspacePolicy: { requireWritable: false, isolation: "git-worktree", cleanup: "when-unchanged" },
    requirements: { hard: {} }, ...overrides
  };
}

interface Fixture {
  state: State;
  connections: Map<string, NodeConnection>;
  reports: Map<string, NodeCapabilityReport>;
  profiles: Map<string, ProjectProfile>;
  refuseDelivery: Set<string>;
  dispatches: HubToControlAgent[];
}

function fixture(agents: Agent[], nodes: ComputeNode[], tasks: Task[]): Fixture {
  const connections = new Map(nodes.map((item) => [item.id, { protocolVersion: "4" as ControlProtocolVersion, synced: true }]));
  return {
    state: { agents, nodes, runs: [], events: [], messages: [], threads: [thread()], tasks },
    connections,
    reports: new Map(),
    profiles: new Map(),
    refuseDelivery: new Set(),
    dispatches: []
  };
}

function context(current: Fixture): SchedulingContext {
  return {
    connection: (nodeId) => current.connections.get(nodeId),
    capabilityReport: (nodeId) => current.reports.get(nodeId),
    projectProfile: (projectId) => current.profiles.get(projectId),
    canDeliver: (nodeId, message: HubToControlAgent) => {
      if (current.refuseDelivery.has(nodeId) || message.type !== "dispatch") return false;
      current.dispatches.push(message);
      return true;
    }
  };
}

const taskById = (current: Fixture, id: string) => current.state.tasks!.find((item) => item.id === id)!;
const attemptRun = (current: Fixture, taskId: string) => current.state.runs.find((run) => run.id === taskById(current, taskId).assignment?.runId);

function leasedFixture(tasks: Task[], isolation: "git-worktree" | "exclusive-existing" = "git-worktree", nodeOverrides: Partial<ComputeNode> = {}): Fixture {
  const current = fixture([agent("alpha")], [node("node-alpha", { concurrency: 2, ...nodeOverrides })], tasks);
  current.profiles.set("proj", profile("proj", isolation === "git-worktree"
    ? {}
    : { repository: undefined, workspacePolicy: { requireWritable: false, isolation: "exclusive-existing", cleanup: "when-unchanged" } }));
  current.reports.set("node-alpha", report("node-alpha", [evidence(`workspace-lease:${isolation}`, "true")]));
  return current;
}

test("a git-worktree profile grants one concurrent leased attempt per task to the same agent", () => {
  const current = leasedFixture([task("one", { projectProfileId: "proj" }), task("two", { projectProfileId: "proj" })]);
  const result = runSchedulingPass(current.state, context(current), at);
  assert.deepEqual(result.attempts.map((attempt) => attempt.taskId), ["one", "two"]);

  const leases = current.state.workspaceLeases!;
  assert.equal(leases.length, 2);
  assert.notEqual(leases[0].branch, leases[1].branch);
  assert.notEqual(leases[0].worktreePath, leases[1].worktreePath);
  assert.deepEqual(leases.map((item) => item.worktreePath), leases.map((item) => `/workspace/.coffee-shop/worktrees/${item.id}`));

  for (const id of ["one", "two"]) {
    const run = attemptRun(current, id)!;
    const lease = leases.find((item) => item.taskId === id)!;
    assert.equal(taskById(current, id).status, "assigned");
    assert.equal(run.workspaceLeaseId, lease.id);
    assert.equal(taskById(current, id).assignment!.workspaceLeaseId, lease.id);
    assert.equal(run.workspace, lease.worktreePath);
    assert.equal(lease.branch, `coffee-shop/${id}/${run.id}`);
    assert.equal(lease.baseRevision, "refs/heads/main");
    assert.equal(lease.repository, "https://example.com/org/repo");
    assert.equal(lease.root, "/workspace");
    assert.equal(lease.sourcePath, "/workspace/alpha");
    assert.equal(lease.status, "requested");
    assert.equal(lease.cleanup, "when-unchanged");
  }

  const grants = current.dispatches.flatMap((message) => (message.type === "dispatch" && message.execution ? [message.execution] : []));
  assert.deepEqual(grants.map((execution) => execution.taskId), ["one", "two"]);
  for (const execution of grants) {
    const run = current.state.runs.find((item) => item.workspaceLeaseId === execution.workspaceLease?.id);
    assert.equal(execution.workspaceLease?.status, "requested");
    assert.equal(execution.workspaceLease?.id, run?.workspaceLeaseId);
    assert.equal(execution.workspaceLease?.worktreePath, run?.workspace);
  }
});

test("missing workspace-lease evidence keeps the task ready with a workspace diagnostic", () => {
  const current = fixture([agent("alpha")], [node("node-alpha")], [task("one", { projectProfileId: "proj" })]);
  current.profiles.set("proj", profile("proj"));
  const result = runSchedulingPass(current.state, context(current), at);
  assert.deepEqual(result.attempts, []);
  assert.equal(current.state.runs.length, 0);
  assert.equal(current.state.workspaceLeases, undefined);
  assert.equal(taskById(current, "one").status, "ready");
  assert.ok(taskById(current, "one").placement?.unsatisfied.some((entry) =>
    entry.kind === "workspace" && entry.requirement === "git-worktree workspace lease" && entry.detail === "no worker-reported evidence"));
});

test("stale workspace-lease evidence keeps the task ready", () => {
  const current = fixture([agent("alpha")], [node("node-alpha")], [task("one", { projectProfileId: "proj" })]);
  current.profiles.set("proj", profile("proj"));
  current.reports.set("node-alpha", report("node-alpha", [evidence("workspace-lease:git-worktree", "true", { observedAt: staleObservedAt })]));
  const result = runSchedulingPass(current.state, context(current), at);
  assert.deepEqual(result.attempts, []);
  assert.equal(current.state.runs.length, 0);
  assert.ok(taskById(current, "one").placement?.unsatisfied.some((entry) => entry.kind === "inventory-stale"));
});

test("an exclusive-existing workspace serves one task at a time", () => {
  const current = leasedFixture([task("one", { projectProfileId: "proj" }), task("two", { projectProfileId: "proj" })], "exclusive-existing", { concurrency: 4 });
  const first = runSchedulingPass(current.state, context(current), at);
  assert.deepEqual(first.attempts.map((attempt) => attempt.taskId), ["one"]);
  assert.equal(current.state.workspaceLeases!.length, 1);
  assert.equal(current.state.workspaceLeases![0].worktreePath, "/workspace/alpha");
  assert.equal(taskById(current, "two").status, "ready");
  assert.ok(taskById(current, "two").placement?.unsatisfied.some((entry) => entry.kind === "capacity" && entry.requirement === "exclusive workspace"));
  assert.equal(current.state.runs.length, 1);

  const run = attemptRun(current, "one")!;
  applyRunLifecycle(current.state, { type: "run.started", runId: run.id, at });
  applyRunLifecycle(current.state, { type: "run.completed", runId: run.id, output: "done", at });
  current.state.workspaceLeases![0].status = "cleaned";
  const second = runSchedulingPass(current.state, context(current), at);
  assert.deepEqual(second.attempts.map((attempt) => attempt.taskId), ["two"]);
  assert.equal(current.state.workspaceLeases!.length, 2);
  assert.equal(current.state.workspaceLeases![1].status, "requested");
  assert.equal(taskById(current, "two").status, "assigned");
});

test("a non-worktree attempt blocks the agent's workspace, a git-worktree attempt does not", () => {
  const plain = fixture([agent("alpha")], [node("node-alpha", { concurrency: 2 })], [task("one"), task("two")]);
  runSchedulingPass(plain.state, context(plain), at);
  assert.deepEqual(runSchedulingPass(plain.state, context(plain), at).attempts, []);
  assert.equal(taskById(plain, "two").status, "ready");
  assert.ok(taskById(plain, "two").placement?.unsatisfied.some((entry) => entry.kind === "capacity" && entry.requirement === "idle agent"));

  const isolated = leasedFixture([task("one", { projectProfileId: "proj" })]);
  runSchedulingPass(isolated.state, context(isolated), at);
  isolated.state.tasks!.push(task("two"));
  const second = runSchedulingPass(isolated.state, context(isolated), at);
  assert.deepEqual(second.attempts.map((attempt) => attempt.taskId), ["two"]);
  assert.equal(isolated.state.runs.length, 2);
  assert.equal(attemptRun(isolated, "two")!.workspaceLeaseId, undefined);
  assert.equal(taskById(isolated, "two").assignment!.workspaceLeaseId, undefined);
});

test("a settled or foreign lease never travels with a dispatch", () => {
  const current = leasedFixture([task("one", { projectProfileId: "proj" })]);
  runSchedulingPass(current.state, context(current), at);
  const run = attemptRun(current, "one")!;
  const agent = current.state.agents[0];
  const leases = current.state.workspaceLeases!;

  const granted = dispatchMessageFor(run, agent, current.state.agents, leases);
  assert.equal(granted.execution?.workspaceLease?.id, run.workspaceLeaseId);
  assert.equal(granted.execution?.workspaceLease?.status, "requested");

  leases[0].status = "released";
  assert.equal(dispatchMessageFor(run, agent, current.state.agents, leases).execution?.workspaceLease, undefined);

  leases[0].status = "requested";
  leases[0].runId = "run-other";
  assert.equal(dispatchMessageFor(run, agent, current.state.agents, leases).execution?.workspaceLease, undefined);

  leases[0].runId = run.id;
  leases[0].status = "cleaned";
  assert.equal(dispatchMessageFor(run, agent, current.state.agents, leases).execution?.workspaceLease, undefined);
  assert.equal(run.workspaceLeaseId, leases[0].id);
});

test("a profile without isolation schedules exactly as before", () => {
  const current = fixture([agent("alpha")], [node("node-alpha", { concurrency: 4 })], [
    task("one", { projectProfileId: "proj" }),
    task("two", { projectProfileId: "proj" })
  ]);
  current.profiles.set("proj", profile("proj", { workspacePolicy: { requireWritable: false } }));
  const first = runSchedulingPass(current.state, context(current), at);
  assert.deepEqual(first.attempts.map((attempt) => attempt.taskId), ["one"]);
  assert.equal(current.state.workspaceLeases, undefined);
  assert.equal(attemptRun(current, "one")!.workspaceLeaseId, undefined);
  assert.equal(taskById(current, "one").assignment!.workspaceLeaseId, undefined);

  assert.deepEqual(runSchedulingPass(current.state, context(current), at).attempts, []);
  assert.equal(taskById(current, "two").status, "ready");
  assert.ok(taskById(current, "two").placement?.unsatisfied.some((entry) => entry.kind === "capacity" && entry.requirement === "idle agent"));
  assert.equal(current.state.runs.length, 1);
});
