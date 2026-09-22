import assert from "node:assert/strict";
import test from "node:test";
import type { AcpAgentCapabilities, HarnessSessionBinding, HubToControlAgent, Run, Task, TaskMessage } from "@coffee-shop/protocol";
import { fixtureHandler, fixtureNode, fixtureRun, fixtureTime, orchestrationStore, rootRunId } from "./hubToolsTestSupport.js";
import { applyRunLifecycle } from "./lifecycle.js";
import { encodeTaskEventCursor } from "./mailbox.js";
import { runContinuationPass } from "./orchestratorInbox.js";
import { dispatchMessageFor, type SchedulingContext } from "./scheduler.js";
import { acceptSessionBinding, retainedTerminalSessionBindings, sessionResumeUnavailableReason } from "./sessionBindings.js";
import type { Store } from "./store.js";
import { assignTaskAttempt } from "./tasks.js";

const later = (minutes: number) => new Date(Date.parse(fixtureTime) + minutes * 60_000).toISOString();

const resumable: AcpAgentCapabilities = {
  protocolVersion: 1, loadSession: false, resumeSession: true,
  prompt: { image: false, audio: false, embeddedContext: false }, mcp: { http: true, sse: false }
};

const context = (delivered: HubToControlAgent[] = []): SchedulingContext => ({
  connection: () => ({ protocolVersion: "4", synced: true }),
  capabilityReport: () => undefined,
  projectProfile: () => undefined,
  canDeliver: (_nodeId, message) => {
    delivered.push(message);
    return true;
  }
});

async function pass(store: Store, at: string, delivered: HubToControlAgent[] = []) {
  let continuations = 0;
  await store.transact((state) => {
    const result = runContinuationPass(state, context(delivered), at);
    continuations = result.continuations.length;
    return result.changed;
  });
  return continuations;
}

const lifecycle = (store: Store, message: Parameters<typeof applyRunLifecycle>[1]) => store.transact((state) => applyRunLifecycle(state, message));
const continuationRuns = (store: Store) => store.read((state) => state.runs.filter((run) => run.id.startsWith("run_wake_")));
const inbox = (store: Store) => store.read((state) => structuredClone(state.orchestratorInboxes?.find((item) => item.threadId === "thread-one")));
const advertise = (store: Store, acp: AcpAgentCapabilities | undefined) => store.transact((state) => {
  const node = state.nodes.find((item) => item.id === "node-orchestrator")!;
  node.harnesses = [{ ...fixtureNode("node-orchestrator").harnesses[0], transports: ["native-cli", "acp-v1"], ...(acp ? { acp } : {}) }];
});

function message(id: string): TaskMessage {
  return {
    id, threadId: "thread-one", sender: { type: "task", taskId: "task-a" }, recipient: { type: "orchestrator" }, sequence: 1,
    kind: "question", body: `Question ${id}`, idempotencyKey: id, createdAt: fixtureTime
  };
}

/** An idle orchestrator with one unacknowledged question and an idle, resumable binding. */
async function idleWithBinding() {
  const store = await orchestrationStore();
  await advertise(store, resumable);
  await store.transact((state) => {
    applyRunLifecycle(state, { type: "run.completed", runId: rootRunId, output: "Delegated", at: fixtureTime });
    state.sessionBindings = [{
      id: "session-previous", threadId: "thread-one", agentId: "orchestrator", nodeId: "node-orchestrator", harnessId: "codex-cli",
      transport: "acp-v1", workspace: "/workspace/orchestrator", providerSessionId: "provider-previous", status: "idle",
      createdByRunId: rootRunId, lastRunId: rootRunId, capabilities: resumable, createdAt: fixtureTime, updatedAt: fixtureTime
    } satisfies HarnessSessionBinding];
    state.taskMessages = [message("taskmsg-one")];
  });
  return store;
}

test("a wait with a valid cursor but an invalid argument acknowledges nothing", async () => {
  const store = await orchestrationStore();
  await store.transact((state) => { state.taskMessages = [message("taskmsg-one")]; });
  const hub = fixtureHandler(store);
  const head = store.read((state) => state.taskEventStreams!.find((stream) => stream.threadId === "thread-one")!.head);
  const cursor = encodeTaskEventCursor("thread-one", "orchestrator", head);
  for (const invalid of [
    { cursor, timeoutMilliseconds: -1 },
    { cursor, maximumEvents: 0 },
    { cursor, acknowledgeMessageIds: ["taskmsg-unknown"] },
    { cursor, unexpected: true }
  ]) {
    await assert.rejects(hub.call("wait_for_task_events", rootRunId, invalid), JSON.stringify(invalid));
    assert.equal(inbox(store)?.processedThrough ?? 0, 0, JSON.stringify(invalid));
  }
  await hub.call("wait_for_task_events", rootRunId, { cursor, timeoutMilliseconds: 0 });
  assert.equal(inbox(store)?.processedThrough, head, "the same cursor acknowledges once the call is valid");
});

