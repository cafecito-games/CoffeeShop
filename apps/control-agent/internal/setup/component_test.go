package setup

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// legacyManifestFixturePath holds the exact bytes of the generation-1 adapter manifest that shipped
// as the embedded manifest at the commit this schema generalized (it was
// internal/setup/manifest/adapters.json, embedded by manifest.go's //go:embed directive). It is a
// real producer artifact, not a hand-written fixture, and it is the byte-for-byte input a node
// administrator may still point --manifest at during the transition.
const legacyManifestFixturePath = "testdata/manifest-legacy-generation-1.json"

const (
	// legacyLedgerFixturePath holds ownership.json bytes produced by OwnershipLedger.Save at the
	// pre-generalization commit (ownership.go:56-92 there), so the migration is proven against what
	// the real producer wrote rather than against a hand-typed approximation.
	legacyLedgerFixturePath = "testdata/ownership-legacy-generation-1.json"
	// legacyLedgerAmbiguousFixturePath is the same producer's output for a record whose path names a
	// different adapter than its own adapterId — the ambiguous case migration must refuse.
	legacyLedgerAmbiguousFixturePath = "testdata/ownership-legacy-generation-1-ambiguous.json"
	// legacyLedgerFixtureDataRoot is the data root the fixture's absolute record paths live under.
	legacyLedgerFixtureDataRoot = "/var/lib/barista"
)

func readFixture(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture %s: %v", path, err)
	}
	return data
}

// TestComponentKindVocabularyIsClosed proves every consumer that must resolve a component kind
// handles every value in the vocabulary, and that a value outside it is refused rather than
// defaulted. A kind added to ComponentKinds without an install location would otherwise silently
// plan nothing, or worse, share another kind's directory.
func TestComponentKindVocabularyIsClosed(t *testing.T) {
	if len(ComponentKinds) != len(componentKindDirectories) {
		t.Fatalf("ComponentKinds has %d values but componentKindDirectories has %d", len(ComponentKinds), len(componentKindDirectories))
	}
	if len(ComponentKinds) != len(componentKindBehaviors) {
		t.Fatalf("ComponentKinds has %d values but componentKindBehaviors has %d", len(ComponentKinds), len(componentKindBehaviors))
	}
	seenDirectories := map[string]ComponentKind{}
	for _, kind := range ComponentKinds {
		if !kind.Valid() {
			t.Fatalf("ComponentKinds contains %q which ComponentKind.Valid rejects", kind)
		}
		directory, known := componentKindDirectories[kind]
		if !known || directory == "" {
			t.Fatalf("component kind %q has no install directory", kind)
		}
		if _, described := componentKindBehaviors[kind]; !described {
			t.Fatalf("component kind %q has no schema rules in componentKindBehaviors", kind)
		}
		if other, duplicate := seenDirectories[directory]; duplicate {
			t.Fatalf("component kinds %q and %q share the install directory %q", kind, other, directory)
		}
		seenDirectories[directory] = kind
		entry := ComponentManifestEntry{
			ID:        "fixture-component",
			Kind:      kind,
			HarnessID: "fixture-component",
			Provider:  "fixture-vendor",
			Label:     "Fixture component",
			Version:   "1.0.0",
			Platforms: map[string]PlatformDistribution{"linux-amd64": {Kind: DistributionKindManual, ExecutablePath: "bin/component"}},
		}
		if err := entry.Ref().Validate(); err != nil {
			t.Fatalf("component kind %q produces an invalid ref: %v", kind, err)
		}
		target, err := ComponentTargetPath("/data", entry, entry.Platforms["linux-amd64"])
		if err != nil {
			t.Fatalf("ComponentTargetPath() for kind %q error = %v", kind, err)
		}
		if !strings.HasPrefix(target, filepath.Join("/data", directory)+string(filepath.Separator)) {
			t.Fatalf("ComponentTargetPath() for kind %q = %s, want it under the kind's directory", kind, target)
		}
	}
	unknown := ComponentManifestEntry{Kind: ComponentKind("shell-installer")}
	if unknown.Kind.Valid() {
		t.Fatal("ComponentKind.Valid accepted a value outside the vocabulary")
	}
	if _, described := componentKindBehaviors[unknown.Kind]; described {
		t.Fatal("componentKindBehaviors describes a kind outside the vocabulary")
	}
	// A kind outside the vocabulary has no rules, and Manifest.Validate must refuse it rather than
	// validate it against no rules at all.
	unknownManifest := Manifest{ManifestVersion: ManifestVersion, Components: []ComponentManifestEntry{{
		ID: "vendor-installer", Kind: unknown.Kind, HarnessID: "vendor-installer", Provider: "vendor",
		Label: "Vendor installer", Version: "1.0.0",
		Platforms: map[string]PlatformDistribution{"linux-amd64": {Kind: DistributionKindManual, ExecutablePath: "bin/install"}},
	}}}
	if err := unknownManifest.Validate(); err == nil || !strings.Contains(err.Error(), "kind is unknown") {
		t.Fatalf("Manifest.Validate() for an unknown kind error = %v, want an unknown-kind refusal", err)
	}
	if unknown.Kind.HasHarnessOfItsOwn() {
		t.Fatal("an unknown component kind claimed a harness of its own")
	}
	if _, err := ComponentTargetPath("/data", unknown, PlatformDistribution{ExecutablePath: "bin/x"}); err == nil {
		t.Fatal("ComponentTargetPath() accepted an unknown component kind, want rejection")
	}
	if err := (ComponentRef{Kind: unknown.Kind, ID: "x", Version: "1.0.0"}).Validate(); err == nil {
		t.Fatal("ComponentRef.Validate() accepted an unknown component kind, want rejection")
	}
}

// TestDistributionKindVocabularyIsClosed proves every distribution kind has both a validation rule
// and exactly one install operation, and that an unknown kind reaches neither.
func TestDistributionKindVocabularyIsClosed(t *testing.T) {
	for _, kind := range DistributionKinds {
		if !kind.Valid() {
			t.Fatalf("DistributionKinds contains %q which DistributionKind.Valid rejects", kind)
		}
		operationKind, err := operationKindForDistribution(kind)
		if err != nil {
			t.Fatalf("distribution kind %q has no install operation: %v", kind, err)
		}
		if !operationKind.Valid() {
			t.Fatalf("distribution kind %q maps to unknown operation kind %q", kind, operationKind)
		}
		// Every kind must have a validation rule that is reached; an empty distribution of a known
		// kind must be rejected by that rule, never fall through the switch's default.
		if err := validatePlatformDistribution(PlatformDistribution{Kind: kind}); err == nil {
			t.Fatalf("validatePlatformDistribution() accepted an empty %q distribution", kind)
		}
	}
	unknown := DistributionKind("curl-pipe-sh")
	if unknown.Valid() {
		t.Fatal("DistributionKind.Valid accepted a value outside the vocabulary")
	}
	if _, err := operationKindForDistribution(unknown); err == nil {
		t.Fatal("operationKindForDistribution() accepted an unknown distribution kind, want rejection")
	}
	if err := validatePlatformDistribution(PlatformDistribution{Kind: unknown, ExecutablePath: "bin/x"}); err == nil {
		t.Fatal("validatePlatformDistribution() accepted an unknown distribution kind, want rejection")
	}
}

