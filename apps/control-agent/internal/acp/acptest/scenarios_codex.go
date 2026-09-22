package acptest

// Frames shaped like the codex-acp adapter's: its mode and model session configuration options and
// its agent identity. The fake reports CodexAdapterVersion, which tests pin as the manifest version.
const (
	CodexAdapterVersion = "1.12.0"
	// CodexModel and CodexAlternateModel are the models the fake offers; CodexAlternateModel is not
	// the current one, so selecting it requires session/set_config_option.
	CodexModel          = "gpt-5.5"
	CodexAlternateModel = "gpt-5.4"
	codexAgentInfo      = `{"name":"@agentclientprotocol/codex-acp","title":"Codex","version":"` + CodexAdapterVersion + `"}`
	codexCapabilities   = `{"loadSession":true,"promptCapabilities":{"image":true,"embeddedContext":true},"mcpCapabilities":{"http":true,"sse":false},"sessionCapabilities":{"close":{},"resume":{}}}`
	codexModes          = `[{"value":"read-only","name":"Ask for approval"},{"value":"agent","name":"Approve for me"},{"value":"agent-full-access","name":"Full access"}]`
	codexModels         = `[{"group":"openai","name":"OpenAI","options":[{"value":"` + CodexModel + `","name":"5.5"},{"value":"` + CodexAlternateModel + `","name":"5.4"}]}]`
)

// CodexConfigOptions renders codex-acp's configOptions array with the given current mode and model.
func CodexConfigOptions(mode, model string) string {
	return `[{"id":"mode","name":"Mode","category":"mode","type":"select","currentValue":"` + mode + `","options":` + codexModes + `},` +
		`{"id":"model","name":"Model","category":"model","type":"select","currentValue":"` + model + `","options":` + codexModels + `}]`
}

// CodexEnvironment lists the variables codex scenarios record at startup.
var CodexEnvironment = []string{"INITIAL_AGENT_MODE", "CODEX_PATH", "COFFEE_SHOP_TOKEN", "COFFEE_SHOP_MCP_TOKEN"}

// CodexHandshake answers initialize like codex-acp and creates a session whose configuration
// options are sessionOptions (a JSON array, or "" to omit configOptions entirely).
func CodexHandshake(sessionOptions string) []Step {
	session := `{"sessionId":"{{session}}"}`
	if sessionOptions != "" {
		session = `{"sessionId":"{{session}}","configOptions":` + sessionOptions + `}`
	}
	return []Step{
		CaptureEnvironment(CodexEnvironment...),
		Expect("initialize"),
		Respond("initialize", `{"protocolVersion":1,"agentCapabilities":`+codexCapabilities+`,"authMethods":[{"id":"chatgpt","name":"Login with ChatGPT"}],"agentInfo":`+codexAgentInfo+`}`),
		Expect("session/new"),
		Respond("session/new", session),
	}
}

// CodexSetOption answers the next session/set_config_option with the given resulting options.
func CodexSetOption(resultingOptions string) []Step {
	return []Step{
		Expect("session/set_config_option"),
		Respond("session/set_config_option", `{"configOptions":`+resultingOptions+`}`),
	}
}

// codexConfigured performs the handshake, switches the mode to read-only, and connects to MCP.
func codexConfigured() []Step {
	return join(
		CodexHandshake(CodexConfigOptions("agent", CodexModel)),
		CodexSetOption(CodexConfigOptions("read-only", CodexModel)),
		[]Step{ConnectMCP()},
	)
}

