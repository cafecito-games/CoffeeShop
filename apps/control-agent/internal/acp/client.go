package acp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

var (
	// ErrUnsupportedVersion reports that the adapter selected a protocol version other than v1.
	ErrUnsupportedVersion = errors.New("acp adapter selected an unsupported protocol version")
	// ErrMissingCapability reports that the adapter lacks a capability this run requires.
	ErrMissingCapability = errors.New("acp adapter lacks a required capability")
	// ErrAuthenticationRequired reports that the adapter refused to create a session until it is
	// authenticated. Barista never authenticates on the operator's behalf.
	ErrAuthenticationRequired = errors.New("acp adapter requires authentication on this compute node")
	// ErrCancelled reports that the run context was cancelled and the adapter acknowledged it.
	ErrCancelled = errors.New("acp prompt turn was cancelled")
	// ErrCancelGraceExpired reports that the adapter did not finish within the cancellation grace
	// period; the caller must terminate its process tree.
	ErrCancelGraceExpired = errors.New("acp adapter did not acknowledge cancellation within its grace period")
	// ErrIncompleteTurn reports a prompt turn that stopped for a reason other than end_turn.
	ErrIncompleteTurn = errors.New("acp prompt turn did not complete")
	// ErrAdapterVersionMismatch reports that the adapter identified itself with a version other
	// than the one Barista verified and pinned for it.
	ErrAdapterVersionMismatch = errors.New("acp adapter reported a version other than its pinned version")
)

var stopReasons = map[string]bool{"end_turn": true, "max_tokens": true, "max_turn_requests": true, "refusal": true, "cancelled": true}

// PermissionRequest is a sanitized, bounded view of session/request_permission.
type PermissionRequest struct {
	RunID      string
	SessionID  string
	ApprovalID string
	ToolCallID string
	Title      string
	Kind       string
	Options    []protocol.ApprovalOption
}

// PermissionDecision selects exactly one offered option. An empty OptionID cancels the request.
type PermissionDecision struct {
	OptionID string
}

// PermissionHandler resolves a permission request. It must honor ctx; a handler that errors, times
// out, or selects an option that was not offered never results in an allow.
type PermissionHandler func(ctx context.Context, request PermissionRequest) (PermissionDecision, error)

// MCPServer is the run-scoped Coffee Shop MCP endpoint offered to the adapter.
type MCPServer struct {
	Name        string
	URL         string
	BearerToken string
}

// Options configures one supervised ACP session.
type Options struct {
	RunID         string
	ClientName    string
	ClientVersion string
	// Secrets are redacted from every event, result, and error this client produces.
	Secrets    []string
	Events     func(protocol.HarnessEvent)
	Permission PermissionHandler

	// ExpectedAgentVersion, when set, must equal the version the adapter reports in initialize.
	ExpectedAgentVersion string

	RequestTimeout    time.Duration
	PermissionTimeout time.Duration
	CancelGracePeriod time.Duration
	Now               func() time.Time
}

// SessionRequest describes the single prompt turn of a run.
type SessionRequest struct {
	Cwd       string
	Prompt    string
	MCPServer *MCPServer
	// Configuration is applied and confirmed after session/new and before the prompt.
	Configuration []ConfigSelection
	// BeforePrompt runs after the session is configured. An error ends the run before any prompt
	// reaches the adapter.
	BeforePrompt func(ctx context.Context) error
}

// Result is the terminal outcome of a successful prompt turn.
type Result struct {
	SessionID  string
	StopReason string
	Text       string
	AgentName  string
}

// Client drives one ACP session over an adapter's stdio. It is single-use.
type Client struct {
	peer          *connection
	options       Options
	redaction     redactor
	normalization *normalizer

	emitMu   sync.Mutex
	sequence int64

	stateMu    sync.Mutex
	sessionID  string
	negotiated *protocol.AcpAgentCapabilities
	// closeSupported records whether initialize advertised session/close.
	closeSupported bool
	completed      bool
	lateReported   bool
	cancelling     chan struct{}
	cancelOnce     sync.Once
	approvalCount  atomic.Int64
	promptSent     atomic.Bool
}

