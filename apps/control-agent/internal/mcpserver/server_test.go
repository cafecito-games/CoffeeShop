package mcpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

func toolNamesOf(listed []any) []string {
	names := make([]string, 0, len(listed))
	for _, entry := range listed {
		names = append(names, entry.(map[string]any)["name"].(string))
	}
	return names
}

func postRPC(t *testing.T, config Config, body string) (int, map[string]any) {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, config.URL, bytes.NewBufferString(body))
	require.NoError(t, err)
	request.Header.Set("Authorization", "Bearer "+config.Token)
	request.Header.Set("Accept", "application/json, text/event-stream")
	response, err := http.DefaultClient.Do(request)
	require.NoError(t, err)
	defer response.Body.Close()
	var decoded map[string]any
	if response.StatusCode == http.StatusOK {
		require.NoError(t, json.NewDecoder(response.Body).Decode(&decoded))
	}
	return response.StatusCode, decoded
}

func TestRunScopedToolsAndAuthorization(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	server := New(func(_ context.Context, _ string, _ string, _ json.RawMessage) (json.RawMessage, error) {
		return json.RawMessage(`{"ok":true}`), nil
	}, nil, t.TempDir())
	require.NoError(t, server.Start(ctx))
	worker, err := server.Grant("run-worker", t.TempDir(), false)
	require.NoError(t, err)
	orchestrator, err := server.Grant("run-orchestrator", t.TempDir(), true)
	require.NoError(t, err)

	status, initialized := postRPC(t, worker, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`)
	require.Equal(t, http.StatusOK, status)
	require.Equal(t, protocolVersion, initialized["result"].(map[string]any)["protocolVersion"])

	_, workerTools := postRPC(t, worker, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	_, orchestratorTools := postRPC(t, orchestrator, `{"jsonrpc":"2.0","id":3,"method":"tools/list"}`)
	listedWorkerTools := workerTools["result"].(map[string]any)["tools"].([]any)
	require.Equal(t, []string{"get_task_context", "post_artifact", "publish_preview", "update_thread", "send_task_message", "wait_for_task_events", "update_task"}, toolNamesOf(listedWorkerTools))
	require.Contains(t, listedWorkerTools[0].(map[string]any), "outputSchema")
	require.Equal(t, protocol.HubToolNames, toolNamesOf(orchestratorTools["result"].(map[string]any)["tools"].([]any)))

	server.Revoke(worker.Token)
	status, _ = postRPC(t, worker, `{"jsonrpc":"2.0","id":4,"method":"tools/list"}`)
	require.Equal(t, http.StatusUnauthorized, status)
}

func TestPostArtifactValidatesAndUploadsWorkspaceFile(t *testing.T) {
	workspace := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(workspace, "reports"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(workspace, "reports", "result.json"), []byte(`{"ok":true}`), 0o600))
	var hubArguments map[string]any
	var uploaded []byte
	server := New(func(_ context.Context, runID, operation string, arguments json.RawMessage) (json.RawMessage, error) {
		require.Equal(t, "run-one", runID)
		require.Equal(t, "post_artifact", operation)
		require.NoError(t, json.Unmarshal(arguments, &hubArguments))
		return json.RawMessage(`{"artifact":{"id":"artifact-one","uploaded":false},"uploadPath":"/api/artifacts/artifact-one/content"}`), nil
	}, func(_ context.Context, path string, content io.Reader, size int64) error {
		require.Equal(t, "/api/artifacts/artifact-one/content", path)
		var err error
		uploaded, err = io.ReadAll(content)
		require.Equal(t, int64(len(uploaded)), size)
		return err
	}, t.TempDir())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	require.NoError(t, server.Start(ctx))
	config, err := server.Grant("run-one", workspace, false)
	require.NoError(t, err)

	_, response := postRPC(t, config, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"post_artifact","arguments":{"relativePath":"reports/result.json","title":"Results","kind":"report","mediaType":"application/json","idempotencyKey":"result-1"}}}`)
	result := response["result"].(map[string]any)
	require.Equal(t, false, result["isError"])
	require.Equal(t, []byte(`{"ok":true}`), uploaded)
	require.Equal(t, "reports/result.json", hubArguments["relativePath"])
	require.Equal(t, float64(len(uploaded)), hubArguments["size"])
	require.Len(t, hubArguments["sha256"], 64)
}

