//go:build system && unix

package systemtest

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// unsatisfiedEntries returns every placement diagnostic entry of the given kind and requirement, so
// a scenario can assert why the scheduler declined to place work. Each candidate agent contributes
// its own entries, so one task can carry several for the same requirement.
func unsatisfiedEntries(item task, kind, requirement string) []unsatisfiedRequirement {
	entries := []unsatisfiedRequirement{}
	if item.Placement == nil {
		return entries
	}
	for _, entry := range item.Placement.Unsatisfied {
		if entry.Kind == kind && entry.Requirement == requirement {
			entries = append(entries, entry)
		}
	}
	return entries
}

// TestAdapterCrashBlocksDependents proves that a provider adapter process dying mid-prompt is
// surfaced as a failed attempt that carries the adapter's exit code, is never retried, and blocks —
// rather than starts — a dependent task whose prerequisite did not succeed. A worker that crashed
// must not leave the graph pretending progress or spawning duplicate work.
func TestAdapterCrashBlocksDependents(t *testing.T) {
	t.Parallel()
	cluster := newWorkflowCluster(t, environmentOptions{}, "")

	requirements := map[string]any{"harnessIds": []string{"claude-cli"}}
	orchestrate := script(t,
		submitTasks("crash-graph", "batch",
			taskSpecification{
				Key: "crashing", Title: "crashing",
				Instructions: "Emit one message, then exit nonzero.\n" + script(t,
					step{Message: "crashing is about to exit"},
					step{Crash: 5},
				),
				Requirements: requirements,
			},
			taskSpecification{
				Key: "dependent", Title: "dependent",
				Instructions: "Run after the prerequisite.\n" + script(t, step{Message: "dependent done"}),
				Requirements: requirements,
				Dependencies: dependsOn("crashing"),
			},
		),
		step{Message: "submitted"},
	)
	orchestratorRun := cluster.sendMessage(cluster.orchestrator, "Run the graph that contains a crashing worker.\n"+orchestrate, "")
	threadID := orchestratorRun.ThreadID

	current := cluster.eventually("the crashed attempt to fail without a retry", func(current snapshot) (bool, string) {
		tasks := current.threadTasks(threadID)
		crashing, dependent := tasks["crashing"], tasks["dependent"]
		if crashing.Status != "failed" || len(crashing.AttemptRunIDs) != 1 {
			return false, fmt.Sprintf("crashing is %s with %d attempts", crashing.Status, len(crashing.AttemptRunIDs))
		}
		if dependent.Status != "blocked" || len(dependent.AttemptRunIDs) != 0 {
			return false, fmt.Sprintf("dependent is %s with %d attempts", dependent.Status, len(dependent.AttemptRunIDs))
		}
		return true, ""
	})
	crashingRun, _ := current.latestAttempt(current.threadTasks(threadID)["crashing"])
	if crashingRun.Status != "failed" || crashingRun.Error == "" {
		t.Fatalf("the crashed attempt did not fail with a surfaced error: %+v", crashingRun)
	}
	crashed := false
	for _, records := range cluster.harnessRecords() {
		role := ""
		for _, record := range records {
			switch record.Event {
			case "start":
				role = record.Role
			case "exit":
				crashed = crashed || (role == "claude-agent-acp" && record.Code == 5)
			}
		}
	}
	if !crashed {
		t.Fatalf("no claude ACP adapter recorded an exit with code 5: %+v", cluster.harnessRecords())
	}
}

