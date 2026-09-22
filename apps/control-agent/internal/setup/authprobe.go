package setup

import (
	"context"
	"errors"
	"os/exec"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

// authProbeTimeout bounds every auth readiness probe, matching the daemon's own discovery probes.
const authProbeTimeout = 5 * time.Second

// authProbeMaximumOutputBytes caps how much combined probe output is ever retained in memory for
// the secret screen. Output beyond the cap is discarded, not buffered.
const authProbeMaximumOutputBytes = 4096

// AuthReadiness is a coarse, tri-state signal. It is never derived from raw command output text —
// only from exit status — and raw output is never retained or returned.
type AuthReadiness string

const (
	AuthReadinessReady    AuthReadiness = "ready"
	AuthReadinessNotReady AuthReadiness = "not-ready"
	// AuthReadinessUnknown covers a binary that was not found or a probe that timed out: an absent
	// harness is a different fact than an installed-but-unauthenticated one, and doctor must never
	// conflate them.
	AuthReadinessUnknown AuthReadiness = "unknown"
)

// RunAuthProbe executes probe.Binary via exec.LookPath (never a literal path, never a shell) with
// probe.Arguments, under a bounded timeout, and returns AuthReadinessReady only when the process
// exits with probe.SuccessExitCode. Any other exit code is AuthReadinessNotReady. A missing binary
// or a timeout is AuthReadinessUnknown, never NotReady. Combined stdout+stderr is captured only to
// check whether it looks secret-like; if it does, that fact alone downgrades the result to
// AuthReadinessUnknown (never surfaced) rather than trusting an exit code that might have been
// influenced by unexpectedly credential-bearing output. The raw output itself is never part of the
// return value.
func RunAuthProbe(ctx context.Context, probe AuthProbe) AuthReadiness {
	path, err := exec.LookPath(probe.Binary)
	if err != nil {
		return AuthReadinessUnknown
	}
	timeoutContext, cancel := context.WithTimeout(ctx, authProbeTimeout)
	defer cancel()
	command := exec.CommandContext(timeoutContext, path, probe.Arguments...)
	var captured authProbeOutput
	command.Stdout = &captured
	command.Stderr = &captured
	runErr := command.Run()
	if timeoutContext.Err() == context.DeadlineExceeded {
		return AuthReadinessUnknown
	}
	if protocol.LooksSecretLike(captured.String()) {
		return AuthReadinessUnknown
	}
	exitCode := 0
	if runErr != nil {
		var exitErr *exec.ExitError
		if !errors.As(runErr, &exitErr) {
			return AuthReadinessUnknown
		}
		exitCode = exitErr.ExitCode()
	}
	if exitCode == probe.SuccessExitCode {
		return AuthReadinessReady
	}
	return AuthReadinessNotReady
}

// authProbeOutput keeps at most authProbeMaximumOutputBytes of combined stdout+stderr. Write never
// fails and always reports the full chunk length so a child writing past the cap never blocks on a
// short write; the retained prefix is all the secret screen needs.
type authProbeOutput struct {
	data []byte
}

func (output *authProbeOutput) Write(chunk []byte) (int, error) {
	if remaining := authProbeMaximumOutputBytes - len(output.data); remaining > 0 {
		held := min(len(chunk), remaining)
		output.data = append(output.data, chunk[:held]...)
	}
	return len(chunk), nil
}

func (output *authProbeOutput) String() string {
	return string(output.data)
}
