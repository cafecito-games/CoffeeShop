package hostsession

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"slices"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/harness"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

type Clock interface {
	Now() time.Time
}

type wallClock struct{}

func (wallClock) Now() time.Time { return time.Now() }

type Config struct {
	DataRoot       string
	NodeID         string
	WorkspaceRoots []string
	Drivers        []Driver
	Clock          Clock
	NewID          func() string
	// persistenceFailpoint is used only by same-package crash-barrier tests.
	persistenceFailpoint func(string) error
}

type CommandResponse struct {
	Ack    protocol.HostSessionControlMessage
	Result protocol.HostSessionControlMessage
}

type CoreUpdate struct {
	HostHarnessSessionID string
	AttachmentEpoch      int64
	ProviderTurnID       string
	Session              *protocol.HostHarnessSessionObservation
	Event                *protocol.HarnessEvent
	Resync               bool
	Delivered            chan bool
	DeliveryState        *atomic.Int32
}

type Supervisor struct {
	mu              sync.RWMutex
	registry        map[string]registryRecord
	providerToID    map[string]string
	ledger          map[string]ledgerRecord
	locks           map[string]*sync.Mutex
	providerLocks   map[string]*sync.Mutex
	creationLock    sync.Mutex
	drivers         map[string]Driver
	workspaceRoots  []string
	nodeID          string
	clock           Clock
	newID           func() string
	storage         persistence
	usable          atomic.Bool
	diagnostic      string
	closing         atomic.Bool
	admissionMu     sync.Mutex
	flightsMu       sync.Mutex
	flights         map[string]*commandFlight
	ctx             context.Context
	cancel          context.CancelFunc
	inflight        sync.WaitGroup
	updateMu        sync.Mutex
	updates         chan CoreUpdate
	historySlots    chan struct{}
	callbackCancels map[string]func()
	reservations    map[string]bool
}

type commandFlight struct {
	digest    string
	operation string
	done      chan struct{}
	response  CommandResponse
}

const (
	maxCommandLedgerRecords            = 8192
	retainedAcknowledgedCommandRecords = 4096
)

var errCommandLedgerCapacity = errors.New("command ledger capacity exhausted")
var maxConcurrentHistoryReads = protocol.HostHarnessSessionLimits.HistoryReadsPerNode
var historyReadTimeout = time.Duration(protocol.HostHarnessSessionLimits.HistoryResponseWaitMilliseconds-1000) * time.Millisecond

func Open(config Config) (*Supervisor, error) {
	if config.NodeID == "" || len(config.WorkspaceRoots) == 0 {
		return nil, fmt.Errorf("host-session node identity and workspace roots are required")
	}
	storage, err := newPersistence(config.DataRoot, config.persistenceFailpoint)
	if err != nil {
		return nil, err
	}
	if config.Clock == nil {
		config.Clock = wallClock{}
	}
	if config.NewID == nil {
		config.NewID = secureSessionID
	}
	ctx, cancel := context.WithCancel(context.Background())
	supervisor := &Supervisor{
		registry: make(map[string]registryRecord), providerToID: make(map[string]string),
		ledger: make(map[string]ledgerRecord), locks: make(map[string]*sync.Mutex), providerLocks: make(map[string]*sync.Mutex),
		drivers: make(map[string]Driver), workspaceRoots: slices.Clone(config.WorkspaceRoots),
		nodeID: config.NodeID, clock: config.Clock, newID: config.NewID, storage: storage,
		ctx: ctx, cancel: cancel,
		updates: make(chan CoreUpdate, 256), callbackCancels: make(map[string]func()), reservations: make(map[string]bool),
		flights: make(map[string]*commandFlight), historySlots: make(chan struct{}, maxConcurrentHistoryReads),
	}
	for _, driver := range config.Drivers {
		if driver == nil || driver.HarnessID() == "" {
			cancel()
			return nil, fmt.Errorf("host-session driver identity is required")
		}
		if _, duplicate := supervisor.drivers[driver.HarnessID()]; duplicate {
			cancel()
			return nil, fmt.Errorf("duplicate host-session driver")
		}
		supervisor.drivers[driver.HarnessID()] = driver
	}
	if err := supervisor.load(); err != nil {
		supervisor.diagnostic = "interactive host sessions unavailable: durable state is invalid; preserve the host-sessions directory and repair it"
		return supervisor, nil
	}
	supervisor.usable.Store(true)
	return supervisor, nil
}

func secureSessionID() string {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		panic("secure host-session identity generation failed")
	}
	return "host-session-" + hex.EncodeToString(bytes)
}

func (supervisor *Supervisor) Usable() bool { return supervisor.usable.Load() }

func (supervisor *Supervisor) Diagnostic() string {
	if supervisor.diagnostic != "" {
		return supervisor.diagnostic
	}
	if !supervisor.Usable() {
		return "interactive host sessions unavailable: persistence became uncertain; restart Barista before continuing"
	}
	return ""
}

func (supervisor *Supervisor) handlePersistenceFailure(err error) {
	if persistenceMayHaveCommitted(err) {
		supervisor.usable.Store(false)
	}
}

func (supervisor *Supervisor) disableAfterPersistenceFailure() {
	supervisor.usable.Store(false)
}

// Updates publishes bounded normalized observations. A consumer that cannot keep up must discard
// transport deltas and reconcile from Snapshot; provider effects are never retried for delivery.
func (supervisor *Supervisor) Updates() <-chan CoreUpdate { return supervisor.updates }

// InteractiveProfiles exposes only the protocol-advertisable driver operations. Provider process
// details and the broader internal operation set stay behind the Driver boundary.
func (supervisor *Supervisor) InteractiveProfiles() map[string]protocol.HostHarnessSessionInteractiveProfile {
	if !supervisor.Usable() || supervisor.closing.Load() {
		return nil
	}
	profiles := make(map[string]protocol.HostHarnessSessionInteractiveProfile, len(supervisor.drivers))
	for harnessID, driver := range supervisor.drivers {
		operations := make([]string, 0, 3)
		for _, operation := range driver.Capabilities().Operations() {
			switch operation {
			case OperationDiscover, OperationCreate, OperationAdopt:
				operations = append(operations, string(operation))
			}
		}
		sort.Strings(operations)
		profile := protocol.HostHarnessSessionInteractiveProfile{Operations: operations}
		if profile.Validate() == nil && len(operations) > 0 {
			profiles[harnessID] = profile
		}
	}
	return profiles
}

// Outcomes returns the completed durable command results used to converge a newly accepted Hub
// connection. Pending and uncertain ledger entries intentionally have no fabricated result.
func (supervisor *Supervisor) Outcomes() []protocol.HostSessionControlMessage {
	if !supervisor.Usable() {
		return nil
	}
	supervisor.mu.RLock()
	defer supervisor.mu.RUnlock()
	commandIDs := make([]string, 0, len(supervisor.ledger))
	for commandID, record := range supervisor.ledger {
		if record.State == commandCompleted && record.Result != nil && !record.Acknowledged {
			commandIDs = append(commandIDs, commandID)
		}
	}
	sort.Strings(commandIDs)
	results := make([]protocol.HostSessionControlMessage, 0, len(commandIDs))
	for _, commandID := range commandIDs {
		results = append(results, *supervisor.ledger[commandID].Result)
	}
	return results
}

// AcknowledgeOutcome records that the transport handed a completed result to its public socket
// boundary. A bounded replay window is retained for idempotent duplicates; only older completed
// records may be compacted, never pending/uncertain work or an outcome that was not handed off.
func (supervisor *Supervisor) AcknowledgeOutcome(commandID string) {
	if commandID == "" || !supervisor.Usable() {
		return
	}
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	record, found := supervisor.ledger[commandID]
	if !found || record.State != commandCompleted || record.Result == nil || record.Acknowledged {
		return
	}
	nextLedger := cloneLedger(supervisor.ledger)
	record.Acknowledged = true
	nextLedger[commandID] = record
	compactLedger(nextLedger, retainedAcknowledgedCommandRecords)
	if err := supervisor.storage.saveLedger(ledgerSlice(nextLedger)); err == nil {
		supervisor.ledger = nextLedger
	} else {
		supervisor.handlePersistenceFailure(err)
	}
}

