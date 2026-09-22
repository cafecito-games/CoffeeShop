package controlplane

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp/acptest"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/config"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/harness"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

func allowTransport(harnessID, transport, fallbackTransport string) error {
	return nil
}

func refuseTransport(harnessID, transport, fallbackTransport string) error {
	return errors.New("adapter unavailable")
}

func allowResume(harnessID string) error {
	return nil
}

func refuseResume(harnessID string) error {
	return errors.New("resume unavailable")
}

func TestUnsupportedExecutionReasonGatesSessionBindings(t *testing.T) {
	validBinding := protocol.DispatchSessionBinding{ID: "binding-one", ProviderSessionID: "provider-previous"}
	cases := []struct {
		name      string
		run       protocol.Run
		execution *protocol.DispatchExecution
		admit     admitTransport
		resume    admitResume
		reason    string
	}{
		{
			name:   "run binding without an execution binding",
			run:    protocol.Run{ID: "run-acp", HarnessID: "codex-cli", SessionBindingID: "binding-one"},
			admit:  allowTransport,
			resume: allowResume,
			reason: "unsupported execution: the run's session binding is missing or names a different binding",
		},
		{
			name:      "execution binding without a run binding",
			run:       protocol.Run{ID: "run-acp", HarnessID: "codex-cli", Transport: protocol.TransportACP},
			execution: &protocol.DispatchExecution{Transport: protocol.TransportACP, SessionBinding: &protocol.DispatchSessionBinding{ID: "binding-one", ProviderSessionID: "provider-previous"}},
			admit:     allowTransport,
			resume:    allowResume,
			reason:    "unsupported execution: the run's session binding is missing or names a different binding",
		},
		{
			name:      "mismatched binding ids",
			run:       protocol.Run{ID: "run-acp", HarnessID: "codex-cli", Transport: protocol.TransportACP, SessionBindingID: "binding-one"},
			execution: &protocol.DispatchExecution{Transport: protocol.TransportACP, SessionBinding: &protocol.DispatchSessionBinding{ID: "binding-two", ProviderSessionID: "provider-previous"}},
			admit:     allowTransport,
			resume:    allowResume,
			reason:    "unsupported execution: the run's session binding is missing or names a different binding",
		},
		{
			name:      "native transport cannot resume",
			run:       protocol.Run{ID: "run-acp", HarnessID: "codex-cli", Transport: protocol.TransportNativeCLI, SessionBindingID: "binding-one"},
			execution: &protocol.DispatchExecution{Transport: protocol.TransportNativeCLI, SessionBinding: &validBinding},
			admit:     allowTransport,
			resume:    allowResume,
			reason:    "unsupported execution: only an acp-v1 run can resume a session",
		},
		{
			name:      "binding without a provider session",
			run:       protocol.Run{ID: "run-acp", HarnessID: "codex-cli", Transport: protocol.TransportACP, SessionBindingID: "binding-one"},
			execution: &protocol.DispatchExecution{Transport: protocol.TransportACP, SessionBinding: &protocol.DispatchSessionBinding{ID: "binding-one"}},
			admit:     allowTransport,
			resume:    allowResume,
			reason:    "unsupported execution: the session binding is malformed",
		},
		{
			name:      "secret-like provider session",
			run:       protocol.Run{ID: "run-acp", HarnessID: "codex-cli", Transport: protocol.TransportACP, SessionBindingID: "binding-one"},
			execution: &protocol.DispatchExecution{Transport: protocol.TransportACP, SessionBinding: &protocol.DispatchSessionBinding{ID: "binding-one", ProviderSessionID: "sk-ant-api03-" + strings.Repeat("a", 40)}},
			admit:     allowTransport,
			resume:    allowResume,
			reason:    "unsupported execution: the session binding is malformed",
		},
		{
			name:      "resume prompt beyond its bound",
			run:       protocol.Run{ID: "run-acp", HarnessID: "codex-cli", Transport: protocol.TransportACP, SessionBindingID: "binding-one"},
			execution: &protocol.DispatchExecution{Transport: protocol.TransportACP, SessionBinding: &protocol.DispatchSessionBinding{ID: "binding-one", ProviderSessionID: "provider-previous", ResumePrompt: strings.Repeat("a", protocol.SessionResumePromptMaximumBytes+1)}},
			admit:     allowTransport,
			resume:    allowResume,
			reason:    "unsupported execution: the session binding is malformed",
		},
		{
			name:      "resume prompt that is not valid UTF-8",
			run:       protocol.Run{ID: "run-acp", HarnessID: "codex-cli", Transport: protocol.TransportACP, SessionBindingID: "binding-one"},
			execution: &protocol.DispatchExecution{Transport: protocol.TransportACP, SessionBinding: &protocol.DispatchSessionBinding{ID: "binding-one", ProviderSessionID: "provider-previous", ResumePrompt: "\xff\xfe"}},
			admit:     allowTransport,
			resume:    allowResume,
			reason:    "unsupported execution: the session binding is malformed",
		},
		{
			name:      "nil resume admission",
			run:       protocol.Run{ID: "run-acp", HarnessID: "codex-cli", Transport: protocol.TransportACP, SessionBindingID: "binding-one"},
			execution: &protocol.DispatchExecution{Transport: protocol.TransportACP, SessionBinding: &validBinding},
			admit:     allowTransport,
			resume:    nil,
			reason:    "unsupported execution: session resume not available for this harness on this Barista",
		},
		{
			name:      "resume admission refuses",
			run:       protocol.Run{ID: "run-acp", HarnessID: "codex-cli", Transport: protocol.TransportACP, SessionBindingID: "binding-one"},
			execution: &protocol.DispatchExecution{Transport: protocol.TransportACP, SessionBinding: &validBinding},
			admit:     allowTransport,
			resume:    refuseResume,
			reason:    "unsupported execution: session resume not available for this harness on this Barista",
		},
		{
			name:      "accepted acp run with matching binding",
			run:       protocol.Run{ID: "run-acp", HarnessID: "codex-cli", Transport: protocol.TransportACP, SessionBindingID: "binding-one"},
			execution: &protocol.DispatchExecution{Transport: protocol.TransportACP, SessionBinding: &protocol.DispatchSessionBinding{ID: "binding-one", ProviderSessionID: "provider-previous", ResumePrompt: "continue the durable work"}},
			admit:     allowTransport,
			resume:    allowResume,
			reason:    "",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			require.Equal(t, testCase.reason, unsupportedExecutionReason(testCase.run, testCase.execution, testCase.admit, testCase.resume, nil))
		})
	}
	require.Equal(t, "unsupported execution: acp-v1 transport not available on this Barista",
		unsupportedExecutionReason(protocol.Run{HarnessID: "codex-cli", Transport: protocol.TransportACP, SessionBindingID: "binding-one"},
			&protocol.DispatchExecution{Transport: protocol.TransportACP, SessionBinding: &protocol.DispatchSessionBinding{ID: "binding-one", ProviderSessionID: "provider-previous"}},
			refuseTransport, allowResume, nil))
}

