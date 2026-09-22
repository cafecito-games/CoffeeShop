import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertPersistedHarnessState, newEvent, Store, type State } from "./store.js";

test("starts empty, persists state atomically, and loads it again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-store-"));
  const path = join(directory, "state.json");
  const first = new Store(path);
  await first.load();
  assert.deepEqual(first.snapshot().agents, []);
  assert.deepEqual(first.snapshot().nodes, []);
  assert.deepEqual(first.snapshot().runs, []);
  assert.deepEqual(first.snapshot().events, []);
  assert.deepEqual(first.snapshot().messages, []);
  assert.deepEqual(first.snapshot().threads, []);

  await first.transact((state) => {
    state.events.push(newEvent({ type: "status", title: "Saved event", detail: "Persistence check" }));
  });
  assert.equal(JSON.parse(await readFile(path, "utf8")).events[0].title, "Saved event");
  const second = new Store(path);
  await second.load();
  assert.equal(second.snapshot().events[0].title, "Saved event");
});

test("removes legacy demo records without removing user-created data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-store-"));
  const path = join(directory, "state.json");
  await writeFile(path, JSON.stringify({
    agents: [
      { id: "cpp-steward", name: "Ada", computeNodeId: "home-linux" },
      { id: "claude-scout", name: "Claude Scout", computeNodeId: "local-macbook" }
    ],
    nodes: [
      { id: "local-macbook", name: "This laptop", workspaceRoots: ["/Users/christian/Projects"] },
      { id: "home-linux", name: "Home server", workspaceRoots: ["/srv/workspaces"] },
      { id: "cloud-runner", name: "Cloud runner", workspaceRoots: ["/workspace"] }
    ],
    runs: [
      { id: "run-benchmark", agentId: "cpp-steward", nodeId: "home-linux" },
      { id: "real-run", agentId: "claude-scout", nodeId: "local-macbook" }
    ],
    events: [
      { id: "evt-1", agentId: "cpp-steward", runId: "run-benchmark" },
      { id: "real-event", agentId: "claude-scout", runId: "real-run" }
    ],
    messages: [
      { id: "msg-1", agentId: "cpp-steward", runId: "run-benchmark" },
      { id: "real-message", agentId: "claude-scout", runId: "real-run" }
    ]
  }));

  const store = new Store(path);
  await store.load();
  const snapshot = store.snapshot();
  assert.deepEqual(snapshot.agents.map((agent) => agent.id), ["claude-scout"]);
  assert.equal(snapshot.agents[0].avatarShape, "cup");
  assert.equal(snapshot.agents[0].avatarColor, "amber");
  assert.deepEqual(snapshot.nodes.map((node) => node.id), ["local-macbook"]);
  assert.deepEqual(snapshot.runs.map((run) => run.id), ["real-run"]);
  assert.deepEqual(snapshot.events.map((event) => event.id), ["real-event"]);
  assert.deepEqual(snapshot.messages.map((message) => message.id), ["real-message"]);
  assert.equal(snapshot.threads?.length, 1);
  assert.equal(snapshot.runs[0].threadId, snapshot.threads?.[0].id);
  assert.equal(snapshot.messages[0].threadId, snapshot.threads?.[0].id);
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.agents[0].id, "claude-scout");
  assert.equal(persisted.agents[0].avatarShape, "cup");
  assert.equal(persisted.agents[0].avatarColor, "amber");
});

test("serializes concurrent transactions without losing persistence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-store-"));
  const path = join(directory, "state.json");
  const store = new Store(path);
  await store.load();

  await Promise.all(Array.from({ length: 24 }, (_, index) => store.transact((state) => {
    state.events.push(newEvent({ type: "status", title: `Event ${index}`, detail: "Concurrent persistence check" }));
  })));

  const reloaded = new Store(path);
  await reloaded.load();
  assert.equal(reloaded.snapshot().events.length, 24);
});

test("stores artifact bytes outside the JSON snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-store-"));
  const path = join(directory, "state.json");
  const store = new Store(path);
  await store.load();
  await store.writeArtifactContent("artifact-safe-id", Buffer.from("artifact body"));
  assert.equal((await store.readArtifactContent("artifact-safe-id")).toString(), "artifact body");
  assert.doesNotMatch(await readFile(path, "utf8"), /artifact body/);
});

