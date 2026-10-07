package codex

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/hostsession"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

const approvalDeliveryTimeout = 15 * time.Minute

func (live *liveSession) deliver(message providerMessage) error {
	select {
	case <-live.stop:
		return errors.New("codex event stream is closed")
	case live.events <- message:
		return nil
	default:
		return errors.New("codex event stream exceeded its bound")
	}
}

func (live *liveSession) runEvents() {
	for {
		select {
		case <-live.stop:
			return
		case message := <-live.events:
			live.mu.Lock()
			activated := live.activated
			aborted := live.aborted
			live.mu.Unlock()
			if activated != nil {
				select {
				case <-activated:
					live.process(message)
					continue
				default:
				}
				select {
				case <-activated:
				case <-aborted:
					live.rejectAbortedRequest(message)
					continue
				case <-live.stop:
					return
				}
			}
			live.process(message)
		}
	}
}

func (live *liveSession) rejectAbortedRequest(message providerMessage) {
	if !message.request {
		return
	}
	response := map[string]any{"decision": "decline"}
	if message.method == "item/permissions/requestApproval" {
		response = map[string]any{"permissions": map[string]any{}, "scope": "turn"}
	}
	go func() { _ = live.client.respond(message.id, response) }()
}

func (live *liveSession) stopEvents() {
	live.stopOnce.Do(func() { close(live.stop) })
}

func (live *liveSession) closeUnexpected() {
	live.mu.Lock()
	if live.uncertain {
		live.mu.Unlock()
		live.stopEvents()
		return
	}
	live.uncertain = true
	live.mu.Unlock()
	live.resolvePendingApprovals("", "cancelled", "")
	live.stopEvents()
	live.scheduleUncertainObservation()
}

func (live *liveSession) scheduleUncertainObservation() {
	live.mu.Lock()
	if !live.uncertain || live.starting || live.observe == nil || live.uncertainObservationScheduled {
		live.mu.Unlock()
		return
	}
	live.uncertainObservationScheduled = true
	observe := live.observe
	thread := live.thread
	turnID := live.turnID
	source := live.source
	activated := live.activated
	aborted := live.aborted
	live.mu.Unlock()
	go func() {
		if activated != nil {
			select {
			case <-activated:
				// Activation wins over a later abort from interrupt/detach cleanup.
			default:
				select {
				case <-activated:
				case <-aborted:
					return
				}
			}
		}
		_ = observe(hostsession.DriverSession{
			ProviderSessionID: thread.ID, Workspace: thread.CWD, Source: source,
			Status: "active-elsewhere", ControlMode: "observe", Operations: append([]string(nil), readOperations...),
			ProviderTurnID: turnID, Summary: providerSummary(thread),
		})
	}()
}

func (live *liveSession) process(message providerMessage) {
	if message.request {
		live.processRequest(message)
		return
	}
	if message.method == "turn/completed" {
		var params struct {
			Turn struct {
				ID     string `json:"id"`
				Status string `json:"status"`
			} `json:"turn"`
		}
		if json.Unmarshal(message.params, &params) != nil || !validProviderID(params.Turn.ID) {
			live.warning("codex-event-invalid")
			return
		}
		live.mu.Lock()
		if params.Turn.ID != live.turnID {
			live.mu.Unlock()
			return
		}
		live.turnID = ""
		observe := live.observe
		thread := live.thread
		live.mu.Unlock()
		live.resolvePendingApprovals(params.Turn.ID, "cancelled", "")
		if observe != nil {
			if params.Turn.Status == "failed" {
				live.warning("codex-turn-failed")
			}
			_ = observe(hostsession.DriverSession{
				ProviderSessionID: thread.ID, Workspace: thread.CWD, Source: live.source,
				Status: "idle", ControlMode: "full", Operations: append([]string(nil), writeOperations...),
				Summary: providerSummary(thread),
			})
		}
		return
	}
	if message.method == "serverRequest/resolved" {
		if !live.processResolvedRequest(message.params) {
			live.warning("codex-event-invalid")
			live.closeUnexpected()
			live.client.Close()
		}
		return
	}
	event, ok := normalizedEvent(message.method, message.params)
	if !ok {
		if ignorableNotification(message.method) {
			return
		}
		if recognizedNotification(message.method) {
			live.warning("codex-event-invalid")
			live.closeUnexpected()
			live.client.Close()
		} else {
			live.warningOnce(message.method)
		}
		return
	}
	if !live.notificationBelongsToCurrentTurn(message.params) {
		return
	}
	live.emitEvent(event)
}

