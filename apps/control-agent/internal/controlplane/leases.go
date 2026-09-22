package controlplane

import (
	"context"
	"errors"
	"log"
	"slices"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/workspace"
)

// leaseReporter reports a lease's local outcomes to the hub. It walks the canonical transition
// table from the status the hub last granted, so every report is one transition the hub accepts
// and a final outcome never skips the steps that lead to it.
type leaseReporter struct {
	client *Client
	runID  string
	grant  protocol.WorkspaceLeaseGrant
	status string
}

func (reporter *leaseReporter) advance(outcome workspace.Outcome) {
	path := protocol.WorkspaceLeasePath(reporter.status, outcome.Status)
	for index, step := range path {
		update := protocol.WorkspaceLeaseUpdate{LeaseID: reporter.grant.ID, Status: step}
		if index == len(path)-1 {
			update = outcome.Update(reporter.grant.ID)
		}
		message := protocol.NewWorkspaceLeaseMessage(reporter.runID, update, now())
		if err := message.Validate(); err != nil {
			log.Printf("drop invalid workspace.lease report for run %s", reporter.runID)
			return
		}
		reporter.client.send(message)
		reporter.status = step
	}
}

// reassert re-sends an outcome the hub already recorded, so a replayed dispatch of an active lease
// still asks the hub to confirm it.
func (reporter *leaseReporter) reassert(outcome workspace.Outcome) {
	if reporter.status != outcome.Status {
		reporter.advance(outcome)
		return
	}
	message := protocol.NewWorkspaceLeaseMessage(reporter.runID, outcome.Update(reporter.grant.ID), now())
	if message.Validate() == nil {
		reporter.client.send(message)
	}
}

// defaultLeaseConfirmationTimeout bounds the wait for the hub to persist an active lease.
const defaultLeaseConfirmationTimeout = time.Minute

type leaseConfirmation struct {
	runID     string
	confirmed chan struct{}
	once      bool
}

// expectConfirmation registers interest in the hub's confirmation of one lease for one run before
// the active report is sent, so a fast confirmation is never missed.
func (client *Client) expectConfirmation(leaseID, runID string) (<-chan struct{}, func()) {
	confirmation := &leaseConfirmation{runID: runID, confirmed: make(chan struct{})}
	client.confirmationsMu.Lock()
	if client.confirmations == nil {
		client.confirmations = map[string]*leaseConfirmation{}
	}
	client.confirmations[leaseID] = confirmation
	client.confirmationsMu.Unlock()
	return confirmation.confirmed, func() {
		client.confirmationsMu.Lock()
		if client.confirmations[leaseID] == confirmation {
			delete(client.confirmations, leaseID)
		}
		client.confirmationsMu.Unlock()
	}
}

// confirmLease accepts the hub's confirmation only for the exact run and lease that is waiting,
// and only for the active status; anything else is ignored.
func (client *Client) confirmLease(runID, leaseID, status string) {
	if status != "active" {
		return
	}
	client.confirmationsMu.Lock()
	defer client.confirmationsMu.Unlock()
	confirmation := client.confirmations[leaseID]
	if confirmation == nil || confirmation.runID != runID || confirmation.once {
		return
	}
	confirmation.once = true
	close(confirmation.confirmed)
}

func (client *Client) confirmationTimeout() time.Duration {
	if client.leaseConfirmationTimeout > 0 {
		return client.leaseConfirmationTimeout
	}
	return defaultLeaseConfirmationTimeout
}

// current is the grant as the hub now knows it, for cleanup decisions that depend on status.
func (reporter *leaseReporter) current() protocol.WorkspaceLeaseGrant {
	grant := reporter.grant
	grant.Status = reporter.status
	return grant
}

