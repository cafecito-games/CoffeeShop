package protocol

import (
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

const (
	CapabilityEvidenceSourceRuntime    = "runtime"
	CapabilityEvidenceSourceConfigured = "configured"
	CapabilityEvidenceSourceProbe      = "probe"
)

var CapabilityEvidenceSources = []string{CapabilityEvidenceSourceRuntime, CapabilityEvidenceSourceConfigured, CapabilityEvidenceSourceProbe}

// Byte and cardinality bounds for capability evidence, mirroring capabilityEvidenceLimits in the
// protocol source of truth.
const (
	capabilityIDBytes            = 128
	rawValueBytes                = 256
	normalizedValueBytes         = 64
	probeDefinitionVersionBytes  = 64
	capabilityDiagnosticBytes    = 512
	maxCapabilityEvidenceEntries = 256
)

var capabilityIDPattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*(:[a-z0-9]+(-[a-z0-9]+)*)?$`)
var projectIDPattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

// LabelOrAcceleratorMaximumBytes bounds a node-admin configured label or accelerator. It mirrors
// capabilityEvidenceLimits.normalizedValueBytes (and this file's own normalizedValueBytes) in the
// TypeScript source of truth, because readiness.BuildCapabilityReport embeds every label and
// accelerator verbatim into a NodeCapabilityEvidence.NormalizedValue, which that limit bounds.
// This is the single Go-side definition Barista's config validation and any other Go caller must
// reference rather than mirror separately.
const LabelOrAcceleratorMaximumBytes = normalizedValueBytes

// LabelOrAcceleratorPattern is the kebab-case grammar a configured label or accelerator must
// satisfy. It is also embedded as the suffix segment of a capability id
// ("label:<value>"/"accelerator:<value>"), so it must match the same shape capabilityIDPattern
// requires for that segment; this is the single Go-side definition of that grammar.
var LabelOrAcceleratorPattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

/*
 * Secret-like value detection, mirroring the narrow denylist in packages/protocol/src/index.ts
 * (vendor token prefixes, a bearer header, a PEM private key marker). This is unanchored (with
 * word boundaries) rather than a whole-string match, because it also scans free-form text such as
 * probe stdout/stderr, where a token can appear embedded in a longer line rather than as the
 * entire string.
 */
var secretLikeTokenPattern = regexp.MustCompile(`(^|[^A-Za-z0-9_])((sk-[a-z0-9_-]{10,})|(pk_(test|live)_[a-z0-9_-]{10,})|((ghp|gho|ghu|ghs|ghr)_[a-z0-9_-]{10,})|(xox[abp]-[a-z0-9_-]{10,})|(akia[a-z0-9_-]{10,})|(glpat-[a-z0-9_-]{10,}))($|[^A-Za-z0-9_])`)
var bearerHeaderPattern = regexp.MustCompile(`(^|[^A-Za-z0-9_])bearer[ \t\n\f\r]+[^ \t\n\f\r]{10,}`)

func asciiLower(text string) string {
	return strings.Map(func(character rune) rune {
		if character >= 'A' && character <= 'Z' {
			return character + ('a' - 'A')
		}
		return character
	}, text)
}

func LooksSecretLike(text string) bool {
	folded := asciiLower(text)
	return secretLikeTokenPattern.MatchString(folded) ||
		bearerHeaderPattern.MatchString(folded) ||
		(strings.Contains(text, "-----BEGIN") && strings.Contains(text, "PRIVATE KEY"))
}

type NodeCapabilityEvidence struct {
	CapabilityID           string `json:"capabilityId"`
	Source                 string `json:"source"`
	Success                bool   `json:"success"`
	RawValue               string `json:"rawValue,omitempty"`
	NormalizedValue        string `json:"normalizedValue,omitempty"`
	ProbeDefinitionVersion string `json:"probeDefinitionVersion,omitempty"`
	ObservedAt             string `json:"observedAt"`
	Diagnostic             string `json:"diagnostic,omitempty"`
}

type NodeCapabilityReport struct {
	NodeID           string                   `json:"nodeId"`
	ProjectAllowlist []string                 `json:"projectAllowlist,omitempty"`
	Evidence         []NodeCapabilityEvidence `json:"evidence"`
	At               string                   `json:"at"`
}

func (evidence NodeCapabilityEvidence) Validate() error {
	if evidence.CapabilityID == "" || len(evidence.CapabilityID) > capabilityIDBytes || !capabilityIDPattern.MatchString(evidence.CapabilityID) {
		return fmt.Errorf("node capability evidence capabilityId is malformed: %q", evidence.CapabilityID)
	}
	if !slices.Contains(CapabilityEvidenceSources, evidence.Source) {
		return fmt.Errorf("node capability evidence source is missing or unknown: %q", evidence.Source)
	}
	if !isBounded(evidence.RawValue, rawValueBytes) {
		return fmt.Errorf("node capability evidence rawValue exceeds its bound")
	}
	if evidence.NormalizedValue != "" && len(evidence.NormalizedValue) > normalizedValueBytes {
		return fmt.Errorf("node capability evidence normalizedValue is malformed")
	}
	isProbe := evidence.Source == CapabilityEvidenceSourceProbe
	if isProbe && (evidence.ProbeDefinitionVersion == "" || len(evidence.ProbeDefinitionVersion) > probeDefinitionVersionBytes) {
		return fmt.Errorf("probe definition version does not match its source")
	}
	if !isProbe && evidence.ProbeDefinitionVersion != "" {
		return fmt.Errorf("probe definition version does not match its source")
	}
	if !isBounded(evidence.Diagnostic, capabilityDiagnosticBytes) {
		return fmt.Errorf("node capability evidence diagnostic exceeds its bound")
	}
	if !isTimestamp(evidence.ObservedAt) {
		return fmt.Errorf("node capability evidence observedAt is malformed")
	}
	return nil
}

func (report NodeCapabilityReport) Validate() error {
	if !isIdentifier(report.NodeID) {
		return fmt.Errorf("node capability report is missing node identity")
	}
	seenProjects := make(map[string]bool, len(report.ProjectAllowlist))
	for _, projectID := range report.ProjectAllowlist {
		if !projectIDPattern.MatchString(projectID) {
			return fmt.Errorf("node capability report projectAllowlist is malformed: %q", projectID)
		}
		if seenProjects[projectID] {
			return fmt.Errorf("node capability report projectAllowlist contains a duplicate")
		}
		seenProjects[projectID] = true
	}
	if len(report.Evidence) > maxCapabilityEvidenceEntries {
		return fmt.Errorf("node capability report evidence exceeds its bound")
	}
	seenEvidence := make(map[string]bool, len(report.Evidence))
	for _, entry := range report.Evidence {
		if err := entry.Validate(); err != nil {
			return err
		}
		pair := entry.CapabilityID + "\x00" + entry.Source
		if seenEvidence[pair] {
			return fmt.Errorf("node capability report contains duplicate evidence for %s via %s", entry.CapabilityID, entry.Source)
		}
		seenEvidence[pair] = true
	}
	if !isTimestamp(report.At) {
		return fmt.Errorf("node capability report timestamp is malformed")
	}
	return nil
}

const (
	VersionComparatorEqual          = "="
	VersionComparatorGreaterOrEqual = ">="
	VersionComparatorGreater        = ">"
	VersionComparatorLessOrEqual    = "<="
	VersionComparatorLess           = "<"
)

var VersionComparators = []string{VersionComparatorGreaterOrEqual, VersionComparatorLessOrEqual, VersionComparatorGreater, VersionComparatorLess, VersionComparatorEqual}

type VersionConstraint struct {
	Comparator string
	Version    string
}

var normalizedVersionPattern = regexp.MustCompile(`^\d{1,4}(\.\d{1,4}){0,3}$`)

// IsNormalizedVersion mirrors the TypeScript grammar: one to four dotted segments of one to four
// digits, at most 32 bytes, with no leading zero unless the whole segment is zero.
func IsNormalizedVersion(value string) bool {
	if len(value) > 32 || !normalizedVersionPattern.MatchString(value) {
		return false
	}
	for _, segment := range strings.Split(value, ".") {
		if segment != "0" && strings.HasPrefix(segment, "0") {
			return false
		}
	}
	return true
}

// reportedVersionPattern finds the first dotted version number in a tool's self-reported version
// output. It is deliberately the only such pattern in the Go tree: it lives beside
// IsNormalizedVersion because "what version did this executable report" must have exactly one
// answer, whether the executable was found on PATH by harness discovery or installed and activated
// by Barista setup.
var reportedVersionPattern = regexp.MustCompile(`\d+(\.\d+)+`)

// ExtractNormalizedVersion extracts the normalized dotted version a tool reported in its own
// version output, or "" when the output carries none that satisfies IsNormalizedVersion. An
// unparsable output always yields "" — the caller, not this function, decides whether that is
// tolerated (an unowned PATH binary that worked before managed components existed) or refused (a
// managed component whose pinned version could otherwise never be confirmed).
func ExtractNormalizedVersion(output string) string {
	version := reportedVersionPattern.FindString(output)
	if !IsNormalizedVersion(version) {
		return ""
	}
	return version
}

// ParseVersionConstraint checks comparator prefixes longest-first, defaulting to "=" when none
// matches, and rejects an empty or unnormalized version part.
func ParseVersionConstraint(raw string) (VersionConstraint, error) {
	if len(raw) > 40 {
		return VersionConstraint{}, fmt.Errorf("version constraint exceeds its bound: %q", raw)
	}
	for _, comparator := range VersionComparators {
		if strings.HasPrefix(raw, comparator) {
			version := strings.TrimPrefix(raw, comparator)
			if !IsNormalizedVersion(version) {
				return VersionConstraint{}, fmt.Errorf("version constraint has an invalid version: %q", raw)
			}
			return VersionConstraint{Comparator: comparator, Version: version}, nil
		}
	}
	if !IsNormalizedVersion(raw) {
		return VersionConstraint{}, fmt.Errorf("version constraint has an invalid version: %q", raw)
	}
	return VersionConstraint{Comparator: VersionComparatorEqual, Version: raw}, nil
}

// CompareVersions right-pads the shorter dotted-integer sequence with zeros; both arguments must
// already satisfy IsNormalizedVersion.
func CompareVersions(a, b string) int {
	left := strings.Split(a, ".")
	right := strings.Split(b, ".")
	for index := range max(len(left), len(right)) {
		var leftSegment, rightSegment int
		if index < len(left) {
			leftSegment, _ = strconv.Atoi(left[index])
		}
		if index < len(right) {
			rightSegment, _ = strconv.Atoi(right[index])
		}
		if leftSegment != rightSegment {
			if leftSegment < rightSegment {
				return -1
			}
			return 1
		}
	}
	return 0
}

func SatisfiesVersionConstraint(normalizedVersion string, constraint VersionConstraint) bool {
	if !IsNormalizedVersion(normalizedVersion) {
		return false
	}
	compared := CompareVersions(normalizedVersion, constraint.Version)
	switch constraint.Comparator {
	case VersionComparatorEqual:
		return compared == 0
	case VersionComparatorGreaterOrEqual:
		return compared >= 0
	case VersionComparatorGreater:
		return compared > 0
	case VersionComparatorLessOrEqual:
		return compared <= 0
	case VersionComparatorLess:
		return compared < 0
	default:
		return false
	}
}
