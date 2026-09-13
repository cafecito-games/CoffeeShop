package mcpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/require"
)

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
	}, nil)
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
	require.Len(t, listedWorkerTools, 3)
	require.Contains(t, listedWorkerTools[0].(map[string]any), "outputSchema")
	require.Len(t, orchestratorTools["result"].(map[string]any)["tools"], 4)

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
	})
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
