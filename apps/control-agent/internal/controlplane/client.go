package controlplane

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/rand/v2"
	"net/http"
	"sync"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/config"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/harness"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"nhooyr.io/websocket"
)

type Client struct {
	config config.Config
	node   protocol.ComputeNode
	runner *harness.Runner

	connectionMu sync.Mutex
	connection   *websocket.Conn
	outbox       [][]byte
	runsMu       sync.Mutex
	runs         map[string]context.CancelFunc
}

func NewClient(cfg config.Config, node protocol.ComputeNode, runner *harness.Runner) *Client {
	return &Client{config: cfg, node: node, runner: runner, runs: map[string]context.CancelFunc{}}
}

func (client *Client) Run(ctx context.Context) error {
	backoff := time.Second
	for {
		connected, err := client.runOnce(ctx)
		if err != nil && ctx.Err() == nil {
			log.Printf("control-plane session ended: %v", err)
		}
		if connected {
			backoff = time.Second
		}
		if ctx.Err() != nil {
			client.cancelRuns()
			return ctx.Err()
		}
		delay := backoff + time.Duration(rand.IntN(500))*time.Millisecond
		log.Printf("reconnecting in %s", delay.Round(time.Millisecond))
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			client.cancelRuns()
			return ctx.Err()
		}
		backoff *= 2
		if backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
	}
}

func (client *Client) runOnce(ctx context.Context) (bool, error) {
	headers := http.Header{}
	if client.config.Token != "" {
		headers.Set("Authorization", "Bearer "+client.config.Token)
	}
	dialContext, cancelDial := context.WithTimeout(ctx, 15*time.Second)
	connection, _, err := websocket.Dial(dialContext, client.config.ControlEndpoint, &websocket.DialOptions{HTTPHeader: headers})
	cancelDial()
	if err != nil {
		return false, fmt.Errorf("connect to %s: %w", client.config.ControlEndpoint, err)
	}
	connection.SetReadLimit(2 * 1024 * 1024)
	registrationContext, cancelRegistration := context.WithTimeout(ctx, 10*time.Second)
	err = client.attach(registrationContext, connection)
	cancelRegistration()
	if err != nil {
		connection.Close(websocket.StatusInternalError, "registration failed")
		return false, err
	}
	defer client.detach(connection)
	defer connection.Close(websocket.StatusNormalClosure, "session ended")
	log.Printf("Barista %q connected to %s", client.node.Name, client.config.ControlEndpoint)

	heartbeatCtx, cancelHeartbeat := context.WithCancel(ctx)
	defer cancelHeartbeat()
	go client.heartbeat(heartbeatCtx)

	for {
		_, data, err := connection.Read(ctx)
		if err != nil {
			return true, err
		}
		message, err := protocol.DecodeInbound(data)
		if err != nil {
			log.Printf("ignore invalid control-plane message: %v", err)
			continue
		}
		client.handle(ctx, message)
	}
}

func (client *Client) attach(ctx context.Context, connection *websocket.Conn) error {
	client.connectionMu.Lock()
	defer client.connectionMu.Unlock()
	client.connection = connection
	registrationNode := client.node
	registrationNode.ActiveRuns = client.activeRuns()
	registrationNode.LastSeen = now()
	registration := protocol.Outbound{Type: "register", ProtocolVersion: protocol.Version, Node: &registrationNode}
	if err := write(ctx, connection, registration); err != nil {
		client.connection = nil
		return err
	}
	for len(client.outbox) > 0 {
		if err := writeBytes(ctx, connection, client.outbox[0]); err != nil {
			client.connection = nil
			return err
		}
		client.outbox = client.outbox[1:]
	}
	return nil
}

func (client *Client) detach(connection *websocket.Conn) {
	client.connectionMu.Lock()
	defer client.connectionMu.Unlock()
	if client.connection == connection {
		client.connection = nil
	}
}

func (client *Client) send(message protocol.Outbound) {
	data, err := json.Marshal(message)
	if err != nil {
		log.Printf("encode outbound message: %v", err)
		return
	}
	client.connectionMu.Lock()
	defer client.connectionMu.Unlock()
	if client.connection == nil {
		client.outbox = append(client.outbox, data)
		return
	}
	writeContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := writeBytes(writeContext, client.connection, data); err != nil {
		client.outbox = append(client.outbox, data)
		client.connection = nil
	}
}

func (client *Client) heartbeat(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			client.send(protocol.Outbound{Type: "heartbeat", NodeID: client.node.ID, ActiveRuns: client.activeRuns(), At: now()})
		case <-ctx.Done():
			return
		}
	}
}

func (client *Client) handle(ctx context.Context, message protocol.Inbound) {
	switch message.Type {
	case "ping":
		client.send(protocol.Outbound{Type: "heartbeat", NodeID: client.node.ID, ActiveRuns: client.activeRuns(), At: now()})
	case "cancel":
		client.runsMu.Lock()
		cancel := client.runs[message.RunID]
		client.runsMu.Unlock()
		if cancel != nil {
			cancel()
		}
	case "dispatch":
		client.dispatch(ctx, message.Run, message.Agent)
	default:
		log.Printf("ignore unknown control-plane message type %q", message.Type)
	}
}

func (client *Client) dispatch(ctx context.Context, run protocol.Run, agent protocol.Agent) {
	client.runsMu.Lock()
	if _, exists := client.runs[run.ID]; exists {
		client.runsMu.Unlock()
		return
	}
	if len(client.runs) >= client.config.Concurrency {
		client.runsMu.Unlock()
		client.send(protocol.Outbound{Type: "run.failed", RunID: run.ID, Error: fmt.Sprintf("Barista concurrency limit (%d) reached", client.config.Concurrency), At: now()})
		return
	}
	runContext, cancel := context.WithCancel(ctx)
	client.runs[run.ID] = cancel
	client.runsMu.Unlock()

	go func() {
		defer func() {
			client.runsMu.Lock()
			delete(client.runs, run.ID)
			client.runsMu.Unlock()
			cancel()
		}()
		workspace, err := harness.AuthorizeWorkspace(run.Workspace, client.config.WorkspaceRoots)
		if err != nil {
			client.send(protocol.Outbound{Type: "run.failed", RunID: run.ID, Error: err.Error(), At: now()})
			return
		}
		client.send(protocol.Outbound{Type: "run.started", RunID: run.ID, At: now()})
		result, err := client.runner.Run(runContext, run, agent, workspace, func(chunk string) {
			client.send(protocol.Outbound{Type: "run.output", RunID: run.ID, Chunk: chunk, At: now()})
		})
		if err != nil {
			if errors.Is(runContext.Err(), context.Canceled) {
				return
			}
			client.send(protocol.Outbound{Type: "run.failed", RunID: run.ID, Error: err.Error(), At: now()})
			return
		}
		client.send(protocol.Outbound{Type: "run.completed", RunID: run.ID, Output: result, At: now()})
	}()
}

func (client *Client) activeRuns() int {
	client.runsMu.Lock()
	defer client.runsMu.Unlock()
	return len(client.runs)
}

func (client *Client) cancelRuns() {
	client.runsMu.Lock()
	defer client.runsMu.Unlock()
	for _, cancel := range client.runs {
		cancel()
	}
}

func write(ctx context.Context, connection *websocket.Conn, message protocol.Outbound) error {
	data, err := json.Marshal(message)
	if err != nil {
		return err
	}
	return writeBytes(ctx, connection, data)
}

func writeBytes(ctx context.Context, connection *websocket.Conn, data []byte) error {
	return connection.Write(ctx, websocket.MessageText, data)
}

func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }
