import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadProjectProfilesFromFile, ProjectProfileRegistry } from "./projectProfiles.js";

const validProfile = (id: string, name: string) => ({
  schemaVersion: 1,
  id,
  name,
  workspacePolicy: { requireWritable: false },
  requirements: { hard: { operatingSystems: ["linux"] } }
});

async function withTempProfileFile(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-project-profiles-"));
  const path = join(directory, "project-profiles.json");
  await writeFile(path, contents, "utf8");
  return path;
}

test("loads a well-formed file with distinct valid profiles in file order", async () => {
  const path = await withTempProfileFile(JSON.stringify({
    profiles: [validProfile("alpha-web", "Alpha web"), validProfile("beta-api", "Beta API")]
  }));
  const result = await loadProjectProfilesFromFile(path);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.profiles.map((profile) => profile.id), ["alpha-web", "beta-api"]);
});

test("accepts an empty profiles array as no configured projects", async () => {
  const path = await withTempProfileFile(JSON.stringify({ profiles: [] }));
  const result = await loadProjectProfilesFromFile(path);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.profiles, []);
});

test("reports a missing file as not-found with the path in the error", async () => {
  const path = join(tmpdir(), "coffee-shop-missing-profiles.json");
  const result = await loadProjectProfilesFromFile(path);
  assert.deepEqual(result, { ok: false, kind: "not-found", error: `project profile file not found: ${path}` });
});

test("rejects malformed files as invalid with a non-empty reason", async () => {
  const cases: [string, string][] = [
    ["malformed JSON", "{ not json"],
    ["top-level array", JSON.stringify([validProfile("alpha-web", "Alpha web")])],
    ["unknown top-level key", JSON.stringify({ profiles: [], extra: true })],
    ["bad schema version", JSON.stringify({ profiles: [{ ...validProfile("alpha-web", "Alpha web"), schemaVersion: 99 }] })]
  ];

  for (const [label, contents] of cases) {
    const path = await withTempProfileFile(contents);
    const result = await loadProjectProfilesFromFile(path);
    assert.equal(result.ok, false, label);
    if (result.ok) return;
    assert.equal(result.kind, "invalid", label);
    assert.ok(result.error.length > 0, label);
  }
});

test("names the array index of the first invalid profile entry", async () => {
  const path = await withTempProfileFile(JSON.stringify({
    profiles: [validProfile("alpha-web", "Alpha web"), { schemaVersion: 99, id: "beta-api", name: "Beta API", workspacePolicy: { requireWritable: false }, requirements: { hard: {} } }]
  }));
  const result = await loadProjectProfilesFromFile(path);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "invalid");
  assert.match(result.error, /index 1/);
});

test("rejects duplicate profile ids across the array", async () => {
  const path = await withTempProfileFile(JSON.stringify({
    profiles: [validProfile("alpha-web", "Alpha web"), validProfile("alpha-web", "Alpha web again")]
  }));
  const result = await loadProjectProfilesFromFile(path);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "invalid");
  assert.match(result.error, /alpha-web/);
});

test("the checked-in example file loads with exactly three valid profiles", async () => {
  const path = fileURLToPath(new URL("../../../config/project-profiles.example.json", import.meta.url));
  const result = await loadProjectProfilesFromFile(path);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.profiles.length, 3);
});

test("registry looks up, tests membership, and preserves load order", async () => {
  const path = await withTempProfileFile(JSON.stringify({
    profiles: [validProfile("alpha-web", "Alpha web"), validProfile("beta-api", "Beta API")]
  }));
  const result = await loadProjectProfilesFromFile(path);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const registry = new ProjectProfileRegistry(result.profiles);

  assert.equal(registry.has("alpha-web"), true);
  assert.equal(registry.has("beta-api"), true);
  assert.equal(registry.has("gone"), false);
  assert.equal(registry.get("alpha-web")?.name, "Alpha web");
  assert.equal(registry.get("gone"), undefined);
  assert.deepEqual(registry.list().map((profile) => profile.id), ["alpha-web", "beta-api"]);
});
