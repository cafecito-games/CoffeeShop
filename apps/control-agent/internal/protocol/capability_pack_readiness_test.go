package protocol

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

const capabilityPackReadinessFixture = "../../../../packages/protocol/test/fixtures/capability-pack-readiness/report.json"

func availablePackReadiness() CapabilityPackReadinessMessage {
	return CapabilityPackReadinessMessage{Type: "capability-pack.readiness", Report: CapabilityPackReadinessReport{
		NodeID: "node-one", ObservedAt: "2026-09-28T12:00:00Z", Status: "available",
		Pack: &CapabilityPackIdentity{ID: "coffeeshop-capability-pack", Version: "1.1.0", Skills: []string{
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
	for _, version := range []string{"1", "2", "3", "4", "6", ""} {
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
	expected := ExpectedCapabilityPack{ID: "coffeeshop-capability-pack", Version: "1.1.0", RequiredSkills: []string{"coffeeshop-preview"}}
	require.NoError(t, expected.Validate())
	require.Error(t, (ExpectedCapabilityPack{ID: expected.ID, Version: expected.Version, RequiredSkills: []string{}}).Validate())
	selection := RunTransportSelection{RequestedTransport: TransportNativeCLI, SelectedTransport: TransportNativeCLI,
		EffectiveCapabilityPack: &EffectiveCapabilityPack{ID: expected.ID, Version: expected.Version, Skills: []string{"coffeeshop-preview"}}}
	require.NoError(t, selection.Validate())
	selection.EffectiveCapabilityPack.Skills = nil
	require.Error(t, selection.Validate())
}
