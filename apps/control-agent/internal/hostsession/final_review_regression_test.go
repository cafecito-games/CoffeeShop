package hostsession

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

type blockingFailBarrier struct {
	point   string
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (barrier *blockingFailBarrier) Reach(point string) error {
	fired := false
	if point == barrier.point {
		barrier.once.Do(func() {
			fired = true
			close(barrier.entered)
			<-barrier.release
		})
	}
	if fired {
		return errors.New("simulated process stop")
	}
	return nil
}

func TestNonStartTurnResultsNeverPersistProviderTurnIdentity(t *testing.T) {
	driver := newFakeDriver()
	driver.startStatus = "running"
	supervisor, workspace := newTestSupervisor(t, driver)
	id := createSession(t, supervisor, workspace, "create-1").Result.Session.HostHarnessSessionID
	epoch := int64(0)
	require.NoError(t, supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.attach", NodeID: "node-1", CommandID: "attach-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, ThreadID: "thread-1", ExpectedStatus: "idle"})).Err)
	epoch++
	started := supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.turn.start", NodeID: "node-1", CommandID: "turn-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, RunID: "run-1", Prompt: "hello"}))
	require.NoError(t, started.Err)
	turnID := started.Result.ProviderTurnID
	require.NotEmpty(t, turnID)

	steered := supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.turn.steer", NodeID: "node-1", CommandID: "steer-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, RunID: "run-1", ProviderTurnID: turnID, Text: "continue"}))
	require.NoError(t, steered.Err)
	require.Empty(t, steered.Result.ProviderTurnID)
	supervisor = restartUsable(t, supervisor, driver)

	provider := driver.session(SessionRequest{ProviderSessionID: supervisor.Session(id).ProviderSessionID})
	provider.Status = "awaiting-approval"
	driver.store(provider)
	require.NoError(t, supervisor.Refresh(context.Background(), id))
	decision := protocol.ApprovalDecision{ApprovalID: "approval-1", RunID: "run-1", Status: "approved", SelectedOptionID: "allow"}
	approved := supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.approval.decision", NodeID: "node-1", CommandID: "approval-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, RunID: "run-1", ProviderTurnID: turnID, Decision: &decision}))
	require.NoError(t, approved.Err)
	require.Empty(t, approved.Result.ProviderTurnID)
	supervisor = restartUsable(t, supervisor, driver)

	interrupted := supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.turn.interrupt", NodeID: "node-1", CommandID: "interrupt-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, RunID: "run-1", ProviderTurnID: turnID}))
	require.NoError(t, interrupted.Err)
	require.Empty(t, interrupted.Result.ProviderTurnID)
	_ = restartUsable(t, supervisor, driver)
}

func TestCreateReconcileReusesAttachedSessionWithoutResettingProjection(t *testing.T) {
	driver := newFakeDriver()
	supervisor, workspace := newTestSupervisor(t, driver)
	created := createSession(t, supervisor, workspace, "create-1")
	id := created.Result.Session.HostHarnessSessionID
	epoch := int64(0)
	require.NoError(t, supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.attach", NodeID: "node-1", CommandID: "attach-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, ThreadID: "thread-1", ExpectedStatus: "idle"})).Err)
	before := supervisor.Session(id)
	markCommandUncertain(t, supervisor, "create-1")

	reconciled := supervisor.Reconcile(context.Background(), "create-1")
	require.NoError(t, reconciled.Err)
	after := supervisor.Session(id)
	require.Equal(t, before.AttachedThreadID, after.AttachedThreadID)
	require.Equal(t, before.AttachmentEpoch, after.AttachmentEpoch)
	require.Equal(t, before.Revision, after.Revision)
	require.Len(t, supervisor.Snapshot(), 1)
	restarted := restartUsable(t, supervisor, driver)
	require.Equal(t, after, restarted.Session(id))
}

