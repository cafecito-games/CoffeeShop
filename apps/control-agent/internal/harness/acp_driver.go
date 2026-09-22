package harness

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

const (
	mcpServerName              = "coffee_shop_hub"
	defaultShutdownGracePeriod = 5 * time.Second
	defaultMCPConnectTimeout   = 30 * time.Second
	// pipeReleaseDelay bounds each wait for adapter stdio to close after killing the process tree,
	// covering a descendant that escaped the tree while holding a pipe.
	pipeReleaseDelay = 3 * time.Second
)

// errShutdownAbandoned reports that adapter supervision stopped waiting for stdio or process exit.
var errShutdownAbandoned = errors.New("ACP adapter stdio did not close after its process tree was terminated")

// ErrMCPUnavailable reports that the adapter did not connect to the run's Coffee Shop MCP server
// before the prompt, so the prompt was never sent.
var ErrMCPUnavailable = errors.New("ACP adapter did not connect to the Coffee Shop MCP server before the prompt")

// Warning codes the ACP driver adds to the normalized event stream.
const (
	warningAdapterExit     = "acp-adapter-exit"
	warningForcedShutdown  = "acp-adapter-forced-shutdown"
	adapterStderrSeparator = "; adapter stderr: "
)

// environmentSecrets are Barista credentials that an ACP adapter never inherits. The run-scoped
// MCP bearer token reaches the adapter only inside the session/new frame on stdin.
var environmentSecrets = []string{"COFFEE_SHOP_TOKEN", "COFFEE_SHOP_MCP_TOKEN"}

// ACPAdapter is an explicitly installed ACP agent executable. Binary must be an absolute path;
// Barista never resolves adapters through PATH or a shell.
type ACPAdapter struct {
	Binary      string
	Arguments   []string
	Environment []string
	// ID and Version identify the manifest entry the adapter was verified against. When Version
	// is set the adapter must report exactly that version in initialize.
	ID      string
	Version string
	// Source says how the executable was verified: protocol.ACPAdapterSourceSetupLedger or
	// protocol.ACPAdapterSourceAdministrator.
	Source string
	// Verify re-checks the executable's content before every launch and probe. A non-nil error
	// makes the adapter unavailable.
	Verify func() error
}

// ACPDriverOptions configures the generic ACP driver. Adapters and providers are keyed by harness
// ID; Providers defaults to DefaultACPProviders.
type ACPDriverOptions struct {
	Adapters  map[string]ACPAdapter
	Providers map[string]ACPProvider
	// NativeBinaries maps a harness ID to the absolute path of its discovered native CLI.
	NativeBinaries      map[string]string
	ClientVersion       string
	RequestTimeout      time.Duration
	PermissionTimeout   time.Duration
	CancelGracePeriod   time.Duration
	ShutdownGracePeriod time.Duration
	MCPConnectTimeout   time.Duration
}

// ACPDriver supervises one ACP adapter process and session per invocation.
type ACPDriver struct {
	options ACPDriverOptions

	mu       sync.Mutex
	disabled map[string]error
}

func NewACPDriver(options ACPDriverOptions) *ACPDriver {
	if options.ShutdownGracePeriod <= 0 {
		options.ShutdownGracePeriod = defaultShutdownGracePeriod
	}
	if options.MCPConnectTimeout <= 0 {
		options.MCPConnectTimeout = defaultMCPConnectTimeout
	}
	if options.Providers == nil {
		options.Providers = DefaultACPProviders()
	}
	return &ACPDriver{options: options, disabled: map[string]error{}}
}

// HarnessIDs lists the harnesses with a configured adapter, in a stable order.
func (driver *ACPDriver) HarnessIDs() []string {
	identifiers := make([]string, 0, len(driver.options.Adapters))
	for harnessID := range driver.options.Adapters {
		identifiers = append(identifiers, harnessID)
	}
	sort.Strings(identifiers)
	return identifiers
}

