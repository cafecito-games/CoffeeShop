import assert from "node:assert/strict";
import test from "node:test";
import { orchestrationToolLimits, type Artifact } from "@coffee-shop/protocol";
import { CoordinationError } from "./coordination.js";
import {
  fixtureAgent,
  fixtureHandler,
  fixtureTime,
  orchestrationStore,
  outputViolations,
  rootRunId,
  startAttempt
} from "./hubToolsTestSupport.js";
import type { NodeConnection } from "./scheduler.js";
import type { Store } from "./store.js";
import { applyAttemptOutcome, cancelTaskInState } from "./tasks.js";

type HubCall = ReturnType<typeof fixtureHandler>["call"];

interface TaskContextResult {
  thread: { id: string };
  task: { id: string; status: string; agentId: string; objective: string; depth: number };
  caller: { runId: string; taskId?: string; role: string; canDelegate: boolean };
  durableTask?: { id: string; status: string };
  childTasks: Array<{ id: string }>;
  taskGraph: Array<{ id: string }>;
  taskGraphTruncated: boolean;
  mailbox: { participant?: { type: string; taskId?: string }; cursor: string };
  delegations: unknown[];
  artifacts: unknown[];
  availableAgents: Array<{ id: string }>;
  limits: { maxDepth: number; remainingDepth: number; maxTasksPerRun: number; remainingTasks: number };
  version: string;
}

interface InventoryResult {
  generatedAt: string;
  agents: Array<{ id: string; self: boolean }>;
  offerings: Array<{ nodeId: string; harnessId: string; model: string; transport: string; fallbackTransport?: string }>;
  instances: Array<{ id: string; threadId: string; status: string; nodeId?: string; model?: string; allocationStatus?: string }>;
  nodes: Array<{
    id: string;
    connected: boolean;
    acceptsTasks: boolean;
    concurrency: number;
    slotsInUse: number;
    instanceCapacity: number;
    residentSlotsInUse: number;
    offersInstances: boolean;
    capabilities: Array<{ capabilityId: string; state: string; value?: string }>;
    capabilitiesReportedAt?: string;
  }>;
  truncated: { agents: boolean; nodes: boolean; instances: boolean; offerings: boolean };
}

interface UpdateResult {
  created: boolean;
  updateId: string;
  task: { id: string; status: string; progress?: { summary?: string; blockedReason?: string; completion?: { summary: string; artifactIds: string[] }; runId: string } };
}

interface SubmissionResult {
  created: boolean;
  taskIdsByKey: Record<string, string>;
  tasks: Array<{ id: string; status: string; placementOverride?: { instanceId?: string; agentId?: string; nodeId?: string; authorizedBy: string } }>;
}

const isCode = (code: string) => (error: unknown): error is CoordinationError =>
  error instanceof CoordinationError && error.code === code;

async function submitSingleTask(call: HubCall, sourceRunId: string, key: string, idempotencyKey: string): Promise<string> {
  const submitted = await call("submit_tasks", sourceRunId, {
    idempotencyKey, tasks: [{ key, title: key, instructions: `Work for ${key}` }]
  }) as SubmissionResult;
  return submitted.taskIdsByKey[key];
}

async function seedArtifact(store: Store, id: string, overrides: Partial<Artifact> = {}) {
  await store.transact((state) => {
    state.artifacts ??= [];
    state.artifacts.push({
      id, threadId: "thread-one", runId: rootRunId, agentId: "orchestrator", relativePath: "reports/out.txt",
      title: `Report ${id}`, kind: "report", mediaType: "text/plain", summary: "", size: 12,
      sha256: "a".repeat(64), downloadPath: `/api/artifacts/${id}/content`, uploaded: true,
      idempotencyKey: `artifact-${id}`, createdAt: fixtureTime, ...overrides
    });
  });
  return id;
}

const storedTask = (store: Store, taskId: string) =>
  store.read((state) => state.tasks!.find((task) => task.id === taskId)!);

const updateRecordCount = (store: Store, taskId: string) =>
  store.read((state) => (state.taskUpdates ?? []).filter((record) => record.taskId === taskId).length);

async function taskWithRunningAttempt(store: Store, call: HubCall, key: string, idempotencyKey: string) {
  const taskId = await submitSingleTask(call, rootRunId, key, idempotencyKey);
  const runId = await startAttempt(store, taskId, "worker-b");
  return { taskId, runId };
}

