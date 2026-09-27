import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  previewBundleArtifactKind,
  previewBundleMediaType,
  type Agent,
  type Run
} from "@coffee-shop/protocol";
import { registerPreview } from "../src/artifactPreviews.js";
import { templateFromLegacyAgent } from "../src/agentTemplates.js";
import { ingestArtifactContent } from "../src/previewPreparation.js";
import { PreviewStorage } from "../src/previewStorage.js";
import { Store } from "../src/store.js";

const at = "2026-09-27T12:00:00.000Z";
const after = (seconds: number) => new Date(Date.parse(at) + seconds * 1_000).toISOString();
const stateUrl = new URL("./state-with-artifact-preview.json", import.meta.url);
const snapshotUrl = new URL("../../web/src/test/fixtures/hubPreviewSnapshot.json", import.meta.url);
const bundleUrl = new URL("./preview-v1/bundle.tar.gz", import.meta.url);
const paxBundleUrl = new URL("./preview-v1/pax-bundle.tar.gz", import.meta.url);
const manifestUrl = new URL("./preview-v1/manifest.json", import.meta.url);
const indexUrl = new URL("./preview-v1/content/site/index.html", import.meta.url);
const scriptUrl = new URL("./preview-v1/content/site/app.js", import.meta.url);
const producerUrl = new URL("./generate-preview-bundle.go", import.meta.url);
const check = process.argv.includes("--check");

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

const sameBytes = async (url: URL, expected: Buffer) => {
  if (check) {
    assert.deepEqual(await readFile(url), expected, `${fileURLToPath(url)} is stale`);
  } else {
    await mkdir(new URL("./", url), { recursive: true });
    await writeFile(url, expected);
  }
};

/** Drives Go archive/tar bytes through the real Hub registration, ingestion, preparation and reload. */
async function generate() {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-preview-fixture-"));
  const generatedStatePath = join(directory, "state.json");
  const originalNow = Date.now;
  const originalRandom = Math.random;
  let sequence = 0;
  Date.now = () => Date.parse(at);
  Math.random = () => (++sequence) / 10_000;
  try {
    // Producer provenance: generate-preview-bundle.go:26-46 writes these exact archive/tar entries.
    const bundle = execFileSync("go", ["run", fileURLToPath(producerUrl)], { maxBuffer: 2 * 1024 * 1024 });
    const paxBundle = execFileSync("go", ["run", fileURLToPath(producerUrl), "--long-pax"], { maxBuffer: 2 * 1024 * 1024 });
    const digest = createHash("sha256").update(bundle).digest("hex");
    const store = new Store(generatedStatePath);
    const storage = new PreviewStorage(directory);
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
      size: bundle.length, sha256: digest, entrypoint: "site/index.html",
      ttlSeconds: 24 * 60 * 60, idempotencyKey: "preview-one"
    }, at);
    const times = [after(60), after(120)];
    await ingestArtifactContent(store, storage, {
      artifactId: registered.artifact.id,
      contentType: "application/octet-stream",
      body: Readable.from([bundle]),
      now: () => times.shift() ?? after(120)
    });

    const beforeReload = await readFile(generatedStatePath);
    const restarted = new Store(generatedStatePath);
    await restarted.load();
    assert.deepEqual(await readFile(generatedStatePath), beforeReload, "the generated state is already migration-complete");
    const preparedRoot = join(directory, "prepared-previews", registered.preview.id, digest);
    await sameBytes(stateUrl, beforeReload);
    await sameBytes(snapshotUrl, Buffer.from(`${JSON.stringify(restarted.snapshot(after(240)), null, 2)}\n`));
    await sameBytes(bundleUrl, bundle);
    await sameBytes(paxBundleUrl, paxBundle);
    await sameBytes(manifestUrl, await readFile(join(preparedRoot, "manifest.json")));
    await sameBytes(indexUrl, await readFile(join(preparedRoot, "content", "site", "index.html")));
    await sameBytes(scriptUrl, await readFile(join(preparedRoot, "content", "site", "app.js")));
  } finally {
    Date.now = originalNow;
    Math.random = originalRandom;
    await rm(directory, { recursive: true, force: true });
  }
}

await generate();
