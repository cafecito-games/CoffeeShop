import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Agent, ComputeNode, HubToControlAgent, Run, Task, TaskAssignment, Thread } from "@coffee-shop/protocol";
import { CoordinationError } from "./coordination.js";
import { applyRunLifecycle, cancelPersistedTask } from "./lifecycle.js";
import { type State, Store } from "./store.js";
import {
  applyAttemptOutcome,
  assignTaskAttempt,
  cancelTaskInState,
  readyTasks,
  submitTaskBatch,
  taskContextProjection,
  taskReadiness,
  threadTaskGraph,
  transitionTask
} from "./tasks.js";

const at = "2026-09-13T12:00:00.000Z";

function agent(id: string, canDelegate = false): Agent {
  return {
    id, name: id, title: id, summary: "", glyph: id[0].toUpperCase(),
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

function thread(id: string, status: Thread["status"] = "active"): Thread {
  return {
    id, title: id, objective: `Objective for ${id}`, summary: "", status,
    ownerAgentId: "orchestrator", createdBy: "user", createdAt: at, updatedAt: at
  };
}

function sourceRun(id: string, threadId: string | undefined, agentId = "orchestrator"): Run {
  return {
    id, threadId, agentId, nodeId: `node-${agentId}`, harnessId: "codex-cli", model: "default",
    workspace: "/workspace", prompt: "Coordinate the work", status: "running", output: "",
    depth: 0, createdAt: at, startedAt: at
  };
}

async function taskStore() {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-tasks-"));
  const path = join(directory, "state.json");
  const store = new Store(path);
  await store.load();
  await store.transact((state) => {
    state.agents = [agent("orchestrator", true), agent("worker")];
    state.nodes = [node("node-orchestrator"), node("node-worker")];
    state.threads = [thread("thread-one"), thread("thread-two")];
    state.runs = [
      sourceRun("run-source", "thread-one"),
      sourceRun("run-source-two", "thread-one"),
      sourceRun("run-thread-two", "thread-two")
    ];
  });
  return { store, path, directory };
}

function taskInput(key: string, dependencies: unknown[] = [], overrides: Record<string, unknown> = {}) {
  return { key, title: `Task ${key}`, instructions: `Instructions for ${key}`, dependencies, ...overrides };
}

function fanOutBatch() {
  return {
    idempotencyKey: "fan-out",
    tasks: [
      taskInput("a"),
      taskInput("b"),
      taskInput("c", [{ key: "a" }, { key: "b" }])
    ]
  };
}

async function rejectsWithoutMutation(
  store: Store,
  path: string,
  code: string,
  action: () => Promise<unknown>,
  inspect?: (error: CoordinationError) => void
) {
  const tasksBefore = store.snapshot().tasks;
  const eventsBefore = store.snapshot().events;
  const fileBefore = await readFile(path, "utf8");
  await assert.rejects(action(), (error: unknown) => {
    assert.ok(error instanceof CoordinationError, `expected CoordinationError, got ${String(error)}`);
    assert.equal(error.code, code);
    inspect?.(error);
    return true;
  });
  assert.deepEqual(store.snapshot().tasks, tasksBefore, `${code} must not change tasks`);
  assert.deepEqual(store.snapshot().events, eventsBefore, `${code} must not change events`);
  assert.equal(await readFile(path, "utf8"), fileBefore, `${code} must not touch the state file`);
}

test("submits a fan-out and join batch atomically", async () => {
  const { store, path } = await taskStore();
  const result = await submitTaskBatch(store, "run-source", fanOutBatch(), at);

  assert.equal(result.created, true);
  const taskAId = result.taskIdsByKey.a;
  const taskBId = result.taskIdsByKey.b;
  const taskCId = result.taskIdsByKey.c;
  for (const taskId of [taskAId, taskBId, taskCId]) {
    assert.ok(taskId.startsWith("task_"), `${taskId} carries the task id prefix`);
  }
  assert.equal(new Set([taskAId, taskBId, taskCId]).size, 3);
  assert.deepEqual(result.tasks.map((task) => task.title), ["Task a", "Task b", "Task c"]);
  assert.equal(result.tasks[0].status, "ready");
  assert.equal(result.tasks[1].status, "ready");
  assert.equal(result.tasks[2].status, "pending");
  assert.deepEqual(result.tasks[2].dependencies, [
    { taskId: taskAId, policy: "require-success" },
    { taskId: taskBId, policy: "require-success" }
  ]);
  for (const task of result.tasks) {
    assert.deepEqual(task.attemptRunIds, []);
    assert.equal(task.assignment, undefined);
    assert.equal(task.sourceRunId, "run-source");
    assert.equal(task.idempotencyKey, "fan-out");
    assert.equal(task.threadId, "thread-one");
  }
  assert.equal(store.snapshot().events.length, 1);
  assert.equal(store.snapshot().events[0].title, "3 tasks submitted");
  assert.equal(store.read((state) => state.taskSubmissions?.length), 1);

  const reopened = new Store(path);
  await reopened.load();
  assert.deepEqual((reopened.snapshot().tasks ?? []).map((task) => task.id).sort(), [taskAId, taskBId, taskCId].sort());
  assert.equal(reopened.read((state) => state.taskSubmissions?.length), 1);
});

test("replays an exact batch and its normalized equivalents", async () => {
  const { store, path } = await taskStore();
  const argumentsValue = {
    idempotencyKey: "fan-out",
    tasks: [
      taskInput("a", [], { requirements: { skills: ["rust", "go"] } }),
      taskInput("b"),
      taskInput("c", [{ key: "a" }, { key: "b" }])
    ]
  };
  const first = await submitTaskBatch(store, "run-source", argumentsValue, at);
  const fileAfterFirst = await readFile(path, "utf8");

  const replay = await submitTaskBatch(store, "run-source", argumentsValue, at);
  assert.equal(replay.created, false);
  assert.equal(replay.submissionId, first.submissionId);
  assert.deepEqual(replay.taskIdsByKey, first.taskIdsByKey);
  assert.equal(store.read((state) => state.tasks?.length), 3);
  assert.equal(await readFile(path, "utf8"), fileAfterFirst);

  const equivalents = [
    {
      expectedTitles: ["Task c", "Task b", "Task a"],
      argumentsValue: { idempotencyKey: "fan-out", tasks: [argumentsValue.tasks[2], argumentsValue.tasks[1], argumentsValue.tasks[0]] }
    },
    {
      expectedTitles: ["Task a", "Task b", "Task c"],
      argumentsValue: {
        idempotencyKey: "fan-out",
        tasks: [
          taskInput("a", [], { requirements: { skills: ["go", "rust", "go"] } }),
          { ...taskInput("b"), title: "  Task b  " },
          taskInput("c", [{ key: "b" }, { key: "a" }, { key: "a" }])
        ]
      }
    }
  ];
  for (const equivalent of equivalents) {
    const normalized = await submitTaskBatch(store, "run-source", equivalent.argumentsValue, at);
    assert.equal(normalized.created, false);
    assert.equal(normalized.submissionId, first.submissionId);
    assert.deepEqual(normalized.taskIdsByKey, first.taskIdsByKey);
    assert.deepEqual(normalized.tasks.map((task) => task.title), equivalent.expectedTitles);
  }
  assert.equal(await readFile(path, "utf8"), fileAfterFirst);
});

test("rejects conflicting replays without mutation", async () => {
  const { store, path } = await taskStore();
  await submitTaskBatch(store, "run-source", fanOutBatch(), at);

  await rejectsWithoutMutation(store, path, "idempotency_conflict", () => submitTaskBatch(store, "run-source", {
    idempotencyKey: "fan-out",
    tasks: [taskInput("a", [], { title: "Assemble differently" }), taskInput("b"), taskInput("c", [{ key: "a" }, { key: "b" }])]
  }, at));

  await rejectsWithoutMutation(store, path, "idempotency_conflict", () => submitTaskBatch(store, "run-source", {
    idempotencyKey: "fan-out",
    tasks: [taskInput("a"), taskInput("b"), taskInput("c", [{ key: "a", policy: "allow-failure" }, { key: "b" }])]
  }, at));

  await rejectsWithoutMutation(store, path, "idempotency_conflict", () => submitTaskBatch(store, "run-source-two", fanOutBatch(), at));
});

test("the same idempotency key in another thread creates an independent batch", async () => {
  const { store } = await taskStore();
  const argumentsValue = { idempotencyKey: "shared", tasks: [taskInput("a")] };
  const first = await submitTaskBatch(store, "run-source", argumentsValue, at);
  const second = await submitTaskBatch(store, "run-thread-two", argumentsValue, at);
  assert.equal(second.created, true);
  assert.notEqual(second.tasks[0].id, first.tasks[0].id);
  assert.equal(second.tasks[0].threadId, "thread-two");
  assert.equal(store.read((state) => state.tasks?.length), 2);
  assert.equal(store.read((state) => state.taskSubmissions?.length), 2);
});

test("concurrent duplicate submissions settle on one creation", async () => {
  const { store } = await taskStore();
  const argumentsValue = fanOutBatch();
  const [first, second] = await Promise.all([
    submitTaskBatch(store, "run-source", argumentsValue, at),
    submitTaskBatch(store, "run-source", argumentsValue, at)
  ]);
  assert.equal([first, second].filter((result) => result.created).length, 1);
  assert.equal(second.submissionId, first.submissionId);
  assert.deepEqual(second.taskIdsByKey, first.taskIdsByKey);
  assert.equal(store.read((state) => state.tasks?.length), 3);
  assert.equal(store.read((state) => state.taskSubmissions?.length), 1);
});

test("concurrent conflicting submissions reject exactly one", async () => {
  const { store } = await taskStore();
  const outcomes = await Promise.allSettled([
    submitTaskBatch(store, "run-source", { idempotencyKey: "fan-out", tasks: [taskInput("a")] }, at),
    submitTaskBatch(store, "run-source", { idempotencyKey: "fan-out", tasks: [taskInput("b")] }, at)
  ]);
  const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
  const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reason instanceof CoordinationError);
  assert.equal(rejected[0].reason.code, "idempotency_conflict");
  assert.equal(store.read((state) => state.tasks?.length), 1);
  assert.equal(store.read((state) => state.taskSubmissions?.length), 1);
});

test("rejects every dependency cycle class without mutation", async () => {
  const { store, path } = await taskStore();
  const cases: Array<{ label: string; tasks: unknown[] }> = [
    { label: "self edge", tasks: [taskInput("a", [{ key: "a" }])] },
    { label: "two cycle", tasks: [taskInput("a", [{ key: "b" }]), taskInput("b", [{ key: "a" }])] },
    { label: "three cycle", tasks: [taskInput("a", [{ key: "b" }]), taskInput("b", [{ key: "c" }]), taskInput("c", [{ key: "a" }])] },
    { label: "cycle after an independent task", tasks: [taskInput("a"), taskInput("b", [{ key: "c" }]), taskInput("c", [{ key: "b" }])] }
  ];
  for (const [index, item] of cases.entries()) {
    await rejectsWithoutMutation(store, path, "dependency_cycle", () => submitTaskBatch(store, "run-source", {
      idempotencyKey: `cycle-${index}`,
      tasks: item.tasks
    }, at));
  }
  assert.equal(store.read((state) => state.tasks?.length), 0);
});

test("rejects missing and cross-thread dependencies without mutation", async () => {
  const { store, path } = await taskStore();
  await rejectsWithoutMutation(store, path, "unknown_dependency", () => submitTaskBatch(store, "run-source", {
    idempotencyKey: "unknown-local",
    tasks: [taskInput("a", [{ key: "missing" }])]
  }, at));

  await rejectsWithoutMutation(store, path, "unknown_dependency", () => submitTaskBatch(store, "run-source", {
    idempotencyKey: "unknown-existing",
    tasks: [taskInput("a", [{ taskId: "task_missing" }])]
  }, at));

  const foreign = await submitTaskBatch(store, "run-thread-two", { idempotencyKey: "foreign", tasks: [taskInput("far")] }, at);
  const foreignTaskId = foreign.taskIdsByKey.far;
  await rejectsWithoutMutation(store, path, "unknown_dependency", () => submitTaskBatch(store, "run-source", {
    idempotencyKey: "cross-thread",
    tasks: [taskInput("near", [{ taskId: foreignTaskId }])]
  }, at), (error) => {
    assert.ok(!error.message.includes(foreignTaskId), "the error must not leak the foreign task id");
    assert.ok(!error.message.includes("Task far"), "the error must not leak the foreign task title");
  });
});

test("dependents of an existing same-thread task follow its outcome", async () => {
  const { store } = await taskStore();
  const seeded = await submitTaskBatch(store, "run-source", { idempotencyKey: "seed-x", tasks: [taskInput("x")] }, at);
  const taskXId = seeded.taskIdsByKey.x;
  const dependent = await submitTaskBatch(store, "run-source", {
    idempotencyKey: "seed-y",
    tasks: [taskInput("y", [{ taskId: taskXId }])]
  }, at);
  assert.equal(dependent.tasks[0].status, "pending");
  assert.equal(seeded.tasks[0].status, "ready");

  await store.transact((state) => {
    const attempt: Run = {
      id: "run-attempt-x", threadId: "thread-one", agentId: "worker", nodeId: "node-worker", harnessId: "codex-cli",
      model: "default", workspace: "/workspace", prompt: "Attempt x", status: "queued", output: "", depth: 1, createdAt: at
    };
    assignTaskAttempt(state, taskXId, attempt, at);
    applyRunLifecycle(state, { type: "run.started", runId: "run-attempt-x", at });
    applyRunLifecycle(state, { type: "run.failed", runId: "run-attempt-x", error: "boom", at });
  });

  const blocked = await submitTaskBatch(store, "run-source", {
    idempotencyKey: "seed-z",
    tasks: [taskInput("z", [{ taskId: taskXId, policy: "require-success" }])]
  }, at);
  assert.equal(blocked.tasks[0].status, "blocked");
  assert.ok(blocked.tasks[0].error?.includes(taskXId));

  const allowed = await submitTaskBatch(store, "run-source", {
    idempotencyKey: "seed-w",
    tasks: [taskInput("w", [{ taskId: taskXId, policy: "allow-failure" }])]
  }, at);
  assert.equal(allowed.tasks[0].status, "ready");
});

test("rejects unauthorized or inactive sources without mutation", async () => {
  const { store, path } = await taskStore();
  const argumentsValue = { idempotencyKey: "authorization", tasks: [taskInput("a")] };
  await rejectsWithoutMutation(store, path, "run_not_active", () => submitTaskBatch(store, "run-missing", argumentsValue, at));

  await store.transact((state) => {
    state.runs.push(
      { ...sourceRun("run-queued", "thread-one"), status: "queued" },
      { ...sourceRun("run-completed", "thread-one"), status: "completed" },
      sourceRun("run-worker", "thread-one", "worker"),
      { ...sourceRun("run-loose", "thread-one"), threadId: undefined }
    );
  });
  await rejectsWithoutMutation(store, path, "run_not_active", () => submitTaskBatch(store, "run-queued", argumentsValue, at));
  await rejectsWithoutMutation(store, path, "run_not_active", () => submitTaskBatch(store, "run-completed", argumentsValue, at));
  await rejectsWithoutMutation(store, path, "forbidden", () => submitTaskBatch(store, "run-worker", argumentsValue, at));
  await rejectsWithoutMutation(store, path, "not_found", () => submitTaskBatch(store, "run-loose", argumentsValue, at));

  for (const status of ["completed", "archived"] as const) {
    const current = await taskStore();
    await current.store.transact((state) => {
      const target = state.threads?.find((item) => item.id === "thread-one");
      if (target) target.status = status;
    });
    await rejectsWithoutMutation(current.store, current.path, "thread_inactive", () => submitTaskBatch(current.store, "run-source", argumentsValue, at));
  }
});

test("rejects malformed batches without mutation", async () => {
  const { store, path } = await taskStore();
  const validTask = taskInput("a");
  const cases: Array<{ label: string; code: string; argumentsValue: unknown }> = [
    { label: "not an object", code: "invalid_arguments", argumentsValue: null },
    { label: "missing idempotencyKey", code: "invalid_arguments", argumentsValue: { tasks: [validTask] } },
    { label: "empty tasks array", code: "invalid_arguments", argumentsValue: { idempotencyKey: "key", tasks: [] } },
    {
      label: "too many tasks", code: "batch_too_large",
      argumentsValue: { idempotencyKey: "key", tasks: Array.from({ length: 33 }, (_, index) => taskInput(`task-${index}`)) }
    },
    { label: "duplicate local key", code: "duplicate_task_key", argumentsValue: { idempotencyKey: "key", tasks: [taskInput("a"), taskInput("a")] } },
    { label: "key with a space", code: "invalid_arguments", argumentsValue: { idempotencyKey: "key", tasks: [taskInput("a", [], { key: "has space" })] } },
    { label: "key with a slash", code: "invalid_arguments", argumentsValue: { idempotencyKey: "key", tasks: [taskInput("a", [], { key: "a/b" })] } },
    { label: "empty title", code: "invalid_arguments", argumentsValue: { idempotencyKey: "key", tasks: [taskInput("a", [], { title: "   " })] } },
    { label: "title over the limit", code: "invalid_arguments", argumentsValue: { idempotencyKey: "key", tasks: [taskInput("a", [], { title: "x".repeat(201) })] } },
    { label: "instructions over the limit", code: "invalid_arguments", argumentsValue: { idempotencyKey: "key", tasks: [taskInput("a", [], { instructions: "x".repeat(16_001) })] } },
    { label: "unknown batch field", code: "invalid_arguments", argumentsValue: { idempotencyKey: "key", tasks: [validTask], priority: "high" } },
    { label: "unknown task field", code: "invalid_arguments", argumentsValue: { idempotencyKey: "key", tasks: [{ ...validTask, priority: "high" }] } },
    { label: "requirements not an object", code: "invalid_arguments", argumentsValue: { idempotencyKey: "key", tasks: [{ ...validTask, requirements: [] }] } },
    { label: "unknown requirements field", code: "invalid_arguments", argumentsValue: { idempotencyKey: "key", tasks: [{ ...validTask, requirements: { caffeine: true } }] } },
    { label: "unknown harness", code: "invalid_arguments", argumentsValue: { idempotencyKey: "key", tasks: [{ ...validTask, requirements: { harnessIds: ["unknown-harness"] } }] } },
    { label: "unknown transport", code: "invalid_arguments", argumentsValue: { idempotencyKey: "key", tasks: [{ ...validTask, requirements: { transports: ["grpc"] } }] } },
    { label: "zero minimum concurrency", code: "invalid_arguments", argumentsValue: { idempotencyKey: "key", tasks: [{ ...validTask, requirements: { minimumConcurrency: 0 } }] } },
    { label: "fractional minimum concurrency", code: "invalid_arguments", argumentsValue: { idempotencyKey: "key", tasks: [{ ...validTask, requirements: { minimumConcurrency: 1.5 } }] } },
    { label: "string minimum concurrency", code: "invalid_arguments", argumentsValue: { idempotencyKey: "key", tasks: [{ ...validTask, requirements: { minimumConcurrency: "2" } }] } },
    { label: "workspace without writable", code: "invalid_arguments", argumentsValue: { idempotencyKey: "key", tasks: [{ ...validTask, requirements: { workspace: { repository: "/repo" } } }] } },
    {
      label: "dependency with key and taskId", code: "invalid_arguments",
      argumentsValue: { idempotencyKey: "key", tasks: [taskInput("a", [{ key: "b", taskId: "task_b" }]), taskInput("b")] }
    },
    { label: "dependency with neither key nor taskId", code: "invalid_arguments", argumentsValue: { idempotencyKey: "key", tasks: [taskInput("a", [{ policy: "require-success" }])] } },
    {
      label: "unknown dependency policy", code: "invalid_arguments",
      argumentsValue: { idempotencyKey: "key", tasks: [taskInput("a", [{ key: "b", policy: "sometimes" }]), taskInput("b")] }
    },
    {
      label: "repeated dependency with different policies", code: "invalid_arguments",
      argumentsValue: { idempotencyKey: "key", tasks: [taskInput("a", [{ key: "b", policy: "require-success" }, { key: "b", policy: "allow-failure" }]), taskInput("b")] }
    },
    {
      label: "too many dependencies", code: "invalid_arguments",
      argumentsValue: { idempotencyKey: "key", tasks: [{ ...validTask, dependencies: Array.from({ length: 33 }, (_, index) => ({ key: `dep-${index}` })) }] }
    }
  ];
  for (const [index, item] of cases.entries()) {
    await rejectsWithoutMutation(store, path, item.code, () => submitTaskBatch(store, "run-source", item.argumentsValue, at));
    assert.equal(store.read((state) => state.tasks?.length), 0, `case ${index}: ${item.label}`);
  }
});

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id, threadId: "thread-one", title: `Task ${id}`, instructions: "Do the work", status: "ready",
    requirements: {}, dependencies: [], idempotencyKey: "batch-one", attemptRunIds: [],
    createdAt: at, updatedAt: at, ...overrides
  };
}

