package hostsession

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

type limitedDriver struct {
	*fakeDriver
	capabilities CapabilitySet
}

func (driver *limitedDriver) Capabilities() CapabilitySet { return driver.capabilities }

type callbackCaptureDriver struct {
	*fakeDriver
	captured func(protocol.HarnessEvent) error
	event    *protocol.HarnessEvent
}

func (driver *callbackCaptureDriver) StartTurn(ctx context.Context, request SessionRequest) (DriverSession, error) {
	driver.captured = request.Emit
	if driver.event != nil {
		if err := request.Emit(*driver.event); err != nil {
			return DriverSession{}, err
		}
	}
	return driver.fakeDriver.StartTurn(ctx, request)
}

func startCommand(t *testing.T, hostID, commandID, runID, prompt string) protocol.HostSessionHubMessage {
	t.Helper()
	epoch := int64(1)
	return commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.turn.start", NodeID: "node-one", CommandID: commandID,
		HostHarnessSessionID: hostID, AttachmentEpoch: &epoch, RunID: runID, Prompt: prompt,
	})
}

func TestCommandReplayConflictPendingRecoveryAndCallerCancellationNeverDuplicateEffects(t *testing.T) {
	dataRoot := t.TempDir()
	workspace := t.TempDir()
	driver := newFakeDriver(workspace)
	supervisor := newTestSupervisor(t, dataRoot, workspace, driver)
	attachDiscoveredSession(t, supervisor, "codex-cli", "provider-existing", workspace, "host-session-one", "thread-one")

	release := make(chan struct{})
	driver.mu.Lock()
	driver.block = map[string]<-chan struct{}{"start-turn": release}
	driver.entered = make(chan string, 2)
	driver.mu.Unlock()
	command := startCommand(t, "host-session-one", "command-pending", "run-pending", "secret-free prompt")

	callerContext, cancelCaller := context.WithCancel(context.Background())
	firstResult := make(chan CommandResponse, 1)
	go func() { firstResult <- supervisor.Execute(callerContext, command) }()
	require.Equal(t, "provider-existing", <-driver.entered)
	cancelCaller()

	replayWhilePending := make(chan CommandResponse, 1)
	go func() { replayWhilePending <- supervisor.Execute(context.Background(), command) }()
	select {
	case <-replayWhilePending:
		t.Fatal("an in-process duplicate must wait for the original durable result")
	case <-time.After(20 * time.Millisecond):
	}
	require.Equal(t, 1, driver.callCount("start-turn"))

	restarted := newTestSupervisor(t, dataRoot, workspace, driver)
	replayAfterRestart := restarted.Execute(context.Background(), command)
	require.Equal(t, "uncertain", replayAfterRestart.Result.Outcome)
	require.Equal(t, 1, driver.callCount("start-turn"))

	changed := command
	changed.Prompt = "changed semantic payload"
	changed = commandDigest(t, changed)
	conflict := restarted.Execute(context.Background(), changed)
	require.Equal(t, "rejected", conflict.Result.Outcome)
	require.Equal(t, "idempotency-conflict", conflict.Result.Code)
	require.Equal(t, 1, driver.callCount("start-turn"))

	close(release)
	first := <-firstResult
	duplicate := <-replayWhilePending
	require.Equal(t, "succeeded", first.Result.Outcome)
	require.Equal(t, "succeeded", duplicate.Result.Outcome)
	require.Equal(t, responseSemanticJSON(t, first), responseSemanticJSON(t, duplicate))
	require.Equal(t, 1, driver.callCount("start-turn"))
}

