package controlplane

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/config"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/harness"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/mcpserver"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/workspace"
	"nhooyr.io/websocket"
)

type Client struct {
	config                config.Config
	node                  protocol.ComputeNode
	runner                *harness.Runner
	bridge                *mcpserver.Server
	buildCapabilityReport func(context.Context) protocol.NodeCapabilityReport
	workspaces            *workspace.Manager
	// leaseConfirmationTimeout bounds how long a leased run waits for the hub to confirm its
	// active lease; zero means defaultLeaseConfirmationTimeout.
	leaseConfirmationTimeout time.Duration
	confirmationsMu          sync.Mutex
	confirmations            map[string]*leaseConfirmation

	connectionMu     sync.Mutex
	connection       *websocket.Conn
	outbox           [][]byte
	outboxEvents     int
	outboxEventBytes int
	sessionsMu       sync.Mutex
	sessions         map[string]*runSession
	runsMu           sync.Mutex
	runs             map[string]context.CancelFunc
	cancelled        map[string]struct{}
	residents        residentSupervisor
	pendingMu        sync.Mutex
	pending          map[string]chan rpcResult
	requestID        atomic.Uint64
}

type rpcResult struct {
	result json.RawMessage
	err    error
}

func NewClient(cfg config.Config, node protocol.ComputeNode, runner *harness.Runner, buildCapabilityReport func(context.Context) protocol.NodeCapabilityReport) *Client {
	git, err := workspace.FindGit()
	if err != nil {
		git = nil
	}
	client := &Client{
		config: cfg, node: node, runner: runner, buildCapabilityReport: buildCapabilityReport,
		workspaces: workspace.NewManager(cfg.WorkspaceRoots, git),
		runs:       map[string]context.CancelFunc{}, cancelled: map[string]struct{}{}, pending: map[string]chan rpcResult{},
		sessions: map[string]*runSession{}, residents: newResidentSupervisor(cfg.InstanceCapacity),
	}
	// The registered node advertises independent run and resident-instance capacities, and its
	// resident count is refreshed from the supervisor on every registration and heartbeat.
	instanceCapacity := cfg.InstanceCapacity
	activeInstances := 0
	client.node.InstanceCapacity = &instanceCapacity
	client.node.ActiveInstances = &activeInstances
	client.bridge = mcpserver.New(client.callHub, client.uploadArtifact)
	return client
}

func (client *Client) Run(ctx context.Context) error {
	if err := client.bridge.Start(ctx); err != nil {
		return err
	}
	backoff := time.Second
	for {
		connected, err := client.runOnce(ctx)
		if err != nil && ctx.Err() == nil {
			log.Printf("control-plane session ended: %v", err)
		}
		if connected {
			backoff = time.Second
		}
		if ctx.Err() != nil {
			client.cancelRuns()
			return ctx.Err()
		}
		delay := backoff + time.Duration(rand.IntN(500))*time.Millisecond
		log.Printf("reconnecting in %s", delay.Round(time.Millisecond))
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			client.cancelRuns()
			return ctx.Err()
		}
		backoff *= 2
		if backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
	}
}

