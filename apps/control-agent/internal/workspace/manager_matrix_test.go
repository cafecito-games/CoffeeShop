package workspace

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

func gitOutput(t *testing.T, directory string, arguments ...string) (string, error) {
	t.Helper()
	command := exec.Command("git", arguments...)
	command.Dir = directory
	output, err := command.CombinedOutput()
	return strings.TrimSpace(string(output)), err
}

func branchRevision(t *testing.T, fixture fixture, branch string) string {
	t.Helper()
	return runGit(t, fixture.source, "rev-parse", "refs/heads/"+branch)
}

// movedRevision returns a valid commit that is not the one refs/heads/main points at.
func movedRevision(t *testing.T, fixture fixture) string {
	t.Helper()
	runGit(t, fixture.source, "commit", "--quiet", "--allow-empty", "-m", "moved base")
	revision := runGit(t, fixture.source, "rev-parse", "HEAD")
	runGit(t, fixture.source, "reset", "--quiet", "--hard", fixture.base)
	return revision
}

// orphanRevision returns a root commit that shares no history with the fixture's main branch.
func orphanRevision(t *testing.T, fixture fixture) string {
	t.Helper()
	runGit(t, fixture.source, "checkout", "--quiet", "--orphan", "unrelated")
	runGit(t, fixture.source, "commit", "--quiet", "-m", "orphan root")
	revision := runGit(t, fixture.source, "rev-parse", "HEAD")
	runGit(t, fixture.source, "checkout", "--quiet", "main")
	runGit(t, fixture.source, "branch", "-D", "unrelated")
	return revision
}

func requireNoLeaseArtifacts(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
	t.Helper()
	require.NoDirExists(t, grant.WorktreePath)
	branches, err := gitOutput(t, fixture.source, "branch", "--list", "coffee-shop/*")
	require.NoError(t, err)
	require.Empty(t, branches, "no coffee-shop branch may exist")
	_, err = gitOutput(t, fixture.source, "config", "--get", "branch."+grant.Branch+".coffeeShopLease")
	require.Error(t, err, "the lease identity config key must be absent")
	_, err = gitOutput(t, fixture.source, "config", "--get", "branch."+grant.Branch+".coffeeShopBase")
	require.Error(t, err, "the lease base config key must be absent")
}

func countRegisteredWorktrees(t *testing.T, fixture fixture, path string) int {
	t.Helper()
	output, err := gitOutput(t, fixture.source, "worktree", "list", "--porcelain", "-z")
	require.NoError(t, err)
	worktrees, err := ParseWorktreeList([]byte(output))
	require.NoError(t, err)
	count := 0
	for _, worktree := range worktrees {
		if worktree.Path == path {
			count++
		}
	}
	return count
}

