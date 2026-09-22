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
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/config"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/harness"
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

func emptyCapabilityReport(context.Context) protocol.NodeCapabilityReport {
	return protocol.NodeCapabilityReport{}
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
	require.Equal(t, "unsupported execution: session binding resume not available on this Barista", message.Error)
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
	require.Equal(t, "unsupported execution: workspace lease provisioning not available on this Barista", message.Error)
}

func TestDispatchWithNativeCliExecutionIsNotRejectedByTheExecutionGuard(t *testing.T) {
	// A nil transport (plain dispatch) and an explicit "native-cli" transport with neither a
	// session binding nor a workspace lease are both fully supported today; neither should ever
	// produce the unsupported-execution run.failed message.
	require.Equal(t, "", unsupportedExecutionReason(protocol.Run{}, nil, nil))
	require.Equal(t, "", unsupportedExecutionReason(protocol.Run{Transport: "native-cli"}, &protocol.DispatchExecution{Transport: "native-cli"}, nil))
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
	require.Equal(t, "unsupported execution: session binding resume not available on this Barista", message.Error)

	workspaceLeaseClient := NewClient(config.Config{Concurrency: 1}, protocol.ComputeNode{ID: "node-two"}, nil, emptyCapabilityReport)
	workspaceLeaseClient.handle(context.Background(), protocol.Inbound{
		Type:  "dispatch",
		Run:   protocol.Run{ID: "run-two", WorkspaceLeaseID: "lease-one"},
		Agent: protocol.Agent{ID: "agent-two"},
	})
	require.Zero(t, workspaceLeaseClient.activeRuns())
	message = waitForMessage(t, workspaceLeaseClient, "run.failed")
	require.Equal(t, "unsupported execution: workspace lease provisioning not available on this Barista", message.Error)
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
