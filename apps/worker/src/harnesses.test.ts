import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertWorkspaceAllowed } from "./harnesses.js";

test("allows a canonical workspace within an enrolled root", async () => {
  const root = await mkdtemp(join(tmpdir(), "coffee-shop-root-"));
  const workspace = join(root, "project");
  await mkdir(workspace);
  assert.equal(await assertWorkspaceAllowed(workspace, [root]), await realpath(workspace));
});

test("rejects a workspace outside enrolled roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "coffee-shop-root-"));
  const other = await mkdtemp(join(tmpdir(), "coffee-shop-other-"));
  await assert.rejects(() => assertWorkspaceAllowed(other, [root]), /outside this worker's allowed roots/);
});
