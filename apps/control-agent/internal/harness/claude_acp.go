package harness

import (
	"errors"
	"fmt"
	"strings"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

// claude-acp session configuration option identifiers and the permission modes Barista selects.
const (
	claudeModeOption  = "mode"
	claudeModelOption = "model"
	// claudeManualPermissionMode is claude-agent-acp's wire id for its "Manual" preset. Every tool
	// call is sent to the client as an ACP permission request instead of being auto-approved, the
	// same fail-closed posture as the native CLI's `--permission-mode auto` with unanswered prompts
	// denied. It is the mode for the default manual approval policy.
	claudeManualPermissionMode = "default"
	// claudeAutoPermissionMode lets Claude's own classifier approve routine tool calls; only the
	// calls it escalates reach Coffee Shop approvals. Used only under the administrator's auto policy.
	claudeAutoPermissionMode = "auto"
	// claudeBypassPermissionMode approves every tool call without asking anyone. Used only under
	// the administrator's bypass policy. The adapter offers it conditionally, and a run whose
	// adapter does not offer it fails rather than running under another mode.
	claudeBypassPermissionMode = "bypassPermissions"
)

// claudePermissionMode maps an approval policy onto claude-agent-acp's mode. "acceptEdits" and
// "plan" are never selected.
func claudePermissionMode(approvalPolicy string) string {
	switch approvalPolicy {
	case protocol.ApprovalPolicyAuto:
		return claudeAutoPermissionMode
	case protocol.ApprovalPolicyBypass:
		return claudeBypassPermissionMode
	default:
		return claudeManualPermissionMode
	}
}

// claudeACPProvider drives the claude-agent-acp adapter. The adapter authenticates through
// Claude's own locally owned subscription storage or inherited provider environment exactly as
// the native CLI does; Barista never sets, reads, or forwards an account credential, and never
// switches a subscription session onto API billing. The permission mode follows the node's
// approval policy and is applied through session configuration and confirmed before the prompt is
// sent, so neither an adapter default nor an inherited operator environment can change it.
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
func claudeSessionConfiguration(run protocol.Run, approvalPolicy string) []acp.ConfigSelection {
	selections := []acp.ConfigSelection{{ID: claudeModeOption, Value: claudePermissionMode(approvalPolicy), Requirement: acp.ConfigPolicy}}
	if run.Model != "" && run.Model != "default" {
		selections = append(selections, acp.ConfigSelection{ID: claudeModelOption, Value: run.Model, Requirement: acp.ConfigRequested})
	}
	return selections
}

// Claude ACP auth-mode policy. Barista never infers whether a node is subscription- or
// API-billed from adapter behavior: the operator states it explicitly, and Claude ACP stays
// unavailable until they do.
const (
	// ClaudeACPAuthModeLocalSubscription is the only mode in which Barista will launch the Claude
	// ACP adapter without first screening its launch environment for a variable that would move
	// billing off the CLI's own locally owned subscription login.
	ClaudeACPAuthModeLocalSubscription = "local-subscription"
	// ClaudeACPAuthModeAPI is an explicit administrator opt-in acknowledging that this node's
	// Claude ACP adapter is intentionally billed through an API key, Bedrock, or Vertex AI rather
	// than a personal subscription; Barista does not screen its environment in this mode.
	ClaudeACPAuthModeAPI = "api"
)

// ErrClaudeACPAuthModeNotConfigured reports that no administrator auth-mode policy was set for
// Claude ACP, so Barista cannot classify the node as subscription- or API-safe and refuses to
// advertise or launch the adapter. The native claude-cli path is unaffected.
var ErrClaudeACPAuthModeNotConfigured = errors.New("claude ACP auth mode is not configured")

// ErrClaudeACPBillingVariablePresent reports that the environment Barista would hand to the
// Claude ACP adapter carries a variable that moves Claude off its locally owned subscription
// login, while the operator configured local-subscription mode.
var ErrClaudeACPBillingVariablePresent = errors.New("a billing-switching environment variable is present for local-subscription Claude ACP")

// ClaudeACPBillingSwitchingVariables are exactly claude-agent-acp's own PROVIDER_ROUTING_ENV_VARS
// (from @agentclientprotocol/claude-agent-acp 0.79.0's compiled source, package/dist/acp-agent.js):
// the variables the adapter itself reads to route a session onto an API key, AWS Bedrock, or
// Google Vertex AI backend instead of the CLI's local subscription login. Barista treats the
// presence of any one of them in the adapter's launch environment as a billing-mode change, never
// as an artifact of process success or adapter output.
var ClaudeACPBillingSwitchingVariables = []string{
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_BEDROCK_BASE_URL",
	"ANTHROPIC_VERTEX_BASE_URL",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"ANTHROPIC_VERTEX_PROJECT_ID",
	"CLOUD_ML_REGION",
	"AWS_REGION",
	"ANTHROPIC_CUSTOM_HEADERS",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"CLAUDE_CODE_OAUTH_TOKEN",
}

// ClaudeACPAuthGate decides whether the operator-configured mode permits Claude ACP to launch
// given the environment (shaped like os.Environ()) Barista would hand the adapter, and what
// authMode to advertise for it. mode must be exactly ClaudeACPAuthModeLocalSubscription or
// ClaudeACPAuthModeAPI; anything else, including an empty, unconfigured value, is refused rather
// than defaulting to either a permissive or a restrictive guess, because an administrator who
// never stated a mode has not established that this node's Claude ACP use is subscription-safe.
//
// In ClaudeACPAuthModeLocalSubscription, environment must carry none of
// ClaudeACPBillingSwitchingVariables; the returned error names only the offending variable, never
// its value, since that value may be a credential. ClaudeACPAuthModeAPI is an explicit
// acknowledgement that this node bills through the API, so the environment is not screened and the
// resulting authMode is reported as "api" rather than "local-subscription".
//
// This gate is evaluated once at ACP adapter load time, before any run, and only changes whether
// the adapter loads at all: it never inspects or alters a specific run's request.
func ClaudeACPAuthGate(mode string, environment []string) (authMode string, err error) {
	switch mode {
	case ClaudeACPAuthModeAPI:
		return ClaudeACPAuthModeAPI, nil
	case ClaudeACPAuthModeLocalSubscription:
		if variable, present := firstPresentEnvironmentVariable(ClaudeACPBillingSwitchingVariables, environment); present {
			return "", fmt.Errorf("%w: %s is set in Barista's environment, which would move Claude ACP off its local subscription login; unset it or set --claude-acp-auth-mode=api", ErrClaudeACPBillingVariablePresent, variable)
		}
		return ClaudeACPAuthModeLocalSubscription, nil
	default:
		return "", fmt.Errorf("%w: set --claude-acp-auth-mode (or BARISTA_CLAUDE_ACP_AUTH_MODE) to %q or %q", ErrClaudeACPAuthModeNotConfigured, ClaudeACPAuthModeLocalSubscription, ClaudeACPAuthModeAPI)
	}
}

// firstPresentEnvironmentVariable returns the first of names that appears, in any case, as a key
// in environment (shaped like os.Environ(), "NAME=value" entries).
func firstPresentEnvironmentVariable(names []string, environment []string) (string, bool) {
	present := map[string]bool{}
	for _, entry := range environment {
		name, _, _ := strings.Cut(entry, "=")
		present[strings.ToUpper(name)] = true
	}
	for _, name := range names {
		if present[strings.ToUpper(name)] {
			return name, true
		}
	}
	return "", false
}
