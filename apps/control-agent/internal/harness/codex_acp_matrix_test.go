package harness

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp/acptest"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/mcpserver"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

// recordedRequests returns every recorded frame the fake adapter read for method, in order.
func recordedRequests(t *testing.T, record, method string) []map[string]any {
	t.Helper()
	requests := []map[string]any{}
	for _, frame := range acptest.Received(t, record) {
		if frame["method"] == method {
			requests = append(requests, frame)
		}
	}
	return requests
}

func TestCodexACPModelSelectionSendsModeThenModel(t *testing.T) {
	run := executeCodex(t, codexRunOptions{scenario: "codex-model", model: acptest.CodexAlternateModel})
	require.NoError(t, run.err)
	require.Equal(t, "codex done", run.result)

	selections := recordedRequests(t, run.record, "session/set_config_option")
	require.Len(t, selections, 2)
	require.Equal(t, map[string]any{"sessionId": acptest.SessionID, "configId": "mode", "value": "read-only"}, selections[0]["params"])
	require.Equal(t, map[string]any{"sessionId": acptest.SessionID, "configId": "model", "value": acptest.CodexAlternateModel}, selections[1]["params"])
}

func TestCodexACPModeAlreadySetSendsNoConfigOption(t *testing.T) {
	run := executeCodex(t, codexRunOptions{scenario: "codex-mode-already-set"})
	require.NoError(t, run.err)
	require.Equal(t, "codex done", run.result)
	require.Empty(t, recordedRequests(t, run.record, "session/set_config_option"))
}

func TestCodexACPDefaultModelKeepsTheAdapterConfiguredModel(t *testing.T) {
	for _, model := range []string{"default", ""} {
		t.Run("model "+model, func(t *testing.T) {
			run := executeCodex(t, codexRunOptions{scenario: "codex-success", model: model})
			require.NoError(t, run.err)
			selections := recordedRequests(t, run.record, "session/set_config_option")
			require.Len(t, selections, 1)
			require.Equal(t, "mode", selections[0]["params"].(map[string]any)["configId"])
		})
	}
}

func TestCodexACPModelNotOfferedFailsClosed(t *testing.T) {
	run := executeCodex(t, codexRunOptions{scenario: "codex-success", model: "gpt-9"})
	require.ErrorIs(t, run.err, acp.ErrConfigRejected)
	require.Nil(t, acptest.ReceivedMethod(t, run.record, "session/prompt"))
	require.Empty(t, run.selections)

	permitted := executeCodex(t, codexRunOptions{
		scenario: "codex-success", model: "gpt-9",
		native: fakeNativeCodex(t), fallbackTransport: TransportNative, operatorFallback: true,
	})
	require.ErrorIs(t, permitted.err, acp.ErrConfigRejected)
	require.Empty(t, permitted.selections)
	require.NotEqual(t, "native done", permitted.result)
}

func TestCodexACPModelRefusedNeverFallsBack(t *testing.T) {
	run := executeCodex(t, codexRunOptions{
		scenario: "codex-model-refused", model: acptest.CodexAlternateModel,
		native: fakeNativeCodex(t), fallbackTransport: TransportNative, operatorFallback: true,
	})
	require.ErrorIs(t, run.err, acp.ErrConfigRejected)
	require.Nil(t, acptest.ReceivedMethod(t, run.record, "session/prompt"))
	require.Empty(t, run.selections)
}

func TestCodexACPPolicyFailuresFallBackOnlyWhenPermitted(t *testing.T) {
	for _, scenario := range []string{"codex-no-config-options", "codex-mode-refused", "codex-mode-ignored"} {
		t.Run(scenario, func(t *testing.T) {
			denied := executeCodex(t, codexRunOptions{scenario: scenario})
			require.ErrorIs(t, denied.err, acp.ErrMissingCapability)
			require.Nil(t, acptest.ReceivedMethod(t, denied.record, "session/prompt"))
			require.Empty(t, denied.selections)

			permitted := executeCodex(t, codexRunOptions{
				scenario: scenario,
				native:   fakeNativeCodex(t), fallbackTransport: TransportNative, operatorFallback: true,
			})
			require.NoError(t, permitted.err)
			require.Equal(t, "native done", permitted.result)
			require.Len(t, permitted.selections, 1)
			require.Equal(t, TransportNative, permitted.selections[0].SelectedTransport)
			require.Equal(t, protocol.FallbackACPCapabilityMissing, permitted.selections[0].FallbackReason)
		})
	}
}

