import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  externalOrchestratorToolNames,
  orchestratorClientCloseReasons,
  orchestratorClientErrorCodes,
  type OrchestratorClientScope
} from "@coffee-shop/protocol";
import { BridgeServer, channelNotificationMethod } from "./bridgeServer.js";
import { FakeHub, FakeHubToolError, type FakeHubOptions } from "./fakeHub.js";
import { HubConnection } from "./hubConnection.js";
import { pinnedProtocolRevision } from "./protocolRevision.js";

interface ChannelEvent {
  content: string;
  meta: Record<string, string>;
}

interface Harness {
  hub: FakeHub;
  connection: HubConnection;
  bridge: BridgeServer;
  client: Client;
  channelEvents: ChannelEvent[];
  toolListChanges: number;
  errors: string[];
  reattachFailures: { threadId: string; code: string }[];
  close: () => Promise<void>;
}

const waitFor = async (predicate: () => boolean, description: string, timeoutMilliseconds = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

async function startHarness(hubOptions: FakeHubOptions = { scopes: ["orchestrate"] }, waitForReady = true): Promise<Harness> {
  const hub = await FakeHub.start(hubOptions);
  const channelEvents: ChannelEvent[] = [];
  const errors: string[] = [];
  const reattachFailures: { threadId: string; code: string }[] = [];
  const harness = { toolListChanges: 0 } as Harness;

  let bridge: BridgeServer | undefined;
  const connection = new HubConnection({
    hubUrl: hub.url,
    clientId: "client-alpha",
    clientSecret: "secret-value",
    logError: (message) => errors.push(message),
    initialReconnectDelayMilliseconds: 5,
    maximumReconnectDelayMilliseconds: 20,
    welcomeTimeoutMilliseconds: 500,
    requestTimeoutMilliseconds: 1_500,
    random: () => 0,
    onDoorbell: (doorbell) => void bridge?.announceDoorbell(doorbell),
    onAttachmentReplaced: (replaced) => void bridge?.announceAttachmentReplaced(replaced),
    onRevoked: () => void bridge?.announceRevocation(),
    onScopesChanged: (scopes) => void bridge?.refreshToolListForScopes(scopes),
    onReattachFailed: (threadId, error) => reattachFailures.push({ threadId, code: error.code })
  });
  bridge = new BridgeServer({ hub: connection, serverVersion: "0.0.0-test", logError: (message) => errors.push(message) });

  const client = new Client({ name: "fake-claude-code", version: "0.0.0-test" }, { capabilities: {} });
  client.fallbackNotificationHandler = async (notification) => {
    if (notification.method === channelNotificationMethod) {
      const params = notification.params as { content: string; meta: Record<string, string> };
      channelEvents.push({ content: params.content, meta: params.meta });
      return;
    }
    if (notification.method === "notifications/tools/list_changed") harness.toolListChanges += 1;
  };

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([bridge.server.connect(serverTransport), client.connect(clientTransport)]);
  connection.start();
  if (waitForReady) await waitFor(() => connection.isReady(), "the bridge to reach the hub");

  Object.assign(harness, {
    hub,
    connection,
    bridge,
    client,
    channelEvents,
    errors,
    reattachFailures,
    close: async () => {
      connection.stop();
      await client.close();
      await bridge.server.close();
      await hub.stop();
    }
  });
  return harness;
}

const parseToolResult = (result: unknown): Record<string, unknown> => {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0].text) as Record<string, unknown>;
};

test("declares the tools and claude/channel capabilities", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const capabilities = harness.client.getServerCapabilities();
  assert.deepEqual(capabilities?.experimental?.["claude/channel"], {});
  assert.equal(capabilities?.tools?.listChanged, true);
  assert.equal(harness.client.getServerVersion()?.name, "coffeeshop");
});

