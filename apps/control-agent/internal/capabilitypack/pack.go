// Package capabilitypack owns the canonical Coffee Shop capability pack format: the pack manifest
// grammar, the tree and content rules every pack must satisfy, the deterministic archive the
// managed-component lifecycle installs, and the validation Barista's activation probe re-runs on
// the installed bytes.
//
// There is exactly one validator. The bytes the packer accepts before it writes an archive are the
// bytes the activation probe re-validates after installation, through this same package, so a pack
// that builds is a pack that can activate and a pack that stopped validating never becomes active.
// Nothing here executes the pack, reads a credential, or resolves a network endpoint: a capability
// pack is workflow prose, and the run-scoped Coffee Shop MCP server remains the only live action
// and authorization layer.
package capabilitypack

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/setup"
)

// PackSchemaVersion is the only pack manifest generation this validator supports. An absent or
// unknown generation is rejected and never assumed to be this one, exactly as
// setup.ParseManifest treats the component manifest's own generation.
const PackSchemaVersion = "1"

// PackManifestPath is the one location a pack manifest may live at inside a pack tree. A tree
// without it has "no pack manifest"; a manifest is never synthesized from the directory listing.
const PackManifestPath = "pack.json"

// Bounds every pack is held to. They exist so a malformed or hostile archive cannot be expanded
// into an unbounded amount of memory before it is rejected, and so every packaged path fits the
// deterministic USTAR header the packer writes.
const (
	maximumLabelBytes       = 128
	maximumSummaryBytes     = 512
	minimumDescriptionBytes = 40
	maximumDescriptionBytes = 1024
	maximumNameBytes        = 128
	// MaximumPathBytes is the USTAR name limit the deterministic archive format imposes. A longer
	// path would force a PAX extension header, which carries producer-dependent records and would
	// make the archive non-reproducible.
	MaximumPathBytes = 99
	// MaximumFileBytes bounds one packaged file, and MaximumPackBytes the whole expanded tree.
	MaximumFileBytes = 64 << 10
	MaximumPackBytes = 1 << 20
	MaximumPackFiles = 64
)

