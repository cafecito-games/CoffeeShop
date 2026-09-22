package readiness

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

func TestParsersExtractVersionsFromByteFaithfulOutput(t *testing.T) {
	tests := []struct {
		name       string
		parse      func(rawOutput string) (string, bool)
		rawOutput  string
		normalized string
	}{
		{
			name:       "go darwin",
			parse:      parseGoVersion,
			rawOutput:  "go version go1.24.0 darwin/arm64\n",
			normalized: "1.24.0",
		},
		{
			name:       "go linux",
			parse:      parseGoVersion,
			rawOutput:  "go version go1.24.0 linux/amd64\n",
			normalized: "1.24.0",
		},
		{
			name:       "git",
			parse:      GenericVersionParser,
			rawOutput:  "git version 2.43.0\n",
			normalized: "2.43.0",
		},
		{
			name:       "apple git",
			parse:      GenericVersionParser,
			rawOutput:  "git version 2.39.3 (Apple Git-143)\n",
			normalized: "2.39.3",
		},
		{
			name:       "windows git",
			parse:      GenericVersionParser,
			rawOutput:  "git version 2.44.0.windows.1\n",
			normalized: "2.44.0",
		},
		{
			name:       "node",
			parse:      parseNodeVersion,
			rawOutput:  "v20.11.0\n",
			normalized: "20.11.0",
		},
		{
			name:       "node later lts",
			parse:      parseNodeVersion,
			rawOutput:  "v22.14.0\n",
			normalized: "22.14.0",
		},
		{
			name:       "pnpm",
			parse:      GenericVersionParser,
			rawOutput:  "9.1.0\n",
			normalized: "9.1.0",
		},
		{
			name:       "pnpm later major",
			parse:      GenericVersionParser,
			rawOutput:  "10.4.1\n",
			normalized: "10.4.1",
		},
		{
			name:  "gcc ubuntu",
			parse: parseGCCVersion,
			rawOutput: "gcc (Ubuntu 13.2.0-4ubuntu3) 13.2.0\n" +
				"Copyright (C) 2023 Free Software Foundation, Inc.\n" +
				"This is free software; see the source for copying conditions.  There is NO\n" +
				"warranty; not even for MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.\n",
			normalized: "13.2.0",
		},
		{
			name:  "gcc homebrew",
			parse: parseGCCVersion,
			rawOutput: "gcc (Homebrew GCC 13.2.0) 13.2.0\n" +
				"Copyright (C) 2023 Free Software Foundation, Inc.\n",
			normalized: "13.2.0",
		},
		{
			name:  "apple clang",
			parse: parseClangVersion,
			rawOutput: "Apple clang version 15.0.0 (clang-1500.3.9.4)\n" +
				"Target: arm64-apple-darwin23.5.0\n" +
				"Thread model: posix\n" +
				"InstalledDir: /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin\n",
			normalized: "15.0.0",
		},
		{
			name:  "llvm clang",
			parse: parseClangVersion,
			rawOutput: "clang version 17.0.6\n" +
				"Target: x86_64-pc-linux-gnu\n" +
				"Thread model: posix\n",
			normalized: "17.0.6",
		},
		{
			name:       "xcode",
			parse:      parseXcodeVersion,
			rawOutput:  "Xcode 15.4\nBuild version 15F31d\n",
			normalized: "15.4",
		},
		{
			name:       "xcode later",
			parse:      parseXcodeVersion,
			rawOutput:  "Xcode 16.2\nBuild version 16C5032a\n",
			normalized: "16.2",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			normalized, ok := test.parse(test.rawOutput)
			require.True(t, ok)
			require.Equal(t, test.normalized, normalized)
		})
	}
}

func TestParsersRejectUnparseableOutput(t *testing.T) {
	for name, parse := range map[string]func(string) (string, bool){
		"go":      parseGoVersion,
		"node":    parseNodeVersion,
		"gcc":     parseGCCVersion,
		"clang":   parseClangVersion,
		"xcode":   parseXcodeVersion,
		"generic": GenericVersionParser,
	} {
		t.Run(name, func(t *testing.T) {
			normalized, ok := parse("no version here")
			require.False(t, ok)
			require.Empty(t, normalized)
		})
	}
}

