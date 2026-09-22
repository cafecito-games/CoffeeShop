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
  Run,
  Task,
  Thread
} from "@coffee-shop/protocol";
import { applyRunLifecycle, cancelRunInState, failLostTaskAttempts, lostComputeError, maximumTaskAttempts, queuedRunsForNode } from "./lifecycle.js";
import { dispatchMessageFor, placeTask, runSchedulingPass, type NodeConnection, type PlacementEnvironment, type SchedulingContext } from "./scheduler.js";
import type { State } from "./store.js";
import { cancelTaskInState } from "./tasks.js";

const at = "2026-09-21T12:00:00.000Z";

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

interface Fixture {
  state: State;
  connections: Map<string, NodeConnection>;
  reports: Map<string, NodeCapabilityReport>;
  profiles: Map<string, ProjectProfile>;
  refuseDelivery: Set<string>;
}

function fixture(agents: Agent[], nodes: ComputeNode[], tasks: Task[]): Fixture {
  const connections = new Map(nodes.map((item) => [item.id, { protocolVersion: "4" as ControlProtocolVersion, synced: true }]));
  return {
    state: { agents, nodes, runs: [], events: [], messages: [], threads: [thread()], tasks },
    connections,
    reports: new Map(),
    profiles: new Map(),
    refuseDelivery: new Set()
  };
}

function context(current: Fixture): SchedulingContext {
  return {
    connection: (nodeId) => current.connections.get(nodeId),
    capabilityReport: (nodeId) => current.reports.get(nodeId),
    projectProfile: (projectId) => current.profiles.get(projectId),
    canDeliver: (nodeId, message: HubToControlAgent) => !current.refuseDelivery.has(nodeId) && message.type === "dispatch"
  };
}

function environment(current: Fixture): PlacementEnvironment {
  return {
    agents: current.state.agents,
    nodes: current.state.nodes,
    runs: current.state.runs,
    connection: (nodeId) => current.connections.get(nodeId),
    capabilityReport: (nodeId) => current.reports.get(nodeId),
    projectProfile: (projectId) => current.profiles.get(projectId),
    now: at
  };
}

const taskById = (current: Fixture, id: string) => current.state.tasks!.find((item) => item.id === id)!;
const attemptRun = (current: Fixture, taskId: string) => current.state.runs.find((run) => run.id === taskById(current, taskId).assignment?.runId);

test("places two independent ready tasks concurrently when two suitable slots exist", () => {
  const current = fixture([agent("alpha"), agent("beta")], [node("node-alpha"), node("node-beta")], [task("one"), task("two")]);
  const result = runSchedulingPass(current.state, context(current), at);
  assert.equal(result.changed, true);
  assert.deepEqual(result.attempts.map((attempt) => [attempt.taskId, attempt.nodeId, attempt.delivered]), [
    ["one", "node-alpha", true],
    ["two", "node-beta", true]
  ]);
  for (const id of ["one", "two"]) {
    const run = attemptRun(current, id)!;
    assert.equal(taskById(current, id).status, "assigned");
    assert.equal(run.taskId, id);
    assert.equal(run.attempt, 1);
    assert.equal(run.status, "queued");
    assert.equal(run.transport, "native-cli");
    assert.equal(run.dispatchedAt, at);
    assert.deepEqual(taskById(current, id).placement?.unsatisfied, []);
  }
});

test("persisted reservations prevent oversubscription before heartbeats catch up", () => {
  const shared = node("node-shared", { concurrency: 1 });
  const current = fixture([agent("alpha", { computeNodeId: "node-shared" }), agent("beta", { computeNodeId: "node-shared" })], [shared], [task("one"), task("two")]);
  const first = runSchedulingPass(current.state, context(current), at);
  assert.deepEqual(first.attempts.map((attempt) => attempt.taskId), ["one"]);
  assert.equal(taskById(current, "two").status, "ready");
  assert.equal(current.state.runs.length, 1);
  assert.ok(taskById(current, "two").placement?.unsatisfied.some((entry) => entry.kind === "capacity" && entry.nodeId === "node-shared"));

  const second = runSchedulingPass(current.state, context(current), at);
  assert.deepEqual(second.attempts, []);
  assert.equal(second.changed, false);
  assert.equal(current.state.runs.length, 1);

  const run = attemptRun(current, "one")!;
  assert.equal(applyRunLifecycle(current.state, { type: "run.started", runId: run.id, at }), true);
  assert.equal(applyRunLifecycle(current.state, { type: "run.completed", runId: run.id, output: "done", at }), true);
  const third = runSchedulingPass(current.state, context(current), at);
  assert.deepEqual(third.attempts.map((attempt) => attempt.taskId), ["two"]);
});