func (supervisor *Supervisor) load() error {
	registry, err := supervisor.storage.loadRegistry()
	if err != nil {
		return err
	}
	ledger, err := supervisor.storage.loadLedger()
	if err != nil {
		return err
	}
	for _, record := range registry {
		if !record.Owned && record.Session.ControlMode == "full" && record.Session.AttachedThreadID != "" {
			record.Owned = true
		}
		if err := record.Session.Validate(); err != nil || record.Session.NodeID != supervisor.nodeID {
			return fmt.Errorf("invalid registry record")
		}
		canonical, err := harness.AuthorizeWorkspace(record.Session.Workspace, supervisor.workspaceRoots)
		if err != nil || canonical != record.Session.Workspace {
			return fmt.Errorf("registry workspace is no longer authorized")
		}
		id := record.Session.HostHarnessSessionID
		key := providerKey(record.Session.HarnessID, record.Session.Workspace, record.Session.ProviderSessionID)
		if _, duplicate := supervisor.registry[id]; duplicate || supervisor.providerToID[key] != "" {
			return fmt.Errorf("duplicate registry identity")
		}
		supervisor.registry[id] = record
		supervisor.providerToID[key] = id
		supervisor.locks[id] = &sync.Mutex{}
	}
	for _, record := range ledger {
		if record.CommandID == "" || record.CommandDigest == "" || record.Operation == "" {
			return fmt.Errorf("invalid command ledger identity")
		}
		if _, duplicate := supervisor.ledger[record.CommandID]; duplicate {
			return fmt.Errorf("duplicate command ledger identity")
		}
		if record.HostHarnessSessionID != "" && supervisor.registry[record.HostHarnessSessionID].Session.HostHarnessSessionID == "" {
			return fmt.Errorf("command ledger references an unknown session")
		}
		if record.State != commandPending && record.State != commandCompleted && record.State != commandUncertain {
			return fmt.Errorf("invalid command ledger state")
		}
		if record.State == commandCompleted && record.Result == nil || record.State != commandCompleted && record.Result != nil {
			return fmt.Errorf("command ledger outcome is inconsistent")
		}
		if record.State != commandCompleted && (record.CompletedAt != "" || record.Acknowledged) {
			return fmt.Errorf("command ledger acknowledgement is inconsistent")
		}
		if record.Result != nil {
			if record.CompletedAt == "" {
				record.CompletedAt = record.Result.At
			}
			if _, timeErr := time.Parse(time.RFC3339Nano, record.CompletedAt); timeErr != nil {
				return fmt.Errorf("invalid command ledger completion time")
			}
			encoded, marshalErr := record.Result.MarshalJSON()
			if marshalErr != nil {
				return fmt.Errorf("invalid command ledger result")
			}
			if _, decodeErr := protocol.DecodeHostSessionControlMessage(encoded, "6"); decodeErr != nil {
				return fmt.Errorf("invalid command ledger result")
			}
			if record.Result.Session != nil && supervisor.registry[record.Result.Session.HostHarnessSessionID].Session.HostHarnessSessionID == "" {
				return fmt.Errorf("command ledger result references an unknown session")
			}
		}
		if record.State == commandPending {
			record.State = commandUncertain
		}
		supervisor.ledger[record.CommandID] = record
	}
	return nil
}

func providerKey(harnessID, workspace, providerSessionID string) string {
	return harnessID + "\x00" + workspace + "\x00" + providerSessionID
}

func (supervisor *Supervisor) now() string {
	return supervisor.clock.Now().UTC().Format(time.RFC3339Nano)
}

func (supervisor *Supervisor) Snapshot() ([]protocol.HostHarnessSessionObservation, error) {
	if !supervisor.Usable() {
		return nil, errors.New(supervisor.Diagnostic())
	}
	supervisor.mu.RLock()
	defer supervisor.mu.RUnlock()
	result := make([]protocol.HostHarnessSessionObservation, 0, len(supervisor.registry))
	for _, record := range supervisor.registry {
		canonical, err := harness.AuthorizeWorkspace(record.Session.Workspace, supervisor.workspaceRoots)
		if err != nil || canonical != record.Session.Workspace {
			return nil, fmt.Errorf("host-session workspace is no longer authorized")
		}
		result = append(result, record.Session.HostHarnessSessionObservation)
	}
	sort.Slice(result, func(left, right int) bool {
		return result[left].HostHarnessSessionID < result[right].HostHarnessSessionID
	})
	return result, nil
}

func (supervisor *Supervisor) RecoverySnapshot() ([]protocol.HostHarnessSessionObservation, error) {
	if !supervisor.Usable() {
		return nil, errors.New(supervisor.Diagnostic())
	}
	supervisor.mu.RLock()
	defer supervisor.mu.RUnlock()
	result := make([]protocol.HostHarnessSessionObservation, 0)
	for _, record := range supervisor.registry {
		if record.Owned && (record.Session.ControlMode == "full" || record.Session.Status == "active-elsewhere") {
			result = append(result, record.Session.HostHarnessSessionObservation)
		}
	}
	sort.Slice(result, func(left, right int) bool {
		return result[left].HostHarnessSessionID < result[right].HostHarnessSessionID
	})
	return result, nil
}

func (supervisor *Supervisor) Discover(ctx context.Context, harnessID string) ([]protocol.HostHarnessSessionObservation, error) {
	if !supervisor.Usable() || supervisor.closing.Load() {
		return nil, errors.New("interactive host sessions unavailable")
	}
	driver, err := supervisor.driverFor(harnessID, OperationDiscover)
	if err != nil {
		return nil, err
	}
	page, err := driver.Discover(ctx, DiscoverRequest{Limit: protocol.HostHarnessSessionLimits.SessionsPerGeneration})
	if err != nil {
		return nil, fmt.Errorf("driver discovery failed")
	}
	if len(page.Sessions) > protocol.HostHarnessSessionLimits.SessionsPerGeneration || page.NextCursor != "" || page.Truncated {
		return nil, fmt.Errorf("driver discovery exceeded the bounded single-page core request")
	}

	supervisor.creationLock.Lock()
	defer supervisor.creationLock.Unlock()
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	nextRegistry := cloneRegistry(supervisor.registry)
	nextProviders := cloneStrings(supervisor.providerToID)
	result := make([]protocol.HostHarnessSessionObservation, 0, len(page.Sessions))
	seenProviders := make(map[string]bool)
	for _, candidate := range page.Sessions {
		canonical, authErr := harness.AuthorizeWorkspace(candidate.Workspace, supervisor.workspaceRoots)
		if authErr != nil || canonical != candidate.Workspace {
			return nil, fmt.Errorf("driver discovery contained an unauthorized workspace")
		}
		key := providerKey(harnessID, canonical, candidate.ProviderSessionID)
		if seenProviders[key] {
			return nil, fmt.Errorf("driver discovery contained an ambiguous provider identity")
		}
		seenProviders[key] = true
		id := nextProviders[key]
		if id == "" {
			id = supervisor.newID()
			if id == "" || nextRegistry[id].Session.HostHarnessSessionID != "" {
				return nil, fmt.Errorf("host-session identity generation failed")
			}
			observation, observationErr := supervisor.initialObservation(id, harnessID, candidate)
			if observationErr != nil {
				return nil, observationErr
			}
			nextRegistry[id] = registryRecord{Session: protocol.HostHarnessSession{HostHarnessSessionObservation: observation}}
			nextProviders[key] = id
		} else {
			// Discovery identifies a provider thread by its stable provider key. Preserve the source
			// recorded when Coffee Shop created or adopted it rather than letting provider history
			// relabel the same thread and trip the immutable identity fence.
			candidate.Source = nextRegistry[id].Session.Source
			if err := validateDriverIdentity(nextRegistry[id].Session, candidate); err != nil {
				return nil, err
			}
		}
		result = append(result, nextRegistry[id].Session.HostHarnessSessionObservation)
	}
	retained, retainErr := retainRegistry(nextRegistry, supervisor.ledger, protocol.HostHarnessSessionLimits.SessionsPerGeneration-len(supervisor.reservations))
	if retainErr != nil {
		return nil, retainErr
	}
	nextRegistry = retained
	nextProviders = make(map[string]string, len(nextRegistry))
	for id, record := range nextRegistry {
		nextProviders[providerKey(record.Session.HarnessID, record.Session.Workspace, record.Session.ProviderSessionID)] = id
	}
	result = slices.DeleteFunc(result, func(observation protocol.HostHarnessSessionObservation) bool {
		_, retained := nextRegistry[observation.HostHarnessSessionID]
		return !retained
	})
	if err := supervisor.storage.saveRegistry(registrySlice(nextRegistry)); err != nil {
		supervisor.handlePersistenceFailure(err)
		return nil, fmt.Errorf("persist discovered sessions: %w", err)
	}
	supervisor.registry = nextRegistry
	supervisor.providerToID = nextProviders
	for id, record := range nextRegistry {
		if supervisor.locks[id] == nil {
			key := providerKey(record.Session.HarnessID, record.Session.Workspace, record.Session.ProviderSessionID)
			if providerLock := supervisor.providerLocks[key]; providerLock != nil {
				supervisor.locks[id] = providerLock
			} else {
				supervisor.locks[id] = &sync.Mutex{}
			}
		}
	}
	return result, nil
}

