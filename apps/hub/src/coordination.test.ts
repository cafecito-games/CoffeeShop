import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Agent, ComputeNode, Run } from "@coffee-shop/protocol";
import { CoordinationError, createArtifact, delegateTask, taskContext } from "./coordination.js";
import { Store } from "./store.js";
import { updateThreadByOperator, updateThreadForRun } from "./threads.js";

const at = "2026-09-13T12:00:00.000Z";

function agent(id: string, canDelegate = false): Agent {
  return {
    id, name: id, title: id === "orchestrator" ? "Coordinator" : "Specialist", summary: "", glyph: id[0].toUpperCase(),
    avatarShape: "cup", avatarColor: "amber", state: "working", currentAction: "Working",
    harnessId: "codex-cli", model: "default", computeNodeId: `node-${id}`, workspace: `/workspace/${id}`,
    systemPrompt: "Work carefully", canDelegate, unread: 0, updatedAt: at
  };
}

function node(id: string): ComputeNode {
  return {
    id, name: id, kind: "local", platform: "test", status: "online", lastSeen: at, activeRuns: 0,
    concurrency: 2, workspaceRoots: ["/workspace"], harnesses: [], version: "test"
  };
}

function sourceRun(): Run {
  return {
    id: "run-source", threadId: "thread-one", agentId: "orchestrator", nodeId: "node-orchestrator", harnessId: "codex-cli",
    model: "default", workspace: "/workspace/orchestrator", prompt: "Coordinate the work", status: "running",
    output: "", depth: 0, createdAt: at, startedAt: at
  };
}

async function coordinationStore() {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-coordination-"));
  const store = new Store(join(directory, "state.json"));
  await store.load();
  await store.transact((state) => {
    state.agents = [agent("orchestrator", true), agent("reviewer")];
    state.nodes = [node("node-orchestrator"), node("node-reviewer")];
    state.threads = [{
      id: "thread-one", title: "Coordinate work", objective: "Coordinate the work", summary: "", status: "active",
      ownerAgentId: "orchestrator", createdBy: "user", createdAt: at, updatedAt: at
    }];
    state.runs = [sourceRun()];
  });
  return store;
}

test("delegation is persisted, bounded, and idempotent", async () => {
  const store = await coordinationStore();
  const argumentsValue = { agentId: "reviewer", task: "Review the change", idempotencyKey: "review-1" };
  const first = await delegateTask(store, "run-source", argumentsValue, () => true, at);
  assert.equal(first.created, true);
  assert.equal(first.dispatched, true);
  assert.equal(first.run.parentRunId, "run-source");
  assert.equal(first.run.threadId, "thread-one");
  assert.equal(first.run.depth, 1);
  assert.equal(store.snapshot().delegations?.length, 1);

  const replay = await delegateTask(store, "run-source", argumentsValue, () => true, "later");
  assert.equal(replay.created, false);
  assert.equal(replay.run.id, first.run.id);
  assert.equal(store.snapshot().runs.length, 2);

  await assert.rejects(
    delegateTask(store, "run-source", { ...argumentsValue, task: "Different work" }, () => true),
    (error: unknown) => error instanceof CoordinationError && error.code === "idempotency_conflict"
  );
});

test("task context exposes only lineage and gives delegation capability to orchestrators", async () => {
  const store = await coordinationStore();
  const child = await delegateTask(store, "run-source", { agentId: "reviewer", task: "Review", idempotencyKey: "review" }, () => false, at);
  const sourceContext = taskContext(store.snapshot(), "run-source", {});
  assert.equal(sourceContext.thread?.id, "thread-one");
  assert.deepEqual(sourceContext.availableAgents.map((item) => item.id), ["reviewer"]);
  assert.deepEqual(sourceContext.delegations.map((item) => item.taskId), [child.run.id]);
  assert.equal(taskContext(store.snapshot(), child.run.id, { taskId: "run-source" }).task.id, "run-source");

  const unrelated = { ...sourceRun(), id: "unrelated", agentId: "reviewer", parentRunId: undefined };
  await store.transact((state) => { state.runs.push(unrelated); });
  assert.throws(() => taskContext(store.snapshot(), "run-source", { taskId: "unrelated" }), /lineage/);
});