// dispatchResume probed the scenario's adapter for resume support, dispatches a run carrying a
// session binding, and returns the client whose outbox captures what the hub would receive.
func dispatchResume(t *testing.T, scenario string) *Client {
	t.Helper()
	executable, err := os.Executable()
	require.NoError(t, err)
	record := filepath.Join(t.TempDir(), "frames.jsonl")
	t.Cleanup(func() { acptest.KillDescendants(t, record) })
	driver := harness.NewACPDriver(harness.ACPDriverOptions{
		Adapters:            map[string]harness.ACPAdapter{"codex-cli": {Binary: executable, Environment: acptest.Environment(scenario, record)}},
		Providers:           map[string]harness.ACPProvider{"codex-cli": {}},
		RequestTimeout:      5 * time.Second,
		PermissionTimeout:   5 * time.Second,
		CancelGracePeriod:   time.Second,
		ShutdownGracePeriod: 2 * time.Second,
	})
	_, err = driver.Probe(context.Background(), "codex-cli")
	require.NoError(t, err)
	directory := t.TempDir()
	client := NewClient(config.Config{Concurrency: 1, WorkspaceRoots: []string{directory}}, protocol.ComputeNode{ID: "node-one"}, harness.NewRunner(nil).WithACP(driver), emptyCapabilityReport)
	client.handle(context.Background(), protocol.Inbound{Type: "dispatch",
		Run: protocol.Run{ID: "run-acp", HarnessID: "codex-cli", Transport: harness.TransportACP, Workspace: directory, Prompt: "run the tests", SessionBindingID: "binding-one"},
		Execution: &protocol.DispatchExecution{Transport: harness.TransportACP, SessionBinding: &protocol.DispatchSessionBinding{
			ID: "binding-one", ProviderSessionID: acptest.ResumedSessionID, ResumePrompt: "continue the durable record",
		}},
	})
	return client
}

