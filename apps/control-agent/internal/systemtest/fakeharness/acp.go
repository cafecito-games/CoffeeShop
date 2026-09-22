package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp/acptest"
)

// flavor is the provider-specific identity an ACP role reports: the agent information and the
// session configuration options the real adapter offers, rendered by the shared acptest shapes so
// the pinned adapter versions and option vocabularies stay in one place.
type flavor struct {
	short         string
	agentName     string
	title         string
	version       string
	configOptions func(mode, model string) string
	initialMode   string
	initialModel  string
}

var (
	codexFlavor = flavor{
		short: "codex", agentName: "@agentclientprotocol/codex-acp", title: "Codex", version: acptest.CodexAdapterVersion,
		configOptions: acptest.CodexConfigOptions, initialMode: "agent", initialModel: acptest.CodexModel,
	}
	claudeFlavor = flavor{
		short: "claude", agentName: "@agentclientprotocol/claude-agent-acp", title: "Claude", version: acptest.ClaudeAdapterVersion,
		configOptions: acptest.ClaudeConfigOptions, initialMode: "auto", initialModel: acptest.ClaudeModel,
	}
)

// agentCapabilities advertises HTTP MCP, session close, and session resume, which is everything
// Barista negotiates for resumable orchestrator sessions.
const agentCapabilities = `{"loadSession":false,"promptCapabilities":{"image":false,"audio":false,"embeddedContext":false},"mcpCapabilities":{"http":true,"sse":false},"sessionCapabilities":{"close":{},"resume":{}}}`

// rejectSessionMarker, present in a session's working directory, makes session/new answer with an
// empty session identity: an ACP protocol violation before the prompt, which is exactly the failure
// Barista may recover from through an operator-permitted native fallback.
const rejectSessionMarker = ".fake-acp-reject-session"

type frame struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   json.RawMessage `json:"error,omitempty"`
}

type acpAgent struct {
	flavor   flavor
	recorder *recorder
	requests chan frame
	eof      chan struct{}

	writeMu sync.Mutex

	mu              sync.Mutex
	pending         map[string]chan frame
	promptCancel    chan struct{}
	promptCancelled bool

	sessionID   string
	cwd         string
	mode        string
	model       string
	mcp         *mcpClient
	sessions    int
	permissions int
}

func runACP(recorder *recorder, flavor flavor) int {
	agent := &acpAgent{
		flavor: flavor, recorder: recorder, requests: make(chan frame), eof: make(chan struct{}),
		pending: map[string]chan frame{}, mode: flavor.initialMode, model: flavor.initialModel,
	}
	go agent.readLoop()
	for request := range agent.requests {
		if err := agent.handle(request); err != nil {
			var crashed crash
			if errors.As(err, &crashed) {
				return crashed.code
			}
			fmt.Fprintf(os.Stderr, "fakeharness: %v\n", err)
			return 70
		}
	}
	return 0
}

func (agent *acpAgent) readLoop() {
	defer close(agent.requests)
	defer close(agent.eof)
	// Barista closing stdin, or exiting, ends any prompt still running.
	defer agent.cancelPrompt()
	reader := bufio.NewReaderSize(os.Stdin, 1<<20)
	for {
		line, err := reader.ReadBytes('\n')
		if len(strings.TrimSpace(string(line))) > 0 {
			var message frame
			if json.Unmarshal(line, &message) == nil {
				agent.route(message)
			}
		}
		if err != nil {
			return
		}
	}
}

func (agent *acpAgent) route(message frame) {
	switch {
	case message.Method == "" && len(message.ID) > 0:
		agent.mu.Lock()
		waiter := agent.pending[string(message.ID)]
		delete(agent.pending, string(message.ID))
		agent.mu.Unlock()
		if waiter != nil {
			waiter <- message
		}
	case message.Method == "session/cancel":
		agent.cancelPrompt()
	default:
		if message.Method == "session/prompt" {
			// The cancellation channel exists before the prompt is handed over, so a session/cancel
			// read right after it can never be missed.
			agent.mu.Lock()
			agent.promptCancel = make(chan struct{})
			agent.promptCancelled = false
			agent.mu.Unlock()
		}
		agent.requests <- message
	}
}

func (agent *acpAgent) cancelPrompt() {
	agent.mu.Lock()
	defer agent.mu.Unlock()
	if agent.promptCancel != nil && !agent.promptCancelled {
		agent.promptCancelled = true
		close(agent.promptCancel)
	}
}

