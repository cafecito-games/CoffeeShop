import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canTransitionWorkspaceLease,
  workspaceLeaseGrant,
  workspaceLeaseStatuses,
  type Agent,
  type ComputeNode,
  type ProjectProfile,
  type Run,
  type Task,
  type WorkspaceLease,
  type WorkspaceLeaseStatus,
  type WorkspaceLeaseUpdate
} from "@coffee-shop/protocol";
import { createRedactor } from "./redaction.js";
import { assertPersistedWorkspaceLeaseState, Store, type State } from "./store.js";
import {
  applyWorkspaceLeaseUpdate,
  cleanupWorkspaceLeaseByOperator,
  dispatchableLease,
  dispatchableWorkspaceLeaseStatuses,
  exclusiveWorkspaceHolder,
  leasesAwaitingReconciliation,
  planWorkspaceLease,
  receiveWorkspaceLeaseUpdate,
  reconcileWorkspaceLeases,
  requestOperatorCleanup,
  workspaceCleanupMessage,
  workspaceLeaseConfirmation
} from "./workspaceLeases.js";

const at = "2026-09-21T12:00:00.000Z";
const laterAt = "2026-09-21T12:05:00.000Z";
const resolvedRevision = "a".repeat(40);
const otherRevision = "b".repeat(40);
const redactor = createRedactor([]);

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "alpha", name: "alpha", title: "alpha", summary: "", glyph: "A",
    avatarShape: "cup", avatarColor: "amber", state: "idle", currentAction: "Available",
    harnessId: "codex-cli", model: "default", computeNodeId: "node-one", workspace: "/workspace/alpha",
    systemPrompt: "Work carefully", unread: 0, updatedAt: at, skills: [], ...overrides
  };
}

function node(overrides: Partial<ComputeNode> = {}): ComputeNode {
  return {
    id: "node-one", name: "node-one", kind: "local", platform: "linux · amd64", status: "online", lastSeen: at, activeRuns: 0,
    concurrency: 2, workspaceRoots: ["/workspace"], version: "test",
    harnesses: [{ id: "codex-cli", label: "Codex", description: "", available: true, authMode: "local-account", models: [] }],
    ...overrides
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-one", threadId: "thread-one", title: "Task one", instructions: "Do one", status: "ready", requirements: {},
    dependencies: [], idempotencyKey: "batch", attemptRunIds: [], createdAt: at, updatedAt: at, ...overrides
  };
}

function profile(overrides: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    schemaVersion: 1, id: "profile-one", name: "Profile one",
    repository: { url: "https://example.com/org/repo.git", defaultBranch: "main" },
    workspacePolicy: { requireWritable: false, isolation: "git-worktree", cleanup: "when-unchanged" },
    requirements: { hard: {} }, ...overrides
  };
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-one", agentId: "alpha", nodeId: "node-one", harnessId: "codex-cli", model: "default",
    workspace: "/workspace/alpha", prompt: "Work", status: "queued", output: "", depth: 0,
    createdAt: at, ...overrides
  };
}

function lease(status: WorkspaceLeaseStatus, overrides: Partial<WorkspaceLease> = {}): WorkspaceLease {
  return {
    id: "lease-one", threadId: "thread-one", taskId: "task-one", runId: "run-one", nodeId: "node-one",
    projectProfileId: "profile-one", policy: "git-worktree", cleanup: "when-unchanged",
    repository: "https://example.com/org/repo", root: "/workspace", sourcePath: "/workspace/alpha",
    baseRevision: "refs/heads/main", branch: "coffee-shop/task-one/run-one",
    worktreePath: "/workspace/.coffee-shop/worktrees/lease-one", status, createdAt: at, updatedAt: at, ...overrides
  };
}

function exclusiveLease(status: WorkspaceLeaseStatus, overrides: Partial<WorkspaceLease> = {}): WorkspaceLease {
  return lease(status, {
    policy: "exclusive-existing",
    repository: undefined,
    baseRevision: undefined,
    branch: undefined,
    worktreePath: "/workspace/alpha",
    ...overrides
  });
}

function leaseState(leases: WorkspaceLease[], runs: Run[] = []): State {
  return { agents: [], nodes: [], runs, events: [], messages: [], threads: [], workspaceLeases: leases };
}

