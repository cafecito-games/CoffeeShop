package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync/atomic"
	"time"
)

// mcpClient speaks the subset of MCP Streamable HTTP that a harness uses against Barista's
// run-scoped Coffee Shop server: initialize, tools/list, and tools/call with the offered bearer.
type mcpClient struct {
	endpoint string
	token    string
	client   *http.Client
	nextID   atomic.Int64
}

// errNoMCP reports a script tool call in a run that was offered no Coffee Shop MCP server.
var errNoMCP = errors.New("no Coffee Shop MCP server was offered to this run")

func newMCPClient(endpoint, token string) (*mcpClient, error) {
	if endpoint == "" {
		return nil, errNoMCP
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || (parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost" && parsed.Hostname() != "::1") {
		// The fake never contacts anything but loopback; a non-loopback endpoint fails the run.
		return nil, errors.New("the offered MCP endpoint is not a loopback URL")
	}
	return &mcpClient{endpoint: endpoint, token: token, client: &http.Client{Timeout: 45 * time.Second}}, nil
}

type rpcEnvelope struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (client *mcpClient) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": client.nextID.Add(1), "method": method, "params": params})
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, client.endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+client.token)
	request.Header.Set("Content-Type", "application/json")
	response, err := client.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("MCP %s: %w", method, err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("MCP %s returned HTTP %d", method, response.StatusCode)
	}
	var envelope rpcEnvelope
	if err := json.Unmarshal(data, &envelope); err != nil {
		return nil, fmt.Errorf("MCP %s returned an undecodable response", method)
	}
	if envelope.Error != nil {
		return nil, fmt.Errorf("MCP %s failed with code %d", method, envelope.Error.Code)
	}
	return envelope.Result, nil
}

// connect performs the handshake an MCP HTTP client performs when a session starts; Barista holds
// the prompt until tools/list has been answered.
func (client *mcpClient) connect(ctx context.Context) error {
	if _, err := client.call(ctx, "initialize", map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "clientInfo": map[string]string{"name": "fakeharness", "version": "1"}}); err != nil {
		return err
	}
	_, err := client.call(ctx, "tools/list", map[string]any{})
	return err
}

// toolResult is a tool call's outcome: the structured result, or the typed tool error.
type toolResult struct {
	Value   any
	IsError bool
}

func (client *mcpClient) tool(ctx context.Context, name string, arguments any) (toolResult, error) {
	raw, err := client.call(ctx, "tools/call", map[string]any{"name": name, "arguments": arguments})
	if err != nil {
		return toolResult{}, err
	}
	var result struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
		StructuredContent json.RawMessage `json:"structuredContent"`
		IsError           bool            `json:"isError"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return toolResult{}, fmt.Errorf("tool %s returned an undecodable result", name)
	}
	text := result.StructuredContent
	if len(text) == 0 && len(result.Content) > 0 {
		text = json.RawMessage(result.Content[0].Text)
	}
	var value any
	if len(text) > 0 {
		if err := json.Unmarshal(text, &value); err != nil {
			return toolResult{}, fmt.Errorf("tool %s returned undecodable content", name)
		}
	}
	return toolResult{Value: value, IsError: result.IsError}, nil
}
