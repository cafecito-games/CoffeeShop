package acptest

import "time"

// Capabilities advertised by the default handshake: HTTP MCP and session/close.
const (
	DefaultCapabilities = `{"loadSession":false,"promptCapabilities":{"image":false,"audio":false,"embeddedContext":false},"mcpCapabilities":{"http":true,"sse":false},"sessionCapabilities":{"close":{}}}`
	NoHTTPCapabilities  = `{"mcpCapabilities":{"http":false,"sse":true}}`
	agentInfo           = `{"name":"fake-acp-agent","title":"Fake ACP Agent","version":"1.0.0"}`
)

// Handshake answers initialize with the given capabilities and creates the session.
func Handshake(capabilities string) []Step {
	return []Step{
		Expect("initialize"),
		Respond("initialize", `{"protocolVersion":1,"agentCapabilities":`+capabilities+`,"authMethods":[],"agentInfo":`+agentInfo+`}`),
		Expect("session/new"),
		Respond("session/new", `{"sessionId":"{{session}}"}`),
	}
}

// Prompted performs the default handshake and waits for the prompt request.
func Prompted() []Step {
	return append(Handshake(DefaultCapabilities), Expect("session/prompt"))
}

// Finish answers the prompt with end_turn, answers session/close, and exits on stdin EOF.
func Finish() []Step {
	return []Step{
		Respond("session/prompt", `{"stopReason":"end_turn"}`),
		Expect("session/close"),
		Respond("session/close", `{}`),
		DrainUntilEOF(),
	}
}

func join(groups ...[]Step) []Step {
	steps := []Step{}
	for _, group := range groups {
		steps = append(steps, group...)
	}
	return steps
}

func repeat(text string, count int) string {
	buffer := make([]byte, 0, len(text)*count)
	for range count {
		buffer = append(buffer, text...)
	}
	return string(buffer)
}

