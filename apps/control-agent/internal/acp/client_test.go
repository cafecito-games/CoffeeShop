package acp

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp/acptest"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

const testToken = "run-scoped-secret-token-value"

type recorder struct {
	mu     sync.Mutex
	events []protocol.HarnessEvent
}

func (events *recorder) add(event protocol.HarnessEvent) {
	events.mu.Lock()
	defer events.mu.Unlock()
	events.events = append(events.events, event)
}

func (events *recorder) all() []protocol.HarnessEvent {
	events.mu.Lock()
	defer events.mu.Unlock()
	return append([]protocol.HarnessEvent(nil), events.events...)
}

func (events *recorder) ofType(eventType string) []protocol.HarnessEvent {
	matching := []protocol.HarnessEvent{}
	for _, event := range events.all() {
		if event.Type == eventType {
			matching = append(matching, event)
		}
	}
	return matching
}

type scenarioRun struct {
	result  Result
	err     error
	events  *recorder
	process *acptest.Process
}

func runScenario(t *testing.T, ctx context.Context, scenario string, configure func(*Options)) scenarioRun {
	t.Helper()
	process := acptest.Start(t, scenario)
	events := &recorder{}
	options := Options{
		RunID: "run-acp", Secrets: []string{testToken}, Events: events.add,
		RequestTimeout: 5 * time.Second, CancelGracePeriod: 500 * time.Millisecond, PermissionTimeout: time.Second,
	}
	if configure != nil {
		configure(&options)
	}
	client := NewClient(process.Stdout, process.Stdin, options)
	result, err := client.Run(ctx, SessionRequest{
		Cwd: t.TempDir(), Prompt: "do the work",
		MCPServer: &MCPServer{Name: "coffee_shop_hub", URL: "http://127.0.0.1:9/mcp", BearerToken: testToken},
	})
	client.Close()
	if err != nil {
		_ = process.Command.Process.Kill()
		acptest.KillDescendants(t, process.RecordPath)
	}
	finished := make(chan struct{})
	go func() {
		client.Wait()
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		_ = process.Command.Process.Kill()
		acptest.KillDescendants(t, process.RecordPath)
		_ = process.Stdout.Close()
		<-finished
	}
	for _, event := range events.all() {
		require.NoError(t, event.Validate())
	}
	return scenarioRun{result: result, err: err, events: events, process: process}
}

func TestClientCompletesHandshakeAndPromptTurn(t *testing.T) {
	run := runScenario(t, context.Background(), "success", nil)
	require.NoError(t, run.err)
	require.Equal(t, "Hello world", run.result.Text)
	require.Equal(t, acptest.SessionID, run.result.SessionID)
	require.Equal(t, "end_turn", run.result.StopReason)
	require.Equal(t, "fake-acp-agent", run.result.AgentName)

	initialize := acptest.ReceivedMethod(t, run.process.RecordPath, "initialize")
	require.NotNil(t, initialize)
	params := initialize["params"].(map[string]any)
	require.EqualValues(t, 1, params["protocolVersion"])
	capabilities := params["clientCapabilities"].(map[string]any)
	require.Equal(t, false, capabilities["terminal"])
	require.Equal(t, map[string]any{"readTextFile": false, "writeTextFile": false}, capabilities["fs"])
	require.NotNil(t, acptest.ReceivedMethod(t, run.process.RecordPath, "session/close"))
}

func TestClientInjectsRunScopedMCPServerWithAuthorizationHeader(t *testing.T) {
	run := runScenario(t, context.Background(), "success", nil)
	require.NoError(t, run.err)
	sessionNew := acptest.ReceivedMethod(t, run.process.RecordPath, "session/new")
	params := sessionNew["params"].(map[string]any)
	require.NotEmpty(t, params["cwd"])
	servers := params["mcpServers"].([]any)
	require.Len(t, servers, 1)
	require.Equal(t, map[string]any{
		"type": "http", "name": "coffee_shop_hub", "url": "http://127.0.0.1:9/mcp",
		"headers": []any{map[string]any{"name": "Authorization", "value": "Bearer " + testToken}},
	}, servers[0])
}

func TestClientNormalizesEveryStreamedEventCategory(t *testing.T) {
	run := runScenario(t, context.Background(), "stream", nil)
	require.NoError(t, run.err)
	require.Equal(t, "Done", run.result.Text)

	types := []string{}
	for index, event := range run.events.all() {
		require.Equal(t, "run-acp", event.RunID)
		require.EqualValues(t, index+1, event.Sequence)
		types = append(types, event.Type)
	}
	require.Equal(t, []string{"thought.delta", "plan.updated", "tool.call", "tool.call", "diff", "usage", "message.delta", "usage"}, types)

	plan := run.events.ofType("plan.updated")[0]
	require.Equal(t, []protocol.PlanEntry{{Content: "Read code", Status: "in-progress", Priority: "high"}, {Content: "Write tests", Status: "pending", Priority: "medium"}}, plan.Entries)
	tools := run.events.ofType("tool.call")
	require.Equal(t, "pending", tools[0].Status)
	require.Equal(t, "edit", tools[0].Kind)
	require.Equal(t, "Edit main.go", tools[1].Title)
	require.Equal(t, "completed", tools[1].Status)
	require.Equal(t, "Applied edit", tools[1].Detail)
	diff := run.events.ofType("diff")[0]
	require.Equal(t, "call-1", diff.ToolCallID)
	require.Equal(t, "/workspace/main.go", diff.Path)
	require.Equal(t, "old", diff.OldText)
	require.Equal(t, "new", diff.NewText)
	usage := run.events.ofType("usage")
	require.InDelta(t, 0.25, *usage[0].CostUSD, 0.0001)
	require.EqualValues(t, 10, *usage[1].InputTokens)
	require.EqualValues(t, 20, *usage[1].OutputTokens)
	require.EqualValues(t, 5, *usage[1].CachedInputTokens)
}

