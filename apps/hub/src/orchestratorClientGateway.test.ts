import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  externalOrchestratorToolNames,
  orchestratorClientSourceKey,
  orchestratorClientHeartbeatSeconds,
  orchestratorClientLimits,
  orchestratorClientProtocolVersion,
  validateOrchestratorClientMessage,
  validateOrchestratorHubMessage,
  type ExternalOrchestratorToolName,
  type OrchestratorClientCloseReason,
  type OrchestratorClientToHub,
  type OrchestratorHubToClient
} from "@coffee-shop/protocol";
import {
  createOrchestratorClientGateway,
  orchestratorClientMaximumFrameBytes,
  orchestratorClientMaximumInFlightRequests,
  servedExternalOrchestratorTools,
  type OrchestratorClientGateway,
  type OrchestratorClientTimers
} from "./orchestratorClientGateway.js";
import { mintOrchestratorClient, revokeOrchestratorClient } from "./orchestratorClients.js";
import { Store } from "./store.js";
import { newThread } from "./threads.js";

const at = "2026-09-22T12:00:00.000Z";

/*
 * Every inbound frame below is built as an `OrchestratorClientToHub` and passed through the real
 * `validateOrchestratorClientMessage` before it reaches the hub, and every outbound frame is read
 * back through `validateOrchestratorHubMessage`. A frame the protocol would refuse therefore fails
 * the test rather than exercising a shape the bridge could never send.
 */
function frame(message: OrchestratorClientToHub) {
  const validated = validateOrchestratorClientMessage(message);
  assert.equal(validated.ok, true, validated.ok ? "" : validated.reason);
  return JSON.stringify(message);
}

class FakeTransport {
  readonly frames: OrchestratorHubToClient[] = [];
  closedWith: OrchestratorClientCloseReason | undefined;

  send(payload: string) {
    const validated = validateOrchestratorHubMessage(JSON.parse(payload));
    assert.equal(validated.ok, true, validated.ok ? "" : validated.reason);
    if (validated.ok) this.frames.push(validated.value);
  }

  close(reason: OrchestratorClientCloseReason) {
    this.closedWith ??= reason;
  }

  lastOf<T extends OrchestratorHubToClient["type"]>(type: T) {
    return [...this.frames].reverse().find((message) => message.type === type) as Extract<OrchestratorHubToClient, { type: T }> | undefined;
  }

  responseTo(requestId: string) {
    const response = this.frames.find((message) => message.type === "rpc.response" && message.requestId === requestId);
    assert.ok(response, `no response for ${requestId}`);
    return response as Extract<OrchestratorHubToClient, { type: "rpc.response" }>;
  }
}

class ManualTimers implements OrchestratorClientTimers {
  private readonly pending = new Map<number, () => void>();
  private next = 1;

  setTimeout(handler: () => void) {
    const handle = this.next++;
    this.pending.set(handle, handler);
    return handle;
  }

  clearTimeout(handle: unknown) {
    this.pending.delete(handle as number);
  }

  fireAll() {
    for (const [handle, handler] of [...this.pending]) {
      this.pending.delete(handle);
      handler();
    }
  }
}

interface Harness {
  store: Store;
  statePath: string;
  gateway: OrchestratorClientGateway;
  timers: ManualTimers;
  broadcasts: { count: number };
  secret: string;
  clientId: string;
}

async function harness(scopes: Parameters<typeof mintOrchestratorClient>[1]["scopes"] = ["orchestrate"]): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-orchestrator-gateway-"));
  const statePath = join(directory, "state.json");
  const store = new Store(statePath);
  await store.load();
  let secret = "";
  let clientId = "";
  await store.transact((state) => {
    const minted = mintOrchestratorClient(state, { name: "Christian's laptop", scopes }, at);
    secret = minted.secret;
    clientId = minted.client.id;
  });
  const broadcasts = { count: 0 };
  const timers = new ManualTimers();
  const gateway = createOrchestratorClientGateway({ store, broadcast: () => { broadcasts.count += 1; }, now: () => new Date().toISOString(), timers });
  return { store, statePath, gateway, timers, broadcasts, secret, clientId };
}

/** Accepts a connection and drives it through the hello handshake. */
async function welcomed(context: Harness) {
  const transport = new FakeTransport();
  const connection = context.gateway.accept(transport);
  await connection.receive(frame({ type: "client.hello", protocolVersion: orchestratorClientProtocolVersion, clientId: context.clientId, secret: context.secret }));
  const welcome = transport.lastOf("client.welcome");
  assert.ok(welcome, "the hub welcomed the connection");
  return { transport, connection, connectionId: welcome.connectionId };
}

