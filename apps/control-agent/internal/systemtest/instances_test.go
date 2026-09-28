//go:build system && unix

package systemtest

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp/acptest"
)

func integer(value int) *int { return &value }

func exactClaudeInstanceRequirements(label string) map[string]any {
	return map[string]any{
		"harnessIds":       []string{"claude-cli"},
		"models":           []string{acptest.ClaudeModel},
		"transports":       []string{"acp-v1"},
		"operatingSystems": []string{runtime.GOOS},
		"labels":           []string{label},
	}
}

// TestInstanceProtocolV4Exclusion uses a bounded version-4 control peer, not a downgraded current
// Barista. It proves the Hub accepts the rolling peer and exposes its precise exclusion while never
// sending it a v5 provision or dispatch.
func TestInstanceProtocolV4Exclusion(t *testing.T) {
	t.Parallel()
	cluster := newEnvironment(t, environmentOptions{})
	workspace := filepath.Join(cluster.root, "v4-workspace")
	if err := os.MkdirAll(workspace, 0o755); err != nil {
		t.Fatal(err)
	}
	peer := startCompatibilityBarista(t, cluster.hub.port, workspace, "instance-v4", "4")
	cluster.eventually("the exact version-4 peer to pass its barrier", func(current snapshot) (bool, string) {
		node, found := nodeByID(current, "instance-v4")
		return found && node.Status != "offline" && node.Version == "0.0.4-compatibility", "version-4 peer is not synchronized"
	})

	clientID, secret := cluster.mintOrchestratorClient("v4 exclusion", "orchestrate")
	bridge := cluster.startBridge("instance-v4-exclusion", clientID, secret)
	created := bridge.mustCallTool("create_thread", map[string]any{"title": "v4 exclusion", "objective": "Never weaken instance placement."})
	threadID := text(object(created, "thread"), "id")
	spawned := bridge.mustCallTool("spawn_instance", map[string]any{
		"threadId": threadID, "idempotencyKey": "v4-instance", "requirements": map[string]any{
			"harnessIds": []string{"codex-cli"}, "models": []string{"default"}, "transports": []string{"native-cli"},
		},
		"initialTask": map[string]any{"title": "v4-refused", "instructions": "Must remain queued."},
	})
	instanceID := text(object(spawned, "instance"), "id")
	taskID := text(spawned, "initialTaskId")
	refused := cluster.eventually("version-4 exclusion to be explicit", func(current snapshot) (bool, string) {
		item, found := current.task(taskID)
		if !found || item.Placement == nil {
			return false, "initial task has no placement diagnostic"
		}
		for _, unsatisfied := range item.Placement.Unsatisfied {
			if unsatisfied.Kind == "protocol-version" && unsatisfied.NodeID == "instance-v4" {
				return true, ""
			}
		}
		return false, "protocol-version exclusion is absent"
	})
	instance, _ := instanceByID(refused, instanceID)
	if instance.Status != "requested" || len(refused.Allocations) != 0 || len(refused.Runs) != 0 || len(peer.recordedDispatches()) != 0 {
		t.Fatalf("version-4 peer received or caused instance work: instance=%+v allocations=%d runs=%d", instance, len(refused.Allocations), len(refused.Runs))
	}
}

func nodeByID(current snapshot, id string) (computeNode, bool) {
	for _, node := range current.Nodes {
		if node.ID == id {
			return node, true
		}
	}
	return computeNode{}, false
}

func instanceByID(current snapshot, id string) (agentInstance, bool) {
	for _, instance := range current.Instances {
		if instance.ID == id {
			return instance, true
		}
	}
	return agentInstance{}, false
}

func allocationFor(current snapshot, instanceID string) (instanceAllocation, bool) {
	// The Hub publishes newest allocations first. Replacement keeps terminal history, so walking
	// backwards would return the lost generation instead of the current one.
	for index := range current.Allocations {
		if current.Allocations[index].InstanceID == instanceID {
			return current.Allocations[index], true
		}
	}
	return instanceAllocation{}, false
}

func taskByTitle(current snapshot, threadID, title string) (task, bool) {
	item, found := current.threadTasks(threadID)[title]
	return item, found
}

func hasPlacementKind(item task, kind string) bool {
	if item.Placement == nil {
		return false
	}
	for _, unsatisfied := range item.Placement.Unsatisfied {
		if unsatisfied.Kind == kind {
			return true
		}
	}
	return false
}