test("planWorkspaceLease derives a complete git-worktree lease from trusted inputs", () => {
  const result = planWorkspaceLease({ task: task(), agent: agent(), node: node(), profile: profile(), runId: "run-one", leaseId: "lease-one", at });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.lease, {
    id: "lease-one",
    threadId: "thread-one",
    taskId: "task-one",
    runId: "run-one",
    nodeId: "node-one",
    projectProfileId: "profile-one",
    policy: "git-worktree",
    cleanup: "when-unchanged",
    repository: "https://example.com/org/repo",
    root: "/workspace",
    sourcePath: "/workspace/alpha",
    baseRevision: "refs/heads/main",
    branch: "coffee-shop/task-one/run-one",
    worktreePath: "/workspace/.coffee-shop/worktrees/lease-one",
    status: "requested",
    createdAt: at,
    updatedAt: at
  });
});

test("planWorkspaceLease strips credentials from the repository url and defaults cleanup to retain", () => {
  const withCredentials = profile({ repository: { url: "https://user:secret@example.com/org/repo.git", defaultBranch: "main" } });
  const result = planWorkspaceLease({
    task: task(), agent: agent(), node: node(), profile: withCredentials,
    runId: "run-one", leaseId: "lease-one", at
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.lease.repository, "https://example.com/org/repo");
  assert.equal(result.lease.cleanup, "when-unchanged");

  const withoutCleanup = profile({ workspacePolicy: { requireWritable: false, isolation: "git-worktree" } });
  const defaulted = planWorkspaceLease({
    task: task(), agent: agent(), node: node(), profile: withoutCleanup,
    runId: "run-one", leaseId: "lease-one", at
  });
  assert.equal(defaulted.ok, true);
  if (!defaulted.ok) return;
  assert.equal(defaulted.lease.cleanup, "retain");
});

test("planWorkspaceLease binds the longest advertised root containing the checkout", () => {
  const nested = node({ workspaceRoots: ["/workspace", "/workspace/alpha", "/workspace/alpha/nested"] });
  const result = planWorkspaceLease({
    task: task(), agent: agent({ workspace: "/workspace/alpha/nested/checkout" }), node: nested, profile: profile(),
    runId: "run-one", leaseId: "lease-one", at
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.lease.root, "/workspace/alpha/nested");
  assert.equal(result.lease.worktreePath, "/workspace/alpha/nested/.coffee-shop/worktrees/lease-one");
});

test("planWorkspaceLease rejects checkouts and identities it cannot bind", () => {
  const cases: Array<{ label: string; task?: Partial<Task>; agentOverrides?: Partial<Agent>; nodeOverrides?: Partial<ComputeNode>; profileOverrides?: Partial<ProjectProfile>; runId?: string }> = [
    { label: "agent workspace is not normalized", agentOverrides: { workspace: "/workspace/a/../b" } },
    { label: "agent workspace ends with a slash", agentOverrides: { workspace: "/workspace/alpha/" } },
    { label: "agent workspace outside every advertised root", agentOverrides: { workspace: "/elsewhere/alpha" } },
    { label: "agent workspace inside the managed worktree directory", agentOverrides: { workspace: "/workspace/.coffee-shop/checkout" } },
    { label: "requested path differs from the agent workspace", task: { requirements: { workspace: { path: "/workspace/beta", writable: false } } } },
    { label: "requested repository differs from the project repository", task: { requirements: { workspace: { repository: "https://example.com/other/repo.git", writable: false } } } },
    { label: "git-worktree without a project repository", profileOverrides: { repository: undefined } },
    { label: "task identity cannot name a workspace", task: { id: "Task-One" } },
    { label: "task identity with a space", task: { id: "task one" } },
    { label: "run identity cannot name a workspace", runId: "Run-One" }
  ];
  for (const testCase of cases) {
    const result = planWorkspaceLease({
      task: task(testCase.task ?? {}),
      agent: agent(testCase.agentOverrides ?? {}),
      node: node(testCase.nodeOverrides ?? {}),
      profile: profile(testCase.profileOverrides ?? {}),
      runId: testCase.runId ?? "run-one",
      leaseId: "lease-one",
      at
    });
    assert.equal(result.ok, false, testCase.label);
    if (result.ok) continue;
    assert.equal(result.requirement, "workspace lease", testCase.label);
    assert.ok(result.detail.length > 0, testCase.label);
  }
});

test("an exclusive-existing lease takes the checkout itself", () => {
  const result = planWorkspaceLease({
    task: task(), agent: agent(), node: node(),
    profile: profile({ workspacePolicy: { requireWritable: false, isolation: "exclusive-existing", cleanup: "when-unchanged" } }),
    runId: "run-one", leaseId: "lease-one", at
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.lease.policy, "exclusive-existing");
  assert.equal(result.lease.worktreePath, "/workspace/alpha");
  assert.equal(result.lease.sourcePath, "/workspace/alpha");
  assert.equal("repository" in result.lease, false);
  assert.equal("baseRevision" in result.lease, false);
  assert.equal("branch" in result.lease, false);
  assert.equal(result.lease.cleanup, "when-unchanged");
});

test("exclusiveWorkspaceHolder finds only leases that still hold the workspace", () => {
  const holding: WorkspaceLeaseStatus[] = ["requested", "provisioning", "active", "released", "cleaning", "retained"];
  const settled: WorkspaceLeaseStatus[] = ["cleaned", "failed"];
  for (const status of holding) {
    const current = [exclusiveLease(status)];
    assert.equal(exclusiveWorkspaceHolder(current, "node-one", "/workspace/alpha"), current[0], status);
  }
  for (const status of settled) {
    assert.equal(exclusiveWorkspaceHolder([exclusiveLease(status)], "node-one", "/workspace/alpha"), undefined, status);
  }
  const elsewhere = exclusiveLease("active");
  assert.equal(exclusiveWorkspaceHolder([elsewhere], "node-two", "/workspace/alpha"), undefined);
  assert.equal(exclusiveWorkspaceHolder([elsewhere], "node-one", "/workspace/beta"), undefined);
});

test("dispatchableLease returns the run's lease only in dispatchable statuses", () => {
  for (const status of workspaceLeaseStatuses) {
    const current = lease(status);
    const expected = dispatchableWorkspaceLeaseStatuses.includes(status);
    assert.equal(dispatchableLease([current], "run-one", "lease-one") !== undefined, expected, status);
  }
  assert.equal(dispatchableLease([lease("requested", { runId: "run-other" })], "run-one", "lease-one"), undefined);
  assert.equal(dispatchableLease([lease("requested")], "run-one", undefined), undefined);
  assert.equal(dispatchableLease([], "run-one", "lease-one"), undefined);
});

test("applyWorkspaceLeaseUpdate applies exactly the canonical transitions", () => {
  for (const from of workspaceLeaseStatuses) {
    for (const to of workspaceLeaseStatuses) {
      const current = lease(from);
      const state = leaseState([current]);
      const update: WorkspaceLeaseUpdate = { leaseId: current.id, status: to };
      if (to === "active") update.resolvedBaseRevision = resolvedRevision;
      if (to === "retained") update.retentionReason = "dirty";
      const result = applyWorkspaceLeaseUpdate(state, "node-one", "run-one", update, laterAt, redactor);
      if (from === to) {
        assert.equal(result.kind, "unchanged", `${from} to ${to}`);
        assert.equal(current.updatedAt, at, `${from} to ${to}`);
      } else if (canTransitionWorkspaceLease(from, to)) {
        assert.equal(result.kind, "applied", `${from} to ${to}`);
        assert.equal(current.status, to, `${from} to ${to}`);
      } else {
        assert.equal(result.kind, "rejected", `${from} to ${to}`);
        assert.equal(current.status, from, `${from} to ${to}`);
      }
    }
  }
});

test("applyWorkspaceLeaseUpdate rejects reports it cannot own", () => {
  const unknown = leaseState([lease("requested")]);
  assert.equal(applyWorkspaceLeaseUpdate(unknown, "node-one", "run-one", { leaseId: "lease-ghost", status: "provisioning" }, laterAt, redactor).kind, "rejected");

  const otherNode = leaseState([lease("requested")]);
  assert.equal(applyWorkspaceLeaseUpdate(otherNode, "node-two", "run-one", { leaseId: "lease-one", status: "provisioning" }, laterAt, redactor).kind, "rejected");
  assert.equal(otherNode.workspaceLeases![0].status, "requested");

  const otherRun = leaseState([lease("requested")]);
  assert.equal(applyWorkspaceLeaseUpdate(otherRun, "node-one", "run-two", { leaseId: "lease-one", status: "provisioning" }, laterAt, redactor).kind, "rejected");
  assert.equal(otherRun.workspaceLeases![0].status, "requested");

  const withoutRevision = leaseState([lease("provisioning")]);
  assert.equal(applyWorkspaceLeaseUpdate(withoutRevision, "node-one", "run-one", { leaseId: "lease-one", status: "active" }, laterAt, redactor).kind, "rejected");
  assert.equal(withoutRevision.workspaceLeases![0].status, "provisioning");

  const conflict = leaseState([lease("active", { resolvedBaseRevision: resolvedRevision })]);
  assert.equal(applyWorkspaceLeaseUpdate(conflict, "node-one", "run-one", { leaseId: "lease-one", status: "released", resolvedBaseRevision: otherRevision }, laterAt, redactor).kind, "rejected");
  assert.equal(conflict.workspaceLeases![0].status, "active");

  const existing = leaseState([exclusiveLease("requested")]);
  assert.equal(applyWorkspaceLeaseUpdate(existing, "node-one", "run-one", { leaseId: "lease-one", status: "provisioning", resolvedBaseRevision: resolvedRevision }, laterAt, redactor).kind, "rejected");
  assert.equal(existing.workspaceLeases![0].status, "requested");
});

test("applied updates record status, retention, redacted detail, revision, and timeline events", () => {
  const current = lease("provisioning", { resolvedBaseRevision: resolvedRevision, retentionReason: "dirty", detail: "earlier detail" });
  const state = leaseState([current]);
  const retained = applyWorkspaceLeaseUpdate(state, "node-one", "run-one", {
    leaseId: current.id, status: "retained", retentionReason: "dirty", detail: "token Bearer abcdefghijklmnopqrstuvwxyz expired"
  }, laterAt, redactor);
  assert.equal(retained.kind, "applied");
  assert.equal(current.status, "retained");
  assert.equal(current.updatedAt, laterAt);
  assert.equal(current.detail, "token Bearer [redacted] expired");
  assert.equal(current.retentionReason, "dirty");
  assert.equal(state.events.length, 1);
  assert.ok(state.events[0].detail.includes(current.id));
  assert.equal(state.events[0].detail.includes("https://"), false);

  const cleaning = applyWorkspaceLeaseUpdate(state, "node-one", "run-one", {
    leaseId: current.id, status: "cleaning"
  }, laterAt, redactor);
  assert.equal(cleaning.kind, "applied");
  assert.equal(current.status, "cleaning");
  assert.equal(current.retentionReason, undefined);
  assert.equal(current.detail, undefined);

  const failing = leaseState([lease("requested")]);
  const failed = applyWorkspaceLeaseUpdate(failing, "node-one", "run-one", { leaseId: "lease-one", status: "failed", detail: "worktree could not be created" }, laterAt, redactor);
  assert.equal(failed.kind, "applied");
  assert.equal(failing.events[0].detail.includes("lease-one"), true);
  assert.equal(failing.events[0].detail.includes("https://"), false);

  const recorded = leaseState([lease("provisioning", { resolvedBaseRevision: resolvedRevision })]);
  const reused = applyWorkspaceLeaseUpdate(recorded, "node-one", "run-one", { leaseId: "lease-one", status: "active" }, laterAt, redactor);
  assert.equal(reused.kind, "applied");
  assert.equal(recorded.workspaceLeases![0].resolvedBaseRevision, resolvedRevision);
});

test("leasesAwaitingReconciliation lists unsettled leases whose run is no longer active", () => {
  const state = leaseState([
    lease("requested", { id: "lease-missing", runId: "run-missing" }),
    lease("provisioning", { id: "lease-done", runId: "run-done" }),
    lease("active", { id: "lease-active", runId: "run-active" }),
    lease("released", { id: "lease-running", runId: "run-running" }),
    lease("cleaning", { id: "lease-reported", runId: "run-reported" }),
    lease("retained", { id: "lease-retained", runId: "run-done" }),
    lease("cleaned", { id: "lease-cleaned", runId: "run-done" }),
    lease("failed", { id: "lease-failed", runId: "run-done" }),
    lease("requested", { id: "lease-elsewhere", nodeId: "node-two", runId: "run-missing" })
  ], [
    run({ id: "run-active", status: "queued" }),
    run({ id: "run-running", status: "running" }),
    run({ id: "run-done", status: "completed" }),
    run({ id: "run-reported", status: "queued" })
  ]);
  assert.deepEqual(leasesAwaitingReconciliation(state, "node-one").map((item) => item.id), ["lease-missing", "lease-done"]);
  assert.deepEqual(leasesAwaitingReconciliation(state, "node-one", ["run-missing"]).map((item) => item.id), ["lease-done"]);
  assert.deepEqual(leasesAwaitingReconciliation(state, "node-two").map((item) => item.id), ["lease-elsewhere"]);
});

test("workspaceCleanupMessage carries the grant and mode", () => {
  const current = lease("retained", { retentionReason: "dirty" });
  assert.deepEqual(workspaceCleanupMessage(current, "operator"), {
    type: "workspace.cleanup",
    runId: "run-one",
    lease: workspaceLeaseGrant(current),
    mode: "operator"
  });
  assert.deepEqual(workspaceCleanupMessage(current, "reconcile").mode, "reconcile");
});

test("requestOperatorCleanup only records a request for a retained lease", () => {
  const missing = leaseState([lease("retained")]);
  assert.deepEqual(requestOperatorCleanup(missing, "lease-ghost", laterAt), { kind: "not-found" });

  const activeLease = leaseState([lease("active")], [run({ id: "run-one", status: "completed" })]);
  assert.equal(requestOperatorCleanup(activeLease, "lease-one", laterAt).kind, "conflict");

  const activeRun = leaseState([lease("retained")], [run({ id: "run-one", status: "running" })]);
  const conflict = requestOperatorCleanup(activeRun, "lease-one", laterAt);
  assert.equal(conflict.kind, "conflict");
  if (conflict.kind !== "conflict") return;
  assert.equal(conflict.reason.includes("still active"), true);
  assert.equal(activeRun.workspaceLeases![0].cleanupRequestedAt, undefined);

  const settled = leaseState([lease("retained")], [run({ id: "run-one", status: "completed" })]);
  const requested = requestOperatorCleanup(settled, "lease-one", laterAt);
  assert.equal(requested.kind, "requested");
  assert.equal(settled.workspaceLeases![0].cleanupRequestedAt, laterAt);
  assert.equal(settled.workspaceLeases![0].status, "retained");

  const withoutRun = leaseState([lease("retained")]);
  assert.equal(requestOperatorCleanup(withoutRun, "lease-one", laterAt).kind, "requested");
});

test("receiveWorkspaceLeaseUpdate persists only applied reports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-leases-"));
  const path = join(directory, "state.json");
  const store = new Store(path);
  await store.load();
  await store.transact((state) => {
    state.workspaceLeases!.push(lease("requested"));
    state.runs.push(run());
  });

  const applied = await receiveWorkspaceLeaseUpdate(store, "node-one", "run-one", {
    leaseId: "lease-one", status: "provisioning", detail: "preparing worktree"
  }, redactor, laterAt);
  assert.equal(applied.kind, "applied");
  const persisted = new Store(path);
  await persisted.load();
  assert.equal(persisted.read((state) => state.workspaceLeases![0].status), "provisioning");

  const rejected = await receiveWorkspaceLeaseUpdate(store, "node-two", "run-one", {
    leaseId: "lease-one", status: "failed"
  }, redactor, laterAt);
  assert.equal(rejected.kind, "rejected");
  const unchanged = new Store(path);
  await unchanged.load();
  assert.equal(unchanged.read((state) => state.workspaceLeases![0].status), "provisioning");
});