// packPathPattern is the packaged-path grammar: forward-slash separated segments of ASCII
// alphanumerics, dots, dashes, and underscores, each beginning with an alphanumeric. It admits no
// absolute path, no "." or ".." segment, no empty segment, and no backslash, so a path that
// matches can never escape the pack root and is always safe to name in a diagnostic.
var packPathPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*$`)

// Vocabulary is the hub tool vocabulary a pack is validated against. It is passed in rather than
// read from a global so a test can prove that renaming, adding, or removing a tool makes validation
// fail, which is the only way tool-vocabulary drift can be kept from silently shipping stale
// instructions.
type Vocabulary struct {
	ToolNames           []string
	DelegationToolNames []string
}

// DefaultVocabulary is the compiled-in hub tool vocabulary, the Go mirror of hubToolNames in
// packages/protocol/src/index.ts that the shared fixture already holds both languages to. The
// returned slices are copies: a validator must never be able to mutate the vocabulary it checks
// against.
func DefaultVocabulary() Vocabulary {
	return Vocabulary{
		ToolNames:           slices.Clone(protocol.HubToolNames),
		DelegationToolNames: slices.Clone(protocol.DelegationHubToolNames),
	}
}

// validate rejects a vocabulary that could not have come from the protocol source of truth, so a
// malformed vocabulary fails closed instead of accepting every tool name a pack might declare.
func (vocabulary Vocabulary) validate() error {
	if len(vocabulary.ToolNames) == 0 {
		return errors.New("tool vocabulary is empty")
	}
	for _, name := range vocabulary.ToolNames {
		if !hubToolNamePattern.MatchString(name) {
			return errors.New("tool vocabulary contains a name that is not a snake_case tool name")
		}
	}
	if hasDuplicate(vocabulary.ToolNames) {
		return errors.New("tool vocabulary contains a duplicate name")
	}
	for _, name := range vocabulary.DelegationToolNames {
		if !slices.Contains(vocabulary.ToolNames, name) {
			return errors.New("delegation tool vocabulary names a tool absent from the tool vocabulary")
		}
	}
	return nil
}

func (vocabulary Vocabulary) isDelegationOnly(name string) bool {
	return slices.Contains(vocabulary.DelegationToolNames, name)
}

// hubToolNamePattern is the shape of a hub tool name: lowercase snake_case with at least one
// underscore. It is how prose is scanned for tool references, so a renamed tool leaves a dangling
// name in the pack text that validation refuses rather than shipping.
var hubToolNamePattern = regexp.MustCompile(`^[a-z][a-z0-9]*(_[a-z0-9]+)+$`)

// PackFile is one packaged file and the digest the pack manifest pins it at. The digest grammar is
// setup.ChecksumPattern, the one definition of a pinned SHA-256 in the Go tree; this package
// defines no second one.
type PackFile struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

// PackSkill is one focused workflow the pack ships. RequiredTools are the hub tools the skill's
// workflow needs in every run; DelegationTools are the delegation-only tools it may use and is the
// skill's explicit declaration of the delegation requirement — a delegation-only name in
// RequiredTools is rejected, because a non-delegating run is never served that tool and
// unconditional instructions to call it would produce a guaranteed failure.
type PackSkill struct {
	ID              string   `json:"id"`
	Path            string   `json:"path"`
	EvaluationPath  string   `json:"evaluationPath"`
	RequiredTools   []string `json:"requiredTools"`
	DelegationTools []string `json:"delegationTools,omitempty"`
}

// PackManifest is the portable pack manifest: pack identity, the declared Coffee Shop
// protocol/tool compatibility, the focused skills, and a digest per packaged file. It is the single
// source of truth for pack identity and compatibility; the components.json entry's version and the
// activation probe both derive from it rather than restating it.
type PackManifest struct {
	PackSchemaVersion string `json:"packSchemaVersion"`
	ID                string `json:"id"`
	Version           string `json:"version"`
	Label             string `json:"label"`
	Summary           string `json:"summary"`
	// MinimumControlProtocolVersion is the oldest Coffee Shop control protocol generation whose tool
	// vocabulary and semantics the workflows assume. A generation this Barista does not support, or
	// one newer than the one it runs, is incompatible and refuses activation outright; the pack is
	// never degraded to a partial one.
	MinimumControlProtocolVersion string `json:"minimumControlProtocolVersion"`
	// ToolVocabulary and DelegationToolVocabulary are the exact vocabulary the pack was authored
	// against, in the protocol's own order. They must equal the running vocabulary exactly, so any
	// rename, addition, or removal upstream breaks validation instead of shipping stale prose.
	ToolVocabulary           []string    `json:"toolVocabulary"`
	DelegationToolVocabulary []string    `json:"delegationToolVocabulary"`
	Skills                   []PackSkill `json:"skills"`
	Files                    []PackFile  `json:"files"`
}

// Ref is the pack identity a manifest entry and an activation record are checked against.
func (manifest PackManifest) Ref() string { return manifest.ID + "@" + manifest.Version }

// SkillIDs returns every declared skill id in declaration order.
func (manifest PackManifest) SkillIDs() []string {
	ids := make([]string, 0, len(manifest.Skills))
	for _, skill := range manifest.Skills {
		ids = append(ids, skill.ID)
	}
	return ids
}

// ParsePackManifest strictly decodes pack manifest bytes. Unknown fields, trailing data, and a
// malformed document are rejected with a decode error rather than tolerated: a malformed manifest
// is a rejection, never the absent case, and an unknown field is named without its value because
// pack bytes may be attacker-influenced once they are on disk.
func ParsePackManifest(data []byte) (PackManifest, error) {
	var manifest PackManifest
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return PackManifest{}, fmt.Errorf("decode pack manifest: %s", screenDetail(err.Error()))
	}
	if decoder.More() {
		return PackManifest{}, errors.New("decode pack manifest: trailing data after the manifest object")
	}
	if manifest.PackSchemaVersion != PackSchemaVersion {
		return PackManifest{}, fmt.Errorf("pack manifest schema generation is absent or unknown; only generation %q is supported", PackSchemaVersion)
	}
	return manifest, nil
}

// validateIdentity enforces the pack identity and compatibility grammar, reusing the one Go-side
// definition of kebab-case and of a normalized dotted version. No second regex is defined here.
func (manifest PackManifest) validateIdentity() error {
	if !protocol.LabelOrAcceleratorPattern.MatchString(manifest.ID) {
		return errors.New("pack manifest id is not kebab-case")
	}
	if !protocol.IsNormalizedVersion(manifest.Version) {
		return errors.New("pack manifest version is not a normalized dotted version")
	}
	if manifest.Label == "" || len(manifest.Label) > maximumLabelBytes {
		return fmt.Errorf("pack manifest label is empty or exceeds %d bytes", maximumLabelBytes)
	}
	if manifest.Summary == "" || len(manifest.Summary) > maximumSummaryBytes {
		return fmt.Errorf("pack manifest summary is empty or exceeds %d bytes", maximumSummaryBytes)
	}
	return manifest.validateCompatibility()
}

// validateCompatibility resolves the declared minimum control protocol generation against the ones
// this build actually supports. An unknown generation and a generation newer than the running one
// are the same answer — incompatible — because both mean the workflows assume semantics this node
// cannot confirm.
func (manifest PackManifest) validateCompatibility() error {
	declared := slices.Index(protocol.SupportedVersions, manifest.MinimumControlProtocolVersion)
	if declared < 0 {
		return fmt.Errorf("pack manifest declares control protocol generation %q, which this build does not support; supported generations are %s",
			screenDetail(manifest.MinimumControlProtocolVersion), strings.Join(protocol.SupportedVersions, ", "))
	}
	running := slices.Index(protocol.SupportedVersions, protocol.LatestVersion)
	if running < 0 || declared > running {
		return fmt.Errorf("pack manifest requires control protocol generation %q, which is newer than the running generation %q",
			manifest.MinimumControlProtocolVersion, protocol.LatestVersion)
	}
	return nil
}

// validateVocabulary refuses any disagreement between the vocabulary the pack was authored against
// and the running one. Equality is exact, order included, because the protocol's order is itself
// part of the shared fixture both languages are checked against.
func (manifest PackManifest) validateVocabulary(vocabulary Vocabulary) error {
	if !slices.Equal(manifest.ToolVocabulary, vocabulary.ToolNames) {
		return errors.New("pack manifest toolVocabulary does not equal the running hub tool vocabulary")
	}
	if !slices.Equal(manifest.DelegationToolVocabulary, vocabulary.DelegationToolNames) {
		return errors.New("pack manifest delegationToolVocabulary does not equal the running delegation tool vocabulary")
	}
	return nil
}

// validateFiles enforces the file table: a safe, sorted, duplicate-free path list with a pinned
// lowercase SHA-256 each. pack.json is never in the table, because a manifest cannot pin its own
// digest; the archive digest and the ownership ledger cover it instead.
func (manifest PackManifest) validateFiles() error {
	if len(manifest.Files) == 0 {
		return errors.New("pack manifest declares no files")
	}
	if len(manifest.Files) > MaximumPackFiles {
		return fmt.Errorf("pack manifest declares more than %d files", MaximumPackFiles)
	}
	previous := ""
	for index, file := range manifest.Files {
		if err := validatePackPath(file.Path); err != nil {
			return fmt.Errorf("pack manifest file at index %d: %w", index, err)
		}
		if file.Path == PackManifestPath {
			return fmt.Errorf("pack manifest file at index %d: the pack manifest must not declare its own digest", index)
		}
		if !setup.ChecksumPattern.MatchString(file.SHA256) {
			return fmt.Errorf("pack manifest file %s: sha256 is not 64 lowercase hex characters", file.Path)
		}
		if index > 0 && file.Path <= previous {
			return fmt.Errorf("pack manifest file at index %d: files must be sorted by path and unique", index)
		}
		previous = file.Path
	}
	return nil
}

// validatePackPath is the one packaged-path check. It reports failures by grammar, and only ever
// echoes a path that already matched the grammar, so a rejection can never print hostile bytes.
func validatePackPath(path string) error {
	if path == "" {
		return errors.New("path is empty")
	}
	if len(path) > MaximumPathBytes {
		return fmt.Errorf("path exceeds %d bytes", MaximumPathBytes)
	}
	if !packPathPattern.MatchString(path) {
		return errors.New("path is not a relative, forward-slash pack path of alphanumeric-led segments")
	}
	return nil
}

// ValidatePackPath is the packaged-path grammar exported for the harness activation adapters, which
// interpolate values into a projection path and must be held to exactly this grammar rather than
// defining a second containment check. It is validatePackPath and nothing else.
func ValidatePackPath(path string) error { return validatePackPath(path) }

func hasDuplicate(values []string) bool {
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		if seen[value] {
			return true
		}
		seen[value] = true
	}
	return false
}
