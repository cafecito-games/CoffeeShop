// Package codex integrates the setup-verified Codex 0.147.0 App Server with the
// provider-neutral host-session supervisor. Provider RPC shapes do not escape this package.
package codex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/harness"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/hostsession"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

const (
	SupportedVersion = "0.147.0"
	maxListPages     = 64
	maxProviderID    = 256
	maxSummaryBytes  = 1024
)

var allCapabilities = hostsession.NewCapabilitySet(
	hostsession.OperationDiscover, hostsession.OperationReadHistory, hostsession.OperationInspect,
	hostsession.OperationAdopt, hostsession.OperationCreate, hostsession.OperationResume,
	hostsession.OperationDetach, hostsession.OperationStartTurn, hostsession.OperationSteer,
	hostsession.OperationInterrupt, hostsession.OperationResolveApproval, hostsession.OperationRefresh,
	hostsession.OperationReconcile, hostsession.OperationClose,
)

var readOperations = []string{"attach", "close", "read-history"}
var writeOperations = []string{"attach", "close", "detach", "interrupt", "read-history", "resolve-approval", "start-turn", "steer"}

type Config struct {
	Binary         string
	Version        string
	Verify         func() error
	WorkspaceRoots []string
	StateRoot      string
	ApprovalPolicy string
}

type Driver struct {
	config Config
	mu     sync.Mutex
	live   map[string]*liveSession
	closed bool
}

type liveSession struct {
	mu        sync.Mutex
	client    *client
	thread    providerThread
	source    string
	turnID    string
	starting  bool
	runID     string
	emit      func(protocol.HarnessEvent) error
	observe   func(hostsession.DriverSession) error
	activated <-chan struct{}
	aborted   <-chan struct{}
	sequence  int64
	approvals map[string]pendingApproval
	warned    map[string]bool
	events    chan providerMessage
	stop      chan struct{}
	stopOnce  sync.Once
	// uncertain is set when a mutating request may have reached the App Server but no valid
	// response was received. This process keeps the writer connection, but admits no further
	// mutation until a daemon restart can reclaim and reconcile the thread conclusively.
	uncertain                     bool
	uncertainObservationScheduled bool
}

type pendingApproval struct {
	id     json.RawMessage
	turnID string
}

type providerMessage struct {
	method  string
	params  json.RawMessage
	request bool
	id      json.RawMessage
	closed  bool
}

type providerThread struct {
	ID          string          `json:"id"`
	CWD         string          `json:"cwd"`
	CLIVersion  string          `json:"cliVersion"`
	HistoryMode string          `json:"historyMode"`
	Preview     string          `json:"preview"`
	Name        *string         `json:"name"`
	Status      json.RawMessage `json:"status"`
	Turns       []providerTurn  `json:"turns"`
}

type providerTurn struct {
	ID     string            `json:"id"`
	Status string            `json:"status"`
	Items  []json.RawMessage `json:"items"`
}

type providerHistoryEntry struct {
	TurnID string          `json:"turnId"`
	Item   json.RawMessage `json:"item"`
}

type threadResponse struct {
	Thread            providerThread `json:"thread"`
	ApprovalPolicy    string         `json:"approvalPolicy"`
	ApprovalsReviewer string         `json:"approvalsReviewer"`
	Sandbox           struct {
		Type string `json:"type"`
	} `json:"sandbox"`
}

type policySettings struct {
	approvalPolicy    string
	approvalsReviewer string
	sandboxMode       string
	sandboxType       string
	sandboxPolicy     map[string]any
}

func New(ctx context.Context, config Config) (*Driver, error) {
	if config.ApprovalPolicy == "" {
		config.ApprovalPolicy = protocol.ApprovalPolicyManual
	}
	if config.Version != SupportedVersion || config.Binary == "" || !filepath.IsAbs(config.Binary) || config.Verify == nil || !filepath.IsAbs(config.StateRoot) {
		return nil, errors.New("codex-protocol-incompatible")
	}
	if _, valid := policyFor(config.ApprovalPolicy); !valid {
		return nil, errors.New("codex-protocol-incompatible")
	}
	if err := config.Verify(); err != nil {
		return nil, errors.New("codex-protocol-incompatible")
	}
	if err := os.MkdirAll(config.StateRoot, 0o700); err != nil {
		return nil, errors.New("codex-protocol-incompatible")
	}
	if err := cleanupStaleRuntimes(config.StateRoot); err != nil {
		return nil, errors.New("codex-protocol-incompatible")
	}
	probe, err := startClient(ctx, clientConfig{binary: config.Binary, verify: config.Verify, stateRoot: config.StateRoot})
	if err != nil {
		return nil, errors.New("codex-protocol-incompatible")
	}
	probe.Close()
	return &Driver{config: config, live: make(map[string]*liveSession)}, nil
}

