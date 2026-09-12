import { useCallback, useEffect, useRef, useState } from "react";
import type { Snapshot } from "@coffee-shop/protocol";

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected" | "authentication-required";

export interface ConnectionView {
  status: ConnectionStatus;
  snapshot: Snapshot;
  canMutate: boolean;
}

interface SocketLike {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  close(): void;
}

export interface ConnectionEnvironment {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  createWebSocket(url: string): SocketLike;
  isOnline(): boolean;
  addEventListener(type: "online" | "offline", listener: () => void): void;
  removeEventListener(type: "online" | "offline", listener: () => void): void;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(id: number): void;
  random(): number;
  socketUrl(token: string): string;
}

export const emptySnapshot: Snapshot = {
  agents: [],
  nodes: [],
  runs: [],
  events: [],
  messages: [],
  generatedAt: ""
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isOptionalString = (value: unknown) => value === undefined || isString(value);
const isOneOf = <T extends string>(value: unknown, options: readonly T[]): value is T => isString(value) && options.includes(value as T);
const isArrayOf = (value: unknown, validator: (item: unknown) => boolean) => Array.isArray(value) && value.every(validator);

const harnessIds = ["claude-cli", "codex-cli", "shell", "ag-ui"] as const;
const agentStates = ["idle", "thinking", "working", "waiting", "blocked", "done"] as const;
const avatarShapes = ["cup", "bean", "moka", "kettle", "grinder", "pour-over"] as const;
const avatarColors = ["amber", "sage", "clay", "sky", "plum", "rose"] as const;
const runStatuses = ["queued", "running", "completed", "failed", "cancelled"] as const;

function isHarness(value: unknown): boolean {
  return isObject(value)
    && isOneOf(value.id, harnessIds)
    && isString(value.label)
    && isString(value.description)
    && isOptionalString(value.binary)
    && typeof value.available === "boolean"
    && isOneOf(value.authMode, ["local-subscription", "local-account", "api", "none"])
    && isArrayOf(value.models, isString);
}

function isAgent(value: unknown): boolean {
  return isObject(value)
    && isString(value.id)
    && isString(value.name)
    && isString(value.title)
    && isString(value.summary)
    && isString(value.glyph)
    && isOneOf(value.avatarShape, avatarShapes)
    && isOneOf(value.avatarColor, avatarColors)
    && isOneOf(value.state, agentStates)
    && isString(value.currentAction)
    && isOneOf(value.harnessId, harnessIds)
    && isString(value.model)
    && isString(value.computeNodeId)
    && isString(value.workspace)
    && isString(value.systemPrompt)
    && isNumber(value.unread)
    && isString(value.updatedAt);
}

function isNode(value: unknown): boolean {
  return isObject(value)
    && isString(value.id)
    && isString(value.name)
    && isOneOf(value.kind, ["local", "home-server", "cloud"])
    && isString(value.platform)
    && isOneOf(value.status, ["online", "offline", "busy"])
    && isString(value.lastSeen)
    && isNumber(value.activeRuns)
    && isNumber(value.concurrency)
    && isArrayOf(value.workspaceRoots, isString)
    && isArrayOf(value.harnesses, isHarness)
    && isString(value.version);
}

function isRun(value: unknown): boolean {
  return isObject(value)
    && isString(value.id)
    && isString(value.agentId)
    && isString(value.nodeId)
    && isOneOf(value.harnessId, harnessIds)
    && isString(value.model)
    && isString(value.workspace)
    && isString(value.prompt)
    && isOneOf(value.status, runStatuses)
    && isString(value.output)
    && isOptionalString(value.error)
    && isNumber(value.depth)
    && isOptionalString(value.parentRunId)
    && isOptionalString(value.startedAt)
    && isOptionalString(value.finishedAt)
    && isString(value.createdAt);
}

function isEvent(value: unknown): boolean {
  return isObject(value)
    && isString(value.id)
    && isOneOf(value.type, ["run", "status", "handoff", "node", "message"])
    && isString(value.title)
    && isString(value.detail)
    && isOptionalString(value.agentId)
    && isOptionalString(value.runId)
    && isOptionalString(value.fromAgentId)
    && isOptionalString(value.toAgentId)
    && isString(value.createdAt);
}

function isMessage(value: unknown): boolean {
  return isObject(value)
    && isString(value.id)
    && isString(value.agentId)
    && isOneOf(value.author, ["you", "agent", "system"])
    && isString(value.body)
    && isOneOf(value.kind, ["message", "handoff", "status"])
    && isOptionalString(value.runId)
    && isString(value.createdAt);
}

export function isSnapshot(value: unknown): value is Snapshot {
  return isObject(value)
    && isArrayOf(value.agents, isAgent)
    && isArrayOf(value.nodes, isNode)
    && isArrayOf(value.runs, isRun)
    && isArrayOf(value.events, isEvent)
    && isArrayOf(value.messages, isMessage)
    && isString(value.generatedAt);
}

function parseSnapshotEnvelope(data: unknown): Snapshot | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const message: unknown = JSON.parse(data);
    if (!isObject(message) || message.type !== "snapshot" || !isSnapshot(message.data)) return undefined;
    return message.data;
  } catch {
    return undefined;
  }
}

function browserEnvironment(): ConnectionEnvironment {
  return {
    fetch: (input, init) => window.fetch(input, init),
    createWebSocket: (url) => new WebSocket(url),
    isOnline: () => navigator.onLine,
    addEventListener: (type, listener) => window.addEventListener(type, listener),
    removeEventListener: (type, listener) => window.removeEventListener(type, listener),
    setTimeout: (callback, delay) => window.setTimeout(callback, delay),
    clearTimeout: (id) => window.clearTimeout(id),
    random: () => Math.random(),
    socketUrl: (token) => {
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      const query = token ? `?token=${encodeURIComponent(token)}` : "";
      return `${protocol}://${location.host}/events${query}`;
    }
  };
}