func (supervisor *Supervisor) ReadHistory(ctx context.Context, sessionID, requestID, cursor string, limit int) (HistoryPage, error) {
	if !supervisor.Usable() || supervisor.closing.Load() {
		return HistoryPage{}, errors.New("interactive host sessions unavailable")
	}
	if requestID == "" || limit < 1 || limit > protocol.HostHarnessSessionLimits.HistoryItemsPerPage || len(cursor) > protocol.HostHarnessSessionLimits.HistoryCursorBytes {
		return HistoryPage{}, fmt.Errorf("history request is malformed")
	}
	select {
	case supervisor.historySlots <- struct{}{}:
		defer func() { <-supervisor.historySlots }()
	default:
		return HistoryPage{}, fmt.Errorf("history-busy")
	}
	readContext, cancel := context.WithTimeout(supervisor.ctx, historyReadTimeout)
	defer cancel()
	record, driver, err := supervisor.sessionAndDriver(sessionID, OperationReadHistory)
	if err != nil {
		return HistoryPage{}, err
	}
	if !slices.Contains(record.Session.Operations, "read-history") {
		return HistoryPage{}, fmt.Errorf("unsupported-capability")
	}
	page, err := driver.ReadHistory(readContext, ReadHistoryRequest{Session: driverSession(record.Session), Cursor: cursor, Limit: limit})
	if err != nil {
		return HistoryPage{}, fmt.Errorf("driver history read failed")
	}
	if len(page.Items) > limit || len(page.Items) > protocol.HostHarnessSessionLimits.HistoryItemsPerPage || len(page.NextCursor) > protocol.HostHarnessSessionLimits.HistoryCursorBytes {
		return HistoryPage{}, fmt.Errorf("driver history page exceeded bounds")
	}
	message := protocol.HostSessionControlMessage{
		Type: "host-session.history.page", NodeID: supervisor.nodeID, HostHarnessSessionID: sessionID,
		RequestID: requestID, Items: page.Items, NextCursor: page.NextCursor, Truncated: page.Truncated, At: supervisor.now(),
	}
	encoded, err := message.MarshalJSON()
	if err != nil {
		return HistoryPage{}, fmt.Errorf("driver history page is invalid")
	}
	if _, err := protocol.DecodeHostSessionControlMessage(encoded, "6"); err != nil {
		return HistoryPage{}, fmt.Errorf("driver history page is invalid")
	}
	return page, nil
}

func (supervisor *Supervisor) Refresh(ctx context.Context, sessionID string) (protocol.HostHarnessSessionObservation, error) {
	return supervisor.observe(ctx, sessionID, OperationRefresh)
}

func (supervisor *Supervisor) Reconcile(ctx context.Context, sessionID string) (protocol.HostHarnessSessionObservation, error) {
	return supervisor.observe(ctx, sessionID, OperationReconcile)
}

func (supervisor *Supervisor) observe(ctx context.Context, sessionID string, operation Operation) (protocol.HostHarnessSessionObservation, error) {
	if !supervisor.Usable() || supervisor.closing.Load() {
		return protocol.HostHarnessSessionObservation{}, errors.New("interactive host sessions unavailable")
	}
	supervisor.mu.RLock()
	lock := supervisor.locks[sessionID]
	supervisor.mu.RUnlock()
	if lock == nil || !lock.TryLock() {
		return protocol.HostHarnessSessionObservation{}, fmt.Errorf("session-busy")
	}
	defer lock.Unlock()
	record, driver, err := supervisor.sessionAndDriver(sessionID, operation)
	if err != nil {
		return protocol.HostHarnessSessionObservation{}, err
	}
	request := sessionRequest(record.Session, protocol.HostSessionHubMessage{})
	activate, abort := gateDriverCallbacks(&request)
	request.Observe = supervisor.sessionObserver(sessionID, record.Session.HarnessID, record.Session.Workspace, record.Session.ProviderSessionID, record.Session.AttachmentEpoch, nil)
	var observed DriverSession
	if operation == OperationRefresh {
		observed, err = driver.Refresh(ctx, request)
	} else {
		observed, err = driver.Reconcile(ctx, request)
	}
	driverSucceeded := err == nil
	if err != nil {
		abort()
		var rejection DriverRejection
		if errors.As(err, &rejection) && rejection.Observation != nil {
			observed = *rejection.Observation
		} else if operation == OperationReconcile {
			observed = driverSession(record.Session)
			observed.Status = "active-elsewhere"
			observed.ControlMode = "observe"
			observed.Operations = []string{"attach", "close", "read-history"}
			observed.ProviderTurnID = ""
		} else {
			return protocol.HostHarnessSessionObservation{}, fmt.Errorf("provider-observation-failed")
		}
	}
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	currentRecord := supervisor.registry[sessionID]
	current := currentRecord.Session
	observed = preserveAttachedRecoveryOperation(currentRecord, observed)
	var next protocol.HostHarnessSession
	if current.Revision > record.Session.Revision {
		if err := validateDriverIdentity(current, observed); err != nil {
			abort()
			return protocol.HostHarnessSessionObservation{}, fmt.Errorf("provider-result-invalid")
		}
		next = current
	} else {
		next, err = supervisor.applyObservation(current, observed)
		if err != nil {
			abort()
			return protocol.HostHarnessSessionObservation{}, fmt.Errorf("provider-result-invalid")
		}
	}
	nextRegistry := cloneRegistry(supervisor.registry)
	nextRegistry[sessionID] = registryRecord{Session: next, Owned: currentRecord.Owned}
	if err := supervisor.storage.saveRegistry(registrySlice(nextRegistry)); err != nil {
		abort()
		supervisor.handlePersistenceFailure(err)
		return protocol.HostHarnessSessionObservation{}, fmt.Errorf("durability-uncertain")
	}
	supervisor.registry = nextRegistry
	if driverSucceeded {
		activate()
	} else {
		abort()
	}
	return next.HostHarnessSessionObservation, nil
}

func (supervisor *Supervisor) Execute(_ context.Context, command protocol.HostSessionHubMessage) (response CommandResponse) {
	operation := commandOperation(command.Type)
	if !supervisor.Usable() {
		return supervisor.rejection(command, operation, "supervision-unavailable")
	}
	supervisor.admissionMu.Lock()
	if supervisor.closing.Load() {
		supervisor.admissionMu.Unlock()
		return supervisor.rejection(command, operation, "supervision-unavailable")
	}
	supervisor.inflight.Add(1)
	supervisor.admissionMu.Unlock()
	defer supervisor.inflight.Done()
	encoded, err := command.MarshalJSON()
	if err != nil {
		return supervisor.rejection(command, operation, "invalid-command")
	}
	validated, err := protocol.DecodeHostSessionHubMessage(encoded, "6")
	if err != nil || validated.NodeID != supervisor.nodeID {
		return supervisor.rejection(command, operation, "invalid-command")
	}
	command = validated
	flight, owner, conflict := supervisor.beginFlight(command, operation)
	if conflict {
		return supervisor.rejection(command, operation, "idempotency-conflict")
	}
	if !owner {
		<-flight.done
		return flight.response
	}
	defer func() { supervisor.finishFlight(command.CommandID, response) }()
	if replay, found := supervisor.replay(command, operation); found {
		return replay
	}

	var lock *sync.Mutex
	if command.HostHarnessSessionID == "" {
		if command.Type == "host-session.adopt" {
			key := providerKey(command.HarnessID, command.Workspace, command.ProviderSessionID)
			supervisor.mu.Lock()
			existingID := supervisor.providerToID[key]
			lock = supervisor.locks[existingID]
			if lock == nil {
				lock = supervisor.providerLocks[key]
				if lock == nil && len(supervisor.providerLocks) < protocol.HostHarnessSessionLimits.SessionsPerGeneration {
					lock = &sync.Mutex{}
					supervisor.providerLocks[key] = lock
				}
			}
			supervisor.mu.Unlock()
		}
		if lock == nil {
			lock = &supervisor.creationLock
		}
	} else {
		supervisor.mu.RLock()
		lock = supervisor.locks[command.HostHarnessSessionID]
		supervisor.mu.RUnlock()
	}
	if lock == nil || !lock.TryLock() {
		return supervisor.rejection(command, operation, "session-busy")
	}
	defer lock.Unlock()
	if replay, found := supervisor.replay(command, operation); found {
		return replay
	}

	prepared, err := supervisor.prepare(command, operation)
	if err != nil {
		return supervisor.rejection(command, operation, stableCode(err))
	}
	if prepared.reserved {
		defer supervisor.releaseRegistryReservation(command.CommandID)
	}
	if err := supervisor.recordPending(command, operation); err != nil {
		if errors.Is(err, errCommandLedgerCapacity) {
			return supervisor.rejection(command, operation, "capacity-conflict")
		}
		return supervisor.rejection(command, operation, "durability-failed")
	}

	observed, driverErr := prepared.invoke(supervisor.ctx)
	if driverErr != nil {
		if prepared.cancelCallbacks != nil {
			prepared.cancelCallbacks()
		}
		var rejection DriverRejection
		if errors.As(driverErr, &rejection) {
			if rejection.Observation != nil {
				if err := supervisor.recordRejectedObservation(command, *rejection.Observation); err != nil {
					return supervisor.markUncertain(command, operation, "durability-uncertain")
				}
			}
			return supervisor.completeRejected(command, operation, boundedCode(rejection.Code))
		}
		return supervisor.markUncertain(command, operation, "provider-effect-uncertain")
	}
	return supervisor.complete(command, operation, prepared, observed)
}