test("get_task_context keeps its legacy fields and adds the caller, durable task, and mailbox", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const orchestratorContext = await hub.call("get_task_context", rootRunId, {}) as TaskContextResult;
  assert.deepEqual(outputViolations("get_task_context", orchestratorContext), []);
  for (const field of ["thread", "task", "delegations", "artifacts", "availableAgents", "limits", "version"] as const) {
    assert.notEqual(orchestratorContext[field], undefined, field);
  }
  assert.deepEqual(orchestratorContext.caller, { runId: rootRunId, role: "orchestrator", canDelegate: true });
  assert.deepEqual(orchestratorContext.mailbox.participant, { type: "orchestrator" });
  assert.match(orchestratorContext.mailbox.cursor, /^tev1\./);
  assert.deepEqual(orchestratorContext.taskGraph, []);
  assert.equal(orchestratorContext.taskGraphTruncated, false);
  assert.deepEqual(orchestratorContext.childTasks, []);
  assert.equal(orchestratorContext.durableTask, undefined);
  assert.ok(orchestratorContext.availableAgents.some((agent) => agent.id === "worker-a"));

  const taskId = await submitSingleTask(hub.call, rootRunId, "described", "context-described-1");
  const workerRunId = await startAttempt(store, taskId, "worker-b");
  const workerContext = await hub.call("get_task_context", workerRunId, {}) as TaskContextResult;
  assert.deepEqual(outputViolations("get_task_context", workerContext), []);
  assert.deepEqual(workerContext.caller, { runId: workerRunId, taskId, role: "task", canDelegate: false });
  assert.equal(workerContext.durableTask?.id, taskId);
  assert.deepEqual(workerContext.mailbox.participant, { type: "task", taskId });
  assert.deepEqual(workerContext.availableAgents, []);
  assert.equal(workerContext.task.id, workerRunId);
  assert.equal(workerContext.task.status, "running");
  assert.equal(workerContext.task.agentId, "worker-b");
});

test("get_task_context accepts visible durable task ids and lineage run ids", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const taskId = await submitSingleTask(hub.call, rootRunId, "focused", "context-focused-1");
  const workerRunId = await startAttempt(store, taskId, "worker-b");
  const focused = await hub.call("get_task_context", rootRunId, { taskId }) as TaskContextResult;
  assert.equal(focused.durableTask?.id, taskId);
  assert.equal(focused.task.id, workerRunId);
  const byRunId = await hub.call("get_task_context", rootRunId, { taskId: workerRunId }) as TaskContextResult;
  assert.equal(byRunId.task.id, workerRunId);
  const workerFocus = await hub.call("get_task_context", workerRunId, { taskId }) as TaskContextResult;
  assert.equal(workerFocus.durableTask?.id, taskId);
  await assert.rejects(hub.call("get_task_context", rootRunId, { taskId, extra: true }), isCode("invalid_arguments"));
});

test("a worker's task graph contains only the tasks it can read", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const submitted = await hub.call("submit_tasks", rootRunId, {
    idempotencyKey: "graph-scope",
    tasks: [
      { key: "left", title: "Left", instructions: "Left work" },
      { key: "right", title: "Right", instructions: "Right work" }
    ]
  }) as SubmissionResult;
  const leftId = submitted.taskIdsByKey.left;
  const rightId = submitted.taskIdsByKey.right;
  const leftRunId = await startAttempt(store, leftId, "worker-b");
  const workerContext = await hub.call("get_task_context", leftRunId, {}) as TaskContextResult;
  assert.deepEqual(workerContext.taskGraph.map((task) => task.id), [leftId]);
  assert.deepEqual(workerContext.childTasks, []);
  const orchestratorContext = await hub.call("get_task_context", rootRunId, {}) as TaskContextResult;
  assert.deepEqual([...orchestratorContext.taskGraph.map((task) => task.id)].sort(), [leftId, rightId].sort());
});

test("get_execution_inventory is reserved for delegating callers and takes no arguments", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const taskId = await submitSingleTask(hub.call, rootRunId, "inventoried", "inventory-1");
  const workerRunId = await startAttempt(store, taskId, "worker-b");
  await assert.rejects(hub.call("get_execution_inventory", workerRunId, {}), isCode("forbidden"));
  await assert.rejects(hub.call("get_execution_inventory", rootRunId, { extra: true }), isCode("invalid_arguments"));
  const inventory = await hub.call("get_execution_inventory", rootRunId, {}) as InventoryResult;
  assert.deepEqual(outputViolations("get_execution_inventory", inventory), []);
});