// Available reports whether a verified, executable adapter and a provider policy are configured
// for the harness and the adapter has not been disabled by a failed probe. It re-verifies the
// adapter's content, so every returned error wraps ErrDriverUnavailable.
func (driver *ACPDriver) Available(harnessID string) error {
	_, _, err := driver.adapter(harnessID)
	return err
}

// Disable makes the harness's adapter unavailable for the lifetime of the driver.
func (driver *ACPDriver) Disable(harnessID string, reason error) {
	driver.mu.Lock()
	defer driver.mu.Unlock()
	driver.disabled[harnessID] = reason
}

func (driver *ACPDriver) provenance(harnessID string) *protocol.ACPAdapterProvenance {
	adapter, configured := driver.options.Adapters[harnessID]
	if !configured || adapter.ID == "" || adapter.Version == "" || adapter.Source == "" {
		return nil
	}
	return &protocol.ACPAdapterProvenance{ID: adapter.ID, Version: adapter.Version, Source: adapter.Source}
}

func (driver *ACPDriver) adapter(harnessID string) (ACPAdapter, ACPProvider, error) {
	adapter, configured := driver.options.Adapters[harnessID]
	if !configured {
		return ACPAdapter{}, ACPProvider{}, fmt.Errorf("%w: no ACP adapter is configured for harness %s", ErrDriverUnavailable, harnessID)
	}
	provider, supported := driver.options.Providers[harnessID]
	if !supported {
		return ACPAdapter{}, ACPProvider{}, fmt.Errorf("%w: Barista has no ACP provider policy for harness %s", ErrDriverUnavailable, harnessID)
	}
	driver.mu.Lock()
	disabled := driver.disabled[harnessID]
	driver.mu.Unlock()
	if disabled != nil {
		return ACPAdapter{}, ACPProvider{}, fmt.Errorf("%w: ACP adapter for %s failed its startup probe", ErrDriverUnavailable, harnessID)
	}
	if !filepath.IsAbs(adapter.Binary) {
		return ACPAdapter{}, ACPProvider{}, fmt.Errorf("%w: ACP adapter path for %s must be absolute", ErrDriverUnavailable, harnessID)
	}
	info, err := os.Stat(adapter.Binary)
	if err != nil || !info.Mode().IsRegular() || (runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0) {
		return ACPAdapter{}, ACPProvider{}, fmt.Errorf("%w: ACP adapter for %s is missing or not executable", ErrDriverUnavailable, harnessID)
	}
	if adapter.Verify != nil {
		if err := adapter.Verify(); err != nil {
			return ACPAdapter{}, ACPProvider{}, fmt.Errorf("%w: ACP adapter for %s failed verification: %w", ErrDriverUnavailable, harnessID, err)
		}
	}
	return adapter, provider, nil
}

// adapterProcess is one started adapter with its stdio and process-tree control.
type adapterProcess struct {
	command         *exec.Cmd
	stdin           io.WriteCloser
	stdout          io.ReadCloser
	stderr          *acp.StderrTail
	killProcessTree context.CancelFunc
}

func (driver *ACPDriver) start(harnessID string, adapter ACPAdapter, provider ACPProvider, directory string, secrets []string) (*adapterProcess, error) {
	killContext, killProcessTree := context.WithCancel(context.Background())
	command := exec.CommandContext(killContext, adapter.Binary, adapter.Arguments...)
	configureProcessCancellation(command)
	command.Dir = directory
	environment := append(append([]string{}, adapter.Environment...), provider.Environment...)
	if native := driver.options.NativeBinaries[harnessID]; provider.NativeBinaryVariable != "" && filepath.IsAbs(native) {
		environment = append(environment, provider.NativeBinaryVariable+"="+native)
	}
	command.Env = adapterEnvironment(os.Environ(), environment)
	stdin, err := command.StdinPipe()
	if err != nil {
		killProcessTree()
		return nil, err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		killProcessTree()
		return nil, err
	}
	stderr := acp.NewStderrTail(acp.MaximumDiagnosticBytes, secrets)
	command.Stderr = stderr
	if err := command.Start(); err != nil {
		killProcessTree()
		return nil, fmt.Errorf("%w: start ACP adapter: %w", ErrDriverUnavailable, err)
	}
	return &adapterProcess{command: command, stdin: stdin, stdout: stdout, stderr: stderr, killProcessTree: killProcessTree}, nil
}

