package controlplane

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/config"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/hostsession"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
	"nhooyr.io/websocket"
)

type fakeHostSessionCore struct {
	usable         bool
	diagnostic     string
	profiles       map[string]protocol.HostHarnessSessionInteractiveProfile
	snapshot       []protocol.HostHarnessSessionObservation
	outcomes       []protocol.HostSessionControlMessage
	updates        chan hostsession.CoreUpdate
	commands       chan protocol.HostSessionHubMessage
	executeBlock   <-chan struct{}
	executeStarted chan struct{}
	executed       atomic.Int32
	shutdowns      atomic.Int32
	mu             sync.Mutex
}

func newFakeHostSessionCore() *fakeHostSessionCore {
	return &fakeHostSessionCore{
		usable: true,
		profiles: map[string]protocol.HostHarnessSessionInteractiveProfile{
			"codex-cli": {Operations: []string{"adopt", "create", "discover"}},
		},
		snapshot: []protocol.HostHarnessSessionObservation{testHostSessionObservation()},
		updates:  make(chan hostsession.CoreUpdate, 512),
		commands: make(chan protocol.HostSessionHubMessage, 8),
	}
}

func (core *fakeHostSessionCore) Usable() bool       { return core.usable }
func (core *fakeHostSessionCore) Diagnostic() string { return core.diagnostic }
func (core *fakeHostSessionCore) InteractiveProfiles() map[string]protocol.HostHarnessSessionInteractiveProfile {
	return core.profiles
}
func (core *fakeHostSessionCore) Snapshot() ([]protocol.HostHarnessSessionObservation, error) {
	core.mu.Lock()
	defer core.mu.Unlock()
	return append([]protocol.HostHarnessSessionObservation(nil), core.snapshot...), nil
}
func (core *fakeHostSessionCore) Outcomes() []protocol.HostSessionControlMessage {
	core.mu.Lock()
	defer core.mu.Unlock()
	return append([]protocol.HostSessionControlMessage(nil), core.outcomes...)
}
func (core *fakeHostSessionCore) AcknowledgeOutcome(commandID string) {
	core.mu.Lock()
	defer core.mu.Unlock()
	core.outcomes = slices.DeleteFunc(core.outcomes, func(outcome protocol.HostSessionControlMessage) bool {
		return outcome.CommandID == commandID
	})
}
func (core *fakeHostSessionCore) Updates() <-chan hostsession.CoreUpdate { return core.updates }
func (core *fakeHostSessionCore) Execute(_ context.Context, command protocol.HostSessionHubMessage) hostsession.CommandResponse {
	core.executed.Add(1)
	core.commands <- command
	if core.executeStarted != nil {
		select {
		case core.executeStarted <- struct{}{}:
		default:
		}
	}
	if core.executeBlock != nil {
		<-core.executeBlock
	}
	epoch := int64(0)
	if command.AttachmentEpoch != nil {
		epoch = *command.AttachmentEpoch
	}
	response := hostsession.CommandResponse{
		Ack: protocol.HostSessionControlMessage{
			Type: "host-session.command.ack", NodeID: command.NodeID, Operation: "attach",
			CommandID: command.CommandID, CommandDigest: command.CommandDigest,
			HostHarnessSessionID: command.HostHarnessSessionID, AttachmentEpoch: command.AttachmentEpoch,
			Disposition: "recorded", At: "2026-10-06T12:00:00Z",
		},
		Result: protocol.HostSessionControlMessage{
			Type: "host-session.command.result", NodeID: command.NodeID, Operation: "attach",
			CommandID: command.CommandID, CommandDigest: command.CommandDigest,
			HostHarnessSessionID: command.HostHarnessSessionID, AttachmentEpoch: &epoch,
			Outcome: "succeeded", Session: &core.snapshot[0], At: "2026-10-06T12:00:01Z",
		},
	}
	core.mu.Lock()
	core.outcomes = append(core.outcomes, response.Result)
	core.mu.Unlock()
	return response
}
func (core *fakeHostSessionCore) ReadHistory(context.Context, string, string, string, int) (hostsession.HistoryPage, error) {
	return hostsession.HistoryPage{Items: []protocol.HostHarnessSessionHistoryItem{{ID: "item-one", Kind: "assistant", Text: "bounded", Truncated: false}}}, nil
}
func (core *fakeHostSessionCore) Shutdown(context.Context) error {
	core.shutdowns.Add(1)
	return nil
}