func TestParseGCCVersionAcrossRealWorldDistributionShapes(t *testing.T) {
	tests := []struct {
		name       string
		rawOutput  string
		normalized string
		ok         bool
	}{
		{
			name:       "debian ubuntu package suffix before the real version",
			rawOutput:  "gcc (Ubuntu 13.2.0-4ubuntu3) 13.2.0\nCopyright (C) 2023 Free Software Foundation, Inc.\n",
			normalized: "13.2.0",
			ok:         true,
		},
		{
			name:       "homebrew package suffix before the real version",
			rawOutput:  "gcc (Homebrew GCC 13.2.0) 13.2.0\nCopyright (C) 2023 Free Software Foundation, Inc.\n",
			normalized: "13.2.0",
			ok:         true,
		},
		{
			// A naive "last dotted number on the line" parser returns "20" here (the release
			// suffix of "8.5.0-20"), not the actual compiler version "8.5.0" that appears right
			// after "(GCC)". This is the exact regression this parser exists to prevent.
			name:       "red hat with a build date and a trailing vendor release suffix",
			rawOutput:  "gcc (GCC) 8.5.0 20210514 (Red Hat 8.5.0-20)\n",
			normalized: "8.5.0",
			ok:         true,
		},
		{
			name:       "red hat with a build date and no trailing parenthetical",
			rawOutput:  "gcc (GCC) 4.8.5 20150623\n",
			normalized: "4.8.5",
			ok:         true,
		},
		{
			name:       "plain upstream build with a single parenthetical and no suffix",
			rawOutput:  "gcc (GCC) 13.2.0\n",
			normalized: "13.2.0",
			ok:         true,
		},
		{
			name:       "no parenthetical at all falls back to the first version on the line",
			rawOutput:  "gcc 13.2.0\n",
			normalized: "13.2.0",
			ok:         true,
		},
		{
			name:      "a closing paren with no version anywhere after it is unparseable",
			rawOutput: "gcc (GCC)\n",
			ok:        false,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			normalized, ok := parseGCCVersion(test.rawOutput)
			require.Equal(t, test.ok, ok)
			require.Equal(t, test.normalized, normalized)
		})
	}
}

func TestFirstNormalizedVersionNeverTruncatesAMalformedTokenIntoAValidLookingOne(t *testing.T) {
	// An eight-digit build date, if capped at four digits per segment the way the old pattern
	// was, truncates into a fabricated but grammar-valid four-digit "version". The fix must
	// capture the whole token and let the grammar reject it, not accept a shortened prefix.
	normalized, ok := firstNormalizedVersion("build 20210514 complete")
	require.False(t, ok)
	require.Empty(t, normalized)

	// Five dotted segments, similarly, must not be truncated down to the four the grammar allows.
	normalized, ok = firstNormalizedVersion("version 1.2.3.4.5 reported")
	require.False(t, ok)
	require.Empty(t, normalized)

	// A legitimate, in-grammar version at the very start of the text is still found; the fix only
	// changes what happens with a malformed token, not with an already-valid one.
	normalized, ok = firstNormalizedVersion("version 1.24.0 installed")
	require.True(t, ok)
	require.Equal(t, "1.24.0", normalized)
}

func TestBoundedStringTruncatesOnlyAtRuneBoundaries(t *testing.T) {
	// "café" repeated so the multi-byte "é" (2 bytes: 0xC3 0xA9) straddles the byte limit.
	value := strings.Repeat("café ", 20)
	for limit := 1; limit <= len(value); limit++ {
		truncated := boundedString(value, limit)
		require.True(t, utf8.ValidString(truncated), "limit %d produced invalid UTF-8: %q", limit, truncated)
		require.LessOrEqual(t, len(truncated), limit, "limit %d", limit)
	}

	// A limit that lands exactly one byte into a two-byte rune must drop that whole rune rather
	// than keep its first byte.
	multiByte := "ab" + "é" // 'é' is 0xC3 0xA9; landing the cut right after 0xC3 must not keep it.
	require.Equal(t, "ab", boundedString(multiByte, 3))
	require.Equal(t, "abé", boundedString(multiByte, 4))
}

func TestRunProbeReportsMissingBinary(t *testing.T) {
	probe := Probe{
		CapabilityID:   "missing",
		Binary:         "definitely-not-a-real-binary-xyz",
		Args:           []string{"--version"},
		Timeout:        time.Second,
		MaxOutputBytes: probeMaxOutputBytes,
		Parse:          GenericVersionParser,
	}
	evidence := RunProbe(context.Background(), probe)
	require.False(t, evidence.Success)
	require.Contains(t, evidence.Diagnostic, "not found")
	require.Empty(t, evidence.RawValue)
	require.Empty(t, evidence.NormalizedValue)
}

