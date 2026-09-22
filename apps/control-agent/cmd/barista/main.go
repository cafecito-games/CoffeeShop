package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/config"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/controlplane"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/harness"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/readiness"
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
	profiles := harness.Discover(ctx)
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
	client := controlplane.NewClient(cfg, node, harness.NewRunner(profiles), buildCapabilityReport)
	if err := client.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Printf("Barista stopped: %v", err)
		return 1
	}
	return 0
}
