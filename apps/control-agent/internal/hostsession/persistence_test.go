package hostsession

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

type failBarrier struct {
	point string
	fired bool
}

func (barrier *failBarrier) Reach(point string) error {
	if !barrier.fired && point == barrier.point {
		barrier.fired = true
		return errors.New("simulated process stop")
	}
	return nil
}

func testOptions(root string, driver Driver) Options {
	return Options{NodeID: "node-1", DataRoot: filepath.Join(root, "data"), WorkspaceRoots: []string{root}, Drivers: []Driver{driver},
		Clock: &fakeClock{now: time.Date(2026, 9, 30, 14, 0, 0, 0, time.UTC)}, IDs: &fakeIDs{}}
}

func TestCrashCutPointsNeverRepeatAProviderEffect(t *testing.T) {
	for _, test := range []struct {
		point     string
		wantCalls int
	}{{BarrierAfterPending, 0}, {BarrierAfterEffect, 1}, {BarrierAfterRegistry, 1}} {
		t.Run(test.point, func(t *testing.T) {
			root := t.TempDir()
			workspace := filepath.Join(root, "workspace")
			require.NoError(t, os.Mkdir(workspace, 0o700))
			driver := newFakeDriver()
			options := testOptions(root, driver)
			options.Barrier = &failBarrier{point: test.point}
			supervisor, err := New(options)
			require.NoError(t, err)
			message := signed(t, protocol.HostSessionHubMessage{Type: "host-session.create", NodeID: "node-1", CommandID: "crash-command", RequestID: "crash-request", HarnessID: "codex-cli", Workspace: workspace})
			require.Error(t, supervisor.Execute(context.Background(), message).Err)
			require.Equal(t, test.wantCalls, driver.count("create"))

			options.Barrier = nil
			restarted, err := New(options)
			require.NoError(t, err)
			replay := restarted.Execute(context.Background(), message)
			require.Error(t, replay.Err)
			require.Equal(t, "uncertain", replay.Result.Outcome)
			require.Equal(t, test.wantCalls, driver.count("create"))
		})
	}
}

func TestCheckedInPersistenceFixturesAreByteFaithfulRealProducerOutput(t *testing.T) {
	dataRoot := t.TempDir()
	registryFixture, err := os.ReadFile(filepath.Join("testdata", "registry-v1.json"))
	require.NoError(t, err)
	ledgerFixture, err := os.ReadFile(filepath.Join("testdata", "ledger-v1.json"))
	require.NoError(t, err)
	observation := protocol.HostHarnessSessionObservation{HostHarnessSessionID: "hs-fixture", NodeID: "node-1", HarnessID: "codex-cli", ProviderSessionID: "provider-fixture",
		Workspace: "/srv/workspaces/project", Source: "provider-history", Status: "idle", ControlMode: "full",
		Operations: []string{"attach", "close", "detach", "interrupt", "read-history", "resolve-approval", "start-turn", "steer"}, Revision: 1,
		CreatedAt: "2026-09-30T12:00:00Z", UpdatedAt: "2026-09-30T12:00:00Z"}
	require.NoError(t, saveRegistry(dataRoot, map[string]*sessionRecord{"hs-fixture": {Observation: observation}}))
	require.NoError(t, saveLedger(dataRoot, map[string]*ledgerRecord{"command-fixture": {CommandID: "command-fixture", Digest: strings.Repeat("a", 64), Operation: "create",
		RequestID: "request-fixture", HarnessID: "codex-cli", Workspace: "/srv/workspaces/project", State: "pending", UpdatedAt: "2026-09-30T12:00:01Z"}}))
	producedRegistry, err := os.ReadFile(filepath.Join(dataRoot, registryName))
	require.NoError(t, err)
	producedLedger, err := os.ReadFile(filepath.Join(dataRoot, ledgerName))
	require.NoError(t, err)
	require.Equal(t, registryFixture, producedRegistry)
	require.Equal(t, ledgerFixture, producedLedger)
	loadedRegistry, err := loadRegistry(dataRoot)
	require.NoError(t, err)
	require.Len(t, loadedRegistry, 1)
	loadedLedger, err := loadLedger(dataRoot)
	require.NoError(t, err)
	require.Len(t, loadedLedger, 1)
}

