package acpadapter

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/config"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/setup"
	"github.com/stretchr/testify/require"
)

func codexManifestEntry() setup.ComponentManifestEntry {
	return setup.ComponentManifestEntry{
		ID:        "codex-acp",
		Kind:      setup.ComponentKindACPAdapter,
		HarnessID: "codex-cli",
		Provider:  "openai",
		Label:     "Codex ACP adapter",
		Version:   "1.12.0",
		Platforms: map[string]setup.PlatformDistribution{
			setup.CurrentPlatform(): {Kind: setup.DistributionKindManual, ExecutablePath: "bin/codex-acp"},
		},
		Launch: setup.LaunchTemplate{Arguments: []string{"--mode", "agent"}, Environment: []string{"CODEX_HOME=/srv/codex"}},
	}
}

func claudeManifestEntry() setup.ComponentManifestEntry {
	entry := codexManifestEntry()
	entry.ID = "claude-acp"
	entry.HarnessID = "claude-cli"
	entry.Provider = "anthropic"
	entry.Label = "Claude ACP adapter"
	entry.Version = "1.2.0"
	return entry
}

func twoHarnessManifest() setup.Manifest {
	return setup.Manifest{ManifestVersion: setup.ManifestVersion, Components: []setup.ComponentManifestEntry{codexManifestEntry(), claudeManifestEntry()}}
}

// installLedgerVerifiedCodex writes a ledger-verified codex adapter into dataRoot, persisting the
// ledger the way setup apply does.
func installLedgerVerifiedCodex(t *testing.T, dataRoot string) string {
	t.Helper()
	entry := codexManifestEntry()
	target, err := setup.ComponentTargetPath(dataRoot, entry, entry.Platforms[setup.CurrentPlatform()])
	require.NoError(t, err)
	require.NoError(t, os.MkdirAll(filepath.Dir(target), 0o755))
	require.NoError(t, os.WriteFile(target, []byte("codex adapter payload"), 0o755))
	digest := sha256.Sum256([]byte("codex adapter payload"))
	ledger := setup.OwnershipLedger{}.WithRecord(setup.OwnershipRecord{
		Path:          target,
		Component:     entry.Ref(),
		HarnessID:     entry.HarnessID,
		ContentSHA256: hex.EncodeToString(digest[:]),
		SizeBytes:     int64(len("codex adapter payload")),
		InstalledAt:   "2026-09-21T12:00:00Z",
	})
	require.NoError(t, ledger.Save(dataRoot))
	return target
}

// activateInstalled records the activation of one installed component exactly the way
// setup.Activate does, so every test that expects an adapter to load selects it explicitly.
func activateInstalled(t *testing.T, dataRoot string, entry setup.ComponentManifestEntry, previous *setup.ActivationTarget) setup.ActivationState {
	t.Helper()
	target, err := setup.ComponentTargetPath(dataRoot, entry, entry.Platforms[setup.CurrentPlatform()])
	require.NoError(t, err)
	content, err := os.ReadFile(target)
	require.NoError(t, err)
	digest := sha256.Sum256(content)
	ledger := setup.ActivationLedger{}.WithRecord(setup.ActivationRecord{
		Active:   setup.ActivationTarget{Component: entry.Ref(), Path: target, ContentSHA256: hex.EncodeToString(digest[:])},
		Previous: previous,
	})
	require.NoError(t, ledger.Save(dataRoot))
	return setup.LoadActivationState(dataRoot)
}

// writeOverrideExecutable writes a regular executable file and returns its path and real digest.
func writeOverrideExecutable(t *testing.T, content string) (string, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "administrator-adapter")
	require.NoError(t, os.WriteFile(path, []byte(content), 0o755))
	digest := sha256.Sum256([]byte(content))
	return path, hex.EncodeToString(digest[:])
}

func loadAdapters(t *testing.T, options Options) Result {
	t.Helper()
	result, err := Load(options)
	require.NoError(t, err)
	return result
}

func TestLoadWithoutADataRootReportsNoInstalledAdapter(t *testing.T) {
	result := loadAdapters(t, Options{
		DataRoot: filepath.Join(t.TempDir(), "never-created"),
		Manifest: twoHarnessManifest(),
		Platform: setup.CurrentPlatform(),
	})

	require.Empty(t, result.Adapters)
	require.Equal(t, "no adapter version is activated for this harness", result.Skipped["codex-cli"])
	require.Equal(t, "no adapter version is activated for this harness", result.Skipped["claude-cli"])
}

