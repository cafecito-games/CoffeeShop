package hostsession

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/harness"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

type Options struct {
	NodeID, DataRoot string
	WorkspaceRoots   []string
	Drivers          []Driver
	Clock            Clock
	IDs              IDGenerator
	Barrier          DurabilityBarrier
	MaximumCommands  int
	MaximumSessions  int
}

type CommandResponse struct {
	Ack    protocol.HostSessionControlMessage
	Result protocol.HostSessionControlMessage
	Events []protocol.HarnessEvent
	Err    error
}

type Supervisor struct {
	nodeID, dataRoot string
	workspaceRoots   []string
	drivers          map[string]Driver
	clock            Clock
	ids              IDGenerator
	barrier          DurabilityBarrier
	maximumCommands  int
	maximumSessions  int

	mu             sync.Mutex
	sessions       map[string]*sessionRecord
	providers      map[string]string
	commands       map[string]*ledgerRecord
	activeCommands map[string]bool
	forgetLock     chan struct{}
	locks          map[string]chan struct{}
	handles        map[string]operationHandleRecord
	disabled       error
	shuttingDown   bool
	operations     sync.WaitGroup
	operationRoot  context.Context
	cancel         context.CancelFunc
}

type operationHandleRecord struct {
	SessionID   string
	Revision    int64
	Fingerprint string
}

type wallClock struct{}

func (wallClock) Now() time.Time { return time.Now().UTC() }

type randomIDs struct{}

func (randomIDs) NewID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return "hs-" + hex.EncodeToString(value), nil
}

func New(options Options) (*Supervisor, error) {
	if options.NodeID == "" || options.DataRoot == "" || !filepath.IsAbs(options.DataRoot) || len(options.WorkspaceRoots) == 0 {
		return nil, fmt.Errorf("host session node, absolute data root, and workspace roots are required")
	}
	if options.Clock == nil {
		options.Clock = wallClock{}
	}
	if options.IDs == nil {
		options.IDs = randomIDs{}
	}
	if options.MaximumCommands <= 0 {
		options.MaximumCommands = 1024
	}
	if options.MaximumCommands > 1024 {
		return nil, fmt.Errorf("maximum host session commands exceeds the durable ledger bound")
	}
	if options.MaximumSessions <= 0 {
		options.MaximumSessions = protocol.HostHarnessSessionLimits.SessionsPerGeneration
	}
	if err := os.MkdirAll(options.DataRoot, 0o700); err != nil {
		return nil, fmt.Errorf("create host session data root: %w", err)
	}
	drivers := make(map[string]Driver, len(options.Drivers))
	for _, driver := range options.Drivers {
		if driver == nil || !supports(protocol.HarnessIDs, driver.HarnessID()) || drivers[driver.HarnessID()] != nil {
			return nil, fmt.Errorf("host session driver identity is missing, unknown, or duplicated")
		}
		if err := validateCapabilities(driver.Capabilities()); err != nil {
			return nil, fmt.Errorf("driver %s capabilities: %w", driver.HarnessID(), err)
		}
		drivers[driver.HarnessID()] = driver
	}
	root, cancel := context.WithCancel(context.Background())
	supervisor := &Supervisor{nodeID: options.NodeID, dataRoot: options.DataRoot, workspaceRoots: append([]string(nil), options.WorkspaceRoots...), drivers: drivers,
		clock: options.Clock, ids: options.IDs, barrier: options.Barrier, maximumCommands: options.MaximumCommands, maximumSessions: options.MaximumSessions,
		locks: map[string]chan struct{}{}, handles: map[string]operationHandleRecord{}, activeCommands: map[string]bool{}, forgetLock: make(chan struct{}, 1), operationRoot: root, cancel: cancel}
	recoveryErr := recoverForgetTransaction(options.DataRoot)
	sessions, registryErr := loadRegistry(options.DataRoot)
	commands, ledgerErr := loadLedger(options.DataRoot)
	if recoveryErr != nil || registryErr != nil || ledgerErr != nil {
		supervisor.sessions, supervisor.commands, supervisor.providers = map[string]*sessionRecord{}, map[string]*ledgerRecord{}, map[string]string{}
		supervisor.disabled = errors.Join(recoveryErr, registryErr, ledgerErr)
		return supervisor, nil
	}
	supervisor.sessions, supervisor.commands, supervisor.providers = sessions, commands, map[string]string{}
	if len(commands) > supervisor.maximumCommands {
		supervisor.disabled = fmt.Errorf("command ledger exceeds configured safe capacity; preserve evidence")
	}
	for id, record := range sessions {
		supervisor.providers[providerKey(record.Observation.HarnessID, record.Observation.ProviderSessionID, record.Observation.Workspace)] = id
	}
	changed := false
	for _, command := range commands {
		if command.HostHarnessSessionID != "" && sessions[command.HostHarnessSessionID] == nil {
			supervisor.disabled = fmt.Errorf("command ledger references an unknown session; preserve evidence")
		}
		if command.State == "pending" {
			command.State = "uncertain"
			result := supervisor.uncertainResult(*command, "recovery-required", "provider effect cannot be proven absent after restart")
			command.Result = &result
			command.UpdatedAt = supervisor.now()
			changed = true
		}
	}
	if supervisor.disabled == nil && changed {
		if err := saveLedger(supervisor.dataRoot, supervisor.commands); err != nil {
			supervisor.disabled = err
		}
	}
	return supervisor, nil
}

func (supervisor *Supervisor) Usable() (bool, string) {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	if supervisor.disabled == nil {
		return true, ""
	}
	return false, boundedDiagnostic(supervisor.disabled.Error())
}

func (supervisor *Supervisor) Snapshot() []protocol.HostHarnessSessionObservation {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	result := make([]protocol.HostHarnessSessionObservation, 0, len(supervisor.sessions))
	for _, record := range supervisor.sessions {
		result = append(result, record.Observation)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].HostHarnessSessionID < result[j].HostHarnessSessionID })
	return result
}

func (supervisor *Supervisor) Session(id string) protocol.HostHarnessSession {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	record := supervisor.sessions[id]
	if record == nil {
		return protocol.HostHarnessSession{}
	}
	return protocol.HostHarnessSession{HostHarnessSessionObservation: record.Observation, AttachedThreadID: record.AttachedThreadID, ActiveRunID: record.ActiveRunID, AttachmentEpoch: record.AttachmentEpoch}
}

func (supervisor *Supervisor) Execute(_ context.Context, message protocol.HostSessionHubMessage) CommandResponse {
	if err := supervisor.validateCommand(message); err != nil {
		return CommandResponse{Err: err}
	}
	operation := commandOperation(message.Type)
	if operation == "" {
		return CommandResponse{Err: ErrUnsupportedCapability}
	}
	supervisor.mu.Lock()
	if err := supervisor.admissionErrorLocked(); err != nil {
		supervisor.mu.Unlock()
		return CommandResponse{Err: err}
	}
	if existing := supervisor.commands[message.CommandID]; existing != nil {
		response := supervisor.replayLocked(message, existing)
		supervisor.mu.Unlock()
		return response
	}
	var release func()
	if message.HostHarnessSessionID != "" {
		var err error
		release, err = supervisor.trySessionLockLocked(message.HostHarnessSessionID)
		if err != nil {
			supervisor.mu.Unlock()
			return CommandResponse{Err: err}
		}
	} else {
		var err error
		release, err = supervisor.trySessionLockLocked("host-session-creation")
		if err != nil {
			supervisor.mu.Unlock()
			return CommandResponse{Err: err}
		}
	}
	supervisor.operations.Add(1)
	supervisor.mu.Unlock()
	defer supervisor.operations.Done()
	if release != nil {
		defer release()
	}
	return supervisor.executeNew(message, operation)
}

