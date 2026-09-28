//go:build linux

package harness

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
	"time"
)

// Linux can additionally bind a provider's lifetime to Barista's. Setpgid keeps ordinary
// cancellation scoped to the provider tree; Pdeathsig closes the SIGKILL/crash boundary where the
// parent has no opportunity to run command.Cancel.
//
// Linux binds Pdeathsig to the OS thread that creates the child, not abstractly to the whole parent
// process. Barista's launch path is Go-owned and contains no project-owned cgo or thread-affine
// handoff; process_linux_test.go keeps that assumption explicit. Introducing either requires a
// guardian or a launch path that keeps the creating thread alive for the whole child lifetime.
func configureProcessCancellation(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
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