func (live *liveSession) notificationBelongsToCurrentTurn(raw json.RawMessage) bool {
	var scope struct {
		ThreadID string `json:"threadId"`
		TurnID   string `json:"turnId"`
	}
	if json.Unmarshal(raw, &scope) != nil {
		return false
	}
	live.mu.Lock()
	defer live.mu.Unlock()
	if scope.ThreadID != "" && scope.ThreadID != live.thread.ID {
		return false
	}
	if scope.TurnID != "" && scope.TurnID != live.turnID {
		return false
	}
	return true
}

func recognizedNotification(method string) bool {
	switch method {
	case "item/agentMessage/delta", "item/reasoning/summaryTextDelta", "item/commandExecution/outputDelta",
		"turn/diff/updated", "turn/plan/updated", "thread/tokenUsage/updated", "warning", "error",
		"item/started", "item/completed":
		return true
	default:
		return false
	}
}

func ignorableNotification(method string) bool {
	switch method {
	case "turn/started", "thread/status/changed", "thread/started", "thread/archived", "thread/unarchived",
		"item/reasoning/summaryPartAdded", "thread/name/updated":
		return true
	default:
		return false
	}
}

func (live *liveSession) processResolvedRequest(raw json.RawMessage) bool {
	var params struct {
		RequestID json.RawMessage `json:"requestId"`
		ThreadID  string          `json:"threadId"`
	}
	if json.Unmarshal(raw, &params) != nil || !json.Valid(params.RequestID) {
		return false
	}
	live.mu.Lock()
	matchedApprovalID := ""
	for approvalID, approval := range live.approvals {
		if bytes.Equal(approval.id, params.RequestID) {
			matchedApprovalID = approvalID
			break
		}
	}
	if matchedApprovalID == "" {
		live.mu.Unlock()
		return true
	}
	if params.ThreadID != live.thread.ID {
		live.mu.Unlock()
		return false
	}
	delete(live.approvals, matchedApprovalID)
	observe := live.observe
	source := live.source
	live.mu.Unlock()
	live.emitEvent(protocol.HarnessEvent{Type: "permission.resolved", ApprovalID: matchedApprovalID, Status: "cancelled"})
	if observe != nil {
		_ = observe(liveObservationSnapshot(live, source))
	}
	return true
}

func (live *liveSession) resolvePendingApprovals(turnID, status, selectedOptionID string) {
	live.mu.Lock()
	approvalIDs := make([]string, 0, len(live.approvals))
	for approvalID, approval := range live.approvals {
		if turnID == "" || approval.turnID == turnID {
			approvalIDs = append(approvalIDs, approvalID)
			delete(live.approvals, approvalID)
		}
	}
	live.mu.Unlock()
	sort.Strings(approvalIDs)
	for _, approvalID := range approvalIDs {
		live.emitEvent(protocol.HarnessEvent{
			Type: "permission.resolved", ApprovalID: approvalID, Status: status, SelectedOptionID: selectedOptionID,
		})
	}
}

func (live *liveSession) cancelPendingProviderApprovals(turnID string) {
	live.mu.Lock()
	pending := make(map[string]pendingApproval)
	for approvalID, approval := range live.approvals {
		if turnID == "" || approval.turnID == turnID {
			pending[approvalID] = approval
			delete(live.approvals, approvalID)
		}
	}
	live.mu.Unlock()
	approvalIDs := make([]string, 0, len(pending))
	for approvalID := range pending {
		approvalIDs = append(approvalIDs, approvalID)
	}
	sort.Strings(approvalIDs)
	for _, approvalID := range approvalIDs {
		_ = live.client.respond(pending[approvalID].id, map[string]any{"decision": "cancel"})
		_ = live.emitEvent(protocol.HarnessEvent{Type: "permission.resolved", ApprovalID: approvalID, Status: "cancelled"})
	}
}

