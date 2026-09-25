package setup

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

// activationLedgerFilename is the activation ledger's fixed location under the data root. It is a
// separate file from ownership.json on purpose: the ownership ledger answers what Barista owns and
// what each owned file's digest is, and this file answers only which owned version is selected for
// launch. Neither restates the other.
const activationLedgerFilename = "activation.json"

const (
	// ActivationLedgerVersion is the current activation ledger schema generation. Save always
	// writes this generation, and an input file declaring anything else is rejected rather than
	// migrated or defaulted.
	ActivationLedgerVersion = "1"
	// ActivationLedgerGenerationAbsent is reported for a data root with no activation file yet.
	ActivationLedgerGenerationAbsent = ""
)

// ErrComponentNotActivated reports that no activation record selects a version of a component. It
// is the ordinary state of a node where a component was installed but never activated, and it is
// deliberately distinct from "installed and selected but no longer verifiable": an absent selection
// must never be inferred from version directories, ownership-ledger order, or the highest installed
// version.
var ErrComponentNotActivated = errors.New("component has no active version")

// ComponentIdentity is the activation ledger's key: the part of a ComponentRef that is stable
// across versions. It is derived from ComponentRef rather than stored beside it, so the ledger
// cannot disagree with the one component identity the manifest, the plan, and the ownership ledger
// all use. Exactly one record may exist per identity; two would be an ambiguous selection.
type ComponentIdentity struct {
	Kind ComponentKind
	ID   string
}

// Identity is the version-independent identity of a component reference.
func (ref ComponentRef) Identity() ComponentIdentity {
	return ComponentIdentity{Kind: ref.Kind, ID: ref.ID}
}

// Validate enforces the same closed vocabulary and grammar ComponentRef.Validate applies to the
// fields an identity carries. An empty field is a rejection, never a wildcard.
func (identity ComponentIdentity) Validate() error {
	// ComponentRef.Validate is the single grammar definition; a placeholder version keeps this from
	// becoming a second, drifting copy of the kind and id rules.
	ref := ComponentRef{Kind: identity.Kind, ID: identity.ID, Version: "0"}
	if err := ref.Validate(); err != nil {
		return err
	}
	return nil
}

// String is the stable human and log form, "<kind>/<id>", built only from already-validated closed
// vocabulary and kebab-case fields.
func (identity ComponentIdentity) String() string {
	return string(identity.Kind) + "/" + identity.ID
}

// Identity is the selector's component identity, which is what the activation ledger is keyed by.
func (selector ComponentSelector) Identity() ComponentIdentity {
	return ComponentIdentity{Kind: selector.Kind, ID: selector.ID}
}

// ActivationTarget is one selected component version: the full identity triple, the deterministic
// install location it must occupy, and the digest recorded for it when the selection was made.
// Identity and digest are bound together — a digest without an identity, or an identity without a
// digest, is a rejected record — so a selection can never be satisfied by different bytes than the
// ones that were verified.
type ActivationTarget struct {
	Component     ComponentRef `json:"component"`
	Path          string       `json:"path"`
	ContentSHA256 string       `json:"contentSha256"`
}

// ActivationRecord is the authoritative selection for one component identity: the version Barista
// launches, and the previously verified version rollback may return to. Previous is absent on a
// first activation and after a rollback has consumed it.
type ActivationRecord struct {
	Active   ActivationTarget  `json:"active"`
	Previous *ActivationTarget `json:"previous,omitempty"`
}

// Identity is the record's key, derived from the active version's own identity triple.
func (record ActivationRecord) Identity() ComponentIdentity {
	return record.Active.Component.Identity()
}

// ActivationLedger is the durable set of activation records under one data root, persisted as JSON
// at <dataRoot>/activation.json.
type ActivationLedger struct {
	LedgerVersion string             `json:"ledgerVersion"`
	Records       []ActivationRecord `json:"records"`
}

// ActivationRejectionError reports that an activation ledger could not be accepted. It is
// deliberately a sibling of LedgerRejectionError rather than a reuse of it — the two name different
// files and different repairs, and an operator told to repair "the ownership ledger" when
// activation.json is the corrupt file would edit the wrong thing — but it carries exactly the same
// shape, including the rejected generation and the shared LedgerRecordRejection, so a corrupt
// current-generation file is never reported as a failed migration. Every rejection names a record
// index and a fixed structural reason, never a field value: the file may have been edited by hand
// into something attacker-influenced and the message must not become an echo of it.
type ActivationRejectionError struct {
	SourceGeneration string
	Rejections       []LedgerRecordRejection
}

func (err *ActivationRejectionError) Error() string {
	reasons := make([]string, 0, len(err.Rejections))
	for _, rejection := range err.Rejections {
		reasons = append(reasons, fmt.Sprintf("record %d: %s", rejection.RecordIndex, rejection.Reason))
	}
	return fmt.Sprintf("activation ledger generation %s cannot be accepted", err.SourceGeneration) +
		"; it was left unchanged and no component is treated as activated: " + strings.Join(reasons, "; ")
}

