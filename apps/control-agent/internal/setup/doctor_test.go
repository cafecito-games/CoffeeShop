package setup

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

// doctorManifestFixture covers every doctor classification: a fully ready adapter (harness
// installed, adapter installed, auth ready), one whose auth probe reports not-ready, one whose
// on-disk digest drifted from its ledger record, and one with no distribution for the platform
// under test. "ready-acp" and "notready-acp" deliberately use the two harness IDs
// (claude-cli/codex-cli) the compiled AuthProbeAllowlist actually covers — the manifest itself
// carries no probe of its own; there is no such field any more.
func doctorManifestFixture(t *testing.T) Manifest {
	t.Helper()
	manifestJSON := []byte(`{
		"manifestVersion": "2",
		"components": [
			{
				"id": "ready-acp", "kind": "acp-adapter", "harnessId": "claude-cli", "provider": "anthropic",
				"label": "Ready ACP adapter", "version": "1.0.0",
				"platforms": {"darwin-arm64": {"kind": "manual", "executablePath": "bin/adapter"}},
				"launch": {}
			},
			{
				"id": "notready-acp", "kind": "acp-adapter", "harnessId": "codex-cli", "provider": "openai",
				"label": "Not-ready ACP adapter", "version": "1.0.0",
				"platforms": {"darwin-arm64": {"kind": "manual", "executablePath": "bin/adapter"}},
				"launch": {}
			},
			{
				"id": "drifted-acp", "kind": "acp-adapter", "harnessId": "drifted-cli", "provider": "alpha-vendor",
				"label": "Drifted ACP adapter", "version": "1.0.0",
				"platforms": {"darwin-arm64": {"kind": "manual", "executablePath": "bin/adapter"}},
				"launch": {}
			},
			{
				"id": "unsupported-acp", "kind": "acp-adapter", "harnessId": "unsupported-cli", "provider": "beta-vendor",
				"label": "Unsupported ACP adapter", "version": "2.0.0",
				"platforms": {"linux-s390x": {"kind": "manual", "executablePath": "bin/adapter"}},
				"launch": {}
			}
		]
	}`)
	manifest, err := ParseManifest(manifestJSON)
	require.NoError(t, err)
	return manifest
}

// installOwnedAdapter places a file at the adapter's target path and records it in the ledger, the
// way a successful apply would. Returning the path lets a test corrupt the file afterwards.
func installOwnedComponent(t *testing.T, dataRoot string, ledger OwnershipLedger, entry ComponentManifestEntry, content []byte) (OwnershipLedger, string) {
	t.Helper()
	distribution := entry.Platforms["darwin-arm64"]
	targetPath, err := ComponentTargetPath(dataRoot, entry, distribution)
	require.NoError(t, err)
	require.NoError(t, os.MkdirAll(filepath.Dir(targetPath), 0o755))
	require.NoError(t, os.WriteFile(targetPath, content, 0o755))
	updated := ledger.WithRecord(OwnershipRecord{
		Path:          targetPath,
		Component:     entry.Ref(),
		HarnessID:     entry.HarnessID,
		ContentSHA256: sha256Hex(content),
		SizeBytes:     int64(len(content)),
		InstalledAt:   "2026-01-01T00:00:00Z",
	})
	return updated, targetPath
}

func doctorEntryFor(report Report, componentID string) ComponentDoctorEntry {
	for _, entry := range report.Components {
		if entry.Component.ID == componentID {
			return entry
		}
	}
	return ComponentDoctorEntry{}
}

