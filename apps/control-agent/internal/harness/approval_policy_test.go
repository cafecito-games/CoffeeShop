package harness

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp/acptest"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/mcpserver"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

func TestApprovalPoliciesDefaultToManual(t *testing.T) {
	var unset ApprovalPolicies
	require.Equal(t, protocol.ApprovalPolicyManual, unset.For("claude-cli"))
	policies := ApprovalPolicies{"claude-cli": protocol.ApprovalPolicyBypass, "codex-cli": "unrecognized"}
	require.Equal(t, protocol.ApprovalPolicyBypass, policies.For("claude-cli"))
	require.Equal(t, protocol.ApprovalPolicyManual, policies.For("codex-cli"), "an unrecognized policy never relaxes approvals")
	require.Equal(t, protocol.ApprovalPolicyManual, policies.For("shell"))
}

func TestACPModesFollowTheApprovalPolicy(t *testing.T) {
	tests := []struct {
		policy     string
		claudeMode string
		codexMode  string
		reportedAs string
	}{
		{policy: "", claudeMode: "default", codexMode: "read-only", reportedAs: ""},
		{policy: protocol.ApprovalPolicyManual, claudeMode: "default", codexMode: "read-only", reportedAs: ""},
		{policy: protocol.ApprovalPolicyAuto, claudeMode: "auto", codexMode: "agent", reportedAs: "auto"},
		{policy: protocol.ApprovalPolicyBypass, claudeMode: "bypassPermissions", codexMode: "agent-full-access", reportedAs: "bypass"},
	}
	for _, test := range tests {
		t.Run("policy "+test.policy, func(t *testing.T) {
			run := protocol.Run{Model: acptest.ClaudeAlternateModel}
			require.Equal(t, []acp.ConfigSelection{
				{ID: "mode", Value: test.claudeMode, Requirement: acp.ConfigPolicy},
				{ID: "model", Value: acptest.ClaudeAlternateModel, Requirement: acp.ConfigRequested},
			}, claudeSessionConfiguration(run, test.policy))
			require.Equal(t, []acp.ConfigSelection{{ID: "mode", Value: test.codexMode, Requirement: acp.ConfigPolicy}}, codexSessionConfiguration(protocol.Run{}, test.policy))
			require.Equal(t, []string{"INITIAL_AGENT_MODE=" + test.codexMode}, codexACPProvider().Environment(test.policy))
			require.Nil(t, claudeACPProvider().Environment, "claude-agent-acp takes its mode only through session configuration")
			require.Equal(t, test.reportedAs, reportedApprovalPolicy(test.policy))
		})
	}
}

func TestNativeArgumentsFollowTheApprovalPolicy(t *testing.T) {
	configuration := mcpserver.Config{URL: "http://127.0.0.1:1234/mcp", Token: "do-not-leak"}
	for _, policy := range []string{"", protocol.ApprovalPolicyManual, protocol.ApprovalPolicyAuto} {
		claude, err := harnessArguments(protocol.Run{HarnessID: "claude-cli", Model: "default", Prompt: "fix it"}, protocol.Agent{}, configuration, policy, nil)
		require.NoError(t, err)
		require.Equal(t, "auto", claude[slices.Index(claude, "--permission-mode")+1], "policy %q", policy)
		require.Equal(t, "none", claude[slices.Index(claude, "--permission-prompts")+1])

		codex, err := harnessArguments(protocol.Run{HarnessID: "codex-cli", Model: "default", Prompt: "fix it"}, protocol.Agent{}, configuration, policy, nil)
		require.NoError(t, err)
		require.Equal(t, []string{"exec", "--json", "--sandbox", "workspace-write"}, codex[:4], "policy %q", policy)
		require.NotContains(t, codex, "--dangerously-bypass-approvals-and-sandbox")
	}

	claude, err := harnessArguments(protocol.Run{HarnessID: "claude-cli", Model: "default", Prompt: "fix it"}, protocol.Agent{}, configuration, protocol.ApprovalPolicyBypass, nil)
	require.NoError(t, err)
	require.Equal(t, "bypassPermissions", claude[slices.Index(claude, "--permission-mode")+1])
	require.Equal(t, "none", claude[slices.Index(claude, "--permission-prompts")+1])

	codex, err := harnessArguments(protocol.Run{HarnessID: "codex-cli", Model: "default", Prompt: "fix it"}, protocol.Agent{}, configuration, protocol.ApprovalPolicyBypass, nil)
	require.NoError(t, err)
	require.Equal(t, []string{"exec", "--json", "--dangerously-bypass-approvals-and-sandbox"}, codex[:3])
	require.NotContains(t, codex, "--sandbox")
	require.Contains(t, codex, "mcp_servers.coffee_shop_hub.required=true")
}

// argumentRecordingNative installs a native CLI stand-in that writes its arguments, one per line,
// to the returned file.
func argumentRecordingNative(t *testing.T, harnessID string, output string) (protocol.HarnessProfile, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the native fixture is a shell script")
	}
	directory := t.TempDir()
	record := filepath.Join(directory, "arguments")
	binary := filepath.Join(directory, "native")
	script := "#!/bin/sh\nfor argument in \"$@\"; do printf '%s\\n' \"$argument\" >> '" + record + "'; done\nprintf '%s\\n' '" + output + "'\n"
	require.NoError(t, os.WriteFile(binary, []byte(script), 0o755))
	return protocol.HarnessProfile{ID: harnessID, Binary: binary, Available: true}, record
}

