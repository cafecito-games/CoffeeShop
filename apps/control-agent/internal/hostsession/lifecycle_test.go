package hostsession

import (
	"context"
	"testing"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

func TestManagedLifecycleCoversCreateSteerApprovalRefreshReconcileDetachAndClose(t *testing.T) {
	dataRoot := t.TempDir()
	workspace := t.TempDir()
	driver := newFakeDriver(workspace)
	supervisor := newTestSupervisor(t, dataRoot, workspace, driver)

	create := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.create", NodeID: "node-one", RequestID: "request-create",
		CommandID: "command-create", HarnessID: "codex-cli", Workspace: workspace, Model: "model-one",
	})
	created := supervisor.Execute(context.Background(), create)
	require.Equal(t, "succeeded", created.Result.Outcome)
	require.NotNil(t, created.Result.Session)
	require.Equal(t, "provider-created", created.Result.Session.ProviderSessionID)
	hostID := created.Result.Session.HostHarnessSessionID

	epoch := int64(0)
	attach := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.attach", NodeID: "node-one", CommandID: "command-attach-created",
		HostHarnessSessionID: hostID, AttachmentEpoch: &epoch, ThreadID: "thread-created", ExpectedStatus: "idle",
	})
	attached := supervisor.Execute(context.Background(), attach)
	require.Equal(t, "succeeded", attached.Result.Outcome)
	epoch++

	start := startCommand(t, hostID, "command-start-created", "run-created", "prompt")
	started := supervisor.Execute(context.Background(), start)
	require.Equal(t, "succeeded", started.Result.Outcome)
	providerTurnID := started.Result.ProviderTurnID

	steer := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.turn.steer", NodeID: "node-one", CommandID: "command-steer",
		HostHarnessSessionID: hostID, AttachmentEpoch: &epoch, RunID: "run-created",
		ProviderTurnID: providerTurnID, Text: "steer text",
	})
	require.Equal(t, "succeeded", supervisor.Execute(context.Background(), steer).Result.Outcome)

	driver.mu.Lock()
	waiting := driver.sessions["provider-created"]
	waiting.Status = "awaiting-approval"
	driver.sessions["provider-created"] = waiting
	driver.mu.Unlock()
	refreshed, err := supervisor.Refresh(context.Background(), hostID)
	require.NoError(t, err)
	require.Equal(t, "awaiting-approval", refreshed.Status)

	approval := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.approval.decision", NodeID: "node-one", CommandID: "command-approval",
		HostHarnessSessionID: hostID, AttachmentEpoch: &epoch, RunID: "run-created", ProviderTurnID: providerTurnID,
		Decision: &protocol.ApprovalDecision{ApprovalID: "approval-one", RunID: "run-created", Status: "approved", SelectedOptionID: "allow-once"},
	})
	require.Equal(t, "succeeded", supervisor.Execute(context.Background(), approval).Result.Outcome)

	interrupt := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.turn.interrupt", NodeID: "node-one", CommandID: "command-interrupt-created",
		HostHarnessSessionID: hostID, AttachmentEpoch: &epoch, RunID: "run-created", ProviderTurnID: providerTurnID,
	})
	require.Equal(t, "succeeded", supervisor.Execute(context.Background(), interrupt).Result.Outcome)
	reconciled, err := supervisor.Reconcile(context.Background(), hostID)
	require.NoError(t, err)
	require.Equal(t, "idle", reconciled.Status)

	detach := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.detach", NodeID: "node-one", CommandID: "command-detach",
		HostHarnessSessionID: hostID, AttachmentEpoch: &epoch, ThreadID: "thread-created",
	})
	detached := supervisor.Execute(context.Background(), detach)
	require.Equal(t, "succeeded", detached.Result.Outcome)
	require.Equal(t, "Managed thread", detached.Result.Session.Summary)
	epoch++

	closeCommand := commandDigest(t, protocol.HostSessionHubMessage{
		Type: "host-session.close", NodeID: "node-one", CommandID: "command-close-created",
		HostHarnessSessionID: hostID, AttachmentEpoch: &epoch,
	})
	closed := supervisor.Execute(context.Background(), closeCommand)
	require.Equal(t, "succeeded", closed.Result.Outcome)
	require.Equal(t, "closed", closed.Result.Session.Status)
	require.Equal(t, "Managed thread", closed.Result.Session.Summary)
	secondClose := closeCommand
	secondClose.CommandID = "command-close-created-again"
	secondClose = commandDigest(t, secondClose)
	require.Equal(t, "illegal-transition", supervisor.Execute(context.Background(), secondClose).Result.Code)

	require.Equal(t, 1, driver.callCount("create"))
	require.Equal(t, 1, driver.callCount("resume"))
	require.Equal(t, 1, driver.callCount("steer"))
	require.Equal(t, 1, driver.callCount("resolve-approval"))
	require.Equal(t, 1, driver.callCount("refresh"))
	require.Equal(t, 1, driver.callCount("reconcile"))
	require.Equal(t, 1, driver.callCount("detach"))
	require.Equal(t, 1, driver.callCount("close"))
}
