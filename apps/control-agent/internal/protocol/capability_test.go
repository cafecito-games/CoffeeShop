package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

const capabilityFixtureDirectory = "../../../../packages/protocol/test/fixtures/project-readiness"

func loadCapabilityFixture(t *testing.T, name string) ([]byte, map[string]json.RawMessage) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(capabilityFixtureDirectory, name+".json"))
	require.NoError(t, err)
	var object map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(data, &object))
	return data, object
}

func TestCapabilityReportFixtureRoundTripsAndValidates(t *testing.T) {
	fixtureBytes, _ := loadCapabilityFixture(t, "capability-report")
	var report NodeCapabilityReport
	require.NoError(t, json.Unmarshal(fixtureBytes, &report))
	require.NoError(t, report.Validate())
	require.Equal(t, "node-one", report.NodeID)
	require.Equal(t, []string{"cafecito-ios"}, report.ProjectAllowlist)
	require.Len(t, report.Evidence, 7)

	encoded, err := json.Marshal(report)
	require.NoError(t, err)
	require.JSONEq(t, string(fixtureBytes), string(encoded))

	envelope := map[string]json.RawMessage{"type": json.RawMessage(`"capability.report"`), "report": json.RawMessage(fixtureBytes)}
	envelopeBytes, err := json.Marshal(envelope)
	require.NoError(t, err)
	var outbound Outbound
	require.NoError(t, json.Unmarshal(envelopeBytes, &outbound))
	require.NotNil(t, outbound.Report)
	require.NoError(t, outbound.Report.Validate())
}

func TestNodeCapabilityEvidenceValidatesItsSourcePairingAndBounds(t *testing.T) {
	observedAt := "2026-09-21T11:59:00Z"
	validCases := map[string]NodeCapabilityEvidence{
		"runtime entry": {
			CapabilityID: "os", Source: CapabilityEvidenceSourceRuntime, Success: true,
			RawValue: "Darwin Kernel Version 25.5.0", NormalizedValue: "macos", ObservedAt: observedAt,
		},
		"configured entry": {
			CapabilityID: "label:ci", Source: CapabilityEvidenceSourceConfigured, Success: true, ObservedAt: observedAt,
		},
		"probe entry": {
			CapabilityID: "toolchain:xcode", Source: CapabilityEvidenceSourceProbe, Success: true,
			NormalizedValue: "16.4", ProbeDefinitionVersion: "1", Diagnostic: "exit status 0", ObservedAt: observedAt,
		},
		"failed probe entry": {
			CapabilityID: "accelerator:cuda", Source: CapabilityEvidenceSourceProbe, Success: false,
			ProbeDefinitionVersion: "1", ObservedAt: observedAt,
		},
	}
	for name, evidence := range validCases {
		t.Run(name, func(t *testing.T) {
			require.NoError(t, evidence.Validate())
		})
	}

	negativeCases := map[string]NodeCapabilityEvidence{
		"probeDefinitionVersion without probe source": {
			CapabilityID: "os", Source: CapabilityEvidenceSourceRuntime, Success: true,
			NormalizedValue: "macos", ProbeDefinitionVersion: "1", ObservedAt: observedAt,
		},
		"probe source without probeDefinitionVersion": {
			CapabilityID: "os", Source: CapabilityEvidenceSourceProbe, Success: true, ObservedAt: observedAt,
		},
		"unknown source": {
			CapabilityID: "os", Source: "guessed", Success: true, ObservedAt: observedAt,
		},
		"malformed capabilityId": {
			CapabilityID: "Operating System!", Source: CapabilityEvidenceSourceRuntime, Success: true, ObservedAt: observedAt,
		},
		"oversize capabilityId": {
			CapabilityID: strings.Repeat("a", capabilityIDBytes+1), Source: CapabilityEvidenceSourceRuntime, Success: true, ObservedAt: observedAt,
		},
		"oversize rawValue": {
			CapabilityID: "os", Source: CapabilityEvidenceSourceRuntime, Success: true,
			RawValue: strings.Repeat("a", rawValueBytes+1), ObservedAt: observedAt,
		},
		"oversize normalizedValue": {
			CapabilityID: "os", Source: CapabilityEvidenceSourceRuntime, Success: true,
			NormalizedValue: strings.Repeat("1", normalizedValueBytes+1), ObservedAt: observedAt,
		},
		"oversize diagnostic": {
			CapabilityID: "os", Source: CapabilityEvidenceSourceRuntime, Success: true,
			Diagnostic: strings.Repeat("a", capabilityDiagnosticBytes+1), ObservedAt: observedAt,
		},
		"non-timestamp observedAt": {
			CapabilityID: "os", Source: CapabilityEvidenceSourceRuntime, Success: true, ObservedAt: "yesterday",
		},
	}
	for name, evidence := range negativeCases {
		t.Run(name, func(t *testing.T) {
			require.Error(t, evidence.Validate())
		})
	}
}