// TestOperationKindVocabularyIsClosed proves installOperation dispatches every operation kind and
// refuses anything else without mutating: an unknown kind must never fall through to a default that
// installs something.
func TestOperationKindVocabularyIsClosed(t *testing.T) {
	dataRoot := t.TempDir()
	for _, kind := range OperationKinds {
		if !kind.Valid() {
			t.Fatalf("OperationKinds contains %q which OperationKind.Valid rejects", kind)
		}
		operation := Operation{
			Kind:       kind,
			Component:  ComponentRef{Kind: ComponentKindACPAdapter, ID: "fixture-acp", Version: "1.0.0"},
			HarnessID:  "fixture-cli",
			TargetPath: filepath.Join(dataRoot, "adapters", "fixture-cli", "fixture-acp", "1.0.0", "bin", "adapter"),
			Source:     PlatformDistribution{Kind: DistributionKindManual, ExecutablePath: "bin/adapter"},
		}
		// Every known kind is dispatched to a handler: it fails for its own reason (no artifact, no
		// URL), never with the "operation kind is unknown" refusal.
		_, err := installOperation(context.Background(), operation, dataRoot, ApplyOptions{})
		if err == nil {
			t.Fatalf("installOperation() for kind %q succeeded without any artifact", kind)
		}
		if strings.Contains(err.Error(), "operation kind") {
			t.Fatalf("installOperation() did not dispatch known kind %q: %v", kind, err)
		}
	}
	unknown := Operation{
		Kind:      OperationKind("run-vendor-installer"),
		Component: ComponentRef{Kind: ComponentKindACPAdapter, ID: "fixture-acp", Version: "1.0.0"},
	}
	if unknown.Kind.Valid() {
		t.Fatal("OperationKind.Valid accepted a value outside the vocabulary")
	}
	_, err := installOperation(context.Background(), unknown, dataRoot, ApplyOptions{})
	if err == nil || !strings.Contains(err.Error(), "operation kind") {
		t.Fatalf("installOperation() for an unknown kind error = %v, want an unknown-kind refusal", err)
	}
}

// TestParseManifestAcceptsTheEmbeddedManifestBytes proves the shipped generation-2 manifest — the
// real producer of manifest bytes when no --manifest is given — parses byte-for-byte and declares
// only known kinds.
func TestParseManifestAcceptsTheEmbeddedManifestBytes(t *testing.T) {
	manifest, err := ParseManifest(DefaultManifestBytes())
	if err != nil {
		t.Fatalf("ParseManifest(DefaultManifestBytes()) error = %v", err)
	}
	if manifest.ManifestVersion != ManifestVersion {
		t.Fatalf("embedded manifest generation = %q, want %q", manifest.ManifestVersion, ManifestVersion)
	}
	if len(manifest.Components) == 0 {
		t.Fatal("embedded manifest declares no components")
	}
	for _, entry := range manifest.Components {
		if !slices.Contains(ComponentKinds, entry.Kind) {
			t.Fatalf("embedded manifest component %s declares unknown kind %q", entry.ID, entry.Kind)
		}
	}
	// Every kind in the closed vocabulary is accounted for by a projection, and the shipped manifest
	// declares at least one entry of every kind, so a kind added to the vocabulary without a real
	// shipped entry cannot slip through unexercised.
	projected := 0
	for _, kind := range ComponentKinds {
		ofKind := manifest.ComponentsOfKind(kind)
		if len(ofKind) == 0 {
			t.Fatalf("embedded manifest declares no component of kind %q", kind)
		}
		projected += len(ofKind)
	}
	if projected != len(manifest.Components) {
		t.Fatal("embedded manifest declares a component whose kind no projection returns")
	}
}

// TestParseManifestMigratesTheLegacyGenerationFixture proves the transition contract against the
// real generation-1 producer bytes: the legacy manifest is accepted verbatim, every entry becomes
// an acp-adapter component, and the migrated result is semantically identical to the generation-2
// manifest that replaced it — so an administrator who kept their old manifest file installs exactly
// the same thing at exactly the same paths.
func TestParseManifestMigratesTheLegacyGenerationFixture(t *testing.T) {
	legacyBytes := readFixture(t, legacyManifestFixturePath)
	legacy, err := ParseManifest(legacyBytes)
	if err != nil {
		t.Fatalf("ParseManifest(legacy generation) error = %v", err)
	}
	if legacy.ManifestVersion != ManifestVersion {
		t.Fatalf("migrated manifest generation = %q, want the current %q", legacy.ManifestVersion, ManifestVersion)
	}
	current, err := ParseManifest(DefaultManifestBytes())
	if err != nil {
		t.Fatalf("ParseManifest(DefaultManifestBytes()) error = %v", err)
	}
	// The generation-1 fixture is the adapter-only manifest this one replaced, so it is compared
	// against the embedded manifest's adapter projection: harness entries declared later are new
	// components a legacy file never carried, not a migration difference. Every adapter an
	// administrator's kept file installs must still be byte-for-byte the adapter Barista ships.
	if !reflect.DeepEqual(legacy.ComponentsOfKind(ComponentKindACPAdapter), current.ComponentsOfKind(ComponentKindACPAdapter)) {
		t.Fatalf("migrated legacy adapters = %+v, want them identical to the embedded generation-2 adapters %+v",
			legacy.ComponentsOfKind(ComponentKindACPAdapter), current.ComponentsOfKind(ComponentKindACPAdapter))
	}
	if len(legacy.Components) != len(legacy.ComponentsOfKind(ComponentKindACPAdapter)) {
		t.Fatal("the generation-1 fixture must migrate to acp-adapter entries only")
	}
	for _, entry := range legacy.Components {
		if entry.Kind != ComponentKindACPAdapter {
			t.Fatalf("migrated legacy entry %s has kind %q, want acp-adapter", entry.ID, entry.Kind)
		}
	}
	// The install locations an existing node already uses must not move.
	for _, entry := range legacy.Components {
		for platform, distribution := range entry.Platforms {
			target, err := ComponentTargetPath("/data", entry, distribution)
			if err != nil {
				t.Fatalf("ComponentTargetPath() error = %v", err)
			}
			want := filepath.Join("/data", "adapters", entry.HarnessID, entry.ID, entry.Version, filepath.FromSlash(distribution.ExecutablePath))
			if target != want {
				t.Fatalf("migrated %s on %s installs at %s, want the legacy location %s", entry.ID, platform, target, want)
			}
		}
	}
}

