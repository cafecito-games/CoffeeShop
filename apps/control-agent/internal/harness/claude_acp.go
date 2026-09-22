package harness

import (
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

// claude-acp session configuration option identifiers and the permission mode Barista requires.
const (
	claudeModeOption  = "mode"
	claudeModelOption = "model"
	// claudeManualPermissionMode is claude-agent-acp's wire id for its "Manual" preset. Every tool
	// call is sent to the client as an ACP permission request instead of being auto-approved, the
	// same fail-closed posture as the native CLI's `--permission-mode auto` with unanswered prompts
	// denied. Barista never selects "acceptEdits", "auto", or "bypassPermissions", each of which
	// lets the adapter approve a tool call without a Coffee Shop decision.
	claudeManualPermissionMode = "default"
)

// claudeACPProvider drives the claude-agent-acp adapter. The adapter authenticates through
// Claude's own locally owned subscription storage or inherited provider environment exactly as
// the native CLI does; Barista never sets, reads, or forwards an account credential, and never
// switches a subscription session onto API billing. The permission mode is applied through
// session configuration and confirmed before the prompt is sent, so neither an adapter default nor
// an inherited operator environment can weaken it to an auto-approving mode.
func claudeACPProvider() ACPProvider {
	return ACPProvider{
		Configuration:        claudeSessionConfiguration,
		RequireMCPConnection: true,
		NativeBinaryVariable: "CLAUDE_CODE_EXECUTABLE",
		ModelOption:          claudeModelOption,
	}
}

// claudeSessionConfiguration maps a run onto claude-agent-acp session options. The "default" model
// keeps Claude's own configured model, exactly like the native CLI without --model; any other
// model must be offered and applied by the adapter or the run fails rather than silently using the
// provider default.
func claudeSessionConfiguration(run protocol.Run) []acp.ConfigSelection {
	selections := []acp.ConfigSelection{{ID: claudeModeOption, Value: claudeManualPermissionMode, Requirement: acp.ConfigPolicy}}
	if run.Model != "" && run.Model != "default" {
		selections = append(selections, acp.ConfigSelection{ID: claudeModelOption, Value: run.Model, Requirement: acp.ConfigRequested})
	}
	return selections
}
