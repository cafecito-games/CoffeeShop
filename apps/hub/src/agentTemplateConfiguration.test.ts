import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Agent, AgentTemplate } from "@coffee-shop/protocol";
import {
  createAgentTemplate,
  deleteAgentTemplate,
  updateAgentTemplate
} from "./agentTemplateConfiguration.js";
import { importLegacyAgentTemplates } from "./agentTemplates.js";
import { CoordinationError } from "./coordinationError.js";
import { Store } from "./store.js";

const at = "2026-09-28T12:00:00.000Z";
const later = "2026-09-28T12:01:00.000Z";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-template-configuration-"));
  const path = join(directory, "state.json");
  const store = new Store(path);
  await store.load();
  return { store, path };
}

const isCode = (code: string) => (error: unknown) => error instanceof CoordinationError && error.code === code;

const editable = {
  name: " Reviewer ",
  purpose: { name: " Reviewer ", title: " Quality ", summary: " Checks changes ", instructions: " Be exact. " },
  glyph: " R ",
  avatarShape: "cup" as const,
  avatarColor: "amber" as const,
  instructions: " Review carefully. ",
  skills: [" TypeScript ", "go", "typescript"],
  tags: [" Quality ", "backend", "quality"],
  requirements: { models: ["fable", "default"], labels: ["trusted", "linux"] },
  preferences: { nodeIds: ["node-two", "node-one"], models: ["fable", "default"] },
  delegation: { canDelegate: false }
};

test("operator template creation normalizes fields, replays exactly, and keeps receipts private", async () => {
  const { store } = await fixture();
  const created = await createAgentTemplate(store, "operator", "create-reviewer", editable, at);
  assert.equal(created.replayed, false);
  assert.match(created.template.id, /^template_/);
  assert.deepEqual(created.template, {
    id: created.template.id,
    name: "Reviewer",
    purpose: { name: "Reviewer", title: "Quality", summary: "Checks changes", instructions: "Be exact." },
    glyph: "R", avatarShape: "cup", avatarColor: "amber", instructions: "Review carefully.",
    skills: ["go", "typescript"], tags: ["backend", "quality"],
    requirements: { labels: ["linux", "trusted"], models: ["default", "fable"] },
    preferences: { nodeIds: ["node-two", "node-one"], models: ["fable", "default"] },
    delegation: { canDelegate: false }
  });
  const replay = await createAgentTemplate(store, "operator", "create-reviewer", {
    ...editable,
    tags: ["backend", "quality"],
    skills: ["typescript", "go"],
    requirements: { labels: ["linux", "trusted"], models: ["default", "fable"] }
  }, later);
  assert.deepEqual({ ...replay, template: { ...replay.template, id: created.template.id } }, { template: created.template, replayed: true });
  assert.equal(store.snapshot().templates?.length, 1);
  assert.equal(Object.hasOwn(store.snapshot() as object, "agentTemplateConfigurationReceipts"), false);

  await assert.rejects(createAgentTemplate(store, "operator", "create-reviewer", { ...editable, name: "Different" }, later), isCode("idempotency_conflict"));
  assert.equal(store.snapshot().templates?.length, 1);
});

test("unknown, hub-owned, malformed, and empty patch fields fail before any write", async () => {
  const { store } = await fixture();
  for (const input of [
    { ...editable, id: "chosen" },
    { ...editable, legacyAgentId: "legacy" },
    { ...editable, unknown: true },
    { ...editable, name: "" },
    { ...editable, skills: "go" }
  ]) await assert.rejects(createAgentTemplate(store, "operator", `bad-${JSON.stringify(input).length}`, input, at), isCode("invalid_arguments"));
  assert.deepEqual(store.snapshot().templates, []);
  assert.equal(store.read((state) => state.agentTemplateConfigurationReceipts?.length ?? 0), 0);

  const created = await createAgentTemplate(store, "operator", "valid", { name: "Valid" }, at);
  for (const patch of [{}, { id: "changed" }, { legacyAgentId: "changed" }, { name: "" }, { purpose: { extra: true } }]) {
    await assert.rejects(updateAgentTemplate(store, "operator", `patch-${JSON.stringify(patch)}`, created.template.id, patch, later), isCode("invalid_arguments"));
  }
  assert.equal(store.snapshot().templates?.[0].name, "Valid");
});

test("updates preserve imported provenance and delete never re-imports a legacy template", async () => {
  const { store } = await fixture();
  const legacy: Agent = {
    id: "legacy-one", name: "Milo", title: "Builder", summary: "Builds", glyph: "M",
    avatarShape: "cup", avatarColor: "amber", state: "idle", currentAction: "Waiting",
    harnessId: "codex-cli", model: "default", computeNodeId: "node-one", workspace: "/workspace",
    systemPrompt: "Build carefully", skills: ["go"], unread: 0, updatedAt: at
  };
  await store.transact((state) => {
    state.agents.push(legacy);
    assert.equal(importLegacyAgentTemplates(state, at), true);
  });
  const imported = store.snapshot().templates?.[0] as AgentTemplate;
  const updated = await updateAgentTemplate(store, "operator", "update-imported", imported.id, { name: "Milo revised", skills: ["Rust", "rust"] }, later);
  assert.deepEqual([updated.template.id, updated.template.legacyAgentId, updated.template.name, updated.template.skills], [imported.id, legacy.id, "Milo revised", ["rust"]]);

  const removed = await deleteAgentTemplate(store, "operator", "delete-imported", imported.id, later);
  assert.deepEqual([removed.template.id, removed.template.legacyAgentId, removed.replayed], [imported.id, legacy.id, false]);
  await store.transact((state) => assert.equal(importLegacyAgentTemplates(state, later), false));
  assert.deepEqual(store.snapshot().templates, []);
  assert.equal(store.read((state) => state.legacyTemplateImports?.[0].templateId), imported.id);
});

