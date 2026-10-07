import assert from "node:assert/strict";
import test from "node:test";
import { hostHarnessSessionLimits, validateHostHarnessSession, type HostSessionControlMessage } from "@coffee-shop/protocol";
import {
  applyHostSessionGeneration,
  applyHostSessionUpdate,
  enforceGlobalHostSessionRetention,
  enforceNodeHostSessionRetention,
  hostSessionOutcomeChangesClientSnapshot,
  hostSessionOutcomeRequiresResync,
  hostSessionUpdatesPerConnection,
  HostSessionInventoryAuthority,
  projectNodeHostSessionsOffline,
  type HostSessionInventoryOutcome
} from "./hostSessionInventory.js";
import { hostSessionInventoryStorageLimits, Store, type State } from "./store.js";
import {
  hostSessionTestComplete as complete,
  hostSessionTestFixture as fixture,
  hostSessionTestNode,
  hostSessionTestObservation as observation,
  hostSessionTestPage as page
} from "./hostSessionTestSupport.js";

test("only inventory mutations require a client snapshot broadcast", () => {
  assert.equal(hostSessionOutcomeChangesClientSnapshot(page(), { kind: "accepted", changed: true }), true);
  assert.equal(hostSessionOutcomeChangesClientSnapshot({
    type: "host-session.history.page", nodeId: "node-one", hostHarnessSessionId: "host-session-one",
    requestId: "history-request", items: [], truncated: false, at: "2026-10-06T12:00:00Z"
  }, { kind: "accepted", changed: true }), false);
  assert.equal(hostSessionOutcomeRequiresResync(page(), {
    kind: "rejected", changed: false, reason: "inventory diverged"
  }), true);
  assert.equal(hostSessionOutcomeRequiresResync(page(), {
    kind: "capacity", changed: false, reason: "fleet is full"
  }), false, "a deterministic capacity refusal must leave the control connection open");
  assert.equal(hostSessionOutcomeRequiresResync({
    type: "host-session.history.page", nodeId: "node-one", hostHarnessSessionId: "host-session-one",
    requestId: "history-request", items: [], truncated: false, at: "2026-10-06T12:00:00Z"
  }, { kind: "rejected", changed: false, reason: "invalid provider page" }), false);
});

test("only one complete valid generation replaces node authority and exact replay writes nothing", async () => {
  const { store, authority, connection } = await fixture();
  let commits = 0;
  store.onCommit(() => { commits += 1; });
  assert.equal((await authority.receive(connection, page())).kind, "staged");
  assert.deepEqual(store.snapshot().hostHarnessSessions, [], "an incomplete generation is not authority");
  assert.equal(commits, 0);

  const accepted = await authority.receive(connection, complete());
  assert.equal(accepted.kind, "accepted");
  assert.equal(accepted.changed, true);
  assert.equal(store.snapshot().hostHarnessSessions?.[0]?.hostHarnessSessionId, "host-session-one");
  assert.equal(store.snapshot().hostHarnessSessions?.[0]?.attachmentEpoch, 0);
  assert.equal(store.snapshot().hostSessionInventoryRevision, 1);
  assert.equal(commits, 1);

  assert.equal((await authority.receive(connection, page())).kind, "staged");
  assert.equal((await authority.receive(connection, complete())).kind, "replayed");
  assert.equal(store.snapshot().hostSessionInventoryRevision, 1);
  assert.equal(commits, 1, "an exact complete-generation replay writes and broadcasts nothing");
});

test("committing one generation does not discard a newer generation staged during persistence", async () => {
  const { store, authority, connection } = await fixture();
  const originalTransact = store.transact.bind(store);
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const transactionEntered = new Promise<void>((resolve) => { entered = resolve; });
  store.transact = async (change) => {
    entered();
    await blocked;
    return originalTransact(change);
  };

  assert.equal((await authority.receive(connection, page(1))).kind, "staged");
  const firstCommit = authority.receive(connection, complete(1));
  await transactionEntered;
  assert.equal((await authority.receive(connection, page(2))).kind, "staged");
  release();
  assert.equal((await firstCommit).kind, "accepted");
  assert.equal((await authority.receive(connection, complete(2))).kind, "accepted");
  assert.equal(store.read((state) => state.hostSessionInventoryGenerations?.[0]?.generation), 2);
});

test("a complete zero-page generation commits empty authority without a synthetic page", async () => {
  const { store, authority, connection } = await fixture();
  const empty = { ...complete(), pageCount: 0, sessionCount: 0 };

  const accepted = await authority.receive(connection, empty);
  assert.equal(accepted.kind, "accepted");
  assert.deepEqual(store.snapshot().hostHarnessSessions, []);
  assert.equal(store.read((state) => state.hostSessionInventoryGenerations?.[0]?.generation), 1);

  assert.equal((await authority.receive(connection, empty)).kind, "replayed");
  const incomplete = { ...complete(2), pageCount: 1, sessionCount: 0 };
  assert.equal((await authority.receive(connection, incomplete)).kind, "rejected");
});

test("nonconsecutive generations, changed page replay, incomplete disconnect, and stale sockets retain prior authority", async () => {
  const { store, authority, connection, setCurrent } = await fixture();
  await authority.receive(connection, page());
  await authority.receive(connection, complete());
  const before = JSON.stringify(store.snapshot().hostHarnessSessions);

  assert.equal((await authority.receive(connection, page(3))).kind, "staged", "timestamp-based generations need only increase");
  const changed = page(3, [observation({ summary: "changed replay" })]);
  assert.equal((await authority.receive(connection, changed)).kind, "rejected");
  assert.equal(JSON.stringify(store.snapshot().hostHarnessSessions), before);

  await authority.receive(connection, page(3));
  authority.discard(connection);
  assert.equal(JSON.stringify(store.snapshot().hostHarnessSessions), before, "disconnect never marks sessions offline");

  setCurrent(false);
  assert.equal((await authority.receive(connection, page(3))).kind, "ignored");
  assert.equal(JSON.stringify(store.snapshot().hostHarnessSessions), before);
});