test("a heartbeat reporting more active runs than persisted reservations also holds capacity", () => {
  const current = fixture([agent("alpha")], [node("node-alpha", { concurrency: 1, activeRuns: 1 })], [task("one")]);
  assert.deepEqual(runSchedulingPass(current.state, context(current), at).attempts, []);
  assert.ok(taskById(current, "one").placement?.unsatisfied.some((entry) => entry.kind === "capacity"));
});

test("repeated scheduling passes create at most one active attempt per task", () => {
  const current = fixture([agent("alpha"), agent("beta")], [node("node-alpha"), node("node-beta")], [task("one")]);
  for (let pass = 0; pass < 5; pass += 1) runSchedulingPass(current.state, context(current), at);
  assert.equal(current.state.runs.length, 1);
  assert.deepEqual(taskById(current, "one").attemptRunIds, [current.state.runs[0].id]);
});

test("an agent holds at most one active task attempt", () => {
  const current = fixture([agent("alpha")], [node("node-alpha", { concurrency: 4 })], [task("one"), task("two")]);
  assert.deepEqual(runSchedulingPass(current.state, context(current), at).attempts.map((attempt) => attempt.taskId), ["one"]);
  assert.ok(taskById(current, "two").placement?.unsatisfied.some((entry) => entry.kind === "capacity" && entry.agentId === "alpha"));
});

test("version 1 to 3 nodes are ineligible for task attempts with a protocol-version diagnostic", () => {
  for (const version of ["1", "2", "3"] as const) {
    const current = fixture([agent("alpha")], [node("node-alpha")], [task("one")]);
    current.connections.set("node-alpha", { protocolVersion: version, synced: true });
    const result = runSchedulingPass(current.state, context(current), at);
    assert.deepEqual(result.attempts, []);
    assert.equal(current.state.runs.length, 0);
    assert.equal(taskById(current, "one").status, "ready");
    assert.deepEqual(taskById(current, "one").placement?.unsatisfied.map((entry) => entry.kind), ["protocol-version"]);
  }
});

test("offline and pre-sync nodes never receive task attempts", () => {
  const offline = fixture([agent("alpha")], [node("node-alpha")], [task("one")]);
  offline.connections.clear();
  runSchedulingPass(offline.state, context(offline), at);
  assert.equal(offline.state.runs.length, 0);
  assert.equal(taskById(offline, "one").placement?.unsatisfied[0].kind, "node-offline");

  const unsynced = fixture([agent("alpha")], [node("node-alpha")], [task("one")]);
  unsynced.connections.set("node-alpha", { protocolVersion: "4", synced: false });
  runSchedulingPass(unsynced.state, context(unsynced), at);
  assert.equal(unsynced.state.runs.length, 0);
  assert.match(taskById(unsynced, "one").placement!.unsatisfied[0].detail, /reconnect synchronization/);
});

test("placement does not depend on the order of agents, nodes, or runs", () => {
  const agents = [agent("gamma"), agent("alpha"), agent("beta")];
  const nodes = [node("node-gamma"), node("node-alpha"), node("node-beta")];
  const forward = fixture(agents, nodes, [task("one")]);
  const reversed = fixture([...agents].reverse(), [...nodes].reverse(), [task("one")]);
  const forwardDecision = placeTask(taskById(forward, "one"), environment(forward));
  const reversedDecision = placeTask(taskById(reversed, "one"), environment(reversed));
  assert.deepEqual(forwardDecision, reversedDecision);
  assert.equal(forwardDecision.kind === "assigned" && forwardDecision.candidate.agentId, "alpha");
});

