package setup

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/harness"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

// The two --version fixtures below are the exact bytes the real vendor executables printed on the
// implementation machine, captured by redirecting each CLI's own output to the file:
//
//	claude --version > testdata/claude-cli-version-output.txt   # @anthropic-ai/claude-code 2.1.231
//	codex  --version > testdata/codex-cli-version-output.txt    # @openai/codex 0.147.0
//
// They are the producer for every version-agreement assertion here: the probe is proven against what
// the vendor binaries actually print, not against a hand-typed approximation of it. Each fixture's
// version is the version the embedded manifest pins for that harness, which is the whole point —
// an agreeing candidate is one whose own output names the pinned version.
const (
	claudeVersionOutputFixturePath = "testdata/claude-cli-version-output.txt"
	codexVersionOutputFixturePath  = "testdata/codex-cli-version-output.txt"
)

// supportedHarnessPlatformKeys is the exact platform set Barista honours, and the same set the
// shipped ACP adapter entries declare. Anything outside it — Windows included — is unsupported by
// omission of the platform key, never by a fallback.
var supportedHarnessPlatformKeys = []string{"darwin-amd64", "darwin-arm64", "linux-amd64", "linux-arm64"}

// shippedHarnessIDs is the set of harnesses this manifest is expected to manage.
var shippedHarnessIDs = []string{"claude-cli", "codex-cli"}

func embeddedManifest_(t *testing.T) Manifest {
	t.Helper()
	manifest, err := LoadDefaultManifest()
	require.NoError(t, err)
	return manifest
}

func harnessEntryFor(t *testing.T, manifest Manifest, id string) ComponentManifestEntry {
	t.Helper()
	for _, entry := range manifest.ComponentsOfKind(ComponentKindHarness) {
		if entry.ID == id {
			return entry
		}
	}
	t.Fatalf("the embedded manifest declares no harness component %q", id)
	return ComponentManifestEntry{}
}

// TestEmbeddedManifestDeclaresHarnessDistributions proves the shipped manifest really does manage
// both harnesses, and that each one is wired to every compiled-in table it needs: a harness with no
// provider-table identity can never be resolved, and one with no version-probe entry can never be
// activated, so an entry missing from either would be dead weight that looks supported.
func TestEmbeddedManifestDeclaresHarnessDistributions(t *testing.T) {
	manifest := embeddedManifest_(t)
	harnesses := manifest.ComponentsOfKind(ComponentKindHarness)
	require.Len(t, harnesses, len(shippedHarnessIDs), "exactly one harness entry per supported harness")

	// Discovery's compiled-in provider table, read through its own public projection so this test
	// cannot drift from the table the daemon actually uses. PATH is emptied first so no real vendor
	// CLI on the implementation machine is executed by a unit test.
	t.Setenv("PATH", t.TempDir())
	providerIDs := []string{}
	for _, profile := range harness.Profiles(harness.Resolve(context.Background(), nil)) {
		providerIDs = append(providerIDs, profile.ID)
	}

	seen := []string{}
	for _, entry := range harnesses {
		seen = append(seen, entry.ID)
		require.Equal(t, entry.ID, entry.HarnessID, "%s: a harness component is its own harness", entry.ID)
		require.Contains(t, shippedHarnessIDs, entry.ID)
		require.Contains(t, providerIDs, entry.HarnessID, "%s has no identity in the compiled-in provider table", entry.ID)
		_, probeable := HarnessVersionProbeAllowlist[entry.HarnessID]
		require.True(t, probeable, "%s has no compiled-in version contract, so it could never be activated", entry.ID)
		require.Empty(t, entry.Launch.Arguments, "%s: native execution builds its own arguments", entry.ID)
		require.Empty(t, entry.Launch.Environment, "%s: native execution builds its own environment", entry.ID)
		require.True(t, protocol.IsNormalizedVersion(entry.Version))
		require.NotEmpty(t, entry.Provider)
	}
	for _, id := range shippedHarnessIDs {
		require.Contains(t, seen, id)
	}
	require.Equal(t, "anthropic", harnessEntryFor(t, manifest, "claude-cli").Provider)
	require.Equal(t, "openai", harnessEntryFor(t, manifest, "codex-cli").Provider)
}

