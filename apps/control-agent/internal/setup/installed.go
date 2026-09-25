package setup

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// ErrComponentNotInstalled reports that nothing is installed at a component's target path, which is
// the ordinary state of a node where setup was never applied for that component.
var ErrComponentNotInstalled = errors.New("component is not installed")

// InstalledComponent is a setup-installed component executable that matched the ownership ledger
// when it was verified.
type InstalledComponent struct {
	Entry         ComponentManifestEntry
	Path          string
	ContentSHA256 string
	dataRoot      string
}

// Ref is the verified component's shared identity.
func (installed InstalledComponent) Ref() ComponentRef {
	return installed.Entry.Ref()
}

// VerifyInstalledComponent confirms that setup installed entry's executable for platform under
// dataRoot and that it is unchanged since: every directory from the data root down to the
// executable is a real directory (never a symlink), the executable is a regular file, the ledger
// records it for exactly this component kind, ID, and version, and its current SHA-256 equals the
// ledger's. It never repairs or follows anything and performs no write.
func VerifyInstalledComponent(dataRoot string, entry ComponentManifestEntry, platform string, ledger OwnershipLedger) (InstalledComponent, error) {
	distribution, supported := entry.Platforms[platform]
	if !supported {
		return InstalledComponent{}, fmt.Errorf("%w: no platform distribution for %s", ErrComponentNotInstalled, platform)
	}
	if !filepath.IsAbs(dataRoot) {
		return InstalledComponent{}, errors.New("data root must be an absolute path")
	}
	target, err := ComponentTargetPath(dataRoot, entry, distribution)
	if err != nil {
		return InstalledComponent{}, err
	}
	if _, err := os.Lstat(target); errors.Is(err, fs.ErrNotExist) {
		return InstalledComponent{}, ErrComponentNotInstalled
	}
	record, owned := ledger.RecordFor(target)
	if !owned {
		return InstalledComponent{}, errors.New("component executable is not recorded in the ownership ledger")
	}
	if record.Component != entry.Ref() {
		return InstalledComponent{}, errors.New("ownership ledger records a different component, kind, or version at the target path")
	}
	installed := InstalledComponent{Entry: entry, Path: target, ContentSHA256: strings.ToLower(record.ContentSHA256), dataRoot: dataRoot}
	if err := installed.Verify(); err != nil {
		return InstalledComponent{}, err
	}
	return installed, nil
}

// Verify re-checks containment, file type, and content against the digest recorded when the
// component was verified, so a later launch never trusts the earlier check alone.
func (installed InstalledComponent) Verify() error {
	if _, err := verifyDirectoryWithinRoot(installed.dataRoot, filepath.Dir(installed.Path)); err != nil {
		return fmt.Errorf("component install directory is not safely contained in the data root: %w", err)
	}
	information, err := os.Lstat(installed.Path)
	if err != nil {
		return fmt.Errorf("inspect component executable: %w", err)
	}
	if !information.Mode().IsRegular() {
		return errors.New("component executable is not a regular file")
	}
	digest, err := fileChecksum(installed.Path)
	if err != nil {
		return fmt.Errorf("read component executable: %w", err)
	}
	if digest != installed.ContentSHA256 {
		return errors.New("component executable content no longer matches the ownership ledger")
	}
	return nil
}
