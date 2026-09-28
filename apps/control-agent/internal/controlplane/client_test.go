package controlplane

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/config"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/harness"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/mcpserver"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
	"nhooyr.io/websocket"
)

func outboundMessages(t *testing.T, client *Client) []protocol.Outbound {
	t.Helper()
	client.connectionMu.Lock()
	defer client.connectionMu.Unlock()
	messages := make([]protocol.Outbound, 0, len(client.outbox))
	for _, data := range client.outbox {
		var message protocol.Outbound
		require.NoError(t, json.Unmarshal(data, &message))
		messages = append(messages, message)
	}
	return messages
}

func waitForMessage(t *testing.T, client *Client, messageType string) protocol.Outbound {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		for _, message := range outboundMessages(t, client) {
			if message.Type == messageType {
				return message
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", messageType)
	return protocol.Outbound{}
}

// acknowledgeRegistration answers a register the way the hub does once it admits the connection.
func acknowledgeRegistration(t *testing.T, ctx context.Context, connection *websocket.Conn) {
	t.Helper()
	require.NoError(t, connection.Write(ctx, websocket.MessageText, []byte(`{"type":"ping"}`)))
}

func TestRefusedRegistrationKeepsTheLifecycleOutbox(t *testing.T) {
	received := make(chan []string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(writer, request, nil)
		require.NoError(t, err)
		_, data, err := connection.Read(request.Context())
		require.NoError(t, err)
		var message protocol.Outbound
		require.NoError(t, json.Unmarshal(data, &message))
		connection.Close(websocket.StatusPolicyViolation, "node is already connected")
		received <- []string{message.Type}
	}))
	defer server.Close()

	client := NewClient(config.Config{
		ControlEndpoint: strings.Replace(server.URL, "http://", "ws://", 1), Concurrency: 1,
	}, protocol.ComputeNode{ID: "node-one"}, nil, emptyCapabilityReport)
	client.send(protocol.Outbound{Type: "run.completed", RunID: "run-one", Output: "done", At: now()})
	connected, err := client.runOnce(context.Background())
	require.Error(t, err)
	require.False(t, connected)
	require.Equal(t, []string{"register"}, <-received, "nothing queued is written to a refused socket")
	queued := outboundMessages(t, client)
	require.Len(t, queued, 1)
	require.Equal(t, "run.completed", queued[0].Type)
}

func emptyCapabilityReport(context.Context) protocol.NodeCapabilityReport {
	return protocol.NodeCapabilityReport{}
}

func TestArtifactUploaderClassifiesHTTPAndTransportFailuresWithoutResponseDetails(t *testing.T) {
	for _, status := range []int{400, 408, 425, 429, 500} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				require.Equal(t, "Bearer enrollment-secret", request.Header.Get("Authorization"))
				require.Equal(t, int64(3), request.ContentLength)
				writer.WriteHeader(status)
				_, _ = writer.Write([]byte("credential=must-not-escape"))
			}))
			defer server.Close()
			client := NewClient(config.Config{
				ControlEndpoint: strings.Replace(server.URL, "http://", "ws://", 1),
				Concurrency:     1, Token: "enrollment-secret",
			}, protocol.ComputeNode{ID: "node-one"}, nil, emptyCapabilityReport)
			err := client.uploadArtifact(context.Background(), "/api/artifacts/one/content", strings.NewReader("abc"), 3)
			var failure *mcpserver.UploadError
			require.ErrorAs(t, err, &failure)
			require.Equal(t, status, failure.StatusCode)
			require.False(t, failure.Uncertain)
			require.NotContains(t, err.Error(), "credential")
			require.NotContains(t, err.Error(), "enrollment-secret")
		})
	}

	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	endpoint := strings.Replace(server.URL, "http://", "ws://", 1)
	server.Close()
	client := NewClient(config.Config{ControlEndpoint: endpoint, Concurrency: 1}, protocol.ComputeNode{ID: "node-one"}, nil, emptyCapabilityReport)
	err := client.uploadArtifact(context.Background(), "/api/artifacts/one/content", strings.NewReader("abc"), 3)
	var failure *mcpserver.UploadError
	require.ErrorAs(t, err, &failure)
	require.True(t, failure.Uncertain)
}

