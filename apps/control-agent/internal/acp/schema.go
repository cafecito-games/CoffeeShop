package acp

import "encoding/json"

// ACP v1 method names used by this client.
const (
	methodInitialize        = "initialize"
	methodSessionNew        = "session/new"
	methodSessionPrompt     = "session/prompt"
	methodSessionCancel     = "session/cancel"
	methodSessionClose      = "session/close"
	methodSessionUpdate     = "session/update"
	methodRequestPermission = "session/request_permission"
)

type implementation struct {
	Name    string `json:"name"`
	Title   string `json:"title,omitempty"`
	Version string `json:"version"`
}

type fileSystemCapabilities struct {
	ReadTextFile  bool `json:"readTextFile"`
	WriteTextFile bool `json:"writeTextFile"`
}

type clientCapabilities struct {
	FileSystem fileSystemCapabilities `json:"fs"`
	Terminal   bool                   `json:"terminal"`
}

type initializeRequest struct {
	ProtocolVersion    int                `json:"protocolVersion"`
	ClientCapabilities clientCapabilities `json:"clientCapabilities"`
	ClientInfo         implementation     `json:"clientInfo"`
}

type promptCapabilities struct {
	Image           bool `json:"image"`
	Audio           bool `json:"audio"`
	EmbeddedContext bool `json:"embeddedContext"`
}

type mcpCapabilities struct {
	HTTP bool `json:"http"`
	SSE  bool `json:"sse"`
}

// sessionCapabilities records optional session methods. ACP advertises each one with a non-null
// object, so presence rather than content is significant.
type sessionCapabilities struct {
	Close  json.RawMessage `json:"close"`
	Resume json.RawMessage `json:"resume"`
}

type agentCapabilities struct {
	LoadSession         bool                `json:"loadSession"`
	PromptCapabilities  promptCapabilities  `json:"promptCapabilities"`
	McpCapabilities     mcpCapabilities     `json:"mcpCapabilities"`
	SessionCapabilities sessionCapabilities `json:"sessionCapabilities"`
}

type authMethod struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type initializeResponse struct {
	ProtocolVersion   *int              `json:"protocolVersion"`
	AgentCapabilities agentCapabilities `json:"agentCapabilities"`
	AuthMethods       []authMethod      `json:"authMethods"`
	AgentInfo         *implementation   `json:"agentInfo"`
}

type httpHeader struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type mcpServerHTTP struct {
	Type    string       `json:"type"`
	Name    string       `json:"name"`
	URL     string       `json:"url"`
	Headers []httpHeader `json:"headers"`
}

type newSessionRequest struct {
	Cwd        string          `json:"cwd"`
	McpServers []mcpServerHTTP `json:"mcpServers"`
}

type newSessionResponse struct {
	SessionID string `json:"sessionId"`
}

type contentBlock struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

type promptRequest struct {
	SessionID string         `json:"sessionId"`
	Prompt    []contentBlock `json:"prompt"`
}

type promptUsage struct {
	InputTokens      *int64 `json:"inputTokens"`
	OutputTokens     *int64 `json:"outputTokens"`
	CachedReadTokens *int64 `json:"cachedReadTokens"`
}

type promptResponse struct {
	StopReason string       `json:"stopReason"`
	Usage      *promptUsage `json:"usage"`
}

type sessionReference struct {
	SessionID string `json:"sessionId"`
}

type sessionNotification struct {
	SessionID string          `json:"sessionId"`
	Update    json.RawMessage `json:"update"`
}

type sessionUpdateKind struct {
	SessionUpdate string `json:"sessionUpdate"`
}

type contentChunk struct {
	Content json.RawMessage `json:"content"`
}

type receivedContent struct {
	Type string  `json:"type"`
	Text *string `json:"text"`
}

type planEntry struct {
	Content  *string `json:"content"`
	Priority string  `json:"priority"`
	Status   string  `json:"status"`
}

type planUpdate struct {
	Entries []planEntry `json:"entries"`
}

type toolCallContent struct {
	Type       string          `json:"type"`
	Content    json.RawMessage `json:"content"`
	Path       *string         `json:"path"`
	OldText    *string         `json:"oldText"`
	NewText    *string         `json:"newText"`
	TerminalID string          `json:"terminalId"`
}

// toolCallFields is the shared shape of tool_call, tool_call_update, and the toolCall carried by
// session/request_permission. Pointers distinguish absent fields, which an update leaves unchanged.
type toolCallFields struct {
	ToolCallID string             `json:"toolCallId"`
	Title      *string            `json:"title"`
	Kind       *string            `json:"kind"`
	Status     *string            `json:"status"`
	Content    *[]toolCallContent `json:"content"`
}

type usageCost struct {
	Amount   *float64 `json:"amount"`
	Currency string   `json:"currency"`
}

type usageUpdate struct {
	Used *int64     `json:"used"`
	Size *int64     `json:"size"`
	Cost *usageCost `json:"cost"`
}

type permissionOption struct {
	OptionID string `json:"optionId"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
}

type requestPermissionRequest struct {
	SessionID string             `json:"sessionId"`
	ToolCall  toolCallFields     `json:"toolCall"`
	Options   []permissionOption `json:"options"`
}

type permissionOutcome struct {
	Outcome  string `json:"outcome"`
	OptionID string `json:"optionId,omitempty"`
}

type requestPermissionResponse struct {
	Outcome permissionOutcome `json:"outcome"`
}