// TestHarnessDistributionPlatformsAreHonestlyClassified proves every declared platform is one
// Barista supports and is classified by the distribution decision procedure without a synthesized
// pin: an archive platform carries a real https URL, a grammar-matching digest, and a positive size;
// a manual platform carries neither URL nor digest; and every omitted platform is documented as
// unsupported rather than silently missing.
func TestHarnessDistributionPlatformsAreHonestlyClassified(t *testing.T) {
	manifest := embeddedManifest_(t)
	readme, err := os.ReadFile(filepath.Join("manifest", "README.md"))
	require.NoError(t, err)
	readmeText := string(readme)

	for _, entry := range manifest.ComponentsOfKind(ComponentKindHarness) {
		require.NotEmpty(t, entry.Platforms, "%s declares no platform at all", entry.ID)
		for platformKey, distribution := range entry.Platforms {
			require.Contains(t, supportedHarnessPlatformKeys, platformKey,
				"%s declares %s, which Barista does not support", entry.ID, platformKey)
			require.True(t, distribution.Kind.Valid())
			switch distribution.Kind {
			case DistributionKindArchive:
				require.True(t, strings.HasPrefix(distribution.URL, "https://"),
					"%s/%s archive url must be https", entry.ID, platformKey)
				require.Regexp(t, ChecksumPattern, distribution.SHA256)
				require.Positive(t, distribution.SizeBytes)
				lowered := strings.ToLower(distribution.URL)
				require.True(t, strings.HasSuffix(lowered, ".tar.gz") || strings.HasSuffix(lowered, ".zip"),
					"%s/%s archive must be a .tar.gz or .zip container", entry.ID, platformKey)
			case DistributionKindManual:
				require.Empty(t, distribution.URL, "%s/%s manual distribution must carry no url", entry.ID, platformKey)
				require.Empty(t, distribution.SHA256, "%s/%s manual distribution must carry no sha256", entry.ID, platformKey)
				require.Zero(t, distribution.SizeBytes, "%s/%s manual distribution pins no size", entry.ID, platformKey)
				// A manual platform is only an honest answer when the README says how to produce its
				// bytes, so the README must name the component and the platform key.
				require.Contains(t, readmeText, entry.ID)
				require.Contains(t, readmeText, platformKey)
			}
		}
		// Every supported key Barista honours is either declared or documented as omitted, so an
		// accidentally dropped platform cannot pass as a deliberate one.
		for _, platformKey := range supportedHarnessPlatformKeys {
			if _, declared := entry.Platforms[platformKey]; !declared {
				require.Contains(t, readmeText, platformKey,
					"%s omits %s, so the README must record the vendor fact that made it unsupported", entry.ID, platformKey)
			}
		}
	}
	// Windows is unsupported by omission of its platform keys, and the README says so rather than
	// leaving an operator to infer it.
	for _, entry := range manifest.ComponentsOfKind(ComponentKindHarness) {
		for _, windowsKey := range []string{"windows-amd64", "windows-arm64"} {
			_, declared := entry.Platforms[windowsKey]
			require.False(t, declared, "%s must not declare %s", entry.ID, windowsKey)
		}
	}
	require.Contains(t, strings.ToLower(readmeText), "windows")
	require.Contains(t, strings.ToLower(readmeText), "unsupported")
}

// TestParseManifestRejectsAHarnessLaunchTemplate proves the one new schema rule: native harness
// execution builds its own arguments and environment, so a harness entry that declared a launch
// template is refused by slice index and field name rather than silently ignored.
func TestParseManifestRejectsAHarnessLaunchTemplate(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		launch string
	}{
		{name: "arguments", launch: `{"arguments":["--dangerously-skip-permissions"]}`},
		{name: "environment", launch: `{"environment":["CLAUDE_CODE_USE_BEDROCK=1"]}`},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			manifestJSON := []byte(`{"manifestVersion":"` + ManifestVersion + `","components":[` +
				`{"id":"claude-cli","kind":"harness","harnessId":"claude-cli","provider":"anthropic",` +
				`"label":"Claude Code CLI","version":"2.1.231",` +
				`"platforms":{"linux-amd64":{"kind":"manual","executablePath":"bin/claude"}},` +
				`"launch":` + testCase.launch + `}]}`)
			_, err := ParseManifest(manifestJSON)
			require.ErrorContains(t, err, "component at index 0")
			require.ErrorContains(t, err, "launch template must be empty")
		})
	}

	// The same template on an ACP adapter stays accepted: an adapter's launch arguments really are
	// consumed, so the rule is harness-specific rather than a blanket ban.
	adapterJSON := []byte(`{"manifestVersion":"` + ManifestVersion + `","components":[` +
		`{"id":"claude-acp","kind":"acp-adapter","harnessId":"claude-cli","provider":"anthropic",` +
		`"label":"Claude ACP adapter","version":"0.79.0",` +
		`"platforms":{"linux-amd64":{"kind":"manual","executablePath":"bin/claude-agent-acp"}},` +
		`"launch":{"arguments":["--stdio"]}}]}`)
	_, err := ParseManifest(adapterJSON)
	require.NoError(t, err)
}

// harnessArchiveServer serves one in-process archive at one path over TLS. No test in this file ever
// reaches a vendor host: the only https origin any of them talks to is this local server.
func harnessArchiveServer(t *testing.T, path string, archive []byte) *httptest.Server {
	t.Helper()
	multiplexer := http.NewServeMux()
	multiplexer.HandleFunc(path, func(writer http.ResponseWriter, _ *http.Request) {
		writer.Write(archive)
	})
	server := httptest.NewTLSServer(multiplexer)
	t.Cleanup(server.Close)
	return server
}

// harnessManifestFixture builds a one-harness manifest for this test binary's own platform. An
// archive-kind harness entry has no real vendor pin to copy — neither vendor publishes a
// checksummed public archive Barista could pin today — so the archive path is proven against a
// locally built archive instead of a fabricated URL and digest.
func harnessManifestFixture(t *testing.T, id string, version string, distributionJSON string) ([]byte, Manifest) {
	t.Helper()
	manifestJSON := []byte(fmt.Sprintf(`{"manifestVersion":%q,"components":[`+
		`{"id":%q,"kind":"harness","harnessId":%q,"provider":"fixture-vendor",`+
		`"label":"Fixture harness","version":%q,`+
		`"platforms":{%q:%s},"launch":{}}]}`,
		ManifestVersion, id, id, version, testPlatform, distributionJSON))
	manifest, err := ParseManifest(manifestJSON)
	require.NoError(t, err)
	return manifestJSON, manifest
}