test("session bindings stay bounded across many completed ACP task attempts and orchestrator turns", async () => {
  const store = await orchestrationStore();
  const attempts = retainedTerminalSessionBindings + 100;
  await store.transact((state) => {
    for (let index = 0; index < attempts; index += 1) {
      const taskId = `task-${index}`;
      const task: Task = {
        id: taskId, threadId: "thread-one", title: taskId, instructions: taskId, status: "ready", requirements: {}, dependencies: [],
        sourceRunId: rootRunId, idempotencyKey: taskId, attemptRunIds: [], createdAt: fixtureTime, updatedAt: fixtureTime
      };
      state.tasks = [...(state.tasks ?? []), task];
      const run: Run = fixtureRun(`run-attempt-${index}`, "thread-one", "worker-a", {
        status: "queued", startedAt: undefined, transport: "acp-v1", dispatchedAt: fixtureTime, depth: 1, parentRunId: rootRunId
      });
      assignTaskAttempt(state, taskId, run, fixtureTime);
      assert.equal(acceptSessionBinding(state, "node-worker-a", run.id, {
        providerSessionId: `provider-attempt-${index}`, harnessId: "codex-cli", transport: "acp-v1", status: "active"
      }, fixtureTime).kind, "created");
      applyRunLifecycle(state, { type: "run.started", runId: run.id, at: fixtureTime, transport: { requestedTransport: "acp-v1", selectedTransport: "acp-v1", acp: resumable } });
      applyRunLifecycle(state, { type: "run.completed", runId: run.id, output: "Done", at: fixtureTime });
    }
    for (let index = 0; index < 5; index += 1) {
      const run: Run = fixtureRun(`run-owner-${index}`, "thread-one", "orchestrator", { status: "queued", startedAt: undefined, transport: "acp-v1", dispatchedAt: fixtureTime });
      state.runs.unshift(run);
      acceptSessionBinding(state, "node-orchestrator", run.id, { providerSessionId: `provider-owner-${index}`, harnessId: "codex-cli", transport: "acp-v1", status: "active" }, later(index));
      applyRunLifecycle(state, { type: "run.started", runId: run.id, at: later(index), transport: { requestedTransport: "acp-v1", selectedTransport: "acp-v1", acp: resumable } });
      applyRunLifecycle(state, { type: "run.completed", runId: run.id, output: "Done", at: later(index) });
    }
  });
  const bindings = store.read((state) => structuredClone(state.sessionBindings ?? []));
  assert.ok(bindings.length <= retainedTerminalSessionBindings + 1, `${bindings.length} bindings retained`);
  assert.equal(bindings.filter((binding) => binding.agentId === "worker-a" && binding.status !== "closed").length, 0, "task attempt sessions close with their run");
  const idle = bindings.filter((binding) => binding.status === "idle");
  assert.deepEqual(idle.map((binding) => binding.providerSessionId), ["provider-owner-4"], "only the latest orchestrator session stays resumable");
});

test("a node that stops advertising resume gets a new session and the binding stays idle", async () => {
  const store = await idleWithBinding();
  const created: HubToControlAgent[] = [];
  assert.equal(await pass(store, later(1), created), 1);
  const [run] = continuationRuns(store);
  assert.equal(run.sessionBindingId, "session-previous");

  await advertise(store, undefined);
  const redispatch = store.read((state) => dispatchMessageFor(run, state.agents.find((agent) => agent.id === "orchestrator")!, state.agents, state.workspaceLeases, state));
  assert.equal(redispatch.execution?.sessionBinding, undefined, "the redispatch no longer asks to resume");
  assert.equal("sessionBindingId" in redispatch.run, false);
  assert.match(redispatch.run.prompt, /durable thread context/, "the new session receives bounded durable context");
  assert.equal(store.read((state) => state.sessionBindings![0].status), "idle");
});

test("a dispatch Barista refuses only for resume is retried at once without the binding", async () => {
  const store = await idleWithBinding();
  await pass(store, later(1));
  const [first] = continuationRuns(store);
  await lifecycle(store, { type: "run.failed", runId: first.id, error: sessionResumeUnavailableReason, at: later(2) });
  assert.equal(store.read((state) => state.sessionBindings![0].status), "idle", "the refusal does not fail the session");

  assert.equal(await pass(store, later(2)), 1, "no backoff applies");
  const refused = inbox(store)!.wakes.find((wake) => wake.runId === first.id)!;
  assert.equal(refused.resumeRefused, true);
  assert.equal(inbox(store)!.consecutiveFailures, 0);
  const retry = continuationRuns(store).find((run) => run.id !== first.id)!;
  assert.equal(retry.sessionBindingId, undefined, "the retry starts a new session with durable context");
  assert.equal(retry.prompt.includes("taskmsg-one"), true);
});
