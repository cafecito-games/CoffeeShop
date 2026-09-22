import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Agent, ComputeNode, HubToControlAgent, Run } from "@coffee-shop/protocol";
import { applyRunLifecycle, cancelPersistedRun, cancelRunInState, coalesceAsync, queuedRunsForNode, retryAsync, serializeAsync } from "./lifecycle.js";
import { type State, Store } from "./store.js";

const at = "2026-09-11T12:00:00.000Z";

function agent(): Agent {
  return {
    id: "agent-one", name: "Milo", title: "Builder", summary: "Builds", glyph: "M",
    avatarShape: "cup", avatarColor: "amber", state: "working", currentAction: "Working",
    harnessId: "codex-cli", model: "gpt-5", computeNodeId: "node-one", workspace: "/workspace",
    systemPrompt: "Build", unread: 0, updatedAt: at
  };
}

function node(status: ComputeNode["status"] = "online"): ComputeNode {
  return {
    id: "node-one", name: "Desk", kind: "local", platform: "darwin", status, lastSeen: at,
    activeRuns: 1, concurrency: 2, workspaceRoots: ["/workspace"], harnesses: [], version: "test"
  };
}

function run(status: Run["status"], id = "run-one"): Run {
  return {
    id, agentId: "agent-one", nodeId: "node-one", harnessId: "codex-cli", model: "gpt-5",
    workspace: "/workspace", prompt: "Build it", status, output: "", depth: 0, createdAt: at
  };
}

function state(status: Run["status"]): State {
  return { agents: [agent()], nodes: [node()], runs: [run(status)], events: [], messages: [] };
}

test("cancellation accepts every active status and is idempotent", () => {
  for (const status of ["queued", "running"] as const) {
    const current = state(status);
    const result = cancelRunInState(current, "run-one", at);
    assert.equal(result.kind, "cancelled");
    assert.equal(current.runs[0].status, "cancelled");
    assert.equal(current.runs[0].finishedAt, at);
    assert.equal(current.events.length, 1);
    assert.equal(current.events[0].runId, "run-one");
    assert.equal(current.agents[0].state, "idle");
    assert.equal(current.agents[0].currentAction, "Available");

    assert.equal(cancelRunInState(current, "run-one", "later").kind, "already-cancelled");
    assert.equal(current.runs[0].finishedAt, at);
    assert.equal(current.events.length, 1);
  }
});

test("cancellation rejects missing and completed or failed runs without mutation", () => {
  for (const status of ["completed", "failed"] as const) {
    const current = state(status);
    const before = structuredClone(current);
    assert.equal(cancelRunInState(current, "run-one", at).kind, "conflict");
    assert.deepEqual(current, before);
  }
  const current = state("running");
  const before = structuredClone(current);
  assert.equal(cancelRunInState(current, "missing", at).kind, "not-found");
  assert.deepEqual(current, before);
});

test("cancelling recalculates agent state from another active run", () => {
  const current = state("running");
  current.runs.push({ ...run("running", "run-two"), output: "still progressing" });
  cancelRunInState(current, "run-one", at);
  assert.equal(current.agents[0].state, "working");
  assert.equal(current.agents[0].currentAction, "still progressing");

  current.runs[1].status = "completed";
  current.runs.push(run("queued", "run-three"));
  current.nodes[0].status = "offline";
  current.runs[0].status = "running";
  cancelRunInState(current, "run-one", at);
  assert.equal(current.agents[0].state, "waiting");
  assert.equal(current.agents[0].currentAction, "Waiting for compute");

  current.runs[2].dispatchedAt = at;
  current.runs[0].status = "running";
  cancelRunInState(current, "run-one", at);
  assert.equal(current.agents[0].state, "thinking");
  assert.equal(current.agents[0].currentAction, "Starting work");
});

test("persisted cancellation finishes before best-effort delivery and works disconnected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-cancel-"));
  const store = new Store(join(directory, "state.json"));
  await store.load();
  await store.transact((current) => Object.assign(current, state("running")));
  const observed: string[] = [];
  const send = (_nodeId: string, message: HubToControlAgent) => {
    observed.push(`${store.getRun("run-one")?.status}:${message.type}`);
    return false;
  };

  const result = await cancelPersistedRun(store, "run-one", send, at);
  assert.equal(result.kind, "cancelled");
  assert.deepEqual(observed, ["cancelled:cancel"]);
  assert.equal(store.snapshot().events.length, 1);

  await cancelPersistedRun(store, "run-one", send, "later");
  assert.deepEqual(observed, ["cancelled:cancel"]);
  assert.equal(store.snapshot().events.length, 1);
});