test("a refused delivery records no dispatch decision and leaves the attempt for reconciliation", () => {
  const current = fixture([agent("alpha")], [node("node-alpha")], [task("one")]);
  current.refuseDelivery.add("node-alpha");
  const result = runSchedulingPass(current.state, context(current), at);
  assert.deepEqual(result.attempts.map((attempt) => attempt.delivered), [false]);
  const run = attemptRun(current, "one")!;
  assert.equal(run.dispatchedAt, undefined);
  assert.equal(current.state.agents[0].state, "waiting");
  assert.deepEqual(queuedRunsForNode({ ...current.state, generatedAt: at }, "node-alpha", [], "4").map((item) => item.id), [run.id]);
  assert.equal(runSchedulingPass(current.state, context(current), at).attempts.length, 0);
});

test("task attempts are dispatched with their version-4 execution", () => {
  const current = fixture([agent("alpha"), agent("beta")], [node("node-alpha")], [task("one")]);
  runSchedulingPass(current.state, context(current), at);
  const run = attemptRun(current, "one")!;
  const message = dispatchMessageFor(run, current.state.agents[0], current.state.agents);
  assert.deepEqual(message.execution, { transport: "native-cli", taskId: "one", attempt: 1 });
  assert.match(message.agent.systemPrompt, /Available teammates: beta \(beta\)/);
  const legacy = dispatchMessageFor({ ...run, taskId: undefined, attempt: undefined, transport: undefined }, current.state.agents[0], current.state.agents);
  assert.equal("execution" in legacy, false);
});

test("lost compute fails a running attempt retryably and the next pass creates a new attempt", () => {
  const current = fixture([agent("alpha")], [node("node-alpha")], [task("one")]);
  runSchedulingPass(current.state, context(current), at);
  const first = attemptRun(current, "one")!;
  applyRunLifecycle(current.state, { type: "run.started", runId: first.id, at });
  assert.equal(taskById(current, "one").status, "running");

  assert.deepEqual(failLostTaskAttempts(current.state, "node-alpha", [first.id], at), []);
  assert.equal(first.status, "running");

  const lost = failLostTaskAttempts(current.state, "node-alpha", [], at);
  assert.deepEqual(lost.map((run) => run.id), [first.id]);
  assert.equal(first.status, "failed");
  assert.equal(first.error, lostComputeError);
  assert.equal(taskById(current, "one").status, "ready");
  assert.equal(taskById(current, "one").assignment, undefined);

  runSchedulingPass(current.state, context(current), at);
  const second = attemptRun(current, "one")!;
  assert.notEqual(second.id, first.id);
  assert.equal(second.attempt, 2);
  assert.equal(taskById(current, "one").attemptRunIds.length, 2);
});

test("lost compute leaves queued attempts for redispatch and fails the task once the attempt budget is spent", () => {
  const current = fixture([agent("alpha")], [node("node-alpha")], [task("one")]);
  runSchedulingPass(current.state, context(current), at);
  assert.deepEqual(failLostTaskAttempts(current.state, "node-alpha", [], at), []);
  assert.equal(attemptRun(current, "one")!.status, "queued");

  for (let attempt = 1; attempt <= maximumTaskAttempts; attempt += 1) {
    const run = attemptRun(current, "one")!;
    applyRunLifecycle(current.state, { type: "run.started", runId: run.id, at });
    failLostTaskAttempts(current.state, "node-alpha", [], at);
    runSchedulingPass(current.state, context(current), at);
  }
  assert.equal(taskById(current, "one").status, "failed");
  assert.equal(taskById(current, "one").attemptRunIds.length, maximumTaskAttempts);
});

test("reconciliation never resurrects cancelled work", () => {
  const current = fixture([agent("alpha")], [node("node-alpha")], [task("one"), task("two")]);
  current.state.agents.push(agent("beta"));
  current.state.nodes.push(node("node-beta"));
  runSchedulingPass(current.state, context(current), at);
  const cancelledRun = attemptRun(current, "one")!;
  const cancellation = cancelTaskInState(current.state, "one", at);
  cancelRunInState(current.state, cancellation.activeAttemptRunId!, at);
  assert.equal(cancelledRun.status, "cancelled");
  assert.deepEqual(failLostTaskAttempts(current.state, "node-alpha", [], at), []);
  assert.deepEqual(queuedRunsForNode({ ...current.state, generatedAt: at }, "node-alpha", [], "4"), []);
  runSchedulingPass(current.state, context(current), at);
  assert.equal(taskById(current, "one").status, "cancelled");
  assert.equal(taskById(current, "one").attemptRunIds.length, 1);
});

