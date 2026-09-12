package harness

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestAuthorizeWorkspace(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "project")
	require.NoError(t, os.Mkdir(inside, 0o755))
	actual, err := AuthorizeWorkspace(inside, []string{root})
	require.NoError(t, err)
	want, err := filepath.EvalSymlinks(inside)
	require.NoError(t, err)
	require.Equal(t, want, actual)
}

func TestAuthorizeWorkspaceRejectsOutsideRoot(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	_, err := AuthorizeWorkspace(outside, []string{root})
	require.Error(t, err)
}

func TestAuthorizeWorkspaceRejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	link := filepath.Join(root, "escape")
	require.NoError(t, os.Symlink(outside, link))
	_, err := AuthorizeWorkspace(link, []string{root})
	require.Error(t, err)
}