func (driver *Driver) HarnessID() string                       { return "codex-cli" }
func (driver *Driver) Capabilities() hostsession.CapabilitySet { return allCapabilities }

func (driver *Driver) Discover(ctx context.Context, request hostsession.DiscoverRequest) (hostsession.DiscoverPage, error) {
	connection, err := driver.ephemeral(ctx)
	if err != nil {
		return hostsession.DiscoverPage{}, err
	}
	defer connection.Close()
	limit := request.Limit
	if limit <= 0 || limit > protocol.HostHarnessSessionLimits.SessionsPerGeneration {
		limit = protocol.HostHarnessSessionLimits.SessionsPerGeneration
	}
	cursor := request.Cursor
	seenCursors := map[string]bool{}
	seenIDs := map[string]bool{}
	result := make([]hostsession.DriverSession, 0, limit)
	truncated := false
	for page := 0; page < maxListPages; page++ {
		params := map[string]any{"limit": limit}
		if cursor != "" {
			params["cursor"] = cursor
		}
		var response struct {
			Data       []providerThread `json:"data"`
			NextCursor *string          `json:"nextCursor"`
		}
		if err := connection.call(ctx, "thread/list", params, &response); err != nil {
			return hostsession.DiscoverPage{}, errors.New("codex-list-failed")
		}
		for _, thread := range response.Data {
			if len(result) == limit {
				truncated = true
				break
			}
			if !validProviderID(thread.ID) || seenIDs[thread.ID] {
				return hostsession.DiscoverPage{}, errors.New("codex-protocol-incompatible")
			}
			seenIDs[thread.ID] = true
			session, valid := driver.observation(thread, "provider-history")
			if valid {
				result = append(result, session)
			}
		}
		if truncated || response.NextCursor == nil || *response.NextCursor == "" {
			return hostsession.DiscoverPage{Sessions: result, Truncated: truncated}, nil
		}
		if seenCursors[*response.NextCursor] || *response.NextCursor == cursor {
			return hostsession.DiscoverPage{}, errors.New("codex-pagination-invalid")
		}
		seenCursors[*response.NextCursor] = true
		cursor = *response.NextCursor
	}
	return hostsession.DiscoverPage{}, errors.New("codex-pagination-limit")
}

func (driver *Driver) ReadHistory(ctx context.Context, request hostsession.ReadHistoryRequest) (hostsession.HistoryPage, error) {
	connection, err := driver.ephemeral(ctx)
	if err != nil {
		return hostsession.HistoryPage{}, err
	}
	defer connection.Close()
	thread, err := readThread(ctx, connection, request.Session.ProviderSessionID, false)
	if err != nil {
		return hostsession.HistoryPage{}, err
	}
	if _, valid := driver.observation(thread, request.Session.Source); !valid || thread.CWD != request.Session.Workspace {
		return hostsession.HistoryPage{}, errors.New("workspace-unauthorized")
	}
	params := map[string]any{
		"threadId": thread.ID, "limit": request.Limit, "sortDirection": "desc",
	}
	if request.Cursor != "" {
		params["cursor"] = request.Cursor
	}
	var response struct {
		Data       []providerHistoryEntry `json:"data"`
		NextCursor *string                `json:"nextCursor"`
	}
	if err := connection.call(ctx, "thread/items/list", params, &response); err != nil {
		return hostsession.HistoryPage{}, errors.New("codex-history-read-failed")
	}
	if len(response.Data) > request.Limit {
		return hostsession.HistoryPage{}, errors.New("codex-protocol-incompatible")
	}
	items, err := historyEntries(response.Data)
	if err != nil {
		return hostsession.HistoryPage{}, err
	}
	next := ""
	if response.NextCursor != nil {
		next = *response.NextCursor
	}
	return hostsession.HistoryPage{Items: items, NextCursor: next, Truncated: next != ""}, nil
}

func (driver *Driver) Inspect(ctx context.Context, request hostsession.SessionRequest) (hostsession.DriverSession, error) {
	connection, err := driver.ephemeral(ctx)
	if err != nil {
		return hostsession.DriverSession{}, err
	}
	defer connection.Close()
	thread, err := readThread(ctx, connection, request.ProviderSessionID, false)
	if err != nil {
		return hostsession.DriverSession{}, errors.New("adoption-failed")
	}
	observation, valid := driver.observation(thread, "provider-history")
	if !valid || observation.Workspace != request.Workspace {
		return hostsession.DriverSession{}, errors.New("workspace-unauthorized")
	}
	return observation, nil
}

