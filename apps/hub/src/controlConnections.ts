import { canSendToControlAgent, supportsControlCapability, type ControlProtocolVersion, type HubToControlAgent, type InstanceHubMessage } from "@coffee-shop/protocol";

export interface ControlSocket {
  readonly readyState: number;
  send(data: string): void;
}

/** One registration of one socket; a re-registration or reconnect is a new connection. */
export interface ControlConnection<Socket extends ControlSocket = ControlSocket> {
  readonly nodeId: string;
  readonly socket: Socket;
  readonly protocolVersion: ControlProtocolVersion;
  readonly generation: number;
  synced: boolean;
  /**
   * Whether instance commands may be written to this connection yet. The replay barrier alone does
   * not open it: the reported resident set behind the sync must be applied first, so a pending
   * provision delivered in that window can never be judged lost against a pre-provision snapshot.
   */
  instanceDeliveryOpen: boolean;
  /** Runs dispatched on this connection; a run is dispatched at most once per connection. */
  readonly deliveredRunIds: Set<string>;
}

type DispatchMessage = Extract<HubToControlAgent, { type: "dispatch" }>;

/**
 * The hub's authoritative view of Barista connections. A dispatch decision is bound to the exact
 * connection it was approved against and is only sent while that connection is still current and
 * has passed its reconnect barrier, so a dispatch approved before a reconnect can never reach the
 * new socket ahead of its barrier and then be redispatched by it.
 */
export class ControlConnectionRegistry<Socket extends ControlSocket> {
  private readonly byNode = new Map<string, ControlConnection<Socket>>();
  private readonly bySocket = new WeakMap<Socket, ControlConnection<Socket>>();
  private generation = 0;

  constructor(private readonly openReadyState: number) {}

  /**
   * Whether `socket` may register as `nodeId`. A node has at most one live connection: while the
   * node's current socket is still open, another socket is refused rather than allowed to supersede
   * it, because a second Barista process registered under the same node would otherwise report only
   * its own active runs, and lost-attempt reconciliation and workspace cleanup computed from that
   * list would act on work the first process is still running. Keepalive closes a half-open socket,
   * after which a reconnecting Barista is admitted.
   */
  admits(nodeId: string, socket: Socket) {
    const current = this.current(nodeId);
    return current === undefined || current.socket === socket;
  }

  register(nodeId: string, socket: Socket, protocolVersion: ControlProtocolVersion) {
    const previous = this.bySocket.get(socket);
    if (previous && this.byNode.get(previous.nodeId) === previous) this.byNode.delete(previous.nodeId);
    this.generation += 1;
    const connection: ControlConnection<Socket> = { nodeId, socket, protocolVersion, generation: this.generation, synced: false, instanceDeliveryOpen: false, deliveredRunIds: new Set() };
    this.byNode.set(nodeId, connection);
    this.bySocket.set(socket, connection);
    return connection;
  }

  connectionFor(socket: Socket) {
    return this.bySocket.get(socket);
  }

  isCurrent(connection: ControlConnection<Socket>) {
    return this.byNode.get(connection.nodeId) === connection && connection.socket.readyState === this.openReadyState;
  }

  /** The open, current connection for a node. */
  current(nodeId: string) {
    const connection = this.byNode.get(nodeId);
    return connection && this.isCurrent(connection) ? connection : undefined;
  }

  has(nodeId: string) {
    return this.current(nodeId) !== undefined;
  }

  get size() {
    return this.byNode.size;
  }

  markSynced(connection: ControlConnection<Socket>) {
    if (!this.isCurrent(connection)) return false;
    connection.synced = true;
    return true;
  }

  /**
   * Opens instance command delivery for one connection. The sync handler calls this only after the
   * connection's reported resident set has been applied (or its sync carried no authoritative
   * instance evidence), so a persisted provision is never delivered against a pre-provision
   * snapshot that would then judge it lost.
   */
  openInstanceDelivery(connection: ControlConnection<Socket>) {
    if (!this.isCurrent(connection)) return false;
    connection.instanceDeliveryOpen = true;
    return true;
  }

  /** Removes the socket's connection; returns it only when it was the node's current one. */
  release(socket: Socket) {
    const connection = this.bySocket.get(socket);
    if (!connection || this.byNode.get(connection.nodeId) !== connection) return undefined;
    this.byNode.delete(connection.nodeId);
    return connection;
  }

  /** Version 1 has no reconnect barrier and never redispatches, so it counts as synchronized. */
  barrierPassed(connection: ControlConnection<Socket>) {
    return connection.synced || !supportsControlCapability(connection.protocolVersion, "replay-barrier");
  }

  /** The connection a dispatch may be approved against right now, if any. */
  deliveryConnection(nodeId: string, message: DispatchMessage) {
    const connection = this.current(nodeId);
    return connection && this.barrierPassed(connection) && canSendToControlAgent(message, connection.protocolVersion) ? connection : undefined;
  }

  /**
   * Sends a dispatch on the connection it was approved against. Returns false when that connection
   * is no longer current, has not passed its barrier, cannot accept the message, or the write
   * fails; returns true without resending when the run was already dispatched on it.
   */
  deliver(connection: ControlConnection<Socket>, message: DispatchMessage) {
    if (!this.isCurrent(connection) || !this.barrierPassed(connection) || !canSendToControlAgent(message, connection.protocolVersion)) return false;
    if (connection.deliveredRunIds.has(message.run.id)) return true;
    try {
      connection.socket.send(JSON.stringify(message));
    } catch {
      return false;
    }
    connection.deliveredRunIds.add(message.run.id);
    return true;
  }

  /** Sends a non-dispatch message to the node's current connection when its version accepts it. */
  send(nodeId: string, message: HubToControlAgent) {
    if (message.type === "dispatch") {
      const connection = this.deliveryConnection(nodeId, message);
      return connection ? this.deliver(connection, message) : false;
    }
    const connection = this.current(nodeId);
    if (!connection || !canSendToControlAgent(message, connection.protocolVersion)) return false;
    try {
      connection.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sends a version-5 instance command to the node's current connection once it has passed its
   * reconnect barrier and its reported resident set has been applied. A stale or pre-v5 connection
   * records no delivery, so the persisted command replays after the node's next authoritative sync.
   */
  sendInstanceCommand(nodeId: string, message: InstanceHubMessage) {
    const connection = this.current(nodeId);
    if (!connection || !this.barrierPassed(connection) || !connection.instanceDeliveryOpen || !canSendToControlAgent(message, connection.protocolVersion)) return false;
    try {
      connection.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }
}