// TestMalformedACPFrameFailsRun proves that a harness corrupting the ACP stream mid-prompt fails its
// run with a surfaced error instead of hanging or silently switching transports after work has
// already begun, that the adapter process does not outlive the failed run, and that the hub's
// activity projection stops claiming an open stream for a run that is over.
func TestMalformedACPFrameFailsRun(t *testing.T) {
	t.Parallel()
	cluster := newWorkflowCluster(t, environmentOptions{}, "")

	orchestrate := script(t,
		submitTasks("malformed-frame", "batch", taskSpecification{
			Key: "malformed", Title: "malformed",
			Instructions: "Stream one message, then corrupt the stream.\n" + script(t,
				step{Message: "before the malformed frame"},
				step{Raw: "this is not an ACP frame\n"},
				step{Hang: true},
			),
			Requirements: map[string]any{"harnessIds": []string{"codex-cli"}},
		}),
		step{Message: "submitted"},
	)
	orchestratorRun := cluster.sendMessage(cluster.orchestrator, "Run the task whose harness corrupts its stream.\n"+orchestrate, "")
	threadID := orchestratorRun.ThreadID

	current := cluster.eventually("the malformed frame to fail the attempt", func(current snapshot) (bool, string) {
		item, known := current.threadTasks(threadID)["malformed"]
		if !known {
			return false, "the malformed task does not exist yet"
		}
		if item.Status != "failed" || len(item.AttemptRunIDs) != 1 {
			return false, fmt.Sprintf("malformed is %s with %d attempts", item.Status, len(item.AttemptRunIDs))
		}
		attempt, _ := current.latestAttempt(item)
		return attempt.Status == "failed" && attempt.Error != "",
			fmt.Sprintf("the attempt is %s with error %q", attempt.Status, attempt.Error)
	})
	malformedRun, _ := current.latestAttempt(current.threadTasks(threadID)["malformed"])
	// The adapter that ran the prompt is the only codex-acp process that recorded one; startup
	// probes never prompt and the orchestrator runs the native CLI.
	adapterPIDs := []int{}
	for _, records := range cluster.harnessRecords() {
		if len(records) == 0 || records[0].Event != "start" || records[0].Role != "codex-acp" {
			continue
		}
		for _, record := range records {
			if record.Event == "prompt" {
				adapterPIDs = append(adapterPIDs, records[0].PID)
				break
			}
		}
	}
	if len(adapterPIDs) != 1 {
		t.Fatalf("expected exactly one prompted codex adapter process, found %v", adapterPIDs)
	}
	waitFor(t, "the malformed run's adapter process to exit", func() bool {
		return !processAlive(t, adapterPIDs[0])
	})
	cluster.eventually("the failed run's activity stream to stop being open", func(current snapshot) (bool, string) {
		activity := current.activity(malformedRun.ID)
		if activity == nil {
			return false, "the run has no activity projection"
		}
		streamStatus, _ := activity["streamStatus"].(string)
		return streamStatus == "failed" || streamStatus == "closed", streamStatus
	})
}

// TestACPCancellation proves that an operator cancelling a running ACP attempt reaches the adapter
// cooperatively — the adapter is asked to stop rather than only killed — ends the run and its task
// as cancelled, and never produces a replacement attempt for work the operator abandoned.
func TestACPCancellation(t *testing.T) {
	t.Parallel()
	cluster := newWorkflowCluster(t, environmentOptions{}, "")

	orchestrate := script(t,
		submitTasks("cancel-hang", "batch", taskSpecification{
			Key: "long-running", Title: "long-running",
			Instructions: "Stream one message, then work until stopped.\n" + script(t,
				step{Message: "working"},
				step{Hang: true},
			),
			Requirements: map[string]any{"harnessIds": []string{"codex-cli"}},
		}),
		step{Message: "submitted"},
	)
	orchestratorRun := cluster.sendMessage(cluster.orchestrator, "Run the task that works until it is stopped.\n"+orchestrate, "")
	threadID := orchestratorRun.ThreadID

	var hangingRunID string
	cluster.eventually("the hanging attempt to stream its first message", func(current snapshot) (bool, string) {
		item, known := current.threadTasks(threadID)["long-running"]
		if !known {
			return false, "the long-running task does not exist yet"
		}
		attempt, found := current.latestAttempt(item)
		if !found || attempt.Status != "running" {
			return false, "the long-running attempt is not running"
		}
		activity := current.activity(attempt.ID)
		summary, _ := activity["summary"].(string)
		if !strings.Contains(summary, "working") {
			return false, "the first message has not streamed yet"
		}
		hangingRunID = attempt.ID
		return true, ""
	})
	if status := cluster.hub.request(http.MethodPost, "/api/runs/"+hangingRunID+"/cancel", nil, nil); status != http.StatusOK {
		t.Fatalf("cancelling the hanging run returned %d", status)
	}
	cluster.eventually("the cancelled run and its task to settle", func(current snapshot) (bool, string) {
		item, known := current.threadTasks(threadID)["long-running"]
		if !known {
			return false, "the long-running task vanished"
		}
		if item.Status != "cancelled" || len(item.AttemptRunIDs) != 1 {
			return false, fmt.Sprintf("the task is %s with %d attempts", item.Status, len(item.AttemptRunIDs))
		}
		attempt, _ := current.latestAttempt(item)
		return attempt.Status == "cancelled", attempt.Status
	})
	waitFor(t, "the adapter to record the cooperative cancellation", func() bool {
		for _, records := range cluster.harnessRecords() {
			for _, record := range records {
				if record.Event == "prompt-cancelled" {
					return true
				}
			}
		}
		return false
	})
}

