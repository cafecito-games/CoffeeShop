package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/capabilitypack"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/setup"
)

// noProbeReason is the fail-closed default componentProbe returns for a kind it does not route. The
// closure test below asserts no kind in the vocabulary ever reaches it, because a kind that did could
// never be activated at all.
const noProbeReason = "has no activation probe"

// TestComponentProbeCoversEveryComponentKind is the activation half of the component-kind vocabulary
// closure. Every kind in setup.ComponentKinds must resolve a probe, and a kind outside the vocabulary
// must reach the fail-closed default instead of being activated unprobed. A fourth kind added without
// a probe case fails here rather than in production.
func TestComponentProbeCoversEveryComponentKind(t *testing.T) {
	probe := componentProbe("test-client", map[string]string{})
	directory := t.TempDir()
	for _, kind := range setup.ComponentKinds {
		installed := setup.InstalledComponent{
			Entry: setup.ComponentManifestEntry{
				ID: "fixture-component", Kind: kind, HarnessID: "fixture-component",
				Provider: "fixture-vendor", Label: "Fixture", Version: "1.0.0",
			},
			Path: filepath.Join(directory, "absent-artifact"),
		}
		err := probe(context.Background(), installed)
		require.Error(t, err, "kind %s accepted an absent artifact", kind)
		require.NotContains(t, err.Error(), noProbeReason, "component kind %s has no activation probe", kind)
	}
	outside := setup.InstalledComponent{
		Entry: setup.ComponentManifestEntry{ID: "vendor-installer", Kind: setup.ComponentKind("shell-installer"), Version: "1.0.0"},
		Path:  filepath.Join(directory, "absent-artifact"),
	}
	err := probe(context.Background(), outside)
	require.ErrorContains(t, err, noProbeReason)
}

// packManifestBytes declares only the capability pack, so applying the plan installs exactly one
// manual artifact and reaches no network.
func packManifestBytes(platform string, version string) []byte {
	return []byte(`{"manifestVersion":"` + setup.ManifestVersion + `","components":[` +
		`{"id":"coffeeshop-capability-pack","kind":"capability-pack","harnessId":"coffee-shop",` +
		`"provider":"cafecito-games","label":"Coffee Shop capability pack","version":"` + version + `",` +
		`"platforms":{"` + platform + `":{"kind":"manual","executablePath":"coffeeshop-capability-pack.tar.gz"}},` +
		`"launch":{}}]}`)
}

// TestActivateTheCanonicalCapabilityPackThroughItsProbe is the end-to-end proof that the pack the
// repository builds is the pack a node can install and activate: the archive is produced by the real
// packer, installed through the real plan and apply, and activated through the real compiled-in probe.
// A tampered artifact is then refused with both ledgers and the installed file left exactly as they
// were, so a failed activation keeps the prior selection.
func TestActivateTheCanonicalCapabilityPackThroughItsProbe(t *testing.T) {
	packRoot := filepath.Join("..", "..", "..", "..", "capability-pack")
	tree, err := capabilitypack.ReadTree(packRoot)
	require.NoError(t, err)
	archive, packManifest, err := capabilitypack.BuildArchive(tree, capabilitypack.DefaultVocabulary())
	require.NoError(t, err)

	platform := setup.CurrentPlatform()
	manifestBytes := packManifestBytes(platform, packManifest.Version)
	manifest, err := setup.ParseManifest(manifestBytes)
	require.NoError(t, err)
	require.Equal(t, packManifest.ID, manifest.Components[0].ID)
	require.Equal(t, packManifest.Version, manifest.Components[0].Version)

	dataRoot := t.TempDir()
	plan, _, err := setup.BuildPlan(manifestBytes, manifest, platform, dataRoot, setup.OwnershipLedger{})
	require.NoError(t, err)
	require.Len(t, plan.Operations, 1)
	source := filepath.Join(t.TempDir(), "coffeeshop-capability-pack.tar.gz")
	require.NoError(t, os.WriteFile(source, archive, 0o644))
	_, err = setup.Apply(context.Background(), plan, manifestBytes, setup.OwnershipLedger{}, dataRoot, setup.ApplyOptions{
		ManualArtifactSources: map[string]string{packManifest.ID: source},
		ManualChecksums:       map[string]string{packManifest.ID: capabilitypack.ArchiveDigest(archive)},
	})
	require.NoError(t, err)

	ledger, err := setup.LoadOwnershipLedger(dataRoot)
	require.NoError(t, err)
	activationContext := func() setup.ActivationContext {
		reloaded, err := setup.LoadOwnershipLedger(dataRoot)
		require.NoError(t, err)
		return setup.ActivationContext{
			DataRoot:   dataRoot,
			Manifest:   manifest,
			Platform:   platform,
			Ownership:  reloaded,
			Activation: setup.LoadActivationState(dataRoot),
			Probe:      componentProbe("test-client", map[string]string{}),
			InUse:      func(string) bool { return false },
		}
	}
	selector := setup.ComponentSelector{Kind: setup.ComponentKindCapabilityPack, ID: packManifest.ID, Version: packManifest.Version}
	outcome, err := setup.Activate(context.Background(), activationContext(), selector)
	require.NoError(t, err)
	require.True(t, outcome.Changed)
	require.Equal(t, packManifest.Version, outcome.Active.Version)

	// The activated pack resolves through the one launch-resolution path, and its bytes still verify.
	active, err := setup.ActiveInstalledComponent(dataRoot, manifest, platform, ledger, setup.LoadActivationState(dataRoot), selector.Identity())
	require.NoError(t, err)
	require.NoError(t, active.Verify())
	verified, err := capabilitypack.ProbeInstalledArtifact(active.Path, packManifest.ID, packManifest.Version)
	require.NoError(t, err)
	require.Len(t, verified.Skills, 4)

	// A pack whose bytes no longer validate is refused. Verification fails before the probe is even
	// reached, and nothing is written.
	activationBefore, err := os.ReadFile(filepath.Join(dataRoot, "activation.json"))
	require.NoError(t, err)
	ownershipBefore, err := os.ReadFile(filepath.Join(dataRoot, "ownership.json"))
	require.NoError(t, err)
	tampered := append([]byte{}, archive...)
	tampered[len(tampered)/2] ^= 0xff
	require.NoError(t, os.WriteFile(active.Path, tampered, 0o644))
	_, err = setup.Activate(context.Background(), activationContext(), selector)
	require.Error(t, err)
	activationAfter, err := os.ReadFile(filepath.Join(dataRoot, "activation.json"))
	require.NoError(t, err)
	ownershipAfter, err := os.ReadFile(filepath.Join(dataRoot, "ownership.json"))
	require.NoError(t, err)
	require.Equal(t, activationBefore, activationAfter, "a refused activation must leave the activation ledger untouched")
	require.Equal(t, ownershipBefore, ownershipAfter, "a refused activation must leave the ownership ledger untouched")

	// A well-formed pack whose declared identity is not the pinned one is refused by the probe itself,
	// after ownership verification passes — the case the identity cross-check exists for.
	require.NoError(t, os.WriteFile(active.Path, archive, 0o644))
	err = probeCapabilityPack(setup.InstalledComponent{
		Entry: setup.ComponentManifestEntry{
			ID: packManifest.ID, Kind: setup.ComponentKindCapabilityPack, HarnessID: "coffee-shop",
			Provider: "cafecito-games", Label: "Coffee Shop capability pack", Version: "9.9.9",
		},
		Path: active.Path,
	})
	require.Error(t, err)
	require.True(t, strings.Contains(err.Error(), "different pack version"), "probe error = %v", err)
}
