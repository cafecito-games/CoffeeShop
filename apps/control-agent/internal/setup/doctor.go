package setup

import (
	"context"
	"errors"
	"net/url"
	"slices"
	"strings"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

// hubDetailMaximumBytes bounds each human-readable hub connectivity detail.
const hubDetailMaximumBytes = 256

// hubConnectivityGenericDetail replaces any connectivity error message that looks secret-like — a
// URL can carry a query-string token, and net errors embed the dialed address verbatim.
const hubConnectivityGenericDetail = "connection attempt failed"

// activationRejectionMaximumBytes bounds the activation rejection detail doctor reports. A strict
// decoder's own message can quote a field name taken straight from the file, which is untrusted
// input, so the detail is bounded and secret-screened exactly like a hub connectivity detail.
const activationRejectionMaximumBytes = 512

// activationRejectionGenericDetail replaces an activation rejection message that looks secret-like.
const activationRejectionGenericDetail = "the activation ledger could not be parsed"

// ActivationRepairGuidance is the fixed repair doctor prints for an activation ledger it could not
// accept. Barista never repairs the file itself: it is the only record of which managed version an
// administrator selected, and rewriting it automatically would silently choose for them.
const ActivationRepairGuidance = "Barista left the file unchanged and will launch no managed component: inspect activation.json under the data root, remove it, and re-run `barista setup activate` for each managed component."

// hubEndpointInvalidDisplay is shown in place of a control endpoint this doctor could not parse
// well enough to sanitize; an endpoint that cannot be sanitized is never echoed verbatim instead.
const hubEndpointInvalidDisplay = "invalid control endpoint"

// ComponentProvenance is the closed vocabulary of where this node would obtain one component. It is
// reported, never inferred from a path or a version ordering.
type ComponentProvenance string

const (
	// ComponentProvenanceManaged is a Barista-owned installed version the activation record selects.
	ComponentProvenanceManaged ComponentProvenance = "managed"
	// ComponentProvenanceExternal is an installation outside Barista ownership — for a harness
	// component, the PATH-discovered binary that keeps working exactly as it did before activation
	// existed.
	ComponentProvenanceExternal ComponentProvenance = "external"
	// ComponentProvenanceNone is neither a selected managed version nor an external installation.
	ComponentProvenanceNone ComponentProvenance = "none"
	// ComponentProvenanceRejected is an activation ledger that could not be accepted, so no
	// provenance can be established at all. It is deliberately distinct from "none": a rejected file
	// is never reported as an absent selection.
	ComponentProvenanceRejected ComponentProvenance = "rejected"
)

// ComponentProvenances is the single enumeration of every provenance value.
var ComponentProvenances = []ComponentProvenance{
	ComponentProvenanceManaged,
	ComponentProvenanceExternal,
	ComponentProvenanceNone,
	ComponentProvenanceRejected,
}

// Valid reports whether provenance is in the closed vocabulary.
func (provenance ComponentProvenance) Valid() bool {
	return slices.Contains(ComponentProvenances, provenance)
}

// ActivationLedgerStatus reports the activation ledger's own state so an operator can tell an
// absent selection from an unreadable file.
type ActivationLedgerStatus struct {
	// Generation is the generation the file declared, "" when no file exists yet.
	Generation string `json:"generation"`
	Accepted   bool   `json:"accepted"`
	// Rejection is the bounded, secret-screened reason the file was not accepted.
	Rejection string `json:"rejection,omitempty"`
	// Repair is ActivationRepairGuidance when the file was not accepted.
	Repair string `json:"repair,omitempty"`
}

// ComponentDoctorEntry reports one manifest component's status on this node. Component is the same
// shared identity the plan and the ownership ledger use, so doctor cannot describe a component in
// terms the rest of setup would not recognize.
type ComponentDoctorEntry struct {
	Component        ComponentRef `json:"component"`
	HarnessID        string       `json:"harnessId"`
	HarnessInstalled bool         `json:"harnessInstalled"` // from the discovered harness profile's Available flag, passed in
	// HarnessApplicable reports whether HarnessInstalled is a meaningful question for this component's
	// kind. A capability pack is harness-agnostic: it has no provider CLI of its own, so its
	// HarnessInstalled is false and that false is *not* a gap. Presentation must read this field
	// before it renders HarnessInstalled, or it will show an operator a missing harness to chase that
	// was never supposed to exist.
	HarnessApplicable  bool          `json:"harnessApplicable"`
	ComponentInstalled bool          `json:"componentInstalled"` // ownership ledger has a matching-digest record at this platform's target path
	ComponentPath      string        `json:"componentPath,omitempty"`
	AuthReadiness      AuthReadiness `json:"authReadiness"`
	// ACPLaunchReady is meaningful only for an ACP adapter: it is the conjunction of a discovered
	// harness, a verified installed adapter, and ready authentication. A harness component is never
	// reported as ACP-launch-ready, because it is not the thing that speaks ACP.
	ACPLaunchReady bool `json:"acpLaunchReady"`
	// ActiveVersion is the version the activation record selects for this component's identity, ""
	// when nothing is selected. It is never inferred from the installed set.
	ActiveVersion string `json:"activeVersion,omitempty"`
	// RollbackVersion is the retained previously verified version a rollback would return to, ""
	// when none is retained.
	RollbackVersion string `json:"rollbackVersion,omitempty"`
	// Provenance is how this node would obtain the component; see ComponentProvenance.
	Provenance ComponentProvenance `json:"provenance"`
	Notes      []string            `json:"notes,omitempty"` // bounded, non-secret human-readable gaps, e.g. "no platform distribution for linux-arm64"
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
	// Activation reports the activation ledger's own generation and acceptance.
	Activation ActivationLedgerStatus `json:"activation"`
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
	activation ActivationState,
	harnesses []protocol.HarnessProfile,
	controlEndpoint string,
	dial func(ctx context.Context, endpoint string) error,
) Report {
	report := Report{
		Platform:         platform,
		DataRoot:         dataRoot,
		Components:       make([]ComponentDoctorEntry, 0, len(manifest.Components)),
		ProjectReadiness: ProjectReadinessNotAvailable,
		Activation:       activationStatus(activation),
	}
	for index := range manifest.Components {
		entry := manifest.Components[index]
		harnessProfile, discovered := findHarnessProfile(harnesses, entry.HarnessID)
		doctorEntry := ComponentDoctorEntry{
			Component:        entry.Ref(),
			HarnessID:        entry.HarnessID,
			HarnessInstalled: discovered && harnessProfile.Available,
			// A kind with no harness of its own never claims one is installed, and says so explicitly
			// rather than leaving a false to be read as a missing dependency.
			HarnessApplicable: entry.Kind.HasHarnessOfItsOwn(),
			AuthReadiness:     AuthReadinessUnknown,
			Provenance:        ComponentProvenanceNone,
		}
		if !doctorEntry.HarnessApplicable {
			doctorEntry.HarnessInstalled = false
		}
		// The activated version is resolved through the one launch-resolution path, so doctor can
		// never report a provenance the daemon would not act on. The resolution is read-only.
		activeInstalled, activeErr := ActiveInstalledComponent(dataRoot, manifest, platform, ledger, activation, entry.Ref().Identity())
		describeActivation(&doctorEntry, activation, activeErr, doctorEntry.HarnessInstalled)
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
		if doctorEntry.ComponentInstalled && doctorEntry.ActiveVersion == "" && activation.Rejection == nil {
			// Installation and activation are separate operations, so an installed-but-unselected
			// version is a reportable gap rather than a silent one.
			doctorEntry.Notes = append(doctorEntry.Notes, "installed but not activated; run `barista setup activate`")
		}
		if spec, allowed := AuthProbeAllowlist[entry.HarnessID]; allowed && doctorEntry.HarnessInstalled {
			doctorEntry.AuthReadiness = RunAuthProbe(ctx, harnessProfile.Binary, spec.Arguments, spec.SuccessExitCode)
		}
		// ACP launch readiness is exactly the conjunction of the three inputs the adapter launch path
		// itself requires: a discovered harness, an activated adapter version that re-verifies right
		// now (activeErr == nil, which is what acpadapter.Load resolves), and ready authentication. It
		// deliberately does not require the *manifest-pinned* version to be the activated one: a
		// retained version the manifest no longer declares still launches, so reporting it as
		// not-ready would contradict the daemon.
		doctorEntry.ACPLaunchReady = entry.Kind == ComponentKindACPAdapter &&
			doctorEntry.HarnessInstalled &&
			activeErr == nil &&
			doctorEntry.AuthReadiness == AuthReadinessReady
		if activeErr == nil && activeInstalled.Ref().Version != entry.Version {
			doctorEntry.Notes = append(doctorEntry.Notes,
				"the active version is retained from an earlier manifest and is no longer declared by this one")
		}
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

// activationStatus projects the loaded activation evidence onto the report, bounding and screening
// the rejection reason: a strict decoder quotes an unknown field name from the file itself, which is
// untrusted input.
func activationStatus(activation ActivationState) ActivationLedgerStatus {
	status := ActivationLedgerStatus{Generation: activation.Generation, Accepted: activation.Rejection == nil}
	if activation.Rejection == nil {
		return status
	}
	status.Rejection = screenedActivationDetail(activation.Rejection.Error())
	status.Repair = ActivationRepairGuidance
	var rejection *ActivationRejectionError
	if errors.As(activation.Rejection, &rejection) {
		status.Generation = rejection.SourceGeneration
	}
	return status
}

// screenedActivationDetail bounds an activation diagnostic and replaces it wholesale when it looks
// secret-like. A strict decoder's own message quotes an unknown field name straight from the file,
// which is untrusted input, so no activation diagnostic reaches a report unscreened.
func screenedActivationDetail(detail string) string {
	bounded := truncateAtRuneBoundary(detail, activationRejectionMaximumBytes)
	if protocol.LooksSecretLike(bounded) {
		return activationRejectionGenericDetail
	}
	return bounded
}

// describeActivation fills one entry's active version, retained rollback target, and provenance.
// Provenance is what would actually launch, not merely what the record claims: a selection whose
// bytes no longer resolve is reported as the fallback the daemon would really take, with a note, so
// doctor and the daemon can never disagree about which executable runs. A rejected ledger reports no
// versions and the rejected provenance — an unreadable selection is never reported as an absent one,
// and never as the external fallback.
func describeActivation(entry *ComponentDoctorEntry, activation ActivationState, activeErr error, harnessAvailable bool) {
	if activation.Rejection != nil {
		entry.Provenance = ComponentProvenanceRejected
		return
	}
	record, activated := activation.Ledger.RecordFor(entry.Component.Identity())
	if activated {
		entry.ActiveVersion = record.Active.Component.Version
		if record.Previous != nil {
			entry.RollbackVersion = record.Previous.Component.Version
		}
		if activeErr == nil {
			entry.Provenance = ComponentProvenanceManaged
			return
		}
		entry.Notes = append(entry.Notes, "the activated version could not be verified: "+screenedActivationDetail(activeErr.Error()))
		// The managed selection is not honored. A harness keeps its documented external PATH
		// compatibility path, which is why the demotion is reported rather than hidden; an adapter has
		// no external path at all.
		if entry.Component.Kind == ComponentKindHarness && harnessAvailable {
			entry.Provenance = ComponentProvenanceExternal
			return
		}
		entry.Provenance = ComponentProvenanceNone
		return
	}
	// With nothing selected, a harness component falls back to the documented external PATH
	// compatibility path; an adapter has no external path at all.
	if entry.Component.Kind == ComponentKindHarness && harnessAvailable {
		entry.Provenance = ComponentProvenanceExternal
		return
	}
	entry.Provenance = ComponentProvenanceNone
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