// activationDocument is the wire shape of an activation ledger file.
type activationDocument struct {
	LedgerVersion string                     `json:"ledgerVersion"`
	Records       []activationRecordDocument `json:"records"`
}

type activationRecordDocument struct {
	Active   *activationTargetDocument `json:"active"`
	Previous *activationTargetDocument `json:"previous,omitempty"`
}

type activationTargetDocument struct {
	Component     *ComponentRef `json:"component"`
	Path          string        `json:"path"`
	ContentSHA256 string        `json:"contentSha256"`
}

// ParseActivationLedger strictly decodes activation ledger bytes: unknown fields, trailing data, an
// unknown generation, a record missing either half of the identity/digest binding, a path that is
// not absolute and already-clean, a digest that is not a SHA-256, and two records for one component
// identity are all rejected before any component is treated as activated. Containment inside the
// data root is deliberately not enforced here, for the same reason validateRecordPathGrammar gives:
// a record naming a foreign path must stay loadable so doctor can report it, and every launch-side
// lookup re-derives the path through ComponentTargetPath and compares literally, so a foreign path
// can never be matched or followed.
func ParseActivationLedger(data []byte) (ActivationLedger, string, error) {
	var document activationDocument
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&document); err != nil {
		return ActivationLedger{}, "", fmt.Errorf("decode activation ledger: %w", err)
	}
	if decoder.More() {
		return ActivationLedger{}, "", errors.New("decode activation ledger: trailing data after the ledger object")
	}
	if document.LedgerVersion != ActivationLedgerVersion {
		return ActivationLedger{}, "", fmt.Errorf("activation ledger schema generation is unknown; only generation %q is supported", ActivationLedgerVersion)
	}
	rejections := []LedgerRecordRejection{}
	records := make([]ActivationRecord, 0, len(document.Records))
	seenIdentities := make(map[ComponentIdentity]bool, len(document.Records))
	for index, record := range document.Records {
		active, reason := record.Active.target()
		if reason != "" {
			rejections = append(rejections, LedgerRecordRejection{RecordIndex: index, Reason: "active " + reason})
			continue
		}
		var previous *ActivationTarget
		if record.Previous != nil {
			retained, previousReason := record.Previous.target()
			if previousReason != "" {
				rejections = append(rejections, LedgerRecordRejection{RecordIndex: index, Reason: "previous " + previousReason})
				continue
			}
			if retained.Component.Identity() != active.Component.Identity() {
				rejections = append(rejections, LedgerRecordRejection{RecordIndex: index, Reason: "previous names a different component identity than active"})
				continue
			}
			if retained.Component.Version == active.Component.Version {
				rejections = append(rejections, LedgerRecordRejection{RecordIndex: index, Reason: "previous names the same version as active"})
				continue
			}
			previous = &retained
		}
		if seenIdentities[active.Component.Identity()] {
			rejections = append(rejections, LedgerRecordRejection{RecordIndex: index, Reason: "duplicates an earlier record's component identity"})
			continue
		}
		seenIdentities[active.Component.Identity()] = true
		records = append(records, ActivationRecord{Active: active, Previous: previous})
	}
	if len(rejections) > 0 {
		return ActivationLedger{}, "", &ActivationRejectionError{SourceGeneration: ActivationLedgerVersion, Rejections: rejections}
	}
	return ActivationLedger{LedgerVersion: ActivationLedgerVersion, Records: records}, ActivationLedgerVersion, nil
}

// target validates one selection and returns it, or a fixed structural reason. The identity and the
// digest must both be present and well formed: either alone cannot establish that specific bytes
// were verified for a specific component version.
func (document *activationTargetDocument) target() (ActivationTarget, string) {
	if document == nil {
		return ActivationTarget{}, "selection is missing"
	}
	if document.Component == nil {
		return ActivationTarget{}, "selection has no component identity"
	}
	if err := document.Component.Validate(); err != nil {
		return ActivationTarget{}, "selection " + err.Error()
	}
	if reason := validateRecordPathGrammar(document.Path); reason != "" {
		return ActivationTarget{}, "selection " + reason
	}
	if !ChecksumPattern.MatchString(strings.ToLower(document.ContentSHA256)) {
		return ActivationTarget{}, "selection contentSha256 is not a sha256 digest"
	}
	return ActivationTarget{
		Component:     *document.Component,
		Path:          document.Path,
		ContentSHA256: strings.ToLower(document.ContentSHA256),
	}, ""
}

