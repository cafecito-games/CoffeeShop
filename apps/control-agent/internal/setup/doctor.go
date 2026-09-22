package setup

import (
	"context"
	"net/url"
	"strings"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

// hubDetailMaximumBytes bounds each human-readable hub connectivity detail.
const hubDetailMaximumBytes = 256

// hubConnectivityGenericDetail replaces any connectivity error message that looks secret-like — a
// URL can carry a query-string token, and net errors embed the dialed address verbatim.
const hubConnectivityGenericDetail = "connection attempt failed"

// hubEndpointInvalidDisplay is shown in place of a control endpoint this doctor could not parse
// well enough to sanitize; an endpoint that cannot be sanitized is never echoed verbatim instead.
const hubEndpointInvalidDisplay = "invalid control endpoint"

// AdapterDoctorEntry reports one manifest adapter's status on this node.
type AdapterDoctorEntry struct {
	AdapterID        string        `json:"adapterId"`
	HarnessID        string        `json:"harnessId"`
	HarnessInstalled bool          `json:"harnessInstalled"` // from the discovered harness profile's Available flag, passed in
	AdapterInstalled bool          `json:"adapterInstalled"` // ownership ledger has a matching-digest record at this platform's target path
	AdapterPath      string        `json:"adapterPath,omitempty"`
	AuthReadiness    AuthReadiness `json:"authReadiness"`
	ACPLaunchReady   bool          `json:"acpLaunchReady"`  // HarnessInstalled && AdapterInstalled && AuthReadiness == ready
	Notes            []string      `json:"notes,omitempty"` // bounded, non-secret human-readable gaps, e.g. "no platform distribution for linux-arm64"
}

// HubConnectivity reports whether the configured control endpoint accepted a bounded, read-only
// TCP connection attempt. It never authenticates, never opens the real WebSocket, and never
// creates a run. Endpoint is always the sanitized display form (see sanitizeEndpointForDisplay);
// it never carries userinfo, a query string, or a fragment, in either JSON or human output.
type HubConnectivity struct {
	Endpoint  string `json:"endpoint"`
	Reachable bool   `json:"reachable"`
	Detail    string `json:"detail,omitempty"` // bounded, screened by protocol.LooksSecretLike before inclusion
}

// Report is the full, read-only doctor output. It performs no filesystem or network mutation.
type Report struct {
	Platform         string               `json:"platform"`
	DataRoot         string               `json:"dataRoot"`
	Adapters         []AdapterDoctorEntry `json:"adapters"`
	HubConnectivity  HubConnectivity      `json:"hubConnectivity"`
	ProjectReadiness string               `json:"projectReadiness"`
}

// ProjectReadinessNotAvailable documents that no hub REST endpoint yet exists for a Barista-local
// project readiness check: readiness evaluation composes hub-held project profiles with node
// capability evidence, and the hub does not yet expose that composition over an endpoint this
// doctor could call. Doctor reports this literal rather than fabricating a readiness verdict it
// cannot actually verify.
const ProjectReadinessNotAvailable = "not available: no hub endpoint exists yet to evaluate project readiness from this node"

// RunDoctor builds one full report. harnesses is the already-discovered harness inventory
// (dependency-injected so this stays testable without invoking real CLIs); dial is the function
// used to test hub connectivity (dependency-injected as func(ctx, endpoint) error so tests never
// make a real network call). Doctor reports problems; it never mutates the filesystem and never
// repairs anything.
//
// Every auth-readiness probe doctor runs comes from the compiled-in AuthProbeAllowlist, keyed by
// harness ID, and its binary is always the exact absolute path harness discovery already resolved
// and trusted as "this harness is installed" — never a command or path named by the adapter
// manifest, which --manifest can point at an arbitrary local file.
func RunDoctor(
	ctx context.Context,
	manifest Manifest,
	ledger OwnershipLedger,
	dataRoot string,
	platform string,
	harnesses []protocol.HarnessProfile,
	controlEndpoint string,
	dial func(ctx context.Context, endpoint string) error,
) Report {
	report := Report{
		Platform:         platform,
		DataRoot:         dataRoot,
		Adapters:         make([]AdapterDoctorEntry, 0, len(manifest.Adapters)),
		ProjectReadiness: ProjectReadinessNotAvailable,
	}
	for index := range manifest.Adapters {
		entry := manifest.Adapters[index]
		harnessProfile, discovered := findHarnessProfile(harnesses, entry.HarnessID)
		doctorEntry := AdapterDoctorEntry{
			AdapterID:        entry.ID,
			HarnessID:        entry.HarnessID,
			HarnessInstalled: discovered && harnessProfile.Available,
			AuthReadiness:    AuthReadinessUnknown,
		}
		distribution, supported := entry.Platforms[platform]
		if !supported {
			// An adapter with no distribution for this platform stays visible in the report with a
			// note; silently dropping it would hide unsupported-platform gaps the operator asked
			// doctor to surface.
			doctorEntry.Notes = append(doctorEntry.Notes, "no platform distribution for "+platform)
			report.Adapters = append(report.Adapters, doctorEntry)
			continue
		}
		targetPath := AdapterTargetPath(dataRoot, entry, distribution)
		doctorEntry.AdapterPath = targetPath
		// Installed means the ledger record still matches the file on disk — a stale ledger entry
		// over a deleted or corrupted file must not report as installed. observeCurrentState makes
		// exactly that distinction, and anything ambiguous classifies as not installed.
		doctorEntry.AdapterInstalled = observeCurrentState(targetPath, ledger) == ExpectedOwnedMatch
		if spec, allowed := AuthProbeAllowlist[entry.HarnessID]; allowed && doctorEntry.HarnessInstalled {
			doctorEntry.AuthReadiness = RunAuthProbe(ctx, harnessProfile.Binary, spec.Arguments, spec.SuccessExitCode)
		}
		doctorEntry.ACPLaunchReady = doctorEntry.HarnessInstalled &&
			doctorEntry.AdapterInstalled &&
			doctorEntry.AuthReadiness == AuthReadinessReady
		report.Adapters = append(report.Adapters, doctorEntry)
	}
	report.HubConnectivity = HubConnectivity{Endpoint: sanitizeEndpointForDisplay(controlEndpoint)}
	if dial == nil {
		report.HubConnectivity.Detail = hubConnectivityGenericDetail
	} else if err := dial(ctx, controlEndpoint); err != nil {
		report.HubConnectivity.Detail = screenedHubDetail(err.Error())
	} else {
		report.HubConnectivity.Reachable = true
	}
	return report
}

// findHarnessProfile looks up harnessID's discovered profile, which carries the absolute resolved
// binary path RunAuthProbe must use — doctor never re-resolves a binary name itself.
func findHarnessProfile(harnesses []protocol.HarnessProfile, harnessID string) (protocol.HarnessProfile, bool) {
	for _, profile := range harnesses {
		if profile.ID == harnessID {
			return profile, true
		}
	}
	return protocol.HarnessProfile{}, false
}

// screenedHubDetail bounds a connectivity error message and replaces it wholesale when it looks
// secret-like, so a token embedded in a dialed URL can never reach the report.
func screenedHubDetail(detail string) string {
	bounded := truncateAtRuneBoundary(detail, hubDetailMaximumBytes)
	if protocol.LooksSecretLike(bounded) {
		return hubConnectivityGenericDetail
	}
	return bounded
}

// sanitizeEndpointForDisplay strips userinfo, query string, and fragment from a control endpoint
// before it is ever stored in a report or printed, in both JSON and human output: an operator can
// legitimately embed a credential in a URL's userinfo or query string, and doctor must never
// become the thing that echoes it back. Dialing still uses the original, unsanitized endpoint
// (only the host and port participate in a TCP dial, and neither is removed here); only display
// is sanitized.
func sanitizeEndpointForDisplay(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return value
	}
	addedScheme := !strings.Contains(value, "://")
	parseable := value
	if addedScheme {
		parseable = "https://" + value
	}
	parsed, err := url.Parse(parseable)
	if err != nil || parsed.Host == "" {
		return hubEndpointInvalidDisplay
	}
	parsed.User = nil
	parsed.RawQuery = ""
	parsed.Fragment = ""
	parsed.RawFragment = ""
	sanitized := parsed.String()
	if addedScheme {
		sanitized = strings.TrimPrefix(sanitized, "https://")
	}
	return sanitized
}
