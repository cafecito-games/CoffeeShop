import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { recordSourceKey, runSourceKey, threadOrchestrator, threadOwnerAgentId } from "@coffee-shop/protocol";
import { submitTasks, updateTask } from "./coordination.js";
import { sendTaskMessage } from "./mailbox.js";
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

test("persists production state in SQLite and imports a legacy JSON snapshot once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-sqlite-store-"));
  const legacyPath = join(directory, "state.json");
  const databasePath = join(directory, "coffee-shop.sqlite");
  await writeFile(legacyPath, JSON.stringify({
    agents: [], nodes: [], runs: [], events: [], messages: [],
    projectProfiles: [{
      schemaVersion: 1,
      id: "uzir",
      name: "Uzir",
      repository: { url: "https://github.com/cafecito-games/uzir", defaultBranch: "main" },
      workspacePolicy: { requireWritable: true, isolation: "git-worktree", cleanup: "when-unchanged" },
      requirements: { hard: {} }
    }]
  }));

  const first = new Store({ databasePath, legacyJsonPath: legacyPath });
  await first.load();
  assert.equal(first.snapshot().projectProfiles?.[0].id, "uzir");
  await first.transact((state) => {
    state.events.push(newEvent({ type: "status", title: "Stored in SQLite", detail: "Persistence check" }));
  });

  // A later change to the legacy file cannot replace state already committed to the database.
  await writeFile(legacyPath, JSON.stringify({ agents: [], nodes: [], runs: [], events: [], messages: [] }));
  const second = new Store({ databasePath, legacyJsonPath: legacyPath });
  await second.load();
  assert.equal(second.snapshot().events[0].title, "Stored in SQLite");
  assert.equal(second.snapshot().projectProfiles?.[0].id, "uzir");
  assert.match((await readFile(databasePath)).subarray(0, 16).toString(), /^SQLite format 3/);
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

/*
 * External orchestrator migration.
 *
 * `state-before-external-orchestrators.json` was written byte-for-byte by the store at
 * 733409151e28741f14769829d557c0a52d968a56 (`apps/hub/src/store.ts:416`, `private async save`),
 * from records built by that revision's `apps/hub/src/threads.ts:29` (`newThread`),
 * `apps/hub/src/approvals.ts:94` (`openApproval`), and `apps/hub/src/approvals.ts:312`
 * (`resolveApprovalInState`). It is the real shape on an operator's disk before this change.
 */
const fixturePath = fileURLToPath(new URL("../test-fixtures/state-before-external-orchestrators.json", import.meta.url));

async function loadFixture(mutate: (state: Record<string, any>) => void = () => undefined) {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-store-"));
  const path = join(directory, "state.json");
  const persisted = JSON.parse(await readFile(fixturePath, "utf8"));
  mutate(persisted);
  await writeFile(path, JSON.stringify(persisted, null, 2));
  const store = new Store(path);
  return { store, path };
}

test("loads a pre-external-orchestrator snapshot with empty orchestrator collections", async () => {
  const { store, path } = await loadFixture();
  await store.load();

  store.read((state) => {
    assert.deepEqual(state.orchestratorClients, [], "clients are never invented");
    assert.deepEqual(state.orchestratorAttachments, [], "attachments are never invented");
  });
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(persisted.orchestratorClients, []);
  assert.deepEqual(persisted.orchestratorAttachments, []);
});

test("derives a thread orchestrator from the persisted owner agent", async () => {
  const { store } = await loadFixture();
  await store.load();

  const thread = store.snapshot().threads![0];
  assert.deepEqual(thread.orchestrator, { kind: "agent", agentId: "orchestrator" });
  assert.equal(thread.ownerAgentId, "orchestrator", "the owner agent stays readable");
  assert.deepEqual(threadOrchestrator(thread), { kind: "agent", agentId: "orchestrator" });
  assert.equal(threadOwnerAgentId(thread), "orchestrator");
});

