package protocol

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// LatestVersion mirrors the TypeScript source of truth.
const LatestVersion = "6"

// SupportedVersions lists every control protocol version accepted during rolling upgrades.
var SupportedVersions = []string{"1", "2", "3", "4", "5", "6"}

const (
	CapabilityReplayBarrier       = "replay-barrier"
	CapabilityHubRPC              = "hub-rpc"
	CapabilityOrchestration       = "orchestration"
	CapabilityInstances           = "instances"
	CapabilityComponentInventory  = "component-inventory"
	CapabilityPackReadiness       = "capability-pack-readiness"
	CapabilityInteractiveSessions = "interactive-sessions"
)

var capabilityIntroducedIn = map[string]int{
	CapabilityReplayBarrier:       2,
	CapabilityHubRPC:              3,
	CapabilityOrchestration:       4,
	CapabilityInstances:           5,
	CapabilityComponentInventory:  5,
	CapabilityPackReadiness:       5,
	CapabilityInteractiveSessions: 6,
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

var (
	HostHarnessSessionSources             = []string{"coffee-shop-managed", "provider-history", "external-live"}
	HostHarnessSessionStatuses            = []string{"idle", "running", "awaiting-approval", "active-elsewhere", "offline", "closed", "failed"}
	HostHarnessSessionControlModes        = []string{"observe", "resume", "full"}
	HostHarnessSessionOperations          = []string{"read-history", "attach", "detach", "start-turn", "steer", "interrupt", "resolve-approval", "close"}
	HostHarnessDriverOperations           = []string{"discover", "create", "adopt"}
	HostHarnessSessionCommandOperations   = []string{"create", "adopt", "attach", "detach", "start-turn", "steer", "interrupt", "resolve-approval", "close"}
	HostHarnessSessionCommandDispositions = []string{"recorded", "replayed"}
	HostHarnessSessionCommandOutcomes     = []string{"succeeded", "rejected", "uncertain"}
	HostHarnessSessionHistoryKinds        = []string{"user", "assistant", "system", "summary"}
	RuntimeActorKinds                     = []string{"agent", "instance", "host-session"}
	ThreadOrchestratorKinds               = []string{"agent", "external", "instance", "host-session"}
	RunStatuses                           = []string{"queued", "running", "completed", "failed", "cancelled"}
	HostSessionHubMessageTypes            = []string{
		"host-session.create", "host-session.adopt", "host-session.attach", "host-session.detach",
		"host-session.history.read", "host-session.turn.start", "host-session.turn.steer",
		"host-session.turn.interrupt", "host-session.approval.decision", "host-session.close",
	}
	HostSessionControlMessageTypes = []string{
		"host-session.inventory.page", "host-session.inventory.complete", "host-session.update",
		"host-session.history.page", "host-session.harness-event", "host-session.command.ack",
		"host-session.command.result",
	}
	HostHarnessSessionTransitions = map[string][]string{
		"idle":              {"running", "active-elsewhere", "offline", "closed", "failed"},
		"running":           {"awaiting-approval", "idle", "active-elsewhere", "offline", "closed", "failed"},
		"awaiting-approval": {"running", "idle", "active-elsewhere", "offline", "closed", "failed"},
		"active-elsewhere":  {"idle", "offline", "closed", "failed"},
		"offline":           {"idle", "running", "awaiting-approval", "active-elsewhere", "closed", "failed"},
		"closed":            {},
		"failed":            {},
	}
)

type HostHarnessSessionLimitSet struct {
	IdentifierBytes          int `json:"identifierBytes"`
	WorkspaceBytes           int `json:"workspaceBytes"`
	DiagnosticBytes          int `json:"diagnosticBytes"`
	PromptBytes              int `json:"promptBytes"`
	OperationCapabilities    int `json:"operationCapabilities"`
	SessionsPerInventoryPage int `json:"sessionsPerInventoryPage"`
	PagesPerGeneration       int `json:"pagesPerGeneration"`
	SessionsPerGeneration    int `json:"sessionsPerGeneration"`
	HistoryItemsPerPage      int `json:"historyItemsPerPage"`
	HistoryItemTextBytes     int `json:"historyItemTextBytes"`
	HistoryCursorBytes       int `json:"historyCursorBytes"`
}

var HostHarnessSessionLimits = HostHarnessSessionLimitSet{
	IdentifierBytes: 256, WorkspaceBytes: 4096, DiagnosticBytes: 2000, PromptBytes: 65536,
	OperationCapabilities: 16, SessionsPerInventoryPage: 64, PagesPerGeneration: 64,
	SessionsPerGeneration: 4096, HistoryItemsPerPage: 100, HistoryItemTextBytes: 32768,
	HistoryCursorBytes: 512,
}

func CanTransitionHostHarnessSession(from, to string) bool {
	return slices.Contains(HostHarnessSessionTransitions[from], to)
}

type HostHarnessSessionInteractiveProfile struct {
	Operations []string `json:"operations"`
}

func (profile HostHarnessSessionInteractiveProfile) Validate() error {
	if len(profile.Operations) > HostHarnessSessionLimits.OperationCapabilities || !sortedUniqueStrings(profile.Operations, HostHarnessDriverOperations) {
		return fmt.Errorf("interactive session profile operations are malformed")
	}
	return nil
}

type HostHarnessSessionObservation struct {
	HostHarnessSessionID string   `json:"hostHarnessSessionId"`
	NodeID               string   `json:"nodeId"`
	HarnessID            string   `json:"harnessId"`
	ProviderSessionID    string   `json:"providerSessionId"`
	Workspace            string   `json:"workspace"`
	Source               string   `json:"source"`
	Status               string   `json:"status"`
	ControlMode          string   `json:"controlMode"`
	Operations           []string `json:"operations"`
	Revision             int64    `json:"revision"`
	ProviderTurnID       string   `json:"providerTurnId,omitempty"`
	Summary              string   `json:"summary,omitempty"`
	CreatedAt            string   `json:"createdAt"`
	UpdatedAt            string   `json:"updatedAt"`
}

type HostHarnessSession struct {
	HostHarnessSessionObservation
	AttachedThreadID string `json:"attachedThreadId,omitempty"`
	ActiveRunID      string `json:"activeRunId,omitempty"`
	AttachmentEpoch  int64  `json:"attachmentEpoch"`
}

type HostHarnessSessionActor struct {
	Kind                 string `json:"kind"`
	HostHarnessSessionID string `json:"hostHarnessSessionId"`
}

func (actor HostHarnessSessionActor) Validate() error {
	if actor.Kind != "host-session" || !hostSessionIdentifier(actor.HostHarnessSessionID) {
		return fmt.Errorf("invalid host-session actor")
	}
	return nil
}

type HostHarnessSessionThreadOrchestrator struct {
	Kind                 string `json:"kind"`
	HostHarnessSessionID string `json:"hostHarnessSessionId"`
}

func (orchestrator HostHarnessSessionThreadOrchestrator) Validate() error {
	if orchestrator.Kind != "host-session" || !hostSessionIdentifier(orchestrator.HostHarnessSessionID) {
		return fmt.Errorf("invalid host-session thread orchestrator")
	}
	return nil
}

// HostHarnessSessionRun is the mutually exclusive host-session Run projection. It deliberately
// has no agentId, instanceId, or allocationId field.
type HostHarnessSessionRun struct {
	ID                   string                 `json:"id"`
	ThreadID             string                 `json:"threadId"`
	HostHarnessSessionID string                 `json:"hostHarnessSessionId"`
	NodeID               string                 `json:"nodeId"`
	HarnessID            string                 `json:"harnessId"`
	Model                string                 `json:"model"`
	Workspace            string                 `json:"workspace"`
	Prompt               string                 `json:"prompt"`
	Status               string                 `json:"status"`
	Output               string                 `json:"output"`
	Error                *string                `json:"error,omitempty"`
	Depth                int64                  `json:"depth"`
	ParentRunID          *string                `json:"parentRunId,omitempty"`
	DispatchedAt         *string                `json:"dispatchedAt,omitempty"`
	StartedAt            *string                `json:"startedAt,omitempty"`
	FinishedAt           *string                `json:"finishedAt,omitempty"`
	CreatedAt            string                 `json:"createdAt"`
	TaskID               *string                `json:"taskId,omitempty"`
	Attempt              *int64                 `json:"attempt,omitempty"`
	Transport            *string                `json:"transport,omitempty"`
	FallbackTransport    *string                `json:"fallbackTransport,omitempty"`
	TransportSelection   *RunTransportSelection `json:"transportSelection,omitempty"`
	SessionBindingID     *string                `json:"sessionBindingId,omitempty"`
	WorkspaceLeaseID     *string                `json:"workspaceLeaseId,omitempty"`
	ProviderSessionID    *string                `json:"providerSessionId,omitempty"`
	ProviderTurnID       *string                `json:"providerTurnId,omitempty"`
}

func (run HostHarnessSessionRun) Validate(orchestrator HostHarnessSessionThreadOrchestrator) error {
	if err := orchestrator.Validate(); err != nil || run.HostHarnessSessionID != orchestrator.HostHarnessSessionID {
		return fmt.Errorf("host session Run requires a matching host-session thread orchestrator")
	}
	if !hostSessionIdentifier(run.ID) || !hostSessionIdentifier(run.ThreadID) || !hostSessionIdentifier(run.HostHarnessSessionID) ||
		!hostSessionIdentifier(run.NodeID) || !slices.Contains(HarnessIDs, run.HarnessID) ||
		!hostSessionBounded(run.Model, HostHarnessSessionLimits.IdentifierBytes, true) ||
		!canonicalHostSessionWorkspace(run.Workspace) || !hostSessionBounded(run.Prompt, HostHarnessSessionLimits.PromptBytes, false) ||
		!slices.Contains(RunStatuses, run.Status) || !hostSessionBounded(run.Output, HostHarnessSessionLimits.PromptBytes, false) ||
		run.Depth < 0 || run.Depth > hostSessionMaximumSafeInteger || !isTimestamp(run.CreatedAt) {
		return fmt.Errorf("host session Run payload is malformed")
	}
	for _, identifier := range []*string{run.ParentRunID, run.TaskID, run.SessionBindingID, run.WorkspaceLeaseID, run.ProviderSessionID, run.ProviderTurnID} {
		if identifier != nil && !hostSessionIdentifier(*identifier) {
			return fmt.Errorf("host session Run optional identity is malformed")
		}
	}
	for _, timestamp := range []*string{run.DispatchedAt, run.StartedAt, run.FinishedAt} {
		if timestamp != nil && !isTimestamp(*timestamp) {
			return fmt.Errorf("host session Run timestamp is malformed")
		}
	}
	if run.Error != nil && !hostSessionBounded(*run.Error, HostHarnessSessionLimits.DiagnosticBytes, false) {
		return fmt.Errorf("host session Run error is malformed")
	}
	if run.Attempt != nil && (*run.Attempt < 1 || *run.Attempt > hostSessionMaximumSafeInteger) {
		return fmt.Errorf("host session Run attempt is malformed")
	}
	if run.Transport != nil && !slices.Contains(HarnessTransports, *run.Transport) {
		return fmt.Errorf("host session Run transport is malformed")
	}
	if run.FallbackTransport != nil && (run.Transport == nil || *run.Transport != "acp-v1" || *run.FallbackTransport != "native-cli") {
		return fmt.Errorf("host session Run fallback transport is malformed")
	}
	if run.TransportSelection != nil {
		if err := run.TransportSelection.Validate(); err != nil {
			return fmt.Errorf("host session Run transport selection is malformed: %w", err)
		}
	}
	if run.Status == "queued" && run.ProviderTurnID != nil {
		return fmt.Errorf("queued host session Run cannot have a provider turn")
	}
	if (run.Status == "running" || run.Status == "completed") && run.ProviderTurnID == nil {
		return fmt.Errorf("accepted host session Run requires a provider turn")
	}
	return nil
}

func (session HostHarnessSessionObservation) Validate() error {
	if !hostSessionIdentifier(session.HostHarnessSessionID) || !hostSessionIdentifier(session.NodeID) ||
		!slices.Contains(HarnessIDs, session.HarnessID) || !hostSessionIdentifier(session.ProviderSessionID) ||
		!canonicalHostSessionWorkspace(session.Workspace) {
		return fmt.Errorf("host session observation identity is malformed")
	}
	if !slices.Contains(HostHarnessSessionSources, session.Source) || !slices.Contains(HostHarnessSessionStatuses, session.Status) ||
		!slices.Contains(HostHarnessSessionControlModes, session.ControlMode) ||
		len(session.Operations) > HostHarnessSessionLimits.OperationCapabilities ||
		!sortedUniqueStrings(session.Operations, HostHarnessSessionOperations) {
		return fmt.Errorf("host session observation vocabulary is malformed")
	}
	if session.Revision < 1 || session.Revision > hostSessionMaximumSafeInteger ||
		(session.ProviderTurnID != "" && !hostSessionIdentifier(session.ProviderTurnID)) ||
		!hostSessionBounded(session.Summary, HostHarnessSessionLimits.DiagnosticBytes, false) ||
		!isTimestamp(session.CreatedAt) || !isTimestamp(session.UpdatedAt) {
		return fmt.Errorf("host session observation metadata is malformed")
	}
	created, _ := time.Parse(time.RFC3339Nano, session.CreatedAt)
	updated, _ := time.Parse(time.RFC3339Nano, session.UpdatedAt)
	if updated.Before(created) {
		return fmt.Errorf("host session observation timestamp regressed")
	}
	return nil
}

func (session HostHarnessSession) Validate() error {
	if err := session.HostHarnessSessionObservation.Validate(); err != nil {
		return err
	}
	if session.AttachmentEpoch < 0 || session.AttachmentEpoch > hostSessionMaximumSafeInteger ||
		(session.AttachedThreadID != "" && !hostSessionIdentifier(session.AttachedThreadID)) ||
		(session.ActiveRunID != "" && !hostSessionIdentifier(session.ActiveRunID)) {
		return fmt.Errorf("host session attachment projection is malformed")
	}
	return nil
}

func sortedUniqueStrings(values, vocabulary []string) bool {
	for index, value := range values {
		if !slices.Contains(vocabulary, value) || (index > 0 && values[index-1] >= value) {
			return false
		}
	}
	return true
}

func hostSessionBounded(value string, limit int, nonEmpty bool) bool {
	return utf8.ValidString(value) && len(value) <= limit && (!nonEmpty || value != "") && !LooksSecretLike(value)
}

func hostSessionIdentifier(value string) bool {
	return hostSessionBounded(value, HostHarnessSessionLimits.IdentifierBytes, true)
}

func canonicalHostSessionWorkspace(value string) bool {
	if !hostSessionBounded(value, HostHarnessSessionLimits.WorkspaceBytes, true) {
		return false
	}
	for _, character := range value {
		if character < 32 {
			return false
		}
	}
	path := value
	if len(path) >= 3 && ((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')) && path[1] == ':' && (path[2] == '/' || path[2] == '\\') {
		path = strings.ReplaceAll(path[2:], "\\", "/")
	} else if !strings.HasPrefix(path, "/") {
		return false
	}
	if path != "/" && strings.HasSuffix(path, "/") {
		return false
	}
	for _, segment := range strings.Split(strings.TrimPrefix(path, "/"), "/") {
		if segment == "" && path != "/" || segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

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
	"status": v5Enum(RunStatuses), "output": v5String(0, InstanceInstructionsBytes),
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
var v6InteractiveSessionProfile = func(value any) bool {
	if !v5Object(map[string]v5Rule{
		"operations": v5Strings(HostHarnessSessionLimits.OperationCapabilities, v5Enum(HostHarnessDriverOperations)),
	}, nil)(value) {
		return false
	}
	data, err := json.Marshal(value)
	if err != nil {
		return false
	}
	var profile HostHarnessSessionInteractiveProfile
	return json.Unmarshal(data, &profile) == nil && profile.Validate() == nil
}

func versionedHarnessProfileRule(version string) v5Rule {
	optional := map[string]v5Rule{
		"binary": v5String(0, InstanceWorkspaceBytes), "transports": v5Strings(InstanceRequirementEntries, v5Enum(HarnessTransports)),
		"acp": v5ACP, "approvalPolicy": v5Enum(ApprovalPolicies),
	}
	if SupportsCapability(version, CapabilityInteractiveSessions) {
		optional["interactiveSessions"] = v6InteractiveSessionProfile
	}
	return v5Object(map[string]v5Rule{
		"id": v5Enum(HarnessIDs), "label": v5String(1, identifierBytes), "description": v5String(0, diagnosticBytes), "available": v5Boolean,
		"authMode": v5Enum([]string{"local-subscription", "local-account", "api", "none"}), "models": v5Names,
	}, optional)
}

func versionedNodeRule(version string) v5Rule {
	harnessRule := versionedHarnessProfileRule(version)
	return v5Object(map[string]v5Rule{
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
				if !harnessRule(item) {
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
}

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
			registeredVersion, _ := object["protocolVersion"].(string)
			required["protocolVersion"] = func(value any) bool {
				registeredVersion, ok := value.(string)
				if !ok || !SupportsCapability(registeredVersion, CapabilityInstances) {
					return false
				}
				registered, registeredError := strconv.Atoi(registeredVersion)
				accepted, acceptedError := strconv.Atoi(version)
				return registeredError == nil && acceptedError == nil && registered <= accepted
			}
			required["node"] = versionedNodeRule(registeredVersion)
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

// Host-session v6 uses closed JSON rules before struct decoding so absent/null/zero/unknown inputs
// never collapse through Go's zero values. The TypeScript contract remains the vocabulary source of
// truth; the checked-in control-v6 fixtures are consumed by both implementations.
const hostSessionMaximumSafeInteger int64 = 9007199254740991

var hostSessionDigestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var hostSessionCodePattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

type HostSessionHubMessage struct {
	Type                 string            `json:"type"`
	NodeID               string            `json:"nodeId"`
	RequestID            string            `json:"requestId,omitempty"`
	CommandID            string            `json:"commandId"`
	CommandDigest        string            `json:"commandDigest,omitempty"`
	HarnessID            string            `json:"harnessId,omitempty"`
	ProviderSessionID    string            `json:"providerSessionId,omitempty"`
	Workspace            string            `json:"workspace,omitempty"`
	Model                string            `json:"model,omitempty"`
	HostHarnessSessionID string            `json:"hostHarnessSessionId,omitempty"`
	AttachmentEpoch      *int64            `json:"attachmentEpoch,omitempty"`
	ThreadID             string            `json:"threadId,omitempty"`
	ExpectedStatus       string            `json:"expectedStatus,omitempty"`
	Cursor               string            `json:"cursor,omitempty"`
	Limit                int64             `json:"limit,omitempty"`
	RunID                string            `json:"runId,omitempty"`
	Prompt               string            `json:"prompt,omitempty"`
	ProviderTurnID       string            `json:"providerTurnId,omitempty"`
	Text                 string            `json:"text,omitempty"`
	Decision             *ApprovalDecision `json:"decision,omitempty"`
}

func (message HostSessionHubMessage) MarshalJSON() ([]byte, error) {
	value, err := hostSessionHubMessageValue(message, true)
	if err != nil {
		return nil, err
	}
	return json.Marshal(value)
}

func v6SecretString(minimum, maximum int) v5Rule {
	return func(value any) bool {
		text, ok := value.(string)
		return ok && v5String(minimum, maximum)(text) && !LooksSecretLike(text)
	}
}

var v6Identifier = v6SecretString(1, HostHarnessSessionLimits.IdentifierBytes)
var v6Diagnostic = v6SecretString(0, HostHarnessSessionLimits.DiagnosticBytes)
var v6Prompt = v6SecretString(0, HostHarnessSessionLimits.PromptBytes)
var v6SafeInteger = v5Integer(0, hostSessionMaximumSafeInteger)
var v6PositiveInteger = v5Integer(1, hostSessionMaximumSafeInteger)

func v6Workspace(value any) bool {
	text, ok := value.(string)
	return ok && canonicalHostSessionWorkspace(text)
}

func v6SortedStrings(limit int, vocabulary []string) v5Rule {
	return func(value any) bool {
		items, ok := value.([]any)
		if !ok || len(items) > limit {
			return false
		}
		previous := ""
		for index, item := range items {
			text, ok := item.(string)
			if !ok || !slices.Contains(vocabulary, text) || (index > 0 && previous >= text) {
				return false
			}
			previous = text
		}
		return true
	}
}

func v6Observation(value any) bool {
	if !v5Object(map[string]v5Rule{
		"hostHarnessSessionId": v6Identifier, "nodeId": v6Identifier, "harnessId": v5Enum(HarnessIDs),
		"providerSessionId": v6Identifier, "workspace": v6Workspace, "source": v5Enum(HostHarnessSessionSources),
		"status": v5Enum(HostHarnessSessionStatuses), "controlMode": v5Enum(HostHarnessSessionControlModes),
		"operations": v6SortedStrings(HostHarnessSessionLimits.OperationCapabilities, HostHarnessSessionOperations),
		"revision":   v6PositiveInteger, "createdAt": v5Time, "updatedAt": v5Time,
	}, map[string]v5Rule{"providerTurnId": v6Identifier, "summary": v6Diagnostic})(value) {
		return false
	}
	data, err := json.Marshal(value)
	if err != nil {
		return false
	}
	var observation HostHarnessSessionObservation
	return json.Unmarshal(data, &observation) == nil && observation.Validate() == nil
}

func v6HostSessionActor(value any) bool {
	return v5Object(map[string]v5Rule{
		"kind": v5Enum([]string{"host-session"}), "hostHarnessSessionId": v6Identifier,
	}, nil)(value)
}

func v6HostSessionRunTransportSelection(value any) bool {
	return v5Run(map[string]any{
		"id": "run", "threadId": "thread", "instanceId": "instance", "allocationId": "allocation",
		"nodeId": "node", "harnessId": "codex-cli", "model": "model", "workspace": "/workspace",
		"prompt": "", "status": "queued", "output": "", "depth": json.Number("0"),
		"createdAt": "2026-01-01T00:00:00Z", "transport": "native-cli", "transportSelection": value,
	})
}

func v6HostSessionRun(value any) bool {
	if v6ContainsSecretLike(value) || !v5Object(map[string]v5Rule{
		"id": v6Identifier, "threadId": v6Identifier, "hostHarnessSessionId": v6Identifier,
		"nodeId": v6Identifier, "harnessId": v5Enum(HarnessIDs), "model": v6Identifier,
		"workspace": v6Workspace, "prompt": v6Prompt, "status": v5Enum(RunStatuses),
		"output": v6Prompt, "depth": v6SafeInteger, "createdAt": v5Time,
	}, map[string]v5Rule{
		"error": v6Diagnostic, "parentRunId": v6Identifier, "dispatchedAt": v5Time, "startedAt": v5Time,
		"finishedAt": v5Time, "taskId": v6Identifier, "attempt": v6PositiveInteger,
		"transport": v5Enum(HarnessTransports), "fallbackTransport": v5Enum([]string{"native-cli"}),
		"transportSelection": v6HostSessionRunTransportSelection, "sessionBindingId": v6Identifier,
		"workspaceLeaseId": v6Identifier, "providerSessionId": v6Identifier, "providerTurnId": v6Identifier,
	})(value) {
		return false
	}
	return true
}

func DecodeHostHarnessSessionActor(data []byte, version string) (HostHarnessSessionActor, error) {
	var actor HostHarnessSessionActor
	if !SupportsCapability(version, CapabilityInteractiveSessions) {
		return actor, fmt.Errorf("host-session actors require protocol v6")
	}
	_, err := decodeHostSessionValue(data, v6HostSessionActor, &actor)
	return actor, err
}

func DecodeHostHarnessSessionThreadOrchestrator(data []byte, version string) (HostHarnessSessionThreadOrchestrator, error) {
	var orchestrator HostHarnessSessionThreadOrchestrator
	if !SupportsCapability(version, CapabilityInteractiveSessions) {
		return orchestrator, fmt.Errorf("host-session thread orchestrators require protocol v6")
	}
	_, err := decodeHostSessionValue(data, v6HostSessionActor, &orchestrator)
	return orchestrator, err
}

func DecodeHostHarnessSessionRun(data []byte, version string, orchestrator HostHarnessSessionThreadOrchestrator) (HostHarnessSessionRun, error) {
	var run HostHarnessSessionRun
	if !SupportsCapability(version, CapabilityInteractiveSessions) {
		return run, fmt.Errorf("host-session Runs require protocol v6")
	}
	if _, err := decodeHostSessionValue(data, v6HostSessionRun, &run); err != nil {
		return run, err
	}
	if err := run.Validate(orchestrator); err != nil {
		return run, err
	}
	return run, nil
}

func optionalHostSessionStringEqual(left, right *string) bool {
	return left == nil && right == nil || left != nil && right != nil && *left == *right
}

func optionalHostSessionIntegerEqual(left, right *int64) bool {
	return left == nil && right == nil || left != nil && right != nil && *left == *right
}

func ValidateHostHarnessSessionRunTransition(previous, next HostHarnessSessionRun, orchestrator HostHarnessSessionThreadOrchestrator) error {
	if err := previous.Validate(orchestrator); err != nil {
		return fmt.Errorf("previous host session Run is invalid: %w", err)
	}
	if err := next.Validate(orchestrator); err != nil {
		return fmt.Errorf("next host session Run is invalid: %w", err)
	}
	if previous.ID != next.ID || previous.ThreadID != next.ThreadID || previous.HostHarnessSessionID != next.HostHarnessSessionID ||
		previous.NodeID != next.NodeID || previous.HarnessID != next.HarnessID || previous.Model != next.Model ||
		previous.Workspace != next.Workspace || previous.Prompt != next.Prompt || previous.Depth != next.Depth ||
		previous.CreatedAt != next.CreatedAt || !optionalHostSessionStringEqual(previous.ParentRunID, next.ParentRunID) ||
		!optionalHostSessionStringEqual(previous.TaskID, next.TaskID) || !optionalHostSessionIntegerEqual(previous.Attempt, next.Attempt) ||
		!optionalHostSessionStringEqual(previous.Transport, next.Transport) || !optionalHostSessionStringEqual(previous.FallbackTransport, next.FallbackTransport) ||
		!optionalHostSessionStringEqual(previous.SessionBindingID, next.SessionBindingID) ||
		!optionalHostSessionStringEqual(previous.WorkspaceLeaseID, next.WorkspaceLeaseID) ||
		!optionalHostSessionStringEqual(previous.ProviderSessionID, next.ProviderSessionID) {
		return fmt.Errorf("host session Run identity or immutable input changed")
	}
	if previous.ProviderTurnID != nil && !optionalHostSessionStringEqual(previous.ProviderTurnID, next.ProviderTurnID) {
		return fmt.Errorf("host session Run provider turn changed or disappeared")
	}
	return nil
}

func v6ApprovalDecision(value any) bool {
	object, ok := value.(map[string]any)
	if !ok {
		return false
	}
	status, _ := object["status"].(string)
	optional := map[string]v5Rule{}
	if status == "approved" || status == "rejected" {
		optional = nil
	}
	required := map[string]v5Rule{"approvalId": v6Identifier, "runId": v6Identifier,
		"status": v5Enum([]string{"approved", "rejected", "cancelled", "expired"})}
	if status == "approved" || status == "rejected" {
		required["selectedOptionId"] = v6Identifier
	} else {
		optional = map[string]v5Rule{}
	}
	if !v5Object(required, optional)(value) {
		return false
	}
	data, _ := json.Marshal(value)
	var decision ApprovalDecision
	return json.Unmarshal(data, &decision) == nil && decision.Validate() == nil
}

func v6HostSessionHubRule(value any, requireDigest bool) bool {
	object, ok := value.(map[string]any)
	if !ok {
		return false
	}
	typeName, ok := object["type"].(string)
	if !ok || !slices.Contains(HostSessionHubMessageTypes, typeName) {
		return false
	}
	required := map[string]v5Rule{"type": v5Enum([]string{typeName}), "nodeId": v6Identifier, "commandId": v6Identifier}
	if requireDigest {
		required["commandDigest"] = func(value any) bool {
			text, ok := value.(string)
			return ok && hostSessionDigestPattern.MatchString(text)
		}
	}
	optional := map[string]v5Rule{}
	switch typeName {
	case "host-session.create":
		required["requestId"] = v6Identifier
		required["harnessId"] = v5Enum(HarnessIDs)
		required["workspace"] = v6Workspace
		optional["model"] = v6Identifier
	case "host-session.adopt":
		required["requestId"] = v6Identifier
		required["harnessId"] = v5Enum(HarnessIDs)
		required["providerSessionId"] = v6Identifier
		required["workspace"] = v6Workspace
	default:
		required["hostHarnessSessionId"] = v6Identifier
		required["attachmentEpoch"] = v6SafeInteger
		switch typeName {
		case "host-session.attach":
			required["threadId"] = v6Identifier
			required["expectedStatus"] = v5Enum(HostHarnessSessionStatuses)
		case "host-session.detach":
			required["threadId"] = v6Identifier
		case "host-session.history.read":
			required["requestId"] = v6Identifier
			required["limit"] = v5Integer(1, int64(HostHarnessSessionLimits.HistoryItemsPerPage))
			optional["cursor"] = v6SecretString(1, HostHarnessSessionLimits.HistoryCursorBytes)
		case "host-session.turn.start":
			required["runId"] = v6Identifier
			required["prompt"] = v6Prompt
		case "host-session.turn.steer":
			required["runId"] = v6Identifier
			required["providerTurnId"] = v6Identifier
			required["text"] = v6Prompt
		case "host-session.turn.interrupt":
			required["runId"] = v6Identifier
			required["providerTurnId"] = v6Identifier
		case "host-session.approval.decision":
			required["runId"] = v6Identifier
			required["decision"] = v6ApprovalDecision
			optional["providerTurnId"] = v6Identifier
		case "host-session.close":
		}
	}
	return v5Object(required, optional)(value)
}

func decodeHostSessionValue(data []byte, rule v5Rule, target any) (any, error) {
	if !utf8.Valid(data) || !hostSessionJSONHasValidUnicodeEscapes(data) {
		return nil, fmt.Errorf("invalid host session UTF-8")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, fmt.Errorf("invalid trailing host session JSON")
	}
	value = normalizeHostSessionJSONNumbers(value)
	if !rule(value) {
		return nil, fmt.Errorf("invalid or unknown host session fields")
	}
	normalized, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(normalized, target); err != nil {
		return nil, err
	}
	return value, nil
}

// encoding/json replaces lone UTF-16 surrogate escapes with U+FFFD. Reject them before decoding
// so Go applies the same Unicode scalar-value contract as JavaScript instead of changing identity
// fields or command-digest inputs.
func hostSessionJSONHasValidUnicodeEscapes(data []byte) bool {
	inString := false
	for index := 0; index < len(data); index++ {
		switch data[index] {
		case '"':
			inString = !inString
		case '\\':
			if !inString {
				continue
			}
			index++
			if index >= len(data) || data[index] != 'u' {
				continue
			}
			code, ok := hostSessionJSONHexQuad(data, index+1)
			if !ok {
				return false
			}
			index += 4
			if code >= 0xd800 && code <= 0xdbff {
				if index+6 >= len(data) || data[index+1] != '\\' || data[index+2] != 'u' {
					return false
				}
				low, ok := hostSessionJSONHexQuad(data, index+3)
				if !ok || low < 0xdc00 || low > 0xdfff {
					return false
				}
				index += 6
			} else if code >= 0xdc00 && code <= 0xdfff {
				return false
			}
		}
	}
	return true
}

func hostSessionJSONHexQuad(data []byte, start int) (uint64, bool) {
	if start+4 > len(data) {
		return 0, false
	}
	value, err := strconv.ParseUint(string(data[start:start+4]), 16, 16)
	return value, err == nil
}

// JavaScript parses JSON numbers as IEEE-754 values before validating safe integers. Normalize the
// equivalent Go json.Number spellings before closed-rule and struct decoding so 4, 4.0, and 4e0
// share one semantic value and command digest.
func normalizeHostSessionJSONNumbers(value any) any {
	switch typed := value.(type) {
	case json.Number:
		numeric, err := typed.Float64()
		if err == nil && math.Abs(numeric) <= float64(hostSessionMaximumSafeInteger) && numeric == math.Trunc(numeric) {
			return json.Number(strconv.FormatInt(int64(numeric), 10))
		}
		return typed
	case []any:
		for index, item := range typed {
			typed[index] = normalizeHostSessionJSONNumbers(item)
		}
		return typed
	case map[string]any:
		for key, item := range typed {
			typed[key] = normalizeHostSessionJSONNumbers(item)
		}
		return typed
	default:
		return value
	}
}

func canonicalHostSessionJSON(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	encoded := bytes.TrimSuffix(buffer.Bytes(), []byte("\n"))
	return canonicalHostSessionLineSeparators(encoded), nil
}

// encoding/json escapes U+2028 and U+2029 even with HTML escaping disabled, while JSON.stringify
// emits the runes literally. Only an odd-length backslash run ends in a JSON Unicode escape; an
// even run represents literal backslashes and must remain byte-for-byte distinct.
func canonicalHostSessionLineSeparators(encoded []byte) []byte {
	result := make([]byte, 0, len(encoded))
	for index := 0; index < len(encoded); {
		if encoded[index] != '\\' {
			result = append(result, encoded[index])
			index++
			continue
		}
		start := index
		for index < len(encoded) && encoded[index] == '\\' {
			index++
		}
		slashes := index - start
		if slashes%2 == 1 && len(encoded)-index >= 5 && encoded[index] == 'u' &&
			(encoded[index+1] == '2' && encoded[index+2] == '0' && encoded[index+3] == '2') &&
			(encoded[index+4] == '8' || encoded[index+4] == '9') {
			result = append(result, encoded[start:start+slashes-1]...)
			if encoded[index+4] == '8' {
				result = append(result, []byte("\u2028")...)
			} else {
				result = append(result, []byte("\u2029")...)
			}
			index += 5
			continue
		}
		result = append(result, encoded[start:index]...)
	}
	return result
}

func hostSessionHubMessageValue(message HostSessionHubMessage, includeDigest bool) (map[string]any, error) {
	value := map[string]any{
		"type": message.Type, "nodeId": message.NodeID, "commandId": message.CommandID,
	}
	if includeDigest {
		value["commandDigest"] = message.CommandDigest
	}
	switch message.Type {
	case "host-session.create":
		value["requestId"] = message.RequestID
		value["harnessId"] = message.HarnessID
		value["workspace"] = message.Workspace
		if message.Model != "" {
			value["model"] = message.Model
		}
	case "host-session.adopt":
		value["requestId"] = message.RequestID
		value["harnessId"] = message.HarnessID
		value["providerSessionId"] = message.ProviderSessionID
		value["workspace"] = message.Workspace
	case "host-session.attach":
		value["hostHarnessSessionId"] = message.HostHarnessSessionID
		value["attachmentEpoch"] = message.AttachmentEpoch
		value["threadId"] = message.ThreadID
		value["expectedStatus"] = message.ExpectedStatus
	case "host-session.detach":
		value["hostHarnessSessionId"] = message.HostHarnessSessionID
		value["attachmentEpoch"] = message.AttachmentEpoch
		value["threadId"] = message.ThreadID
	case "host-session.history.read":
		value["hostHarnessSessionId"] = message.HostHarnessSessionID
		value["attachmentEpoch"] = message.AttachmentEpoch
		value["requestId"] = message.RequestID
		if message.Cursor != "" {
			value["cursor"] = message.Cursor
		}
		value["limit"] = message.Limit
	case "host-session.turn.start":
		value["hostHarnessSessionId"] = message.HostHarnessSessionID
		value["attachmentEpoch"] = message.AttachmentEpoch
		value["runId"] = message.RunID
		value["prompt"] = message.Prompt
	case "host-session.turn.steer":
		value["hostHarnessSessionId"] = message.HostHarnessSessionID
		value["attachmentEpoch"] = message.AttachmentEpoch
		value["runId"] = message.RunID
		value["providerTurnId"] = message.ProviderTurnID
		value["text"] = message.Text
	case "host-session.turn.interrupt":
		value["hostHarnessSessionId"] = message.HostHarnessSessionID
		value["attachmentEpoch"] = message.AttachmentEpoch
		value["runId"] = message.RunID
		value["providerTurnId"] = message.ProviderTurnID
	case "host-session.approval.decision":
		value["hostHarnessSessionId"] = message.HostHarnessSessionID
		value["attachmentEpoch"] = message.AttachmentEpoch
		value["runId"] = message.RunID
		if message.ProviderTurnID != "" {
			value["providerTurnId"] = message.ProviderTurnID
		}
		value["decision"] = message.Decision
	case "host-session.close":
		value["hostHarnessSessionId"] = message.HostHarnessSessionID
		value["attachmentEpoch"] = message.AttachmentEpoch
	default:
		return nil, fmt.Errorf("host session command type is missing or unknown")
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var normalized map[string]any
	if err := decoder.Decode(&normalized); err != nil {
		return nil, err
	}
	return normalized, nil
}

func HostHarnessSessionCommandDigest(message HostSessionHubMessage) (string, error) {
	value, err := hostSessionHubMessageValue(message, false)
	if err != nil {
		return "", err
	}
	if !v6HostSessionHubRule(value, false) {
		return "", fmt.Errorf("host session command is malformed")
	}
	canonical, err := canonicalHostSessionJSON(value)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(canonical)
	return fmt.Sprintf("%x", digest), nil
}

func DecodeHostSessionHubMessage(data []byte, version string) (HostSessionHubMessage, error) {
	var message HostSessionHubMessage
	if !SupportsCapability(version, CapabilityInteractiveSessions) {
		return message, fmt.Errorf("host sessions require protocol v6")
	}
	if _, err := decodeHostSessionValue(data, func(value any) bool { return v6HostSessionHubRule(value, true) }, &message); err != nil {
		return message, err
	}
	digest, err := HostHarnessSessionCommandDigest(message)
	if err != nil || digest != message.CommandDigest {
		return message, fmt.Errorf("host session command digest does not match canonical payload")
	}
	if message.Type == "host-session.approval.decision" && (message.Decision == nil || message.Decision.RunID != message.RunID) {
		return message, fmt.Errorf("host session approval decision Run identity mismatch")
	}
	return message, nil
}

type HostHarnessSessionHistoryItem struct {
	ID             string `json:"id"`
	Kind           string `json:"kind"`
	Text           string `json:"text"`
	ProviderTurnID string `json:"providerTurnId,omitempty"`
	At             string `json:"at,omitempty"`
	Truncated      bool   `json:"truncated"`
}

// HostSessionControlMessage is the closed union of Barista-to-hub v6 session frames. Pointer
// fields preserve the absent-versus-zero distinction for epochs, events, and observations.
type HostSessionControlMessage struct {
	Type                 string                          `json:"type"`
	NodeID               string                          `json:"nodeId"`
	Generation           int64                           `json:"generation,omitempty"`
	PageIndex            int64                           `json:"pageIndex,omitempty"`
	Sessions             []HostHarnessSessionObservation `json:"sessions,omitempty"`
	PageCount            int64                           `json:"pageCount,omitempty"`
	SessionCount         int64                           `json:"sessionCount,omitempty"`
	Session              *HostHarnessSessionObservation  `json:"session,omitempty"`
	HostHarnessSessionID string                          `json:"hostHarnessSessionId,omitempty"`
	RequestID            string                          `json:"requestId,omitempty"`
	Items                []HostHarnessSessionHistoryItem `json:"items,omitempty"`
	NextCursor           string                          `json:"nextCursor,omitempty"`
	Truncated            bool                            `json:"truncated,omitempty"`
	AttachmentEpoch      *int64                          `json:"attachmentEpoch,omitempty"`
	ProviderTurnID       string                          `json:"providerTurnId,omitempty"`
	Event                *HarnessEvent                   `json:"event,omitempty"`
	Operation            string                          `json:"operation,omitempty"`
	CommandID            string                          `json:"commandId,omitempty"`
	CommandDigest        string                          `json:"commandDigest,omitempty"`
	Disposition          string                          `json:"disposition,omitempty"`
	Outcome              string                          `json:"outcome,omitempty"`
	Code                 string                          `json:"code,omitempty"`
	Detail               string                          `json:"detail,omitempty"`
	At                   string                          `json:"at,omitempty"`
}

func (message HostSessionControlMessage) MarshalJSON() ([]byte, error) {
	value := map[string]any{"type": message.Type, "nodeId": message.NodeID}
	switch message.Type {
	case "host-session.inventory.page":
		value["generation"] = message.Generation
		value["pageIndex"] = message.PageIndex
		if message.Sessions == nil {
			value["sessions"] = []HostHarnessSessionObservation{}
		} else {
			value["sessions"] = message.Sessions
		}
		value["at"] = message.At
	case "host-session.inventory.complete":
		value["generation"] = message.Generation
		value["pageCount"] = message.PageCount
		value["sessionCount"] = message.SessionCount
		value["at"] = message.At
	case "host-session.update":
		value["session"] = message.Session
		value["at"] = message.At
	case "host-session.history.page":
		value["hostHarnessSessionId"] = message.HostHarnessSessionID
		value["requestId"] = message.RequestID
		if message.Items == nil {
			value["items"] = []HostHarnessSessionHistoryItem{}
		} else {
			value["items"] = message.Items
		}
		if message.NextCursor != "" {
			value["nextCursor"] = message.NextCursor
		}
		value["truncated"] = message.Truncated
		value["at"] = message.At
	case "host-session.harness-event":
		value["hostHarnessSessionId"] = message.HostHarnessSessionID
		value["attachmentEpoch"] = message.AttachmentEpoch
		if message.ProviderTurnID != "" {
			value["providerTurnId"] = message.ProviderTurnID
		}
		value["event"] = message.Event
	case "host-session.command.ack":
		message.addCommandResponseIdentity(value)
		value["disposition"] = message.Disposition
		value["at"] = message.At
	case "host-session.command.result":
		message.addCommandResponseIdentity(value)
		value["outcome"] = message.Outcome
		if message.Code != "" {
			value["code"] = message.Code
		}
		if message.Detail != "" {
			value["detail"] = message.Detail
		}
		if message.ProviderTurnID != "" {
			value["providerTurnId"] = message.ProviderTurnID
		}
		if message.Session != nil {
			value["session"] = message.Session
		}
		value["at"] = message.At
	default:
		return nil, fmt.Errorf("host session control message type is missing or unknown")
	}
	return json.Marshal(value)
}

func (message HostSessionControlMessage) addCommandResponseIdentity(value map[string]any) {
	value["operation"] = message.Operation
	value["commandId"] = message.CommandID
	value["commandDigest"] = message.CommandDigest
	if message.Operation == "create" || message.Operation == "adopt" {
		value["requestId"] = message.RequestID
	} else {
		value["hostHarnessSessionId"] = message.HostHarnessSessionID
		value["attachmentEpoch"] = message.AttachmentEpoch
	}
}

func v6Array(maximum int, rule v5Rule) v5Rule {
	return func(value any) bool {
		items, ok := value.([]any)
		if !ok || len(items) > maximum {
			return false
		}
		for _, item := range items {
			if !rule(item) {
				return false
			}
		}
		return true
	}
}

func v6NonNegativeNumber(value any) bool {
	number, ok := value.(json.Number)
	if !ok {
		return false
	}
	numeric, err := number.Float64()
	return err == nil && numeric >= 0 && !math.IsInf(numeric, 0) && !math.IsNaN(numeric)
}

func v6ContainsSecretLike(value any) bool {
	switch item := value.(type) {
	case string:
		return LooksSecretLike(item)
	case []any:
		for _, child := range item {
			if v6ContainsSecretLike(child) {
				return true
			}
		}
	case map[string]any:
		for _, child := range item {
			if v6ContainsSecretLike(child) {
				return true
			}
		}
	}
	return false
}

var v6PlanEntry = v5Object(map[string]v5Rule{
	"content": v5String(0, textBytes), "status": v5Enum(PlanEntryStatuses), "priority": v5Enum(PlanEntryPriorities),
}, nil)

var v6ApprovalOption = v5Object(map[string]v5Rule{
	"id": v5String(1, identifierBytes), "label": v5String(0, diagnosticBytes), "kind": v5Enum(ApprovalOptionKinds),
}, nil)

func v6ApprovalOptions(value any) bool {
	items, ok := value.([]any)
	if !ok || len(items) == 0 || len(items) > approvalOptionLimit {
		return false
	}
	seen := make(map[string]bool, len(items))
	for _, item := range items {
		if !v6ApprovalOption(item) {
			return false
		}
		id := item.(map[string]any)["id"].(string)
		if seen[id] {
			return false
		}
		seen[id] = true
	}
	return true
}

func v6HarnessEvent(value any) bool {
	object, ok := value.(map[string]any)
	if !ok || v6ContainsSecretLike(value) {
		return false
	}
	typeName, ok := object["type"].(string)
	if !ok || !slices.Contains(HarnessEventTypes, typeName) {
		return false
	}
	required := map[string]v5Rule{
		"type": v5Enum([]string{typeName}), "runId": v5String(1, identifierBytes),
		"sequence": v6SafeInteger, "at": v5Time,
	}
	optional := map[string]v5Rule{}
	switch typeName {
	case "message.delta", "thought.delta":
		required["text"] = v5String(0, textBytes)
	case "plan.updated":
		required["entries"] = v6Array(planEntryLimit, v6PlanEntry)
	case "tool.call":
		required["toolCallId"] = v5String(1, identifierBytes)
		required["status"] = v5Enum(ToolCallStatuses)
		required["kind"] = v5Enum(ToolCallKinds)
		required["title"] = v5String(0, diagnosticBytes)
		optional["detail"] = v5String(0, textBytes)
	case "diff":
		required["path"] = v5String(0, textBytes)
		required["newText"] = v5String(0, diffBytes)
		optional["toolCallId"] = v5String(1, identifierBytes)
		optional["oldText"] = v5String(0, diffBytes)
	case "terminal.output":
		required["terminalId"] = v5String(1, identifierBytes)
		required["stream"] = v5Enum([]string{"stdout", "stderr"})
		required["text"] = v5String(0, textBytes)
	case "usage":
		optional["inputTokens"] = v6SafeInteger
		optional["outputTokens"] = v6SafeInteger
		optional["cachedInputTokens"] = v6SafeInteger
		optional["costUsd"] = v6NonNegativeNumber
	case "permission.requested":
		required["approvalId"] = v5String(1, identifierBytes)
		required["title"] = v5String(0, diagnosticBytes)
		required["options"] = v6ApprovalOptions
		optional["toolCallId"] = v5String(1, identifierBytes)
		optional["detail"] = v5String(0, textBytes)
	case "permission.resolved":
		required["approvalId"] = v5String(1, identifierBytes)
		required["status"] = v5Enum([]string{"approved", "rejected", "cancelled", "expired"})
		optional["selectedOptionId"] = v5String(1, identifierBytes)
	case "warning":
		required["code"] = v5String(1, identifierBytes)
		required["message"] = v5String(0, diagnosticBytes)
	case "unknown":
		required["sourceType"] = v5String(1, identifierBytes)
		optional["detail"] = v5String(0, diagnosticBytes)
	}
	if !v5Object(required, optional)(value) {
		return false
	}
	data, err := json.Marshal(value)
	if err != nil {
		return false
	}
	var event HarnessEvent
	return json.Unmarshal(data, &event) == nil && event.Validate() == nil
}

func v6HistoryItem(value any) bool {
	if v6ContainsSecretLike(value) || !v5Object(map[string]v5Rule{
		"id": v6Identifier, "kind": v5Enum(HostHarnessSessionHistoryKinds),
		"text": v5String(0, HostHarnessSessionLimits.HistoryItemTextBytes), "truncated": v5Boolean,
	}, map[string]v5Rule{"providerTurnId": v6Identifier, "at": v5Time})(value) {
		return false
	}
	return true
}

func v6CommandResponseIdentity(object map[string]any) bool {
	operation, ok := object["operation"].(string)
	if !ok || !slices.Contains(HostHarnessSessionCommandOperations, operation) || !v6Identifier(object["commandId"]) {
		return false
	}
	digest, ok := object["commandDigest"].(string)
	if !ok || !hostSessionDigestPattern.MatchString(digest) {
		return false
	}
	_, hasRequest := object["requestId"]
	_, hasSession := object["hostHarnessSessionId"]
	_, hasEpoch := object["attachmentEpoch"]
	if operation == "create" || operation == "adopt" {
		return hasRequest && v6Identifier(object["requestId"]) && !hasSession && !hasEpoch
	}
	return !hasRequest && hasSession && v6Identifier(object["hostHarnessSessionId"]) && hasEpoch && v6SafeInteger(object["attachmentEpoch"])
}

func v6HostSessionControlRule(value any) bool {
	object, ok := value.(map[string]any)
	if !ok || v6ContainsSecretLike(value) {
		return false
	}
	typeName, ok := object["type"].(string)
	if !ok || !slices.Contains(HostSessionControlMessageTypes, typeName) {
		return false
	}
	required := map[string]v5Rule{"type": v5Enum([]string{typeName}), "nodeId": v6Identifier}
	optional := map[string]v5Rule{}
	switch typeName {
	case "host-session.inventory.page":
		required["generation"] = v6PositiveInteger
		required["pageIndex"] = v5Integer(0, int64(HostHarnessSessionLimits.PagesPerGeneration-1))
		required["sessions"] = v6Array(HostHarnessSessionLimits.SessionsPerInventoryPage, v6Observation)
		required["at"] = v5Time
	case "host-session.inventory.complete":
		required["generation"] = v6PositiveInteger
		required["pageCount"] = v5Integer(0, int64(HostHarnessSessionLimits.PagesPerGeneration))
		required["sessionCount"] = v5Integer(0, int64(HostHarnessSessionLimits.SessionsPerGeneration))
		required["at"] = v5Time
	case "host-session.update":
		required["session"] = v6Observation
		required["at"] = v5Time
	case "host-session.history.page":
		required["hostHarnessSessionId"] = v6Identifier
		required["requestId"] = v6Identifier
		required["items"] = v6Array(HostHarnessSessionLimits.HistoryItemsPerPage, v6HistoryItem)
		required["truncated"] = v5Boolean
		required["at"] = v5Time
		optional["nextCursor"] = v6SecretString(1, HostHarnessSessionLimits.HistoryCursorBytes)
	case "host-session.harness-event":
		required["hostHarnessSessionId"] = v6Identifier
		required["attachmentEpoch"] = v6SafeInteger
		required["event"] = v6HarnessEvent
		optional["providerTurnId"] = v6Identifier
	case "host-session.command.ack":
		required["operation"] = v5Enum(HostHarnessSessionCommandOperations)
		required["commandId"] = v6Identifier
		required["commandDigest"] = func(value any) bool {
			text, ok := value.(string)
			return ok && hostSessionDigestPattern.MatchString(text)
		}
		required["disposition"] = v5Enum(HostHarnessSessionCommandDispositions)
		required["at"] = v5Time
		operation, _ := object["operation"].(string)
		if operation == "create" || operation == "adopt" {
			required["requestId"] = v6Identifier
		} else {
			required["hostHarnessSessionId"] = v6Identifier
			required["attachmentEpoch"] = v6SafeInteger
		}
	case "host-session.command.result":
		required["operation"] = v5Enum(HostHarnessSessionCommandOperations)
		required["commandId"] = v6Identifier
		required["commandDigest"] = func(value any) bool {
			text, ok := value.(string)
			return ok && hostSessionDigestPattern.MatchString(text)
		}
		required["outcome"] = v5Enum(HostHarnessSessionCommandOutcomes)
		required["at"] = v5Time
		operation, _ := object["operation"].(string)
		if operation == "create" || operation == "adopt" {
			required["requestId"] = v6Identifier
		} else {
			required["hostHarnessSessionId"] = v6Identifier
			required["attachmentEpoch"] = v6SafeInteger
		}
		optional["code"] = func(value any) bool {
			text, ok := value.(string)
			return ok && v6Identifier(text) && hostSessionCodePattern.MatchString(text)
		}
		optional["detail"] = v6Diagnostic
		optional["providerTurnId"] = v6Identifier
		optional["session"] = v6Observation
	}
	if !v5Object(required, optional)(value) {
		return false
	}
	if typeName == "host-session.command.ack" || typeName == "host-session.command.result" {
		return v6CommandResponseIdentity(object)
	}
	return true
}

func validateHostSessionControlSemantics(message HostSessionControlMessage) error {
	switch message.Type {
	case "host-session.inventory.page":
		ids := make(map[string]bool, len(message.Sessions))
		providers := make(map[string]bool, len(message.Sessions))
		for _, session := range message.Sessions {
			if session.NodeID != message.NodeID || ids[session.HostHarnessSessionID] {
				return fmt.Errorf("host session inventory page contains an invalid or duplicate session")
			}
			provider := hostSessionProviderIdentity(session)
			if providers[provider] {
				return fmt.Errorf("host session inventory page contains a duplicate provider identity")
			}
			ids[session.HostHarnessSessionID] = true
			providers[provider] = true
		}
	case "host-session.update":
		if message.Session == nil || message.Session.NodeID != message.NodeID {
			return fmt.Errorf("host session update identity is malformed or mismatched")
		}
	case "host-session.history.page":
		ids := make(map[string]bool, len(message.Items))
		for _, item := range message.Items {
			if ids[item.ID] {
				return fmt.Errorf("host session history page contains a duplicate item")
			}
			ids[item.ID] = true
		}
	case "host-session.command.result":
		if message.Session != nil && (message.Session.NodeID != message.NodeID ||
			(message.HostHarnessSessionID != "" && message.Session.HostHarnessSessionID != message.HostHarnessSessionID)) {
			return fmt.Errorf("host session command result observation is malformed or mismatched")
		}
		createsIdentity := message.Operation == "create" || message.Operation == "adopt"
		if createsIdentity && ((message.Outcome == "succeeded") != (message.Session != nil)) {
			return fmt.Errorf("host session create/adopt result fabricates or omits identity")
		}
		if message.Operation == "start-turn" {
			if (message.Outcome == "succeeded") != (message.ProviderTurnID != "") {
				return fmt.Errorf("host session command result provider turn does not match operation/outcome")
			}
		} else if message.ProviderTurnID != "" {
			return fmt.Errorf("host session command result provider turn does not match operation/outcome")
		}
		if message.Operation == "close" && message.Session != nil && message.Session.Status == "closed" && message.Outcome != "succeeded" {
			return fmt.Errorf("host session close outcome and observation conflict")
		}
		if message.Operation == "close" && (message.Outcome == "succeeded") && (message.Session == nil || message.Session.Status != "closed") {
			return fmt.Errorf("host session close outcome and observation conflict")
		}
	}
	return nil
}

func DecodeHostSessionControlMessage(data []byte, version string) (HostSessionControlMessage, error) {
	var message HostSessionControlMessage
	if !SupportsCapability(version, CapabilityInteractiveSessions) {
		return message, fmt.Errorf("host sessions require protocol v6")
	}
	if _, err := decodeHostSessionValue(data, v6HostSessionControlRule, &message); err != nil {
		return message, err
	}
	if err := validateHostSessionControlSemantics(message); err != nil {
		return message, err
	}
	return message, nil
}

func hostSessionProviderIdentity(session HostHarnessSessionObservation) string {
	return strings.Join([]string{session.NodeID, session.HarnessID, session.Workspace, session.ProviderSessionID}, "\x00")
}

func hostSessionCanonicalEqual(left, right any) bool {
	leftJSON, leftErr := canonicalHostSessionJSON(left)
	rightJSON, rightErr := canonicalHostSessionJSON(right)
	return leftErr == nil && rightErr == nil && bytes.Equal(leftJSON, rightJSON)
}

func validateHostSessionControlMessageValue(message HostSessionControlMessage) error {
	data, err := json.Marshal(message)
	if err != nil {
		return err
	}
	_, err = DecodeHostSessionControlMessage(data, "6")
	return err
}

func ValidateHostHarnessSessionObservationTransition(previous, next HostHarnessSessionObservation) error {
	if err := previous.Validate(); err != nil {
		return fmt.Errorf("previous observation is invalid: %w", err)
	}
	if err := next.Validate(); err != nil {
		return fmt.Errorf("next observation is invalid: %w", err)
	}
	if previous.HostHarnessSessionID != next.HostHarnessSessionID || previous.NodeID != next.NodeID ||
		previous.HarnessID != next.HarnessID || previous.ProviderSessionID != next.ProviderSessionID ||
		previous.Workspace != next.Workspace || previous.Source != next.Source || previous.CreatedAt != next.CreatedAt {
		return fmt.Errorf("host session identity changed")
	}
	if next.Revision < previous.Revision {
		return fmt.Errorf("host session revision regressed")
	}
	if next.Revision == previous.Revision {
		if !hostSessionCanonicalEqual(previous, next) {
			return fmt.Errorf("host session revision replay changed payload")
		}
		return nil
	}
	if !CanTransitionHostHarnessSession(previous.Status, next.Status) {
		return fmt.Errorf("host session status transition is not legal")
	}
	previousTime, _ := time.Parse(time.RFC3339Nano, previous.UpdatedAt)
	nextTime, _ := time.Parse(time.RFC3339Nano, next.UpdatedAt)
	if nextTime.Before(previousTime) {
		return fmt.Errorf("host session timestamp regressed")
	}
	return nil
}

type HostHarnessSessionInventoryGeneration struct {
	NodeID     string                          `json:"nodeId"`
	Generation int64                           `json:"generation"`
	Pages      []HostSessionControlMessage     `json:"pages"`
	Complete   HostSessionControlMessage       `json:"complete"`
	Sessions   []HostHarnessSessionObservation `json:"sessions"`
}

func ValidateHostHarnessSessionInventoryGeneration(pages []HostSessionControlMessage, complete HostSessionControlMessage) (HostHarnessSessionInventoryGeneration, error) {
	empty := HostHarnessSessionInventoryGeneration{}
	if complete.Type != "host-session.inventory.complete" || validateHostSessionControlMessageValue(complete) != nil {
		return empty, fmt.Errorf("host session inventory has no valid completion")
	}
	byIndex := make(map[int64]HostSessionControlMessage, len(pages))
	for _, page := range pages {
		if page.Type != "host-session.inventory.page" || validateHostSessionControlMessageValue(page) != nil {
			return empty, fmt.Errorf("host session inventory contains an invalid page")
		}
		if page.NodeID != complete.NodeID || page.Generation != complete.Generation {
			return empty, fmt.Errorf("host session inventory mixes node or generation identity")
		}
		if prior, found := byIndex[page.PageIndex]; found {
			if !hostSessionCanonicalEqual(prior, page) {
				return empty, fmt.Errorf("host session inventory page replay changed payload")
			}
			continue
		}
		byIndex[page.PageIndex] = page
	}
	if int64(len(byIndex)) != complete.PageCount {
		return empty, fmt.Errorf("host session inventory page count does not match completion")
	}
	ordered := make([]HostSessionControlMessage, 0, complete.PageCount)
	sessions := make([]HostHarnessSessionObservation, 0, complete.SessionCount)
	ids := make(map[string]bool)
	providers := make(map[string]bool)
	for index := int64(0); index < complete.PageCount; index++ {
		page, found := byIndex[index]
		if !found {
			return empty, fmt.Errorf("host session inventory pages are not contiguous")
		}
		ordered = append(ordered, page)
		for _, session := range page.Sessions {
			provider := hostSessionProviderIdentity(session)
			if ids[session.HostHarnessSessionID] || providers[provider] {
				return empty, fmt.Errorf("host session inventory generation contains ambiguous identity")
			}
			ids[session.HostHarnessSessionID] = true
			providers[provider] = true
			sessions = append(sessions, session)
		}
	}
	if int64(len(sessions)) != complete.SessionCount || len(sessions) > HostHarnessSessionLimits.SessionsPerGeneration {
		return empty, fmt.Errorf("host session inventory session count does not match completion")
	}
	return HostHarnessSessionInventoryGeneration{
		NodeID: complete.NodeID, Generation: complete.Generation, Pages: ordered, Complete: complete, Sessions: sessions,
	}, nil
}

func validateHostHarnessSessionInventoryGenerationValue(value HostHarnessSessionInventoryGeneration) error {
	assembled, err := ValidateHostHarnessSessionInventoryGeneration(value.Pages, value.Complete)
	if err != nil || value.NodeID != assembled.NodeID || value.Generation != assembled.Generation || !hostSessionCanonicalEqual(value.Sessions, assembled.Sessions) {
		return fmt.Errorf("host session inventory generation projection is inconsistent")
	}
	return nil
}

func ValidateHostHarnessSessionInventoryTransition(previous, next HostHarnessSessionInventoryGeneration) error {
	if err := validateHostHarnessSessionInventoryGenerationValue(previous); err != nil {
		return fmt.Errorf("previous inventory is invalid: %w", err)
	}
	if err := validateHostHarnessSessionInventoryGenerationValue(next); err != nil {
		return fmt.Errorf("next inventory is invalid: %w", err)
	}
	if next.NodeID != previous.NodeID {
		return fmt.Errorf("host session inventory node changed")
	}
	if next.Generation < previous.Generation {
		return fmt.Errorf("host session inventory generation regressed")
	}
	if next.Generation == previous.Generation {
		if !hostSessionCanonicalEqual(previous, next) {
			return fmt.Errorf("host session inventory generation replay changed payload")
		}
		return nil
	}
	if next.Generation != previous.Generation+1 {
		return fmt.Errorf("host session inventory generation has a gap")
	}
	oldByID := make(map[string]HostHarnessSessionObservation, len(previous.Sessions))
	oldByProvider := make(map[string]string, len(previous.Sessions))
	for _, session := range previous.Sessions {
		oldByID[session.HostHarnessSessionID] = session
		oldByProvider[hostSessionProviderIdentity(session)] = session.HostHarnessSessionID
	}
	for _, session := range next.Sessions {
		if old, found := oldByID[session.HostHarnessSessionID]; found {
			if err := ValidateHostHarnessSessionObservationTransition(old, session); err != nil {
				return fmt.Errorf("host session inventory contains an invalid observation transition")
			}
		}
		if priorID, found := oldByProvider[hostSessionProviderIdentity(session)]; found && priorID != session.HostHarnessSessionID {
			return fmt.Errorf("provider identity maps to a different host session")
		}
	}
	return nil
}

const (
	HostHarnessSessionCommandReplayNew      = "new"
	HostHarnessSessionCommandReplayReplay   = "replay"
	HostHarnessSessionCommandReplayConflict = "conflict"
)

func validHostSessionHubMessage(message HostSessionHubMessage) bool {
	value, err := hostSessionHubMessageValue(message, true)
	if err != nil {
		return false
	}
	data, err := canonicalHostSessionJSON(value)
	if err != nil {
		return false
	}
	_, err = DecodeHostSessionHubMessage(data, "6")
	return err == nil
}

func ClassifyHostHarnessSessionCommandReplay(recorded *HostSessionHubMessage, incoming HostSessionHubMessage) string {
	if !validHostSessionHubMessage(incoming) {
		return HostHarnessSessionCommandReplayConflict
	}
	if recorded == nil {
		return HostHarnessSessionCommandReplayNew
	}
	if !validHostSessionHubMessage(*recorded) {
		return HostHarnessSessionCommandReplayConflict
	}
	if recorded.CommandID != incoming.CommandID {
		return HostHarnessSessionCommandReplayConflict
	}
	if recorded.CommandDigest == incoming.CommandDigest && hostSessionCanonicalEqual(*recorded, incoming) {
		return HostHarnessSessionCommandReplayReplay
	}
	return HostHarnessSessionCommandReplayConflict
}

var hostSessionCommandTypeOperation = map[string]string{
	"host-session.create":            "create",
	"host-session.adopt":             "adopt",
	"host-session.attach":            "attach",
	"host-session.detach":            "detach",
	"host-session.history.read":      "read-history",
	"host-session.turn.start":        "start-turn",
	"host-session.turn.steer":        "steer",
	"host-session.turn.interrupt":    "interrupt",
	"host-session.approval.decision": "resolve-approval",
	"host-session.close":             "close",
}

func ValidateHostHarnessSessionCommandResponse(command HostSessionHubMessage, response HostSessionControlMessage) error {
	if !validHostSessionHubMessage(command) {
		return fmt.Errorf("host session command is invalid")
	}
	if err := validateHostSessionControlMessageValue(response); err != nil {
		return fmt.Errorf("host session response is invalid: %w", err)
	}
	if command.Type == "host-session.history.read" {
		if response.Type != "host-session.history.page" || response.NodeID != command.NodeID ||
			response.HostHarnessSessionID != command.HostHarnessSessionID || response.RequestID != command.RequestID {
			return fmt.Errorf("host session history response correlation mismatch")
		}
		return nil
	}
	if response.Type != "host-session.command.ack" && response.Type != "host-session.command.result" {
		return fmt.Errorf("host session command requires an acknowledgement or result")
	}
	expectedOperation := hostSessionCommandTypeOperation[command.Type]
	if expectedOperation == "" || expectedOperation == "read-history" || response.NodeID != command.NodeID ||
		response.Operation != expectedOperation || response.CommandID != command.CommandID || response.CommandDigest != command.CommandDigest {
		return fmt.Errorf("host session command response correlation mismatch")
	}
	if command.Type == "host-session.create" || command.Type == "host-session.adopt" {
		if response.RequestID != command.RequestID {
			return fmt.Errorf("host session request correlation mismatch")
		}
		if response.Type == "host-session.command.result" && response.Session != nil {
			session := response.Session
			if session.NodeID != command.NodeID || session.HarnessID != command.HarnessID || session.Workspace != command.Workspace ||
				(command.Type == "host-session.adopt" && session.ProviderSessionID != command.ProviderSessionID) ||
				(command.Type == "host-session.create" && session.Source != "coffee-shop-managed") {
				return fmt.Errorf("host session create/adopt result identity mismatch")
			}
		}
	} else if response.HostHarnessSessionID != command.HostHarnessSessionID || response.AttachmentEpoch == nil ||
		command.AttachmentEpoch == nil || *response.AttachmentEpoch != *command.AttachmentEpoch {
		return fmt.Errorf("host session/epoch response correlation mismatch")
	}
	return nil
}

func ValidateHostHarnessSessionEventCorrelation(message HostSessionControlMessage, session HostHarnessSession, run HostHarnessSessionRun) error {
	if err := validateHostSessionControlMessageValue(message); err != nil || message.Type != "host-session.harness-event" {
		return fmt.Errorf("host session event is invalid")
	}
	if err := session.Validate(); err != nil {
		return fmt.Errorf("host session projection is invalid: %w", err)
	}
	orchestrator := HostHarnessSessionThreadOrchestrator{Kind: "host-session", HostHarnessSessionID: session.HostHarnessSessionID}
	if err := run.Validate(orchestrator); err != nil {
		return fmt.Errorf("host session Run is invalid: %w", err)
	}
	if message.Event == nil || run.ProviderTurnID == nil || run.Status != "running" ||
		(session.Status != "running" && session.Status != "awaiting-approval") ||
		message.NodeID != session.NodeID || message.HostHarnessSessionID != session.HostHarnessSessionID ||
		message.AttachmentEpoch == nil || *message.AttachmentEpoch != session.AttachmentEpoch ||
		session.AttachedThreadID != run.ThreadID || session.ActiveRunID != run.ID || message.Event.RunID != run.ID ||
		run.NodeID != session.NodeID || run.HarnessID != session.HarnessID || run.Workspace != session.Workspace ||
		message.ProviderTurnID != *run.ProviderTurnID || session.ProviderTurnID != *run.ProviderTurnID {
		return fmt.Errorf("host session event identity, writer, Run, or provider turn mismatch")
	}
	return nil
}
