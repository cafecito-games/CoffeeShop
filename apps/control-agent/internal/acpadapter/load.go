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
	// Activation is the loaded activation evidence. Which installed adapter version Barista may
	// launch comes from here and nowhere else: an absent record means no version is selected, and a
	// rejected file means every managed adapter is unavailable with that reason.
	Activation setup.ActivationState
}

// Result holds the adapters that may be launched, keyed by harness ID, and a non-secret reason for
// each manifest harness that has none.
type Result struct {
	Adapters map[string]harness.ACPAdapter
	Skipped  map[string]string
}

// Load verifies every administrator override and every activated setup-installed adapter. An
// override that cannot be verified is an error, because the administrator explicitly asked for that
// executable and running without it, or with the setup-installed one instead, would silently ignore
// that choice — and an override always wins over an activation record for the same harness, which is
// the precedence Barista has always applied. A managed adapter that is not activated, or whose
// activated version fails verification, is only skipped: its harness keeps the native transport, and
// the reason is reported.
func Load(options Options) (Result, error) {
	result := Result{Adapters: map[string]harness.ACPAdapter{}, Skipped: map[string]string{}}
	// Only ACP adapter components can be launched as an adapter; a harness component in the same
	// manifest is not a candidate here and must never be substituted for one.
	entries := map[string][]setup.ComponentManifestEntry{}
	for _, entry := range options.Manifest.ComponentsOfKind(setup.ComponentKindACPAdapter) {
		entries[entry.HarnessID] = append(entries[entry.HarnessID], entry)
	}
	for index, override := range options.Overrides {
		candidates := entries[override.HarnessID]
		if len(candidates) != 1 {
			return Result{}, fmt.Errorf("acp adapter at index %d names a harness without exactly one manifest ACP adapter", index)
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
		if options.Activation.Rejection != nil {
			result.Skipped[harnessID] = "the activation ledger could not be accepted"
			continue
		}
		// Selection is by component identity, which is the activation ledger's key: two installed
		// versions of one adapter resolve to the one version its activation record selects rather
		// than being refused as ambiguous. Two *different* adapter components for one harness both
		// being activated stays ambiguous, because nothing chose between them.
		selected := []setup.InstalledComponent{}
		seen := map[setup.ComponentIdentity]bool{}
		for _, entry := range candidates {
			identity := entry.Ref().Identity()
			if seen[identity] {
				continue
			}
			seen[identity] = true
			installed, err := setup.ActiveInstalledComponent(options.DataRoot, options.Manifest, options.Platform, ledger, options.Activation, identity)
			switch {
			case errors.Is(err, setup.ErrComponentNotActivated), errors.Is(err, setup.ErrComponentNotInstalled):
				continue
			case err != nil:
				result.Skipped[harnessID] = "the activated adapter failed verification: " + err.Error()
				selected = nil
			default:
				selected = append(selected, installed)
			}
			if result.Skipped[harnessID] != "" {
				break
			}
		}
		switch {
		case result.Skipped[harnessID] != "":
		case len(selected) == 0:
			result.Skipped[harnessID] = "no adapter version is activated for this harness"
		case len(selected) > 1:
			result.Skipped[harnessID] = "more than one activated adapter matches the harness"
		default:
			result.Adapters[harnessID] = installedAdapter(selected[0])
		}
	}
	return result, nil
}

func installedAdapter(installed setup.InstalledComponent) harness.ACPAdapter {
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

func verifiedOverride(entry setup.ComponentManifestEntry, override config.ACPAdapterOverride) (harness.ACPAdapter, error) {
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
