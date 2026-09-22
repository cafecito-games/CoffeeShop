import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  orchestrationToolLimits,
  orchestratorClientErrorCodes,
  orchestratorClientProtocolVersion,
  orchestratorClientSourceKey,
  recordSourceKey,
  runSourceKey,
  validateOrchestratorClientMessage,
  validateOrchestratorHubMessage,
  type ExternalOrchestratorToolName,
  type OrchestratorClientToHub,
  type OrchestratorHubToClient
} from "@coffee-shop/protocol";
import { CoordinationError } from "./coordinationError.js";
import { fixtureAgent, fixtureNode, fixtureRun, fixtureThread, fixtureTime } from "./hubToolsTestSupport.js";
import { encodeTaskEventCursor, TaskEventWaiters } from "./mailbox.js";
import {
  createOrchestratorClientGateway,
  externalOrchestratorErrorFor,
  parseThreadEventsRequest,
  servedExternalOrchestratorTools,
  type OrchestratorClientGateway
} from "./orchestratorClientGateway.js";
import { mintOrchestratorClient, revokeOrchestratorClient } from "./orchestratorClients.js";
import { inboxFor } from "./orchestratorInbox.js";
import { Store } from "./store.js";

/*
 * External orchestrator tool routing.
 *
 * Every frame below is built as a real `OrchestratorClientToHub` and validated by the protocol
 * before it reaches the hub, so nothing here exercises a shape the bridge could not send. The same
 * scenarios are driven as a hub-hosted run wherever both principals can reach the handler, because
 * the point of this route is that one implementation serves both.
 */

const at = "2026-09-22T12:00:00.000Z";

function frame(message: OrchestratorClientToHub) {
  const validated = validateOrchestratorClientMessage(message);
  assert.equal(validated.ok, true, validated.ok ? "" : validated.reason);
  return JSON.stringify(message);
}

class FakeTransport {
  readonly frames: OrchestratorHubToClient[] = [];

  send(payload: string) {
    const validated = validateOrchestratorHubMessage(JSON.parse(payload));
    assert.equal(validated.ok, true, validated.ok ? "" : validated.reason);
    if (validated.ok) this.frames.push(validated.value);
  }

  close() {}

  responseTo(requestId: string) {
    const response = this.frames.find((message) => message.type === "rpc.response" && message.requestId === requestId);
    assert.ok(response, `no response for ${requestId}`);
    return response as Extract<OrchestratorHubToClient, { type: "rpc.response" }>;
  }
}

interface Harness {
  store: Store;
  gateway: OrchestratorClientGateway;
  clientId: string;
  secret: string;
  schedulingPasses: { count: number };
}

async function harness(): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-external-tools-"));
  const store = new Store(join(directory, "state.json"));
  await store.load();
  let secret = "";
  let clientId = "";
  await store.transact((state) => {
    const minted = mintOrchestratorClient(state, { name: "Christian's laptop", scopes: ["orchestrate"] }, at);
    secret = minted.secret;
    clientId = minted.client.id;
    state.agents = [fixtureAgent("worker-a", false, { skills: ["go"] }), fixtureAgent("worker-b", false)];
    state.nodes = state.agents.map((agent) => fixtureNode(agent.computeNodeId));
  });
  const schedulingPasses = { count: 0 };
  const gateway = createOrchestratorClientGateway({
    store,
    broadcast: () => undefined,
    now: () => new Date().toISOString(),
    waiters: new TaskEventWaiters(store),
    schedule: async () => { schedulingPasses.count += 1; }
  });
  return { store, gateway, clientId, secret, schedulingPasses };
}

interface Connected {
  transport: FakeTransport;
  connection: { receive(raw: string): Promise<void>; closed(): Promise<void> };
  connectionId: string;
}

async function connect(context: Harness): Promise<Connected> {
  const transport = new FakeTransport();
  const connection = context.gateway.accept(transport);
  await connection.receive(frame({ type: "client.hello", protocolVersion: orchestratorClientProtocolVersion, clientId: context.clientId, secret: context.secret }));
  const welcome = transport.frames.find((message) => message.type === "client.welcome");
  assert.ok(welcome && welcome.type === "client.welcome", "the hub welcomed the connection");
  return { transport, connection, connectionId: welcome.connectionId };
}

