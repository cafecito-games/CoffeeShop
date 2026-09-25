package setup

import (
	"context"
	"errors"
	"os/exec"
	"path/filepath"
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

// AuthProbeSpec is a fixed, compiled-in, read-only vendor command doctor may run against an
// already-discovered harness binary to report coarse authentication presence. It never carries a
// binary path — only the arguments and expected exit code — because the binary always comes from
// harness discovery's own resolved, absolute path, never from this spec or from any external
// input.
type AuthProbeSpec struct {
	Arguments       []string
	SuccessExitCode int
}

// AuthProbeAllowlist maps a harness ID (matching the provider ids internal/harness/discovery.go
// defines) to its fixed auth-readiness probe. This is the single, compiled-in source of what
// doctor is ever allowed to execute for auth readiness: extending doctor to a new harness means
// adding an entry here in source and rebuilding Barista, never accepting a command or argument
// list from the adapter manifest (which, through --manifest, can point at an arbitrary local
// file), the hub, or any other external input.
var AuthProbeAllowlist = map[string]AuthProbeSpec{
	"claude-cli": {Arguments: []string{"--version"}, SuccessExitCode: 0},
	"codex-cli":  {Arguments: []string{"--version"}, SuccessExitCode: 0},
}

// RunAuthProbe executes binaryPath with arguments under a bounded timeout and returns
// AuthReadinessReady only when the process exits with successExitCode. Any other exit code is
// AuthReadinessNotReady. A probe that cannot start or times out is AuthReadinessUnknown, never
// NotReady. binaryPath must be an absolute path already resolved by harness discovery —
// RunAuthProbe performs no PATH lookup and no shell of its own, and every caller in this codebase
// sources binaryPath from a discovered protocol.HarnessProfile.Binary, never from manifest text.
// Combined stdout+stderr is captured only to check whether it looks secret-like; if it does, that
// fact alone downgrades the result to AuthReadinessUnknown (never surfaced) rather than trusting
// an exit code that might have been influenced by unexpectedly credential-bearing output. The raw
// output itself is never part of the return value.
func RunAuthProbe(ctx context.Context, binaryPath string, arguments []string, successExitCode int) AuthReadiness {
	readiness, _ := runProbeCapturingOutput(ctx, binaryPath, arguments, successExitCode)
	return readiness
}

// runProbeCapturingOutput is the one child-process reader every compiled-in probe in this package
// goes through. It is RunAuthProbe's whole implementation and additionally returns the bounded,
// already secret-screened combined output, for the one caller that must read the executable's own
// claim rather than only its exit status: ProbeHarnessVersion, which has to compare the reported
// version against the pinned one.
//
// The returned output is non-empty only alongside AuthReadinessReady, and never when the output
// looked secret-like — a secret-like output is AuthReadinessUnknown with no output at all, so no
// caller can accidentally surface it. Callers must still keep it out of every error, log, and
// report: it is process output, not a diagnostic.
func runProbeCapturingOutput(ctx context.Context, binaryPath string, arguments []string, successExitCode int) (AuthReadiness, string) {
	if !filepath.IsAbs(binaryPath) {
		return AuthReadinessUnknown, ""
	}
	timeoutContext, cancel := context.WithTimeout(ctx, authProbeTimeout)
	defer cancel()
	command := exec.CommandContext(timeoutContext, binaryPath, arguments...)
	var captured authProbeOutput
	command.Stdout = &captured
	command.Stderr = &captured
	runErr := command.Run()
	if timeoutContext.Err() == context.DeadlineExceeded {
		return AuthReadinessUnknown, ""
	}
	output := captured.String()
	if protocol.LooksSecretLike(output) {
		return AuthReadinessUnknown, ""
	}
	exitCode := 0
	if runErr != nil {
		var exitErr *exec.ExitError
		if !errors.As(runErr, &exitErr) {
			return AuthReadinessUnknown, ""
		}
		exitCode = exitErr.ExitCode()
	}
	if exitCode == successExitCode {
		return AuthReadinessReady, output
	}
	return AuthReadinessNotReady, ""
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