func (agent *acpAgent) handle(request frame) error {
	switch request.Method {
	case "initialize":
		return agent.respond(request.ID, `{"protocolVersion":1,"agentCapabilities":`+agentCapabilities+`,"authMethods":[],"agentInfo":{"name":"`+agent.flavor.agentName+`","title":"`+agent.flavor.title+`","version":"`+agent.flavor.version+`"}}`)
	case "session/new":
		return agent.newSession(request)
	case "session/resume":
		return agent.resumeSession(request)
	case "session/set_config_option":
		var params struct {
			ConfigID string `json:"configId"`
			Value    string `json:"value"`
		}
		if err := json.Unmarshal(request.Params, &params); err != nil {
			return agent.respondError(request.ID, -32602, "invalid params")
		}
		switch params.ConfigID {
		case "mode":
			agent.mode = params.Value
		case "model":
			agent.model = params.Value
		default:
			return agent.respondError(request.ID, -32602, "unknown configuration option")
		}
		return agent.respond(request.ID, `{"configOptions":`+agent.flavor.configOptions(agent.mode, agent.model)+`}`)
	case "session/prompt":
		return agent.prompt(request)
	case "session/close":
		agent.recorder.write(map[string]any{"event": "session-closed", "sessionId": agent.sessionID})
		return agent.respond(request.ID, `{}`)
	default:
		if len(request.ID) > 0 {
			return agent.respondError(request.ID, -32601, "method not found")
		}
		return nil
	}
}

type sessionParams struct {
	SessionID  string `json:"sessionId"`
	Cwd        string `json:"cwd"`
	McpServers []struct {
		URL     string `json:"url"`
		Headers []struct {
			Name  string `json:"name"`
			Value string `json:"value"`
		} `json:"headers"`
	} `json:"mcpServers"`
}

func (agent *acpAgent) configure(params sessionParams) error {
	agent.cwd = params.Cwd
	agent.mcp = nil
	for _, server := range params.McpServers {
		token := ""
		for _, header := range server.Headers {
			if header.Name == "Authorization" {
				token = strings.TrimPrefix(header.Value, "Bearer ")
			}
		}
		client, err := newMCPClient(server.URL, token)
		if err != nil {
			return err
		}
		agent.mcp = client
	}
	return nil
}

func (agent *acpAgent) connectMCP() error {
	if agent.mcp == nil {
		return nil
	}
	return agent.mcp.connect(context.Background())
}

func (agent *acpAgent) newSession(request frame) error {
	var params sessionParams
	if err := json.Unmarshal(request.Params, &params); err != nil {
		return agent.respondError(request.ID, -32602, "invalid params")
	}
	if err := agent.configure(params); err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(params.Cwd, rejectSessionMarker)); err == nil {
		agent.recorder.write(map[string]any{"event": "session-rejected", "cwd": params.Cwd})
		return agent.respond(request.ID, `{"sessionId":""}`)
	}
	agent.sessions++
	agent.sessionID = "fake-" + agent.flavor.short + "-" + strconv.Itoa(os.Getpid()) + "-" + strconv.Itoa(agent.sessions)
	if len(params.McpServers) > 0 {
		agent.rememberSession(agent.sessionID)
	}
	agent.recorder.write(map[string]any{"event": "session-new", "sessionId": agent.sessionID, "cwd": params.Cwd, "mcp": agent.mcp != nil})
	if err := agent.respond(request.ID, `{"sessionId":"`+agent.sessionID+`","configOptions":`+agent.flavor.configOptions(agent.mode, agent.model)+`}`); err != nil {
		return err
	}
	return agent.connectMCP()
}

// resumeSession continues a session this provider still knows about. The provider's memory is the
// session directory: a test deletes an entry to make a session stale, and the fake then refuses
// the resume exactly like a provider that lost it.
func (agent *acpAgent) resumeSession(request frame) error {
	var params sessionParams
	if err := json.Unmarshal(request.Params, &params); err != nil {
		return agent.respondError(request.ID, -32602, "invalid params")
	}
	if !agent.knowsSession(params.SessionID) {
		agent.recorder.write(map[string]any{"event": "session-resume-refused", "sessionId": params.SessionID})
		return agent.respondError(request.ID, -32002, "Resource not found")
	}
	if err := agent.configure(params); err != nil {
		return err
	}
	agent.sessionID = params.SessionID
	agent.recorder.write(map[string]any{"event": "session-resumed", "sessionId": agent.sessionID, "cwd": params.Cwd})
	if err := agent.respond(request.ID, `{"configOptions":`+agent.flavor.configOptions(agent.mode, agent.model)+`}`); err != nil {
		return err
	}
	return agent.connectMCP()
}