let requestCounter = 0;
async function call(connection: { receive(raw: string): Promise<void> }, transport: FakeTransport, tool: ExternalOrchestratorToolName, argumentsValue: Record<string, unknown> = {}) {
  const requestId = `request-${requestCounter += 1}`;
  await connection.receive(frame({ type: "rpc.request", requestId, tool, arguments: argumentsValue }));
  return transport.responseTo(requestId);
}

const resultOf = (response: Extract<OrchestratorHubToClient, { type: "rpc.response" }>) => {
  assert.ok(!("error" in response), `unexpected error ${JSON.stringify((response as { error?: unknown }).error)}`);
  return (response as { result: any }).result;
};

const errorOf = (response: Extract<OrchestratorHubToClient, { type: "rpc.response" }>) => {
  assert.ok("error" in response, `expected an error, got ${JSON.stringify(response)}`);
  return (response as { error: { code: string; message: string } }).error;
};

test("welcomes a valid credential and records that it was seen", async () => {
  const context = await harness(["orchestrate", "resolve-approvals"]);
  const { transport } = await welcomed(context);

  const welcome = transport.lastOf("client.welcome")!;
  assert.equal(welcome.heartbeatSeconds, orchestratorClientHeartbeatSeconds);
  assert.deepEqual(welcome.scopes, ["orchestrate", "resolve-approvals"]);
  assert.equal(transport.closedWith, undefined);
  assert.equal(context.gateway.connectionCount(), 1);
  assert.ok(context.store.snapshot().orchestratorClients![0].lastSeenAt, "the credential records its last use");
  assert.ok(!JSON.stringify(transport.frames).includes("secretHash"), "no frame carries a secret hash");
});

test("closes a connection that never says hello", async () => {
  const context = await harness();
  const transport = new FakeTransport();
  context.gateway.accept(transport);

  context.timers.fireAll();

  assert.equal(transport.closedWith, "unauthorized");
  assert.equal(context.gateway.connectionCount(), 0);
});

test("closes a connection that sends any other frame before the welcome", async () => {
  for (const first of [
    { type: "client.heartbeat" } as const,
    { type: "rpc.request", requestId: "request-early", tool: "list_threads", arguments: {} } as const
  ]) {
    const context = await harness();
    const transport = new FakeTransport();
    const connection = context.gateway.accept(transport);
    await connection.receive(frame(first));
    assert.equal(transport.closedWith, "unauthorized", first.type);
    assert.deepEqual(transport.frames, []);
  }
});

test("closes a hello the hub cannot honour with the matching reason", async () => {
  const wrongSecret = await harness();
  const unknownClient = await harness();
  const revoked = await harness();
  await revoked.store.transact((state) => { revokeOrchestratorClient(state, revoked.clientId, at); });

  const cases: Array<[Harness, OrchestratorClientToHub, OrchestratorClientCloseReason]> = [
    [wrongSecret, { type: "client.hello", protocolVersion: 1, clientId: wrongSecret.clientId, secret: `csoc_${wrongSecret.clientId}_${"a".repeat(43)}` }, "unauthorized"],
    [unknownClient, { type: "client.hello", protocolVersion: 1, clientId: "orchestrator-client-absent", secret: unknownClient.secret }, "unauthorized"],
    [revoked, { type: "client.hello", protocolVersion: 1, clientId: revoked.clientId, secret: revoked.secret }, "revoked"]
  ];
  for (const [context, hello, reason] of cases) {
    const transport = new FakeTransport();
    const connection = context.gateway.accept(transport);
    await connection.receive(frame(hello));
    assert.equal(transport.closedWith, reason, reason);
    assert.deepEqual(transport.frames, []);
    assert.equal(context.gateway.connectionCount(), 0);
  }
});

test("closes a hello for another protocol revision as unsupported rather than unauthorized", async () => {
  const context = await harness();
  const transport = new FakeTransport();
  const connection = context.gateway.accept(transport);

  // A future revision is not a frame this revision's validator accepts, so it is sent raw.
  await connection.receive(JSON.stringify({ type: "client.hello", protocolVersion: orchestratorClientProtocolVersion + 1, clientId: context.clientId, secret: context.secret }));

  assert.equal(transport.closedWith, "unsupported_version");
});