func TestProvisionFailsClosedWithoutTouchingTheRepository(t *testing.T) {
	cases := []struct {
		name    string
		taskID  string
		prepare func(t *testing.T, fixture fixture, grant *protocol.WorkspaceLeaseGrant)
		manager func(t *testing.T, fixture fixture) *Manager
		verify  func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant)
	}{
		{
			name: "root is not an authorized root",
			manager: func(t *testing.T, fixture fixture) *Manager {
				return NewManager([]string{t.TempDir()}, fixture.git)
			},
		},
		{
			name: "source path is outside the authorized root",
			prepare: func(t *testing.T, fixture fixture, grant *protocol.WorkspaceLeaseGrant) {
				grant.SourcePath = t.TempDir()
			},
		},
		{
			name: "source path is a symbolic link to the repository",
			prepare: func(t *testing.T, fixture fixture, grant *protocol.WorkspaceLeaseGrant) {
				link := filepath.Join(fixture.root, "link")
				require.NoError(t, os.Symlink(fixture.source, link))
				grant.SourcePath = link
			},
		},
		{
			name: "managed directory component is a symbolic link outside the root",
			prepare: func(t *testing.T, fixture fixture, grant *protocol.WorkspaceLeaseGrant) {
				outside := t.TempDir()
				require.NoError(t, os.Symlink(outside, filepath.Join(fixture.root, ".coffee-shop")))
			},
			verify: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				target, err := filepath.EvalSymlinks(filepath.Join(fixture.root, ".coffee-shop"))
				require.NoError(t, err)
				entries, err := os.ReadDir(target)
				require.NoError(t, err)
				require.Empty(t, entries, "nothing may be created inside the symlink target")
			},
		},
		{
			name: "managed worktrees path exists as a regular file",
			prepare: func(t *testing.T, fixture fixture, grant *protocol.WorkspaceLeaseGrant) {
				require.NoError(t, os.Mkdir(filepath.Join(fixture.root, ".coffee-shop"), 0o755))
				require.NoError(t, os.WriteFile(filepath.Join(fixture.root, ".coffee-shop", "worktrees"), []byte("not a directory"), 0o644))
			},
		},
		{
			name: "remote origin identifies a different repository",
			prepare: func(t *testing.T, fixture fixture, grant *protocol.WorkspaceLeaseGrant) {
				runGit(t, fixture.source, "remote", "set-url", "origin", "https://example.com/cafecito/other.git")
			},
		},
		{
			name: "the repository has no remotes at all",
			prepare: func(t *testing.T, fixture fixture, grant *protocol.WorkspaceLeaseGrant) {
				runGit(t, fixture.source, "remote", "remove", "origin")
			},
		},
		{
			name: "source path is a subdirectory of the repository",
			prepare: func(t *testing.T, fixture fixture, grant *protocol.WorkspaceLeaseGrant) {
				subdirectory := filepath.Join(fixture.source, "nested")
				require.NoError(t, os.Mkdir(subdirectory, 0o755))
				grant.SourcePath = subdirectory
			},
		},
		{
			name: "source path is itself a linked worktree",
			prepare: func(t *testing.T, fixture fixture, grant *protocol.WorkspaceLeaseGrant) {
				linked := filepath.Join(fixture.root, "elsewhere")
				runGit(t, fixture.source, "worktree", "add", "--quiet", "--detach", "--", linked, "main")
				grant.SourcePath = linked
			},
		},
		{
			name: "base ref does not exist",
			prepare: func(t *testing.T, fixture fixture, grant *protocol.WorkspaceLeaseGrant) {
				grant.BaseRevision = "refs/heads/does-not-exist"
			},
		},
		{
			name: "resolved base revision differs from the base ref on fresh creation",
			prepare: func(t *testing.T, fixture fixture, grant *protocol.WorkspaceLeaseGrant) {
				grant.ResolvedBaseRevision = movedRevision(t, fixture)
			},
		},
		{
			name:   "task identity does not reproduce the grant's branch",
			taskID: "task_two",
		},
		{
			name: "worktree path is not the managed path",
			prepare: func(t *testing.T, fixture fixture, grant *protocol.WorkspaceLeaseGrant) {
				grant.WorktreePath = filepath.Join(fixture.root, ".coffee-shop", "worktrees", "other")
			},
		},
		{
			name: "grant status cleaned is not provisionable",
			prepare: func(t *testing.T, fixture fixture, grant *protocol.WorkspaceLeaseGrant) {
				grant.Status = "cleaned"
			},
		},
		{
			name: "grant status retained is not provisionable",
			prepare: func(t *testing.T, fixture fixture, grant *protocol.WorkspaceLeaseGrant) {
				grant.Status = "retained"
			},
		},
		{
			name: "grant id is malformed",
			prepare: func(t *testing.T, fixture fixture, grant *protocol.WorkspaceLeaseGrant) {
				grant.ID = "Bad ID"
			},
		},
		{
			name: "grant repository identity is not normalized",
			prepare: func(t *testing.T, fixture fixture, grant *protocol.WorkspaceLeaseGrant) {
				grant.Repository = "https://example.com/x.git"
			},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			fixture := newFixture(t)
			grant := fixture.grant("lease_one", "task_one", "run_one")
			if testCase.prepare != nil {
				testCase.prepare(t, fixture, &grant)
			}
			manager := NewManager([]string{fixture.root}, fixture.git)
			if testCase.manager != nil {
				manager = testCase.manager(t, fixture)
			}
			taskID := testCase.taskID
			if taskID == "" {
				taskID = "task_one"
			}
			outcome := manager.Provision(context.Background(), grant, taskID, "run_one")
			require.Equal(t, "failed", outcome.Status)
			require.NotEmpty(t, outcome.Detail)
			require.Empty(t, outcome.Path)
			requireNoLeaseArtifacts(t, fixture, grant)
			if testCase.verify != nil {
				testCase.verify(t, fixture, grant)
			}
		})
	}
}