func (client *Client) runOnce(ctx context.Context) (bool, error) {
	headers := http.Header{}
	if client.config.Token != "" {
		headers.Set("Authorization", "Bearer "+client.config.Token)
	}
	dialContext, cancelDial := context.WithTimeout(ctx, 15*time.Second)
	connection, _, err := websocket.Dial(dialContext, client.config.ControlEndpoint, &websocket.DialOptions{HTTPHeader: headers})
	cancelDial()
	if err != nil {
		return false, fmt.Errorf("connect to %s: %w", client.config.ControlEndpoint, err)
	}
	connection.SetReadLimit(2 * 1024 * 1024)
	registrationContext, cancelRegistration := context.WithTimeout(ctx, 10*time.Second)
	err = client.attach(registrationContext, connection)
	cancelRegistration()
	if err != nil {
		connection.Close(websocket.StatusInternalError, "registration failed")
		return false, err
	}
	defer client.detach(connection)
	defer connection.Close(websocket.StatusNormalClosure, "session ended")
	log.Printf("Barista %q connected to %s", client.node.Name, client.config.ControlEndpoint)

	heartbeatCtx, cancelHeartbeat := context.WithCancel(ctx)
	defer cancelHeartbeat()
	go client.heartbeat(heartbeatCtx)
	go client.capabilityReportLoop(heartbeatCtx)

	// Sent through client.send so a disconnected connection queues the report in the outbox and
	// replays it on the next successful attach, giving resend-after-reconnect for free.
	capabilityReport := client.buildCapabilityReport(ctx)
	client.send(protocol.Outbound{Type: "capability.report", Report: &capabilityReport})

	for {
		_, data, err := connection.Read(ctx)
		if err != nil {
			return true, err
		}
		message, err := protocol.DecodeInbound(data)
		if err != nil {
			// The legacy decoder refuses every v5 instance message rather than reinterpreting it;
			// only the v5 decoder may accept one, and it re-validates the whole payload.
			instanceMessage, instanceErr := protocol.DecodeInstanceHubMessage(data, protocol.Version)
			if instanceErr != nil {
				log.Printf("ignore invalid control-plane message: %v", err)
				continue
			}
			client.handleInstanceMessage(ctx, instanceMessage)
			continue
		}
		if message.Type == "hub.rpc.response" {
			client.resolveRPC(message)
			continue
		}
		client.handle(ctx, message)
	}
}

func (client *Client) attach(ctx context.Context, connection *websocket.Conn) error {
	client.connectionMu.Lock()
	defer client.connectionMu.Unlock()
	client.connection = connection
	registrationNode := client.node
	registrationNode.ActiveRuns = client.activeRuns()
	activeInstances := client.activeInstanceCount()
	registrationNode.ActiveInstances = &activeInstances
	registrationNode.LastSeen = now()
	registration := protocol.Outbound{Type: "register", ProtocolVersion: protocol.Version, Node: &registrationNode}
	if err := write(ctx, connection, registration); err != nil {
		client.connection = nil
		return err
	}
	if err := awaitRegistrationAcknowledgement(ctx, connection); err != nil {
		client.connection = nil
		return err
	}
	for len(client.outbox) > 0 {
		if err := writeBytes(ctx, connection, client.outbox[0]); err != nil {
			client.connection = nil
			return err
		}
		client.outbox = client.outbox[1:]
	}
	client.outboxEvents, client.outboxEventBytes = 0, 0
	activeRunIDs := client.activeRunIDs()
	// activeInstanceIds is always present on sync.complete — an explicitly empty array is the
	// authoritative statement that no resident survived the reconnect, distinct from an absent
	// field, which the hub must not read as evidence.
	activeInstanceIDs := client.activeInstanceIDs()
	return write(ctx, connection, protocol.Outbound{Type: "sync.complete", NodeID: client.node.ID, ActiveRunIDs: &activeRunIDs, ActiveInstanceIDs: &activeInstanceIDs, At: now()})
}

// awaitRegistrationAcknowledgement waits for the hub's first message, a ping, which it sends only
// after admitting the registration. The hub refuses a registration while another connection for
// the same node is live, so waiting keeps the lifecycle outbox from being written to, and lost on,
// a refused socket; the outbox is replayed on the next accepted connection instead.
func awaitRegistrationAcknowledgement(ctx context.Context, connection *websocket.Conn) error {
	_, data, err := connection.Read(ctx)
	if err != nil {
		return fmt.Errorf("registration was not acknowledged: %w", err)
	}
	message, err := protocol.DecodeInbound(data)
	if err != nil || message.Type != "ping" {
		return errors.New("registration was not acknowledged")
	}
	return nil
}

