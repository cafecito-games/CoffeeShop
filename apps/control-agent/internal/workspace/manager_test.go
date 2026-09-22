package workspace

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

const testRepository = "https://example.com/cafecito/project"

type fixture struct {
	root   string
	source string
	git    *Git
	base   string
}

func runGit(t *testing.T, directory string, arguments ...string) string {
	t.Helper()
	command := exec.Command("git", append([]string{"-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"}, arguments...)...)
	command.Dir = directory
	output, err := command.CombinedOutput()
	require.NoError(t, err, string(output))
	return strings.TrimSpace(string(output))
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	git, err := FindGit()
	if err != nil {
		t.Skip("git is not installed")
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	require.NoError(t, err)
	source := filepath.Join(root, "project")
	require.NoError(t, os.Mkdir(source, 0o755))
	runGit(t, source, "init", "--quiet")
	require.NoError(t, os.WriteFile(filepath.Join(source, "README.md"), []byte("hello\n"), 0o644))
	runGit(t, source, "add", "README.md")
	runGit(t, source, "commit", "--quiet", "-m", "initial")
	runGit(t, source, "remote", "add", "origin", "https://token@example.com/cafecito/project.git")
	return fixture{root: root, source: source, git: git, base: runGit(t, source, "rev-parse", "HEAD")}
}

func (fixture fixture) grant(leaseID, taskID, runID string) protocol.WorkspaceLeaseGrant {
	return protocol.WorkspaceLeaseGrant{
		ID:           leaseID,
		Status:       "requested",
		Policy:       protocol.WorkspaceIsolationGitWorktree,
		Cleanup:      protocol.WorkspaceCleanupWhenUnchanged,
		Repository:   testRepository,
		Root:         fixture.root,
		SourcePath:   fixture.source,
		BaseRevision: "refs/heads/main",
		Branch:       protocol.WorkspaceLeaseBranch(taskID, runID),
		WorktreePath: filepath.Join(fixture.root, ".coffee-shop", "worktrees", leaseID),
	}
}

func TestProvisionCreatesAdoptsAndCleansAnExactWorktree(t *testing.T) {
	fixture := newFixture(t)
	manager := NewManager([]string{fixture.root}, fixture.git)
	grant := fixture.grant("lease_one", "task_one", "run_one")

	outcome := manager.Provision(context.Background(), grant, "task_one", "run_one")
	require.Equal(t, "active", outcome.Status, outcome.Detail)
	require.Equal(t, grant.WorktreePath, outcome.Path)
	require.Equal(t, fixture.base, outcome.ResolvedBaseRevision)
	require.Equal(t, "refs/heads/coffee-shop/task_one/run_one", runGit(t, grant.WorktreePath, "symbolic-ref", "HEAD"))

	replay := manager.Provision(context.Background(), grant, "task_one", "run_one")
	require.Equal(t, "active", replay.Status, replay.Detail)

	grant.Status = "released"
	cleaned := manager.Cleanup(context.Background(), grant, "run_one", ModeRun, nil)
	require.Equal(t, "cleaned", cleaned.Status, cleaned.Detail)
	require.NoDirExists(t, grant.WorktreePath)
	require.Empty(t, runGit(t, fixture.source, "branch", "--list", "coffee-shop/*"))

	grant.Status = "requested"
	resurrected := manager.Provision(context.Background(), grant, "task_one", "run_one")
	require.Equal(t, "failed", resurrected.Status)
	require.NoDirExists(t, grant.WorktreePath)
}

func TestCleanupRetainsDirtyWorktree(t *testing.T) {
	fixture := newFixture(t)
	manager := NewManager([]string{fixture.root}, fixture.git)
	grant := fixture.grant("lease_two", "task_two", "run_two")
	require.Equal(t, "active", manager.Provision(context.Background(), grant, "task_two", "run_two").Status)
	require.NoError(t, os.WriteFile(filepath.Join(grant.WorktreePath, "README.md"), []byte("changed\n"), 0o644))
	grant.Status = "released"
	outcome := manager.Cleanup(context.Background(), grant, "run_two", ModeRun, nil)
	require.Equal(t, "retained", outcome.Status)
	require.Equal(t, "dirty", outcome.RetentionReason)
	require.DirExists(t, grant.WorktreePath)
}
