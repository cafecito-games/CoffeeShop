package controlplane

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp/acptest"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/config"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/harness"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/mcpserver"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

func TestMain(m *testing.M) {
	acptest.RunIfRequested()
	os.Exit(m.Run())
}

const testTimestamp = "2026-09-21T12:00:00Z"

func newSessionClient() *Client {
	return NewClient(config.Config{Concurrency: 1}, protocol.ComputeNode{ID: "node-one"}, nil, emptyCapabilityReport)
}

// startedSession opens a session for a run that has started, discarding its run.started message so
// tests observe only what they forward.
func startedSession(client *Client, runID string) *runSession {
	session := client.openSession(runID)
	session.start(protocol.RunTransportSelection{RequestedTransport: protocol.TransportNativeCLI, SelectedTransport: protocol.TransportNativeCLI})
	client.connectionMu.Lock()
	client.outbox = nil
	client.connectionMu.Unlock()
	return session
}

func outboxObjects(t *testing.T, client *Client) []map[string]json.RawMessage {
	t.Helper()
	client.connectionMu.Lock()
	defer client.connectionMu.Unlock()
	objects := make([]map[string]json.RawMessage, 0, len(client.outbox))
	for _, data := range client.outbox {
		var object map[string]json.RawMessage
		require.NoError(t, json.Unmarshal(data, &object))
		objects = append(objects, object)
	}
	return objects
}

func forwardedEvents(t *testing.T, client *Client) []protocol.HarnessEvent {
	t.Helper()
	events := []protocol.HarnessEvent{}
	for _, message := range outboundMessages(t, client) {
		if message.Type == "harness.event" {
			events = append(events, *message.Event)
		}
	}
	return events
}

func permissionRequested(runID, approvalID string) protocol.HarnessEvent {
	return protocol.HarnessEvent{
		Type: "permission.requested", RunID: runID, Sequence: 99, At: testTimestamp, ApprovalID: approvalID, ToolCallID: "call-1", Title: "Run tests",
		Options: []protocol.ApprovalOption{{ID: "allow", Label: "Allow once", Kind: "allow-once"}, {ID: "reject", Label: "Reject", Kind: "reject-once"}},
	}
}

func messageDelta(runID, text string) protocol.HarnessEvent {
	return protocol.HarnessEvent{Type: "message.delta", RunID: runID, Sequence: 7, At: testTimestamp, Text: text}
}

func undeliverable(t *testing.T, client *Client) []protocol.ApprovalUndeliverableMessage {
	t.Helper()
	client.connectionMu.Lock()
	defer client.connectionMu.Unlock()
	reports := []protocol.ApprovalUndeliverableMessage{}
	for _, data := range client.outbox {
		var report protocol.ApprovalUndeliverableMessage
		require.NoError(t, json.Unmarshal(data, &report))
		if report.Type == "approval.undeliverable" {
			reports = append(reports, report)
		}
	}
	return reports
}

func TestForwardedEventsUseExactEnvelopeAndBaristaSequence(t *testing.T) {
	client := newSessionClient()
	session := startedSession(client, "run-one")
	session.forward(messageDelta("run-one", "Hello "))
	session.forward(messageDelta("run-one", "world"))
	session.forward(messageDelta("run-other", "not this run"))

	objects := outboxObjects(t, client)
	require.Len(t, objects, 2)
	for index, object := range objects {
		require.ElementsMatch(t, []string{"type", "event"}, keys(object), "harness.event must not carry Outbound fields such as activeRuns")
		var event protocol.HarnessEvent
		require.NoError(t, json.Unmarshal(object["event"], &event))
		require.Equal(t, int64(index+1), event.Sequence)
		require.Equal(t, "run-one", event.RunID)
	}
}

func keys(object map[string]json.RawMessage) []string {
	names := make([]string, 0, len(object))
	for name := range object {
		names = append(names, name)
	}
	return names
}

