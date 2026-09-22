import assert from "node:assert/strict";
import test from "node:test";
import { CoordinationError } from "./coordination.js";
import {
  fixtureHandler,
  foreignRunId,
  listedToolNames,
  orchestrationStore,
  outputViolations,
  rootRunId,
  startAttempt
} from "./hubToolsTestSupport.js";

const isCode = (code: string) => (error: unknown) => error instanceof CoordinationError && error.code === code;

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
