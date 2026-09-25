package setup

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/require"
)

// adapterExecutableContent is the stand-in adapter payload; every rejection message must be
// asserted free of it, since echoing file content into an error could leak whatever an attacker
// planted at the target path.
const adapterExecutableContent = "fake-adapter-executable-payload"

func installedTestEntry() ComponentManifestEntry {
	return ComponentManifestEntry{
		ID:        "codex-acp",
		Kind:      ComponentKindACPAdapter,
		HarnessID: "codex-cli",
		Provider:  "openai",
		Label:     "Codex ACP adapter",
		Version:   "1.12.0",
		Platforms: map[string]PlatformDistribution{
			CurrentPlatform(): {Kind: DistributionKindManual, ExecutablePath: "bin/adapter"},
		},
		Launch: LaunchTemplate{Arguments: []string{"--mode", "agent"}, Environment: []string{"CODEX_HOME=/srv/codex"}},
	}
}

// writeInstalledExecutable places the adapter payload at entry's target path without recording it
// anywhere, so each test controls the ledger independently.
func writeInstalledExecutable(t *testing.T, dataRoot string, entry ComponentManifestEntry) string {
	t.Helper()
	target, err := ComponentTargetPath(dataRoot, entry, entry.Platforms[CurrentPlatform()])
	require.NoError(t, err)
	require.NoError(t, os.MkdirAll(filepath.Dir(target), 0o755))
	require.NoError(t, os.WriteFile(target, []byte(adapterExecutableContent), 0o755))
	return target
}

func ledgerRecording(target string, entry ComponentManifestEntry, checksum string) OwnershipLedger {
	return OwnershipLedger{}.WithRecord(OwnershipRecord{
		Path:          target,
		Component:     entry.Ref(),
		HarnessID:     entry.HarnessID,
		ContentSHA256: checksum,
		SizeBytes:     int64(len(adapterExecutableContent)),
		InstalledAt:   "2026-09-21T12:00:00Z",
	})
}

// installLedgerVerifiedAdapter writes the payload and records its real digest, the state a
// successful setup apply leaves behind.
func installLedgerVerifiedAdapter(t *testing.T, dataRoot string, entry ComponentManifestEntry) (string, OwnershipLedger) {
	t.Helper()
	target := writeInstalledExecutable(t, dataRoot, entry)
	checksum, err := fileChecksum(target)
	require.NoError(t, err)
	return target, ledgerRecording(target, entry, checksum)
}

func TestVerifyInstalledComponentAcceptsALedgerVerifiedInstall(t *testing.T) {
	dataRoot := t.TempDir()
	entry := installedTestEntry()
	target, ledger := installLedgerVerifiedAdapter(t, dataRoot, entry)

	installed, err := VerifyInstalledComponent(dataRoot, entry, CurrentPlatform(), ledger)
	require.NoError(t, err)
	require.Equal(t, target, installed.Path)
	checksum, err := fileChecksum(target)
	require.NoError(t, err)
	require.Equal(t, checksum, installed.ContentSHA256)
	require.Equal(t, entry, installed.Entry)
	require.NoError(t, installed.Verify())
}

func TestVerifyInstalledComponentRejectsMissingPlatformDistribution(t *testing.T) {
	entry := installedTestEntry()
	entry.Platforms = map[string]PlatformDistribution{"other-arch": entry.Platforms[CurrentPlatform()]}

	_, err := VerifyInstalledComponent(t.TempDir(), entry, CurrentPlatform(), OwnershipLedger{})
	require.ErrorIs(t, err, ErrComponentNotInstalled)
}

func TestVerifyInstalledComponentRejectsAbsentExecutable(t *testing.T) {
	dataRoot := t.TempDir()
	entry := installedTestEntry()
	target, ledger := installLedgerVerifiedAdapter(t, dataRoot, entry)
	require.NoError(t, os.Remove(target))

	_, err := VerifyInstalledComponent(dataRoot, entry, CurrentPlatform(), ledger)
	require.ErrorIs(t, err, ErrComponentNotInstalled)
}

func TestVerifyInstalledComponentRejectsExecutableMissingFromTheLedger(t *testing.T) {
	dataRoot := t.TempDir()
	entry := installedTestEntry()
	writeInstalledExecutable(t, dataRoot, entry)

	_, err := VerifyInstalledComponent(dataRoot, entry, CurrentPlatform(), OwnershipLedger{})
	require.Error(t, err)
	require.NotErrorIs(t, err, ErrComponentNotInstalled)
	require.NotContains(t, err.Error(), adapterExecutableContent)
}