func (supervisor *Supervisor) executeNew(message protocol.HostSessionHubMessage, operation string) CommandResponse {
	var record *sessionRecord
	var driver Driver
	if message.HostHarnessSessionID != "" {
		supervisor.mu.Lock()
		record = cloneSession(supervisor.sessions[message.HostHarnessSessionID])
		supervisor.mu.Unlock()
		if record == nil {
			return CommandResponse{Err: fmt.Errorf("host session does not exist")}
		}
		if err := checkEpoch(message.AttachmentEpoch, record.AttachmentEpoch); err != nil {
			return CommandResponse{Err: err}
		}
		driver = supervisor.drivers[record.Observation.HarnessID]
		if driver == nil || !supervisor.supportsSessionOperation(record, operation) {
			return CommandResponse{Err: ErrUnsupportedCapability}
		}
		if _, err := supervisor.authorize(record.Observation.Workspace); err != nil {
			return CommandResponse{Err: err}
		}
		if err := preflightExisting(message, record, operation); err != nil {
			return CommandResponse{Err: err}
		}
	} else {
		driver = supervisor.drivers[message.HarnessID]
		if driver == nil || !supports(driver.Capabilities().DriverOperations, operation) {
			return CommandResponse{Err: ErrUnsupportedCapability}
		}
		if operation == "adopt" && !supports(driver.Capabilities().LifecycleOperations, "inspect") {
			return CommandResponse{Err: ErrUnsupportedCapability}
		}
		if _, err := supervisor.authorize(message.Workspace); err != nil {
			return CommandResponse{Err: err}
		}
		supervisor.mu.Lock()
		full := len(supervisor.sessions) >= supervisor.maximumSessions
		supervisor.mu.Unlock()
		if full {
			return CommandResponse{Err: fmt.Errorf("host session retention limit reached")}
		}
	}
	pending := &ledgerRecord{CommandID: message.CommandID, Digest: message.CommandDigest, Operation: operation, RequestID: message.RequestID,
		HarnessID: message.HarnessID, ProviderSessionID: message.ProviderSessionID, Workspace: message.Workspace,
		HostHarnessSessionID: message.HostHarnessSessionID, State: "pending", UpdatedAt: supervisor.now()}
	if message.AttachmentEpoch != nil {
		pending.AttachmentEpoch = *message.AttachmentEpoch
	}
	supervisor.mu.Lock()
	if existing := supervisor.commands[message.CommandID]; existing != nil {
		response := supervisor.replayLocked(message, existing)
		supervisor.mu.Unlock()
		return response
	}
	previousCommands := cloneCommands(supervisor.commands)
	if !supervisor.ensureCommandCapacityLocked() {
		supervisor.mu.Unlock()
		return CommandResponse{Err: ErrCommandCapacity}
	}
	supervisor.commands[message.CommandID] = pending
	if err := saveLedger(supervisor.dataRoot, supervisor.commands); err != nil {
		supervisor.commands = previousCommands
		supervisor.mu.Unlock()
		return CommandResponse{Err: fmt.Errorf("persist command before provider effect: %w", err)}
	}
	supervisor.activeCommands[message.CommandID] = true
	supervisor.mu.Unlock()
	defer func() {
		supervisor.mu.Lock()
		delete(supervisor.activeCommands, message.CommandID)
		supervisor.mu.Unlock()
	}()
	ack := supervisor.ack(message, operation, "recorded")
	if err := supervisor.reach(BarrierAfterPending); err != nil {
		return CommandResponse{Ack: ack, Err: err}
	}
	if operation == "attach" || operation == "detach" {
		return supervisor.executeAttachment(message, record, pending, ack)
	}
	if operation == "create" || operation == "adopt" {
		return supervisor.executeCreation(message, driver, pending, ack)
	}
	return supervisor.executeDriverMutation(message, operation, driver, record, pending, ack)
}

func (supervisor *Supervisor) executeAttachment(message protocol.HostSessionHubMessage, record *sessionRecord, pending *ledgerRecord, ack protocol.HostSessionControlMessage) CommandResponse {
	expected := cloneSession(record)
	if pending.Operation == "attach" {
		if terminalStatus(record.Observation.Status) || record.Observation.Status != message.ExpectedStatus || record.AttachedThreadID != "" && record.AttachedThreadID != message.ThreadID {
			return supervisor.completeRejected(message, pending, ack, "attachment-conflict", "attachment identity or expected status does not match")
		}
		record.AttachedThreadID = message.ThreadID
	} else {
		if record.AttachedThreadID != message.ThreadID {
			return supervisor.completeRejected(message, pending, ack, "attachment-conflict", "attachment identity does not match")
		}
		record.AttachedThreadID, record.ActiveRunID = "", ""
	}
	record.AttachmentEpoch++
	record.Observation.Revision++
	record.Observation.UpdatedAt = supervisor.now()
	return supervisor.commitSuccessFenced(message, pending, ack, record, "", nil, expected)
}

func (supervisor *Supervisor) executeCreation(message protocol.HostSessionHubMessage, driver Driver, pending *ledgerRecord, ack protocol.HostSessionControlMessage) CommandResponse {
	var provider ProviderSession
	var err error
	if pending.Operation == "create" {
		provider, err = driver.Create(supervisor.operationRoot, CreateRequest{Workspace: message.Workspace, Model: message.Model})
	} else {
		if !supports(driver.Capabilities().LifecycleOperations, "inspect") {
			return supervisor.completeRejected(message, pending, ack, "unsupported-capability", ErrUnsupportedCapability.Error())
		}
		inspected, inspectErr := driver.Inspect(supervisor.operationRoot, SessionRequest{ProviderSessionID: message.ProviderSessionID, Workspace: message.Workspace})
		if inspectErr != nil {
			return supervisor.completeDriverFailure(message, pending, ack, inspectErr)
		}
		if inspectErr = validateProviderCapabilities(driver, inspected); inspectErr != nil {
			return supervisor.completeRejected(message, pending, ack, "invalid-provider-capability", inspectErr.Error())
		}
		if _, inspectErr = supervisor.recordFromProvider("inspection", driver.HarnessID(), inspected, nil); inspectErr != nil {
			return supervisor.completeRejected(message, pending, ack, "invalid-provider-observation", inspectErr.Error())
		}
		if inspected.ProviderSessionID != message.ProviderSessionID || inspected.Workspace != message.Workspace {
			return supervisor.completeRejected(message, pending, ack, "provider-identity-mismatch", "provider inspection did not prove the requested identity")
		}
		if _, inspectErr = supervisor.authorize(inspected.Workspace); inspectErr != nil {
			return supervisor.completeRejected(message, pending, ack, "workspace-drift", inspectErr.Error())
		}
		provider, err = driver.Adopt(supervisor.operationRoot, AdoptRequest{ProviderSessionID: message.ProviderSessionID, Workspace: message.Workspace})
	}
	if err != nil {
		return supervisor.completeDriverFailure(message, pending, ack, err)
	}
	if err := supervisor.reach(BarrierAfterEffect); err != nil {
		return CommandResponse{Ack: ack, Err: err}
	}
	if provider.Workspace != message.Workspace || pending.Operation == "adopt" && provider.ProviderSessionID != message.ProviderSessionID {
		return supervisor.completeUncertain(message, pending, ack, "provider-identity-mismatch", "provider observation did not prove the requested identity")
	}
	canonical, err := supervisor.authorize(provider.Workspace)
	if err != nil {
		return supervisor.completeUncertain(message, pending, ack, "workspace-drift", err.Error())
	}
	provider.Workspace = canonical
	id, err := supervisor.ids.NewID()
	if err != nil {
		return supervisor.completeUncertain(message, pending, ack, "identity-generation-failed", "could not mint host session identity")
	}
	if err := validateProviderCapabilities(driver, provider); err != nil {
		return supervisor.completeUncertain(message, pending, ack, "invalid-provider-capability", err.Error())
	}
	record, err := supervisor.recordFromProvider(id, driver.HarnessID(), provider, nil)
	if err != nil {
		return supervisor.completeUncertain(message, pending, ack, "invalid-provider-observation", err.Error())
	}
	return supervisor.commitSuccess(message, pending, ack, record, provider.ProviderTurnID, nil)
}