test("closes a second hello on a welcomed connection", async () => {
  const context = await harness();
  const { transport, connection } = await welcomed(context);

  await connection.receive(frame({ type: "client.hello", protocolVersion: 1, clientId: context.clientId, secret: context.secret }));

  assert.equal(transport.closedWith, "unauthorized");
});

test("creates an external thread, attaches it, and queues no run", async () => {
  const context = await harness();
  const { transport, connection, connectionId } = await welcomed(context);

  const result = resultOf(await call(connection, transport, "create_thread", { title: "Auth refactor", objective: "Ship the auth refactor" }));
  assert.equal(result.thread.title, "Auth refactor");
  assert.equal(result.thread.attachment.connectionId, connectionId);
  assert.equal(result.thread.attachment.status, "attached");
  assert.equal(result.thread.unreadEvents, 0);

  const snapshot = context.store.snapshot();
  assert.deepEqual(snapshot.runs, [], "no run is queued for an external thread");
  assert.equal(snapshot.threads!.find((thread) => thread.id === result.thread.id)!.ownerAgentId, undefined);
  assert.equal(snapshot.orchestratorAttachments!.length, 1);
});

test("registers external artifacts with source-scoped replay and fresh bridge-only grants", async () => {
  const context = await harness();
  const first = await welcomed(context);
  const threadId = resultOf(await call(first.connection, first.transport, "create_thread", { objective: "Publish it" })).thread.id;
  const argumentsValue = {
    threadId,
    relativePath: "reports/result.txt",
    title: "Result",
    kind: "report",
    mediaType: "text/plain",
    summary: "Ready",
    size: 5,
    sha256: "a".repeat(64),
    idempotencyKey: "external-result"
  };

  const created = resultOf(await call(first.connection, first.transport, "post_artifact", argumentsValue));
  assert.equal(created.artifact.sourceKey, `orchestrator-client:${context.clientId}`);
  assert.equal(created.artifact.runId, undefined);
  assert.equal(created.artifact.agentId, undefined);
  assert.equal(created.artifact.instanceId, undefined);
  assert.equal(created.artifact.allocationId, undefined);
  assert.equal(created.artifact.uploaded, false);
  assert.equal(created.uploadGrant.path, created.artifact.downloadPath);
  assert.match(created.uploadGrant.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(context.store.snapshot()).includes(created.uploadGrant.token), false);

  const replay = resultOf(await call(first.connection, first.transport, "post_artifact", argumentsValue));
  assert.equal(replay.artifact.id, created.artifact.id);
  assert.notEqual(replay.uploadGrant.token, created.uploadGrant.token);
  assert.equal(context.store.snapshot().artifacts?.length, 1);
  assert.equal(context.store.read((state) => state.artifactUploadGrants?.length), 1, "exact replay prunes replaced private authority");

  const second = await welcomed(context);
  await call(second.connection, second.transport, "attach_thread", { threadId });
  const reconnectReplay = resultOf(await call(second.connection, second.transport, "post_artifact", argumentsValue));
  assert.equal(reconnectReplay.artifact.id, created.artifact.id);
  assert.notEqual(reconnectReplay.uploadGrant.token, replay.uploadGrant.token);
  assert.equal(context.store.read((state) => state.artifactUploadGrants?.length), 1, "reconnect replay remains bounded");

  const beforeConflict = context.store.read((state) => JSON.stringify([state.artifacts, state.artifactUploadGrants, state.events]));
  assert.equal(errorOf(await call(second.connection, second.transport, "post_artifact", {
    ...argumentsValue, summary: "Changed"
  })).code, "conflict");
  assert.equal(context.store.read((state) => JSON.stringify([state.artifacts, state.artifactUploadGrants, state.events])), beforeConflict);
});

