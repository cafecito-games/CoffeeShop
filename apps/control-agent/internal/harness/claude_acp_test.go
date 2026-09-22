package harness

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp/acptest"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/mcpserver"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

// claudeRun is the observable outcome of one claude-agent-acp invocation against the fake adapter.
type claudeRun struct {
	result     string
	err        error
	events     []protocol.HarnessEvent
	selections []protocol.RunTransportSelection
	record     string
	token      string
}

type claudeRunOptions struct {
	scenario          string
	model             string
	native            []protocol.HarnessProfile
	fallbackTransport string
	operatorFallback  bool
	mcpConnectTimeout time.Duration
	context           context.Context
	onEvent           func(protocol.HarnessEvent)
}

// fakeClaudeNativeBinary is the native CLI path Barista passes to claude-agent-acp as
// CLAUDE_CODE_EXECUTABLE.
const fakeClaudeNativeBinary = "/opt/claude/bin/claude"

// executeClaude runs the claude-cli harness over ACP with the compiled-in claude provider policy,
// a fake adapter pinned at the fake's version, and a real run-scoped MCP bridge grant.
func executeClaude(t *testing.T, options claudeRunOptions) claudeRun {
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
	grant, err := bridge.Grant("run-claude", workspace, false)
	require.NoError(t, err)

	timeout := options.mcpConnectTimeout
	if timeout == 0 {
		timeout = 5 * time.Second
	}
	driver := NewACPDriver(ACPDriverOptions{
		Adapters: map[string]ACPAdapter{"claude-cli": {
			Binary: executable, Environment: acptest.Environment(options.scenario, record),
			ID: "claude-acp", Version: acptest.ClaudeAdapterVersion, Source: protocol.ACPAdapterSourceSetupLedger,
		}},
		NativeBinaries:    map[string]string{"claude-cli": fakeClaudeNativeBinary},
		RequestTimeout:    5 * time.Second,
		PermissionTimeout: 2 * time.Second,
		CancelGracePeriod: 2 * time.Second,
		MCPConnectTimeout: timeout,
	})
	runner := NewRunner(options.native).WithACP(driver)
	if options.operatorFallback {
		runner.WithNativeFallback("claude-cli")
	}
	ctx := options.context
	if ctx == nil {
		ctx = context.Background()
	}
	var mu sync.Mutex
	outcome := claudeRun{record: record, token: grant.Token}
	outcome.result, outcome.err = runner.Execute(ctx, Invocation{
		Run:               protocol.Run{ID: "run-claude", HarnessID: "claude-cli", Transport: TransportACP, Model: options.model, Prompt: "fix the bug"},
		Agent:             protocol.Agent{ID: "agent-one", SystemPrompt: "You are a tester."},
		Workspace:         workspace,
		MCP:               grant,
		FallbackTransport: options.fallbackTransport,
		Events: func(event protocol.HarnessEvent) {
			mu.Lock()
			outcome.events = append(outcome.events, event)
			mu.Unlock()
			if options.onEvent != nil {
				options.onEvent(event)
			}
		},
		Started: func(selection protocol.RunTransportSelection) {
			mu.Lock()
			defer mu.Unlock()
			outcome.selections = append(outcome.selections, selection)
		},
	})
	return outcome
}

func TestClaudeACPRunAppliesPolicyWaitsForMCPAndReportsItsSelection(t *testing.T) {
	run := executeClaude(t, claudeRunOptions{scenario: "claude-success", model: "default"})
	require.NoError(t, run.err)
	require.Equal(t, "claude done", run.result)

	setOption := acptest.ReceivedMethod(t, run.record, "session/set_config_option")
	require.NotNil(t, setOption)
	require.Equal(t, map[string]any{"sessionId": acptest.SessionID, "configId": "mode", "value": "default"}, setOption["params"])

	environment := acptest.RecordedEnvironment(t, run.record)
	require.Equal(t, fakeClaudeNativeBinary, environment["CLAUDE_CODE_EXECUTABLE"])
	require.Equal(t, acptest.UnsetEnvironmentValue, environment["COFFEE_SHOP_TOKEN"])
	require.Equal(t, acptest.UnsetEnvironmentValue, environment["COFFEE_SHOP_MCP_TOKEN"])

	require.Len(t, run.selections, 1)
	selection := run.selections[0]
	require.NoError(t, selection.Validate())
	require.Equal(t, TransportACP, selection.RequestedTransport)
	require.Equal(t, TransportACP, selection.SelectedTransport)
	require.Empty(t, selection.FallbackReason)
	require.Equal(t, &protocol.ACPAdapterProvenance{ID: "claude-acp", Version: acptest.ClaudeAdapterVersion, Source: protocol.ACPAdapterSourceSetupLedger}, selection.Adapter)
	require.NotNil(t, selection.ACP)
	require.Equal(t, acptest.ClaudeAdapterVersion, selection.ACP.AdapterVersion)
	require.True(t, selection.ACP.Mcp.HTTP)
	require.True(t, selection.ACP.ResumeSession)
}

