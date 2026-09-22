package harness

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp/acptest"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/mcpserver"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

const resumeDriverToken = "resume-run-scoped-token"

// resumeAdapter builds a policy-free driver and runner whose codex-cli adapter replays scenario.
// The same scenario also serves its own startup probe, which needs only the initialize answer.
func resumeAdapter(t *testing.T, scenario string) (*Runner, *ACPDriver, string) {
	t.Helper()
	executable, err := os.Executable()
	require.NoError(t, err)
	record := filepath.Join(t.TempDir(), "frames.jsonl")
	driver := NewACPDriver(ACPDriverOptions{
		Adapters:            map[string]ACPAdapter{"codex-cli": {Binary: executable, Environment: acptest.Environment(scenario, record)}},
		Providers:           map[string]ACPProvider{"codex-cli": {}},
		RequestTimeout:      5 * time.Second,
		PermissionTimeout:   time.Second,
		CancelGracePeriod:   time.Second,
		ShutdownGracePeriod: 2 * time.Second,
	})
	t.Cleanup(func() { acptest.KillDescendants(t, record) })
	return NewRunner(nil).WithACP(driver), driver, record
}

func TestSupportsResumeRequiresANegotiatedResumeOrLoadCapability(t *testing.T) {
	_, driver, _ := resumeAdapter(t, "resume-success")
	require.ErrorIs(t, driver.SupportsResume("codex-cli"), ErrResumeUnsupported, "before any probe")

	unsupported, unsupportedDriver, _ := resumeAdapter(t, "resume-unsupported")
	_, err := unsupportedDriver.Probe(context.Background(), "codex-cli")
	require.NoError(t, err)
	require.ErrorIs(t, unsupportedDriver.SupportsResume("codex-cli"), ErrResumeUnsupported)
	require.ErrorIs(t, unsupported.AdmitResume("codex-cli"), ErrResumeUnsupported)

	for _, scenario := range []string{"resume-success", "load-success"} {
		t.Run(scenario, func(t *testing.T) {
			runner, driver, _ := resumeAdapter(t, scenario)
			probe, err := driver.Probe(context.Background(), "codex-cli")
			require.NoError(t, err)
			require.True(t, probe.Capabilities.ResumeSession || probe.Capabilities.LoadSession)
			require.NoError(t, driver.SupportsResume("codex-cli"))
			require.NoError(t, runner.AdmitResume("codex-cli"))
		})
	}
}

func TestAdmitResumeRequiresAConfiguredAvailableAdapter(t *testing.T) {
	require.ErrorIs(t, NewRunner(nil).AdmitResume("codex-cli"), ErrDriverUnavailable, "no ACP driver is configured")

	directory := t.TempDir()
	driver := NewACPDriver(ACPDriverOptions{Adapters: map[string]ACPAdapter{"codex-cli": {Binary: filepath.Join(directory, "absent")}}})
	require.ErrorIs(t, NewRunner(nil).WithACP(driver).AdmitResume("codex-cli"), ErrDriverUnavailable)
}

// executeResume runs one invocation that asks to continue acptest.ResumedSessionID and records the
// order the driver reported the established session and the run start.
func executeResume(t *testing.T, scenario string, resume *SessionResume) ([]string, string) {
	t.Helper()
	runner, _, record := resumeAdapter(t, scenario)
	var mu sync.Mutex
	order := []string{}
	_, err := runner.Execute(context.Background(), Invocation{
		Run:       protocol.Run{ID: "run-resume", HarnessID: "codex-cli", Transport: TransportACP, Prompt: "fix the bug"},
		Agent:     protocol.Agent{ID: "agent-one", SystemPrompt: "You are a tester."},
		Workspace: t.TempDir(),
		MCP:       mcpserver.Config{URL: "http://127.0.0.1:9/mcp", Token: resumeDriverToken},
		Resume:    resume,
		Session: func(established EstablishedSession) {
			mu.Lock()
			defer mu.Unlock()
			order = append(order, fmt.Sprintf("session:%s:%t", established.ProviderSessionID, established.Resumed))
		},
		Started: func(protocol.RunTransportSelection) {
			mu.Lock()
			defer mu.Unlock()
			order = append(order, "started")
		},
	})
	require.NoError(t, err)
	return order, record
}

func promptedResumeText(t *testing.T, recordPath string) string {
	t.Helper()
	prompt := acptest.ReceivedMethod(t, recordPath, "session/prompt")
	require.NotNil(t, prompt)
	return prompt["params"].(map[string]any)["prompt"].([]any)[0].(map[string]any)["text"].(string)
}

func TestExecuteReportsTheResumedSessionBeforeTheRunStarts(t *testing.T) {
	order, record := executeResume(t, "resume-success", &SessionResume{ProviderSessionID: acptest.ResumedSessionID, Prompt: "continue the durable work"})
	require.Equal(t, []string{"session:" + acptest.ResumedSessionID + ":true", "started"}, order)

	resume := acptest.ReceivedMethod(t, record, "session/resume")
	require.NotNil(t, resume)
	require.Equal(t, acptest.ResumedSessionID, resume["params"].(map[string]any)["sessionId"])
	require.Nil(t, acptest.ReceivedMethod(t, record, "session/new"))
	text := promptedResumeText(t, record)
	require.Contains(t, text, "continue the durable work")
	require.NotContains(t, text, "fix the bug")
}

func TestExecuteReportsTheReplacementSessionWhenResumeIsRefused(t *testing.T) {
	order, record := executeResume(t, "resume-refused", &SessionResume{ProviderSessionID: acptest.ResumedSessionID, Prompt: "continue the durable work"})
	require.Equal(t, []string{"session:" + acptest.SessionID + ":false", "started"}, order)

	require.NotNil(t, acptest.ReceivedMethod(t, record, "session/resume"))
	require.NotNil(t, acptest.ReceivedMethod(t, record, "session/new"))
	text := promptedResumeText(t, record)
	require.Contains(t, text, "fix the bug")
	require.NotContains(t, text, "continue the durable work")
}
