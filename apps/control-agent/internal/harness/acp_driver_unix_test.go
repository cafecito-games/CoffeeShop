//go:build !windows

package harness

import (
	"context"
	"errors"
	"syscall"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp/acptest"
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
