import type { Snapshot } from "@coffee-shop/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  HubConnection,
  isSnapshot,
  type ConnectionEnvironment,
  type ConnectionView
} from "./hubConnection.js";

const snapshot = (generatedAt: string): Snapshot => ({
  agents: [],
  nodes: [],
  runs: [],
  events: [],
  messages: [],
  generatedAt
});

class FakeSocket {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  close = vi.fn();

  message(value: unknown) {
    this.onmessage?.({ data: typeof value === "string" ? value : JSON.stringify(value) } as MessageEvent);
  }
}

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(fetchImpl: ConnectionEnvironment["fetch"], random = () => 0.5) {
  const sockets: FakeSocket[] = [];
  const socketUrls: string[] = [];
  const timers = new Map<number, () => void>();
  const delays: number[] = [];
  const listeners = new Map<string, Set<() => void>>();
  let timerId = 0;
  let online = true;
  const environment: ConnectionEnvironment = {
    fetch: fetchImpl,
    createWebSocket: (url) => {
      const socket = new FakeSocket();
      sockets.push(socket);
      socketUrls.push(url);
      return socket;
    },
    isOnline: () => online,
    addEventListener: (type, listener) => {
      const group = listeners.get(type) ?? new Set();
      group.add(listener);
      listeners.set(type, group);
    },
    removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
    setTimeout: (callback, delay) => {
      const id = ++timerId;
      timers.set(id, callback);
      delays.push(delay);
      return id;
    },
    clearTimeout: (id) => { timers.delete(id); },
    random,
    socketUrl: (token) => `ws://example.test/events?token=${encodeURIComponent(token)}`
  };
  return {
    environment,
    sockets,
    socketUrls,
    timers,
    delays,
    setOnline(value: boolean) { online = value; },
    dispatch(type: "online" | "offline") { for (const listener of listeners.get(type) ?? []) listener(); },
    runTimer() {
      const entry = timers.entries().next().value as [number, () => void] | undefined;
      if (!entry) throw new Error("No pending timer");
      timers.delete(entry[0]);
      entry[1]();
    }
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("snapshot validation", () => {
  it("accepts a complete snapshot and rejects malformed nested records", () => {
    expect(isSnapshot(snapshot("rest"))).toBe(true);
    expect(isSnapshot({ ...snapshot("bad"), agents: [{}] })).toBe(false);
    expect(isSnapshot({ ...snapshot("bad"), nodes: [{ id: "node" }] })).toBe(false);
    expect(isSnapshot({ ...snapshot("bad"), messages: [{ author: "intruder" }] })).toBe(false);
    expect(isSnapshot({ ...snapshot("bad"), generatedAt: 42 })).toBe(false);
  });

  it("preserves well-formed unknown harness and authentication strings for fail-closed presentation", () => {
    const node = {
      id: "future-node", name: "Future", kind: "local", platform: "linux", status: "online",
      lastSeen: "now", activeRuns: 0, concurrency: 1, workspaceRoots: ["/srv/workspaces"], version: "custom",
      harnesses: [{ id: "future-harness", label: "Future", description: "External adapter", available: true, authMode: "future-auth", models: [] }]
    };
    expect(isSnapshot({ ...snapshot("future"), nodes: [node] })).toBe(true);
    expect(isSnapshot({ ...snapshot("bad"), nodes: [{ ...node, harnesses: [{ ...node.harnesses[0], authMode: 42 }] }] })).toBe(false);
  });
});

describe("version-4 orchestration snapshot validation", () => {
  const task = {
    id: "task-1", threadId: "thread-1", title: "Build", instructions: "Build the thing",
    status: "ready", requirements: {}, dependencies: [], idempotencyKey: "key-1",
    attemptRunIds: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z"
  };

  const approval = {
    id: "approval-1", harnessApprovalId: "acp-permission-1", threadId: "thread-1", runId: "run-1",
    nodeId: "node-1", title: "Write file", options: [{ id: "opt-1", label: "Allow once", kind: "allow-once" }],
    status: "pending", requestedAt: "2026-01-01T00:00:00Z"
  };

  const lease = {
    id: "lease-1", threadId: "thread-1", taskId: "task-1", runId: "run-1", nodeId: "node-1",
    projectProfileId: "profile-1", policy: "git-worktree", cleanup: "retain", root: "/srv/repos",
    sourcePath: "/srv/repos/app", worktreePath: "/srv/repos/.coffee-shop/worktrees/lease-1", status: "active",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z"
  };

  const runActivity = {
    runId: "run-1", nodeId: "node-1", streamStatus: "open", lastSequence: 1, acceptedEvents: 1,
    message: { text: "hello", truncatedBytes: 0 }, thought: { text: "", truncatedBytes: 0 },
    plan: [], toolCalls: [], diffs: [], terminals: [], warnings: [], unknownEvents: 0,
    omitted: { toolCalls: 0, diffs: 0, terminals: 0, warnings: 0 }, summary: "hello", updatedAt: "2026-01-01T00:00:00Z"
  };

  const taskMessage = {
    id: "message-1", threadId: "thread-1", sender: { type: "task", taskId: "task-1" },
    recipient: { type: "orchestrator" }, sequence: 1, kind: "question", body: "Need input",
    idempotencyKey: "key-2", createdAt: "2026-01-01T00:00:00Z"
  };

  const acknowledgement = {
    messageId: "message-1", threadId: "thread-1", recipient: { type: "orchestrator" },
    runId: "run-1", acknowledgedAt: "2026-01-01T00:00:00Z"
  };

  const sessionBinding = {
    id: "binding-1", threadId: "thread-1", agentId: "agent-1", nodeId: "node-1", harnessId: "claude-cli",
    transport: "acp-v1", workspace: "/workspace", providerSessionId: "provider-session", status: "active",
    createdByRunId: "run-1", lastRunId: "run-1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z"
  };

  it("accepts a fully populated version-4 snapshot", () => {
    expect(isSnapshot({
      ...snapshot("v4"),
      tasks: [task],
      taskMessages: [taskMessage],
      taskMessageAcknowledgements: [acknowledgement],
      sessionBindings: [sessionBinding],
      approvals: [approval],
      workspaceLeases: [lease],
      runActivity: [runActivity]
    })).toBe(true);
  });

  it("accepts a legacy snapshot with every orchestration collection absent", () => {
    expect(isSnapshot(snapshot("legacy"))).toBe(true);
  });

  it("rejects an unknown task status rather than coercing it", () => {
    expect(isSnapshot({ ...snapshot("bad"), tasks: [{ ...task, status: "in-limbo" }] })).toBe(false);
  });

  it("rejects an approval with an option of an unknown kind", () => {
    expect(isSnapshot({ ...snapshot("bad"), approvals: [{ ...approval, options: [{ id: "opt-1", label: "?", kind: "maybe" }] }] })).toBe(false);
  });

  it("rejects a workspace lease with an unknown status", () => {
    expect(isSnapshot({ ...snapshot("bad"), workspaceLeases: [{ ...lease, status: "vanished" }] })).toBe(false);
  });

  it("rejects run activity missing its bounded text fields", () => {
    expect(isSnapshot({ ...snapshot("bad"), runActivity: [{ ...runActivity, message: "hello" }] })).toBe(false);
  });

  it("rejects a task message with a malformed participant", () => {
    expect(isSnapshot({ ...snapshot("bad"), taskMessages: [{ ...taskMessage, sender: { type: "task" } }] })).toBe(false);
  });

  it("accepts a run carrying version-4 task attempt and transport fields", () => {
    const run = {
      id: "run-1", agentId: "agent-1", nodeId: "node-1", harnessId: "claude-cli", model: "sonnet",
      workspace: "/workspace", prompt: "go", status: "running", output: "", depth: 0, createdAt: "2026-01-01T00:00:00Z",
      taskId: "task-1", attempt: 1, transport: "acp-v1", fallbackTransport: "native-cli",
      transportSelection: { requestedTransport: "acp-v1", selectedTransport: "native-cli", fallbackReason: "acp-adapter-unavailable" },
      sessionBindingId: "binding-1", workspaceLeaseId: "lease-1"
    };
    expect(isSnapshot({ ...snapshot("v4"), runs: [run] })).toBe(true);
    expect(isSnapshot({ ...snapshot("bad"), runs: [{ ...run, transport: "carrier-pigeon" }] })).toBe(false);
  });
});

describe("HubConnection", () => {
  it("loads REST before opening a socket and only a valid socket snapshot becomes current", async () => {
    const pending = deferred<Response>();
    const test = harness(() => pending.promise);
    const states: ConnectionView[] = [];
    const connection = new HubConnection("secret", test.environment, (state) => states.push(state));

    connection.start();
    expect(test.sockets).toHaveLength(0);
    pending.resolve(response(200, snapshot("rest")));
    await flush();
    expect(test.sockets).toHaveLength(1);
    expect(test.socketUrls).toEqual(["ws://example.test/events?token=secret"]);
    expect(states.at(-1)).toMatchObject({ status: "connecting", snapshot: { generatedAt: "rest" }, canMutate: false });
    test.sockets[0].onopen?.(new Event("open"));
    expect(states.at(-1)?.status).toBe("connecting");
    test.sockets[0].message({ type: "snapshot", data: snapshot("socket") });
    expect(states.at(-1)).toMatchObject({ status: "connected", snapshot: { generatedAt: "socket" }, canMutate: true });
  });

  it("distinguishes a REST 401 from a transient fetch failure", async () => {
    const unauthorizedFetch = vi.fn(async () => response(401, {}));
    const unauthorized = harness(unauthorizedFetch);
    const unauthorizedStates: ConnectionView[] = [];
    const unauthorizedConnection = new HubConnection("bad", unauthorized.environment, (state) => unauthorizedStates.push(state));
    unauthorizedConnection.start();
    await flush();
    expect(unauthorizedStates.at(-1)?.status).toBe("authentication-required");
    expect(unauthorized.timers.size).toBe(0);
    unauthorized.setOnline(false);
    unauthorized.dispatch("offline");
    unauthorized.setOnline(true);
    unauthorized.dispatch("online");
    await flush();
    expect(unauthorizedStates.at(-1)?.status).toBe("authentication-required");
    expect(unauthorizedFetch).toHaveBeenCalledOnce();

    const unavailable = harness(async () => { throw new TypeError("network"); });
    const unavailableStates: ConnectionView[] = [];
    const unavailableConnection = new HubConnection("good", unavailable.environment, (state) => unavailableStates.push(state));
    unavailableConnection.start();
    await flush();
    expect(unavailableStates.at(-1)?.status).toBe("disconnected");
    expect(unavailable.timers.size).toBe(1);
  });

  it("deduplicates socket error and close into one retry", async () => {
    const test = harness(async () => response(200, snapshot("rest")));
    const states: ConnectionView[] = [];
    const connection = new HubConnection("secret", test.environment, (state) => states.push(state));
    connection.start();
    await flush();
    test.sockets[0].message({ type: "snapshot", data: snapshot("live") });

    test.sockets[0].onerror?.(new Event("error"));
    test.sockets[0].onclose?.(new CloseEvent("close"));
    expect(states.at(-1)).toMatchObject({ status: "reconnecting", snapshot: { generatedAt: "live" }, canMutate: false });
    expect(test.timers.size).toBe(1);
    expect(test.delays).toEqual([1000]);
  });

  it("uses capped exponential backoff with bounded jitter and resets after resync", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("network"); });
    const low = harness(fetchImpl, () => 0);
    const connection = new HubConnection("secret", low.environment, () => undefined);
    connection.start();
    await flush();
    for (let index = 0; index < 6; index += 1) { low.runTimer(); await flush(); }
    expect(low.delays).toEqual([800, 1600, 3200, 6400, 12800, 24000, 24000]);

    const high = harness(async () => response(200, snapshot("rest")), () => 1);
    const recovered = new HubConnection("secret", high.environment, () => undefined);
    recovered.start();
    await flush();
    high.sockets[0].onclose?.(new CloseEvent("close"));
    expect(high.delays).toEqual([1200]);
    high.runTimer();
    await flush();
    high.sockets[1].message({ type: "snapshot", data: snapshot("live") });
    high.sockets[1].onclose?.(new CloseEvent("close"));
    expect(high.delays).toEqual([1200, 1200]);
  });

  it("pauses offline and retries immediately on online or manual retry", async () => {
    const test = harness(async () => response(200, snapshot("rest")));
    const connection = new HubConnection("secret", test.environment, () => undefined);
    connection.start();
    await flush();
    test.sockets[0].onclose?.(new CloseEvent("close"));
    expect(test.timers.size).toBe(1);

    test.setOnline(false);
    connection.retry();
    expect(test.timers.size).toBe(0);
    test.dispatch("offline");
    expect(test.timers.size).toBe(0);
    test.setOnline(true);
    test.dispatch("online");
    await flush();
    expect(test.sockets).toHaveLength(2);

    test.sockets[1].onclose?.(new CloseEvent("close"));
    expect(test.timers.size).toBe(1);
    connection.retry();
    await flush();
    expect(test.timers.size).toBe(0);
    expect(test.sockets).toHaveLength(3);
  });

  it.each([
    ["non-JSON", "not-json"],
    ["wrong envelope", { type: "update", data: snapshot("bad") }],
    ["malformed snapshot", { type: "snapshot", data: { ...snapshot("bad"), runs: [{}] } }]
  ])("fails closed for %s messages", async (_label, payload) => {
    const test = harness(async () => response(200, snapshot("rest")));
    const states: ConnectionView[] = [];
    const connection = new HubConnection("secret", test.environment, (state) => states.push(state));
    connection.start();
    await flush();
    test.sockets[0].message({ type: "snapshot", data: snapshot("live") });
    test.sockets[0].message(payload);
    expect(states.at(-1)).toMatchObject({ status: "reconnecting", snapshot: { generatedAt: "live" }, canMutate: false });
    expect(test.timers.size).toBe(1);
  });

  it("ignores superseded fetches and callbacks and cleans up on stop", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const test = harness(fetchImpl);
    const states: ConnectionView[] = [];
    const connection = new HubConnection("secret", test.environment, (state) => states.push(state));
    connection.start();
    connection.retry();
    first.resolve(response(200, snapshot("obsolete")));
    second.resolve(response(200, snapshot("current-rest")));
    await flush();
    expect(test.sockets).toHaveLength(1);
    expect(states.at(-1)?.snapshot.generatedAt).toBe("current-rest");

    connection.stop();
    test.sockets[0].message({ type: "snapshot", data: snapshot("late") });
    test.sockets[0].onclose?.(new CloseEvent("close"));
    expect(states.at(-1)?.snapshot.generatedAt).toBe("current-rest");
    expect(test.timers.size).toBe(0);
  });
});
