package hostsession

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

func TestConclusiveStartRejectionRestoresDurablePreEffectState(t *testing.T) {
	driver := newFakeDriver()
	supervisor, workspace := newTestSupervisor(t, driver)
	id := createSession(t, supervisor, workspace, "create-1").Result.Session.HostHarnessSessionID
	epoch := int64(0)
	require.NoError(t, supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.attach", NodeID: "node-1", CommandID: "attach-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, ThreadID: "thread-1", ExpectedStatus: "idle"})).Err)
	driver.failures["start-turn"] = errors.New("request rejected")
	epoch++
	response := supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.turn.start", NodeID: "node-1", CommandID: "turn-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, RunID: "run-1", Prompt: "hello"}))
	require.Error(t, response.Err)
	require.Equal(t, "rejected", response.Result.Outcome)
	require.Equal(t, "idle", supervisor.Session(id).Status)
	require.Empty(t, supervisor.Session(id).ActiveRunID)
	restarted, err := New(Options{NodeID: "node-1", DataRoot: supervisor.dataRoot, WorkspaceRoots: supervisor.workspaceRoots, Drivers: []Driver{driver}})
	require.NoError(t, err)
	require.Equal(t, "idle", restarted.Session(id).Status)
	require.Empty(t, restarted.Session(id).ActiveRunID)
}

func TestExplicitAmbiguousDriverFailureStaysDurablyUncertain(t *testing.T) {
	driver := newFakeDriver()
	supervisor, workspace := newTestSupervisor(t, driver)
	driver.failures["create"] = OutcomeUncertain(errors.New("connection lost after dispatch"))
	message := signed(t, protocol.HostSessionHubMessage{Type: "host-session.create", NodeID: "node-1", CommandID: "create-1", RequestID: "request-1", HarnessID: "codex-cli", Workspace: workspace})
	response := supervisor.Execute(context.Background(), message)
	require.Error(t, response.Err)
	require.Equal(t, "uncertain", response.Result.Outcome)
	replayed := supervisor.Execute(context.Background(), message)
	require.Error(t, replayed.Err)
	require.Equal(t, "uncertain", replayed.Result.Outcome)
	require.Equal(t, 1, driver.count("create"))
}

func TestLivePendingReplayIsBusyButRestartedPendingNeedsRecovery(t *testing.T) {
	driver := newFakeDriver()
	supervisor, workspace := newTestSupervisor(t, driver)
	driver.entered = make(chan string, 1)
	driver.release = make(chan struct{})
	message := signed(t, protocol.HostSessionHubMessage{Type: "host-session.create", NodeID: "node-1", CommandID: "create-1", RequestID: "request-1", HarnessID: "codex-cli", Workspace: workspace})
	done := make(chan CommandResponse, 1)
	go func() { done <- supervisor.Execute(context.Background(), message) }()
	require.Equal(t, "create", <-driver.entered)
	live := supervisor.Execute(context.Background(), message)
	require.ErrorIs(t, live.Err, ErrSessionBusy)
	require.Equal(t, "operation-pending", live.Result.Code)
	close(driver.release)
	require.NoError(t, (<-done).Err)
}

func TestSettledPendingReplayRequiresRecoveryInsteadOfReportingLive(t *testing.T) {
	driver := newFakeDriver()
	supervisor, workspace := newTestSupervisor(t, driver)
	supervisor.barrier = &failBarrier{point: BarrierAfterPending}
	message := signed(t, protocol.HostSessionHubMessage{Type: "host-session.create", NodeID: "node-1", CommandID: "create-1", RequestID: "request-1", HarnessID: "codex-cli", Workspace: workspace})
	require.Error(t, supervisor.Execute(context.Background(), message).Err)
	replay := supervisor.Execute(context.Background(), message)
	require.Error(t, replay.Err)
	require.NotErrorIs(t, replay.Err, ErrSessionBusy)
	require.Equal(t, "recovery-required", replay.Result.Code)
	require.Zero(t, driver.count("create"))
}

func TestCommandLedgerRejectsAdmissionWhenNothingIsSafelyEvictable(t *testing.T) {
	driver := newFakeDriver()
	root := t.TempDir()
	workspace := filepath.Join(root, "workspace")
	require.NoError(t, os.Mkdir(workspace, 0o700))
	options := testOptions(root, driver)
	options.MaximumCommands = 1
	supervisor, err := New(options)
	require.NoError(t, err)
	require.NoError(t, createSession(t, supervisor, workspace, "create-1").Err)
	second := createSession(t, supervisor, workspace, "create-2")
	require.ErrorIs(t, second.Err, ErrCommandCapacity)
	require.Equal(t, 1, driver.count("create"))
	require.Len(t, supervisor.commands, 1)
	require.NoError(t, supervisor.Acknowledge("create-1"))
	require.NoError(t, createSession(t, supervisor, workspace, "create-3").Err)
	require.Equal(t, 2, driver.count("create"))
	require.NotContains(t, supervisor.commands, "create-1")
}

