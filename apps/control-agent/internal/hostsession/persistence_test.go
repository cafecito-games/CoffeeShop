package hostsession

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

func retentionRecord(id, status, updated string, attached bool) registryRecord {
	session := protocol.HostHarnessSession{
		HostHarnessSessionObservation: protocol.HostHarnessSessionObservation{
			HostHarnessSessionID: id, NodeID: "node-one", HarnessID: "codex-cli", ProviderSessionID: "provider-" + id,
			Workspace: "/workspace", Source: "provider-history", Status: status, ControlMode: "observe",
			Operations: []string{"read-history"}, Revision: 1, CreatedAt: updated, UpdatedAt: updated,
		},
	}
	if attached {
		session.AttachedThreadID = "thread-" + id
	}
	return registryRecord{Session: session}
}

func openTestSupervisorWithFailpoint(t *testing.T, dataRoot, workspace string, driver Driver, failpoint func(string) error) *Supervisor {
	t.Helper()
	clock := &fakeClock{now: time.Date(2026, 10, 6, 14, 0, 0, 0, time.UTC)}
	supervisor, err := Open(Config{
		DataRoot: dataRoot, NodeID: "node-one", WorkspaceRoots: []string{workspace}, Drivers: []Driver{driver},
		Clock: clock, NewID: func() string { return "host-session-unused" }, persistenceFailpoint: failpoint,
	})
	require.NoError(t, err)
	require.True(t, supervisor.Usable())
	return supervisor
}

func seedAttachedState(t *testing.T) (string, string, *fakeDriver) {
	t.Helper()
	dataRoot := t.TempDir()
	workspace := t.TempDir()
	driver := newFakeDriver(workspace)
	supervisor := newTestSupervisor(t, dataRoot, workspace, driver)
	attachDiscoveredSession(t, supervisor, "codex-cli", "provider-existing", workspace, "host-session-one", "thread-one")
	return dataRoot, workspace, driver
}

func TestEveryPendingPersistenceBarrierFailsBeforeProviderAndRecoversUncertain(t *testing.T) {
	stages := []string{"before-create", "after-write", "after-file-sync", "after-rename", "after-directory-sync"}
	for _, stage := range stages {
		t.Run(stage, func(t *testing.T) {
			dataRoot, workspace, driver := seedAttachedState(t)
			failed := false
			supervisor := openTestSupervisorWithFailpoint(t, dataRoot, workspace, driver, func(candidate string) error {
				if !failed && candidate == ledgerFilename+":"+stage {
					failed = true
					return errors.New("crash barrier")
				}
				return nil
			})
			command := startCommand(t, "host-session-one", "pending-"+stage, "run-"+stage, "prompt")
			response := supervisor.Execute(context.Background(), command)
			require.Equal(t, "rejected", response.Result.Outcome)
			require.Equal(t, "durability-failed", response.Result.Code)
			require.Equal(t, 0, driver.callCount("start-turn"))
			if stage == "after-rename" || stage == "after-directory-sync" {
				require.False(t, supervisor.Usable(), "a write that may have been renamed must fence later in-process saves")
			}

			restarted := openTestSupervisorWithFailpoint(t, dataRoot, workspace, driver, nil)
			replay := restarted.Execute(context.Background(), command)
			if stage == "after-rename" || stage == "after-directory-sync" {
				require.Equal(t, "uncertain", replay.Result.Outcome)
			} else {
				// The pending record was never renamed, so a new delivery can safely be admitted.
				require.Equal(t, "succeeded", replay.Result.Outcome)
			}
			require.LessOrEqual(t, driver.callCount("start-turn"), 1)
		})
	}
}