func TestPerSessionSerializationStillLetsIndependentSessionsProgress(t *testing.T) {
	dataRoot := t.TempDir()
	workspace := t.TempDir()
	driver := newFakeDriver(workspace)
	driver.sessions["provider-second"] = DriverSession{
		ProviderSessionID: "provider-second", Workspace: workspace, Source: "provider-history",
		Status: "idle", ControlMode: "resume", Operations: []string{"attach", "close", "detach", "interrupt", "read-history", "resolve-approval", "start-turn", "steer"},
	}
	supervisor := newTestSupervisor(t, dataRoot, workspace, driver)
	attachDiscoveredSession(t, supervisor, "codex-cli", "provider-existing", workspace, "host-session-one", "thread-one")
	attachDiscoveredSession(t, supervisor, "codex-cli", "provider-second", workspace, "host-session-two", "thread-two")

	release := make(chan struct{})
	driver.mu.Lock()
	driver.block = map[string]<-chan struct{}{"start-turn": release}
	driver.entered = make(chan string, 4)
	driver.mu.Unlock()
	first := startCommand(t, "host-session-one", "command-first", "run-first", "first")
	second := startCommand(t, "host-session-two", "command-second", "run-second", "second")
	responses := make(chan CommandResponse, 2)
	go func() { responses <- supervisor.Execute(context.Background(), first) }()
	go func() { responses <- supervisor.Execute(context.Background(), second) }()
	entered := map[string]bool{<-driver.entered: true, <-driver.entered: true}
	require.True(t, entered["provider-existing"])
	require.True(t, entered["provider-second"])

	busy := startCommand(t, "host-session-one", "command-busy", "run-busy", "busy")
	busyResponse := supervisor.Execute(context.Background(), busy)
	require.Equal(t, "rejected", busyResponse.Result.Outcome)
	require.Equal(t, "session-busy", busyResponse.Result.Code)
	require.Equal(t, 2, driver.callCount("start-turn"))

	close(release)
	require.Equal(t, "succeeded", (<-responses).Result.Outcome)
	require.Equal(t, "succeeded", (<-responses).Result.Outcome)
}

func TestEpochWorkspaceCapabilityAndNormalizedEventFencesRunBeforeDriverAccess(t *testing.T) {
	dataRoot := t.TempDir()
	root := t.TempDir()
	workspace := filepath.Join(root, "workspace")
	require.NoError(t, os.Mkdir(workspace, 0o700))
	driver := newFakeDriver(workspace)
	driver.emit = true
	supervisor := newTestSupervisor(t, dataRoot, root, driver)
	attachDiscoveredSession(t, supervisor, "codex-cli", "provider-existing", workspace, "host-session-one", "thread-one")

	staleEpoch := int64(0)
	stale := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.turn.start", NodeID: "node-one", CommandID: "command-stale",
		HostHarnessSessionID: "host-session-one", AttachmentEpoch: &staleEpoch,
		RunID: "run-stale", Prompt: "prompt",
	})
	result := supervisor.Execute(context.Background(), stale)
	require.Equal(t, "attachment-epoch-conflict", result.Result.Code)
	require.Equal(t, 0, driver.callCount("start-turn"))

	command := startCommand(t, "host-session-one", "command-event", "run-event", "prompt")
	result = supervisor.Execute(context.Background(), command)
	require.Equal(t, "succeeded", result.Result.Outcome)
	select {
	case update := <-supervisor.Updates():
		// Discovery/adoption/attachment observations can precede the event.
		for update.Event == nil {
			update = <-supervisor.Updates()
		}
		require.Equal(t, "message.delta", update.Event.Type)
		require.Equal(t, "run-event", update.Event.RunID)
	case <-time.After(time.Second):
		t.Fatal("normalized event was not published")
	}

	alternate := filepath.Join(root, "alternate")
	require.NoError(t, os.Mkdir(alternate, 0o700))
	require.NoError(t, os.Remove(workspace))
	require.NoError(t, os.Symlink(alternate, workspace))
	_, snapshotErr := supervisor.Snapshot()
	require.ErrorContains(t, snapshotErr, "workspace is no longer authorized")
	epoch := int64(1)
	closeCommand := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.close", NodeID: "node-one", CommandID: "command-close",
		HostHarnessSessionID: "host-session-one", AttachmentEpoch: &epoch,
	})
	result = supervisor.Execute(context.Background(), closeCommand)
	require.Equal(t, "workspace-unauthorized", result.Result.Code)
	require.Equal(t, 0, driver.callCount("close"))
	reopened, err := Open(Config{DataRoot: dataRoot, NodeID: "node-one", WorkspaceRoots: []string{root}, Drivers: []Driver{driver}})
	require.NoError(t, err)
	require.False(t, reopened.Usable())
}

