//go:build system && unix

package systemtest

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp/acptest"
)

const e2eProject = "e2e-app"

// workflowCluster is the two-node installation most scenarios use: node-a runs Codex through its
// ACP adapter (with operator-permitted native fallback), node-b runs Claude through its ACP
// adapter under an explicit API auth mode, and each node has its own checkout of the project.
type workflowCluster struct {
	*environment
	nodeA, nodeB         *baristaNode
	checkoutA, checkoutB string
	orchestrator         string
	codexBuilder         string
	claudeBuilder        string
}

func newWorkflowCluster(t *testing.T, options environmentOptions, orchestratorDefault string) *workflowCluster {
	t.Helper()
	if options.profiles == nil {
		options.profiles = []map[string]any{projectProfile(e2eProject, "git-worktree", "when-unchanged")}
	}
	cluster := &workflowCluster{environment: newEnvironment(t, options)}
	cluster.nodeA = cluster.startNode(nodeOptions{id: "node-a", codex: true, labels: []string{"e2e-ready"}, nativeFallback: []string{"codex-cli"}})
	cluster.nodeB = cluster.startNode(nodeOptions{id: "node-b", claudeAuthMode: "api", labels: []string{"e2e-ready"}})
	cluster.waitForReadiness(e2eProject, "node-a", "node-b")
	cluster.checkoutA = cluster.nodeA.repository(e2eProject)
	cluster.checkoutB = cluster.nodeB.repository(e2eProject)
	if orchestratorDefault == "" {
		orchestratorDefault = acknowledgeWake(t)
	}
	cluster.orchestrator = cluster.createAgent(agentOptions{
		name: "Orchestrator", harnessID: "codex-cli", model: "default", nodeID: "node-a",
		workspace: cluster.nodeA.directory("orchestration"), canDelegate: true,
		systemPrompt: "You coordinate the thread's task graph.\n" + orchestratorDefault,
	})
	cluster.codexBuilder = cluster.createAgent(agentOptions{name: "Codex Builder", harnessID: "codex-cli", model: "default", nodeID: "node-a", workspace: cluster.checkoutA, skills: []string{"build"}})
	cluster.claudeBuilder = cluster.createAgent(agentOptions{name: "Claude Builder", harnessID: "claude-cli", model: acptest.ClaudeModel, nodeID: "node-b", workspace: cluster.checkoutB, skills: []string{"build"}})
	return cluster
}

// outputField reads "name=value" from a run's output, where value runs to the next space.
func outputField(t *testing.T, output, name string) string {
	t.Helper()
	match := regexp.MustCompile(`(?:^|\s)` + regexp.QuoteMeta(name) + `=(\S*)`).FindStringSubmatch(output)
	if match == nil {
		t.Fatalf("output has no %s field: %q", name, output)
	}
	return match[1]
}

