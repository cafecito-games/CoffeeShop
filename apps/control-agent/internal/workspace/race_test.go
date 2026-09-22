package workspace

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestManagedDirectoriesAreCreatedPrivate(t *testing.T) {
	fixture := newFixture(t)
	manager := NewManager([]string{fixture.root}, fixture.git)
	grant := fixture.grant("lease_one", "task_one", "run_one")
	require.Equal(t, "active", manager.Provision(context.Background(), grant, "task_one", "run_one").Status)
	for _, directory := range []string{filepath.Join(fixture.root, ".coffee-shop"), filepath.Dir(grant.WorktreePath), grant.WorktreePath} {
		information, err := os.Lstat(directory)
		require.NoError(t, err)
		require.Equal(t, os.FileMode(0o700), information.Mode().Perm(), directory)
	}
}

func TestProvisionRefusesALeafSwappedForASymbolicLinkBeforeCheckout(t *testing.T) {
	fixture := newFixture(t)
	outside := t.TempDir()
	manager := NewManager([]string{fixture.root}, fixture.git)
	manager.interleave = func(step string, path string) {
		if step != "leaf-created" {
			return
		}
		require.NoError(t, os.Remove(path))
		require.NoError(t, os.Symlink(outside, path))
	}
	grant := fixture.grant("lease_one", "task_one", "run_one")

	outcome := manager.Provision(context.Background(), grant, "task_one", "run_one")
	require.Equal(t, "retained", outcome.Status, outcome.Detail)
	require.Equal(t, "identity-mismatch", outcome.RetentionReason)
	entries, err := os.ReadDir(outside)
	require.NoError(t, err)
	require.Empty(t, entries, "nothing may be checked out through the swapped link")
	require.Empty(t, runGit(t, fixture.source, "branch", "--list", "coffee-shop/*"))
}

func TestProvisionRetainsAWorktreeRedirectedOutsideTheRootAfterCheckout(t *testing.T) {
	fixture := newFixture(t)
	outside := filepath.Join(t.TempDir(), "moved")
	manager := NewManager([]string{fixture.root}, fixture.git)
	manager.interleave = func(step string, path string) {
		if step != "worktree-added" {
			return
		}
		require.NoError(t, os.Rename(path, outside))
		require.NoError(t, os.Symlink(outside, path))
	}
	grant := fixture.grant("lease_one", "task_one", "run_one")

	outcome := manager.Provision(context.Background(), grant, "task_one", "run_one")
	require.Equal(t, "retained", outcome.Status, outcome.Detail)
	require.Contains(t, []string{"ambiguous", "identity-mismatch"}, outcome.RetentionReason)
	require.Empty(t, outcome.Path)

	manager.interleave = nil
	grant.Status = "retained"
	cleanup := manager.Cleanup(context.Background(), grant, "run_one", ModeOperator, nil)
	require.Equal(t, "retained", cleanup.Status, cleanup.Detail)
	require.FileExists(t, filepath.Join(outside, "README.md"), "nothing outside the root may be deleted")
}

func TestAdoptionRejectsAWorktreeWhoseGitFilePointsElsewhere(t *testing.T) {
	fixture := newFixture(t)
	manager := NewManager([]string{fixture.root}, fixture.git)
	grant := fixture.grant("lease_one", "task_one", "run_one")
	require.Equal(t, "active", manager.Provision(context.Background(), grant, "task_one", "run_one").Status)

	other := newFixture(t)
	foreign := filepath.Join(other.root, "foreign")
	runGit(t, other.source, "worktree", "add", "--quiet", "--detach", "--", foreign, "main")
	foreignGitFile, err := os.ReadFile(filepath.Join(foreign, ".git"))
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(grant.WorktreePath, ".git"), foreignGitFile, 0o644))

	outcome := manager.Provision(context.Background(), grant, "task_one", "run_one")
	require.Equal(t, "retained", outcome.Status, outcome.Detail)
	require.Equal(t, "identity-mismatch", outcome.RetentionReason)

	grant.Status = "released"
	cleanup := manager.Cleanup(context.Background(), grant, "run_one", ModeRun, nil)
	require.Equal(t, "retained", cleanup.Status, cleanup.Detail)
	require.DirExists(t, grant.WorktreePath)
}

func TestProvisionRemovesItsOwnEmptyLeafWhenCheckoutFails(t *testing.T) {
	fixture := newFixture(t)
	manager := NewManager([]string{fixture.root}, fixture.git)
	grant := fixture.grant("lease_one", "task_one", "run_one")
	manager.interleave = func(step string, path string) {
		if step == "leaf-created" {
			runGit(t, fixture.source, "branch", grant.Branch)
		}
	}
	outcome := manager.Provision(context.Background(), grant, "task_one", "run_one")
	require.Equal(t, "retained", outcome.Status, outcome.Detail)
	require.NoDirExists(t, grant.WorktreePath, "the empty directory Barista created is removed")
	require.Equal(t, fixture.base, runGit(t, fixture.source, "rev-parse", "refs/heads/"+grant.Branch), "a branch Barista did not create is kept")

	grant.Status = "retained"
	cleanup := manager.Cleanup(context.Background(), grant, "run_one", ModeOperator, nil)
	require.Equal(t, "retained", cleanup.Status, cleanup.Detail)
	require.Equal(t, fixture.base, runGit(t, fixture.source, "rev-parse", "refs/heads/"+grant.Branch), "cleanup never deletes a branch the lease cannot prove it owns")
}