func TestFutureMissingEpochUnsupportedCapabilityAndTerminalStateRejectBeforeProvider(t *testing.T) {
	dataRoot := t.TempDir()
	workspace := t.TempDir()
	base := newFakeDriver(workspace)
	driver := &limitedDriver{fakeDriver: base, capabilities: NewCapabilitySet(
		OperationDiscover, OperationReadHistory, OperationInspect, OperationAdopt, OperationResume,
		OperationDetach, OperationStartTurn, OperationSteer, OperationInterrupt, OperationResolveApproval,
		OperationRefresh, OperationReconcile,
	)}
	supervisor := newTestSupervisor(t, dataRoot, workspace, driver)
	attachDiscoveredSession(t, supervisor, "codex-cli", "provider-existing", workspace, "host-session-one", "thread-one")

	future := int64(99)
	futureCommand := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.turn.start", NodeID: "node-one", CommandID: "command-future",
		HostHarnessSessionID: "host-session-one", AttachmentEpoch: &future, RunID: "run-future", Prompt: "prompt",
	})
	response := supervisor.Execute(context.Background(), futureCommand)
	require.Equal(t, "attachment-epoch-conflict", response.Result.Code)
	require.Equal(t, 0, base.callCount("start-turn"))

	missing := protocol.HostSessionHubMessage{
		Type: "host-session.turn.start", NodeID: "node-one", CommandID: "command-missing",
		HostHarnessSessionID: "host-session-one", RunID: "run-missing", Prompt: "prompt",
	}
	missing.CommandDigest = strings.Repeat("0", 64)
	response = supervisor.Execute(context.Background(), missing)
	require.Equal(t, "invalid-command", response.Result.Code)
	require.Equal(t, 0, base.callCount("start-turn"))

	epoch := int64(1)
	closeCommand := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.close", NodeID: "node-one", CommandID: "command-unsupported-close",
		HostHarnessSessionID: "host-session-one", AttachmentEpoch: &epoch,
	})
	response = supervisor.Execute(context.Background(), closeCommand)
	require.Equal(t, "unsupported-capability", response.Result.Code)
	require.Equal(t, 0, base.callCount("close"))
}

func TestCorruptionPreservesEvidenceAndSecretsNeverEnterDurableState(t *testing.T) {
	dataRoot := t.TempDir()
	workspace := t.TempDir()
	driver := newFakeDriver(workspace)
	supervisor := newTestSupervisor(t, dataRoot, workspace, driver)
	attachDiscoveredSession(t, supervisor, "codex-cli", "provider-existing", workspace, "host-session-one", "thread-one")

	canary := "CANARY_PROMPT_7f42fbe7"
	command := startCommand(t, "host-session-one", "command-canary", "run-canary", canary)
	require.Equal(t, "succeeded", supervisor.Execute(context.Background(), command).Result.Outcome)
	for _, filename := range []string{registryFilename, ledgerFilename} {
		data, err := os.ReadFile(filepath.Join(dataRoot, "host-sessions", filename))
		require.NoError(t, err)
		require.NotContains(t, string(data), canary)
		require.NotContains(t, strings.ToLower(string(data)), "authorization")
	}

	registryPath := filepath.Join(dataRoot, "host-sessions", registryFilename)
	corrupt, err := os.ReadFile(registryPath)
	require.NoError(t, err)
	corrupt = append(corrupt, byte('x'))
	require.NoError(t, os.WriteFile(registryPath, corrupt, 0o600))
	reopened, err := Open(Config{
		DataRoot: dataRoot, NodeID: "node-one", WorkspaceRoots: []string{workspace}, Drivers: []Driver{driver},
	})
	require.NoError(t, err)
	require.False(t, reopened.Usable())
	require.NotEmpty(t, reopened.Diagnostic())
	preserved, err := os.ReadFile(registryPath)
	require.NoError(t, err)
	require.Equal(t, corrupt, preserved)

	_, snapshotErr := reopened.Snapshot()
	require.Error(t, snapshotErr)
}