func (driver *Driver) Adopt(ctx context.Context, request hostsession.SessionRequest) (hostsession.DriverSession, error) {
	if request.ControlMode == "observe" {
		return hostsession.DriverSession{}, hostsession.DriverRejection{Code: "unsupported-history-mode"}
	}
	if driver.lookupLive(request.ProviderSessionID) != nil {
		return hostsession.DriverSession{}, hostsession.DriverRejection{Code: "active-elsewhere"}
	}
	return driver.claim(ctx, request, false)
}

func (driver *Driver) Create(ctx context.Context, request hostsession.SessionRequest) (hostsession.DriverSession, error) {
	canonical, err := harness.AuthorizeWorkspace(request.Workspace, driver.config.WorkspaceRoots)
	if err != nil || canonical != request.Workspace {
		return hostsession.DriverSession{}, hostsession.DriverRejection{Code: "workspace-unauthorized"}
	}
	live := newLiveSession("coffee-shop-managed")
	live.mu.Lock()
	live.observe = request.Observe
	live.activated = request.Activated
	live.aborted = request.Aborted
	live.starting = true
	live.mu.Unlock()
	connection, err := driver.newLiveClient(ctx, live)
	if err != nil {
		live.stopEvents()
		return hostsession.DriverSession{}, err
	}
	live.mu.Lock()
	live.client = connection
	live.mu.Unlock()
	policy, _ := policyFor(driver.config.ApprovalPolicy)
	params := map[string]any{
		"cwd": canonical, "historyMode": "paginated", "approvalPolicy": policy.approvalPolicy,
		"approvalsReviewer": policy.approvalsReviewer, "sandbox": policy.sandboxMode,
	}
	if request.Model != "" {
		params["model"] = request.Model
	}
	var response threadResponse
	if err := connection.call(ctx, "thread/start", params, &response); err != nil {
		connection.Close()
		live.stopEvents()
		return hostsession.DriverSession{}, errors.New("create-failed")
	}
	observation, valid := driver.observation(response.Thread, "coffee-shop-managed")
	if !valid || response.Thread.HistoryMode != "paginated" || response.Thread.CLIVersion != SupportedVersion || observation.Workspace != canonical || !validPolicyResponse(response, policy) {
		connection.Close()
		live.stopEvents()
		return hostsession.DriverSession{}, errors.New("codex-protocol-incompatible")
	}
	live.mu.Lock()
	live.thread = response.Thread
	uncertain := live.uncertain
	live.mu.Unlock()
	if uncertain {
		connection.Close()
		live.stopEvents()
		return hostsession.DriverSession{}, errors.New("create-failed")
	}
	driver.mu.Lock()
	if driver.closed || driver.live[response.Thread.ID] != nil {
		driver.mu.Unlock()
		connection.Close()
		live.stopEvents()
		return hostsession.DriverSession{}, errors.New("session-already-live")
	}
	driver.live[response.Thread.ID] = live
	driver.mu.Unlock()
	live.mu.Lock()
	live.starting = false
	uncertain = live.uncertain
	live.mu.Unlock()
	if uncertain {
		driver.forgetLive(live)
		connection.Close()
		live.stopEvents()
		return hostsession.DriverSession{}, errors.New("create-failed")
	}
	driver.watchClaimCommit(live)
	observation.ControlMode = "full"
	observation.Operations = slices.Clone(writeOperations)
	return observation, nil
}

func (driver *Driver) Resume(ctx context.Context, request hostsession.SessionRequest) (hostsession.DriverSession, error) {
	driver.mu.Lock()
	live := driver.live[request.ProviderSessionID]
	driver.mu.Unlock()
	if live != nil {
		if driver.liveUncertain(live) {
			observed := driver.uncertainObservation(live, request.Source)
			return hostsession.DriverSession{}, hostsession.DriverRejection{Code: "active-elsewhere", Observation: &observed}
		}
		driver.bindExistingClaimAfterCommit(live, request)
		return driver.liveObservation(live, request.Source), nil
	}
	return driver.claim(ctx, request, true)
}

