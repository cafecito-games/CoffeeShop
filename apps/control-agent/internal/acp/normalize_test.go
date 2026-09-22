package acp

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

func normalizeUpdate(t *testing.T, normalization *normalizer, raw string) []protocol.HarnessEvent {
	t.Helper()
	events, err := normalization.sessionUpdate(json.RawMessage(raw))
	require.NoError(t, err)
	return events
}

func chunkUpdate(text string) string {
	return fmt.Sprintf(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":%q}}`, text)
}

func thoughtUpdate(text string) string {
	return fmt.Sprintf(`{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":%q}}`, text)
}

func toolCallRaw(fields string) string {
	return `{"sessionUpdate":"tool_call","toolCallId":"call-1"` + fields + `}`
}

func TestNormalizeMessageChunkAtTextBoundary(t *testing.T) {
	normalization := newNormalizer()
	text := strings.Repeat("a", eventTextBytes)
	events := normalizeUpdate(t, normalization, chunkUpdate(text))
	require.Len(t, events, 1)
	require.Equal(t, "message.delta", events[0].Type)
	require.Equal(t, text, events[0].Text)

	excess := strings.Repeat("b", eventTextBytes+1)
	events = normalizeUpdate(t, normalization, chunkUpdate(excess))
	require.Len(t, events, 2)
	require.Equal(t, "message.delta", events[0].Type)
	require.Equal(t, "message.delta", events[1].Type)
	require.Equal(t, excess, events[0].Text+events[1].Text)
}

func TestNormalizeFinalTextAccumulation(t *testing.T) {
	normalization := newNormalizer()
	normalizeUpdate(t, normalization, chunkUpdate("Hello, "))
	normalizeUpdate(t, normalization, thoughtUpdate("pondering"))
	normalizeUpdate(t, normalization, chunkUpdate("world"))
	require.Equal(t, "Hello, world", normalization.finalText())
}

func TestNormalizeThoughtChunksAreStreamedButNotAccumulated(t *testing.T) {
	normalization := newNormalizer()
	events := normalizeUpdate(t, normalization, thoughtUpdate("pondering"))
	require.Len(t, events, 1)
	require.Equal(t, "thought.delta", events[0].Type)
	require.Equal(t, "pondering", events[0].Text)
	require.Empty(t, normalization.finalText())
}

func TestNormalizeFinalTextCappedAtMaximumResultBytes(t *testing.T) {
	normalization := newNormalizer()
	normalizeUpdate(t, normalization, chunkUpdate(strings.Repeat("a", MaximumResultBytes+100)))
	require.Len(t, normalization.finalText(), MaximumResultBytes)
	normalizeUpdate(t, normalization, chunkUpdate("tail"))
	require.Len(t, normalization.finalText(), MaximumResultBytes)
}

func TestNormalizeNonTextAndMalformedChunks(t *testing.T) {
	normalization := newNormalizer()
	events := normalizeUpdate(t, normalization, `{"sessionUpdate":"agent_message_chunk","content":{"type":"image","data":"..."}}`)
	require.Len(t, events, 1)
	require.Equal(t, "unknown", events[0].Type)
	require.Equal(t, "agent_message_chunk/image", events[0].SourceType)

	_, err := normalization.sessionUpdate(json.RawMessage(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text"}}`))
	require.ErrorIs(t, err, ErrMalformedUpdate)

	_, err = normalization.sessionUpdate(json.RawMessage(`{"sessionUpdate":"agent_message_chunk"}`))
	require.ErrorIs(t, err, ErrMalformedUpdate)
}

func planUpdateWithEntries(entryCount int, entry string) string {
	entries := make([]string, entryCount)
	for index := range entries {
		entries[index] = entry
	}
	return `{"sessionUpdate":"plan","entries":[` + strings.Join(entries, ",") + `]}`
}

const validPlanEntry = `{"content":"entry","priority":"medium","status":"pending"}`

func TestNormalizePlanAtEntryLimit(t *testing.T) {
	normalization := newNormalizer()
	events := normalizeUpdate(t, normalization, planUpdateWithEntries(eventPlanEntryLimit, validPlanEntry))
	require.Len(t, events, 1)
	require.Equal(t, "plan.updated", events[0].Type)
	require.Len(t, events[0].Entries, eventPlanEntryLimit)
}

func TestNormalizePlanTruncatesBeyondEntryLimit(t *testing.T) {
	normalization := newNormalizer()
	events := normalizeUpdate(t, normalization, planUpdateWithEntries(eventPlanEntryLimit+1, validPlanEntry))
	require.Len(t, events, 2)
	require.Equal(t, "warning", events[0].Type)
	require.Equal(t, warningPlanEntriesTruncated, events[0].Code)
	require.Equal(t, "plan.updated", events[1].Type)
	require.Len(t, events[1].Entries, eventPlanEntryLimit)
}

func TestNormalizePlanSkipsInvalidEntries(t *testing.T) {
	normalization := newNormalizer()
	raw := `{"sessionUpdate":"plan","entries":[` + strings.Join([]string{
		`{"content":"active","priority":"high","status":"in_progress"}`,
		`{"content":"bogus","priority":"medium","status":"paused"}`,
		`{"content":"bogus","priority":"urgent","status":"pending"}`,
		`{"priority":"medium","status":"pending"}`,
	}, ",") + `]}`
	events := normalizeUpdate(t, normalization, raw)
	require.Len(t, events, 2)
	require.Equal(t, "warning", events[0].Type)
	require.Equal(t, WarningInvalidItemsSkipped, events[0].Code)
	require.Equal(t, "plan.updated", events[1].Type)
	require.Len(t, events[1].Entries, 1)
	require.Equal(t, "active", events[1].Entries[0].Content)
	require.Equal(t, "in-progress", events[1].Entries[0].Status)
}

func TestNormalizeToolCallValidation(t *testing.T) {
	cases := []struct {
		name string
		raw  string
	}{
		{name: "tool call without toolCallId", raw: `{"sessionUpdate":"tool_call","title":"t"}`},
		{name: "tool call without title", raw: `{"sessionUpdate":"tool_call","toolCallId":"call-1"}`},
		{name: "update with unknown status", raw: `{"sessionUpdate":"tool_call_update","toolCallId":"call-1","status":"paused"}`},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := newNormalizer().sessionUpdate(json.RawMessage(testCase.raw))
			require.ErrorIs(t, err, ErrMalformedUpdate)
		})
	}
}

func TestNormalizeToolCallKindAndStatusMapping(t *testing.T) {
	cases := []struct {
		name           string
		raw            string
		expectedKind   string
		expectedStatus string
	}{
		{
			name:           "switch_mode maps to other",
			raw:            `{"sessionUpdate":"tool_call","toolCallId":"call-1","title":"T","kind":"switch_mode"}`,
			expectedKind:   "other",
			expectedStatus: "pending",
		},
		{
			name:           "unknown kind maps to other",
			raw:            `{"sessionUpdate":"tool_call","toolCallId":"call-1","title":"T","kind":"frobnicate"}`,
			expectedKind:   "other",
			expectedStatus: "pending",
		},
		{
			name:           "in_progress maps to in-progress",
			raw:            `{"sessionUpdate":"tool_call","toolCallId":"call-1","title":"T","kind":"edit","status":"in_progress"}`,
			expectedKind:   "edit",
			expectedStatus: "in-progress",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			events := normalizeUpdate(t, newNormalizer(), testCase.raw)
			require.Len(t, events, 1)
			require.Equal(t, "tool.call", events[0].Type)
			require.Equal(t, testCase.expectedKind, events[0].Kind)
			require.Equal(t, testCase.expectedStatus, events[0].Status)
		})
	}
}