// NewClient prepares a client reading adapter stdout and writing adapter stdin.
func NewClient(stdout io.Reader, stdin io.WriteCloser, options Options) *Client {
	if options.RequestTimeout <= 0 {
		options.RequestTimeout = DefaultRequestTimeout
	}
	if options.PermissionTimeout <= 0 {
		options.PermissionTimeout = DefaultPermissionTimeout
	}
	if options.CancelGracePeriod <= 0 {
		options.CancelGracePeriod = DefaultCancelGracePeriod
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.ClientName == "" {
		options.ClientName = "coffee-shop-barista"
	}
	if options.ClientVersion == "" {
		options.ClientVersion = "dev"
	}
	client := &Client{
		options:       options,
		redaction:     newRedactor(options.Secrets),
		normalization: newNormalizer(),
		cancelling:    make(chan struct{}),
	}
	client.peer = newConnection(stdout, stdin, client)
	return client
}

// Run negotiates the connection, creates a session, and completes one prompt turn. Cancelling ctx
// sends session/cancel and waits at most CancelGracePeriod for the turn to end.
func (client *Client) Run(ctx context.Context, request SessionRequest) (Result, error) {
	client.peer.start()
	result, err := client.run(ctx, request)
	client.markCompleted()
	if err != nil {
		return Result{}, client.redactError(err)
	}
	result.Text = client.redaction.apply(result.Text)
	return result, nil
}

// Probe negotiates the connection and returns the adapter's capabilities without creating a
// session. Afterwards the client can only answer ProbeOption, never run a prompt.
func (client *Client) Probe(ctx context.Context) (protocol.AcpAgentCapabilities, error) {
	client.peer.start()
	client.markCompleted()
	if _, err := client.initialize(ctx); err != nil {
		return protocol.AcpAgentCapabilities{}, client.redactError(err)
	}
	capabilities, _ := client.Negotiated()
	return capabilities, nil
}

// ProbeOption, after a successful Probe, creates a throwaway session in cwd without MCP servers
// or a prompt, reads the values the adapter offers for the session configuration option optionID,
// and closes the session when the adapter supports that. The values are untrusted adapter output
// in offered order. Failing to read them, for example because the adapter requires authentication
// before creating a session, is not an error: the option is then reported as offering nothing.
func (client *Client) ProbeOption(ctx context.Context, cwd, optionID string) []string {
	client.stateMu.Lock()
	negotiated := client.negotiated != nil
	client.stateMu.Unlock()
	if !negotiated || optionID == "" || !filepath.IsAbs(cwd) {
		return nil
	}
	requestContext, cancel := context.WithTimeout(ctx, client.options.RequestTimeout)
	defer cancel()
	var response newSessionResponse
	if client.peer.call(requestContext, methodSessionNew, newSessionRequest{Cwd: cwd, McpServers: []mcpServerHTTP{}}, &response) != nil || response.SessionID == "" {
		return nil
	}
	values := []string{}
	for _, option := range response.ConfigOptions {
		if option.ID == optionID {
			values = orderedOfferedValues(option.Options)
			break
		}
	}
	if client.closeSupported {
		_ = client.peer.call(requestContext, methodSessionClose, sessionReference{SessionID: response.SessionID}, nil)
	}
	return values
}

// Negotiated returns the capabilities the adapter reported in initialize, once it has answered.
func (client *Client) Negotiated() (protocol.AcpAgentCapabilities, bool) {
	client.stateMu.Lock()
	defer client.stateMu.Unlock()
	if client.negotiated == nil {
		return protocol.AcpAgentCapabilities{}, false
	}
	return *client.negotiated, true
}

// PromptSent reports whether session/prompt was handed to the adapter. From that point on the
// adapter may have acted on the run, so the attempt can only succeed or fail, never be replayed.
func (client *Client) PromptSent() bool {
	return client.promptSent.Load()
}

// Close flushes queued frames and closes adapter stdin.
func (client *Client) Close() {
	client.peer.closeInput()
}

// Wait blocks until adapter stdout is exhausted and every inbound request handler has returned.
// The caller must ensure the adapter exits, terminating it if necessary.
func (client *Client) Wait() {
	client.peer.wait()
}

func (client *Client) run(ctx context.Context, request SessionRequest) (Result, error) {
	if !filepath.IsAbs(request.Cwd) {
		return Result{}, fmt.Errorf("acp session cwd must be absolute")
	}
	initialized, err := client.initialize(ctx)
	if err != nil {
		return Result{}, err
	}
	servers := []mcpServerHTTP{}
	if request.MCPServer != nil {
		if !initialized.AgentCapabilities.McpCapabilities.HTTP {
			return Result{}, fmt.Errorf("%w: HTTP MCP servers are required for the Coffee Shop MCP server", ErrMissingCapability)
		}
		servers = append(servers, mcpServerHTTP{
			Type: "http", Name: request.MCPServer.Name, URL: request.MCPServer.URL,
			Headers: []httpHeader{{Name: "Authorization", Value: "Bearer " + request.MCPServer.BearerToken}},
		})
	}
	sessionID, configuration, err := client.newSession(ctx, request.Cwd, servers, initialized.AuthMethods)
	if err != nil {
		return Result{}, err
	}
	if err := client.configure(ctx, sessionID, configuration, request.Configuration); err != nil {
		return Result{}, err
	}
	if request.BeforePrompt != nil {
		if err := request.BeforePrompt(ctx); err != nil {
			return Result{}, err
		}
	}
	if ctx.Err() != nil {
		return Result{}, fmt.Errorf("%w before %s was sent", ErrCancelled, methodSessionPrompt)
	}
	response, err := client.prompt(ctx, sessionID, request.Prompt)
	if err != nil {
		return Result{}, err
	}
	client.stateMu.Lock()
	text := client.normalization.finalText()
	client.stateMu.Unlock()
	if initialized.AgentCapabilities.SessionCapabilities.Close != nil && !isNull(initialized.AgentCapabilities.SessionCapabilities.Close) {
		closeContext, cancel := context.WithTimeout(context.Background(), client.options.RequestTimeout)
		if err := client.peer.call(closeContext, methodSessionClose, sessionReference{SessionID: sessionID}, nil); err != nil {
			client.emit(warningEvent(WarningSessionCloseFailed, "session/close failed: "+err.Error()))
		}
		cancel()
	}
	agentName := ""
	if initialized.AgentInfo != nil {
		agentName = truncateBytes(initialized.AgentInfo.Name, eventIdentifierBytes)
	}
	return Result{SessionID: sessionID, StopReason: response.StopReason, Text: text, AgentName: agentName}, nil
}

func (client *Client) initialize(ctx context.Context) (initializeResponse, error) {
	requestContext, cancel := context.WithTimeout(ctx, client.options.RequestTimeout)
	defer cancel()
	request := initializeRequest{
		ProtocolVersion: ProtocolVersion,
		ClientInfo:      implementation{Name: client.options.ClientName, Version: client.options.ClientVersion},
	}
	var response initializeResponse
	if err := client.peer.call(requestContext, methodInitialize, request, &response); err != nil {
		return response, client.setupError(ctx, methodInitialize, err)
	}
	if response.ProtocolVersion == nil {
		return response, fmt.Errorf("%w: initialize response has no protocolVersion", ErrProtocolViolation)
	}
	if *response.ProtocolVersion != ProtocolVersion {
		return response, fmt.Errorf("%w: adapter selected %d, Barista supports %d", ErrUnsupportedVersion, *response.ProtocolVersion, ProtocolVersion)
	}
	if expected := client.options.ExpectedAgentVersion; expected != "" && (response.AgentInfo == nil || response.AgentInfo.Version != expected) {
		return response, fmt.Errorf("%w %s", ErrAdapterVersionMismatch, expected)
	}
	negotiated := negotiatedCapabilities(response)
	closeCapability := response.AgentCapabilities.SessionCapabilities.Close
	client.stateMu.Lock()
	client.negotiated = &negotiated
	client.closeSupported = closeCapability != nil && !isNull(closeCapability)
	client.stateMu.Unlock()
	return response, nil
}

// negotiatedCapabilities projects an initialize response onto the Coffee Shop capability summary.
// The adapter name and version are untrusted adapter output: a name is bounded and dropped when it
// looks secret-like, and a version is kept only in normalized form.
func negotiatedCapabilities(response initializeResponse) protocol.AcpAgentCapabilities {
	capabilities := response.AgentCapabilities
	resume := capabilities.SessionCapabilities.Resume
	negotiated := protocol.AcpAgentCapabilities{
		ProtocolVersion: ProtocolVersion,
		LoadSession:     capabilities.LoadSession,
		ResumeSession:   resume != nil && !isNull(resume),
		Prompt: protocol.AcpPromptCapabilities{
			Image: capabilities.PromptCapabilities.Image, Audio: capabilities.PromptCapabilities.Audio, EmbeddedContext: capabilities.PromptCapabilities.EmbeddedContext,
		},
		Mcp: protocol.AcpMcpCapabilities{HTTP: capabilities.McpCapabilities.HTTP, SSE: capabilities.McpCapabilities.SSE},
	}
	if response.AgentInfo != nil {
		if name := truncateBytes(response.AgentInfo.Name, protocol.ACPAdapterNameMaximumBytes); !protocol.LooksSecretLike(name) {
			negotiated.AdapterName = name
		}
		if protocol.IsNormalizedVersion(response.AgentInfo.Version) {
			negotiated.AdapterVersion = response.AgentInfo.Version
		}
	}
	return negotiated
}

func (client *Client) newSession(ctx context.Context, cwd string, servers []mcpServerHTTP, methods []authMethod) (string, configState, error) {
	requestContext, cancel := context.WithTimeout(ctx, client.options.RequestTimeout)
	defer cancel()
	var response newSessionResponse
	err := client.peer.call(requestContext, methodSessionNew, newSessionRequest{Cwd: cwd, McpServers: servers}, &response)
	var responseError *ResponseError
	if errors.As(err, &responseError) && responseError.Code == CodeAuthenticationRequired {
		names := make([]string, 0, len(methods))
		for _, method := range methods {
			names = append(names, truncateBytes(method.ID, eventIdentifierBytes))
		}
		return "", nil, fmt.Errorf("%w (advertised methods: %s)", ErrAuthenticationRequired, truncateBytes(strings.Join(names, ", "), MaximumDiagnosticBytes))
	}
	if err != nil {
		return "", nil, client.setupError(ctx, methodSessionNew, err)
	}
	if response.SessionID == "" || len(response.SessionID) > eventIdentifierBytes {
		return "", nil, fmt.Errorf("%w: session/new returned an invalid sessionId", ErrProtocolViolation)
	}
	client.stateMu.Lock()
	client.sessionID = response.SessionID
	client.stateMu.Unlock()
	return response.SessionID, newConfigState(response.ConfigOptions), nil
}

func (client *Client) setupError(ctx context.Context, method string, err error) error {
	if ctx.Err() != nil {
		return fmt.Errorf("%w before %s completed", ErrCancelled, method)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("%w: %s did not respond within %s", ErrProtocolViolation, method, client.options.RequestTimeout)
	}
	return fmt.Errorf("%s failed: %w", method, err)
}

type promptOutcome struct {
	response promptResponse
	err      error
}

func (client *Client) prompt(ctx context.Context, sessionID string, text string) (promptResponse, error) {
	outcome := make(chan promptOutcome, 1)
	client.promptSent.Store(true)
	go func() {
		var response promptResponse
		request := promptRequest{SessionID: sessionID, Prompt: []contentBlock{{Type: "text", Text: text}}}
		err := client.peer.callSettled(context.Background(), methodSessionPrompt, request, &response, client.markCompleted)
		outcome <- promptOutcome{response: response, err: err}
	}()

	var grace <-chan time.Time
	var finished promptOutcome
	select {
	case finished = <-outcome:
	case <-ctx.Done():
		client.requestCancellation(sessionID)
		timer := time.NewTimer(client.options.CancelGracePeriod)
		defer timer.Stop()
		grace = timer.C
		select {
		case finished = <-outcome:
		case <-grace:
			return promptResponse{}, ErrCancelGraceExpired
		}
	}
	if finished.err != nil {
		if ctx.Err() != nil {
			return promptResponse{}, fmt.Errorf("%w: %w", ErrCancelled, finished.err)
		}
		return promptResponse{}, fmt.Errorf("session/prompt failed: %w", finished.err)
	}
	response := finished.response
	if !stopReasons[response.StopReason] {
		failure := fmt.Errorf("%w: unknown stopReason %q", ErrProtocolViolation, truncateBytes(response.StopReason, eventIdentifierBytes))
		client.peer.fail(failure)
		return promptResponse{}, failure
	}
	client.emit(promptUsageEvent(response.Usage)...)
	if ctx.Err() != nil {
		return promptResponse{}, ErrCancelled
	}
	if response.StopReason != "end_turn" {
		return promptResponse{}, fmt.Errorf("%w: stopReason %s", ErrIncompleteTurn, response.StopReason)
	}
	return response, nil
}

// markCompleted ends the prompt turn: later session updates are ignored and permission requests
// are cancelled.
func (client *Client) markCompleted() {
	client.stateMu.Lock()
	client.completed = true
	client.stateMu.Unlock()
}

// requestCancellation sends session/cancel once and cancels outstanding permission requests, as ACP
// requires the client to answer them with the cancelled outcome.
func (client *Client) requestCancellation(sessionID string) {
	client.cancelOnce.Do(func() {
		close(client.cancelling)
		notifyContext, cancel := context.WithTimeout(context.Background(), client.options.CancelGracePeriod)
		defer cancel()
		_ = client.peer.notify(notifyContext, methodSessionCancel, sessionReference{SessionID: sessionID})
	})
}

func (client *Client) handleNotification(method string, params json.RawMessage) error {
	if method == methodSessionUpdate {
		return client.sessionUpdate(params)
	}
	if strings.HasPrefix(method, "_") {
		return nil
	}
	client.emit(unknownEvent(method, "unsupported ACP notification"))
	return nil
}

func (client *Client) sessionUpdate(params json.RawMessage) error {
	var notification sessionNotification
	if err := decodeStrict(params, &notification); err != nil || notification.SessionID == "" || notification.Update == nil {
		return fmt.Errorf("%w: session/update is missing sessionId or update", ErrMalformedUpdate)
	}
	client.stateMu.Lock()
	sessionID, completed := client.sessionID, client.completed
	if sessionID == "" {
		client.stateMu.Unlock()
		return nil
	}
	if notification.SessionID != sessionID {
		client.stateMu.Unlock()
		return fmt.Errorf("session/update names session %q, not the active session", truncateBytes(notification.SessionID, eventIdentifierBytes))
	}
	if completed {
		reportLate := !client.lateReported
		client.lateReported = true
		client.stateMu.Unlock()
		if reportLate {
			client.emit(warningEvent(WarningUpdateAfterComplete, "adapter sent session updates after the prompt turn ended; they were ignored"))
		}
		return nil
	}
	events, err := client.normalization.sessionUpdate(notification.Update)
	client.stateMu.Unlock()
	if err != nil {
		return err
	}
	client.emit(events...)
	return nil
}

func (client *Client) handleRequest(ctx context.Context, method string, params json.RawMessage) (any, *ResponseError) {
	if method == methodRequestPermission {
		return client.requestPermission(ctx, params), nil
	}
	return nil, &ResponseError{Code: CodeMethodNotFound, Message: "method not supported by Barista"}
}

var approvalOptionKinds = map[string]string{
	"allow_once": "allow-once", "allow_always": "allow-always", "reject_once": "reject-once", "reject_always": "reject-always",
}

func cancelledPermission() requestPermissionResponse {
	return requestPermissionResponse{Outcome: permissionOutcome{Outcome: "cancelled"}}
}

func (client *Client) requestPermission(ctx context.Context, params json.RawMessage) requestPermissionResponse {
	var request requestPermissionRequest
	if err := decodeStrict(params, &request); err != nil {
		client.emit(warningEvent(WarningPermissionMalformed, "permission request is malformed and was cancelled"))
		return cancelledPermission()
	}
	client.stateMu.Lock()
	sessionID, completed := client.sessionID, client.completed
	client.stateMu.Unlock()
	if sessionID == "" || request.SessionID != sessionID || completed {
		client.emit(warningEvent(WarningPermissionMalformed, "permission request does not belong to the active prompt turn and was cancelled"))
		return cancelledPermission()
	}
	options, offered, valid := approvalOptions(request.Options)
	toolCallID := request.ToolCall.ToolCallID
	if !valid || toolCallID == "" || len(toolCallID) > eventIdentifierBytes {
		client.emit(warningEvent(WarningPermissionMalformed, "permission request has missing, duplicate, or invalid options and was cancelled"))
		return cancelledPermission()
	}

	approvalID := fmt.Sprintf("acp-permission-%d", client.approvalCount.Add(1))
	title := "Permission requested"
	if request.ToolCall.Title != nil && *request.ToolCall.Title != "" {
		title = truncateBytes(*request.ToolCall.Title, eventTitleBytes)
	}
	kind := "other"
	if request.ToolCall.Kind != nil {
		if mapped, known := toolCallKinds[*request.ToolCall.Kind]; known {
			kind = mapped
		}
	}
	client.emit(protocol.HarnessEvent{Type: "permission.requested", ApprovalID: approvalID, ToolCallID: toolCallID, Title: title, Options: options})

	status, selected := client.decidePermission(ctx, PermissionRequest{
		RunID: client.options.RunID, SessionID: sessionID, ApprovalID: approvalID, ToolCallID: toolCallID,
		Title: client.redaction.apply(title), Kind: kind, Options: client.redactOptions(options),
	}, offered)
	client.emit(protocol.HarnessEvent{Type: "permission.resolved", ApprovalID: approvalID, Status: status, SelectedOptionID: selected})
	if selected == "" {
		return fallbackPermission(options)
	}
	return requestPermissionResponse{Outcome: permissionOutcome{Outcome: "selected", OptionID: selected}}
}

// decidePermission returns the normalized resolution status and, for approved or rejected, the
// selected option. Anything other than a valid, timely choice resolves without an option.
func (client *Client) decidePermission(ctx context.Context, request PermissionRequest, offered map[string]string) (string, string) {
	if client.options.Permission == nil {
		return "cancelled", ""
	}
	decisionContext, cancel := context.WithTimeout(ctx, client.options.PermissionTimeout)
	defer cancel()

	type decisionOutcome struct {
		decision PermissionDecision
		err      error
	}
	outcome := make(chan decisionOutcome, 1)
	go func() {
		decision, err := client.options.Permission(decisionContext, request)
		outcome <- decisionOutcome{decision: decision, err: err}
	}()
	select {
	case result := <-outcome:
		if decisionContext.Err() != nil {
			return timeoutStatus(decisionContext), ""
		}
		kind, known := offered[result.decision.OptionID]
		if result.err != nil || result.decision.OptionID == "" || !known {
			return "cancelled", ""
		}
		if strings.HasPrefix(kind, "allow") {
			return "approved", result.decision.OptionID
		}
		return "rejected", result.decision.OptionID
	case <-decisionContext.Done():
		return timeoutStatus(decisionContext), ""
	case <-client.cancelling:
		return "cancelled", ""
	}
}

func timeoutStatus(ctx context.Context) string {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return "expired"
	}
	return "cancelled"
}

