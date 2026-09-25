package setup

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

// activationManifestFixture declares one adapter component at two installable versions and one
// harness component, which is the shape every activation test needs: a component whose two installed
// versions coexist, and a managed harness.
func activationManifestFixture(t *testing.T) Manifest {
	t.Helper()
	manifestJSON := []byte(`{
		"manifestVersion": "2",
		"components": [
			{
				"id": "codex-acp", "kind": "acp-adapter", "harnessId": "codex-cli", "provider": "openai",
				"label": "Codex ACP adapter", "version": "1.0.0",
				"platforms": {"darwin-arm64": {"kind": "manual", "executablePath": "bin/codex-acp"}},
				"launch": {}
			},
			{
				"id": "codex-acp-next", "kind": "acp-adapter", "harnessId": "codex-cli", "provider": "openai",
				"label": "Codex ACP adapter (next)", "version": "2.0.0",
				"platforms": {"darwin-arm64": {"kind": "manual", "executablePath": "bin/codex-acp"}},
				"launch": {}
			},
			{
				"id": "claude-cli", "kind": "harness", "harnessId": "claude-cli", "provider": "anthropic",
				"label": "Claude Code", "version": "2.1.0",
				"platforms": {"darwin-arm64": {"kind": "manual", "executablePath": "bin/claude"}},
				"launch": {}
			}
		]
	}`)
	manifest, err := ParseManifest(manifestJSON)
	require.NoError(t, err)
	return manifest
}

// versionedEntry clones entry at another version, which is how a component's two coexisting
// installed versions are built without a second manifest component.
func versionedEntry(entry ComponentManifestEntry, version string) ComponentManifestEntry {
	entry.Version = version
	return entry
}

// declaredManifest is the manifest shape a real Barista build carries: at most one version per
// component id, which Manifest.Validate enforces. Every entry after the first for a given id is
// dropped, mirroring how a manifest bump replaces a component's declared version rather than adding
// one beside it.
func declaredManifest(t *testing.T, entries ...ComponentManifestEntry) Manifest {
	t.Helper()
	declared := []ComponentManifestEntry{}
	seen := map[string]bool{}
	for _, entry := range entries {
		if seen[entry.ID] {
			continue
		}
		seen[entry.ID] = true
		declared = append(declared, entry)
	}
	manifest := Manifest{ManifestVersion: ManifestVersion, Components: declared}
	require.NoError(t, manifest.Validate(), "an activation test must never rely on a manifest the real parser would reject")
	return manifest
}

// activationFixture is one prepared data root: a manifest, an ownership ledger with every installed
// version recorded, and the platform under test.
type activationFixture struct {
	dataRoot string
	manifest Manifest
	platform string
	ledger   OwnershipLedger
}

func newActivationFixture(t *testing.T, entries ...ComponentManifestEntry) *activationFixture {
	t.Helper()
	fixture := &activationFixture{dataRoot: t.TempDir(), manifest: declaredManifest(t, entries...), platform: "darwin-arm64"}
	for _, entry := range entries {
		fixture.install(t, entry)
	}
	return fixture
}

// install places the entry's payload at its deterministic target path and records it, exactly as a
// successful apply does, then persists the ledger.
func (fixture *activationFixture) install(t *testing.T, entry ComponentManifestEntry) string {
	t.Helper()
	content := []byte("payload for " + entry.Ref().String())
	updated, target := installOwnedComponent(t, fixture.dataRoot, fixture.ledger, entry, content)
	fixture.ledger = updated
	require.NoError(t, fixture.ledger.Save(fixture.dataRoot))
	return target
}

func (fixture *activationFixture) targetFor(t *testing.T, entry ComponentManifestEntry) string {
	t.Helper()
	target, err := ComponentTargetPath(fixture.dataRoot, entry, entry.Platforms[fixture.platform])
	require.NoError(t, err)
	return target
}

// context builds an ActivationContext against the fixture's current on-disk state. Every operation
// reloads the activation ledger, so a test always acts on what was durably written.
func (fixture *activationFixture) context(probe ComponentProbe, inUse func(string) bool) ActivationContext {
	if inUse == nil {
		inUse = func(string) bool { return false }
	}
	ledger, err := LoadOwnershipLedger(fixture.dataRoot)
	if err == nil {
		fixture.ledger = ledger
	}
	return ActivationContext{
		DataRoot:   fixture.dataRoot,
		Manifest:   fixture.manifest,
		Platform:   fixture.platform,
		Ownership:  fixture.ledger,
		Activation: LoadActivationState(fixture.dataRoot),
		Probe:      probe,
		InUse:      inUse,
	}
}

// declareVersion replaces the declared version of one component id, which is exactly what a Barista
// upgrade does: the previous version stops being declared while its installed files remain owned.
func (fixture *activationFixture) declareVersion(t *testing.T, entry ComponentManifestEntry, version string) {
	t.Helper()
	components := []ComponentManifestEntry{versionedEntry(entry, version)}
	for _, existing := range fixture.manifest.Components {
		if existing.ID != entry.ID {
			components = append(components, existing)
		}
	}
	fixture.manifest = declaredManifest(t, components...)
}

// activate declares the candidate version and selects it, which is the real operator sequence: a
// manifest bump declares the new version, apply installs it, activate selects it.
func (fixture *activationFixture) activate(t *testing.T, entry ComponentManifestEntry, version string, probe ComponentProbe, inUse func(string) bool) (ActivationOutcome, error) {
	t.Helper()
	fixture.declareVersion(t, entry, version)
	return Activate(context.Background(), fixture.context(probe, inUse), ComponentSelector{Kind: entry.Kind, ID: entry.ID, Version: version})
}

// acceptingProbe accepts every candidate. A test that needs a refusal uses refusingProbe.
func acceptingProbe(calls *int) ComponentProbe {
	return func(context.Context, InstalledComponent) error {
		if calls != nil {
			*calls++
		}
		return nil
	}
}

func refusingProbe() ComponentProbe {
	return func(context.Context, InstalledComponent) error {
		return errors.New("the candidate did not answer its version contract")
	}
}

func activationFileBytes(t *testing.T, dataRoot string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dataRoot, "activation.json"))
	require.NoError(t, err)
	return data
}

// TestActivationAbsentRecordNeverSelectsInstalledVersion proves installation and activation are
// separate operations: a freshly installed, fully verified version is not launchable, and the absent
// selection is never inferred from the installed set, the ledger order, or the highest version.
func TestActivationAbsentRecordNeverSelectsInstalledVersion(t *testing.T) {
	adapter := activationManifestFixture(t).Components[0]
	fixture := newActivationFixture(t, adapter, versionedEntry(adapter, "2.0.0"))

	state := LoadActivationState(fixture.dataRoot)
	require.NoError(t, state.Rejection)
	require.Equal(t, ActivationLedgerGenerationAbsent, state.Generation)
	require.Empty(t, state.Ledger.Records)

	_, err := ActiveInstalledComponent(fixture.dataRoot, fixture.manifest, fixture.platform, fixture.ledger, state, adapter.Ref().Identity())
	require.ErrorIs(t, err, ErrComponentNotActivated)

	// Both versions verify on their own, so the refusal is about the missing selection and nothing
	// else.
	for _, version := range []string{"1.0.0", "2.0.0"} {
		_, verifyErr := VerifyInstalledComponent(fixture.dataRoot, versionedEntry(adapter, version), fixture.platform, fixture.ledger)
		require.NoError(t, verifyErr)
	}
	require.NoFileExists(t, filepath.Join(fixture.dataRoot, "activation.json"))
}