func TestLoadReturnsALedgerVerifiedAdapter(t *testing.T) {
	dataRoot := t.TempDir()
	target := installLedgerVerifiedCodex(t, dataRoot)
	activation := activateInstalled(t, dataRoot, codexManifestEntry(), nil)

	result := loadAdapters(t, Options{DataRoot: dataRoot, Manifest: twoHarnessManifest(), Platform: setup.CurrentPlatform(), Activation: activation})

	adapter, present := result.Adapters["codex-cli"]
	require.True(t, present)
	require.Equal(t, target, adapter.Binary)
	require.Equal(t, "codex-acp", adapter.ID)
	require.Equal(t, "1.12.0", adapter.Version)
	require.Equal(t, protocol.ACPAdapterSourceSetupLedger, adapter.Source)
	require.Equal(t, []string{"--mode", "agent"}, adapter.Arguments)
	require.Equal(t, []string{"CODEX_HOME=/srv/codex"}, adapter.Environment)
	require.NoError(t, adapter.Verify())
	require.Equal(t, "no adapter version is activated for this harness", result.Skipped["claude-cli"])

	// The returned Verify is live, not a record of the load-time check.
	require.NoError(t, os.WriteFile(target, []byte("tampered payload"), 0o755))
	require.Error(t, adapter.Verify())
}

func TestLoadSkipsATamperedInstall(t *testing.T) {
	dataRoot := t.TempDir()
	target := installLedgerVerifiedCodex(t, dataRoot)
	activation := activateInstalled(t, dataRoot, codexManifestEntry(), nil)
	require.NoError(t, os.WriteFile(target, []byte("tampered payload"), 0o755))

	result := loadAdapters(t, Options{DataRoot: dataRoot, Manifest: twoHarnessManifest(), Platform: setup.CurrentPlatform(), Activation: activation})

	require.NotContains(t, result.Adapters, "codex-cli")
	require.Contains(t, result.Skipped["codex-cli"], "the activated adapter failed verification")
}

// TestLoadSkipsWhenTheActivationLedgerCannotBeAccepted proves a rejected activation file never reads
// as an absent selection: every managed adapter is unavailable with that reason.
func TestLoadSkipsWhenTheActivationLedgerCannotBeAccepted(t *testing.T) {
	dataRoot := t.TempDir()
	installLedgerVerifiedCodex(t, dataRoot)
	activateInstalled(t, dataRoot, codexManifestEntry(), nil)
	require.NoError(t, os.WriteFile(filepath.Join(dataRoot, "activation.json"), []byte("{not json"), 0o644))

	result := loadAdapters(t, Options{
		DataRoot: dataRoot, Manifest: twoHarnessManifest(), Platform: setup.CurrentPlatform(),
		Activation: setup.LoadActivationState(dataRoot),
	})

	require.Empty(t, result.Adapters)
	require.Equal(t, "the activation ledger could not be accepted", result.Skipped["codex-cli"])
	require.Equal(t, "the activation ledger could not be accepted", result.Skipped["claude-cli"])
}

// installLedgerVerifiedEntries installs and records every entry, returning the shared ledger.
func installLedgerVerifiedEntries(t *testing.T, dataRoot string, entries ...setup.ComponentManifestEntry) {
	t.Helper()
	ledger := setup.OwnershipLedger{}
	for _, entry := range entries {
		target, err := setup.ComponentTargetPath(dataRoot, entry, entry.Platforms[setup.CurrentPlatform()])
		require.NoError(t, err)
		require.NoError(t, os.MkdirAll(filepath.Dir(target), 0o755))
		payload := []byte("codex adapter payload " + entry.Version)
		require.NoError(t, os.WriteFile(target, payload, 0o755))
		digest := sha256.Sum256(payload)
		ledger = ledger.WithRecord(setup.OwnershipRecord{
			Path: target, Component: entry.Ref(), HarnessID: entry.HarnessID,
			ContentSHA256: hex.EncodeToString(digest[:]), SizeBytes: int64(len(payload)), InstalledAt: "2026-09-21T12:00:00Z",
		})
	}
	require.NoError(t, ledger.Save(dataRoot))
}