// TestInstanceCapacitiesStayIndependent proves that the resident pool and active-run slots are
// separately accounted through the public bridge and producer snapshot. It also keeps a hard model
// mismatch explicit instead of weakening the request or falling back.
func TestInstanceCapacitiesStayIndependent(t *testing.T) {
	t.Parallel()
	cluster := newEnvironment(t, environmentOptions{})
	cluster.startNode(nodeOptions{
		id: "capacity-node", claudeAuthMode: "api", labels: []string{"capacity-e2e"},
		concurrency: 1, instanceCapacity: integer(1),
	})
	clientID, secret := cluster.mintOrchestratorClient("capacity operator", "orchestrate")
	bridge := cluster.startBridge("instance-capacity", clientID, secret)
	created := bridge.mustCallTool("create_thread", map[string]any{"title": "Independent capacities", "objective": "Keep residents and runs separate."})
	threadID := text(object(created, "thread"), "id")
	requirements := exactClaudeInstanceRequirements("capacity-e2e")

	first := bridge.mustCallTool("spawn_instance", map[string]any{
		"threadId": threadID, "idempotencyKey": "capacity-first", "requirements": requirements,
		"initialTask": map[string]any{"title": "capacity-running", "instructions": script(t, step{Gate: "capacity-first"})},
	})
	firstInstanceID := text(object(first, "instance"), "id")
	cluster.eventually("one run and one resident to occupy their independent limits", func(current snapshot) (bool, string) {
		item, found := taskByTitle(current, threadID, "capacity-running")
		node, nodeFound := nodeByID(current, "capacity-node")
		if !found || !nodeFound || len(item.AttemptRunIDs) != 1 || node.ActiveInstances == nil {
			return false, "capacity evidence is incomplete"
		}
		attempt, found := current.latestAttempt(item)
		return found && attempt.Status == "running" && node.ActiveRuns == 1 && *node.ActiveInstances == 1,
			"run/resident counters are not both occupied"
	})

	second := bridge.mustCallTool("spawn_instance", map[string]any{
		"threadId": threadID, "idempotencyKey": "capacity-second", "requirements": requirements,
		"initialTask": map[string]any{"title": "resident-blocked", "instructions": "Wait for a resident slot."},
	})
	secondTaskID := text(second, "initialTaskId")
	bridge.mustCallTool("submit_tasks", map[string]any{
		"threadId": threadID, "idempotencyKey": "run-capacity-second",
		"tasks": []taskSpecification{{
			Key: "same-resident", Title: "run-blocked", Instructions: script(t, step{Message: "run slot done"}), Requirements: requirements,
			Pin: map[string]any{"instanceId": firstInstanceID},
		}},
	})

	mismatchRequirements := exactClaudeInstanceRequirements("capacity-e2e")
	mismatchRequirements["models"] = []string{"model-that-is-not-advertised"}
	mismatch := bridge.mustCallTool("spawn_instance", map[string]any{
		"threadId": threadID, "idempotencyKey": "capacity-mismatch", "requirements": mismatchRequirements,
		"initialTask": map[string]any{"title": "model-refused", "instructions": "Never weaken this model."},
	})
	mismatchTaskID := text(mismatch, "initialTaskId")
	osMismatchRequirements := exactClaudeInstanceRequirements("capacity-e2e")
	if runtime.GOOS == "linux" {
		osMismatchRequirements["operatingSystems"] = []string{"darwin"}
	} else {
		osMismatchRequirements["operatingSystems"] = []string{"linux"}
	}
	osMismatch := bridge.mustCallTool("spawn_instance", map[string]any{
		"threadId": threadID, "idempotencyKey": "capacity-os-mismatch", "requirements": osMismatchRequirements,
		"initialTask": map[string]any{"title": "os-refused", "instructions": "Never weaken this operating system."},
	})
	labelMismatchRequirements := exactClaudeInstanceRequirements("label-that-is-not-advertised")
	labelMismatch := bridge.mustCallTool("spawn_instance", map[string]any{
		"threadId": threadID, "idempotencyKey": "capacity-label-mismatch", "requirements": labelMismatchRequirements,
		"initialTask": map[string]any{"title": "label-refused", "instructions": "Never weaken this label."},
	})
	osMismatchTaskID := text(osMismatch, "initialTaskId")
	labelMismatchTaskID := text(labelMismatch, "initialTaskId")

	blocked := cluster.eventually("resident, run, and model exclusions to stay distinct", func(current snapshot) (bool, string) {
		residentTask, residentFound := current.task(secondTaskID)
		runTask, runFound := taskByTitle(current, threadID, "run-blocked")
		modelTask, modelFound := current.task(mismatchTaskID)
		osTask, osFound := current.task(osMismatchTaskID)
		labelTask, labelFound := current.task(labelMismatchTaskID)
		if !residentFound || !runFound || !modelFound || !osFound || !labelFound {
			return false, "one blocked task is absent"
		}
		return hasPlacementKind(residentTask, "resident-capacity") && hasPlacementKind(runTask, "capacity") &&
				hasPlacementKind(modelTask, "model") && hasPlacementKind(osTask, "operating-system") && hasPlacementKind(labelTask, "label"),
			"the distinct placement diagnostics are not present"
	})
	if len(blocked.Allocations) != 1 || len(blocked.Instances) != 5 {
		t.Fatalf("capacity refusal mutated resident allocation counts: instances=%d allocations=%d", len(blocked.Instances), len(blocked.Allocations))
	}

	cluster.openGate("capacity-first")
	completed := cluster.eventually("the queued exact pin to use the freed run slot", func(current snapshot) (bool, string) {
		item, found := taskByTitle(current, threadID, "run-blocked")
		return found && item.Status == "completed", "the exact pinned task is not completed"
	})
	pinnedTask, _ := taskByTitle(completed, threadID, "run-blocked")
	pinnedRun, _ := completed.latestAttempt(pinnedTask)
	if pinnedRun.InstanceID != firstInstanceID || len(completed.Allocations) != 1 {
		t.Fatalf("free run capacity weakened the resident identity: run=%+v allocations=%d", pinnedRun, len(completed.Allocations))
	}
}

// TestInstanceRenewalWinsBeforeTheClosedExpiryBoundary proves the ordering of renewal and expiry
// against the Hub's one serialized state authority. A committed renewal keeps the resident alive
// when the original boundary passes; the renewed closed boundary then drains and releases it.
func TestInstanceRenewalWinsBeforeTheClosedExpiryBoundary(t *testing.T) {
	t.Parallel()
	cluster := newEnvironment(t, environmentOptions{clockOffset: true})
	cluster.startNode(nodeOptions{
		id: "expiry-node", claudeAuthMode: "api", labels: []string{"expiry-e2e"},
		concurrency: 1, instanceCapacity: integer(2),
	})
	clientID, secret := cluster.mintOrchestratorClient("expiry operator", "orchestrate")
	bridge := cluster.startBridge("instance-expiry", clientID, secret)
	created := bridge.mustCallTool("create_thread", map[string]any{"title": "Instance expiry", "objective": "Prove the closed lease boundary."})
	threadID := text(object(created, "thread"), "id")
	const leaseSeconds = 120
	spawned := bridge.mustCallTool("spawn_instance", map[string]any{
		"threadId": threadID, "idempotencyKey": "expiry-instance", "requirements": exactClaudeInstanceRequirements("expiry-e2e"),
		"idleTimeoutSeconds": leaseSeconds,
	})
	instanceID := text(object(spawned, "instance"), "id")
	ready := cluster.eventually("the expiring resident to become ready", func(current snapshot) (bool, string) {
		instance, known := instanceByID(current, instanceID)
		allocation, allocated := allocationFor(current, instanceID)
		return known && allocated && instance.Status == "ready" && allocation.Status == "active", "resident is not active"
	})
	before, _ := instanceByID(ready, instanceID)
	originalExpiry, err := time.Parse(time.RFC3339Nano, before.Lease.ExpiresAt)
	if err != nil {
		t.Fatalf("parse original expiry: %v", err)
	}
	witness := bridge.mustCallTool("spawn_instance", map[string]any{
		"threadId": threadID, "idempotencyKey": "expiry-witness", "requirements": exactClaudeInstanceRequirements("expiry-e2e"),
		"idleTimeoutSeconds": leaseSeconds,
	})
	witnessID := text(object(witness, "instance"), "id")
	witnessReady := cluster.eventually("the unrenewed expiry witness to become ready", func(current snapshot) (bool, string) {
		instance, known := instanceByID(current, witnessID)
		allocation, allocated := allocationFor(current, witnessID)
		return known && allocated && instance.Status == "ready" && allocation.Status == "active", "expiry witness is not active"
	})
	witnessInstance, _ := instanceByID(witnessReady, witnessID)
	witnessExpiry, err := time.Parse(time.RFC3339Nano, witnessInstance.Lease.ExpiresAt)
	if err != nil {
		t.Fatalf("parse witness expiry: %v", err)
	}

	// Move just short of the first closed boundary, then commit the renewal first. The maintenance
	// transaction must observe that new expiry rather than racing a stale in-memory timer.
	timeToOriginalBoundary := time.Until(originalExpiry)
	if timeToOriginalBoundary <= 2*time.Second {
		t.Fatalf("system setup consumed the lease before the renewal race: %s", timeToOriginalBoundary)
	}
	cluster.hub.advanceClock(timeToOriginalBoundary / 2)
	var renewed map[string]any
	if status := cluster.hub.request(http.MethodPost, "/api/threads/"+threadID+"/instances/"+instanceID+"/renew", map[string]any{
		"idempotencyKey": "expiry-renewal", "idleTimeoutSeconds": leaseSeconds,
	}, &renewed); status != http.StatusOK {
		t.Fatalf("operator renewal returned %d: %v", status, renewed)
	}
	renewedExpiry, err := time.Parse(time.RFC3339Nano, text(object(object(renewed, "instance"), "lease"), "expiresAt"))
	if err != nil || !renewedExpiry.After(originalExpiry) {
		t.Fatalf("renewal did not commit a later boundary: old=%s renewed=%v err=%v", originalExpiry, renewedExpiry, err)
	}
	closedOldBoundary := originalExpiry
	if witnessExpiry.After(closedOldBoundary) {
		closedOldBoundary = witnessExpiry
	}
	cluster.hub.advanceClock(time.Until(closedOldBoundary) + time.Millisecond)
	cluster.eventually("maintenance to release the unrenewed witness but preserve the committed renewal", func(current snapshot) (bool, string) {
		renewedInstance, renewedKnown := instanceByID(current, instanceID)
		witnessInstance, witnessKnown := instanceByID(current, witnessID)
		if !renewedKnown || !witnessKnown {
			return false, "expiry records are incomplete"
		}
		residentLive := renewedInstance.Status == "ready" || renewedInstance.Status == "idle"
		return residentLive && renewedInstance.Lease.ExpiresAt == renewedExpiry.Format(time.RFC3339Nano) && witnessInstance.Status == "released",
			"maintenance has not resolved the two serialized outcomes"
	})

	// Equality is expired, not one more instant of lease. Crossing the renewed timestamp by the
	// smallest clock-file unit lets maintenance drain, await exact Barista acknowledgement, and free.
	cluster.hub.advanceClock(time.Until(renewedExpiry) + time.Millisecond)
	terminal := cluster.eventually("the renewed closed boundary to release the resident", func(current snapshot) (bool, string) {
		instance, known := instanceByID(current, instanceID)
		allocation, allocated := allocationFor(current, instanceID)
		node, present := nodeByID(current, "expiry-node")
		return known && allocated && present && instance.Status == "released" && allocation.Status == "released" &&
			node.ActiveInstances != nil && *node.ActiveInstances == 0, "renewed expiry has not released or published free capacity"
	})
	node, _ := nodeByID(terminal, "expiry-node")
	if node.ActiveInstances == nil || *node.ActiveInstances != 0 {
		t.Fatalf("expiry did not return resident capacity: %+v", node)
	}
}

