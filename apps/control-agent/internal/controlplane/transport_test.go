package controlplane

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp/acptest"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/config"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/harness"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

func TestUnsupportedExecutionReasonAcrossAdmitBehaviorsAndDispatches(t *testing.T) {
	admitError := func(string, string, string) error { return errors.New("adapter is unavailable") }
	admitNothing := func(string, string, string) error { return nil }
	tests := []struct {
		name      string
		run       protocol.Run
		execution *protocol.DispatchExecution
		admit     admitTransport
		want      string
	}{
		{
			name: "plain run with a nil admit",
			run:  protocol.Run{ID: "run-one", HarnessID: "codex-cli"},
			want: "",
		},
		{
			name:  "plain run with an admitting admit",
			run:   protocol.Run{ID: "run-one", HarnessID: "codex-cli"},
			admit: admitNothing,
			want:  "",
		},
		{
			name:      "native execution",
			run:       protocol.Run{ID: "run-one", HarnessID: "codex-cli"},
			execution: &protocol.DispatchExecution{Transport: "native-cli"},
			admit:     admitNothing,
			want:      "",
		},
		{
			name:      "native run with a fallback transport",
			run:       protocol.Run{ID: "run-one", HarnessID: "codex-cli"},
			execution: &protocol.DispatchExecution{Transport: "native-cli", FallbackTransport: "native-cli"},
			admit:     admitNothing,
			want:      "unsupported execution: a fallback transport is only meaningful for an acp-v1 run",
		},
		{
			name:  "run-level acp transport with no execution object",
			run:   protocol.Run{ID: "run-one", HarnessID: "codex-cli", Transport: "acp-v1"},
			admit: admitNothing,
			want:  "",
		},
		{
			name:      "acp run whose admit fails",
			run:       protocol.Run{ID: "run-one", HarnessID: "codex-cli"},
			execution: &protocol.DispatchExecution{Transport: "acp-v1"},
			admit:     admitError,
			want:      "unsupported execution: acp-v1 transport not available on this Barista",
		},
		{
			name:      "acp run with no admit at all",
			run:       protocol.Run{ID: "run-one", HarnessID: "codex-cli"},
			execution: &protocol.DispatchExecution{Transport: "acp-v1"},
			want:      "unsupported execution: acp-v1 transport not available on this Barista",
		},
		{
			name:      "run and execution name different transports",
			run:       protocol.Run{ID: "run-one", HarnessID: "codex-cli", Transport: "acp-v1"},
			execution: &protocol.DispatchExecution{Transport: "native-cli"},
			admit:     admitNothing,
			want:      "unsupported execution: the run and its execution name different transports",
		},
		{
			name:      "unknown transport",
			run:       protocol.Run{ID: "run-one", HarnessID: "codex-cli", Transport: "carrier-pigeon"},
			execution: &protocol.DispatchExecution{Transport: "carrier-pigeon"},
			want:      "unsupported execution: unknown transport not available on this Barista",
		},
		{
			name:      "acp run falling back to acp",
			run:       protocol.Run{ID: "run-one", HarnessID: "codex-cli"},
			execution: &protocol.DispatchExecution{Transport: "acp-v1", FallbackTransport: "acp-v1"},
			admit:     admitNothing,
			want:      "unsupported execution: acp-v1 may only fall back to native-cli",
		},
		{
			name:      "acp run with an execution session binding",
			run:       protocol.Run{ID: "run-one", HarnessID: "codex-cli"},
			execution: &protocol.DispatchExecution{Transport: "acp-v1", SessionBinding: &protocol.DispatchSessionBinding{ID: "binding-one", ProviderSessionID: "provider-session-one"}},
			admit:     admitNothing,
			want:      "unsupported execution: the run's session binding is missing or names a different binding",
		},
		{
			name:  "acp run with a run-level session binding",
			run:   protocol.Run{ID: "run-one", HarnessID: "codex-cli", Transport: "acp-v1", SessionBindingID: "binding-one"},
			admit: admitNothing,
			want:  "unsupported execution: the run's session binding is missing or names a different binding",
		},
		{
			name:      "acp run with an execution workspace lease",
			run:       protocol.Run{ID: "run-one", HarnessID: "codex-cli"},
			execution: &protocol.DispatchExecution{Transport: "acp-v1", WorkspaceLease: &protocol.WorkspaceLeaseGrant{ID: "lease-one"}},
			admit:     admitNothing,
			want:      "unsupported execution: the workspace lease grant does not belong to the run",
		},
		{
			name:      "acp run with a matching lease grant this Barista cannot provision",
			run:       protocol.Run{ID: "run-one", HarnessID: "codex-cli", WorkspaceLeaseID: "lease-one", Workspace: "/srv/.coffee-shop/worktrees/lease-one", TaskID: "task-one"},
			execution: &protocol.DispatchExecution{Transport: "acp-v1", TaskID: "task-one", WorkspaceLease: &protocol.WorkspaceLeaseGrant{ID: "lease-one", Status: "requested", Policy: "git-worktree", Cleanup: "retain", Repository: "https://example.com/org/repo", Root: "/srv", SourcePath: "/srv/repo", BaseRevision: "refs/heads/main", Branch: "coffee-shop/task-one/run-one", WorktreePath: "/srv/.coffee-shop/worktrees/lease-one"}},
			admit:     admitNothing,
			want:      "unsupported execution: git-worktree workspace leases are not available on this Barista",
		},
		{
			name:  "acp run with a run-level workspace lease",
			run:   protocol.Run{ID: "run-one", HarnessID: "codex-cli", Transport: "acp-v1", WorkspaceLeaseID: "lease-one"},
			admit: admitNothing,
			want:  "unsupported execution: the run's workspace lease grant is missing or names a different lease",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			require.Equal(t, test.want, unsupportedExecutionReason(test.run, test.execution, test.admit, nil, nil))
		})
	}
}

