import assert from "node:assert/strict";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { captureLocalPreview } from "./localPreview.js";

const contentRoot = new URL("../../hub/test-fixtures/preview-v1/content/", import.meta.url);
const bundleUrl = new URL("../../hub/test-fixtures/preview-v1/bridge-bundle.tar.gz", import.meta.url);
const registrationUrl = new URL("../../hub/test-fixtures/preview-v1/bridge-registration.json", import.meta.url);
const check = process.argv.includes("--check");

export const localPreviewFixtureArguments = {
  threadId: "thread-external-preview",
  relativePath: "site",
  entrypoint: "index.html",
  title: "External preview",
  summary: "Packaged by the local orchestrator bridge",
  ttlSeconds: 3_600,
  idempotencyKey: "external-preview-fixture"
} as const;

async function exactFile(url: URL, expected: Buffer) {
  if (check) assert.deepEqual(await readFile(url), expected, `${fileURLToPath(url)} is stale`);
  else await writeFile(url, expected);
}

/** Generates the immutable bytes the real Bridge packager sends to the Hub ingestion path. */
async function generate() {
  const workingRoot = await realpath(contentRoot);
  const captured = await captureLocalPreview(workingRoot, localPreviewFixtureArguments);
  await exactFile(bundleUrl, captured.bytes);
  await exactFile(registrationUrl, Buffer.from(`${JSON.stringify(captured.registration, null, 2)}\n`));
}

await generate();
