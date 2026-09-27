package protocol

import "slices"

// HubToolNames mirrors hubToolNames in the protocol source of truth: the run-scoped tools Barista's
// MCP bridge lists and forwards to the hub. The shared fixture
// packages/protocol/test/fixtures/hub-tools/vocabulary.json is checked against both languages.
var HubToolNames = []string{
	"get_task_context",
	"delegate_task",
	"post_artifact",
	"publish_preview",
	"update_thread",
	"get_execution_inventory",
	"submit_tasks",
	"send_task_message",
	"wait_for_task_events",
	"update_task",
}

// DelegationHubToolNames are listed and served only to agents allowed to delegate.
var DelegationHubToolNames = []string{"delegate_task", "get_execution_inventory", "submit_tasks"}

// TaskMessageKinds mirrors taskMessageKinds.
var TaskMessageKinds = []string{"question", "answer", "instruction", "progress", "result", "note"}

// Bounds mirrored from orchestrationToolLimits. MaximumWaitMilliseconds must stay below the hub
// RPC timeout so a long-poll wait always answers before Barista gives up on it.
const (
	MaximumWaitMilliseconds = 20_000
	MaximumEventsPerWait    = 50
)

func IsHubToolName(name string) bool { return slices.Contains(HubToolNames, name) }

func IsDelegationHubToolName(name string) bool { return slices.Contains(DelegationHubToolNames, name) }