test("reconcileWorkspaceLeases sends one reconcile message per awaiting lease and records nothing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-leases-"));
  const path = join(directory, "state.json");
  const store = new Store(path);
  await store.load();
  const seeded = [
    lease("requested", { id: "lease-one", runId: "run-one" }),
    lease("released", { id: "lease-two", runId: "run-two" }),
    lease("retained", { id: "lease-three", runId: "run-two" }),
    lease("requested", { id: "lease-four", nodeId: "node-two", runId: "run-two" })
  ];
  await store.transact((state) => {
    state.workspaceLeases!.push(...structuredClone(seeded));
    state.runs.push(run({ id: "run-two", status: "completed" }));
  });

  const delivered: Array<{ nodeId: string; runId: string; mode: string; leaseId: string }> = [];
  let calls = 0;
  const count = reconcileWorkspaceLeases(store, "node-one", [], (nodeId, message) => {
    calls += 1;
    if (message.type !== "workspace.cleanup") return false;
    delivered.push({ nodeId, runId: message.runId, mode: message.mode, leaseId: message.lease.id });
    return calls === 1;
  });
  assert.equal(count, 1);
  assert.deepEqual(delivered, [
    { nodeId: "node-one", runId: "run-one", mode: "reconcile", leaseId: "lease-one" },
    { nodeId: "node-one", runId: "run-two", mode: "reconcile", leaseId: "lease-two" }
  ]);
  const persisted = new Store(path);
  await persisted.load();
  assert.deepEqual(persisted.read((state) => state.workspaceLeases), seeded);
});

