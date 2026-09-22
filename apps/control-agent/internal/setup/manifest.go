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

// ManifestVersion identifies the schema generation of the adapter manifest, not any individual
// adapter's version.
const ManifestVersion = "1"

//go:embed manifest/adapters.json
var embeddedManifest []byte

type DistributionKind string

const (
	DistributionKindArchive DistributionKind = "archive" // downloaded over HTTPS, verified, extracted
	DistributionKindManual  DistributionKind = "manual"  // operator places and verifies the artifact themselves
)

// PlatformDistribution is the exact source and integrity material for one adapter on one
// platform. URL is required and must be HTTPS when Kind is DistributionKindArchive; it is empty
// for DistributionKindManual. SHA256 is required whenever Kind is DistributionKindArchive.
// ExecutablePath is the relative path to the adapter's executable inside the archive (or, for
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
// installed adapter. It never contains a token, URL, or path with runtime state baked in; those
// are supplied at invocation time by internal/harness.
type LaunchTemplate struct {
	Arguments   []string `json:"arguments,omitempty"`
	Environment []string `json:"environment,omitempty"` // "NAME=value" pairs, no secret-like values
}

// AdapterManifestEntry describes one supported ACP adapter at one pinned version. The manifest
// deliberately has no field that names a command, binary, or argument list to execute: doctor's
// auth-readiness probes are a compiled-in allowlist keyed by HarnessID (see AuthProbeAllowlist in
// authprobe.go), never anything this file — which an operator can point --manifest at freely —
// could supply. ParseManifest's DisallowUnknownFields rejects a manifest that tries to add one
// back, rather than silently ignoring it.
type AdapterManifestEntry struct {
	ID          string                          `json:"id"`        // kebab-case, globally unique within the manifest
	HarnessID   string                          `json:"harnessId"` // matches a harness.Discover() profile id, e.g. "claude-cli"
	Provider    string                          `json:"provider"`  // kebab-case vendor identifier, e.g. "anthropic"
	Label       string                          `json:"label"`     // human-readable, <= 128 bytes
	Version     string                          `json:"version"`   // must satisfy protocol.IsNormalizedVersion
	Platforms   map[string]PlatformDistribution `json:"platforms"` // key is "GOOS-GOARCH", e.g. "darwin-arm64"
	Launch      LaunchTemplate                  `json:"launch"`
	AuthDocsURL string                          `json:"authDocsUrl,omitempty"` // documentation link only, never executed
}

// Manifest is the version-controlled, non-secret adapter manifest. It is the single source of
// truth for which adapters are supported and how to obtain them.
type Manifest struct {
	ManifestVersion string                 `json:"manifestVersion"`
	Adapters        []AdapterManifestEntry `json:"adapters"`
}

// checksumPattern is the exact grammar of a pinned SHA-256 in the manifest: 64 lowercase hex
// characters. An uppercase or short digest is rejected outright rather than normalized, because a
// half-remembered digest must never be trimmed into something that passes.
var checksumPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// platformKeyPattern reuses the protocol kebab-case grammar: a GOOS-GOARCH key such as
// "darwin-arm64" is exactly two lowercase alphanumeric segments joined by one dash, so the single
// Go-side definition of that grammar stays the only one.
var platformKeyPattern = protocol.LabelOrAcceleratorPattern

// ParseManifest strictly decodes adapter manifest bytes and validates them. Unknown fields,
// trailing data, and any validation failure are rejected rather than tolerated: a manifest drives
// what gets installed on compute machines, so ambiguity fails closed.
func ParseManifest(data []byte) (Manifest, error) {
	var manifest Manifest
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return Manifest{}, fmt.Errorf("decode adapter manifest: %w", err)
	}
	if decoder.More() {
		return Manifest{}, errors.New("decode adapter manifest: trailing data after the manifest object")
	}
	if err := manifest.Validate(); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

// LoadDefaultManifest parses the adapter manifest compiled into the binary. It is the manifest
// used unless an operator explicitly overrides it with an external one.
func LoadDefaultManifest() (Manifest, error) {
	manifest, err := ParseManifest(embeddedManifest)
	if err != nil {
		return Manifest{}, fmt.Errorf("parse embedded adapter manifest: %w", err)
	}
	return manifest, nil
}

// DefaultManifestBytes returns the exact bytes of the embedded adapter manifest. Planning and
// applying both hash the manifest source to tie a plan to the manifest it was built from, so a
// default-manifest plan and its apply must read these same bytes rather than re-reading any file.
func DefaultManifestBytes() []byte {
	return embeddedManifest
}