test("migrates an active legacy run into an active durable thread", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-store-"));
  const path = join(directory, "state.json");
  await writeFile(path, JSON.stringify({
    agents: [], nodes: [], events: [], messages: [],
    runs: [{ id: "run-active", agentId: "agent-one", prompt: "Continue active work", status: "queued", createdAt: "2026-01-01T00:00:00Z" }]
  }));
  const store = new Store(path);
  await store.load();
  assert.equal(store.snapshot().threads?.[0].status, "active");
  assert.equal(store.snapshot().runs[0].threadId, store.snapshot().threads?.[0].id);
});

test("backfills missing orchestration collections and persists them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-store-"));
  const path = join(directory, "state.json");
  await writeFile(path, JSON.stringify({
    agents: [], nodes: [], runs: [], events: [], messages: []
  }));

  const store = new Store(path);
  await store.load();
  const snapshot = store.snapshot();
  for (const collection of ["tasks", "taskMessages", "taskMessageAcknowledgements", "sessionBindings", "approvals", "workspaceLeases"] as const) {
    assert.deepEqual(snapshot[collection], [], `${collection} defaults to an empty array`);
  }
  const persisted = JSON.parse(await readFile(path, "utf8"));
  for (const collection of ["tasks", "taskMessages", "taskMessageAcknowledgements", "sessionBindings", "approvals", "workspaceLeases"] as const) {
    assert.deepEqual(persisted[collection], [], `${collection} is persisted as an empty array`);
  }
});

test("keeps orchestration collections that already hold records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-store-"));
  const path = join(directory, "state.json");
  await writeFile(path, JSON.stringify({
    agents: [], nodes: [], runs: [], events: [], messages: [],
    tasks: [{
      id: "task-one", threadId: "thread-one", title: "Task", instructions: "Do it", status: "pending", requirements: {},
      dependencies: [], idempotencyKey: "batch-one", attemptRunIds: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z"
    }]
  }));

  const store = new Store(path);
  await store.load();
  assert.deepEqual(store.snapshot().tasks?.map((task) => task.id), ["task-one"]);
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(persisted.tasks.map((task: { id: string }) => task.id), ["task-one"]);
});

test("omits task submissions from snapshots while persisting them on disk", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-store-"));
  const path = join(directory, "state.json");
  await writeFile(path, JSON.stringify({
    agents: [], nodes: [], runs: [], events: [], messages: []
  }));

  const store = new Store(path);
  await store.load();
  assert.deepEqual(store.snapshot().tasks, []);
  assert.ok(!("taskSubmissions" in store.snapshot()), "snapshots never publish task submissions");
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(persisted.taskSubmissions, []);
});

test("loads legacy runs with parentRunId without synthesizing tasks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-store-"));
  const path = join(directory, "state.json");
  await writeFile(path, JSON.stringify({
    agents: [], nodes: [], events: [], messages: [],
    runs: [
      { id: "run-parent", agentId: "agent-one", prompt: "Parent work", status: "completed", createdAt: "2026-01-01T00:00:00Z" },
      { id: "run-child", agentId: "agent-one", prompt: "Child work", status: "completed", parentRunId: "run-parent", createdAt: "2026-01-01T00:01:00Z" }
    ]
  }));

  const store = new Store(path);
  await store.load();
  assert.deepEqual(store.snapshot().tasks, []);
  assert.equal(store.snapshot().runs.length, 2);
});

test("rejects uninterpretable persisted task state without rewriting the file", async () => {
  const validTask = {
    id: "task-one", threadId: "thread-one", title: "Task", instructions: "Do it", status: "pending", requirements: {},
    dependencies: [], idempotencyKey: "batch-one", attemptRunIds: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z"
  };
  const validTaskWithoutStatus: Record<string, unknown> = { ...validTask };
  delete validTaskWithoutStatus.status;
  const cases: Array<{ label: string; state: Record<string, unknown> }> = [
    { label: "unknown task status", state: { tasks: [{ ...validTask, status: "queued" }] } },
    { label: "missing task status", state: { tasks: [validTaskWithoutStatus] } },
    { label: "unknown dependency policy", state: { tasks: [{ ...validTask, dependencies: [{ taskId: "task-missing", policy: "maybe" }] }] } },
    { label: "duplicated task id", state: { tasks: [validTask, { ...validTask, title: "Second task" }] } },
    { label: "malformed task submission", state: { tasks: [validTask], taskSubmissions: [{ id: "tasksub-one" }] } }
  ];

  for (const [index, item] of cases.entries()) {
    const directory = await mkdtemp(join(tmpdir(), "coffee-shop-store-"));
    const path = join(directory, "state.json");
    const contents = JSON.stringify({
      agents: [], nodes: [], runs: [], events: [], messages: [],
      ...item.state
    });
    await writeFile(path, contents);
    const store = new Store(path);
    await assert.rejects(store.load(), Error, `case ${index}: ${item.label}`);
    assert.equal(await readFile(path, "utf8"), contents, item.label);
  }
});

