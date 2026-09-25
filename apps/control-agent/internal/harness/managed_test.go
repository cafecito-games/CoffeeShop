package harness

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/mcpserver"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

// writeExternalHarness puts an executable named binary on a fresh PATH whose --version prints
// description, which is exactly what external discovery accepts.
func writeExternalHarness(t *testing.T, binary, description string) string {
	t.Helper()
	directory := t.TempDir()
	path := filepath.Join(directory, binary)
	script := "#!/bin/sh\necho '" + description + "'\n"
	require.NoError(t, os.WriteFile(path, []byte(script), 0o755))
	t.Setenv("PATH", directory)
	return path
}

// writeManagedHarness writes a managed harness executable under a data-root-shaped directory.
func writeManagedHarness(t *testing.T, version string) string {
	t.Helper()
	target := filepath.Join(t.TempDir(), "harnesses", "claude-cli", "claude-cli", version, "bin", "claude")
	require.NoError(t, os.MkdirAll(filepath.Dir(target), 0o755))
	require.NoError(t, os.WriteFile(target, []byte("#!/bin/sh\nexit 0\n"), 0o755))
	return target
}

func resolutionFor(resolutions []HarnessResolution, harnessID string) HarnessResolution {
	for _, resolution := range resolutions {
		if resolution.HarnessID == harnessID {
			return resolution
		}
	}
	return HarnessResolution{}
}

