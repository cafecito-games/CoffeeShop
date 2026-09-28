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
import { beginProcessing, expireDuePreviews, registerPreview, registerPreviewForSource, settleProcessing } from "../src/artifactPreviews.js";
import { claimArtifactUploadGrant } from "../src/artifactUploadGrants.js";
import { templateFromLegacyAgent } from "../src/agentTemplates.js";
import { createExternalThreadInState } from "../src/externalOrchestrators.js";
import { externalSource } from "../src/mailbox.js";
import { ingestArtifactContent } from "../src/previewPreparation.js";
import { PreviewStorage } from "../src/previewStorage.js";
import { Store } from "../src/store.js";

const at = "2026-09-27T12:00:00.000Z";
const after = (seconds: number) => new Date(Date.parse(at) + seconds * 1_000).toISOString();
const stateUrl = new URL("./state-with-artifact-preview.json", import.meta.url);
const snapshotUrl = new URL("../../web/src/test/fixtures/hubPreviewSnapshot.json", import.meta.url);
const externalSnapshotUrl = new URL("../../web/src/test/fixtures/hubExternalPreviewSnapshot.json", import.meta.url);
const bundleUrl = new URL("./preview-v1/bundle.tar.gz", import.meta.url);
const bridgeBundleUrl = new URL("./preview-v1/bridge-bundle.tar.gz", import.meta.url);
const bridgeRegistrationUrl = new URL("./preview-v1/bridge-registration.json", import.meta.url);
const paxBundleUrl = new URL("./preview-v1/pax-bundle.tar.gz", import.meta.url);
const manifestUrl = new URL("./preview-v1/manifest.json", import.meta.url);
const indexUrl = new URL("./preview-v1/content/site/index.html", import.meta.url);
const scriptUrl = new URL("./preview-v1/content/site/app.js", import.meta.url);
const workflowResultsUrl = new URL("./preview-workflow-results.json", import.meta.url);
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
    const imported = templateFromLegacyAgent(agent);
    assert.equal(imported.ok, true);
    const seed = async (target: Store) => {
      await target.load();
      await target.transact((state) => {
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
    };
    const store = new Store(generatedStatePath);
    const storage = new PreviewStorage(directory);
    await seed(store);
    const request = {
      relativePath: ".coffee-shop/previews/site.tar.gz", title: "Site preview",
      kind: previewBundleArtifactKind, mediaType: previewBundleMediaType, summary: "Static site",
      size: bundle.length, sha256: digest, entrypoint: "site/index.html",
      ttlSeconds: 24 * 60 * 60, idempotencyKey: "preview-one"
    };
    const registered = await registerPreview(store, run.id, request, at);

    // These are exact replay results from the authoritative lifecycle producer. The only direct
    // state write supplies the same uploaded precondition the ingestion route owns; every preview
    // transition and every serialized result comes from artifactPreviews.ts.
    const fixtureSequence = sequence;
    const workflowStore = new Store(join(directory, "workflow-state.json"));
    await seed(workflowStore);
    const workflowRegistered = await registerPreview(workflowStore, run.id, request, at);
    const workflowResults: Record<string, unknown> = { "upload-pending": workflowRegistered };
    await workflowStore.transact((state) => {
      const artifact = state.artifacts?.find((candidate) => candidate.id === workflowRegistered.artifact.id);
      assert.ok(artifact);
      artifact.uploaded = true;
    });
    workflowResults["upload-pending-replayed"] = await registerPreview(workflowStore, run.id, request, after(30));
    const processing = await beginProcessing(workflowStore, workflowRegistered.preview.id, after(60));
    workflowResults.processing = await registerPreview(workflowStore, run.id, request, after(61));
    await settleProcessing(workflowStore, {
      previewId: workflowRegistered.preview.id, artifactId: workflowRegistered.artifact.id, artifactSha256: digest,
      processingGeneration: processing.generation, outcome: "ready", at: after(120)
    });
    workflowResults.ready = await registerPreview(workflowStore, run.id, request, after(121));

    const failedRequest = { ...request, relativePath: ".coffee-shop/previews/failed.tar.gz", idempotencyKey: "preview-failed" };
    const failedRegistered = await registerPreview(workflowStore, run.id, failedRequest, after(130));
    await workflowStore.transact((state) => {
      const artifact = state.artifacts?.find((candidate) => candidate.id === failedRegistered.artifact.id);
      assert.ok(artifact);
      artifact.uploaded = true;
    });
    const failedProcessing = await beginProcessing(workflowStore, failedRegistered.preview.id, after(140));
    await settleProcessing(workflowStore, {
      previewId: failedRegistered.preview.id, artifactId: failedRegistered.artifact.id, artifactSha256: digest,
      processingGeneration: failedProcessing.generation, outcome: "failed", failureCode: "bundle-invalid", at: after(150)
    });
    workflowResults.failed = await registerPreview(workflowStore, run.id, failedRequest, after(151));

    const expiredRequest = {
      ...request, relativePath: ".coffee-shop/previews/expired.tar.gz", idempotencyKey: "preview-expired", ttlSeconds: 5 * 60
    };
    const expiredRegistered = await registerPreview(workflowStore, run.id, expiredRequest, after(160));
    await workflowStore.transact((state) => {
      const artifact = state.artifacts?.find((candidate) => candidate.id === expiredRegistered.artifact.id);
      assert.ok(artifact);
      artifact.uploaded = true;
    });
    await expireDuePreviews(workflowStore, after(461));
    workflowResults.expired = await registerPreview(workflowStore, run.id, expiredRequest, after(462));
    await sameBytes(workflowResultsUrl, Buffer.from(`${JSON.stringify(workflowResults, null, 2)}\n`));
    sequence = fixtureSequence;
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

    // Producer provenance: orchestrator-bridge/src/generateLocalPreviewFixture.ts invokes the real
    // local packager, then these exact bytes traverse external registration, #60 grant claim,
    // immutable ingestion, preparation, persistence reload, and Store.snapshot().
    const externalRoot = join(directory, "external-preview");
    const externalStatePath = join(externalRoot, "state.json");
    const externalStore = new Store(externalStatePath);
    const externalStorage = new PreviewStorage(externalRoot);
    await externalStore.load();
    const connectionId = "connection-external-preview-fixture";
    const externalClientId = "orchestrator-client-external-preview-fixture";
    let externalThreadId = "";
    await externalStore.transact((state) => {
      // Credential minting has its own cryptographic producer fixtures. This fixed valid stored
      // principal keeps this preview fixture deterministic while registration still resolves it
      // through the same live external CallerSource authority as production.
      state.orchestratorClients = [{
        id: externalClientId,
        name: "Christian's laptop",
        scopes: ["orchestrate"],
        secretHash: `sha256:${"0".repeat(64)}`,
        createdAt: at
      }];
      const creation = createExternalThreadInState(state, {
        clientId: externalClientId,
        connectionId,
        title: "External preview",
        objective: "Review a preview published by an external orchestrator"
      }, at);
      externalThreadId = creation.thread.id;
      // `newEvent` reads the wall clock rather than this producer's injected operation clock.
      // Pin that display-only field so the checked fixture remains reproducible.
      const creationEvent = state.events.find((event) => event.threadId === externalThreadId && event.title === "Thread created");
      assert.ok(creationEvent);
      creationEvent.createdAt = at;
    });
    const bridgeBundle = await readFile(bridgeBundleUrl);
    const bridgeRegistration = JSON.parse(await readFile(bridgeRegistrationUrl, "utf8")) as Record<string, unknown>;
    const { threadId: _fixtureThreadId, ...externalRequest } = bridgeRegistration;
    const externalRegistered = await registerPreviewForSource(
      externalStore,
      externalSource(connectionId, externalThreadId),
      externalRequest,
      at
    );
    assert.ok(externalRegistered.uploadGrant);
    assert.equal(await claimArtifactUploadGrant(
      externalStore,
      externalRegistered.artifact.id,
      externalRegistered.uploadGrant.token,
      after(1)
    ), true);
    const externalTimes = [after(60), after(120)];
    await ingestArtifactContent(externalStore, externalStorage, {
      artifactId: externalRegistered.artifact.id,
      contentType: "application/octet-stream",
      body: Readable.from([bridgeBundle]),
      now: () => externalTimes.shift() ?? after(120)
    });
    const externalRestarted = new Store(externalStatePath);
    await externalRestarted.load();
    const externalSnapshot = externalRestarted.snapshot(after(240));
    assert.equal(externalSnapshot.artifactPreviews?.[0].sourceKey, `orchestrator-client:${externalClientId}`);
    await sameBytes(externalSnapshotUrl, Buffer.from(`${JSON.stringify(externalSnapshot, null, 2)}\n`));
  } finally {
    Date.now = originalNow;
    Math.random = originalRandom;
    await rm(directory, { recursive: true, force: true });
  }
}

await generate();
