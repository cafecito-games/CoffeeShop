package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

const maxFrameBytes = 2 << 20
const rpcTimeout = 30 * time.Second

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (err rpcError) Error() string { return "codex app-server request failed" }

type rpcEnvelope struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *rpcError       `json:"error,omitempty"`
}

type rpcResult struct {
	result json.RawMessage
	err    error
}

type client struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser

	writeMu sync.Mutex
	mu      sync.Mutex
	pending map[int64]chan rpcResult
	nextID  atomic.Int64
	done    chan struct{}
	err     error
	cleanup sync.Once

	onNotification func(string, json.RawMessage) error
	onRequest      func(json.RawMessage, string, json.RawMessage) error
	onClose        func(error)
}

type clientConfig struct {
	binary         string
	verify         func() error
	onNotification func(string, json.RawMessage) error
	onRequest      func(json.RawMessage, string, json.RawMessage) error
	onClose        func(error)
	lifetime       context.Context
}

func startClient(ctx context.Context, config clientConfig) (*client, error) {
	if config.binary == "" || config.verify == nil {
		return nil, errors.New("managed codex executable is unavailable")
	}
	if err := config.verify(); err != nil {
		return nil, errors.New("managed codex executable no longer verifies")
	}
	command := exec.Command(config.binary, "app-server", "--listen", "stdio://")
	configureProcess(command)
	// Preserve Codex's configured state location. A fresh CODEX_SQLITE_HOME makes the App Server
	// rebuild the operator's complete rollout index before it can answer initialize; on a mature
	// account that can exceed the bounded startup probe by minutes. SQLite is provider state, not
	// Coffee Shop's writer-ownership authority: thread/resume remains the exact writer claim.
	stdin, err := command.StdinPipe()
	if err != nil {
		return nil, errors.New("start codex app-server")
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, errors.New("start codex app-server")
	}
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		return nil, errors.New("start codex app-server")
	}
	result := &client{
		cmd: command, stdin: stdin, pending: make(map[int64]chan rpcResult),
		done: make(chan struct{}), onNotification: config.onNotification, onRequest: config.onRequest, onClose: config.onClose,
	}
	go result.readLoop(stdout)
	lifetime := config.lifetime
	if lifetime == nil {
		lifetime = ctx
	}
	go func() {
		select {
		case <-lifetime.Done():
			result.Close()
		case <-result.done:
		}
	}()
	var initialized struct {
		UserAgent      string `json:"userAgent"`
		CodexHome      string `json:"codexHome"`
		PlatformFamily string `json:"platformFamily"`
		PlatformOS     string `json:"platformOs"`
	}
	initContext, initCancel := context.WithTimeout(ctx, 10*time.Second)
	defer initCancel()
	if err := result.call(initContext, "initialize", map[string]any{
		"clientInfo":   map[string]string{"name": "coffee-shop-barista", "version": "1"},
		"capabilities": map[string]any{"experimentalApi": true},
	}, &initialized); err != nil || initialized.UserAgent == "" || initialized.CodexHome == "" || initialized.PlatformFamily == "" || initialized.PlatformOS == "" {
		result.Close()
		return nil, errors.New("initialize codex app-server")
	}
	if err := result.notify("initialized", map[string]any{}); err != nil {
		result.Close()
		return nil, errors.New("initialize codex app-server")
	}
	return result, nil
}

func (client *client) readLoop(reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), maxFrameBytes)
	for scanner.Scan() {
		line := append([]byte(nil), scanner.Bytes()...)
		var envelope rpcEnvelope
		if err := json.Unmarshal(line, &envelope); err != nil {
			client.closeWithError(errors.New("malformed codex app-server frame"), true)
			return
		}
		if len(envelope.ID) > 0 && envelope.Method == "" {
			var id int64
			if err := json.Unmarshal(envelope.ID, &id); err != nil {
				client.closeWithError(errors.New("invalid codex app-server response identity"), true)
				return
			}
			client.mu.Lock()
			pending := client.pending[id]
			delete(client.pending, id)
			client.mu.Unlock()
			if pending == nil {
				client.closeWithError(errors.New("unexpected codex app-server response"), true)
				return
			}
			if envelope.Error != nil {
				pending <- rpcResult{err: *envelope.Error}
			} else {
				pending <- rpcResult{result: envelope.Result}
			}
			continue
		}
		if envelope.Method == "" {
			client.closeWithError(errors.New("invalid codex app-server frame"), true)
			return
		}
		if len(envelope.ID) > 0 {
			if client.onRequest == nil {
				client.closeWithError(errors.New("unsupported codex app-server request"), true)
				return
			}
			if err := client.onRequest(append(json.RawMessage(nil), envelope.ID...), envelope.Method, append(json.RawMessage(nil), envelope.Params...)); err != nil {
				client.closeWithError(err, true)
				return
			}
		} else if client.onNotification != nil {
			if err := client.onNotification(envelope.Method, append(json.RawMessage(nil), envelope.Params...)); err != nil {
				client.closeWithError(err, true)
				return
			}
		}
	}
	if err := scanner.Err(); err != nil {
		client.closeWithError(errors.New("read codex app-server"), true)
	} else {
		client.closeWithError(errors.New("codex app-server exited"), true)
	}
}

