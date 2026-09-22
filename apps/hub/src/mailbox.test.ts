import assert from "node:assert/strict";
import test from "node:test";
import { orchestrationToolLimits, type Artifact, type TaskMessage, type TaskMessageParticipant } from "@coffee-shop/protocol";
import { CoordinationError } from "./coordination.js";
import {
  fixtureHandler,
  fixtureRun,
  fixtureTime,
  foreignRunId,
  inputViolations,
  orchestrationStore,
  outputViolations,
  rootRunId,
  startAttempt
} from "./hubToolsTestSupport.js";
import { encodeTaskEventCursor } from "./mailbox.js";
import type { Store } from "./store.js";
import { applyAttemptOutcome } from "./tasks.js";
import { taskEventStream, type TaskEventEntry } from "./taskEvents.js";

type HubCall = ReturnType<typeof fixtureHandler>["call"];

type TaskEntry = Extract<TaskEventEntry, { kind: "task" }>;

interface WaitResult {
  events: Array<{ type: string; sequence: number; taskId?: string; changes?: string[]; message?: { id: string; body: string; acknowledged: boolean } }>;
  cursor: string;
  hasMore: boolean;
  timedOut: boolean;
}

interface ContextResult {
  mailbox: { participant?: { type: string; taskId?: string }; cursor: string; messageCount: number; unacknowledgedCount: number; latestSequence: number };
  caller: { runId: string; taskId?: string; role: string };
}

const isCode = (code: string) => (error: unknown): error is CoordinationError =>
  error instanceof CoordinationError && error.code === code;

async function coordinationError(promise: Promise<unknown>): Promise<CoordinationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CoordinationError) return error;
    throw error;
  }
  return assert.fail("expected the call to fail with a coordination error");
}

async function submitSingleTask(call: HubCall, sourceRunId: string, key: string, idempotencyKey: string): Promise<string> {
  const submitted = await call("submit_tasks", sourceRunId, {
    idempotencyKey, tasks: [{ key, title: key, instructions: `Work for ${key}` }]
  }) as { taskIdsByKey: Record<string, string> };
  return submitted.taskIdsByKey[key];
}

const messageToTask = (idempotencyKey: string, taskId: string, body: string) => ({
  idempotencyKey, recipient: { type: "task" as const, taskId }, kind: "note" as const, body
});

const messageToOrchestrator = (idempotencyKey: string, body: string) => ({
  idempotencyKey, recipient: { type: "orchestrator" as const }, kind: "note" as const, body
});

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

async function seedMessages(store: Store, threadId: string, count: number, sender: TaskMessageParticipant, recipient: TaskMessageParticipant) {
  await store.transact((state) => {
    state.taskMessages ??= [];
    for (let index = 0; index < count; index += 1) {
      const message: TaskMessage = {
        id: `taskmsg-seed-${index}`, threadId, sender: { ...sender }, recipient: { ...recipient },
        sequence: index + 1, kind: "note", body: "Seeded", idempotencyKey: `seed-${index}`, createdAt: fixtureTime
      };
      state.taskMessages.push(message);
    }
  });
}

const messageCount = (store: Store) => store.read((state) => state.taskMessages?.length ?? 0);

const journalEntries = (store: Store, threadId: string) =>
  store.read((state) => (state.taskEventJournal ?? []).filter((entry) => entry.threadId === threadId));

const journalTaskEntries = (store: Store, threadId: string) =>
  journalEntries(store, threadId).filter((entry): entry is TaskEntry => entry.kind === "task");

async function currentCursor(call: HubCall, sourceRunId: string) {
  const context = await call("get_task_context", sourceRunId, {}) as ContextResult;
  return context.mailbox.cursor;
}

test("the caller is derived from the source run alone and inactive or unattached runs have no mailbox", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  await store.transact((state) => {
    state.runs.push(fixtureRun("run-orphan", "thread-one", "worker-c"));
  });
  await assert.rejects(hub.call("send_task_message", "run-orphan", messageToOrchestrator("identity-1", "Hello")), isCode("forbidden"));
  const orphanContext = await hub.call("get_task_context", "run-orphan", {}) as ContextResult;
  assert.equal(orphanContext.caller.role, "run");
  assert.equal(orphanContext.mailbox.participant, undefined);

  await store.transact((state) => {
    state.runs.find((run) => run.id === rootRunId)!.status = "completed";
  });
  await assert.rejects(hub.call("send_task_message", rootRunId, messageToOrchestrator("identity-2", "Hello")), isCode("run_not_active"));
  await assert.rejects(hub.call("wait_for_task_events", rootRunId, { timeoutMilliseconds: 0 }), isCode("run_not_active"));
  await assert.rejects(hub.call("get_task_context", rootRunId, {}), isCode("run_not_active"));
});

