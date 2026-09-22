package controlplane

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/config"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/mcpserver"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
	"nhooyr.io/websocket"
)

func newTestClient() *Client {
	return NewClient(config.Config{Concurrency: 1}, protocol.ComputeNode{ID: "node-one"}, nil, emptyCapabilityReport)
}

func websocketURL(server *httptest.Server) string {
	return strings.Replace(server.URL, "http://", "ws://", 1)
}

func TestCallHubWithoutConnectionReportsRetryableHubUnavailable(t *testing.T) {
	client := newTestClient()

	result, err := client.callHub(context.Background(), "run-one", "get_task_context", json.RawMessage(`{}`))

	require.Nil(t, result)
	require.Error(t, err)
	var toolError *mcpserver.ToolError
	require.True(t, errors.As(err, &toolError))
	require.Equal(t, "hub_unavailable", toolError.Code)
	require.True(t, toolError.Retryable)
	client.pendingMu.Lock()
	defer client.pendingMu.Unlock()
	require.Empty(t, client.pending)
}

func TestResolveRPCDeliversErrorsAndResultsToPendingRequests(t *testing.T) {
	client := newTestClient()
	errorChannel := make(chan rpcResult, 1)
	resultChannel := make(chan rpcResult, 1)
	client.pendingMu.Lock()
	client.pending["rpc-error"] = errorChannel
	client.pending["rpc-result"] = resultChannel
	client.pendingMu.Unlock()

	client.resolveRPC(protocol.Inbound{
		Type:      "hub.rpc.response",
		RequestID: "rpc-error",
		RPCError:  &protocol.HubRPCError{Code: "not_found", Message: "m", Retryable: false},
	})
	received := <-errorChannel
	require.Nil(t, received.result)
	var toolError *mcpserver.ToolError
	require.True(t, errors.As(received.err, &toolError))
	require.Equal(t, "not_found", toolError.Code)
	require.Equal(t, "m", toolError.Message)
	require.False(t, toolError.Retryable)

	client.resolveRPC(protocol.Inbound{
		Type:      "hub.rpc.response",
		RequestID: "rpc-result",
		Result:    json.RawMessage(`{"ok":true}`),
	})
	delivered := <-resultChannel
	require.NoError(t, delivered.err)
	require.JSONEq(t, `{"ok":true}`, string(delivered.result))

	client.resolveRPC(protocol.Inbound{Type: "hub.rpc.response", RequestID: "rpc-unknown", Result: json.RawMessage(`{}`)})
	client.pendingMu.Lock()
	defer client.pendingMu.Unlock()
	require.Empty(t, client.pending)
}

func TestDetachFailsPendingRequestsAsRetryableHubUnavailable(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(writer, request, nil)
		if err != nil {
			return
		}
		defer connection.Close(websocket.StatusNormalClosure, "test complete")
		<-release
	}))
	t.Cleanup(func() {
		close(release)
		server.Close()
	})

	client := newTestClient()
	dialContext, cancelDial := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancelDial()
	connection, _, err := websocket.Dial(dialContext, websocketURL(server), nil)
	require.NoError(t, err)
	t.Cleanup(func() { connection.Close(websocket.StatusNormalClosure, "test complete") })

	client.connection = connection
	response := make(chan rpcResult, 1)
	client.pendingMu.Lock()
	client.pending["rpc-1"] = response
	client.pendingMu.Unlock()

	client.detach(connection)

	received := <-response
	require.Nil(t, received.result)
	var toolError *mcpserver.ToolError
	require.True(t, errors.As(received.err, &toolError))
	require.Equal(t, "hub_unavailable", toolError.Code)
	require.True(t, toolError.Retryable)
	client.pendingMu.Lock()
	require.Empty(t, client.pending)
	client.pendingMu.Unlock()
	require.Nil(t, client.connection)
}

func TestCallHubRoundTripsRequestOverWebSocket(t *testing.T) {
	requests := make(chan protocol.Outbound, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(writer, request, nil)
		if err != nil {
			return
		}
		defer connection.Close(websocket.StatusNormalClosure, "test complete")
		_, data, err := connection.Read(request.Context())
		if err != nil {
			return
		}
		var message protocol.Outbound
		if err := json.Unmarshal(data, &message); err != nil {
			return
		}
		requests <- message
	}))
	defer server.Close()

	client := newTestClient()
	dialContext, cancelDial := context.WithTimeout(context.Background(), 3*time.Second)
	connection, _, err := websocket.Dial(dialContext, websocketURL(server), nil)
	cancelDial()
	require.NoError(t, err)
	defer connection.Close(websocket.StatusNormalClosure, "test complete")
	client.connection = connection

	type callOutcome struct {
		result json.RawMessage
		err    error
	}
	done := make(chan callOutcome, 1)
	go func() {
		result, err := client.callHub(context.Background(), "run-one", "send_task_message", json.RawMessage(`{"body":"hello"}`))
		done <- callOutcome{result: result, err: err}
	}()

	sent := <-requests
	require.Equal(t, "hub.rpc.request", sent.Type)
	require.Equal(t, "run-one", sent.RunID)
	require.Equal(t, "send_task_message", sent.Operation)
	require.JSONEq(t, `{"body":"hello"}`, string(sent.Arguments))

	client.resolveRPC(protocol.Inbound{
		Type:      "hub.rpc.response",
		RequestID: sent.RequestID,
		Result:    json.RawMessage(`{"ok":true}`),
	})
	outcome := <-done
	require.NoError(t, outcome.err)
	require.JSONEq(t, `{"ok":true}`, string(outcome.result))
}

func TestCallHubReturnsContextCanceledWhenCancelledBeforeResponse(t *testing.T) {
	requests := make(chan protocol.Outbound, 1)
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(writer, request, nil)
		if err != nil {
			return
		}
		defer connection.Close(websocket.StatusNormalClosure, "test complete")
		_, data, err := connection.Read(request.Context())
		if err != nil {
			return
		}
		var message protocol.Outbound
		if json.Unmarshal(data, &message) != nil {
			return
		}
		requests <- message
		// Keep the connection open so only the cancelled context can end the call.
		<-release
	}))
	t.Cleanup(func() {
		close(release)
		server.Close()
	})

	client := newTestClient()
	dialContext, cancelDial := context.WithTimeout(context.Background(), 3*time.Second)
	connection, _, err := websocket.Dial(dialContext, websocketURL(server), nil)
	cancelDial()
	require.NoError(t, err)
	defer connection.Close(websocket.StatusNormalClosure, "test complete")
	client.connection = connection

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := client.callHub(ctx, "run-one", "update_task", json.RawMessage(`{}`))
		done <- err
	}()

	<-requests
	cancel()
	require.ErrorIs(t, <-done, context.Canceled)
	client.pendingMu.Lock()
	defer client.pendingMu.Unlock()
	require.Empty(t, client.pending)
}

func TestHubRequestTimeoutExceedsLongestWaitWithMargin(t *testing.T) {
	require.Greater(t,
		hubRequestTimeout,
		time.Duration(protocol.MaximumWaitMilliseconds)*time.Millisecond+5*time.Second,
		"a wait_for_task_events long-poll must always answer before the hub RPC timeout",
	)
}