func TestArtifactPathCannotEscapeWorkspace(t *testing.T) {
	workspace := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside.txt")
	require.NoError(t, os.WriteFile(outside, []byte("secret"), 0o600))
	_, _, _, _, err := openArtifact(workspace, outside)
	require.ErrorContains(t, err, "relative")

	if runtime.GOOS == "windows" {
		return
	}
	require.NoError(t, os.Symlink(outside, filepath.Join(workspace, "escape")))
	_, _, _, _, err = openArtifact(workspace, "escape")
	require.ErrorContains(t, err, "outside")
}

type recordedCall struct {
	runID     string
	operation string
	arguments json.RawMessage
}

// callRecorder captures what the bridge forwards so tests can assert the hub caller contract.
type callRecorder struct {
	mu    sync.Mutex
	calls []recordedCall
}

func (recorder *callRecorder) asCaller() Caller {
	return func(_ context.Context, runID, operation string, arguments json.RawMessage) (json.RawMessage, error) {
		recorder.mu.Lock()
		defer recorder.mu.Unlock()
		recorder.calls = append(recorder.calls, recordedCall{runID: runID, operation: operation, arguments: arguments})
		return json.RawMessage(`{}`), nil
	}
}

func (recorder *callRecorder) recorded() []recordedCall {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	return append([]recordedCall(nil), recorder.calls...)
}

func (recorder *callRecorder) reset() {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	recorder.calls = nil
}

func newTestServer(t *testing.T, caller Caller) *Server {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	server := New(caller, nil, t.TempDir())
	require.NoError(t, server.Start(ctx))
	return server
}

