import { canSendToControlAgent, supportsControlCapability, type ControlProtocolVersion, type HubToControlAgent } from "@coffee-shop/protocol";

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

  register(nodeId: string, socket: Socket, protocolVersion: ControlProtocolVersion) {
    const previous = this.bySocket.get(socket);
    if (previous && this.byNode.get(previous.nodeId) === previous) this.byNode.delete(previous.nodeId);
    this.generation += 1;
    const connection: ControlConnection<Socket> = { nodeId, socket, protocolVersion, generation: this.generation, synced: false, deliveredRunIds: new Set() };
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
}
