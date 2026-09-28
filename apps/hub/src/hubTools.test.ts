import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { CoordinationError } from "./coordination.js";
import {
  fixtureHandler,
  fixtureTime,
  foreignRunId,
  listedToolNames,
  orchestrationStore,
  outputViolations,
  rootRunId,
  startAttempt
} from "./hubToolsTestSupport.js";

const isCode = (code: string) => (error: unknown) => error instanceof CoordinationError && error.code === code;

async function seedInstanceCaller(store: Awaited<ReturnType<typeof orchestrationStore>>, canDelegate = true) {
  await store.transact((state) => {
    state.instances = [{
      id: "instance-caller", threadId: "thread-one", creator: { kind: "operator", operatorId: "operator" },
      purpose: { name: "Coordinator", instructions: "PRIVATE CALLER INSTRUCTIONS" },
      delegation: { canDelegate }, requirements: {},
      lease: { idleTimeoutSeconds: 1800, expiresAt: "2026-09-30T12:00:00.000Z" },
      status: "ready", createdAt: fixtureTime, updatedAt: fixtureTime
    }];
    state.allocations = [{
      id: "allocation-caller", instanceId: "instance-caller", nodeId: "node-orchestrator",
      harnessId: "codex-cli", model: "default", transport: "native-cli", workspace: "/workspace/private-caller",
      lease: { idleTimeoutSeconds: 1800, expiresAt: "2026-09-30T12:00:00.000Z" },
      status: "active", createdAt: fixtureTime, updatedAt: fixtureTime
    }];
    state.runs.push({
      id: "run-instance-caller", threadId: "thread-one", instanceId: "instance-caller", allocationId: "allocation-caller",
      nodeId: "node-orchestrator", harnessId: "codex-cli", model: "default", transport: "native-cli",
      workspace: "/workspace/private-caller", prompt: "Coordinate", status: "running", output: "", depth: 0,
      createdAt: fixtureTime, startedAt: fixtureTime
    });
  });
  return "run-instance-caller";
}

const parallelBatch = {
  idempotencyKey: "plan-1",
  tasks: [
    { key: "backend", title: "Backend", instructions: "Build the API", requirements: { skills: ["go"] } },
    { key: "frontend", title: "Frontend", instructions: "Build the UI", requirements: { skills: ["typescript"] } },
    { key: "verify", title: "Verify", instructions: "Test both", dependencies: [{ key: "backend" }, { key: "frontend" }] }
  ]
};

test("an orchestrator submits two parallel tasks and a dependent task in one call", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const inventory = await hub.call("get_execution_inventory", rootRunId, {});
  assert.deepEqual(outputViolations("get_execution_inventory", inventory), []);

  const submitted = await hub.call("submit_tasks", rootRunId, parallelBatch) as { created: boolean; taskIdsByKey: Record<string, string>; tasks: Array<{ id: string; status: string }> };
  assert.deepEqual(outputViolations("submit_tasks", submitted), []);
  assert.equal(submitted.created, true);
  assert.deepEqual(submitted.tasks.map((task) => task.status), ["ready", "ready", "pending"]);
  assert.equal(hub.schedulingRequests, 1);
  assert.equal(store.snapshot().runs.length, 2, "submission never dispatches or creates attempts itself");

  const replay = await hub.call("submit_tasks", rootRunId, parallelBatch) as typeof submitted;
  assert.equal(replay.created, false);
  assert.deepEqual(replay.taskIdsByKey, submitted.taskIdsByKey);
  assert.equal(hub.schedulingRequests, 1);
  await assert.rejects(hub.call("submit_tasks", rootRunId, { ...parallelBatch, tasks: parallelBatch.tasks.slice(0, 2) }), isCode("idempotency_conflict"));
  assert.equal(store.snapshot().tasks?.length, 3);
});

test("submission success does not depend on scheduling", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store, { schedule: () => new Promise(() => undefined) });
  const submitted = await hub.call("submit_tasks", rootRunId, parallelBatch) as { created: boolean };
  assert.equal(submitted.created, true);
});