func TestOversizedAndSecretCallbacksAreRejectedAndLateCallbacksCannotEscapeTheirOperation(t *testing.T) {
	t.Run("oversized discovery", func(t *testing.T) {
		dataRoot := t.TempDir()
		workspace := t.TempDir()
		driver := newFakeDriver(workspace)
		candidate := driver.sessions["provider-existing"]
		candidate.Summary = strings.Repeat("x", protocol.HostHarnessSessionLimits.DiagnosticBytes+1)
		driver.sessions["provider-existing"] = candidate
		supervisor := newTestSupervisor(t, dataRoot, workspace, driver)
		_, err := supervisor.Discover(context.Background(), "codex-cli")
		require.ErrorContains(t, err, "driver observation is invalid")
		snapshot, err := supervisor.Snapshot()
		require.NoError(t, err)
		require.Empty(t, snapshot)
	})

	t.Run("secret and late callback", func(t *testing.T) {
		dataRoot := t.TempDir()
		workspace := t.TempDir()
		base := newFakeDriver(workspace)
		driver := &callbackCaptureDriver{fakeDriver: base, event: &protocol.HarnessEvent{
			Type: "message.delta", RunID: "run-secret", Sequence: 1, At: "2026-10-06T12:00:00Z",
			Text: "Authorization: Bearer SECRET_CALLBACK_CANARY",
		}}
		supervisor := newTestSupervisor(t, dataRoot, workspace, driver)
		attachDiscoveredSession(t, supervisor, "codex-cli", "provider-existing", workspace, "host-session-one", "thread-one")
		command := startCommand(t, "host-session-one", "command-secret-callback", "run-secret", "prompt")
		response := supervisor.Execute(context.Background(), command)
		require.Equal(t, "uncertain", response.Result.Outcome)
		require.Equal(t, "provider-effect-uncertain", response.Result.Code)

		driver.event = nil
		second := startCommand(t, "host-session-one", "command-capture-callback", "run-late", "prompt")
		// The prior uncertain start intentionally leaves the Coffee Shop observation idle. The fake
		// provider is reset to match before exercising the callback lifetime fence.
		base.mu.Lock()
		provider := base.sessions["provider-existing"]
		provider.Status = "idle"
		provider.ProviderTurnID = ""
		base.sessions["provider-existing"] = provider
		base.mu.Unlock()
		response = supervisor.Execute(context.Background(), second)
		require.Equal(t, "succeeded", response.Result.Outcome)
		require.NotNil(t, driver.captured)
		err := driver.captured(protocol.HarnessEvent{
			Type: "message.delta", RunID: "run-late", Sequence: 2, At: "2026-10-06T12:00:01Z", Text: "late",
		})
		require.NoError(t, err)
		epoch := int64(1)
		interrupt := commandDigest(t, protocol.HostSessionHubMessage{
			Type: "host-session.turn.interrupt", NodeID: "node-one", CommandID: "command-fence-callback",
			HostHarnessSessionID: "host-session-one", AttachmentEpoch: &epoch,
			RunID: "run-late", ProviderTurnID: response.Result.ProviderTurnID,
		})
		interrupted := supervisor.Execute(context.Background(), interrupt)
		require.Equal(t, "succeeded", interrupted.Result.Outcome, interrupted.Result.Code)
		err = driver.captured(protocol.HarnessEvent{
			Type: "message.delta", RunID: "run-late", Sequence: 3, At: "2026-10-06T12:00:02Z", Text: "too late",
		})
		require.ErrorContains(t, err, "late or mismatched")
	})
}

func TestShutdownStopsAdmissionAndBoundsAnUnsettledProviderEffect(t *testing.T) {
	dataRoot := t.TempDir()
	workspace := t.TempDir()
	driver := newFakeDriver(workspace)
	supervisor := newTestSupervisor(t, dataRoot, workspace, driver)
	attachDiscoveredSession(t, supervisor, "codex-cli", "provider-existing", workspace, "host-session-one", "thread-one")
	release := make(chan struct{})
	driver.mu.Lock()
	driver.block = map[string]<-chan struct{}{"start-turn": release}
	driver.entered = make(chan string, 1)
	driver.mu.Unlock()
	command := startCommand(t, "host-session-one", "command-shutdown", "run-shutdown", "prompt")
	result := make(chan CommandResponse, 1)
	go func() { result <- supervisor.Execute(context.Background(), command) }()
	<-driver.entered

	shutdownContext, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	require.ErrorContains(t, supervisor.Shutdown(shutdownContext), "did not settle")
	newCommand := startCommand(t, "host-session-one", "command-after-shutdown", "run-after", "prompt")
	require.Equal(t, "supervision-unavailable", supervisor.Execute(context.Background(), newCommand).Result.Code)
	close(release)
	require.Equal(t, "succeeded", (<-result).Result.Outcome)
}

