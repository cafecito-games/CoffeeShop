package harness

import (
	"context"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

type provider struct {
	id       string
	label    string
	binary   string
	authMode string
	models   []string
}

var providers = []provider{
	{id: "claude-cli", label: "Claude Code", binary: "claude", authMode: "local-subscription", models: []string{"sonnet", "opus", "haiku"}},
	{id: "codex-cli", label: "Codex", binary: "codex", authMode: "local-account", models: []string{}},
}

// HarnessProvenance is the closed vocabulary of where a harness executable came from. Every
// resolution carries exactly one selected provenance; a value outside this set is never defaulted.
type HarnessProvenance string

const (
	// HarnessProvenanceManaged is a Barista-owned installed version that an activation record
	// selects and that re-verified against the ownership ledger.
	HarnessProvenanceManaged HarnessProvenance = "managed"
	// HarnessProvenanceExternal is an operator-installed binary found on PATH, outside Barista
	// ownership.
	HarnessProvenanceExternal HarnessProvenance = "external"
	// HarnessProvenanceAbsent is no usable executable at all.
	HarnessProvenanceAbsent HarnessProvenance = "absent"
)

// HarnessProvenances is the single enumeration of every provenance, so a consumer that must handle
// them all iterates this rather than repeating a list.
var HarnessProvenances = []HarnessProvenance{HarnessProvenanceManaged, HarnessProvenanceExternal, HarnessProvenanceAbsent}

// Valid reports whether provenance is in the closed vocabulary.
func (provenance HarnessProvenance) Valid() bool {
	return slices.Contains(HarnessProvenances, provenance)
}

// ManagedHarness is the activated, already-verified managed harness executable for one harness.
// The caller resolves it through setup.ActiveInstalledComponent, so discovery never reads either
// ledger itself: internal/setup stays the only package that parses them.
type ManagedHarness struct {
	// Binary is the absolute install path of the active version.
	Binary string
	// Version is the active version from the activation record's component identity.
	Version string
	// Verify re-checks ownership, containment, file type, and digest. It is called before every
	// launch, exactly as an ACP adapter's Verify already is.
	Verify func() error
}

// HarnessCandidate is one provenance's own view of a harness. Candidates are reported side by side
// and never merged: a managed version's identity must never be attributed to an external binary or
// the other way round.
type HarnessCandidate struct {
	Provenance HarnessProvenance
	// Binary is the executable this candidate would launch.
	Binary string
	// Version is the candidate's own version, "" when it reports none.
	Version string
	// Description is the candidate's own human-readable description.
	Description string
}

// HarnessResolution is the documented merge of every candidate for one harness. Precedence is
// fixed and total: a managed, activated, verified version wins over an external PATH installation,
// because an administrator selecting a managed version is an explicit choice and PATH is ambient.
// Both candidates stay reported so the precedence is visible rather than silent.
type HarnessResolution struct {
	HarnessID string
	// Selected names the provenance the profile was built from.
	Selected HarnessProvenance
	Managed  *HarnessCandidate
	External *HarnessCandidate
	// Profile is built from the selected candidate alone. Label, auth mode, and models come from
	// Barista's compiled-in provider table, never from a candidate, so no candidate's metadata can
	// stand in for another's.
	Profile protocol.HarnessProfile
	// verified is the managed executable Resolve accepted, kept unexported so the reported
	// candidate stays plain data while the Runner can still reach the verification closure.
	verified *ManagedHarness
}

// Discover resolves every supported harness from external PATH installations only, which is what a
// node with no managed harness components has. It is the read-only discovery doctor and the daemon
// have always performed.
func Discover(ctx context.Context) []protocol.HarnessProfile {
	return Profiles(Resolve(ctx, nil))
}

// Resolve resolves every supported harness from the managed, activated versions in managed (keyed
// by harness ID) and from external PATH discovery, applying HarnessResolution's documented
// precedence. A managed entry whose Verify fails is not a candidate at all: a selection whose bytes
// no longer verify must never be launched, and it must never silently promote the external binary
// either — the harness is reported unavailable so the operator sees the drift.
func Resolve(ctx context.Context, managed map[string]ManagedHarness) []HarnessResolution {
	resolutions := make([]HarnessResolution, 0, len(providers))
	for _, item := range providers {
		resolution := HarnessResolution{
			HarnessID: item.id,
			Selected:  HarnessProvenanceAbsent,
			Profile: protocol.HarnessProfile{
				ID:          item.id,
				Label:       item.label,
				Description: "Not installed",
				Binary:      item.binary,
				Available:   false,
				AuthMode:    item.authMode,
				Models:      item.models,
				// Set explicitly even when unavailable: the hub reads the transports list to decide
				// how it may dispatch to each harness, and AdvertiseACP adds acp-v1 only for a
				// harness whose verified adapter passes its startup probe.
				Transports: []string{TransportNative},
			},
		}
		if candidate, entry, present := managedCandidate(managed, item.id); present {
			resolution.Managed = &candidate
			resolution.verified = &entry
		}
		if candidate, present := externalCandidate(ctx, item.binary); present {
			resolution.External = &candidate
		}
		switch {
		case resolution.Managed != nil:
			resolution.Selected = HarnessProvenanceManaged
		case resolution.External != nil:
			resolution.Selected = HarnessProvenanceExternal
		}
		if selected := resolution.selectedCandidate(); selected != nil {
			resolution.Profile.Available = true
			resolution.Profile.Binary = selected.Binary
			resolution.Profile.Description = selected.Description
		}
		resolutions = append(resolutions, resolution)
	}
	return resolutions
}

// selectedCandidate returns the candidate the profile was built from, or nil when none is usable.
func (resolution HarnessResolution) selectedCandidate() *HarnessCandidate {
	switch resolution.Selected {
	case HarnessProvenanceManaged:
		return resolution.Managed
	case HarnessProvenanceExternal:
		return resolution.External
	case HarnessProvenanceAbsent:
		return nil
	default:
		// Unreachable while HarnessProvenances and this switch agree; an unrecognized provenance
		// resolves to no candidate rather than launching one it never classified.
		return nil
	}
}

// Profiles projects resolutions onto the harness profile list the rest of Barista consumes.
func Profiles(resolutions []HarnessResolution) []protocol.HarnessProfile {
	profiles := make([]protocol.HarnessProfile, 0, len(resolutions))
	for _, resolution := range resolutions {
		profiles = append(profiles, resolution.Profile)
	}
	return profiles
}

// ManagedHarnesses collects the managed executables from resolutions, keyed by harness ID, so the
// Runner can re-verify the selected bytes before every launch.
func ManagedHarnesses(resolutions []HarnessResolution) map[string]ManagedHarness {
	harnesses := map[string]ManagedHarness{}
	for _, resolution := range resolutions {
		if resolution.Selected == HarnessProvenanceManaged && resolution.verified != nil {
			harnesses[resolution.HarnessID] = *resolution.verified
		}
	}
	return harnesses
}

// managedCandidate turns a caller-supplied managed harness into a candidate, refusing anything that
// is not an absolute path or whose content no longer verifies.
func managedCandidate(managed map[string]ManagedHarness, harnessID string) (HarnessCandidate, ManagedHarness, bool) {
	entry, present := managed[harnessID]
	if !present || !filepath.IsAbs(entry.Binary) {
		return HarnessCandidate{}, ManagedHarness{}, false
	}
	if entry.Verify == nil {
		return HarnessCandidate{}, ManagedHarness{}, false
	}
	if err := entry.Verify(); err != nil {
		return HarnessCandidate{}, ManagedHarness{}, false
	}
	description := "Managed harness"
	if entry.Version != "" {
		description += " " + entry.Version
	}
	return HarnessCandidate{
		Provenance:  HarnessProvenanceManaged,
		Binary:      entry.Binary,
		Version:     entry.Version,
		Description: description,
	}, entry, true
}

// externalCandidate is the PATH discovery Barista has always performed: look the binary up on PATH
// and accept it only after its own --version command succeeds.
func externalCandidate(ctx context.Context, binary string) (HarnessCandidate, bool) {
	path, err := exec.LookPath(binary)
	if err != nil {
		return HarnessCandidate{}, false
	}
	versionContext, cancel := context.WithTimeout(ctx, 5*time.Second)
	output, commandErr := exec.CommandContext(versionContext, path, "--version").CombinedOutput()
	cancel()
	if commandErr != nil {
		return HarnessCandidate{}, false
	}
	description := strings.TrimSpace(string(output))
	if description == "" {
		description = "Installed"
	}
	return HarnessCandidate{
		Provenance:  HarnessProvenanceExternal,
		Binary:      path,
		Version:     normalizedHarnessVersion(description),
		Description: description,
	}, true
}

func Available(profiles []protocol.HarnessProfile, id string) bool {
	for _, profile := range profiles {
		if profile.ID == id {
			return profile.Available
		}
	}
	return false
}

// harnessVersionPattern finds the first dotted version number in a harness's --version output.
var harnessVersionPattern = regexp.MustCompile(`\d+(\.\d+)+`)

// normalizedHarnessVersion extracts a normalized version from a discovered description, or "" when
// the description carries none.
func normalizedHarnessVersion(description string) string {
	version := harnessVersionPattern.FindString(description)
	if !protocol.IsNormalizedVersion(version) {
		return ""
	}
	return version
}

// acpProbeTimeout bounds each adapter's startup initialize handshake.
const acpProbeTimeout = 15 * time.Second

// AdvertiseACP probes every adapter configured in driver and returns a copy of profiles in which
// each harness whose adapter completed the initialize handshake advertises acp-v1 with the
// capabilities it negotiated. The capabilities come from the live handshake, not from the adapter
// manifest, so the hub sees what this adapter build actually supports. An adapter that fails its
// probe is disabled in driver, so it can neither be advertised nor dispatched to, and its error is
// returned keyed by harness ID. A harness advertises native-cli only when its native CLI passed
// discovery; it is available when at least one transport is.
func AdvertiseACP(ctx context.Context, profiles []protocol.HarnessProfile, driver *ACPDriver) ([]protocol.HarnessProfile, map[string]error) {
	advertised := make([]protocol.HarnessProfile, len(profiles))
	copy(advertised, profiles)
	failures := map[string]error{}
	if driver == nil {
		return advertised, failures
	}
	for _, harnessID := range driver.HarnessIDs() {
		index := slices.IndexFunc(advertised, func(profile protocol.HarnessProfile) bool { return profile.ID == harnessID })
		if index < 0 {
			continue
		}
		probeContext, cancel := context.WithTimeout(ctx, acpProbeTimeout)
		probe, err := driver.Probe(probeContext, harnessID)
		cancel()
		capabilities := probe.Capabilities
		if err != nil {
			driver.Disable(harnessID, err)
			failures[harnessID] = err
			continue
		}
		profile := advertised[index]
		transports := []string{}
		if profile.Available {
			transports = append(transports, TransportNative)
		}
		profile.Transports = append(transports, TransportACP)
		if !profile.Available {
			profile.Description = "ACP adapter"
			if capabilities.AdapterVersion != "" {
				profile.Description += " " + capabilities.AdapterVersion
			}
		}
		profile.Models = advertisedModels(profile.Models, profile.Available, probe.Models)
		profile.Available = true
		profile.ACP = &capabilities
		advertised[index] = profile
	}
	return advertised, failures
}

// Bounds on the model identifiers an adapter may contribute to a harness's advertised models.
const (
	MaximumAdvertisedModels     = 32
	MaximumAdvertisedModelBytes = 128
)

// modelIdentifierPattern admits the model identifier shapes providers use (such as "gpt-5.5" or
// "anthropic/claude-sonnet@2026") and nothing with whitespace or control characters.
var modelIdentifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$`)

// screenedModels keeps the adapter-offered model identifiers that are bounded, well formed, and
// not secret-like, deduplicated in offered order and capped at MaximumAdvertisedModels.
func screenedModels(offered []string) []string {
	models := []string{}
	seen := map[string]bool{}
	for _, model := range offered {
		if len(models) >= MaximumAdvertisedModels {
			break
		}
		if seen[model] || len(model) > MaximumAdvertisedModelBytes || !modelIdentifierPattern.MatchString(model) || protocol.LooksSecretLike(model) {
			continue
		}
		seen[model] = true
		models = append(models, model)
	}
	return models
}

// advertisedModels merges the adapter's models into a harness's advertised list. The hub reads an
// empty list as "default only", so when the list was empty and the adapter offers models, "default"
// is kept explicitly: a "default" run keeps the provider's configured model on either transport.
// The native list, when the native CLI is available, keeps its entries and order. Without adapter
// models the list is unchanged.
func advertisedModels(existing []string, nativeAvailable bool, adapterModels []string) []string {
	if len(adapterModels) == 0 {
		return existing
	}
	base := []string{}
	if nativeAvailable {
		base = append(base, existing...)
	}
	if len(base) == 0 {
		base = append(base, "default")
	}
	merged := make([]string, 0, len(base)+len(adapterModels))
	seen := map[string]bool{}
	for _, model := range append(base, adapterModels...) {
		if !seen[model] && len(merged) < MaximumAdvertisedModels {
			seen[model] = true
			merged = append(merged, model)
		}
	}
	return merged
}
