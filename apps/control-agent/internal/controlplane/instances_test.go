package controlplane

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp/acptest"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/config"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/harness"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
	"nhooyr.io/websocket"
)

const instanceAt = "2026-09-24T12:00:00Z"

// fakeHarnessBinary writes a codex-cli agent_message event and then sleeps, so a run stays active
// until it is cancelled or the sleep elapses. A completed-at-once variant is built per test.
func fakeHarnessBinary(t *testing.T, directory, name, script string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("test fixture is a shell script")
	}
	binary := filepath.Join(directory, name)
	require.NoError(t, os.WriteFile(binary, []byte(script), 0o755))
	return binary
}

func slowHarnessBinary(t *testing.T, directory string) string {
	return fakeHarnessBinary(t, directory, "fake-codex",
		"#!/bin/sh\nprintf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"started\"}}'\nsleep 30\n")
}

func quickHarnessBinary(t *testing.T, directory string) string {
	return fakeHarnessBinary(t, directory, "fake-codex",
		"#!/bin/sh\nprintf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"done\"}}'\n")
}

func instanceTestClient(t *testing.T, binary, workspace string, concurrency, instanceCapacity int, models []string) *Client {
	t.Helper()
	runner := harness.NewRunner([]protocol.HarnessProfile{{ID: "codex-cli", Binary: binary, Available: true, Models: models}})
	return NewClient(config.Config{
		Concurrency: concurrency, InstanceCapacity: instanceCapacity, WorkspaceRoots: []string{workspace},
	}, protocol.ComputeNode{ID: "node-one"}, runner, emptyCapabilityReport)
}

func testInstanceAndAllocation(workspace string) (protocol.AgentInstance, protocol.InstanceAllocation) {
	return testInstanceAndAllocationFor("instance-one", "allocation-one", workspace)
}

func testInstanceAndAllocationFor(instanceID, allocationID, workspace string) (protocol.AgentInstance, protocol.InstanceAllocation) {
	lease := protocol.InstanceLease{IdleTimeoutSeconds: protocol.DefaultInstanceIdleTimeoutSeconds, ExpiresAt: "2026-09-24T12:30:00Z"}
	instance := protocol.AgentInstance{
		ID: instanceID, ThreadID: "thread-one",
		Creator:    protocol.InstanceCreator{Kind: "operator", OperatorID: "operator-one"},
		Delegation: protocol.InstanceDelegationPolicy{CanDelegate: false},
		Lease:      lease, Status: "provisioning", CreatedAt: instanceAt, UpdatedAt: instanceAt,
	}
	allocation := protocol.InstanceAllocation{
		ID: allocationID, InstanceID: instanceID, NodeID: "node-one", HarnessID: "codex-cli", Model: "default",
		Transport: "native-cli", Workspace: workspace, Lease: lease, Status: "provisioning", CreatedAt: instanceAt, UpdatedAt: instanceAt,
	}
	return instance, allocation
}

func testProvisionMessage(instance protocol.AgentInstance, allocation protocol.InstanceAllocation) protocol.InstanceHubMessage {
	return protocol.InstanceHubMessage{Type: "instance.provision", Instance: &instance, Allocation: &allocation}
}

func testDispatchMessage(instance protocol.AgentInstance, allocation protocol.InstanceAllocation, runID string) protocol.InstanceHubMessage {
	run := &protocol.InstanceRun{
		ID: runID, ThreadID: instance.ThreadID, InstanceID: instance.ID, AllocationID: allocation.ID, NodeID: allocation.NodeID,
		HarnessID: allocation.HarnessID, Model: allocation.Model, Workspace: allocation.Workspace, Prompt: "do the work",
		Status: "queued", Depth: 0, CreatedAt: instanceAt, Transport: allocation.Transport,
	}
	return protocol.InstanceHubMessage{Type: "dispatch", Instance: &instance, Allocation: &allocation, Run: run}
}

func testReleaseMessage(allocation protocol.InstanceAllocation, mode string) protocol.InstanceHubMessage {
	return protocol.InstanceHubMessage{Type: "instance.release", InstanceID: allocation.InstanceID, AllocationID: allocation.ID, Mode: mode}
}

// provisionReady provisions one resident and requires its acknowledgement before returning.
func provisionReady(t *testing.T, client *Client, instance protocol.AgentInstance, allocation protocol.InstanceAllocation) {
	t.Helper()
	client.handleInstanceMessage(context.Background(), testProvisionMessage(instance, allocation))
	require.NotNil(t, waitForInstanceMessage(t, client, "instance.ready", ""), "provision must be acknowledged with instance.ready")
}

func instanceControlMessages(t *testing.T, client *Client) []protocol.InstanceControlMessage {
	t.Helper()
	client.connectionMu.Lock()
	defer client.connectionMu.Unlock()
	messages := make([]protocol.InstanceControlMessage, 0, len(client.outbox))
	for _, data := range client.outbox {
		var message protocol.InstanceControlMessage
		if err := json.Unmarshal(data, &message); err == nil && strings.Contains(strings.Join(protocol.InstanceControlMessageTypes, " "), message.Type) {
			messages = append(messages, message)
		}
	}
	return messages
}

// waitForInstanceMessage returns the latest message of messageType, optionally narrowed to one
// allocation. The outbox accumulates across a test, so callers that provoke several messages of
// the same type must narrow by allocation and take the latest.
func waitForInstanceMessage(t *testing.T, client *Client, messageType string, allocationID string) *protocol.InstanceControlMessage {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var latest *protocol.InstanceControlMessage
		for index, message := range instanceControlMessages(t, client) {
			if message.Type == messageType && (allocationID == "" || message.AllocationID == allocationID) {
				latest = &instanceControlMessages(t, client)[index]
			}
		}
		if latest != nil {
			return latest
		}
		time.Sleep(5 * time.Millisecond)
	}
	return nil
}

