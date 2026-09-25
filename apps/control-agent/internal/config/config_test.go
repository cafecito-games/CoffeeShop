package config

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
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
	// The bound matches protocol.LabelOrAcceleratorMaximumBytes (64), not an independently chosen
	// number: a label/accelerator becomes a NodeCapabilityEvidence.NormalizedValue, and the hub's
	// wire validator rejects the whole report if any entry exceeds that limit. The error names the
	// field and its index only — never the rejected value, which config errors commonly log.
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
	oversized := strings.Repeat("x", 65)

	_, err := Parse([]string{"--name", "Worker 1", "--id", "worker-1", "--label", oversized})
	require.EqualError(t, err, "label at index 0 exceeds 64 bytes")
	require.NotContains(t, err.Error(), oversized)
	_, err = Parse([]string{"--name", "Worker 1", "--id", "worker-1", "--accelerator", oversized})
	require.EqualError(t, err, "accelerator at index 0 exceeds 64 bytes")
	require.NotContains(t, err.Error(), oversized)
}

func TestParseRejectsSecretLikeLabelsAndAccelerators(t *testing.T) {
	// A kebab-case grammar alone does not exclude a lowercase, hyphenated secret shape, so this is
	// a distinct rejection from TestParseRejectsLabelsAndAcceleratorsThatWouldNotFormAValidCapabilityID.
	// The error must never contain the rejected value, since it is by definition a suspected secret.
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
	secret := "sk-abcdefghij1234567890"

	_, err := Parse([]string{"--name", "Worker 1", "--id", "worker-1", "--label", secret})
	require.EqualError(t, err, "label at index 0 looks like it contains a secret and was rejected")
	require.NotContains(t, err.Error(), secret)

	_, err = Parse([]string{"--name", "Worker 1", "--id", "worker-1", "--label", "gpu", "--label", secret})
	require.EqualError(t, err, "label at index 1 looks like it contains a secret and was rejected", "the index reflects position, not just the first offender")

	_, err = Parse([]string{"--name", "Worker 1", "--id", "worker-1", "--accelerator", secret})
	require.EqualError(t, err, "accelerator at index 0 looks like it contains a secret and was rejected")
	require.NotContains(t, err.Error(), secret)
}

func TestParseRejectsLabelsAndAcceleratorsThatWouldNotFormAValidCapabilityID(t *testing.T) {
	// readiness.BuildCapabilityReport embeds every label/accelerator verbatim into a capability id
	// ("label:<label>", "accelerator:<accelerator>"); a value the shared capability id grammar
	// rejects would make the hub reject the whole capability report, not just that entry, so
	// config load must fail closed on it instead. The error names the field and index only.
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))

	_, err := Parse([]string{"--name", "Worker 1", "--id", "worker-1", "--label", "GPU Runner"})
	require.EqualError(t, err, "label at index 0 must contain only lowercase letters, numbers, and hyphens")
	require.NotContains(t, err.Error(), "GPU Runner")

	_, err = Parse([]string{"--name", "Worker 1", "--id", "worker-1", "--accelerator", "Apple_M3_Max"})
	require.EqualError(t, err, "accelerator at index 0 must contain only lowercase letters, numbers, and hyphens")
	require.NotContains(t, err.Error(), "Apple_M3_Max")
}

func TestParseRejectsEmptyInventoryFlagValues(t *testing.T) {
	// An empty or whitespace-only flag value is a configuration mistake, not a silent no-op:
	// scripts that interpolate variables into flags would otherwise enroll nothing where an entry
	// was intended. The error names the field and index only, never the value.
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
	t.Setenv("BARISTA_LABELS", "")
	t.Setenv("BARISTA_ACCELERATORS", "")
	t.Setenv("BARISTA_TOOLCHAINS", "")
	base := []string{"--name", "Worker 1", "--id", "worker-1"}
	tests := []struct {
		name    string
		args    []string
		message string
	}{
		{"empty label", []string{"--label", ""}, "label at index 0 is empty"},
		{"whitespace-only label", []string{"--label", "  "}, "label at index 0 is empty"},
		{"empty accelerator", []string{"--accelerator", ""}, "accelerator at index 0 is empty"},
		{"whitespace-only accelerator", []string{"--accelerator", " "}, "accelerator at index 0 is empty"},
		{"empty toolchain", []string{"--toolchain", ""}, "toolchain at index 0 is empty"},
		{"whitespace-only toolchain", []string{"--toolchain", "  "}, "toolchain at index 0 is empty"},
		{"second flag empty", []string{"--label", "gpu", "--label", ""}, "label at index 1 is empty"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := Parse(append(base, test.args...))
			require.EqualError(t, err, test.message)
		})
	}
}

