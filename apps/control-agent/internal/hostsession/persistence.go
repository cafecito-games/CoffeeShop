package hostsession

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

const (
	persistenceVersion = 1
	registryFilename   = "registry.json"
	ledgerFilename     = "ledger.json"
)

type registryRecord struct {
	Session protocol.HostHarnessSession `json:"session"`
	Owned   bool                        `json:"owned,omitempty"`
}

type commandState string

const (
	commandPending   commandState = "pending"
	commandCompleted commandState = "completed"
	commandUncertain commandState = "uncertain"
)

type ledgerRecord struct {
	CommandID            string                              `json:"commandId"`
	CommandDigest        string                              `json:"commandDigest"`
	Operation            string                              `json:"operation"`
	HostHarnessSessionID string                              `json:"hostHarnessSessionId,omitempty"`
	RequestID            string                              `json:"requestId,omitempty"`
	State                commandState                        `json:"state"`
	Result               *protocol.HostSessionControlMessage `json:"result,omitempty"`
	CompletedAt          string                              `json:"completedAt,omitempty"`
	Acknowledged         bool                                `json:"acknowledged,omitempty"`
}

type registryPayload struct {
	Version int              `json:"version"`
	Records []registryRecord `json:"records"`
}

type registryEnvelope struct {
	Version  int              `json:"version"`
	Records  []registryRecord `json:"records"`
	Checksum string           `json:"checksum"`
}

type ledgerPayload struct {
	Version int            `json:"version"`
	Records []ledgerRecord `json:"records"`
}

type ledgerEnvelope struct {
	Version  int            `json:"version"`
	Records  []ledgerRecord `json:"records"`
	Checksum string         `json:"checksum"`
}

type persistence struct {
	directory string
	failpoint func(string) error
}

type committedPersistenceError struct {
	err error
}

func (failure committedPersistenceError) Error() string { return failure.err.Error() }
func (failure committedPersistenceError) Unwrap() error { return failure.err }

func persistenceMayHaveCommitted(err error) bool {
	var committed committedPersistenceError
	return errors.As(err, &committed)
}

func newPersistence(dataRoot string, failpoint func(string) error) (persistence, error) {
	if !filepath.IsAbs(dataRoot) {
		return persistence{}, fmt.Errorf("host-session data root must be absolute")
	}
	directory := filepath.Join(dataRoot, "host-sessions")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return persistence{}, fmt.Errorf("create host-session data directory: %w", err)
	}
	return persistence{directory: directory, failpoint: failpoint}, nil
}

func checksum(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:]), nil
}

func decodeStrict(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			return fmt.Errorf("unexpected trailing JSON value")
		}
		return err
	}
	return nil
}

func readOptional(path string) ([]byte, bool, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return data, true, nil
}

func (storage persistence) loadRegistry() ([]registryRecord, error) {
	data, present, err := readOptional(filepath.Join(storage.directory, registryFilename))
	if err != nil {
		return nil, fmt.Errorf("read registry: %w", err)
	}
	if !present {
		return []registryRecord{}, nil
	}
	var envelope registryEnvelope
	if err := decodeStrict(data, &envelope); err != nil {
		return nil, fmt.Errorf("decode registry: %w", err)
	}
	if envelope.Version != persistenceVersion {
		return nil, fmt.Errorf("unsupported registry version")
	}
	payload := registryPayload{Version: envelope.Version, Records: envelope.Records}
	want, err := checksum(payload)
	if err != nil || envelope.Checksum != want {
		return nil, fmt.Errorf("registry checksum mismatch")
	}
	return envelope.Records, nil
}

func (storage persistence) loadLedger() ([]ledgerRecord, error) {
	data, present, err := readOptional(filepath.Join(storage.directory, ledgerFilename))
	if err != nil {
		return nil, fmt.Errorf("read command ledger: %w", err)
	}
	if !present {
		return []ledgerRecord{}, nil
	}
	var envelope ledgerEnvelope
	if err := decodeStrict(data, &envelope); err != nil {
		return nil, fmt.Errorf("decode command ledger: %w", err)
	}
	if envelope.Version != persistenceVersion {
		return nil, fmt.Errorf("unsupported command ledger version")
	}
	payload := ledgerPayload{Version: envelope.Version, Records: envelope.Records}
	want, err := checksum(payload)
	if err != nil || envelope.Checksum != want {
		return nil, fmt.Errorf("command ledger checksum mismatch")
	}
	return envelope.Records, nil
}

func (storage persistence) saveRegistry(records []registryRecord) error {
	payload := registryPayload{Version: persistenceVersion, Records: records}
	sum, err := checksum(payload)
	if err != nil {
		return fmt.Errorf("checksum registry: %w", err)
	}
	return storage.writeAtomic(registryFilename, registryEnvelope{
		Version: payload.Version, Records: payload.Records, Checksum: sum,
	})
}

func (storage persistence) saveLedger(records []ledgerRecord) error {
	payload := ledgerPayload{Version: persistenceVersion, Records: records}
	sum, err := checksum(payload)
	if err != nil {
		return fmt.Errorf("checksum command ledger: %w", err)
	}
	return storage.writeAtomic(ledgerFilename, ledgerEnvelope{
		Version: payload.Version, Records: payload.Records, Checksum: sum,
	})
}

func (storage persistence) writeAtomic(filename string, value any) error {
	if err := storage.fail(filename + ":before-create"); err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return fmt.Errorf("encode %s: %w", filename, err)
	}
	temporary, err := os.CreateTemp(storage.directory, ".host-session-*")
	if err != nil {
		return fmt.Errorf("create temporary %s: %w", filename, err)
	}
	temporaryPath := temporary.Name()
	removeTemporary := true
	defer func() {
		if removeTemporary {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("secure temporary %s: %w", filename, err)
	}
	if _, err := temporary.Write(encoded); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write temporary %s: %w", filename, err)
	}
	if err := storage.fail(filename + ":after-write"); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("sync temporary %s: %w", filename, err)
	}
	if err := storage.fail(filename + ":after-file-sync"); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close temporary %s: %w", filename, err)
	}
	destination := filepath.Join(storage.directory, filename)
	if err := os.Rename(temporaryPath, destination); err != nil {
		return fmt.Errorf("replace %s: %w", filename, err)
	}
	removeTemporary = false
	if err := storage.fail(filename + ":after-rename"); err != nil {
		return committedPersistenceError{err: err}
	}
	directory, err := os.Open(storage.directory)
	if err != nil {
		return committedPersistenceError{err: fmt.Errorf("open host-session directory durability barrier: %w", err)}
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return committedPersistenceError{err: fmt.Errorf("sync host-session directory durability barrier: %w", err)}
	}
	if err := storage.fail(filename + ":after-directory-sync"); err != nil {
		return committedPersistenceError{err: err}
	}
	return nil
}

func (storage persistence) fail(stage string) error {
	if storage.failpoint == nil {
		return nil
	}
	if err := storage.failpoint(stage); err != nil {
		return fmt.Errorf("injected durability failure at %s: %w", stage, err)
	}
	return nil
}
