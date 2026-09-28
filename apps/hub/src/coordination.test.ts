import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Agent, ComputeNode, Run } from "@coffee-shop/protocol";
import { CoordinationError, createArtifact, delegateTask, taskContext } from "./coordination.js";
import { Store } from "./store.js";
import { applyAttemptOutcome, assignTaskAttempt } from "./tasks.js";
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
    concurrency: 2, workspaceRoots: ["/workspace"], version: "test",
    harnesses: [{ id: "codex-cli", label: "Codex", description: "", available: true, authMode: "local-account", models: ["default"] }]
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
  return (await coordinationFixture()).store;
}

async function coordinationFixture() {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-coordination-"));
  const path = join(directory, "state.json");
  const store = new Store(path);
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
  return { store, path };
}

/** Starts a task's first attempt as a running run of `agentId`, as the scheduler and lifecycle would. */
async function startAttempt(store: Store, taskId: string, agentId: string, runId = `run-${taskId}`) {
  await store.transact((state) => {
    const task = state.tasks!.find((item) => item.id === taskId)!;
    const source = state.runs.find((run) => run.id === task.sourceRunId);
    const run: Run = {
      id: runId, threadId: task.threadId, agentId, nodeId: `node-${agentId}`, harnessId: "codex-cli", model: "default",
      workspace: `/workspace/${agentId}`, prompt: task.instructions, status: "queued", output: "",
      depth: (source?.depth ?? 0) + 1, parentRunId: source?.id, createdAt: at
    };
    assignTaskAttempt(state, taskId, run, at);
    run.status = "running";
    run.startedAt = at;
    applyAttemptOutcome(state, run.id, at);
  });
  return runId;
}

test("legacy delegation submits one pinned task through the task graph and is idempotent", async () => {
  const store = await coordinationStore();
  const argumentsValue = { agentId: "reviewer", task: "Review the change", idempotencyKey: "review-1" };
  const first = await delegateTask(store, "run-source", argumentsValue, at);
  assert.equal(first.created, true);
  assert.equal(first.agentId, "reviewer");
  const task = store.snapshot().tasks?.find((item) => item.id === first.taskId);
  assert.equal(task?.status, "ready");
  assert.equal(task?.threadId, "thread-one");
  assert.equal(task?.sourceRunId, "run-source");
  assert.deepEqual(task?.placementOverride, { agentId: "reviewer", authorizedBy: "policy" });
  assert.equal(store.snapshot().runs.length, 1, "delegation never creates a run directly");

  const replay = await delegateTask(store, "run-source", argumentsValue, "later");
  assert.equal(replay.created, false);
  assert.equal(replay.taskId, first.taskId);
  assert.equal(store.snapshot().tasks?.length, 1);

  await assert.rejects(
    delegateTask(store, "run-source", { ...argumentsValue, task: "Different work" }, at),
    (error: unknown) => error instanceof CoordinationError && error.code === "idempotency_conflict"
  );
  await assert.rejects(
    delegateTask(store, "run-source", { ...argumentsValue, agentId: "orchestrator", idempotencyKey: "self" }, at),
    (error: unknown) => error instanceof CoordinationError && error.code === "target_ineligible" && !error.retryable
  );
  await assert.rejects(
    delegateTask(store, "run-source", { ...argumentsValue, agentId: "missing", idempotencyKey: "missing" }, at),
    (error: unknown) => error instanceof CoordinationError && error.code === "target_ineligible" && !error.retryable
  );
  assert.equal(store.snapshot().tasks?.length, 1);
});

test("legacy delegation keeps its depth and fan-out limits", async () => {
  const store = await coordinationStore();
  for (let index = 0; index < 4; index += 1) {
    await delegateTask(store, "run-source", { agentId: "reviewer", task: `Review ${index}`, idempotencyKey: `review-${index}` }, at);
  }
  await assert.rejects(
    delegateTask(store, "run-source", { agentId: "reviewer", task: "One too many", idempotencyKey: "review-4" }, at),
    (error: unknown) => error instanceof CoordinationError && error.code === "fanout_limit"
  );
  await store.transact((state) => { state.runs[0].depth = 3; });
  await assert.rejects(
    delegateTask(store, "run-source", { agentId: "reviewer", task: "Too deep", idempotencyKey: "deep" }, at),
    (error: unknown) => error instanceof CoordinationError && error.code === "depth_limit"
  );
  assert.equal(store.snapshot().tasks?.length, 4);
});