func TestRunOnceAuthenticatesAndRegisters(t *testing.T) {
	type receivedMessage struct {
		authorization string
		message       protocol.Outbound
		err           error
	}
	messages := make(chan receivedMessage, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		result := receivedMessage{authorization: request.Header.Get("Authorization")}
		connection, err := websocket.Accept(writer, request, nil)
		if err != nil {
			result.err = err
			messages <- result
			return
		}
		defer connection.Close(websocket.StatusNormalClosure, "test complete")
		_, data, err := connection.Read(request.Context())
		if err != nil {
			result.err = err
			messages <- result
			return
		}
		result.err = json.Unmarshal(data, &result.message)
		acknowledgeRegistration(t, request.Context(), connection)
		messages <- result
	}))
	defer server.Close()

	cfg := config.Config{
		ControlEndpoint: strings.Replace(server.URL, "http://", "ws://", 1),
		Concurrency:     2,
		Token:           "enrollment-secret",
	}
	node := protocol.ComputeNode{ID: "worker-1", Name: "Worker 1"}
	client := NewClient(cfg, node, nil, emptyCapabilityReport)
	connected, err := client.runOnce(context.Background())
	require.Error(t, err)
	require.True(t, connected)

	got := <-messages
	require.NoError(t, got.err)
	require.Equal(t, "Bearer enrollment-secret", got.authorization)
	require.Equal(t, "register", got.message.Type)
	require.Equal(t, protocol.Version, got.message.ProtocolVersion)
	require.NotNil(t, got.message.Node)
	require.Equal(t, "worker-1", got.message.Node.ID)
}

func TestReconnectFlushesLifecycleBeforeCompletingSync(t *testing.T) {
	messages := make(chan []protocol.Outbound, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(writer, request, nil)
		require.NoError(t, err)
		defer connection.Close(websocket.StatusNormalClosure, "test complete")
		got := make([]protocol.Outbound, 0, 3)
		for len(got) < 3 {
			_, data, readErr := connection.Read(request.Context())
			require.NoError(t, readErr)
			var message protocol.Outbound
			require.NoError(t, json.Unmarshal(data, &message))
			got = append(got, message)
			if message.Type == "register" {
				acknowledgeRegistration(t, request.Context(), connection)
			}
		}
		messages <- got
	}))
	defer server.Close()

	client := NewClient(config.Config{
		ControlEndpoint: strings.Replace(server.URL, "http://", "ws://", 1), Concurrency: 1,
	}, protocol.ComputeNode{ID: "node-one"}, nil, emptyCapabilityReport)
	client.send(protocol.Outbound{Type: "run.completed", RunID: "run-one", Output: "done", At: now()})
	connected, err := client.runOnce(context.Background())
	require.Error(t, err)
	require.True(t, connected)

	got := <-messages
	require.Equal(t, []string{"register", "run.completed", "sync.complete"}, []string{got[0].Type, got[1].Type, got[2].Type})
	require.Equal(t, protocol.Version, got[0].ProtocolVersion)
	require.Equal(t, "node-one", got[2].NodeID)
}

func TestComponentInventoryIsBuiltAfterAckAndWrittenBeforeOutboxAndSync(t *testing.T) {
	var built atomic.Int32
	var readinessBuilt atomic.Int32
	types := make(chan []string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(writer, request, nil)
		require.NoError(t, err)
		defer connection.Close(websocket.StatusNormalClosure, "test complete")
		got := make([]string, 0, 5)
		for len(got) < 5 {
			_, data, readErr := connection.Read(request.Context())
			require.NoError(t, readErr)
			var envelope struct {
				Type string `json:"type"`
			}
			require.NoError(t, json.Unmarshal(data, &envelope))
			got = append(got, envelope.Type)
			if envelope.Type == "register" {
				require.Zero(t, built.Load(), "inventory must not be built for an unacknowledged socket")
				acknowledgeRegistration(t, request.Context(), connection)
			}
		}
		types <- got
	}))
	defer server.Close()

	client := NewClient(config.Config{ControlEndpoint: strings.Replace(server.URL, "http://", "ws://", 1), Concurrency: 1},
		protocol.ComputeNode{ID: "node-one"}, nil, emptyCapabilityReport).WithComponentInventory(func(context.Context) protocol.ComponentInventoryReport {
		built.Add(1)
		return protocol.ComponentInventoryReport{NodeID: "node-one", ObservedAt: "2026-09-28T12:00:00Z", Components: []protocol.ComponentInventoryEntry{}}
	}).WithCapabilityPackReadiness(func(context.Context) protocol.CapabilityPackReadinessReport {
		readinessBuilt.Add(1)
		return protocol.CapabilityPackReadinessReport{NodeID: "node-one", ObservedAt: "2026-09-28T12:00:00Z", Status: "unavailable", Surfaces: []protocol.CapabilityPackSurface{}, ReasonCode: "not-selected"}
	})
	client.send(protocol.Outbound{Type: "run.completed", RunID: "run-one", Output: "done", At: now()})
	connected, err := client.runOnce(context.Background())
	require.Error(t, err)
	require.True(t, connected)
	require.Equal(t, []string{"register", "component.inventory", "capability-pack.readiness", "run.completed", "sync.complete"}, <-types)
	require.EqualValues(t, 1, built.Load())
	require.EqualValues(t, 1, readinessBuilt.Load())
}

