package hostsession

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (clock *fakeClock) Now() time.Time {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	clock.now = clock.now.Add(time.Second)
	return clock.now
}

type fakeIDs struct {
	mu   sync.Mutex
	next int
}

func (ids *fakeIDs) NewID() (string, error) {
	ids.mu.Lock()
	defer ids.mu.Unlock()
	ids.next++
	return "host-session-" + string(rune('0'+ids.next)), nil
}

type fakeDriver struct {
	mu            sync.Mutex
	calls         []string
	sessions      map[string]ProviderSession
	entered       chan string
	release       chan struct{}
	capabilities  Capabilities
	created       int
	summary       string
	history       HistoryPage
	observe       func(OperationHandle, ProviderSession, []protocol.HarnessEvent) error
	lastHandle    OperationHandle
	failures      map[string]error
	outcomeEvents []protocol.HarnessEvent
	discovered    []ProviderSession
	reconcileFn   func(ReconcileRequest) (ReconcileResult, error)
	startStatus   string
	closeStatus   string
}

func newFakeDriver() *fakeDriver {
	return &fakeDriver{
		sessions: map[string]ProviderSession{},
		capabilities: Capabilities{
			DriverOperations:    []string{"adopt", "create", "discover"},
			SessionOperations:   []string{"attach", "close", "detach", "interrupt", "read-history", "resolve-approval", "start-turn", "steer"},
			LifecycleOperations: []string{"inspect", "reconcile", "refresh", "resume"},
		},
		failures: map[string]error{},
	}
}

