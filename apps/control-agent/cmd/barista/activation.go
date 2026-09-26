package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/capabilitypack"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/harness"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/setup"
)

// activationProbeTimeout bounds one candidate's activation probe: a harness's --version contract or
// an ACP adapter's startup handshake.
const activationProbeTimeout = 30 * time.Second

// managedHarnesses resolves every managed harness component whose activation record selects a
// version that still verifies, keyed by harness ID. It is the one place launch-time managed harness
// resolution happens, and it consults only internal/setup's verified results — the ownership ledger
// and the activation ledger are parsed there and nowhere else.
//
// The second return value is the reason, per harness, that an existing selection could not be
// resolved. It is never dropped on the floor: a harness whose managed selection stopped verifying
// falls back to its external PATH installation, and the operator must be told that rather than left
// to infer it from a silently different binary.
func managedHarnesses(
	manifest setup.Manifest,
	ledger setup.OwnershipLedger,
	activation setup.ActivationState,
	dataRoot string,
) (map[string]harness.ManagedHarness, map[string]string) {
	resolved := map[string]harness.ManagedHarness{}
	unresolved := map[string]string{}
	seen := map[setup.ComponentIdentity]bool{}
	for _, entry := range manifest.ComponentsOfKind(setup.ComponentKindHarness) {
		identity := entry.Ref().Identity()
		if seen[identity] {
			continue
		}
		seen[identity] = true
		if activation.Rejection != nil {
			// A rejected activation ledger makes every managed component unavailable. Discovery is
			// told about no managed candidate at all, and the reason is reported here rather than
			// letting the external fallback look like an ordinary "nothing selected".
			unresolved[entry.HarnessID] = "the activation ledger could not be accepted"
			continue
		}
		installed, err := setup.ActiveInstalledComponent(dataRoot, manifest, setup.CurrentPlatform(), ledger, activation, identity)
		switch {
		case errors.Is(err, setup.ErrComponentNotActivated):
			// Nothing was ever selected, which is not a failure: the documented external path applies.
		case err != nil:
			unresolved[entry.HarnessID] = "the activated version could not be verified"
		default:
			resolved[installed.Entry.HarnessID] = harness.ManagedHarness{
				Binary:  installed.Path,
				Version: installed.Ref().Version,
				Verify:  installed.Verify,
			}
		}
	}
	return resolved, unresolved
}

// activeCapabilityPack is the capability-pack sibling of managedHarnesses: it resolves the one
// verified active capability pack this daemon will project for its whole lifetime, or the fixed
// reason none is available. Like managedHarnesses it consults only internal/setup's verified results
// and internal/capabilitypack's one validator, and it distinguishes every outcome the fail-closed
// contract distinguishes — a rejected activation ledger, nothing selected, and a selection that
// stopped verifying are three separate reasons and none is ever reported as another.
//
// The second return value is empty exactly when the first is non-nil.
func activeCapabilityPack(
	manifest setup.Manifest,
	ledger setup.OwnershipLedger,
	activation setup.ActivationState,
	dataRoot string,
	build string,
) (*harness.ActivePack, string) {
	entries := manifest.ComponentsOfKind(setup.ComponentKindCapabilityPack)
	if len(entries) == 0 {
		return nil, "this Barista's component manifest declares no capability pack"
	}
	if activation.Rejection != nil {
		// A rejected ledger is never read as "no pack selected": no pack is resolved at all, and the
		// reason names the ledger rather than the selection.
		return nil, "the activation ledger could not be accepted, so no capability pack was resolved"
	}
	if len(entries) > 1 {
		// Duplicate or conflicting pack identities resolve as ambiguous, never newest-wins.
		return nil, "this Barista's component manifest declares more than one capability pack, which is ambiguous"
	}
	entry := entries[0]
	installed, err := setup.ActiveInstalledComponent(dataRoot, manifest, setup.CurrentPlatform(), ledger, activation, entry.Ref().Identity())
	switch {
	case errors.Is(err, setup.ErrComponentNotActivated):
		return nil, "no capability pack version is activated on this node"
	case err != nil:
		return nil, "the activated capability pack version could not be verified"
	}
	// The selection's bytes are read and validated here, through the same validator that packaged
	// them, and read again immediately before every projection through the returned Reread.
	reread := func() (capabilitypack.Tree, capabilitypack.PackManifest, string, error) {
		if err := installed.Verify(); err != nil {
			return nil, capabilitypack.PackManifest{}, "", err
		}
		packManifest, err := capabilitypack.ProbeInstalledArtifact(installed.Path, installed.Entry.ID, installed.Ref().Version)
		if err != nil {
			return nil, capabilitypack.PackManifest{}, "", err
		}
		data, err := os.ReadFile(installed.Path)
		if err != nil {
			return nil, capabilitypack.PackManifest{}, "", err
		}
		tree, err := capabilitypack.ArchiveTree(data)
		if err != nil {
			return nil, capabilitypack.PackManifest{}, "", err
		}
		return tree, packManifest, capabilitypack.ArchiveDigest(data), nil
	}
	tree, packManifest, digest, err := reread()
	if err != nil {
		return nil, "the activated capability pack is not a valid Coffee Shop capability pack"
	}
	return &harness.ActivePack{
		ID:            packManifest.ID,
		Version:       packManifest.Version,
		ArchiveDigest: digest,
		Manifest:      packManifest,
		Tree:          tree,
		Build:         build,
		Reread:        reread,
	}, ""
}

