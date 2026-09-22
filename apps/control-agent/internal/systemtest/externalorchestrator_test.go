//go:build system && unix

package systemtest

import (
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// attachmentReleaseBound is how long a closed bridge socket may take to release its attachments.
// It is well under the heartbeat expiry the hub falls back on (45 seconds, refreshed every 15 by a
// live bridge), so the two paths cannot be mistaken for each other.
const attachmentReleaseBound = 25 * time.Second

// mintOrchestratorClient mints one orchestrator credential through the operator REST API, exactly
// as the PWA's "Connect a Claude Code orchestrator" dialog does, and returns its id and the secret
// the hub shows once.
func (environment *environment) mintOrchestratorClient(name string, scopes ...string) (string, string) {
	t := environment.t
	t.Helper()
	var minted struct {
		Client orchestratorClient `json:"client"`
		Secret string             `json:"secret"`
		Error  string             `json:"error"`
	}
	if status := environment.hub.request(http.MethodPost, "/api/orchestrator-clients",
		map[string]any{"name": name, "scopes": scopes}, &minted); status != http.StatusCreated {
		t.Fatalf("minting %s returned %d: %s", name, status, minted.Error)
	}
	if minted.Client.ID == "" || minted.Secret == "" {
		t.Fatalf("the hub minted an unusable credential: %+v", minted.Client)
	}
	return minted.Client.ID, minted.Secret
}

// revokeOrchestratorClient revokes a credential, as an operator does when a laptop should no
// longer drive threads.
func (environment *environment) revokeOrchestratorClient(clientID string) {
	t := environment.t
	t.Helper()
	var revoked struct {
		Client orchestratorClient `json:"client"`
		Error  string             `json:"error"`
	}
	if status := environment.hub.request(http.MethodPost, "/api/orchestrator-clients/"+clientID+"/revoke", map[string]any{}, &revoked); status != http.StatusOK {
		t.Fatalf("revoking %s returned %d: %s", clientID, status, revoked.Error)
	}
	if revoked.Client.RevokedAt == "" {
		t.Fatalf("the hub did not record the revocation: %+v", revoked.Client)
	}
}

// threadView finds one thread in a list_threads result.
func threadView(t *testing.T, result map[string]any, threadID string) map[string]any {
	t.Helper()
	listed, _ := result["threads"].([]any)
	for _, entry := range listed {
		view, _ := entry.(map[string]any)
		if view != nil && text(view, "id") == threadID {
			return view
		}
	}
	t.Fatalf("list_threads did not report thread %s: %v", threadID, result)
	return nil
}

// unreadEvents is what the hub says this thread's orchestrator has not acknowledged.
func unreadEvents(t *testing.T, bridge *bridgeProcess, threadID string) int {
	t.Helper()
	unread, ok := threadView(t, bridge.mustCallTool("list_threads", map[string]any{}), threadID)["unreadEvents"].(float64)
	if !ok {
		t.Fatalf("list_threads reported no unreadEvents for %s", threadID)
	}
	return int(unread)
}

// acknowledgeThreadEvents reads a thread's events and acknowledges everything it just read, which
// is the only delivery truth an orchestrator has. It returns the events of the first read.
func acknowledgeThreadEvents(t *testing.T, bridge *bridgeProcess, threadID string) []any {
	t.Helper()
	page := bridge.mustCallTool("get_thread_events", map[string]any{"threadId": threadID})
	cursor := text(page, "cursor")
	if cursor == "" {
		t.Fatalf("get_thread_events returned no cursor for %s: %v", threadID, page)
	}
	bridge.mustCallTool("get_thread_events", map[string]any{"threadId": threadID, "cursor": cursor})
	events, _ := page["events"].([]any)
	return events
}

// eventStatuses summarizes an event page by the task status each entry reports.
func eventStatuses(events []any) map[string]int {
	result := map[string]int{}
	for _, entry := range events {
		event, _ := entry.(map[string]any)
		if event == nil {
			continue
		}
		status, _ := event["status"].(string)
		if status != "" {
			result[status]++
		}
	}
	return result
}

// TestExternalClaudeCodeOrchestration proves the external orchestrator path end to end: an
// operator mints a scoped credential, the real orchestrator bridge drives a thread over stdio MCP
// as Claude Code would, the hub dispatches the task graph across two simulated Barista nodes,
// doorbells reach the session as channel events, the orchestrator resolves a worker approval,
// events survive the session's machine dying without ever producing a hub-hosted orchestrator run,
// a second session takes the thread over, and revocation stops the bridge dead.
func TestExternalClaudeCodeOrchestration(t *testing.T) {
	t.Parallel()
	cluster := newWorkflowCluster(t, environmentOptions{}, "")

	// A third worker keeps agent capacity from standing in for the dependency edge: the dependent
	// task has somewhere to run the moment its prerequisites are satisfied, and nowhere before.
	cluster.createAgent(agentOptions{
		name: "Spare Builder", harnessID: "codex-cli", model: "default", nodeID: "node-a",
		workspace: cluster.checkoutA, skills: []string{"build"},
	})

	clientID, secret := cluster.mintOrchestratorClient("Operator laptop", "orchestrate", "resolve-approvals")
	session := cluster.startBridge("primary", clientID, secret)

	// The approval tools are offered only once the hub's welcome proved the credential's scopes,
	// and the bridge announces that change so Claude Code re-lists.
	session.awaitTools("create_thread", "attach_thread", "get_thread_events", "submit_tasks",
		"get_execution_inventory", "update_thread", "list_approvals", "resolve_approval")
	if session.observedToolListChanges() == 0 {
		t.Fatal("the bridge never announced that the scoped tools became available")
	}

	created := session.mustCallTool("create_thread", map[string]any{
		"title":     "External orchestration",
		"objective": "Ship the external orchestration feature across the fleet.",
	})
	threadID := text(object(created, "thread"), "id")
	if threadID == "" {
		t.Fatalf("create_thread returned no thread id: %v", created)
	}

	// The fleet the orchestrator plans against is the hub's own inventory, not anything the model
	// was told.
	inventory := session.mustCallTool("get_execution_inventory", map[string]any{"threadId": threadID})
	nodes, _ := inventory["nodes"].([]any)
	inventoryNodes := map[string]bool{}
	for _, entry := range nodes {
		node, _ := entry.(map[string]any)
		if node != nil && node["acceptsTasks"] == true {
			inventoryNodes[text(node, "id")] = true
		}
	}
	if !inventoryNodes["node-a"] || !inventoryNodes["node-b"] {
		t.Fatalf("the inventory did not report both dispatchable nodes: %v", inventory["nodes"])
	}

	alpha := script(t,
		step{Gate: "fan-out"},
		step{Gate: "alpha-permission"},
		step{Permission: &permission{ToolCallID: "alpha-edit", Title: "Write alpha.txt", Kind: "edit", Options: allowOrReject, As: "approval"}},
		step{Message: "alpha permission={{approval.outcome.optionId}}"},
	)
	beta := script(t,
		step{Gate: "fan-out"},
		step{Message: "beta done"},
	)
	integrate := script(t,
		step{Gate: "integrate"},
		step{Message: "integrated"},
	)
	submitted := session.mustCallTool("submit_tasks", map[string]any{
		"threadId":       threadID,
		"idempotencyKey": "external-graph",
		"tasks": []taskSpecification{
			{Key: "alpha", Title: "alpha", Instructions: "Implement alpha.\n" + alpha, Requirements: buildRequirements(e2eProject, "codex-cli")},
			{Key: "beta", Title: "beta", Instructions: "Implement beta.\n" + beta, Requirements: buildRequirements(e2eProject, "claude-cli")},
			{Key: "integrate", Title: "integrate", Instructions: "Integrate alpha and beta.\n" + integrate, Requirements: buildRequirements(e2eProject), Dependencies: dependsOn("alpha", "beta")},
		},
	})
	if submitted["created"] != true {
		t.Fatalf("submit_tasks did not create the graph: %v", submitted)
	}

	// The two independent tasks run at the same time on different nodes; the dependent one has no
	// attempt at all until both finish.
	var alphaRun, betaRun run
	fanOut := cluster.eventually("alpha and beta to run concurrently", func(current snapshot) (bool, string) {
		tasks := current.threadTasks(threadID)
		var found bool
		if alphaRun, found = current.latestAttempt(tasks["alpha"]); !found || alphaRun.Status != "running" {
			return false, "alpha not running"
		}
		if betaRun, found = current.latestAttempt(tasks["beta"]); !found || betaRun.Status != "running" {
			return false, "beta not running"
		}
		return true, ""
	})
	if alphaRun.NodeID != "node-a" || betaRun.NodeID != "node-b" {
		t.Fatalf("the parallel tasks were not placed across both nodes: alpha %s, beta %s", alphaRun.NodeID, betaRun.NodeID)
	}
	if dependent := fanOut.threadTasks(threadID)["integrate"]; len(dependent.AttemptRunIDs) != 0 || dependent.Status != "pending" {
		t.Fatalf("the dependent task did not wait for its prerequisites: %+v", dependent)
	}
	cluster.openGate("fan-out")

	// A completed task rings the session's doorbell, and reading with a cursor acknowledges it.
	completion := session.awaitChannelEvent("a task-completion doorbell", func(event channelEvent) bool {
		return event.Meta["thread_id"] == threadID && event.pending() >= 1 && !event.urgent()
	})
	if !strings.Contains(completion.Content, "1 task completed") {
		t.Fatalf("the completion doorbell did not report the completed task: %q", completion.Content)
	}
	if statuses := eventStatuses(acknowledgeThreadEvents(t, session, threadID)); statuses["completed"] < 1 {
		t.Fatalf("the acknowledged events did not include the completed task: %v", statuses)
	}
	if unread := unreadEvents(t, session, threadID); unread != 0 {
		t.Fatalf("the cursor did not acknowledge the delivered events: %d still unread", unread)
	}

	// A worker's permission request is urgent, and the scoped credential answers it.
	cluster.openGate("alpha-permission")
	urgent := session.awaitChannelEvent("an urgent approval doorbell", func(event channelEvent) bool {
		return event.Meta["thread_id"] == threadID && event.urgent()
	})
	if urgent.Meta["approvals"] != "1" {
		t.Fatalf("the urgent doorbell did not report the pending approval: %v", urgent.Meta)
	}
	listed := session.mustCallTool("list_approvals", map[string]any{"threadId": threadID})
	open, _ := listed["approvals"].([]any)
	if len(open) != 1 {
		t.Fatalf("list_approvals did not report the worker's request: %v", listed)
	}
	pending, _ := open[0].(map[string]any)
	resolved := object(session.mustCallTool("resolve_approval", map[string]any{
		"approvalId":     text(pending, "id"),
		"optionId":       "allow",
		"idempotencyKey": "external-alpha-allow",
	}), "approval")
	if text(resolved, "status") != "approved" || text(resolved, "selectedOptionId") != "allow" {
		t.Fatalf("the orchestrator's decision was not recorded: %v", resolved)
	}
	if resolver := object(resolved, "resolvedBy"); text(resolver, "kind") != "orchestrator" || text(resolver, "clientId") != clientID {
		t.Fatalf("the approval was not attributed to the orchestrator credential: %v", resolved["resolvedBy"])
	}
	settled := cluster.eventually("the approval decision to reach its worker", func(current snapshot) (bool, string) {
		for _, item := range current.approvalsFor(alphaRun.ID) {
			if item.Delivery == nil || item.Delivery.Status != "applied" {
				return false, "delivery not applied"
			}
		}
		return len(current.approvalsFor(alphaRun.ID)) == 1, "approval missing"
	})
	if decided := settled.approvalsFor(alphaRun.ID)[0]; decided.Status != "approved" || decided.ResolvedBy.kind() != "orchestrator" {
		t.Fatalf("the persisted approval does not record an orchestrator resolution: %+v", decided)
	}

	// The operator's machine dies. Work continues, events accumulate, and the hub never starts an
	// orchestrator of its own for a thread an operator's session owns.
	session.stop(true)
	killedAt := time.Now()
	cluster.eventually("the dead session's attachment to be released", func(current snapshot) (bool, string) {
		_, attached := current.attachedTo(threadID)
		return !attached, "the thread is still attached"
	})
	// The closed socket is what must release the attachment. The heartbeat expiry sweep reaches the
	// same state eventually, so a release that takes longer than a heartbeat interval means the
	// socket path stopped working and only the slow safety net is left.
	if elapsed := time.Since(killedAt); elapsed > attachmentReleaseBound {
		t.Fatalf("the attachment was released only after %s, which is the heartbeat expiry sweep rather than the closed socket", elapsed)
	}
	orphaned := cluster.eventually("alpha to finish while no session is attached", func(current snapshot) (bool, string) {
		item, found := current.run(alphaRun.ID)
		return found && item.Status == "completed", "alpha is " + item.Status
	})
	alphaAttempt, _ := orphaned.run(alphaRun.ID)
	if outputField(t, alphaAttempt.Output, "permission") != "allow" {
		t.Fatalf("the orchestrator's approval did not reach the worker's callback: %q", alphaAttempt.Output)
	}
	if runs := orphaned.hubHostedOrchestratorRuns(threadID); len(runs) != 0 {
		t.Fatalf("the hub started an orchestrator run for an externally orchestrated thread: %+v", runs)
	}
	if inbox, found := orphaned.inbox(threadID); found && len(inbox.Wakes) != 0 {
		t.Fatalf("the hub scheduled a continuation wake for an externally orchestrated thread: %+v", inbox.Wakes)
	}

	// A new session attaches the same thread and is rung for the whole backlog at once.
	resumed := cluster.startBridge("resumed", clientID, secret)
	resumed.mustCallTool("attach_thread", map[string]any{"threadId": threadID})
	backlog := resumed.awaitChannelEvent("the backlog doorbell", func(event channelEvent) bool {
		return event.Meta["thread_id"] == threadID && event.pending() >= 1
	})
	if backlog.pending() < 1 {
		t.Fatalf("the backlog doorbell reported nothing waiting: %v", backlog.Meta)
	}
	acknowledgeThreadEvents(t, resumed, threadID)
	if unread := unreadEvents(t, resumed, threadID); unread != 0 {
		t.Fatalf("the reattached session did not acknowledge its backlog: %d still unread", unread)
	}

	// A second session takes the thread over, and the one it replaced is told so.
	taker := cluster.startBridge("taker", clientID, secret)
	taker.mustCallTool("attach_thread", map[string]any{"threadId": threadID})
	replacedNotice := resumed.awaitChannelEvent("the attachment.replaced notice", func(event channelEvent) bool {
		return event.Meta["thread_id"] == threadID && strings.Contains(event.Content, "taken over")
	})
	if replacedNotice.Meta["thread_id"] != threadID {
		t.Fatalf("the takeover notice did not name its thread: %v", replacedNotice.Meta)
	}
	takenOver := cluster.eventually("the replaced attachment to be recorded", func(current snapshot) (bool, string) {
		for _, attachment := range current.attachmentsFor(threadID) {
			if attachment.Status == "replaced" {
				return true, ""
			}
		}
		return false, "no replaced attachment"
	})
	if _, attached := takenOver.attachedTo(threadID); !attached {
		t.Fatalf("the takeover left the thread with no attachment: %+v", takenOver.attachmentsFor(threadID))
	}
	if outcome := resumed.callTool("get_thread_events", map[string]any{"threadId": threadID}); outcome.errorCode() != "not_attached" {
		t.Fatalf("the replaced session could still act on the thread: %+v", outcome)
	}

	// The dependent task runs only now, and the taking session completes the thread.
	cluster.openGate("integrate")
	finished := cluster.eventually("the dependent task to complete", func(current snapshot) (bool, string) {
		dependent := current.threadTasks(threadID)["integrate"]
		return dependent.Status == "completed", "integrate is " + dependent.Status
	})
	dependent := finished.threadTasks(threadID)["integrate"]
	dependentRun, _ := finished.latestAttempt(dependent)
	alphaFinal, _ := finished.run(alphaRun.ID)
	betaFinal, _ := finished.run(betaRun.ID)
	if dependentRun.CreatedAt < alphaFinal.FinishedAt || dependentRun.CreatedAt < betaFinal.FinishedAt {
		t.Fatalf("the dependent attempt was created before its prerequisites finished: %s vs %s, %s", dependentRun.CreatedAt, alphaFinal.FinishedAt, betaFinal.FinishedAt)
	}
	updated := object(taker.mustCallTool("update_thread", map[string]any{
		"threadId": threadID, "status": "completed", "summary": "alpha, beta, and integrate completed",
	}), "thread")
	if text(updated, "status") != "completed" {
		t.Fatalf("update_thread did not complete the thread: %v", updated)
	}
	completed := cluster.eventually("the thread to be completed", func(current snapshot) (bool, string) {
		item, _ := current.thread(threadID)
		return item.Status == "completed", "thread is " + item.Status
	})
	if item, _ := completed.thread(threadID); item.Summary != "alpha, beta, and integrate completed" {
		t.Fatalf("the orchestrator's summary did not reach the thread: %+v", item)
	}
	if runs := completed.hubHostedOrchestratorRuns(threadID); len(runs) != 0 {
		t.Fatalf("the hub started an orchestrator run for an externally orchestrated thread: %+v", runs)
	}

	// Revoking the laptop stops every session holding that credential.
	cluster.revokeOrchestratorClient(clientID)
	taker.awaitChannelEvent("the revocation notice", func(event channelEvent) bool {
		return strings.Contains(event.Content, "revoked")
	})
	if outcome := taker.callTool("list_threads", map[string]any{}); outcome.errorCode() != "revoked" {
		t.Fatalf("a revoked credential could still call the hub: %+v", outcome)
	}
	revoked := cluster.eventually("the revocation to release every attachment", func(current snapshot) (bool, string) {
		client, _ := current.orchestratorClient(clientID)
		if client.RevokedAt == "" {
			return false, "the credential is not revoked"
		}
		_, attached := current.attachedTo(threadID)
		return !attached, "the thread is still attached"
	})
	if client, _ := revoked.orchestratorClient(clientID); client.RevokedAt == "" {
		t.Fatalf("the published credential does not show the revocation: %+v", client)
	}

	// The credential is the only secret the bridge holds, and it never reaches the hub's records or
	// either process's output.
	persisted, err := os.ReadFile(cluster.hub.dataPath)
	if err != nil {
		t.Fatalf("read the hub state: %v", err)
	}
	for source, content := range map[string]string{
		"the resumed session's output": resumed.output(),
		"the taking session's output":  taker.output(),
		"the hub log":                  cluster.hub.logs.String(),
		"the hub state file":           string(persisted),
	} {
		if strings.Contains(content, secret) {
			t.Errorf("the orchestrator client secret leaked into %s", source)
		}
	}
	cluster.assertNoCredentialLeak()
}