func (client *Client) detach(connection *websocket.Conn) {
	client.connectionMu.Lock()
	defer client.connectionMu.Unlock()
	if client.connection == connection {
		client.connection = nil
		client.failPending(&mcpserver.ToolError{Code: "hub_unavailable", Message: "The control plane disconnected; retry with the same idempotency key", Retryable: true})
	}
}

func (client *Client) send(message any) {
	data, err := json.Marshal(message)
	if err != nil {
		log.Printf("encode outbound message: %v", err)
		return
	}
	client.connectionMu.Lock()
	defer client.connectionMu.Unlock()
	if client.connection == nil {
		client.outbox = append(client.outbox, data)
		return
	}
	writeContext, cancel := context.WithTimeout(context.Background(), writeTimeout)
	defer cancel()
	if err := writeBytes(writeContext, client.connection, data); err != nil {
		client.outbox = append(client.outbox, data)
		client.connection = nil
	}
}

func (client *Client) heartbeat(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			client.send(client.heartbeatMessage())
		case <-ctx.Done():
			return
		}
	}
}

func (client *Client) capabilityReportLoop(ctx context.Context) {
	ticker := time.NewTicker(15 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			report := client.buildCapabilityReport(ctx)
			client.send(protocol.Outbound{Type: "capability.report", Report: &report})
		case <-ctx.Done():
			return
		}
	}
}

func (client *Client) handle(ctx context.Context, message protocol.Inbound) {
	switch message.Type {
	case "ping":
		client.send(client.heartbeatMessage())
	case "cancel":
		client.runsMu.Lock()
		client.cancelled[message.RunID] = struct{}{}
		cancel := client.runs[message.RunID]
		client.runsMu.Unlock()
		if cancel != nil {
			cancel()
		} else {
			client.send(protocol.Outbound{Type: "run.cancelled", RunID: message.RunID, At: now()})
		}
	case "dispatch":
		client.dispatch(ctx, message.Run, message.Agent, message.Execution)
	case "approval.decision":
		client.applyApprovalDecision(message.Decision)
	case "workspace.lease.confirmed":
		client.confirmLease(message.RunID, message.LeaseID, message.Status)
	case "workspace.cleanup":
		go client.cleanupLease(ctx, message.RunID, message.Lease, message.Mode)
	default:
		log.Printf("ignore unknown control-plane message type %q", message.Type)
	}
}

// admitTransport is the capability check the dispatch guard uses for a harness transport. It must
// not start anything; see harness.Runner.Admit.
type admitTransport func(harnessID, transport, fallbackTransport string) error

// admitResume is the capability check the dispatch guard uses for a session resume. It must not
// start anything; see harness.Runner.AdmitResume.
type admitResume func(harnessID string) error