func (supervisor *Supervisor) recordRejectedObservation(command protocol.HostSessionHubMessage, observed DriverSession) error {
	if supervisor.closing.Load() {
		return fmt.Errorf("supervision is closing")
	}
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	id := command.HostHarnessSessionID
	if id == "" {
		id = supervisor.providerToID[providerKey(command.HarnessID, command.Workspace, command.ProviderSessionID)]
	}
	current, found := supervisor.registry[id]
	if !found {
		return nil
	}
	observed = preserveAttachedRecoveryOperation(current, observed)
	next, err := supervisor.applyObservation(current.Session, observed)
	if err != nil {
		return err
	}
	nextRegistry := cloneRegistry(supervisor.registry)
	nextRegistry[id] = registryRecord{Session: next, Owned: current.Owned}
	if err := supervisor.storage.saveRegistry(registrySlice(nextRegistry)); err != nil {
		supervisor.handlePersistenceFailure(err)
		return err
	}
	supervisor.registry = nextRegistry
	observation := next.HostHarnessSessionObservation
	supervisor.publishUpdate(CoreUpdate{HostHarnessSessionID: id, AttachmentEpoch: next.AttachmentEpoch, ProviderTurnID: next.ProviderTurnID, Session: &observation})
	return nil
}

type preparedCommand struct {
	record          protocol.HostHarnessSession
	driver          Driver
	invoke          func(context.Context) (DriverSession, error)
	rollback        func(string)
	cancelCallbacks func()
	activate        func()
	setProviderTurn func(string)
	reserved        bool
}

type claimReleaser interface {
	ReleaseClaim(string)
}

func (supervisor *Supervisor) prepare(command protocol.HostSessionHubMessage, operation string) (preparedCommand, error) {
	if command.Type == "host-session.create" || command.Type == "host-session.adopt" {
		canonical, err := harness.AuthorizeWorkspace(command.Workspace, supervisor.workspaceRoots)
		if err != nil || canonical != command.Workspace {
			return preparedCommand{}, fmt.Errorf("workspace-unauthorized")
		}
		required := OperationCreate
		if command.Type == "host-session.adopt" {
			required = OperationAdopt
		}
		driver, err := supervisor.driverFor(command.HarnessID, required)
		if err != nil {
			return preparedCommand{}, err
		}
		request := SessionRequest{ProviderSessionID: command.ProviderSessionID, Workspace: canonical, Source: "coffee-shop-managed", Model: command.Model}
		activate, abort := gateDriverCallbacks(&request)
		var rollback func(string)
		if releaser, ok := driver.(claimReleaser); ok {
			rollback = func(providerSessionID string) {
				releaser.ReleaseClaim(providerSessionID)
				if command.ProviderSessionID != "" && command.ProviderSessionID != providerSessionID {
					releaser.ReleaseClaim(command.ProviderSessionID)
				}
			}
		}
		if command.Type == "host-session.adopt" {
			supervisor.mu.RLock()
			existingID := supervisor.providerToID[providerKey(command.HarnessID, canonical, command.ProviderSessionID)]
			existing := supervisor.registry[existingID].Session
			supervisor.mu.RUnlock()
			if existing.Status == "closed" || existing.Status == "failed" || existing.AttachedThreadID != "" || existing.ControlMode == "full" {
				return preparedCommand{}, fmt.Errorf("illegal-transition")
			}
			if existing.HostHarnessSessionID != "" {
				request.Source = existing.Source
				request.Summary = existing.Summary
				request.Observe = supervisor.sessionObserver(existing.HostHarnessSessionID, command.HarnessID, canonical, command.ProviderSessionID, existing.AttachmentEpoch, nil)
			} else {
				request.Observe = supervisor.sessionObserver("", command.HarnessID, canonical, command.ProviderSessionID, 0, nil)
			}
			if !driver.Capabilities().Supports(OperationInspect) {
				return preparedCommand{}, fmt.Errorf("unsupported-capability")
			}
			inspectContext, cancelInspect := context.WithTimeout(supervisor.ctx, historyReadTimeout)
			inspected, inspectErr := driver.Inspect(inspectContext, request)
			cancelInspect()
			if inspectErr != nil {
				return preparedCommand{}, fmt.Errorf("provider-inspection-failed")
			}
			if inspected.ProviderSessionID != command.ProviderSessionID || inspected.Workspace != canonical {
				return preparedCommand{}, fmt.Errorf("provider-identity-conflict")
			}
			if existing.HostHarnessSessionID == "" {
				request.Source = inspected.Source
				request.Summary = inspected.Summary
			}
			request.Status = inspected.Status
			request.ControlMode = inspected.ControlMode
			request.Operations = slices.Clone(inspected.Operations)
			reserved, reserveErr := supervisor.reserveRegistrySlot(command.CommandID, command.HarnessID, canonical, command.ProviderSessionID)
			if reserveErr != nil {
				return preparedCommand{}, reserveErr
			}
			return preparedCommand{driver: driver, rollback: rollback, reserved: reserved, activate: activate, cancelCallbacks: abort, invoke: func(ctx context.Context) (DriverSession, error) { return driver.Adopt(ctx, request) }}, nil
		}
		request.Observe = supervisor.sessionObserver("", command.HarnessID, canonical, "", 0, nil)
		reserved, reserveErr := supervisor.reserveRegistrySlot(command.CommandID, command.HarnessID, canonical, command.ProviderSessionID)
		if reserveErr != nil {
			return preparedCommand{}, reserveErr
		}
		return preparedCommand{driver: driver, rollback: rollback, reserved: reserved, activate: activate, cancelCallbacks: abort, invoke: func(ctx context.Context) (DriverSession, error) { return driver.Create(ctx, request) }}, nil
	}

	record, driver, err := supervisor.sessionAndDriver(command.HostHarnessSessionID, driverOperation(command.Type))
	if err != nil {
		return preparedCommand{}, err
	}
	if sessionOperation := commandSessionOperation(command.Type); sessionOperation == "" || !slices.Contains(record.Session.Operations, sessionOperation) {
		return preparedCommand{}, fmt.Errorf("unsupported-capability")
	}
	if !legalCommandState(command.Type, record.Session.Status) {
		return preparedCommand{}, fmt.Errorf("illegal-transition")
	}
	if command.AttachmentEpoch == nil || *command.AttachmentEpoch != record.Session.AttachmentEpoch {
		return preparedCommand{}, fmt.Errorf("attachment-epoch-conflict")
	}
	if command.Type == "host-session.attach" {
		if record.Session.AttachedThreadID != "" || command.ExpectedStatus != record.Session.Status {
			return preparedCommand{}, fmt.Errorf("attachment-conflict")
		}
	} else if command.Type == "host-session.detach" {
		if record.Session.AttachedThreadID != command.ThreadID {
			return preparedCommand{}, fmt.Errorf("attachment-conflict")
		}
	} else if command.Type != "host-session.close" && record.Session.AttachedThreadID == "" {
		return preparedCommand{}, fmt.Errorf("session-not-attached")
	}
	request := sessionRequest(record.Session, command)
	callbackActive := &atomic.Bool{}
	callbackActive.Store(true)
	callbacksActivated := &atomic.Bool{}
	callbacksActivated.Store(command.Type != "host-session.turn.start")
	var callbackTurn atomic.Value
	callbackTurn.Store(command.ProviderTurnID)
	var activate func()
	var abort func()
	if command.Type == "host-session.turn.start" || command.Type == "host-session.attach" {
		activateGate, abortGate := gateDriverCallbacks(&request)
		activate = func() {
			callbacksActivated.Store(true)
			activateGate()
		}
		abort = abortGate
	}
	request.Emit = func(event protocol.HarnessEvent) error {
		if !callbackActive.Load() || !callbacksActivated.Load() || event.RunID != command.RunID {
			return fmt.Errorf("late or mismatched driver callback")
		}
		if err := event.Validate(); err != nil {
			return fmt.Errorf("invalid driver callback")
		}
		epoch := record.Session.AttachmentEpoch
		message := protocol.HostSessionControlMessage{
			Type: "host-session.harness-event", NodeID: supervisor.nodeID,
			HostHarnessSessionID: record.Session.HostHarnessSessionID,
			AttachmentEpoch:      &epoch, ProviderTurnID: callbackTurn.Load().(string), Event: &event,
		}
		encoded, err := message.MarshalJSON()
		if err != nil {
			return fmt.Errorf("invalid driver callback")
		}
		if _, err := protocol.DecodeHostSessionControlMessage(encoded, "6"); err != nil {
			return fmt.Errorf("invalid driver callback")
		}
		copy := event
		update := CoreUpdate{
			HostHarnessSessionID: record.Session.HostHarnessSessionID,
			AttachmentEpoch:      record.Session.AttachmentEpoch,
			ProviderTurnID:       callbackTurn.Load().(string),
			Event:                &copy,
		}
		if event.Type == "permission.requested" {
			update.Delivered = make(chan bool, 1)
			update.DeliveryState = &atomic.Int32{}
		}
		if !supervisor.publishUpdate(update) {
			return fmt.Errorf("driver callback delivery overflow")
		}
		if update.Delivered == nil {
			return nil
		}
		timer := time.NewTimer(15 * time.Second)
		defer timer.Stop()
		stopped := supervisor.ctx.Done()
		for {
			select {
			case delivered := <-update.Delivered:
				if !delivered {
					return fmt.Errorf("driver callback was not delivered")
				}
				return nil
			case <-timer.C:
				if update.DeliveryState.CompareAndSwap(0, -1) {
					return fmt.Errorf("driver callback delivery timed out")
				}
				// A transport write has already started. Its own bounded deadline now owns
				// completion; cancelling here could leave a delivered approval dangling.
			case <-stopped:
				if update.DeliveryState.CompareAndSwap(0, -1) {
					return fmt.Errorf("driver callback delivery stopped")
				}
				stopped = nil
			}
		}
	}
	observerEpoch := record.Session.AttachmentEpoch
	if command.Type == "host-session.attach" {
		observerEpoch++
	}
	request.Observe = supervisor.sessionObserver(record.Session.HostHarnessSessionID, record.Session.HarnessID, record.Session.Workspace, record.Session.ProviderSessionID, observerEpoch, func() {
		callbackActive.Store(false)
	})
	invoke := func(ctx context.Context) (DriverSession, error) { return driver.Refresh(ctx, request) }
	switch command.Type {
	case "host-session.attach":
		invoke = func(ctx context.Context) (DriverSession, error) { return driver.Resume(ctx, request) }
	case "host-session.detach":
		invoke = func(ctx context.Context) (DriverSession, error) { return driver.Detach(ctx, request) }
	case "host-session.turn.start":
		invoke = func(ctx context.Context) (DriverSession, error) { return driver.StartTurn(ctx, request) }
	case "host-session.turn.steer":
		invoke = func(ctx context.Context) (DriverSession, error) { return driver.Steer(ctx, request) }
	case "host-session.turn.interrupt":
		invoke = func(ctx context.Context) (DriverSession, error) { return driver.Interrupt(ctx, request) }
	case "host-session.approval.decision":
		invoke = func(ctx context.Context) (DriverSession, error) { return driver.ResolveApproval(ctx, request) }
	case "host-session.close":
		invoke = func(ctx context.Context) (DriverSession, error) { return driver.Close(ctx, request) }
	}
	return preparedCommand{record: record.Session, driver: driver, activate: activate, setProviderTurn: func(id string) { callbackTurn.Store(id) }, cancelCallbacks: func() {
		callbackActive.Store(false)
		if abort != nil {
			abort()
		}
	}, invoke: func(ctx context.Context) (DriverSession, error) {
		if command.Type != "host-session.turn.start" {
			defer callbackActive.Store(false)
		}
		return invoke(ctx)
	}}, nil
}

