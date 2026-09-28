import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { artifactMaximumBytes } from "@coffee-shop/protocol";
import { canonicalWorkingRoot, captureLocalArtifact } from "./localArtifact.js";

const argumentsValue = {
  threadId: "thread-one",
  relativePath: "reports/result.txt",
  title: "Result",
  kind: "report",
  mediaType: "text/plain",
  summary: "Ready",
  idempotencyKey: "result-one"
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "coffee-shop-local-artifact-"));
  await mkdir(join(root, "reports"));
  await writeFile(join(root, "reports", "result.txt"), "hello");
  return { root, canonical: await canonicalWorkingRoot(root) };
}

test("captures exact retained bytes, normalized metadata, size, and lowercase digest", async () => {
  const { canonical } = await fixture();
  const captured = await captureLocalArtifact(canonical, {
    ...argumentsValue,
    relativePath: "reports/../reports\\result.txt"
  });
  assert.equal(captured.bytes.toString(), "hello");
  assert.deepEqual(captured.registration, {
    ...argumentsValue,
    relativePath: "reports/result.txt",
    size: 5,
    sha256: createHash("sha256").update("hello").digest("hex")
  });
});

test("allows an intermediate symlink that resolves inside and rejects every escape", async () => {
  const { root, canonical } = await fixture();
  await symlink(join(root, "reports"), join(root, "inside"), "dir");
  assert.equal((await captureLocalArtifact(canonical, { ...argumentsValue, relativePath: "inside/result.txt" })).bytes.toString(), "hello");

  const outside = await mkdtemp(join(tmpdir(), "coffee-shop-local-artifact-outside-"));
  await writeFile(join(outside, "secret.txt"), "secret");
  await symlink(outside, join(root, "outside"), "dir");
  for (const relativePath of ["", "/etc/passwd", "C:\\secret.txt", "C:secret.txt", "../secret.txt", "outside/secret.txt", "reports/secret\0.txt"]) {
    await assert.rejects(captureLocalArtifact(canonical, { ...argumentsValue, relativePath }), (error: unknown) => {
      assert.doesNotMatch(String(error), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    });
  }
});

test("rejects final symlinks, directories, and a final-component replacement", async () => {
  const { root, canonical } = await fixture();
  await symlink(join(root, "reports", "result.txt"), join(root, "reports", "linked.txt"));
  await assert.rejects(captureLocalArtifact(canonical, { ...argumentsValue, relativePath: "reports/linked.txt" }), /regular file|symbolic link/);
  await assert.rejects(captureLocalArtifact(canonical, { ...argumentsValue, relativePath: "reports" }), /regular file/);

  await writeFile(join(root, "reports", "replace.txt"), "original");
  await assert.rejects(captureLocalArtifact(canonical, { ...argumentsValue, relativePath: "reports/replace.txt" }, {
    beforeOpen: async () => {
      await writeFile(join(root, "replacement.txt"), "replacement");
      const { rename, unlink } = await import("node:fs/promises");
      await unlink(join(root, "reports", "replace.txt"));
      await symlink(join(root, "replacement.txt"), join(root, "reports", "replace.txt"));
    }
  }), (error: NodeJS.ErrnoException) => error.code === "ELOOP" || /symbolic link/.test(error.message));

  await writeFile(join(root, "reports", "replace-regular.txt"), "original");
  await assert.rejects(captureLocalArtifact(canonical, { ...argumentsValue, relativePath: "reports/replace-regular.txt" }, {
    beforeOpen: async () => {
      const { unlink } = await import("node:fs/promises");
      await unlink(join(root, "reports", "replace-regular.txt"));
      await writeFile(join(root, "reports", "replace-regular.txt"), "replacement");
    }
  }), /changed while it was being opened/);
});

test("rejects a FIFO before open instead of blocking on the special file", async () => {
  const { root, canonical } = await fixture();
  const fifo = join(root, "reports", "pipe");
  execFileSync("mkfifo", [fifo]);
  await assert.rejects(captureLocalArtifact(canonical, { ...argumentsValue, relativePath: "reports/pipe" }), /regular file/);
});

test("accepts zero bytes and exactly 10 MiB, but reads only one byte beyond the limit", async () => {
  const { root, canonical } = await fixture();
  await writeFile(join(root, "empty"), Buffer.alloc(0));
  await writeFile(join(root, "boundary"), Buffer.alloc(artifactMaximumBytes, 7));
  await writeFile(join(root, "oversize"), Buffer.alloc(artifactMaximumBytes + 1, 7));
  assert.equal((await captureLocalArtifact(canonical, { ...argumentsValue, relativePath: "empty" })).bytes.length, 0);
  assert.equal((await captureLocalArtifact(canonical, { ...argumentsValue, relativePath: "boundary" })).bytes.length, artifactMaximumBytes);
  await assert.rejects(captureLocalArtifact(canonical, { ...argumentsValue, relativePath: "oversize" }), /at most 10 MiB/);
});

test("rejects preview bundles and undeclared or malformed tool fields before file access", async () => {
  const { canonical } = await fixture();
  const rejected = [
    { ...argumentsValue, kind: "preview-bundle" },
    { ...argumentsValue, kind: "unknown" },
    { ...argumentsValue, title: "" },
    { ...argumentsValue, idempotencyKey: "" },
    { ...argumentsValue, extra: true }
  ];
  for (const value of rejected) await assert.rejects(captureLocalArtifact(canonical, value), /arguments|kind|title|idempotencyKey/);
});

test("the platform exposes no-follow, required for final-component safety", () => {
  assert.equal(typeof constants.O_NOFOLLOW, "number");
});
