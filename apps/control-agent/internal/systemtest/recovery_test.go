//go:build system && unix

package systemtest

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"nhooyr.io/websocket"
)

// lostComputeError is the hub's exact failure for an attempt its Barista stopped reporting after a
// reconnect.
const lostComputeError = "Compute lost: Barista no longer reports this attempt as active"

// TestControlConnectionPartition proves that a compute node surviving a control-connection
// partition keeps its in-flight work: the hub holds the attempt running instead of guessing, and
// once the connection returns, everything the run produced while disconnected — structured events,
// streamed output, and its report to the orchestrator — is delivered exactly once, with no
// duplicate attempt and no lost or reordered event history.
func TestControlConnectionPartition(t *testing.T) {
	t.Parallel()
	cluster := newWorkflowCluster(t, environmentOptions{}, "")

	partitioned := script(t,
		step{Gate: "partition-emit"},
		step{Update: map[string]any{"sessionUpdate": "plan", "entries": []map[string]any{
			{"content": "Work through the partition", "priority": "high", "status": "in_progress"},
		}}},
		step{Message: "emitted-during-partition "},
		step{WriteFile: &writeFile{Path: "partition-marker.txt", Content: "emitted"}},
		step{Gate: "partition-finish"},
		step{Call: "send_task_message", As: "report", Arguments: map[string]any{
			"idempotencyKey": "partition-report", "recipient": map[string]any{"type": "orchestrator"}, "kind": "result",
			"body": "survived the partition",
		}},
		step{Message: "report={{report.messageId}}"},
	)
	orchestrate := script(t,
		submitTasks("partition-graph", "batch", taskSpecification{
			Key: "partitioned", Title: "partitioned",
			Instructions: "Work through a network partition.\n" + partitioned,
			Requirements: map[string]any{"harnessIds": []string{"codex-cli"}},
			Pin:          map[string]any{"agentId": cluster.codexBuilder},
		}),
		step{Message: "submitted {{batch.submissionId}}"},
	)
	orchestratorRun := cluster.sendMessage(cluster.orchestrator, "Run one worker across a network partition.\n"+orchestrate, "")
	threadID := orchestratorRun.ThreadID

	started := cluster.eventually("the partitioned attempt to run", func(current snapshot) (bool, string) {
		item, known := current.threadTasks(threadID)["partitioned"]
		if !known {
			return false, "the worker task was not submitted yet"
		}
		attempt, known := current.latestAttempt(item)
		return known && attempt.Status == "running", "the attempt is not running"
	})
	partitionTask := started.threadTasks(threadID)["partitioned"]
	if len(partitionTask.AttemptRunIDs) != 1 {
		t.Fatalf("the partitioned work started with %d attempts", len(partitionTask.AttemptRunIDs))
	}
	attemptRunID := partitionTask.AttemptRunIDs[0]

	// Partition the node off the hub; the run keeps executing on the compute side.
	cluster.nodeA.proxy.setPaused(true)
	cluster.nodeA.proxy.sever()
	cluster.eventually("node-a to be offline", func(current snapshot) (bool, string) {
		for _, candidate := range current.Nodes {
			if candidate.ID == "node-a" {
				return candidate.Status == "offline", candidate.Status
			}
		}
		return false, "node-a is missing from the snapshot"
	})

	// While disconnected the run emits a plan update, streams text, and writes inside its workspace.
	cluster.openGate("partition-emit")
	marker := filepath.Join(cluster.checkoutA, "partition-marker.txt")
	waitFor(t, "the run to write its marker inside its workspace", func() bool {
		_, err := os.Stat(marker)
		return err == nil
	})

	cluster.nodeA.proxy.setPaused(false)
	cluster.eventually("node-a to reconnect", func(current snapshot) (bool, string) {
		for _, candidate := range current.Nodes {
			if candidate.ID == "node-a" {
				return candidate.Status != "offline", candidate.Status
			}
		}
		return false, "node-a is missing from the snapshot"
	})
	cluster.openGate("partition-finish")

	final := cluster.eventually("the partitioned work to complete", func(current snapshot) (bool, string) {
		item, known := current.threadTasks(threadID)["partitioned"]
		return known && item.Status == "completed", "the work has not completed"
	})
	completed := final.threadTasks(threadID)["partitioned"]
	if len(completed.AttemptRunIDs) != 1 || completed.AttemptRunIDs[0] != attemptRunID {
		t.Fatalf("the partition caused a retry: attempts %v", completed.AttemptRunIDs)
	}
	finalRun, _ := final.run(attemptRunID)
	if finalRun.Status != "completed" || finalRun.Error != "" {
		t.Fatalf("the partitioned attempt ended %s with error %q", finalRun.Status, finalRun.Error)
	}

	// Events buffered while disconnected were delivered once, in order, with no duplicates.
	events, _ := cluster.runEvents(attemptRunID)
	planUpdates := 0
	previousSequence := 0
	for _, event := range events {
		if event["type"] == "plan.updated" {
			planUpdates++
		}
		sequence, isNumber := event["sequence"].(float64)
		if !isNumber {
			t.Fatalf("an event carries no sequence: %v", event)
		}
		if int(sequence) <= previousSequence {
			t.Fatalf("event sequences are not strictly increasing: %d after %d", int(sequence), previousSequence)
		}
		previousSequence = int(sequence)
	}
	if planUpdates != 1 {
		t.Fatalf("the buffered plan update was delivered %d times, want exactly once", planUpdates)
	}
	reports := 0
	for _, message := range final.messagesIn(threadID) {
		if message.IdempotencyKey == "partition-report" {
			reports++
		}
	}
	if reports != 1 {
		t.Fatalf("the partition report was recorded %d times, want exactly once", reports)
	}
}

