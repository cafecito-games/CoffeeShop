package hostsession

import (
	"context"
	"fmt"
	"slices"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

type failingReconcileDriver struct {
	*fakeDriver
}

func (driver *failingReconcileDriver) Reconcile(context.Context, SessionRequest) (DriverSession, error) {
	return DriverSession{}, fmt.Errorf("writer unavailable")
}

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (clock *fakeClock) Now() time.Time {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	result := clock.now
	clock.now = clock.now.Add(time.Second)
	return result
}

type fakeDriver struct {
	mu       sync.Mutex
	sessions map[string]DriverSession
	calls    []string
	block    map[string]<-chan struct{}
	entered  chan string
	emit     bool
	observer func(DriverSession) error
}

type releasingFakeDriver struct {
	*fakeDriver
	releases []string
}

type trackingClaimDriver struct {
	*fakeDriver
	releases []string
}

func (driver *trackingClaimDriver) ReleaseClaim(providerSessionID string) {
	driver.mu.Lock()
	defer driver.mu.Unlock()
	driver.releases = append(driver.releases, providerSessionID)
}

type providerHistoryInspectDriver struct {
	*fakeDriver
}

type observingSteerDriver struct {
	*fakeDriver
}

type observingDetachDriver struct {
	*fakeDriver
}

func (driver *observingDetachDriver) Detach(_ context.Context, request SessionRequest) (DriverSession, error) {
	driver.mu.Lock()
	driver.calls = append(driver.calls, "detach")
	latest := driver.sessions[request.ProviderSessionID]
	latest.Status = "idle"
	latest.ControlMode = "full"
	driver.sessions[request.ProviderSessionID] = latest
	driver.mu.Unlock()
	if request.Observe != nil {
		if err := request.Observe(latest); err != nil {
			return DriverSession{}, err
		}
	}
	latest.ControlMode = "resume"
	latest.Operations = []string{"attach", "close", "read-history"}
	return latest, nil
}

type rejectingResumeDriver struct {
	*fakeDriver
	reject bool
}

func (driver *rejectingResumeDriver) Resume(ctx context.Context, request SessionRequest) (DriverSession, error) {
	if !driver.reject {
		return driver.fakeDriver.Resume(ctx, request)
	}
	observed := driverSessionFromRequest(request)
	observed.Status = "active-elsewhere"
	observed.ControlMode = "observe"
	observed.Operations = []string{"attach", "close", "read-history"}
	return DriverSession{}, DriverRejection{Code: "active-elsewhere", Observation: &observed}
}

func driverSessionFromRequest(request SessionRequest) DriverSession {
	return DriverSession{
		ProviderSessionID: request.ProviderSessionID, Workspace: request.Workspace, Source: request.Source,
		Status: request.Status, ControlMode: request.ControlMode, Operations: slices.Clone(request.Operations),
		ProviderTurnID: request.ProviderTurnID, Summary: request.Summary,
	}
}

func (driver *observingSteerDriver) Steer(_ context.Context, request SessionRequest) (DriverSession, error) {
	driver.mu.Lock()
	driver.calls = append(driver.calls, "steer")
	stale := driver.sessions[request.ProviderSessionID]
	latest := stale
	latest.Status = "idle"
	latest.ProviderTurnID = ""
	driver.sessions[request.ProviderSessionID] = latest
	driver.mu.Unlock()
	if request.Observe != nil {
		if err := request.Observe(latest); err != nil {
			return DriverSession{}, err
		}
	}
	return stale, nil
}

func (driver *providerHistoryInspectDriver) Inspect(ctx context.Context, request SessionRequest) (DriverSession, error) {
	observed, err := driver.fakeDriver.Inspect(ctx, request)
	observed.Source = "provider-history"
	return observed, err
}

func (driver *releasingFakeDriver) Adopt(ctx context.Context, request SessionRequest) (DriverSession, error) {
	observed, err := driver.fakeDriver.Adopt(ctx, request)
	observed.Source = "invalid-source"
	return observed, err
}

func (driver *releasingFakeDriver) ReleaseClaim(providerSessionID string) {
	driver.mu.Lock()
	defer driver.mu.Unlock()
	driver.releases = append(driver.releases, providerSessionID)
}

func newFakeDriver(workspace string) *fakeDriver {
	return &fakeDriver{sessions: map[string]DriverSession{
		"provider-existing": {
			ProviderSessionID: "provider-existing",
			Workspace:         workspace,
			Source:            "provider-history",
			Status:            "idle",
			ControlMode:       "resume",
			Operations:        []string{"attach", "close", "detach", "interrupt", "read-history", "resolve-approval", "start-turn", "steer"},
			Summary:           "Existing thread",
		},
	}}
}

func (driver *fakeDriver) HarnessID() string { return "codex-cli" }

func (driver *fakeDriver) Capabilities() CapabilitySet {
	return NewCapabilitySet(
		OperationDiscover, OperationReadHistory, OperationInspect, OperationAdopt,
		OperationCreate, OperationResume, OperationStartTurn, OperationSteer,
		OperationDetach, OperationInterrupt, OperationResolveApproval, OperationRefresh,
		OperationReconcile, OperationClose,
	)
}

func (driver *fakeDriver) Discover(context.Context, DiscoverRequest) (DiscoverPage, error) {
	driver.mu.Lock()
	defer driver.mu.Unlock()
	driver.calls = append(driver.calls, "discover")
	ids := make([]string, 0, len(driver.sessions))
	for id := range driver.sessions {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	sessions := make([]DriverSession, 0, len(ids))
	for _, id := range ids {
		sessions = append(sessions, driver.sessions[id])
	}
	return DiscoverPage{Sessions: sessions}, nil
}

func (driver *fakeDriver) ReadHistory(_ context.Context, request ReadHistoryRequest) (HistoryPage, error) {
	driver.mu.Lock()
	driver.calls = append(driver.calls, "read-history")
	block := driver.block["read-history"]
	entered := driver.entered
	driver.mu.Unlock()
	if block != nil {
		if entered != nil {
			entered <- request.Session.ProviderSessionID
		}
		<-block
	}
	return HistoryPage{Items: []protocol.HostHarnessSessionHistoryItem{{ID: "history-1", Kind: "assistant", Text: "bounded", Truncated: false}}}, nil
}

func (driver *fakeDriver) Inspect(_ context.Context, request SessionRequest) (DriverSession, error) {
	return driver.invoke("inspect", request)
}

func (driver *fakeDriver) Adopt(_ context.Context, request SessionRequest) (DriverSession, error) {
	observed, err := driver.invoke("adopt", request)
	if err != nil {
		return DriverSession{}, err
	}
	observed.ControlMode = "full"
	observed.Operations = []string{"attach", "close", "detach", "interrupt", "read-history", "resolve-approval", "start-turn", "steer"}
	driver.mu.Lock()
	driver.sessions[observed.ProviderSessionID] = observed
	driver.mu.Unlock()
	return observed, nil
}

func (driver *fakeDriver) Create(_ context.Context, request SessionRequest) (DriverSession, error) {
	request.ProviderSessionID = "provider-created"
	request.Source = "coffee-shop-managed"
	request.Summary = "Managed thread"
	return driver.invoke("create", request)
}

func (driver *fakeDriver) Resume(_ context.Context, request SessionRequest) (DriverSession, error) {
	return driver.invoke("resume", request)
}

func (driver *fakeDriver) Detach(_ context.Context, request SessionRequest) (DriverSession, error) {
	request.Status = "idle"
	request.ProviderTurnID = ""
	observed, err := driver.invoke("detach", request)
	if err != nil {
		return DriverSession{}, err
	}
	observed.ControlMode = "resume"
	observed.Operations = []string{"attach", "close", "read-history"}
	driver.mu.Lock()
	driver.sessions[observed.ProviderSessionID] = observed
	driver.mu.Unlock()
	return observed, nil
}

func (driver *fakeDriver) StartTurn(_ context.Context, request SessionRequest) (DriverSession, error) {
	if driver.emit && request.Emit != nil {
		go func() {
			if request.Activated != nil {
				<-request.Activated
			}
			_ = request.Emit(protocol.HarnessEvent{
				Type: "message.delta", RunID: request.RunID, Sequence: 1,
				At: "2026-10-06T12:00:00Z", Text: "normalized event",
			})
		}()
	}
	request.Status = "running"
	request.ProviderTurnID = "turn-" + request.RunID
	return driver.invoke("start-turn", request)
}

func (driver *fakeDriver) Steer(_ context.Context, request SessionRequest) (DriverSession, error) {
	return driver.invoke("steer", request)
}

func (driver *fakeDriver) Interrupt(_ context.Context, request SessionRequest) (DriverSession, error) {
	request.Status = "idle"
	request.ProviderTurnID = ""
	return driver.invoke("interrupt", request)
}

func (driver *fakeDriver) ResolveApproval(_ context.Context, request SessionRequest) (DriverSession, error) {
	request.Status = "running"
	return driver.invoke("resolve-approval", request)
}

func (driver *fakeDriver) Refresh(_ context.Context, request SessionRequest) (DriverSession, error) {
	request.Status = ""
	return driver.invoke("refresh", request)
}

func (driver *fakeDriver) Reconcile(_ context.Context, request SessionRequest) (DriverSession, error) {
	request.Status = ""
	return driver.invoke("reconcile", request)
}

func (driver *fakeDriver) Close(_ context.Context, request SessionRequest) (DriverSession, error) {
	request.Status = "closed"
	request.ProviderTurnID = ""
	return driver.invoke("close", request)
}

func (driver *fakeDriver) invoke(operation string, request SessionRequest) (DriverSession, error) {
	driver.mu.Lock()
	driver.calls = append(driver.calls, operation)
	if request.Observe != nil {
		driver.observer = request.Observe
	}
	block := driver.block[operation]
	entered := driver.entered
	driver.mu.Unlock()
	if block != nil {
		if entered != nil {
			entered <- request.ProviderSessionID
		}
		<-block
	}
	driver.mu.Lock()
	defer driver.mu.Unlock()
	session, found := driver.sessions[request.ProviderSessionID]
	if !found {
		session = DriverSession{
			ProviderSessionID: request.ProviderSessionID,
			Workspace:         request.Workspace,
			Source:            request.Source,
			Status:            "idle",
			ControlMode:       "full",
			Operations:        []string{"attach", "close", "detach", "interrupt", "read-history", "resolve-approval", "start-turn", "steer"},
			Summary:           request.Summary,
		}
	}
	if request.Status != "" {
		session.Status = request.Status
	}
	if request.ProviderTurnID != "" || operation == "interrupt" || operation == "close" {
		session.ProviderTurnID = request.ProviderTurnID
	}
	driver.sessions[session.ProviderSessionID] = session
	return session, nil
}

func (driver *fakeDriver) callCount(operation string) int {
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

func newTestSupervisor(t *testing.T, dataRoot, workspace string, driver Driver) *Supervisor {
	t.Helper()
	clock := &fakeClock{now: time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)}
	ids := []string{"host-session-one", "host-session-two"}
	index := 0
	supervisor, err := Open(Config{
		DataRoot:       dataRoot,
		NodeID:         "node-one",
		WorkspaceRoots: []string{workspace},
		Drivers:        []Driver{driver},
		Clock:          clock,
		NewID: func() string {
			result := ids[index]
			index++
			return result
		},
	})
	require.NoError(t, err)
	require.True(t, supervisor.Usable())
	return supervisor
}

func commandDigest(t *testing.T, command protocol.HostSessionHubMessage) protocol.HostSessionHubMessage {
	t.Helper()
	digest, err := protocol.HostHarnessSessionCommandDigest(command)
	require.NoError(t, err)
	command.CommandDigest = digest
	return command
}

func attachDiscoveredSession(t *testing.T, supervisor *Supervisor, harnessID, providerID, workspace, hostID, threadID string) protocol.HostHarnessSessionObservation {
	t.Helper()
	discovered, err := supervisor.Discover(context.Background(), harnessID)
	require.NoError(t, err)
	var session protocol.HostHarnessSessionObservation
	for _, candidate := range discovered {
		if candidate.ProviderSessionID == providerID {
			session = candidate
			break
		}
	}
	require.Equal(t, hostID, session.HostHarnessSessionID)
	adopt := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.adopt", NodeID: "node-one", RequestID: "request-" + hostID,
		CommandID: "adopt-" + hostID, HarnessID: harnessID, ProviderSessionID: providerID, Workspace: workspace,
	})
	adoptResponse := supervisor.Execute(context.Background(), adopt)
	require.Equal(t, "succeeded", adoptResponse.Result.Outcome, adoptResponse.Result.Code)
	epoch := int64(0)
	attach := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.attach", NodeID: "node-one", CommandID: "attach-" + hostID,
		HostHarnessSessionID: hostID, AttachmentEpoch: &epoch, ThreadID: threadID, ExpectedStatus: "idle",
	})
	require.Equal(t, "succeeded", supervisor.Execute(context.Background(), attach).Result.Outcome)
	return session
}