test("a queued attempt that is no longer its task's assignment is never redispatched", () => {
  const current = fixture([agent("alpha")], [node("node-alpha")], [task("one")]);
  runSchedulingPass(current.state, context(current), at);
  const run = attemptRun(current, "one")!;
  taskById(current, "one").assignment = { ...taskById(current, "one").assignment!, runId: "run-other" };
  assert.deepEqual(queuedRunsForNode({ ...current.state, generatedAt: at }, "node-alpha", [], "4").filter((item) => item.id === run.id), []);
});

test("only authorized placement overrides narrow candidates, and they never bypass hard requirements", () => {
  const agents = [agent("alpha"), agent("beta", { skills: ["rust"] })];
  const nodes = [node("node-alpha"), node("node-beta")];

  const pinned = fixture(agents, nodes, [task("one", {}, { placementOverride: { agentId: "beta", authorizedBy: "operator" } })]);
  const pinnedDecision = placeTask(taskById(pinned, "one"), environment(pinned));
  assert.equal(pinnedDecision.kind === "assigned" && pinnedDecision.candidate.agentId, "beta");

  const unauthorized = fixture(agents, nodes, [task("one", {}, { placementOverride: { agentId: "beta", authorizedBy: "model" } as unknown as Task["placementOverride"] })]);
  const unauthorizedDecision = placeTask(taskById(unauthorized, "one"), environment(unauthorized));
  assert.equal(unauthorizedDecision.kind, "unsatisfied");
  assert.deepEqual(unauthorizedDecision.diagnostic.unsatisfied.map((entry) => entry.kind), ["agent"]);

  const conflicting = fixture(agents, nodes, [task("one", { skills: ["rust"] }, { placementOverride: { agentId: "alpha", authorizedBy: "operator" } })]);
  const conflictingDecision = placeTask(taskById(conflicting, "one"), environment(conflicting));
  assert.equal(conflictingDecision.kind, "unsatisfied");
  assert.deepEqual(conflictingDecision.diagnostic.unsatisfied.map((entry) => [entry.kind, entry.agentId]), [["skill", "alpha"]]);
});

test("inconsistent persisted assignments are surfaced and never dispatched", () => {
  const current = fixture([agent("alpha")], [node("node-alpha")], [
    task("one", {}, { status: "assigned", assignment: { runId: "run-missing", agentId: "alpha", nodeId: "node-alpha", harnessId: "codex-cli", transport: "native-cli", model: "default", assignedAt: at } })
  ]);
  const result = runSchedulingPass(current.state, context(current), at);
  assert.equal(result.changed, true);
  assert.deepEqual(result.attempts, []);
  assert.equal(taskById(current, "one").placement?.unsatisfied[0].kind, "assignment");
  assert.equal(runSchedulingPass(current.state, context(current), "2026-09-21T12:05:00.000Z").changed, false);
});

test("an unsatisfiable task stays ready with exact per-candidate diagnostics and no run", () => {
  const current = fixture([agent("alpha")], [node("node-alpha")], [task("one", { operatingSystems: ["darwin"], labels: ["gpu"] })]);
  current.reports.set("node-alpha", report("node-alpha", [evidence("os", "linux")]));
  const result = runSchedulingPass(current.state, context(current), at);
  assert.deepEqual(result.attempts, []);
  assert.equal(current.state.runs.length, 0);
  assert.equal(taskById(current, "one").status, "ready");
  assert.deepEqual(taskById(current, "one").placement, {
    evaluatedAt: at,
    eligibleNodeIds: [],
    unsatisfied: [
      { kind: "label", requirement: "gpu", nodeId: "node-alpha", agentId: "alpha", detail: "no worker-reported evidence" },
      { kind: "operating-system", requirement: "darwin", nodeId: "node-alpha", agentId: "alpha", detail: "worker-reported value does not match" }
    ]
  });
});