test("execution inventory redacts prompts, paths, raw evidence, and diagnostics", async () => {
  const store = await orchestrationStore();
  const observedAt = new Date().toISOString();
  const report = {
    nodeId: "node-worker-a",
    evidence: [{
      capabilityId: "os", source: "runtime" as const, success: true, rawValue: "RAW-SECRET-os",
      normalizedValue: "darwin", observedAt, diagnostic: "DIAG-SECRET"
    }],
    at: observedAt
  };
  const hub = fixtureHandler(store, {
    reports: { "node-worker-a": report },
    connections: { "node-worker-a": { protocolVersion: "4", synced: true } }
  });
  const inventory = await hub.call("get_execution_inventory", rootRunId, {}) as InventoryResult;
  const serialized = JSON.stringify(inventory);
  for (const secret of ["secret prompt for", "/workspace", "/usr/local/bin/codex", "RAW-SECRET", "DIAG-SECRET"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  const node = inventory.nodes.find((candidate) => candidate.id === "node-worker-a")!;
  assert.equal(node.connected, true);
  assert.equal(node.acceptsTasks, true);
  assert.equal(node.capabilitiesReportedAt, report.at);
  const capability = node.capabilities.find((candidate) => candidate.capabilityId === "os")!;
  assert.equal(capability.state, "ok");
  assert.equal(capability.value, "darwin");
});

test("stale capability evidence resolves to stale without a value", async () => {
  const store = await orchestrationStore();
  const observedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const hub = fixtureHandler(store, {
    reports: {
      "node-worker-a": {
        nodeId: "node-worker-a",
        evidence: [{ capabilityId: "os", source: "runtime" as const, success: true, normalizedValue: "darwin", observedAt }],
        at: observedAt
      }
    }
  });
  const inventory = await hub.call("get_execution_inventory", rootRunId, {}) as InventoryResult;
  const capability = inventory.nodes.find((candidate) => candidate.id === "node-worker-a")!.capabilities
    .find((candidate) => candidate.capabilityId === "os")!;
  assert.equal(capability.state, "stale");
  assert.equal("value" in capability, false);
});

test("acceptsTasks requires a connected, synced, version-four node", async () => {
  const store = await orchestrationStore();
  const cases: Array<{ connections: Record<string, NodeConnection>; connected: boolean; acceptsTasks: boolean }> = [
    { connections: {}, connected: false, acceptsTasks: false },
    { connections: { "node-worker-a": { protocolVersion: "4", synced: false } }, connected: true, acceptsTasks: false },
    { connections: { "node-worker-a": { protocolVersion: "3", synced: true } }, connected: true, acceptsTasks: false },
    { connections: { "node-worker-a": { protocolVersion: "4", synced: true } }, connected: true, acceptsTasks: true }
  ];
  for (const item of cases) {
    const hub = fixtureHandler(store, { connections: item.connections });
    const inventory = await hub.call("get_execution_inventory", rootRunId, {}) as InventoryResult;
    const node = inventory.nodes.find((candidate) => candidate.id === "node-worker-a")!;
    assert.equal(node.connected, item.connected);
    assert.equal(node.acceptsTasks, item.acceptsTasks);
  }
});

test("the inventory agent list is bounded and reports truncation", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  await store.transact((state) => {
    for (let index = 0; index < orchestrationToolLimits.inventoryAgents - 4; index += 1) {
      state.agents.push(fixtureAgent(`extra-agent-${index.toString().padStart(2, "0")}`));
    }
  });
  const inventory = await hub.call("get_execution_inventory", rootRunId, {}) as InventoryResult;
  assert.equal(inventory.agents.length, orchestrationToolLimits.inventoryAgents);
  assert.equal(inventory.truncated.agents, true);
  assert.equal(inventory.truncated.nodes, false);
  assert.equal(inventory.agents.some((agent) => agent.id === "worker-c"), false);
});

test("a pin becomes a policy-authorized placement override on the stored task", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const submitted = await hub.call("submit_tasks", rootRunId, {
    idempotencyKey: "pin-agent",
    tasks: [{ key: "pinned-agent", title: "Pinned", instructions: "Pinned work", pin: { agentId: "worker-b" } }]
  }) as SubmissionResult;
  assert.deepEqual(submitted.tasks[0].placementOverride, { agentId: "worker-b", authorizedBy: "policy" });
  assert.deepEqual(storedTask(store, submitted.taskIdsByKey["pinned-agent"]).placementOverride, { agentId: "worker-b", authorizedBy: "policy" });

  const nodePinned = await hub.call("submit_tasks", rootRunId, {
    idempotencyKey: "pin-node",
    tasks: [{ key: "pinned-node", title: "Pinned", instructions: "Pinned work", pin: { nodeId: "node-worker-c" } }]
  }) as SubmissionResult;
  assert.deepEqual(storedTask(store, nodePinned.taskIdsByKey["pinned-node"]).placementOverride, { nodeId: "node-worker-c", authorizedBy: "policy" });
});