let requestCounter = 0;
async function call(peer: Connected, tool: ExternalOrchestratorToolName, argumentsValue: Record<string, unknown> = {}) {
  const requestId = `request-${requestCounter += 1}`;
  await peer.connection.receive(frame({ type: "rpc.request", requestId, tool, arguments: argumentsValue }));
  return peer.transport.responseTo(requestId);
}

const resultOf = (response: Extract<OrchestratorHubToClient, { type: "rpc.response" }>) => {
  assert.ok(!("error" in response), `unexpected error ${JSON.stringify((response as { error?: unknown }).error)}`);
  return (response as { result: any }).result;
};

const errorOf = (response: Extract<OrchestratorHubToClient, { type: "rpc.response" }>) => {
  assert.ok("error" in response, `expected an error, got ${JSON.stringify(response)}`);
  return (response as { error: { code: string; message: string } }).error;
};

/** A welcomed connection holding a freshly created thread. */
async function attached(context: Harness) {
  const peer = await connect(context);
  const created = resultOf(await call(peer, "create_thread", { objective: "Ship the auth refactor" }));
  return { peer, threadId: created.thread.id as string };
}

const oneTask = (key: string, title = "Write the migration") => ({ key, title, instructions: `${title} carefully` });

test("an external orchestrator submits tasks into its own thread", async () => {
  const context = await harness();
  const { peer, threadId } = await attached(context);

  const result = resultOf(await call(peer, "submit_tasks", { threadId, idempotencyKey: "batch-1", tasks: [oneTask("one"), oneTask("two", "Review the migration")] }));

  assert.equal(result.created, true);
  assert.equal(result.tasks.length, 2);
  assert.equal(context.schedulingPasses.count, 1, "a submission asks for a scheduling pass");
  context.store.read((state) => {
    const tasks = state.tasks!.filter((task) => task.threadId === threadId);
    assert.equal(tasks.length, 2);
    for (const task of tasks) {
      assert.equal(task.sourceRunId, undefined, "an external submission names no run");
      assert.equal(task.sourceKey, orchestratorClientSourceKey(context.clientId));
      assert.equal(recordSourceKey(task), orchestratorClientSourceKey(context.clientId));
    }
    const submission = state.taskSubmissions!.find((item) => item.threadId === threadId)!;
    assert.equal(submission.sourceKey, orchestratorClientSourceKey(context.clientId));
    assert.equal(submission.sourceRunId, undefined);
    assert.equal(submission.creatorAgentId, undefined);
  });
});

test("a replay from a new attachment of the same client returns the original submission", async () => {
  const context = await harness();
  const { peer, threadId } = await attached(context);
  const first = resultOf(await call(peer, "submit_tasks", { threadId, idempotencyKey: "batch-1", tasks: [oneTask("one")] }));

  // The bridge reconnects: a new socket, a new connection id, and a new attachment on the thread.
  await peer.connection.closed();
  const reconnected = await connect(context);
  resultOf(await call(reconnected, "attach_thread", { threadId }));
  const replay = resultOf(await call(reconnected, "submit_tasks", { threadId, idempotencyKey: "batch-1", tasks: [oneTask("one")] }));

  assert.equal(replay.created, false, "the retry replays rather than duplicating");
  assert.deepEqual(replay.taskIdsByKey, first.taskIdsByKey);
  assert.equal(context.store.snapshot().tasks!.filter((task) => task.threadId === threadId).length, 1);
});

test("the same key with different work is a conflict", async () => {
  const context = await harness();
  const { peer, threadId } = await attached(context);
  resultOf(await call(peer, "submit_tasks", { threadId, idempotencyKey: "batch-1", tasks: [oneTask("one")] }));

  const error = errorOf(await call(peer, "submit_tasks", { threadId, idempotencyKey: "batch-1", tasks: [oneTask("one", "Something else")] }));

  assert.equal(error.code, "conflict");
});

