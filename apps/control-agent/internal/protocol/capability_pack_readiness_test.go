package protocol

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

const capabilityPackReadinessFixture = "../../../../packages/protocol/test/fixtures/capability-pack-readiness/report.json"

func availablePackReadiness() CapabilityPackReadinessMessage {
	return CapabilityPackReadinessMessage{Type: "capability-pack.readiness", Report: CapabilityPackReadinessReport{
		NodeID: "node-one", ObservedAt: "2026-09-28T12:00:00Z", Status: "available",
		Pack: &CapabilityPackIdentity{ID: "coffeeshop-capability-pack", Version: "1.2.0", Skills: []string{
			"coffeeshop-artifacts", "coffeeshop-coordination", "coffeeshop-preview", "coffeeshop-task-reporting",
		}},
		Surfaces: []CapabilityPackSurface{{HarnessID: "claude-cli", Transport: "native-cli"}, {HarnessID: "codex-cli", Transport: "native-cli"}},
	}}
}

func TestCapabilityPackReadinessIsExactAndV5Only(t *testing.T) {
	message := availablePackReadiness()
	encoded, err := json.MarshalIndent(message, "", "  ")
	require.NoError(t, err)
	encoded = append(encoded, '\n')
	fixture, err := os.ReadFile(capabilityPackReadinessFixture)
	require.NoError(t, err)
	require.Equal(t, string(fixture), string(encoded), "the checked-in report must be the Go producer's exact bytes")
	decoded, err := DecodeCapabilityPackReadinessMessage(fixture, "5")
	require.NoError(t, err)
	require.Equal(t, message, decoded)
	for _, version := range []string{"1", "2", "3", "4", ""} {
		_, err := DecodeCapabilityPackReadinessMessage(encoded, version)
		require.Error(t, err)
	}
	for name, mutate := range map[string]func(*CapabilityPackReadinessMessage){
		"unsorted skills": func(candidate *CapabilityPackReadinessMessage) {
			candidate.Report.Pack.Skills = []string{"review", "preview"}
		},
		"duplicate surface": func(candidate *CapabilityPackReadinessMessage) {
			candidate.Report.Surfaces[1] = candidate.Report.Surfaces[0]
		},
		"reason on available": func(candidate *CapabilityPackReadinessMessage) { candidate.Report.ReasonCode = "not-selected" },
		"pack on unavailable": func(candidate *CapabilityPackReadinessMessage) {
			candidate.Report.Status = "unavailable"
			candidate.Report.ReasonCode = "not-selected"
		},
	} {
		t.Run(name, func(t *testing.T) {
			candidate := availablePackReadiness()
			mutate(&candidate)
			encoded, err := json.Marshal(candidate)
			require.NoError(t, err)
			_, err = DecodeCapabilityPackReadinessMessage(encoded, "5")
			require.Error(t, err)
		})
	}
}

func TestCapabilityPackExpectationAndProofValidate(t *testing.T) {
	expected := ExpectedCapabilityPack{ID: "coffeeshop-capability-pack", Version: "1.2.0", RequiredSkills: []string{"coffeeshop-preview"}}
	require.NoError(t, expected.Validate())
	require.Error(t, (ExpectedCapabilityPack{ID: expected.ID, Version: expected.Version, RequiredSkills: []string{}}).Validate())
	selection := RunTransportSelection{RequestedTransport: TransportNativeCLI, SelectedTransport: TransportNativeCLI,
		EffectiveCapabilityPack: &EffectiveCapabilityPack{ID: expected.ID, Version: expected.Version, Skills: []string{"coffeeshop-preview"}}}
	require.NoError(t, selection.Validate())
	selection.EffectiveCapabilityPack.Skills = nil
	require.Error(t, selection.Validate())
}

func TestCapabilityPackIdentifiersMatchTypeScriptBoundsAndGrammar(t *testing.T) {
	valid := ExpectedCapabilityPack{ID: strings.Repeat("a", 64), Version: "1.0.0", RequiredSkills: []string{strings.Repeat("b", 64)}}
	require.NoError(t, valid.Validate())
	for name, mutate := range map[string]func(*ExpectedCapabilityPack){
		"long id":    func(pack *ExpectedCapabilityPack) { pack.ID = strings.Repeat("a", 65) },
		"mixed id":   func(pack *ExpectedCapabilityPack) { pack.ID = "Mixed-Case" },
		"long skill": func(pack *ExpectedCapabilityPack) { pack.RequiredSkills = []string{strings.Repeat("b", 65)} },
		"mixed skill": func(pack *ExpectedCapabilityPack) {
			pack.RequiredSkills = []string{"Mixed-Case"}
		},
	} {
		t.Run(name, func(t *testing.T) {
			candidate := valid
			mutate(&candidate)
			require.Error(t, candidate.Validate())
			encoded, err := json.Marshal(candidate)
			require.NoError(t, err)
			var decoded any
			require.NoError(t, json.Unmarshal(encoded, &decoded))
			require.False(t, v5ExpectedCapabilityPack(decoded))
		})
	}
}
