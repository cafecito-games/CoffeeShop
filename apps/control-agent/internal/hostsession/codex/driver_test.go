package codex

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/hostsession"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

type testWriteCloser struct{ *bytes.Buffer }

func (testWriteCloser) Close() error { return nil }

func TestOutboundFrameAtTheTwoMiBBoundaryIsRejected(t *testing.T) {
	var destination bytes.Buffer
	connection := &client{stdin: testWriteCloser{&destination}, pending: make(map[int64]chan rpcResult), done: make(chan struct{})}
	require.Error(t, connection.write(strings.Repeat("a", maxOutboundFrameBytes-2)))
	require.Empty(t, destination.Bytes())
	require.NoError(t, connection.write(strings.Repeat("a", maxOutboundFrameBytes-3)))
	require.Len(t, destination.Bytes(), maxOutboundFrameBytes)
}

func TestDriverDiscoversBoundedAuthorizedThreadsAndReadsHistory(t *testing.T) {
	workspace := t.TempDir()
	driver := newFakeAppServerDriver(t, workspace)
	defer driver.Shutdown()

	page, err := driver.Discover(context.Background(), hostsession.DiscoverRequest{Limit: 8})
	require.NoError(t, err)
	require.Len(t, page.Sessions, 2)
	require.Equal(t, "resume", page.Sessions[0].ControlMode)
	require.Equal(t, []string{"attach", "close", "read-history"}, page.Sessions[0].Operations)
	require.Equal(t, "observe", page.Sessions[1].ControlMode)
	require.Equal(t, []string{"read-history"}, page.Sessions[1].Operations)

	bounded, err := driver.Discover(context.Background(), hostsession.DiscoverRequest{Limit: 1})
	require.NoError(t, err)
	require.Len(t, bounded.Sessions, 1)
	require.False(t, bounded.Truncated)
	require.Empty(t, bounded.NextCursor)

	history, err := driver.ReadHistory(context.Background(), hostsession.ReadHistoryRequest{Session: page.Sessions[0], Limit: 10})
	require.NoError(t, err)
	require.Len(t, history.Items, 2)
	require.Equal(t, "assistant", history.Items[0].Kind)
	require.Equal(t, "user", history.Items[1].Kind)
	require.NotContains(t, fmt.Sprintf("%+v", history), "SECRET_RAW_PAYLOAD")
}

func TestPinnedContractFixtureAndWritableVersionEligibility(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "protocol-0.147.0.json"))
	require.NoError(t, err)
	var fixture struct {
		Version              string   `json:"version"`
		Tag                  string   `json:"tag"`
		Commit               string   `json:"commit"`
		Transport            string   `json:"transport"`
		ClientMethods        []string `json:"clientMethods"`
		ServerRequests       []string `json:"serverRequests"`
		HistoryModes         []string `json:"historyModes"`
		WritableHistoryMode  string   `json:"writableHistoryMode"`
		ActiveWriterConflict struct {
			Code            int    `json:"code"`
			MessageTemplate string `json:"messageTemplate"`
		} `json:"activeWriterError"`
	}
	require.NoError(t, json.Unmarshal(data, &fixture))
	require.Equal(t, SupportedVersion, fixture.Version)
	require.Equal(t, "rust-v0.147.0", fixture.Tag)
	require.Equal(t, "be6e8eac029b183056b7e4402879f15d2c85f61b", fixture.Commit)
	require.Equal(t, "stdio-jsonl", fixture.Transport)
	require.Equal(t, []string{"initialize", "thread/list", "thread/read", "thread/items/list", "thread/start", "thread/resume", "turn/start", "turn/steer", "turn/interrupt"}, fixture.ClientMethods)
	require.Equal(t, []string{"item/commandExecution/requestApproval", "item/fileChange/requestApproval"}, fixture.ServerRequests)
	require.Equal(t, []string{"legacy", "paginated"}, fixture.HistoryModes)
	require.Equal(t, "paginated", fixture.WritableHistoryMode)
	require.Equal(t, -32600, fixture.ActiveWriterConflict.Code)

	workspace := t.TempDir()
	t.Setenv("FAKE_CODEX_THREAD_VERSION", "0.146.0")
	driver := newFakeAppServerDriver(t, workspace)
	defer driver.Shutdown()
	page, err := driver.Discover(context.Background(), hostsession.DiscoverRequest{Limit: 8})
	require.NoError(t, err)
	require.Len(t, page.Sessions, 2)
	for _, session := range page.Sessions {
		require.Equal(t, "observe", session.ControlMode)
		require.Equal(t, []string{"read-history"}, session.Operations)
	}
	_, err = driver.Adopt(context.Background(), hostsession.SessionRequest{
		ProviderSessionID: page.Sessions[0].ProviderSessionID, Workspace: page.Sessions[0].Workspace,
		Source: page.Sessions[0].Source, ControlMode: page.Sessions[0].ControlMode,
		Operations: page.Sessions[0].Operations,
	})
	var rejection hostsession.DriverRejection
	require.ErrorAs(t, err, &rejection)
	require.Equal(t, "unsupported-history-mode", rejection.Code)
}

func TestAdoptionClassifiesOnlyThePinnedWriterConflict(t *testing.T) {
	workspace := t.TempDir()
	request := hostsession.SessionRequest{ProviderSessionID: "thread-one", Workspace: workspace, Source: "provider-history", ControlMode: "resume", Summary: "Existing thread"}

	t.Setenv("FAKE_CODEX_RESUME", "writer-conflict")
	driver := newFakeAppServerDriver(t, workspace)
	_, err := driver.Adopt(context.Background(), request)
	var rejection hostsession.DriverRejection
	require.ErrorAs(t, err, &rejection)
	require.Equal(t, "active-elsewhere", rejection.Code)
	require.NotNil(t, rejection.Observation)
	require.Equal(t, "Existing thread", rejection.Observation.Summary)
	driver.Shutdown()

	t.Setenv("FAKE_CODEX_RESUME", "other-invalid-request")
	driver = newFakeAppServerDriver(t, workspace)
	_, err = driver.Adopt(context.Background(), request)
	require.ErrorAs(t, err, &rejection)
	require.Equal(t, "adoption-failed", rejection.Code)
	driver.Shutdown()
}

func TestAdoptionNeverContendsWithThisDriversExistingWriter(t *testing.T) {
	workspace := t.TempDir()
	driver := newFakeAppServerDriver(t, workspace)
	defer driver.Shutdown()
	created, err := driver.Create(context.Background(), hostsession.SessionRequest{Workspace: workspace, Source: "coffee-shop-managed"})
	require.NoError(t, err)
	_, err = driver.Adopt(context.Background(), hostsession.SessionRequest{
		ProviderSessionID: created.ProviderSessionID, Workspace: workspace, Source: created.Source, ControlMode: "resume",
	})
	var rejection hostsession.DriverRejection
	require.ErrorAs(t, err, &rejection)
	require.Equal(t, "active-elsewhere", rejection.Code)
	require.Nil(t, rejection.Observation)
	require.NotNil(t, driver.lookupLive(created.ProviderSessionID))
}

func TestDriverRequiresTheSetupPinnedVersionAndCanonicalWorkspace(t *testing.T) {
	binary := fakeAppServerBinary(t)
	_, err := New(context.Background(), Config{Binary: binary, Version: "0.146.0", Verify: func() error { return nil }, WorkspaceRoots: []string{t.TempDir()}})
	require.ErrorContains(t, err, "codex-protocol-incompatible")

	workspace := t.TempDir()
	t.Setenv("FAKE_CODEX_WORKSPACE", filepath.Join(workspace, "missing"))
	driver, err := New(context.Background(), Config{Binary: binary, Version: SupportedVersion, Verify: func() error { return nil }, WorkspaceRoots: []string{workspace}})
	require.NoError(t, err)
	defer driver.Shutdown()
	page, err := driver.Discover(context.Background(), hostsession.DiscoverRequest{Limit: 8})
	require.NoError(t, err)
	require.Empty(t, page.Sessions)
}

