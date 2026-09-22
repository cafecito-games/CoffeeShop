package protocol

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestHubToolVocabularyMatchesSharedFixture(t *testing.T) {
	data, err := os.ReadFile("../../../../packages/protocol/test/fixtures/hub-tools/vocabulary.json")
	require.NoError(t, err)
	var vocabulary struct {
		ToolNames               []string `json:"toolNames"`
		DelegationToolNames     []string `json:"delegationToolNames"`
		TaskMessageKinds        []string `json:"taskMessageKinds"`
		MaximumWaitMilliseconds int      `json:"maximumWaitMilliseconds"`
		MaximumEventsPerWait    int      `json:"maximumEventsPerWait"`
	}
	require.NoError(t, json.Unmarshal(data, &vocabulary))
	require.Equal(t, vocabulary.ToolNames, HubToolNames)
	require.Equal(t, vocabulary.DelegationToolNames, DelegationHubToolNames)
	require.Equal(t, vocabulary.TaskMessageKinds, TaskMessageKinds)
	require.Equal(t, vocabulary.MaximumWaitMilliseconds, MaximumWaitMilliseconds)
	require.Equal(t, vocabulary.MaximumEventsPerWait, MaximumEventsPerWait)
	for _, name := range DelegationHubToolNames {
		require.True(t, IsHubToolName(name))
		require.True(t, IsDelegationHubToolName(name))
	}
	require.False(t, IsHubToolName("unknown_tool"))
}