func TestNodeCapabilityReportRejectsDuplicatesAndMalformedAllowlists(t *testing.T) {
	observedAt := "2026-09-21T11:59:00Z"
	entry := NodeCapabilityEvidence{
		CapabilityID: "os", Source: CapabilityEvidenceSourceRuntime, Success: true,
		NormalizedValue: "macos", ObservedAt: observedAt,
	}
	report := func(mutate func(*NodeCapabilityReport)) NodeCapabilityReport {
		base := NodeCapabilityReport{
			NodeID:   "node-one",
			Evidence: []NodeCapabilityEvidence{entry},
			At:       "2026-09-21T12:00:00Z",
		}
		mutate(&base)
		return base
	}

	require.NoError(t, report(func(base *NodeCapabilityReport) {}).Validate())
	require.NoError(t, report(func(base *NodeCapabilityReport) {
		base.Evidence = append(base.Evidence, NodeCapabilityEvidence{
			CapabilityID: "os", Source: CapabilityEvidenceSourceConfigured, Success: true,
			NormalizedValue: "macos", ObservedAt: "2026-09-21T11:58:00Z",
		})
		base.ProjectAllowlist = []string{"cafecito-ios", "cafecito-android"}
	}).Validate())

	negativeCases := map[string]NodeCapabilityReport{
		"missing node identity": report(func(base *NodeCapabilityReport) { base.NodeID = "" }),
		"duplicate capability and source pair": report(func(base *NodeCapabilityReport) {
			base.Evidence = append(base.Evidence, entry)
		}),
		"malformed project allowlist entry": report(func(base *NodeCapabilityReport) {
			base.ProjectAllowlist = []string{"Cafecito"}
		}),
		"duplicate project allowlist entry": report(func(base *NodeCapabilityReport) {
			base.ProjectAllowlist = []string{"cafecito-ios", "cafecito-ios"}
		}),
		"invalid evidence entry": report(func(base *NodeCapabilityReport) {
			base.Evidence = append(base.Evidence, NodeCapabilityEvidence{
				CapabilityID: "os", Source: "nope", Success: true, ObservedAt: observedAt,
			})
		}),
		"evidence beyond the entry limit": report(func(base *NodeCapabilityReport) {
			base.Evidence = make([]NodeCapabilityEvidence, maxCapabilityEvidenceEntries+1)
			for index := range base.Evidence {
				base.Evidence[index] = NodeCapabilityEvidence{
					CapabilityID: "capability-" + strconv.Itoa(index),
					Source:       CapabilityEvidenceSourceRuntime, Success: true, ObservedAt: observedAt,
				}
			}
		}),
		"non-timestamp at": report(func(base *NodeCapabilityReport) { base.At = "soon" }),
	}
	for name, candidate := range negativeCases {
		t.Run(name, func(t *testing.T) {
			require.Error(t, candidate.Validate())
		})
	}
}