test("a live delegating instance run owns idempotent lifecycle mutations and receives only safe projections", async () => {
  const store = await orchestrationStore();
  const sourceRunId = await seedInstanceCaller(store);
  const hub = fixtureHandler(store, { now: () => fixtureTime });
  const self = await hub.call("get_instance", sourceRunId, { instanceId: "instance-caller" }) as {
    instance: { creator?: unknown; purpose?: Record<string, unknown> };
    allocation?: { workspace?: string; id: string };
  };
  assert.equal(self.instance.creator, undefined);
  assert.equal(self.instance.purpose?.instructions, undefined);
  assert.deepEqual(self.allocation, {
    id: "allocation-caller", instanceId: "instance-caller", nodeId: "node-orchestrator",
    harnessId: "codex-cli", model: "default", transport: "native-cli",
    lease: { idleTimeoutSeconds: 1800, expiresAt: "2026-09-30T12:00:00.000Z" },
    status: "active", createdAt: fixtureTime, updatedAt: fixtureTime
  });
  assert.deepEqual(outputViolations("get_instance", self), []);
  const spawn = {
    idempotencyKey: "spawn-reviewer",
    purpose: { name: "Reviewer", title: "Review resident", summary: "Review changes", instructions: "PRIVATE TARGET INSTRUCTIONS" },
    requirements: { templateId: "template-reviewer", preferences: { models: ["default"] } },
    idleTimeoutSeconds: 3600,
    initialTask: { title: "Initial review", instructions: "Review the patch" }
  };

  const created = await hub.call("spawn_instance", sourceRunId, spawn) as {
    instance: { id: string; creator?: unknown; purpose?: Record<string, unknown>; delegation: { canDelegate: boolean }; status: string };
    allocation?: { workspace?: string };
    initialTaskId?: string;
    replayed: boolean;
  };
  assert.equal(created.replayed, false);
  assert.equal(created.instance.status, "requested");
  assert.deepEqual(created.instance.delegation, { canDelegate: false });
  assert.ok(created.initialTaskId);
  assert.equal(created.instance.creator, undefined);
  assert.equal(created.instance.purpose?.instructions, undefined);
  assert.equal(created.allocation?.workspace, undefined);
  assert.deepEqual(outputViolations("spawn_instance", created), []);
  assert.deepEqual([hub.broadcasts, hub.schedulingRequests], [1, 1]);

  const stateAfterCreate = store.read((state) => JSON.stringify([
    state.instances, state.allocations, state.tasks, state.instanceLifecycleReceipts, state.events
  ]));
  const replay = await hub.call("spawn_instance", sourceRunId, spawn) as typeof created;
  assert.deepEqual([replay.instance.id, replay.initialTaskId, replay.replayed], [created.instance.id, created.initialTaskId, true]);
  assert.deepEqual([hub.broadcasts, hub.schedulingRequests], [1, 1], "a replay is not rebroadcast as new work");
  assert.equal(store.read((state) => JSON.stringify([
    state.instances, state.allocations, state.tasks, state.instanceLifecycleReceipts, state.events
  ])), stateAfterCreate);
  await assert.rejects(hub.call("spawn_instance", sourceRunId, { ...spawn, requirements: {} }), isCode("idempotency_conflict"));

  const receiptsBeforeGet = store.read((state) => state.instanceLifecycleReceipts?.length ?? 0);
  const read = await hub.call("get_instance", sourceRunId, { instanceId: created.instance.id }) as Record<string, unknown>;
  assert.deepEqual(outputViolations("get_instance", read), []);
  assert.equal(Object.hasOwn(read, "replayed"), false);
  assert.equal(store.read((state) => state.instanceLifecycleReceipts?.length ?? 0), receiptsBeforeGet);

  const renewed = await hub.call("renew_instance", sourceRunId, {
    instanceId: created.instance.id, idempotencyKey: "renew-reviewer", idleTimeoutSeconds: 7200
  }) as { instance: { lease: { idleTimeoutSeconds: number } }; replayed: boolean };
  assert.deepEqual([renewed.instance.lease.idleTimeoutSeconds, renewed.replayed], [7200, false]);
  assert.deepEqual(outputViolations("renew_instance", renewed), []);
  assert.deepEqual([hub.broadcasts, hub.schedulingRequests], [2, 1]);

  const released = await hub.call("release_instance", sourceRunId, {
    instanceId: created.instance.id, idempotencyKey: "release-reviewer", mode: "drain"
  }) as { instance: { status: string }; replayed: boolean };
  assert.deepEqual([released.instance.status, released.replayed], ["released", false]);
  assert.deepEqual(outputViolations("release_instance", released), []);
  assert.deepEqual([hub.broadcasts, hub.schedulingRequests], [3, 2]);
  const terminal = await hub.call("get_instance", sourceRunId, { instanceId: created.instance.id }) as { instance: { status: string } };
  assert.equal(terminal.instance.status, "released", "terminal same-thread instances remain queryable");

  const releaseReplay = await hub.call("release_instance", sourceRunId, {
    instanceId: created.instance.id, idempotencyKey: "release-reviewer", mode: "drain"
  }) as { replayed: boolean };
  assert.equal(releaseReplay.replayed, true);
  assert.deepEqual([hub.broadcasts, hub.schedulingRequests], [3, 2]);
});

