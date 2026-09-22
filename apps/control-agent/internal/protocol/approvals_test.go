package protocol

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/stretchr/testify/require"
)

func sortedKeys(object map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(object))
	for key := range object {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}

func TestApprovalUndeliverableFixtureRoundTripsAndValidates(t *testing.T) {
	fixtureBytes, _ := loadFixture(t, "approval-undeliverable")
	var message ApprovalUndeliverableMessage
	require.NoError(t, json.Unmarshal(fixtureBytes, &message))
	require.Equal(t, "approval.undeliverable", message.Type)
	require.Equal(t, "run-one", message.RunID)
	require.Equal(t, "acp-permission-1", message.ApprovalID)
	require.NoError(t, message.Validate())

	encoded, err := json.Marshal(message)
	require.NoError(t, err)
	require.JSONEq(t, string(fixtureBytes), string(encoded))
}

func TestNewApprovalUndeliverableMessageTruncatesReasonOnRuneBoundary(t *testing.T) {
	oversizeReason := strings.Repeat("é", diagnosticBytes/2+1)
	require.Greater(t, len(oversizeReason), diagnosticBytes)

	message := NewApprovalUndeliverableMessage("run-one", "approval-one", oversizeReason, "2026-09-21T12:00:00Z")
	require.LessOrEqual(t, len(message.Reason), diagnosticBytes)
	require.True(t, utf8.ValidString(message.Reason))
	require.NoError(t, message.Validate())
	require.True(t, strings.HasPrefix(oversizeReason, message.Reason))
}

func TestApprovalUndeliverableValidationFailures(t *testing.T) {
	valid := NewApprovalUndeliverableMessage("run-one", "approval-one", "no live permission request", "2026-09-21T12:00:00Z")
	negativeTests := []struct {
		name    string
		message ApprovalUndeliverableMessage
	}{
		{"empty run id", ApprovalUndeliverableMessage{
			Type: "approval.undeliverable", ApprovalID: "approval-one", Reason: "no live request", At: "2026-09-21T12:00:00Z",
		}},
		{"empty approval id", ApprovalUndeliverableMessage{
			Type: "approval.undeliverable", RunID: "run-one", Reason: "no live request", At: "2026-09-21T12:00:00Z",
		}},
		{"invalid timestamp", ApprovalUndeliverableMessage{
			Type: "approval.undeliverable", RunID: "run-one", ApprovalID: "approval-one", Reason: "no live request", At: "Sep 21 2026 12:00",
		}},
		{"oversize reason", ApprovalUndeliverableMessage{
			Type: "approval.undeliverable", RunID: "run-one", ApprovalID: "approval-one",
			Reason: strings.Repeat("a", diagnosticBytes+1), At: "2026-09-21T12:00:00Z",
		}},
	}
	for _, negativeTest := range negativeTests {
		t.Run(negativeTest.name, func(t *testing.T) {
			require.Error(t, negativeTest.message.Validate())
		})
	}
	require.NoError(t, valid.Validate())
}

func TestHarnessEventMessageEnvelopeCarriesOnlyTypeAndEvent(t *testing.T) {
	event := HarnessEvent{
		Type: "message.delta", RunID: "run-one", Sequence: 1, At: "2026-09-21T12:00:00Z", Text: "hello",
	}
	require.NoError(t, event.Validate())

	encoded, err := json.Marshal(NewHarnessEventMessage(event))
	require.NoError(t, err)
	var envelope map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(encoded, &envelope))
	require.Equal(t, []string{"event", "type"}, sortedKeys(envelope))
	require.Equal(t, `"harness.event"`, string(envelope["type"]))

	var encodedEvent map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(envelope["event"], &encodedEvent))
	require.Equal(t, []string{"at", "runId", "sequence", "text", "type"}, sortedKeys(encodedEvent))
	require.JSONEq(t, `"message.delta"`, string(encodedEvent["type"]))
}

func TestHarnessEventMessageRoundTripsPlanUpdatedFixture(t *testing.T) {
	fixtureBytes, fixtureObject := loadFixture(t, "harness-event-plan-updated")
	var event HarnessEvent
	require.NoError(t, json.Unmarshal(fixtureObject["event"], &event))
	require.NoError(t, event.Validate())

	encoded, err := json.Marshal(NewHarnessEventMessage(event))
	require.NoError(t, err)
	require.JSONEq(t, string(fixtureBytes), string(encoded))
}