func (supervisor *Supervisor) executeDriverMutation(message protocol.HostSessionHubMessage, operation string, driver Driver, record *sessionRecord, pending *ledgerRecord, ack protocol.HostSessionControlMessage) CommandResponse {
	beforeEffect := cloneSession(record)
	if operation == "start-turn" {
		if record.AttachedThreadID == "" || record.Observation.Status != "idle" {
			return supervisor.completeRejected(message, pending, ack, "illegal-state", "session is not attached and idle")
		}
		record.ActiveRunID = message.RunID
		if err := supervisor.saveSession(record); err != nil {
			return supervisor.completeUncertain(message, pending, ack, "pre-effect-persist-failed", err.Error())
		}
	}
	handle, handleErr := supervisor.issueHandle(record.Observation.HostHarnessSessionID)
	if handleErr != nil {
		if operation == "start-turn" {
			if restoreErr := supervisor.restoreSession(record.Observation.HostHarnessSessionID, record, beforeEffect); restoreErr != nil {
				return supervisor.completeUncertain(message, pending, ack, "pre-effect-restore-failed", restoreErr.Error())
			}
		}
		return supervisor.completeRejected(message, pending, ack, "handle-generation-failed", "could not issue provider operation handle")
	}
	defer supervisor.retireHandle(handle)
	request := SessionRequest{Handle: handle, ProviderSessionID: record.Observation.ProviderSessionID, Workspace: record.Observation.Workspace}
	var outcome DriverOutcome
	var err error
	switch operation {
	case "start-turn":
		outcome, err = driver.StartTurn(supervisor.operationRoot, TurnRequest{SessionRequest: request, RunID: message.RunID, Prompt: message.Prompt})
	case "steer":
		outcome, err = driver.Steer(supervisor.operationRoot, SteerRequest{SessionRequest: request, RunID: message.RunID, ProviderTurnID: message.ProviderTurnID, Text: message.Text})
	case "interrupt":
		outcome, err = driver.Interrupt(supervisor.operationRoot, TurnControlRequest{SessionRequest: request, RunID: message.RunID, ProviderTurnID: message.ProviderTurnID})
	case "resolve-approval":
		outcome, err = driver.DecideApproval(supervisor.operationRoot, ApprovalRequest{SessionRequest: request, RunID: message.RunID, ProviderTurnID: message.ProviderTurnID, Decision: *message.Decision})
	case "close":
		outcome, err = driver.Close(supervisor.operationRoot, request)
	default:
		return supervisor.completeRejected(message, pending, ack, "unsupported-capability", ErrUnsupportedCapability.Error())
	}
	if err != nil {
		supervisor.retireHandle(handle)
		if operation == "start-turn" && !isOutcomeUncertain(err) {
			if restoreErr := supervisor.restoreSession(record.Observation.HostHarnessSessionID, record, beforeEffect); restoreErr != nil {
				return supervisor.completeUncertain(message, pending, ack, "pre-effect-restore-failed", restoreErr.Error())
			}
		}
		return supervisor.completeDriverFailure(message, pending, ack, err)
	}
	supervisor.retireHandle(handle)
	if err := supervisor.reach(BarrierAfterEffect); err != nil {
		return CommandResponse{Ack: ack, Err: err}
	}
	supervisor.mu.Lock()
	latest := cloneSession(supervisor.sessions[record.Observation.HostHarnessSessionID])
	supervisor.mu.Unlock()
	if latest == nil {
		latest = record
	}
	if err := validateProviderCapabilities(driver, outcome.Session); err != nil {
		return supervisor.completeUncertain(message, pending, ack, "invalid-provider-capability", err.Error())
	}
	if operation == "close" && outcome.Session.Status != "closed" {
		return supervisor.completeUncertain(message, pending, ack, "invalid-close-outcome", "provider did not conclusively close the session")
	}
	if len(outcome.Events) > MaximumOutcomeEvents {
		return supervisor.completeUncertain(message, pending, ack, "too-many-provider-events", "provider outcome exceeded the event count bound")
	}
	updated, err := supervisor.recordDriverOutcome(record.Observation.HostHarnessSessionID, record.Observation.HarnessID, operation, outcome, latest)
	if err != nil {
		return supervisor.completeUncertain(message, pending, ack, "invalid-provider-observation", err.Error())
	}
	if operation == "start-turn" && updated.Observation.Status != "running" {
		updated.ActiveRunID = ""
	}
	if err := validateEvents(outcome.Events, message.RunID); err != nil {
		return supervisor.completeUncertain(message, pending, ack, "invalid-provider-event", err.Error())
	}
	return supervisor.commitSuccess(message, pending, ack, updated, outcome.ProviderTurnID, outcome.Events)
}

func (supervisor *Supervisor) commitSuccess(message protocol.HostSessionHubMessage, command *ledgerRecord, ack protocol.HostSessionControlMessage, record *sessionRecord, providerTurnID string, events []protocol.HarnessEvent) CommandResponse {
	return supervisor.commitSuccessFenced(message, command, ack, record, providerTurnID, events, nil)
}

func (supervisor *Supervisor) commitSuccessFenced(message protocol.HostSessionHubMessage, command *ledgerRecord, ack protocol.HostSessionControlMessage, record *sessionRecord, providerTurnID string, events []protocol.HarnessEvent, expected *sessionRecord) CommandResponse {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	if expected != nil && !sameSessionRecord(supervisor.sessions[record.Observation.HostHarnessSessionID], expected) {
		return supervisor.completeRejectedLocked(message, command, ack, "attachment-conflict", "session changed after attachment preflight")
	}
	return supervisor.commitSuccessLocked(message, command, ack, record, providerTurnID, events)
}

func (supervisor *Supervisor) commitReconciledSuccess(message protocol.HostSessionHubMessage, command *ledgerRecord, ack protocol.HostSessionControlMessage, record *sessionRecord, providerTurnID string, events []protocol.HarnessEvent, expected *sessionRecord) CommandResponse {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	if expected != nil && !sameSessionRecord(supervisor.sessions[record.Observation.HostHarnessSessionID], expected) {
		return supervisor.completeUncertainLocked(message, command, ack, "reconciliation-conflict", "session changed while provider reconciliation settled")
	}
	return supervisor.commitSuccessLocked(message, command, ack, record, providerTurnID, events)
}

func (supervisor *Supervisor) commitSuccessLocked(message protocol.HostSessionHubMessage, command *ledgerRecord, ack protocol.HostSessionControlMessage, record *sessionRecord, providerTurnID string, events []protocol.HarnessEvent) CommandResponse {
	key := providerKey(record.Observation.HarnessID, record.Observation.ProviderSessionID, record.Observation.Workspace)
	if existing := supervisor.providers[key]; existing != "" && existing != record.Observation.HostHarnessSessionID {
		return supervisor.completeUncertainLocked(message, command, ack, "provider-identity-conflict", ErrIdentityConflict.Error())
	}
	previous := cloneSession(supervisor.sessions[record.Observation.HostHarnessSessionID])
	previousProvider := supervisor.providers[key]
	if previous != nil && providerKey(previous.Observation.HarnessID, previous.Observation.ProviderSessionID, previous.Observation.Workspace) != key {
		return supervisor.completeUncertainLocked(message, command, ack, "host-session-identity-conflict", ErrIdentityConflict.Error())
	}
	supervisor.sessions[record.Observation.HostHarnessSessionID] = cloneSession(record)
	supervisor.providers[key] = record.Observation.HostHarnessSessionID
	if err := saveRegistry(supervisor.dataRoot, supervisor.sessions); err != nil {
		if previous == nil {
			delete(supervisor.sessions, record.Observation.HostHarnessSessionID)
		} else {
			supervisor.sessions[record.Observation.HostHarnessSessionID] = previous
		}
		if previousProvider == "" {
			delete(supervisor.providers, key)
		} else {
			supervisor.providers[key] = previousProvider
		}
		return supervisor.completeUncertainLocked(message, command, ack, "registry-persist-failed", err.Error())
	}
	if err := supervisor.reach(BarrierAfterRegistry); err != nil {
		return CommandResponse{Ack: ack, Err: err}
	}
	if command.Operation != "start-turn" {
		providerTurnID = ""
	}
	result := supervisor.result(message, command.Operation, "succeeded", "", "", providerTurnID, &record.Observation)
	command.State, command.Result, command.UpdatedAt = "completed", &result, supervisor.now()
	if err := saveLedger(supervisor.dataRoot, supervisor.commands); err != nil {
		command.State = "uncertain"
		uncertain := supervisor.uncertainResult(*command, "outcome-persist-failed", "provider effect may have completed; manual reconciliation is required")
		command.Result = &uncertain
		_ = saveLedger(supervisor.dataRoot, supervisor.commands)
		return CommandResponse{Ack: ack, Result: *command.Result, Err: fmt.Errorf("persist completed provider outcome: %w", err)}
	}
	return CommandResponse{Ack: ack, Result: result, Events: append([]protocol.HarnessEvent(nil), events...)}
}

func (supervisor *Supervisor) saveSession(record *sessionRecord) error {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	previous := cloneSession(supervisor.sessions[record.Observation.HostHarnessSessionID])
	supervisor.sessions[record.Observation.HostHarnessSessionID] = cloneSession(record)
	if err := saveRegistry(supervisor.dataRoot, supervisor.sessions); err != nil {
		if previous == nil {
			delete(supervisor.sessions, record.Observation.HostHarnessSessionID)
		} else {
			supervisor.sessions[record.Observation.HostHarnessSessionID] = previous
		}
		return err
	}
	return nil
}

func (supervisor *Supervisor) saveSessionFenced(record, expected *sessionRecord) error {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	current := supervisor.sessions[record.Observation.HostHarnessSessionID]
	if !sameSessionRecord(current, expected) {
		return ErrInvalidObservation
	}
	previous := cloneSession(current)
	supervisor.sessions[record.Observation.HostHarnessSessionID] = cloneSession(record)
	if err := saveRegistry(supervisor.dataRoot, supervisor.sessions); err != nil {
		supervisor.sessions[record.Observation.HostHarnessSessionID] = previous
		return err
	}
	return nil
}

func (supervisor *Supervisor) recordDriverOutcome(id, harnessID, operation string, outcome DriverOutcome, previous *sessionRecord) (*sessionRecord, error) {
	provider := outcome.Session
	if provider.ProviderTurnID == "" {
		provider.ProviderTurnID = outcome.ProviderTurnID
	}
	if operation == "start-turn" {
		if provider.ProviderTurnID == "" {
			return nil, ErrInvalidObservation
		}
		if previous != nil && previous.Observation.Status == "idle" && provider.Status != "running" {
			running := provider
			running.Status = "running"
			intermediate, err := supervisor.recordFromProvider(id, harnessID, running, previous)
			if err != nil {
				return nil, err
			}
			if err := supervisor.saveSession(intermediate); err != nil {
				return nil, err
			}
			previous = intermediate
		}
	}
	return supervisor.recordFromProvider(id, harnessID, provider, previous)
}

