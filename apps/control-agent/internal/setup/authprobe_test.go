package setup

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/require"
)

func writeProbeScript(t *testing.T, directory string, name string, body string) {
	t.Helper()
	path := filepath.Join(directory, name)
	require.NoError(t, os.WriteFile(path, []byte(body), 0o755))
}

func TestRunAuthProbeClassifiesExitStatus(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test fixtures are shell scripts")
	}
	directory := t.TempDir()
	writeProbeScript(t, directory, "probe-clean", "#!/bin/sh\necho 'probe ok'\nexit 0\n")
	writeProbeScript(t, directory, "probe-failure", "#!/bin/sh\necho 'not authenticated'\nexit 1\n")
	t.Setenv("PATH", directory)

	tests := []struct {
		name  string
		probe AuthProbe
		want  AuthReadiness
	}{
		{"exit zero is ready", AuthProbe{Binary: "probe-clean", SuccessExitCode: 0}, AuthReadinessReady},
		{"exit one is not ready", AuthProbe{Binary: "probe-failure", SuccessExitCode: 0}, AuthReadinessNotReady},
		{"matching nonzero success exit code is ready", AuthProbe{Binary: "probe-failure", SuccessExitCode: 1}, AuthReadinessReady},
		{"absent binary is unknown, never not ready", AuthProbe{Binary: "probe-absent", SuccessExitCode: 0}, AuthReadinessUnknown},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			require.Equal(t, test.want, RunAuthProbe(context.Background(), test.probe))
		})
	}
}

func TestRunAuthProbeTimesOutAsUnknown(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test fixtures are shell scripts")
	}
	directory := t.TempDir()
	// sleep is invoked by its absolute path because PATH points at the fixture directory, where
	// there is no sleep binary to find.
	writeProbeScript(t, directory, "probe-sleeper", "#!/bin/sh\nexec /bin/sleep 30\n")
	t.Setenv("PATH", directory)

	require.Equal(t, AuthReadinessUnknown, RunAuthProbe(context.Background(), AuthProbe{Binary: "probe-sleeper", SuccessExitCode: 0}))
}

func TestRunAuthProbeDowngradesSecretLikeOutputToUnknown(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test fixtures are shell scripts")
	}
	// ghp_-prefixed tokens are part of protocol.LooksSecretLike's own denylist fixtures; the probe
	// exits 0, so only the secret screen can change the outcome away from ready.
	directory := t.TempDir()
	writeProbeScript(t, directory, "probe-secret", "#!/bin/sh\necho 'token ghp_abcdefghij1234'\nexit 0\n")
	writeProbeScript(t, directory, "probe-plain", "#!/bin/sh\necho 'logged in as worker'\nexit 0\n")
	t.Setenv("PATH", directory)

	require.Equal(t, AuthReadinessUnknown, RunAuthProbe(context.Background(), AuthProbe{Binary: "probe-secret", SuccessExitCode: 0}))
	// The plain-output twin confirms the downgrade comes from the screen, not from output existing.
	require.Equal(t, AuthReadinessReady, RunAuthProbe(context.Background(), AuthProbe{Binary: "probe-plain", SuccessExitCode: 0}))
}