// TestInstanceReconnectReplacesLostAllocation proves the real v5 reconnect barrier. Restarting
// Barista loses its process-local resident table, so the Hub marks only that allocation lost and
// places the unchanged instance requirements on another eligible node under a fresh allocation.
func TestInstanceReconnectReplacesLostAllocation(t *testing.T) {
	t.Parallel()
	cluster := newEnvironment(t, environmentOptions{})
	original := cluster.startNode(nodeOptions{
		id: "replacement-a", claudeAuthMode: "api", labels: []string{"replacement-e2e"},
		concurrency: 1, instanceCapacity: integer(1),
	})
	cluster.startNode(nodeOptions{
		id: "replacement-b", claudeAuthMode: "api", labels: []string{"replacement-e2e"},
		concurrency: 1, instanceCapacity: integer(1),
	})
	clientID, secret := cluster.mintOrchestratorClient("replacement operator", "orchestrate")
	bridge := cluster.startBridge("instance-replacement", clientID, secret)
	created := bridge.mustCallTool("create_thread", map[string]any{"title": "Instance replacement", "objective": "Keep immutable placement intent."})
	threadID := text(object(created, "thread"), "id")
	requirements := exactClaudeInstanceRequirements("replacement-e2e")
	spawned := bridge.mustCallTool("spawn_instance", map[string]any{
		"threadId": threadID, "idempotencyKey": "replacement-instance", "requirements": requirements,
	})
	instanceID := text(object(spawned, "instance"), "id")
	first := cluster.eventually("the original allocation to become active", func(current snapshot) (bool, string) {
		instance, known := instanceByID(current, instanceID)
		allocation, allocated := allocationFor(current, instanceID)
		return known && allocated && instance.Status == "ready" && allocation.Status == "active" && allocation.NodeID == original.options.id,
			"original allocation is not active on the deterministic first node"
	})
	firstAllocation, _ := allocationFor(first, instanceID)
	original.proxy.sever()
	cluster.eventually("the real Barista to reconnect with its exact resident inventory", func(current snapshot) (bool, string) {
		allocation, allocated := allocationFor(current, instanceID)
		node, present := nodeByID(current, original.options.id)
		return allocated && present && allocation.ID == firstAllocation.ID && allocation.Status == "active" &&
				node.ActiveInstances != nil && *node.ActiveInstances == 1 && strings.Count(original.logs.String(), "connected to") >= 2,
			"resident inventory has not converged after the severed socket"
	})

	// The reconnected node reports the truth (no process-local residents) but deliberately no longer
	// satisfies the immutable label. Replacement therefore has exactly one valid destination.
	original.stop(true)
	original.options.labels = nil
	original.start()
	replaced := cluster.eventually("the lost allocation to be replaced without weakening requirements", func(current snapshot) (bool, string) {
		instance, known := instanceByID(current, instanceID)
		latest, allocated := allocationFor(current, instanceID)
		if !known || !allocated || latest.ID == firstAllocation.ID {
			return false, "replacement allocation is absent"
		}
		return instance.Status == "ready" && latest.Status == "active" && latest.NodeID == "replacement-b", "replacement is not active on the remaining eligible node"
	})
	instance, _ := instanceByID(replaced, instanceID)
	latest, _ := allocationFor(replaced, instanceID)
	firstHistory, found := func() (instanceAllocation, bool) {
		for _, allocation := range replaced.Allocations {
			if allocation.ID == firstAllocation.ID {
				return allocation, true
			}
		}
		return instanceAllocation{}, false
	}()
	if latest.ID == firstAllocation.ID || len(replaced.Allocations) != 2 || !found || firstHistory.Status != "lost" {
		t.Fatalf("replacement did not preserve lost history and create one generation: first=%+v latest=%+v all=%+v", firstAllocation, latest, replaced.Allocations)
	}
	labels, labelsPresent := instance.Requirements["labels"].([]any)
	if !labelsPresent || len(labels) != 1 || labels[0] != "replacement-e2e" {
		t.Fatalf("replacement weakened immutable requirements: %+v", instance.Requirements)
	}
}