// unsupportedExecutionReason reports why a version-4 dispatch cannot be honored by this Barista,
// or "" when it is fully supported. Anything Barista cannot honor exactly is rejected here, before
// any process starts, rather than silently degraded to plain native execution, which is what
// registering control protocol version 4 must never allow (see docs/architecture.md's
// compatibility policy). The version-4 run itself, not only the optional execution object, can
// carry these fields (protocol.Run.Transport/SessionBindingID/WorkspaceLeaseID), so both are
// checked and must agree: a hub could send run.transport="acp-v1" with no execution object at all.
//
// acp-v1 is accepted only when admit confirms that a verified adapter is available for the
// harness, or that the dispatch and the operator both permit native fallback and the native CLI is
// installed; a nil admit accepts no ACP run.
//
// A session binding to resume is accepted only for an acp-v1 run whose run-level binding identity
// equals the execution's, whose binding is well formed, and whose adapter negotiated session
// resume or load in its startup probe (resume confirms this); a nil resume accepts none. Anything
// else is rejected rather than silently started as a new session.
//
// The final check is lease acceptance: a run naming a lease must arrive with exactly that lease's
// grant, the grant must be well formed, name the run's own cwd (and, for a worktree, its task),
// and use a policy this Barista's workspace manager can provision; a nil manager accepts no lease.
func unsupportedExecutionReason(run protocol.Run, execution *protocol.DispatchExecution, admit admitTransport, resume admitResume, workspaces *workspace.Manager) string {
	transport := run.Transport
	fallbackTransport := ""
	if execution != nil {
		if transport != "" && execution.Transport != "" && transport != execution.Transport {
			return "unsupported execution: the run and its execution name different transports"
		}
		if transport == "" {
			transport = execution.Transport
		}
		fallbackTransport = execution.FallbackTransport
	}
	switch transport {
	case "", protocol.TransportNativeCLI:
		if fallbackTransport != "" {
			return "unsupported execution: a fallback transport is only meaningful for an acp-v1 run"
		}
	case protocol.TransportACP:
		if fallbackTransport != "" && fallbackTransport != protocol.TransportNativeCLI {
			return "unsupported execution: acp-v1 may only fall back to native-cli"
		}
		if admit == nil || admit(run.HarnessID, transport, fallbackTransport) != nil {
			return "unsupported execution: acp-v1 transport not available on this Barista"
		}
	default:
		return "unsupported execution: unknown transport not available on this Barista"
	}
	var binding *protocol.DispatchSessionBinding
	if execution != nil {
		binding = execution.SessionBinding
	}
	if run.SessionBindingID != "" || binding != nil {
		if binding == nil || binding.ID != run.SessionBindingID {
			return "unsupported execution: the run's session binding is missing or names a different binding"
		}
		if transport != protocol.TransportACP {
			return "unsupported execution: only an acp-v1 run can resume a session"
		}
		if err := binding.Validate(); err != nil {
			return "unsupported execution: the session binding is malformed"
		}
		if resume == nil || resume(run.HarnessID) != nil {
			return protocol.SessionResumeUnavailableReason
		}
	}
	var lease *protocol.WorkspaceLeaseGrant
	if execution != nil {
		lease = execution.WorkspaceLease
	}
	if run.WorkspaceLeaseID != "" && (lease == nil || lease.ID != run.WorkspaceLeaseID) {
		return "unsupported execution: the run's workspace lease grant is missing or names a different lease"
	}
	if lease == nil {
		return ""
	}
	if lease.ID != run.WorkspaceLeaseID {
		return "unsupported execution: the workspace lease grant does not belong to the run"
	}
	if err := lease.Validate(); err != nil {
		return "unsupported execution: the workspace lease grant is malformed"
	}
	if workspaces == nil || !workspaces.Supports(lease.Policy) {
		return fmt.Sprintf("unsupported execution: %s workspace leases are not available on this Barista", lease.Policy)
	}
	if run.Workspace != lease.WorktreePath {
		return "unsupported execution: the run workspace is not its lease's isolated cwd"
	}
	if lease.Policy == protocol.WorkspaceIsolationGitWorktree && (execution.TaskID == "" || execution.TaskID != run.TaskID) {
		return "unsupported execution: a worktree lease requires the run's task identity"
	}
	return ""
}

func (client *Client) admitTransport() admitTransport {
	if client.runner == nil {
		return nil
	}
	return client.runner.Admit
}

func (client *Client) admitResume() admitResume {
	if client.runner == nil {
		return nil
	}
	return client.runner.AdmitResume
}

func (client *Client) dispatch(ctx context.Context, run protocol.Run, agent protocol.Agent, execution *protocol.DispatchExecution) {
	client.dispatchRun(ctx, run, agent, execution, "")
}

