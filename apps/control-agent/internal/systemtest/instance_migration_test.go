//go:build system && unix

package systemtest

import (
	"os"
	"path/filepath"
	"testing"
)

// TestLegacyInstanceMigration crosses the production COFFEE_SHOP_DATA -> SQLite startup path. The
// source fixture predates orchestration and v5; the current Hub must add the complete triplet and
// import one template, then treat SQLite as authoritative on every later restart.
func TestLegacyInstanceMigration(t *testing.T) {
	t.Parallel()
	legacy := filepath.Join(repositoryRoot, "apps", "hub", "test-fixtures", "state-before-external-orchestrators.json")
	cluster := newEnvironment(t, environmentOptions{legacyStatePath: legacy})

	first := cluster.hub.snapshot()
	if len(first.Agents) != 1 || len(first.Threads) != 1 || len(first.Templates) != 1 {
		t.Fatalf("legacy import did not preserve history and import one template: agents=%d threads=%d templates=%d", len(first.Agents), len(first.Threads), len(first.Templates))
	}
	if first.Instances == nil || first.Allocations == nil || first.Templates == nil {
		t.Fatal("legacy import did not publish the all-present v5 triplet")
	}
	if first.Templates[0].LegacyAgentID != first.Agents[0].ID {
		t.Fatalf("template provenance was not preserved: %+v", first.Templates[0])
	}

	// If the Hub consulted JSON again this valid-but-empty source would erase the imported history.
	legacyPath := filepath.Join(cluster.root, "hub", "state.json")
	if err := os.WriteFile(legacyPath, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cluster.hub.restart()
	second := cluster.hub.snapshot()
	if len(second.Agents) != len(first.Agents) || len(second.Threads) != len(first.Threads) || len(second.Templates) != len(first.Templates) {
		t.Fatalf("restart re-imported JSON instead of authoritative SQLite: before=%d/%d/%d after=%d/%d/%d",
			len(first.Agents), len(first.Threads), len(first.Templates), len(second.Agents), len(second.Threads), len(second.Templates))
	}
	if second.Templates[0].ID != first.Templates[0].ID || second.Templates[0].LegacyAgentID != first.Templates[0].LegacyAgentID {
		t.Fatalf("restart duplicated or rewrote the legacy template: before=%+v after=%+v", first.Templates[0], second.Templates[0])
	}
}