test("publishes an externally attributed preview lifecycle with convergent replay authority", async () => {
  const context = await harness();
  const first = await welcomed(context);
  const threadId = resultOf(await call(first.connection, first.transport, "create_thread", { objective: "Preview it" })).thread.id;
  const argumentsValue = {
    threadId,
    relativePath: "dist",
    title: "External preview",
    kind: "preview-bundle",
    mediaType: "application/vnd.coffee-shop.preview-bundle+tar+gzip",
    summary: "Review the current build",
    size: 512,
    sha256: "b".repeat(64),
    entrypoint: "index.html",
    ttlSeconds: 3_600,
    idempotencyKey: "external-preview"
  };

  const created = resultOf(await call(first.connection, first.transport, "publish_preview", argumentsValue));
  const sourceKey = orchestratorClientSourceKey(context.clientId);
  assert.equal(created.created, true);
  assert.equal(created.artifact.sourceKey, sourceKey);
  assert.equal(created.preview.sourceKey, sourceKey);
  assert.equal(created.artifact.runId, undefined);
  assert.equal(created.preview.runId, undefined);
  assert.equal(created.preview.artifactId, created.artifact.id);
  assert.equal(created.preview.artifactSha256, created.artifact.sha256);
  assert.equal(created.preview.status, "upload-pending");
  assert.equal(created.preview.accessState, "unavailable");
  assert.equal(created.uploadGrant.path, created.artifact.downloadPath);
  assert.match(created.uploadGrant.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(context.store.snapshot()).includes(created.uploadGrant.token), false);

  const replay = resultOf(await call(first.connection, first.transport, "publish_preview", argumentsValue));
  assert.equal(replay.created, false);
  assert.equal(replay.artifact.id, created.artifact.id);
  assert.equal(replay.preview.id, created.preview.id);
  assert.notEqual(replay.uploadGrant.token, created.uploadGrant.token);
  assert.equal(context.store.snapshot().artifacts?.length, 1);
  assert.equal(context.store.snapshot().artifactPreviews?.length, 1);
  assert.equal(context.store.read((state) => state.previewRegistrationReceipts?.length), 1);
  assert.equal(context.store.read((state) => state.artifactUploadGrants?.length), 1);

  const restarted = new Store(context.statePath);
  await restarted.load();
  const persisted = restarted.snapshot();
  assert.equal(persisted.artifacts?.[0].sourceKey, sourceKey);
  assert.equal(persisted.artifactPreviews?.[0].sourceKey, sourceKey);
  assert.equal(restarted.read((state) => state.previewRegistrationReceipts?.length), 1);
  const malformedPath = `${context.statePath}.mismatched-source`;
  const malformed = JSON.parse(await readFile(context.statePath, "utf8"));
  malformed.artifactPreviews[0].sourceKey = "orchestrator-client:another-client";
  await writeFile(malformedPath, JSON.stringify(malformed));
  await assert.rejects(new Store(malformedPath).load(), /disagrees with its artifact source/);
  assert.equal(restarted.snapshot().artifactPreviews?.[0].sourceKey, sourceKey, "a rejected persisted mismatch changes nothing");
  const foreignThreadPath = `${context.statePath}.foreign-thread-source`;
  const foreignThread = JSON.parse(await readFile(context.statePath, "utf8"));
  foreignThread.threads[0].orchestrator.clientId = "another-client";
  await writeFile(foreignThreadPath, JSON.stringify(foreignThread));
  await assert.rejects(new Store(foreignThreadPath).load(), /disagrees with its thread orchestrator/);

  const second = await welcomed(context);
  await call(second.connection, second.transport, "attach_thread", { threadId });
  const reconnect = resultOf(await call(second.connection, second.transport, "publish_preview", argumentsValue));
  assert.equal(reconnect.artifact.id, created.artifact.id);
  assert.equal(reconnect.preview.id, created.preview.id);
  assert.notEqual(reconnect.uploadGrant.token, replay.uploadGrant.token);
  assert.equal(context.store.read((state) => state.artifactUploadGrants?.length), 1);

  const beforeConflict = context.store.read((state) => JSON.stringify([
    state.artifacts, state.artifactPreviews, state.previewRegistrationReceipts, state.artifactUploadGrants, state.events
  ]));
  assert.equal(errorOf(await call(second.connection, second.transport, "publish_preview", {
    ...argumentsValue, entrypoint: "other.html"
  })).code, "conflict");
  assert.equal(context.store.read((state) => JSON.stringify([
    state.artifacts, state.artifactPreviews, state.previewRegistrationReceipts, state.artifactUploadGrants, state.events
  ])), beforeConflict);

  for (const invalid of [
    { ...argumentsValue, sourceKey },
    { ...argumentsValue, runId: "run-invented", agentId: "agent-invented" },
    { ...argumentsValue, kind: "report" },
    { ...argumentsValue, entrypoint: "../index.html" },
    { ...argumentsValue, ttlSeconds: 299 },
    { ...argumentsValue, title: "界".repeat(100), idempotencyKey: "too-wide-title" },
    { ...argumentsValue, summary: "界".repeat(667), idempotencyKey: "too-wide-summary" },
    { ...argumentsValue, idempotencyKey: "界".repeat(43) },
    { ...argumentsValue, extra: true }
  ]) {
    assert.equal(errorOf(await call(second.connection, second.transport, "publish_preview", invalid)).code, "invalid_arguments");
  }
});