// LoadActivationLedgerGeneration reads the activation ledger at dataRoot, returning an empty
// current-generation ledger (not an error) when the file does not yet exist, together with the
// generation the file declared ("" when absent). Reading never writes and never repairs.
func LoadActivationLedgerGeneration(dataRoot string) (ActivationLedger, string, error) {
	data, err := os.ReadFile(filepath.Join(dataRoot, activationLedgerFilename))
	if errors.Is(err, fs.ErrNotExist) {
		return ActivationLedger{LedgerVersion: ActivationLedgerVersion}, ActivationLedgerGenerationAbsent, nil
	}
	if err != nil {
		return ActivationLedger{}, "", fmt.Errorf("read activation ledger: %w", err)
	}
	return ParseActivationLedger(data)
}

// ActivationState is the loaded activation evidence every consumer reads: the parsed ledger, the
// generation it was stored in, and the reason it could not be accepted. A rejected file is never
// downgraded to "absent" — Rejection being non-nil means every managed component is unavailable
// with that reason, which is a different verdict from an empty ledger.
type ActivationState struct {
	Ledger     ActivationLedger
	Generation string
	Rejection  error
}

// LoadActivationState loads the activation ledger at dataRoot without ever failing the caller: a
// rejection is carried in the state so doctor can report it and every launch path can refuse with
// it, rather than one caller treating an unreadable file as an empty one.
func LoadActivationState(dataRoot string) ActivationState {
	ledger, generation, err := LoadActivationLedgerGeneration(dataRoot)
	if err != nil {
		return ActivationState{Generation: generation, Rejection: err}
	}
	return ActivationState{Ledger: ledger, Generation: generation}
}

// Fingerprint is a stable digest of the activation evidence, used by the daemon to notice that the
// file changed after startup. It covers the rejection reason too, so a file that became corrupt
// after startup is also a change.
func (state ActivationState) Fingerprint() string {
	rejection := ""
	if state.Rejection != nil {
		rejection = state.Rejection.Error()
	}
	encoded, err := json.Marshal(struct {
		Generation string           `json:"generation"`
		Rejection  string           `json:"rejection"`
		Ledger     ActivationLedger `json:"ledger"`
	}{Generation: state.Generation, Rejection: rejection, Ledger: state.Ledger})
	if err != nil {
		return ""
	}
	summed := sha256.Sum256(encoded)
	return hex.EncodeToString(summed[:])
}

// RecordFor returns the activation record for one component identity and whether one exists.
// Identity is the ledger's primary key and parsing rejects a duplicate, so this lookup has no
// precedence question to resolve and never lets a first or last record win.
func (ledger ActivationLedger) RecordFor(identity ComponentIdentity) (ActivationRecord, bool) {
	for _, record := range ledger.Records {
		if record.Identity() == identity {
			return record, true
		}
	}
	return ActivationRecord{}, false
}

// WithRecord returns a copy of the ledger with record added or replacing the existing record for
// the same component identity.
func (ledger ActivationLedger) WithRecord(record ActivationRecord) ActivationLedger {
	updated := ActivationLedger{
		LedgerVersion: ActivationLedgerVersion,
		Records:       make([]ActivationRecord, 0, len(ledger.Records)+1),
	}
	replaced := false
	for _, existing := range ledger.Records {
		switch {
		case existing.Identity() == record.Identity() && !replaced:
			updated.Records = append(updated.Records, record)
			replaced = true
		case existing.Identity() == record.Identity():
			// A duplicate entry for one identity collapses into the new record; parsing rejects a
			// file that contains one, so this can only be reached on an in-memory ledger.
		default:
			updated.Records = append(updated.Records, existing)
		}
	}
	if !replaced {
		updated.Records = append(updated.Records, record)
	}
	return updated
}

// Save writes the activation ledger atomically in the current generation, using the durability
// pattern OwnershipLedger.Save proves: encode, write a temporary file in the data root, fsync,
// rename over the destination, then best-effort directory sync. A crash mid-write leaves the
// previous record intact and parseable; a crash before the rename leaves only a removable temp
// file, never a second authoritative selection. Symlink selection is deliberately not used:
// InstalledComponent.Verify and recordIsSafelyRemovable both reject symlinks outright, and a
// symlink pointer would not be portable to Windows.
func (ledger ActivationLedger) Save(dataRoot string) error {
	ledger.LedgerVersion = ActivationLedgerVersion
	if ledger.Records == nil {
		ledger.Records = []ActivationRecord{}
	}
	encoded, err := json.MarshalIndent(ledger, "", "  ")
	if err != nil {
		return fmt.Errorf("encode activation ledger: %w", err)
	}
	destination := filepath.Join(dataRoot, activationLedgerFilename)
	temporaryFile, err := os.CreateTemp(dataRoot, ".activation-*")
	if err != nil {
		return fmt.Errorf("create activation ledger temporary file: %w", err)
	}
	temporaryPath := temporaryFile.Name()
	if _, err := temporaryFile.Write(encoded); err != nil {
		temporaryFile.Close()
		os.Remove(temporaryPath)
		return fmt.Errorf("write activation ledger temporary file: %w", err)
	}
	if err := temporaryFile.Sync(); err != nil {
		temporaryFile.Close()
		os.Remove(temporaryPath)
		return fmt.Errorf("sync activation ledger temporary file: %w", err)
	}
	if err := temporaryFile.Close(); err != nil {
		os.Remove(temporaryPath)
		return fmt.Errorf("close activation ledger temporary file: %w", err)
	}
	if err := os.Rename(temporaryPath, destination); err != nil {
		os.Remove(temporaryPath)
		return fmt.Errorf("replace activation ledger: %w", err)
	}
	if directory, err := os.Open(dataRoot); err == nil {
		directory.Sync()
		directory.Close()
	}
	return nil
}