func TestUnsupportedExecutionReasonPassesExactArgumentsToAdmitAndSkipsNativeRuns(t *testing.T) {
	type admitCall struct {
		harnessID         string
		transport         string
		fallbackTransport string
	}
	calls := []admitCall{}
	admit := func(harnessID, transport, fallbackTransport string) error {
		calls = append(calls, admitCall{harnessID: harnessID, transport: transport, fallbackTransport: fallbackTransport})
		return nil
	}

	run := protocol.Run{ID: "run-one", HarnessID: "codex-cli", Transport: "acp-v1"}
	execution := &protocol.DispatchExecution{Transport: "acp-v1", FallbackTransport: "native-cli"}
	require.Equal(t, "", unsupportedExecutionReason(run, execution, admit, nil, nil))
	require.Equal(t, []admitCall{{harnessID: "codex-cli", transport: "acp-v1", fallbackTransport: "native-cli"}}, calls)

	require.Equal(t, "", unsupportedExecutionReason(protocol.Run{ID: "run-two", HarnessID: "codex-cli", Transport: "native-cli"}, &protocol.DispatchExecution{Transport: "native-cli"}, admit, nil, nil))
	require.Equal(t, "", unsupportedExecutionReason(protocol.Run{ID: "run-three", HarnessID: "codex-cli"}, nil, admit, nil, nil))
	require.Len(t, calls, 1, "admit is a pre-execution guard and must never run for native dispatches")
}