func TestFullOutboxDropsOrdinaryEventsWithoutASequenceGap(t *testing.T) {
	client := newSessionClient()
	session := startedSession(client, "run-one")
	session.forward(messageDelta("run-one", "first"))

	client.connectionMu.Lock()
	client.outboxEvents = outboxEventLimit
	client.connectionMu.Unlock()
	session.forward(messageDelta("run-one", "dropped one"))
	session.forward(messageDelta("run-one", "dropped two"))
	session.forward(permissionRequested("run-one", "acp-permission-1"))
	session.forward(messageDelta("run-one", "dropped three"))

	client.connectionMu.Lock()
	client.outboxEvents = 0
	client.connectionMu.Unlock()
	session.forward(messageDelta("run-one", "after reconnect"))

	events := forwardedEvents(t, client)
	require.Equal(t, []string{"message.delta", "permission.requested", "warning", "message.delta"}, eventTypes(events))
	for index, event := range events {
		require.Equal(t, int64(index+1), event.Sequence, "forwarded sequence must stay contiguous")
	}
	require.Equal(t, WarningEventsDropped, events[2].Code)
	require.Contains(t, events[2].Message, "3 harness events")
	require.Equal(t, "after reconnect", events[3].Text)
}

func eventTypes(events []protocol.HarnessEvent) []string {
	types := make([]string, len(events))
	for index, event := range events {
		types[index] = event.Type
	}
	return types
}

func TestOutboxByteBoundAppliesToOptionalEvents(t *testing.T) {
	client := newSessionClient()
	session := startedSession(client, "run-one")
	client.connectionMu.Lock()
	client.outboxEventBytes = outboxEventByteLimit - 10
	client.connectionMu.Unlock()
	session.forward(messageDelta("run-one", "does not fit"))
	require.Empty(t, forwardedEvents(t, client))
	require.Equal(t, 1, session.dropped)
}

func decide(t *testing.T, session *runSession, approvalID string) <-chan acp.PermissionDecision {
	t.Helper()
	result := make(chan acp.PermissionDecision, 1)
	go func() {
		decision, err := session.permission(context.Background(), acp.PermissionRequest{RunID: session.runID, ApprovalID: approvalID})
		if err != nil {
			decision.OptionID = "error: " + err.Error()
		}
		result <- decision
	}()
	return result
}

func receive(t *testing.T, result <-chan acp.PermissionDecision) acp.PermissionDecision {
	t.Helper()
	select {
	case decision := <-result:
		return decision
	case <-time.After(3 * time.Second):
		t.Fatal("permission callback did not return")
		return acp.PermissionDecision{}
	}
}

func TestApprovalDecisionReleasesOnlyTheMatchingLiveCallback(t *testing.T) {
	client := newSessionClient()
	session := startedSession(client, "run-one")
	session.forward(permissionRequested("run-one", "acp-permission-1"))
	result := decide(t, session, "acp-permission-1")

	approved := protocol.ApprovalDecision{ApprovalID: "acp-permission-1", RunID: "run-one", Status: "approved", SelectedOptionID: "allow"}
	client.applyApprovalDecision(&approved)
	require.Equal(t, "allow", receive(t, result).OptionID)

	client.applyApprovalDecision(&approved)
	require.Empty(t, undeliverable(t, client), "an exact redelivery is idempotent")

	rejected := protocol.ApprovalDecision{ApprovalID: "acp-permission-1", RunID: "run-one", Status: "rejected", SelectedOptionID: "reject"}
	client.applyApprovalDecision(&rejected)
	reports := undeliverable(t, client)
	require.Len(t, reports, 1)
	require.Equal(t, reasonConflictingResult, reports[0].Reason)
}

func TestApprovalDecisionArrivingBeforeTheCallbackIsHeld(t *testing.T) {
	client := newSessionClient()
	session := startedSession(client, "run-one")
	session.forward(permissionRequested("run-one", "acp-permission-1"))
	client.applyApprovalDecision(&protocol.ApprovalDecision{ApprovalID: "acp-permission-1", RunID: "run-one", Status: "rejected", SelectedOptionID: "reject"})
	require.Equal(t, "reject", receive(t, decide(t, session, "acp-permission-1")).OptionID)
	require.Empty(t, undeliverable(t, client))
}

func TestCancelledAndExpiredDecisionsNeverSelectAnOption(t *testing.T) {
	for _, status := range []string{"cancelled", "expired"} {
		t.Run(status, func(t *testing.T) {
			client := newSessionClient()
			session := startedSession(client, "run-one")
			session.forward(permissionRequested("run-one", "acp-permission-1"))
			result := decide(t, session, "acp-permission-1")
			client.applyApprovalDecision(&protocol.ApprovalDecision{ApprovalID: "acp-permission-1", RunID: "run-one", Status: status})
			require.Empty(t, receive(t, result).OptionID)
		})
	}
}