func (agent *acpAgent) sessionPath(sessionID string) string {
	directory := os.Getenv(sessionDirectoryVariable)
	if directory == "" || sessionID == "" || sessionID != filepath.Base(sessionID) {
		return ""
	}
	return filepath.Join(directory, sessionID)
}

func (agent *acpAgent) rememberSession(sessionID string) {
	if path := agent.sessionPath(sessionID); path != "" {
		_ = os.WriteFile(path, []byte(agent.flavor.short+"\n"), 0o600)
	}
}

func (agent *acpAgent) knowsSession(sessionID string) bool {
	path := agent.sessionPath(sessionID)
	if path == "" {
		return false
	}
	_, err := os.Stat(path)
	return err == nil
}

func (agent *acpAgent) prompt(request frame) error {
	var params struct {
		SessionID string `json:"sessionId"`
		Prompt    []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"prompt"`
	}
	if err := json.Unmarshal(request.Params, &params); err != nil || params.SessionID != agent.sessionID {
		return agent.respondError(request.ID, -32602, "invalid prompt")
	}
	var text strings.Builder
	for _, block := range params.Prompt {
		if block.Type == "text" {
			text.WriteString(block.Text)
		}
	}
	agent.recorder.write(map[string]any{"event": "prompt", "sessionId": agent.sessionID})
	script, err := extractScript(text.String())
	if err != nil {
		return err
	}
	runErr := newEngine(agent, agent.mcp, text.String(), agent.cwd, agent.sessionID).run(context.Background(), script)
	switch {
	case runErr == nil:
		return agent.respond(request.ID, `{"stopReason":"end_turn"}`)
	case errors.Is(runErr, errCancelled):
		agent.recorder.write(map[string]any{"event": "prompt-cancelled", "sessionId": agent.sessionID})
		return agent.respond(request.ID, `{"stopReason":"cancelled"}`)
	default:
		return runErr
	}
}

func (agent *acpAgent) cancelled() <-chan struct{} {
	agent.mu.Lock()
	defer agent.mu.Unlock()
	if agent.promptCancel == nil {
		return make(chan struct{})
	}
	return agent.promptCancel
}

func (agent *acpAgent) sessionUpdate(update string) error {
	return agent.write(`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"` + agent.sessionID + `","update":` + update + `}}` + "\n")
}

func (agent *acpAgent) message(text string) error {
	encoded, _ := json.Marshal(text)
	return agent.sessionUpdate(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":` + string(encoded) + `}}`)
}

func (agent *acpAgent) thought(text string) error {
	encoded, _ := json.Marshal(text)
	return agent.sessionUpdate(`{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":` + string(encoded) + `}}`)
}

func (agent *acpAgent) update(raw json.RawMessage) error {
	return agent.sessionUpdate(string(raw))
}

func (agent *acpAgent) raw(text string) error {
	return agent.write(text)
}

func (agent *acpAgent) permission(ctx context.Context, request map[string]any) (any, error) {
	agent.mu.Lock()
	agent.permissions++
	identifier := `"permission-` + strconv.Itoa(agent.permissions) + `"`
	waiter := make(chan frame, 1)
	agent.pending[identifier] = waiter
	agent.mu.Unlock()
	request["sessionId"] = agent.sessionID
	params, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	if err := agent.write(`{"jsonrpc":"2.0","id":` + identifier + `,"method":"session/request_permission","params":` + string(params) + "}\n"); err != nil {
		return nil, err
	}
	select {
	case response := <-waiter:
		var decoded any
		if len(response.Result) > 0 {
			if err := json.Unmarshal(response.Result, &decoded); err != nil {
				return nil, err
			}
			return decoded, nil
		}
		return nil, errors.New("the permission request was answered with an error")
	case <-agent.eof:
		terminate(0)
		return nil, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (agent *acpAgent) respond(id json.RawMessage, result string) error {
	return agent.write(`{"jsonrpc":"2.0","id":` + string(id) + `,"result":` + result + "}\n")
}

func (agent *acpAgent) respondError(id json.RawMessage, code int, message string) error {
	encoded, _ := json.Marshal(message)
	return agent.write(`{"jsonrpc":"2.0","id":` + string(id) + `,"error":{"code":` + strconv.Itoa(code) + `,"message":` + string(encoded) + "}}\n")
}

// write sends text in two pieces so Barista's framing is exercised with partial reads of a frame.
func (agent *acpAgent) write(text string) error {
	agent.writeMu.Lock()
	defer agent.writeMu.Unlock()
	middle := len(text) / 2
	if _, err := os.Stdout.WriteString(text[:middle]); err != nil {
		return err
	}
	_, err := os.Stdout.WriteString(text[middle:])
	return err
}
