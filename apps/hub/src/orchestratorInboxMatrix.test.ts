import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  orchestratorContinuationLimits as limits,
  type AcpAgentCapabilities,
  type HarnessSessionBinding,
  type HubToControlAgent,
  type Run,
  type Task,
  type TaskMessage,
  type TaskStatus
} from "@coffee-shop/protocol";
import { fixtureHandler, fixtureNode, fixtureRun, fixtureTime, orchestrationStore, rootRunId } from "./hubToolsTestSupport.js";
import { openApproval } from "./approvals.js";
import { resolveApproval } from "./harnessGateway.js";
import { applyRunLifecycle, failLostTaskAttempts } from "./lifecycle.js";
import type { TaskEventWaitResult } from "./mailbox.js";
import { isOrchestratorRelevant, retryDelayMilliseconds, runContinuationPass, type ContinuationPassResult } from "./orchestratorInbox.js";
import type { NodeConnection, SchedulingContext } from "./scheduler.js";
import { acceptSessionBinding } from "./sessionBindings.js";
import { Store, type State } from "./store.js";
import { assignTaskAttempt } from "./tasks.js";
import type { TaskEventEntry } from "./taskEvents.js";

const later = (minutes: number) => new Date(Date.parse(fixtureTime) + minutes * 60_000).toISOString();
const secondsAfter = (base: string, seconds: number) => new Date(Date.parse(base) + seconds * 1_000).toISOString();

const resumable: AcpAgentCapabilities = {
  protocolVersion: 1, loadSession: false, resumeSession: true,
  prompt: { image: false, audio: false, embeddedContext: false }, mcp: { http: true, sse: false }
};

interface PassOptions {
  delivered?: HubToControlAgent[];
  connection?: (nodeId: string) => NodeConnection | undefined;
  canDeliver?: boolean;
}

function schedulingContext(options: PassOptions = {}): SchedulingContext {
  return {
    connection: options.connection ?? (() => ({ protocolVersion: "4" as const, synced: true })),
    capabilityReport: () => undefined,
    projectProfile: () => undefined,
    canDeliver: (_nodeId: string, message: HubToControlAgent) => {
      options.delivered?.push(message);
      return options.canDeliver ?? true;
    }
  };
}

async function pass(store: Store, at: string, options: PassOptions = {}) {
  const delivered = options.delivered ?? [];
  let result: ContinuationPassResult | undefined;
  await store.transact((state) => {
    result = runContinuationPass(state, schedulingContext({ ...options, delivered }), at);
    return result.changed;
  });
  return result!;
}

const lifecycle = (store: Store, message: Parameters<typeof applyRunLifecycle>[1]) =>
  store.transact((state) => applyRunLifecycle(state, message));

const continuationRuns = (store: Store) => store.read((state) => state.runs.filter((run) => run.id.startsWith("run_wake_")));
const inbox = (store: Store) => store.read((state) => structuredClone(state.orchestratorInboxes?.find((item) => item.threadId === "thread-one")));
/** Journal sequences of the thread's message entries, so assertions never assume where numbering starts. */
const messageSequences = (store: Store) => store.read((state) => (state.taskEventJournal ?? [])
  .filter((entry) => entry.kind === "message" && entry.threadId === "thread-one")
  .map((entry) => entry.sequence));
const lastWake = (store: Store) => inbox(store)!.wakes.at(-1)!;
const cursorFrom = (prompt: string) => {
  const cursor = /"cursor":"([^"]+)"/.exec(prompt)?.[1];
  assert.ok(cursor, "the prompt carries the acknowledgement cursor");
  return cursor;
};

function workerTask(id: string): Task {
  return {
    id, threadId: "thread-one", title: `Task ${id}`, instructions: `Do ${id}`, status: "ready", requirements: {}, dependencies: [],
    sourceRunId: rootRunId, idempotencyKey: `key-${id}`, attemptRunIds: [], createdAt: fixtureTime, updatedAt: fixtureTime
  };
}