test("an orchestrator reads and messages every task in its thread with independent sequences", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const submitted = await hub.call("submit_tasks", rootRunId, {
    idempotencyKey: "orchestrator-scope",
    tasks: [
      { key: "left", title: "Left", instructions: "Left work" },
      { key: "right", title: "Right", instructions: "Right work" }
    ]
  }) as { taskIdsByKey: Record<string, string> };
  const leftId = submitted.taskIdsByKey.left;
  const rightId = submitted.taskIdsByKey.right;
  for (const taskId of [leftId, rightId]) {
    const focused = await hub.call("get_task_context", rootRunId, { taskId }) as { durableTask?: { id: string } };
    assert.equal(focused.durableTask?.id, taskId);
  }
  const toLeft = await hub.call("send_task_message", rootRunId, messageToTask("scope-left", leftId, "first")) as { sequence: number };
  const toRight = await hub.call("send_task_message", rootRunId, messageToTask("scope-right", rightId, "second")) as { sequence: number };
  const toLeftAgain = await hub.call("send_task_message", rootRunId, messageToTask("scope-left-2", leftId, "third")) as { sequence: number };
  assert.equal(toLeft.sequence, 1);
  assert.equal(toRight.sequence, 1);
  assert.equal(toLeftAgain.sequence, 2);
});

test("a task participant sees its lineage and messages only ancestors, descendants, and the orchestrator", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const rootBatch = await hub.call("submit_tasks", rootRunId, {
    idempotencyKey: "lineage-root",
    tasks: [
      { key: "parent", title: "Parent", instructions: "Parent work" },
      { key: "sibling", title: "Sibling", instructions: "Sibling work" }
    ]
  }) as { taskIdsByKey: Record<string, string> };
  const parentId = rootBatch.taskIdsByKey.parent;
  const siblingId = rootBatch.taskIdsByKey.sibling;
  const parentRunId = await startAttempt(store, parentId, "worker-a");
  const childBatch = await hub.call("submit_tasks", parentRunId, {
    idempotencyKey: "lineage-child", tasks: [{ key: "child", title: "Child", instructions: "Child work" }]
  }) as { taskIdsByKey: Record<string, string> };
  const childId = childBatch.taskIdsByKey.child;
  const childRunId = await startAttempt(store, childId, "worker-c");

  for (const taskId of [parentId, childId]) {
    const focused = await hub.call("get_task_context", parentRunId, { taskId }) as { durableTask?: { id: string } };
    assert.equal(focused.durableTask?.id, taskId, taskId);
  }
  const siblingRead = await coordinationError(hub.call("get_task_context", parentRunId, { taskId: siblingId }));
  const missingRead = await coordinationError(hub.call("get_task_context", parentRunId, { taskId: "task_missing" }));
  assert.deepEqual([siblingRead.code, siblingRead.message], [missingRead.code, missingRead.message]);
  assert.equal(siblingRead.code, "not_found");

  const parentContext = await hub.call("get_task_context", parentRunId, {}) as ContextResult;
  assert.equal(parentContext.caller.taskId, parentId);
  assert.equal(parentContext.caller.role, "task");

  await hub.call("send_task_message", parentRunId, messageToTask("lineage-to-child", childId, "for my descendant"));
  await hub.call("send_task_message", parentRunId, messageToOrchestrator("lineage-to-orchestrator", "a question"));
  await hub.call("send_task_message", childRunId, messageToTask("lineage-to-parent", parentId, "for my ancestor"));

  const selfSend = await coordinationError(hub.call("send_task_message", parentRunId, messageToTask("lineage-to-self", parentId, "for myself")));
  assert.equal(selfSend.code, "invalid_target");
  const siblingSend = await coordinationError(hub.call("send_task_message", parentRunId, messageToTask("lineage-to-sibling", siblingId, "for a sibling")));
  const missingSend = await coordinationError(hub.call("send_task_message", parentRunId, messageToTask("lineage-to-missing", "task_missing", "for nobody")));
  assert.equal(siblingSend.code, "not_found");
  assert.deepEqual([siblingSend.code, siblingSend.message], [missingSend.code, missingSend.message]);
  const siblingFromChild = await coordinationError(hub.call("send_task_message", childRunId, messageToTask("lineage-child-sibling", siblingId, "for a sibling")));
  assert.equal(siblingFromChild.code, "not_found");
});

