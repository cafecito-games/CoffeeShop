package acptest

// Frames shaped like the claude-agent-acp adapter's: its mode and model session configuration
// options and its agent identity. The fake reports ClaudeAdapterVersion, which tests pin as the
// manifest version.
const (
	ClaudeAdapterVersion = "0.79.0"
	// ClaudeModel and ClaudeAlternateModel are the models the fake offers; ClaudeAlternateModel is
	// not the current one, so selecting it requires session/set_config_option.
	ClaudeModel          = "claude-sonnet-4-6"
	ClaudeAlternateModel = "claude-opus-4-2"
	claudeAgentInfo      = `{"name":"@agentclientprotocol/claude-agent-acp","title":"Claude","version":"` + ClaudeAdapterVersion + `"}`
	claudeCapabilities   = `{"loadSession":true,"promptCapabilities":{"image":true,"embeddedContext":true},"mcpCapabilities":{"http":true,"sse":false},"sessionCapabilities":{"close":{},"resume":{}}}`
	// claudeModes uses claude-agent-acp's wire ids. "bypassPermissions" is absent because the real
	// adapter offers it only conditionally, so a bypass approval policy must fail closed against
	// it; claudeModesWithBypass is the offer from an adapter that permits bypass.
	claudeModes           = `[{"value":"default","name":"Manual"},{"value":"acceptEdits","name":"Accept edits"},{"value":"plan","name":"Plan"},{"value":"auto","name":"Auto"}]`
	claudeModesWithBypass = `[{"value":"default","name":"Manual"},{"value":"acceptEdits","name":"Accept edits"},{"value":"plan","name":"Plan"},{"value":"auto","name":"Auto"},{"value":"bypassPermissions","name":"Bypass permissions"}]`
	claudeModels          = `[{"group":"anthropic","name":"Anthropic","options":[{"value":"` + ClaudeModel + `","name":"Sonnet 4.6"},{"value":"` + ClaudeAlternateModel + `","name":"Opus 4.2"}]}]`
)

// ClaudeConfigOptions renders claude-agent-acp's configOptions array with the given current mode
// and model.
func ClaudeConfigOptions(mode, model string) string {
	return claudeConfigOptions(claudeModes, mode, model)
}

// ClaudeBypassConfigOptions is ClaudeConfigOptions from an adapter that also offers bypassPermissions.
func ClaudeBypassConfigOptions(mode, model string) string {
	return claudeConfigOptions(claudeModesWithBypass, mode, model)
}

func claudeConfigOptions(modes, mode, model string) string {
	return `[{"id":"mode","name":"Mode","category":"mode","type":"select","currentValue":"` + mode + `","options":` + modes + `},` +
		`{"id":"model","name":"Model","category":"model","type":"select","currentValue":"` + model + `","options":` + claudeModels + `}]`
}

// ClaudeEnvironment lists the variables claude scenarios record at startup. There is no mode
// environment variable: claude-agent-acp applies the mode only through session configuration.
var ClaudeEnvironment = []string{"CLAUDE_CODE_EXECUTABLE", "COFFEE_SHOP_TOKEN", "COFFEE_SHOP_MCP_TOKEN"}

// ClaudeHandshake answers initialize like claude-agent-acp and creates a session whose
// configuration options are sessionOptions (a JSON array, or "" to omit configOptions entirely).
// A locally authenticated Claude CLI subscription session offers no ACP auth methods.
func ClaudeHandshake(sessionOptions string) []Step {
	session := `{"sessionId":"{{session}}"}`
	if sessionOptions != "" {
		session = `{"sessionId":"{{session}}","configOptions":` + sessionOptions + `}`
	}
	return []Step{
		CaptureEnvironment(ClaudeEnvironment...),
		Expect("initialize"),
		Respond("initialize", `{"protocolVersion":1,"agentCapabilities":`+claudeCapabilities+`,"authMethods":[],"agentInfo":`+claudeAgentInfo+`}`),
		Expect("session/new"),
		Respond("session/new", session),
	}
}

// ClaudeSetOption answers the next session/set_config_option with the given resulting options.
func ClaudeSetOption(resultingOptions string) []Step {
	return []Step{
		Expect("session/set_config_option"),
		Respond("session/set_config_option", `{"configOptions":`+resultingOptions+`}`),
	}
}

