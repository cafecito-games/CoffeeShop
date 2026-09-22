package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// The fixture is shared with packages/protocol/test/workspace-leases.test.mjs, so both languages
// must produce identical identities for every URL.
func TestNormalizeRepositoryIdentityMatchesTheSharedFixture(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("../../../../packages/protocol/test/fixtures", "repository-identities.json"))
	require.NoError(t, err)
	var cases []struct {
		URL      string  `json:"url"`
		Identity *string `json:"identity"`
	}
	require.NoError(t, json.Unmarshal(data, &cases))
	require.GreaterOrEqual(t, len(cases), 5)
	for _, testCase := range cases {
		identity, ok := NormalizeRepositoryIdentity(testCase.URL)
		if testCase.Identity == nil {
			require.False(t, ok, testCase.URL)
			require.Empty(t, identity, testCase.URL)
			continue
		}
		require.True(t, ok, testCase.URL)
		require.Equal(t, *testCase.Identity, identity, testCase.URL)
	}
}

func TestNormalizeRepositoryIdentityNeverKeepsAPasswordSuffix(t *testing.T) {
	identity, ok := NormalizeRepositoryIdentity("https://user:p@ss@host/repo")
	require.True(t, ok)
	require.Equal(t, "https://host/repo", identity)
	require.False(t, strings.Contains(identity, "ss"))
}

func TestGrantValidationRejectsARepositoryThatIsNotCredentialFree(t *testing.T) {
	grant := WorkspaceLeaseGrant{
		ID: "lease-one", Status: "requested", Policy: WorkspaceIsolationGitWorktree, Cleanup: WorkspaceCleanupRetain,
		Repository: "https://host/repo", Root: "/srv", SourcePath: "/srv/repo", BaseRevision: "refs/heads/main",
		Branch: "coffee-shop/task-one/run-one", WorktreePath: "/srv/.coffee-shop/worktrees/lease-one",
	}
	require.NoError(t, grant.Validate())
	for _, repository := range []string{"https://user:p@ss@host/repo", "ss@host/repo", "https://host/ghp_abcdefghijklmnopqrstuvwxyz0123456789/repo"} {
		grant.Repository = repository
		require.Error(t, grant.Validate(), repository)
	}
}