// sessionBindingPlacement locates the session.binding and run.started messages in outbox order.
func sessionBindingPlacement(t *testing.T, client *Client) (map[string]json.RawMessage, int, int) {
	t.Helper()
	objects := outboxObjects(t, client)
	bindingIndex, startedIndex := -1, -1
	for index, object := range objects {
		var messageType string
		require.NoError(t, json.Unmarshal(object["type"], &messageType))
		switch messageType {
		case "session.binding":
			bindingIndex = index
		case "run.started":
			startedIndex = index
		}
	}
	return objects[bindingIndex], bindingIndex, startedIndex
}

func TestDispatchReportsTheResumedSessionBeforeTheRunStarts(t *testing.T) {
	client := dispatchResume(t, "resume-success")
	completed := waitForMessage(t, client, "run.completed")
	require.Equal(t, "run-acp", completed.RunID)

	bindingMessage, bindingIndex, startedIndex := sessionBindingPlacement(t, client)
	require.GreaterOrEqual(t, bindingIndex, 0, "the hub must receive a session.binding")
	require.GreaterOrEqual(t, startedIndex, 0)
	require.Less(t, bindingIndex, startedIndex, "session.binding must arrive before run.started")
	require.ElementsMatch(t, []string{"type", "runId", "binding", "at"}, keys(bindingMessage))
	var binding protocol.SessionBindingUpdate
	require.NoError(t, json.Unmarshal(bindingMessage["binding"], &binding))
	require.Equal(t, protocol.SessionBindingUpdate{
		BindingID: "binding-one", ProviderSessionID: acptest.ResumedSessionID,
		HarnessID: "codex-cli", Transport: "acp-v1", Status: "active",
	}, binding)
}

func TestDispatchReportsAReplacementSessionWithoutABindingIdentity(t *testing.T) {
	client := dispatchResume(t, "resume-refused")
	completed := waitForMessage(t, client, "run.completed")
	require.Equal(t, "run-acp", completed.RunID)

	bindingMessage, bindingIndex, startedIndex := sessionBindingPlacement(t, client)
	require.GreaterOrEqual(t, bindingIndex, 0)
	require.GreaterOrEqual(t, startedIndex, 0)
	require.Less(t, bindingIndex, startedIndex)
	var rawBinding map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(bindingMessage["binding"], &rawBinding))
	_, carriesBindingID := rawBinding["bindingId"]
	require.False(t, carriesBindingID, "a replacement session carries no binding identity")
	var binding protocol.SessionBindingUpdate
	require.NoError(t, json.Unmarshal(bindingMessage["binding"], &binding))
	require.Equal(t, acptest.SessionID, binding.ProviderSessionID)
	require.Empty(t, binding.BindingID)
}

func TestDispatchHonorsALoadOnlyProbedAdapter(t *testing.T) {
	client := dispatchResume(t, "load-success")
	completed := waitForMessage(t, client, "run.completed")
	require.Equal(t, "run-acp", completed.RunID)

	bindingMessage, _, _ := sessionBindingPlacement(t, client)
	var binding protocol.SessionBindingUpdate
	require.NoError(t, json.Unmarshal(bindingMessage["binding"], &binding))
	require.Equal(t, acptest.ResumedSessionID, binding.ProviderSessionID)
	require.Equal(t, "binding-one", binding.BindingID)
	for _, message := range outboundMessages(t, client) {
		require.NotEqual(t, "run.failed", message.Type)
	}
}
