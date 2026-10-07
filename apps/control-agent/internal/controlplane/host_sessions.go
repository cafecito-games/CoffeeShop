package controlplane

import (
	"context"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/hostsession"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

const (
	hostSessionBufferedFrames = 256
	hostSessionBufferedBytes  = 512 * 1024
)

// hostSessionCore is the provider-neutral surface owned by internal/hostsession. Keeping this
// interface here makes the transport independently testable and prevents controlplane from
// learning registry, ledger, process, endpoint, or provider configuration details.
type hostSessionCore interface {
	Usable() bool
	Diagnostic() string
	InteractiveProfiles() map[string]protocol.HostHarnessSessionInteractiveProfile
	Snapshot() ([]protocol.HostHarnessSessionObservation, error)
	Outcomes() []protocol.HostSessionControlMessage
	AcknowledgeOutcome(string)
	Updates() <-chan hostsession.CoreUpdate
	Execute(context.Context, protocol.HostSessionHubMessage) hostsession.CommandResponse
	ReadHistory(context.Context, string, string, string, int) (hostsession.HistoryPage, error)
	Shutdown(context.Context) error
}

type hostSessionTransport struct {
	core   hostSessionCore
	nodeID string
	client *Client

	started        atomic.Bool
	lastGeneration atomic.Int64
	mu             sync.Mutex
	pending        [][]byte
	pendingBytes   int
	dirty          bool
}

func newHostSessionTransport(core hostSessionCore, nodeID string, client *Client) *hostSessionTransport {
	transport := &hostSessionTransport{core: core, nodeID: nodeID, client: client}
	transport.lastGeneration.Store(time.Now().UTC().UnixMilli())
	return transport
}

func (transport *hostSessionTransport) start(ctx context.Context) {
	if transport == nil || !transport.started.CompareAndSwap(false, true) {
		return
	}
	go func() {
		for {
			select {
			case update := <-transport.core.Updates():
				if update.Resync {
					if update.Delivered != nil {
						update.Delivered <- false
					}
					transport.markDirty()
					transport.client.requestHostSessionResync()
					continue
				}
				message := protocol.HostSessionControlMessage{NodeID: transport.nodeID}
				switch {
				case update.Session != nil:
					message.Type = "host-session.update"
					message.Session = update.Session
					message.At = now()
				case update.Event != nil:
					message.Type = "host-session.harness-event"
					message.HostHarnessSessionID = update.HostHarnessSessionID
					epoch := update.AttachmentEpoch
					message.AttachmentEpoch = &epoch
					message.ProviderTurnID = update.ProviderTurnID
					message.Event = update.Event
				default:
					if update.Delivered != nil {
						update.Delivered <- false
					}
					transport.markDirty()
					continue
				}
				if update.DeliveryState != nil && !update.DeliveryState.CompareAndSwap(0, 1) {
					update.Delivered <- false
					transport.markDirty()
					transport.client.requestHostSessionResync()
					continue
				}
				delivered := false
				if update.DeliveryState != nil {
					delivered = transport.client.sendTrackedHostSession(message)
				} else {
					delivered = transport.client.sendHostSession(message)
				}
				if update.Delivered != nil {
					if update.DeliveryState != nil {
						update.DeliveryState.Store(2)
					}
					update.Delivered <- delivered
					if !delivered {
						transport.markDirty()
						transport.client.requestHostSessionResync()
					}
				}
			case <-ctx.Done():
				return
			}
		}
	}()
}

func (transport *hostSessionTransport) shutdown() {
	if transport == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := transport.core.Shutdown(ctx); err != nil {
		log.Printf("interactive host-session shutdown did not settle")
	}
}

func (transport *hostSessionTransport) nextGeneration() int64 {
	for {
		previous := transport.lastGeneration.Load()
		next := time.Now().UTC().UnixMilli()
		if next <= previous {
			next = previous + 1
		}
		if transport.lastGeneration.CompareAndSwap(previous, next) {
			return next
		}
	}
}

func (transport *hostSessionTransport) authoritativeFrames() ([][]byte, []string, error) {
	sessions, err := transport.core.Snapshot()
	if err != nil {
		transport.markDirty()
		return nil, nil, fmt.Errorf("host-session snapshot unavailable")
	}
	if len(sessions) > protocol.HostHarnessSessionLimits.SessionsPerGeneration {
		transport.markDirty()
		return nil, nil, fmt.Errorf("host-session snapshot exceeds the protocol bound")
	}
	generation := transport.nextGeneration()
	at := now()
	pageSize := protocol.HostHarnessSessionLimits.SessionsPerInventoryPage
	pages := make([]protocol.HostSessionControlMessage, 0, (len(sessions)+pageSize-1)/pageSize)
	for start := 0; start < len(sessions); start += pageSize {
		end := min(start+pageSize, len(sessions))
		pageSessions := append([]protocol.HostHarnessSessionObservation(nil), sessions[start:end]...)
		pages = append(pages, protocol.HostSessionControlMessage{
			Type: "host-session.inventory.page", NodeID: transport.nodeID, Generation: generation,
			PageIndex: int64(len(pages)), Sessions: pageSessions, At: at,
		})
	}
	complete := protocol.HostSessionControlMessage{
		Type: "host-session.inventory.complete", NodeID: transport.nodeID, Generation: generation,
		PageCount: int64(len(pages)), SessionCount: int64(len(sessions)), At: at,
	}
	if _, err := protocol.ValidateHostHarnessSessionInventoryGeneration(pages, complete); err != nil {
		transport.markDirty()
		return nil, nil, fmt.Errorf("host-session snapshot is not serializable")
	}
	outcomes := transport.core.Outcomes()
	frames := make([][]byte, 0, len(pages)+1+len(outcomes))
	outcomeIDs := make([]string, 0, len(outcomes))
	for _, page := range pages {
		encoded, err := encodeHostSessionFrame(page)
		if err != nil {
			transport.markDirty()
			return nil, nil, err
		}
		frames = append(frames, encoded)
	}
	encoded, err := encodeHostSessionFrame(complete)
	if err != nil {
		transport.markDirty()
		return nil, nil, err
	}
	frames = append(frames, encoded)
	for _, outcome := range outcomes {
		encoded, err := encodeHostSessionFrame(outcome)
		if err != nil {
			transport.markDirty()
			return nil, nil, fmt.Errorf("durable host-session outcome is not serializable")
		}
		frames = append(frames, encoded)
		outcomeIDs = append(outcomeIDs, outcome.CommandID)
	}
	return frames, outcomeIDs, nil
}

func encodeHostSessionFrame(message protocol.HostSessionControlMessage) ([]byte, error) {
	encoded, err := message.MarshalJSON()
	if err != nil {
		return nil, err
	}
	if _, err := protocol.DecodeHostSessionControlMessage(encoded, protocol.Version); err != nil {
		return nil, err
	}
	return encoded, nil
}

func (transport *hostSessionTransport) buffer(encoded []byte) {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if transport.dirty {
		return
	}
	if len(transport.pending) >= hostSessionBufferedFrames || transport.pendingBytes+len(encoded) > hostSessionBufferedBytes {
		transport.pending = nil
		transport.pendingBytes = 0
		transport.dirty = true
		return
	}
	transport.pending = append(transport.pending, append([]byte(nil), encoded...))
	transport.pendingBytes += len(encoded)
}

func (transport *hostSessionTransport) markDirty() {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	transport.pending = nil
	transport.pendingBytes = 0
	transport.dirty = true
}

func (transport *hostSessionTransport) takePendingAfterSnapshot() [][]byte {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	// A fresh authoritative generation subsumes every earlier delta. Updates racing after Snapshot
	// may reappear as exact-revision replays, which the Hub accepts without a write.
	pending := transport.pending
	transport.pending = nil
	transport.pendingBytes = 0
	transport.dirty = false
	return pending
}

func (transport *hostSessionTransport) handle(ctx context.Context, command protocol.HostSessionHubMessage) {
	if command.Type == "host-session.history.read" {
		page, err := transport.core.ReadHistory(context.WithoutCancel(ctx), command.HostHarnessSessionID, command.RequestID, command.Cursor, int(command.Limit))
		if err != nil {
			log.Printf("interactive host-session history request was refused")
			return
		}
		transport.client.sendHostSession(protocol.HostSessionControlMessage{
			Type: "host-session.history.page", NodeID: transport.nodeID,
			HostHarnessSessionID: command.HostHarnessSessionID, RequestID: command.RequestID,
			Items: page.Items, NextCursor: page.NextCursor, Truncated: page.Truncated, At: now(),
		})
		return
	}
	response := transport.core.Execute(context.WithoutCancel(ctx), command)
	if response.Ack.Type != "" {
		transport.client.sendHostSession(response.Ack)
	}
	if response.Result.Type != "" {
		if transport.client.sendHostSession(response.Result) {
			transport.core.AcknowledgeOutcome(response.Result.CommandID)
		}
	}
}