test("cancelling an orchestrator cascades to active descendants", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-cancel-"));
  const store = new Store(join(directory, "state.json"));
  await store.load();
  const current = state("running");
  current.runs.push({ ...run("queued", "run-child"), parentRunId: "run-one", agentId: "agent-one" });
  current.runs.push({ ...run("completed", "run-finished"), parentRunId: "run-child", agentId: "agent-one" });
  await store.transact((value) => Object.assign(value, current));
  const delivered: string[] = [];
  await cancelPersistedRun(store, "run-one", (_nodeId, message) => { if (message.type === "cancel") delivered.push(message.runId); return true; }, at);
  assert.deepEqual(delivered.sort(), ["run-child", "run-one"]);
  assert.equal(store.getRun("run-child")?.status, "cancelled");
  assert.equal(store.getRun("run-finished")?.status, "completed");
});

test("persistence failure rolls cancellation back and leaves delivery retryable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-cancel-"));
  const store = new Store(join(directory, "state.json"));
  await store.load();
  await store.transact((current) => Object.assign(current, state("running")));
  const before = store.snapshot();
  const mutableStore = store as unknown as { save: () => Promise<void> };
  const save = mutableStore.save.bind(store);
  mutableStore.save = async () => { throw new Error("disk full"); };
  let deliveries = 0;

  await assert.rejects(cancelPersistedRun(store, "run-one", () => { deliveries += 1; return true; }, at), /disk full/);
  assert.equal(deliveries, 0);
  const { generatedAt: _beforeGeneratedAt, ...stateBefore } = before;
  const { generatedAt: _afterGeneratedAt, ...stateAfter } = store.snapshot();
  assert.deepEqual(stateAfter, stateBefore);

  mutableStore.save = save;
  const retried = await cancelPersistedRun(store, "run-one", () => { deliveries += 1; return true; }, at);
  assert.equal(retried.kind, "cancelled");
  assert.equal(deliveries, 1);
});

test("late lifecycle messages and duplicate acknowledgements cannot change a cancelled run", () => {
  for (const message of [
    { type: "run.started", runId: "run-one", at },
    { type: "run.output", runId: "run-one", chunk: "late", at },
    { type: "run.completed", runId: "run-one", output: '<handoff to="other">late</handoff>', at },
    { type: "run.failed", runId: "run-one", error: "late", at }
  ] as const) {
    const current = state("cancelled");
    const before = structuredClone(current);
    assert.equal(applyRunLifecycle(current, message), false);
    assert.deepEqual(current, before);
  }
  const current = state("cancelled");
  assert.equal(applyRunLifecycle(current, { type: "run.cancelled", runId: "run-one", at }), false);
  assert.equal(applyRunLifecycle(current, { type: "run.cancelled", runId: "run-one", at: "later" }), false);
  assert.equal(current.events.length, 0);
});

test("a native run records its provider session once from a text-free run.output", () => {
  const current = state("running");
  current.agents[0].currentAction = "Reading the repository";
  assert.equal(applyRunLifecycle(current, { type: "run.output", runId: "run-one", providerSessionId: "01a0c881-6c5c-7b42-a6ca-cb1fa772c4e7", at } as never), true);
  assert.equal(current.runs[0].providerSessionId, "01a0c881-6c5c-7b42-a6ca-cb1fa772c4e7");
  assert.equal(current.runs[0].output, "");
  assert.equal(current.agents[0].currentAction, "Reading the repository");

  assert.equal(applyRunLifecycle(current, { type: "run.output", runId: "run-one", chunk: "", providerSessionId: "another-session", at }), true);
  assert.equal(current.runs[0].providerSessionId, "01a0c881-6c5c-7b42-a6ca-cb1fa772c4e7");
});

test("provider sessions are ignored when malformed or reported by an ACP run", () => {
  const malformed = state("running");
  assert.equal(applyRunLifecycle(malformed, { type: "run.output", runId: "run-one", chunk: "", providerSessionId: "id; rm -rf /", at }), true);
  assert.equal(malformed.runs[0].providerSessionId, undefined);

  const acp = state("running");
  acp.runs[0].transport = "acp-v1";
  assert.equal(applyRunLifecycle(acp, { type: "run.output", runId: "run-one", chunk: "", providerSessionId: "session-one", at }), true);
  assert.equal(acp.runs[0].providerSessionId, undefined);
});

test("malformed lifecycle payloads are ignored without mutation", () => {
  for (const message of [
    { type: "run.started", runId: "run-one" },
    { type: "run.output", runId: "run-one", chunk: 3, at },
    { type: "run.completed", runId: "run-one", output: null, at },
    { type: "run.failed", runId: "run-one", error: {}, at },
    { type: "run.future", runId: "run-one", error: "unsupported", at },
    { type: "run.future", runId: "run-one", at }
  ]) {
    const current = state("running");
    const before = structuredClone(current);
    assert.equal(applyRunLifecycle(current, message as never), false);
    assert.deepEqual(current, before);
  }
});

