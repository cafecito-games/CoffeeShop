package harness

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/mcpserver"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

const (
	TransportNative = protocol.TransportNativeCLI
	TransportACP    = protocol.TransportACP
)

// ErrDriverUnavailable reports that the requested transport cannot run this harness on this node.
// Callers may fall back to the native transport only by an explicit decision.
var ErrDriverUnavailable = errors.New("harness driver unavailable")

// PermissionHandler resolves harness permission requests. Without one, every request is refused.
type PermissionHandler = acp.PermissionHandler

// Invocation is one execution of a harness for a run.
type Invocation struct {
	Run       protocol.Run
	Agent     protocol.Agent
	Workspace string
	MCP       mcpserver.Config
	// Output receives human-readable text chunks.
	Output func(string)
	// Events receives normalized harness events, when the driver produces them.
	Events     func(protocol.HarnessEvent)
	Permission PermissionHandler
	// FallbackTransport is the dispatch's permission for an acp-v1 run to fall back to the native
	// CLI: "native-cli" permits it, "" forbids it. The Runner also requires operator opt-in.
	FallbackTransport string
	// Started is called at most once, immediately before the harness receives the prompt, with
	// the transport the run actually uses. A run whose Started was never called did not start.
	Started func(protocol.RunTransportSelection)
	// Resume asks an ACP driver to continue an existing provider session. Drivers that cannot
	// resume ignore it and run the run prompt, which carries the durable context a new session
	// needs.
	Resume *SessionResume
	// Session is called at most once by a driver that established a provider session, after the
	// session exists and before Started.
	Session func(EstablishedSession)

	// begin is installed by Runner.Execute; drivers call it when the prompt is about to be sent.
	begin func(transportDetails)
	// approvalPolicy is set by Runner.Execute from the node's configuration. It is deliberately
	// unexported: a caller building an Invocation from a dispatch cannot set it, and a driver
	// reached without the Runner sees "" and applies the manual policy.
	approvalPolicy string
}

// SessionResume identifies the provider session to continue and the prompt it receives if it does.
type SessionResume struct {
	ProviderSessionID string
	// Prompt replaces the run prompt when the session resumed; empty keeps the run prompt.
	Prompt string
}

// EstablishedSession is the provider session a run's prompt is about to be sent to.
type EstablishedSession struct {
	ProviderSessionID string
	Resumed           bool
}

// transportDetails is what a driver knows about the transport it is about to start.
type transportDetails struct {
	capabilities *protocol.AcpAgentCapabilities
}

func (invocation Invocation) announce(details transportDetails) {
	if invocation.begin != nil {
		invocation.begin(details)
	}
}

// Driver executes an invocation and returns exactly one terminal result.
type Driver interface {
	Execute(ctx context.Context, invocation Invocation) (string, error)
}

// Runner selects the driver for a run's transport. The native CLI driver is always registered.
type Runner struct {
	profiles       []protocol.HarnessProfile
	native         Driver
	acp            *ACPDriver
	nativeFallback map[string]bool
	// approvalPolicies is the administrator's approval policy per harness; see ApprovalPolicies.
	approvalPolicies ApprovalPolicies
	now              func() time.Time
}

func NewRunner(profiles []protocol.HarnessProfile) *Runner {
	runner := &Runner{profiles: profiles, nativeFallback: map[string]bool{}, now: time.Now}
	runner.native = nativeDriver{runner: runner}
	return runner
}

// WithACP registers the ACP driver used for runs whose transport is acp-v1.
func (r *Runner) WithACP(driver *ACPDriver) *Runner {
	r.acp = driver
	return r
}

// WithNativeFallback records the operator's opt-in to native fallback for the given harnesses. An
// acp-v1 run of such a harness may run through the native CLI instead only when its dispatch also
// permits it, the native CLI is installed, and ACP failed for a reason FallbackReason recognizes
// before the prompt was sent.
func (r *Runner) WithNativeFallback(harnessIDs ...string) *Runner {
	for _, harnessID := range harnessIDs {
		r.nativeFallback[harnessID] = true
	}
	return r
}

// WithApprovalPolicies records the node administrator's approval policy per harness. Every run of
// a harness, over either transport, executes under its policy; a harness without an entry is manual.
func (r *Runner) WithApprovalPolicies(policies ApprovalPolicies) *Runner {
	r.approvalPolicies = ApprovalPolicies{}
	for harnessID, policy := range policies {
		r.approvalPolicies[harnessID] = policy
	}
	return r
}

// ApprovalPolicy returns the effective approval policy for the harness.
func (r *Runner) ApprovalPolicy(harnessID string) string {
	return r.approvalPolicies.For(harnessID)
}

// Run executes a run with text output only, preserving the original native runner contract.
func (r *Runner) Run(ctx context.Context, run protocol.Run, agent protocol.Agent, cwd string, mcpConfig mcpserver.Config, output func(string)) (string, error) {
	return r.Execute(ctx, Invocation{Run: run, Agent: agent, Workspace: cwd, MCP: mcpConfig, Output: output})
}

