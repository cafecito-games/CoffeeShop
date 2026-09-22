package controlplane

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

// Bounds on harness events queued while the control plane is unreachable. Lifecycle messages and
// permission events are never dropped; ordinary harness events beyond these bounds are dropped and
// reported by a single warning once forwarding resumes, so the hub never observes a sequence gap.
const (
	outboxEventLimit     = 2048
	outboxEventByteLimit = 8 * 1024 * 1024
	// heldEventLimit bounds events produced before a run started, such as an ACP adapter's session
	// setup notifications. The hub accepts events only for a running run, so they wait for
	// run.started; any beyond this bound are dropped and reported like outbox drops.
	heldEventLimit = 256
)

// WarningEventsDropped reports harness events Barista could not queue for the hub.
const WarningEventsDropped = "barista-events-dropped"

const (
	reasonNoActiveRun       = "no active run on this Barista matches this decision"
	reasonNoLiveRequest     = "no live permission request matches this decision"
	reasonConflictingResult = "a different decision was already applied to this permission request"
	reasonOptionNotOffered  = "the selected option was not offered by this permission request"
	reasonOptionKind        = "the selected option does not match the decision status"
)

// runSession owns the forwarded event sequence and the live permission callbacks of one run. The
// sequence Barista forwards is its own: it starts at 1 and only advances for events actually
// queued for the hub, so dropping an event under backpressure never creates a gap.
type runSession struct {
	client *Client
	runID  string

	mu           sync.Mutex
	closed       bool
	started      bool
	held         []protocol.HarnessEvent
	nextSequence int64
	dropped      int
	approvals    map[string]*liveApproval
	settled      map[string]protocol.ApprovalDecision
}

// liveApproval is a permission request that was forwarded to the hub and still blocks its ACP
// callback. Its decision channel holds at most the single decision that settles it.
type liveApproval struct {
	options  map[string]string
	decision chan protocol.ApprovalDecision
}

func (client *Client) openSession(runID string) *runSession {
	session := &runSession{client: client, runID: runID, approvals: map[string]*liveApproval{}, settled: map[string]protocol.ApprovalDecision{}}
	client.sessionsMu.Lock()
	client.sessions[runID] = session
	client.sessionsMu.Unlock()
	return session
}

func (client *Client) closeSession(session *runSession) {
	client.sessionsMu.Lock()
	if client.sessions[session.runID] == session {
		delete(client.sessions, session.runID)
	}
	client.sessionsMu.Unlock()
	session.mu.Lock()
	session.closed = true
	session.approvals = map[string]*liveApproval{}
	session.mu.Unlock()
}

func (client *Client) session(runID string) *runSession {
	client.sessionsMu.Lock()
	defer client.sessionsMu.Unlock()
	return client.sessions[runID]
}

// start sends run.started with the run's transport selection and then forwards, in order, every
// event held while the run had not started. It only acts once.
func (session *runSession) start(selection protocol.RunTransportSelection) {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed || session.started {
		return
	}
	session.started = true
	message := protocol.Outbound{Type: "run.started", RunID: session.runID, At: now()}
	if err := selection.Validate(); err != nil {
		log.Printf("omit invalid transport selection for run %s: %v", session.runID, err)
	} else {
		message.Transport = &selection
	}
	session.client.send(message)
	held := session.held
	session.held = nil
	for _, event := range held {
		session.forwardLocked(event)
	}
}

// forward sends one normalized event to the hub in the order the driver produced it. Before the
// run has started the event is held for start to forward.
func (session *runSession) forward(event protocol.HarnessEvent) {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed || event.RunID != session.runID {
		return
	}
	if !session.started {
		if len(session.held) >= heldEventLimit {
			session.dropped++
			return
		}
		session.held = append(session.held, event)
		return
	}
	session.forwardLocked(event)
}

func (session *runSession) forwardLocked(event protocol.HarnessEvent) {
	if session.dropped > 0 {
		warning := protocol.HarnessEvent{
			Type: "warning", RunID: session.runID, At: now(), Code: WarningEventsDropped,
			Message: fmt.Sprintf("%d harness events were not forwarded because the control plane was unreachable and the event queue was full", session.dropped),
		}
		if session.enqueue(warning, false) {
			session.dropped = 0
		} else if !isPermissionEvent(event) {
			session.dropped++
			return
		}
	}
	if !session.enqueue(event, isPermissionEvent(event)) {
		session.dropped++
		return
	}
	// Registration happens under the same lock as forwarding, so a decision the hub sends for this
	// request cannot be routed until the request is both queued and registered.
	if event.Type == "permission.requested" {
		options := make(map[string]string, len(event.Options))
		for _, option := range event.Options {
			options[option.ID] = option.Kind
		}
		session.approvals[event.ApprovalID] = &liveApproval{options: options, decision: make(chan protocol.ApprovalDecision, 1)}
	}
}

