package mcpserver

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

// toolFixturePath is the shared fixture the hub validates its structured tool results against.
const toolFixturePath = "../../../../packages/protocol/test/fixtures/hub-tools/tools.json"

func TestEveryHubToolHasADefinition(t *testing.T) {
	require.Len(t, definitions, len(protocol.HubToolNames))
	for _, name := range protocol.HubToolNames {
		definition, ok := definitions[name]
		require.True(t, ok, name)
		require.Equal(t, "object", definition.input["type"], name)
		require.Equal(t, false, definition.input["additionalProperties"], name)
		require.Equal(t, "object", definition.output["type"], name)
	}
	require.Equal(t, protocol.HubToolNames, ToolNames(true))
	for _, name := range ToolNames(false) {
		require.False(t, protocol.IsDelegationHubToolName(name))
	}
}

func TestToolSchemasMatchSharedFixture(t *testing.T) {
	encoded, err := json.MarshalIndent(tools(true), "", "  ")
	require.NoError(t, err)
	encoded = append(encoded, '\n')
	if os.Getenv("UPDATE_HUB_TOOL_FIXTURE") == "1" {
		require.NoError(t, os.WriteFile(toolFixturePath, encoded, 0o644))
	}
	fixture, err := os.ReadFile(toolFixturePath)
	require.NoError(t, err, "run with UPDATE_HUB_TOOL_FIXTURE=1 to regenerate the fixture")
	require.JSONEq(t, string(fixture), string(encoded))
}
