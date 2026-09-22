import assert from "node:assert/strict";
import test from "node:test";
import { orchestratorContinuationLimits as limits, sessionResumePromptMaximumBytes, type Task, type TaskMessage } from "@coffee-shop/protocol";
import { encodeTaskEventCursor } from "./mailbox.js";
import { boundedField, continuationDelivery, continuationPrompts, durableThreadContext, type ContinuationRange } from "./orchestratorContext.js";
import { fixtureTime, orchestrationStore } from "./hubToolsTestSupport.js";
import type { State } from "./store.js";
import type { TaskEventEntry } from "./taskEvents.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const byteLength = (value: string) => encoder.encode(value).length;

async function baseState() {
  const store = await orchestrationStore();
  return store.read((state) => structuredClone(state) as State);
}

const threadOne = (state: State) => state.threads!.find((thread) => thread.id === "thread-one")!;

function orchestratorMessage(sequence: number, body: string): TaskMessage {
  return {
    id: `brief-${String(sequence).padStart(3, "0")}`,
    threadId: "thread-one",
    sender: { type: "task", taskId: "task-a" },
    recipient: { type: "orchestrator" },
    sequence,
    kind: "note",
    body,
    idempotencyKey: `brief-key-${sequence}`,
    createdAt: fixtureTime
  };
}

function messageEntry(message: TaskMessage): TaskEventEntry {
  return { threadId: "thread-one", sequence: message.sequence, at: fixtureTime, kind: "message", messageId: message.id, recipientKey: "orchestrator" };
}