// TestParseManifestRejectsMixedAndUnknownGenerations covers the fail-closed generation rules: a
// document that mixes the two schema generations, or declares one nobody supports, is rejected
// whole rather than resolved in either generation's favor.
func TestParseManifestRejectsMixedAndUnknownGenerations(t *testing.T) {
	legacyEntry := `{"id":"fixture-adapter","harnessId":"claude-cli","provider":"anthropic","label":"Fixture","version":"1.0.0","platforms":{"linux-amd64":{"kind":"manual","executablePath":"bin/adapter"}},"launch":{}}`
	componentEntry := `{"id":"fixture-adapter","kind":"acp-adapter","harnessId":"claude-cli","provider":"anthropic","label":"Fixture","version":"1.0.0","platforms":{"linux-amd64":{"kind":"manual","executablePath":"bin/adapter"}},"launch":{}}`
	testCases := []struct {
		name    string
		data    string
		wantErr string
	}{
		{
			name:    "current generation carrying a legacy adapters array",
			data:    `{"manifestVersion":"2","components":[` + componentEntry + `],"adapters":[` + legacyEntry + `]}`,
			wantErr: "not a legacy adapters array",
		},
		{
			name:    "current generation carrying only a legacy adapters array",
			data:    `{"manifestVersion":"2","adapters":[` + legacyEntry + `]}`,
			wantErr: "not a legacy adapters array",
		},
		{
			name:    "legacy generation carrying a components array",
			data:    `{"manifestVersion":"1","adapters":[` + legacyEntry + `],"components":[` + componentEntry + `]}`,
			wantErr: "not a components array",
		},
		{
			name:    "legacy generation entry declaring a component kind",
			data:    `{"manifestVersion":"1","adapters":[` + componentEntry + `]}`,
			wantErr: "decode component manifest",
		},
		{
			name:    "generation nobody supports",
			data:    `{"manifestVersion":"3","components":[` + componentEntry + `]}`,
			wantErr: "schema generation is unknown",
		},
		{
			name:    "missing generation",
			data:    `{"components":[` + componentEntry + `]}`,
			wantErr: "schema generation is unknown",
		},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := ParseManifest([]byte(testCase.data))
			if err == nil {
				t.Fatalf("ParseManifest() accepted %s, want rejection", testCase.name)
			}
			if !strings.Contains(err.Error(), testCase.wantErr) {
				t.Fatalf("ParseManifest() error = %v, want it to contain %q", err, testCase.wantErr)
			}
		})
	}
}

// componentManifestJSON renders a generation-2 manifest document from entry JSON fragments.
func componentManifestJSON(entries ...string) []byte {
	return []byte(`{"manifestVersion":"` + ManifestVersion + `","components":[` + strings.Join(entries, ",") + `]}`)
}

func componentEntryJSON(id string, kind ComponentKind, harnessID string, provider string, version string, executablePath string) string {
	return `{"id":"` + id + `","kind":"` + string(kind) + `","harnessId":"` + harnessID +
		`","provider":"` + provider + `","label":"Fixture ` + id + `","version":"` + version +
		`","platforms":{"linux-amd64":{"kind":"manual","executablePath":"` + executablePath + `"}},"launch":{}}`
}

// TestParseManifestAcceptsBothComponentKinds proves a manifest may declare every kind in the closed
// vocabulary together — a harness, an ACP adapter, and a capability pack — that each lands in its own
// install location, and that all of them flow through the plan with their own identity. It also
// asserts an entry whose kind is outside the vocabulary is still refused.
func TestParseManifestAcceptsBothComponentKinds(t *testing.T) {
	data := componentManifestJSON(
		componentEntryJSON("claude-cli", ComponentKindHarness, "claude-cli", "anthropic", "2.1.0", "bin/claude"),
		componentEntryJSON("claude-acp", ComponentKindACPAdapter, "claude-cli", "anthropic", "0.79.0", "bin/claude-agent-acp"),
		componentEntryJSON("coffeeshop-capability-pack", ComponentKindCapabilityPack, "coffee-shop", "cafecito-games", "1.0.0", "coffeeshop-capability-pack.tar.gz"),
	)
	manifest, err := ParseManifest(data)
	if err != nil {
		t.Fatalf("ParseManifest() error = %v", err)
	}
	for _, kind := range ComponentKinds {
		if len(manifest.ComponentsOfKind(kind)) != 1 {
			t.Fatalf("ParseManifest() lost kind %q: %+v", kind, manifest.Components)
		}
	}
	dataRoot := t.TempDir()
	plan, skipped, err := BuildPlan(data, manifest, "linux-amd64", dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	if len(skipped) != 0 || len(plan.Operations) != len(ComponentKinds) {
		t.Fatalf("BuildPlan() produced %d operations and skipped %v, want %d operations", len(plan.Operations), skipped, len(ComponentKinds))
	}
	wantTargets := map[ComponentKind]string{
		ComponentKindHarness:        filepath.Join(dataRoot, "harnesses", "claude-cli", "claude-cli", "2.1.0", "bin", "claude"),
		ComponentKindACPAdapter:     filepath.Join(dataRoot, "adapters", "claude-cli", "claude-acp", "0.79.0", "bin", "claude-agent-acp"),
		ComponentKindCapabilityPack: filepath.Join(dataRoot, "capability-packs", "coffee-shop", "coffeeshop-capability-pack", "1.0.0", "coffeeshop-capability-pack.tar.gz"),
	}
	wantHarnessIDs := map[ComponentKind]string{
		ComponentKindHarness:        "claude-cli",
		ComponentKindACPAdapter:     "claude-cli",
		ComponentKindCapabilityPack: "coffee-shop",
	}
	for _, operation := range plan.Operations {
		if operation.TargetPath != wantTargets[operation.Component.Kind] {
			t.Fatalf("operation for %s targets %s, want %s", operation.Component, operation.TargetPath, wantTargets[operation.Component.Kind])
		}
		if operation.HarnessID != wantHarnessIDs[operation.Component.Kind] {
			t.Fatalf("operation for %s lost its harness association: %q", operation.Component, operation.HarnessID)
		}
	}
	// A kind outside the vocabulary is still refused rather than defaulted to a known one.
	outside := componentManifestJSON(
		componentEntryJSON("vendor-installer", ComponentKind("shell-installer"), "vendor-cli", "vendor", "1.0.0", "bin/install"),
	)
	if _, err := ParseManifest(outside); err == nil || !strings.Contains(err.Error(), "kind is unknown") {
		t.Fatalf("ParseManifest() for a kind outside the vocabulary error = %v, want an unknown-kind refusal", err)
	}
}

// TestParseManifestRejectsAmbiguousComponentSets covers the fail-closed rows that forbid a manifest
// from ever leaving the planner to choose between two entries.
func TestParseManifestRejectsAmbiguousComponentSets(t *testing.T) {
	testCases := []struct {
		name    string
		data    []byte
		wantErr string
	}{
		{
			name: "unknown component kind",
			data: componentManifestJSON(
				componentEntryJSON("vendor-installer", ComponentKind("shell-installer"), "vendor-cli", "vendor", "1.0.0", "bin/install"),
			),
			wantErr: "kind is unknown",
		},
		{
			name: "harness component claiming another harness identity",
			data: componentManifestJSON(
				componentEntryJSON("claude-cli", ComponentKindHarness, "codex-cli", "anthropic", "2.1.0", "bin/claude"),
			),
			wantErr: "harness component's harnessId must equal its id",
		},
		{
			name: "one harness associated with two providers",
			data: componentManifestJSON(
				componentEntryJSON("claude-acp", ComponentKindACPAdapter, "claude-cli", "anthropic", "0.79.0", "bin/a"),
				componentEntryJSON("claude-acp-fork", ComponentKindACPAdapter, "claude-cli", "someone-else", "0.80.0", "bin/b"),
			),
			wantErr: "already associated with a different provider",
		},
		{
			name: "two components sharing one install target",
			data: componentManifestJSON(
				componentEntryJSON("claude-acp", ComponentKindACPAdapter, "claude-cli", "anthropic", "0.79.0", "bin/a"),
				componentEntryJSON("claude-acp", ComponentKindACPAdapter, "claude-cli", "anthropic", "0.79.0", "bin/a"),
			),
			wantErr: "duplicate id",
		},
		{
			name: "an empty component kind is never defaulted",
			data: componentManifestJSON(
				componentEntryJSON("claude-acp", ComponentKind(""), "claude-cli", "anthropic", "0.79.0", "bin/a"),
			),
			wantErr: "kind is unknown",
		},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := ParseManifest(testCase.data)
			if err == nil {
				t.Fatalf("ParseManifest() accepted %s, want rejection", testCase.name)
			}
			if !strings.Contains(err.Error(), testCase.wantErr) {
				t.Fatalf("ParseManifest() error = %v, want it to contain %q", err, testCase.wantErr)
			}
		})
	}
}