func (supervisor *Supervisor) restoreSession(id string, expected, record *sessionRecord) error {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	current := supervisor.sessions[id]
	if current == nil || !sameSessionRecord(current, expected) {
		return ErrInvalidObservation
	}
	previous := cloneSession(current)
	supervisor.sessions[id] = cloneSession(record)
	if err := saveRegistry(supervisor.dataRoot, supervisor.sessions); err != nil {
		supervisor.sessions[id] = previous
		return err
	}
	return nil
}

func (supervisor *Supervisor) completeDriverFailure(message protocol.HostSessionHubMessage, command *ledgerRecord, ack protocol.HostSessionControlMessage, err error) CommandResponse {
	if isOutcomeUncertain(err) {
		return supervisor.completeUncertain(message, command, ack, "provider-outcome-uncertain", "provider operation ended without a conclusive outcome")
	}
	return supervisor.completeRejected(message, command, ack, "provider-rejected", "provider operation was rejected")
}
func (supervisor *Supervisor) completeRejected(message protocol.HostSessionHubMessage, command *ledgerRecord, ack protocol.HostSessionControlMessage, code, detail string) CommandResponse {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	return supervisor.completeRejectedLocked(message, command, ack, code, detail)
}
func (supervisor *Supervisor) completeRejectedLocked(message protocol.HostSessionHubMessage, command *ledgerRecord, ack protocol.HostSessionControlMessage, code, detail string) CommandResponse {
	result := supervisor.result(message, command.Operation, "rejected", code, detail, "", nil)
	command.State, command.Result, command.UpdatedAt = "completed", &result, supervisor.now()
	if err := saveLedger(supervisor.dataRoot, supervisor.commands); err != nil {
		command.State = "uncertain"
		uncertain := supervisor.uncertainResult(*command, "outcome-persist-failed", "command outcome could not be made durable; manual reconciliation is required")
		command.Result = &uncertain
		_ = saveLedger(supervisor.dataRoot, supervisor.commands)
		return CommandResponse{Ack: ack, Result: uncertain, Err: fmt.Errorf("persist rejected command outcome: %w", err)}
	}
	return CommandResponse{Ack: ack, Result: result, Err: fmt.Errorf("%s: %s", code, detail)}
}
func (supervisor *Supervisor) completeUncertain(message protocol.HostSessionHubMessage, command *ledgerRecord, ack protocol.HostSessionControlMessage, code, detail string) CommandResponse {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	return supervisor.completeUncertainLocked(message, command, ack, code, detail)
}
func (supervisor *Supervisor) completeUncertainLocked(message protocol.HostSessionHubMessage, command *ledgerRecord, ack protocol.HostSessionControlMessage, code, detail string) CommandResponse {
	result := supervisor.result(message, command.Operation, "uncertain", code, boundedDiagnostic(detail), "", nil)
	command.State, command.Result, command.UpdatedAt = "uncertain", &result, supervisor.now()
	_ = saveLedger(supervisor.dataRoot, supervisor.commands)
	return CommandResponse{Ack: ack, Result: result, Err: fmt.Errorf("%s: %s", code, boundedDiagnostic(detail))}
}

func (supervisor *Supervisor) Refresh(ctx context.Context, id string) error {
	supervisor.mu.Lock()
	if err := supervisor.admissionErrorLocked(); err != nil {
		supervisor.mu.Unlock()
		return err
	}
	release, err := supervisor.trySessionLockLocked(id)
	record := cloneSession(supervisor.sessions[id])
	if err == nil {
		supervisor.operations.Add(1)
	}
	supervisor.mu.Unlock()
	if err != nil {
		return err
	}
	defer supervisor.operations.Done()
	if record == nil {
		release()
		return fmt.Errorf("host session does not exist")
	}
	defer release()
	if _, err := supervisor.authorize(record.Observation.Workspace); err != nil {
		return err
	}
	driver := supervisor.drivers[record.Observation.HarnessID]
	if driver == nil || !supervisor.supportsSessionOperation(record, "refresh") {
		return ErrUnsupportedCapability
	}
	handle, err := supervisor.issueHandle(id)
	if err != nil {
		return err
	}
	defer supervisor.retireHandle(handle)
	provider, err := driver.Refresh(context.WithoutCancel(ctx), SessionRequest{Handle: handle, ProviderSessionID: record.Observation.ProviderSessionID, Workspace: record.Observation.Workspace})
	if err != nil {
		return err
	}
	supervisor.retireHandle(handle)
	if err := validateProviderCapabilities(driver, provider); err != nil {
		return err
	}
	supervisor.mu.Lock()
	latest := cloneSession(supervisor.sessions[id])
	supervisor.mu.Unlock()
	updated, err := supervisor.recordFromProvider(id, record.Observation.HarnessID, provider, latest)
	if err != nil {
		return err
	}
	return supervisor.saveSession(updated)
}

func (supervisor *Supervisor) Resume(ctx context.Context, id string) error {
	return supervisor.observeSession(ctx, id, "resume")
}

func (supervisor *Supervisor) Inspect(ctx context.Context, id string) error {
	return supervisor.observeSession(ctx, id, "inspect")
}

func (supervisor *Supervisor) observeSession(ctx context.Context, id, operation string) error {
	supervisor.mu.Lock()
	if err := supervisor.admissionErrorLocked(); err != nil {
		supervisor.mu.Unlock()
		return err
	}
	release, err := supervisor.trySessionLockLocked(id)
	record := cloneSession(supervisor.sessions[id])
	if err == nil {
		supervisor.operations.Add(1)
	}
	supervisor.mu.Unlock()
	if err != nil {
		return err
	}
	defer supervisor.operations.Done()
	if record == nil {
		release()
		return fmt.Errorf("host session does not exist")
	}
	defer release()
	if _, err := supervisor.authorize(record.Observation.Workspace); err != nil {
		return err
	}
	handle, err := supervisor.issueHandle(id)
	if err != nil {
		return err
	}
	defer supervisor.retireHandle(handle)
	request := SessionRequest{Handle: handle, ProviderSessionID: record.Observation.ProviderSessionID, Workspace: record.Observation.Workspace}
	driver := supervisor.drivers[record.Observation.HarnessID]
	if driver == nil || !supervisor.supportsSessionOperation(record, operation) {
		return ErrUnsupportedCapability
	}
	var provider ProviderSession
	if operation == "resume" {
		provider, err = driver.Resume(context.WithoutCancel(ctx), request)
	} else {
		provider, err = driver.Inspect(context.WithoutCancel(ctx), request)
	}
	if err != nil {
		return err
	}
	supervisor.retireHandle(handle)
	if err := validateProviderCapabilities(driver, provider); err != nil {
		return err
	}
	supervisor.mu.Lock()
	latest := cloneSession(supervisor.sessions[id])
	supervisor.mu.Unlock()
	updated, err := supervisor.recordFromProvider(id, record.Observation.HarnessID, provider, latest)
	if err != nil {
		return err
	}
	return supervisor.saveSession(updated)
}

