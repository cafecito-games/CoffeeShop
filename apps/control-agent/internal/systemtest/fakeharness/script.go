package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Script is what the fake does with one prompt: its steps run in order. Every string inside a
// step may reference earlier results as {{path}}; a string that is exactly one reference is
// replaced by the referenced JSON value, otherwise the value is interpolated as text.
type Script struct {
	Steps []Step `json:"steps"`
}

// Step is one scripted action; exactly one action field is set.
type Step struct {
	// When skips the step unless the condition holds.
	When *Condition `json:"when,omitempty"`

	// Message streams agent text; it becomes the run's output.
	Message string `json:"message,omitempty"`
	// Thought streams agent reasoning (ACP only).
	Thought string `json:"thought,omitempty"`
	// Update writes one raw ACP session/update payload (ACP only; the native CLIs ignore it).
	Update json.RawMessage `json:"update,omitempty"`
	// Call invokes a Coffee Shop MCP tool with Arguments and stores the result under As. A tool
	// error fails the script unless AllowError is set. ExpectErrorCode is the strict alternative:
	// it requires an error with that closed Coffee Shop code before storing the result.
	Call            string          `json:"call,omitempty"`
	Arguments       json.RawMessage `json:"arguments,omitempty"`
	As              string          `json:"as,omitempty"`
	AllowError      bool            `json:"allowError,omitempty"`
	ExpectErrorCode string          `json:"expectErrorCode,omitempty"`
	// MutateResultRemove removes one dotted path from a successful producer result before it is
	// exposed to subsequent steps. This is test-only fault injection at the serialized boundary.
	MutateResultRemove string `json:"mutateResultRemove,omitempty"`
	// WaitFor long-polls wait_for_task_events, advancing the run's own cursor, until an event
	// containing every field of the given object arrives; the event is stored under As.
	WaitFor json.RawMessage `json:"waitFor,omitempty"`
	// AcknowledgeDelivery calls wait_for_task_events with the exact acknowledgement arguments the
	// hub's continuation prompt asks for, as a model reading that prompt would.
	AcknowledgeDelivery bool `json:"acknowledgeDelivery,omitempty"`
	// Permission raises an ACP permission request and stores the client's response under As.
	Permission *Permission `json:"permission,omitempty"`
	// Gate blocks until the test creates the named file in the gate directory.
	Gate string `json:"gate,omitempty"`
	// WriteFile and RemoveFile change the run's working directory.
	WriteFile  *WriteFile `json:"writeFile,omitempty"`
	RemoveFile string     `json:"removeFile,omitempty"`
	// Raw writes text to the ACP stream verbatim, for malformed-frame scenarios.
	Raw string `json:"raw,omitempty"`
	// Crash exits the process immediately with this code.
	Crash int `json:"crash,omitempty"`
	// Hang blocks until the run is cancelled.
	Hang bool `json:"hang,omitempty"`
}

// Condition holds when the value at Path equals Equals. A "*" segment requires every element of a
// non-empty array to satisfy the rest of the path.
type Condition struct {
	Path   string `json:"path"`
	Equals any    `json:"equals"`
}

// Permission is an ACP session/request_permission payload.
type Permission struct {
	ToolCallID string             `json:"toolCallId"`
	Title      string             `json:"title"`
	Kind       string             `json:"kind"`
	Options    []PermissionOption `json:"options"`
	As         string             `json:"as"`
}