// TestLoadSelectsActivatedAdapterAmongMany is the concrete failure this issue resolves: two verified
// installed adapters for one harness used to make Load refuse both (load.go's
// "more than one installed adapter matches the harness"). The activation record now decides, and the
// unselected adapter is never launched.
func TestLoadSelectsActivatedAdapterAmongMany(t *testing.T) {
	dataRoot := t.TempDir()
	alternate := codexManifestEntry()
	alternate.ID = "codex-alt"
	alternate.Version = "0.9.0"
	manifest := setup.Manifest{ManifestVersion: setup.ManifestVersion, Components: []setup.ComponentManifestEntry{codexManifestEntry(), alternate}}
	require.NoError(t, manifest.Validate())
	installLedgerVerifiedEntries(t, dataRoot, codexManifestEntry(), alternate)

	// The alternate, lower-versioned, later-declared adapter is selected deliberately, so a passing
	// test cannot be explained by a highest-version, manifest-order, or ledger-order rule.
	activation := activateInstalled(t, dataRoot, alternate, nil)
	alternateTarget, err := setup.ComponentTargetPath(dataRoot, alternate, alternate.Platforms[setup.CurrentPlatform()])
	require.NoError(t, err)

	result := loadAdapters(t, Options{DataRoot: dataRoot, Manifest: manifest, Platform: setup.CurrentPlatform(), Activation: activation})

	adapter, present := result.Adapters["codex-cli"]
	require.True(t, present)
	require.Equal(t, alternateTarget, adapter.Binary)
	require.Equal(t, "codex-alt", adapter.ID)
	require.Equal(t, "0.9.0", adapter.Version)
	require.NotContains(t, result.Skipped, "codex-cli")
}

// TestLoadSkipsWhenTwoActivatedAdapterComponentsMatchOneHarness keeps the ambiguity refusal for the
// case nothing actually chose: two *different* adapter components, each with its own activation
// record, both claiming one harness.
func TestLoadSkipsWhenTwoActivatedAdapterComponentsMatchOneHarness(t *testing.T) {
	dataRoot := t.TempDir()
	alternate := codexManifestEntry()
	alternate.ID = "codex-alt"
	alternate.Version = "0.9.0"
	manifest := setup.Manifest{ManifestVersion: setup.ManifestVersion, Components: []setup.ComponentManifestEntry{codexManifestEntry(), alternate}}
	installLedgerVerifiedEntries(t, dataRoot, codexManifestEntry(), alternate)
	activateInstalled(t, dataRoot, codexManifestEntry(), nil)
	// Both identities are activated, which is a genuine ambiguity: neither may launch.
	first := setup.LoadActivationState(dataRoot).Ledger
	alternateTarget, err := setup.ComponentTargetPath(dataRoot, alternate, alternate.Platforms[setup.CurrentPlatform()])
	require.NoError(t, err)
	alternateContent, err := os.ReadFile(alternateTarget)
	require.NoError(t, err)
	alternateDigest := sha256.Sum256(alternateContent)
	require.NoError(t, first.WithRecord(setup.ActivationRecord{Active: setup.ActivationTarget{
		Component: alternate.Ref(), Path: alternateTarget, ContentSHA256: hex.EncodeToString(alternateDigest[:]),
	}}).Save(dataRoot))

	result := loadAdapters(t, Options{
		DataRoot: dataRoot, Manifest: manifest, Platform: setup.CurrentPlatform(),
		Activation: setup.LoadActivationState(dataRoot),
	})

	require.NotContains(t, result.Adapters, "codex-cli")
	require.Equal(t, "more than one activated adapter matches the harness", result.Skipped["codex-cli"])
}

func TestLoadSkipsEveryHarnessWhenTheLedgerCannotBeRead(t *testing.T) {
	dataRoot := t.TempDir()
	installLedgerVerifiedCodex(t, dataRoot)
	require.NoError(t, os.WriteFile(filepath.Join(dataRoot, "ownership.json"), []byte("not a ledger"), 0o644))

	result := loadAdapters(t, Options{DataRoot: dataRoot, Manifest: twoHarnessManifest(), Platform: setup.CurrentPlatform()})

	require.Empty(t, result.Adapters)
	require.Equal(t, "the ownership ledger could not be read", result.Skipped["codex-cli"])
	require.Equal(t, "the ownership ledger could not be read", result.Skipped["claude-cli"])
}