test("lifecycle tools reject legacy, nondelegating, authority-bearing, malformed, and foreign calls without writes", async () => {
  const store = await orchestrationStore();
  const sourceRunId = await seedInstanceCaller(store, false);
  const hub = fixtureHandler(store);
  const before = store.read((state) => JSON.stringify([
    state.instances, state.allocations, state.tasks, state.instanceLifecycleReceipts, state.events
  ]));

  await assert.rejects(hub.call("spawn_instance", rootRunId, {
    idempotencyKey: "legacy", requirements: {}
  }), isCode("forbidden"), "a delegating configured-agent run is not a live instance principal");
  await assert.rejects(hub.call("spawn_instance", sourceRunId, {
    idempotencyKey: "nondelegating", requirements: {}
  }), isCode("forbidden"));
  assert.equal(store.read((state) => JSON.stringify([
    state.instances, state.allocations, state.tasks, state.instanceLifecycleReceipts, state.events
  ])), before);

  await store.transact((state) => {
    state.instances!.find((item) => item.id === "instance-caller")!.delegation.canDelegate = true;
    state.instances!.push({
      id: "instance-foreign", threadId: "thread-two", creator: { kind: "operator", operatorId: "operator" },
      delegation: { canDelegate: false }, requirements: {},
      lease: { idleTimeoutSeconds: 1800, expiresAt: "2026-09-30T12:00:00.000Z" }, status: "ready",
      createdAt: fixtureTime, updatedAt: fixtureTime
    });
  });
  const missing = await hub.call("get_instance", sourceRunId, { instanceId: "instance-missing" }).catch((error: unknown) => error);
  const foreign = await hub.call("get_instance", sourceRunId, { instanceId: "instance-foreign" }).catch((error: unknown) => error);
  assert.ok(missing instanceof CoordinationError && foreign instanceof CoordinationError);
  assert.deepEqual([foreign.code, foreign.message], [missing.code, missing.message]);

  for (const invalid of [
    { idempotencyKey: "authority", requirements: {}, creator: { kind: "operator", operatorId: "operator" } },
    { idempotencyKey: "delegation", requirements: {}, canDelegate: true },
    { idempotencyKey: "policy", requirements: {}, policy: { canDelegate: true } },
    { idempotencyKey: "task-extra", requirements: {}, initialTask: { title: "Task", instructions: "Do it", taskId: "chosen" } },
    { idempotencyKey: "timeout", requirements: {}, idleTimeoutSeconds: 59 }
  ]) await assert.rejects(hub.call("spawn_instance", sourceRunId, invalid), isCode("invalid_arguments"));
  assert.equal(store.read((state) => state.instanceLifecycleReceipts?.length ?? 0), 0);
});