// ComponentProbe verifies that a candidate installed component answers its own startup contract
// before a selection of it becomes durable. It never installs, downloads, or repairs anything, and
// it must never surface raw child-process output to its caller.
type ComponentProbe func(ctx context.Context, installed InstalledComponent) error

// HarnessVersionProbeAllowlist maps a harness ID to the fixed, compiled-in command a managed
// harness candidate must answer before it can be activated. It exists for exactly the reason
// AuthProbeAllowlist does: the component manifest is operator-supplied through --manifest and has no
// field that can name a command, so extending activation to a new harness means adding an entry
// here in source and rebuilding Barista. A harness with no entry cannot be activated at all rather
// than being activated unprobed.
var HarnessVersionProbeAllowlist = map[string]AuthProbeSpec{
	"claude-cli": {Arguments: []string{"--version"}, SuccessExitCode: 0},
	"codex-cli":  {Arguments: []string{"--version"}, SuccessExitCode: 0},
}

// Fixed reasons ProbeHarnessVersion refuses a candidate. Each names a distinguishable input
// condition and nothing else: the error it is embedded in carries only the component identity, so a
// reason must never quote probe output, a path, or an operator argument. They are separate values
// rather than one generic reason because the fail-closed contract distinguishes them — an output
// that cannot be parsed is malformed, a probe that could not run at all is unknown, and neither is
// ever read as agreement.
const (
	// harnessVersionProbeUnansweredReason is a probe that ran and exited unsuccessfully.
	harnessVersionProbeUnansweredReason = "did not answer its version contract"
	// harnessVersionProbeUnknownReason is a probe that could not start, timed out, or produced
	// secret-like output. It is deliberately not reported as an unsuccessful answer.
	harnessVersionProbeUnknownReason = "could not be probed for its version contract"
	// harnessVersionProbeMalformedReason is a successful probe whose output carries no parsable
	// normalized version. It is deliberately not reported as "reports no version": a pinned version
	// that cannot be confirmed is not a pin.
	harnessVersionProbeMalformedReason = "reported no parsable version for its version contract"
	// harnessVersionProbeMismatchReason is a successful, parsable probe naming another version.
	harnessVersionProbeMismatchReason = "reported a version other than the one pinned for it"
)

// ProbeHarnessVersion runs the candidate harness executable's compiled-in --version contract, the
// same shape harness discovery already applies to an external binary, and refuses the candidate
// unless the version it reports for itself is exactly the version the manifest pinned. The
// executable is always the absolute path VerifyInstalledComponent resolved and verified, never
// anything the manifest named, and the reported version is normalized through the single
// protocol.ExtractNormalizedVersion definition harness discovery uses, so the two can never disagree
// about what an executable reported.
//
// Unlike an external PATH binary — which stays accepted with no version, because an
// operator-installed harness that worked before managed components existed must keep working — a
// managed candidate whose output carries no parsable version is refused: activating it would record
// a pinned version nothing ever confirmed.
//
// The returned error names only the component identity and one of the fixed reasons above: raw probe
// output may carry credentials and is never surfaced, not even the version parsed out of it.
func ProbeHarnessVersion(ctx context.Context, installed InstalledComponent) error {
	spec, allowed := HarnessVersionProbeAllowlist[installed.Entry.HarnessID]
	if !allowed {
		return fmt.Errorf("%s has no compiled-in version contract, so it cannot be activated", installed.Ref())
	}
	readiness, output := runProbeCapturingOutput(ctx, installed.Path, spec.Arguments, spec.SuccessExitCode)
	switch readiness {
	case AuthReadinessReady:
	case AuthReadinessNotReady:
		return fmt.Errorf("%s %s", installed.Ref(), harnessVersionProbeUnansweredReason)
	default:
		// AuthReadinessUnknown, and any value a later vocabulary addition introduces, fails closed.
		return fmt.Errorf("%s %s", installed.Ref(), harnessVersionProbeUnknownReason)
	}
	reported := protocol.ExtractNormalizedVersion(output)
	if reported == "" {
		return fmt.Errorf("%s %s", installed.Ref(), harnessVersionProbeMalformedReason)
	}
	if reported != installed.Ref().Version {
		return fmt.Errorf("%s %s", installed.Ref(), harnessVersionProbeMismatchReason)
	}
	return nil
}

