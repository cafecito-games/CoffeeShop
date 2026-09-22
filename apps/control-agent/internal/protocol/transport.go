package protocol

import (
	"errors"
	"slices"
)

const (
	TransportNativeCLI = "native-cli"
	TransportACP       = "acp-v1"
)

// Native fallback reasons, mirroring transportFallbackReasons in the protocol source of truth.
// Each names a condition detected before an ACP prompt was sent; nothing else may cause a run to
// fall back from its requested ACP transport to the native CLI.
const (
	FallbackACPAdapterUnavailable   = "acp-adapter-unavailable"
	FallbackACPProtocolIncompatible = "acp-protocol-incompatible"
	FallbackACPCapabilityMissing    = "acp-capability-missing"
	FallbackACPMCPUnavailable       = "acp-mcp-unavailable"
)

// Where a verified ACP adapter executable came from, mirroring acpAdapterSources.
const (
	ACPAdapterSourceSetupLedger   = "setup-ledger"
	ACPAdapterSourceAdministrator = "administrator-override"
)

// Approval policies a node administrator may declare for a harness, mirroring approvalPolicies in
// the protocol source of truth. Manual sends every permission request to Coffee Shop approvals;
// auto lets the harness approve routine actions itself; bypass disables the harness's approval
// prompts and, for Codex, its sandbox. Only Barista's own configuration selects one: nothing the
// hub sends can change it.
const (
	ApprovalPolicyManual = "manual"
	ApprovalPolicyAuto   = "auto"
	ApprovalPolicyBypass = "bypass"
)

// WarningTransportNativeFallback is the harness warning code Barista emits when a run falls back.
const WarningTransportNativeFallback = "transport-native-fallback"

// ACPAdapterNameMaximumBytes bounds the adapter name reported from an ACP initialize handshake.
const ACPAdapterNameMaximumBytes = 128

var (
	TransportFallbackReasons = []string{FallbackACPAdapterUnavailable, FallbackACPProtocolIncompatible, FallbackACPCapabilityMissing, FallbackACPMCPUnavailable}
	ACPAdapterSources        = []string{ACPAdapterSourceSetupLedger, ACPAdapterSourceAdministrator}
	ApprovalPolicies         = []string{ApprovalPolicyManual, ApprovalPolicyAuto, ApprovalPolicyBypass}
)

// ACPAdapterProvenance identifies the verified adapter executable an ACP run used or attempted.
type ACPAdapterProvenance struct {
	ID      string `json:"id"`
	Version string `json:"version"`
	Source  string `json:"source"`
}

// RunTransportSelection is the transport decision Barista made for one run, reported once on
// run.started. SelectedTransport differs from RequestedTransport only for an ACP request that fell
// back to the native CLI before its prompt was sent, and then FallbackReason says why.
type RunTransportSelection struct {
	RequestedTransport string                `json:"requestedTransport"`
	SelectedTransport  string                `json:"selectedTransport"`
	FallbackReason     string                `json:"fallbackReason,omitempty"`
	HarnessVersion     string                `json:"harnessVersion,omitempty"`
	Adapter            *ACPAdapterProvenance `json:"adapter,omitempty"`
	ACP                *AcpAgentCapabilities `json:"acp,omitempty"`
	// ApprovalPolicy is the approval policy the run executed under. Barista omits
	// ApprovalPolicyManual, so an absent value means manual.
	ApprovalPolicy string `json:"approvalPolicy,omitempty"`
}

// Validate mirrors validateRunTransportSelection in the protocol source of truth.
func (selection RunTransportSelection) Validate() error {
	if !slices.Contains(HarnessTransports, selection.RequestedTransport) || !slices.Contains(HarnessTransports, selection.SelectedTransport) {
		return errors.New("transport selection names an unknown transport")
	}
	if selection.SelectedTransport == selection.RequestedTransport {
		if selection.FallbackReason != "" {
			return errors.New("transport selection has a fallback reason without a fallback")
		}
	} else if selection.RequestedTransport != TransportACP || selection.SelectedTransport != TransportNativeCLI || !slices.Contains(TransportFallbackReasons, selection.FallbackReason) {
		return errors.New("transport selection falls back other than from acp-v1 to native-cli for a known reason")
	}
	if selection.HarnessVersion != "" && !IsNormalizedVersion(selection.HarnessVersion) {
		return errors.New("transport selection harness version is not a normalized version")
	}
	if adapter := selection.Adapter; adapter != nil {
		if len(adapter.ID) > LabelOrAcceleratorMaximumBytes || !LabelOrAcceleratorPattern.MatchString(adapter.ID) || !IsNormalizedVersion(adapter.Version) || !slices.Contains(ACPAdapterSources, adapter.Source) {
			return errors.New("transport selection adapter provenance is malformed")
		}
	}
	if selection.ApprovalPolicy != "" && !slices.Contains(ApprovalPolicies, selection.ApprovalPolicy) {
		return errors.New("transport selection names an unknown approval policy")
	}
	if selection.ACP != nil {
		if selection.SelectedTransport != TransportACP {
			return errors.New("transport selection carries ACP capabilities for a native run")
		}
		if err := selection.ACP.Validate(); err != nil {
			return err
		}
	}
	return nil
}

// Validate mirrors isAcpAgentCapabilities in the protocol source of truth.
func (capabilities AcpAgentCapabilities) Validate() error {
	if capabilities.ProtocolVersion != 1 {
		return errors.New("ACP capabilities name an unsupported protocol version")
	}
	if len(capabilities.AdapterName) > ACPAdapterNameMaximumBytes || LooksSecretLike(capabilities.AdapterName) {
		return errors.New("ACP adapter name is too long or looks secret-like")
	}
	if capabilities.AdapterVersion != "" && !IsNormalizedVersion(capabilities.AdapterVersion) {
		return errors.New("ACP adapter version is not a normalized version")
	}
	return nil
}