func TestProtocolSkewAndPaginationFailClosed(t *testing.T) {
	workspace := t.TempDir()
	for _, mode := range []string{"oversize-initialize", "unknown-response"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("FAKE_CODEX_MODE", mode)
			_, err := New(context.Background(), Config{Binary: fakeAppServerBinary(t), Version: SupportedVersion, Verify: func() error { return nil }, WorkspaceRoots: []string{workspace}})
			require.ErrorContains(t, err, "codex-protocol-incompatible")
		})
	}

	t.Setenv("FAKE_CODEX_MODE", "large-initialize")
	largeDriver, err := New(context.Background(), Config{Binary: fakeAppServerBinary(t), Version: SupportedVersion, Verify: func() error { return nil }, WorkspaceRoots: []string{workspace}})
	require.NoError(t, err)
	largeDriver.Shutdown()

	t.Setenv("FAKE_CODEX_MODE", "repeat-cursor")
	driver := newFakeAppServerDriver(t, workspace)
	_, err = driver.Discover(context.Background(), hostsession.DiscoverRequest{Limit: 8})
	require.ErrorContains(t, err, "pagination")
	driver.Shutdown()

	t.Setenv("FAKE_CODEX_MODE", "resume-mismatch")
	driver = newFakeAppServerDriver(t, workspace)
	_, err = driver.Adopt(context.Background(), hostsession.SessionRequest{ProviderSessionID: "thread-one", Workspace: workspace, Source: "provider-history", ControlMode: "resume"})
	var rejection hostsession.DriverRejection
	require.ErrorAs(t, err, &rejection)
	require.Equal(t, "adoption-failed", rejection.Code)
	driver.Shutdown()
}

func TestHistoryUsesBoundedProviderItemPages(t *testing.T) {
	workspace := t.TempDir()
	t.Setenv("FAKE_CODEX_MODE", "large-history")
	driver := newFakeAppServerDriver(t, workspace)
	defer driver.Shutdown()
	page, err := driver.Discover(context.Background(), hostsession.DiscoverRequest{Limit: 8})
	require.NoError(t, err)
	require.NotEmpty(t, page.Sessions)
	first, err := driver.ReadHistory(context.Background(), hostsession.ReadHistoryRequest{Session: page.Sessions[0], Limit: 1})
	require.NoError(t, err)
	require.Len(t, first.Items, 1)
	require.Equal(t, "assistant", first.Items[0].Kind)
	require.NotEmpty(t, first.NextCursor)
	require.True(t, first.Truncated)
	second, err := driver.ReadHistory(context.Background(), hostsession.ReadHistoryRequest{Session: page.Sessions[0], Limit: 1, Cursor: first.NextCursor})
	require.NoError(t, err)
	require.Len(t, second.Items, 1)
	require.Equal(t, "user", second.Items[0].Kind)
	require.Empty(t, second.NextCursor)
	require.False(t, second.Truncated)
}

func TestManagedThreadKeepsOneConnectionAcrossThreeTurns(t *testing.T) {
	workspace := t.TempDir()
	driver := newFakeAppServerDriver(t, workspace)
	defer driver.Shutdown()
	created, err := driver.Create(context.Background(), hostsession.SessionRequest{Workspace: workspace, Source: "coffee-shop-managed"})
	require.NoError(t, err)
	require.Equal(t, "full", created.ControlMode)
	for turn := 0; turn < 3; turn++ {
		activated := make(chan struct{})
		close(activated)
		started, startErr := driver.StartTurn(context.Background(), hostsession.SessionRequest{
			ProviderSessionID: created.ProviderSessionID, Source: created.Source, RunID: fmt.Sprintf("run-%d", turn),
			Prompt: "bounded", Activated: activated, Emit: func(event protocol.HarnessEvent) error { return nil },
			Observe: func(observation hostsession.DriverSession) error { return nil },
		})
		require.NoError(t, startErr)
		require.Equal(t, "turn-created", started.ProviderTurnID)
		_, interruptErr := driver.Interrupt(context.Background(), hostsession.SessionRequest{
			ProviderSessionID: created.ProviderSessionID, ProviderTurnID: started.ProviderTurnID, Source: created.Source,
		})
		require.NoError(t, interruptErr)
	}
	closed, err := driver.Close(context.Background(), hostsession.SessionRequest{ProviderSessionID: created.ProviderSessionID, Workspace: workspace, Source: created.Source, Summary: created.Summary})
	require.NoError(t, err)
	require.Equal(t, "closed", closed.Status)
	require.Equal(t, created.Summary, closed.Summary)
}

func TestDetachPreservesProviderSummary(t *testing.T) {
	workspace := t.TempDir()
	driver := newFakeAppServerDriver(t, workspace)
	defer driver.Shutdown()
	created, err := driver.Create(context.Background(), hostsession.SessionRequest{Workspace: workspace, Source: "coffee-shop-managed"})
	require.NoError(t, err)
	detached, err := driver.Detach(context.Background(), hostsession.SessionRequest{
		ProviderSessionID: created.ProviderSessionID, Workspace: workspace, Source: created.Source,
		Status: created.Status, ControlMode: created.ControlMode, Operations: created.Operations, Summary: created.Summary,
	})
	require.NoError(t, err)
	require.Equal(t, created.Summary, detached.Summary)
}

func TestManagedThreadsEnforceConfiguredApprovalAndSandboxPolicy(t *testing.T) {
	for _, policy := range []string{protocol.ApprovalPolicyManual, protocol.ApprovalPolicyAuto, protocol.ApprovalPolicyBypass} {
		t.Run(policy, func(t *testing.T) {
			workspace := t.TempDir()
			driver := newFakeAppServerDriverWithPolicy(t, workspace, policy)
			defer driver.Shutdown()
			created, err := driver.Create(context.Background(), hostsession.SessionRequest{Workspace: workspace, Source: "coffee-shop-managed"})
			require.NoError(t, err)
			activated := make(chan struct{})
			close(activated)
			started, err := driver.StartTurn(context.Background(), hostsession.SessionRequest{
				ProviderSessionID: created.ProviderSessionID, Source: created.Source, RunID: "run-policy",
				Prompt: "bounded", Activated: activated, Emit: func(protocol.HarnessEvent) error { return nil },
				Observe: func(hostsession.DriverSession) error { return nil },
			})
			require.NoError(t, err)
			_, err = driver.Interrupt(context.Background(), hostsession.SessionRequest{
				ProviderSessionID: created.ProviderSessionID, ProviderTurnID: started.ProviderTurnID, Source: created.Source,
			})
			require.NoError(t, err)
		})
	}
}

func TestManagedThreadRejectsPolicyResponseSkew(t *testing.T) {
	workspace := t.TempDir()
	t.Setenv("FAKE_CODEX_MODE", "policy-mismatch")
	driver := newFakeAppServerDriver(t, workspace)
	defer driver.Shutdown()
	_, err := driver.Create(context.Background(), hostsession.SessionRequest{Workspace: workspace, Source: "coffee-shop-managed"})
	require.ErrorContains(t, err, "codex-protocol-incompatible")
}

func TestLostTurnStartResponseBlocksEveryLaterWriteUntilRestartReconciliation(t *testing.T) {
	workspace := t.TempDir()
	logPath := filepath.Join(t.TempDir(), "rpc.log")
	t.Setenv("FAKE_CODEX_MODE", "turn-start-response-lost")
	t.Setenv("FAKE_CODEX_RPC_LOG", logPath)
	driver := newFakeAppServerDriver(t, workspace)
	defer driver.Shutdown()
	created, err := driver.Create(context.Background(), hostsession.SessionRequest{Workspace: workspace, Source: "coffee-shop-managed"})
	require.NoError(t, err)
	request := hostsession.SessionRequest{
		ProviderSessionID: created.ProviderSessionID, Source: created.Source, RunID: "run-lost",
		Prompt: "bounded", Activated: make(chan struct{}), Emit: func(protocol.HarnessEvent) error { return nil },
		Observe: func(hostsession.DriverSession) error { return nil },
	}
	_, err = driver.StartTurn(context.Background(), request)
	require.ErrorContains(t, err, "turn-start-failed")
	_, err = driver.StartTurn(context.Background(), request)
	require.ErrorContains(t, err, "uncertain")
	refreshed, err := driver.Refresh(context.Background(), hostsession.SessionRequest{ProviderSessionID: created.ProviderSessionID, Source: created.Source})
	require.NoError(t, err)
	require.Equal(t, "active-elsewhere", refreshed.Status)
	require.Equal(t, "observe", refreshed.ControlMode)
	logBytes, err := os.ReadFile(logPath)
	require.NoError(t, err)
	require.Equal(t, 1, strings.Count(string(logBytes), "turn/start\n"))
}

func TestNormalizedPinnedEventsAreBoundedAndUnknownShapesFailClosed(t *testing.T) {
	tests := []struct {
		method string
		raw    string
		kind   string
	}{
		{"item/agentMessage/delta", `{"delta":"answer"}`, "message.delta"},
		{"item/reasoning/summaryTextDelta", `{"delta":"thinking"}`, "thought.delta"},
		{"item/commandExecution/outputDelta", `{"itemId":"tool-one","delta":"output","stream":"stderr"}`, "terminal.output"},
		{"turn/diff/updated", `{"turnId":"turn-one","diff":"patch"}`, "diff"},
		{"turn/plan/updated", `{"plan":[{"step":"work","status":"inProgress"}]}`, "plan.updated"},
		{"thread/tokenUsage/updated", `{"tokenUsage":{"total":{"inputTokens":2,"outputTokens":3,"cachedInputTokens":1}}}`, "usage"},
		{"item/started", `{"item":{"id":"tool-one","type":"commandExecution","status":"inProgress"}}`, "tool.call"},
		{"item/completed", `{"item":{"id":"tool-one","type":"commandExecution","status":"completed"}}`, "tool.call"},
	}
	for _, test := range tests {
		event, ok := normalizedEvent(test.method, json.RawMessage(test.raw))
		require.True(t, ok, test.method)
		require.Equal(t, test.kind, event.Type)
	}
	_, ok := normalizedEvent("item/agentMessage/delta", json.RawMessage(`{"delta":`))
	require.False(t, ok)
	_, ok = normalizedEvent("provider/unknown", json.RawMessage(`{"secret":"SECRET_RAW_PAYLOAD"}`))
	require.False(t, ok)
}

