package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/setup"
)

// activationCLIFixture is a data root with one adapter component installed at two versions, plus the
// manifest file that declares them, which is what the activation subcommands and doctor read.
type activationCLIFixture struct {
	dataRoot     string
	manifestPath string
	manifest     setup.Manifest
	entries      []setup.ComponentManifestEntry
}

func newActivationCLIFixture(t *testing.T) *activationCLIFixture {
	t.Helper()
	platform := runtime.GOOS + "-" + runtime.GOARCH
	fixture := &activationCLIFixture{dataRoot: t.TempDir(), manifestPath: filepath.Join(t.TempDir(), "components.json")}
	// Two installed versions of one component id. A manifest carries at most one version per id, so
	// the fixture declares one at a time — which is exactly how a Barista upgrade presents a new
	// version while the previous one stays installed and owned.
	for _, version := range []string{"0.4.0", "0.5.0"} {
		fixture.entries = append(fixture.entries, setup.ComponentManifestEntry{
			ID: "manual-acp", Kind: setup.ComponentKindACPAdapter, HarnessID: "manual-cli",
			Provider: "manual-vendor", Label: "Manual ACP adapter", Version: version,
			Platforms: map[string]setup.PlatformDistribution{
				platform: {Kind: setup.DistributionKindManual, ExecutablePath: "bin/adapter"},
			},
		})
	}
	fixture.declare(t, fixture.entries[0])

	ledger := setup.OwnershipLedger{}
	for _, entry := range fixture.entries {
		target := fixture.targetFor(t, entry)
		require.NoError(t, os.MkdirAll(filepath.Dir(target), 0o755))
		payload := []byte("adapter payload " + entry.Version)
		require.NoError(t, os.WriteFile(target, payload, 0o755))
		digest := sha256.Sum256(payload)
		ledger = ledger.WithRecord(setup.OwnershipRecord{
			Path: target, Component: entry.Ref(), HarnessID: entry.HarnessID,
			ContentSHA256: hex.EncodeToString(digest[:]), SizeBytes: int64(len(payload)),
			InstalledAt: "2026-09-25T00:00:00Z",
		})
	}
	require.NoError(t, ledger.Save(fixture.dataRoot))
	return fixture
}

// declare writes the manifest file the CLI reads, asserting the real parser accepts it.
func (fixture *activationCLIFixture) declare(t *testing.T, entries ...setup.ComponentManifestEntry) {
	t.Helper()
	encoded, err := json.Marshal(setup.Manifest{ManifestVersion: setup.ManifestVersion, Components: entries})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(fixture.manifestPath, encoded, 0o644))
	manifest, err := setup.ParseManifest(encoded)
	require.NoError(t, err)
	fixture.manifest = manifest
}

// entryFor returns the fixture entry for one version.
func (fixture *activationCLIFixture) entryFor(t *testing.T, version string) setup.ComponentManifestEntry {
	t.Helper()
	for _, entry := range fixture.entries {
		if entry.Version == version {
			return entry
		}
	}
	t.Fatalf("no fixture entry for version %s", version)
	return setup.ComponentManifestEntry{}
}

func (fixture *activationCLIFixture) targetFor(t *testing.T, entry setup.ComponentManifestEntry) string {
	t.Helper()
	platform := runtime.GOOS + "-" + runtime.GOARCH
	target, err := setup.ComponentTargetPath(fixture.dataRoot, entry, entry.Platforms[platform])
	require.NoError(t, err)
	return target
}

// activate declares the version and records its selection through setup.Activate with an accepting
// probe, because the real CLI probe would start a vendor process this test has no business launching.
func (fixture *activationCLIFixture) activate(t *testing.T, version string) {
	t.Helper()
	fixture.declare(t, fixture.entryFor(t, version))
	ownership, err := setup.LoadOwnershipLedger(fixture.dataRoot)
	require.NoError(t, err)
	_, err = setup.Activate(context.Background(), setup.ActivationContext{
		DataRoot:   fixture.dataRoot,
		Manifest:   fixture.manifest,
		Platform:   setup.CurrentPlatform(),
		Ownership:  ownership,
		Activation: setup.LoadActivationState(fixture.dataRoot),
		Probe:      func(context.Context, setup.InstalledComponent) error { return nil },
		InUse:      func(string) bool { return false },
	}, setup.ComponentSelector{Kind: setup.ComponentKindACPAdapter, ID: "manual-acp", Version: version})
	require.NoError(t, err)
}

// reportShape is the subset of the doctor report this test asserts on.
type reportShape struct {
	Components []struct {
		Component struct {
			ID      string `json:"id"`
			Version string `json:"version"`
		} `json:"component"`
		ActiveVersion   string `json:"activeVersion"`
		RollbackVersion string `json:"rollbackVersion"`
		Provenance      string `json:"provenance"`
	} `json:"components"`
	Activation struct {
		Generation string `json:"generation"`
		Accepted   bool   `json:"accepted"`
		Rejection  string `json:"rejection"`
		Repair     string `json:"repair"`
	} `json:"activation"`
}