// TestLostAttemptIsRetriedAfterBaristaCrash proves compute-loss recovery: when a Barista dies with
// its runs, the hub keeps the attempt running until the replacement Barista's reconnect barrier
// proves the work is gone, fails it with the compute-lost error, and retries the work exactly once
// on the restarted node — never running two attempts of the same work at the same time.
func TestLostAttemptIsRetriedAfterBaristaCrash(t *testing.T) {
	t.Parallel()
	cluster := newWorkflowCluster(t, environmentOptions{}, "")

	resilient := script(t, step{Gate: "resilient-release"}, step{Message: "resilient done"})
	orchestrate := script(t,
		submitTasks("resilient-graph", "batch", taskSpecification{
			Key: "resilient", Title: "resilient",
			Instructions: "Survive your compute dying.\n" + resilient,
			Requirements: map[string]any{"harnessIds": []string{"codex-cli"}},
		}),
		step{Message: "submitted {{batch.submissionId}}"},
	)
	orchestratorRun := cluster.sendMessage(cluster.orchestrator, "Run one worker whose compute will crash.\n"+orchestrate, "")
	threadID := orchestratorRun.ThreadID

	started := cluster.eventually("the first attempt to run", func(current snapshot) (bool, string) {
		item, known := current.threadTasks(threadID)["resilient"]
		if !known {
			return false, "the worker task was not submitted yet"
		}
		attempt, known := current.latestAttempt(item)
		return known && attempt.Status == "running", "the attempt is not running"
	})
	resilientTask := started.threadTasks(threadID)["resilient"]
	firstRunID := resilientTask.AttemptRunIDs[0]
	taskID := resilientTask.ID

	// The whole process group dies without warning; the hub must not guess before the barrier.
	cluster.nodeA.stop(true)
	cluster.eventually("node-a to be offline while the hub still holds the attempt", func(current snapshot) (bool, string) {
		offline := false
		for _, candidate := range current.Nodes {
			if candidate.ID == "node-a" {
				offline = candidate.Status == "offline"
			}
		}
		if !offline {
			return false, "node-a is not offline yet"
		}
		attempt, known := current.run(firstRunID)
		if !known || attempt.Status != "running" {
			return false, "the hub already moved the attempt"
		}
		return true, ""
	})

	cluster.nodeA.start()
	cluster.eventually("the lost attempt to fail and a fresh attempt to run", func(current snapshot) (bool, string) {
		first, known := current.run(firstRunID)
		if !known {
			return false, "the first attempt vanished"
		}
		if first.Status != "failed" || first.Error != lostComputeError {
			return false, fmt.Sprintf("the first attempt is %s: %q", first.Status, first.Error)
		}
		item, known := current.task(taskID)
		if !known || len(item.AttemptRunIDs) != 2 {
			return false, fmt.Sprintf("the work has %d attempts", len(item.AttemptRunIDs))
		}
		second, known := current.latestAttempt(item)
		return known && second.Status == "running", "the second attempt is not running"
	})

	cluster.openGate("resilient-release")
	final := cluster.eventually("the retried work to complete", func(current snapshot) (bool, string) {
		item, known := current.task(taskID)
		return known && item.Status == "completed", "the work has not completed"
	})
	item, _ := final.task(taskID)
	if len(item.AttemptRunIDs) != 2 {
		t.Fatalf("the work ended with %d attempts, want exactly two", len(item.AttemptRunIDs))
	}
	first, _ := final.run(firstRunID)
	second, _ := final.latestAttempt(item)
	if second.Status != "completed" {
		t.Fatalf("the retried attempt ended %s", second.Status)
	}
	if second.CreatedAt < first.FinishedAt {
		t.Fatalf("the retry started at %s, before the lost attempt finished at %s", second.CreatedAt, first.FinishedAt)
	}
}