function attemptRun(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id, threadId: "thread-one", agentId: "worker", nodeId: "node-worker", harnessId: "codex-cli",
    model: "default", workspace: "/workspace", prompt: "Attempt", status: "queued", output: "",
    depth: 1, createdAt: at, ...overrides
  };
}

function taskState(tasks: Task[], runs: Run[] = []): State & { tasks: Task[] } {
  return {
    agents: [agent("orchestrator", true), agent("worker")],
    nodes: [node("node-orchestrator"), node("node-worker")],
    runs,
    events: [],
    messages: [],
    threads: [thread("thread-one"), thread("thread-two")],
    tasks
  };
}

function throwsWithoutMutation(state: State, code: string, action: () => unknown) {
  const before = structuredClone(state);
  assert.throws(action, (error: unknown) => error instanceof CoordinationError && error.code === code);
  assert.deepEqual(state, before);
}

test("assignTaskAttempt places a queued run as an immutable attempt", () => {
  const current = taskState([task("task-one")]);
  const attempt = attemptRun("run-attempt-one");
  assignTaskAttempt(current, "task-one", attempt, at);
  assert.equal(attempt.taskId, "task-one");
  assert.equal(attempt.attempt, 1);
  assert.equal(current.runs[0].id, "run-attempt-one");
  assert.equal(current.tasks[0].status, "assigned");
  assert.equal(current.tasks[0].assignment?.runId, "run-attempt-one");
  assert.equal(current.tasks[0].assignment?.agentId, "worker");
  assert.equal(current.tasks[0].assignment?.transport, "native-cli");
  assert.deepEqual(current.tasks[0].attemptRunIds, ["run-attempt-one"]);
});

