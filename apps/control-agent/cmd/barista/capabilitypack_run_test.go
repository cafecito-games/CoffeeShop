package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/capabilitypack"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/harness"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/setup"
)

// installedCapabilityPack installs and, when asked, activates the repository's own capability pack
// through the real plan, apply, and activation lifecycle, and returns the data root plus the parsed
// manifest. It reaches no network: the pack is a manual distribution whose bytes the caller supplies.
func installedCapabilityPack(t *testing.T, activate bool) (dataRoot string, manifest setup.Manifest, packManifest capabilitypack.PackManifest, digest string) {
	t.Helper()
	tree, err := capabilitypack.ReadTree(filepath.Join("..", "..", "..", "..", "capability-pack"))
	require.NoError(t, err)
	archive, packManifest, err := capabilitypack.BuildArchive(tree, capabilitypack.DefaultVocabulary())
	require.NoError(t, err)
	digest = capabilitypack.ArchiveDigest(archive)

	platform := setup.CurrentPlatform()
	manifestBytes := packManifestBytes(platform)
	manifest, err = setup.ParseManifest(manifestBytes)
	require.NoError(t, err)
	dataRoot = t.TempDir()
	plan, _, err := setup.BuildPlan(manifestBytes, manifest, platform, dataRoot, setup.OwnershipLedger{})
	require.NoError(t, err)
	source := filepath.Join(t.TempDir(), "coffeeshop-capability-pack.tar.gz")
	require.NoError(t, os.WriteFile(source, archive, 0o644))
	_, err = setup.Apply(context.Background(), plan, manifestBytes, setup.OwnershipLedger{}, dataRoot, setup.ApplyOptions{
		ManualArtifactSources: map[string]string{packManifest.ID: source},
		ManualChecksums:       map[string]string{packManifest.ID: digest},
	})
	require.NoError(t, err)
	if !activate {
		return dataRoot, manifest, packManifest, digest
	}
	ownership, err := setup.LoadOwnershipLedger(dataRoot)
	require.NoError(t, err)
	_, err = setup.Activate(context.Background(), setup.ActivationContext{
		DataRoot: dataRoot, Manifest: manifest, Platform: platform, Ownership: ownership,
		Activation: setup.LoadActivationState(dataRoot),
		Probe:      componentProbe("test-client", map[string]string{}),
		InUse:      func(string) bool { return false },
	}, setup.ComponentSelector{Kind: setup.ComponentKindCapabilityPack, ID: packManifest.ID, Version: packManifest.Version})
	require.NoError(t, err)
	return dataRoot, manifest, packManifest, digest
}

func loadedLedgers(t *testing.T, dataRoot string) (setup.OwnershipLedger, setup.ActivationState) {
	t.Helper()
	ownership, err := setup.LoadOwnershipLedger(dataRoot)
	require.NoError(t, err)
	return ownership, setup.LoadActivationState(dataRoot)
}

// TestActiveCapabilityPackResolvesTheOneActivatedArchive is the resolution half of this issue: the
// capability-pack sibling of managedHarnesses resolves exactly the activated archive, re-verifies its
// bytes, and hands the harness package a pack bound to one id, version, and archive digest.
func TestActiveCapabilityPackResolvesTheOneActivatedArchive(t *testing.T) {
	dataRoot, manifest, packManifest, digest := installedCapabilityPack(t, true)
	ownership, activation := loadedLedgers(t, dataRoot)

	pack, unavailable := activeCapabilityPack(manifest, ownership, activation, dataRoot, "barista-test-build")
	require.Empty(t, unavailable)
	require.NotNil(t, pack)
	require.Equal(t, packManifest.ID, pack.ID)
	require.Equal(t, packManifest.Version, pack.Version)
	require.Equal(t, digest, pack.ArchiveDigest)
	require.Equal(t, packManifest.ID+"@"+packManifest.Version+"@"+digest, pack.Identity())
	require.Equal(t, "barista-test-build", pack.Build)
	require.Len(t, pack.Manifest.Skills, len(packManifest.Skills))

	// The tree is exactly the archive's, and the skills parse through the one parser.
	declared := []string{capabilitypack.PackManifestPath}
	for _, file := range packManifest.Files {
		declared = append(declared, file.Path)
	}
	require.ElementsMatch(t, declared, pack.Tree.Paths())
	names, err := pack.SkillNamesByDirectory()
	require.NoError(t, err)
	require.Len(t, names, len(packManifest.Skills))

	// Reread is what every projection re-verifies with, and it agrees with the startup resolution.
	tree, rereadManifest, rereadDigest, err := pack.Reread()
	require.NoError(t, err)
	require.Equal(t, pack.Tree, tree)
	require.Equal(t, packManifest.Version, rereadManifest.Version)
	require.Equal(t, digest, rereadDigest)

	// Tampered bytes make Reread fail rather than return a different pack, so no projection happens.
	installed, err := setup.ActiveInstalledComponent(dataRoot, manifest, setup.CurrentPlatform(), ownership, activation,
		setup.ComponentSelector{Kind: setup.ComponentKindCapabilityPack, ID: packManifest.ID}.Identity())
	require.NoError(t, err)
	original, err := os.ReadFile(installed.Path)
	require.NoError(t, err)
	tampered := append([]byte{}, original...)
	tampered[len(tampered)/2] ^= 0xff
	require.NoError(t, os.WriteFile(installed.Path, tampered, 0o644))
	_, _, _, err = pack.Reread()
	require.Error(t, err)
	require.NoError(t, os.WriteFile(installed.Path, original, 0o644))
}