func TestCodexACPMCPConnectionTimeoutFallsBackOnlyWhenPermitted(t *testing.T) {
	denied := executeCodex(t, codexRunOptions{scenario: "codex-mcp-silent", mcpConnectTimeout: 200 * time.Millisecond})
	require.ErrorIs(t, denied.err, ErrMCPUnavailable)
	require.Nil(t, acptest.ReceivedMethod(t, denied.record, "session/prompt"))
	require.Empty(t, denied.selections)

	permitted := executeCodex(t, codexRunOptions{
		scenario: "codex-mcp-silent", mcpConnectTimeout: 200 * time.Millisecond,
		native: fakeNativeCodex(t), fallbackTransport: TransportNative, operatorFallback: true,
	})
	require.NoError(t, permitted.err)
	require.Equal(t, "native done", permitted.result)
	require.Len(t, permitted.selections, 1)
	require.Equal(t, protocol.FallbackACPMCPUnavailable, permitted.selections[0].FallbackReason)
}

func TestCodexACPProtocolIncompatibilitiesFallBackOnlyWhenPermitted(t *testing.T) {
	cases := []struct {
		scenario string
		target   error
	}{
		{scenario: "codex-version-mismatch", target: acp.ErrAdapterVersionMismatch},
		{scenario: "codex-protocol-mismatch", target: acp.ErrUnsupportedVersion},
		{scenario: "codex-exit-before-initialize", target: acp.ErrAdapterClosed},
	}
	for _, testCase := range cases {
		t.Run(testCase.scenario, func(t *testing.T) {
			denied := executeCodex(t, codexRunOptions{scenario: testCase.scenario})
			require.ErrorIs(t, denied.err, testCase.target)
			require.Nil(t, acptest.ReceivedMethod(t, denied.record, "session/prompt"))

			permitted := executeCodex(t, codexRunOptions{
				scenario: testCase.scenario,
				native:   fakeNativeCodex(t), fallbackTransport: TransportNative, operatorFallback: true,
			})
			require.NoError(t, permitted.err)
			require.Equal(t, "native done", permitted.result)
			require.Len(t, permitted.selections, 1)
			require.Equal(t, protocol.FallbackACPProtocolIncompatible, permitted.selections[0].FallbackReason)
		})
	}
}

func TestCodexACPAuthenticationRequiredNeverFallsBack(t *testing.T) {
	run := executeCodex(t, codexRunOptions{
		scenario: "codex-authentication-required",
		native:   fakeNativeCodex(t), fallbackTransport: TransportNative, operatorFallback: true,
	})
	require.ErrorIs(t, run.err, acp.ErrAuthenticationRequired)
	require.Contains(t, run.err.Error(), "chatgpt")
	require.NotContains(t, run.err.Error(), run.token)
	require.Empty(t, run.selections)
}

func TestCodexACPPostPromptFailuresNeverReplay(t *testing.T) {
	cases := []struct {
		scenario string
		target   error
	}{
		{scenario: "codex-crash-after-prompt", target: nil},
		{scenario: "codex-malformed-after-prompt", target: acp.ErrMalformedUpdate},
	}
	for _, testCase := range cases {
		t.Run(testCase.scenario, func(t *testing.T) {
			run := executeCodex(t, codexRunOptions{
				scenario: testCase.scenario,
				native:   fakeNativeCodex(t), fallbackTransport: TransportNative, operatorFallback: true,
			})
			require.Error(t, run.err)
			if testCase.target != nil {
				require.ErrorIs(t, run.err, testCase.target)
			}
			require.NotEqual(t, "native done", run.result)
			require.Len(t, run.selections, 1)
			require.Equal(t, TransportACP, run.selections[0].SelectedTransport)
		})
	}
}

