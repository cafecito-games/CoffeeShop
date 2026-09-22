import { randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import {
  orchestratorClientHeartbeatSeconds,
  orchestratorClientProtocolVersion,
  validateOrchestratorClientMessage,
  validateOrchestratorHubMessage,
  type ExternalOrchestratorToolName,
  type OrchestratorClientCloseReason,
  type OrchestratorClientError,
  type OrchestratorClientScope,
  type OrchestratorClientToHub,
  type OrchestratorHubToClient
} from "@coffee-shop/protocol";
import { isOrchestratorClientCloseReason } from "@coffee-shop/protocol";

export type HubDoorbell = Extract<OrchestratorHubToClient, { type: "doorbell" }>;
export type HubAttachmentReplaced = Extract<OrchestratorHubToClient, { type: "attachment.replaced" }>;

export type HubCallOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: OrchestratorClientError };

export interface HubConnectionEvents {
  onDoorbell: (doorbell: HubDoorbell) => void;
  onAttachmentReplaced: (replaced: HubAttachmentReplaced) => void;
  onRevoked: () => void;
  onScopesChanged: (scopes: OrchestratorClientScope[]) => void;
  onReattachFailed: (threadId: string, error: OrchestratorClientError) => void;
  logError: (message: string) => void;
}

export interface HubConnectionOptions extends HubConnectionEvents {
  hubUrl: string;
  clientId: string;
  clientSecret: string;
  /** Timeout for an ordinary `rpc.request`; long polls add their own wait on top of this. */
  requestTimeoutMilliseconds?: number;
  welcomeTimeoutMilliseconds?: number;
  initialReconnectDelayMilliseconds?: number;
  maximumReconnectDelayMilliseconds?: number;
  /** Injected for deterministic backoff in tests. */
  random?: () => number;
  createSocket?: (url: string) => WebSocket;
}

const defaultRequestTimeoutMilliseconds = 30_000;
const defaultWelcomeTimeoutMilliseconds = 10_000;
const defaultInitialReconnectDelayMilliseconds = 1_000;
const defaultMaximumReconnectDelayMilliseconds = 30_000;

/** The bridge never queues a tool call, so an unusable connection is an immediate failure. */
const unavailable = (message: string): HubCallOutcome => ({ ok: false, error: { code: "hub_unavailable", message } });

interface PendingRequest {
  settle: (outcome: HubCallOutcome) => void;
  timer: NodeJS.Timeout;
}

/**
 * The bridge's single outbound connection to the hub. It owns the hello/welcome handshake,
 * heartbeats, capped exponential backoff with jitter, re-attachment after a reconnect, and the
 * request/response correlation for every MCP tool call.
 *
 * Nothing here is ever queued: while the connection is not ready, calls fail fast so the model
 * learns immediately instead of waiting on a socket that may never come back.
 */
export class HubConnection {
  private readonly options: Required<Pick<HubConnectionOptions,
    "requestTimeoutMilliseconds" | "welcomeTimeoutMilliseconds" | "initialReconnectDelayMilliseconds" | "maximumReconnectDelayMilliseconds" | "random" | "createSocket">>
    & HubConnectionOptions;
  private socket: WebSocket | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly attachedThreadIds = new Set<string>();
  private scopes: OrchestratorClientScope[] = [];
  private ready = false;
  private revoked = false;
  private stopped = false;
  private consecutiveFailures = 0;
  private lastCloseReason: OrchestratorClientCloseReason | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private welcomeTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;

  constructor(options: HubConnectionOptions) {
    this.options = {
      ...options,
      requestTimeoutMilliseconds: options.requestTimeoutMilliseconds ?? defaultRequestTimeoutMilliseconds,
      welcomeTimeoutMilliseconds: options.welcomeTimeoutMilliseconds ?? defaultWelcomeTimeoutMilliseconds,
      initialReconnectDelayMilliseconds: options.initialReconnectDelayMilliseconds ?? defaultInitialReconnectDelayMilliseconds,
      maximumReconnectDelayMilliseconds: options.maximumReconnectDelayMilliseconds ?? defaultMaximumReconnectDelayMilliseconds,
      random: options.random ?? Math.random,
      createSocket: options.createSocket ?? ((url) => new WebSocket(url))
    };
  }

  /** Scopes granted by the last `client.welcome`; empty until the first successful handshake. */
  grantedScopes(): readonly OrchestratorClientScope[] {
    return this.scopes;
  }

  isReady(): boolean {
    return this.ready;
  }

