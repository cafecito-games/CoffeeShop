package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"maps"
	"os"
	"os/signal"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acpadapter"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/config"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/controlplane"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/harness"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/readiness"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/setup"
)

var version = "dev"

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) > 0 {
		switch args[0] {
		case "setup":
			return runSetup(args[1:])
		case "doctor":
			return runDoctor(args[1:])
		}
	}
	cfg, err := config.Parse(args)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		log.Printf("configuration: %v", err)
		return 2
	}
	if cfg.VersionOnly {
		fmt.Printf("barista %s\n", version)
		return 0
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// Both ledgers are read once, here, and the selection they establish is what this process
	// launches for its whole lifetime. A rejected activation ledger makes every managed component
	// unavailable with that reason rather than being treated as an absent selection.
	activation := setup.LoadActivationState(cfg.DataRoot)
	if activation.Rejection != nil {
		log.Printf("component activation: %v", activation.Rejection)
		log.Printf("component activation: %s", setup.ActivationRepairGuidance)
	}
	_, componentManifest, err := loadSetupManifest(cfg.AdapterManifestPath)
	if err != nil {
		log.Printf("component manifest: %v", err)
		return 2
	}
	ownership, ownershipErr := setup.LoadOwnershipLedger(cfg.DataRoot)
	if ownershipErr != nil {
		// Managed components are all unavailable without the ownership ledger; the daemon still
		// starts on its external PATH harnesses, exactly as acpadapter.Load already degrades.
		log.Printf("ownership ledger could not be read, so no managed component is available: %v", ownershipErr)
		ownership = setup.OwnershipLedger{}
	}
	managed, unresolvedManaged := managedHarnesses(componentManifest, ownership, activation, cfg.DataRoot)
	resolutions := harness.Resolve(ctx, managed)
	// A manifest may declare a harness component for a harness this build has no provider policy for,
	// which Resolve therefore never returns. Its unresolved reason is reported first so the
	// "never silent" property has no blind spot exactly where the harness is also unlaunchable.
	reported := map[string]bool{}
	for _, resolution := range resolutions {
		reported[resolution.HarnessID] = true
	}
	for _, harnessID := range slices.Sorted(maps.Keys(unresolvedManaged)) {
		if !reported[harnessID] {
			log.Printf("harness %s: the activated managed version is not usable (%s); Barista has no provider policy for this harness, so it is unavailable", harnessID, unresolvedManaged[harnessID])
		}
	}
	for _, resolution := range resolutions {
		// Every way a managed selection can fail to be honored is logged, so falling back to an
		// external PATH installation is never silent and never diverges from what doctor reports.
		if reason, unresolved := unresolvedManaged[resolution.HarnessID]; unresolved {
			log.Printf("harness %s: the activated managed version is not usable (%s); %s", resolution.HarnessID, reason, fallbackDescription(resolution))
			continue
		}
		if resolution.ManagedRejected != "" {
			log.Printf("harness %s: the activated managed version was rejected (%s); %s", resolution.HarnessID, resolution.ManagedRejected, fallbackDescription(resolution))
			continue
		}
		if resolution.Managed != nil && resolution.External != nil {
			log.Printf("harness %s: a managed version %s and an external installation are both present; the managed version is selected", resolution.HarnessID, resolution.Managed.Version)
		}
	}
	nativeProfiles := harness.Profiles(resolutions)
	activationWatch := newActivationWatcher(cfg.DataRoot, activation)
	driver, claudeACPAuthMode, err := acpDriver(cfg, componentManifest, activation, nativeProfiles)
	if err != nil {
		log.Printf("ACP adapters: %v", err)
		return 2
	}
	profiles, probeFailures := harness.AdvertiseACP(ctx, nativeProfiles, driver)
	for _, harnessID := range driver.HarnessIDs() {
		if failure, failed := probeFailures[harnessID]; failed {
			log.Printf("ACP adapter for %s is disabled: %s", harnessID, displayableError(failure))
		} else {
			log.Printf("ACP adapter for %s passed its startup probe", harnessID)
		}
	}
	// The Claude ACP harness profile's authMode reflects the administrator's explicit policy only
	// once the adapter actually advertises acp-v1: a gate failure or a probe failure leaves the
	// harness on its native, local-subscription default rather than claiming an "api" auth mode
	// nothing verified.
	if claudeACPAuthMode == harness.ClaudeACPAuthModeAPI {
		for index := range profiles {
			if profiles[index].ID == "claude-cli" && slices.Contains(profiles[index].Transports, harness.TransportACP) {
				profiles[index].AuthMode = harness.ClaudeACPAuthModeAPI
			}
		}
	}
	profiles = harness.AdvertiseApprovalPolicies(profiles, cfg.ApprovalPolicies)
	for _, harnessID := range harness.ApprovalPolicyHarnessIDs {
		if policy := cfg.ApprovalPolicies.For(harnessID); policy != protocol.ApprovalPolicyManual {
			log.Printf("approval policy for %s is %s: %s", harnessID, policy, harness.ApprovalPolicyEffect(policy))
		}
	}
	available := make([]string, 0, len(profiles))
	for _, profile := range profiles {
		if profile.Available {
			available = append(available, profile.Label)
		}
	}
	if len(available) == 0 {
		log.Printf("no supported harnesses found; install and authenticate Claude Code or Codex before starting Barista")
		return 1
	}
	log.Printf("discovered harnesses: %s", strings.Join(available, ", "))
	log.Printf("allowed workspace roots: %s", strings.Join(cfg.WorkspaceRoots, ", "))
	if cfg.InstanceCapacity == 0 {
		log.Printf("resident instance hosting is disabled (instance capacity 0)")
	} else {
		log.Printf("resident instance capacity: %d (run concurrency %d)", cfg.InstanceCapacity, cfg.Concurrency)
	}

	node := protocol.ComputeNode{
		ID:             cfg.NodeID,
		Name:           cfg.Name,
		Kind:           cfg.Kind,
		Platform:       config.Platform(),
		Status:         "online",
		LastSeen:       time.Now().UTC().Format(time.RFC3339Nano),
		Concurrency:    cfg.Concurrency,
		WorkspaceRoots: cfg.WorkspaceRoots,
		Harnesses:      profiles,
		Version:        version,
	}
	buildCapabilityReport := func(buildContext context.Context) protocol.NodeCapabilityReport {
		// The daemon keeps the selection it verified at startup; a record that changed since then is
		// only reported, never adopted in place, so no in-flight run has its launch target swapped.
		if notice := activationWatch.RestartNotice(); notice != "" {
			log.Print(notice)
		}
		return readiness.BuildCapabilityReport(buildContext, cfg, profiles)
	}
	report := buildCapabilityReport(ctx)
	succeeded := 0
	for _, entry := range report.Evidence {
		if entry.Success {
			succeeded++
		}
	}
	log.Printf("node capability report ready: %d of %d evidence entries succeeded", succeeded, len(report.Evidence))
	// A crash can leave run-scoped projections on disk. They are reconciled here, at daemon start,
	// and nowhere else: only entries directly beneath the one Barista-owned run-scoped prefix are
	// removed, and a symlink is never followed while cleaning.
	if removed, err := harness.ReconcileStaleProjections(cfg.DataRoot); err != nil {
		log.Printf("capability pack: stale run-scoped projections were retained and will be reconciled at the next start: %v", err)
	} else if len(removed) > 0 {
		log.Printf("capability pack: reconciled %d run-scoped projection(s) left behind by an earlier Barista", len(removed))
	}
	activePack, packUnavailable := activeCapabilityPack(componentManifest, ownership, activation, cfg.DataRoot, version)
	if activePack == nil {
		log.Printf("capability pack: %s; runs on this node are %s", packUnavailable, cfg.CapabilityPackRequirement)
	} else {
		log.Printf("capability pack %s@%s (%s) is active; runs on this node are %s",
			activePack.ID, activePack.Version, activePack.ArchiveDigest, cfg.CapabilityPackRequirement)
		for _, harnessID := range packReadyHarnessIDs() {
			log.Printf("capability pack: %s", harnessID)
		}
	}
	runner := newRunner(nativeProfiles, profiles, driver, cfg).WithManagedHarnesses(harness.ManagedHarnesses(resolutions)).
		WithCapabilityPack(activePack, packUnavailable, cfg.CapabilityPackRequirement, cfg.DataRoot).
		WithCapabilityPackReport(func(line string) { log.Print(line) })
	client := controlplane.NewClient(cfg, node, runner, buildCapabilityReport)
	if err := client.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Printf("Barista stopped: %v", err)
		return 1
	}
	return 0
}

