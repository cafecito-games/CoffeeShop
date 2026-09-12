package config

import (
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

const DefaultEndpoint = "http://localhost:8787"

type Config struct {
	ControlEndpoint string
	Name            string
	NodeID          string
	Kind            string
	WorkspaceRoots  []string
	Concurrency     int
	Token           string
	VersionOnly     bool
}

type stringList []string

func (values *stringList) String() string { return strings.Join(*values, ",") }

func (values *stringList) Set(value string) error {
	if item := strings.TrimSpace(value); item != "" {
		*values = append(*values, item)
	}
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
	roots := stringList(splitEnv("WORKSPACE_ROOTS"))
	set := flag.NewFlagSet("barista", flag.ContinueOnError)
	set.SetOutput(os.Stderr)
	endpoint := set.String("control-endpoint", env("CONTROL_ENDPOINT", DefaultEndpoint), "Coffee Shop URL or WebSocket endpoint")
	name := set.String("name", env("BARISTA_NAME", host), "display name for this compute node")
	nodeID := set.String("id", env("BARISTA_ID", slug(host)), "stable compute node id")
	kind := set.String("kind", env("BARISTA_KIND", "local"), "compute node kind: local, home-server, or cloud")
	set.Var(&roots, "workspace-root", "allowed workspace root; repeat the flag for multiple roots")
	limit := set.Int("concurrency", concurrency, "maximum number of simultaneous runs")
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

	return Config{
		ControlEndpoint: wsEndpoint,
		Name:            strings.TrimSpace(*name),
		NodeID:          *nodeID,
		Kind:            *kind,
		WorkspaceRoots:  canonicalRoots,
		Concurrency:     *limit,
		Token:           *token,
		VersionOnly:     *versionOnly,
	}, nil
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

func splitEnv(key string) []string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return nil
	}
	return strings.FieldsFunc(value, func(char rune) bool {
		return char == ','
	})
}

func Platform() string { return runtime.GOOS + " · " + runtime.GOARCH }