test("assignTaskAttempt rejects tasks and runs that cannot receive an attempt", () => {
  const assignment: TaskAssignment = {
    runId: "run-attempt-one", agentId: "worker", nodeId: "node-worker", harnessId: "codex-cli",
    transport: "native-cli", model: "default", assignedAt: at
  };
  const pending = taskState([task("task-one", { status: "pending" })]);
  throwsWithoutMutation(pending, "task_not_ready", () => assignTaskAttempt(pending, "task-one", attemptRun("run-attempt-one"), at));

  const assigned = taskState([task("task-one", { status: "assigned", assignment })]);
  throwsWithoutMutation(assigned, "task_not_ready", () => assignTaskAttempt(assigned, "task-one", attemptRun("run-attempt-two"), at));

  const otherThread = taskState([task("task-one")]);
  throwsWithoutMutation(otherThread, "invalid_attempt",
    () => assignTaskAttempt(otherThread, "task-one", attemptRun("run-attempt-one", { threadId: "thread-two" }), at));

  const alreadyStarted = taskState([task("task-one")]);
  throwsWithoutMutation(alreadyStarted, "invalid_attempt",
    () => assignTaskAttempt(alreadyStarted, "task-one", attemptRun("run-attempt-one", { status: "running" }), at));

  const duplicate = taskState([task("task-one")], [attemptRun("run-attempt-one")]);
  throwsWithoutMutation(duplicate, "invalid_attempt", () => assignTaskAttempt(duplicate, "task-one", attemptRun("run-attempt-one"), at));
});

