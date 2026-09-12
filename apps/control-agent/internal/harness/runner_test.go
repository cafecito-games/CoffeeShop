package harness

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

func TestReadableClaudeResult(t *testing.T) {
	line := []byte(`{"type":"result","result":"finished"}`)
	require.Equal(t, "finished", readableEvent("claude-cli", line))
}

func TestReadableCodexAgentMessage(t *testing.T) {
	line := []byte(`{"type":"item.completed","item":{"type":"agent_message","text":"done"}}`)
	require.Equal(t, "done", readableEvent("codex-cli", line))
}

func TestRunnerExecutesDiscoveredBinaryAndNormalizesOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test fixture is a shell script")
	}
	directory := t.TempDir()
	binary := filepath.Join(directory, "fake-codex")
	require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\nprintf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"fake result\"}}'\n"), 0o755))
	t.Setenv("PATH", "")

	runner := NewRunner([]protocol.HarnessProfile{{ID: "codex-cli", Binary: binary, Available: true}})
	chunks := []string{}
	result, err := runner.Run(
		context.Background(),
		protocol.Run{ID: "run-1", HarnessID: "codex-cli", Model: "default", Prompt: "test"},
		protocol.Agent{ID: "agent-1", SystemPrompt: "Test agent"},
		directory,
		func(chunk string) { chunks = append(chunks, chunk) },
	)

	require.NoError(t, err)
	require.Equal(t, "fake result", result)
	require.Equal(t, []string{"fake result"}, chunks)
}