// TestInstanceUnknownRemoteResidentIsReleased proves the opposite reconciliation direction. A
// current Barista resident absent from restored Hub authority is never imported into the lifecycle
// tables and is cancelled once its exact v5 inventory lands. Offline heartbeat counters are not
// treated as authority while that inventory is unavailable.
func TestInstanceUnknownRemoteResidentIsReleased(t *testing.T) {
	t.Parallel()
	cluster := newEnvironment(t, environmentOptions{})
	node := cluster.startNode(nodeOptions{
		id: "orphan-node", claudeAuthMode: "api", labels: []string{"orphan-e2e"},
		concurrency: 1, instanceCapacity: integer(1),
	})
	clientID, secret := cluster.mintOrchestratorClient("orphan operator", "orchestrate")
	bridge := cluster.startBridge("instance-orphan", clientID, secret)
	created := bridge.mustCallTool("create_thread", map[string]any{"title": "Unknown resident", "objective": "Never adopt remote residency."})
	threadID := text(object(created, "thread"), "id")
	spawned := bridge.mustCallTool("spawn_instance", map[string]any{
		"threadId": threadID, "idempotencyKey": "orphan-instance", "requirements": exactClaudeInstanceRequirements("orphan-e2e"),
	})
	instanceID := text(object(spawned, "instance"), "id")
	cluster.eventually("the future unknown resident to become active", func(current snapshot) (bool, string) {
		instance, known := instanceByID(current, instanceID)
		allocation, allocated := allocationFor(current, instanceID)
		return known && allocated && instance.Status == "ready" && allocation.Status == "active", "resident is not active"
	})

	// Hold the Barista outside the restarted Hub until the operator-visible restored snapshot has
	// been observed. The offline node record is not authoritative inventory in either direction.
	node.proxy.setPaused(true)
	cluster.hub.stop()
	removeHubInstanceAuthority(t, cluster.hub.dataPath)
	cluster.hub.start()
	restored := cluster.hub.snapshot()
	restoredNode, present := nodeByID(restored, node.options.id)
	if !present || len(restored.Instances) != 0 || len(restored.Allocations) != 0 {
		t.Fatalf("restored Hub guessed away or adopted remote occupancy: node=%+v instances=%d allocations=%d", restoredNode, len(restored.Instances), len(restored.Allocations))
	}

	node.proxy.setPaused(false)
	settled := cluster.eventually("the unknown resident to be released rather than adopted", func(current snapshot) (bool, string) {
		reconciled, known := nodeByID(current, node.options.id)
		return known && reconciled.ActiveInstances != nil && *reconciled.ActiveInstances == 0 &&
			len(current.Instances) == 0 && len(current.Allocations) == 0, "unknown residency has not been evicted"
	})
	if _, adopted := instanceByID(settled, instanceID); adopted {
		t.Fatalf("unknown resident %s was adopted into Hub authority", instanceID)
	}
}

func TestInstanceReleaseWaitsForReconnectAcknowledgement(t *testing.T) {
	t.Parallel()
	cluster := newEnvironment(t, environmentOptions{})
	node := cluster.startNode(nodeOptions{
		id: "release-node", claudeAuthMode: "api", labels: []string{"release-e2e"},
		concurrency: 1, instanceCapacity: integer(1),
	})
	clientID, secret := cluster.mintOrchestratorClient("release operator", "orchestrate")
	bridge := cluster.startBridge("instance-release", clientID, secret)
	created := bridge.mustCallTool("create_thread", map[string]any{"title": "Release acknowledgement", "objective": "Keep capacity until exact acknowledgement."})
	threadID := text(object(created, "thread"), "id")
	spawned := bridge.mustCallTool("spawn_instance", map[string]any{
		"threadId": threadID, "idempotencyKey": "release-instance", "requirements": exactClaudeInstanceRequirements("release-e2e"),
	})
	instanceID := text(object(spawned, "instance"), "id")
	cluster.eventually("the releasable resident to become ready", func(current snapshot) (bool, string) {
		instance, known := instanceByID(current, instanceID)
		allocation, allocated := allocationFor(current, instanceID)
		return known && allocated && instance.Status == "ready" && allocation.Status == "active", "resident is not ready"
	})

	node.proxy.setPaused(true)
	cluster.hub.restart()
	var releaseResult map[string]any
	path := "/api/threads/" + threadID + "/instances/" + instanceID + "/release"
	if status := cluster.hub.request(http.MethodPost, path, map[string]any{
		"idempotencyKey": "offline-release", "mode": "drain",
	}, &releaseResult); status != http.StatusAccepted {
		t.Fatalf("offline release returned %d: %v", status, releaseResult)
	}
	held := cluster.hub.snapshot()
	heldInstance, _ := instanceByID(held, instanceID)
	heldAllocation, _ := allocationFor(held, instanceID)
	if heldInstance.Status != "draining" || heldAllocation.Status != "active" {
		t.Fatalf("undelivered release guessed successful cleanup: instance=%+v allocation=%+v", heldInstance, heldAllocation)
	}

	node.proxy.setPaused(false)
	terminal := cluster.eventually("the replayed release to settle after exact reconnect", func(current snapshot) (bool, string) {
		instance, known := instanceByID(current, instanceID)
		allocation, allocated := allocationFor(current, instanceID)
		reconciled, present := nodeByID(current, node.options.id)
		return known && allocated && present && reconciled.ActiveInstances != nil && *reconciled.ActiveInstances == 0 &&
			instance.Status == "released" && allocation.Status == "released", "release has not received exact acknowledgement"
	})
	beforeReplay, _ := instanceByID(terminal, instanceID)
	var replayed map[string]any
	if status := cluster.hub.request(http.MethodPost, path, map[string]any{
		"idempotencyKey": "offline-release", "mode": "drain",
	}, &replayed); status != http.StatusOK || replayed["replayed"] != true {
		t.Fatalf("terminal release did not replay exactly: status=%d result=%v", status, replayed)
	}
	afterReplay := cluster.hub.snapshot()
	afterReplayInstance, _ := instanceByID(afterReplay, instanceID)
	afterReplayNode, _ := nodeByID(afterReplay, node.options.id)
	if beforeReplay.UpdatedAt != afterReplayInstance.UpdatedAt || afterReplayNode.ActiveInstances == nil || *afterReplayNode.ActiveInstances != 0 {
		t.Fatalf("duplicate terminal release mutated history or capacity: before=%+v after=%+v node=%+v", beforeReplay, afterReplayInstance, afterReplayNode)
	}
}