test("cleanupWorkspaceLeaseByOperator records, sends, and reports delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-leases-"));
  const path = join(directory, "state.json");
  const store = new Store(path);
  await store.load();
  await store.transact((state) => {
    state.workspaceLeases!.push(lease("retained", { retentionReason: "dirty" }));
    state.runs.push(run({ id: "run-one", status: "completed" }));
  });

  const delivered: Array<{ nodeId: string; mode: string; leaseId: string }> = [];
  const requested = await cleanupWorkspaceLeaseByOperator(store, "lease-one", (nodeId, message) => {
    if (message.type !== "workspace.cleanup") return false;
    delivered.push({ nodeId, mode: message.mode, leaseId: message.lease.id });
    return true;
  }, laterAt);
  assert.equal(requested.kind, "requested");
  assert.equal(requested.sent, true);
  assert.equal(requested.lease.cleanupRequestedAt, laterAt);
  assert.equal(requested.lease.status, "retained");
  assert.deepEqual(delivered, [{ nodeId: "node-one", mode: "operator", leaseId: "lease-one" }]);
  const persisted = new Store(path);
  await persisted.load();
  assert.equal(persisted.read((state) => state.workspaceLeases![0].cleanupRequestedAt), laterAt);

  const undelivered = await cleanupWorkspaceLeaseByOperator(store, "lease-one", () => false, laterAt);
  assert.equal(undelivered.kind, "requested");
  assert.equal(undelivered.sent, false);

  const notFound = await cleanupWorkspaceLeaseByOperator(store, "lease-ghost", () => true, laterAt);
  assert.deepEqual(notFound, { kind: "not-found", sent: false });

  const busy = new Store(join(directory, "busy.json"));
  await busy.load();
  await busy.transact((state) => {
    state.workspaceLeases!.push(lease("active"));
    state.runs.push(run());
  });
  const conflict = await cleanupWorkspaceLeaseByOperator(busy, "lease-one", () => true, laterAt);
  assert.equal(conflict.kind, "conflict");
  assert.equal(conflict.sent, false);
  assert.equal(busy.read((state) => state.workspaceLeases![0].cleanupRequestedAt), undefined);
});

