package protocol

import (
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"time"
	"unicode/utf8"
)

// LatestVersion mirrors the TypeScript source of truth.
const LatestVersion = "4"

// SupportedVersions lists every control protocol version accepted during rolling upgrades.
var SupportedVersions = []string{"1", "2", "3", "4"}

const (
	CapabilityReplayBarrier = "replay-barrier"
	CapabilityHubRPC        = "hub-rpc"
	CapabilityOrchestration = "orchestration"
)

var capabilityIntroducedIn = map[string]int{
	CapabilityReplayBarrier: 2,
	CapabilityHubRPC:        3,
	CapabilityOrchestration: 4,
}

func IsSupportedVersion(version string) bool {
	return slices.Contains(SupportedVersions, version)
}

// SupportsCapability reports whether a peer that registered the given version may exchange
// messages requiring the capability. Unknown versions and capabilities are never assumed to be
// supported; the caller must reject instead of reinterpreting the message.
func SupportsCapability(version string, capability string) bool {
	introducedIn, knownCapability := capabilityIntroducedIn[capability]
	if !knownCapability || !IsSupportedVersion(version) {
		return false
	}
	registeredAs, err := strconv.Atoi(version)
	if err != nil {
		return false
	}
	return registeredAs >= introducedIn
}

var (
	HarnessTransports         = []string{"native-cli", "acp-v1"}
	HarnessIDs                = []string{"claude-cli", "codex-cli", "shell", "ag-ui"}
	HarnessEventTypes         = []string{"message.delta", "thought.delta", "plan.updated", "tool.call", "diff", "terminal.output", "usage", "permission.requested", "permission.resolved", "warning", "unknown"}
	ApprovalStatuses          = []string{"pending", "approved", "rejected", "cancelled", "expired"}
	ApprovalOptionKinds       = []string{"allow-once", "allow-always", "reject-once", "reject-always"}
	SessionBindingStatuses    = []string{"active", "idle", "closed", "replaced", "failed"}
	WorkspaceLeaseStatuses    = []string{"requested", "provisioning", "active", "released", "cleaning", "retained", "cleaned", "failed"}
	WorkspaceRetentionReasons = []string{"dirty", "identity-mismatch", "ambiguous", "operator-hold"}
	PlanEntryStatuses         = []string{"pending", "in-progress", "completed"}
	PlanEntryPriorities       = []string{"high", "medium", "low"}
	ToolCallStatuses          = []string{"pending", "in-progress", "completed", "failed"}
	ToolCallKinds             = []string{"read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"}
)

// Byte and cardinality bounds for harness events, mirroring harnessEventLimits in the protocol
// source of truth.
const (
	textBytes           = 64 * 1024
	diffBytes           = 256 * 1024
	planEntryLimit      = 200
	approvalOptionLimit = 8
	diagnosticBytes     = 2 * 1024
	identifierBytes     = 256
)

type AcpPromptCapabilities struct {
	Image           bool `json:"image"`
	Audio           bool `json:"audio"`
	EmbeddedContext bool `json:"embeddedContext"`
}

type AcpMcpCapabilities struct {
	HTTP bool `json:"http"`
	SSE  bool `json:"sse"`
}

type AcpAgentCapabilities struct {
	ProtocolVersion int                   `json:"protocolVersion"`
	LoadSession     bool                  `json:"loadSession"`
	ResumeSession   bool                  `json:"resumeSession"`
	Prompt          AcpPromptCapabilities `json:"prompt"`
	Mcp             AcpMcpCapabilities    `json:"mcp"`
	AdapterName     string                `json:"adapterName,omitempty"`
	AdapterVersion  string                `json:"adapterVersion,omitempty"`
}

type DispatchSessionBinding struct {
	ID                string `json:"id"`
	ProviderSessionID string `json:"providerSessionId"`
}

type WorkspaceLeaseGrant struct {
	ID           string `json:"id"`
	Repository   string `json:"repository"`
	Root         string `json:"root"`
	BaseRevision string `json:"baseRevision"`
	Branch       string `json:"branch"`
	WorktreePath string `json:"worktreePath"`
}

type DispatchExecution struct {
	Transport string `json:"transport"`
	// FallbackTransport, when "native-cli", permits Barista to run an acp-v1 dispatch through the
	// native CLI instead, but only for a pre-prompt fallback reason and only when the operator
	// enabled native fallback for the harness.
	FallbackTransport string                  `json:"fallbackTransport,omitempty"`
	TaskID            string                  `json:"taskId,omitempty"`
	Attempt           int                     `json:"attempt,omitempty"`
	SessionBinding    *DispatchSessionBinding `json:"sessionBinding,omitempty"`
	WorkspaceLease    *WorkspaceLeaseGrant    `json:"workspaceLease,omitempty"`
}