func (driver *Driver) claim(ctx context.Context, request hostsession.SessionRequest, restart bool) (hostsession.DriverSession, error) {
	live := newLiveSession(request.Source)
	live.mu.Lock()
	live.observe = request.Observe
	live.activated = request.Activated
	live.aborted = request.Aborted
	live.starting = true
	live.mu.Unlock()
	connection, err := driver.newLiveClient(ctx, live)
	if err != nil {
		live.stopEvents()
		return hostsession.DriverSession{}, err
	}
	live.mu.Lock()
	live.client = connection
	live.mu.Unlock()
	policy, _ := policyFor(driver.config.ApprovalPolicy)
	var response threadResponse
	err = connection.call(ctx, "thread/resume", map[string]any{
		"threadId": request.ProviderSessionID, "approvalPolicy": policy.approvalPolicy,
		"approvalsReviewer": policy.approvalsReviewer, "sandbox": policy.sandboxMode,
	}, &response)
	if err != nil {
		connection.Close()
		live.stopEvents()
		code, message, rpc := classifyRPC(err)
		expected := fmt.Sprintf("thread %s already has an active writer", request.ProviderSessionID)
		if rpc && code == -32600 && message == expected {
			observed := hostsession.DriverSession{ProviderSessionID: request.ProviderSessionID, Workspace: request.Workspace, Source: request.Source, Status: "active-elsewhere", ControlMode: "observe", Operations: slices.Clone(readOperations), Summary: request.Summary}
			return hostsession.DriverSession{}, hostsession.DriverRejection{Code: "active-elsewhere", Observation: &observed}
		}
		observed := hostsession.DriverSession{ProviderSessionID: request.ProviderSessionID, Workspace: request.Workspace, Source: request.Source, Status: "active-elsewhere", ControlMode: "observe", Operations: slices.Clone(readOperations), Summary: request.Summary}
		return hostsession.DriverSession{}, hostsession.DriverRejection{Code: "adoption-failed", Observation: &observed}
	}
	observation, valid := driver.observation(response.Thread, request.Source)
	if !valid || response.Thread.ID != request.ProviderSessionID || response.Thread.HistoryMode != "paginated" || response.Thread.CLIVersion != SupportedVersion || observation.Workspace != request.Workspace || !validPolicyResponse(response, policy) {
		connection.Close()
		live.stopEvents()
		observed := hostsession.DriverSession{ProviderSessionID: request.ProviderSessionID, Workspace: request.Workspace, Source: request.Source, Status: "active-elsewhere", ControlMode: "observe", Operations: slices.Clone(readOperations), Summary: request.Summary}
		return hostsession.DriverSession{}, hostsession.DriverRejection{Code: "adoption-failed", Observation: &observed}
	}
	live.mu.Lock()
	live.thread = response.Thread
	uncertain := live.uncertain
	live.mu.Unlock()
	if uncertain {
		connection.Close()
		live.stopEvents()
		observed := hostsession.DriverSession{ProviderSessionID: request.ProviderSessionID, Workspace: request.Workspace, Source: request.Source, Status: "active-elsewhere", ControlMode: "observe", Operations: slices.Clone(readOperations), Summary: request.Summary}
		return hostsession.DriverSession{}, hostsession.DriverRejection{Code: "adoption-failed", Observation: &observed}
	}
	driver.mu.Lock()
	if driver.closed || driver.live[response.Thread.ID] != nil {
		driver.mu.Unlock()
		connection.Close()
		live.stopEvents()
		return hostsession.DriverSession{}, hostsession.DriverRejection{Code: "active-elsewhere"}
	}
	driver.live[response.Thread.ID] = live
	driver.mu.Unlock()
	live.mu.Lock()
	live.starting = false
	uncertain = live.uncertain
	live.mu.Unlock()
	if uncertain {
		driver.forgetLive(live)
		connection.Close()
		live.stopEvents()
		observed := hostsession.DriverSession{ProviderSessionID: request.ProviderSessionID, Workspace: request.Workspace, Source: request.Source, Status: "active-elsewhere", ControlMode: "observe", Operations: slices.Clone(readOperations), Summary: request.Summary}
		return hostsession.DriverSession{}, hostsession.DriverRejection{Code: "adoption-failed", Observation: &observed}
	}
	driver.watchClaimCommit(live)
	observation.ControlMode = "full"
	observation.Operations = slices.Clone(writeOperations)
	if restart {
		observation.Summary = bounded(observation.Summary, maxSummaryBytes)
	}
	return observation, nil
}

func (driver *Driver) Detach(_ context.Context, request hostsession.SessionRequest) (hostsession.DriverSession, error) {
	driver.release(request.ProviderSessionID)
	request.Status = "idle"
	request.ControlMode = "resume"
	request.Operations = slices.Clone(readOperations)
	request.ProviderTurnID = ""
	return fromRequest(request), nil
}

