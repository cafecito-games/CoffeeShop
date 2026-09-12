//go:build windows

package harness

import (
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"time"
)

func configureProcessCancellation(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
	command.Cancel = func() error {
		if command.Process == nil {
			return os.ErrProcessDone
		}
		killer := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(command.Process.Pid))
		if err := killer.Run(); err != nil && command.ProcessState != nil && command.ProcessState.Exited() {
			return os.ErrProcessDone
		} else {
			return err
		}
	}
	command.WaitDelay = 2 * time.Second
}