func TestUncertainCommandCanBeConclusiveReconciledWithoutRepeatingEffect(t *testing.T) {
	root := t.TempDir()
	workspace := filepath.Join(root, "workspace")
	require.NoError(t, os.Mkdir(workspace, 0o700))
	driver := newFakeDriver()
	options := testOptions(root, driver)
	options.Barrier = &failBarrier{point: BarrierAfterEffect}
	supervisor, err := New(options)
	require.NoError(t, err)
	message := signed(t, protocol.HostSessionHubMessage{Type: "host-session.create", NodeID: "node-1", CommandID: "create-uncertain", RequestID: "request-uncertain", HarnessID: "codex-cli", Workspace: workspace})
	require.Error(t, supervisor.Execute(context.Background(), message).Err)
	require.Equal(t, 1, driver.count("create"))
	options.Barrier = nil
	restarted, err := New(options)
	require.NoError(t, err)
	reconciled := restarted.Reconcile(context.Background(), "create-uncertain")
	require.NoError(t, reconciled.Err)
	require.Equal(t, "succeeded", reconciled.Result.Outcome)
	require.Equal(t, 1, driver.count("create"))
	require.Equal(t, 1, driver.count("reconcile"))
	require.Len(t, restarted.Snapshot(), 1)
	require.NoError(t, restarted.Inspect(context.Background(), reconciled.Result.Session.HostHarnessSessionID))
	require.NoError(t, restarted.Resume(context.Background(), reconciled.Result.Session.HostHarnessSessionID))
}

func TestCorruptFutureAndCrossRecordStateDisableOnlyInteractiveCoreAndPreserveEvidence(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(t *testing.T, supervisor *Supervisor, sessionID string)
	}{
		{"corrupt-registry", func(t *testing.T, supervisor *Supervisor, _ string) {
			require.NoError(t, os.WriteFile(filepath.Join(supervisor.dataRoot, registryName), []byte("{not-json"), 0o600))
		}},
		{"future-registry", func(t *testing.T, supervisor *Supervisor, _ string) {
			payload := registryPayload{Sessions: []sessionRecord{}}
			digest, err := checksum(payload)
			require.NoError(t, err)
			require.NoError(t, atomicJSON(filepath.Join(supervisor.dataRoot, registryName), registryDocument{Version: 99, Checksum: digest, Payload: payload}))
		}},
		{"cross-record", func(t *testing.T, supervisor *Supervisor, _ string) {
			supervisor.commands["attach-1"].HostHarnessSessionID = "missing-session"
			require.NoError(t, saveLedger(supervisor.dataRoot, supervisor.commands))
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			driver := newFakeDriver()
			supervisor, workspace := newTestSupervisor(t, driver)
			created := createSession(t, supervisor, workspace, "create-1")
			id := created.Result.Session.HostHarnessSessionID
			epoch := int64(0)
			attached := supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.attach", NodeID: "node-1", CommandID: "attach-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, ThreadID: "thread-1", ExpectedStatus: "idle"}))
			require.NoError(t, attached.Err)
			test.mutate(t, supervisor, id)
			registryBefore, registryErr := os.ReadFile(filepath.Join(supervisor.dataRoot, registryName))
			ledgerBefore, ledgerErr := os.ReadFile(filepath.Join(supervisor.dataRoot, ledgerName))

			restarted, err := New(Options{NodeID: "node-1", DataRoot: supervisor.dataRoot, WorkspaceRoots: supervisor.workspaceRoots, Drivers: []Driver{driver}})
			require.NoError(t, err)
			usable, diagnostic := restarted.Usable()
			require.False(t, usable)
			require.NotEmpty(t, diagnostic)
			if registryErr == nil {
				after, err := os.ReadFile(filepath.Join(supervisor.dataRoot, registryName))
				require.NoError(t, err)
				require.Equal(t, registryBefore, after)
			}
			if ledgerErr == nil {
				after, err := os.ReadFile(filepath.Join(supervisor.dataRoot, ledgerName))
				require.NoError(t, err)
				require.Equal(t, ledgerBefore, after)
			}
			require.ErrorIs(t, createSession(t, restarted, workspace, "disabled-create").Err, ErrDisabled)
		})
	}
}

func TestAdoptionThreeTurnsHistoryCloseAndSecretExclusion(t *testing.T) {
	driver := newFakeDriver()
	driver.summary = "credential ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	supervisor, workspace := newTestSupervisor(t, driver)
	created := createSession(t, supervisor, workspace, "create-1")
	require.NoError(t, created.Err)
	require.Equal(t, "provider diagnostic redacted", created.Result.Session.Summary)
	id := created.Result.Session.HostHarnessSessionID
	epoch := int64(0)
	require.NoError(t, supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.attach", NodeID: "node-1", CommandID: "attach-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, ThreadID: "thread-1", ExpectedStatus: "idle"})).Err)
	epoch = 1
	for turn := 1; turn <= 3; turn++ {
		response := supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.turn.start", NodeID: "node-1", CommandID: "turn-" + string(rune('0'+turn)), HostHarnessSessionID: id, AttachmentEpoch: &epoch, RunID: "run-" + string(rune('0'+turn)), Prompt: "private prompt must not persist"}))
		require.NoError(t, response.Err)
		require.Equal(t, "idle", response.Result.Session.Status)
	}
	require.Equal(t, 3, driver.count("start-turn"))
	historyMessage := signed(t, protocol.HostSessionHubMessage{Type: "host-session.history.read", NodeID: "node-1", CommandID: "history-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, RequestID: "history-request", Limit: 10})
	history, err := supervisor.ReadHistory(context.Background(), historyMessage)
	require.NoError(t, err)
	require.Len(t, history.Items, 1)
	closed := supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.close", NodeID: "node-1", CommandID: "close-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch}))
	require.NoError(t, closed.Err)
	require.Equal(t, "closed", closed.Result.Session.Status)

	registry, err := os.ReadFile(filepath.Join(supervisor.dataRoot, registryName))
	require.NoError(t, err)
	ledger, err := os.ReadFile(filepath.Join(supervisor.dataRoot, ledgerName))
	require.NoError(t, err)
	for _, bytes := range [][]byte{registry, ledger} {
		text := string(bytes)
		require.NotContains(t, text, "private prompt")
		require.NotContains(t, text, "ghp_")
	}

	adopt := supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.adopt", NodeID: "node-1", CommandID: "adopt-conflict", RequestID: "adopt-request", HarnessID: "codex-cli", ProviderSessionID: created.Result.Session.ProviderSessionID, Workspace: workspace}))
	require.Error(t, adopt.Err)
	require.Equal(t, "uncertain", adopt.Result.Outcome)
	require.Len(t, supervisor.Snapshot(), 1)
}

