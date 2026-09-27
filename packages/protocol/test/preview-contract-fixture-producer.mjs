import { writeFileSync } from "node:fs";
import { previewBundleContract } from "../dist/index.js";

/** Writes the language-neutral contract bytes consumed by Barista and protocol tests. */
export function writePreviewContractFixture() {
  writeFileSync(
    new URL("./fixtures/preview-v1/limits.json", import.meta.url),
    `${JSON.stringify(previewBundleContract, null, 2)}\n`
  );
}

if (process.argv[1] === new URL(import.meta.url).pathname) writePreviewContractFixture();