// componentProbe is the compiled-in candidate probe activation and rollback run before a selection
// becomes durable: a managed harness answers its compiled-in --version contract, an ACP adapter
// completes the existing ACP startup handshake, and a capability pack is re-validated through the
// same validator that packaged it. A kind with no probe cannot be activated at all rather than being
// activated unprobed. No probe result ever carries raw child-process output.
func componentProbe(clientVersion string, nativeBinaries map[string]string) setup.ComponentProbe {
	return func(ctx context.Context, installed setup.InstalledComponent) error {
		switch installed.Ref().Kind {
		case setup.ComponentKindHarness:
			return setup.ProbeHarnessVersion(ctx, installed)
		case setup.ComponentKindACPAdapter:
			return probeACPAdapter(ctx, installed, clientVersion, nativeBinaries)
		case setup.ComponentKindCapabilityPack:
			return probeCapabilityPack(installed)
		default:
			// Unreachable while setup.ComponentKinds and this switch agree; an unrecognized kind
			// fails closed rather than being selected without any probe.
			return fmt.Errorf("%s has no activation probe", installed.Ref())
		}
	}
}

// probeCapabilityPack validates an installed capability pack through internal/capabilitypack, the
// same package that packaged it. It is deliberately not an execution: a pack is workflow prose, so
// there is nothing to run and nothing to ask for a version — the artifact's own declared identity is
// cross-checked against the component manifest entry instead, so a well-formed pack of some other
// version can never be recorded as this one.
//
// The returned error carries the validator's reason, which is already bounded and secret-screened by
// internal/capabilitypack and names only fields and validated paths, never packaged content.
func probeCapabilityPack(installed setup.InstalledComponent) error {
	if _, err := capabilitypack.ProbeInstalledArtifact(installed.Path, installed.Entry.ID, installed.Ref().Version); err != nil {
		return fmt.Errorf("%s is not a valid Coffee Shop capability pack: %w", installed.Ref(), err)
	}
	return nil
}

// probeACPAdapter runs the candidate adapter through the existing ACP startup handshake. The
// returned error is a fixed reason naming only the component identity: a probe failure's diagnostic
// includes adapter stderr, which may carry credentials.
func probeACPAdapter(ctx context.Context, installed setup.InstalledComponent, clientVersion string, nativeBinaries map[string]string) error {
	harnessID := installed.Entry.HarnessID
	driver := harness.NewACPDriver(harness.ACPDriverOptions{
		Adapters: map[string]harness.ACPAdapter{harnessID: {
			Binary:      installed.Path,
			Arguments:   installed.Entry.Launch.Arguments,
			Environment: installed.Entry.Launch.Environment,
			ID:          installed.Entry.ID,
			Version:     installed.Entry.Version,
			Source:      protocol.ACPAdapterSourceSetupLedger,
			Verify:      installed.Verify,
		}},
		NativeBinaries: nativeBinaries,
		ClientVersion:  clientVersion,
	})
	probeContext, cancel := context.WithTimeout(ctx, activationProbeTimeout)
	defer cancel()
	if _, err := driver.Probe(probeContext, harnessID); err != nil {
		return fmt.Errorf("%s did not complete its ACP startup handshake", installed.Ref())
	}
	return nil
}

// availableNativeBinaries collects the absolute paths of the external harness CLIs an adapter
// candidate may need to be told about during its handshake.
func availableNativeBinaries(ctx context.Context) map[string]string {
	binaries := map[string]string{}
	for _, profile := range harness.Discover(ctx) {
		if profile.Available {
			binaries[profile.ID] = profile.Binary
		}
	}
	return binaries
}