// TestApplyInstallsHarnessArchiveAndManualFixtures proves both distribution kinds install a harness
// offline, under the harness kind's own directory layout, recorded with the harness component
// identity — and that replaying the same completed apply mutates nothing.
func TestApplyInstallsHarnessArchiveAndManualFixtures(t *testing.T) {
	executable := []byte("#!/bin/sh\necho 'fixture-cli 3.4.5'\n")

	t.Run("archive", func(t *testing.T) {
		archive := buildTarGzipArchive(t, "bin/fixture", executable)
		server := harnessArchiveServer(t, "/harness/fixture.tar.gz", archive)
		manifestBytes, manifest := harnessManifestFixture(t, "fixture-cli", "3.4.5", fmt.Sprintf(
			`{"kind":"archive","url":%q,"sha256":%q,"sizeBytes":%d,"executablePath":"bin/fixture"}`,
			server.URL+"/harness/fixture.tar.gz", sha256Hex(archive), len(archive)))
		dataRoot := t.TempDir()
		plan, _, err := BuildPlan(manifestBytes, manifest, testPlatform, dataRoot, OwnershipLedger{})
		require.NoError(t, err)
		result, err := Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, applyOptions(server))
		require.NoError(t, err)
		require.Len(t, result.Applied, 1)

		wantTarget := filepath.Join(dataRoot, "harnesses", "fixture-cli", "fixture-cli", "3.4.5", "bin", "fixture")
		assertInstalledExecutable(t, wantTarget, executable)
		ledger, err := LoadOwnershipLedger(dataRoot)
		require.NoError(t, err)
		record, owned := ledger.RecordFor(wantTarget)
		require.True(t, owned)
		require.Equal(t, ComponentRef{Kind: ComponentKindHarness, ID: "fixture-cli", Version: "3.4.5"}, record.Component)

		// Exact replay mutates nothing: planning observes the owned match and records it as the
		// operation's expected current state, and apply skips such an operation instead of
		// re-downloading or re-linking anything.
		replayPlan, _, err := BuildPlan(manifestBytes, manifest, testPlatform, dataRoot, ledger)
		require.NoError(t, err)
		require.Len(t, replayPlan.Operations, 1)
		require.Equal(t, ExpectedOwnedMatch, replayPlan.Operations[0].ExpectedCurrentState)
		replayResult, err := Apply(context.Background(), replayPlan, manifestBytes, ledger, dataRoot, applyOptions(server))
		require.NoError(t, err)
		require.Empty(t, replayResult.Applied, "an already-installed harness version installs nothing on replay")
		require.Len(t, replayResult.Skipped, 1)
		replayLedger, err := LoadOwnershipLedger(dataRoot)
		require.NoError(t, err)
		require.Equal(t, ledger.Records, replayLedger.Records, "replay leaves the ownership ledger unchanged")
	})

	t.Run("manual", func(t *testing.T) {
		manifestBytes, manifest := harnessManifestFixture(t, "fixture-cli", "3.4.5",
			`{"kind":"manual","executablePath":"bin/fixture"}`)
		dataRoot := t.TempDir()
		source := filepath.Join(t.TempDir(), "fixture")
		require.NoError(t, os.WriteFile(source, executable, 0o755))
		plan, _, err := BuildPlan(manifestBytes, manifest, testPlatform, dataRoot, OwnershipLedger{})
		require.NoError(t, err)

		// Neither the artifact nor its checksum may be assumed: each missing half refuses the whole
		// operation, naming only the component identity.
		_, err = Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, ApplyOptions{
			ManualArtifactSources: map[string]string{"fixture-cli": source},
		})
		require.ErrorContains(t, err, "requires both a manual artifact source and a manual checksum")
		require.NotContains(t, err.Error(), source, "an operator's source path is never published into a diagnostic")

		result, err := Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, ApplyOptions{
			ManualArtifactSources: map[string]string{"fixture-cli": source},
			ManualChecksums:       map[string]string{"fixture-cli": sha256Hex(executable)},
		})
		require.NoError(t, err)
		require.Len(t, result.Applied, 1)
		wantTarget := filepath.Join(dataRoot, "harnesses", "fixture-cli", "fixture-cli", "3.4.5", "bin", "fixture")
		assertInstalledExecutable(t, wantTarget, executable)
		ledger, err := LoadOwnershipLedger(dataRoot)
		require.NoError(t, err)
		record, owned := ledger.RecordFor(wantTarget)
		require.True(t, owned)
		require.Equal(t, ComponentRef{Kind: ComponentKindHarness, ID: "fixture-cli", Version: "3.4.5"}, record.Component)
	})
}