test("task context exposes only lineage and gives delegation capability to orchestrators", async () => {
  const store = await coordinationStore();
  const child = await delegateTask(store, "run-source", { agentId: "reviewer", task: "Review", idempotencyKey: "review" }, at);
  const sourceContext = store.read((state) => taskContext(state, "run-source", {}));
  assert.equal(sourceContext.thread.id, "thread-one");
  assert.equal(sourceContext.caller.role, "orchestrator");
  assert.deepEqual(sourceContext.availableAgents.map((item) => item.id), ["reviewer"]);
  assert.deepEqual(sourceContext.childTasks.map((item) => item.id), [child.taskId]);
  assert.equal(sourceContext.mailbox.messageCount, 0);
  assert.match(sourceContext.mailbox.cursor, /^tev1\./);

  const childRunId = await startAttempt(store, child.taskId, "reviewer");
  const childContext = store.read((state) => taskContext(state, childRunId, {}));
  assert.equal(childContext.caller.taskId, child.taskId);
  assert.equal(childContext.durableTask?.id, child.taskId);
  assert.equal(store.read((state) => taskContext(state, childRunId, { taskId: "run-source" })).task.id, "run-source");

  const unrelated = { ...sourceRun(), id: "unrelated", agentId: "reviewer", parentRunId: undefined };
  await store.transact((state) => { state.runs.push(unrelated); });
  assert.throws(() => store.read((state) => taskContext(state, "run-source", { taskId: "unrelated" })), /lineage/);
  assert.throws(() => store.read((state) => taskContext(state, "run-source", { taskId: "does-not-exist" })), /lineage/);
  assert.throws(() => store.read((state) => taskContext(state, "run-source", { taskId: "run-source", extra: true })), /unknown field/);
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

test("run artifact registration preserves the real Barista producer's historical character limits and replay", async () => {
  const { path } = await coordinationFixture();
  // Settle this test fixture's unrelated legacy-agent template import before capturing the artifact
  // producer's bytes, so the subsequent reload can prove the artifact itself causes no migration.
  const store = new Store(path);
  await store.load();
  const segment = "é".repeat(90);
  const argumentsValue = {
    // Barista canonicalizes the opened path at apps/control-agent/internal/mcpserver/server.go:355
    // and forwards these exact metadata strings at server.go:290-292. The MCP schema closes the object,
    // but it deliberately places no byte bounds on title, summary, mediaType, or idempotencyKey.
    relativePath: [`${segment}\\literal`, ...Array.from({ length: 5 }, () => segment)].join("/"),
    title: "界".repeat(100),
    kind: "report",
    mediaType: `x/${"é".repeat(64)}`,
    summary: "é".repeat(2_001),
    size: 2,
    sha256: "a".repeat(64),
    idempotencyKey: "鍵".repeat(64)
  };
  for (const field of ["relativePath", "title", "mediaType", "summary", "idempotencyKey"] as const) {
    assert.ok(Buffer.byteLength(argumentsValue[field], "utf8") > ({
      relativePath: 1_024, title: 256, mediaType: 128, summary: 2_000, idempotencyKey: 128
    })[field], `${field} must exercise the historical character-vs-byte boundary`);
  }

  const first = await createArtifact(store, "run-source", argumentsValue, at);
  assert.equal(first.artifact.relativePath, argumentsValue.relativePath);
  assert.match(first.artifact.relativePath, /\\literal\//, "legacy run paths are not rewritten by external POSIX normalization");
  assert.equal(first.artifact.title, argumentsValue.title);
  assert.equal(first.artifact.mediaType, argumentsValue.mediaType);
  assert.equal(first.artifact.idempotencyKey, argumentsValue.idempotencyKey);
  assert.equal(first.artifact.summary, "é".repeat(2_000), "the legacy producer truncates summary to 2,000 characters");

  const replay = await createArtifact(store, "run-source", { ...argumentsValue, summary: "A changed retry summary" }, at);
  assert.equal(replay.artifact.id, first.artifact.id, "legacy run replay ignores summary exactly as the historical Hub did");
  assert.equal(replay.artifact.summary, first.artifact.summary, "replay never rewrites the first stored summary");
  assert.equal(store.snapshot().artifacts?.length, 1);

  const persisted = await readFile(path);
  const restarted = new Store(path);
  await restarted.load();
  assert.deepEqual(await readFile(path), persisted, "Store accepts the real run producer's persisted bytes without rewriting them");
  assert.equal(restarted.snapshot().artifacts?.[0]?.title, argumentsValue.title);
});

test("agents can refine and complete their thread but cannot archive it", async () => {
  const store = await coordinationStore();
  const child = await delegateTask(store, "run-source", { agentId: "reviewer", task: "Review", idempotencyKey: "thread-review" }, at);
  const childRunId = await startAttempt(store, child.taskId, "reviewer");
  await assert.rejects(
    updateThreadForRun(store, childRunId, { summary: "Worker summary" }),
    (error: unknown) => error instanceof CoordinationError && error.code === "forbidden"
  );
  await store.transact((state) => { state.runs.find((run) => run.id === childRunId)!.status = "completed"; });
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
    delegateTask(store, "run-source", { agentId: "reviewer", task: "Review", idempotencyKey: "review" }, at),
    (error: unknown) => error instanceof CoordinationError && error.code === "forbidden"
  );
});