func TestEveryPostEffectRegistryBarrierReturnsUncertainAndNeverRetries(t *testing.T) {
	stages := []string{"before-create", "after-write", "after-file-sync", "after-rename", "after-directory-sync"}
	for _, stage := range stages {
		t.Run(stage, func(t *testing.T) {
			dataRoot, workspace, driver := seedAttachedState(t)
			failed := false
			supervisor := openTestSupervisorWithFailpoint(t, dataRoot, workspace, driver, func(candidate string) error {
				if !failed && candidate == registryFilename+":"+stage {
					failed = true
					return errors.New("crash barrier")
				}
				return nil
			})
			command := startCommand(t, "host-session-one", "effect-"+stage, "run-"+stage, "prompt")
			response := supervisor.Execute(context.Background(), command)
			require.Equal(t, "uncertain", response.Result.Outcome)
			require.Equal(t, 1, driver.callCount("start-turn"))
			if stage == "after-rename" || stage == "after-directory-sync" {
				require.False(t, supervisor.Usable())
				_, err := supervisor.Snapshot()
				require.ErrorContains(t, err, "persistence became uncertain")
				retry := supervisor.Execute(context.Background(), command)
				require.Equal(t, "rejected", retry.Result.Outcome)
				require.Equal(t, "supervision-unavailable", retry.Result.Code)
			} else {
				snapshot, err := supervisor.Snapshot()
				require.NoError(t, err)
				require.Len(t, snapshot, 1)
				require.Equal(t, "idle", snapshot[0].Status, "an uncertain registry write must not publish uncommitted state in memory")
				require.Equal(t, "uncertain", supervisor.Execute(context.Background(), command).Result.Outcome)
			}
			require.Equal(t, 1, driver.callCount("start-turn"))
		})
	}
}

func TestRefreshPersistenceFailureDoesNotReleaseAnExistingWriterClaim(t *testing.T) {
	dataRoot := t.TempDir()
	workspace := t.TempDir()
	driver := &trackingClaimDriver{fakeDriver: newFakeDriver(workspace)}
	seed := newTestSupervisor(t, dataRoot, workspace, driver)
	attachDiscoveredSession(t, seed, "codex-cli", "provider-existing", workspace, "host-session-one", "thread-one")
	failed := false
	supervisor := openTestSupervisorWithFailpoint(t, dataRoot, workspace, driver, func(candidate string) error {
		if !failed && candidate == registryFilename+":before-create" {
			failed = true
			return errors.New("crash barrier")
		}
		return nil
	})
	_, err := supervisor.Refresh(context.Background(), "host-session-one")
	require.ErrorContains(t, err, "durability-uncertain")
	driver.mu.Lock()
	require.Empty(t, driver.releases)
	driver.mu.Unlock()
}

func TestEveryCompletedLedgerBarrierFallsBackToDurableUncertainty(t *testing.T) {
	stages := []string{"before-create", "after-write", "after-file-sync", "after-rename", "after-directory-sync"}
	for _, stage := range stages {
		t.Run(stage, func(t *testing.T) {
			dataRoot, workspace, driver := seedAttachedState(t)
			matchingWrites := 0
			supervisor := openTestSupervisorWithFailpoint(t, dataRoot, workspace, driver, func(candidate string) error {
				if candidate == ledgerFilename+":"+stage {
					matchingWrites++
					if matchingWrites == 2 {
						return errors.New("crash barrier")
					}
				}
				return nil
			})
			command := startCommand(t, "host-session-one", "complete-"+stage, "run-"+stage, "prompt")
			response := supervisor.Execute(context.Background(), command)
			require.Equal(t, "uncertain", response.Result.Outcome)
			require.Equal(t, 1, driver.callCount("start-turn"))
			if stage == "after-rename" || stage == "after-directory-sync" {
				require.False(t, supervisor.Usable())
				retry := supervisor.Execute(context.Background(), command)
				require.Equal(t, "rejected", retry.Result.Outcome)
				require.Equal(t, "supervision-unavailable", retry.Result.Code)
			} else {
				require.Equal(t, "uncertain", supervisor.Execute(context.Background(), command).Result.Outcome)
			}
			require.Equal(t, 1, driver.callCount("start-turn"))
		})
	}
}