func TestVersionGrammarMatchesTheTypeScriptSourceOfTruth(t *testing.T) {
	accepted := []string{"0", "1", "0.2", "1.24.0", "16.4", "2026.9.21", "1.0.0.0"}
	for _, value := range accepted {
		require.True(t, IsNormalizedVersion(value), "%s must be normalized", value)
	}
	rejected := []string{"", "01.2", "1.02", "1.2.3.4.5", "20260921", "1.x.2", "1..2", ".1", "1.", "v1.2", "1-2", strings.Repeat("1", 33), "12345.1"}
	for _, value := range rejected {
		require.False(t, IsNormalizedVersion(value), "%s must not be normalized", value)
	}
}

// TestExtractNormalizedVersionIsTheOneAnswerForReportedVersions covers the single definition of
// "what version did this executable report", which both harness PATH discovery and Barista setup's
// managed activation probe call. An output that carries nothing normalized yields "" rather than a
// guess; whether "" is tolerated or refused is the caller's decision, never this function's.
func TestExtractNormalizedVersionIsTheOneAnswerForReportedVersions(t *testing.T) {
	for _, testCase := range []struct {
		output   string
		expected string
	}{
		// The two captures below are the exact bytes the released Claude Code and Codex CLIs print.
		{output: "2.1.231 (Claude Code)\n", expected: "2.1.231"},
		{output: "codex-cli 0.147.0\n", expected: "0.147.0"},
		{output: "claude 2.1.3 (Claude Code)", expected: "2.1.3"},
		{output: "0.2", expected: "0.2"},
		// Malformed, absent, and prose-only outputs all resolve to "" — never to a partial version.
		{output: "", expected: ""},
		{output: "Installed", expected: ""},
		{output: "version 2", expected: ""},
		{output: "v01.2", expected: ""},
		// The first dotted match is the only candidate: an over-long dotted sequence is dropped whole
		// rather than trimmed into something that would pass.
		{output: "1.2.3.4.5", expected: ""},
		{output: "12345.1", expected: ""},
	} {
		t.Run(testCase.output, func(t *testing.T) {
			extracted := ExtractNormalizedVersion(testCase.output)
			require.Equal(t, testCase.expected, extracted)
			require.True(t, extracted == "" || IsNormalizedVersion(extracted),
				"a non-empty result always satisfies the normalized-version grammar")
		})
	}
}

func TestParseVersionConstraintAcceptsEveryComparatorAndDefaultsToEquality(t *testing.T) {
	expectations := []struct {
		raw        string
		comparator string
		version    string
	}{
		{">=1.24.0", VersionComparatorGreaterOrEqual, "1.24.0"},
		{"<=1.24.0", VersionComparatorLessOrEqual, "1.24.0"},
		{">1.24.0", VersionComparatorGreater, "1.24.0"},
		{"<1.24.0", VersionComparatorLess, "1.24.0"},
		{"=1.24.0", VersionComparatorEqual, "1.24.0"},
		{"1.24.0", VersionComparatorEqual, "1.24.0"},
	}
	for _, expectation := range expectations {
		constraint, err := ParseVersionConstraint(expectation.raw)
		require.NoError(t, err, expectation.raw)
		require.Equal(t, VersionConstraint{Comparator: expectation.comparator, Version: expectation.version}, constraint)
	}
	for _, raw := range []string{"01.2", "", ">=", "<= (empty)", "1.2.3.4.5", "1.x.2", strings.Repeat("x", 41)} {
		_, err := ParseVersionConstraint(raw)
		require.Error(t, err, "%s must be rejected", raw)
	}
}

func TestCompareVersionsPadsTheShorterSegmentList(t *testing.T) {
	expectations := []struct {
		a, b     string
		expected int
	}{
		{"1.24.0", "1.24.0", 0},
		{"1.24.0", "1.30.0", -1},
		{"1.30.0", "1.24.0", 1},
		{"1.2", "1.2.0", 0},
		{"1.2", "1.2.1", -1},
		{"1.2.1", "1.2", 1},
		{"1.10", "1.9", 1},
		{"2.0", "1.9.9", 1},
		{"0.0.1", "0.1", -1},
	}
	for _, expectation := range expectations {
		require.Equal(t, expectation.expected, CompareVersions(expectation.a, expectation.b), "%s vs %s", expectation.a, expectation.b)
	}
}