func (driver *Driver) StartTurn(ctx context.Context, request hostsession.SessionRequest) (hostsession.DriverSession, error) {
	live, err := driver.requireLive(request.ProviderSessionID)
	if err != nil {
		return hostsession.DriverSession{}, err
	}
	live.mu.Lock()
	if live.turnID != "" {
		live.mu.Unlock()
		return hostsession.DriverSession{}, hostsession.DriverRejection{Code: "illegal-transition"}
	}
	live.runID, live.emit, live.observe, live.activated, live.aborted = request.RunID, request.Emit, request.Observe, request.Activated, request.Aborted
	live.sequence = 0
	live.starting = true
	live.mu.Unlock()
	policy, _ := policyFor(driver.config.ApprovalPolicy)
	var response struct {
		Turn providerTurn `json:"turn"`
	}
	if err := live.client.call(ctx, "turn/start", map[string]any{
		"threadId":       request.ProviderSessionID,
		"input":          []map[string]string{{"type": "text", "text": request.Prompt}},
		"approvalPolicy": policy.approvalPolicy, "approvalsReviewer": policy.approvalsReviewer,
		"sandboxPolicy": policy.sandboxPolicy,
	}, &response); err != nil || !validProviderID(response.Turn.ID) || response.Turn.Status != "inProgress" {
		live.mu.Lock()
		live.starting = false
		live.uncertain = true
		live.mu.Unlock()
		return hostsession.DriverSession{}, errors.New("turn-start-failed")
	}
	live.mu.Lock()
	live.starting = false
	live.turnID = response.Turn.ID
	uncertain := live.uncertain
	live.mu.Unlock()
	live.watchTurnCommit(response.Turn.ID)
	live.scheduleUncertainObservation()
	if uncertain {
		driver.forgetLive(live)
	}
	observation := driver.liveObservation(live, request.Source)
	observation.Status = "running"
	observation.ProviderTurnID = response.Turn.ID
	return observation, nil
}

func (driver *Driver) Steer(ctx context.Context, request hostsession.SessionRequest) (hostsession.DriverSession, error) {
	live, err := driver.requireLive(request.ProviderSessionID)
	if err != nil {
		return hostsession.DriverSession{}, err
	}
	live.mu.Lock()
	turnID := live.turnID
	live.mu.Unlock()
	if turnID == "" || request.ProviderTurnID != turnID {
		return hostsession.DriverSession{}, hostsession.DriverRejection{Code: "provider-turn-conflict"}
	}
	var response struct {
		TurnID string `json:"turnId"`
	}
	if err := live.client.call(ctx, "turn/steer", map[string]any{"threadId": request.ProviderSessionID, "expectedTurnId": turnID, "input": []map[string]string{{"type": "text", "text": request.Text}}}, &response); err != nil || response.TurnID != turnID {
		live.mu.Lock()
		live.uncertain = true
		live.mu.Unlock()
		return hostsession.DriverSession{}, errors.New("steer-failed")
	}
	return driver.liveObservation(live, request.Source), nil
}

func (driver *Driver) Interrupt(ctx context.Context, request hostsession.SessionRequest) (hostsession.DriverSession, error) {
	live, err := driver.requireLive(request.ProviderSessionID)
	if err != nil {
		return hostsession.DriverSession{}, err
	}
	live.mu.Lock()
	turnID := live.turnID
	live.mu.Unlock()
	if turnID == "" || request.ProviderTurnID != turnID {
		return hostsession.DriverSession{}, hostsession.DriverRejection{Code: "provider-turn-conflict"}
	}
	if err := live.client.call(ctx, "turn/interrupt", map[string]any{"threadId": request.ProviderSessionID, "turnId": turnID}, &struct{}{}); err != nil {
		live.mu.Lock()
		live.uncertain = true
		live.mu.Unlock()
		return hostsession.DriverSession{}, errors.New("interrupt-failed")
	}
	live.mu.Lock()
	if live.turnID == turnID {
		live.turnID = ""
	}
	live.mu.Unlock()
	live.resolvePendingApprovals(turnID, "cancelled", "")
	result := driver.liveObservation(live, request.Source)
	result.Status = "idle"
	result.ProviderTurnID = ""
	return result, nil
}

func (driver *Driver) ResolveApproval(_ context.Context, request hostsession.SessionRequest) (hostsession.DriverSession, error) {
	live, err := driver.requireLive(request.ProviderSessionID)
	if err != nil {
		return hostsession.DriverSession{}, err
	}
	if request.Decision == nil {
		return hostsession.DriverSession{}, hostsession.DriverRejection{Code: "approval-mismatch"}
	}
	live.mu.Lock()
	pending, found := live.approvals[request.Decision.ApprovalID]
	live.mu.Unlock()
	if !found || pending.turnID != request.ProviderTurnID {
		return hostsession.DriverSession{}, hostsession.DriverRejection{Code: "approval-mismatch"}
	}
	decision := approvalDecision(request.Decision)
	response := map[string]any{"decision": decision}
	if decision == "" {
		return hostsession.DriverSession{}, hostsession.DriverRejection{Code: "approval-mismatch"}
	}
	live.mu.Lock()
	current, stillPending := live.approvals[request.Decision.ApprovalID]
	if stillPending && current.turnID == request.ProviderTurnID {
		delete(live.approvals, request.Decision.ApprovalID)
	} else {
		stillPending = false
	}
	live.mu.Unlock()
	if !stillPending {
		return hostsession.DriverSession{}, hostsession.DriverRejection{Code: "approval-mismatch"}
	}
	if live.client.respond(pending.id, response) != nil {
		live.mu.Lock()
		live.uncertain = true
		live.mu.Unlock()
		return hostsession.DriverSession{}, errors.New("approval-failed")
	}
	live.emitEvent(protocol.HarnessEvent{
		Type: "permission.resolved", ApprovalID: request.Decision.ApprovalID,
		Status: request.Decision.Status, SelectedOptionID: request.Decision.SelectedOptionID,
	})
	return driver.liveObservation(live, request.Source), nil
}