// fallbackPermission answers an unresolved request with a rejection when the agent offered one, so
// the agent learns the tool was denied; otherwise it cancels. It never allows.
func fallbackPermission(options []protocol.ApprovalOption) requestPermissionResponse {
	for _, option := range options {
		if option.Kind == "reject-once" {
			return requestPermissionResponse{Outcome: permissionOutcome{Outcome: "selected", OptionID: option.ID}}
		}
	}
	return cancelledPermission()
}

func approvalOptions(received []permissionOption) ([]protocol.ApprovalOption, map[string]string, bool) {
	if len(received) == 0 || len(received) > eventOptionLimit {
		return nil, nil, false
	}
	options := make([]protocol.ApprovalOption, 0, len(received))
	offered := make(map[string]string, len(received))
	for _, option := range received {
		kind, known := approvalOptionKinds[option.Kind]
		if !known || option.OptionID == "" || len(option.OptionID) > eventIdentifierBytes {
			return nil, nil, false
		}
		if _, duplicate := offered[option.OptionID]; duplicate {
			return nil, nil, false
		}
		offered[option.OptionID] = kind
		options = append(options, protocol.ApprovalOption{ID: option.OptionID, Label: truncateBytes(option.Name, eventTitleBytes), Kind: kind})
	}
	return options, offered, true
}