// componentTarget is the shared --kind/--id/--version selector flag set every activation subcommand
// accepts, so one grammar covers all three. The selector's own Validate is the only grammar check:
// it rejects an unknown kind and a non-kebab-case id, and never reads an empty field as a wildcard.
type componentTarget struct {
	kind    *string
	id      *string
	version *string
}

func registerComponentTarget(set *flag.FlagSet, withVersion bool) componentTarget {
	target := componentTarget{
		kind: set.String("kind", "", "component kind: "+strings.Join(componentKindNames(), " or ")),
		id:   set.String("id", "", "component id as declared in the component manifest"),
	}
	if withVersion {
		target.version = set.String("version", "", "exact installed version to select")
	}
	return target
}

func componentKindNames() []string {
	names := make([]string, 0, len(setup.ComponentKinds))
	for _, kind := range setup.ComponentKinds {
		names = append(names, string(kind))
	}
	return names
}

// selector builds the component selector, refusing anything outside the closed vocabulary and
// grammar before any filesystem access.
func (target componentTarget) selector() (setup.ComponentSelector, error) {
	selector := setup.ComponentSelector{Kind: setup.ComponentKind(*target.kind), ID: *target.id}
	if target.version != nil {
		selector.Version = *target.version
	}
	if err := selector.Validate(); err != nil {
		return setup.ComponentSelector{}, err
	}
	if target.version != nil && selector.Version == "" {
		return setup.ComponentSelector{}, errors.New("--version is required")
	}
	return selector, nil
}

// activationEnvironment is everything the three activation subcommands load identically: the
// manifest, both ledgers, and the probe. Loading refuses before any mutation when either ledger
// cannot be accepted.
func activationEnvironment(ctx context.Context, command string, dataRoot, manifestPath string) (setup.ActivationContext, int) {
	if _, err := os.Stat(dataRoot); err != nil {
		fmt.Fprintf(os.Stderr, "setup %s: the Barista data root does not exist; run `barista setup apply` first\n", command)
		return setup.ActivationContext{}, 1
	}
	_, manifest, err := loadSetupManifest(manifestPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "setup %s: %v\n", command, err)
		return setup.ActivationContext{}, 2
	}
	ownership, err := setup.LoadOwnershipLedger(dataRoot)
	if err != nil {
		fmt.Fprintf(os.Stderr, "setup %s: %v\n", command, err)
		return setup.ActivationContext{}, 1
	}
	activation := setup.LoadActivationState(dataRoot)
	if activation.Rejection != nil {
		fmt.Fprintf(os.Stderr, "setup %s: %v\n", command, activation.Rejection)
		fmt.Fprintln(os.Stderr, "setup "+command+": "+setup.ActivationRepairGuidance)
		return setup.ActivationContext{}, 1
	}
	return setup.ActivationContext{
		DataRoot:   dataRoot,
		Manifest:   manifest,
		Platform:   currentPlatform(),
		Ownership:  ownership,
		Activation: activation,
		Probe:      componentProbe(version, availableNativeBinaries(ctx)),
		// This process supervises no run of its own. A running daemon's in-flight runs are not
		// visible here, which is exactly why a daemon never adopts a selection change in place: it
		// keeps the selection it verified at startup and reports that a restart is required.
		InUse: func(string) bool { return false },
	}, 0
}

func runSetupActivate(args []string) int {
	set := flag.NewFlagSet("setup activate", flag.ContinueOnError)
	set.SetOutput(os.Stderr)
	dataRoot := set.String("data-root", setup.DefaultDataRoot(), "Barista-owned data root; never $HOME itself")
	manifestPath := set.String("manifest", "", "path to a component manifest JSON file (default: the manifest embedded in this binary)")
	target := registerComponentTarget(set, true)
	if code, done := parseActivationFlags(set, args, "activate"); done {
		return code
	}
	selector, err := target.selector()
	if err != nil {
		fmt.Fprintf(os.Stderr, "setup activate: %v\n", err)
		return 2
	}
	ctx := context.Background()
	activationContext, code := activationEnvironment(ctx, "activate", *dataRoot, *manifestPath)
	if code != 0 {
		return code
	}
	outcome, err := setup.Activate(ctx, activationContext, selector)
	if err != nil {
		fmt.Fprintf(os.Stderr, "setup activate: %v\n", err)
		return 1
	}
	printActivationOutcome("activated", outcome)
	return 0
}

