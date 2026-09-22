package readiness

import (
	"context"
	"testing"
	"time"

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