// TestRunDoctorActivationOutput proves doctor reports the active version, the retained rollback
// target, and the provenance in both human and --json output, and reports a rejected activation
// ledger with its generation and repair guidance instead of as an absent selection.
func TestRunDoctorActivationOutput(t *testing.T) {
	emptyPATH(t)
	fixture := newActivationCLIFixture(t)
	fixture.activate(t, "0.4.0")
	fixture.activate(t, "0.5.0")

	stdout, stderr, code := captureOutput(t, func() int {
		return runDoctor([]string{"--manifest", fixture.manifestPath, "--data-root", fixture.dataRoot, "--control-endpoint", "http://127.0.0.1:1"})
	})
	require.Equal(t, 0, code, stderr)
	require.Contains(t, stdout, "provenance=managed active=0.5.0 rollback=0.4.0")
	require.Contains(t, stdout, "activation ledger: generation=1 accepted=true")

	stdout, stderr, code = captureOutput(t, func() int {
		return runDoctor([]string{"--json", "--manifest", fixture.manifestPath, "--data-root", fixture.dataRoot, "--control-endpoint", "http://127.0.0.1:1"})
	})
	require.Equal(t, 0, code, stderr)
	var report reportShape
	require.NoError(t, json.Unmarshal([]byte(stdout), &report))
	require.True(t, report.Activation.Accepted)
	require.Equal(t, setup.ActivationLedgerVersion, report.Activation.Generation)
	require.Empty(t, report.Activation.Repair)
	require.Len(t, report.Components, 1)
	require.Equal(t, "0.5.0", report.Components[0].ActiveVersion)
	require.Equal(t, "0.4.0", report.Components[0].RollbackVersion)
	require.Equal(t, "managed", report.Components[0].Provenance)

	// A rejected ledger is reported with the generation and the repair, and no component is reported
	// as having an absent selection.
	activationPath := filepath.Join(fixture.dataRoot, "activation.json")
	require.NoError(t, os.WriteFile(activationPath, []byte(`{"ledgerVersion":"7","records":[]}`), 0o644))
	stdout, _, code = captureOutput(t, func() int {
		return runDoctor([]string{"--json", "--manifest", fixture.manifestPath, "--data-root", fixture.dataRoot, "--control-endpoint", "http://127.0.0.1:1"})
	})
	require.Equal(t, 0, code)
	// Decoded into a fresh value: omitempty fields absent from the new payload must not be read from
	// the previous decode.
	report = reportShape{}
	require.NoError(t, json.Unmarshal([]byte(stdout), &report))
	require.False(t, report.Activation.Accepted)
	require.Contains(t, report.Activation.Rejection, "generation is unknown")
	require.Equal(t, setup.ActivationRepairGuidance, report.Activation.Repair)
	for _, entry := range report.Components {
		require.Equal(t, "rejected", entry.Provenance)
		require.Empty(t, entry.ActiveVersion)
	}
	// Doctor never repairs the file.
	current, err := os.ReadFile(activationPath)
	require.NoError(t, err)
	require.Equal(t, `{"ledgerVersion":"7","records":[]}`, string(current))
}

// TestSetupActivationSubcommandsRefuseBeforeMutating proves each subcommand refuses on a rejected
// activation ledger, prints the repair guidance, and leaves the file byte-identical.
func TestSetupActivationSubcommandsRefuseBeforeMutating(t *testing.T) {
	fixture := newActivationCLIFixture(t)
	corrupt := []byte(`{"ledgerVersion":"1","records":[{"active":{"component":{"kind":"acp-adapter","id":"manual-acp","version":"0.4.0"},"path":"relative/path","contentSha256":"` + hex.EncodeToString(make([]byte, 32)) + `"}}]}`)
	activationPath := filepath.Join(fixture.dataRoot, "activation.json")
	require.NoError(t, os.WriteFile(activationPath, corrupt, 0o644))

	for _, args := range [][]string{
		{"activate", "--kind", "acp-adapter", "--id", "manual-acp", "--version", "0.4.0"},
		{"rollback", "--kind", "acp-adapter", "--id", "manual-acp"},
		{"prune", "--kind", "acp-adapter", "--id", "manual-acp"},
	} {
		_, stderr, code := captureOutput(t, func() int {
			return runSetup(append(args, "--data-root", fixture.dataRoot, "--manifest", fixture.manifestPath))
		})
		require.Equal(t, 1, code, args[0])
		require.Contains(t, stderr, "activation ledger generation 1 cannot be accepted", args[0])
		require.Contains(t, stderr, setup.ActivationRepairGuidance, args[0])
		current, err := os.ReadFile(activationPath)
		require.NoError(t, err)
		require.Equal(t, corrupt, current, args[0])
	}
}