// TestApplyRejectsHarnessArchiveIntegrityFailures proves a harness archive is held to the same
// integrity bound every component is: a digest mismatch, a size overrun, a redirect outside the
// allowlist, and an archive entry that traverses upward each install nothing and record nothing.
func TestApplyRejectsHarnessArchiveIntegrityFailures(t *testing.T) {
	executable := []byte("#!/bin/sh\necho 'fixture-cli 3.4.5'\n")
	archive := buildTarGzipArchive(t, "bin/fixture", executable)

	assertNothingInstalled := func(t *testing.T, dataRoot string) {
		t.Helper()
		ledger, err := LoadOwnershipLedger(dataRoot)
		require.NoError(t, err)
		require.Empty(t, ledger.Records, "a refused install must leave the ownership ledger empty")
		target := filepath.Join(dataRoot, "harnesses", "fixture-cli", "fixture-cli", "3.4.5", "bin", "fixture")
		_, statErr := os.Lstat(target)
		require.ErrorIs(t, statErr, os.ErrNotExist)
	}

	t.Run("checksum mismatch", func(t *testing.T) {
		server := harnessArchiveServer(t, "/harness/fixture.tar.gz", archive)
		wrongDigest := sha256Hex([]byte("not the archive"))
		manifestBytes, manifest := harnessManifestFixture(t, "fixture-cli", "3.4.5", fmt.Sprintf(
			`{"kind":"archive","url":%q,"sha256":%q,"sizeBytes":%d,"executablePath":"bin/fixture"}`,
			server.URL+"/harness/fixture.tar.gz", wrongDigest, len(archive)))
		dataRoot := t.TempDir()
		plan, _, err := BuildPlan(manifestBytes, manifest, testPlatform, dataRoot, OwnershipLedger{})
		require.NoError(t, err)
		_, err = Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, applyOptions(server))
		require.Error(t, err)
		assertNothingInstalled(t, dataRoot)
	})

	t.Run("size bound exceeded", func(t *testing.T) {
		server := harnessArchiveServer(t, "/harness/fixture.tar.gz", archive)
		manifestBytes, manifest := harnessManifestFixture(t, "fixture-cli", "3.4.5", fmt.Sprintf(
			`{"kind":"archive","url":%q,"sha256":%q,"sizeBytes":%d,"executablePath":"bin/fixture"}`,
			server.URL+"/harness/fixture.tar.gz", sha256Hex(archive), len(archive)-1))
		dataRoot := t.TempDir()
		plan, _, err := BuildPlan(manifestBytes, manifest, testPlatform, dataRoot, OwnershipLedger{})
		require.NoError(t, err)
		_, err = Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, applyOptions(server))
		require.Error(t, err)
		assertNothingInstalled(t, dataRoot)
	})

	t.Run("redirect outside the allowlist", func(t *testing.T) {
		elsewhere := harnessArchiveServer(t, "/harness/fixture.tar.gz", archive)
		multiplexer := http.NewServeMux()
		multiplexer.HandleFunc("/harness/fixture.tar.gz", func(writer http.ResponseWriter, request *http.Request) {
			http.Redirect(writer, request, elsewhere.URL+"/harness/fixture.tar.gz", http.StatusFound)
		})
		redirector := httptest.NewTLSServer(multiplexer)
		t.Cleanup(redirector.Close)
		manifestBytes, manifest := harnessManifestFixture(t, "fixture-cli", "3.4.5", fmt.Sprintf(
			`{"kind":"archive","url":%q,"sha256":%q,"sizeBytes":%d,"executablePath":"bin/fixture"}`,
			redirector.URL+"/harness/fixture.tar.gz", sha256Hex(archive), len(archive)))
		dataRoot := t.TempDir()
		plan, _, err := BuildPlan(manifestBytes, manifest, testPlatform, dataRoot, OwnershipLedger{})
		require.NoError(t, err)
		// An empty allowlist rejects every redirect, which is the default a node administrator gets.
		_, err = Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot,
			ApplyOptions{HTTPClient: redirector.Client()})
		require.Error(t, err)
		assertNothingInstalled(t, dataRoot)
	})

	t.Run("archive entry traverses upward", func(t *testing.T) {
		traversing := buildTarGzipArchive(t, "../escaped", executable)
		server := harnessArchiveServer(t, "/harness/fixture.tar.gz", traversing)
		// The manifest cannot even declare a traversing executablePath, so the refusal is proven at
		// the schema boundary and again at extraction time with a well-formed declaration whose entry
		// is simply absent from the archive.
		_, err := ParseManifest([]byte(fmt.Sprintf(`{"manifestVersion":%q,"components":[`+
			`{"id":"fixture-cli","kind":"harness","harnessId":"fixture-cli","provider":"fixture-vendor",`+
			`"label":"Fixture harness","version":"3.4.5",`+
			`"platforms":{%q:{"kind":"archive","url":"https://example.invalid/x.tar.gz",`+
			`"sha256":%q,"sizeBytes":1,"executablePath":"../escaped"}},"launch":{}}]}`,
			ManifestVersion, testPlatform, sha256Hex(traversing))))
		require.ErrorContains(t, err, "must not traverse upward")

		manifestBytes, manifest := harnessManifestFixture(t, "fixture-cli", "3.4.5", fmt.Sprintf(
			`{"kind":"archive","url":%q,"sha256":%q,"sizeBytes":%d,"executablePath":"bin/fixture"}`,
			server.URL+"/harness/fixture.tar.gz", sha256Hex(traversing), len(traversing)))
		dataRoot := t.TempDir()
		plan, _, err := BuildPlan(manifestBytes, manifest, testPlatform, dataRoot, OwnershipLedger{})
		require.NoError(t, err)
		_, err = Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, applyOptions(server))
		require.Error(t, err)
		assertNothingInstalled(t, dataRoot)
	})

	t.Run("target already occupied", func(t *testing.T) {
		server := harnessArchiveServer(t, "/harness/fixture.tar.gz", archive)
		manifestBytes, manifest := harnessManifestFixture(t, "fixture-cli", "3.4.5", fmt.Sprintf(
			`{"kind":"archive","url":%q,"sha256":%q,"sizeBytes":%d,"executablePath":"bin/fixture"}`,
			server.URL+"/harness/fixture.tar.gz", sha256Hex(archive), len(archive)))
		dataRoot := t.TempDir()
		plan, _, err := BuildPlan(manifestBytes, manifest, testPlatform, dataRoot, OwnershipLedger{})
		require.NoError(t, err)
		target := filepath.Join(dataRoot, "harnesses", "fixture-cli", "fixture-cli", "3.4.5", "bin", "fixture")
		require.NoError(t, os.MkdirAll(filepath.Dir(target), 0o755))
		require.NoError(t, os.WriteFile(target, []byte("someone else's file"), 0o600))
		_, err = Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, applyOptions(server))
		require.Error(t, err, "an occupied target is refused, never replaced")
		content, readErr := os.ReadFile(target)
		require.NoError(t, readErr)
		require.Equal(t, "someone else's file", string(content))
		ledger, err := LoadOwnershipLedger(dataRoot)
		require.NoError(t, err)
		require.Empty(t, ledger.Records)
	})
}

