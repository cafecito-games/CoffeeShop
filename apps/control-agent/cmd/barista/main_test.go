package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp/acptest"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/config"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/harness"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

func TestMain(m *testing.M) {
	acptest.RunIfRequested()
	os.Exit(m.Run())
}

func TestHelpExitsSuccessfully(t *testing.T) {
	require.Equal(t, 0, run([]string{"--help"}))
}

func TestInvalidConfigurationNeverConnects(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		requests.Add(1)
	}))
	t.Cleanup(server.Close)
	t.Setenv("CONTROL_ENDPOINT", server.URL)
	t.Setenv("WORKSPACE_ROOTS", "relative/workspace")

	require.Equal(t, 2, run([]string{"--name", "Worker 1", "--id", "worker-1"}))
	require.Zero(t, requests.Load())
}

// undiscoveredHarnessProfiles mirrors Discover's output for a node whose CLIs are not installed:
// each harness keeps its native transport claimed but unavailable.
func undiscoveredHarnessProfiles() []protocol.HarnessProfile {
	return []protocol.HarnessProfile{
		{ID: "claude-cli", Label: "Claude Code", Description: "Not installed", Binary: "claude", Available: false, Transports: []string{harness.TransportNative}},
		{ID: "codex-cli", Label: "Codex", Description: "Not installed", Binary: "codex", Available: false, Transports: []string{harness.TransportNative}},
	}
}

// probedClaudeAdapterDriver builds the ACP driver of a node whose claude-cli adapter replays the
// named acptest startup-probe scenario.
func probedClaudeAdapterDriver(t *testing.T, scenario string) *harness.ACPDriver {
	t.Helper()
	executable, err := os.Executable()
	require.NoError(t, err)
	record := filepath.Join(t.TempDir(), "frames.jsonl")
	t.Cleanup(func() { acptest.KillDescendants(t, record) })
	return harness.NewACPDriver(harness.ACPDriverOptions{
		Adapters: map[string]harness.ACPAdapter{"claude-cli": {
			Binary: executable, Environment: acptest.Environment(scenario, record),
			ID: "claude-acp", Version: acptest.ClaudeAdapterVersion, Source: protocol.ACPAdapterSourceSetupLedger,
		}},
		RequestTimeout: 5 * time.Second,
	})
}

// The invariant this node's wiring must hold: what it advertises to the hub and what it will admit
// are the same set. Every available harness in the advertised profiles, with each of its advertised
// models over each of its advertised transports, is admissible through the Runner main builds, and
// everything absent from the advertised set is refused.
func TestRunnerAdmissionMatchesTheAdvertisedHarnessProfiles(t *testing.T) {
	driver := probedClaudeAdapterDriver(t, "claude-probe-models")
	nativeProfiles := undiscoveredHarnessProfiles()
	advertised, failures := harness.AdvertiseACP(context.Background(), nativeProfiles, driver)
	require.Empty(t, failures)
	runner := newRunner(nativeProfiles, advertised, driver, config.Config{})

	advertisedHarness := false
	for _, profile := range advertised {
		if !profile.Available {
			continue
		}
		advertisedHarness = true
		models := profile.Models
		if len(models) == 0 {
			models = []string{"any-model"}
		}
		for _, model := range models {
			require.NoError(t, runner.AdmitModel(profile.ID, model),
				"an advertised harness and model must be admissible: %s/%s", profile.ID, model)
		}
		for _, transport := range profile.Transports {
			require.NoError(t, runner.Admit(profile.ID, transport, ""),
				"an advertised transport must be admissible: %s over %s", profile.ID, transport)
		}
	}
	require.True(t, advertisedHarness, "the probed adapter must advertise claude-cli without its native CLI")

	require.ErrorContains(t, runner.AdmitModel("codex-cli", "default"),
		"harness codex-cli is not installed", "a harness absent from the advertised set must not be admissible")
	require.ErrorContains(t, runner.AdmitModel("claude-cli", "claude-unreleased-9"),
		"model claude-unreleased-9 is not advertised by harness claude-cli")
}

// A harness whose adapter failed its startup probe is not advertised — its profile keeps its native
// form and its adapter is disabled — so the Runner main builds must refuse it on both checks.
func TestRunnerAdmissionRefusesHarnessesWhoseProbeFailed(t *testing.T) {
	driver := probedClaudeAdapterDriver(t, "claude-version-mismatch")
	nativeProfiles := undiscoveredHarnessProfiles()
	advertised, failures := harness.AdvertiseACP(context.Background(), nativeProfiles, driver)
	require.NotEmpty(t, failures["claude-cli"], "the adapter must fail its startup probe")
	runner := newRunner(nativeProfiles, advertised, driver, config.Config{})

	require.ErrorContains(t, runner.AdmitModel("claude-cli", acptest.ClaudeModel),
		"harness claude-cli is not installed", "a probe-failed adapter must not make its harness admissible")
	require.ErrorIs(t, runner.Admit("claude-cli", harness.TransportACP, ""), harness.ErrDriverUnavailable,
		"a probe-failed adapter must not carry its harness over ACP")
}