test("assertPersistedWorkspaceLeaseState rejects leases the hub cannot interpret", () => {
  assert.doesNotThrow(() => assertPersistedWorkspaceLeaseState(leaseState([lease("requested")])));
  assert.doesNotThrow(() => assertPersistedWorkspaceLeaseState(leaseState([exclusiveLease("active")])));

  const cases: Array<{ label: string; leases: unknown[] }> = [
    { label: "unknown status", leases: [{ ...lease("requested"), status: "paused" }] },
    { label: "unknown isolation policy", leases: [{ ...lease("requested"), policy: "shared" }] },
    { label: "unknown cleanup policy", leases: [{ ...lease("requested"), cleanup: "always" }] },
    { label: "missing identity", leases: [{ ...lease("requested"), root: undefined }] },
    { label: "git-worktree lease missing its branch", leases: [{ ...lease("requested"), branch: undefined }] },
    { label: "git-worktree lease missing its base revision", leases: [{ ...lease("requested"), baseRevision: undefined }] },
    { label: "git-worktree lease missing its repository", leases: [{ ...lease("requested"), repository: undefined }] },
    { label: "duplicate lease ids", leases: [lease("requested"), lease("cleaned", { runId: "run-two" })] }
  ];
  for (const testCase of cases) {
    assert.throws(() => assertPersistedWorkspaceLeaseState(leaseState(testCase.leases as WorkspaceLease[])), testCase.label);
  }
});

