//go:build system && unix

package systemtest

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The orchestrator bridge as Claude Code drives it: the real apps/orchestrator-bridge process,
// spoken to over stdio with newline-delimited JSON-RPC, holding its own authenticated WebSocket to
// the hub's /orchestrator-client endpoint. Nothing here reimplements the bridge or the hub; the
// scenario asserts only what crosses these two wires.

// channelEvent is one notifications/claude/channel event the bridge pushed into this session.
type channelEvent struct {
	Content string            `json:"content"`
	Meta    map[string]string `json:"meta"`
}

// urgent reports the doorbell's urgency flag, which the bridge stringifies for Claude Code.
func (event channelEvent) urgent() bool { return event.Meta["urgent"] == "true" }

// pending reports how many unacknowledged journal entries the doorbell counted.
func (event channelEvent) pending() int {
	value, err := strconv.Atoi(event.Meta["pending"])
	if err != nil {
		return -1
	}
	return value
}

type jsonRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type jsonRPCMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *jsonRPCError   `json:"error,omitempty"`
}

// toolOutcome is one MCP tools/call result. The bridge answers every Coffee Shop tool with a
// structured object, and reports a hub refusal as an error result carrying the hub's own code.
type toolOutcome struct {
	IsError           bool           `json:"isError"`
	StructuredContent map[string]any `json:"structuredContent"`
}

// errorCode is the orchestrator-client error code of a failed call, or the empty string.
func (outcome toolOutcome) errorCode() string {
	if !outcome.IsError {
		return ""
	}
	failure, _ := outcome.StructuredContent["error"].(map[string]any)
	code, _ := failure["code"].(string)
	return code
}

// object returns the nested object at path, or nil when any step is missing.
func object(value map[string]any, path ...string) map[string]any {
	current := value
	for _, key := range path {
		next, ok := current[key].(map[string]any)
		if !ok {
			return nil
		}
		current = next
	}
	return current
}

// text returns the string at key, or the empty string when it is absent or another type.
func text(value map[string]any, key string) string {
	result, _ := value[key].(string)
	return result
}

// bridgeProcess is one running bridge and the MCP session held with it.
type bridgeProcess struct {
	environment *environment
	name        string
	clientID    string
	process     *ownedProcess
	stdin       io.WriteCloser
	logs        *boundedLog

	mu              sync.Mutex
	nextID          int
	pending         map[string]chan jsonRPCMessage
	channels        []channelEvent
	toolListChanges int
	stdout          strings.Builder
}

// startBridge launches one bridge against the hub and completes the MCP initialize handshake, as
// Claude Code does before it lists tools.
func (environment *environment) startBridge(name, clientID, secret string) *bridgeProcess {
	return environment.startBridgeAt(name, clientID, secret, filepath.Join(repositoryRoot, "apps", "orchestrator-bridge"))
}

// startBridgeAt launches the bridge with the supplied machine-local working root. The executable
// remains the repository bridge; only process.cwd(), which defines post_artifact's file authority,
// changes.
func (environment *environment) startBridgeAt(name, clientID, secret, workingRoot string) *bridgeProcess {
	t := environment.t
	t.Helper()
	bridge := &bridgeProcess{environment: environment, name: name, clientID: clientID, pending: map[string]chan jsonRPCMessage{}, logs: newBoundedLog()}
	command := exec.Command(
		filepath.Join(repositoryRoot, "apps", "orchestrator-bridge", "node_modules", ".bin", "tsx"),
		filepath.Join(repositoryRoot, "apps", "orchestrator-bridge", "src", "index.ts"),
	)
	command.Dir = workingRoot
	command.Env = []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + filepath.Join(environment.root, "bridges", name),
		"COFFEE_SHOP_HUB_URL=ws://127.0.0.1:" + strconv.Itoa(environment.hub.port) + "/orchestrator-client",
		"COFFEE_SHOP_CLIENT_ID=" + clientID,
		"COFFEE_SHOP_CLIENT_SECRET=" + secret,
	}
	if err := os.MkdirAll(filepath.Join(environment.root, "bridges", name), 0o755); err != nil {
		t.Fatal(err)
	}
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	command.Stderr = bridge.logs
	process, err := startOwned(command)
	if err != nil {
		t.Fatalf("start bridge %s: %v", name, err)
	}
	bridge.stdin = stdin
	bridge.process = process
	go bridge.read(stdout)
	t.Cleanup(func() { bridge.stop(false) })

	initialized := bridge.request("initialize", map[string]any{
		"protocolVersion": "2025-06-18",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "coffee-shop-system-test", "version": "0.0.0"},
	})
	var handshake struct {
		ProtocolVersion string         `json:"protocolVersion"`
		Capabilities    map[string]any `json:"capabilities"`
	}
	if err := json.Unmarshal(initialized, &handshake); err != nil {
		t.Fatalf("bridge %s returned an undecodable initialize result: %v", name, err)
	}
	// Claude Code refuses to register a channel server that negotiates this revision or newer, so
	// a bridge that settled on one would never deliver a doorbell.
	if handshake.ProtocolVersion == "" || handshake.ProtocolVersion >= channelIncompatibleProtocolRevision {
		t.Fatalf("bridge %s negotiated MCP revision %q, which Claude Code will not register as a channel", name, handshake.ProtocolVersion)
	}
	if object(handshake.Capabilities, "experimental", "claude/channel") == nil {
		t.Fatalf("bridge %s did not declare the claude/channel capability: %v", name, handshake.Capabilities)
	}
	bridge.notify("notifications/initialized", map[string]any{})
	bridge.awaitHubConnection()
	return bridge
}