func (live *liveSession) watchTurnCommit(turnID string) {
	live.mu.Lock()
	activated := live.activated
	aborted := live.aborted
	live.mu.Unlock()
	if activated == nil || aborted == nil {
		return
	}
	go func() {
		select {
		case <-activated:
			return
		case <-aborted:
		case <-live.stop:
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err := live.client.call(ctx, "turn/interrupt", map[string]any{"threadId": live.thread.ID, "turnId": turnID}, &struct{}{})
		cancel()
		live.mu.Lock()
		if live.turnID == turnID {
			live.turnID = ""
		}
		if err != nil {
			live.uncertain = true
		}
		observe := live.observe
		thread := live.thread
		source := live.source
		live.mu.Unlock()
		live.cancelPendingProviderApprovals(turnID)
		if observe == nil {
			return
		}
		if err != nil {
			_ = observe(hostsession.DriverSession{
				ProviderSessionID: thread.ID, Workspace: thread.CWD, Source: source,
				Status: "active-elsewhere", ControlMode: "observe", Operations: append([]string(nil), readOperations...),
				Summary: providerSummary(thread),
			})
			return
		}
		_ = observe(liveObservationSnapshot(live, source))
	}()
}

func liveObservationSnapshot(live *liveSession, source string) hostsession.DriverSession {
	live.mu.Lock()
	defer live.mu.Unlock()
	status := "idle"
	if live.turnID != "" {
		status = "running"
	}
	if len(live.approvals) > 0 {
		status = "awaiting-approval"
	}
	return hostsession.DriverSession{
		ProviderSessionID: live.thread.ID, Workspace: live.thread.CWD, Source: source,
		Status: status, ControlMode: "full", Operations: append([]string(nil), writeOperations...),
		ProviderTurnID: live.turnID, Summary: providerSummary(live.thread),
	}
}

func (live *liveSession) processRequest(message providerMessage) {
	if message.method != "item/commandExecution/requestApproval" && message.method != "item/fileChange/requestApproval" {
		response := map[string]any{"decision": "decline"}
		if message.method == "item/permissions/requestApproval" {
			response = map[string]any{"permissions": map[string]any{}, "scope": "turn"}
		}
		go func() { _ = live.client.respond(message.id, response) }()
		live.warning("codex-request-unsupported")
		return
	}
	var params struct {
		ItemID     string  `json:"itemId"`
		ApprovalID *string `json:"approvalId"`
		ThreadID   string  `json:"threadId"`
		TurnID     string  `json:"turnId"`
		Reason     string  `json:"reason"`
		Command    string  `json:"command"`
		CWD        string  `json:"cwd"`
		GrantRoot  string  `json:"grantRoot"`
	}
	if json.Unmarshal(message.params, &params) != nil || !validProviderID(params.ItemID) || !validProviderID(params.TurnID) {
		go func() { _ = live.client.respond(message.id, map[string]any{"decision": "decline"}) }()
		live.warning("codex-request-invalid")
		return
	}
	approvalID := params.ItemID
	if params.ApprovalID != nil && validProviderID(*params.ApprovalID) {
		approvalID = *params.ApprovalID
	}
	title := "Apply Codex file change"
	details := make([]string, 0, 3)
	if message.method == "item/commandExecution/requestApproval" {
		title = "Run Codex command"
		if params.Command != "" {
			details = append(details, "Command: "+params.Command)
		}
		if params.CWD != "" {
			details = append(details, "Working directory: "+params.CWD)
		}
	} else if params.GrantRoot != "" {
		details = append(details, "Write root: "+params.GrantRoot)
	}
	if params.Reason != "" {
		details = append(details, "Reason: "+params.Reason)
	}
	live.mu.Lock()
	if params.ThreadID != live.thread.ID || params.TurnID != live.turnID {
		live.mu.Unlock()
		go func() { _ = live.client.respond(message.id, map[string]any{"decision": "decline"}) }()
		return
	}
	for _, approval := range live.approvals {
		if bytes.Equal(approval.id, message.id) {
			live.mu.Unlock()
			live.warning("codex-request-id-reused")
			live.closeUnexpected()
			live.client.Close()
			return
		}
	}
	if _, duplicate := live.approvals[approvalID]; duplicate {
		live.mu.Unlock()
		go func() { _ = live.client.respond(message.id, map[string]any{"decision": "decline"}) }()
		live.warning("codex-request-duplicate")
		return
	}
	live.approvals[approvalID] = pendingApproval{id: append(json.RawMessage(nil), message.id...), turnID: params.TurnID}
	observe := live.observe
	thread := live.thread
	live.mu.Unlock()
	if observe != nil {
		if err := observe(hostsession.DriverSession{
			ProviderSessionID: thread.ID, Workspace: thread.CWD, Source: live.source,
			Status: "awaiting-approval", ControlMode: "full", Operations: append([]string(nil), writeOperations...),
			ProviderTurnID: params.TurnID, Summary: providerSummary(thread),
		}); err != nil {
			live.cancelUndeliveredApproval(approvalID, message.id)
			return
		}
	}
	if err := live.emitEvent(protocol.HarnessEvent{
		Type: "permission.requested", ApprovalID: approvalID, ToolCallID: params.ItemID,
		Title: title, Detail: bounded(strings.Join(details, "\n"), 16*1024),
		Options: []protocol.ApprovalOption{
			{ID: "allow-once", Label: "Allow once", Kind: "allow-once"},
			{ID: "allow-always", Label: "Allow for session", Kind: "allow-always"},
			{ID: "reject-once", Label: "Reject", Kind: "reject-once"},
		},
	}); err != nil {
		live.cancelUndeliveredApproval(approvalID, message.id)
		if observe != nil {
			_ = observe(liveObservationSnapshot(live, live.source))
		}
		return
	}
	go live.expireApproval(approvalID, params.TurnID, message.id)
}

func (live *liveSession) cancelUndeliveredApproval(approvalID string, requestID json.RawMessage) {
	live.mu.Lock()
	if pending, found := live.approvals[approvalID]; found && bytes.Equal(pending.id, requestID) {
		delete(live.approvals, approvalID)
	}
	live.mu.Unlock()
	_ = live.client.respond(requestID, map[string]any{"decision": "cancel"})
}

func (live *liveSession) expireApproval(approvalID, turnID string, requestID json.RawMessage) {
	timer := time.NewTimer(approvalDeliveryTimeout)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-live.stop:
		return
	}
	live.mu.Lock()
	pending, found := live.approvals[approvalID]
	if !found || pending.turnID != turnID || !bytes.Equal(pending.id, requestID) {
		live.mu.Unlock()
		return
	}
	delete(live.approvals, approvalID)
	observe := live.observe
	live.mu.Unlock()
	_ = live.client.respond(requestID, map[string]any{"decision": "cancel"})
	_ = live.emitEvent(protocol.HarnessEvent{Type: "permission.resolved", ApprovalID: approvalID, Status: "expired"})
	if observe != nil {
		_ = observe(liveObservationSnapshot(live, live.source))
	}
}