test("negotiates a protocol revision Claude Code will register as a channel", async (t) => {
  const bridge = new BridgeServer({
    hub: {
      call: async () => ({ ok: false, error: { code: "hub_unavailable", message: "unused" } }),
      grantedScopes: () => [],
      isReady: () => false,
      isRevoked: () => false,
      rememberAttachment: () => {},
      forgetAttachment: () => {}
    },
    serverVersion: "0.0.0-test",
    logError: () => {}
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await bridge.server.connect(serverTransport);
  t.after(() => bridge.server.close());

  let nextRequestId = 0;
  const initialize = async (protocolVersion: unknown): Promise<string> => {
    const requestId = (nextRequestId += 1);
    const answer = new Promise<string>((resolve) => {
      clientTransport.onmessage = (message) => {
        const response = message as { id?: number; result?: { protocolVersion: string }; error?: { message: string } };
        if (response.id !== requestId) return;
        resolve(response.result?.protocolVersion ?? `rejected: ${response.error?.message ?? "unknown"}`);
      };
    });
    await clientTransport.send({
      jsonrpc: "2.0",
      id: requestId,
      method: "initialize",
      params: { protocolVersion, capabilities: {}, clientInfo: { name: "fake-claude-code", version: "0.0.0-test" } }
    } as never);
    return await answer;
  };

  await clientTransport.start();
  assert.equal(await initialize("2026-07-28"), pinnedProtocolRevision);
  assert.equal(await initialize("2099-01-01"), pinnedProtocolRevision);
  assert.equal(await initialize("2025-06-18"), "2025-06-18");
  assert.ok(pinnedProtocolRevision < "2026-07-28");
});

test("lists the approval tools only when the welcome granted the scope", async (t) => {
  const withoutScope = await startHarness({ scopes: ["orchestrate"] });
  t.after(() => withoutScope.close());
  const listedWithoutScope = (await withoutScope.client.listTools()).tools.map((tool) => tool.name);
  assert.ok(!listedWithoutScope.includes("list_approvals"));
  assert.ok(!listedWithoutScope.includes("resolve_approval"));
  assert.equal(listedWithoutScope.length, externalOrchestratorToolNames.length - 2);

  const withScope = await startHarness({ scopes: ["orchestrate", "resolve-approvals"] });
  t.after(() => withScope.close());
  const listedWithScope = (await withScope.client.listTools()).tools.map((tool) => tool.name);
  assert.deepEqual([...listedWithScope].sort(), [...externalOrchestratorToolNames].sort());
});

test("an approval tool called without the scope is refused without reaching the hub", async (t) => {
  const harness = await startHarness({ scopes: ["orchestrate"] });
  t.after(() => harness.close());
  const result = await harness.client.callTool({ name: "list_approvals", arguments: { threadId: "thread-1" } });
  assert.equal(result.isError, true);
  const payload = parseToolResult(result) as { error: { code: string } };
  assert.equal(payload.error.code, "forbidden");
  assert.equal(harness.hub.receivedOfType("rpc.request").length, 0);
});

test("maps a tool call to an rpc.request and returns the rpc.response result", async (t) => {
  const harness = await startHarness({
    scopes: ["orchestrate"],
    handle: (request) => ({ echoed: request.tool, threadId: request.arguments.threadId })
  });
  t.after(() => harness.close());

  const result = await harness.client.callTool({ name: "submit_tasks", arguments: { threadId: "thread-1", tasks: [] } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(parseToolResult(result), { echoed: "submit_tasks", threadId: "thread-1" });

  const requests = harness.hub.receivedOfType("rpc.request");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].tool, "submit_tasks");
  assert.deepEqual(requests[0].arguments, { threadId: "thread-1", tasks: [] });
});

for (const code of orchestratorClientErrorCodes) {
  test(`surfaces the ${code} rpc error to the model`, async (t) => {
    const harness = await startHarness({
      scopes: ["orchestrate", "resolve-approvals"],
      handle: () => {
        throw new FakeHubToolError({ code, message: `the hub said ${code}` });
      }
    });
    t.after(() => harness.close());
    const result = await harness.client.callTool({ name: "get_thread_context", arguments: { threadId: "thread-1" } });
    assert.equal(result.isError, true);
    const payload = parseToolResult(result) as { error: { code: string; message: string } };
    assert.equal(payload.error.code, code);
    assert.equal(payload.error.message, `the hub said ${code}`);
  });
}

test("an unknown tool name is refused instead of being forwarded", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const result = await harness.client.callTool({ name: "delete_everything", arguments: {} });
  assert.equal(result.isError, true);
  assert.equal((parseToolResult(result) as { error: { code: string } }).error.code, "not_found");
  assert.equal(harness.hub.receivedOfType("rpc.request").length, 0);
});

test("turns a doorbell into one channel notification with identifier-safe string meta", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  harness.hub.send({ type: "doorbell", threadId: "thread-1", pending: 2, approvals: 1, urgent: true, summary: "Thread \"Auth refactor\": 2 tasks completed." });
  await waitFor(() => harness.channelEvents.length === 1, "the doorbell channel event");

  const event = harness.channelEvents[0];
  assert.equal(event.content, "Thread \"Auth refactor\": 2 tasks completed.");
  assert.deepEqual(event.meta, { thread_id: "thread-1", pending: "2", approvals: "1", urgent: "true" });
  for (const [key, value] of Object.entries(event.meta)) {
    assert.match(key, /^[A-Za-z0-9_]+$/);
    assert.equal(typeof value, "string");
  }
});