test("a reconnect tolerates clock rollback and carries offline projections across repeated omissions", async () => {
  const { store, authority, connection } = await fixture();
  await authority.receive(connection, page(1_700_000_000_000));
  assert.equal((await authority.receive(connection, complete(1_700_000_000_000))).kind, "accepted");

  const restarted = { ...connection, generation: connection.generation + 1 };
  const empty = { ...complete(1_600_000_000_000), pageCount: 0, sessionCount: 0 };
  assert.equal((await authority.receive(restarted, empty)).kind, "accepted");
  let session = store.snapshot().hostHarnessSessions?.[0];
  assert.equal(session?.status, "offline");
  assert.equal(session?.revision, 1, "Hub absence projections do not mint Barista revisions");
  assert.equal(session?.updatedAt, "2026-10-06T10:00:00Z");

  const stillEmpty = { ...complete(1_600_000_000_001), pageCount: 0, sessionCount: 0 };
  assert.equal((await authority.receive(restarted, stillEmpty)).kind, "accepted");
  assert.equal(store.read((state) => state.hostSessionInventoryGenerations?.[0]?.offlineProjections?.length), 1);

  await authority.receive(restarted, page(1_600_000_000_002, [observation({ summary: "conflicting same revision" })]));
  assert.equal((await authority.receive(restarted, complete(1_600_000_000_002))).kind, "rejected");

  await authority.receive(restarted, page(1_600_000_000_003));
  assert.equal((await authority.receive(restarted, complete(1_600_000_000_003))).kind, "accepted");
  session = store.snapshot().hostHarnessSessions?.[0];
  assert.equal(session?.status, "idle");
  assert.equal(session?.revision, 1);
  assert.equal(session?.updatedAt, "2026-10-06T10:00:00Z");
});

test("disconnect projects nonterminal sessions offline and a fresh generation restores them", async () => {
  const { store, authority, connection } = await fixture();
  const running = observation({
    status: "running", providerTurnId: "disconnect-turn", updatedAt: "2026-10-06T12:00:00Z"
  });
  const closed = observation({
    hostHarnessSessionId: "disconnect-closed", providerSessionId: "disconnect-closed-provider",
    status: "closed", controlMode: "observe", operations: [], updatedAt: "2026-10-06T12:00:00Z"
  });
  await authority.receive(connection, page(1, [running, closed]));
  assert.equal((await authority.receive(connection, complete(1, 2))).kind, "accepted");
  const beforeRevision = store.read((state) => state.hostSessionInventoryRevision!);
  await store.transact((state) => projectNodeHostSessionsOffline(state, "node-one"));
  let projected = store.snapshot().hostHarnessSessions!;
  assert.equal(projected.find((session) => session.hostHarnessSessionId === running.hostHarnessSessionId)?.status, "offline");
  assert.equal(projected.find((session) => session.hostHarnessSessionId === closed.hostHarnessSessionId)?.status, "closed");
  assert.equal(store.read((state) => state.hostSessionInventoryRevision), beforeRevision + 1);
  assert.deepEqual(store.read((state) => state.hostSessionInventoryGenerations?.[0]?.offlineProjections
    ?.map((projection) => projection.hostHarnessSessionId)), [running.hostHarnessSessionId]);
  await store.transact((state) => projectNodeHostSessionsOffline(state, "node-one"));
  assert.equal(store.read((state) => state.hostSessionInventoryRevision), beforeRevision + 1,
    "an already-offline node does not create another projection revision");

  const replacement = { ...connection, generation: connection.generation + 1 };
  await authority.receive(replacement, page(2, [running, closed]));
  assert.equal((await authority.receive(replacement, complete(2, 2))).kind, "accepted");
  projected = store.snapshot().hostHarnessSessions!;
  assert.equal(projected.find((session) => session.hostHarnessSessionId === running.hostHarnessSessionId)?.status, "running");
  assert.equal(store.read((state) => state.hostSessionInventoryGenerations?.[0]?.offlineProjections), undefined);
});

test("omitted terminal sessions remain terminal and persist without an offline projection", async () => {
  const { store, authority, connection, path } = await fixture();
  await authority.receive(connection, page());
  await authority.receive(connection, complete());
  const closed: HostSessionControlMessage = {
    type: "host-session.update", nodeId: "node-one",
    session: observation({ status: "closed", revision: 2, operations: [], updatedAt: "2026-10-06T12:10:00Z" }),
    at: "2026-10-06T12:10:00Z"
  };
  assert.equal((await authority.receive(connection, closed)).kind, "accepted");
  const empty = { ...complete(2), pageCount: 0, sessionCount: 0 };
  assert.equal((await authority.receive(connection, empty)).kind, "accepted");
  assert.equal(store.snapshot().hostHarnessSessions?.[0]?.status, "closed");
  assert.equal(store.read((state) => state.hostSessionInventoryGenerations?.[0]?.offlineProjections), undefined);
  await new Store(path).load();
});

test("an offline projection never moves updatedAt backward when Barista's clock rolls back", async () => {
  const { store, authority, connection, path } = await fixture();
  await authority.receive(connection, page());
  await authority.receive(connection, complete());
  const rolledBack = {
    ...complete(2), pageCount: 0, sessionCount: 0, at: "2020-01-01T00:00:00Z"
  };
  assert.equal((await authority.receive(connection, rolledBack)).kind, "accepted");
  const session = store.snapshot().hostHarnessSessions?.[0];
  assert.equal(session?.status, "offline");
  assert.equal(session?.updatedAt, "2026-10-06T10:00:00Z");
  await new Store(path).load();
});