// Reconcile asks the provider about an uncertain command without repeating that command's effect.
func (supervisor *Supervisor) Reconcile(ctx context.Context, commandID string) CommandResponse {
	supervisor.mu.Lock()
	if err := supervisor.admissionErrorLocked(); err != nil {
		supervisor.mu.Unlock()
		return CommandResponse{Err: err}
	}
	command := supervisor.commands[commandID]
	if command == nil || command.State == "completed" {
		supervisor.mu.Unlock()
		return CommandResponse{Err: fmt.Errorf("command is not uncertain")}
	}
	copy := *command
	record := cloneSession(supervisor.sessions[command.HostHarnessSessionID])
	driver := supervisor.drivers[command.HarnessID]
	if record != nil {
		driver = supervisor.drivers[record.Observation.HarnessID]
	}
	lockID := "host-session-creation"
	if record != nil {
		lockID = record.Observation.HostHarnessSessionID
	}
	release, lockErr := supervisor.trySessionLockLocked(lockID)
	if lockErr == nil {
		supervisor.operations.Add(1)
	}
	supervisor.mu.Unlock()
	if lockErr != nil {
		return CommandResponse{Err: lockErr}
	}
	defer release()
	defer supervisor.operations.Done()
	if copy.State == "pending" {
		supervisor.mu.Lock()
		current := supervisor.commands[commandID]
		if current != nil && current.State == "pending" {
			previous := cloneCommands(supervisor.commands)
			result := supervisor.uncertainResult(*current, "recovery-required", "provider effect cannot be proven absent after operation settlement")
			current.State, current.Result, current.UpdatedAt = "uncertain", &result, supervisor.now()
			if err := saveLedger(supervisor.dataRoot, supervisor.commands); err != nil {
				supervisor.commands = previous
				supervisor.mu.Unlock()
				return CommandResponse{Err: fmt.Errorf("persist reconciliation uncertainty: %w", err)}
			}
		}
		supervisor.mu.Unlock()
	}
	if driver == nil {
		return CommandResponse{Err: ErrUnsupportedCapability}
	}
	workspace, providerID := copy.Workspace, copy.ProviderSessionID
	if record != nil {
		workspace, providerID = record.Observation.Workspace, record.Observation.ProviderSessionID
	}
	canonicalWorkspace, err := supervisor.authorize(workspace)
	if err != nil {
		return CommandResponse{Err: err}
	}
	workspace = canonicalWorkspace
	if !supports(driver.Capabilities().LifecycleOperations, "reconcile") {
		return CommandResponse{Err: ErrUnsupportedCapability}
	}
	if record != nil {
		if !supervisor.supportsSessionOperation(record, "reconcile") || !supervisor.supportsSessionOperation(record, copy.Operation) {
			return CommandResponse{Err: ErrUnsupportedCapability}
		}
	} else if !supportsDriverOperation(driver.Capabilities(), copy.Operation) {
		return CommandResponse{Err: ErrUnsupportedCapability}
	}
	handle := OperationHandle{}
	if record != nil {
		handle, err = supervisor.issueHandle(record.Observation.HostHarnessSessionID)
		if err != nil {
			return CommandResponse{Err: err}
		}
	}
	reconciled, err := driver.Reconcile(context.WithoutCancel(ctx), ReconcileRequest{SessionRequest: SessionRequest{Handle: handle, ProviderSessionID: providerID, Workspace: workspace}, CommandID: commandID, Operation: copy.Operation})
	if handle.Token != "" {
		supervisor.retireHandle(handle)
	}
	if err != nil || !reconciled.Conclusive {
		if err == nil {
			err = fmt.Errorf("provider could not conclusively reconcile command")
		}
		return CommandResponse{Result: supervisor.uncertainResult(copy, "recovery-required", "provider effect cannot be proven absent"), Err: err}
	}
	provider := reconciled.Outcome.Session
	if provider.ProviderSessionID == "" {
		provider = reconciled.Session
	}
	canonicalProviderWorkspace, err := supervisor.authorize(provider.Workspace)
	if err != nil {
		return CommandResponse{Err: err}
	}
	provider.Workspace = canonicalProviderWorkspace
	workspaceDrift := (copy.Operation == "create" || copy.Operation == "adopt") && provider.Workspace != workspace
	providerDrift := copy.Operation == "adopt" && provider.ProviderSessionID != providerID
	if workspaceDrift || providerDrift {
		return CommandResponse{Err: ErrIdentityConflict}
	}
	if err := validateProviderCapabilities(driver, provider); err != nil {
		return CommandResponse{Err: err}
	}
	id := copy.HostHarnessSessionID
	var resolvedRelease func()
	if id == "" {
		supervisor.mu.Lock()
		id = supervisor.providers[providerKey(driver.HarnessID(), provider.ProviderSessionID, provider.Workspace)]
		if id != "" {
			resolvedRelease, err = supervisor.trySessionLockLocked(id)
			if err == nil {
				record = cloneSession(supervisor.sessions[id])
			}
		}
		supervisor.mu.Unlock()
		if err != nil {
			return CommandResponse{Err: err}
		}
		if resolvedRelease != nil {
			defer resolvedRelease()
			if record == nil {
				return CommandResponse{Err: ErrIdentityConflict}
			}
		}
		if id == "" {
			id, err = supervisor.ids.NewID()
			if err != nil {
				return CommandResponse{Err: err}
			}
		}
	} else {
		supervisor.mu.Lock()
		record = cloneSession(supervisor.sessions[id])
		supervisor.mu.Unlock()
		if record == nil {
			return CommandResponse{Err: ErrIdentityConflict}
		}
	}
	expected := cloneSession(record)
	effectiveOutcome := reconciled.Outcome
	effectiveOutcome.Session = provider
	runID := ""
	if record != nil {
		runID = record.ActiveRunID
	}
	if len(effectiveOutcome.Events) > MaximumOutcomeEvents {
		epoch := copy.AttachmentEpoch
		message := protocol.HostSessionHubMessage{NodeID: supervisor.nodeID, CommandID: copy.CommandID, CommandDigest: copy.Digest, RequestID: copy.RequestID, HostHarnessSessionID: copy.HostHarnessSessionID, AttachmentEpoch: &epoch}
		return supervisor.completeUncertain(message, command, supervisor.ack(message, copy.Operation, "replayed"), "too-many-provider-events", "provider outcome exceeded the event count bound")
	}
	if err := validateEvents(effectiveOutcome.Events, runID); err != nil {
		epoch := copy.AttachmentEpoch
		message := protocol.HostSessionHubMessage{NodeID: supervisor.nodeID, CommandID: copy.CommandID, CommandDigest: copy.Digest, RequestID: copy.RequestID, HostHarnessSessionID: copy.HostHarnessSessionID, AttachmentEpoch: &epoch}
		return supervisor.completeUncertain(message, command, supervisor.ack(message, copy.Operation, "replayed"), "invalid-provider-event", err.Error())
	}
	if copy.Operation == "start-turn" && record != nil && record.Observation.Status == "idle" && effectiveOutcome.Session.Status != "running" {
		running := effectiveOutcome.Session
		if running.ProviderTurnID == "" {
			running.ProviderTurnID = effectiveOutcome.ProviderTurnID
		}
		running.Status = "running"
		intermediate, intermediateErr := supervisor.recordFromProvider(id, driver.HarnessID(), running, record)
		if intermediateErr != nil {
			return CommandResponse{Err: intermediateErr}
		}
		if intermediateErr = supervisor.saveSessionFenced(intermediate, expected); intermediateErr != nil {
			return CommandResponse{Err: intermediateErr}
		}
		record = intermediate
		expected = cloneSession(intermediate)
	}
	updated, err := supervisor.recordDriverOutcome(id, driver.HarnessID(), copy.Operation, effectiveOutcome, record)
	if err != nil {
		return CommandResponse{Err: err}
	}
	epoch := copy.AttachmentEpoch
	message := protocol.HostSessionHubMessage{NodeID: supervisor.nodeID, CommandID: copy.CommandID, CommandDigest: copy.Digest, RequestID: copy.RequestID, HostHarnessSessionID: copy.HostHarnessSessionID, AttachmentEpoch: &epoch}
	ack := supervisor.ack(message, copy.Operation, "replayed")
	return supervisor.commitReconciledSuccess(message, command, ack, updated, reconciled.Outcome.ProviderTurnID, reconciled.Outcome.Events, expected)
}

func (supervisor *Supervisor) Discover(ctx context.Context, harnessID string, limit int) (DiscoveryResult, error) {
	finish, err := supervisor.beginOperation()
	if err != nil {
		return DiscoveryResult{}, err
	}
	defer finish()
	if limit < 1 || limit > protocol.HostHarnessSessionLimits.SessionsPerGeneration {
		return DiscoveryResult{}, fmt.Errorf("discovery limit is outside protocol bounds")
	}
	driver := supervisor.drivers[harnessID]
	if driver == nil || !supports(driver.Capabilities().DriverOperations, "discover") {
		return DiscoveryResult{}, ErrUnsupportedCapability
	}
	providers, err := driver.Discover(context.WithoutCancel(ctx), DiscoverRequest{Limit: limit})
	if err != nil {
		return DiscoveryResult{}, fmt.Errorf("provider discovery failed: %s", boundedDiagnostic(err.Error()))
	}
	if len(providers) > limit {
		return DiscoveryResult{}, ErrInvalidObservation
	}
	result := DiscoveryResult{Sessions: make([]protocol.HostHarnessSessionObservation, 0, len(providers)), Diagnostics: []string{}}
	seen := map[string]bool{}
	for _, provider := range providers {
		canonical, err := supervisor.authorize(provider.Workspace)
		if err != nil {
			result.Diagnostics = appendDiscoveryDiagnostic(result.Diagnostics, err)
			continue
		}
		provider.Workspace = canonical
		if err := validateProviderCapabilities(driver, provider); err != nil {
			result.Diagnostics = appendDiscoveryDiagnostic(result.Diagnostics, err)
			continue
		}
		if _, err := supervisor.recordFromProvider("discovery-validation", harnessID, provider, nil); err != nil {
			result.Diagnostics = appendDiscoveryDiagnostic(result.Diagnostics, err)
			continue
		}
		supervisor.mu.Lock()
		id := supervisor.providers[providerKey(harnessID, provider.ProviderSessionID, provider.Workspace)]
		supervisor.mu.Unlock()
		if id == "" {
			continue
		}
		if seen[id] {
			result.Diagnostics = appendDiscoveryDiagnostic(result.Diagnostics, fmt.Errorf("provider discovery repeated a known session identity"))
			continue
		}
		seen[id] = true
		supervisor.mu.Lock()
		previous := cloneSession(supervisor.sessions[id])
		supervisor.mu.Unlock()
		record, err := supervisor.recordFromProvider(id, harnessID, provider, previous)
		if err != nil {
			result.Diagnostics = appendDiscoveryDiagnostic(result.Diagnostics, err)
			continue
		}
		result.Sessions = append(result.Sessions, record.Observation)
	}
	return result, nil
}