// TestActivationLedgerRejectionDistinctFromNoSelection proves the two are never reported as each
// other, which is the difference between "the operator's ledger is broken" and "the operator has not
// chosen a pack yet".
func TestActivationLedgerRejectionDistinctFromNoSelection(t *testing.T) {
	dataRoot, manifest, _, _ := installedCapabilityPack(t, false)
	ownership, activation := loadedLedgers(t, dataRoot)

	// Nothing selected.
	require.Nil(t, activation.Rejection)
	pack, noSelection := activeCapabilityPack(manifest, ownership, activation, dataRoot, "b")
	require.Nil(t, pack)
	require.Equal(t, "no capability pack version is activated on this node", noSelection)

	// A rejected ledger. The reason names the ledger and never the selection.
	require.NoError(t, os.WriteFile(filepath.Join(dataRoot, "activation.json"), []byte("{not json"), 0o644))
	rejected := setup.LoadActivationState(dataRoot)
	require.NotNil(t, rejected.Rejection)
	pack, rejection := activeCapabilityPack(manifest, ownership, rejected, dataRoot, "b")
	require.Nil(t, pack)
	require.Equal(t, "the activation ledger could not be accepted, so no capability pack was resolved", rejection)
	require.NotEqual(t, noSelection, rejection)

	// A selection whose bytes stopped verifying is a third, distinct reason.
	require.NoError(t, os.Remove(filepath.Join(dataRoot, "activation.json")))
	activated, _, packManifest, _ := installedCapabilityPack(t, true)
	activatedOwnership, activatedActivation := loadedLedgers(t, activated)
	installed, err := setup.ActiveInstalledComponent(activated, manifest, setup.CurrentPlatform(), activatedOwnership, activatedActivation,
		setup.ComponentSelector{Kind: setup.ComponentKindCapabilityPack, ID: packManifest.ID}.Identity())
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(installed.Path, []byte("not an archive"), 0o644))
	pack, drifted := activeCapabilityPack(manifest, activatedOwnership, activatedActivation, activated, "b")
	require.Nil(t, pack)
	require.Equal(t, "the activated capability pack version could not be verified", drifted)
	require.NotEqual(t, noSelection, drifted)
	require.NotEqual(t, rejection, drifted)

	// Every reason is a distinct, non-empty string, so no consumer can confuse two of them.
	reasons := map[string]bool{}
	for _, reason := range []string{noSelection, rejection, drifted} {
		require.NotEmpty(t, reason)
		require.False(t, reasons[reason])
		reasons[reason] = true
	}
}

// TestManifestPackVersionMatchesPackJSON keeps the component manifest's declared pack version equal
// to the canonical pack's own, which is the single source of truth for pack identity.
func TestManifestPackVersionMatchesPackJSON(t *testing.T) {
	manifest, err := setup.LoadDefaultManifest()
	require.NoError(t, err)
	entries := manifest.ComponentsOfKind(setup.ComponentKindCapabilityPack)
	require.Len(t, entries, 1, "exactly one capability pack entry")

	source, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "capability-pack", capabilitypack.PackManifestPath))
	require.NoError(t, err)
	packManifest, err := capabilitypack.ParsePackManifest(source)
	require.NoError(t, err)
	require.Equal(t, packManifest.ID, entries[0].ID)
	require.Equal(t, packManifest.Version, entries[0].Version)
}

// TestPackReadyReportNamesEveryCombination proves the operator log never leaves a harness and
// transport unaccounted for: every combination is either named as having a verified adapter or named
// as shipping none, and the ACP combinations are in the second group because neither ACP adapter's
// skill-discovery surface has been verified at its pinned version.
func TestPackReadyReportNamesEveryCombination(t *testing.T) {
	lines := packReadyHarnessIDs()
	require.Len(t, lines, 4)
	ready, unready := 0, 0
	for _, line := range lines {
		switch {
		case strings.Contains(line, "has a verified activation adapter"):
			ready++
			require.True(t, strings.Contains(line, harness.TransportNative), "only native surfaces are verified: %s", line)
		case strings.Contains(line, "ships no activation adapter"):
			unready++
			require.True(t, strings.Contains(line, harness.TransportACP), "only ACP surfaces are unverified: %s", line)
			require.True(t, strings.Contains(line, "refuses a pack-required run before the prompt"))
		default:
			t.Fatalf("a harness and transport combination is neither reported ready nor reported unready: %s", line)
		}
	}
	require.Equal(t, 2, ready)
	require.Equal(t, 2, unready)
}