func (driver *fakeDriver) HarnessID() string          { return "codex-cli" }
func (driver *fakeDriver) Capabilities() Capabilities { return driver.capabilities }
func (driver *fakeDriver) record(operation string) {
	driver.mu.Lock()
	driver.calls = append(driver.calls, operation)
	driver.mu.Unlock()
	if driver.entered != nil {
		driver.entered <- operation
		<-driver.release
	}
}
func (driver *fakeDriver) count(operation string) int {
	driver.mu.Lock()
	defer driver.mu.Unlock()
	count := 0
	for _, call := range driver.calls {
		if call == operation {
			count++
		}
	}
	return count
}
func (driver *fakeDriver) Discover(context.Context, DiscoverRequest) ([]ProviderSession, error) {
	driver.record("discover")
	driver.mu.Lock()
	defer driver.mu.Unlock()
	if driver.discovered != nil {
		return append([]ProviderSession(nil), driver.discovered...), driver.failures["discover"]
	}
	result := make([]ProviderSession, 0, len(driver.sessions))
	for _, session := range driver.sessions {
		result = append(result, session)
	}
	return result, driver.failures["discover"]
}
func (driver *fakeDriver) Inspect(_ context.Context, request SessionRequest) (ProviderSession, error) {
	driver.record("inspect")
	if err := driver.failure("inspect"); err != nil {
		return ProviderSession{}, err
	}
	session := driver.session(request)
	if session.ProviderSessionID == "" {
		session = providerSession(request.ProviderSessionID, request.Workspace, "provider-history")
	}
	return session, nil
}
func (driver *fakeDriver) Adopt(_ context.Context, request AdoptRequest) (ProviderSession, error) {
	driver.record("adopt")
	if err := driver.failure("adopt"); err != nil {
		return ProviderSession{}, err
	}
	session := providerSession(request.ProviderSessionID, request.Workspace, "provider-history")
	driver.mu.Lock()
	driver.sessions[session.ProviderSessionID] = session
	driver.mu.Unlock()
	return session, nil
}
func (driver *fakeDriver) Create(_ context.Context, request CreateRequest) (ProviderSession, error) {
	driver.record("create")
	if err := driver.failure("create"); err != nil {
		return ProviderSession{}, err
	}
	driver.mu.Lock()
	driver.created++
	session := providerSession("provider-created-"+string(rune('0'+driver.created)), request.Workspace, "coffee-shop-managed")
	session.Summary = driver.summary
	driver.sessions[session.ProviderSessionID] = session
	driver.mu.Unlock()
	return session, nil
}
func (driver *fakeDriver) Resume(_ context.Context, request SessionRequest) (ProviderSession, error) {
	driver.record("resume")
	if err := driver.failure("resume"); err != nil {
		return ProviderSession{}, err
	}
	return driver.session(request), nil
}
func (driver *fakeDriver) ReadHistory(context.Context, HistoryRequest) (HistoryPage, error) {
	driver.record("read-history")
	if err := driver.failure("read-history"); err != nil {
		return HistoryPage{}, err
	}
	if driver.history.Items != nil {
		return driver.history, nil
	}
	return HistoryPage{Items: []protocol.HostHarnessSessionHistoryItem{{ID: "history-1", Kind: "summary", Text: "bounded", Truncated: false}}}, nil
}
func (driver *fakeDriver) StartTurn(_ context.Context, request TurnRequest) (DriverOutcome, error) {
	driver.record("start-turn")
	if err := driver.failure("start-turn"); err != nil {
		return DriverOutcome{}, err
	}
	session := driver.session(request.SessionRequest)
	driver.mu.Lock()
	driver.lastHandle = request.Handle
	driver.mu.Unlock()
	if driver.observe != nil {
		callback := session
		callback.Status = "running"
		callback.ProviderTurnID = request.RunID + "-turn"
		if err := driver.observe(request.Handle, callback, nil); err != nil {
			return DriverOutcome{}, err
		}
	}
	session.Status = driver.startStatus
	if session.Status == "" {
		session.Status = "idle"
	}
	session.ProviderTurnID = request.RunID + "-turn"
	driver.store(session)
	return DriverOutcome{Session: session, ProviderTurnID: session.ProviderTurnID, Events: append([]protocol.HarnessEvent(nil), driver.outcomeEvents...)}, nil
}
func (driver *fakeDriver) Steer(_ context.Context, request SteerRequest) (DriverOutcome, error) {
	driver.record("steer")
	if err := driver.failure("steer"); err != nil {
		return DriverOutcome{}, err
	}
	return DriverOutcome{Session: driver.session(request.SessionRequest), ProviderTurnID: request.ProviderTurnID}, nil
}
func (driver *fakeDriver) Interrupt(_ context.Context, request TurnControlRequest) (DriverOutcome, error) {
	driver.record("interrupt")
	if err := driver.failure("interrupt"); err != nil {
		return DriverOutcome{}, err
	}
	session := driver.session(request.SessionRequest)
	session.Status = "idle"
	driver.store(session)
	return DriverOutcome{Session: session, ProviderTurnID: request.ProviderTurnID}, nil
}
func (driver *fakeDriver) DecideApproval(_ context.Context, request ApprovalRequest) (DriverOutcome, error) {
	driver.record("resolve-approval")
	if err := driver.failure("resolve-approval"); err != nil {
		return DriverOutcome{}, err
	}
	session := driver.session(request.SessionRequest)
	session.Status = "running"
	driver.store(session)
	return DriverOutcome{Session: session, ProviderTurnID: request.ProviderTurnID}, nil
}
func (driver *fakeDriver) Refresh(_ context.Context, request SessionRequest) (ProviderSession, error) {
	driver.record("refresh")
	if err := driver.failure("refresh"); err != nil {
		return ProviderSession{}, err
	}
	return driver.session(request), nil
}
func (driver *fakeDriver) Reconcile(_ context.Context, request ReconcileRequest) (ReconcileResult, error) {
	driver.record("reconcile")
	if err := driver.failure("reconcile"); err != nil {
		return ReconcileResult{}, err
	}
	if driver.reconcileFn != nil {
		return driver.reconcileFn(request)
	}
	session := driver.session(request.SessionRequest)
	if session.ProviderSessionID == "" {
		driver.mu.Lock()
		for _, candidate := range driver.sessions {
			session = candidate
			break
		}
		driver.mu.Unlock()
	}
	return ReconcileResult{Session: session, Conclusive: request.CommandID != ""}, nil
}
func (driver *fakeDriver) Close(_ context.Context, request SessionRequest) (DriverOutcome, error) {
	driver.record("close")
	if err := driver.failure("close"); err != nil {
		return DriverOutcome{}, err
	}
	session := driver.session(request)
	session.Status = driver.closeStatus
	if session.Status == "" {
		session.Status = "closed"
	}
	driver.store(session)
	return DriverOutcome{Session: session, Events: append([]protocol.HarnessEvent(nil), driver.outcomeEvents...)}, nil
}
func (driver *fakeDriver) session(request SessionRequest) ProviderSession {
	driver.mu.Lock()
	defer driver.mu.Unlock()
	return driver.sessions[request.ProviderSessionID]
}