func TestSupervisorDiscoversReadsAdoptsAndRunsThreeTurnsAcrossRestart(t *testing.T) {
	root := t.TempDir()
	workspace := t.TempDir()
	driver := newFakeDriver(workspace)
	supervisor := newTestSupervisor(t, root, workspace, driver)

	discovered, err := supervisor.Discover(context.Background(), "codex-cli")
	require.NoError(t, err)
	require.Len(t, discovered, 1)
	session := discovered[0]
	require.Equal(t, "host-session-one", session.HostHarnessSessionID)
	require.Equal(t, "provider-existing", session.ProviderSessionID)

	history, err := supervisor.ReadHistory(context.Background(), session.HostHarnessSessionID, "request-history", "", 10)
	require.NoError(t, err)
	require.Len(t, history.Items, 1)

	adopt := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.adopt", NodeID: "node-one", RequestID: "request-adopt",
		CommandID: "command-adopt", HarnessID: "codex-cli", ProviderSessionID: session.ProviderSessionID,
		Workspace: workspace,
	})
	response := supervisor.Execute(context.Background(), adopt)
	require.Equal(t, "succeeded", response.Result.Outcome, response.Result.Code)
	require.Equal(t, session.HostHarnessSessionID, response.Result.Session.HostHarnessSessionID)
	require.Equal(t, "full", response.Result.Session.ControlMode)
	require.Contains(t, response.Result.Session.Operations, "start-turn")

	epoch := int64(0)
	attach := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.attach", NodeID: "node-one", CommandID: "command-attach",
		HostHarnessSessionID: session.HostHarnessSessionID, AttachmentEpoch: &epoch,
		ThreadID: "thread-one", ExpectedStatus: "idle",
	})
	response = supervisor.Execute(context.Background(), attach)
	require.Equal(t, "succeeded", response.Result.Outcome)
	require.EqualValues(t, 0, *response.Result.AttachmentEpoch)
	require.NoError(t, protocol.ValidateHostHarnessSessionCommandResponse(attach, response.Result))
	supervisor.mu.RLock()
	require.EqualValues(t, 1, supervisor.registry[session.HostHarnessSessionID].Session.AttachmentEpoch)
	supervisor.mu.RUnlock()

	for turn := 1; turn <= 3; turn++ {
		currentEpoch := int64(1)
		start := commandDigest(t, protocol.HostSessionHubMessage{
			Type: "host-session.turn.start", NodeID: "node-one", CommandID: "command-turn-" + string(rune('0'+turn)),
			HostHarnessSessionID: session.HostHarnessSessionID, AttachmentEpoch: &currentEpoch,
			RunID: "run-" + string(rune('0'+turn)), Prompt: "bounded prompt",
		})
		response = supervisor.Execute(context.Background(), start)
		require.Equal(t, "succeeded", response.Result.Outcome)
		require.NotEmpty(t, response.Result.ProviderTurnID)

		interrupt := commandDigest(t, protocol.HostSessionHubMessage{
			Type: "host-session.turn.interrupt", NodeID: "node-one", CommandID: "command-interrupt-" + string(rune('0'+turn)),
			HostHarnessSessionID: session.HostHarnessSessionID, AttachmentEpoch: &currentEpoch,
			RunID: "run-" + string(rune('0'+turn)), ProviderTurnID: response.Result.ProviderTurnID,
		})
		response = supervisor.Execute(context.Background(), interrupt)
		require.Equal(t, "succeeded", response.Result.Outcome)
	}

	replayed := supervisor.Execute(context.Background(), attach)
	require.Equal(t, "replayed", replayed.Ack.Disposition)
	require.Equal(t, responseSemanticJSON(t, supervisor.Execute(context.Background(), attach)), responseSemanticJSON(t, replayed))
	require.Equal(t, 1, driver.callCount("resume"))

	restarted := newTestSupervisor(t, root, workspace, driver)
	snapshot, err := restarted.Snapshot()
	require.NoError(t, err)
	require.Len(t, snapshot, 1)
	require.Equal(t, session.HostHarnessSessionID, snapshot[0].HostHarnessSessionID)

	replayAfterRestart := restarted.Execute(context.Background(), attach)
	require.Equal(t, "replayed", replayAfterRestart.Ack.Disposition)
	require.Equal(t, 1, driver.callCount("resume"))
}