func (client *client) call(ctx context.Context, method string, params any, destination any) error {
	callContext, cancel := context.WithTimeout(ctx, rpcTimeout)
	defer cancel()
	id := client.nextID.Add(1)
	pending := make(chan rpcResult, 1)
	client.mu.Lock()
	if client.err != nil {
		err := client.err
		client.mu.Unlock()
		return err
	}
	client.pending[id] = pending
	client.mu.Unlock()
	if err := client.write(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		client.mu.Lock()
		delete(client.pending, id)
		client.mu.Unlock()
		return err
	}
	select {
	case response := <-pending:
		if response.err != nil {
			return response.err
		}
		if destination == nil {
			return nil
		}
		if err := json.Unmarshal(response.result, destination); err != nil {
			return errors.New("invalid codex app-server response")
		}
		return nil
	case <-callContext.Done():
		client.mu.Lock()
		delete(client.pending, id)
		client.mu.Unlock()
		return errors.New("codex app-server request timed out")
	case <-client.done:
		client.mu.Lock()
		err := client.err
		client.mu.Unlock()
		return err
	}
}

func (client *client) notify(method string, params any) error {
	return client.write(map[string]any{"method": method, "params": params})
}

func (client *client) respond(id json.RawMessage, result any) error {
	var value any
	if err := json.Unmarshal(id, &value); err != nil {
		return errors.New("invalid codex app-server request identity")
	}
	return client.write(map[string]any{"id": value, "result": result})
}

func (client *client) write(value any) error {
	encoded, err := json.Marshal(value)
	if err != nil || len(encoded) >= maxFrameBytes {
		return errors.New("encode codex app-server frame")
	}
	client.writeMu.Lock()
	defer client.writeMu.Unlock()
	if _, err := client.stdin.Write(append(encoded, '\n')); err != nil {
		return errors.New("write codex app-server frame")
	}
	return nil
}

func (client *client) closeWithError(err error, unexpected bool) {
	client.mu.Lock()
	if client.err != nil {
		client.mu.Unlock()
		return
	}
	client.err = err
	for id, pending := range client.pending {
		pending <- rpcResult{err: err}
		delete(client.pending, id)
	}
	close(client.done)
	onClose := client.onClose
	client.mu.Unlock()
	if unexpected && onClose != nil {
		onClose(err)
	}
	if unexpected {
		_ = terminateProcess(client.cmd)
		go client.cleanupProcess()
	}
}

func (client *client) Close() {
	client.closeWithError(errors.New("codex app-server closed"), false)
	client.cleanupProcess()
}

func (client *client) cleanupProcess() {
	client.cleanup.Do(func() {
		_ = client.stdin.Close()
		wait := make(chan struct{})
		go func() { _ = client.cmd.Wait(); close(wait) }()
		select {
		case <-wait:
			_ = terminateProcess(client.cmd)
		case <-time.After(2 * time.Second):
			_ = terminateProcess(client.cmd)
			<-wait
		}
	})
}

func classifyRPC(err error) (int, string, bool) {
	var rpc rpcError
	if !errors.As(err, &rpc) {
		return 0, "", false
	}
	return rpc.Code, rpc.Message, true
}

func bounded(value string, limit int) string {
	if protocol.LooksSecretLike(value) {
		return "[redacted]"
	}
	if len(value) <= limit {
		return value
	}
	end := limit
	for end > 0 && !utf8.RuneStart(value[end]) {
		end--
	}
	return value[:end]
}