test("an instance pin is authorized atomically, stays stable on replay, and never accepts a hidden target", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  await store.transact((state) => {
    state.instances = [
      {
        id: "instance-ready", threadId: "thread-one", creator: { kind: "operator", operatorId: "operator" },
        delegation: { canDelegate: false }, requirements: {}, lease: { idleTimeoutSeconds: 1800, expiresAt: fixtureTime },
        status: "ready", createdAt: fixtureTime, updatedAt: fixtureTime
      },
      {
        id: "instance-foreign", threadId: "thread-two", creator: { kind: "operator", operatorId: "operator" },
        delegation: { canDelegate: false }, requirements: {}, lease: { idleTimeoutSeconds: 1800, expiresAt: fixtureTime },
        status: "ready", createdAt: fixtureTime, updatedAt: fixtureTime
      },
      {
        id: "instance-terminal", threadId: "thread-one", creator: { kind: "operator", operatorId: "operator" },
        delegation: { canDelegate: false }, requirements: {}, lease: { idleTimeoutSeconds: 1800, expiresAt: fixtureTime },
        status: "released", createdAt: fixtureTime, updatedAt: fixtureTime
      }
    ];
  });
  const argumentsValue = {
    idempotencyKey: "pin-instance",
    tasks: [{ key: "resident", title: "Resident", instructions: "Run here", pin: { instanceId: "instance-ready" } }]
  };
  const submitted = await hub.call("submit_tasks", rootRunId, argumentsValue) as SubmissionResult;
  assert.deepEqual(submitted.tasks[0].placementOverride, { instanceId: "instance-ready", authorizedBy: "policy" });

  await store.transact((state) => {
    state.instances!.find((item) => item.id === "instance-ready")!.status = "released";
  });
  const replay = await hub.call("submit_tasks", rootRunId, argumentsValue) as SubmissionResult;
  assert.deepEqual([replay.created, replay.tasks[0].id], [false, submitted.tasks[0].id],
    "an exact accepted replay does not revalidate a target that later became terminal");

  const before = store.read((state) => JSON.stringify([state.tasks, state.taskSubmissions, state.events]));
  const refusals: unknown[] = [];
  for (const [idempotencyKey, instanceId] of [
    ["pin-missing", "instance-missing"],
    ["pin-foreign", "instance-foreign"],
    ["pin-terminal", "instance-terminal"]
  ]) {
    refusals.push(await hub.call("submit_tasks", rootRunId, {
      idempotencyKey,
      tasks: [{ key: "resident", title: "Resident", instructions: "Run here", pin: { instanceId } }]
    }).catch((error: unknown) => error));
  }
  assert.ok(refusals.every((error) => error instanceof CoordinationError && error.code === "invalid_target"));
  assert.deepEqual(refusals.map((error) => (error as CoordinationError).message), Array(3).fill("The pinned instance is not available in this thread"));
  assert.equal(store.read((state) => JSON.stringify([state.tasks, state.taskSubmissions, state.events])), before);
});

test("pins naming unknown targets are rejected without writing anything", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  await assert.rejects(hub.call("submit_tasks", rootRunId, {
    idempotencyKey: "pin-ghost-agent",
    tasks: [{ key: "ghost-agent", title: "Ghost", instructions: "Ghost work", pin: { agentId: "ghost-agent" } }]
  }), isCode("invalid_target"));
  await assert.rejects(hub.call("submit_tasks", rootRunId, {
    idempotencyKey: "pin-ghost-node",
    tasks: [{ key: "ghost-node", title: "Ghost", instructions: "Ghost work", pin: { nodeId: "node-ghost" } }]
  }), isCode("invalid_target"));
  assert.equal(store.read((state) => state.tasks?.length ?? 0), 0);
});