test("every orchestration tool answers a thread this connection does not hold identically", async () => {
  const context = await harness();
  const { peer } = await attached(context);
  const other = await harness();
  const foreign = await attached(other);
  // A thread of another credential, a thread that never existed, and a thread this connection
  // released must be indistinguishable from each other.
  const released = await attached(context);
  resultOf(await call(released.peer, "detach_thread", { threadId: released.threadId }));

  const tools: Array<[ExternalOrchestratorToolName, Record<string, unknown>]> = [
    ["get_thread_context", {}],
    ["get_thread_events", {}],
    ["submit_tasks", { idempotencyKey: "batch-1", tasks: [oneTask("one")] }],
    ["update_task", { idempotencyKey: "update-1", progress: "halfway" }],
    ["send_task_message", { idempotencyKey: "message-1", recipient: { type: "task", taskId: "task-absent" }, kind: "note", body: "hello" }],
    ["update_thread", { title: "Renamed" }]
  ];
  const answers = new Set<string>();
  for (const [tool, argumentsValue] of tools) {
    for (const threadId of [foreign.threadId, "thread-that-never-existed", released.threadId]) {
      const error = errorOf(await call(peer, tool, { threadId, ...argumentsValue }));
      assert.equal(error.code, "not_attached", `${tool} on ${threadId}`);
      answers.add(JSON.stringify(error));
    }
  }
  assert.equal(answers.size, 1, "every refusal is the same answer, so nothing leaks which thread exists");
});

test("a replaced attachment can no longer change its former thread", async () => {
  const context = await harness();
  const { peer, threadId } = await attached(context);
  const replacement = await connect(context);
  resultOf(await call(replacement, "attach_thread", { threadId }));

  for (const [tool, argumentsValue] of [
    ["submit_tasks", { idempotencyKey: "batch-1", tasks: [oneTask("one")] }],
    ["update_thread", { title: "Renamed by the replaced session" }]
  ] as Array<[ExternalOrchestratorToolName, Record<string, unknown>]>) {
    assert.equal(errorOf(await call(peer, tool, { threadId, ...argumentsValue })).code, "not_attached", tool);
  }
  context.store.read((state) => {
    assert.equal(state.tasks?.filter((task) => task.threadId === threadId).length ?? 0, 0, "no mutation landed");
    assert.notEqual(state.threads!.find((thread) => thread.id === threadId)!.title, "Renamed by the replaced session");
  });
  assert.equal(resultOf(await call(replacement, "submit_tasks", { threadId, idempotencyKey: "batch-1", tasks: [oneTask("one")] })).created, true);
});

test("a revoked credential stops being able to act even on a thread it still names", async () => {
  const context = await harness();
  const { peer, threadId } = await attached(context);
  await context.store.transact((state) => { revokeOrchestratorClient(state, context.clientId, at); });

  const error = errorOf(await call(peer, "submit_tasks", { threadId, idempotencyKey: "batch-1", tasks: [oneTask("one")] }));

  assert.equal(error.code, "revoked", "the dispatcher refuses before a handler is reached");
});

test("a credential narrowed to approvals only can no longer orchestrate", async () => {
  const context = await harness();
  const { peer, threadId } = await attached(context);
  // Scopes are read from committed state on every call, never cached from the welcome.
  await context.store.transact((state) => {
    state.orchestratorClients!.find((client) => client.id === context.clientId)!.scopes = ["resolve-approvals"];
  });

  assert.equal(errorOf(await call(peer, "submit_tasks", { threadId, idempotencyKey: "batch-1", tasks: [oneTask("one")] })).code, "forbidden");
});

test("update_task stays assignee-only for an external orchestrator", async () => {
  const context = await harness();
  const { peer, threadId } = await attached(context);
  const submitted = resultOf(await call(peer, "submit_tasks", { threadId, idempotencyKey: "batch-1", tasks: [oneTask("one")] }));

  const error = errorOf(await call(peer, "update_task", { threadId, taskId: submitted.taskIdsByKey.one, idempotencyKey: "update-1", progress: "halfway" }));

  assert.equal(error.code, "forbidden");
  assert.equal(context.store.read((state) => state.taskUpdates?.length ?? 0), 0);
});

test("an external orchestrator messages a task in its thread and replays across a reattach", async () => {
  const context = await harness();
  const { peer, threadId } = await attached(context);
  const submitted = resultOf(await call(peer, "submit_tasks", { threadId, idempotencyKey: "batch-1", tasks: [oneTask("one")] }));
  const taskId = submitted.taskIdsByKey.one as string;
  const message = { idempotencyKey: "message-1", recipient: { type: "task", taskId }, kind: "instruction", body: "Start with the schema" };

  const sent = resultOf(await call(peer, "send_task_message", { threadId, ...message }));
  await peer.connection.closed();
  const reconnected = await connect(context);
  resultOf(await call(reconnected, "attach_thread", { threadId }));
  const replay = resultOf(await call(reconnected, "send_task_message", { threadId, ...message }));

  assert.equal(sent.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.messageId, sent.messageId);
  context.store.read((state) => {
    const stored = state.taskMessages!.find((item) => item.id === sent.messageId)!;
    assert.deepEqual(stored.sender, { type: "orchestrator" });
    assert.equal(stored.sourceRunId, undefined);
    assert.equal(stored.sourceKey, orchestratorClientSourceKey(context.clientId));
  });
});

