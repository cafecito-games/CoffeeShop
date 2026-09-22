package setup

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// ErrAdapterNotInstalled reports that nothing is installed at an adapter's target path, which is
// the ordinary state of a node where setup was never applied for that adapter.
var ErrAdapterNotInstalled = errors.New("adapter is not installed")

// InstalledAdapter is a setup-installed adapter executable that matched the ownership ledger when
// it was verified.
type InstalledAdapter struct {
	Entry         AdapterManifestEntry
	Path          string
	ContentSHA256 string
	dataRoot      string
}

// VerifyInstalledAdapter confirms that setup installed entry's executable for platform under
// dataRoot and that it is unchanged since: every directory from the data root down to the
// executable is a real directory (never a symlink), the executable is a regular file, the ledger
// records it for exactly this adapter ID and version, and its current SHA-256 equals the ledger's.
// It never repairs or follows anything and performs no write.
func VerifyInstalledAdapter(dataRoot string, entry AdapterManifestEntry, platform string, ledger OwnershipLedger) (InstalledAdapter, error) {
	distribution, supported := entry.Platforms[platform]
	if !supported {
		return InstalledAdapter{}, fmt.Errorf("%w: no platform distribution for %s", ErrAdapterNotInstalled, platform)
	}
	if !filepath.IsAbs(dataRoot) {
		return InstalledAdapter{}, errors.New("data root must be an absolute path")
	}
	target := AdapterTargetPath(dataRoot, entry, distribution)
	if _, err := os.Lstat(target); errors.Is(err, fs.ErrNotExist) {
		return InstalledAdapter{}, ErrAdapterNotInstalled
	}
	record, owned := ledger.RecordFor(target)
	if !owned {
		return InstalledAdapter{}, errors.New("adapter executable is not recorded in the ownership ledger")
	}
	if record.AdapterID != entry.ID || record.AdapterVersion != entry.Version {
		return InstalledAdapter{}, errors.New("ownership ledger records a different adapter or version at the target path")
	}
	installed := InstalledAdapter{Entry: entry, Path: target, ContentSHA256: strings.ToLower(record.ContentSHA256), dataRoot: dataRoot}
	if err := installed.Verify(); err != nil {
		return InstalledAdapter{}, err
	}
	return installed, nil
}

// Verify re-checks containment, file type, and content against the digest recorded when the
// adapter was verified, so a later launch never trusts the earlier check alone.
func (installed InstalledAdapter) Verify() error {
	if _, err := verifyDirectoryWithinRoot(installed.dataRoot, filepath.Dir(installed.Path)); err != nil {
		return fmt.Errorf("adapter install directory is not safely contained in the data root: %w", err)
	}
	information, err := os.Lstat(installed.Path)
	if err != nil {
		return fmt.Errorf("inspect adapter executable: %w", err)
	}
	if !information.Mode().IsRegular() {
		return errors.New("adapter executable is not a regular file")
	}
	digest, err := fileChecksum(installed.Path)
	if err != nil {
		return fmt.Errorf("read adapter executable: %w", err)
	}
	if digest != installed.ContentSHA256 {
		return errors.New("adapter executable content no longer matches the ownership ledger")
	}
	return nil
}
