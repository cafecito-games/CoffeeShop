package config

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
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

func TestWorkspaceRootEnvironmentUsesOnlyCommaAsDelimiter(t *testing.T) {
	t.Setenv("WORKSPACE_ROOTS", "/srv/with:colon,/srv/other")
	require.Equal(t, []string{"/srv/with:colon", "/srv/other"}, splitEnv("WORKSPACE_ROOTS"))
}

func TestWorkspaceRootFlagPreservesCommaInPath(t *testing.T) {
	root := filepath.Join(t.TempDir(), "root,one")
	require.NoError(t, os.Mkdir(root, 0o755))
	t.Setenv("WORKSPACE_ROOTS", "")

	cfg, err := Parse([]string{"--name", "Worker 1", "--id", "worker-1", "--workspace-root", root})
	require.NoError(t, err)
	canonical, err := filepath.EvalSymlinks(root)
	require.NoError(t, err)
	require.Equal(t, []string{canonical}, cfg.WorkspaceRoots)
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

func TestParseReadsCapabilityValuesFromEnvironment(t *testing.T) {
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
	t.Setenv("BARISTA_PROJECT_ALLOWLIST", "coffee-shop,internal-tools")
	t.Setenv("BARISTA_LABELS", "gpu,latency-sensitive")
	t.Setenv("BARISTA_ACCELERATORS", "apple-m3-max,cuda")
	t.Setenv("BARISTA_MEMORY_MEGABYTES", "32768")

	cfg, err := Parse([]string{"--name", "Worker 1", "--id", "worker-1"})
	require.NoError(t, err)
	require.Equal(t, []string{"coffee-shop", "internal-tools"}, cfg.ProjectAllowlist)
	require.Equal(t, []string{"gpu", "latency-sensitive"}, cfg.Labels)
	require.Equal(t, []string{"apple-m3-max", "cuda"}, cfg.Accelerators)
	require.Equal(t, 32768, cfg.MemoryMegabytes)
}

func TestParseAccumulatesRepeatedCapabilityFlags(t *testing.T) {
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
	t.Setenv("BARISTA_PROJECT_ALLOWLIST", "")
	t.Setenv("BARISTA_LABELS", "")
	t.Setenv("BARISTA_ACCELERATORS", "")

	cfg, err := Parse([]string{
		"--name", "Worker 1", "--id", "worker-1",
		"--project", "coffee-shop", "--project", "internal-tools",
		"--label", "gpu", "--label", "latency-sensitive",
		"--accelerator", "cuda",
	})
	require.NoError(t, err)
	require.Equal(t, []string{"coffee-shop", "internal-tools"}, cfg.ProjectAllowlist)
	require.Equal(t, []string{"gpu", "latency-sensitive"}, cfg.Labels)
	require.Equal(t, []string{"cuda"}, cfg.Accelerators)
}

func TestParseRejectsInvalidProjectID(t *testing.T) {
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))

	_, err := Parse([]string{"--name", "Worker 1", "--id", "worker-1", "--project", "Coffee Shop"})
	require.EqualError(t, err, `project id "Coffee Shop" must contain only letters, numbers, and hyphens`)
}

func TestParseDeduplicatesCapabilityValuesPreservingOrder(t *testing.T) {
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))

	cfg, err := Parse([]string{
		"--name", "Worker 1", "--id", "worker-1",
		"--project", "coffee-shop", "--project", "internal-tools", "--project", "coffee-shop",
		"--label", "gpu", "--label", "gpu",
	})
	require.NoError(t, err)
	require.Equal(t, []string{"coffee-shop", "internal-tools"}, cfg.ProjectAllowlist)
	require.Equal(t, []string{"gpu"}, cfg.Labels)
}

func TestParseRejectsOversizedLabelAndAccelerator(t *testing.T) {
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
	oversized := strings.Repeat("x", 129)

	_, err := Parse([]string{"--name", "Worker 1", "--id", "worker-1", "--label", oversized})
	require.EqualError(t, err, fmt.Sprintf("label %q exceeds 128 bytes", oversized))
	_, err = Parse([]string{"--name", "Worker 1", "--id", "worker-1", "--accelerator", oversized})
	require.EqualError(t, err, fmt.Sprintf("accelerator %q exceeds 128 bytes", oversized))
}

func TestParseTreatsExplicitZeroMemoryAsUnset(t *testing.T) {
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
	t.Setenv("BARISTA_MEMORY_MEGABYTES", "0")

	cfg, err := Parse([]string{"--name", "Worker 1", "--id", "worker-1"})
	require.NoError(t, err)
	require.Zero(t, cfg.MemoryMegabytes)
}

func TestParseRejectsNegativeMemory(t *testing.T) {
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
	t.Setenv("BARISTA_MEMORY_MEGABYTES", "-512")

	_, err := Parse([]string{"--name", "Worker 1", "--id", "worker-1"})
	require.EqualError(t, err, `BARISTA_MEMORY_MEGABYTES must be a non-negative integer`)

	t.Setenv("BARISTA_MEMORY_MEGABYTES", "")
	_, err = Parse([]string{"--name", "Worker 1", "--id", "worker-1", "--memory-megabytes", "-1"})
	require.EqualError(t, err, "memory megabytes must not be negative")
}
