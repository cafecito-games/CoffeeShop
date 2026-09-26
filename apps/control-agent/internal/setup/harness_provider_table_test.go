package setup_test

// This test lives in the external setup_test package, not in package setup, because it reads
// internal/harness's compiled-in provider table and internal/harness now depends on
// internal/capabilitypack, which depends on internal/setup. An in-package test importing
// internal/harness would therefore close an import cycle; an external test package cannot.

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/harness"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/setup"
)

// shippedHarnessIDs is the set of harnesses the embedded manifest is expected to manage.
var shippedHarnessIDs = []string{"claude-cli", "codex-cli"}

func embeddedManifest(t *testing.T) setup.Manifest {
	t.Helper()
	manifest, err := setup.LoadDefaultManifest()
	require.NoError(t, err)
	return manifest
}

func harnessEntry(t *testing.T, manifest setup.Manifest, id string) setup.ComponentManifestEntry {
	t.Helper()
	for _, entry := range manifest.ComponentsOfKind(setup.ComponentKindHarness) {
		if entry.ID == id {
			return entry
		}
	}
	t.Fatalf("the embedded manifest declares no harness component %q", id)
	return setup.ComponentManifestEntry{}
}

// TestEmbeddedManifestDeclaresHarnessDistributions proves the shipped manifest really does manage
// both harnesses, and that each one is wired to every compiled-in table it needs: a harness with no
// provider-table identity can never be resolved, and one with no version-probe entry can never be
// activated, so an entry missing from either would be dead weight that looks supported.
func TestEmbeddedManifestDeclaresHarnessDistributions(t *testing.T) {
	manifest := embeddedManifest(t)
	harnesses := manifest.ComponentsOfKind(setup.ComponentKindHarness)
	require.Len(t, harnesses, len(shippedHarnessIDs), "exactly one harness entry per supported harness")

	// Discovery's compiled-in provider table, read through its own public projection so this test
	// cannot drift from the table the daemon actually uses. PATH is emptied first so no real vendor
	// CLI on the implementation machine is executed by a unit test.
	t.Setenv("PATH", t.TempDir())
	providerIDs := []string{}
	for _, profile := range harness.Profiles(harness.Resolve(context.Background(), nil)) {
		providerIDs = append(providerIDs, profile.ID)
	}

	seen := []string{}
	for _, entry := range harnesses {
		seen = append(seen, entry.ID)
		require.Equal(t, entry.ID, entry.HarnessID, "%s: a harness component is its own harness", entry.ID)
		require.Contains(t, shippedHarnessIDs, entry.ID)
		require.Contains(t, providerIDs, entry.HarnessID, "%s has no identity in the compiled-in provider table", entry.ID)
		_, probeable := setup.HarnessVersionProbeAllowlist[entry.HarnessID]
		require.True(t, probeable, "%s has no compiled-in version contract, so it could never be activated", entry.ID)
		require.Empty(t, entry.Launch.Arguments, "%s: native execution builds its own arguments", entry.ID)
		require.Empty(t, entry.Launch.Environment, "%s: native execution builds its own environment", entry.ID)
		require.True(t, protocol.IsNormalizedVersion(entry.Version))
		require.NotEmpty(t, entry.Provider)
	}
	for _, id := range shippedHarnessIDs {
		require.Contains(t, seen, id)
	}
	require.Equal(t, "anthropic", harnessEntry(t, manifest, "claude-cli").Provider)
	require.Equal(t, "openai", harnessEntry(t, manifest, "codex-cli").Provider)
}
