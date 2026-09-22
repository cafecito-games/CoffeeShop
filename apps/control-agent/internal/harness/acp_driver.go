package harness

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

const (
	mcpServerName              = "coffee_shop_hub"
	defaultShutdownGracePeriod = 5 * time.Second
	// pipeReleaseDelay bounds each wait for adapter stdio to close after killing the process tree,
	// covering a descendant that escaped the tree while holding a pipe.
	pipeReleaseDelay = 3 * time.Second
)

// errShutdownAbandoned reports that adapter supervision stopped waiting for stdio or process exit.
var errShutdownAbandoned = errors.New("ACP adapter stdio did not close after its process tree was terminated")

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
}

// ACPDriverOptions configures the generic ACP driver. Adapters are keyed by harness ID.
type ACPDriverOptions struct {
	Adapters            map[string]ACPAdapter
	ClientVersion       string
	RequestTimeout      time.Duration
	PermissionTimeout   time.Duration
	CancelGracePeriod   time.Duration
	ShutdownGracePeriod time.Duration
}

// ACPDriver supervises one ACP adapter process and session per invocation.
type ACPDriver struct {
	options ACPDriverOptions
}

func NewACPDriver(options ACPDriverOptions) *ACPDriver {
	if options.ShutdownGracePeriod <= 0 {
		options.ShutdownGracePeriod = defaultShutdownGracePeriod
	}
	return &ACPDriver{options: options}
}

// Available reports whether an executable adapter is configured for the harness.
func (driver *ACPDriver) Available(harnessID string) error {
	_, err := driver.adapter(harnessID)
	return err
}

func (driver *ACPDriver) adapter(harnessID string) (ACPAdapter, error) {
	adapter, configured := driver.options.Adapters[harnessID]
	if !configured {
		return ACPAdapter{}, fmt.Errorf("%w: no ACP adapter is configured for harness %s", ErrDriverUnavailable, harnessID)
	}
	if !filepath.IsAbs(adapter.Binary) {
		return ACPAdapter{}, fmt.Errorf("%w: ACP adapter path for %s must be absolute", ErrDriverUnavailable, harnessID)
	}
	info, err := os.Stat(adapter.Binary)
	if err != nil || !info.Mode().IsRegular() || (runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0) {
		return ACPAdapter{}, fmt.Errorf("%w: ACP adapter for %s is missing or not executable", ErrDriverUnavailable, harnessID)
	}
	return adapter, nil
}

func (driver *ACPDriver) Execute(ctx context.Context, invocation Invocation) (string, error) {
	adapter, err := driver.adapter(invocation.Run.HarnessID)
	if err != nil {
		return "", err
	}
	cwd, err := canonicalDirectory(invocation.Workspace)
	if err != nil {
		return "", err
	}
	secrets := []string{invocation.MCP.Token}

	killContext, killProcessTree := context.WithCancel(context.Background())
	defer killProcessTree()
	command := exec.CommandContext(killContext, adapter.Binary, adapter.Arguments...)
	configureProcessCancellation(command)
	command.Dir = cwd
	command.Env = adapterEnvironment(os.Environ(), adapter.Environment)
	stdin, err := command.StdinPipe()
	if err != nil {
		return "", err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return "", err
	}
	stderr := acp.NewStderrTail(acp.MaximumDiagnosticBytes, secrets)
	command.Stderr = stderr
	if err := command.Start(); err != nil {
		return "", fmt.Errorf("%w: start ACP adapter: %w", ErrDriverUnavailable, err)
	}

	output := invocation.Output
	client := acp.NewClient(stdout, stdin, acp.Options{
		RunID:         invocation.Run.ID,
		ClientVersion: driver.options.ClientVersion,
		Secrets:       secrets,
		Permission:    invocation.Permission,
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
	if invocation.MCP.URL != "" {
		request.MCPServer = &acp.MCPServer{Name: mcpServerName, URL: invocation.MCP.URL, BearerToken: invocation.MCP.Token}
	}
	result, runErr := client.Run(ctx, request)

	exited := make(chan error, 1)
	go func() {
		client.Wait()
		exited <- command.Wait()
	}()
	client.Close()
	waitErr, forced := driver.shutdown(runErr == nil, exited, killProcessTree, func() { _ = stdin.Close() }, func() { _ = stdout.Close() })

	if runErr != nil {
		if diagnostic := stderr.String(); diagnostic != "" {
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