test("keeps a thread with neither orchestrator nor owner agent, and treats it as not agent-orchestrated", async () => {
  const { store } = await loadFixture((state) => {
    delete state.threads[0].ownerAgentId;
  });
  await store.load();

  const thread = store.snapshot().threads![0];
  assert.equal(thread.orchestrator, undefined, "no orchestrator is invented");
  assert.equal(thread.ownerAgentId, undefined);
  assert.equal(threadOrchestrator(thread), undefined);
  assert.equal(threadOwnerAgentId(thread), undefined);
});

test("migrates a persisted approval resolver string into its resolver union", async () => {
  for (const kind of ["operator", "policy", "system"] as const) {
    const { store } = await loadFixture((state) => {
      state.approvals[0].resolvedBy = kind;
    });
    await store.load();
    assert.deepEqual(store.snapshot().approvals![0].resolvedBy, { kind }, kind);
  }
});

test("rejects a persisted approval whose resolver the hub cannot interpret", async () => {
  for (const resolvedBy of ["orchestrator", "robot", 7, { kind: "robot" }, { kind: "orchestrator" }]) {
    const { store } = await loadFixture((state) => {
      state.approvals[0].resolvedBy = resolvedBy;
    });
    await assert.rejects(() => store.load(), /unknown resolver/, JSON.stringify(resolvedBy));
  }
});

test("rejects a persisted approval that is not an object, with a diagnosable reason", async () => {
  for (const approval of [null, "approval_one", 7, ["approval_one"]]) {
    const { store } = await loadFixture((state) => {
      state.approvals = [approval];
    });
    await assert.rejects(() => store.load(), /Persisted approval 0 is not an object/, JSON.stringify(approval ?? null));
  }
});

// The producer that writes every entry of this array is `apps/hub/src/threads.ts:29` (`newThread`).
test("rejects a persisted thread that is not an object, with a diagnosable reason", async () => {
  for (const thread of [null, "thread-one", 7, ["thread-one"]]) {
    const { store } = await loadFixture((state) => {
      state.threads = [thread];
    });
    await assert.rejects(() => store.load(), /Persisted thread 0 is not an object/, JSON.stringify(thread ?? null));
  }
});

test("keeps an already-migrated orchestrator resolution unchanged", async () => {
  const resolvedBy = { kind: "orchestrator", clientId: "client-one", attachmentId: "attachment-one" };
  const { store } = await loadFixture((state) => {
    state.approvals[0].resolvedBy = resolvedBy;
  });
  await store.load();
  assert.deepEqual(store.snapshot().approvals![0].resolvedBy, resolvedBy);
});

test("loads a pre-union approval resolution written by an older hub, byte for byte, as an operator resolution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-store-"));
  const path = join(directory, "state.json");
  const bytes = await readFile(fixturePath);
  assert.match(bytes.toString("utf8"), /"resolvedBy": "operator"/, "the fixture still carries the string an older hub wrote");
  await writeFile(path, bytes);
  const store = new Store(path);

  await store.load();

  assert.deepEqual(store.snapshot().approvals![0].resolvedBy, { kind: "operator" }, "an older resolution is attributed to the operator who made it");
  const rewritten = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(rewritten.approvals[0].resolvedBy, { kind: "operator" }, "the migration is persisted once");
  assert.equal(rewritten.approvals[0].resolutionIdempotencyKey, "operator-1", "nothing else about the resolution changes");
});

/*
 * `state-with-orchestrator-resolved-approval.json` was written byte-for-byte by
 * `apps/hub/src/store.ts:562` (`private async save`) from records built by the real producers in
 * this change: `apps/hub/src/orchestratorClients.ts:121` (`mintOrchestratorClient`),
 * `apps/hub/src/tasks.ts:558` (`assignTaskAttempt`), `apps/hub/src/approvals.ts:103`
 * (`openApproval`) reached through `apps/hub/src/harnessGateway.ts:42` (`receiveHarnessEvent`),
 * and a live `/orchestrator-client` connection driven through `client.hello`, `create_thread`,
 * `submit_tasks`, and `resolve_approval` by `apps/hub/src/orchestratorClientGateway.ts:226`
 * (`createOrchestratorClientGateway`), which records the resolution through
 * `apps/hub/src/approvals.ts:487` (`resolveApprovalForOrchestrator`). It is the shape on an
 * operator's disk once a scoped orchestrator has answered a worker approval.
 */