test("the delivery prompt stays within its byte budget while listing every event and acknowledging every message", async () => {
  const state = await baseState();
  const body = `Status update with multi-byte text: ${"é".repeat(1000)}${"漢".repeat(1000)}${"plain".repeat(400)}`;
  const messages = Array.from({ length: 50 }, (_, index) => orchestratorMessage(index + 1, body));
  state.taskMessages = messages;
  const range: ContinuationRange = {
    wakeId: "wake-bounds", generation: 1, fromSequence: 0, throughSequence: 50,
    events: messages.map(messageEntry), redelivery: false
  };
  const prompts = continuationPrompts(state, threadOne(state), range);
  const resumeBytes = byteLength(prompts.resumePrompt);
  assert.ok(resumeBytes <= limits.deliveryBytes, `resume prompt is ${resumeBytes} bytes`);
  assert.ok(resumeBytes <= sessionResumePromptMaximumBytes, `resume prompt is ${resumeBytes} bytes`);

  const listedSequences = new Set([...prompts.resumePrompt.matchAll(/sequence (\d+)/g)].map((match) => Number(match[1])));
  assert.deepEqual([...listedSequences].sort((left, right) => left - right), messages.map((message) => message.sequence));
  for (const message of messages) assert.equal(prompts.resumePrompt.includes(message.id), true, message.id);

  const acknowledgement = JSON.parse(/wait_for_task_events with (\{[^\n]+\})\./.exec(prompts.resumePrompt)![1]) as {
    cursor: string;
    timeoutMilliseconds: number;
    acknowledgeMessageIds: string[];
  };
  assert.equal(acknowledgement.cursor, encodeTaskEventCursor("thread-one", "orchestrator", 50));
  assert.equal(acknowledgement.timeoutMilliseconds, 0);
  assert.deepEqual(acknowledgement.acknowledgeMessageIds, messages.map((message) => message.id));

  const truncated = boundedField(body, limits.eventBodyBytes);
  assert.match(truncated, /\[truncated: \d+ of \d+ bytes shown\]$/);
  assert.equal(prompts.resumePrompt.includes(truncated), true, "a body that does not fit is shortened with its marker");
  for (const match of prompts.resumePrompt.matchAll(/\[truncated: (\d+) of (\d+) bytes shown\]/g)) {
    const kept = Number(match[1]);
    const total = Number(match[2]);
    assert.equal(total, byteLength(body));
    assert.ok(kept < total);
    assert.ok(kept > 0);
  }
  const markerIndex = prompts.resumePrompt.indexOf(" [truncated:");
  const lineStart = prompts.resumePrompt.lastIndexOf("\n  ", markerIndex) + 3;
  const keptText = prompts.resumePrompt.slice(lineStart, markerIndex);
  assert.equal(decoder.decode(encoder.encode(keptText)), keptText, "a truncated field never splits a multi-byte character");
  assert.ok(body.startsWith(keptText));
  assert.equal(byteLength(keptText), Number(/\[truncated: (\d+) of/.exec(prompts.resumePrompt)![1]));
});

test("the durable context lists only the most recent tasks within its byte budget", async () => {
  const state = await baseState();
  const total = 120;
  state.tasks = Array.from({ length: total }, (_, index) => ({
    id: `context-task-${String(index).padStart(3, "0")}`,
    threadId: "thread-one",
    title: "x".repeat(700),
    instructions: "",
    status: "ready",
    requirements: {},
    dependencies: [],
    idempotencyKey: `context-key-${index}`,
    attemptRunIds: [],
    result: "y".repeat(700),
    createdAt: new Date(Date.parse(fixtureTime) + index * 1_000).toISOString(),
    updatedAt: fixtureTime
  })) as Task[];
  const context = durableThreadContext(state, threadOne(state));
  assert.ok(byteLength(context) <= limits.contextBytes, `context is ${byteLength(context)} bytes`);
  const listed = [...context.matchAll(/context-task-(\d+)/g)].map((match) => Number(match[1]));
  assert.ok(listed.length >= 1);
  assert.ok(listed.length <= limits.contextTasks);
  for (const index of listed) assert.ok(index >= total - limits.contextTasks, `task ${index} is among the most recent`);
  for (let index = 0; index < total - limits.contextTasks; index += 1) {
    assert.equal(context.includes(`context-task-${String(index).padStart(3, "0")}`), false, `older task ${index} is excluded`);
  }
  for (let offset = 1; offset < listed.length; offset += 1) assert.ok(listed[offset - 1] < listed[offset], "tasks are oldest first");
  assert.match(context, /Tasks \(50 most recent of 120, oldest first\):/);
  assert.match(context, new RegExp(`- ${limits.contextTasks - listed.length} more tasks did not fit in this context\\.`));
});

test("rendering the same range twice is byte-identical", async () => {
  const state = await baseState();
  const messages = Array.from({ length: 3 }, (_, index) => orchestratorMessage(index + 1, `Note ${index + 1}`));
  state.taskMessages = messages;
  const range: ContinuationRange = {
    wakeId: "wake-determinism", generation: 3, fromSequence: 0, throughSequence: 3,
    events: messages.map(messageEntry), redelivery: false
  };
  const first = continuationPrompts(structuredClone(state), threadOne(state), range);
  const second = continuationPrompts(structuredClone(state), threadOne(state), range);
  assert.equal(first.prompt, second.prompt);
  assert.equal(first.resumePrompt, second.resumePrompt);
  assert.equal(first.prompt.endsWith(first.resumePrompt), true, "the full prompt is the durable context followed by the delivery");
});

test("a range that starts below the journal floor says those sequences were pruned", async () => {
  const state = await baseState();
  const messages = Array.from({ length: 6 }, (_, index) => orchestratorMessage(index + 5, `Note ${index + 5}`));
  state.taskMessages = messages;
  state.taskEventStreams = [{ threadId: "thread-one", head: 10, floor: 4 }];
  state.taskEventJournal = messages.map(messageEntry);
  const delivery = continuationDelivery(state, threadOne(state), {
    wakeId: "wake-pruned", generation: 1, fromSequence: 0, throughSequence: 10,
    events: messages.map(messageEntry), redelivery: false
  });
  assert.match(delivery, /Sequences after 0 through 4 were pruned before you acknowledged them/);
});