/** A thread whose orchestrator run finished after delegating one task, which is now running. */
async function idleOrchestrator(options: { acp?: boolean } = {}) {
  const store = await orchestrationStore();
  await store.transact((state) => {
    if (options.acp) {
      const node = state.nodes.find((item) => item.id === "node-orchestrator")!;
      node.harnesses = [{ ...fixtureNode("node-orchestrator").harnesses[0], transports: ["native-cli", "acp-v1"], acp: resumable }];
    }
    state.tasks = [workerTask("task-a")];
    const attempt: Run = fixtureRun("run-task-a", "thread-one", "worker-a", { status: "queued", startedAt: undefined, depth: 1, parentRunId: rootRunId });
    assignTaskAttempt(state, "task-a", attempt, fixtureTime);
    applyRunLifecycle(state, { type: "run.started", runId: attempt.id, at: fixtureTime });
    applyRunLifecycle(state, { type: "run.completed", runId: rootRunId, output: "Delegated", at: fixtureTime });
  });
  return store;
}

async function withIdleBinding(store: Store, overrides: Partial<HarnessSessionBinding> = {}) {
  await store.transact((state) => {
    state.sessionBindings = [{
      id: "session-previous", threadId: "thread-one", agentId: "orchestrator", nodeId: "node-orchestrator", harnessId: "codex-cli",
      transport: "acp-v1", workspace: "/workspace/orchestrator", providerSessionId: "provider-previous", status: "idle",
      createdByRunId: rootRunId, lastRunId: rootRunId, capabilities: resumable, createdAt: fixtureTime, updatedAt: fixtureTime, ...overrides
    }];
  });
}

async function pushMessages(store: Store, count: number, options: { first?: number; body?: string; toTask?: boolean } = {}) {
  const first = options.first ?? 1;
  const body = options.body ?? "worker note";
  await store.transact((state) => {
    state.taskMessages ??= [];
    for (let offset = 0; offset < count; offset += 1) {
      const sequence = first + offset;
      const message: TaskMessage = {
        id: `taskmsg-${String(sequence).padStart(3, "0")}`,
        threadId: "thread-one",
        sender: { type: "task", taskId: "task-a" },
        recipient: options.toTask ? { type: "task", taskId: "task-a" } : { type: "orchestrator" },
        sequence,
        kind: "progress",
        body: `${body} ${sequence}`,
        idempotencyKey: `message-key-${sequence}`,
        createdAt: fixtureTime
      };
      state.taskMessages.push(message);
    }
  });
}

async function restartedStore(store: Store): Promise<Store> {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-orchestrator-restart-"));
  const path = join(directory, "state.json");
  await writeFile(path, store.read((state) => JSON.stringify(state)));
  const fresh = new Store(path);
  await fresh.load();
  return fresh;
}

test("an orchestrator blocked in wait_for_task_events receives the committed event and no continuation is created", async () => {
  const store = await orchestrationStore();
  const hub = fixtureHandler(store);
  const waiting = hub.call("wait_for_task_events", rootRunId, { timeoutMilliseconds: 2000 });
  await pushMessages(store, 1);
  const result = await waiting as TaskEventWaitResult;
  assert.equal(result.timedOut, false);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, "message");
  if (result.events[0].type === "message") assert.equal(result.events[0].message.id, "taskmsg-001");
  assert.equal((await pass(store, later(1))).continuations.length, 0);
  assert.equal(continuationRuns(store).length, 0);
  const current = inbox(store)!;
  assert.equal(current.deliveredThrough, result.events[0].sequence);
  assert.equal(current.processedThrough, 0, "the page the waiter received is delivered, not processed");
});

test("an event that commits while the orchestrator runs is delivered only by a continuation after the run completes", async () => {
  const store = await orchestrationStore();
  await pushMessages(store, 1);
  assert.equal((await pass(store, later(1))).continuations.length, 0, "an active orchestrator run takes precedence");
  await lifecycle(store, { type: "run.completed", runId: rootRunId, output: "Delegated", at: later(2) });
  const result = await pass(store, later(3));
  assert.equal(result.continuations.length, 1);
  const [eventSequence] = messageSequences(store);
  const wake = lastWake(store);
  assert.equal(wake.fromSequence, 0);
  assert.deepEqual(wake.eventSequences, [eventSequence]);
  assert.ok(wake.throughSequence >= eventSequence);
});