func (driver *Driver) Refresh(ctx context.Context, request hostsession.SessionRequest) (hostsession.DriverSession, error) {
	if live := driver.lookupLive(request.ProviderSessionID); live != nil {
		if driver.liveUncertain(live) {
			return driver.uncertainObservation(live, request.Source), nil
		}
		driver.bindExistingClaimAfterCommit(live, request)
		return driver.liveObservation(live, request.Source), nil
	}
	connection, err := driver.ephemeral(ctx)
	if err != nil {
		return hostsession.DriverSession{}, err
	}
	defer connection.Close()
	thread, err := readThread(ctx, connection, request.ProviderSessionID, false)
	if err != nil {
		return hostsession.DriverSession{}, err
	}
	observation, valid := driver.observation(thread, request.Source)
	if !valid || observation.Workspace != request.Workspace {
		return hostsession.DriverSession{}, errors.New("workspace-unauthorized")
	}
	return observation, nil
}

func (driver *Driver) Reconcile(ctx context.Context, request hostsession.SessionRequest) (hostsession.DriverSession, error) {
	if live := driver.lookupLive(request.ProviderSessionID); live != nil {
		if driver.liveUncertain(live) {
			return driver.uncertainObservation(live, request.Source), nil
		}
		driver.bindExistingClaimAfterCommit(live, request)
		return driver.liveObservation(live, request.Source), nil
	}
	return driver.claim(ctx, request, true)
}

func (driver *Driver) Close(_ context.Context, request hostsession.SessionRequest) (hostsession.DriverSession, error) {
	driver.release(request.ProviderSessionID)
	result := fromRequest(request)
	result.Status = "closed"
	result.ProviderTurnID = ""
	result.Operations = []string{"read-history"}
	result.ControlMode = "observe"
	return result, nil
}

func (driver *Driver) Shutdown() {
	driver.mu.Lock()
	driver.closed = true
	sessions := driver.live
	driver.live = make(map[string]*liveSession)
	driver.mu.Unlock()
	for _, live := range sessions {
		live.resolvePendingApprovals("", "cancelled", "")
		live.client.Close()
		live.stopEvents()
	}
}

func (driver *Driver) ReleaseClaim(providerSessionID string) {
	driver.release(providerSessionID)
}

func cleanupStaleRuntimes(stateRoot string) error {
	entries, err := os.ReadDir(stateRoot)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "process-") {
			continue
		}
		if err := os.RemoveAll(filepath.Join(stateRoot, entry.Name())); err != nil {
			return err
		}
	}
	return nil
}

func (driver *Driver) ephemeral(ctx context.Context) (*client, error) {
	return startClient(ctx, clientConfig{binary: driver.config.Binary, verify: driver.config.Verify, stateRoot: driver.config.StateRoot})
}

func (driver *Driver) newLiveClient(ctx context.Context, live *liveSession) (*client, error) {
	return startClient(ctx, clientConfig{binary: driver.config.Binary, verify: driver.config.Verify, stateRoot: driver.config.StateRoot,
		lifetime: context.Background(),
		onNotification: func(method string, params json.RawMessage) error {
			return live.deliver(providerMessage{method: method, params: params})
		},
		onRequest: func(id json.RawMessage, method string, params json.RawMessage) error {
			return live.deliver(providerMessage{id: id, method: method, params: params, request: true})
		},
		onClose: func(error) {
			live.closeUnexpected()
			live.mu.Lock()
			starting := live.starting
			live.mu.Unlock()
			if !starting {
				driver.forgetLive(live)
			}
		},
	})
}

func (driver *Driver) observation(thread providerThread, source string) (hostsession.DriverSession, bool) {
	if !validProviderID(thread.ID) || thread.CLIVersion == "" || len(thread.CLIVersion) > 128 || len(thread.Status) == 0 || !json.Valid(thread.Status) || (thread.HistoryMode != "paginated" && thread.HistoryMode != "legacy") {
		return hostsession.DriverSession{}, false
	}
	canonical, err := harness.AuthorizeWorkspace(thread.CWD, driver.config.WorkspaceRoots)
	if err != nil || canonical != thread.CWD {
		return hostsession.DriverSession{}, false
	}
	control, operations := "observe", []string{"read-history"}
	if thread.HistoryMode == "paginated" && thread.CLIVersion == SupportedVersion {
		control, operations = "resume", slices.Clone(readOperations)
	}
	return hostsession.DriverSession{ProviderSessionID: thread.ID, Workspace: canonical, Source: source, Status: "idle", ControlMode: control, Operations: operations, Summary: providerSummary(thread)}, true
}

