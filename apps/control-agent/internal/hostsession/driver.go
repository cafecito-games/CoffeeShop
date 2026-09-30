// Package hostsession owns provider-neutral, durable Barista host sessions.
// It deliberately has no control-plane dependency; transport adapters may call it, but providers
// can only return observations through Driver.
package hostsession

import (
	"context"
	"errors"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

var (
	ErrDisabled              = errors.New("interactive host sessions are disabled")
	ErrUnsupportedCapability = errors.New("host session capability is unsupported")
	ErrCommandConflict       = errors.New("host session command id has a different semantic payload")
	ErrStaleEpoch            = errors.New("host session attachment epoch is stale")
	ErrFutureEpoch           = errors.New("host session attachment epoch is in the future")
	ErrSessionBusy           = errors.New("host session is already mutating")
	ErrInvalidTransition     = errors.New("host session state transition is illegal")
	ErrIdentityConflict      = errors.New("host session provider identity is ambiguous")
	ErrUnauthorizedWorkspace = errors.New("host session workspace is not authorized")
	ErrInvalidObservation    = errors.New("host session driver observation is invalid")
	ErrShuttingDown          = errors.New("host session supervisor is shutting down")
)

type Clock interface{ Now() time.Time }
type IDGenerator interface{ NewID() (string, error) }
type DurabilityBarrier interface{ Reach(point string) error }

const (
	BarrierAfterPending  = "after-pending"
	BarrierAfterEffect   = "after-provider-effect"
	BarrierAfterRegistry = "after-registry"
)

type Capabilities struct {
	DriverOperations  []string
	SessionOperations []string
}

type ProviderSession struct {
	ProviderSessionID string
	Workspace         string
	Source            string
	Status            string
	ControlMode       string
	Operations        []string
	ProviderTurnID    string
	Summary           string
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

type DiscoverRequest struct{ Limit int }
type SessionRequest struct {
	Handle            OperationHandle
	ProviderSessionID string
	Workspace         string
}
type AdoptRequest struct{ ProviderSessionID, Workspace string }
type CreateRequest struct{ Workspace, Model string }
type HistoryRequest struct {
	SessionRequest
	Cursor string
	Limit  int
}
type TurnRequest struct {
	SessionRequest
	RunID, Prompt string
}
type SteerRequest struct {
	SessionRequest
	RunID, ProviderTurnID, Text string
}
type TurnControlRequest struct {
	SessionRequest
	RunID, ProviderTurnID string
}
type ApprovalRequest struct {
	SessionRequest
	RunID, ProviderTurnID string
	Decision              protocol.ApprovalDecision
}
type ReconcileRequest struct {
	SessionRequest
	CommandID, Operation string
}

type OperationHandle struct {
	HostHarnessSessionID string
	Token                string
}

type HistoryPage struct {
	Items      []protocol.HostHarnessSessionHistoryItem
	NextCursor string
	Truncated  bool
}

type DriverOutcome struct {
	Session        ProviderSession
	ProviderTurnID string
	Detail         string
	Events         []protocol.HarnessEvent
}

type ReconcileResult struct {
	Session    ProviderSession
	Outcome    DriverOutcome
	Conclusive bool
}

// Driver exposes every provider operation independently. Capabilities are authoritative: the
// supervisor never calls an unadvertised method and never emulates it with another operation.
type Driver interface {
	HarnessID() string
	Capabilities() Capabilities
	Discover(context.Context, DiscoverRequest) ([]ProviderSession, error)
	Inspect(context.Context, SessionRequest) (ProviderSession, error)
	Adopt(context.Context, AdoptRequest) (ProviderSession, error)
	Create(context.Context, CreateRequest) (ProviderSession, error)
	Resume(context.Context, SessionRequest) (ProviderSession, error)
	ReadHistory(context.Context, HistoryRequest) (HistoryPage, error)
	StartTurn(context.Context, TurnRequest) (DriverOutcome, error)
	Steer(context.Context, SteerRequest) (DriverOutcome, error)
	Interrupt(context.Context, TurnControlRequest) (DriverOutcome, error)
	DecideApproval(context.Context, ApprovalRequest) (DriverOutcome, error)
	Refresh(context.Context, SessionRequest) (ProviderSession, error)
	Reconcile(context.Context, ReconcileRequest) (ReconcileResult, error)
	Close(context.Context, SessionRequest) (DriverOutcome, error)
}
