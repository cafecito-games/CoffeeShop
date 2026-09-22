package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

func TestLeaseOwnershipExcludesASecondManagerUntilReleased(t *testing.T) {
	fixture := newFixture(t)
	running := NewManager([]string{fixture.root}, fixture.git)
	replacement := NewManager([]string{fixture.root}, fixture.git)
	grant := fixture.grant("lease_one", "task_one", "run_one")

	release, err := running.Own(grant)
	require.NoError(t, err)
	require.Equal(t, "active", running.Provision(context.Background(), grant, "task_one", "run_one").Status)
	information, err := os.Lstat(filepath.Join(fixture.root, ".coffee-shop", "leases"))
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0o700), information.Mode().Perm())

	_, err = replacement.Own(grant)
	require.ErrorIs(t, err, ErrLeaseOwned, "a second process may not own a lease the first still holds")
	_, err = running.Own(grant)
	require.ErrorIs(t, err, ErrLeaseOwned)
	require.DirExists(t, grant.WorktreePath)

	release()
	release()
	takeover, err := replacement.Own(grant)
	require.NoError(t, err)
	defer takeover()
	grant.Status = "active"
	require.Equal(t, "cleaned", replacement.Cleanup(context.Background(), grant, "run_one", ModeReconcile, nil).Status)
	require.NoDirExists(t, grant.WorktreePath)
}

func TestLeaseOwnershipRefusesAnUnsafeLockLocation(t *testing.T) {
	fixture := newFixture(t)
	manager := NewManager([]string{fixture.root}, fixture.git)
	grant := fixture.grant("lease_one", "task_one", "run_one")
	outside := t.TempDir()
	require.NoError(t, os.Mkdir(filepath.Join(fixture.root, ".coffee-shop"), 0o700))
	require.NoError(t, os.Symlink(outside, filepath.Join(fixture.root, ".coffee-shop", "leases")))

	_, err := manager.Own(grant)
	require.Error(t, err)
	require.False(t, errors.Is(err, ErrLeaseOwned))
	entries, readErr := os.ReadDir(outside)
	require.NoError(t, readErr)
	require.Empty(t, entries)

	lockDirectory := filepath.Join(fixture.root, ".coffee-shop", "leases")
	require.NoError(t, os.Remove(lockDirectory))
	require.NoError(t, os.Mkdir(lockDirectory, 0o700))
	require.NoError(t, os.Symlink(filepath.Join(outside, "target"), filepath.Join(lockDirectory, grant.ID+".lock")))
	_, err = manager.Own(grant)
	require.Error(t, err, "a lock file that is a symbolic link is never followed")
	require.NoFileExists(t, filepath.Join(outside, "target"))
}

func TestLeaseOwnershipRejectsAnUnauthorizedRoot(t *testing.T) {
	fixture := newFixture(t)
	manager := NewManager([]string{t.TempDir()}, fixture.git)
	_, err := manager.Own(fixture.grant("lease_one", "task_one", "run_one"))
	require.Error(t, err)
	require.NoDirExists(t, filepath.Join(fixture.root, ".coffee-shop"))
}

func TestExclusiveLeaseOwnershipCreatesNoManagedDirectory(t *testing.T) {
	fixture := newFixture(t)
	manager := NewManager([]string{fixture.root}, fixture.git)
	release, err := manager.Own(protocol.WorkspaceLeaseGrant{ID: "lease_ex", Policy: protocol.WorkspaceIsolationExclusiveExisting, Root: fixture.root})
	require.NoError(t, err)
	release()
	require.NoDirExists(t, filepath.Join(fixture.root, ".coffee-shop"))
}