func TestCapabilitiesRequireDriverAndSessionEvidence(t *testing.T) {
	for _, operation := range append(append([]string{}, protocol.HostHarnessSessionOperations...), LifecycleOperations...) {
		t.Run(operation, func(t *testing.T) {
			driver := newFakeDriver()
			supervisor, workspace := newTestSupervisor(t, driver)
			id := createSession(t, supervisor, workspace, "create-1").Result.Session.HostHarnessSessionID
			record := supervisor.sessions[id]
			if supports(protocol.HostHarnessSessionOperations, operation) {
				driver.capabilities.SessionOperations = removeString(driver.capabilities.SessionOperations, operation)
			} else {
				driver.capabilities.LifecycleOperations = removeString(driver.capabilities.LifecycleOperations, operation)
			}
			require.False(t, supervisor.supportsSessionOperation(record, operation))
			driver = newFakeDriver()
			supervisor.drivers["codex-cli"] = driver
			if supports(protocol.HostHarnessSessionOperations, operation) {
				record.Observation.Operations = removeString(record.Observation.Operations, operation)
			} else {
				record.LifecycleOperations = removeString(record.LifecycleOperations, operation)
			}
			require.False(t, supervisor.supportsSessionOperation(record, operation))
		})
	}
}

func TestEveryProviderCallingPathEnforcesGlobalCapabilityEvidence(t *testing.T) {
	tests := []struct {
		operation string
		invoke    func(*testing.T, *Supervisor, string, string) error
	}{
		{"inspect", func(_ *testing.T, supervisor *Supervisor, id, _ string) error {
			return supervisor.Inspect(context.Background(), id)
		}},
		{"resume", func(_ *testing.T, supervisor *Supervisor, id, _ string) error {
			return supervisor.Resume(context.Background(), id)
		}},
		{"refresh", func(_ *testing.T, supervisor *Supervisor, id, _ string) error {
			return supervisor.Refresh(context.Background(), id)
		}},
		{"read-history", func(t *testing.T, supervisor *Supervisor, id, _ string) error {
			epoch := int64(0)
			message := signed(t, protocol.HostSessionHubMessage{Type: "host-session.history.read", NodeID: "node-1", CommandID: "history-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, RequestID: "request-1", Limit: 1})
			_, err := supervisor.ReadHistory(context.Background(), message)
			return err
		}},
		{"start-turn", func(t *testing.T, supervisor *Supervisor, id, _ string) error {
			epoch := int64(0)
			return supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.turn.start", NodeID: "node-1", CommandID: "turn-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, RunID: "run-1", Prompt: "hello"})).Err
		}},
	}
	for _, test := range tests {
		t.Run(test.operation, func(t *testing.T) {
			driver := newFakeDriver()
			supervisor, workspace := newTestSupervisor(t, driver)
			id := createSession(t, supervisor, workspace, "create-1").Result.Session.HostHarnessSessionID
			if supports(LifecycleOperations, test.operation) {
				driver.capabilities.LifecycleOperations = removeString(driver.capabilities.LifecycleOperations, test.operation)
			} else {
				driver.capabilities.SessionOperations = removeString(driver.capabilities.SessionOperations, test.operation)
			}
			require.ErrorIs(t, test.invoke(t, supervisor, id, workspace), ErrUnsupportedCapability)
			require.Zero(t, driver.count(test.operation))
		})
	}

	driver := newFakeDriver()
	supervisor, workspace := newTestSupervisor(t, driver)
	createSession(t, supervisor, workspace, "create-1")
	supervisor.commands["create-1"].State = "uncertain"
	driver.capabilities.LifecycleOperations = removeString(driver.capabilities.LifecycleOperations, "reconcile")
	require.ErrorIs(t, supervisor.Reconcile(context.Background(), "create-1").Err, ErrUnsupportedCapability)
	require.Zero(t, driver.count("reconcile"))

	driver = newFakeDriver()
	driver.capabilities.LifecycleOperations = removeString(driver.capabilities.LifecycleOperations, "inspect")
	supervisor, workspace = newTestSupervisor(t, driver)
	adopt := supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.adopt", NodeID: "node-1", CommandID: "adopt-1", RequestID: "request-1", HarnessID: "codex-cli", ProviderSessionID: "provider-1", Workspace: workspace}))
	require.ErrorIs(t, adopt.Err, ErrUnsupportedCapability)
	require.Zero(t, driver.count("inspect"))
	require.Zero(t, driver.count("adopt"))
}

