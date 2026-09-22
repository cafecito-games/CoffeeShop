package acptest

// ResumedSessionID is the provider session every resume scenario continues. The resumed identity
// belongs to the provider, so the fake replays it literally instead of assigning {{session}}.
const ResumedSessionID = "provider-previous"

// Capability sets for session continuation: resume-capable advertises session/resume, load-only
// advertises only session/load, and DefaultCapabilities advertises neither.
const (
	ResumeCapabilities   = `{"loadSession":false,"promptCapabilities":{"image":false,"audio":false,"embeddedContext":false},"mcpCapabilities":{"http":true,"sse":false},"sessionCapabilities":{"close":{},"resume":{}}}`
	LoadOnlyCapabilities = `{"loadSession":true,"promptCapabilities":{"image":false,"audio":false,"embeddedContext":false},"mcpCapabilities":{"http":true,"sse":false},"sessionCapabilities":{"close":{}}}`
)

// resumeHandshake answers initialize with the given capabilities and stops before any session
// request, so the same scenarios also serve startup probes.
func resumeHandshake(capabilities string) []Step {
	return []Step{
		Expect("initialize"),
		Respond("initialize", `{"protocolVersion":1,"agentCapabilities":`+capabilities+`,"authMethods":[],"agentInfo":`+agentInfo+`}`),
	}
}

// resumedUpdate streams an agent_message_chunk for the resumed session, whose identity the provider
// already owns rather than the fake's placeholder.
func resumedUpdate(text string) Step {
	return Frame(`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"` + ResumedSessionID + `","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"` + text + `"}}}}`)
}

func init() {
	resumeScenarios := map[string][]Step{
		"resume-success": join(resumeHandshake(ResumeCapabilities), []Step{
			Expect("session/resume"),
			Respond("session/resume", `{}`),
			Expect("session/prompt"),
			resumedUpdate("resumed work"),
			Respond("session/prompt", `{"stopReason":"end_turn"}`),
			Expect("session/close"),
			Respond("session/close", `{}`),
			DrainUntilEOF(),
		}),

		"resume-refused": join(resumeHandshake(ResumeCapabilities), []Step{
			Expect("session/resume"),
			RespondError("session/resume", -32002, "Resource not found"),
			Expect("session/new"),
			Respond("session/new", `{"sessionId":"{{session}}"}`),
			Expect("session/prompt"),
		}, Finish()),

		"resume-auth-required": join(resumeHandshake(ResumeCapabilities), []Step{
			Expect("session/resume"),
			RespondError("session/resume", -32000, "Authentication required"),
			DrainUntilEOF(),
		}),

		"resume-adapter-exit": join(resumeHandshake(ResumeCapabilities), []Step{
			Expect("session/resume"),
			Exit(3),
		}),

		"load-success": join(resumeHandshake(LoadOnlyCapabilities), []Step{
			Expect("session/load"),
			resumedUpdate("old history"),
			resumedUpdate("old history again"),
			Frame(`{"jsonrpc":"2.0","id":"load-permission-1","method":"session/request_permission","params":{"sessionId":"` + ResumedSessionID + `","toolCall":{"toolCallId":"call-1","title":"Run tests","kind":"execute"},"options":[{"optionId":"allow","name":"Allow once","kind":"allow_once"},{"optionId":"reject","name":"Reject","kind":"reject_once"}]}}`),
			ExpectResponse(`"load-permission-1"`, "load-permission"),
			Respond("session/load", `{}`),
			Expect("session/prompt"),
			resumedUpdate("fresh"),
		}, Finish()),

		"resume-unsupported": join(Prompted(), Finish()),
	}
	for name, steps := range resumeScenarios {
		Scenarios[name] = steps
	}
}
