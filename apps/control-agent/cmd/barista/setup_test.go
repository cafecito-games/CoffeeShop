package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/setup"
)

// captureOutput swaps os.Stdout and os.Stderr for the duration of fn and returns whatever was
// written to each. The flag sets inside the run functions resolve os.Stderr when they are
// constructed, after the swap, so flag usage output is captured too.
func captureOutput(t *testing.T, fn func() int) (string, string, int) {
	t.Helper()
	originalStdout, originalStderr := os.Stdout, os.Stderr
	stdoutReader, stdoutWriter, err := os.Pipe()
	require.NoError(t, err)
	stderrReader, stderrWriter, err := os.Pipe()
	require.NoError(t, err)
	os.Stdout, os.Stderr = stdoutWriter, stderrWriter
	code := fn()
	os.Stdout, os.Stderr = originalStdout, originalStderr
	require.NoError(t, stdoutWriter.Close())
	require.NoError(t, stderrWriter.Close())
	stdout, err := io.ReadAll(stdoutReader)
	require.NoError(t, err)
	stderr, err := io.ReadAll(stderrReader)
	require.NoError(t, err)
	return string(stdout), string(stderr), code
}

// cliManualManifestFixture writes a one-manual-adapter manifest for this test binary's platform.
func cliManualManifestFixture(t *testing.T) (string, string) {
	t.Helper()
	platform := runtime.GOOS + "-" + runtime.GOARCH
	manifestJSON := fmt.Sprintf(`{
		"manifestVersion": "1",
		"adapters": [
			{
				"id": "manual-acp", "harnessId": "manual-cli", "provider": "manual-vendor",
				"label": "Manual ACP adapter", "version": "0.4.0",
				"platforms": {"%s": {"kind": "manual", "executablePath": "bin/adapter"}},
				"launch": {}
			}
		]
	}`, platform)
	manifestPath := filepath.Join(t.TempDir(), "adapters.json")
	require.NoError(t, os.WriteFile(manifestPath, []byte(manifestJSON), 0o644))
	return platform, manifestPath
}

func TestSetupPlanWritesPlanWithoutTouchingTheDataRoot(t *testing.T) {
	_, manifestPath := cliManualManifestFixture(t)
	dataRoot := filepath.Join(t.TempDir(), "data-root")
	outPath := filepath.Join(t.TempDir(), "plan.json")

	stdout, _, code := captureOutput(t, func() int {
		return runSetup([]string{"plan", "--manifest", manifestPath, "--data-root", dataRoot, "--out", outPath})
	})
	require.Equal(t, 0, code)
	require.Empty(t, stdout)

	planBytes, err := os.ReadFile(outPath)
	require.NoError(t, err)
	var plan setup.Plan
	require.NoError(t, json.Unmarshal(planBytes, &plan))
	require.Equal(t, "manual-acp", plan.Operations[0].AdapterID)
	require.Equal(t, plan.Digest, setup.ComputePlanDigest(plan))

	// Planning is read-only: the data root directory is never created just to observe state.
	_, err = os.Stat(dataRoot)
	require.True(t, os.IsNotExist(err), "setup plan must not create the data root")
}

func TestSetupPlanPrintsPlanJSONToStdout(t *testing.T) {
	_, manifestPath := cliManualManifestFixture(t)
	dataRoot := t.TempDir()

	stdout, _, code := captureOutput(t, func() int {
		return runSetup([]string{"plan", "--manifest", manifestPath, "--data-root", dataRoot})
	})
	require.Equal(t, 0, code)
	var plan setup.Plan
	require.NoError(t, json.Unmarshal([]byte(stdout), &plan))
	require.Equal(t, dataRoot, plan.DataRoot)
}

func TestSetupApplyInstallsManualArtifactEndToEnd(t *testing.T) {
	_, manifestPath := cliManualManifestFixture(t)
	dataRoot := filepath.Join(t.TempDir(), "data-root")
	planPath := filepath.Join(t.TempDir(), "plan.json")

	_, _, code := captureOutput(t, func() int {
		return runSetup([]string{"plan", "--manifest", manifestPath, "--data-root", dataRoot, "--out", planPath})
	})
	require.Equal(t, 0, code)

	artifact := []byte("operator supplied adapter bytes")
	artifactPath := filepath.Join(t.TempDir(), "adapter")
	require.NoError(t, os.WriteFile(artifactPath, artifact, 0o755))
	checksum := sha256.Sum256(artifact)
	checksumHex := hex.EncodeToString(checksum[:])

	stdout, stderr, code := captureOutput(t, func() int {
		return runSetup([]string{
			"apply",
			"--manifest", manifestPath,
			"--data-root", dataRoot,
			"--plan", planPath,
			"--manual-artifact", "manual-acp=" + artifactPath,
			"--manual-checksum", "manual-acp=" + checksumHex,
		})
	})
	require.Equal(t, 0, code, "stderr: %s", stderr)
	require.Contains(t, stdout, "installed: manual-acp@0.4.0")
	require.Contains(t, stdout, "ACP_ADAPTER_MANUAL_CLI=")

	targetPath := filepath.Join(dataRoot, "adapters", "manual-cli", "manual-acp", "0.4.0", "bin", "adapter")
	installed, err := os.ReadFile(targetPath)
	require.NoError(t, err)
	require.Equal(t, artifact, installed)
	information, err := os.Stat(targetPath)
	require.NoError(t, err)
	if runtime.GOOS != "windows" {
		require.Equal(t, os.FileMode(0o755), information.Mode().Perm())
	}
}