func TestFutureVersionAndCrossRecordInconsistencyDisableWithoutRewritingEvidence(t *testing.T) {
	t.Run("future registry", func(t *testing.T) {
		dataRoot := t.TempDir()
		workspace := t.TempDir()
		directory := filepath.Join(dataRoot, "host-sessions")
		require.NoError(t, os.MkdirAll(directory, 0o700))
		payload := registryPayload{Version: persistenceVersion + 1, Records: []registryRecord{}}
		sum, err := checksum(payload)
		require.NoError(t, err)
		encoded, err := json.Marshal(registryEnvelope{Version: payload.Version, Records: payload.Records, Checksum: sum})
		require.NoError(t, err)
		path := filepath.Join(directory, registryFilename)
		require.NoError(t, os.WriteFile(path, encoded, 0o600))
		supervisor, err := Open(Config{DataRoot: dataRoot, NodeID: "node-one", WorkspaceRoots: []string{workspace}, Drivers: []Driver{newFakeDriver(workspace)}})
		require.NoError(t, err)
		require.False(t, supervisor.Usable())
		preserved, err := os.ReadFile(path)
		require.NoError(t, err)
		require.Equal(t, encoded, preserved)
	})

	t.Run("ledger references unknown session", func(t *testing.T) {
		dataRoot := t.TempDir()
		workspace := t.TempDir()
		directory := filepath.Join(dataRoot, "host-sessions")
		require.NoError(t, os.MkdirAll(directory, 0o700))
		records := []ledgerRecord{{
			CommandID: "command-one", CommandDigest: "digest-one", Operation: "start-turn",
			HostHarnessSessionID: "unknown-session", State: commandPending,
		}}
		payload := ledgerPayload{Version: persistenceVersion, Records: records}
		sum, err := checksum(payload)
		require.NoError(t, err)
		encoded, err := json.Marshal(ledgerEnvelope{Version: payload.Version, Records: records, Checksum: sum})
		require.NoError(t, err)
		path := filepath.Join(directory, ledgerFilename)
		require.NoError(t, os.WriteFile(path, encoded, 0o600))
		supervisor, err := Open(Config{DataRoot: dataRoot, NodeID: "node-one", WorkspaceRoots: []string{workspace}, Drivers: []Driver{newFakeDriver(workspace)}})
		require.NoError(t, err)
		require.False(t, supervisor.Usable())
	})
}

func TestRetentionEvictsOnlyOldestUnreferencedTerminalSessionsAndOtherwiseFailsCapacity(t *testing.T) {
	records := map[string]registryRecord{
		"closed-old": retentionRecord("closed-old", "closed", "2026-10-01T00:00:00Z", false),
		"closed-new": retentionRecord("closed-new", "closed", "2026-10-02T00:00:00Z", false),
		"failed-ref": retentionRecord("failed-ref", "failed", "2026-09-01T00:00:00Z", false),
		"offline":    retentionRecord("offline", "offline", "2026-08-01T00:00:00Z", false),
		"attached":   retentionRecord("attached", "closed", "2026-07-01T00:00:00Z", true),
	}
	ledger := map[string]ledgerRecord{
		"command-ref": {CommandID: "command-ref", HostHarnessSessionID: "failed-ref", State: commandUncertain},
	}
	retained, err := retainRegistry(records, ledger, 4)
	require.NoError(t, err)
	require.NotContains(t, retained, "closed-old")
	require.Contains(t, retained, "closed-new")
	require.Contains(t, retained, "failed-ref")
	require.Contains(t, retained, "offline")
	require.Contains(t, retained, "attached")

	_, err = retainRegistry(records, ledger, 2)
	require.ErrorContains(t, err, "capacity-conflict")
}

func TestLedgerCompactionKeepsUnacknowledgedPendingAndUncertainEvidence(t *testing.T) {
	result := func(commandID string) *protocol.HostSessionControlMessage {
		return &protocol.HostSessionControlMessage{Type: "host-session.command.result", CommandID: commandID}
	}
	records := map[string]ledgerRecord{
		"ack-old":   {CommandID: "ack-old", State: commandCompleted, Result: result("ack-old"), CompletedAt: "2026-10-01T00:00:00Z", Acknowledged: true},
		"ack-mid":   {CommandID: "ack-mid", State: commandCompleted, Result: result("ack-mid"), CompletedAt: "2026-10-02T00:00:00Z", Acknowledged: true},
		"ack-new":   {CommandID: "ack-new", State: commandCompleted, Result: result("ack-new"), CompletedAt: "2026-10-03T00:00:00Z", Acknowledged: true},
		"unacked":   {CommandID: "unacked", State: commandCompleted, Result: result("unacked"), CompletedAt: "2026-10-04T00:00:00Z"},
		"pending":   {CommandID: "pending", State: commandPending},
		"uncertain": {CommandID: "uncertain", State: commandUncertain},
	}
	compactLedger(records, 4)
	require.Len(t, records, 4)
	require.NotContains(t, records, "ack-old")
	require.NotContains(t, records, "ack-mid")
	require.Contains(t, records, "ack-new")
	require.Contains(t, records, "unacked")
	require.Contains(t, records, "pending")
	require.Contains(t, records, "uncertain")
}
