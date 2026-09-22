package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

const fixtureDirectory = "../../../../packages/protocol/test/fixtures/control-v4"

func loadFixture(t *testing.T, name string) ([]byte, map[string]json.RawMessage) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(fixtureDirectory, name+".json"))
	require.NoError(t, err)
	var object map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(data, &object))
	return data, object
}

func TestDispatchFixtureRoundTripsVersionFourExecution(t *testing.T) {
	fixtureBytes, fixtureObject := loadFixture(t, "dispatch")
	inbound, err := DecodeInbound(fixtureBytes)
	require.NoError(t, err)
	require.Equal(t, "dispatch", inbound.Type)
	require.Equal(t, "task-one", inbound.Run.TaskID)
	require.Equal(t, 1, inbound.Run.Attempt)
	require.Equal(t, "acp-v1", inbound.Run.Transport)
	require.Equal(t, "binding-one", inbound.Run.SessionBindingID)
	require.Equal(t, "lease-one", inbound.Run.WorkspaceLeaseID)
	require.NotNil(t, inbound.Execution)
	require.Equal(t, "acp-v1", inbound.Execution.Transport)
	require.Equal(t, "provider-session-7", inbound.Execution.SessionBinding.ProviderSessionID)
	require.Equal(t, "/srv/workspaces/repo/.coffee-shop/task-one", inbound.Execution.WorkspaceLease.WorktreePath)

	encoded, err := json.Marshal(inbound.Execution)
	require.NoError(t, err)
	require.JSONEq(t, string(fixtureObject["execution"]), string(encoded))
}

func TestApprovalDecisionFixtureRoundTripsAndValidates(t *testing.T) {
	fixtureBytes, fixtureObject := loadFixture(t, "approval-decision")
	inbound, err := DecodeInbound(fixtureBytes)
	require.NoError(t, err)
	require.Equal(t, "approval.decision", inbound.Type)
	require.NotNil(t, inbound.Decision)
	require.Equal(t, "approval-one", inbound.Decision.ApprovalID)
	require.Equal(t, "run-one", inbound.Decision.RunID)
	require.Equal(t, "approved", inbound.Decision.Status)
	require.NoError(t, inbound.Decision.Validate())

	encoded, err := json.Marshal(inbound.Decision)
	require.NoError(t, err)
	require.JSONEq(t, string(fixtureObject["decision"]), string(encoded))
}

func TestControlAgentFixturesRoundTripThroughOutbound(t *testing.T) {
	fixtureNames := []string{
		"register",
		"harness-event-permission-requested",
		"harness-event-plan-updated",
		"harness-event-unknown",
		"session-binding",
		"workspace-lease",
	}
	for _, fixtureName := range fixtureNames {
		t.Run(fixtureName, func(t *testing.T) {
			fixtureBytes, fixtureObject := loadFixture(t, fixtureName)
			var outbound Outbound
			require.NoError(t, json.Unmarshal(fixtureBytes, &outbound))
			if outbound.Event != nil {
				require.NoError(t, outbound.Event.Validate())
			}
			if outbound.Binding != nil {
				require.NoError(t, outbound.Binding.Validate())
			}
			if outbound.Lease != nil {
				require.NoError(t, outbound.Lease.Validate())
			}

			encoded, err := json.Marshal(outbound)
			require.NoError(t, err)
			var encodedObject map[string]json.RawMessage
			require.NoError(t, json.Unmarshal(encoded, &encodedObject))
			if _, hasActiveRuns := fixtureObject["activeRuns"]; !hasActiveRuns {
				// Go always emits activeRuns because heartbeats rely on 0 being sent; the hub ignores it on non-heartbeat messages.
				delete(encodedObject, "activeRuns")
			}
			normalized, err := json.Marshal(encodedObject)
			require.NoError(t, err)
			require.JSONEq(t, string(fixtureBytes), string(normalized))
		})
	}
}

func TestRegisterFixtureCarriesVersionFourHarnessInventory(t *testing.T) {
	_, fixtureObject := loadFixture(t, "register")
	var outbound Outbound
	require.NoError(t, json.Unmarshal(fixtureObject["node"], &outbound.Node))
	harness := outbound.Node.Harnesses[0]
	require.Equal(t, []string{"native-cli", "acp-v1"}, harness.Transports)
	require.NotNil(t, harness.ACP)
	require.True(t, harness.ACP.Prompt.Image)
	require.False(t, harness.ACP.Prompt.Audio)
	require.True(t, harness.ACP.Mcp.HTTP)
	require.Equal(t, "codex-acp", harness.ACP.AdapterName)
}

