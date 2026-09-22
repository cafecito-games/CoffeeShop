import assert from "node:assert/strict";
import test from "node:test";
import type {
  Agent,
  ComputeNode,
  ExecutionRequirements,
  HarnessProfile,
  HarnessTransport,
  HubToControlAgent,
  ProjectProfile,
  Run,
  RunTransportSelection,
  Task,
  Thread
} from "@coffee-shop/protocol";
import { acceptedTransportSelection, applyRunLifecycle } from "./lifecycle.js";
import { dispatchMessageFor, runSchedulingPass, type NodeConnection, type SchedulingContext } from "./scheduler.js";
import { taskContextProjection } from "./tasks.js";
import type { State } from "./store.js";

const at = "2026-09-21T12:00:00.000Z";

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id, name: id, title: id, summary: "", glyph: id[0].toUpperCase(),
    avatarShape: "cup", avatarColor: "amber", state: "idle", currentAction: "Available",
    harnessId: "codex-cli", model: "default", computeNodeId: `node-${id}`, workspace: `/workspace/${id}`,
    systemPrompt: "Work carefully", unread: 0, updatedAt: at, skills: [], ...overrides
  };
}

function harnessProfile(id: HarnessProfile["id"], overrides: Partial<HarnessProfile> = {}): HarnessProfile {
  return { id, label: id, description: "", available: true, authMode: "local-account", models: [], ...overrides };
}

function node(id: string, overrides: Partial<ComputeNode> = {}): ComputeNode {
  return {
    id, name: id, kind: "local", platform: "linux · amd64", status: "online", lastSeen: at, activeRuns: 0,
    concurrency: 2, workspaceRoots: ["/workspace"], version: "test",
    harnesses: [harnessProfile("codex-cli")],
    ...overrides
  };
}

function thread(id = "thread-one"): Thread {
  return { id, title: id, objective: id, summary: "", status: "active", ownerAgentId: "orchestrator", createdBy: "user", createdAt: at, updatedAt: at };
}

function task(id: string, requirements: ExecutionRequirements = {}, overrides: Partial<Task> = {}): Task {
  return {
    id, threadId: "thread-one", title: `Task ${id}`, instructions: `Do ${id}`, status: "ready", requirements,
    dependencies: [], idempotencyKey: "batch", attemptRunIds: [], createdAt: at, updatedAt: at, ...overrides
  };
}

function profile(id: string, overrides: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    schemaVersion: 1, id, name: id, workspacePolicy: { requireWritable: false },
    requirements: { hard: {} }, ...overrides
  };
}

function run(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id, agentId: "alpha", nodeId: "node-alpha", harnessId: "codex-cli", model: "default",
    workspace: "/workspace/alpha", prompt: "Work", status: "queued", output: "", depth: 0,
    createdAt: at, ...overrides
  };
}

function schedulingFixture(transports: readonly HarnessTransport[], requirements: ExecutionRequirements, profiles: ProjectProfile[] = []) {
  const state: State = {
    agents: [agent("alpha")],
    nodes: [node("node-alpha", { harnesses: [harnessProfile("codex-cli", { transports: [...transports] })] })],
    runs: [],
    events: [],
    messages: [],
    threads: [thread()],
    tasks: [task("one", requirements)]
  };
  const profilesById = new Map(profiles.map((item) => [item.id, item]));
  const context: SchedulingContext = {
    connection: () => ({ protocolVersion: "4", synced: true } satisfies NodeConnection),
    capabilityReport: () => undefined,
    projectProfile: (projectId) => profilesById.get(projectId),
    canDeliver: (_nodeId, message: HubToControlAgent) => message.type === "dispatch"
  };
  return { state, context };
}

test("transport selection prefers ACP and records the native CLI as the only possible fallback", () => {
  const cases: Array<{
    label: string;
    transports: readonly HarnessTransport[];
    requirements: ExecutionRequirements;
    profiles?: ProjectProfile[];
    expectedTransport: HarnessTransport;
    expectedFallbackTransport?: HarnessTransport;
  }> = [
    {
      label: "both advertised with no transport requirement",
      transports: ["native-cli", "acp-v1"],
      requirements: {},
      expectedTransport: "acp-v1",
      expectedFallbackTransport: "native-cli"
    },
    {
      label: "only ACP advertised",
      transports: ["acp-v1"],
      requirements: {},
      expectedTransport: "acp-v1"
    },
    {
      label: "only the native CLI advertised",
      transports: ["native-cli"],
      requirements: {},
      expectedTransport: "native-cli"
    },
    {
      label: "ACP required with both advertised",
      transports: ["native-cli", "acp-v1"],
      requirements: { transports: ["acp-v1"] },
      expectedTransport: "acp-v1"
    },
    {
      label: "native CLI required with both advertised",
      transports: ["native-cli", "acp-v1"],
      requirements: { transports: ["native-cli"] },
      expectedTransport: "native-cli"
    },
    {
      label: "project profile restricts hard transports to ACP",
      transports: ["native-cli", "acp-v1"],
      requirements: { projectProfileId: "proj" },
      profiles: [profile("proj", { requirements: { hard: { transports: ["acp-v1"] } } })],
      expectedTransport: "acp-v1"
    }
  ];
  for (const testCase of cases) {
    const { state, context } = schedulingFixture(testCase.transports, testCase.requirements, testCase.profiles ?? []);
    const result = runSchedulingPass(state, context, at);
    assert.equal(result.changed, true, testCase.label);
    const placedRun = state.runs.find((item) => item.taskId === "one");
    assert.ok(placedRun, testCase.label);
    assert.equal(placedRun.transport, testCase.expectedTransport, testCase.label);
    assert.equal(placedRun.fallbackTransport, testCase.expectedFallbackTransport, testCase.label);
    assert.equal("fallbackTransport" in placedRun, testCase.expectedFallbackTransport !== undefined, testCase.label);

    const dispatchAgent = state.agents.find((item) => item.id === "alpha")!;
    const dispatch = dispatchMessageFor(placedRun, dispatchAgent, state.agents);
    assert.ok(dispatch.execution, testCase.label);
    assert.equal(dispatch.execution.transport, testCase.expectedTransport, testCase.label);
    assert.equal(dispatch.execution.fallbackTransport, testCase.expectedFallbackTransport, testCase.label);
    assert.equal("fallbackTransport" in dispatch.execution, testCase.expectedFallbackTransport !== undefined, testCase.label);
  }
});

