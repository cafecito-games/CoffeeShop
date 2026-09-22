package harness

import (
	"errors"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

// FallbackReason classifies an ACP failure that happened before the prompt was sent. It returns
// the protocol fallback reason when the failure is an incompatibility or unavailability that the
// native CLI does not share, and "" for every other failure: cancellation, missing provider
// authentication, a rejected model or configuration request, and anything unrecognized must fail
// the run instead of changing how it executes.
func FallbackReason(err error) string {
	switch {
	case err == nil,
		errors.Is(err, acp.ErrCancelled),
		errors.Is(err, acp.ErrCancelGraceExpired),
		errors.Is(err, acp.ErrAuthenticationRequired),
		errors.Is(err, acp.ErrConfigRejected):
		return ""
	case errors.Is(err, ErrMCPUnavailable):
		return protocol.FallbackACPMCPUnavailable
	case errors.Is(err, acp.ErrMissingCapability):
		return protocol.FallbackACPCapabilityMissing
	case errors.Is(err, acp.ErrUnsupportedVersion),
		errors.Is(err, acp.ErrAdapterVersionMismatch),
		errors.Is(err, acp.ErrProtocolViolation),
		errors.Is(err, acp.ErrAdapterClosed):
		return protocol.FallbackACPProtocolIncompatible
	case errors.Is(err, ErrDriverUnavailable):
		return protocol.FallbackACPAdapterUnavailable
	default:
		return ""
	}
}