test("a worker question wakes a waiting orchestrator and the answer wakes the worker", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const submitted = await hub.call("submit_tasks", rootRunId, parallelBatch) as { taskIdsByKey: Record<string, string> };
  const backendId = submitted.taskIdsByKey.backend;
  const workerRunId = await startAttempt(store, backendId, "worker-a");

  const initial = await hub.call("get_task_context", rootRunId, {}) as { mailbox: { cursor: string } };
  assert.deepEqual(outputViolations("get_task_context", initial), []);
  const waiting = hub.call("wait_for_task_events", rootRunId, { cursor: initial.mailbox.cursor, timeoutMilliseconds: 5_000 });
  const question = await hub.call("send_task_message", workerRunId, {
    idempotencyKey: "question-1", recipient: { type: "orchestrator" }, kind: "question", body: "Which port?"
  }) as { messageId: string; sequence: number };
  assert.deepEqual(outputViolations("send_task_message", question), []);
  assert.equal(question.sequence, 1);

  const woke = await waiting as { events: Array<{ type: string; message?: { id: string; sender: unknown } }>; cursor: string; timedOut: boolean };
  assert.deepEqual(outputViolations("wait_for_task_events", woke), []);
  assert.equal(woke.timedOut, false);
  const delivered = woke.events.find((event) => event.type === "message");
  assert.equal(delivered?.message?.id, question.messageId);
  assert.deepEqual(delivered?.message?.sender, { type: "task", taskId: backendId });

  await hub.call("send_task_message", rootRunId, {
    idempotencyKey: "answer-1", recipient: { type: "task", taskId: backendId }, kind: "answer", body: "8080", inReplyToMessageId: question.messageId
  });
  const answered = await hub.call("wait_for_task_events", workerRunId, { timeoutMilliseconds: 0 }) as { events: Array<{ type: string; message?: { body: string } }> };
  assert.equal(answered.events.find((event) => event.type === "message")?.message?.body, "8080");

  const quiet = await hub.call("wait_for_task_events", rootRunId, { cursor: woke.cursor, timeoutMilliseconds: 20, acknowledgeMessageIds: [question.messageId] }) as { events: unknown[]; timedOut: boolean };
  assert.equal(quiet.timedOut, true);
  assert.deepEqual(quiet.events, []);
  assert.equal(store.snapshot().taskMessageAcknowledgements?.length, 1);
  assert.equal(hub.waiters.size, 0);
});

test("tasks in another thread are invisible and indistinguishable from missing ones", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const submitted = await hub.call("submit_tasks", rootRunId, parallelBatch) as { taskIdsByKey: Record<string, string> };
  const missing = await hub.call("get_task_context", foreignRunId, { taskId: "task_missing" }).catch((error: unknown) => error);
  const foreign = await hub.call("get_task_context", foreignRunId, { taskId: submitted.taskIdsByKey.backend }).catch((error: unknown) => error);
  assert.ok(missing instanceof CoordinationError && foreign instanceof CoordinationError);
  assert.deepEqual([foreign.code, foreign.message], [missing.code, missing.message]);
  await assert.rejects(hub.call("send_task_message", foreignRunId, {
    idempotencyKey: "cross", recipient: { type: "task", taskId: submitted.taskIdsByKey.backend }, kind: "note", body: "hello"
  }), isCode("not_found"));
});

test("revoked, unknown, and terminal sources fail closed", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  await assert.rejects(hub.call("unknown_tool", rootRunId, {}), isCode("unknown_tool"));
  await store.transact((state) => { state.runs.find((run) => run.id === rootRunId)!.status = "completed"; });
  for (const name of listedToolNames()) {
    await assert.rejects(hub.call(name, rootRunId, name === "get_execution_inventory" ? {} : { idempotencyKey: "any" }), (error: unknown) => error instanceof CoordinationError, name);
  }
  assert.equal(store.snapshot().tasks?.length, 0);
});

test("preview publication delegates to the dedicated authority and broadcasts only creation", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const request = {
    relativePath: "site",
    title: "Site preview",
    kind: "preview-bundle",
    mediaType: "application/vnd.coffee-shop.preview-bundle+tar+gzip",
    summary: "Static site",
    size: 512,
    sha256: "a".repeat(64),
    entrypoint: "index.html",
    ttlSeconds: 300,
    idempotencyKey: "preview-site-1"
  };

  const created = await hub.call("publish_preview", rootRunId, request) as {
    artifact: { id: string; uploaded: boolean };
    preview: { id: string; artifactId: string; status: string; accessState: string };
    uploadPath: string;
    created: boolean;
  };
  assert.equal(created.created, true);
  assert.equal(created.artifact.uploaded, false);
  assert.equal(created.preview.artifactId, created.artifact.id);
  assert.equal(created.preview.status, "upload-pending");
  assert.equal(created.preview.accessState, "unavailable");
  assert.equal(created.uploadPath, `/api/artifacts/${created.artifact.id}/content`);
  assert.deepEqual(outputViolations("publish_preview", created), []);
  assert.equal(hub.broadcasts, 1);

  const replayed = await hub.call("publish_preview", rootRunId, request) as typeof created;
  assert.equal(replayed.created, false);
  assert.equal(replayed.artifact.id, created.artifact.id);
  assert.equal(replayed.preview.id, created.preview.id);
  assert.equal(hub.broadcasts, 1, "an exact registration replay is a no-write response");
});