func TestManagerWithoutGitRejectsWorktreeLeases(t *testing.T) {
	fixture := newFixture(t)
	manager := NewManager([]string{fixture.root}, nil)
	require.False(t, manager.Supports(protocol.WorkspaceIsolationGitWorktree))
	require.True(t, manager.Supports(protocol.WorkspaceIsolationExclusiveExisting))

	grant := fixture.grant("lease_one", "task_one", "run_one")
	outcome := manager.Provision(context.Background(), grant, "task_one", "run_one")
	require.Equal(t, "failed", outcome.Status)
	requireNoLeaseArtifacts(t, fixture, grant)
}

func TestProvisionMatchesRepositoryIdentityThroughAnyRemote(t *testing.T) {
	t.Run("origin with credentials and a trailing .git suffix matches", func(t *testing.T) {
		fixture := newFixture(t)
		manager := NewManager([]string{fixture.root}, fixture.git)
		grant := fixture.grant("lease_one", "task_one", "run_one")
		outcome := manager.Provision(context.Background(), grant, "task_one", "run_one")
		require.Equal(t, "active", outcome.Status, outcome.Detail)
	})
	t.Run("a second remote with the right identity matches while origin is wrong", func(t *testing.T) {
		fixture := newFixture(t)
		runGit(t, fixture.source, "remote", "set-url", "origin", "https://example.com/cafecito/wrong.git")
		runGit(t, fixture.source, "remote", "add", "upstream", "https://token@example.com/cafecito/project.git")
		manager := NewManager([]string{fixture.root}, fixture.git)
		grant := fixture.grant("lease_one", "task_one", "run_one")
		outcome := manager.Provision(context.Background(), grant, "task_one", "run_one")
		require.Equal(t, "active", outcome.Status, outcome.Detail)
	})
}