test("malformed pins and direct placement overrides are invalid arguments", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const invalidBatches: unknown[] = [
    { idempotencyKey: "pin-string", tasks: [{ key: "string-pin", title: "Pin", instructions: "Work", pin: "worker-b" }] },
    { idempotencyKey: "pin-empty", tasks: [{ key: "empty-pin", title: "Pin", instructions: "Work", pin: {} }] },
    { idempotencyKey: "pin-field", tasks: [{ key: "field-pin", title: "Pin", instructions: "Work", pin: { agentId: "worker-b", extra: true } }] },
    { idempotencyKey: "pin-instance-agent", tasks: [{ key: "ambiguous", title: "Pin", instructions: "Work", pin: { instanceId: "instance-one", agentId: "worker-b" } }] },
    { idempotencyKey: "pin-instance-node", tasks: [{ key: "ambiguous", title: "Pin", instructions: "Work", pin: { instanceId: "instance-one", nodeId: "node-worker-b" } }] },
    {
      idempotencyKey: "pin-direct",
      tasks: [{ key: "direct-override", title: "Direct", instructions: "Work", placementOverride: { agentId: "worker-b", authorizedBy: "policy" } }]
    }
  ];
  for (const argumentsValue of invalidBatches) {
    await assert.rejects(hub.call("submit_tasks", rootRunId, argumentsValue), isCode("invalid_arguments"));
  }
  assert.equal(store.read((state) => state.tasks?.length ?? 0), 0);
});

test("the same batch pinned and unpinned under one idempotency key conflicts", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const pinned = {
    idempotencyKey: "pin-conflict",
    tasks: [{ key: "conflicted", title: "Conflicted", instructions: "Work", pin: { agentId: "worker-b" } }]
  };
  await hub.call("submit_tasks", rootRunId, pinned);
  await assert.rejects(hub.call("submit_tasks", rootRunId, {
    idempotencyKey: "pin-conflict",
    tasks: [{ key: "conflicted", title: "Conflicted", instructions: "Work" }]
  }), isCode("idempotency_conflict"));
  assert.equal(store.read((state) => state.tasks?.length ?? 0), 1);
});

test("a source run at or beyond the depth limit cannot submit", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  await store.transact((state) => {
    state.runs.find((run) => run.id === rootRunId)!.depth = 3;
  });
  await assert.rejects(hub.call("submit_tasks", rootRunId, {
    idempotencyKey: "depth-overflow", tasks: [{ key: "too-deep", title: "Deep", instructions: "Work" }]
  }), isCode("depth_limit"));
  assert.equal(store.read((state) => state.tasks?.length ?? 0), 0);
});

test("a source run cannot exceed its total task limit", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  for (let batch = 0; batch < orchestrationToolLimits.tasksPerSourceRun / 32; batch += 1) {
    await hub.call("submit_tasks", rootRunId, {
      idempotencyKey: `fanout-${batch}`,
      tasks: Array.from({ length: 32 }, (_, index) => ({
        key: `fanout-${batch}-${index}`, title: `Task ${batch}-${index}`, instructions: "Work"
      }))
    });
  }
  assert.equal(store.read((state) => state.tasks?.length ?? 0), orchestrationToolLimits.tasksPerSourceRun);
  await assert.rejects(hub.call("submit_tasks", rootRunId, {
    idempotencyKey: "fanout-overflow", tasks: [{ key: "one-too-many", title: "Overflow", instructions: "Work" }]
  }), isCode("fanout_limit"));
  assert.equal(store.read((state) => state.tasks?.length ?? 0), orchestrationToolLimits.tasksPerSourceRun);
});

test("update_task validates its arguments", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const { runId } = await taskWithRunningAttempt(store, hub.call, "update-shape", "update-shape-1");
  const invalidArguments: unknown[] = [
    { idempotencyKey: "update-extra", progress: "Half", extra: true },
    { idempotencyKey: "update-empty" },
    { idempotencyKey: "update-completion", completion: {} },
    { idempotencyKey: "update-blocked", blockedReason: "   " }
  ];
  for (const argumentsValue of invalidArguments) {
    await assert.rejects(hub.call("update_task", runId, argumentsValue), isCode("invalid_arguments"));
  }
  assert.equal(store.read((state) => (state.taskUpdates ?? []).length), 0);
});