func TestNativeRunsExecuteAndReportTheirHarnessApprovalPolicy(t *testing.T) {
	claude, claudeRecord := argumentRecordingNative(t, "claude-cli", `{"type":"result","result":"claude native"}`)
	codex, codexRecord := argumentRecordingNative(t, "codex-cli", `{"type":"item.completed","item":{"type":"agent_message","text":"codex native"}}`)
	runner := NewRunner([]protocol.HarnessProfile{claude, codex}).WithApprovalPolicies(ApprovalPolicies{"claude-cli": protocol.ApprovalPolicyBypass})

	execute := func(harnessID string) protocol.RunTransportSelection {
		var selection protocol.RunTransportSelection
		_, err := runner.Execute(context.Background(), Invocation{
			Run:       protocol.Run{ID: "run-" + harnessID, HarnessID: harnessID, Model: "default", Prompt: "fix it"},
			Workspace: t.TempDir(),
			Started:   func(started protocol.RunTransportSelection) { selection = started },
		})
		require.NoError(t, err)
		require.NoError(t, selection.Validate())
		return selection
	}

	require.Equal(t, protocol.ApprovalPolicyBypass, execute("claude-cli").ApprovalPolicy)
	recorded, err := os.ReadFile(claudeRecord)
	require.NoError(t, err)
	require.Contains(t, string(recorded), "--permission-mode\nbypassPermissions\n")

	require.Empty(t, execute("codex-cli").ApprovalPolicy, "manual is reported by omission")
	recorded, err = os.ReadFile(codexRecord)
	require.NoError(t, err)
	require.Contains(t, string(recorded), "--sandbox\nworkspace-write\n")
	require.NotContains(t, string(recorded), "--dangerously-bypass-approvals-and-sandbox")
}

func TestAdvertiseApprovalPoliciesMarksOnlyRelaxedHarnesses(t *testing.T) {
	profiles := AdvertiseApprovalPolicies([]protocol.HarnessProfile{{ID: "claude-cli"}, {ID: "codex-cli"}, {ID: "shell"}}, ApprovalPolicies{"codex-cli": protocol.ApprovalPolicyAuto})
	require.Equal(t, []string{"", protocol.ApprovalPolicyAuto, ""}, []string{profiles[0].ApprovalPolicy, profiles[1].ApprovalPolicy, profiles[2].ApprovalPolicy})
}

func TestCodexACPRunsUnderTheConfiguredApprovalPolicy(t *testing.T) {
	for _, test := range []struct {
		policy   string
		scenario string
		mode     string
	}{
		{policy: protocol.ApprovalPolicyAuto, scenario: "codex-agent", mode: "agent"},
		{policy: protocol.ApprovalPolicyBypass, scenario: "codex-full-access", mode: "agent-full-access"},
	} {
		t.Run(test.policy, func(t *testing.T) {
			run := executeCodex(t, codexRunOptions{scenario: test.scenario, model: "default", approvalPolicies: ApprovalPolicies{"codex-cli": test.policy}})
			require.NoError(t, run.err)
			require.Equal(t, "codex done", run.result)
			setOption := acptest.ReceivedMethod(t, run.record, "session/set_config_option")
			require.Equal(t, map[string]any{"sessionId": acptest.SessionID, "configId": "mode", "value": test.mode}, setOption["params"])
			require.Equal(t, test.mode, acptest.RecordedEnvironment(t, run.record)["INITIAL_AGENT_MODE"])
			require.Len(t, run.selections, 1)
			require.Equal(t, test.policy, run.selections[0].ApprovalPolicy)
			require.NoError(t, run.selections[0].Validate())
		})
	}
}

func TestCodexACPManualRunReportsNoApprovalPolicy(t *testing.T) {
	run := executeCodex(t, codexRunOptions{scenario: "codex-success", model: "default", approvalPolicies: ApprovalPolicies{"claude-cli": protocol.ApprovalPolicyBypass}})
	require.NoError(t, run.err)
	require.Equal(t, "read-only", acptest.RecordedEnvironment(t, run.record)["INITIAL_AGENT_MODE"])
	require.Len(t, run.selections, 1)
	require.Empty(t, run.selections[0].ApprovalPolicy, "another harness's policy never applies")
}