func TestCodexACPCancellationNeverFallsBack(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	run := executeCodex(t, codexRunOptions{
		scenario: "codex-cancel", context: ctx,
		native: fakeNativeCodex(t), fallbackTransport: TransportNative, operatorFallback: true,
		onEvent: func(event protocol.HarnessEvent) {
			if event.Type == "message.delta" {
				cancel()
			}
		},
	})
	require.ErrorIs(t, run.err, acp.ErrCancelled)
	require.NotNil(t, acptest.ReceivedMethod(t, run.record, "session/cancel"))
	require.Len(t, run.selections, 1)
	require.Equal(t, TransportACP, run.selections[0].SelectedTransport)
}

func TestCodexACPRedactsTheRunScopedToken(t *testing.T) {
	run := executeCodex(t, codexRunOptions{scenario: "codex-secret-echo"})
	require.NoError(t, run.err)
	require.NotContains(t, run.result, run.token)
	for _, event := range run.events {
		require.NotContains(t, event.Text+event.Title+event.Detail, run.token)
	}
}

// executeCodexWithPermission mirrors executeCodex for scenarios whose approval flow must reach a
// Permission handler, with a driver-controlled permission timeout.
func executeCodexWithPermission(t *testing.T, scenario string, permission acp.PermissionHandler, permissionTimeout time.Duration) codexRun {
	t.Helper()
	executable, err := os.Executable()
	require.NoError(t, err)
	record := filepath.Join(t.TempDir(), "frames.jsonl")
	t.Cleanup(func() { acptest.KillDescendants(t, record) })
	bridgeContext, stopBridge := context.WithCancel(context.Background())
	t.Cleanup(stopBridge)
	bridge := mcpserver.New(nil, nil)
	require.NoError(t, bridge.Start(bridgeContext))
	workspace := t.TempDir()
	grant, err := bridge.Grant("run-codex-permission", workspace, false)
	require.NoError(t, err)

	driver := NewACPDriver(ACPDriverOptions{
		Adapters: map[string]ACPAdapter{"codex-cli": {
			Binary: executable, Environment: acptest.Environment(scenario, record),
			ID: "codex-acp", Version: acptest.CodexAdapterVersion, Source: protocol.ACPAdapterSourceSetupLedger,
		}},
		NativeBinaries:    map[string]string{"codex-cli": fakeCodexNativeBinary},
		RequestTimeout:    5 * time.Second,
		PermissionTimeout: permissionTimeout,
		CancelGracePeriod: 2 * time.Second,
		MCPConnectTimeout: 5 * time.Second,
	})
	runner := NewRunner(nil).WithACP(driver)

	var mu sync.Mutex
	outcome := codexRun{record: record, token: grant.Token}
	outcome.result, outcome.err = runner.Execute(context.Background(), Invocation{
		Run:        protocol.Run{ID: "run-codex-permission", HarnessID: "codex-cli", Transport: TransportACP, Prompt: "fix the bug"},
		Agent:      protocol.Agent{ID: "agent-one", SystemPrompt: "You are a tester."},
		Workspace:  workspace,
		MCP:        grant,
		Permission: permission,
		Events: func(event protocol.HarnessEvent) {
			mu.Lock()
			outcome.events = append(outcome.events, event)
			mu.Unlock()
		},
		Started: func(selection protocol.RunTransportSelection) {
			mu.Lock()
			defer mu.Unlock()
			outcome.selections = append(outcome.selections, selection)
		},
	})
	return outcome
}