func (driver *Driver) liveObservation(live *liveSession, source string) hostsession.DriverSession {
	return liveObservationSnapshot(live, source)
}

func (driver *Driver) requireLive(id string) (*liveSession, error) {
	live := driver.lookupLive(id)
	if live == nil {
		return nil, hostsession.DriverRejection{Code: "session-not-live"}
	}
	if driver.liveUncertain(live) {
		return nil, errors.New("session-effect-uncertain")
	}
	return live, nil
}

func (driver *Driver) lookupLive(id string) *liveSession {
	driver.mu.Lock()
	defer driver.mu.Unlock()
	return driver.live[id]
}

func (driver *Driver) liveUncertain(live *liveSession) bool {
	live.mu.Lock()
	defer live.mu.Unlock()
	return live.uncertain
}

func (driver *Driver) uncertainObservation(live *liveSession, source string) hostsession.DriverSession {
	live.mu.Lock()
	defer live.mu.Unlock()
	return hostsession.DriverSession{
		ProviderSessionID: live.thread.ID, Workspace: live.thread.CWD, Source: source,
		Status: "active-elsewhere", ControlMode: "observe", Operations: slices.Clone(readOperations),
		ProviderTurnID: live.turnID, Summary: providerSummary(live.thread),
	}
}

func (driver *Driver) release(id string) {
	driver.mu.Lock()
	live := driver.live[id]
	delete(driver.live, id)
	driver.mu.Unlock()
	if live != nil {
		live.resolvePendingApprovals("", "cancelled", "")
		live.client.Close()
		live.stopEvents()
	}
}

func (driver *Driver) forgetLive(target *liveSession) {
	driver.mu.Lock()
	defer driver.mu.Unlock()
	for id, live := range driver.live {
		if live == target {
			delete(driver.live, id)
			return
		}
	}
}

func (driver *Driver) watchClaimCommit(live *liveSession) {
	live.mu.Lock()
	activated := live.activated
	aborted := live.aborted
	live.mu.Unlock()
	if activated == nil || aborted == nil {
		return
	}
	go func() {
		select {
		case <-activated:
		case <-aborted:
			driver.releaseLive(live)
		case <-live.stop:
		}
	}()
}

func (driver *Driver) releaseLive(live *liveSession) {
	driver.forgetLive(live)
	live.resolvePendingApprovals("", "cancelled", "")
	live.client.Close()
	live.stopEvents()
}

func (driver *Driver) bindExistingClaimAfterCommit(live *liveSession, request hostsession.SessionRequest) {
	if request.Activated == nil || request.Aborted == nil {
		live.mu.Lock()
		live.observe = request.Observe
		live.mu.Unlock()
		return
	}
	go func() {
		select {
		case <-request.Activated:
			live.mu.Lock()
			if live.turnID == "" && !live.starting {
				live.observe = request.Observe
			}
			live.mu.Unlock()
		case <-request.Aborted:
		case <-live.stop:
		}
	}()
}

func newLiveSession(source string) *liveSession {
	live := &liveSession{
		source: source, approvals: make(map[string]pendingApproval), warned: make(map[string]bool),
		events: make(chan providerMessage, 256), stop: make(chan struct{}),
	}
	go live.runEvents()
	return live
}

func policyFor(policy string) (policySettings, bool) {
	switch policy {
	case protocol.ApprovalPolicyManual:
		return policySettings{
			approvalPolicy: "on-request", approvalsReviewer: "user", sandboxMode: "workspace-write", sandboxType: "workspaceWrite",
			sandboxPolicy: map[string]any{"type": "workspaceWrite", "writableRoots": []string{}, "networkAccess": false, "excludeTmpdirEnvVar": false, "excludeSlashTmp": false},
		}, true
	case protocol.ApprovalPolicyAuto:
		return policySettings{
			approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandboxMode: "workspace-write", sandboxType: "workspaceWrite",
			sandboxPolicy: map[string]any{"type": "workspaceWrite", "writableRoots": []string{}, "networkAccess": false, "excludeTmpdirEnvVar": false, "excludeSlashTmp": false},
		}, true
	case protocol.ApprovalPolicyBypass:
		return policySettings{
			approvalPolicy: "never", approvalsReviewer: "user", sandboxMode: "danger-full-access", sandboxType: "dangerFullAccess",
			sandboxPolicy: map[string]any{"type": "dangerFullAccess"},
		}, true
	default:
		return policySettings{}, false
	}
}

