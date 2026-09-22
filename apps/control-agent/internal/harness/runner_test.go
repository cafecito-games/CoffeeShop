package harness

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/mcpserver"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

func TestReadableClaudeResult(t *testing.T) {
	line := []byte(`{"type":"result","result":"finished"}`)
	require.Equal(t, "finished", readableEvent("claude-cli", line))
}

func TestRunnerCancellationTerminatesDescendantProcessTree(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test fixture is a shell script")
	}
	directory := t.TempDir()
	binary := filepath.Join(directory, "fake-codex-tree")
	script := "#!/bin/sh\nsh -c 'trap \"\" HUP TERM INT; sleep 30' &\nchild=$!\nprintf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"started\"}}'\nwait \"$child\"\n"
	require.NoError(t, os.WriteFile(binary, []byte(script), 0o755))
	runner := NewRunner([]protocol.HarnessProfile{{ID: "codex-cli", Binary: binary, Available: true}})
	ctx, cancel := context.WithCancel(context.Background())
	started := make(chan struct{}, 1)
	finished := make(chan error, 1)
	go func() {
		_, err := runner.Run(ctx, protocol.Run{ID: "run-tree", HarnessID: "codex-cli", Workspace: directory}, protocol.Agent{}, directory, mcpserver.Config{}, func(string) {
			started <- struct{}{}
		})
		finished <- err
	}()

	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("descendant fixture did not start")
	}
	cancel()
	select {
	case err := <-finished:
		require.Error(t, err)
	case <-time.After(3 * time.Second):
		t.Fatal("cancellation did not terminate the descendant process tree")
	}
}

func TestProviderSessionIdentityReadsEachVendorStream(t *testing.T) {
	require.Equal(t, "3b729b65-f2e4-48c7-bc3b-0302a7ea1c34", providerSessionIdentity("claude-cli", []byte(`{"type":"system","subtype":"init","session_id":"3b729b65-f2e4-48c7-bc3b-0302a7ea1c34"}`)))
	require.Equal(t, "01a0c881-6c5c-7b42-a6ca-cb1fa772c4e7", providerSessionIdentity("codex-cli", []byte(`{"type":"thread.started","thread_id":"01a0c881-6c5c-7b42-a6ca-cb1fa772c4e7"}`)))
	require.Empty(t, providerSessionIdentity("codex-cli", []byte(`{"type":"turn.started","thread_id":"01a0c881"}`)))
	require.Empty(t, providerSessionIdentity("claude-cli", []byte(`{"type":"system","session_id":"id; rm -rf /"}`)))
	require.Empty(t, providerSessionIdentity("claude-cli", []byte(`not json`)))
}

func TestReadEventsReportsProviderSessionOnce(t *testing.T) {
	stream := strings.Join([]string{
		`{"type":"system","subtype":"init","session_id":"session-one"}`,
		`{"type":"assistant","session_id":"session-one","message":{"content":[{"type":"text","text":"working"}]}}`,
		`{"type":"result","session_id":"session-one","result":"done"}`,
	}, "\n")
	var sessions []string
	final, err := readEvents(strings.NewReader(stream), "claude-cli", func(string) {}, func(identity string) { sessions = append(sessions, identity) })
	require.NoError(t, err)
	require.Equal(t, "done", final)
	require.Equal(t, []string{"session-one"}, sessions)
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
		mcpserver.Config{},
		func(chunk string) { chunks = append(chunks, chunk) },
	)

	require.NoError(t, err)
	require.Equal(t, "fake result", result)
	require.Equal(t, []string{"fake result"}, chunks)
}

func TestClaudeWorkersAreNotAllowedDelegationTools(t *testing.T) {
	_, args, err := commandFor(protocol.Run{HarnessID: "claude-cli", Model: "default", Prompt: "test"}, protocol.Agent{}, mcpserver.Config{URL: "http://127.0.0.1:1234/mcp", Token: "worker"}, protocol.ApprovalPolicyManual)
	require.NoError(t, err)
	joined := strings.Join(args, " ")
	require.Contains(t, joined, "mcp__coffee_shop_hub__send_task_message")
	for _, name := range protocol.DelegationHubToolNames {
		require.NotContains(t, joined, "mcp__coffee_shop_hub__"+name)
	}
}

func TestHarnessCommandsInjectRunScopedMCPWithoutPuttingTokenInArguments(t *testing.T) {
	configuration := mcpserver.Config{URL: "http://127.0.0.1:1234/mcp", Token: "do-not-leak", CanDelegate: true}
	for _, harnessID := range []string{"claude-cli", "codex-cli"} {
		_, args, err := commandFor(protocol.Run{HarnessID: harnessID, Model: "default", Prompt: "test"}, protocol.Agent{}, configuration, protocol.ApprovalPolicyManual)
		require.NoError(t, err)
		joined := strings.Join(args, " ")
		require.Contains(t, joined, "coffee_shop_hub")
		if harnessID == "claude-cli" {
			require.Contains(t, joined, "mcp__coffee_shop_hub__update_thread")
			require.Contains(t, joined, "mcp__coffee_shop_hub__wait_for_task_events")
			require.Contains(t, joined, "mcp__coffee_shop_hub__submit_tasks")
		}
		require.Contains(t, joined, "COFFEE_SHOP_MCP_TOKEN")
		require.NotContains(t, joined, configuration.Token)
	}
}