// waitForDispatchMessage is waitForMessage with the longer deadline a full ACP dispatch needs.
func waitForDispatchMessage(t *testing.T, client *Client, messageType string) protocol.Outbound {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		for _, message := range outboundMessages(t, client) {
			if message.Type == messageType {
				return message
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", messageType)
	return protocol.Outbound{}
}

// messageIndexOf returns the outbox position of the first message of messageType, or -1.
func messageIndexOf(t *testing.T, client *Client, messageType string) int {
	t.Helper()
	for index, message := range outboundMessages(t, client) {
		if message.Type == messageType {
			return index
		}
	}
	return -1
}

// bridgeForDispatch starts the client's MCP bridge, which the ACP driver requires before it will
// send a prompt, and stops it when the test ends.
func bridgeForDispatch(t *testing.T, client *Client) {
	t.Helper()
	context_, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	require.NoError(t, client.bridge.Start(context_))
}

func TestDispatchRunsCodexThroughAcpEndToEnd(t *testing.T) {
	executable, err := os.Executable()
	require.NoError(t, err)
	directory := t.TempDir()
	record := filepath.Join(directory, "frames.jsonl")
	t.Cleanup(func() { acptest.KillDescendants(t, record) })
	runner := harness.NewRunner(nil).WithACP(harness.NewACPDriver(harness.ACPDriverOptions{
		Adapters: map[string]harness.ACPAdapter{"codex-cli": {
			Binary:      executable,
			Environment: acptest.Environment("codex-success", record),
			ID:          "codex-acp",
			Version:     acptest.CodexAdapterVersion,
			Source:      protocol.ACPAdapterSourceSetupLedger,
		}},
		RequestTimeout:    5 * time.Second,
		MCPConnectTimeout: 5 * time.Second,
	}))
	client := NewClient(config.Config{Concurrency: 1, WorkspaceRoots: []string{directory}}, protocol.ComputeNode{ID: "node-one"}, runner, emptyCapabilityReport)
	bridgeForDispatch(t, client)

	// The run itself carries no transport; only the execution object does, and dispatch must copy it.
	client.handle(context.Background(), protocol.Inbound{
		Type:      "dispatch",
		Run:       protocol.Run{ID: "run-acp", HarnessID: "codex-cli", Model: "default", Workspace: directory, Prompt: "fix"},
		Agent:     protocol.Agent{ID: "agent-one"},
		Execution: &protocol.DispatchExecution{Transport: "acp-v1"},
	})

	completed := waitForDispatchMessage(t, client, "run.completed")
	require.Equal(t, "run-acp", completed.RunID)
	require.Equal(t, "codex done", completed.Output)

	startedIndex := messageIndexOf(t, client, "run.started")
	require.NotEqual(t, -1, startedIndex)
	messages := outboundMessages(t, client)
	startedCount := 0
	for _, message := range messages {
		if message.Type == "run.started" {
			startedCount++
		}
	}
	require.Equal(t, 1, startedCount)
	started := messages[startedIndex]
	require.Equal(t, "run-acp", started.RunID)
	require.NotNil(t, started.Transport)
	require.Equal(t, "acp-v1", started.Transport.RequestedTransport)
	require.Equal(t, "acp-v1", started.Transport.SelectedTransport)
	require.NotNil(t, started.Transport.Adapter)
	require.Equal(t, "codex-acp", started.Transport.Adapter.ID)
	require.NotNil(t, started.Transport.ACP)
	require.Equal(t, acptest.CodexAdapterVersion, started.Transport.ACP.AdapterVersion)

	events := forwardedEvents(t, client)
	require.NotEmpty(t, events)
	for index, event := range events {
		require.Equal(t, int64(index+1), event.Sequence, "forwarded sequence must be contiguous")
		require.Equal(t, "run-acp", event.RunID)
	}
	require.Less(t, startedIndex, messageIndexOf(t, client, "harness.event"), "run.started precedes every harness event")
	for _, message := range messages {
		require.NotEqual(t, "run.failed", message.Type)
	}
	require.NotNil(t, acptest.ReceivedMethod(t, record, "session/set_config_option"))
}

func TestDispatchCannotChangeTheNodeApprovalPolicy(t *testing.T) {
	for _, test := range []struct {
		name     string
		policies harness.ApprovalPolicies
		injected string
		scenario string
		mode     string
		reported string
	}{
		{name: "manual node", policies: nil, injected: "bypass", scenario: "codex-success", mode: "read-only", reported: ""},
		{name: "auto node", policies: harness.ApprovalPolicies{"codex-cli": "auto"}, injected: "manual", scenario: "codex-agent", mode: "agent", reported: "auto"},
	} {
		t.Run(test.name, func(t *testing.T) {
			executable, err := os.Executable()
			require.NoError(t, err)
			directory := t.TempDir()
			record := filepath.Join(directory, "frames.jsonl")
			t.Cleanup(func() { acptest.KillDescendants(t, record) })
			runner := harness.NewRunner(nil).WithACP(harness.NewACPDriver(harness.ACPDriverOptions{
				Adapters: map[string]harness.ACPAdapter{"codex-cli": {
					Binary: executable, Environment: acptest.Environment(test.scenario, record),
					ID: "codex-acp", Version: acptest.CodexAdapterVersion, Source: protocol.ACPAdapterSourceSetupLedger,
				}},
				RequestTimeout:    5 * time.Second,
				MCPConnectTimeout: 5 * time.Second,
			})).WithApprovalPolicies(test.policies)
			client := NewClient(config.Config{Concurrency: 1, WorkspaceRoots: []string{directory}}, protocol.ComputeNode{ID: "node-one"}, runner, emptyCapabilityReport)
			bridgeForDispatch(t, client)

			// A hub that tries to choose the policy anywhere in the dispatch is ignored: no dispatch
			// field carries it, so it never reaches the runner.
			raw := fmt.Sprintf(`{"type":"dispatch","approvalPolicy":%[1]q,`+
				`"run":{"id":"run-policy","harnessId":"codex-cli","model":"default","workspace":%[2]q,"prompt":"fix","approvalPolicy":%[1]q,"mode":%[1]q},`+
				`"agent":{"id":"agent-one","approvalPolicy":%[1]q},`+
				`"execution":{"transport":"acp-v1","approvalPolicy":%[1]q}}`, test.injected, directory)
			inbound, err := protocol.DecodeInbound([]byte(raw))
			require.NoError(t, err)
			client.handle(context.Background(), inbound)

			waitForDispatchMessage(t, client, "run.completed")
			started := outboundMessages(t, client)[messageIndexOf(t, client, "run.started")]
			require.NotNil(t, started.Transport)
			require.Equal(t, test.reported, started.Transport.ApprovalPolicy)
			setOption := acptest.ReceivedMethod(t, record, "session/set_config_option")
			require.Equal(t, map[string]any{"sessionId": acptest.SessionID, "configId": "mode", "value": test.mode}, setOption["params"])
			require.Equal(t, test.mode, acptest.RecordedEnvironment(t, record)["INITIAL_AGENT_MODE"])
		})
	}
}

func TestSessionHoldsEventsUntilStartAndThenForwardsThemInOrder(t *testing.T) {
	client := newSessionClient()
	session := client.openSession("run-one")
	session.forward(messageDelta("run-one", "one "))
	session.forward(messageDelta("run-one", "two"))
	require.Empty(t, forwardedEvents(t, client))

	session.start(protocol.RunTransportSelection{RequestedTransport: protocol.TransportNativeCLI, SelectedTransport: protocol.TransportNativeCLI})
	messages := outboundMessages(t, client)
	require.Equal(t, "run.started", messages[0].Type)
	events := forwardedEvents(t, client)
	require.Equal(t, []string{"one ", "two"}, []string{events[0].Text, events[1].Text})
	require.Equal(t, int64(1), events[0].Sequence)
	require.Equal(t, int64(2), events[1].Sequence)

	session.forward(messageDelta("run-one", "three"))
	events = forwardedEvents(t, client)
	require.Len(t, events, 3)
	require.Equal(t, int64(3), events[2].Sequence)
}

func TestSessionDropsHeldEventsBeyondTheLimitAndReportsThemOnce(t *testing.T) {
	client := newSessionClient()
	session := client.openSession("run-one")
	for index := range heldEventLimit + 5 {
		session.forward(messageDelta("run-one", fmt.Sprintf("held %d", index)))
	}
	require.Empty(t, forwardedEvents(t, client))

	session.start(protocol.RunTransportSelection{RequestedTransport: protocol.TransportNativeCLI, SelectedTransport: protocol.TransportNativeCLI})
	deltas := []protocol.HarnessEvent{}
	warnings := []protocol.HarnessEvent{}
	for _, event := range forwardedEvents(t, client) {
		if event.Code == WarningEventsDropped {
			warnings = append(warnings, event)
		} else {
			deltas = append(deltas, event)
		}
	}
	require.Len(t, deltas, heldEventLimit)
	require.Len(t, warnings, 1)
	require.Contains(t, warnings[0].Message, "5 harness events")
	for index, event := range forwardedEvents(t, client) {
		require.Equal(t, int64(index+1), event.Sequence)
	}

	session.forward(messageDelta("run-one", "after start"))
	warningsAfter := 0
	for _, event := range forwardedEvents(t, client) {
		if event.Code == WarningEventsDropped {
			warningsAfter++
		}
	}
	require.Equal(t, 1, warningsAfter, "the drop is reported exactly once")
}

func TestSessionStartReportsOnlyOneRunStarted(t *testing.T) {
	client := newSessionClient()
	session := client.openSession("run-one")
	selection := protocol.RunTransportSelection{RequestedTransport: protocol.TransportNativeCLI, SelectedTransport: protocol.TransportNativeCLI}
	session.start(selection)
	session.start(selection)
	started := 0
	for _, message := range outboundMessages(t, client) {
		if message.Type == "run.started" {
			started++
		}
	}
	require.Equal(t, 1, started)
}

func TestSessionStartOmitsTheTransportOfAnInvalidSelection(t *testing.T) {
	client := newSessionClient()
	session := client.openSession("run-one")
	session.start(protocol.RunTransportSelection{RequestedTransport: "carrier-pigeon", SelectedTransport: "carrier-pigeon"})

	messages := outboundMessages(t, client)
	require.Len(t, messages, 1)
	require.Equal(t, "run.started", messages[0].Type)
	require.Nil(t, messages[0].Transport)
}

func TestSessionStartAfterCloseSendsNothing(t *testing.T) {
	client := newSessionClient()
	session := client.openSession("run-one")
	client.closeSession(session)
	session.start(protocol.RunTransportSelection{RequestedTransport: protocol.TransportNativeCLI, SelectedTransport: protocol.TransportNativeCLI})
	require.Empty(t, outboundMessages(t, client))
}

func TestDispatchFallsBackToNativeWhenTheAcpAdapterIsUnavailable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the native fixture is a shell script")
	}
	executable, err := os.Executable()
	require.NoError(t, err)
	directory := t.TempDir()
	nativeBinary := filepath.Join(directory, "codex")
	script := "#!/bin/sh\nprintf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"native done\"}}'\n"
	require.NoError(t, os.WriteFile(nativeBinary, []byte(script), 0o755))
	record := filepath.Join(directory, "frames.jsonl")
	t.Cleanup(func() { acptest.KillDescendants(t, record) })
	runner := harness.NewRunner([]protocol.HarnessProfile{{ID: "codex-cli", Binary: nativeBinary, Available: true}}).
		WithACP(harness.NewACPDriver(harness.ACPDriverOptions{
			Adapters: map[string]harness.ACPAdapter{"codex-cli": {
				Binary: executable,
				Verify: func() error { return errors.New("adapter executable no longer matches its pin") },
			}},
		})).
		WithNativeFallback("codex-cli")
	client := NewClient(config.Config{Concurrency: 1, WorkspaceRoots: []string{directory}}, protocol.ComputeNode{ID: "node-one"}, runner, emptyCapabilityReport)
	bridgeForDispatch(t, client)

	client.handle(context.Background(), protocol.Inbound{
		Type:      "dispatch",
		Run:       protocol.Run{ID: "run-fallback", HarnessID: "codex-cli", Model: "default", Workspace: directory, Prompt: "fix"},
		Agent:     protocol.Agent{ID: "agent-one"},
		Execution: &protocol.DispatchExecution{Transport: "acp-v1", FallbackTransport: "native-cli"},
	})

	completed := waitForDispatchMessage(t, client, "run.completed")
	require.Equal(t, "run-fallback", completed.RunID)
	require.Equal(t, "native done", completed.Output)

	startedIndex := messageIndexOf(t, client, "run.started")
	require.NotEqual(t, -1, startedIndex)
	started := outboundMessages(t, client)[startedIndex]
	require.NotNil(t, started.Transport)
	require.Equal(t, "acp-v1", started.Transport.RequestedTransport)
	require.Equal(t, "native-cli", started.Transport.SelectedTransport)
	require.Equal(t, protocol.FallbackACPAdapterUnavailable, started.Transport.FallbackReason)

	fallbackWarnings := []protocol.HarnessEvent{}
	for _, event := range forwardedEvents(t, client) {
		if event.Code == protocol.WarningTransportNativeFallback {
			fallbackWarnings = append(fallbackWarnings, event)
		}
	}
	require.Len(t, fallbackWarnings, 1)
	require.Less(t, startedIndex, messageIndexOf(t, client, "harness.event"), "the fallback warning is forwarded after run.started")
	for _, message := range outboundMessages(t, client) {
		require.NotEqual(t, "run.failed", message.Type)
	}
}