// PermissionOption is one offered permission option.
type PermissionOption struct {
	OptionID string `json:"optionId"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
}

// WriteFile writes Content to Path, relative to the run's working directory.
type WriteFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

var (
	errCancelled = errors.New("the run was cancelled")
	scriptBlock  = regexp.MustCompile(`(?s)<fake-script>(.*?)</fake-script>`)
	reference    = regexp.MustCompile(`\{\{([A-Za-z0-9_.*-]+)\}\}`)
)

// crash is returned by a Crash step; the process exits with its code.
type crash struct{ code int }

func (err crash) Error() string { return "scripted crash with exit code " + strconv.Itoa(err.code) }

// extractScript decodes the last script block in text; a prompt without one runs no steps.
func extractScript(text string) (Script, error) {
	blocks := scriptBlock.FindAllStringSubmatch(text, -1)
	if len(blocks) == 0 {
		return Script{Steps: []Step{{Message: "no script was provided"}}}, nil
	}
	var script Script
	if err := json.Unmarshal([]byte(blocks[len(blocks)-1][1]), &script); err != nil {
		return Script{}, fmt.Errorf("decode script: %w", err)
	}
	return script, nil
}

// host is the transport a script's side effects travel over.
type host interface {
	message(text string) error
	thought(text string) error
	update(raw json.RawMessage) error
	permission(ctx context.Context, request map[string]any) (any, error)
	raw(text string) error
	cancelled() <-chan struct{}
}

type engine struct {
	host        host
	mcp         *mcpClient
	prompt      string
	cwd         string
	variables   map[string]any
	unconsumed  []any
	permissions int
}

func newEngine(host host, mcp *mcpClient, prompt, cwd, session string) *engine {
	return &engine{host: host, mcp: mcp, prompt: prompt, cwd: cwd, variables: map[string]any{"cwd": cwd, "session": session}}
}

func (engine *engine) run(ctx context.Context, script Script) error {
	for index, step := range script.Steps {
		select {
		case <-engine.host.cancelled():
			return errCancelled
		default:
		}
		if step.When != nil {
			holds, err := engine.holds(*step.When)
			if err != nil {
				return fmt.Errorf("step %d condition: %w", index, err)
			}
			if !holds {
				continue
			}
		}
		if err := engine.execute(ctx, step); err != nil {
			if errors.Is(err, errCancelled) {
				return err
			}
			var crashed crash
			if errors.As(err, &crashed) {
				return err
			}
			return fmt.Errorf("step %d: %w", index, err)
		}
	}
	return nil
}

func (engine *engine) execute(ctx context.Context, step Step) error {
	switch {
	case step.Message != "":
		text, err := engine.text(step.Message)
		if err != nil {
			return err
		}
		if activeRecorder != nil {
			activeRecorder.write(map[string]any{"event": "evaluation-message", "message": text})
		}
		return engine.host.message(text)
	case step.Thought != "":
		text, err := engine.text(step.Thought)
		if err != nil {
			return err
		}
		return engine.host.thought(text)
	case len(step.Update) > 0:
		rendered, err := engine.renderJSON(step.Update)
		if err != nil {
			return err
		}
		return engine.host.update(rendered)
	case step.Call != "":
		return engine.call(ctx, step)
	case len(step.WaitFor) > 0:
		return engine.waitFor(ctx, step)
	case step.AcknowledgeDelivery:
		return engine.acknowledgeDelivery(ctx, step.As)
	case step.Permission != nil:
		return engine.permission(ctx, *step.Permission)
	case step.Gate != "":
		return engine.gate(step.Gate)
	case step.WriteFile != nil:
		relative, err := engine.text(step.WriteFile.Path)
		if err != nil {
			return err
		}
		path, err := engine.localPath(relative)
		if err != nil {
			return err
		}
		content, err := engine.text(step.WriteFile.Content)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		return os.WriteFile(path, []byte(content), 0o644)
	case step.RemoveFile != "":
		path, err := engine.localPath(step.RemoveFile)
		if err != nil {
			return err
		}
		return os.Remove(path)
	case step.Raw != "":
		return engine.host.raw(step.Raw)
	case step.Crash != 0:
		fmt.Fprintln(os.Stderr, "fakeharness: scripted adapter crash")
		return crash{code: step.Crash}
	case step.Hang:
		<-engine.host.cancelled()
		return errCancelled
	default:
		return errors.New("step names no action")
	}
}

func (engine *engine) call(ctx context.Context, step Step) error {
	if engine.mcp == nil {
		return errNoMCP
	}
	arguments := any(map[string]any{})
	if len(step.Arguments) > 0 {
		var decoded any
		if err := json.Unmarshal(step.Arguments, &decoded); err != nil {
			return fmt.Errorf("decode %s arguments: %w", step.Call, err)
		}
		rendered, err := engine.render(decoded)
		if err != nil {
			return err
		}
		arguments = rendered
	}
	result, err := engine.mcp.tool(ctx, step.Call, arguments)
	if err != nil {
		return err
	}
	if step.ExpectErrorCode != "" {
		code := toolErrorCode(result.Value)
		if !result.IsError || code != step.ExpectErrorCode {
			return fmt.Errorf("tool %s error code=%q, want %q", step.Call, code, step.ExpectErrorCode)
		}
	} else if result.IsError && !step.AllowError {
		encoded, _ := json.Marshal(result.Value)
		return fmt.Errorf("tool %s failed: %s", step.Call, encoded)
	}
	if step.MutateResultRemove != "" {
		if result.IsError {
			return fmt.Errorf("tool %s cannot mutate an error result", step.Call)
		}
		mutated, removed := removeResultPath(result.Value, step.MutateResultRemove)
		if !removed {
			return fmt.Errorf("tool %s result has no %s field to mutate", step.Call, step.MutateResultRemove)
		}
		result.Value = mutated
	}
	if step.As != "" {
		engine.variables[step.As] = result.Value
	}
	return nil
}

func toolErrorCode(value any) string {
	object, _ := value.(map[string]any)
	failure, _ := object["error"].(map[string]any)
	code, _ := failure["code"].(string)
	return code
}

func removeResultPath(value any, path string) (any, bool) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, false
	}
	var copy any
	if json.Unmarshal(encoded, &copy) != nil {
		return nil, false
	}
	segments := strings.Split(path, ".")
	current, _ := copy.(map[string]any)
	for _, segment := range segments[:len(segments)-1] {
		current, _ = current[segment].(map[string]any)
		if current == nil {
			return nil, false
		}
	}
	last := segments[len(segments)-1]
	if _, present := current[last]; !present {
		return nil, false
	}
	delete(current, last)
	return copy, true
}

// waitDeadline bounds one WaitFor step; the test's own deadlines are shorter, so a missing event
// fails the scenario there first.
const waitDeadline = 3 * time.Minute

func (engine *engine) waitFor(ctx context.Context, step Step) error {
	var decoded any
	if err := json.Unmarshal(step.WaitFor, &decoded); err != nil {
		return fmt.Errorf("decode waitFor: %w", err)
	}
	pattern, err := engine.render(decoded)
	if err != nil {
		return err
	}
	deadline := time.Now().Add(waitDeadline)
	for {
		for index, event := range engine.unconsumed {
			if contains(event, pattern) {
				engine.unconsumed = append(engine.unconsumed[:index:index], engine.unconsumed[index+1:]...)
				if step.As != "" {
					engine.variables[step.As] = event
				}
				return nil
			}
		}
		engine.unconsumed = nil
		if time.Now().After(deadline) {
			return errors.New("waitFor deadline passed without a matching event")
		}
		arguments := map[string]any{"timeoutMilliseconds": 2000, "maximumEvents": 50}
		if cursor, known := engine.variables["_cursor"].(string); known {
			arguments["cursor"] = cursor
		}
		result, err := engine.mcp.tool(ctx, "wait_for_task_events", arguments)
		if err != nil {
			return err
		}
		if result.IsError {
			encoded, _ := json.Marshal(result.Value)
			return fmt.Errorf("wait_for_task_events failed: %s", encoded)
		}
		page, _ := result.Value.(map[string]any)
		if cursor, known := page["cursor"].(string); known {
			engine.variables["_cursor"] = cursor
		}
		events, _ := page["events"].([]any)
		engine.unconsumed = events
		select {
		case <-engine.host.cancelled():
			return errCancelled
		default:
		}
	}
}

const acknowledgementInstruction = "acknowledge them by calling wait_for_task_events with "

func (engine *engine) acknowledgeDelivery(ctx context.Context, as string) error {
	start := strings.LastIndex(engine.prompt, acknowledgementInstruction)
	if start < 0 {
		return errors.New("the prompt carries no acknowledgement instruction")
	}
	line, _, _ := strings.Cut(engine.prompt[start+len(acknowledgementInstruction):], "\n")
	var arguments map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSuffix(strings.TrimSpace(line), ".")), &arguments); err != nil {
		return fmt.Errorf("decode acknowledgement arguments: %w", err)
	}
	result, err := engine.mcp.tool(ctx, "wait_for_task_events", arguments)
	if err != nil {
		return err
	}
	if result.IsError {
		encoded, _ := json.Marshal(result.Value)
		return fmt.Errorf("acknowledgement failed: %s", encoded)
	}
	if page, _ := result.Value.(map[string]any); page != nil {
		if cursor, known := page["cursor"].(string); known {
			engine.variables["_cursor"] = cursor
		}
	}
	if as != "" {
		engine.variables[as] = result.Value
	}
	return nil
}

func (engine *engine) permission(ctx context.Context, request Permission) error {
	engine.permissions++
	options := make([]any, 0, len(request.Options))
	for _, option := range request.Options {
		options = append(options, map[string]any{"optionId": option.OptionID, "name": option.Name, "kind": option.Kind})
	}
	payload := map[string]any{"toolCall": map[string]any{"toolCallId": request.ToolCallID, "title": request.Title, "kind": request.Kind}, "options": options}
	response, err := engine.host.permission(ctx, payload)
	if err != nil {
		return err
	}
	if request.As != "" {
		engine.variables[request.As] = response
	}
	return nil
}

// gateDeadline bounds how long a script waits for its test to open a gate.
const gateDeadline = 3 * time.Minute

func (engine *engine) gate(name string) error {
	directory := os.Getenv(gateDirectoryVariable)
	if directory == "" || name != filepath.Base(name) {
		return errors.New("gates need a gate directory and a plain gate name")
	}
	path := filepath.Join(directory, name)
	deadline := time.Now().Add(gateDeadline)
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		if _, err := os.Stat(path); err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("gate %s was never opened", name)
		}
		select {
		case <-engine.host.cancelled():
			return errCancelled
		case <-ticker.C:
		}
	}
}

func (engine *engine) localPath(relative string) (string, error) {
	if relative == "" || filepath.IsAbs(relative) || filepath.Clean(relative) != relative || strings.HasPrefix(relative, "..") {
		return "", errors.New("file steps take a clean path relative to the working directory")
	}
	return filepath.Join(engine.cwd, relative), nil
}

func (engine *engine) text(value string) (string, error) {
	rendered, err := engine.render(value)
	if err != nil {
		return "", err
	}
	if text, isText := rendered.(string); isText {
		return text, nil
	}
	encoded, err := json.Marshal(rendered)
	return string(encoded), err
}

func (engine *engine) renderJSON(raw json.RawMessage) (json.RawMessage, error) {
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, err
	}
	rendered, err := engine.render(decoded)
	if err != nil {
		return nil, err
	}
	return json.Marshal(rendered)
}

func (engine *engine) render(value any) (any, error) {
	switch typed := value.(type) {
	case string:
		// A nested script, such as a task's instructions, carries references for the process that
		// will run it, so it is passed on verbatim.
		if strings.Contains(typed, "<fake-script>") {
			return typed, nil
		}
		if match := reference.FindStringSubmatch(typed); match != nil && match[0] == typed {
			return engine.lookup(match[1])
		}
		var failure error
		replaced := reference.ReplaceAllStringFunc(typed, func(token string) string {
			resolved, err := engine.lookup(strings.Trim(token, "{}"))
			if err != nil {
				failure = err
				return ""
			}
			if text, isText := resolved.(string); isText {
				return text
			}
			encoded, _ := json.Marshal(resolved)
			return string(encoded)
		})
		return replaced, failure
	case []any:
		result := make([]any, len(typed))
		for index, item := range typed {
			rendered, err := engine.render(item)
			if err != nil {
				return nil, err
			}
			result[index] = rendered
		}
		return result, nil
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, item := range typed {
			rendered, err := engine.render(item)
			if err != nil {
				return nil, err
			}
			result[key] = rendered
		}
		return result, nil
	default:
		return value, nil
	}
}

func (engine *engine) lookup(path string) (any, error) {
	values, err := resolve(engine.variables, strings.Split(path, "."))
	if err != nil {
		return nil, fmt.Errorf("reference %s: %w", path, err)
	}
	if len(values) != 1 {
		return nil, fmt.Errorf("reference %s must name exactly one value", path)
	}
	return values[0], nil
}

func (engine *engine) holds(condition Condition) (bool, error) {
	expected, err := engine.render(condition.Equals)
	if err != nil {
		return false, err
	}
	values, err := resolve(engine.variables, strings.Split(condition.Path, "."))
	if err != nil {
		return false, nil
	}
	if len(values) == 0 {
		return false, nil
	}
	for _, value := range values {
		if !equalJSON(value, expected) {
			return false, nil
		}
	}
	return true, nil
}

// resolve follows segments through decoded JSON; "*" fans out over every element of an array.
func resolve(value any, segments []string) ([]any, error) {
	if len(segments) == 0 {
		return []any{value}, nil
	}
	segment, rest := segments[0], segments[1:]
	switch typed := value.(type) {
	case map[string]any:
		child, known := typed[segment]
		if !known {
			return nil, fmt.Errorf("no field %s", segment)
		}
		return resolve(child, rest)
	case []any:
		if segment == "*" {
			results := []any{}
			for _, item := range typed {
				resolved, err := resolve(item, rest)
				if err != nil {
					return nil, err
				}
				results = append(results, resolved...)
			}
			return results, nil
		}
		index, err := strconv.Atoi(segment)
		if err != nil || index < 0 || index >= len(typed) {
			return nil, fmt.Errorf("no element %s", segment)
		}
		return resolve(typed[index], rest)
	default:
		return nil, fmt.Errorf("cannot descend into %s", segment)
	}
}

// contains reports whether actual has every field of pattern with an equal value.
func contains(actual, pattern any) bool {
	expected, isObject := pattern.(map[string]any)
	if !isObject {
		return equalJSON(actual, pattern)
	}
	object, isObject := actual.(map[string]any)
	if !isObject {
		return false
	}
	for key, value := range expected {
		if !contains(object[key], value) {
			return false
		}
	}
	return true
}

func equalJSON(left, right any) bool {
	leftEncoded, leftErr := json.Marshal(left)
	rightEncoded, rightErr := json.Marshal(right)
	if leftErr != nil || rightErr != nil {
		return reflect.DeepEqual(left, right)
	}
	return string(leftEncoded) == string(rightEncoded)
}
