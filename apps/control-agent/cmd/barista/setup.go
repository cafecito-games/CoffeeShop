package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/config"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/harness"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/setup"
)

// doctorDialTimeout bounds the read-only hub connectivity dial. Doctor sends no bytes and closes
// the connection immediately on success.
const doctorDialTimeout = 3 * time.Second

// applyHTTPTimeout bounds every adapter archive download one apply performs.
const applyHTTPTimeout = 2 * time.Minute

// runSetup dispatches the setup subcommands. Only `plan` and `apply` exist; anything else names
// both valid subcommands on stderr and fails closed with exit code 2.
func runSetup(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "setup requires a subcommand: plan or apply")
		return 2
	}
	switch args[0] {
	case "plan":
		return runSetupPlan(args[1:])
	case "apply":
		return runSetupApply(args[1:])
	default:
		fmt.Fprintf(os.Stderr, "unknown setup subcommand %q; valid subcommands are plan and apply\n", args[0])
		return 2
	}
}

// nameValueFlag collects repeated NAME=VALUE flags into a map. A value without the NAME=VALUE
// shape is rejected naming the flag, never echoing the value back — the value half of a malformed
// pair is still operator-supplied text.
type nameValueFlag struct {
	flagName string
	values   map[string]string
}

func (pairFlag *nameValueFlag) String() string {
	if pairFlag.values == nil {
		return ""
	}
	pairs := make([]string, 0, len(pairFlag.values))
	for name, value := range pairFlag.values {
		pairs = append(pairs, name+"="+value)
	}
	return strings.Join(pairs, ",")
}

func (pairFlag *nameValueFlag) Set(value string) error {
	name, item, found := strings.Cut(value, "=")
	if !found || name == "" || item == "" {
		return fmt.Errorf("%s must be NAME=VALUE", pairFlag.flagName)
	}
	if pairFlag.values == nil {
		pairFlag.values = make(map[string]string)
	}
	pairFlag.values[name] = item
	return nil
}

// repeatedFlag collects a plain repeatable string flag.
type repeatedFlag []string

func (values *repeatedFlag) String() string { return strings.Join(*values, ",") }

func (values *repeatedFlag) Set(value string) error {
	if item := strings.TrimSpace(value); item != "" {
		*values = append(*values, item)
	}
	return nil
}

// loadSetupManifest resolves the manifest exactly the same way for plan and apply: the embedded
// manifest by default, or the given file parsed strictly. The raw bytes are returned alongside the
// parsed manifest because a plan's digest is taken over the exact source bytes.
func loadSetupManifest(manifestPath string) ([]byte, setup.Manifest, error) {
	if manifestPath == "" {
		manifest, err := setup.LoadDefaultManifest()
		if err != nil {
			return nil, setup.Manifest{}, err
		}
		return setup.DefaultManifestBytes(), manifest, nil
	}
	manifestBytes, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, setup.Manifest{}, fmt.Errorf("read adapter manifest: %w", err)
	}
	manifest, err := setup.ParseManifest(manifestBytes)
	if err != nil {
		return nil, setup.Manifest{}, fmt.Errorf("adapter manifest at %s: %w", manifestPath, err)
	}
	return manifestBytes, manifest, nil
}

// currentPlatform is the GOOS-GOARCH key the manifest and planner use for this node.
func currentPlatform() string {
	return runtime.GOOS + "-" + runtime.GOARCH
}