// Scenarios maps scenario names to their scripted steps.
var Scenarios = map[string][]Step{
	"hang": {Hang()},

	"success": join(Prompted(), []Step{
		Update(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hello "}}`),
		Update(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"world"}}`),
	}, Finish()),

	"stream": join(Prompted(), []Step{
		Update(`{"sessionUpdate":"available_commands_update","availableCommands":[]}`),
		Update(`{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"Thinking"}}`),
		Update(`{"sessionUpdate":"plan","entries":[{"content":"Read code","priority":"high","status":"in_progress"},{"content":"Write tests","priority":"medium","status":"pending"}]}`),
		Update(`{"sessionUpdate":"tool_call","toolCallId":"call-1","title":"Edit main.go","kind":"edit","status":"pending"}`),
		Update(`{"sessionUpdate":"tool_call_update","toolCallId":"call-1","status":"completed","content":[{"type":"content","content":{"type":"text","text":"Applied edit"}},{"type":"diff","path":"/workspace/main.go","oldText":"old","newText":"new"}]}`),
		Update(`{"sessionUpdate":"usage_update","used":1200,"size":200000,"cost":{"amount":0.25,"currency":"USD"}}`),
		Update(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Done"}}`),
		Respond("session/prompt", `{"stopReason":"end_turn","usage":{"totalTokens":30,"inputTokens":10,"outputTokens":20,"cachedReadTokens":5}}`),
		Expect("session/close"),
		Respond("session/close", `{}`),
		DrainUntilEOF(),
	}),

	"partial-reads": join(Prompted(), []Step{
		Split(`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"{{session}}","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"split"}}}}`+"\n"+
			`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"{{session}}","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":" frames"}}}}`+"\n", 7, 5*time.Millisecond),
	}, Finish()),

	"permission": join(Prompted(), []Step{
		Frame(`{"jsonrpc":"2.0","id":"permission-1","method":"session/request_permission","params":{"sessionId":"{{session}}","toolCall":{"toolCallId":"call-1","title":"Run tests","kind":"execute"},"options":[{"optionId":"allow","name":"Allow once","kind":"allow_once"},{"optionId":"reject","name":"Reject","kind":"reject_once"}]}}`),
		ExpectResponse(`"permission-1"`, "permission"),
		Update(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"after permission"}}`),
	}, Finish()),

	"permission-malformed": join(Prompted(), []Step{
		Frame(`{"jsonrpc":"2.0","id":7,"method":"session/request_permission","params":{"sessionId":"{{session}}","toolCall":{"toolCallId":"call-1"},"options":[]}}`),
		ExpectResponse(`7`, "permission"),
	}, Finish()),

	"interleaved": join(Prompted(), []Step{
		Frame(`{"jsonrpc":"2.0","id":"permission-1","method":"session/request_permission","params":{"sessionId":"{{session}}","toolCall":{"toolCallId":"call-1","title":"Write file"},"options":[{"optionId":"allow","name":"Allow","kind":"allow_once"},{"optionId":"reject","name":"Reject","kind":"reject_once"}]}}`),
		Update(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"while waiting"}}`),
		Frame(`{"jsonrpc":"2.0","id":99,"method":"fs/read_text_file","params":{"sessionId":"{{session}}","path":"/etc/passwd"}}`),
		ExpectResponses(map[string]string{`99`: "read", `"permission-1"`: "permission"}),
	}, Finish()),

	"cancel-cooperative": join(Prompted(), []Step{
		Update(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"working"}}`),
		Expect("session/cancel"),
		Respond("session/prompt", `{"stopReason":"cancelled"}`),
		DrainUntilEOF(),
	}),

	"cancel-ignored": join(Prompted(), []Step{
		IgnoreTermination(),
		Update(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"working"}}`),
		Expect("session/cancel"),
		Hang(),
	}),

	"stderr-token-exit": join(Prompted(), []Step{
		Stderr("fatal: could not reach MCP with Authorization: Bearer {{token}}"),
		Exit(3),
	}),

	"stdout-contamination": join(Prompted(), []Step{
		Raw("Starting agent...\n"),
		Hang(),
	}),

	"embedded-frames": join(Prompted(), []Step{
		Raw(`{"jsonrpc":"2.0","method":"session/update","params":{}}{"jsonrpc":"2.0","method":"session/update","params":{}}` + "\n"),
		Hang(),
	}),

	"oversized-frame": join(Prompted(), []Step{
		Raw(`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"{{session}}","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"` + repeat("x", 4*1024*1024) + `"}}}}` + "\n"),
		Hang(),
	}),

	"unknown-response-id": join(Prompted(), []Step{
		Frame(`{"jsonrpc":"2.0","id":4242,"result":{}}`),
		Hang(),
	}),

	"duplicate-response-id": join(Handshake(DefaultCapabilities), []Step{
		Respond("initialize", `{"protocolVersion":1}`),
		Hang(),
	}),

	"version-mismatch": {
		Expect("initialize"),
		Respond("initialize", `{"protocolVersion":2,"agentCapabilities":`+DefaultCapabilities+`}`),
		DrainUntilEOF(),
	},

	"missing-http-mcp": {
		Expect("initialize"),
		Respond("initialize", `{"protocolVersion":1,"agentCapabilities":`+NoHTTPCapabilities+`}`),
		DrainUntilEOF(),
	},

	"authentication-required": {
		Expect("initialize"),
		Respond("initialize", `{"protocolVersion":1,"agentCapabilities":`+DefaultCapabilities+`,"authMethods":[{"id":"vendor-login","name":"Log in"}]}`),
		Expect("session/new"),
		RespondError("session/new", -32000, "Authentication required"),
		DrainUntilEOF(),
	},

	"premature-exit": join(Prompted(), []Step{
		Update(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"partial"}}`),
		Stderr("adapter crashed"),
		Exit(0),
	}),

	"unknown-notification": join(Prompted(), []Step{
		Frame(`{"jsonrpc":"2.0","method":"_vendor/telemetry","params":{"ok":true}}`),
		Frame(`{"jsonrpc":"2.0","method":"session/unheard_of","params":{}}`),
		Update(`{"sessionUpdate":"future_update_kind","payload":{}}`),
		Update(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"still fine"}}`),
	}, Finish()),

	"malformed-update": join(Prompted(), []Step{
		Update(`{"sessionUpdate":"tool_call","title":"missing identifier"}`),
		Hang(),
	}),

	"foreign-session": join(Prompted(), []Step{
		Frame(`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"another-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"x"}}}}`),
		Hang(),
	}),

	"updates-after-completion": join(Prompted(), []Step{
		Respond("session/prompt", `{"stopReason":"end_turn"}`),
		Update(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"late"}}`),
		Update(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"later"}}`),
		Expect("session/close"),
		Respond("session/close", `{}`),
		DrainUntilEOF(),
	}),

	"refusal": join(Prompted(), []Step{
		Respond("session/prompt", `{"stopReason":"refusal"}`),
		DrainUntilEOF(),
	}),

	"secret-echo": join(Prompted(), []Step{
		Update(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"token is {{token}}"}}`),
		Update(`{"sessionUpdate":"tool_call","toolCallId":"call-1","title":"curl -H 'Authorization: Bearer {{token}}'","kind":"fetch"}`),
	}, Finish()),
}