// TestDiscoverManagedAndExternalPrecedence proves managed-versus-external precedence is deterministic,
// that both provenances are reported, and that no metadata is merged across them.
func TestDiscoverManagedAndExternalPrecedence(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the external harness fixture is a shell script")
	}

	t.Run("managed wins over external and both are reported", func(t *testing.T) {
		externalPath := writeExternalHarness(t, "claude", "claude-code 1.2.3 (external build)")
		managedPath := writeManagedHarness(t, "9.9.9")
		verifications := 0

		resolutions := Resolve(context.Background(), map[string]ManagedHarness{
			"claude-cli": {Binary: managedPath, Version: "9.9.9", Verify: func() error { verifications++; return nil }},
		})

		claude := resolutionFor(resolutions, "claude-cli")
		require.Equal(t, HarnessProvenanceManaged, claude.Selected)
		require.NotNil(t, claude.Managed)
		require.NotNil(t, claude.External, "the external installation stays reported so the precedence is visible")
		require.Equal(t, managedPath, claude.Managed.Binary)
		require.Equal(t, "9.9.9", claude.Managed.Version)
		require.Equal(t, externalPath, claude.External.Binary)
		require.Equal(t, "1.2.3", claude.External.Version)
		require.Positive(t, verifications)

		// The profile is built from the managed candidate alone: the external build string never
		// describes the managed version, and the managed version never appears on the external
		// candidate.
		require.True(t, claude.Profile.Available)
		require.Equal(t, managedPath, claude.Profile.Binary)
		require.Equal(t, "Managed harness 9.9.9", claude.Profile.Description)
		require.NotContains(t, claude.Profile.Description, "external build")
		require.NotEqual(t, claude.Managed.Version, claude.External.Version)
		// Label, auth mode, and models come from the compiled-in provider table, never a candidate.
		require.Equal(t, "Claude Code", claude.Profile.Label)
		require.Equal(t, "local-subscription", claude.Profile.AuthMode)

		collected := ManagedHarnesses(resolutions)
		require.Len(t, collected, 1)
		require.Equal(t, managedPath, collected["claude-cli"].Binary)
		require.Equal(t, "9.9.9", collected["claude-cli"].Version)
		require.NoError(t, collected["claude-cli"].Verify())
	})

	t.Run("external is used when nothing is activated", func(t *testing.T) {
		externalPath := writeExternalHarness(t, "claude", "claude-code 1.2.3")

		resolutions := Resolve(context.Background(), nil)

		claude := resolutionFor(resolutions, "claude-cli")
		require.Equal(t, HarnessProvenanceExternal, claude.Selected)
		require.Nil(t, claude.Managed)
		require.Equal(t, externalPath, claude.Profile.Binary)
		require.Equal(t, "claude-code 1.2.3", claude.Profile.Description)
		require.Empty(t, ManagedHarnesses(resolutions))
		// Discover is exactly this resolution with no managed candidates, so the PATH-discovered
		// compatibility path is unchanged.
		require.Equal(t, Profiles(resolutions), Discover(context.Background()))
	})

	t.Run("a managed candidate that no longer verifies falls back to external with a reported reason", func(t *testing.T) {
		externalPath := writeExternalHarness(t, "claude", "claude-code 1.2.3")
		managedPath := writeManagedHarness(t, "9.9.9")

		resolutions := Resolve(context.Background(), map[string]ManagedHarness{
			"claude-cli": {Binary: managedPath, Version: "9.9.9", Verify: func() error { return errors.New("content no longer matches") }},
		})

		claude := resolutionFor(resolutions, "claude-cli")
		require.Nil(t, claude.Managed, "a selection whose bytes no longer verify is never a candidate")
		require.NotNil(t, claude.External)
		// An operator-installed harness that worked before managed components existed keeps working,
		// which is the epic's compatibility decision — but the demotion is never silent.
		require.Equal(t, HarnessProvenanceExternal, claude.Selected)
		require.Equal(t, externalPath, claude.Profile.Binary)
		require.Equal(t, ManagedRejectedDrifted, claude.ManagedRejected)
		require.Empty(t, ManagedHarnesses(resolutions), "the drifted executable is never handed to the Runner")
	})

	t.Run("a relative or unverifiable managed entry is never a candidate and says why", func(t *testing.T) {
		t.Setenv("PATH", t.TempDir())
		resolutions := Resolve(context.Background(), map[string]ManagedHarness{
			"claude-cli": {Binary: "claude", Version: "9.9.9", Verify: func() error { return nil }},
			"codex-cli":  {Binary: writeManagedHarness(t, "1.0.0"), Version: "1.0.0"},
		})
		expected := map[string]string{"claude-cli": ManagedRejectedNotAbsolute, "codex-cli": ManagedRejectedUnverifiable}
		for harnessID, reason := range expected {
			resolution := resolutionFor(resolutions, harnessID)
			require.Nil(t, resolution.Managed, harnessID)
			require.Equal(t, HarnessProvenanceAbsent, resolution.Selected, harnessID)
			require.False(t, resolution.Profile.Available, harnessID)
			require.Equal(t, reason, resolution.ManagedRejected, harnessID)
			require.NotContains(t, resolution.ManagedRejected, resolution.HarnessID+"/", harnessID)
		}
	})

	t.Run("a harness with no managed entry reports no rejection", func(t *testing.T) {
		writeExternalHarness(t, "claude", "claude-code 1.2.3")
		for _, resolution := range Resolve(context.Background(), nil) {
			require.Empty(t, resolution.ManagedRejected, resolution.HarnessID,
				"nothing selected is not a rejection")
		}
	})

	t.Run("the provenance vocabulary is closed", func(t *testing.T) {
		for _, provenance := range HarnessProvenances {
			require.True(t, provenance.Valid(), "%s", provenance)
		}
		require.False(t, HarnessProvenance("").Valid())
		require.False(t, HarnessProvenance("path").Valid())
		// An unrecognized provenance resolves to no candidate rather than launching one.
		require.Nil(t, HarnessResolution{Selected: HarnessProvenance("path")}.selectedCandidate())
	})
}