test("get_thread_context reports the durable context, the task graph, approvals, and a cursor", async () => {
  const context = await harness();
  const { peer, threadId } = await attached(context);
  const submitted = resultOf(await call(peer, "submit_tasks", { threadId, idempotencyKey: "batch-1", tasks: [oneTask("one")] }));
  await context.store.transact((state) => {
    state.runs.push(fixtureRun("run-attempt", threadId, "worker-a"));
    (state.approvals ??= []).push({
      id: "approval-1", harnessApprovalId: "harness-1", threadId, runId: "run-attempt", nodeId: "node-worker-a",
      title: "Run the migration", options: [{ id: "allow", label: "Allow", kind: "allow-once" }], status: "pending", requestedAt: fixtureTime
    });
  });

  const result = resultOf(await call(peer, "get_thread_context", { threadId }));

  assert.equal(result.thread.id, threadId);
  assert.match(result.context, /durable thread context/);
  assert.deepEqual(result.tasks.map((task: { id: string }) => task.id), [submitted.taskIdsByKey.one]);
  assert.equal(result.tasksTruncated, false);
  assert.deepEqual(result.approvals.map((approval: { id: string }) => approval.id), ["approval-1"]);
  assert.equal(result.approvalsTruncated, false);
  assert.match(result.cursor, /^tev1\./);
  assert.ok(!("channels" in result), "the bridge owns the channels field");
  assert.ok(!JSON.stringify(result).includes("secret prompt"), "no agent system prompt reaches an orchestrator");
});

test("get_thread_context refuses arguments it does not interpret", async () => {
  const context = await harness();
  const { peer, threadId } = await attached(context);

  assert.equal(errorOf(await call(peer, "get_thread_context", { threadId, taskId: "task-one" })).code, "invalid_arguments");
});

test("get_thread_events returns the thread's orchestrator events and acknowledges a cursor", async () => {
  const context = await harness();
  const { peer, threadId } = await attached(context);
  const submitted = resultOf(await call(peer, "submit_tasks", { threadId, idempotencyKey: "batch-1", tasks: [oneTask("one")] }));
  const taskId = submitted.taskIdsByKey.one as string;
  await context.store.transact((state) => {
    const task = state.tasks!.find((item) => item.id === taskId)!;
    task.status = "cancelled";
    task.finishedAt = fixtureTime;
  });

  const first = resultOf(await call(peer, "get_thread_events", { threadId }));
  assert.ok(first.events.length >= 1, "a terminal task reaches the orchestrator");
  assert.equal(context.store.read((state) => inboxFor(state, threadId)?.processedThrough ?? 0), 0, "reading alone acknowledges nothing");

  const second = resultOf(await call(peer, "get_thread_events", { threadId, cursor: first.cursor }));

  assert.deepEqual(second.events, [], "everything up to the cursor was consumed");
  assert.ok(context.store.read((state) => inboxFor(state, threadId)!.processedThrough) > 0, "the cursor advanced the inbox");
});

test("a cursor the caller was not issued leaves the acknowledged position unchanged", async () => {
  const context = await harness();
  const { peer, threadId } = await attached(context);
  const otherThread = await attached(context);
  const foreignCursor = resultOf(await call(otherThread.peer, "get_thread_context", { threadId: otherThread.threadId })).cursor;

  for (const cursor of [foreignCursor, "not-a-cursor", "tev1.abc.def"]) {
    const error = errorOf(await call(peer, "get_thread_events", { threadId, cursor }));
    assert.equal(error.code, "invalid_arguments", cursor);
  }
  assert.equal(context.store.read((state) => inboxFor(state, threadId)?.processedThrough ?? 0), 0);
});