const orchestratorResolvedFixturePath = fileURLToPath(new URL("../test-fixtures/state-with-orchestrator-resolved-approval.json", import.meta.url));

test("loads an orchestrator-resolved approval written by a live connection byte for byte", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-store-"));
  const path = join(directory, "state.json");
  const bytes = await readFile(orchestratorResolvedFixturePath);
  await writeFile(path, bytes);
  const store = new Store(path);

  await store.load();

  assert.deepEqual(await readFile(path), bytes, "a snapshot the hub just wrote is never rewritten on load");
  const snapshot = store.snapshot();
  const approval = snapshot.approvals![0];
  const attachment = snapshot.orchestratorAttachments![0];
  assert.equal(approval.status, "approved");
  assert.equal(approval.selectedOptionId, "allow");
  assert.deepEqual(approval.resolvedBy, { kind: "orchestrator", clientId: attachment.clientId, attachmentId: attachment.id });
  assert.equal(snapshot.tasks!.find((task) => task.id === approval.taskId)!.threadId, attachment.threadId, "the audited decision names the thread it was made on");
  assert.ok(!JSON.stringify(snapshot).includes("secretHash"));
});

test("snapshots publish orchestrator clients without their secret hash", async () => {
  const at = "2026-09-22T12:00:00.000Z";
  const { store } = await loadFixture();
  await store.load();
  await store.transact((state) => {
    state.orchestratorClients!.push(
      { id: "client-one", name: "Christian's laptop", scopes: ["orchestrate"], secretHash: "sha256:deadbeef", createdAt: at },
      { id: "client-two", name: "Reviewer", scopes: ["orchestrate", "resolve-approvals"], secretHash: "sha256:feedface", createdAt: at, lastSeenAt: at, revokedAt: at }
    );
    state.orchestratorAttachments!.push({
      id: "attachment-one", threadId: "thread-one", clientId: "client-one", connectionId: "connection-one",
      attachedAt: at, lastHeartbeatAt: at, status: "attached"
    });
  });

  const snapshot = store.snapshot();
  assert.deepEqual(snapshot.orchestratorClients, [
    { id: "client-one", name: "Christian's laptop", scopes: ["orchestrate"], createdAt: at },
    { id: "client-two", name: "Reviewer", scopes: ["orchestrate", "resolve-approvals"], createdAt: at, lastSeenAt: at, revokedAt: at }
  ]);
  assert.ok(!JSON.stringify(snapshot).includes("secretHash"), "snapshots never carry a secret hash");
  assert.ok(!JSON.stringify(snapshot).includes("deadbeef"), "snapshots never carry a secret");
  assert.deepEqual(snapshot.orchestratorAttachments?.map((attachment) => attachment.id), ["attachment-one"]);
  store.read((state) => {
    assert.equal(state.orchestratorClients![0].secretHash, "sha256:deadbeef", "the hub keeps the hash");
  });
});

