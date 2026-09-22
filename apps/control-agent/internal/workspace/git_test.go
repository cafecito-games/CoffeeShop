package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRunFailsWhenOutputExceedsItsBound(t *testing.T) {
	fixture := newFixture(t)
	limited := *fixture.git
	limited.MaximumOutputBytes = 16

	_, err := limited.Run(context.Background(), fixture.source, "log")
	require.Error(t, err)
	var gitError *GitError
	require.True(t, errors.As(err, &gitError))
	require.Equal(t, GitErrorOutput, gitError.Kind)
}

func TestRunTimesOut(t *testing.T) {
	fixture := newFixture(t)
	impatient := *fixture.git
	impatient.Timeout = 1

	_, err := impatient.Run(context.Background(), fixture.source, "log", "--all", "--full-history")
	require.Error(t, err)
	var gitError *GitError
	require.True(t, errors.As(err, &gitError))
	require.Equal(t, GitErrorTimeout, gitError.Kind)
}

func TestRunReportsExitCode(t *testing.T) {
	fixture := newFixture(t)

	_, err := fixture.git.Run(context.Background(), fixture.source, "rev-parse", "--verify", "--quiet", "refs/heads/missing")
	require.Error(t, err)
	var gitError *GitError
	require.True(t, errors.As(err, &gitError))
	require.Equal(t, GitErrorExit, gitError.Kind)
	require.Equal(t, 1, gitError.ExitCode)
	require.True(t, exitedWith(err, 1))
	require.False(t, exitedWith(err, 2))
}

func TestRunIgnoresInheritedGitEnvironment(t *testing.T) {
	fixture := newFixture(t)
	t.Setenv("GIT_DIR", "/nonexistent")
	t.Setenv("GIT_WORK_TREE", "/nonexistent")

	output, err := fixture.git.Run(context.Background(), fixture.source, "rev-parse", "--show-toplevel")
	require.NoError(t, err)
	require.Equal(t, fixture.source, strings.TrimSpace(string(output)))
}

func TestProvisionDoesNotRunRepositoryHooks(t *testing.T) {
	fixture := newFixture(t)
	marker := filepath.Join(t.TempDir(), "hook-ran")
	hook := filepath.Join(fixture.source, ".git", "hooks", "post-checkout")
	script := "#!/bin/sh\necho ran > " + marker + "\n"
	require.NoError(t, os.WriteFile(hook, []byte(script), 0o755))

	manager := NewManager([]string{fixture.root}, fixture.git)
	grant := fixture.grant("lease_hook", "task_hook", "run_hook")
	outcome := manager.Provision(context.Background(), grant, "task_hook", "run_hook")
	require.Equal(t, "active", outcome.Status, outcome.Detail)
	require.NoFileExists(t, marker)
}

func TestGitErrorMessagesNeverRepeatPathsOrUrls(t *testing.T) {
	fixture := newFixture(t)
	for _, gitError := range []*GitError{
		{Kind: GitErrorStart},
		{Kind: GitErrorTimeout},
		{Kind: GitErrorOutput},
		{Kind: GitErrorExit, ExitCode: 128},
	} {
		message := gitError.Error()
		require.NotContains(t, message, fixture.source)
		require.NotContains(t, message, fixture.root)
		require.NotContains(t, message, "example.com")
		require.NotContains(t, message, "token@")
	}
}
