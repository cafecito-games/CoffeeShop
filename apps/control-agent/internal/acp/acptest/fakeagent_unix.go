//go:build !windows

package acptest

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
)

func init() {
	Scenarios["escaped-stdio-holder"] = join(Handshake(DefaultCapabilities), []Step{
		EscapeWithStdio(),
		Hang(),
	})
}

// EscapeWithStdio starts a descendant in a new session, outside the agent's process group, that
// inherits stdin and stdout and never reads. Killing the agent's process tree does not reach it,
// so adapter stdin fills and stays open. The descendant PID is recorded like IgnoreTermination.
func EscapeWithStdio() Step {
	return func(agent *Agent) error {
		descendant := exec.Command(os.Args[0])
		descendant.Env = append(os.Environ(), ScenarioEnvironment+"=hang")
		descendant.Stdin = os.Stdin
		descendant.Stdout = os.Stdout
		descendant.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		if err := descendant.Start(); err != nil {
			return err
		}
		if agent.record != nil {
			_, _ = fmt.Fprintf(agent.record, "{\"descendantPid\":%d}\n", descendant.Process.Pid)
		}
		return nil
	}
}