test("external artifact registration re-resolves the live attachment and validates every field", async () => {
  const context = await harness();
  const first = await welcomed(context);
  const threadId = resultOf(await call(first.connection, first.transport, "create_thread", { objective: "Publish it" })).thread.id;
  const valid = {
    threadId, relativePath: "result.txt", title: "Result", kind: "report", mediaType: "text/plain",
    size: 0, sha256: "a".repeat(64), idempotencyKey: "result"
  };
  const second = await welcomed(context);
  await call(second.connection, second.transport, "attach_thread", { threadId });
  assert.equal(errorOf(await call(first.connection, first.transport, "post_artifact", valid)).code, "not_attached");
  assert.equal(context.store.snapshot().artifacts?.length, 0);

  const rejected = [
    { ...valid, kind: "preview-bundle" },
    { ...valid, relativePath: "../secret" },
    { ...valid, relativePath: "C:secret" },
    { ...valid, relativePath: "result\0.txt" },
    { ...valid, size: 10 * 1024 * 1024 + 1 },
    { ...valid, summary: "é".repeat(1_001) },
    { ...valid, sha256: "A".repeat(64) },
    { ...valid, idempotencyKey: "" },
    { ...valid, extra: true }
  ];
  for (const value of rejected) {
    assert.equal(errorOf(await call(second.connection, second.transport, "post_artifact", value)).code, "invalid_arguments");
  }
  assert.equal(context.store.snapshot().artifacts?.length, 0);
});

test("lists only this client's threads", async () => {
  const context = await harness();
  const other = await harness();
  const mine = await welcomed(context);
  const theirs = await welcomed(other);
  const created = resultOf(await call(mine.connection, mine.transport, "create_thread", { objective: "Mine" }));
  await call(theirs.connection, theirs.transport, "create_thread", { objective: "Theirs" });
  await context.store.transact((state) => { state.threads!.push(newThread("agent-one", "An agent thread", "user", at)); });

  const listed = resultOf(await call(mine.connection, mine.transport, "list_threads"));
  assert.deepEqual(listed.threads.map((thread: { id: string }) => thread.id), [created.thread.id]);
  assert.equal(errorOf(await call(mine.connection, mine.transport, "list_threads", { threadId: "thread-one" })).code, "invalid_arguments");
});

test("refuses an attach to a thread this client does not orchestrate", async () => {
  const context = await harness();
  const other = await harness();
  const mine = await welcomed(context);
  const theirs = await welcomed(other);
  const theirThread = resultOf(await call(theirs.connection, theirs.transport, "create_thread", { objective: "Theirs" })).thread.id;
  await context.store.transact((state) => { state.threads!.push(newThread("agent-one", "An agent thread", "user", at)); });
  const agentThread = context.store.read((state) => state.threads!.find((thread) => thread.ownerAgentId === "agent-one")!.id);

  // The client and the other harness share no store, so the foreign thread id simply does not
  // exist here; all three refusals must be indistinguishable.
  for (const threadId of [theirThread, agentThread, "thread-that-never-existed"]) {
    const error = errorOf(await call(mine.connection, mine.transport, "attach_thread", { threadId }));
    assert.deepEqual(error, { code: "forbidden", message: "The thread is not orchestrated by this client" }, threadId);
  }
});

test("two connections attaching the same thread leave exactly one attached, and tell the loser", async () => {
  const context = await harness();
  const first = await welcomed(context);
  const second = await welcomed(context);
  const threadId = resultOf(await call(first.connection, first.transport, "create_thread", { objective: "Ship it" })).thread.id;

  const responses = await Promise.all([
    call(first.connection, first.transport, "attach_thread", { threadId }),
    call(second.connection, second.transport, "attach_thread", { threadId })
  ]);
  for (const response of responses) assert.equal(resultOf(response).thread.id, threadId);

  const attachments = context.store.snapshot().orchestratorAttachments!;
  const live = attachments.filter((attachment) => attachment.status === "attached");
  assert.equal(live.length, 1, "exactly one connection ends attached");
  assert.equal(attachments.filter((attachment) => attachment.status === "replaced").length, 1);
  const loser = live[0].connectionId === first.connectionId ? second : first;
  const notice = loser.transport.lastOf("attachment.replaced");
  assert.ok(notice, "the replaced connection is told");
  assert.equal(notice.threadId, threadId);
});

