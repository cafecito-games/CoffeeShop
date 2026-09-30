import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import type {
  HostHarnessSessionInventoryComplete,
  HostHarnessSessionInventoryPage,
  HostSessionControlMessage
} from "@coffee-shop/protocol";
import { WebSocket, type RawData } from "ws";

type HistoryPage = Extract<HostSessionControlMessage, { type: "host-session.history.page" }>;
type JsonMessage = Record<string, any>;
type PendingMessage = {
  predicate: (message: JsonMessage) => boolean;
  resolve: (message: JsonMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const hubDirectory = fileURLToPath(new URL("..", import.meta.url));
const fixtureDirectory = fileURLToPath(new URL("../../../packages/protocol/test/fixtures/control-v6/", import.meta.url));

class JsonInbox {
  private readonly queued: JsonMessage[] = [];
  private readonly pending: PendingMessage[] = [];

  constructor(socket: WebSocket) {
    socket.on("message", (raw: RawData) => {
      const message = JSON.parse(raw.toString()) as JsonMessage;
      const index = this.pending.findIndex((item) => item.predicate(message));
      if (index < 0) {
        this.queued.push(message);
        return;
      }
      const [item] = this.pending.splice(index, 1);
      clearTimeout(item!.timer);
      item!.resolve(message);
    });
  }

  next(predicate: (message: JsonMessage) => boolean, timeoutMilliseconds = 3_000) {
    const index = this.queued.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.queued.splice(index, 1)[0]!);
    return new Promise<JsonMessage>((resolve, reject) => {
      const item = {} as PendingMessage;
      item.predicate = predicate;
      item.resolve = resolve;
      item.reject = reject;
      item.timer = setTimeout(() => {
        const pendingIndex = this.pending.indexOf(item);
        if (pendingIndex >= 0) this.pending.splice(pendingIndex, 1);
        reject(new Error("timed out waiting for websocket message"));
      }, timeoutMilliseconds);
      this.pending.push(item);
    });
  }

  async expectNone(predicate: (message: JsonMessage) => boolean) {
    let received: JsonMessage;
    try {
      received = await this.next(predicate, 150);
    } catch (error) {
      assert.match((error as Error).message, /timed out waiting for websocket message/);
      return;
    }
    assert.fail(`unexpected websocket message: ${JSON.stringify(received)}`);
  }

  async drainUntilQuiet(predicate: (message: JsonMessage) => boolean) {
    for (;;) {
      try {
        await this.next(predicate, 150);
      } catch (error) {
        assert.match((error as Error).message, /timed out waiting for websocket message/);
        return;
      }
    }
  }
}

async function loadFixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(fixtureDirectory, `${name}.json`), "utf8")) as T;
}

const stopProcess = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
};

async function startHub(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-host-gateway-"));
  const profiles = join(directory, "profiles.json");
  await writeFile(profiles, JSON.stringify({ profiles: [] }));
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: hubDirectory,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: "0",
      COFFEE_SHOP_TOKEN: "gateway-test-token",
      COFFEE_SHOP_DATABASE: join(directory, "coffee-shop.sqlite"),
      COFFEE_SHOP_DATA: join(directory, "legacy-state.json"),
      PROJECT_PROFILES_PATH: profiles
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Hub startup timed out\n${output}`)), 10_000);
    const inspect = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/Coffee Shop hub listening on http:\/\/localhost:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    };
    child.stdout!.on("data", inspect);
    child.stderr!.on("data", inspect);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Hub exited before listening (${code ?? signal})\n${output}`));
    });
  });
  t.after(async () => {
    await stopProcess(child);
    await rm(directory, { recursive: true, force: true });
  });
  return { port, output: () => output };
}

async function openSocket(url: string) {
  const socket = new WebSocket(url);
  const inbox = new JsonInbox(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, inbox };
}

const closeSocket = async (socket: WebSocket) => {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.close();
  await closed;
};

const registration = {
  type: "register",
  protocolVersion: "6",
  node: {
    id: "node-one", name: "Local", kind: "local", platform: "linux", status: "online",
    lastSeen: "2026-09-30T12:00:00Z", activeRuns: 0, concurrency: 1,
    instanceCapacity: 1, activeInstances: 0, workspaceRoots: ["/workspaces"], version: "0.1.0",
    harnesses: [{
      id: "codex-cli", label: "Codex", description: "Local Codex", available: true,
      authMode: "local-subscription", models: ["gpt-5"],
      interactiveSessions: { operations: ["adopt", "create", "discover"] }
    }]
  }
} as const;

const syncComplete = {
  type: "sync.complete", nodeId: "node-one", activeRunIds: [], activeInstanceIds: [], at: "2026-09-30T12:00:00Z"
};

const send = (socket: WebSocket, message: unknown) => socket.send(JSON.stringify(message));
const snapshotMessage = (message: JsonMessage) => message.type === "snapshot";