test("delete rejects live task and instance references atomically but permits terminal history", async () => {
  const { store } = await fixture();
  const template = (await createAgentTemplate(store, "operator", "create-referenced", { name: "Referenced" }, at)).template;
  await store.transact((state) => {
    state.tasks = [{
      id: "task-one", threadId: "thread-one", title: "Task", instructions: "Do it", status: "ready",
      requirements: { templateId: template.id }, dependencies: [], idempotencyKey: "batch", attemptRunIds: [], createdAt: at, updatedAt: at
    }];
    state.instances = [{
      id: "instance-one", threadId: "thread-one", creator: { kind: "operator", operatorId: "operator" },
      delegation: { canDelegate: false }, requirements: { templateId: template.id },
      lease: { idleTimeoutSeconds: 1800, expiresAt: later }, status: "draining", createdAt: at, updatedAt: at
    }];
  });
  const before = store.read((state) => JSON.stringify([state.templates, state.agentTemplateConfigurationReceipts]));
  await assert.rejects(deleteAgentTemplate(store, "operator", "delete-live", template.id, later), isCode("conflict"));
  assert.equal(store.read((state) => JSON.stringify([state.templates, state.agentTemplateConfigurationReceipts])), before);

  await store.transact((state) => {
    state.tasks![0].status = "completed";
    state.instances![0].status = "released";
  });
  assert.equal((await deleteAgentTemplate(store, "operator", "delete-terminal", template.id, later)).template.id, template.id);
});

test("receipts survive restart, concurrent duplicates converge, and missing targets never upsert", async () => {
  const { store, path } = await fixture();
  const [left, right] = await Promise.all([
    createAgentTemplate(store, "operator", "concurrent", { name: "Concurrent" }, at),
    createAgentTemplate(store, "operator", "concurrent", { name: "Concurrent" }, at)
  ]);
  assert.equal(left.template.id, right.template.id);
  assert.deepEqual([left.replayed, right.replayed].sort(), [false, true]);

  const restarted = new Store(path);
  await restarted.load();
  const replay = await createAgentTemplate(restarted, "operator", "concurrent", { name: "Concurrent" }, later);
  assert.deepEqual([replay.template.id, replay.replayed], [left.template.id, true]);
  await assert.rejects(updateAgentTemplate(restarted, "operator", "missing-update", "template-missing", { name: "Nope" }, later), isCode("not_found"));
  await assert.rejects(deleteAgentTemplate(restarted, "operator", "missing-delete", "template-missing", later), isCode("not_found"));
  assert.equal(restarted.snapshot().templates?.length, 1);
});

test("a failed persistence attempt commits neither catalog nor receipt and leaves the key retryable", async () => {
  const { store, path } = await fixture();
  await rm(path);
  await mkdir(path);
  await assert.rejects(createAgentTemplate(store, "operator", "safe-retry", { name: "Retryable" }, at));
  assert.deepEqual(store.snapshot().templates, []);
  assert.equal(store.read((state) => state.agentTemplateConfigurationReceipts?.length), 0);

  await rm(path, { recursive: true });
  const retried = await createAgentTemplate(store, "operator", "safe-retry", { name: "Retryable" }, later);
  assert.equal(retried.replayed, false);
  assert.equal(store.snapshot().templates?.length, 1);
  const restarted = new Store(path);
  await restarted.load();
  assert.equal((await createAgentTemplate(restarted, "operator", "safe-retry", { name: "Retryable" }, later)).replayed, true);
});

test("store migration defaults private receipts and load rejects noncanonical receipt bytes", async () => {
  const migratedFixture = await fixture();
  const legacy = JSON.parse(await readFile(migratedFixture.path, "utf8"));
  delete legacy.agentTemplateConfigurationReceipts;
  await writeFile(migratedFixture.path, JSON.stringify(legacy, null, 2));
  const migrated = new Store(migratedFixture.path);
  await migrated.load();
  assert.deepEqual(migrated.read((state) => state.agentTemplateConfigurationReceipts), []);
  assert.ok(JSON.parse(await readFile(migratedFixture.path, "utf8")).agentTemplateConfigurationReceipts);

  const corruptFixture = await fixture();
  await createAgentTemplate(corruptFixture.store, "operator", "corrupt-me", { name: "Canonical" }, at);
  const corrupt = JSON.parse(await readFile(corruptFixture.path, "utf8"));
  corrupt.agentTemplateConfigurationReceipts[0].input.name = " Canonical ";
  const bytes = `${JSON.stringify(corrupt, null, 2)}\n`;
  await writeFile(corruptFixture.path, bytes);
  await assert.rejects(new Store(corruptFixture.path).load(), /invalid normalized input/);
  assert.equal(await readFile(corruptFixture.path, "utf8"), bytes);
});