func TestComponentInventoryIsRebuiltForEveryAcknowledgedReconnect(t *testing.T) {
	observations := make(chan string, 2)
	readinessObservations := make(chan string, 2)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(writer, request, nil)
		require.NoError(t, err)
		defer connection.Close(websocket.StatusNormalClosure, "test complete")
		for {
			_, data, readErr := connection.Read(request.Context())
			require.NoError(t, readErr)
			var envelope struct {
				Type   string                            `json:"type"`
				Report protocol.ComponentInventoryReport `json:"report"`
			}
			require.NoError(t, json.Unmarshal(data, &envelope))
			switch envelope.Type {
			case "register":
				acknowledgeRegistration(t, request.Context(), connection)
			case "component.inventory":
				observations <- envelope.Report.ObservedAt
			case "capability-pack.readiness":
				var readiness protocol.CapabilityPackReadinessMessage
				require.NoError(t, json.Unmarshal(data, &readiness))
				readinessObservations <- readiness.Report.ObservedAt
			case "sync.complete":
				return
			}
		}
	}))
	defer server.Close()

	var builds atomic.Int32
	client := NewClient(config.Config{ControlEndpoint: strings.Replace(server.URL, "http://", "ws://", 1), Concurrency: 1},
		protocol.ComputeNode{ID: "node-one"}, nil, emptyCapabilityReport).WithComponentInventory(func(context.Context) protocol.ComponentInventoryReport {
		build := builds.Add(1)
		return protocol.ComponentInventoryReport{NodeID: "node-one", ObservedAt: time.Date(2026, 9, 28, 12, 0, int(build), 0, time.UTC).Format(time.RFC3339), Components: []protocol.ComponentInventoryEntry{}}
	}).WithCapabilityPackReadiness(func(context.Context) protocol.CapabilityPackReadinessReport {
		build := builds.Load()
		return protocol.CapabilityPackReadinessReport{NodeID: "node-one", ObservedAt: time.Date(2026, 9, 28, 12, 1, int(build), 0, time.UTC).Format(time.RFC3339), Status: "unavailable", Surfaces: []protocol.CapabilityPackSurface{}, ReasonCode: "not-selected"}
	})
	for range 2 {
		connected, err := client.runOnce(context.Background())
		require.Error(t, err)
		require.True(t, connected)
	}
	require.Equal(t, []string{"2026-09-28T12:00:01Z", "2026-09-28T12:00:02Z"}, []string{<-observations, <-observations})
	require.Equal(t, []string{"2026-09-28T12:01:01Z", "2026-09-28T12:01:02Z"}, []string{<-readinessObservations, <-readinessObservations})
	require.EqualValues(t, 2, builds.Load())
}