test("run lifecycle settles a task and releases its dependents", () => {
  const dependent = task("task-dependent", { status: "pending", dependencies: [{ taskId: "task-one", policy: "require-success" }] });
  const current = taskState([task("task-one"), dependent]);
  assignTaskAttempt(current, "task-one", attemptRun("run-attempt-one"), at);

  assert.equal(applyRunLifecycle(current, { type: "run.started", runId: "run-attempt-one", at }), true);
  assert.equal(current.tasks[0].status, "running");
  assert.equal(applyRunLifecycle(current, { type: "run.completed", runId: "run-attempt-one", output: "All done", at }), true);
  assert.equal(current.tasks[0].status, "completed");
  assert.equal(current.tasks[0].result, "All done");
  assert.equal(current.tasks[0].finishedAt, at);
  assert.equal(dependent.status, "ready");
});

test("a failed attempt blocks require-success dependents and frees allow-failure ones", () => {
  const requireSuccess = task("task-require", { status: "pending", dependencies: [{ taskId: "task-one", policy: "require-success" }] });
  const allowFailure = task("task-allow", { status: "pending", dependencies: [{ taskId: "task-one", policy: "allow-failure" }] });
  const transitive = task("task-transitive", { status: "pending", dependencies: [{ taskId: "task-require", policy: "require-success" }] });
  const current = taskState([task("task-one"), requireSuccess, allowFailure, transitive]);
  assignTaskAttempt(current, "task-one", attemptRun("run-attempt-one"), at);
  applyRunLifecycle(current, { type: "run.started", runId: "run-attempt-one", at });
  applyRunLifecycle(current, { type: "run.failed", runId: "run-attempt-one", error: "boom", at });

  assert.equal(current.tasks[0].status, "failed");
  assert.equal(current.tasks[0].error, "boom");
  assert.equal(requireSuccess.status, "blocked");
  assert.ok(requireSuccess.error?.includes("task-one"));
  assert.notEqual(requireSuccess.status, "ready");
  assert.equal(transitive.status, "blocked");
  assert.equal(allowFailure.status, "ready");
});