// TestHubRestartPreservesDurableState proves that a hub process restart is transparent to running
// work: every task, attempt, thread, and orchestrator inbox identity survives from persisted
// state, both compute nodes reconnect to the new process without disturbing their in-flight
// attempts, and the durable mailbox still delivers the worker's result to a completed
// orchestrator wake afterwards.
func TestHubRestartPreservesDurableState(t *testing.T) {
	t.Parallel()
	cluster := newWorkflowCluster(t, environmentOptions{}, "")

	durable := script(t,
		step{Gate: "durable-release"},
		step{Call: "send_task_message", As: "result", Arguments: map[string]any{
			"idempotencyKey": "durable-result", "recipient": map[string]any{"type": "orchestrator"}, "kind": "result",
			"body": "finished after the hub restart",
		}},
		step{Message: "durable done"},
	)
	orchestrate := script(t,
		submitTasks("durable-graph", "batch", taskSpecification{
			Key: "durable", Title: "durable",
			Instructions: "Finish across a hub restart.\n" + durable,
			Requirements: map[string]any{"harnessIds": []string{"claude-cli"}},
		}),
		step{Message: "submitted {{batch.submissionId}}"},
	)
	orchestratorRun := cluster.sendMessage(cluster.orchestrator, "Run one worker across a hub restart.\n"+orchestrate, "")
	threadID := orchestratorRun.ThreadID

	started := cluster.eventually("the durable attempt to run", func(current snapshot) (bool, string) {
		item, known := current.threadTasks(threadID)["durable"]
		if !known {
			return false, "the worker task was not submitted yet"
		}
		attempt, known := current.latestAttempt(item)
		return known && attempt.Status == "running", "the attempt is not running"
	})
	durableTask := started.threadTasks(threadID)["durable"]
	taskID := durableTask.ID
	if len(durableTask.AttemptRunIDs) != 1 {
		t.Fatalf("the durable work started with %d attempts", len(durableTask.AttemptRunIDs))
	}
	attemptRunID := durableTask.AttemptRunIDs[0]

	cluster.hub.restart()
	cluster.eventually("both nodes to reconnect with their durable state intact", func(current snapshot) (bool, string) {
		online := 0
		for _, candidate := range current.Nodes {
			if candidate.ID == "node-a" || candidate.ID == "node-b" {
				if candidate.Status != "offline" {
					online++
				}
			}
		}
		if online != 2 {
			return false, fmt.Sprintf("%d of 2 nodes have reconnected", online)
		}
		item, known := current.task(taskID)
		if !known {
			return false, "the task identity was lost"
		}
		if len(item.AttemptRunIDs) != 1 || item.AttemptRunIDs[0] != attemptRunID {
			return false, fmt.Sprintf("the task records %d attempts", len(item.AttemptRunIDs))
		}
		attempt, known := current.run(attemptRunID)
		if !known {
			return false, "the attempt run identity was lost"
		}
		return attempt.Status == "running", "the attempt is " + attempt.Status
	})

	cluster.openGate("durable-release")
	final := cluster.eventually("the durable work to complete", func(current snapshot) (bool, string) {
		item, known := current.task(taskID)
		return known && item.Status == "completed", "the work has not completed"
	})
	item, _ := final.task(taskID)
	if len(item.AttemptRunIDs) != 1 || item.AttemptRunIDs[0] != attemptRunID {
		t.Fatalf("the hub restart retried the work: attempts %v", item.AttemptRunIDs)
	}
	results := 0
	for _, message := range final.messagesIn(threadID) {
		if message.IdempotencyKey == "durable-result" {
			results++
		}
	}
	if results != 1 {
		t.Fatalf("the durable result was recorded %d times, want exactly once", results)
	}
	woken := cluster.eventually("the orchestrator's wake to complete", func(current snapshot) (bool, string) {
		inbox, known := current.inbox(threadID)
		if !known || len(inbox.Wakes) == 0 {
			return false, "no wake has run yet"
		}
		last := inbox.Wakes[len(inbox.Wakes)-1]
		return last.Status == "completed", last.Status
	})
	inbox, _ := woken.inbox(threadID)
	if inbox.ProcessedThrough <= 0 {
		t.Fatalf("the orchestrator inbox did not process any events after the restart: %+v", inbox)
	}
}

