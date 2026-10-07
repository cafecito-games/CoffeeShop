package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// runCodexAppServer is the account-free private-stdio fixture for the existing-session system
// test. It implements only the pinned read surface exercised by Barista; an unexpected method is
// refused rather than silently emulated.
func runCodexAppServer(recorder *recorder) int {
	workspace := os.Getenv(codexWorkspaceVariable)
	if workspace == "" {
		fmt.Fprintln(os.Stderr, "fakeharness: Codex workspace is missing")
		return 64
	}
	recorder.write(map[string]any{"event": "codex-app-server", "transport": "private-stdio"})
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 2<<20)
	encoder := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if json.Unmarshal(scanner.Bytes(), &request) != nil || request.Method == "" {
			return 65
		}
		if len(request.ID) == 0 {
			continue
		}
		var result any
		var rpcError any
		switch request.Method {
		case "initialize":
			result = map[string]any{
				"userAgent": "codex-cli/0.147.0", "codexHome": filepath.Join(os.Getenv("HOME"), ".codex"),
				"platformFamily": "unix", "platformOs": "linux",
			}
		case "thread/list":
			var params struct {
				Cursor string `json:"cursor"`
			}
			_ = json.Unmarshal(request.Params, &params)
			threads := []any{}
			if params.Cursor == "" {
				threads = append(threads,
					fakeCodexThread("system-codex-thread", workspace, "paginated", nil),
					fakeCodexThread("system-codex-legacy", workspace, "legacy", nil),
				)
			}
			result = map[string]any{"data": threads, "nextCursor": nil}
		case "thread/read":
			var params struct {
				ThreadID string `json:"threadId"`
			}
			if json.Unmarshal(request.Params, &params) != nil || params.ThreadID == "" {
				rpcError = map[string]any{"code": -32602, "message": "invalid thread identity"}
				break
			}
			mode := "paginated"
			if params.ThreadID == "system-codex-legacy" {
				mode = "legacy"
			}
			turns := []any{map[string]any{
				"id": "system-provider-turn", "status": "completed", "items": []any{
					map[string]any{"type": "userMessage", "id": "system-history-user", "content": []any{map[string]any{"type": "text", "text": "Synthetic system-test request"}}},
					map[string]any{"type": "agentMessage", "id": "system-history-assistant", "text": "Synthetic bounded response"},
				},
			}}
			result = map[string]any{"thread": fakeCodexThread(params.ThreadID, workspace, mode, turns)}
		case "thread/items/list":
			var params struct {
				ThreadID      string `json:"threadId"`
				Limit         int    `json:"limit"`
				SortDirection string `json:"sortDirection"`
			}
			if json.Unmarshal(request.Params, &params) != nil || params.ThreadID == "" || params.Limit < 2 || params.SortDirection != "desc" {
				rpcError = map[string]any{"code": -32602, "message": "invalid history request"}
				break
			}
			result = map[string]any{
				"data": []any{
					map[string]any{"turnId": "system-provider-turn", "item": map[string]any{"type": "agentMessage", "id": "system-history-assistant", "text": "Synthetic bounded response"}},
					map[string]any{"turnId": "system-provider-turn", "item": map[string]any{"type": "userMessage", "id": "system-history-user", "content": []any{map[string]any{"type": "text", "text": "Synthetic system-test request"}}}},
				},
				"nextCursor": nil,
			}
		default:
			rpcError = map[string]any{"code": -32601, "message": "unsupported method"}
		}
		response := map[string]any{"id": json.RawMessage(request.ID), "result": result}
		if rpcError != nil {
			delete(response, "result")
			response["error"] = rpcError
		}
		if encoder.Encode(response) != nil {
			return 70
		}
	}
	if scanner.Err() != nil {
		return 70
	}
	return 0
}

func fakeCodexThread(id, workspace, historyMode string, turns []any) map[string]any {
	if turns == nil {
		turns = []any{}
	}
	return map[string]any{
		"id": id, "cwd": workspace, "cliVersion": "0.147.0", "historyMode": historyMode,
		"preview": "Synthetic existing Codex thread", "createdAt": 1, "updatedAt": 2,
		"ephemeral": false, "source": "cli", "status": map[string]any{"type": "notLoaded"}, "turns": turns,
	}
}