test("a node cannot reuse another node's global host-session identity", async () => {
  const { store, authority, connection } = await fixture();
  await authority.receive(connection, page());
  await authority.receive(connection, complete());
  await store.transact((state) => {
    state.nodes.push({ ...hostSessionTestNode, id: "node-two", name: "Node two" });
  });
  const otherConnection = { supportsCapability: true, isCurrent: () => true, nodeId: "node-two", generation: 1 };
  const collision = {
    ...page(10, [observation({ nodeId: "node-two" })]),
    nodeId: "node-two"
  };
  assert.equal((await authority.receive(otherConnection, collision)).kind, "staged");
  assert.equal((await authority.receive(otherConnection, { ...complete(10), nodeId: "node-two" })).kind, "rejected");
  assert.equal(store.snapshot().hostHarnessSessions?.length, 1);
});

test("a rediscovered provider identity replaces an omitted unattached session with a fresh id", async () => {
  const { store, authority, connection } = await fixture();
  await authority.receive(connection, page());
  await authority.receive(connection, complete());
  const rediscovered = observation({
    hostHarnessSessionId: "host-session-rediscovered", createdAt: "2026-10-06T12:20:00Z",
    updatedAt: "2026-10-06T12:20:00Z"
  });
  await authority.receive(connection, page(2, [rediscovered]));
  assert.equal((await authority.receive(connection, complete(2))).kind, "accepted");
  assert.deepEqual(store.snapshot().hostHarnessSessions?.map((session) => session.hostHarnessSessionId),
    ["host-session-rediscovered"]);
});

test("later complete generation updates legal observations and marks missing sessions offline atomically", async () => {
  const { store, authority, connection } = await fixture();
  const second = observation({
    hostHarnessSessionId: "host-session-two", providerSessionId: "provider-thread-two",
    createdAt: "2026-10-06T10:01:00Z", updatedAt: "2026-10-06T10:01:00Z"
  });
  await authority.receive(connection, page(1, [observation(), second]));
  await authority.receive(connection, complete(1, 2));

  const updated = observation({ status: "running", revision: 2, providerTurnId: "turn-one", updatedAt: "2026-10-06T12:05:00Z" });
  await authority.receive(connection, page(2, [updated]));
  assert.equal((await authority.receive(connection, complete(2, 1))).kind, "accepted");
  const sessions = store.snapshot().hostHarnessSessions!;
  assert.equal(sessions.find((session) => session.hostHarnessSessionId === "host-session-one")?.status, "running");
  assert.equal(sessions.find((session) => session.hostHarnessSessionId === "host-session-two")?.status, "offline");
});

test("session updates enforce current socket, identity, sequence, and legal transitions", async () => {
  const { store, authority, connection } = await fixture();
  await authority.receive(connection, page());
  await authority.receive(connection, complete());
  let commits = 0;
  store.onCommit(() => { commits += 1; });

  const update: HostSessionControlMessage = {
    type: "host-session.update", nodeId: "node-one",
    session: observation({ status: "running", revision: 2, providerTurnId: "turn-one", updatedAt: "2026-10-06T12:10:00Z" }),
    at: "2026-10-06T12:10:00Z"
  };
  assert.equal((await authority.receive(connection, update)).kind, "accepted");
  assert.equal(commits, 1);
  assert.equal((await authority.receive(connection, update)).kind, "replayed");
  assert.equal(commits, 1);

  const conflict = structuredClone(update);
  if (conflict.type !== "host-session.update") throw new Error("fixture type changed");
  conflict.session.summary = "conflicting replay";
  assert.equal((await authority.receive(connection, conflict)).kind, "rejected");
  const gap = structuredClone(update);
  if (gap.type !== "host-session.update") throw new Error("fixture type changed");
  gap.session.revision = 4;
  gap.session.status = "idle";
  assert.equal((await authority.receive(connection, gap)).kind, "rejected");
  assert.equal(store.snapshot().hostHarnessSessions?.[0]?.status, "running");

  const immutableMismatch = structuredClone(update);
  if (immutableMismatch.type !== "host-session.update") throw new Error("fixture type changed");
  immutableMismatch.session.providerSessionId = "provider-other";
  immutableMismatch.session.revision = 3;
  immutableMismatch.session.status = "idle";
  assert.equal((await authority.receive(connection, immutableMismatch)).kind, "rejected");
  const illegal = structuredClone(update);
  if (illegal.type !== "host-session.update") throw new Error("fixture type changed");
  illegal.session.revision = 3;
  illegal.session.status = "closed";
  illegal.session.updatedAt = "2026-10-06T12:11:00Z";
  assert.equal((await authority.receive(connection, illegal)).kind, "accepted");
  const terminalEscape = structuredClone(illegal);
  if (terminalEscape.type !== "host-session.update") throw new Error("fixture type changed");
  terminalEscape.session.revision = 4;
  terminalEscape.session.status = "idle";
  terminalEscape.session.updatedAt = "2026-10-06T12:12:00Z";
  assert.equal((await authority.receive(connection, terminalEscape)).kind, "rejected");
  const unknown = structuredClone(update);
  if (unknown.type !== "host-session.update") throw new Error("fixture type changed");
  unknown.session.hostHarnessSessionId = "host-session-unknown";
  assert.equal((await authority.receive(connection, unknown)).kind, "rejected");
});

test("a burst of session updates is persisted in one bounded batch", async () => {
  const { store, connection } = await fixture();
  let batchBroadcasts = 0;
  const authority = new HostSessionInventoryAuthority(store, {
    onUpdateBatchCommitted: () => { batchBroadcasts += 1; }
  });
  await authority.receive(connection, page());
  await authority.receive(connection, complete());
  let commits = 0;
  store.onCommit(() => { commits += 1; });

  const update = (
    revision: number,
    status: "idle" | "running",
    updatedAt: string
  ): Extract<HostSessionControlMessage, { type: "host-session.update" }> => ({
    type: "host-session.update",
    nodeId: "node-one",
    session: observation({
      revision,
      status,
      ...(status === "running" ? { providerTurnId: `turn-${revision}` } : {}),
      updatedAt
    }),
    at: updatedAt
  });
  const settlements = [
    update(2, "running", "2026-10-06T12:02:00Z"),
    update(3, "idle", "2026-10-06T12:03:00Z"),
    update(4, "running", "2026-10-06T12:04:00Z")
  ].map((message) => new Promise<HostSessionInventoryOutcome>((resolve, reject) => {
    const immediate = authority.deferUpdate(connection, message, resolve, reject);
    assert.equal(immediate.kind, "staged", "the socket handler must not wait for the persistence batch");
  }));
  const outcomes = await Promise.all(settlements);

  assert.deepEqual(outcomes.map((outcome) => outcome.kind), ["accepted", "accepted", "accepted"]);
  assert.equal(commits, 1, "one burst must cause one durable state write");
  assert.equal(batchBroadcasts, 1, "one durable update batch must cause one client broadcast");
  assert.equal(store.snapshot().hostHarnessSessions?.[0]?.revision, 4);
  assert.equal(store.snapshot().hostSessionInventoryRevision, 2,
    "one durable update batch advances the public inventory revision once");
});