func TestProvisionRetainsCollisionsWithoutResettingOrDeletingThem(t *testing.T) {
	cases := []struct {
		name   string
		reason string
		// anyReason allows a set of acceptable retention reasons where the contract names more than one.
		anyReason []string
		prepare   func(t *testing.T, fixture fixture, grant *protocol.WorkspaceLeaseGrant, manager *Manager)
		verify    func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant)
	}{
		{
			name:   "path exists but is not a registered worktree",
			reason: "unregistered",
			prepare: func(t *testing.T, fixture fixture, grant *protocol.WorkspaceLeaseGrant, manager *Manager) {
				require.NoError(t, os.MkdirAll(grant.WorktreePath, 0o755))
				require.NoError(t, os.WriteFile(filepath.Join(grant.WorktreePath, "keep.txt"), []byte("precious"), 0o644))
			},
			verify: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				content, err := os.ReadFile(filepath.Join(grant.WorktreePath, "keep.txt"))
				require.NoError(t, err)
				require.Equal(t, "precious", string(content))
			},
		},
		{
			name:   "the lease branch already exists without its worktree",
			reason: "identity-mismatch",
			prepare: func(t *testing.T, fixture fixture, grant *protocol.WorkspaceLeaseGrant, manager *Manager) {
				runGit(t, fixture.source, "branch", grant.Branch)
			},
			verify: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				require.Equal(t, fixture.base, branchRevision(t, fixture, grant.Branch))
			},
		},
		{
			name:   "a registered worktree at the path is on a different branch",
			reason: "identity-mismatch",
			prepare: func(t *testing.T, fixture fixture, grant *protocol.WorkspaceLeaseGrant, manager *Manager) {
				runGit(t, fixture.source, "worktree", "add", "--quiet", "-b", "other", "--", grant.WorktreePath, "main")
			},
			verify: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				require.Equal(t, 1, countRegisteredWorktrees(t, fixture, grant.WorktreePath))
				require.Equal(t, "other", runGit(t, grant.WorktreePath, "branch", "--show-current"))
			},
		},
		{
			name:   "an exact worktree without the recorded lease identity",
			reason: "identity-mismatch",
			prepare: func(t *testing.T, fixture fixture, grant *protocol.WorkspaceLeaseGrant, manager *Manager) {
				runGit(t, fixture.source, "worktree", "add", "--quiet", "-b", grant.Branch, "--", grant.WorktreePath, "main")
			},
			verify: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				require.Equal(t, 1, countRegisteredWorktrees(t, fixture, grant.WorktreePath))
			},
		},
		{
			name:   "the recorded lease identity names a different lease",
			reason: "identity-mismatch",
			prepare: func(t *testing.T, fixture fixture, grant *protocol.WorkspaceLeaseGrant, manager *Manager) {
				runGit(t, fixture.source, "worktree", "add", "--quiet", "-b", grant.Branch, "--", grant.WorktreePath, "main")
				runGit(t, fixture.source, "config", "--local", "branch."+grant.Branch+".coffeeShopLease", "lease_other")
				runGit(t, fixture.source, "config", "--local", "branch."+grant.Branch+".coffeeShopBase", fixture.base)
			},
			verify: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				require.Equal(t, 1, countRegisteredWorktrees(t, fixture, grant.WorktreePath))
			},
		},
		{
			name:   "the worktree is locked",
			reason: "locked",
			prepare: func(t *testing.T, fixture fixture, grant *protocol.WorkspaceLeaseGrant, manager *Manager) {
				require.Equal(t, "active", manager.Provision(context.Background(), *grant, "task_one", "run_one").Status)
				runGit(t, fixture.source, "worktree", "lock", "--", grant.WorktreePath)
			},
			verify: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				require.DirExists(t, grant.WorktreePath)
			},
		},
		{
			name:   "the hub's resolved base revision differs from the recorded base",
			reason: "identity-mismatch",
			prepare: func(t *testing.T, fixture fixture, grant *protocol.WorkspaceLeaseGrant, manager *Manager) {
				require.Equal(t, "active", manager.Provision(context.Background(), *grant, "task_one", "run_one").Status)
				grant.ResolvedBaseRevision = movedRevision(t, fixture)
			},
			verify: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				require.DirExists(t, grant.WorktreePath)
				require.Equal(t, fixture.base, branchRevision(t, fixture, grant.Branch))
			},
		},
		{
			name:      "the worktree head does not descend from the recorded base",
			anyReason: []string{"identity-mismatch", "ambiguous"},
			prepare: func(t *testing.T, fixture fixture, grant *protocol.WorkspaceLeaseGrant, manager *Manager) {
				require.Equal(t, "active", manager.Provision(context.Background(), *grant, "task_one", "run_one").Status)
				orphan := orphanRevision(t, fixture)
				runGit(t, grant.WorktreePath, "reset", "--hard", orphan)
			},
			verify: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				require.DirExists(t, grant.WorktreePath)
			},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			fixture := newFixture(t)
			manager := NewManager([]string{fixture.root}, fixture.git)
			grant := fixture.grant("lease_one", "task_one", "run_one")
			testCase.prepare(t, fixture, &grant, manager)

			outcome := manager.Provision(context.Background(), grant, "task_one", "run_one")
			require.Equal(t, "retained", outcome.Status)
			if testCase.anyReason != nil {
				require.Contains(t, testCase.anyReason, outcome.RetentionReason)
			} else {
				require.Equal(t, testCase.reason, outcome.RetentionReason)
			}
			testCase.verify(t, fixture, grant)
		})
	}
}

func TestProvisionReplayAdoptsTheExactSameWorktree(t *testing.T) {
	fixture := newFixture(t)
	manager := NewManager([]string{fixture.root}, fixture.git)
	grant := fixture.grant("lease_one", "task_one", "run_one")

	first := manager.Provision(context.Background(), grant, "task_one", "run_one")
	require.Equal(t, "active", first.Status, first.Detail)
	second := manager.Provision(context.Background(), grant, "task_one", "run_one")
	require.Equal(t, "active", second.Status, second.Detail)
	require.Equal(t, first.Path, second.Path)
	require.Equal(t, first.ResolvedBaseRevision, second.ResolvedBaseRevision)
	require.Equal(t, 1, countRegisteredWorktrees(t, fixture, grant.WorktreePath))
}

func TestProvisionReplayAdoptsAfterTheHarnessCommitted(t *testing.T) {
	fixture := newFixture(t)
	manager := NewManager([]string{fixture.root}, fixture.git)
	grant := fixture.grant("lease_one", "task_one", "run_one")
	require.Equal(t, "active", manager.Provision(context.Background(), grant, "task_one", "run_one").Status)

	require.NoError(t, os.WriteFile(filepath.Join(grant.WorktreePath, "README.md"), []byte("harness work\n"), 0o644))
	runGit(t, grant.WorktreePath, "add", "README.md")
	runGit(t, grant.WorktreePath, "commit", "--quiet", "-m", "harness commit")

	outcome := manager.Provision(context.Background(), grant, "task_one", "run_one")
	require.Equal(t, "active", outcome.Status, outcome.Detail)
	require.Equal(t, fixture.base, outcome.ResolvedBaseRevision)
}

