package controlplane

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/config"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/harness"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/workspace"
	"github.com/stretchr/testify/require"
)

const leaseRepository = "https://example.com/cafecito/project"

const completedHarnessLine = `{"type":"item.completed","item":{"type":"agent_message","text":"done"}}`

type leaseFixture struct {
	root   string
	source string
	base   string
}

func leaseGit(t *testing.T, directory string, arguments ...string) string {
	t.Helper()
	command := exec.Command("git", append([]string{"-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"}, arguments...)...)
	command.Dir = directory
	output, err := command.CombinedOutput()
	require.NoError(t, err, string(output))
	return strings.TrimSpace(string(output))
}

func newLeaseFixture(t *testing.T) leaseFixture {
	t.Helper()
	if _, err := workspace.FindGit(); err != nil {
		t.Skip("git is not installed")
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	require.NoError(t, err)
	source := filepath.Join(root, "project")
	require.NoError(t, os.Mkdir(source, 0o755))
	leaseGit(t, source, "init", "--quiet")
	require.NoError(t, os.WriteFile(filepath.Join(source, "README.md"), []byte("hello\n"), 0o644))
	leaseGit(t, source, "add", "README.md")
	leaseGit(t, source, "commit", "--quiet", "-m", "initial")
	leaseGit(t, source, "remote", "add", "origin", "https://token@example.com/cafecito/project.git")
	return leaseFixture{root: root, source: source, base: leaseGit(t, source, "rev-parse", "HEAD")}
}

func (fixture leaseFixture) grant(leaseID, taskID, runID string) protocol.WorkspaceLeaseGrant {
	return protocol.WorkspaceLeaseGrant{
		ID:           leaseID,
		Status:       "requested",
		Policy:       protocol.WorkspaceIsolationGitWorktree,
		Cleanup:      protocol.WorkspaceCleanupWhenUnchanged,
		Repository:   leaseRepository,
		Root:         fixture.root,
		SourcePath:   fixture.source,
		BaseRevision: "refs/heads/main",
		Branch:       protocol.WorkspaceLeaseBranch(taskID, runID),
		WorktreePath: filepath.Join(fixture.root, ".coffee-shop", "worktrees", leaseID),
	}
}

func writeLeaseHarness(t *testing.T, script string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("test fixture is a shell script")
	}
	binary := filepath.Join(t.TempDir(), "fake-codex")
	require.NoError(t, os.WriteFile(binary, []byte(script), 0o755))
	return binary
}

// leaseClient returns a client whose simulated hub confirms every active lease report, as the hub
// does once it has persisted the transition.
func leaseClient(t *testing.T, fixture leaseFixture, binary string) *Client {
	t.Helper()
	client := unconfirmedLeaseClient(t, fixture, binary)
	confirmActiveLeases(t, client)
	return client
}

func unconfirmedLeaseClient(t *testing.T, fixture leaseFixture, binary string) *Client {
	t.Helper()
	runner := harness.NewRunner([]protocol.HarnessProfile{{ID: "codex-cli", Binary: binary, Available: true}})
	return NewClient(config.Config{Concurrency: 2, WorkspaceRoots: []string{fixture.root}}, protocol.ComputeNode{ID: "node-one"}, runner, emptyCapabilityReport)
}

func confirmActiveLeases(t *testing.T, client *Client) {
	t.Helper()
	stop := make(chan struct{})
	done := make(chan struct{})
	t.Cleanup(func() {
		close(stop)
		<-done
	})
	go func() {
		defer close(done)
		confirmed := 0
		for {
			select {
			case <-stop:
				return
			case <-time.After(5 * time.Millisecond):
			}
			actives := 0
			for _, report := range leaseReports(t, client) {
				if report.Lease.Status != "active" {
					continue
				}
				actives++
				if actives > confirmed {
					client.handle(context.Background(), protocol.Inbound{Type: "workspace.lease.confirmed", RunID: report.RunID, LeaseID: report.Lease.LeaseID, Status: "active"})
					confirmed = actives
				}
			}
		}
	}()
}

type leaseReport struct {
	Type  string `json:"type"`
	RunID string `json:"runId"`
	Lease struct {
		LeaseID              string `json:"leaseId"`
		Status               string `json:"status"`
		RetentionReason      string `json:"retentionReason"`
		ResolvedBaseRevision string `json:"resolvedBaseRevision"`
		Detail               string `json:"detail"`
	} `json:"lease"`
	At string `json:"at"`
}