test("a new inventory generation drains earlier deferred updates from the same connection", async () => {
  const { authority, connection } = await fixture();
  await authority.receive(connection, page());
  await authority.receive(connection, complete());
  const updated = observation({
    status: "running",
    revision: 2,
    providerTurnId: "turn-before-generation",
    updatedAt: "2026-10-06T12:02:00Z"
  });
  const settlement = new Promise<HostSessionInventoryOutcome>((resolve, reject) => {
    const immediate = authority.deferUpdate(connection, {
      type: "host-session.update",
      nodeId: "node-one",
      session: updated,
      at: updated.updatedAt
    }, resolve, reject);
    assert.equal(immediate.kind, "staged");
  });

  assert.equal((await authority.receive(connection, page(2, [updated]))).kind, "staged");
  assert.equal((await settlement).kind, "accepted",
    "the preceding delta must settle before the generation page is staged");
  assert.equal((await authority.receive(connection, complete(2))).kind, "accepted");
});

test("capacity-deferred nodes keep their control socket and updates remain nonfatal until a generation fits", async () => {
  const { store } = await fixture();
  const resyncs: string[] = [];
  const authority = new HostSessionInventoryAuthority(store, {
    onDeferredCapacityMayFit: (nodeId) => { resyncs.push(nodeId); }
  });
  const nodeIds = ["node-one", "node-two", "node-three", "node-four"];
  await store.transact((state) => {
    state.nodes.push(
      { ...hostSessionTestNode, id: "node-two", name: "Node two" },
      { ...hostSessionTestNode, id: "node-three", name: "Node three" },
      { ...hostSessionTestNode, id: "node-four", name: "Node four" },
      { ...hostSessionTestNode, id: "node-five", name: "Node five" }
    );
    state.hostHarnessSessions = nodeIds.flatMap((nodeId) =>
      Array.from({ length: hostHarnessSessionLimits.sessionsPerGeneration }, (_, index) => ({
        ...observation({
          hostHarnessSessionId: `${nodeId}-capacity-${index}`,
          nodeId,
          providerSessionId: `${nodeId}-provider-${index}`,
          status: "running",
          providerTurnId: `${nodeId}-turn-${index}`
        }),
        attachmentEpoch: 0
      }))
    ).sort((left, right) => left.hostHarnessSessionId.localeCompare(right.hostHarnessSessionId));
    state.hostSessionInventoryRecords = state.hostHarnessSessions.length;
    state.hostSessionInventoryBytes = Buffer.byteLength(JSON.stringify(state.hostHarnessSessions), "utf8");
  });
  const connection = {
    supportsCapability: true,
    isCurrent: () => true,
    nodeId: "node-five",
    generation: 1
  };
  const deferredObservation = observation({
    hostHarnessSessionId: "node-five-deferred",
    nodeId: "node-five",
    providerSessionId: "node-five-deferred-provider"
  });
  const deferredPage = { ...page(1, [deferredObservation]), nodeId: "node-five" };
  const deferredComplete = { ...complete(1), nodeId: "node-five" };

  assert.equal((await authority.receive(connection, deferredPage)).kind, "staged");
  const capacity = await authority.receive(connection, deferredComplete);
  assert.equal(capacity.kind, "capacity");
  assert.equal(hostSessionOutcomeRequiresResync(deferredComplete, capacity), false);
  assert.equal(authority.isCapacityDeferred("node-five"), true);

  const deferredUpdate: Extract<HostSessionControlMessage, { type: "host-session.update" }> = {
    type: "host-session.update",
    nodeId: "node-five",
    session: { ...deferredObservation, revision: 2, status: "running", providerTurnId: "deferred-turn" },
    at: "2026-10-06T12:02:00Z"
  };
  assert.equal((await authority.receive(connection, deferredUpdate)).kind, "capacity",
    "an update for an uncommitted deferred generation must not force a reconnect");
  assert.equal((await authority.receive(connection, {
    ...deferredUpdate,
    session: observation({
      hostHarnessSessionId: "node-five-deferred",
      nodeId: "node-five",
      providerSessionId: "node-five-deferred-provider",
      revision: 3,
      status: "idle",
      updatedAt: "2026-10-06T12:03:00Z"
    }),
    at: "2026-10-06T12:03:00Z"
  })).kind, "capacity", "later revisions remain deferred instead of forcing a reconnect");

  const nodeOneConnection = {
    supportsCapability: true,
    isCurrent: () => true,
    nodeId: "node-one",
    generation: 1
  };
  assert.equal((await authority.receive(nodeOneConnection, {
    type: "host-session.update",
    nodeId: "node-one",
    session: observation({
      hostHarnessSessionId: "node-one-capacity-0",
      providerSessionId: "node-one-provider-0",
      status: "idle",
      revision: 2,
      updatedAt: "2026-10-06T12:03:00Z"
    }),
    at: "2026-10-06T12:03:00Z"
  })).kind, "accepted");
  assert.deepEqual(resyncs, [], "a smaller record is not enough when one whole record must be freed");
  assert.equal((await authority.receive(nodeOneConnection, {
    type: "host-session.update",
    nodeId: "node-one",
    session: observation({
      hostHarnessSessionId: "node-one-capacity-0",
      providerSessionId: "node-one-provider-0",
      status: "running",
      providerTurnId: "node-one-turn-again",
      revision: 3,
      updatedAt: "2026-10-06T12:04:00Z"
    }),
    at: "2026-10-06T12:04:00Z"
  })).kind, "accepted");
  assert.deepEqual(resyncs, [], "routine status churn does not reconnect a deferred node");
  assert.equal((await authority.receive(nodeOneConnection, {
    type: "host-session.update",
    nodeId: "node-one",
    session: observation({
      hostHarnessSessionId: "node-one-capacity-0",
      providerSessionId: "node-one-provider-0",
      status: "closed",
      controlMode: "observe",
      operations: [],
      revision: 4,
      updatedAt: "2026-10-06T12:05:00Z"
    }),
    at: "2026-10-06T12:05:00Z"
  })).kind, "accepted");
  assert.deepEqual(resyncs, ["node-five"],
    "a newly evictable record prompts one deferred node resync without a capacity reconnect loop");
  const acceptedPage = { ...deferredPage, generation: 2 };
  const acceptedComplete = { ...deferredComplete, generation: 2 };
  assert.equal((await authority.receive(connection, acceptedPage)).kind, "staged");
  assert.equal((await authority.receive(connection, acceptedComplete)).kind, "accepted");
  assert.equal(authority.isCapacityDeferred("node-five"), false);
});

