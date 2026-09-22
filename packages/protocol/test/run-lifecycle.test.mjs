import assert from "node:assert/strict";
import test from "node:test";
import {
  activeRunStatuses,
  canTransitionRun,
  delegationHubToolNames,
  harnessIds,
  hubToolNames,
  isActiveRunStatus,
  isHubToolName,
  isTerminalRunStatus,
  orchestrationToolLimits,
  runStatuses,
  taskMessageKinds,
  terminalRunStatuses,
  threadStatuses
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

test("agent harness identities remain a closed mutation vocabulary", () => {
  assert.deepEqual(harnessIds, ["claude-cli", "codex-cli", "shell", "ag-ui"]);
});

test("hub MCP tools remain a small stable vocabulary", () => {
  assert.deepEqual(hubToolNames, [
    "get_task_context", "delegate_task", "post_artifact", "update_thread",
    "get_execution_inventory", "submit_tasks", "send_task_message", "wait_for_task_events", "update_task"
  ]);
  assert.deepEqual(delegationHubToolNames, ["delegate_task", "get_execution_inventory", "submit_tasks"]);
  assert.ok(delegationHubToolNames.every(isHubToolName));
  assert.equal(isHubToolName("unknown_tool"), false);
  assert.deepEqual(threadStatuses, ["active", "completed", "archived"]);
});

test("hub tool vocabulary matches the fixture Barista is checked against", async () => {
  const { readFile } = await import("node:fs/promises");
  const vocabulary = JSON.parse(await readFile(new URL("./fixtures/hub-tools/vocabulary.json", import.meta.url), "utf8"));
  assert.deepEqual(vocabulary.toolNames, [...hubToolNames]);
  assert.deepEqual(vocabulary.delegationToolNames, [...delegationHubToolNames]);
  assert.deepEqual(vocabulary.taskMessageKinds, [...taskMessageKinds]);
  assert.equal(vocabulary.maximumWaitMilliseconds, orchestrationToolLimits.maximumWaitMilliseconds);
  assert.equal(vocabulary.maximumEventsPerWait, orchestrationToolLimits.maximumEventsPerWait);
});