test("external lifecycle retries converge by credential across reconnects and replaced attachments fail closed", async () => {
  const context = await harness();
  const first = await welcomed(context);
  const threadId = resultOf(await call(first.connection, first.transport, "create_thread", { objective: "Use residents" })).thread.id;
  const spawnArguments = {
    threadId,
    idempotencyKey: "spawn-external",
    purpose: { name: "Reviewer", instructions: "PRIVATE EXTERNAL INSTRUCTIONS" },
    requirements: { templateId: "template-reviewer", preferences: { models: ["default"] } },
    initialTask: { title: "Review", instructions: "Review the change" }
  };

  const created = resultOf(await call(first.connection, first.transport, "spawn_instance", spawnArguments));
  assert.equal(created.replayed, false);
  assert.equal(created.instance.delegation.canDelegate, false);
  assert.equal(created.instance.purpose.instructions, undefined);
  assert.equal(created.instance.creator, undefined);
  assert.ok(created.initialTaskId);

  const second = await welcomed(context);
  await call(second.connection, second.transport, "attach_thread", { threadId });
  const replay = resultOf(await call(second.connection, second.transport, "spawn_instance", spawnArguments));
  assert.deepEqual([replay.instance.id, replay.initialTaskId, replay.replayed], [created.instance.id, created.initialTaskId, true],
    "connection ids never create a second idempotency namespace");

  const beforeRefusal = context.store.read((state) => JSON.stringify([
    state.instances, state.tasks, state.instanceLifecycleReceipts, state.events
  ]));
  assert.equal(errorOf(await call(first.connection, first.transport, "renew_instance", {
    threadId, instanceId: created.instance.id, idempotencyKey: "replaced-renew"
  })).code, "not_attached");
  assert.equal(context.store.read((state) => JSON.stringify([
    state.instances, state.tasks, state.instanceLifecycleReceipts, state.events
  ])), beforeRefusal);

  const read = resultOf(await call(second.connection, second.transport, "get_instance", {
    threadId, instanceId: created.instance.id
  }));
  assert.equal(read.instance.id, created.instance.id);
  assert.equal(Object.hasOwn(read, "replayed"), false);
  const pinnedArguments = {
    threadId,
    idempotencyKey: "external-pin",
    tasks: [{ key: "resident", title: "Resident task", instructions: "Run exactly here", pin: { instanceId: created.instance.id } }]
  };
  const pinned = resultOf(await call(second.connection, second.transport, "submit_tasks", pinnedArguments));
  assert.deepEqual(pinned.tasks[0].placementOverride, { instanceId: created.instance.id, authorizedBy: "policy" });
  const renewed = resultOf(await call(second.connection, second.transport, "renew_instance", {
    threadId, instanceId: created.instance.id, idempotencyKey: "renew-external", idleTimeoutSeconds: 3600
  }));
  assert.deepEqual([renewed.instance.lease.idleTimeoutSeconds, renewed.replayed], [3600, false]);
  const released = resultOf(await call(second.connection, second.transport, "release_instance", {
    threadId, instanceId: created.instance.id, idempotencyKey: "release-external", mode: "cancel"
  }));
  assert.deepEqual([released.instance.status, released.replayed], ["released", false]);
  const pinnedReplay = resultOf(await call(second.connection, second.transport, "submit_tasks", pinnedArguments));
  assert.deepEqual([pinnedReplay.created, pinnedReplay.tasks[0].id], [false, pinned.tasks[0].id],
    "a previously accepted external pin replays after the resident becomes terminal");
  assert.equal(resultOf(await call(second.connection, second.transport, "get_instance", {
    threadId, instanceId: created.instance.id
  })).instance.status, "released");
});

