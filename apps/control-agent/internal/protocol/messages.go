package protocol

import (
	"encoding/json"
	"fmt"
)

// Version is the control protocol version Barista registers. Barista honors dispatch execution
// for the native-cli and acp-v1 transports, for the workspace lease policies it can provision,
// and for session resume where its adapter negotiated it, and rejects anything else rather than
// degrading execution to an older version's behavior. Version 5 adds resident-instance
// supervision: Barista provisions, dispatches against, and releases allocations negotiated
// through the instance messages.
const Version = "5"

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
	// ApprovalPolicy is the node administrator's approval policy for this harness. Barista omits
	// ApprovalPolicyManual, so an absent value means manual and older hubs see an unchanged profile.
	ApprovalPolicy string `json:"approvalPolicy,omitempty"`
}

type ComputeNode struct {
	ID               string           `json:"id"`
	Name             string           `json:"name"`
	Kind             string           `json:"kind"`
	Platform         string           `json:"platform"`
	Status           string           `json:"status"`
	LastSeen         string           `json:"lastSeen"`
	ActiveRuns       int              `json:"activeRuns"`
	Concurrency      int              `json:"concurrency"`
	InstanceCapacity *int             `json:"instanceCapacity,omitempty"`
	ActiveInstances  *int             `json:"activeInstances,omitempty"`
	WorkspaceRoots   []string         `json:"workspaceRoots"`
	Harnesses        []HarnessProfile `json:"harnesses"`
	Version          string           `json:"version"`
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
	ActiveRunIDs      *[]string             `json:"activeRunIds,omitempty"`
	ActiveInstanceIDs *[]string             `json:"activeInstanceIds,omitempty"`
	ActiveInstances   *int                  `json:"activeInstances,omitempty"`
	RunID             string                `json:"runId,omitempty"`
	Chunk             string                `json:"chunk,omitempty"`
	Output            string                `json:"output,omitempty"`
	Error             string                `json:"error,omitempty"`
	At                string                `json:"at,omitempty"`
	RequestID         string                `json:"requestId,omitempty"`
	Operation         string                `json:"operation,omitempty"`
	Arguments         json.RawMessage       `json:"arguments,omitempty"`
	Event             *HarnessEvent         `json:"event,omitempty"`
	Binding           *SessionBindingUpdate `json:"binding,omitempty"`
	Lease             *WorkspaceLeaseUpdate `json:"lease,omitempty"`
	Report            *NodeCapabilityReport `json:"report,omitempty"`
	// Transport is the version-4 transport selection reported once on run.started.
	Transport *RunTransportSelection `json:"transport,omitempty"`
	// ProviderSessionID is the vendor's own session identity, reported at most once on a native
	// CLI run's run.output so an operator can resume the conversation outside Coffee Shop.
	ProviderSessionID string `json:"providerSessionId,omitempty"`
}

func DecodeInbound(data []byte) (Inbound, error) {
	// This is the deployed legacy decoder. Never discard v5 identity and reinterpret the
	// remaining run as a legacy dispatch. Migrated callers must use DecodeInstanceHubMessage.
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(data, &envelope); err != nil {
		return Inbound{}, err
	}
	var kind string
	if err := json.Unmarshal(envelope["type"], &kind); err != nil {
		return Inbound{}, err
	}
	if kind == "instance.provision" || kind == "instance.release" {
		return Inbound{}, fmt.Errorf("instance message requires the v5 decoder")
	}
	if kind == "dispatch" {
		var run map[string]json.RawMessage
		if err := json.Unmarshal(envelope["run"], &run); err != nil {
			return Inbound{}, err
		}
		for _, key := range []string{"instance", "allocation", "instanceId", "allocationId"} {
			if _, found := envelope[key]; found {
				return Inbound{}, fmt.Errorf("instance dispatch requires the v5 decoder")
			}
			if _, found := run[key]; found {
				return Inbound{}, fmt.Errorf("instance run requires the v5 decoder")
			}
		}
	}
	var message Inbound
	err := json.Unmarshal(data, &message)
	return message, err
}
