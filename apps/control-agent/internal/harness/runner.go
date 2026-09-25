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
	"regexp"
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
	binary, args, err := commandFor(run, invocation.Agent, mcpConfig, invocation.approvalPolicy)
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

	final, readErr := readEvents(stdout, run.HarnessID, output, invocation.ProviderSession)
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

// profile returns the harness's natively discovered profile. Only a harness whose native CLI was
// found and passed its version check is available, which is what native execution, native
// fallback, and harness-version reporting require.
func (r *Runner) profile(id string) (protocol.HarnessProfile, bool) {
	for _, profile := range r.nativeProfiles {
		if profile.ID == id && profile.Available {
			return profile, true
		}
	}
	return protocol.HarnessProfile{}, false
}

// advertisedProfile returns the harness's profile as this node advertises it to the hub, which
// admission reads. A harness installed only through ACP is available here even though profile
// refuses it; without an advertised set the native profiles are the advertisement.
func (r *Runner) advertisedProfile(id string) (protocol.HarnessProfile, bool) {
	advertised := r.advertisedProfiles
	if advertised == nil {
		advertised = r.nativeProfiles
	}
	for _, profile := range advertised {
		if profile.ID == id && profile.Available {
			return profile, true
		}
	}
	return protocol.HarnessProfile{}, false
}

func composePrompt(run protocol.Run, agent protocol.Agent) string {
	return agent.SystemPrompt + coordinationContract + "\n\nAvailable teammate ids may be listed by the control plane.\n\nUser task:\n" + run.Prompt
}

// nativeClaudePermissionMode maps an approval policy onto the native Claude CLI's permission mode.
// The native CLI never prompts: under manual and auto, "auto" lets Claude's classifier approve
// routine actions and denies anything that would prompt; only bypass approves everything.
func nativeClaudePermissionMode(approvalPolicy string) string {
	if approvalPolicy == protocol.ApprovalPolicyBypass {
		return "bypassPermissions"
	}
	return "auto"
}

// nativeCodexSandboxArguments maps an approval policy onto the native Codex CLI's sandbox. `codex
// exec` never prompts: under manual and auto it runs in the workspace-write sandbox; only bypass
// removes both the sandbox and approvals.
func nativeCodexSandboxArguments(approvalPolicy string) []string {
	if approvalPolicy == protocol.ApprovalPolicyBypass {
		return []string{"--dangerously-bypass-approvals-and-sandbox"}
	}
	return []string{"--sandbox", "workspace-write"}
}

func commandFor(run protocol.Run, agent protocol.Agent, mcpConfig mcpserver.Config, approvalPolicy string) (string, []string, error) {
	prompt := composePrompt(run, agent)
	switch run.HarnessID {
	case "claude-cli":
		args := []string{"-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", nativeClaudePermissionMode(approvalPolicy), "--permission-prompts", "none", "--model", run.Model}
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
		args := append([]string{"exec", "--json"}, nativeCodexSandboxArguments(approvalPolicy)...)
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

func readEvents(reader io.Reader, harnessID string, output func(string), session func(string)) (string, error) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	final := ""
	sessionReported := false
	for scanner.Scan() {
		if !sessionReported && session != nil {
			if identity := providerSessionIdentity(harnessID, scanner.Bytes()); identity != "" {
				sessionReported = true
				session(identity)
			}
		}
		readable := readableEvent(harnessID, scanner.Bytes())
		if readable == "" {
			continue
		}
		final = readable
		output(readable)
	}
	return final, scanner.Err()
}

var providerSessionPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

// providerSessionIdentity extracts the vendor's session identity from one stream line: Claude
// stamps session_id on its events, and Codex opens its stream with thread.started.
func providerSessionIdentity(harnessID string, line []byte) string {
	var event struct {
		Type      string `json:"type"`
		SessionID string `json:"session_id"`
		ThreadID  string `json:"thread_id"`
	}
	if json.Unmarshal(line, &event) != nil {
		return ""
	}
	identity := ""
	switch harnessID {
	case "claude-cli":
		identity = event.SessionID
	case "codex-cli":
		if event.Type == "thread.started" {
			identity = event.ThreadID
		}
	}
	if !providerSessionPattern.MatchString(identity) {
		return ""
	}
	return identity
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