func TestNormalizeToolCallUpdateMergesState(t *testing.T) {
	normalization := newNormalizer()
	events := normalizeUpdate(t, normalization, toolCallRaw(`,"title":"Original","kind":"edit","status":"in_progress"`))
	require.Len(t, events, 1)
	require.Equal(t, "Original", events[0].Title)
	require.Equal(t, "edit", events[0].Kind)
	require.Equal(t, "in-progress", events[0].Status)

	raw := `{"sessionUpdate":"tool_call_update","toolCallId":"call-1","status":"completed"}`
	events = normalizeUpdate(t, normalization, raw)
	require.Len(t, events, 1)
	require.Equal(t, "tool.call", events[0].Type)
	require.Equal(t, "Original", events[0].Title)
	require.Equal(t, "edit", events[0].Kind)
	require.Equal(t, "completed", events[0].Status)
}

func toolCallWithContentItems(itemCount int) string {
	items := make([]string, itemCount)
	for index := range items {
		items[index] = `{"type":"content","content":{"type":"text","text":"ok"}}`
	}
	return toolCallRaw(`,"title":"T","content":[` + strings.Join(items, ",") + `]`)
}

func countWarnings(events []protocol.HarnessEvent, code string) int {
	total := 0
	for _, event := range events {
		if event.Type == "warning" && event.Code == code {
			total++
		}
	}
	return total
}

func TestNormalizeToolContentAtItemLimit(t *testing.T) {
	normalization := newNormalizer()
	events := normalizeUpdate(t, normalization, toolCallWithContentItems(MaximumToolContentItems))
	require.Equal(t, 0, countWarnings(events, WarningContentTruncated))

	events = normalizeUpdate(t, newNormalizer(), toolCallWithContentItems(MaximumToolContentItems+1))
	require.Equal(t, 1, countWarnings(events, WarningContentTruncated))
}

