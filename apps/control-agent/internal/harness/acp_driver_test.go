package harness

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp/acptest"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/mcpserver"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

const driverTestToken = "driver-run-scoped-token"

type driverRun struct {
	result string
	err    error
	chunks []string
	events []protocol.HarnessEvent
	record string
}

func fakeAdapterDriver(t *testing.T, scenario string, cancelGrace time.Duration) (*Runner, string) {
	t.Helper()
	executable, err := os.Executable()
	require.NoError(t, err)
	record := filepath.Join(t.TempDir(), "frames.jsonl")
	driver := NewACPDriver(ACPDriverOptions{
		Adapters:            map[string]ACPAdapter{"codex-cli": {Binary: executable, Environment: acptest.Environment(scenario, record)}},
		RequestTimeout:      5 * time.Second,
		PermissionTimeout:   time.Second,
		CancelGracePeriod:   cancelGrace,
		ShutdownGracePeriod: 2 * time.Second,
	})
	t.Cleanup(func() { acptest.KillDescendants(t, record) })
	return NewRunner(nil).WithACP(driver), record
}

func executeScenario(t *testing.T, ctx context.Context, scenario string, cancelGrace time.Duration, onEvent func(protocol.HarnessEvent)) driverRun {
	t.Helper()
	runner, record := fakeAdapterDriver(t, scenario, cancelGrace)
	var mu sync.Mutex
	run := driverRun{record: record}
	run.result, run.err = runner.Execute(ctx, Invocation{
		Run:       protocol.Run{ID: "run-driver", HarnessID: "codex-cli", Transport: TransportACP, Prompt: "fix the bug"},
		Agent:     protocol.Agent{ID: "agent-one", SystemPrompt: "You are a tester."},
		Workspace: t.TempDir(),
		MCP:       mcpserver.Config{URL: "http://127.0.0.1:9/mcp", Token: driverTestToken},
		Output: func(chunk string) {
			mu.Lock()
			defer mu.Unlock()
			run.chunks = append(run.chunks, chunk)
		},
		Events: func(event protocol.HarnessEvent) {
			mu.Lock()
			run.events = append(run.events, event)
			mu.Unlock()
			if onEvent != nil {
				onEvent(event)
			}
		},
	})
	return run
}

func TestACPDriverCompletesRunAndStreamsOutput(t *testing.T) {
	run := executeScenario(t, context.Background(), "success", time.Second, nil)
	require.NoError(t, run.err)
	require.Equal(t, "Hello world", run.result)
	require.Equal(t, []string{"Hello ", "world"}, run.chunks)
	require.Len(t, run.events, 2)

	sessionNew := acptest.ReceivedMethod(t, run.record, "session/new")
	params := sessionNew["params"].(map[string]any)
	cwd := params["cwd"].(string)
	require.True(t, filepath.IsAbs(cwd))
	resolved, err := filepath.EvalSymlinks(cwd)
	require.NoError(t, err)
	require.Equal(t, resolved, cwd)
	server := params["mcpServers"].([]any)[0].(map[string]any)
	require.Equal(t, mcpServerName, server["name"])
	require.Equal(t, []any{map[string]any{"name": "Authorization", "value": "Bearer " + driverTestToken}}, server["headers"])

	prompt := acptest.ReceivedMethod(t, run.record, "session/prompt")
	text := prompt["params"].(map[string]any)["prompt"].([]any)[0].(map[string]any)["text"].(string)
	require.Contains(t, text, "You are a tester.")
	require.Contains(t, text, "fix the bug")
}

