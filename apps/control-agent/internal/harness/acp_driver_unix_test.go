//go:build !windows

package harness

import (
	"context"
	"errors"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp/acptest"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/mcpserver"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

func TestACPDriverKillsProcessTreeAfterCancellationGrace(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var cancelledAt time.Time
	run := executeScenario(t, ctx, "cancel-ignored", 300*time.Millisecond, func(event protocol.HarnessEvent) {
		if event.Type == "message.delta" {
			cancelledAt = time.Now()
			cancel()
		}
	})
	require.ErrorIs(t, run.err, acp.ErrCancelGraceExpired)
	elapsed := time.Since(cancelledAt)
	require.GreaterOrEqual(t, elapsed, 300*time.Millisecond)
	require.Less(t, elapsed, 6*time.Second)
	require.NotNil(t, acptest.ReceivedMethod(t, run.record, "session/cancel"))
	pids := acptest.DescendantPIDs(t, run.record)
	require.Len(t, pids, 1)
	require.Eventually(t, func() bool {
		return errors.Is(syscall.Kill(pids[0], 0), syscall.ESRCH)
	}, 5*time.Second, 50*time.Millisecond, "descendant survived process-tree termination")
}

func TestACPDriverShutdownIsBoundedWhenAnEscapedDescendantHoldsStdio(t *testing.T) {
	runner, record := fakeAdapterDriver(t, "escaped-stdio-holder", 200*time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	finished := make(chan error, 1)
	go func() {
		_, err := runner.Execute(ctx, Invocation{
			Run:       protocol.Run{ID: "run-escaped", HarnessID: "codex-cli", Transport: TransportACP, Prompt: strings.Repeat("large prompt ", 256*1024)},
			Workspace: t.TempDir(),
			MCP:       mcpserver.Config{URL: "http://127.0.0.1:9/mcp", Token: driverTestToken},
		})
		finished <- err
	}()
	require.Eventually(t, func() bool {
		return len(acptest.DescendantPIDs(t, record)) == 1
	}, 10*time.Second, 25*time.Millisecond, "escaped stdio holder did not start")
	cancel()
	select {
	case err := <-finished:
		require.Error(t, err)
	case <-time.After(20 * time.Second):
		acptest.KillDescendants(t, record)
		t.Fatal("ACP driver shutdown blocked on adapter stdio held by an escaped descendant")
	}
	require.Len(t, acptest.DescendantPIDs(t, record), 1)
}