// ActivationContext is everything one activation, rollback, or prune operation reads. Every field
// is required: a zero value must never be interpretable as "no constraint".
type ActivationContext struct {
	DataRoot string
	Manifest Manifest
	Platform string
	// Ownership is the loaded ownership ledger. It is the only ownership authority: activation never
	// installs, downloads, stages, or repairs bytes, and a candidate absent from it is refused.
	Ownership OwnershipLedger
	// Activation is the loaded activation evidence. A rejected file refuses every mutation before
	// anything is written.
	Activation ActivationState
	// Probe verifies a candidate before its selection becomes durable. A nil Probe refuses
	// activation and rollback rather than recording an unprobed selection.
	Probe ComponentProbe
	// InUse reports whether an absolute executable path currently supervises a run in this process.
	// It is required: a nil function would silently mean "nothing is in use", which is the
	// fail-open reading of missing evidence. The setup CLI supplies a function that reports false
	// because that process supervises nothing, and a running daemon never adopts a selection change
	// in place — it reports that a restart is required — so the two together are the whole
	// protection this design offers.
	InUse func(path string) bool
}

// validate refuses an operation whose evidence is incomplete before it reads the filesystem.
func (activationContext ActivationContext) validate() error {
	if !filepath.IsAbs(activationContext.DataRoot) {
		return errors.New("data root must be an absolute path")
	}
	if !platformKeyPattern.MatchString(activationContext.Platform) {
		return errors.New("platform must be GOOS-GOARCH shaped")
	}
	if activationContext.InUse == nil {
		return errors.New("an active-run usage check is required")
	}
	if activationContext.Activation.Rejection != nil {
		return fmt.Errorf("the activation ledger cannot be accepted: %w", activationContext.Activation.Rejection)
	}
	return nil
}

// ActivationOutcome reports what one activation or rollback settled on. It names only component
// identities: a diagnostic must never carry an install path, an operator argument, or process
// output.
type ActivationOutcome struct {
	Identity ComponentIdentity
	Active   ComponentRef
	// Previous is the retained rollback target after the operation, absent when none is retained.
	Previous *ComponentRef
	// Changed is false when the operation was an exact replay of the durable selection, which
	// writes nothing.
	Changed bool
}

// Activate selects one already-installed, verified component version for launch. It is
// verified-then-recorded: the manifest must declare the version, the ownership ledger must record
// its exact identity at its deterministic install location, the file must still hash to the
// recorded digest, no run may be using the affected executable, and the candidate must pass its
// probe — all before the atomic rename. Any failure leaves the activation ledger, the ownership
// ledger, and every installed file exactly as they were, so a failed activation keeps the prior
// version active. Re-activating the currently active, still-verifying version writes nothing.
func Activate(ctx context.Context, activationContext ActivationContext, selector ComponentSelector) (ActivationOutcome, error) {
	if err := activationContext.validate(); err != nil {
		return ActivationOutcome{}, fmt.Errorf("activate: %w", err)
	}
	if err := selector.Validate(); err != nil {
		return ActivationOutcome{}, fmt.Errorf("activate: %w", err)
	}
	if selector.Version == "" {
		return ActivationOutcome{}, errors.New("activate: an exact component version is required")
	}
	if activationContext.Probe == nil {
		return ActivationOutcome{}, errors.New("activate: a candidate probe is required")
	}
	identity := selector.Identity()
	ref := ComponentRef{Kind: selector.Kind, ID: selector.ID, Version: selector.Version}
	// A candidate must be a version the current manifest declares: activation selects something an
	// apply of this manifest installed, and it never installs, stages, or invents bytes itself.
	if _, declared := manifestEntryFor(activationContext.Manifest, ref); !declared {
		return ActivationOutcome{}, fmt.Errorf("activate %s: the component manifest does not declare this version", ref)
	}
	installed, err := verifiedComponentVersion(activationContext, ref)
	if err != nil {
		return ActivationOutcome{}, fmt.Errorf("activate %s: %w", ref, err)
	}
	current, activated := activationContext.Activation.Ledger.RecordFor(identity)
	if activated && current.Active.Component == ref && current.Active.Path == installed.Path &&
		current.Active.ContentSHA256 == installed.ContentSHA256 {
		// An exact replay of the durable selection, re-verified above: nothing to write.
		return outcome(current, false), nil
	}
	if err := refuseBusySelection(activationContext, installed.Path, current, activated); err != nil {
		return ActivationOutcome{}, fmt.Errorf("activate %s: %w", ref, err)
	}
	if err := activationContext.Probe(ctx, installed); err != nil {
		return ActivationOutcome{}, fmt.Errorf("activate %s: the candidate failed its probe: %w", ref, err)
	}
	record := ActivationRecord{Active: targetFor(installed)}
	if activated {
		// The retained target must always name a *different* version than the active one — the
		// parser rejects a record where they agree, so retaining the outgoing selection blindly
		// would let Activate write a ledger it cannot read back. Re-selecting the same version with
		// different bytes (a re-pinned source archive reinstalled at the same declared version)
		// replaces the selection in place and keeps the genuinely older retained target.
		switch {
		case current.Active.Component.Version != record.Active.Component.Version:
			retained := current.Active
			record.Previous = &retained
		case current.Previous != nil:
			retained := *current.Previous
			record.Previous = &retained
		}
	}
	if err := activationContext.Activation.Ledger.WithRecord(record).Save(activationContext.DataRoot); err != nil {
		return ActivationOutcome{}, fmt.Errorf("activate %s: %w", ref, err)
	}
	return outcome(record, true), nil
}