// fakeNativeClaude installs a shell script standing in for the native Claude CLI and returns its
// discovered profile. Its output is one native stream-json result line, the shape the real
// claude-cli parser in runner.go consumes.
func fakeNativeClaude(t *testing.T) []protocol.HarnessProfile {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the native fixture is a shell script")
	}
	binary := filepath.Join(t.TempDir(), "claude")
	script := "#!/bin/sh\nprintf '%s\\n' '{\"type\":\"result\",\"result\":\"native done\"}'\n"
	require.NoError(t, os.WriteFile(binary, []byte(script), 0o755))
	return []protocol.HarnessProfile{{ID: "claude-cli", Binary: binary, Available: true, Description: "claude-cli 2.5.0"}}
}

func TestClaudeACPFallsBackToNativeBeforeThePromptOnlyWhenPermitted(t *testing.T) {
	run := executeClaude(t, claudeRunOptions{scenario: "claude-no-http-mcp", native: fakeNativeClaude(t), fallbackTransport: TransportNative, operatorFallback: true})
	require.NoError(t, run.err)
	require.Equal(t, "native done", run.result)
	require.Len(t, run.selections, 1)
	require.Equal(t, protocol.RunTransportSelection{
		RequestedTransport: TransportACP, SelectedTransport: TransportNative, FallbackReason: protocol.FallbackACPCapabilityMissing, HarnessVersion: "2.5.0",
		Adapter: &protocol.ACPAdapterProvenance{ID: "claude-acp", Version: acptest.ClaudeAdapterVersion, Source: protocol.ACPAdapterSourceSetupLedger},
	}, run.selections[0])
	require.NoError(t, run.selections[0].Validate())
	require.NotEmpty(t, run.events)
	warning := run.events[len(run.events)-1]
	require.Equal(t, "warning", warning.Type)
	require.Equal(t, protocol.WarningTransportNativeFallback, warning.Code)
	require.Contains(t, warning.Message, protocol.FallbackACPCapabilityMissing)

	forbidden := executeClaude(t, claudeRunOptions{scenario: "claude-no-http-mcp", native: fakeNativeClaude(t), operatorFallback: true})
	require.ErrorIs(t, forbidden.err, acp.ErrMissingCapability)
	require.Empty(t, forbidden.selections)
}

func TestClaudeSessionConfiguration(t *testing.T) {
	modeOnly := []acp.ConfigSelection{{ID: "mode", Value: "default", Requirement: acp.ConfigPolicy}}
	for _, testCase := range []struct {
		model    string
		expected []acp.ConfigSelection
	}{
		{model: "", expected: modeOnly},
		{model: "default", expected: modeOnly},
		{model: acptest.ClaudeAlternateModel, expected: []acp.ConfigSelection{
			{ID: "mode", Value: "default", Requirement: acp.ConfigPolicy},
			{ID: "model", Value: acptest.ClaudeAlternateModel, Requirement: acp.ConfigRequested},
		}},
	} {
		t.Run("model "+testCase.model, func(t *testing.T) {
			require.Equal(t, testCase.expected, claudeSessionConfiguration(protocol.Run{Model: testCase.model}))
		})
	}
}

func TestClaudeACPAuthGateRequiresAnExplicitMode(t *testing.T) {
	for _, mode := range []string{"", "trust-me", "subscription", "API"} {
		t.Run("mode "+mode, func(t *testing.T) {
			authMode, err := ClaudeACPAuthGate(mode, nil)
			require.ErrorIs(t, err, ErrClaudeACPAuthModeNotConfigured)
			require.Empty(t, authMode)
		})
	}
}

func TestClaudeACPAuthGateLocalSubscriptionRejectsEveryBillingSwitchingVariable(t *testing.T) {
	require.NotEmpty(t, ClaudeACPBillingSwitchingVariables)
	for _, variable := range ClaudeACPBillingSwitchingVariables {
		t.Run(variable, func(t *testing.T) {
			environment := []string{"PATH=/usr/bin", variable + "=super-secret-value"}
			authMode, err := ClaudeACPAuthGate(ClaudeACPAuthModeLocalSubscription, environment)
			require.ErrorIs(t, err, ErrClaudeACPBillingVariablePresent)
			require.Contains(t, err.Error(), variable)
			require.NotContains(t, err.Error(), "super-secret-value")
			require.Empty(t, authMode)
		})
	}
}

func TestClaudeACPAuthGateLocalSubscriptionAllowsACleanEnvironment(t *testing.T) {
	authMode, err := ClaudeACPAuthGate(ClaudeACPAuthModeLocalSubscription, []string{"PATH=/usr/bin", "HOME=/home/operator"})
	require.NoError(t, err)
	require.Equal(t, ClaudeACPAuthModeLocalSubscription, authMode)
}

func TestClaudeACPAuthGateAPIModeAllowsBillingSwitchingVariables(t *testing.T) {
	for _, variable := range ClaudeACPBillingSwitchingVariables {
		authMode, err := ClaudeACPAuthGate(ClaudeACPAuthModeAPI, []string{variable + "=value"})
		require.NoError(t, err)
		require.Equal(t, ClaudeACPAuthModeAPI, authMode)
	}
}
