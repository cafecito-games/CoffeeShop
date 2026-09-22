package workspace

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	// DefaultGitTimeout bounds every Git invocation, including a checkout of a large repository.
	DefaultGitTimeout = 2 * time.Minute
	// DefaultGitOutputBytes bounds captured standard output; larger output fails the command.
	DefaultGitOutputBytes = 1 << 20
	gitErrorOutputBytes   = 64 << 10
	gitWaitDelay          = 2 * time.Second
)

// Git invokes one fixed Git executable directly, never through a shell. Arguments are passed as
// separate process arguments, repository hooks and filesystem monitors are disabled, and inherited
// GIT_* variables that could redirect the repository, index, or configuration are removed.
type Git struct {
	Binary             string
	Timeout            time.Duration
	MaximumOutputBytes int
}

// FindGit resolves the git executable once so later invocations never depend on PATH.
func FindGit() (*Git, error) {
	path, err := exec.LookPath("git")
	if err != nil {
		return nil, err
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	return &Git{Binary: absolute, Timeout: DefaultGitTimeout, MaximumOutputBytes: DefaultGitOutputBytes}, nil
}

type GitErrorKind string

const (
	GitErrorStart   GitErrorKind = "start"
	GitErrorTimeout GitErrorKind = "timeout"
	GitErrorOutput  GitErrorKind = "output"
	GitErrorExit    GitErrorKind = "exit"
)

// GitError describes a failed invocation without repeating Git's output, which can contain paths
// or remote URLs with embedded credentials.
type GitError struct {
	Kind     GitErrorKind
	ExitCode int
}

func (err *GitError) Error() string {
	switch err.Kind {
	case GitErrorTimeout:
		return "git command timed out"
	case GitErrorOutput:
		return "git command output exceeded its bound"
	case GitErrorStart:
		return "git command could not start"
	default:
		return "git command failed"
	}
}

// exitedWith reports whether err is a normal Git exit with the given status.
func exitedWith(err error, code int) bool {
	var gitError *GitError
	return errors.As(err, &gitError) && gitError.Kind == GitErrorExit && gitError.ExitCode == code
}

type boundedBuffer struct {
	buffer   bytes.Buffer
	limit    int
	exceeded bool
	cancel   context.CancelFunc
}

func (writer *boundedBuffer) Write(data []byte) (int, error) {
	if writer.exceeded {
		return len(data), nil
	}
	if writer.buffer.Len()+len(data) > writer.limit {
		writer.exceeded = true
		if writer.cancel != nil {
			writer.cancel()
		}
		return len(data), nil
	}
	return writer.buffer.Write(data)
}

func (git *Git) environment() []string {
	environment := make([]string, 0, len(os.Environ())+4)
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(strings.ToUpper(name), "GIT_") || name == "LC_ALL" || name == "LANG" {
			continue
		}
		environment = append(environment, entry)
	}
	return append(environment, "GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0", "LC_ALL=C", "GIT_CONFIG_NOSYSTEM=1")
}

// Run executes git with arguments in directory and returns its bounded standard output.
func (git *Git) Run(ctx context.Context, directory string, arguments ...string) ([]byte, error) {
	timeout := git.Timeout
	if timeout <= 0 {
		timeout = DefaultGitTimeout
	}
	limit := git.MaximumOutputBytes
	if limit <= 0 {
		limit = DefaultGitOutputBytes
	}
	commandContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	fixed := []string{"-c", "core.hooksPath=" + os.DevNull, "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"}
	command := exec.CommandContext(commandContext, git.Binary, append(fixed, arguments...)...)
	command.Dir = directory
	command.Env = git.environment()
	command.WaitDelay = gitWaitDelay
	output := &boundedBuffer{limit: limit, cancel: cancel}
	command.Stdout = output
	command.Stderr = &boundedBuffer{limit: gitErrorOutputBytes}
	err := command.Run()
	switch {
	case output.exceeded:
		return nil, &GitError{Kind: GitErrorOutput}
	case errors.Is(commandContext.Err(), context.DeadlineExceeded):
		return nil, &GitError{Kind: GitErrorTimeout}
	case err == nil:
		return output.buffer.Bytes(), nil
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) && exitError.ExitCode() >= 0 {
		return output.buffer.Bytes(), &GitError{Kind: GitErrorExit, ExitCode: exitError.ExitCode()}
	}
	if ctx.Err() != nil {
		return nil, &GitError{Kind: GitErrorTimeout}
	}
	return nil, &GitError{Kind: GitErrorStart}
}
