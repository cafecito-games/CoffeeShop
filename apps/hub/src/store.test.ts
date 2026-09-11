import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "./store.js";

test("persists state atomically and loads it again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-store-"));
  const path = join(directory, "state.json");
  const first = new Store(path);
  await first.load();
  await first.transact((state) => { state.agents[0].name = "Test Ada"; });
  assert.equal(JSON.parse(await readFile(path, "utf8")).agents[0].name, "Test Ada");
  const second = new Store(path);
  await second.load();
  assert.equal(second.snapshot().agents[0].name, "Test Ada");
});