test("Store.load rejects a state file containing an uninterpretable lease", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-leases-"));
  const path = join(directory, "state.json");
  const invalid = lease("requested") as unknown as Record<string, unknown>;
  delete invalid.branch;
  await writeFile(path, JSON.stringify({
    agents: [], nodes: [], runs: [], events: [], messages: [], workspaceLeases: [invalid]
  }));
  const store = new Store(path);
  await assert.rejects(() => store.load());
});

test("workspaceLeaseConfirmation confirms only a persisted active lease of the node's own active run", () => {
  const confirmed = leaseState([lease("active", { resolvedBaseRevision: resolvedRevision })], [run()]);
  assert.deepEqual(workspaceLeaseConfirmation(confirmed, "node-one", "run-one", "lease-one"),
    { type: "workspace.lease.confirmed", runId: "run-one", leaseId: "lease-one", status: "active" });
  assert.deepEqual(workspaceLeaseConfirmation(leaseState([lease("active")], [run({ status: "running" })]), "node-one", "run-one", "lease-one")?.status, "active");

  for (const status of workspaceLeaseStatuses.filter((item) => item !== "active")) {
    assert.equal(workspaceLeaseConfirmation(leaseState([lease(status)], [run()]), "node-one", "run-one", "lease-one"), undefined, status);
  }
  assert.equal(workspaceLeaseConfirmation(confirmed, "node-two", "run-one", "lease-one"), undefined);
  assert.equal(workspaceLeaseConfirmation(confirmed, "node-one", "run-two", "lease-one"), undefined);
  assert.equal(workspaceLeaseConfirmation(confirmed, "node-one", "run-one", "lease-two"), undefined);
  for (const status of ["completed", "failed", "cancelled"] as const) {
    assert.equal(workspaceLeaseConfirmation(leaseState([lease("active")], [run({ status })]), "node-one", "run-one", "lease-one"), undefined, status);
  }
  assert.equal(workspaceLeaseConfirmation(leaseState([lease("active")], []), "node-one", "run-one", "lease-one"), undefined);
});