test("assertPersistedHarnessState rejects uninterpretable approvals and event streams", () => {
  const persistedAt = "2026-01-01T00:00:00.000Z";
  const validApproval = {
    id: "approval-one", harnessApprovalId: "acp-approval-1", threadId: "thread-one", runId: "run-one",
    nodeId: "node-one", title: "Run tests", options: [], status: "pending", requestedAt: persistedAt
  };
  const validStream = {
    runId: "run-one", nodeId: "node-one", status: "open", lastSequence: 0, recentDigests: [],
    retainedEvents: 0, retainedBytes: 0, retentionTruncated: false, createdAt: persistedAt, updatedAt: persistedAt
  };
  const base = { agents: [], nodes: [], runs: [], events: [], messages: [] };
  const withState = (overrides: Record<string, unknown>): State => ({ ...base, ...overrides }) as State;
  const cases: Array<{ label: string; state: State }> = [
    { label: "unknown approval status", state: withState({ approvals: [{ ...validApproval, status: "queued" }] }) },
    { label: "unknown approval delivery status", state: withState({ approvals: [{ ...validApproval, delivery: { status: "mailed", attempts: 0, updatedAt: persistedAt } }] }) },
    { label: "approval missing harnessApprovalId", state: withState({ approvals: [{ ...validApproval, harnessApprovalId: "" }] }) },
    { label: "unknown stream status", state: withState({ approvals: [], harnessEventStreams: [{ ...validStream, status: "paused" }] }) }
  ];
  for (const item of cases) {
    assert.throws(() => assertPersistedHarnessState(item.state), Error, item.label);
  }
  assert.doesNotThrow(() => assertPersistedHarnessState(withState({ approvals: [validApproval], harnessEventStreams: [validStream] })));
});

test("loads a legacy state file without harness collections and backfills them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-store-"));
  const path = join(directory, "state.json");
  await writeFile(path, JSON.stringify({ agents: [], nodes: [], runs: [], events: [], messages: [] }));

  const store = new Store(path);
  await store.load();
  const persisted = JSON.parse(await readFile(path, "utf8"));
  for (const collection of ["runActivity", "harnessEventStreams", "harnessEvents"] as const) {
    assert.deepEqual(persisted[collection], [], `${collection} is backfilled on disk`);
  }
  store.read((state) => {
    assert.deepEqual(state.runActivity, []);
    assert.deepEqual(state.harnessEventStreams, []);
    assert.deepEqual(state.harnessEvents, []);
  });
});

test("snapshots publish run activity but never retained harness events", async () => {
  const harnessAt = "2026-09-21T12:00:00.000Z";
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-store-"));
  const store = new Store(join(directory, "state.json"));
  await store.load();
  await store.transact((state) => {
    state.runActivity!.push({
      runId: "run-one", nodeId: "node-one", threadId: "thread-one", streamStatus: "open", lastSequence: 1,
      acceptedEvents: 1, message: { text: "hello", truncatedBytes: 0 }, thought: { text: "", truncatedBytes: 0 },
      plan: [], toolCalls: [], diffs: [], terminals: [], warnings: [], unknownEvents: 0,
      omitted: { toolCalls: 0, diffs: 0, terminals: 0, warnings: 0 }, summary: "hello", updatedAt: harnessAt
    });
    state.harnessEventStreams!.push({
      runId: "run-one", nodeId: "node-one", status: "open", lastSequence: 1, recentDigests: [],
      retainedEvents: 1, retainedBytes: 48, retentionTruncated: false, createdAt: harnessAt, updatedAt: harnessAt
    });
    state.harnessEvents!.push({
      runId: "run-one", sequence: 1, receivedAt: harnessAt, event: { type: "message.delta", runId: "run-one", sequence: 1, at: harnessAt, text: "hello" }
    });
  });
  const snapshot = store.snapshot();
  assert.deepEqual(snapshot.runActivity?.map((activity) => activity.runId), ["run-one"]);
  assert.ok(!("harnessEventStreams" in snapshot), "snapshots never publish event streams");
  assert.ok(!("harnessEvents" in snapshot), "snapshots never publish retained events");
});
