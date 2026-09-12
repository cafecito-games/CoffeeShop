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
	"strings"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

const handoffContract = `

You are running inside Coffee Shop. If another specialist should continue a bounded task, end your response with exactly <handoff to="agent-id">task and context</handoff>. Use only an agent id you were given. Handoffs are visible and capped; do not delegate reflexively.`

type Runner struct {
	profiles []protocol.HarnessProfile
}

func NewRunner(profiles []protocol.HarnessProfile) *Runner {
	return &Runner{profiles: profiles}
}

func (r *Runner) Run(ctx context.Context, run protocol.Run, agent protocol.Agent, cwd string, output func(string)) (string, error) {
	profile, available := r.profile(run.HarnessID)
	if !available {
		return "", fmt.Errorf("harness %s is not installed or did not pass its version check", run.HarnessID)
	}
	binary, args, err := commandFor(run, agent)
	if err != nil {
		return "", err
	}
	if profile.Binary != "" {
		binary = profile.Binary
	}
	command := exec.CommandContext(ctx, binary, args...)
	configureProcessCancellation(command)
	command.Dir = cwd
	command.Env = os.Environ()
	stdout, err := command.StdoutPipe()
	if err != nil {
		return "", err
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
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
		return "Run completed without a text response.", nil
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

func commandFor(run protocol.Run, agent protocol.Agent) (string, []string, error) {
	prompt := agent.SystemPrompt + handoffContract + "\n\nAvailable teammate ids may be listed by the control plane.\n\nUser task:\n" + run.Prompt
	switch run.HarnessID {
	case "claude-cli":
		return "claude", []string{"-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "auto", "--permission-prompts", "none", "--model", run.Model}, nil
	case "codex-cli":
		args := []string{"exec", "--json", "--sandbox", "workspace-write"}
		if run.Model != "" && run.Model != "default" {
			args = append(args, "--model", run.Model)
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
