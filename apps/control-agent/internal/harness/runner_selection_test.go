package harness

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp/acptest"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/mcpserver"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

func TestRunnerAdmitReportsTransportAvailability(t *testing.T) {
	executable, err := os.Executable()
	require.NoError(t, err)

	plain := NewRunner(nil)
	require.NoError(t, plain.Admit("codex-cli", "", ""))
	require.NoError(t, plain.Admit("codex-cli", TransportNative, TransportNative))
	require.ErrorIs(t, plain.Admit("codex-cli", "carrier-pigeon", ""), ErrDriverUnavailable)
	require.ErrorIs(t, plain.Admit("codex-cli", TransportACP, ""), ErrDriverUnavailable)

	verified := NewACPDriver(ACPDriverOptions{Adapters: map[string]ACPAdapter{"codex-cli": {Binary: executable}}})
	require.NoError(t, NewRunner(nil).WithACP(verified).Admit("codex-cli", TransportACP, ""))

	failing := NewACPDriver(ACPDriverOptions{Adapters: map[string]ACPAdapter{"codex-cli": {
		Binary: executable,
		Verify: func() error { return errors.New("adapter content changed since verification") },
	}}})
	for _, testCase := range []struct {
		name    string
		runner  *Runner
		permit  string
		message string
	}{
		{
			name:    "dispatch forbids fallback",
			runner:  NewRunner(fakeNativeCodex(t)).WithACP(failing).WithNativeFallback("codex-cli"),
			permit:  "",
			message: "the dispatch did not permit native fallback",
		},
		{
			name:    "operator did not opt in",
			runner:  NewRunner(fakeNativeCodex(t)).WithACP(failing),
			permit:  TransportNative,
			message: "the operator did not opt into native fallback",
		},
		{
			name:    "native profile missing",
			runner:  NewRunner(nil).WithACP(failing).WithNativeFallback("codex-cli"),
			permit:  TransportNative,
			message: "no discovered native CLI can serve the fallback",
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			require.ErrorIs(t, testCase.runner.Admit("codex-cli", TransportACP, testCase.permit), ErrDriverUnavailable, testCase.message)
		})
	}

	permitted := NewRunner(fakeNativeCodex(t)).WithACP(failing).WithNativeFallback("codex-cli")
	require.NoError(t, permitted.Admit("codex-cli", TransportACP, TransportNative))
}

// nativeScriptProfile installs a shell script standing in for the native Codex CLI and returns its
// profile carrying the given discovered description.
func nativeScriptProfile(t *testing.T, description string) protocol.HarnessProfile {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the native fixture is a shell script")
	}
	binary := filepath.Join(t.TempDir(), "codex")
	script := "#!/bin/sh\nprintf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"native done\"}}'\n"
	require.NoError(t, os.WriteFile(binary, []byte(script), 0o755))
	return protocol.HarnessProfile{ID: "codex-cli", Binary: binary, Available: true, Description: description}
}

func TestNativeRunReportsStartedOnceWithDiscoveredVersion(t *testing.T) {
	for _, testCase := range []struct {
		name        string
		description string
		version     string
	}{
		{name: "versioned description", description: "codex-cli 0.154.0", version: "0.154.0"},
		{name: "description without a version", description: "Installed", version: ""},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			runner := NewRunner([]protocol.HarnessProfile{nativeScriptProfile(t, testCase.description)})
			var selections []protocol.RunTransportSelection
			result, err := runner.Execute(context.Background(), Invocation{
				Run:       protocol.Run{ID: "run-native", HarnessID: "codex-cli", Transport: TransportNative, Prompt: "fix"},
				Workspace: t.TempDir(),
				Started:   func(selection protocol.RunTransportSelection) { selections = append(selections, selection) },
			})
			require.NoError(t, err)
			require.Equal(t, "native done", result)
			require.Equal(t, []protocol.RunTransportSelection{{
				RequestedTransport: TransportNative,
				SelectedTransport:  TransportNative,
				HarnessVersion:     testCase.version,
			}}, selections)
			require.NoError(t, selections[0].Validate())
		})
	}
}