func TestProviderEventsRemainFIFOAndCompletionCannotOvertakeDeltas(t *testing.T) {
	workspace := t.TempDir()
	t.Setenv("FAKE_CODEX_MODE", "ordered-events")
	t.Setenv("FAKE_CODEX_THREAD_NAME", "Named thread")
	driver := newFakeAppServerDriver(t, workspace)
	defer driver.Shutdown()
	created, err := driver.Create(context.Background(), hostsession.SessionRequest{Workspace: workspace, Source: "coffee-shop-managed"})
	require.NoError(t, err)
	activated := make(chan struct{})
	var mu sync.Mutex
	texts := []string{}
	completed := make(chan hostsession.DriverSession, 1)
	_, err = driver.StartTurn(context.Background(), hostsession.SessionRequest{
		ProviderSessionID: created.ProviderSessionID, Source: created.Source, RunID: "run-ordered",
		Prompt: "bounded", Activated: activated,
		Emit: func(event protocol.HarnessEvent) error {
			mu.Lock()
			texts = append(texts, event.Text)
			mu.Unlock()
			return nil
		},
		Observe: func(observation hostsession.DriverSession) error {
			if observation.Status == "idle" {
				completed <- observation
			}
			return nil
		},
	})
	require.NoError(t, err)
	close(activated)
	select {
	case observation := <-completed:
		require.Equal(t, "Named thread", observation.Summary)
	case <-time.After(time.Second):
		t.Fatal("turn completion was not observed")
	}
	mu.Lock()
	require.Equal(t, []string{"first", "second"}, texts)
	mu.Unlock()
}

func TestUnexpectedAppServerExitMarksLiveSessionUncertain(t *testing.T) {
	workspace := t.TempDir()
	t.Setenv("FAKE_CODEX_MODE", "exit-after-turn-start")
	driver := newFakeAppServerDriverWithPolicy(t, workspace, protocol.ApprovalPolicyManual)
	defer driver.Shutdown()
	created, err := driver.Create(context.Background(), hostsession.SessionRequest{Workspace: workspace, Source: "coffee-shop-managed"})
	require.NoError(t, err)
	activated := make(chan struct{})
	close(activated)
	observed := make(chan hostsession.DriverSession, 1)
	_, err = driver.StartTurn(context.Background(), hostsession.SessionRequest{
		ProviderSessionID: created.ProviderSessionID, Source: created.Source, RunID: "run-exit",
		Prompt: "bounded", Activated: activated, Emit: func(protocol.HarnessEvent) error { return nil },
		Observe: func(observation hostsession.DriverSession) error {
			if observation.Status == "active-elsewhere" {
				observed <- observation
			}
			return nil
		},
	})
	require.NoError(t, err)
	select {
	case observation := <-observed:
		require.Equal(t, "observe", observation.ControlMode)
		require.Contains(t, observation.Operations, "attach")
	case <-time.After(5 * time.Second):
		t.Fatal("unexpected provider exit was not observed")
	}
	require.Eventually(t, func() bool { return driver.lookupLive(created.ProviderSessionID) == nil }, time.Second, 10*time.Millisecond)
	refreshed, err := driver.Refresh(context.Background(), hostsession.SessionRequest{ProviderSessionID: created.ProviderSessionID, Workspace: workspace, Source: created.Source})
	require.NoError(t, err)
	require.Equal(t, "idle", refreshed.Status)
	require.Equal(t, "resume", refreshed.ControlMode)
	resumed, err := driver.Resume(context.Background(), hostsession.SessionRequest{
		ProviderSessionID: created.ProviderSessionID, Workspace: workspace, Source: created.Source,
	})
	require.NoError(t, err)
	require.Equal(t, "full", resumed.ControlMode)
}

func TestDriverPreservesTheProviderSQLiteHome(t *testing.T) {
	workspace := t.TempDir()
	sqliteHome := t.TempDir()
	reported := filepath.Join(t.TempDir(), "sqlite-home")
	t.Setenv("CODEX_SQLITE_HOME", sqliteHome)
	t.Setenv("FAKE_CODEX_SQLITE_HOME_LOG", reported)
	driver := newFakeAppServerDriverWithPolicy(t, workspace, protocol.ApprovalPolicyManual)
	driver.Shutdown()
	actual, err := os.ReadFile(reported)
	require.NoError(t, err)
	require.Equal(t, sqliteHome, string(actual))
}

func TestFailedTurnReturnsSessionToIdleAndAllowsAnotherTurn(t *testing.T) {
	workspace := t.TempDir()
	t.Setenv("FAKE_CODEX_MODE", "failed-turn")
	driver := newFakeAppServerDriver(t, workspace)
	defer driver.Shutdown()
	created, err := driver.Create(context.Background(), hostsession.SessionRequest{Workspace: workspace, Source: "coffee-shop-managed"})
	require.NoError(t, err)
	completed := make(chan hostsession.DriverSession, 2)
	start := func(runID string) {
		activated := make(chan struct{})
		_, startErr := driver.StartTurn(context.Background(), hostsession.SessionRequest{
			ProviderSessionID: created.ProviderSessionID, Source: created.Source, RunID: runID,
			Prompt: "bounded", Activated: activated, Emit: func(protocol.HarnessEvent) error { return nil },
			Observe: func(observation hostsession.DriverSession) error {
				if observation.Status == "idle" {
					completed <- observation
				}
				return nil
			},
		})
		require.NoError(t, startErr)
		close(activated)
		select {
		case observation := <-completed:
			require.Empty(t, observation.ProviderTurnID)
		case <-time.After(time.Second):
			t.Fatal("failed turn did not settle back to idle")
		}
	}
	start("run-failed-one")
	start("run-failed-two")
}

func TestUnknownNotificationIsWarnedAndIgnoredWithoutLosingWriter(t *testing.T) {
	workspace := t.TempDir()
	t.Setenv("FAKE_CODEX_MODE", "unknown-notification")
	driver := newFakeAppServerDriver(t, workspace)
	defer driver.Shutdown()
	created, err := driver.Create(context.Background(), hostsession.SessionRequest{Workspace: workspace, Source: "coffee-shop-managed"})
	require.NoError(t, err)
	activated := make(chan struct{})
	warned := make(chan struct{}, 1)
	started, err := driver.StartTurn(context.Background(), hostsession.SessionRequest{
		ProviderSessionID: created.ProviderSessionID, Source: created.Source, RunID: "run-notification",
		Prompt: "bounded", Activated: activated, Emit: func(event protocol.HarnessEvent) error {
			if event.Type == "warning" {
				warned <- struct{}{}
			}
			return nil
		},
		Observe: func(hostsession.DriverSession) error { return nil },
	})
	require.NoError(t, err)
	close(activated)
	select {
	case <-warned:
	case <-time.After(time.Second):
		t.Fatal("unknown provider notification was not surfaced as a bounded warning")
	}
	_, err = driver.Steer(context.Background(), hostsession.SessionRequest{
		ProviderSessionID: created.ProviderSessionID, ProviderTurnID: started.ProviderTurnID,
		Source: created.Source, Text: "continue",
	})
	require.NoError(t, err)
}