func TestExecuteProbeTimesOut(t *testing.T) {
	// go is guaranteed present in this Go module's CI; the context is already expired at one
	// nanosecond, so the outcome is deterministic regardless of how fast the binary runs.
	execution := executeProbe(context.Background(), "go", []string{"version"}, time.Nanosecond, probeMaxOutputBytes)
	require.True(t, execution.TimedOut)
}

func TestExecuteProbeFlagsOversizedOutput(t *testing.T) {
	execution := executeProbe(context.Background(), "go", []string{"version"}, probeTimeout, 1)
	require.True(t, execution.Oversized)
	require.Len(t, execution.Output, 1)

	probe := Probe{CapabilityID: "go", Binary: "go", Args: []string{"version"}, Timeout: probeTimeout, MaxOutputBytes: 1, Parse: GenericVersionParser}
	evidence := RunProbe(context.Background(), probe)
	require.False(t, evidence.Success)
	require.Empty(t, evidence.NormalizedValue)
}

func TestRunProbeAgainstRealGoAndGitBinaries(t *testing.T) {
	// go and git are both guaranteed present since this is a Go module in a Git repository. The
	// installed versions vary across machines, so assert shape rather than an exact version.
	for _, capabilityID := range []string{"go", "git"} {
		t.Run(capabilityID, func(t *testing.T) {
			var probe Probe
			for _, candidate := range AllowlistedProbes {
				if candidate.CapabilityID == capabilityID {
					probe = candidate
					break
				}
			}
			require.NotEmpty(t, probe.Binary, "probe must exist in AllowlistedProbes")
			evidence := RunProbe(context.Background(), probe)
			require.True(t, evidence.Success)
			require.True(t, protocol.IsNormalizedVersion(evidence.NormalizedValue))
			require.Equal(t, protocol.CapabilityEvidenceSourceProbe, evidence.Source)
			require.Equal(t, probeDefinitionVersion, evidence.ProbeDefinitionVersion)
		})
	}
}

func TestLooksSecretLikeMatchesTokensEmbeddedInFreeFormOutput(t *testing.T) {
	require.True(t, looksSecretLike("build failed: token sk-abcdefghij1234567890 was rejected"))
	require.True(t, looksSecretLike("Authorization: Bearer abcdefghijklmnopqrstuvwxyz"))
	require.True(t, looksSecretLike("-----BEGIN RSA PRIVATE KEY-----\nMIIExyz\n-----END RSA PRIVATE KEY-----"))
	require.False(t, looksSecretLike("go version go1.24.0 darwin/arm64"))
	require.False(t, looksSecretLike("git version 2.43.0"))
}

func TestRunProbeRedactsSecretLikeSuccessfulOutputInsteadOfForwardingIt(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test fixture is a shell script")
	}
	directory := t.TempDir()
	binary := filepath.Join(directory, "fake-tool")
	require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\nprintf 'tool version 1.0.0, token sk-abcdefghij1234567890 embedded\\n'\n"), 0o755))

	probe := Probe{
		CapabilityID: "fake-tool", Binary: binary, Args: nil,
		Timeout: probeTimeout, MaxOutputBytes: probeMaxOutputBytes, Parse: GenericVersionParser,
	}
	evidence := RunProbe(context.Background(), probe)
	require.False(t, evidence.Success, "output containing a secret-like token must never be reported as successful evidence")
	require.Empty(t, evidence.RawValue)
	require.Empty(t, evidence.NormalizedValue)
	require.NotContains(t, evidence.Diagnostic, "sk-abcdefghij1234567890")
	require.Contains(t, evidence.Diagnostic, "secret-like")
}

func TestRunProbeRedactsSecretLikeFailureDiagnostic(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test fixture is a shell script")
	}
	directory := t.TempDir()
	binary := filepath.Join(directory, "fake-tool")
	require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\nprintf 'error: Bearer abcdefghijklmnopqrstuvwxyz rejected\\n' 1>&2\nexit 1\n"), 0o755))

	probe := Probe{
		CapabilityID: "fake-tool", Binary: binary, Args: nil,
		Timeout: probeTimeout, MaxOutputBytes: probeMaxOutputBytes, Parse: GenericVersionParser,
	}
	evidence := RunProbe(context.Background(), probe)
	require.False(t, evidence.Success)
	require.NotContains(t, evidence.Diagnostic, "abcdefghijklmnopqrstuvwxyz")
	require.Contains(t, evidence.Diagnostic, "secret-like")
}