// TestActivateSelectsVerifiedVersion proves activation records the selection atomically and that
// launch resolution then returns exactly that path.
func TestActivateSelectsVerifiedVersion(t *testing.T) {
	adapter := activationManifestFixture(t).Components[0]
	fixture := newActivationFixture(t, adapter, versionedEntry(adapter, "2.0.0"))
	probes := 0

	outcome, err := fixture.activate(t, adapter, "2.0.0", acceptingProbe(&probes), nil)
	require.NoError(t, err)
	require.True(t, outcome.Changed)
	require.Equal(t, "2.0.0", outcome.Active.Version)
	require.Nil(t, outcome.Previous)
	require.Equal(t, 1, probes)

	state := LoadActivationState(fixture.dataRoot)
	require.NoError(t, state.Rejection)
	require.Equal(t, ActivationLedgerVersion, state.Generation)
	installed, err := ActiveInstalledComponent(fixture.dataRoot, fixture.manifest, fixture.platform, fixture.ledger, state, adapter.Ref().Identity())
	require.NoError(t, err)
	require.Equal(t, fixture.targetFor(t, versionedEntry(adapter, "2.0.0")), installed.Path)

	// Activating the other installed version retains the first as the rollback target.
	second, err := fixture.activate(t, adapter, "1.0.0", acceptingProbe(&probes), nil)
	require.NoError(t, err)
	require.Equal(t, "1.0.0", second.Active.Version)
	require.NotNil(t, second.Previous)
	require.Equal(t, "2.0.0", second.Previous.Version)
}

// TestActivateFailedProbeKeepsPriorSelection proves a candidate that fails its file checks or its
// probe never replaces the working active version, and that nothing on disk changes.
func TestActivateFailedProbeKeepsPriorSelection(t *testing.T) {
	adapter := activationManifestFixture(t).Components[0]
	fixture := newActivationFixture(t, adapter, versionedEntry(adapter, "2.0.0"))
	_, err := fixture.activate(t, adapter, "1.0.0", acceptingProbe(nil), nil)
	require.NoError(t, err)
	before := activationFileBytes(t, fixture.dataRoot)

	// A candidate whose probe refuses.
	_, err = fixture.activate(t, adapter, "2.0.0", refusingProbe(), nil)
	require.Error(t, err)
	require.Contains(t, err.Error(), "failed its probe")
	require.Equal(t, before, activationFileBytes(t, fixture.dataRoot))

	// A candidate whose bytes drifted from the ownership ledger. The probe must never even run.
	drifted := versionedEntry(adapter, "2.0.0")
	require.NoError(t, os.WriteFile(fixture.targetFor(t, drifted), []byte("tampered"), 0o755))
	probes := 0
	_, err = fixture.activate(t, adapter, "2.0.0", acceptingProbe(&probes), nil)
	require.Error(t, err)
	require.Equal(t, 0, probes)
	require.Equal(t, before, activationFileBytes(t, fixture.dataRoot))

	// A candidate the ownership ledger never recorded.
	unowned := versionedEntry(adapter, "3.0.0")
	fixture.declareVersion(t, adapter, "3.0.0")
	target := fixture.targetFor(t, unowned)
	require.NoError(t, os.MkdirAll(filepath.Dir(target), 0o755))
	require.NoError(t, os.WriteFile(target, []byte("never recorded"), 0o755))
	_, err = fixture.activate(t, adapter, "3.0.0", acceptingProbe(nil), nil)
	require.ErrorContains(t, err, "ownership ledger")
	require.Equal(t, before, activationFileBytes(t, fixture.dataRoot))

	// And the selection that was durable before every refusal is still the one launch resolves.
	state := LoadActivationState(fixture.dataRoot)
	installed, err := ActiveInstalledComponent(fixture.dataRoot, fixture.manifest, fixture.platform, fixture.ledger, state, adapter.Ref().Identity())
	require.NoError(t, err)
	require.Equal(t, "1.0.0", installed.Ref().Version)
}

// TestActivationRecordRejectionMatrix proves every malformed, ambiguous, or out-of-root activation
// file refuses launch, is reported with its rejected generation, and is left byte-identical on disk —
// and is never downgraded to "absent".
func TestActivationRecordRejectionMatrix(t *testing.T) {
	adapter := activationManifestFixture(t).Components[0]
	reference := newActivationFixture(t, adapter)
	target := reference.targetFor(t, adapter)
	digest := sha256Hex([]byte("payload for " + adapter.Ref().String()))
	valid := func() map[string]any {
		return map[string]any{
			"ledgerVersion": ActivationLedgerVersion,
			"records": []any{map[string]any{
				"active": map[string]any{"component": map[string]any{"kind": "acp-adapter", "id": "codex-acp", "version": "1.0.0"}, "path": target, "contentSha256": digest},
			}},
		}
	}
	mutate := func(apply func(document map[string]any)) []byte {
		document := valid()
		apply(document)
		encoded, err := json.Marshal(document)
		require.NoError(t, err)
		return encoded
	}
	records := func(document map[string]any) []any { return document["records"].([]any) }
	active := func(document map[string]any) map[string]any {
		return records(document)[0].(map[string]any)["active"].(map[string]any)
	}

	tests := []struct {
		name     string
		bytes    []byte
		rejected bool // true when the failure is a record-level rejection carrying a generation
		contains string
	}{
		{name: "truncated", bytes: []byte(`{"ledgerVersion": "1", "records": [`), contains: "decode activation ledger"},
		{name: "trailing data", bytes: append(mutate(func(map[string]any) {}), []byte(`{"ledgerVersion":"1"}`)...), contains: "trailing data"},
		{name: "unknown field", bytes: mutate(func(document map[string]any) { document["surprise"] = true }), contains: "decode activation ledger"},
		{name: "unknown generation", bytes: mutate(func(document map[string]any) { document["ledgerVersion"] = "9" }), contains: "generation is unknown"},
		{name: "absent generation", bytes: mutate(func(document map[string]any) { delete(document, "ledgerVersion") }), contains: "generation is unknown"},
		{
			name:     "unknown kind",
			bytes:    mutate(func(document map[string]any) { active(document)["component"].(map[string]any)["kind"] = "plugin" }),
			rejected: true, contains: "component kind is unknown",
		},
		{
			name:     "empty kind is not a wildcard",
			bytes:    mutate(func(document map[string]any) { active(document)["component"].(map[string]any)["kind"] = "" }),
			rejected: true, contains: "component kind is unknown",
		},
		{
			name:     "non kebab-case id",
			bytes:    mutate(func(document map[string]any) { active(document)["component"].(map[string]any)["id"] = "Codex_ACP" }),
			rejected: true, contains: "component id is not kebab-case",
		},
		{
			name:     "unnormalized version",
			bytes:    mutate(func(document map[string]any) { active(document)["component"].(map[string]any)["version"] = "v1" }),
			rejected: true, contains: "component version is not a normalized dotted version",
		},
		{
			name:     "no identity",
			bytes:    mutate(func(document map[string]any) { delete(active(document), "component") }),
			rejected: true, contains: "no component identity",
		},
		{
			name:     "no digest",
			bytes:    mutate(func(document map[string]any) { delete(active(document), "contentSha256") }),
			rejected: true, contains: "contentSha256 is not a sha256 digest",
		},
		{
			name: "relative path",
			bytes: mutate(func(document map[string]any) {
				active(document)["path"] = "adapters/codex-cli/codex-acp/1.0.0/bin/codex-acp"
			}),
			rejected: true, contains: "absolute, already-clean path",
		},
		{
			name:     "unclean path",
			bytes:    mutate(func(document map[string]any) { active(document)["path"] = target + "/." }),
			rejected: true, contains: "absolute, already-clean path",
		},
		{
			name: "duplicated identity",
			bytes: mutate(func(document map[string]any) {
				document["records"] = append(records(document), records(document)[0])
			}),
			rejected: true, contains: "duplicates an earlier record's component identity",
		},
		{
			name: "previous names another identity",
			bytes: mutate(func(document map[string]any) {
				records(document)[0].(map[string]any)["previous"] = map[string]any{
					"component":     map[string]any{"kind": "acp-adapter", "id": "other-acp", "version": "1.0.0"},
					"path":          target,
					"contentSha256": digest,
				}
			}),
			rejected: true, contains: "previous names a different component identity",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			dataRoot := t.TempDir()
			require.NoError(t, os.WriteFile(filepath.Join(dataRoot, "activation.json"), test.bytes, 0o644))
			state := LoadActivationState(dataRoot)
			require.Error(t, state.Rejection)
			require.Contains(t, state.Rejection.Error(), test.contains)
			// Never "absent": the ledger is empty but the rejection is what every consumer sees.
			require.Empty(t, state.Ledger.Records)
			var rejection *ActivationRejectionError
			if test.rejected {
				require.True(t, errors.As(state.Rejection, &rejection))
				require.Equal(t, ActivationLedgerVersion, rejection.SourceGeneration)
				require.Regexp(t, `record \d+: `, state.Rejection.Error())
			}
			// Launch refuses with the rejection reason, not with ErrComponentNotActivated.
			_, err := ActiveInstalledComponent(dataRoot, reference.manifest, reference.platform, reference.ledger, state, adapter.Ref().Identity())
			require.Error(t, err)
			require.NotErrorIs(t, err, ErrComponentNotActivated)
			// Every mutation refuses before touching anything.
			activationContext := ActivationContext{
				DataRoot: dataRoot, Manifest: reference.manifest, Platform: reference.platform,
				Ownership: reference.ledger, Activation: state, Probe: acceptingProbe(nil),
				InUse: func(string) bool { return false },
			}
			_, err = Activate(context.Background(), activationContext, ComponentSelector{Kind: adapter.Kind, ID: adapter.ID, Version: "1.0.0"})
			require.ErrorContains(t, err, "activation ledger cannot be accepted")
			_, err = Rollback(context.Background(), activationContext, ComponentSelector{Kind: adapter.Kind, ID: adapter.ID})
			require.ErrorContains(t, err, "activation ledger cannot be accepted")
			_, _, err = Prune(activationContext, ComponentSelector{Kind: adapter.Kind, ID: adapter.ID})
			require.ErrorContains(t, err, "activation ledger cannot be accepted")
			// The bytes are untouched.
			require.Equal(t, test.bytes, activationFileBytes(t, dataRoot))
		})
	}
}