// packReadyHarnessIDs describes, per harness and transport, whether this build ships a capability
// pack activation adapter. A combination with no adapter is named as such rather than left silent,
// because silence about an unverified surface is exactly what would make a run look pack-ready.
func packReadyHarnessIDs() []string {
	ready := map[string]bool{}
	for _, combination := range harness.PackReadyCombinations() {
		ready[combination[0]+" over "+combination[1]] = true
	}
	lines := make([]string, 0, len(ready)+2)
	for _, harnessID := range []string{"claude-cli", "codex-cli"} {
		for _, transport := range []string{harness.TransportNative, harness.TransportACP} {
			combination := harnessID + " over " + transport
			if ready[combination] {
				lines = append(lines, combination+" has a verified activation adapter")
				continue
			}
			lines = append(lines, combination+" has no verified skill-discovery surface at its pinned version, so it ships no activation adapter and refuses a pack-required run before the prompt")
		}
	}
	slices.Sort(lines)
	return lines
}

// fallbackDescription names what a harness falls back to when its managed selection is not usable,
// so one log line carries both the failure and its consequence.
func fallbackDescription(resolution harness.HarnessResolution) string {
	if resolution.External != nil {
		return "falling back to the external installation found on PATH"
	}
	return "this harness is unavailable"
}