// waitForRunFailure waits for the run.failed addressed to exactly this run, ignoring failures of
// other runs queued earlier in the outbox.
func waitForRunFailure(t *testing.T, client *Client, runID string) protocol.Outbound {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, message := range outboundMessages(t, client) {
			if message.Type == "run.failed" && message.RunID == runID {
				return message
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for run.failed for %s", runID)
	return protocol.Outbound{}
}

// waitForInstanceReason waits for an instance message whose error contains reason, so an earlier
// instance.failed for the same allocation cannot satisfy the wait.
func waitForInstanceReason(t *testing.T, client *Client, messageType, allocationID, reason string) protocol.InstanceControlMessage {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, message := range instanceControlMessages(t, client) {
			if message.Type == messageType && message.AllocationID == allocationID && message.Error != nil && strings.Contains(*message.Error, reason) {
				return message
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s of %s containing %q", messageType, allocationID, reason)
	return protocol.InstanceControlMessage{}
}

// waitForInstanceMessageCount waits until allocationID has exactly count messages of messageType.
func waitForInstanceMessageCount(t *testing.T, client *Client, messageType, allocationID string, count int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		seen := 0
		for _, message := range instanceControlMessages(t, client) {
			if message.Type == messageType && message.AllocationID == allocationID {
				seen++
			}
		}
		if seen >= count {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %d %s messages of %s", count, messageType, allocationID)
}

func TestProvisionValidatesEveryPrerequisiteBeforeReserving(t *testing.T) {
	directory := t.TempDir()
	runner := harness.NewRunner([]protocol.HarnessProfile{{ID: "codex-cli", Binary: quickHarnessBinary(t, directory), Available: true, Models: []string{"sonnet"}}})
	newClient := func() *Client {
		return NewClient(config.Config{Concurrency: 2, InstanceCapacity: 2, WorkspaceRoots: []string{directory}}, protocol.ComputeNode{ID: "node-one"}, runner, emptyCapabilityReport)
	}
	baseInstance, baseAllocation := testInstanceAndAllocation(directory)

	wrongNode := baseAllocation
	wrongNode.NodeID = "node-two"
	unknownHarness := baseAllocation
	unknownHarness.HarnessID = "shell"
	unadvertisedModel := baseAllocation
	unadvertisedModel.Model = "opus"
	acpTransport := baseAllocation
	acpTransport.Transport = "acp-v1"
	outsideRoots := baseAllocation
	outsideRoots.Workspace = filepath.Join(os.TempDir(), "elsewhere")

	cases := []struct {
		name       string
		allocation protocol.InstanceAllocation
	}{
		{"wrong node", wrongNode},
		{"unknown harness", unknownHarness},
		{"unadvertised model", unadvertisedModel},
		{"unavailable transport", acpTransport},
		{"workspace outside roots", outsideRoots},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			client := newClient()
			client.handleInstanceMessage(context.Background(), testProvisionMessage(baseInstance, item.allocation))
			failed := waitForInstanceMessage(t, client, "instance.failed", "")
			require.NotNil(t, failed)
			require.Equal(t, baseAllocation.ID, failed.AllocationID)
			require.NotNil(t, failed.Error)
			require.Zero(t, client.activeInstanceCount(), "a rejected provision must not reserve a slot")
		})
	}
	t.Run("no harness inventory", func(t *testing.T) {
		client := NewClient(config.Config{Concurrency: 2, InstanceCapacity: 2, WorkspaceRoots: []string{directory}}, protocol.ComputeNode{ID: "node-one"}, nil, emptyCapabilityReport)
		client.handleInstanceMessage(context.Background(), testProvisionMessage(baseInstance, baseAllocation))
		failed := waitForInstanceMessage(t, client, "instance.failed", "")
		require.NotNil(t, failed)
		require.Contains(t, *failed.Error, "no harness inventory")
	})
}

// advertisingClaudeCLIDriver builds an ACP driver whose claude-cli adapter replays the named
// acptest scenario, plus the native discovery profiles of a node whose Claude CLI is not installed
// natively: claude-cli is reachable only through ACP.
func advertisingClaudeCLIDriver(t *testing.T, scenario string) (*harness.ACPDriver, string, []protocol.HarnessProfile) {
	t.Helper()
	executable, err := os.Executable()
	require.NoError(t, err)
	record := filepath.Join(t.TempDir(), "frames.jsonl")
	driver := harness.NewACPDriver(harness.ACPDriverOptions{
		Adapters: map[string]harness.ACPAdapter{"claude-cli": {
			Binary: executable, Environment: acptest.Environment(scenario, record),
			ID: "claude-acp", Version: acptest.ClaudeAdapterVersion, Source: protocol.ACPAdapterSourceSetupLedger,
		}},
		RequestTimeout: 5 * time.Second,
	})
	t.Cleanup(func() { acptest.KillDescendants(t, record) })
	nativeProfiles := []protocol.HarnessProfile{{
		ID: "claude-cli", Label: "Claude Code", Description: "Not installed", Binary: "claude",
		Available: false, Transports: []string{harness.TransportNative},
	}}
	return driver, record, nativeProfiles
}

// An allocation the hub selected from this node's advertised capabilities — a harness available
// only through ACP, over acp-v1, with a model the adapter's probe contributed — must provision.
func TestProvisionAcceptsAllocationsSelectedFromAdvertisedACPCapabilities(t *testing.T) {
	driver, _, nativeProfiles := advertisingClaudeCLIDriver(t, "claude-probe-models")
	advertised, failures := harness.AdvertiseACP(context.Background(), nativeProfiles, driver)
	require.Empty(t, failures)
	require.True(t, advertised[0].Available, "the probed adapter makes claude-cli available without its native CLI")
	require.Equal(t, []string{harness.TransportACP}, advertised[0].Transports)

	runner := harness.NewRunner(nativeProfiles).WithAdvertisedProfiles(advertised).WithACP(driver)
	client := NewClient(config.Config{
		Concurrency: 1, InstanceCapacity: 1, WorkspaceRoots: []string{t.TempDir()},
	}, protocol.ComputeNode{ID: "node-one", Harnesses: advertised}, runner, emptyCapabilityReport)

	instance, allocation := testInstanceAndAllocation(client.config.WorkspaceRoots[0])
	allocation.HarnessID = "claude-cli"
	allocation.Model = acptest.ClaudeModel
	allocation.Transport = harness.TransportACP
	client.handleInstanceMessage(context.Background(), testProvisionMessage(instance, allocation))
	failed := waitForInstanceMessage(t, client, "instance.failed", allocation.ID)
	if failed != nil {
		t.Fatalf("an allocation selected from the advertised ACP capabilities must provision, not fail: %s", *failed.Error)
	}
	require.NotNil(t, waitForInstanceMessage(t, client, "instance.ready", allocation.ID))
	require.Equal(t, 1, client.activeInstanceCount())
}

// A harness whose ACP adapter failed its startup probe is absent from the advertised capabilities
// and must not be admitted: the adapter is disabled, so neither admission check accepts it.
func TestProvisionRefusesHarnessesWhoseACPProbeFailed(t *testing.T) {
	driver, _, nativeProfiles := advertisingClaudeCLIDriver(t, "claude-version-mismatch")
	advertised, failures := harness.AdvertiseACP(context.Background(), nativeProfiles, driver)
	require.ErrorIs(t, failures["claude-cli"], acp.ErrAdapterVersionMismatch)
	require.Equal(t, nativeProfiles, advertised, "a failed probe must not change what the node advertises")

	runner := harness.NewRunner(nativeProfiles).WithAdvertisedProfiles(advertised).WithACP(driver)
	client := NewClient(config.Config{
		Concurrency: 1, InstanceCapacity: 1, WorkspaceRoots: []string{t.TempDir()},
	}, protocol.ComputeNode{ID: "node-one", Harnesses: advertised}, runner, emptyCapabilityReport)

	instance, allocation := testInstanceAndAllocation(client.config.WorkspaceRoots[0])
	allocation.HarnessID = "claude-cli"
	allocation.Model = acptest.ClaudeModel
	allocation.Transport = harness.TransportACP
	client.handleInstanceMessage(context.Background(), testProvisionMessage(instance, allocation))
	failed := waitForInstanceMessage(t, client, "instance.failed", allocation.ID)
	require.NotNil(t, failed)
	require.Contains(t, *failed.Error, "not installed")
	require.Zero(t, client.activeInstanceCount())
}

// An allocation that names a transport the harness does not advertise — here native-cli for a
// harness this node can reach only through ACP — must be refused at admission: Barista would
// otherwise reserve resident capacity and acknowledge instance.ready for work it cannot execute.
func TestProvisionRefusesATransportTheHarnessDoesNotAdvertise(t *testing.T) {
	driver, _, nativeProfiles := advertisingClaudeCLIDriver(t, "claude-probe-models")
	advertised, failures := harness.AdvertiseACP(context.Background(), nativeProfiles, driver)
	require.Empty(t, failures)
	require.Equal(t, []string{harness.TransportACP}, advertised[0].Transports, "claude-cli is advertised over acp-v1 only")

	runner := harness.NewRunner(nativeProfiles).WithAdvertisedProfiles(advertised).WithACP(driver)
	client := NewClient(config.Config{
		Concurrency: 1, InstanceCapacity: 1, WorkspaceRoots: []string{t.TempDir()},
	}, protocol.ComputeNode{ID: "node-one", Harnesses: advertised}, runner, emptyCapabilityReport)

	instance, allocation := testInstanceAndAllocation(client.config.WorkspaceRoots[0])
	allocation.HarnessID = "claude-cli"
	allocation.Model = acptest.ClaudeModel
	allocation.Transport = harness.TransportNative
	client.handleInstanceMessage(context.Background(), testProvisionMessage(instance, allocation))
	failed := waitForInstanceMessage(t, client, "instance.failed", allocation.ID)
	require.NotNil(t, failed)
	require.Contains(t, *failed.Error, "transport native-cli is not available for harness claude-cli")
	require.Zero(t, client.activeInstanceCount(), "a provision for an unadvertised transport must not reserve a slot")
}

func TestProvisionCapacityZeroDisabledFullAndFree(t *testing.T) {
	directory := t.TempDir()

	disabled := instanceTestClient(t, quickHarnessBinary(t, directory), directory, 2, 0, nil)
	instance, allocation := testInstanceAndAllocation(directory)
	disabled.handleInstanceMessage(context.Background(), testProvisionMessage(instance, allocation))
	waitForInstanceReason(t, disabled, "instance.failed", allocation.ID, "instance hosting is disabled")
	require.Zero(t, disabled.activeInstanceCount())

	client := instanceTestClient(t, quickHarnessBinary(t, directory), directory, 2, 1, nil)
	provisionReady(t, client, instance, allocation)
	require.Equal(t, 1, client.activeInstanceCount())

	secondInstance, secondAllocation := testInstanceAndAllocationFor("instance-two", "allocation-two", directory)
	client.handleInstanceMessage(context.Background(), testProvisionMessage(secondInstance, secondAllocation))
	waitForInstanceReason(t, client, "instance.failed", secondAllocation.ID, "resident instance capacity (1) reached")
	require.Equal(t, 1, client.activeInstanceCount(), "a full node must not evict the hosted resident")

	client.handleInstanceMessage(context.Background(), testReleaseMessage(allocation, "drain"))
	require.NotNil(t, waitForInstanceMessage(t, client, "instance.released", ""))
	require.Zero(t, client.activeInstanceCount(), "release frees the slot")
	client.handleInstanceMessage(context.Background(), testProvisionMessage(secondInstance, secondAllocation))
	require.NotNil(t, waitForInstanceMessage(t, client, "instance.ready", ""), "the freed slot hosts the next resident")
}

func TestProvisionReplayIsExactAndConflictsAreRefused(t *testing.T) {
	directory := t.TempDir()
	client := instanceTestClient(t, quickHarnessBinary(t, directory), directory, 2, 2, nil)
	instance, allocation := testInstanceAndAllocation(directory)
	provisionReady(t, client, instance, allocation)

	client.handleInstanceMessage(context.Background(), testProvisionMessage(instance, allocation))
	ready := waitForInstanceMessage(t, client, "instance.ready", "")
	require.NotNil(t, ready, "an exact replay is acknowledged like the original")
	require.Equal(t, 1, client.activeInstanceCount())

	conflictingInstance, conflictingAllocation := instance, allocation
	conflictingInstance.ID = "instance-other"
	conflictingAllocation.InstanceID = "instance-other"
	conflictingAllocation.Model = "other-model"
	client.handleInstanceMessage(context.Background(), testProvisionMessage(conflictingInstance, conflictingAllocation))
	waitForInstanceReason(t, client, "instance.failed", allocation.ID, "a different resident is already hosted for this allocation")
	require.Equal(t, 1, client.activeInstanceCount(), "a conflicting replay must not replace the original")

	client.handleInstanceMessage(context.Background(), testDispatchMessage(instance, allocation, "run-one"))
	require.NotNil(t, waitForMessage(t, client, "run.completed"), "the original resident still dispatches")
}

// An allocation that was already accepted replays exactly while a local prerequisite has drifted.
// The recorded admission owns the answer; re-adjudicating the prerequisite would report
// instance.failed for a lifecycle whose ready resident still occupies its slot.
func TestExactProvisionReplayIsAnsweredBeforePrerequisiteRevalidation(t *testing.T) {
	directory := t.TempDir()
	client := instanceTestClient(t, quickHarnessBinary(t, directory), directory, 2, 1, nil)
	instance, allocation := testInstanceAndAllocation(directory)
	provisionReady(t, client, instance, allocation)

	// A local prerequisite drifts after admission: the resident's workspace is no longer inside any
	// configured root.
	client.config.WorkspaceRoots = []string{filepath.Join(directory, "gone")}

	client.handleInstanceMessage(context.Background(), testProvisionMessage(instance, allocation))
	waitForInstanceMessageCount(t, client, "instance.ready", allocation.ID, 2)
	require.Equal(t, 1, client.activeInstanceCount(), "an exact replay must neither reserve nor free a slot")

	conflictingInstance, conflictingAllocation := instance, allocation
	conflictingInstance.ID = "instance-other"
	conflictingAllocation.InstanceID = "instance-other"
	client.handleInstanceMessage(context.Background(), testProvisionMessage(conflictingInstance, conflictingAllocation))
	waitForInstanceReason(t, client, "instance.failed", allocation.ID, "a different resident is already hosted for this allocation")
	require.Equal(t, 1, client.activeInstanceCount(), "a conflicting replay must not replace the resident")

	// The drift is still enforced where it is a security boundary: dispatch re-authorizes the
	// workspace before granting MCP or starting the provider, so the run is refused, not degraded.
	client.handleInstanceMessage(context.Background(), testDispatchMessage(instance, allocation, "run-one"))
	failed := waitForRunFailure(t, client, "run-one")
	require.Contains(t, failed.Error, "outside this Barista's allowed roots")
	require.Zero(t, client.activeRuns())
}

// A delivered drain escalates to a cancel while the drain is still waiting: its active runs are
// terminated instead of being left to settle on their own, and the waiting drain remains the only
// release that completes, so exactly one instance.released is reported.
func TestCancelEscalatesAWaitingDrainIntoTerminatingActiveRuns(t *testing.T) {
	directory := t.TempDir()
	client := instanceTestClient(t, slowHarnessBinary(t, directory), directory, 2, 1, nil)
	instance, allocation := testInstanceAndAllocation(directory)
	provisionReady(t, client, instance, allocation)
	client.handleInstanceMessage(context.Background(), testDispatchMessage(instance, allocation, "run-one"))
	waitForMessage(t, client, "run.started")

	client.handleInstanceMessage(context.Background(), testReleaseMessage(allocation, "drain"))
	require.Eventually(t, func() bool {
		client.residents.mu.Lock()
		defer client.residents.mu.Unlock()
		resident := client.residents.residentsTable[allocation.ID]
		return resident != nil && resident.state == residentDraining
	}, 5*time.Second, 5*time.Millisecond, "the drain must be visibly waiting before the cancel arrives")

	client.handleInstanceMessage(context.Background(), testReleaseMessage(allocation, "cancel"))
	require.NotNil(t, waitForMessage(t, client, "run.cancelled"), "a cancel must escalate a waiting drain and terminate its active runs")
	require.NotNil(t, waitForInstanceMessage(t, client, "instance.released", allocation.ID))
	released := 0
	for _, message := range instanceControlMessages(t, client) {
		if message.Type == "instance.released" && message.AllocationID == allocation.ID {
			released++
		}
	}
	require.Equal(t, 1, released, "the waiting drain and the escalating cancel converge on exactly one instance.released")
	require.Zero(t, client.activeRuns())
	require.Zero(t, client.activeInstanceCount())
}

// A drain and a subsequent cancel race freely against an active run. Whichever order the two
// release goroutines take the resident lock in, the run is terminated, the release completes exactly
// once, and the slot is freed. The verification suite also runs this under -race.
func TestConcurrentDrainAndCancelConvergeOnOneReleasedOutcome(t *testing.T) {
	directory := t.TempDir()
	client := instanceTestClient(t, slowHarnessBinary(t, directory), directory, 4, 1, nil)
	instance, allocation := testInstanceAndAllocation(directory)
	provisionReady(t, client, instance, allocation)
	client.handleInstanceMessage(context.Background(), testDispatchMessage(instance, allocation, "run-one"))
	waitForMessage(t, client, "run.started")

	client.handleInstanceMessage(context.Background(), testReleaseMessage(allocation, "drain"))
	client.handleInstanceMessage(context.Background(), testReleaseMessage(allocation, "cancel"))

	require.NotNil(t, waitForMessage(t, client, "run.cancelled"), "the run must be terminated whether the cancel escalates a waiting drain or takes the resident first")
	require.NotNil(t, waitForInstanceMessage(t, client, "instance.released", allocation.ID))
	time.Sleep(100 * time.Millisecond)
	released := 0
	for _, message := range instanceControlMessages(t, client) {
		if message.Type == "instance.released" && message.AllocationID == allocation.ID {
			released++
		}
	}
	require.Equal(t, 1, released, "drain then cancel must converge on exactly one instance.released")
	require.Zero(t, client.activeRuns())
	require.Zero(t, client.activeInstanceCount())
}

func TestProvisionReplayConflictsOnEveryImmutableInstanceField(t *testing.T) {
	directory := t.TempDir()
	client := instanceTestClient(t, quickHarnessBinary(t, directory), directory, 2, 2, nil)
	instance, allocation := testInstanceAndAllocation(directory)
	provisionReady(t, client, instance, allocation)

	differentCreator := instance
	differentCreator.Creator = protocol.InstanceCreator{Kind: "run", RunID: "run-one", InstanceID: "instance-two"}
	skills := []string{"frontend-design"}
	differentRequirements := instance
	differentRequirements.Requirements.Skills = &skills
	differentPurpose := instance
	instructions := "Build the mobile shell."
	differentPurpose.Purpose = &protocol.InstancePurpose{Instructions: &instructions}

	for name, replay := range map[string]protocol.AgentInstance{
		"creator":      differentCreator,
		"requirements": differentRequirements,
		"purpose":      differentPurpose,
	} {
		t.Run(name, func(t *testing.T) {
			client.handleInstanceMessage(context.Background(), testProvisionMessage(replay, allocation))
			waitForInstanceReason(t, client, "instance.failed", allocation.ID, "a different resident is already hosted for this allocation")
		})
	}
	require.Equal(t, 1, client.activeInstanceCount(), "a conflicting replay must never replace the original resident")

	refreshed := instance
	refreshed.Lease.ExpiresAt = "2026-09-24T13:30:00Z"
	refreshed.Lease.IdleTimeoutSeconds = 3600
	refreshed.Status = "ready"
	client.handleInstanceMessage(context.Background(), testProvisionMessage(refreshed, allocation))
	waitForInstanceMessageCount(t, client, "instance.ready", allocation.ID, 2)
}

func TestProvisionAfterReleaseRefusesToReopenTheAllocation(t *testing.T) {
	directory := t.TempDir()
	client := instanceTestClient(t, quickHarnessBinary(t, directory), directory, 2, 2, nil)
	instance, allocation := testInstanceAndAllocation(directory)
	provisionReady(t, client, instance, allocation)
	client.handleInstanceMessage(context.Background(), testReleaseMessage(allocation, "drain"))
	require.NotNil(t, waitForInstanceMessage(t, client, "instance.released", ""))

	client.handleInstanceMessage(context.Background(), testProvisionMessage(instance, allocation))
	waitForInstanceReason(t, client, "instance.failed", allocation.ID, "this allocation was already released")
}

func TestProvisionDoesNotStartProviderWork(t *testing.T) {
	directory := t.TempDir()
	started := filepath.Join(directory, "provider-started")
	binary := fakeHarnessBinary(t, directory, "fake-codex", "#!/bin/sh\ntouch "+started+"\n")
	client := instanceTestClient(t, binary, directory, 2, 2, nil)
	instance, allocation := testInstanceAndAllocation(directory)
	provisionReady(t, client, instance, allocation)

	time.Sleep(100 * time.Millisecond)
	_, err := os.Stat(started)
	require.True(t, os.IsNotExist(err), "instance.ready must prove local prerequisites without starting a provider process or prompt")
}

func TestDispatchRequiresAnExactReadyAllocation(t *testing.T) {
	directory := t.TempDir()
	client := instanceTestClient(t, slowHarnessBinary(t, directory), directory, 4, 2, nil)
	instance, allocation := testInstanceAndAllocation(directory)
	provisionReady(t, client, instance, allocation)

	requireDispatchFailure := func(t *testing.T, message protocol.InstanceHubMessage, runID, expectedReason string) {
		t.Helper()
		client.handleInstanceMessage(context.Background(), message)
		failed := waitForRunFailure(t, client, runID)
		require.Contains(t, failed.Error, expectedReason)
		require.Zero(t, client.activeRuns(), "a rejected dispatch must never occupy a run slot")
	}

	unknownAllocation := allocation
	unknownAllocation.ID = "allocation-unknown"
	unknownInstance := instance
	unknownInstance.ID = "instance-unknown"
	unknownInstance.ThreadID = "thread-other"
	delegatingInstance := instance
	delegatingInstance.Delegation = protocol.InstanceDelegationPolicy{CanDelegate: true}
	otherThread := instance
	otherThread.ThreadID = "thread-other"

	cases := []struct {
		name       string
		instance   protocol.AgentInstance
		allocation protocol.InstanceAllocation
		reason     string
	}{
		{"unknown allocation", instance, unknownAllocation, "no resident allocation"},
		{"different instance", unknownInstance, allocation, "approved identity or placement"},
		{"different thread", otherThread, allocation, "approved identity or placement"},
		{"different delegation policy", delegatingInstance, allocation, "approved identity or placement"},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			requireDispatchFailure(t, testDispatchMessage(item.instance, item.allocation, "run-"+item.name), "run-"+item.name, item.reason)
		})
	}

	mismatches := []struct {
		name string
		edit func(run *protocol.InstanceRun)
	}{
		{"harness", func(run *protocol.InstanceRun) { run.HarnessID = "claude-cli" }},
		{"model", func(run *protocol.InstanceRun) { run.Model = "other-model" }},
		{"transport", func(run *protocol.InstanceRun) { run.Transport = "acp-v1" }},
		{"workspace", func(run *protocol.InstanceRun) { run.Workspace = filepath.Join(directory, "elsewhere") }},
	}
	for _, item := range mismatches {
		t.Run("run "+item.name, func(t *testing.T) {
			message := testDispatchMessage(instance, allocation, "run-"+item.name)
			item.edit(message.Run)
			requireDispatchFailure(t, message, "run-"+item.name, "does not match the resident allocation")
		})
	}

	t.Run("session binding", func(t *testing.T) {
		message := testDispatchMessage(instance, allocation, "run-binding")
		binding := "binding-one"
		message.Run.SessionBindingID = &binding
		requireDispatchFailure(t, message, "run-binding", "unsupported execution: the run's session binding is missing or names a different binding")
	})
	t.Run("workspace lease", func(t *testing.T) {
		message := testDispatchMessage(instance, allocation, "run-lease")
		lease := "lease-one"
		message.Run.WorkspaceLeaseID = &lease
		requireDispatchFailure(t, message, "run-lease", "unsupported execution: the run's workspace lease grant is missing or names a different lease")
	})
}

func TestDispatchAfterLeaseRenewalIsAccepted(t *testing.T) {
	directory := t.TempDir()
	client := instanceTestClient(t, quickHarnessBinary(t, directory), directory, 2, 1, nil)
	instance, allocation := testInstanceAndAllocation(directory)
	provisionReady(t, client, instance, allocation)

	// The protocol defines the lease as mutable — accepted work or an authorized renewal refreshes
	// its expiry and idle timeout — while the identity and placement stay fixed. A dispatch that
	// carries the renewed records must be admitted, not rejected as a different resident.
	renewedInstance, renewedAllocation := instance, allocation
	renewedInstance.Lease.ExpiresAt = "2026-09-24T13:30:00Z"
	renewedInstance.Lease.IdleTimeoutSeconds = 3600
	renewedInstance.Status = "idle"
	renewedInstance.UpdatedAt = "2026-09-24T12:10:00Z"
	renewedAllocation.Lease.ExpiresAt = "2026-09-24T13:30:00Z"
	renewedAllocation.Lease.IdleTimeoutSeconds = 3600
	renewedAllocation.Status = "active"
	renewedAllocation.UpdatedAt = "2026-09-24T12:10:00Z"
	client.handleInstanceMessage(context.Background(), testDispatchMessage(renewedInstance, renewedAllocation, "run-one"))
	require.NotNil(t, waitForMessage(t, client, "run.completed"), "a dispatch on the renewed lease must be admitted")
}

func TestDispatchRejectsWhileDrainingAndAfterRelease(t *testing.T) {
	directory := t.TempDir()
	client := instanceTestClient(t, slowHarnessBinary(t, directory), directory, 2, 1, nil)
	instance, allocation := testInstanceAndAllocation(directory)
	provisionReady(t, client, instance, allocation)

	client.handleInstanceMessage(context.Background(), testDispatchMessage(instance, allocation, "run-one"))
	waitForMessage(t, client, "run.started")
	// The release goroutine marks the resident draining before it waits, so a dispatch racing it
	// loses deterministically once draining is visible.
	client.handleInstanceMessage(context.Background(), testReleaseMessage(allocation, "drain"))
	time.Sleep(50 * time.Millisecond)
	client.handleInstanceMessage(context.Background(), testDispatchMessage(instance, allocation, "run-two"))
	failed := waitForRunFailure(t, client, "run-two")
	require.Contains(t, failed.Error, "the resident allocation is closed to new dispatch")

	// The drain stays waiting for run-one; finish it the way a hub cancel would so the release
	// can complete inside the test's time budget.
	client.handle(context.Background(), protocol.Inbound{Type: "cancel", RunID: "run-one"})
	require.NotNil(t, waitForMessage(t, client, "run.cancelled"))
	require.NotNil(t, waitForInstanceMessage(t, client, "instance.released", allocation.ID))
	client.handleInstanceMessage(context.Background(), testDispatchMessage(instance, allocation, "run-three"))
	failed = waitForRunFailure(t, client, "run-three")
	require.Contains(t, failed.Error, "no resident allocation on this Barista matches the dispatch")
}

func TestProvisionReplayWhileDrainingIsNotAcknowledgedReady(t *testing.T) {
	directory := t.TempDir()
	client := instanceTestClient(t, slowHarnessBinary(t, directory), directory, 2, 1, nil)
	instance, allocation := testInstanceAndAllocation(directory)
	provisionReady(t, client, instance, allocation)
	client.handleInstanceMessage(context.Background(), testDispatchMessage(instance, allocation, "run-one"))
	waitForMessage(t, client, "run.started")

	client.handleInstanceMessage(context.Background(), testReleaseMessage(allocation, "drain"))
	require.Eventually(t, func() bool {
		client.residents.mu.Lock()
		defer client.residents.mu.Unlock()
		resident := client.residents.residentsTable[allocation.ID]
		return resident != nil && resident.state == residentDraining
	}, 5*time.Second, 5*time.Millisecond, "the drain must be visibly waiting before the replay arrives")

	// The exact replay carries only refreshed hub-side bookkeeping, so it matches the draining
	// resident; acknowledging instance.ready would advertise capacity the hub can no longer dispatch to.
	replayedInstance := instance
	replayedInstance.Status = "ready"
	replayedInstance.UpdatedAt = "2026-09-24T12:10:00Z"
	client.handleInstanceMessage(context.Background(), testProvisionMessage(replayedInstance, allocation))
	failed := waitForInstanceReason(t, client, "instance.failed", allocation.ID, "draining")
	require.Equal(t, allocation.ID, failed.AllocationID)
	readyMessages := 0
	for _, message := range instanceControlMessages(t, client) {
		if message.Type == "instance.ready" && message.AllocationID == allocation.ID {
			readyMessages++
		}
	}
	require.Equal(t, 1, readyMessages, "a replay against a draining resident must not add a second instance.ready")
	require.Equal(t, 1, client.activeInstanceCount(), "the replay must neither reserve nor free a slot")

	// The drain still owns the outcome: finish the run the way a hub cancel would and require the
	// release to complete without the replay having reopened the resident.
	client.handle(context.Background(), protocol.Inbound{Type: "cancel", RunID: "run-one"})
	require.NotNil(t, waitForMessage(t, client, "run.cancelled"))
	require.NotNil(t, waitForInstanceMessage(t, client, "instance.released", allocation.ID))
	require.Zero(t, client.activeInstanceCount())
}

func TestDrainWaitsForActiveRunsBeforeReportingReleased(t *testing.T) {
	directory := t.TempDir()
	client := instanceTestClient(t, slowHarnessBinary(t, directory), directory, 2, 1, nil)
	instance, allocation := testInstanceAndAllocation(directory)
	provisionReady(t, client, instance, allocation)
	client.handleInstanceMessage(context.Background(), testDispatchMessage(instance, allocation, "run-one"))
	waitForMessage(t, client, "run.started")

	client.handleInstanceMessage(context.Background(), testReleaseMessage(allocation, "drain"))
	// The drain cannot complete while the run is still active; the run finishes only by timing out
	// the harness sleep, so simulate the run's completion by cancelling it through the run cancel
	// path a hub would trigger, then require the release to finish.
	time.Sleep(100 * time.Millisecond)
	require.Nil(t, waitForInstanceMessage(t, client, "instance.released", allocation.ID), "a drain must not report released while a run is active")

	client.handle(context.Background(), protocol.Inbound{Type: "cancel", RunID: "run-one"})
	require.NotNil(t, waitForMessage(t, client, "run.cancelled"))
	released := waitForInstanceMessage(t, client, "instance.released", allocation.ID)
	require.NotNil(t, released)
	require.Equal(t, allocation.ID, released.AllocationID)
	require.Zero(t, client.activeInstanceCount())
}

func TestCancelReleaseTerminatesActiveRunsThenReleases(t *testing.T) {
	directory := t.TempDir()
	client := instanceTestClient(t, slowHarnessBinary(t, directory), directory, 2, 1, nil)
	instance, allocation := testInstanceAndAllocation(directory)
	provisionReady(t, client, instance, allocation)
	client.handleInstanceMessage(context.Background(), testDispatchMessage(instance, allocation, "run-one"))
	waitForMessage(t, client, "run.started")

	client.handleInstanceMessage(context.Background(), testReleaseMessage(allocation, "cancel"))
	require.NotNil(t, waitForMessage(t, client, "run.cancelled"), "a cancelling release terminates the resident's active runs")
	require.NotNil(t, waitForInstanceMessage(t, client, "instance.released", allocation.ID))
	require.Zero(t, client.activeRuns())
	require.Zero(t, client.activeInstanceCount())

	// The cancelled run stays tombstoned: a replayed dispatch for it is never restarted.
	client.handleInstanceMessage(context.Background(), testDispatchMessage(instance, allocation, "run-one"))
	time.Sleep(50 * time.Millisecond)
	require.Zero(t, client.activeRuns())
}

func TestSequentialRunsShareOneResidentWhileConcurrencyStaysIndependent(t *testing.T) {
	directory := t.TempDir()
	client := instanceTestClient(t, quickHarnessBinary(t, directory), directory, 1, 1, nil)
	instance, allocation := testInstanceAndAllocation(directory)
	provisionReady(t, client, instance, allocation)

	client.handleInstanceMessage(context.Background(), testDispatchMessage(instance, allocation, "run-one"))
	require.NotNil(t, waitForMessage(t, client, "run.completed"))
	client.handleInstanceMessage(context.Background(), testDispatchMessage(instance, allocation, "run-two"))
	require.NotNil(t, waitForMessage(t, client, "run.completed"), "one resident may run sequential attempts")
	require.Equal(t, 1, client.activeInstanceCount())
}

func TestRunConcurrencyIsStillEnforcedAlongsideResidents(t *testing.T) {
	directory := t.TempDir()
	client := instanceTestClient(t, slowHarnessBinary(t, directory), directory, 1, 1, nil)
	instance, allocation := testInstanceAndAllocation(directory)
	provisionReady(t, client, instance, allocation)

	client.handleInstanceMessage(context.Background(), testDispatchMessage(instance, allocation, "run-one"))
	waitForMessage(t, client, "run.started")
	client.handleInstanceMessage(context.Background(), testDispatchMessage(instance, allocation, "run-two"))
	failed := waitForRunFailure(t, client, "run-two")
	require.Equal(t, "Barista concurrency limit (1) reached", failed.Error)

	client.handleInstanceMessage(context.Background(), testReleaseMessage(allocation, "cancel"))
	require.NotNil(t, waitForInstanceMessage(t, client, "instance.released", allocation.ID))
}

func TestReleaseCleanupFailureKeepsTheSlotOccupiedAndRetrySucceeds(t *testing.T) {
	directory := t.TempDir()
	client := instanceTestClient(t, quickHarnessBinary(t, directory), directory, 2, 1, nil)
	instance, allocation := testInstanceAndAllocation(directory)
	provisionReady(t, client, instance, allocation)

	attempts := 0
	client.registerResidentCleanup(allocation.ID, "stuck-resource", func() error {
		attempts++
		if attempts == 1 {
			return errors.New("the provider session could not be closed")
		}
		return nil
	})

	client.handleInstanceMessage(context.Background(), testReleaseMessage(allocation, "drain"))
	waitForInstanceReason(t, client, "instance.failed", allocation.ID, "release cleanup failed")
	require.Equal(t, 1, client.activeInstanceCount(), "a failed cleanup must never advertise the slot as free")

	client.handleInstanceMessage(context.Background(), testDispatchMessage(instance, allocation, "run-one"))
	rejected := waitForMessage(t, client, "run.failed")
	require.Equal(t, "run-one", rejected.RunID)
	require.Contains(t, rejected.Error, "closed to new dispatch")

	client.handleInstanceMessage(context.Background(), testProvisionMessage(instance, allocation))
	waitForInstanceReason(t, client, "instance.failed", allocation.ID, "held by a failed release cleanup")

	client.handleInstanceMessage(context.Background(), testReleaseMessage(allocation, "drain"))
	waitForInstanceMessageCount(t, client, "instance.released", allocation.ID, 1)
	require.Zero(t, client.activeInstanceCount())
	require.Equal(t, 2, attempts)
}

func TestDuplicateAndUnknownReleasesReturnThePriorOutcome(t *testing.T) {
	directory := t.TempDir()
	client := instanceTestClient(t, quickHarnessBinary(t, directory), directory, 2, 2, nil)
	instance, allocation := testInstanceAndAllocation(directory)
	provisionReady(t, client, instance, allocation)
	client.handleInstanceMessage(context.Background(), testReleaseMessage(allocation, "drain"))
	require.NotNil(t, waitForInstanceMessage(t, client, "instance.released", allocation.ID))
	client.handleInstanceMessage(context.Background(), testReleaseMessage(allocation, "drain"))
	waitForInstanceMessageCount(t, client, "instance.released", allocation.ID, 2)

	_, unknownAllocation := testInstanceAndAllocationFor("instance-two", "allocation-unknown", directory)
	client.handleInstanceMessage(context.Background(), testReleaseMessage(unknownAllocation, "cancel"))
	unknown := waitForInstanceMessage(t, client, "instance.released", "allocation-unknown")
	require.NotNil(t, unknown, "releasing an allocation this Barista does not host acknowledges released so the hub converges")
}

func TestReleaseWithWrongInstanceIDIsRefused(t *testing.T) {
	directory := t.TempDir()
	client := instanceTestClient(t, quickHarnessBinary(t, directory), directory, 2, 1, nil)
	instance, allocation := testInstanceAndAllocation(directory)
	provisionReady(t, client, instance, allocation)

	message := testReleaseMessage(allocation, "drain")
	message.InstanceID = "instance-other"
	client.handleInstanceMessage(context.Background(), message)
	failed := waitForInstanceMessage(t, client, "instance.failed", "")
	require.NotNil(t, failed)
	require.Contains(t, *failed.Error, "names a different instance")
	require.Equal(t, 1, client.activeInstanceCount(), "the resident is retained")
}

// A hub that does not own a resident's allocation knows only its instance ID — the identity
// sync.complete reports — so its release substitutes the instance ID for the allocation ID. Such a
// release must still evict the real resident, close its session resources, free the slot exactly
// once, and acknowledge under the resident's true allocation ID.
func TestReleaseNamingAnInstanceWhoseAllocationIsUnknownEvictsTheResident(t *testing.T) {
	directory := t.TempDir()
	client := instanceTestClient(t, slowHarnessBinary(t, directory), directory, 2, 1, nil)
	instance, allocation := testInstanceAndAllocation(directory)
	provisionReady(t, client, instance, allocation)
	client.handleInstanceMessage(context.Background(), testDispatchMessage(instance, allocation, "run-one"))
	waitForMessage(t, client, "run.started")

	cleanups := 0
	client.registerResidentCleanup(allocation.ID, "session-resource", func() error {
		cleanups++
		return nil
	})

	substitute := testReleaseMessage(allocation, "cancel")
	substitute.AllocationID = "allocation-substituted"
	client.handleInstanceMessage(context.Background(), substitute)

	require.NotNil(t, waitForMessage(t, client, "run.cancelled"), "the eviction must terminate the resident's active runs")
	released := waitForInstanceMessage(t, client, "instance.released", allocation.ID)
	require.NotNil(t, released, "the eviction must be acknowledged under the resident's true allocation ID")
	require.Zero(t, client.activeRuns())
	require.Zero(t, client.activeInstanceCount())
	require.Equal(t, 1, cleanups, "the resident's session resources are closed exactly once")

	client.handleInstanceMessage(context.Background(), substitute)
	acknowledged := waitForInstanceMessage(t, client, "instance.released", "allocation-substituted")
	require.NotNil(t, acknowledged, "a replay of the substituted release is acknowledged already-released")
	require.Equal(t, 1, cleanups, "the replay must not run the resident's cleanup again")
}

// Admission refuses to host an instance under a second concurrent allocation, so the ambiguous
// match this test provokes can no longer be produced through provisioning. The duplicate state is
// injected directly into the table to keep the release-side guard exercised — it is defense in
// depth for a table that structurally permits what admission now refuses, so it must keep refusing
// rather than guess.
func TestAmbiguousInstanceMatchOnAnUnknownAllocationReleaseIsRefused(t *testing.T) {
	directory := t.TempDir()
	client := instanceTestClient(t, quickHarnessBinary(t, directory), directory, 2, 2, nil)
	firstInstance, firstAllocation := testInstanceAndAllocationFor("instance-shared", "allocation-one", directory)
	provisionReady(t, client, firstInstance, firstAllocation)
	secondInstance, secondAllocation := testInstanceAndAllocationFor("instance-shared", "allocation-two", directory)
	client.residents.mu.Lock()
	client.residents.residentsTable[secondAllocation.ID] = &residentInstance{
		instance: secondInstance, allocation: secondAllocation, state: residentReady,
		runs: map[string]struct{}{}, closers: map[string]func() error{},
	}
	client.residents.mu.Unlock()

	message := testReleaseMessage(firstAllocation, "drain")
	message.AllocationID = "allocation-unknown"
	client.handleInstanceMessage(context.Background(), message)
	failed := waitForInstanceMessage(t, client, "instance.failed", "allocation-unknown")
	require.NotNil(t, failed)
	require.Contains(t, *failed.Error, "multiple resident allocations")
	require.Equal(t, 2, client.activeInstanceCount(), "an ambiguous match must not guess and evict either resident")
}

// A provision that would host an instance under a second concurrent allocation is refused before
// any resident state changes: an instance is hosted by one allocation at a time — the same
// invariant the hub's load validation states — because a duplicate resident would make the
// heartbeat identity list either invalid (a repeated ID fails the protocol's uniqueness check) or,
// if deduplicated, an under-count of the slots the instance family occupies.
func TestProvisionRefusesASecondConcurrentResidentForAnInstance(t *testing.T) {
	directory := t.TempDir()
	client := instanceTestClient(t, quickHarnessBinary(t, directory), directory, 2, 2, nil)
	instance, allocation := testInstanceAndAllocation(directory)
	provisionReady(t, client, instance, allocation)

	replacementInstance, replacementAllocation := testInstanceAndAllocationFor(instance.ID, "allocation-two", directory)
	client.handleInstanceMessage(context.Background(), testProvisionMessage(replacementInstance, replacementAllocation))
	failed := waitForInstanceMessage(t, client, "instance.failed", replacementAllocation.ID)
	require.NotNil(t, failed)
	require.Contains(t, *failed.Error, "already hosted by allocation "+allocation.ID)
	require.Equal(t, 1, client.activeInstanceCount(), "a refused duplicate must not become a second resident")

	// An exact replay of the hosted allocation stays idempotent: it is answered by the replay
	// lookup, never mistaken for a second resident.
	client.handleInstanceMessage(context.Background(), testProvisionMessage(instance, allocation))
	waitForInstanceMessageCount(t, client, "instance.ready", allocation.ID, 2)
	require.Equal(t, 1, client.activeInstanceCount(), "an exact replay must neither reserve nor free a slot")

	// Replacement after release is legitimate: only a concurrently resident duplicate is refused.
	client.handleInstanceMessage(context.Background(), testReleaseMessage(allocation, "drain"))
	require.NotNil(t, waitForInstanceMessage(t, client, "instance.released", allocation.ID))
	client.handleInstanceMessage(context.Background(), testProvisionMessage(replacementInstance, replacementAllocation))
	require.NotNil(t, waitForInstanceMessage(t, client, "instance.ready", replacementAllocation.ID), "a released instance may be hosted again under a new allocation")
	require.Equal(t, 1, client.activeInstanceCount())
}

// The heartbeat identity list is unique by construction and its length is the resident count, so it
// is accurate occupancy evidence the hub can count directly.
func TestHeartbeatInstanceIdentitiesAreUniqueAndCountTheResidents(t *testing.T) {
	directory := t.TempDir()
	client := instanceTestClient(t, quickHarnessBinary(t, directory), directory, 3, 3, nil)
	for index := 0; index < 3; index++ {
		instance, allocation := testInstanceAndAllocationFor(fmt.Sprintf("instance-%d", index), fmt.Sprintf("allocation-%d", index), directory)
		provisionReady(t, client, instance, allocation)
	}
	heartbeat := client.heartbeatMessage()
	identities := *heartbeat.ActiveInstanceIDs
	require.Equal(t, []string{"instance-0", "instance-1", "instance-2"}, identities, "the snapshot is sorted")
	require.Equal(t, client.activeInstanceCount(), len(identities), "the identity count is the resident count")
	seen := map[string]struct{}{}
	for _, identity := range identities {
		require.NotContains(t, seen, identity, "an instance is hosted by one allocation at a time, so no identity repeats")
		seen[identity] = struct{}{}
	}

	// A duplicate the admission invariant refuses never reaches the list.
	duplicateInstance, duplicateAllocation := testInstanceAndAllocationFor("instance-1", "allocation-duplicate", directory)
	client.handleInstanceMessage(context.Background(), testProvisionMessage(duplicateInstance, duplicateAllocation))
	require.NotNil(t, waitForInstanceMessage(t, client, "instance.failed", duplicateAllocation.ID))
	nextHeartbeat := client.heartbeatMessage()
	require.Equal(t, identities, *nextHeartbeat.ActiveInstanceIDs)
	require.Equal(t, 3, *nextHeartbeat.ActiveInstances)
}

func TestHeartbeatAndRegistrationReportIndependentResidentCounts(t *testing.T) {
	directory := t.TempDir()
	client := instanceTestClient(t, quickHarnessBinary(t, directory), directory, 3, 2, nil)
	instance, allocation := testInstanceAndAllocation(directory)

	heartbeat := client.heartbeatMessage()
	require.Equal(t, 0, *heartbeat.ActiveInstances)
	require.NotNil(t, heartbeat.ActiveRuns)
	require.Equal(t, 0, *heartbeat.ActiveRuns)
	require.NotNil(t, heartbeat.ActiveInstanceIDs, "every heartbeat carries identity evidence")
	require.Empty(t, *heartbeat.ActiveInstanceIDs, "zero residents are an explicit empty array, not an absent field")

	provisionReady(t, client, instance, allocation)
	heartbeat = client.heartbeatMessage()
	require.Equal(t, 1, *heartbeat.ActiveInstances)
	require.Equal(t, []string{"instance-one"}, *heartbeat.ActiveInstanceIDs)

	instanceIDs := client.activeInstanceIDs()
	require.Equal(t, []string{"instance-one"}, instanceIDs)
	require.NotNil(t, client.node.InstanceCapacity)
	require.Equal(t, 2, *client.node.InstanceCapacity)
}

func TestSyncCompleteReportsExplicitEmptyInstanceEvidence(t *testing.T) {
	client := NewClient(config.Config{Concurrency: 1, InstanceCapacity: 2}, protocol.ComputeNode{ID: "node-one"}, nil, emptyCapabilityReport)
	sync := client.attachTestSync()
	require.NotNil(t, sync.ActiveInstanceIDs)
	require.Empty(t, *sync.ActiveInstanceIDs, "a reconnect with zero residents sends an explicit empty array, not an absent field")
}

// attachTestSync drives one attach cycle against a throwaway hub socket and returns the
// sync.complete message the hub received.
func (client *Client) attachTestSync() (sync protocol.Outbound) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(writer, request, nil)
		if err != nil {
			return
		}
		defer connection.Close(websocket.StatusNormalClosure, "test complete")
		ctx := request.Context()
		for {
			_, data, readErr := connection.Read(ctx)
			if readErr != nil {
				return
			}
			var message protocol.Outbound
			if json.Unmarshal(data, &message) != nil {
				continue
			}
			switch message.Type {
			case "register":
				if err := connection.Write(ctx, websocket.MessageText, []byte(`{"type":"ping"}`)); err != nil {
					return
				}
			case "sync.complete":
				sync = message
				return
			}
		}
	}))
	defer server.Close()
	client.config.ControlEndpoint = strings.Replace(server.URL, "http://", "ws://", 1)
	client.runOnce(context.Background())
	return sync
}