// stop closes the client and ends the adapter process; see shutdown for the bounds.
func (driver *ACPDriver) stop(process *adapterProcess, client *acp.Client, graceful bool) (error, bool) {
	defer process.killProcessTree()
	exited := make(chan error, 1)
	go func() {
		client.Wait()
		exited <- process.command.Wait()
	}()
	client.Close()
	return driver.shutdown(graceful, exited, process.killProcessTree, func() { _ = process.stdin.Close() }, func() { _ = process.stdout.Close() })
}

// Probe starts the harness's adapter, performs only the initialize handshake, and returns the
// capabilities it negotiated. An adapter that cannot host the Coffee Shop MCP server over HTTP is
// reported as lacking a required capability.
func (driver *ACPDriver) Probe(ctx context.Context, harnessID string) (protocol.AcpAgentCapabilities, error) {
	adapter, provider, err := driver.adapter(harnessID)
	if err != nil {
		return protocol.AcpAgentCapabilities{}, err
	}
	process, err := driver.start(harnessID, adapter, provider, "", nil)
	if err != nil {
		return protocol.AcpAgentCapabilities{}, err
	}
	client := acp.NewClient(process.stdout, process.stdin, acp.Options{
		ClientVersion:        driver.options.ClientVersion,
		ExpectedAgentVersion: adapter.Version,
		RequestTimeout:       driver.options.RequestTimeout,
	})
	capabilities, probeErr := client.Probe(ctx)
	driver.stop(process, client, probeErr == nil)
	if probeErr != nil {
		if diagnostic := process.stderr.String(); diagnostic != "" {
			return protocol.AcpAgentCapabilities{}, fmt.Errorf("%w%s%s", probeErr, adapterStderrSeparator, diagnostic)
		}
		return protocol.AcpAgentCapabilities{}, probeErr
	}
	if !capabilities.Mcp.HTTP {
		return protocol.AcpAgentCapabilities{}, fmt.Errorf("%w: HTTP MCP servers are required for the Coffee Shop MCP server", acp.ErrMissingCapability)
	}
	return capabilities, nil
}

func (driver *ACPDriver) Execute(ctx context.Context, invocation Invocation) (string, error) {
	adapter, provider, err := driver.adapter(invocation.Run.HarnessID)
	if err != nil {
		return "", err
	}
	cwd, err := canonicalDirectory(invocation.Workspace)
	if err != nil {
		return "", err
	}
	secrets := []string{invocation.MCP.Token}
	process, err := driver.start(invocation.Run.HarnessID, adapter, provider, cwd, secrets)
	if err != nil {
		return "", err
	}

	output := invocation.Output
	client := acp.NewClient(process.stdout, process.stdin, acp.Options{
		RunID:                invocation.Run.ID,
		ClientVersion:        driver.options.ClientVersion,
		ExpectedAgentVersion: adapter.Version,
		Secrets:              secrets,
		Permission:           invocation.Permission,
		Events: func(event protocol.HarnessEvent) {
			if event.Type == "message.delta" {
				output(event.Text)
			}
			if invocation.Events != nil {
				invocation.Events(event)
			}
		},
		RequestTimeout:    driver.options.RequestTimeout,
		PermissionTimeout: driver.options.PermissionTimeout,
		CancelGracePeriod: driver.options.CancelGracePeriod,
	})
	request := acp.SessionRequest{Cwd: cwd, Prompt: composePrompt(invocation.Run, invocation.Agent)}
	if provider.Configuration != nil {
		request.Configuration = provider.Configuration(invocation.Run)
	}
	if invocation.MCP.URL != "" {
		request.MCPServer = &acp.MCPServer{Name: mcpServerName, URL: invocation.MCP.URL, BearerToken: invocation.MCP.Token}
	}
	request.BeforePrompt = func(ctx context.Context) error {
		if provider.RequireMCPConnection && request.MCPServer != nil {
			if err := driver.awaitMCPConnection(ctx, invocation.MCP.Connected); err != nil {
				return err
			}
		}
		details := transportDetails{}
		if capabilities, negotiated := client.Negotiated(); negotiated {
			details.capabilities = &capabilities
		}
		invocation.announce(details)
		return nil
	}
	result, runErr := client.Run(ctx, request)
	waitErr, forced := driver.stop(process, client, runErr == nil)

	if runErr != nil {
		if diagnostic := process.stderr.String(); diagnostic != "" {
			return "", fmt.Errorf("%w%s%s", runErr, adapterStderrSeparator, diagnostic)
		}
		return "", runErr
	}
	if forced {
		client.Warn(warningForcedShutdown, "ACP adapter did not exit after its session ended and was terminated")
	} else if waitErr != nil {
		client.Warn(warningAdapterExit, "ACP adapter exited abnormally after completing the prompt turn: "+client.Redact(waitErr.Error()))
	}
	if strings.TrimSpace(result.Text) == "" {
		return emptyResponse, nil
	}
	return strings.TrimSpace(result.Text), nil
}