func TestInvalidLocalComponentInventoryDoesNotTakeDownTheRegisteredNode(t *testing.T) {
	validEntry := protocol.ComponentInventoryEntry{
		Kind: "harness", ID: "codex-cli", HarnessID: "codex-cli", DeclaredVersion: "1.2.3",
		InstalledVersions: []string{}, Provenance: "external", Readiness: "ready", DiagnosticCodes: []string{},
	}
	for _, testCase := range []struct {
		name       string
		nodeID     string
		components []protocol.ComponentInventoryEntry
	}{
		{name: "too many components", nodeID: "node-one", components: make([]protocol.ComponentInventoryEntry, protocol.ComponentInventoryLimit+1)},
		{name: "oversized component id", nodeID: "node-one", components: []protocol.ComponentInventoryEntry{{
			Kind: "harness", ID: strings.Repeat("a", 129), HarnessID: validEntry.HarnessID, DeclaredVersion: validEntry.DeclaredVersion,
			InstalledVersions: []string{}, Provenance: validEntry.Provenance, Readiness: validEntry.Readiness, DiagnosticCodes: []string{},
		}}},
		{name: "registration-compatible long node id", nodeID: strings.Repeat("n", 129), components: []protocol.ComponentInventoryEntry{}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			types := make(chan []string, 1)
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				connection, err := websocket.Accept(writer, request, nil)
				require.NoError(t, err)
				defer connection.Close(websocket.StatusNormalClosure, "test complete")
				got := []string{}
				for {
					_, data, readErr := connection.Read(request.Context())
					if readErr != nil {
						types <- got
						return
					}
					var envelope struct {
						Type string `json:"type"`
					}
					require.NoError(t, json.Unmarshal(data, &envelope))
					got = append(got, envelope.Type)
					if envelope.Type == "register" {
						acknowledgeRegistration(t, request.Context(), connection)
					}
					if envelope.Type == "sync.complete" {
						types <- got
						return
					}
				}
			}))
			defer server.Close()

			client := NewClient(config.Config{ControlEndpoint: strings.Replace(server.URL, "http://", "ws://", 1), Concurrency: 1},
				protocol.ComputeNode{ID: testCase.nodeID}, nil, emptyCapabilityReport).WithComponentInventory(func(context.Context) protocol.ComponentInventoryReport {
				return protocol.ComponentInventoryReport{NodeID: testCase.nodeID, ObservedAt: "2026-09-28T12:00:00Z", Components: testCase.components}
			})
			client.send(protocol.Outbound{Type: "run.completed", RunID: "run-one", Output: "done", At: now()})
			connected, err := client.runOnce(context.Background())
			require.Error(t, err)
			require.True(t, connected)
			require.Equal(t, []string{"register", "run.completed", "sync.complete"}, <-types)
		})
	}
}

func TestCancelBeforeDispatchCreatesTombstoneAndAcknowledgesDuplicates(t *testing.T) {
	client := NewClient(config.Config{Concurrency: 1}, protocol.ComputeNode{ID: "node-one"}, nil, emptyCapabilityReport)
	client.handle(context.Background(), protocol.Inbound{Type: "cancel", RunID: "run-one"})
	client.handle(context.Background(), protocol.Inbound{Type: "cancel", RunID: "run-one"})
	client.handle(context.Background(), protocol.Inbound{Type: "dispatch", Run: protocol.Run{ID: "run-one"}})

	require.Zero(t, client.activeRuns())
	messages := outboundMessages(t, client)
	require.Len(t, messages, 2)
	for _, message := range messages {
		require.Equal(t, "run.cancelled", message.Type)
		require.Equal(t, "run-one", message.RunID)
	}
}

func TestDispatchRejectsUnsupportedAcpTransportWithoutStartingAProcess(t *testing.T) {
	client := NewClient(config.Config{Concurrency: 1}, protocol.ComputeNode{ID: "node-one"}, nil, emptyCapabilityReport)
	client.handle(context.Background(), protocol.Inbound{
		Type:      "dispatch",
		Run:       protocol.Run{ID: "run-one"},
		Agent:     protocol.Agent{ID: "agent-one"},
		Execution: &protocol.DispatchExecution{Transport: "acp-v1"},
	})

	require.Zero(t, client.activeRuns(), "an unsupported execution must never occupy a run slot")
	message := waitForMessage(t, client, "run.failed")
	require.Equal(t, "run-one", message.RunID)
	require.Equal(t, "unsupported execution: acp-v1 transport not available on this Barista", message.Error)
}

