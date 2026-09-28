//go:build system && unix

package systemtest

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// removeHubInstanceAuthority simulates restoring a valid Hub database that no longer owns the
// machine-local resident. It edits the one opaque state_json row while the real Hub is stopped; the
// next real startup and v5 reconnect must treat the Barista report as unknown rather than adopt it.
func removeHubInstanceAuthority(t *testing.T, databasePath string) {
	t.Helper()
	script := `
import { DatabaseSync } from "node:sqlite";
const database = new DatabaseSync(process.argv[1]);
const row = database.prepare("SELECT state_json FROM hub_state WHERE singleton = 1").get();
if (!row) throw new Error("hub state row is absent");
const state = JSON.parse(row.state_json);
state.instances = [];
state.allocations = [];
state.instanceLifecycleReceipts = [];
state.instanceReleaseIntents = [];
state.instanceDeliveries = [];
state.remoteReleaseRequests = [];
database.prepare("UPDATE hub_state SET state_json = ?, updated_at = ? WHERE singleton = 1")
  .run(JSON.stringify(state), "2026-09-28T12:00:00.000Z");
database.close();`
	command := exec.Command("node", "--input-type=module", "--eval", script, databasePath)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("remove Hub instance authority: %v\n%s", err, output)
	}
}

func TestInvalidCurrentInstanceStateFailsBeforeListen(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	databasePath := filepath.Join(root, "coffee-shop.sqlite")
	fixture := `{
  "agents":[],"nodes":[],"runs":[],"events":[],"messages":[],"threads":[],"delegations":[],"artifacts":[],
  "instances":[],
  "allocations":[{"id":"allocation-invalid","instanceId":"instance-missing","nodeId":"node-missing","harnessId":"claude-cli","model":"default","transport":"native-cli","workspace":"/workspace","lease":{"idleTimeoutSeconds":1800,"expiresAt":"2026-09-28T12:30:00.000Z"},"status":"active","createdAt":"2026-09-28T12:00:00.000Z","updatedAt":"2026-09-28T12:00:00.000Z"}],
  "templates":[]
}`
	seed := `
import { DatabaseSync } from "node:sqlite";
const database = new DatabaseSync(process.argv[1]);
database.exec("CREATE TABLE hub_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), state_json TEXT NOT NULL, updated_at TEXT NOT NULL)");
database.prepare("INSERT INTO hub_state (singleton, state_json, updated_at) VALUES (1, ?, ?)").run(process.argv[2], "2026-09-28T12:00:00.000Z");
database.close();`
	if output, err := exec.Command("node", "--input-type=module", "--eval", seed, databasePath, fixture).CombinedOutput(); err != nil {
		t.Fatalf("seed malformed current database: %v\n%s", err, output)
	}
	profiles := filepath.Join(root, "project-profiles.json")
	if err := os.WriteFile(profiles, []byte("{\"profiles\":[]}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(root, "home")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "node", "--import", "tsx", "src/index.ts")
	command.Dir = filepath.Join(repositoryRoot, "apps", "hub")
	command.Env = []string{
		"PATH=" + os.Getenv("PATH"), "HOME=" + home, "NODE_ENV=production", "PORT=0",
		"COFFEE_SHOP_TOKEN=" + enrollmentToken, "COFFEE_SHOP_DATABASE=" + databasePath,
		"COFFEE_SHOP_DATA=" + filepath.Join(root, "legacy.json"), "PROJECT_PROFILES_PATH=" + profiles,
	}
	output, err := command.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatalf("invalid current state did not fail startup within the bound:\n%s", output)
	}
	if err == nil {
		t.Fatalf("invalid current state unexpectedly started the Hub:\n%s", output)
	}
	log := string(output)
	if strings.Contains(log, "Coffee Shop hub listening") || !strings.Contains(strings.ToLower(log), "allocation") {
		t.Fatalf("invalid current state did not fail closed before listen with an allocation diagnostic:\n%s", log)
	}
}

// TestLegacyInstanceMigration crosses the production COFFEE_SHOP_DATA -> SQLite startup path. The
// source fixture predates orchestration and v5; the current Hub must add the complete triplet,
// promote its agent-owned thread once, and treat SQLite as authoritative on every later restart.
func TestLegacyInstanceMigration(t *testing.T) {
	t.Parallel()
	legacy := filepath.Join(repositoryRoot, "apps", "hub", "test-fixtures", "state-before-external-orchestrators.json")
	cluster := newEnvironment(t, environmentOptions{legacyStatePath: legacy})

	first := cluster.hub.snapshot()
	if len(first.Agents) != 1 || len(first.Threads) != 1 || len(first.Templates) != 0 {
		t.Fatalf("legacy import did not preserve its producer history: agents=%d threads=%d templates=%d", len(first.Agents), len(first.Threads), len(first.Templates))
	}
	if first.Instances == nil || first.Allocations == nil || first.Templates == nil {
		t.Fatal("legacy import did not publish the all-present v5 triplet")
	}
	if len(first.Threads) != 1 || first.Threads[0].Orchestrator["kind"] != "agent" || first.Threads[0].Orchestrator["agentId"] != first.Agents[0].ID {
		t.Fatalf("legacy thread was not promoted once to its exact agent orchestrator: %+v", first.Threads)
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
	if second.Threads[0].Orchestrator["kind"] != first.Threads[0].Orchestrator["kind"] || second.Threads[0].Orchestrator["agentId"] != first.Threads[0].Orchestrator["agentId"] {
		t.Fatalf("restart duplicated or rewrote thread promotion: before=%+v after=%+v", first.Threads[0].Orchestrator, second.Threads[0].Orchestrator)
	}
}

// This later, still pre-v5 producer fixture carries a configured agent whose harness vocabulary is
// representable as a template. It complements the older fixture above, whose historical
// `claude-code` identifier is intentionally refused rather than coerced.
func TestLegacyTemplateMigration(t *testing.T) {
	t.Parallel()
	legacy := filepath.Join(repositoryRoot, "apps", "hub", "test-fixtures", "state-with-orchestrator-resolved-approval.json")
	cluster := newEnvironment(t, environmentOptions{legacyStatePath: legacy})
	first := cluster.hub.snapshot()
	if len(first.Agents) != 1 || len(first.Templates) != 1 || first.Templates[0].LegacyAgentID != first.Agents[0].ID {
		t.Fatalf("representable legacy agent did not import once with provenance: agents=%+v templates=%+v", first.Agents, first.Templates)
	}
	cluster.hub.restart()
	second := cluster.hub.snapshot()
	if len(second.Templates) != 1 || second.Templates[0].ID != first.Templates[0].ID || second.Templates[0].LegacyAgentID != first.Templates[0].LegacyAgentID {
		t.Fatalf("restart duplicated or rewrote the imported template: before=%+v after=%+v", first.Templates, second.Templates)
	}
}