func gateDriverCallbacks(request *SessionRequest) (func(), func()) {
	activated := make(chan struct{})
	aborted := make(chan struct{})
	var activateOnce sync.Once
	var abortOnce sync.Once
	request.Activated = activated
	request.Aborted = aborted
	return func() { activateOnce.Do(func() { close(activated) }) }, func() { abortOnce.Do(func() { close(aborted) }) }
}

func (supervisor *Supervisor) sessionObserver(sessionID, harnessID, workspace, providerSessionID string, attachmentEpoch int64, onTerminal func()) func(DriverSession) error {
	return func(observed DriverSession) error {
		if supervisor.closing.Load() {
			return fmt.Errorf("late driver observation")
		}
		supervisor.mu.Lock()
		defer supervisor.mu.Unlock()
		resolvedID := sessionID
		if resolvedID == "" {
			resolvedID = supervisor.providerToID[providerKey(harnessID, workspace, observed.ProviderSessionID)]
		}
		current, found := supervisor.registry[resolvedID]
		if !found || current.Session.AttachmentEpoch != attachmentEpoch || current.Session.HarnessID != harnessID ||
			current.Session.Workspace != workspace || (providerSessionID != "" && current.Session.ProviderSessionID != providerSessionID) {
			return fmt.Errorf("stale driver observation")
		}
		observed = preserveAttachedRecoveryOperation(current, observed)
		next, err := supervisor.applyObservation(current.Session, observed)
		if err != nil {
			return fmt.Errorf("invalid driver observation")
		}
		terminal := next.Status == "idle" || next.Status == "closed" || next.Status == "failed" || next.Status == "active-elsewhere"
		if terminal {
			next.ActiveRunID = ""
			delete(supervisor.callbackCancels, next.HostHarnessSessionID)
		}
		nextRegistry := cloneRegistry(supervisor.registry)
		nextRegistry[next.HostHarnessSessionID] = registryRecord{Session: next, Owned: current.Owned}
		if err := supervisor.storage.saveRegistry(registrySlice(nextRegistry)); err != nil {
			supervisor.handlePersistenceFailure(err)
			return fmt.Errorf("persist driver observation")
		}
		supervisor.registry = nextRegistry
		if terminal && onTerminal != nil {
			onTerminal()
		}
		observation := next.HostHarnessSessionObservation
		supervisor.publishUpdate(CoreUpdate{HostHarnessSessionID: next.HostHarnessSessionID, AttachmentEpoch: next.AttachmentEpoch, ProviderTurnID: next.ProviderTurnID, Session: &observation})
		return nil
	}
}

func preserveAttachedRecoveryOperation(record registryRecord, observed DriverSession) DriverSession {
	if record.Owned && record.Session.AttachedThreadID != "" && observed.ControlMode != "full" && observed.Status != "closed" && observed.Status != "failed" {
		observed.Status = "active-elsewhere"
		observed.ControlMode = "observe"
		observed.ProviderTurnID = ""
		operations := []string{"attach", "close", "detach", "read-history"}
		observed.Operations = slices.DeleteFunc(operations, func(operation string) bool {
			return operation != "detach" && !slices.Contains(observed.Operations, operation)
		})
		sort.Strings(observed.Operations)
	}
	return observed
}

