package harness

import (
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

// ACPProvider is the compiled-in policy for driving one harness through its ACP adapter. It is
// deliberately not part of the adapter manifest, which an operator may replace: sandbox,
// approval, and tool requirements are Barista's to enforce, not the manifest's to relax.
type ACPProvider struct {
	// Environment returns variables added after the inherited and manifest launch environment, so
	// they win, for the harness's effective approval policy. It must never carry a credential.
	Environment func(approvalPolicy string) []string
	// Configuration returns the session options to apply and confirm before a run's prompt, for the
	// harness's effective approval policy. The policy comes from Barista's configuration, never the run.
	Configuration func(run protocol.Run, approvalPolicy string) []acp.ConfigSelection
	// RequireMCPConnection holds the prompt until the adapter has listed the run's Coffee Shop MCP
	// tools, for adapters that connect MCP servers when the session is created.
	RequireMCPConnection bool
	// NativeBinaryVariable names the environment variable through which the adapter is told the
	// absolute path of the harness's discovered, version-checked native CLI, so an adapter that
	// drives that CLI never resolves it through PATH itself.
	NativeBinaryVariable string
	// ModelOption names the session configuration option through which the adapter offers models.
	// The startup probe reads its values so a harness reachable only over ACP can advertise them.
	ModelOption string
}

// DefaultACPProviders returns the provider policy for every harness Barista can drive over ACP.
// A harness without an entry is never driven over ACP, whatever adapter is installed for it.
func DefaultACPProviders() map[string]ACPProvider {
	return map[string]ACPProvider{
		"claude-cli": claudeACPProvider(),
		"codex-cli":  codexACPProvider(),
	}
}