  isRevoked(): boolean {
    return this.revoked;
  }

  attachedThreads(): readonly string[] {
    return [...this.attachedThreadIds];
  }

  start(): void {
    if (this.stopped || this.revoked) return;
    this.openSocket();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.failPending(unavailable("the bridge is shutting down"));
    this.closeSocket();
  }

  /**
   * Issues one `rpc.request` and resolves with the matching `rpc.response`. `extraWaitMilliseconds`
   * extends the timeout for a long poll so a legitimate `get_thread_events` wait is not cut short.
   */
  async call(
    tool: ExternalOrchestratorToolName,
    toolArguments: Record<string, unknown>,
    extraWaitMilliseconds = 0
  ): Promise<HubCallOutcome> {
    if (this.revoked) {
      return { ok: false, error: { code: "revoked", message: "this orchestrator credential was revoked by an operator; mint a new one in the Coffee Shop app" } };
    }
    const socket = this.socket;
    if (!this.ready || socket === undefined || socket.readyState !== WebSocket.OPEN) {
      return unavailable(this.disconnectedReason());
    }

    const requestId = randomUUID();
    const request: OrchestratorClientToHub = { type: "rpc.request", requestId, tool, arguments: toolArguments };
    const validation = validateOrchestratorClientMessage(request);
    if (!validation.ok) {
      return { ok: false, error: { code: "invalid_arguments", message: `the call does not satisfy the orchestrator-client contract: ${validation.reason}` } };
    }

    return await new Promise<HubCallOutcome>((resolve) => {
      const timeoutMilliseconds = this.options.requestTimeoutMilliseconds + Math.max(0, extraWaitMilliseconds);
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(unavailable(`the hub did not answer ${tool} within ${timeoutMilliseconds} ms`));
      }, timeoutMilliseconds);
      timer.unref?.();
      this.pending.set(requestId, { settle: resolve, timer });
      try {
        socket.send(JSON.stringify(validation.value));
      } catch (error) {
        this.settle(requestId, unavailable(`the request could not be sent: ${describe(error)}`));
      }
    });
  }

  /** Remembers a thread so it is re-attached after a reconnect. */
  rememberAttachment(threadId: string): void {
    this.attachedThreadIds.add(threadId);
  }

  forgetAttachment(threadId: string): void {
    this.attachedThreadIds.delete(threadId);
  }

  private disconnectedReason(): string {
    const reason = this.lastCloseReason;
    if (reason === undefined) return "the bridge is not connected to the Coffee Shop hub; it is reconnecting in the background";
    return `the Coffee Shop hub closed the orchestrator connection with reason "${reason}"; the bridge is reconnecting in the background`;
  }

  private openSocket(): void {
    if (this.stopped || this.revoked) return;
    this.clearReconnectTimer();

    let socket: WebSocket;
    try {
      socket = this.options.createSocket(this.options.hubUrl);
    } catch (error) {
      this.options.logError(`could not open the hub connection: ${describe(error)}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.on("open", () => {
      if (this.socket !== socket) return;
      const hello: OrchestratorClientToHub = {
        type: "client.hello",
        protocolVersion: orchestratorClientProtocolVersion,
        clientId: this.options.clientId,
        secret: this.options.clientSecret
      };
      try {
        socket.send(JSON.stringify(hello));
      } catch (error) {
        this.options.logError(`could not send client.hello: ${describe(error)}`);
        socket.close();
        return;
      }
      this.welcomeTimer = setTimeout(() => {
        this.options.logError(`the hub did not send client.welcome within ${this.options.welcomeTimeoutMilliseconds} ms`);
        socket.close();
      }, this.options.welcomeTimeoutMilliseconds);
      this.welcomeTimer.unref?.();
    });

    socket.on("message", (data: RawData) => {
      if (this.socket !== socket) return;
      this.receive(data);
    });

    socket.on("error", (error: Error) => {
      if (this.socket !== socket) return;
      this.options.logError(`hub connection error: ${describe(error)}`);
    });

    socket.on("close", (_code: number, reason: Buffer) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.handleClose(reason.toString());
    });
  }

  private receive(data: RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch (error) {
      this.options.logError(`dropped an unparsable hub frame: ${describe(error)}`);
      return;
    }
    const validation = validateOrchestratorHubMessage(parsed);
    if (!validation.ok) {
      this.options.logError(`dropped a malformed hub frame: ${validation.reason}`);
      return;
    }
    this.handle(validation.value);
  }

  private handle(message: OrchestratorHubToClient): void {
    switch (message.type) {
      case "client.welcome":
        this.handleWelcome(message.heartbeatSeconds, message.scopes);
        return;
      case "rpc.response":
        this.settle(message.requestId, "error" in message ? { ok: false, error: message.error } : { ok: true, result: message.result });
        return;
      case "doorbell":
        this.options.onDoorbell(message);
        return;
      case "attachment.replaced":
        this.attachedThreadIds.delete(message.threadId);
        this.options.onAttachmentReplaced(message);
        return;
      case "client.revoked":
        this.handleRevoked();
        return;
    }
  }

  private handleWelcome(heartbeatSeconds: number, scopes: OrchestratorClientScope[]): void {
    this.clearWelcomeTimer();
    this.ready = true;
    this.consecutiveFailures = 0;
    this.lastCloseReason = undefined;
    const changed = !sameScopes(this.scopes, scopes);
    this.scopes = [...scopes];
    if (changed) this.options.onScopesChanged([...this.scopes]);
    this.startHeartbeat(heartbeatSeconds);
    void this.reattachThreads();
  }

  private handleRevoked(): void {
    this.revoked = true;
    this.ready = false;
    this.attachedThreadIds.clear();
    this.clearTimers();
    this.failPending({ ok: false, error: { code: "revoked", message: "this orchestrator credential was revoked by an operator" } });
    this.options.onRevoked();
    this.closeSocket();
  }

  private handleClose(reasonText: string): void {
    this.ready = false;
    this.clearWelcomeTimer();
    this.clearHeartbeat();
    if (isOrchestratorClientCloseReason(reasonText)) {
      this.lastCloseReason = reasonText;
      if (reasonText === "revoked") {
        this.handleRevoked();
        return;
      }
      this.options.logError(`the hub closed the orchestrator connection: ${reasonText}`);
    }
    this.failPending(unavailable(this.disconnectedReason()));
    if (this.stopped || this.revoked) return;
    this.consecutiveFailures += 1;
    this.scheduleReconnect();
  }

  /**
   * Re-attaches every thread this process held. A thread the hub no longer grants is forgotten, so
   * a stale attachment can never be retried forever.
   */
  private async reattachThreads(): Promise<void> {
    for (const threadId of [...this.attachedThreadIds]) {
      const outcome = await this.call("attach_thread", { threadId });
      if (outcome.ok) continue;
      if (outcome.error.code === "hub_unavailable") return;
      this.attachedThreadIds.delete(threadId);
      this.options.onReattachFailed(threadId, outcome.error);
    }
  }

  private startHeartbeat(heartbeatSeconds: number): void {
    this.clearHeartbeat();
    const interval = Math.max(1, Math.min(heartbeatSeconds, orchestratorClientHeartbeatSeconds)) * 1_000;
    this.heartbeatTimer = setInterval(() => {
      const socket = this.socket;
      if (socket === undefined || socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.send(JSON.stringify({ type: "client.heartbeat" } satisfies OrchestratorClientToHub));
      } catch (error) {
        this.options.logError(`could not send a heartbeat: ${describe(error)}`);
      }
    }, interval);
    this.heartbeatTimer.unref?.();
  }

  /** Capped exponential backoff with full jitter, from one second to thirty. */
  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const exponential = this.options.initialReconnectDelayMilliseconds * 2 ** Math.min(this.consecutiveFailures, 20);
    const capped = Math.min(exponential, this.options.maximumReconnectDelayMilliseconds);
    const delay = Math.max(1, Math.round(capped * (0.5 + this.options.random() * 0.5)));
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
    this.reconnectTimer.unref?.();
  }

  private settle(requestId: string, outcome: HubCallOutcome): void {
    const request = this.pending.get(requestId);
    if (request === undefined) return;
    this.pending.delete(requestId);
    clearTimeout(request.timer);
    request.settle(outcome);
  }

  private failPending(outcome: HubCallOutcome): void {
    for (const requestId of [...this.pending.keys()]) this.settle(requestId, outcome);
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  private clearTimers(): void {
    this.clearWelcomeTimer();
    this.clearHeartbeat();
    this.clearReconnectTimer();
  }

  private clearWelcomeTimer(): void {
    if (this.welcomeTimer !== undefined) clearTimeout(this.welcomeTimer);
    this.welcomeTimer = undefined;
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }
}

const sameScopes = (left: readonly OrchestratorClientScope[], right: readonly OrchestratorClientScope[]) =>
  left.length === right.length && [...left].sort().join() === [...right].sort().join();

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