func (supervisor *Supervisor) complete(command protocol.HostSessionHubMessage, operation string, prepared preparedCommand, observed DriverSession) CommandResponse {
	settled := false
	defer func() {
		if !settled && prepared.rollback != nil {
			prepared.rollback(observed.ProviderSessionID)
		}
		if !settled && prepared.cancelCallbacks != nil {
			prepared.cancelCallbacks()
		}
	}()
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	if prepared.reserved {
		delete(supervisor.reservations, command.CommandID)
	}
	nextRegistry := cloneRegistry(supervisor.registry)
	nextProviders := cloneStrings(supervisor.providerToID)
	var session protocol.HostHarnessSession
	if prepared.record.HostHarnessSessionID == "" {
		canonical, err := harness.AuthorizeWorkspace(observed.Workspace, supervisor.workspaceRoots)
		if err != nil || canonical != command.Workspace || observed.ProviderSessionID == "" || (command.ProviderSessionID != "" && observed.ProviderSessionID != command.ProviderSessionID) {
			return supervisor.markUncertainLocked(command, operation, "provider-result-invalid")
		}
		key := providerKey(command.HarnessID, canonical, observed.ProviderSessionID)
		id := nextProviders[key]
		if id == "" {
			id = supervisor.newID()
		}
		if existing := nextRegistry[id].Session; existing.HostHarnessSessionID != "" {
			if err := validateDriverIdentity(existing, observed); err != nil {
				return supervisor.markUncertainLocked(command, operation, "provider-identity-conflict")
			}
			updated, err := supervisor.applyObservation(existing, observed)
			if err != nil {
				return supervisor.markUncertainLocked(command, operation, "provider-result-invalid")
			}
			session = updated
		} else {
			observation, err := supervisor.initialObservation(id, command.HarnessID, observed)
			if err != nil {
				return supervisor.markUncertainLocked(command, operation, "provider-result-invalid")
			}
			session = protocol.HostHarnessSession{HostHarnessSessionObservation: observation}
		}
		nextProviders[key] = id
	} else {
		currentRecord := nextRegistry[prepared.record.HostHarnessSessionID]
		session = currentRecord.Session
		if session.HostHarnessSessionID == "" {
			return supervisor.markUncertainLocked(command, operation, "provider-result-invalid")
		}
		if session.Revision > prepared.record.Revision && command.Type != "host-session.detach" && command.Type != "host-session.close" {
			if err := validateDriverIdentity(session, observed); err != nil {
				return supervisor.markUncertainLocked(command, operation, "provider-result-invalid")
			}
		} else {
			next, err := supervisor.applyObservation(session, observed)
			if err != nil {
				return supervisor.markUncertainLocked(command, operation, "provider-result-invalid")
			}
			session = next
		}
	}

	switch command.Type {
	case "host-session.attach":
		session.AttachedThreadID = command.ThreadID
		session.AttachmentEpoch++
	case "host-session.detach":
		session.AttachedThreadID = ""
		session.ActiveRunID = ""
		session.AttachmentEpoch++
	case "host-session.turn.start":
		session.ActiveRunID = command.RunID
	case "host-session.turn.interrupt":
		session.ActiveRunID = ""
	case "host-session.close":
		session.ActiveRunID = ""
		if session.AttachedThreadID != "" {
			session.AttachedThreadID = ""
			session.AttachmentEpoch++
		}
	}
	owned := true
	if existing := nextRegistry[session.HostHarnessSessionID]; existing.Session.HostHarnessSessionID != "" {
		owned = existing.Owned || command.Type == "host-session.create" || command.Type == "host-session.adopt" || command.Type == "host-session.attach"
	}
	if command.Type == "host-session.detach" {
		owned = false
	}
	recovered := preserveAttachedRecoveryOperation(registryRecord{Session: session, Owned: owned}, driverSession(session))
	if session.Status != recovered.Status || session.ControlMode != recovered.ControlMode ||
		session.ProviderTurnID != recovered.ProviderTurnID || !slices.Equal(session.Operations, recovered.Operations) {
		normalized, err := supervisor.applyObservation(session, recovered)
		if err != nil {
			return supervisor.markUncertainLocked(command, operation, "provider-result-invalid")
		}
		session = normalized
	}
	record := registryRecord{Session: session, Owned: owned}
	nextRegistry[session.HostHarnessSessionID] = record
	retained, retainErr := retainRegistry(nextRegistry, supervisor.ledger, protocol.HostHarnessSessionLimits.SessionsPerGeneration-len(supervisor.reservations))
	if retainErr != nil {
		return supervisor.markUncertainLocked(command, operation, "provider-result-invalid")
	}
	nextRegistry = retained
	nextProviders = make(map[string]string, len(nextRegistry))
	for id, retainedRecord := range nextRegistry {
		nextProviders[providerKey(retainedRecord.Session.HarnessID, retainedRecord.Session.Workspace, retainedRecord.Session.ProviderSessionID)] = id
	}
	if err := supervisor.storage.saveRegistry(registrySlice(nextRegistry)); err != nil {
		supervisor.handlePersistenceFailure(err)
		if command.Type == "host-session.turn.start" && prepared.cancelCallbacks != nil {
			prepared.cancelCallbacks()
		}
		if command.Type == "host-session.detach" || command.Type == "host-session.turn.interrupt" || command.Type == "host-session.close" {
			if cancel := supervisor.callbackCancels[session.HostHarnessSessionID]; cancel != nil {
				cancel()
				delete(supervisor.callbackCancels, session.HostHarnessSessionID)
			}
		}
		return supervisor.markUncertainLocked(command, operation, "durability-uncertain")
	}
	supervisor.registry = nextRegistry
	supervisor.providerToID = nextProviders
	// The provider effect and registry projection now agree durably. From this point onward a
	// command-ledger failure must not release the writer or abort callbacks, because doing so would
	// make the already-committed registry lie about ownership.
	settled = true
	if supervisor.locks[session.HostHarnessSessionID] == nil {
		key := providerKey(session.HarnessID, session.Workspace, session.ProviderSessionID)
		if providerLock := supervisor.providerLocks[key]; providerLock != nil {
			supervisor.locks[session.HostHarnessSessionID] = providerLock
		} else {
			supervisor.locks[session.HostHarnessSessionID] = &sync.Mutex{}
		}
	}
	if command.Type == "host-session.detach" || command.Type == "host-session.turn.interrupt" || command.Type == "host-session.close" {
		if cancel := supervisor.callbackCancels[session.HostHarnessSessionID]; cancel != nil {
			cancel()
			delete(supervisor.callbackCancels, session.HostHarnessSessionID)
		}
	}
	observationUpdate := session.HostHarnessSessionObservation
	supervisor.publishUpdate(CoreUpdate{HostHarnessSessionID: session.HostHarnessSessionID, AttachmentEpoch: session.AttachmentEpoch, ProviderTurnID: session.ProviderTurnID, Session: &observationUpdate})
	if command.Type == "host-session.turn.start" && prepared.cancelCallbacks != nil {
		if previous := supervisor.callbackCancels[session.HostHarnessSessionID]; previous != nil {
			previous()
		}
		supervisor.callbackCancels[session.HostHarnessSessionID] = prepared.cancelCallbacks
	}
	result := supervisor.result(command, operation, "succeeded", "")
	result.HostHarnessSessionID = session.HostHarnessSessionID
	result.AttachmentEpoch = command.AttachmentEpoch
	observation := session.HostHarnessSessionObservation
	result.Session = &observation
	if command.Type == "host-session.turn.start" {
		result.ProviderTurnID = session.ProviderTurnID
		if prepared.setProviderTurn != nil {
			prepared.setProviderTurn(session.ProviderTurnID)
		}
	}
	response := supervisor.completeResultLocked(command, operation, result)
	if prepared.activate != nil {
		prepared.activate()
	}
	return response
}

func (supervisor *Supervisor) initialObservation(id, harnessID string, observed DriverSession) (protocol.HostHarnessSessionObservation, error) {
	at := supervisor.now()
	observation := protocol.HostHarnessSessionObservation{
		HostHarnessSessionID: id, NodeID: supervisor.nodeID, HarnessID: harnessID,
		ProviderSessionID: observed.ProviderSessionID, Workspace: observed.Workspace,
		Source: observed.Source, Status: observed.Status, ControlMode: observed.ControlMode,
		Operations: slices.Clone(observed.Operations), Revision: 1, ProviderTurnID: observed.ProviderTurnID,
		Summary: observed.Summary, CreatedAt: at, UpdatedAt: at,
	}
	if err := observation.Validate(); err != nil {
		return protocol.HostHarnessSessionObservation{}, fmt.Errorf("driver observation is invalid: %w", err)
	}
	return observation, nil
}

