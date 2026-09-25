package capabilitypack

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

// Pack content carries workflow prose and nothing else. These screens enforce that by rejecting the
// four classes of content a capability pack must never contain, and they name only the file and the
// rule that fired — never the offending value, which may be exactly the credential the screen
// caught.
var (
	// urlSchemePattern matches any URI scheme followed by "//". A pack must name no endpoint at all:
	// the run-scoped MCP endpoint is injected per run and a pack that shipped one would be a second,
	// stale authorization path.
	urlSchemePattern = regexp.MustCompile(`(?i)\b[a-z][a-z0-9+.\-]*://`)
	// absolutePathPattern matches a machine-local absolute path, POSIX or Windows. Workflow prose is
	// portable; an absolute path in it is either a leaked operator path or an instruction that only
	// works on one machine.
	//
	// The POSIX rule is general rather than a list of known top-level directories: any leading-slash
	// path of two or more segments is rejected, so /workspace/..., /data/..., /run/..., and
	// /nix/store/... are caught as surely as /home/... A single-segment path (/etc, /tmp) still matches
	// the well-known-root alternative, because one segment is otherwise indistinguishable from prose
	// punctuation. The home-relative "~/" form is rejected for the same reason an absolute path is: it
	// names a location on one machine's filesystem.
	//
	// The Windows rules cover all three forms a Windows path takes: drive-absolute ("C:\dir"),
	// drive-relative ("C:dir\file" — still a location on one machine), and a UNC share
	// ("\\\\host\\share\\file"). Drive-relative requires a following separator so that ordinary prose
	// with a colon ("Step A:Done") is not mistaken for a path.
	absolutePathPattern = regexp.MustCompile(
		`(?:^|[^A-Za-z0-9._~/-])(?:` +
			`(?:/[A-Za-z0-9._-]+){2,}` +
			`|/(?:home|Users|var|etc|usr|opt|tmp|root|private|Volumes|mnt|srv|proc|sys|dev|bin|sbin|run|nix|data|workspace|Applications|Library)(?:/|\b)` +
			`|~/` +
			`|[A-Za-z]:(?:[\\/]|[A-Za-z0-9._-]+[\\/])` +
			`|\\\\[A-Za-z0-9._-]+[\\/]` +
			`)`)
	// schemaMarkers are the syntactic markers of a JSON Schema. The run-scoped MCP server owns every
	// tool input and output schema (internal/mcpserver/tools.go); a pack that restated one would
	// create a second schema that could drift from the served one.
	schemaMarkers = []string{"additionalProperties", "$schema", "inputSchema", "outputSchema", `"properties"`, `"$defs"`}
)

// screenContent applies every content rule to one packaged file. Files are required to be valid
// UTF-8 text: a capability pack is prose, and a binary blob could carry anything past a text screen.
func screenContent(path string, content []byte) error {
	if len(content) > MaximumFileBytes {
		return fmt.Errorf("pack file %s exceeds %d bytes", path, MaximumFileBytes)
	}
	if !utf8.Valid(content) {
		return fmt.Errorf("pack file %s is not valid UTF-8 text", path)
	}
	text := string(content)
	if protocol.LooksSecretLike(text) {
		return fmt.Errorf("pack file %s contains a secret-like value", path)
	}
	if urlSchemePattern.MatchString(text) {
		return fmt.Errorf("pack file %s contains a URL scheme; a pack declares no endpoint", path)
	}
	if absolutePathPattern.MatchString(text) {
		return fmt.Errorf("pack file %s contains an absolute machine path", path)
	}
	for _, marker := range schemaMarkers {
		if strings.Contains(text, marker) {
			return fmt.Errorf("pack file %s restates a tool schema; the run-scoped MCP server owns every tool schema", path)
		}
	}
	return nil
}

// screenSecrets runs only the secret screen, ahead of every structural check, for the same reason
// setup.Manifest.Validate screens before it validates: a structural rejection message must never
// become an oracle that echoes a pasted credential back.
func screenSecrets(path string, content []byte) error {
	if !utf8.Valid(content) {
		return fmt.Errorf("pack file %s is not valid UTF-8 text", path)
	}
	if protocol.LooksSecretLike(string(content)) {
		return fmt.Errorf("pack file %s contains a secret-like value", path)
	}
	return nil
}

// backtickedTokenPattern finds inline-code spans in Markdown, which is how a pack names a hub tool.
var backtickedTokenPattern = regexp.MustCompile("`([^`\n]{1,64})`")

// toolNamesInProse returns every hub-tool-shaped inline-code token in Markdown, in first-appearance
// order. A snake_case inline-code token in pack prose is a tool reference by construction, so a
// renamed or removed tool leaves a token validation refuses instead of shipping a name that no
// longer exists.
func toolNamesInProse(text string) []string {
	names := make([]string, 0, 8)
	for _, match := range backtickedTokenPattern.FindAllStringSubmatch(text, -1) {
		token := match[1]
		if !hubToolNamePattern.MatchString(token) {
			continue
		}
		if !contains(names, token) {
			names = append(names, token)
		}
	}
	return names
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

// screenDetail bounds a diagnostic taken from untrusted pack bytes and replaces it wholesale when it
// looks secret-like, so no rejection reason derived from pack content reaches an operator or a log
// unscreened.
func screenDetail(detail string) string {
	const maximumDetailBytes = 200
	bounded := detail
	if len(bounded) > maximumDetailBytes {
		for len(bounded) > maximumDetailBytes || !utf8.ValidString(bounded) {
			bounded = bounded[:len(bounded)-1]
		}
		bounded += "…"
	}
	if protocol.LooksSecretLike(bounded) {
		return "withheld: the diagnostic looked secret-like"
	}
	return bounded
}

// errNoPackManifest is the absent case, kept distinct from every malformed case so a caller can tell
// "this is not a pack" from "this pack is broken".
var errNoPackManifest = errors.New("no pack manifest")