func testHostSessionObservation() protocol.HostHarnessSessionObservation {
	return protocol.HostHarnessSessionObservation{
		HostHarnessSessionID: "host-session-one", NodeID: "node-one", HarnessID: "codex-cli",
		ProviderSessionID: "provider-one", Workspace: "/workspace", Source: "provider-history",
		Status: "idle", ControlMode: "resume", Operations: []string{"attach", "close", "read-history", "start-turn"},
		Revision: 1, Summary: "Existing session", CreatedAt: "2026-10-06T12:00:00Z", UpdatedAt: "2026-10-06T12:00:00Z",
	}
}

func hostSessionTestClient(core hostSessionCore) *Client {
	profile := protocol.HarnessProfile{
		ID: "codex-cli", Label: "Codex", Description: "Local Codex", Available: true,
		AuthMode: "local-subscription", Models: []string{},
	}
	client := NewClient(config.Config{Concurrency: 1, WorkspaceRoots: []string{"/workspace"}}, protocol.ComputeNode{
		ID: "node-one", Name: "Node", Kind: "local", Platform: "linux", Status: "online",
		Concurrency: 1, WorkspaceRoots: []string{"/workspace"}, Harnesses: []protocol.HarnessProfile{profile}, Version: "test",
	}, nil, emptyCapabilityReport)
	return client.WithHostSessions(core)
}

func digestHostCommand(t *testing.T, command protocol.HostSessionHubMessage) protocol.HostSessionHubMessage {
	t.Helper()
	digest, err := protocol.HostHarnessSessionCommandDigest(command)
	require.NoError(t, err)
	command.CommandDigest = digest
	return command
}

func TestHostSessionsAdvertiseOnlyFromUsableValidatedCore(t *testing.T) {
	unusable := newFakeHostSessionCore()
	unusable.usable = false
	unusable.diagnostic = "interactive host sessions unavailable"
	client := hostSessionTestClient(unusable)
	require.Nil(t, client.hostSessions)
	require.Nil(t, client.node.Harnesses[0].InteractiveSessions)

	usable := newFakeHostSessionCore()
	client = hostSessionTestClient(usable)
	require.NotNil(t, client.hostSessions)
	require.Equal(t, []string{"adopt", "create", "discover"}, client.node.Harnesses[0].InteractiveSessions.Operations)
}

func TestHostSessionInventoryIsImmutableOrderedValidatedAndFollowedByDurableOutcomes(t *testing.T) {
	core := newFakeHostSessionCore()
	epoch := int64(0)
	core.outcomes = []protocol.HostSessionControlMessage{{
		Type: "host-session.command.result", NodeID: "node-one", Operation: "attach",
		CommandID: "command-old", CommandDigest: strings.Repeat("a", 64),
		HostHarnessSessionID: "host-session-one", AttachmentEpoch: &epoch,
		Outcome: "rejected", Code: "attachment-conflict", At: "2026-10-06T12:00:00Z",
	}}
	client := hostSessionTestClient(core)
	frames, _, err := client.hostSessions.authoritativeFrames()
	require.NoError(t, err)
	require.Len(t, frames, 3)
	page, err := protocol.DecodeHostSessionControlMessage(frames[0], protocol.Version)
	require.NoError(t, err)
	complete, err := protocol.DecodeHostSessionControlMessage(frames[1], protocol.Version)
	require.NoError(t, err)
	result, err := protocol.DecodeHostSessionControlMessage(frames[2], protocol.Version)
	require.NoError(t, err)
	require.Equal(t, int64(0), page.PageIndex)
	require.Equal(t, page.Generation, complete.Generation)
	require.Equal(t, int64(1), complete.PageCount)
	require.Equal(t, int64(1), complete.SessionCount)
	require.Equal(t, "command-old", result.CommandID)
}