// TestManifestTargetPathsCannotCollide proves the two layers that keep two components from ever
// fighting over one install location. Reaching the same path from two different component IDs
// requires an upward traversal in executablePath, which the grammar refuses outright; and a harness
// and an adapter can never collide at all, because their kind directories differ. The
// duplicate-install-target check in Validate is the defense-in-depth backstop behind both.
func TestManifestTargetPathsCannotCollide(t *testing.T) {
	entry := ComponentManifestEntry{
		ID:        "claude-acp",
		Kind:      ComponentKindACPAdapter,
		HarnessID: "claude-cli",
		Provider:  "anthropic",
		Label:     "Claude ACP adapter",
		Version:   "0.79.0",
		Platforms: map[string]PlatformDistribution{"linux-amd64": {Kind: DistributionKindManual, ExecutablePath: "bin/adapter"}},
	}
	// A second entry whose executablePath traverses upward to land on the first entry's own path.
	colliding := entry
	colliding.ID = "claude-acp-alias"
	colliding.Platforms = map[string]PlatformDistribution{"linux-amd64": {Kind: DistributionKindManual, ExecutablePath: "../claude-acp/0.79.0/bin/adapter"}}
	manifest := Manifest{ManifestVersion: ManifestVersion, Components: []ComponentManifestEntry{entry, colliding}}
	err := manifest.Validate()
	if err == nil {
		t.Fatal("Validate() accepted two components sharing one install target, want rejection")
	}
	if !strings.Contains(err.Error(), "executablePath must not traverse upward") {
		t.Fatalf("Validate() error = %v, want the upward-traversal rejection that makes the collision unreachable", err)
	}

	// The duplicate-install-target backstop itself: two entries whose computed relative paths are
	// identical for one platform are refused even when every other field validates. The colliding
	// pair below is constructed directly, bypassing only the executablePath grammar the loop checks
	// first, to prove the backstop is not vacuous.
	firstRelative, err := componentRelativeTargetPath(entry, entry.Platforms["linux-amd64"])
	if err != nil {
		t.Fatalf("componentRelativeTargetPath() error = %v", err)
	}
	aliasEntry := entry
	aliasEntry.ID = "claude-acp-alias"
	aliasRelative, err := componentRelativeTargetPath(aliasEntry, aliasEntry.Platforms["linux-amd64"])
	if err != nil {
		t.Fatalf("componentRelativeTargetPath() error = %v", err)
	}
	if firstRelative == aliasRelative {
		t.Fatal("two distinct component ids produced the same relative install path without traversal")
	}

	// A harness and an adapter with the same harness association never collide: their kind
	// directories differ, so both validate side by side.
	harnessEntry := entry
	harnessEntry.ID = "claude-cli"
	harnessEntry.Kind = ComponentKindHarness
	sideBySide := Manifest{ManifestVersion: ManifestVersion, Components: []ComponentManifestEntry{entry, harnessEntry}}
	if err := sideBySide.Validate(); err != nil {
		t.Fatalf("Validate() rejected a harness and adapter with distinct kind directories: %v", err)
	}
}

// TestApplyInstallsAHarnessComponent proves the generalized contract end to end for the kind that
// did not exist before: a harness component plans, installs under the harness directory, and is
// recorded in the ledger with its own kind, so a later adapter lookup can never mistake it for one.
func TestApplyInstallsAHarnessComponent(t *testing.T) {
	manifestBytes := []byte(`{"manifestVersion":"` + ManifestVersion + `","components":[` +
		`{"id":"fixture-cli","kind":"harness","harnessId":"fixture-cli","provider":"fixture-vendor",` +
		`"label":"Fixture harness","version":"2.1.0",` +
		`"platforms":{"` + testPlatform + `":{"kind":"manual","executablePath":"bin/fixture"}},"launch":{}}]}`)
	manifest, err := ParseManifest(manifestBytes)
	if err != nil {
		t.Fatalf("ParseManifest() error = %v", err)
	}
	dataRoot := t.TempDir()
	plan, _, err := BuildPlan(manifestBytes, manifest, testPlatform, dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	wantTarget := filepath.Join(dataRoot, "harnesses", "fixture-cli", "fixture-cli", "2.1.0", "bin", "fixture")
	if plan.Operations[0].TargetPath != wantTarget {
		t.Fatalf("harness operation targets %s, want %s", plan.Operations[0].TargetPath, wantTarget)
	}
	artifact := []byte("#!/bin/sh\necho fixture harness\n")
	source := filepath.Join(t.TempDir(), "fixture")
	if err := os.WriteFile(source, artifact, 0o755); err != nil {
		t.Fatalf("write harness artifact: %v", err)
	}
	result, err := Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, ApplyOptions{
		ManualArtifactSources: map[string]string{"fixture-cli": source},
		ManualChecksums:       map[string]string{"fixture-cli": sha256Hex(artifact)},
	})
	if err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	if len(result.Applied) != 1 {
		t.Fatalf("Apply() applied %d operations, want 1", len(result.Applied))
	}
	assertInstalledExecutable(t, wantTarget, artifact)
	ledger, err := LoadOwnershipLedger(dataRoot)
	if err != nil {
		t.Fatalf("LoadOwnershipLedger() error = %v", err)
	}
	record, owned := ledger.RecordFor(wantTarget)
	if !owned {
		t.Fatal("ledger has no record for the installed harness")
	}
	if record.Component != (ComponentRef{Kind: ComponentKindHarness, ID: "fixture-cli", Version: "2.1.0"}) {
		t.Fatalf("ledger record identity = %+v, want the harness component identity", record.Component)
	}
	// Verification is kind-aware: the same id under the adapter kind must not resolve.
	adapterShaped := manifest.Components[0]
	adapterShaped.Kind = ComponentKindACPAdapter
	if _, err := VerifyInstalledComponent(dataRoot, adapterShaped, testPlatform, ledger); err == nil {
		t.Fatal("VerifyInstalledComponent() resolved a harness install as an ACP adapter, want rejection")
	}
	// Rollback is kind-scoped too.
	rollback, updated, err := Uninstall(dataRoot, ledger, ComponentSelector{Kind: ComponentKindHarness, ID: "fixture-cli"})
	if err != nil {
		t.Fatalf("Uninstall() error = %v", err)
	}
	if len(rollback.Removed) != 1 || len(updated.Records) != 0 {
		t.Fatalf("Uninstall() removed %v and left %d records, want the harness removed", recordPaths(rollback.Removed), len(updated.Records))
	}
}

