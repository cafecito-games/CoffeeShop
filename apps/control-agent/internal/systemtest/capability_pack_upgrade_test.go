//go:build system && unix

package systemtest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/capabilitypack"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/setup"
)

type packUpgradeFixture struct {
	archive, manifest, source, version string
}

func buildPackUpgradeFixture(t *testing.T, root, version string) packUpgradeFixture {
	t.Helper()
	tree, err := capabilitypack.ReadTree(filepath.Join(repositoryRoot, "capability-pack"))
	if err != nil {
		t.Fatal(err)
	}
	if version != "1.2.0" {
		var authored map[string]any
		if err := json.Unmarshal(tree[capabilitypack.PackManifestPath], &authored); err != nil {
			t.Fatal(err)
		}
		authored["version"] = version
		tree[capabilitypack.PackManifestPath], err = json.Marshal(authored)
		if err != nil {
			t.Fatal(err)
		}
		tree, _, err = capabilitypack.Seal(tree, capabilitypack.DefaultVocabulary())
		if err != nil {
			t.Fatal(err)
		}
	}
	archive, manifest, err := capabilitypack.BuildArchive(tree, capabilitypack.DefaultVocabulary())
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "pack-"+version+".tar.gz")
	if err := os.WriteFile(source, archive, 0o600); err != nil {
		t.Fatal(err)
	}
	platform := setup.CurrentPlatform()
	manifestBytes := []byte(fmt.Sprintf(`{"manifestVersion":%q,"components":[{"id":%q,"kind":"capability-pack","harnessId":"coffee-shop","provider":"cafecito-games","label":"Coffee Shop capability pack","version":%q,"platforms":{%q:{"kind":"manual","executablePath":"coffeeshop-capability-pack.tar.gz"}},"launch":{}}]}`,
		setup.ManifestVersion, manifest.ID, manifest.Version, platform))
	manifestPath := filepath.Join(root, "manifest-"+version+".json")
	if err := os.WriteFile(manifestPath, manifestBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	return packUpgradeFixture{archive: capabilitypack.ArchiveDigest(archive), manifest: manifestPath, source: source, version: version}
}

func installPackCLI(t *testing.T, node *baristaNode, fixture packUpgradeFixture) {
	t.Helper()
	plan := filepath.Join(node.environment.root, "plan-pack-"+fixture.version+".json")
	requireSetupSuccess(t, runSetupCommand(t, node.home, nil, "setup", "plan", "--data-root", node.dataRoot, "--manifest", fixture.manifest, "--out", plan), "plan pack "+fixture.version)
	requireSetupSuccess(t, runSetupCommand(t, node.home, nil, "setup", "apply", "--data-root", node.dataRoot, "--manifest", fixture.manifest, "--plan", plan,
		"--manual-artifact", systemCapabilityPackID+"="+fixture.source, "--manual-checksum", systemCapabilityPackID+"="+fixture.archive), "apply pack "+fixture.version)
}

func activatePackCLI(t *testing.T, node *baristaNode, fixture packUpgradeFixture) setupCommandResult {
	t.Helper()
	return runSetupCommand(t, node.home, nil, "setup", "activate", "--data-root", node.dataRoot, "--manifest", fixture.manifest,
		"--kind", "capability-pack", "--id", systemCapabilityPackID, "--version", fixture.version)
}

func rollbackPackCLI(t *testing.T, node *baristaNode, fixture packUpgradeFixture) setupCommandResult {
	t.Helper()
	return runSetupCommand(t, node.home, nil, "setup", "rollback", "--data-root", node.dataRoot, "--manifest", fixture.manifest,
		"--kind", "capability-pack", "--id", systemCapabilityPackID)
}

func requireLivePackVersion(t *testing.T, cluster *environment, nodeID, version string) componentInventoryEntry {
	t.Helper()
	var component componentInventoryEntry
	cluster.eventually("live capability pack "+version, func(current snapshot) (bool, string) {
		report, found := componentInventoryFor(current, nodeID)
		var known bool
		component, known = capabilityPackInventory(report)
		return found && known && component.ActiveVersion == version, "process-local pack inventory has not converged"
	})
	return component
}

