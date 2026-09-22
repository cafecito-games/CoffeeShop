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

// doctorManifestFixture covers every doctor classification: a fully ready adapter, one whose
// on-disk digest drifted from its ledger record, one never installed, and one with no distribution
// for the platform under test.
func doctorManifestFixture(t *testing.T) Manifest {
	t.Helper()
	manifestJSON := []byte(`{
		"manifestVersion": "1",
		"adapters": [
			{
				"id": "ready-acp", "harnessId": "ready-cli", "provider": "alpha-vendor",
				"label": "Ready ACP adapter", "version": "1.0.0",
				"platforms": {"darwin-arm64": {"kind": "manual", "executablePath": "bin/adapter"}},
				"launch": {},
				"authProbe": {"binary": "probe-clean", "arguments": [], "successExitCode": 0}
			},
			{
				"id": "drifted-acp", "harnessId": "drifted-cli", "provider": "alpha-vendor",
				"label": "Drifted ACP adapter", "version": "1.0.0",
				"platforms": {"darwin-arm64": {"kind": "manual", "executablePath": "bin/adapter"}},
				"launch": {}
			},
			{
				"id": "missing-acp", "harnessId": "missing-cli", "provider": "beta-vendor",
				"label": "Missing ACP adapter", "version": "2.0.0",
				"platforms": {"darwin-arm64": {"kind": "manual", "executablePath": "bin/adapter"}},
				"launch": {},
				"authProbe": {"binary": "probe-failure", "arguments": [], "successExitCode": 0}
			},
			{
				"id": "unsupported-acp", "harnessId": "unsupported-cli", "provider": "beta-vendor",
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
func installOwnedAdapter(t *testing.T, dataRoot string, ledger OwnershipLedger, entry AdapterManifestEntry, content []byte) (OwnershipLedger, string) {
	t.Helper()
	distribution := entry.Platforms["darwin-arm64"]
	targetPath := AdapterTargetPath(dataRoot, entry, distribution)
	require.NoError(t, os.MkdirAll(filepath.Dir(targetPath), 0o755))
	require.NoError(t, os.WriteFile(targetPath, content, 0o755))
	updated := ledger.WithRecord(OwnershipRecord{
		Path:           targetPath,
		AdapterID:      entry.ID,
		AdapterVersion: entry.Version,
		ContentSHA256:  sha256Hex(content),
		SizeBytes:      int64(len(content)),
		InstalledAt:    "2026-01-01T00:00:00Z",
	})
	return updated, targetPath
}

func doctorEntryFor(report Report, adapterID string) AdapterDoctorEntry {
	for _, entry := range report.Adapters {
		if entry.AdapterID == adapterID {
			return entry
		}
	}
	return AdapterDoctorEntry{}
}

func TestRunDoctorReportsAdapterAndHubStatus(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test fixtures are shell scripts")
	}
	probeDirectory := t.TempDir()
	writeProbeScript(t, probeDirectory, "probe-clean", "#!/bin/sh\nexit 0\n")
	writeProbeScript(t, probeDirectory, "probe-failure", "#!/bin/sh\nexit 1\n")
	t.Setenv("PATH", probeDirectory)

	manifest := doctorManifestFixture(t)
	dataRoot := t.TempDir()
	ledger := OwnershipLedger{}
	ledger, _ = installOwnedAdapter(t, dataRoot, ledger, manifest.Adapters[0], []byte("ready adapter bytes"))
	ledger, driftedPath := installOwnedAdapter(t, dataRoot, ledger, manifest.Adapters[1], []byte("original bytes"))
	// Corrupt the drifted adapter after recording it: doctor must trust the file, not the ledger.
	require.NoError(t, os.WriteFile(driftedPath, []byte("tampered bytes"), 0o755))

	harnesses := []protocol.HarnessProfile{
		{ID: "ready-cli", Available: true},
		{ID: "drifted-cli", Available: true},
		{ID: "missing-cli", Available: false},
	}

	report := RunDoctor(context.Background(), manifest, ledger, dataRoot, "darwin-arm64", harnesses, "http://hub.example:8787", func(context.Context, string) error {
		return nil
	})

	require.Equal(t, "darwin-arm64", report.Platform)
	require.Equal(t, dataRoot, report.DataRoot)
	require.Len(t, report.Adapters, 4)
	require.Equal(t, ProjectReadinessNotAvailable, report.ProjectReadiness)

	ready := doctorEntryFor(report, "ready-acp")
	require.True(t, ready.HarnessInstalled)
	require.True(t, ready.AdapterInstalled)
	require.Equal(t, AuthReadinessReady, ready.AuthReadiness)
	require.True(t, ready.ACPLaunchReady)
	require.NotEmpty(t, ready.AdapterPath)

	missingHarness := doctorEntryFor(report, "missing-acp")
	require.False(t, missingHarness.HarnessInstalled)
	require.False(t, missingHarness.AdapterInstalled)
	require.Equal(t, AuthReadinessNotReady, missingHarness.AuthReadiness)
	require.False(t, missingHarness.ACPLaunchReady)

	drifted := doctorEntryFor(report, "drifted-acp")
	require.True(t, drifted.HarnessInstalled)
	// The ledger says installed, the file no longer matches: doctor reports reality.
	require.False(t, drifted.AdapterInstalled)
	require.Equal(t, AuthReadinessUnknown, drifted.AuthReadiness)
	require.False(t, drifted.ACPLaunchReady)

	// An unsupported-platform adapter stays in the report with a note rather than being dropped.
	unsupported := doctorEntryFor(report, "unsupported-acp")
	require.False(t, unsupported.HarnessInstalled)
	require.False(t, unsupported.AdapterInstalled)
	require.Equal(t, AuthReadinessUnknown, unsupported.AuthReadiness)
	require.False(t, unsupported.ACPLaunchReady)
	require.Equal(t, []string{"no platform distribution for darwin-arm64"}, unsupported.Notes)
	require.Empty(t, unsupported.AdapterPath)

	require.True(t, report.HubConnectivity.Reachable)
	require.Equal(t, "http://hub.example:8787", report.HubConnectivity.Endpoint)
	require.Empty(t, report.HubConnectivity.Detail)
}

func TestRunDoctorReportsUnreachableHubWithScreenedDetail(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test fixtures are shell scripts")
	}
	manifest := doctorManifestFixture(t)
	harnesses := []protocol.HarnessProfile{{ID: "ready-cli", Available: true}}

	plain := RunDoctor(context.Background(), manifest, OwnershipLedger{}, t.TempDir(), "darwin-arm64", harnesses, "http://127.0.0.1:1", func(context.Context, string) error {
		return errors.New("dial tcp 127.0.0.1:1: connection refused")
	})
	require.False(t, plain.HubConnectivity.Reachable)
	require.Equal(t, "dial tcp 127.0.0.1:1: connection refused", plain.HubConnectivity.Detail)

	// A URL can carry a query-string token, so a secret-looking error message is replaced wholesale.
	secret := RunDoctor(context.Background(), manifest, OwnershipLedger{}, t.TempDir(), "darwin-arm64", harnesses, "https://hub.example", func(context.Context, string) error {
		return errors.New("dial https://hub.example?token=ghp_abcdefghij1234 failed")
	})
	require.False(t, secret.HubConnectivity.Reachable)
	require.Equal(t, "connection attempt failed", secret.HubConnectivity.Detail)
}