test("the nonblocking update queue is bounded per connection", async () => {
  const { store, connection } = await fixture();
  const authority = new HostSessionInventoryAuthority(store);
  await authority.receive(connection, page());
  await authority.receive(connection, complete());
  const update: Extract<HostSessionControlMessage, { type: "host-session.update" }> = {
    type: "host-session.update",
    nodeId: "node-one",
    session: observation({
      status: "running",
      revision: 2,
      providerTurnId: "bounded-turn",
      updatedAt: "2026-10-06T12:02:00Z"
    }),
    at: "2026-10-06T12:02:00Z"
  };
  const settlements: Array<Promise<HostSessionInventoryOutcome>> = [];
  for (let index = 0; index < hostSessionUpdatesPerConnection; index += 1) {
    settlements.push(new Promise((resolve, reject) => {
      assert.equal(authority.deferUpdate(connection, update, resolve, reject).kind, "staged");
    }));
  }
  const overflow = authority.deferUpdate(connection, update, () => undefined, () => undefined);
  assert.equal(overflow.kind, "rejected");
  assert.match(overflow.kind === "rejected" ? overflow.reason : "", /queue capacity/);
  await Promise.all(settlements);
});

test("updates buffered behind a newer reconnect generation are older or exact replays", async () => {
  const { store, authority, connection } = await fixture();
  const latest = observation({
    status: "idle", revision: 3, updatedAt: "2026-10-06T12:03:00Z"
  });
  await authority.receive(connection, page(3, [latest]));
  assert.equal((await authority.receive(connection, complete(3))).kind, "accepted");
  const buffered = {
    type: "host-session.update", nodeId: "node-one",
    session: observation({
      status: "running", revision: 2, providerTurnId: "buffered-turn", updatedAt: "2026-10-06T12:02:00Z"
    }),
    at: "2026-10-06T12:02:00Z"
  } satisfies Extract<HostSessionControlMessage, { type: "host-session.update" }>;
  assert.equal((await authority.receive(connection, buffered)).kind, "older");
  assert.equal((await authority.receive(connection, {
    type: "host-session.update", nodeId: "node-one", session: latest, at: "2026-10-06T12:03:00Z"
  })).kind, "replayed");
  assert.equal(store.snapshot().hostHarnessSessions?.[0]?.revision, 3);
});

test("an in-capacity update uses cached byte extent without walking the whole inventory", async () => {
  const { store } = await fixture();
  const state = store.read((current) => structuredClone(current) as State);
  state.hostHarnessSessions = Array.from({ length: 1_000 }, (_, index) => ({
    ...observation({
      hostHarnessSessionId: `cached-session-${index.toString().padStart(4, "0")}`,
      providerSessionId: `cached-provider-${index.toString().padStart(4, "0")}`
    }),
    attachmentEpoch: 0
  }));
  state.hostSessionInventoryRecords = state.hostHarnessSessions.length;
  state.hostSessionInventoryBytes = Buffer.byteLength(JSON.stringify(state.hostHarnessSessions), "utf8");
  let indexedReads = 0;
  state.hostHarnessSessions = new Proxy(state.hostHarnessSessions, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) indexedReads += 1;
      return Reflect.get(target, property, receiver);
    }
  });
  const current = state.hostHarnessSessions[0]!;
  const { attachmentEpoch: _attachmentEpoch, ...currentObservation } = current;
  assert.equal(applyHostSessionUpdate(state, {
    type: "host-session.update", nodeId: "node-one",
    session: {
      ...currentObservation, status: "running", revision: 2, providerTurnId: "cached-turn",
      updatedAt: "2026-10-06T12:05:00Z"
    },
    at: "2026-10-06T12:05:00Z"
  }).kind, "accepted");
  assert.ok(indexedReads < 10, `cached update traversed ${indexedReads} inventory entries`);
});

test("staging is connection-scoped, restart-ephemeral, ordered, and mixed-node input is rejected", async () => {
  const { store, authority, connection, setCurrent } = await fixture();
  assert.equal((await authority.receive(connection, page())).kind, "staged");
  const afterRestart = new HostSessionInventoryAuthority(store);
  assert.equal((await afterRestart.receive(connection, complete())).kind, "rejected");
  assert.deepEqual(store.snapshot().hostHarnessSessions, []);

  authority.discard(connection);
  const outOfOrder = { ...page(), pageIndex: 1 };
  assert.equal((await authority.receive(connection, outOfOrder)).kind, "rejected");
  const mixedNode = structuredClone(page());
  mixedNode.sessions[0]!.nodeId = "node-other";
  assert.equal((await authority.receive(connection, mixedNode)).kind, "rejected");

  setCurrent(false);
  const replacement = { supportsCapability: true, isCurrent: () => true, nodeId: "node-one", generation: 2 };
  assert.equal((await authority.receive(connection, page())).kind, "ignored");
  assert.equal((await authority.receive(replacement, page())).kind, "staged");
  assert.equal((await authority.receive(replacement, complete())).kind, "accepted");
});

