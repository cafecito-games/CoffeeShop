//go:build linux

package codex

import (
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestClientCloseTerminatesProviderProcessGroupChildren(t *testing.T) {
	workspace := t.TempDir()
	pidPath := t.TempDir() + "/child.pid"
	t.Setenv("FAKE_CODEX_WORKSPACE", workspace)
	t.Setenv("FAKE_CODEX_MODE", "spawn-child")
	t.Setenv("FAKE_CODEX_CHILD_PID", pidPath)
	connection, err := startClient(context.Background(), clientConfig{
		binary: fakeAppServerBinary(t), verify: func() error { return nil }, stateRoot: t.TempDir(),
	})
	require.NoError(t, err)
	pidBytes, err := os.ReadFile(pidPath)
	require.NoError(t, err)
	pid, err := strconv.Atoi(strings.TrimSpace(string(pidBytes)))
	require.NoError(t, err)
	connection.Close()
	require.Eventually(t, func() bool {
		err := syscall.Kill(pid, 0)
		return errors.Is(err, syscall.ESRCH)
	}, 2*time.Second, 10*time.Millisecond)
}