test("publish_preview fixtures are byte-faithful outputs from the Hub registration producer", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store, { now: () => fixtureTimeForProducer });
  const request = {
    relativePath: "site", title: "Site preview", kind: "preview-bundle",
    mediaType: "application/vnd.coffee-shop.preview-bundle+tar+gzip", summary: "Static site",
    size: 512, sha256: "a".repeat(64), entrypoint: "index.html", ttlSeconds: 300,
    idempotencyKey: "preview-site-1"
  };
  const originalNow = Date.now;
  const originalRandom = Math.random;
  Date.now = () => Date.parse(fixtureTimeForProducer);
  Math.random = () => 0.123456789;
  try {
    const created = await hub.call("publish_preview", rootRunId, request);
    const createdBytes = `${JSON.stringify(created, null, 2)}\n`;
    const createdURL = new URL("../../../packages/protocol/test/fixtures/hub-tools/publish-preview-created.json", import.meta.url);
    if (process.env.UPDATE_PUBLISH_PREVIEW_FIXTURES === "1") writeFileSync(createdURL, createdBytes);
    assert.equal(readFileSync(createdURL, "utf8"), createdBytes);

    await store.transact((state) => {
      const artifact = state.artifacts?.find((item) => item.id === (created as { artifact: { id: string } }).artifact.id);
      assert.ok(artifact);
      artifact.uploaded = true;
    });
    const replayed = await hub.call("publish_preview", rootRunId, request);
    const replayedBytes = `${JSON.stringify(replayed, null, 2)}\n`;
    const replayedURL = new URL("../../../packages/protocol/test/fixtures/hub-tools/publish-preview-replayed.json", import.meta.url);
    if (process.env.UPDATE_PUBLISH_PREVIEW_FIXTURES === "1") writeFileSync(replayedURL, replayedBytes);
    assert.equal(readFileSync(replayedURL, "utf8"), replayedBytes);
  } finally {
    Date.now = originalNow;
    Math.random = originalRandom;
  }
});

const fixtureTimeForProducer = "2026-09-27T12:00:00.000Z";

test("legacy delegation to a statically ineligible target fails without writing anything", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  await store.transact((state) => {
    state.agents.find((agent) => agent.id === "worker-b")!.model = "unadvertised-model";
    state.agents.find((agent) => agent.id === "worker-c")!.harnessId = "claude-cli";
    state.agents.push({ ...state.agents.find((agent) => agent.id === "worker-a")!, id: "worker-outside", workspace: "/elsewhere/worker" });
  });
  const before = store.read((state) => JSON.stringify([state.tasks, state.runs, state.taskSubmissions]));
  for (const agentId of ["worker-b", "worker-c", "worker-outside", "orchestrator", "missing-agent"]) {
    const failure = await hub.call("delegate_task", rootRunId, { agentId, task: "Review", idempotencyKey: `review-${agentId}` }).catch((error: unknown) => error);
    assert.ok(failure instanceof CoordinationError, agentId);
    assert.deepEqual([failure.code, failure.retryable], ["target_ineligible", false], agentId);
  }
  assert.equal(store.read((state) => JSON.stringify([state.tasks, state.runs, state.taskSubmissions])), before);
});

test("legacy delegation to an offline or busy target still queues a pinned task", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  await store.transact((state) => {
    const node = state.nodes.find((item) => item.id === "node-worker-a")!;
    node.status = "offline";
    node.activeRuns = node.concurrency;
  });
  const delegated = await hub.call("delegate_task", rootRunId, { agentId: "worker-a", task: "Review", idempotencyKey: "review-offline" }) as { taskId: string; status: string; created: boolean };
  assert.deepEqual(outputViolations("delegate_task", delegated), []);
  assert.equal(delegated.created, true);
  assert.equal(delegated.status, "ready");
  assert.deepEqual(store.snapshot().tasks?.find((task) => task.id === delegated.taskId)?.placementOverride, { agentId: "worker-a", authorizedBy: "policy" });
  assert.equal(store.snapshot().runs.length, 2);

  await store.transact((state) => { state.agents.find((agent) => agent.id === "worker-a")!.model = "unadvertised-model"; });
  const replay = await hub.call("delegate_task", rootRunId, { agentId: "worker-a", task: "Review", idempotencyKey: "review-offline" }) as { taskId: string; created: boolean };
  assert.deepEqual([replay.taskId, replay.created], [delegated.taskId, false], "an exact replay returns the original task even after the target changed");
});