test("generation identity conflicts and protected-capacity exhaustion reject atomically", async () => {
  const { store, authority, connection } = await fixture();
  await authority.receive(connection, page());
  await authority.receive(connection, complete());
  const before = JSON.stringify(store.snapshot().hostHarnessSessions);

  const conflictingIdentity = observation({ providerSessionId: "provider-changed", revision: 2, status: "running", updatedAt: "2026-10-06T12:10:00Z" });
  await authority.receive(connection, page(2, [conflictingIdentity]));
  assert.equal((await authority.receive(connection, complete(2))).kind, "rejected");
  assert.equal(JSON.stringify(store.snapshot().hostHarnessSessions), before);

  const state = store.read((current) => structuredClone(current) as State);
  state.hostHarnessSessions = Array.from({ length: hostHarnessSessionLimits.sessionsPerGeneration }, (_, index) => ({
    ...observation({
      hostHarnessSessionId: `host-protected-${index}`, providerSessionId: `provider-protected-${index}`,
      status: "running", revision: 1, providerTurnId: `turn-${index}`,
      createdAt: "2026-10-06T10:00:00Z", updatedAt: "2026-10-06T10:00:00Z"
    }),
    attachedThreadId: `thread-${index}`, attachmentEpoch: 1
  }));
  state.hostSessionInventoryGenerations = [{
    nodeId: "node-one", generation: 1, digest: "0".repeat(64), completedAt: "2026-10-06T12:00:00Z"
  }];
  const nextPage = page(2, [observation({ hostHarnessSessionId: "host-new", providerSessionId: "provider-new" })]);
  const capacity = applyHostSessionGeneration(state, [nextPage], complete(2));
  assert.equal(capacity.kind, "capacity");
  assert.match(capacity.kind === "capacity" ? capacity.reason : "", /capacity/);
});

test("maximum-count generations and globally maximal valid records fit the inventory byte budget", async () => {
  const { store } = await fixture();
  const state = store.read((current) => structuredClone(current) as State);
  const workspace = `/${"\"".repeat(hostHarnessSessionLimits.workspaceBytes - 1)}`;
  const summary = "\"".repeat(hostHarnessSessionLimits.diagnosticBytes);
  const sessions = Array.from({ length: hostHarnessSessionLimits.sessionsPerGeneration }, (_, index) => observation({
    hostHarnessSessionId: `max-session-${index.toString().padStart(4, "0")}`,
    providerSessionId: `max-provider-${index.toString().padStart(4, "0")}`,
    workspace,
    summary
  }));
  const pages = Array.from({ length: hostHarnessSessionLimits.pagesPerGeneration }, (_, pageIndex) => ({
    ...page(11, sessions.slice(
      pageIndex * hostHarnessSessionLimits.sessionsPerInventoryPage,
      (pageIndex + 1) * hostHarnessSessionLimits.sessionsPerInventoryPage
    )),
    pageIndex
  }));
  const completion = { ...complete(11, sessions.length), pageCount: pages.length };
  assert.equal(applyHostSessionGeneration(state, pages, completion).kind, "accepted");
  assert.ok(state.hostSessionInventoryBytes! <= hostSessionInventoryStorageLimits.bytes);

  const maximalProjection = {
    ...sessions[0]!,
    hostHarnessSessionId: "i".repeat(hostHarnessSessionLimits.identifierBytes),
    nodeId: "n".repeat(hostHarnessSessionLimits.identifierBytes),
    providerSessionId: "p".repeat(hostHarnessSessionLimits.identifierBytes),
    providerTurnId: "t".repeat(hostHarnessSessionLimits.identifierBytes),
    attachedThreadId: "a".repeat(hostHarnessSessionLimits.identifierBytes),
    activeRunId: "r".repeat(hostHarnessSessionLimits.identifierBytes),
    attachmentEpoch: Number.MAX_SAFE_INTEGER
  };
  assert.equal(validateHostHarnessSession(maximalProjection).ok, true);
  const maximalGlobal = Array(hostHarnessSessionLimits.sessionsGlobal).fill(maximalProjection);
  assert.ok(Buffer.byteLength(JSON.stringify(maximalGlobal), "utf8") <= hostSessionInventoryStorageLimits.bytes,
    "the global count bound must fit worst-case valid string extents");
});