func TestNormalizedHarnessVersion(t *testing.T) {
	for _, testCase := range []struct {
		description string
		expected    string
	}{
		{description: "codex-cli 0.154.0", expected: "0.154.0"},
		{description: "claude 2.1.3 (Claude Code)", expected: "2.1.3"},
		{description: "Installed", expected: ""},
		{description: "v01.2", expected: ""},
	} {
		t.Run(testCase.description, func(t *testing.T) {
			version := normalizedHarnessVersion(testCase.description)
			require.Equal(t, testCase.expected, version)
			require.True(t, version == "" || protocol.IsNormalizedVersion(version))
		})
	}

	// The first dotted match in "1.2.3.4.5" is not a normalized version, so it is dropped whole.
	first := harnessVersionPattern.FindString("1.2.3.4.5")
	require.False(t, protocol.IsNormalizedVersion(first))
	require.Equal(t, "", normalizedHarnessVersion("1.2.3.4.5"))
}

func TestFallbackReasonClassifiesPrePromptFailures(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		cause  error
		reason string
	}{
		{name: "cancelled", cause: acp.ErrCancelled, reason: ""},
		{name: "cancel grace expired", cause: acp.ErrCancelGraceExpired, reason: ""},
		{name: "authentication required", cause: acp.ErrAuthenticationRequired, reason: ""},
		{name: "config rejected", cause: acp.ErrConfigRejected, reason: ""},
		{name: "mcp unavailable", cause: ErrMCPUnavailable, reason: protocol.FallbackACPMCPUnavailable},
		{name: "capability missing", cause: acp.ErrMissingCapability, reason: protocol.FallbackACPCapabilityMissing},
		{name: "unsupported version", cause: acp.ErrUnsupportedVersion, reason: protocol.FallbackACPProtocolIncompatible},
		{name: "adapter version mismatch", cause: acp.ErrAdapterVersionMismatch, reason: protocol.FallbackACPProtocolIncompatible},
		{name: "protocol violation", cause: acp.ErrProtocolViolation, reason: protocol.FallbackACPProtocolIncompatible},
		{name: "adapter closed", cause: acp.ErrAdapterClosed, reason: protocol.FallbackACPProtocolIncompatible},
		{name: "driver unavailable", cause: ErrDriverUnavailable, reason: protocol.FallbackACPAdapterUnavailable},
		{name: "other failure", cause: errors.New("other"), reason: ""},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			require.Equal(t, testCase.reason, FallbackReason(fmt.Errorf("wrapping: %w", testCase.cause)))
		})
	}
	require.Equal(t, "", FallbackReason(nil))

	// A cancellation alongside a protocol failure still fails the run rather than falling back.
	combined := fmt.Errorf("%w: %w", acp.ErrCancelled, acp.ErrProtocolViolation)
	require.Equal(t, "", FallbackReason(combined))
}

// advertisingDriver builds an ACP driver whose codex-cli adapter replays scenario, pinned at the
// fake adapter's version, and returns the frame record path.
func advertisingDriver(t *testing.T, scenario string) (*ACPDriver, string) {
	t.Helper()
	executable, err := os.Executable()
	require.NoError(t, err)
	record := filepath.Join(t.TempDir(), "frames.jsonl")
	driver := NewACPDriver(ACPDriverOptions{
		Adapters: map[string]ACPAdapter{"codex-cli": {
			Binary: executable, Environment: acptest.Environment(scenario, record),
			ID: "codex-acp", Version: acptest.CodexAdapterVersion, Source: protocol.ACPAdapterSourceSetupLedger,
		}},
		NativeBinaries: map[string]string{"codex-cli": fakeCodexNativeBinary},
		RequestTimeout: 5 * time.Second,
	})
	t.Cleanup(func() { acptest.KillDescendants(t, record) })
	return driver, record
}

func findProfile(profiles []protocol.HarnessProfile, id string) protocol.HarnessProfile {
	for _, profile := range profiles {
		if profile.ID == id {
			return profile
		}
	}
	return protocol.HarnessProfile{}
}