func TestParseRejectsEmptyInventoryEnvironmentSegments(t *testing.T) {
	// A double comma or trailing comma in a BARISTA_* inventory list is rejected rather than
	// collapsed: silently dropping the segment would hide the same configuration mistake the
	// empty-flag test covers. A wholly empty or unset variable still means "none".
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
	t.Setenv("BARISTA_LABELS", "")
	t.Setenv("BARISTA_ACCELERATORS", "")
	t.Setenv("BARISTA_TOOLCHAINS", "")
	base := []string{"--name", "Worker 1", "--id", "worker-1"}
	tests := []struct {
		name        string
		environment string
		value       string
		message     string
	}{
		{"labels double comma", "BARISTA_LABELS", "gpu,,latency", "label at index 1 is empty"},
		{"labels trailing comma", "BARISTA_LABELS", "gpu,", "label at index 1 is empty"},
		{"labels whitespace segment", "BARISTA_LABELS", "gpu, ,latency", "label at index 1 is empty"},
		{"accelerators double comma", "BARISTA_ACCELERATORS", "cuda,,metal", "accelerator at index 1 is empty"},
		{"accelerators trailing comma", "BARISTA_ACCELERATORS", "cuda,", "accelerator at index 1 is empty"},
		{"toolchains double comma", "BARISTA_TOOLCHAINS", "go,,rust", "toolchain at index 1 is empty"},
		{"toolchains trailing comma", "BARISTA_TOOLCHAINS", "go,", "toolchain at index 1 is empty"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv(test.environment, test.value)
			_, err := Parse(base)
			require.EqualError(t, err, test.message)
		})
	}
}

func TestParseAcceptsToolchainsFromFlagsAndEnvironment(t *testing.T) {
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
	t.Setenv("BARISTA_LABELS", "")
	t.Setenv("BARISTA_ACCELERATORS", "")
	t.Setenv("BARISTA_TOOLCHAINS", "rust@1.80")

	parsed, err := Parse([]string{
		"--name", "Worker 1", "--id", "worker-1",
		"--toolchain", "go",
		"--toolchain", "node@22.9.0",
	})
	require.NoError(t, err)
	require.Equal(t, []Toolchain{
		{ID: "rust", Version: "1.80"},
		{ID: "go"},
		{ID: "node", Version: "22.9.0"},
	}, parsed.Toolchains)
}

func TestParseDeduplicatesToolchainsPreservingOrder(t *testing.T) {
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
	t.Setenv("BARISTA_TOOLCHAINS", "")

	parsed, err := Parse([]string{
		"--name", "Worker 1", "--id", "worker-1",
		"--toolchain", "go", "--toolchain", "rust@1.80", "--toolchain", "go", "--toolchain", "rust@1.80",
	})
	require.NoError(t, err)
	require.Equal(t, []Toolchain{
		{ID: "go"},
		{ID: "rust", Version: "1.80"},
	}, parsed.Toolchains)
}

func TestParseRejectsConflictingToolchainVersions(t *testing.T) {
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
	t.Setenv("BARISTA_TOOLCHAINS", "")
	base := []string{"--name", "Worker 1", "--id", "worker-1"}
	tests := []struct {
		name string
		args []string
	}{
		{"versioned then unversioned", []string{"--toolchain", "go@1.21", "--toolchain", "go"}},
		{"unversioned then versioned", []string{"--toolchain", "go", "--toolchain", "go@1.21"}},
		{"different versions", []string{"--toolchain", "go@1.21", "--toolchain", "go@1.22"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := Parse(append(base, test.args...))
			require.EqualError(t, err, "toolchain at index 1 conflicts with an earlier entry for the same toolchain")
		})
	}
}

