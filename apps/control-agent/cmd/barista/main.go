package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
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
	nativeProfiles := harness.Discover(ctx)
	driver, claudeACPAuthMode, err := acpDriver(cfg, nativeProfiles)
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
	runner := harness.NewRunner(nativeProfiles).WithACP(driver).WithNativeFallback(cfg.ACPNativeFallback...)
	client := controlplane.NewClient(cfg, node, runner, buildCapabilityReport)
	if err := client.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Printf("Barista stopped: %v", err)
		return 1
	}
	return 0
}

// acpDriver loads the ACP adapters this node may launch: administrator overrides, which must
// verify or startup fails, and setup-installed adapters re-verified against the ownership ledger.
// It also applies the Claude ACP auth-mode gate: an adapter otherwise ready to load for claude-cli
// is dropped, with a logged reason, unless the administrator explicitly configured an auth mode
// and, for local-subscription, none of Claude's billing-switching variables are present in
// Barista's own environment. The second return value is the auth mode the gate resolved for
// claude-cli ("" when Claude ACP did not load), so the caller can reflect it on the advertised
// harness profile once the adapter has actually proven itself over ACP.
func acpDriver(cfg config.Config, nativeProfiles []protocol.HarnessProfile) (*harness.ACPDriver, string, error) {
	_, manifest, err := loadSetupManifest(cfg.AdapterManifestPath)
	if err != nil {
		return nil, "", err
	}
	loaded, err := acpadapter.Load(acpadapter.Options{DataRoot: cfg.DataRoot, Manifest: manifest, Platform: setup.CurrentPlatform(), Overrides: cfg.ACPAdapters})
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
