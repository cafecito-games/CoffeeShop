package acp

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

// ErrMalformedUpdate reports a known session update variant whose required fields are invalid.
var ErrMalformedUpdate = errors.New("malformed acp session update")

// Warning codes carried by normalized warning events.
const (
	WarningInvalidItemsSkipped  = "acp-invalid-items-skipped"
	WarningDiffTooLarge         = "acp-diff-too-large"
	WarningContentTruncated     = "acp-content-truncated"
	WarningUpdateAfterComplete  = "acp-update-after-completion"
	WarningPermissionMalformed  = "acp-permission-malformed"
	WarningSessionCloseFailed   = "acp-session-close-failed"
	WarningSessionNotResumed    = "acp-session-not-resumed"
	WarningEventInvalid         = "acp-event-invalid"
	warningPlanEntriesTruncated = "acp-plan-truncated"
)

var toolCallStatuses = map[string]string{
	"pending":     "pending",
	"in_progress": "in-progress",
	"completed":   "completed",
	"failed":      "failed",
}

var planEntryStatuses = map[string]string{
	"pending":     "pending",
	"in_progress": "in-progress",
	"completed":   "completed",
}

var planEntryPriorities = map[string]bool{"high": true, "medium": true, "low": true}

var toolCallKinds = map[string]string{
	"read": "read", "edit": "edit", "delete": "delete", "move": "move", "search": "search",
	"execute": "execute", "think": "think", "fetch": "fetch", "switch_mode": "other", "other": "other",
}

type toolCallState struct {
	title  string
	kind   string
	status string
}

// normalizer translates ACP session updates into Coffee Shop harness events. Run identity,
// sequence, and timestamps are assigned by the emitter.
type normalizer struct {
	toolCalls  map[string]*toolCallState
	result     strings.Builder
	resultFull bool
}

func newNormalizer() *normalizer {
	return &normalizer{toolCalls: map[string]*toolCallState{}}
}

// finalText returns the accumulated agent message for the prompt turn.
func (normalization *normalizer) finalText() string {
	return normalization.result.String()
}

func (normalization *normalizer) sessionUpdate(raw json.RawMessage) ([]protocol.HarnessEvent, error) {
	var kind sessionUpdateKind
	if err := decodeStrict(raw, &kind); err != nil || kind.SessionUpdate == "" {
		return nil, fmt.Errorf("%w: update has no sessionUpdate discriminator", ErrMalformedUpdate)
	}
	switch kind.SessionUpdate {
	case "agent_message_chunk":
		return normalization.chunk(kind.SessionUpdate, "message.delta", raw)
	case "agent_thought_chunk":
		return normalization.chunk(kind.SessionUpdate, "thought.delta", raw)
	case "plan":
		return normalization.plan(raw)
	case "tool_call":
		return normalization.toolCall(raw, true)
	case "tool_call_update":
		return normalization.toolCall(raw, false)
	case "usage_update":
		return normalization.usage(raw)
	case "user_message_chunk", "available_commands_update", "current_mode_update", "config_option_update", "session_info_update":
		return nil, nil
	default:
		return []protocol.HarnessEvent{unknownEvent(kind.SessionUpdate, "unsupported ACP session update")}, nil
	}
}

func (normalization *normalizer) chunk(sourceType, eventType string, raw json.RawMessage) ([]protocol.HarnessEvent, error) {
	var chunk contentChunk
	if err := decodeStrict(raw, &chunk); err != nil || chunk.Content == nil {
		return nil, fmt.Errorf("%w: %s has no content", ErrMalformedUpdate, sourceType)
	}
	var content receivedContent
	if err := decodeStrict(chunk.Content, &content); err != nil || content.Type == "" {
		return nil, fmt.Errorf("%w: %s content is malformed", ErrMalformedUpdate, sourceType)
	}
	if content.Type != "text" {
		return []protocol.HarnessEvent{unknownEvent(sourceType+"/"+content.Type, "non-text content is not rendered")}, nil
	}
	if content.Text == nil {
		return nil, fmt.Errorf("%w: %s text content has no text", ErrMalformedUpdate, sourceType)
	}
	if eventType == "message.delta" {
		normalization.appendResult(*content.Text)
	}
	events := []protocol.HarnessEvent{}
	for _, part := range splitBytes(*content.Text, eventTextBytes) {
		if part != "" {
			events = append(events, protocol.HarnessEvent{Type: eventType, Text: part})
		}
	}
	return events, nil
}

