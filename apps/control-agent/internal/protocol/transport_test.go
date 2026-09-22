package protocol

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func validAcpSelection() RunTransportSelection {
	return RunTransportSelection{
		RequestedTransport: TransportACP,
		SelectedTransport:  TransportACP,
		Adapter:            &ACPAdapterProvenance{ID: "codex-acp", Version: "1.12.0", Source: ACPAdapterSourceSetupLedger},
		ACP: &AcpAgentCapabilities{
			ProtocolVersion: 1,
			Prompt:          AcpPromptCapabilities{Image: true, EmbeddedContext: true},
			Mcp:             AcpMcpCapabilities{HTTP: true},
			AdapterName:     "@agentclientprotocol/codex-acp",
			AdapterVersion:  "1.12.0",
		},
	}
}

func TestRunTransportSelectionValidateAcceptsEveryWellFormedSelection(t *testing.T) {
	acpSelection := validAcpSelection()
	nativeSelection := RunTransportSelection{
		RequestedTransport: TransportNativeCLI,
		SelectedTransport:  TransportNativeCLI,
		HarnessVersion:     "0.154.0",
		Adapter:            &ACPAdapterProvenance{ID: "codex-acp", Version: "1.12.0", Source: ACPAdapterSourceAdministrator},
	}
	valid := []RunTransportSelection{acpSelection, nativeSelection}
	for _, reason := range TransportFallbackReasons {
		fallback := RunTransportSelection{
			RequestedTransport: TransportACP,
			SelectedTransport:  TransportNativeCLI,
			FallbackReason:     reason,
			HarnessVersion:     "0.154.0",
		}
		valid = append(valid, fallback)
	}
	for index, selection := range valid {
		require.NoError(t, selection.Validate(), "selection %d (%s -> %s)", index, selection.RequestedTransport, selection.SelectedTransport)
	}
}

func TestRunTransportSelectionValidateRejectsMalformedSelections(t *testing.T) {
	tests := []struct {
		name      string
		selection RunTransportSelection
		want      string
	}{
		{
			name:      "unknown requested transport",
			selection: RunTransportSelection{RequestedTransport: "carrier-pigeon", SelectedTransport: TransportNativeCLI},
			want:      "transport selection names an unknown transport",
		},
		{
			name:      "unknown selected transport",
			selection: RunTransportSelection{RequestedTransport: TransportACP, SelectedTransport: "carrier-pigeon"},
			want:      "transport selection names an unknown transport",
		},
		{
			name: "fallback reason without a fallback",
			selection: RunTransportSelection{
				RequestedTransport: TransportACP, SelectedTransport: TransportACP, FallbackReason: FallbackACPAdapterUnavailable,
			},
			want: "transport selection has a fallback reason without a fallback",
		},
		{
			name: "native to acp fallback",
			selection: RunTransportSelection{
				RequestedTransport: TransportNativeCLI, SelectedTransport: TransportACP, FallbackReason: FallbackACPAdapterUnavailable,
			},
			want: "transport selection falls back other than from acp-v1 to native-cli for a known reason",
		},
		{
			name: "acp to native without a reason",
			selection: RunTransportSelection{
				RequestedTransport: TransportACP, SelectedTransport: TransportNativeCLI,
			},
			want: "transport selection falls back other than from acp-v1 to native-cli for a known reason",
		},
		{
			name: "acp to native for an unknown reason",
			selection: RunTransportSelection{
				RequestedTransport: TransportACP, SelectedTransport: TransportNativeCLI, FallbackReason: "adapter-was-sad",
			},
			want: "transport selection falls back other than from acp-v1 to native-cli for a known reason",
		},
		{
			name: "non-normalized harness version",
			selection: RunTransportSelection{
				RequestedTransport: TransportNativeCLI, SelectedTransport: TransportNativeCLI, HarnessVersion: "v1",
			},
			want: "transport selection harness version is not a normalized version",
		},
		{
			name: "adapter id that is not kebab-case",
			selection: RunTransportSelection{
				RequestedTransport: TransportACP, SelectedTransport: TransportACP,
				Adapter: &ACPAdapterProvenance{ID: "Codex_ACP", Version: "1.12.0", Source: ACPAdapterSourceSetupLedger},
			},
			want: "transport selection adapter provenance is malformed",
		},
		{
			name: "adapter version that is not normalized",
			selection: RunTransportSelection{
				RequestedTransport: TransportACP, SelectedTransport: TransportACP,
				Adapter: &ACPAdapterProvenance{ID: "codex-acp", Version: "1.12.0-beta", Source: ACPAdapterSourceSetupLedger},
			},
			want: "transport selection adapter provenance is malformed",
		},
		{
			name: "adapter from an unknown source",
			selection: RunTransportSelection{
				RequestedTransport: TransportACP, SelectedTransport: TransportACP,
				Adapter: &ACPAdapterProvenance{ID: "codex-acp", Version: "1.12.0", Source: "vendor-download"},
			},
			want: "transport selection adapter provenance is malformed",
		},
		{
			name: "acp capabilities on a native selection",
			selection: RunTransportSelection{
				RequestedTransport: TransportNativeCLI, SelectedTransport: TransportNativeCLI,
				ACP: &AcpAgentCapabilities{ProtocolVersion: 1},
			},
			want: "transport selection carries ACP capabilities for a native run",
		},
		{
			name: "acp capabilities naming an unsupported protocol version",
			selection: RunTransportSelection{
				RequestedTransport: TransportACP, SelectedTransport: TransportACP,
				ACP: &AcpAgentCapabilities{ProtocolVersion: 2},
			},
			want: "ACP capabilities name an unsupported protocol version",
		},
		{
			name: "secret-like adapter name",
			selection: RunTransportSelection{
				RequestedTransport: TransportACP, SelectedTransport: TransportACP,
				ACP: &AcpAgentCapabilities{ProtocolVersion: 1, AdapterName: "sk-abcdefghijklmnop123456"},
			},
			want: "ACP adapter name is too long or looks secret-like",
		},
		{
			name: "oversized adapter name",
			selection: RunTransportSelection{
				RequestedTransport: TransportACP, SelectedTransport: TransportACP,
				ACP: &AcpAgentCapabilities{ProtocolVersion: 1, AdapterName: strings.Repeat("n", ACPAdapterNameMaximumBytes+1)},
			},
			want: "ACP adapter name is too long or looks secret-like",
		},
		{
			name: "non-normalized adapter version",
			selection: RunTransportSelection{
				RequestedTransport: TransportACP, SelectedTransport: TransportACP,
				ACP: &AcpAgentCapabilities{ProtocolVersion: 1, AdapterVersion: "1.0.0.0.0"},
			},
			want: "ACP adapter version is not a normalized version",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := test.selection.Validate()
			require.ErrorContains(t, err, test.want)
		})
	}
}

