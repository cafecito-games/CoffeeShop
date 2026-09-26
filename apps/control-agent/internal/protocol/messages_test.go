package protocol

import (
	"encoding/json"
	"sort"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCancellationMessagesUseTypedWireContract(t *testing.T) {
	require.Equal(t, "5", Version)
	inbound, err := DecodeInbound([]byte(`{"type":"cancel","runId":"run-one"}`))
	require.NoError(t, err)
	require.Equal(t, "cancel", inbound.Type)
	require.Equal(t, "run-one", inbound.RunID)

	data, err := json.Marshal(Outbound{Type: "run.cancelled", RunID: "run-one", At: "2026-09-11T12:00:00Z"})
	require.NoError(t, err)
	require.JSONEq(t, `{"type":"run.cancelled","runId":"run-one","at":"2026-09-11T12:00:00Z"}`, string(data))
}

func TestSyncCompleteMessageFollowsRegistrationAndOutbox(t *testing.T) {
	activeRunIDs := []string{"run-one"}
	data, err := json.Marshal(Outbound{Type: "sync.complete", NodeID: "node-one", ActiveRunIDs: &activeRunIDs, At: "2026-09-11T12:00:00Z"})
	require.NoError(t, err)
	require.JSONEq(t, `{"type":"sync.complete","nodeId":"node-one","activeRunIds":["run-one"],"at":"2026-09-11T12:00:00Z"}`, string(data))
}

func TestSyncCompleteWithNoActiveRunsEncodesAnEmptyActiveRunIDsArray(t *testing.T) {
	// The hub distinguishes "Barista reported its active set and it is empty" from "the field was
	// absent"; only the former lets it redispatch queued runs immediately, so an empty set must
	// encode as [] rather than being dropped by omitempty.
	activeRunIDs := []string{}
	data, err := json.Marshal(Outbound{Type: "sync.complete", NodeID: "node-one", ActiveRunIDs: &activeRunIDs, At: "2026-09-11T12:00:00Z"})
	require.NoError(t, err)
	// activeRuns is absent because only heartbeat's contract carries it; the v5 sync.complete
	// contract makes it optional and the hub reads only activeRunIds here. The subject of this
	// test is that an empty activeRunIds still encodes as [] rather than being omitted.
	require.JSONEq(t, `{"type":"sync.complete","nodeId":"node-one","activeRunIds":[],"at":"2026-09-11T12:00:00Z"}`, string(data))
}

func TestHeartbeatOmitsActiveRunIDs(t *testing.T) {
	data, err := json.Marshal(Outbound{Type: "heartbeat", NodeID: "node-one", ActiveRuns: instancePointer(2), At: "2026-09-11T12:00:00Z"})
	require.NoError(t, err)
	require.NotContains(t, string(data), "activeRunIds")
	require.JSONEq(t, `{"type":"heartbeat","nodeId":"node-one","activeRuns":2,"at":"2026-09-11T12:00:00Z"}`, string(data))
}

func TestHubRPCMessagesPreserveStructuredArgumentsAndResults(t *testing.T) {
	data, err := json.Marshal(Outbound{
		Type: "hub.rpc.request", RequestID: "rpc-1", RunID: "run-one", Operation: "get_task_context",
		Arguments: json.RawMessage(`{"taskId":"run-child"}`), At: "2026-09-13T12:00:00Z",
	})
	require.NoError(t, err)
	require.JSONEq(t, `{"type":"hub.rpc.request","requestId":"rpc-1","runId":"run-one","operation":"get_task_context","arguments":{"taskId":"run-child"},"at":"2026-09-13T12:00:00Z"}`, string(data))

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

// TestRegisterCarriesOnlyTheKeysItsContractAdmits pins the exact top-level key set of the frame
// controlplane.Client.attach writes. The v5 register contract admits type, protocolVersion and node
// and nothing else, so a fourth key makes a v5 hub close the socket with "invalid v5 registration"
// and the node never comes online. That is what a non-pointer Outbound.ActiveRuns caused: it put
// "activeRuns":0 on every message, which heartbeat requires, sync.complete tolerates as optional,
// and register is refused for. Asserting the whole key set rather than the absence of one field
// means any future non-omitempty addition to Outbound fails here instead of in the system suite.
// TestZeroHeartbeatStillEncodesActiveRuns pins the property this fix depends on at the JSON layer:
// heartbeat's v5 contract requires activeRuns, so an idle node reporting zero must still encode the
// field. omitempty on a *int drops only nil, but asserting the encoded bytes means a future change
// to a value type with omitempty -- which would drop a zero -- fails here rather than silently
// removing a required field from every idle heartbeat.
func TestZeroHeartbeatStillEncodesActiveRuns(t *testing.T) {
	activeRuns := 0
	activeInstances := 0
	activeInstanceIDs := []string{}
	data, err := json.Marshal(Outbound{Type: "heartbeat", NodeID: "node-one", ActiveRuns: &activeRuns,
		ActiveInstances: &activeInstances, ActiveInstanceIDs: &activeInstanceIDs, At: "2026-09-11T12:00:00Z"})
	require.NoError(t, err)
	require.Contains(t, string(data), `"activeRuns":0`, "heartbeat must encode a zero activeRuns; its contract requires the field")
	require.JSONEq(t, `{"type":"heartbeat","nodeId":"node-one","activeRuns":0,"activeInstances":0,"activeInstanceIds":[],"at":"2026-09-11T12:00:00Z"}`, string(data))
}

func TestRegisterCarriesOnlyTheKeysItsContractAdmits(t *testing.T) {
	activeInstances := 0
	data, err := json.Marshal(Outbound{Type: "register", ProtocolVersion: LatestVersion, Node: &ComputeNode{
		ID: "node-one", Name: "Build Mac", Kind: "local", Platform: "darwin/arm64", Status: "online",
		LastSeen: "2026-09-11T12:00:00Z", ActiveRuns: 0, Concurrency: 2, ActiveInstances: &activeInstances,
		WorkspaceRoots: []string{"/workspace"}, Version: "0.1.0",
		Harnesses: []HarnessProfile{{ID: "claude-cli", Label: "Claude", Description: "Local account", Available: true, AuthMode: "local-subscription", Models: []string{"fable"}}},
	}})
	require.NoError(t, err)
	var frame map[string]any
	require.NoError(t, json.Unmarshal(data, &frame))
	keys := make([]string, 0, len(frame))
	for key := range frame {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	require.Equal(t, []string{"node", "protocolVersion", "type"}, keys,
		"register must carry exactly the keys its v5 contract admits; a v5 hub refuses any other key")
	// The node's own activeRuns is a different field and stays required inside node.
	require.Contains(t, frame["node"], "activeRuns")
}