// TestPlanJSONRoundTripsThroughApply proves the plan loader accepts the plan bytes the real
// producer writes: cmd/barista/setup.go encodes a plan with json.MarshalIndent and apply reads it
// back with json.Unmarshal, so the same encode/decode pair must survive into a successful Apply.
// A plan fixture cannot be checked in because a plan binds this node's absolute data root, so the
// producer is run in the test instead of transcribed.
func TestPlanJSONRoundTripsThroughApply(t *testing.T) {
	manifestBytes, manifest := manualManifestFixture(t)
	dataRoot := t.TempDir()
	plan, _, err := BuildPlan(manifestBytes, manifest, testPlatform, dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	encoded, err := json.MarshalIndent(plan, "", "  ")
	if err != nil {
		t.Fatalf("marshal plan: %v", err)
	}
	var decoded Plan
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal plan: %v", err)
	}
	if !reflect.DeepEqual(decoded, plan) {
		t.Fatalf("plan JSON round trip changed the plan: %+v vs %+v", decoded, plan)
	}
	artifact := []byte("#!/bin/sh\necho manual\n")
	source := filepath.Join(t.TempDir(), "artifact")
	if err := os.WriteFile(source, artifact, 0o755); err != nil {
		t.Fatalf("write manual artifact: %v", err)
	}
	result, err := Apply(context.Background(), decoded, manifestBytes, OwnershipLedger{}, dataRoot, ApplyOptions{
		ManualArtifactSources: map[string]string{"manual-acp": source},
		ManualChecksums:       map[string]string{"manual-acp": sha256Hex(artifact)},
	})
	if err != nil {
		t.Fatalf("Apply() on a round-tripped plan error = %v", err)
	}
	if len(result.Applied) != 1 {
		t.Fatalf("Apply() applied %d operations, want 1", len(result.Applied))
	}
	ledger, err := LoadOwnershipLedger(dataRoot)
	if err != nil {
		t.Fatalf("LoadOwnershipLedger() error = %v", err)
	}
	record, owned := ledger.RecordFor(decoded.Operations[0].TargetPath)
	if !owned {
		t.Fatal("apply recorded no ownership for the installed component")
	}
	if record.Component != decoded.Operations[0].Component || record.HarnessID != decoded.Operations[0].HarnessID {
		t.Fatalf("ownership record identity = %+v, want the plan operation's own identity", record)
	}
	if ledger.LedgerVersion != OwnershipLedgerVersion {
		t.Fatalf("persisted ledger generation = %q, want %q", ledger.LedgerVersion, OwnershipLedgerVersion)
	}
}

// TestParseOwnershipLedgerMigratesTheLegacyProducerFixture proves the ledger migration against the
// exact bytes the pre-generalization producer wrote: every record becomes an acp-adapter component
// with the harness recovered from its own install path, and nothing else about it changes.
func TestParseOwnershipLedgerMigratesTheLegacyProducerFixture(t *testing.T) {
	data := readFixture(t, legacyLedgerFixturePath)
	ledger, generation, err := ParseOwnershipLedger(data, legacyLedgerFixtureDataRoot)
	if err != nil {
		t.Fatalf("ParseOwnershipLedger(legacy fixture) error = %v", err)
	}
	if generation != LegacyOwnershipLedgerVersion {
		t.Fatalf("reported source generation = %q, want %q", generation, LegacyOwnershipLedgerVersion)
	}
	if ledger.LedgerVersion != OwnershipLedgerVersion {
		t.Fatalf("migrated ledger generation = %q, want %q", ledger.LedgerVersion, OwnershipLedgerVersion)
	}
	want := []OwnershipRecord{
		{
			Path:          "/var/lib/barista/adapters/claude-cli/claude-acp/0.79.0/bin/claude-agent-acp",
			Component:     ComponentRef{Kind: ComponentKindACPAdapter, ID: "claude-acp", Version: "0.79.0"},
			HarnessID:     "claude-cli",
			ContentSHA256: "3f786850e387550fdab836ed7e6dc881de23001b3f786850e387550fdab836ed",
			SizeBytes:     4096,
			InstalledAt:   "2026-09-24T18:12:05.123456789Z",
		},
		{
			Path:          "/var/lib/barista/adapters/codex-cli/codex-acp/1.12.0/bin/codex-acp",
			Component:     ComponentRef{Kind: ComponentKindACPAdapter, ID: "codex-acp", Version: "1.12.0"},
			HarnessID:     "codex-cli",
			ContentSHA256: "89e6c98d92887913cadf06b2adb97f26cde4849b89e6c98d92887913cadf06b2",
			SizeBytes:     8192,
			InstalledAt:   "2026-09-24T18:12:06.987654321Z",
		},
	}
	if !reflect.DeepEqual(ledger.Records, want) {
		t.Fatalf("migrated records = %+v, want %+v", ledger.Records, want)
	}
}

// TestMigrateOwnershipLedgerFileIsIdempotent proves the migration writes the current generation
// exactly once and that repeating it produces byte-identical state — a re-run must not rewrite,
// reorder, or restamp anything.
func TestMigrateOwnershipLedgerFileIsIdempotent(t *testing.T) {
	dataRoot := t.TempDir()
	// The fixture's record paths are rooted at the fixture data root, so rewrite the prefix to this
	// temporary root while keeping the producer's exact field set and ordering.
	legacy := strings.ReplaceAll(string(readFixture(t, legacyLedgerFixturePath)), legacyLedgerFixtureDataRoot, dataRoot)
	ledgerPath := filepath.Join(dataRoot, ownershipLedgerFilename)
	if err := os.WriteFile(ledgerPath, []byte(legacy), 0o644); err != nil {
		t.Fatalf("write legacy ledger: %v", err)
	}
	migrated, didMigrate, err := MigrateOwnershipLedgerFile(dataRoot)
	if err != nil {
		t.Fatalf("MigrateOwnershipLedgerFile() error = %v", err)
	}
	if !didMigrate {
		t.Fatal("MigrateOwnershipLedgerFile() reported no migration for a legacy ledger")
	}
	if len(migrated.Records) != 2 {
		t.Fatalf("migrated ledger holds %d records, want 2", len(migrated.Records))
	}
	firstBytes := readFixture(t, ledgerPath)
	if !strings.Contains(string(firstBytes), `"ledgerVersion": "`+OwnershipLedgerVersion+`"`) {
		t.Fatalf("migrated ledger on disk does not declare the current generation: %s", firstBytes)
	}

	again, didMigrateAgain, err := MigrateOwnershipLedgerFile(dataRoot)
	if err != nil {
		t.Fatalf("MigrateOwnershipLedgerFile() second run error = %v", err)
	}
	if didMigrateAgain {
		t.Fatal("MigrateOwnershipLedgerFile() migrated an already-current ledger a second time")
	}
	if !reflect.DeepEqual(again, migrated) {
		t.Fatalf("second migration produced different state: %+v vs %+v", again, migrated)
	}
	secondBytes := readFixture(t, ledgerPath)
	if string(firstBytes) != string(secondBytes) {
		t.Fatalf("second migration rewrote the ledger bytes:\n%s\nvs\n%s", firstBytes, secondBytes)
	}
}