func TestDiscoveryIsolatesBadEntriesAndReturnsKnownSessionsOnly(t *testing.T) {
	driver := newFakeDriver()
	supervisor, workspace := newTestSupervisor(t, driver)
	known := createSession(t, supervisor, workspace, "create-1").Result.Session
	outside := filepath.Join(filepath.Dir(filepath.Dir(workspace)), "outside")
	require.NoError(t, os.Mkdir(outside, 0o700))
	driver.discovered = []ProviderSession{
		providerSession(known.ProviderSessionID, workspace, "coffee-shop-managed"),
		providerSession("provider-unknown", workspace, "provider-history"),
		providerSession("provider-outside", outside, "provider-history"),
		{ProviderSessionID: "provider-invalid", Workspace: workspace, Source: "bad", Status: "idle", ControlMode: "full"},
	}
	result, err := supervisor.Discover(context.Background(), "codex-cli", 4)
	require.NoError(t, err)
	require.Len(t, result.Sessions, 1)
	require.Equal(t, known.HostHarnessSessionID, result.Sessions[0].HostHarnessSessionID)
	require.Len(t, result.Diagnostics, 2)
	for _, diagnostic := range result.Diagnostics {
		require.LessOrEqual(t, len(diagnostic), protocol.HostHarnessSessionLimits.DiagnosticBytes)
	}
}

func TestCallbackCannotOverwriteNewerStateAndShutdownRejectsNewCallback(t *testing.T) {
	driver := newFakeDriver()
	supervisor, workspace := newTestSupervisor(t, driver)
	id := createSession(t, supervisor, workspace, "create-1").Result.Session.HostHarnessSessionID
	handle, err := supervisor.issueHandle(id)
	require.NoError(t, err)
	newer := supervisor.Session(id)
	newerProvider := providerSession(newer.ProviderSessionID, newer.Workspace, newer.Source)
	newerProvider.Status = "running"
	require.NoError(t, supervisor.saveSession(&sessionRecord{Observation: protocol.HostHarnessSessionObservation{
		HostHarnessSessionID: id, NodeID: "node-1", HarnessID: "codex-cli", ProviderSessionID: newer.ProviderSessionID,
		Workspace: newer.Workspace, Source: newer.Source, Status: "running", ControlMode: newer.ControlMode,
		Operations: newer.Operations, Revision: newer.Revision + 1, CreatedAt: newer.CreatedAt, UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}, LifecycleOperations: append([]string(nil), LifecycleOperations...)}))
	require.ErrorIs(t, supervisor.AcceptObservation(handle, newerProvider, nil), ErrInvalidObservation)
	require.Equal(t, "running", supervisor.Session(id).Status)
	require.NoError(t, supervisor.Shutdown(context.Background()))
	require.ErrorIs(t, supervisor.AcceptObservation(handle, newerProvider, nil), ErrShuttingDown)
}

func TestTerminalAttachmentCloseOutcomeAndEventCountAreRejected(t *testing.T) {
	driver := newFakeDriver()
	supervisor, workspace := newTestSupervisor(t, driver)
	id := createSession(t, supervisor, workspace, "create-1").Result.Session.HostHarnessSessionID
	epoch := int64(0)
	require.NoError(t, supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.attach", NodeID: "node-1", CommandID: "attach-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, ThreadID: "thread-1", ExpectedStatus: "idle"})).Err)
	epoch++
	driver.outcomeEvents = make([]protocol.HarnessEvent, MaximumOutcomeEvents+1)
	tooMany := supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.turn.start", NodeID: "node-1", CommandID: "turn-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, RunID: "run-1", Prompt: "hello"}))
	require.Error(t, tooMany.Err)
	require.Equal(t, "uncertain", tooMany.Result.Outcome)
}