test("reports channels as unknown until a channel event has been delivered", async (t) => {
  const harness = await startHarness({ scopes: ["orchestrate"], handle: () => ({ summary: "thread summary" }) });
  t.after(() => harness.close());

  const before = parseToolResult(await harness.client.callTool({ name: "get_thread_context", arguments: { threadId: "thread-1" } }));
  assert.equal(before.channels, "unknown");
  assert.equal(before.summary, "thread summary");
  assert.match(String(before.channelsInstruction), /get_thread_events/);

  harness.hub.send({ type: "doorbell", threadId: "thread-1", pending: 1, approvals: 0, urgent: false, summary: "one task finished" });
  await waitFor(() => harness.channelEvents.length === 1, "the doorbell channel event");

  const after = parseToolResult(await harness.client.callTool({ name: "get_thread_context", arguments: { threadId: "thread-1" } }));
  assert.equal(after.channels, "active");
});

test("wraps a non-object thread context so the channels field is never lost", async (t) => {
  const harness = await startHarness({ scopes: ["orchestrate"], handle: () => ["an", "unexpected", "shape"] });
  t.after(() => harness.close());
  const result = parseToolResult(await harness.client.callTool({ name: "get_thread_context", arguments: { threadId: "thread-1" } }));
  assert.deepEqual(result.context, ["an", "unexpected", "shape"]);
  assert.equal(result.channels, "unknown");
});

test("re-attaches every attached thread after a reconnect", async (t) => {
  const harness = await startHarness({ scopes: ["orchestrate"], handle: (request) => ({ tool: request.tool }) });
  t.after(() => harness.close());

  await harness.client.callTool({ name: "attach_thread", arguments: { threadId: "thread-1" } });
  await harness.client.callTool({ name: "attach_thread", arguments: { threadId: "thread-2" } });
  await harness.client.callTool({ name: "detach_thread", arguments: { threadId: "thread-2" } });
  assert.deepEqual(harness.connection.attachedThreads(), ["thread-1"]);

  harness.hub.closeConnections(1001, "going away");
  await waitFor(() => harness.hub.connectionCount === 2 && harness.connection.isReady(), "the bridge to reconnect");
  await waitFor(
    () => harness.hub.receivedOfType("rpc.request").filter((request) => request.tool === "attach_thread").length === 3,
    "the re-attach after reconnect"
  );

  const attachCalls = harness.hub.receivedOfType("rpc.request").filter((request) => request.tool === "attach_thread");
  assert.deepEqual(attachCalls.at(-1)?.arguments, { threadId: "thread-1" });
  assert.equal(harness.hub.receivedOfType("client.hello").length, 2);
});