func TestAdvertiseACPMergesVerifiedAdapterTransports(t *testing.T) {
	driver, record := advertisingDriver(t, "codex-probe-models")
	discovered := fakeNativeCodex(t)[0]
	discovered.Transports = []string{TransportNative}
	input := []protocol.HarnessProfile{discovered}

	advertised, failures := AdvertiseACP(context.Background(), input, driver)
	require.Empty(t, failures)
	profile := findProfile(advertised, "codex-cli")
	require.Equal(t, []string{TransportNative, TransportACP}, profile.Transports)
	require.True(t, profile.Available)
	require.NotNil(t, profile.ACP)
	require.Equal(t, acptest.CodexAdapterVersion, profile.ACP.AdapterVersion)
	require.True(t, profile.ACP.Mcp.HTTP)
	require.NoError(t, driver.Available("codex-cli"))

	original := findProfile(input, "codex-cli")
	require.Equal(t, []string{TransportNative}, original.Transports)
	require.Nil(t, original.ACP)

	require.Equal(t, fakeCodexNativeBinary, acptest.RecordedEnvironment(t, record)["CODEX_PATH"])
	require.Equal(t, []string{"default", acptest.CodexModel, acptest.CodexAlternateModel}, profile.Models)
	require.Empty(t, original.Models)
}

func TestAdvertiseACPAdvertisesACPWithoutTheNativeCLI(t *testing.T) {
	driver, _ := advertisingDriver(t, "codex-probe-models")
	input := []protocol.HarnessProfile{{
		ID: "codex-cli", Label: "Codex", Description: "Not installed",
		Available: false, Transports: []string{TransportNative},
	}}

	advertised, failures := AdvertiseACP(context.Background(), input, driver)
	require.Empty(t, failures)
	profile := findProfile(advertised, "codex-cli")
	require.Equal(t, []string{TransportACP}, profile.Transports)
	require.True(t, profile.Available)
	require.Equal(t, "ACP adapter "+acptest.CodexAdapterVersion, profile.Description)
	require.NotNil(t, profile.ACP)
	require.Equal(t, []string{"default", acptest.CodexModel, acptest.CodexAlternateModel}, profile.Models)
}