test("a direct dependency is readable but not messageable", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const submitted = await hub.call("submit_tasks", rootRunId, {
    idempotencyKey: "dependency-scope",
    tasks: [
      { key: "first", title: "First", instructions: "First work" },
      { key: "second", title: "Second", instructions: "Second work", dependencies: [{ key: "first" }] }
    ]
  }) as { taskIdsByKey: Record<string, string> };
  const firstId = submitted.taskIdsByKey.first;
  const secondId = submitted.taskIdsByKey.second;
  const firstRunId = await startAttempt(store, firstId, "worker-a");
  await store.transact((state) => {
    const run = state.runs.find((item) => item.id === firstRunId)!;
    run.status = "completed";
    run.finishedAt = fixtureTime;
    applyAttemptOutcome(state, firstRunId, fixtureTime);
  });
  const secondRunId = await startAttempt(store, secondId, "worker-b");
  const focused = await hub.call("get_task_context", secondRunId, { taskId: firstId }) as { durableTask?: { id: string } };
  assert.equal(focused.durableTask?.id, firstId, "a dependency is readable");
  const dependencySend = await coordinationError(hub.call("send_task_message", secondRunId, messageToTask("dependency-send", firstId, "hello")));
  const missingSend = await coordinationError(hub.call("send_task_message", secondRunId, messageToTask("dependency-missing", "task_missing", "hello")));
  assert.equal(dependencySend.code, "not_found");
  assert.deepEqual([dependencySend.code, dependencySend.message], [missingSend.code, missingSend.message]);
});

test("messaging a task in another thread fails without writing a message", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const taskId = await submitSingleTask(hub.call, rootRunId, "cross-thread", "cross-thread-1");
  await assert.rejects(hub.call("send_task_message", foreignRunId, messageToTask("cross-thread-send", taskId, "hello")), isCode("not_found"));
  await assert.rejects(hub.call("send_task_message", foreignRunId, messageToTask("cross-thread-missing", "task_missing", "hello")), isCode("not_found"));
  assert.equal(messageCount(store), 0);
});

test("malformed message arguments are rejected without writing a message", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const taskId = await submitSingleTask(hub.call, rootRunId, "validated", "validated-1");
  const workerRunId = await startAttempt(store, taskId, "worker-a");
  const valid = messageToOrchestrator("validated-send", "Hello");
  assert.deepEqual(inputViolations("send_task_message", valid), []);
  const invalidArguments: unknown[] = [
    "not an object",
    { ...valid, extra: true },
    { idempotencyKey: "validated-shape", recipient: { type: "orchestrator" }, kind: "note" },
    { ...valid, idempotencyKey: "validated-empty", body: "   " },
    { ...valid, idempotencyKey: "validated-long-body", body: "b".repeat(orchestrationToolLimits.messageBodyLength + 1) },
    { ...valid, idempotencyKey: "validated-long-key".padEnd(orchestrationToolLimits.idempotencyKeyLength + 2, "x") },
    { ...valid, idempotencyKey: "validated-long-correlation", correlationId: "c".repeat(orchestrationToolLimits.correlationIdLength + 1) },
    { ...valid, idempotencyKey: "validated-kind", kind: "chat" },
    { ...valid, idempotencyKey: "validated-recipient-operator", recipient: { type: "operator" } },
    { ...valid, idempotencyKey: "validated-recipient-field", recipient: { type: "task", taskId, extra: true } },
    { ...valid, idempotencyKey: "validated-recipient-task", recipient: { type: "task" } },
    {
      ...valid, idempotencyKey: "validated-artifacts",
      artifactIds: Array.from({ length: orchestrationToolLimits.messageArtifacts + 1 }, (_, index) => `artifact-${index}`)
    }
  ];
  for (const argumentsValue of invalidArguments) {
    await assert.rejects(hub.call("send_task_message", workerRunId, argumentsValue), isCode("invalid_arguments"));
  }
  assert.equal(messageCount(store), 0);
});

test("the sender is always the caller and the result describes the created message", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const taskId = await submitSingleTask(hub.call, rootRunId, "described", "described-1");
  const workerRunId = await startAttempt(store, taskId, "worker-a");
  const sent = await hub.call("send_task_message", workerRunId, {
    idempotencyKey: "described-send", recipient: { type: "orchestrator" }, kind: "question", body: "Which port?"
  }) as { created: boolean; messageId: string; sequence: number; recipient: { type: string }; createdAt: string };
  assert.deepEqual(outputViolations("send_task_message", sent), []);
  assert.equal(sent.created, true);
  assert.equal(sent.sequence, 1);
  assert.deepEqual(sent.recipient, { type: "orchestrator" });
  const stored = store.read((state) => state.taskMessages!.find((message) => message.id === sent.messageId));
  assert.deepEqual(stored?.sender, { type: "task", taskId });
  assert.equal(stored?.sourceRunId, workerRunId);
});