test("forgets a thread the hub refuses to re-attach", async (t) => {
  let attachCalls = 0;
  const harness = await startHarness({
    scopes: ["orchestrate"],
    handle: (request) => {
      if (request.tool !== "attach_thread") return { tool: request.tool };
      attachCalls += 1;
      if (attachCalls === 1) return { attached: true };
      throw new FakeHubToolError({ code: "forbidden", message: "another orchestrator owns this thread" });
    }
  });
  t.after(() => harness.close());

  await harness.client.callTool({ name: "attach_thread", arguments: { threadId: "thread-1" } });
  harness.hub.closeConnections(1001, "going away");
  await waitFor(() => harness.reattachFailures.length === 1, "the re-attach failure");
  assert.deepEqual(harness.reattachFailures[0], { threadId: "thread-1", code: "forbidden" });
  assert.deepEqual(harness.connection.attachedThreads(), []);
});

test("announces a replaced attachment and forgets it", async (t) => {
  const harness = await startHarness({ scopes: ["orchestrate"], handle: () => ({ attached: true }) });
  t.after(() => harness.close());
  await harness.client.callTool({ name: "attach_thread", arguments: { threadId: "thread-1" } });
  assert.deepEqual(harness.connection.attachedThreads(), ["thread-1"]);

  harness.hub.send({ type: "attachment.replaced", threadId: "thread-1", attachmentId: "attachment-1" });
  await waitFor(() => harness.channelEvents.length === 1, "the takeover channel event");
  assert.match(harness.channelEvents[0].content, /was taken over by another session/);
  assert.deepEqual(harness.channelEvents[0].meta, { thread_id: "thread-1" });
  assert.deepEqual(harness.connection.attachedThreads(), []);
});

test("a revoked credential stops reconnecting and fails every tool", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const connectionsBefore = harness.hub.connectionCount;

  harness.hub.send({ type: "client.revoked" });
  await waitFor(() => harness.connection.isRevoked(), "the revocation");
  await waitFor(() => harness.channelEvents.length === 1, "the revocation channel event");
  assert.match(harness.channelEvents[0].content, /revoked/);

  for (const name of ["create_thread", "get_thread_events"]) {
    const result = await harness.client.callTool({ name, arguments: { threadId: "thread-1" } });
    assert.equal(result.isError, true);
    assert.equal((parseToolResult(result) as { error: { code: string } }).error.code, "revoked");
  }

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(harness.hub.connectionCount, connectionsBefore, "a revoked bridge must not reconnect");
});

for (const closeReason of orchestratorClientCloseReasons) {
  test(`surfaces a "${closeReason}" hello rejection through tool errors`, async (t) => {
    const harness = await startHarness({ closeReason }, false);
    t.after(() => harness.close());
    await waitFor(() => harness.hub.connectionCount >= 1 && !harness.connection.isReady(), "the rejected handshake");

    if (closeReason === "revoked") {
      await waitFor(() => harness.connection.isRevoked(), "the revocation");
      const result = await harness.client.callTool({ name: "list_threads", arguments: {} });
      assert.equal((parseToolResult(result) as { error: { code: string } }).error.code, "revoked");
      return;
    }

    await waitFor(() => harness.hub.connectionCount >= 2, "a retry after a retryable rejection");
    const result = await harness.client.callTool({ name: "list_threads", arguments: {} });
    assert.equal(result.isError, true);
    const payload = parseToolResult(result) as { error: { code: string; message: string } };
    assert.equal(payload.error.code, "hub_unavailable");
    assert.match(payload.error.message, new RegExp(closeReason));
  });
}

