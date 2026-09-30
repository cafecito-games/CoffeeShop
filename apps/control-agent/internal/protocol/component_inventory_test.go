package protocol

import (
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

const componentInventoryFixture = "../../../../packages/protocol/test/fixtures/component-inventory/report.json"
const invalidComponentInventoryFixture = "../../../../packages/protocol/test/fixtures/component-inventory/invalid-reports.json"

func componentInventoryProducer() ComponentInventoryMessage {
	return ComponentInventoryMessage{Type: "component.inventory", Report: ComponentInventoryReport{
		NodeID: "node-one", ObservedAt: "2026-09-28T12:00:00Z",
		Components: []ComponentInventoryEntry{
			{Kind: "acp-adapter", ID: "claude-acp", HarnessID: "claude-cli", DeclaredVersion: "2.0.0", InstalledVersions: []string{"1.0.0", "2.0.0"}, ActiveVersion: "1.0.0", RollbackVersion: "2.0.0", Provenance: "managed", Readiness: "ready", UpdateVersion: "2.0.0", RollbackAvailable: true, DiagnosticCodes: []string{"rollback-available", "update-available"}},
			{Kind: "capability-pack", ID: "coffee-shop-default", DeclaredVersion: "1.0.0", InstalledVersions: []string{}, Provenance: "none", Readiness: "not-applicable", DiagnosticCodes: []string{}},
			{Kind: "harness", ID: "codex-cli", HarnessID: "codex-cli", DeclaredVersion: "1.2.3", InstalledVersions: []string{}, Provenance: "external", Readiness: "ready", DiagnosticCodes: []string{}},
		},
	}}
}

func TestComponentInventoryProducerFixtureIsByteFaithful(t *testing.T) {
	encoded, err := json.MarshalIndent(componentInventoryProducer(), "", "  ")
	require.NoError(t, err)
	encoded = append(encoded, '\n')
	fixture, err := os.ReadFile(componentInventoryFixture)
	require.NoError(t, err)
	require.Equal(t, string(fixture), string(encoded))
	decoded, err := DecodeComponentInventoryMessage(fixture, "5")
	require.NoError(t, err)
	require.Equal(t, componentInventoryProducer(), decoded)
	for _, version := range []string{"1", "2", "3", "4", ""} {
		_, err := DecodeComponentInventoryMessage(fixture, version)
		require.Error(t, err)
	}
}

func TestComponentInventoryRejectsClosedContractViolations(t *testing.T) {
	mutations := map[string]func(*ComponentInventoryMessage){
		"unknown kind": func(message *ComponentInventoryMessage) { message.Report.Components[0].Kind = "plugin" },
		"duplicate key": func(message *ComponentInventoryMessage) {
			message.Report.Components = append(message.Report.Components[:1], message.Report.Components[0])
		},
		"unsorted versions": func(message *ComponentInventoryMessage) {
			message.Report.Components[0].InstalledVersions = []string{"2.0.0", "1.0.0"}
		},
		"unknown diagnostic": func(message *ComponentInventoryMessage) {
			message.Report.Components[0].DiagnosticCodes = []string{"raw-error"}
		},
		"rollback conflict":         func(message *ComponentInventoryMessage) { message.Report.Components[0].RollbackAvailable = false },
		"pack executable readiness": func(message *ComponentInventoryMessage) { message.Report.Components[1].Readiness = "ready" },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			candidate := componentInventoryProducer()
			mutate(&candidate)
			encoded, err := json.Marshal(candidate)
			require.NoError(t, err)
			_, err = DecodeComponentInventoryMessage(encoded, "5")
			require.Error(t, err)
		})
	}
}

func TestComponentInventoryRequiresEveryNonOptionalJSONKey(t *testing.T) {
	encoded, err := json.Marshal(componentInventoryProducer())
	require.NoError(t, err)
	var envelope map[string]any
	require.NoError(t, json.Unmarshal(encoded, &envelope))
	for _, key := range []string{"kind", "id", "declaredVersion", "installedVersions", "provenance", "readiness", "rollbackAvailable", "diagnosticCodes"} {
		candidate := structuredCloneJSON(t, envelope)
		candidateEntry := candidate["report"].(map[string]any)["components"].([]any)[0].(map[string]any)
		delete(candidateEntry, key)
		bytes, err := json.Marshal(candidate)
		require.NoError(t, err)
		_, err = DecodeComponentInventoryMessage(bytes, "5")
		require.Error(t, err, key)
	}
}

func structuredCloneJSON(t *testing.T, value map[string]any) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(value)
	require.NoError(t, err)
	var cloned map[string]any
	require.NoError(t, json.Unmarshal(encoded, &cloned))
	return cloned
}

func TestComponentInventoryRejectsSharedLanguageNeutralInvalidFixtures(t *testing.T) {
	fixture, err := os.ReadFile(invalidComponentInventoryFixture)
	require.NoError(t, err)
	var cases []struct {
		Name    string          `json:"name"`
		Message json.RawMessage `json:"message"`
	}
	require.NoError(t, json.Unmarshal(fixture, &cases))
	require.NotEmpty(t, cases)
	for _, candidate := range cases {
		t.Run(candidate.Name, func(t *testing.T) {
			_, err := DecodeComponentInventoryMessage(candidate.Message, "5")
			require.Error(t, err)
		})
	}
}

func TestComponentInventoryEnforcesExactCountAndStringBoundaries(t *testing.T) {
	entry := componentInventoryProducer().Report.Components[2]
	entry.ID = strings.Repeat("a", 128)
	require.NoError(t, entry.Validate())
	entry.ID += "a"
	require.Error(t, entry.Validate())

	entry = componentInventoryProducer().Report.Components[2]
	entry.InstalledVersions = make([]string, ComponentVersionLimit)
	for index := range entry.InstalledVersions {
		entry.InstalledVersions[index] = fmt.Sprintf("1.%d", index)
	}
	slices.Sort(entry.InstalledVersions)
	require.NoError(t, entry.Validate())
	entry.InstalledVersions = append(entry.InstalledVersions, "99.0")
	require.Error(t, entry.Validate())

	report := componentInventoryProducer().Report
	report.Components = make([]ComponentInventoryEntry, ComponentInventoryLimit)
	for index := range report.Components {
		report.Components[index] = componentInventoryProducer().Report.Components[2]
		report.Components[index].ID = fmt.Sprintf("component-%02d", index)
		report.Components[index].HarnessID = report.Components[index].ID
	}
	require.NoError(t, report.Validate())
	report.Components = append(report.Components, componentInventoryProducer().Report.Components[2])
	require.Error(t, report.Validate())

	report = componentInventoryProducer().Report
	report.Components = nil
	require.Error(t, report.Validate())
	entry = componentInventoryProducer().Report.Components[2]
	entry.InstalledVersions = nil
	require.Error(t, entry.Validate())
	entry = componentInventoryProducer().Report.Components[2]
	entry.DiagnosticCodes = nil
	require.Error(t, entry.Validate())
}