func (driver *fakeDriver) store(session ProviderSession) {
	driver.mu.Lock()
	driver.sessions[session.ProviderSessionID] = session
	driver.mu.Unlock()
}

func (driver *fakeDriver) failure(operation string) error {
	driver.mu.Lock()
	defer driver.mu.Unlock()
	return driver.failures[operation]
}

func providerSession(id, workspace, source string) ProviderSession {
	return ProviderSession{ProviderSessionID: id, Workspace: workspace, Source: source, Status: "idle", ControlMode: "full",
		Operations:          []string{"attach", "close", "detach", "interrupt", "read-history", "resolve-approval", "start-turn", "steer"},
		LifecycleOperations: []string{"inspect", "reconcile", "refresh", "resume"}}
}

func newTestSupervisor(t *testing.T, driver *fakeDriver) (*Supervisor, string) {
	t.Helper()
	root := t.TempDir()
	workspace := filepath.Join(root, "workspace")
	require.NoError(t, os.Mkdir(workspace, 0o700))
	supervisor, err := New(Options{NodeID: "node-1", DataRoot: filepath.Join(root, "data"), WorkspaceRoots: []string{root}, Drivers: []Driver{driver},
		Clock: &fakeClock{now: time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)}, IDs: &fakeIDs{}})
	require.NoError(t, err)
	return supervisor, workspace
}

func signed(t *testing.T, message protocol.HostSessionHubMessage) protocol.HostSessionHubMessage {
	t.Helper()
	digest, err := protocol.HostHarnessSessionCommandDigest(message)
	require.NoError(t, err)
	message.CommandDigest = digest
	return message
}

func createSession(t *testing.T, supervisor *Supervisor, workspace, commandID string) CommandResponse {
	t.Helper()
	return supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.create", NodeID: "node-1", CommandID: commandID,
		RequestID: commandID + "-request", HarnessID: "codex-cli", Workspace: workspace}))
}

func TestLifecycleReplayAndRestartRecovery(t *testing.T) {
	driver := newFakeDriver()
	supervisor, workspace := newTestSupervisor(t, driver)
	created := createSession(t, supervisor, workspace, "create-1")
	require.NoError(t, created.Err)
	require.Equal(t, "succeeded", created.Result.Outcome)
	require.Equal(t, 1, driver.count("create"))
	sessionID := created.Result.Session.HostHarnessSessionID

	replayed := createSession(t, supervisor, workspace, "create-1")
	require.NoError(t, replayed.Err)
	require.Equal(t, "replayed", replayed.Ack.Disposition)
	require.Equal(t, created.Result.Session, replayed.Result.Session)
	require.Equal(t, 1, driver.count("create"))

	changed := signed(t, protocol.HostSessionHubMessage{Type: "host-session.create", NodeID: "node-1", CommandID: "create-1", RequestID: "changed", HarnessID: "codex-cli", Workspace: workspace})
	conflict := supervisor.Execute(context.Background(), changed)
	require.ErrorIs(t, conflict.Err, ErrCommandConflict)
	require.Equal(t, 1, driver.count("create"))

	restarted, err := New(Options{NodeID: "node-1", DataRoot: supervisor.dataRoot, WorkspaceRoots: supervisor.workspaceRoots, Drivers: []Driver{driver}, Clock: supervisor.clock, IDs: &fakeIDs{next: 1}})
	require.NoError(t, err)
	recovered := restarted.Snapshot()
	require.Len(t, recovered, 1)
	require.Equal(t, sessionID, recovered[0].HostHarnessSessionID)
	replayAfterRestart := createSession(t, restarted, workspace, "create-1")
	require.Equal(t, "replayed", replayAfterRestart.Ack.Disposition)
	require.Equal(t, 1, driver.count("create"))
}

