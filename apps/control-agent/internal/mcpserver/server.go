package mcpserver

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	protocolVersion     = "2025-06-18"
	maximumArtifactSize = 10 * 1024 * 1024
)

type Caller func(context.Context, string, string, json.RawMessage) (json.RawMessage, error)
type Uploader func(context.Context, string, io.Reader, int64) error

type Config struct {
	URL         string
	Token       string
	CanDelegate bool
}

type grant struct {
	runID       string
	workspace   string
	canDelegate bool
}

type Server struct {
	caller   Caller
	uploader Uploader

	mu     sync.RWMutex
	grants map[string]grant
	url    string
	server *http.Server
}

func New(caller Caller, uploader Uploader) *Server {
	return &Server{caller: caller, uploader: uploader, grants: map[string]grant{}}
}

func (server *Server) Start(ctx context.Context) error {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("start MCP listener: %w", err)
	}
	server.mu.Lock()
	server.url = "http://" + listener.Addr().String() + "/mcp"
	server.server = &http.Server{Handler: http.HandlerFunc(server.serveHTTP), ReadHeaderTimeout: 5 * time.Second}
	server.mu.Unlock()
	go func() {
		<-ctx.Done()
		shutdownContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.server.Shutdown(shutdownContext)
	}()
	go func() { _ = server.server.Serve(listener) }()
	return nil
}