func TestClientReassemblesFramesSplitAcrossReads(t *testing.T) {
	run := runScenario(t, context.Background(), "partial-reads", nil)
	require.NoError(t, run.err)
	require.Equal(t, "split frames", run.result.Text)
	require.Len(t, run.events.ofType("message.delta"), 2)
}

func TestPermissionRequestRoundTripsThroughCallback(t *testing.T) {
	var received PermissionRequest
	run := runScenario(t, context.Background(), "permission", func(options *Options) {
		options.Permission = func(_ context.Context, request PermissionRequest) (PermissionDecision, error) {
			received = request
			return PermissionDecision{OptionID: "allow"}, nil
		}
	})
	require.NoError(t, run.err)
	require.Equal(t, "run-acp", received.RunID)
	require.Equal(t, acptest.SessionID, received.SessionID)
	require.Equal(t, "call-1", received.ToolCallID)
	require.Equal(t, "Run tests", received.Title)
	require.Equal(t, "execute", received.Kind)
	require.Equal(t, []protocol.ApprovalOption{{ID: "allow", Label: "Allow once", Kind: "allow-once"}, {ID: "reject", Label: "Reject", Kind: "reject-once"}}, received.Options)

	response := acptest.ReceivedResponse(t, run.process.RecordPath, "permission-1")
	require.Equal(t, map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": "allow"}}, response["result"])
	requested := run.events.ofType("permission.requested")
	require.Len(t, requested, 1)
	resolved := run.events.ofType("permission.resolved")
	require.Len(t, resolved, 1)
	require.Equal(t, requested[0].ApprovalID, resolved[0].ApprovalID)
	require.Equal(t, "approved", resolved[0].Status)
	require.Equal(t, "allow", resolved[0].SelectedOptionID)
}

func TestPermissionNeverAllowsWithoutAValidTimelyDecision(t *testing.T) {
	cases := []struct {
		name       string
		permission PermissionHandler
		status     string
	}{
		{name: "no callback", permission: nil, status: "cancelled"},
		{name: "callback error", permission: func(context.Context, PermissionRequest) (PermissionDecision, error) {
			return PermissionDecision{OptionID: "allow"}, context.DeadlineExceeded
		}, status: "cancelled"},
		{name: "unknown option", permission: func(context.Context, PermissionRequest) (PermissionDecision, error) {
			return PermissionDecision{OptionID: "allow-everything"}, nil
		}, status: "cancelled"},
		{name: "timeout", permission: func(ctx context.Context, _ PermissionRequest) (PermissionDecision, error) {
			<-ctx.Done()
			return PermissionDecision{OptionID: "allow"}, nil
		}, status: "expired"},
		{name: "explicit rejection", permission: func(context.Context, PermissionRequest) (PermissionDecision, error) {
			return PermissionDecision{OptionID: "reject"}, nil
		}, status: "rejected"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			run := runScenario(t, context.Background(), "permission", func(options *Options) {
				options.Permission = testCase.permission
				options.PermissionTimeout = 200 * time.Millisecond
			})
			require.NoError(t, run.err)
			response := acptest.ReceivedResponse(t, run.process.RecordPath, "permission-1")
			require.Equal(t, map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": "reject"}}, response["result"])
			resolved := run.events.ofType("permission.resolved")
			require.Len(t, resolved, 1)
			require.Equal(t, testCase.status, resolved[0].Status)
		})
	}
}

func TestMalformedPermissionRequestIsCancelled(t *testing.T) {
	called := false
	run := runScenario(t, context.Background(), "permission-malformed", func(options *Options) {
		options.Permission = func(context.Context, PermissionRequest) (PermissionDecision, error) {
			called = true
			return PermissionDecision{OptionID: "allow"}, nil
		}
	})
	require.NoError(t, run.err)
	require.False(t, called)
	response := acptest.ReceivedResponse(t, run.process.RecordPath, float64(7))
	require.Equal(t, map[string]any{"outcome": map[string]any{"outcome": "cancelled"}}, response["result"])
	warnings := run.events.ofType("warning")
	require.Len(t, warnings, 1)
	require.Equal(t, WarningPermissionMalformed, warnings[0].Code)
}

func TestInterleavedAgentRequestsAreServicedIndependently(t *testing.T) {
	release := make(chan struct{})
	run := runScenario(t, context.Background(), "interleaved", func(options *Options) {
		options.Permission = func(ctx context.Context, _ PermissionRequest) (PermissionDecision, error) {
			select {
			case <-release:
			case <-ctx.Done():
			}
			return PermissionDecision{OptionID: "allow"}, nil
		}
		options.Events = func(event protocol.HarnessEvent) {
			if event.Type == "message.delta" {
				close(release)
			}
		}
	})
	require.NoError(t, run.err)
	read := acptest.ReceivedResponse(t, run.process.RecordPath, float64(99))
	require.EqualValues(t, CodeMethodNotFound, read["error"].(map[string]any)["code"])
	permission := acptest.ReceivedResponse(t, run.process.RecordPath, "permission-1")
	require.Equal(t, "allow", permission["result"].(map[string]any)["outcome"].(map[string]any)["optionId"])
}

func TestCancellationIsCooperativeWhenTheAgentAcknowledges(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	started := time.Now()
	run := runScenario(t, ctx, "cancel-cooperative", func(options *Options) {
		options.CancelGracePeriod = 5 * time.Second
		options.Events = func(event protocol.HarnessEvent) {
			if event.Type == "message.delta" {
				cancel()
			}
		}
	})
	require.ErrorIs(t, run.err, ErrCancelled)
	require.Less(t, time.Since(started), 4*time.Second)
	cancelFrame := acptest.ReceivedMethod(t, run.process.RecordPath, "session/cancel")
	require.NotNil(t, cancelFrame)
	require.Nil(t, cancelFrame["id"])
	require.Equal(t, acptest.SessionID, cancelFrame["params"].(map[string]any)["sessionId"])
}

func TestCancellationGraceExpiresWhenTheAgentIgnoresIt(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var cancelledAt time.Time
	run := runScenario(t, ctx, "cancel-ignored", func(options *Options) {
		options.CancelGracePeriod = 300 * time.Millisecond
		options.Events = func(event protocol.HarnessEvent) {
			if event.Type == "message.delta" {
				cancelledAt = time.Now()
				cancel()
			}
		}
	})
	require.ErrorIs(t, run.err, ErrCancelGraceExpired)
	require.GreaterOrEqual(t, time.Since(cancelledAt), 300*time.Millisecond)
}

func TestProtocolFailuresFailDeterministically(t *testing.T) {
	cases := []struct {
		scenario string
		target   error
	}{
		{scenario: "stdout-contamination", target: ErrStdoutContamination},
		{scenario: "embedded-frames", target: ErrStdoutContamination},
		{scenario: "oversized-frame", target: ErrFrameTooLarge},
		{scenario: "unknown-response-id", target: ErrProtocolViolation},
		{scenario: "duplicate-response-id", target: ErrProtocolViolation},
		{scenario: "version-mismatch", target: ErrUnsupportedVersion},
		{scenario: "missing-http-mcp", target: ErrMissingCapability},
		{scenario: "authentication-required", target: ErrAuthenticationRequired},
		{scenario: "premature-exit", target: ErrAdapterClosed},
		{scenario: "malformed-update", target: ErrMalformedUpdate},
		{scenario: "foreign-session", target: ErrProtocolViolation},
		{scenario: "refusal", target: ErrIncompleteTurn},
	}
	for _, testCase := range cases {
		t.Run(testCase.scenario, func(t *testing.T) {
			run := runScenario(t, context.Background(), testCase.scenario, nil)
			require.ErrorIs(t, run.err, testCase.target)
		})
	}
}

func TestUnknownOptionalNotificationsAndUpdatesAreDiagnosed(t *testing.T) {
	run := runScenario(t, context.Background(), "unknown-notification", nil)
	require.NoError(t, run.err)
	require.Equal(t, "still fine", run.result.Text)
	unknown := run.events.ofType("unknown")
	require.Len(t, unknown, 2)
	require.Equal(t, "session/unheard_of", unknown[0].SourceType)
	require.Equal(t, "future_update_kind", unknown[1].SourceType)
}

func TestUpdatesAfterCompletionAreIgnoredWithOneDiagnostic(t *testing.T) {
	run := runScenario(t, context.Background(), "updates-after-completion", nil)
	require.NoError(t, run.err)
	require.Empty(t, run.result.Text)
	require.Empty(t, run.events.ofType("message.delta"))
	warnings := run.events.ofType("warning")
	require.Len(t, warnings, 1)
	require.Equal(t, WarningUpdateAfterComplete, warnings[0].Code)
}

func TestSecretsAreRedactedFromEventsAndResults(t *testing.T) {
	run := runScenario(t, context.Background(), "secret-echo", nil)
	require.NoError(t, run.err)
	require.Equal(t, "token is [redacted]", run.result.Text)
	for _, event := range run.events.all() {
		require.NotContains(t, event.Text+event.Title+event.Detail, testToken)
	}
	require.Equal(t, "curl -H 'Authorization: Bearer [redacted]'", run.events.ofType("tool.call")[0].Title)
}