func TestCommittedMutationSurvivesUpdatePressureAndRequestsResync(t *testing.T) {
	workspace := t.TempDir()
	driver := newFakeDriver(workspace)
	supervisor := newTestSupervisor(t, t.TempDir(), workspace, driver)
	attachDiscoveredSession(t, supervisor, "codex-cli", "provider-existing", workspace, "host-session-one", "thread-one")
	for {
		select {
		case <-supervisor.Updates():
		default:
			goto drained
		}
	}

drained:
	for range cap(supervisor.updates) {
		supervisor.updates <- CoreUpdate{Resync: false}
	}
	response := supervisor.Execute(context.Background(), startCommand(t, "host-session-one", "command-pressure", "run-pressure", "prompt"))
	require.Equal(t, "succeeded", response.Result.Outcome)
	require.Empty(t, response.Result.Code)

	foundResync := false
	for range cap(supervisor.updates) {
		if (<-supervisor.updates).Resync {
			foundResync = true
		}
	}
	require.True(t, foundResync, "overflow must request an authoritative transport generation")
	replayed := supervisor.Execute(context.Background(), startCommand(t, "host-session-one", "command-pressure", "run-pressure", "prompt"))
	require.Equal(t, "replayed", replayed.Ack.Disposition)
	require.Equal(t, "succeeded", replayed.Result.Outcome)
}

func TestUpdatePressureImmediatelyWithdrawsADroppedTrackedApproval(t *testing.T) {
	workspace := t.TempDir()
	supervisor := newTestSupervisor(t, t.TempDir(), workspace, newFakeDriver(workspace))
	for {
		select {
		case <-supervisor.Updates():
		default:
			goto drained
		}
	}

drained:
	delivered := make(chan bool, 1)
	state := &atomic.Int32{}
	supervisor.updates <- CoreUpdate{Delivered: delivered, DeliveryState: state}
	for range cap(supervisor.updates) - 1 {
		supervisor.updates <- CoreUpdate{}
	}
	require.False(t, supervisor.publishUpdate(CoreUpdate{}))
	select {
	case accepted := <-delivered:
		require.False(t, accepted)
	case <-time.After(time.Second):
		t.Fatal("dropped tracked approval was not withdrawn immediately")
	}
	require.Equal(t, int32(-1), state.Load())
}

func TestHistoryReadsHaveBoundedConcurrency(t *testing.T) {
	workspace := t.TempDir()
	driver := newFakeDriver(workspace)
	supervisor := newTestSupervisor(t, t.TempDir(), workspace, driver)
	discovered, err := supervisor.Discover(context.Background(), "codex-cli")
	require.NoError(t, err)
	require.Len(t, discovered, 1)
	release := make(chan struct{})
	driver.mu.Lock()
	driver.block = map[string]<-chan struct{}{"read-history": release}
	driver.entered = make(chan string, maxConcurrentHistoryReads)
	driver.mu.Unlock()
	results := make(chan error, maxConcurrentHistoryReads)
	for index := range maxConcurrentHistoryReads {
		go func(index int) {
			_, readErr := supervisor.ReadHistory(context.Background(), discovered[0].HostHarnessSessionID, fmt.Sprintf("request-history-%d", index), "", 1)
			results <- readErr
		}(index)
	}
	for range maxConcurrentHistoryReads {
		<-driver.entered
	}
	_, err = supervisor.ReadHistory(context.Background(), discovered[0].HostHarnessSessionID, "request-history-overflow", "", 1)
	require.ErrorContains(t, err, "history-busy")
	close(release)
	for range maxConcurrentHistoryReads {
		require.NoError(t, <-results)
	}
}

func TestAcknowledgedOutcomeLeavesReplayWindowButStopsReconnectPublication(t *testing.T) {
	workspace := t.TempDir()
	driver := newFakeDriver(workspace)
	supervisor := newTestSupervisor(t, t.TempDir(), workspace, driver)
	attachDiscoveredSession(t, supervisor, "codex-cli", "provider-existing", workspace, "host-session-one", "thread-one")
	command := startCommand(t, "host-session-one", "command-acknowledged", "run-acknowledged", "prompt")
	response := supervisor.Execute(context.Background(), command)
	require.Equal(t, "succeeded", response.Result.Outcome)
	require.True(t, slices.ContainsFunc(supervisor.Outcomes(), func(outcome protocol.HostSessionControlMessage) bool {
		return outcome.CommandID == command.CommandID
	}))
	supervisor.AcknowledgeOutcome(command.CommandID)
	require.False(t, slices.ContainsFunc(supervisor.Outcomes(), func(outcome protocol.HostSessionControlMessage) bool {
		return outcome.CommandID == command.CommandID
	}))
	replayed := supervisor.Execute(context.Background(), command)
	require.Equal(t, "replayed", replayed.Ack.Disposition)
	require.Equal(t, "succeeded", replayed.Result.Outcome)
}