test("fails a tool call fast while disconnected instead of queuing it", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  await harness.hub.stop();
  await waitFor(() => !harness.connection.isReady(), "the disconnect");

  const started = Date.now();
  const result = await harness.client.callTool({ name: "list_threads", arguments: {} });
  assert.ok(Date.now() - started < 1_000, "the call must fail immediately, not wait for a timeout");
  assert.equal(result.isError, true);
  assert.equal((parseToolResult(result) as { error: { code: string } }).error.code, "hub_unavailable");
});

test("drops a malformed hub frame without crashing or telling the model", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  harness.hub.sendRaw("this is not json");
  harness.hub.sendRaw(JSON.stringify({ type: "doorbell", threadId: "thread-1" }));
  harness.hub.sendRaw(JSON.stringify({ type: "doorbell", threadId: "thread-1", pending: "two", approvals: 0, urgent: false, summary: "s" }));
  harness.hub.sendRaw(JSON.stringify({ type: "nonsense" }));
  await waitFor(() => harness.errors.length >= 4, "the dropped-frame logs");

  harness.hub.send({ type: "doorbell", threadId: "thread-1", pending: 1, approvals: 0, urgent: false, summary: "still alive" });
  await waitFor(() => harness.channelEvents.length === 1, "the following good doorbell");
  assert.equal(harness.channelEvents[0].content, "still alive");
  assert.equal(harness.connection.isReady(), true);
});

test("announces a tool list change when a reconnect changes the granted scopes", async (t) => {
  const harness = await startHarness({ scopes: ["orchestrate"], handle: () => ({}) });
  t.after(() => harness.close());
  await harness.client.listTools();
  assert.equal(harness.toolListChanges, 0);

  harness.hub.options = { ...harness.hub.options, scopes: ["orchestrate", "resolve-approvals"] as OrchestratorClientScope[] };
  harness.hub.closeConnections(1001, "going away");
  await waitFor(() => harness.toolListChanges === 1, "the tools/list_changed notification");

  const listed = (await harness.client.listTools()).tools.map((tool) => tool.name);
  assert.ok(listed.includes("resolve_approval"));
});

test("sends heartbeats the hub contract accepts", async (t) => {
  const harness = await startHarness({ scopes: ["orchestrate"], heartbeatSeconds: 1 });
  t.after(() => harness.close());
  await waitFor(() => harness.hub.receivedOfType("client.heartbeat").length >= 1, "a heartbeat", 4_000);
  assert.deepEqual(harness.hub.rejectedFrames, []);
});

test("extends the request timeout for a long poll rather than cutting it short", async (t) => {
  const harness = await startHarness({
    scopes: ["orchestrate"],
    handle: async (request) => {
      if (request.tool !== "get_thread_events") return {};
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { events: [], cursor: "cursor-1" };
    }
  });
  t.after(() => harness.close());
  const result = await harness.client.callTool(
    { name: "get_thread_events", arguments: { threadId: "thread-1", waitMilliseconds: 150 } },
    undefined,
    { timeout: 10_000 }
  );
  assert.deepEqual(parseToolResult(result), { events: [], cursor: "cursor-1" });
});

test("remembers the thread a create_thread result names", async (t) => {
  const harness = await startHarness({ scopes: ["orchestrate"], handle: () => ({ thread: { id: "thread-created" } }) });
  t.after(() => harness.close());
  await harness.client.callTool({ name: "create_thread", arguments: { title: "Auth refactor", objective: "Ship it" } });
  assert.deepEqual(harness.connection.attachedThreads(), ["thread-created"]);
});

test("never writes the client secret into an error log", async (t) => {
  const harness = await startHarness({ closeReason: "unauthorized" }, false);
  t.after(() => harness.close());
  await waitFor(() => harness.errors.length >= 1, "a connection error log");
  assert.ok(!harness.errors.join("\n").includes("secret-value"), "no log line may contain the secret");
  const hellos = harness.hub.receivedOfType("client.hello");
  assert.ok(hellos.length >= 1 && hellos.every((hello) => hello.secret === "secret-value"), "client.hello is the only frame carrying the secret");
});