func TestRunDoctorReportsComponentAndHubStatus(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test fixtures are shell scripts")
	}
	probeDirectory := t.TempDir()
	cleanProbePath := writeProbeScript(t, probeDirectory, "probe-clean", "#!/bin/sh\nexit 0\n")
	failureProbePath := writeProbeScript(t, probeDirectory, "probe-failure", "#!/bin/sh\nexit 1\n")

	manifest := doctorManifestFixture(t)
	dataRoot := t.TempDir()
	ledger := OwnershipLedger{}
	// ready-acp is installed; notready-acp deliberately is not, so its auth probe still runs (the
	// harness itself is installed) but the adapter is not.
	ledger, readyPath := installOwnedComponent(t, dataRoot, ledger, manifest.Components[0], []byte("ready adapter bytes"))
	ledger, driftedPath := installOwnedComponent(t, dataRoot, ledger, manifest.Components[2], []byte("original bytes"))
	// Corrupt the drifted adapter after recording it: doctor must trust the file, not the ledger.
	require.NoError(t, os.WriteFile(driftedPath, []byte("tampered bytes"), 0o755))

	// harnessProfile.Binary is the absolute, already-resolved path doctor's auth probe must use —
	// exactly what harness.Discover would have set after its own successful --version check.
	harnesses := []protocol.HarnessProfile{
		{ID: "claude-cli", Available: true, Binary: cleanProbePath},
		{ID: "codex-cli", Available: true, Binary: failureProbePath},
		{ID: "drifted-cli", Available: true},
	}

	// ACP launch readiness now also requires that the installed version is the activated one, so the
	// ready adapter is selected the way setup.Activate would select it.
	activation := ActivationState{
		Generation: ActivationLedgerVersion,
		Ledger: ActivationLedger{}.WithRecord(ActivationRecord{Active: ActivationTarget{
			Component: manifest.Components[0].Ref(), Path: readyPath, ContentSHA256: sha256Hex([]byte("ready adapter bytes")),
		}}),
	}

	report := RunDoctor(context.Background(), manifest, ledger, dataRoot, "darwin-arm64", activation, harnesses, "http://hub.example:8787", func(context.Context, string) error {
		return nil
	})

	require.Equal(t, "darwin-arm64", report.Platform)
	require.Equal(t, dataRoot, report.DataRoot)
	require.Len(t, report.Components, 4)
	require.Equal(t, ProjectReadinessNotAvailable, report.ProjectReadiness)

	ready := doctorEntryFor(report, "ready-acp")
	require.True(t, ready.HarnessInstalled)
	require.True(t, ready.ComponentInstalled)
	require.Equal(t, AuthReadinessReady, ready.AuthReadiness)
	require.True(t, ready.ACPLaunchReady)
	require.NotEmpty(t, ready.ComponentPath)

	notReady := doctorEntryFor(report, "notready-acp")
	require.True(t, notReady.HarnessInstalled)
	require.False(t, notReady.ComponentInstalled)
	require.Equal(t, AuthReadinessNotReady, notReady.AuthReadiness)
	require.False(t, notReady.ACPLaunchReady)

	drifted := doctorEntryFor(report, "drifted-acp")
	require.True(t, drifted.HarnessInstalled)
	// The ledger says installed, the file no longer matches: doctor reports reality.
	require.False(t, drifted.ComponentInstalled)
	// drifted-cli has no compiled AuthProbeAllowlist entry, so it is always unknown regardless of
	// installation state.
	require.Equal(t, AuthReadinessUnknown, drifted.AuthReadiness)
	require.False(t, drifted.ACPLaunchReady)

	// An unsupported-platform adapter stays in the report with a note rather than being dropped.
	unsupported := doctorEntryFor(report, "unsupported-acp")
	require.False(t, unsupported.HarnessInstalled)
	require.False(t, unsupported.ComponentInstalled)
	require.Equal(t, AuthReadinessUnknown, unsupported.AuthReadiness)
	require.False(t, unsupported.ACPLaunchReady)
	require.Equal(t, []string{"no platform distribution for darwin-arm64"}, unsupported.Notes)
	require.Empty(t, unsupported.ComponentPath)

	require.True(t, report.HubConnectivity.Reachable)
	require.Equal(t, "http://hub.example:8787", report.HubConnectivity.Endpoint)
	require.Empty(t, report.HubConnectivity.Detail)
}

// TestRunDoctorNeverRunsAuthProbeForUninstalledHarness proves the core of fix 2's runtime
// behavior: even though claude-cli has a compiled AuthProbeAllowlist entry, doctor must never run
// it against a harness that discovery did not find installed — there is no resolved absolute
// binary path to run in that case, and doctor must report Unknown rather than guessing at one.
func TestRunDoctorNeverRunsAuthProbeForUninstalledHarness(t *testing.T) {
	manifestJSON := []byte(`{
		"manifestVersion": "2",
		"components": [
			{
				"id": "claude-acp", "kind": "acp-adapter", "harnessId": "claude-cli", "provider": "anthropic",
				"label": "Claude ACP adapter", "version": "1.0.0",
				"platforms": {"darwin-arm64": {"kind": "manual", "executablePath": "bin/adapter"}},
				"launch": {}
			}
		]
	}`)
	manifest, err := ParseManifest(manifestJSON)
	require.NoError(t, err)

	// No harness profile at all for claude-cli: discovery did not find it.
	report := RunDoctor(context.Background(), manifest, OwnershipLedger{}, t.TempDir(), "darwin-arm64", ActivationState{}, nil, "https://hub.example", func(context.Context, string) error {
		return nil
	})
	entry := doctorEntryFor(report, "claude-acp")
	require.False(t, entry.HarnessInstalled)
	require.Equal(t, AuthReadinessUnknown, entry.AuthReadiness)
}

func TestRunDoctorReportsUnreachableHubWithScreenedDetail(t *testing.T) {
	manifest := doctorManifestFixture(t)
	harnesses := []protocol.HarnessProfile{{ID: "claude-cli", Available: true}}

	plain := RunDoctor(context.Background(), manifest, OwnershipLedger{}, t.TempDir(), "darwin-arm64", ActivationState{}, harnesses, "http://127.0.0.1:1", func(context.Context, string) error {
		return errors.New("dial tcp 127.0.0.1:1: connection refused")
	})
	require.False(t, plain.HubConnectivity.Reachable)
	require.Equal(t, "dial tcp 127.0.0.1:1: connection refused", plain.HubConnectivity.Detail)

	// A URL can carry a query-string token, so a secret-looking error message is replaced wholesale.
	secret := RunDoctor(context.Background(), manifest, OwnershipLedger{}, t.TempDir(), "darwin-arm64", ActivationState{}, harnesses, "https://hub.example", func(context.Context, string) error {
		return errors.New("dial https://hub.example?token=ghp_abcdefghij1234 failed")
	})
	require.False(t, secret.HubConnectivity.Reachable)
	require.Equal(t, "connection attempt failed", secret.HubConnectivity.Detail)
}

