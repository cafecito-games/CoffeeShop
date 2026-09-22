package protocol

import "encoding/json"

// Version is the control protocol version Barista registers. Barista honors version-4 dispatch
// execution for the native-cli and acp-v1 transports, for the workspace lease policies it can
// provision, and for session resume where its adapter negotiated it, and rejects anything else,
// so registering as 4 never degrades execution to version-3 behavior.
const Version = "4"

type HarnessProfile struct {
	ID          string                `json:"id"`
	Label       string                `json:"label"`
	Description string                `json:"description"`
	Binary      string                `json:"binary,omitempty"`
	Available   bool                  `json:"available"`
	AuthMode    string                `json:"authMode"`
	Models      []string              `json:"models"`
	Transports  []string              `json:"transports,omitempty"`
	ACP         *AcpAgentCapabilities `json:"acp,omitempty"`
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
	ID               string `json:"id"`
	ThreadID         string `json:"threadId,omitempty"`
	HarnessID        string `json:"harnessId"`
	Model            string `json:"model"`
	Workspace        string `json:"workspace"`
	Prompt           string `json:"prompt"`
	TaskID           string `json:"taskId,omitempty"`
	Attempt          int    `json:"attempt,omitempty"`
	Transport        string `json:"transport,omitempty"`
	SessionBindingID string `json:"sessionBindingId,omitempty"`
	WorkspaceLeaseID string `json:"workspaceLeaseId,omitempty"`
}

type Inbound struct {
	Type      string               `json:"type"`
	RunID     string               `json:"runId,omitempty"`
	Run       Run                  `json:"run,omitempty"`
	Agent     Agent                `json:"agent,omitempty"`
	Execution *DispatchExecution   `json:"execution,omitempty"`
	Decision  *ApprovalDecision    `json:"decision,omitempty"`
	Lease     *WorkspaceLeaseGrant `json:"lease,omitempty"`
	Mode      string               `json:"mode,omitempty"`
	LeaseID   string               `json:"leaseId,omitempty"`
	Status    string               `json:"status,omitempty"`
	RequestID string               `json:"requestId,omitempty"`
	Result    json.RawMessage      `json:"result,omitempty"`
	RPCError  *HubRPCError         `json:"error,omitempty"`
}

type HubRPCError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

type Outbound struct {
	Type            string       `json:"type"`
	ProtocolVersion string       `json:"protocolVersion,omitempty"`
	Node            *ComputeNode `json:"node,omitempty"`
	NodeID          string       `json:"nodeId,omitempty"`
	ActiveRuns      int          `json:"activeRuns"`
	// ActiveRunIDs is a pointer so sync.complete can encode an explicitly empty array
	// ("activeRunIds":[]) when no runs survived the reconnect, while every other message type
	// omits the field entirely by leaving the pointer nil.
	ActiveRunIDs *[]string             `json:"activeRunIds,omitempty"`
	RunID        string                `json:"runId,omitempty"`
	Chunk        string                `json:"chunk,omitempty"`
	Output       string                `json:"output,omitempty"`
	Error        string                `json:"error,omitempty"`
	At           string                `json:"at,omitempty"`
	RequestID    string                `json:"requestId,omitempty"`
	Operation    string                `json:"operation,omitempty"`
	Arguments    json.RawMessage       `json:"arguments,omitempty"`
	Event        *HarnessEvent         `json:"event,omitempty"`
	Binding      *SessionBindingUpdate `json:"binding,omitempty"`
	Lease        *WorkspaceLeaseUpdate `json:"lease,omitempty"`
	Report       *NodeCapabilityReport `json:"report,omitempty"`
	// Transport is the version-4 transport selection reported once on run.started.
	Transport *RunTransportSelection `json:"transport,omitempty"`
}

func DecodeInbound(data []byte) (Inbound, error) {
	var message Inbound
	err := json.Unmarshal(data, &message)
	return message, err
}