func TestHostSessionPostAckOrderingAndStrictCommandRouting(t *testing.T) {
	core := newFakeHostSessionCore()
	types := make(chan []string, 1)
	command := digestHostCommand(t, protocol.HostSessionHubMessage{
		Type: "host-session.attach", NodeID: "node-one", CommandID: "command-one",
		HostHarnessSessionID: "host-session-one", AttachmentEpoch: pointerInt64(0),
		ThreadID: "thread-one", ExpectedStatus: "idle",
	})
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(writer, request, nil)
		require.NoError(t, err)
		defer connection.Close(websocket.StatusNormalClosure, "done")
		got := []string{}
		for {
			_, data, readErr := connection.Read(request.Context())
			require.NoError(t, readErr)
			var envelope struct {
				Type string `json:"type"`
			}
			require.NoError(t, json.Unmarshal(data, &envelope))
			got = append(got, envelope.Type)
			switch envelope.Type {
			case "register":
				acknowledgeRegistration(t, request.Context(), connection)
			case "sync.complete":
				encoded, encodeErr := command.MarshalJSON()
				require.NoError(t, encodeErr)
				require.NoError(t, connection.Write(request.Context(), websocket.MessageText, encoded))
			case "host-session.command.result":
				types <- got
				return
			}
		}
	}))
	defer server.Close()
	client := hostSessionTestClient(core)
	client.config.ControlEndpoint = strings.Replace(server.URL, "http://", "ws://", 1)
	connected, err := client.runOnce(context.Background())
	require.Error(t, err)
	require.True(t, connected)
	require.Equal(t, []string{
		"register", "host-session.inventory.page", "host-session.inventory.complete", "sync.complete",
		"capability.report", "host-session.command.ack", "host-session.command.result",
	}, <-types)
	require.Equal(t, command, <-core.commands)
}

func TestHostSessionAcceptedEffectSurvivesDisconnectAndReconnectDoesNotRepeatIt(t *testing.T) {
	core := newFakeHostSessionCore()
	block := make(chan struct{})
	core.executeBlock = block
	core.executeStarted = make(chan struct{}, 1)
	command := digestHostCommand(t, protocol.HostSessionHubMessage{
		Type: "host-session.attach", NodeID: "node-one", CommandID: "command-live",
		HostHarnessSessionID: "host-session-one", AttachmentEpoch: pointerInt64(0),
		ThreadID: "thread-one", ExpectedStatus: "idle",
	})
	var connections atomic.Int32
	secondTypes := make(chan []string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		connectionNumber := connections.Add(1)
		connection, err := websocket.Accept(writer, request, nil)
		require.NoError(t, err)
		defer connection.Close(websocket.StatusNormalClosure, "done")
		got := []string{}
		for {
			_, data, readErr := connection.Read(request.Context())
			require.NoError(t, readErr)
			var envelope struct {
				Type string `json:"type"`
			}
			require.NoError(t, json.Unmarshal(data, &envelope))
			got = append(got, envelope.Type)
			if envelope.Type == "register" {
				acknowledgeRegistration(t, request.Context(), connection)
			}
			if envelope.Type != "sync.complete" {
				continue
			}
			if connectionNumber == 1 {
				encoded, encodeErr := command.MarshalJSON()
				require.NoError(t, encodeErr)
				require.NoError(t, connection.Write(request.Context(), websocket.MessageText, encoded))
				select {
				case <-core.executeStarted:
				case <-time.After(time.Second):
					t.Error("host-session command did not reach the core")
				}
				return
			}
			secondTypes <- got
			return
		}
	}))
	defer server.Close()
	client := hostSessionTestClient(core)
	client.config.ControlEndpoint = strings.Replace(server.URL, "http://", "ws://", 1)
	connected, err := client.runOnce(context.Background())
	require.Error(t, err)
	require.True(t, connected)
	require.EqualValues(t, 1, core.executed.Load())
	close(block)
	require.Eventually(t, func() bool { return len(core.Outcomes()) == 1 }, time.Second, 10*time.Millisecond)

	connected, err = client.runOnce(context.Background())
	require.Error(t, err)
	require.True(t, connected)
	require.EqualValues(t, 1, core.executed.Load(), "reconnect must deliver authority, never replay the provider effect")
	types := <-secondTypes
	require.Equal(t, []string{
		"register", "host-session.inventory.page", "host-session.inventory.complete",
	}, types[:3])
	require.Equal(t, "sync.complete", types[len(types)-1])
	require.GreaterOrEqual(t, countString(types, "host-session.command.result"), 1,
		"the durable result must converge even when the transient acknowledgement was lost with the old socket")
}