func TestCodexACPPermissionDecisionsRouteThroughTheHandler(t *testing.T) {
	selected := func(optionID string) map[string]any {
		return map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": optionID}}
	}
	cases := []struct {
		name       string
		permission acp.PermissionHandler
		response   map[string]any
		status     string
		selected   string
	}{
		{
			name: "allow once",
			permission: func(context.Context, acp.PermissionRequest) (acp.PermissionDecision, error) {
				return acp.PermissionDecision{OptionID: "approved"}, nil
			},
			response: selected("approved"), status: "approved", selected: "approved",
		},
		{
			name: "allow always",
			permission: func(context.Context, acp.PermissionRequest) (acp.PermissionDecision, error) {
				return acp.PermissionDecision{OptionID: "approved-always"}, nil
			},
			response: selected("approved-always"), status: "approved", selected: "approved-always",
		},
		{
			name: "explicit rejection",
			permission: func(context.Context, acp.PermissionRequest) (acp.PermissionDecision, error) {
				return acp.PermissionDecision{OptionID: "abort"}, nil
			},
			response: selected("abort"), status: "rejected", selected: "abort",
		},
		{
			name: "empty choice falls back to rejection",
			permission: func(context.Context, acp.PermissionRequest) (acp.PermissionDecision, error) {
				return acp.PermissionDecision{}, nil
			},
			response: selected("abort"), status: "cancelled",
		},
		{
			name: "unoffered choice falls back to rejection",
			permission: func(context.Context, acp.PermissionRequest) (acp.PermissionDecision, error) {
				return acp.PermissionDecision{OptionID: "allow-everything"}, nil
			},
			response: selected("abort"), status: "cancelled",
		},
		{
			name: "handler timeout expires",
			permission: func(ctx context.Context, _ acp.PermissionRequest) (acp.PermissionDecision, error) {
				<-ctx.Done()
				return acp.PermissionDecision{OptionID: "approved"}, nil
			},
			response: selected("abort"), status: "expired",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			run := executeCodexWithPermission(t, "codex-permission", testCase.permission, 300*time.Millisecond)
			require.NoError(t, run.err)
			require.Equal(t, "after permission", run.result)

			response := acptest.ReceivedResponse(t, run.record, "permission-1")
			require.NotNil(t, response)
			require.Equal(t, testCase.response, response["result"])

			resolved := []protocol.HarnessEvent{}
			requested := []protocol.HarnessEvent{}
			for _, event := range run.events {
				switch event.Type {
				case "permission.resolved":
					resolved = append(resolved, event)
				case "permission.requested":
					requested = append(requested, event)
				}
			}
			require.Len(t, requested, 1)
			require.Len(t, resolved, 1)
			require.Equal(t, requested[0].ApprovalID, resolved[0].ApprovalID)
			require.Equal(t, testCase.status, resolved[0].Status)
			require.Equal(t, testCase.selected, resolved[0].SelectedOptionID)
		})
	}
}

func TestCodexACPAdapterVerificationFailureFallsBackOrFails(t *testing.T) {
	executable, err := os.Executable()
	require.NoError(t, err)
	newRunner := func() *Runner {
		driver := NewACPDriver(ACPDriverOptions{
			Adapters: map[string]ACPAdapter{"codex-cli": {
				Binary: executable,
				Verify: func() error { return errors.New("adapter content changed since verification") },
			}},
			RequestTimeout: time.Second,
		})
		return NewRunner(fakeNativeCodex(t)).WithACP(driver).WithNativeFallback("codex-cli")
	}

	_, denied := newRunner().Execute(context.Background(), Invocation{
		Run:       protocol.Run{ID: "run-denied", HarnessID: "codex-cli", Transport: TransportACP, Prompt: "fix"},
		Workspace: t.TempDir(),
	})
	require.ErrorIs(t, denied, ErrDriverUnavailable)

	var mu sync.Mutex
	var events []protocol.HarnessEvent
	var order []string
	result, err := newRunner().Execute(context.Background(), Invocation{
		Run:               protocol.Run{ID: "run-fallback", HarnessID: "codex-cli", Transport: TransportACP, Prompt: "fix"},
		Workspace:         t.TempDir(),
		FallbackTransport: TransportNative,
		Events: func(event protocol.HarnessEvent) {
			mu.Lock()
			events = append(events, event)
			order = append(order, "event:"+event.Code)
			mu.Unlock()
		},
		Started: func(selection protocol.RunTransportSelection) {
			mu.Lock()
			order = append(order, "started:"+selection.SelectedTransport+":"+selection.FallbackReason)
			mu.Unlock()
		},
	})
	require.NoError(t, err)
	require.Equal(t, "native done", result)
	mu.Lock()
	require.Len(t, events, 1)
	warning := events[0]
	require.Equal(t, []string{
		"event:" + protocol.WarningTransportNativeFallback,
		"started:" + TransportNative + ":" + protocol.FallbackACPAdapterUnavailable,
	}, order)
	mu.Unlock()
	require.Equal(t, "warning", warning.Type)
	require.Equal(t, "run-fallback", warning.RunID)
	require.Equal(t, protocol.WarningTransportNativeFallback, warning.Code)
	require.Contains(t, warning.Message, protocol.FallbackACPAdapterUnavailable)
}