test("an exact replay returns the original message and any difference conflicts", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const leftId = await submitSingleTask(hub.call, rootRunId, "replay-left", "replay-left-1");
  const rightId = await submitSingleTask(hub.call, rootRunId, "replay-right", "replay-right-1");
  await seedArtifact(store, "artifact-replay-one");
  await seedArtifact(store, "artifact-replay-two");
  const original = {
    idempotencyKey: "replay-key", recipient: { type: "task", taskId: leftId }, kind: "note",
    body: "original", artifactIds: ["artifact-replay-one", "artifact-replay-two"]
  };
  const first = await hub.call("send_task_message", rootRunId, original) as { created: boolean; messageId: string };
  assert.equal(first.created, true);
  const replay = await hub.call("send_task_message", rootRunId, {
    ...original, artifactIds: ["artifact-replay-two", "artifact-replay-one"]
  }) as { created: boolean; messageId: string };
  assert.equal(replay.created, false);
  assert.equal(replay.messageId, first.messageId);
  assert.equal(messageCount(store), 1);

  const conflicts: unknown[] = [
    { ...original, body: "different body" },
    { ...original, kind: "instruction" },
    { ...original, recipient: { type: "task", taskId: rightId } },
    { ...original, recipient: { type: "orchestrator" } },
    { ...original, correlationId: "correlation-1" },
    { ...original, inReplyToMessageId: "taskmsg-anything" },
    { ...original, artifactIds: ["artifact-replay-one"] },
    { ...original, artifactIds: [] }
  ];
  for (const argumentsValue of conflicts) {
    await assert.rejects(hub.call("send_task_message", rootRunId, argumentsValue), isCode("idempotency_conflict"));
  }
  assert.equal(messageCount(store), 1);
});

test("sequences are per recipient and concurrent sends never share one", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const taskId = await submitSingleTask(hub.call, rootRunId, "sequenced", "sequenced-1");
  const sent = await Promise.all(Array.from({ length: 10 }, (_, index) =>
    hub.call("send_task_message", rootRunId, messageToTask(`burst-${index}`, taskId, `message ${index}`)) as Promise<{ sequence: number }>));
  const sequences = sent.map((result) => result.sequence).sort((left, right) => left - right);
  assert.deepEqual(sequences, Array.from({ length: 10 }, (_, index) => index + 1));
});

test("a reply must reference a message the caller sent or received in its thread", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const leftId = await submitSingleTask(hub.call, rootRunId, "reply-left", "reply-left-1");
  const rightId = await submitSingleTask(hub.call, rootRunId, "reply-right", "reply-right-1");
  const leftRunId = await startAttempt(store, leftId, "worker-a");
  const rightRunId = await startAttempt(store, rightId, "worker-b");
  const question = await hub.call("send_task_message", leftRunId, {
    idempotencyKey: "reply-question", recipient: { type: "orchestrator" }, kind: "question", body: "Which port?"
  }) as { messageId: string };
  await hub.call("send_task_message", rootRunId, {
    idempotencyKey: "reply-answer", recipient: { type: "task", taskId: leftId }, kind: "answer",
    body: "8080", inReplyToMessageId: question.messageId
  });
  await hub.call("send_task_message", leftRunId, {
    idempotencyKey: "reply-thanks", recipient: { type: "orchestrator" }, kind: "note",
    body: "Thanks", inReplyToMessageId: question.messageId
  });
  const outside = await hub.call("send_task_message", rootRunId, messageToTask("reply-outside", rightId, "unrelated")) as { messageId: string };
  const eavesdrop = await coordinationError(hub.call("send_task_message", leftRunId, {
    idempotencyKey: "reply-eavesdrop", recipient: { type: "orchestrator" }, kind: "note",
    body: "I saw this", inReplyToMessageId: outside.messageId
  }));
  const fabricated = await coordinationError(hub.call("send_task_message", leftRunId, {
    idempotencyKey: "reply-fabricated", recipient: { type: "orchestrator" }, kind: "note",
    body: "I saw this", inReplyToMessageId: "taskmsg_missing"
  }));
  assert.equal(eavesdrop.code, "not_found");
  assert.deepEqual([eavesdrop.code, eavesdrop.message], [fabricated.code, fabricated.message]);
  assert.equal(messageCount(store), 4);
});