test("a retryable failure returns the task to ready and retries keep attempt history", () => {
  const current = taskState([task("task-one")]);
  assignTaskAttempt(current, "task-one", attemptRun("run-attempt-one"), at);
  applyRunLifecycle(current, { type: "run.started", runId: "run-attempt-one", at });

  const firstRun = current.runs.find((item) => item.id === "run-attempt-one");
  assert.ok(firstRun);
  firstRun.status = "failed";
  firstRun.error = "lost compute";
  assert.equal(applyAttemptOutcome(current, "run-attempt-one", at, { retryable: true }), true);
  assert.equal(current.tasks[0].status, "ready");
  assert.equal(current.tasks[0].assignment, undefined);
  assert.deepEqual(current.tasks[0].attemptRunIds, ["run-attempt-one"]);

  const firstRunBeforeRetry = structuredClone(firstRun);
  const secondRun = attemptRun("run-attempt-two");
  assignTaskAttempt(current, "task-one", secondRun, at);
  assert.equal(secondRun.attempt, 2);
  assert.deepEqual(current.tasks[0].attemptRunIds, ["run-attempt-one", "run-attempt-two"]);
  assert.deepEqual(current.runs.find((item) => item.id === "run-attempt-one"), firstRunBeforeRetry);
  assert.equal(current.tasks[0].id, "task-one");
});