func TestReconnectRetainsResidentsAcrossConnections(t *testing.T) {
	directory := t.TempDir()
	client := instanceTestClient(t, quickHarnessBinary(t, directory), directory, 2, 2, nil)
	instance, allocation := testInstanceAndAllocation(directory)
	provisionReady(t, client, instance, allocation)

	var registered []*protocol.ComputeNode
	var synced []*protocol.Outbound
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(writer, request, nil)
		if err != nil {
			return
		}
		defer connection.Close(websocket.StatusNormalClosure, "test complete")
		ctx := request.Context()
		for {
			_, data, readErr := connection.Read(ctx)
			if readErr != nil {
				return
			}
			var message protocol.Outbound
			if json.Unmarshal(data, &message) != nil {
				continue
			}
			switch message.Type {
			case "register":
				require.NoError(t, connection.Write(ctx, websocket.MessageText, []byte(`{"type":"ping"}`)))
				if message.Node != nil {
					nodeCopy := *message.Node
					registered = append(registered, &nodeCopy)
				}
			case "sync.complete":
				syncCopy := message
				synced = append(synced, &syncCopy)
				return
			}
		}
	}))
	defer server.Close()
	client.config.ControlEndpoint = strings.Replace(server.URL, "http://", "ws://", 1)

	client.runOnce(context.Background())
	client.runOnce(context.Background())

	require.Len(t, registered, 2, "each connection registers")
	for _, node := range registered {
		require.NotNil(t, node.InstanceCapacity)
		require.Equal(t, 2, *node.InstanceCapacity)
		require.NotNil(t, node.ActiveInstances)
		require.Equal(t, 1, *node.ActiveInstances)
	}
	require.Len(t, synced, 2)
	for _, sync := range synced {
		require.NotNil(t, sync.ActiveInstanceIDs)
		require.Equal(t, []string{"instance-one"}, *sync.ActiveInstanceIDs, "resident supervision survives reconnection for the process lifetime")
	}
}