test("protocol-v6 gateway commits and broadcasts only authoritative host-session evidence across replacement and close", async (t) => {
  const { port, output } = await startHub(t);
  const events = await openSocket(`ws://127.0.0.1:${port}/events?token=gateway-test-token`);
  t.after(() => closeSocket(events.socket));
  const initial = await events.inbox.next(snapshotMessage);
  assert.deepEqual(initial.data.hostHarnessSessions, []);

  const control = await openSocket(`ws://127.0.0.1:${port}/control-agent?token=gateway-test-token`);
  t.after(() => closeSocket(control.socket));
  send(control.socket, registration);
  await events.inbox.next((message) => snapshotMessage(message)
    && message.data.nodes.some((node: JsonMessage) => node.id === "node-one" && node.status === "online"));
  send(control.socket, syncComplete);
  await events.inbox.drainUntilQuiet(snapshotMessage);

  const page = await loadFixture<HostHarnessSessionInventoryPage>("inventory-page");
  const complete = await loadFixture<HostHarnessSessionInventoryComplete>("inventory-complete");
  send(control.socket, page);
  await events.inbox.expectNone(snapshotMessage);
  send(control.socket, complete);
  const committed = await events.inbox.next((message) => snapshotMessage(message)
    && message.data.hostHarnessSessions?.[0]?.hostHarnessSessionId === "host-session-one");
  assert.equal(committed.data.hostHarnessSessions[0].providerSessionId, "provider-session-one");
  assert.equal("hostSessionHistories" in committed.data, false);

  send(control.socket, page);
  send(control.socket, complete);
  await events.inbox.expectNone(snapshotMessage);

  const history = await loadFixture<HistoryPage>("history-page");
  history.items[0]!.text = "PRIVATE_PROVIDER_HISTORY";
  send(control.socket, history);
  const historyCommit = await events.inbox.next(snapshotMessage);
  assert.doesNotMatch(JSON.stringify(historyCommit), /PRIVATE_PROVIDER_HISTORY|cursor-two/);
  send(control.socket, history);
  await events.inbox.expectNone(snapshotMessage);

  const snapshotResponse = await fetch(`http://127.0.0.1:${port}/api/snapshot`, {
    headers: { authorization: "Bearer gateway-test-token" }
  });
  assert.equal(snapshotResponse.status, 200);
  const snapshot = await snapshotResponse.json() as JsonMessage;
  assert.equal(snapshot.hostHarnessSessions[0].hostHarnessSessionId, "host-session-one");
  assert.equal("hostSessionHistories" in snapshot, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_PROVIDER_HISTORY|cursor-two/);

  const generationFive: HostHarnessSessionInventoryPage = {
    ...page,
    generation: 5,
    sessions: [{ ...page.sessions[0]!, status: "running", revision: 2, updatedAt: "2026-09-30T12:01:00Z" }],
    at: "2026-09-30T12:01:00Z"
  };
  send(control.socket, generationFive);
  await events.inbox.expectNone(snapshotMessage);
  send(control.socket, registration);
  await events.inbox.next(snapshotMessage);
  send(control.socket, syncComplete);
  await events.inbox.drainUntilQuiet(snapshotMessage);
  send(control.socket, { ...complete, generation: 5, at: "2026-09-30T12:01:00Z" });
  await events.inbox.expectNone(snapshotMessage);
  send(control.socket, generationFive);
  send(control.socket, { ...complete, generation: 5, at: "2026-09-30T12:01:00Z" });
  await events.inbox.next((message) => snapshotMessage(message)
    && message.data.hostHarnessSessions?.[0]?.status === "running");

  const generationSix: HostHarnessSessionInventoryPage = {
    ...page,
    generation: 6,
    sessions: [{ ...page.sessions[0]!, status: "idle", revision: 3, updatedAt: "2026-09-30T12:02:00Z" }],
    at: "2026-09-30T12:02:00Z"
  };
  send(control.socket, generationSix);
  await events.inbox.expectNone(snapshotMessage);
  await closeSocket(control.socket);
  await events.inbox.next((message) => snapshotMessage(message)
    && message.data.nodes.some((node: JsonMessage) => node.id === "node-one" && node.status === "offline"));

  const replacement = await openSocket(`ws://127.0.0.1:${port}/control-agent?token=gateway-test-token`);
  t.after(() => closeSocket(replacement.socket));
  send(replacement.socket, registration);
  await events.inbox.next((message) => snapshotMessage(message)
    && message.data.nodes.some((node: JsonMessage) => node.id === "node-one" && node.status === "online"));
  send(replacement.socket, syncComplete);
  await events.inbox.drainUntilQuiet(snapshotMessage);
  send(replacement.socket, { ...complete, generation: 6, at: "2026-09-30T12:02:00Z" });
  await events.inbox.expectNone(snapshotMessage);
  send(replacement.socket, generationSix);
  send(replacement.socket, { ...complete, generation: 6, at: "2026-09-30T12:02:00Z" });
  await events.inbox.next((message) => snapshotMessage(message)
    && message.data.hostHarnessSessions?.[0]?.revision === 3);
  assert.doesNotMatch(output(), /PRIVATE_PROVIDER_HISTORY|provider-session-one|\/workspaces\/coffee-shop/);
});
