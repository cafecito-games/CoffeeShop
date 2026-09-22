package readiness

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

const (
	probeTimeout        = 5 * time.Second
	probeMaxOutputBytes = 4096
)

// looksSecretLike delegates to the single Go-side secret-detection definition in
// internal/protocol, so probe redaction and every other Go caller (config validation, evidence
// screening) can never drift apart on what counts as secret-like.
func looksSecretLike(text string) bool {
	return protocol.LooksSecretLike(text)
}

// probeDefinitionVersion identifies the current compile-time definition of every probe below.
// Bump it by hand whenever a probe's Args or Parse semantics change so the hub can distinguish
// evidence produced by incompatible probe generations.
const probeDefinitionVersion = "1"

// Output bounds mirror the unexported protocol constants rawValueBytes (256),
// normalizedValueBytes (64), and capabilityDiagnosticBytes (512) in capability.go.
const (
	rawValueMaximumBytes   = 256
	normalizedMaximumBytes = 64
	diagnosticMaximumBytes = 512
)

// Probe is a fixed, Go-compiled {binary, args} pair. Probes are never accepted from the hub, from
// task or run payloads, or from any other network input: extending node capability discovery
// means adding an entry to AllowlistedProbes in this file, never accepting one from outside the
// binary.
type Probe struct {
	CapabilityID   string
	Label          string
	Binary         string
	Args           []string
	Timeout        time.Duration
	MaxOutputBytes int
	Parse          func(rawOutput string) (normalized string, ok bool)
}

var AllowlistedProbes = []Probe{
	{CapabilityID: "go", Label: "Go", Binary: "go", Args: []string{"version"}, Timeout: probeTimeout, MaxOutputBytes: probeMaxOutputBytes, Parse: parseGoVersion},
	{CapabilityID: "git", Label: "Git", Binary: "git", Args: []string{"--version"}, Timeout: probeTimeout, MaxOutputBytes: probeMaxOutputBytes, Parse: GenericVersionParser},
	{CapabilityID: "node", Label: "Node.js", Binary: "node", Args: []string{"--version"}, Timeout: probeTimeout, MaxOutputBytes: probeMaxOutputBytes, Parse: parseNodeVersion},
	{CapabilityID: "pnpm", Label: "pnpm", Binary: "pnpm", Args: []string{"--version"}, Timeout: probeTimeout, MaxOutputBytes: probeMaxOutputBytes, Parse: GenericVersionParser},
	{CapabilityID: "gcc", Label: "GCC", Binary: "gcc", Args: []string{"--version"}, Timeout: probeTimeout, MaxOutputBytes: probeMaxOutputBytes, Parse: parseGCCVersion},
	{CapabilityID: "clang", Label: "Clang", Binary: "clang", Args: []string{"--version"}, Timeout: probeTimeout, MaxOutputBytes: probeMaxOutputBytes, Parse: parseClangVersion},
	{CapabilityID: "xcodebuild", Label: "Xcode", Binary: "xcodebuild", Args: []string{"-version"}, Timeout: probeTimeout, MaxOutputBytes: probeMaxOutputBytes, Parse: parseXcodeVersion},
}

// probeExecution is the raw outcome of running one probe, before it is shaped into protocol
// evidence. Tests exercise executeProbe directly so they never depend on which toolchains are
// installed, and only the integration tests below run real binaries.
type probeExecution struct {
	Output    string
	Err       error // non-nil when the binary was not found or exited non-zero
	TimedOut  bool
	Oversized bool
}