test("only messages to the orchestrator, terminal task statuses, and blocked progress are relevant", async () => {
  const store = await orchestrationStore();
  await store.transact((state) => {
    state.tasks = [
      { ...workerTask("task-a"), status: "running", progress: { summary: "Waiting", blockedReason: "Waiting on an operator", runId: "run-task-a", updatedAt: fixtureTime } },
      { ...workerTask("task-b"), status: "running", progress: { summary: "Working", runId: "run-task-b", updatedAt: fixtureTime } }
    ];
  });
  const state = store.read((current) => current);
  const at = fixtureTime;
  const messageToOrchestrator: TaskEventEntry = { threadId: "thread-one", sequence: 1, at, kind: "message", messageId: "message-one", recipientKey: "orchestrator" };
  const messageToTask: TaskEventEntry = { threadId: "thread-one", sequence: 2, at, kind: "message", messageId: "message-two", recipientKey: "task:task-a" };
  const statusChange = (status: TaskStatus): TaskEventEntry => ({ threadId: "thread-one", sequence: 3, at, kind: "task", taskId: "task-a", status, changes: ["status"] });
  const progressChange = (taskId: string): TaskEventEntry => ({ threadId: "thread-one", sequence: 4, at, kind: "task", taskId, status: "running", changes: ["progress"] });
  const attemptChange: TaskEventEntry = { threadId: "thread-one", sequence: 5, at, kind: "task", taskId: "task-a", status: "running", changes: ["attempt"] };
  assert.equal(isOrchestratorRelevant(state, messageToOrchestrator), true);
  assert.equal(isOrchestratorRelevant(state, messageToTask), false);
  for (const status of ["completed", "failed", "cancelled", "blocked"] as const) assert.equal(isOrchestratorRelevant(state, statusChange(status)), true);
  for (const status of ["ready", "assigned", "running"] as const) assert.equal(isOrchestratorRelevant(state, statusChange(status)), false);
  assert.equal(isOrchestratorRelevant(state, progressChange("task-a")), true, "progress of a blocked task is relevant");
  assert.equal(isOrchestratorRelevant(state, progressChange("task-b")), false, "progress without a blocked reason is not");
  assert.equal(isOrchestratorRelevant(state, progressChange("task-missing")), false);
  assert.equal(isOrchestratorRelevant(state, attemptChange), false);

  const flow = await idleOrchestrator();
  await pushMessages(flow, 1, { toTask: true });
  assert.equal((await pass(flow, later(3))).continuations.length, 0, "irrelevant events alone never wake the orchestrator");
  assert.equal(continuationRuns(flow).length, 0);
});

test("a burst of relevant events is coalesced into bounded wakes that resume in order", async () => {
  const store = await idleOrchestrator();
  await pushMessages(store, 60);
  const sequences = messageSequences(store);
  assert.equal(sequences.length, 60);
  const bounded = sequences.slice(0, limits.eventsPerWake);
  const first = await pass(store, later(3));
  assert.equal(first.continuations.length, 1);
  const [firstRun] = continuationRuns(store);
  const firstWake = lastWake(store);
  assert.equal(firstWake.eventSequences.length, limits.eventsPerWake);
  assert.deepEqual(firstWake.eventSequences, bounded);
  assert.equal(firstWake.throughSequence, bounded.at(-1));
  assert.equal(firstRun.prompt.includes("taskmsg-050"), true, "the wake prompt covers the fiftieth event");
  assert.equal(firstRun.prompt.includes("taskmsg-051"), false, "events beyond the bound stay pending");

  await lifecycle(store, { type: "run.started", runId: firstRun.id, at: later(4) });
  const hub = fixtureHandler(store);
  await hub.call("wait_for_task_events", firstRun.id, { cursor: cursorFrom(firstRun.prompt), timeoutMilliseconds: 0 });
  assert.equal(inbox(store)!.processedThrough, bounded.at(-1));
  await lifecycle(store, { type: "run.completed", runId: firstRun.id, output: "Handled", at: later(5) });

  const second = await pass(store, later(6));
  assert.equal(second.continuations.length, 1);
  const secondWake = lastWake(store);
  const remaining = sequences.slice(limits.eventsPerWake);
  assert.deepEqual(secondWake.eventSequences, remaining);
  assert.equal(secondWake.generation, firstWake.generation + 1);
  const secondRun = continuationRuns(store).find((run) => run.id === second.continuations[0].runId)!;
  const promptOrder = [...secondRun.prompt.matchAll(/- sequence (\d+)/g)].map((match) => Number(match[1]));
  assert.deepEqual(promptOrder, remaining, "events keep their journal order in the prompt");
});