test("attached artifacts must be uploaded within the caller's thread, indistinguishably", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const taskId = await submitSingleTask(hub.call, rootRunId, "artifacts", "artifacts-1");
  await seedArtifact(store, "artifact-ready");
  await seedArtifact(store, "artifact-draft", { uploaded: false });
  await seedArtifact(store, "artifact-elsewhere", { threadId: "thread-two", runId: foreignRunId, agentId: "foreign-owner" });
  const sent = await hub.call("send_task_message", rootRunId, {
    ...messageToTask("artifacts-ok", taskId, "with artifacts"), artifactIds: ["artifact-ready"]
  }) as { messageId: string };
  const stored = store.read((state) => state.taskMessages!.find((message) => message.id === sent.messageId));
  assert.deepEqual(stored?.artifactIds, ["artifact-ready"]);
  const rejections: Array<{ id: string; error: CoordinationError }> = [];
  for (const artifactId of ["artifact-draft", "artifact-elsewhere", "artifact_missing"]) {
    const error = await coordinationError(hub.call("send_task_message", rootRunId, {
      ...messageToTask(`artifacts-${artifactId}`, taskId, "with artifacts"), artifactIds: [artifactId]
    }));
    rejections.push({ id: artifactId, error });
  }
  for (const rejection of rejections) {
    assert.deepEqual([rejection.error.code, rejection.error.message], [rejections[0].error.code, rejections[0].error.message], rejection.id);
  }
  assert.equal(rejections[0].error.code, "invalid_artifact");
  assert.equal(messageCount(store), 1);
});

test("sending into an inactive thread is rejected", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const taskId = await submitSingleTask(hub.call, rootRunId, "inactive", "inactive-1");
  await store.transact((state) => {
    state.threads!.find((thread) => thread.id === "thread-one")!.status = "completed";
  });
  await assert.rejects(hub.call("send_task_message", rootRunId, messageToTask("inactive-send", taskId, "hello")), isCode("thread_inactive"));
  assert.equal(messageCount(store), 0);
});

test("the per-sender and per-thread message limits reject with mailbox_full", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const taskId = await submitSingleTask(hub.call, rootRunId, "limited", "limited-1");
  await seedMessages(store, "thread-one", orchestrationToolLimits.messagesPerSender, { type: "orchestrator" }, { type: "task", taskId });
  await assert.rejects(hub.call("send_task_message", rootRunId, messageToTask("limited-sender", taskId, "one too many")), isCode("mailbox_full"));
  assert.equal(messageCount(store), orchestrationToolLimits.messagesPerSender);

  const freshStore = await orchestrationStore();
  const freshHub = fixtureHandler(freshStore);
  const otherTaskId = await submitSingleTask(freshHub.call, rootRunId, "crowded", "crowded-1");
  await seedMessages(freshStore, "thread-one", orchestrationToolLimits.messagesPerThread, { type: "task", taskId: otherTaskId }, { type: "orchestrator" });
  await assert.rejects(freshHub.call("send_task_message", rootRunId, messageToTask("crowded-thread", otherTaskId, "one too many")), isCode("mailbox_full"));
  assert.equal(messageCount(freshStore), orchestrationToolLimits.messagesPerThread);
});

test("wait arguments are bounded and reject unknown fields", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const invalidArguments: unknown[] = [
    { extra: true },
    { timeoutMilliseconds: orchestrationToolLimits.maximumWaitMilliseconds + 1 },
    { timeoutMilliseconds: -1 },
    { timeoutMilliseconds: 1.5 },
    { maximumEvents: 0 },
    { maximumEvents: orchestrationToolLimits.maximumEventsPerWait + 1 },
    { acknowledgeMessageIds: "taskmsg-1" },
    { cursor: 123 }
  ];
  for (const argumentsValue of invalidArguments) {
    await assert.rejects(hub.call("wait_for_task_events", rootRunId, argumentsValue), isCode("invalid_arguments"));
  }
  assert.equal(hub.waiters.size, 0);
});

test("a wait without a cursor replays every retained relevant event", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const taskId = await submitSingleTask(hub.call, rootRunId, "history", "history-1");
  const workerRunId = await startAttempt(store, taskId, "worker-a");
  await hub.call("send_task_message", workerRunId, {
    idempotencyKey: "history-question", recipient: { type: "orchestrator" }, kind: "question", body: "Which port?"
  });
  const page = await hub.call("wait_for_task_events", rootRunId, { timeoutMilliseconds: 0 }) as WaitResult;
  assert.deepEqual(outputViolations("wait_for_task_events", page), []);
  assert.equal(page.timedOut, false);
  assert.deepEqual(page.events.map((event) => event.type), ["task", "task", "message"]);
  assert.deepEqual(page.events.map((event) => event.sequence), [1, 2, 3]);
  assert.equal(page.events[0].changes?.includes("status"), true);
  assert.equal(page.events[1].changes?.includes("attempt"), true);
  assert.equal(page.hasMore, false);
});

