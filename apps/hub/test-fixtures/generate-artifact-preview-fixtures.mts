import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import {
  previewBundleArtifactKind,
  previewBundleMediaType,
  type Agent,
  type Run
} from "@coffee-shop/protocol";
import { beginProcessing, registerPreview, settleProcessing } from "../src/artifactPreviews.js";
import { templateFromLegacyAgent } from "../src/agentTemplates.js";
import { Store } from "../src/store.js";

const at = "2026-09-27T12:00:00.000Z";
const after = (seconds: number) => new Date(Date.parse(at) + seconds * 1_000).toISOString();
const stateUrl = new URL("./state-with-artifact-preview.json", import.meta.url);
const snapshotUrl = new URL("../../web/src/test/fixtures/hubPreviewSnapshot.json", import.meta.url);

const agent: Agent = {
  id: "publisher", name: "Publisher", title: "Publisher", summary: "", glyph: "P",
  avatarShape: "cup", avatarColor: "amber", state: "working", currentAction: "Publishing",
  harnessId: "codex-cli", model: "default", computeNodeId: "node-one", workspace: "/workspace/publisher",
  systemPrompt: "Publish carefully", canDelegate: true, unread: 0, updatedAt: at
};
const run: Run = {
  id: "run-source", threadId: "thread-one", agentId: agent.id, nodeId: "node-one", harnessId: "codex-cli",
  model: "default", workspace: "/workspace/publisher", prompt: "Publish the preview", status: "running",
  output: "", depth: 0, createdAt: at, startedAt: at
};

/** Drives the real lifecycle producers; deterministic IDs make checked-in bytes reproducible. */
async function generate() {
  await rm(stateUrl, { force: true });
  const originalNow = Date.now;
  const originalRandom = Math.random;
  let sequence = 0;
  Date.now = () => Date.parse(at);
  Math.random = () => (++sequence) / 10_000;
  try {
    const store = new Store(stateUrl.pathname);
    await store.load();
    const imported = templateFromLegacyAgent(agent);
    assert.equal(imported.ok, true);
    await store.transact((state) => {
      state.agents = [agent];
      state.threads = [{
        id: "thread-one", title: "Preview", objective: "Publish the preview", summary: "", status: "active",
        ownerAgentId: agent.id, orchestrator: { kind: "agent", agentId: agent.id }, createdBy: "user",
        createdAt: at, updatedAt: at
      }];
      state.runs = [run];
      state.templates = [imported.template];
      state.legacyTemplateImports = [{ agentId: agent.id, templateId: imported.template.id, at }];
    });
    const registered = await registerPreview(store, run.id, {
      relativePath: ".coffee-shop/previews/site.tar.gz", title: "Site preview",
      kind: previewBundleArtifactKind, mediaType: previewBundleMediaType, summary: "Static site",
      size: 512, sha256: "a".repeat(64), entrypoint: "site/index.html",
      ttlSeconds: 24 * 60 * 60, idempotencyKey: "preview-one"
    }, at);
    await store.transact((state) => {
      state.artifacts!.find((artifact) => artifact.id === registered.artifact.id)!.uploaded = true;
    });
    await beginProcessing(store, registered.preview.id, after(60));
    await settleProcessing(store, {
      previewId: registered.preview.id, artifactId: registered.artifact.id,
      artifactSha256: registered.artifact.sha256, processingGeneration: 1,
      outcome: "ready", at: after(120)
    });

    const beforeReload = await readFile(stateUrl);
    const restarted = new Store(stateUrl.pathname);
    await restarted.load();
    assert.deepEqual(await readFile(stateUrl), beforeReload, "the generated state is already migration-complete");
    await writeFile(snapshotUrl, `${JSON.stringify(restarted.snapshot(after(240)), null, 2)}\n`);
  } finally {
    Date.now = originalNow;
    Math.random = originalRandom;
  }
}

await generate();