func TestDispatchRejectsSessionBindingResumeWithoutStartingAProcess(t *testing.T) {
	client := NewClient(config.Config{Concurrency: 1}, protocol.ComputeNode{ID: "node-one"}, nil, emptyCapabilityReport)
	client.handle(context.Background(), protocol.Inbound{
		Type:  "dispatch",
		Run:   protocol.Run{ID: "run-one"},
		Agent: protocol.Agent{ID: "agent-one"},
		Execution: &protocol.DispatchExecution{
			Transport:      "native-cli",
			SessionBinding: &protocol.DispatchSessionBinding{ID: "binding-one", ProviderSessionID: "session-one"},
		},
	})

	require.Zero(t, client.activeRuns())
	message := waitForMessage(t, client, "run.failed")
	require.Equal(t, "run-one", message.RunID)
	require.Equal(t, "unsupported execution: the run's session binding is missing or names a different binding", message.Error)
}

func TestDispatchRejectsWorkspaceLeaseGrantWithoutStartingAProcess(t *testing.T) {
	client := NewClient(config.Config{Concurrency: 1}, protocol.ComputeNode{ID: "node-one"}, nil, emptyCapabilityReport)
	client.handle(context.Background(), protocol.Inbound{
		Type:  "dispatch",
		Run:   protocol.Run{ID: "run-one"},
		Agent: protocol.Agent{ID: "agent-one"},
		Execution: &protocol.DispatchExecution{
			Transport:      "native-cli",
			WorkspaceLease: &protocol.WorkspaceLeaseGrant{ID: "lease-one"},
		},
	})

	require.Zero(t, client.activeRuns())
	message := waitForMessage(t, client, "run.failed")
	require.Equal(t, "run-one", message.RunID)
	require.Equal(t, "unsupported execution: the workspace lease grant does not belong to the run", message.Error)
}

func TestDispatchWithNativeCliExecutionIsNotRejectedByTheExecutionGuard(t *testing.T) {
	// A nil transport (plain dispatch) and an explicit "native-cli" transport with neither a
	// session binding nor a workspace lease are both fully supported today; neither should ever
	// produce the unsupported-execution run.failed message.
	require.Equal(t, "", unsupportedExecutionReason(protocol.Run{}, nil, nil, nil, nil))
	require.Equal(t, "", unsupportedExecutionReason(protocol.Run{Transport: "native-cli"}, &protocol.DispatchExecution{Transport: "native-cli"}, nil, nil, nil))
}

// A version-4 dispatch may omit the transport entirely; the omitted transport is the legacy native
// default and must keep working end to end for a natively available harness even though admission
// of an explicit native-cli request now reads the harness's advertised transports.
func TestV4DispatchWithoutATransportRunsANativelyAvailableHarness(t *testing.T) {
	directory := t.TempDir()
	client := instanceTestClient(t, quickHarnessBinary(t, directory), directory, 1, 0, []string{"default"})
	client.handle(context.Background(), protocol.Inbound{
		Type:  "dispatch",
		Run:   protocol.Run{ID: "run-legacy", HarnessID: "codex-cli", Model: "default", Workspace: directory, Prompt: "do the work"},
		Agent: protocol.Agent{ID: "agent-one"},
	})

	message := waitForMessage(t, client, "run.completed")
	require.Equal(t, "run-legacy", message.RunID)
	require.Equal(t, "done", message.Output)
	require.Zero(t, client.activeRuns())
}

func TestDispatchRejectsUnsupportedTransportOnTheRunWithNoExecutionObject(t *testing.T) {
	// A hub could set run.transport directly without an execution object at all; the guard must
	// still reject it instead of letting the run start natively.
	client := NewClient(config.Config{Concurrency: 1}, protocol.ComputeNode{ID: "node-one"}, nil, emptyCapabilityReport)
	client.handle(context.Background(), protocol.Inbound{
		Type:  "dispatch",
		Run:   protocol.Run{ID: "run-one", Transport: "acp-v1"},
		Agent: protocol.Agent{ID: "agent-one"},
	})

	require.Zero(t, client.activeRuns(), "a run.transport of acp-v1 with no execution object must still be rejected")
	message := waitForMessage(t, client, "run.failed")
	require.Equal(t, "run-one", message.RunID)
	require.Equal(t, "unsupported execution: acp-v1 transport not available on this Barista", message.Error)
}

