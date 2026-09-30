package hostsession

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

const (
	registryVersion             = 1
	ledgerVersion               = 1
	forgetTransactionVersion    = 1
	registryName                = "host-sessions.json"
	ledgerName                  = "host-session-commands.json"
	forgetTransactionName       = "host-session-forget.json"
	maximumDurableDocumentBytes = 16 << 20
)

type sessionRecord struct {
	Observation         protocol.HostHarnessSessionObservation `json:"observation"`
	LifecycleOperations []string                               `json:"lifecycleOperations,omitempty"`
	AttachedThreadID    string                                 `json:"attachedThreadId,omitempty"`
	ActiveRunID         string                                 `json:"activeRunId,omitempty"`
	AttachmentEpoch     int64                                  `json:"attachmentEpoch"`
}
type registryPayload struct {
	Sessions []sessionRecord `json:"sessions"`
}
type registryDocument struct {
	Version  int             `json:"version"`
	Checksum string          `json:"checksum"`
	Payload  registryPayload `json:"payload"`
}

type ledgerRecord struct {
	CommandID            string                              `json:"commandId"`
	Digest               string                              `json:"digest"`
	Operation            string                              `json:"operation"`
	RequestID            string                              `json:"requestId,omitempty"`
	HarnessID            string                              `json:"harnessId,omitempty"`
	ProviderSessionID    string                              `json:"providerSessionId,omitempty"`
	Workspace            string                              `json:"workspace,omitempty"`
	HostHarnessSessionID string                              `json:"hostHarnessSessionId,omitempty"`
	AttachmentEpoch      int64                               `json:"attachmentEpoch,omitempty"`
	State                string                              `json:"state"`
	Acknowledged         bool                                `json:"acknowledged,omitempty"`
	Result               *protocol.HostSessionControlMessage `json:"result,omitempty"`
	UpdatedAt            string                              `json:"updatedAt"`
}
type ledgerPayload struct {
	Commands []ledgerRecord `json:"commands"`
}
type ledgerDocument struct {
	Version  int           `json:"version"`
	Checksum string        `json:"checksum"`
	Payload  ledgerPayload `json:"payload"`
}

type forgetTransactionPayload struct {
	Session sessionRecord `json:"session"`
}
type forgetTransactionDocument struct {
	Version  int                      `json:"version"`
	Checksum string                   `json:"checksum"`
	Payload  forgetTransactionPayload `json:"payload"`
}

func checksum(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:]), nil
}

func saveRegistry(dataRoot string, records map[string]*sessionRecord) error {
	payload := registryPayload{Sessions: make([]sessionRecord, 0, len(records))}
	for _, record := range records {
		payload.Sessions = append(payload.Sessions, *record)
	}
	sort.Slice(payload.Sessions, func(i, j int) bool {
		return payload.Sessions[i].Observation.HostHarnessSessionID < payload.Sessions[j].Observation.HostHarnessSessionID
	})
	digest, err := checksum(payload)
	if err != nil {
		return err
	}
	return atomicJSON(filepath.Join(dataRoot, registryName), registryDocument{Version: registryVersion, Checksum: digest, Payload: payload})
}

func saveLedger(dataRoot string, records map[string]*ledgerRecord) error {
	payload := ledgerPayload{Commands: make([]ledgerRecord, 0, len(records))}
	for _, record := range records {
		payload.Commands = append(payload.Commands, *record)
	}
	sort.Slice(payload.Commands, func(i, j int) bool { return payload.Commands[i].CommandID < payload.Commands[j].CommandID })
	digest, err := checksum(payload)
	if err != nil {
		return err
	}
	return atomicJSON(filepath.Join(dataRoot, ledgerName), ledgerDocument{Version: ledgerVersion, Checksum: digest, Payload: payload})
}

func saveForgetTransaction(dataRoot string, record *sessionRecord) error {
	payload := forgetTransactionPayload{Session: *cloneSession(record)}
	digest, err := checksum(payload)
	if err != nil {
		return err
	}
	return atomicJSON(filepath.Join(dataRoot, forgetTransactionName), forgetTransactionDocument{Version: forgetTransactionVersion, Checksum: digest, Payload: payload})
}