// awaitHubConnection waits until the bridge has a welcomed hub connection. Until then every tool
// call fails fast with `hub_unavailable` rather than being queued, which is what the model sees.
func (bridge *bridgeProcess) awaitHubConnection() {
	t := bridge.environment.t
	t.Helper()
	deadline := time.Now().Add(stateDeadline)
	for {
		outcome := bridge.callTool("list_threads", map[string]any{})
		if outcome.errorCode() != "hub_unavailable" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("bridge %s never reached the hub:\n%s", bridge.name, bridge.logs.tail(8000))
		}
		time.Sleep(pollInterval)
	}
}

// channelIncompatibleProtocolRevision mirrors apps/orchestrator-bridge/src/protocolRevision.ts.
const channelIncompatibleProtocolRevision = "2026-07-28"

// read consumes the bridge's MCP stream, settling responses and collecting channel events.
func (bridge *bridgeProcess) read(stdout io.ReadCloser) {
	reader := bufio.NewReader(stdout)
	for {
		line, err := reader.ReadString('\n')
		if line != "" {
			bridge.mu.Lock()
			bridge.stdout.WriteString(line)
			bridge.mu.Unlock()
			bridge.dispatch(strings.TrimSpace(line))
		}
		if err != nil {
			return
		}
	}
}

func (bridge *bridgeProcess) dispatch(line string) {
	if line == "" {
		return
	}
	var message jsonRPCMessage
	if err := json.Unmarshal([]byte(line), &message); err != nil {
		return
	}
	if message.Method == toolListChangedNotificationMethod {
		bridge.mu.Lock()
		bridge.toolListChanges++
		bridge.mu.Unlock()
		return
	}
	if message.Method == channelNotificationMethod {
		var event channelEvent
		if err := json.Unmarshal(message.Params, &event); err == nil {
			bridge.mu.Lock()
			bridge.channels = append(bridge.channels, event)
			bridge.mu.Unlock()
		}
		return
	}
	if message.ID == nil {
		return
	}
	key := fmt.Sprint(message.ID)
	bridge.mu.Lock()
	waiter, found := bridge.pending[key]
	delete(bridge.pending, key)
	bridge.mu.Unlock()
	if found {
		waiter <- message
	}
}

// channelNotificationMethod mirrors apps/orchestrator-bridge/src/bridgeServer.ts.
const channelNotificationMethod = "notifications/claude/channel"

// toolListChangedNotificationMethod is how the bridge tells Claude Code its scopes changed.
const toolListChangedNotificationMethod = "notifications/tools/list_changed"

func (bridge *bridgeProcess) send(message map[string]any) {
	encoded, err := json.Marshal(message)
	if err != nil {
		bridge.environment.t.Fatal(err)
	}
	if _, err := bridge.stdin.Write(append(encoded, '\n')); err != nil {
		bridge.environment.t.Fatalf("bridge %s stdin: %v\n%s", bridge.name, err, bridge.logs.tail(4000))
	}
}

