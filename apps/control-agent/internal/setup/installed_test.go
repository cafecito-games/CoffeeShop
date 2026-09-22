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

func installedTestEntry() AdapterManifestEntry {
	return AdapterManifestEntry{
		ID:        "codex-acp",
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
func writeInstalledExecutable(t *testing.T, dataRoot string, entry AdapterManifestEntry) string {
	t.Helper()
	target := AdapterTargetPath(dataRoot, entry, entry.Platforms[CurrentPlatform()])
	require.NoError(t, os.MkdirAll(filepath.Dir(target), 0o755))
	require.NoError(t, os.WriteFile(target, []byte(adapterExecutableContent), 0o755))
	return target
}

func ledgerRecording(target string, entry AdapterManifestEntry, checksum string) OwnershipLedger {
	return OwnershipLedger{}.WithRecord(OwnershipRecord{
		Path:           target,
		AdapterID:      entry.ID,
		AdapterVersion: entry.Version,
		ContentSHA256:  checksum,
		SizeBytes:      int64(len(adapterExecutableContent)),
		InstalledAt:    "2026-09-21T12:00:00Z",
	})
}

// installLedgerVerifiedAdapter writes the payload and records its real digest, the state a
// successful setup apply leaves behind.
func installLedgerVerifiedAdapter(t *testing.T, dataRoot string, entry AdapterManifestEntry) (string, OwnershipLedger) {
	t.Helper()
	target := writeInstalledExecutable(t, dataRoot, entry)
	checksum, err := fileChecksum(target)
	require.NoError(t, err)
	return target, ledgerRecording(target, entry, checksum)
}

func TestVerifyInstalledAdapterAcceptsALedgerVerifiedInstall(t *testing.T) {
	dataRoot := t.TempDir()
	entry := installedTestEntry()
	target, ledger := installLedgerVerifiedAdapter(t, dataRoot, entry)

	installed, err := VerifyInstalledAdapter(dataRoot, entry, CurrentPlatform(), ledger)
	require.NoError(t, err)
	require.Equal(t, target, installed.Path)
	checksum, err := fileChecksum(target)
	require.NoError(t, err)
	require.Equal(t, checksum, installed.ContentSHA256)
	require.Equal(t, entry, installed.Entry)
	require.NoError(t, installed.Verify())
}

func TestVerifyInstalledAdapterRejectsMissingPlatformDistribution(t *testing.T) {
	entry := installedTestEntry()
	entry.Platforms = map[string]PlatformDistribution{"other-arch": entry.Platforms[CurrentPlatform()]}

	_, err := VerifyInstalledAdapter(t.TempDir(), entry, CurrentPlatform(), OwnershipLedger{})
	require.ErrorIs(t, err, ErrAdapterNotInstalled)
}

func TestVerifyInstalledAdapterRejectsAbsentExecutable(t *testing.T) {
	dataRoot := t.TempDir()
	entry := installedTestEntry()
	target, ledger := installLedgerVerifiedAdapter(t, dataRoot, entry)
	require.NoError(t, os.Remove(target))

	_, err := VerifyInstalledAdapter(dataRoot, entry, CurrentPlatform(), ledger)
	require.ErrorIs(t, err, ErrAdapterNotInstalled)
}

func TestVerifyInstalledAdapterRejectsExecutableMissingFromTheLedger(t *testing.T) {
	dataRoot := t.TempDir()
	entry := installedTestEntry()
	writeInstalledExecutable(t, dataRoot, entry)

	_, err := VerifyInstalledAdapter(dataRoot, entry, CurrentPlatform(), OwnershipLedger{})
	require.Error(t, err)
	require.NotErrorIs(t, err, ErrAdapterNotInstalled)
	require.NotContains(t, err.Error(), adapterExecutableContent)
}

func TestVerifyInstalledAdapterRejectsLedgerAdapterMismatch(t *testing.T) {
	dataRoot := t.TempDir()
	entry := installedTestEntry()
	target, ledger := installLedgerVerifiedAdapter(t, dataRoot, entry)

	wrongAdapter := ledgerRecording(target, entry, ledger.Records[0].ContentSHA256)
	wrongAdapter.Records[0].AdapterID = "claude-acp"
	_, err := VerifyInstalledAdapter(dataRoot, entry, CurrentPlatform(), wrongAdapter)
	require.Error(t, err)
	require.NotErrorIs(t, err, ErrAdapterNotInstalled)
	require.Contains(t, err.Error(), "ownership ledger records a different adapter or version")
	require.NotContains(t, err.Error(), adapterExecutableContent)

	wrongVersion := ledgerRecording(target, entry, ledger.Records[0].ContentSHA256)
	wrongVersion.Records[0].AdapterVersion = "0.9.0"
	_, err = VerifyInstalledAdapter(dataRoot, entry, CurrentPlatform(), wrongVersion)
	require.Error(t, err)
	require.Contains(t, err.Error(), "ownership ledger records a different adapter or version")
}

func TestVerifyInstalledAdapterRejectsTamperedContent(t *testing.T) {
	dataRoot := t.TempDir()
	entry := installedTestEntry()
	target, ledger := installLedgerVerifiedAdapter(t, dataRoot, entry)
	require.NoError(t, os.WriteFile(target, []byte("tampered-adapter-executable-payload"), 0o755))

	_, err := VerifyInstalledAdapter(dataRoot, entry, CurrentPlatform(), ledger)
	require.Error(t, err)
	require.Contains(t, err.Error(), "adapter executable content no longer matches the ownership ledger")
	require.NotContains(t, err.Error(), adapterExecutableContent)
}

func TestVerifyInstalledAdapterRejectsASymlinkedExecutable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks require privileges on windows")
	}
	dataRoot := t.TempDir()
	entry := installedTestEntry()
	target, ledger := installLedgerVerifiedAdapter(t, dataRoot, entry)
	relocated := filepath.Join(t.TempDir(), "relocated-adapter")
	require.NoError(t, os.Rename(target, relocated))
	require.NoError(t, os.Symlink(relocated, target))

	_, err := VerifyInstalledAdapter(dataRoot, entry, CurrentPlatform(), ledger)
	require.Error(t, err)
	require.Contains(t, err.Error(), "adapter executable is not a regular file")
}

func TestVerifyInstalledAdapterRejectsASymlinkedAncestorDirectory(t *testing.T) {
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

	_, err := VerifyInstalledAdapter(dataRoot, entry, CurrentPlatform(), ledger)
	require.Error(t, err)
	require.Contains(t, err.Error(), "adapter install directory is not safely contained in the data root")
}

func TestVerifyInstalledAdapterRejectsRelativeDataRoot(t *testing.T) {
	entry := installedTestEntry()

	_, err := VerifyInstalledAdapter("relative/data-root", entry, CurrentPlatform(), OwnershipLedger{})
	require.EqualError(t, err, "data root must be an absolute path")
}

func TestInstalledAdapterVerifyDetectsLaterDrift(t *testing.T) {
	dataRoot := t.TempDir()
	entry := installedTestEntry()
	target, ledger := installLedgerVerifiedAdapter(t, dataRoot, entry)
	installed, err := VerifyInstalledAdapter(dataRoot, entry, CurrentPlatform(), ledger)
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