func init() {
	codexScenarios := map[string][]Step{
		"codex-probe": {
			CaptureEnvironment(CodexEnvironment...),
			Expect("initialize"),
			Respond("initialize", `{"protocolVersion":1,"agentCapabilities":`+codexCapabilities+`,"authMethods":[],"agentInfo":`+codexAgentInfo+`}`),
			DrainUntilEOF(),
		},

		"codex-probe-models": {
			CaptureEnvironment(CodexEnvironment...),
			Expect("initialize"),
			Respond("initialize", `{"protocolVersion":1,"agentCapabilities":`+codexCapabilities+`,"authMethods":[],"agentInfo":`+codexAgentInfo+`}`),
			Expect("session/new"),
			Respond("session/new", `{"sessionId":"{{session}}","configOptions":`+CodexConfigOptions("agent", CodexModel)+`}`),
			Expect("session/close"),
			Respond("session/close", `{}`),
			DrainUntilEOF(),
		},

		"codex-probe-unsafe-models": {
			Expect("initialize"),
			Respond("initialize", `{"protocolVersion":1,"agentCapabilities":`+codexCapabilities+`,"authMethods":[],"agentInfo":`+codexAgentInfo+`}`),
			Expect("session/new"),
			Respond("session/new", `{"sessionId":"{{session}}","configOptions":[{"id":"model","type":"select","currentValue":"gpt-5.5","options":[{"value":"gpt-5.5"},{"value":"gpt-5.5"},{"value":"has space"},{"value":"sk-abcdefghijklmnop123456"},{"value":""},{"value":"`+repeat("m", 129)+`"},{"value":"o4-mini"}]}]}`),
			Expect("session/close"),
			Respond("session/close", `{}`),
			DrainUntilEOF(),
		},

		"codex-probe-authentication-required": {
			Expect("initialize"),
			Respond("initialize", `{"protocolVersion":1,"agentCapabilities":`+codexCapabilities+`,"authMethods":[{"id":"chatgpt","name":"Login with ChatGPT"}],"agentInfo":`+codexAgentInfo+`}`),
			Expect("session/new"),
			RespondError("session/new", -32000, "Authentication required"),
			DrainUntilEOF(),
		},

		"codex-success": join(codexConfigured(), []Step{
			Expect("session/prompt"),
			Update(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"codex done"}}`),
		}, Finish()),

		"codex-mode-already-set": join(CodexHandshake(CodexConfigOptions("read-only", CodexModel)), []Step{
			ConnectMCP(),
			Expect("session/prompt"),
			Update(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"codex done"}}`),
		}, Finish()),

		"codex-model": join(
			CodexHandshake(CodexConfigOptions("agent", CodexModel)),
			CodexSetOption(CodexConfigOptions("read-only", CodexModel)),
			CodexSetOption(CodexConfigOptions("read-only", CodexAlternateModel)),
			[]Step{
				ConnectMCP(),
				Expect("session/prompt"),
				Update(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"codex done"}}`),
			}, Finish()),

		"codex-no-config-options": join(CodexHandshake(""), []Step{DrainUntilEOF()}),

		"codex-mode-refused": join(CodexHandshake(CodexConfigOptions("agent", CodexModel)), []Step{
			Expect("session/set_config_option"),
			RespondError("session/set_config_option", -32602, "mode is locked"),
			DrainUntilEOF(),
		}),

		"codex-mode-ignored": join(
			CodexHandshake(CodexConfigOptions("agent", CodexModel)),
			CodexSetOption(CodexConfigOptions("agent", CodexModel)),
			[]Step{DrainUntilEOF()},
		),

		"codex-model-refused": join(
			CodexHandshake(CodexConfigOptions("agent", CodexModel)),
			CodexSetOption(CodexConfigOptions("read-only", CodexModel)),
			[]Step{
				Expect("session/set_config_option"),
				RespondError("session/set_config_option", -32602, "model unavailable"),
				DrainUntilEOF(),
			}),

		"codex-mcp-silent": join(
			CodexHandshake(CodexConfigOptions("agent", CodexModel)),
			CodexSetOption(CodexConfigOptions("read-only", CodexModel)),
			[]Step{DrainUntilEOF()},
		),

		"codex-authentication-required": {
			CaptureEnvironment(CodexEnvironment...),
			Expect("initialize"),
			Respond("initialize", `{"protocolVersion":1,"agentCapabilities":`+codexCapabilities+`,"authMethods":[{"id":"chatgpt","name":"Login with ChatGPT"}],"agentInfo":`+codexAgentInfo+`}`),
			Expect("session/new"),
			RespondError("session/new", -32000, "Authentication required"),
			DrainUntilEOF(),
		},

		"codex-no-http-mcp": {
			Expect("initialize"),
			Respond("initialize", `{"protocolVersion":1,"agentCapabilities":`+NoHTTPCapabilities+`,"agentInfo":`+codexAgentInfo+`}`),
			DrainUntilEOF(),
		},

		"codex-version-mismatch": {
			Expect("initialize"),
			Respond("initialize", `{"protocolVersion":1,"agentCapabilities":`+codexCapabilities+`,"agentInfo":{"name":"@agentclientprotocol/codex-acp","version":"0.9.0"}}`),
			DrainUntilEOF(),
		},

		"codex-protocol-mismatch": {
			Expect("initialize"),
			Respond("initialize", `{"protocolVersion":2,"agentCapabilities":`+codexCapabilities+`,"agentInfo":`+codexAgentInfo+`}`),
			DrainUntilEOF(),
		},

		"codex-exit-before-initialize": {Stderr("codex-acp: cannot start app server"), Exit(4)},

		"codex-crash-after-prompt": join(codexConfigured(), []Step{
			Expect("session/prompt"),
			Update(`{"sessionUpdate":"tool_call","toolCallId":"call-1","title":"Edit main.go","kind":"edit","status":"in_progress"}`),
			Stderr("codex-acp: app server exited"),
			Exit(5),
		}),

		"codex-malformed-after-prompt": join(codexConfigured(), []Step{
			Expect("session/prompt"),
			Update(`{"sessionUpdate":"tool_call","title":"missing identifier"}`),
			Hang(),
		}),

		"codex-permission": join(codexConfigured(), []Step{
			Expect("session/prompt"),
			Frame(`{"jsonrpc":"2.0","id":"permission-1","method":"session/request_permission","params":{"sessionId":"{{session}}","toolCall":{"toolCallId":"call-1","title":"Run go test with network","kind":"execute"},"options":[{"optionId":"approved","name":"Yes","kind":"allow_once"},{"optionId":"approved-always","name":"Yes, always","kind":"allow_always"},{"optionId":"abort","name":"No","kind":"reject_once"}]}}`),
			ExpectResponse(`"permission-1"`, "permission"),
			Update(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"after permission"}}`),
		}, Finish()),

		"codex-cancel": join(codexConfigured(), []Step{
			Expect("session/prompt"),
			Update(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"working"}}`),
			Expect("session/cancel"),
			Respond("session/prompt", `{"stopReason":"cancelled"}`),
			DrainUntilEOF(),
		}),

		"codex-secret-echo": join(codexConfigured(), []Step{
			Expect("session/prompt"),
			Update(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"token is {{token}}"}}`),
			Update(`{"sessionUpdate":"tool_call","toolCallId":"call-1","title":"curl -H 'Authorization: Bearer {{token}}'","kind":"fetch"}`),
		}, Finish()),
	}
	for name, steps := range codexScenarios {
		Scenarios[name] = steps
	}
}