func rawOutbox(t *testing.T, client *Client) [][]byte {
	t.Helper()
	client.connectionMu.Lock()
	defer client.connectionMu.Unlock()
	return append([][]byte{}, client.outbox...)
}

func leaseReports(t *testing.T, client *Client) []leaseReport {
	t.Helper()
	var reports []leaseReport
	for _, data := range rawOutbox(t, client) {
		var probe map[string]any
		if err := json.Unmarshal(data, &probe); err != nil || probe["type"] != "workspace.lease" {
			continue
		}
		var report leaseReport
		require.NoError(t, json.Unmarshal(data, &report))
		reports = append(reports, report)
	}
	return reports
}

func leaseStatuses(t *testing.T, client *Client) []string {
	t.Helper()
	reports := leaseReports(t, client)
	statuses := make([]string, 0, len(reports))
	for _, report := range reports {
		statuses = append(statuses, report.Lease.Status)
	}
	return statuses
}

func waitForLeaseStatus(t *testing.T, client *Client, status string) []leaseReport {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		reports := leaseReports(t, client)
		for _, report := range reports {
			if report.Lease.Status == status {
				return reports
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for workspace.lease status %s, saw %v", status, leaseStatuses(t, client))
	return nil
}

// leaseAndRunSequence renders the interesting outbound messages, in order, as
// "lease:<status>" and "<message type>" tokens so full protocol ordering can be asserted.
func leaseAndRunSequence(t *testing.T, client *Client) []string {
	t.Helper()
	var sequence []string
	for _, data := range rawOutbox(t, client) {
		var probe map[string]any
		require.NoError(t, json.Unmarshal(data, &probe))
		messageType, _ := probe["type"].(string)
		switch messageType {
		case "workspace.lease":
			lease, _ := probe["lease"].(map[string]any)
			status, _ := lease["status"].(string)
			sequence = append(sequence, "lease:"+status)
		case "run.started", "run.completed", "run.failed":
			sequence = append(sequence, messageType)
		}
	}
	return sequence
}

func requireLeaseEnvelopeHasExactlyDeclaredKeys(t *testing.T, client *Client) {
	t.Helper()
	for _, data := range rawOutbox(t, client) {
		var probe map[string]any
		require.NoError(t, json.Unmarshal(data, &probe))
		if probe["type"] != "workspace.lease" {
			continue
		}
		keys := make([]string, 0, len(probe))
		for key := range probe {
			keys = append(keys, key)
		}
		require.ElementsMatch(t, []string{"type", "runId", "lease", "at"}, keys)
	}
}

func TestDispatchRunsInsideAProvisionedWorktreeLease(t *testing.T) {
	fixture := newLeaseFixture(t)
	marker := filepath.Join(t.TempDir(), "harness-cwd")
	binary := writeLeaseHarness(t, "#!/bin/sh\npwd > "+marker+"\nprintf '%s\\n' '"+completedHarnessLine+"'\n")
	client := leaseClient(t, fixture, binary)
	grant := fixture.grant("lease_one", "task_one", "run_one")
	run := protocol.Run{
		ID: "run_one", HarnessID: "codex-cli", Model: "default",
		Workspace: grant.WorktreePath, Prompt: "test", TaskID: "task_one", WorkspaceLeaseID: grant.ID,
	}
	execution := &protocol.DispatchExecution{Transport: "native-cli", TaskID: "task_one", WorkspaceLease: &grant}

	client.handle(context.Background(), protocol.Inbound{
		Type: "dispatch", Run: run, Agent: protocol.Agent{ID: "agent-one"}, Execution: execution,
	})

	waitForLeaseStatus(t, client, "cleaned")
	require.Equal(t, []string{"provisioning", "active", "released", "cleaning", "cleaned"}, leaseStatuses(t, client))
	require.Equal(t, []string{
		"lease:provisioning", "lease:active", "run.started", "run.completed",
		"lease:released", "lease:cleaning", "lease:cleaned",
	}, leaseAndRunSequence(t, client))
	requireLeaseEnvelopeHasExactlyDeclaredKeys(t, client)

	var active leaseReport
	for _, report := range leaseReports(t, client) {
		if report.Lease.Status == "active" {
			active = report
		}
	}
	require.Equal(t, grant.ID, active.Lease.LeaseID)
	require.Equal(t, "run_one", active.RunID)
	require.Equal(t, fixture.base, active.Lease.ResolvedBaseRevision)
	require.Regexp(t, "^[0-9a-f]{40}$", active.Lease.ResolvedBaseRevision)

	completed := waitForMessage(t, client, "run.completed")
	require.Equal(t, "run_one", completed.RunID)
	require.DirExists(t, filepath.Dir(grant.WorktreePath))
	require.NoDirExists(t, grant.WorktreePath, "the settled lease's worktree must be removed")

	content, err := os.ReadFile(marker)
	require.NoError(t, err)
	require.Equal(t, grant.WorktreePath, strings.TrimSpace(string(content)))
}

func TestDispatchRetainsLeaseWhenHarnessLeavesUntrackedFiles(t *testing.T) {
	fixture := newLeaseFixture(t)
	binary := writeLeaseHarness(t, "#!/bin/sh\nprintf 'scratch\\n' > unwanted.txt\nprintf '%s\\n' '"+completedHarnessLine+"'\n")
	client := leaseClient(t, fixture, binary)
	grant := fixture.grant("lease_two", "task_two", "run_two")
	run := protocol.Run{
		ID: "run_two", HarnessID: "codex-cli", Model: "default",
		Workspace: grant.WorktreePath, Prompt: "test", TaskID: "task_two", WorkspaceLeaseID: grant.ID,
	}
	execution := &protocol.DispatchExecution{Transport: "native-cli", TaskID: "task_two", WorkspaceLease: &grant}

	client.handle(context.Background(), protocol.Inbound{
		Type: "dispatch", Run: run, Agent: protocol.Agent{ID: "agent-one"}, Execution: execution,
	})

	reports := waitForLeaseStatus(t, client, "retained")
	require.Equal(t, []string{"provisioning", "active", "released", "retained"}, leaseStatuses(t, client))
	final := reports[len(reports)-1]
	require.Equal(t, grant.ID, final.Lease.LeaseID)
	require.Equal(t, "untracked", final.Lease.RetentionReason)
	require.DirExists(t, grant.WorktreePath)
	require.FileExists(t, filepath.Join(grant.WorktreePath, "unwanted.txt"))
}

func TestDispatchNeverStartsTheHarnessWhenProvisioningFails(t *testing.T) {
	fixture := newLeaseFixture(t)
	marker := filepath.Join(t.TempDir(), "harness-cwd")
	binary := writeLeaseHarness(t, "#!/bin/sh\npwd > "+marker+"\nprintf '%s\\n' '"+completedHarnessLine+"'\n")
	client := leaseClient(t, fixture, binary)
	grant := fixture.grant("lease_one", "task_one", "run_one")
	grant.Repository = "https://example.com/cafecito/other"
	run := protocol.Run{
		ID: "run_one", HarnessID: "codex-cli", Model: "default",
		Workspace: grant.WorktreePath, Prompt: "test", TaskID: "task_one", WorkspaceLeaseID: grant.ID,
	}
	execution := &protocol.DispatchExecution{Transport: "native-cli", TaskID: "task_one", WorkspaceLease: &grant}

	client.handle(context.Background(), protocol.Inbound{
		Type: "dispatch", Run: run, Agent: protocol.Agent{ID: "agent-one"}, Execution: execution,
	})

	waitForLeaseStatus(t, client, "failed")
	require.Equal(t, []string{"provisioning", "failed"}, leaseStatuses(t, client))
	failure := waitForMessage(t, client, "run.failed")
	require.Equal(t, "run_one", failure.RunID)
	require.Contains(t, failure.Error, "workspace lease could not be provisioned")
	for _, message := range outboundMessages(t, client) {
		require.NotEqual(t, "run.started", message.Type)
	}
	require.NoFileExists(t, marker)
	require.NoDirExists(t, grant.WorktreePath)
}

func TestDispatchGuardRejectsLeaseRunsItCannotHonor(t *testing.T) {
	fixture := newLeaseFixture(t)

	t.Run("run names a lease but no execution object carries its grant", func(t *testing.T) {
		client := NewClient(config.Config{Concurrency: 1, WorkspaceRoots: []string{fixture.root}}, protocol.ComputeNode{ID: "node-one"}, nil, emptyCapabilityReport)
		client.handle(context.Background(), protocol.Inbound{
			Type:  "dispatch",
			Run:   protocol.Run{ID: "run_one", WorkspaceLeaseID: "lease_one"},
			Agent: protocol.Agent{ID: "agent-one"},
		})
		message := waitForMessage(t, client, "run.failed")
		require.Equal(t, "run_one", message.RunID)
		require.Equal(t, "unsupported execution: the run's workspace lease grant is missing or names a different lease", message.Error)
	})

	t.Run("run workspace is not the lease's isolated cwd", func(t *testing.T) {
		client := NewClient(config.Config{Concurrency: 1, WorkspaceRoots: []string{fixture.root}}, protocol.ComputeNode{ID: "node-two"}, nil, emptyCapabilityReport)
		grant := fixture.grant("lease_one", "task_one", "run_one")
		run := protocol.Run{ID: "run_one", Workspace: fixture.source, WorkspaceLeaseID: grant.ID, TaskID: "task_one"}
		client.handle(context.Background(), protocol.Inbound{
			Type:      "dispatch",
			Run:       run,
			Agent:     protocol.Agent{ID: "agent-one"},
			Execution: &protocol.DispatchExecution{Transport: "native-cli", TaskID: "task_one", WorkspaceLease: &grant},
		})
		message := waitForMessage(t, client, "run.failed")
		require.Equal(t, "run_one", message.RunID)
		require.Equal(t, "unsupported execution: the run workspace is not its lease's isolated cwd", message.Error)
	})

	t.Run("unknown isolation policy", func(t *testing.T) {
		client := NewClient(config.Config{Concurrency: 1, WorkspaceRoots: []string{fixture.root}}, protocol.ComputeNode{ID: "node-three"}, nil, emptyCapabilityReport)
		grant := fixture.grant("lease_one", "task_one", "run_one")
		grant.Policy = "carrier-pigeon"
		run := protocol.Run{ID: "run_one", Workspace: grant.WorktreePath, WorkspaceLeaseID: grant.ID, TaskID: "task_one"}
		client.handle(context.Background(), protocol.Inbound{
			Type:      "dispatch",
			Run:       run,
			Agent:     protocol.Agent{ID: "agent-one"},
			Execution: &protocol.DispatchExecution{Transport: "native-cli", TaskID: "task_one", WorkspaceLease: &grant},
		})
		message := waitForMessage(t, client, "run.failed")
		require.Equal(t, "run_one", message.RunID)
		require.Equal(t, "unsupported execution: the workspace lease grant is malformed", message.Error)
	})
}

func TestWorkspaceCleanupOperatorModeCleansARetainedLease(t *testing.T) {
	fixture := newLeaseFixture(t)
	binary := writeLeaseHarness(t, "#!/bin/sh\nprintf 'scratch\\n' > unwanted.txt\nprintf '%s\\n' '"+completedHarnessLine+"'\n")
	client := leaseClient(t, fixture, binary)
	grant := fixture.grant("lease_two", "task_two", "run_two")
	run := protocol.Run{
		ID: "run_two", HarnessID: "codex-cli", Model: "default",
		Workspace: grant.WorktreePath, Prompt: "test", TaskID: "task_two", WorkspaceLeaseID: grant.ID,
	}
	execution := &protocol.DispatchExecution{Transport: "native-cli", TaskID: "task_two", WorkspaceLease: &grant}
	client.handle(context.Background(), protocol.Inbound{
		Type: "dispatch", Run: run, Agent: protocol.Agent{ID: "agent-one"}, Execution: execution,
	})
	retained := waitForLeaseStatus(t, client, "retained")
	require.Equal(t, "untracked", retained[len(retained)-1].Lease.RetentionReason)

	require.NoError(t, os.Remove(filepath.Join(grant.WorktreePath, "unwanted.txt")))
	grant.Status = "retained"
	client.handle(context.Background(), protocol.Inbound{Type: "workspace.cleanup", RunID: "run_two", Lease: &grant, Mode: "operator"})

	reports := waitForLeaseStatus(t, client, "cleaned")
	require.Equal(t, []string{"cleaning", "cleaned"}, leaseStatuses(t, client)[len(retained):])
	require.Equal(t, grant.ID, reports[len(reports)-1].Lease.LeaseID)
	require.NoDirExists(t, grant.WorktreePath)
}

func TestWorkspaceCleanupReconcileModeFailsALeaseThatWasNeverProvisioned(t *testing.T) {
	fixture := newLeaseFixture(t)
	client := leaseClient(t, fixture, "")
	grant := fixture.grant("lease_three", "task_three", "run_three")

	client.handle(context.Background(), protocol.Inbound{Type: "workspace.cleanup", RunID: "run_three", Lease: &grant, Mode: "reconcile"})

	reports := waitForLeaseStatus(t, client, "failed")
	require.Equal(t, []string{"failed"}, leaseStatuses(t, client))
	require.Equal(t, grant.ID, reports[0].Lease.LeaseID)
	require.NotEmpty(t, reports[0].Lease.Detail)
}

func TestWorkspaceCleanupIgnoresALeaseOwnedByALiveRun(t *testing.T) {
	fixture := newLeaseFixture(t)
	client := leaseClient(t, fixture, "")
	grant := fixture.grant("lease_one", "task_one", "run_one")
	grant.Status = "retained"
	release, ownErr := client.workspaces.Own(grant)
	owned := ownErr == nil
	require.True(t, owned)
	defer release()

	client.handle(context.Background(), protocol.Inbound{Type: "workspace.cleanup", RunID: "run_one", Lease: &grant, Mode: "operator"})

	deadline := time.Now().Add(300 * time.Millisecond)
	for time.Now().Before(deadline) {
		if statuses := leaseStatuses(t, client); len(statuses) > 0 {
			t.Fatalf("a lease owned by a live run must not be reported: %v", statuses)
		}
		time.Sleep(10 * time.Millisecond)
	}
	require.Empty(t, leaseStatuses(t, client))
}

func TestWorkspaceLeasePathReturnsTheCanonicalTransitionSequence(t *testing.T) {
	require.Equal(t, []string{"provisioning", "released", "cleaning", "cleaned"}, protocol.WorkspaceLeasePath("requested", "cleaned"))
	require.Equal(t, []string{"released", "cleaning", "cleaned"}, protocol.WorkspaceLeasePath("active", "cleaned"))
	require.Equal(t, []string{"failed"}, protocol.WorkspaceLeasePath("requested", "failed"))
	require.Nil(t, protocol.WorkspaceLeasePath("retained", "retained"))
	require.Nil(t, protocol.WorkspaceLeasePath("cleaned", "active"))
	require.Equal(t, []string{"cleaning"}, protocol.WorkspaceLeasePath("retained", "cleaning"))
}

func dispatchLeasedRun(client *Client, grant *protocol.WorkspaceLeaseGrant, runID, taskID string) {
	run := protocol.Run{
		ID: runID, HarnessID: "codex-cli", Model: "default",
		Workspace: grant.WorktreePath, Prompt: "test", TaskID: taskID, WorkspaceLeaseID: grant.ID,
	}
	client.handle(context.Background(), protocol.Inbound{
		Type: "dispatch", Run: run, Agent: protocol.Agent{ID: "agent-one"},
		Execution: &protocol.DispatchExecution{Transport: "native-cli", TaskID: taskID, WorkspaceLease: grant},
	})
}

func TestHarnessNeverStartsWithoutHubConfirmation(t *testing.T) {
	fixture := newLeaseFixture(t)
	marker := filepath.Join(t.TempDir(), "harness-cwd")
	binary := writeLeaseHarness(t, "#!/bin/sh\npwd > "+marker+"\nprintf '%s\\n' '"+completedHarnessLine+"'\n")
	client := unconfirmedLeaseClient(t, fixture, binary)
	client.leaseConfirmationTimeout = 200 * time.Millisecond
	grant := fixture.grant("lease_one", "task_one", "run_one")
	dispatchLeasedRun(client, &grant, "run_one", "task_one")

	failure := waitForMessage(t, client, "run.failed")
	require.Equal(t, "workspace lease was not confirmed by the hub", failure.Error)
	waitForLeaseStatus(t, client, "cleaned")
	require.Equal(t, []string{"provisioning", "active", "released", "cleaning", "cleaned"}, leaseStatuses(t, client))
	for _, message := range outboundMessages(t, client) {
		require.NotEqual(t, "run.started", message.Type)
	}
	require.NoFileExists(t, marker)
}

func TestHarnessIgnoresConfirmationsForAnotherRunLeaseOrStatus(t *testing.T) {
	fixture := newLeaseFixture(t)
	marker := filepath.Join(t.TempDir(), "harness-cwd")
	binary := writeLeaseHarness(t, "#!/bin/sh\npwd > "+marker+"\nprintf '%s\\n' '"+completedHarnessLine+"'\n")
	client := unconfirmedLeaseClient(t, fixture, binary)
	client.leaseConfirmationTimeout = 2 * time.Second
	grant := fixture.grant("lease_one", "task_one", "run_one")
	dispatchLeasedRun(client, &grant, "run_one", "task_one")
	waitForLeaseStatus(t, client, "active")

	for _, confirmation := range []protocol.Inbound{
		{Type: "workspace.lease.confirmed", RunID: "run_other", LeaseID: grant.ID, Status: "active"},
		{Type: "workspace.lease.confirmed", RunID: "run_one", LeaseID: "lease_other", Status: "active"},
		{Type: "workspace.lease.confirmed", RunID: "run_one", LeaseID: grant.ID, Status: "provisioning"},
	} {
		client.handle(context.Background(), confirmation)
	}
	time.Sleep(200 * time.Millisecond)
	for _, message := range outboundMessages(t, client) {
		require.NotEqual(t, "run.started", message.Type)
	}

	client.handle(context.Background(), protocol.Inbound{Type: "workspace.lease.confirmed", RunID: "run_one", LeaseID: grant.ID, Status: "active"})
	waitForMessage(t, client, "run.completed")
	content, err := os.ReadFile(marker)
	require.NoError(t, err)
	require.Equal(t, grant.WorktreePath, strings.TrimSpace(string(content)))
}

func TestCancellationWhileAwaitingConfirmationNeverStartsTheHarness(t *testing.T) {
	fixture := newLeaseFixture(t)
	marker := filepath.Join(t.TempDir(), "harness-cwd")
	binary := writeLeaseHarness(t, "#!/bin/sh\npwd > "+marker+"\n")
	client := unconfirmedLeaseClient(t, fixture, binary)
	client.leaseConfirmationTimeout = 10 * time.Second
	grant := fixture.grant("lease_one", "task_one", "run_one")
	dispatchLeasedRun(client, &grant, "run_one", "task_one")
	waitForLeaseStatus(t, client, "active")

	client.handle(context.Background(), protocol.Inbound{Type: "cancel", RunID: "run_one"})
	waitForMessage(t, client, "run.cancelled")
	waitForLeaseStatus(t, client, "cleaned")
	require.NoFileExists(t, marker)
	require.NoDirExists(t, grant.WorktreePath)
}

func TestReplayedDispatchOfAnActiveLeaseReassertsItForConfirmation(t *testing.T) {
	fixture := newLeaseFixture(t)
	binary := writeLeaseHarness(t, "#!/bin/sh\nprintf '%s\\n' '"+completedHarnessLine+"'\n")
	grant := fixture.grant("lease_one", "task_one", "run_one")
	provisioner, err := workspace.FindGit()
	require.NoError(t, err)
	require.Equal(t, "active", workspace.NewManager([]string{fixture.root}, provisioner).Provision(context.Background(), grant, "task_one", "run_one").Status)

	client := leaseClient(t, fixture, binary)
	grant.Status = "active"
	grant.ResolvedBaseRevision = fixture.base
	dispatchLeasedRun(client, &grant, "run_one", "task_one")
	waitForMessage(t, client, "run.completed")
	statuses := leaseStatuses(t, client)
	require.Equal(t, "active", statuses[0], "an already-active lease is re-reported so the hub can confirm it")
}

func TestReplacementBaristaCannotCleanUpALeaseAnotherProcessStillRuns(t *testing.T) {
	fixture := newLeaseFixture(t)
	git, err := workspace.FindGit()
	require.NoError(t, err)
	grant := fixture.grant("lease_one", "task_one", "run_one")
	running := workspace.NewManager([]string{fixture.root}, git)
	release, err := running.Own(grant)
	require.NoError(t, err)
	require.Equal(t, "active", running.Provision(context.Background(), grant, "task_one", "run_one").Status)

	replacement := unconfirmedLeaseClient(t, fixture, "")
	grant.Status = "active"
	for _, mode := range []string{"reconcile", "operator"} {
		replacement.handle(context.Background(), protocol.Inbound{Type: "workspace.cleanup", RunID: "run_one", Lease: &grant, Mode: mode})
	}
	time.Sleep(300 * time.Millisecond)
	require.Empty(t, leaseReports(t, replacement), "a lease locked by another process is neither reported nor touched")
	require.DirExists(t, grant.WorktreePath)

	release()
	replacement.handle(context.Background(), protocol.Inbound{Type: "workspace.cleanup", RunID: "run_one", Lease: &grant, Mode: "reconcile"})
	waitForLeaseStatus(t, replacement, "cleaned")
	require.NoDirExists(t, grant.WorktreePath)
}