// TestActivationRecordOutOfRootPathIsReportableButNeverFollowed proves a record whose path lies
// outside the data root loads — so doctor can report it — but never resolves to a launch.
func TestActivationRecordOutOfRootPathIsReportableButNeverFollowed(t *testing.T) {
	adapter := activationManifestFixture(t).Components[0]
	fixture := newActivationFixture(t, adapter)
	foreign := filepath.Join(t.TempDir(), "outside-adapter")
	require.NoError(t, os.WriteFile(foreign, []byte("foreign bytes"), 0o755))
	ledger := ActivationLedger{}.WithRecord(ActivationRecord{Active: ActivationTarget{
		Component: adapter.Ref(), Path: foreign, ContentSHA256: sha256Hex([]byte("foreign bytes")),
	}})
	require.NoError(t, ledger.Save(fixture.dataRoot))

	state := LoadActivationState(fixture.dataRoot)
	require.NoError(t, state.Rejection, "a foreign path must stay loadable so it can be reported")
	record, activated := state.Ledger.RecordFor(adapter.Ref().Identity())
	require.True(t, activated)
	require.Equal(t, foreign, record.Active.Path)

	_, err := ActiveInstalledComponent(fixture.dataRoot, fixture.manifest, fixture.platform, fixture.ledger, state, adapter.Ref().Identity())
	require.ErrorContains(t, err, "is not this component version's install location")
}

// TestActivationCrashRecoveryLeavesOneSelection interrupts the write path and restarts: a crash
// before the rename leaves the previous selection authoritative and only a removable temp file
// behind, never two active versions and never a torn file.
func TestActivationCrashRecoveryLeavesOneSelection(t *testing.T) {
	adapter := activationManifestFixture(t).Components[0]
	fixture := newActivationFixture(t, adapter, versionedEntry(adapter, "2.0.0"))
	_, err := fixture.activate(t, adapter, "1.0.0", acceptingProbe(nil), nil)
	require.NoError(t, err)
	durable := activationFileBytes(t, fixture.dataRoot)

	// Simulate a process that died between writing its temp file and renaming it: the temp file is
	// present, the destination still holds the previous bytes.
	torn := ActivationLedger{}.WithRecord(ActivationRecord{Active: ActivationTarget{
		Component: versionedEntry(adapter, "2.0.0").Ref(), Path: fixture.targetFor(t, versionedEntry(adapter, "2.0.0")), ContentSHA256: sha256Hex([]byte("partial")),
	}})
	encoded, err := json.MarshalIndent(torn, "", "  ")
	require.NoError(t, err)
	temporary, err := os.CreateTemp(fixture.dataRoot, ".activation-*")
	require.NoError(t, err)
	_, err = temporary.Write(encoded[:len(encoded)/2])
	require.NoError(t, err)
	require.NoError(t, temporary.Close())

	// Restart: the loader reads only the destination, so exactly one selection is authoritative.
	state := LoadActivationState(fixture.dataRoot)
	require.NoError(t, state.Rejection)
	require.Len(t, state.Ledger.Records, 1)
	installed, err := ActiveInstalledComponent(fixture.dataRoot, fixture.manifest, fixture.platform, fixture.ledger, state, adapter.Ref().Identity())
	require.NoError(t, err)
	require.Equal(t, "1.0.0", installed.Ref().Version)
	require.Equal(t, durable, activationFileBytes(t, fixture.dataRoot))

	// Re-running the interrupted activation now succeeds and still leaves exactly one selection.
	_, err = fixture.activate(t, adapter, "2.0.0", acceptingProbe(nil), nil)
	require.NoError(t, err)
	state = LoadActivationState(fixture.dataRoot)
	require.NoError(t, state.Rejection)
	require.Len(t, state.Ledger.Records, 1)
	require.Equal(t, "2.0.0", state.Ledger.Records[0].Active.Component.Version)
}

// TestActivateIsIdempotentForCurrentVersion proves an exact replay writes nothing and succeeds.
func TestActivateIsIdempotentForCurrentVersion(t *testing.T) {
	adapter := activationManifestFixture(t).Components[0]
	fixture := newActivationFixture(t, adapter, versionedEntry(adapter, "2.0.0"))
	selector := ComponentSelector{Kind: adapter.Kind, ID: adapter.ID, Version: "1.0.0"}
	_, err := Activate(context.Background(), fixture.context(acceptingProbe(nil), nil), selector)
	require.NoError(t, err)
	before := activationFileBytes(t, fixture.dataRoot)
	information, err := os.Stat(filepath.Join(fixture.dataRoot, "activation.json"))
	require.NoError(t, err)

	probes := 0
	outcome, err := Activate(context.Background(), fixture.context(acceptingProbe(&probes), nil), selector)
	require.NoError(t, err)
	require.False(t, outcome.Changed)
	require.Equal(t, "1.0.0", outcome.Active.Version)
	require.Equal(t, 0, probes, "an exact replay re-verifies but never re-probes or re-writes")
	require.Equal(t, before, activationFileBytes(t, fixture.dataRoot))
	after, err := os.Stat(filepath.Join(fixture.dataRoot, "activation.json"))
	require.NoError(t, err)
	require.Equal(t, information.ModTime(), after.ModTime())
}