func TestFullManagedLifecycleCoversSteerApprovalInterruptDetachAndClose(t *testing.T) {
	driver := newFakeDriver()
	driver.startStatus = "running"
	supervisor, workspace := newTestSupervisor(t, driver)
	id := createSession(t, supervisor, workspace, "create-1").Result.Session.HostHarnessSessionID
	epoch := int64(0)
	require.NoError(t, supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.attach", NodeID: "node-1", CommandID: "attach-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, ThreadID: "thread-1", ExpectedStatus: "idle"})).Err)
	epoch++
	driver.outcomeEvents = []protocol.HarnessEvent{{Type: "warning", RunID: "run-1", Sequence: 1, At: time.Now().UTC().Format(time.RFC3339Nano), Code: "bounded-warning", Message: "normalized"}}
	started := supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.turn.start", NodeID: "node-1", CommandID: "turn-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, RunID: "run-1", Prompt: "hello"}))
	require.NoError(t, started.Err)
	require.Equal(t, "running", started.Result.Session.Status)
	require.Len(t, started.Events, 1)
	providerTurnID := started.Result.ProviderTurnID
	driver.outcomeEvents = nil
	steered := supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.turn.steer", NodeID: "node-1", CommandID: "steer-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, RunID: "run-1", ProviderTurnID: providerTurnID, Text: "continue"}))
	require.NoError(t, steered.Err)
	require.Equal(t, 1, driver.count("steer"))

	provider := driver.session(SessionRequest{ProviderSessionID: started.Result.Session.ProviderSessionID})
	provider.Status = "awaiting-approval"
	driver.store(provider)
	require.NoError(t, supervisor.Refresh(context.Background(), id))
	decision := protocol.ApprovalDecision{ApprovalID: "approval-1", RunID: "run-1", Status: "approved", SelectedOptionID: "allow"}
	approved := supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.approval.decision", NodeID: "node-1", CommandID: "approval-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, RunID: "run-1", ProviderTurnID: providerTurnID, Decision: &decision}))
	require.NoError(t, approved.Err)
	require.Equal(t, "running", approved.Result.Session.Status)

	interrupted := supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.turn.interrupt", NodeID: "node-1", CommandID: "interrupt-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, RunID: "run-1", ProviderTurnID: providerTurnID}))
	require.NoError(t, interrupted.Err)
	require.Equal(t, "idle", interrupted.Result.Session.Status)
	detached := supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.detach", NodeID: "node-1", CommandID: "detach-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, ThreadID: "thread-1"}))
	require.NoError(t, detached.Err)
	epoch++
	require.Empty(t, supervisor.Session(id).AttachedThreadID)
	closed := supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.close", NodeID: "node-1", CommandID: "close-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch}))
	require.NoError(t, closed.Err)
	require.Equal(t, "closed", closed.Result.Session.Status)

	terminalAttach := supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.attach", NodeID: "node-1", CommandID: "attach-terminal", HostHarnessSessionID: id, AttachmentEpoch: &epoch, ThreadID: "thread-2", ExpectedStatus: "closed"}))
	require.ErrorIs(t, terminalAttach.Err, ErrInvalidTransition)
	require.Zero(t, driver.count("attach"))
}

func TestCleanAdoptionAndKnownSessionDiscovery(t *testing.T) {
	driver := newFakeDriver()
	root := t.TempDir()
	workspace := filepath.Join(root, "workspace")
	require.NoError(t, os.Mkdir(workspace, 0o700))
	provider := providerSession("provider-adopted", workspace, "provider-history")
	driver.store(provider)
	supervisor, err := New(testOptions(root, driver))
	require.NoError(t, err)
	adopted := supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.adopt", NodeID: "node-1", CommandID: "adopt-1", RequestID: "request-1", HarnessID: "codex-cli", ProviderSessionID: provider.ProviderSessionID, Workspace: workspace}))
	require.NoError(t, adopted.Err)
	require.Equal(t, "provider-history", adopted.Result.Session.Source)
	require.Equal(t, 1, driver.count("inspect"))
	require.Equal(t, 1, driver.count("adopt"))
	discovered, err := supervisor.Discover(context.Background(), "codex-cli", 10)
	require.NoError(t, err)
	require.Len(t, discovered.Sessions, 1)
	require.Equal(t, adopted.Result.Session.HostHarnessSessionID, discovered.Sessions[0].HostHarnessSessionID)
}

