package config

import (
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

const DefaultEndpoint = "http://localhost:8787"

// Bounds on the operator-declared inventory lists, applied after exact-duplicate removal so a
// repeated entry costs nothing. Mirrored by the readiness report's evidence-entry bound.
const (
	MaximumLabels       = 32
	MaximumAccelerators = 32
	MaximumToolchains   = 32
)

var projectIDPattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

// A Toolchain is an operator-declared toolchain identifier with an optional normalized version.
// The grammar and byte bound come from protocol.LabelOrAcceleratorPattern/
// protocol.LabelOrAcceleratorMaximumBytes and protocol.IsNormalizedVersion: a toolchain id is
// embedded verbatim into a capability id ("toolchain:<id>") and its version into that evidence
// entry's NormalizedValue, so config must enforce exactly what the protocol's single source of
// truth defines — a locally duplicated, looser bound would make the hub reject the whole
// capability report, not just the oversized entry.
type Toolchain struct {
	ID      string
	Version string
}

type Config struct {
	ControlEndpoint  string
	Name             string
	NodeID           string
	Kind             string
	WorkspaceRoots   []string
	Concurrency      int
	Token            string
	VersionOnly      bool
	ProjectAllowlist []string
	Labels           []string
	Accelerators     []string
	Toolchains       []Toolchain
	MemoryMegabytes  int // 0 means "not configured"; never reported as evidence when 0
}

type stringList []string

func (values *stringList) String() string { return strings.Join(*values, ",") }

func (values *stringList) Set(value string) error {
	if item := strings.TrimSpace(value); item != "" {
		*values = append(*values, item)
	}
	return nil
}

// strictStringList collects label, accelerator, and toolchain flag values. Unlike stringList it
// keeps empty entries so Parse can reject them with the same field-and-index error the other
// validation uses; the flag package's own error format would echo the rejected value.
type strictStringList []string

func (values *strictStringList) String() string { return strings.Join(*values, ",") }

func (values *strictStringList) Set(value string) error {
	*values = append(*values, strings.TrimSpace(value))
	return nil
}

func Parse(args []string) (Config, error) {
	host, err := os.Hostname()
	if err != nil {
		return Config{}, fmt.Errorf("read hostname: %w", err)
	}
	workingDirectory, err := os.Getwd()
	if err != nil {
		return Config{}, fmt.Errorf("read working directory: %w", err)
	}

	concurrency, err := envPositiveInt("BARISTA_CONCURRENCY", 2)
	if err != nil {
		return Config{}, err
	}
	memoryMegabytes, err := envOptionalPositiveInt("BARISTA_MEMORY_MEGABYTES")
	if err != nil {
		return Config{}, err
	}
	roots := stringList(splitEnv("WORKSPACE_ROOTS"))
	projects := stringList(splitEnv("BARISTA_PROJECT_ALLOWLIST"))
	labels := strictStringList(splitStrictEnv("BARISTA_LABELS"))
	accelerators := strictStringList(splitStrictEnv("BARISTA_ACCELERATORS"))
	toolchains := strictStringList(splitStrictEnv("BARISTA_TOOLCHAINS"))
	set := flag.NewFlagSet("barista", flag.ContinueOnError)
	set.SetOutput(os.Stderr)
	endpoint := set.String("control-endpoint", env("CONTROL_ENDPOINT", DefaultEndpoint), "Coffee Shop URL or WebSocket endpoint")
	name := set.String("name", env("BARISTA_NAME", host), "display name for this compute node")
	nodeID := set.String("id", env("BARISTA_ID", slug(host)), "stable compute node id")
	kind := set.String("kind", env("BARISTA_KIND", "local"), "compute node kind: local, home-server, or cloud")
	set.Var(&roots, "workspace-root", "allowed workspace root; repeat the flag for multiple roots")
	set.Var(&projects, "project", "project ID this node accepts work for; repeat the flag for multiple IDs")
	set.Var(&labels, "label", "operator-assigned capability label (lowercase letters, numbers, and hyphens); repeat the flag for multiple labels")
	set.Var(&accelerators, "accelerator", "hardware accelerator available on this node (lowercase letters, numbers, and hyphens); repeat the flag for multiple accelerators")
	set.Var(&toolchains, "toolchain", "toolchain available on this node, as <id> or <id>@<version> (lowercase letters, numbers, and hyphens; dotted numeric version); repeat the flag for multiple toolchains")
	limit := set.Int("concurrency", concurrency, "maximum number of simultaneous runs")
	memory := set.Int("memory-megabytes", memoryMegabytes, "configured system memory in megabytes (0 means not configured)")
	token := set.String("token", os.Getenv("COFFEE_SHOP_TOKEN"), "control-plane token (prefer COFFEE_SHOP_TOKEN)")
	versionOnly := set.Bool("version", false, "print the Barista version")
	if err := set.Parse(args); err != nil {
		return Config{}, err
	}
	if len(set.Args()) > 0 {
		return Config{}, fmt.Errorf("unexpected arguments: %s", strings.Join(set.Args(), " "))
	}
	if len(roots) == 0 {
		roots = []string{workingDirectory}
	}

	canonicalRoots, err := canonicalizeRoots(roots)
	if err != nil {
		return Config{}, err
	}
	wsEndpoint, err := WebSocketEndpoint(*endpoint)
	if err != nil {
		return Config{}, err
	}
	if strings.TrimSpace(*name) == "" {
		return Config{}, errors.New("name must not be empty")
	}
	if *nodeID == "" || *nodeID != slug(*nodeID) {
		return Config{}, errors.New("id must contain only letters, numbers, and hyphens")
	}
	if *kind != "local" && *kind != "home-server" && *kind != "cloud" {
		return Config{}, errors.New("kind must be local, home-server, or cloud")
	}
	if *limit < 1 {
		return Config{}, errors.New("concurrency must be at least one")
	}
	for _, project := range projects {
		if !projectIDPattern.MatchString(project) {
			return Config{}, fmt.Errorf("project id %q must contain only letters, numbers, and hyphens", project)
		}
	}
	// Every rejection below names the field and its position, never the value itself: an inventory
	// entry is arbitrary operator-supplied text, this validation is exactly what screens it for a
	// secret, and configuration errors are commonly logged, so the rejected value must never appear
	// in the error even when rejection was for an unrelated reason (emptiness, length, or grammar).
	validatedLabels, err := validatedCapabilitySegments("label", labels, MaximumLabels)
	if err != nil {
		return Config{}, err
	}
	validatedAccelerators, err := validatedCapabilitySegments("accelerator", accelerators, MaximumAccelerators)
	if err != nil {
		return Config{}, err
	}
	validatedToolchains, err := validatedToolchains(toolchains, MaximumToolchains)
	if err != nil {
		return Config{}, err
	}
	if *memory < 0 {
		return Config{}, errors.New("memory megabytes must not be negative")
	}

	return Config{
		ControlEndpoint:  wsEndpoint,
		Name:             strings.TrimSpace(*name),
		NodeID:           *nodeID,
		Kind:             *kind,
		WorkspaceRoots:   canonicalRoots,
		Concurrency:      *limit,
		Token:            *token,
		VersionOnly:      *versionOnly,
		ProjectAllowlist: deduplicate(projects),
		Labels:           validatedLabels,
		Accelerators:     validatedAccelerators,
		Toolchains:       validatedToolchains,
		MemoryMegabytes:  *memory,
	}, nil
}

// validatedCapabilitySegments checks and deduplicates one plain-segment inventory list (labels,
// accelerators). The secret screen runs before the length and grammar checks so a secret-looking
// entry is never rejected under a message that hints at its shape instead.
func validatedCapabilitySegments(field string, values []string, maximum int) ([]string, error) {
	for index, value := range values {
		if value == "" {
			return nil, fmt.Errorf("%s at index %d is empty", field, index)
		}
		// A kebab-case grammar alone does not rule out a lowercase, hyphenated secret (for example
		// "sk-abcdefghij1234567890"), and an inventory entry becomes a capability id and evidence
		// value that Barista reports to the hub, so it is screened exactly like probe output.
		if protocol.LooksSecretLike(value) {
			return nil, fmt.Errorf("%s at index %d looks like it contains a secret and was rejected", field, index)
		}
		if len(value) > protocol.LabelOrAcceleratorMaximumBytes {
			return nil, fmt.Errorf("%s at index %d exceeds %d bytes", field, index, protocol.LabelOrAcceleratorMaximumBytes)
		}
		if !protocol.LabelOrAcceleratorPattern.MatchString(value) {
			return nil, fmt.Errorf("%s at index %d must contain only lowercase letters, numbers, and hyphens", field, index)
		}
	}
	deduplicated := deduplicate(values)
	if len(deduplicated) > maximum {
		return nil, fmt.Errorf("at most %d %ss may be configured", maximum, field)
	}
	return deduplicated, nil
}

// validatedToolchains parses, checks, and deduplicates the toolchain list. An exact duplicate
// (same id and version) is dropped like any other duplicate; two entries that name the same
// toolchain id with different versions — including one with a version and one without — conflict,
// because the hub would otherwise see two different claims about one capability.
func validatedToolchains(values []string, maximum int) ([]Toolchain, error) {
	if len(values) == 0 {
		return nil, nil
	}
	result := make([]Toolchain, 0, len(values))
	seenEntries := map[string]bool{}
	seenIdentifiers := map[string]bool{}
	for index, value := range values {
		if value == "" {
			return nil, fmt.Errorf("toolchain at index %d is empty", index)
		}
		if protocol.LooksSecretLike(value) {
			return nil, fmt.Errorf("toolchain at index %d looks like it contains a secret and was rejected", index)
		}
		if strings.Count(value, "@") > 1 {
			return nil, fmt.Errorf("toolchain at index %d must contain at most one \"@\"", index)
		}
		identifier, version, hasVersion := strings.Cut(value, "@")
		if hasVersion && version == "" {
			return nil, fmt.Errorf("toolchain at index %d has an empty version after \"@\"", index)
		}
		if len(identifier) > protocol.LabelOrAcceleratorMaximumBytes {
			return nil, fmt.Errorf("toolchain at index %d exceeds %d bytes", index, protocol.LabelOrAcceleratorMaximumBytes)
		}
		if !protocol.LabelOrAcceleratorPattern.MatchString(identifier) {
			return nil, fmt.Errorf("toolchain at index %d must contain only lowercase letters, numbers, and hyphens", index)
		}
		if version != "" && !protocol.IsNormalizedVersion(version) {
			return nil, fmt.Errorf("toolchain at index %d has a version that is not a normalized dotted number", index)
		}
		if seenEntries[value] {
			continue
		}
		seenEntries[value] = true
		// Reaching here with an already-seen identifier means the same toolchain was declared with
		// a different version (an identical declaration was deduplicated above).
		if seenIdentifiers[identifier] {
			return nil, fmt.Errorf("toolchain at index %d conflicts with an earlier entry for the same toolchain", index)
		}
		seenIdentifiers[identifier] = true
		result = append(result, Toolchain{ID: identifier, Version: version})
	}
	if len(result) > maximum {
		return nil, fmt.Errorf("at most %d toolchains may be configured", maximum)
	}
	return result, nil
}

// deduplicate removes repeated entries while preserving first-seen order, mirroring the approach
// canonicalizeRoots uses for workspace roots.
func deduplicate(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	result := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		if !seen[value] {
			result = append(result, value)
			seen[value] = true
		}
	}
	return result
}

