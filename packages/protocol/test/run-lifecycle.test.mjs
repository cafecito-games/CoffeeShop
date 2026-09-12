import assert from "node:assert/strict";
import test from "node:test";
import {
  activeRunStatuses,
  canTransitionRun,
  isActiveRunStatus,
  isTerminalRunStatus,
  runStatuses,
  terminalRunStatuses
} from "../dist/index.js";

test("run status vocabulary and canonical transitions stay aligned", () => {
  assert.deepEqual(runStatuses, ["queued", "running", "completed", "failed", "cancelled"]);
  assert.deepEqual(activeRunStatuses, ["queued", "running"]);
  assert.deepEqual(terminalRunStatuses, ["completed", "failed", "cancelled"]);
  assert.equal(isActiveRunStatus("queued"), true);
  assert.equal(isTerminalRunStatus("cancelled"), true);
  assert.equal(canTransitionRun("queued", "running"), true);
  assert.equal(canTransitionRun("queued", "cancelled"), true);
  assert.equal(canTransitionRun("running", "completed"), true);
  assert.equal(canTransitionRun("running", "failed"), true);
  for (const terminal of terminalRunStatuses) {
    for (const next of runStatuses) assert.equal(canTransitionRun(terminal, next), false);
  }
});
