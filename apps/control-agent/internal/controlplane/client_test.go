package controlplane

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/config"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
	"nhooyr.io/websocket"
)

func TestRunOnceAuthenticatesAndRegisters(t *testing.T) {
	type receivedMessage struct {
		authorization string
		message       protocol.Outbound
		err           error
	}
	messages := make(chan receivedMessage, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		result := receivedMessage{authorization: request.Header.Get("Authorization")}
		connection, err := websocket.Accept(writer, request, nil)
		if err != nil {
			result.err = err
			messages <- result
			return
		}
		defer connection.Close(websocket.StatusNormalClosure, "test complete")
		_, data, err := connection.Read(request.Context())
		if err != nil {
			result.err = err
			messages <- result
			return
		}
		result.err = json.Unmarshal(data, &result.message)
		messages <- result
	}))
	defer server.Close()

	cfg := config.Config{
		ControlEndpoint: strings.Replace(server.URL, "http://", "ws://", 1),
		Concurrency:     2,
		Token:           "enrollment-secret",
	}
	node := protocol.ComputeNode{ID: "worker-1", Name: "Worker 1"}
	client := NewClient(cfg, node, nil)
	connected, err := client.runOnce(context.Background())
	require.Error(t, err)
	require.True(t, connected)

	got := <-messages
	require.NoError(t, got.err)
	require.Equal(t, "Bearer enrollment-secret", got.authorization)
	require.Equal(t, "register", got.message.Type)
	require.Equal(t, protocol.Version, got.message.ProtocolVersion)
	require.NotNil(t, got.message.Node)
	require.Equal(t, "worker-1", got.message.Node.ID)
}