test("a well-formed cursor ahead of the journal is refused", async () => {
  const context = await harness();
  const { peer, threadId } = await attached(context);
  // Correctly checksummed for this thread and scope, but naming a sequence the hub never issued.
  const ahead = encodeTaskEventCursor(threadId, "orchestrator", 500);

  const error = errorOf(await call(peer, "get_thread_events", { threadId, cursor: ahead }));

  assert.equal(error.code, "invalid_arguments");
  assert.equal(context.store.read((state) => inboxFor(state, threadId)?.processedThrough ?? 0), 0);
});

test("a cursor issued to another participant of the same thread is refused", async () => {
  const context = await harness();
  const { peer, threadId } = await attached(context);

  const error = errorOf(await call(peer, "get_thread_events", { threadId, cursor: encodeTaskEventCursor(threadId, "task:task-one", 0) }));

  assert.equal(error.code, "invalid_arguments");
  assert.equal(context.store.read((state) => inboxFor(state, threadId)?.processedThrough ?? 0), 0);
});

test("get_thread_events caps the wait it is asked to hold", async () => {
  assert.deepEqual(parseThreadEventsRequest({}), { ok: true, value: { waitMilliseconds: 0 } });
  assert.deepEqual(parseThreadEventsRequest({ waitMilliseconds: 10 }), { ok: true, value: { waitMilliseconds: 10 } });
  assert.deepEqual(
    parseThreadEventsRequest({ waitMilliseconds: 10 * orchestrationToolLimits.maximumWaitMilliseconds }),
    { ok: true, value: { waitMilliseconds: orchestrationToolLimits.maximumWaitMilliseconds } }
  );
  for (const invalid of [{ waitMilliseconds: -1 }, { waitMilliseconds: 1.5 }, { waitMilliseconds: "10" }, { cursor: "" }, { unknown: 1 }]) {
    assert.equal(parseThreadEventsRequest(invalid).ok, false, JSON.stringify(invalid));
  }
});

test("update_thread changes the fields an orchestrator owns and never archives", async () => {
  const context = await harness();
  const { peer, threadId } = await attached(context);

  const result = resultOf(await call(peer, "update_thread", { threadId, title: "Auth refactor", summary: "Two tasks left" }));
  assert.equal(result.thread.title, "Auth refactor");
  assert.equal(result.thread.summary, "Two tasks left");

  assert.equal(errorOf(await call(peer, "update_thread", { threadId, status: "archived" })).code, "forbidden");
  assert.equal(errorOf(await call(peer, "update_thread", { threadId })).code, "invalid_arguments");
  assert.equal(resultOf(await call(peer, "update_thread", { threadId, status: "completed" })).thread.status, "completed");
});

test("get_execution_inventory serves an attached orchestrator with or without a thread", async () => {
  const context = await harness();
  const { peer, threadId } = await attached(context);

  for (const argumentsValue of [{}, { threadId }]) {
    const result = resultOf(await call(peer, "get_execution_inventory", argumentsValue));
    assert.deepEqual(result.agents.map((agent: { id: string }) => agent.id), ["worker-a", "worker-b"]);
    assert.ok(result.agents.every((agent: { self: boolean }) => agent.self === false), "an external orchestrator is not one of the agents");
    assert.deepEqual(result.nodes.map((node: { id: string }) => node.id), ["node-worker-a", "node-worker-b"]);
    assert.ok(!JSON.stringify(result).includes("secret prompt"));
  }
  assert.equal(errorOf(await call(peer, "get_execution_inventory", { threadId: "thread-that-never-existed" })).code, "not_attached");
  assert.equal(errorOf(await call(peer, "get_execution_inventory", { unknown: true })).code, "invalid_arguments");
});

test("a connection holding no attachment cannot read the inventory", async () => {
  const context = await harness();
  const peer = await connect(context);

  assert.equal(errorOf(await call(peer, "get_execution_inventory", {})).code, "not_attached");
});

