//go:build system && unix

package systemtest

import (
	"net/http"
	"runtime"
	"strings"
	"testing"

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
	for index := len(current.Allocations) - 1; index >= 0; index-- {
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

	released := bridge.mustCallTool("release_instance", map[string]any{
		"threadId": threadID, "instanceId": instanceID, "idempotencyKey": "release-once", "mode": "drain",
	})
	if released["replayed"] != false {
		t.Fatalf("the release was not a new lifecycle request: %v", released)
	}
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
