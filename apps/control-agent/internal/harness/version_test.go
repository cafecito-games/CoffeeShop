package harness

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/setup"
)

// realVendorVersionOutputFixtures names, per harness, the checked-in capture of that harness's own
// released CLI printing `--version` on the implementation machine (`@anthropic-ai/claude-code`
// 2.1.231 and `@openai/codex` 0.147.0). The files live beside internal/setup's tests because the
// managed probe is the side that compares them against a manifest pin; they are read from there
// rather than transcribed here so there is exactly one copy of the producer's bytes.
var realVendorVersionOutputFixtures = map[string]string{
	"claude-cli": filepath.Join("..", "setup", "testdata", "claude-cli-version-output.txt"),
	"codex-cli":  filepath.Join("..", "setup", "testdata", "codex-cli-version-output.txt"),
}

// nativeBinaryName is the PATH name each harness's native CLI is discovered under, matching the
// compiled-in provider table.
var nativeBinaryName = map[string]string{"claude-cli": "claude", "codex-cli": "codex"}

// TestHarnessVersionNormalizationIsShared proves there is exactly one answer to "what version did
// this executable report". External PATH discovery and the managed activation probe both normalize
// through protocol.ExtractNormalizedVersion, so for identical output they agree — and the deliberate
// asymmetry in what each side *does* with an unparsable answer is preserved: an unowned external
// binary stays accepted with no version, while a managed candidate whose pinned version cannot be
// confirmed is refused activation.
func TestHarnessVersionNormalizationIsShared(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the harness fixtures are shell scripts")
	}
	for harnessID, fixturePath := range realVendorVersionOutputFixtures {
		t.Run(harnessID, func(t *testing.T) {
			captured, err := os.ReadFile(fixturePath)
			require.NoError(t, err)
			reported := protocol.ExtractNormalizedVersion(string(captured))
			require.NotEmpty(t, reported, "the captured vendor output must carry a parsable version")

			path := writeVersionPrintingExecutable(t, nativeBinaryName[harnessID], string(captured))
			t.Setenv("PATH", filepath.Dir(path))

			// External discovery's own view of the executable.
			external := resolutionFor(Resolve(context.Background(), nil), harnessID)
			require.Equal(t, HarnessProvenanceExternal, external.Selected)
			require.NotNil(t, external.External)
			require.Equal(t, reported, external.External.Version)

			// The managed activation probe's own view of the very same executable. The two agree
			// exactly, because both sides call the one shared normalization.
			require.NoError(t, setup.ProbeHarnessVersion(context.Background(), managedCandidateAt(harnessID, path, reported)))
			require.Error(t, setup.ProbeHarnessVersion(context.Background(), managedCandidateAt(harnessID, path, "9.9.9")),
				"a managed candidate pinned at another version is refused")
		})
	}

	t.Run("an unparsable external binary stays accepted while a managed one is refused", func(t *testing.T) {
		path := writeVersionPrintingExecutable(t, "claude", "Installed\n")
		t.Setenv("PATH", filepath.Dir(path))

		external := resolutionFor(Resolve(context.Background(), nil), "claude-cli")
		require.Equal(t, HarnessProvenanceExternal, external.Selected,
			"an operator-installed harness that reports no parsable version must keep working")
		require.NotNil(t, external.External)
		require.Empty(t, external.External.Version)
		require.True(t, external.Profile.Available)

		require.Error(t, setup.ProbeHarnessVersion(context.Background(), managedCandidateAt("claude-cli", path, "2.1.231")),
			"a managed candidate whose pinned version cannot be confirmed is not a pin")
	})
}

// writeVersionPrintingExecutable writes an executable on its own fresh directory whose --version
// reproduces output byte-for-byte, including its trailing newline. The copying command is resolved
// to an absolute path before the test replaces PATH with the fixture directory, so the fixture does
// not depend on the PATH it is about to invalidate.
func writeVersionPrintingExecutable(t *testing.T, binary string, output string) string {
	t.Helper()
	copier, err := exec.LookPath("cat")
	require.NoError(t, err)
	directory := t.TempDir()
	outputPath := filepath.Join(directory, "version-output.txt")
	require.NoError(t, os.WriteFile(outputPath, []byte(output), 0o600))
	path := filepath.Join(directory, binary)
	script := fmt.Sprintf("#!/bin/sh\n%s %s\n", copier, outputPath)
	require.NoError(t, os.WriteFile(path, []byte(script), 0o755))
	return path
}

// managedCandidateAt is the shape setup's activation probe consumes: a component identity plus the
// absolute executable path VerifyInstalledComponent already resolved. Only those two fields
// participate in the version probe, so the probe can be exercised here without a data root.
func managedCandidateAt(harnessID string, path string, version string) setup.InstalledComponent {
	return setup.InstalledComponent{
		Entry: setup.ComponentManifestEntry{
			ID:        harnessID,
			Kind:      setup.ComponentKindHarness,
			HarnessID: harnessID,
			Version:   version,
		},
		Path: path,
	}
}
