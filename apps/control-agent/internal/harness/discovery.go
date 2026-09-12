package harness

import (
	"context"
	"os/exec"
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