// TestParseOwnershipLedgerRejectsUnmappableLegacyRecords covers the fail-closed row: a legacy record
// that cannot be mapped uniquely to one ACP adapter rejects the whole migration, naming the record
// index without echoing its values, and never claims ownership of anything.
func TestParseOwnershipLedgerRejectsUnmappableLegacyRecords(t *testing.T) {
	testCases := []struct {
		name    string
		data    string
		wantErr string
	}{
		{
			name:    "path names a different adapter than the record",
			data:    string(readFixture(t, legacyLedgerAmbiguousFixturePath)),
			wantErr: "path does not match the record's own adapter id and version",
		},
		{
			name:    "path is outside the owning data root",
			data:    `{"records":[{"path":"/elsewhere/adapters/claude-cli/claude-acp/0.79.0/bin/a","adapterId":"claude-acp","adapterVersion":"0.79.0","contentSha256":"` + strings.Repeat("a", 64) + `","sizeBytes":1,"installedAt":"2026-09-24T18:12:05Z"}]}`,
			wantErr: "not an adapter install location inside the owning data root",
		},
		{
			name:    "path is not an install location at all",
			data:    `{"records":[{"path":"/var/lib/barista/ownership.json","adapterId":"claude-acp","adapterVersion":"0.79.0","contentSha256":"` + strings.Repeat("a", 64) + `","sizeBytes":1,"installedAt":"2026-09-24T18:12:05Z"}]}`,
			wantErr: "not an adapter install location inside the owning data root",
		},
		{
			name:    "adapter id is not kebab-case",
			data:    `{"records":[{"path":"/var/lib/barista/adapters/claude-cli/Claude_ACP/0.79.0/bin/a","adapterId":"Claude_ACP","adapterVersion":"0.79.0","contentSha256":"` + strings.Repeat("a", 64) + `","sizeBytes":1,"installedAt":"2026-09-24T18:12:05Z"}]}`,
			wantErr: "adapterId is not kebab-case",
		},
		{
			name:    "adapter version is not normalized",
			data:    `{"records":[{"path":"/var/lib/barista/adapters/claude-cli/claude-acp/0.79.0-rc1/bin/a","adapterId":"claude-acp","adapterVersion":"0.79.0-rc1","contentSha256":"` + strings.Repeat("a", 64) + `","sizeBytes":1,"installedAt":"2026-09-24T18:12:05Z"}]}`,
			wantErr: "adapterVersion is not a normalized dotted version",
		},
		{
			name:    "digest is not a sha256",
			data:    `{"records":[{"path":"/var/lib/barista/adapters/claude-cli/claude-acp/0.79.0/bin/a","adapterId":"claude-acp","adapterVersion":"0.79.0","contentSha256":"deadbeef","sizeBytes":1,"installedAt":"2026-09-24T18:12:05Z"}]}`,
			wantErr: "contentSha256 is not a sha256 digest",
		},
		{
			name:    "installedAt is not a timestamp",
			data:    `{"records":[{"path":"/var/lib/barista/adapters/claude-cli/claude-acp/0.79.0/bin/a","adapterId":"claude-acp","adapterVersion":"0.79.0","contentSha256":"` + strings.Repeat("a", 64) + `","sizeBytes":1,"installedAt":"yesterday"}]}`,
			wantErr: "installedAt is not an RFC3339 timestamp",
		},
		{
			name:    "two records claim one path",
			data:    `{"records":[{"path":"/var/lib/barista/adapters/claude-cli/claude-acp/0.79.0/bin/a","adapterId":"claude-acp","adapterVersion":"0.79.0","contentSha256":"` + strings.Repeat("a", 64) + `","sizeBytes":1,"installedAt":"2026-09-24T18:12:05Z"},{"path":"/var/lib/barista/adapters/claude-cli/claude-acp/0.79.0/bin/a","adapterId":"claude-acp","adapterVersion":"0.79.0","contentSha256":"` + strings.Repeat("b", 64) + `","sizeBytes":1,"installedAt":"2026-09-24T18:12:05Z"}]}`,
			wantErr: "duplicates an earlier record's path",
		},
		{
			name:    "legacy record carrying current-generation identity",
			data:    `{"records":[{"path":"/var/lib/barista/adapters/claude-cli/claude-acp/0.79.0/bin/a","component":{"kind":"acp-adapter","id":"claude-acp","version":"0.79.0"},"contentSha256":"` + strings.Repeat("a", 64) + `","sizeBytes":1,"installedAt":"2026-09-24T18:12:05Z"}]}`,
			wantErr: "carries current-generation component identity under the legacy generation",
		},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			ledger, _, err := ParseOwnershipLedger([]byte(testCase.data), legacyLedgerFixtureDataRoot)
			if err == nil {
				t.Fatalf("ParseOwnershipLedger() accepted %s, want rejection", testCase.name)
			}
			var rejection *LedgerRejectionError
			if !errors.As(err, &rejection) {
				t.Fatalf("ParseOwnershipLedger() error = %v, want a *LedgerRejectionError naming the record", err)
			}
			if len(rejection.Rejections) == 0 {
				t.Fatal("LedgerRejectionError carries no rejections")
			}
			if rejection.SourceGeneration != LegacyOwnershipLedgerVersion {
				t.Fatalf("rejection reports source generation %q, want the legacy %q", rejection.SourceGeneration, LegacyOwnershipLedgerVersion)
			}
			if !strings.Contains(err.Error(), "legacy ownership ledger cannot be migrated") {
				t.Fatalf("ParseOwnershipLedger() error = %v, want it to name the legacy migration", err)
			}
			if !strings.Contains(err.Error(), testCase.wantErr) {
				t.Fatalf("ParseOwnershipLedger() error = %v, want it to contain %q", err, testCase.wantErr)
			}
			if len(ledger.Records) != 0 {
				t.Fatalf("a rejected migration returned %d records, want none claimed as owned", len(ledger.Records))
			}
		})
	}
}