test("dispatchMessageFor carries an execution only for task attempts", () => {
  const alpha = agent("alpha");
  const plain = dispatchMessageFor(run("run-one"), alpha, [alpha]);
  assert.equal(plain.execution, undefined);

  const stray = dispatchMessageFor(
    run("run-two", { taskId: "task-one", attempt: 1, transport: "native-cli", fallbackTransport: "native-cli" }),
    alpha,
    [alpha]
  );
  assert.ok(stray.execution);
  assert.equal(stray.execution.transport, "native-cli");
  assert.equal(stray.execution.fallbackTransport, undefined);
  assert.equal("fallbackTransport" in stray.execution, false);
});

const acpReportedSelection = {
  requestedTransport: "acp-v1",
  selectedTransport: "acp-v1",
  adapter: { id: "codex-acp", version: "1.12.0", source: "setup-ledger" },
  acp: {
    protocolVersion: 1,
    loadSession: true,
    resumeSession: true,
    prompt: { image: true, audio: false, embeddedContext: true },
    mcp: { http: true, sse: false },
    adapterName: "@agentclientprotocol/codex-acp",
    adapterVersion: "1.12.0"
  }
} as const;

const nativeFallbackReportedSelection = {
  requestedTransport: "acp-v1",
  selectedTransport: "native-cli",
  fallbackReason: "acp-mcp-unavailable",
  harnessVersion: "0.154.0",
  adapter: { id: "codex-acp", version: "1.12.0", source: "administrator-override" }
} as const;

const acpRun = (overrides: Partial<Run> = {}) => run("run-one", { transport: "acp-v1", ...overrides });

test("acceptedTransportSelection admits only selections consistent with the dispatch", () => {
  assert.deepEqual(acceptedTransportSelection(acpRun(), acpReportedSelection), acpReportedSelection);
  assert.equal(acceptedTransportSelection(run("run-one"), acpReportedSelection), undefined, "requested would be native-cli");

  const nativeSelection = { requestedTransport: "native-cli", selectedTransport: "native-cli", harnessVersion: "0.154.0" };
  assert.deepEqual(acceptedTransportSelection(run("run-one"), nativeSelection), nativeSelection);

  assert.deepEqual(
    acceptedTransportSelection(acpRun({ fallbackTransport: "native-cli" }), nativeFallbackReportedSelection),
    nativeFallbackReportedSelection
  );
  assert.equal(acceptedTransportSelection(acpRun(), nativeFallbackReportedSelection), undefined, "run permitted no fallback");
  assert.equal(acceptedTransportSelection(run("run-one"), nativeFallbackReportedSelection), undefined, "run requested the native CLI");

  for (const malformed of [null, "acp-v1", {}, { requestedTransport: "acp-v1" }, { ...acpReportedSelection, surprise: 1 }]) {
    assert.equal(acceptedTransportSelection(acpRun(), malformed), undefined);
  }
});

function lifecycleState(runOverrides: Partial<Run> = {}): State {
  return {
    agents: [agent("alpha", { state: "thinking", currentAction: "Starting work" })],
    nodes: [node("node-alpha")],
    runs: [run("run-one", { status: "queued", ...runOverrides })],
    events: [],
    messages: []
  };
}

test("run.started records a consistent transport selection", () => {
  const current = lifecycleState({ transport: "acp-v1" });
  assert.equal(applyRunLifecycle(current, { type: "run.started", runId: "run-one", at, transport: acpReportedSelection }), true);
  assert.equal(current.runs[0].status, "running");
  assert.deepEqual(current.runs[0].transportSelection, acpReportedSelection);
  assert.equal(current.events.filter((event) => event.title.includes("transport")).length, 0);
});