// TestCapabilityPackUpgradeRestartAndRollback uses the shipped setup CLI grammar and two valid
// producer-built archives. Selection changes are ledger-only until a fresh daemon adopts them.
func TestCapabilityPackUpgradeRestartAndRollback(t *testing.T) {
	cluster := newEnvironment(t, environmentOptions{})
	node := cluster.prepareNode(nodeOptions{id: "pack-upgrade", labels: []string{"pack-upgrade"}, concurrency: 2, instanceCapacity: integer(3)})
	fixtures := filepath.Join(cluster.root, "pack-upgrade-fixtures")
	if err := os.MkdirAll(fixtures, 0o755); err != nil {
		t.Fatal(err)
	}
	packA := buildPackUpgradeFixture(t, fixtures, "1.2.0")
	packB := buildPackUpgradeFixture(t, fixtures, "1.2.1")
	installPackCLI(t, node, packA)
	requireSetupSuccess(t, activatePackCLI(t, node, packA), "activate pack A")
	activationA := bytesIfPresent(t, filepath.Join(node.dataRoot, "activation.json"))
	requireSetupSuccess(t, activatePackCLI(t, node, packA), "replay pack A activation")
	if string(activationA) != string(bytesIfPresent(t, filepath.Join(node.dataRoot, "activation.json"))) {
		t.Fatal("exact activation replay rewrote its ledger")
	}
	node.options.componentManifest = packA.manifest
	node.start()
	requireLivePackVersion(t, cluster, node.options.id, packA.version)
	clientID, secret := cluster.mintOrchestratorClient("Pack upgrade", "orchestrate")
	bridge := cluster.startBridge("pack-upgrade", clientID, secret)
	created := bridge.mustCallTool("create_thread", map[string]any{"title": "Pack upgrade", "objective": "Prove A/B/A run identity and restart-only adoption."})
	threadID := text(object(created, "thread"), "id")
	type packRun struct{ taskID, runID, instanceID string }
	startRun := func(title, gate string) packRun {
		instructions := script(t, step{Message: "pack run " + title})
		if gate != "" {
			instructions = script(t, step{Gate: gate}, step{Message: "pack run " + title})
		}
		spawned := bridge.mustCallTool("spawn_instance", map[string]any{
			"threadId": threadID, "idempotencyKey": title,
			"requirements": evaluationRequirementsAt("coffeeshop-artifacts", "claude-cli", "pack-upgrade"),
			"initialTask":  map[string]any{"title": title, "instructions": instructions},
		})
		result := packRun{taskID: text(spawned, "initialTaskId"), instanceID: text(object(spawned, "instance"), "id")}
		cluster.eventually(title+" started", func(current snapshot) (bool, string) {
			item, known := current.task(result.taskID)
			if !known {
				return false, "task is absent"
			}
			run, ran := current.latestAttempt(item)
			if ran {
				result.runID = run.ID
			}
			if gate == "" {
				return ran && item.Status == "completed", "task is not complete"
			}
			return ran && run.Status == "running", "task is not held"
		})
		return result
	}
	requireRunVersion := func(candidate packRun, version string) {
		current := cluster.hub.snapshot()
		item, known := current.task(candidate.taskID)
		run, ran := current.run(candidate.runID)
		allocation, allocated := allocationFor(current, candidate.instanceID)
		if !known || !ran || !allocated || allocation.ExpectedCapabilityPack == nil || run.TransportSelection == nil || run.TransportSelection.EffectiveCapabilityPack == nil ||
			allocation.ExpectedCapabilityPack.Version != version || run.TransportSelection.EffectiveCapabilityPack.Version != version ||
			!slices.Equal(allocation.ExpectedCapabilityPack.RequiredSkills, []string{"coffeeshop-artifacts"}) {
			t.Fatalf("%s lacks exact %s allocation/effective proof: task=%+v allocation=%+v run=%+v", candidate.taskID, version, item, allocation, run)
		}
	}

	heldA := startRun("pack-A-held", "pack-A-held")
	requireRunVersion(heldA, packA.version)

	installPackCLI(t, node, packB)
	activationBeforeTamper := bytesIfPresent(t, filepath.Join(node.dataRoot, "activation.json"))
	if err := os.WriteFile(filepath.Join(node.dataRoot, "activation.json"), []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	requireSetupFailure(t, activatePackCLI(t, node, packB), "refuse malformed activation ledger")
	if err := os.WriteFile(filepath.Join(node.dataRoot, "activation.json"), activationBeforeTamper, 0o600); err != nil {
		t.Fatal(err)
	}
	targetB := filepath.Join(node.dataRoot, "capability-packs", "coffee-shop", systemCapabilityPackID, packB.version, "coffeeshop-capability-pack.tar.gz")
	originalB := bytesIfPresent(t, targetB)
	if err := os.WriteFile(targetB, []byte("tampered capability pack bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	requireSetupFailure(t, activatePackCLI(t, node, packB), "refuse tampered pack bytes")
	if !bytes.Equal(activationBeforeTamper, bytesIfPresent(t, filepath.Join(node.dataRoot, "activation.json"))) {
		t.Fatal("tampered pack activation mutated the selection ledger")
	}
	if err := os.WriteFile(targetB, originalB, 0o600); err != nil {
		t.Fatal(err)
	}
	requireSetupSuccess(t, activatePackCLI(t, node, packB), "activate pack B")
	requireRunVersion(heldA, packA.version)
	requireLivePackVersion(t, cluster, node.options.id, packA.version)
	cluster.openGate("pack-A-held")
	cluster.eventually("in-flight A completion", func(current snapshot) (bool, string) {
		item, known := current.task(heldA.taskID)
		return known && item.Status == "completed", "held A run is not complete"
	})
	node.stop(true)
	node.options.componentManifest = packB.manifest
	node.start()
	b := requireLivePackVersion(t, cluster, node.options.id, packB.version)
	if b.RollbackVersion != packA.version || !b.RollbackAvailable {
		t.Fatalf("pack B omitted rollback selection: %+v", b)
	}
	runB := startRun("pack-B-run", "")
	requireRunVersion(runB, packB.version)

	requireSetupSuccess(t, rollbackPackCLI(t, node, packB), "rollback pack B to A")
	requireLivePackVersion(t, cluster, node.options.id, packB.version)
	node.stop(true)
	node.options.componentManifest = packA.manifest
	node.start()
	a := requireLivePackVersion(t, cluster, node.options.id, packA.version)
	if a.RollbackAvailable || a.RollbackVersion != "" {
		t.Fatalf("rolled-back pack retained an oscillating rollback target: %+v", a)
	}
	runA2 := startRun("pack-A-rollback-run", "")
	requireRunVersion(runA2, packA.version)
}