test("external lifecycle calls reject detached, cross-thread, malformed, and authority-bearing input without writes", async () => {
  const context = await harness();
  const active = await welcomed(context);
  const firstThread = resultOf(await call(active.connection, active.transport, "create_thread", { objective: "First" })).thread.id;
  const secondThread = resultOf(await call(active.connection, active.transport, "create_thread", { objective: "Second" })).thread.id;
  await call(active.connection, active.transport, "attach_thread", { threadId: firstThread });
  const firstInstance = resultOf(await call(active.connection, active.transport, "spawn_instance", {
    threadId: firstThread, idempotencyKey: "first-instance", requirements: {}
  })).instance.id;
  assert.equal(errorOf(await call(active.connection, active.transport, "get_instance", {
    threadId: secondThread, instanceId: firstInstance
  })).code, "not_found", "a valid attachment cannot use another thread to observe an instance");
  const before = context.store.read((state) => JSON.stringify([
    state.instances, state.allocations, state.tasks, state.taskSubmissions,
    state.instanceLifecycleReceipts, state.instanceReleaseIntents, state.instanceDeliveries, state.events
  ]));

  await call(active.connection, active.transport, "detach_thread", { threadId: secondThread });
  assert.equal(errorOf(await call(active.connection, active.transport, "spawn_instance", {
    threadId: secondThread, idempotencyKey: "detached", requirements: {}
  })).code, "not_attached");
  for (const argumentsValue of [
    { threadId: firstThread, idempotencyKey: "creator", requirements: {}, creator: { kind: "operator", operatorId: "operator" } },
    { threadId: firstThread, idempotencyKey: "caller", requirements: {}, idempotency: { caller: "chosen" } },
    { threadId: firstThread, idempotencyKey: "delegate", requirements: {}, canDelegate: true },
    { threadId: firstThread, idempotencyKey: "timeout", requirements: {}, idleTimeoutSeconds: 59 }
  ]) assert.equal(errorOf(await call(active.connection, active.transport, "spawn_instance", argumentsValue)).code, "invalid_arguments");
  assert.equal(context.store.read((state) => JSON.stringify([
    state.instances, state.allocations, state.tasks, state.taskSubmissions,
    state.instanceLifecycleReceipts, state.instanceReleaseIntents, state.instanceDeliveries, state.events
  ])), before);
});

test("detaches a thread and refuses a detach this connection does not hold", async () => {
  const context = await harness();
  const { transport, connection } = await welcomed(context);
  const threadId = resultOf(await call(connection, transport, "create_thread", { objective: "Ship it" })).thread.id;

  const detached = resultOf(await call(connection, transport, "detach_thread", { threadId }));
  assert.equal(detached.threadId, threadId);
  assert.ok(detached.detachedAt);
  assert.equal(errorOf(await call(connection, transport, "detach_thread", { threadId })).code, "not_attached");
  assert.deepEqual(context.store.snapshot().orchestratorAttachments!.filter((attachment) => attachment.status === "attached"), []);
});

test("a closed socket releases the attachments it held", async () => {
  const context = await harness();
  const { transport, connection } = await welcomed(context);
  await call(connection, transport, "create_thread", { objective: "Ship it" });

  await connection.closed();

  assert.deepEqual(context.store.snapshot().orchestratorAttachments!.map((attachment) => attachment.status), ["detached"]);
  assert.equal(context.gateway.connectionCount(), 0);
});

test("a heartbeat refreshes the attachment, and silence past the expiry detaches it", async () => {
  const context = await harness();
  const { transport, connection } = await welcomed(context);
  await call(connection, transport, "create_thread", { objective: "Ship it" });
  await connection.receive(frame({ type: "client.heartbeat" }));

  const stale = new Date(Date.now() + 120_000).toISOString();
  const gateway = createOrchestratorClientGateway({ store: context.store, broadcast: () => undefined, now: () => stale, timers: context.timers });
  assert.equal(await gateway.expireAttachments(), true);
  assert.deepEqual(context.store.snapshot().orchestratorAttachments!.map((attachment) => attachment.status), ["detached"]);
  assert.equal(await gateway.expireAttachments(), false, "expiry is idempotent");
  assert.deepEqual(context.store.snapshot().runs, [], "expiry never touches runs");
});

test("revoking a credential closes its sockets and releases its attachments", async () => {
  const context = await harness();
  const { transport, connection } = await welcomed(context);
  await call(connection, transport, "create_thread", { objective: "Ship it" });

  await context.store.transact((state) => { revokeOrchestratorClient(state, context.clientId, at); });
  await context.gateway.revokeClient(context.clientId);

  assert.equal(transport.lastOf("client.revoked") !== undefined, true);
  assert.equal(transport.closedWith, "revoked");
  assert.deepEqual(context.store.snapshot().orchestratorAttachments!.map((attachment) => attachment.status), ["detached"]);
  assert.equal(context.gateway.connectionCount(), 0);
});

test("a call made after the credential is revoked is refused and closes the socket", async () => {
  const context = await harness();
  const { transport, connection } = await welcomed(context);
  await context.store.transact((state) => { revokeOrchestratorClient(state, context.clientId, at); });

  assert.equal(errorOf(await call(connection, transport, "list_threads")).code, "revoked");
  assert.equal(transport.closedWith, "revoked");
});