func TestRefusedDecisionsAreReportedAndLeaveTheCallbackWaiting(t *testing.T) {
	cases := map[string]struct {
		decision protocol.ApprovalDecision
		reason   string
	}{
		"unknown run":         {protocol.ApprovalDecision{ApprovalID: "acp-permission-1", RunID: "run-two", Status: "approved", SelectedOptionID: "allow"}, reasonNoActiveRun},
		"unknown approval":    {protocol.ApprovalDecision{ApprovalID: "acp-permission-9", RunID: "run-one", Status: "approved", SelectedOptionID: "allow"}, reasonNoLiveRequest},
		"option not offered":  {protocol.ApprovalDecision{ApprovalID: "acp-permission-1", RunID: "run-one", Status: "approved", SelectedOptionID: "allow-always"}, reasonOptionNotOffered},
		"approve with reject": {protocol.ApprovalDecision{ApprovalID: "acp-permission-1", RunID: "run-one", Status: "approved", SelectedOptionID: "reject"}, reasonOptionKind},
		"reject with allow":   {protocol.ApprovalDecision{ApprovalID: "acp-permission-1", RunID: "run-one", Status: "rejected", SelectedOptionID: "allow"}, reasonOptionKind},
		"invalid decision":    {protocol.ApprovalDecision{ApprovalID: "acp-permission-1", RunID: "run-one", Status: "approved"}, "invalid decision: approval decision option does not match its status"},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			client := newSessionClient()
			session := startedSession(client, "run-one")
			session.forward(permissionRequested("run-one", "acp-permission-1"))
			result := decide(t, session, "acp-permission-1")

			client.applyApprovalDecision(&testCase.decision)
			reports := undeliverable(t, client)
			require.Len(t, reports, 1)
			require.Equal(t, testCase.reason, reports[0].Reason)
			require.Equal(t, testCase.decision.RunID, reports[0].RunID)
			require.NoError(t, reports[0].Validate())
			select {
			case <-result:
				t.Fatal("a refused decision must not release the callback")
			case <-time.After(20 * time.Millisecond):
			}

			client.applyApprovalDecision(&protocol.ApprovalDecision{ApprovalID: "acp-permission-1", RunID: "run-one", Status: "approved", SelectedOptionID: "allow"})
			require.Equal(t, "allow", receive(t, result).OptionID)
		})
	}
}

func TestCallbackForARequestThatWasNeverForwardedFailsClosed(t *testing.T) {
	session := startedSession(newSessionClient(), "run-one")
	_, err := session.permission(context.Background(), acp.PermissionRequest{RunID: "run-one", ApprovalID: "acp-permission-1"})
	require.Error(t, err)
}

func TestClosedSessionRefusesLateDecisions(t *testing.T) {
	client := newSessionClient()
	session := startedSession(client, "run-one")
	session.forward(permissionRequested("run-one", "acp-permission-1"))
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := session.permission(ctx, acp.PermissionRequest{RunID: "run-one", ApprovalID: "acp-permission-1"})
		result <- err
	}()
	cancel()
	require.ErrorIs(t, <-result, context.Canceled)
	client.closeSession(session)
	session.forward(messageDelta("run-one", "after close"))

	client.applyApprovalDecision(&protocol.ApprovalDecision{ApprovalID: "acp-permission-1", RunID: "run-one", Status: "approved", SelectedOptionID: "allow"})
	reports := undeliverable(t, client)
	require.Len(t, reports, 1)
	require.Equal(t, reasonNoActiveRun, reports[0].Reason)
	require.Len(t, forwardedEvents(t, client), 1)
}

