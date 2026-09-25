package setup

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

// ManifestVersion identifies the current schema generation of the managed component manifest, not
// any individual component's version. Generation 2 carries a "components" array whose entries each
// name a ComponentKind.
const ManifestVersion = "2"

// LegacyAdapterManifestVersion is the previous, adapter-only schema generation: a "manifestVersion"
// of "1" with an "adapters" array and no component kind. It stays accepted as an input for the
// transition — ParseManifest migrates every entry to ComponentKindACPAdapter, which is what an
// adapter-only manifest could only ever have meant — but it is never produced again. A document
// that mixes the two generations (either array under the other generation) is rejected outright
// rather than resolved in one generation's favor.
const LegacyAdapterManifestVersion = "1"

//go:embed manifest/components.json
var embeddedManifest []byte

// ComponentKind is the closed vocabulary of things Barista setup can own. Every value must appear
// in ComponentKinds and be handled by componentKindDirectory; a value outside the vocabulary is
// rejected at parse time and never defaulted.
type ComponentKind string

const (
	// ComponentKindHarness is a provider CLI Barista launches runs with (Claude Code, Codex).
	ComponentKindHarness ComponentKind = "harness"
	// ComponentKindACPAdapter is an Agent Client Protocol adapter Barista launches alongside a
	// harness.
	ComponentKindACPAdapter ComponentKind = "acp-adapter"
)

// ComponentKinds is the single enumeration of every supported ComponentKind. Consumers that must
// handle every kind (containment layout, doctor, tests) iterate this rather than repeating a list.
var ComponentKinds = []ComponentKind{ComponentKindHarness, ComponentKindACPAdapter}

// Valid reports whether kind is in the closed vocabulary.
func (kind ComponentKind) Valid() bool {
	return slices.Contains(ComponentKinds, kind)
}

// ComponentRef is the identity triple every managed component is addressed by across the manifest,
// the plan, and the ownership ledger: exactly one definition, so a plan operation, an ownership
// record, and a doctor entry cannot disagree about what identifies a component. Every field
// participates in the plan digest, because installing a different kind, id, or version at the same
// target path is a different mutation, not the same one.
type ComponentRef struct {
	Kind    ComponentKind `json:"kind"`
	ID      string        `json:"id"`
	Version string        `json:"version"`
}

// Validate enforces the identity grammar: a known kind, a kebab-case id, and a normalized dotted
// version. An empty field is a rejection, never a wildcard.
func (ref ComponentRef) Validate() error {
	if !ref.Kind.Valid() {
		return errors.New("component kind is unknown")
	}
	if ref.ID == "" || !protocol.LabelOrAcceleratorPattern.MatchString(ref.ID) {
		return errors.New("component id is not kebab-case")
	}
	if !protocol.IsNormalizedVersion(ref.Version) {
		return errors.New("component version is not a normalized dotted version")
	}
	return nil
}

// String is the stable human and log form of a component identity, "<kind>/<id>@<version>". It is
// built only from already-validated kebab-case and dotted-version fields, so it never carries
// operator-supplied free text.
func (ref ComponentRef) String() string {
	return string(ref.Kind) + "/" + ref.ID + "@" + ref.Version
}

type DistributionKind string

const (
	DistributionKindArchive DistributionKind = "archive" // downloaded over HTTPS, verified, extracted
	DistributionKindManual  DistributionKind = "manual"  // operator places and verifies the artifact themselves
)

// DistributionKinds is the single enumeration of every supported DistributionKind, for the same
// reason ComponentKinds exists: one definition every consumer and test can exhaust.
var DistributionKinds = []DistributionKind{DistributionKindArchive, DistributionKindManual}

// Valid reports whether kind is in the closed vocabulary.
func (kind DistributionKind) Valid() bool {
	return slices.Contains(DistributionKinds, kind)
}