test("a pending wait wakes as soon as a relevant event commits", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const taskId = await submitSingleTask(hub.call, rootRunId, "woken", "woken-1");
  const workerRunId = await startAttempt(store, taskId, "worker-a");
  const cursor = await currentCursor(hub.call, rootRunId);
  const startedAt = Date.now();
  const waiting = hub.call("wait_for_task_events", rootRunId, { cursor, timeoutMilliseconds: 5_000 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(hub.waiters.size, 1);
  await hub.call("send_task_message", workerRunId, {
    idempotencyKey: "woken-question", recipient: { type: "orchestrator" }, kind: "question", body: "Which port?"
  });
  const woke = await waiting as WaitResult;
  assert.equal(woke.timedOut, false);
  assert.equal(woke.events.length, 1);
  assert.equal(woke.events[0].message?.body, "Which port?");
  assert.ok(Date.now() - startedAt < 2_000, "the wait resolves long before its timeout");
  assert.equal(hub.waiters.size, 0);
});

test("irrelevant events never wake a waiter and never skip a later relevant one", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const submitted = await hub.call("submit_tasks", rootRunId, {
    idempotencyKey: "irrelevant-batch",
    tasks: [
      { key: "watched", title: "Watched", instructions: "Watched work" },
      { key: "other", title: "Other", instructions: "Other work" }
    ]
  }) as { taskIdsByKey: Record<string, string> };
  const watchedId = submitted.taskIdsByKey.watched;
  const otherId = submitted.taskIdsByKey.other;
  const workerRunId = await startAttempt(store, watchedId, "worker-b");
  const cursor = await currentCursor(hub.call, workerRunId);
  const waiting = hub.call("wait_for_task_events", workerRunId, { cursor, timeoutMilliseconds: 120 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await hub.call("send_task_message", rootRunId, messageToTask("irrelevant-to-other", otherId, "not for you"));
  await submitSingleTask(hub.call, foreignRunId, "elsewhere", "irrelevant-foreign");
  const ignored = await waiting as WaitResult;
  assert.equal(ignored.timedOut, true);
  assert.deepEqual(ignored.events, []);
  assert.equal(hub.waiters.size, 0);

  await hub.call("send_task_message", rootRunId, messageToTask("irrelevant-to-watched", watchedId, "for you"));
  const relevant = await hub.call("wait_for_task_events", workerRunId, { cursor: ignored.cursor, timeoutMilliseconds: 0 }) as WaitResult;
  assert.equal(relevant.timedOut, false);
  assert.deepEqual(relevant.events.map((event) => event.message?.body), ["for you"]);
});

test("pages of maximumEvents return every relevant event exactly once in sequence order", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const taskId = await submitSingleTask(hub.call, rootRunId, "paged", "paged-1");
  const workerRunId = await startAttempt(store, taskId, "worker-a");
  const cursor = await currentCursor(hub.call, rootRunId);
  const sentMessageIds: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    const sent = await hub.call("send_task_message", workerRunId, {
      idempotencyKey: `paged-${index}`, recipient: { type: "orchestrator" }, kind: "progress", body: `update ${index}`
    }) as { messageId: string };
    sentMessageIds.push(sent.messageId);
  }
  const pages: WaitResult[] = [];
  let pageCursor = cursor;
  let page: WaitResult;
  do {
    page = await hub.call("wait_for_task_events", rootRunId, {
      cursor: pageCursor, timeoutMilliseconds: 0, maximumEvents: 2
    }) as WaitResult;
    assert.deepEqual(outputViolations("wait_for_task_events", page), []);
    pages.push(page);
    pageCursor = page.cursor;
  } while (page.hasMore);
  assert.deepEqual(pages.map((page) => page.events.length), [2, 2, 1]);
  assert.deepEqual(pages.map((page) => page.hasMore), [true, true, false]);
  const delivered = pages.flatMap((page) => page.events);
  assert.deepEqual(delivered.map((event) => event.message?.id), sentMessageIds);
  const sequences = delivered.map((event) => event.sequence);
  assert.deepEqual([...sequences].sort((left, right) => left - right), sequences);
});

test("cursors that are malformed, foreign, or ahead of the head are rejected", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const taskId = await submitSingleTask(hub.call, rootRunId, "cursor", "cursor-1");
  const workerRunId = await startAttempt(store, taskId, "worker-a");
  const orchestratorCursor = await currentCursor(hub.call, rootRunId);
  const workerCursor = await currentCursor(hub.call, workerRunId);
  const parts = orchestratorCursor.split(".");
  const flippedPayload = (parts[1].startsWith("A") ? "B" : "A") + parts[1].slice(1);
  const flipped = `${parts[0]}.${flippedPayload}.${parts[2]}`;
  const wrongThread = encodeTaskEventCursor("thread-two", "orchestrator", 0);
  const aheadOfHead = encodeTaskEventCursor("thread-one", "orchestrator", 999);
  for (const cursor of ["garbage", flipped, workerCursor, wrongThread, aheadOfHead]) {
    await assert.rejects(hub.call("wait_for_task_events", rootRunId, { cursor, timeoutMilliseconds: 0 }), isCode("cursor_invalid"), cursor);
  }
});