func (supervisor *Supervisor) ReadHistory(ctx context.Context, message protocol.HostSessionHubMessage) (HistoryPage, error) {
	finish, operationErr := supervisor.beginOperation()
	if operationErr != nil {
		return HistoryPage{}, operationErr
	}
	defer finish()
	if message.Type != "host-session.history.read" {
		return HistoryPage{}, ErrUnsupportedCapability
	}
	if err := supervisor.validateCommand(message); err != nil {
		return HistoryPage{}, err
	}
	supervisor.mu.Lock()
	record := cloneSession(supervisor.sessions[message.HostHarnessSessionID])
	supervisor.mu.Unlock()
	if record == nil {
		return HistoryPage{}, fmt.Errorf("host session does not exist")
	}
	if err := checkEpoch(message.AttachmentEpoch, record.AttachmentEpoch); err != nil {
		return HistoryPage{}, err
	}
	if !supports(record.Observation.Operations, "read-history") {
		return HistoryPage{}, ErrUnsupportedCapability
	}
	if _, err := supervisor.authorize(record.Observation.Workspace); err != nil {
		return HistoryPage{}, err
	}
	handle, err := supervisor.issueHandle(message.HostHarnessSessionID)
	if err != nil {
		return HistoryPage{}, err
	}
	defer supervisor.retireHandle(handle)
	driver := supervisor.drivers[record.Observation.HarnessID]
	if driver == nil || !supervisor.supportsSessionOperation(record, "read-history") {
		return HistoryPage{}, ErrUnsupportedCapability
	}
	page, err := driver.ReadHistory(context.WithoutCancel(ctx), HistoryRequest{SessionRequest: SessionRequest{Handle: handle, ProviderSessionID: record.Observation.ProviderSessionID, Workspace: record.Observation.Workspace}, Cursor: message.Cursor, Limit: int(message.Limit)})
	if err != nil {
		return HistoryPage{}, err
	}
	if len(page.Items) > int(message.Limit) || len(page.NextCursor) > protocol.HostHarnessSessionLimits.HistoryCursorBytes || !utf8.ValidString(page.NextCursor) || protocol.LooksSecretLike(page.NextCursor) {
		return HistoryPage{}, ErrInvalidObservation
	}
	identities := make(map[string]bool, len(page.Items))
	for _, item := range page.Items {
		_, timestampErr := time.Parse(time.RFC3339Nano, item.At)
		invalidTimestamp := item.At != "" && (len(item.At) > protocol.HostHarnessSessionLimits.IdentifierBytes || timestampErr != nil)
		invalidTurn := item.ProviderTurnID != "" && (len(item.ProviderTurnID) > protocol.HostHarnessSessionLimits.IdentifierBytes || !utf8.ValidString(item.ProviderTurnID) || protocol.LooksSecretLike(item.ProviderTurnID))
		if item.ID == "" || len(item.ID) > protocol.HostHarnessSessionLimits.IdentifierBytes || !utf8.ValidString(item.ID) || protocol.LooksSecretLike(item.ID) || identities[item.ID] || invalidTurn || invalidTimestamp || !utf8.ValidString(item.Text) || len(item.Text) > protocol.HostHarnessSessionLimits.HistoryItemTextBytes || !supports(protocol.HostHarnessSessionHistoryKinds, item.Kind) || protocol.LooksSecretLike(item.Text) {
			return HistoryPage{}, ErrInvalidObservation
		}
		identities[item.ID] = true
	}
	return page, nil
}