// Rollback re-selects the retained previously verified version. It is an activation of an
// already-installed version and nothing more: it never restores bytes from a backup or an archive,
// and it never deletes the failed candidate's files. Rolling back consumes the retained target
// rather than swapping it with the outgoing version, so rollback can never become a way to
// re-select the candidate that was just rolled away from.
func Rollback(ctx context.Context, activationContext ActivationContext, selector ComponentSelector) (ActivationOutcome, error) {
	if err := activationContext.validate(); err != nil {
		return ActivationOutcome{}, fmt.Errorf("rollback: %w", err)
	}
	if err := selector.Validate(); err != nil {
		return ActivationOutcome{}, fmt.Errorf("rollback: %w", err)
	}
	if selector.Version != "" {
		return ActivationOutcome{}, errors.New("rollback: the target comes from the retained rollback version, so no version may be given")
	}
	if activationContext.Probe == nil {
		return ActivationOutcome{}, errors.New("rollback: a candidate probe is required")
	}
	identity := selector.Identity()
	current, activated := activationContext.Activation.Ledger.RecordFor(identity)
	if !activated {
		return ActivationOutcome{}, fmt.Errorf("rollback %s: %w", identity, ErrComponentNotActivated)
	}
	if current.Previous == nil {
		return ActivationOutcome{}, fmt.Errorf("rollback %s: no previously verified version is retained", identity)
	}
	ref := current.Previous.Component
	installed, err := verifiedComponentVersion(activationContext, ref)
	if err != nil {
		return ActivationOutcome{}, fmt.Errorf("rollback %s: %w", ref, err)
	}
	if current.Previous.Path != installed.Path || current.Previous.ContentSHA256 != installed.ContentSHA256 {
		return ActivationOutcome{}, fmt.Errorf("rollback %s: the retained rollback target no longer matches the ownership ledger", ref)
	}
	if err := refuseBusySelection(activationContext, installed.Path, current, true); err != nil {
		return ActivationOutcome{}, fmt.Errorf("rollback %s: %w", ref, err)
	}
	if err := activationContext.Probe(ctx, installed); err != nil {
		return ActivationOutcome{}, fmt.Errorf("rollback %s: the retained version failed its probe: %w", ref, err)
	}
	record := ActivationRecord{Active: targetFor(installed)}
	if err := activationContext.Activation.Ledger.WithRecord(record).Save(activationContext.DataRoot); err != nil {
		return ActivationOutcome{}, fmt.Errorf("rollback %s: %w", ref, err)
	}
	return outcome(record, true), nil
}

// verifiedComponentVersion resolves one exact component version to a verified installed component.
//
// When the manifest still declares that exact version, resolution goes through
// VerifyInstalledComponent, so the file must sit at the one location ComponentTargetPath derives.
// A version the manifest no longer declares is the ordinary state of a retained rollback target: a
// manifest carries at most one version per component id (Manifest.Validate rejects a duplicate id),
// so the moment a manifest bump declares the new version the previous one stops being declared, and
// requiring declaration would make every rollback and every already-active older version fail the
// instant Barista was upgraded. Such a version is resolved from the ownership ledger instead, which
// is the only ownership authority and which records the exact absolute path of every owned file; the
// path is then held to the same containment, file-type, and digest checks through
// InstalledComponent.Verify. Nothing is ever repaired and no other installed version is ever
// substituted.
func verifiedComponentVersion(activationContext ActivationContext, ref ComponentRef) (InstalledComponent, error) {
	return resolveInstalledVersion(activationContext.DataRoot, activationContext.Manifest, activationContext.Platform, activationContext.Ownership, ref)
}