func TestEpochAndAttachmentConflictsNeverReachProvider(t *testing.T) {
	driver := newFakeDriver()
	supervisor, workspace := newTestSupervisor(t, driver)
	id := createSession(t, supervisor, workspace, "create-1").Result.Session.HostHarnessSessionID
	future := int64(1)
	require.ErrorIs(t, supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.attach", NodeID: "node-1", CommandID: "attach-future", HostHarnessSessionID: id, AttachmentEpoch: &future, ThreadID: "thread-1", ExpectedStatus: "idle"})).Err, ErrFutureEpoch)
	epoch := int64(0)
	statusMismatch := supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.attach", NodeID: "node-1", CommandID: "attach-status", HostHarnessSessionID: id, AttachmentEpoch: &epoch, ThreadID: "thread-1", ExpectedStatus: "running"}))
	require.Error(t, statusMismatch.Err)
	require.NoError(t, supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.attach", NodeID: "node-1", CommandID: "attach-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, ThreadID: "thread-1", ExpectedStatus: "idle"})).Err)
	epoch++
	conflict := supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.attach", NodeID: "node-1", CommandID: "attach-conflict", HostHarnessSessionID: id, AttachmentEpoch: &epoch, ThreadID: "thread-2", ExpectedStatus: "idle"}))
	require.Error(t, conflict.Err)
	require.Equal(t, "thread-1", supervisor.Session(id).AttachedThreadID)
}

func TestSessionScopedReconcileDoesNotRepeatTurn(t *testing.T) {
	driver := newFakeDriver()
	supervisor, workspace := newTestSupervisor(t, driver)
	id := createSession(t, supervisor, workspace, "create-1").Result.Session.HostHarnessSessionID
	epoch := int64(0)
	require.NoError(t, supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.attach", NodeID: "node-1", CommandID: "attach-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, ThreadID: "thread-1", ExpectedStatus: "idle"})).Err)
	epoch++
	supervisor.barrier = &failBarrier{point: BarrierAfterEffect}
	turn := supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.turn.start", NodeID: "node-1", CommandID: "turn-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, RunID: "run-1", Prompt: "hello"}))
	require.Error(t, turn.Err)
	supervisor.barrier = nil
	reconciled := supervisor.Reconcile(context.Background(), "turn-1")
	require.NoError(t, reconciled.Err)
	require.Equal(t, "succeeded", reconciled.Result.Outcome)
	require.Equal(t, 1, driver.count("start-turn"))
	require.Equal(t, 1, driver.count("reconcile"))
}

func TestCloseRequiresTerminalOutcomeAndRejectsEvents(t *testing.T) {
	for _, test := range []struct {
		name   string
		status string
		events []protocol.HarnessEvent
		code   string
	}{
		{name: "non-terminal", status: "idle", code: "invalid-close-outcome"},
		{name: "event-on-close", status: "closed", events: []protocol.HarnessEvent{{Type: "warning", RunID: "run-1", Sequence: 1, At: time.Now().UTC().Format(time.RFC3339Nano), Code: "unexpected", Message: "event"}}, code: "invalid-provider-event"},
	} {
		t.Run(test.name, func(t *testing.T) {
			driver := newFakeDriver()
			driver.closeStatus = test.status
			driver.outcomeEvents = test.events
			supervisor, workspace := newTestSupervisor(t, driver)
			id := createSession(t, supervisor, workspace, "create-1").Result.Session.HostHarnessSessionID
			epoch := int64(0)
			response := supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.close", NodeID: "node-1", CommandID: "close-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch}))
			require.Error(t, response.Err)
			require.Equal(t, "uncertain", response.Result.Outcome)
			require.Equal(t, test.code, response.Result.Code)
			require.Equal(t, "idle", supervisor.Session(id).Status)
		})
	}
}

func TestCallbackAndShutdownRaceIsOperationAccounted(t *testing.T) {
	driver := newFakeDriver()
	supervisor, workspace := newTestSupervisor(t, driver)
	id := createSession(t, supervisor, workspace, "create-1").Result.Session.HostHarnessSessionID
	provider := providerSession(supervisor.Session(id).ProviderSessionID, workspace, "coffee-shop-managed")
	var handles []OperationHandle
	for range 32 {
		handle, err := supervisor.issueHandle(id)
		require.NoError(t, err)
		handles = append(handles, handle)
	}
	var wait sync.WaitGroup
	for _, handle := range handles {
		wait.Add(1)
		go func() { defer wait.Done(); _ = supervisor.AcceptObservation(handle, provider, nil) }()
	}
	require.NoError(t, supervisor.Shutdown(context.Background()))
	wait.Wait()
	require.ErrorIs(t, supervisor.AcceptObservation(handles[0], provider, nil), ErrShuttingDown)
}

func removeString(values []string, target string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value != target {
			result = append(result, value)
		}
	}
	return result
}

func TestBoundedDiagnosticRedactsAndBoundsDiscoveryErrors(t *testing.T) {
	value := boundedDiagnostic(strings.Repeat("x", protocol.HostHarnessSessionLimits.DiagnosticBytes+10))
	require.Len(t, value, protocol.HostHarnessSessionLimits.DiagnosticBytes)
}