func TestSatisfiesVersionConstraintInterpretsEveryComparatorAndFailsClosed(t *testing.T) {
	expectations := []struct {
		version    string
		comparator string
		against    string
		expected   bool
	}{
		{"1.24.0", VersionComparatorEqual, "1.24.0", true},
		{"1.24.0", VersionComparatorEqual, "1.23", false},
		{"1.24.0", VersionComparatorGreaterOrEqual, "1.24.0", true},
		{"1.24.0", VersionComparatorGreaterOrEqual, "1.24.1", false},
		{"1.24.0", VersionComparatorGreater, "1.24.0", false},
		{"1.24.1", VersionComparatorGreater, "1.24.0", true},
		{"1.24.0", VersionComparatorLessOrEqual, "1.24.0", true},
		{"1.24.1", VersionComparatorLessOrEqual, "1.24.0", false},
		{"1.24.0", VersionComparatorLess, "1.24.0", false},
		{"1.23", VersionComparatorLess, "1.24.0", true},
		{"1.2", VersionComparatorGreaterOrEqual, "1.2.0", true},
	}
	for _, expectation := range expectations {
		require.Equal(t, expectation.expected,
			SatisfiesVersionConstraint(expectation.version, VersionConstraint{Comparator: expectation.comparator, Version: expectation.against}),
			"%s %s %s", expectation.version, expectation.comparator, expectation.against)
	}
	require.False(t, SatisfiesVersionConstraint("01.2", VersionConstraint{Comparator: VersionComparatorGreaterOrEqual, Version: "1.0"}))
	require.False(t, SatisfiesVersionConstraint("not-a-version", VersionConstraint{Comparator: VersionComparatorEqual, Version: "1.0"}))
	require.False(t, SatisfiesVersionConstraint("1.0", VersionConstraint{Comparator: "~=", Version: "1.0"}))
}

func TestCapabilityVocabulariesMatchTheTypeScriptSourceOfTruth(t *testing.T) {
	require.Equal(t, []string{"runtime", "configured", "probe"}, CapabilityEvidenceSources)
	require.Equal(t, []string{">=", "<=", ">", "<", "="}, VersionComparators)
	require.Regexp(t, `^[a-z0-9]+(-[a-z0-9]+)*(:[a-z0-9]+(-[a-z0-9]+)*)?$`, "toolchain:xcode")
	require.Regexp(t, `^[a-z0-9]+(-[a-z0-9]+)*$`, "cafecito-ios")
}

func TestLooksSecretLikeMatchesTheNarrowDenylist(t *testing.T) {
	for _, flagged := range []string{
		"sk-abcdefghij1234567890",
		"pk_test_1234567890abcdef",
		"ghp_abcdefghij1234",
		"xoxb-1234567890abcdef",
		"AKIAIOSFODNN7EXAMPLE",
		"glpat-abcdefghij1234",
		"Bearer abcdefghijklmnop",
		"-----BEGIN RSA PRIVATE KEY-----",
		"build failed: token sk-abcdefghij1234567890 was rejected",
	} {
		require.True(t, LooksSecretLike(flagged), "%q must be flagged", flagged)
	}
	for _, clean := range []string{
		"go version go1.24.0 darwin/arm64",
		"git version 2.43.0",
		"gpu",
		"cafecito-ios",
	} {
		require.False(t, LooksSecretLike(clean), "%q must not be flagged", clean)
	}
}

func TestLabelOrAcceleratorGrammarAndBoundMirrorTheEvidenceValueLimit(t *testing.T) {
	require.Equal(t, normalizedValueBytes, LabelOrAcceleratorMaximumBytes)
	require.True(t, LabelOrAcceleratorPattern.MatchString("gpu"))
	require.True(t, LabelOrAcceleratorPattern.MatchString("apple-m3-max"))
	require.False(t, LabelOrAcceleratorPattern.MatchString("GPU"))
	require.False(t, LabelOrAcceleratorPattern.MatchString("gpu runner"))
	require.False(t, LabelOrAcceleratorPattern.MatchString("label:ci"), "a label value must not itself contain the capability id's colon suffix")
}