func TestApprovalMismatchPreservesPendingRequestUntilValidDecision(t *testing.T) {
	workspace := t.TempDir()
	t.Setenv("FAKE_CODEX_MODE", "approval-request")
	driver := newFakeAppServerDriver(t, workspace)
	defer driver.Shutdown()
	created, err := driver.Create(context.Background(), hostsession.SessionRequest{Workspace: workspace, Source: "coffee-shop-managed"})
	require.NoError(t, err)
	activated := make(chan struct{})
	requested := make(chan protocol.HarnessEvent, 1)
	resolved := make(chan protocol.HarnessEvent, 1)
	started, err := driver.StartTurn(context.Background(), hostsession.SessionRequest{
		ProviderSessionID: created.ProviderSessionID, Source: created.Source, RunID: "run-approval",
		Prompt: "bounded", Activated: activated, Emit: func(event protocol.HarnessEvent) error {
			if event.Type == "permission.requested" {
				requested <- event
			}
			if event.Type == "permission.resolved" {
				resolved <- event
			}
			return nil
		}, Observe: func(hostsession.DriverSession) error { return nil },
	})
	require.NoError(t, err)
	close(activated)
	select {
	case event := <-requested:
		require.Equal(t, "approval-one", event.ApprovalID)
		require.Equal(t, "Run Codex command", event.Title)
		require.Contains(t, event.Detail, "Reason: bounded")
	case <-time.After(time.Second):
		t.Fatal("approval request was not normalized")
	}
	decision := &protocol.ApprovalDecision{ApprovalID: "approval-one", RunID: "run-approval", Status: "approved", SelectedOptionID: "allow-once"}
	_, err = driver.ResolveApproval(context.Background(), hostsession.SessionRequest{
		ProviderSessionID: created.ProviderSessionID, ProviderTurnID: "turn-wrong", Source: created.Source, Decision: decision,
	})
	var rejection hostsession.DriverRejection
	require.ErrorAs(t, err, &rejection)
	require.Equal(t, "approval-mismatch", rejection.Code)
	_, err = driver.ResolveApproval(context.Background(), hostsession.SessionRequest{
		ProviderSessionID: created.ProviderSessionID, ProviderTurnID: started.ProviderTurnID, Source: created.Source, Decision: decision,
	})
	require.NoError(t, err)
	select {
	case event := <-resolved:
		require.Equal(t, "approval-one", event.ApprovalID)
		require.Equal(t, "approved", event.Status)
		require.Equal(t, "allow-once", event.SelectedOptionID)
	case <-time.After(time.Second):
		t.Fatal("approval decision was not normalized as resolved")
	}
}