// executeProbe resolves binary with exec.LookPath (so "not found" stays distinct from a nonzero
// exit) and runs it with a bounded timeout, capturing combined stdout and stderr through an
// io.LimitReader capped at maxOutputBytes+1 bytes so "exactly at the limit" can be distinguished
// from "truncated". It never invokes a shell and never string-joins arguments; binary and args
// always originate from a compiled Probe value.
func executeProbe(ctx context.Context, binary string, args []string, timeout time.Duration, maxOutputBytes int) probeExecution {
	path, err := exec.LookPath(binary)
	if err != nil {
		return probeExecution{Err: err}
	}
	timeoutContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	command := exec.CommandContext(timeoutContext, path, args...)
	reader, writer := io.Pipe()
	command.Stdout = writer
	command.Stderr = writer
	if err := command.Start(); err != nil {
		reader.Close()
		writer.Close()
		// Start fails outright when the timeout context is already expired, so the timed-out
		// classification has to be derived here too.
		return probeExecution{Err: err, TimedOut: timeoutContext.Err() == context.DeadlineExceeded}
	}
	var captured bytes.Buffer
	copyDone := make(chan error, 1)
	go func() {
		_, copyErr := io.Copy(&captured, io.LimitReader(reader, int64(maxOutputBytes)+1))
		// Closing the read end unblocks a child still writing past the cap instead of letting it
		// hang command.Wait.
		reader.Close()
		copyDone <- copyErr
	}()
	runErr := command.Wait()
	writer.Close()
	if copyErr := <-copyDone; runErr == nil {
		runErr = copyErr
	}
	return probeExecution{
		Output:    captured.String()[:min(captured.Len(), maxOutputBytes)],
		Err:       runErr,
		TimedOut:  timeoutContext.Err() == context.DeadlineExceeded,
		Oversized: captured.Len() > maxOutputBytes,
	}
}

// RunProbe builds one evidence entry from a probe execution. ObservedAt is deliberately left
// empty here so RunProbe performs no wall-clock read and stays trivially testable; report.go
// stamps every entry with a single report-wide timestamp.
func RunProbe(ctx context.Context, probe Probe) protocol.NodeCapabilityEvidence {
	execution := executeProbe(ctx, probe.Binary, probe.Args, probe.Timeout, probe.MaxOutputBytes)
	evidence := protocol.NodeCapabilityEvidence{
		CapabilityID:           probe.CapabilityID,
		Source:                 protocol.CapabilityEvidenceSourceProbe,
		ProbeDefinitionVersion: probeDefinitionVersion,
	}
	switch {
	case errors.Is(execution.Err, exec.ErrNotFound):
		evidence.Diagnostic = "executable not found on PATH"
	case execution.TimedOut:
		evidence.Diagnostic = fmt.Sprintf("probe timed out after %s", probe.Timeout)
	case execution.Oversized:
		evidence.Diagnostic = fmt.Sprintf("probe output exceeded %d bytes", probe.MaxOutputBytes)
	case execution.Err != nil:
		evidence.Diagnostic = boundedString(execution.Output, diagnosticMaximumBytes)
		if looksSecretLike(evidence.Diagnostic) {
			evidence.Diagnostic = "probe diagnostic withheld: output looked secret-like"
		}
	default:
		evidence.Success = true
		evidence.RawValue = boundedString(execution.Output, rawValueMaximumBytes)
		// An unparseable version leaves NormalizedValue empty on purpose: an unknown version must
		// never satisfy a versioned hard requirement, which the hub enforces by finding no value.
		if normalized, ok := probe.Parse(execution.Output); ok {
			evidence.NormalizedValue = boundedString(normalized, normalizedMaximumBytes)
		}
		// Probe output is never trusted verbatim when it looks like it carries a credential: the
		// whole entry is downgraded to a redacted failure rather than sending any matched value.
		if looksSecretLike(evidence.RawValue) || looksSecretLike(evidence.NormalizedValue) {
			evidence.Success = false
			evidence.RawValue = ""
			evidence.NormalizedValue = ""
			evidence.Diagnostic = "probe output withheld: output looked secret-like"
		}
	}
	return evidence
}

// boundedString truncates to at most maximumBytes without splitting a multi-byte UTF-8 sequence.
// A byte-index slice alone can cut a rune in half; Go's JSON encoder then replaces the orphaned
// trailing bytes with the 3-byte U+FFFD replacement character, which can grow the encoded string
// past the very byte limit this function exists to enforce.
func boundedString(value string, maximumBytes int) string {
	if len(value) <= maximumBytes {
		return value
	}
	truncated := value[:maximumBytes]
	for len(truncated) > 0 {
		r, size := utf8.DecodeLastRuneInString(truncated)
		if r != utf8.RuneError || size > 1 {
			break
		}
		truncated = truncated[:len(truncated)-1]
	}
	return truncated
}

