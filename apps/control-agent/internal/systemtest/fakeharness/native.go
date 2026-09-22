package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Native CLI versions the fake reports from --version; Barista normalizes the dotted number.
const (
	codexNativeVersion  = "codex-cli 0.46.0"
	claudeNativeVersion = "2.0.14 (Claude Code)"
)

// nativeHost emulates a native CLI's JSON event stream on stdout. It has no ACP session, so
// structured updates are dropped and permission requests cannot be raised.
type nativeHost struct {
	role string
	last string
	done chan struct{}
}

func runNative(recorder *recorder, role string, arguments []string) int {
	if len(arguments) == 1 && arguments[0] == "--version" {
		if role == "codex" {
			fmt.Println(codexNativeVersion)
		} else {
			fmt.Println(claudeNativeVersion)
		}
		return 0
	}
	prompt, endpoint, err := nativeInvocation(role, arguments)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fakeharness: %v\n", err)
		return 64
	}
	var client *mcpClient
	if endpoint != "" {
		client, err = newMCPClient(endpoint, os.Getenv("COFFEE_SHOP_MCP_TOKEN"))
		if err != nil {
			fmt.Fprintf(os.Stderr, "fakeharness: %v\n", err)
			return 64
		}
	}
	recorder.write(map[string]any{"event": "native-run", "mcp": client != nil})
	script, err := extractScript(prompt)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fakeharness: %v\n", err)
		return 65
	}
	workingDirectory, _ := os.Getwd()
	host := &nativeHost{role: role, done: make(chan struct{})}
	runErr := newEngine(host, client, prompt, workingDirectory, "").run(context.Background(), script)
	var crashed crash
	if errors.As(runErr, &crashed) {
		return crashed.code
	}
	if runErr != nil {
		fmt.Fprintf(os.Stderr, "fakeharness: %v\n", runErr)
		return 70
	}
	if role == "claude" {
		host.emit(map[string]any{"type": "result", "subtype": "success", "result": host.last})
	}
	return 0
}

// nativeInvocation extracts the prompt and the Coffee Shop MCP endpoint from the exact command
// line Barista builds for each native CLI.
func nativeInvocation(role string, arguments []string) (string, string, error) {
	prompt, endpoint := "", ""
	if role == "codex" {
		if len(arguments) < 2 || arguments[0] != "exec" {
			return "", "", errors.New("expected codex exec")
		}
		prompt = arguments[len(arguments)-1]
		for index := 0; index+1 < len(arguments)-1; index++ {
			if arguments[index] != "-c" {
				continue
			}
			key, value, found := strings.Cut(arguments[index+1], "=")
			if found && key == "mcp_servers.coffee_shop_hub.url" {
				unquoted, err := strconv.Unquote(value)
				if err != nil {
					return "", "", errors.New("the MCP url configuration is not quoted")
				}
				endpoint = unquoted
			}
		}
		return prompt, endpoint, nil
	}
	for index := 0; index+1 < len(arguments); index++ {
		switch arguments[index] {
		case "-p":
			prompt = arguments[index+1]
		case "--mcp-config":
			var configuration struct {
				McpServers map[string]struct {
					URL string `json:"url"`
				} `json:"mcpServers"`
			}
			if err := json.Unmarshal([]byte(arguments[index+1]), &configuration); err != nil {
				return "", "", errors.New("the MCP configuration is not JSON")
			}
			endpoint = configuration.McpServers["coffee_shop_hub"].URL
		}
	}
	if prompt == "" {
		return "", "", errors.New("expected claude -p")
	}
	return prompt, endpoint, nil
}

func (host *nativeHost) emit(event map[string]any) {
	encoded, _ := json.Marshal(event)
	fmt.Println(string(encoded))
}

func (host *nativeHost) message(text string) error {
	host.last = text
	if host.role == "codex" {
		host.emit(map[string]any{"type": "item.completed", "item": map[string]any{"type": "agent_message", "text": text}})
	} else {
		host.emit(map[string]any{"type": "assistant", "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": text}}}})
	}
	return nil
}

func (host *nativeHost) thought(string) error { return nil }

func (host *nativeHost) update(json.RawMessage) error { return nil }

func (host *nativeHost) raw(string) error {
	return errors.New("the native CLI emulation has no ACP stream")
}

func (host *nativeHost) permission(context.Context, map[string]any) (any, error) {
	return nil, errors.New("the native CLI emulation cannot raise ACP permission requests")
}

// cancelled never fires: Barista cancels a native run by terminating its process group.
func (host *nativeHost) cancelled() <-chan struct{} { return host.done }
