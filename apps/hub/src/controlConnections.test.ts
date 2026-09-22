import assert from "node:assert/strict";
import test from "node:test";
import type { Agent, HubToControlAgent, Run } from "@coffee-shop/protocol";
import { ControlConnectionRegistry, type ControlSocket } from "./controlConnections.js";

const open = 1;
const closed = 3;

class FakeSocket implements ControlSocket {
  readyState = open;
  readonly sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
}

const run = { id: "run-one", taskId: "task-one", attempt: 1, transport: "native-cli", nodeId: "node-one", status: "queued" } as Run;
const dispatch = (): Extract<HubToControlAgent, { type: "dispatch" }> =>
  ({ type: "dispatch", run, agent: { id: "agent-one" } as Agent, execution: { transport: "native-cli", taskId: "task-one", attempt: 1 } });

test("a dispatch approved against a replaced connection is never sent to the new unsynced socket", () => {
  const registry = new ControlConnectionRegistry<FakeSocket>(open);
  const oldSocket = new FakeSocket();
  const oldConnection = registry.register("node-one", oldSocket, "4");
  registry.markSynced(oldConnection);
  const approved = registry.deliveryConnection("node-one", dispatch());
  assert.equal(approved, oldConnection);

  const newSocket = new FakeSocket();
  const newConnection = registry.register("node-one", newSocket, "4");
  oldSocket.readyState = closed;
  assert.equal(registry.deliver(approved!, dispatch()), false);
  assert.deepEqual(oldSocket.sent, []);
  assert.deepEqual(newSocket.sent, []);
  assert.equal(registry.deliveryConnection("node-one", dispatch()), undefined, "an unsynced connection cannot approve a dispatch");

  assert.equal(registry.markSynced(newConnection), true);
  const barrierApproval = registry.deliveryConnection("node-one", dispatch());
  assert.equal(barrierApproval, newConnection);
  assert.equal(registry.deliver(barrierApproval!, dispatch()), true);
  assert.equal(registry.deliver(barrierApproval!, dispatch()), true);
  assert.equal(newSocket.sent.length, 1, "the barrier path dispatches the run exactly once");
});

test("re-registering the same socket starts a new unsynced connection generation", () => {
  const registry = new ControlConnectionRegistry<FakeSocket>(open);
  const socket = new FakeSocket();
  const first = registry.register("node-one", socket, "4");
  registry.markSynced(first);
  const second = registry.register("node-one", socket, "4");
  assert.ok(second.generation > first.generation);
  assert.equal(registry.deliver(first, dispatch()), false);
  assert.equal(registry.deliver(second, dispatch()), false);
  assert.deepEqual(socket.sent, []);
});

test("version 1 connections have no barrier, and version-4 dispatch content is refused for older versions", () => {
  const registry = new ControlConnectionRegistry<FakeSocket>(open);
  const legacySocket = new FakeSocket();
  registry.register("node-legacy", legacySocket, "1");
  const legacyDispatch = { ...dispatch(), run: { ...run, taskId: undefined, attempt: undefined, transport: undefined, nodeId: "node-legacy" } } as Extract<HubToControlAgent, { type: "dispatch" }>;
  delete (legacyDispatch as { execution?: unknown }).execution;
  assert.ok(registry.deliveryConnection("node-legacy", legacyDispatch));
  assert.equal(registry.deliveryConnection("node-legacy", dispatch()), undefined);

  const versionThree = registry.register("node-three", new FakeSocket(), "3");
  registry.markSynced(versionThree);
  assert.equal(registry.deliveryConnection("node-three", dispatch()), undefined);
});

test("releasing a stale socket leaves the node's current connection in place", () => {
  const registry = new ControlConnectionRegistry<FakeSocket>(open);
  const oldSocket = new FakeSocket();
  registry.register("node-one", oldSocket, "4");
  const current = registry.register("node-one", new FakeSocket(), "4");
  assert.equal(registry.release(oldSocket), undefined);
  assert.equal(registry.current("node-one"), current);
  assert.equal(registry.release(current.socket), current);
  assert.equal(registry.has("node-one"), false);
});

test("a failed write does not record the run as delivered", () => {
  const registry = new ControlConnectionRegistry<FakeSocket>(open);
  const socket = new FakeSocket();
  let failures = 1;
  socket.send = (data: string) => {
    if (failures-- > 0) throw new Error("write failed");
    socket.sent.push(data);
  };
  const connection = registry.register("node-one", socket, "4");
  registry.markSynced(connection);
  assert.equal(registry.deliver(connection, dispatch()), false);
  assert.equal(registry.deliver(connection, dispatch()), true);
  assert.equal(socket.sent.length, 1);
});

test("a node admits a second socket only after its live connection is gone", () => {
  const registry = new ControlConnectionRegistry<FakeSocket>(open);
  const running = new FakeSocket();
  const replacement = new FakeSocket();
  assert.equal(registry.admits("node-one", running), true);
  registry.register("node-one", running, "4");

  assert.equal(registry.admits("node-one", replacement), false, "a live connection is never superseded by another process");
  assert.equal(registry.admits("node-one", running), true, "the same socket may re-register");
  assert.equal(registry.admits("node-two", replacement), true, "other nodes are unaffected");
  assert.equal(registry.current("node-one")?.socket, running);

  running.readyState = closed;
  assert.equal(registry.admits("node-one", replacement), true, "a closed connection no longer holds the node");
  const admitted = registry.register("node-one", replacement, "4");
  assert.equal(registry.current("node-one"), admitted);
});

test("a refused socket never becomes current, so reconciliation never reads its active runs", () => {
  const registry = new ControlConnectionRegistry<FakeSocket>(open);
  const running = new FakeSocket();
  const runningConnection = registry.register("node-one", running, "4");
  registry.markSynced(runningConnection);
  const replacement = new FakeSocket();
  if (registry.admits("node-one", replacement)) registry.register("node-one", replacement, "4");

  assert.equal(registry.connectionFor(replacement), undefined);
  assert.equal(registry.current("node-one"), runningConnection);
  assert.equal(registry.barrierPassed(runningConnection), true);
  assert.equal(registry.send("node-one", { type: "ping" }), true);
  assert.equal(running.sent.length, 1);
  assert.equal(replacement.sent.length, 0);
});
