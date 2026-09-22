package main

import (
	"encoding/json"
	"testing"
)

func testEngine() *engine {
	return &engine{variables: map[string]any{
		"cwd":   "/work",
		"batch": map[string]any{"taskIdsByKey": map[string]any{"alpha": "task_1"}, "created": false},
		"graph": map[string]any{"tasks": []any{map[string]any{"status": "completed"}, map[string]any{"status": "completed"}}},
		"mixed": map[string]any{"tasks": []any{map[string]any{"status": "completed"}, map[string]any{"status": "running"}}},
	}}
}

func TestRenderReplacesWholeReferencesWithValuesAndInterpolatesText(t *testing.T) {
	rendered, err := testEngine().render(map[string]any{
		"taskId":  "{{batch.taskIdsByKey.alpha}}",
		"created": "{{batch.created}}",
		"summary": "created={{batch.created}} in {{cwd}}",
	})
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(rendered)
	if string(encoded) != `{"created":false,"summary":"created=false in /work","taskId":"task_1"}` {
		t.Fatalf("unexpected rendering: %s", encoded)
	}
}

func TestRenderPassesNestedScriptsVerbatim(t *testing.T) {
	nested := `run this <fake-script>{"steps":[{"message":"{{cwd}}"}]}</fake-script>`
	rendered, err := testEngine().render(nested)
	if err != nil || rendered != nested {
		t.Fatalf("a nested script was rendered: %v %v", rendered, err)
	}
}

func TestRenderFailsOnUnknownReference(t *testing.T) {
	if _, err := testEngine().render("{{missing.value}}"); err == nil {
		t.Fatal("an unknown reference rendered without an error")
	}
}

func TestConditionWildcardRequiresEveryElement(t *testing.T) {
	engine := testEngine()
	for path, expected := range map[string]bool{"graph.tasks.*.status": true, "mixed.tasks.*.status": false, "absent.*.status": false} {
		holds, err := engine.holds(Condition{Path: path, Equals: "completed"})
		if err != nil || holds != expected {
			t.Fatalf("condition %s = %v (%v), want %v", path, holds, err, expected)
		}
	}
}

func TestContainsMatchesSubsets(t *testing.T) {
	event := map[string]any{"type": "message", "message": map[string]any{"kind": "answer", "body": "hello"}}
	if !contains(event, map[string]any{"message": map[string]any{"kind": "answer"}}) {
		t.Fatal("a subset pattern did not match")
	}
	if contains(event, map[string]any{"message": map[string]any{"kind": "question"}}) {
		t.Fatal("a mismatching pattern matched")
	}
}

func TestExtractScriptUsesTheLastBlock(t *testing.T) {
	script, err := extractScript(`system <fake-script>{"steps":[{"message":"default"}]}</fake-script> user <fake-script>{"steps":[{"message":"primary"}]}</fake-script>`)
	if err != nil || len(script.Steps) != 1 || script.Steps[0].Message != "primary" {
		t.Fatalf("unexpected script %+v %v", script, err)
	}
}

func TestNativeInvocationReadsTheExactBaristaCommandLines(t *testing.T) {
	prompt, endpoint, err := nativeInvocation("codex", []string{"exec", "--json", "--sandbox", "workspace-write", "-c", `mcp_servers.coffee_shop_hub.url="http://127.0.0.1:4100/mcp"`, "-c", "mcp_servers.coffee_shop_hub.required=true", "do it"})
	if err != nil || prompt != "do it" || endpoint != "http://127.0.0.1:4100/mcp" {
		t.Fatalf("codex: %q %q %v", prompt, endpoint, err)
	}
	prompt, endpoint, err = nativeInvocation("claude", []string{"-p", "do it", "--output-format", "stream-json", "--mcp-config", `{"mcpServers":{"coffee_shop_hub":{"type":"http","url":"http://127.0.0.1:4200/mcp"}}}`})
	if err != nil || prompt != "do it" || endpoint != "http://127.0.0.1:4200/mcp" {
		t.Fatalf("claude: %q %q %v", prompt, endpoint, err)
	}
}

func TestMCPClientRefusesNonLoopbackEndpoints(t *testing.T) {
	if _, err := newMCPClient("https://example.test/mcp", "token"); err == nil {
		t.Fatal("a non-loopback MCP endpoint was accepted")
	}
}
