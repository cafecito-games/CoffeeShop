//go:build system && unix

// Package systemtest proves the multi-node orchestration workflow end to end: a real hub process,
// real Barista processes connected over the real control WebSocket, and the deterministic fake
// harness (fakeharness) standing in for every provider executable. Nothing here reimplements hub
// or scheduler logic; assertions read the hub's persisted state and REST projections.
//
// Run it with `task system:test`; it needs Node.js with the workspace dependencies installed, the
// built protocol package, Go, and Git. It never contacts a provider or the network.
package systemtest

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// buildDirectoryPrefix names the temporary directory holding the binaries built for one test run.
const buildDirectoryPrefix = "coffee-shop-system-build-"

// Built once per test binary by TestMain.
var (
	repositoryRoot  string
	baristaBinary   string
	adapterBinaries map[string]string
	nativeDirectory string
)

func TestMain(m *testing.M) {
	code, err := prepare(m)
	if err != nil {
		fmt.Fprintf(os.Stderr, "system test setup failed: %v\n", err)
		os.Exit(1)
	}
	os.Exit(code)
}

// prepare builds Barista and the fake harness and checks the hub can start, failing before any
// scenario rather than skipping when something is missing.
func prepare(m *testing.M) (int, error) {
	workingDirectory, err := os.Getwd()
	if err != nil {
		return 0, err
	}
	repositoryRoot = filepath.Clean(filepath.Join(workingDirectory, "..", "..", "..", ".."))
	for _, required := range []string{
		filepath.Join(repositoryRoot, "apps", "hub", "src", "index.ts"),
		filepath.Join(repositoryRoot, "apps", "hub", "node_modules", "tsx"),
		filepath.Join(repositoryRoot, "packages", "protocol", "dist", "index.js"),
		filepath.Join(repositoryRoot, "apps", "orchestrator-bridge", "src", "index.ts"),
		filepath.Join(repositoryRoot, "apps", "orchestrator-bridge", "node_modules", "tsx"),
	} {
		if _, err := os.Stat(required); err != nil {
			return 0, fmt.Errorf("%s is missing; run `task install` and `task protocol:build` first", required)
		}
	}
	if err := verifyProcessInspection(); err != nil {
		return 0, err
	}
	for _, tool := range []string{"node", "git", "go"} {
		if _, err := exec.LookPath(tool); err != nil {
			return 0, fmt.Errorf("%s is not on PATH", tool)
		}
	}
	buildDirectory, err := os.MkdirTemp("", buildDirectoryPrefix)
	if err != nil {
		return 0, err
	}
	defer os.RemoveAll(buildDirectory)
	controlAgent := filepath.Join(repositoryRoot, "apps", "control-agent")
	baristaBinary = filepath.Join(buildDirectory, "barista")
	fake := filepath.Join(buildDirectory, "fakeharness")
	for target, output := range map[string]string{"./cmd/barista": baristaBinary, "./internal/systemtest/fakeharness": fake} {
		command := exec.Command("go", "build", "-o", output, target)
		command.Dir = controlAgent
		if combined, err := command.CombinedOutput(); err != nil {
			return 0, fmt.Errorf("build %s: %v\n%s", target, err, combined)
		}
	}
	adapterDirectory := filepath.Join(buildDirectory, "adapters")
	nativeDirectory = filepath.Join(buildDirectory, "native")
	adapterBinaries = map[string]string{"codex-cli": filepath.Join(adapterDirectory, "codex-acp"), "claude-cli": filepath.Join(adapterDirectory, "claude-agent-acp")}
	copies := []string{adapterBinaries["codex-cli"], adapterBinaries["claude-cli"], filepath.Join(nativeDirectory, "codex"), filepath.Join(nativeDirectory, "claude")}
	for _, destination := range copies {
		if err := copyExecutable(fake, destination); err != nil {
			return 0, err
		}
	}
	return m.Run(), nil
}

func copyExecutable(source, destination string) error {
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return err
	}
	content, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	return os.WriteFile(destination, content, 0o755)
}

// Deadlines for observable state. Every wait is bounded and polls committed hub state.
const (
	stateDeadline   = 90 * time.Second
	processDeadline = 30 * time.Second
	pollInterval    = 25 * time.Millisecond
)

