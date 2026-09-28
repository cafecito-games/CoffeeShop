//go:build !windows && !linux

package harness

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
	"time"
)

// Non-Linux Unix has no Pdeathsig equivalent here. Ordinary cancellation still kills the provider
// process group; an uncatchable Barista crash is reconciled remotely, but child death is not claimed.
func configureProcessCancellation(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.Cancel = func() error {
		if command.Process == nil {
			return os.ErrProcessDone
		}
		err := syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	command.WaitDelay = 2 * time.Second
}
