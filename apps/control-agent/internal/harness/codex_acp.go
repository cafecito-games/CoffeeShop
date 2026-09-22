package harness

import (
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

// codex-acp session configuration option identifiers and the mode Barista requires.
const (
	codexModeOption  = "mode"
	codexModelOption = "model"
	// codexWorkspaceWriteMode is codex-acp's "Ask for approval" preset. Despite its identifier it
	// runs Codex with the workspace-write sandbox and no network access, the same sandbox as the
	// native `codex exec --sandbox workspace-write`, and sends every escalation to the client as
	// an ACP permission request rather than to Codex's automatic reviewer. Barista routes those
	// requests to Coffee Shop approvals, so an escalation is never approved without the hub.
	codexWorkspaceWriteMode = "read-only"
)

// codexACPProvider drives the codex-acp adapter. The adapter reads Codex's own configuration and
// authentication (Codex-owned storage or the inherited provider environment); Barista never sets,
// reads, or forwards an account credential. INITIAL_AGENT_MODE only chooses the adapter's initial
// preset: the mode is also applied through session configuration and confirmed before the prompt,
// so an adapter that ignores the variable, or an operator environment that sets another mode,
// cannot weaken the sandbox.
func codexACPProvider() ACPProvider {
	return ACPProvider{
		Environment:          []string{"INITIAL_AGENT_MODE=" + codexWorkspaceWriteMode},
		Configuration:        codexSessionConfiguration,
		RequireMCPConnection: true,
		NativeBinaryVariable: "CODEX_PATH",
		ModelOption:          codexModelOption,
	}
}

// codexSessionConfiguration maps a run onto codex-acp session options. The "default" model keeps
// Codex's own configured model, exactly like the native CLI without --model; any other model must
// be offered and applied by the adapter or the run fails rather than using the provider default.
func codexSessionConfiguration(run protocol.Run) []acp.ConfigSelection {
	selections := []acp.ConfigSelection{{ID: codexModeOption, Value: codexWorkspaceWriteMode, Requirement: acp.ConfigPolicy}}
	if run.Model != "" && run.Model != "default" {
		selections = append(selections, acp.ConfigSelection{ID: codexModelOption, Value: run.Model, Requirement: acp.ConfigRequested})
	}
	return selections
}