test("only the task's current running assignee may update it", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const { taskId, runId } = await taskWithRunningAttempt(store, hub.call, "update-assignee", "update-assignee-1");
  await assert.rejects(hub.call("update_task", rootRunId, { idempotencyKey: "update-orchestrator", progress: "Half" }), isCode("forbidden"));

  await store.transact((state) => {
    const task = state.tasks!.find((task) => task.id === taskId)!;
    task.assignment = undefined;
    task.status = "ready";
  });
  const replacementRunId = await startAttempt(store, taskId, "worker-b", "run-update-replacement");
  await assert.rejects(hub.call("update_task", runId, { idempotencyKey: "update-stale", progress: "Stale" }), isCode("forbidden"));
  await hub.call("update_task", replacementRunId, { idempotencyKey: "update-current", progress: "Current" });

  await store.transact((state) => {
    cancelTaskInState(state, taskId, fixtureTime);
  });
  await assert.rejects(hub.call("update_task", replacementRunId, { idempotencyKey: "update-terminal", progress: "Terminal" }), isCode("forbidden"));
});

test("update_task records progress, blocked reasons, and completion without touching status", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const { taskId, runId } = await taskWithRunningAttempt(store, hub.call, "update-progress", "update-progress-1");
  const first = await hub.call("update_task", runId, { idempotencyKey: "update-one", progress: "Half done" }) as UpdateResult;
  assert.deepEqual(outputViolations("update_task", first), []);
  assert.equal(first.created, true);
  assert.equal(first.task.id, taskId);
  assert.equal(storedTask(store, taskId).progress?.summary, "Half done");
  assert.equal(storedTask(store, taskId).progress?.runId, runId);
  assert.equal(storedTask(store, taskId).status, "running");

  await hub.call("update_task", runId, { idempotencyKey: "update-blocked", blockedReason: "Waiting on CI" });
  assert.equal(storedTask(store, taskId).progress?.blockedReason, "Waiting on CI");
  assert.equal(storedTask(store, taskId).status, "running");
  await hub.call("update_task", runId, { idempotencyKey: "update-unblocked", blockedReason: null });
  assert.equal(storedTask(store, taskId).progress?.blockedReason, undefined);

  const attemptArtifactId = await seedArtifact(store, "artifact-attempt", { runId, agentId: "worker-b" });
  await hub.call("update_task", runId, {
    idempotencyKey: "update-completion", completion: { summary: "Done", artifactIds: [attemptArtifactId] }
  });
  assert.deepEqual(storedTask(store, taskId).progress?.completion, { summary: "Done", artifactIds: [attemptArtifactId] });
  assert.equal(storedTask(store, taskId).status, "running");
});

test("update_task replays exactly and conflicts on any difference", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const { taskId, runId } = await taskWithRunningAttempt(store, hub.call, "update-replay", "update-replay-1");
  const argumentsValue = { idempotencyKey: "update-replay-key", progress: "Same words" };
  const first = await hub.call("update_task", runId, argumentsValue) as UpdateResult;
  const replay = await hub.call("update_task", runId, argumentsValue) as UpdateResult;
  assert.equal(replay.created, false);
  assert.equal(replay.updateId, first.updateId);
  assert.equal(updateRecordCount(store, taskId), 1);
  await assert.rejects(hub.call("update_task", runId, { ...argumentsValue, progress: "Different words" }), isCode("idempotency_conflict"));
  assert.equal(updateRecordCount(store, taskId), 1);
});

test("completion artifacts must be uploaded by one of the task's attempts", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const { taskId, runId } = await taskWithRunningAttempt(store, hub.call, "update-artifacts", "update-artifacts-1");
  const foreignArtifactId = await seedArtifact(store, "artifact-foreign-run");
  const draftArtifactId = await seedArtifact(store, "artifact-attempt-draft", { runId, agentId: "worker-b", uploaded: false });
  const externalArtifactId = await seedArtifact(store, "artifact-external", {
    runId: undefined, agentId: undefined, sourceKey: "orchestrator-client:orchestrator-client-one"
  });
  for (const artifactId of [foreignArtifactId, draftArtifactId, externalArtifactId]) {
    await assert.rejects(hub.call("update_task", runId, {
      idempotencyKey: `update-artifact-${artifactId}`, completion: { summary: "Done", artifactIds: [artifactId] }
    }), isCode("invalid_artifact"));
  }
  assert.equal(storedTask(store, taskId).progress, undefined);
});

