package setup

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/require"
)

func writeProbeScript(t *testing.T, directory string, name string, body string) string {
	t.Helper()
	path := filepath.Join(directory, name)
	require.NoError(t, os.WriteFile(path, []byte(body), 0o755))
	return path
}

func TestRunAuthProbeClassifiesExitStatus(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test fixtures are shell scripts")
	}
	directory := t.TempDir()
	cleanPath := writeProbeScript(t, directory, "probe-clean", "#!/bin/sh\necho 'probe ok'\nexit 0\n")
	failurePath := writeProbeScript(t, directory, "probe-failure", "#!/bin/sh\necho 'not authenticated'\nexit 1\n")
	absentPath := filepath.Join(directory, "probe-absent")

	tests := []struct {
		name            string
		binaryPath      string
		successExitCode int
		want            AuthReadiness
	}{
		{"exit zero is ready", cleanPath, 0, AuthReadinessReady},
		{"exit one is not ready", failurePath, 0, AuthReadinessNotReady},
		{"matching nonzero success exit code is ready", failurePath, 1, AuthReadinessReady},
		{"absent binary is unknown, never not ready", absentPath, 0, AuthReadinessUnknown},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			require.Equal(t, test.want, RunAuthProbe(context.Background(), test.binaryPath, nil, test.successExitCode))
		})
	}
}

func TestRunAuthProbeRejectsNonAbsoluteBinaryPath(t *testing.T) {
	// RunAuthProbe never performs its own PATH lookup: a relative "binary" name — exactly what a
	// manifest-sourced command would look like — is unknown, not executed.
	require.Equal(t, AuthReadinessUnknown, RunAuthProbe(context.Background(), "claude", nil, 0))
}

func TestRunAuthProbeTimesOutAsUnknown(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test fixtures are shell scripts")
	}
	directory := t.TempDir()
	sleeperPath := writeProbeScript(t, directory, "probe-sleeper", "#!/bin/sh\nexec /bin/sleep 30\n")

	require.Equal(t, AuthReadinessUnknown, RunAuthProbe(context.Background(), sleeperPath, nil, 0))
}

func TestRunAuthProbeDowngradesSecretLikeOutputToUnknown(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test fixtures are shell scripts")
	}
	// ghp_-prefixed tokens are part of protocol.LooksSecretLike's own denylist fixtures; the probe
	// exits 0, so only the secret screen can change the outcome away from ready.
	directory := t.TempDir()
	secretPath := writeProbeScript(t, directory, "probe-secret", "#!/bin/sh\necho 'token ghp_abcdefghij1234'\nexit 0\n")
	plainPath := writeProbeScript(t, directory, "probe-plain", "#!/bin/sh\necho 'logged in as worker'\nexit 0\n")

	require.Equal(t, AuthReadinessUnknown, RunAuthProbe(context.Background(), secretPath, nil, 0))
	// The plain-output twin confirms the downgrade comes from the screen, not from output existing.
	require.Equal(t, AuthReadinessReady, RunAuthProbe(context.Background(), plainPath, nil, 0))
}

// TestAuthProbeAllowlistIsCompiledInOnly documents the fix-2 security property structurally: the
// allowlist a doctor probe can ever run from is a Go source map keyed by harness ID, with no path
// from AdapterManifestEntry (which ParseManifest can build from an operator-supplied --manifest
// file) into it. Manifest.Validate/ParseManifest have no "authProbe" field to parse in the first
// place — see TestParseManifestRejectsUnknownAuthProbeField in manifest_test.go for the
// fail-closed proof that a manifest attempting to supply one is rejected outright.
func TestAuthProbeAllowlistIsCompiledInOnly(t *testing.T) {
	require.Contains(t, AuthProbeAllowlist, "claude-cli")
	require.Contains(t, AuthProbeAllowlist, "codex-cli")
	for harnessID, spec := range AuthProbeAllowlist {
		require.NotEmptyf(t, spec.Arguments, "harness %s", harnessID)
	}
}