func TestSupervisorReleasesAClaimRejectedDuringDurableAdoption(t *testing.T) {
	workspace := t.TempDir()
	driver := &releasingFakeDriver{fakeDriver: newFakeDriver(workspace)}
	supervisor := newTestSupervisor(t, t.TempDir(), workspace, driver)
	discovered, err := supervisor.Discover(context.Background(), "codex-cli")
	require.NoError(t, err)
	require.Len(t, discovered, 1)

	adopt := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.adopt", NodeID: "node-one", RequestID: "request-adopt-invalid",
		CommandID: "command-adopt-invalid", HarnessID: "codex-cli", ProviderSessionID: "provider-existing",
		Workspace: workspace,
	})
	response := supervisor.Execute(context.Background(), adopt)
	require.Equal(t, "uncertain", response.Result.Outcome)
	require.Equal(t, "provider-identity-conflict", response.Result.Code)
	require.Equal(t, []string{"provider-existing"}, driver.releases)
}

func TestSupervisorRejectsDuplicateAdoptionBeforeProviderAccess(t *testing.T) {
	workspace := t.TempDir()
	driver := newFakeDriver(workspace)
	supervisor := newTestSupervisor(t, t.TempDir(), workspace, driver)
	attachDiscoveredSession(t, supervisor, "codex-cli", "provider-existing", workspace, "host-session-one", "thread-one")
	inspectCalls := driver.callCount("inspect")
	adoptCalls := driver.callCount("adopt")

	duplicate := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.adopt", NodeID: "node-one", RequestID: "request-adopt-duplicate",
		CommandID: "command-adopt-duplicate", HarnessID: "codex-cli", ProviderSessionID: "provider-existing",
		Workspace: workspace,
	})
	response := supervisor.Execute(context.Background(), duplicate)
	require.Equal(t, "rejected", response.Result.Outcome)
	require.Equal(t, "illegal-transition", response.Result.Code)
	require.Equal(t, inspectCalls, driver.callCount("inspect"))
	require.Equal(t, adoptCalls, driver.callCount("adopt"))
}