// TestRollbackSelectsRetainedVersion proves rollback re-selects the retained previously verified
// version and consumes the retained target rather than swapping it.
func TestRollbackSelectsRetainedVersion(t *testing.T) {
	adapter := activationManifestFixture(t).Components[0]
	fixture := newActivationFixture(t, adapter, versionedEntry(adapter, "2.0.0"))
	_, err := fixture.activate(t, adapter, "1.0.0", acceptingProbe(nil), nil)
	require.NoError(t, err)
	_, err = fixture.activate(t, adapter, "2.0.0", acceptingProbe(nil), nil)
	require.NoError(t, err)

	// The manifest now declares only 2.0.0, which is the ordinary state after a Barista upgrade: the
	// retained 1.0.0 is still owned and still verifiable, so rollback must not need it declared.
	_, declared := manifestEntryFor(fixture.manifest, versionedEntry(adapter, "1.0.0").Ref())
	require.False(t, declared)

	outcome, err := Rollback(context.Background(), fixture.context(acceptingProbe(nil), nil), ComponentSelector{Kind: adapter.Kind, ID: adapter.ID})
	require.NoError(t, err)
	require.True(t, outcome.Changed)
	require.Equal(t, "1.0.0", outcome.Active.Version)
	require.Nil(t, outcome.Previous, "rollback consumes the retained target instead of swapping it")

	state := LoadActivationState(fixture.dataRoot)
	installed, err := ActiveInstalledComponent(fixture.dataRoot, fixture.manifest, fixture.platform, fixture.ledger, state, adapter.Ref().Identity())
	require.NoError(t, err)
	require.Equal(t, "1.0.0", installed.Ref().Version)
	// The failed candidate's files are never deleted by a rollback.
	require.FileExists(t, fixture.targetFor(t, versionedEntry(adapter, "2.0.0")))

	// A second rollback has nothing retained and refuses without changing the selection.
	before := activationFileBytes(t, fixture.dataRoot)
	_, err = Rollback(context.Background(), fixture.context(acceptingProbe(nil), nil), ComponentSelector{Kind: adapter.Kind, ID: adapter.ID})
	require.ErrorContains(t, err, "no previously verified version is retained")
	require.Equal(t, before, activationFileBytes(t, fixture.dataRoot))
}

// TestRollbackRefusesDriftedTarget proves a drifted, removed, or never-activated rollback target
// refuses the rollback and leaves the current selection unchanged.
func TestRollbackRefusesDriftedTarget(t *testing.T) {
	adapter := activationManifestFixture(t).Components[0]
	selector := ComponentSelector{Kind: adapter.Kind, ID: adapter.ID}

	t.Run("never activated", func(t *testing.T) {
		fixture := newActivationFixture(t, adapter)
		_, err := Rollback(context.Background(), fixture.context(acceptingProbe(nil), nil), selector)
		require.ErrorIs(t, err, ErrComponentNotActivated)
		require.NoFileExists(t, filepath.Join(fixture.dataRoot, "activation.json"))
	})

	for _, test := range []struct {
		name    string
		damage  func(t *testing.T, fixture *activationFixture, target string)
		message string
	}{
		{
			name: "drifted",
			damage: func(t *testing.T, _ *activationFixture, target string) {
				require.NoError(t, os.WriteFile(target, []byte("tampered"), 0o755))
			},
			message: "no longer matches the ownership ledger",
		},
		{
			name: "absent",
			damage: func(t *testing.T, _ *activationFixture, target string) {
				require.NoError(t, os.Remove(target))
			},
			message: "not installed",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newActivationFixture(t, adapter, versionedEntry(adapter, "2.0.0"))
			_, err := fixture.activate(t, adapter, "1.0.0", acceptingProbe(nil), nil)
			require.NoError(t, err)
			_, err = fixture.activate(t, adapter, "2.0.0", acceptingProbe(nil), nil)
			require.NoError(t, err)
			before := activationFileBytes(t, fixture.dataRoot)

			test.damage(t, fixture, fixture.targetFor(t, adapter))
			_, err = Rollback(context.Background(), fixture.context(acceptingProbe(nil), nil), selector)
			require.ErrorContains(t, err, test.message)
			require.Equal(t, before, activationFileBytes(t, fixture.dataRoot))
			state := LoadActivationState(fixture.dataRoot)
			installed, err := ActiveInstalledComponent(fixture.dataRoot, fixture.manifest, fixture.platform, fixture.ledger, state, adapter.Ref().Identity())
			require.NoError(t, err)
			require.Equal(t, "2.0.0", installed.Ref().Version, "the current selection is unchanged")
		})
	}
}

// TestActivationRefusesBusyComponent proves an executable that currently supervises a run cannot be
// activated, rolled back, or pruned, and that the diagnostic names only the component identity.
func TestActivationRefusesBusyComponent(t *testing.T) {
	adapter := activationManifestFixture(t).Components[0]
	fixture := newActivationFixture(t, adapter, versionedEntry(adapter, "2.0.0"))
	_, err := fixture.activate(t, adapter, "1.0.0", acceptingProbe(nil), nil)
	require.NoError(t, err)
	_, err = fixture.activate(t, adapter, "2.0.0", acceptingProbe(nil), nil)
	require.NoError(t, err)
	before := activationFileBytes(t, fixture.dataRoot)
	activePath := fixture.targetFor(t, versionedEntry(adapter, "2.0.0"))
	retainedPath := fixture.targetFor(t, adapter)
	busy := func(path string) bool { return path == activePath || path == retainedPath }

	probes := 0
	_, err = fixture.activate(t, adapter, "1.0.0", acceptingProbe(&probes), busy)
	require.ErrorContains(t, err, "a run is currently using")
	_, err = Rollback(context.Background(), fixture.context(acceptingProbe(&probes), busy), ComponentSelector{Kind: adapter.Kind, ID: adapter.ID})
	require.ErrorContains(t, err, "a run is currently using")
	_, _, pruneErr := Prune(fixture.context(acceptingProbe(&probes), busy), ComponentSelector{Kind: adapter.Kind, ID: adapter.ID})
	require.ErrorContains(t, pruneErr, "a run is currently using")

	require.Equal(t, 0, probes, "a busy component is refused before its candidate is ever started")
	require.Equal(t, before, activationFileBytes(t, fixture.dataRoot))
	for _, err := range []error{err, pruneErr} {
		require.NotContains(t, err.Error(), fixture.dataRoot, "a busy diagnostic must never carry a path")
		require.NotContains(t, err.Error(), activePath)
	}
	require.FileExists(t, activePath)
	require.FileExists(t, retainedPath)
}