func runSetupPlan(args []string) int {
	set := flag.NewFlagSet("setup plan", flag.ContinueOnError)
	set.SetOutput(os.Stderr)
	dataRoot := set.String("data-root", setup.DefaultDataRoot(), "Barista-owned data root; never $HOME itself")
	manifestPath := set.String("manifest", "", "path to an adapter manifest JSON file (default: the manifest embedded in this binary)")
	outPath := set.String("out", "", "write the plan JSON to this path (default: stdout)")
	if err := set.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if set.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "setup plan: unexpected arguments: %s\n", strings.Join(set.Args(), " "))
		return 2
	}
	manifestBytes, manifest, err := loadSetupManifest(*manifestPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "setup plan: %v\n", err)
		return 2
	}
	// LoadOwnershipLedger returns an empty ledger without creating anything when the data root or
	// ledger does not exist yet, so planning stays strictly read-only against the data root.
	ledger, err := setup.LoadOwnershipLedger(*dataRoot)
	if err != nil {
		fmt.Fprintf(os.Stderr, "setup plan: %v\n", err)
		return 2
	}
	plan, skipped, err := setup.BuildPlan(manifestBytes, manifest, currentPlatform(), *dataRoot, ledger)
	if err != nil {
		fmt.Fprintf(os.Stderr, "setup plan: %v\n", err)
		return 2
	}
	encoded, err := json.MarshalIndent(plan, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "setup plan: encode plan: %v\n", err)
		return 2
	}
	var writer io.Writer = os.Stdout
	if *outPath != "" {
		file, err := os.Create(*outPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "setup plan: create --out file: %v\n", err)
			return 2
		}
		defer file.Close()
		writer = file
	}
	if _, err := writer.Write(append(encoded, '\n')); err != nil {
		fmt.Fprintf(os.Stderr, "setup plan: write plan: %v\n", err)
		return 2
	}
	for _, harnessID := range skipped {
		fmt.Fprintf(os.Stderr, "skipped: %s has no platform distribution for %s\n", harnessID, currentPlatform())
	}
	return 0
}

func runSetupApply(args []string) int {
	set := flag.NewFlagSet("setup apply", flag.ContinueOnError)
	set.SetOutput(os.Stderr)
	dataRoot := set.String("data-root", setup.DefaultDataRoot(), "Barista-owned data root; never $HOME itself")
	manifestPath := set.String("manifest", "", "path to an adapter manifest JSON file (default: the manifest embedded in this binary)")
	planPath := set.String("plan", "", "path to the plan JSON file produced by `barista setup plan` (required)")
	var allowedHosts repeatedFlag
	manualArtifacts := &nameValueFlag{flagName: "--manual-artifact"}
	manualChecksums := &nameValueFlag{flagName: "--manual-checksum"}
	set.Var(&allowedHosts, "allowed-host", "download host an archive adapter may redirect to; repeat the flag for multiple hosts")
	set.Var(manualArtifacts, "manual-artifact", "adapterID=PATH local artifact for a manual adapter; repeat the flag per adapter")
	set.Var(manualChecksums, "manual-checksum", "adapterID=SHA256 operator-asserted checksum for a manual adapter; repeat the flag per adapter")
	if err := set.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if set.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "setup apply: unexpected arguments: %s\n", strings.Join(set.Args(), " "))
		return 2
	}
	if *planPath == "" {
		fmt.Fprintln(os.Stderr, "setup apply: apply requires --plan")
		return 2
	}
	planBytes, err := os.ReadFile(*planPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "setup apply: read plan: %v\n", err)
		return 1
	}
	var plan setup.Plan
	if err := json.Unmarshal(planBytes, &plan); err != nil {
		fmt.Fprintf(os.Stderr, "setup apply: parse plan: %v\n", err)
		return 1
	}
	manifestBytes, manifest, err := loadSetupManifest(*manifestPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "setup apply: %v\n", err)
		return 1
	}
	ledger, err := setup.LoadOwnershipLedger(*dataRoot)
	if err != nil {
		fmt.Fprintf(os.Stderr, "setup apply: %v\n", err)
		return 1
	}
	// Apply stages every download and extraction under the data root, so apply — the one mutating
	// command — creates the root it owns when it does not exist yet. Planning and doctor never do.
	if err := os.MkdirAll(*dataRoot, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "setup apply: create data root: %v\n", err)
		return 1
	}
	result, err := setup.Apply(context.Background(), plan, manifestBytes, ledger, *dataRoot, setup.ApplyOptions{
		HTTPClient:            &http.Client{Timeout: applyHTTPTimeout},
		AllowedHosts:          allowedHosts,
		ManualArtifactSources: manualArtifacts.values,
		ManualChecksums:       manualChecksums.values,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "setup apply: %v\n", err)
		return 1
	}
	// Apply persists the ownership ledger itself after every completed operation, so this command
	// never writes the ledger a second time.
	harnessByAdapter := make(map[string]string, len(manifest.Adapters))
	for index := range manifest.Adapters {
		harnessByAdapter[manifest.Adapters[index].ID] = manifest.Adapters[index].HarnessID
	}
	for _, operation := range result.Applied {
		fmt.Printf("installed: %s@%s\n", operation.AdapterID, operation.AdapterVersion)
		fmt.Print(config.AdapterConfigSnippet(harnessByAdapter[operation.AdapterID], operation.TargetPath))
	}
	for _, operation := range result.Skipped {
		fmt.Printf("already installed: %s\n", operation.AdapterID)
	}
	return 0
}