test("refuses a tool the credential is not scoped for", async () => {
  const context = await harness(["orchestrate"]);
  const { transport, connection } = await welcomed(context);

  assert.equal(errorOf(await call(connection, transport, "resolve_approval", { approvalId: "approval-one" })).code, "forbidden");
});

test("every declared tool is either served or refused as unavailable", async () => {
  const context = await harness(["orchestrate", "resolve-approvals"]);
  const { transport, connection } = await welcomed(context);

  for (const tool of externalOrchestratorToolNames) {
    const response = await call(connection, transport, tool, { threadId: "thread-that-never-existed" });
    if (servedExternalOrchestratorTools.includes(tool)) {
      assert.ok("error" in response || "result" in response, tool);
      continue;
    }
    const error = errorOf(response);
    assert.equal(error.code, "invalid_arguments", tool);
    assert.match(error.message, new RegExp(`${tool} is not served`));
  }
  assert.equal(transport.closedWith, undefined, "an unavailable tool never costs the connection");
});

test("an unknown tool name never reaches the dispatcher", async () => {
  const context = await harness();
  const { transport, connection } = await welcomed(context);

  await connection.receive(JSON.stringify({ type: "rpc.request", requestId: "request-unknown", tool: "drop_database", arguments: {} }));

  assert.equal(errorOf(transport.responseTo("request-unknown")).code, "invalid_arguments");
  assert.equal(transport.closedWith, undefined);
});

test("a malformed or oversized frame is refused without closing a welcomed connection", async () => {
  const context = await harness();
  const { transport, connection } = await welcomed(context);

  await connection.receive("{not json");
  await connection.receive(JSON.stringify({ type: "rpc.request", requestId: "request-bad", tool: "attach_thread" }));
  await connection.receive(JSON.stringify({ type: "rpc.request", requestId: "request-huge", tool: "attach_thread", arguments: { threadId: "x".repeat(orchestratorClientMaximumFrameBytes) } }));
  await connection.receive(JSON.stringify({ type: "rpc.request", requestId: "request-over-argument-limit", tool: "attach_thread", arguments: { threadId: "x".repeat(orchestratorClientLimits.argumentsBytes) } }));

  assert.equal(errorOf(transport.responseTo("request-bad")).code, "invalid_arguments");
  assert.equal(errorOf(transport.responseTo("request-over-argument-limit")).code, "invalid_arguments");
  assert.equal(transport.frames.some((message) => message.type === "rpc.response" && message.requestId === "request-huge"), false, "an oversized frame is dropped undecoded");
  assert.equal(transport.closedWith, undefined);
  assert.equal(context.gateway.connectionCount(), 1);
});

test("a malformed frame before the welcome closes the connection", async () => {
  const context = await harness();
  const transport = new FakeTransport();
  const connection = context.gateway.accept(transport);

  await connection.receive("{not json");

  assert.equal(transport.closedWith, "unauthorized");
});

test("bounds the calls one connection may have in flight", async () => {
  const context = await harness();
  const { transport, connection } = await welcomed(context);

  const pending = Array.from({ length: orchestratorClientMaximumInFlightRequests + 4 }, (_value, index) =>
    connection.receive(frame({ type: "rpc.request", requestId: `burst-${index}`, tool: "create_thread", arguments: { objective: `Objective ${index}` } })));
  await Promise.all(pending);

  const refused = transport.frames.filter((message) =>
    message.type === "rpc.response" && "error" in message && message.error.code === "hub_unavailable");
  assert.equal(refused.length, 4, "calls past the limit are refused rather than queued");
  assert.equal(context.store.snapshot().threads!.length, orchestratorClientMaximumInFlightRequests);
});

test("refuses a repeated requestId that is still in flight", async () => {
  const context = await harness();
  const { transport, connection } = await welcomed(context);

  await Promise.all([
    connection.receive(frame({ type: "rpc.request", requestId: "same", tool: "create_thread", arguments: { objective: "First" } })),
    connection.receive(frame({ type: "rpc.request", requestId: "same", tool: "create_thread", arguments: { objective: "Second" } }))
  ]);

  const answers = transport.frames.filter((message) => message.type === "rpc.response" && message.requestId === "same");
  assert.equal(answers.length, 2);
  assert.deepEqual(answers.filter((message) => "error" in message).map((message) => (message as { error: { code: string } }).error.code), ["conflict"]);
  assert.equal(context.store.snapshot().threads!.length, 1, "the duplicate never reaches a handler");
});