// TestApprovalExpiry proves that an operator who decides after an approval's lifetime cannot
// resurrect it: the late resolution is refused, the expiry is attributed to the system, the
// blocked harness callback is released with the safe fallback — the offered rejection, never an
// allowance — so the run finishes, and no option is ever recorded for a decision that arrived too
// late.
func TestApprovalExpiry(t *testing.T) {
	t.Parallel()
	cluster := newWorkflowCluster(t, environmentOptions{clockOffset: true}, "")

	needsApproval := script(t,
		step{Permission: &permission{ToolCallID: "expiring", Title: "Deploy to staging", Kind: "execute", Options: allowOrReject, As: "approval"}},
		step{Message: "outcome={{approval.outcome.outcome}} option={{approval.outcome.optionId}}"},
	)
	orchestrate := script(t,
		submitTasks("approval-expiry", "batch", taskSpecification{
			Key: "needs-approval", Title: "needs-approval",
			Instructions: "Ask for a deployment decision.\n" + needsApproval,
			Requirements: map[string]any{"harnessIds": []string{"codex-cli"}},
		}),
		step{Message: "submitted {{batch.submissionId}}"},
	)
	orchestratorRun := cluster.sendMessage(cluster.orchestrator, "Run one worker that needs a late decision.\n"+orchestrate, "")
	threadID := orchestratorRun.ThreadID

	pending := cluster.eventually("the approval to be pending", func(current snapshot) (bool, string) {
		item, known := current.threadTasks(threadID)["needs-approval"]
		if !known {
			return false, "the worker task was not submitted yet"
		}
		attempt, known := current.latestAttempt(item)
		if !known || attempt.Status != "running" {
			return false, "the attempt is not running"
		}
		return len(current.approvalsFor(attempt.ID)) == 1, "the approval was not raised"
	})
	approvalTask := pending.threadTasks(threadID)["needs-approval"]
	attemptRun, _ := pending.latestAttempt(approvalTask)
	raised := pending.approvalsFor(attemptRun.ID)[0]
	if raised.Status != "pending" {
		t.Fatalf("the raised approval is %s", raised.Status)
	}

	// The operator waits past the approval's lifetime; hub time moves ten minutes forward.
	cluster.hub.advanceClock(10 * time.Minute)
	if status, _ := cluster.resolveApproval(raised.ID, "late-operator", "allow"); status != http.StatusConflict {
		t.Fatalf("resolving an expired approval returned %d, want %d", status, http.StatusConflict)
	}
	expired := cluster.eventually("the approval to expire by itself", func(current snapshot) (bool, string) {
		for _, candidate := range current.approvalsFor(attemptRun.ID) {
			if candidate.ID == raised.ID {
				return candidate.Status == "expired" && candidate.ResolvedBy.kind() == "system", candidate.Status + " by " + candidate.ResolvedBy.kind()
			}
		}
		return false, "the approval vanished"
	})
	final := cluster.eventually("the work to complete after its callback was released", func(current snapshot) (bool, string) {
		item, known := current.task(approvalTask.ID)
		return known && item.Status == "completed", "the work has not completed"
	})
	finalRun, _ := final.run(attemptRun.ID)
	// A permission released without a hub decision falls back to the offered rejection, so an
	// expired approval can never let the tool through.
	if outcome := outputField(t, finalRun.Output, "outcome"); outcome != "selected" {
		t.Fatalf("the released callback reported outcome %q, want a fallback selection", outcome)
	}
	if option := outputField(t, finalRun.Output, "option"); option != "reject" {
		t.Fatalf("the expired approval fell back to option %q, want the reject option", option)
	}
	expiredApproval := expired.approvalsFor(attemptRun.ID)[0]
	if expiredApproval.SelectedOptionID != "" {
		t.Fatalf("the expired approval recorded a decision: %q", expiredApproval.SelectedOptionID)
	}
	if status, _ := cluster.resolveApproval(raised.ID, "operator-retry", "allow"); status != http.StatusConflict {
		t.Fatalf("a second late resolution returned %d, want %d", status, http.StatusConflict)
	}
}