test("run.started records the approval policy the run executed under", () => {
  const current = lifecycleState({ transport: "acp-v1" });
  const reported = { ...acpReportedSelection, approvalPolicy: "bypass" } as const;
  assert.equal(applyRunLifecycle(current, { type: "run.started", runId: "run-one", at, transport: reported }), true);
  assert.equal(current.runs[0].transportSelection?.approvalPolicy, "bypass");

  const unrecognized = lifecycleState({ transport: "acp-v1" });
  const malformed = { ...acpReportedSelection, approvalPolicy: "yolo" } as unknown as RunTransportSelection;
  assert.equal(applyRunLifecycle(unrecognized, { type: "run.started", runId: "run-one", at, transport: malformed }), true);
  const recorded = unrecognized.runs[0].transportSelection;
  assert.equal(recorded?.selectedTransport, acpReportedSelection.selectedTransport, "the rest of the selection is kept");
  assert.equal(recorded?.approvalPolicy, undefined);
  assert.equal(recorded?.approvalPolicyUnrecognized, true);
});

test("run.started announces a permitted fallback to the native CLI", () => {
  const current = lifecycleState({ transport: "acp-v1", fallbackTransport: "native-cli" });
  assert.equal(applyRunLifecycle(current, { type: "run.started", runId: "run-one", at, transport: nativeFallbackReportedSelection }), true);
  assert.equal(current.runs[0].status, "running");
  assert.deepEqual(current.runs[0].transportSelection, nativeFallbackReportedSelection);
  const event = current.events[0];
  assert.ok(event);
  assert.ok(event.title.includes("fell back to the native CLI"), event.title);
  assert.equal(event.runId, "run-one");
});

test("run.started starts the run even when its transport selection is inconsistent with the dispatch", () => {
  const current = lifecycleState({ transport: "acp-v1" });
  assert.equal(applyRunLifecycle(current, { type: "run.started", runId: "run-one", at, transport: nativeFallbackReportedSelection }), true);
  assert.equal(current.runs[0].status, "running");
  assert.equal(current.runs[0].transportSelection, undefined);
  const event = current.events[0];
  assert.ok(event);
  assert.ok(event.title.includes("unexpected transport"), event.title);
  assert.equal(event.runId, "run-one");
});

test("run.started without a transport reports leaves the selection unset", () => {
  const current = lifecycleState({ transport: "acp-v1" });
  assert.equal(applyRunLifecycle(current, { type: "run.started", runId: "run-one", at }), true);
  assert.equal(current.runs[0].status, "running");
  assert.equal(current.runs[0].transportSelection, undefined);
  assert.equal(current.events.length, 0);
});

test("task attempts project their transport and, once started, their selection", () => {
  const current: State = {
    agents: [agent("alpha")],
    nodes: [node("node-alpha")],
    runs: [
      run("run-attempt-one", { taskId: "task-one", attempt: 1, status: "queued" }),
      run("run-attempt-two", {
        taskId: "task-one", attempt: 2, status: "running", transport: "acp-v1",
        transportSelection: acpReportedSelection
      })
    ],
    events: [],
    messages: [],
    threads: [thread()],
    tasks: [task("one", {}, {
      id: "task-one",
      status: "assigned",
      attemptRunIds: ["run-attempt-one", "run-attempt-two"],
      assignment: { runId: "run-attempt-two", agentId: "alpha", nodeId: "node-alpha", harnessId: "codex-cli", transport: "acp-v1", model: "default", assignedAt: at }
    })]
  };
  const projection = taskContextProjection(current, "thread-one", "task-one");
  assert.deepEqual(projection.attempts.map((attempt) => attempt.runId), ["run-attempt-one", "run-attempt-two"]);
  assert.equal(projection.attempts[0].transport, "native-cli");
  assert.equal("transportSelection" in projection.attempts[0], false);
  assert.equal(projection.attempts[1].transport, "acp-v1");
  assert.deepEqual(projection.attempts[1].transportSelection, acpReportedSelection);
});

test("an ACP-only harness advertising adapter models accepts an agent with a concrete model", () => {
  const acpOnly = harnessProfile("codex-cli", { transports: ["acp-v1"], models: ["default", "gpt-5.5", "gpt-5.4"] });
  for (const model of ["gpt-5.5", "default"]) {
    const { state, context } = schedulingFixture(["acp-v1"], {});
    state.agents = [agent("alpha", { model })];
    state.nodes = [node("node-alpha", { harnesses: [acpOnly] })];
    runSchedulingPass(state, context, at);
    const placed = state.runs.find((item) => item.taskId === "one");
    assert.ok(placed, `an agent using ${model} is placed`);
    assert.equal(placed.model, model);
    assert.equal(placed.transport, "acp-v1");
  }

  const { state, context } = schedulingFixture(["acp-v1"], {});
  state.agents = [agent("alpha", { model: "gpt-9" })];
  state.nodes = [node("node-alpha", { harnesses: [acpOnly] })];
  runSchedulingPass(state, context, at);
  assert.equal(state.runs.length, 0, "a model the adapter does not offer is not placed");
});