// PlatformDistribution is the exact source and integrity material for one component on one
// platform. URL is required and must be HTTPS when Kind is DistributionKindArchive; it is empty
// for DistributionKindManual. SHA256 is required whenever Kind is DistributionKindArchive.
// ExecutablePath is the relative path to the component's executable inside the archive (or, for
// manual distributions, inside the operator-supplied directory) using forward slashes regardless
// of host OS; it must not contain ".." segments or be absolute.
type PlatformDistribution struct {
	Kind           DistributionKind `json:"kind"`
	URL            string           `json:"url,omitempty"`
	SHA256         string           `json:"sha256,omitempty"`
	SizeBytes      int64            `json:"sizeBytes,omitempty"`
	ExecutablePath string           `json:"executablePath"`
}

// LaunchTemplate is the non-secret argument/environment template Barista uses to invoke an
// installed component. It never contains a token, URL, or path with runtime state baked in; those
// are supplied at invocation time by internal/harness.
type LaunchTemplate struct {
	Arguments   []string `json:"arguments,omitempty"`
	Environment []string `json:"environment,omitempty"` // "NAME=value" pairs, no secret-like values
}

// ComponentManifestEntry describes one supported managed component at one pinned version — a
// provider harness or an ACP adapter. The manifest deliberately has no field that names a command,
// binary, or argument list to execute: doctor's auth-readiness probes are a compiled-in allowlist
// keyed by HarnessID (see AuthProbeAllowlist in authprobe.go), never anything this file — which an
// operator can point --manifest at freely — could supply. ParseManifest's DisallowUnknownFields
// rejects a manifest that tries to add one back, rather than silently ignoring it.
type ComponentManifestEntry struct {
	ID   string        `json:"id"`   // kebab-case, globally unique within the manifest
	Kind ComponentKind `json:"kind"` // "harness" or "acp-adapter"; never defaulted
	// HarnessID associates the component with one harness identity: for ComponentKindACPAdapter it
	// is the harness the adapter adapts (matching a harness.Discover() profile id, e.g.
	// "claude-cli"); for ComponentKindHarness it must equal ID, because a harness component *is*
	// that harness and a harness that claimed a different harness's identity would let one entry
	// silently stand in for another.
	HarnessID   string                          `json:"harnessId"`
	Provider    string                          `json:"provider"` // kebab-case vendor identifier, e.g. "anthropic"
	Label       string                          `json:"label"`    // human-readable, <= 128 bytes
	Version     string                          `json:"version"`  // must satisfy protocol.IsNormalizedVersion
	Platforms   map[string]PlatformDistribution `json:"platforms"`
	Launch      LaunchTemplate                  `json:"launch"`
	AuthDocsURL string                          `json:"authDocsUrl,omitempty"` // documentation link only, never executed
}

// Ref is the entry's shared component identity, the one value plan operations, ownership records,
// and installed verification all compare against.
func (entry ComponentManifestEntry) Ref() ComponentRef {
	return ComponentRef{Kind: entry.Kind, ID: entry.ID, Version: entry.Version}
}

// Manifest is the version-controlled, non-secret managed component manifest. It is the single
// source of truth for which components are supported and how to obtain them. ManifestVersion is
// always the current generation on a parsed manifest: ParseManifest migrates a legacy
// generation-1 document rather than carrying its generation forward, so every downstream consumer
// (plan, ledger, doctor) sees exactly one schema.
type Manifest struct {
	ManifestVersion string                   `json:"manifestVersion"`
	Components      []ComponentManifestEntry `json:"components"`
}

// ComponentsOfKind returns every entry of one kind, in manifest order.
func (manifest Manifest) ComponentsOfKind(kind ComponentKind) []ComponentManifestEntry {
	matching := make([]ComponentManifestEntry, 0, len(manifest.Components))
	for _, entry := range manifest.Components {
		if entry.Kind == kind {
			matching = append(matching, entry)
		}
	}
	return matching
}