func (supervisor *Supervisor) applyObservation(current protocol.HostHarnessSession, observed DriverSession) (protocol.HostHarnessSession, error) {
	if err := validateDriverIdentity(current, observed); err != nil {
		return protocol.HostHarnessSession{}, err
	}
	next := current.HostHarnessSessionObservation
	next.Status = observed.Status
	next.ControlMode = observed.ControlMode
	next.Operations = slices.Clone(observed.Operations)
	next.ProviderTurnID = observed.ProviderTurnID
	next.Summary = observed.Summary
	if next.Status == current.Status && next.ControlMode == current.ControlMode && slices.Equal(next.Operations, current.Operations) &&
		next.ProviderTurnID == current.ProviderTurnID && next.Summary == current.Summary {
		return current, nil
	}
	next.Revision++
	next.UpdatedAt = supervisor.now()
	if err := protocol.ValidateHostHarnessSessionObservationTransition(current.HostHarnessSessionObservation, next); err != nil {
		return protocol.HostHarnessSession{}, err
	}
	current.HostHarnessSessionObservation = next
	return current, nil
}

func validateDriverIdentity(current protocol.HostHarnessSession, observed DriverSession) error {
	if current.ProviderSessionID != observed.ProviderSessionID || current.Workspace != observed.Workspace || current.Source != observed.Source {
		return fmt.Errorf("provider identity conflict")
	}
	return nil
}

func driverSession(session protocol.HostHarnessSession) DriverSession {
	return DriverSession{
		ProviderSessionID: session.ProviderSessionID, Workspace: session.Workspace, Source: session.Source,
		Status: session.Status, ControlMode: session.ControlMode, Operations: slices.Clone(session.Operations),
		ProviderTurnID: session.ProviderTurnID, Summary: session.Summary,
	}
}

func sessionRequest(session protocol.HostHarnessSession, command protocol.HostSessionHubMessage) SessionRequest {
	providerTurnID := command.ProviderTurnID
	if command.Type == "host-session.approval.decision" && providerTurnID == "" {
		providerTurnID = session.ProviderTurnID
	}
	return SessionRequest{
		HostHarnessSessionID: session.HostHarnessSessionID, ProviderSessionID: session.ProviderSessionID,
		Workspace: session.Workspace, Source: session.Source, Status: session.Status,
		Summary:     session.Summary,
		ControlMode: session.ControlMode, Operations: slices.Clone(session.Operations),
		ProviderTurnID: providerTurnID, AttachmentEpoch: session.AttachmentEpoch,
		ThreadID: command.ThreadID, RunID: command.RunID, Prompt: command.Prompt, Text: command.Text,
		Decision: command.Decision,
	}
}

func (supervisor *Supervisor) driverFor(harnessID string, operation Operation) (Driver, error) {
	driver := supervisor.drivers[harnessID]
	if driver == nil || !driver.Capabilities().Supports(operation) {
		return nil, fmt.Errorf("unsupported-capability")
	}
	return driver, nil
}

func (supervisor *Supervisor) sessionAndDriver(sessionID string, operation Operation) (registryRecord, Driver, error) {
	supervisor.mu.RLock()
	record := supervisor.registry[sessionID]
	supervisor.mu.RUnlock()
	if record.Session.HostHarnessSessionID == "" {
		return registryRecord{}, nil, fmt.Errorf("unknown-session")
	}
	canonical, err := harness.AuthorizeWorkspace(record.Session.Workspace, supervisor.workspaceRoots)
	if err != nil || canonical != record.Session.Workspace {
		return registryRecord{}, nil, fmt.Errorf("workspace-unauthorized")
	}
	driver, err := supervisor.driverFor(record.Session.HarnessID, operation)
	return record, driver, err
}

func (supervisor *Supervisor) reserveRegistrySlot(commandID, harnessID, workspace, providerSessionID string) (bool, error) {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	if providerSessionID != "" && supervisor.providerToID[providerKey(harnessID, workspace, providerSessionID)] != "" {
		return false, nil
	}
	limit := protocol.HostHarnessSessionLimits.SessionsPerGeneration - len(supervisor.reservations) - 1
	if limit < 0 {
		return false, fmt.Errorf("capacity-conflict")
	}
	if _, err := retainRegistry(cloneRegistry(supervisor.registry), supervisor.ledger, limit); err != nil {
		return false, fmt.Errorf("capacity-conflict")
	}
	supervisor.reservations[commandID] = true
	return true, nil
}

func (supervisor *Supervisor) releaseRegistryReservation(commandID string) {
	supervisor.mu.Lock()
	delete(supervisor.reservations, commandID)
	supervisor.mu.Unlock()
}

func (supervisor *Supervisor) replay(command protocol.HostSessionHubMessage, operation string) (CommandResponse, bool) {
	supervisor.mu.RLock()
	record, found := supervisor.ledger[command.CommandID]
	supervisor.mu.RUnlock()
	if !found {
		return CommandResponse{}, false
	}
	if record.CommandDigest != command.CommandDigest || record.Operation != operation {
		return supervisor.rejection(command, operation, "idempotency-conflict"), true
	}
	ack := supervisor.ack(command, operation, "replayed")
	if record.State == commandCompleted && record.Result != nil {
		return CommandResponse{Ack: ack, Result: *record.Result}, true
	}
	result := supervisor.result(command, operation, "uncertain", "manual-reconciliation-required")
	return CommandResponse{Ack: ack, Result: result}, true
}

func (supervisor *Supervisor) beginFlight(command protocol.HostSessionHubMessage, operation string) (*commandFlight, bool, bool) {
	supervisor.flightsMu.Lock()
	defer supervisor.flightsMu.Unlock()
	if existing := supervisor.flights[command.CommandID]; existing != nil {
		if existing.digest != command.CommandDigest || existing.operation != operation {
			return existing, false, true
		}
		return existing, false, false
	}
	flight := &commandFlight{digest: command.CommandDigest, operation: operation, done: make(chan struct{})}
	supervisor.flights[command.CommandID] = flight
	return flight, true, false
}

func (supervisor *Supervisor) finishFlight(commandID string, response CommandResponse) {
	supervisor.flightsMu.Lock()
	flight := supervisor.flights[commandID]
	if flight != nil {
		flight.response = response
		delete(supervisor.flights, commandID)
		close(flight.done)
	}
	supervisor.flightsMu.Unlock()
}

func (supervisor *Supervisor) recordPending(command protocol.HostSessionHubMessage, operation string) error {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	nextLedger := cloneLedger(supervisor.ledger)
	compactLedger(nextLedger, maxCommandLedgerRecords-1)
	if len(nextLedger) >= maxCommandLedgerRecords {
		return errCommandLedgerCapacity
	}
	record := ledgerRecord{
		CommandID: command.CommandID, CommandDigest: command.CommandDigest, Operation: operation,
		HostHarnessSessionID: command.HostHarnessSessionID, RequestID: command.RequestID, State: commandPending,
	}
	nextLedger[command.CommandID] = record
	if err := supervisor.storage.saveLedger(ledgerSlice(nextLedger)); err != nil {
		supervisor.handlePersistenceFailure(err)
		return err
	}
	supervisor.ledger = nextLedger
	return nil
}

func (supervisor *Supervisor) completeRejected(command protocol.HostSessionHubMessage, operation, code string) CommandResponse {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	result := supervisor.result(command, operation, "rejected", code)
	return supervisor.completeResultLocked(command, operation, result)
}

func (supervisor *Supervisor) completeResultLocked(command protocol.HostSessionHubMessage, operation string, result protocol.HostSessionControlMessage) CommandResponse {
	record := supervisor.ledger[command.CommandID]
	record.State = commandCompleted
	record.Result = &result
	record.CompletedAt = supervisor.now()
	record.Acknowledged = false
	supervisor.ledger[command.CommandID] = record
	if err := supervisor.storage.saveLedger(ledgerSlice(supervisor.ledger)); err != nil {
		if persistenceMayHaveCommitted(err) {
			supervisor.disableAfterPersistenceFailure()
			return CommandResponse{Ack: supervisor.ack(command, operation, "recorded"), Result: supervisor.result(command, operation, "uncertain", "durability-uncertain")}
		}
		record.State = commandUncertain
		record.Result = nil
		record.CompletedAt = ""
		record.Acknowledged = false
		supervisor.ledger[command.CommandID] = record
		if fallbackErr := supervisor.storage.saveLedger(ledgerSlice(supervisor.ledger)); fallbackErr != nil {
			supervisor.disableAfterPersistenceFailure()
		}
		return CommandResponse{Ack: supervisor.ack(command, operation, "recorded"), Result: supervisor.result(command, operation, "uncertain", "durability-uncertain")}
	}
	return CommandResponse{Ack: supervisor.ack(command, operation, "recorded"), Result: result}
}

func (supervisor *Supervisor) markUncertain(command protocol.HostSessionHubMessage, operation, code string) CommandResponse {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	return supervisor.markUncertainLocked(command, operation, code)
}