func (supervisor *Supervisor) Shutdown(ctx context.Context) error {
	supervisor.mu.Lock()
	supervisor.shuttingDown = true
	supervisor.cancel()
	supervisor.mu.Unlock()
	done := make(chan struct{})
	go func() { supervisor.operations.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// AcceptObservation accepts an asynchronous provider callback only while the exact core-issued
// handle is active. Late, invented, or cross-session handles cannot select a registry record.
func (supervisor *Supervisor) AcceptObservation(handle OperationHandle, provider ProviderSession, events []protocol.HarnessEvent) error {
	supervisor.mu.Lock()
	if err := supervisor.admissionErrorLocked(); err != nil {
		supervisor.mu.Unlock()
		return err
	}
	issued, found := supervisor.handles[handle.Token]
	record := cloneSession(supervisor.sessions[issued.SessionID])
	if !found || issued.SessionID == "" || issued.SessionID != handle.HostHarnessSessionID || record == nil || record.Observation.Revision != issued.Revision || sessionRecordFingerprint(record) != issued.Fingerprint {
		supervisor.mu.Unlock()
		return ErrInvalidObservation
	}
	supervisor.operations.Add(1)
	supervisor.mu.Unlock()
	defer supervisor.operations.Done()
	if terminalStatus(record.Observation.Status) {
		return ErrInvalidObservation
	}
	if provider.ProviderSessionID != record.Observation.ProviderSessionID || provider.Workspace != record.Observation.Workspace {
		return ErrIdentityConflict
	}
	if _, err := supervisor.authorize(provider.Workspace); err != nil {
		return err
	}
	if len(events) > MaximumOutcomeEvents {
		return ErrInvalidObservation
	}
	if err := validateEvents(events, record.ActiveRunID); err != nil {
		return err
	}
	driver := supervisor.drivers[record.Observation.HarnessID]
	if driver == nil {
		return ErrUnsupportedCapability
	}
	if err := validateProviderCapabilities(driver, provider); err != nil {
		return err
	}
	updated, err := supervisor.recordFromProvider(issued.SessionID, record.Observation.HarnessID, provider, record)
	if err != nil {
		return err
	}
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	currentHandle, stillActive := supervisor.handles[handle.Token]
	current := supervisor.sessions[issued.SessionID]
	if !stillActive || currentHandle != issued || current == nil || !sameSessionRecord(current, record) {
		return ErrInvalidObservation
	}
	previous := cloneSession(current)
	supervisor.sessions[issued.SessionID] = cloneSession(updated)
	if err := saveRegistry(supervisor.dataRoot, supervisor.sessions); err != nil {
		supervisor.sessions[issued.SessionID] = previous
		return err
	}
	return nil
}

func (supervisor *Supervisor) Acknowledge(commandID string) error {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	command := supervisor.commands[commandID]
	if command == nil || command.State != "completed" {
		return fmt.Errorf("command outcome is not complete")
	}
	previous := cloneCommands(supervisor.commands)
	command.Acknowledged = true
	if len(supervisor.commands) > supervisor.maximumCommands {
		supervisor.evictAcknowledgedCommandsLocked(supervisor.maximumCommands)
	}
	if err := saveLedger(supervisor.dataRoot, supervisor.commands); err != nil {
		supervisor.commands = previous
		return err
	}
	return nil
}

// ForgetClosed removes an acknowledged terminal session. Active sessions and any session with a
// pending, uncertain, or unacknowledged command are never retention candidates.
func (supervisor *Supervisor) ForgetClosed(id string) error {
	select {
	case supervisor.forgetLock <- struct{}{}:
		defer func() { <-supervisor.forgetLock }()
	default:
		return ErrSessionBusy
	}
	supervisor.mu.Lock()
	if err := supervisor.admissionErrorLocked(); err != nil {
		supervisor.mu.Unlock()
		return err
	}
	release, err := supervisor.trySessionLockLocked(id)
	if err != nil {
		supervisor.mu.Unlock()
		return err
	}
	supervisor.operations.Add(1)
	supervisor.mu.Unlock()
	defer supervisor.operations.Done()
	defer release()

	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	record := supervisor.sessions[id]
	if record == nil || record.Observation.Status != "closed" {
		return fmt.Errorf("only a closed host session can be forgotten")
	}
	for _, command := range supervisor.commands {
		if ledgerSessionID(command) == id && (command.State != "completed" || !command.Acknowledged) {
			return fmt.Errorf("host session has an unacknowledged or uncertain command")
		}
	}
	if err := saveForgetTransaction(supervisor.dataRoot, record); err != nil {
		return fmt.Errorf("stage forget transaction: %w", err)
	}
	if err := supervisor.reach(BarrierAfterForgetIntent); err != nil {
		supervisor.disabled = err
		return err
	}
	previousProvider := supervisor.providers[providerKey(record.Observation.HarnessID, record.Observation.ProviderSessionID, record.Observation.Workspace)]
	delete(supervisor.sessions, id)
	delete(supervisor.providers, providerKey(record.Observation.HarnessID, record.Observation.ProviderSessionID, record.Observation.Workspace))
	if err := saveRegistry(supervisor.dataRoot, supervisor.sessions); err != nil {
		supervisor.sessions[id] = record
		supervisor.providers[providerKey(record.Observation.HarnessID, record.Observation.ProviderSessionID, record.Observation.Workspace)] = previousProvider
		supervisor.disabled = err
		return err
	}
	if err := supervisor.reach(BarrierAfterForgetRegistry); err != nil {
		supervisor.disabled = err
		return err
	}
	remainingCommands := cloneCommands(supervisor.commands)
	for commandID, command := range remainingCommands {
		if ledgerSessionID(command) == id {
			delete(remainingCommands, commandID)
		}
	}
	if err := saveLedger(supervisor.dataRoot, remainingCommands); err != nil {
		supervisor.disabled = err
		return err
	}
	supervisor.commands = remainingCommands
	if err := supervisor.reach(BarrierAfterForgetLedger); err != nil {
		supervisor.disabled = err
		return err
	}
	if err := removeDurableFile(filepath.Join(supervisor.dataRoot, forgetTransactionName)); err != nil {
		supervisor.disabled = err
		return fmt.Errorf("commit forget transaction: %w", err)
	}
	return nil
}

func (supervisor *Supervisor) validateCommand(message protocol.HostSessionHubMessage) error {
	if message.NodeID != supervisor.nodeID {
		return fmt.Errorf("host session command names a different node")
	}
	digest, err := protocol.HostHarnessSessionCommandDigest(message)
	if err != nil {
		return err
	}
	if digest != message.CommandDigest {
		return fmt.Errorf("host session command digest does not match canonical payload")
	}
	return nil
}
func (supervisor *Supervisor) replayLocked(message protocol.HostSessionHubMessage, command *ledgerRecord) CommandResponse {
	if command.Digest != message.CommandDigest {
		return CommandResponse{Err: ErrCommandConflict}
	}
	ack := supervisor.ack(message, command.Operation, "replayed")
	if command.State == "completed" && command.Result != nil {
		return CommandResponse{Ack: ack, Result: *command.Result}
	}
	if command.State == "pending" {
		code, detail := "recovery-required", "provider effect cannot be proven absent after operation settlement"
		err := fmt.Errorf("command outcome is uncertain; manual reconciliation is required")
		if supervisor.activeCommands[command.CommandID] {
			code, detail, err = "operation-pending", "the accepted operation is still settling", ErrSessionBusy
		}
		result := supervisor.result(message, command.Operation, "uncertain", code, detail, "", nil)
		result.At = command.UpdatedAt
		return CommandResponse{Ack: ack, Result: result, Err: err}
	}
	var result protocol.HostSessionControlMessage
	if command.Result != nil {
		result = *command.Result
	}
	if result.Type == "" {
		result = supervisor.uncertainResult(*command, "recovery-required", "provider effect cannot be proven absent")
	}
	return CommandResponse{Ack: ack, Result: result, Err: fmt.Errorf("command outcome is uncertain; manual reconciliation is required")}
}
func (supervisor *Supervisor) admissionErrorLocked() error {
	if supervisor.disabled != nil {
		return fmt.Errorf("%w: %s", ErrDisabled, boundedDiagnostic(supervisor.disabled.Error()))
	}
	if supervisor.shuttingDown {
		return ErrShuttingDown
	}
	return nil
}

func (supervisor *Supervisor) beginOperation() (func(), error) {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	if err := supervisor.admissionErrorLocked(); err != nil {
		return nil, err
	}
	supervisor.operations.Add(1)
	return supervisor.operations.Done, nil
}

func (supervisor *Supervisor) ensureCommandCapacityLocked() bool {
	if len(supervisor.commands) < supervisor.maximumCommands {
		return true
	}
	supervisor.evictAcknowledgedCommandsLocked(supervisor.maximumCommands - 1)
	return len(supervisor.commands) < supervisor.maximumCommands
}

func (supervisor *Supervisor) evictAcknowledgedCommandsLocked(target int) {
	type candidate struct {
		id        string
		updatedAt time.Time
	}
	candidates := make([]candidate, 0, len(supervisor.commands))
	for id, command := range supervisor.commands {
		if command.State == "completed" && command.Acknowledged {
			updatedAt, err := time.Parse(time.RFC3339Nano, command.UpdatedAt)
			if err != nil {
				continue
			}
			candidates = append(candidates, candidate{id: id, updatedAt: updatedAt})
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].updatedAt.Equal(candidates[j].updatedAt) {
			return candidates[i].id < candidates[j].id
		}
		return candidates[i].updatedAt.Before(candidates[j].updatedAt)
	})
	for _, candidate := range candidates {
		if len(supervisor.commands) <= target {
			break
		}
		delete(supervisor.commands, candidate.id)
	}
}

func supportsDriverOperation(capabilities Capabilities, operation string) bool {
	switch {
	case supports(protocol.HostHarnessDriverOperations, operation):
		return supports(capabilities.DriverOperations, operation)
	case supports(protocol.HostHarnessSessionOperations, operation):
		return supports(capabilities.SessionOperations, operation)
	case supports(LifecycleOperations, operation):
		return supports(capabilities.LifecycleOperations, operation)
	default:
		return false
	}
}

func (supervisor *Supervisor) supportsSessionOperation(record *sessionRecord, operation string) bool {
	if record == nil {
		return false
	}
	driver := supervisor.drivers[record.Observation.HarnessID]
	if driver == nil || !supportsDriverOperation(driver.Capabilities(), operation) {
		return false
	}
	if supports(protocol.HostHarnessSessionOperations, operation) {
		return supports(record.Observation.Operations, operation)
	}
	return supports(record.LifecycleOperations, operation)
}

func validateProviderCapabilities(driver Driver, provider ProviderSession) error {
	if !sortedVocabulary(provider.Operations, protocol.HostHarnessSessionOperations) || !sortedVocabulary(provider.LifecycleOperations, LifecycleOperations) {
		return ErrInvalidObservation
	}
	capabilities := driver.Capabilities()
	for _, operation := range provider.Operations {
		if !supports(capabilities.SessionOperations, operation) {
			return ErrUnsupportedCapability
		}
	}
	for _, operation := range provider.LifecycleOperations {
		if !supports(capabilities.LifecycleOperations, operation) {
			return ErrUnsupportedCapability
		}
	}
	return nil
}

func appendDiscoveryDiagnostic(diagnostics []string, err error) []string {
	if len(diagnostics) >= protocol.HostHarnessSessionLimits.SessionsPerInventoryPage {
		return diagnostics
	}
	return append(diagnostics, boundedDiagnostic(err.Error()))
}

func terminalStatus(status string) bool { return status == "closed" || status == "failed" }

func (supervisor *Supervisor) trySessionLockLocked(id string) (func(), error) {
	lock := supervisor.locks[id]
	if lock == nil {
		lock = make(chan struct{}, 1)
		supervisor.locks[id] = lock
	}
	select {
	case lock <- struct{}{}:
		return func() { <-lock }, nil
	default:
		return nil, ErrSessionBusy
	}
}

func (supervisor *Supervisor) recordFromProvider(id, harnessID string, provider ProviderSession, previous *sessionRecord) (*sessionRecord, error) {
	if provider.ProviderSessionID == "" || provider.Workspace == "" || !supports(protocol.HostHarnessSessionSources, provider.Source) || !supports(protocol.HostHarnessSessionStatuses, provider.Status) || !supports(protocol.HostHarnessSessionControlModes, provider.ControlMode) || !sortedVocabulary(provider.Operations, protocol.HostHarnessSessionOperations) || !sortedVocabulary(provider.LifecycleOperations, LifecycleOperations) {
		return nil, ErrInvalidObservation
	}
	now := supervisor.clock.Now().UTC()
	created := provider.CreatedAt
	if created.IsZero() {
		created = now
	}
	updated := provider.UpdatedAt
	if updated.IsZero() {
		updated = now
	}
	revision, epoch := int64(1), int64(0)
	attached, active := "", ""
	sameStatus := false
	if previous != nil {
		if previous.Observation.ProviderSessionID != provider.ProviderSessionID || previous.Observation.Workspace != provider.Workspace {
			return nil, ErrIdentityConflict
		}
		if previous.Observation.Source != provider.Source {
			return nil, ErrIdentityConflict
		}
		sameStatus = previous.Observation.Status == provider.Status
		if !sameStatus {
			if err := requireTransition(previous.Observation.Status, provider.Status); err != nil {
				return nil, err
			}
		}
		created, _ = time.Parse(time.RFC3339Nano, previous.Observation.CreatedAt)
		revision, epoch, attached, active = previous.Observation.Revision+1, previous.AttachmentEpoch, previous.AttachedThreadID, previous.ActiveRunID
		unchanged := sameStatus && previous.Observation.ControlMode == provider.ControlMode &&
			previous.Observation.ProviderTurnID == provider.ProviderTurnID && previous.Observation.Summary == boundedDiagnostic(provider.Summary) &&
			slices.Equal(previous.Observation.Operations, provider.Operations)
		if unchanged {
			revision = previous.Observation.Revision
			updated, _ = time.Parse(time.RFC3339Nano, previous.Observation.UpdatedAt)
		}
	}
	if provider.Status != "running" && provider.Status != "awaiting-approval" {
		active = ""
	}
	if terminalStatus(provider.Status) && attached != "" {
		attached = ""
		epoch++
	}
	observation := protocol.HostHarnessSessionObservation{HostHarnessSessionID: id, NodeID: supervisor.nodeID, HarnessID: harnessID, ProviderSessionID: provider.ProviderSessionID, Workspace: provider.Workspace,
		Source: provider.Source, Status: provider.Status, ControlMode: provider.ControlMode, Operations: append([]string(nil), provider.Operations...), Revision: revision,
		ProviderTurnID: provider.ProviderTurnID, Summary: boundedDiagnostic(provider.Summary), CreatedAt: created.Format(time.RFC3339Nano), UpdatedAt: updated.Format(time.RFC3339Nano)}
	if err := observation.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidObservation, err)
	}
	if previous != nil {
		if err := protocol.ValidateHostHarnessSessionObservationTransition(previous.Observation, observation); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalidObservation, err)
		}
	}
	return &sessionRecord{Observation: observation, LifecycleOperations: append([]string(nil), provider.LifecycleOperations...), AttachedThreadID: attached, ActiveRunID: active, AttachmentEpoch: epoch}, nil
}