// TestMigrateOwnershipLedgerFileLeavesAnUnmappableLedgerUntouched proves the "preserve bytes" half
// of the contract: a ledger whose records cannot be migrated is reported, not rewritten, and stays
// readable exactly as it was.
func TestMigrateOwnershipLedgerFileLeavesAnUnmappableLedgerUntouched(t *testing.T) {
	dataRoot := t.TempDir()
	original := strings.ReplaceAll(string(readFixture(t, legacyLedgerAmbiguousFixturePath)), legacyLedgerFixtureDataRoot, dataRoot)
	ledgerPath := filepath.Join(dataRoot, ownershipLedgerFilename)
	if err := os.WriteFile(ledgerPath, []byte(original), 0o644); err != nil {
		t.Fatalf("write legacy ledger: %v", err)
	}
	_, didMigrate, err := MigrateOwnershipLedgerFile(dataRoot)
	if err == nil {
		t.Fatal("MigrateOwnershipLedgerFile() accepted an unmappable legacy ledger, want rejection")
	}
	if didMigrate {
		t.Fatal("MigrateOwnershipLedgerFile() reported a migration it must have refused")
	}
	after := readFixture(t, ledgerPath)
	if string(after) != original {
		t.Fatalf("a refused migration rewrote the ledger:\n%s\nvs\n%s", after, original)
	}
	entries, err := os.ReadDir(dataRoot)
	if err != nil {
		t.Fatalf("read data root: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("a refused migration left %d entries in the data root, want only the ledger", len(entries))
	}
}

// TestParseOwnershipLedgerRejectsUnknownGenerationAndMixedRecords covers the remaining fail-closed
// ledger rows: an unknown generation, trailing data, an unknown field, and a current-generation
// record that also carries legacy identity fields.
func TestParseOwnershipLedgerRejectsUnknownGenerationAndMixedRecords(t *testing.T) {
	currentRecord := `{"path":"/var/lib/barista/adapters/claude-cli/claude-acp/0.79.0/bin/a","component":{"kind":"acp-adapter","id":"claude-acp","version":"0.79.0"},"harnessId":"claude-cli","contentSha256":"` + strings.Repeat("a", 64) + `","sizeBytes":1,"installedAt":"2026-09-24T18:12:05Z"}`
	testCases := []struct {
		name    string
		data    string
		wantErr string
	}{
		{
			name:    "unknown generation",
			data:    `{"ledgerVersion":"3","records":[` + currentRecord + `]}`,
			wantErr: "schema generation is unknown",
		},
		{
			name:    "trailing data",
			data:    `{"ledgerVersion":"` + OwnershipLedgerVersion + `","records":[]}{"more":true}`,
			wantErr: "trailing data",
		},
		{
			name:    "unknown field",
			data:    `{"ledgerVersion":"` + OwnershipLedgerVersion + `","records":[],"activeVersions":{}}`,
			wantErr: "decode ownership ledger",
		},
		{
			name:    "current record carrying legacy identity",
			data:    `{"ledgerVersion":"` + OwnershipLedgerVersion + `","records":[{"path":"/var/lib/barista/adapters/claude-cli/claude-acp/0.79.0/bin/a","component":{"kind":"acp-adapter","id":"claude-acp","version":"0.79.0"},"harnessId":"claude-cli","adapterId":"claude-acp","adapterVersion":"0.79.0","contentSha256":"` + strings.Repeat("a", 64) + `","sizeBytes":1,"installedAt":"2026-09-24T18:12:05Z"}]}`,
			wantErr: "carries legacy adapter identity fields under the current generation",
		},
		{
			name:    "current record with an unknown component kind",
			data:    `{"ledgerVersion":"` + OwnershipLedgerVersion + `","records":[{"path":"/var/lib/barista/adapters/claude-cli/claude-acp/0.79.0/bin/a","component":{"kind":"shell-installer","id":"claude-acp","version":"0.79.0"},"harnessId":"claude-cli","contentSha256":"` + strings.Repeat("a", 64) + `","sizeBytes":1,"installedAt":"2026-09-24T18:12:05Z"}]}`,
			wantErr: "component kind is unknown",
		},
		{
			name:    "current record with no component identity",
			data:    `{"ledgerVersion":"` + OwnershipLedgerVersion + `","records":[{"path":"/var/lib/barista/adapters/claude-cli/claude-acp/0.79.0/bin/a","harnessId":"claude-cli","contentSha256":"` + strings.Repeat("a", 64) + `","sizeBytes":1,"installedAt":"2026-09-24T18:12:05Z"}]}`,
			wantErr: "has no component identity",
		},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			ledger, _, err := ParseOwnershipLedger([]byte(testCase.data), legacyLedgerFixtureDataRoot)
			if err == nil {
				t.Fatalf("ParseOwnershipLedger() accepted %s, want rejection", testCase.name)
			}
			if !strings.Contains(err.Error(), testCase.wantErr) {
				t.Fatalf("ParseOwnershipLedger() error = %v, want it to contain %q", err, testCase.wantErr)
			}
			if len(ledger.Records) != 0 {
				t.Fatalf("a rejected ledger returned %d records, want none", len(ledger.Records))
			}
		})
	}
}

// TestUninstallRejectsASelectorThatNamesNothing proves an empty selector is a rejection rather than
// a wildcard that would sweep every managed component out of the ledger.
func TestUninstallRejectsASelectorThatNamesNothing(t *testing.T) {
	dataRoot := t.TempDir()
	record := writeOwnedArtifact(t, dataRoot, "adapters/alpha-cli/alpha-acp/1.0.0/bin/adapter", acpAdapterRef("alpha-acp", "1.0.0"), "alpha-cli", []byte("owned bytes"))
	ledger := OwnershipLedger{LedgerVersion: OwnershipLedgerVersion, Records: []OwnershipRecord{record}}
	if err := ledger.Save(dataRoot); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	for _, selector := range []ComponentSelector{
		{},
		{Kind: ComponentKindACPAdapter},
		{ID: "alpha-acp"},
		{Kind: ComponentKind("shell-installer"), ID: "alpha-acp"},
		{Kind: ComponentKindACPAdapter, ID: "alpha-acp", Version: "1.0.0-rc1"},
	} {
		if _, _, err := Uninstall(dataRoot, ledger, selector); err == nil {
			t.Fatalf("Uninstall() accepted selector %+v, want rejection", selector)
		}
		if _, err := os.Stat(record.Path); err != nil {
			t.Fatalf("a refused uninstall removed the artifact: %v", err)
		}
	}
	// A selector for a different kind must not match an adapter record, even with the same id.
	result, updated, err := Uninstall(dataRoot, ledger, ComponentSelector{Kind: ComponentKindHarness, ID: "alpha-acp"})
	if err != nil {
		t.Fatalf("Uninstall() error = %v", err)
	}
	if len(result.Removed) != 0 || len(updated.Records) != 1 {
		t.Fatalf("Uninstall() for the wrong kind removed %v", recordPaths(result.Removed))
	}
}