func toolCallBody(identifier int, name, arguments string) string {
	return fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"name":%q,"arguments":%s}}`, identifier, name, arguments)
}

type decodedToolError struct {
	Code      string
	Message   string
	Retryable bool
}

func requireToolError(t *testing.T, response map[string]any) decodedToolError {
	t.Helper()
	result := response["result"].(map[string]any)
	require.Equal(t, true, result["isError"])
	contentEntries := result["content"].([]any)
	require.NotEmpty(t, contentEntries)
	var decoded struct {
		Error struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			Retryable bool   `json:"retryable"`
		} `json:"error"`
	}
	text := contentEntries[0].(map[string]any)["text"].(string)
	require.NoError(t, json.Unmarshal([]byte(text), &decoded))
	return decodedToolError{Code: decoded.Error.Code, Message: decoded.Error.Message, Retryable: decoded.Error.Retryable}
}

func TestDelegationToolsForbiddenForWorkersAndForwardedForOrchestrators(t *testing.T) {
	recorder := &callRecorder{}
	server := newTestServer(t, recorder.asCaller())
	worker, err := server.Grant("run-worker", t.TempDir(), false)
	require.NoError(t, err)
	orchestrator, err := server.Grant("run-orchestrator", t.TempDir(), true)
	require.NoError(t, err)

	for _, name := range protocol.DelegationHubToolNames {
		status, response := postRPC(t, worker, toolCallBody(1, name, `{}`))
		require.Equal(t, http.StatusOK, status, name)
		failure := requireToolError(t, response)
		require.Equal(t, "forbidden", failure.Code, name)
		require.Empty(t, recorder.recorded(), "a worker call to %s must never reach the hub", name)

		status, response = postRPC(t, orchestrator, toolCallBody(2, name, `{}`))
		require.Equal(t, http.StatusOK, status, name)
		require.Equal(t, false, response["result"].(map[string]any)["isError"], name)
		calls := recorder.recorded()
		require.Len(t, calls, 1, name)
		require.Equal(t, "run-orchestrator", calls[0].runID, name)
		require.Equal(t, name, calls[0].operation, name)
		require.JSONEq(t, `{}`, string(calls[0].arguments), name)
		recorder.reset()
	}
}

func TestToolsListRespectsDelegationAndDeclaresObjectSchemas(t *testing.T) {
	server := newTestServer(t, func(_ context.Context, _ string, _ string, _ json.RawMessage) (json.RawMessage, error) {
		return json.RawMessage(`{}`), nil
	})
	worker, err := server.Grant("run-worker", t.TempDir(), false)
	require.NoError(t, err)
	orchestrator, err := server.Grant("run-orchestrator", t.TempDir(), true)
	require.NoError(t, err)

	status, workerResponse := postRPC(t, worker, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	require.Equal(t, http.StatusOK, status)
	listedWorkerTools := workerResponse["result"].(map[string]any)["tools"].([]any)
	workerNames := toolNamesOf(listedWorkerTools)
	for _, name := range protocol.DelegationHubToolNames {
		require.NotContains(t, workerNames, name)
	}

	_, orchestratorResponse := postRPC(t, orchestrator, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	listedOrchestratorTools := orchestratorResponse["result"].(map[string]any)["tools"].([]any)
	require.Equal(t, protocol.HubToolNames, toolNamesOf(listedOrchestratorTools))

	allListed := append(append([]any{}, listedWorkerTools...), listedOrchestratorTools...)
	for _, entry := range allListed {
		tool := entry.(map[string]any)
		require.Equal(t, "object", tool["inputSchema"].(map[string]any)["type"], "inputSchema of %s", tool["name"])
		require.Equal(t, "object", tool["outputSchema"].(map[string]any)["type"], "outputSchema of %s", tool["name"])
	}
}

func TestNonObjectArgumentsRejectedAndAbsentArgumentsBecomeEmptyObject(t *testing.T) {
	recorder := &callRecorder{}
	server := newTestServer(t, recorder.asCaller())
	worker, err := server.Grant("run-worker", t.TempDir(), false)
	require.NoError(t, err)

	for _, raw := range []string{`[]`, `"text"`, `3`, `true`} {
		status, response := postRPC(t, worker, toolCallBody(1, "update_thread", raw))
		require.Equal(t, http.StatusOK, status, raw)
		failure := requireToolError(t, response)
		require.Equal(t, "invalid_arguments", failure.Code, raw)
		require.Empty(t, recorder.recorded(), "arguments %s must never reach the hub", raw)
	}

	variants := []struct {
		name string
		body string
	}{
		{"missing arguments", `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"update_thread"}}`},
		{"null arguments", `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"update_thread","arguments":null}}`},
	}
	for _, variant := range variants {
		status, response := postRPC(t, worker, variant.body)
		require.Equal(t, http.StatusOK, status, variant.name)
		require.Equal(t, false, response["result"].(map[string]any)["isError"], variant.name)
		calls := recorder.recorded()
		require.Len(t, calls, 1, variant.name)
		require.JSONEq(t, `{}`, string(calls[0].arguments), variant.name)
		recorder.reset()
	}
}

func TestUnknownToolNameIsAProtocolError(t *testing.T) {
	recorder := &callRecorder{}
	server := newTestServer(t, recorder.asCaller())
	worker, err := server.Grant("run-worker", t.TempDir(), false)
	require.NoError(t, err)

	status, response := postRPC(t, worker, toolCallBody(1, "definitely_not_a_hub_tool", `{}`))
	require.Equal(t, http.StatusOK, status)
	require.Equal(t, float64(-32602), response["error"].(map[string]any)["code"])
	require.Empty(t, recorder.recorded())
}

func TestCallerErrorsMapToToolErrors(t *testing.T) {
	variants := []struct {
		name     string
		err      error
		expected decodedToolError
	}{
		{"non retryable tool error", &ToolError{Code: "idempotency_conflict", Message: "m", Retryable: false}, decodedToolError{Code: "idempotency_conflict", Message: "m", Retryable: false}},
		{"retryable tool error", &ToolError{Code: "hub_unavailable", Message: "m", Retryable: true}, decodedToolError{Code: "hub_unavailable", Message: "m", Retryable: true}},
		{"plain error", errors.New("boom"), decodedToolError{Code: "tool_failed", Message: "boom", Retryable: false}},
	}
	for _, variant := range variants {
		server := newTestServer(t, func(_ context.Context, _ string, _ string, _ json.RawMessage) (json.RawMessage, error) {
			return nil, variant.err
		})
		worker, err := server.Grant("run-worker", t.TempDir(), false)
		require.NoError(t, err, variant.name)
		status, response := postRPC(t, worker, toolCallBody(1, "get_task_context", `{}`))
		require.Equal(t, http.StatusOK, status, variant.name)
		failure := requireToolError(t, response)
		require.Equal(t, variant.expected, failure, variant.name)
	}
}

func TestNonObjectHubResultIsAnInvalidResult(t *testing.T) {
	for _, raw := range []string{`[]`, `"x"`} {
		server := newTestServer(t, func(_ context.Context, _ string, _ string, _ json.RawMessage) (json.RawMessage, error) {
			return json.RawMessage(raw), nil
		})
		worker, err := server.Grant("run-worker", t.TempDir(), false)
		require.NoError(t, err, raw)
		status, response := postRPC(t, worker, toolCallBody(1, "get_task_context", `{}`))
		require.Equal(t, http.StatusOK, status, raw)
		failure := requireToolError(t, response)
		require.Equal(t, "invalid_result", failure.Code, raw)
		require.True(t, failure.Retryable, raw)
	}
}

func TestSuccessfulHubResultIsStructuredContent(t *testing.T) {
	raw := `{"events":[],"cursor":"c","hasMore":false,"timedOut":true}`
	server := newTestServer(t, func(_ context.Context, _ string, _ string, _ json.RawMessage) (json.RawMessage, error) {
		return json.RawMessage(raw), nil
	})
	worker, err := server.Grant("run-worker", t.TempDir(), false)
	require.NoError(t, err)

	status, response := postRPC(t, worker, toolCallBody(1, "wait_for_task_events", `{}`))
	require.Equal(t, http.StatusOK, status)
	result := response["result"].(map[string]any)
	require.Equal(t, false, result["isError"])
	require.Equal(t, map[string]any{"events": []any{}, "cursor": "c", "hasMore": false, "timedOut": true}, result["structuredContent"])
	require.JSONEq(t, raw, result["content"].([]any)[0].(map[string]any)["text"].(string))
}

func TestNestedArgumentsAreForwardedVerbatim(t *testing.T) {
	recorder := &callRecorder{}
	server := newTestServer(t, recorder.asCaller())
	worker, err := server.Grant("run-worker", t.TempDir(), false)
	require.NoError(t, err)

	arguments := `{"idempotencyKey":"send-1","recipient":{"type":"task","taskId":"task-9"},"kind":"question","body":"Where is the build?"}`
	status, response := postRPC(t, worker, toolCallBody(1, "send_task_message", arguments))
	require.Equal(t, http.StatusOK, status)
	require.Equal(t, false, response["result"].(map[string]any)["isError"])
	calls := recorder.recorded()
	require.Len(t, calls, 1)
	require.Equal(t, "run-worker", calls[0].runID)
	require.Equal(t, "send_task_message", calls[0].operation)
	require.JSONEq(t, arguments, string(calls[0].arguments))
}

func TestForwardedArgumentsGainNoRunIdentifiers(t *testing.T) {
	recorder := &callRecorder{}
	server := newTestServer(t, recorder.asCaller())
	worker, err := server.Grant("run-worker", t.TempDir(), false)
	require.NoError(t, err)

	status, response := postRPC(t, worker, toolCallBody(1, "get_task_context", `{"taskId":"x"}`))
	require.Equal(t, http.StatusOK, status)
	require.Equal(t, false, response["result"].(map[string]any)["isError"])
	calls := recorder.recorded()
	require.Len(t, calls, 1)
	require.JSONEq(t, `{"taskId":"x"}`, string(calls[0].arguments))
}

func TestRevokedGrantCannotCallTools(t *testing.T) {
	recorder := &callRecorder{}
	server := newTestServer(t, recorder.asCaller())
	worker, err := server.Grant("run-worker", t.TempDir(), false)
	require.NoError(t, err)

	server.Revoke(worker.Token)
	status, _ := postRPC(t, worker, toolCallBody(1, "get_task_context", `{}`))
	require.Equal(t, http.StatusUnauthorized, status)
	require.Empty(t, recorder.recorded())
}