test("rejects persisted orchestrator records the hub cannot interpret", async () => {
  const client = { id: "client-one", name: "Laptop", scopes: ["orchestrate"], secretHash: "sha256:deadbeef", createdAt: "2026-09-22T12:00:00.000Z" };
  const attachment = {
    id: "attachment-one", threadId: "thread-one", clientId: "client-one", connectionId: "connection-one",
    attachedAt: "2026-09-22T12:00:00.000Z", lastHeartbeatAt: "2026-09-22T12:00:00.000Z", status: "attached"
  };
  const cases: Array<[string, (state: Record<string, any>) => void]> = [
    ["missing its identity", (state) => { state.orchestratorClients = [{ ...client, secretHash: "" }]; }],
    ["has an unknown scope", (state) => { state.orchestratorClients = [{ ...client, scopes: ["orchestrate", "administer"] }]; }],
    ["repeats client id", (state) => { state.orchestratorClients = [client, { ...client }]; }],
    ["missing its identity", (state) => { state.orchestratorAttachments = [{ ...attachment, connectionId: "" }]; }],
    ["has an unknown status", (state) => { state.orchestratorAttachments = [{ ...attachment, status: "paused" }]; }],
    ["repeats attachment id", (state) => { state.orchestratorAttachments = [attachment, { ...attachment }]; }],
    ["has an unknown orchestrator", (state) => { state.threads[0].orchestrator = { kind: "robot", agentId: "orchestrator" }; }],
    ["has an unknown orchestrator", (state) => { state.threads[0].orchestrator = { kind: "external" }; }],
    ["has a malformed orchestrator", (state) => { state.threads[0].orchestrator = "agent"; }],
    ["still names an owner agent", (state) => { state.threads[0].orchestrator = { kind: "external", clientId: "client-one" }; }],
    ["disagrees with its own owner agent", (state) => { state.threads[0].orchestrator = { kind: "agent", agentId: "someone-else" }; }],
    ["disagrees with its own owner agent", (state) => {
      state.threads[0].orchestrator = { kind: "agent", agentId: "orchestrator" };
      delete state.threads[0].ownerAgentId;
    }]
  ];
  for (const [reason, mutate] of cases) {
    const { store } = await loadFixture(mutate);
    await assert.rejects(() => store.load(), new RegExp(reason), reason);
  }
});

test("loads an externally orchestrated thread without an owner agent", async () => {
  const { store } = await loadFixture((state) => {
    delete state.threads[0].ownerAgentId;
    state.threads[0].orchestrator = { kind: "external", clientId: "client-one" };
  });
  await store.load();

  const thread = store.snapshot().threads![0];
  assert.deepEqual(thread.orchestrator, { kind: "external", clientId: "client-one" });
  assert.equal(threadOwnerAgentId(thread), undefined, "an external thread has no owner agent");
});

/*
 * `state-with-external-orchestrator-attachment.json` was written byte-for-byte by
 * `apps/hub/src/store.ts` (`private async save`) from records built by the real producers in this
 * change: `apps/hub/src/orchestratorClients.ts:124` (`mintOrchestratorClient`) and a live
 * `/orchestrator-client` connection driven through `client.hello`, `create_thread`, and
 * `client.heartbeat` by `apps/hub/src/orchestratorClientGateway.ts:120`
 * (`createOrchestratorClientGateway`). It is the shape on an operator's disk once a bridge has
 * opened and attached a thread.
 */
const attachedFixturePath = fileURLToPath(new URL("../test-fixtures/state-with-external-orchestrator-attachment.json", import.meta.url));

async function loadAttachedFixture(mutate: (state: Record<string, any>) => void = () => undefined) {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-store-"));
  const path = join(directory, "state.json");
  const persisted = JSON.parse(await readFile(attachedFixturePath, "utf8"));
  mutate(persisted);
  await writeFile(path, JSON.stringify(persisted, null, 2));
  return { store: new Store(path), persisted };
}

test("loads a snapshot written by a live orchestrator-client connection byte for byte", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-store-"));
  const path = join(directory, "state.json");
  const bytes = await readFile(attachedFixturePath);
  await writeFile(path, bytes);
  const store = new Store(path);
  await store.load();

  assert.deepEqual(await readFile(path), bytes, "a snapshot the hub just wrote is never rewritten on load");
  const snapshot = store.snapshot();
  assert.equal(snapshot.orchestratorAttachments!.length, 1);
  assert.equal(snapshot.orchestratorAttachments![0].status, "attached");
  assert.equal(snapshot.orchestratorAttachments![0].clientId, snapshot.orchestratorClients![0].id);
  assert.equal(snapshot.orchestratorAttachments![0].threadId, snapshot.threads![0].id);
  assert.deepEqual(snapshot.threads![0].orchestrator, { kind: "external", clientId: snapshot.orchestratorClients![0].id });
  assert.ok(!JSON.stringify(snapshot).includes("secretHash"));
});

