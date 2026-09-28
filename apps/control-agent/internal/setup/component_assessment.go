package setup

import (
	"context"
	"errors"
	"slices"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

// ComponentAssessment is the one path-aware local interpretation of component evidence. Doctor
// may display its local fields; the control-plane projection deliberately selects only the bounded
// semantic fields and fixed diagnostic codes.
type ComponentAssessment struct {
	Component          ComponentRef
	HarnessID          string
	HarnessInstalled   bool
	HarnessApplicable  bool
	ComponentInstalled bool
	ComponentPath      string
	AuthReadiness      AuthReadiness
	ACPLaunchReady     bool
	InstalledVersions  []string
	ActiveVersion      string
	RollbackVersion    string
	Provenance         ComponentProvenance
	Readiness          string
	UpdateVersion      string
	RollbackAvailable  bool
	DiagnosticCodes    []string
	Notes              []string
}

// ComponentAssessmentOptions carries runtime evidence that lives above setup's package boundary.
// In particular, capability-pack archive parsing imports setup and therefore cannot be called from
// this package without a cycle; the daemon and doctor pass the result of their shared resolver back
// here so the one assessment cannot claim an archive is active when runtime rejected its contents.
type ComponentAssessmentOptions struct {
	CapabilityPackResolutionKnown bool
	ResolvedCapabilityPack        *ComponentRef
	ACPStartupEvidenceKnown       bool
}

func appendCode(assessment *ComponentAssessment, code string) {
	if !slices.Contains(assessment.DiagnosticCodes, code) {
		assessment.DiagnosticCodes = append(assessment.DiagnosticCodes, code)
	}
}

// AssessComponents reads, verifies, and classifies all manifest components without mutating local
// state. Its output is deterministic by component key, installed version, and diagnostic code.
func AssessComponents(ctx context.Context, manifest Manifest, ledger OwnershipLedger, dataRoot, platform string, activation ActivationState, harnesses []protocol.HarnessProfile, supplied ...ComponentAssessmentOptions) []ComponentAssessment {
	options := ComponentAssessmentOptions{}
	if len(supplied) > 0 {
		options = supplied[0]
	}
	assessments := make([]ComponentAssessment, 0, len(manifest.Components))
	for _, entry := range manifest.Components {
		profile, discovered := findHarnessProfile(harnesses, entry.HarnessID)
		assessment := ComponentAssessment{
			Component: entry.Ref(), HarnessID: entry.HarnessID,
			HarnessApplicable: entry.Kind.HasHarnessOfItsOwn(), AuthReadiness: AuthReadinessUnknown,
			Provenance: ComponentProvenanceNone, Readiness: "unavailable",
		}
		assessment.HarnessInstalled = assessment.HarnessApplicable && discovered && profile.Available
		activeInstalled, activeErr := ActiveInstalledComponent(dataRoot, manifest, platform, ledger, activation, entry.Ref().Identity())
		if entry.Kind == ComponentKindACPAdapter && options.ACPStartupEvidenceKnown && activeErr == nil &&
			!slices.Contains(profile.Transports, protocol.TransportACP) {
			activeErr = errors.New("the selected ACP adapter did not pass the daemon startup probe")
		}
		if entry.Kind == ComponentKindCapabilityPack && options.CapabilityPackResolutionKnown && activeErr == nil &&
			(options.ResolvedCapabilityPack == nil || *options.ResolvedCapabilityPack != activeInstalled.Ref()) {
			activeErr = errors.New("the selected capability pack was rejected by runtime validation")
		}
		doctorEntry := ComponentDoctorEntry{Component: entry.Ref(), Provenance: ComponentProvenanceNone}
		describeActivation(&doctorEntry, activation, activeErr, assessment.HarnessInstalled)
		assessment.ActiveVersion, assessment.RollbackVersion, assessment.Provenance = doctorEntry.ActiveVersion, doctorEntry.RollbackVersion, doctorEntry.Provenance
		assessment.Notes = append(assessment.Notes, doctorEntry.Notes...)
		if entry.Kind == ComponentKindCapabilityPack && activation.Rejection == nil && assessment.ActiveVersion != "" && activeErr != nil {
			appendCode(&assessment, "active-unverified")
		}

		// The ownership ledger is the only authority for retained installed versions. Enumerate every
		// version it names for this exact component identity, then pass each one through the same
		// containment/type/digest verifier used by activation. A directory scan, lexical newest-wins
		// rule, or ledger claim on its own is never sufficient evidence.
		refs := []ComponentRef{entry.Ref()}
		for _, owned := range ledger.Records {
			if owned.Component.Identity() == entry.Ref().Identity() {
				refs = append(refs, owned.Component)
			}
		}
		if record, ok := activation.Ledger.RecordFor(entry.Ref().Identity()); ok {
			refs = append(refs, record.Active.Component)
			if record.Previous != nil {
				refs = append(refs, record.Previous.Component)
			}
		}
		for _, ref := range refs {
			if slices.Contains(assessment.InstalledVersions, ref.Version) {
				continue
			}
			if _, err := resolveInstalledVersion(dataRoot, manifest, platform, ledger, ref); err == nil {
				assessment.InstalledVersions = append(assessment.InstalledVersions, ref.Version)
			}
		}
		slices.Sort(assessment.InstalledVersions)
		assessment.ComponentInstalled = slices.Contains(assessment.InstalledVersions, entry.Version)
		assessment.RollbackAvailable = assessment.RollbackVersion != "" && slices.Contains(assessment.InstalledVersions, assessment.RollbackVersion)
		if assessment.ActiveVersion != "" && assessment.ActiveVersion != entry.Version && assessment.ComponentInstalled {
			assessment.UpdateVersion = entry.Version
			appendCode(&assessment, "update-available")
		}
		if assessment.RollbackAvailable {
			appendCode(&assessment, "rollback-available")
		}

		distribution, supported := entry.Platforms[platform]
		if !supported {
			assessment.Notes = append(assessment.Notes, "no platform distribution for "+platform)
			appendCode(&assessment, "platform-unsupported")
		} else if target, err := ComponentTargetPath(dataRoot, entry, distribution); err == nil {
			assessment.ComponentPath = target
		} else {
			assessment.Notes = append(assessment.Notes, "no install location for component kind "+string(entry.Kind))
		}
		if assessment.ComponentInstalled && assessment.ActiveVersion == "" && activation.Rejection == nil {
			assessment.Notes = append(assessment.Notes, "installed but not activated; run `barista setup activate`")
		}
		if spec, allowed := AuthProbeAllowlist[entry.HarnessID]; allowed && assessment.HarnessInstalled {
			assessment.AuthReadiness = RunAuthProbe(ctx, profile.Binary, spec.Arguments, spec.SuccessExitCode)
		}
		assessment.ACPLaunchReady = entry.Kind == ComponentKindACPAdapter && assessment.HarnessInstalled && activeErr == nil && assessment.AuthReadiness == AuthReadinessReady
		if activeErr == nil && activeInstalled.Ref().Version != entry.Version {
			assessment.Notes = append(assessment.Notes, "the active version is retained from an earlier manifest and is no longer declared by this one")
		}

		switch {
		case entry.Kind == ComponentKindCapabilityPack:
			// A capability pack is not executable, even when its selection ledger is rejected. Its
			// executable-readiness dimension therefore remains not-applicable; provenance and the fixed
			// activation-rejected code carry the rejected authority state without making the wire report
			// internally contradictory.
			assessment.Readiness = "not-applicable"
			if activation.Rejection != nil {
				appendCode(&assessment, "activation-rejected")
			}
		case activation.Rejection != nil:
			assessment.Readiness = "rejected"
			appendCode(&assessment, "activation-rejected")
		case assessment.ActiveVersion == "":
			if assessment.Provenance == ComponentProvenanceExternal && assessment.HarnessInstalled {
				assessment.Readiness = authComponentReadiness(assessment.AuthReadiness)
			} else if assessment.ComponentInstalled {
				assessment.Readiness = "inactive"
				appendCode(&assessment, "not-activated")
			} else {
				assessment.Readiness = "unavailable"
			}
		case activeErr != nil:
			assessment.Readiness = "unhealthy"
			appendCode(&assessment, "active-unverified")
		case !assessment.HarnessInstalled:
			assessment.Readiness = "unavailable"
			appendCode(&assessment, "harness-unavailable")
		default:
			assessment.Readiness = authComponentReadiness(assessment.AuthReadiness)
		}
		if assessment.HarnessApplicable && assessment.HarnessInstalled {
			switch assessment.AuthReadiness {
			case AuthReadinessNotReady:
				appendCode(&assessment, "auth-unhealthy")
			case AuthReadinessUnknown:
				appendCode(&assessment, "auth-unavailable")
			}
		}
		slices.Sort(assessment.DiagnosticCodes)
		assessments = append(assessments, assessment)
	}
	slices.SortFunc(assessments, func(a, b ComponentAssessment) int {
		if a.Component.Kind != b.Component.Kind {
			return stringsCompare(string(a.Component.Kind), string(b.Component.Kind))
		}
		return stringsCompare(a.Component.ID, b.Component.ID)
	})
	return assessments
}

func stringsCompare(a, b string) int {
	if a < b {
		return -1
	}
	if a > b {
		return 1
	}
	return 0
}

func authComponentReadiness(readiness AuthReadiness) string {
	switch readiness {
	case AuthReadinessReady:
		return "ready"
	case AuthReadinessNotReady:
		return "unhealthy"
	default:
		return "unavailable"
	}
}

// ComponentInventoryReport projects an assessment onto the path-free control-plane contract.
func ComponentInventoryReport(nodeID, observedAt string, assessments []ComponentAssessment) protocol.ComponentInventoryReport {
	components := make([]protocol.ComponentInventoryEntry, 0, len(assessments))
	for _, assessment := range assessments {
		entry := protocol.ComponentInventoryEntry{
			Kind: string(assessment.Component.Kind), ID: assessment.Component.ID,
			DeclaredVersion:   assessment.Component.Version,
			InstalledVersions: append([]string{}, assessment.InstalledVersions...),
			ActiveVersion:     assessment.ActiveVersion, RollbackVersion: assessment.RollbackVersion,
			Provenance: string(assessment.Provenance), Readiness: assessment.Readiness,
			UpdateVersion: assessment.UpdateVersion, RollbackAvailable: assessment.RollbackAvailable,
			DiagnosticCodes: append([]string{}, assessment.DiagnosticCodes...),
		}
		if assessment.Component.Kind != ComponentKindCapabilityPack {
			entry.HarnessID = assessment.HarnessID
		}
		components = append(components, entry)
	}
	return protocol.ComponentInventoryReport{NodeID: nodeID, ObservedAt: observedAt, Components: components}
}