test("late results cannot resurrect a settled task", () => {
  const cancelled = taskState([task("task-one")]);
  assignTaskAttempt(cancelled, "task-one", attemptRun("run-attempt-one"), at);
  applyRunLifecycle(cancelled, { type: "run.started", runId: "run-attempt-one", at });
  assert.equal(cancelTaskInState(cancelled, "task-one", at).kind, "cancelled");
  assert.equal(applyRunLifecycle(cancelled, { type: "run.completed", runId: "run-attempt-one", output: "late", at }), true);
  assert.equal(cancelled.tasks[0].status, "cancelled");
  assert.equal(cancelled.tasks[0].result, undefined);

  const retried = taskState([task("task-one")]);
  assignTaskAttempt(retried, "task-one", attemptRun("run-attempt-one"), at);
  applyRunLifecycle(retried, { type: "run.started", runId: "run-attempt-one", at });
  retried.runs[0].status = "failed";
  retried.runs[0].error = "lost compute";
  applyAttemptOutcome(retried, "run-attempt-one", at, { retryable: true });
  assignTaskAttempt(retried, "task-one", attemptRun("run-attempt-two"), at);
  applyRunLifecycle(retried, { type: "run.started", runId: "run-attempt-two", at });
  const stale = retried.runs.find((item) => item.id === "run-attempt-one");
  assert.ok(stale);
  stale.status = "completed";
  stale.output = "late";
  assert.equal(applyAttemptOutcome(retried, "run-attempt-one", at), false);
  assert.equal(retried.tasks[0].status, "running");
  assert.equal(retried.tasks[0].result, undefined);
});

