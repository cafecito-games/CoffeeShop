// Package acptest provides a deterministic fake ACP agent. Test binaries re-execute themselves
// with ScenarioEnvironment set; TestMain calls RunIfRequested, which replays the named scenario
// over real stdio and exits. Frames are written byte-for-byte as scripted.
package acptest

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

const (
	// ScenarioEnvironment names the scenario the fake agent replays.
	ScenarioEnvironment = "COFFEE_SHOP_FAKE_ACP_SCENARIO"
	// RecordEnvironment names a file that receives every frame the fake agent reads, one per line.
	RecordEnvironment = "COFFEE_SHOP_FAKE_ACP_RECORD"
	// SessionID is the session identifier every scenario assigns.
	SessionID = "fake-session-1"
)

// RunIfRequested replays the requested scenario and exits the process. It returns immediately when
// the process is not a fake agent invocation.
func RunIfRequested() {
	name := os.Getenv(ScenarioEnvironment)
	if name == "" {
		return
	}
	steps, known := Scenarios[name]
	if !known {
		fmt.Fprintf(os.Stderr, "unknown fake ACP scenario %q\n", name)
		os.Exit(90)
	}
	agent := newAgent()
	for index, step := range steps {
		if err := step(agent); err != nil {
			fmt.Fprintf(os.Stderr, "fake ACP scenario %s step %d: %v\n", name, index, err)
			os.Exit(91)
		}
	}
	os.Exit(0)
}

// Step is one scripted action of the fake agent.
type Step func(*Agent) error

// Agent is the fake agent's replay state.
type Agent struct {
	input     *bufio.Reader
	output    io.Writer
	record    *os.File
	requestID map[string]json.RawMessage
	params    map[string]json.RawMessage
	responses map[string]json.RawMessage
	token     string
	mcpURL    string
}

func newAgent() *Agent {
	agent := &Agent{
		input:     bufio.NewReaderSize(os.Stdin, 1024*1024),
		output:    os.Stdout,
		requestID: map[string]json.RawMessage{},
		params:    map[string]json.RawMessage{},
		responses: map[string]json.RawMessage{},
	}
	if path := os.Getenv(RecordEnvironment); path != "" {
		record, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err == nil {
			agent.record = record
		}
	}
	return agent
}

type frame struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
}

func (agent *Agent) read() (frame, error) {
	line, err := agent.input.ReadBytes('\n')
	if err != nil {
		return frame{}, fmt.Errorf("read frame: %w", err)
	}
	if agent.record != nil {
		_, _ = agent.record.Write(line)
	}
	var message frame
	if err := json.Unmarshal(line, &message); err != nil {
		return frame{}, fmt.Errorf("decode frame %q: %w", line, err)
	}
	return message, nil
}

func (agent *Agent) expand(text string) string {
	replacements := []string{"{{session}}", SessionID, "{{token}}", agent.token}
	for method, id := range agent.requestID {
		replacements = append(replacements, "{{id:"+method+"}}", string(id))
	}
	return strings.NewReplacer(replacements...).Replace(text)
}

func (agent *Agent) captureToken(params json.RawMessage) {
	var request struct {
		McpServers []struct {
			URL     string `json:"url"`
			Headers []struct {
				Name  string `json:"name"`
				Value string `json:"value"`
			} `json:"headers"`
		} `json:"mcpServers"`
	}
	if json.Unmarshal(params, &request) != nil {
		return
	}
	for _, server := range request.McpServers {
		agent.mcpURL = server.URL
		for _, header := range server.Headers {
			if header.Name == "Authorization" {
				agent.token = strings.TrimPrefix(header.Value, "Bearer ")
			}
		}
	}
}

// Expect reads the next frame and requires it to be a request or notification for method.
func Expect(method string) Step {
	return func(agent *Agent) error {
		message, err := agent.read()
		if err != nil {
			return err
		}
		if message.Method != method {
			return fmt.Errorf("expected %s, received method %q", method, message.Method)
		}
		agent.requestID[method] = message.ID
		agent.params[method] = message.Params
		if method == "session/new" {
			agent.captureToken(message.Params)
		}
		return nil
	}
}

// Respond answers the most recent request for method with a raw JSON result.
func Respond(method, result string) Step {
	return func(agent *Agent) error {
		id, known := agent.requestID[method]
		if !known || id == nil {
			return fmt.Errorf("no request for %s to answer", method)
		}
		return agent.write(fmt.Sprintf(`{"jsonrpc":"2.0","id":%s,"result":%s}`, id, agent.expand(result)) + "\n")
	}
}

// RespondError answers the most recent request for method with a JSON-RPC error.
func RespondError(method string, code int, message string) Step {
	return func(agent *Agent) error {
		id := agent.requestID[method]
		encoded, _ := json.Marshal(message)
		return agent.write(fmt.Sprintf(`{"jsonrpc":"2.0","id":%s,"error":{"code":%d,"message":%s}}`, id, code, agent.expand(string(encoded))) + "\n")
	}
}

// Raw writes text to stdout exactly as given after placeholder expansion.
func Raw(text string) Step {
	return func(agent *Agent) error { return agent.write(agent.expand(text)) }
}

// Frame writes one JSON line followed by a newline.
func Frame(text string) Step {
	return Raw(text + "\n")
}

// Update writes a session/update notification carrying the raw update object.
func Update(update string) Step {
	return Frame(`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"{{session}}","update":` + update + `}}`)
}