// newRunner wires the node's Runner from both views of its harness capability. Native execution
// and native fallback read the natively discovered profiles, while admission reads exactly the
// profiles the node advertises to the hub, so an allocation the hub selected from the advertised
// set — including a harness or model available only through ACP — is always admissible.
func newRunner(nativeProfiles, advertisedProfiles []protocol.HarnessProfile, driver *harness.ACPDriver, cfg config.Config) *harness.Runner {
	return harness.NewRunner(nativeProfiles).WithAdvertisedProfiles(advertisedProfiles).WithACP(driver).
		WithNativeFallback(cfg.ACPNativeFallback...).WithApprovalPolicies(cfg.ApprovalPolicies)
}

// acpDriver loads the ACP adapters this node may launch: administrator overrides, which must
// verify or startup fails, and setup-installed adapters re-verified against the ownership ledger.
// It also applies the Claude ACP auth-mode gate: an adapter otherwise ready to load for claude-cli
// is dropped, with a logged reason, unless the administrator explicitly configured an auth mode
// and, for local-subscription, none of Claude's billing-switching variables are present in
// Barista's own environment. The second return value is the auth mode the gate resolved for
// claude-cli ("" when Claude ACP did not load), so the caller can reflect it on the advertised
// harness profile once the adapter has actually proven itself over ACP.
func acpDriver(cfg config.Config, manifest setup.Manifest, activation setup.ActivationState, nativeProfiles []protocol.HarnessProfile) (*harness.ACPDriver, string, error) {
	loaded, err := acpadapter.Load(acpadapter.Options{DataRoot: cfg.DataRoot, Manifest: manifest, Platform: setup.CurrentPlatform(), Overrides: cfg.ACPAdapters, Activation: activation})
	if err != nil {
		return nil, "", err
	}
	claudeACPAuthMode := ""
	if _, configured := loaded.Adapters["claude-cli"]; configured {
		resolved, gateErr := harness.ClaudeACPAuthGate(cfg.ClaudeACPAuthMode, os.Environ())
		if gateErr != nil {
			delete(loaded.Adapters, "claude-cli")
			loaded.Skipped["claude-cli"] = gateErr.Error()
		} else {
			claudeACPAuthMode = resolved
		}
	}
	for harnessID, reason := range loaded.Skipped {
		log.Printf("no ACP adapter loaded for %s: %s", harnessID, reason)
	}
	nativeBinaries := map[string]string{}
	for _, profile := range nativeProfiles {
		if profile.Available {
			nativeBinaries[profile.ID] = profile.Binary
		}
	}
	return harness.NewACPDriver(harness.ACPDriverOptions{Adapters: loaded.Adapters, NativeBinaries: nativeBinaries, ClientVersion: version}), claudeACPAuthMode, nil
}

// displayableError keeps a probe failure out of the log when it looks like it carries a secret,
// since adapter stderr is included in it.
func displayableError(err error) string {
	message := err.Error()
	if protocol.LooksSecretLike(message) {
		return "the adapter's diagnostic output was withheld because it looks like it contains a secret"
	}
	return message
}
