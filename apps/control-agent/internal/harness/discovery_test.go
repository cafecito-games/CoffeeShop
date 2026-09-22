package harness

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestDiscoverReportsInstalledHarnesses(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test fixtures are shell scripts")
	}
	directory := t.TempDir()
	for _, binary := range []string{"claude", "codex"} {
		path := filepath.Join(directory, binary)
		require.NoError(t, os.WriteFile(path, []byte("#!/bin/sh\necho '"+binary+" test-version'\n"), 0o755))
	}
	t.Setenv("PATH", directory)

	profiles := Discover(context.Background())
	for _, id := range []string{"claude-cli", "codex-cli"} {
		require.Truef(t, Available(profiles, id), "expected %s to be available: %#v", id, profiles)
	}
}

// The transports list is a static property of this Barista build, not of the machine, so the
// assertion must hold for every profile Discover returns regardless of which binaries exist.
func TestDiscoverReportsNativeCLIAsTheOnlyTransport(t *testing.T) {
	profiles := Discover(context.Background())
	require.NotEmpty(t, profiles)
	for _, profile := range profiles {
		require.Equal(t, []string{"native-cli"}, profile.Transports)
	}
}