test("a cursor older than the retained floor is stale rather than silently replayed", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  await submitSingleTask(hub.call, rootRunId, "stale", "stale-1");
  const head = store.read((state) => taskEventStream(state, "thread-one").head);
  await store.transact((state) => {
    state.taskEventStreams!.find((stream) => stream.threadId === "thread-one")!.floor = head;
  });
  const stale = encodeTaskEventCursor("thread-one", "orchestrator", head - 1);
  await assert.rejects(hub.call("wait_for_task_events", rootRunId, { cursor: stale, timeoutMilliseconds: 0 }), isCode("cursor_stale"));
});

test("a timed-out wait returns no events and releases its registration", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const cursor = await currentCursor(hub.call, rootRunId);
  const page = await hub.call("wait_for_task_events", rootRunId, { cursor, timeoutMilliseconds: 60 }) as WaitResult;
  assert.equal(page.timedOut, true);
  assert.deepEqual(page.events, []);
  assert.equal(hub.waiters.size, 0);
});

test("an aborted signal ends the wait and cleans up", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const cursor = await currentCursor(hub.call, rootRunId);
  const controller = new AbortController();
  const waiting = hub.call("wait_for_task_events", rootRunId, { cursor, timeoutMilliseconds: 5_000 }, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(hub.waiters.size, 1);
  controller.abort();
  const aborted = await waiting as WaitResult;
  assert.equal(aborted.timedOut, true);
  assert.equal(hub.waiters.size, 0);
});

test("a third concurrent wait displaces the oldest one", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const cursor = await currentCursor(hub.call, rootRunId);
  const startedAt = Date.now();
  let displacedFinishedAt = 0;
  const displaced = hub.call("wait_for_task_events", rootRunId, { cursor, timeoutMilliseconds: 150 }).then((result) => {
    displacedFinishedAt = Date.now();
    return result as WaitResult;
  });
  const remaining = [
    hub.call("wait_for_task_events", rootRunId, { cursor, timeoutMilliseconds: 150 }),
    hub.call("wait_for_task_events", rootRunId, { cursor, timeoutMilliseconds: 150 })
  ];
  assert.equal(hub.waiters.size, orchestrationToolLimits.concurrentWaitsPerRun);
  const settled = await Promise.all([displaced, ...remaining]) as WaitResult[];
  assert.deepEqual(settled.map((result) => result.timedOut), [true, true, true]);
  assert.ok(displacedFinishedAt - startedAt < 100, "the displaced wait ends immediately rather than at its timeout");
  assert.equal(hub.waiters.size, 0);
});

test("a wait rejects when its source run stops running", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const cursor = await currentCursor(hub.call, rootRunId);
  const waiting = hub.call("wait_for_task_events", rootRunId, { cursor, timeoutMilliseconds: 5_000 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await store.transact((state) => {
    state.runs.find((run) => run.id === rootRunId)!.status = "completed";
  });
  await assert.rejects(waiting, isCode("run_not_active"));
  assert.equal(hub.waiters.size, 0);
});

test("acknowledgements are all-or-nothing, idempotent, and never modify messages", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const taskId = await submitSingleTask(hub.call, rootRunId, "acknowledged", "acknowledged-1");
  const workerRunId = await startAttempt(store, taskId, "worker-a");
  const question = await hub.call("send_task_message", workerRunId, {
    idempotencyKey: "acknowledged-question", recipient: { type: "orchestrator" }, kind: "question", body: "Which port?"
  }) as { messageId: string };
  const answer = await hub.call("send_task_message", rootRunId, {
    idempotencyKey: "acknowledged-answer", recipient: { type: "task", taskId }, kind: "answer", body: "8080"
  }) as { messageId: string };
  const messagesBefore = store.read((state) => structuredClone(state.taskMessages));
  const beforeContext = await hub.call("get_task_context", rootRunId, {}) as ContextResult;
  assert.equal(beforeContext.mailbox.unacknowledgedCount, 1);
  assert.equal(beforeContext.mailbox.latestSequence, 1);

  await assert.rejects(
    hub.call("wait_for_task_events", rootRunId, { acknowledgeMessageIds: [question.messageId, "taskmsg_missing"], timeoutMilliseconds: 0 }),
    isCode("not_found")
  );
  await assert.rejects(
    hub.call("wait_for_task_events", workerRunId, { acknowledgeMessageIds: [question.messageId], timeoutMilliseconds: 0 }),
    isCode("not_found")
  );
  assert.equal(store.read((state) => state.taskMessageAcknowledgements?.length ?? 0), 0);

  const acknowledging = await hub.call("wait_for_task_events", rootRunId, {
    acknowledgeMessageIds: [question.messageId], timeoutMilliseconds: 0
  }) as WaitResult;
  assert.equal(acknowledging.events.find((event) => event.message?.id === question.messageId)?.message?.acknowledged, true);
  await hub.call("wait_for_task_events", rootRunId, { acknowledgeMessageIds: [question.messageId], timeoutMilliseconds: 0 });
  assert.equal(store.read((state) => state.taskMessageAcknowledgements?.length), 1);
  assert.deepEqual(store.read((state) => state.taskMessages), messagesBefore);

  const afterContext = await hub.call("get_task_context", rootRunId, {}) as ContextResult;
  assert.equal(afterContext.mailbox.unacknowledgedCount, 0);
  const seen = await hub.call("wait_for_task_events", workerRunId, { timeoutMilliseconds: 0 }) as WaitResult;
  assert.equal(seen.events.find((event) => event.message?.id === answer.messageId)?.message?.acknowledged, false);
});

