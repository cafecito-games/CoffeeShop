package protocol

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCancellationMessagesUseTypedWireContract(t *testing.T) {
	require.Equal(t, "2", Version)
	inbound, err := DecodeInbound([]byte(`{"type":"cancel","runId":"run-one"}`))
	require.NoError(t, err)
	require.Equal(t, "cancel", inbound.Type)
	require.Equal(t, "run-one", inbound.RunID)

	data, err := json.Marshal(Outbound{Type: "run.cancelled", RunID: "run-one", At: "2026-09-11T12:00:00Z"})
	require.NoError(t, err)
	require.JSONEq(t, `{"type":"run.cancelled","runId":"run-one","activeRuns":0,"at":"2026-09-11T12:00:00Z"}`, string(data))
}

func TestSyncCompleteMessageFollowsRegistrationAndOutbox(t *testing.T) {
	data, err := json.Marshal(Outbound{Type: "sync.complete", NodeID: "node-one", ActiveRunIDs: []string{"run-one"}, At: "2026-09-11T12:00:00Z"})
	require.NoError(t, err)
	require.JSONEq(t, `{"type":"sync.complete","nodeId":"node-one","activeRuns":0,"activeRunIds":["run-one"],"at":"2026-09-11T12:00:00Z"}`, string(data))
}
