import { createServer, type Server as HttpServer } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import {
  orchestratorClientHeartbeatSeconds,
  validateOrchestratorClientMessage,
  validateOrchestratorHubMessage,
  type OrchestratorClientError,
  type OrchestratorClientScope,
  type OrchestratorClientToHub,
  type OrchestratorHubToClient
} from "@coffee-shop/protocol";

export interface FakeHubRequest {
  requestId: string;
  tool: string;
  arguments: Record<string, unknown>;
}

export type FakeHubHandler = (request: FakeHubRequest) => Promise<unknown> | unknown;

export interface FakeHubOptions {
  /** Scopes granted in `client.welcome`; `undefined` closes the socket with `closeReason`. */
  scopes?: OrchestratorClientScope[];
  closeReason?: string;
  heartbeatSeconds?: number;
  handle?: FakeHubHandler;
}

/** An `rpc.response` carrying an error rather than a result. */
export class FakeHubToolError extends Error {
  constructor(readonly error: OrchestratorClientError) {
    super(error.message);
  }
}

/**
 * A hub stand-in for the bridge's tests. Every frame it sends is checked against the real
 * `validateOrchestratorHubMessage` before it reaches the socket, and every frame it receives is
 * parsed with the real `validateOrchestratorClientMessage`, so a test can never assert against a
 * frame shape the hub contract would reject.
 */
export class FakeHub {
  private readonly httpServer: HttpServer;
  private readonly webSocketServer: WebSocketServer;
  private readonly sockets = new Set<WebSocket>();
  readonly received: OrchestratorClientToHub[] = [];
  readonly rejectedFrames: string[] = [];
  connectionCount = 0;
  options: FakeHubOptions;
  private stopped = false;

  private constructor(httpServer: HttpServer, options: FakeHubOptions) {
    this.httpServer = httpServer;
    this.options = options;
    this.webSocketServer = new WebSocketServer({ server: httpServer, path: "/orchestrator-client" });
    this.webSocketServer.on("connection", (socket) => this.accept(socket));
  }

  static async start(options: FakeHubOptions = {}): Promise<FakeHub> {
    const httpServer = createServer();
    const hub = new FakeHub(httpServer, options);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    return hub;
  }

  get url(): string {
    const address = this.httpServer.address() as AddressInfo;
    return `ws://127.0.0.1:${address.port}/orchestrator-client`;
  }

  /** Sends a hub frame after validating it against the shared contract. */
  send(message: OrchestratorHubToClient, socket?: WebSocket): void {
    const validation = validateOrchestratorHubMessage(message);
    if (!validation.ok) throw new Error(`the fake hub tried to send an invalid frame: ${validation.reason}`);
    const encoded = JSON.stringify(validation.value);
    const targets = socket === undefined ? this.sockets : [socket];
    for (const target of targets) target.send(encoded);
  }

  /** Sends text the contract would reject, to exercise the bridge's malformed-frame handling. */
  sendRaw(payload: string): void {
    for (const socket of this.sockets) socket.send(payload);
  }

  closeConnections(code = 1000, reason = ""): void {
    for (const socket of [...this.sockets]) socket.close(code, reason);
  }

  receivedOfType<T extends OrchestratorClientToHub["type"]>(type: T): Extract<OrchestratorClientToHub, { type: T }>[] {
    return this.received.filter((message) => message.type === type) as Extract<OrchestratorClientToHub, { type: T }>[];
  }

  /** Idempotent, so a test that stops the hub mid-scenario can still tear down afterwards. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const socket of [...this.sockets]) socket.terminate();
    await new Promise<void>((resolve, reject) => this.webSocketServer.close((error) => (error ? reject(error) : resolve())));
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
  }

  private accept(socket: WebSocket): void {
    this.connectionCount += 1;
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        this.rejectedFrames.push("unparsable");
        return;
      }
      const validation = validateOrchestratorClientMessage(parsed);
      if (!validation.ok) {
        this.rejectedFrames.push(validation.reason);
        return;
      }
      this.received.push(validation.value);
      void this.respond(socket, validation.value);
    });
  }

  private async respond(socket: WebSocket, message: OrchestratorClientToHub): Promise<void> {
    if (message.type === "client.hello") {
      const { scopes, closeReason } = this.options;
      if (scopes === undefined) {
        socket.close(1008, closeReason ?? "unauthorized");
        return;
      }
      this.send({
        type: "client.welcome",
        connectionId: `connection-${this.connectionCount}`,
        heartbeatSeconds: this.options.heartbeatSeconds ?? orchestratorClientHeartbeatSeconds,
        scopes
      }, socket);
      return;
    }
    if (message.type !== "rpc.request") return;
    const handle = this.options.handle;
    if (handle === undefined) {
      this.send({ type: "rpc.response", requestId: message.requestId, result: { tool: message.tool } }, socket);
      return;
    }
    try {
      const result = await handle({ requestId: message.requestId, tool: message.tool, arguments: message.arguments });
      this.send({ type: "rpc.response", requestId: message.requestId, result }, socket);
    } catch (error) {
      if (error instanceof FakeHubToolError) {
        this.send({ type: "rpc.response", requestId: message.requestId, error: error.error }, socket);
        return;
      }
      throw error;
    }
  }
}
