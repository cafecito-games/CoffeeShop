package config

import (
	"strings"
	"testing"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/setup"
	"github.com/stretchr/testify/require"
)

var acpDigest = strings.Repeat("a", 64)

var acpBaseArguments = []string{"--name", "Worker 1", "--id", "worker-1"}

func TestParseDefaultsTheDataRootToTheSetupDefault(t *testing.T) {
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
	t.Setenv("BARISTA_DATA_ROOT", "")

	parsed, err := Parse(acpBaseArguments)
	require.NoError(t, err)
	require.Equal(t, setup.DefaultDataRoot(), parsed.DataRoot)
}

func TestParseRejectsARelativeDataRootFlag(t *testing.T) {
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
	t.Setenv("BARISTA_DATA_ROOT", "")

	_, err := Parse(append(acpBaseArguments, "--data-root", "relative/data-root"))
	require.EqualError(t, err, "data root must be an absolute path")
}

func TestParseHonorsTheDataRootEnvironment(t *testing.T) {
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
	t.Setenv("BARISTA_DATA_ROOT", "/srv/barista-data")

	parsed, err := Parse(acpBaseArguments)
	require.NoError(t, err)
	require.Equal(t, "/srv/barista-data", parsed.DataRoot)
}

func TestParseRejectsARelativeAdapterManifest(t *testing.T) {
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
	t.Setenv("BARISTA_ADAPTER_MANIFEST", "")

	_, err := Parse(append(acpBaseArguments, "--adapter-manifest", "relative/adapters.json"))
	require.EqualError(t, err, "adapter manifest must be an absolute path")
}

func TestParseAcceptsAnAcpAdapterOverride(t *testing.T) {
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
	t.Setenv("BARISTA_ACP_ADAPTERS", "")

	parsed, err := Parse(append(acpBaseArguments,
		"--acp-adapter", "codex-cli=sha256:"+acpDigest+":/opt/codex-acp/bin/codex-acp"))
	require.NoError(t, err)
	require.Equal(t, []ACPAdapterOverride{
		{HarnessID: "codex-cli", SHA256: acpDigest, Path: "/opt/codex-acp/bin/codex-acp"},
	}, parsed.ACPAdapters)
}

func TestParseCleansTheAcpAdapterOverridePath(t *testing.T) {
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
	t.Setenv("BARISTA_ACP_ADAPTERS", "")

	parsed, err := Parse(append(acpBaseArguments,
		"--acp-adapter", "codex-cli=sha256:"+acpDigest+":/opt//x/../y"))
	require.NoError(t, err)
	require.Equal(t, "/opt/y", parsed.ACPAdapters[0].Path)
}

func TestParseReadsAcpAdapterOverridesFromTheEnvironment(t *testing.T) {
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
	t.Setenv("BARISTA_ACP_ADAPTERS", "codex-cli=sha256:"+acpDigest+":/opt/codex-acp,claude-cli=sha256:"+acpDigest+":/opt/claude-acp")

	parsed, err := Parse(acpBaseArguments)
	require.NoError(t, err)
	require.Equal(t, []ACPAdapterOverride{
		{HarnessID: "codex-cli", SHA256: acpDigest, Path: "/opt/codex-acp"},
		{HarnessID: "claude-cli", SHA256: acpDigest, Path: "/opt/claude-acp"},
	}, parsed.ACPAdapters)
}

