import assert from "node:assert/strict";
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  orchestratorAttachmentStatuses,
  orchestratorClientHeartbeatExpirySeconds,
  threadOrchestrator,
  type HubToControlAgent,
  type OrchestratorAttachment
} from "@coffee-shop/protocol";
import {
  attachThreadInState,
  createExternalThreadInState,
  detachClientInState,
  detachConnectionInState,
  detachEveryAttachmentInState,
  detachThreadInState,
  expireOrchestratorAttachments,
  externalThreadViewsForClient,
  parseExternalThreadInput,
  parseThreadReference,
  recordHeartbeatInState,
  retainedEndedAttachmentsPerThread
} from "./externalOrchestrators.js";
import { runContinuationPass } from "./orchestratorInbox.js";
import type { SchedulingContext } from "./scheduler.js";
import { Store, type State } from "./store.js";
import { newThread } from "./threads.js";

const at = "2026-09-22T12:00:00.000Z";
const later = (seconds: number) => new Date(Date.parse(at) + seconds * 1000).toISOString();

async function emptyStore() {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-external-"));
  const store = new Store(join(directory, "state.json"));
  await store.load();
  return store;
}

/** Creates a thread for `client-one` from connection `connection-one` and returns both ids. */
async function threadFor(store: Store, clientId = "client-one", connectionId = "connection-one") {
  let threadId = "";
  await store.transact((state) => {
    threadId = createExternalThreadInState(state, { clientId, connectionId, objective: "Ship the auth refactor" }, at).thread.id;
  });
  return threadId;
}

const attachmentsOf = (store: Store) => store.read((state) => structuredClone(state.orchestratorAttachments ?? []));
const attachedIds = (store: Store) => attachmentsOf(store).filter((attachment) => attachment.status === "attached").map((attachment) => attachment.id);

test("creates an external thread with no owner agent and never queues a run", async () => {
  const store = await emptyStore();
  const threadId = await threadFor(store);

  const thread = store.snapshot().threads!.find((item) => item.id === threadId)!;
  assert.deepEqual(threadOrchestrator(thread), { kind: "external", clientId: "client-one" });
  assert.equal(thread.ownerAgentId, undefined, "an external thread has no owner agent");
  assert.equal(thread.createdBy, "agent");
  assert.equal(thread.title, "Ship the auth refactor");
  assert.deepEqual(store.snapshot().runs, [], "creating an external thread queues no run");
  assert.deepEqual(attachedIds(store).length, 1, "the creating connection is attached");
});

test("a scheduling continuation pass creates no run for an external thread", async () => {
  const store = await emptyStore();
  await threadFor(store);
  const delivered: HubToControlAgent[] = [];
  const context: SchedulingContext = {
    connection: () => ({ protocolVersion: "4", synced: true }),
    capabilityReport: () => undefined,
    projectProfile: () => undefined,
    canDeliver: (_nodeId, message) => { delivered.push(message); return true; }
  };
  await store.transact((state) => runContinuationPass(state, context, later(60)).changed);

  assert.deepEqual(store.snapshot().runs, []);
  assert.deepEqual(delivered, []);
});

test("refuses an attach to a thread this client does not orchestrate, without disclosing existence", async () => {
  const store = await emptyStore();
  const owned = await threadFor(store);
  await store.transact((state) => {
    state.threads!.push(newThread("agent-one", "An agent thread", "user", at));
  });
  const agentThreadId = store.read((state) => state.threads!.find((thread) => thread.ownerAgentId === "agent-one")!.id);

  const outcomes = store.read((state) => [
    attachThreadInState(structuredClone(state) as State, { threadId: agentThreadId, clientId: "client-one", connectionId: "connection-two" }, at),
    attachThreadInState(structuredClone(state) as State, { threadId: owned, clientId: "client-two", connectionId: "connection-two" }, at),
    attachThreadInState(structuredClone(state) as State, { threadId: "thread-that-never-existed", clientId: "client-one", connectionId: "connection-two" }, at)
  ]);
  assert.deepEqual(outcomes.map((outcome) => outcome.kind), ["forbidden", "forbidden", "forbidden"]);
});

