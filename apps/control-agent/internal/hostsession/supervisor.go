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

	mu            sync.Mutex
	sessions      map[string]*sessionRecord
	providers     map[string]string
	commands      map[string]*ledgerRecord
	locks         map[string]chan struct{}
	handles       map[string]string
	disabled      error
	shuttingDown  bool
	operations    sync.WaitGroup
	operationRoot context.Context
	cancel        context.CancelFunc
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
		options.MaximumCommands = 4096
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
		locks: map[string]chan struct{}{}, handles: map[string]string{}, operationRoot: root, cancel: cancel}
	sessions, registryErr := loadRegistry(options.DataRoot)
	commands, ledgerErr := loadLedger(options.DataRoot)
	if registryErr != nil || ledgerErr != nil {
		supervisor.sessions, supervisor.commands, supervisor.providers = map[string]*sessionRecord{}, map[string]*ledgerRecord{}, map[string]string{}
		supervisor.disabled = errors.Join(registryErr, ledgerErr)
		return supervisor, nil
	}
	supervisor.sessions, supervisor.commands, supervisor.providers = sessions, commands, map[string]string{}
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
		if driver == nil || !supports(record.Observation.Operations, operation) {
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
	supervisor.commands[message.CommandID] = pending
	if err := saveLedger(supervisor.dataRoot, supervisor.commands); err != nil {
		delete(supervisor.commands, message.CommandID)
		supervisor.mu.Unlock()
		return CommandResponse{Err: fmt.Errorf("persist command before provider effect: %w", err)}
	}
	supervisor.mu.Unlock()
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
	if pending.Operation == "attach" {
		if record.Observation.Status != message.ExpectedStatus || record.AttachedThreadID != "" && record.AttachedThreadID != message.ThreadID {
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
	return supervisor.commitSuccess(message, pending, ack, record, "", nil)
}

func (supervisor *Supervisor) executeCreation(message protocol.HostSessionHubMessage, driver Driver, pending *ledgerRecord, ack protocol.HostSessionControlMessage) CommandResponse {
	var provider ProviderSession
	var err error
	if pending.Operation == "create" {
		provider, err = driver.Create(supervisor.operationRoot, CreateRequest{Workspace: message.Workspace, Model: message.Model})
	} else {
		inspected, inspectErr := driver.Inspect(supervisor.operationRoot, SessionRequest{ProviderSessionID: message.ProviderSessionID, Workspace: message.Workspace})
		if inspectErr != nil {
			return supervisor.completeDriverFailure(message, pending, ack, inspectErr)
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
	record, err := supervisor.recordFromProvider(id, driver.HarnessID(), provider, nil)
	if err != nil {
		return supervisor.completeUncertain(message, pending, ack, "invalid-provider-observation", err.Error())
	}
	return supervisor.commitSuccess(message, pending, ack, record, provider.ProviderTurnID, nil)
}

func (supervisor *Supervisor) executeDriverMutation(message protocol.HostSessionHubMessage, operation string, driver Driver, record *sessionRecord, pending *ledgerRecord, ack protocol.HostSessionControlMessage) CommandResponse {
	handle, handleErr := supervisor.issueHandle(record.Observation.HostHarnessSessionID)
	if handleErr != nil {
		return supervisor.completeUncertain(message, pending, ack, "handle-generation-failed", "could not issue provider operation handle")
	}
	defer supervisor.retireHandle(handle)
	request := SessionRequest{Handle: handle, ProviderSessionID: record.Observation.ProviderSessionID, Workspace: record.Observation.Workspace}
	if operation == "start-turn" {
		if record.AttachedThreadID == "" || record.Observation.Status != "idle" {
			return supervisor.completeRejected(message, pending, ack, "illegal-state", "session is not attached and idle")
		}
		record.Observation.Status, record.ActiveRunID = "running", message.RunID
		record.Observation.Revision++
		record.Observation.UpdatedAt = supervisor.now()
		if err := supervisor.saveSession(record); err != nil {
			return supervisor.completeUncertain(message, pending, ack, "pre-effect-persist-failed", err.Error())
		}
	}
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
		return supervisor.completeDriverFailure(message, pending, ack, err)
	}
	if err := supervisor.reach(BarrierAfterEffect); err != nil {
		return CommandResponse{Ack: ack, Err: err}
	}
	supervisor.mu.Lock()
	latest := cloneSession(supervisor.sessions[record.Observation.HostHarnessSessionID])
	supervisor.mu.Unlock()
	if latest == nil {
		latest = record
	}
	updated, err := supervisor.recordFromProvider(record.Observation.HostHarnessSessionID, record.Observation.HarnessID, outcome.Session, latest)
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
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
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

func (supervisor *Supervisor) completeDriverFailure(message protocol.HostSessionHubMessage, command *ledgerRecord, ack protocol.HostSessionControlMessage, err error) CommandResponse {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return supervisor.completeUncertain(message, command, ack, "provider-outcome-uncertain", "provider operation ended without a conclusive outcome")
	}
	return supervisor.completeRejected(message, command, ack, "provider-rejected", "provider operation was rejected")
}
func (supervisor *Supervisor) completeRejected(message protocol.HostSessionHubMessage, command *ledgerRecord, ack protocol.HostSessionControlMessage, code, detail string) CommandResponse {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
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
	handle, err := supervisor.issueHandle(id)
	if err != nil {
		return err
	}
	defer supervisor.retireHandle(handle)
	provider, err := driver.Refresh(context.WithoutCancel(ctx), SessionRequest{Handle: handle, ProviderSessionID: record.Observation.ProviderSessionID, Workspace: record.Observation.Workspace})
	if err != nil {
		return err
	}
	updated, err := supervisor.recordFromProvider(id, record.Observation.HarnessID, provider, record)
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
	var provider ProviderSession
	if operation == "resume" {
		provider, err = driver.Resume(context.WithoutCancel(ctx), request)
	} else {
		provider, err = driver.Inspect(context.WithoutCancel(ctx), request)
	}
	if err != nil {
		return err
	}
	updated, err := supervisor.recordFromProvider(id, record.Observation.HarnessID, provider, record)
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
	if driver == nil {
		return CommandResponse{Err: ErrUnsupportedCapability}
	}
	workspace, providerID := copy.Workspace, copy.ProviderSessionID
	if record != nil {
		workspace, providerID = record.Observation.Workspace, record.Observation.ProviderSessionID
	}
	if _, err := supervisor.authorize(workspace); err != nil {
		return CommandResponse{Err: err}
	}
	var err error
	handle := OperationHandle{}
	if record != nil {
		handle, err = supervisor.issueHandle(record.Observation.HostHarnessSessionID)
		if err != nil {
			return CommandResponse{Err: err}
		}
		defer supervisor.retireHandle(handle)
	}
	reconciled, err := driver.Reconcile(context.WithoutCancel(ctx), ReconcileRequest{SessionRequest: SessionRequest{Handle: handle, ProviderSessionID: providerID, Workspace: workspace}, CommandID: commandID, Operation: copy.Operation})
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
	if _, err := supervisor.authorize(provider.Workspace); err != nil {
		return CommandResponse{Err: err}
	}
	id := copy.HostHarnessSessionID
	if id == "" {
		supervisor.mu.Lock()
		id = supervisor.providers[providerKey(driver.HarnessID(), provider.ProviderSessionID, provider.Workspace)]
		supervisor.mu.Unlock()
		if id == "" {
			id, err = supervisor.ids.NewID()
			if err != nil {
				return CommandResponse{Err: err}
			}
		}
	}
	updated, err := supervisor.recordFromProvider(id, driver.HarnessID(), provider, record)
	if err != nil {
		return CommandResponse{Err: err}
	}
	epoch := copy.AttachmentEpoch
	message := protocol.HostSessionHubMessage{NodeID: supervisor.nodeID, CommandID: copy.CommandID, CommandDigest: copy.Digest, RequestID: copy.RequestID, HostHarnessSessionID: copy.HostHarnessSessionID, AttachmentEpoch: &epoch}
	ack := supervisor.ack(message, copy.Operation, "replayed")
	return supervisor.commitSuccess(message, command, ack, updated, reconciled.Outcome.ProviderTurnID, reconciled.Outcome.Events)
}

func (supervisor *Supervisor) Discover(ctx context.Context, harnessID string, limit int) ([]protocol.HostHarnessSessionObservation, error) {
	finish, err := supervisor.beginOperation()
	if err != nil {
		return nil, err
	}
	defer finish()
	if limit < 1 || limit > protocol.HostHarnessSessionLimits.SessionsPerGeneration {
		return nil, fmt.Errorf("discovery limit is outside protocol bounds")
	}
	driver := supervisor.drivers[harnessID]
	if driver == nil || !supports(driver.Capabilities().DriverOperations, "discover") {
		return nil, ErrUnsupportedCapability
	}
	providers, err := driver.Discover(context.WithoutCancel(ctx), DiscoverRequest{Limit: limit})
	if err != nil {
		return nil, err
	}
	if len(providers) > limit {
		return nil, ErrInvalidObservation
	}
	result := make([]protocol.HostHarnessSessionObservation, 0, len(providers))
	for _, provider := range providers {
		canonical, err := supervisor.authorize(provider.Workspace)
		if err != nil {
			return nil, err
		}
		provider.Workspace = canonical
		supervisor.mu.Lock()
		id := supervisor.providers[providerKey(harnessID, provider.ProviderSessionID, provider.Workspace)]
		supervisor.mu.Unlock()
		if id == "" {
			continue
		}
		supervisor.mu.Lock()
		previous := cloneSession(supervisor.sessions[id])
		supervisor.mu.Unlock()
		record, err := supervisor.recordFromProvider(id, harnessID, provider, previous)
		if err != nil {
			return nil, err
		}
		result = append(result, record.Observation)
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
	page, err := supervisor.drivers[record.Observation.HarnessID].ReadHistory(context.WithoutCancel(ctx), HistoryRequest{SessionRequest: SessionRequest{Handle: handle, ProviderSessionID: record.Observation.ProviderSessionID, Workspace: record.Observation.Workspace}, Cursor: message.Cursor, Limit: int(message.Limit)})
	if err != nil {
		return HistoryPage{}, err
	}
	if len(page.Items) > int(message.Limit) || len(page.NextCursor) > protocol.HostHarnessSessionLimits.HistoryCursorBytes {
		return HistoryPage{}, ErrInvalidObservation
	}
	for _, item := range page.Items {
		if item.ID == "" || !utf8.ValidString(item.Text) || len(item.Text) > protocol.HostHarnessSessionLimits.HistoryItemTextBytes || !supports(protocol.HostHarnessSessionHistoryKinds, item.Kind) || protocol.LooksSecretLike(item.Text) {
			return HistoryPage{}, ErrInvalidObservation
		}
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
	id := supervisor.handles[handle.Token]
	record := cloneSession(supervisor.sessions[id])
	supervisor.mu.Unlock()
	if id == "" || id != handle.HostHarnessSessionID || record == nil {
		return ErrInvalidObservation
	}
	if provider.ProviderSessionID != record.Observation.ProviderSessionID || provider.Workspace != record.Observation.Workspace {
		return ErrIdentityConflict
	}
	if _, err := supervisor.authorize(provider.Workspace); err != nil {
		return err
	}
	if err := validateEvents(events, record.ActiveRunID); err != nil {
		return err
	}
	updated, err := supervisor.recordFromProvider(id, record.Observation.HarnessID, provider, record)
	if err != nil {
		return err
	}
	return supervisor.saveSession(updated)
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
		ids := []string{}
		for id, record := range supervisor.commands {
			if record.Acknowledged && record.State == "completed" {
				ids = append(ids, id)
			}
		}
		sort.Strings(ids)
		for _, id := range ids {
			if len(supervisor.commands) <= supervisor.maximumCommands {
				break
			}
			delete(supervisor.commands, id)
		}
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
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	record := supervisor.sessions[id]
	if record == nil || record.Observation.Status != "closed" {
		return fmt.Errorf("only a closed host session can be forgotten")
	}
	for _, command := range supervisor.commands {
		if command.HostHarnessSessionID == id && (command.State != "completed" || !command.Acknowledged) {
			return fmt.Errorf("host session has an unacknowledged or uncertain command")
		}
	}
	previousCommands := cloneCommands(supervisor.commands)
	for commandID, command := range supervisor.commands {
		if command.HostHarnessSessionID == id {
			delete(supervisor.commands, commandID)
		}
	}
	if err := saveLedger(supervisor.dataRoot, supervisor.commands); err != nil {
		supervisor.commands = previousCommands
		return err
	}
	previousProvider := supervisor.providers[providerKey(record.Observation.HarnessID, record.Observation.ProviderSessionID, record.Observation.Workspace)]
	delete(supervisor.sessions, id)
	delete(supervisor.providers, providerKey(record.Observation.HarnessID, record.Observation.ProviderSessionID, record.Observation.Workspace))
	if err := saveRegistry(supervisor.dataRoot, supervisor.sessions); err != nil {
		supervisor.sessions[id] = record
		supervisor.providers[providerKey(record.Observation.HarnessID, record.Observation.ProviderSessionID, record.Observation.Workspace)] = previousProvider
		return err
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
	if provider.ProviderSessionID == "" || provider.Workspace == "" || !supports(protocol.HostHarnessSessionSources, provider.Source) || !supports(protocol.HostHarnessSessionStatuses, provider.Status) || !supports(protocol.HostHarnessSessionControlModes, provider.ControlMode) || !sortedVocabulary(provider.Operations, protocol.HostHarnessSessionOperations) {
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
		if sameStatus {
			revision = previous.Observation.Revision
			updated, _ = time.Parse(time.RFC3339Nano, previous.Observation.UpdatedAt)
		}
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
	return &sessionRecord{Observation: observation, AttachedThreadID: attached, ActiveRunID: active, AttachmentEpoch: epoch}, nil
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
	supervisor.handles[token] = id
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
	return &copy
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