// TestManagedHarnessLaunchRefusesDrift proves a managed harness re-verifies before every launch, the
// way an ACP adapter already does, and that drift refuses the launch before the process starts.
func TestManagedHarnessLaunchRefusesDrift(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the harness fixture is a shell script")
	}
	directory := t.TempDir()
	marker := filepath.Join(directory, "launched")
	binary := filepath.Join(directory, "codex")
	script := "#!/bin/sh\ntouch " + marker + "\necho '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"done\"}}'\n"
	require.NoError(t, os.WriteFile(binary, []byte(script), 0o755))
	profile := protocol.HarnessProfile{ID: "codex-cli", Binary: binary, Available: true, Description: "Managed harness 1.0.0"}
	run := protocol.Run{HarnessID: "codex-cli", Model: "default", Prompt: "fix it"}
	workspace := t.TempDir()

	verifications := 0
	drifted := NewRunner([]protocol.HarnessProfile{profile}).WithManagedHarnesses(map[string]ManagedHarness{
		"codex-cli": {Binary: binary, Version: "1.0.0", Verify: func() error {
			verifications++
			return errors.New("component executable content no longer matches the ownership ledger")
		}},
	})
	_, err := drifted.Run(context.Background(), run, protocol.Agent{}, workspace, mcpserver.Config{}, func(string) {})
	require.ErrorContains(t, err, "managed harness codex-cli failed verification")
	require.ErrorContains(t, err, "no longer matches the ownership ledger")
	require.Equal(t, 1, verifications)
	require.NoFileExists(t, marker, "the refusal happens before the executable is ever started")

	// A managed entry with no verification function is refused rather than trusted.
	unverifiable := NewRunner([]protocol.HarnessProfile{profile}).WithManagedHarnesses(map[string]ManagedHarness{
		"codex-cli": {Binary: binary, Version: "1.0.0"},
	})
	_, err = unverifiable.Run(context.Background(), run, protocol.Agent{}, workspace, mcpserver.Config{}, func(string) {})
	require.ErrorContains(t, err, "has no verification function")
	require.NoFileExists(t, marker)

	// With the selected bytes still verifying, the managed executable is the one that launches, and
	// it is re-verified on every launch rather than once.
	verifications = 0
	healthy := NewRunner([]protocol.HarnessProfile{profile}).WithManagedHarnesses(map[string]ManagedHarness{
		"codex-cli": {Binary: binary, Version: "1.0.0", Verify: func() error { verifications++; return nil }},
	})
	for launch := 1; launch <= 2; launch++ {
		result, err := healthy.Run(context.Background(), run, protocol.Agent{}, workspace, mcpserver.Config{}, func(string) {})
		require.NoError(t, err)
		require.Equal(t, "done", result)
		require.Equal(t, launch, verifications)
	}
	require.FileExists(t, marker)

	// An external harness has no managed entry and nothing for Barista to verify against.
	external := NewRunner([]protocol.HarnessProfile{profile})
	require.NoError(t, external.verifyManagedHarness("codex-cli"))
}

// TestRunnerTracksExecutableUsage proves the in-memory active-run usage a local activation, rollback,
// or prune must find empty, including nesting and release.
func TestRunnerTracksExecutableUsage(t *testing.T) {
	runner := NewRunner(nil)
	require.False(t, runner.ExecutableInUse("/opt/barista/bin/codex"))
	require.False(t, runner.ExecutableInUse(""), "an unresolved executable is never reported as in use")

	releaseFirst := runner.holdExecutable("/opt/barista/bin/codex")
	require.True(t, runner.ExecutableInUse("/opt/barista/bin/codex"))
	releaseSecond := runner.holdExecutable("/opt/barista/bin/codex")
	releaseFirst()
	require.True(t, runner.ExecutableInUse("/opt/barista/bin/codex"), "a second run still holds the executable")
	releaseSecond()
	require.False(t, runner.ExecutableInUse("/opt/barista/bin/codex"))
	// Releasing twice never makes the count negative or resurrects a hold.
	releaseSecond()
	require.False(t, runner.ExecutableInUse("/opt/barista/bin/codex"))
}

// TestNativeLaunchRefusesAnUnresolvedExecutable proves the executable always comes from the resolved
// profile: there is no hardcoded binary name left to fall back to.
func TestNativeLaunchRefusesAnUnresolvedExecutable(t *testing.T) {
	runner := NewRunner([]protocol.HarnessProfile{{ID: "codex-cli", Available: true}})
	_, err := runner.Run(context.Background(), protocol.Run{HarnessID: "codex-cli", Model: "default", Prompt: "fix it"},
		protocol.Agent{}, t.TempDir(), mcpserver.Config{}, func(string) {})
	require.ErrorContains(t, err, "has no resolved executable")
}