func TestProtocolVocabulariesMatchTypeScriptSourceOfTruth(t *testing.T) {
	vocabularies := []struct {
		name   string
		values []string
		actual []string
	}{
		{"HarnessTransports", []string{"native-cli", "acp-v1"}, HarnessTransports},
		{"HarnessIDs", []string{"claude-cli", "codex-cli", "shell", "ag-ui"}, HarnessIDs},
		{"HarnessEventTypes", []string{
			"message.delta", "thought.delta", "plan.updated", "tool.call", "diff", "terminal.output",
			"usage", "permission.requested", "permission.resolved", "warning", "unknown",
		}, HarnessEventTypes},
		{"ApprovalStatuses", []string{"pending", "approved", "rejected", "cancelled", "expired"}, ApprovalStatuses},
		{"ApprovalOptionKinds", []string{"allow-once", "allow-always", "reject-once", "reject-always"}, ApprovalOptionKinds},
		{"SessionBindingStatuses", []string{"active", "idle", "closed", "replaced", "failed"}, SessionBindingStatuses},
		{"WorkspaceLeaseStatuses", []string{"requested", "provisioning", "active", "released", "cleaning", "retained", "cleaned", "failed"}, WorkspaceLeaseStatuses},
		{"WorkspaceRetentionReasons", []string{"dirty", "identity-mismatch", "ambiguous", "operator-hold"}, WorkspaceRetentionReasons},
		{"PlanEntryStatuses", []string{"pending", "in-progress", "completed"}, PlanEntryStatuses},
		{"PlanEntryPriorities", []string{"high", "medium", "low"}, PlanEntryPriorities},
		{"ToolCallStatuses", []string{"pending", "in-progress", "completed", "failed"}, ToolCallStatuses},
		{"ToolCallKinds", []string{"read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"}, ToolCallKinds},
	}
	for _, vocabulary := range vocabularies {
		t.Run(vocabulary.name, func(t *testing.T) {
			require.Equal(t, vocabulary.values, vocabulary.actual)
		})
	}
}

func TestSupportsCapabilityAcrossVersions(t *testing.T) {
	cases := []struct {
		version    string
		capability string
		expected   bool
	}{
		{"1", CapabilityReplayBarrier, false},
		{"1", CapabilityHubRPC, false},
		{"1", CapabilityOrchestration, false},
		{"2", CapabilityReplayBarrier, true},
		{"2", CapabilityHubRPC, false},
		{"2", CapabilityOrchestration, false},
		{"3", CapabilityReplayBarrier, true},
		{"3", CapabilityHubRPC, true},
		{"3", CapabilityOrchestration, false},
		{"4", CapabilityReplayBarrier, true},
		{"4", CapabilityHubRPC, true},
		{"4", CapabilityOrchestration, true},
		{"5", CapabilityReplayBarrier, false},
		{"5", CapabilityHubRPC, false},
		{"5", CapabilityOrchestration, false},
		{"", CapabilityReplayBarrier, false},
		{"", CapabilityHubRPC, false},
		{"", CapabilityOrchestration, false},
		{"3", "teleport", false},
	}
	for _, testCase := range cases {
		require.Equal(t, testCase.expected, SupportsCapability(testCase.version, testCase.capability),
			"version %q capability %q", testCase.version, testCase.capability)
	}
	require.True(t, IsSupportedVersion("4"))
	require.False(t, IsSupportedVersion("5"))
	require.Equal(t, "4", LatestVersion)
}

