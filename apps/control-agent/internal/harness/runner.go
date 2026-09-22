package harness

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/mcpserver"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

const emptyResponse = "Run completed without a text response."

const coordinationContract = `

You are running inside Coffee Shop. Use the Coffee Shop hub tools for durable thread and task context, task messages, artifacts, and bounded delegation when they are available. Refine the thread title, objective, and summary when that improves the shared record, and mark it completed only when the overall objective is satisfied. Keep returned task and artifact ids. If hub delegation is unavailable and another specialist must continue, end your response with exactly <handoff to="agent-id">task and context</handoff>. Use only an agent id you were given.`

// nativeDriver runs a vendor CLI directly and parses its vendor-specific JSON stream.
type nativeDriver struct {
	runner *Runner
}

func (driver nativeDriver) Execute(ctx context.Context, invocation Invocation) (string, error) {
	run, mcpConfig, output := invocation.Run, invocation.MCP, invocation.Output
	profile, available := driver.runner.profile(run.HarnessID)
	if !available {
		return "", fmt.Errorf("harness %s is not installed or did not pass its version check", run.HarnessID)
	}
	binary, args, err := commandFor(run, invocation.Agent, mcpConfig)
	if err != nil {
		return "", err
	}
	if profile.Binary != "" {
		binary = profile.Binary
	}
	command := exec.CommandContext(ctx, binary, args...)
	configureProcessCancellation(command)
	command.Dir = invocation.Workspace
	command.Env = os.Environ()
	if mcpConfig.URL != "" {
		command.Env = append(command.Env, "COFFEE_SHOP_MCP_TOKEN="+mcpConfig.Token)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return "", err
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	invocation.announce(transportDetails{})
	if err := command.Start(); err != nil {
		return "", err
	}

	final, readErr := readEvents(stdout, run.HarnessID, output)
	waitErr := command.Wait()
	if readErr != nil {
		return "", readErr
	}
	if waitErr != nil {
		if message := strings.TrimSpace(stderr.String()); message != "" {
			return "", errors.New(message)
		}
		return "", waitErr
	}
	if strings.TrimSpace(final) == "" {
		return emptyResponse, nil
	}
	return strings.TrimSpace(final), nil
}

func (r *Runner) profile(id string) (protocol.HarnessProfile, bool) {
	for _, profile := range r.profiles {
		if profile.ID == id && profile.Available {
			return profile, true
		}
	}
	return protocol.HarnessProfile{}, false
}

func composePrompt(run protocol.Run, agent protocol.Agent) string {
	return agent.SystemPrompt + coordinationContract + "\n\nAvailable teammate ids may be listed by the control plane.\n\nUser task:\n" + run.Prompt
}

func commandFor(run protocol.Run, agent protocol.Agent, mcpConfig mcpserver.Config) (string, []string, error) {
	prompt := composePrompt(run, agent)
	switch run.HarnessID {
	case "claude-cli":
		args := []string{"-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "auto", "--permission-prompts", "none", "--model", run.Model}
		if mcpConfig.URL != "" {
			configuration, err := json.Marshal(map[string]any{"mcpServers": map[string]any{"coffee_shop_hub": map[string]any{
				"type": "http", "url": mcpConfig.URL, "headers": map[string]string{"Authorization": "Bearer ${COFFEE_SHOP_MCP_TOKEN}"},
			}}})
			if err != nil {
				return "", nil, err
			}
			allowed := make([]string, 0, len(protocol.HubToolNames))
			for _, name := range mcpserver.ToolNames(mcpConfig.CanDelegate) {
				allowed = append(allowed, "mcp__coffee_shop_hub__"+name)
			}
			args = append(args, "--mcp-config", string(configuration), "--allowedTools", strings.Join(allowed, ","))
		}
		return "claude", args, nil
	case "codex-cli":
		args := []string{"exec", "--json", "--sandbox", "workspace-write"}
		if run.Model != "" && run.Model != "default" {
			args = append(args, "--model", run.Model)
		}
		if mcpConfig.URL != "" {
			args = append(args,
				"-c", "mcp_servers.coffee_shop_hub.url="+strconv.Quote(mcpConfig.URL),
				"-c", `mcp_servers.coffee_shop_hub.bearer_token_env_var="COFFEE_SHOP_MCP_TOKEN"`,
				"-c", "mcp_servers.coffee_shop_hub.required=true",
				"-c", `mcp_servers.coffee_shop_hub.default_tools_approval_mode="approve"`,
			)
		}
		return "codex", append(args, prompt), nil
	default:
		return "", nil, fmt.Errorf("harness %s is not executable by Barista", run.HarnessID)
	}
}

func readEvents(reader io.Reader, harnessID string, output func(string)) (string, error) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	final := ""
	for scanner.Scan() {
		readable := readableEvent(harnessID, scanner.Bytes())
		if readable == "" {
			continue
		}
		final = readable
		output(readable)
	}
	return final, scanner.Err()
}

func readableEvent(harnessID string, line []byte) string {
	var event map[string]any
	if json.Unmarshal(line, &event) != nil {
		return ""
	}
	if harnessID == "claude-cli" {
		if event["type"] == "result" {
			result, _ := event["result"].(string)
			return result
		}
		if event["type"] == "assistant" {
			message, _ := event["message"].(map[string]any)
			content, _ := message["content"].([]any)
			var text strings.Builder
			for _, rawPart := range content {
				part, _ := rawPart.(map[string]any)
				if part["type"] == "text" {
					value, _ := part["text"].(string)
					text.WriteString(value)
				}
			}
			return text.String()
		}
	}
	if harnessID == "codex-cli" && event["type"] == "item.completed" {
		item, _ := event["item"].(map[string]any)
		switch item["type"] {
		case "agent_message":
			text, _ := item["text"].(string)
			return text
		case "command_execution":
			command, _ := item["command"].(string)
			if command == "" {
				command = "command"
			}
			return "Ran " + command + "\n"
		}
	}
	return ""
}