// provisionLease provisions the dispatch's lease before any harness process exists. Provisioning
// runs to completion even if the run is cancelled meanwhile, because interrupting a Git mutation
// is what leaves ambiguous state; a cancelled run then settles the lease immediately. The harness
// may start only after the hub confirms it persisted the exact lease as active for this run: a
// report that was merely sent or queued proves nothing, so a missing confirmation fails the run
// and settles the lease locally instead. It returns the verified cwd and the function that
// settles the lease after the harness exits, or ok=false when the run must not start.
func (client *Client) provisionLease(runContext context.Context, run protocol.Run, execution protocol.DispatchExecution) (string, func(), bool) {
	grant := *execution.WorkspaceLease
	release, err := client.workspaces.Own(grant)
	if err != nil {
		reason := "workspace lease ownership could not be established"
		if errors.Is(err, workspace.ErrLeaseOwned) {
			reason = "workspace lease is already in use by another Barista operation"
		}
		client.send(protocol.Outbound{Type: "run.failed", RunID: run.ID, Error: reason, At: now()})
		return "", nil, false
	}
	reporter := &leaseReporter{client: client, runID: run.ID, grant: grant, status: grant.Status}
	operationContext := context.WithoutCancel(runContext)
	confirmed, stopWaiting := client.expectConfirmation(grant.ID, run.ID)
	defer stopWaiting()
	reporter.advance(workspace.Outcome{Status: "provisioning"})
	outcome := client.workspaces.Provision(operationContext, grant, execution.TaskID, run.ID)
	if outcome.Status == "active" {
		reporter.reassert(outcome)
	} else {
		reporter.advance(outcome)
	}
	finish := func() {
		defer release()
		if reporter.status != "active" && reporter.status != "provisioning" {
			return
		}
		reporter.advance(workspace.Outcome{Status: "released"})
		settled := client.workspaces.Cleanup(operationContext, reporter.current(), run.ID, workspace.ModeRun, func() {
			reporter.advance(workspace.Outcome{Status: "cleaning"})
		})
		reporter.advance(settled)
	}
	if outcome.Status != "active" {
		release()
		if runContext.Err() == nil {
			client.send(protocol.Outbound{Type: "run.failed", RunID: run.ID, Error: "workspace lease could not be provisioned: " + outcome.Detail, At: now()})
		}
		return "", nil, false
	}
	timer := time.NewTimer(client.confirmationTimeout())
	defer timer.Stop()
	select {
	case <-confirmed:
	case <-runContext.Done():
		finish()
		return "", nil, false
	case <-timer.C:
		client.send(protocol.Outbound{Type: "run.failed", RunID: run.ID, Error: "workspace lease was not confirmed by the hub", At: now()})
		finish()
		return "", nil, false
	}
	if runContext.Err() != nil {
		finish()
		return "", nil, false
	}
	return outcome.Path, finish, true
}

// cleanupLease answers a hub workspace.cleanup request for a lease no live run owns. A lease held
// by a live operation — in this process or, through its lock file, in another Barista process —
// is left untouched and unreported, so it stays active until its owner settles it.
func (client *Client) cleanupLease(ctx context.Context, runID string, grant *protocol.WorkspaceLeaseGrant, mode string) {
	if grant == nil || !slices.Contains(protocol.WorkspaceCleanupModes, mode) || grant.Validate() != nil {
		log.Printf("ignore malformed workspace.cleanup request for run %s", runID)
		return
	}
	release, err := client.workspaces.Own(*grant)
	if err != nil {
		return
	}
	defer release()
	reporter := &leaseReporter{client: client, runID: runID, grant: *grant, status: grant.Status}
	if mode == workspace.ModeOperator {
		if grant.Status != "retained" {
			return
		}
		reporter.advance(workspace.Outcome{Status: "cleaning"})
	}
	outcome := client.workspaces.Cleanup(context.WithoutCancel(ctx), reporter.current(), runID, mode, func() {
		reporter.advance(workspace.Outcome{Status: "cleaning"})
	})
	reporter.advance(outcome)
}