func (server *Server) Grant(runID, workspace string, canDelegate bool) (Config, error) {
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return Config{}, fmt.Errorf("create MCP capability: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes)
	server.mu.Lock()
	defer server.mu.Unlock()
	server.grants[token] = grant{runID: runID, workspace: workspace, canDelegate: canDelegate}
	return Config{URL: server.url, Token: token, CanDelegate: canDelegate}, nil
}

func (server *Server) Revoke(token string) {
	server.mu.Lock()
	defer server.mu.Unlock()
	delete(server.grants, token)
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type callParams struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (server *Server) serveHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.URL.Path != "/mcp" {
		http.NotFound(writer, request)
		return
	}
	if request.Method == http.MethodGet || request.Method == http.MethodDelete {
		writer.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if request.Method != http.MethodPost {
		writer.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !validOrigin(request.Header.Get("Origin")) {
		http.Error(writer, "invalid origin", http.StatusForbidden)
		return
	}
	token := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
	server.mu.RLock()
	activeGrant, ok := server.grants[token]
	server.mu.RUnlock()
	if !ok || token == "" {
		http.Error(writer, "unauthorized", http.StatusUnauthorized)
		return
	}
	request.Body = http.MaxBytesReader(writer, request.Body, 1<<20)
	var message rpcRequest
	if err := json.NewDecoder(request.Body).Decode(&message); err != nil || message.JSONRPC != "2.0" || message.Method == "" {
		writeRPC(writer, rpcResponse{JSONRPC: "2.0", ID: message.ID, Error: &rpcError{Code: -32600, Message: "Invalid request"}})
		return
	}
	if len(message.ID) == 0 {
		writer.WriteHeader(http.StatusAccepted)
		return
	}

	switch message.Method {
	case "initialize":
		writeRPC(writer, rpcResponse{JSONRPC: "2.0", ID: message.ID, Result: map[string]any{
			"protocolVersion": protocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]string{"name": "coffee-shop-hub", "version": "1"},
			"instructions":    "Use get_task_context for the durable thread and task lineage. Refine or complete the thread with update_thread. Post durable outputs with post_artifact. Delegate only bounded work when delegate_task is available; retain the returned task id and inspect it later with get_task_context.",
		}})
	case "tools/list":
		writeRPC(writer, rpcResponse{JSONRPC: "2.0", ID: message.ID, Result: map[string]any{"tools": tools(activeGrant.canDelegate)}})
	case "tools/call":
		server.callTool(writer, request, message, activeGrant)
	default:
		writeRPC(writer, rpcResponse{JSONRPC: "2.0", ID: message.ID, Error: &rpcError{Code: -32601, Message: "Method not found"}})
	}
}

func validOrigin(raw string) bool {
	if raw == "" {
		return true
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return false
	}
	host := parsed.Hostname()
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func (server *Server) callTool(writer http.ResponseWriter, request *http.Request, message rpcRequest, activeGrant grant) {
	var params callParams
	if err := json.Unmarshal(message.Params, &params); err != nil || params.Name == "" {
		writeRPC(writer, rpcResponse{JSONRPC: "2.0", ID: message.ID, Error: &rpcError{Code: -32602, Message: "Invalid tool arguments"}})
		return
	}
	if params.Name == "delegate_task" && !activeGrant.canDelegate {
		writeToolError(writer, message.ID, "This run is not allowed to delegate tasks")
		return
	}
	if params.Name != "get_task_context" && params.Name != "delegate_task" && params.Name != "post_artifact" && params.Name != "update_thread" {
		writeRPC(writer, rpcResponse{JSONRPC: "2.0", ID: message.ID, Error: &rpcError{Code: -32602, Message: "Unknown tool"}})
		return
	}
	arguments := params.Arguments
	if len(arguments) == 0 {
		arguments = json.RawMessage(`{}`)
	}
	var (
		result json.RawMessage
		err    error
	)
	if params.Name == "post_artifact" {
		result, err = server.postArtifact(request.Context(), activeGrant, arguments)
	} else {
		result, err = server.caller(request.Context(), activeGrant.runID, params.Name, arguments)
	}
	if err != nil {
		writeToolError(writer, message.ID, err.Error())
		return
	}
	var structured any
	if err := json.Unmarshal(result, &structured); err != nil {
		writeToolError(writer, message.ID, "Hub returned an invalid tool result")
		return
	}
	writeRPC(writer, rpcResponse{JSONRPC: "2.0", ID: message.ID, Result: map[string]any{
		"content":           []map[string]string{{"type": "text", "text": string(result)}},
		"structuredContent": structured,
		"isError":           false,
	}})
}

type postArtifactArguments struct {
	RelativePath   string `json:"relativePath"`
	Title          string `json:"title"`
	Kind           string `json:"kind"`
	MediaType      string `json:"mediaType"`
	Summary        string `json:"summary,omitempty"`
	IdempotencyKey string `json:"idempotencyKey"`
}

func (server *Server) postArtifact(ctx context.Context, activeGrant grant, raw json.RawMessage) (json.RawMessage, error) {
	var arguments postArtifactArguments
	if err := json.Unmarshal(raw, &arguments); err != nil {
		return nil, errors.New("invalid post_artifact arguments")
	}
	file, relativePath, size, digest, err := openArtifact(activeGrant.workspace, arguments.RelativePath)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	arguments.RelativePath = relativePath
	requestArguments, err := json.Marshal(map[string]any{
		"relativePath": arguments.RelativePath, "title": arguments.Title, "kind": arguments.Kind,
		"mediaType": arguments.MediaType, "summary": arguments.Summary, "idempotencyKey": arguments.IdempotencyKey,
		"size": size, "sha256": digest,
	})
	if err != nil {
		return nil, err
	}
	result, err := server.caller(ctx, activeGrant.runID, "post_artifact", requestArguments)
	if err != nil {
		return nil, err
	}
	var registration struct {
		Artifact   map[string]any `json:"artifact"`
		UploadPath string         `json:"uploadPath"`
	}
	if err := json.Unmarshal(result, &registration); err != nil || registration.UploadPath == "" {
		return nil, errors.New("hub returned an invalid artifact registration")
	}
	if server.uploader == nil {
		return nil, errors.New("artifact upload is unavailable")
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	if err := server.uploader(ctx, registration.UploadPath, file, size); err != nil {
		return nil, fmt.Errorf("upload artifact: %w", err)
	}
	registration.Artifact["uploaded"] = true
	return json.Marshal(registration.Artifact)
}

func openArtifact(workspace, requested string) (*os.File, string, int64, string, error) {
	if requested == "" || filepath.IsAbs(requested) {
		return nil, "", 0, "", errors.New("relativePath must be relative to the run workspace")
	}
	workspacePath, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		return nil, "", 0, "", fmt.Errorf("resolve workspace: %w", err)
	}
	path, err := filepath.EvalSymlinks(filepath.Join(workspacePath, requested))
	if err != nil {
		return nil, "", 0, "", fmt.Errorf("resolve artifact: %w", err)
	}
	relative, err := filepath.Rel(workspacePath, path)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return nil, "", 0, "", errors.New("artifact is outside the run workspace")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, "", 0, "", err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		return nil, "", 0, "", errors.New("artifact must be a regular file")
	}
	if info.Size() > maximumArtifactSize {
		file.Close()
		return nil, "", 0, "", errors.New("artifact must be at most 10 MiB")
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		file.Close()
		return nil, "", 0, "", err
	}
	return file, filepath.ToSlash(relative), info.Size(), hex.EncodeToString(hash.Sum(nil)), nil
}

func writeRPC(writer http.ResponseWriter, response rpcResponse) {
	writer.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(writer).Encode(response)
}

func writeToolError(writer http.ResponseWriter, id json.RawMessage, message string) {
	writeRPC(writer, rpcResponse{JSONRPC: "2.0", ID: id, Result: map[string]any{
		"content": []map[string]string{{"type": "text", "text": message}},
		"isError": true,
	}})
}

func tools(canDelegate bool) []map[string]any {
	result := []map[string]any{
		tool("get_task_context", "Get task context", "Get the durable thread and current task or a related parent or child task, including delegation status and artifacts.", map[string]any{
			"type": "object", "properties": map[string]any{"taskId": map[string]string{"type": "string"}}, "additionalProperties": false,
		}, map[string]any{
			"type": "object", "properties": map[string]any{
				"thread": map[string]any{"type": "object"},
				"task":   map[string]any{"type": "object"}, "delegations": map[string]any{"type": "array"},
				"artifacts": map[string]any{"type": "array"}, "availableAgents": map[string]any{"type": "array"},
				"limits": map[string]any{"type": "object"}, "version": map[string]string{"type": "string"},
			}, "required": []string{"thread", "task", "delegations", "artifacts", "availableAgents", "limits", "version"},
		}, true),
		tool("post_artifact", "Post artifact", "Publish a regular file from the current run workspace. Use a relative path and a stable idempotency key.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"relativePath": map[string]string{"type": "string"}, "title": map[string]string{"type": "string"},
				"kind":      map[string]any{"type": "string", "enum": []string{"patch", "report", "test-results", "log", "image", "other"}},
				"mediaType": map[string]string{"type": "string"}, "summary": map[string]string{"type": "string"},
				"idempotencyKey": map[string]string{"type": "string"},
			},
			"required": []string{"relativePath", "title", "kind", "mediaType", "idempotencyKey"}, "additionalProperties": false,
		}, map[string]any{
			"type": "object", "properties": map[string]any{
				"id": map[string]string{"type": "string"}, "runId": map[string]string{"type": "string"},
				"title": map[string]string{"type": "string"}, "kind": map[string]string{"type": "string"},
				"downloadPath": map[string]string{"type": "string"}, "uploaded": map[string]string{"type": "boolean"},
			}, "required": []string{"id", "runId", "title", "kind", "downloadPath", "uploaded"},
		}, false),
		tool("update_thread", "Update thread", "Refine the current thread title, objective, or summary, or mark it active or completed. Archival is reserved for the operator.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"title": map[string]string{"type": "string"}, "objective": map[string]string{"type": "string"},
				"summary": map[string]string{"type": "string"},
				"status":  map[string]any{"type": "string", "enum": []string{"active", "completed"}},
			},
			"additionalProperties": false, "minProperties": 1,
		}, map[string]any{
			"type": "object", "properties": map[string]any{"thread": map[string]any{"type": "object"}}, "required": []string{"thread"},
		}, false),
	}
	if canDelegate {
		result = append(result, tool("delegate_task", "Delegate task", "Create a bounded child task for another available agent. Use a stable idempotency key and retain the returned task id.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"agentId": map[string]string{"type": "string"}, "task": map[string]string{"type": "string"},
				"artifactIds":    map[string]any{"type": "array", "items": map[string]string{"type": "string"}},
				"idempotencyKey": map[string]string{"type": "string"},
			},
			"required": []string{"agentId", "task", "idempotencyKey"}, "additionalProperties": false,
		}, map[string]any{
			"type": "object", "properties": map[string]any{
				"taskId": map[string]string{"type": "string"}, "status": map[string]string{"type": "string"},
				"agentId": map[string]string{"type": "string"}, "created": map[string]string{"type": "boolean"},
			}, "required": []string{"taskId", "status", "agentId", "created"},
		}, false))
	}
	return result
}

func tool(name, title, description string, inputSchema, outputSchema map[string]any, readOnly bool) map[string]any {
	return map[string]any{
		"name": name, "title": title, "description": description, "inputSchema": inputSchema, "outputSchema": outputSchema,
		"annotations": map[string]bool{"readOnlyHint": readOnly, "destructiveHint": false, "idempotentHint": true},
	}
}
