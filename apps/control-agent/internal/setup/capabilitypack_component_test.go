package setup

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// capabilityPackEntry is the shape of the shipped capability-pack manifest entry: a manual
// distribution of one archive on every supported platform, with no launch template and a harness
// identity of its own that belongs to no provider CLI.
func capabilityPackEntry(version string) ComponentManifestEntry {
	return ComponentManifestEntry{
		ID:        "coffeeshop-capability-pack",
		Kind:      ComponentKindCapabilityPack,
		HarnessID: "coffee-shop",
		Provider:  "cafecito-games",
		Label:     "Coffee Shop capability pack",
		Version:   version,
		Platforms: map[string]PlatformDistribution{
			"darwin-arm64": {Kind: DistributionKindManual, ExecutablePath: "coffeeshop-capability-pack.tar.gz"},
			testPlatform:   {Kind: DistributionKindManual, ExecutablePath: "coffeeshop-capability-pack.tar.gz"},
		},
		Launch: LaunchTemplate{},
	}
}

// TestApplyInstallsACapabilityPackComponent proves the generalized lifecycle admits the third kind end
// to end: it plans to its own directory segment, installs one regular file there, is recorded in the
// ownership ledger under its own kind, verifies through VerifyInstalledComponent, and does not resolve
// as either of the other two kinds. The existing adapters/ and harnesses/ layouts are asserted
// unchanged in the same test, because a new kind that moved an installed component would orphan it.
func TestApplyInstallsACapabilityPackComponent(t *testing.T) {
	manifestBytes := []byte(`{"manifestVersion":"` + ManifestVersion + `","components":[` +
		`{"id":"coffeeshop-capability-pack","kind":"capability-pack","harnessId":"coffee-shop","provider":"cafecito-games",` +
		`"label":"Coffee Shop capability pack","version":"1.0.0",` +
		`"platforms":{"` + testPlatform + `":{"kind":"manual","executablePath":"coffeeshop-capability-pack.tar.gz"}},"launch":{}},` +
		`{"id":"fixture-cli","kind":"harness","harnessId":"fixture-cli","provider":"fixture-vendor",` +
		`"label":"Fixture harness","version":"2.1.0",` +
		`"platforms":{"` + testPlatform + `":{"kind":"manual","executablePath":"bin/fixture"}},"launch":{}},` +
		`{"id":"fixture-acp","kind":"acp-adapter","harnessId":"fixture-cli","provider":"fixture-vendor",` +
		`"label":"Fixture adapter","version":"0.5.0",` +
		`"platforms":{"` + testPlatform + `":{"kind":"manual","executablePath":"bin/fixture-acp"}},"launch":{}}]}`)
	manifest, err := ParseManifest(manifestBytes)
	require.NoError(t, err)
	dataRoot := t.TempDir()
	plan, skipped, err := BuildPlan(manifestBytes, manifest, testPlatform, dataRoot, OwnershipLedger{})
	require.NoError(t, err)
	require.Empty(t, skipped)
	require.Len(t, plan.Operations, 3)
	wantTargets := map[ComponentKind]string{
		ComponentKindCapabilityPack: filepath.Join(dataRoot, "capability-packs", "coffee-shop", "coffeeshop-capability-pack", "1.0.0", "coffeeshop-capability-pack.tar.gz"),
		ComponentKindHarness:        filepath.Join(dataRoot, "harnesses", "fixture-cli", "fixture-cli", "2.1.0", "bin", "fixture"),
		ComponentKindACPAdapter:     filepath.Join(dataRoot, "adapters", "fixture-cli", "fixture-acp", "0.5.0", "bin", "fixture-acp"),
	}
	for _, operation := range plan.Operations {
		require.Equal(t, wantTargets[operation.Component.Kind], operation.TargetPath, "kind %s installed to the wrong directory", operation.Component.Kind)
	}

	artifact := []byte("deterministic pack archive bytes")
	source := filepath.Join(t.TempDir(), "coffeeshop-capability-pack.tar.gz")
	require.NoError(t, os.WriteFile(source, artifact, 0o644))
	harnessArtifact := []byte("#!/bin/sh\necho fixture harness\n")
	harnessSource := filepath.Join(t.TempDir(), "fixture")
	require.NoError(t, os.WriteFile(harnessSource, harnessArtifact, 0o755))
	adapterArtifact := []byte("#!/bin/sh\necho fixture adapter\n")
	adapterSource := filepath.Join(t.TempDir(), "fixture-acp")
	require.NoError(t, os.WriteFile(adapterSource, adapterArtifact, 0o755))
	result, err := Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, ApplyOptions{
		ManualArtifactSources: map[string]string{
			"coffeeshop-capability-pack": source,
			"fixture-cli":                harnessSource,
			"fixture-acp":                adapterSource,
		},
		ManualChecksums: map[string]string{
			"coffeeshop-capability-pack": sha256Hex(artifact),
			"fixture-cli":                sha256Hex(harnessArtifact),
			"fixture-acp":                sha256Hex(adapterArtifact),
		},
	})
	require.NoError(t, err)
	require.Len(t, result.Applied, 3)

	packTarget := wantTargets[ComponentKindCapabilityPack]
	installedBytes, err := os.ReadFile(packTarget)
	require.NoError(t, err)
	require.Equal(t, artifact, installedBytes, "the installed pack must be the exact bytes the operator asserted")
	ledger, err := LoadOwnershipLedger(dataRoot)
	require.NoError(t, err)
	record, owned := ledger.RecordFor(packTarget)
	require.True(t, owned, "the ownership ledger has no record for the installed capability pack")
	require.Equal(t, ComponentRef{Kind: ComponentKindCapabilityPack, ID: "coffeeshop-capability-pack", Version: "1.0.0"}, record.Component)

	packEntry := manifest.ComponentsOfKind(ComponentKindCapabilityPack)[0]
	installed, err := VerifyInstalledComponent(dataRoot, packEntry, testPlatform, ledger)
	require.NoError(t, err)
	require.Equal(t, packTarget, installed.Path)
	require.NoError(t, installed.Verify())

	// Verification is kind-aware: the same id under either other kind must not resolve, so a pack can
	// never stand in for a harness or an adapter.
	for _, kind := range []ComponentKind{ComponentKindHarness, ComponentKindACPAdapter} {
		mislabelled := packEntry
		mislabelled.Kind = kind
		_, err := VerifyInstalledComponent(dataRoot, mislabelled, testPlatform, ledger)
		require.Error(t, err, "a capability pack install resolved as kind %s", kind)
	}

	// A tampered artifact stops verifying, which is what keeps the activation probe from ever being
	// reached for drifted bytes.
	require.NoError(t, os.WriteFile(packTarget, append(installedBytes, 'x'), 0o644))
	require.Error(t, installed.Verify())
	_, err = VerifyInstalledComponent(dataRoot, packEntry, testPlatform, ledger)
	require.Error(t, err)
}