test("canonical transitions reject malformed ordering and accept normal lifecycle", () => {
  const queued = state("queued");
  assert.equal(applyRunLifecycle(queued, { type: "run.output", runId: "run-one", chunk: "early", at }), false);
  assert.equal(applyRunLifecycle(queued, { type: "run.completed", runId: "run-one", output: "early", at }), false);
  assert.equal(applyRunLifecycle(queued, { type: "run.started", runId: "run-one", at }), true);
  assert.equal(applyRunLifecycle(queued, { type: "run.output", runId: "run-one", chunk: "hello", at }), true);
  assert.equal(applyRunLifecycle(queued, { type: "run.completed", runId: "run-one", output: "done", at }), true);
  assert.equal(queued.runs[0].status, "completed");
  assert.equal(queued.messages[0].body, "done");
  assert.equal(applyRunLifecycle(queued, { type: "run.failed", runId: "run-one", error: "late", at }), false);
});

test("serial message handling settles lifecycle work before reconnect reconciliation", async () => {
  const entered: string[] = [];
  let releaseLifecycle: (() => void) | undefined;
  const lifecycleGate = new Promise<void>((resolve) => { releaseLifecycle = resolve; });
  const handle = serializeAsync(async (message: string) => {
    entered.push(`start:${message}`);
    if (message === "lifecycle") await lifecycleGate;
    entered.push(`finish:${message}`);
  }, (error) => { throw error; });

  const lifecycle = handle("lifecycle");
  const reconciliation = handle("reconciliation");
  await Promise.resolve();
  assert.deepEqual(entered, ["start:lifecycle"]);
  releaseLifecycle?.();
  await Promise.all([lifecycle, reconciliation]);
  assert.deepEqual(entered, ["start:lifecycle", "finish:lifecycle", "start:reconciliation", "finish:reconciliation"]);
});

test("serial handling stops before a replay barrier after an unrecoverable message", async () => {
  const entered: string[] = [];
  const errors: string[] = [];
  const handle = serializeAsync(async (message: string) => {
    entered.push(message);
    if (message === "run.started") throw new Error("disk unavailable");
  }, (error) => errors.push((error as Error).message));

  await handle("run.started");
  await handle("sync.complete");
  assert.deepEqual(entered, ["run.started"]);
  assert.deepEqual(errors, ["disk unavailable"]);
});

test("bounded retry settles a transient persistence failure before continuing", async () => {
  let attempts = 0;
  const result = await retryAsync(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("transient write failure");
    return "persisted";
  });
  assert.equal(result, "persisted");
  assert.equal(attempts, 2);
});

test("reconnect reconciliation does not redispatch runs Barista reports active", () => {
  const snapshot = { ...state("queued"), generatedAt: at };
  snapshot.runs.push(run("queued", "run-two"));
  assert.deepEqual(queuedRunsForNode(snapshot, "node-one", ["run-one"], "2").map((item) => item.id), ["run-two"]);
  assert.deepEqual(queuedRunsForNode(snapshot, "node-one", ["run-one"], "3").map((item) => item.id), ["run-two"]);
  assert.deepEqual(queuedRunsForNode(snapshot, "node-one", ["run-one"], "4").map((item) => item.id), ["run-two"]);
  assert.deepEqual(queuedRunsForNode(snapshot, "node-one", [], "1"), [], "v1 has no safe replay barrier and must fail closed");
});

test("a request while a coalesced run is in progress schedules exactly one more run", async () => {
  let concurrent = 0;
  let maximumConcurrent = 0;
  let completedRuns = 0;
  let releaseFirstRun: (() => void) | undefined;
  const firstRunGate = new Promise<void>((resolve) => { releaseFirstRun = resolve; });
  const errors: unknown[] = [];
  const request = coalesceAsync(async () => {
    concurrent += 1;
    maximumConcurrent = Math.max(maximumConcurrent, concurrent);
    if (completedRuns === 0) await firstRunGate;
    concurrent -= 1;
    completedRuns += 1;
  }, (error) => errors.push(error));

  const first = request();
  const second = request();
  const third = request();
  releaseFirstRun?.();
  await Promise.all([first, second, third]);
  assert.equal(completedRuns, 2, "three requests during one run collapse into one follow-up run");
  assert.equal(maximumConcurrent, 1, "coalesced runs must never overlap");
  assert.deepEqual(errors, []);
});

test("a coalesced run error reaches onError and a later request runs again", async () => {
  const errors: string[] = [];
  let runs = 0;
  const request = coalesceAsync(async () => {
    runs += 1;
    if (runs === 1) throw new Error("coalesced failure");
  }, (error) => errors.push((error as Error).message));

  await request();
  assert.equal(runs, 1);
  assert.deepEqual(errors, ["coalesced failure"]);

  await request();
  assert.equal(runs, 2);
  assert.deepEqual(errors, ["coalesced failure"]);
});