func TestAdoptAndAttachForOneProviderShareTheSessionLock(t *testing.T) {
	workspace := t.TempDir()
	driver := newFakeDriver(workspace)
	block := make(chan struct{})
	driver.block = map[string]<-chan struct{}{"adopt": block}
	driver.entered = make(chan string, 1)
	supervisor := newTestSupervisor(t, t.TempDir(), workspace, driver)
	discovered, err := supervisor.Discover(context.Background(), "codex-cli")
	require.NoError(t, err)
	require.Len(t, discovered, 1)
	adopt := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.adopt", NodeID: "node-one", RequestID: "request-adopt-race",
		CommandID: "command-adopt-race", HarnessID: "codex-cli", ProviderSessionID: "provider-existing", Workspace: workspace,
	})
	adopted := make(chan CommandResponse, 1)
	go func() { adopted <- supervisor.Execute(context.Background(), adopt) }()
	select {
	case <-driver.entered:
	case <-time.After(time.Second):
		t.Fatal("adopt did not enter the provider")
	}
	epoch := int64(0)
	attach := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.attach", NodeID: "node-one", CommandID: "command-attach-race",
		HostHarnessSessionID: discovered[0].HostHarnessSessionID, AttachmentEpoch: &epoch,
		ThreadID: "thread-race", ExpectedStatus: "idle",
	})
	response := supervisor.Execute(context.Background(), attach)
	require.Equal(t, "rejected", response.Result.Outcome)
	require.Equal(t, "session-busy", response.Result.Code)
	close(block)
	require.Equal(t, "succeeded", (<-adopted).Result.Outcome)
}