// awaitMCPConnection waits, for at most MCPConnectTimeout, until the adapter has listed the run's
// Coffee Shop tools. Without a connection signal the connection cannot be confirmed, which fails
// closed exactly like a connection that never happens.
func (driver *ACPDriver) awaitMCPConnection(ctx context.Context, connected <-chan struct{}) error {
	if connected == nil {
		return fmt.Errorf("%w: the run's MCP grant cannot report a connection", ErrMCPUnavailable)
	}
	timer := time.NewTimer(driver.options.MCPConnectTimeout)
	defer timer.Stop()
	select {
	case <-connected:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("%w before the Coffee Shop MCP server connected", acp.ErrCancelled)
	case <-timer.C:
		return fmt.Errorf("%w within %s", ErrMCPUnavailable, driver.options.MCPConnectTimeout)
	}
}

// shutdown lets a successful adapter exit on its own within the grace period and terminates the
// process tree immediately after a failure. Every wait after that is bounded: a descendant that
// escaped the process tree may still hold adapter stdin or stdout, so Barista closes its own pipe
// ends to unblock the connection and finally stops waiting rather than holding the run slot. It
// returns the process wait error and whether the tree had to be killed after a successful turn.
func (driver *ACPDriver) shutdown(graceful bool, exited <-chan error, killProcessTree, releaseInput, releaseOutput func()) (error, bool) {
	if graceful {
		timer := time.NewTimer(driver.options.ShutdownGracePeriod)
		defer timer.Stop()
		select {
		case err := <-exited:
			return err, false
		case <-timer.C:
		}
	}
	killProcessTree()
	releaseInput()
	for _, release := range []func(){releaseOutput, func() {}} {
		timer := time.NewTimer(pipeReleaseDelay)
		select {
		case err := <-exited:
			timer.Stop()
			return err, graceful
		case <-timer.C:
		}
		release()
	}
	return errShutdownAbandoned, graceful
}

func canonicalDirectory(workspace string) (string, error) {
	if !filepath.IsAbs(workspace) {
		return "", errors.New("ACP session workspace must be an absolute path")
	}
	resolved, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		return "", fmt.Errorf("resolve ACP session workspace: %w", err)
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.IsDir() {
		return "", errors.New("ACP session workspace is not a directory")
	}
	return filepath.Clean(resolved), nil
}

func adapterEnvironment(inherited []string, additional []string) []string {
	environment := make([]string, 0, len(inherited)+len(additional))
	for _, entry := range inherited {
		name, _, _ := strings.Cut(entry, "=")
		secret := false
		for _, blocked := range environmentSecrets {
			if strings.EqualFold(name, blocked) {
				secret = true
			}
		}
		if !secret {
			environment = append(environment, entry)
		}
	}
	return append(environment, additional...)
}