// enqueue assigns the next forwarded sequence and hands the event to the control connection. The
// sequence is consumed only when the event was written or queued.
func (session *runSession) enqueue(event protocol.HarnessEvent, required bool) bool {
	event.Sequence = session.nextSequence + 1
	if err := event.Validate(); err != nil {
		log.Printf("drop invalid harness event for run %s: %v", session.runID, err)
		return false
	}
	data, err := json.Marshal(protocol.NewHarnessEventMessage(event))
	if err != nil {
		log.Printf("encode harness event for run %s: %v", session.runID, err)
		return false
	}
	if !session.client.sendEvent(data, required) {
		return false
	}
	session.nextSequence = event.Sequence
	return true
}

func isPermissionEvent(event protocol.HarnessEvent) bool {
	return event.Type == "permission.requested" || event.Type == "permission.resolved"
}

// permission blocks an ACP permission callback until the hub delivers a decision for exactly this
// run and approval, or until ctx ends. Only a request that was forwarded to the hub can be decided.
func (session *runSession) permission(ctx context.Context, request acp.PermissionRequest) (acp.PermissionDecision, error) {
	session.mu.Lock()
	live := session.approvals[request.ApprovalID]
	session.mu.Unlock()
	if live == nil || request.RunID != session.runID {
		return acp.PermissionDecision{}, errors.New("permission request was not forwarded to the hub")
	}
	defer func() {
		session.mu.Lock()
		if session.approvals[request.ApprovalID] == live {
			delete(session.approvals, request.ApprovalID)
		}
		session.mu.Unlock()
	}()
	select {
	case decision := <-live.decision:
		if decision.Status == "approved" || decision.Status == "rejected" {
			return acp.PermissionDecision{OptionID: decision.SelectedOptionID}, nil
		}
		return acp.PermissionDecision{}, nil
	case <-ctx.Done():
		return acp.PermissionDecision{}, ctx.Err()
	}
}

// deliver hands a validated decision to the matching live callback. It returns "" when the
// decision was applied or exactly repeats the one already applied, and otherwise the reason it
// was refused.
func (session *runSession) deliver(decision protocol.ApprovalDecision) string {
	session.mu.Lock()
	defer session.mu.Unlock()
	if settled, exists := session.settled[decision.ApprovalID]; exists {
		if settled == decision {
			return ""
		}
		return reasonConflictingResult
	}
	live := session.approvals[decision.ApprovalID]
	if session.closed || live == nil {
		return reasonNoLiveRequest
	}
	if decision.Status == "approved" || decision.Status == "rejected" {
		kind, offered := live.options[decision.SelectedOptionID]
		if !offered {
			return reasonOptionNotOffered
		}
		if (decision.Status == "approved") != strings.HasPrefix(kind, "allow") {
			return reasonOptionKind
		}
	}
	live.decision <- decision
	session.settled[decision.ApprovalID] = decision
	return ""
}

// applyApprovalDecision routes a hub decision to its run. A decision that cannot be applied is
// reported back so the hub never records it as delivered.
func (client *Client) applyApprovalDecision(decision *protocol.ApprovalDecision) {
	if decision == nil {
		log.Printf("ignore approval.decision without a decision")
		return
	}
	if err := decision.Validate(); err != nil {
		if decision.RunID != "" && decision.ApprovalID != "" {
			client.reportUndeliverable(decision.RunID, decision.ApprovalID, "invalid decision: "+err.Error())
		}
		return
	}
	session := client.session(decision.RunID)
	if session == nil {
		client.reportUndeliverable(decision.RunID, decision.ApprovalID, reasonNoActiveRun)
		return
	}
	if reason := session.deliver(*decision); reason != "" {
		client.reportUndeliverable(decision.RunID, decision.ApprovalID, reason)
	}
}

func (client *Client) reportUndeliverable(runID, approvalID, reason string) {
	message := protocol.NewApprovalUndeliverableMessage(runID, approvalID, reason, now())
	if err := message.Validate(); err != nil {
		log.Printf("drop approval.undeliverable for run %s: %v", runID, err)
		return
	}
	client.send(message)
}

// sendEvent writes an encoded harness event or queues it for the next connection. Optional events
// are refused rather than queued once the outbox's event bounds are reached.
func (client *Client) sendEvent(data []byte, required bool) bool {
	client.connectionMu.Lock()
	defer client.connectionMu.Unlock()
	if client.connection != nil {
		writeContext, cancel := context.WithTimeout(context.Background(), writeTimeout)
		err := writeBytes(writeContext, client.connection, data)
		cancel()
		if err == nil {
			return true
		}
		client.connection = nil
	}
	if !required && (client.outboxEvents >= outboxEventLimit || client.outboxEventBytes+len(data) > outboxEventByteLimit) {
		return false
	}
	client.outbox = append(client.outbox, data)
	client.outboxEvents++
	client.outboxEventBytes += len(data)
	return true
}