func validateEvents(events []protocol.HarnessEvent, runID string) error {
	for _, event := range events {
		if event.RunID != runID {
			return ErrInvalidObservation
		}
		if err := event.Validate(); err != nil {
			return fmt.Errorf("%w: %v", ErrInvalidObservation, err)
		}
		encoded, _ := json.Marshal(event)
		if protocol.LooksSecretLike(string(encoded)) {
			return ErrInvalidObservation
		}
	}
	return nil
}
func (supervisor *Supervisor) authorize(workspace string) (string, error) {
	canonical, err := harness.AuthorizeWorkspace(workspace, supervisor.workspaceRoots)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrUnauthorizedWorkspace, err)
	}
	return canonical, nil
}
func (supervisor *Supervisor) issueHandle(id string) (OperationHandle, error) {
	token, err := randomIDs{}.NewID()
	if err != nil {
		return OperationHandle{}, err
	}
	supervisor.mu.Lock()
	record := supervisor.sessions[id]
	if record == nil {
		supervisor.mu.Unlock()
		return OperationHandle{}, fmt.Errorf("host session does not exist")
	}
	supervisor.handles[token] = operationHandleRecord{SessionID: id, Revision: record.Observation.Revision, Fingerprint: sessionRecordFingerprint(record)}
	supervisor.mu.Unlock()
	return OperationHandle{HostHarnessSessionID: id, Token: token}, nil
}
func (supervisor *Supervisor) retireHandle(handle OperationHandle) {
	supervisor.mu.Lock()
	delete(supervisor.handles, handle.Token)
	supervisor.mu.Unlock()
}
func (supervisor *Supervisor) now() string {
	return supervisor.clock.Now().UTC().Format(time.RFC3339Nano)
}
func providerKey(harnessID, providerID, workspace string) string {
	return strings.Join([]string{harnessID, providerID, workspace}, "\x00")
}
func cloneSession(record *sessionRecord) *sessionRecord {
	if record == nil {
		return nil
	}
	copy := *record
	copy.Observation.Operations = append([]string(nil), record.Observation.Operations...)
	copy.LifecycleOperations = append([]string(nil), record.LifecycleOperations...)
	return &copy
}

func sameSessionRecord(left, right *sessionRecord) bool {
	if left == nil || right == nil || left.AttachedThreadID != right.AttachedThreadID || left.ActiveRunID != right.ActiveRunID || left.AttachmentEpoch != right.AttachmentEpoch ||
		!slices.Equal(left.LifecycleOperations, right.LifecycleOperations) || !slices.Equal(left.Observation.Operations, right.Observation.Operations) {
		return false
	}
	leftObservation, rightObservation := left.Observation, right.Observation
	leftObservation.Operations, rightObservation.Operations = nil, nil
	return reflect.DeepEqual(leftObservation, rightObservation)
}

func sessionRecordFingerprint(record *sessionRecord) string {
	digest, _ := checksum(record)
	return digest
}
func cloneCommands(records map[string]*ledgerRecord) map[string]*ledgerRecord {
	cloned := make(map[string]*ledgerRecord, len(records))
	for id, record := range records {
		copy := *record
		if record.Result != nil {
			result := *record.Result
			copy.Result = &result
		}
		cloned[id] = &copy
	}
	return cloned
}
func checkEpoch(got *int64, expected int64) error {
	if got == nil || *got < expected {
		return ErrStaleEpoch
	}
	if *got > expected {
		return ErrFutureEpoch
	}
	return nil
}

func preflightExisting(message protocol.HostSessionHubMessage, record *sessionRecord, operation string) error {
	switch operation {
	case "attach":
		if terminalStatus(record.Observation.Status) {
			return ErrInvalidTransition
		}
		if record.Observation.Status != message.ExpectedStatus || record.AttachedThreadID != "" && record.AttachedThreadID != message.ThreadID {
			return fmt.Errorf("attachment identity or expected status does not match")
		}
	case "detach":
		if record.AttachedThreadID != message.ThreadID {
			return fmt.Errorf("attachment identity does not match")
		}
	case "start-turn":
		if record.AttachedThreadID == "" || record.Observation.Status != "idle" {
			return ErrInvalidTransition
		}
	case "steer", "interrupt":
		if record.Observation.Status != "running" || record.ActiveRunID != message.RunID || record.Observation.ProviderTurnID != message.ProviderTurnID {
			return ErrInvalidTransition
		}
	case "resolve-approval":
		if record.Observation.Status != "awaiting-approval" || record.ActiveRunID != message.RunID {
			return ErrInvalidTransition
		}
	case "close":
		if record.Observation.Status == "closed" || record.Observation.Status == "failed" {
			return ErrInvalidTransition
		}
	}
	return nil
}
func commandOperation(messageType string) string {
	switch messageType {
	case "host-session.create":
		return "create"
	case "host-session.adopt":
		return "adopt"
	case "host-session.attach":
		return "attach"
	case "host-session.detach":
		return "detach"
	case "host-session.turn.start":
		return "start-turn"
	case "host-session.turn.steer":
		return "steer"
	case "host-session.turn.interrupt":
		return "interrupt"
	case "host-session.approval.decision":
		return "resolve-approval"
	case "host-session.close":
		return "close"
	}
	return ""
}
func (supervisor *Supervisor) ack(message protocol.HostSessionHubMessage, operation, disposition string) protocol.HostSessionControlMessage {
	ack := protocol.HostSessionControlMessage{Type: "host-session.command.ack", NodeID: supervisor.nodeID, Operation: operation, CommandID: message.CommandID, CommandDigest: message.CommandDigest, Disposition: disposition, At: supervisor.now()}
	if operation == "create" || operation == "adopt" {
		ack.RequestID = message.RequestID
	} else {
		ack.HostHarnessSessionID = message.HostHarnessSessionID
		ack.AttachmentEpoch = message.AttachmentEpoch
	}
	return ack
}
func (supervisor *Supervisor) result(message protocol.HostSessionHubMessage, operation, outcome, code, detail, providerTurnID string, session *protocol.HostHarnessSessionObservation) protocol.HostSessionControlMessage {
	result := protocol.HostSessionControlMessage{Type: "host-session.command.result", NodeID: supervisor.nodeID, Operation: operation, CommandID: message.CommandID, CommandDigest: message.CommandDigest,
		Outcome: outcome, Code: code, Detail: boundedDiagnostic(detail), ProviderTurnID: providerTurnID, Session: session, At: supervisor.now()}
	if operation == "create" || operation == "adopt" {
		result.RequestID = message.RequestID
	} else {
		result.HostHarnessSessionID = message.HostHarnessSessionID
		result.AttachmentEpoch = message.AttachmentEpoch
	}
	return result
}
func (supervisor *Supervisor) uncertainResult(command ledgerRecord, code, detail string) protocol.HostSessionControlMessage {
	epoch := command.AttachmentEpoch
	result := protocol.HostSessionControlMessage{Type: "host-session.command.result", NodeID: supervisor.nodeID, Operation: command.Operation, CommandID: command.CommandID,
		CommandDigest: command.Digest, Outcome: "uncertain", Code: code, Detail: boundedDiagnostic(detail), RequestID: command.RequestID, HostHarnessSessionID: command.HostHarnessSessionID, At: supervisor.now()}
	if command.HostHarnessSessionID != "" {
		result.AttachmentEpoch = &epoch
	}
	return result
}
func boundedDiagnostic(value string) string {
	lower := strings.ToLower(value)
	if protocol.LooksSecretLike(value) || strings.Contains(value, "://") || strings.Contains(lower, "authorization") || strings.Contains(lower, "password") || strings.Contains(lower, "credential") || strings.Contains(lower, "environment") {
		return "provider diagnostic redacted"
	}
	if !utf8.ValidString(value) {
		return "provider diagnostic was not valid UTF-8"
	}
	if len(value) <= protocol.HostHarnessSessionLimits.DiagnosticBytes {
		return value
	}
	value = string([]byte(value)[:protocol.HostHarnessSessionLimits.DiagnosticBytes])
	for !utf8.ValidString(value) {
		value = value[:len(value)-1]
	}
	return value
}

func (supervisor *Supervisor) reach(point string) error {
	if supervisor.barrier == nil {
		return nil
	}
	return supervisor.barrier.Reach(point)
}