func TestAdvertiseACPReadsModelsFromAThrowawaySessionItCloses(t *testing.T) {
	driver, record := advertisingDriver(t, "codex-probe-models")
	input := []protocol.HarnessProfile{{ID: "codex-cli", Label: "Codex", Description: "Not installed", Models: []string{}, Transports: []string{TransportNative}}}
	advertised, failures := AdvertiseACP(context.Background(), input, driver)
	require.Empty(t, failures)
	require.Equal(t, []string{"default", acptest.CodexModel, acptest.CodexAlternateModel}, advertised[0].Models)

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

func TestAdvertiseACPScreensAdapterModels(t *testing.T) {
	driver, _ := advertisingDriver(t, "codex-probe-unsafe-models")
	input := []protocol.HarnessProfile{{ID: "codex-cli", Label: "Codex", Transports: []string{TransportNative}}}
	advertised, failures := AdvertiseACP(context.Background(), input, driver)
	require.Empty(t, failures)
	require.Equal(t, []string{"default", "gpt-5.5", "o4-mini"}, advertised[0].Models)
}

func TestAdvertiseACPKeepsDefaultOnlyModelsWhenTheProbeCannotOpenASession(t *testing.T) {
	driver, _ := advertisingDriver(t, "codex-probe-authentication-required")
	input := []protocol.HarnessProfile{{ID: "codex-cli", Label: "Codex", Models: []string{}, Transports: []string{TransportNative}}}
	advertised, failures := AdvertiseACP(context.Background(), input, driver)
	require.Empty(t, failures, "an unauthenticated adapter is still advertised; its runs report auth-required")
	require.Equal(t, []string{TransportACP}, advertised[0].Transports)
	require.Empty(t, advertised[0].Models)
}

func TestAdvertisedModelsMergeRules(t *testing.T) {
	require.Equal(t, []string{"native-a"}, advertisedModels([]string{"native-a"}, true, nil))
	require.Equal(t, []string{"native-a", "gpt-5.5"}, advertisedModels([]string{"native-a"}, true, []string{"native-a", "gpt-5.5"}))
	require.Equal(t, []string{"default", "gpt-5.5"}, advertisedModels([]string{}, true, []string{"gpt-5.5"}))
	require.Equal(t, []string{"default", "gpt-5.5"}, advertisedModels([]string{"stale"}, false, []string{"gpt-5.5"}))
	many := make([]string, 0, 2*MaximumAdvertisedModels)
	for index := range 2 * MaximumAdvertisedModels {
		many = append(many, fmt.Sprintf("model-%d", index))
	}
	require.Len(t, advertisedModels(nil, false, screenedModels(many)), MaximumAdvertisedModels)
	require.Len(t, screenedModels(many), MaximumAdvertisedModels)
}

func TestAdvertiseACPDisablesAdaptersThatFailTheirProbe(t *testing.T) {
	for _, testCase := range []struct {
		scenario string
		target   error
	}{
		{scenario: "codex-no-http-mcp", target: acp.ErrMissingCapability},
		{scenario: "codex-version-mismatch", target: acp.ErrAdapterVersionMismatch},
	} {
		t.Run(testCase.scenario, func(t *testing.T) {
			driver, _ := advertisingDriver(t, testCase.scenario)
			input := []protocol.HarnessProfile{{
				ID: "codex-cli", Label: "Codex", Description: "Not installed",
				Available: false, Transports: []string{TransportNative},
			}}

			advertised, failures := AdvertiseACP(context.Background(), input, driver)
			require.ErrorIs(t, failures["codex-cli"], testCase.target)
			require.Equal(t, input, advertised)
			require.ErrorIs(t, driver.Available("codex-cli"), ErrDriverUnavailable)
		})
	}
}

func TestAdvertiseACPWithoutADriverCopiesProfiles(t *testing.T) {
	input := fakeNativeCodex(t)
	advertised, failures := AdvertiseACP(context.Background(), input, nil)
	require.Equal(t, input, advertised)
	require.Empty(t, failures)
}

func TestACPPolicyGatesConfiguredAdapters(t *testing.T) {
	executable, err := os.Executable()
	require.NoError(t, err)
	driver := NewACPDriver(ACPDriverOptions{
		Adapters:  map[string]ACPAdapter{"claude-cli": {Binary: executable}},
		Providers: map[string]ACPProvider{"codex-cli": {}},
	})
	require.ErrorIs(t, driver.Available("claude-cli"), ErrDriverUnavailable)

	defaults := DefaultACPProviders()
	require.Len(t, defaults, 1)
	require.Contains(t, defaults, "codex-cli")
}

func TestCodexSessionConfiguration(t *testing.T) {
	modeOnly := []acp.ConfigSelection{{ID: "mode", Value: "read-only", Requirement: acp.ConfigPolicy}}
	for _, testCase := range []struct {
		model    string
		expected []acp.ConfigSelection
	}{
		{model: "", expected: modeOnly},
		{model: "default", expected: modeOnly},
		{model: "gpt-5.4", expected: []acp.ConfigSelection{
			{ID: "mode", Value: "read-only", Requirement: acp.ConfigPolicy},
			{ID: "model", Value: "gpt-5.4", Requirement: acp.ConfigRequested},
		}},
	} {
		t.Run("model "+testCase.model, func(t *testing.T) {
			require.Equal(t, testCase.expected, codexSessionConfiguration(protocol.Run{Model: testCase.model}))
		})
	}
}

func TestCodexNativeCommandWiresRunScopedMCPWithoutLeakingTheToken(t *testing.T) {
	configuration := mcpserver.Config{URL: "http://127.0.0.1:1234/mcp", Token: "do-not-leak"}
	run := protocol.Run{HarnessID: "codex-cli", Model: "gpt-5.4", Prompt: "fix it"}

	binary, arguments, err := commandFor(run, protocol.Agent{}, configuration)
	require.NoError(t, err)
	require.Equal(t, "codex", binary)
	require.Equal(t, []string{"exec", "--json", "--sandbox", "workspace-write"}, arguments[:4])
	for _, override := range []string{
		`mcp_servers.coffee_shop_hub.url="http://127.0.0.1:1234/mcp"`,
		`mcp_servers.coffee_shop_hub.bearer_token_env_var="COFFEE_SHOP_MCP_TOKEN"`,
		`mcp_servers.coffee_shop_hub.required=true`,
		`mcp_servers.coffee_shop_hub.default_tools_approval_mode="approve"`,
	} {
		require.Contains(t, arguments, override)
	}
	modelIndex := slices.Index(arguments, "--model")
	require.NotEqual(t, -1, modelIndex)
	require.Equal(t, "gpt-5.4", arguments[modelIndex+1])
	require.Equal(t, composePrompt(run, protocol.Agent{}), arguments[len(arguments)-1])
	for _, argument := range arguments {
		require.NotContains(t, argument, configuration.Token)
	}

	for _, model := range []string{"", "default"} {
		_, arguments, err := commandFor(protocol.Run{HarnessID: "codex-cli", Model: model, Prompt: "fix it"}, protocol.Agent{}, configuration)
		require.NoError(t, err)
		require.NotContains(t, arguments, "--model")
	}
}