func TestInstanceMessagesFromTheProtocolFixturesAreAccepted(t *testing.T) {
	directory := t.TempDir()
	client := instanceTestClient(t, quickHarnessBinary(t, directory), directory, 2, 2, nil)
	// The fixture allocation names node-one with workspace /workspace, which no test root
	// contains; the dispatch must still be decoded and answered with run.failed rather than
	// crashing or being silently reinterpreted as a legacy run.
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "protocol", "test", "fixtures", "control-v5", "dispatch.json"))
	require.NoError(t, err)
	message, err := protocol.DecodeInstanceHubMessage(data, protocol.Version)
	require.NoError(t, err)
	require.Equal(t, "dispatch", message.Type)
	client.handleInstanceMessage(context.Background(), message)
	provisionData, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "protocol", "test", "fixtures", "control-v5", "provision.json"))
	require.NoError(t, err)
	provision, err := protocol.DecodeInstanceHubMessage(provisionData, protocol.Version)
	require.NoError(t, err)
	client.handleInstanceMessage(context.Background(), provision)
	failed := waitForInstanceMessage(t, client, "instance.failed", "")
	require.NotNil(t, failed)
	require.Zero(t, client.activeInstanceCount())
}

// The resident comparator is exercised against the committed producer fixtures — the exact output
// of instanceFixtureProducer in apps/control-agent/internal/protocol/instances_test.go:21 — rather
// than hand-built records, so the fields it compares are the fields the real wire carries.
func TestResidentMatchingAgainstTheProtocolFixtures(t *testing.T) {
	provisionData, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "protocol", "test", "fixtures", "control-v5", "provision.json"))
	require.NoError(t, err)
	provision, err := protocol.DecodeInstanceHubMessage(provisionData, protocol.Version)
	require.NoError(t, err)
	dispatchData, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "protocol", "test", "fixtures", "control-v5", "dispatch.json"))
	require.NoError(t, err)
	dispatch, err := protocol.DecodeInstanceHubMessage(dispatchData, protocol.Version)
	require.NoError(t, err)

	resident := residentInstance{instance: *provision.Instance, allocation: *provision.Allocation}

	// The dispatch fixture carries hub-side bookkeeping the provision fixture does not — ready and
	// active statuses — while identity, specification, and placement are unchanged.
	require.True(t, resident.matches(*dispatch.Instance, *dispatch.Allocation))

	renewedInstance, renewedAllocation := *dispatch.Instance, *dispatch.Allocation
	renewedInstance.Lease.ExpiresAt = "2026-09-24T14:30:00Z"
	renewedInstance.Lease.IdleTimeoutSeconds = protocol.MaximumInstanceIdleTimeoutSeconds
	renewedAllocation.Lease.ExpiresAt = "2026-09-24T14:30:00Z"
	renewedAllocation.Lease.IdleTimeoutSeconds = protocol.MaximumInstanceIdleTimeoutSeconds
	require.True(t, resident.matches(renewedInstance, renewedAllocation), "a renewal refreshes the lease without changing identity or placement")

	conflictingCreator := renewedInstance
	conflictingCreator.Creator = protocol.InstanceCreator{Kind: "run", RunID: "run-one", InstanceID: renewedInstance.ID}
	require.False(t, resident.matches(conflictingCreator, renewedAllocation), "the creator is immutable instance provenance")

	conflictingRequirements := renewedInstance
	skills := []string{"frontend-design"}
	conflictingRequirements.Requirements.Skills = &skills
	require.False(t, resident.matches(conflictingRequirements, renewedAllocation), "the original requirements are immutable")

	conflictingPlacement := renewedAllocation
	conflictingPlacement.Workspace = "/other"
	require.False(t, resident.matches(renewedInstance, conflictingPlacement), "the resolved placement is immutable")
}

