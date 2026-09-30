package hostsession

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

type blockingBarrier struct {
	point   string
	entered chan struct{}
	release chan struct{}
}

func (barrier *blockingBarrier) Reach(point string) error {
	if point == barrier.point {
		close(barrier.entered)
		<-barrier.release
	}
	return nil
}

func TestForgetClosedSerializesWithObservationRefresh(t *testing.T) {
	driver := newFakeDriver()
	supervisor, workspace := newTestSupervisor(t, driver)
	created := createSession(t, supervisor, workspace, "create-1")
	id := created.Result.Session.HostHarnessSessionID
	epoch := int64(0)
	require.NoError(t, supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.close", NodeID: "node-1", CommandID: "close-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch})).Err)
	require.NoError(t, supervisor.Acknowledge("create-1"))
	require.NoError(t, supervisor.Acknowledge("close-1"))

	driver.entered = make(chan string)
	driver.release = make(chan struct{})
	refreshDone := make(chan error, 1)
	go func() { refreshDone <- supervisor.Refresh(context.Background(), id) }()
	require.Equal(t, "refresh", <-driver.entered)
	require.ErrorIs(t, supervisor.ForgetClosed(id), ErrSessionBusy)
	close(driver.release)
	require.NoError(t, <-refreshDone)
	require.NoError(t, supervisor.ForgetClosed(id))
	require.Empty(t, supervisor.Snapshot())
}

func TestForgetClosedCrashCutsRecoverTheWholeTransaction(t *testing.T) {
	for _, point := range []string{BarrierAfterForgetIntent, BarrierAfterForgetRegistry, BarrierAfterForgetLedger} {
		t.Run(point, func(t *testing.T) {
			root := t.TempDir()
			workspace := filepath.Join(root, "workspace")
			require.NoError(t, os.Mkdir(workspace, 0o700))
			driver := newFakeDriver()
			options := testOptions(root, driver)
			supervisor, err := New(options)
			require.NoError(t, err)
			created := createSession(t, supervisor, workspace, "create-1")
			id := created.Result.Session.HostHarnessSessionID
			epoch := int64(0)
			require.NoError(t, supervisor.Execute(context.Background(), signed(t, protocol.HostSessionHubMessage{Type: "host-session.close", NodeID: "node-1", CommandID: "close-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch})).Err)
			require.NoError(t, supervisor.Acknowledge("create-1"))
			require.NoError(t, supervisor.Acknowledge("close-1"))

			supervisor.barrier = &failBarrier{point: point}
			require.Error(t, supervisor.ForgetClosed(id))
			require.FileExists(t, filepath.Join(supervisor.dataRoot, forgetTransactionName))
			intent, err := loadForgetTransaction(supervisor.dataRoot)
			require.NoError(t, err)
			require.Equal(t, id, intent.Observation.HostHarnessSessionID)
			durableSessions, err := loadRegistry(supervisor.dataRoot)
			require.NoError(t, err)
			durableCommands, err := loadLedger(supervisor.dataRoot)
			require.NoError(t, err)
			if point == BarrierAfterForgetIntent {
				require.Contains(t, durableSessions, id)
				require.Len(t, durableCommands, 2)
			} else {
				require.NotContains(t, durableSessions, id)
				if point == BarrierAfterForgetRegistry {
					require.Len(t, durableCommands, 2)
				} else {
					require.Empty(t, durableCommands)
				}
			}

			options.Barrier = nil
			restarted, err := New(options)
			require.NoError(t, err)
			usable, diagnostic := restarted.Usable()
			require.True(t, usable, diagnostic)
			require.Empty(t, restarted.Snapshot())
			require.Empty(t, restarted.commands)
			require.NoFileExists(t, filepath.Join(supervisor.dataRoot, forgetTransactionName))
		})
	}
}

func TestAttachmentCannotOverwriteConcurrentTerminalObservation(t *testing.T) {
	driver := newFakeDriver()
	supervisor, workspace := newTestSupervisor(t, driver)
	id := createSession(t, supervisor, workspace, "create-1").Result.Session.HostHarnessSessionID
	handle, err := supervisor.issueHandle(id)
	require.NoError(t, err)
	barrier := &blockingBarrier{point: BarrierAfterPending, entered: make(chan struct{}), release: make(chan struct{})}
	supervisor.barrier = barrier
	epoch := int64(0)
	attach := signed(t, protocol.HostSessionHubMessage{Type: "host-session.attach", NodeID: "node-1", CommandID: "attach-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, ThreadID: "thread-1", ExpectedStatus: "idle"})
	result := make(chan CommandResponse, 1)
	go func() { result <- supervisor.Execute(context.Background(), attach) }()
	<-barrier.entered
	provider := providerSession(supervisor.Session(id).ProviderSessionID, workspace, "coffee-shop-managed")
	provider.Status = "closed"
	require.NoError(t, supervisor.AcceptObservation(handle, provider, nil))
	close(barrier.release)
	response := <-result
	require.Error(t, response.Err)
	require.Equal(t, "closed", supervisor.Session(id).Status)
	require.Empty(t, supervisor.Session(id).AttachedThreadID)
}

func TestHistoryItemIdentityAndTimestampBounds(t *testing.T) {
	driver := newFakeDriver()
	supervisor, workspace := newTestSupervisor(t, driver)
	id := createSession(t, supervisor, workspace, "create-1").Result.Session.HostHarnessSessionID
	epoch := int64(0)
	message := signed(t, protocol.HostSessionHubMessage{Type: "host-session.history.read", NodeID: "node-1", CommandID: "history-1", HostHarnessSessionID: id, AttachmentEpoch: &epoch, RequestID: "request-1", Limit: 1})
	validTimestamp := "2026-09-30T12:34:56.123456789Z"
	validIdentifier := strings.Repeat("i", protocol.HostHarnessSessionLimits.IdentifierBytes)
	driver.history = HistoryPage{Items: []protocol.HostHarnessSessionHistoryItem{{ID: validIdentifier, Kind: "assistant", Text: "bounded", ProviderTurnID: validIdentifier, At: validTimestamp}}}
	_, err := supervisor.ReadHistory(context.Background(), message)
	require.NoError(t, err)

	invalid := []protocol.HostHarnessSessionHistoryItem{
		{ID: "", Kind: "assistant", Text: "bounded"},
		{ID: strings.Repeat("i", protocol.HostHarnessSessionLimits.IdentifierBytes+1), Kind: "assistant", Text: "bounded"},
		{ID: "item", Kind: "assistant", Text: "bounded", ProviderTurnID: strings.Repeat("t", protocol.HostHarnessSessionLimits.IdentifierBytes+1)},
		{ID: "item", Kind: "assistant", Text: "bounded", At: strings.Repeat("2", protocol.HostHarnessSessionLimits.IdentifierBytes+1)},
		{ID: "item", Kind: "assistant", Text: "bounded", At: "2026-02-30T00:00:00Z"},
	}
	for index, item := range invalid {
		driver.history = HistoryPage{Items: []protocol.HostHarnessSessionHistoryItem{item}}
		message.CommandID = "history-invalid-" + string(rune('0'+index))
		message = signed(t, message)
		_, err := supervisor.ReadHistory(context.Background(), message)
		require.ErrorIs(t, err, ErrInvalidObservation)
	}
}
