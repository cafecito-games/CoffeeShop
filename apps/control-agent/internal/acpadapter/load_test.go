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

func codexManifestEntry() setup.AdapterManifestEntry {
	return setup.AdapterManifestEntry{
		ID:        "codex-acp",
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

func claudeManifestEntry() setup.AdapterManifestEntry {
	entry := codexManifestEntry()
	entry.ID = "claude-acp"
	entry.HarnessID = "claude-cli"
	entry.Provider = "anthropic"
	entry.Label = "Claude ACP adapter"
	entry.Version = "1.2.0"
	return entry
}

func twoHarnessManifest() setup.Manifest {
	return setup.Manifest{ManifestVersion: setup.ManifestVersion, Adapters: []setup.AdapterManifestEntry{codexManifestEntry(), claudeManifestEntry()}}
}

// installLedgerVerifiedCodex writes a ledger-verified codex adapter into dataRoot, persisting the
// ledger the way setup apply does.
func installLedgerVerifiedCodex(t *testing.T, dataRoot string) string {
	t.Helper()
	entry := codexManifestEntry()
	target := setup.AdapterTargetPath(dataRoot, entry, entry.Platforms[setup.CurrentPlatform()])
	require.NoError(t, os.MkdirAll(filepath.Dir(target), 0o755))
	require.NoError(t, os.WriteFile(target, []byte("codex adapter payload"), 0o755))
	digest := sha256.Sum256([]byte("codex adapter payload"))
	ledger := setup.OwnershipLedger{}.WithRecord(setup.OwnershipRecord{
		Path:           target,
		AdapterID:      entry.ID,
		AdapterVersion: entry.Version,
		ContentSHA256:  hex.EncodeToString(digest[:]),
		SizeBytes:      int64(len("codex adapter payload")),
		InstalledAt:    "2026-09-21T12:00:00Z",
	})
	require.NoError(t, ledger.Save(dataRoot))
	return target
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
	require.Equal(t, "no adapter is installed", result.Skipped["codex-cli"])
	require.Equal(t, "no adapter is installed", result.Skipped["claude-cli"])
}

func TestLoadReturnsALedgerVerifiedAdapter(t *testing.T) {
	dataRoot := t.TempDir()
	target := installLedgerVerifiedCodex(t, dataRoot)

	result := loadAdapters(t, Options{DataRoot: dataRoot, Manifest: twoHarnessManifest(), Platform: setup.CurrentPlatform()})

	adapter, present := result.Adapters["codex-cli"]
	require.True(t, present)
	require.Equal(t, target, adapter.Binary)
	require.Equal(t, "codex-acp", adapter.ID)
	require.Equal(t, "1.12.0", adapter.Version)
	require.Equal(t, protocol.ACPAdapterSourceSetupLedger, adapter.Source)
	require.Equal(t, []string{"--mode", "agent"}, adapter.Arguments)
	require.Equal(t, []string{"CODEX_HOME=/srv/codex"}, adapter.Environment)
	require.NoError(t, adapter.Verify())
	require.Equal(t, "no adapter is installed", result.Skipped["claude-cli"])

	// The returned Verify is live, not a record of the load-time check.
	require.NoError(t, os.WriteFile(target, []byte("tampered payload"), 0o755))
	require.Error(t, adapter.Verify())
}

func TestLoadSkipsATamperedInstall(t *testing.T) {
	dataRoot := t.TempDir()
	target := installLedgerVerifiedCodex(t, dataRoot)
	require.NoError(t, os.WriteFile(target, []byte("tampered payload"), 0o755))

	result := loadAdapters(t, Options{DataRoot: dataRoot, Manifest: twoHarnessManifest(), Platform: setup.CurrentPlatform()})

	require.NotContains(t, result.Adapters, "codex-cli")
	require.Contains(t, result.Skipped["codex-cli"], "installed adapter failed verification")
}

func TestLoadSkipsWhenTwoInstalledAdaptersMatchOneHarness(t *testing.T) {
	dataRoot := t.TempDir()
	alternate := codexManifestEntry()
	alternate.ID = "codex-alt"
	alternate.Version = "0.9.0"
	manifest := setup.Manifest{ManifestVersion: setup.ManifestVersion, Adapters: []setup.AdapterManifestEntry{codexManifestEntry(), alternate}}

	ledger := setup.OwnershipLedger{}
	for _, entry := range manifest.Adapters {
		target := setup.AdapterTargetPath(dataRoot, entry, entry.Platforms[setup.CurrentPlatform()])
		require.NoError(t, os.MkdirAll(filepath.Dir(target), 0o755))
		require.NoError(t, os.WriteFile(target, []byte("codex adapter payload"), 0o755))
		digest := sha256.Sum256([]byte("codex adapter payload"))
		ledger = ledger.WithRecord(setup.OwnershipRecord{
			Path: target, AdapterID: entry.ID, AdapterVersion: entry.Version,
			ContentSHA256: hex.EncodeToString(digest[:]), InstalledAt: "2026-09-21T12:00:00Z",
		})
	}
	require.NoError(t, ledger.Save(dataRoot))

	result := loadAdapters(t, Options{DataRoot: dataRoot, Manifest: manifest, Platform: setup.CurrentPlatform()})

	require.NotContains(t, result.Adapters, "codex-cli")
	require.Equal(t, "more than one installed adapter matches the harness", result.Skipped["codex-cli"])
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

func TestLoadHonorsAVerifiedOverrideOverALedgerInstall(t *testing.T) {
	dataRoot := t.TempDir()
	installLedgerVerifiedCodex(t, dataRoot)
	path, digest := writeOverrideExecutable(t, "administrator adapter payload")

	result := loadAdapters(t, Options{
		DataRoot:  dataRoot,
		Manifest:  twoHarnessManifest(),
		Platform:  setup.CurrentPlatform(),
		Overrides: []config.ACPAdapterOverride{{HarnessID: "codex-cli", SHA256: digest, Path: path}},
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
				return setup.Manifest{ManifestVersion: setup.ManifestVersion, Adapters: []setup.AdapterManifestEntry{codexManifestEntry(), alternate}}
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