test("cancelTaskInState cancels non-terminal tasks and re-derives dependents", () => {
  const ready = taskState([task("task-one")]);
  assert.deepEqual(cancelTaskInState(ready, "task-one", at), { kind: "cancelled", task: ready.tasks[0], activeAttemptRunId: undefined });
  assert.equal(ready.tasks[0].status, "cancelled");

  const assignment: TaskAssignment = {
    runId: "run-attempt-one", agentId: "worker", nodeId: "node-worker", harnessId: "codex-cli",
    transport: "native-cli", model: "default", assignedAt: at
  };
  const assigned = taskState([task("task-one", { status: "assigned", assignment })]);
  const assignedResult = cancelTaskInState(assigned, "task-one", at);
  assert.equal(assignedResult.kind, "cancelled");
  assert.equal(assignedResult.activeAttemptRunId, "run-attempt-one");

  const terminal = taskState([task("task-one", { status: "completed", finishedAt: at })]);
  assert.equal(cancelTaskInState(terminal, "task-one", at).kind, "already-terminal");
  assert.equal(cancelTaskInState(taskState([task("task-one")]), "task-missing", at).kind, "not-found");

  const requireSuccess = task("task-require", { status: "pending", dependencies: [{ taskId: "task-one", policy: "require-success" }] });
  const allowFailure = task("task-allow", { status: "pending", dependencies: [{ taskId: "task-one", policy: "allow-failure" }] });
  const withDependents = taskState([task("task-one"), requireSuccess, allowFailure]);
  cancelTaskInState(withDependents, "task-one", at);
  assert.equal(requireSuccess.status, "blocked");
  assert.equal(allowFailure.status, "ready");
});

test("cancelPersistedTask cancels the task and its attempt before delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-tasks-"));
  const store = new Store(join(directory, "state.json"));
  await store.load();
  const assignment: TaskAssignment = {
    runId: "run-attempt-one", agentId: "worker", nodeId: "node-worker", harnessId: "codex-cli",
    transport: "native-cli", model: "default", assignedAt: at
  };
  await store.transact((state) => {
    state.agents = [agent("orchestrator", true), agent("worker")];
    state.nodes = [node("node-orchestrator"), node("node-worker")];
    state.threads = [thread("thread-one")];
    state.tasks = [task("task-one", { status: "assigned", assignment, attemptRunIds: ["run-attempt-one"] })];
    state.runs = [attemptRun("run-attempt-one", { taskId: "task-one", attempt: 1 })];
  });

  const delivered: HubToControlAgent[] = [];
  const result = await cancelPersistedTask(store, "task-one", (_nodeId, message) => {
    delivered.push(message);
    return true;
  }, at);
  assert.equal(result.kind, "cancelled");
  assert.equal(result.activeAttemptRunId, "run-attempt-one");
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0], { type: "cancel", runId: "run-attempt-one" });
  assert.equal(store.snapshot().tasks?.[0].status, "cancelled");
  assert.equal(store.getRun("run-attempt-one")?.status, "cancelled");
});