func TestAttachmentEpochWorkspaceDriftAndPerSessionSerialization(t *testing.T) {
	driver := newFakeDriver()
	supervisor, workspace := newTestSupervisor(t, driver)
	created := createSession(t, supervisor, workspace, "create-1")
	id := created.Result.Session.HostHarnessSessionID
	epoch := int64(0)
	attach := signed(t, protocol.HostSessionHubMessage{Type: "host-session.attach", NodeID: "node-1", CommandID: "attach-1", HostHarnessSessionID: id,
		AttachmentEpoch: &epoch, ThreadID: "thread-1", ExpectedStatus: "idle"})
	attached := supervisor.Execute(context.Background(), attach)
	require.NoError(t, attached.Err)
	require.Equal(t, int64(1), supervisor.Session(id).AttachmentEpoch)

	stale := signed(t, protocol.HostSessionHubMessage{Type: "host-session.turn.start", NodeID: "node-1", CommandID: "turn-stale", HostHarnessSessionID: id,
		AttachmentEpoch: &epoch, RunID: "run-stale", Prompt: "hello"})
	require.ErrorIs(t, supervisor.Execute(context.Background(), stale).Err, ErrStaleEpoch)
	require.Zero(t, driver.count("start-turn"))
	require.NotContains(t, supervisor.commands, "turn-stale")

	driver.entered = make(chan string, 2)
	driver.release = make(chan struct{})
	current := int64(1)
	first := signed(t, protocol.HostSessionHubMessage{Type: "host-session.turn.start", NodeID: "node-1", CommandID: "turn-1", HostHarnessSessionID: id,
		AttachmentEpoch: &current, RunID: "run-1", Prompt: "first"})
	done := make(chan CommandResponse, 1)
	go func() { done <- supervisor.Execute(context.Background(), first) }()
	require.Equal(t, "start-turn", <-driver.entered)
	second := signed(t, protocol.HostSessionHubMessage{Type: "host-session.turn.start", NodeID: "node-1", CommandID: "turn-2", HostHarnessSessionID: id,
		AttachmentEpoch: &current, RunID: "run-2", Prompt: "second"})
	require.ErrorIs(t, supervisor.Execute(context.Background(), second).Err, ErrSessionBusy)
	require.NotContains(t, supervisor.commands, "turn-2")
	close(driver.release)
	require.NoError(t, (<-done).Err)
	require.Equal(t, 1, driver.count("start-turn"))

	moved := filepath.Join(filepath.Dir(workspace), "moved")
	require.NoError(t, os.Rename(workspace, moved))
	linkOutside := filepath.Join(filepath.Dir(filepath.Dir(workspace)), "outside")
	require.NoError(t, os.Mkdir(linkOutside, 0o700))
	require.NoError(t, os.Symlink(linkOutside, workspace))
	refreshErr := supervisor.Refresh(context.Background(), id)
	require.Error(t, refreshErr)
	require.Equal(t, 0, driver.count("refresh"))
}

func TestIndependentSessionsProgressConcurrently(t *testing.T) {
	driver := newFakeDriver()
	supervisor, workspace := newTestSupervisor(t, driver)
	first := createSession(t, supervisor, workspace, "create-1").Result.Session.HostHarnessSessionID
	second := createSession(t, supervisor, workspace, "create-2").Result.Session.HostHarnessSessionID
	done := make(chan CommandResponse, 2)
	for index, id := range []string{first, second} {
		epoch := int64(0)
		response := supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.attach", NodeID: "node-1", CommandID: "attach-" + string(rune('1'+index)), HostHarnessSessionID: id,
			AttachmentEpoch: &epoch, ThreadID: "thread-" + string(rune('1'+index)), ExpectedStatus: "idle"}))
		require.NoError(t, response.Err)
	}
	driver.entered = make(chan string, 2)
	driver.release = make(chan struct{})
	current := int64(1)
	for index, id := range []string{first, second} {
		message := signed(t, protocol.HostSessionHubMessage{Type: "host-session.turn.start", NodeID: "node-1", CommandID: "turn-" + string(rune('1'+index)), HostHarnessSessionID: id,
			AttachmentEpoch: &current, RunID: "run-" + string(rune('1'+index)), Prompt: "hello"})
		go func() { done <- supervisor.Execute(context.Background(), message) }()
	}
	require.Equal(t, "start-turn", <-driver.entered)
	require.Equal(t, "start-turn", <-driver.entered)
	close(driver.release)
	require.NoError(t, (<-done).Err)
	require.NoError(t, (<-done).Err)
}