// Split writes text in pieces with a pause between them, exercising partial reads.
func Split(text string, pieces int, pause time.Duration) Step {
	return func(agent *Agent) error {
		expanded := agent.expand(text)
		size := max(1, len(expanded)/pieces)
		for start := 0; start < len(expanded); start += size {
			end := min(len(expanded), start+size)
			if err := agent.write(expanded[start:end]); err != nil {
				return err
			}
			time.Sleep(pause)
		}
		return nil
	}
}

// Stderr writes a diagnostic line to stderr after placeholder expansion.
func Stderr(text string) Step {
	return func(agent *Agent) error {
		_, err := fmt.Fprintln(os.Stderr, agent.expand(text))
		return err
	}
}

// ExpectResponse reads the next frame and requires it to be a response to the given request id,
// recording its result under key.
func ExpectResponse(id string, key string) Step {
	return func(agent *Agent) error {
		message, err := agent.read()
		if err != nil {
			return err
		}
		if strings.TrimSpace(string(message.ID)) != id || message.Method != "" {
			return fmt.Errorf("expected response to %s, received %s %s", id, message.ID, message.Method)
		}
		if message.Result != nil {
			agent.responses[key] = message.Result
		} else {
			agent.responses[key] = message.Error
		}
		return nil
	}
}

// ExpectResponses reads one response per entry of keys, which maps request ids to recording keys,
// accepting them in any order because concurrently serviced requests may complete in any order.
func ExpectResponses(keys map[string]string) Step {
	return func(agent *Agent) error {
		remaining := make(map[string]string, len(keys))
		for id, key := range keys {
			remaining[id] = key
		}
		for len(remaining) > 0 {
			message, err := agent.read()
			if err != nil {
				return err
			}
			id := strings.TrimSpace(string(message.ID))
			key, expected := remaining[id]
			if !expected || message.Method != "" {
				return fmt.Errorf("expected a response to one of %v, received %s %s", keys, message.ID, message.Method)
			}
			delete(remaining, id)
			if message.Result != nil {
				agent.responses[key] = message.Result
			} else {
				agent.responses[key] = message.Error
			}
		}
		return nil
	}
}

// Sleep pauses the scenario.
func Sleep(duration time.Duration) Step {
	return func(*Agent) error {
		time.Sleep(duration)
		return nil
	}
}

// Exit terminates the fake agent immediately with code.
func Exit(code int) Step {
	return func(*Agent) error {
		os.Exit(code)
		return nil
	}
}

// DrainUntilEOF reads frames until stdin closes, then exits cleanly.
func DrainUntilEOF() Step {
	return func(agent *Agent) error {
		for {
			if _, err := agent.read(); err != nil {
				os.Exit(0)
			}
		}
	}
}

// IgnoreTermination ignores catchable termination signals and starts a descendant that shares the
// agent's stdout, so it outlives the agent unless the whole process tree is killed. The descendant
// PID is appended to the record file as {"descendantPid":N}.
func IgnoreTermination() Step {
	return func(agent *Agent) error {
		signal.Ignore(syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
		descendant := exec.Command(os.Args[0])
		descendant.Env = append(os.Environ(), ScenarioEnvironment+"=hang")
		descendant.Stdout = os.Stdout
		if err := descendant.Start(); err != nil {
			return err
		}
		if agent.record != nil {
			_, _ = fmt.Fprintf(agent.record, "{\"descendantPid\":%d}\n", descendant.Process.Pid)
		}
		return nil
	}
}

// Hang blocks forever without reading stdin.
func Hang() Step {
	return func(*Agent) error {
		for {
			time.Sleep(time.Hour)
		}
	}
}

func (agent *Agent) write(text string) error {
	_, err := io.WriteString(agent.output, text)
	return err
}

// ConnectMCP connects to the MCP server offered in session/new as an HTTP MCP client would: it
// sends initialize and then tools/list with the offered bearer header, and fails unless both are
// answered with HTTP 200.
func ConnectMCP() Step {
	return func(agent *Agent) error {
		if agent.mcpURL == "" {
			return fmt.Errorf("session/new offered no MCP server")
		}
		for index, method := range []string{"initialize", "tools/list"} {
			body := fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":%q,"params":{}}`, index+1, method)
			request, err := http.NewRequest(http.MethodPost, agent.mcpURL, strings.NewReader(body))
			if err != nil {
				return err
			}
			request.Header.Set("Authorization", "Bearer "+agent.token)
			request.Header.Set("Content-Type", "application/json")
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				return fmt.Errorf("MCP %s: %w", method, err)
			}
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			if response.StatusCode != http.StatusOK {
				return fmt.Errorf("MCP %s returned HTTP %d", method, response.StatusCode)
			}
		}
		return nil
	}
}

// CaptureEnvironment appends {"environment":{NAME:value}} to the record file for each named
// variable, with "<unset>" for a variable the fake agent did not inherit.
func CaptureEnvironment(names ...string) Step {
	return func(agent *Agent) error {
		if agent.record == nil {
			return nil
		}
		values := map[string]string{}
		for _, name := range names {
			value, set := os.LookupEnv(name)
			if !set {
				value = UnsetEnvironmentValue
			}
			values[name] = value
		}
		encoded, err := json.Marshal(map[string]any{"environment": values})
		if err != nil {
			return err
		}
		_, err = agent.record.Write(append(encoded, '\n'))
		return err
	}
}

// UnsetEnvironmentValue is what CaptureEnvironment records for a variable that was not set.
const UnsetEnvironmentValue = "<unset>"