// TestPruneRetainsActiveRetainedAndDriftedFiles proves prune removes only inactive, ledger-owned,
// digest-matching files, never the active or retained version, never a directory, never an unowned
// file, and that replaying it converges.
func TestPruneRetainsActiveRetainedAndDriftedFiles(t *testing.T) {
	adapter := activationManifestFixture(t).Components[0]
	entries := []ComponentManifestEntry{
		adapter,
		versionedEntry(adapter, "2.0.0"),
		versionedEntry(adapter, "3.0.0"),
		versionedEntry(adapter, "4.0.0"),
	}
	fixture := newActivationFixture(t, entries...)
	_, err := fixture.activate(t, adapter, "1.0.0", acceptingProbe(nil), nil)
	require.NoError(t, err)
	_, err = fixture.activate(t, adapter, "2.0.0", acceptingProbe(nil), nil)
	require.NoError(t, err)

	// 3.0.0 drifted from its record and must be retained with its diagnostic; 4.0.0 is a clean
	// inactive version and is the only removable one. An unowned file beside it is never touched.
	driftedPath := fixture.targetFor(t, entries[2])
	require.NoError(t, os.WriteFile(driftedPath, []byte("tampered"), 0o755))
	removablePath := fixture.targetFor(t, entries[3])
	unownedPath := filepath.Join(filepath.Dir(removablePath), "operator-note.txt")
	require.NoError(t, os.WriteFile(unownedPath, []byte("not ours"), 0o644))

	result, ledger, err := Prune(fixture.context(acceptingProbe(nil), nil), ComponentSelector{Kind: adapter.Kind, ID: adapter.ID})
	require.NoError(t, err)
	require.Len(t, result.Removed, 1)
	require.Equal(t, "4.0.0", result.Removed[0].Component.Version)
	require.NoFileExists(t, removablePath)
	require.FileExists(t, unownedPath)
	require.DirExists(t, filepath.Dir(removablePath), "prune removes files, never a directory")
	require.FileExists(t, fixture.targetFor(t, entries[0]))
	require.FileExists(t, fixture.targetFor(t, entries[1]))
	require.FileExists(t, driftedPath)
	reasons := map[string]string{}
	for _, retained := range result.Retained {
		reasons[retained.Record.Component.Version] = retained.Reason
	}
	require.Equal(t, PruneRetainedRollback, reasons["1.0.0"])
	require.Equal(t, PruneRetainedActive, reasons["2.0.0"])
	require.Equal(t, PruneRetainedDrifted, reasons["3.0.0"])
	_, stillOwned := ledger.RecordFor(removablePath)
	require.False(t, stillOwned)
	_, driftedStillOwned := ledger.RecordFor(driftedPath)
	require.True(t, driftedStillOwned, "a drifted file stays in the ledger so it stays reportable")

	// Replay converges: nothing new is removed and the same retentions are reported.
	replay, _, err := Prune(fixture.context(acceptingProbe(nil), nil), ComponentSelector{Kind: adapter.Kind, ID: adapter.ID})
	require.NoError(t, err)
	require.Empty(t, replay.Removed)
	require.Len(t, replay.Retained, 3)
	// The selection is untouched by pruning.
	state := LoadActivationState(fixture.dataRoot)
	installed, err := ActiveInstalledComponent(fixture.dataRoot, fixture.manifest, fixture.platform, fixture.ledger, state, adapter.Ref().Identity())
	require.NoError(t, err)
	require.Equal(t, "2.0.0", installed.Ref().Version)
}

// TestActivationRecordPathAndDigestGrammar proves the activation record reuses the shared path and
// digest grammars rather than defining its own.
func TestActivationRecordPathAndDigestGrammar(t *testing.T) {
	valid := ActivationTarget{
		Component:     ComponentRef{Kind: ComponentKindACPAdapter, ID: "codex-acp", Version: "1.0.0"},
		Path:          filepath.Join(string(filepath.Separator), "var", "lib", "barista", "adapters", "codex-cli", "codex-acp", "1.0.0", "bin", "codex-acp"),
		ContentSHA256: strings.Repeat("a", 64),
	}
	encode := func(target ActivationTarget) []byte {
		encoded, err := json.Marshal(ActivationLedger{LedgerVersion: ActivationLedgerVersion, Records: []ActivationRecord{{Active: target}}})
		require.NoError(t, err)
		return encoded
	}
	_, _, err := ParseActivationLedger(encode(valid))
	require.NoError(t, err)

	relative := valid
	relative.Path = "adapters/codex-cli/codex-acp/1.0.0/bin/codex-acp"
	_, _, err = ParseActivationLedger(encode(relative))
	require.ErrorContains(t, err, "absolute, already-clean path")

	uppercase := valid
	uppercase.ContentSHA256 = strings.ToUpper(valid.ContentSHA256)
	ledger, _, err := ParseActivationLedger(encode(uppercase))
	require.NoError(t, err, "an uppercase digest is lowered, exactly as the ownership ledger does")
	require.Equal(t, valid.ContentSHA256, ledger.Records[0].Active.ContentSHA256)

	for _, digest := range []string{"", "not-a-digest", strings.Repeat("a", 63), strings.Repeat("g", 64)} {
		bad := valid
		bad.ContentSHA256 = digest
		_, _, err = ParseActivationLedger(encode(bad))
		require.ErrorContains(t, err, "contentSha256 is not a sha256 digest")
	}
}

// TestActivationLedgerFixtureIsWhatSaveProduces pins the checked-in activation ledger fixture to the
// exact bytes the real producer writes, and proves the loader accepts those bytes byte-for-byte. A
// hand-written fixture could drift from what Save emits; this one cannot.
func TestActivationLedgerFixtureIsWhatSaveProduces(t *testing.T) {
	// The fixture's data root is a fixed absolute path so the bytes are machine-independent. Save
	// writes into the directory it is given, which is why the temporary directory and the recorded
	// paths differ here and only here.
	fixtureRoot := "/var/lib/barista"
	adapterPath := filepath.ToSlash(filepath.Join(fixtureRoot, "adapters", "codex-cli", "codex-acp", "2.0.0", "bin", "codex-acp"))
	previousPath := filepath.ToSlash(filepath.Join(fixtureRoot, "adapters", "codex-cli", "codex-acp", "1.0.0", "bin", "codex-acp"))
	harnessPath := filepath.ToSlash(filepath.Join(fixtureRoot, "harnesses", "claude-cli", "claude-cli", "2.1.0", "bin", "claude"))
	if runtime.GOOS == "windows" {
		t.Skip("the checked-in fixture records POSIX absolute paths")
	}
	previous := ActivationTarget{
		Component:     ComponentRef{Kind: ComponentKindACPAdapter, ID: "codex-acp", Version: "1.0.0"},
		Path:          previousPath,
		ContentSHA256: strings.Repeat("1", 64),
	}
	ledger := ActivationLedger{Records: []ActivationRecord{
		{
			Active: ActivationTarget{
				Component:     ComponentRef{Kind: ComponentKindACPAdapter, ID: "codex-acp", Version: "2.0.0"},
				Path:          adapterPath,
				ContentSHA256: strings.Repeat("2", 64),
			},
			Previous: &previous,
		},
		{
			Active: ActivationTarget{
				Component:     ComponentRef{Kind: ComponentKindHarness, ID: "claude-cli", Version: "2.1.0"},
				Path:          harnessPath,
				ContentSHA256: strings.Repeat("3", 64),
			},
		},
	}}
	produced := t.TempDir()
	require.NoError(t, ledger.Save(produced))
	written := activationFileBytes(t, produced)

	fixture, err := os.ReadFile(filepath.Join("testdata", "activation-generation-1.json"))
	require.NoError(t, err)
	require.Equal(t, string(fixture), string(written), "regenerate testdata/activation-generation-1.json from ActivationLedger.Save")

	parsed, generation, err := ParseActivationLedger(fixture)
	require.NoError(t, err)
	require.Equal(t, ActivationLedgerVersion, generation)
	require.Equal(t, ledger.Records, parsed.Records)
	require.Equal(t, "2.0.0", mustRecord(t, parsed, ComponentIdentity{Kind: ComponentKindACPAdapter, ID: "codex-acp"}).Active.Component.Version)
	require.Equal(t, "1.0.0", mustRecord(t, parsed, ComponentIdentity{Kind: ComponentKindACPAdapter, ID: "codex-acp"}).Previous.Component.Version)
}