func TestACPDriverIsUnavailableWithoutAnExecutableAdapter(t *testing.T) {
	directory := t.TempDir()
	notExecutable := filepath.Join(directory, "adapter")
	require.NoError(t, os.WriteFile(notExecutable, []byte("#!/bin/sh\n"), 0o644))
	cases := map[string]ACPAdapter{
		"missing":        {Binary: filepath.Join(directory, "absent")},
		"relative":       {Binary: "codex-acp"},
		"directory":      {Binary: directory},
		"not executable": {Binary: notExecutable},
	}
	for name, adapter := range cases {
		t.Run(name, func(t *testing.T) {
			if name == "not executable" && runtime.GOOS == "windows" {
				t.Skip("Windows has no executable permission bit")
			}
			runner := NewRunner(nil).WithACP(NewACPDriver(ACPDriverOptions{Adapters: map[string]ACPAdapter{"codex-cli": adapter}}))
			_, err := runner.Execute(context.Background(), Invocation{Run: protocol.Run{ID: "run", HarnessID: "codex-cli", Transport: TransportACP}, Workspace: directory})
			require.ErrorIs(t, err, ErrDriverUnavailable)
		})
	}
	t.Run("unconfigured harness", func(t *testing.T) {
		driver := NewACPDriver(ACPDriverOptions{})
		require.ErrorIs(t, driver.Available("claude-cli"), ErrDriverUnavailable)
	})
}

func TestRunnerSelectsDriverByTransport(t *testing.T) {
	runner := NewRunner(nil)
	_, err := runner.Execute(context.Background(), Invocation{Run: protocol.Run{HarnessID: "codex-cli", Transport: TransportACP}})
	require.ErrorIs(t, err, ErrDriverUnavailable)
	_, err = runner.Execute(context.Background(), Invocation{Run: protocol.Run{HarnessID: "codex-cli", Transport: "carrier-pigeon"}})
	require.ErrorIs(t, err, ErrDriverUnavailable)
	_, err = runner.Execute(context.Background(), Invocation{Run: protocol.Run{HarnessID: "codex-cli", Transport: TransportNative}})
	require.ErrorContains(t, err, "not installed")
}

func TestACPDriverCancelsCooperatively(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started := time.Now()
	run := executeScenario(t, ctx, "cancel-cooperative", 10*time.Second, func(event protocol.HarnessEvent) {
		if event.Type == "message.delta" {
			cancel()
		}
	})
	require.ErrorIs(t, run.err, acp.ErrCancelled)
	require.Less(t, time.Since(started), 8*time.Second)
	require.NotNil(t, acptest.ReceivedMethod(t, run.record, "session/cancel"))
}

func TestACPDriverReportsBoundedRedactedStderrOnPrematureExit(t *testing.T) {
	run := executeScenario(t, context.Background(), "stderr-token-exit", time.Second, nil)
	require.ErrorIs(t, run.err, acp.ErrAdapterClosed)
	require.Contains(t, run.err.Error(), adapterStderrSeparator)
	require.Contains(t, run.err.Error(), "Bearer [redacted]")
	require.NotContains(t, run.err.Error(), driverTestToken)
	require.LessOrEqual(t, len(run.err.Error()), 2*acp.MaximumDiagnosticBytes+len(adapterStderrSeparator))
}

func TestACPDriverTerminatesAdapterOnStdoutContamination(t *testing.T) {
	started := time.Now()
	run := executeScenario(t, context.Background(), "stdout-contamination", time.Second, nil)
	require.ErrorIs(t, run.err, acp.ErrStdoutContamination)
	require.Less(t, time.Since(started), 8*time.Second)
}

func TestACPDriverRedactsSecretsFromOutputAndEvents(t *testing.T) {
	run := executeScenario(t, context.Background(), "secret-echo", time.Second, nil)
	require.NoError(t, run.err)
	require.NotContains(t, run.result, driverTestToken)
	require.NotContains(t, strings.Join(run.chunks, ""), driverTestToken)
	for _, event := range run.events {
		require.NotContains(t, event.Text+event.Title, driverTestToken)
	}
}

func TestAdapterEnvironmentDropsBaristaCredentials(t *testing.T) {
	environment := adapterEnvironment(
		[]string{"PATH=/usr/bin", "COFFEE_SHOP_TOKEN=hub-secret", "coffee_shop_mcp_token=run-secret", "HOME=/home/barista"},
		[]string{"ADAPTER_MODE=test"},
	)
	require.Equal(t, []string{"PATH=/usr/bin", "HOME=/home/barista", "ADAPTER_MODE=test"}, environment)
}
