import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, ComputeNode, NodeCapabilityReport, Run, Thread } from "@coffee-shop/protocol";
import { createHubToolHandler, type HubToolEnvironment } from "./hubTools.js";
import { TaskEventWaiters } from "./mailbox.js";
import type { NodeConnection } from "./scheduler.js";
import { Store } from "./store.js";
import { applyAttemptOutcome, assignTaskAttempt } from "./tasks.js";

/*
 * Shared fixtures for hub tool tests. The default world has one active thread owned by the
 * `orchestrator` agent with a running root run, three worker agents, and a second thread whose
 * owner run must never see the first thread's tasks or messages.
 */

export const fixtureTime = "2026-09-13T12:00:00.000Z";

export function fixtureAgent(id: string, canDelegate = false, overrides: Partial<Agent> = {}): Agent {
  return {
    id, name: id, title: `${id} title`, summary: "", glyph: id[0].toUpperCase(),
    avatarShape: "cup", avatarColor: "amber", state: "idle", currentAction: "Available",
    harnessId: "codex-cli", model: "default", computeNodeId: `node-${id}`, workspace: `/workspace/${id}`,
    systemPrompt: `secret prompt for ${id}`, canDelegate, skills: [], unread: 0, updatedAt: fixtureTime, ...overrides
  };
}

export function fixtureNode(id: string, overrides: Partial<ComputeNode> = {}): ComputeNode {
  return {
    id, name: id, kind: "local", platform: "test", status: "online", lastSeen: fixtureTime, activeRuns: 0,
    concurrency: 2, workspaceRoots: ["/workspace"], version: "test",
    harnesses: [{ id: "codex-cli", label: "Codex", description: "", binary: "/usr/local/bin/codex", available: true, authMode: "local-account", models: ["default"] }],
    ...overrides
  };
}

export function fixtureThread(id: string, ownerAgentId = "orchestrator", status: Thread["status"] = "active"): Thread {
  return { id, title: id, objective: `Objective for ${id}`, summary: "", status, ownerAgentId, createdBy: "user", createdAt: fixtureTime, updatedAt: fixtureTime };
}

export function fixtureRun(id: string, threadId: string, agentId: string, overrides: Partial<Run> = {}): Run {
  return {
    id, threadId, agentId, nodeId: `node-${agentId}`, harnessId: "codex-cli", model: "default",
    workspace: `/workspace/${agentId}`, prompt: "Coordinate the work", status: "running", output: "",
    depth: 0, createdAt: fixtureTime, startedAt: fixtureTime, ...overrides
  };
}

/** Root run of the thread owner in `thread-one`. */
export const rootRunId = "run-root";
/** Owner run of `thread-two`, a different thread. */
export const foreignRunId = "run-foreign";

export async function orchestrationStore() {
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-hub-tools-"));
  const store = new Store(join(directory, "state.json"));
  await store.load();
  await store.transact((state) => {
    state.agents = [
      fixtureAgent("orchestrator", true),
      fixtureAgent("worker-a", true, { skills: ["go"] }),
      fixtureAgent("worker-b", false, { skills: ["typescript"] }),
      fixtureAgent("worker-c", false),
      fixtureAgent("foreign-owner", true)
    ];
    state.nodes = state.agents.map((agent) => fixtureNode(agent.computeNodeId));
    state.threads = [fixtureThread("thread-one"), fixtureThread("thread-two", "foreign-owner")];
    state.runs = [fixtureRun(rootRunId, "thread-one", "orchestrator"), fixtureRun(foreignRunId, "thread-two", "foreign-owner")];
  });
  return store;
}