func runSetupRollback(args []string) int {
	set := flag.NewFlagSet("setup rollback", flag.ContinueOnError)
	set.SetOutput(os.Stderr)
	dataRoot := set.String("data-root", setup.DefaultDataRoot(), "Barista-owned data root; never $HOME itself")
	manifestPath := set.String("manifest", "", "path to a component manifest JSON file (default: the manifest embedded in this binary)")
	target := registerComponentTarget(set, false)
	if code, done := parseActivationFlags(set, args, "rollback"); done {
		return code
	}
	selector, err := target.selector()
	if err != nil {
		fmt.Fprintf(os.Stderr, "setup rollback: %v\n", err)
		return 2
	}
	ctx := context.Background()
	activationContext, code := activationEnvironment(ctx, "rollback", *dataRoot, *manifestPath)
	if code != 0 {
		return code
	}
	outcome, err := setup.Rollback(ctx, activationContext, selector)
	if err != nil {
		fmt.Fprintf(os.Stderr, "setup rollback: %v\n", err)
		return 1
	}
	printActivationOutcome("rolled back to", outcome)
	return 0
}

func runSetupPrune(args []string) int {
	set := flag.NewFlagSet("setup prune", flag.ContinueOnError)
	set.SetOutput(os.Stderr)
	dataRoot := set.String("data-root", setup.DefaultDataRoot(), "Barista-owned data root; never $HOME itself")
	manifestPath := set.String("manifest", "", "path to a component manifest JSON file (default: the manifest embedded in this binary)")
	target := registerComponentTarget(set, false)
	if code, done := parseActivationFlags(set, args, "prune"); done {
		return code
	}
	selector, err := target.selector()
	if err != nil {
		fmt.Fprintf(os.Stderr, "setup prune: %v\n", err)
		return 2
	}
	activationContext, code := activationEnvironment(context.Background(), "prune", *dataRoot, *manifestPath)
	if code != 0 {
		return code
	}
	result, _, err := setup.Prune(activationContext, selector)
	if err != nil {
		fmt.Fprintf(os.Stderr, "setup prune: %v\n", err)
		return 1
	}
	for _, removed := range result.Removed {
		fmt.Printf("pruned: %s\n", removed.Component)
	}
	for _, retained := range result.Retained {
		fmt.Printf("retained: %s (%s)\n", retained.Record.Component, retained.Reason)
	}
	return 0
}

// parseActivationFlags parses one activation subcommand's flags, reporting whether the caller should
// stop and with which exit code. Unexpected positional arguments fail closed rather than being
// ignored.
func parseActivationFlags(set *flag.FlagSet, args []string, command string) (int, bool) {
	if err := set.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0, true
		}
		return 2, true
	}
	if set.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "setup %s: unexpected arguments: %s\n", command, strings.Join(set.Args(), " "))
		return 2, true
	}
	return 0, false
}

// printActivationOutcome reports what the operation settled on, naming only component identities.
func printActivationOutcome(verb string, outcome setup.ActivationOutcome) {
	if !outcome.Changed {
		fmt.Printf("already active: %s\n", outcome.Active)
	} else {
		fmt.Printf("%s: %s\n", verb, outcome.Active)
	}
	if outcome.Previous != nil {
		fmt.Printf("rollback target: %s\n", *outcome.Previous)
	} else {
		fmt.Printf("rollback target: none\n")
	}
	fmt.Println("a running Barista keeps the selection it verified at startup; restart it to adopt this one")
}

// activationWatcher compares the activation evidence the daemon verified at startup with what is on
// disk now. The daemon deliberately never adopts a change in place: swapping a launch target
// underneath an in-flight run would run a version the run never started with. A change produces one
// operator notice telling them a restart is required, and nothing else.
type activationWatcher struct {
	dataRoot string
	startup  setup.ActivationState
	// fingerprint is the startup evidence's digest, which is what a later read is compared against.
	fingerprint string
	notified    bool
}

func newActivationWatcher(dataRoot string, startup setup.ActivationState) *activationWatcher {
	return &activationWatcher{dataRoot: dataRoot, startup: startup, fingerprint: startup.Fingerprint()}
}

// Startup is the activation evidence the daemon verified at startup and keeps using for the rest of
// its lifetime.
func (watcher *activationWatcher) Startup() setup.ActivationState {
	return watcher.startup
}

// RestartNotice returns the one-time operator notice when the activation ledger has changed since
// startup, and "" otherwise. It never changes the selection the daemon is using.
func (watcher *activationWatcher) RestartNotice() string {
	if watcher == nil || watcher.notified {
		return ""
	}
	if setup.LoadActivationState(watcher.dataRoot).Fingerprint() == watcher.fingerprint {
		return ""
	}
	watcher.notified = true
	return "the component activation record changed after startup; Barista is still using the selection it verified at startup, so restart it to adopt the new one"
}
