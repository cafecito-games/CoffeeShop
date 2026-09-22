//go:build system && unix

package systemtest

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// completeWhenDone is the orchestrator's continuation script: acknowledge exactly the delivered
// range, then complete the thread once every task in its graph has completed.
func completeWhenDone(t *testing.T) string {
	return script(t,
		step{AcknowledgeDelivery: true},
		step{Call: "get_task_context", As: "context"},
		step{When: &condition{Path: "context.taskGraph.*.status", Equals: "completed"}, Call: "update_thread", Arguments: map[string]any{"status": "completed", "summary": "every task completed"}},
		step{Message: "wake session={{session}}"},
	)
}

// TestOrchestratorContinuation proves idle orchestrator recovery: the orchestrator submits a chain
// of tasks and ends its turn, and each prerequisite's completion wakes it through its durable
// inbox. The first wake opens a new ACP session, the second resumes it, and after the provider
// forgets the session the third is safely replaced by a new session with bounded durable context.
// Every relevant event is delivered to exactly one wake and acknowledged exactly once.
func TestOrchestratorContinuation(t *testing.T) {
	t.Parallel()
	cluster := newWorkflowCluster(t, environmentOptions{}, completeWhenDone(t))

	chained := func(gate, name string) string {
		steps := []step{}
		if gate != "" {
			steps = append(steps, step{Gate: gate})
		}
		return script(t, append(steps, step{Message: name + " done"})...)
	}
	requirements := map[string]any{"skills": []string{"build"}, "harnessIds": []string{"claude-cli"}}
	orchestrate := script(t,
		submitTasks("continuation-chain", "batch",
			taskSpecification{Key: "first", Title: "first", Instructions: chained("", "first"), Requirements: requirements},
			taskSpecification{Key: "second", Title: "second", Instructions: chained("continuation-second", "second"), Requirements: requirements, Dependencies: dependsOn("first")},
			taskSpecification{Key: "third", Title: "third", Instructions: chained("continuation-third", "third"), Requirements: requirements, Dependencies: dependsOn("second")},
		),
		step{Message: "submitted {{batch.submissionId}}"},
	)
	initial := cluster.sendMessage(cluster.orchestrator, "Run the chain and report back.\n"+orchestrate, "")
	threadID := initial.ThreadID

	wakeSettled := func(count int, outcome string) snapshot {
		return cluster.eventually(fmt.Sprintf("wake %d to complete with a %s session", count, outcome), func(current snapshot) (bool, string) {
			inbox, _ := current.inbox(threadID)
			if len(inbox.Wakes) < count {
				return false, fmt.Sprintf("%d wakes", len(inbox.Wakes))
			}
			wake := inbox.Wakes[count-1]
			return wake.Status == "completed" && wake.SessionOutcome == outcome, wake.Status + "/" + wake.SessionOutcome
		})
	}
	first := wakeSettled(1, "new")
	if initialRun, _ := first.run(initial.ID); initialRun.Status != "completed" || initialRun.Transport != "" {
		t.Fatalf("the initial orchestrator run should be a completed direct native run: %+v", initialRun)
	}
	if inbox, _ := first.inbox(threadID); len(inbox.Wakes) != 1 {
		t.Fatalf("a wake was scheduled before the second task finished: %+v", inbox.Wakes)
	}
	cluster.openGate("continuation-second")
	wakeSettled(2, "resumed")

	// The provider forgets every session it created, so the next resume is refused.
	entries, err := os.ReadDir(cluster.nodeA.sessions)
	if err != nil || len(entries) == 0 {
		t.Fatalf("the provider recorded no sessions to forget: %v", err)
	}
	for _, entry := range entries {
		if err := os.Remove(filepath.Join(cluster.nodeA.sessions, entry.Name())); err != nil {
			t.Fatal(err)
		}
	}
	cluster.openGate("continuation-third")
	wakeSettled(3, "replaced")

	final := cluster.eventually("the thread to complete", func(current snapshot) (bool, string) {
		item, _ := current.thread(threadID)
		return item.Status == "completed", item.Status
	})
	inbox, _ := final.inbox(threadID)
	if len(inbox.Wakes) != 3 {
		t.Fatalf("expected exactly three wakes, got %+v", inbox.Wakes)
	}
	delivered := []int{}
	previousThrough := 0
	for index, wake := range inbox.Wakes {
		if wake.Redelivery || wake.FromSequence != previousThrough || wake.ThroughSequence < wake.FromSequence || len(wake.EventSequences) != 1 {
			t.Fatalf("wake %d range is not contiguous and single-delivery: %+v", index+1, wake)
		}
		previousThrough = wake.ThroughSequence
		delivered = append(delivered, wake.EventSequences...)
		wakeRun, _ := final.run(wake.RunID)
		if wakeRun.Status != "completed" || wakeRun.NodeID != "node-a" || wakeRun.TransportSelection == nil || wakeRun.TransportSelection.SelectedTransport != "acp-v1" {
			t.Fatalf("wake %d did not run over ACP on the orchestrator's node: %+v", index+1, wakeRun)
		}
	}
	sort.Ints(delivered)
	for index := 1; index < len(delivered); index++ {
		if delivered[index] == delivered[index-1] {
			t.Fatalf("an inbox event was delivered twice: %v", delivered)
		}
	}
	if inbox.ProcessedThrough != previousThrough || inbox.DeliveredThrough != previousThrough {
		t.Fatalf("the inbox was not acknowledged exactly through the last wake: %+v", inbox)
	}

	// The resumed wake reused the first wake's binding; the third replaced it with a new one.
	firstWake, secondWake, thirdWake := inbox.Wakes[0], inbox.Wakes[1], inbox.Wakes[2]
	if firstWake.RequestedSessionBindingID != "" || secondWake.RequestedSessionBindingID == "" || thirdWake.RequestedSessionBindingID != secondWake.RequestedSessionBindingID {
		t.Fatalf("wakes did not request the expected bindings: %+v", inbox.Wakes)
	}
	bindings := map[string]sessionBinding{}
	for _, binding := range final.SessionBindings {
		if binding.ThreadID == threadID {
			bindings[binding.ID] = binding
		}
	}
	original, known := bindings[secondWake.RequestedSessionBindingID]
	if !known || original.CreatedByRunID != firstWake.RunID || original.Status != "replaced" || original.ReplacedByBindingID == "" {
		t.Fatalf("the stale binding was not recorded as replaced: %+v", original)
	}
	replacement, known := bindings[original.ReplacedByBindingID]
	if !known || replacement.CreatedByRunID != thirdWake.RunID || replacement.ProviderSessionID == original.ProviderSessionID {
		t.Fatalf("the replacement binding is not the third wake's new session: %+v", replacement)
	}
	events, _ := cluster.runEvents(thirdWake.RunID)
	warned := false
	for _, event := range events {
		warned = warned || (event["type"] == "warning" && event["code"] == "acp-session-not-resumed")
	}
	if !warned {
		t.Fatalf("the replacement session did not warn that the resume was refused: %v", events)
	}
	for title, item := range final.threadTasks(threadID) {
		if item.Status != "completed" || len(item.AttemptRunIDs) != 1 {
			t.Fatalf("task %s ended %s with %d attempts", title, item.Status, len(item.AttemptRunIDs))
		}
	}
}