test("an event that commits during a wake is delivered by the next generation", async () => {
  const store = await idleOrchestrator();
  await pushMessages(store, 1);
  const [firstSequence] = messageSequences(store);
  await pass(store, later(3));
  const firstWake = lastWake(store);
  await pushMessages(store, 1, { first: 2 });
  const secondSequence = messageSequences(store)[1];
  assert.deepEqual(lastWake(store).eventSequences, [firstSequence], "the new event is outside the active wake's range");
  assert.equal((await pass(store, later(4))).continuations.length, 0, "no second continuation is created while one is active");
  assert.equal(continuationRuns(store).length, 1);
  const [run] = continuationRuns(store);

  await lifecycle(store, { type: "run.started", runId: run.id, at: later(5) });
  const hub = fixtureHandler(store);
  await hub.call("wait_for_task_events", run.id, { cursor: cursorFrom(run.prompt), timeoutMilliseconds: 0 });
  assert.equal(inbox(store)!.processedThrough, firstSequence);
  await lifecycle(store, { type: "run.completed", runId: run.id, output: "Handled", at: later(6) });
  const next = await pass(store, later(7));
  assert.equal(next.continuations.length, 1);
  const secondWake = lastWake(store);
  assert.deepEqual(secondWake.eventSequences, [secondSequence]);
  assert.equal(secondWake.generation, firstWake.generation + 1);
  assert.notEqual(next.continuations[0].runId, run.id);
});

test("a continuation that fails before its prompt is delivered backs off and retries without redelivery", async () => {
  const store = await idleOrchestrator();
  await pushMessages(store, 1);
  await pass(store, later(3));
  const [run] = continuationRuns(store);
  const failureTime = later(4);
  await lifecycle(store, { type: "run.failed", runId: run.id, error: "Adapter crashed", at: failureTime });
  await pass(store, failureTime);
  const current = inbox(store)!;
  const wake = current.wakes.at(-1)!;
  assert.equal(wake.status, "failed");
  assert.equal(wake.failedAfterDelivery, false);
  assert.equal(current.deliveredThrough, 0);
  assert.equal(current.consecutiveFailures, 1);
  assert.equal(current.retryAfter, new Date(Date.parse(failureTime) + retryDelayMilliseconds(1)).toISOString());
  assert.equal((await pass(store, secondsAfter(failureTime, 4))).continuations.length, 0, "no retry before the backoff elapses");
  const retry = await pass(store, secondsAfter(failureTime, 6));
  assert.equal(retry.continuations.length, 1);
  assert.equal(lastWake(store).redelivery, false);
});