func mustRecord(t *testing.T, ledger ActivationLedger, identity ComponentIdentity) ActivationRecord {
	t.Helper()
	record, found := ledger.RecordFor(identity)
	require.True(t, found)
	return record
}

// TestActivationVocabularyIsClosed proves every value of every enumeration this issue introduces is
// handled or rejected, and that no value outside it is ever defaulted.
func TestActivationVocabularyIsClosed(t *testing.T) {
	for _, provenance := range ComponentProvenances {
		require.True(t, provenance.Valid(), "%s", provenance)
	}
	require.False(t, ComponentProvenance("").Valid())
	require.False(t, ComponentProvenance("managed-active").Valid())

	// Every component kind either has an activation probe policy or refuses activation outright; a
	// kind with no compiled-in probe must never be activated unprobed.
	for _, kind := range ComponentKinds {
		identity := ComponentIdentity{Kind: kind, ID: "some-component"}
		require.NoError(t, identity.Validate())
		require.Equal(t, string(kind)+"/some-component", identity.String())
	}
	require.Error(t, ComponentIdentity{Kind: ComponentKind("plugin"), ID: "x"}.Validate())
	require.Error(t, ComponentIdentity{ID: "x"}.Validate(), "an empty kind is never a wildcard")
	require.Error(t, ComponentIdentity{Kind: ComponentKindHarness}.Validate())
	require.Error(t, ComponentIdentity{Kind: ComponentKindHarness, ID: "Not_Kebab"}.Validate())

	// Every harness the version-probe allowlist covers is a harness discovery knows, so a probe can
	// never be aimed at something Barista does not recognize.
	for harnessID := range HarnessVersionProbeAllowlist {
		_, covered := AuthProbeAllowlist[harnessID]
		require.True(t, covered, "%s", harnessID)
	}
}

// TestProbeHarnessVersionRefusesAnUnlistedHarness proves the version contract is a compiled-in
// allowlist: a harness with no entry cannot be activated at all.
func TestProbeHarnessVersionRefusesAnUnlistedHarness(t *testing.T) {
	installed := InstalledComponent{Entry: ComponentManifestEntry{
		ID: "mystery-cli", Kind: ComponentKindHarness, HarnessID: "mystery-cli", Version: "1.0.0",
	}}
	err := ProbeHarnessVersion(context.Background(), installed)
	require.ErrorContains(t, err, "no compiled-in version contract")
}

// TestActivationOperationsRefuseIncompleteEvidence proves a zero-value context or selector is never
// read as "no constraint".
func TestActivationOperationsRefuseIncompleteEvidence(t *testing.T) {
	adapter := activationManifestFixture(t).Components[0]
	fixture := newActivationFixture(t, adapter)
	selector := ComponentSelector{Kind: adapter.Kind, ID: adapter.ID, Version: "1.0.0"}

	withoutUsage := fixture.context(acceptingProbe(nil), nil)
	withoutUsage.InUse = nil
	_, err := Activate(context.Background(), withoutUsage, selector)
	require.ErrorContains(t, err, "usage check is required")

	withoutProbe := fixture.context(nil, nil)
	_, err = Activate(context.Background(), withoutProbe, selector)
	require.ErrorContains(t, err, "probe is required")

	_, err = Activate(context.Background(), fixture.context(acceptingProbe(nil), nil), ComponentSelector{Kind: adapter.Kind, ID: adapter.ID})
	require.ErrorContains(t, err, "exact component version is required")

	_, err = Rollback(context.Background(), fixture.context(acceptingProbe(nil), nil), selector)
	require.ErrorContains(t, err, "no version may be given")

	_, _, err = Prune(fixture.context(acceptingProbe(nil), nil), selector)
	require.ErrorContains(t, err, "no version may be given")

	_, err = Activate(context.Background(), fixture.context(acceptingProbe(nil), nil), ComponentSelector{})
	require.ErrorContains(t, err, "component kind is unknown")

	relativeRoot := fixture.context(acceptingProbe(nil), nil)
	relativeRoot.DataRoot = "relative/root"
	_, err = Activate(context.Background(), relativeRoot, selector)
	require.ErrorContains(t, err, "absolute path")
}

// TestActivateRefusesAVersionTheManifestDoesNotDeclare proves activation never installs, stages, or
// invents a component version.
func TestActivateRefusesAVersionTheManifestDoesNotDeclare(t *testing.T) {
	adapter := activationManifestFixture(t).Components[0]
	fixture := newActivationFixture(t, adapter)
	// Called directly rather than through the fixture helper, which would declare the version first.
	_, err := Activate(context.Background(), fixture.context(acceptingProbe(nil), nil), ComponentSelector{
		Kind: adapter.Kind, ID: adapter.ID, Version: "9.9.9",
	})
	require.ErrorContains(t, err, "does not declare this version")
	require.NoFileExists(t, filepath.Join(fixture.dataRoot, "activation.json"))
}

// TestActiveInstalledComponentRefusesDrift proves launch resolution re-verifies the selected bytes
// and never falls back to another installed version.
func TestActiveInstalledComponentRefusesDrift(t *testing.T) {
	adapter := activationManifestFixture(t).Components[0]
	fixture := newActivationFixture(t, adapter, versionedEntry(adapter, "2.0.0"))
	_, err := fixture.activate(t, adapter, "1.0.0", acceptingProbe(nil), nil)
	require.NoError(t, err)
	state := LoadActivationState(fixture.dataRoot)

	require.NoError(t, os.WriteFile(fixture.targetFor(t, adapter), []byte("tampered"), 0o755))
	_, err = ActiveInstalledComponent(fixture.dataRoot, fixture.manifest, fixture.platform, fixture.ledger, state, adapter.Ref().Identity())
	require.ErrorContains(t, err, "no longer matches the ownership ledger")

	require.NoError(t, os.Remove(fixture.targetFor(t, adapter)))
	_, err = ActiveInstalledComponent(fixture.dataRoot, fixture.manifest, fixture.platform, fixture.ledger, state, adapter.Ref().Identity())
	require.ErrorIs(t, err, ErrComponentNotInstalled)
}

// TestActivationStateFingerprintChangesWithTheRecord proves the daemon's restart check notices a
// changed or newly corrupt file and nothing else.
func TestActivationStateFingerprintChangesWithTheRecord(t *testing.T) {
	adapter := activationManifestFixture(t).Components[0]
	fixture := newActivationFixture(t, adapter, versionedEntry(adapter, "2.0.0"))
	_, err := fixture.activate(t, adapter, "1.0.0", acceptingProbe(nil), nil)
	require.NoError(t, err)
	first := LoadActivationState(fixture.dataRoot).Fingerprint()
	require.NotEmpty(t, first)
	require.Equal(t, first, LoadActivationState(fixture.dataRoot).Fingerprint())

	_, err = fixture.activate(t, adapter, "2.0.0", acceptingProbe(nil), nil)
	require.NoError(t, err)
	second := LoadActivationState(fixture.dataRoot).Fingerprint()
	require.NotEqual(t, first, second)

	require.NoError(t, os.WriteFile(filepath.Join(fixture.dataRoot, "activation.json"), []byte("{broken"), 0o644))
	require.NotEqual(t, second, LoadActivationState(fixture.dataRoot).Fingerprint())
}