// TestNoEligibleComputeWaitsForQualifyingNode proves that placement waits rather than compromises: a
// task whose gpu label requirement no node satisfies stays ready with zero attempts and a
// diagnostic naming the missing label and the node that lacks it, and once a node restarts with the
// label the task runs there — exactly once, not once per scheduling pass while it waited.
func TestNoEligibleComputeWaitsForQualifyingNode(t *testing.T) {
	t.Parallel()
	environment := newEnvironment(t, environmentOptions{})
	nodeA := environment.startNode(nodeOptions{id: "node-a", codex: true})
	nodeGPU := environment.startNode(nodeOptions{id: "node-gpu", codex: true})
	orchestrator := environment.createAgent(agentOptions{
		name: "Orchestrator", harnessID: "codex-cli", model: "default", nodeID: "node-a",
		workspace: nodeA.directory("orchestration"), canDelegate: true,
		systemPrompt: "Coordinate the render job.\n" + acknowledgeWake(t),
	})
	environment.createAgent(agentOptions{
		name: "GPU Builder", harnessID: "codex-cli", model: "default", nodeID: "node-gpu",
		workspace: nodeGPU.directory("gpu-work"), skills: []string{"gpu-build"},
	})
	orchestrate := script(t,
		submitTasks("gpu-render", "batch", taskSpecification{
			Key: "render", Title: "render",
			Instructions: "Render the frame.\n" + script(t, step{Message: "render done"}),
			Requirements: map[string]any{"labels": []string{"gpu"}},
		}),
		step{Message: "submitted"},
	)
	orchestratorRun := environment.sendMessage(orchestrator, "Render the frame on a gpu node.\n"+orchestrate, "")
	threadID := orchestratorRun.ThreadID

	environment.eventually("the render task to wait for a qualifying node", func(current snapshot) (bool, string) {
		item, known := current.threadTasks(threadID)["render"]
		if !known {
			return false, "the render task does not exist yet"
		}
		if item.Status != "ready" || len(item.AttemptRunIDs) != 0 {
			return false, fmt.Sprintf("render is %s with %d attempts", item.Status, len(item.AttemptRunIDs))
		}
		// Every candidate agent gets its own diagnostic; the one that matters names the only node
		// that could ever satisfy the gpu label.
		for _, entry := range unsatisfiedEntries(item, "label", "gpu") {
			if entry.NodeID == "node-gpu" {
				return true, ""
			}
		}
		return false, "the gpu label diagnostic does not name node-gpu"
	})
	settled := environment.eventually("the orchestrator's submission run to complete", func(current snapshot) (bool, string) {
		item, _ := current.run(orchestratorRun.ID)
		return item.Status == "completed", item.Status
	})
	if item, known := settled.threadTasks(threadID)["render"]; !known || item.Status != "ready" || len(item.AttemptRunIDs) != 0 {
		t.Fatalf("the render task was scheduled without a qualifying node: %+v", item)
	}

	nodeGPU.options.labels = []string{"gpu"}
	nodeGPU.restart()
	environment.eventually("the render task to complete on the qualifying node", func(current snapshot) (bool, string) {
		item, known := current.threadTasks(threadID)["render"]
		if !known {
			return false, "the render task vanished"
		}
		if item.Status != "completed" || len(item.AttemptRunIDs) != 1 {
			return false, fmt.Sprintf("render is %s with %d attempts", item.Status, len(item.AttemptRunIDs))
		}
		attempt, _ := current.latestAttempt(item)
		return attempt.NodeID == "node-gpu" && attempt.Status == "completed",
			fmt.Sprintf("the attempt runs on %s and is %s", attempt.NodeID, attempt.Status)
	})
}