// dottedNumberPattern captures a maximal run of digits and dots with no per-segment or
// per-count cap. The version grammar itself (protocol.IsNormalizedVersion) is the only bound
// applied to the captured token: a capped quantifier here would silently truncate a malformed
// token — for example an eight-digit build date — into a shorter prefix that happens to satisfy
// the grammar, reporting a fabricated version instead of failing closed as unparseable.
var dottedNumberPattern = regexp.MustCompile(`\d+(\.\d+)*`)

// firstNormalizedVersion returns the first maximal dotted-number run in text that also satisfies
// protocol.IsNormalizedVersion, reusing the protocol grammar rather than reimplementing it. A
// token that fails the grammar (too many segments, an oversized segment) is unparseable — it is
// never truncated into a shorter, valid-looking substring.
func firstNormalizedVersion(text string) (string, bool) {
	match := dottedNumberPattern.FindString(text)
	if match == "" || !protocol.IsNormalizedVersion(match) {
		return "", false
	}
	return match, true
}

// GenericVersionParser is the generic executable-version parser: the first normalized
// dotted-number run in the probe output. It covers baseline toolchains whose version is simply
// the first dotted number they print; adding a new baseline toolchain means adding one Probe
// entry to AllowlistedProbes, never accepting a probe definition from outside the binary.
var GenericVersionParser = firstNormalizedVersion

// parseGoVersion strips the exact "go version go" prefix first so a stray number in the
// platform suffix can never be picked up before the version.
func parseGoVersion(rawOutput string) (string, bool) {
	return firstNormalizedVersion(strings.TrimPrefix(rawOutput, "go version go"))
}

func parseNodeVersion(rawOutput string) (string, bool) {
	return firstNormalizedVersion(strings.TrimPrefix(strings.TrimSpace(rawOutput), "v"))
}

// parseGCCVersion locates the compiler version rather than trusting the last dotted-number run on
// the line, which can be a distribution build identifier or part of a trailing build date, not
// the version. Every observed real-world `gcc --version` first line — Debian/Ubuntu
// ("gcc (Ubuntu 13.2.0-4ubuntu3) 13.2.0"), Homebrew ("gcc (Homebrew GCC 13.2.0) 13.2.0"), Red
// Hat/Fedora ("gcc (GCC) 8.5.0 20210514 (Red Hat 8.5.0-20)"), and a plain upstream build
// ("gcc (GCC) 13.2.0") — prints the actual compiler version as the first version-grammar token
// after the line's first closing parenthesis; a distribution package suffix or a build date never
// precedes that closing paren in any of these shapes. A build with no parenthetical at all falls
// back to the first version-grammar token anywhere on the line. Either way, an ambiguous or
// malformed token is reported unparseable rather than guessed at.
func parseGCCVersion(rawOutput string) (string, bool) {
	firstLine, _, _ := strings.Cut(rawOutput, "\n")
	afterFirstParen := firstLine
	if closingParen := strings.IndexByte(firstLine, ')'); closingParen >= 0 {
		afterFirstParen = firstLine[closingParen+1:]
	}
	return firstNormalizedVersion(afterFirstParen)
}

// parseClangVersion scans from just after the word "version" when present (falling back to just
// after "clang") so build identifiers inside the parenthetical, such as clang-1500.3.9.4, never
// win over the actual version.
func parseClangVersion(rawOutput string) (string, bool) {
	lowered := strings.ToLower(rawOutput)
	text := rawOutput
	if index := strings.Index(lowered, "version"); index >= 0 {
		text = rawOutput[index+len("version"):]
	} else if index := strings.Index(lowered, "clang"); index >= 0 {
		text = rawOutput[index+len("clang"):]
	}
	return firstNormalizedVersion(text)
}

// parseXcodeVersion reads only the first line so the build number on line two, such as 15F31d,
// never wins.
func parseXcodeVersion(rawOutput string) (string, bool) {
	firstLine, _, _ := strings.Cut(rawOutput, "\n")
	return firstNormalizedVersion(firstLine)
}