// TestRunDoctorSanitizesControlEndpointForDisplay proves the fix-5 property: userinfo, query
// string, and fragment never reach the report — in either the reachable or unreachable case — even
// though the unsanitized endpoint is still what dial actually receives (verified here by asserting
// the dial callback still sees the raw value, so connectivity itself keeps working).
func TestRunDoctorSanitizesControlEndpointForDisplay(t *testing.T) {
	manifest := doctorManifestFixture(t)
	const secretLikeUserinfo = "operator:ghp_abcdefghij1234"
	rawEndpoint := "https://" + secretLikeUserinfo + "@hub.example:8787/control-agent?token=" + secretLikeUserinfo + "#fragment"

	var dialedEndpoint string
	report := RunDoctor(context.Background(), manifest, OwnershipLedger{}, t.TempDir(), "darwin-arm64", ActivationState{}, nil, rawEndpoint, func(_ context.Context, endpoint string) error {
		dialedEndpoint = endpoint
		return nil
	})

	require.Equal(t, rawEndpoint, dialedEndpoint, "dial must still receive the real endpoint")
	require.NotContains(t, report.HubConnectivity.Endpoint, "ghp_abcdefghij1234")
	require.NotContains(t, report.HubConnectivity.Endpoint, "operator:")
	require.NotContains(t, report.HubConnectivity.Endpoint, "token=")
	require.NotContains(t, report.HubConnectivity.Endpoint, "#fragment")
	require.Equal(t, "https://hub.example:8787/control-agent", report.HubConnectivity.Endpoint)
}

// TestRunDoctorNeverReportsAHarnessComponentAsACPLaunchReady proves the kind-aware half of the
// readiness verdict: a harness component can be installed and its auth probe can pass, but it is
// not the thing that speaks ACP, so ACPLaunchReady stays false for it while the adapter alongside it
// is reported ready.
func TestRunDoctorNeverReportsAHarnessComponentAsACPLaunchReady(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test fixtures are shell scripts")
	}
	probePath := writeProbeScript(t, t.TempDir(), "probe-clean", "#!/bin/sh\nexit 0\n")
	manifestJSON := []byte(`{
		"manifestVersion": "2",
		"components": [
			{
				"id": "claude-cli", "kind": "harness", "harnessId": "claude-cli", "provider": "anthropic",
				"label": "Claude Code", "version": "2.1.0",
				"platforms": {"darwin-arm64": {"kind": "manual", "executablePath": "bin/claude"}},
				"launch": {}
			},
			{
				"id": "claude-acp", "kind": "acp-adapter", "harnessId": "claude-cli", "provider": "anthropic",
				"label": "Claude ACP adapter", "version": "0.79.0",
				"platforms": {"darwin-arm64": {"kind": "manual", "executablePath": "bin/claude-agent-acp"}},
				"launch": {}
			}
		]
	}`)
	manifest, err := ParseManifest(manifestJSON)
	require.NoError(t, err)
	dataRoot := t.TempDir()
	ledger := OwnershipLedger{}
	activation := ActivationLedger{}
	for _, entry := range manifest.Components {
		var installedPath string
		ledger, installedPath = installOwnedComponent(t, dataRoot, ledger, entry, []byte("payload for "+entry.ID))
		activation = activation.WithRecord(ActivationRecord{Active: ActivationTarget{
			Component: entry.Ref(), Path: installedPath, ContentSHA256: sha256Hex([]byte("payload for " + entry.ID)),
		}})
	}
	harnesses := []protocol.HarnessProfile{{ID: "claude-cli", Available: true, Binary: probePath}}

	report := RunDoctor(context.Background(), manifest, ledger, dataRoot, "darwin-arm64",
		ActivationState{Generation: ActivationLedgerVersion, Ledger: activation}, harnesses, "http://hub.example:8787", func(context.Context, string) error {
			return nil
		})

	harnessEntry := doctorEntryFor(report, "claude-cli")
	require.Equal(t, ComponentKindHarness, harnessEntry.Component.Kind)
	require.True(t, harnessEntry.HarnessInstalled)
	require.True(t, harnessEntry.ComponentInstalled)
	require.Equal(t, AuthReadinessReady, harnessEntry.AuthReadiness)
	require.False(t, harnessEntry.ACPLaunchReady, "a harness component must never be reported as ACP-launch-ready")

	adapterEntry := doctorEntryFor(report, "claude-acp")
	require.Equal(t, ComponentKindACPAdapter, adapterEntry.Component.Kind)
	require.True(t, adapterEntry.ComponentInstalled)
	require.True(t, adapterEntry.ACPLaunchReady)
	// The two kinds install under distinct directories, so neither shadows the other.
	require.NotEqual(t, harnessEntry.ComponentPath, adapterEntry.ComponentPath)
}