func (normalization *normalizer) appendResult(text string) {
	if normalization.resultFull {
		return
	}
	remaining := MaximumResultBytes - normalization.result.Len()
	if len(text) > remaining {
		text = truncateBytes(text, remaining)
		normalization.resultFull = true
	}
	normalization.result.WriteString(text)
}

func (normalization *normalizer) plan(raw json.RawMessage) ([]protocol.HarnessEvent, error) {
	var update planUpdate
	if err := decodeStrict(raw, &update); err != nil || update.Entries == nil {
		return nil, fmt.Errorf("%w: plan has no entries", ErrMalformedUpdate)
	}
	entries := make([]protocol.PlanEntry, 0, min(len(update.Entries), eventPlanEntryLimit))
	skipped := 0
	for _, entry := range update.Entries {
		status, knownStatus := planEntryStatuses[entry.Status]
		if entry.Content == nil || !knownStatus || !planEntryPriorities[entry.Priority] {
			skipped++
			continue
		}
		entries = append(entries, protocol.PlanEntry{Content: truncateBytes(*entry.Content, eventTextBytes), Status: status, Priority: entry.Priority})
	}
	events := []protocol.HarnessEvent{}
	if len(entries) > eventPlanEntryLimit {
		events = append(events, warningEvent(warningPlanEntriesTruncated, fmt.Sprintf("plan truncated from %d to %d entries", len(entries), eventPlanEntryLimit)))
		entries = entries[:eventPlanEntryLimit]
	}
	if skipped > 0 {
		events = append(events, warningEvent(WarningInvalidItemsSkipped, fmt.Sprintf("skipped %d invalid plan entries", skipped)))
	}
	return append(events, protocol.HarnessEvent{Type: "plan.updated", Entries: entries}), nil
}

func (normalization *normalizer) toolCall(raw json.RawMessage, created bool) ([]protocol.HarnessEvent, error) {
	var fields toolCallFields
	if err := decodeStrict(raw, &fields); err != nil {
		return nil, fmt.Errorf("%w: tool call is malformed", ErrMalformedUpdate)
	}
	if fields.ToolCallID == "" || len(fields.ToolCallID) > eventIdentifierBytes {
		return nil, fmt.Errorf("%w: tool call identifier is missing or too long", ErrMalformedUpdate)
	}
	if created && fields.Title == nil {
		return nil, fmt.Errorf("%w: tool_call has no title", ErrMalformedUpdate)
	}
	state, err := normalization.toolCallState(fields.ToolCallID, created)
	if err != nil {
		return nil, err
	}
	if fields.Title != nil {
		state.title = truncateBytes(*fields.Title, eventTitleBytes)
	}
	if fields.Kind != nil {
		kind, known := toolCallKinds[*fields.Kind]
		if !known {
			kind = "other"
		}
		state.kind = kind
	}
	if fields.Status != nil {
		status, known := toolCallStatuses[*fields.Status]
		if !known {
			return nil, fmt.Errorf("%w: tool call status %q is unknown", ErrMalformedUpdate, truncateBytes(*fields.Status, eventIdentifierBytes))
		}
		state.status = status
	}

	events := []protocol.HarnessEvent{}
	details := []string{}
	if fields.Content != nil {
		content := *fields.Content
		if len(content) > MaximumToolContentItems {
			events = append(events, warningEvent(WarningContentTruncated, fmt.Sprintf("tool call content truncated from %d to %d items", len(content), MaximumToolContentItems)))
			content = content[:MaximumToolContentItems]
		}
		skipped := 0
		for _, item := range content {
			switch item.Type {
			case "content":
				var block receivedContent
				if decodeStrict(item.Content, &block) != nil || block.Type == "" {
					skipped++
				} else if block.Type == "text" && block.Text != nil {
					details = append(details, *block.Text)
				} else {
					events = append(events, unknownEvent("tool_call_content/"+block.Type, "non-text tool content is not rendered"))
				}
			case "diff":
				if item.Path == nil || item.NewText == nil {
					skipped++
					continue
				}
				events = append(events, diffEvent(fields.ToolCallID, *item.Path, item.OldText, *item.NewText))
			case "terminal":
				events = append(events, unknownEvent("tool_call_content/terminal", "terminal content requires a client terminal capability Barista does not advertise"))
			default:
				skipped++
			}
		}
		if skipped > 0 {
			events = append(events, warningEvent(WarningInvalidItemsSkipped, fmt.Sprintf("skipped %d invalid tool call content items", skipped)))
		}
	}
	toolEvent := protocol.HarnessEvent{
		Type: "tool.call", ToolCallID: fields.ToolCallID, Status: state.status, Kind: state.kind, Title: state.title,
		Detail: truncateBytes(strings.Join(details, "\n"), eventTextBytes),
	}
	return append([]protocol.HarnessEvent{toolEvent}, events...), nil
}