// Admit reports whether this Barista can honor a dispatch of the harness over transport, directly
// or through a permitted native fallback. It performs no execution and is safe to call before a
// run is accepted.
func (r *Runner) Admit(harnessID, transport, fallbackTransport string) error {
	switch transport {
	case "", TransportNative:
		return nil
	case TransportACP:
		err := r.acpAvailable(harnessID)
		if err == nil || r.fallbackPermitted(harnessID, fallbackTransport) {
			return nil
		}
		return err
	default:
		return fmt.Errorf("%w: unknown harness transport", ErrDriverUnavailable)
	}
}

// AdmitResume reports whether an acp-v1 run of the harness may ask to resume a provider session:
// a verified adapter is available and its startup probe negotiated session resume or load. It
// performs no execution.
func (r *Runner) AdmitResume(harnessID string) error {
	if err := r.acpAvailable(harnessID); err != nil {
		return err
	}
	return r.acp.SupportsResume(harnessID)
}

// Execute dispatches the invocation to the driver for its transport.
func (r *Runner) Execute(ctx context.Context, invocation Invocation) (string, error) {
	if invocation.Output == nil {
		invocation.Output = func(string) {}
	}
	invocation.approvalPolicy = r.approvalPolicies.For(invocation.Run.HarnessID)
	switch invocation.Run.Transport {
	case "", TransportNative:
		return r.native.Execute(ctx, r.beginning(invocation, protocol.RunTransportSelection{RequestedTransport: TransportNative, SelectedTransport: TransportNative}, nil))
	case TransportACP:
		return r.executeACP(ctx, invocation)
	default:
		return "", fmt.Errorf("%w: unknown harness transport", ErrDriverUnavailable)
	}
}

func (r *Runner) executeACP(ctx context.Context, invocation Invocation) (string, error) {
	harnessID := invocation.Run.HarnessID
	permitted := r.fallbackPermitted(harnessID, invocation.FallbackTransport)
	if err := r.acpAvailable(harnessID); err != nil {
		if permitted {
			return r.fallBack(ctx, invocation, protocol.FallbackACPAdapterUnavailable)
		}
		return "", err
	}
	var started atomic.Bool
	selection := protocol.RunTransportSelection{RequestedTransport: TransportACP, SelectedTransport: TransportACP, Adapter: r.acp.provenance(harnessID)}
	result, err := r.acp.Execute(ctx, r.beginning(invocation, selection, &started))
	if err == nil || started.Load() || !permitted || ctx.Err() != nil {
		return result, err
	}
	reason := FallbackReason(err)
	if reason == "" {
		return "", err
	}
	return r.fallBack(ctx, invocation, reason)
}

// fallBack runs an acp-v1 invocation through the native CLI and makes the decision visible: a
// warning event precedes the native run, and the selection reported to Started names the reason.
func (r *Runner) fallBack(ctx context.Context, invocation Invocation, reason string) (string, error) {
	if invocation.Events != nil {
		invocation.Events(protocol.HarnessEvent{
			Type: "warning", RunID: invocation.Run.ID, At: r.now().UTC().Format(time.RFC3339Nano),
			Code:    protocol.WarningTransportNativeFallback,
			Message: "ACP transport was not usable before the prompt was sent (" + reason + "); running through the native CLI as the dispatch and operator permit",
		})
	}
	selection := protocol.RunTransportSelection{RequestedTransport: TransportACP, SelectedTransport: TransportNative, FallbackReason: reason}
	if r.acp != nil {
		selection.Adapter = r.acp.provenance(invocation.Run.HarnessID)
	}
	return r.native.Execute(ctx, r.beginning(invocation, selection, nil))
}

// beginning installs the begin hook that reports selection to Started exactly once, records that
// the run started, and adds what the driver learned about the transport.
func (r *Runner) beginning(invocation Invocation, selection protocol.RunTransportSelection, started *atomic.Bool) Invocation {
	selection.ApprovalPolicy = reportedApprovalPolicy(invocation.approvalPolicy)
	if selection.SelectedTransport == TransportNative {
		if profile, available := r.profile(invocation.Run.HarnessID); available {
			selection.HarnessVersion = normalizedHarnessVersion(profile.Description)
		}
	}
	var once sync.Once
	report := invocation.Started
	invocation.begin = func(details transportDetails) {
		once.Do(func() {
			if started != nil {
				started.Store(true)
			}
			if details.capabilities != nil {
				capabilities := *details.capabilities
				selection.ACP = &capabilities
			}
			if report != nil {
				report(selection)
			}
		})
	}
	return invocation
}

func (r *Runner) acpAvailable(harnessID string) error {
	if r.acp == nil {
		return fmt.Errorf("%w: no ACP adapter is configured on this Barista", ErrDriverUnavailable)
	}
	return r.acp.Available(harnessID)
}

func (r *Runner) fallbackPermitted(harnessID, fallbackTransport string) bool {
	if fallbackTransport != TransportNative || !r.nativeFallback[harnessID] {
		return false
	}
	_, available := r.profile(harnessID)
	return available
}