// TestInstanceDelegatingTemplateTools proves the run-scoped surface from a real template-backed
// resident. The model supplies neither thread authority nor delegation policy; the Hub carries the
// operator-authored template defaults into the instance and derives every tool caller from its run.
func TestInstanceDelegatingTemplateTools(t *testing.T) {
	t.Parallel()
	cluster := newEnvironment(t, environmentOptions{})
	node := cluster.startNode(nodeOptions{
		id: "delegation-node", claudeAuthMode: "api", labels: []string{"delegation-e2e"},
		concurrency: 1, instanceCapacity: integer(2),
	})
	hiddenLegacyAgentID := cluster.createAgent(agentOptions{
		name: "Hidden legacy reviewer", harnessID: "claude-cli", model: acptest.ClaudeModel,
		nodeID: node.options.id, workspace: node.directory("hidden-legacy-reviewer"),
	})
	requirements := exactClaudeInstanceRequirements("delegation-e2e")
	var templateResult map[string]any
	status := cluster.hub.request(http.MethodPost, "/api/agent-templates", map[string]any{
		"idempotencyKey": "delegating-template",
		"name":           "Delegating developer", "purpose": map[string]any{"title": "Developer", "summary": "Delegates exact work"},
		"instructions": "private template instructions", "requirements": requirements,
		"delegation": map[string]any{"canDelegate": true},
	}, &templateResult)
	if status != http.StatusCreated {
		t.Fatalf("template creation returned %d: %v", status, templateResult)
	}
	templateID := text(object(templateResult, "template"), "id")

	clientID, secret := cluster.mintOrchestratorClient("delegation operator", "orchestrate")
	bridge := cluster.startBridge("instance-delegation", clientID, secret)
	created := bridge.mustCallTool("create_thread", map[string]any{"title": "Delegating instance", "objective": "Exercise run-scoped instance tools."})
	threadID := text(object(created, "thread"), "id")
	childTaskScript := script(t, step{Message: "child exact pin complete"})
	parentScript := script(t,
		step{Call: "get_execution_inventory", Arguments: map[string]any{}, As: "inventory"},
		step{Call: "delegate_task", Arguments: map[string]any{
			"agentId": hiddenLegacyAgentID, "task": "This hidden target must never run.", "idempotencyKey": "hidden-legacy-target",
		}, AllowError: true, As: "hidden"},
		step{Call: "spawn_instance", Arguments: map[string]any{
			"idempotencyKey": "run-child", "requirements": requirements,
			"purpose": map[string]any{"name": "Child reviewer"},
		}, As: "child"},
		step{Call: "submit_tasks", Arguments: map[string]any{
			"idempotencyKey": "run-child-task",
			"tasks": []taskSpecification{{
				Key: "child", Title: "delegated-child", Instructions: childTaskScript, Requirements: requirements,
				Pin: map[string]any{"instanceId": "{{child.instance.id}}"},
			}},
		}, As: "batch"},
		step{Message: "spawned {{child.instance.id}} hidden={{hidden.error.code}}"},
	)
	bridge.mustCallTool("submit_tasks", map[string]any{
		"threadId": threadID, "idempotencyKey": "template-parent",
		"tasks": []taskSpecification{{
			Key: "parent", Title: "template-parent", Instructions: parentScript,
			Requirements: map[string]any{"templateId": templateID},
		}},
	})

	final := cluster.eventually("the delegated exact child task to complete", func(current snapshot) (bool, string) {
		parent, parentFound := taskByTitle(current, threadID, "template-parent")
		child, childFound := taskByTitle(current, threadID, "delegated-child")
		if !parentFound || !childFound {
			return false, "parent or child task is absent"
		}
		return parent.Status == "completed" && child.Status == "completed", parent.Status + "/" + child.Status
	})
	parentTask, _ := taskByTitle(final, threadID, "template-parent")
	childTask, _ := taskByTitle(final, threadID, "delegated-child")
	parentRun, _ := final.latestAttempt(parentTask)
	childRun, _ := final.latestAttempt(childTask)
	parentInstance, _ := instanceByID(final, parentRun.InstanceID)
	childInstance, _ := instanceByID(final, childRun.InstanceID)
	if !parentInstance.Delegation["canDelegate"] || parentInstance.Purpose.Instructions != "private template instructions" {
		t.Fatalf("template defaults did not reach the resident: %+v", parentInstance)
	}
	if childRun.InstanceID == parentRun.InstanceID || childTask.PlacementOverride == nil || childTask.PlacementOverride.InstanceID != childRun.InstanceID {
		t.Fatalf("run-scoped submit did not keep the exact child pin: task=%+v run=%+v", childTask, childRun)
	}
	if !strings.Contains(parentRun.Output, "hidden=target_ineligible") {
		t.Fatalf("the live instance could see or target a hidden legacy agent: %q", parentRun.Output)
	}
	threadTaskCount := 0
	for _, item := range final.Tasks {
		if item.ThreadID == threadID {
			threadTaskCount++
		}
	}
	if threadTaskCount != 2 {
		t.Fatalf("the refused hidden legacy target changed the thread's exact task count: got %d, want parent and child only", threadTaskCount)
	}
	if text(childInstance.Creator, "kind") != "run" || text(childInstance.Creator, "instanceId") != parentRun.InstanceID {
		t.Fatalf("child authority was not derived from the live parent run: %+v", childInstance.Creator)
	}
}

func TestInstanceLegacyAndNonDelegatingCallersAreRefused(t *testing.T) {
	t.Parallel()
	cluster := newEnvironment(t, environmentOptions{})
	node := cluster.startNode(nodeOptions{
		id: "authority-node", claudeAuthMode: "api", labels: []string{"authority-e2e"},
		concurrency: 1, instanceCapacity: integer(1),
	})
	requirements := exactClaudeInstanceRequirements("authority-e2e")
	refusalScript := script(t,
		step{Call: "spawn_instance", Arguments: map[string]any{
			"idempotencyKey": "unauthorized-child", "requirements": requirements,
		}, AllowError: true, As: "refused"},
		step{Message: "lifecycle={{refused.error.code}}"},
	)

	legacyAgent := cluster.createAgent(agentOptions{
		name: "Legacy delegator", harnessID: "claude-cli", model: acptest.ClaudeModel,
		nodeID: node.options.id, workspace: node.root, canDelegate: true,
	})
	legacyQueued := cluster.sendMessage(legacyAgent, refusalScript, "")
	legacyFinal := cluster.eventually("the delegating legacy run to be denied instance authority", func(current snapshot) (bool, string) {
		attempt, known := current.run(legacyQueued.ID)
		return known && attempt.Status == "completed", "legacy authority probe is not completed"
	})
	legacyRun, _ := legacyFinal.run(legacyQueued.ID)
	if !strings.Contains(legacyRun.Output, "lifecycle=forbidden") {
		t.Fatalf("legacy configured-agent run received instance authority: %q", legacyRun.Output)
	}

	var templateResult map[string]any
	status := cluster.hub.request(http.MethodPost, "/api/agent-templates", map[string]any{
		"idempotencyKey": "nondelegating-template",
		"name":           "Non-delegating worker", "requirements": requirements,
		"delegation": map[string]any{"canDelegate": false},
	}, &templateResult)
	if status != http.StatusCreated {
		t.Fatalf("non-delegating template creation returned %d: %v", status, templateResult)
	}
	clientID, secret := cluster.mintOrchestratorClient("authority operator", "orchestrate")
	bridge := cluster.startBridge("instance-authority", clientID, secret)
	created := bridge.mustCallTool("create_thread", map[string]any{"title": "Instance authority", "objective": "Keep delegation server-authored."})
	threadID := text(object(created, "thread"), "id")
	bridge.mustCallTool("submit_tasks", map[string]any{
		"threadId": threadID, "idempotencyKey": "nondelegating-probe",
		"tasks": []taskSpecification{{
			Key: "probe", Title: "nondelegating-probe", Instructions: refusalScript,
			Requirements: map[string]any{"templateId": text(object(templateResult, "template"), "id")},
		}},
	})
	nondelegating := cluster.eventually("the non-delegating instance run to be denied lifecycle tools", func(current snapshot) (bool, string) {
		item, found := taskByTitle(current, threadID, "nondelegating-probe")
		if !found || item.Status != "completed" {
			return false, "non-delegating authority probe is not completed"
		}
		attempt, found := current.latestAttempt(item)
		return found && strings.Contains(attempt.Output, "lifecycle=forbidden"), "non-delegating refusal is absent"
	})
	probe, _ := taskByTitle(nondelegating, threadID, "nondelegating-probe")
	probeRun, _ := nondelegating.latestAttempt(probe)
	probeInstance, _ := instanceByID(nondelegating, probeRun.InstanceID)
	if probeInstance.Delegation["canDelegate"] {
		t.Fatalf("non-delegating template elevated its live instance: %+v", probeInstance)
	}
}