// claudeConfigured performs the handshake from the unsafe acceptEdits mode, switches the mode to
// default, and connects to MCP.
func claudeConfigured() []Step {
	return join(
		ClaudeHandshake(ClaudeConfigOptions("acceptEdits", ClaudeModel)),
		ClaudeSetOption(ClaudeConfigOptions("default", ClaudeModel)),
		[]Step{ConnectMCP()},
	)
}

func init() {
	claudeScenarios := map[string][]Step{
		"claude-probe": {
			CaptureEnvironment(ClaudeEnvironment...),
			Expect("initialize"),
			Respond("initialize", `{"protocolVersion":1,"agentCapabilities":`+claudeCapabilities+`,"authMethods":[],"agentInfo":`+claudeAgentInfo+`}`),
			DrainUntilEOF(),
		},

		"claude-probe-models": {
			CaptureEnvironment(ClaudeEnvironment...),
			Expect("initialize"),
			Respond("initialize", `{"protocolVersion":1,"agentCapabilities":`+claudeCapabilities+`,"authMethods":[],"agentInfo":`+claudeAgentInfo+`}`),
			Expect("session/new"),
			Respond("session/new", `{"sessionId":"{{session}}","configOptions":`+ClaudeConfigOptions("acceptEdits", ClaudeModel)+`}`),
			Expect("session/close"),
			Respond("session/close", `{}`),
			DrainUntilEOF(),
		},

		"claude-probe-unsafe-models": {
			Expect("initialize"),
			Respond("initialize", `{"protocolVersion":1,"agentCapabilities":`+claudeCapabilities+`,"authMethods":[],"agentInfo":`+claudeAgentInfo+`}`),
			Expect("session/new"),
			Respond("session/new", `{"sessionId":"{{session}}","configOptions":[{"id":"model","type":"select","currentValue":"`+ClaudeModel+`","options":[{"value":"`+ClaudeModel+`"},{"value":"`+ClaudeModel+`"},{"value":"has space"},{"value":"sk-abcdefghijklmnop123456"},{"value":""},{"value":"`+repeat("m", 129)+`"},{"value":"claude-haiku-4-5"}]}]}`),
			Expect("session/close"),
			Respond("session/close", `{}`),
			DrainUntilEOF(),
		},

		"claude-probe-authentication-required": {
			Expect("initialize"),
			Respond("initialize", `{"protocolVersion":1,"agentCapabilities":`+claudeCapabilities+`,"authMethods":[],"agentInfo":`+claudeAgentInfo+`}`),
			Expect("session/new"),
			RespondError("session/new", -32000, "Authentication required"),
			DrainUntilEOF(),
		},

		"claude-success": join(claudeConfigured(), []Step{
			Expect("session/prompt"),
			Update(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"claude done"}}`),
		}, Finish()),

		"claude-auto": join(
			ClaudeHandshake(ClaudeConfigOptions("acceptEdits", ClaudeModel)),
			ClaudeSetOption(ClaudeConfigOptions("auto", ClaudeModel)),
			[]Step{
				ConnectMCP(),
				Expect("session/prompt"),
				Update(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"claude done"}}`),
			}, Finish()),

		"claude-bypass": join(
			ClaudeHandshake(ClaudeBypassConfigOptions("acceptEdits", ClaudeModel)),
			ClaudeSetOption(ClaudeBypassConfigOptions("bypassPermissions", ClaudeModel)),
			[]Step{
				ConnectMCP(),
				Expect("session/prompt"),
				Update(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"claude done"}}`),
			}, Finish()),

		"claude-no-bypass": join(ClaudeHandshake(ClaudeConfigOptions("acceptEdits", ClaudeModel)), []Step{DrainUntilEOF()}),

		"claude-mode-already-set": join(ClaudeHandshake(ClaudeConfigOptions("default", ClaudeModel)), []Step{
			ConnectMCP(),
			Expect("session/prompt"),
			Update(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"claude done"}}`),
		}, Finish()),

		"claude-model": join(
			ClaudeHandshake(ClaudeConfigOptions("acceptEdits", ClaudeModel)),
			ClaudeSetOption(ClaudeConfigOptions("default", ClaudeModel)),
			ClaudeSetOption(ClaudeConfigOptions("default", ClaudeAlternateModel)),
			[]Step{
				ConnectMCP(),
				Expect("session/prompt"),
				Update(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"claude done"}}`),
			}, Finish()),

		"claude-no-config-options": join(ClaudeHandshake(""), []Step{DrainUntilEOF()}),

		"claude-mode-refused": join(ClaudeHandshake(ClaudeConfigOptions("acceptEdits", ClaudeModel)), []Step{
			Expect("session/set_config_option"),
			RespondError("session/set_config_option", -32602, "mode is locked"),
			DrainUntilEOF(),
		}),

		"claude-mode-ignored": join(
			ClaudeHandshake(ClaudeConfigOptions("acceptEdits", ClaudeModel)),
			ClaudeSetOption(ClaudeConfigOptions("acceptEdits", ClaudeModel)),
			[]Step{DrainUntilEOF()},
		),

		"claude-model-refused": join(
			ClaudeHandshake(ClaudeConfigOptions("acceptEdits", ClaudeModel)),
			ClaudeSetOption(ClaudeConfigOptions("default", ClaudeModel)),
			[]Step{
				Expect("session/set_config_option"),
				RespondError("session/set_config_option", -32602, "model unavailable"),
				DrainUntilEOF(),
			}),

		"claude-mcp-silent": join(
			ClaudeHandshake(ClaudeConfigOptions("acceptEdits", ClaudeModel)),
			ClaudeSetOption(ClaudeConfigOptions("default", ClaudeModel)),
			[]Step{DrainUntilEOF()},
		),

		"claude-authentication-required": {
			CaptureEnvironment(ClaudeEnvironment...),
			Expect("initialize"),
			Respond("initialize", `{"protocolVersion":1,"agentCapabilities":`+claudeCapabilities+`,"authMethods":[],"agentInfo":`+claudeAgentInfo+`}`),
			Expect("session/new"),
			RespondError("session/new", -32000, "Authentication required"),
			DrainUntilEOF(),
		},

		"claude-no-http-mcp": {
			Expect("initialize"),
			Respond("initialize", `{"protocolVersion":1,"agentCapabilities":`+NoHTTPCapabilities+`,"agentInfo":`+claudeAgentInfo+`}`),
			DrainUntilEOF(),
		},

		"claude-version-mismatch": {
			Expect("initialize"),
			Respond("initialize", `{"protocolVersion":1,"agentCapabilities":`+claudeCapabilities+`,"agentInfo":{"name":"@agentclientprotocol/claude-agent-acp","version":"0.10.0"}}`),
			DrainUntilEOF(),
		},

		"claude-protocol-mismatch": {
			Expect("initialize"),
			Respond("initialize", `{"protocolVersion":2,"agentCapabilities":`+claudeCapabilities+`,"agentInfo":`+claudeAgentInfo+`}`),
			DrainUntilEOF(),
		},

		"claude-exit-before-initialize": {Stderr("claude-agent-acp: cannot start"), Exit(4)},

		"claude-crash-after-prompt": join(claudeConfigured(), []Step{
			Expect("session/prompt"),
			Update(`{"sessionUpdate":"tool_call","toolCallId":"call-1","title":"Edit main.go","kind":"edit","status":"in_progress"}`),
			Stderr("claude-agent-acp: process exited"),
			Exit(5),
		}),

		"claude-malformed-after-prompt": join(claudeConfigured(), []Step{
			Expect("session/prompt"),
			Update(`{"sessionUpdate":"tool_call","title":"missing identifier"}`),
			Hang(),
		}),

		"claude-permission": join(claudeConfigured(), []Step{
			Expect("session/prompt"),
			Frame(`{"jsonrpc":"2.0","id":"permission-1","method":"session/request_permission","params":{"sessionId":"{{session}}","toolCall":{"toolCallId":"call-1","title":"Run npm test","kind":"execute"},"options":[{"optionId":"approved","name":"Yes","kind":"allow_once"},{"optionId":"approved-always","name":"Yes, always","kind":"allow_always"},{"optionId":"abort","name":"No","kind":"reject_once"}]}}`),
			ExpectResponse(`"permission-1"`, "permission"),
			Update(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"after permission"}}`),
		}, Finish()),

		"claude-cancel": join(claudeConfigured(), []Step{
			Expect("session/prompt"),
			Update(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"working"}}`),
			Expect("session/cancel"),
			Respond("session/prompt", `{"stopReason":"cancelled"}`),
			DrainUntilEOF(),
		}),

		"claude-secret-echo": join(claudeConfigured(), []Step{
			Expect("session/prompt"),
			Update(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"token is {{token}}"}}`),
			Update(`{"sessionUpdate":"tool_call","toolCallId":"call-1","title":"curl -H 'Authorization: Bearer {{token}}'","kind":"fetch"}`),
		}, Finish()),
	}
	for name, steps := range claudeScenarios {
		Scenarios[name] = steps
	}
}