func (live *liveSession) emitEvent(event protocol.HarnessEvent) error {
	live.mu.Lock()
	event.RunID = live.runID
	event.Sequence = live.sequence + 1
	event.At = time.Now().UTC().Format(time.RFC3339Nano)
	emit := live.emit
	if emit == nil {
		live.mu.Unlock()
		return errors.New("codex event sink is unavailable")
	}
	if err := event.Validate(); err != nil {
		live.mu.Unlock()
		return err
	}
	if err := emit(event); err != nil {
		live.mu.Unlock()
		return err
	}
	live.sequence = event.Sequence
	live.mu.Unlock()
	return nil
}

func (live *liveSession) warning(code string) {
	live.emitEvent(protocol.HarnessEvent{Type: "warning", Code: code, Message: "Codex App Server returned an unsupported event shape"})
}

func (live *liveSession) warningOnce(method string) {
	live.mu.Lock()
	if live.warned[method] {
		live.mu.Unlock()
		return
	}
	live.warned[method] = true
	live.mu.Unlock()
	live.warning("codex-event-ignored")
}

func normalizedEvent(method string, raw json.RawMessage) (protocol.HarnessEvent, bool) {
	switch method {
	case "item/agentMessage/delta":
		var value struct {
			Delta string `json:"delta"`
		}
		if json.Unmarshal(raw, &value) != nil {
			return protocol.HarnessEvent{}, false
		}
		return protocol.HarnessEvent{Type: "message.delta", Text: bounded(value.Delta, 16*1024)}, true
	case "item/reasoning/summaryTextDelta":
		var value struct {
			Delta string `json:"delta"`
		}
		if json.Unmarshal(raw, &value) != nil {
			return protocol.HarnessEvent{}, false
		}
		return protocol.HarnessEvent{Type: "thought.delta", Text: bounded(value.Delta, 16*1024)}, true
	case "item/commandExecution/outputDelta":
		var value struct {
			ItemID, Delta string
			Stream        string `json:"stream"`
		}
		if json.Unmarshal(raw, &value) != nil || !validProviderID(value.ItemID) {
			return protocol.HarnessEvent{}, false
		}
		stream := value.Stream
		if stream != "stderr" {
			stream = "stdout"
		}
		return protocol.HarnessEvent{Type: "terminal.output", TerminalID: value.ItemID, Stream: stream, Text: bounded(value.Delta, 16*1024)}, true
	case "turn/diff/updated":
		var value struct{ TurnID, Diff string }
		if json.Unmarshal(raw, &value) != nil {
			return protocol.HarnessEvent{}, false
		}
		return protocol.HarnessEvent{Type: "diff", Path: "", NewText: bounded(value.Diff, 64*1024)}, true
	case "turn/plan/updated":
		var value struct {
			Plan []struct{ Step, Status string } `json:"plan"`
		}
		if json.Unmarshal(raw, &value) != nil {
			return protocol.HarnessEvent{}, false
		}
		entries := make([]protocol.PlanEntry, 0, min(len(value.Plan), 64))
		for _, entry := range value.Plan[:min(len(value.Plan), 64)] {
			status := strings.ReplaceAll(entry.Status, "inProgress", "in-progress")
			entries = append(entries, protocol.PlanEntry{Content: bounded(entry.Step, 16*1024), Status: status, Priority: "medium"})
		}
		return protocol.HarnessEvent{Type: "plan.updated", Entries: entries}, true
	case "thread/tokenUsage/updated":
		var value struct {
			TokenUsage struct {
				Total struct{ InputTokens, OutputTokens, CachedInputTokens int64 } `json:"total"`
			} `json:"tokenUsage"`
		}
		if json.Unmarshal(raw, &value) != nil {
			return protocol.HarnessEvent{}, false
		}
		return protocol.HarnessEvent{Type: "usage", InputTokens: &value.TokenUsage.Total.InputTokens, OutputTokens: &value.TokenUsage.Total.OutputTokens, CachedInputTokens: &value.TokenUsage.Total.CachedInputTokens}, true
	case "warning", "error":
		return protocol.HarnessEvent{Type: "warning", Code: "codex-provider-warning", Message: "Codex reported a bounded provider warning"}, true
	case "item/started", "item/completed":
		var value struct {
			Item struct {
				ID, Type, Status string
				Text             string `json:"text"`
			} `json:"item"`
		}
		if json.Unmarshal(raw, &value) != nil || !validProviderID(value.Item.ID) {
			return protocol.HarnessEvent{}, false
		}
		kind := "other"
		if value.Item.Type == "commandExecution" {
			kind = "execute"
		}
		if value.Item.Type == "fileChange" {
			kind = "edit"
		}
		status := "in-progress"
		if method == "item/completed" {
			status = "completed"
		}
		if value.Item.Status == "failed" {
			status = "failed"
		}
		title := value.Item.Type
		if title == "" {
			title = "Codex item"
		}
		return protocol.HarnessEvent{Type: "tool.call", ToolCallID: value.Item.ID, Status: status, Kind: kind, Title: bounded(title, 1024), Detail: ""}, true
	case "turn/started", "thread/status/changed", "thread/started", "serverRequest/resolved":
		return protocol.HarnessEvent{}, false
	default:
		return protocol.HarnessEvent{}, false
	}
}