func TestInstanceCancelStopsActiveWork(t *testing.T) {
	t.Parallel()
	cluster := newEnvironment(t, environmentOptions{})
	cluster.startNode(nodeOptions{
		id: "cancel-node", claudeAuthMode: "api", labels: []string{"cancel-e2e"}, concurrency: 1, instanceCapacity: integer(1),
	})
	clientID, secret := cluster.mintOrchestratorClient("cancel operator", "orchestrate")
	bridge := cluster.startBridge("instance-cancel", clientID, secret)
	created := bridge.mustCallTool("create_thread", map[string]any{"title": "Cancel instance", "objective": "Terminate active resident work."})
	threadID := text(object(created, "thread"), "id")
	var spawned map[string]any
	if status := cluster.hub.request(http.MethodPost, "/api/threads/"+threadID+"/instances", map[string]any{
		"idempotencyKey": "cancel-instance", "requirements": exactClaudeInstanceRequirements("cancel-e2e"),
		"initialTask": map[string]any{"title": "cancel-active", "instructions": script(t, step{Gate: "never-opened"})},
	}, &spawned); status != http.StatusCreated {
		t.Fatalf("operator instance create returned %d: %v", status, spawned)
	}
	instanceID := text(object(spawned, "instance"), "id")
	taskID := text(spawned, "initialTaskId")
	running := cluster.eventually("the cancellable instance turn to start", func(current snapshot) (bool, string) {
		item, found := current.task(taskID)
		if !found {
			return false, "cancel task is absent"
		}
		attempt, found := current.latestAttempt(item)
		return found && attempt.Status == "running", "cancel task is not running"
	})
	item, _ := running.task(taskID)
	attempt, _ := running.latestAttempt(item)
	var cancelled map[string]any
	if status := cluster.hub.request(http.MethodPost, "/api/threads/"+threadID+"/instances/"+instanceID+"/release", map[string]any{
		"idempotencyKey": "cancel-now", "mode": "cancel",
	}, &cancelled); status != http.StatusAccepted {
		t.Fatalf("operator cancel returned %d: %v", status, cancelled)
	}
	terminal := cluster.eventually("cancel release to terminate the run and resident", func(current snapshot) (bool, string) {
		instance, known := instanceByID(current, instanceID)
		allocation, allocated := allocationFor(current, instanceID)
		run, runFound := current.run(attempt.ID)
		return known && allocated && runFound && instance.Status == "released" && allocation.Status == "released" && run.Status == "cancelled",
			"cancel has not settled the run and resident"
	})
	node, _ := nodeByID(terminal, "cancel-node")
	if node.ActiveInstances == nil || *node.ActiveInstances != 0 || node.ActiveRuns != 0 {
		t.Fatalf("cancel leaked run or resident capacity: %+v", node)
	}
}