// dispatchRun admits and executes one dispatch. A non-empty allocationID also binds the run to
// that resident allocation: admission validates the resident and registers the run membership
// under the resident lock in the same critical section that registers the run, so a concurrent
// release either sees this run and waits for it, or has already closed the resident and this
// dispatch fails. The resident lock is always taken before runsMu and never the reverse.
func (client *Client) dispatchRun(ctx context.Context, run protocol.Run, agent protocol.Agent, execution *protocol.DispatchExecution, allocationID string) {
	// The guard may re-verify an adapter executable's digest, so it runs before taking any lock;
	// its verdict is applied in the same place as before, after the tombstone and duplicate
	// checks.
	rejection := unsupportedExecutionReason(run, execution, client.admitTransport(), client.admitResume(), client.workspaces)
	client.residents.mu.Lock()
	if allocationID != "" {
		if reason := client.residents.admitRunLocked(allocationID, run); reason != "" {
			client.residents.mu.Unlock()
			client.send(protocol.Outbound{Type: "run.failed", RunID: run.ID, Error: reason, At: now()})
			return
		}
	}
	client.runsMu.Lock()
	if _, cancelled := client.cancelled[run.ID]; cancelled {
		client.runsMu.Unlock()
		client.residents.mu.Unlock()
		return
	}
	if _, exists := client.runs[run.ID]; exists {
		client.runsMu.Unlock()
		client.residents.mu.Unlock()
		return
	}
	if rejection != "" {
		client.runsMu.Unlock()
		client.residents.mu.Unlock()
		client.send(protocol.Outbound{Type: "run.failed", RunID: run.ID, Error: rejection, At: now()})
		return
	}
	if len(client.runs) >= client.config.Concurrency {
		client.runsMu.Unlock()
		client.residents.mu.Unlock()
		client.send(protocol.Outbound{Type: "run.failed", RunID: run.ID, Error: fmt.Sprintf("Barista concurrency limit (%d) reached", client.config.Concurrency), At: now()})
		return
	}
	runContext, cancel := context.WithCancel(ctx)
	client.runs[run.ID] = cancel
	if allocationID != "" {
		client.residents.residentsTable[allocationID].runs[run.ID] = struct{}{}
	}
	client.runsMu.Unlock()
	client.residents.mu.Unlock()

	fallbackTransport := ""
	if execution != nil {
		if run.Transport == "" {
			run.Transport = execution.Transport
		}
		fallbackTransport = execution.FallbackTransport
	}

	go func() {
		defer func() {
			client.runsMu.Lock()
			delete(client.runs, run.ID)
			_, cancelled := client.cancelled[run.ID]
			client.runsMu.Unlock()
			cancel()
			if allocationID != "" {
				client.finishResidentRun(allocationID, run.ID)
			}
			if cancelled {
				client.send(protocol.Outbound{Type: "run.cancelled", RunID: run.ID, At: now()})
			}
		}()
		var workspacePath string
		if execution != nil && execution.WorkspaceLease != nil {
			path, finish, ok := client.provisionLease(runContext, run, *execution)
			if !ok {
				return
			}
			defer finish()
			workspacePath = path
		} else {
			authorized, err := harness.AuthorizeWorkspace(run.Workspace, client.config.WorkspaceRoots)
			if err != nil {
				client.send(protocol.Outbound{Type: "run.failed", RunID: run.ID, Error: err.Error(), At: now()})
				return
			}
			workspacePath = authorized
		}
		if runContext.Err() != nil {
			return
		}
		capability, err := client.bridge.Grant(run.ID, workspacePath, agent.CanDelegate)
		if err != nil {
			client.send(protocol.Outbound{Type: "run.failed", RunID: run.ID, Error: err.Error(), At: now()})
			return
		}
		defer client.bridge.Revoke(capability.Token)
		session := client.openSession(run.ID)
		defer client.closeSession(session)
		if allocationID != "" {
			// The run's own completion closes its session; this closer is the resident's defensive
			// backstop that a release invokes if a session outlived its run.
			client.registerResidentCleanup(allocationID, run.ID, func() error {
				if open := client.session(run.ID); open != nil {
					client.closeSession(open)
				}
				return nil
			})
		}
		// run.started is sent only when the driver is about to hand the harness its prompt, after
		// transport selection and, for ACP, after the adapter connected to the Coffee Shop MCP
		// server; it carries that selection. Events produced before then are held by the session.
		invocation := harness.Invocation{Run: run, Agent: agent, Workspace: workspacePath, MCP: capability, FallbackTransport: fallbackTransport, Output: func(chunk string) {
			if runContext.Err() != nil {
				return
			}
			client.send(protocol.Outbound{Type: "run.output", RunID: run.ID, Chunk: chunk, At: now()})
		}, ProviderSession: func(identity string) {
			if runContext.Err() != nil {
				return
			}
			client.send(protocol.Outbound{Type: "run.output", RunID: run.ID, ProviderSessionID: identity, At: now()})
		}, Started: func(selection protocol.RunTransportSelection) {
			session.start(selection)
		}}
		if protocol.SupportsCapability(protocol.Version, protocol.CapabilityOrchestration) {
			invocation.Events = func(event protocol.HarnessEvent) {
				if runContext.Err() == nil {
					session.forward(event)
				}
			}
			invocation.Permission = session.permission
			var bindingID string
			if execution != nil && execution.SessionBinding != nil {
				bindingID = execution.SessionBinding.ID
				invocation.Resume = &harness.SessionResume{ProviderSessionID: execution.SessionBinding.ProviderSessionID, Prompt: execution.SessionBinding.ResumePrompt}
			}
			invocation.Session = func(established harness.EstablishedSession) {
				client.reportSession(run, bindingID, established)
			}
		}
		result, err := client.runner.Execute(runContext, invocation)
		if err != nil {
			if errors.Is(runContext.Err(), context.Canceled) {
				return
			}
			client.send(protocol.Outbound{Type: "run.failed", RunID: run.ID, Error: err.Error(), At: now()})
			return
		}
		if runContext.Err() == nil {
			client.send(protocol.Outbound{Type: "run.completed", RunID: run.ID, Output: result, At: now()})
		}
	}()
}