// Credentials: the enrollment token is Coffee Shop's own; the canaries are fake provider tokens
// injected only into Barista's environment, where a real provider CLI would read them. None of them
// may ever appear in hub state, projections, events, or logs.
const enrollmentToken = "coffee-shop-enrollment-canary-7d1f0c2a9b"

var providerCanaries = map[string]string{
	"OPENAI_API_KEY":          "sk-proj-CANARYopenai0123456789abcdefghij",
	"CODEX_API_KEY":           "sk-CANARYcodex0123456789abcdefghijklmn",
	"ANTHROPIC_API_KEY":       "sk-ant-api03-CANARYanthropic0123456789abcdef",
	"CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat01-CANARYoauth0123456789abcdefgh",
	"GITHUB_TOKEN":            "ghp_CANARYgithub0123456789abcdefghijklmnop",
}

// environment is one isolated Coffee Shop installation: a hub, its Baristas, and the test-owned
// directories the fake harness reads. Its root is removed only after every owned process stopped
// and the scenario passed; a failing scenario keeps it for diagnosis.
type environment struct {
	t        *testing.T
	root     string
	records  string
	gates    string
	hub      *hubProcess
	mu       sync.Mutex
	nodes    map[string]*baristaNode
	profiles []map[string]any
}

type environmentOptions struct {
	profiles []map[string]any
	// legacyStatePath is copied to COFFEE_SHOP_DATA before the real Hub first starts.
	legacyStatePath string
	// clockOffset loads the hub's test clock so a scenario can move hub time forward.
	clockOffset bool
}

