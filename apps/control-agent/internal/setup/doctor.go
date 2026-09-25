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

// ComponentDoctorEntry reports one manifest component's status on this node. Component is the same
// shared identity the plan and the ownership ledger use, so doctor cannot describe a component in
// terms the rest of setup would not recognize.
type ComponentDoctorEntry struct {
	Component          ComponentRef  `json:"component"`
	HarnessID          string        `json:"harnessId"`
	HarnessInstalled   bool          `json:"harnessInstalled"`   // from the discovered harness profile's Available flag, passed in
	ComponentInstalled bool          `json:"componentInstalled"` // ownership ledger has a matching-digest record at this platform's target path
	ComponentPath      string        `json:"componentPath,omitempty"`
	AuthReadiness      AuthReadiness `json:"authReadiness"`
	// ACPLaunchReady is meaningful only for an ACP adapter: it is the conjunction of a discovered
	// harness, a verified installed adapter, and ready authentication. A harness component is never
	// reported as ACP-launch-ready, because it is not the thing that speaks ACP.
	ACPLaunchReady bool     `json:"acpLaunchReady"`
	Notes          []string `json:"notes,omitempty"` // bounded, non-secret human-readable gaps, e.g. "no platform distribution for linux-arm64"
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
	Platform         string                 `json:"platform"`
	DataRoot         string                 `json:"dataRoot"`
	Components       []ComponentDoctorEntry `json:"components"`
	HubConnectivity  HubConnectivity        `json:"hubConnectivity"`
	ProjectReadiness string                 `json:"projectReadiness"`
	// ApprovalPolicies is the effective approval policy per harness that the given configuration
	// would run under; the doctor command fills it in from its --approval-policy setting.
	ApprovalPolicies map[string]string `json:"approvalPolicies,omitempty"`
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
// and trusted as "this harness is installed" — never a command or path named by the component
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
		Components:       make([]ComponentDoctorEntry, 0, len(manifest.Components)),
		ProjectReadiness: ProjectReadinessNotAvailable,
	}
	for index := range manifest.Components {
		entry := manifest.Components[index]
		harnessProfile, discovered := findHarnessProfile(harnesses, entry.HarnessID)
		doctorEntry := ComponentDoctorEntry{
			Component:        entry.Ref(),
			HarnessID:        entry.HarnessID,
			HarnessInstalled: discovered && harnessProfile.Available,
			AuthReadiness:    AuthReadinessUnknown,
		}
		distribution, supported := entry.Platforms[platform]
		if !supported {
			// A component with no distribution for this platform stays visible in the report with a
			// note; silently dropping it would hide unsupported-platform gaps the operator asked
			// doctor to surface.
			doctorEntry.Notes = append(doctorEntry.Notes, "no platform distribution for "+platform)
			report.Components = append(report.Components, doctorEntry)
			continue
		}
		targetPath, err := ComponentTargetPath(dataRoot, entry, distribution)
		if err != nil {
			// A kind with no install location is reported as a gap rather than guessed at; the note
			// names only the kind, which is a closed vocabulary value, never manifest free text.
			doctorEntry.Notes = append(doctorEntry.Notes, "no install location for component kind "+string(entry.Kind))
			report.Components = append(report.Components, doctorEntry)
			continue
		}
		doctorEntry.ComponentPath = targetPath
		// Installed means the ledger record still matches the file on disk — a stale ledger entry
		// over a deleted or corrupted file must not report as installed. observeCurrentState makes
		// exactly that distinction, and anything ambiguous classifies as not installed.
		doctorEntry.ComponentInstalled = observeCurrentState(targetPath, ledger) == ExpectedOwnedMatch
		if spec, allowed := AuthProbeAllowlist[entry.HarnessID]; allowed && doctorEntry.HarnessInstalled {
			doctorEntry.AuthReadiness = RunAuthProbe(ctx, harnessProfile.Binary, spec.Arguments, spec.SuccessExitCode)
		}
		doctorEntry.ACPLaunchReady = entry.Kind == ComponentKindACPAdapter &&
			doctorEntry.HarnessInstalled &&
			doctorEntry.ComponentInstalled &&
			doctorEntry.AuthReadiness == AuthReadinessReady
		report.Components = append(report.Components, doctorEntry)
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
