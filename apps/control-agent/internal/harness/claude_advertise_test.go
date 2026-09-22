package harness

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp/acptest"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

// advertisingClaudeDriver builds an ACP driver whose claude-cli adapter replays scenario, pinned
// at the fake adapter's version, and returns the frame record path. It exercises the four
// "claude-probe*" scenarios defined in acptest/scenarios_claude.go, which the runtime tests in
// claude_acp_test.go and claude_acp_matrix_test.go never reach.
func advertisingClaudeDriver(t *testing.T, scenario string) (*ACPDriver, string) {
	t.Helper()
	executable, err := os.Executable()
	require.NoError(t, err)
	record := filepath.Join(t.TempDir(), "frames.jsonl")
	driver := NewACPDriver(ACPDriverOptions{
		Adapters: map[string]ACPAdapter{"claude-cli": {
			Binary: executable, Environment: acptest.Environment(scenario, record),
			ID: "claude-acp", Version: acptest.ClaudeAdapterVersion, Source: protocol.ACPAdapterSourceSetupLedger,
		}},
		NativeBinaries: map[string]string{"claude-cli": fakeClaudeNativeBinary},
		RequestTimeout: 5 * time.Second,
	})
	t.Cleanup(func() { acptest.KillDescendants(t, record) })
	return driver, record
}

func TestAdvertiseACPMergesVerifiedClaudeAdapterTransports(t *testing.T) {
	driver, record := advertisingClaudeDriver(t, "claude-probe-models")
	discovered := fakeNativeClaude(t)[0]
	discovered.Transports = []string{TransportNative}
	input := []protocol.HarnessProfile{discovered}

	advertised, failures := AdvertiseACP(context.Background(), input, driver)
	require.Empty(t, failures)
	profile := findProfile(advertised, "claude-cli")
	require.Equal(t, []string{TransportNative, TransportACP}, profile.Transports)
	require.True(t, profile.Available)
	require.NotNil(t, profile.ACP)
	require.Equal(t, acptest.ClaudeAdapterVersion, profile.ACP.AdapterVersion)
	require.True(t, profile.ACP.Mcp.HTTP)
	require.NoError(t, driver.Available("claude-cli"))

	original := findProfile(input, "claude-cli")
	require.Equal(t, []string{TransportNative}, original.Transports)
	require.Nil(t, original.ACP)

	require.Equal(t, fakeClaudeNativeBinary, acptest.RecordedEnvironment(t, record)["CLAUDE_CODE_EXECUTABLE"])
	require.Equal(t, []string{"default", acptest.ClaudeModel, acptest.ClaudeAlternateModel}, profile.Models)
	require.Empty(t, original.Models)
}

func TestAdvertiseACPAdvertisesClaudeACPWithoutTheNativeCLI(t *testing.T) {
	driver, _ := advertisingClaudeDriver(t, "claude-probe-models")
	input := []protocol.HarnessProfile{{
		ID: "claude-cli", Label: "Claude Code", Description: "Not installed",
		Available: false, Transports: []string{TransportNative},
	}}

	advertised, failures := AdvertiseACP(context.Background(), input, driver)
	require.Empty(t, failures)
	profile := findProfile(advertised, "claude-cli")
	require.Equal(t, []string{TransportACP}, profile.Transports)
	require.True(t, profile.Available)
	require.Equal(t, "ACP adapter "+acptest.ClaudeAdapterVersion, profile.Description)
	require.NotNil(t, profile.ACP)
	require.Equal(t, []string{"default", acptest.ClaudeModel, acptest.ClaudeAlternateModel}, profile.Models)
}

func TestAdvertiseACPReadsClaudeModelsFromAThrowawaySessionItCloses(t *testing.T) {
	driver, record := advertisingClaudeDriver(t, "claude-probe-models")
	input := []protocol.HarnessProfile{{ID: "claude-cli", Label: "Claude Code", Description: "Not installed", Models: []string{}, Transports: []string{TransportNative}}}
	advertised, failures := AdvertiseACP(context.Background(), input, driver)
	require.Empty(t, failures)
	require.Equal(t, []string{"default", acptest.ClaudeModel, acptest.ClaudeAlternateModel}, advertised[0].Models)

	sessionNew := acptest.ReceivedMethod(t, record, "session/new")
	require.NotNil(t, sessionNew)
	params := sessionNew["params"].(map[string]any)
	require.Equal(t, []any{}, params["mcpServers"], "the probe session never receives the Coffee Shop MCP server")
	require.True(t, filepath.IsAbs(params["cwd"].(string)))
	_, statErr := os.Stat(params["cwd"].(string))
	require.True(t, os.IsNotExist(statErr), "the probe's temporary directory is removed")
	require.NotNil(t, acptest.ReceivedMethod(t, record, "session/close"))
	require.Nil(t, acptest.ReceivedMethod(t, record, "session/prompt"))
}

func TestAdvertiseACPScreensClaudeAdapterModels(t *testing.T) {
	driver, _ := advertisingClaudeDriver(t, "claude-probe-unsafe-models")
	input := []protocol.HarnessProfile{{ID: "claude-cli", Label: "Claude Code", Transports: []string{TransportNative}}}
	advertised, failures := AdvertiseACP(context.Background(), input, driver)
	require.Empty(t, failures)
	require.Equal(t, []string{"default", acptest.ClaudeModel, "claude-haiku-4-5"}, advertised[0].Models)
}

func TestAdvertiseACPKeepsDefaultOnlyClaudeModelsWhenTheProbeCannotOpenASession(t *testing.T) {
	driver, _ := advertisingClaudeDriver(t, "claude-probe-authentication-required")
	input := []protocol.HarnessProfile{{ID: "claude-cli", Label: "Claude Code", Models: []string{}, Transports: []string{TransportNative}}}
	advertised, failures := AdvertiseACP(context.Background(), input, driver)
	require.Empty(t, failures, "an unauthenticated adapter is still advertised; its runs report auth-required")
	require.Equal(t, []string{TransportACP}, advertised[0].Transports)
	require.Empty(t, advertised[0].Models)
}

func TestAdvertiseACPDisablesClaudeAdaptersThatFailTheirProbe(t *testing.T) {
	for _, testCase := range []struct {
		scenario string
		target   error
	}{
		{scenario: "claude-no-http-mcp", target: acp.ErrMissingCapability},
		{scenario: "claude-version-mismatch", target: acp.ErrAdapterVersionMismatch},
	} {
		t.Run(testCase.scenario, func(t *testing.T) {
			driver, _ := advertisingClaudeDriver(t, testCase.scenario)
			input := []protocol.HarnessProfile{{
				ID: "claude-cli", Label: "Claude Code", Description: "Not installed",
				Available: false, Transports: []string{TransportNative},
			}}

			advertised, failures := AdvertiseACP(context.Background(), input, driver)
			require.ErrorIs(t, failures["claude-cli"], testCase.target)
			require.Equal(t, input, advertised)
			require.ErrorIs(t, driver.Available("claude-cli"), ErrDriverUnavailable)
		})
	}
}