func TestUnknownProviderAdoptDoesNotBlockAnUnrelatedCreate(t *testing.T) {
	workspace := t.TempDir()
	driver := newFakeDriver(workspace)
	block := make(chan struct{})
	driver.block = map[string]<-chan struct{}{"adopt": block}
	driver.entered = make(chan string, 1)
	supervisor := newTestSupervisor(t, t.TempDir(), workspace, driver)
	adopt := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.adopt", NodeID: "node-one", RequestID: "request-adopt-other",
		CommandID: "command-adopt-other", HarnessID: "codex-cli", ProviderSessionID: "provider-other", Workspace: workspace,
	})
	adopted := make(chan CommandResponse, 1)
	go func() { adopted <- supervisor.Execute(context.Background(), adopt) }()
	select {
	case <-driver.entered:
	case <-time.After(time.Second):
		t.Fatal("adopt did not enter the provider")
	}
	create := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.create", NodeID: "node-one", RequestID: "request-create-unrelated",
		CommandID: "command-create-unrelated", HarnessID: "codex-cli", Workspace: workspace,
	})
	created := supervisor.Execute(context.Background(), create)
	require.Equal(t, "succeeded", created.Result.Outcome, created.Result.Code)
	close(block)
	require.Equal(t, "succeeded", (<-adopted).Result.Outcome)
}

func TestRegistryReservationsPreventConcurrentGrowthBeyondCapacity(t *testing.T) {
	workspace := t.TempDir()
	supervisor := newTestSupervisor(t, t.TempDir(), workspace, newFakeDriver(workspace))
	supervisor.mu.Lock()
	for index := 0; index < protocol.HostHarnessSessionLimits.SessionsPerGeneration-1; index++ {
		id := fmt.Sprintf("host-capacity-%03d", index)
		providerID := fmt.Sprintf("provider-capacity-%03d", index)
		session := protocol.HostHarnessSession{HostHarnessSessionObservation: protocol.HostHarnessSessionObservation{
			HostHarnessSessionID: id, NodeID: "node-one", HarnessID: "codex-cli", ProviderSessionID: providerID,
			Workspace: workspace, Source: "provider-history", Status: "idle", ControlMode: "resume",
			Operations: []string{"attach", "close", "read-history"}, Revision: 1,
		}}
		supervisor.registry[id] = registryRecord{Session: session}
		supervisor.providerToID[providerKey("codex-cli", workspace, providerID)] = id
	}
	supervisor.mu.Unlock()
	reserved, err := supervisor.reserveRegistrySlot("command-one", "codex-cli", workspace, "provider-new-one")
	require.NoError(t, err)
	require.True(t, reserved)
	_, err = supervisor.reserveRegistrySlot("command-two", "codex-cli", workspace, "provider-new-two")
	require.ErrorContains(t, err, "capacity-conflict")
	supervisor.releaseRegistryReservation("command-one")
}