test("the per-task update limit is enforced", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const { taskId, runId } = await taskWithRunningAttempt(store, hub.call, "update-limit", "update-limit-1");
  await store.transact((state) => {
    state.taskUpdates ??= [];
    for (let index = 0; index < orchestrationToolLimits.updatesPerTask; index += 1) {
      state.taskUpdates.push({
        id: `taskupd-seed-${index}`, threadId: "thread-one", taskId, sourceRunId: runId, agentId: "worker-b",
        idempotencyKey: `update-seed-${index}`, digest: `digest-${index}`, createdAt: fixtureTime
      });
    }
  });
  await assert.rejects(hub.call("update_task", runId, { idempotencyKey: "update-over-limit", progress: "One too many" }), isCode("update_limit"));
  assert.equal(updateRecordCount(store, taskId), orchestrationToolLimits.updatesPerTask);
});

test("a task update emits a progress event the orchestrator can wait for", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const { taskId, runId } = await taskWithRunningAttempt(store, hub.call, "update-event", "update-event-1");
  const context = await hub.call("get_task_context", rootRunId, {}) as TaskContextResult;
  await hub.call("update_task", runId, { idempotencyKey: "update-observed", progress: "Half done" });
  const page = await hub.call("wait_for_task_events", rootRunId, { cursor: context.mailbox.cursor, timeoutMilliseconds: 0 }) as {
    events: Array<{ type: string; taskId?: string; changes?: string[] }>;
  };
  const progressEvent = page.events.find((event) => event.type === "task" && event.changes?.includes("progress"));
  assert.equal(progressEvent?.taskId, taskId);
  assert.deepEqual(progressEvent?.changes, ["progress"]);
});

test("delegate_task creates one pinned task without a run and replays", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const argumentsValue = { agentId: "worker-b", task: "Review the change", idempotencyKey: "delegate-review" };
  const first = await hub.call("delegate_task", rootRunId, argumentsValue) as { taskId: string; status: string; agentId: string; created: boolean };
  assert.deepEqual(outputViolations("delegate_task", first), []);
  assert.equal(first.created, true);
  assert.equal(first.agentId, "worker-b");
  const tasks = store.read((state) => state.tasks!);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, first.taskId);
  assert.equal(tasks[0].sourceRunId, rootRunId);
  assert.deepEqual(tasks[0].placementOverride, { agentId: "worker-b", authorizedBy: "policy" });
  assert.equal(store.snapshot().runs.length, 2, "delegation never creates a run itself");

  const replay = await hub.call("delegate_task", rootRunId, argumentsValue) as { taskId: string; created: boolean };
  assert.equal(replay.created, false);
  assert.equal(replay.taskId, first.taskId);
  assert.equal(store.read((state) => state.tasks!.length), 1);
});

test("delegate_task is authorized like delegation and checks artifact provenance", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const taskId = await submitSingleTask(hub.call, rootRunId, "delegating", "delegate-auth-1");
  const workerRunId = await startAttempt(store, taskId, "worker-b");
  await assert.rejects(hub.call("delegate_task", workerRunId, {
    agentId: "worker-a", task: "Sub-delegate", idempotencyKey: "delegate-forbidden"
  }), isCode("forbidden"));

  const uploadedArtifactId = await seedArtifact(store, "artifact-delegate");
  const foreignArtifactId = await seedArtifact(store, "artifact-delegate-foreign", { threadId: "thread-two", runId: "run-foreign", agentId: "foreign-owner" });
  const draftArtifactId = await seedArtifact(store, "artifact-delegate-draft", { uploaded: false });
  const attached = await hub.call("delegate_task", rootRunId, {
    agentId: "worker-a", task: "Review with attachment", idempotencyKey: "delegate-artifact", artifactIds: [uploadedArtifactId]
  }) as { taskId: string };
  assert.ok(attached.taskId);
  for (const artifactId of [foreignArtifactId, draftArtifactId, "artifact_missing"]) {
    await assert.rejects(hub.call("delegate_task", rootRunId, {
      agentId: "worker-a", task: "Review with attachment", idempotencyKey: `delegate-bad-${artifactId}`, artifactIds: [artifactId]
    }), isCode("invalid_artifact"));
  }
  assert.equal(store.read((state) => state.tasks!.length), 2);
});

test("a run cannot delegate more than four tasks", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  for (let index = 0; index < 4; index += 1) {
    await hub.call("delegate_task", rootRunId, { agentId: "worker-b", task: `Review ${index}`, idempotencyKey: `delegate-fanout-${index}` });
  }
  await assert.rejects(hub.call("delegate_task", rootRunId, {
    agentId: "worker-b", task: "One too many", idempotencyKey: "delegate-fanout-overflow"
  }), isCode("fanout_limit"));
  assert.equal(store.read((state) => state.tasks!.length), 4);
});