test("a continuation that fails after its prompt was delivered is redelivered with backoff and then stops", async () => {
  const store = await idleOrchestrator();
  await pushMessages(store, 1);
  const [eventSequence] = messageSequences(store);
  await pass(store, later(3));
  const [run] = continuationRuns(store);
  await lifecycle(store, { type: "run.started", runId: run.id, at: later(4) });
  await pass(store, later(4));
  await lifecycle(store, { type: "run.failed", runId: run.id, error: "Session died", at: later(5) });
  await pass(store, later(5));
  let current = inbox(store)!;
  assert.equal(current.wakes.at(-1)!.status, "failed");
  assert.equal(current.wakes.at(-1)!.failedAfterDelivery, true);
  assert.equal(current.deliveredThrough, eventSequence);

  let failureTime = later(5);
  for (let redelivery = 1; redelivery <= limits.maximumRedeliveries; redelivery += 1) {
    const result = await pass(store, secondsAfter(failureTime, 30));
    assert.equal(result.continuations.length, 1, `redelivery ${redelivery}`);
    const wake = lastWake(store);
    assert.equal(wake.redelivery, true);
    const redeliveryRun = continuationRuns(store).find((candidate) => candidate.id === result.continuations[0].runId)!;
    assert.match(redeliveryRun.prompt, /already delivered/);
    await lifecycle(store, { type: "run.started", runId: redeliveryRun.id, at: secondsAfter(failureTime, 31) });
    failureTime = secondsAfter(failureTime, 32);
    await lifecycle(store, { type: "run.failed", runId: redeliveryRun.id, error: "Session died again", at: failureTime });
    await pass(store, failureTime);
  }
  current = inbox(store)!;
  assert.equal(current.redeliveries, limits.maximumRedeliveries);
  assert.equal((await pass(store, secondsAfter(failureTime, 60))).continuations.length, 0, "no further continuation after the redelivery budget");

  await pushMessages(store, 1, { first: 2 });
  const laterSequence = messageSequences(store)[1];
  const revived = await pass(store, secondsAfter(failureTime, 90));
  assert.equal(revived.continuations.length, 1);
  const revivedWake = lastWake(store);
  assert.equal(revivedWake.redelivery, false, "a new event restarts delivery covering old and new events");
  assert.deepEqual(revivedWake.eventSequences, [eventSequence, laterSequence]);
});

test("a continuation that completes without acknowledging is redelivered at most twice and acknowledging resets the count", async () => {
  const store = await idleOrchestrator();
  await pushMessages(store, 1);
  await pass(store, later(3));
  let runCount = 1;
  for (let redelivery = 1; redelivery <= limits.maximumRedeliveries; redelivery += 1) {
    const previous = continuationRuns(store)[0];
    await lifecycle(store, { type: "run.started", runId: previous.id, at: later(3 + redelivery) });
    await lifecycle(store, { type: "run.completed", runId: previous.id, output: "Handled", at: later(3 + redelivery) });
    const result = await pass(store, later(6 + redelivery));
    runCount += result.continuations.length;
    assert.equal(result.continuations.length, 1, `redelivery ${redelivery} after an unacknowledged completion`);
    assert.equal(lastWake(store).redelivery, true);
  }
  const finalRun = continuationRuns(store)[0];
  await lifecycle(store, { type: "run.started", runId: finalRun.id, at: later(10) });
  await lifecycle(store, { type: "run.completed", runId: finalRun.id, output: "Handled", at: later(11) });
  assert.equal((await pass(store, later(12))).continuations.length, 0, "the redelivery budget stops the cycle");
  assert.equal(continuationRuns(store).length, runCount);

  const acknowledging = await idleOrchestrator();
  await pushMessages(acknowledging, 1);
  await pass(acknowledging, later(3));
  const firstRun = continuationRuns(acknowledging)[0];
  await lifecycle(acknowledging, { type: "run.started", runId: firstRun.id, at: later(4) });
  await lifecycle(acknowledging, { type: "run.completed", runId: firstRun.id, output: "Handled", at: later(5) });
  const second = await pass(acknowledging, later(6));
  assert.equal(second.continuations.length, 1);
  const secondRun = continuationRuns(acknowledging).find((candidate) => candidate.id === second.continuations[0].runId)!;
  const acknowledgedThrough = lastWake(acknowledging)!.throughSequence;
  await lifecycle(acknowledging, { type: "run.started", runId: secondRun.id, at: later(7) });
  const hub = fixtureHandler(acknowledging);
  await hub.call("wait_for_task_events", secondRun.id, { cursor: cursorFrom(secondRun.prompt), timeoutMilliseconds: 0 });
  assert.equal(inbox(acknowledging)!.redeliveries, 0, "acknowledging resets the redelivery count");
  assert.equal(inbox(acknowledging)!.processedThrough, acknowledgedThrough);
  await lifecycle(acknowledging, { type: "run.completed", runId: secondRun.id, output: "Handled", at: later(8) });
  assert.equal((await pass(acknowledging, later(9))).continuations.length, 0);
});

