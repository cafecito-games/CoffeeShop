//go:build system && unix

package systemtest

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
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
	if version != "1.1.0" {
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
	node := cluster.prepareNode(nodeOptions{id: "pack-upgrade", labels: []string{"pack-upgrade"}, concurrency: 1, instanceCapacity: integer(1)})
	fixtures := filepath.Join(cluster.root, "pack-upgrade-fixtures")
	if err := os.MkdirAll(fixtures, 0o755); err != nil {
		t.Fatal(err)
	}
	packA := buildPackUpgradeFixture(t, fixtures, "1.1.0")
	packB := buildPackUpgradeFixture(t, fixtures, "1.1.1")
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

	installPackCLI(t, node, packB)
	requireSetupSuccess(t, activatePackCLI(t, node, packB), "activate pack B")
	node.proxy.sever()
	requireLivePackVersion(t, cluster, node.options.id, packA.version)
	node.stop(true)
	node.options.componentManifest = packB.manifest
	node.start()
	b := requireLivePackVersion(t, cluster, node.options.id, packB.version)
	if b.RollbackVersion != packA.version || !b.RollbackAvailable {
		t.Fatalf("pack B omitted rollback selection: %+v", b)
	}

	requireSetupSuccess(t, rollbackPackCLI(t, node, packB), "rollback pack B to A")
	node.proxy.sever()
	requireLivePackVersion(t, cluster, node.options.id, packB.version)
	node.stop(true)
	node.options.componentManifest = packA.manifest
	node.start()
	a := requireLivePackVersion(t, cluster, node.options.id, packA.version)
	if a.RollbackAvailable || a.RollbackVersion != "" {
		t.Fatalf("rolled-back pack retained an oscillating rollback target: %+v", a)
	}
}