func TestParseRejectsInvalidToolchainEntries(t *testing.T) {
	// The error must never contain the rejected value: a toolchain entry is arbitrary
	// operator-supplied text and this validation is the secret screen for it.
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
	t.Setenv("BARISTA_LABELS", "")
	t.Setenv("BARISTA_ACCELERATORS", "")
	t.Setenv("BARISTA_TOOLCHAINS", "")
	base := []string{"--name", "Worker 1", "--id", "worker-1"}
	tests := []struct {
		name    string
		value   string
		message string
	}{
		{"invalid id grammar", "Rust_Tool", "toolchain at index 0 must contain only lowercase letters, numbers, and hyphens"},
		{"oversize id", strings.Repeat("x", 65), "toolchain at index 0 exceeds 64 bytes"},
		{"non-numeric version", "rust@1.x", "toolchain at index 0 has a version that is not a normalized dotted number"},
		{"leading-zero version", "rust@01.2", "toolchain at index 0 has a version that is not a normalized dotted number"},
		{"too many version segments", "rust@1.2.3.4.5", "toolchain at index 0 has a version that is not a normalized dotted number"},
		{"double at", "rust@1.80@1", `toolchain at index 0 must contain at most one "@"`},
		{"trailing at with empty version", "rust@", `toolchain at index 0 has an empty version after "@"`},
		{"secret-like entry", "sk-abcdefghij1234567890", "toolchain at index 0 looks like it contains a secret and was rejected"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := Parse(append(base, "--toolchain", test.value))
			require.EqualError(t, err, test.message)
			require.NotContains(t, err.Error(), test.value)
		})
	}
}

func TestParseRejectsInventoryCountsAboveTheirBounds(t *testing.T) {
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
	t.Setenv("BARISTA_LABELS", "")
	t.Setenv("BARISTA_ACCELERATORS", "")
	t.Setenv("BARISTA_TOOLCHAINS", "")
	tooMany := func(prefix string) []string {
		values := make([]string, MaximumLabels+1)
		for index := range values {
			values[index] = fmt.Sprintf("%s-%02d", prefix, index)
		}
		return values
	}
	tests := []struct {
		name    string
		flag    string
		values  []string
		message string
	}{
		{"labels", "label", tooMany("label"), "at most 32 labels may be configured"},
		{"accelerators", "accelerator", tooMany("accelerator"), "at most 32 accelerators may be configured"},
		{"toolchains", "toolchain", tooMany("toolchain"), "at most 32 toolchains may be configured"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			args := []string{"--name", "Worker 1", "--id", "worker-1"}
			for _, value := range test.values {
				args = append(args, "--"+test.flag, value)
			}
			_, err := Parse(args)
			require.EqualError(t, err, test.message)
		})
	}
}

func TestParseAcceptsInventoryAtExactlyTheBounds(t *testing.T) {
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
	args := []string{"--name", "Worker 1", "--id", "worker-1"}
	for index := range MaximumLabels {
		args = append(args, "--label", fmt.Sprintf("label-%02d", index))
		args = append(args, "--accelerator", fmt.Sprintf("accelerator-%02d", index))
		args = append(args, "--toolchain", fmt.Sprintf("toolchain-%02d", index))
	}

	parsed, err := Parse(args)
	require.NoError(t, err)
	require.Len(t, parsed.Labels, MaximumLabels)
	require.Len(t, parsed.Accelerators, MaximumAccelerators)
	require.Len(t, parsed.Toolchains, MaximumToolchains)
}

func TestParseTreatsExplicitZeroMemoryAsUnset(t *testing.T) {
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
	t.Setenv("BARISTA_MEMORY_MEGABYTES", "0")

	cfg, err := Parse([]string{"--name", "Worker 1", "--id", "worker-1"})
	require.NoError(t, err)
	require.Zero(t, cfg.MemoryMegabytes)
}