test("the retry delay doubles from its base and caps at its maximum", () => {
  assert.equal(retryDelayMilliseconds(1), limits.retryBaseMilliseconds);
  assert.equal(retryDelayMilliseconds(2), limits.retryBaseMilliseconds * 2);
  assert.equal(retryDelayMilliseconds(4), limits.retryBaseMilliseconds * 8);
  const uncapped = limits.retryMaximumMilliseconds * 2;
  assert.ok(retryDelayMilliseconds(40) <= limits.retryMaximumMilliseconds);
  assert.equal(retryDelayMilliseconds(40), limits.retryMaximumMilliseconds);
  assert.ok(limits.retryBaseMilliseconds < uncapped);
});

test("a restarted hub converges on the persisted wake state without duplicating a continuation", async () => {
  const store = await idleOrchestrator();
  await pushMessages(store, 1);
  await pass(store, later(3), { canDeliver: false });
  let current = await restartedStore(store);
  assert.equal((await pass(current, later(4))).continuations.length, 0);
  assert.equal(continuationRuns(current).length, 1);
  assert.equal(lastWake(current).status, "scheduled");

  const runId = lastWake(current).runId;
  assert.equal(current.getRun(runId)!.dispatchedAt, undefined);
  await current.transact((state) => {
    const run = state.runs.find((item) => item.id === runId)!;
    run.dispatchedAt = later(4);
  });
  current = await restartedStore(current);
  assert.equal((await pass(current, later(5))).continuations.length, 0);
  assert.equal(lastWake(current).status, "scheduled");

  await lifecycle(current, { type: "run.started", runId, at: later(5) });
  current = await restartedStore(current);
  assert.equal((await pass(current, later(6))).continuations.length, 0);
  assert.equal(lastWake(current).status, "delivered");

  const hub = fixtureHandler(current);
  await hub.call("wait_for_task_events", runId, { cursor: cursorFrom(current.getRun(runId)!.prompt), timeoutMilliseconds: 0 });
  await lifecycle(current, { type: "run.completed", runId, output: "Handled", at: later(7) });
  current = await restartedStore(current);
  assert.equal((await pass(current, later(8))).continuations.length, 0, "an acknowledged range never wakes again after a restart");
  assert.equal(lastWake(current).status, "completed");
  assert.equal(continuationRuns(current).length, 1);

  const failing = await idleOrchestrator();
  await pushMessages(failing, 1);
  await pass(failing, later(3));
  const failingRunId = continuationRuns(failing)[0].id;
  const failureTime = later(4);
  await lifecycle(failing, { type: "run.failed", runId: failingRunId, error: "Crashed", at: failureTime });
  const restartedFailure = await restartedStore(failing);
  assert.equal((await pass(restartedFailure, failureTime)).continuations.length, 0, "the failure backoff survives the restart");
  assert.equal(lastWake(restartedFailure).status, "failed");
  assert.equal(continuationRuns(restartedFailure).length, 1);
});

test("an exact retry of a scheduling pass produces the same continuation and wake identities", async () => {
  const store = await idleOrchestrator();
  await pushMessages(store, 2);
  const baseState = store.read((state) => structuredClone(state) as State);
  const firstState = structuredClone(baseState);
  const secondState = structuredClone(baseState);
  const first = runContinuationPass(firstState, schedulingContext(), later(3));
  const second = runContinuationPass(secondState, schedulingContext(), later(3));
  assert.equal(first.continuations.length, 1);
  assert.equal(second.continuations.length, 1);
  assert.equal(first.continuations[0].runId, second.continuations[0].runId);
  const firstWake = firstState.orchestratorInboxes![0].wakes.at(-1)!;
  const secondWake = secondState.orchestratorInboxes![0].wakes.at(-1)!;
  assert.equal(firstWake.id, secondWake.id);
  assert.equal(firstWake.runId, secondWake.runId);
});