// fixtureVersionScript writes a shell script that reproduces bytes byte-for-byte from outputPath and
// exits with exitCode. outputPath is a file the test controls; for the agreement cases it is the
// checked-in capture of the real vendor CLI's own --version output, so the probe is exercised against
// genuine producer bytes rather than a transcription of them.
func fixtureVersionScript(t *testing.T, outputPath string, exitCode int) []byte {
	t.Helper()
	absolute, err := filepath.Abs(outputPath)
	require.NoError(t, err)
	return []byte(fmt.Sprintf("#!/bin/sh\ncat %q\nexit %d\n", absolute, exitCode))
}

// literalVersionScript writes a script that prints literal bytes, for the outputs no real vendor
// produces (empty, prose-only, secret-like).
func literalVersionScript(t *testing.T, output string) []byte {
	t.Helper()
	path := filepath.Join(t.TempDir(), "output.txt")
	require.NoError(t, os.WriteFile(path, []byte(output), 0o600))
	return fixtureVersionScript(t, path, 0)
}

// newHarnessProbeFixture prepares a data root with one harness entry installed at version, whose
// executable is script, exactly as a successful apply would leave it.
func newHarnessProbeFixture(t *testing.T, entry ComponentManifestEntry, script []byte) *activationFixture {
	t.Helper()
	fixture := &activationFixture{dataRoot: t.TempDir(), manifest: declaredManifest(t, entry), platform: "darwin-arm64"}
	fixture.installScript(t, entry, script)
	return fixture
}

// installScript installs entry at its own declared version with the given executable content.
func (fixture *activationFixture) installScript(t *testing.T, entry ComponentManifestEntry, script []byte) string {
	t.Helper()
	updated, target := installOwnedComponent(t, fixture.dataRoot, fixture.ledger, entry, script)
	fixture.ledger = updated
	require.NoError(t, fixture.ledger.Save(fixture.dataRoot))
	return target
}

// harnessProbeEntry is a harness manifest entry for harnessID at version, on the platform the
// activation fixtures use. The harness ID is a real one so the compiled-in version-probe allowlist
// covers it, which is what makes the probe runnable at all.
func harnessProbeEntry(t *testing.T, harnessID string, provider string, version string) ComponentManifestEntry {
	t.Helper()
	entry := ComponentManifestEntry{
		ID:        harnessID,
		Kind:      ComponentKindHarness,
		HarnessID: harnessID,
		Provider:  provider,
		Label:     "Fixture " + harnessID,
		Version:   version,
		Platforms: map[string]PlatformDistribution{
			"darwin-arm64": {Kind: DistributionKindManual, ExecutablePath: "bin/" + harnessID},
		},
	}
	require.NoError(t, entry.Ref().Validate())
	return entry
}

func activateHarness(t *testing.T, fixture *activationFixture, entry ComponentManifestEntry) (ActivationOutcome, error) {
	t.Helper()
	return Activate(context.Background(), fixture.context(ProbeHarnessVersion, nil),
		ComponentSelector{Kind: ComponentKindHarness, ID: entry.ID, Version: entry.Version})
}

// TestActivateHarnessAcceptsAgreeingVersion proves a managed harness whose own --version output
// names the pinned version activates, is recorded as the active selection, and that the version it
// replaced becomes the retained rollback target. Both agreement cases are driven by the captured
// real vendor output.
func TestActivateHarnessAcceptsAgreeingVersion(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the harness fixture is a shell script")
	}
	manifest := embeddedManifest_(t)
	for _, testCase := range []struct {
		harnessID   string
		provider    string
		fixturePath string
	}{
		{harnessID: "claude-cli", provider: "anthropic", fixturePath: claudeVersionOutputFixturePath},
		{harnessID: "codex-cli", provider: "openai", fixturePath: codexVersionOutputFixturePath},
	} {
		t.Run(testCase.harnessID, func(t *testing.T) {
			// The pinned version comes from the shipped manifest, and the probe output comes from the
			// real vendor binary: the two must already agree, or the shipped pin names a version the
			// vendor build in hand does not report.
			shipped := harnessEntryFor(t, manifest, testCase.harnessID)
			captured := string(readFixture(t, testCase.fixturePath))
			require.Equal(t, shipped.Version, protocol.ExtractNormalizedVersion(captured),
				"the shipped pin for %s must be the version the captured vendor output reports", testCase.harnessID)

			previous := harnessProbeEntry(t, testCase.harnessID, testCase.provider, "1.0.0")
			current := harnessProbeEntry(t, testCase.harnessID, testCase.provider, shipped.Version)
			fixture := newHarnessProbeFixture(t, previous, literalVersionScript(t, "fixture 1.0.0\n"))
			fixture.installScript(t, current, fixtureVersionScript(t, testCase.fixturePath, 0))

			first, err := activateHarness(t, fixture, previous)
			require.NoError(t, err)
			require.True(t, first.Changed)
			require.Equal(t, previous.Ref(), first.Active)
			require.Nil(t, first.Previous)

			fixture.declareVersion(t, current, current.Version)
			second, err := activateHarness(t, fixture, current)
			require.NoError(t, err)
			require.True(t, second.Changed)
			require.Equal(t, current.Ref(), second.Active)
			require.NotNil(t, second.Previous, "the version just replaced is retained as the rollback target")
			require.Equal(t, previous.Ref(), *second.Previous)

			// Re-selecting the same, still-verifying version writes nothing.
			replay, err := activateHarness(t, fixture, current)
			require.NoError(t, err)
			require.False(t, replay.Changed)
		})
	}
}

