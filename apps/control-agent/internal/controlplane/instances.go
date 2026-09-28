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

// provisionReplayOutcomeLocked answers a provision for an allocation this Barista has already
// settled — hosted, draining, held by a failed cleanup, or released — from its recorded outcome
// without re-adjudicating local prerequisites, and reports settled. An exact replay may carry
// refreshed hub-side bookkeeping — a renewed lease, new status or timestamps — which the hosted
// records adopt without touching identity or placement; a conflicting replay is refused without
// replacing the resident. settled is false only when the allocation is unknown here and the caller
// must validate prerequisites and admit it. The caller must hold the resident lock and send any
// message only after releasing it.
func (supervisor *residentSupervisor) provisionReplayOutcomeLocked(instance protocol.AgentInstance, allocation protocol.InstanceAllocation) (failure string, settled bool) {
	existing, hosted := supervisor.residentsTable[allocation.ID]
	if !hosted {
		if _, released := supervisor.releasedOutcomes[allocation.ID]; released {
			return "this allocation was already released", true
		}
		return "", false
	}
	if !existing.matches(instance, allocation) {
		return "a different resident is already hosted for this allocation", true
	}
	existing.instance, existing.allocation = instance, allocation
	switch existing.state {
	case residentReady:
		return "", true
	case residentDraining:
		return "the resident for this allocation is draining a release and is closed to new dispatch", true
	case residentCleanupFailed:
		return "the resident for this allocation is held by a failed release cleanup", true
	default:
		// A state added later must fail closed rather than fall through as ready: instance.ready
		// advertises capacity the hub may dispatch to, and only a ready resident can accept work.
		return "the resident for this allocation is closed to new dispatch", true
	}
}

// duplicateResidentRejectionLocked reports why the instance cannot be hosted under a second
// concurrent allocation, or "" when it may. An instance is hosted by one allocation at a time — the
// same invariant the hub's load validation states — so refusing here keeps the heartbeat identity
// list unique by construction and an accurate occupancy count, where deduplicating it would
// under-count the occupied slots instead. The replay lookup has already settled the allocation
// itself, so any match here names a different, concurrently resident allocation. The caller must
// hold the resident lock.
func (supervisor *residentSupervisor) duplicateResidentRejectionLocked(instanceID string) string {
	hosting, hostingAllocationID, ambiguous := supervisor.residentByInstanceIDLocked(instanceID)
	switch {
	case ambiguous:
		return "the instance is hosted by multiple resident allocations on this Barista"
	case hosting == nil:
		return ""
	default:
		return fmt.Sprintf("instance %s is already hosted by allocation %s on this Barista", instanceID, hostingAllocationID)
	}
}

// reportProvisionOutcome reports a settled provision outcome; an empty failure is acknowledged
// ready.
func (client *Client) reportProvisionOutcome(allocationID, instanceID, failure string) {
	if failure == "" {
		client.reportInstanceReady(allocationID, instanceID)
		return
	}
	client.reportInstanceFailure(allocationID, instanceID, failure)
}