test("transitionTask rejects moves the protocol forbids", () => {
  assert.throws(() => transitionTask(task("task-one", { status: "completed", finishedAt: at }), "ready", at),
    (error: unknown) => error instanceof CoordinationError && error.code === "invalid_transition");
  assert.throws(() => transitionTask(task("task-one", { status: "pending" }), "assigned", at),
    (error: unknown) => error instanceof CoordinationError && error.code === "invalid_transition");
});

test("readiness and readyTasks describe the schedulable frontier", () => {
  const completed = task("task-completed", { status: "completed", finishedAt: at });
  const running = task("task-running", { status: "running" });
  const failed = task("task-failed", { status: "failed", finishedAt: at });
  const observed = task("task-observed", { status: "pending", dependencies: [
    { taskId: "task-completed", policy: "require-success" },
    { taskId: "task-running", policy: "allow-failure" },
    { taskId: "task-failed", policy: "require-success" }
  ] });
  const waiting = task("task-waiting", { status: "pending", dependencies: [{ taskId: "task-running", policy: "require-success" }] });
  const current = taskState([completed, running, failed, observed, waiting]);

  const readiness = taskReadiness(current, observed);
  assert.deepEqual(readiness.satisfiedBy, ["task-completed"]);
  assert.deepEqual(readiness.waitingOn, ["task-running"]);
  assert.deepEqual(readiness.blockedBy, ["task-failed"]);
  assert.equal(readiness.outcome, "blocking");
  assert.equal(taskReadiness(current, waiting).outcome, "waiting");

  const assignment: TaskAssignment = {
    runId: "run-attempt-one", agentId: "worker", nodeId: "node-worker", harnessId: "codex-cli",
    transport: "native-cli", model: "default", assignedAt: at
  };
  const frontier = taskState([
    task("task-ready-one"),
    task("task-ready-assigned", { assignment }),
    task("task-ready-other", { threadId: "thread-two" }),
    task("task-pending", { status: "pending" })
  ]);
  assert.deepEqual(readyTasks(frontier).map((item) => item.id), ["task-ready-one", "task-ready-other"]);
  assert.deepEqual(readyTasks(frontier, "thread-two").map((item) => item.id), ["task-ready-other"]);
});

test("thread projections are deterministic and scoped to their thread", () => {
  const current = taskState([
    task("task-one", {
      status: "running",
      dependencies: [{ taskId: "task-two", policy: "require-success" }],
      attemptRunIds: ["run-attempt-one", "run-attempt-two"]
    }),
    task("task-two", { status: "running" })
  ], [
    attemptRun("run-attempt-one", { taskId: "task-one", attempt: 1, status: "failed", error: "lost compute", finishedAt: at }),
    attemptRun("run-attempt-two", { taskId: "task-one", attempt: 2, status: "running", startedAt: at })
  ]);
  current.taskSubmissions = [{
    id: "tasksub-one", threadId: "thread-one", sourceRunId: "run-source", creatorAgentId: "orchestrator",
    idempotencyKey: "batch-one", digest: "0".repeat(64), tasks: [{ key: "one", taskId: "task-one" }], createdAt: at
  }];

  assert.deepEqual(threadTaskGraph(current, "thread-one"), threadTaskGraph(current, "thread-one"));
  const projection = taskContextProjection(current, "thread-one", "task-one");
  assert.deepEqual(projection.attempts.map((attempt) => [attempt.runId, attempt.attempt]), [["run-attempt-one", 1], ["run-attempt-two", 2]]);
  assert.deepEqual(projection.dependentTaskIds, []);
  assert.equal(projection.creatorAgentId, "orchestrator");
  assert.equal(taskContextProjection(current, "thread-one", "task-two").dependentTaskIds.includes("task-one"), true);
  assert.throws(() => taskContextProjection(current, "thread-two", "task-one"),
    (error: unknown) => error instanceof CoordinationError && error.code === "not_found");
});

test("a persistence failure leaves the in-memory state unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-tasks-"));
  const path = join(directory, "nested", "state.json");
  const store = new Store(path);
  await store.load();
  await store.transact((state) => {
    state.agents = [agent("orchestrator", true)];
    state.threads = [thread("thread-one")];
    state.runs = [sourceRun("run-source", "thread-one")];
  });

  await rm(join(directory, "nested"), { recursive: true, force: true });
  await writeFile(join(directory, "nested"), "not a directory");
  await assert.rejects(submitTaskBatch(store, "run-source", { idempotencyKey: "fan-out", tasks: [taskInput("a")] }, at));
  assert.deepEqual(store.snapshot().tasks, []);
  assert.deepEqual(store.read((state) => state.taskSubmissions), [], "no submission survives a failed transaction");
});