func countString(values []string, expected string) int {
	count := 0
	for _, value := range values {
		if value == expected {
			count++
		}
	}
	return count
}

func TestHostSessionMalformedCommandAndV5FrameNeverReachTheCore(t *testing.T) {
	core := newFakeHostSessionCore()
	command := digestHostCommand(t, protocol.HostSessionHubMessage{
		Type: "host-session.attach", NodeID: "node-one", CommandID: "command-one",
		HostHarnessSessionID: "host-session-one", AttachmentEpoch: pointerInt64(0),
		ThreadID: "thread-one", ExpectedStatus: "idle",
	})
	encoded, err := command.MarshalJSON()
	require.NoError(t, err)
	var malformed map[string]any
	require.NoError(t, json.Unmarshal(encoded, &malformed))
	malformed["extra"] = true
	encoded, err = json.Marshal(malformed)
	require.NoError(t, err)
	_, err = protocol.DecodeHostSessionHubMessage(encoded, "5")
	require.Error(t, err)
	_, err = protocol.DecodeHostSessionHubMessage(encoded, protocol.Version)
	require.Error(t, err)
	require.Zero(t, core.executed.Load())
}

func TestHostSessionOverflowDropsDeltasAndRequiresFreshAuthority(t *testing.T) {
	core := newFakeHostSessionCore()
	client := hostSessionTestClient(core)
	for range hostSessionBufferedFrames + 1 {
		client.hostSessions.buffer([]byte(`{"type":"bounded"}`))
	}
	client.hostSessions.mu.Lock()
	require.True(t, client.hostSessions.dirty)
	require.Empty(t, client.hostSessions.pending)
	client.hostSessions.mu.Unlock()
	frames, _, err := client.hostSessions.authoritativeFrames()
	require.NoError(t, err)
	require.NotEmpty(t, frames)
	require.Empty(t, client.hostSessions.takePendingAfterSnapshot())
	client.hostSessions.mu.Lock()
	require.False(t, client.hostSessions.dirty)
	client.hostSessions.mu.Unlock()
}

func TestPendingApprovalDeliveryFailsImmediatelyWithoutALiveHubTransport(t *testing.T) {
	core := newFakeHostSessionCore()
	client := hostSessionTestClient(core)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client.hostSessions.start(ctx)
	delivered := make(chan bool, 1)
	core.updates <- hostsession.CoreUpdate{
		HostHarnessSessionID: "host-session-one", AttachmentEpoch: 0, ProviderTurnID: "turn-one",
		Event: &protocol.HarnessEvent{
			Type: "permission.requested", RunID: "run-one", Sequence: 1, At: "2026-10-06T12:00:00Z",
			ApprovalID: "approval-one", Title: "Run command",
			Options: []protocol.ApprovalOption{{ID: "allow-once", Label: "Allow once", Kind: "allow-once"}},
		},
		Delivered: delivered,
	}
	select {
	case accepted := <-delivered:
		require.False(t, accepted)
	case <-time.After(time.Second):
		t.Fatal("approval delivery was not rejected while the Hub transport was unavailable")
	}
	client.hostSessions.mu.Lock()
	require.True(t, client.hostSessions.dirty)
	require.Empty(t, client.hostSessions.pending)
	client.hostSessions.mu.Unlock()
}