test("a delegated task's attempt completes through the run lifecycle", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const delegated = await hub.call("delegate_task", rootRunId, {
    agentId: "worker-b", task: "Review the change", idempotencyKey: "delegate-lifecycle"
  }) as { taskId: string };
  const workerRunId = await startAttempt(store, delegated.taskId, "worker-b");
  await store.transact((state) => {
    const run = state.runs.find((item) => item.id === workerRunId)!;
    run.status = "completed";
    run.output = "Reviewed";
    run.finishedAt = fixtureTime;
    applyAttemptOutcome(state, workerRunId, fixtureTime);
  });
  assert.equal(storedTask(store, delegated.taskId).status, "completed");
  const context = await hub.call("get_task_context", rootRunId, {}) as TaskContextResult;
  assert.ok(context.taskGraph.some((task) => task.id === delegated.taskId));
});

test("execution inventory reports live offerings, this thread's residents, and both capacity dimensions", async () => {
  const store = await orchestrationStore();
  await store.transact((state) => {
    const node = state.nodes.find((item) => item.id === "node-worker-a")!;
    node.instanceCapacity = 3;
    node.activeInstances = 0;
    node.harnesses = [{
      id: "claude-cli", label: "Claude", description: "", available: true,
      authMode: "local-subscription", models: ["fable"], transports: ["native-cli", "acp-v1"]
    }];
    state.instances = [
      {
        id: "instance-mine", threadId: "thread-one", creator: { kind: "operator", operatorId: "operator" },
        purpose: { name: "Reviewer", instructions: "PRIVATE-INSTRUCTIONS" }, delegation: { canDelegate: false },
        requirements: {}, lease: { idleTimeoutSeconds: 1800, expiresAt: fixtureTime }, status: "ready",
        createdAt: fixtureTime, updatedAt: fixtureTime
      },
      {
        id: "instance-foreign", threadId: "thread-two", creator: { kind: "operator", operatorId: "operator" },
        delegation: { canDelegate: false }, requirements: {},
        lease: { idleTimeoutSeconds: 1800, expiresAt: fixtureTime }, status: "ready",
        createdAt: fixtureTime, updatedAt: fixtureTime
      }
    ];
    state.allocations = [{
      id: "allocation-mine", instanceId: "instance-mine", nodeId: "node-worker-a", harnessId: "claude-cli",
      model: "fable", transport: "native-cli", workspace: "/workspace/worker-a",
      lease: { idleTimeoutSeconds: 1800, expiresAt: fixtureTime }, status: "active",
      createdAt: fixtureTime, updatedAt: fixtureTime
    }];
    return true;
  });
  const hub = fixtureHandler(store, { connections: { "node-worker-a": { protocolVersion: "5", synced: true } } });
  const inventory = await hub.call("get_execution_inventory", rootRunId, {}) as InventoryResult;
  assert.deepEqual(outputViolations("get_execution_inventory", inventory), []);

  // Offerings are the candidate set: one per available harness, advertised model, and transport.
  assert.deepEqual(inventory.offerings, [
    { nodeId: "node-worker-a", harnessId: "claude-cli", model: "fable", transport: "acp-v1", fallbackTransport: "native-cli" },
    { nodeId: "node-worker-a", harnessId: "claude-cli", model: "fable", transport: "native-cli" }
  ]);

  // Instances are thread-scoped, and their private instructions never travel.
  assert.deepEqual(inventory.instances.map((instance) => instance.id), ["instance-mine"]);
  assert.deepEqual(
    [inventory.instances[0].nodeId, inventory.instances[0].model, inventory.instances[0].allocationStatus],
    ["node-worker-a", "fable", "active"]
  );
  assert.equal(JSON.stringify(inventory).includes("PRIVATE-INSTRUCTIONS"), false);

  const capable = inventory.nodes.find((node) => node.id === "node-worker-a")!;
  assert.deepEqual([capable.concurrency, capable.slotsInUse, capable.instanceCapacity, capable.residentSlotsInUse, capable.offersInstances], [2, 0, 3, 1, true]);
  const incapable = inventory.nodes.find((node) => node.id === "node-worker-b")!;
  assert.deepEqual([incapable.instanceCapacity, incapable.residentSlotsInUse, incapable.offersInstances], [0, 0, false]);
  assert.deepEqual(inventory.truncated, { agents: false, nodes: false, instances: false, offerings: false });
});
