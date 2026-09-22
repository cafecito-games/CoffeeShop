package harness

import (
	"context"
	"os/exec"
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

func Discover(ctx context.Context) []protocol.HarnessProfile {
	profiles := make([]protocol.HarnessProfile, 0, len(providers))
	for _, item := range providers {
		profile := protocol.HarnessProfile{
			ID:          item.id,
			Label:       item.label,
			Description: "Not installed",
			Binary:      item.binary,
			Available:   false,
			AuthMode:    item.authMode,
			Models:      item.models,
			// Set explicitly even when unavailable: the hub reads the transports list to decide how
			// it may dispatch to each harness, and AdvertiseACP adds acp-v1 only for a harness whose
			// verified adapter passes its startup probe.
			Transports: []string{TransportNative},
		}
		path, err := exec.LookPath(item.binary)
		if err == nil {
			versionContext, cancel := context.WithTimeout(ctx, 5*time.Second)
			output, commandErr := exec.CommandContext(versionContext, path, "--version").CombinedOutput()
			cancel()
			if commandErr == nil {
				profile.Available = true
				profile.Binary = path
				profile.Description = strings.TrimSpace(string(output))
				if profile.Description == "" {
					profile.Description = "Installed"
				}
			}
		}
		profiles = append(profiles, profile)
	}
	return profiles
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
