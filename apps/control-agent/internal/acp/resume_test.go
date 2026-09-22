package acp

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp/acptest"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

const (
	resumeRunPrompt  = "do the work"
	resumeTurnPrompt = "continue the durable work"
)

type resumeScenarioRun struct {
	result  Result
	err     error
	events  *recorder
	process *acptest.Process
	client  *Client
	cwd     string
}

// runResumeScenario drives one session request whose Resume names acptest.ResumedSessionID, so the
// prompt turn is only reached through session/resume, session/load, or a replacement session/new.
func runResumeScenario(t *testing.T, scenario string, resume *ResumeRequest) resumeScenarioRun {
	t.Helper()
	process := acptest.Start(t, scenario)
	events := &recorder{}
	client := NewClient(process.Stdout, process.Stdin, Options{
		RunID: "run-acp", Secrets: []string{testToken}, Events: events.add,
		RequestTimeout: 5 * time.Second, CancelGracePeriod: 500 * time.Millisecond, PermissionTimeout: time.Second,
	})
	cwd := t.TempDir()
	result, err := client.Run(context.Background(), SessionRequest{
		Cwd: cwd, Prompt: resumeRunPrompt, Resume: resume,
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
	return resumeScenarioRun{result: result, err: err, events: events, process: process, client: client, cwd: cwd}
}

// receivedMethodNames lists the requests and notifications the adapter read, in order.
func receivedMethodNames(t *testing.T, recordPath string) []string {
	t.Helper()
	names := []string{}
	for _, frame := range acptest.Received(t, recordPath) {
		if method, isRequest := frame["method"].(string); isRequest {
			names = append(names, method)
		}
	}
	return names
}

func continueRequest() *ResumeRequest {
	return &ResumeRequest{SessionID: acptest.ResumedSessionID, Prompt: resumeTurnPrompt}
}

func requireResumeParameters(t *testing.T, run resumeScenarioRun, method string) map[string]any {
	t.Helper()
	frame := acptest.ReceivedMethod(t, run.process.RecordPath, method)
	require.NotNil(t, frame, "the adapter must receive %s", method)
	params := frame["params"].(map[string]any)
	require.Equal(t, acptest.ResumedSessionID, params["sessionId"])
	require.Equal(t, run.cwd, params["cwd"])
	servers := params["mcpServers"].([]any)
	require.Len(t, servers, 1)
	require.Equal(t, map[string]any{
		"type": "http", "name": "coffee_shop_hub", "url": "http://127.0.0.1:9/mcp",
		"headers": []any{map[string]any{"name": "Authorization", "value": "Bearer " + testToken}},
	}, servers[0])
	return params
}

func promptedText(t *testing.T, recordPath string) string {
	t.Helper()
	prompt := acptest.ReceivedMethod(t, recordPath, "session/prompt")
	require.NotNil(t, prompt)
	return prompt["params"].(map[string]any)["prompt"].([]any)[0].(map[string]any)["text"].(string)
}

func TestClientResumesThroughSessionResume(t *testing.T) {
	run := runResumeScenario(t, "resume-success", continueRequest())
	require.NoError(t, run.err)
	require.Equal(t, acptest.ResumedSessionID, run.result.SessionID)
	require.Equal(t, "resumed work", run.result.Text)
	sessionID, resumed := run.client.Session()
	require.Equal(t, acptest.ResumedSessionID, sessionID)
	require.True(t, resumed)

	require.Equal(t, []string{"initialize", "session/resume", "session/prompt", "session/close"},
		receivedMethodNames(t, run.process.RecordPath))
	requireResumeParameters(t, run, "session/resume")
	require.Equal(t, resumeTurnPrompt, promptedText(t, run.process.RecordPath))
	for _, event := range run.events.all() {
		require.NotEqual(t, WarningSessionNotResumed, event.Code)
	}
}

func TestClientReplacesTheSessionWhenResumeIsRefused(t *testing.T) {
	run := runResumeScenario(t, "resume-refused", continueRequest())
	require.NoError(t, run.err)
	require.Equal(t, acptest.SessionID, run.result.SessionID)
	sessionID, resumed := run.client.Session()
	require.Equal(t, acptest.SessionID, sessionID)
	require.False(t, resumed)

	require.Equal(t, []string{"initialize", "session/resume", "session/new", "session/prompt", "session/close"},
		receivedMethodNames(t, run.process.RecordPath))
	requireResumeParameters(t, run, "session/resume")
	require.Equal(t, resumeRunPrompt, promptedText(t, run.process.RecordPath))
	warnings := run.events.ofType("warning")
	require.Len(t, warnings, 1)
	require.Equal(t, WarningSessionNotResumed, warnings[0].Code)
}

func TestClientResumesThroughSessionLoadAndDiscardsReplayedHistory(t *testing.T) {
	run := runResumeScenario(t, "load-success", continueRequest())
	require.NoError(t, run.err)
	sessionID, resumed := run.client.Session()
	require.Equal(t, acptest.ResumedSessionID, sessionID)
	require.True(t, resumed)

	require.Equal(t, []string{"initialize", "session/load", "session/prompt", "session/close"},
		receivedMethodNames(t, run.process.RecordPath))
	requireResumeParameters(t, run, "session/load")
	require.Equal(t, resumeTurnPrompt, promptedText(t, run.process.RecordPath))

	for _, event := range run.events.all() {
		require.NotContains(t, event.Text+event.Title+event.Detail, "old history")
		require.NotEqual(t, WarningSessionNotResumed, event.Code)
	}
	require.Equal(t, []string{"fresh"}, textsOf(run.events.ofType("message.delta")))

	response := acptest.ReceivedResponse(t, run.process.RecordPath, "load-permission-1")
	require.NotNil(t, response)
	require.Equal(t, map[string]any{"outcome": map[string]any{"outcome": "cancelled"}}, response["result"])
}

func TestClientWarnsAndStartsANewSessionWithoutResumeSupport(t *testing.T) {
	run := runResumeScenario(t, "resume-unsupported", continueRequest())
	require.NoError(t, run.err)
	require.Equal(t, acptest.SessionID, run.result.SessionID)
	sessionID, resumed := run.client.Session()
	require.Equal(t, acptest.SessionID, sessionID)
	require.False(t, resumed)

	require.Equal(t, []string{"initialize", "session/new", "session/prompt", "session/close"},
		receivedMethodNames(t, run.process.RecordPath))
	require.Nil(t, acptest.ReceivedMethod(t, run.process.RecordPath, "session/resume"))
	require.Nil(t, acptest.ReceivedMethod(t, run.process.RecordPath, "session/load"))
	require.Equal(t, resumeRunPrompt, promptedText(t, run.process.RecordPath))
	warnings := run.events.ofType("warning")
	require.Len(t, warnings, 1)
	require.Equal(t, WarningSessionNotResumed, warnings[0].Code)
}

func TestClientFailsAuthenticationRequiredWithoutAReplacementSession(t *testing.T) {
	run := runResumeScenario(t, "resume-auth-required", continueRequest())
	require.ErrorIs(t, run.err, ErrAuthenticationRequired)
	sessionID, resumed := run.client.Session()
	require.Empty(t, sessionID)
	require.False(t, resumed)
	require.Nil(t, acptest.ReceivedMethod(t, run.process.RecordPath, "session/new"))
	require.Nil(t, acptest.ReceivedMethod(t, run.process.RecordPath, "session/prompt"))
}

func TestClientFailsWithoutAPromptWhenTheAdapterExitsDuringResume(t *testing.T) {
	run := runResumeScenario(t, "resume-adapter-exit", continueRequest())
	require.ErrorIs(t, run.err, ErrAdapterClosed)
	require.Nil(t, acptest.ReceivedMethod(t, run.process.RecordPath, "session/new"))
	require.Nil(t, acptest.ReceivedMethod(t, run.process.RecordPath, "session/prompt"))
}

func TestClientRejectsAnInvalidResumeIdentityBeforeAnySessionRequest(t *testing.T) {
	for name, sessionID := range map[string]string{
		"empty":    "",
		"too long": strings.Repeat("s", 257),
	} {
		t.Run(name, func(t *testing.T) {
			run := runResumeScenario(t, "resume-success", &ResumeRequest{SessionID: sessionID, Prompt: resumeTurnPrompt})
			require.ErrorContains(t, run.err, "acp resume session identity is invalid")
			for _, method := range []string{"session/resume", "session/load", "session/new", "session/prompt"} {
				require.Nil(t, acptest.ReceivedMethod(t, run.process.RecordPath, method), "%s must never be sent", method)
			}
		})
	}
}

func textsOf(events []protocol.HarnessEvent) []string {
	texts := make([]string, 0, len(events))
	for _, event := range events {
		texts = append(texts, event.Text)
	}
	return texts
}