func TestSetupApplyWithoutPlanFailsClosedWithoutMutating(t *testing.T) {
	_, manifestPath := cliManualManifestFixture(t)
	dataRoot := filepath.Join(t.TempDir(), "data-root")

	_, stderr, code := captureOutput(t, func() int {
		return runSetup([]string{"apply", "--manifest", manifestPath, "--data-root", dataRoot})
	})
	require.Equal(t, 2, code)
	require.Contains(t, stderr, "apply requires --plan")
	_, err := os.Stat(dataRoot)
	require.True(t, os.IsNotExist(err))
}

func TestSetupRejectsUnknownSubcommand(t *testing.T) {
	_, stderr, code := captureOutput(t, func() int {
		return runSetup([]string{"frobnicate"})
	})
	require.Equal(t, 2, code)
	require.Contains(t, stderr, "valid subcommands are plan and apply")
}

func TestSetupApplyRejectsMalformedManualArtifactBeforeAnyWork(t *testing.T) {
	_, manifestPath := cliManualManifestFixture(t)
	dataRoot := filepath.Join(t.TempDir(), "data-root")
	planPath := filepath.Join(t.TempDir(), "plan.json")
	_, _, code := captureOutput(t, func() int {
		return runSetup([]string{"plan", "--manifest", manifestPath, "--data-root", dataRoot, "--out", planPath})
	})
	require.Equal(t, 0, code)

	_, stderr, code := captureOutput(t, func() int {
		return runSetup([]string{
			"apply",
			"--manifest", manifestPath,
			"--data-root", dataRoot,
			"--plan", planPath,
			"--manual-artifact", "missing-delimiter",
		})
	})
	require.Equal(t, 2, code)
	// The rejection names the flag, never relying on the value to explain itself.
	require.Contains(t, stderr, "--manual-artifact must be NAME=VALUE")
	_, err := os.Stat(dataRoot)
	require.True(t, os.IsNotExist(err))
}

func TestSetupApplyWithoutSubcommandNamesTheValidOnes(t *testing.T) {
	_, stderr, code := captureOutput(t, func() int {
		return runSetup(nil)
	})
	require.Equal(t, 2, code)
	require.Contains(t, stderr, "plan or apply")
}

// TestSetupApplyNeverEchoesRejectedFlagValueToStderr proves the fix-6 property directly: Go's flag
// package wraps a flag.Value.Set error as `invalid value %q for flag -name: ...`, echoing the raw
// argument regardless of what the wrapped error text says. --manual-artifact and --manual-checksum
// are plain repeatedFlag values (Set never errors) validated only after flag.Parse returns, so a
// malformed value that happens to look like a secret must never reach stderr in any form.
func TestSetupApplyNeverEchoesRejectedFlagValueToStderr(t *testing.T) {
	_, manifestPath := cliManualManifestFixture(t)
	dataRoot := filepath.Join(t.TempDir(), "data-root")
	planPath := filepath.Join(t.TempDir(), "plan.json")
	_, _, code := captureOutput(t, func() int {
		return runSetup([]string{"plan", "--manifest", manifestPath, "--data-root", dataRoot, "--out", planPath})
	})
	require.Equal(t, 0, code)

	const secretLikeMalformedValue = "ghp_abcdefghij1234567890"
	_, stderr, code := captureOutput(t, func() int {
		return runSetup([]string{
			"apply",
			"--manifest", manifestPath,
			"--data-root", dataRoot,
			"--plan", planPath,
			"--manual-artifact", secretLikeMalformedValue, // missing the "=" delimiter
		})
	})
	require.Equal(t, 2, code)
	require.NotContains(t, stderr, secretLikeMalformedValue)
	require.Contains(t, stderr, "--manual-artifact must be NAME=VALUE")
	_, err := os.Stat(dataRoot)
	require.True(t, os.IsNotExist(err))
}