func newEnvironment(t *testing.T, options environmentOptions) *environment {
	t.Helper()
	created, err := os.MkdirTemp("", "coffee-shop-system-")
	if err != nil {
		t.Fatal(err)
	}
	root, err := filepath.EvalSymlinks(created)
	if err != nil {
		t.Fatal(err)
	}
	environment := &environment{t: t, root: root, records: filepath.Join(root, "records"), gates: filepath.Join(root, "gates"), nodes: map[string]*baristaNode{}, profiles: options.profiles}
	for _, directory := range []string{environment.records, environment.gates} {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if options.legacyStatePath != "" {
		legacy, err := os.ReadFile(options.legacyStatePath)
		if err != nil {
			t.Fatal(err)
		}
		legacyPath := filepath.Join(environment.root, "hub", "state.json")
		if err := os.MkdirAll(filepath.Dir(legacyPath), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(legacyPath, legacy, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(environment.teardown)
	environment.hub = environment.startHub(options.clockOffset)
	return environment
}

// teardown stops every owned process, proves no fake harness process outlived its Barista, and
// removes the environment root only when the scenario passed.
func (environment *environment) teardown() {
	t := environment.t
	environment.mu.Lock()
	nodes := make([]*baristaNode, 0, len(environment.nodes))
	for _, node := range environment.nodes {
		nodes = append(nodes, node)
	}
	environment.mu.Unlock()
	for _, node := range nodes {
		node.stop(false)
		node.proxy.close()
	}
	if environment.hub != nil {
		environment.hub.stop()
	}
	if leaked := environment.liveHarnessProcesses(processDeadline); len(leaked) > 0 {
		for _, pid := range leaked {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
		t.Errorf("fake harness processes outlived their Barista: %v", leaked)
	}
	if t.Failed() {
		t.Logf("retained the failed scenario's environment for diagnosis: %s", environment.root)
		environment.dumpDiagnostics()
		return
	}
	_ = os.RemoveAll(environment.root)
}

// harnessRecord is one line the fake harness recorded.
type harnessRecord struct {
	Event            string          `json:"event"`
	Role             string          `json:"role"`
	PID              int             `json:"pid"`
	Environment      map[string]bool `json:"environment"`
	WorkingDirectory string          `json:"workingDirectory"`
	SessionID        string          `json:"sessionId"`
	Cwd              string          `json:"cwd"`
	Code             int             `json:"code"`
}

// harnessRecords returns every record the fake harness wrote, grouped by the file (one process).
func (environment *environment) harnessRecords() map[string][]harnessRecord {
	result := map[string][]harnessRecord{}
	entries, _ := os.ReadDir(environment.records)
	for _, entry := range entries {
		file, err := os.Open(filepath.Join(environment.records, entry.Name()))
		if err != nil {
			continue
		}
		scanner := bufio.NewScanner(file)
		for scanner.Scan() {
			var record harnessRecord
			if json.Unmarshal(scanner.Bytes(), &record) == nil {
				result[entry.Name()] = append(result[entry.Name()], record)
			}
		}
		file.Close()
	}
	return result
}

// liveHarnessProcesses waits up to deadline for every recorded fake harness process to exit and
// returns the ones still alive.
func (environment *environment) liveHarnessProcesses(deadline time.Duration) []int {
	limit := time.Now().Add(deadline)
	for {
		alive := []int{}
		for _, records := range environment.harnessRecords() {
			for _, record := range records {
				if record.Event == "start" && processAlive(environment.t, record.PID) {
					alive = append(alive, record.PID)
				}
			}
		}
		if len(alive) == 0 || time.Now().After(limit) {
			sort.Ints(alive)
			return alive
		}
		time.Sleep(pollInterval)
	}
}

// processAlive reports whether pid is still one of this test binary's fake harness executables,
// so a recycled process ID never counts as a leak and is never signalled. It fails the test when
// the process cannot be inspected, so leak detection can never be silently disabled.
func processAlive(t *testing.T, pid int) bool {
	t.Helper()
	if pid <= 0 {
		return false
	}
	if err := syscall.Kill(pid, 0); err != nil && !errors.Is(err, syscall.EPERM) {
		return false
	}
	command, err := exec.Command("ps", "-o", "command=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		// ps exits nonzero for a process that ended between the two checks; anything else means
		// the process cannot be inspected.
		if exitError := (*exec.ExitError)(nil); errors.As(err, &exitError) {
			if killErr := syscall.Kill(pid, 0); killErr != nil && !errors.Is(killErr, syscall.EPERM) {
				return false
			}
		}
		t.Fatalf("cannot inspect process %d with ps: %v", pid, err)
	}
	return strings.Contains(string(command), buildDirectoryPrefix)
}

// verifyProcessInspection proves ps can report a live process's command before any scenario
// relies on it for leak detection.
func verifyProcessInspection() error {
	command, err := exec.Command("ps", "-o", "command=", "-p", strconv.Itoa(os.Getpid())).Output()
	if err != nil || strings.TrimSpace(string(command)) == "" {
		return fmt.Errorf("process inspection with `ps -o command= -p <pid>` is unavailable: %v", err)
	}
	return nil
}

func (environment *environment) dumpDiagnostics() {
	t := environment.t
	if environment.hub != nil {
		t.Logf("hub log tail:\n%s", environment.hub.logs.tail(8000))
	}
	for id, node := range environment.nodes {
		t.Logf("barista %s log tail:\n%s", id, node.logs.tail(8000))
	}
}

// openGate lets every fake harness step waiting on name continue.
func (environment *environment) openGate(name string) {
	environment.t.Helper()
	if err := os.WriteFile(filepath.Join(environment.gates, name), []byte("open\n"), 0o644); err != nil {
		environment.t.Fatal(err)
	}
}

// boundedLog keeps the most recent output of a process for diagnostics and scans.
type boundedLog struct {
	mu       sync.Mutex
	data     []byte
	complete []byte
	lines    chan string
}

const logRetentionBytes = 4 << 20

func newBoundedLog() *boundedLog { return &boundedLog{lines: make(chan string, 1024)} }

func (log *boundedLog) Write(data []byte) (int, error) {
	log.mu.Lock()
	defer log.mu.Unlock()
	log.data = append(log.data, data...)
	if len(log.data) > logRetentionBytes {
		log.data = log.data[len(log.data)-logRetentionBytes:]
	}
	log.complete = append(log.complete, data...)
	for {
		index := bytes.IndexByte(log.complete, '\n')
		if index < 0 {
			break
		}
		line := string(log.complete[:index])
		log.complete = log.complete[index+1:]
		select {
		case log.lines <- line:
		default:
		}
	}
	return len(data), nil
}

func (log *boundedLog) String() string {
	log.mu.Lock()
	defer log.mu.Unlock()
	return string(log.data)
}

func (log *boundedLog) tail(limit int) string {
	text := log.String()
	if len(text) > limit {
		return text[len(text)-limit:]
	}
	return text
}

// ownedProcess is a process group the test started and must stop.
type ownedProcess struct {
	command *exec.Cmd
	exited  chan struct{}
}

func startOwned(command *exec.Cmd) (*ownedProcess, error) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := command.Start(); err != nil {
		return nil, err
	}
	process := &ownedProcess{command: command, exited: make(chan struct{})}
	go func() {
		_ = command.Wait()
		close(process.exited)
	}()
	return process, nil
}

// stop sends SIGTERM (or SIGKILL) to the whole process group and waits, escalating after a bound.
func (process *ownedProcess) stop(kill bool) {
	if process == nil {
		return
	}
	select {
	case <-process.exited:
		return
	default:
	}
	signal := syscall.SIGTERM
	if kill {
		signal = syscall.SIGKILL
	}
	_ = syscall.Kill(-process.command.Process.Pid, signal)
	select {
	case <-process.exited:
	case <-time.After(10 * time.Second):
		_ = syscall.Kill(-process.command.Process.Pid, syscall.SIGKILL)
		<-process.exited
	}
}

// hubProcess is the real hub started from source with tsx.
type hubProcess struct {
	environment *environment
	process     *ownedProcess
	logs        *boundedLog
	port        int
	dataPath    string
	profiles    string
	clock       string
}

var listeningPattern = regexp.MustCompile(`Coffee Shop hub listening on http://localhost:(\d+)`)

func (environment *environment) startHub(clockOffset bool) *hubProcess {
	t := environment.t
	t.Helper()
	hub := &hubProcess{environment: environment, dataPath: filepath.Join(environment.root, "hub", "coffee-shop.sqlite"), profiles: filepath.Join(environment.root, "hub", "project-profiles.json")}
	if clockOffset {
		hub.clock = filepath.Join(environment.root, "hub", "clock-offset")
	}
	if err := os.MkdirAll(filepath.Dir(hub.dataPath), 0o755); err != nil {
		t.Fatal(err)
	}
	profiles := environment.profiles
	if profiles == nil {
		profiles = []map[string]any{}
	}
	encoded, _ := json.MarshalIndent(map[string]any{"profiles": profiles}, "", "  ")
	if err := os.WriteFile(hub.profiles, encoded, 0o644); err != nil {
		t.Fatal(err)
	}
	hub.start()
	return hub
}

func (hub *hubProcess) start() {
	t := hub.environment.t
	t.Helper()
	arguments := []string{"--import", "tsx"}
	environmentVariables := []string{
		"PATH=" + os.Getenv("PATH"), "HOME=" + filepath.Join(hub.environment.root, "hub"),
		"NODE_ENV=production", "PORT=0", "COFFEE_SHOP_TOKEN=" + enrollmentToken,
		"COFFEE_SHOP_DATABASE=" + hub.dataPath,
		"COFFEE_SHOP_DATA=" + filepath.Join(filepath.Dir(hub.dataPath), "state.json"),
		"PROJECT_PROFILES_PATH=" + hub.profiles,
	}
	if hub.clock != "" {
		arguments = append(arguments, "--import", "file://"+filepath.Join(repositoryRoot, "apps", "control-agent", "internal", "systemtest", "testdata", "hub-clock.mjs"))
		environmentVariables = append(environmentVariables, "COFFEE_SHOP_TEST_CLOCK_OFFSET_FILE="+hub.clock)
	}
	command := exec.Command("node", append(arguments, "src/index.ts")...)
	command.Dir = filepath.Join(repositoryRoot, "apps", "hub")
	command.Env = environmentVariables
	hub.logs = newBoundedLog()
	command.Stdout = hub.logs
	command.Stderr = hub.logs
	process, err := startOwned(command)
	if err != nil {
		t.Fatalf("start hub: %v", err)
	}
	hub.process = process
	deadline := time.After(processDeadline)
	for {
		select {
		case line := <-hub.logs.lines:
			if match := listeningPattern.FindStringSubmatch(line); match != nil {
				hub.port, _ = strconv.Atoi(match[1])
				for _, node := range hub.environment.nodes {
					node.proxy.retarget(hub.port)
				}
				return
			}
		case <-process.exited:
			t.Fatalf("hub exited before it was ready:\n%s", hub.logs.tail(8000))
		case <-deadline:
			t.Fatalf("hub was not ready within %s:\n%s", processDeadline, hub.logs.tail(8000))
		}
	}
}

func (hub *hubProcess) stop() { hub.process.stop(false) }

// restart stops the hub and starts it again on the same data file; Baristas reconnect through
// their proxies, which follow the new port.
func (hub *hubProcess) restart() {
	hub.stop()
	hub.start()
}

// advanceClock moves the hub's clock forward and waits for the hub to confirm it.
func (hub *hubProcess) advanceClock(offset time.Duration) {
	t := hub.environment.t
	t.Helper()
	if hub.clock == "" {
		t.Fatal("the environment was started without the test clock")
	}
	milliseconds := strconv.FormatInt(offset.Milliseconds(), 10)
	if err := os.WriteFile(hub.clock, []byte(milliseconds), 0o644); err != nil {
		t.Fatal(err)
	}
	confirmation := "test clock offset " + milliseconds
	deadline := time.After(processDeadline)
	for {
		if strings.Contains(hub.logs.String(), confirmation) {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("the hub did not apply the clock offset")
		case <-time.After(pollInterval):
		}
	}
}

// request performs one authenticated REST call and decodes the JSON response into result.
func (hub *hubProcess) request(method, path string, body any, result any) int {
	t := hub.environment.t
	t.Helper()
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequest(method, "http://127.0.0.1:"+strconv.Itoa(hub.port)+path, reader)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+enrollmentToken)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if result != nil && len(data) > 0 {
		if err := json.Unmarshal(data, result); err != nil {
			t.Fatalf("%s %s returned undecodable JSON (%d): %s", method, path, response.StatusCode, data)
		}
	}
	return response.StatusCode
}

func (hub *hubProcess) rawGet(path string) (int, []byte) {
	t := hub.environment.t
	t.Helper()
	request, _ := http.NewRequest(http.MethodGet, "http://127.0.0.1:"+strconv.Itoa(hub.port)+path, nil)
	request.Header.Set("Authorization", "Bearer "+enrollmentToken)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	return response.StatusCode, data
}

func (hub *hubProcess) snapshot() snapshot {
	var result snapshot
	if status := hub.request(http.MethodGet, "/api/snapshot", nil, &result); status != http.StatusOK {
		hub.environment.t.Fatalf("snapshot returned %d", status)
	}
	return result
}

// eventually polls condition until it reports true, failing with its last explanation.
func (environment *environment) eventually(description string, condition func(snapshot) (bool, string)) snapshot {
	environment.t.Helper()
	deadline := time.Now().Add(stateDeadline)
	last := ""
	for {
		current := environment.hub.snapshot()
		done, explanation := condition(current)
		if done {
			return current
		}
		last = explanation
		if time.Now().After(deadline) {
			environment.t.Fatalf("timed out waiting for %s: %s", description, last)
		}
		time.Sleep(pollInterval)
	}
}

// proxy relays one Barista's control connection so a scenario can sever it or follow a restarted
// hub to its new port without restarting Barista.
type proxy struct {
	listener net.Listener
	mu       sync.Mutex
	target   int
	paused   bool
	links    map[net.Conn]net.Conn
}

func newProxy(t *testing.T, target int) *proxy {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	relay := &proxy{listener: listener, target: target, links: map[net.Conn]net.Conn{}}
	go relay.serve()
	return relay
}

func (relay *proxy) port() int { return relay.listener.Addr().(*net.TCPAddr).Port }

func (relay *proxy) serve() {
	for {
		downstream, err := relay.listener.Accept()
		if err != nil {
			return
		}
		relay.mu.Lock()
		paused, target := relay.paused, relay.target
		relay.mu.Unlock()
		if paused {
			downstream.Close()
			continue
		}
		upstream, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(target), 5*time.Second)
		if err != nil {
			downstream.Close()
			continue
		}
		relay.mu.Lock()
		relay.links[downstream] = upstream
		relay.mu.Unlock()
		go relay.pipe(downstream, upstream)
		go relay.pipe(upstream, downstream)
	}
}

func (relay *proxy) pipe(from, to net.Conn) {
	_, _ = io.Copy(to, from)
	from.Close()
	to.Close()
	relay.mu.Lock()
	delete(relay.links, from)
	delete(relay.links, to)
	relay.mu.Unlock()
}

// sever closes every relayed connection, as a network partition would.
func (relay *proxy) sever() {
	relay.mu.Lock()
	defer relay.mu.Unlock()
	for downstream, upstream := range relay.links {
		downstream.Close()
		upstream.Close()
	}
}

// setPaused refuses (true) or accepts (false) new connections.
func (relay *proxy) setPaused(paused bool) {
	relay.mu.Lock()
	relay.paused = paused
	relay.mu.Unlock()
}

func (relay *proxy) retarget(port int) {
	relay.mu.Lock()
	relay.target = port
	relay.mu.Unlock()
}

func (relay *proxy) close() {
	relay.listener.Close()
	relay.sever()
}

// nodeOptions configures one Barista.
type nodeOptions struct {
	id    string
	name  string
	codex bool
	// claudeAuthMode, when set, installs the Claude ACP adapter under that auth mode.
	claudeAuthMode   string
	labels           []string
	nativeFallback   []string
	concurrency      int
	instanceCapacity *int
	projects         []string
}

// baristaNode is one real Barista process with its own workspace root, data root, and provider
// session store.
type baristaNode struct {
	environment *environment
	options     nodeOptions
	home        string
	root        string
	dataRoot    string
	sessions    string
	proxy       *proxy
	process     *ownedProcess
	logs        *boundedLog
	starts      int
}

func (environment *environment) startNode(options nodeOptions) *baristaNode {
	t := environment.t
	t.Helper()
	if options.name == "" {
		options.name = options.id
	}
	if options.concurrency == 0 {
		options.concurrency = 4
	}
	base := filepath.Join(environment.root, "nodes", options.id)
	node := &baristaNode{
		environment: environment, options: options, home: filepath.Join(base, "home"), root: filepath.Join(base, "workspace"),
		dataRoot: filepath.Join(base, "data"), sessions: filepath.Join(base, "provider-sessions"),
	}
	for _, directory := range []string{node.home, node.root, node.dataRoot, node.sessions} {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	node.proxy = newProxy(t, environment.hub.port)
	node.logs = newBoundedLog()
	environment.mu.Lock()
	environment.nodes[options.id] = node
	environment.mu.Unlock()
	node.start()
	return node
}

func sha256File(t *testing.T, path string) string {
	t.Helper()
	output, err := exec.Command("shasum", "-a", "256", path).Output()
	if err != nil {
		output, err = exec.Command("sha256sum", path).Output()
	}
	if err != nil {
		t.Fatalf("hash %s: %v", path, err)
	}
	return strings.Fields(string(output))[0]
}

// start launches Barista and waits until the hub reports the node online and past its reconnect
// barrier (its capability report is visible through project readiness).
func (node *baristaNode) start() {
	t := node.environment.t
	t.Helper()
	options := node.options
	instanceCapacity := options.concurrency
	if options.instanceCapacity != nil {
		instanceCapacity = *options.instanceCapacity
	}
	arguments := []string{
		"--control-endpoint", "http://127.0.0.1:" + strconv.Itoa(node.proxy.port()),
		"--id", options.id, "--name", options.name, "--kind", "local",
		"--workspace-root", node.root, "--concurrency", strconv.Itoa(options.concurrency),
		"--instance-capacity", strconv.Itoa(instanceCapacity),
		"--data-root", node.dataRoot,
	}
	if options.codex {
		arguments = append(arguments, "--acp-adapter", "codex-cli=sha256:"+sha256File(t, adapterBinaries["codex-cli"])+":"+adapterBinaries["codex-cli"])
	}
	if options.claudeAuthMode != "" {
		arguments = append(arguments, "--acp-adapter", "claude-cli=sha256:"+sha256File(t, adapterBinaries["claude-cli"])+":"+adapterBinaries["claude-cli"], "--claude-acp-auth-mode", options.claudeAuthMode)
	}
	for _, label := range options.labels {
		arguments = append(arguments, "--label", label)
	}
	for _, harnessID := range options.nativeFallback {
		arguments = append(arguments, "--acp-native-fallback", harnessID)
	}
	for _, project := range options.projects {
		arguments = append(arguments, "--project", project)
	}
	environmentVariables := []string{
		"PATH=" + nativeDirectory + string(os.PathListSeparator) + os.Getenv("PATH"),
		"HOME=" + node.home, "COFFEE_SHOP_TOKEN=" + enrollmentToken,
		"COFFEE_SHOP_FAKE_RECORD_DIRECTORY=" + node.environment.records,
		"COFFEE_SHOP_FAKE_SESSION_DIRECTORY=" + node.sessions,
		"COFFEE_SHOP_FAKE_GATE_DIRECTORY=" + node.environment.gates,
		"GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=" + filepath.Join(node.home, ".gitconfig"),
	}
	for name, value := range providerCanaries {
		environmentVariables = append(environmentVariables, name+"="+value)
	}
	command := exec.Command(baristaBinary, arguments...)
	command.Dir = node.home
	command.Env = environmentVariables
	command.Stdout = node.logs
	command.Stderr = node.logs
	process, err := startOwned(command)
	if err != nil {
		t.Fatalf("start barista %s: %v", options.id, err)
	}
	node.process = process
	node.starts++
	node.environment.eventually("barista "+options.id+" to register", func(current snapshot) (bool, string) {
		select {
		case <-process.exited:
			t.Fatalf("barista %s exited:\n%s", options.id, node.logs.tail(8000))
		default:
		}
		for _, candidate := range current.Nodes {
			if candidate.ID == options.id && candidate.Status != "offline" {
				return strings.Count(node.logs.String(), "connected to") >= node.starts, "waiting for the connection log"
			}
		}
		return false, "node not online"
	})
}

// stop terminates Barista (SIGTERM lets it cancel its runs; SIGKILL simulates a crash).
func (node *baristaNode) stop(kill bool) {
	node.process.stop(kill)
}

// restart starts Barista again with the same identity, data root, and workspace.
func (node *baristaNode) restart() {
	node.stop(false)
	node.start()
}

// directory creates a plain directory beneath the node's workspace root.
func (node *baristaNode) directory(name string) string {
	path := filepath.Join(node.root, name)
	if err := os.MkdirAll(path, 0o755); err != nil {
		node.environment.t.Fatal(err)
	}
	return path
}

// repositoryURL is the credential-free identity every test checkout's origin names. It is never
// fetched from.
const repositoryURL = "https://git.example.test/cafecito/e2e-app"

// repository creates a Git checkout on main with one commit and an origin naming repositoryURL.
func (node *baristaNode) repository(name string) string {
	path := node.directory(name)
	for _, arguments := range [][]string{
		{"init", "-q", "-b", "main"},
		{"config", "user.name", "Coffee Shop System Test"},
		{"config", "user.email", "system-test@example.test"},
		{"remote", "add", "origin", repositoryURL + ".git"},
	} {
		runGit(node.environment.t, path, arguments...)
	}
	if err := os.WriteFile(filepath.Join(path, "README.md"), []byte("# e2e app\n"), 0o644); err != nil {
		node.environment.t.Fatal(err)
	}
	runGit(node.environment.t, path, "add", "README.md")
	runGit(node.environment.t, path, "commit", "-q", "-m", "Initial commit")
	return path
}

func runGit(t *testing.T, directory string, arguments ...string) string {
	t.Helper()
	command := exec.Command("git", arguments...)
	command.Dir = directory
	command.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(arguments, " "), err, output)
	}
	return strings.TrimSpace(string(output))
}

// projectProfile is the checked-in-shaped, non-secret profile the scenarios place work against.
func projectProfile(id string, isolation, cleanup string) map[string]any {
	workspacePolicy := map[string]any{"requireWritable": true}
	if isolation != "" {
		workspacePolicy["isolation"] = isolation
		workspacePolicy["cleanup"] = cleanup
	}
	return map[string]any{
		"schemaVersion":   1,
		"id":              id,
		"name":            "System test " + id,
		"repository":      map[string]any{"url": repositoryURL, "defaultBranch": "main"},
		"workspacePolicy": workspacePolicy,
		"requirements": map[string]any{
			"hard": map[string]any{"operatingSystems": []string{runtime.GOOS}, "labels": []string{"e2e-ready"}},
		},
	}
}

// waitForReadiness waits until the hub evaluates every named node as ready for the project,
// which requires each node's capability report.
func (environment *environment) waitForReadiness(projectID string, nodeIDs ...string) {
	t := environment.t
	t.Helper()
	deadline := time.Now().Add(stateDeadline)
	for {
		var response struct {
			Readiness []map[string]any `json:"readiness"`
		}
		environment.hub.request(http.MethodGet, "/api/project-readiness?projectId="+projectID, nil, &response)
		ready := map[string]bool{}
		for _, entry := range response.Readiness {
			nodeID, _ := entry["nodeId"].(string)
			ready[nodeID] = entry["ready"] == true
		}
		missing := []string{}
		for _, nodeID := range nodeIDs {
			if !ready[nodeID] {
				missing = append(missing, nodeID)
			}
		}
		if len(missing) == 0 {
			return
		}
		if time.Now().After(deadline) {
			encoded, _ := json.Marshal(response)
			t.Fatalf("nodes %v never became ready for %s: %s", missing, projectID, encoded)
		}
		time.Sleep(pollInterval)
	}
}

// agentOptions is the operator configuration of one agent.
type agentOptions struct {
	name         string
	harnessID    string
	model        string
	nodeID       string
	workspace    string
	systemPrompt string
	canDelegate  bool
	skills       []string
}

// createAgent configures an agent through the REST API and returns its hub-issued ID.
func (environment *environment) createAgent(options agentOptions) string {
	t := environment.t
	t.Helper()
	if options.systemPrompt == "" {
		options.systemPrompt = "You are a Coffee Shop system test agent."
	}
	body := map[string]any{
		"name": options.name, "title": options.name, "harnessId": options.harnessID, "model": options.model,
		"computeNodeId": options.nodeID, "workspace": options.workspace, "systemPrompt": options.systemPrompt,
		"canDelegate": options.canDelegate, "skills": options.skills,
	}
	if options.skills == nil {
		body["skills"] = []string{}
	}
	var created struct {
		ID    string `json:"id"`
		Error string `json:"error"`
	}
	if status := environment.hub.request(http.MethodPost, "/api/agents", body, &created); status != http.StatusCreated {
		t.Fatalf("create agent %s returned %d: %s", options.name, status, created.Error)
	}
	return created.ID
}

// sendMessage posts an operator message to an agent and returns the queued run.
func (environment *environment) sendMessage(agentID, body, threadID string) run {
	t := environment.t
	t.Helper()
	request := map[string]any{"body": body}
	if threadID != "" {
		request["threadId"] = threadID
	}
	var queued run
	if status := environment.hub.request(http.MethodPost, "/api/agents/"+agentID+"/messages", request, &queued); status != http.StatusAccepted {
		t.Fatalf("message to %s returned %d", agentID, status)
	}
	return queued
}

// resolveApproval posts an operator resolution and returns the HTTP status and approval.
func (environment *environment) resolveApproval(approvalID, idempotencyKey, optionID string) (int, approval) {
	var response struct {
		Approval approval `json:"approval"`
		Error    string   `json:"error"`
	}
	status := environment.hub.request(http.MethodPost, "/api/approvals/"+approvalID+"/resolution",
		map[string]any{"idempotencyKey": idempotencyKey, "expectedStatus": "pending", "optionId": optionID}, &response)
	return status, response.Approval
}

// runEvents returns a run's retained normalized harness events and its activity projection.
func (environment *environment) runEvents(runID string) ([]map[string]any, map[string]any) {
	var response struct {
		Events   []map[string]any `json:"events"`
		Activity map[string]any   `json:"activity"`
	}
	if status := environment.hub.request(http.MethodGet, "/api/runs/"+runID+"/events", nil, &response); status != http.StatusOK {
		environment.t.Fatalf("run events for %s returned %d", runID, status)
	}
	return response.Events, response.Activity
}

// assertNoCredentialLeak scans everything the hub persisted, published, or logged for the
// enrollment token and every provider canary.
func (environment *environment) assertNoCredentialLeak() {
	t := environment.t
	t.Helper()
	sources := map[string]string{"hub log": environment.hub.logs.String()}
	_ = filepath.WalkDir(filepath.Dir(environment.hub.dataPath), func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() || path == environment.hub.profiles {
			return nil
		}
		content, readErr := os.ReadFile(path)
		if readErr == nil {
			sources["hub file "+path] = string(content)
		}
		return nil
	})
	current := environment.hub.snapshot()
	encoded, _ := json.Marshal(current)
	sources["snapshot"] = string(encoded)
	for _, path := range []string{"/api/approvals", "/api/workspace-leases"} {
		_, body := environment.hub.rawGet(path)
		sources[path] = string(body)
	}
	for _, item := range current.Runs {
		_, body := environment.hub.rawGet("/api/runs/" + item.ID + "/events")
		sources["events "+item.ID] = string(body)
	}
	secrets := map[string]string{"COFFEE_SHOP_TOKEN": enrollmentToken}
	for name, value := range providerCanaries {
		secrets[name] = value
	}
	for source, content := range sources {
		for name, value := range secrets {
			if strings.Contains(content, value) {
				t.Errorf("%s leaked into %s", name, source)
			}
		}
	}
}

// waitFor polls a REST-free condition, such as a file, with the same bound as state waits.
func waitFor(t *testing.T, description string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(stateDeadline)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", description)
		}
		time.Sleep(pollInterval)
	}
}