func loadForgetTransaction(dataRoot string) (*sessionRecord, error) {
	var document forgetTransactionDocument
	if err := decodeDocument(filepath.Join(dataRoot, forgetTransactionName), &document); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("forget transaction unavailable; preserve %s for repair: %w", forgetTransactionName, err)
	}
	if document.Version != forgetTransactionVersion {
		return nil, fmt.Errorf("forget transaction version %d is unsupported; preserve evidence", document.Version)
	}
	digest, _ := checksum(document.Payload)
	if digest != document.Checksum {
		return nil, fmt.Errorf("forget transaction checksum mismatch; preserve evidence")
	}
	record := cloneSession(&document.Payload.Session)
	if err := validateSessionRecord(record); err != nil || record.Observation.Status != "closed" {
		return nil, fmt.Errorf("forget transaction contains an ineligible session")
	}
	return record, nil
}

// recoverForgetTransaction completes the idempotent second half of a staged forget before the
// registry and ledger are cross-validated. The durable intent makes every intermediate cut
// distinguishable from corruption and prevents either file from being interpreted in isolation.
func recoverForgetTransaction(dataRoot string) error {
	record, err := loadForgetTransaction(dataRoot)
	if err != nil || record == nil {
		return err
	}
	sessions, err := loadRegistry(dataRoot)
	if err != nil {
		return err
	}
	commands, err := loadLedger(dataRoot)
	if err != nil {
		return err
	}
	id := record.Observation.HostHarnessSessionID
	if current := sessions[id]; current != nil && !sameSessionRecord(current, record) {
		return fmt.Errorf("forget transaction conflicts with the durable session record")
	}
	for _, command := range commands {
		if ledgerSessionID(command) == id && (command.State != "completed" || !command.Acknowledged) {
			return fmt.Errorf("forget transaction conflicts with unacknowledged command evidence")
		}
	}
	delete(sessions, id)
	if err := saveRegistry(dataRoot, sessions); err != nil {
		return fmt.Errorf("complete forget registry removal: %w", err)
	}
	for commandID, command := range commands {
		if ledgerSessionID(command) == id {
			delete(commands, commandID)
		}
	}
	if err := saveLedger(dataRoot, commands); err != nil {
		return fmt.Errorf("complete forget ledger removal: %w", err)
	}
	return removeDurableFile(filepath.Join(dataRoot, forgetTransactionName))
}

func ledgerSessionID(command *ledgerRecord) string {
	if command == nil {
		return ""
	}
	if command.HostHarnessSessionID != "" {
		return command.HostHarnessSessionID
	}
	if command.Result != nil && command.Result.Session != nil {
		return command.Result.Session.HostHarnessSessionID
	}
	return ""
}

func removeDurableFile(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	directory, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func atomicJSON(destination string, value any) error {
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return fmt.Errorf("encode durable host-session state: %w", err)
	}
	encoded = append(encoded, '\n')
	if len(encoded) > maximumDurableDocumentBytes {
		return fmt.Errorf("durable host-session state exceeds the 16 MiB safety bound")
	}
	directory := filepath.Dir(destination)
	temporary, err := os.CreateTemp(directory, ".host-session-*")
	if err != nil {
		return fmt.Errorf("create durable host-session temporary file: %w", err)
	}
	temporaryPath := temporary.Name()
	cleanup := func() { _ = temporary.Close(); _ = os.Remove(temporaryPath) }
	if err := temporary.Chmod(0o600); err != nil {
		cleanup()
		return err
	}
	if _, err := temporary.Write(encoded); err != nil {
		cleanup()
		return fmt.Errorf("write durable host-session state: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		cleanup()
		return fmt.Errorf("sync durable host-session state: %w", err)
	}
	if err := temporary.Close(); err != nil {
		_ = os.Remove(temporaryPath)
		return fmt.Errorf("close durable host-session state: %w", err)
	}
	if err := os.Rename(temporaryPath, destination); err != nil {
		_ = os.Remove(temporaryPath)
		return fmt.Errorf("replace durable host-session state: %w", err)
	}
	dir, err := os.Open(directory)
	if err != nil {
		return fmt.Errorf("open durable host-session directory: %w", err)
	}
	defer dir.Close()
	if err := dir.Sync(); err != nil {
		return fmt.Errorf("sync durable host-session directory: %w", err)
	}
	return nil
}

func loadRegistry(dataRoot string) (map[string]*sessionRecord, error) {
	var document registryDocument
	if err := decodeDocument(filepath.Join(dataRoot, registryName), &document); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return map[string]*sessionRecord{}, nil
		}
		return nil, fmt.Errorf("registry unavailable; preserve %s for repair: %w", registryName, err)
	}
	if document.Version != registryVersion {
		return nil, fmt.Errorf("registry version %d is unsupported; preserve evidence", document.Version)
	}
	digest, _ := checksum(document.Payload)
	if digest != document.Checksum {
		return nil, fmt.Errorf("registry checksum mismatch; preserve evidence")
	}
	records := make(map[string]*sessionRecord, len(document.Payload.Sessions))
	providers := map[string]bool{}
	for index := range document.Payload.Sessions {
		record := document.Payload.Sessions[index]
		if err := validateSessionRecord(&record); err != nil {
			return nil, fmt.Errorf("registry record is malformed: %w", err)
		}
		id := record.Observation.HostHarnessSessionID
		provider := providerKey(record.Observation.HarnessID, record.Observation.ProviderSessionID, record.Observation.Workspace)
		if records[id] != nil || providers[provider] {
			return nil, fmt.Errorf("registry contains conflicting or malformed identity")
		}
		copy := record
		records[id] = &copy
		providers[provider] = true
	}
	return records, nil
}

