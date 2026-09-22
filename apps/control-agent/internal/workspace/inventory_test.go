package workspace

import (
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

const inventoryHead = "0123456789abcdef0123456789abcdef01234567"

func TestParseWorktreeListReadsEveryKnownAttribute(t *testing.T) {
	output := strings.Join([]string{
		"worktree /repo/main\x00HEAD " + inventoryHead + "\x00branch refs/heads/main\x00\x00",
		"worktree /repo/linked\x00HEAD " + inventoryHead + "\x00branch refs/heads/feature\x00\x00",
		"worktree /repo/detached\x00HEAD " + inventoryHead + "\x00detached\x00\x00",
		"worktree /repo/bare.git\x00bare\x00\x00",
		"worktree /repo/locked\x00HEAD " + inventoryHead + "\x00branch refs/heads/locked\x00locked reason: flaky disk\x00\x00",
		"worktree /repo/prunable\x00HEAD " + inventoryHead + "\x00branch refs/heads/prunable\x00prunable worktree path is gone\x00\x00",
	}, "")

	worktrees, err := ParseWorktreeList([]byte(output))
	require.NoError(t, err)
	require.Len(t, worktrees, 6)
	require.Equal(t, Worktree{Path: "/repo/main", Head: inventoryHead, Branch: "refs/heads/main"}, worktrees[0])
	require.Equal(t, Worktree{Path: "/repo/linked", Head: inventoryHead, Branch: "refs/heads/feature"}, worktrees[1])
	require.True(t, worktrees[2].Detached)
	require.False(t, worktrees[2].Bare)
	require.True(t, worktrees[3].Bare)
	require.True(t, worktrees[4].Locked)
	require.True(t, worktrees[5].Prunable)
}

func TestParseWorktreeListKeepsPathsWithNewlinesAndSpaces(t *testing.T) {
	output := "worktree /repo/with space\nand newline\x00HEAD " + inventoryHead + "\x00branch refs/heads/main\x00\x00"

	worktrees, err := ParseWorktreeList([]byte(output))
	require.NoError(t, err)
	require.Len(t, worktrees, 1)
	require.Equal(t, "/repo/with space\nand newline", worktrees[0].Path)
}

func TestParseWorktreeListMarksUnknownAttributesUnrecognized(t *testing.T) {
	output := "worktree /repo/main\x00HEAD " + inventoryHead + "\x00branch refs/heads/main\x00shiny-new-attribute value\x00\x00"

	worktrees, err := ParseWorktreeList([]byte(output))
	require.NoError(t, err)
	require.Len(t, worktrees, 1)
	require.True(t, worktrees[0].Unrecognized)
}

func TestParseWorktreeListAcceptsEmptyOutput(t *testing.T) {
	worktrees, err := ParseWorktreeList(nil)
	require.NoError(t, err)
	require.Empty(t, worktrees)
}

func TestParseWorktreeListRejectsMalformedOutput(t *testing.T) {
	cases := map[string][]byte{
		"missing trailing NUL":              []byte("worktree /repo/main\x00HEAD " + inventoryHead),
		"record not starting with worktree": []byte("HEAD " + inventoryHead + "\x00\x00"),
		"relative worktree path":            []byte("worktree repo/main\x00\x00"),
		"worktree attribute twice":          []byte("worktree /repo/main\x00worktree /repo/other\x00\x00"),
		"empty record at start":             []byte("\x00worktree /repo/main\x00\x00"),
	}
	for name, output := range cases {
		_, err := ParseWorktreeList(output)
		require.Error(t, err, name)
		require.ErrorIs(t, err, errMalformedInventory, name)
	}
}

func TestParseStatusClassifiesEntries(t *testing.T) {
	cases := map[string]struct {
		output    string
		modified  int
		untracked int
		ignored   int
	}{
		"modified in worktree":      {output: " M file.txt\x00", modified: 1},
		"staged only":               {output: "M  file.txt\x00", modified: 1},
		"untracked":                 {output: "?? file.txt\x00", untracked: 1},
		"ignored counted apart":     {output: "!! build/output.log\x00", ignored: 1},
		"rename counts once":        {output: "R  new.txt\x00old.txt\x00", modified: 1},
		"rename in worktree column": {output: " R new.txt\x00old.txt\x00", modified: 1},
		"copy counts once":          {output: "C  new.txt\x00old.txt\x00", modified: 1},
		"mixed":                     {output: "?? added.txt\x00M  staged.txt\x00 R moved\x00origin\x00!! skipped\x00", modified: 2, untracked: 1, ignored: 1},
	}
	for name, testCase := range cases {
		summary, err := ParseStatus([]byte(testCase.output))
		require.NoError(t, err, name)
		require.Equal(t, testCase.modified, summary.Modified, name)
		require.Equal(t, testCase.untracked, summary.Untracked, name)
		require.Equal(t, testCase.ignored, summary.Ignored, name)
	}
}

func TestParseStatusAcceptsEmptyOutput(t *testing.T) {
	summary, err := ParseStatus(nil)
	require.NoError(t, err)
	require.Equal(t, StatusSummary{}, summary)
}

func TestParseStatusRejectsMalformedOutput(t *testing.T) {
	cases := map[string][]byte{
		"short entry":           []byte("M\x00"),
		"missing column gap":    []byte("Mfile.txt\x00"),
		"missing trailing NUL":  []byte("M  file.txt"),
		"rename without source": []byte("R  new.txt\x00"),
	}
	for name, output := range cases {
		_, err := ParseStatus(output)
		require.Error(t, err, name)
		require.ErrorIs(t, err, errMalformedInventory, name)
	}
}

func TestParseWorktreeListReadsRealGitInventory(t *testing.T) {
	fixture := newFixture(t)
	linked := filepath.Join(fixture.root, "linked")
	runGit(t, fixture.source, "worktree", "add", "--quiet", "-b", "feature", "--", linked, "main")

	command := exec.Command("git", "worktree", "list", "--porcelain", "-z")
	command.Dir = fixture.source
	output, err := command.Output()
	require.NoError(t, err)

	worktrees, err := ParseWorktreeList(output)
	require.NoError(t, err)
	require.Len(t, worktrees, 2)
	require.Equal(t, fixture.source, worktrees[0].Path)
	require.Equal(t, "refs/heads/main", worktrees[0].Branch)
	require.Equal(t, linked, worktrees[1].Path)
	require.Equal(t, "refs/heads/feature", worktrees[1].Branch)
	require.Equal(t, fixture.base, worktrees[1].Head)
}
