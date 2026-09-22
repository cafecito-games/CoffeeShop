package harness

import (
	"context"
	"errors"
	"fmt"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/mcpserver"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

const (
	TransportNative = "native-cli"
	TransportACP    = "acp-v1"
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
}

// Driver executes an invocation and returns exactly one terminal result.
type Driver interface {
	Execute(ctx context.Context, invocation Invocation) (string, error)
}

// Runner selects the driver for a run's transport. The native CLI driver is always registered.
type Runner struct {
	profiles []protocol.HarnessProfile
	native   Driver
	acp      Driver
}

func NewRunner(profiles []protocol.HarnessProfile) *Runner {
	runner := &Runner{profiles: profiles}
	runner.native = nativeDriver{runner: runner}
	return runner
}

// WithACP registers the ACP driver used for runs whose transport is acp-v1.
func (r *Runner) WithACP(driver Driver) *Runner {
	r.acp = driver
	return r
}

// Run executes a run with text output only, preserving the original native runner contract.
func (r *Runner) Run(ctx context.Context, run protocol.Run, agent protocol.Agent, cwd string, mcpConfig mcpserver.Config, output func(string)) (string, error) {
	return r.Execute(ctx, Invocation{Run: run, Agent: agent, Workspace: cwd, MCP: mcpConfig, Output: output})
}

// Execute dispatches the invocation to the driver for its transport.
func (r *Runner) Execute(ctx context.Context, invocation Invocation) (string, error) {
	driver, err := r.driverFor(invocation.Run.Transport)
	if err != nil {
		return "", err
	}
	if invocation.Output == nil {
		invocation.Output = func(string) {}
	}
	return driver.Execute(ctx, invocation)
}

func (r *Runner) driverFor(transport string) (Driver, error) {
	switch transport {
	case "", TransportNative:
		return r.native, nil
	case TransportACP:
		if r.acp == nil {
			return nil, fmt.Errorf("%w: no ACP adapter is configured on this Barista", ErrDriverUnavailable)
		}
		return r.acp, nil
	default:
		return nil, fmt.Errorf("%w: unknown harness transport %q", ErrDriverUnavailable, transport)
	}
}