test("artifact registration validates metadata and rejects idempotency conflicts", async () => {
  const store = await coordinationStore();
  const argumentsValue = {
    relativePath: "reports/result.json", title: "Results", kind: "report", mediaType: "application/json",
    size: 2, sha256: "a".repeat(64), idempotencyKey: "results-1"
  };
  const first = await createArtifact(store, "run-source", argumentsValue, at);
  assert.equal(first.artifact.uploaded, false);
  assert.equal(first.artifact.threadId, "thread-one");
  assert.match(first.uploadPath, /^\/api\/artifacts\//);
  const replay = await createArtifact(store, "run-source", argumentsValue, "later");
  assert.equal(replay.artifact.id, first.artifact.id);
  assert.equal(store.snapshot().artifacts?.length, 1);
  await assert.rejects(
    createArtifact(store, "run-source", { ...argumentsValue, size: 3 }),
    (error: unknown) => error instanceof CoordinationError && error.code === "idempotency_conflict"
  );
  await assert.rejects(
    createArtifact(store, "run-source", { ...argumentsValue, relativePath: "../secret", idempotencyKey: "escape" }),
    (error: unknown) => error instanceof CoordinationError && error.code === "invalid_arguments"
  );
});

test("agents can refine and complete their thread but cannot archive it", async () => {
  const store = await coordinationStore();
  const child = await delegateTask(store, "run-source", { agentId: "reviewer", task: "Review", idempotencyKey: "thread-review" }, () => false, at);
  await store.transact((state) => { state.runs.find((run) => run.id === child.run.id)!.status = "running"; });
  await assert.rejects(
    updateThreadForRun(store, child.run.id, { summary: "Worker summary" }),
    (error: unknown) => error instanceof CoordinationError && error.code === "forbidden"
  );
  await store.transact((state) => { state.runs.find((run) => run.id === child.run.id)!.status = "completed"; });
  const updated = await updateThreadForRun(store, "run-source", {
    title: "Reviewed change", summary: "The review is ready", status: "completed"
  }, at);
  assert.equal(updated.title, "Reviewed change");
  assert.equal(updated.status, "completed");
  assert.equal(updated.completedAt, at);
  await assert.rejects(
    updateThreadForRun(store, "run-source", { status: "archived" }),
    (error: unknown) => error instanceof CoordinationError && error.code === "forbidden"
  );
});

test("only the operator can archive an idle thread and reopen it", async () => {
  const store = await coordinationStore();
  await assert.rejects(
    updateThreadByOperator(store, "thread-one", { status: "archived" }, at),
    (error: unknown) => error instanceof CoordinationError && error.code === "thread_in_use"
  );
  await store.transact((state) => { state.runs[0].status = "completed"; });
  assert.equal((await updateThreadByOperator(store, "thread-one", { status: "archived" }, at)).status, "archived");
  await assert.rejects(
    updateThreadByOperator(store, "thread-one", { title: "Hidden edit" }),
    (error: unknown) => error instanceof CoordinationError && error.code === "thread_archived"
  );
  assert.equal((await updateThreadByOperator(store, "thread-one", { status: "active" }, "later")).status, "active");
  assert.equal(store.snapshot().threads?.[0].archivedAt, undefined);
});

test("workers cannot delegate", async () => {
  const store = await coordinationStore();
  await store.transact((state) => { state.agents[0].canDelegate = false; });
  await assert.rejects(
    delegateTask(store, "run-source", { agentId: "reviewer", task: "Review", idempotencyKey: "review" }, () => true),
    (error: unknown) => error instanceof CoordinationError && error.code === "forbidden"
  );
});
