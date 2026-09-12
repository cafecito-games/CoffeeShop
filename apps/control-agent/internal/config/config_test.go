package config

import (
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestWebSocketEndpoint(t *testing.T) {
	tests := map[string]string{
		"coffeeshop.example.com":         "wss://coffeeshop.example.com/control-agent",
		"https://coffeeshop.example.com": "wss://coffeeshop.example.com/control-agent",
		"http://localhost:8787":          "ws://localhost:8787/control-agent",
		"wss://example.com/custom":       "wss://example.com/custom",
	}
	for input, expected := range tests {
		t.Run(input, func(t *testing.T) {
			actual, err := WebSocketEndpoint(input)
			require.NoError(t, err)
			require.Equal(t, expected, actual)
		})
	}
}

func TestParseRejectsRelativeConfiguredWorkspaceRoot(t *testing.T) {
	t.Setenv("WORKSPACE_ROOTS", "relative/workspace")
	t.Setenv("CONTROL_ENDPOINT", "http://localhost:8787")

	_, err := Parse([]string{"--name", "Worker 1", "--id", "worker-1"})
	require.EqualError(t, err, `workspace root "relative/workspace" must be an absolute path`)
}

func TestParseRejectsRelativeWorkspaceRootFlag(t *testing.T) {
	t.Setenv("WORKSPACE_ROOTS", "")

	_, err := Parse([]string{"--name", "Worker 1", "--id", "worker-1", "--workspace-root", "relative/workspace"})
	require.EqualError(t, err, `workspace root "relative/workspace" must be an absolute path`)
}

func TestParseRejectsInvalidConfiguredConcurrency(t *testing.T) {
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
	t.Setenv("BARISTA_CONCURRENCY", "many")

	_, err := Parse([]string{"--name", "Worker 1", "--id", "worker-1"})
	require.EqualError(t, err, `BARISTA_CONCURRENCY must be a positive integer`)
}

func TestParseAcceptsEverySupportedKindFromEnvironment(t *testing.T) {
	for _, kind := range []string{"local", "home-server", "cloud"} {
		t.Run(kind, func(t *testing.T) {
			t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
			t.Setenv("BARISTA_KIND", kind)
			cfg, err := Parse([]string{"--name", "Worker 1", "--id", "worker-1"})
			require.NoError(t, err)
			require.Equal(t, kind, cfg.Kind)
		})
	}
}

func TestParseRejectsInvalidIdentityEndpointKindAndConcurrency(t *testing.T) {
	root := absoluteExistingRoot(t)
	tests := []struct {
		name    string
		args    []string
		message string
	}{
		{"endpoint", []string{"--control-endpoint", "ftp://coffee.example", "--name", "Worker", "--id", "worker", "--workspace-root", root}, "control endpoint must use"},
		{"name", []string{"--name", " ", "--id", "worker", "--workspace-root", root}, "name must not be empty"},
		{"id", []string{"--name", "Worker", "--id", "Bad ID", "--workspace-root", root}, "id must contain only"},
		{"kind", []string{"--name", "Worker", "--id", "worker", "--kind", "edge", "--workspace-root", root}, "kind must be local"},
		{"concurrency", []string{"--name", "Worker", "--id", "worker", "--concurrency", "0", "--workspace-root", root}, "concurrency must be at least one"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := Parse(test.args)
			require.ErrorContains(t, err, test.message)
		})
	}
}

func absoluteExistingRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if runtime.GOOS == "windows" {
		return filepath.Clean(root)
	}
	return root
}

func TestParseUsesWorkingDirectoryAsTheDefaultRoot(t *testing.T) {
	t.Setenv("WORKSPACE_ROOTS", "")
	t.Setenv("CONTROL_ENDPOINT", "http://localhost:8787")
	cfg, err := Parse([]string{"--name", "Worker 1", "--id", "worker-1"})
	require.NoError(t, err)
	require.Len(t, cfg.WorkspaceRoots, 1)
	want, err := filepath.EvalSymlinks(".")
	require.NoError(t, err)
	want, err = filepath.Abs(want)
	require.NoError(t, err)
	require.Equal(t, want, cfg.WorkspaceRoots[0])
}