// TestActivateHarnessRejectsVersionDisagreement proves the gap this issue closes: a candidate that
// starts and exits 0 but reports another version is refused, so a managed harness can never be
// activated under a version it does not report. The activation ledger, the ownership ledger, and
// every installed file are unchanged, so the previously activated version stays active.
func TestActivateHarnessRejectsVersionDisagreement(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the harness fixture is a shell script")
	}
	good := harnessProbeEntry(t, "claude-cli", "anthropic", "1.0.0")
	// The candidate is pinned at 2.1.231 but its executable reports 1.0.0 — the exact confusion an
	// exit-status-only probe could not see.
	disagreeing := harnessProbeEntry(t, "claude-cli", "anthropic", "2.1.231")

	fixture := newHarnessProbeFixture(t, good, literalVersionScript(t, "claude 1.0.0 (Claude Code)\n"))
	disagreeingTarget := fixture.installScript(t, disagreeing, literalVersionScript(t, "claude 1.0.0 (Claude Code)\n"))

	first, err := activateHarness(t, fixture, good)
	require.NoError(t, err)
	require.Equal(t, good.Ref(), first.Active)
	ledgerBefore := activationFileBytes(t, fixture.dataRoot)
	ownershipBefore, err := os.ReadFile(filepath.Join(fixture.dataRoot, "ownership.json"))
	require.NoError(t, err)
	installedBefore, err := os.ReadFile(disagreeingTarget)
	require.NoError(t, err)

	fixture.declareVersion(t, disagreeing, disagreeing.Version)
	_, err = activateHarness(t, fixture, disagreeing)
	require.ErrorContains(t, err, harnessVersionProbeMismatchReason)
	require.NotContains(t, err.Error(), "1.0.0 (Claude Code)", "raw probe output never reaches a diagnostic")

	require.Equal(t, string(ledgerBefore), string(activationFileBytes(t, fixture.dataRoot)),
		"a refused activation leaves the activation ledger byte-identical")
	ownershipAfter, err := os.ReadFile(filepath.Join(fixture.dataRoot, "ownership.json"))
	require.NoError(t, err)
	require.Equal(t, string(ownershipBefore), string(ownershipAfter))
	installedAfter, err := os.ReadFile(disagreeingTarget)
	require.NoError(t, err)
	require.Equal(t, string(installedBefore), string(installedAfter),
		"a refused activation never deletes or rewrites the failed candidate")

	// The prior version is still the active one, and rollback is still available from it.
	active, err := ActiveInstalledComponent(fixture.dataRoot, fixture.manifest, fixture.platform,
		fixture.ledger, LoadActivationState(fixture.dataRoot), good.Ref().Identity())
	require.NoError(t, err)
	require.Equal(t, good.Ref(), active.Ref())
}

// TestActivateHarnessRejectsMalformedAbsentAndUnknownVersionOutput proves every non-agreeing probe
// outcome refuses activation, and that the reasons stay distinguishable: malformed output is never
// reported as "this harness reports no version", and a probe that could not run is never reported as
// an unsuccessful answer.
func TestActivateHarnessRejectsMalformedAbsentAndUnknownVersionOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the harness fixtures are shell scripts")
	}
	for _, testCase := range []struct {
		name   string
		script []byte
		reason string
	}{
		{name: "empty output", script: literalVersionScript(t, ""), reason: harnessVersionProbeMalformedReason},
		{name: "prose only", script: literalVersionScript(t, "Claude Code is installed.\n"), reason: harnessVersionProbeMalformedReason},
		{name: "truncated version", script: literalVersionScript(t, "version 2\n"), reason: harnessVersionProbeMalformedReason},
		{name: "unnormalized version", script: literalVersionScript(t, "version 01.2\n"), reason: harnessVersionProbeMalformedReason},
		{
			name:   "secret-like output",
			script: literalVersionScript(t, "2.1.231 (Claude Code) token=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n"),
			reason: harnessVersionProbeUnknownReason,
		},
		{name: "non-zero exit", script: []byte("#!/bin/sh\necho '2.1.231 (Claude Code)'\nexit 3\n"), reason: harnessVersionProbeUnansweredReason},
		{name: "cannot start", script: []byte("not an executable program at all\n"), reason: harnessVersionProbeUnknownReason},
		// `exec sleep` so the probe's own child *is* the long-running process: a plain `sleep` would
		// leave a grandchild holding the captured pipe open after the timeout killed the shell, which
		// is a separate pre-existing property of the shared child-process reader, not the bound under
		// test here.
		{name: "times out", script: []byte("#!/bin/sh\nexec sleep 30\n"), reason: harnessVersionProbeUnknownReason},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			entry := harnessProbeEntry(t, "claude-cli", "anthropic", "2.1.231")
			fixture := newHarnessProbeFixture(t, entry, testCase.script)
			_, err := activateHarness(t, fixture, entry)
			require.ErrorContains(t, err, testCase.reason)
			// No selection became durable, so nothing is active.
			_, activeErr := ActiveInstalledComponent(fixture.dataRoot, fixture.manifest, fixture.platform,
				fixture.ledger, LoadActivationState(fixture.dataRoot), entry.Ref().Identity())
			require.ErrorIs(t, activeErr, ErrComponentNotActivated)
			// A secret-like or credential-bearing output never reaches the diagnostic.
			require.NotContains(t, err.Error(), "sk-ant-api03")
		})
	}

	// The four reasons are distinct strings, so a consumer can tell the conditions apart rather than
	// collapsing malformed, unanswered, unknown, and mismatched into one verdict.
	reasons := []string{
		harnessVersionProbeUnansweredReason,
		harnessVersionProbeUnknownReason,
		harnessVersionProbeMalformedReason,
		harnessVersionProbeMismatchReason,
	}
	for index, reason := range reasons {
		require.NotEmpty(t, reason)
		require.Equal(t, index, slices.Index(reasons, reason), "probe refusal reasons must be distinct")
	}
}