// legacyNodeID identifies the version-3 Barista TestMixedProtocolVersions simulates in-process.
const legacyNodeID = "node-legacy"

// legacyBarista is a minimal in-process Barista that registers with control protocol version 3.
// It accepts direct dispatches and answers them itself, but a version-3 peer can never receive
// task-attempt execution fields, so orchestration must refuse to place work on it.
type legacyBarista struct {
	connection   *websocket.Conn
	lifetime     context.Context
	nodeID       string
	version      string
	dispatches   chan json.RawMessage
	synchronized bool
}

// startLegacyBarista connects a version-3 Barista to the hub and serves it until the scenario ends.
func startLegacyBarista(t *testing.T, hubPort int, workspaceRoot string) *legacyBarista {
	return startCompatibilityBarista(t, hubPort, workspaceRoot, legacyNodeID, "3")
}

// startCompatibilityBarista is the bounded control-socket peer used only to prove rolling-version
// exclusion. It implements the advertised version's barrier and legacy dispatch, never v5 residency.
func startCompatibilityBarista(t *testing.T, hubPort int, workspaceRoot, nodeID, version string) *legacyBarista {
	t.Helper()
	lifetime, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	connection, _, err := websocket.Dial(lifetime, fmt.Sprintf("ws://127.0.0.1:%d/control-agent", hubPort), &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + enrollmentToken}},
	})
	if err != nil {
		t.Fatalf("dial the hub as a version-%s Barista: %v", version, err)
	}
	// Registered after the environment's own teardown, so this runs first and the connection closes
	// before the hub does.
	t.Cleanup(func() { connection.Close(websocket.StatusNormalClosure, "scenario finished") })
	barista := &legacyBarista{connection: connection, lifetime: lifetime, nodeID: nodeID, version: version, dispatches: make(chan json.RawMessage, 16)}
	reportedVersion := "0.0." + version + "-compatibility"
	if version == "3" {
		reportedVersion = "0.0.3-legacy"
	}
	if err := barista.send(protocol.Outbound{
		Type: "register", ProtocolVersion: version,
		Node: &protocol.ComputeNode{
			ID: nodeID, Name: "Compatibility node", Kind: "local", Platform: "linux-amd64", Status: "online",
			LastSeen: legacyTimestamp(), Concurrency: 2, WorkspaceRoots: []string{workspaceRoot},
			Harnesses: []protocol.HarnessProfile{{
				ID: "codex-cli", Label: "Codex", Description: "codex-cli 0.40.0", Binary: "codex",
				Available: true, AuthMode: "local-account", Models: []string{},
			}},
			Version: reportedVersion,
		},
	}); err != nil {
		t.Fatal(err)
	}
	go barista.readLoop()
	return barista
}

