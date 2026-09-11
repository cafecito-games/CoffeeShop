import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
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