// TestHarnessUnsupportedPlatformReportsWithoutInstalling proves a platform with no key in a harness
// entry is unsupported rather than installable: verification refuses it, planning emits no
// operation, and doctor still reports the component with the bounded note.
func TestHarnessUnsupportedPlatformReportsWithoutInstalling(t *testing.T) {
	entry := harnessProbeEntry(t, "claude-cli", "anthropic", "2.1.231")
	manifest := declaredManifest(t, entry)
	dataRoot := t.TempDir()
	const unsupported = "linux-s390x"

	_, err := VerifyInstalledComponent(dataRoot, entry, unsupported, OwnershipLedger{})
	require.ErrorIs(t, err, ErrComponentNotInstalled)
	require.ErrorContains(t, err, "no platform distribution for "+unsupported)

	manifestBytes := []byte(`{"manifestVersion":"` + ManifestVersion + `","components":[]}`)
	plan, skipped, err := BuildPlan(manifestBytes, manifest, unsupported, dataRoot, OwnershipLedger{})
	require.NoError(t, err)
	require.Empty(t, plan.Operations, "an unsupported platform plans no operation and no substitute")
	require.Len(t, skipped, 1)

	report := RunDoctor(context.Background(), manifest, OwnershipLedger{}, dataRoot, unsupported,
		LoadActivationState(dataRoot), nil, "", func(context.Context, string) error { return nil })
	doctorEntry := doctorEntryFor(report, entry.ID)
	require.Equal(t, entry.Ref(), doctorEntry.Component)
	require.Contains(t, doctorEntry.Notes, "no platform distribution for "+unsupported)
	require.False(t, doctorEntry.ComponentInstalled)
	require.Empty(t, doctorEntry.ComponentPath)
}

// TestDoctorReportsManagedHarnessProvenanceAndAuth proves doctor's harness reporting: the active and
// retained versions come from the activation record, a managed selection that stops verifying is
// reported as the external fallback the daemon would really take rather than as managed, auth
// readiness is reported separately from installation, and nothing in the report carries a credential
// or raw probe output.
func TestDoctorReportsManagedHarnessProvenanceAndAuth(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the harness fixture is a shell script")
	}
	previous := harnessProbeEntry(t, "claude-cli", "anthropic", "1.0.0")
	current := harnessProbeEntry(t, "claude-cli", "anthropic", "2.1.231")
	fixture := newHarnessProbeFixture(t, previous, literalVersionScript(t, "claude 1.0.0\n"))
	currentTarget := fixture.installScript(t, current, fixtureVersionScript(t, claudeVersionOutputFixturePath, 0))

	_, err := activateHarness(t, fixture, previous)
	require.NoError(t, err)
	fixture.declareVersion(t, current, current.Version)
	_, err = activateHarness(t, fixture, current)
	require.NoError(t, err)

	// An external PATH binary exists, so a managed selection that stops verifying has somewhere to
	// fall back to. Its --version answers the auth probe successfully.
	externalDirectory := t.TempDir()
	externalBinary := filepath.Join(externalDirectory, "claude")
	require.NoError(t, os.WriteFile(externalBinary, literalVersionScript(t, "claude 1.0.0 (Claude Code)\n"), 0o755))
	profiles := []protocol.HarnessProfile{{ID: "claude-cli", Binary: externalBinary, Available: true}}

	ledger, err := LoadOwnershipLedger(fixture.dataRoot)
	require.NoError(t, err)
	report := RunDoctor(context.Background(), fixture.manifest, ledger, fixture.dataRoot, fixture.platform,
		LoadActivationState(fixture.dataRoot), profiles, "", func(context.Context, string) error { return nil })
	entry := doctorEntryFor(report, current.ID)
	require.Equal(t, current.Version, entry.ActiveVersion)
	require.Equal(t, previous.Version, entry.RollbackVersion)
	require.Equal(t, ComponentProvenanceManaged, entry.Provenance)
	require.True(t, entry.ComponentInstalled)
	require.Equal(t, AuthReadinessReady, entry.AuthReadiness, "auth readiness is reported separately from installation")
	require.False(t, entry.ACPLaunchReady, "a harness is never reported as ACP-launch-ready")

	// Drift the activated bytes: the managed selection is no longer honored, and the demotion to the
	// external PATH binary is reported rather than hidden.
	require.NoError(t, os.WriteFile(currentTarget, []byte("#!/bin/sh\nexit 0\n"), 0o755))
	drifted := RunDoctor(context.Background(), fixture.manifest, ledger, fixture.dataRoot, fixture.platform,
		LoadActivationState(fixture.dataRoot), profiles, "", func(context.Context, string) error { return nil })
	driftedEntry := doctorEntryFor(drifted, current.ID)
	require.Equal(t, ComponentProvenanceExternal, driftedEntry.Provenance,
		"a managed selection that stopped verifying reports the external fallback, not managed")
	require.NotEmpty(t, driftedEntry.Notes)
	require.False(t, driftedEntry.ComponentInstalled)

	// An absent harness is reported as unknown auth readiness, never as "not authenticated".
	absent := RunDoctor(context.Background(), fixture.manifest, ledger, fixture.dataRoot, fixture.platform,
		LoadActivationState(fixture.dataRoot), nil, "", func(context.Context, string) error { return nil })
	require.Equal(t, AuthReadinessUnknown, doctorEntryFor(absent, current.ID).AuthReadiness)

	for _, candidate := range []Report{report, drifted, absent} {
		for _, reported := range candidate.Components {
			require.False(t, protocol.LooksSecretLike(strings.Join(reported.Notes, " ")))
			require.NotContains(t, strings.Join(reported.Notes, " "), "Claude Code",
				"raw --version output never reaches doctor's notes")
		}
	}
}