// TestNativeFallbackWhenACPUnusable proves the operator-permitted escape hatch for a broken ACP
// adapter: when the provider violates the protocol before the prompt is sent, the attempt still
// completes through the native CLI, and the substitution is visible in the run's transport
// selection, its event stream, and the harness processes that actually ran.
func TestNativeFallbackWhenACPUnusable(t *testing.T) {
	t.Parallel()
	cluster := newWorkflowCluster(t, environmentOptions{}, "")

	fallbackWorkspace := cluster.nodeA.directory("fallback-work")
	if err := os.WriteFile(filepath.Join(fallbackWorkspace, ".fake-acp-reject-session"), []byte("reject ACP sessions\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	fallbackAgent := cluster.createAgent(agentOptions{
		name: "Fallback Builder", harnessID: "codex-cli", model: "default", nodeID: "node-a",
		workspace: fallbackWorkspace, skills: []string{"fallback"},
	})
	orchestrate := script(t,
		submitTasks("fallback-dispatch", "batch", taskSpecification{
			Key: "fallback", Title: "fallback",
			Instructions: "Produce the result through whichever transport works.\n" + script(t, step{Message: "fallback result=done"}),
			Pin:          map[string]any{"agentId": fallbackAgent},
		}),
		step{Message: "submitted"},
	)
	orchestratorRun := cluster.sendMessage(cluster.orchestrator, "Run the task whose ACP adapter is unusable.\n"+orchestrate, "")
	threadID := orchestratorRun.ThreadID

	current := cluster.eventually("the fallback attempt to complete", func(current snapshot) (bool, string) {
		item, known := current.threadTasks(threadID)["fallback"]
		if !known {
			return false, "the fallback task does not exist yet"
		}
		return item.Status == "completed" && len(item.AttemptRunIDs) == 1,
			fmt.Sprintf("fallback is %s with %d attempts", item.Status, len(item.AttemptRunIDs))
	})
	fallbackRun, _ := current.latestAttempt(current.threadTasks(threadID)["fallback"])
	if fallbackRun.Transport != "acp-v1" || fallbackRun.FallbackTransport != "native-cli" {
		t.Fatalf("the attempt did not request ACP with a permitted native fallback: %+v", fallbackRun)
	}
	selection := fallbackRun.TransportSelection
	if selection == nil || selection.RequestedTransport != "acp-v1" || selection.SelectedTransport != "native-cli" || selection.FallbackReason != "acp-protocol-incompatible" {
		t.Fatalf("the transport substitution was not recorded on the run: %+v", selection)
	}
	if outputField(t, fallbackRun.Output, "result") != "done" {
		t.Fatalf("the native run did not produce the scripted result: %q", fallbackRun.Output)
	}
	events, _ := cluster.runEvents(fallbackRun.ID)
	warned := false
	for _, event := range events {
		warned = warned || (event["type"] == "warning" && event["code"] == "transport-native-fallback")
	}
	if !warned {
		t.Fatalf("the fallback was not announced as a warning event: %v", events)
	}
	rejected, nativeRuns := false, 0
	for _, records := range cluster.harnessRecords() {
		for _, record := range records {
			if record.Event == "session-rejected" {
				rejected = true
			}
			if record.Event == "start" && record.Role == "codex" {
				nativeRuns++
			}
		}
	}
	if !rejected || nativeRuns < 2 {
		t.Fatalf("the unusable adapter was not rejected before a native run took over: rejected=%v nativeRuns=%d", rejected, nativeRuns)
	}
}