func validateSessionRecord(record *sessionRecord) error {
	if record == nil || !sortedVocabulary(record.LifecycleOperations, LifecycleOperations) {
		return ErrInvalidObservation
	}
	projection := protocol.HostHarnessSession{HostHarnessSessionObservation: record.Observation, AttachedThreadID: record.AttachedThreadID, ActiveRunID: record.ActiveRunID, AttachmentEpoch: record.AttachmentEpoch}
	return projection.Validate()
}

func loadLedger(dataRoot string) (map[string]*ledgerRecord, error) {
	var document ledgerDocument
	if err := decodeDocument(filepath.Join(dataRoot, ledgerName), &document); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return map[string]*ledgerRecord{}, nil
		}
		return nil, fmt.Errorf("command ledger unavailable; preserve %s for repair: %w", ledgerName, err)
	}
	if document.Version != ledgerVersion {
		return nil, fmt.Errorf("command ledger version %d is unsupported; preserve evidence", document.Version)
	}
	digest, _ := checksum(document.Payload)
	if digest != document.Checksum {
		return nil, fmt.Errorf("command ledger checksum mismatch; preserve evidence")
	}
	records := make(map[string]*ledgerRecord, len(document.Payload.Commands))
	for index := range document.Payload.Commands {
		record := document.Payload.Commands[index]
		digest, digestErr := hex.DecodeString(record.Digest)
		_, timeErr := time.Parse(time.RFC3339Nano, record.UpdatedAt)
		if record.CommandID == "" || len(record.CommandID) > protocol.HostHarnessSessionLimits.IdentifierBytes || digestErr != nil || len(digest) != sha256.Size ||
			!supports(protocol.HostHarnessSessionCommandOperations, record.Operation) || (record.State != "pending" && record.State != "completed" && record.State != "uncertain") || records[record.CommandID] != nil || timeErr != nil ||
			(record.Acknowledged && record.State != "completed") || (record.State == "pending" && record.Result != nil) || (record.State != "pending" && record.Result == nil) {
			return nil, fmt.Errorf("command ledger record is malformed or conflicting")
		}
		if record.Result != nil {
			encoded, err := json.Marshal(record.Result)
			if err != nil {
				return nil, fmt.Errorf("command ledger result is malformed")
			}
			decoded, err := protocol.DecodeHostSessionControlMessage(encoded, "6")
			if err != nil || decoded.Type != "host-session.command.result" || decoded.CommandID != record.CommandID || decoded.CommandDigest != record.Digest || decoded.Operation != record.Operation ||
				(record.State == "completed" && decoded.Outcome == "uncertain") || (record.State == "uncertain" && decoded.Outcome != "uncertain") {
				return nil, fmt.Errorf("command ledger result is malformed or conflicts with its record")
			}
		}
		copy := record
		records[record.CommandID] = &copy
	}
	return records, nil
}

func decodeDocument(path string, target any) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if info.Size() > maximumDurableDocumentBytes {
		return fmt.Errorf("durable document exceeds the 16 MiB safety bound")
	}
	decoder := json.NewDecoder(io.LimitReader(file, maximumDurableDocumentBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return fmt.Errorf("durable document contains trailing data")
	}
	return nil
}