func TestEveryInstanceHubMessageTypeAndReleaseModeIsHandled(t *testing.T) {
	directory := t.TempDir()
	for _, messageType := range protocol.InstanceHubMessageTypes {
		t.Run(messageType, func(t *testing.T) {
			client := instanceTestClient(t, quickHarnessBinary(t, directory), directory, 2, 1, nil)
			instance, allocation := testInstanceAndAllocation(directory)
			var message protocol.InstanceHubMessage
			switch messageType {
			case "instance.provision":
				message = testProvisionMessage(instance, allocation)
			case "instance.release":
				message = testReleaseMessage(allocation, "drain")
			case "dispatch":
				message = testDispatchMessage(instance, allocation, "run-one")
			}
			require.NotPanics(t, func() { client.handleInstanceMessage(context.Background(), message) })
		})
	}
	for _, mode := range protocol.InstanceReleaseModes {
		t.Run("release-"+mode, func(t *testing.T) {
			client := instanceTestClient(t, quickHarnessBinary(t, directory), directory, 2, 1, nil)
			instance, allocation := testInstanceAndAllocation(directory)
			provisionReady(t, client, instance, allocation)
			client.handleInstanceMessage(context.Background(), testReleaseMessage(allocation, mode))
			require.NotNil(t, waitForInstanceMessage(t, client, "instance.released", ""))
		})
	}
}