func TestHistoryBoundsAndRetentionKeepUncertainCommands(t *testing.T) {
	driver := newFakeDriver()
	supervisor, workspace := newTestSupervisor(t, driver)
	supervisor.maximumCommands = 1
	created := createSession(t, supervisor, workspace, "create-1")
	id := created.Result.Session.HostHarnessSessionID
	epoch := int64(0)
	require.NoError(t, supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.attach", NodeID: "node-1", CommandID: "attach-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, ThreadID: "thread-1", ExpectedStatus: "idle"})).Err)
	epoch = 1
	driver.history = HistoryPage{Items: []protocol.HostHarnessSessionHistoryItem{{ID: "oversized", Kind: "assistant", Text: strings.Repeat("x", protocol.HostHarnessSessionLimits.HistoryItemTextBytes+1)}}}
	message := signed(t, protocol.HostSessionHubMessage{Type: "host-session.history.read", NodeID: "node-1", CommandID: "history-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, RequestID: "request-1", Limit: 1})
	_, err := supervisor.ReadHistory(context.Background(), message)
	require.ErrorIs(t, err, ErrInvalidObservation)

	uncertain := &ledgerRecord{CommandID: "uncertain-1", Digest: strings.Repeat("a", 64), Operation: "start-turn", HostHarnessSessionID: id, AttachmentEpoch: epoch, State: "uncertain", UpdatedAt: supervisor.now()}
	supervisor.commands[uncertain.CommandID] = uncertain
	require.NoError(t, supervisor.Acknowledge("create-1"))
	require.Contains(t, supervisor.commands, "uncertain-1")
	require.NotContains(t, supervisor.commands, "create-1")
}

func TestGeneratedHostSessionIDCollisionNeverOverwritesAnExistingSession(t *testing.T) {
	driver := newFakeDriver()
	supervisor, workspace := newTestSupervisor(t, driver)
	first := createSession(t, supervisor, workspace, "create-1")
	require.NoError(t, first.Err)
	firstProvider := first.Result.Session.ProviderSessionID
	supervisor.ids = &fakeIDs{}
	second := createSession(t, supervisor, workspace, "create-2")
	require.Error(t, second.Err)
	require.Equal(t, "uncertain", second.Result.Outcome)
	require.Len(t, supervisor.Snapshot(), 1)
	require.Equal(t, firstProvider, supervisor.Snapshot()[0].ProviderSessionID)
}

func TestClosedAcknowledgedSessionCanBeForgottenWithoutBreakingRestart(t *testing.T) {
	driver := newFakeDriver()
	supervisor, workspace := newTestSupervisor(t, driver)
	created := createSession(t, supervisor, workspace, "create-1")
	id := created.Result.Session.HostHarnessSessionID
	epoch := int64(0)
	require.NoError(t, supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.attach", NodeID: "node-1", CommandID: "attach-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, ThreadID: "thread-1", ExpectedStatus: "idle"})).Err)
	epoch = 1
	require.NoError(t, supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.close", NodeID: "node-1", CommandID: "close-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch})).Err)
	require.Error(t, supervisor.ForgetClosed(id))
	require.NoError(t, supervisor.Acknowledge("attach-1"))
	require.NoError(t, supervisor.Acknowledge("close-1"))
	require.NoError(t, supervisor.ForgetClosed(id))
	require.Empty(t, supervisor.Snapshot())
	restarted, err := New(Options{NodeID: "node-1", DataRoot: supervisor.dataRoot, WorkspaceRoots: supervisor.workspaceRoots, Drivers: []Driver{driver}})
	require.NoError(t, err)
	usable, diagnostic := restarted.Usable()
	require.True(t, usable, diagnostic)
}
