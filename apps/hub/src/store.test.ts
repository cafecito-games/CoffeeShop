import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { newEvent, Store } from "./store.js";

test("starts empty, persists state atomically, and loads it again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-store-"));
  const path = join(directory, "state.json");
  const first = new Store(path);
  await first.load();
  assert.deepEqual(first.snapshot().agents, []);
  assert.deepEqual(first.snapshot().nodes, []);
  assert.deepEqual(first.snapshot().runs, []);
  assert.deepEqual(first.snapshot().events, []);
  assert.deepEqual(first.snapshot().messages, []);

  await first.transact((state) => {
    state.events.push(newEvent({ type: "status", title: "Saved event", detail: "Persistence check" }));
  });
  assert.equal(JSON.parse(await readFile(path, "utf8")).events[0].title, "Saved event");
  const second = new Store(path);
  await second.load();
  assert.equal(second.snapshot().events[0].title, "Saved event");
});

test("removes legacy demo records without removing user-created data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-store-"));
  const path = join(directory, "state.json");
  await writeFile(path, JSON.stringify({
    agents: [
      { id: "cpp-steward", name: "Ada", computeNodeId: "home-linux" },
      { id: "claude-scout", name: "Claude Scout", computeNodeId: "local-macbook" }
    ],
    nodes: [
      { id: "local-macbook", name: "This laptop", workspaceRoots: ["/Users/christian/Projects"] },
      { id: "home-linux", name: "Home server", workspaceRoots: ["/srv/workspaces"] },
      { id: "cloud-runner", name: "Cloud runner", workspaceRoots: ["/workspace"] }
    ],
    runs: [
      { id: "run-benchmark", agentId: "cpp-steward", nodeId: "home-linux" },
      { id: "real-run", agentId: "claude-scout", nodeId: "local-macbook" }
    ],
    events: [
      { id: "evt-1", agentId: "cpp-steward", runId: "run-benchmark" },
      { id: "real-event", agentId: "claude-scout", runId: "real-run" }
    ],
    messages: [
      { id: "msg-1", agentId: "cpp-steward", runId: "run-benchmark" },
      { id: "real-message", agentId: "claude-scout", runId: "real-run" }
    ]
  }));

  const store = new Store(path);
  await store.load();
  const snapshot = store.snapshot();
  assert.deepEqual(snapshot.agents.map((agent) => agent.id), ["claude-scout"]);
  assert.equal(snapshot.agents[0].avatarShape, "cup");
  assert.equal(snapshot.agents[0].avatarColor, "amber");
  assert.deepEqual(snapshot.nodes.map((node) => node.id), ["local-macbook"]);
  assert.deepEqual(snapshot.runs.map((run) => run.id), ["real-run"]);
  assert.deepEqual(snapshot.events.map((event) => event.id), ["real-event"]);
  assert.deepEqual(snapshot.messages.map((message) => message.id), ["real-message"]);
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.agents[0].id, "claude-scout");
  assert.equal(persisted.agents[0].avatarShape, "cup");
  assert.equal(persisted.agents[0].avatarColor, "amber");
});

test("serializes concurrent transactions without losing persistence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-store-"));
  const path = join(directory, "state.json");
  const store = new Store(path);
  await store.load();

  await Promise.all(Array.from({ length: 24 }, (_, index) => store.transact((state) => {
    state.events.push(newEvent({ type: "status", title: `Event ${index}`, detail: "Concurrent persistence check" }));
  })));

  const reloaded = new Store(path);
  await reloaded.load();
  assert.equal(reloaded.snapshot().events.length, 24);
});