type ApprovalDecision struct {
	ApprovalID       string `json:"approvalId"`
	RunID            string `json:"runId"`
	Status           string `json:"status"`
	SelectedOptionID string `json:"selectedOptionId,omitempty"`
}

type SessionBindingUpdate struct {
	BindingID         string `json:"bindingId,omitempty"`
	ProviderSessionID string `json:"providerSessionId"`
	HarnessID         string `json:"harnessId"`
	Transport         string `json:"transport"`
	Status            string `json:"status"`
}

type WorkspaceLeaseUpdate struct {
	LeaseID         string `json:"leaseId"`
	Status          string `json:"status"`
	RetentionReason string `json:"retentionReason,omitempty"`
	Detail          string `json:"detail,omitempty"`
}

type PlanEntry struct {
	Content  string `json:"content"`
	Status   string `json:"status"`
	Priority string `json:"priority"`
}

type ApprovalOption struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Kind  string `json:"kind"`
}

// HarnessEvent is the flat wire shape of every normalized harness event variant; fields that a
// variant does not use are omitted from the encoded JSON.
type HarnessEvent struct {
	Type              string           `json:"type"`
	RunID             string           `json:"runId"`
	Sequence          int64            `json:"sequence"`
	At                string           `json:"at"`
	Text              string           `json:"text,omitempty"`
	Entries           []PlanEntry      `json:"entries,omitempty"`
	ToolCallID        string           `json:"toolCallId,omitempty"`
	Status            string           `json:"status,omitempty"`
	Kind              string           `json:"kind,omitempty"`
	Title             string           `json:"title,omitempty"`
	Detail            string           `json:"detail,omitempty"`
	Path              string           `json:"path,omitempty"`
	OldText           string           `json:"oldText,omitempty"`
	NewText           string           `json:"newText,omitempty"`
	TerminalID        string           `json:"terminalId,omitempty"`
	Stream            string           `json:"stream,omitempty"`
	InputTokens       *int64           `json:"inputTokens,omitempty"`
	OutputTokens      *int64           `json:"outputTokens,omitempty"`
	CachedInputTokens *int64           `json:"cachedInputTokens,omitempty"`
	CostUSD           *float64         `json:"costUsd,omitempty"`
	ApprovalID        string           `json:"approvalId,omitempty"`
	Options           []ApprovalOption `json:"options,omitempty"`
	SelectedOptionID  string           `json:"selectedOptionId,omitempty"`
	Code              string           `json:"code,omitempty"`
	Message           string           `json:"message,omitempty"`
	SourceType        string           `json:"sourceType,omitempty"`
}

// isIdentifier mirrors the TypeScript bound: non-empty and at most identifierBytes bytes.
func isIdentifier(value string) bool {
	return value != "" && len(value) <= identifierBytes
}

// isTimestamp requires the RFC 3339 form Barista emits, which the hub's strict isTimestamp also accepts.
func isTimestamp(value string) bool {
	_, err := time.Parse(time.RFC3339Nano, value)
	return isIdentifier(value) && err == nil
}

func isBounded(value string, limit int) bool {
	return len(value) <= limit
}