func TestACPPermissionRoundTripThroughTheControlSession(t *testing.T) {
	executable, err := os.Executable()
	require.NoError(t, err)
	record := filepath.Join(t.TempDir(), "frames.jsonl")
	t.Cleanup(func() { acptest.KillDescendants(t, record) })
	runner := harness.NewRunner(nil).WithACP(harness.NewACPDriver(harness.ACPDriverOptions{
		Adapters:          map[string]harness.ACPAdapter{"codex-cli": {Binary: executable, Environment: acptest.Environment("permission", record)}},
		Providers:         map[string]harness.ACPProvider{"codex-cli": {}},
		RequestTimeout:    5 * time.Second,
		PermissionTimeout: 5 * time.Second,
	}))
	client := newSessionClient()
	session := client.openSession("run-acp")
	defer client.closeSession(session)

	go func() {
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			for _, event := range forwardedEvents(t, client) {
				if event.Type == "permission.requested" {
					client.applyApprovalDecision(&protocol.ApprovalDecision{ApprovalID: event.ApprovalID, RunID: "run-acp", Status: "approved", SelectedOptionID: "allow"})
					return
				}
			}
			time.Sleep(5 * time.Millisecond)
		}
	}()
	result, err := runner.Execute(context.Background(), harness.Invocation{
		Run:        protocol.Run{ID: "run-acp", HarnessID: "codex-cli", Transport: harness.TransportACP, Prompt: "run the tests"},
		Workspace:  t.TempDir(),
		MCP:        mcpserver.Config{},
		Events:     session.forward,
		Permission: session.permission,
		Started:    session.start,
	})
	require.NoError(t, err)
	require.Equal(t, "after permission", result)

	events := forwardedEvents(t, client)
	require.Equal(t, []string{"permission.requested", "permission.resolved", "message.delta"}, eventTypes(events))
	for index, event := range events {
		require.Equal(t, int64(index+1), event.Sequence)
	}
	require.Equal(t, "approved", events[1].Status)
	require.Equal(t, "allow", events[1].SelectedOptionID)
	response := acptest.ReceivedResponse(t, record, "permission-1")
	encoded, err := json.Marshal(response["result"])
	require.NoError(t, err)
	require.JSONEq(t, `{"outcome":{"outcome":"selected","optionId":"allow"}}`, string(encoded))
	require.Empty(t, undeliverable(t, client))
}

func TestRegisteredVersionEnablesEventForwardingAndApprovals(t *testing.T) {
	require.Equal(t, "5", protocol.Version)
	require.True(t, protocol.SupportsCapability(protocol.Version, protocol.CapabilityOrchestration))
	require.True(t, protocol.SupportsCapability(protocol.Version, protocol.CapabilityInstances))
}

func TestRejectedDispatchNeverStartsTheAdapterOrOpensASession(t *testing.T) {
	executable, err := os.Executable()
	require.NoError(t, err)
	directory := t.TempDir()
	record := filepath.Join(directory, "frames.jsonl")
	t.Cleanup(func() { acptest.KillDescendants(t, record) })
	runner := harness.NewRunner(nil).WithACP(harness.NewACPDriver(harness.ACPDriverOptions{
		Adapters: map[string]harness.ACPAdapter{"codex-cli": {Binary: executable, Environment: acptest.Environment("permission", record)}},
	}))
	client := NewClient(config.Config{Concurrency: 1, WorkspaceRoots: []string{directory}}, protocol.ComputeNode{ID: "node-one"}, runner, emptyCapabilityReport)
	run := protocol.Run{ID: "run-acp", HarnessID: "codex-cli", Transport: harness.TransportACP, Workspace: directory, Prompt: "run the tests", SessionBindingID: "binding-one"}
	// The adapter is available, so acp-v1 alone is admitted; resuming a session binding is not,
	// because no startup probe negotiated resume or load for it.
	client.handle(context.Background(), protocol.Inbound{Type: "dispatch", Run: run, Execution: &protocol.DispatchExecution{
		Transport: harness.TransportACP, SessionBinding: &protocol.DispatchSessionBinding{ID: "binding-one", ProviderSessionID: "provider-session-one"},
	}})

	failed := waitForMessage(t, client, "run.failed")
	require.Equal(t, "unsupported execution: session resume not available for this harness on this Barista", failed.Error)
	require.Zero(t, client.activeRuns())
	require.Nil(t, client.session("run-acp"))
	time.Sleep(50 * time.Millisecond)
	_, statErr := os.Stat(record)
	require.True(t, os.IsNotExist(statErr), "the adapter process must never start")
	require.Empty(t, forwardedEvents(t, client))
}
