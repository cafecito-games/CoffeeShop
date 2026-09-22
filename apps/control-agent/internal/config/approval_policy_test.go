package config

import (
	"testing"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/harness"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

func parseApprovalPolicies(t *testing.T, environment string, arguments ...string) (Config, error) {
	t.Helper()
	t.Setenv("WORKSPACE_ROOTS", absoluteExistingRoot(t))
	t.Setenv("BARISTA_APPROVAL_POLICY", environment)
	flags := append([]string{}, acpBaseArguments...)
	for _, argument := range arguments {
		flags = append(flags, "--approval-policy", argument)
	}
	return Parse(flags)
}

func TestParseDefaultsEveryHarnessToTheManualApprovalPolicy(t *testing.T) {
	parsed, err := parseApprovalPolicies(t, "")
	require.NoError(t, err)
	require.Empty(t, parsed.ApprovalPolicies)
	for _, harnessID := range harness.ApprovalPolicyHarnessIDs {
		require.Equal(t, protocol.ApprovalPolicyManual, parsed.ApprovalPolicies.For(harnessID))
	}
}

func TestParseResolvesApprovalPolicies(t *testing.T) {
	tests := []struct {
		name        string
		environment string
		arguments   []string
		expected    harness.ApprovalPolicies
	}{
		{name: "node-wide flag", arguments: []string{"auto"}, expected: harness.ApprovalPolicies{"claude-cli": "auto", "codex-cli": "auto"}},
		{name: "node-wide manual", arguments: []string{"manual"}, expected: harness.ApprovalPolicies{}},
		{name: "per-harness flag", arguments: []string{"claude-cli=bypass"}, expected: harness.ApprovalPolicies{"claude-cli": "bypass"}},
		{name: "repeated per-harness flags", arguments: []string{"claude-cli=bypass", "codex-cli=auto"}, expected: harness.ApprovalPolicies{"claude-cli": "bypass", "codex-cli": "auto"}},
		{name: "per-harness overrides node-wide after it", arguments: []string{"auto", "codex-cli=bypass"}, expected: harness.ApprovalPolicies{"claude-cli": "auto", "codex-cli": "bypass"}},
		{name: "per-harness overrides node-wide before it", arguments: []string{"codex-cli=manual", "bypass"}, expected: harness.ApprovalPolicies{"claude-cli": "bypass"}},
		{name: "identical repeats are harmless", arguments: []string{"auto", "auto", "claude-cli=bypass", "claude-cli=bypass"}, expected: harness.ApprovalPolicies{"claude-cli": "bypass", "codex-cli": "auto"}},
		{name: "environment list", environment: "auto, claude-cli=bypass", expected: harness.ApprovalPolicies{"claude-cli": "bypass", "codex-cli": "auto"}},
		{name: "environment combined with flags", environment: "codex-cli=auto", arguments: []string{"claude-cli=bypass"}, expected: harness.ApprovalPolicies{"claude-cli": "bypass", "codex-cli": "auto"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			parsed, err := parseApprovalPolicies(t, test.environment, test.arguments...)
			require.NoError(t, err)
			require.Equal(t, test.expected, parsed.ApprovalPolicies)
		})
	}
}

func TestParseRejectsInvalidApprovalPolicies(t *testing.T) {
	tests := []struct {
		name        string
		environment string
		arguments   []string
		expected    string
	}{
		{name: "unknown level", arguments: []string{"yolo"}, expected: "approval policy at index 0 must be manual, auto, bypass"},
		{name: "unknown level for a harness", arguments: []string{"claude-cli=acceptEdits"}, expected: "approval policy at index 0 must be manual, auto, bypass"},
		{name: "unknown harness", arguments: []string{"gemini-cli=auto"}, expected: "approval policy at index 0 must name one of the harnesses claude-cli, codex-cli"},
		{name: "harness Barista does not execute", arguments: []string{"shell=bypass"}, expected: "approval policy at index 0 must name one of the harnesses claude-cli, codex-cli"},
		{name: "empty harness", arguments: []string{"=auto"}, expected: "approval policy at index 0 must name one of the harnesses claude-cli, codex-cli"},
		{name: "empty entry", arguments: []string{""}, expected: "approval policy at index 0 is empty"},
		{name: "empty environment entry", environment: "auto,", expected: "approval policy at index 1 is empty"},
		{name: "conflicting node-wide policies", arguments: []string{"auto", "bypass"}, expected: "approval policy at index 1 conflicts with an earlier node-wide approval policy"},
		{name: "conflicting per-harness policies", arguments: []string{"claude-cli=auto", "codex-cli=auto", "claude-cli=manual"}, expected: "approval policy at index 2 conflicts with an earlier approval policy for claude-cli"},
		{name: "environment conflicts with a flag", environment: "claude-cli=bypass", arguments: []string{"claude-cli=auto"}, expected: "approval policy at index 1 conflicts with an earlier approval policy for claude-cli"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := parseApprovalPolicies(t, test.environment, test.arguments...)
			require.EqualError(t, err, test.expected)
		})
	}
}