test("a confirmation is derived only after the active report is persisted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-confirmation-"));
  const path = join(directory, "state.json");
  await writeFile(path, JSON.stringify(leaseState([lease("provisioning")], [run()])));
  const store = new Store(path);
  await store.load();
  assert.equal(store.read((state) => workspaceLeaseConfirmation(state, "node-one", "run-one", "lease-one")), undefined);

  const rejected = await receiveWorkspaceLeaseUpdate(store, "node-one", "run-one", { leaseId: "lease-one", status: "active" }, redactor, laterAt);
  assert.equal(rejected.kind, "rejected");
  assert.equal(store.read((state) => workspaceLeaseConfirmation(state, "node-one", "run-one", "lease-one")), undefined);

  const applied = await receiveWorkspaceLeaseUpdate(store, "node-one", "run-one", { leaseId: "lease-one", status: "active", resolvedBaseRevision: resolvedRevision }, redactor, laterAt);
  assert.equal(applied.kind, "applied");
  assert.equal(store.read((state) => workspaceLeaseConfirmation(state, "node-one", "run-one", "lease-one"))?.status, "active");

  const replayed = await receiveWorkspaceLeaseUpdate(store, "node-one", "run-one", { leaseId: "lease-one", status: "active", resolvedBaseRevision: resolvedRevision }, redactor, laterAt);
  assert.equal(replayed.kind, "unchanged");
  assert.equal(store.read((state) => workspaceLeaseConfirmation(state, "node-one", "run-one", "lease-one"))?.status, "active");
});