func TestProvisionParallelLeasesUseDistinctWorktrees(t *testing.T) {
	fixture := newFixture(t)
	manager := NewManager([]string{fixture.root}, fixture.git)
	firstGrant := fixture.grant("lease_a", "task_a", "run_a")
	secondGrant := fixture.grant("lease_b", "task_b", "run_b")

	outcomes := make([]Outcome, 2)
	var waitGroup sync.WaitGroup
	waitGroup.Add(2)
	go func() {
		defer waitGroup.Done()
		outcomes[0] = manager.Provision(context.Background(), firstGrant, "task_a", "run_a")
	}()
	go func() {
		defer waitGroup.Done()
		outcomes[1] = manager.Provision(context.Background(), secondGrant, "task_b", "run_b")
	}()
	waitGroup.Wait()

	for _, outcome := range outcomes {
		require.Equal(t, "active", outcome.Status, outcome.Detail)
	}
	require.NotEqual(t, outcomes[0].Path, outcomes[1].Path)
	require.False(t, strings.HasPrefix(outcomes[0].Path, outcomes[1].Path+string(filepath.Separator)))
	require.False(t, strings.HasPrefix(outcomes[1].Path, outcomes[0].Path+string(filepath.Separator)))

	output, err := gitOutput(t, fixture.source, "worktree", "list", "--porcelain", "-z")
	require.NoError(t, err)
	worktrees, err := ParseWorktreeList([]byte(output))
	require.NoError(t, err)
	require.Len(t, worktrees, 3)
}

func TestSettledLeaseTombstoneBlocksRecreationAcrossManagers(t *testing.T) {
	fixture := newFixture(t)
	manager := NewManager([]string{fixture.root}, fixture.git)
	grant := fixture.grant("lease_one", "task_one", "run_one")
	require.Equal(t, "active", manager.Provision(context.Background(), grant, "task_one", "run_one").Status)

	grant.Status = "released"
	require.Equal(t, "cleaned", manager.Cleanup(context.Background(), grant, "run_one", ModeRun, nil).Status)

	grant.Status = "requested"
	sameManager := manager.Provision(context.Background(), grant, "task_one", "run_one")
	require.Equal(t, "failed", sameManager.Status)
	require.NoDirExists(t, grant.WorktreePath)

	freshManager := NewManager([]string{fixture.root}, fixture.git)
	replayed := freshManager.Provision(context.Background(), grant, "task_one", "run_one")
	require.Equal(t, "failed", replayed.Status)
	require.NoDirExists(t, grant.WorktreePath)
	require.FileExists(t, filepath.Join(fixture.root, ".coffee-shop", "tombstones", grant.ID))
}

func TestProvisionReplayKeepsTheRecordedBaseWhenMainMoves(t *testing.T) {
	fixture := newFixture(t)
	manager := NewManager([]string{fixture.root}, fixture.git)
	grant := fixture.grant("lease_one", "task_one", "run_one")
	require.Equal(t, "active", manager.Provision(context.Background(), grant, "task_one", "run_one").Status)

	runGit(t, fixture.source, "commit", "--quiet", "--allow-empty", "-m", "main moved on")
	grant.ResolvedBaseRevision = fixture.base

	outcome := manager.Provision(context.Background(), grant, "task_one", "run_one")
	require.Equal(t, "active", outcome.Status, outcome.Detail)
	require.Equal(t, fixture.base, outcome.ResolvedBaseRevision)
}

