package protocol

import "encoding/json"

const Version = "3"

type HarnessProfile struct {
	ID          string   `json:"id"`
	Label       string   `json:"label"`
	Description string   `json:"description"`
	Binary      string   `json:"binary,omitempty"`
	Available   bool     `json:"available"`
	AuthMode    string   `json:"authMode"`
	Models      []string `json:"models"`
}

type ComputeNode struct {
	ID             string           `json:"id"`
	Name           string           `json:"name"`
	Kind           string           `json:"kind"`
	Platform       string           `json:"platform"`
	Status         string           `json:"status"`
	LastSeen       string           `json:"lastSeen"`
	ActiveRuns     int              `json:"activeRuns"`
	Concurrency    int              `json:"concurrency"`
	WorkspaceRoots []string         `json:"workspaceRoots"`
	Harnesses      []HarnessProfile `json:"harnesses"`
	Version        string           `json:"version"`
}

type Agent struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	SystemPrompt string `json:"systemPrompt"`
	CanDelegate  bool   `json:"canDelegate,omitempty"`
}

type Run struct {
	ID        string `json:"id"`
	ThreadID  string `json:"threadId,omitempty"`
	HarnessID string `json:"harnessId"`
	Model     string `json:"model"`
	Workspace string `json:"workspace"`
	Prompt    string `json:"prompt"`
}

type Inbound struct {
	Type      string          `json:"type"`
	RunID     string          `json:"runId,omitempty"`
	Run       Run             `json:"run,omitempty"`
	Agent     Agent           `json:"agent,omitempty"`
	RequestID string          `json:"requestId,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	RPCError  *HubRPCError    `json:"error,omitempty"`
}

type HubRPCError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

type Outbound struct {
	Type            string          `json:"type"`
	ProtocolVersion string          `json:"protocolVersion,omitempty"`
	Node            *ComputeNode    `json:"node,omitempty"`
	NodeID          string          `json:"nodeId,omitempty"`
	ActiveRuns      int             `json:"activeRuns"`
	ActiveRunIDs    []string        `json:"activeRunIds,omitempty"`
	RunID           string          `json:"runId,omitempty"`
	Chunk           string          `json:"chunk,omitempty"`
	Output          string          `json:"output,omitempty"`
	Error           string          `json:"error,omitempty"`
	At              string          `json:"at,omitempty"`
	RequestID       string          `json:"requestId,omitempty"`
	Operation       string          `json:"operation,omitempty"`
	Arguments       json.RawMessage `json:"arguments,omitempty"`
}

func DecodeInbound(data []byte) (Inbound, error) {
	var message Inbound
	err := json.Unmarshal(data, &message)
	return message, err
}