// Validate enforces the manifest schema. Operator- and vendor-supplied text is screened for
// secret-like content before any structural check, because during manifest review the structural
// rejection message must never become an oracle that echoes a pasted credential back. Every
// rejection names the adapter's slice index and the offending field — never the adapter ID, the
// field value, or the platform key — since a malformed manifest may itself be attacker-influenced.
func (manifest Manifest) Validate() error {
	for index := range manifest.Adapters {
		entry := &manifest.Adapters[index]
		if protocol.LooksSecretLike(entry.Label) {
			return fmt.Errorf("adapter at index %d: label looks secret-like", index)
		}
		if protocol.LooksSecretLike(entry.AuthDocsURL) {
			return fmt.Errorf("adapter at index %d: authDocsUrl looks secret-like", index)
		}
		if slices.ContainsFunc(entry.Launch.Environment, protocol.LooksSecretLike) {
			return fmt.Errorf("adapter at index %d: launch environment entry looks secret-like", index)
		}
		for _, distribution := range entry.Platforms {
			if protocol.LooksSecretLike(distribution.URL) {
				return fmt.Errorf("adapter at index %d: platform distribution url looks secret-like", index)
			}
		}
	}
	if manifest.ManifestVersion != ManifestVersion {
		return fmt.Errorf("adapter manifest schema generation is unknown; only generation %q is supported", ManifestVersion)
	}
	if len(manifest.Adapters) == 0 {
		return errors.New("adapter manifest declares no adapters")
	}
	seenIDs := make(map[string]bool, len(manifest.Adapters))
	for index := range manifest.Adapters {
		entry := manifest.Adapters[index]
		if entry.ID == "" || !protocol.LabelOrAcceleratorPattern.MatchString(entry.ID) {
			return fmt.Errorf("adapter at index %d: id is not kebab-case", index)
		}
		if entry.HarnessID == "" || !protocol.LabelOrAcceleratorPattern.MatchString(entry.HarnessID) {
			return fmt.Errorf("adapter at index %d: harnessId is not kebab-case", index)
		}
		if entry.Provider == "" || !protocol.LabelOrAcceleratorPattern.MatchString(entry.Provider) {
			return fmt.Errorf("adapter at index %d: provider is not kebab-case", index)
		}
		if seenIDs[entry.ID] {
			return fmt.Errorf("adapter at index %d: duplicate id", index)
		}
		seenIDs[entry.ID] = true
		if entry.Label == "" || len(entry.Label) > 128 {
			return fmt.Errorf("adapter at index %d: label is empty or exceeds 128 bytes", index)
		}
		if !protocol.IsNormalizedVersion(entry.Version) {
			return fmt.Errorf("adapter at index %d: version is not a normalized dotted version", index)
		}
		if len(entry.Platforms) == 0 {
			return fmt.Errorf("adapter at index %d: platforms is empty", index)
		}
		for platformKey, distribution := range entry.Platforms {
			if !platformKeyPattern.MatchString(platformKey) {
				return fmt.Errorf("adapter at index %d: platform key is not GOOS-GOARCH shaped", index)
			}
			if err := validatePlatformDistribution(distribution); err != nil {
				return fmt.Errorf("adapter at index %d: %w", index, err)
			}
		}
	}
	return nil
}

func validatePlatformDistribution(distribution PlatformDistribution) error {
	if distribution.Kind != DistributionKindArchive && distribution.Kind != DistributionKindManual {
		return fmt.Errorf("platform distribution kind must be %q or %q", DistributionKindArchive, DistributionKindManual)
	}
	if err := validateExecutablePath(distribution.ExecutablePath); err != nil {
		return err
	}
	if distribution.Kind == DistributionKindArchive {
		if !strings.HasPrefix(distribution.URL, "https://") {
			return fmt.Errorf("archive platform distribution url must use https")
		}
		if !checksumPattern.MatchString(distribution.SHA256) {
			return fmt.Errorf("archive platform distribution sha256 must be 64 lowercase hex characters")
		}
		if distribution.SizeBytes <= 0 {
			return fmt.Errorf("archive platform distribution sizeBytes must be positive")
		}
		return nil
	}
	if distribution.URL != "" || distribution.SHA256 != "" {
		return fmt.Errorf("manual platform distribution must not carry a url or sha256")
	}
	return nil
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