test("a continuation lost with its compute node fails its binding and its range is offered again", async () => {
  const store = await idleOrchestrator({ acp: true });
  await withIdleBinding(store);
  await pushMessages(store, 1);
  const [eventSequence] = messageSequences(store);
  await pass(store, later(3));
  const [run] = continuationRuns(store);
  assert.equal(run.sessionBindingId, "session-previous");
  await store.transact((state) => {
    const outcome = acceptSessionBinding(state, "node-orchestrator", run.id, {
      bindingId: "session-previous", providerSessionId: "provider-previous", harnessId: "codex-cli", transport: "acp-v1", status: "active"
    }, later(4));
    assert.equal(outcome.kind, "resumed");
  });
  await lifecycle(store, { type: "run.started", runId: run.id, at: later(4), transport: { requestedTransport: "acp-v1", selectedTransport: "acp-v1", acp: resumable } });
  await pass(store, later(5));
  const lostTime = later(6);
  await store.transact((state) => {
    const lost = failLostTaskAttempts(state, "node-orchestrator", [], lostTime);
    assert.equal(lost.length, 1);
  });
  assert.equal(store.getRun(run.id)?.status, "failed");
  assert.equal(store.read((state) => state.sessionBindings!.find((item) => item.id === "session-previous")!.status), "failed");
  await pass(store, lostTime);
  const retry = await pass(store, secondsAfter(lostTime, 6));
  assert.equal(retry.continuations.length, 1);
  assert.deepEqual(lastWake(store).eventSequences, [eventSequence], "the unacknowledged range is offered again");
  assert.equal(store.getRun(retry.continuations[0].runId)?.sessionBindingId, undefined, "a failed binding is never requested");
});

test("a continuation that is never dispatched loses its claim after the claim window", async () => {
  const store = await idleOrchestrator();
  await pushMessages(store, 1);
  await pass(store, later(3), { canDeliver: false });
  const [run] = continuationRuns(store);
  assert.equal(run.dispatchedAt, undefined);
  assert.equal(run.status, "queued");
  assert.equal((await pass(store, later(8))).continuations.length, 0, "the claim holds inside the window");
  await pass(store, later(14));
  assert.equal(store.getRun(run.id)?.status, "cancelled");
  const wake = lastWake(store);
  assert.equal(wake.status, "failed");
  assert.equal(wake.failedAfterDelivery, false);
});

test("no continuation is created for an inactive thread, a missing owner, an unsynchronized node, or a node at capacity", async () => {
  const scenarios: Array<{ name: string; prepare?: (store: Store) => Promise<void>; connection?: (nodeId: string) => NodeConnection | undefined }> = [
    {
      name: "the thread is not active",
      prepare: async (store) => { await store.transact((state) => { const thread = state.threads!.find((item) => item.id === "thread-one")!; thread.status = "completed"; }); }
    },
    {
      name: "the owner agent is missing",
      prepare: async (store) => { await store.transact((state) => { state.agents = state.agents.filter((agent) => agent.id !== "orchestrator"); }); }
    },
    { name: "the owner's node is not connected", connection: () => undefined },
    { name: "the owner's node speaks protocol version three", connection: () => ({ protocolVersion: "3" as const, synced: true }) },
    { name: "the owner's node has not synchronized", connection: () => ({ protocolVersion: "4" as const, synced: false }) },
    {
      name: "the owner's node is at capacity",
      prepare: async (store) => { await store.transact((state) => { const node = state.nodes.find((item) => item.id === "node-orchestrator")!; node.activeRuns = node.concurrency; }); }
    }
  ];
  for (const scenario of scenarios) {
    const store = await idleOrchestrator();
    await pushMessages(store, 1);
    if (scenario.prepare) await scenario.prepare(store);
    const result = await pass(store, later(3), { connection: scenario.connection });
    assert.equal(result.continuations.length, 0, scenario.name);
    assert.equal(continuationRuns(store).length, 0, scenario.name);
  }
});

test("a native fallback continuation is recorded as native and leaves the requested binding idle", async () => {
  const store = await idleOrchestrator({ acp: true });
  await withIdleBinding(store);
  await pushMessages(store, 1);
  await pass(store, later(3));
  const [run] = continuationRuns(store);
  assert.equal(run.transport, "acp-v1");
  assert.equal(run.fallbackTransport, "native-cli");
  assert.equal(run.sessionBindingId, "session-previous");
  await lifecycle(store, {
    type: "run.started", runId: run.id, at: later(4),
    transport: { requestedTransport: "acp-v1", selectedTransport: "native-cli", fallbackReason: "acp-adapter-unavailable" }
  });
  await pass(store, later(5));
  const wake = lastWake(store);
  assert.equal(wake.status, "delivered");
  assert.equal(wake.sessionOutcome, "native");
  const bindingState = store.read((state) => state.sessionBindings!.find((item) => item.id === "session-previous"));
  assert.equal(bindingState?.status, "idle", "the fallback never activated the binding");
  assert.equal(bindingState?.lastRunId, rootRunId);
  assert.equal(bindingState?.replacedByBindingId, undefined);
});