// TestExclusiveWorkspaceCollision proves that two agents sharing one exclusive-existing checkout can
// never run tasks in it concurrently: while one attempt holds the checkout the other task waits in
// ready with a capacity diagnostic naming the exclusive workspace, and it runs — exactly once, only
// after the holder finished and released the workspace.
func TestExclusiveWorkspaceCollision(t *testing.T) {
	t.Parallel()
	profiles := []map[string]any{
		projectProfile("shared-checkout", "exclusive-existing", "retain"),
		projectProfile(e2eProject, "git-worktree", "when-unchanged"),
	}
	cluster := newWorkflowCluster(t, environmentOptions{profiles: profiles}, "")
	agentIDs := []string{}
	for _, name := range []string{"Exclusive One", "Exclusive Two"} {
		agentIDs = append(agentIDs, cluster.createAgent(agentOptions{
			name: name, harnessID: "codex-cli", model: "default", nodeID: "node-a",
			workspace: cluster.checkoutA, skills: []string{"exclusive"},
		}))
	}
	requirements := map[string]any{
		"projectProfileId": "shared-checkout",
		"workspace":        map[string]any{"writable": true},
	}
	scripted := func(name string) string {
		return script(t, step{Gate: "exclusive-hold-" + name}, step{Message: name + " done"})
	}
	orchestrate := script(t,
		submitTasks("exclusive-collision", "batch",
			taskSpecification{Key: "holder", Title: "holder", Instructions: "Hold the shared checkout.\n" + scripted("holder"), Requirements: requirements, Pin: map[string]any{"agentId": agentIDs[0]}},
			taskSpecification{Key: "waiter", Title: "waiter", Instructions: "Wait for the shared checkout.\n" + scripted("waiter"), Requirements: requirements, Pin: map[string]any{"agentId": agentIDs[1]}},
		),
		step{Message: "submitted"},
	)
	orchestratorRun := cluster.sendMessage(cluster.orchestrator, "Run both tasks against the shared checkout.\n"+orchestrate, "")
	threadID := orchestratorRun.ThreadID

	runningTitle, waitingTitle := "", ""
	cluster.eventually("exactly one task to hold the exclusive workspace", func(current snapshot) (bool, string) {
		tasks := current.threadTasks(threadID)
		holderRun, holderFound := current.latestAttempt(tasks["holder"])
		waiterRun, waiterFound := current.latestAttempt(tasks["waiter"])
		if holderFound && holderRun.Status == "running" && !waiterFound {
			runningTitle, waitingTitle = "holder", "waiter"
			return true, ""
		}
		if waiterFound && waiterRun.Status == "running" && !holderFound {
			runningTitle, waitingTitle = "waiter", "holder"
			return true, ""
		}
		return false, fmt.Sprintf("holder found=%v running=%v, waiter found=%v running=%v",
			holderFound, holderFound && holderRun.Status == "running", waiterFound, waiterFound && waiterRun.Status == "running")
	})
	settled := cluster.eventually("the waiting task to report the occupied exclusive workspace", func(current snapshot) (bool, string) {
		item := current.threadTasks(threadID)[waitingTitle]
		if item.Status != "ready" || len(item.AttemptRunIDs) != 0 {
			return false, fmt.Sprintf("%s is %s with %d attempts", waitingTitle, item.Status, len(item.AttemptRunIDs))
		}
		found := len(unsatisfiedEntries(item, "capacity", "exclusive workspace")) > 0
		return found, "the exclusive workspace capacity diagnostic is missing"
	})
	holderTask := settled.threadTasks(threadID)[runningTitle]
	holderRun, _ := settled.latestAttempt(holderTask)
	lease, known := settled.lease(holderRun.WorkspaceLeaseID)
	if !known || lease.Policy != "exclusive-existing" || lease.WorktreePath != cluster.checkoutA {
		t.Fatalf("the running task did not lease the shared checkout exclusively: %+v", lease)
	}
	cluster.openGate("exclusive-hold-" + runningTitle)
	cluster.eventually("the holder to finish", func(current snapshot) (bool, string) {
		item := current.threadTasks(threadID)[runningTitle]
		return item.Status == "completed" && len(item.AttemptRunIDs) == 1,
			fmt.Sprintf("%s is %s with %d attempts", runningTitle, item.Status, len(item.AttemptRunIDs))
	})
	cluster.eventually("the waiter to take over the workspace", func(current snapshot) (bool, string) {
		item := current.threadTasks(threadID)[waitingTitle]
		attempt, found := current.latestAttempt(item)
		return found && attempt.Status == "running", fmt.Sprintf("%s attempt found=%v", waitingTitle, found)
	})
	cluster.openGate("exclusive-hold-" + waitingTitle)
	final := cluster.eventually("both tasks to complete", func(current snapshot) (bool, string) {
		tasks := current.threadTasks(threadID)
		return tasks[runningTitle].Status == "completed" && tasks[waitingTitle].Status == "completed",
			fmt.Sprintf("%s %s, %s %s", runningTitle, tasks[runningTitle].Status, waitingTitle, tasks[waitingTitle].Status)
	})
	tasks := final.threadTasks(threadID)
	for title, item := range tasks {
		if item.Status != "completed" || len(item.AttemptRunIDs) != 1 {
			t.Fatalf("task %s ended %s with %d attempts", title, item.Status, len(item.AttemptRunIDs))
		}
	}
	holderFinal, _ := final.run(holderRun.ID)
	waiterRun, _ := final.latestAttempt(tasks[waitingTitle])
	if waiterRun.CreatedAt < holderFinal.FinishedAt {
		t.Fatalf("the waiter started before the holder finished: %s vs %s", waiterRun.CreatedAt, holderFinal.FinishedAt)
	}
}