func TestParseRejectsInvalidAcpAdapterOverrides(t *testing.T) {
	// Every rejection names the entry's position and never the value itself: the value is arbitrary
	// administrator-supplied text and this validation is exactly the screen that decides whether it
	// might be a secret, so it must not be echoed back into a loggable error.
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
	t.Setenv("BARISTA_ACP_ADAPTERS", "")
	tests := []struct {
		name string
		args []string
		env  string
		want string
	}{
		{
			name: "unknown harness",
			args: []string{"--acp-adapter", "codex-acp=sha256:" + acpDigest + ":/opt/codex-acp"},
			want: `acp adapter at index 0 must start with a known harness id followed by "="`,
		},
		{
			name: "missing equals",
			args: []string{"--acp-adapter", "codex-cli"},
			want: `acp adapter at index 0 must start with a known harness id followed by "="`,
		},
		{
			name: "missing sha256 prefix",
			args: []string{"--acp-adapter", "codex-cli=" + acpDigest + ":/opt/codex-acp"},
			want: "acp adapter at index 0 must pin the executable as sha256:<64 lowercase hex>:<path>",
		},
		{
			name: "uppercase digest",
			args: []string{"--acp-adapter", "codex-cli=sha256:" + strings.Repeat("A", 64) + ":/opt/codex-acp"},
			want: "acp adapter at index 0 must pin the executable as sha256:<64 lowercase hex>:<path>",
		},
		{
			name: "short digest",
			args: []string{"--acp-adapter", "codex-cli=sha256:" + strings.Repeat("a", 63) + ":/opt/codex-acp"},
			want: "acp adapter at index 0 must pin the executable as sha256:<64 lowercase hex>:<path>",
		},
		{
			name: "missing path",
			args: []string{"--acp-adapter", "codex-cli=sha256:" + acpDigest},
			want: "acp adapter at index 0 must pin the executable as sha256:<64 lowercase hex>:<path>",
		},
		{
			name: "relative path",
			args: []string{"--acp-adapter", "codex-cli=sha256:" + acpDigest + ":relative/codex-acp"},
			want: "acp adapter at index 0 must name an absolute executable path",
		},
		{
			name: "duplicate harness",
			args: []string{
				"--acp-adapter", "codex-cli=sha256:" + acpDigest + ":/opt/codex-acp",
				"--acp-adapter", "codex-cli=sha256:" + acpDigest + ":/opt/other-codex-acp",
			},
			want: "acp adapter at index 1 repeats a harness that already has an override",
		},
		{
			name: "secret-like path",
			args: []string{"--acp-adapter", "codex-cli=sha256:" + acpDigest + ":/opt/sk-abcdefghijklmnop123456"},
			want: "acp adapter at index 0 looks like it contains a secret and was rejected",
		},
		{
			name: "empty environment segment",
			env:  "codex-cli=sha256:" + acpDigest + ":/opt/codex-acp,",
			want: "acp adapter at index 1 is empty",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if test.env != "" {
				t.Setenv("BARISTA_ACP_ADAPTERS", test.env)
			}
			_, err := Parse(append(acpBaseArguments, test.args...))
			require.Error(t, err)
			require.ErrorContains(t, err, test.want)
			require.Contains(t, err.Error(), "index")
			for _, value := range test.args {
				if strings.HasPrefix(value, "-") {
					continue
				}
				require.NotContains(t, err.Error(), value)
			}
			if test.env != "" {
				require.NotContains(t, err.Error(), test.env)
			}
		})
	}
}

func TestParseDeduplicatesNativeFallbackHarnesses(t *testing.T) {
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
	t.Setenv("BARISTA_ACP_NATIVE_FALLBACK", "")

	parsed, err := Parse(append(acpBaseArguments, "--acp-native-fallback", "codex-cli", "--acp-native-fallback", "codex-cli"))
	require.NoError(t, err)
	require.Equal(t, []string{"codex-cli"}, parsed.ACPNativeFallback)
}

func TestParseReadsNativeFallbackHarnessesFromTheEnvironment(t *testing.T) {
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
	t.Setenv("BARISTA_ACP_NATIVE_FALLBACK", "codex-cli,claude-cli")

	parsed, err := Parse(acpBaseArguments)
	require.NoError(t, err)
	require.Equal(t, []string{"codex-cli", "claude-cli"}, parsed.ACPNativeFallback)
}

func TestParseRejectsAnUnknownNativeFallbackHarness(t *testing.T) {
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
	t.Setenv("BARISTA_ACP_NATIVE_FALLBACK", "")

	_, err := Parse(append(acpBaseArguments, "--acp-native-fallback", "carrier-pigeon"))
	require.EqualError(t, err, "acp native fallback at index 0 is not a known harness id")
	require.NotContains(t, err.Error(), "carrier-pigeon")
}