test("bindings in use, unadvertised, leased, or of another thread are never requested for resume", async () => {
  const scenarios: Array<{ name: string; bindingOverrides?: Partial<HarnessSessionBinding>; prepare?: (store: Store) => Promise<void> }> = [
    {
      name: "in use by another active run",
      prepare: async (store) => {
        await store.transact((state) => {
          state.runs.unshift(fixtureRun("run-holder", "thread-one", "worker-a", { status: "running", sessionBindingId: "session-previous" }));
        });
      }
    },
    {
      name: "no longer advertised as resumable by the node",
      prepare: async (store) => {
        await store.transact((state) => {
          const node = state.nodes.find((item) => item.id === "node-orchestrator")!;
          node.harnesses = [{
            ...fixtureNode("node-orchestrator").harnesses[0],
            transports: ["native-cli", "acp-v1"],
            acp: { ...resumable, resumeSession: false, loadSession: false }
          }];
        });
      }
    },
    { name: "leased to a workspace", bindingOverrides: { workspaceLeaseId: "lease-one" } },
    { name: "of another thread", bindingOverrides: { threadId: "thread-two" } }
  ];
  for (const scenario of scenarios) {
    const store = await idleOrchestrator({ acp: true });
    await withIdleBinding(store, scenario.bindingOverrides);
    if (scenario.prepare) await scenario.prepare(store);
    await pushMessages(store, 1);
    const result = await pass(store, later(3));
    assert.equal(result.continuations.length, 1, scenario.name);
    assert.equal(store.getRun(result.continuations[0].runId)?.sessionBindingId, undefined, scenario.name);
  }
});

test("approvals raised by a continuation are settled with it and never cross into the next session", async () => {
  const store = await idleOrchestrator({ acp: true });
  await withIdleBinding(store);
  await pushMessages(store, 1);
  await pass(store, later(3));
  const [firstRun] = continuationRuns(store);
  await store.transact((state) => {
    const outcome = acceptSessionBinding(state, "node-orchestrator", firstRun.id, {
      bindingId: "session-previous", providerSessionId: "provider-previous", harnessId: "codex-cli", transport: "acp-v1", status: "active"
    }, later(4));
    assert.equal(outcome.kind, "resumed");
  });
  await lifecycle(store, { type: "run.started", runId: firstRun.id, at: later(4), transport: { requestedTransport: "acp-v1", selectedTransport: "acp-v1", acp: resumable } });
  await store.transact((state) => {
    const run = state.runs.find((item) => item.id === firstRun.id)!;
    const conflict = openApproval(state, run, {
      runId: firstRun.id, sequence: 1, at: later(4), type: "permission.requested", approvalId: "permission-one",
      title: "Run a command", options: [{ id: "allow", label: "Allow", kind: "allow-once" }]
    }, later(4));
    assert.equal(conflict, undefined);
  });
  await lifecycle(store, { type: "run.completed", runId: firstRun.id, output: "Handled", at: later(5) });
  const settled = store.read((state) => state.approvals!.find((item) => item.harnessApprovalId === "permission-one"));
  assert.notEqual(settled?.status, "pending");

  const second = await pass(store, later(6));
  assert.equal(second.continuations.length, 1);
  const secondRunId = second.continuations[0].runId;
  assert.equal(store.getRun(secondRunId)?.sessionBindingId, "session-previous", "the next continuation resumes the same binding");
  const sent: HubToControlAgent[] = [];
  const response = await resolveApproval(store, settled!.id, { idempotencyKey: "resolution-one", expectedStatus: "pending", optionId: "allow" }, (_nodeId, message) => {
    sent.push(message);
    return true;
  });
  assert.equal(response.status, 409);
  assert.equal(sent.some((message) => message.type === "approval.decision" && message.decision.runId === secondRunId), false, "no decision is sent for the new session");
});