// TestOrchestratorWorkflow is the epic's happy path: one orchestrator submits a dependency graph,
// two independent tasks run concurrently on different nodes and harnesses in distinct worktrees,
// a worker asks the orchestrator a question over the durable mailbox, both approval outcomes
// round-trip to the exact ACP callback, the dependent integration task starts only after both
// prerequisites, and the orchestrator aggregates and completes the thread. Exact retries of the
// submission and of the messages create nothing new, a dirty worktree is retained, and no
// credential reaches the hub.
func TestOrchestratorWorkflow(t *testing.T) {
	t.Parallel()
	cluster := newWorkflowCluster(t, environmentOptions{}, "")

	alpha := script(t,
		step{Gate: "fan-out"},
		step{Update: map[string]any{"sessionUpdate": "plan", "entries": []map[string]any{
			{"content": "Write alpha.txt", "priority": "high", "status": "in_progress"},
			{"content": "Report to the orchestrator", "priority": "medium", "status": "pending"},
		}}},
		step{Update: map[string]any{"sessionUpdate": "tool_call", "toolCallId": "alpha-edit", "title": "Edit alpha.txt", "kind": "edit", "status": "in_progress"}},
		step{Permission: &permission{ToolCallID: "alpha-edit", Title: "Write alpha.txt", Kind: "edit", Options: allowOrReject, As: "approval"}},
		step{Update: map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "alpha-edit", "status": "completed", "content": []map[string]any{
			{"type": "diff", "path": "{{cwd}}/alpha.txt", "oldText": "", "newText": "alpha\n"},
		}}},
		step{Update: map[string]any{"sessionUpdate": "usage_update", "used": 1200, "size": 200000, "cost": map[string]any{"amount": 0.25, "currency": "USD"}}},
		step{Call: "update_task", Arguments: map[string]any{"idempotencyKey": "alpha-progress", "progress": "alpha edit applied"}},
		step{Call: "send_task_message", As: "question", Arguments: map[string]any{
			"idempotencyKey": "alpha-question", "recipient": map[string]any{"type": "orchestrator"}, "kind": "question",
			"body": "Which greeting should alpha use?", "correlationId": "alpha-greeting",
		}},
		step{Call: "send_task_message", As: "questionReplay", Arguments: map[string]any{
			"idempotencyKey": "alpha-question", "recipient": map[string]any{"type": "orchestrator"}, "kind": "question",
			"body": "Which greeting should alpha use?", "correlationId": "alpha-greeting",
		}},
		step{WaitFor: map[string]any{"type": "message", "message": map[string]any{"kind": "answer", "inReplyToMessageId": "{{question.messageId}}"}}, As: "answer"},
		step{WriteFile: &writeFile{Path: "alpha-report.md", Content: "alpha used {{answer.message.body}}\n"}},
		step{Call: "post_artifact", As: "artifact", Arguments: map[string]any{
			"relativePath": "alpha-report.md", "title": "Alpha report", "kind": "report", "mediaType": "text/markdown", "idempotencyKey": "alpha-report",
		}},
		step{RemoveFile: "alpha-report.md"},
		step{Message: "alpha permission={{approval.outcome.optionId}} question={{question.messageId}} questionReplay={{questionReplay.messageId}} questionReplayCreated={{questionReplay.created}} answer={{answer.message.body}}"},
	)
	beta := script(t,
		step{Gate: "fan-out"},
		step{Update: map[string]any{"sessionUpdate": "plan", "entries": []map[string]any{{"content": "Probe the network", "priority": "high", "status": "in_progress"}}}},
		step{Permission: &permission{ToolCallID: "beta-network", Title: "Run a network command", Kind: "execute", Options: allowOrReject, As: "approval"}},
		step{Call: "send_task_message", Arguments: map[string]any{
			"idempotencyKey": "beta-progress", "recipient": map[string]any{"type": "orchestrator"}, "kind": "progress",
			"body": "beta finished without network access",
		}},
		step{WriteFile: &writeFile{Path: "beta-notes.txt", Content: "uncommitted beta notes\n"}},
		step{Message: "beta permission={{approval.outcome.optionId}}"},
	)
	integrate := script(t,
		step{Call: "get_task_context", As: "context"},
		step{Message: "integrated role={{context.caller.role}}"},
	)
	tasks := []taskSpecification{
		{Key: "alpha", Title: "alpha", Instructions: "Implement alpha.\n" + alpha, Requirements: buildRequirements(e2eProject, "codex-cli")},
		{Key: "beta", Title: "beta", Instructions: "Implement beta.\n" + beta, Requirements: buildRequirements(e2eProject, "claude-cli")},
		{Key: "integrate", Title: "integrate", Instructions: "Integrate alpha and beta.\n" + integrate, Requirements: buildRequirements(e2eProject), Dependencies: dependsOn("alpha", "beta")},
	}
	orchestrate := script(t,
		step{Call: "get_execution_inventory", As: "inventory"},
		submitTasks("e2e-graph", "batch", tasks...),
		submitTasks("e2e-graph", "replay", tasks...),
		step{WaitFor: map[string]any{"type": "message", "message": map[string]any{"kind": "question"}}, As: "question"},
		step{Call: "send_task_message", As: "answer", Arguments: map[string]any{
			"idempotencyKey": "answer-alpha", "recipient": map[string]any{"type": "task", "taskId": "{{question.message.sender.taskId}}"},
			"kind": "answer", "body": "hello", "inReplyToMessageId": "{{question.message.id}}", "correlationId": "alpha-greeting",
		}},
		step{Call: "send_task_message", As: "answerReplay", Arguments: map[string]any{
			"idempotencyKey": "answer-alpha", "recipient": map[string]any{"type": "task", "taskId": "{{question.message.sender.taskId}}"},
			"kind": "answer", "body": "hello", "inReplyToMessageId": "{{question.message.id}}", "correlationId": "alpha-greeting",
		}},
		step{WaitFor: map[string]any{"type": "task", "taskId": "{{batch.taskIdsByKey.integrate}}", "status": "completed"}},
		step{Call: "get_task_context", As: "context"},
		step{Call: "update_thread", Arguments: map[string]any{"status": "completed", "summary": "alpha, beta, and integrate completed"}},
		step{Message: "submission={{batch.submissionId}} replaySubmission={{replay.submissionId}} replayCreated={{replay.created}} answer={{answer.messageId}} answerReplay={{answerReplay.messageId}} answerReplayCreated={{answerReplay.created}}"},
	)
	orchestratorRun := cluster.sendMessage(cluster.orchestrator, "Ship the e2e feature across the fleet.\n"+orchestrate, "")
	threadID := orchestratorRun.ThreadID

	// Both independent tasks start, on different nodes and harnesses, in distinct worktrees, while
	// the integration task has no attempt at all.
	var alphaRun, betaRun run
	fanOut := cluster.eventually("alpha and beta to run concurrently", func(current snapshot) (bool, string) {
		tasks := current.threadTasks(threadID)
		var found bool
		alphaRun, found = current.latestAttempt(tasks["alpha"])
		if !found || alphaRun.Status != "running" {
			return false, "alpha not running"
		}
		betaRun, found = current.latestAttempt(tasks["beta"])
		if !found || betaRun.Status != "running" {
			return false, "beta not running"
		}
		return true, ""
	})
	tasksBefore := fanOut.threadTasks(threadID)
	if integrate := tasksBefore["integrate"]; len(integrate.AttemptRunIDs) != 0 || integrate.Status == "assigned" || integrate.Status == "running" {
		t.Fatalf("the integration task started before its prerequisites: %+v", integrate)
	}
	if alphaRun.NodeID != "node-a" || alphaRun.HarnessID != "codex-cli" || betaRun.NodeID != "node-b" || betaRun.HarnessID != "claude-cli" {
		t.Fatalf("independent tasks were not placed on their suitable nodes: alpha %s/%s, beta %s/%s", alphaRun.NodeID, alphaRun.HarnessID, betaRun.NodeID, betaRun.HarnessID)
	}
	for _, attempt := range []run{alphaRun, betaRun} {
		if attempt.Transport != "acp-v1" || attempt.TransportSelection == nil || attempt.TransportSelection.SelectedTransport != "acp-v1" || attempt.TransportSelection.Adapter == nil {
			t.Fatalf("attempt %s did not run over a verified ACP adapter: %+v", attempt.ID, attempt.TransportSelection)
		}
	}
	alphaLease, _ := fanOut.lease(alphaRun.WorkspaceLeaseID)
	betaLease, _ := fanOut.lease(betaRun.WorkspaceLeaseID)
	if alphaLease.Status != "active" || betaLease.Status != "active" || alphaLease.WorktreePath == betaLease.WorktreePath || alphaLease.Branch == betaLease.Branch {
		t.Fatalf("concurrent tasks did not receive distinct active leases: %+v %+v", alphaLease, betaLease)
	}
	for _, lease := range []workspaceLease{alphaLease, betaLease} {
		if lease.Policy != "git-worktree" || !strings.HasPrefix(lease.WorktreePath, lease.Root+"/.coffee-shop/worktrees/") {
			t.Fatalf("lease %s is not an isolated worktree beneath its root: %+v", lease.ID, lease)
		}
		if _, err := os.Stat(filepath.Join(lease.WorktreePath, "README.md")); err != nil {
			t.Fatalf("lease %s worktree was not provisioned from its checkout: %v", lease.ID, err)
		}
	}
	cluster.openGate("fan-out")

	// Both approvals block their ACP callbacks until the operator decides; the decisions differ.
	current := cluster.eventually("both approvals to be pending", func(current snapshot) (bool, string) {
		return len(current.approvalsFor(alphaRun.ID)) == 1 && len(current.approvalsFor(betaRun.ID)) == 1, "approvals not raised"
	})
	alphaApproval := current.approvalsFor(alphaRun.ID)[0]
	betaApproval := current.approvalsFor(betaRun.ID)[0]
	if alphaApproval.Status != "pending" || betaApproval.Status != "pending" || alphaApproval.TaskID != alphaRun.TaskID || alphaApproval.NodeID != "node-a" {
		t.Fatalf("approvals were not opened for their exact runs: %+v %+v", alphaApproval, betaApproval)
	}
	if status, resolved := cluster.resolveApproval(alphaApproval.ID, "operator-alpha", "allow"); status != http.StatusOK || resolved.Status != "approved" {
		t.Fatalf("approving alpha returned %d %+v", status, resolved)
	}
	if status, replayed := cluster.resolveApproval(alphaApproval.ID, "operator-alpha", "allow"); status != http.StatusOK || replayed.Status != "approved" {
		t.Fatalf("an exact approval replay returned %d %+v", status, replayed)
	}
	if status, _ := cluster.resolveApproval(alphaApproval.ID, "operator-alpha", "reject"); status != http.StatusConflict {
		t.Fatalf("reusing an approval idempotency key for another decision returned %d", status)
	}
	if status, resolved := cluster.resolveApproval(betaApproval.ID, "operator-beta", "reject"); status != http.StatusOK || resolved.Status != "rejected" {
		t.Fatalf("rejecting beta returned %d %+v", status, resolved)
	}

	final := cluster.eventually("the thread to complete", func(current snapshot) (bool, string) {
		item, _ := current.thread(threadID)
		orchestratorState, _ := current.run(orchestratorRun.ID)
		return item.Status == "completed" && orchestratorState.Status == "completed", "thread " + item.Status + ", orchestrator " + orchestratorState.Status
	})
	graph := final.threadTasks(threadID)
	if len(graph) != 3 {
		t.Fatalf("the duplicate submission created extra tasks: %d tasks", len(graph))
	}
	for title, item := range graph {
		if item.Status != "completed" || len(item.AttemptRunIDs) != 1 {
			t.Fatalf("task %s ended %s with %d attempts", title, item.Status, len(item.AttemptRunIDs))
		}
	}
	alphaFinal, _ := final.run(alphaRun.ID)
	betaFinal, _ := final.run(betaRun.ID)
	integrateRun, _ := final.latestAttempt(graph["integrate"])
	if integrateRun.CreatedAt < alphaFinal.FinishedAt || integrateRun.CreatedAt < betaFinal.FinishedAt {
		t.Fatalf("the integration attempt was created before its prerequisites finished: %s vs %s, %s", integrateRun.CreatedAt, alphaFinal.FinishedAt, betaFinal.FinishedAt)
	}
	if outputField(t, integrateRun.Output, "role") != "task" {
		t.Fatalf("the integration attempt did not act as its task: %q", integrateRun.Output)
	}

	// Each ACP callback received exactly the operator's decision.
	if outputField(t, alphaFinal.Output, "permission") != "allow" || outputField(t, betaFinal.Output, "permission") != "reject" {
		t.Fatalf("approval decisions did not reach their callbacks: alpha %q, beta %q", alphaFinal.Output, betaFinal.Output)
	}
	settled := cluster.eventually("approval deliveries to be confirmed", func(current snapshot) (bool, string) {
		for _, item := range append(current.approvalsFor(alphaRun.ID), current.approvalsFor(betaRun.ID)...) {
			if item.Delivery == nil || item.Delivery.Status != "applied" {
				return false, "delivery not applied"
			}
		}
		return true, ""
	})
	if approved := settled.approvalsFor(alphaRun.ID)[0]; approved.SelectedOptionID != "allow" || approved.ResolvedBy != "operator" {
		t.Fatalf("alpha approval did not record the operator's decision: %+v", approved)
	}

	// The durable mailbox holds exactly one question, one answer, and one progress report, the answer
	// correlated with the question and first in alpha's ordered mailbox, and the exact retries
	// returned the original identities.
	messages := final.messagesIn(threadID)
	byKind := map[string][]taskMessage{}
	for _, message := range messages {
		byKind[message.Kind] = append(byKind[message.Kind], message)
	}
	if len(byKind["question"]) != 1 || len(byKind["answer"]) != 1 || len(byKind["progress"]) != 1 || len(messages) != 3 {
		t.Fatalf("mailbox holds unexpected messages: %+v", messages)
	}
	question, answer := byKind["question"][0], byKind["answer"][0]
	if question.Sender.TaskID != alphaRun.TaskID || question.Recipient.Type != "orchestrator" || answer.Recipient.TaskID != alphaRun.TaskID ||
		answer.InReplyToMessageID != question.ID || answer.CorrelationID != "alpha-greeting" || answer.Sequence != 1 {
		t.Fatalf("question and answer are not correlated and ordered: %+v %+v", question, answer)
	}
	if outputField(t, alphaFinal.Output, "questionReplay") != question.ID || outputField(t, alphaFinal.Output, "questionReplayCreated") != "false" ||
		outputField(t, alphaFinal.Output, "answer") != "hello" {
		t.Fatalf("the worker's message retry or answer was wrong: %q", alphaFinal.Output)
	}
	orchestratorFinal, _ := final.run(orchestratorRun.ID)
	if outputField(t, orchestratorFinal.Output, "replayCreated") != "false" ||
		outputField(t, orchestratorFinal.Output, "replaySubmission") != outputField(t, orchestratorFinal.Output, "submission") ||
		outputField(t, orchestratorFinal.Output, "answerReplay") != answer.ID || outputField(t, orchestratorFinal.Output, "answerReplayCreated") != "false" {
		t.Fatalf("the orchestrator's retries were not exact replays: %q", orchestratorFinal.Output)
	}
	if item, _ := final.thread(threadID); item.Summary != "alpha, beta, and integrate completed" {
		t.Fatalf("the orchestrator did not aggregate into the thread: %+v", item)
	}

	// The artifact was uploaded and its content matches.
	var report artifact
	for _, item := range final.Artifacts {
		if item.ThreadID == threadID && item.Title == "Alpha report" {
			report = item
		}
	}
	if !report.Uploaded || report.RunID != alphaRun.ID {
		t.Fatalf("the worker's artifact was not uploaded: %+v", report)
	}
	if status, content := cluster.hub.rawGet("/api/artifacts/" + report.ID + "/content"); status != http.StatusOK || string(content) != "alpha used hello\n" {
		t.Fatalf("artifact content returned %d %q", status, content)
	}

	// Structured progress reached the hub as normalized events and a bounded projection.
	events, activity := cluster.runEvents(alphaRun.ID)
	seen := map[string]bool{}
	for _, event := range events {
		seen[fmt.Sprint(event["type"])] = true
	}
	for _, required := range []string{"plan.updated", "tool.call", "diff", "usage", "permission.requested", "permission.resolved", "message.delta"} {
		if !seen[required] {
			t.Errorf("alpha's event stream has no %s event (saw %v)", required, seen)
		}
	}
	if plan, _ := activity["plan"].([]any); len(plan) != 2 {
		t.Errorf("alpha's activity projection lost its plan: %v", activity["plan"])
	}
	if diffs, _ := activity["diffs"].([]any); len(diffs) != 1 {
		t.Errorf("alpha's activity projection lost its diff: %v", activity["diffs"])
	}
	if progress := graph["alpha"].Progress; progress == nil || progress["summary"] != "alpha edit applied" {
		t.Errorf("alpha's progress report was not recorded: %v", progress)
	}

	// Clean worktrees are removed; the dirty one is retained with its data, even when an operator
	// asks for cleanup.
	integrateLease := integrateRun.WorkspaceLeaseID
	leases := cluster.eventually("leases to settle", func(current snapshot) (bool, string) {
		alphaState, _ := current.lease(alphaLease.ID)
		betaState, _ := current.lease(betaLease.ID)
		integrateState, _ := current.lease(integrateLease)
		return alphaState.Status == "cleaned" && betaState.Status == "retained" && integrateState.Status == "cleaned",
			fmt.Sprintf("alpha %s, beta %s, integrate %s", alphaState.Status, betaState.Status, integrateState.Status)
	})
	retained, _ := leases.lease(betaLease.ID)
	if retained.RetentionReason == "" {
		t.Fatalf("the retained lease has no reason: %+v", retained)
	}
	if _, err := os.Stat(alphaLease.WorktreePath); !os.IsNotExist(err) {
		t.Fatalf("the clean alpha worktree still exists: %v", err)
	}
	notes := filepath.Join(betaLease.WorktreePath, "beta-notes.txt")
	if content, err := os.ReadFile(notes); err != nil || string(content) != "uncommitted beta notes\n" {
		t.Fatalf("the dirty beta worktree lost its data: %v", err)
	}
	var cleanup struct {
		Lease workspaceLease `json:"lease"`
	}
	if status := cluster.hub.request(http.MethodPost, "/api/workspace-leases/"+betaLease.ID+"/cleanup", map[string]any{}, &cleanup); status != http.StatusAccepted {
		t.Fatalf("operator cleanup of the retained lease returned %d", status)
	}
	cluster.eventually("the operator cleanup to be reconciled", func(current snapshot) (bool, string) {
		item, _ := current.lease(betaLease.ID)
		return item.Status == "retained", item.Status
	})
	if content, err := os.ReadFile(notes); err != nil || string(content) != "uncommitted beta notes\n" {
		t.Fatalf("operator cleanup destroyed uncommitted work: %v", err)
	}

	// Provider credentials stayed on the compute nodes: the ACP adapters inherited them, never the
	// enrollment token, and nothing the hub holds contains any of them.
	for file, records := range cluster.harnessRecords() {
		start := records[0]
		if start.Event != "start" || !strings.HasSuffix(start.Role, "acp") {
			continue
		}
		if start.Environment["COFFEE_SHOP_TOKEN"] || !start.Environment["OPENAI_API_KEY"] {
			t.Errorf("adapter %s saw the wrong credentials: %v", file, start.Environment)
		}
	}
	cluster.assertNoCredentialLeak()
}