func TestForgetTransactionsSerializeAcrossSessionsAndRecoverCrash(t *testing.T) {
	driver := newFakeDriver()
	supervisor, workspace := newTestSupervisor(t, driver)
	ids := make([]string, 0, 2)
	for index := 1; index <= 2; index++ {
		commandID := "create-" + string(rune('0'+index))
		id := createSession(t, supervisor, workspace, commandID).Result.Session.HostHarnessSessionID
		epoch := int64(0)
		closeID := "close-" + string(rune('0'+index))
		require.NoError(t, supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.close", NodeID: "node-1", CommandID: closeID, HostHarnessSessionID: id, AttachmentEpoch: &epoch})).Err)
		require.NoError(t, supervisor.Acknowledge(commandID))
		require.NoError(t, supervisor.Acknowledge(closeID))
		ids = append(ids, id)
	}
	barrier := &blockingFailBarrier{point: BarrierAfterForgetIntent, entered: make(chan struct{}), release: make(chan struct{})}
	supervisor.barrier = barrier
	firstDone := make(chan error, 1)
	go func() { firstDone <- supervisor.ForgetClosed(ids[0]) }()
	<-barrier.entered
	require.ErrorIs(t, supervisor.ForgetClosed(ids[1]), ErrSessionBusy)
	close(barrier.release)
	require.Error(t, <-firstDone)

	restarted, err := New(Options{NodeID: "node-1", DataRoot: supervisor.dataRoot, WorkspaceRoots: supervisor.workspaceRoots, Drivers: []Driver{driver}})
	require.NoError(t, err)
	usable, diagnostic := restarted.Usable()
	require.True(t, usable, diagnostic)
	require.Empty(t, restarted.Session(ids[0]).HostHarnessSessionID)
	require.Equal(t, "closed", restarted.Session(ids[1]).Status)
	require.NoError(t, restarted.ForgetClosed(ids[1]))
	restarted = restartUsable(t, restarted, driver)
	require.Empty(t, restarted.Snapshot())
}

func TestReconcileCallbackCannotBeOverwrittenByStaleOutcome(t *testing.T) {
	driver := newFakeDriver()
	driver.startStatus = "running"
	supervisor, workspace := newTestSupervisor(t, driver)
	id := createSession(t, supervisor, workspace, "create-1").Result.Session.HostHarnessSessionID
	epoch := int64(0)
	require.NoError(t, supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.attach", NodeID: "node-1", CommandID: "attach-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, ThreadID: "thread-1", ExpectedStatus: "idle"})).Err)
	epoch++
	started := supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.turn.start", NodeID: "node-1", CommandID: "turn-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, RunID: "run-1", Prompt: "hello"}))
	require.NoError(t, started.Err)
	turnID := started.Result.ProviderTurnID
	supervisor.barrier = &failBarrier{point: BarrierAfterEffect}
	steer := signed(t, protocol.HostSessionHubMessage{Type: "host-session.turn.steer", NodeID: "node-1", CommandID: "steer-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, RunID: "run-1", ProviderTurnID: turnID, Text: "continue"})
	require.Error(t, supervisor.Execute(context.Background(), steer).Err)
	supervisor.barrier = nil

	var reconcileHandle OperationHandle
	driver.reconcileFn = func(request ReconcileRequest) (ReconcileResult, error) {
		reconcileHandle = request.Handle
		stale := driver.session(request.SessionRequest)
		terminal := stale
		terminal.Status = "closed"
		require.NoError(t, supervisor.AcceptObservation(request.Handle, terminal, nil))
		return ReconcileResult{Outcome: DriverOutcome{Session: stale, ProviderTurnID: turnID}, Conclusive: true}, nil
	}
	response := supervisor.Reconcile(context.Background(), "steer-1")
	require.Error(t, response.Err)
	require.Equal(t, "closed", supervisor.Session(id).Status)
	require.ErrorIs(t, supervisor.AcceptObservation(reconcileHandle, driver.session(SessionRequest{ProviderSessionID: started.Result.Session.ProviderSessionID}), nil), ErrInvalidObservation)
}

func TestCreateAndAdoptReconcileRejectProviderIdentityDrift(t *testing.T) {
	for _, test := range []struct {
		name      string
		operation string
		provider  func(workspace, other string) ProviderSession
	}{
		{"create-workspace", "create", func(_, other string) ProviderSession {
			return providerSession("provider-new", other, "coffee-shop-managed")
		}},
		{"adopt-provider", "adopt", func(workspace, _ string) ProviderSession {
			return providerSession("provider-wrong", workspace, "provider-history")
		}},
		{"adopt-workspace", "adopt", func(_, other string) ProviderSession {
			return providerSession("provider-expected", other, "provider-history")
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			driver := newFakeDriver()
			root := t.TempDir()
			workspace := filepath.Join(root, "workspace")
			other := filepath.Join(root, "other")
			require.NoError(t, os.Mkdir(workspace, 0o700))
			require.NoError(t, os.Mkdir(other, 0o700))
			supervisor, err := New(testOptions(root, driver))
			require.NoError(t, err)
			command := &ledgerRecord{CommandID: "uncertain-1", Digest: strings.Repeat("a", 64), Operation: test.operation, RequestID: "request-1", HarnessID: driver.HarnessID(), ProviderSessionID: "provider-expected", Workspace: workspace, State: "uncertain", UpdatedAt: supervisor.now()}
			result := supervisor.uncertainResult(*command, "recovery-required", "uncertain")
			command.Result = &result
			supervisor.commands[command.CommandID] = command
			reconciledProvider := test.provider(workspace, other)
			driver.reconcileFn = func(ReconcileRequest) (ReconcileResult, error) {
				return ReconcileResult{Session: reconciledProvider, Conclusive: true}, nil
			}
			response := supervisor.Reconcile(context.Background(), command.CommandID)
			require.Error(t, response.Err)
			require.Empty(t, supervisor.Snapshot())
		})
	}
}

func TestCommandEvictionUsesParsedTimestampThenCommandID(t *testing.T) {
	supervisor := &Supervisor{maximumCommands: 2}
	supervisor.commands = map[string]*ledgerRecord{
		"chronologically-older": {CommandID: "chronologically-older", State: "completed", Acknowledged: true, UpdatedAt: "2026-01-01T00:30:00+02:00"},
		"lexically-older":       {CommandID: "lexically-older", State: "completed", Acknowledged: true, UpdatedAt: "2025-12-31T23:00:00Z"},
	}
	require.True(t, supervisor.ensureCommandCapacityLocked())
	require.NotContains(t, supervisor.commands, "chronologically-older")
	require.Contains(t, supervisor.commands, "lexically-older")

	supervisor.commands = map[string]*ledgerRecord{
		"a": {CommandID: "a", State: "completed", Acknowledged: true, UpdatedAt: "2026-01-01T00:00:00Z"},
		"b": {CommandID: "b", State: "completed", Acknowledged: true, UpdatedAt: "2026-01-01T00:00:00+00:00"},
	}
	require.True(t, supervisor.ensureCommandCapacityLocked())
	require.NotContains(t, supervisor.commands, "a")
	require.Contains(t, supervisor.commands, "b")

	driver := newFakeDriver()
	durable, workspace := newTestSupervisor(t, driver)
	for index := 1; index <= 3; index++ {
		require.NoError(t, createSession(t, durable, workspace, "create-"+string(rune('0'+index))).Err)
	}
	durable.maximumCommands = 2
	durable.commands["create-1"].Acknowledged = true
	durable.commands["create-1"].UpdatedAt = "2026-01-01T00:30:00+02:00"
	durable.commands["create-2"].Acknowledged = true
	durable.commands["create-2"].UpdatedAt = "2025-12-31T23:00:00Z"
	durable.commands["create-3"].UpdatedAt = "2026-01-02T00:00:00Z"
	require.NoError(t, durable.Acknowledge("create-3"))
	require.NotContains(t, durable.commands, "create-1")
	require.Contains(t, durable.commands, "create-2")
}

func markCommandUncertain(t *testing.T, supervisor *Supervisor, commandID string) {
	t.Helper()
	command := supervisor.commands[commandID]
	command.State = "uncertain"
	command.Acknowledged = false
	result := supervisor.uncertainResult(*command, "recovery-required", "uncertain")
	command.Result = &result
	require.NoError(t, saveLedger(supervisor.dataRoot, supervisor.commands))
}

func restartUsable(t *testing.T, supervisor *Supervisor, driver Driver) *Supervisor {
	t.Helper()
	restarted, err := New(Options{NodeID: supervisor.nodeID, DataRoot: supervisor.dataRoot, WorkspaceRoots: supervisor.workspaceRoots, Drivers: []Driver{driver}, Clock: supervisor.clock, IDs: supervisor.ids})
	require.NoError(t, err)
	usable, diagnostic := restarted.Usable()
	require.True(t, usable, diagnostic)
	return restarted
}