// TestEphemeralInstanceLifecycle crosses the real external bridge, Hub WebSocket gateway, scheduler,
// latest Barista resident supervisor, and deterministic ACP provider. It keeps run capacity and
// resident capacity separately observable while proving exact actor attribution, session reuse,
// public projection privacy, idempotent renew/release, and acknowledgement-ordered cleanup.
func TestEphemeralInstanceLifecycle(t *testing.T) {
	t.Parallel()
	cluster := newEnvironment(t, environmentOptions{})
	node := cluster.startNode(nodeOptions{
		id: "instance-node", claudeAuthMode: "api", labels: []string{"instance-e2e"},
		concurrency: 1, instanceCapacity: integer(2),
	})

	clientID, secret := cluster.mintOrchestratorClient("Instance operator", "orchestrate")
	bridge := cluster.startBridge("instance-primary", clientID, secret)
	bridge.awaitTools("create_thread", "spawn_instance", "get_instance", "renew_instance", "release_instance", "submit_tasks", "get_execution_inventory")
	created := bridge.mustCallTool("create_thread", map[string]any{
		"title": "Ephemeral instance lifecycle", "objective": "Prove the version-five resident lifecycle.",
	})
	threadID := text(object(created, "thread"), "id")
	if threadID == "" {
		t.Fatalf("create_thread returned no thread id: %v", created)
	}

	requirements := exactClaudeInstanceRequirements("instance-e2e")
	firstScript := script(t, step{Gate: "instance-first"}, step{Message: "first session={{session}}"})
	spawnArguments := map[string]any{
		"threadId": threadID, "idempotencyKey": "issue-123-instance", "requirements": requirements,
		"purpose": map[string]any{
			"name": "Issue #123 Developer", "title": "Developer", "summary": "Owns exact pinned work",
			"instructions": "private resident instructions",
		},
		"idleTimeoutSeconds": 600,
		"initialTask":        map[string]any{"title": "instance-first", "instructions": firstScript},
	}
	spawned := bridge.mustCallTool("spawn_instance", spawnArguments)
	instanceID := text(object(spawned, "instance"), "id")
	initialTaskID := text(spawned, "initialTaskId")
	if instanceID == "" || initialTaskID == "" || spawned["replayed"] != false {
		t.Fatalf("spawn_instance did not atomically create one instance and task: %v", spawned)
	}

	var firstRun run
	active := cluster.eventually("the exact resident and initial task to become active", func(current snapshot) (bool, string) {
		instance, known := instanceByID(current, instanceID)
		if !known || (instance.Status != "busy" && instance.Status != "ready") {
			return false, "instance is not ready/busy"
		}
		allocation, known := allocationFor(current, instanceID)
		if !known || allocation.Status != "active" {
			return false, "allocation is not active"
		}
		initial, known := current.task(initialTaskID)
		if !known || len(initial.AttemptRunIDs) != 1 {
			return false, "initial task has no exact attempt"
		}
		firstRun, known = current.latestAttempt(initial)
		if !known || firstRun.Status != "running" {
			return false, "initial attempt is not running"
		}
		registered, present := nodeByID(current, node.options.id)
		if !present || registered.ActiveRuns != 1 || registered.ActiveInstances == nil || *registered.ActiveInstances != 1 {
			return false, "heartbeat has not published independent active run/resident counters"
		}
		return true, ""
	})
	if len(active.Instances) != 1 || len(active.Allocations) != 1 || firstRun.InstanceID != instanceID || firstRun.AllocationID != active.Allocations[0].ID || firstRun.AgentID != "" {
		t.Fatalf("the initial task lost its exact instance actor: instance=%+v allocation=%+v run=%+v", active.Instances, active.Allocations, firstRun)
	}
	allocation := active.Allocations[0]
	if allocation.NodeID != node.options.id || allocation.HarnessID != "claude-cli" || allocation.Model != acptest.ClaudeModel || allocation.Transport != "acp-v1" {
		t.Fatalf("placement weakened the exact requirements: %+v", allocation)
	}
	if firstRun.CreatedAt < allocation.UpdatedAt {
		t.Fatalf("run %s was created before allocation %s became ready: %s < %s", firstRun.ID, allocation.ID, firstRun.CreatedAt, allocation.UpdatedAt)
	}
	registered, _ := nodeByID(active, node.options.id)
	if registered.InstanceCapacity == nil || *registered.InstanceCapacity != 2 || registered.ActiveInstances == nil || *registered.ActiveInstances != 1 || registered.Concurrency != 1 || registered.ActiveRuns != 1 {
		t.Fatalf("independent resident/run counters are wrong: %+v", registered)
	}

	cluster.openGate("instance-first")
	firstDone := cluster.eventually("the first pinned task to settle without releasing residency", func(current snapshot) (bool, string) {
		attempt, known := current.run(firstRun.ID)
		node, present := nodeByID(current, "instance-node")
		if !known || !present || attempt.Status != "completed" || node.ActiveRuns != 0 || node.ActiveInstances == nil || *node.ActiveInstances != 1 {
			return false, "run or capacity has not settled"
		}
		return true, ""
	})
	firstFinal, _ := firstDone.run(firstRun.ID)

	// A lifecycle retry is keyed to the authenticated client rather than either connection. Cross
	// both process boundaries before replaying it, then prove a changed digest is refused without
	// changing the durable identity or its timestamps.
	bridge.stop(false)
	cluster.hub.restart()
	cluster.eventually("the resident to reconcile after the Hub restart", func(current snapshot) (bool, string) {
		instance, known := instanceByID(current, instanceID)
		allocation, allocated := allocationFor(current, instanceID)
		return known && allocated && (instance.Status == "idle" || instance.Status == "ready") && allocation.Status == "active",
			"the resident has not reconciled"
	})
	bridge = cluster.startBridge("instance-reconnected", clientID, secret)
	bridge.mustCallTool("attach_thread", map[string]any{"threadId": threadID})
	replayedSpawn := bridge.mustCallTool("spawn_instance", spawnArguments)
	if replayedSpawn["replayed"] != true ||
		text(object(replayedSpawn, "instance"), "id") != instanceID ||
		text(object(replayedSpawn, "allocation"), "id") != allocation.ID ||
		text(replayedSpawn, "initialTaskId") != initialTaskID {
		t.Fatalf("spawn did not replay stable identities across bridge/Hub restart: %v", replayedSpawn)
	}
	beforeConflict := cluster.hub.snapshot()
	changedSpawn := map[string]any{}
	for key, value := range spawnArguments {
		changedSpawn[key] = value
	}
	changedSpawn["idleTimeoutSeconds"] = 601
	conflict := bridge.callTool("spawn_instance", changedSpawn)
	if conflict.errorCode() != "conflict" {
		t.Fatalf("changed spawn replay was not an idempotency conflict: %+v", conflict)
	}
	afterConflict := cluster.hub.snapshot()
	beforeInstance, _ := instanceByID(beforeConflict, instanceID)
	afterInstance, _ := instanceByID(afterConflict, instanceID)
	if len(afterConflict.Instances) != len(beforeConflict.Instances) || len(afterConflict.Allocations) != len(beforeConflict.Allocations) || beforeInstance.UpdatedAt != afterInstance.UpdatedAt {
		t.Fatalf("conflicting replay mutated lifecycle state: before=%+v after=%+v", beforeInstance, afterInstance)
	}

	foreignCreated := bridge.mustCallTool("create_thread", map[string]any{"title": "Foreign lifecycle", "objective": "Prove thread isolation."})
	foreignThreadID := text(object(foreignCreated, "thread"), "id")
	foreignRead := bridge.callTool("get_instance", map[string]any{"threadId": foreignThreadID, "instanceId": instanceID})
	missingRead := bridge.callTool("get_instance", map[string]any{"threadId": threadID, "instanceId": "instance-missing"})
	foreignRenew := bridge.callTool("renew_instance", map[string]any{
		"threadId": foreignThreadID, "instanceId": instanceID, "idempotencyKey": "foreign-renew",
	})
	foreignRelease := bridge.callTool("release_instance", map[string]any{
		"threadId": foreignThreadID, "instanceId": instanceID, "idempotencyKey": "foreign-release", "mode": "cancel",
	})
	foreignPin := bridge.callTool("submit_tasks", map[string]any{
		"threadId": foreignThreadID, "idempotencyKey": "foreign-pin",
		"tasks": []taskSpecification{{Key: "foreign", Title: "foreign-pin", Instructions: "Never created.", Pin: map[string]any{"instanceId": instanceID}}},
	})
	selfElevating := map[string]any{}
	for key, value := range spawnArguments {
		selfElevating[key] = value
	}
	selfElevating["idempotencyKey"] = "self-elevating"
	selfElevating["creator"] = map[string]any{"kind": "operator", "operatorId": "forged"}
	selfElevating["delegation"] = map[string]any{"canDelegate": true}
	elevation := bridge.callTool("spawn_instance", selfElevating)
	if foreignRead.errorCode() != "not_found" || missingRead.errorCode() != foreignRead.errorCode() ||
		foreignRenew.errorCode() != "not_found" || foreignRelease.errorCode() != "not_found" ||
		!foreignPin.IsError || !elevation.IsError {
		t.Fatalf("thread/authority refusals diverged: foreign=%+v missing=%+v renew=%+v release=%+v pin=%+v elevation=%+v",
			foreignRead, missingRead, foreignRenew, foreignRelease, foreignPin, elevation)
	}
	afterRefusals := cluster.hub.snapshot()
	afterRefusedInstance, _ := instanceByID(afterRefusals, instanceID)
	if len(afterRefusals.Instances) != len(afterConflict.Instances) || afterRefusedInstance.UpdatedAt != afterInstance.UpdatedAt {
		t.Fatalf("refused lifecycle calls mutated state: before=%+v after=%+v", afterInstance, afterRefusedInstance)
	}

	secondScript := script(t, step{Message: "second session={{session}}"})
	submitted := bridge.mustCallTool("submit_tasks", map[string]any{
		"threadId": threadID, "idempotencyKey": "instance-second",
		"tasks": []taskSpecification{{
			Key: "second", Title: "instance-second", Instructions: secondScript, Requirements: requirements,
			Pin: map[string]any{"instanceId": instanceID},
		}},
	})
	if submitted["created"] != true {
		t.Fatalf("the second pinned task was not created: %v", submitted)
	}
	secondDone := cluster.eventually("the second pinned task to reuse the resident session", func(current snapshot) (bool, string) {
		second, known := taskByTitle(current, threadID, "instance-second")
		if !known || second.Status != "completed" {
			return false, "second task is not completed"
		}
		return true, ""
	})
	secondTask, _ := taskByTitle(secondDone, threadID, "instance-second")
	secondRun, _ := secondDone.latestAttempt(secondTask)
	if secondRun.InstanceID != instanceID || secondRun.AllocationID != allocation.ID || secondRun.AgentID != "" {
		t.Fatalf("the second task did not stay on the exact resident: %+v", secondRun)
	}
	if outputField(t, firstFinal.Output, "session") != outputField(t, secondRun.Output, "session") {
		t.Fatalf("the sequential prompts did not reuse the provider session: %q / %q", firstFinal.Output, secondRun.Output)
	}
	if len(secondDone.SessionBindings) != 1 || secondDone.SessionBindings[0].InstanceID != instanceID || secondDone.SessionBindings[0].AllocationID != allocation.ID || secondDone.SessionBindings[0].AgentID != "" || secondDone.SessionBindings[0].LastRunID != secondRun.ID {
		t.Fatalf("the provider binding did not retain exact instance attribution: %+v", secondDone.SessionBindings)
	}

	got := bridge.mustCallTool("get_instance", map[string]any{"threadId": threadID, "instanceId": instanceID})
	if purpose := object(object(got, "instance"), "purpose"); purpose["instructions"] != nil {
		t.Fatalf("get_instance leaked private purpose instructions: %v", purpose)
	}
	if safeAllocation := object(got, "allocation"); safeAllocation["workspace"] != nil {
		t.Fatalf("get_instance leaked the allocation workspace: %v", safeAllocation)
	}

	renewed := bridge.mustCallTool("renew_instance", map[string]any{
		"threadId": threadID, "instanceId": instanceID, "idempotencyKey": "renew-once", "idleTimeoutSeconds": 1200,
	})
	renewExpiry := text(object(object(renewed, "instance"), "lease"), "expiresAt")
	replayedRenewal := bridge.mustCallTool("renew_instance", map[string]any{
		"threadId": threadID, "instanceId": instanceID, "idempotencyKey": "renew-once", "idleTimeoutSeconds": 1200,
	})
	if replayedRenewal["replayed"] != true || text(object(object(replayedRenewal, "instance"), "lease"), "expiresAt") != renewExpiry {
		t.Fatalf("the renewal did not replay exactly: first=%v replay=%v", renewed, replayedRenewal)
	}
	bridge.mustCallTool("submit_tasks", map[string]any{
		"threadId": threadID, "idempotencyKey": "drain-active",
		"tasks": []taskSpecification{{
			Key: "active", Title: "drain-active", Instructions: script(t, step{Gate: "drain-active"}), Requirements: requirements,
			Pin: map[string]any{"instanceId": instanceID},
		}},
	})
	drainRunning := cluster.eventually("the turn that drain must wait for", func(current snapshot) (bool, string) {
		item, found := taskByTitle(current, threadID, "drain-active")
		if !found {
			return false, "drain task is absent"
		}
		attempt, found := current.latestAttempt(item)
		return found && attempt.Status == "running", "drain task is not running"
	})
	drainTask, _ := taskByTitle(drainRunning, threadID, "drain-active")
	drainRun, _ := drainRunning.latestAttempt(drainTask)

	released := bridge.mustCallTool("release_instance", map[string]any{
		"threadId": threadID, "instanceId": instanceID, "idempotencyKey": "release-once", "mode": "drain",
	})
	if released["replayed"] != false {
		t.Fatalf("the release was not a new lifecycle request: %v", released)
	}
	refusedAfterDrain := bridge.callTool("submit_tasks", map[string]any{
		"threadId": threadID, "idempotencyKey": "after-drain",
		"tasks": []taskSpecification{{
			Key: "refused", Title: "after-drain", Instructions: "Must remain queued.", Requirements: requirements,
			Pin: map[string]any{"instanceId": instanceID},
		}},
	})
	if refusedAfterDrain.errorCode() != "invalid_arguments" {
		t.Fatalf("a draining instance remained available for a new exact pin: %+v", refusedAfterDrain)
	}
	cluster.eventually("drain to refuse new work while preserving the active turn", func(current snapshot) (bool, string) {
		instance, known := instanceByID(current, instanceID)
		attempt, running := current.run(drainRun.ID)
		_, created := taskByTitle(current, threadID, "after-drain")
		return known && running && !created && instance.Status == "draining" && attempt.Status == "running",
			"drain has not closed admission without mutating the task graph"
	})
	cluster.openGate("drain-active")
	terminal := cluster.eventually("release acknowledgement to free resident capacity exactly once", func(current snapshot) (bool, string) {
		instance, known := instanceByID(current, instanceID)
		allocation, allocated := allocationFor(current, instanceID)
		node, present := nodeByID(current, "instance-node")
		if !known || !allocated || !present || node.ActiveInstances == nil {
			return false, "terminal projection is incomplete"
		}
		return instance.Status == "released" && allocation.Status == "released" && *node.ActiveInstances == 0,
			instance.Status + "/" + allocation.Status
	})
	if len(terminal.Instances) != 1 || len(terminal.Allocations) != 1 {
		t.Fatalf("terminal audit history was not retained: %d/%d", len(terminal.Instances), len(terminal.Allocations))
	}
	terminalView := bridge.mustCallTool("get_instance", map[string]any{"threadId": threadID, "instanceId": instanceID})
	if text(object(terminalView, "instance"), "status") != "released" {
		t.Fatalf("get_instance omitted terminal history: %v", terminalView)
	}
	exactReleaseReplay := bridge.mustCallTool("release_instance", map[string]any{
		"threadId": threadID, "instanceId": instanceID, "idempotencyKey": "release-once", "mode": "drain",
	})
	if exactReleaseReplay["replayed"] != true {
		t.Fatalf("the exact release did not replay: %v", exactReleaseReplay)
	}

	// The fake provider records a close only after release cleanup; no provider credential or Hub
	// enrollment token crosses the machine boundary during the complete lifecycle.
	closed := false
	for _, records := range cluster.harnessRecords() {
		for _, record := range records {
			if record.Event == "session-closed" {
				closed = true
			}
		}
	}
	if !closed {
		t.Fatal("release acknowledgement arrived before the retained provider session was closed")
	}
	cluster.assertNoCredentialLeak()

	// The operator endpoint exposes the same terminal state without accepting caller identity.
	var listed struct {
		Instances   []agentInstance      `json:"instances"`
		Allocations []instanceAllocation `json:"allocations"`
	}
	if status := cluster.hub.request(http.MethodGet, "/api/threads/"+threadID+"/instances?includeTerminal=true", nil, &listed); status != http.StatusOK {
		t.Fatalf("operator instance listing returned %d", status)
	}
	if len(listed.Instances) != 1 || len(listed.Allocations) != 1 || !strings.HasPrefix(listed.Instances[0].Purpose.Name, "Issue #123") {
		t.Fatalf("operator listing did not preserve terminal lifecycle history: %+v", listed)
	}
}