func (supervisor *Supervisor) markUncertainLocked(command protocol.HostSessionHubMessage, operation, code string) CommandResponse {
	record := supervisor.ledger[command.CommandID]
	record.State = commandUncertain
	record.Result = nil
	record.CompletedAt = ""
	record.Acknowledged = false
	supervisor.ledger[command.CommandID] = record
	if err := supervisor.storage.saveLedger(ledgerSlice(supervisor.ledger)); err != nil {
		supervisor.disableAfterPersistenceFailure()
	}
	return CommandResponse{Ack: supervisor.ack(command, operation, "recorded"), Result: supervisor.result(command, operation, "uncertain", code)}
}

func (supervisor *Supervisor) ack(command protocol.HostSessionHubMessage, operation, disposition string) protocol.HostSessionControlMessage {
	return protocol.HostSessionControlMessage{
		Type: "host-session.command.ack", NodeID: supervisor.nodeID, Operation: operation,
		CommandID: command.CommandID, CommandDigest: command.CommandDigest,
		HostHarnessSessionID: command.HostHarnessSessionID, RequestID: command.RequestID,
		AttachmentEpoch: command.AttachmentEpoch, Disposition: disposition, At: supervisor.now(),
	}
}

func (supervisor *Supervisor) result(command protocol.HostSessionHubMessage, operation, outcome, code string) protocol.HostSessionControlMessage {
	return protocol.HostSessionControlMessage{
		Type: "host-session.command.result", NodeID: supervisor.nodeID, Operation: operation,
		CommandID: command.CommandID, CommandDigest: command.CommandDigest,
		HostHarnessSessionID: command.HostHarnessSessionID, RequestID: command.RequestID,
		AttachmentEpoch: command.AttachmentEpoch, Outcome: outcome, Code: code, At: supervisor.now(),
	}
}

func (supervisor *Supervisor) rejection(command protocol.HostSessionHubMessage, operation, code string) CommandResponse {
	return CommandResponse{Result: supervisor.result(command, operation, "rejected", boundedCode(code))}
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
	default:
		return "close"
	}
}

func driverOperation(messageType string) Operation {
	switch messageType {
	case "host-session.attach":
		return OperationResume
	case "host-session.detach":
		return OperationDetach
	case "host-session.turn.start":
		return OperationStartTurn
	case "host-session.turn.steer":
		return OperationSteer
	case "host-session.turn.interrupt":
		return OperationInterrupt
	case "host-session.approval.decision":
		return OperationResolveApproval
	case "host-session.close":
		return OperationClose
	default:
		return OperationRefresh
	}
}

func commandSessionOperation(messageType string) string {
	switch messageType {
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
	default:
		return ""
	}
}

func legalCommandState(messageType, status string) bool {
	if status == "closed" || status == "failed" {
		return false
	}
	switch messageType {
	case "host-session.turn.start":
		return status == "idle"
	case "host-session.turn.steer", "host-session.turn.interrupt":
		return status == "running" || status == "awaiting-approval"
	case "host-session.approval.decision":
		return status == "awaiting-approval"
	default:
		return true
	}
}

func stableCode(err error) string {
	return boundedCode(err.Error())
}

func boundedCode(code string) string {
	allowed := []string{
		"unsupported-capability", "workspace-unauthorized", "provider-inspection-failed", "provider-identity-conflict",
		"unknown-session", "attachment-epoch-conflict", "attachment-conflict", "session-not-attached",
		"provider-effect-uncertain", "provider-result-invalid", "durability-uncertain", "manual-reconciliation-required",
		"idempotency-conflict", "session-busy", "supervision-unavailable", "invalid-command", "durability-failed",
		"illegal-transition",
		"capacity-conflict",
		"adoption-failed", "active-elsewhere", "codex-protocol-incompatible", "authentication-required",
	}
	if slices.Contains(allowed, code) {
		return code
	}
	return "provider-operation-rejected"
}

func cloneRegistry(source map[string]registryRecord) map[string]registryRecord {
	result := make(map[string]registryRecord, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func cloneStrings(source map[string]string) map[string]string {
	result := make(map[string]string, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func cloneLedger(source map[string]ledgerRecord) map[string]ledgerRecord {
	result := make(map[string]ledgerRecord, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func compactLedger(records map[string]ledgerRecord, limit int) {
	if len(records) <= limit {
		return
	}
	candidates := make([]ledgerRecord, 0, len(records))
	for _, record := range records {
		if record.State == commandCompleted && record.Result != nil && record.Acknowledged {
			candidates = append(candidates, record)
		}
	}
	sort.Slice(candidates, func(left, right int) bool {
		if candidates[left].CompletedAt == candidates[right].CompletedAt {
			return candidates[left].CommandID < candidates[right].CommandID
		}
		return candidates[left].CompletedAt < candidates[right].CompletedAt
	})
	for _, candidate := range candidates {
		if len(records) <= limit {
			return
		}
		delete(records, candidate.CommandID)
	}
}

func registrySlice(records map[string]registryRecord) []registryRecord {
	result := make([]registryRecord, 0, len(records))
	for _, record := range records {
		result = append(result, record)
	}
	sort.Slice(result, func(left, right int) bool {
		return result[left].Session.HostHarnessSessionID < result[right].Session.HostHarnessSessionID
	})
	return result
}

func ledgerSlice(records map[string]ledgerRecord) []ledgerRecord {
	result := make([]ledgerRecord, 0, len(records))
	for _, record := range records {
		result = append(result, record)
	}
	sort.Slice(result, func(left, right int) bool { return result[left].CommandID < result[right].CommandID })
	return result
}

func retainRegistry(records map[string]registryRecord, ledger map[string]ledgerRecord, limit int) (map[string]registryRecord, error) {
	if len(records) <= limit {
		return records, nil
	}
	referenced := make(map[string]bool)
	for _, command := range ledger {
		if command.HostHarnessSessionID != "" {
			referenced[command.HostHarnessSessionID] = true
		}
		if command.Result != nil && command.Result.Session != nil {
			referenced[command.Result.Session.HostHarnessSessionID] = true
		}
	}
	candidates := make([]registryRecord, 0)
	for _, record := range records {
		terminal := record.Session.Status == "closed" || record.Session.Status == "failed"
		if terminal && record.Session.AttachedThreadID == "" && !referenced[record.Session.HostHarnessSessionID] {
			candidates = append(candidates, record)
		}
	}
	sort.Slice(candidates, func(left, right int) bool {
		if candidates[left].Session.UpdatedAt == candidates[right].Session.UpdatedAt {
			return candidates[left].Session.HostHarnessSessionID < candidates[right].Session.HostHarnessSessionID
		}
		return candidates[left].Session.UpdatedAt < candidates[right].Session.UpdatedAt
	})
	result := cloneRegistry(records)
	for _, candidate := range candidates {
		if len(result) <= limit {
			break
		}
		delete(result, candidate.Session.HostHarnessSessionID)
	}
	if len(result) > limit {
		return nil, fmt.Errorf("capacity-conflict")
	}
	return result, nil
}

func (supervisor *Supervisor) Shutdown(ctx context.Context) error {
	supervisor.admissionMu.Lock()
	if supervisor.closing.Swap(true) {
		supervisor.admissionMu.Unlock()
		return nil
	}
	supervisor.admissionMu.Unlock()
	supervisor.cancel()
	done := make(chan struct{})
	go func() { supervisor.inflight.Wait(); close(done) }()
	select {
	case <-done:
		supervisor.shutdownDrivers()
		return nil
	case <-ctx.Done():
		supervisor.shutdownDrivers()
		return fmt.Errorf("host-session shutdown did not settle: %w", ctx.Err())
	}
}

func (supervisor *Supervisor) shutdownDrivers() {
	for _, driver := range supervisor.drivers {
		if closer, ok := driver.(interface{ Shutdown() }); ok {
			closer.Shutdown()
		}
	}
}

func (supervisor *Supervisor) publishUpdate(update CoreUpdate) bool {
	supervisor.updateMu.Lock()
	defer supervisor.updateMu.Unlock()
	select {
	case supervisor.updates <- update:
		return true
	default:
	}
	// The registry/ledger commit has already succeeded. Drop a transport delta and force the
	// consumer to reconnect for a fresh authoritative generation; delivery pressure must never
	// rewrite a durable provider outcome as uncertain.
	select {
	case dropped := <-supervisor.updates:
		if dropped.DeliveryState != nil && dropped.DeliveryState.CompareAndSwap(0, -1) {
			dropped.Delivered <- false
		}
	default:
	}
	select {
	case supervisor.updates <- CoreUpdate{Resync: true}:
	default:
	}
	return false
}
