package controlplane

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/config"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/harness"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/mcpserver"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"nhooyr.io/websocket"
)

type Client struct {
	config                config.Config
	node                  protocol.ComputeNode
	runner                *harness.Runner
	bridge                *mcpserver.Server
	buildCapabilityReport func(context.Context) protocol.NodeCapabilityReport

	connectionMu sync.Mutex
	connection   *websocket.Conn
	outbox       [][]byte
	runsMu       sync.Mutex
	runs         map[string]context.CancelFunc
	cancelled    map[string]struct{}
	pendingMu    sync.Mutex
	pending      map[string]chan rpcResult
	requestID    atomic.Uint64
}

type rpcResult struct {
	result json.RawMessage
	err    error
}

func NewClient(cfg config.Config, node protocol.ComputeNode, runner *harness.Runner, buildCapabilityReport func(context.Context) protocol.NodeCapabilityReport) *Client {
	client := &Client{
		config: cfg, node: node, runner: runner, buildCapabilityReport: buildCapabilityReport,
		runs: map[string]context.CancelFunc{}, cancelled: map[string]struct{}{}, pending: map[string]chan rpcResult{},
	}
	client.bridge = mcpserver.New(client.callHub, client.uploadArtifact)
	return client
}

func (client *Client) Run(ctx context.Context) error {
	if err := client.bridge.Start(ctx); err != nil {
		return err
	}
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
	go client.capabilityReportLoop(heartbeatCtx)

	// Sent through client.send so a disconnected connection queues the report in the outbox and
	// replays it on the next successful attach, giving resend-after-reconnect for free.
	capabilityReport := client.buildCapabilityReport(ctx)
	client.send(protocol.Outbound{Type: "capability.report", Report: &capabilityReport})

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
		if message.Type == "hub.rpc.response" {
			client.resolveRPC(message)
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
	return write(ctx, connection, protocol.Outbound{Type: "sync.complete", NodeID: client.node.ID, ActiveRunIDs: client.activeRunIDs(), At: now()})
}

func (client *Client) detach(connection *websocket.Conn) {
	client.connectionMu.Lock()
	defer client.connectionMu.Unlock()
	if client.connection == connection {
		client.connection = nil
		client.failPending(errors.New("control plane disconnected"))
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

func (client *Client) capabilityReportLoop(ctx context.Context) {
	ticker := time.NewTicker(15 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			report := client.buildCapabilityReport(ctx)
			client.send(protocol.Outbound{Type: "capability.report", Report: &report})
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
		client.cancelled[message.RunID] = struct{}{}
		cancel := client.runs[message.RunID]
		client.runsMu.Unlock()
		if cancel != nil {
			cancel()
		} else {
			client.send(protocol.Outbound{Type: "run.cancelled", RunID: message.RunID, At: now()})
		}
	case "dispatch":
		client.dispatch(ctx, message.Run, message.Agent)
	default:
		log.Printf("ignore unknown control-plane message type %q", message.Type)
	}
}

func (client *Client) dispatch(ctx context.Context, run protocol.Run, agent protocol.Agent) {
	client.runsMu.Lock()
	if _, cancelled := client.cancelled[run.ID]; cancelled {
		client.runsMu.Unlock()
		return
	}
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
			_, cancelled := client.cancelled[run.ID]
			client.runsMu.Unlock()
			cancel()
			if cancelled {
				client.send(protocol.Outbound{Type: "run.cancelled", RunID: run.ID, At: now()})
			}
		}()
		workspace, err := harness.AuthorizeWorkspace(run.Workspace, client.config.WorkspaceRoots)
		if err != nil {
			client.send(protocol.Outbound{Type: "run.failed", RunID: run.ID, Error: err.Error(), At: now()})
			return
		}
		if runContext.Err() != nil {
			return
		}
		capability, err := client.bridge.Grant(run.ID, workspace, agent.CanDelegate)
		if err != nil {
			client.send(protocol.Outbound{Type: "run.failed", RunID: run.ID, Error: err.Error(), At: now()})
			return
		}
		defer client.bridge.Revoke(capability.Token)
		client.send(protocol.Outbound{Type: "run.started", RunID: run.ID, At: now()})
		result, err := client.runner.Run(runContext, run, agent, workspace, capability, func(chunk string) {
			if runContext.Err() != nil {
				return
			}
			client.send(protocol.Outbound{Type: "run.output", RunID: run.ID, Chunk: chunk, At: now()})
		})
		if err != nil {
			if errors.Is(runContext.Err(), context.Canceled) {
				return
			}
			client.send(protocol.Outbound{Type: "run.failed", RunID: run.ID, Error: err.Error(), At: now()})
			return
		}
		if runContext.Err() == nil {
			client.send(protocol.Outbound{Type: "run.completed", RunID: run.ID, Output: result, At: now()})
		}
	}()
}

func (client *Client) callHub(ctx context.Context, runID, operation string, arguments json.RawMessage) (json.RawMessage, error) {
	requestID := fmt.Sprintf("rpc-%d", client.requestID.Add(1))
	response := make(chan rpcResult, 1)
	client.pendingMu.Lock()
	client.pending[requestID] = response
	client.pendingMu.Unlock()
	defer func() {
		client.pendingMu.Lock()
		delete(client.pending, requestID)
		client.pendingMu.Unlock()
	}()

	message := protocol.Outbound{Type: "hub.rpc.request", RequestID: requestID, RunID: runID, Operation: operation, Arguments: arguments, At: now()}
	data, err := json.Marshal(message)
	if err != nil {
		return nil, err
	}
	client.connectionMu.Lock()
	connection := client.connection
	if connection == nil {
		client.connectionMu.Unlock()
		return nil, errors.New("control plane is unavailable")
	}
	writeContext, cancel := context.WithTimeout(ctx, 10*time.Second)
	err = writeBytes(writeContext, connection, data)
	cancel()
	client.connectionMu.Unlock()
	if err != nil {
		return nil, fmt.Errorf("send hub tool request: %w", err)
	}
	select {
	case received := <-response:
		return received.result, received.err
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(30 * time.Second):
		return nil, errors.New("hub tool request timed out")
	}
}

func (client *Client) resolveRPC(message protocol.Inbound) {
	client.pendingMu.Lock()
	response := client.pending[message.RequestID]
	delete(client.pending, message.RequestID)
	client.pendingMu.Unlock()
	if response == nil {
		return
	}
	if message.RPCError != nil {
		response <- rpcResult{err: fmt.Errorf("%s: %s", message.RPCError.Code, message.RPCError.Message)}
		return
	}
	response <- rpcResult{result: message.Result}
}

func (client *Client) failPending(err error) {
	client.pendingMu.Lock()
	pending := client.pending
	client.pending = map[string]chan rpcResult{}
	client.pendingMu.Unlock()
	for _, response := range pending {
		response <- rpcResult{err: err}
	}
}

func (client *Client) uploadArtifact(ctx context.Context, uploadPath string, content io.Reader, size int64) error {
	endpoint, err := httpEndpoint(client.config.ControlEndpoint, uploadPath)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint, content)
	if err != nil {
		return err
	}
	request.ContentLength = size
	request.Header.Set("Content-Type", "application/octet-stream")
	if client.config.Token != "" {
		request.Header.Set("Authorization", "Bearer "+client.config.Token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4*1024))
		return fmt.Errorf("hub returned %s: %s", response.Status, strings.TrimSpace(string(body)))
	}
	return nil
}

func httpEndpoint(controlEndpoint, path string) (string, error) {
	parsed, err := url.Parse(controlEndpoint)
	if err != nil {
		return "", err
	}
	switch parsed.Scheme {
	case "ws":
		parsed.Scheme = "http"
	case "wss":
		parsed.Scheme = "https"
	default:
		return "", errors.New("control endpoint must use ws or wss")
	}
	parsed.Path = path
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

func (client *Client) activeRuns() int {
	client.runsMu.Lock()
	defer client.runsMu.Unlock()
	return len(client.runs)
}

func (client *Client) activeRunIDs() []string {
	client.runsMu.Lock()
	defer client.runsMu.Unlock()
	ids := make([]string, 0, len(client.runs))
	for id := range client.runs {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
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