func TestLegacyDispatchStillWorksAlongsideResidentSupervision(t *testing.T) {
	directory := t.TempDir()
	client := instanceTestClient(t, quickHarnessBinary(t, directory), directory, 2, 2, nil)
	instance, allocation := testInstanceAndAllocation(directory)
	provisionReady(t, client, instance, allocation)

	run := protocol.Run{ID: "legacy-run", HarnessID: "codex-cli", Model: "default", Workspace: directory, Prompt: "legacy"}
	client.handle(context.Background(), protocol.Inbound{Type: "dispatch", Run: run, Agent: protocol.Agent{ID: "agent-one"}})
	require.NotNil(t, waitForMessage(t, client, "run.completed"))
	require.Equal(t, 1, client.activeInstanceCount(), "a legacy run neither consumes nor disturbs resident capacity")
}

func TestInstanceFailedReasonsStayWithinTheDiagnosticBound(t *testing.T) {
	require.LessOrEqual(t, len(boundedInstanceReason(strings.Repeat("x", 10*1024))), 2*1024)
	require.Equal(t, "short", boundedInstanceReason("short"))
}

func TestReleaseAfterReconnectCancelsRunsAndReleasesTheResident(t *testing.T) {
	directory := t.TempDir()
	client := instanceTestClient(t, slowHarnessBinary(t, directory), directory, 2, 1, nil)
	instance, allocation := testInstanceAndAllocation(directory)
	provisionReady(t, client, instance, allocation)
	client.handleInstanceMessage(context.Background(), testDispatchMessage(instance, allocation, "run-one"))
	waitForMessage(t, client, "run.started")

	// The connection drops and Barista reconnects; the run and the resident both survive.
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(writer, request, nil)
		if err != nil {
			return
		}
		defer connection.Close(websocket.StatusNormalClosure, "test complete")
		ctx := request.Context()
		for {
			_, data, readErr := connection.Read(ctx)
			if readErr != nil {
				return
			}
			var message protocol.Outbound
			if json.Unmarshal(data, &message) != nil {
				continue
			}
			if message.Type == "register" {
				require.NoError(t, connection.Write(ctx, websocket.MessageText, []byte(`{"type":"ping"}`)))
				continue
			}
			if message.Type == "sync.complete" {
				sync := message
				require.NotNil(t, sync.ActiveRunIDs)
				require.Equal(t, []string{"run-one"}, *sync.ActiveRunIDs)
				require.NotNil(t, sync.ActiveInstanceIDs)
				require.Equal(t, []string{"instance-one"}, *sync.ActiveInstanceIDs)
				return
			}
		}
	}))
	defer server.Close()
	client.config.ControlEndpoint = strings.Replace(server.URL, "http://", "ws://", 1)
	client.runOnce(context.Background())
	require.Equal(t, 1, client.activeRuns(), "the run survives the reconnect")
	require.Equal(t, 1, client.activeInstanceCount(), "the resident survives the reconnect")

	client.handleInstanceMessage(context.Background(), testReleaseMessage(allocation, "cancel"))
	require.NotNil(t, waitForMessage(t, client, "run.cancelled"))
	require.NotNil(t, waitForInstanceMessage(t, client, "instance.released", allocation.ID))
	require.Zero(t, client.activeRuns())
	require.Zero(t, client.activeInstanceCount())
}