func (event HarnessEvent) Validate() error {
	if !slices.Contains(HarnessEventTypes, event.Type) {
		return fmt.Errorf("harness event type is missing or unknown: %q", event.Type)
	}
	if !isIdentifier(event.RunID) || event.Sequence < 0 || !isTimestamp(event.At) {
		return fmt.Errorf("%s is missing run identity, sequence, or timestamp", event.Type)
	}
	switch event.Type {
	case "message.delta", "thought.delta":
		if !isBounded(event.Text, textBytes) {
			return fmt.Errorf("%s text exceeds its bound", event.Type)
		}
	case "plan.updated":
		if len(event.Entries) > planEntryLimit {
			return fmt.Errorf("plan.updated entries are missing or exceed their bound")
		}
		for _, entry := range event.Entries {
			if !isBounded(entry.Content, textBytes) || !slices.Contains(PlanEntryStatuses, entry.Status) || !slices.Contains(PlanEntryPriorities, entry.Priority) {
				return fmt.Errorf("plan.updated entry is malformed")
			}
		}
	case "tool.call":
		if !isIdentifier(event.ToolCallID) || !slices.Contains(ToolCallStatuses, event.Status) || !slices.Contains(ToolCallKinds, event.Kind) || !isBounded(event.Title, diagnosticBytes) || !isBounded(event.Detail, textBytes) {
			return fmt.Errorf("tool.call payload is malformed or exceeds its bounds")
		}
	case "diff":
		if !isBounded(event.Path, textBytes) || !isBounded(event.OldText, diffBytes) || !isBounded(event.NewText, diffBytes) || (event.ToolCallID != "" && !isIdentifier(event.ToolCallID)) {
			return fmt.Errorf("diff payload is malformed or exceeds its bounds")
		}
	case "terminal.output":
		if !isIdentifier(event.TerminalID) || (event.Stream != "stdout" && event.Stream != "stderr") || !isBounded(event.Text, textBytes) {
			return fmt.Errorf("terminal.output payload is malformed or exceeds its bounds")
		}
	case "usage":
		if !isNonNegativeCount(event.InputTokens) || !isNonNegativeCount(event.OutputTokens) || !isNonNegativeCount(event.CachedInputTokens) || !isNonNegativeAmount(event.CostUSD) {
			return fmt.Errorf("usage payload is malformed")
		}
	case "permission.requested":
		if err := validateApprovalOptions(event); err != nil {
			return err
		}
		if !isIdentifier(event.ApprovalID) || (event.ToolCallID != "" && !isIdentifier(event.ToolCallID)) || !isBounded(event.Title, diagnosticBytes) || !isBounded(event.Detail, textBytes) {
			return fmt.Errorf("permission.requested payload is malformed or exceeds its bounds")
		}
	case "permission.resolved":
		if !isIdentifier(event.ApprovalID) || !slices.Contains(ApprovalStatuses, event.Status) || event.Status == "pending" || (event.SelectedOptionID != "" && !isIdentifier(event.SelectedOptionID)) {
			return fmt.Errorf("permission.resolved payload is malformed")
		}
	case "warning":
		if !isIdentifier(event.Code) || !isBounded(event.Message, diagnosticBytes) {
			return fmt.Errorf("warning payload is malformed or exceeds its bounds")
		}
	case "unknown":
		if !isIdentifier(event.SourceType) || !isBounded(event.Detail, diagnosticBytes) {
			return fmt.Errorf("unknown payload is malformed or exceeds its bounds")
		}
	}
	return nil
}

func isNonNegativeCount(value *int64) bool {
	return value == nil || *value >= 0
}

func isNonNegativeAmount(value *float64) bool {
	return value == nil || *value >= 0
}

func validateApprovalOptions(event HarnessEvent) error {
	if len(event.Options) == 0 || len(event.Options) > approvalOptionLimit {
		return fmt.Errorf("permission.requested options are missing or exceed their bound")
	}
	seenIdentifiers := make(map[string]bool, len(event.Options))
	for _, option := range event.Options {
		if !isIdentifier(option.ID) || !isBounded(option.Label, diagnosticBytes) || !slices.Contains(ApprovalOptionKinds, option.Kind) {
			return fmt.Errorf("permission.requested option is malformed")
		}
		if seenIdentifiers[option.ID] {
			return fmt.Errorf("permission.requested options contain a duplicate identifier")
		}
		seenIdentifiers[option.ID] = true
	}
	return nil
}

func (decision ApprovalDecision) Validate() error {
	if !isIdentifier(decision.ApprovalID) || !isIdentifier(decision.RunID) {
		return fmt.Errorf("approval decision is missing identity")
	}
	if !slices.Contains(ApprovalStatuses, decision.Status) || decision.Status == "pending" {
		return fmt.Errorf("approval decision status must be terminal")
	}
	selectsOption := decision.Status == "approved" || decision.Status == "rejected"
	if selectsOption && !isIdentifier(decision.SelectedOptionID) {
		return fmt.Errorf("approval decision option does not match its status")
	}
	if !selectsOption && decision.SelectedOptionID != "" {
		return fmt.Errorf("approval decision option does not match its status")
	}
	return nil
}

func (binding SessionBindingUpdate) Validate() error {
	if (binding.BindingID != "" && !isIdentifier(binding.BindingID)) || !isIdentifier(binding.ProviderSessionID) {
		return fmt.Errorf("session binding is missing identity")
	}
	if !slices.Contains(HarnessIDs, binding.HarnessID) || !slices.Contains(HarnessTransports, binding.Transport) || !slices.Contains(SessionBindingStatuses, binding.Status) {
		return fmt.Errorf("session binding has an unknown harness, transport, or status")
	}
	return nil
}

func (update WorkspaceLeaseUpdate) Validate() error {
	if !isIdentifier(update.LeaseID) {
		return fmt.Errorf("workspace lease update is missing identity")
	}
	if !slices.Contains(WorkspaceLeaseStatuses, update.Status) {
		return fmt.Errorf("workspace lease status is missing or unknown")
	}
	if update.Status == "retained" {
		if !slices.Contains(WorkspaceRetentionReasons, update.RetentionReason) {
			return fmt.Errorf("workspace lease retention reason does not match its status")
		}
	} else if update.RetentionReason != "" {
		return fmt.Errorf("workspace lease retention reason does not match its status")
	}
	if !isBounded(update.Detail, diagnosticBytes) {
		return fmt.Errorf("workspace lease detail exceeds its bound")
	}
	return nil
}