// reportSession tells the hub which provider session the run's prompt is about to reach. It names
// the dispatch's binding only when that session actually resumed; a new session carries no binding
// identity, so the hub records it as a replacement.
func (client *Client) reportSession(run protocol.Run, bindingID string, established harness.EstablishedSession) {
	update := protocol.SessionBindingUpdate{ProviderSessionID: established.ProviderSessionID, HarnessID: run.HarnessID, Transport: protocol.TransportACP, Status: "active"}
	if established.Resumed {
		update.BindingID = bindingID
	}
	message := protocol.NewSessionBindingMessage(run.ID, update, now())
	if err := message.Validate(); err != nil {
		log.Printf("omit invalid session.binding for run %s: %v", run.ID, err)
		return
	}
	client.send(message)
}

func (client *Client) callHub(ctx context.Context, runID, operation string, arguments json.RawMessage) (json.RawMessage, error) {
	requestID := fmt.Sprintf("rpc-%d", client.requestID.Add(1))
	response := make(chan rpcResult, 1)
	client.pendingMu.Lock()
	client.pending[requestID] = response
	client.pendingMu.Unlock()
	defer func() {
		client.pendingMu.Lock()
		delete(client.pending, requestID)
		client.pendingMu.Unlock()
	}()

	message := protocol.Outbound{Type: "hub.rpc.request", RequestID: requestID, RunID: runID, Operation: operation, Arguments: arguments, At: now()}
	data, err := json.Marshal(message)
	if err != nil {
		return nil, err
	}
	client.connectionMu.Lock()
	connection := client.connection
	if connection == nil {
		client.connectionMu.Unlock()
		return nil, &mcpserver.ToolError{Code: "hub_unavailable", Message: "The control plane is unavailable; retry with the same idempotency key", Retryable: true}
	}
	writeContext, cancel := context.WithTimeout(ctx, 10*time.Second)
	err = writeBytes(writeContext, connection, data)
	cancel()
	client.connectionMu.Unlock()
	if err != nil {
		return nil, &mcpserver.ToolError{Code: "hub_unavailable", Message: "The hub tool request could not be sent; retry with the same idempotency key", Retryable: true}
	}
	timer := time.NewTimer(hubRequestTimeout)
	defer timer.Stop()
	select {
	case received := <-response:
		return received.result, received.err
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timer.C:
		return nil, &mcpserver.ToolError{Code: "hub_timeout", Message: "The hub tool request timed out; retry with the same idempotency key", Retryable: true}
	}
}