func TestCleanupMatrix(t *testing.T) {
	cases := []struct {
		name          string
		cleanupPolicy string
		mode          string
		grantStatus   string
		preProvision  func(t *testing.T, fixture fixture, grant *protocol.WorkspaceLeaseGrant)
		prepare       func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant)
		outcomeStatus string
		reason        string
		mutations     int
		verify        func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant)
	}{
		{
			name:          "clean worktree is removed",
			outcomeStatus: "cleaned",
			mutations:     1,
			verify: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				requireNoLeaseArtifacts(t, fixture, grant)
			},
		},
		{
			name: "modified tracked file",
			prepare: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				require.NoError(t, os.WriteFile(filepath.Join(grant.WorktreePath, "README.md"), []byte("changed\n"), 0o644))
			},
			outcomeStatus: "retained", reason: "dirty",
			verify: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				require.DirExists(t, grant.WorktreePath)
			},
		},
		{
			name: "staged change only",
			prepare: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				require.NoError(t, os.WriteFile(filepath.Join(grant.WorktreePath, "README.md"), []byte("staged\n"), 0o644))
				runGit(t, grant.WorktreePath, "add", "README.md")
			},
			outcomeStatus: "retained", reason: "dirty",
			verify: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				require.DirExists(t, grant.WorktreePath)
			},
		},
		{
			name: "untracked file only",
			prepare: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				require.NoError(t, os.WriteFile(filepath.Join(grant.WorktreePath, "notes.txt"), []byte("scratch\n"), 0o644))
			},
			outcomeStatus: "retained", reason: "untracked",
			verify: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				require.DirExists(t, grant.WorktreePath)
			},
		},
		{
			name: "ignored file only is retained, never deleted",
			preProvision: func(t *testing.T, fixture fixture, grant *protocol.WorkspaceLeaseGrant) {
				require.NoError(t, os.WriteFile(filepath.Join(fixture.source, ".gitignore"), []byte("*.env\n"), 0o644))
				runGit(t, fixture.source, "add", ".gitignore")
				runGit(t, fixture.source, "commit", "--quiet", "-m", "ignore environment files")
			},
			prepare: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				require.NoError(t, os.WriteFile(filepath.Join(grant.WorktreePath, "secrets.env"), []byte("TOKEN=value\n"), 0o600))
			},
			outcomeStatus: "retained", reason: "untracked",
			verify: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				content, err := os.ReadFile(filepath.Join(grant.WorktreePath, "secrets.env"))
				require.NoError(t, err)
				require.Equal(t, "TOKEN=value\n", string(content))
			},
		},
		{
			name: "a new commit on the lease branch",
			prepare: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				require.NoError(t, os.WriteFile(filepath.Join(grant.WorktreePath, "README.md"), []byte("committed\n"), 0o644))
				runGit(t, grant.WorktreePath, "add", "README.md")
				runGit(t, grant.WorktreePath, "commit", "--quiet", "-m", "lease work")
			},
			outcomeStatus: "retained", reason: "diverged",
			verify: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				require.DirExists(t, grant.WorktreePath)
				require.Equal(t, runGit(t, grant.WorktreePath, "rev-parse", "HEAD"), branchRevision(t, fixture, grant.Branch))
			},
		},
		{
			name: "locked worktree",
			prepare: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				runGit(t, fixture.source, "worktree", "lock", "--", grant.WorktreePath)
			},
			outcomeStatus: "retained", reason: "locked",
			verify: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				require.DirExists(t, grant.WorktreePath)
			},
		},
		{
			name: "worktree directory deleted but still registered",
			prepare: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				require.NoError(t, os.RemoveAll(grant.WorktreePath))
			},
			outcomeStatus: "retained", reason: "ambiguous",
			verify: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				require.Equal(t, fixture.base, branchRevision(t, fixture, grant.Branch))
			},
		},
		{
			name: "unregistered directory at the worktree path",
			prepare: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				runGit(t, fixture.source, "worktree", "remove", "--", grant.WorktreePath)
				require.NoError(t, os.MkdirAll(grant.WorktreePath, 0o755))
				require.NoError(t, os.WriteFile(filepath.Join(grant.WorktreePath, "operator.txt"), []byte("kept\n"), 0o644))
			},
			outcomeStatus: "retained", reason: "unregistered",
			verify: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				require.DirExists(t, grant.WorktreePath)
				require.FileExists(t, filepath.Join(grant.WorktreePath, "operator.txt"))
			},
		},
		{
			name: "worktree config recorded for another lease",
			prepare: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				runGit(t, fixture.source, "config", "--local", "branch."+grant.Branch+".coffeeShopLease", "lease_other")
			},
			outcomeStatus: "retained", reason: "identity-mismatch",
			verify: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				require.DirExists(t, grant.WorktreePath)
			},
		},
		{
			name: "source repository renamed away",
			prepare: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				require.NoError(t, os.Rename(fixture.source, fixture.source+"-gone"))
			},
			outcomeStatus: "retained", reason: "identity-mismatch",
			verify: func(t *testing.T, fixture fixture, grant protocol.WorkspaceLeaseGrant) {
				require.DirExists(t, grant.WorktreePath)
			},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			fixture := newFixture(t)
			manager := NewManager([]string{fixture.root}, fixture.git)
			grant := fixture.grant("lease_one", "task_one", "run_one")
			if testCase.preProvision != nil {
				testCase.preProvision(t, fixture, &grant)
			}
			require.Equal(t, "active", manager.Provision(context.Background(), grant, "task_one", "run_one").Status)
			if testCase.cleanupPolicy != "" {
				grant.Cleanup = testCase.cleanupPolicy
			}
			if testCase.prepare != nil {
				testCase.prepare(t, fixture, grant)
			}
			grant.Status = "released"
			if testCase.grantStatus != "" {
				grant.Status = testCase.grantStatus
			}
			mode := testCase.mode
			if mode == "" {
				mode = ModeRun
			}
			mutations := 0
			outcome := manager.Cleanup(context.Background(), grant, "run_one", mode, func() { mutations++ })
			require.Equal(t, testCase.outcomeStatus, outcome.Status, outcome.Detail)
			require.Equal(t, testCase.reason, outcome.RetentionReason)
			require.Equal(t, testCase.mutations, mutations)
			if testCase.verify != nil {
				testCase.verify(t, fixture, grant)
			}
		})
	}
}