func TestDispatchRejectsRunLevelSessionBindingAndWorkspaceLeaseFields(t *testing.T) {
	sessionBindingClient := NewClient(config.Config{Concurrency: 1}, protocol.ComputeNode{ID: "node-one"}, nil, emptyCapabilityReport)
	sessionBindingClient.handle(context.Background(), protocol.Inbound{
		Type:  "dispatch",
		Run:   protocol.Run{ID: "run-one", SessionBindingID: "binding-one"},
		Agent: protocol.Agent{ID: "agent-one"},
	})
	require.Zero(t, sessionBindingClient.activeRuns())
	message := waitForMessage(t, sessionBindingClient, "run.failed")
	require.Equal(t, "unsupported execution: the run's session binding is missing or names a different binding", message.Error)

	workspaceLeaseClient := NewClient(config.Config{Concurrency: 1}, protocol.ComputeNode{ID: "node-two"}, nil, emptyCapabilityReport)
	workspaceLeaseClient.handle(context.Background(), protocol.Inbound{
		Type:  "dispatch",
		Run:   protocol.Run{ID: "run-two", WorkspaceLeaseID: "lease-one"},
		Agent: protocol.Agent{ID: "agent-two"},
	})
	require.Zero(t, workspaceLeaseClient.activeRuns())
	message = waitForMessage(t, workspaceLeaseClient, "run.failed")
	require.Equal(t, "unsupported execution: the run's workspace lease grant is missing or names a different lease", message.Error)
}

func TestActiveCancellationAcknowledgesWithoutFailureOrCompletion(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test fixture is a shell script")
	}
	directory := t.TempDir()
	binary := filepath.Join(directory, "fake-codex")
	require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\nprintf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"started\"}}'\nsleep 30\n"), 0o755))
	runner := harness.NewRunner([]protocol.HarnessProfile{{ID: "codex-cli", Binary: binary, Available: true}})
	client := NewClient(config.Config{Concurrency: 1, WorkspaceRoots: []string{directory}}, protocol.ComputeNode{ID: "node-one"}, runner, emptyCapabilityReport)
	run := protocol.Run{ID: "run-one", HarnessID: "codex-cli", Model: "default", Workspace: directory, Prompt: "test"}
	client.handle(context.Background(), protocol.Inbound{Type: "dispatch", Run: run, Agent: protocol.Agent{ID: "agent-one"}})
	waitForMessage(t, client, "run.started")

	client.handle(context.Background(), protocol.Inbound{Type: "cancel", RunID: "run-one"})
	waitForMessage(t, client, "run.cancelled")
	require.Zero(t, client.activeRuns(), "active cancellation is acknowledged after process-tree cleanup")
	for _, message := range outboundMessages(t, client) {
		require.NotEqual(t, "run.failed", message.Type)
		require.NotEqual(t, "run.completed", message.Type)
	}

	client.handle(context.Background(), protocol.Inbound{Type: "dispatch", Run: run, Agent: protocol.Agent{ID: "agent-one"}})
	require.Zero(t, client.activeRuns(), "a reconnect replay must remain tombstoned")
}

func TestRunOnceSendsCapabilityReportAfterRegistration(t *testing.T) {
	messages := make(chan []protocol.Outbound, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(writer, request, nil)
		require.NoError(t, err)
		defer connection.Close(websocket.StatusNormalClosure, "test complete")
		got := make([]protocol.Outbound, 0, 4)
		for len(got) < 4 {
			_, data, readErr := connection.Read(request.Context())
			require.NoError(t, readErr)
			var message protocol.Outbound
			require.NoError(t, json.Unmarshal(data, &message))
			got = append(got, message)
			if message.Type == "register" {
				acknowledgeRegistration(t, request.Context(), connection)
			}
			if message.Type == "capability.report" {
				break
			}
		}
		messages <- got
	}))
	defer server.Close()

	client := NewClient(config.Config{
		ControlEndpoint: strings.Replace(server.URL, "http://", "ws://", 1), Concurrency: 1,
	}, protocol.ComputeNode{ID: "worker-9"}, nil, func(context.Context) protocol.NodeCapabilityReport {
		return protocol.NodeCapabilityReport{NodeID: "worker-9", Evidence: []protocol.NodeCapabilityEvidence{}, At: now()}
	})
	connected, err := client.runOnce(context.Background())
	require.Error(t, err)
	require.True(t, connected)

	got := <-messages
	var report *protocol.NodeCapabilityReport
	for _, message := range got {
		if message.Type == "capability.report" {
			report = message.Report
		}
	}
	require.NotNil(t, report, "a capability.report must follow registration on every connection")
	require.Equal(t, "worker-9", report.NodeID)
}