func (normalization *normalizer) toolCallState(id string, created bool) (*toolCallState, error) {
	state, known := normalization.toolCalls[id]
	if known && !created {
		return state, nil
	}
	if !known && len(normalization.toolCalls) >= MaximumTrackedToolCalls {
		return nil, fmt.Errorf("%w: more than %d tool calls in one session", ErrMalformedUpdate, MaximumTrackedToolCalls)
	}
	state = &toolCallState{kind: "other", status: "pending"}
	normalization.toolCalls[id] = state
	return state, nil
}

func diffEvent(toolCallID, path string, oldText *string, newText string) protocol.HarnessEvent {
	previous := ""
	if oldText != nil {
		previous = *oldText
	}
	if len(path) > eventTextBytes || len(previous) > eventDiffBytes || len(newText) > eventDiffBytes {
		return warningEvent(WarningDiffTooLarge, "diff for "+truncateBytes(path, 512)+" exceeds its size bound and was not forwarded")
	}
	return protocol.HarnessEvent{Type: "diff", ToolCallID: toolCallID, Path: path, OldText: previous, NewText: newText}
}

func (normalization *normalizer) usage(raw json.RawMessage) ([]protocol.HarnessEvent, error) {
	var update usageUpdate
	if err := decodeStrict(raw, &update); err != nil || update.Used == nil || update.Size == nil || *update.Used < 0 || *update.Size < 0 {
		return nil, fmt.Errorf("%w: usage_update requires used and size", ErrMalformedUpdate)
	}
	if update.Cost == nil || update.Cost.Amount == nil || *update.Cost.Amount < 0 || !strings.EqualFold(update.Cost.Currency, "USD") {
		return nil, nil
	}
	cost := *update.Cost.Amount
	return []protocol.HarnessEvent{{Type: "usage", CostUSD: &cost}}, nil
}

// promptUsageEvent converts the optional token totals reported with a prompt response.
func promptUsageEvent(usage *promptUsage) []protocol.HarnessEvent {
	if usage == nil || (usage.InputTokens == nil && usage.OutputTokens == nil && usage.CachedReadTokens == nil) {
		return nil
	}
	for _, count := range []*int64{usage.InputTokens, usage.OutputTokens, usage.CachedReadTokens} {
		if count != nil && *count < 0 {
			return nil
		}
	}
	return []protocol.HarnessEvent{{Type: "usage", InputTokens: usage.InputTokens, OutputTokens: usage.OutputTokens, CachedInputTokens: usage.CachedReadTokens}}
}

func warningEvent(code, message string) protocol.HarnessEvent {
	return protocol.HarnessEvent{Type: "warning", Code: code, Message: truncateBytes(message, MaximumDiagnosticBytes)}
}

func unknownEvent(sourceType, detail string) protocol.HarnessEvent {
	return protocol.HarnessEvent{Type: "unknown", SourceType: truncateBytes(sourceType, eventIdentifierBytes), Detail: truncateBytes(detail, MaximumDiagnosticBytes)}
}