func TestUnsupportedOperationAndCallerCancellationDoNotDuplicateEffect(t *testing.T) {
	driver := newFakeDriver()
	driver.capabilities.DriverOperations = []string{"discover"}
	supervisor, workspace := newTestSupervisor(t, driver)
	response := createSession(t, supervisor, workspace, "create-1")
	require.ErrorIs(t, response.Err, ErrUnsupportedCapability)
	require.Zero(t, driver.count("create"))

	driver.capabilities.DriverOperations = []string{"adopt", "create", "discover"}
	driver.entered = make(chan string, 1)
	driver.release = make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan CommandResponse, 1)
	message := signed(t, protocol.HostSessionHubMessage{Type: "host-session.create", NodeID: "node-1", CommandID: "create-2", RequestID: "create-2-request", HarnessID: "codex-cli", Workspace: workspace})
	go func() { done <- supervisor.Execute(ctx, message) }()
	require.Equal(t, "create", <-driver.entered)
	cancel()
	close(driver.release)
	require.NoError(t, (<-done).Err)
	require.Equal(t, 1, driver.count("create"))
}

func TestDriverCallbackRequiresAnActiveCoreIssuedHandle(t *testing.T) {
	driver := newFakeDriver()
	supervisor, workspace := newTestSupervisor(t, driver)
	created := createSession(t, supervisor, workspace, "create-1")
	id := created.Result.Session.HostHarnessSessionID
	epoch := int64(0)
	require.NoError(t, supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.attach", NodeID: "node-1", CommandID: "attach-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, ThreadID: "thread-1", ExpectedStatus: "idle"})).Err)
	driver.observe = supervisor.AcceptObservation
	epoch = 1
	turn := supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.turn.start", NodeID: "node-1", CommandID: "turn-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, RunID: "run-1", Prompt: "hello"}))
	require.NoError(t, turn.Err)
	driver.mu.Lock()
	late := driver.lastHandle
	provider := driver.sessions[turn.Result.Session.ProviderSessionID]
	driver.mu.Unlock()
	require.ErrorIs(t, supervisor.AcceptObservation(late, provider, nil), ErrInvalidObservation)
	require.ErrorIs(t, supervisor.AcceptObservation(OperationHandle{HostHarnessSessionID: id, Token: "invented"}, provider, nil), ErrInvalidObservation)
}

func TestProtocolVocabularyIsClosedOverEveryCoreConsumer(t *testing.T) {
	for _, operation := range protocol.HostHarnessSessionCommandOperations {
		typeName := map[string]string{"create": "host-session.create", "adopt": "host-session.adopt", "attach": "host-session.attach", "detach": "host-session.detach",
			"start-turn": "host-session.turn.start", "steer": "host-session.turn.steer", "interrupt": "host-session.turn.interrupt",
			"resolve-approval": "host-session.approval.decision", "close": "host-session.close"}[operation]
		require.NotEmpty(t, typeName, operation)
		require.Equal(t, operation, commandOperation(typeName))
	}
	for _, operation := range protocol.HostHarnessSessionOperations {
		if operation == "read-history" {
			continue
		}
		require.Contains(t, protocol.HostHarnessSessionCommandOperations, operation)
	}
	for _, operation := range protocol.HostHarnessDriverOperations {
		require.Contains(t, []string{"adopt", "create", "discover"}, operation)
	}
	require.Equal(t, []string{"inspect", "reconcile", "refresh", "resume"}, LifecycleOperations)
}

func TestShutdownStopsAdmissionAndBoundsAnInflightProviderOperation(t *testing.T) {
	driver := newFakeDriver()
	supervisor, workspace := newTestSupervisor(t, driver)
	driver.entered = make(chan string, 1)
	driver.release = make(chan struct{})
	done := make(chan CommandResponse, 1)
	go func() { done <- createSession(t, supervisor, workspace, "create-1") }()
	require.Equal(t, "create", <-driver.entered)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	require.ErrorIs(t, supervisor.Shutdown(ctx), context.DeadlineExceeded)
	require.ErrorIs(t, createSession(t, supervisor, workspace, "create-2").Err, ErrShuttingDown)
	close(driver.release)
	response := <-done
	require.NoError(t, response.Err)
	require.NoError(t, supervisor.Shutdown(context.Background()))
}