// TestLoadOverrideWinsOverActivation proves the administrator override still wins over an activation
// record for the same harness — the precedence Barista has always applied, unchanged.
func TestLoadOverrideWinsOverActivation(t *testing.T) {
	dataRoot := t.TempDir()
	installLedgerVerifiedCodex(t, dataRoot)
	activation := activateInstalled(t, dataRoot, codexManifestEntry(), nil)
	path, digest := writeOverrideExecutable(t, "administrator adapter payload")

	result := loadAdapters(t, Options{
		DataRoot:   dataRoot,
		Manifest:   twoHarnessManifest(),
		Platform:   setup.CurrentPlatform(),
		Overrides:  []config.ACPAdapterOverride{{HarnessID: "codex-cli", SHA256: digest, Path: path}},
		Activation: activation,
	})

	adapter, present := result.Adapters["codex-cli"]
	require.True(t, present)
	require.Equal(t, path, adapter.Binary)
	require.Equal(t, "codex-acp", adapter.ID)
	require.Equal(t, "1.12.0", adapter.Version)
	require.Equal(t, protocol.ACPAdapterSourceAdministrator, adapter.Source)
	require.Equal(t, []string{"--mode", "agent"}, adapter.Arguments)
	require.NoError(t, adapter.Verify())
	require.NotContains(t, result.Skipped, "codex-cli")
}

func TestLoadRejectsOverridesThatCannotBeVerified(t *testing.T) {
	validPath, validDigest := writeOverrideExecutable(t, "administrator adapter payload")
	regularFile := filepath.Join(t.TempDir(), "plain-file")
	require.NoError(t, os.WriteFile(regularFile, []byte("not executable"), 0o644))

	tests := []struct {
		name      string
		prepare   func(t *testing.T) config.ACPAdapterOverride
		manifest  func() setup.Manifest
		skipOnWin bool
	}{
		{
			name: "digest mismatch",
			prepare: func(t *testing.T) config.ACPAdapterOverride {
				path, _ := writeOverrideExecutable(t, "different content than pinned")
				return config.ACPAdapterOverride{HarnessID: "codex-cli", SHA256: validDigest, Path: path}
			},
		},
		{
			name: "symlink path",
			prepare: func(t *testing.T) config.ACPAdapterOverride {
				path, digest := writeOverrideExecutable(t, "administrator adapter payload")
				link := filepath.Join(t.TempDir(), "adapter-link")
				require.NoError(t, os.Symlink(path, link))
				return config.ACPAdapterOverride{HarnessID: "codex-cli", SHA256: digest, Path: link}
			},
			skipOnWin: true,
		},
		{
			name: "non-executable file",
			prepare: func(t *testing.T) config.ACPAdapterOverride {
				digest := sha256.Sum256([]byte("not executable"))
				return config.ACPAdapterOverride{HarnessID: "codex-cli", SHA256: hex.EncodeToString(digest[:]), Path: regularFile}
			},
			skipOnWin: true,
		},
		{
			name: "missing file",
			prepare: func(t *testing.T) config.ACPAdapterOverride {
				return config.ACPAdapterOverride{HarnessID: "codex-cli", SHA256: validDigest, Path: filepath.Join(t.TempDir(), "absent")}
			},
		},
		{
			name: "harness without a manifest entry",
			prepare: func(t *testing.T) config.ACPAdapterOverride {
				return config.ACPAdapterOverride{HarnessID: "shell", SHA256: validDigest, Path: validPath}
			},
		},
		{
			name: "harness with two manifest entries",
			prepare: func(t *testing.T) config.ACPAdapterOverride {
				return config.ACPAdapterOverride{HarnessID: "codex-cli", SHA256: validDigest, Path: validPath}
			},
			manifest: func() setup.Manifest {
				alternate := codexManifestEntry()
				alternate.ID = "codex-alt"
				alternate.Version = "0.9.0"
				return setup.Manifest{ManifestVersion: setup.ManifestVersion, Components: []setup.ComponentManifestEntry{codexManifestEntry(), alternate}}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if test.skipOnWin && runtime.GOOS == "windows" {
				t.Skip("symlinks and executable bits need a unix filesystem")
			}
			override := test.prepare(t)
			manifest := twoHarnessManifest()
			if test.manifest != nil {
				manifest = test.manifest()
			}
			_, err := Load(Options{
				DataRoot:  t.TempDir(),
				Manifest:  manifest,
				Platform:  setup.CurrentPlatform(),
				Overrides: []config.ACPAdapterOverride{override},
			})
			require.Error(t, err)
			require.Contains(t, err.Error(), "index 0")
			require.NotContains(t, err.Error(), override.Path)
			require.NotContains(t, err.Error(), override.SHA256)
		})
	}
}