func validPolicyResponse(response threadResponse, policy policySettings) bool {
	return response.ApprovalPolicy == policy.approvalPolicy && response.ApprovalsReviewer == policy.approvalsReviewer && response.Sandbox.Type == policy.sandboxType
}

func readThread(ctx context.Context, connection *client, id string, turns bool) (providerThread, error) {
	if !validProviderID(id) {
		return providerThread{}, errors.New("invalid-provider-session")
	}
	var response threadResponse
	if err := connection.call(ctx, "thread/read", map[string]any{"threadId": id, "includeTurns": turns}, &response); err != nil {
		return providerThread{}, errors.New("codex-read-failed")
	}
	if response.Thread.ID != id {
		return providerThread{}, errors.New("codex-protocol-incompatible")
	}
	return response.Thread, nil
}

func validProviderID(id string) bool {
	if id == "" || len(id) > maxProviderID {
		return false
	}
	return !strings.ContainsAny(id, "\x00\r\n\t")
}

func historyEntries(entries []providerHistoryEntry) ([]protocol.HostHarnessSessionHistoryItem, error) {
	items := make([]protocol.HostHarnessSessionHistoryItem, 0, len(entries))
	for _, entry := range entries {
		if !validProviderID(entry.TurnID) {
			return nil, errors.New("codex-protocol-incompatible")
		}
		var header struct{ Type, ID string }
		if json.Unmarshal(entry.Item, &header) != nil || !validProviderID(header.ID) {
			return nil, errors.New("codex-protocol-incompatible")
		}
		var kind, text string
		switch header.Type {
		case "agentMessage":
			var item struct {
				Text string `json:"text"`
			}
			if json.Unmarshal(entry.Item, &item) != nil {
				return nil, errors.New("codex-protocol-incompatible")
			}
			kind, text = "assistant", item.Text
		case "userMessage":
			var item struct {
				Content []struct{ Type, Text string } `json:"content"`
			}
			if json.Unmarshal(entry.Item, &item) != nil {
				return nil, errors.New("codex-protocol-incompatible")
			}
			parts := []string{}
			for _, part := range item.Content {
				if part.Type == "text" {
					parts = append(parts, part.Text)
				}
			}
			kind, text = "user", strings.Join(parts, "\n")
		case "reasoning":
			var item struct {
				Summary []string `json:"summary"`
			}
			if json.Unmarshal(entry.Item, &item) != nil {
				return nil, errors.New("codex-protocol-incompatible")
			}
			kind, text = "summary", strings.Join(item.Summary, "\n")
		case "plan":
			var item struct {
				Text string `json:"text"`
			}
			if json.Unmarshal(entry.Item, &item) != nil {
				return nil, errors.New("codex-protocol-incompatible")
			}
			kind, text = "summary", item.Text
		case "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabToolCall", "webSearch", "imageView", "functionCallOutput", "enteredReviewMode", "exitedReviewMode", "contextCompaction":
			kind, text = "summary", "Codex recorded a "+header.Type+" item"
		default:
			return nil, errors.New("codex-protocol-incompatible")
		}
		truncated := len(text) > 16384
		items = append(items, protocol.HostHarnessSessionHistoryItem{ID: header.ID, Kind: kind, Text: bounded(text, 16384), ProviderTurnID: entry.TurnID, Truncated: truncated})
	}
	return items, nil
}

func fromRequest(request hostsession.SessionRequest) hostsession.DriverSession {
	return hostsession.DriverSession{ProviderSessionID: request.ProviderSessionID, Workspace: request.Workspace, Source: request.Source, Status: request.Status, ControlMode: request.ControlMode, Operations: slices.Clone(request.Operations), ProviderTurnID: request.ProviderTurnID, Summary: request.Summary}
}

func approvalDecision(decision *protocol.ApprovalDecision) string {
	if decision == nil {
		return ""
	}
	if decision.Status == "cancelled" || decision.Status == "expired" {
		return "cancel"
	}
	if decision.Status == "approved" {
		switch decision.SelectedOptionID {
		case "allow-once":
			return "accept"
		case "allow-always":
			return "acceptForSession"
		}
	}
	if decision.Status == "rejected" {
		switch decision.SelectedOptionID {
		case "reject-once":
			return "decline"
		}
	}
	return ""
}

func providerSummary(thread providerThread) string {
	summary := thread.Preview
	if thread.Name != nil && *thread.Name != "" {
		summary = *thread.Name
	}
	return bounded(summary, maxSummaryBytes)
}

var _ hostsession.Driver = (*Driver)(nil)