func (client *Client) redactOptions(options []protocol.ApprovalOption) []protocol.ApprovalOption {
	redacted := make([]protocol.ApprovalOption, len(options))
	for index, option := range options {
		redacted[index] = protocol.ApprovalOption{ID: option.ID, Label: client.redaction.apply(option.Label), Kind: option.Kind}
	}
	return redacted
}

// emit assigns run identity, sequence, and time, redacts secrets, and delivers events in order.
func (client *Client) emit(events ...protocol.HarnessEvent) {
	if len(events) == 0 {
		return
	}
	client.emitMu.Lock()
	defer client.emitMu.Unlock()
	for _, event := range events {
		event = client.redactEvent(event)
		client.sequence++
		event.RunID = client.options.RunID
		event.Sequence = client.sequence
		event.At = client.options.Now().UTC().Format(time.RFC3339Nano)
		if err := event.Validate(); err != nil {
			event = protocol.HarnessEvent{
				Type: "warning", RunID: event.RunID, Sequence: event.Sequence, At: event.At,
				Code: WarningEventInvalid, Message: truncateBytes(client.redaction.apply(err.Error()), MaximumDiagnosticBytes),
			}
		}
		if client.options.Events != nil {
			client.options.Events(event)
		}
	}
}

func (client *Client) redactEvent(event protocol.HarnessEvent) protocol.HarnessEvent {
	apply := client.redaction.apply
	for _, field := range []*string{&event.Text, &event.Title, &event.Detail, &event.Path, &event.OldText, &event.NewText, &event.Message, &event.ToolCallID, &event.SourceType} {
		*field = apply(*field)
	}
	if event.Entries != nil {
		entries := make([]protocol.PlanEntry, len(event.Entries))
		for index, entry := range event.Entries {
			entry.Content = apply(entry.Content)
			entries[index] = entry
		}
		event.Entries = entries
	}
	if event.Options != nil {
		event.Options = client.redactOptions(event.Options)
	}
	return event
}

type redactedError struct {
	message string
	cause   error
}

func (err *redactedError) Error() string { return err.message }
func (err *redactedError) Unwrap() error { return err.cause }

func (client *Client) redactError(err error) error {
	return &redactedError{message: truncateBytes(client.redaction.apply(err.Error()), MaximumDiagnosticBytes), cause: err}
}

// Warn appends a bounded warning to the event stream, in sequence with normalized updates.
func (client *Client) Warn(code, message string) {
	client.emit(warningEvent(code, message))
}

// Redact removes configured secrets from a caller-produced diagnostic.
func (client *Client) Redact(value string) string {
	return client.redaction.apply(value)
}

func isNull(raw json.RawMessage) bool {
	return strings.TrimSpace(string(raw)) == "null"
}