func TestNormalizeDiffAtSizeBoundary(t *testing.T) {
	newText := strings.Repeat("a", eventDiffBytes)
	raw := fmt.Sprintf(`{"sessionUpdate":"tool_call","toolCallId":"call-1","title":"Edit","content":[{"type":"diff","path":"file.txt","newText":%q}]}`, newText)
	events := normalizeUpdate(t, newNormalizer(), raw)
	require.Len(t, events, 2)
	require.Equal(t, "tool.call", events[0].Type)
	require.Equal(t, "diff", events[1].Type)
	require.Equal(t, "file.txt", events[1].Path)
	require.Len(t, events[1].NewText, eventDiffBytes)

	newText = strings.Repeat("b", eventDiffBytes+1)
	raw = fmt.Sprintf(`{"sessionUpdate":"tool_call","toolCallId":"call-1","title":"Edit","content":[{"type":"diff","path":"file.txt","newText":%q}]}`, newText)
	events = normalizeUpdate(t, newNormalizer(), raw)
	require.Len(t, events, 2)
	require.Equal(t, "tool.call", events[0].Type)
	require.Equal(t, 1, countWarnings(events, WarningDiffTooLarge))
	for _, event := range events {
		require.NotEqual(t, "diff", event.Type)
	}
}

func TestNormalizeTerminalContent(t *testing.T) {
	raw := `{"sessionUpdate":"tool_call","toolCallId":"call-1","title":"T","content":[{"type":"terminal","terminalId":"t1"}]}`
	events := normalizeUpdate(t, newNormalizer(), raw)
	require.Len(t, events, 2)
	require.Equal(t, "tool.call", events[0].Type)
	require.Equal(t, "unknown", events[1].Type)
	require.Equal(t, "tool_call_content/terminal", events[1].SourceType)
}

func TestNormalizeUsageUpdate(t *testing.T) {
	normalization := newNormalizer()
	events := normalizeUpdate(t, normalization, `{"sessionUpdate":"usage_update","used":10,"size":100,"cost":{"amount":1.5,"currency":"USD"}}`)
	require.Len(t, events, 1)
	require.Equal(t, "usage", events[0].Type)
	require.NotNil(t, events[0].CostUSD)
	require.Equal(t, 1.5, *events[0].CostUSD)

	events = normalizeUpdate(t, normalization, `{"sessionUpdate":"usage_update","used":10,"size":100,"cost":{"amount":1.5,"currency":"EUR"}}`)
	require.Empty(t, events)

	_, err := normalization.sessionUpdate(json.RawMessage(`{"sessionUpdate":"usage_update","size":100,"cost":{"amount":1.5,"currency":"USD"}}`))
	require.ErrorIs(t, err, ErrMalformedUpdate)
}

func TestNormalizeUnknownAndIgnorableKinds(t *testing.T) {
	normalization := newNormalizer()
	events := normalizeUpdate(t, normalization, `{"sessionUpdate":"frobnicate"}`)
	require.Len(t, events, 1)
	require.Equal(t, "unknown", events[0].Type)
	require.Equal(t, "frobnicate", events[0].SourceType)

	cases := []struct {
		name string
		raw  string
	}{
		{name: "available commands", raw: `{"sessionUpdate":"available_commands_update","current":[]}`},
		{name: "current mode", raw: `{"sessionUpdate":"current_mode_update","current":"default"}`},
		{name: "user message chunk", raw: `{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hi"}}`},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			events, err := normalization.sessionUpdate(json.RawMessage(testCase.raw))
			require.NoError(t, err)
			require.Empty(t, events)
		})
	}
}

func TestNormalizeMissingDiscriminator(t *testing.T) {
	_, err := newNormalizer().sessionUpdate(json.RawMessage(`{}`))
	require.ErrorIs(t, err, ErrMalformedUpdate)
}

func int64Pointer(value int64) *int64 {
	return &value
}

func TestPromptUsageEvent(t *testing.T) {
	require.Nil(t, promptUsageEvent(nil))

	events := promptUsageEvent(&promptUsage{
		InputTokens:      int64Pointer(10),
		OutputTokens:     int64Pointer(20),
		CachedReadTokens: int64Pointer(30),
	})
	require.Len(t, events, 1)
	require.Equal(t, "usage", events[0].Type)
	require.NotNil(t, events[0].InputTokens)
	require.Equal(t, int64(10), *events[0].InputTokens)
	require.NotNil(t, events[0].OutputTokens)
	require.Equal(t, int64(20), *events[0].OutputTokens)
	require.NotNil(t, events[0].CachedInputTokens)
	require.Equal(t, int64(30), *events[0].CachedInputTokens)

	require.Nil(t, promptUsageEvent(&promptUsage{InputTokens: int64Pointer(-1)}))
}
