//go:build system && unix

package systemtest

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/capabilitypack"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/setup"
)

const systemCapabilityPackID = "coffeeshop-capability-pack"

type installedSystemCapabilityPack struct {
	archive      []byte
	manifestPath string
	path         string
	version      string
}

// installSystemCapabilityPack uses the real deterministic producer, setup planner, applier, and
// activation authority. Leaving activate false deliberately creates the #98 informational state:
// installed bytes are visible in component inventory, but are not execution readiness.
func installSystemCapabilityPack(t *testing.T, node *baristaNode, activate bool) installedSystemCapabilityPack {
	t.Helper()
	tree, err := capabilitypack.ReadTree(filepath.Join(repositoryRoot, "capability-pack"))
	if err != nil {
		t.Fatal(err)
	}
	archive, pack, err := capabilitypack.BuildArchive(tree, capabilitypack.DefaultVocabulary())
	if err != nil {
		t.Fatal(err)
	}
	platform := setup.CurrentPlatform()
	manifestBytes := []byte(fmt.Sprintf(`{"manifestVersion":%q,"components":[{"id":%q,"kind":"capability-pack","harnessId":"coffee-shop","provider":"cafecito-games","label":"Coffee Shop capability pack","version":%q,"platforms":{%q:{"kind":"manual","executablePath":"coffeeshop-capability-pack.tar.gz"}},"launch":{}}]}`,
		setup.ManifestVersion, pack.ID, pack.Version, platform))
	manifest, err := setup.ParseManifest(manifestBytes)
	if err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(node.environment.root, node.options.id+"-capability-components.json")
	if err := os.WriteFile(manifestPath, manifestBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	plan, skipped, err := setup.BuildPlan(manifestBytes, manifest, platform, node.dataRoot, setup.OwnershipLedger{})
	if err != nil {
		t.Fatal(err)
	}
	if len(skipped) != 0 {
		t.Fatalf("fresh capability-pack plan skipped components: %+v", skipped)
	}
	source := filepath.Join(node.environment.root, node.options.id+"-capability-pack.tar.gz")
	if err := os.WriteFile(source, archive, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := setup.Apply(context.Background(), plan, manifestBytes, setup.OwnershipLedger{}, node.dataRoot, setup.ApplyOptions{
		ManualArtifactSources: map[string]string{pack.ID: source},
		ManualChecksums:       map[string]string{pack.ID: capabilitypack.ArchiveDigest(archive)},
	}); err != nil {
		t.Fatal(err)
	}
	ownership, err := setup.LoadOwnershipLedger(node.dataRoot)
	if err != nil {
		t.Fatal(err)
	}
	selector := setup.ComponentSelector{Kind: setup.ComponentKindCapabilityPack, ID: pack.ID, Version: pack.Version}
	if activate {
		if _, err := setup.Activate(context.Background(), setup.ActivationContext{
			DataRoot: node.dataRoot, Manifest: manifest, Platform: platform, Ownership: ownership,
			Activation: setup.LoadActivationState(node.dataRoot), InUse: func(string) bool { return false },
			Probe: func(_ context.Context, installed setup.InstalledComponent) error {
				_, probeErr := capabilitypack.ProbeInstalledArtifact(installed.Path, pack.ID, pack.Version)
				return probeErr
			},
		}, selector); err != nil {
			t.Fatal(err)
		}
	}
	installed, err := setup.VerifyInstalledComponent(node.dataRoot, manifest.ComponentsOfKind(setup.ComponentKindCapabilityPack)[0], platform, ownership)
	if err != nil {
		t.Fatal(err)
	}
	return installedSystemCapabilityPack{archive: archive, manifestPath: manifestPath, path: installed.Path, version: pack.Version}
}

func capabilityPackInventory(report componentInventory) (componentInventoryEntry, bool) {
	for _, component := range report.Components {
		if component.Kind == "capability-pack" && component.ID == systemCapabilityPackID {
			return component, true
		}
	}
	return componentInventoryEntry{}, false
}

func capabilityPackRequirements() map[string]any {
	return map[string]any{
		"skills":           []string{"coffeeshop-preview"},
		"harnessIds":       []string{"claude-cli"},
		"models":           []string{"sonnet"},
		"transports":       []string{"native-cli"},
		"operatingSystems": []string{runtime.GOOS},
	}
}

// TestCapabilityPackReadinessGatesInstanceWork crosses the real #99 setup and process scaffolding,
// the Hub's current-socket scheduler state, resident allocations, run-start proof, and the native
// harness. It deliberately keeps an installed-but-inactive peer and a version-four peer online so
// neither persisted inventory nor compatibility agent skill strings can accidentally become
// execution authority.
func TestCapabilityPackReadinessGatesInstanceWork(t *testing.T) {
	cluster := newEnvironment(t, environmentOptions{})
	readyNode := cluster.prepareNode(nodeOptions{
		id: "pack-ready", labels: []string{"pack-e2e"}, concurrency: 2, instanceCapacity: integer(3),
	})
	inventoryNode := cluster.prepareNode(nodeOptions{
		id: "pack-inventory", labels: []string{"pack-e2e"}, concurrency: 2, instanceCapacity: integer(2),
	})
	readyPack := installSystemCapabilityPack(t, readyNode, true)
	inventoryPack := installSystemCapabilityPack(t, inventoryNode, false)
	readyNode.options.componentManifest = readyPack.manifestPath
	inventoryNode.options.componentManifest = inventoryPack.manifestPath
	readyNode.start()
	inventoryNode.start()

	compatibilityWorkspace := filepath.Join(cluster.root, "pack-v4-workspace")
	if err := os.MkdirAll(compatibilityWorkspace, 0o755); err != nil {
		t.Fatal(err)
	}
	compatibility := startCompatibilityBarista(t, cluster.hub.port, compatibilityWorkspace, "pack-v4", "4")
	cluster.createAgent(agentOptions{
		name: "Configured skill metadata only", harnessID: "codex-cli", model: "default", nodeID: "pack-v4",
		workspace: compatibilityWorkspace, skills: []string{"coffeeshop-preview"},
	})

	live := cluster.eventually("active and inventory-only capability-pack states", func(current snapshot) (bool, string) {
		readyReport, readyFound := componentInventoryFor(current, "pack-ready")
		inventoryReport, inventoryFound := componentInventoryFor(current, "pack-inventory")
		readyComponent, readyKnown := capabilityPackInventory(readyReport)
		inventoryComponent, inventoryKnown := capabilityPackInventory(inventoryReport)
		v4, v4Found := nodeByID(current, "pack-v4")
		if !readyFound || !inventoryFound || !readyKnown || !inventoryKnown || !v4Found || v4.Status == "offline" {
			return false, "component inventories or compatibility peer are not live"
		}
		return readyComponent.ActiveVersion == readyPack.version && inventoryComponent.ActiveVersion == "" &&
			slices.Equal(inventoryComponent.InstalledVersions, []string{inventoryPack.version}) &&
			inventoryComponent.Readiness == "not-applicable", "active and informational states have not converged"
	})
	readyReport, _ := componentInventoryFor(live, "pack-ready")
	inventoryReport, _ := componentInventoryFor(live, "pack-inventory")
	requireInventoryContract(t, readyReport, "pack-ready")
	requireInventoryContract(t, inventoryReport, "pack-inventory")

	clientID, secret := cluster.mintOrchestratorClient("Capability-pack operator", "orchestrate")
	bridge := cluster.startBridge("capability-pack-readiness", clientID, secret)
	created := bridge.mustCallTool("create_thread", map[string]any{
		"title": "Capability-pack readiness", "objective": "Use only current process proof for skill work.",
	})
	threadID := text(object(created, "thread"), "id")

	first := bridge.mustCallTool("spawn_instance", map[string]any{
		"threadId": threadID, "idempotencyKey": "pack-first", "requirements": capabilityPackRequirements(),
		"initialTask": map[string]any{"title": "pack-first", "instructions": script(t, step{Message: "pack first done"})},
	})
	firstInstanceID := text(object(first, "instance"), "id")
	firstTaskID := text(first, "initialTaskId")
	completed := cluster.eventually("skill work to use the live exact pack", func(current snapshot) (bool, string) {
		item, known := current.task(firstTaskID)
		return known && item.Status == "completed", "skill task is not completed"
	})
	firstAllocation, allocated := allocationFor(completed, firstInstanceID)
	firstTask, _ := completed.task(firstTaskID)
	firstRun, ran := completed.latestAttempt(firstTask)
	if !allocated || !ran || firstAllocation.NodeID != "pack-ready" || firstRun.NodeID != "pack-ready" {
		t.Fatalf("skill work did not use the readiness-proving offering: allocation=%+v run=%+v", firstAllocation, firstRun)
	}
	wantExpected := protocol.ExpectedCapabilityPack{ID: systemCapabilityPackID, Version: readyPack.version, RequiredSkills: []string{"coffeeshop-preview"}}
	if firstAllocation.ExpectedCapabilityPack == nil || firstAllocation.ExpectedCapabilityPack.ID != wantExpected.ID ||
		firstAllocation.ExpectedCapabilityPack.Version != wantExpected.Version ||
		!slices.Equal(firstAllocation.ExpectedCapabilityPack.RequiredSkills, wantExpected.RequiredSkills) {
		t.Fatalf("allocation omitted the exact pack expectation: %+v", firstAllocation.ExpectedCapabilityPack)
	}
	wantSkills := []string{"coffeeshop-artifacts", "coffeeshop-coordination", "coffeeshop-preview", "coffeeshop-task-reporting"}
	if firstRun.TransportSelection == nil || firstRun.TransportSelection.EffectiveCapabilityPack == nil {
		t.Fatalf("run-start proof omitted the effective pack: %+v", firstRun.TransportSelection)
	}
	effective := firstRun.TransportSelection.EffectiveCapabilityPack
	if effective.ID != systemCapabilityPackID || effective.Version != readyPack.version || !slices.Equal(effective.Skills, wantSkills) {
		t.Fatalf("run-start proof does not identify the effective pack: %+v", effective)
	}
	if len(nativeRunRecords(cluster)) != 1 {
		t.Fatalf("exactly one provider prompt should have run, got %d", len(nativeRunRecords(cluster)))
	}

	witness := bridge.mustCallTool("spawn_instance", map[string]any{
		"threadId": threadID, "idempotencyKey": "pack-witness", "requirements": capabilityPackRequirements(),
	})
	witnessID := text(object(witness, "instance"), "id")
	cluster.eventually("a second skill resident to become ready", func(current snapshot) (bool, string) {
		instance, known := instanceByID(current, witnessID)
		allocation, present := allocationFor(current, witnessID)
		return known && present && instance.Status == "ready" && allocation.Status == "active" && allocation.NodeID == "pack-ready",
			"skill resident is not active on the ready node"
	})

	if err := os.WriteFile(readyPack.path, []byte("drifted capability pack"), 0o644); err != nil {
		t.Fatal(err)
	}
	bridge.mustCallTool("submit_tasks", map[string]any{
		"threadId": threadID, "idempotencyKey": "pack-drift-refusal",
		"tasks": []taskSpecification{{
			Key: "pack-drift-refusal", Title: "pack-drift-refusal", Instructions: "This prompt must never run.",
			Requirements: capabilityPackRequirements(), Pin: map[string]any{"instanceId": firstInstanceID},
		}},
	})
	drifted := cluster.eventually("archive drift to fail before the provider prompt", func(current snapshot) (bool, string) {
		item, known := taskByTitle(current, threadID, "pack-drift-refusal")
		return known && item.Status == "failed" && len(item.AttemptRunIDs) == 1, "drift refusal has not become terminal"
	})
	driftTask, _ := taskByTitle(drifted, threadID, "pack-drift-refusal")
	for _, runID := range driftTask.AttemptRunIDs {
		attempt, _ := drifted.run(runID)
		if attempt.Status != "failed" || attempt.StartedAt != "" {
			t.Fatalf("drifted pack reached run-start authority: %+v", attempt)
		}
	}
	if len(nativeRunRecords(cluster)) != 1 {
		t.Fatalf("archive drift reached a provider prompt: %+v", nativeRunRecords(cluster))
	}

	readyNode.proxy.setPaused(true)
	readyNode.proxy.sever()
	disconnected := cluster.eventually("disconnected readiness to retire its idle resident", func(current snapshot) (bool, string) {
		node, nodeKnown := nodeByID(current, "pack-ready")
		instance, instanceKnown := instanceByID(current, witnessID)
		return nodeKnown && node.Status == "offline" && instanceKnown && instance.Status == "draining",
			"node is not offline or its stale pack resident is not draining"
	})
	if _, retained := componentInventoryFor(disconnected, "pack-ready"); !retained {
		t.Fatal("disconnect erased persisted component inventory; the test cannot prove it is non-authoritative")
	}

	blocked := bridge.mustCallTool("spawn_instance", map[string]any{
		"threadId": threadID, "idempotencyKey": "pack-blocked", "requirements": capabilityPackRequirements(),
		"initialTask": map[string]any{"title": "pack-blocked", "instructions": script(t, step{Message: "pack recovered"})},
	})
	blockedTaskID := text(blocked, "initialTaskId")
	cluster.eventually("inventory and compatibility metadata to refuse skill placement", func(current snapshot) (bool, string) {
		item, known := current.task(blockedTaskID)
		if !known || len(item.AttemptRunIDs) != 0 || !hasPlacementKind(item, "skill") {
			return false, "skill task lacks the fail-closed placement diagnosis"
		}
		return len(compatibility.recordedDispatches()) == 0, "version-four peer received skill work"
	})

	plainRequirements := map[string]any{
		"harnessIds": []string{"claude-cli"}, "models": []string{"sonnet"}, "transports": []string{"native-cli"},
		"operatingSystems": []string{runtime.GOOS},
	}
	plain := bridge.mustCallTool("spawn_instance", map[string]any{
		"threadId": threadID, "idempotencyKey": "pack-plain", "requirements": plainRequirements,
		"initialTask": map[string]any{"title": "pack-plain", "instructions": script(t, step{Message: "plain done"})},
	})
	plainInstanceID := text(object(plain, "instance"), "id")
	plainTaskID := text(plain, "initialTaskId")
	plainDone := cluster.eventually("no-skill work to remain independent of pack readiness", func(current snapshot) (bool, string) {
		item, known := current.task(plainTaskID)
		return known && item.Status == "completed", "plain task is not completed"
	})
	plainAllocation, present := allocationFor(plainDone, plainInstanceID)
	plainTask, _ := plainDone.task(plainTaskID)
	plainRun, plainRan := plainDone.latestAttempt(plainTask)
	if !present || !plainRan || plainAllocation.NodeID != "pack-inventory" || plainAllocation.ExpectedCapabilityPack != nil ||
		plainRun.TransportSelection == nil || plainRun.TransportSelection.EffectiveCapabilityPack != nil {
		t.Fatalf("no-skill work gained or required pack authority: allocation=%+v run=%+v", plainAllocation, plainRun)
	}

	if err := os.WriteFile(readyPack.path, readyPack.archive, 0o644); err != nil {
		t.Fatal(err)
	}
	readyNode.proxy.setPaused(false)
	recovered := cluster.eventually("a fresh current-socket report to restore exact skill placement", func(current snapshot) (bool, string) {
		item, known := current.task(blockedTaskID)
		return known && item.Status == "completed", "skill task has not recovered"
	})
	blockedInstanceID := text(object(blocked, "instance"), "id")
	recoveredAllocation, recoveredAllocated := allocationFor(recovered, blockedInstanceID)
	recoveredTask, _ := recovered.task(blockedTaskID)
	recoveredRun, recoveredRan := recovered.latestAttempt(recoveredTask)
	if !recoveredAllocated || !recoveredRan || recoveredAllocation.NodeID != "pack-ready" ||
		recoveredAllocation.ExpectedCapabilityPack == nil || recoveredRun.TransportSelection == nil ||
		recoveredRun.TransportSelection.EffectiveCapabilityPack == nil {
		t.Fatalf("recovered work lacks exact allocation/run proof: allocation=%+v run=%+v", recoveredAllocation, recoveredRun)
	}
}