// TestDoctorReportsActivationState proves doctor reports each component's active version, retained
// rollback target, and provenance, and reports a rejected ledger with its generation and repair
// guidance rather than as an absent selection.
func TestDoctorReportsActivationState(t *testing.T) {
	adapter := activationManifestFixture(t).Components[0]
	harnessEntry := activationManifestFixture(t).Components[2]
	fixture := newActivationFixture(t, adapter, versionedEntry(adapter, "2.0.0"), harnessEntry)
	_, err := fixture.activate(t, adapter, "1.0.0", acceptingProbe(nil), nil)
	require.NoError(t, err)
	_, err = fixture.activate(t, adapter, "2.0.0", acceptingProbe(nil), nil)
	require.NoError(t, err)

	report := RunDoctor(context.Background(), fixture.manifest, fixture.ledger, fixture.dataRoot, fixture.platform,
		LoadActivationState(fixture.dataRoot), nil, "", func(context.Context, string) error { return nil })
	require.True(t, report.Activation.Accepted)
	require.Equal(t, ActivationLedgerVersion, report.Activation.Generation)
	require.Empty(t, report.Activation.Rejection)

	selected := doctorEntryFor(report, "codex-acp")
	require.Equal(t, "2.0.0", selected.ActiveVersion)
	require.Equal(t, "1.0.0", selected.RollbackVersion)
	require.Equal(t, ComponentProvenanceManaged, selected.Provenance)

	// The harness component is installed but never activated: provenance is reported as the
	// documented external fallback only when an external installation actually exists.
	unselected := doctorEntryFor(report, "claude-cli")
	require.Empty(t, unselected.ActiveVersion)
	require.Empty(t, unselected.RollbackVersion)
	require.Equal(t, ComponentProvenanceNone, unselected.Provenance)
	require.Contains(t, strings.Join(unselected.Notes, " "), "installed but not activated")

	// A rejected ledger reports the rejected generation and the repair, and no provenance at all.
	require.NoError(t, os.WriteFile(filepath.Join(fixture.dataRoot, "activation.json"), []byte(`{"ledgerVersion":"1","records":[{"active":{"component":{"kind":"plugin","id":"codex-acp","version":"1.0.0"},"path":"/tmp/x","contentSha256":"`+strings.Repeat("a", 64)+`"}}]}`), 0o644))
	rejected := RunDoctor(context.Background(), fixture.manifest, fixture.ledger, fixture.dataRoot, fixture.platform,
		LoadActivationState(fixture.dataRoot), nil, "", func(context.Context, string) error { return nil })
	require.False(t, rejected.Activation.Accepted)
	require.Equal(t, ActivationLedgerVersion, rejected.Activation.Generation)
	require.Contains(t, rejected.Activation.Rejection, "record 0")
	require.Equal(t, ActivationRepairGuidance, rejected.Activation.Repair)
	for _, entry := range rejected.Components {
		require.Equal(t, ComponentProvenanceRejected, entry.Provenance)
		require.Empty(t, entry.ActiveVersion)
		require.Empty(t, entry.RollbackVersion)
	}
}

// TestDoctorReportsExternalProvenanceForAnUnselectedHarness proves the documented external PATH
// compatibility path stays visible when no managed version is selected: the harness component's
// provenance is external, not "none", and no version is ever attributed to it.
func TestDoctorReportsExternalProvenanceForAnUnselectedHarness(t *testing.T) {
	harnessEntry := activationManifestFixture(t).Components[2]
	fixture := newActivationFixture(t, harnessEntry)
	harnesses := []protocol.HarnessProfile{{ID: "claude-cli", Available: true, Binary: filepath.Join(t.TempDir(), "claude")}}

	report := RunDoctor(context.Background(), fixture.manifest, fixture.ledger, fixture.dataRoot, fixture.platform,
		LoadActivationState(fixture.dataRoot), harnesses, "", func(context.Context, string) error { return nil })

	entry := doctorEntryFor(report, "claude-cli")
	require.Equal(t, ComponentProvenanceExternal, entry.Provenance)
	require.Empty(t, entry.ActiveVersion)
	require.Empty(t, entry.RollbackVersion)
}

// TestActivateNeverWritesARecordItsOwnParserRejects is the regression for a defect review found: the
// outgoing selection used to be retained as the rollback target without comparing versions, so
// re-activating the *same* declared version after its bytes were reinstalled (a re-pinned source
// archive) wrote a record whose previous and active versions agreed — exactly what
// ParseActivationLedger rejects — and the whole activation ledger became unreadable for every
// component on the node.
func TestActivateNeverWritesARecordItsOwnParserRejects(t *testing.T) {
	adapter := activationManifestFixture(t).Components[0]
	fixture := newActivationFixture(t, adapter, versionedEntry(adapter, "2.0.0"))
	_, err := fixture.activate(t, adapter, "1.0.0", acceptingProbe(nil), nil)
	require.NoError(t, err)
	_, err = fixture.activate(t, adapter, "2.0.0", acceptingProbe(nil), nil)
	require.NoError(t, err)

	// 2.0.0 is reinstalled with different bytes at the same declared version, the way a re-pinned
	// archive would arrive, and re-activated.
	replacement := []byte("re-pinned payload for " + versionedEntry(adapter, "2.0.0").Ref().String())
	target := fixture.targetFor(t, versionedEntry(adapter, "2.0.0"))
	require.NoError(t, os.WriteFile(target, replacement, 0o755))
	record, owned := fixture.ledger.RecordFor(target)
	require.True(t, owned)
	record.ContentSHA256 = sha256Hex(replacement)
	record.SizeBytes = int64(len(replacement))
	fixture.ledger = fixture.ledger.WithRecord(record)
	require.NoError(t, fixture.ledger.Save(fixture.dataRoot))

	outcome, err := fixture.activate(t, adapter, "2.0.0", acceptingProbe(nil), nil)
	require.NoError(t, err)
	require.True(t, outcome.Changed, "the same version with different bytes is a new selection, not a replay")
	require.NotNil(t, outcome.Previous)
	require.Equal(t, "1.0.0", outcome.Previous.Version, "the genuinely older retained target survives")

	// The written ledger must be readable back: previous and active can never name one version.
	reloaded := LoadActivationState(fixture.dataRoot)
	require.NoError(t, reloaded.Rejection)
	written, activated := reloaded.Ledger.RecordFor(adapter.Ref().Identity())
	require.True(t, activated)
	require.Equal(t, "2.0.0", written.Active.Component.Version)
	require.Equal(t, sha256Hex(replacement), written.Active.ContentSHA256)
	require.NotNil(t, written.Previous)
	require.NotEqual(t, written.Active.Component.Version, written.Previous.Component.Version)

	// And the same is true on a first re-selection, where nothing older is retained at all.
	single := newActivationFixture(t, adapter)
	_, err = single.activate(t, adapter, "1.0.0", acceptingProbe(nil), nil)
	require.NoError(t, err)
	singleTarget := single.targetFor(t, adapter)
	singlePayload := []byte("re-pinned single payload")
	require.NoError(t, os.WriteFile(singleTarget, singlePayload, 0o755))
	singleRecord, owned := single.ledger.RecordFor(singleTarget)
	require.True(t, owned)
	singleRecord.ContentSHA256 = sha256Hex(singlePayload)
	single.ledger = single.ledger.WithRecord(singleRecord)
	require.NoError(t, single.ledger.Save(single.dataRoot))
	outcome, err = single.activate(t, adapter, "1.0.0", acceptingProbe(nil), nil)
	require.NoError(t, err)
	require.Nil(t, outcome.Previous)
	require.NoError(t, LoadActivationState(single.dataRoot).Rejection)
}

