// Package acp implements the subset of the Agent Client Protocol v1 that Barista needs to supervise
// a locally installed harness adapter over newline-delimited JSON-RPC on stdio. ACP values never
// leave this package: session updates are normalized into protocol.HarnessEvent values.
package acp

import "time"

// ProtocolVersion is the only ACP major version this client negotiates.
const ProtocolVersion = 1

// Bounds applied to untrusted adapter output. Every limit is inclusive: a value exactly at the
// limit is accepted and one byte or item beyond it is not.
const (
	// MaximumFrameBytes bounds one stdout line, excluding its newline delimiter. It leaves room
	// for a tool call carrying two maximum-size diff texts after JSON escaping.
	MaximumFrameBytes = 4 * 1024 * 1024
	// MaximumPendingRequests bounds client-initiated requests awaiting a response.
	MaximumPendingRequests = 32
	// MaximumInboundRequests bounds agent-initiated requests being serviced concurrently.
	MaximumInboundRequests = 16
	// OutboundQueueDepth bounds encoded frames waiting to be written to adapter stdin.
	OutboundQueueDepth = 64
	// MaximumToolContentItems bounds the content entries normalized from one tool call update.
	MaximumToolContentItems = 64
	// MaximumTrackedToolCalls bounds the per-session tool call state used to merge updates.
	MaximumTrackedToolCalls = 4096
	// MaximumResultBytes bounds the accumulated final agent message returned to the caller.
	MaximumResultBytes = 256 * 1024
	// MaximumDiagnosticBytes bounds stderr tails and diagnostic messages placed in errors.
	MaximumDiagnosticBytes = 2 * 1024
)

// Bounds mirrored from the normalized harness event contract so values are shaped before they are
// validated rather than rejected after the fact.
const (
	eventTextBytes       = 64 * 1024
	eventDiffBytes       = 256 * 1024
	eventTitleBytes      = 2 * 1024
	eventIdentifierBytes = 256
	eventPlanEntryLimit  = 200
	eventOptionLimit     = 8
)

// Default timing used when Options leaves a duration unset.
const (
	DefaultRequestTimeout    = 30 * time.Second
	DefaultPermissionTimeout = 10 * time.Minute
	DefaultCancelGracePeriod = 5 * time.Second
)