test("global multi-node retention preserves per-node fairness and keeps snapshots within the shared client bound", async () => {
  const { store } = await fixture();
  const state = store.read((current) => structuredClone(current) as State);
  state.hostHarnessSessions = Array.from({ length: hostHarnessSessionLimits.sessionsPerGeneration + 1 }, (_, index) => ({
    ...observation({
      hostHarnessSessionId: `global-session-${index}`, providerSessionId: `global-provider-${index}`,
      nodeId: index % 2 === 0 ? "node-one" : "node-two", status: "closed", operations: [],
      createdAt: "2026-10-06T10:00:00Z", updatedAt: new Date(Date.UTC(2026, 9, 6, 10, 0, index % 60)).toISOString()
    }),
    attachmentEpoch: 0
  }));
  assert.equal(enforceGlobalHostSessionRetention(state), true);
  assert.equal(state.hostHarnessSessions.length, hostHarnessSessionLimits.sessionsPerGeneration + 1,
    "one full node cannot consume the larger multi-node ceiling");

  state.hostHarnessSessions = Array.from({ length: hostHarnessSessionLimits.sessionsGlobal + 1 }, (_, index) => ({
    ...observation({
      hostHarnessSessionId: `evicted-global-${index}`, providerSessionId: `evicted-provider-${index}`,
      nodeId: index % 2 === 0 ? "node-one" : "node-two", status: "closed", operations: [],
      createdAt: "2026-10-06T10:00:00Z", updatedAt: new Date(Date.UTC(2026, 9, 6, 10, 0, index % 60)).toISOString()
    }),
    attachmentEpoch: 0
  }));
  assert.equal(enforceGlobalHostSessionRetention(state), true);
  assert.ok(state.hostHarnessSessions.length <= hostHarnessSessionLimits.sessionsGlobal);
  assert.ok(state.hostHarnessSessions.length > hostHarnessSessionLimits.sessionsPerGeneration,
    "the byte budget still permits more than one node-sized generation of ordinary records");
  assert.ok(Buffer.byteLength(JSON.stringify(state.hostHarnessSessions), "utf8")
    <= hostSessionInventoryStorageLimits.bytes);

  state.hostHarnessSessions = Array.from({ length: hostHarnessSessionLimits.sessionsGlobal + 1 }, (_, index) => ({
    ...observation({
      hostHarnessSessionId: `protected-global-${index}`, providerSessionId: `protected-provider-${index}`,
      nodeId: index % 2 === 0 ? "node-one" : "node-two", status: "running", revision: 2,
      providerTurnId: `turn-${index}`, updatedAt: "2026-10-06T12:00:00Z"
    }),
    attachedThreadId: `thread-${index}`, attachmentEpoch: 1
  }));
  assert.equal(enforceGlobalHostSessionRetention(state), false);
  assert.equal(state.hostHarnessSessions.length, hostHarnessSessionLimits.sessionsGlobal + 1);
});

test("per-node retention never removes an unattached session that still owns an active run", async () => {
  const { store } = await fixture();
  const state = store.read((current) => structuredClone(current) as State);
  state.hostHarnessSessions = Array.from({ length: hostHarnessSessionLimits.sessionsPerGeneration + 1 }, (_, index) => ({
    ...observation({
      hostHarnessSessionId: `node-retention-${index}`, providerSessionId: `node-provider-${index}`,
      status: index === 0 ? "offline" : "closed", operations: index === 0 ? ["attach", "read-history"] : [],
      updatedAt: new Date(Date.UTC(2026, 9, 6, 10, 0, index % 60)).toISOString()
    }),
    ...(index === 0 ? { activeRunId: "run-protected" } : {}),
    attachmentEpoch: 0
  }));
  assert.equal(enforceNodeHostSessionRetention(state, "node-one"), true);
  assert.equal(state.hostHarnessSessions.length, hostHarnessSessionLimits.sessionsPerGeneration);
  assert.ok(state.hostHarnessSessions.some((session) => session.hostHarnessSessionId === "node-retention-0"));
});

test("global eviction invalidates another node's marker so an exact inventory replay restores authority", async () => {
  const { store } = await fixture();
  const state = store.read((current) => structuredClone(current) as State);
  state.nodes.push({ ...hostSessionTestNode, id: "node-two", name: "Node two" });
  const evicted = observation({
    hostHarnessSessionId: "node-two-evicted", providerSessionId: "node-two-provider", nodeId: "node-two",
    status: "offline", updatedAt: "2000-01-01T00:00:00Z"
  });
  const kept = observation({
    hostHarnessSessionId: "node-two-kept", providerSessionId: "node-two-kept-provider", nodeId: "node-two",
    status: "offline", updatedAt: "2026-10-06T11:00:00Z"
  });
  const restored = observation({
    hostHarnessSessionId: evicted.hostHarnessSessionId, providerSessionId: evicted.providerSessionId,
    nodeId: "node-two", updatedAt: "2026-10-06T12:01:00Z"
  });
  const keptOriginal = { ...kept, status: "idle" as const };
  const restoredPage = { ...page(7, [restored, keptOriginal]), nodeId: "node-two" };
  const restoredComplete = { ...complete(7, 2), nodeId: "node-two" };
  const digestProbe = structuredClone(state);
  digestProbe.hostHarnessSessions = [];
  digestProbe.hostSessionInventoryGenerations = [];
  assert.equal(applyHostSessionGeneration(digestProbe, [restoredPage], restoredComplete).kind, "accepted");
  const committedDigest = digestProbe.hostSessionInventoryGenerations?.[0]?.digest;
  assert.ok(committedDigest);
  state.hostHarnessSessions = [
    { ...evicted, attachmentEpoch: 0 },
    { ...kept, attachedThreadId: "thread-protected", attachmentEpoch: 1 },
    ...Array.from({ length: hostHarnessSessionLimits.sessionsGlobal }, (_, index) => ({
      ...observation({
        hostHarnessSessionId: `node-one-global-${index}`, providerSessionId: `node-one-provider-${index}`,
        status: "closed", operations: [], updatedAt: "2026-10-06T12:00:00Z"
      }),
      attachmentEpoch: 0
    }))
  ];
  state.hostSessionInventoryGenerations = [{
    nodeId: "node-two", generation: 7, digest: committedDigest, completedAt: "2026-10-06T12:00:00Z",
    offlineProjections: [{
      hostHarnessSessionId: kept.hostHarnessSessionId, revision: kept.revision,
      originalStatus: "idle", originalUpdatedAt: kept.updatedAt
    }]
  }];
  assert.equal(enforceGlobalHostSessionRetention(state), true);
  assert.equal(state.hostHarnessSessions.some((session) => session.hostHarnessSessionId === evicted.hostHarnessSessionId), false);
  const invalidated = state.hostSessionInventoryGenerations.find((marker) => marker.nodeId === "node-two");
  assert.equal(invalidated?.invalidated, true);
  assert.equal(invalidated?.offlineProjections?.[0]?.hostHarnessSessionId, kept.hostHarnessSessionId);

  assert.equal(applyHostSessionGeneration(state,
    [{ ...page(6, [keptOriginal]), nodeId: "node-two" }],
    { ...complete(6), nodeId: "node-two" }).kind, "older",
  "invalidation permits an exact replay, not rollback to an older generation");
  const conflictingPage = {
    ...restoredPage,
    sessions: [restored, { ...keptOriginal, summary: "conflicting same-generation evidence" }]
  };
  assert.equal(applyHostSessionGeneration(state, [conflictingPage], restoredComplete).kind, "rejected");
  assert.equal(state.hostHarnessSessions.some((session) => session.hostHarnessSessionId === evicted.hostHarnessSessionId), false);
  assert.equal(applyHostSessionGeneration(state, [restoredPage], restoredComplete).kind, "accepted");
  assert.equal(state.hostHarnessSessions.some((session) => session.hostHarnessSessionId === evicted.hostHarnessSessionId), true);
  assert.equal(state.hostHarnessSessions.find((session) => session.hostHarnessSessionId === kept.hostHarnessSessionId)?.status, "idle");
  assert.equal(applyHostSessionUpdate(state, {
    type: "host-session.update", nodeId: "node-two",
    session: { ...restored, status: "running", revision: 2, providerTurnId: "turn-restored", updatedAt: "2026-10-06T12:02:00Z" },
    at: "2026-10-06T12:02:00Z"
  }).kind, "accepted");
});