// TestDoctorProvenanceMatchesWhatWouldLaunch is the regression for the second defect review found:
// doctor reported provenance=managed from the activation record alone, so a drifted managed selection
// showed as managed while the daemon actually launched the external PATH binary. Provenance now comes
// from the same launch resolution the daemon uses.
func TestDoctorProvenanceMatchesWhatWouldLaunch(t *testing.T) {
	harnessEntry := activationManifestFixture(t).Components[2]
	adapter := activationManifestFixture(t).Components[0]
	fixture := newActivationFixture(t, harnessEntry, adapter)
	_, err := fixture.activate(t, harnessEntry, harnessEntry.Version, acceptingProbe(nil), nil)
	require.NoError(t, err)
	_, err = fixture.activate(t, adapter, adapter.Version, acceptingProbe(nil), nil)
	require.NoError(t, err)
	// The harness keeps its external installation available, which is what the fallback would use.
	harnesses := []protocol.HarnessProfile{{ID: "claude-cli", Available: true, Binary: filepath.Join(t.TempDir(), "claude")}}
	report := func() Report {
		return RunDoctor(context.Background(), fixture.manifest, fixture.ledger, fixture.dataRoot, fixture.platform,
			LoadActivationState(fixture.dataRoot), harnesses, "", func(context.Context, string) error { return nil })
	}
	require.Equal(t, ComponentProvenanceManaged, doctorEntryFor(report(), "claude-cli").Provenance)

	// Both activated versions drift.
	require.NoError(t, os.WriteFile(fixture.targetFor(t, harnessEntry), []byte("tampered harness"), 0o755))
	require.NoError(t, os.WriteFile(fixture.targetFor(t, adapter), []byte("tampered adapter"), 0o755))
	drifted := report()

	harnessDrift := doctorEntryFor(drifted, "claude-cli")
	require.Equal(t, harnessEntry.Version, harnessDrift.ActiveVersion, "the record is still reported")
	require.Equal(t, ComponentProvenanceExternal, harnessDrift.Provenance,
		"a drifted managed selection reports the fallback the daemon would really take")
	require.Contains(t, strings.Join(harnessDrift.Notes, " "), "the activated version could not be verified")

	adapterDrift := doctorEntryFor(drifted, "codex-acp")
	require.Equal(t, ComponentProvenanceNone, adapterDrift.Provenance, "an adapter has no external fallback")
	require.False(t, adapterDrift.ACPLaunchReady)
	require.Contains(t, strings.Join(adapterDrift.Notes, " "), "the activated version could not be verified")
}

// TestDoctorReportsARetainedActiveVersionAsLaunchable proves doctor does not contradict
// acpadapter.Load for an adapter whose active version the current manifest no longer declares: the
// retained version still launches, so it must not be reported as not-ready.
func TestDoctorReportsARetainedActiveVersionAsLaunchable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the auth probe fixture is a shell script")
	}
	claudeAdapter := activationManifestFixture(t).Components[0]
	claudeAdapter.ID = "claude-acp"
	claudeAdapter.HarnessID = "claude-cli"
	claudeAdapter.Provider = "anthropic"
	fixture := newActivationFixture(t, claudeAdapter, versionedEntry(claudeAdapter, "2.0.0"))
	_, err := fixture.activate(t, claudeAdapter, "1.0.0", acceptingProbe(nil), nil)
	require.NoError(t, err)
	// The manifest now declares only 2.0.0 while 1.0.0 stays active and owned.
	fixture.declareVersion(t, claudeAdapter, "2.0.0")
	_, declared := manifestEntryFor(fixture.manifest, claudeAdapter.Ref())
	require.False(t, declared)

	probePath := writeProbeScript(t, t.TempDir(), "probe-clean", "#!/bin/sh\nexit 0\n")
	harnesses := []protocol.HarnessProfile{{ID: "claude-cli", Available: true, Binary: probePath}}
	report := RunDoctor(context.Background(), fixture.manifest, fixture.ledger, fixture.dataRoot, fixture.platform,
		LoadActivationState(fixture.dataRoot), harnesses, "", func(context.Context, string) error { return nil })

	entry := doctorEntryFor(report, "claude-acp")
	require.Equal(t, "1.0.0", entry.ActiveVersion)
	require.Equal(t, ComponentProvenanceManaged, entry.Provenance)
	require.True(t, entry.ACPLaunchReady, "a retained active version launches, so doctor must not call it not-ready")
	require.Contains(t, strings.Join(entry.Notes, " "), "retained from an earlier manifest")
}

// TestResolveUndeclaredVersionValidatesAsStrictlyAsTheDeclaredBranch proves the two branches of
// resolveInstalledVersion agree: the branch that reaches its record by component identity checks the
// harness binding and the version install directory explicitly, which the declared branch gets for
// free from resolving the path through ComponentTargetPath.
func TestResolveUndeclaredVersionValidatesAsStrictlyAsTheDeclaredBranch(t *testing.T) {
	adapter := activationManifestFixture(t).Components[0]
	fixture := newActivationFixture(t, adapter, versionedEntry(adapter, "2.0.0"))
	fixture.declareVersion(t, adapter, "2.0.0")
	retained := versionedEntry(adapter, "1.0.0")
	_, declared := manifestEntryFor(fixture.manifest, retained.Ref())
	require.False(t, declared)

	// The undeclared, retained version resolves on its own.
	installed, err := resolveInstalledVersion(fixture.dataRoot, fixture.manifest, fixture.platform, fixture.ledger, retained.Ref())
	require.NoError(t, err)
	require.Equal(t, fixture.targetFor(t, retained), installed.Path)
	require.Equal(t, "1.0.0", installed.Ref().Version)
	require.Equal(t, adapter.HarnessID, installed.Entry.HarnessID)

	original, owned := fixture.ledger.RecordFor(installed.Path)
	require.True(t, owned)

	// A record bound to another harness is refused rather than lending its bytes to this component.
	rebound := original
	rebound.HarnessID = "other-cli"
	_, err = resolveInstalledVersion(fixture.dataRoot, fixture.manifest, fixture.platform,
		fixture.ledger.WithRecord(rebound), retained.Ref())
	require.ErrorContains(t, err, "different harness")

	// A record whose path is outside this version's own install directory is refused, even though it
	// is inside the data root and its digest matches.
	foreign := original
	foreign.Path = filepath.Join(fixture.dataRoot, "adapters", "codex-cli", "codex-acp", "2.0.0", "bin", "codex-acp")
	require.NotEqual(t, original.Path, foreign.Path)
	_, err = resolveInstalledVersion(fixture.dataRoot, fixture.manifest, fixture.platform,
		OwnershipLedger{}.WithRecord(foreign), retained.Ref())
	require.ErrorContains(t, err, "outside its own install directory")

	// Two records claiming one version are ambiguous, never resolved in either's favor.
	duplicate := original
	duplicate.Path = filepath.Join(filepath.Dir(original.Path), "codex-acp-copy")
	_, err = resolveInstalledVersion(fixture.dataRoot, fixture.manifest, fixture.platform,
		fixture.ledger.WithRecord(duplicate), retained.Ref())
	require.ErrorContains(t, err, "more than one file for this component version")

	// A component the manifest does not declare at any version cannot borrow another's metadata.
	_, err = resolveInstalledVersion(fixture.dataRoot, fixture.manifest, fixture.platform, fixture.ledger,
		ComponentRef{Kind: ComponentKindACPAdapter, ID: "unknown-acp", Version: "1.0.0"})
	require.ErrorContains(t, err, "does not declare this component")
}
