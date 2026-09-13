package protocol

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCancellationMessagesUseTypedWireContract(t *testing.T) {
	require.Equal(t, "3", Version)
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

func TestHubRPCMessagesPreserveStructuredArgumentsAndResults(t *testing.T) {
	data, err := json.Marshal(Outbound{
		Type: "hub.rpc.request", RequestID: "rpc-1", RunID: "run-one", Operation: "get_task_context",
		Arguments: json.RawMessage(`{"taskId":"run-child"}`), At: "2026-09-13T12:00:00Z",
	})
	require.NoError(t, err)
	require.JSONEq(t, `{"type":"hub.rpc.request","activeRuns":0,"requestId":"rpc-1","runId":"run-one","operation":"get_task_context","arguments":{"taskId":"run-child"},"at":"2026-09-13T12:00:00Z"}`, string(data))

	inbound, err := DecodeInbound([]byte(`{"type":"hub.rpc.response","requestId":"rpc-1","runId":"run-one","result":{"ok":true}}`))
	require.NoError(t, err)
	require.Equal(t, "rpc-1", inbound.RequestID)
	require.JSONEq(t, `{"ok":true}`, string(inbound.Result))
}

func TestDispatchPreservesDurableThreadIdentity(t *testing.T) {
	inbound, err := DecodeInbound([]byte(`{"type":"dispatch","run":{"id":"run-one","threadId":"thread-one","harnessId":"codex-cli","workspace":"/workspace","prompt":"work"}}`))
	require.NoError(t, err)
	require.Equal(t, "thread-one", inbound.Run.ThreadID)
}