// ChecksumPattern is the exact grammar of a pinned SHA-256, in the manifest and wherever else
// Barista pins a digest: 64 lowercase hex characters. An uppercase or short digest is rejected outright rather than normalized, because a
// half-remembered digest must never be trimmed into something that passes.
var ChecksumPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// platformKeyPattern reuses the protocol kebab-case grammar: a GOOS-GOARCH key such as
// "darwin-arm64" is exactly two lowercase alphanumeric segments joined by one dash, so the single
// Go-side definition of that grammar stays the only one.
var platformKeyPattern = protocol.LabelOrAcceleratorPattern

// manifestDocument is the wire shape ParseManifest decodes. It carries both generations' arrays so
// that strict decoding can see, and reject, a document that mixes them — decoding only the array
// belonging to the declared generation would silently ignore the other one.
type manifestDocument struct {
	ManifestVersion string                   `json:"manifestVersion"`
	Components      []ComponentManifestEntry `json:"components,omitempty"`
	Adapters        []legacyAdapterEntry     `json:"adapters,omitempty"`
}

// legacyAdapterEntry is the generation-1 adapter entry. It deliberately has no "kind" field, so a
// generation-1 document that tries to declare a component kind is rejected by
// DisallowUnknownFields instead of being accepted as a half-migrated hybrid.
type legacyAdapterEntry struct {
	ID          string                          `json:"id"`
	HarnessID   string                          `json:"harnessId"`
	Provider    string                          `json:"provider"`
	Label       string                          `json:"label"`
	Version     string                          `json:"version"`
	Platforms   map[string]PlatformDistribution `json:"platforms"`
	Launch      LaunchTemplate                  `json:"launch"`
	AuthDocsURL string                          `json:"authDocsUrl,omitempty"`
}

// component migrates one legacy adapter entry to the component schema. An adapter-only manifest
// could only ever have declared ACP adapters, so the kind is fully determined; every other field
// is carried across unchanged and then validated by Manifest.Validate exactly like a natively
// declared component.
func (entry legacyAdapterEntry) component() ComponentManifestEntry {
	return ComponentManifestEntry{
		ID:          entry.ID,
		Kind:        ComponentKindACPAdapter,
		HarnessID:   entry.HarnessID,
		Provider:    entry.Provider,
		Label:       entry.Label,
		Version:     entry.Version,
		Platforms:   entry.Platforms,
		Launch:      entry.Launch,
		AuthDocsURL: entry.AuthDocsURL,
	}
}

// ParseManifest strictly decodes managed component manifest bytes and validates them. Unknown
// fields, trailing data, an unknown or mixed schema generation, and any validation failure are
// rejected rather than tolerated: a manifest drives what gets installed on compute machines, so
// ambiguity fails closed.
func ParseManifest(data []byte) (Manifest, error) {
	var document manifestDocument
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&document); err != nil {
		return Manifest{}, fmt.Errorf("decode component manifest: %w", err)
	}
	if decoder.More() {
		return Manifest{}, errors.New("decode component manifest: trailing data after the manifest object")
	}
	components, err := document.components()
	if err != nil {
		return Manifest{}, err
	}
	manifest := Manifest{ManifestVersion: ManifestVersion, Components: components}
	if err := manifest.Validate(); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

// components resolves the declared generation to one component slice, refusing any document whose
// arrays do not belong to the generation it declares.
func (document manifestDocument) components() ([]ComponentManifestEntry, error) {
	switch document.ManifestVersion {
	case ManifestVersion:
		if len(document.Adapters) > 0 {
			return nil, fmt.Errorf("component manifest generation %q must declare components, not a legacy adapters array", ManifestVersion)
		}
		return document.Components, nil
	case LegacyAdapterManifestVersion:
		if len(document.Components) > 0 {
			return nil, fmt.Errorf("legacy adapter manifest generation %q must declare adapters, not a components array", LegacyAdapterManifestVersion)
		}
		migrated := make([]ComponentManifestEntry, 0, len(document.Adapters))
		for _, entry := range document.Adapters {
			migrated = append(migrated, entry.component())
		}
		return migrated, nil
	default:
		return nil, fmt.Errorf("component manifest schema generation is unknown; supported generations are %q and legacy %q", ManifestVersion, LegacyAdapterManifestVersion)
	}
}