export class HubConnection {
  private snapshot = emptySnapshot;
  private status: ConnectionStatus = "connecting";
  private hasSnapshot = false;
  private generation = 0;
  private retryCount = 0;
  private timer: number | undefined;
  private socket: SocketLike | undefined;
  private abortController: AbortController | undefined;
  private started = false;

  constructor(
    private readonly token: string,
    private readonly environment: ConnectionEnvironment,
    private readonly onChange: (view: ConnectionView) => void
  ) {}

  private readonly onOffline = () => {
    if (!this.started) return;
    if (this.status === "authentication-required") return;
    this.generation += 1;
    this.clearResources();
    this.status = "disconnected";
    this.emit();
  };

  private readonly onOnline = () => {
    if (!this.started) return;
    if (this.status === "authentication-required") return;
    this.attempt();
  };

  start() {
    if (this.started) return;
    this.started = true;
    this.environment.addEventListener("online", this.onOnline);
    this.environment.addEventListener("offline", this.onOffline);
    this.emit();
    this.attempt();
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.generation += 1;
    this.clearResources();
    this.environment.removeEventListener("online", this.onOnline);
    this.environment.removeEventListener("offline", this.onOffline);
  }

  retry() {
    if (!this.started) return;
    if (!this.environment.isOnline()) {
      this.generation += 1;
      this.clearResources();
      this.status = "disconnected";
      this.emit();
      return;
    }
    this.attempt();
  }

  private emit() {
    if (!this.started) return;
    this.onChange({
      status: this.status,
      snapshot: this.snapshot,
      canMutate: this.status === "connected"
    });
  }

  private clearTimer() {
    if (this.timer === undefined) return;
    this.environment.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private clearResources() {
    this.clearTimer();
    this.abortController?.abort();
    this.abortController = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  private attempt() {
    this.generation += 1;
    const generation = this.generation;
    this.clearResources();
    if (!this.environment.isOnline()) {
      this.status = "disconnected";
      this.emit();
      return;
    }
    this.status = this.hasSnapshot ? "reconnecting" : "connecting";
    this.emit();
    const abortController = new AbortController();
    this.abortController = abortController;
    void this.environment.fetch("/api/snapshot", {
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
      signal: abortController.signal
    }).then(async (response) => {
      if (!this.isCurrent(generation)) return;
      if (response.status === 401) {
        this.abortController = undefined;
        this.status = "authentication-required";
        this.emit();
        return;
      }
      if (!response.ok) throw new Error("Snapshot request failed");
      const data: unknown = await response.json();
      if (!this.isCurrent(generation)) return;
      if (!isSnapshot(data)) throw new Error("Invalid snapshot");
      this.abortController = undefined;
      this.snapshot = data;
      this.hasSnapshot = true;
      this.emit();
      this.openSocket(generation);
    }).catch(() => {
      if (!this.isCurrent(generation)) return;
      this.abortController = undefined;
      this.status = "disconnected";
      this.emit();
      this.scheduleRetry(generation);
    });
  }

  private openSocket(generation: number) {
    if (!this.isCurrent(generation)) return;
    let socket: SocketLike;
    try {
      socket = this.environment.createWebSocket(this.environment.socketUrl(this.token));
    } catch {
      this.status = "reconnecting";
      this.emit();
      this.scheduleRetry(generation);
      return;
    }
    this.socket = socket;
    let disconnected = false;
    const disconnect = () => {
      if (disconnected || !this.isCurrent(generation) || this.socket !== socket) return;
      disconnected = true;
      this.socket = undefined;
      socket.close();
      this.status = "reconnecting";
      this.emit();
      this.scheduleRetry(generation);
    };
    socket.onopen = () => undefined;
    socket.onmessage = (event) => {
      if (!this.isCurrent(generation) || this.socket !== socket) return;
      const next = parseSnapshotEnvelope(event.data);
      if (!next) {
        disconnect();
        return;
      }
      this.snapshot = next;
      this.hasSnapshot = true;
      this.status = "connected";
      this.retryCount = 0;
      this.clearTimer();
      this.emit();
    };
    socket.onerror = disconnect;
    socket.onclose = disconnect;
  }

  private scheduleRetry(generation: number) {
    if (!this.isCurrent(generation) || !this.environment.isOnline() || this.timer !== undefined) return;
    const baseDelay = Math.min(1000 * (2 ** this.retryCount), 30000);
    const delay = Math.round(baseDelay * (0.8 + (this.environment.random() * 0.4)));
    this.retryCount += 1;
    this.timer = this.environment.setTimeout(() => {
      this.timer = undefined;
      if (this.isCurrent(generation)) this.attempt();
    }, delay);
  }

  private isCurrent(generation: number) {
    return this.started && generation === this.generation;
  }
}

export function useHubConnection(token: string): ConnectionView & { retry: () => void } {
  const [view, setView] = useState<ConnectionView>({ status: "connecting", snapshot: emptySnapshot, canMutate: false });
  const connectionRef = useRef<HubConnection | undefined>(undefined);

  useEffect(() => {
    const connection = new HubConnection(token, browserEnvironment(), setView);
    connectionRef.current = connection;
    connection.start();
    return () => {
      connection.stop();
      if (connectionRef.current === connection) connectionRef.current = undefined;
    };
  }, [token]);

  const retry = useCallback(() => connectionRef.current?.retry(), []);
  return { ...view, retry };
}