// TestNoRuntimeInstallerInvocation proves Barista never reaches for a package manager or a shell
// bootstrap on any path, and that no test in these packages contacts a vendor host: a manual
// distribution is documented operator work, never something the tool quietly performs itself.
func TestNoRuntimeInstallerInvocation(t *testing.T) {
	installerTokens := []string{"npm", "npx", "brew", "pipx", "sh -c", "bash -c", "curl", "install.sh"}
	vendorHosts := []string{
		"registry.npmjs.org", "api.anthropic.com", "api.openai.com",
		"releases.openai.com", "chatgpt.com", "claude.ai", "code.claude.com", "developers.openai.com",
	}
	// This file is excluded from the scan it defines: the token and host lists above are literally
	// the strings being searched for, so scanning it would only ever find its own checklist.
	const selfName = "harness_distribution_test.go"
	for _, directory := range []string{".", filepath.Join("..", "harness"), filepath.Join("..", "..", "cmd", "barista")} {
		entries, err := os.ReadDir(directory)
		require.NoError(t, err)
		for _, item := range entries {
			if item.IsDir() || !strings.HasSuffix(item.Name(), ".go") || item.Name() == selfName {
				continue
			}
			path := filepath.Join(directory, item.Name())
			source, err := os.ReadFile(path)
			require.NoError(t, err)
			text := string(source)
			if strings.HasSuffix(item.Name(), "_test.go") {
				for _, host := range vendorHosts {
					require.NotContains(t, text, host, "%s must not contact or reference a vendor host", path)
				}
				continue
			}
			for _, token := range installerTokens {
				require.NotContains(t, text, token, "%s must never invoke %q", path, token)
			}
		}
	}
}

// TestHarnessManifestCarriesNoCredentialMaterial proves nothing credential-shaped can ride in on a
// harness entry: every operator- and vendor-supplied string in the shipped manifest is screened, and
// a secret-like value in any screened field is refused before any structural check.
func TestHarnessManifestCarriesNoCredentialMaterial(t *testing.T) {
	manifest := embeddedManifest_(t)
	for _, entry := range manifest.Components {
		require.False(t, protocol.LooksSecretLike(entry.Label), "%s label", entry.ID)
		require.False(t, protocol.LooksSecretLike(entry.AuthDocsURL), "%s authDocsUrl", entry.ID)
		require.False(t, protocol.LooksSecretLike(entry.ID))
		require.False(t, protocol.LooksSecretLike(entry.Version))
		for _, distribution := range entry.Platforms {
			require.False(t, protocol.LooksSecretLike(distribution.URL), "%s url", entry.ID)
			require.False(t, protocol.LooksSecretLike(distribution.ExecutablePath), "%s executablePath", entry.ID)
		}
		// authDocsUrl is documentation only. No Barista path executes it, and it must not be a
		// credential-bearing URL.
		if entry.AuthDocsURL != "" {
			require.True(t, strings.HasPrefix(entry.AuthDocsURL, "https://"), "%s authDocsUrl", entry.ID)
			require.NotContains(t, entry.AuthDocsURL, "?", "%s authDocsUrl carries no query string", entry.ID)
			require.NotContains(t, entry.AuthDocsURL, "@", "%s authDocsUrl carries no userinfo", entry.ID)
		}
	}

	secretBearing := []byte(`{"manifestVersion":"` + ManifestVersion + `","components":[` +
		`{"id":"claude-cli","kind":"harness","harnessId":"claude-cli","provider":"anthropic",` +
		`"label":"Claude Code CLI","version":"2.1.231",` +
		`"platforms":{"linux-amd64":{"kind":"manual","executablePath":"bin/claude"}},"launch":{},` +
		`"authDocsUrl":"https://example.invalid/docs?token=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}]}`)
	_, err := ParseManifest(secretBearing)
	require.ErrorContains(t, err, "authDocsUrl looks secret-like")
	require.NotContains(t, err.Error(), "sk-ant-api03", "the rejection is never an oracle for the pasted value")
}