func (bridge *bridgeProcess) notify(method string, params any) {
	bridge.send(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

// request issues one MCP request and returns its result, failing the test on a JSON-RPC error.
func (bridge *bridgeProcess) request(method string, params any) json.RawMessage {
	t := bridge.environment.t
	t.Helper()
	bridge.mu.Lock()
	bridge.nextID++
	id := bridge.nextID
	waiter := make(chan jsonRPCMessage, 1)
	bridge.pending[strconv.Itoa(id)] = waiter
	bridge.mu.Unlock()

	bridge.send(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	select {
	case message := <-waiter:
		if message.Error != nil {
			t.Fatalf("bridge %s answered %s with a protocol error: %d %s", bridge.name, method, message.Error.Code, message.Error.Message)
		}
		return message.Result
	case <-bridge.process.exited:
		t.Fatalf("bridge %s exited while waiting for %s:\n%s", bridge.name, method, bridge.logs.tail(8000))
	case <-time.After(stateDeadline):
		t.Fatalf("bridge %s did not answer %s within %s:\n%s", bridge.name, method, stateDeadline, bridge.logs.tail(8000))
	}
	return nil
}

// tools lists the tool names the bridge currently offers.
func (bridge *bridgeProcess) tools() []string {
	t := bridge.environment.t
	t.Helper()
	var listed struct {
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(bridge.request("tools/list", map[string]any{}), &listed); err != nil {
		t.Fatalf("bridge %s returned an undecodable tool list: %v", bridge.name, err)
	}
	names := make([]string, 0, len(listed.Tools))
	for _, tool := range listed.Tools {
		names = append(names, tool.Name)
	}
	return names
}

// awaitTools waits until the bridge offers every named tool. Claude Code lists tools as soon as it
// starts the bridge, which can precede the hub's welcome, so a scoped tool appears only once the
// granted scopes are known and the bridge has announced the change.
func (bridge *bridgeProcess) awaitTools(required ...string) {
	t := bridge.environment.t
	t.Helper()
	deadline := time.Now().Add(stateDeadline)
	for {
		offered := map[string]bool{}
		for _, name := range bridge.tools() {
			offered[name] = true
		}
		missing := []string{}
		for _, name := range required {
			if !offered[name] {
				missing = append(missing, name)
			}
		}
		if len(missing) == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("bridge %s never offered %v; it offers %v\n%s", bridge.name, missing, offered, bridge.logs.tail(8000))
		}
		time.Sleep(pollInterval)
	}
}

// observedToolListChanges is how often the bridge announced a changed tool surface.
func (bridge *bridgeProcess) observedToolListChanges() int {
	bridge.mu.Lock()
	defer bridge.mu.Unlock()
	return bridge.toolListChanges
}

// callTool performs one tools/call and returns the outcome, including a refusal.
func (bridge *bridgeProcess) callTool(name string, arguments map[string]any) toolOutcome {
	t := bridge.environment.t
	t.Helper()
	var outcome toolOutcome
	if err := json.Unmarshal(bridge.request("tools/call", map[string]any{"name": name, "arguments": arguments}), &outcome); err != nil {
		t.Fatalf("bridge %s returned an undecodable %s result: %v", bridge.name, name, err)
	}
	return outcome
}

// mustCallTool performs one tools/call and fails the test unless the hub accepted it.
func (bridge *bridgeProcess) mustCallTool(name string, arguments map[string]any) map[string]any {
	t := bridge.environment.t
	t.Helper()
	outcome := bridge.callTool(name, arguments)
	if outcome.IsError {
		t.Fatalf("bridge %s: %s was refused: %v", bridge.name, name, outcome.StructuredContent)
	}
	return outcome.StructuredContent
}

// awaitChannelEvent waits for a channel event matching the predicate and returns it.
func (bridge *bridgeProcess) awaitChannelEvent(description string, matches func(channelEvent) bool) channelEvent {
	t := bridge.environment.t
	t.Helper()
	deadline := time.Now().Add(stateDeadline)
	for {
		for _, event := range bridge.observedChannelEvents() {
			if matches(event) {
				return event
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("bridge %s never received %s; it received %v\n%s", bridge.name, description, bridge.observedChannelEvents(), bridge.logs.tail(8000))
		}
		time.Sleep(pollInterval)
	}
}

// observedChannelEvents is a copy of every channel event delivered so far.
func (bridge *bridgeProcess) observedChannelEvents() []channelEvent {
	bridge.mu.Lock()
	defer bridge.mu.Unlock()
	return append([]channelEvent(nil), bridge.channels...)
}

// output is everything the bridge wrote to either stream, for credential scans and diagnostics.
func (bridge *bridgeProcess) output() string {
	bridge.mu.Lock()
	stdout := bridge.stdout.String()
	bridge.mu.Unlock()
	return stdout + bridge.logs.String()
}

// stop ends the bridge; kill simulates the session's machine dying without a clean shutdown.
func (bridge *bridgeProcess) stop(kill bool) { bridge.process.stop(kill) }