func (barista *legacyBarista) send(message protocol.Outbound) error {
	encoded, err := json.Marshal(message)
	if err != nil {
		return err
	}
	return barista.connection.Write(barista.lifetime, websocket.MessageText, encoded)
}

func legacyTimestamp() string { return time.Now().UTC().Format(time.RFC3339Nano) }

// readLoop answers the hub until the connection closes. All sends and the synchronization flag stay
// on this goroutine, and dispatches reach the scenario only through the channel.
func (barista *legacyBarista) readLoop() {
	for {
		_, data, err := barista.connection.Read(barista.lifetime)
		if err != nil {
			return
		}
		var envelope struct {
			Type string `json:"type"`
			Run  struct {
				ID string `json:"id"`
			} `json:"run"`
		}
		if json.Unmarshal(data, &envelope) != nil {
			continue
		}
		switch envelope.Type {
		case "ping":
			// The first ping acknowledges the registration and is followed by the reconnect barrier;
			// later ones are answered as heartbeats.
			if barista.synchronized {
				activeRuns := 0
				_ = barista.send(protocol.Outbound{Type: "heartbeat", NodeID: barista.nodeID, ActiveRuns: &activeRuns, At: legacyTimestamp()})
			} else {
				barrier := protocol.Outbound{Type: "sync.complete", NodeID: barista.nodeID, At: legacyTimestamp()}
				if barista.version == "4" {
					empty := []string{}
					barrier.ActiveRunIDs = &empty
				}
				_ = barista.send(barrier)
				barista.synchronized = true
			}
		case "dispatch":
			select {
			case barista.dispatches <- append(json.RawMessage(nil), data...):
			default:
			}
			_ = barista.send(protocol.Outbound{Type: "run.started", RunID: envelope.Run.ID, At: legacyTimestamp()})
			_ = barista.send(protocol.Outbound{Type: "run.completed", RunID: envelope.Run.ID, Output: "legacy done", At: legacyTimestamp()})
		}
	}
}

// recordedDispatches drains the dispatches the legacy Barista has received so far.
func (barista *legacyBarista) recordedDispatches() []json.RawMessage {
	recorded := []json.RawMessage{}
	for {
		select {
		case raw := <-barista.dispatches:
			recorded = append(recorded, raw)
		default:
			return recorded
		}
	}
}

