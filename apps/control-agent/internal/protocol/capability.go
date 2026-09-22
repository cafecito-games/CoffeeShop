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
