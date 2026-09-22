import assert from "node:assert/strict";
import test from "node:test";
import {
  canSendToControlAgent,
  isWorkspaceLeaseBaseBranch,
  normalizeRepositoryIdentity,
  requiredCapabilityForHubMessage,
  validateProjectProfile,
  validateWorkspaceLeaseUpdate,
  workspaceLeaseGrant,
  workspaceLeaseWorktreePath
} from "../dist/index.js";

const at = "2026-09-21T12:00:00Z";

test("normalizeRepositoryIdentity drops credentials from scheme urls and one trailing .git or slash", () => {
  const cases = [
    ["https://user:secret@example.com/org/repo.git", "https://example.com/org/repo"],
    ["https://example.com/org/repo.git", "https://example.com/org/repo"],
    ["https://example.com/org/repo/", "https://example.com/org/repo"],
    ["https://example.com/org/repo", "https://example.com/org/repo"],
    ["ssh://git@github.com/org/repo.git", "ssh://github.com/org/repo"],
    ["git@github.com:org/repo.git", "git@github.com:org/repo"],
    ["git@github.com:org/repo", "git@github.com:org/repo"]
  ];
  for (const [url, expected] of cases) {
    assert.equal(normalizeRepositoryIdentity(url), expected, url);
  }
});

test("isWorkspaceLeaseBaseBranch accepts resolvable branch names and rejects Git-ref violations", () => {
  for (const accepted of ["main", "release/1.2", "feature_x-y"]) {
    assert.equal(isWorkspaceLeaseBaseBranch(accepted), true, accepted);
  }
  const rejected = ["", "-x", "a..b", "a/", "/a", "a.lock", "a/.b", "a.", "a b", "a~b", "a^b", "a:b", "a".repeat(201)];
  for (const value of rejected) {
    assert.equal(isWorkspaceLeaseBaseBranch(value), false, JSON.stringify(value));
  }
});

test("workspaceLeaseWorktreePath places the worktree beneath the managed directory of the root", () => {
  assert.equal(workspaceLeaseWorktreePath("/", "l"), "/.coffee-shop/worktrees/l");
  assert.equal(workspaceLeaseWorktreePath("/r", "l"), "/r/.coffee-shop/worktrees/l");
});

test("workspaceLeaseGrant copies only the grant fields", () => {
  const lease = {
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
    resolvedBaseRevision: "a".repeat(40),
    branch: "coffee-shop/task-one/run-one",
    worktreePath: "/workspace/.coffee-shop/worktrees/lease-one",
    status: "requested",
    retentionReason: "dirty",
    detail: "kept for attention",
    cleanupRequestedAt: at,
    createdAt: at,
    updatedAt: at
  };
  assert.deepEqual(workspaceLeaseGrant(lease), {
    id: "lease-one",
    status: "requested",
    policy: "git-worktree",
    cleanup: "when-unchanged",
    repository: "https://example.com/org/repo",
    root: "/workspace",
    sourcePath: "/workspace/alpha",
    baseRevision: "refs/heads/main",
    resolvedBaseRevision: "a".repeat(40),
    branch: "coffee-shop/task-one/run-one",
    worktreePath: "/workspace/.coffee-shop/worktrees/lease-one"
  });

  const exclusive = workspaceLeaseGrant({
    id: "lease-two",
    threadId: "thread-one",
    taskId: "task-one",
    runId: "run-one",
    nodeId: "node-one",
    projectProfileId: "profile-one",
    policy: "exclusive-existing",
    cleanup: "retain",
    root: "/workspace",
    sourcePath: "/workspace/alpha",
    worktreePath: "/workspace/alpha",
    status: "active",
    createdAt: at,
    updatedAt: at
  });
  assert.deepEqual(exclusive, {
    id: "lease-two",
    status: "active",
    policy: "exclusive-existing",
    cleanup: "retain",
    root: "/workspace",
    sourcePath: "/workspace/alpha",
    worktreePath: "/workspace/alpha"
  });
});

test("validateWorkspaceLeaseUpdate accepts only lowercase hex resolved base revisions of 40 or 64 characters", () => {
  const base = { leaseId: "lease-1", status: "provisioning" };
  for (const resolvedBaseRevision of ["a".repeat(40), "0123456789".repeat(4), "c".repeat(64)]) {
    assert.equal(validateWorkspaceLeaseUpdate({ ...base, resolvedBaseRevision }).ok, true, resolvedBaseRevision.slice(0, 8));
  }
  for (const resolvedBaseRevision of ["A".repeat(40), "a".repeat(39), "g".repeat(40), "a".repeat(65)]) {
    assert.equal(validateWorkspaceLeaseUpdate({ ...base, resolvedBaseRevision }).ok, false, resolvedBaseRevision.slice(0, 8));
  }
});

test("validateProjectProfile accepts isolation and cleanup combinations and rejects incoherent ones", () => {
  const base = {
    schemaVersion: 1,
    id: "proj",
    name: "Project",
    workspacePolicy: { requireWritable: false },
    requirements: { hard: {} }
  };
  const repository = { url: "https://example.com/org/repo.git", defaultBranch: "main" };
  const accepted = [
    base,
    { ...base, workspacePolicy: { requireWritable: false, isolation: "exclusive-existing" } },
    { ...base, workspacePolicy: { requireWritable: false, isolation: "exclusive-existing", cleanup: "retain" } },
    { ...base, repository, workspacePolicy: { requireWritable: false, isolation: "git-worktree", cleanup: "when-unchanged" } }
  ];
  for (const value of accepted) {
    assert.equal(validateProjectProfile(value).ok, true, JSON.stringify(value.workspacePolicy));
  }
  const rejected = [
    { ...base, workspacePolicy: { requireWritable: false, isolation: "shared" } },
    { ...base, workspacePolicy: { requireWritable: false, cleanup: "when-unchanged" } },
    { ...base, workspacePolicy: { requireWritable: false, isolation: "git-worktree" } },
    { ...base, repository: { url: repository.url, defaultBranch: "a..b" }, workspacePolicy: { requireWritable: false, isolation: "git-worktree" } }
  ];
  for (const value of rejected) {
    assert.equal(validateProjectProfile(value).ok, false, JSON.stringify(value.workspacePolicy));
  }
});

test("workspace cleanup messages require the orchestration capability", () => {
  const cleanup = {
    type: "workspace.cleanup",
    runId: "run-1",
    lease: {
      id: "lease-1",
      status: "retained",
      policy: "git-worktree",
      cleanup: "retain",
      root: "/r",
      sourcePath: "/r/src",
      worktreePath: "/r/.coffee-shop/worktrees/lease-1"
    },
    mode: "operator"
  };
  assert.equal(requiredCapabilityForHubMessage(cleanup), "orchestration");
  for (const version of ["1", "2", "3"]) {
    assert.equal(canSendToControlAgent(cleanup, version), false, version);
  }
  assert.equal(canSendToControlAgent(cleanup, "4"), true);
});

test("workspace.lease.confirmed requires the orchestration capability", () => {
  const confirmation = { type: "workspace.lease.confirmed", runId: "run-one", leaseId: "lease-one", status: "active" };
  assert.equal(requiredCapabilityForHubMessage(confirmation), "orchestration");
  for (const version of ["1", "2", "3"]) assert.equal(canSendToControlAgent(confirmation, version), false, version);
  assert.equal(canSendToControlAgent(confirmation, "4"), true);
});