func TestCleanupHonorsTheRetainPolicyOutsideOperatorMode(t *testing.T) {
	fixture := newFixture(t)
	manager := NewManager([]string{fixture.root}, fixture.git)
	grant := fixture.grant("lease_one", "task_one", "run_one")
	grant.Cleanup = protocol.WorkspaceCleanupRetain
	require.Equal(t, "active", manager.Provision(context.Background(), grant, "task_one", "run_one").Status)
	grant.Status = "released"

	for _, mode := range []string{ModeRun, ModeReconcile} {
		mutations := 0
		outcome := manager.Cleanup(context.Background(), grant, "run_one", mode, func() { mutations++ })
		require.Equal(t, "retained", outcome.Status, outcome.Detail)
		require.Equal(t, "policy", outcome.RetentionReason)
		require.Zero(t, mutations)
		require.DirExists(t, grant.WorktreePath)
		require.NotEmpty(t, branchRevision(t, fixture, grant.Branch))
	}

	outcome := manager.Cleanup(context.Background(), grant, "run_one", ModeOperator, nil)
	require.Equal(t, "cleaned", outcome.Status, outcome.Detail)
	requireNoLeaseArtifacts(t, fixture, grant)
}

func TestCleanupOfNothingExistsReportsFailedOnlyForUnstartedLeases(t *testing.T) {
	t.Run("requested lease", func(t *testing.T) {
		fixture := newFixture(t)
		manager := NewManager([]string{fixture.root}, fixture.git)
		grant := fixture.grant("lease_one", "task_one", "run_one")
		mutations := 0
		outcome := manager.Cleanup(context.Background(), grant, "run_one", ModeRun, func() { mutations++ })
		require.Equal(t, "failed", outcome.Status, outcome.Detail)
		require.Zero(t, mutations)
	})
	t.Run("active lease", func(t *testing.T) {
		fixture := newFixture(t)
		manager := NewManager([]string{fixture.root}, fixture.git)
		grant := fixture.grant("lease_one", "task_one", "run_one")
		grant.Status = "active"
		mutations := 0
		outcome := manager.Cleanup(context.Background(), grant, "run_one", ModeRun, func() { mutations++ })
		require.Equal(t, "cleaned", outcome.Status, outcome.Detail)
		require.Zero(t, mutations)
	})
}