// TestCapabilityPackManifestRules proves the schema rules the new kind inherits and the ones it does
// not: its launch template must be empty for the same reason a harness's is, its harnessId need not
// equal its id, and it cannot occupy another entry's install target.
func TestCapabilityPackManifestRules(t *testing.T) {
	entry := capabilityPackEntry("1.0.0")
	require.NoError(t, declaredManifest(t, entry).Validate())

	withLaunch := entry
	withLaunch.Launch = LaunchTemplate{Arguments: []string{"--serve"}}
	manifest := Manifest{ManifestVersion: ManifestVersion, Components: []ComponentManifestEntry{withLaunch}}
	require.ErrorContains(t, manifest.Validate(), "launch template must be empty")

	// Two packs that would occupy the same target for a platform are refused by the existing
	// seenTargets check; the new kind must not weaken it.
	twin := entry
	twin.ID = entry.ID
	colliding := Manifest{ManifestVersion: ManifestVersion, Components: []ComponentManifestEntry{entry, twin}}
	require.Error(t, colliding.Validate())

	// A pack sharing a harness identity with another provider is refused, so the pack's own identity
	// can never be co-opted.
	conflicting := Manifest{ManifestVersion: ManifestVersion, Components: []ComponentManifestEntry{
		entry,
		{
			ID: "other-pack", Kind: ComponentKindCapabilityPack, HarnessID: "coffee-shop", Provider: "someone-else",
			Label: "Other", Version: "1.0.0",
			Platforms: map[string]PlatformDistribution{testPlatform: {Kind: DistributionKindManual, ExecutablePath: "other.tar.gz"}},
		},
	}}
	require.ErrorContains(t, conflicting.Validate(), "harnessId is already associated with a different provider")
}