func TestReconcileFailureDurablyDropsStaleWriteAuthority(t *testing.T) {
	workspace := t.TempDir()
	driver := &failingReconcileDriver{fakeDriver: newFakeDriver(workspace)}
	supervisor := newTestSupervisor(t, t.TempDir(), workspace, driver)
	session := attachDiscoveredSession(t, supervisor, "codex-cli", "provider-existing", workspace, "host-session-one", "thread-one")
	reconciled, err := supervisor.Reconcile(context.Background(), session.HostHarnessSessionID)
	require.NoError(t, err)
	require.Equal(t, "active-elsewhere", reconciled.Status)
	require.Equal(t, "observe", reconciled.ControlMode)
	require.Equal(t, []string{"attach", "close", "detach", "read-history"}, reconciled.Operations)
	supervisor.mu.RLock()
	require.Empty(t, supervisor.registry[session.HostHarnessSessionID].Session.ActiveRunID)
	supervisor.mu.RUnlock()
	epoch := int64(1)
	detach := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.detach", NodeID: "node-one", CommandID: "command-detach-after-reconcile-failure",
		HostHarnessSessionID: session.HostHarnessSessionID, AttachmentEpoch: &epoch, ThreadID: "thread-one",
	})
	require.Equal(t, "succeeded", supervisor.Execute(context.Background(), detach).Result.Outcome)
}

func TestAttachedOwnedRefreshCannotEraseWriterLossRecovery(t *testing.T) {
	record := registryRecord{Owned: true, Session: protocol.HostHarnessSession{
		HostHarnessSessionObservation: protocol.HostHarnessSessionObservation{
			HostHarnessSessionID: "host-session-one", Status: "active-elsewhere", ControlMode: "observe",
		},
		AttachedThreadID: "thread-one",
	}}
	observed := preserveAttachedRecoveryOperation(record, DriverSession{
		Status: "idle", ControlMode: "resume", ProviderTurnID: "turn-stale",
		Operations: []string{"attach", "close", "read-history"},
	})
	require.Equal(t, "active-elsewhere", observed.Status)
	require.Equal(t, "observe", observed.ControlMode)
	require.Empty(t, observed.ProviderTurnID)
	require.Equal(t, []string{"attach", "close", "detach", "read-history"}, observed.Operations)
}

func TestSupervisorReadoptsDetachedManagedSessionWithoutRelabelingItsSource(t *testing.T) {
	workspace := t.TempDir()
	driver := &providerHistoryInspectDriver{fakeDriver: newFakeDriver(workspace)}
	supervisor := newTestSupervisor(t, t.TempDir(), workspace, driver)
	create := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.create", NodeID: "node-one", RequestID: "request-create-readopt",
		CommandID: "command-create-readopt", HarnessID: "codex-cli", Workspace: workspace,
	})
	created := supervisor.Execute(context.Background(), create)
	require.Equal(t, "succeeded", created.Result.Outcome)
	epoch := int64(0)
	attach := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.attach", NodeID: "node-one", CommandID: "command-attach-readopt",
		HostHarnessSessionID: created.Result.HostHarnessSessionID, AttachmentEpoch: &epoch,
		ThreadID: "thread-readopt", ExpectedStatus: "idle",
	})
	attached := supervisor.Execute(context.Background(), attach)
	require.Equal(t, "succeeded", attached.Result.Outcome)
	epoch++
	detach := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.detach", NodeID: "node-one", CommandID: "command-detach-readopt",
		HostHarnessSessionID: created.Result.HostHarnessSessionID, AttachmentEpoch: &epoch, ThreadID: "thread-readopt",
	})
	detached := supervisor.Execute(context.Background(), detach)
	require.Equal(t, "succeeded", detached.Result.Outcome)
	require.Equal(t, "resume", detached.Result.Session.ControlMode)
	require.Equal(t, "coffee-shop-managed", detached.Result.Session.Source)

	readopt := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.adopt", NodeID: "node-one", RequestID: "request-readopt-managed",
		CommandID: "command-readopt-managed", HarnessID: "codex-cli", ProviderSessionID: created.Result.Session.ProviderSessionID,
		Workspace: workspace,
	})
	readopted := supervisor.Execute(context.Background(), readopt)
	require.Equal(t, "succeeded", readopted.Result.Outcome, readopted.Result.Code)
	require.Equal(t, "coffee-shop-managed", readopted.Result.Session.Source)
	require.Equal(t, "full", readopted.Result.Session.ControlMode)
}

