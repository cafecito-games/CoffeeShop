package controlplane

import (
	"context"
	"fmt"
	"log"
	"reflect"
	"sort"
	"sync"
	"unicode/utf8"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/harness"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

// retainedReleaseOutcomes bounds how many finished release outcomes the supervisor remembers, so
// an exact replay of instance.release after a reconnect is still acknowledged idempotently. The
// bound keeps a long-lived Barista from growing without limit; beyond it, a replay of a long-gone
// allocation is answered like any other unknown allocation (released), which is the truthful state.
const retainedReleaseOutcomes = 512

type residentState int

const (
	residentReady residentState = iota
	residentDraining
	residentCleanupFailed
)

// residentInstance is one resident allocation hosted by this Barista. The instance identity,
// creator, purpose, delegation policy, requirements, and resolved placement are immutable for the
// allocation's lifetime; the lease, status, and timestamps are hub-side mutable state that an
// exact replay or an accepted dispatch refreshes. The allocation ID is the lifecycle generation on
// the wire, because its resolved identity can never change — replacement requires a new ID.
type residentInstance struct {
	instance   protocol.AgentInstance
	allocation protocol.InstanceAllocation
	state      residentState
	// runs is the active-run membership registered before the run starts any side effect and
	// removed exactly once when the run settles.
	runs    map[string]struct{}
	closers map[string]func() error
	// settled is created when a release starts draining and closed once the last registered run
	// settles, so a drain can wait without polling.
	settled chan struct{}
}

// residentSupervisor is the single owner of resident admission and release state. Dispatch
// admission, heartbeat, sync, and registration query it instead of keeping separate counters.
// Its mutex is never held while waiting for a run, a process, a filesystem operation, or a
// network send; the only nested lock is runsMu, acquired briefly and always after this one.
type residentSupervisor struct {
	mu             sync.Mutex
	capacity       int
	residentsTable map[string]*residentInstance
	// releasedOutcomes remembers allocations whose release completed, bounded by
	// retainedReleaseOutcomes in first-release order.
	releasedOutcomes map[string]struct{}
	releasedOrder    []string
}

func newResidentSupervisor(capacity int) residentSupervisor {
	return residentSupervisor{
		capacity:         capacity,
		residentsTable:   map[string]*residentInstance{},
		releasedOutcomes: map[string]struct{}{},
	}
}

// closeSettledLocked closes the settled channel exactly once.
func (resident *residentInstance) closeSettledLocked() {
	if resident.settled == nil {
		return
	}
	select {
	case <-resident.settled:
	default:
		close(resident.settled)
	}
}

// immutableResidentForm clears the protocol-defined mutable fields of the instance and allocation
// records — the lease, which accepted work or an authorized renewal refreshes, and the hub-side
// status and timestamps — leaving the immutable identity, creator, purpose, delegation policy,
// requirements, and resolved placement. Every other field of the wire records stays in the form, so
// a field the protocol adds later is compared by default instead of being silently skipped.
func immutableResidentForm(instance protocol.AgentInstance, allocation protocol.InstanceAllocation) (protocol.AgentInstance, protocol.InstanceAllocation) {
	instance.Lease = protocol.InstanceLease{}
	instance.Status = ""
	instance.CreatedAt = ""
	instance.UpdatedAt = ""
	allocation.Lease = protocol.InstanceLease{}
	allocation.Status = ""
	allocation.CreatedAt = ""
	allocation.UpdatedAt = ""
	return instance, allocation
}

// matches reports whether the immutable identity, specification, and resolved placement of a
// provision or dispatch equal the hosted resident's. The mutable hub-side state — the lease and its
// bookkeeping — is cleared on both sides first, so a resident whose lease the hub renewed still
// matches the dispatches that follow the renewal.
func (resident *residentInstance) matches(instance protocol.AgentInstance, allocation protocol.InstanceAllocation) bool {
	residentInstanceRecord, residentAllocationRecord := immutableResidentForm(resident.instance, resident.allocation)
	messageInstanceRecord, messageAllocationRecord := immutableResidentForm(instance, allocation)
	return reflect.DeepEqual(residentInstanceRecord, messageInstanceRecord) &&
		reflect.DeepEqual(residentAllocationRecord, messageAllocationRecord)
}

// recordReleasedLocked remembers a completed release outcome under the bound above.
func (supervisor *residentSupervisor) recordReleasedLocked(allocationID string) {
	if _, exists := supervisor.releasedOutcomes[allocationID]; exists {
		return
	}
	supervisor.releasedOutcomes[allocationID] = struct{}{}
	supervisor.releasedOrder = append(supervisor.releasedOrder, allocationID)
	for len(supervisor.releasedOrder) > retainedReleaseOutcomes {
		delete(supervisor.releasedOutcomes, supervisor.releasedOrder[0])
		supervisor.releasedOrder = supervisor.releasedOrder[1:]
	}
}

// admitRunLocked validates a dispatch against its resident and, on success, leaves the caller
// holding the resident lock with the run's admission decision made while the resident was still
// ready. The caller registers the run membership before releasing the lock, which is what makes a
// concurrent drain win or lose against this dispatch atomically.
func (supervisor *residentSupervisor) admitRunLocked(allocationID string, run protocol.Run) string {
	resident := supervisor.residentsTable[allocationID]
	if resident == nil {
		return "no resident allocation on this Barista matches the dispatch"
	}
	if resident.state != residentReady {
		return "the resident allocation is closed to new dispatch"
	}
	if run.HarnessID != resident.allocation.HarnessID || run.Model != resident.allocation.Model ||
		run.Transport != resident.allocation.Transport || run.Workspace != resident.allocation.Workspace {
		return "the dispatch does not match the resident allocation's approved placement"
	}
	return ""
}

// handleInstanceMessage routes one protocol-v5 instance message. A release runs in its own
// goroutine because a drain waits for active runs to settle, which must not block the connection's
// read loop.
func (client *Client) handleInstanceMessage(ctx context.Context, message protocol.InstanceHubMessage) {
	switch message.Type {
	case "instance.provision":
		client.provisionInstance(message)
	case "instance.release":
		go client.releaseInstance(ctx, message)
	case "dispatch":
		client.dispatchInstance(ctx, message)
	default:
		log.Printf("ignore unknown instance message type %q", message.Type)
	}
}

// provisionRejection reports why Barista cannot host the allocation, or "" when it can. Every
// check runs before any resident state is mutated and none of them starts a provider process or
// sends a prompt: instance.ready proves the allocation and local prerequisites only.
func (client *Client) provisionRejection(allocation protocol.InstanceAllocation) string {
	if allocation.NodeID != client.node.ID {
		return "the allocation names a different compute node"
	}
	if client.runner == nil {
		return "no harness inventory is available on this Barista"
	}
	if err := client.runner.AdmitModel(allocation.HarnessID, allocation.Model); err != nil {
		return err.Error()
	}
	if err := client.runner.Admit(allocation.HarnessID, allocation.Transport, ""); err != nil {
		return fmt.Sprintf("transport %s is not available for harness %s on this Barista", allocation.Transport, allocation.HarnessID)
	}
	if _, err := harness.AuthorizeWorkspace(allocation.Workspace, client.config.WorkspaceRoots); err != nil {
		return err.Error()
	}
	return ""
}

func (client *Client) provisionInstance(message protocol.InstanceHubMessage) {
	instance, allocation := *message.Instance, *message.Allocation
	if reason := client.provisionRejection(allocation); reason != "" {
		client.reportInstanceFailure(allocation.ID, instance.ID, reason)
		return
	}
	client.residents.mu.Lock()
	if existing, hosted := client.residents.residentsTable[allocation.ID]; hosted {
		exactReplay := existing.matches(instance, allocation)
		state := existing.state
		if exactReplay {
			// An exact replay may carry refreshed hub-side bookkeeping — a renewed lease, new status
			// or timestamps — which the hosted records adopt without touching identity or placement.
			existing.instance, existing.allocation = instance, allocation
		}
		client.residents.mu.Unlock()
		if !exactReplay {
			client.reportInstanceFailure(allocation.ID, instance.ID, "a different resident is already hosted for this allocation")
			return
		}
		switch state {
		case residentReady:
			client.reportInstanceReady(allocation.ID, instance.ID)
		case residentDraining:
			client.reportInstanceFailure(allocation.ID, instance.ID, "the resident for this allocation is draining a release and is closed to new dispatch")
		case residentCleanupFailed:
			client.reportInstanceFailure(allocation.ID, instance.ID, "the resident for this allocation is held by a failed release cleanup")
		default:
			// A state added later must fail closed rather than fall through as ready: instance.ready
			// advertises capacity the hub may dispatch to, and only a ready resident can accept work.
			client.reportInstanceFailure(allocation.ID, instance.ID, "the resident for this allocation is closed to new dispatch")
		}
		return
	}
	if _, released := client.residents.releasedOutcomes[allocation.ID]; released {
		client.residents.mu.Unlock()
		client.reportInstanceFailure(allocation.ID, instance.ID, "this allocation was already released")
		return
	}
	if client.residents.capacity <= 0 {
		client.residents.mu.Unlock()
		client.reportInstanceFailure(allocation.ID, instance.ID, "instance hosting is disabled on this Barista")
		return
	}
	if len(client.residents.residentsTable) >= client.residents.capacity {
		capacity := client.residents.capacity
		client.residents.mu.Unlock()
		client.reportInstanceFailure(allocation.ID, instance.ID, fmt.Sprintf("Barista resident instance capacity (%d) reached", capacity))
		return
	}
	client.residents.residentsTable[allocation.ID] = &residentInstance{
		instance: instance, allocation: allocation, state: residentReady,
		runs: map[string]struct{}{}, closers: map[string]func() error{},
	}
	client.residents.mu.Unlock()
	client.reportInstanceReady(allocation.ID, instance.ID)
}

// releaseInstance drains or cancels a resident, closes its retained session resources, and only
// then frees the slot. A release whose cleanup fails keeps the resident in a terminal
// cleanup-failed state: capacity is never advertised as free while local resources may still be
// open, and a replay retries the cleanup.
func (client *Client) releaseInstance(ctx context.Context, message protocol.InstanceHubMessage) {
	client.residents.mu.Lock()
	resident, hosted := client.residents.residentsTable[message.AllocationID]
	if !hosted {
		_, released := client.residents.releasedOutcomes[message.AllocationID]
		if !released {
			client.residents.recordReleasedLocked(message.AllocationID)
		}
		client.residents.mu.Unlock()
		client.reportInstanceReleased(message.AllocationID, message.InstanceID)
		return
	}
	if resident.instance.ID != message.InstanceID {
		residentInstanceID := resident.instance.ID
		client.residents.mu.Unlock()
		client.reportInstanceFailure(message.AllocationID, residentInstanceID, "the release names a different instance than the resident allocation hosts")
		return
	}
	if resident.state == residentDraining {
		client.residents.mu.Unlock()
		log.Printf("ignore duplicate release while allocation %s is draining", message.AllocationID)
		return
	}
	resident.state = residentDraining
	runIDs := make([]string, 0, len(resident.runs))
	for runID := range resident.runs {
		runIDs = append(runIDs, runID)
	}
	if resident.settled == nil {
		resident.settled = make(chan struct{})
	}
	if len(resident.runs) == 0 {
		resident.closeSettledLocked()
	}
	// Cancel decisions and cancel functions are gathered under runsMu (always nested inside the
	// resident lock, never the reverse) but invoked only after both locks are released. A drain
	// gathers nothing: it lets its runs settle on their own.
	client.runsMu.Lock()
	var cancels []context.CancelFunc
	if message.Mode == "cancel" {
		for _, runID := range runIDs {
			client.cancelled[runID] = struct{}{}
			if cancel := client.runs[runID]; cancel != nil {
				cancels = append(cancels, cancel)
			}
		}
	}
	client.runsMu.Unlock()
	client.residents.mu.Unlock()

	for _, cancel := range cancels {
		cancel()
	}

	select {
	case <-resident.settled:
	case <-ctx.Done():
		log.Printf("release of allocation %s stopped before its runs settled; the resident stays closed to dispatch and its capacity stays occupied", message.AllocationID)
		return
	}

	client.residents.mu.Lock()
	closers := make([]func() error, 0, len(resident.closers))
	for _, closer := range resident.closers {
		closers = append(closers, closer)
	}
	client.residents.mu.Unlock()
	var cleanupFailure error
	for _, closer := range closers {
		if err := closer(); err != nil {
			cleanupFailure = err
			break
		}
	}
	if cleanupFailure != nil {
		client.residents.mu.Lock()
		resident.state = residentCleanupFailed
		client.residents.mu.Unlock()
		client.reportInstanceFailure(message.AllocationID, message.InstanceID, "release cleanup failed: "+cleanupFailure.Error())
		return
	}
	client.residents.mu.Lock()
	delete(client.residents.residentsTable, message.AllocationID)
	client.residents.recordReleasedLocked(message.AllocationID)
	client.residents.mu.Unlock()
	client.reportInstanceReleased(message.AllocationID, message.InstanceID)
}

// finishResidentRun removes a settled run's membership exactly once and completes a drain whose
// last run just settled.
func (client *Client) finishResidentRun(allocationID, runID string) {
	client.residents.mu.Lock()
	defer client.residents.mu.Unlock()
	resident := client.residents.residentsTable[allocationID]
	if resident == nil {
		return
	}
	delete(resident.runs, runID)
	delete(resident.closers, runID)
	if resident.state == residentDraining && len(resident.runs) == 0 {
		resident.closeSettledLocked()
	}
}

// registerResidentCleanup associates a local session resource with the resident allocation so a
// release closes it. The resource keyed by its run is dropped when that run settles.
func (client *Client) registerResidentCleanup(allocationID, key string, closer func() error) {
	client.residents.mu.Lock()
	defer client.residents.mu.Unlock()
	if resident := client.residents.residentsTable[allocationID]; resident != nil {
		resident.closers[key] = closer
	}
}

// dispatchInstance admits a protocol-v5 dispatch against its resident allocation and reuses the
// run pipeline. The message-level match runs first for a precise rejection; dispatchRun then
// re-checks and registers membership under the resident lock, which is what settles the race with
// a concurrent release.
func (client *Client) dispatchInstance(ctx context.Context, message protocol.InstanceHubMessage) {
	instance, allocation, instanceRun := *message.Instance, *message.Allocation, *message.Run
	client.residents.mu.Lock()
	resident, hosted := client.residents.residentsTable[allocation.ID]
	mismatch := ""
	switch {
	case !hosted:
		mismatch = "no resident allocation on this Barista matches the dispatch"
	case !resident.matches(instance, allocation):
		mismatch = "the dispatch does not match the resident allocation's approved identity or placement"
	default:
		// Accepted work refreshes the lease, so the dispatch's hub-side bookkeeping is adopted the
		// same way an exact provision replay's is.
		resident.instance, resident.allocation = instance, allocation
	}
	client.residents.mu.Unlock()
	if mismatch != "" {
		client.send(protocol.Outbound{Type: "run.failed", RunID: instanceRun.ID, Error: mismatch, At: now()})
		return
	}
	run, agent := instanceDispatchRun(instance, instanceRun)
	execution := &protocol.DispatchExecution{Transport: instanceRun.Transport}
	if instanceRun.FallbackTransport != nil {
		execution.FallbackTransport = *instanceRun.FallbackTransport
	}
	client.dispatchRun(ctx, run, agent, execution, allocation.ID)
}

// instanceDispatchRun projects the v5 run record and its instance onto the run pipeline's run and
// agent. The instance's delegation policy is the agent's, and its purpose instructions become the
// system prompt. A run naming a session binding or a workspace lease is rejected by the dispatch
// guard, because the v5 message carries no binding grant or lease grant to honor.
func instanceDispatchRun(instance protocol.AgentInstance, instanceRun protocol.InstanceRun) (protocol.Run, protocol.Agent) {
	run := protocol.Run{
		ID:        instanceRun.ID,
		ThreadID:  instanceRun.ThreadID,
		HarnessID: instanceRun.HarnessID,
		Model:     instanceRun.Model,
		Workspace: instanceRun.Workspace,
		Prompt:    instanceRun.Prompt,
		Transport: instanceRun.Transport,
	}
	if instanceRun.TaskID != nil {
		run.TaskID = *instanceRun.TaskID
	}
	if instanceRun.Attempt != nil {
		run.Attempt = *instanceRun.Attempt
	}
	if instanceRun.SessionBindingID != nil {
		run.SessionBindingID = *instanceRun.SessionBindingID
	}
	if instanceRun.WorkspaceLeaseID != nil {
		run.WorkspaceLeaseID = *instanceRun.WorkspaceLeaseID
	}
	agent := protocol.Agent{ID: instance.ID, Name: instance.ID, CanDelegate: instance.Delegation.CanDelegate}
	if instance.Purpose != nil && instance.Purpose.Instructions != nil {
		agent.SystemPrompt = *instance.Purpose.Instructions
	}
	return run, agent
}

func (client *Client) reportInstanceReady(allocationID, instanceID string) {
	client.send(protocol.InstanceControlMessage{Type: "instance.ready", NodeID: client.node.ID, InstanceID: instanceID, AllocationID: allocationID, At: now()})
}

func (client *Client) reportInstanceReleased(allocationID, instanceID string) {
	client.send(protocol.InstanceControlMessage{Type: "instance.released", NodeID: client.node.ID, InstanceID: instanceID, AllocationID: allocationID, At: now()})
}

func (client *Client) reportInstanceFailure(allocationID, instanceID, reason string) {
	bounded := boundedInstanceReason(reason)
	client.send(protocol.InstanceControlMessage{Type: "instance.failed", NodeID: client.node.ID, InstanceID: instanceID, AllocationID: allocationID, At: now(), Error: &bounded})
}

// boundedInstanceReason keeps an instance.failed error within the protocol's diagnostic bound on a
// rune boundary, so a workspace path in an authorization error can never make the hub reject the
// whole message.
func boundedInstanceReason(reason string) string {
	const diagnosticBytes = 2 * 1024
	if len(reason) <= diagnosticBytes {
		return reason
	}
	cut := diagnosticBytes
	for cut > 0 && !utf8.RuneStart(reason[cut]) {
		cut--
	}
	return reason[:cut]
}

// activeInstanceCount is the number of residents occupying instance capacity: hosted, draining,
// and cleanup-failed residents all count; a released slot does not.
func (client *Client) activeInstanceCount() int {
	client.residents.mu.Lock()
	defer client.residents.mu.Unlock()
	return len(client.residents.residentsTable)
}

// activeInstanceIDs snapshots the sorted resident instance IDs under the lock; encoding happens
// after it is released.
func (client *Client) activeInstanceIDs() []string {
	client.residents.mu.Lock()
	defer client.residents.mu.Unlock()
	ids := make([]string, 0, len(client.residents.residentsTable))
	for _, resident := range client.residents.residentsTable {
		ids = append(ids, resident.instance.ID)
	}
	sort.Strings(ids)
	return ids
}