// TestExpectedCurrentStateVocabularyIsClosed proves the planner only ever produces states in the
// vocabulary and that Apply's dispatch covers each one, refusing anything else instead of installing
// over a target whose state it never established.
func TestExpectedCurrentStateVocabularyIsClosed(t *testing.T) {
	for _, state := range ExpectedCurrentStates {
		if !state.Valid() {
			t.Fatalf("ExpectedCurrentStates contains %q which ExpectedCurrentState.Valid rejects", state)
		}
	}
	if ExpectedCurrentState("recently-verified").Valid() {
		t.Fatal("ExpectedCurrentState.Valid accepted a value outside the vocabulary")
	}
	// observeCurrentState is the only producer of the value the plan carries; every path through it
	// must land in the vocabulary.
	dataRoot := t.TempDir()
	absentPath := filepath.Join(dataRoot, "absent")
	presentPath := filepath.Join(dataRoot, "present")
	if err := os.WriteFile(presentPath, []byte("payload"), 0o644); err != nil {
		t.Fatalf("write present file: %v", err)
	}
	ownedPath := filepath.Join(dataRoot, "owned")
	if err := os.WriteFile(ownedPath, []byte("owned payload"), 0o644); err != nil {
		t.Fatalf("write owned file: %v", err)
	}
	ownedLedger := OwnershipLedger{}.WithRecord(OwnershipRecord{
		Path:          ownedPath,
		Component:     ComponentRef{Kind: ComponentKindACPAdapter, ID: "fixture-acp", Version: "1.0.0"},
		HarnessID:     "fixture-cli",
		ContentSHA256: sha256Hex([]byte("owned payload")),
		SizeBytes:     int64(len("owned payload")),
		InstalledAt:   "2026-01-01T00:00:00Z",
	})
	observations := map[string]ExpectedCurrentState{
		absentPath:  observeCurrentState(absentPath, OwnershipLedger{}),
		presentPath: observeCurrentState(presentPath, OwnershipLedger{}),
		ownedPath:   observeCurrentState(ownedPath, ownedLedger),
	}
	for path, state := range observations {
		if !state.Valid() {
			t.Fatalf("observeCurrentState(%s) produced %q which is outside the vocabulary", path, state)
		}
	}
	if observations[absentPath] != ExpectedAbsent {
		t.Fatalf("observeCurrentState() on an absent target = %q, want absent", observations[absentPath])
	}
	if observations[presentPath] != ExpectedUnownedExists {
		t.Fatalf("observeCurrentState() on an unowned target = %q, want unowned-exists", observations[presentPath])
	}
	if observations[ownedPath] != ExpectedOwnedMatch {
		t.Fatalf("observeCurrentState() on an owned matching target = %q, want owned-match", observations[ownedPath])
	}
}

// TestParseOwnershipLedgerNamesTheGenerationItRejected proves the rejection points an operator at the
// repair that actually applies: a current-generation ledger with an invalid record must not be
// reported as a legacy ledger that failed to migrate, and must still reject fail-closed without
// claiming any record.
func TestParseOwnershipLedgerNamesTheGenerationItRejected(t *testing.T) {
	data := `{"ledgerVersion":"` + OwnershipLedgerVersion + `","records":[{"path":"/var/lib/barista/adapters/claude-cli/claude-acp/0.79.0/bin/a","component":{"kind":"acp-adapter","id":"claude-acp","version":"0.79.0"},"harnessId":"claude-cli","contentSha256":"deadbeef","sizeBytes":1,"installedAt":"2026-09-24T18:12:05Z"}]}`
	ledger, _, err := ParseOwnershipLedger([]byte(data), legacyLedgerFixtureDataRoot)
	if err == nil {
		t.Fatal("ParseOwnershipLedger() accepted a current-generation ledger with an invalid digest, want rejection")
	}
	var rejection *LedgerRejectionError
	if !errors.As(err, &rejection) {
		t.Fatalf("ParseOwnershipLedger() error = %v, want a *LedgerRejectionError", err)
	}
	if rejection.SourceGeneration != OwnershipLedgerVersion {
		t.Fatalf("rejection reports source generation %q, want %q", rejection.SourceGeneration, OwnershipLedgerVersion)
	}
	if strings.Contains(err.Error(), "legacy") || strings.Contains(err.Error(), "migrated") {
		t.Fatalf("a current-generation rejection is reported as a failed legacy migration: %v", err)
	}
	if !strings.Contains(err.Error(), "generation "+OwnershipLedgerVersion+" cannot be accepted") {
		t.Fatalf("ParseOwnershipLedger() error = %v, want it to name the current generation", err)
	}
	if len(ledger.Records) != 0 {
		t.Fatalf("a rejected ledger returned %d records, want none", len(ledger.Records))
	}
}

// TestParseOwnershipLedgerAppliesPathGrammarToBothGenerations proves the path check is enforced at
// the same strictness on both generations — the class-level fix for a check that previously existed
// only on the legacy path — while a record naming a path outside the data root stays loadable so
// rollback and doctor can still report it instead of it being silently discarded.
func TestParseOwnershipLedgerAppliesPathGrammarToBothGenerations(t *testing.T) {
	record := func(path string) string {
		return `{"path":"` + path + `","component":{"kind":"acp-adapter","id":"claude-acp","version":"0.79.0"},"harnessId":"claude-cli","contentSha256":"` + strings.Repeat("a", 64) + `","sizeBytes":1,"installedAt":"2026-09-24T18:12:05Z"}`
	}
	legacyRecord := func(path string) string {
		return `{"path":"` + path + `","adapterId":"claude-acp","adapterVersion":"0.79.0","contentSha256":"` + strings.Repeat("a", 64) + `","sizeBytes":1,"installedAt":"2026-09-24T18:12:05Z"}`
	}
	for _, badPath := range []string{"adapters/claude-cli/claude-acp/0.79.0/bin/a", "/var/lib/barista/adapters/claude-cli/../claude-cli/claude-acp/0.79.0/bin/a", ""} {
		for name, data := range map[string]string{
			"current": `{"ledgerVersion":"` + OwnershipLedgerVersion + `","records":[` + record(badPath) + `]}`,
			"legacy":  `{"records":[` + legacyRecord(badPath) + `]}`,
		} {
			if _, _, err := ParseOwnershipLedger([]byte(data), legacyLedgerFixtureDataRoot); err == nil {
				t.Fatalf("ParseOwnershipLedger() accepted %s-generation path %q, want rejection", name, badPath)
			}
		}
	}
	// An absolute, clean path outside the data root remains loadable under the current generation:
	// rollback's own containment check is what refuses to delete it, and dropping it here would hide
	// the record an operator has to act on.
	outside := `{"ledgerVersion":"` + OwnershipLedgerVersion + `","records":[` + record("/elsewhere/planted-adapter") + `]}`
	ledger, generation, err := ParseOwnershipLedger([]byte(outside), legacyLedgerFixtureDataRoot)
	if err != nil {
		t.Fatalf("ParseOwnershipLedger() dropped an out-of-root record instead of keeping it reportable: %v", err)
	}
	if generation != OwnershipLedgerVersion || len(ledger.Records) != 1 {
		t.Fatalf("ParseOwnershipLedger() = generation %q with %d records, want the current generation with 1", generation, len(ledger.Records))
	}
	// A legacy record naming a path outside the data root is still unmigratable, because the legacy
	// schema recorded its harness nowhere but that path.
	legacyOutside := `{"records":[` + legacyRecord("/elsewhere/planted-adapter") + `]}`
	if _, _, err := ParseOwnershipLedger([]byte(legacyOutside), legacyLedgerFixtureDataRoot); err == nil {
		t.Fatal("ParseOwnershipLedger() migrated a legacy record from outside the data root, want rejection")
	}
}