func resolveInstalledVersion(dataRoot string, manifest Manifest, platform string, ownership OwnershipLedger, ref ComponentRef) (InstalledComponent, error) {
	if entry, declared := manifestEntryFor(manifest, ref); declared {
		return VerifyInstalledComponent(dataRoot, entry, platform, ownership)
	}
	// The sibling entry supplies only the component's non-version metadata — its harness and its
	// launch template — because a retained version's own launch template is not recorded anywhere and
	// must not be invented. The version itself always comes from ref.
	sibling, known := manifestEntryForIdentity(manifest, ref.Identity())
	if !known {
		return InstalledComponent{}, errors.New("the component manifest does not declare this component")
	}
	record, owned, err := ownershipRecordForComponent(ownership, ref)
	if err != nil {
		return InstalledComponent{}, err
	}
	if !owned {
		return InstalledComponent{}, fmt.Errorf("%w: the ownership ledger records no file for this version", ErrComponentNotInstalled)
	}
	// The declared branch reaches its record by the exact path ComponentTargetPath derives, which
	// binds the record's harness and version layout implicitly. This branch reaches its record by
	// component identity instead, so both are checked explicitly rather than inherited: a record whose
	// harness binding or version directory disagrees with the component it claims to be would make the
	// launch template and the executable come from two different components.
	if record.HarnessID != sibling.HarnessID {
		return InstalledComponent{}, errors.New("the ownership ledger binds this component version to a different harness")
	}
	versionDirectory, err := componentVersionDirectory(dataRoot, sibling, ref.Version)
	if err != nil {
		return InstalledComponent{}, err
	}
	if !strings.HasPrefix(record.Path, versionDirectory+string(filepath.Separator)) {
		return InstalledComponent{}, errors.New("the ownership ledger records this component version outside its own install directory")
	}
	entry := sibling
	entry.Version = ref.Version
	// An absent file classifies as ErrComponentNotInstalled here exactly as it does in
	// VerifyInstalledComponent, so the two resolution branches cannot disagree about what "not
	// installed" means.
	if _, statErr := os.Lstat(record.Path); errors.Is(statErr, fs.ErrNotExist) {
		return InstalledComponent{}, ErrComponentNotInstalled
	}
	installed := InstalledComponent{
		Entry:         entry,
		Path:          record.Path,
		ContentSHA256: strings.ToLower(record.ContentSHA256),
		dataRoot:      dataRoot,
	}
	if err := installed.Verify(); err != nil {
		return InstalledComponent{}, err
	}
	return installed, nil
}

// manifestEntryFor finds the one manifest entry whose identity triple equals ref.
func manifestEntryFor(manifest Manifest, ref ComponentRef) (ComponentManifestEntry, bool) {
	for index := range manifest.Components {
		if manifest.Components[index].Ref() == ref {
			return manifest.Components[index], true
		}
	}
	return ComponentManifestEntry{}, false
}

// manifestEntryForIdentity finds the manifest entry for a component identity regardless of version.
// Manifest.Validate rejects a duplicate component id, so at most one entry can match.
func manifestEntryForIdentity(manifest Manifest, identity ComponentIdentity) (ComponentManifestEntry, bool) {
	for index := range manifest.Components {
		if manifest.Components[index].Ref().Identity() == identity {
			return manifest.Components[index], true
		}
	}
	return ComponentManifestEntry{}, false
}

// ownershipRecordForComponent finds the one owned file recorded for an exact component version. Two
// records claiming one version are ambiguous — nothing can say which file that version is — so they
// are refused rather than resolved in either record's favor.
func ownershipRecordForComponent(ownership OwnershipLedger, ref ComponentRef) (OwnershipRecord, bool, error) {
	found := OwnershipRecord{}
	matches := 0
	for _, record := range ownership.Records {
		if record.Component == ref {
			found = record
			matches++
		}
	}
	switch matches {
	case 0:
		return OwnershipRecord{}, false, nil
	case 1:
		return found, true, nil
	default:
		return OwnershipRecord{}, false, errors.New("the ownership ledger records more than one file for this component version")
	}
}

// refuseBusySelection refuses a selection change while a run in this process supervises either the
// candidate executable or the executable the current selection names. The diagnostic carries no
// path and no process output.
func refuseBusySelection(activationContext ActivationContext, candidatePath string, current ActivationRecord, activated bool) error {
	if activationContext.InUse(candidatePath) {
		return errors.New("a run is currently using this component, so its selection cannot change")
	}
	if activated && activationContext.InUse(current.Active.Path) {
		return errors.New("a run is currently using the active version of this component, so its selection cannot change")
	}
	return nil
}

func targetFor(installed InstalledComponent) ActivationTarget {
	return ActivationTarget{
		Component:     installed.Ref(),
		Path:          installed.Path,
		ContentSHA256: installed.ContentSHA256,
	}
}

func outcome(record ActivationRecord, changed bool) ActivationOutcome {
	result := ActivationOutcome{Identity: record.Identity(), Active: record.Active.Component, Changed: changed}
	if record.Previous != nil {
		previous := record.Previous.Component
		result.Previous = &previous
	}
	return result
}