func TestDuplicateApprovalRequestIsDeclinedWithoutReplacingTheFirst(t *testing.T) {
	workspace := t.TempDir()
	t.Setenv("FAKE_CODEX_MODE", "duplicate-approval-request")
	driver := newFakeAppServerDriver(t, workspace)
	defer driver.Shutdown()
	created, err := driver.Create(context.Background(), hostsession.SessionRequest{Workspace: workspace, Source: "coffee-shop-managed"})
	require.NoError(t, err)
	activated := make(chan struct{})
	requested := make(chan protocol.HarnessEvent, 2)
	warned := make(chan protocol.HarnessEvent, 2)
	_, err = driver.StartTurn(context.Background(), hostsession.SessionRequest{
		ProviderSessionID: created.ProviderSessionID, Source: created.Source, RunID: "run-duplicate-approval",
		Prompt: "bounded", Activated: activated, Emit: func(event protocol.HarnessEvent) error {
			switch event.Type {
			case "permission.requested":
				requested <- event
			case "warning":
				warned <- event
			}
			return nil
		}, Observe: func(hostsession.DriverSession) error { return nil },
	})
	require.NoError(t, err)
	close(activated)
	select {
	case <-requested:
	case <-time.After(time.Second):
		t.Fatal("first approval request was not emitted")
	}
	select {
	case warning := <-warned:
		require.Equal(t, "codex-request-duplicate", warning.Code)
	case <-time.After(time.Second):
		t.Fatal("duplicate approval request was not declined")
	}
	select {
	case duplicate := <-requested:
		t.Fatalf("duplicate approval was emitted: %s", duplicate.ApprovalID)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestReusedApprovalRPCIdentityClosesTheUncertainWriter(t *testing.T) {
	workspace := t.TempDir()
	t.Setenv("FAKE_CODEX_MODE", "duplicate-approval-rpc-id")
	driver := newFakeAppServerDriver(t, workspace)
	defer driver.Shutdown()
	created, err := driver.Create(context.Background(), hostsession.SessionRequest{Workspace: workspace, Source: "coffee-shop-managed"})
	require.NoError(t, err)
	activated := make(chan struct{})
	observed := make(chan hostsession.DriverSession, 1)
	_, err = driver.StartTurn(context.Background(), hostsession.SessionRequest{
		ProviderSessionID: created.ProviderSessionID, Source: created.Source, RunID: "run-reused-rpc-id",
		Prompt: "bounded", Activated: activated, Emit: func(protocol.HarnessEvent) error { return nil },
		Observe: func(session hostsession.DriverSession) error {
			if session.Status == "active-elsewhere" {
				observed <- session
			}
			return nil
		},
	})
	require.NoError(t, err)
	close(activated)
	select {
	case session := <-observed:
		require.Equal(t, "observe", session.ControlMode)
	case <-time.After(time.Second):
		t.Fatal("reused approval RPC identity did not close and fence the writer")
	}
}

func TestProviderResolutionAfterDecisionEmitsOnlyTheOperatorResolution(t *testing.T) {
	workspace := t.TempDir()
	t.Setenv("FAKE_CODEX_MODE", "approval-resolved-after-response")
	driver := newFakeAppServerDriver(t, workspace)
	defer driver.Shutdown()
	created, err := driver.Create(context.Background(), hostsession.SessionRequest{Workspace: workspace, Source: "coffee-shop-managed"})
	require.NoError(t, err)
	activated := make(chan struct{})
	requested := make(chan struct{}, 1)
	resolved := make(chan protocol.HarnessEvent, 2)
	started, err := driver.StartTurn(context.Background(), hostsession.SessionRequest{
		ProviderSessionID: created.ProviderSessionID, Source: created.Source, RunID: "run-resolution-race",
		Prompt: "bounded", Activated: activated, Emit: func(event protocol.HarnessEvent) error {
			if event.Type == "permission.requested" {
				requested <- struct{}{}
			}
			if event.Type == "permission.resolved" {
				resolved <- event
			}
			return nil
		}, Observe: func(hostsession.DriverSession) error { return nil },
	})
	require.NoError(t, err)
	close(activated)
	select {
	case <-requested:
	case <-time.After(time.Second):
		t.Fatal("approval request was not emitted")
	}
	decision := &protocol.ApprovalDecision{ApprovalID: "approval-one", RunID: "run-resolution-race", Status: "approved", SelectedOptionID: "allow-once"}
	_, err = driver.ResolveApproval(context.Background(), hostsession.SessionRequest{
		ProviderSessionID: created.ProviderSessionID, ProviderTurnID: started.ProviderTurnID, Source: created.Source, Decision: decision,
	})
	require.NoError(t, err)
	select {
	case event := <-resolved:
		require.Equal(t, "approved", event.Status)
	case <-time.After(time.Second):
		t.Fatal("operator resolution was not emitted")
	}
	select {
	case duplicate := <-resolved:
		t.Fatalf("duplicate resolution was emitted with status %s", duplicate.Status)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestPendingApprovalsSurviveRefreshSteerAndAnEarlierDecision(t *testing.T) {
	workspace := t.TempDir()
	t.Setenv("FAKE_CODEX_MODE", "two-approval-requests")
	driver := newFakeAppServerDriver(t, workspace)
	defer driver.Shutdown()
	created, err := driver.Create(context.Background(), hostsession.SessionRequest{Workspace: workspace, Source: "coffee-shop-managed"})
	require.NoError(t, err)
	activated := make(chan struct{})
	requested := make(chan protocol.HarnessEvent, 2)
	started, err := driver.StartTurn(context.Background(), hostsession.SessionRequest{
		ProviderSessionID: created.ProviderSessionID, Source: created.Source, RunID: "run-two-approvals",
		Prompt: "bounded", Activated: activated, Emit: func(event protocol.HarnessEvent) error {
			if event.Type == "permission.requested" {
				requested <- event
			}
			return nil
		}, Observe: func(hostsession.DriverSession) error { return nil },
	})
	require.NoError(t, err)
	close(activated)
	first := <-requested
	second := <-requested
	require.ElementsMatch(t, []string{"approval-one", "approval-two"}, []string{first.ApprovalID, second.ApprovalID})

	refreshed, err := driver.Refresh(context.Background(), hostsession.SessionRequest{
		ProviderSessionID: created.ProviderSessionID, Workspace: workspace, Source: created.Source,
	})
	require.NoError(t, err)
	require.Equal(t, "awaiting-approval", refreshed.Status)
	steered, err := driver.Steer(context.Background(), hostsession.SessionRequest{
		ProviderSessionID: created.ProviderSessionID, ProviderTurnID: started.ProviderTurnID,
		Source: created.Source, Text: "continue",
	})
	require.NoError(t, err)
	require.Equal(t, "awaiting-approval", steered.Status)

	decision := func(approvalID string) *protocol.ApprovalDecision {
		return &protocol.ApprovalDecision{ApprovalID: approvalID, RunID: "run-two-approvals", Status: "approved", SelectedOptionID: "allow-once"}
	}
	afterFirst, err := driver.ResolveApproval(context.Background(), hostsession.SessionRequest{
		ProviderSessionID: created.ProviderSessionID, ProviderTurnID: started.ProviderTurnID,
		Source: created.Source, Decision: decision("approval-one"),
	})
	require.NoError(t, err)
	require.Equal(t, "awaiting-approval", afterFirst.Status)
	afterSecond, err := driver.ResolveApproval(context.Background(), hostsession.SessionRequest{
		ProviderSessionID: created.ProviderSessionID, ProviderTurnID: started.ProviderTurnID,
		Source: created.Source, Decision: decision("approval-two"),
	})
	require.NoError(t, err)
	require.Equal(t, "running", afterSecond.Status)
}

func TestHarnessEventSequencesRestartPerRunAndRemainSerialized(t *testing.T) {
	live := newLiveSession("coffee-shop-managed")
	defer live.stopEvents()
	firstEntered := make(chan struct{})
	releaseFirst := make(chan struct{})
	delivered := make(chan protocol.HarnessEvent, 3)
	live.mu.Lock()
	live.runID = "run-one"
	live.emit = func(event protocol.HarnessEvent) error {
		if event.Text == "first" {
			close(firstEntered)
			<-releaseFirst
		}
		delivered <- event
		return nil
	}
	live.mu.Unlock()
	done := make(chan error, 1)
	go func() {
		done <- live.emitEvent(protocol.HarnessEvent{Type: "message.delta", Text: "first"})
	}()
	<-firstEntered
	secondDone := make(chan error, 1)
	go func() {
		secondDone <- live.emitEvent(protocol.HarnessEvent{Type: "message.delta", Text: "second"})
	}()
	close(releaseFirst)
	require.NoError(t, <-done)
	require.NoError(t, <-secondDone)
	first, second := <-delivered, <-delivered
	require.Equal(t, int64(1), first.Sequence)
	require.Equal(t, "first", first.Text)
	require.Equal(t, int64(2), second.Sequence)
	require.Equal(t, "second", second.Text)

	live.mu.Lock()
	live.runID = "run-two"
	live.sequence = 0
	live.mu.Unlock()
	require.NoError(t, live.emitEvent(protocol.HarnessEvent{Type: "message.delta", Text: "next run"}))
	next := <-delivered
	require.Equal(t, "run-two", next.RunID)
	require.Equal(t, int64(1), next.Sequence)
}

func TestCreateObserverReportsUnexpectedIdleWriterLoss(t *testing.T) {
	workspace := t.TempDir()
	driver := newFakeAppServerDriver(t, workspace)
	defer driver.Shutdown()
	observed := make(chan hostsession.DriverSession, 1)
	created, err := driver.Create(context.Background(), hostsession.SessionRequest{
		Workspace: workspace, Source: "coffee-shop-managed",
		Observe: func(session hostsession.DriverSession) error {
			if session.Status == "active-elsewhere" {
				observed <- session
			}
			return nil
		},
	})
	require.NoError(t, err)
	live := driver.lookupLive(created.ProviderSessionID)
	require.NotNil(t, live)
	live.client.closeWithError(fmt.Errorf("unexpected writer loss"), true)
	select {
	case session := <-observed:
		require.Equal(t, created.ProviderSessionID, session.ProviderSessionID)
		require.Equal(t, "observe", session.ControlMode)
	case <-time.After(time.Second):
		t.Fatal("idle writer loss was not reported through the session observer")
	}
}

func TestReconcileWriterExitCannotPublishADeadFullClaim(t *testing.T) {
	workspace := t.TempDir()
	t.Setenv("FAKE_CODEX_MODE", "exit-after-resume")
	driver := newFakeAppServerDriver(t, workspace)
	defer driver.Shutdown()
	activated := make(chan struct{})
	aborted := make(chan struct{})
	observed := make(chan hostsession.DriverSession, 1)
	request := hostsession.SessionRequest{
		ProviderSessionID: "thread-one", Workspace: workspace, Source: "provider-history",
		Activated: activated, Aborted: aborted,
		Observe: func(session hostsession.DriverSession) error { observed <- session; return nil },
	}
	result, err := driver.Reconcile(context.Background(), request)
	close(activated)
	if err != nil {
		var rejection hostsession.DriverRejection
		require.ErrorAs(t, err, &rejection)
		require.NotNil(t, rejection.Observation)
		require.Equal(t, "active-elsewhere", rejection.Observation.Status)
	} else {
		require.Equal(t, "full", result.ControlMode)
		select {
		case session := <-observed:
			require.Equal(t, "active-elsewhere", session.Status)
		case <-time.After(5 * time.Second):
			t.Fatal("post-return writer exit was not observed")
		}
	}
	require.Eventually(t, func() bool { return driver.lookupLive("thread-one") == nil }, 5*time.Second, 10*time.Millisecond)
}

func TestAbortedAdoptReleasesTheNewWriterClaim(t *testing.T) {
	workspace := t.TempDir()
	driver := newFakeAppServerDriver(t, workspace)
	defer driver.Shutdown()
	activated := make(chan struct{})
	aborted := make(chan struct{})
	_, err := driver.Adopt(context.Background(), hostsession.SessionRequest{
		ProviderSessionID: "thread-one", Workspace: workspace, Source: "provider-history", ControlMode: "resume",
		Activated: activated, Aborted: aborted,
	})
	require.NoError(t, err)
	require.NotNil(t, driver.lookupLive("thread-one"))
	close(aborted)
	require.Eventually(t, func() bool { return driver.lookupLive("thread-one") == nil }, time.Second, 10*time.Millisecond)
}

func TestAbortedTurnStartInterruptsTheProviderTurn(t *testing.T) {
	workspace := t.TempDir()
	driver := newFakeAppServerDriver(t, workspace)
	defer driver.Shutdown()
	created, err := driver.Create(context.Background(), hostsession.SessionRequest{Workspace: workspace, Source: "coffee-shop-managed"})
	require.NoError(t, err)
	activated := make(chan struct{})
	aborted := make(chan struct{})
	observed := make(chan hostsession.DriverSession, 1)
	_, err = driver.StartTurn(context.Background(), hostsession.SessionRequest{
		ProviderSessionID: created.ProviderSessionID, Source: created.Source, RunID: "run-aborted",
		Prompt: "bounded", Activated: activated, Aborted: aborted,
		Emit:    func(protocol.HarnessEvent) error { return nil },
		Observe: func(session hostsession.DriverSession) error { observed <- session; return nil },
	})
	require.NoError(t, err)
	close(aborted)
	select {
	case session := <-observed:
		require.Equal(t, "idle", session.Status)
		require.Empty(t, session.ProviderTurnID)
	case <-time.After(time.Second):
		t.Fatal("aborted provider turn was not interrupted and observed idle")
	}
}

func TestWriterLossObservationWaitsForOwnershipCommit(t *testing.T) {
	live := newLiveSession("coffee-shop-managed")
	defer live.stopEvents()
	activated := make(chan struct{})
	aborted := make(chan struct{})
	observed := make(chan hostsession.DriverSession, 1)
	live.mu.Lock()
	live.thread = providerThread{ID: "thread-one", CWD: "/workspace", Preview: "bounded"}
	live.uncertain = true
	live.activated = activated
	live.aborted = aborted
	live.observe = func(session hostsession.DriverSession) error { observed <- session; return nil }
	live.mu.Unlock()
	live.scheduleUncertainObservation()
	select {
	case <-observed:
		t.Fatal("writer loss was reported before ownership committed")
	case <-time.After(50 * time.Millisecond):
	}
	close(activated)
	select {
	case session := <-observed:
		require.Equal(t, "active-elsewhere", session.Status)
	case <-time.After(time.Second):
		t.Fatal("writer loss was not reported after ownership committed")
	}
}

func TestUndeliverableApprovalIsCancelledAndNotLeftPending(t *testing.T) {
	workspace := t.TempDir()
	t.Setenv("FAKE_CODEX_MODE", "approval-request")
	driver := newFakeAppServerDriver(t, workspace)
	defer driver.Shutdown()
	created, err := driver.Create(context.Background(), hostsession.SessionRequest{Workspace: workspace, Source: "coffee-shop-managed"})
	require.NoError(t, err)
	activated := make(chan struct{})
	started, err := driver.StartTurn(context.Background(), hostsession.SessionRequest{
		ProviderSessionID: created.ProviderSessionID, Source: created.Source, RunID: "run-undeliverable",
		Prompt: "bounded", Activated: activated,
		Emit:    func(protocol.HarnessEvent) error { return fmt.Errorf("transport full") },
		Observe: func(hostsession.DriverSession) error { return nil },
	})
	require.NoError(t, err)
	close(activated)
	require.Eventually(t, func() bool {
		live := driver.lookupLive(created.ProviderSessionID)
		if live == nil {
			return false
		}
		live.mu.Lock()
		defer live.mu.Unlock()
		return len(live.approvals) == 0
	}, time.Second, 10*time.Millisecond)
	refreshed, err := driver.Refresh(context.Background(), hostsession.SessionRequest{
		ProviderSessionID: created.ProviderSessionID, Workspace: workspace, Source: created.Source,
	})
	require.NoError(t, err)
	require.Equal(t, "running", refreshed.Status)
	require.Equal(t, started.ProviderTurnID, refreshed.ProviderTurnID)
}

func TestInterruptClearsPendingApprovalsForTheInterruptedTurn(t *testing.T) {
	workspace := t.TempDir()
	t.Setenv("FAKE_CODEX_MODE", "approval-request")
	driver := newFakeAppServerDriver(t, workspace)
	defer driver.Shutdown()
	created, err := driver.Create(context.Background(), hostsession.SessionRequest{Workspace: workspace, Source: "coffee-shop-managed"})
	require.NoError(t, err)
	activated := make(chan struct{})
	requested := make(chan struct{}, 1)
	resolved := make(chan protocol.HarnessEvent, 1)
	started, err := driver.StartTurn(context.Background(), hostsession.SessionRequest{
		ProviderSessionID: created.ProviderSessionID, Source: created.Source, RunID: "run-interrupt-approval",
		Prompt: "bounded", Activated: activated, Emit: func(event protocol.HarnessEvent) error {
			if event.Type == "permission.requested" {
				requested <- struct{}{}
			}
			if event.Type == "permission.resolved" {
				resolved <- event
			}
			return nil
		}, Observe: func(hostsession.DriverSession) error { return nil },
	})
	require.NoError(t, err)
	close(activated)
	select {
	case <-requested:
	case <-time.After(time.Second):
		t.Fatal("approval request was not observed")
	}
	interrupted, err := driver.Interrupt(context.Background(), hostsession.SessionRequest{
		ProviderSessionID: created.ProviderSessionID, ProviderTurnID: started.ProviderTurnID, Source: created.Source,
	})
	require.NoError(t, err)
	require.Equal(t, "idle", interrupted.Status)
	select {
	case event := <-resolved:
		require.Equal(t, "approval-one", event.ApprovalID)
		require.Equal(t, "cancelled", event.Status)
	case <-time.After(time.Second):
		t.Fatal("interrupted approval was not resolved")
	}
	refreshed, err := driver.Refresh(context.Background(), hostsession.SessionRequest{
		ProviderSessionID: created.ProviderSessionID, Workspace: workspace, Source: created.Source,
	})
	require.NoError(t, err)
	require.Equal(t, "idle", refreshed.Status)
	require.Empty(t, refreshed.ProviderTurnID)
}

func TestProviderTextIsRuneSafeBoundedAndSecretScreened(t *testing.T) {
	truncated := bounded(strings.Repeat("é", 600), 1023)
	require.True(t, utf8.ValidString(truncated))
	require.LessOrEqual(t, len(truncated), 1023)
	require.Equal(t, "[redacted]", bounded("ghp_abcdefghijklmnopqrstuvwxyz1234567890", 1024))
}

func TestApprovalDecisionNeverLetsARejectedStatusAccept(t *testing.T) {
	require.Empty(t, approvalDecision(&protocol.ApprovalDecision{Status: "rejected", SelectedOptionID: "allow-once"}))
	require.Empty(t, approvalDecision(&protocol.ApprovalDecision{Status: "approved", SelectedOptionID: "reject-once"}))
	require.Equal(t, "decline", approvalDecision(&protocol.ApprovalDecision{Status: "rejected", SelectedOptionID: "reject-once"}))
	require.Equal(t, "accept", approvalDecision(&protocol.ApprovalDecision{Status: "approved", SelectedOptionID: "allow-once"}))
	require.Empty(t, approvalDecision(&protocol.ApprovalDecision{Status: "rejected", SelectedOptionID: "reject-always"}))
	for _, unadvertised := range []string{"accept", "acceptForSession", "decline", "cancel"} {
		require.Empty(t, approvalDecision(&protocol.ApprovalDecision{Status: "approved", SelectedOptionID: unadvertised}))
		require.Empty(t, approvalDecision(&protocol.ApprovalDecision{Status: "rejected", SelectedOptionID: unadvertised}))
	}
}

func TestIntentionalDriverShutdownDoesNotPublishActiveElsewhere(t *testing.T) {
	workspace := t.TempDir()
	driver := newFakeAppServerDriver(t, workspace)
	created, err := driver.Create(context.Background(), hostsession.SessionRequest{Workspace: workspace, Source: "coffee-shop-managed"})
	require.NoError(t, err)
	activated := make(chan struct{})
	close(activated)
	unexpected := make(chan hostsession.DriverSession, 1)
	_, err = driver.StartTurn(context.Background(), hostsession.SessionRequest{
		ProviderSessionID: created.ProviderSessionID, Source: created.Source, RunID: "run-shutdown",
		Prompt: "bounded", Activated: activated, Emit: func(protocol.HarnessEvent) error { return nil },
		Observe: func(observation hostsession.DriverSession) error {
			if observation.Status == "active-elsewhere" {
				unexpected <- observation
			}
			return nil
		},
	})
	require.NoError(t, err)
	driver.Shutdown()
	select {
	case <-unexpected:
		t.Fatal("intentional shutdown was reported as an unexpected writer loss")
	case <-time.After(100 * time.Millisecond):
	}
}

func TestActivatedTurnAbortDoesNotStopLaterEventDelivery(t *testing.T) {
	live := newLiveSession("coffee-shop-managed")
	defer live.stopEvents()
	events := make(chan protocol.HarnessEvent, 2)
	activated := make(chan struct{})
	aborted := make(chan struct{})
	close(activated)
	close(aborted)
	live.mu.Lock()
	live.runID = "run-one"
	live.activated = activated
	live.aborted = aborted
	live.emit = func(event protocol.HarnessEvent) error { events <- event; return nil }
	live.mu.Unlock()
	require.NoError(t, live.deliver(providerMessage{method: "item/agentMessage/delta", params: json.RawMessage(`{"delta":"first"}`)}))
	require.Equal(t, "first", (<-events).Text)

	secondActivated := make(chan struct{})
	secondAborted := make(chan struct{})
	close(secondActivated)
	live.mu.Lock()
	live.runID = "run-two"
	live.activated = secondActivated
	live.aborted = secondAborted
	live.mu.Unlock()
	require.NoError(t, live.deliver(providerMessage{method: "item/agentMessage/delta", params: json.RawMessage(`{"delta":"second"}`)}))
	require.Equal(t, "second", (<-events).Text)
}

func TestProviderResolvedRequestClearsTheMatchingApproval(t *testing.T) {
	live := newLiveSession("coffee-shop-managed")
	defer live.stopEvents()
	observed := make(chan hostsession.DriverSession, 1)
	resolved := make(chan protocol.HarnessEvent, 1)
	live.mu.Lock()
	live.thread = providerThread{ID: "thread-one", CWD: "/workspace", Preview: "bounded"}
	live.turnID = "turn-one"
	live.runID = "run-one"
	live.approvals["approval-one"] = pendingApproval{id: json.RawMessage(`99`), turnID: "turn-one"}
	live.observe = func(session hostsession.DriverSession) error { observed <- session; return nil }
	live.emit = func(event protocol.HarnessEvent) error { resolved <- event; return nil }
	live.mu.Unlock()
	live.process(providerMessage{method: "serverRequest/resolved", params: json.RawMessage(`{"requestId":99,"threadId":"thread-one"}`)})
	select {
	case event := <-resolved:
		require.Equal(t, "permission.resolved", event.Type)
		require.Equal(t, "approval-one", event.ApprovalID)
		require.Equal(t, "cancelled", event.Status)
	case <-time.After(time.Second):
		t.Fatal("provider resolution event was not emitted")
	}
	select {
	case session := <-observed:
		require.Equal(t, "running", session.Status)
	case <-time.After(time.Second):
		t.Fatal("provider-resolved approval was not observed")
	}
	live.mu.Lock()
	require.Empty(t, live.approvals)
	live.mu.Unlock()
}

func TestUntrackedResolutionFromAnotherThreadIsIgnored(t *testing.T) {
	live := newLiveSession("coffee-shop-managed")
	defer live.stopEvents()
	live.mu.Lock()
	live.thread = providerThread{ID: "thread-one", CWD: "/workspace"}
	live.approvals["approval-one"] = pendingApproval{id: json.RawMessage(`99`), turnID: "turn-one"}
	live.mu.Unlock()
	live.process(providerMessage{method: "serverRequest/resolved", params: json.RawMessage(`{"requestId":100,"threadId":"thread-child"}`)})
	live.mu.Lock()
	require.False(t, live.uncertain)
	require.Contains(t, live.approvals, "approval-one")
	live.mu.Unlock()
}

func TestChildThreadNotificationsDoNotLeakIntoTheParentRun(t *testing.T) {
	live := newLiveSession("coffee-shop-managed")
	defer live.stopEvents()
	events := make(chan protocol.HarnessEvent, 3)
	live.mu.Lock()
	live.thread = providerThread{ID: "thread-parent", CWD: "/workspace"}
	live.turnID = "turn-parent"
	live.runID = "run-parent"
	live.emit = func(event protocol.HarnessEvent) error { events <- event; return nil }
	live.mu.Unlock()
	live.process(providerMessage{method: "item/agentMessage/delta", params: json.RawMessage(`{"threadId":"thread-child","turnId":"turn-child","delta":"child"}`)})
	live.process(providerMessage{method: "thread/tokenUsage/updated", params: json.RawMessage(`{"threadId":"thread-child","turnId":"turn-child","tokenUsage":{"total":{"inputTokens":1,"outputTokens":1,"cachedInputTokens":0}}}`)})
	live.process(providerMessage{method: "item/started", params: json.RawMessage(`{"threadId":"thread-child","turnId":"turn-child","item":{"id":"child-tool","type":"commandExecution","status":"inProgress"}}`)})
	select {
	case event := <-events:
		t.Fatalf("child-thread event leaked into parent run: %s", event.Type)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestRealPinnedAppServerWriterContention(t *testing.T) {
	binary, err := exec.LookPath("codex")
	if err != nil {
		t.Skip("pinned Codex executable is not installed")
	}
	versionContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	version, err := exec.CommandContext(versionContext, binary, "--version").Output()
	if err != nil || strings.TrimSpace(string(version)) != "codex-cli "+SupportedVersion {
		t.Skip("installed Codex executable is not the pinned build")
	}
	workspace := t.TempDir()
	codexHome := t.TempDir()
	t.Setenv("CODEX_HOME", codexHome)
	threadID := "018f0000-0000-7000-8000-000000000001"
	rolloutDirectory := filepath.Join(codexHome, "sessions", "2026", "10", "06")
	require.NoError(t, os.MkdirAll(rolloutDirectory, 0o700))
	meta := fmt.Sprintf(`{"timestamp":"2026-10-06T12:00:00Z","type":"session_meta","payload":{"session_id":%q,"id":%q,"timestamp":"2026-10-06T12:00:00Z","cwd":%q,"originator":"codex","cli_version":"0.147.0","source":"cli","model_provider":"openai","base_instructions":null,"dynamic_tools":null,"history_mode":"paginated"},"ordinal":0}`, threadID, threadID, workspace)
	user := `{"timestamp":"2026-10-06T12:00:00Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"synthetic account-free fixture"}]},"ordinal":1}`
	event := `{"timestamp":"2026-10-06T12:00:00Z","type":"event_msg","payload":{"type":"user_message","message":"synthetic account-free fixture","kind":"plain"},"ordinal":2}`
	rollout := filepath.Join(rolloutDirectory, "rollout-2026-10-06T12-00-00-"+threadID+".jsonl")
	require.NoError(t, os.WriteFile(rollout, []byte(meta+"\n"+user+"\n"+event+"\n"), 0o600))
	verify := func() error { return nil }
	primary, err := startClient(context.Background(), clientConfig{binary: binary, verify: verify})
	require.NoError(t, err)
	var first threadResponse
	require.NoError(t, primary.call(context.Background(), "thread/resume", map[string]any{"threadId": threadID}, &first))
	require.Equal(t, threadID, first.Thread.ID)
	secondary, err := startClient(context.Background(), clientConfig{binary: binary, verify: verify})
	require.NoError(t, err)
	var conflict threadResponse
	err = secondary.call(context.Background(), "thread/resume", map[string]any{"threadId": threadID}, &conflict)
	code, message, rpc := classifyRPC(err)
	require.True(t, rpc)
	require.Equal(t, -32600, code)
	require.Equal(t, "thread "+threadID+" already has an active writer", message)
	primary.Close()
	var reclaimed threadResponse
	require.NoError(t, secondary.call(context.Background(), "thread/resume", map[string]any{"threadId": threadID}, &reclaimed))
	require.Equal(t, threadID, reclaimed.Thread.ID)
	secondary.Close()
}

func newFakeAppServerDriver(t *testing.T, workspace string) *Driver {
	return newFakeAppServerDriverWithPolicy(t, workspace, protocol.ApprovalPolicyManual)
}

func newFakeAppServerDriverWithPolicy(t *testing.T, workspace, policy string) *Driver {
	t.Helper()
	t.Setenv("FAKE_CODEX_WORKSPACE", workspace)
	driver, err := New(context.Background(), Config{
		Binary: fakeAppServerBinary(t), Version: SupportedVersion, Verify: func() error { return nil },
		WorkspaceRoots: []string{workspace}, ApprovalPolicy: policy,
	})
	require.NoError(t, err)
	return driver
}

func fakeAppServerBinary(t *testing.T) string {
	t.Helper()
	executable, err := os.Executable()
	require.NoError(t, err)
	path := filepath.Join(t.TempDir(), "codex")
	script := fmt.Sprintf("#!/bin/sh\nGO_WANT_CODEX_HELPER=1 exec %q -test.run=TestCodexAppServerHelperProcess -- \"$@\"\n", executable)
	require.NoError(t, os.WriteFile(path, []byte(script), 0o700))
	return path
}

func TestCodexAppServerHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_CODEX_HELPER") != "1" {
		return
	}
	workspace := os.Getenv("FAKE_CODEX_WORKSPACE")
	scanner := bufio.NewScanner(os.Stdin)
	encoder := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
			Result json.RawMessage `json:"result"`
		}
		if json.Unmarshal(scanner.Bytes(), &request) != nil {
			os.Exit(2)
		}
		if request.Method == "" && len(request.ID) > 0 && len(request.Result) > 0 {
			if os.Getenv("FAKE_CODEX_MODE") == "approval-resolved-after-response" {
				_ = encoder.Encode(map[string]any{"method": "serverRequest/resolved", "params": map[string]any{"requestId": 99, "threadId": "thread-created"}})
			}
			continue
		}
		if request.Method == "" {
			os.Exit(2)
		}
		if logPath := os.Getenv("FAKE_CODEX_RPC_LOG"); logPath != "" {
			file, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
			if err != nil {
				os.Exit(2)
			}
			_, _ = fmt.Fprintln(file, request.Method)
			_ = file.Close()
		}
		if len(request.ID) == 0 {
			continue
		}
		result := any(map[string]any{})
		var rpcErr any
		switch request.Method {
		case "initialize":
			if path := os.Getenv("FAKE_CODEX_SQLITE_HOME_LOG"); path != "" {
				if os.WriteFile(path, []byte(os.Getenv("CODEX_SQLITE_HOME")), 0o600) != nil {
					os.Exit(2)
				}
			}
			if os.Getenv("FAKE_CODEX_MODE") == "spawn-child" {
				child := exec.Command("sleep", "60")
				if child.Start() != nil || os.WriteFile(os.Getenv("FAKE_CODEX_CHILD_PID"), []byte(strconv.Itoa(child.Process.Pid)), 0o600) != nil {
					os.Exit(2)
				}
			}
			if os.Getenv("FAKE_CODEX_MODE") == "oversize-initialize" {
				_, _ = os.Stdout.Write(append([]byte(`{"id":1,"result":{"padding":"`), append(make([]byte, maxInboundFrameBytes), []byte(`"}}\n`)...)...))
				os.Exit(0)
			}
			if os.Getenv("FAKE_CODEX_MODE") == "unknown-response" {
				_ = encoder.Encode(map[string]any{"id": 999, "result": map[string]any{}})
				continue
			}
			initializeResult := map[string]any{"userAgent": "codex-cli/0.147.0", "codexHome": filepath.Join(workspace, ".codex"), "platformFamily": "unix", "platformOs": "linux"}
			if os.Getenv("FAKE_CODEX_MODE") == "large-initialize" {
				initializeResult["padding"] = strings.Repeat("x", maxOutboundFrameBytes)
			}
			result = initializeResult
		case "thread/list":
			var params struct {
				Cursor string `json:"cursor"`
			}
			_ = json.Unmarshal(request.Params, &params)
			data := []any{
				fakeThread("thread-one", workspace, "paginated", nil),
				fakeThread("thread-legacy", workspace, "legacy", nil),
			}
			if params.Cursor != "" {
				data = nil
			}
			result = map[string]any{"data": data, "nextCursor": func() any {
				if os.Getenv("FAKE_CODEX_MODE") == "repeat-cursor" {
					return "same"
				}
				return nil
			}()}
		case "thread/read":
			var params struct {
				ThreadID     string `json:"threadId"`
				IncludeTurns bool   `json:"includeTurns"`
			}
			_ = json.Unmarshal(request.Params, &params)
			if os.Getenv("FAKE_CODEX_MODE") == "large-history" && params.IncludeTurns {
				os.Exit(2)
			}
			items := []any{
				map[string]any{"type": "userMessage", "id": "item-user", "content": []any{map[string]any{"type": "text", "text": "hello"}}},
				map[string]any{"type": "agentMessage", "id": "item-agent", "text": "world"},
			}
			result = map[string]any{"thread": fakeThread(params.ThreadID, workspace, historyMode(params.ThreadID), []any{map[string]any{"id": "turn-one", "status": "completed", "items": items}})}
		case "thread/items/list":
			var params struct {
				Cursor        string `json:"cursor"`
				Limit         int    `json:"limit"`
				SortDirection string `json:"sortDirection"`
			}
			_ = json.Unmarshal(request.Params, &params)
			if params.SortDirection != "desc" {
				os.Exit(2)
			}
			entries := []any{
				map[string]any{"turnId": "turn-one", "item": map[string]any{"type": "agentMessage", "id": "item-agent", "text": "world"}},
				map[string]any{"turnId": "turn-one", "item": map[string]any{"type": "userMessage", "id": "item-user", "content": []any{map[string]any{"type": "text", "text": "hello"}}}},
			}
			start := 0
			if params.Cursor == "after-item-agent" {
				start = 1
			} else if params.Cursor != "" {
				rpcErr = map[string]any{"code": -32602, "message": "invalid cursor"}
				break
			}
			limit := params.Limit
			if limit <= 0 || limit > len(entries)-start {
				limit = len(entries) - start
			}
			end := start + limit
			var next any
			if end < len(entries) {
				next = "after-item-agent"
			}
			result = map[string]any{"data": entries[start:end], "nextCursor": next}
		case "thread/resume":
			var params struct {
				ThreadID string `json:"threadId"`
			}
			_ = json.Unmarshal(request.Params, &params)
			switch os.Getenv("FAKE_CODEX_RESUME") {
			case "writer-conflict":
				rpcErr = map[string]any{"code": -32600, "message": "thread " + params.ThreadID + " already has an active writer"}
			case "other-invalid-request":
				rpcErr = map[string]any{"code": -32600, "message": "SECRET_RAW_PAYLOAD malformed request"}
			default:
				id := params.ThreadID
				if os.Getenv("FAKE_CODEX_MODE") == "resume-mismatch" {
					id = "thread-other"
				}
				result = fakeThreadResponse(id, workspace, request.Params)
			}
		case "thread/start":
			result = fakeThreadResponse("thread-created", workspace, request.Params)
		case "turn/start":
			if os.Getenv("FAKE_CODEX_MODE") == "turn-start-response-lost" {
				os.Exit(0)
			}
			var params struct {
				ApprovalPolicy    string         `json:"approvalPolicy"`
				ApprovalsReviewer string         `json:"approvalsReviewer"`
				SandboxPolicy     map[string]any `json:"sandboxPolicy"`
			}
			if json.Unmarshal(request.Params, &params) != nil || params.ApprovalPolicy == "" || params.ApprovalsReviewer == "" || params.SandboxPolicy["type"] == nil {
				os.Exit(2)
			}
			result = map[string]any{"turn": map[string]any{"id": "turn-created", "status": "inProgress", "items": []any{}}}
		case "turn/steer":
			result = map[string]any{"turnId": "turn-created"}
		case "turn/interrupt":
			result = map[string]any{}
		default:
			rpcErr = map[string]any{"code": -32601, "message": "unsupported"}
		}
		response := map[string]any{"id": json.RawMessage(request.ID), "result": result}
		if rpcErr != nil {
			delete(response, "result")
			response["error"] = rpcErr
		}
		if encoder.Encode(response) != nil {
			os.Exit(2)
		}
		if request.Method == "thread/resume" && os.Getenv("FAKE_CODEX_MODE") == "exit-after-resume" {
			os.Exit(0)
		}
		if request.Method == "turn/start" && os.Getenv("FAKE_CODEX_MODE") == "ordered-events" {
			_ = encoder.Encode(map[string]any{"method": "item/agentMessage/delta", "params": map[string]any{"delta": "first"}})
			_ = encoder.Encode(map[string]any{"method": "item/agentMessage/delta", "params": map[string]any{"delta": "second"}})
			_ = encoder.Encode(map[string]any{"method": "turn/completed", "params": map[string]any{"turn": map[string]any{"id": "turn-created", "status": "completed"}}})
		}
		if request.Method == "turn/start" && os.Getenv("FAKE_CODEX_MODE") == "failed-turn" {
			_ = encoder.Encode(map[string]any{"method": "turn/completed", "params": map[string]any{"turn": map[string]any{"id": "turn-created", "status": "failed"}}})
		}
		if request.Method == "turn/start" && os.Getenv("FAKE_CODEX_MODE") == "unknown-notification" {
			_ = encoder.Encode(map[string]any{"method": "account/rateLimits/updated", "params": map[string]any{"bounded": true}})
		}
		if request.Method == "turn/start" && (os.Getenv("FAKE_CODEX_MODE") == "approval-request" || os.Getenv("FAKE_CODEX_MODE") == "approval-resolved-after-response") {
			_ = encoder.Encode(map[string]any{
				"id": 99, "method": "item/commandExecution/requestApproval",
				"params": map[string]any{"itemId": "approval-one", "threadId": "thread-created", "turnId": "turn-created", "reason": "bounded"},
			})
		}
		if request.Method == "turn/start" && os.Getenv("FAKE_CODEX_MODE") == "duplicate-approval-request" {
			for index := 0; index < 2; index++ {
				_ = encoder.Encode(map[string]any{
					"id": 99 + index, "method": "item/commandExecution/requestApproval",
					"params": map[string]any{"itemId": "approval-one", "threadId": "thread-created", "turnId": "turn-created", "reason": "bounded"},
				})
			}
		}
		if request.Method == "turn/start" && os.Getenv("FAKE_CODEX_MODE") == "duplicate-approval-rpc-id" {
			for _, itemID := range []string{"approval-one", "approval-two"} {
				_ = encoder.Encode(map[string]any{
					"id": 99, "method": "item/commandExecution/requestApproval",
					"params": map[string]any{"itemId": itemID, "threadId": "thread-created", "turnId": "turn-created", "reason": "bounded"},
				})
			}
		}
		if request.Method == "turn/start" && os.Getenv("FAKE_CODEX_MODE") == "two-approval-requests" {
			for index, itemID := range []string{"approval-one", "approval-two"} {
				_ = encoder.Encode(map[string]any{
					"id": 99 + index, "method": "item/commandExecution/requestApproval",
					"params": map[string]any{"itemId": itemID, "threadId": "thread-created", "turnId": "turn-created", "reason": "bounded"},
				})
			}
		}
		if request.Method == "turn/start" && os.Getenv("FAKE_CODEX_MODE") == "exit-after-turn-start" {
			os.Exit(0)
		}
	}
	os.Exit(0)
}

func fakeThread(id, workspace, mode string, turns []any) map[string]any {
	if turns == nil {
		turns = []any{}
	}
	version := os.Getenv("FAKE_CODEX_THREAD_VERSION")
	if version == "" {
		version = SupportedVersion
	}
	thread := map[string]any{
		"id": id, "sessionId": id, "cwd": workspace, "cliVersion": version,
		"historyMode": mode, "preview": "bounded preview", "modelProvider": "openai",
		"createdAt": 1, "updatedAt": 1, "ephemeral": false, "source": "cli",
		"status": map[string]any{"type": "notLoaded"}, "turns": turns,
	}
	if name := os.Getenv("FAKE_CODEX_THREAD_NAME"); name != "" {
		thread["name"] = name
	}
	return thread
}

func fakeThreadResponse(id, workspace string, raw json.RawMessage) map[string]any {
	var params struct {
		ApprovalPolicy    string `json:"approvalPolicy"`
		ApprovalsReviewer string `json:"approvalsReviewer"`
		Sandbox           string `json:"sandbox"`
	}
	if json.Unmarshal(raw, &params) != nil || params.ApprovalPolicy == "" || params.ApprovalsReviewer == "" || params.Sandbox == "" {
		os.Exit(2)
	}
	sandboxType := "workspaceWrite"
	if params.Sandbox == "danger-full-access" {
		sandboxType = "dangerFullAccess"
	}
	if os.Getenv("FAKE_CODEX_MODE") == "policy-mismatch" {
		sandboxType = "readOnly"
	}
	return map[string]any{
		"thread":         fakeThread(id, workspace, "paginated", nil),
		"approvalPolicy": params.ApprovalPolicy, "approvalsReviewer": params.ApprovalsReviewer,
		"sandbox": map[string]any{"type": sandboxType},
	}
}

func historyMode(id string) string {
	if id == "thread-legacy" {
		return "legacy"
	}
	return "paginated"
}