/** Starts a task's next attempt as a running run of `agentId`, as the scheduler and lifecycle would. */
export async function startAttempt(store: Store, taskId: string, agentId: string, runId = `run-${taskId}-${agentId}`) {
  await store.transact((state) => {
    const task = state.tasks!.find((item) => item.id === taskId)!;
    const source = state.runs.find((run) => run.id === task.sourceRunId);
    const run: Run = fixtureRun(runId, task.threadId, agentId, {
      status: "queued", startedAt: undefined, depth: (source?.depth ?? 0) + 1, parentRunId: source?.id, prompt: task.instructions
    });
    assignTaskAttempt(state, taskId, run, fixtureTime);
    run.status = "running";
    run.startedAt = fixtureTime;
    applyAttemptOutcome(state, run.id, fixtureTime);
  });
  return runId;
}

export interface FixtureHandlerOptions {
  connections?: Record<string, NodeConnection>;
  reports?: Record<string, NodeCapabilityReport>;
  schedule?: () => Promise<void>;
  now?: () => string;
}

export function fixtureHandler(store: Store, options: FixtureHandlerOptions = {}) {
  const waiters = new TaskEventWaiters(store);
  let broadcasts = 0;
  let schedulingRequests = 0;
  const environment: HubToolEnvironment = {
    store,
    waiters,
    inventory: () => ({
      connection: (nodeId) => options.connections?.[nodeId],
      capabilityReport: (nodeId) => options.reports?.[nodeId]
    }),
    schedule: async () => {
      schedulingRequests += 1;
      await options.schedule?.();
    },
    broadcast: () => { broadcasts += 1; },
    now: options.now,
    schedulingWaitMilliseconds: 50
  };
  return {
    call: createHubToolHandler(environment),
    waiters,
    get broadcasts() { return broadcasts; },
    get schedulingRequests() { return schedulingRequests; }
  };
}

type JsonSchema = Record<string, unknown>;

const toolFixture = JSON.parse(readFileSync(new URL("../../../packages/protocol/test/fixtures/hub-tools/tools.json", import.meta.url), "utf8")) as Array<{
  name: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}>;

/** The tool definitions Barista lists, from the fixture its Go tests check. */
export function listedTool(name: string) {
  const tool = toolFixture.find((item) => item.name === name);
  if (!tool) throw new Error(`tool ${name} is not listed by Barista`);
  return tool;
}

export const listedToolNames = () => toolFixture.map((tool) => tool.name);

function typeMatches(type: string, value: unknown) {
  switch (type) {
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    case "integer": return Number.isSafeInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "null": return value === null;
    default: return false;
  }
}

/** Validates the JSON Schema subset Barista's tool schemas use; returns every violation found. */
export function schemaViolations(schema: JsonSchema, value: unknown, path = "$"): string[] {
  const violations: string[] = [];
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type as string[] : [schema.type as string];
    if (!types.some((type) => typeMatches(type, value))) return [`${path} is not ${types.join(" or ")}`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) violations.push(`${path} is not an allowed value`);
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) violations.push(`${path} is below its minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum) violations.push(`${path} is above its maximum`);
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, index) => violations.push(...schemaViolations(schema.items as JsonSchema, item, `${path}[${index}]`)));
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const key of (schema.required ?? []) as string[]) if (record[key] === undefined) violations.push(`${path}.${key} is required`);
    if (typeof schema.minProperties === "number" && Object.keys(record).length < schema.minProperties) violations.push(`${path} has too few properties`);
    for (const [key, entry] of Object.entries(record)) {
      if (properties[key]) violations.push(...schemaViolations(properties[key], entry, `${path}.${key}`));
      else if (schema.additionalProperties === false) violations.push(`${path}.${key} is not declared`);
    }
  }
  return violations;
}

/** Round-trips a hub result through JSON, as Barista forwards it, and validates it against the tool's output schema. */
export function outputViolations(name: string, result: unknown) {
  return schemaViolations(listedTool(name).outputSchema, JSON.parse(JSON.stringify(result)));
}

export function inputViolations(name: string, argumentsValue: unknown) {
  return schemaViolations(listedTool(name).inputSchema, argumentsValue);
}