func TestConcurrentProvisionDispatchAndReleaseStayConsistent(t *testing.T) {
	directory := t.TempDir()
	client := instanceTestClient(t, quickHarnessBinary(t, directory), directory, 4, 2, nil)

	// Each round hosts a fresh allocation and lets its provision, dispatch, and release race freely;
	// rounds are separated by waiting for the round's release outcome, because a release that
	// arrives while a drain is still settling is ignored by design and would otherwise swallow that
	// round's instance.released nondeterministically.
	const rounds = 20
	for round := 0; round < rounds; round++ {
		instance, allocation := testInstanceAndAllocationFor(fmt.Sprintf("instance-%d", round), fmt.Sprintf("allocation-%d", round), directory)
		client.handleInstanceMessage(context.Background(), testProvisionMessage(instance, allocation))
		go client.handleInstanceMessage(context.Background(), testDispatchMessage(instance, allocation, fmt.Sprintf("run-%d", round)))
		client.handleInstanceMessage(context.Background(), testReleaseMessage(allocation, "cancel"))
		waitForInstanceMessageCount(t, client, "instance.released", allocation.ID, 1)
	}
	deadline := time.Now().Add(10 * time.Second)
	for client.activeRuns() > 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	require.Zero(t, client.activeRuns())
	require.Zero(t, client.activeInstanceCount(), "every round's release completed and freed the slot")
	// The resident table never leaks a run membership entry after everything settled.
	client.residents.mu.Lock()
	require.Empty(t, client.residents.residentsTable)
	client.residents.mu.Unlock()
}
