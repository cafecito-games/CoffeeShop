// Command fakeharness is the deterministic stand-in for every provider executable the system
// test puts in front of a real Barista. One binary plays four roles, chosen by the name it is
// invoked under: "codex-acp" and "claude-agent-acp" speak ACP v1 over stdio like the real
// adapters, and "codex" and "claude" emulate the native CLIs' version check and JSON event
// streams. It never contacts a provider or any host other than the loopback Coffee Shop MCP
// endpoint Barista offers it.
//
// Behavior is scripted by the prompt: the last <fake-script>...</fake-script> block in the text a
// run receives is decoded as a Script and executed (see script.go). Test-owned directories named
// by environment variables hold the only state the fake keeps between processes: records of every
// process it started (for leak detection), provider session identities (so a test can make a
// session stale), and gates (so a test can hold a step until it has observed the system).
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Environment variables the fake reads. None of them is a credential.
const (
	recordDirectoryVariable  = "COFFEE_SHOP_FAKE_RECORD_DIRECTORY"
	sessionDirectoryVariable = "COFFEE_SHOP_FAKE_SESSION_DIRECTORY"
	gateDirectoryVariable    = "COFFEE_SHOP_FAKE_GATE_DIRECTORY"
)

// ObservedEnvironment lists the variables whose presence, never their value, each process records
// at startup, so a test can prove provider authentication stayed on the compute node and Coffee
// Shop credentials never reached a harness.
var observedEnvironment = []string{
	"OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "GITHUB_TOKEN",
	"COFFEE_SHOP_TOKEN", "COFFEE_SHOP_MCP_TOKEN", "INITIAL_AGENT_MODE", "CODEX_PATH", "CLAUDE_CODE_EXECUTABLE",
}

func main() {
	role := strings.TrimSuffix(filepath.Base(os.Args[0]), filepath.Ext(os.Args[0]))
	recorder := newRecorder(role)
	var code int
	switch role {
	case "codex-acp":
		code = runACP(recorder, codexFlavor)
	case "claude-agent-acp":
		code = runACP(recorder, claudeFlavor)
	case "codex", "claude":
		code = runNative(recorder, role, os.Args[1:])
	default:
		fmt.Fprintf(os.Stderr, "fakeharness: unknown role %q\n", role)
		code = 64
	}
	terminate(code)
}