test("every tool the hub serves is reachable with a well-formed call", async () => {
  const context = await harness();
  const { peer, threadId } = await attached(context);
  const submitted = resultOf(await call(peer, "submit_tasks", { threadId, idempotencyKey: "batch-0", tasks: [oneTask("seed")] }));
  const taskId = submitted.taskIdsByKey.seed as string;
  // `detach_thread` is called last: once it runs, every thread-scoped tool answers `not_attached`.
  const calls: Array<[ExternalOrchestratorToolName, Record<string, unknown>]> = [
    ["create_thread", { objective: "Another thread" }],
    ["list_threads", {}],
    ["attach_thread", { threadId }],
    ["get_thread_context", { threadId }],
    ["get_thread_events", { threadId }],
    ["get_execution_inventory", {}],
    ["submit_tasks", { threadId, idempotencyKey: "batch-1", tasks: [oneTask("one")] }],
    ["send_task_message", { threadId, idempotencyKey: "message-1", recipient: { type: "task", taskId }, kind: "note", body: "hello" }],
    ["update_task", { threadId, taskId, idempotencyKey: "update-1", progress: "halfway" }],
    ["update_thread", { threadId, title: "Renamed" }],
    ["detach_thread", { threadId }]
  ];
  assert.deepEqual([...calls.map(([tool]) => tool)].sort(), [...servedExternalOrchestratorTools].sort(), "every served tool is exercised");

  for (const [tool, argumentsValue] of calls) {
    const response = await call(peer, tool, argumentsValue);
    if (!("error" in response)) continue;
    assert.equal(response.error.code, tool === "update_task" ? "forbidden" : "", `${tool}: ${response.error.message}`);
  }
  for (const tool of ["list_approvals", "resolve_approval"] as ExternalOrchestratorToolName[]) {
    assert.equal(errorOf(await call(peer, tool, { threadId })).code, "forbidden", `${tool} needs another scope`);
  }
});

test("every hub tool failure maps to a code the protocol declares", async () => {
  const codes = [
    "not_attached", "forbidden", "not_found", "idempotency_conflict", "duplicate_task_key", "thread_in_use",
    "persistence_failed", "inconsistent_state", "internal_error", "run_not_active", "thread_inactive", "thread_archived",
    "cursor_invalid", "cursor_stale", "invalid_arguments", "invalid_artifact", "invalid_target", "invalid_transition",
    "batch_too_large", "dependency_cycle", "unknown_dependency", "depth_limit", "fanout_limit", "mailbox_full",
    "update_limit", "task_not_ready", "invalid_attempt", "invalid_target", "a_code_this_hub_has_never_raised"
  ];
  for (const code of codes) {
    const mapped = externalOrchestratorErrorFor(new CoordinationError(code, "why"));
    assert.ok((orchestratorClientErrorCodes as readonly string[]).includes(mapped.code), `${code} -> ${mapped.code}`);
    assert.equal(mapped.message, "why");
  }
  // A refusal the caller cannot fix by editing its arguments is never reported as an argument error.
  for (const code of ["thread_inactive", "thread_archived", "thread_in_use", "task_not_ready", "invalid_transition", "mailbox_full", "update_limit", "idempotency_conflict"]) {
    assert.equal(externalOrchestratorErrorFor(new CoordinationError(code, "why")).code, "conflict", code);
  }
  // A malformed batch the caller can fix by editing its own arguments is never reported as a conflict.
  assert.equal(externalOrchestratorErrorFor(new CoordinationError("duplicate_task_key", "why")).code, "invalid_arguments", "duplicate_task_key");
  const unexpected = externalOrchestratorErrorFor(new Error("a stack trace nobody should see"));
  assert.deepEqual(unexpected, { code: "hub_unavailable", message: "The hub could not complete this call" });
});

test("a hub-hosted orchestrator run keeps naming its run, not a source key", async () => {
  const context = await harness();
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-run-principal-"));
  const store = new Store(join(directory, "state.json"));
  await store.load();
  await store.transact((state) => {
    state.agents = [fixtureAgent("orchestrator", true), fixtureAgent("worker-a", false)];
    state.nodes = state.agents.map((agent) => fixtureNode(agent.computeNodeId));
    state.threads = [fixtureThread("thread-one")];
    state.runs = [fixtureRun("run-root", "thread-one", "orchestrator")];
  });
  const { submitTasks } = await import("./coordination.js");

  await submitTasks(store, "run-root", { idempotencyKey: "batch-1", tasks: [oneTask("one")] });

  store.read((state) => {
    const task = state.tasks![0];
    assert.equal(task.sourceRunId, "run-root", "the run principal keeps writing its run id");
    assert.equal(task.sourceKey, undefined, "and writes no redundant source key");
    assert.equal(recordSourceKey(task), runSourceKey("run-root"));
    assert.equal(state.taskSubmissions![0].creatorAgentId, "orchestrator");
  });
  assert.equal(context.clientId.includes(":"), false, "a client id never collides with a run source key");
});
