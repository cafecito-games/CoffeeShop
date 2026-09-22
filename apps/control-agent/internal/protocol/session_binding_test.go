package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestDispatchSessionBindingValidate(t *testing.T) {
	valid := DispatchSessionBinding{ID: "binding-one", ProviderSessionID: "provider-session-7"}
	require.NoError(t, valid.Validate())

	atBound := DispatchSessionBinding{ID: "binding-one", ProviderSessionID: "provider-session-7", ResumePrompt: strings.Repeat("a", SessionResumePromptMaximumBytes)}
	require.NoError(t, atBound.Validate())

	invalid := []struct {
		name    string
		binding DispatchSessionBinding
	}{
		{"missing id", DispatchSessionBinding{ProviderSessionID: "provider-session-7"}},
		{"missing provider session", DispatchSessionBinding{ID: "binding-one"}},
		{"secret-like provider session", DispatchSessionBinding{ID: "binding-one", ProviderSessionID: "sk-ant-api03-" + strings.Repeat("a", 40)}},
		{"secret-like id", DispatchSessionBinding{ID: "sk-ant-api03-" + strings.Repeat("a", 40), ProviderSessionID: "provider-session-7"}},
		{"resume prompt beyond the bound", DispatchSessionBinding{ID: "binding-one", ProviderSessionID: "provider-session-7", ResumePrompt: strings.Repeat("a", SessionResumePromptMaximumBytes+1)}},
		{"resume prompt that is not valid UTF-8", DispatchSessionBinding{ID: "binding-one", ProviderSessionID: "provider-session-7", ResumePrompt: "\xff\xfe"}},
	}
	for _, testCase := range invalid {
		t.Run(testCase.name, func(t *testing.T) {
			require.Error(t, testCase.binding.Validate())
		})
	}
}

func TestSessionBindingMessageValidate(t *testing.T) {
	update := SessionBindingUpdate{BindingID: "binding-one", ProviderSessionID: "provider-session-7", HarnessID: "codex-cli", Transport: "acp-v1", Status: "active"}
	require.NoError(t, NewSessionBindingMessage("run-one", update, "2026-09-21T12:00:00Z").Validate())

	invalid := []struct {
		name    string
		message SessionBindingMessage
	}{
		{"missing run id", NewSessionBindingMessage("", update, "2026-09-21T12:00:00Z")},
		{"bad timestamp", NewSessionBindingMessage("run-one", update, "yesterday")},
		{"unknown status", NewSessionBindingMessage("run-one", SessionBindingUpdate{ProviderSessionID: "provider-session-7", HarnessID: "codex-cli", Transport: "acp-v1", Status: "dormant"}, "2026-09-21T12:00:00Z")},
	}
	for _, testCase := range invalid {
		t.Run(testCase.name, func(t *testing.T) {
			require.Error(t, testCase.message.Validate())
		})
	}
}

func TestSessionBindingMessageEncodesTheExactEnvelope(t *testing.T) {
	message := NewSessionBindingMessage("run-one", SessionBindingUpdate{
		BindingID: "binding-one", ProviderSessionID: "provider-session-7", HarnessID: "codex-cli", Transport: "acp-v1", Status: "active",
	}, "2026-09-21T12:00:00Z")
	encoded, err := json.Marshal(message)
	require.NoError(t, err)
	var object map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(encoded, &object))
	require.ElementsMatch(t, []string{"type", "runId", "binding", "at"}, keysOf(object))
	var binding map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(object["binding"], &binding))
	require.ElementsMatch(t, []string{"bindingId", "providerSessionId", "harnessId", "transport", "status"}, keysOf(binding))

	replacement, err := json.Marshal(NewSessionBindingMessage("run-one", SessionBindingUpdate{
		ProviderSessionID: "provider-session-7", HarnessID: "codex-cli", Transport: "acp-v1", Status: "active",
	}, "2026-09-21T12:00:00Z"))
	require.NoError(t, err)
	var replacementObject map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(replacement, &replacementObject))
	require.ElementsMatch(t, []string{"type", "runId", "binding", "at"}, keysOf(replacementObject))
	var replacementBinding map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(replacementObject["binding"], &replacementBinding))
	require.ElementsMatch(t, []string{"providerSessionId", "harnessId", "transport", "status"}, keysOf(replacementBinding))
}

func keysOf(object map[string]json.RawMessage) []string {
	names := make([]string, 0, len(object))
	for name := range object {
		names = append(names, name)
	}
	return names
}

func TestDispatchResumeFixtureCarriesTheResumePrompt(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(fixtureDirectory, "dispatch-resume.json"))
	require.NoError(t, err)
	inbound, err := DecodeInbound(data)
	require.NoError(t, err)
	require.Equal(t, "dispatch", inbound.Type)
	require.NotNil(t, inbound.Execution)
	require.NotNil(t, inbound.Execution.SessionBinding)
	require.Equal(t, "binding-one", inbound.Execution.SessionBinding.ID)
	require.Equal(t, "provider-session-7", inbound.Execution.SessionBinding.ProviderSessionID)
	require.Equal(t, "Continue the parser work from the durable record.", inbound.Execution.SessionBinding.ResumePrompt)
	require.NoError(t, inbound.Execution.SessionBinding.Validate())
}

// declarationPattern matches the exported numeric literal declaration of a protocol bound.
var declarationPattern = regexp.MustCompile(`(?m)^\s*export const sessionResumePromptMaximumBytes = ([0-9]+(?: \* [0-9]+)*);`)

func TestSessionResumePromptMaximumBytesMatchesTypeScriptSourceOfTruth(t *testing.T) {
	source, err := os.ReadFile(filepath.Join(filepath.Dir(fixtureDirectory), "..", "..", "src", "index.ts"))
	require.NoError(t, err)
	match := declarationPattern.FindStringSubmatch(string(source))
	require.NotNil(t, match, "sessionResumePromptMaximumBytes must stay declared in the TypeScript source of truth")
	product := 1
	for _, factor := range strings.Split(match[1], "*") {
		value, err := strconv.Atoi(strings.TrimSpace(factor))
		require.NoError(t, err)
		product *= value
	}
	require.Equal(t, SessionResumePromptMaximumBytes, product)
}