// TestActivateAndRollbackACapabilityPack proves the activation lifecycle is the same for the third
// kind: a verified version activates, a refused probe writes nothing at all, and rollback re-selects
// the retained version.
func TestActivateAndRollbackACapabilityPack(t *testing.T) {
	first := capabilityPackEntry("1.0.0")
	second := capabilityPackEntry("2.0.0")
	fixture := newActivationFixture(t, first)
	fixture.install(t, second)

	calls := 0
	outcome, err := fixture.activate(t, first, "1.0.0", acceptingProbe(&calls), nil)
	require.NoError(t, err)
	require.True(t, outcome.Changed)
	require.Equal(t, 1, calls)
	require.Equal(t, "1.0.0", outcome.Active.Version)

	// A refused candidate leaves the activation ledger byte-for-byte as it was, so the prior version
	// stays active.
	before := activationFileBytes(t, fixture.dataRoot)
	_, err = fixture.activate(t, second, "2.0.0", refusingProbe(), nil)
	require.Error(t, err)
	require.Equal(t, before, activationFileBytes(t, fixture.dataRoot))
	active, err := ActiveInstalledComponent(fixture.dataRoot, fixture.manifest, fixture.platform,
		fixture.ledger, LoadActivationState(fixture.dataRoot), first.Ref().Identity())
	require.NoError(t, err)
	require.Equal(t, "1.0.0", active.Ref().Version)

	// An accepted upgrade retains the previous version, and rollback re-selects it.
	outcome, err = fixture.activate(t, second, "2.0.0", acceptingProbe(nil), nil)
	require.NoError(t, err)
	require.Equal(t, "2.0.0", outcome.Active.Version)
	require.NotNil(t, outcome.Previous)
	require.Equal(t, "1.0.0", outcome.Previous.Version)
	rolled, err := Rollback(context.Background(), fixture.context(acceptingProbe(nil), nil),
		ComponentSelector{Kind: ComponentKindCapabilityPack, ID: first.ID})
	require.NoError(t, err)
	require.Equal(t, "1.0.0", rolled.Active.Version)

	// Re-activating the currently active, still-verifying version writes nothing.
	unchangedBefore := activationFileBytes(t, fixture.dataRoot)
	replay, err := fixture.activate(t, first, "1.0.0", acceptingProbe(nil), nil)
	require.NoError(t, err)
	require.False(t, replay.Changed)
	require.Equal(t, unchangedBefore, activationFileBytes(t, fixture.dataRoot))
}

// TestDoctorReportsACapabilityPackWithoutAHarnessGap proves the report never presents a capability
// pack's absent harness as something to fix. The pack is harness-agnostic, so HarnessInstalled is
// false and HarnessApplicable says that false is not a gap.
func TestDoctorReportsACapabilityPackWithoutAHarnessGap(t *testing.T) {
	entry := capabilityPackEntry("1.0.0")
	dataRoot := t.TempDir()
	ledger, target := installOwnedComponent(t, dataRoot, OwnershipLedger{}, entry, []byte("pack archive"))
	require.NoError(t, ledger.Save(dataRoot))
	report := RunDoctor(context.Background(), declaredManifest(t, entry), ledger, dataRoot, "darwin-arm64",
		LoadActivationState(dataRoot), nil, "", nil)
	doctorEntry := doctorEntryFor(report, entry.ID)
	require.Equal(t, target, doctorEntry.ComponentPath)
	require.True(t, doctorEntry.ComponentInstalled)
	require.False(t, doctorEntry.HarnessApplicable, "a capability pack has no harness of its own")
	require.False(t, doctorEntry.HarnessInstalled)
	require.False(t, doctorEntry.ACPLaunchReady, "a capability pack is never ACP-launch-ready")
	require.Equal(t, ComponentProvenanceNone, doctorEntry.Provenance)
	for _, note := range doctorEntry.Notes {
		require.NotContains(t, note, "harness", "a capability pack must never be reported as having a missing harness: %q", note)
	}
	// Every other kind keeps a meaningful harness column.
	for _, kind := range ComponentKinds {
		if kind == ComponentKindCapabilityPack {
			require.False(t, kind.HasHarnessOfItsOwn())
			continue
		}
		require.True(t, kind.HasHarnessOfItsOwn(), "kind %s lost its harness association", kind)
	}
}

func TestCapabilityPackAssessmentUsesTheRuntimeArchiveResolution(t *testing.T) {
	entry := capabilityPackEntry("1.0.0")
	fixture := newActivationFixture(t, entry)
	_, err := fixture.activate(t, entry, entry.Version, acceptingProbe(nil), nil)
	require.NoError(t, err)
	activation := LoadActivationState(fixture.dataRoot)

	rejected := AssessComponents(context.Background(), fixture.manifest, fixture.ledger, fixture.dataRoot, fixture.platform,
		activation, nil, ComponentAssessmentOptions{CapabilityPackResolutionKnown: true})
	require.Len(t, rejected, 1)
	require.Equal(t, entry.Version, rejected[0].ActiveVersion, "the selected version remains visible as diagnostic context")
	require.Equal(t, ComponentProvenanceNone, rejected[0].Provenance)
	require.Equal(t, "not-applicable", rejected[0].Readiness)
	require.Contains(t, rejected[0].DiagnosticCodes, "active-unverified")

	resolved := entry.Ref()
	accepted := AssessComponents(context.Background(), fixture.manifest, fixture.ledger, fixture.dataRoot, fixture.platform,
		activation, nil, ComponentAssessmentOptions{CapabilityPackResolutionKnown: true, ResolvedCapabilityPack: &resolved})
	require.Len(t, accepted, 1)
	require.Equal(t, ComponentProvenanceManaged, accepted[0].Provenance)
	require.NotContains(t, accepted[0].DiagnosticCodes, "active-unverified")
}
