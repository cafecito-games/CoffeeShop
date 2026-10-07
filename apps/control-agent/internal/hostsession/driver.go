package hostsession

import (
	"context"
	"sort"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

// Operation is a provider-driver capability. The supervisor checks each operation independently
// and never emulates an unsupported provider action with another action.
type Operation string

const (
	OperationDiscover        Operation = "discover"
	OperationReadHistory     Operation = "read-history"
	OperationInspect         Operation = "inspect"
	OperationAdopt           Operation = "adopt"
	OperationCreate          Operation = "create"
	OperationResume          Operation = "resume"
	OperationDetach          Operation = "detach"
	OperationStartTurn       Operation = "start-turn"
	OperationSteer           Operation = "steer"
	OperationInterrupt       Operation = "interrupt"
	OperationResolveApproval Operation = "resolve-approval"
	OperationRefresh         Operation = "refresh"
	OperationReconcile       Operation = "reconcile"
	OperationClose           Operation = "close"
)

type CapabilitySet struct {
	values map[Operation]struct{}
}

func NewCapabilitySet(operations ...Operation) CapabilitySet {
	values := make(map[Operation]struct{}, len(operations))
	for _, operation := range operations {
		values[operation] = struct{}{}
	}
	return CapabilitySet{values: values}
}

func (capabilities CapabilitySet) Supports(operation Operation) bool {
	_, supported := capabilities.values[operation]
	return supported
}

func (capabilities CapabilitySet) Operations() []Operation {
	operations := make([]Operation, 0, len(capabilities.values))
	for operation := range capabilities.values {
		operations = append(operations, operation)
	}
	sort.Slice(operations, func(left, right int) bool { return operations[left] < operations[right] })
	return operations
}

// DriverSession is a bounded provider observation. It contains no provider configuration,
// credential, command environment, process handle, endpoint, or raw transcript.
type DriverSession struct {
	ProviderSessionID string
	Workspace         string
	Source            string
	Status            string
	ControlMode       string
	Operations        []string
	ProviderTurnID    string
	Summary           string
}

type DiscoverRequest struct {
	Limit  int
	Cursor string
}

type DiscoverPage struct {
	Sessions   []DriverSession
	NextCursor string
	Truncated  bool
}

type ReadHistoryRequest struct {
	Session DriverSession
	Cursor  string
	Limit   int
}

type HistoryPage struct {
	Items      []protocol.HostHarnessSessionHistoryItem
	NextCursor string
	Truncated  bool
}

type SessionRequest struct {
	HostHarnessSessionID string
	ProviderSessionID    string
	Workspace            string
	Source               string
	Status               string
	Summary              string
	ControlMode          string
	Operations           []string
	ProviderTurnID       string
	AttachmentEpoch      int64
	ThreadID             string
	RunID                string
	Prompt               string
	Text                 string
	Model                string
	Decision             *protocol.ApprovalDecision
	Emit                 func(protocol.HarnessEvent) error
	// Observe reports an asynchronous provider status change for the lifetime of the claimed
	// provider session, including writer loss while no turn is active. The supervisor revalidates
	// identity and attachment epoch before committing it.
	Observe func(DriverSession) error
	// Activated closes only after the supervisor has durably committed the successful command
	// result. Drivers must not publish asynchronous turn notifications before it closes.
	Activated <-chan struct{}
	// Aborted closes when the supervisor cannot commit the command. Drivers must discard queued
	// callbacks and release activation waiters rather than publishing an uncommitted turn.
	Aborted <-chan struct{}
}

// Driver owns provider process/RPC behavior only. Coffee Shop identity, registry state, epochs,
// legal transitions, workspace admission, and command outcomes remain inaccessible to drivers.
type Driver interface {
	HarnessID() string
	Capabilities() CapabilitySet
	Discover(context.Context, DiscoverRequest) (DiscoverPage, error)
	ReadHistory(context.Context, ReadHistoryRequest) (HistoryPage, error)
	Inspect(context.Context, SessionRequest) (DriverSession, error)
	Adopt(context.Context, SessionRequest) (DriverSession, error)
	Create(context.Context, SessionRequest) (DriverSession, error)
	Resume(context.Context, SessionRequest) (DriverSession, error)
	Detach(context.Context, SessionRequest) (DriverSession, error)
	StartTurn(context.Context, SessionRequest) (DriverSession, error)
	Steer(context.Context, SessionRequest) (DriverSession, error)
	Interrupt(context.Context, SessionRequest) (DriverSession, error)
	ResolveApproval(context.Context, SessionRequest) (DriverSession, error)
	Refresh(context.Context, SessionRequest) (DriverSession, error)
	Reconcile(context.Context, SessionRequest) (DriverSession, error)
	Close(context.Context, SessionRequest) (DriverSession, error)
}

type DriverRejection struct {
	Code        string
	Observation *DriverSession
}

func (rejection DriverRejection) Error() string { return rejection.Code }
