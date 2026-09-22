package acp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp/acptest"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

func TestOfferedValuesFlattensFlatAndGroupedShapes(t *testing.T) {
	for _, testCase := range []struct {
		name     string
		raw      string
		expected []string
	}{
		{name: "flat list", raw: `[{"value":"read-only"},{"value":"agent"}]`, expected: []string{"read-only", "agent"}},
		{name: "grouped list", raw: `[{"group":"openai","options":[{"value":"gpt-5.5"},{"value":"gpt-5.4"}]}]`, expected: []string{"gpt-5.5", "gpt-5.4"}},
		{name: "mixed list", raw: `[{"value":"read-only"},{"group":"openai","options":[{"value":"gpt-5.5"}]}]`, expected: []string{"read-only", "gpt-5.5"}},
		{name: "malformed json", raw: `{not json`, expected: nil},
		{name: "entries without a value", raw: `[{"name":"Ask for approval"},{"group":"empty"}]`, expected: nil},
		{name: "group with malformed options", raw: `[{"group":"openai","options":"not json"}]`, expected: nil},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			offered := offeredValues(json.RawMessage(testCase.raw))
			require.Len(t, offered, len(testCase.expected))
			for _, value := range testCase.expected {
				require.True(t, offered[value], "expected %q to be offered", value)
			}
		})
	}
}

func TestOfferedValuesBoundsWhatItReads(t *testing.T) {
	entries := make([]string, 0, maximumConfigValues+44)
	for index := range maximumConfigValues + 44 {
		entries = append(entries, fmt.Sprintf(`{"value":"v%d"}`, index))
	}
	offered := offeredValues(json.RawMessage("[" + strings.Join(entries, ",") + "]"))
	require.Len(t, offered, maximumConfigValues)
}

func TestNewConfigStateSkipsUnusableOptions(t *testing.T) {
	options := []sessionConfigOption{
		{ID: "", CurrentValue: json.RawMessage(`"empty"`), Options: json.RawMessage(`[{"value":"empty"}]`)},
		{ID: strings.Repeat("i", eventIdentifierBytes+1), CurrentValue: json.RawMessage(`"oversized"`), Options: json.RawMessage(`[{"value":"oversized"}]`)},
		{ID: "numeric", CurrentValue: json.RawMessage(`7`), Options: json.RawMessage(`[{"value":"7"}]`)},
		{ID: "mode", CurrentValue: json.RawMessage(`"read-only"`), Options: json.RawMessage(`[{"value":"read-only"},{"value":"agent"}]`)},
	}
	state := newConfigState(options)
	require.Len(t, state, 1)
	option, known := state["mode"]
	require.True(t, known)
	require.Equal(t, "read-only", option.current)
	require.True(t, option.offered["agent"])
}

// drainClient closes the adapter's stdin and waits, bounded, for its output to be exhausted.
func drainClient(t *testing.T, client *Client, process *acptest.Process) {
	t.Helper()
	client.Close()
	finished := make(chan struct{})
	go func() {
		client.Wait()
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		_ = process.Command.Process.Kill()
		acptest.KillDescendants(t, process.RecordPath)
		_ = process.Stdout.Close()
		<-finished
	}
}

func TestClientProbeNegotiatesCodexAdapterCapabilities(t *testing.T) {
	process := acptest.Start(t, "codex-probe")
	client := NewClient(process.Stdout, process.Stdin, Options{RequestTimeout: 5 * time.Second})
	_, negotiated := client.Negotiated()
	require.False(t, negotiated)

	capabilities, err := client.Probe(context.Background())
	drainClient(t, client, process)
	require.NoError(t, err)
	require.Equal(t, protocol.AcpAgentCapabilities{
		ProtocolVersion: 1,
		LoadSession:     true,
		ResumeSession:   true,
		Prompt:          protocol.AcpPromptCapabilities{Image: true, EmbeddedContext: true},
		Mcp:             protocol.AcpMcpCapabilities{HTTP: true},
		AdapterName:     "@agentclientprotocol/codex-acp",
		AdapterVersion:  acptest.CodexAdapterVersion,
	}, capabilities)
	require.False(t, client.PromptSent())

	renegotiated, negotiated := client.Negotiated()
	require.True(t, negotiated)
	require.Equal(t, capabilities, renegotiated)
}