func TestClaudeACPRunsUnderTheConfiguredApprovalPolicy(t *testing.T) {
	for _, test := range []struct {
		policy   string
		scenario string
		mode     string
	}{
		{policy: protocol.ApprovalPolicyAuto, scenario: "claude-auto", mode: "auto"},
		{policy: protocol.ApprovalPolicyBypass, scenario: "claude-bypass", mode: "bypassPermissions"},
	} {
		t.Run(test.policy, func(t *testing.T) {
			run := executeClaude(t, claudeRunOptions{scenario: test.scenario, model: "default", approvalPolicies: ApprovalPolicies{"claude-cli": test.policy}})
			require.NoError(t, run.err)
			require.Equal(t, "claude done", run.result)
			setOption := acptest.ReceivedMethod(t, run.record, "session/set_config_option")
			require.Equal(t, map[string]any{"sessionId": acptest.SessionID, "configId": "mode", "value": test.mode}, setOption["params"])
			require.Len(t, run.selections, 1)
			require.Equal(t, test.policy, run.selections[0].ApprovalPolicy)
		})
	}
}

func TestClaudeACPBypassFailsClosedWhenTheAdapterDoesNotOfferIt(t *testing.T) {
	run := executeClaude(t, claudeRunOptions{scenario: "claude-no-bypass", model: "default", approvalPolicies: ApprovalPolicies{"claude-cli": protocol.ApprovalPolicyBypass}})
	require.ErrorIs(t, run.err, acp.ErrMissingCapability)
	require.True(t, strings.Contains(run.err.Error(), "mode"), run.err.Error())
	require.Empty(t, run.selections, "the prompt was never sent")
	require.Nil(t, acptest.ReceivedMethod(t, run.record, "session/set_config_option"), "no weaker or different mode was selected instead")
}

func TestACPCapabilityFallbackKeepsTheApprovalPolicyOnTheNativeCLI(t *testing.T) {
	claudeOutput := `{"type":"result","result":"native done"}`
	codexOutput := `{"type":"item.completed","item":{"type":"agent_message","text":"native done"}}`
	tests := []struct {
		name      string
		harnessID string
		policy    string
		scenario  string
		required  []string
		forbidden []string
	}{
		{
			name: "claude bypass not offered", harnessID: "claude-cli", policy: protocol.ApprovalPolicyBypass, scenario: "claude-no-bypass",
			required: []string{"--permission-mode\nbypassPermissions\n", "--permission-prompts\nnone\n"},
		},
		{
			name: "claude bypass without config options", harnessID: "claude-cli", policy: protocol.ApprovalPolicyBypass, scenario: "claude-no-config-options",
			required: []string{"--permission-mode\nbypassPermissions\n", "--permission-prompts\nnone\n"},
		},
		{
			name: "claude auto without config options", harnessID: "claude-cli", policy: protocol.ApprovalPolicyAuto, scenario: "claude-no-config-options",
			required:  []string{"--permission-mode\nauto\n", "--permission-prompts\nnone\n"},
			forbidden: []string{"bypassPermissions"},
		},
		{
			name: "codex bypass without config options", harnessID: "codex-cli", policy: protocol.ApprovalPolicyBypass, scenario: "codex-no-config-options",
			required:  []string{"exec\n--json\n--dangerously-bypass-approvals-and-sandbox\n"},
			forbidden: []string{"--sandbox\n"},
		},
		{
			name: "codex auto without config options", harnessID: "codex-cli", policy: protocol.ApprovalPolicyAuto, scenario: "codex-no-config-options",
			required:  []string{"exec\n--json\n--sandbox\nworkspace-write\n"},
			forbidden: []string{"--dangerously-bypass-approvals-and-sandbox"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			policies := ApprovalPolicies{test.harnessID: test.policy}
			var result string
			var err error
			var selections []protocol.RunTransportSelection
			var record string
			if test.harnessID == "claude-cli" {
				native, arguments := argumentRecordingNative(t, "claude-cli", claudeOutput)
				record = arguments
				run := executeClaude(t, claudeRunOptions{
					scenario: test.scenario, model: "default", approvalPolicies: policies,
					native: []protocol.HarnessProfile{native}, fallbackTransport: TransportNative, operatorFallback: true,
				})
				result, err, selections = run.result, run.err, run.selections
				require.Nil(t, acptest.ReceivedMethod(t, run.record, "session/prompt"))
			} else {
				native, arguments := argumentRecordingNative(t, "codex-cli", codexOutput)
				record = arguments
				run := executeCodex(t, codexRunOptions{
					scenario: test.scenario, model: "default", approvalPolicies: policies,
					native: []protocol.HarnessProfile{native}, fallbackTransport: TransportNative, operatorFallback: true,
				})
				result, err, selections = run.result, run.err, run.selections
				require.Nil(t, acptest.ReceivedMethod(t, run.record, "session/prompt"))
			}

			require.NoError(t, err)
			require.Equal(t, "native done", result)
			require.Len(t, selections, 1)
			require.Equal(t, TransportACP, selections[0].RequestedTransport)
			require.Equal(t, TransportNative, selections[0].SelectedTransport)
			require.Equal(t, protocol.FallbackACPCapabilityMissing, selections[0].FallbackReason)
			require.Equal(t, test.policy, selections[0].ApprovalPolicy)
			require.NoError(t, selections[0].Validate())

			recorded, readError := os.ReadFile(record)
			require.NoError(t, readError)
			for _, required := range test.required {
				require.Contains(t, string(recorded), required)
			}
			for _, forbidden := range test.forbidden {
				require.NotContains(t, string(recorded), forbidden)
			}
		})
	}
}