test("rejects a persisted attachment that names a client or thread the snapshot does not hold", async () => {
  const cases: Array<[RegExp, (state: Record<string, any>) => void]> = [
    [/names unknown orchestrator client/, (state) => { state.orchestratorAttachments[0].clientId = "orchestrator-client-absent"; }],
    [/names unknown orchestrator client/, (state) => { state.orchestratorClients = []; }],
    [/names unknown thread/, (state) => { state.orchestratorAttachments[0].threadId = "thread-absent"; }],
    [/names unknown thread/, (state) => { state.threads = []; }]
  ];
  for (const [reason, mutate] of cases) {
    const { store } = await loadAttachedFixture(mutate);
    await assert.rejects(() => store.load(), reason, String(reason));
  }
});

/*
 * Source-key compatibility.
 *
 * `state-with-run-submitted-tasks.json` was written byte-for-byte by the store at
 * d8c0e853f775b8e0c0608a3fde7fa0df2692c92d (`apps/hub/src/store.ts:563`, `private async save`) from
 * records built by that revision's real producers, driven through `apps/hub/src/hubTools.ts:56`
 * (`createHubToolHandler`): `apps/hub/src/threads.ts:29` (`newThread`), `apps/hub/src/tasks.ts:395`
 * (`submitTaskBatch`), `apps/hub/src/tasks.ts:529` (`assignTaskAttempt`),
 * `apps/hub/src/mailbox.ts:342` (`sendTaskMessage`), and `apps/hub/src/coordination.ts:399`
 * (`updateTask`). None of its records carries a source key, because that revision had none: it is
 * the shape on an operator's disk today.
 */
const runSubmittedFixturePath = fileURLToPath(new URL("../test-fixtures/state-with-run-submitted-tasks.json", import.meta.url));

async function loadRunSubmittedFixture() {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-store-"));
  const path = join(directory, "state.json");
  const bytes = await readFile(runSubmittedFixturePath);
  await writeFile(path, bytes);
  const store = new Store(path);
  await store.load();
  return { store, path, bytes };
}

test("loads a state file written before source keys existed without rewriting it", async () => {
  const { store, path, bytes } = await loadRunSubmittedFixture();

  assert.deepEqual(await readFile(path), bytes, "a snapshot the hub just wrote is never rewritten on load");
  store.read((state) => {
    assert.ok(!JSON.stringify(state).includes("sourceKey"), "no source key is invented for an existing record");
    assert.equal(recordSourceKey(state.tasks![0]), runSourceKey("run-root"), "a task keeps the identity it was written with");
    assert.equal(recordSourceKey(state.taskSubmissions![0]), runSourceKey("run-root"));
    assert.deepEqual(state.taskMessages!.map((message) => recordSourceKey(message)), [runSourceKey("run-root"), runSourceKey("run-attempt")]);
    assert.equal(state.taskUpdates![0].sourceRunId, "run-attempt");
  });
});

test("replays a submission, a message, and a task update persisted before source keys existed", async () => {
  const { store } = await loadRunSubmittedFixture();
  const taskId = store.read((state) => state.tasks![0].id);
  const persisted = () => JSON.stringify(store.read((state) => [state.tasks, state.taskSubmissions, state.taskMessages, state.taskUpdates]));
  const before = persisted();

  const submission = await submitTasks(store, "run-root", {
    idempotencyKey: "batch-one",
    tasks: [{ key: "migrate", title: "Write the migration", instructions: "Write the migration carefully" }]
  });
  const message = await sendTaskMessage(store, "run-root", {
    idempotencyKey: "message-one",
    recipient: { type: "task", taskId },
    kind: "instruction",
    body: "Start with the schema"
  });
  const update = await updateTask(store, "run-attempt", { idempotencyKey: "update-one", progress: "Schema drafted" });

  assert.equal(submission.created, false, "a persisted batch still replays rather than conflicting");
  assert.deepEqual(submission.taskIdsByKey, { migrate: taskId });
  assert.equal(message.created, false, "a persisted message still replays");
  assert.equal(update.created, false, "a persisted task update still replays");
  assert.equal(persisted(), before, "a replay writes nothing");
});