func (client *Client) resolveRPC(message protocol.Inbound) {
	client.pendingMu.Lock()
	response := client.pending[message.RequestID]
	delete(client.pending, message.RequestID)
	client.pendingMu.Unlock()
	if response == nil {
		return
	}
	if message.RPCError != nil {
		response <- rpcResult{err: &mcpserver.ToolError{Code: message.RPCError.Code, Message: message.RPCError.Message, Retryable: message.RPCError.Retryable}}
		return
	}
	response <- rpcResult{result: message.Result}
}

func (client *Client) failPending(err error) {
	client.pendingMu.Lock()
	pending := client.pending
	client.pending = map[string]chan rpcResult{}
	client.pendingMu.Unlock()
	for _, response := range pending {
		response <- rpcResult{err: err}
	}
}

func (client *Client) uploadArtifact(ctx context.Context, uploadPath string, content io.Reader, size int64) error {
	endpoint, err := httpEndpoint(client.config.ControlEndpoint, uploadPath)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint, content)
	if err != nil {
		return err
	}
	request.ContentLength = size
	request.Header.Set("Content-Type", "application/octet-stream")
	if client.config.Token != "" {
		request.Header.Set("Authorization", "Bearer "+client.config.Token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4*1024))
		return fmt.Errorf("hub returned %s: %s", response.Status, strings.TrimSpace(string(body)))
	}
	return nil
}

func httpEndpoint(controlEndpoint, path string) (string, error) {
	parsed, err := url.Parse(controlEndpoint)
	if err != nil {
		return "", err
	}
	switch parsed.Scheme {
	case "ws":
		parsed.Scheme = "http"
	case "wss":
		parsed.Scheme = "https"
	default:
		return "", errors.New("control endpoint must use ws or wss")
	}
	parsed.Path = path
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

// heartbeatMessage reports the node's live run and resident counts plus the resident identities
// themselves; the count and the list are independent evidence, not one derived from the other. The
// identity list makes every heartbeat a current residency snapshot, so the hub never has to
// reconstruct it from lifecycle events.
func (client *Client) heartbeatMessage() protocol.Outbound {
	activeInstances := client.activeInstanceCount()
	activeInstanceIDs := client.activeInstanceIDs()
	activeRuns := client.activeRuns()
	return protocol.Outbound{Type: "heartbeat", NodeID: client.node.ID, ActiveRuns: &activeRuns, ActiveInstances: &activeInstances, ActiveInstanceIDs: &activeInstanceIDs, At: now()}
}

func (client *Client) activeRuns() int {
	client.runsMu.Lock()
	defer client.runsMu.Unlock()
	return len(client.runs)
}

func (client *Client) activeRunIDs() []string {
	client.runsMu.Lock()
	defer client.runsMu.Unlock()
	ids := make([]string, 0, len(client.runs))
	for id := range client.runs {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func (client *Client) cancelRuns() {
	client.runsMu.Lock()
	defer client.runsMu.Unlock()
	for _, cancel := range client.runs {
		cancel()
	}
}

func write(ctx context.Context, connection *websocket.Conn, message protocol.Outbound) error {
	data, err := json.Marshal(message)
	if err != nil {
		return err
	}
	return writeBytes(ctx, connection, data)
}

func writeBytes(ctx context.Context, connection *websocket.Conn, data []byte) error {
	return connection.Write(ctx, websocket.MessageText, data)
}

const writeTimeout = 10 * time.Second

// hubRequestTimeout bounds one correlated hub RPC. It exceeds the longest wait_for_task_events
// long-poll, protocol.MaximumWaitMilliseconds, so a wait always answers before Barista gives up.
const hubRequestTimeout = 30 * time.Second

func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }
