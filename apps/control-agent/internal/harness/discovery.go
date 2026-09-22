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
		capabilities, err := driver.Probe(probeContext, harnessID)
		cancel()
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
		profile.Available = true
		profile.ACP = &capabilities
		advertised[index] = profile
	}
	return advertised, failures
}