test("a second connection replaces the first attachment, inside one transaction", async () => {
  const store = await emptyStore();
  const threadId = await threadFor(store);

  let replaced: OrchestratorAttachment | undefined;
  await store.transact((state) => {
    const outcome = attachThreadInState(state, { threadId, clientId: "client-one", connectionId: "connection-two" }, later(5));
    assert.equal(outcome.kind, "attached");
    if (outcome.kind === "attached") replaced = outcome.replaced;
  });

  assert.equal(replaced?.connectionId, "connection-one");
  assert.equal(replaced?.status, "replaced");
  assert.equal(replaced?.detachedAt, later(5));
  const attachments = attachmentsOf(store);
  assert.equal(attachments.filter((attachment) => attachment.status === "attached").length, 1, "exactly one attachment stays live");
  assert.equal(attachments.find((attachment) => attachment.status === "attached")!.connectionId, "connection-two");
});

test("re-attaching the same connection is idempotent and replaces nothing", async () => {
  const store = await emptyStore();
  const threadId = await threadFor(store);
  const before = attachedIds(store);

  await store.transact((state) => {
    const outcome = attachThreadInState(state, { threadId, clientId: "client-one", connectionId: "connection-one" }, later(30));
    assert.equal(outcome.kind, "attached");
    if (outcome.kind === "attached") assert.equal(outcome.replaced, undefined);
  });

  assert.deepEqual(attachedIds(store), before);
  assert.equal(attachmentsOf(store)[0].lastHeartbeatAt, later(30), "the heartbeat is refreshed");
});

test("detach releases only this connection's attachment on the named thread", async () => {
  const store = await emptyStore();
  const threadId = await threadFor(store);

  await store.transact((state) => {
    assert.equal(detachThreadInState(state, { threadId, connectionId: "connection-other" }, later(1)).kind, "not-attached");
    assert.equal(detachThreadInState(state, { threadId: "thread-none", connectionId: "connection-one" }, later(1)).kind, "not-attached");
    const outcome = detachThreadInState(state, { threadId, connectionId: "connection-one" }, later(1));
    assert.equal(outcome.kind, "detached");
    if (outcome.kind === "detached") assert.equal(outcome.attachment.detachedAt, later(1));
  });

  assert.deepEqual(attachedIds(store), []);
  assert.equal(attachmentsOf(store)[0].status, "detached");
});

test("socket close, credential revocation, and restart all detach without touching the thread", async () => {
  for (const release of [
    (state: State) => detachConnectionInState(state, "connection-one", later(2)),
    (state: State) => detachClientInState(state, "client-one", later(2)),
    (state: State) => detachEveryAttachmentInState(state, later(2))
  ]) {
    const store = await emptyStore();
    const threadId = await threadFor(store);
    const threadBefore = store.read((state) => structuredClone(state.threads!));

    await store.transact((state) => { assert.equal(release(state).length, 1); });

    assert.deepEqual(attachedIds(store), []);
    assert.deepEqual(store.read((state) => structuredClone(state.threads!)), threadBefore, "threads are untouched");
    assert.deepEqual(store.snapshot().runs, []);
    assert.deepEqual(store.snapshot().tasks, []);
    assert.equal(store.read((state) => state.orchestratorAttachments!.find((item) => item.threadId === threadId)!.status), "detached");
  }
});

test("a connection silent past the heartbeat expiry is detached, and a fresh one is not", async () => {
  const store = await emptyStore();
  await threadFor(store);

  await store.transact((state) => {
    assert.deepEqual(expireOrchestratorAttachments(state, later(orchestratorClientHeartbeatExpirySeconds - 1)), []);
    assert.equal(recordHeartbeatInState(state, "connection-one", later(30)), true);
    assert.deepEqual(expireOrchestratorAttachments(state, later(orchestratorClientHeartbeatExpirySeconds)), [], "the heartbeat moved the deadline");
    assert.equal(expireOrchestratorAttachments(state, later(30 + orchestratorClientHeartbeatExpirySeconds)).length, 1);
  });

  assert.deepEqual(attachedIds(store), []);
});

test("a heartbeat timestamp the hub cannot read counts as expired", async () => {
  const store = await emptyStore();
  await threadFor(store);

  await store.transact((state) => {
    state.orchestratorAttachments![0].lastHeartbeatAt = "not a timestamp";
    assert.equal(expireOrchestratorAttachments(state, later(1)).length, 1);
  });

  assert.deepEqual(attachedIds(store), []);
});