func TestReadoptedDetachedSessionKeepsItsCurrentEpochObserver(t *testing.T) {
	workspace := t.TempDir()
	driver := newFakeDriver(workspace)
	supervisor := newTestSupervisor(t, t.TempDir(), workspace, driver)
	attached := attachDiscoveredSession(t, supervisor, "codex-cli", "provider-existing", workspace, "host-session-one", "thread-one")
	epoch := int64(1)
	detach := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.detach", NodeID: "node-one", CommandID: "command-detach-observer",
		HostHarnessSessionID: attached.HostHarnessSessionID, AttachmentEpoch: &epoch, ThreadID: "thread-one",
	})
	require.Equal(t, "succeeded", supervisor.Execute(context.Background(), detach).Result.Outcome)
	adopt := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.adopt", NodeID: "node-one", RequestID: "request-readopt-observer",
		CommandID: "command-readopt-observer", HarnessID: "codex-cli", ProviderSessionID: "provider-existing", Workspace: workspace,
	})
	require.Equal(t, "succeeded", supervisor.Execute(context.Background(), adopt).Result.Outcome)
	driver.mu.Lock()
	observer := driver.observer
	observed := driver.sessions["provider-existing"]
	driver.mu.Unlock()
	require.NotNil(t, observer)
	observed.Status = "active-elsewhere"
	observed.ControlMode = "observe"
	observed.Operations = []string{"attach", "close", "read-history"}
	require.NoError(t, observer(observed))
	snapshot, err := supervisor.Snapshot()
	require.NoError(t, err)
	require.Equal(t, "active-elsewhere", snapshot[0].Status)
}

func TestRecoverySnapshotIncludesOnlyDurablyOwnedSessions(t *testing.T) {
	workspace := t.TempDir()
	dataRoot := t.TempDir()
	driver := newFakeDriver(workspace)
	supervisor := newTestSupervisor(t, dataRoot, workspace, driver)
	discovered, err := supervisor.Discover(context.Background(), "codex-cli")
	require.NoError(t, err)
	require.Len(t, discovered, 1)
	supervisor.mu.Lock()
	record := supervisor.registry[discovered[0].HostHarnessSessionID]
	record.Session.Status = "active-elsewhere"
	record.Session.ControlMode = "observe"
	record.Session.Operations = []string{"attach", "close", "read-history"}
	supervisor.registry[discovered[0].HostHarnessSessionID] = record
	supervisor.mu.Unlock()
	recovery, err := supervisor.RecoverySnapshot()
	require.NoError(t, err)
	require.Empty(t, recovery)

	create := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.create", NodeID: "node-one", RequestID: "request-owned-recovery",
		CommandID: "command-owned-recovery", HarnessID: "codex-cli", Workspace: workspace,
	})
	created := supervisor.Execute(context.Background(), create)
	require.Equal(t, "succeeded", created.Result.Outcome)
	recovery, err = supervisor.RecoverySnapshot()
	require.NoError(t, err)
	require.Len(t, recovery, 1)
	require.Equal(t, created.Result.HostHarnessSessionID, recovery[0].HostHarnessSessionID)
	restarted := newTestSupervisor(t, dataRoot, workspace, driver)
	recovery, err = restarted.RecoverySnapshot()
	require.NoError(t, err)
	require.Len(t, recovery, 1)
	require.Equal(t, created.Result.HostHarnessSessionID, recovery[0].HostHarnessSessionID)
}

func TestDetachedSessionRejectedOnReattachIsNotReclaimedAtStartup(t *testing.T) {
	workspace := t.TempDir()
	driver := &rejectingResumeDriver{fakeDriver: newFakeDriver(workspace)}
	supervisor := newTestSupervisor(t, t.TempDir(), workspace, driver)
	attached := attachDiscoveredSession(t, supervisor, "codex-cli", "provider-existing", workspace, "host-session-one", "thread-one")
	epoch := int64(1)
	detach := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.detach", NodeID: "node-one", CommandID: "command-detach-before-rejected-attach",
		HostHarnessSessionID: attached.HostHarnessSessionID, AttachmentEpoch: &epoch, ThreadID: "thread-one",
	})
	require.Equal(t, "succeeded", supervisor.Execute(context.Background(), detach).Result.Outcome)
	driver.reject = true
	epoch++
	attach := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.attach", NodeID: "node-one", CommandID: "command-rejected-reattach",
		HostHarnessSessionID: attached.HostHarnessSessionID, AttachmentEpoch: &epoch,
		ThreadID: "thread-two", ExpectedStatus: "idle",
	})
	result := supervisor.Execute(context.Background(), attach)
	require.Equal(t, "rejected", result.Result.Outcome)
	require.Equal(t, "active-elsewhere", result.Result.Code)
	recovery, err := supervisor.RecoverySnapshot()
	require.NoError(t, err)
	require.Empty(t, recovery)
}