func (client *Client) provisionInstance(message protocol.InstanceHubMessage) {
	instance, allocation := *message.Instance, *message.Allocation
	// Identity resolution comes before prerequisite validation: an allocation this Barista already
	// settled is answered from its recorded admission, so an exact replay stays harmless even when a
	// local prerequisite drifted after admission — re-adjudicating it would report instance.failed
	// for a lifecycle whose ready resident still occupies its slot. This order is safe only because
	// dispatch re-authorizes the workspace before granting MCP or starting the provider (dispatchRun
	// in client.go), so answering a replay from its recorded outcome cannot bypass WORKSPACE_ROOTS.
	client.residents.mu.Lock()
	failure, settled := client.residents.provisionReplayOutcomeLocked(instance, allocation)
	client.residents.mu.Unlock()
	if settled {
		client.reportProvisionOutcome(allocation.ID, instance.ID, failure)
		return
	}
	// Prerequisite validation runs outside the resident lock because a transport admission may
	// re-verify an adapter executable's digest on the filesystem.
	if reason := client.provisionRejection(allocation); reason != "" {
		client.reportInstanceFailure(allocation.ID, instance.ID, reason)
		return
	}
	client.residents.mu.Lock()
	// A concurrent provision of the same allocation may have been admitted while the lock was
	// released for validation; it is answered as the replay it has now become.
	failure, settled = client.residents.provisionReplayOutcomeLocked(instance, allocation)
	if settled {
		client.residents.mu.Unlock()
		client.reportProvisionOutcome(allocation.ID, instance.ID, failure)
		return
	}
	if client.residents.capacity <= 0 {
		client.residents.mu.Unlock()
		client.reportInstanceFailure(allocation.ID, instance.ID, "instance hosting is disabled on this Barista")
		return
	}
	if reason := client.residents.duplicateResidentRejectionLocked(instance.ID); reason != "" {
		client.residents.mu.Unlock()
		client.reportInstanceFailure(allocation.ID, instance.ID, reason)
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
	resident := client.residents.residentsTable[message.AllocationID]
	allocationID := message.AllocationID
	if resident == nil {
		// A hub that does not own a resident's allocation knows only its instance ID — the identity
		// sync.complete reports — so its release substitutes the instance ID for the allocation ID.
		// The resident is matched by instance ID before the allocation is answered already-released,
		// and the release proceeds under the resident's real allocation key so the table, the slot,
		// and the acknowledgement all stay consistent.
		matched, matchedAllocationID, ambiguous := client.residents.residentByInstanceIDLocked(message.InstanceID)
		switch {
		case ambiguous:
			instanceID := message.InstanceID
			client.residents.mu.Unlock()
			client.reportInstanceFailure(message.AllocationID, instanceID, "the release names an instance hosted by multiple resident allocations")
			return
		case matched != nil:
			resident, allocationID = matched, matchedAllocationID
		default:
			_, released := client.residents.releasedOutcomes[message.AllocationID]
			if !released {
				client.residents.recordReleasedLocked(message.AllocationID)
			}
			client.residents.mu.Unlock()
			client.reportInstanceReleased(message.AllocationID, message.InstanceID)
			return
		}
	}
	if resident.instance.ID != message.InstanceID {
		residentInstanceID := resident.instance.ID
		client.residents.mu.Unlock()
		client.reportInstanceFailure(message.AllocationID, residentInstanceID, "the release names a different instance than the resident allocation hosts")
		return
	}
	if resident.state == residentDraining {
		if message.Mode != "cancel" {
			client.residents.mu.Unlock()
			log.Printf("ignore duplicate release while allocation %s is draining", allocationID)
			return
		}
		// A delivered drain escalates monotonically to a cancel: the runs the waiting drain is
		// letting settle on their own are terminated now, instead of the release waiting them out
		// indefinitely. The waiting release stays the sole owner of the outcome — this path never
		// changes the resident's state, deletes it, frees its slot, or reports — so both releases
		// converge on exactly one instance.released.
		runIDs := make([]string, 0, len(resident.runs))
		for runID := range resident.runs {
			runIDs = append(runIDs, runID)
		}
		cancels := client.markResidentRunsCancelled(runIDs)
		client.residents.mu.Unlock()
		for _, cancel := range cancels {
			cancel()
		}
		log.Printf("escalated the draining allocation %s to cancel its active runs", allocationID)
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
	var cancels []context.CancelFunc
	if message.Mode == "cancel" {
		cancels = client.markResidentRunsCancelled(runIDs)
	}
	client.residents.mu.Unlock()

	for _, cancel := range cancels {
		cancel()
	}

	select {
	case <-resident.settled:
	case <-ctx.Done():
		log.Printf("release of allocation %s stopped before its runs settled; the resident stays closed to dispatch and its capacity stays occupied", allocationID)
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
		client.reportInstanceFailure(allocationID, message.InstanceID, "release cleanup failed: "+cleanupFailure.Error())
		return
	}
	client.residents.mu.Lock()
	delete(client.residents.residentsTable, allocationID)
	client.residents.recordReleasedLocked(allocationID)
	client.residents.mu.Unlock()
	client.reportInstanceReleased(allocationID, message.InstanceID)
}

// residentByInstanceIDLocked resolves the single resident hosting instanceID. Admission refuses a
// provision that would host an instance under a second concurrent allocation, so at most one
// resident matches by construction; the ambiguity branch below is defense in depth for a table that
// structurally permits what admission refuses, so it keeps refusing rather than guessing. The
// caller must hold the resident lock.
func (supervisor *residentSupervisor) residentByInstanceIDLocked(instanceID string) (resident *residentInstance, allocationID string, ambiguous bool) {
	var match *residentInstance
	var matchAllocationID string
	for key, candidate := range supervisor.residentsTable {
		if candidate.instance.ID != instanceID {
			continue
		}
		if match != nil {
			return nil, "", true
		}
		match, matchAllocationID = candidate, key
	}
	return match, matchAllocationID, false
}

// markResidentRunsCancelled tombstones the given runs and collects their cancel functions without
// invoking them. The caller must hold the resident lock; runsMu is acquired and released inside
// (always after the resident lock, never the reverse), and the returned functions must be invoked
// only after the resident lock is released, because cancelling a run stops a harness process.
func (client *Client) markResidentRunsCancelled(runIDs []string) []context.CancelFunc {
	client.runsMu.Lock()
	defer client.runsMu.Unlock()
	cancels := make([]context.CancelFunc, 0, len(runIDs))
	for _, runID := range runIDs {
		client.cancelled[runID] = struct{}{}
		if cancel := client.runs[runID]; cancel != nil {
			cancels = append(cancels, cancel)
		}
	}
	return cancels
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
	execution.SessionBinding = message.SessionBinding
	if instanceRun.FallbackTransport != nil {
		execution.FallbackTransport = *instanceRun.FallbackTransport
	}
	client.dispatchRun(ctx, run, agent, execution, allocation.ID)
}

// instanceDispatchRun projects the v5 run record and its instance onto the run pipeline's run and
// agent. The instance's delegation policy is the agent's, and its purpose instructions become the
// system prompt. A workspace lease remains unsupported because the v5 message carries no lease
// grant; a session binding is honored only when the closed message carries its matching grant.
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
// after it is released. Admission hosts an instance under at most one concurrent allocation, so the
// identities are unique by construction and the list length is the occupied-slot count — accurate
// occupancy evidence, never deduplicated, which would under-count the occupied slots instead.
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