func TestClientProbeRejectsAnAdapterAwayFromItsPinnedVersion(t *testing.T) {
	process := acptest.Start(t, "codex-probe")
	client := NewClient(process.Stdout, process.Stdin, Options{
		RequestTimeout:       5 * time.Second,
		ExpectedAgentVersion: "9.9.9",
	})
	_, err := client.Probe(context.Background())
	drainClient(t, client, process)
	require.ErrorIs(t, err, ErrAdapterVersionMismatch)
}

// runConfiguredCodexSession runs the mode-already-set codex scenario, whose Coffee Shop MCP server
// is served by a local HTTP test server, through one supervised client. build receives the fake
// adapter's frame record path so a BeforePrompt hook can inspect what has been sent so far.
func runConfiguredCodexSession(t *testing.T, build func(recordPath string) SessionRequest) (Result, error, *Client, *acptest.Process) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)

	process := acptest.Start(t, "codex-mode-already-set")
	request := build(process.RecordPath)
	if request.MCPServer == nil {
		request.MCPServer = &MCPServer{Name: "coffee_shop_hub", URL: server.URL, BearerToken: "run-scoped-token"}
	}
	client := NewClient(process.Stdout, process.Stdin, Options{
		RunID: "run-configuration", RequestTimeout: 5 * time.Second,
		CancelGracePeriod: time.Second, PermissionTimeout: time.Second,
	})
	result, err := client.Run(context.Background(), request)
	if err != nil {
		_ = process.Command.Process.Kill()
		acptest.KillDescendants(t, process.RecordPath)
	}
	drainClient(t, client, process)
	return result, err, client, process
}

func TestClientAppliesConfigurationBeforeThePrompt(t *testing.T) {
	var beforePromptCount int
	result, err, client, process := runConfiguredCodexSession(t, func(recordPath string) SessionRequest {
		return SessionRequest{
			Cwd:           t.TempDir(),
			Prompt:        "do the work",
			Configuration: []ConfigSelection{{ID: "mode", Value: "read-only", Requirement: ConfigPolicy}},
			BeforePrompt: func(context.Context) error {
				beforePromptCount++
				for _, frame := range acptest.Received(t, recordPath) {
					require.NotEqual(t, "session/prompt", frame["method"], "the prompt was sent before BeforePrompt ran")
				}
				return nil
			},
		}
	})
	require.NoError(t, err)
	require.Equal(t, "codex done", result.Text)
	require.True(t, client.PromptSent())
	require.Equal(t, 1, beforePromptCount)
	require.Nil(t, acptest.ReceivedMethod(t, process.RecordPath, "session/set_config_option"))
	require.NotNil(t, acptest.ReceivedMethod(t, process.RecordPath, "session/prompt"))
}

func TestClientBeforePromptErrorEndsTheRunBeforeThePrompt(t *testing.T) {
	errStopBeforePrompt := errors.New("stop before the prompt")
	result, err, client, process := runConfiguredCodexSession(t, func(recordPath string) SessionRequest {
		return SessionRequest{
			Cwd:    t.TempDir(),
			Prompt: "do the work",
			BeforePrompt: func(context.Context) error {
				return errStopBeforePrompt
			},
		}
	})
	require.ErrorIs(t, err, errStopBeforePrompt)
	require.Empty(t, result.Text)
	require.False(t, client.PromptSent())
	require.Nil(t, acptest.ReceivedMethod(t, process.RecordPath, "session/prompt"))
}

func TestNegotiatedCapabilitiesSanitizesAdapterIdentity(t *testing.T) {
	secretLike := negotiatedCapabilities(initializeResponse{AgentInfo: &implementation{
		Name: "sk-abcdefghijklmnop1234", Version: "1.2.3",
	}})
	require.Empty(t, secretLike.AdapterName)
	require.Equal(t, "1.2.3", secretLike.AdapterVersion)

	longName := strings.Repeat("a", protocol.ACPAdapterNameMaximumBytes+50)
	truncated := negotiatedCapabilities(initializeResponse{AgentInfo: &implementation{
		Name: longName, Version: "1.2.3",
	}})
	require.Len(t, truncated.AdapterName, protocol.ACPAdapterNameMaximumBytes)
	require.Equal(t, longName[:protocol.ACPAdapterNameMaximumBytes], truncated.AdapterName)

	unnormalized := negotiatedCapabilities(initializeResponse{AgentInfo: &implementation{
		Name: "codex-acp", Version: "1.2.3-beta",
	}})
	require.Empty(t, unnormalized.AdapterVersion)
}