// TestMixedProtocolVersions proves the rolling-upgrade contract: a hub that still accepts a
// version-3 Barista keeps direct operator messaging working on it — sending only the dispatch
// fields that version understands — while orchestration fails closed for it with a placement
// diagnosis instead of silently degrading, and version-4 nodes in the same hub keep executing
// orchestration work unaffected.
func TestMixedProtocolVersions(t *testing.T) {
	t.Parallel()
	cluster := newWorkflowCluster(t, environmentOptions{}, "")

	legacyWorkspace := filepath.Join(cluster.root, "legacy-workspace")
	if err := os.MkdirAll(legacyWorkspace, 0o755); err != nil {
		t.Fatal(err)
	}
	legacy := startLegacyBarista(t, cluster.hub.port, legacyWorkspace)
	cluster.eventually("the legacy node to register", func(current snapshot) (bool, string) {
		for _, candidate := range current.Nodes {
			if candidate.ID == legacyNodeID {
				return candidate.Status != "offline" && candidate.Version == "0.0.3-legacy", candidate.Status + " running " + candidate.Version
			}
		}
		return false, "the legacy node has not registered"
	})
	legacyAgent := cluster.createAgent(agentOptions{
		name: "Legacy Builder", harnessID: "codex-cli", model: "default", nodeID: legacyNodeID,
		workspace: legacyWorkspace, skills: []string{"legacy"},
	})

	// Direct operator messaging still works on a version-3 node.
	hello := cluster.sendMessage(legacyAgent, "Say hello", "")
	legacyRun := cluster.eventually("the direct run on the legacy node to complete", func(current snapshot) (bool, string) {
		item, known := current.run(hello.ID)
		return known && item.Status == "completed", "the run is not completed"
	})
	completedRun, _ := legacyRun.run(hello.ID)
	if completedRun.Output != "legacy done" {
		t.Fatalf("the legacy run produced %q", completedRun.Output)
	}
	var dispatched map[string]json.RawMessage
	for _, raw := range legacy.recordedDispatches() {
		var decoded struct {
			Run protocol.Run `json:"run"`
		}
		if json.Unmarshal(raw, &decoded) != nil || decoded.Run.ID != hello.ID {
			continue
		}
		if err := json.Unmarshal(raw, &dispatched); err != nil {
			t.Fatal(err)
		}
	}
	if dispatched == nil {
		t.Fatal("the legacy node never received the direct run's dispatch")
	}
	if execution, present := dispatched["execution"]; present {
		t.Fatalf("a version-3 dispatch carried execution fields: %s", execution)
	}

	// Orchestration fails closed for the legacy node while version-4 compute keeps working.
	orchestrate := script(t,
		submitTasks("mixed-versions", "batch",
			taskSpecification{
				Key: "legacy-only", Title: "legacy-only",
				Instructions: "Run on the legacy fleet.\n" + script(t, step{Message: "legacy work ran"}),
				Pin:          map[string]any{"agentId": legacyAgent},
			},
			taskSpecification{
				Key: "modern", Title: "modern",
				Instructions: "Run on the modern fleet.\n" + script(t, step{Message: "modern done"}),
				Requirements: map[string]any{"harnessIds": []string{"claude-cli"}},
			},
		),
		step{Message: "submitted {{batch.submissionId}}"},
	)
	orchestratorRun := cluster.sendMessage(cluster.orchestrator, "Place one piece of work on each protocol generation.\n"+orchestrate, "")
	threadID := orchestratorRun.ThreadID

	final := cluster.eventually("the modern work to complete while the legacy work is refused", func(current snapshot) (bool, string) {
		tasks := current.threadTasks(threadID)
		modern, known := tasks["modern"]
		if !known {
			return false, "the work was not submitted yet"
		}
		legacyTask, known := tasks["legacy-only"]
		if !known {
			return false, "the legacy work was not submitted yet"
		}
		if modern.Status != "completed" {
			return false, "the modern work is " + modern.Status
		}
		if legacyTask.Status != "ready" || len(legacyTask.AttemptRunIDs) != 0 {
			return false, fmt.Sprintf("the legacy work is %s with %d attempts", legacyTask.Status, len(legacyTask.AttemptRunIDs))
		}
		if legacyTask.Placement == nil {
			return false, "the legacy work has no placement diagnosis"
		}
		for _, entry := range legacyTask.Placement.Unsatisfied {
			if entry.Kind == "protocol-version" && entry.NodeID == legacyNodeID {
				return true, ""
			}
		}
		return false, "the legacy work has no protocol-version diagnosis"
	})
	modernRun, _ := final.latestAttempt(final.threadTasks(threadID)["modern"])
	if modernRun.NodeID != "node-b" || modernRun.HarnessID != "claude-cli" {
		t.Fatalf("the modern work ran on %s/%s, want node-b over claude-cli", modernRun.NodeID, modernRun.HarnessID)
	}
	for _, raw := range legacy.recordedDispatches() {
		var decoded struct {
			Run protocol.Run `json:"run"`
		}
		if json.Unmarshal(raw, &decoded) != nil {
			continue
		}
		if decoded.Run.TaskID != "" {
			t.Fatalf("the legacy node received a dispatch for a task attempt: %s", raw)
		}
	}
}