func TestCleanupRemovesALeftoverBranchAtBaseAndRetainsADivergedOne(t *testing.T) {
	t.Run("branch at its base revision", func(t *testing.T) {
		fixture := newFixture(t)
		manager := NewManager([]string{fixture.root}, fixture.git)
		grant := fixture.grant("lease_one", "task_one", "run_one")
		require.Equal(t, "active", manager.Provision(context.Background(), grant, "task_one", "run_one").Status)
		runGit(t, fixture.source, "worktree", "remove", "--", grant.WorktreePath)

		grant.Status = "released"
		outcome := manager.Cleanup(context.Background(), grant, "run_one", ModeRun, nil)
		require.Equal(t, "cleaned", outcome.Status, outcome.Detail)
		requireNoLeaseArtifacts(t, fixture, grant)
	})
	t.Run("branch with an extra commit", func(t *testing.T) {
		fixture := newFixture(t)
		manager := NewManager([]string{fixture.root}, fixture.git)
		grant := fixture.grant("lease_one", "task_one", "run_one")
		require.Equal(t, "active", manager.Provision(context.Background(), grant, "task_one", "run_one").Status)
		require.NoError(t, os.WriteFile(filepath.Join(grant.WorktreePath, "README.md"), []byte("committed\n"), 0o644))
		runGit(t, grant.WorktreePath, "add", "README.md")
		runGit(t, grant.WorktreePath, "commit", "--quiet", "-m", "lease work")
		tip := runGit(t, grant.WorktreePath, "rev-parse", "HEAD")
		runGit(t, fixture.source, "worktree", "remove", "--", grant.WorktreePath)

		grant.Status = "released"
		outcome := manager.Cleanup(context.Background(), grant, "run_one", ModeRun, nil)
		require.Equal(t, "retained", outcome.Status, outcome.Detail)
		require.Equal(t, "diverged", outcome.RetentionReason)
		require.Equal(t, tip, branchRevision(t, fixture, grant.Branch))
	})
}

func TestCleanupIsIdempotent(t *testing.T) {
	fixture := newFixture(t)
	manager := NewManager([]string{fixture.root}, fixture.git)
	grant := fixture.grant("lease_one", "task_one", "run_one")
	require.Equal(t, "active", manager.Provision(context.Background(), grant, "task_one", "run_one").Status)

	grant.Status = "released"
	require.Equal(t, "cleaned", manager.Cleanup(context.Background(), grant, "run_one", ModeRun, nil).Status)
	again := manager.Cleanup(context.Background(), grant, "run_one", ModeRun, nil)
	require.Equal(t, "cleaned", again.Status, again.Detail)
	requireNoLeaseArtifacts(t, fixture, grant)
}

func TestExclusiveExistingLeases(t *testing.T) {
	fixture := newFixture(t)
	manager := NewManager([]string{fixture.root}, fixture.git)
	firstGrant := protocol.WorkspaceLeaseGrant{
		ID: "lease_ex_one", Status: "requested",
		Policy: protocol.WorkspaceIsolationExclusiveExisting, Cleanup: protocol.WorkspaceCleanupWhenUnchanged,
		Root: fixture.root, SourcePath: fixture.source, WorktreePath: fixture.source,
	}
	outcome := manager.Provision(context.Background(), firstGrant, "task_one", "run_one")
	require.Equal(t, "active", outcome.Status, outcome.Detail)
	require.Equal(t, fixture.source, outcome.Path)

	secondGrant := firstGrant
	secondGrant.ID = "lease_ex_two"
	second := manager.Provision(context.Background(), secondGrant, "task_two", "run_two")
	require.Equal(t, "failed", second.Status)
	require.NotEmpty(t, second.Detail)

	firstGrant.Status = "released"
	require.Equal(t, "cleaned", manager.Cleanup(context.Background(), firstGrant, "run_one", ModeRun, nil).Status)

	secondGrant.Status = "requested"
	retry := manager.Provision(context.Background(), secondGrant, "task_two", "run_two")
	require.Equal(t, "active", retry.Status, retry.Detail)
	require.Equal(t, fixture.source, retry.Path)
	require.NoDirExists(t, filepath.Join(fixture.root, ".coffee-shop"))
}

func TestExclusiveExistingRejectsASymbolicLinkedSource(t *testing.T) {
	fixture := newFixture(t)
	manager := NewManager([]string{fixture.root}, fixture.git)
	link := filepath.Join(fixture.root, "link")
	require.NoError(t, os.Symlink(fixture.source, link))
	grant := protocol.WorkspaceLeaseGrant{
		ID: "lease_ex_one", Status: "requested",
		Policy: protocol.WorkspaceIsolationExclusiveExisting, Cleanup: protocol.WorkspaceCleanupWhenUnchanged,
		Root: fixture.root, SourcePath: link, WorktreePath: link,
	}
	outcome := manager.Provision(context.Background(), grant, "task_one", "run_one")
	require.Equal(t, "failed", outcome.Status)
	require.NotEmpty(t, outcome.Detail)
	require.Empty(t, outcome.Path)
}