test("ended attachments of a thread stay bounded and keep the most recent", async () => {
  const store = await emptyStore();
  const threadId = await threadFor(store);

  await store.transact((state) => {
    for (let index = 2; index <= retainedEndedAttachmentsPerThread + 5; index += 1) {
      attachThreadInState(state, { threadId, clientId: "client-one", connectionId: `connection-${index}` }, later(index));
    }
  });

  const attachments = attachmentsOf(store);
  const ended = attachments.filter((attachment) => attachment.status !== "attached");
  assert.equal(ended.length, retainedEndedAttachmentsPerThread);
  assert.equal(ended.at(-1)!.connectionId, `connection-${retainedEndedAttachmentsPerThread + 4}`, "the newest ended attachment is kept");
  assert.equal(attachments.filter((attachment) => attachment.status === "attached").length, 1);
});

test("every attachment status is one the protocol declares", async () => {
  const store = await emptyStore();
  const threadId = await threadFor(store);
  await store.transact((state) => {
    attachThreadInState(state, { threadId, clientId: "client-one", connectionId: "connection-two" }, later(1));
    detachThreadInState(state, { threadId, connectionId: "connection-two" }, later(2));
  });

  const statuses = new Set(attachmentsOf(store).map((attachment) => attachment.status));
  assert.deepEqual([...statuses].sort(), ["detached", "replaced"]);
  for (const status of statuses) assert.ok(orchestratorAttachmentStatuses.includes(status), status);
});

test("lists only the threads this client orchestrates, with attachment and unread counts", async () => {
  const store = await emptyStore();
  const mine = await threadFor(store);
  await threadFor(store, "client-two", "connection-nine");
  await store.transact((state) => {
    state.threads!.push(newThread("agent-one", "An agent thread", "user", at));
  });

  const views = store.read((state) => structuredClone(externalThreadViewsForClient(state, "client-one")));
  assert.deepEqual(views.map((view) => view.id), [mine]);
  assert.equal(views[0].attachment?.connectionId, "connection-one");
  assert.equal(views[0].attachment?.status, "attached");
  assert.equal(views[0].unreadEvents, 0);

  await store.transact((state) => { detachConnectionInState(state, "connection-one", later(3)); });
  assert.equal(store.read((state) => externalThreadViewsForClient(state, "client-one")[0].attachment), null);
});

test("refuses create_thread and thread-reference arguments the hub cannot interpret", () => {
  for (const value of [undefined, null, "objective", [], { objective: "" }, { objective: 7 }, { objective: "x".repeat(8_001) }, { objective: "Ship it", extra: 1 }, { title: "T" }]) {
    assert.equal(parseExternalThreadInput(value).ok, false, JSON.stringify(value ?? null));
  }
  const accepted = parseExternalThreadInput({ title: "  Refactor  ", objective: " Ship it " });
  assert.deepEqual(accepted, { ok: true, value: { title: "Refactor", objective: "Ship it" } });

  for (const value of [undefined, {}, { threadId: "" }, { threadId: 7 }, { threadId: "t", extra: 1 }]) {
    assert.equal(parseThreadReference(value).ok, false, JSON.stringify(value ?? null));
  }
  assert.deepEqual(parseThreadReference({ threadId: "thread-one" }), { ok: true, value: "thread-one" });
});

/**
 * Hub startup, as `apps/hub/src/index.ts` performs it, against the snapshot a live connection
 * actually wrote (`apps/hub/test-fixtures/state-with-external-orchestrator-attachment.json`).
 */
test("a restarted hub detaches every persisted attachment and keeps the thread", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-restart-"));
  const path = join(directory, "state.json");
  await copyFile(fileURLToPath(new URL("../test-fixtures/state-with-external-orchestrator-attachment.json", import.meta.url)), path);
  const store = new Store(path);
  await store.load();
  const threadsBefore = store.read((state) => structuredClone(state.threads!));

  await store.transact((state) => detachEveryAttachmentInState(state, later(120)).length > 0);

  const attachments = store.snapshot().orchestratorAttachments!;
  assert.deepEqual(attachments.map((attachment) => attachment.status), ["detached"]);
  assert.equal(attachments[0].detachedAt, later(120));
  assert.deepEqual(store.read((state) => structuredClone(state.threads!)), threadsBefore, "threads survive the restart");
  assert.deepEqual(store.snapshot().runs, []);

  // Reloading the reconciled snapshot is a supported restart, not a load the hub refuses.
  const again = new Store(path);
  await again.load();
  assert.deepEqual(again.snapshot().orchestratorAttachments!.map((attachment) => attachment.status), ["detached"]);
});