func WebSocketEndpoint(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if !strings.Contains(value, "://") {
		value = "https://" + value
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" {
		return "", fmt.Errorf("control endpoint %q is not a valid URL", raw)
	}
	switch parsed.Scheme {
	case "http":
		parsed.Scheme = "ws"
	case "https":
		parsed.Scheme = "wss"
	case "ws", "wss":
	default:
		return "", fmt.Errorf("control endpoint must use http, https, ws, or wss")
	}
	if parsed.Path == "" || parsed.Path == "/" {
		parsed.Path = "/control-agent"
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

func canonicalizeRoots(roots []string) ([]string, error) {
	result := make([]string, 0, len(roots))
	seen := map[string]bool{}
	for _, root := range roots {
		if !filepath.IsAbs(root) {
			return nil, fmt.Errorf("workspace root %q must be an absolute path", root)
		}
		absolute, err := filepath.Abs(root)
		if err != nil {
			return nil, fmt.Errorf("resolve workspace root %q: %w", root, err)
		}
		canonical, err := filepath.EvalSymlinks(absolute)
		if err != nil {
			return nil, fmt.Errorf("resolve workspace root %q: %w", root, err)
		}
		if !seen[canonical] {
			result = append(result, canonical)
			seen[canonical] = true
		}
	}
	return result, nil
}

func slug(value string) string {
	var result strings.Builder
	lastHyphen := false
	for _, char := range strings.ToLower(value) {
		valid := char >= 'a' && char <= 'z' || char >= '0' && char <= '9'
		if valid {
			result.WriteRune(char)
			lastHyphen = false
		} else if result.Len() > 0 && !lastHyphen {
			result.WriteByte('-')
			lastHyphen = true
		}
	}
	return strings.Trim(result.String(), "-")
}

func env(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envPositiveInt(key string, fallback int) (int, error) {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 1 {
		return 0, fmt.Errorf("%s must be a positive integer", key)
	}
	return parsed, nil
}

// envOptionalPositiveInt reads an integer that may be legitimately absent. An empty value returns
// 0, and an explicit 0 is indistinguishable from unset so it is also accepted: the caller treats
// 0 as "not configured" and must never silently default it to a nonzero number. Only a negative
// or non-integer value is rejected.
func envOptionalPositiveInt(key string) (int, error) {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return 0, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 0 {
		return 0, fmt.Errorf("%s must be a non-negative integer", key)
	}
	return parsed, nil
}

func splitEnv(key string) []string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return nil
	}
	return strings.FieldsFunc(value, func(char rune) bool {
		return char == ','
	})
}

// splitStrictEnv splits a comma-separated environment value for the inventory lists (labels,
// accelerators, toolchains). Unlike splitEnv it preserves empty segments — including a trailing
// comma's — so Parse can reject them by index; a wholly empty or unset value still means "none".
func splitStrictEnv(key string) []string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return nil
	}
	entries := strings.Split(value, ",")
	for index, entry := range entries {
		entries[index] = strings.TrimSpace(entry)
	}
	return entries
}

func Platform() string { return runtime.GOOS + " · " + runtime.GOARCH }

// AdapterConfigSnippet renders the exact environment variable an operator would add to a Barista
// invocation to register a verified, locally installed ACP adapter once a later release wires
// setup-installed adapters into the ACP driver. It performs no file write and no runtime
// registration itself — it is documentation output only, matching the requirement that no
// permanent Coffee Shop server entry or harness reconfiguration happens implicitly. The harness
// ID's kebab-case segments become an uppercase, underscore-separated environment variable name
// segment.
func AdapterConfigSnippet(harnessID string, adapterBinaryPath string) string {
	environmentName := strings.ToUpper(strings.ReplaceAll(harnessID, "-", "_"))
	return fmt.Sprintf("# %s ACP adapter (installed by `barista setup apply`)\n# ACP_ADAPTER_%s=%s\n", harnessID, environmentName, adapterBinaryPath)
}