func TestVerifyInstalledComponentRejectsLedgerComponentMismatch(t *testing.T) {
	dataRoot := t.TempDir()
	entry := installedTestEntry()
	target, ledger := installLedgerVerifiedAdapter(t, dataRoot, entry)

	wrongAdapter := ledgerRecording(target, entry, ledger.Records[0].ContentSHA256)
	wrongAdapter.Records[0].Component.ID = "claude-acp"
	_, err := VerifyInstalledComponent(dataRoot, entry, CurrentPlatform(), wrongAdapter)
	require.Error(t, err)
	require.NotErrorIs(t, err, ErrComponentNotInstalled)
	require.Contains(t, err.Error(), "ownership ledger records a different component, kind, or version")
	require.NotContains(t, err.Error(), adapterExecutableContent)

	wrongVersion := ledgerRecording(target, entry, ledger.Records[0].ContentSHA256)
	wrongVersion.Records[0].Component.Version = "0.9.0"
	_, err = VerifyInstalledComponent(dataRoot, entry, CurrentPlatform(), wrongVersion)
	require.Error(t, err)
	require.Contains(t, err.Error(), "ownership ledger records a different component, kind, or version")
}

func TestVerifyInstalledComponentRejectsTamperedContent(t *testing.T) {
	dataRoot := t.TempDir()
	entry := installedTestEntry()
	target, ledger := installLedgerVerifiedAdapter(t, dataRoot, entry)
	require.NoError(t, os.WriteFile(target, []byte("tampered-adapter-executable-payload"), 0o755))

	_, err := VerifyInstalledComponent(dataRoot, entry, CurrentPlatform(), ledger)
	require.Error(t, err)
	require.Contains(t, err.Error(), "component executable content no longer matches the ownership ledger")
	require.NotContains(t, err.Error(), adapterExecutableContent)
}

func TestVerifyInstalledComponentRejectsASymlinkedExecutable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks require privileges on windows")
	}
	dataRoot := t.TempDir()
	entry := installedTestEntry()
	target, ledger := installLedgerVerifiedAdapter(t, dataRoot, entry)
	relocated := filepath.Join(t.TempDir(), "relocated-adapter")
	require.NoError(t, os.Rename(target, relocated))
	require.NoError(t, os.Symlink(relocated, target))

	_, err := VerifyInstalledComponent(dataRoot, entry, CurrentPlatform(), ledger)
	require.Error(t, err)
	require.Contains(t, err.Error(), "component executable is not a regular file")
}

func TestVerifyInstalledComponentRejectsASymlinkedAncestorDirectory(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks require privileges on windows")
	}
	dataRoot := t.TempDir()
	entry := installedTestEntry()
	_, ledger := installLedgerVerifiedAdapter(t, dataRoot, entry)

	harnessDirectory := filepath.Join(dataRoot, "adapters", entry.HarnessID)
	relocated := filepath.Join(t.TempDir(), "relocated-harness")
	require.NoError(t, os.Rename(harnessDirectory, relocated))
	require.NoError(t, os.Symlink(relocated, harnessDirectory))

	_, err := VerifyInstalledComponent(dataRoot, entry, CurrentPlatform(), ledger)
	require.Error(t, err)
	require.Contains(t, err.Error(), "component install directory is not safely contained in the data root")
}

func TestVerifyInstalledComponentRejectsRelativeDataRoot(t *testing.T) {
	entry := installedTestEntry()

	_, err := VerifyInstalledComponent("relative/data-root", entry, CurrentPlatform(), OwnershipLedger{})
	require.EqualError(t, err, "data root must be an absolute path")
}

func TestInstalledComponentVerifyDetectsLaterDrift(t *testing.T) {
	dataRoot := t.TempDir()
	entry := installedTestEntry()
	target, ledger := installLedgerVerifiedAdapter(t, dataRoot, entry)
	installed, err := VerifyInstalledComponent(dataRoot, entry, CurrentPlatform(), ledger)
	require.NoError(t, err)

	// A previous verification must never stand in for a fresh one: content changed underneath it.
	file, err := os.OpenFile(target, os.O_WRONLY|os.O_APPEND, 0o755)
	require.NoError(t, err)
	_, err = file.WriteString(" appended after verification")
	require.NoError(t, err)
	require.NoError(t, file.Close())
	require.Error(t, installed.Verify())

	if runtime.GOOS != "windows" {
		relocated := filepath.Join(t.TempDir(), "relocated-adapter")
		require.NoError(t, os.Rename(target, relocated))
		require.NoError(t, os.Symlink(relocated, target))
		require.Error(t, installed.Verify())
	}
}