// LoadDefaultManifest parses the component manifest compiled into the binary. It is the manifest
// used unless an operator explicitly overrides it with an external one.
func LoadDefaultManifest() (Manifest, error) {
	manifest, err := ParseManifest(embeddedManifest)
	if err != nil {
		return Manifest{}, fmt.Errorf("parse embedded component manifest: %w", err)
	}
	return manifest, nil
}

// DefaultManifestBytes returns the exact bytes of the embedded component manifest. Planning and
// applying both hash the manifest source to tie a plan to the manifest it was built from, so a
// default-manifest plan and its apply must read these same bytes rather than re-reading any file.
func DefaultManifestBytes() []byte {
	return embeddedManifest
}

// Validate enforces the manifest schema. Operator- and vendor-supplied text is screened for
// secret-like content before any structural check, because during manifest review the structural
// rejection message must never become an oracle that echoes a pasted credential back. Every
// rejection names the component's slice index and the offending field — never the component ID, the
// field value, or the platform key — since a malformed manifest may itself be attacker-influenced.
func (manifest Manifest) Validate() error {
	for index := range manifest.Components {
		entry := &manifest.Components[index]
		if protocol.LooksSecretLike(entry.Label) {
			return fmt.Errorf("component at index %d: label looks secret-like", index)
		}
		if protocol.LooksSecretLike(entry.AuthDocsURL) {
			return fmt.Errorf("component at index %d: authDocsUrl looks secret-like", index)
		}
		if slices.ContainsFunc(entry.Launch.Environment, protocol.LooksSecretLike) {
			return fmt.Errorf("component at index %d: launch environment entry looks secret-like", index)
		}
		for _, distribution := range entry.Platforms {
			if protocol.LooksSecretLike(distribution.URL) {
				return fmt.Errorf("component at index %d: platform distribution url looks secret-like", index)
			}
		}
	}
	if manifest.ManifestVersion != ManifestVersion {
		return fmt.Errorf("component manifest schema generation is unknown; only generation %q is supported", ManifestVersion)
	}
	if len(manifest.Components) == 0 {
		return errors.New("component manifest declares no components")
	}
	seenIDs := make(map[string]bool, len(manifest.Components))
	providerByHarness := make(map[string]string, len(manifest.Components))
	// seenTargets keys a platform key plus the data-root-relative install location one entry would
	// occupy, so two entries that would fight over the same file are rejected outright instead of
	// one silently winning at apply time.
	seenTargets := make(map[string]bool, len(manifest.Components))
	for index := range manifest.Components {
		entry := manifest.Components[index]
		if !entry.Kind.Valid() {
			return fmt.Errorf("component at index %d: kind is unknown", index)
		}
		if entry.ID == "" || !protocol.LabelOrAcceleratorPattern.MatchString(entry.ID) {
			return fmt.Errorf("component at index %d: id is not kebab-case", index)
		}
		if entry.HarnessID == "" || !protocol.LabelOrAcceleratorPattern.MatchString(entry.HarnessID) {
			return fmt.Errorf("component at index %d: harnessId is not kebab-case", index)
		}
		if entry.Kind == ComponentKindHarness && entry.HarnessID != entry.ID {
			return fmt.Errorf("component at index %d: a harness component's harnessId must equal its id", index)
		}
		// Native harness execution builds its own arguments and environment (internal/harness/runner.go)
		// and reads no manifest launch template, so a harness entry that declared one would be making a
		// promise Barista does not keep. Nothing consumes it, so it is refused rather than silently
		// ignored — an operator pointing --manifest at a file with harness arguments must be told they
		// have no effect, not left believing a sandbox or permission flag was applied.
		if entry.Kind == ComponentKindHarness && (len(entry.Launch.Arguments) > 0 || len(entry.Launch.Environment) > 0) {
			return fmt.Errorf("component at index %d: a harness component's launch template must be empty", index)
		}
		if entry.Provider == "" || !protocol.LabelOrAcceleratorPattern.MatchString(entry.Provider) {
			return fmt.Errorf("component at index %d: provider is not kebab-case", index)
		}
		if seenIDs[entry.ID] {
			return fmt.Errorf("component at index %d: duplicate id", index)
		}
		seenIDs[entry.ID] = true
		if existing, seen := providerByHarness[entry.HarnessID]; seen && existing != entry.Provider {
			return fmt.Errorf("component at index %d: harnessId is already associated with a different provider", index)
		}
		providerByHarness[entry.HarnessID] = entry.Provider
		if entry.Label == "" || len(entry.Label) > 128 {
			return fmt.Errorf("component at index %d: label is empty or exceeds 128 bytes", index)
		}
		if !protocol.IsNormalizedVersion(entry.Version) {
			return fmt.Errorf("component at index %d: version is not a normalized dotted version", index)
		}
		if err := entry.Ref().Validate(); err != nil {
			return fmt.Errorf("component at index %d: %w", index, err)
		}
		if len(entry.Platforms) == 0 {
			return fmt.Errorf("component at index %d: platforms is empty", index)
		}
		for platformKey, distribution := range entry.Platforms {
			if !platformKeyPattern.MatchString(platformKey) {
				return fmt.Errorf("component at index %d: platform key is not GOOS-GOARCH shaped", index)
			}
			if err := validatePlatformDistribution(distribution); err != nil {
				return fmt.Errorf("component at index %d: %w", index, err)
			}
			relative, err := componentRelativeTargetPath(entry, distribution)
			if err != nil {
				return fmt.Errorf("component at index %d: %w", index, err)
			}
			targetKey := platformKey + "\x00" + relative
			if seenTargets[targetKey] {
				return fmt.Errorf("component at index %d: duplicate install target path for a platform", index)
			}
			seenTargets[targetKey] = true
		}
	}
	return nil
}