// runDoctor builds and prints one read-only readiness report. Doctor reporting problems is not a
// command failure: it exits 0 whenever a report could be built, and non-zero only when even that
// was impossible (for example an unparseable manifest).
func runDoctor(args []string) int {
	set := flag.NewFlagSet("doctor", flag.ContinueOnError)
	set.SetOutput(os.Stderr)
	dataRoot := set.String("data-root", setup.DefaultDataRoot(), "Barista-owned data root; never $HOME itself")
	manifestPath := set.String("manifest", "", "path to an adapter manifest JSON file (default: the manifest embedded in this binary)")
	controlEndpoint := set.String("control-endpoint", config.DefaultEndpoint, "Coffee Shop URL or WebSocket endpoint to test for reachability")
	asJSON := set.Bool("json", false, "print the report as JSON instead of a human-readable summary")
	if err := set.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if set.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "doctor: unexpected arguments: %s\n", strings.Join(set.Args(), " "))
		return 2
	}
	_, manifest, err := loadSetupManifest(*manifestPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "doctor: %v\n", err)
		return 1
	}
	ledger, err := setup.LoadOwnershipLedger(*dataRoot)
	if err != nil {
		fmt.Fprintf(os.Stderr, "doctor: %v\n", err)
		return 1
	}
	// Doctor reuses the same read-only --version discovery the daemon performs at startup; it is
	// the existing capability, not a new one.
	profiles := harness.Discover(context.Background())
	report := setup.RunDoctor(context.Background(), manifest, ledger, *dataRoot, currentPlatform(), profiles, *controlEndpoint, dialHubEndpoint)
	if *asJSON {
		encoded, err := json.MarshalIndent(report, "", "  ")
		if err != nil {
			fmt.Fprintf(os.Stderr, "doctor: encode report: %v\n", err)
			return 1
		}
		fmt.Println(string(encoded))
		return 0
	}
	for _, entry := range report.Adapters {
		fmt.Printf("%s (%s): harness=%s adapter=%s auth=%s launch=%s\n",
			entry.AdapterID, entry.HarnessID,
			installedOrMissing(entry.HarnessInstalled),
			installedOrMissing(entry.AdapterInstalled),
			entry.AuthReadiness,
			readyOrNot(entry.ACPLaunchReady))
		for _, note := range entry.Notes {
			fmt.Printf("  note: %s\n", note)
		}
	}
	fmt.Printf("hub %s: %s\n", report.HubConnectivity.Endpoint, reachableSummary(report.HubConnectivity))
	fmt.Printf("project readiness: %s\n", report.ProjectReadiness)
	return 0
}

func installedOrMissing(installed bool) string {
	if installed {
		return "installed"
	}
	return "missing"
}

func readyOrNot(ready bool) string {
	if ready {
		return "ready"
	}
	return "not-ready"
}

func reachableSummary(connectivity setup.HubConnectivity) string {
	if connectivity.Reachable {
		return "reachable"
	}
	if connectivity.Detail == "" {
		return "unreachable"
	}
	return "unreachable (" + connectivity.Detail + ")"
}

// dialHubEndpoint performs one bounded, read-only TCP connection attempt against the endpoint's
// host:port and closes the connection immediately; doctor never authenticates and sends no bytes.
func dialHubEndpoint(ctx context.Context, endpoint string) error {
	hostPort, err := hostPortFromEndpoint(endpoint)
	if err != nil {
		return err
	}
	connection, err := (&net.Dialer{Timeout: doctorDialTimeout}).DialContext(ctx, "tcp", hostPort)
	if err != nil {
		return err
	}
	return connection.Close()
}

// hostPortFromEndpoint derives a dialable host:port from a control endpoint URL the same way
// config.WebSocketEndpoint parses it, defaulting the port by scheme when the URL carries none.
func hostPortFromEndpoint(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if !strings.Contains(value, "://") {
		value = "https://" + value
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" {
		return "", fmt.Errorf("control endpoint %q is not a valid URL", raw)
	}
	port := parsed.Port()
	if port == "" {
		switch parsed.Scheme {
		case "http", "ws":
			port = "80"
		default:
			port = "443"
		}
	}
	return net.JoinHostPort(parsed.Hostname(), port), nil
}