// harnessEventPayloadKeys mirrors the TypeScript variant shapes. Required keys are always encoded,
// even when empty, because the hub rejects a variant that omits them; optional keys are encoded
// only when set; keys that belong to other variants are never encoded.
var harnessEventPayloadKeys = map[string]struct{ required, optional []string }{
	"message.delta":        {required: []string{"text"}},
	"thought.delta":        {required: []string{"text"}},
	"plan.updated":         {required: []string{"entries"}},
	"tool.call":            {required: []string{"toolCallId", "status", "kind", "title"}, optional: []string{"detail"}},
	"diff":                 {required: []string{"path", "newText"}, optional: []string{"toolCallId", "oldText"}},
	"terminal.output":      {required: []string{"terminalId", "stream", "text"}},
	"usage":                {optional: []string{"inputTokens", "outputTokens", "cachedInputTokens", "costUsd"}},
	"permission.requested": {required: []string{"approvalId", "title", "options"}, optional: []string{"toolCallId", "detail"}},
	"permission.resolved":  {required: []string{"approvalId", "status"}, optional: []string{"selectedOptionId"}},
	"warning":              {required: []string{"code", "message"}},
	"unknown":              {required: []string{"sourceType"}, optional: []string{"detail"}},
}

func (event HarnessEvent) payloadValues() map[string]any {
	entries := event.Entries
	if entries == nil {
		entries = []PlanEntry{}
	}
	options := event.Options
	if options == nil {
		options = []ApprovalOption{}
	}
	values := map[string]any{
		"text": event.Text, "entries": entries, "toolCallId": event.ToolCallID, "status": event.Status,
		"kind": event.Kind, "title": event.Title, "detail": event.Detail, "path": event.Path,
		"oldText": event.OldText, "newText": event.NewText, "terminalId": event.TerminalID, "stream": event.Stream,
		"approvalId": event.ApprovalID, "options": options, "selectedOptionId": event.SelectedOptionID,
		"code": event.Code, "message": event.Message, "sourceType": event.SourceType,
	}
	counts := map[string]*int64{"inputTokens": event.InputTokens, "outputTokens": event.OutputTokens, "cachedInputTokens": event.CachedInputTokens}
	for key, count := range counts {
		if count != nil {
			values[key] = *count
		}
	}
	if event.CostUSD != nil {
		values["costUsd"] = *event.CostUSD
	}
	return values
}

func (event HarnessEvent) MarshalJSON() ([]byte, error) {
	keys, known := harnessEventPayloadKeys[event.Type]
	if !known {
		return nil, fmt.Errorf("harness event type is missing or unknown: %q", event.Type)
	}
	values := event.payloadValues()
	encoded := map[string]any{"type": event.Type, "runId": event.RunID, "sequence": event.Sequence, "at": event.At}
	for _, key := range keys.required {
		encoded[key] = values[key]
	}
	for _, key := range keys.optional {
		if value, present := values[key]; present && value != "" {
			encoded[key] = value
		}
	}
	return json.Marshal(encoded)
}

// HarnessEventMessage is the exact harness.event envelope. It is sent instead of Outbound because
// the hub rejects orchestration envelopes that carry undeclared fields such as activeRuns.
type HarnessEventMessage struct {
	Type  string       `json:"type"`
	Event HarnessEvent `json:"event"`
}

func NewHarnessEventMessage(event HarnessEvent) HarnessEventMessage {
	return HarnessEventMessage{Type: "harness.event", Event: event}
}

// ApprovalUndeliverableMessage reports that an approval decision reached Barista but could not be
// applied, because no live permission request matched it or it conflicted with one.
type ApprovalUndeliverableMessage struct {
	Type       string `json:"type"`
	RunID      string `json:"runId"`
	ApprovalID string `json:"approvalId"`
	Reason     string `json:"reason"`
	At         string `json:"at"`
}

func NewApprovalUndeliverableMessage(runID, approvalID, reason, at string) ApprovalUndeliverableMessage {
	return ApprovalUndeliverableMessage{Type: "approval.undeliverable", RunID: runID, ApprovalID: approvalID, Reason: truncateDiagnostic(reason), At: at}
}

func (message ApprovalUndeliverableMessage) Validate() error {
	if !isIdentifier(message.RunID) || !isIdentifier(message.ApprovalID) || !isTimestamp(message.At) {
		return fmt.Errorf("approval.undeliverable is missing identity or timestamp")
	}
	if !isBounded(message.Reason, diagnosticBytes) {
		return fmt.Errorf("approval.undeliverable reason exceeds its bound")
	}
	return nil
}

func truncateDiagnostic(value string) string {
	if len(value) <= diagnosticBytes {
		return value
	}
	cut := diagnosticBytes
	for cut > 0 && !utf8.RuneStart(value[cut]) {
		cut--
	}
	return value[:cut]
}