func TestAdapterConfigSnippetSaysSetupInstallsAreLoadedAutomatically(t *testing.T) {
	snippet := AdapterConfigSnippet("codex-cli", "/srv/barista/adapters/codex-cli/codex-acp/1.12.0/bin/codex-acp")
	require.Equal(t, "# codex-cli ACP adapter (installed by `barista setup apply`) at /srv/barista/adapters/codex-cli/codex-acp/1.12.0/bin/codex-acp\n"+
		"# Barista loads it at startup from the same --data-root (BARISTA_DATA_ROOT); no other configuration is required.\n", snippet)
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

func TestParseInstanceCapacityDefaultsToConcurrencyAndHonorsExplicitValues(t *testing.T) {
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))

	t.Run("defaults to run concurrency", func(t *testing.T) {
		t.Setenv("BARISTA_CONCURRENCY", "3")
		t.Setenv("BARISTA_INSTANCE_CAPACITY", "")
		parsed, err := Parse([]string{"--name", "Worker 1", "--id", "worker-1"})
		require.NoError(t, err)
		require.Equal(t, 3, parsed.InstanceCapacity)
		require.Equal(t, 3, parsed.Concurrency)
	})

	t.Run("explicit environment zero disables hosting without touching concurrency", func(t *testing.T) {
		t.Setenv("BARISTA_INSTANCE_CAPACITY", "0")
		parsed, err := Parse([]string{"--name", "Worker 1", "--id", "worker-1"})
		require.NoError(t, err)
		require.Zero(t, parsed.InstanceCapacity)
		require.Equal(t, 2, parsed.Concurrency)
	})

	t.Run("the flag overrides the environment", func(t *testing.T) {
		t.Setenv("BARISTA_INSTANCE_CAPACITY", "4")
		parsed, err := Parse([]string{"--name", "Worker 1", "--id", "worker-1", "--instance-capacity", "7"})
		require.NoError(t, err)
		require.Equal(t, 7, parsed.InstanceCapacity)
	})

	t.Run("capacity stays independent of a later concurrency flag", func(t *testing.T) {
		t.Setenv("BARISTA_INSTANCE_CAPACITY", "")
		parsed, err := Parse([]string{"--name", "Worker 1", "--id", "worker-1", "--concurrency", "5"})
		require.NoError(t, err)
		require.Equal(t, 5, parsed.Concurrency)
		require.Equal(t, 2, parsed.InstanceCapacity, "an unset capacity defaults to the environment concurrency, not a later flag")
	})

	t.Run("rejects a negative or non-integer environment value", func(t *testing.T) {
		t.Setenv("BARISTA_INSTANCE_CAPACITY", "-1")
		_, err := Parse([]string{"--name", "Worker 1", "--id", "worker-1"})
		require.EqualError(t, err, `BARISTA_INSTANCE_CAPACITY must be a non-negative integer`)
	})

	t.Run("rejects a capacity above the protocol reconciliation bound", func(t *testing.T) {
		above := strconv.Itoa(protocol.InstanceCollectionEntries + 1)
		_, err := Parse([]string{"--name", "Worker 1", "--id", "worker-1", "--instance-capacity", above})
		require.ErrorContains(t, err, fmt.Sprintf("instance capacity must be between 0 and %d", protocol.InstanceCollectionEntries))
	})

	t.Run("accepts a capacity at the protocol reconciliation bound", func(t *testing.T) {
		atBound := strconv.Itoa(protocol.InstanceCollectionEntries)
		parsed, err := Parse([]string{"--name", "Worker 1", "--id", "worker-1", "--instance-capacity", atBound})
		require.NoError(t, err)
		require.Equal(t, protocol.InstanceCollectionEntries, parsed.InstanceCapacity)
	})

	t.Run("rejects a concurrency above the protocol reconciliation bound", func(t *testing.T) {
		t.Setenv("BARISTA_INSTANCE_CAPACITY", "")
		t.Setenv("BARISTA_CONCURRENCY", strconv.Itoa(protocol.InstanceCollectionEntries+1))
		_, err := Parse([]string{"--name", "Worker 1", "--id", "worker-1"})
		require.ErrorContains(t, err, fmt.Sprintf("concurrency must not exceed %d", protocol.InstanceCollectionEntries))
	})

	t.Run("rejects a capacity defaulted from an over-bound concurrency", func(t *testing.T) {
		t.Setenv("BARISTA_INSTANCE_CAPACITY", "")
		t.Setenv("BARISTA_CONCURRENCY", strconv.Itoa(protocol.InstanceCollectionEntries+1))
		_, err := Parse([]string{"--name", "Worker 1", "--id", "worker-1", "--concurrency", "2"})
		require.ErrorContains(t, err, fmt.Sprintf("instance capacity must be between 0 and %d", protocol.InstanceCollectionEntries))
	})
}