func TestRunStartedTransportFixturesRoundTripThroughOutbound(t *testing.T) {
	for _, fixtureName := range []string{"run-started-acp", "run-started-native-fallback"} {
		t.Run(fixtureName, func(t *testing.T) {
			fixtureBytes, _ := loadFixture(t, fixtureName)
			var outbound Outbound
			require.NoError(t, json.Unmarshal(fixtureBytes, &outbound))
			require.Equal(t, "run.started", outbound.Type)
			require.NotNil(t, outbound.Transport)
			require.NoError(t, outbound.Transport.Validate())

			encoded, err := json.Marshal(outbound)
			require.NoError(t, err)
			var encodedObject map[string]json.RawMessage
			require.NoError(t, json.Unmarshal(encoded, &encodedObject))
			// Go always emits activeRuns because heartbeats rely on 0 being sent; the fixture omits it.
			delete(encodedObject, "activeRuns")
			normalized, err := json.Marshal(encodedObject)
			require.NoError(t, err)
			require.JSONEq(t, string(fixtureBytes), string(normalized))
		})
	}
}

func TestDispatchAcpFallbackFixtureRoundTripsItsExecution(t *testing.T) {
	fixtureBytes, fixtureObject := loadFixture(t, "dispatch-acp-fallback")
	inbound, err := DecodeInbound(fixtureBytes)
	require.NoError(t, err)
	require.Equal(t, "dispatch", inbound.Type)
	require.Equal(t, "acp-v1", inbound.Run.Transport)
	require.NotNil(t, inbound.Execution)
	require.Equal(t, "acp-v1", inbound.Execution.Transport)
	require.Equal(t, "native-cli", inbound.Execution.FallbackTransport)

	encoded, err := json.Marshal(inbound.Execution)
	require.NoError(t, err)
	require.JSONEq(t, string(fixtureObject["execution"]), string(encoded))
}

func TestTransportVocabularyMatchesTheProtocolSourceOfTruth(t *testing.T) {
	require.Equal(t, []string{
		"acp-adapter-unavailable", "acp-protocol-incompatible", "acp-capability-missing", "acp-mcp-unavailable",
	}, TransportFallbackReasons)
	require.Equal(t, []string{"setup-ledger", "administrator-override"}, ACPAdapterSources)
	require.Equal(t, "transport-native-fallback", WarningTransportNativeFallback)
}