// TestDaemonKeepsStartupSelection proves a daemon whose activation record changes after startup keeps
// the selection it verified at startup and reports that a restart is required, exactly once.
func TestDaemonKeepsStartupSelection(t *testing.T) {
	fixture := newActivationCLIFixture(t)
	fixture.activate(t, "0.4.0")
	startup := setup.LoadActivationState(fixture.dataRoot)
	require.NoError(t, startup.Rejection)
	watcher := newActivationWatcher(fixture.dataRoot, startup)
	require.Empty(t, watcher.RestartNotice(), "an unchanged record produces no notice")

	// The daemon's managed resolution is taken from the startup state, so it keeps resolving 0.4.0.
	ownership, err := setup.LoadOwnershipLedger(fixture.dataRoot)
	require.NoError(t, err)
	startupSelection := func() string {
		installed, err := setup.ActiveInstalledComponent(fixture.dataRoot, fixture.manifest, setup.CurrentPlatform(),
			ownership, watcher.Startup(), setup.ComponentIdentity{Kind: setup.ComponentKindACPAdapter, ID: "manual-acp"})
		require.NoError(t, err)
		return installed.Ref().Version
	}
	require.Equal(t, "0.4.0", startupSelection())

	fixture.activate(t, "0.5.0")
	notice := watcher.RestartNotice()
	require.Contains(t, notice, "restart")
	require.Contains(t, notice, "selection it verified at startup")
	require.Empty(t, watcher.RestartNotice(), "the notice is reported once, not on every capability report")
	require.Equal(t, "0.4.0", startupSelection(), "the running daemon never adopts the new selection in place")
	require.Equal(t, startup.Fingerprint(), watcher.Startup().Fingerprint())

	// A file that becomes unreadable after startup is also a change, and still never adopted.
	fresh := newActivationWatcher(fixture.dataRoot, setup.LoadActivationState(fixture.dataRoot))
	require.NoError(t, os.WriteFile(filepath.Join(fixture.dataRoot, "activation.json"), []byte("{broken"), 0o644))
	require.Contains(t, fresh.RestartNotice(), "restart")
	require.NoError(t, fresh.Startup().Rejection)
}

// TestManagedHarnessesRefusesUnverifiableSelections proves the daemon's managed harness resolution
// yields nothing when the activation ledger is rejected, when nothing is activated, and when the
// selected bytes drifted — never a fallback to a different installed version.
func TestManagedHarnessesRefusesUnverifiableSelections(t *testing.T) {
	platform := runtime.GOOS + "-" + runtime.GOARCH
	manifestJSON := fmt.Sprintf(`{
		"manifestVersion": "2",
		"components": [
			{
				"id": "managed-cli", "kind": "harness", "harnessId": "managed-cli", "provider": "manual-vendor",
				"label": "Managed harness", "version": "1.0.0",
				"platforms": {"%s": {"kind": "manual", "executablePath": "bin/managed"}},
				"launch": {}
			}
		]
	}`, platform)
	manifest, err := setup.ParseManifest([]byte(manifestJSON))
	require.NoError(t, err)
	dataRoot := t.TempDir()
	entry := manifest.Components[0]
	target, err := setup.ComponentTargetPath(dataRoot, entry, entry.Platforms[platform])
	require.NoError(t, err)
	require.NoError(t, os.MkdirAll(filepath.Dir(target), 0o755))
	payload := []byte("managed harness payload")
	require.NoError(t, os.WriteFile(target, payload, 0o755))
	digest := sha256.Sum256(payload)
	ownership := setup.OwnershipLedger{}.WithRecord(setup.OwnershipRecord{
		Path: target, Component: entry.Ref(), HarnessID: entry.HarnessID,
		ContentSHA256: hex.EncodeToString(digest[:]), SizeBytes: int64(len(payload)), InstalledAt: "2026-09-25T00:00:00Z",
	})
	require.NoError(t, ownership.Save(dataRoot))

	// Installed but never activated: not launchable.
	require.Empty(t, managedHarnesses(manifest, ownership, setup.LoadActivationState(dataRoot), dataRoot))

	_, err = setup.Activate(context.Background(), setup.ActivationContext{
		DataRoot: dataRoot, Manifest: manifest, Platform: platform, Ownership: ownership,
		Activation: setup.LoadActivationState(dataRoot),
		Probe:      func(context.Context, setup.InstalledComponent) error { return nil },
		InUse:      func(string) bool { return false },
	}, setup.ComponentSelector{Kind: setup.ComponentKindHarness, ID: "managed-cli", Version: "1.0.0"})
	require.NoError(t, err)

	resolved := managedHarnesses(manifest, ownership, setup.LoadActivationState(dataRoot), dataRoot)
	require.Len(t, resolved, 1)
	require.Equal(t, target, resolved["managed-cli"].Binary)
	require.Equal(t, "1.0.0", resolved["managed-cli"].Version)
	require.NoError(t, resolved["managed-cli"].Verify())

	// A rejected activation ledger yields no managed candidate at all.
	require.Empty(t, managedHarnesses(manifest, ownership, setup.ActivationState{Rejection: fmt.Errorf("unreadable")}, dataRoot))

	// Drifted bytes are refused at resolution, and the live Verify keeps refusing afterwards.
	require.NoError(t, os.WriteFile(target, []byte("tampered"), 0o755))
	require.Error(t, resolved["managed-cli"].Verify())
	require.Empty(t, managedHarnesses(manifest, ownership, setup.LoadActivationState(dataRoot), dataRoot))
}