func TestCloseClearsAnAttachedSessionAndAdvancesItsEpoch(t *testing.T) {
	workspace := t.TempDir()
	driver := newFakeDriver(workspace)
	supervisor := newTestSupervisor(t, t.TempDir(), workspace, driver)
	attachDiscoveredSession(t, supervisor, "codex-cli", "provider-existing", workspace, "host-session-one", "thread-close")
	epoch := int64(1)
	closeCommand := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.close", NodeID: "node-one", CommandID: "command-close-attached",
		HostHarnessSessionID: "host-session-one", AttachmentEpoch: &epoch,
	})
	closed := supervisor.Execute(context.Background(), closeCommand)
	require.Equal(t, "succeeded", closed.Result.Outcome)
	require.EqualValues(t, 1, *closed.Result.AttachmentEpoch)
	require.NoError(t, protocol.ValidateHostHarnessSessionCommandResponse(closeCommand, closed.Result))
	supervisor.mu.RLock()
	stored := supervisor.registry["host-session-one"].Session
	supervisor.mu.RUnlock()
	require.Empty(t, stored.AttachedThreadID)
	require.EqualValues(t, 2, stored.AttachmentEpoch)
}

func TestCommandResultCannotRegressANewerAsyncObservation(t *testing.T) {
	workspace := t.TempDir()
	driver := &observingSteerDriver{fakeDriver: newFakeDriver(workspace)}
	supervisor := newTestSupervisor(t, t.TempDir(), workspace, driver)
	attachDiscoveredSession(t, supervisor, "codex-cli", "provider-existing", workspace, "host-session-one", "thread-race")
	epoch := int64(1)
	start := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.turn.start", NodeID: "node-one", CommandID: "command-start-observation-race",
		HostHarnessSessionID: "host-session-one", AttachmentEpoch: &epoch, RunID: "run-observation-race", Prompt: "bounded",
	})
	started := supervisor.Execute(context.Background(), start)
	require.Equal(t, "succeeded", started.Result.Outcome)
	steer := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.turn.steer", NodeID: "node-one", CommandID: "command-steer-observation-race",
		HostHarnessSessionID: "host-session-one", AttachmentEpoch: &epoch, RunID: "run-observation-race",
		ProviderTurnID: started.Result.ProviderTurnID, Text: "continue",
	})
	steered := supervisor.Execute(context.Background(), steer)
	require.Equal(t, "succeeded", steered.Result.Outcome)
	require.Equal(t, "idle", steered.Result.Session.Status)
	require.Empty(t, steered.Result.Session.ProviderTurnID)
}

func TestDetachTerminalResultWinsRacingFullObservation(t *testing.T) {
	workspace := t.TempDir()
	driver := &observingDetachDriver{fakeDriver: newFakeDriver(workspace)}
	supervisor := newTestSupervisor(t, t.TempDir(), workspace, driver)
	attached := attachDiscoveredSession(t, supervisor, "codex-cli", "provider-existing", workspace, "host-session-one", "thread-one")
	epoch := int64(1)
	detach := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.detach", NodeID: "node-one", CommandID: "command-detach-racing-observation",
		HostHarnessSessionID: attached.HostHarnessSessionID, AttachmentEpoch: &epoch, ThreadID: "thread-one",
	})
	result := supervisor.Execute(context.Background(), detach)
	require.Equal(t, "succeeded", result.Result.Outcome)
	require.Equal(t, "resume", result.Result.Session.ControlMode)
	supervisor.mu.RLock()
	record := supervisor.registry[attached.HostHarnessSessionID]
	supervisor.mu.RUnlock()
	require.Equal(t, "resume", record.Session.ControlMode)
	require.False(t, record.Owned)
	recovery, err := supervisor.RecoverySnapshot()
	require.NoError(t, err)
	require.Empty(t, recovery)
}

func TestDiscoveryPreservesManagedSourceForAnExistingProviderThread(t *testing.T) {
	workspace := t.TempDir()
	driver := newFakeDriver(workspace)
	supervisor := newTestSupervisor(t, t.TempDir(), workspace, driver)
	create := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.create", NodeID: "node-one", RequestID: "request-create-discover",
		CommandID: "command-create-discover", HarnessID: "codex-cli", Workspace: workspace,
	})
	created := supervisor.Execute(context.Background(), create)
	require.Equal(t, "succeeded", created.Result.Outcome)
	require.Equal(t, "coffee-shop-managed", created.Result.Session.Source)

	discovered, err := supervisor.Discover(context.Background(), "codex-cli")
	require.NoError(t, err)
	require.Contains(t, discovered, *created.Result.Session)
	snapshot, err := supervisor.Snapshot()
	require.NoError(t, err)
	for _, session := range snapshot {
		if session.ProviderSessionID == "provider-created" {
			require.Equal(t, "coffee-shop-managed", session.Source)
			return
		}
	}
	t.Fatal("managed provider thread was not retained")
}

func responseSemanticJSON(t *testing.T, response CommandResponse) string {
	t.Helper()
	return response.Result.Outcome + "|" + response.Result.Code + "|" + response.Result.HostHarnessSessionID
}