// TestCrossThreadAccessIsRejected proves thread isolation of the task tools: an orchestrator working
// in one thread cannot read, message, or even distinguish a task that belongs to another thread —
// the errors are identical to those for a nonexistent task, so thread membership leaks nothing — and
// the foreign task itself is unaffected and completes normally.
func TestCrossThreadAccessIsRejected(t *testing.T) {
	t.Parallel()
	cluster := newWorkflowCluster(t, environmentOptions{}, "")
	orchestratorWorkspace := cluster.nodeA.directory("orchestration")

	requirements := map[string]any{"harnessIds": []string{"claude-cli"}}
	firstOrchestrate := script(t,
		submitTasks("cross-thread-private", "batch", taskSpecification{
			Key: "private", Title: "private",
			Instructions: "Wait for the release, then finish.\n" + script(t,
				step{Gate: "cross-thread-release"},
				step{Message: "private done"},
			),
			Requirements: requirements,
		}),
		step{Message: "submitted"},
	)
	firstRun := cluster.sendMessage(cluster.orchestrator, "Run the private task in this thread.\n"+firstOrchestrate, "")
	threadOne := firstRun.ThreadID

	var privateTaskID string
	cluster.eventually("the private task to be running", func(current snapshot) (bool, string) {
		item, known := current.threadTasks(threadOne)["private"]
		if !known {
			return false, "the private task does not exist yet"
		}
		attempt, found := current.latestAttempt(item)
		if !found || attempt.Status != "running" {
			return false, "the private task is not running"
		}
		privateTaskID = item.ID
		return true, ""
	})

	probe := script(t,
		step{Call: "get_task_context", Arguments: map[string]any{"taskId": privateTaskID}, AllowError: true, As: "foreign"},
		step{Call: "get_task_context", Arguments: map[string]any{"taskId": "task_does_not_exist"}, AllowError: true, As: "missing"},
		step{Call: "send_task_message", AllowError: true, As: "send", Arguments: map[string]any{
			"idempotencyKey": "cross-thread-probe",
			"recipient":      map[string]any{"type": "task", "taskId": privateTaskID},
			"kind":           "instruction", "body": "stop",
		}},
		// The native CLI's run output is only its last message, so the in-harness equality check
		// leaves its evidence in a file instead of an earlier streamed message.
		step{When: &condition{Path: "foreign.error.message", Equals: "{{missing.error.message}}"},
			WriteFile: &writeFile{Path: "same-message", Content: "the errors are indistinguishable\n"}},
		step{Message: "foreign={{foreign.error.code}} missing={{missing.error.code}} send={{send.error.code}}"},
	)
	secondRun := cluster.sendMessage(cluster.orchestrator, "Probe another thread's task from a new thread.\n"+probe, "")
	current := cluster.eventually("the probing run to complete", func(current snapshot) (bool, string) {
		item, _ := current.run(secondRun.ID)
		return item.Status == "completed", item.Status
	})
	probeRun, _ := current.run(secondRun.ID)
	for _, name := range []string{"foreign", "missing", "send"} {
		if outputField(t, probeRun.Output, name) != "not_found" {
			t.Fatalf("the %s probe did not fail with not_found: %q", name, probeRun.Output)
		}
	}
	if _, err := os.Stat(filepath.Join(orchestratorWorkspace, "same-message")); err != nil {
		t.Fatalf("the foreign task's error was distinguishable from a nonexistent task's: %q", probeRun.Output)
	}
	for _, message := range current.messagesIn(threadOne) {
		if message.Body == "stop" {
			t.Fatalf("the rejected instruction still reached the private task's thread: %+v", message)
		}
	}

	cluster.openGate("cross-thread-release")
	cluster.eventually("the private task to complete normally", func(current snapshot) (bool, string) {
		item, known := current.threadTasks(threadOne)["private"]
		if !known {
			return false, "the private task vanished"
		}
		return item.Status == "completed" && len(item.AttemptRunIDs) == 1,
			fmt.Sprintf("private is %s with %d attempts", item.Status, len(item.AttemptRunIDs))
	})
}
