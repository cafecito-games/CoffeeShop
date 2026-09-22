package acptest

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// Process is a running fake agent started from the current test binary.
type Process struct {
	Command    *exec.Cmd
	Stdin      io.WriteCloser
	Stdout     io.ReadCloser
	RecordPath string
	stderr     *lockedBuffer
}

// Environment returns the variables that make the current test binary replay scenario, recording
// received frames at recordPath.
func Environment(scenario, recordPath string) []string {
	return []string{ScenarioEnvironment + "=" + scenario, RecordEnvironment + "=" + recordPath, "GORACE=atexit_sleep_ms=0"}
}

// Start launches the fake agent for scenario and kills it when the test ends.
func Start(t testing.TB, scenario string) *Process {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatalf("locate test binary: %v", err)
	}
	record := filepath.Join(t.TempDir(), "frames.jsonl")
	command := exec.Command(executable)
	command.Env = append(os.Environ(), Environment(scenario, record)...)
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	stderr := &lockedBuffer{}
	command.Stderr = stderr
	if err := command.Start(); err != nil {
		t.Fatalf("start fake agent: %v", err)
	}
	process := &Process{Command: command, Stdin: stdin, Stdout: stdout, RecordPath: record, stderr: stderr}
	t.Cleanup(func() {
		_ = command.Process.Kill()
		KillDescendants(t, record)
		_ = command.Wait()
	})
	return process
}

// KillDescendants kills every descendant the fake agent recorded starting.
func KillDescendants(t testing.TB, recordPath string) {
	t.Helper()
	for _, pid := range DescendantPIDs(t, recordPath) {
		if descendant, err := os.FindProcess(pid); err == nil {
			_ = descendant.Kill()
		}
	}
}

// DescendantPIDs returns the process IDs recorded by the IgnoreTermination step.
func DescendantPIDs(t testing.TB, recordPath string) []int {
	t.Helper()
	pids := []int{}
	for _, frame := range Received(t, recordPath) {
		if pid, recorded := frame["descendantPid"].(float64); recorded {
			pids = append(pids, int(pid))
		}
	}
	return pids
}

// RecordedEnvironment returns the variables recorded by CaptureEnvironment steps, merged in order.
func RecordedEnvironment(t testing.TB, recordPath string) map[string]string {
	t.Helper()
	environment := map[string]string{}
	for _, frame := range Received(t, recordPath) {
		recorded, isEnvironment := frame["environment"].(map[string]any)
		if !isEnvironment {
			continue
		}
		for name, value := range recorded {
			environment[name], _ = value.(string)
		}
	}
	return environment
}

// Stderr returns everything the fake agent wrote to stderr so far.
func (process *Process) Stderr() string {
	return process.stderr.String()
}

// Received returns the frames the fake agent read, decoded as generic objects.
func Received(t testing.TB, recordPath string) []map[string]any {
	t.Helper()
	file, err := os.Open(recordPath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	frames := []map[string]any{}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var decoded map[string]any
		if err := json.Unmarshal([]byte(line), &decoded); err != nil {
			t.Fatalf("decode recorded frame %q: %v", line, err)
		}
		frames = append(frames, decoded)
	}
	return frames
}

// ReceivedMethod returns the first recorded frame for method, or nil.
func ReceivedMethod(t testing.TB, recordPath, method string) map[string]any {
	t.Helper()
	for _, frame := range Received(t, recordPath) {
		if frame["method"] == method {
			return frame
		}
	}
	return nil
}

// ReceivedResponse returns the first recorded response whose id equals id, or nil.
func ReceivedResponse(t testing.TB, recordPath string, id any) map[string]any {
	t.Helper()
	for _, frame := range Received(t, recordPath) {
		if _, isMethod := frame["method"]; !isMethod && frame["id"] == id {
			return frame
		}
	}
	return nil
}

type lockedBuffer struct {
	mu   sync.Mutex
	data []byte
}

func (buffer *lockedBuffer) Write(data []byte) (int, error) {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	buffer.data = append(buffer.data, data...)
	return len(data), nil
}

func (buffer *lockedBuffer) String() string {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return string(buffer.data)
}
