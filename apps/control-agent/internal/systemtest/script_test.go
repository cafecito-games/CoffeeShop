//go:build system && unix

package systemtest

import (
	"encoding/json"
	"testing"
)

// step mirrors fakeharness.Step; see apps/control-agent/internal/systemtest/fakeharness/script.go
// for the semantics of each field.
type step struct {
	When                *condition  `json:"when,omitempty"`
	Message             string      `json:"message,omitempty"`
	Thought             string      `json:"thought,omitempty"`
	Update              any         `json:"update,omitempty"`
	Call                string      `json:"call,omitempty"`
	Arguments           any         `json:"arguments,omitempty"`
	As                  string      `json:"as,omitempty"`
	AllowError          bool        `json:"allowError,omitempty"`
	ExpectErrorCode     string      `json:"expectErrorCode,omitempty"`
	MutateResultRemove  string      `json:"mutateResultRemove,omitempty"`
	WaitFor             any         `json:"waitFor,omitempty"`
	AcknowledgeDelivery bool        `json:"acknowledgeDelivery,omitempty"`
	Permission          *permission `json:"permission,omitempty"`
	Gate                string      `json:"gate,omitempty"`
	WriteFile           *writeFile  `json:"writeFile,omitempty"`
	RemoveFile          string      `json:"removeFile,omitempty"`
	Raw                 string      `json:"raw,omitempty"`
	Crash               int         `json:"crash,omitempty"`
	Hang                bool        `json:"hang,omitempty"`
}

type condition struct {
	Path   string `json:"path"`
	Equals any    `json:"equals"`
}

type permission struct {
	ToolCallID string             `json:"toolCallId"`
	Title      string             `json:"title"`
	Kind       string             `json:"kind"`
	Options    []permissionOption `json:"options"`
	As         string             `json:"as"`
}

type permissionOption struct {
	OptionID string `json:"optionId"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
}

type writeFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// script renders steps as the block the fake harness executes. Go's JSON encoder escapes "<" and
// ">", so a script nested inside another script's arguments is never mistaken for the outer one.
func script(t *testing.T, steps ...step) string {
	t.Helper()
	encoded, err := json.Marshal(map[string]any{"steps": steps})
	if err != nil {
		t.Fatal(err)
	}
	return "<fake-script>" + string(encoded) + "</fake-script>"
}

// allowOrReject are the options every scripted permission request offers.
var allowOrReject = []permissionOption{
	{OptionID: "allow", Name: "Allow once", Kind: "allow_once"},
	{OptionID: "reject", Name: "Reject", Kind: "reject_once"},
}

// taskSpecification is one entry of a submit_tasks call.
type taskSpecification struct {
	Key          string           `json:"key"`
	Title        string           `json:"title"`
	Instructions string           `json:"instructions"`
	Requirements map[string]any   `json:"requirements,omitempty"`
	Dependencies []map[string]any `json:"dependencies,omitempty"`
	Pin          map[string]any   `json:"pin,omitempty"`
}

// buildRequirements asks for a writable, leased checkout of the project over ACP. These workflow
// fixtures predate capability-pack skills; their old configured-agent "build" label was descriptive
// metadata, not runtime pack authority.
func buildRequirements(projectID string, harnessIDs ...string) map[string]any {
	requirements := map[string]any{
		"projectProfileId": projectID,
		"transports":       []string{"acp-v1"},
		"workspace":        map[string]any{"writable": true},
	}
	if len(harnessIDs) > 0 {
		requirements["harnessIds"] = harnessIDs
	}
	return requirements
}

func dependsOn(keys ...string) []map[string]any {
	result := make([]map[string]any, 0, len(keys))
	for _, key := range keys {
		result = append(result, map[string]any{"key": key})
	}
	return result
}

// submitTasks is the submit_tasks call step.
func submitTasks(idempotencyKey, as string, tasks ...taskSpecification) step {
	return step{Call: "submit_tasks", Arguments: map[string]any{"idempotencyKey": idempotencyKey, "tasks": tasks}, As: as}
}

// acknowledgeWake is the default script of an orchestrator agent: on every continuation it
// acknowledges exactly the delivered range, as the hub's continuation prompt instructs.
func acknowledgeWake(t *testing.T) string {
	return script(t, step{AcknowledgeDelivery: true}, step{Message: "acknowledged the delivered inbox range"})
}