func TestTimedOutApprovalIsWithdrawnBeforeTransportSend(t *testing.T) {
	core := newFakeHostSessionCore()
	client := hostSessionTestClient(core)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client.hostSessions.start(ctx)
	delivered := make(chan bool, 1)
	state := &atomic.Int32{}
	state.Store(-1)
	core.updates <- hostsession.CoreUpdate{
		HostHarnessSessionID: "host-session-one", AttachmentEpoch: 0, ProviderTurnID: "turn-one",
		Event: &protocol.HarnessEvent{
			Type: "permission.requested", RunID: "run-one", Sequence: 1, At: "2026-10-06T12:00:00Z",
			ApprovalID: "approval-one", Title: "Run command",
			Options: []protocol.ApprovalOption{{ID: "allow-once", Label: "Allow once", Kind: "allow-once"}},
		},
		Delivered: delivered, DeliveryState: state,
	}
	select {
	case accepted := <-delivered:
		require.False(t, accepted)
	case <-time.After(time.Second):
		t.Fatal("withdrawn approval was not skipped")
	}
	client.hostSessions.mu.Lock()
	require.True(t, client.hostSessions.dirty)
	require.Empty(t, client.hostSessions.pending)
	client.hostSessions.mu.Unlock()
}

func TestHostSessionSerializationFailureAbortsGenerationWithoutCompletion(t *testing.T) {
	core := newFakeHostSessionCore()
	core.snapshot[0].Summary = "ghp_abcdefghijklmnopqrstuvwxyz1234567890"
	client := hostSessionTestClient(core)
	frames, _, err := client.hostSessions.authoritativeFrames()
	require.Error(t, err)
	require.Empty(t, frames)
}

func TestAuthoritativeFramesReturnOnlyOutcomeIDsActuallySerialized(t *testing.T) {
	core := newFakeHostSessionCore()
	epoch := int64(1)
	core.outcomes = []protocol.HostSessionControlMessage{{
		Type: "host-session.command.result", NodeID: "node-one", Operation: "attach",
		CommandID: "command-sent", CommandDigest: strings.Repeat("a", 64),
		HostHarnessSessionID: "host-session-one", AttachmentEpoch: &epoch,
		Outcome: "succeeded", Session: &core.snapshot[0], At: "2026-10-06T12:00:00Z",
	}}
	client := hostSessionTestClient(core)
	_, outcomeIDs, err := client.hostSessions.authoritativeFrames()
	require.NoError(t, err)
	require.Equal(t, []string{"command-sent"}, outcomeIDs)
	core.outcomes = append(core.outcomes, protocol.HostSessionControlMessage{CommandID: "command-raced"})
	require.NotContains(t, outcomeIDs, "command-raced")
}

func TestHostSessionRunShutdownIsBoundedAndIndependentOfSocketLifetime(t *testing.T) {
	core := newFakeHostSessionCore()
	client := hostSessionTestClient(core)
	ctx, cancel := context.WithCancel(context.Background())
	client.hostSessions.start(ctx)
	cancel()
	client.hostSessions.shutdown()
	require.EqualValues(t, 1, core.shutdowns.Load())
}

func pointerInt64(value int64) *int64 { return &value }

func TestHostSessionUpdateFrameIsBoundedBeforeTransportBuffering(t *testing.T) {
	core := newFakeHostSessionCore()
	client := hostSessionTestClient(core)
	client.hostSessions.start(context.Background())
	observation := testHostSessionObservation()
	observation.Revision = 2
	observation.UpdatedAt = "2026-10-06T12:00:01Z"
	core.updates <- hostsession.CoreUpdate{HostHarnessSessionID: observation.HostHarnessSessionID, Session: &observation}
	require.Eventually(t, func() bool {
		client.hostSessions.mu.Lock()
		defer client.hostSessions.mu.Unlock()
		return len(client.hostSessions.pending) == 1
	}, time.Second, 10*time.Millisecond)
}

func TestHostSessionCoreResyncSignalDiscardsDeltasAndMarksTransportDirty(t *testing.T) {
	core := newFakeHostSessionCore()
	client := hostSessionTestClient(core)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client.hostSessions.start(ctx)
	core.updates <- hostsession.CoreUpdate{Resync: true}
	require.Eventually(t, func() bool {
		client.hostSessions.mu.Lock()
		defer client.hostSessions.mu.Unlock()
		return client.hostSessions.dirty && len(client.hostSessions.pending) == 0
	}, time.Second, 10*time.Millisecond)
}