// ActiveInstalledComponent resolves the one installed version the activation ledger selects for a
// component identity and re-verifies it, so every launch trusts the selection's bytes rather than
// the check that recorded them. It is the single launch-time entry point for a managed component:
// an unreadable activation ledger, an absent selection, a selection the manifest no longer
// declares, a selection whose recorded path is not the one ComponentTargetPath derives, a selection
// the ownership ledger does not record, and a selection whose bytes drifted are each a refusal —
// never a fallback to a different installed version and never a repair.
func ActiveInstalledComponent(
	dataRoot string,
	manifest Manifest,
	platform string,
	ownership OwnershipLedger,
	activation ActivationState,
	identity ComponentIdentity,
) (InstalledComponent, error) {
	if err := identity.Validate(); err != nil {
		return InstalledComponent{}, err
	}
	if activation.Rejection != nil {
		return InstalledComponent{}, fmt.Errorf("the activation ledger cannot be accepted: %w", activation.Rejection)
	}
	record, activated := activation.Ledger.RecordFor(identity)
	if !activated {
		return InstalledComponent{}, ErrComponentNotActivated
	}
	installed, err := resolveInstalledVersion(dataRoot, manifest, platform, ownership, record.Active.Component)
	if err != nil {
		return InstalledComponent{}, err
	}
	if installed.Path != record.Active.Path {
		// The record's path is compared literally against the path resolution independently
		// established, so a record naming anything else — including a path outside the data root —
		// stays reportable but is never matched or followed.
		return InstalledComponent{}, errors.New("the active version's recorded path is not this component version's install location")
	}
	if installed.ContentSHA256 != record.Active.ContentSHA256 {
		return InstalledComponent{}, errors.New("the active version's recorded digest no longer matches the ownership ledger")
	}
	return installed, nil
}

// PruneRetention is one ownership record prune left in place, with the fixed reason it was kept.
type PruneRetention struct {
	Record OwnershipRecord
	Reason string
}

// Reasons prune reports for a file it kept. Each is a fixed structural string; none names a path,
// an operator argument, or process output.
const (
	PruneRetainedActive   = "the version is active"
	PruneRetainedRollback = "the version is the retained rollback target"
	PruneRetainedDrifted  = "the file no longer matches its ownership record"
)

// PruneResult reports what prune removed and what it kept.
type PruneResult struct {
	Removed  []OwnershipRecord
	Retained []PruneRetention
}

// Prune deletes the installed files of a component's inactive versions. It removes only files whose
// ownership record still matches on disk — the existing recordIsSafelyRemovable rule, reached
// through the existing Uninstall path so the ownership ledger is persisted the one way it already
// is — and never the active version, never the retained rollback version, never a drifted or
// unowned file, and never a directory. Replaying it converges: a second run finds nothing left to
// remove and keeps reporting the same retentions.
func Prune(activationContext ActivationContext, selector ComponentSelector) (PruneResult, OwnershipLedger, error) {
	if err := activationContext.validate(); err != nil {
		return PruneResult{}, OwnershipLedger{}, fmt.Errorf("prune: %w", err)
	}
	if err := selector.Validate(); err != nil {
		return PruneResult{}, OwnershipLedger{}, fmt.Errorf("prune: %w", err)
	}
	if selector.Version != "" {
		return PruneResult{}, OwnershipLedger{}, errors.New("prune: the versions to remove are derived from the activation record, so no version may be given")
	}
	identity := selector.Identity()
	record, activated := activationContext.Activation.Ledger.RecordFor(identity)
	protected := map[string]string{}
	if activated {
		protected[record.Active.Component.Version] = PruneRetainedActive
		if record.Previous != nil {
			protected[record.Previous.Component.Version] = PruneRetainedRollback
		}
	}
	result := PruneResult{}
	ledger := activationContext.Ownership
	// Collect the versions to remove before mutating anything, so the set prune acts on is decided
	// from one consistent view of the ledger.
	versions := []string{}
	seen := map[string]bool{}
	// Usage is checked across every version of the component first, including the protected ones: a
	// component whose executable supervises a run is refused outright rather than partially pruned.
	for _, owned := range ledger.Records {
		if selector.Matches(owned.Component) && activationContext.InUse(owned.Path) {
			return PruneResult{}, OwnershipLedger{}, fmt.Errorf("prune %s: a run is currently using this component, so nothing was removed", identity)
		}
	}
	for _, owned := range ledger.Records {
		if !selector.Matches(owned.Component) {
			continue
		}
		if reason, isProtected := protected[owned.Component.Version]; isProtected {
			result.Retained = append(result.Retained, PruneRetention{Record: owned, Reason: reason})
			continue
		}
		if !seen[owned.Component.Version] {
			seen[owned.Component.Version] = true
			versions = append(versions, owned.Component.Version)
		}
	}
	for _, version := range versions {
		removed, updated, err := Uninstall(activationContext.DataRoot, ledger, ComponentSelector{Kind: selector.Kind, ID: selector.ID, Version: version})
		if err != nil {
			return PruneResult{}, OwnershipLedger{}, fmt.Errorf("prune %s: %w", identity, err)
		}
		ledger = updated
		result.Removed = append(result.Removed, removed.Removed...)
		for _, retained := range removed.Retained {
			result.Retained = append(result.Retained, PruneRetention{Record: retained, Reason: PruneRetainedDrifted})
		}
	}
	return result, ledger, nil
}