func TestValidatorsRejectMalformedVersionFourPayloads(t *testing.T) {
	oversizeText := strings.Repeat("a", textBytes+1)
	negativeTests := []struct {
		name     string
		validate func() error
	}{
		{"event missing type", func() error {
			return HarnessEvent{RunID: "run-one", Sequence: 1, At: "2026-09-21T12:00:00Z", Text: "hello"}.Validate()
		}},
		{"event unknown type", func() error {
			return HarnessEvent{Type: "session.teleport", RunID: "run-one", Sequence: 1, At: "2026-09-21T12:00:00Z"}.Validate()
		}},
		{"event missing runId", func() error {
			return HarnessEvent{Type: "message.delta", Sequence: 1, At: "2026-09-21T12:00:00Z", Text: "hello"}.Validate()
		}},
		{"event negative sequence", func() error {
			return HarnessEvent{Type: "message.delta", RunID: "run-one", Sequence: -1, At: "2026-09-21T12:00:00Z", Text: "hello"}.Validate()
		}},
		{"event missing timestamp", func() error {
			return HarnessEvent{Type: "message.delta", RunID: "run-one", Sequence: 1, Text: "hello"}.Validate()
		}},
		{"event oversize text", func() error {
			return HarnessEvent{Type: "message.delta", RunID: "run-one", Sequence: 1, At: "2026-09-21T12:00:00Z", Text: oversizeText}.Validate()
		}},
		{"approval decision pending status", func() error {
			return ApprovalDecision{ApprovalID: "approval-one", RunID: "run-one", Status: "pending"}.Validate()
		}},
		{"approval decision approved without option", func() error {
			return ApprovalDecision{ApprovalID: "approval-one", RunID: "run-one", Status: "approved"}.Validate()
		}},
		{"approval decision cancelled with option", func() error {
			return ApprovalDecision{ApprovalID: "approval-one", RunID: "run-one", Status: "cancelled", SelectedOptionID: "allow-once"}.Validate()
		}},
		{"workspace lease retained without reason", func() error {
			return WorkspaceLeaseUpdate{LeaseID: "lease-one", Status: "retained"}.Validate()
		}},
		{"workspace lease active with reason", func() error {
			return WorkspaceLeaseUpdate{LeaseID: "lease-one", Status: "active", RetentionReason: "dirty"}.Validate()
		}},
	}
	for _, negativeTest := range negativeTests {
		t.Run(negativeTest.name, func(t *testing.T) {
			require.Error(t, negativeTest.validate())
		})
	}
}

func TestHarnessEventEncodesRequiredEmptyFieldsAndOnlyItsVariantKeys(t *testing.T) {
	cases := map[string]struct {
		event    HarnessEvent
		expected string
	}{
		"empty message text": {
			event:    HarnessEvent{Type: "message.delta", RunID: "run-one", At: "2026-09-21T12:00:00Z"},
			expected: `{"type":"message.delta","runId":"run-one","sequence":0,"at":"2026-09-21T12:00:00Z","text":""}`,
		},
		"cleared plan": {
			event:    HarnessEvent{Type: "plan.updated", RunID: "run-one", Sequence: 2, At: "2026-09-21T12:00:00Z"},
			expected: `{"type":"plan.updated","runId":"run-one","sequence":2,"at":"2026-09-21T12:00:00Z","entries":[]}`,
		},
		"diff emptying a file drops fields from other variants": {
			event:    HarnessEvent{Type: "diff", RunID: "run-one", Sequence: 3, At: "2026-09-21T12:00:00Z", Path: "README.md", OldText: "old", Status: "completed"},
			expected: `{"type":"diff","runId":"run-one","sequence":3,"at":"2026-09-21T12:00:00Z","path":"README.md","oldText":"old","newText":""}`,
		},
		"zero usage counts": {
			event:    HarnessEvent{Type: "usage", RunID: "run-one", Sequence: 4, At: "2026-09-21T12:00:00Z", InputTokens: new(int64)},
			expected: `{"type":"usage","runId":"run-one","sequence":4,"at":"2026-09-21T12:00:00Z","inputTokens":0}`,
		},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			data, err := json.Marshal(testCase.event)
			require.NoError(t, err)
			require.JSONEq(t, testCase.expected, string(data))
		})
	}

	_, err := json.Marshal(HarnessEvent{Type: "session.teleport", RunID: "run-one"})
	require.Error(t, err)
}

func TestHarnessEventValidationAcceptsClearedPlanAndRequiresTimestamps(t *testing.T) {
	cleared := HarnessEvent{Type: "plan.updated", RunID: "run-one", Sequence: 2, At: "2026-09-21T12:00:00Z"}
	require.NoError(t, cleared.Validate())

	undated := HarnessEvent{Type: "warning", RunID: "run-one", Sequence: 1, At: "yesterday", Code: "stalled", Message: "No output"}
	require.Error(t, undated.Validate())
}