test("each committed task change appends one journal entry with an increasing per-thread sequence", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const taskId = await submitSingleTask(hub.call, rootRunId, "journaled", "journaled-1");
  let entries = journalTaskEntries(store, "thread-one");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].taskId, taskId);
  assert.equal(entries[0].sequence, 1);
  assert.equal(entries[0].status, "ready");
  assert.equal(entries[0].previousStatus, undefined);
  assert.deepEqual(entries[0].changes, ["status"]);

  const workerRunId = await startAttempt(store, taskId, "worker-a");
  entries = journalTaskEntries(store, "thread-one");
  assert.equal(entries.length, 2);
  assert.equal(entries[1].sequence, 2);
  assert.deepEqual([...entries[1].changes].sort(), ["attempt", "status"]);
  assert.equal(entries[1].attemptRunId, workerRunId);
  assert.equal(entries[1].previousStatus, "ready");

  await store.transact((state) => {
    const run = state.runs.find((item) => item.id === workerRunId)!;
    run.status = "completed";
    run.finishedAt = fixtureTime;
    applyAttemptOutcome(state, workerRunId, fixtureTime);
  });
  entries = journalTaskEntries(store, "thread-one");
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[2].changes, ["status"]);
  assert.equal(entries[2].status, "completed");
  assert.equal(entries[2].previousStatus, "running");
  assert.equal(taskEventStream(store.read((state) => state), "thread-one").head, 3);

  await submitSingleTask(hub.call, foreignRunId, "elsewhere", "journal-foreign");
  assert.equal(taskEventStream(store.read((state) => state), "thread-one").head, 3);
  const otherThread = taskEventStream(store.read((state) => state), "thread-two");
  assert.equal(otherThread.head, 1);
  assert.equal(journalEntries(store, "thread-two").length, 1);
});

test("the journal prunes to the retention bound and moves its floor past the pruned entries", async () => {
  const store = await orchestrationStore();
  await seedMessages(store, "thread-one", orchestrationToolLimits.retainedEventsPerThread + 5, { type: "orchestrator" }, { type: "task", taskId: "task-seed-target" });
  store.read((state) => {
    const entries = state.taskEventJournal!.filter((entry) => entry.threadId === "thread-one");
    assert.equal(entries.length, orchestrationToolLimits.retainedEventsPerThread);
    const stream = taskEventStream(state, "thread-one");
    assert.equal(stream.head, orchestrationToolLimits.retainedEventsPerThread + 5);
    assert.equal(stream.floor, 5);
    assert.equal(Math.min(...entries.map((entry) => entry.sequence)), 6);
  });
});

test("snapshots never publish the hub-only coordination collections", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const taskId = await submitSingleTask(hub.call, rootRunId, "unpublished", "unpublished-1");
  const workerRunId = await startAttempt(store, taskId, "worker-b");
  await hub.call("update_task", workerRunId, { idempotencyKey: "unpublished-update", progress: "Started" });
  const snapshot = store.snapshot() as unknown as Record<string, unknown>;
  for (const collection of ["taskEventJournal", "taskEventStreams", "taskUpdates"]) {
    assert.equal(Object.hasOwn(snapshot, collection), false, collection);
  }
  assert.ok(store.read((state) => (state.taskEventJournal ?? []).length > 0));
  assert.ok(store.read((state) => (state.taskUpdates ?? []).length > 0));
});
