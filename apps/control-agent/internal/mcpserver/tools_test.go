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

func TestPublishPreviewSchemaKeepsPackagingAuthorityInBarista(t *testing.T) {
	definition := definitions["publish_preview"]
	require.Equal(t, []string{"relativePath", "entrypoint", "title", "idempotencyKey"}, definition.input["required"])
	properties := definition.input["properties"].(schema)
	require.ElementsMatch(t, []string{"relativePath", "entrypoint", "title", "summary", "ttlSeconds", "idempotencyKey"}, mapKeys(properties))
	for _, forbidden := range []string{"kind", "mediaType", "size", "sha256", "archive", "uploadPath"} {
		require.NotContains(t, properties, forbidden)
	}
	require.False(t, protocol.IsDelegationHubToolName("publish_preview"))
}

func TestInstanceLifecycleSchemasAreClosedAndSafe(t *testing.T) {
	spawn := definitions["spawn_instance"]
	require.Equal(t, []string{"idempotencyKey", "requirements"}, spawn.input["required"])
	spawnProperties := spawn.input["properties"].(schema)
	require.ElementsMatch(t, []string{"idempotencyKey", "requirements", "purpose", "idleTimeoutSeconds", "initialTask"}, mapKeys(spawnProperties))
	for _, forbidden := range []string{"threadId", "caller", "creator", "canDelegate", "policy", "connectionId"} {
		require.NotContains(t, spawnProperties, forbidden)
	}

	for _, name := range []string{"spawn_instance", "renew_instance", "release_instance"} {
		output := definitions[name].output
		require.Contains(t, output["required"], "replayed", name)
		instance := output["properties"].(schema)["instance"].(schema)
		require.Equal(t, false, instance["additionalProperties"], name)
		require.NotContains(t, instance["properties"].(schema), "creator", name)
		allocation := output["properties"].(schema)["allocation"].(schema)
		require.NotContains(t, allocation["properties"].(schema), "workspace", name)
	}
	require.True(t, definitions["get_instance"].readOnly)
	require.False(t, protocol.IsDelegationHubToolName("publish_preview"))
}

func mapKeys(value schema) []string {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	return keys
}