func validatePlatformDistribution(distribution PlatformDistribution) error {
	if !distribution.Kind.Valid() {
		return fmt.Errorf("platform distribution kind must be %q or %q", DistributionKindArchive, DistributionKindManual)
	}
	if err := validateExecutablePath(distribution.ExecutablePath); err != nil {
		return err
	}
	switch distribution.Kind {
	case DistributionKindArchive:
		if !strings.HasPrefix(distribution.URL, "https://") {
			return errors.New("archive platform distribution url must use https")
		}
		if !ChecksumPattern.MatchString(distribution.SHA256) {
			return errors.New("archive platform distribution sha256 must be 64 lowercase hex characters")
		}
		if distribution.SizeBytes <= 0 {
			return errors.New("archive platform distribution sizeBytes must be positive")
		}
		return nil
	case DistributionKindManual:
		if distribution.URL != "" || distribution.SHA256 != "" {
			return errors.New("manual platform distribution must not carry a url or sha256")
		}
		return nil
	default:
		// Unreachable while DistributionKinds and this switch agree; a new kind added to the
		// vocabulary without a case here fails closed rather than installing something unverified.
		return fmt.Errorf("platform distribution kind %q has no validation rule", distribution.Kind)
	}
}

// validateExecutablePath keeps the archive-relative executable reference portable and inside the
// archive: forward slashes only, never absolute, and never an upward traversal. The check runs on
// both slash forms of absoluteness because a Windows drive prefix is absolute on Windows while a
// leading slash is absolute everywhere.
func validateExecutablePath(executablePath string) error {
	if executablePath == "" {
		return errors.New("platform distribution executablePath is empty")
	}
	if strings.ContainsRune(executablePath, '\\') {
		return errors.New("platform distribution executablePath must use forward slashes")
	}
	if strings.HasPrefix(executablePath, "/") || filepath.IsAbs(executablePath) {
		return errors.New("platform distribution executablePath must be relative")
	}
	if slices.Contains(strings.Split(executablePath, "/"), "..") {
		return errors.New("platform distribution executablePath must not traverse upward")
	}
	return nil
}
