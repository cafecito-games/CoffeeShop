// Package acpadapter decides which ACP adapter executables the Barista daemon may launch. It reads
// only verified sources: an adapter setup installed and recorded in the ownership ledger, or an
// executable an administrator named and pinned by digest. It never searches PATH, downloads, or
// installs anything.
package acpadapter

import (
	"errors"
	"fmt"
	"os"
	"runtime"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/config"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/harness"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/setup"
)

// Options describes where to look for adapters.
type Options struct {
	DataRoot  string
	Manifest  setup.Manifest
	Platform  string
	Overrides []config.ACPAdapterOverride
}

// Result holds the adapters that may be launched, keyed by harness ID, and a non-secret reason for
// each manifest harness that has none.
type Result struct {
	Adapters map[string]harness.ACPAdapter
	Skipped  map[string]string
}

// Load verifies every administrator override and every setup-installed adapter. An override that
// cannot be verified is an error, because the administrator explicitly asked for that executable
// and running without it, or with the setup-installed one instead, would silently ignore that
// choice. A setup-installed adapter that fails verification is only skipped: its harness keeps the
// native transport, and the reason is reported.
func Load(options Options) (Result, error) {
	result := Result{Adapters: map[string]harness.ACPAdapter{}, Skipped: map[string]string{}}
	entries := map[string][]setup.AdapterManifestEntry{}
	for _, entry := range options.Manifest.Adapters {
		entries[entry.HarnessID] = append(entries[entry.HarnessID], entry)
	}
	for index, override := range options.Overrides {
		candidates := entries[override.HarnessID]
		if len(candidates) != 1 {
			return Result{}, fmt.Errorf("acp adapter at index %d names a harness without exactly one manifest adapter", index)
		}
		adapter, err := verifiedOverride(candidates[0], override)
		if err != nil {
			return Result{}, fmt.Errorf("acp adapter at index %d: %w", index, err)
		}
		result.Adapters[override.HarnessID] = adapter
	}

	ledger, ledgerErr := setup.LoadOwnershipLedger(options.DataRoot)
	for harnessID, candidates := range entries {
		if _, overridden := result.Adapters[harnessID]; overridden {
			continue
		}
		if ledgerErr != nil {
			result.Skipped[harnessID] = "the ownership ledger could not be read"
			continue
		}
		verified := []setup.InstalledAdapter{}
		for _, entry := range candidates {
			installed, err := setup.VerifyInstalledAdapter(options.DataRoot, entry, options.Platform, ledger)
			if errors.Is(err, setup.ErrAdapterNotInstalled) {
				continue
			}
			if err != nil {
				result.Skipped[harnessID] = "installed adapter failed verification: " + err.Error()
				verified = nil
				break
			}
			verified = append(verified, installed)
		}
		switch {
		case result.Skipped[harnessID] != "":
		case len(verified) == 0:
			result.Skipped[harnessID] = "no adapter is installed"
		case len(verified) > 1:
			result.Skipped[harnessID] = "more than one installed adapter matches the harness"
		default:
			result.Adapters[harnessID] = installedAdapter(verified[0])
		}
	}
	return result, nil
}

func installedAdapter(installed setup.InstalledAdapter) harness.ACPAdapter {
	return harness.ACPAdapter{
		Binary:      installed.Path,
		Arguments:   installed.Entry.Launch.Arguments,
		Environment: installed.Entry.Launch.Environment,
		ID:          installed.Entry.ID,
		Version:     installed.Entry.Version,
		Source:      protocol.ACPAdapterSourceSetupLedger,
		Verify:      installed.Verify,
	}
}

func verifiedOverride(entry setup.AdapterManifestEntry, override config.ACPAdapterOverride) (harness.ACPAdapter, error) {
	verify := func() error { return verifyPinnedExecutable(override.Path, override.SHA256) }
	if err := verify(); err != nil {
		return harness.ACPAdapter{}, err
	}
	return harness.ACPAdapter{
		Binary:      override.Path,
		Arguments:   entry.Launch.Arguments,
		Environment: entry.Launch.Environment,
		ID:          entry.ID,
		Version:     entry.Version,
		Source:      protocol.ACPAdapterSourceAdministrator,
		Verify:      verify,
	}, nil
}

// verifyPinnedExecutable requires path itself to be a regular, executable file (not a symlink,
// which could be repointed after verification) whose content has the pinned digest.
func verifyPinnedExecutable(path, digest string) error {
	information, err := os.Lstat(path)
	if err != nil {
		return errors.New("the executable could not be inspected")
	}
	if !information.Mode().IsRegular() {
		return errors.New("the path must name a regular file, not a symlink or directory")
	}
	if runtime.GOOS != "windows" && information.Mode().Perm()&0o111 == 0 {
		return errors.New("the file is not executable")
	}
	if err := setup.VerifyFileChecksum(path, digest); err != nil {
		return errors.New("the file does not match its pinned sha256")
	}
	return nil
}