test("an update eviction invalidates its own generation so an exact reconnect replay restores authority", async () => {
  const { store } = await fixture();
  const state = store.read((current) => structuredClone(current) as State);
  const evicted = observation({
    hostHarnessSessionId: "same-node-evicted", providerSessionId: "same-node-evicted-provider",
    status: "offline", createdAt: "2000-01-01T00:00:00Z", updatedAt: "2000-01-01T00:00:00Z"
  });
  const evictedOriginal = { ...evicted, status: "idle" as const };
  const target = observation({
    hostHarnessSessionId: "same-node-target", providerSessionId: "same-node-target-provider",
    updatedAt: "2026-10-06T12:00:00Z"
  });
  const committedPage = page(9, [evictedOriginal, target]);
  const committedComplete = complete(9, 2);
  const digestProbe = structuredClone(state);
  assert.equal(applyHostSessionGeneration(digestProbe, [committedPage], committedComplete).kind, "accepted");
  const committedDigest = digestProbe.hostSessionInventoryGenerations?.[0]?.digest;
  assert.ok(committedDigest);

  state.hostHarnessSessions = [evicted, target].map((session) => ({ ...session, attachmentEpoch: 0 }));
  state.hostSessionInventoryGenerations = [{
    nodeId: "node-one", generation: 9, digest: committedDigest, completedAt: committedComplete.at,
    offlineProjections: [{
      hostHarnessSessionId: evicted.hostHarnessSessionId, revision: evicted.revision,
      originalStatus: "idle", originalUpdatedAt: evicted.updatedAt
    }]
  }];
  let storedBytes = Buffer.byteLength(JSON.stringify(state.hostHarnessSessions), "utf8");
  let fillerIndex = 0;
  for (;;) {
    const filler = {
      ...observation({
        hostHarnessSessionId: `update-filler-${fillerIndex}`, providerSessionId: `update-filler-provider-${fillerIndex}`,
        nodeId: "node-two", status: "closed", operations: [], summary: "f".repeat(2_000),
        updatedAt: "2026-10-06T12:01:00Z"
      }),
      attachmentEpoch: 0
    };
    const encodedBytes = Buffer.byteLength(JSON.stringify(filler), "utf8") + 1;
    if (storedBytes + encodedBytes > hostSessionInventoryStorageLimits.bytes - 1_000) break;
    state.hostHarnessSessions.push(filler);
    storedBytes += encodedBytes;
    fillerIndex += 1;
  }
  const padding = {
    ...observation({
      hostHarnessSessionId: "update-padding", providerSessionId: "update-padding-provider",
      nodeId: "node-two", status: "closed", operations: [], summary: "",
      updatedAt: "2026-10-06T12:01:00Z"
    }),
    attachmentEpoch: 0
  };
  const paddingOverhead = Buffer.byteLength(JSON.stringify(padding), "utf8") + 1;
  const paddingLength = Math.max(0, Math.min(2_000,
    hostSessionInventoryStorageLimits.bytes - 1_000 - storedBytes - paddingOverhead));
  if (paddingLength > 0) state.hostHarnessSessions.push({ ...padding, summary: "p".repeat(paddingLength) });
  assert.ok(Buffer.byteLength(JSON.stringify(state.hostHarnessSessions), "utf8")
    <= hostSessionInventoryStorageLimits.bytes);
  const update = {
    type: "host-session.update", nodeId: "node-one",
    session: {
      ...target, status: "running", revision: 2, providerTurnId: "same-node-turn",
      summary: "u".repeat(2_000), updatedAt: "2026-10-06T12:02:00Z"
    },
    at: "2026-10-06T12:02:00Z"
  } satisfies Extract<HostSessionControlMessage, { type: "host-session.update" }>;
  const unretained = state.hostHarnessSessions.map((session) =>
    session.hostHarnessSessionId === target.hostHarnessSessionId ? { ...update.session, attachmentEpoch: 0 } : session);
  assert.ok(Buffer.byteLength(JSON.stringify(unretained), "utf8") > hostSessionInventoryStorageLimits.bytes,
    "the update must cross the byte cap before retention");

  assert.equal(applyHostSessionUpdate(state, update).kind, "accepted");
  assert.equal(state.hostHarnessSessions.some((session) => session.hostHarnessSessionId === evicted.hostHarnessSessionId), false);
  assert.equal(state.hostSessionInventoryGenerations[0]?.invalidated, true);
  assert.equal(applyHostSessionGeneration(state, [committedPage], committedComplete).kind, "accepted");
  assert.equal(state.hostHarnessSessions.some((session) => session.hostHarnessSessionId === evicted.hostHarnessSessionId), true);
  assert.equal(state.hostHarnessSessions.find((session) =>
    session.hostHarnessSessionId === target.hostHarnessSessionId)?.revision, 2,
    "repairing the generation must not roll back a newer accepted update");
});