func TestDispatchWithoutFallbackPermissionRejectsAnUnavailableAcpAdapter(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the native fixture is a shell script")
	}
	executable, err := os.Executable()
	require.NoError(t, err)
	directory := t.TempDir()
	nativeBinary := filepath.Join(directory, "codex")
	require.NoError(t, os.WriteFile(nativeBinary, []byte("#!/bin/sh\n"), 0o755))
	runner := harness.NewRunner([]protocol.HarnessProfile{{ID: "codex-cli", Binary: nativeBinary, Available: true}}).
		WithACP(harness.NewACPDriver(harness.ACPDriverOptions{
			Adapters: map[string]harness.ACPAdapter{"codex-cli": {
				Binary: executable,
				Verify: func() error { return errors.New("adapter executable no longer matches its pin") },
			}},
		})).
		WithNativeFallback("codex-cli")
	client := NewClient(config.Config{Concurrency: 1, WorkspaceRoots: []string{directory}}, protocol.ComputeNode{ID: "node-one"}, runner, emptyCapabilityReport)

	client.handle(context.Background(), protocol.Inbound{
		Type:      "dispatch",
		Run:       protocol.Run{ID: "run-rejected", HarnessID: "codex-cli", Model: "default", Workspace: directory, Prompt: "fix"},
		Agent:     protocol.Agent{ID: "agent-one"},
		Execution: &protocol.DispatchExecution{Transport: "acp-v1"},
	})

	failed := waitForDispatchMessage(t, client, "run.failed")
	require.Equal(t, "run-rejected", failed.RunID)
	require.Equal(t, "unsupported execution: acp-v1 transport not available on this Barista", failed.Error)
	require.Equal(t, -1, messageIndexOf(t, client, "run.started"))
}
