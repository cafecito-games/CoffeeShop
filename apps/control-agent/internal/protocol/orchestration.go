package protocol

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"time"
	"unicode/utf8"
)

// LatestVersion mirrors the TypeScript source of truth.
const LatestVersion = "5"

// SupportedVersions lists every control protocol version accepted during rolling upgrades.
var SupportedVersions = []string{"1", "2", "3", "4", "5"}

const (
	CapabilityReplayBarrier      = "replay-barrier"
	CapabilityHubRPC             = "hub-rpc"
	CapabilityOrchestration      = "orchestration"
	CapabilityInstances          = "instances"
	CapabilityComponentInventory = "component-inventory"
	CapabilityPackReadiness      = "capability-pack-readiness"
)

var capabilityIntroducedIn = map[string]int{
	CapabilityReplayBarrier:      2,
	CapabilityHubRPC:             3,
	CapabilityOrchestration:      4,
	CapabilityInstances:          5,
	CapabilityComponentInventory: 5,
	CapabilityPackReadiness:      5,
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
	WorkspaceRetentionReasons = []string{"dirty", "untracked", "diverged", "locked", "unregistered", "identity-mismatch", "ambiguous", "operator-hold", "policy"}
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

// SessionResumePromptMaximumBytes mirrors sessionResumePromptMaximumBytes in the TypeScript source
// of truth: the bound on the delivery-only prompt sent to a resumed session.
const SessionResumePromptMaximumBytes = 64 * 1024

// SessionResumeUnavailableReason is the exact run.failed error for a dispatch refused only because
// the harness's adapter did not negotiate session resume or load; the hub recognizes it and retries
// with a new session instead of failing the binding. It mirrors sessionResumeUnavailableReason in
// the hub.
const SessionResumeUnavailableReason = "unsupported execution: session resume not available for this harness on this Barista"

// DispatchSessionBinding asks Barista to resume an existing provider session. ResumePrompt, when
// set, replaces the run prompt for a session that actually resumed; a session that could not be
// resumed is replaced by a new one that receives the run prompt.
type DispatchSessionBinding struct {
	ID                string `json:"id"`
	ProviderSessionID string `json:"providerSessionId"`
	ResumePrompt      string `json:"resumePrompt,omitempty"`
}

// Validate checks the binding's identity and bounds without echoing any of its values.
func (binding DispatchSessionBinding) Validate() error {
	if !isIdentifier(binding.ID) || !isIdentifier(binding.ProviderSessionID) {
		return fmt.Errorf("session binding is missing identity")
	}
	if LooksSecretLike(binding.ID) || LooksSecretLike(binding.ProviderSessionID) {
		return fmt.Errorf("session binding identity looks like a credential")
	}
	if len(binding.ResumePrompt) > SessionResumePromptMaximumBytes || !utf8.ValidString(binding.ResumePrompt) {
		return fmt.Errorf("session binding resume prompt exceeds its bound")
	}
	return nil
}

type WorkspaceLeaseGrant struct {
	ID                   string `json:"id"`
	Status               string `json:"status"`
	Policy               string `json:"policy"`
	Cleanup              string `json:"cleanup"`
	Repository           string `json:"repository,omitempty"`
	Root                 string `json:"root"`
	SourcePath           string `json:"sourcePath"`
	BaseRevision         string `json:"baseRevision,omitempty"`
	ResolvedBaseRevision string `json:"resolvedBaseRevision,omitempty"`
	Branch               string `json:"branch,omitempty"`
	WorktreePath         string `json:"worktreePath"`
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
	LeaseID              string `json:"leaseId"`
	Status               string `json:"status"`
	RetentionReason      string `json:"retentionReason,omitempty"`
	ResolvedBaseRevision string `json:"resolvedBaseRevision,omitempty"`
	Detail               string `json:"detail,omitempty"`
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
	if update.ResolvedBaseRevision != "" && !IsResolvedRevision(update.ResolvedBaseRevision) {
		return fmt.Errorf("workspace lease resolved base revision is malformed")
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

// SessionBindingMessage is the exact session.binding envelope. It is sent instead of Outbound
// because the hub rejects orchestration envelopes that carry undeclared fields such as activeRuns.
type SessionBindingMessage struct {
	Type    string               `json:"type"`
	RunID   string               `json:"runId"`
	Binding SessionBindingUpdate `json:"binding"`
	At      string               `json:"at"`
}

func NewSessionBindingMessage(runID string, binding SessionBindingUpdate, at string) SessionBindingMessage {
	return SessionBindingMessage{Type: "session.binding", RunID: runID, Binding: binding, At: at}
}

func (message SessionBindingMessage) Validate() error {
	if !isIdentifier(message.RunID) || !isTimestamp(message.At) {
		return fmt.Errorf("session.binding is missing run identity or timestamp")
	}
	return message.Binding.Validate()
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

// Instance contracts mirror packages/protocol/src/index.ts. Barista registers as version 5, so
// resident-instance supervision and these contracts are deployed behavior, not contract-only.
var InstanceStatuses = []string{"requested", "provisioning", "ready", "busy", "idle", "draining", "released", "failed"}
var AllocationStatuses = []string{"reserved", "provisioning", "active", "lost", "released", "failed"}
var InstanceReleaseModes = []string{"drain", "cancel"}
var InstanceCreatorKinds = []string{"operator", "run", "orchestrator-client"}
var InstanceLifecycleOperations = []string{"create", "release", "renew"}
var InstanceHubMessageTypes = []string{"instance.provision", "instance.release", "dispatch"}
var InstanceControlMessageTypes = []string{"instance.ready", "instance.failed", "instance.released", "register", "heartbeat", "sync.complete"}
var instanceTransitions = map[string][]string{
	"requested":    {"provisioning", "draining", "failed"},
	"provisioning": {"ready", "draining", "failed"},
	"ready":        {"busy", "idle", "provisioning", "draining", "failed"},
	"busy":         {"idle", "provisioning", "draining", "failed"},
	"idle":         {"busy", "provisioning", "draining", "failed"},
	"draining":     {"released", "failed"}, "released": {}, "failed": {},
}
var allocationTransitions = map[string][]string{
	"reserved":     {"provisioning", "released", "failed"},
	"provisioning": {"active", "lost", "released", "failed"},
	"active":       {"lost", "released", "failed"}, "lost": {"released", "failed"}, "released": {}, "failed": {},
}

func CanTransitionInstance(from, to string) bool {
	return slices.Contains(instanceTransitions[from], to)
}
func CanTransitionAllocation(from, to string) bool {
	return slices.Contains(allocationTransitions[from], to)
}

const (
	MinimumInstanceIdleTimeoutSeconds = 60
	DefaultInstanceIdleTimeoutSeconds = 1800
	MaximumInstanceIdleTimeoutSeconds = 86400
	InstanceNameBytes                 = 256
	InstanceSummaryBytes              = 2000
	InstanceInstructionsBytes         = 65536
	InstanceIdempotencyKeyBytes       = 128
	InstanceWorkspaceBytes            = 4096
	InstanceCollectionEntries         = 1024
	InstanceRequirementEntries        = 64
	InstanceCountMaximum              = 65535
)

type InstancePurpose struct {
	Name         *string `json:"name,omitempty"`
	Title        *string `json:"title,omitempty"`
	Summary      *string `json:"summary,omitempty"`
	Instructions *string `json:"instructions,omitempty"`
}

// Identity is derived by the hub from authentication, never from a model's authority claim.
type InstanceCreator struct {
	Kind       string `json:"kind"`
	OperatorID string `json:"operatorId,omitempty"`
	RunID      string `json:"runId,omitempty"`
	InstanceID string `json:"instanceId,omitempty"`
	ClientID   string `json:"clientId,omitempty"`
}
type InstanceDelegationPolicy struct {
	CanDelegate bool `json:"canDelegate"`
}
type InstanceLease struct {
	IdleTimeoutSeconds int    `json:"idleTimeoutSeconds"`
	ExpiresAt          string `json:"expiresAt"`
}
type InstanceExecutionPreferences struct {
	NodeIDs    *[]string `json:"nodeIds,omitempty"`
	HarnessIDs *[]string `json:"harnessIds,omitempty"`
	Models     *[]string `json:"models,omitempty"`
	Labels     *[]string `json:"labels,omitempty"`
}
type InstanceWorkspaceRequirements struct {
	Repository *string `json:"repository,omitempty"`
	Path       *string `json:"path,omitempty"`
	Writable   bool    `json:"writable"`
}
type InstanceExecutionRequirements struct {
	Skills                 *[]string                      `json:"skills,omitempty"`
	HarnessIDs             *[]string                      `json:"harnessIds,omitempty"`
	Models                 *[]string                      `json:"models,omitempty"`
	Transports             *[]string                      `json:"transports,omitempty"`
	OperatingSystems       *[]string                      `json:"operatingSystems,omitempty"`
	Architectures          *[]string                      `json:"architectures,omitempty"`
	Labels                 *[]string                      `json:"labels,omitempty"`
	MinimumConcurrency     *int                           `json:"minimumConcurrency,omitempty"`
	MinimumMemoryMegabytes *int64                         `json:"minimumMemoryMegabytes,omitempty"`
	ProjectProfileID       *string                        `json:"projectProfileId,omitempty"`
	TemplateID             *string                        `json:"templateId,omitempty"`
	Workspace              *InstanceWorkspaceRequirements `json:"workspace,omitempty"`
	Preferences            *InstanceExecutionPreferences  `json:"preferences,omitempty"`
}
type AgentInstance struct {
	ID           string                        `json:"id"`
	ThreadID     string                        `json:"threadId"`
	Creator      InstanceCreator               `json:"creator"`
	Purpose      *InstancePurpose              `json:"purpose,omitempty"`
	Delegation   InstanceDelegationPolicy      `json:"delegation"`
	Requirements InstanceExecutionRequirements `json:"requirements"`
	Lease        InstanceLease                 `json:"lease"`
	Status       string                        `json:"status"`
	CreatedAt    string                        `json:"createdAt"`
	UpdatedAt    string                        `json:"updatedAt"`
}

// Resolved identity/placement is immutable for this ID. Replacement requires a new ID.
type InstanceAllocation struct {
	ID                     string                  `json:"id"`
	InstanceID             string                  `json:"instanceId"`
	NodeID                 string                  `json:"nodeId"`
	HarnessID              string                  `json:"harnessId"`
	Model                  string                  `json:"model"`
	Transport              string                  `json:"transport"`
	Workspace              string                  `json:"workspace"`
	ExpectedCapabilityPack *ExpectedCapabilityPack `json:"expectedCapabilityPack,omitempty"`
	Lease                  InstanceLease           `json:"lease"`
	Status                 string                  `json:"status"`
	CreatedAt              string                  `json:"createdAt"`
	UpdatedAt              string                  `json:"updatedAt"`
}
type AgentTemplate struct {
	ID           string                         `json:"id"`
	Name         string                         `json:"name"`
	Purpose      *InstancePurpose               `json:"purpose,omitempty"`
	Glyph        *string                        `json:"glyph,omitempty"`
	AvatarShape  *string                        `json:"avatarShape,omitempty"`
	AvatarColor  *string                        `json:"avatarColor,omitempty"`
	Instructions *string                        `json:"instructions,omitempty"`
	Skills       *[]string                      `json:"skills,omitempty"`
	Tags         *[]string                      `json:"tags,omitempty"`
	Requirements *InstanceExecutionRequirements `json:"requirements,omitempty"`
	Preferences  *InstanceExecutionPreferences  `json:"preferences,omitempty"`
}
type InstanceActor struct {
	InstanceID   string `json:"instanceId"`
	AllocationID string `json:"allocationId"`
}

// InstanceRun is the complete v5 wire record; legacy Run remains the deployed v1-v4 subset.
type InstanceRun struct {
	ID                 string                 `json:"id"`
	ThreadID           string                 `json:"threadId"`
	InstanceID         string                 `json:"instanceId"`
	AllocationID       string                 `json:"allocationId"`
	NodeID             string                 `json:"nodeId"`
	HarnessID          string                 `json:"harnessId"`
	Model              string                 `json:"model"`
	Workspace          string                 `json:"workspace"`
	Prompt             string                 `json:"prompt"`
	Status             string                 `json:"status"`
	Output             string                 `json:"output"`
	Error              *string                `json:"error,omitempty"`
	Depth              int                    `json:"depth"`
	ParentRunID        *string                `json:"parentRunId,omitempty"`
	DispatchedAt       *string                `json:"dispatchedAt,omitempty"`
	StartedAt          *string                `json:"startedAt,omitempty"`
	FinishedAt         *string                `json:"finishedAt,omitempty"`
	CreatedAt          string                 `json:"createdAt"`
	TaskID             *string                `json:"taskId,omitempty"`
	Attempt            *int                   `json:"attempt,omitempty"`
	Transport          string                 `json:"transport"`
	FallbackTransport  *string                `json:"fallbackTransport,omitempty"`
	TransportSelection *RunTransportSelection `json:"transportSelection,omitempty"`
	SessionBindingID   *string                `json:"sessionBindingId,omitempty"`
	WorkspaceLeaseID   *string                `json:"workspaceLeaseId,omitempty"`
	ProviderSessionID  *string                `json:"providerSessionId,omitempty"`
}
type InstanceHubMessage struct {
	Type           string                  `json:"type"`
	Instance       *AgentInstance          `json:"instance,omitempty"`
	Allocation     *InstanceAllocation     `json:"allocation,omitempty"`
	Run            *InstanceRun            `json:"run,omitempty"`
	SessionBinding *DispatchSessionBinding `json:"sessionBinding,omitempty"`
	InstanceID     string                  `json:"instanceId,omitempty"`
	AllocationID   string                  `json:"allocationId,omitempty"`
	Mode           string                  `json:"mode,omitempty"`
}
type InstanceControlMessage struct {
	Type              string       `json:"type"`
	ProtocolVersion   string       `json:"protocolVersion,omitempty"`
	Node              *ComputeNode `json:"node,omitempty"`
	NodeID            string       `json:"nodeId,omitempty"`
	InstanceID        string       `json:"instanceId,omitempty"`
	AllocationID      string       `json:"allocationId,omitempty"`
	ActiveRuns        *int         `json:"activeRuns,omitempty"`
	ActiveInstances   *int         `json:"activeInstances,omitempty"`
	ActiveRunIDs      *[]string    `json:"activeRunIds,omitempty"`
	ActiveInstanceIDs *[]string    `json:"activeInstanceIds,omitempty"`
	At                string       `json:"at,omitempty"`
	Error             *string      `json:"error,omitempty"`
}

func (message InstanceControlMessage) HasAuthoritativeInstanceEvidence() bool {
	return message.ActiveInstanceIDs != nil && v5IDs(v5Array(*message.ActiveInstanceIDs))
}

type InstanceIdempotency struct {
	Caller InstanceCreator `json:"caller"`
	Key    string          `json:"key"`
}
type InstanceInitialTask struct {
	Title        string `json:"title"`
	Instructions string `json:"instructions"`
}
type InstanceLifecycleRequest struct {
	Operation          string                         `json:"operation"`
	ThreadID           string                         `json:"threadId"`
	InstanceID         string                         `json:"instanceId,omitempty"`
	Idempotency        InstanceIdempotency            `json:"idempotency"`
	Purpose            *InstancePurpose               `json:"purpose,omitempty"`
	Requirements       *InstanceExecutionRequirements `json:"requirements,omitempty"`
	IdleTimeoutSeconds *int                           `json:"idleTimeoutSeconds,omitempty"`
	InitialTask        *InstanceInitialTask           `json:"initialTask,omitempty"`
	Mode               string                         `json:"mode,omitempty"`
}
type InstanceLifecycleResult struct {
	Instance      AgentInstance       `json:"instance"`
	Allocation    *InstanceAllocation `json:"allocation,omitempty"`
	InitialTaskID *string             `json:"initialTaskId,omitempty"`
	Replayed      bool                `json:"replayed"`
}

// A closed JSON rule validates required fields before decoding into structs, so absent, null,
// false, zero, unknown, and an explicit empty array never collapse into the same input.
type v5Rule func(any) bool

func v5Object(required, optional map[string]v5Rule) v5Rule {
	return func(value any) bool {
		object, ok := value.(map[string]any)
		if !ok {
			return false
		}
		for key, rule := range required {
			child, found := object[key]
			if !found || !rule(child) {
				return false
			}
		}
		for key, child := range object {
			if _, found := required[key]; found {
				continue
			}
			rule, found := optional[key]
			if !found || !rule(child) {
				return false
			}
		}
		return true
	}
}
func v5String(minimum, maximum int) v5Rule {
	return func(value any) bool {
		text, ok := value.(string)
		return ok && utf8.ValidString(text) && len(text) >= minimum && len(text) <= maximum
	}
}
func v5Enum(values []string) v5Rule {
	return func(value any) bool { text, ok := value.(string); return ok && slices.Contains(values, text) }
}
func v5Integer(minimum, maximum int64) v5Rule {
	return func(value any) bool {
		number, ok := value.(json.Number)
		if !ok {
			return false
		}
		numeric, err := number.Float64()
		return err == nil && numeric >= float64(minimum) && numeric <= float64(maximum) && numeric == float64(int64(numeric))
	}
}
func v5Boolean(value any) bool { _, ok := value.(bool); return ok }

var instanceIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]*$`)
var instancePathPattern = regexp.MustCompile(`^(/|[A-Za-z]:[\\/])`)

func v5ID(value any) bool {
	text, ok := value.(string)
	return ok && v5String(1, identifierBytes)(text) && instanceIDPattern.MatchString(text)
}
func v5Time(value any) bool { text, ok := value.(string); return ok && isTimestamp(text) }
func v5Path(value any) bool {
	text, ok := value.(string)
	if !ok || !v5String(1, InstanceWorkspaceBytes)(text) || !instancePathPattern.MatchString(text) {
		return false
	}
	for _, character := range text {
		if character < 32 {
			return false
		}
	}
	return true
}
func v5Strings(limit int, rule v5Rule) v5Rule {
	return func(value any) bool {
		items, ok := value.([]any)
		if !ok || len(items) > limit {
			return false
		}
		seen := map[string]bool{}
		for _, item := range items {
			text, ok := item.(string)
			if !ok || !rule(item) || seen[text] {
				return false
			}
			seen[text] = true
		}
		return true
	}
}
func v5Array(values []string) []any {
	result := make([]any, len(values))
	for index, value := range values {
		result[index] = value
	}
	return result
}

var v5IDs = v5Strings(InstanceCollectionEntries, v5ID)
var v5Names = v5Strings(InstanceRequirementEntries, v5String(1, identifierBytes))
var v5Count = v5Integer(0, InstanceCountMaximum)
var v5Idle = v5Integer(MinimumInstanceIdleTimeoutSeconds, MaximumInstanceIdleTimeoutSeconds)
var v5Purpose = v5Object(nil, map[string]v5Rule{"name": v5String(0, InstanceNameBytes), "title": v5String(0, InstanceNameBytes), "summary": v5String(0, InstanceSummaryBytes), "instructions": v5String(0, InstanceInstructionsBytes)})

func v5Creator(value any) bool {
	object, ok := value.(map[string]any)
	if !ok {
		return false
	}
	switch object["kind"] {
	case "operator":
		return v5Object(map[string]v5Rule{"kind": v5Enum([]string{"operator"}), "operatorId": v5ID}, nil)(value)
	case "run":
		return v5Object(map[string]v5Rule{"kind": v5Enum([]string{"run"}), "runId": v5ID, "instanceId": v5ID}, nil)(value)
	case "orchestrator-client":
		return v5Object(map[string]v5Rule{"kind": v5Enum([]string{"orchestrator-client"}), "clientId": v5ID}, nil)(value)
	default:
		return false
	}
}

var v5Lease = v5Object(map[string]v5Rule{"idleTimeoutSeconds": v5Idle, "expiresAt": v5Time}, nil)
var v5Preferences = v5Object(nil, map[string]v5Rule{"nodeIds": v5Names, "harnessIds": v5Strings(InstanceRequirementEntries, v5Enum(HarnessIDs)), "models": v5Names, "labels": v5Names})
var v5Requirements = v5Object(nil, map[string]v5Rule{
	"skills": v5Names, "harnessIds": v5Strings(InstanceRequirementEntries, v5Enum(HarnessIDs)), "models": v5Names,
	"transports": v5Strings(InstanceRequirementEntries, v5Enum(HarnessTransports)), "operatingSystems": v5Names, "architectures": v5Names, "labels": v5Names,
	"minimumConcurrency": v5Count, "minimumMemoryMegabytes": v5Integer(0, 4294967295), "projectProfileId": v5ID, "templateId": v5ID, "preferences": v5Preferences,
	"workspace": v5Object(map[string]v5Rule{"writable": v5Boolean}, map[string]v5Rule{"repository": v5String(0, InstanceWorkspaceBytes), "path": v5Path}),
})
var v5Instance = v5Object(map[string]v5Rule{
	"id": v5ID, "threadId": v5ID, "creator": v5Creator, "delegation": v5Object(map[string]v5Rule{"canDelegate": v5Boolean}, nil),
	"requirements": v5Requirements, "lease": v5Lease, "status": v5Enum(InstanceStatuses), "createdAt": v5Time, "updatedAt": v5Time,
}, map[string]v5Rule{"purpose": v5Purpose})
var v5Allocation = v5Object(map[string]v5Rule{
	"id": v5ID, "instanceId": v5ID, "nodeId": v5ID, "harnessId": v5Enum(HarnessIDs), "model": v5String(1, identifierBytes),
	"transport": v5Enum(HarnessTransports), "workspace": v5Path, "lease": v5Lease, "status": v5Enum(AllocationStatuses), "createdAt": v5Time, "updatedAt": v5Time,
}, map[string]v5Rule{"expectedCapabilityPack": v5ExpectedCapabilityPack})
var v5Template = v5Object(map[string]v5Rule{"id": v5ID, "name": v5String(1, InstanceNameBytes)}, map[string]v5Rule{
	"purpose": v5Purpose, "glyph": v5String(1, identifierBytes), "avatarShape": v5Enum([]string{"cup", "bean", "moka", "kettle", "grinder", "pour-over"}),
	"avatarColor": v5Enum([]string{"amber", "sage", "clay", "sky", "plum", "rose"}), "instructions": v5String(0, InstanceInstructionsBytes),
	"skills": v5Names, "tags": v5Names, "requirements": v5Requirements, "preferences": v5Preferences,
})
var v5Run = v5Object(map[string]v5Rule{
	"id": v5ID, "threadId": v5ID, "instanceId": v5ID, "allocationId": v5ID, "nodeId": v5ID, "harnessId": v5Enum(HarnessIDs),
	"model": v5String(1, identifierBytes), "workspace": v5Path, "prompt": v5String(0, InstanceInstructionsBytes),
	"status": v5Enum([]string{"queued", "running", "completed", "failed", "cancelled"}), "output": v5String(0, InstanceInstructionsBytes),
	"depth": v5Count, "createdAt": v5Time, "transport": v5Enum(HarnessTransports),
}, map[string]v5Rule{
	"error": v5String(0, diagnosticBytes), "parentRunId": v5ID, "taskId": v5ID, "attempt": v5Integer(1, InstanceCountMaximum),
	"dispatchedAt": v5Time, "startedAt": v5Time, "finishedAt": v5Time, "fallbackTransport": v5Enum([]string{"native-cli"}),
	"sessionBindingId": v5ID, "workspaceLeaseId": v5ID, "providerSessionId": v5ID,
	"transportSelection": func(value any) bool {
		if !v5Object(map[string]v5Rule{"requestedTransport": v5Enum(HarnessTransports), "selectedTransport": v5Enum(HarnessTransports)}, map[string]v5Rule{
			"fallbackReason": v5Enum(TransportFallbackReasons), "harnessVersion": v5NormalizedVersion,
			"approvalPolicy": v5Enum(ApprovalPolicies), "acp": v5ACP,
			"effectiveCapabilityPack": v5EffectiveCapabilityPack,
			"adapter": v5Object(map[string]v5Rule{
				"id": func(value any) bool {
					text, ok := value.(string)
					return ok && len(text) <= LabelOrAcceleratorMaximumBytes && LabelOrAcceleratorPattern.MatchString(text)
				},
				"version": v5NormalizedVersion, "source": v5Enum(ACPAdapterSources),
			}, nil),
		})(value) {
			return false
		}
		data, err := json.Marshal(value)
		if err != nil {
			return false
		}
		var selection RunTransportSelection
		return json.Unmarshal(data, &selection) == nil && selection.Validate() == nil
	},
})

func v5DispatchSessionBinding(value any) bool {
	if !v5Object(map[string]v5Rule{
		"id": v5String(1, identifierBytes), "providerSessionId": v5String(1, identifierBytes),
	}, map[string]v5Rule{"resumePrompt": v5String(0, SessionResumePromptMaximumBytes)})(value) {
		return false
	}
	data, err := json.Marshal(value)
	if err != nil {
		return false
	}
	var binding DispatchSessionBinding
	return json.Unmarshal(data, &binding) == nil && binding.Validate() == nil
}

func decodeInstanceValue(data []byte, rule v5Rule, target any) error {
	if !utf8.Valid(data) {
		return fmt.Errorf("invalid instance UTF-8")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	if !rule(value) {
		return fmt.Errorf("invalid or unknown instance fields")
	}
	// Unmarshal rejects trailing JSON, while the rule rejects null and unknown fields recursively.
	return json.Unmarshal(data, target)
}
func DecodeAgentInstance(data []byte) (AgentInstance, error) {
	var result AgentInstance
	err := decodeInstanceValue(data, v5Instance, &result)
	return result, err
}
func DecodeInstanceAllocation(data []byte) (InstanceAllocation, error) {
	var result InstanceAllocation
	err := decodeInstanceValue(data, v5Allocation, &result)
	return result, err
}
func DecodeAgentTemplate(data []byte) (AgentTemplate, error) {
	var result AgentTemplate
	err := decodeInstanceValue(data, v5Template, &result)
	return result, err
}

// ValidateCurrentInstanceHubMessage applies invariants every current Hub writer must satisfy. The
// rolling wire decoder below has one deliberately narrower compatibility exception: it removes an
// obsolete no-skill expectation emitted by the immediately preceding Hub release before this
// validator can interpret it as capability-pack authority.
func ValidateCurrentInstanceHubMessage(message InstanceHubMessage) error {
	if message.Type == "instance.release" {
		return nil
	}
	if message.Instance == nil || message.Allocation == nil {
		return fmt.Errorf("instance and allocation are required")
	}
	instance, allocation := message.Instance, message.Allocation
	if instance.ID != allocation.InstanceID || instance.Lease != allocation.Lease {
		return fmt.Errorf("instance allocation identity or lease mismatch")
	}
	requiredSkills := []string{}
	if message.Instance.Requirements.Skills != nil {
		requiredSkills = *message.Instance.Requirements.Skills
	}
	expected := message.Allocation.ExpectedCapabilityPack
	if len(requiredSkills) == 0 && expected != nil {
		return fmt.Errorf("instance skill requirements and allocation capability pack expectation mismatch")
	}
	if len(requiredSkills) > 0 && expected == nil {
		return fmt.Errorf("instance skill requirements and allocation capability pack expectation mismatch")
	}
	if expected != nil {
		covered := make(map[string]struct{}, len(expected.RequiredSkills))
		for _, skill := range expected.RequiredSkills {
			covered[skill] = struct{}{}
		}
		for _, skill := range requiredSkills {
			if _, ok := covered[skill]; !ok {
				return fmt.Errorf("instance skill requirements and allocation capability pack expectation mismatch")
			}
		}
	}
	if message.Type == "instance.provision" {
		if instance.Status != "provisioning" || !slices.Contains([]string{"reserved", "provisioning"}, allocation.Status) {
			return fmt.Errorf("invalid provision state")
		}
		return nil
	}
	if message.Type != "dispatch" || message.Run == nil {
		return fmt.Errorf("unknown instance message")
	}
	run := message.Run
	identityMatches := run.InstanceID == instance.ID && run.AllocationID == allocation.ID && run.ThreadID == instance.ThreadID
	placementMatches := run.NodeID == allocation.NodeID && run.HarnessID == allocation.HarnessID && run.Model == allocation.Model &&
		run.Transport == allocation.Transport && run.Workspace == allocation.Workspace
	stateAllowsDispatch := run.Status == "queued" && allocation.Status == "active" &&
		slices.Contains([]string{"ready", "busy", "idle"}, instance.Status)
	bindingMatches := (run.SessionBindingID == nil) == (message.SessionBinding == nil)
	if bindingMatches && message.SessionBinding != nil {
		bindingMatches = run.Transport == "acp-v1" && *run.SessionBindingID == message.SessionBinding.ID
	}
	if !identityMatches || !placementMatches || !stateAllowsDispatch || !bindingMatches || (run.FallbackTransport != nil && run.Transport != "acp-v1") {
		return fmt.Errorf("invalid dispatch identity, state, or placement")
	}
	return nil
}

func DecodeInstanceHubMessage(data []byte, version string) (InstanceHubMessage, error) {
	var message InstanceHubMessage
	if !SupportsCapability(version, CapabilityInstances) {
		return message, fmt.Errorf("instances require protocol v5")
	}
	rule := func(value any) bool {
		object, ok := value.(map[string]any)
		if !ok {
			return false
		}
		switch object["type"] {
		case "instance.release":
			return v5Object(map[string]v5Rule{"type": v5Enum([]string{"instance.release"}), "instanceId": v5ID, "allocationId": v5ID, "mode": v5Enum(InstanceReleaseModes)}, nil)(value)
		case "instance.provision":
			return v5Object(map[string]v5Rule{"type": v5Enum([]string{"instance.provision"}), "instance": v5Instance, "allocation": v5Allocation}, nil)(value)
		case "dispatch":
			return v5Object(map[string]v5Rule{"type": v5Enum([]string{"dispatch"}), "instance": v5Instance, "allocation": v5Allocation, "run": v5Run}, map[string]v5Rule{"sessionBinding": v5DispatchSessionBinding})(value)
		default:
			return false
		}
	}
	if err := decodeInstanceValue(data, rule, &message); err != nil {
		return message, err
	}
	if message.Type == "instance.release" {
		return message, nil
	}
	instance, allocation := message.Instance, message.Allocation
	/*
		Rolling compatibility for exactly one prior Hub release: that writer could attach an
		expectation to a genuinely no-skill instance. It granted no skill authority, so discard it
		before admission. Missing or non-covering expectations for skill work remain strict failures.
	*/
	if (instance.Requirements.Skills == nil || len(*instance.Requirements.Skills) == 0) && allocation.ExpectedCapabilityPack != nil {
		allocation.ExpectedCapabilityPack = nil
	}
	if err := ValidateCurrentInstanceHubMessage(message); err != nil {
		return message, err
	}
	return message, nil
}

func v5NormalizedVersion(value any) bool {
	text, ok := value.(string)
	return ok && IsNormalizedVersion(text)
}

var v5ACP = v5Object(map[string]v5Rule{
	"protocolVersion": v5Integer(1, 1), "loadSession": v5Boolean, "resumeSession": v5Boolean,
	"prompt": v5Object(map[string]v5Rule{"image": v5Boolean, "audio": v5Boolean, "embeddedContext": v5Boolean}, nil),
	"mcp":    v5Object(map[string]v5Rule{"http": v5Boolean, "sse": v5Boolean}, nil),
}, map[string]v5Rule{
	"adapterName": func(value any) bool {
		text, ok := value.(string)
		return ok && v5String(0, ACPAdapterNameMaximumBytes)(text) && !LooksSecretLike(text)
	},
	"adapterVersion": v5NormalizedVersion,
})
var v5Harness = v5Object(map[string]v5Rule{
	"id": v5Enum(HarnessIDs), "label": v5String(1, identifierBytes), "description": v5String(0, diagnosticBytes), "available": v5Boolean,
	"authMode": v5Enum([]string{"local-subscription", "local-account", "api", "none"}), "models": v5Names,
}, map[string]v5Rule{"binary": v5String(0, InstanceWorkspaceBytes), "transports": v5Strings(InstanceRequirementEntries, v5Enum(HarnessTransports)), "acp": v5ACP, "approvalPolicy": v5Enum(ApprovalPolicies)})
var v5Node = v5Object(map[string]v5Rule{
	"id": v5ID, "name": v5String(1, identifierBytes), "kind": v5Enum([]string{"local", "home-server", "cloud"}),
	"platform": v5String(1, identifierBytes), "status": v5Enum([]string{"online", "offline", "busy"}), "lastSeen": v5Time,
	"activeRuns": v5Count, "concurrency": v5Count, "workspaceRoots": v5Strings(InstanceRequirementEntries, v5Path), "version": v5String(1, identifierBytes),
	"harnesses": func(value any) bool {
		items, ok := value.([]any)
		if !ok || len(items) > InstanceRequirementEntries {
			return false
		}
		seen := map[any]bool{}
		for _, item := range items {
			if !v5Harness(item) {
				return false
			}
			id := item.(map[string]any)["id"]
			if seen[id] {
				return false
			}
			seen[id] = true
		}
		return true
	},
}, map[string]v5Rule{"instanceCapacity": v5Count, "activeInstances": v5Count})

func DecodeInstanceControlMessage(data []byte, version string) (InstanceControlMessage, error) {
	var message InstanceControlMessage
	if !SupportsCapability(version, CapabilityInstances) {
		return message, fmt.Errorf("instances require protocol v5")
	}
	rule := func(value any) bool {
		object, ok := value.(map[string]any)
		if !ok {
			return false
		}
		required := map[string]v5Rule{"type": v5Enum(InstanceControlMessageTypes)}
		optional := map[string]v5Rule{}
		switch object["type"] {
		case "register":
			required["protocolVersion"] = v5Enum([]string{version})
			required["node"] = v5Node
		case "heartbeat":
			required["nodeId"] = v5ID
			required["at"] = v5Time
			required["activeRuns"] = v5Count
			optional["activeInstances"] = v5Count
			optional["activeInstanceIds"] = v5IDs
		case "sync.complete":
			required["nodeId"] = v5ID
			required["at"] = v5Time
			optional["activeRuns"] = v5Count
			optional["activeRunIds"] = v5IDs
			optional["activeInstanceIds"] = v5IDs
		case "instance.ready", "instance.failed", "instance.released":
			required["nodeId"] = v5ID
			required["at"] = v5Time
			required["instanceId"] = v5ID
			required["allocationId"] = v5ID
			if object["type"] == "instance.failed" {
				required["error"] = v5String(0, diagnosticBytes)
			}
		default:
			return false
		}
		return v5Object(required, optional)(value)
	}
	if err := decodeInstanceValue(data, rule, &message); err != nil {
		return message, err
	}
	if node := message.Node; node != nil && node.InstanceCapacity != nil && node.ActiveInstances != nil && *node.ActiveInstances > *node.InstanceCapacity {
		return message, fmt.Errorf("resident count exceeds capacity")
	}
	return message, nil
}
func DecodeInstanceLifecycleRequest(data []byte) (InstanceLifecycleRequest, error) {
	var request InstanceLifecycleRequest
	rule := func(value any) bool {
		object, ok := value.(map[string]any)
		if !ok {
			return false
		}
		required := map[string]v5Rule{"operation": v5Enum(InstanceLifecycleOperations), "threadId": v5ID,
			"idempotency": v5Object(map[string]v5Rule{"caller": v5Creator, "key": v5String(1, InstanceIdempotencyKeyBytes)}, nil)}
		optional := map[string]v5Rule{}
		switch object["operation"] {
		case "create":
			required["requirements"] = v5Requirements
			optional["purpose"] = v5Purpose
			optional["idleTimeoutSeconds"] = v5Idle
			optional["initialTask"] = v5Object(map[string]v5Rule{"title": v5String(1, identifierBytes), "instructions": v5String(0, InstanceInstructionsBytes)}, nil)
		case "release":
			required["instanceId"] = v5ID
			required["mode"] = v5Enum(InstanceReleaseModes)
		case "renew":
			required["instanceId"] = v5ID
			optional["idleTimeoutSeconds"] = v5Idle
		default:
			return false
		}
		return v5Object(required, optional)(value)
	}
	err := decodeInstanceValue(data, rule, &request)
	return request, err
}
