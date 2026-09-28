import assert from "node:assert/strict";
import test from "node:test";
import type {
  Agent,
  ComputeNode,
  ControlProtocolVersion,
  ExecutionRequirements,
  HarnessId,
  HarnessProfile,
  HarnessTransport,
  HubToControlAgent,
  NodeCapabilityEvidence,
  NodeCapabilityReport,
  PlacementRequirementKind,
  ProjectProfile,
  Run,
  Task,
  Thread,
  UnsatisfiedRequirement
} from "@coffee-shop/protocol";
import {
  isAuthorizedPlacementOverride,
  nodeUsage,
  placeTask,
  placementDiagnosticLimit,
  runSchedulingPass,
  type NodeConnection,
  type NodeUsage,
  type PlacementEnvironment,
  type SchedulingContext
} from "./scheduler.js";
import type { State } from "./store.js";

const at = "2026-09-21T12:00:00.000Z";
const staleObservedAt = "2026-09-21T11:29:00.000Z";
const futureObservedAt = "2026-09-21T12:05:00.000Z";

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id, name: id, title: id, summary: "", glyph: id[0].toUpperCase(),
    avatarShape: "cup", avatarColor: "amber", state: "idle", currentAction: "Available",
    harnessId: "codex-cli", model: "default", computeNodeId: `node-${id}`, workspace: `/workspace/${id}`,
    systemPrompt: "Work carefully", unread: 0, updatedAt: at, skills: [], ...overrides
  };
}

function harnessProfile(id: HarnessId, overrides: Partial<HarnessProfile> = {}): HarnessProfile {
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

function thread(id = "thread-one", overrides: Partial<Thread> = {}): Thread {
  return { id, title: id, objective: id, summary: "", status: "active", ownerAgentId: "orchestrator", createdBy: "user", createdAt: at, updatedAt: at, ...overrides };
}

function task(id: string, requirements: ExecutionRequirements = {}, overrides: Partial<Task> = {}): Task {
  return {
    id, threadId: "thread-one", title: `Task ${id}`, instructions: `Do ${id}`, status: "ready", requirements,
    dependencies: [], idempotencyKey: "batch", attemptRunIds: [], createdAt: at, updatedAt: at, ...overrides
  };
}

function evidence(capabilityId: string, normalizedValue: string, overrides: Partial<NodeCapabilityEvidence> = {}): NodeCapabilityEvidence {
  return { capabilityId, source: "runtime", success: true, normalizedValue, observedAt: at, ...overrides };
}

function report(nodeId: string, entries: NodeCapabilityEvidence[]): NodeCapabilityReport {
  return { nodeId, evidence: entries, at };
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

interface Fixture {
  state: State;
  connections: Map<string, NodeConnection>;
  reports: Map<string, NodeCapabilityReport>;
  profiles: Map<string, ProjectProfile>;
  refuseDelivery: Set<string>;
}

function fixture(agents: Agent[], nodes: ComputeNode[], tasks: Task[]): Fixture {
  const connections = new Map(nodes.map((item) => [item.id, { protocolVersion: "4" as ControlProtocolVersion, synced: true }]));
  return {
    state: { agents, nodes, runs: [], events: [], messages: [], threads: [thread()], tasks },
    connections,
    reports: new Map(),
    profiles: new Map(),
    refuseDelivery: new Set()
  };
}

function context(current: Fixture): SchedulingContext {
  return {
    connection: (nodeId) => current.connections.get(nodeId),
    capabilityReport: (nodeId) => current.reports.get(nodeId),
    projectProfile: (projectId) => current.profiles.get(projectId),
    canDeliver: (nodeId, message: HubToControlAgent) => !current.refuseDelivery.has(nodeId) && message.type === "dispatch"
  };
}

function environment(current: Fixture): PlacementEnvironment {
  return {
    agents: current.state.agents,
    nodes: current.state.nodes,
    runs: current.state.runs,
    connection: (nodeId) => current.connections.get(nodeId),
    capabilityReport: (nodeId) => current.reports.get(nodeId),
    projectProfile: (projectId) => current.profiles.get(projectId),
    now: at
  };
}

const taskById = (current: Fixture, id: string) => current.state.tasks!.find((item) => item.id === id)!;

const alphaEntry = (kind: PlacementRequirementKind, requirement: string, detail: string): UnsatisfiedRequirement =>
  ({ kind, requirement, nodeId: "node-alpha", agentId: "alpha", detail });

interface ConstraintCase {
  label: string;
  requirements: ExecutionRequirements;
  agentOverrides?: Partial<Agent>;
  nodeOverrides?: Partial<ComputeNode>;
  omitNode?: boolean;
  evidenceEntries?: NodeCapabilityEvidence[];
  profiles?: ProjectProfile[];
}

function constraintFixture(testCase: ConstraintCase): Fixture {
  const nodes = testCase.omitNode ? [] : [node("node-alpha", testCase.nodeOverrides ?? {})];
  const current = fixture([agent("alpha", testCase.agentOverrides ?? {})], nodes, [task("one", testCase.requirements)]);
  if (testCase.evidenceEntries !== undefined) current.reports.set("node-alpha", report("node-alpha", testCase.evidenceEntries));
  for (const projectProfile of testCase.profiles ?? []) current.profiles.set(projectProfile.id, projectProfile);
  return current;
}

test("every satisfied hard constraint assigns the task to the candidate", () => {
  const cases: Array<ConstraintCase & { expectedTransport?: HarnessTransport; expectedWorkspace?: string }> = [
    { label: "harness id matched", requirements: { harnessIds: ["codex-cli"] } },
    { label: "model matched", requirements: { models: ["default"] } },
    {
      label: "operating system matched case-insensitively",
      requirements: { operatingSystems: ["linux"] },
      evidenceEntries: [evidence("os", "Linux")]
    },
    {
      label: "architecture matched case-insensitively",
      requirements: { architectures: ["ARM64"] },
      evidenceEntries: [evidence("architecture", "arm64")]
    },
    { label: "label reported ok", requirements: { labels: ["gpu"] }, evidenceEntries: [evidence("label:gpu", "true")] },
    {
      label: "memory exactly at the minimum",
      requirements: { minimumMemoryMegabytes: 8192 },
      evidenceEntries: [evidence("configured-memory-megabytes", "8192")]
    },
    {
      label: "memory above the minimum",
      requirements: { minimumMemoryMegabytes: 8192 },
      evidenceEntries: [evidence("configured-memory-megabytes", "16384")]
    },
    { label: "concurrency exactly at the minimum", requirements: { minimumConcurrency: 2 } },
    {
      label: "acp transport advertised by the harness is chosen",
      requirements: { transports: ["acp-v1"] },
      nodeOverrides: { harnesses: [harnessProfile("codex-cli", { transports: ["acp-v1"] })] },
      expectedTransport: "acp-v1"
    },
    {
      label: "unknown advertised transport strings are ignored",
      requirements: {},
      nodeOverrides: { harnesses: [harnessProfile("codex-cli", { transports: ["carrier-pigeon", "acp-v1"] as unknown as HarnessTransport[] })] },
      expectedTransport: "acp-v1"
    },
    {
      label: "requested workspace path beneath the agent workspace",
      requirements: { workspace: { path: "/workspace/alpha/checkout", writable: false } },
      expectedWorkspace: "/workspace/alpha/checkout"
    },
    {
      label: "writable workspace evidence ok",
      requirements: { workspace: { writable: true } },
      evidenceEntries: [evidence("workspace-writable", "true")]
    },
    {
      label: "repository matching the profile repository",
      requirements: { projectProfileId: "proj", workspace: { repository: "https://example.com/repo.git", writable: false } },
      profiles: [profile("proj", { repository: { url: "https://example.com/repo.git", defaultBranch: "main" } })]
    },
    {
      label: "repository within the profile allowlist",
      requirements: { projectProfileId: "proj", workspace: { repository: "https://example.com/repo.git", writable: false } },
      profiles: [profile("proj", { workspacePolicy: { requireWritable: false, allowedRepositories: ["https://example.com/repo.git"] } })]
    }
  ];
  for (const testCase of cases) {
    const decision = placeTask(task("one", testCase.requirements), environment(constraintFixture(testCase)));
    assert.equal(decision.kind, "assigned", testCase.label);
    if (decision.kind !== "assigned") continue;
    assert.equal(decision.candidate.agentId, "alpha", testCase.label);
    assert.equal(decision.candidate.transport, testCase.expectedTransport ?? "native-cli", testCase.label);
    assert.equal(decision.candidate.workspace, testCase.expectedWorkspace ?? "/workspace/alpha", testCase.label);
    assert.deepEqual(decision.diagnostic, { evaluatedAt: at, eligibleNodeIds: ["node-alpha"], unsatisfied: [] }, testCase.label);
  }
});

test("every unmet hard constraint reports its exact unsatisfied entry", () => {
  const cases: Array<ConstraintCase & { expected: UnsatisfiedRequirement[] }> = [
    {
      label: "configured skill metadata is not readiness authority",
      requirements: { skills: ["rust"] },
      agentOverrides: { skills: ["rust"] },
      expected: [alphaEntry("skill", "rust", "configured agent metadata is not live capability pack readiness")]
    },
    {
      label: "different harness configured",
      requirements: { harnessIds: ["claude-cli"] },
      expected: [alphaEntry("harness", "claude-cli", "agent is configured with a different harness")]
    },
    {
      label: "different model configured",
      requirements: { models: ["gpt-5"] },
      expected: [alphaEntry("model", "gpt-5", "agent is configured with a different model")]
    },
    {
      label: "required transport not advertised",
      requirements: { transports: ["acp-v1"] },
      expected: [alphaEntry("transport", "acp-v1", "no transport the harness reports satisfies the requirement")]
    },
    {
      label: "harness advertising no transports",
      requirements: {},
      nodeOverrides: { harnesses: [harnessProfile("codex-cli", { transports: [] })] },
      expected: [alphaEntry("transport", "native-cli", "no transport the harness reports satisfies the requirement")]
    },
    {
      label: "harness not available on the node",
      requirements: {},
      nodeOverrides: { harnesses: [harnessProfile("codex-cli", { available: false })] },
      expected: [alphaEntry("harness", "codex-cli", "harness is not reported available on the compute node")]
    },
    {
      label: "compute node never registered",
      requirements: {},
      omitNode: true,
      expected: [alphaEntry("node-offline", "node-alpha", "compute node has never registered")]
    },
    {
      label: "operating system mismatch",
      requirements: { operatingSystems: ["darwin"] },
      evidenceEntries: [evidence("os", "linux")],
      expected: [alphaEntry("operating-system", "darwin", "worker-reported value does not match")]
    },
    {
      label: "architecture mismatch",
      requirements: { architectures: ["amd64"] },
      evidenceEntries: [evidence("architecture", "arm64")],
      expected: [alphaEntry("architecture", "amd64", "worker-reported value does not match")]
    },
    {
      label: "label without evidence",
      requirements: { labels: ["gpu"] },
      expected: [alphaEntry("label", "gpu", "no worker-reported evidence")]
    },
    {
      label: "memory below the minimum",
      requirements: { minimumMemoryMegabytes: 8192 },
      evidenceEntries: [evidence("configured-memory-megabytes", "4096")],
      expected: [alphaEntry("memory", "8192 MiB", "configured memory is below the minimum")]
    },
    {
      label: "memory without evidence",
      requirements: { minimumMemoryMegabytes: 8192 },
      expected: [alphaEntry("memory", "8192 MiB", "no worker-reported evidence")]
    },
    {
      label: "concurrency below the minimum",
      requirements: { minimumConcurrency: 3 },
      expected: [alphaEntry("concurrency", "3", "compute node reports lower concurrency")]
    },
    {
      label: "agent workspace outside every advertised root",
      requirements: {},
      agentOverrides: { workspace: "/elsewhere/alpha" },
      expected: [alphaEntry("workspace", "workspace beneath an advertised root", "agent workspace is not beneath a root the compute node advertises")]
    },
    {
      label: "requested path outside the agent workspace",
      requirements: { workspace: { path: "/workspace/beta/checkout", writable: false } },
      expected: [alphaEntry("workspace", "/workspace/beta/checkout", "requested path is not beneath the agent workspace and an advertised root")]
    },
    {
      label: "writable workspace evidence failed",
      requirements: { workspace: { writable: true } },
      evidenceEntries: [evidence("workspace-writable", "false", { success: false })],
      expected: [alphaEntry("workspace", "writable workspace", "worker-reported evidence failed")]
    },
    {
      label: "writable workspace evidence missing",
      requirements: { workspace: { writable: true } },
      expected: [alphaEntry("workspace", "writable workspace", "no worker-reported evidence")]
    },
    {
      label: "repository without an authorizing profile",
      requirements: { workspace: { repository: "https://example.com/repo.git", writable: false } },
      expected: [{ kind: "workspace", requirement: "repository https://example.com/repo.git", detail: "repository is not authorized by the task's project profile" }]
    },
    {
      label: "repository outside the profile allowlist",
      requirements: { projectProfileId: "proj", workspace: { repository: "https://example.com/second.git", writable: false } },
      profiles: [profile("proj", { workspacePolicy: { requireWritable: false, allowedRepositories: ["https://example.com/first.git"] } })],
      expected: [{ kind: "workspace", requirement: "repository https://example.com/second.git", detail: "repository is not authorized by the task's project profile" }]
    },
    {
      label: "unknown project profile",
      requirements: { projectProfileId: "ghost" },
      expected: [{ kind: "project-profile", requirement: "ghost", detail: "project profile is not loaded" }]
    },
    {
      label: "profile hard operating system unmet",
      requirements: { projectProfileId: "proj" },
      evidenceEntries: [evidence("os", "linux")],
      profiles: [profile("proj", { requirements: { hard: { operatingSystems: ["darwin"] } } })],
      expected: [alphaEntry("project-profile", "operating-system darwin", "reported value does not match")]
    },
    {
      label: "profile hard harness ids excluding the agent's harness",
      requirements: { projectProfileId: "proj" },
      profiles: [profile("proj", { requirements: { hard: { harnessIds: ["claude-cli"] } } })],
      expected: [
        alphaEntry("project-profile", "harness claude-cli", "agent is configured with a harness the project profile does not allow"),
        alphaEntry("project-profile", "harness claude-cli", "no available harness matches")
      ]
    }
  ];
  for (const testCase of cases) {
    const decision = placeTask(task("one", testCase.requirements), environment(constraintFixture(testCase)));
    assert.equal(decision.kind, "unsatisfied", testCase.label);
    assert.deepEqual(decision.diagnostic.eligibleNodeIds, [], testCase.label);
    assert.deepEqual(decision.diagnostic.unsatisfied, testCase.expected, testCase.label);
  }
});

test("evidence resolution states map to their diagnostic kinds and details", () => {
  const cases: Array<ConstraintCase & { expected: UnsatisfiedRequirement[] }> = [
    {
      label: "missing capability report",
      requirements: { operatingSystems: ["linux"] },
      expected: [alphaEntry("operating-system", "linux", "no worker-reported evidence")]
    },
    {
      label: "evidence older than the default thirty-minute window",
      requirements: { labels: ["gpu"] },
      evidenceEntries: [evidence("label:gpu", "true", { observedAt: staleObservedAt })],
      expected: [alphaEntry("inventory-stale", "gpu", "worker-reported evidence is stale")]
    },
    {
      label: "future-dated evidence beyond the clock-skew allowance",
      requirements: { labels: ["gpu"] },
      evidenceEntries: [evidence("label:gpu", "true", { observedAt: futureObservedAt })],
      expected: [alphaEntry("inventory-stale", "gpu", "worker-reported evidence is stale")]
    },
    {
      label: "ambiguous evidence from disagreeing sources",
      requirements: { operatingSystems: ["linux"] },
      evidenceEntries: [
        evidence("os", "linux", { source: "runtime" }),
        evidence("os", "darwin", { source: "configured" })
      ],
      expected: [alphaEntry("operating-system", "linux", "worker-reported evidence is ambiguous")]
    }
  ];
  for (const testCase of cases) {
    const decision = placeTask(task("one", testCase.requirements), environment(constraintFixture(testCase)));
    assert.equal(decision.kind, "unsatisfied", testCase.label);
    assert.deepEqual(decision.diagnostic.unsatisfied, testCase.expected, testCase.label);
  }
});

test("global diagnostics carry no node or agent identity", () => {
  const cases: Array<{ label: string; current: Fixture; expected: UnsatisfiedRequirement[] }> = [
    {
      label: "unauthorized placement override",
      current: fixture([agent("alpha")], [node("node-alpha")], [
        task("one", {}, { placementOverride: { agentId: "alpha", authorizedBy: "model" } as unknown as Task["placementOverride"] })
      ]),
      expected: [{ kind: "agent", requirement: "placement override", detail: "placement override is malformed or not authorized" }]
    },
    {
      label: "malformed placement override",
      current: fixture([agent("alpha")], [node("node-alpha")], [
        task("one", {}, { placementOverride: { agentId: "alpha", authorizedBy: "operator", reason: "pinning" } as unknown as Task["placementOverride"] })
      ]),
      expected: [{ kind: "agent", requirement: "placement override", detail: "placement override is malformed or not authorized" }]
    },
    {
      label: "unknown project profile",
      current: fixture([agent("alpha")], [node("node-alpha")], [task("one", { projectProfileId: "ghost" })]),
      expected: [{ kind: "project-profile", requirement: "ghost", detail: "project profile is not loaded" }]
    },
    {
      label: "repository without an authorizing profile",
      current: fixture([agent("alpha")], [node("node-alpha")], [task("one", { workspace: { repository: "https://example.com/repo.git", writable: false } })]),
      expected: [{ kind: "workspace", requirement: "repository https://example.com/repo.git", detail: "repository is not authorized by the task's project profile" }]
    },
    {
      label: "no configured agents",
      current: fixture([], [], [task("one")]),
      expected: [{ kind: "agent", requirement: "configured agent", detail: "no configured agent is a candidate" }]
    }
  ];
  for (const testCase of cases) {
    const decision = placeTask(taskById(testCase.current, "one"), environment(testCase.current));
    assert.equal(decision.kind, "unsatisfied", testCase.label);
    assert.deepEqual(decision.diagnostic.eligibleNodeIds, [], testCase.label);
    assert.deepEqual(decision.diagnostic.unsatisfied, testCase.expected, testCase.label);
  }
});

test("a combination of unmet constraints reports the full sorted deduplicated list", () => {
  const current = fixture(
    [agent("alpha"), agent("beta", { skills: ["rust"] })],
    [node("node-alpha"), node("node-beta")],
    [task("one", { skills: ["rust"], labels: ["gpu"] })]
  );
  current.connections.set("node-alpha", { protocolVersion: "3", synced: true });
  const decision = placeTask(taskById(current, "one"), environment(current));
  assert.equal(decision.kind, "unsatisfied");
  assert.deepEqual(decision.diagnostic, {
    evaluatedAt: at,
    eligibleNodeIds: [],
    unsatisfied: [
      { kind: "label", requirement: "gpu", nodeId: "node-alpha", agentId: "alpha", detail: "no worker-reported evidence" },
      { kind: "protocol-version", requirement: "control protocol version 4", nodeId: "node-alpha", agentId: "alpha", detail: "compute node registered a protocol version without task orchestration" },
      { kind: "skill", requirement: "rust", nodeId: "node-alpha", agentId: "alpha", detail: "configured agent metadata is not live capability pack readiness" },
      { kind: "label", requirement: "gpu", nodeId: "node-beta", agentId: "beta", detail: "no worker-reported evidence" },
      { kind: "skill", requirement: "rust", nodeId: "node-beta", agentId: "beta", detail: "configured agent metadata is not live capability pack readiness" }
    ]
  });
});

interface PreferenceCase {
  label: string;
  requirements: ExecutionRequirements;
  agents?: Agent[];
  nodes?: ComputeNode[];
  reports?: Record<string, NodeCapabilityEvidence[]>;
  profiles?: ProjectProfile[];
  expectedAgentId: string;
}

test("preferences rank otherwise equal candidates without excluding them", () => {
  const bothHarnesses = { harnesses: [harnessProfile("codex-cli"), harnessProfile("claude-cli")] };
  const cases: PreferenceCase[] = [
    {
      label: "preferred node id",
      requirements: { preferences: { nodeIds: ["node-beta"] } },
      expectedAgentId: "beta"
    },
    {
      label: "preferred harness id",
      requirements: { preferences: { harnessIds: ["claude-cli"] } },
      agents: [agent("alpha"), agent("beta", { harnessId: "claude-cli" })],
      nodes: [node("node-alpha", bothHarnesses), node("node-beta", bothHarnesses)],
      expectedAgentId: "beta"
    },
    {
      label: "preferred model",
      requirements: { preferences: { models: ["gpt-5"] } },
      agents: [agent("alpha"), agent("beta", { model: "gpt-5" })],
      nodes: ["node-alpha", "node-beta"].map((id) => node(id, { harnesses: [harnessProfile("codex-cli", { models: ["default", "gpt-5"] })] })),
      expectedAgentId: "beta"
    },
    {
      label: "preferred label reported ok",
      requirements: { preferences: { labels: ["gpu"] } },
      reports: { "node-beta": [evidence("label:gpu", "true")] },
      expectedAgentId: "beta"
    },
    {
      label: "unmet project profile preferences",
      requirements: { projectProfileId: "proj" },
      reports: { "node-beta": [evidence("label:cuda", "true")] },
      profiles: [profile("proj", { requirements: { hard: {}, preferred: { labels: ["cuda"] } } })],
      expectedAgentId: "beta"
    },
    {
      label: "preferred node that is ineligible does not block assignment",
      requirements: { labels: ["gpu"], preferences: { nodeIds: ["node-alpha"] } },
      reports: { "node-beta": [evidence("label:gpu", "true")] },
      expectedAgentId: "beta"
    }
  ];
  for (const testCase of cases) {
    const agents = testCase.agents ?? [agent("alpha"), agent("beta")];
    const nodes = testCase.nodes ?? [node("node-alpha"), node("node-beta")];
    const build = (candidateAgents: Agent[], candidateNodes: ComputeNode[]) => {
      const current = fixture(candidateAgents, candidateNodes, [task("one", testCase.requirements)]);
      for (const [nodeId, entries] of Object.entries(testCase.reports ?? {})) current.reports.set(nodeId, report(nodeId, entries));
      for (const projectProfile of testCase.profiles ?? []) current.profiles.set(projectProfile.id, projectProfile);
      return current;
    };
    const forwardDecision = placeTask(task("one", testCase.requirements), environment(build(agents, nodes)));
    const reversedDecision = placeTask(task("one", testCase.requirements), environment(build([...agents].reverse(), [...nodes].reverse())));
    assert.deepEqual(forwardDecision, reversedDecision, testCase.label);
    assert.equal(forwardDecision.kind, "assigned", testCase.label);
    if (forwardDecision.kind !== "assigned") continue;
    assert.equal(forwardDecision.candidate.agentId, testCase.expectedAgentId, testCase.label);
    assert.deepEqual(forwardDecision.diagnostic.unsatisfied, [], testCase.label);
  }
});

test("node utilization and identifiers break ties between eligible candidates", () => {
  const utilized = fixture([agent("alpha"), agent("beta")], [node("node-alpha"), node("node-beta")], [task("one")]);
  utilized.state.runs.push(run("run-reserved", { agentId: "agent-other", nodeId: "node-alpha", status: "queued" }));
  const utilizationDecision = placeTask(taskById(utilized, "one"), environment(utilized));
  assert.equal(utilizationDecision.kind, "assigned");
  assert.equal(utilizationDecision.kind === "assigned" && utilizationDecision.candidate.agentId, "beta");

  const tied = fixture([agent("beta"), agent("alpha")], [node("node-beta"), node("node-alpha")], [task("one")]);
  const tiedDecision = placeTask(taskById(tied, "one"), environment(tied));
  assert.equal(tiedDecision.kind, "assigned");
  if (tiedDecision.kind !== "assigned") return;
  assert.equal(tiedDecision.candidate.agentId, "alpha");
  assert.deepEqual(tiedDecision.diagnostic.eligibleNodeIds, ["node-alpha", "node-beta"]);
});

test("nodeUsage treats malformed concurrency as zero slots and malformed active runs as full", () => {
  const reserved = [
    run("run-queued", { nodeId: "node-a", status: "queued" }),
    run("run-running", { nodeId: "node-a", status: "running" }),
    run("run-finished", { nodeId: "node-a", status: "completed" }),
    run("run-elsewhere", { nodeId: "node-b", status: "queued" })
  ];
  const cases: Array<{ label: string; node: ComputeNode; runs: Run[]; expected: NodeUsage }> = [
    { label: "persisted reservations outweigh a lower heartbeat count", node: node("node-a", { concurrency: 4, activeRuns: 1 }), runs: reserved, expected: { concurrency: 4, used: 2 } },
    { label: "zero concurrency counts as zero slots", node: node("node-a", { concurrency: 0 }), runs: [], expected: { concurrency: 0, used: 0 } },
    { label: "negative concurrency counts as zero slots", node: node("node-a", { concurrency: -2 }), runs: [], expected: { concurrency: 0, used: 0 } },
    { label: "fractional concurrency counts as zero slots", node: node("node-a", { concurrency: 2.5 }), runs: [], expected: { concurrency: 0, used: 0 } },
    { label: "not-a-number concurrency counts as zero slots", node: node("node-a", { concurrency: Number.NaN }), runs: [], expected: { concurrency: 0, used: 0 } },
    { label: "negative active runs counts as full", node: node("node-a", { concurrency: 4, activeRuns: -1 }), runs: [], expected: { concurrency: 4, used: 4 } },
    { label: "not-a-number active runs counts as full", node: node("node-a", { concurrency: 4, activeRuns: Number.NaN }), runs: [], expected: { concurrency: 4, used: 4 } }
  ];
  for (const testCase of cases) {
    assert.deepEqual(nodeUsage(testCase.node, testCase.runs), testCase.expected, testCase.label);
  }
});

test("only operator- or policy-authorized overrides with declared keys are accepted", () => {
  const cases: Array<{ label: string; value: unknown; expected: boolean }> = [
    { label: "operator with agent id", value: { agentId: "alpha", authorizedBy: "operator" }, expected: true },
    { label: "operator with node id", value: { nodeId: "node-alpha", authorizedBy: "operator" }, expected: true },
    { label: "policy with both ids", value: { agentId: "alpha", nodeId: "node-alpha", authorizedBy: "policy" }, expected: true },
    { label: "missing authorizedBy", value: { agentId: "alpha" }, expected: false },
    { label: "model authorizer", value: { agentId: "alpha", authorizedBy: "model" }, expected: false },
    { label: "extra key", value: { agentId: "alpha", authorizedBy: "operator", reason: "pinning" }, expected: false },
    { label: "empty string agent id", value: { agentId: "", authorizedBy: "operator" }, expected: false },
    { label: "neither agent id nor node id", value: { authorizedBy: "operator" }, expected: false },
    { label: "null", value: null, expected: false },
    { label: "array", value: [{ agentId: "alpha", authorizedBy: "operator" }], expected: false }
  ];
  for (const testCase of cases) {
    assert.equal(isAuthorizedPlacementOverride(testCase.value), testCase.expected, testCase.label);
  }
});

test("an authorized override narrows candidates without bypassing hard requirements", () => {
  const narrowed = fixture([agent("alpha"), agent("beta")], [node("node-alpha"), node("node-beta")], [
    task("one", {}, { placementOverride: { nodeId: "node-beta", authorizedBy: "operator" } })
  ]);
  const narrowedDecision = placeTask(taskById(narrowed, "one"), environment(narrowed));
  assert.equal(narrowedDecision.kind, "assigned");
  if (narrowedDecision.kind === "assigned") {
    assert.equal(narrowedDecision.candidate.agentId, "beta");
    assert.deepEqual(narrowedDecision.diagnostic.eligibleNodeIds, ["node-beta"]);
  }

  const missing = fixture([agent("alpha")], [node("node-alpha")], [
    task("one", {}, { placementOverride: { agentId: "ghost", authorizedBy: "policy" } })
  ]);
  const missingDecision = placeTask(taskById(missing, "one"), environment(missing));
  assert.equal(missingDecision.kind, "unsatisfied");
  assert.deepEqual(missingDecision.diagnostic.unsatisfied, [
    { kind: "agent", requirement: "placement override", detail: "no configured agent is a candidate" }
  ]);
});

test("a version 3 node without harness transports reports protocol and label diagnostics", () => {
  const current = fixture([agent("alpha")], [node("node-alpha")], [task("one", { labels: ["gpu"] })]);
  current.connections.set("node-alpha", { protocolVersion: "3", synced: true });
  const decision = placeTask(taskById(current, "one"), environment(current));
  assert.equal(decision.kind, "unsatisfied");
  assert.deepEqual(decision.diagnostic.unsatisfied, [
    { kind: "label", requirement: "gpu", nodeId: "node-alpha", agentId: "alpha", detail: "no worker-reported evidence" },
    { kind: "protocol-version", requirement: "control protocol version 4", nodeId: "node-alpha", agentId: "alpha", detail: "compute node registered a protocol version without task orchestration" }
  ]);
});

test("the unsatisfied list is capped, sorted, and free of duplicates", () => {
  const total = placementDiagnosticLimit + 1;
  const agents = Array.from({ length: total }, (_, index) => agent(`agent-${String(index).padStart(3, "0")}`));
  const nodes = Array.from({ length: total }, (_, index) => node(`node-agent-${String(index).padStart(3, "0")}`));
  const current = fixture(agents, nodes, [task("one", { skills: ["rust"] })]);
  const decision = placeTask(taskById(current, "one"), environment(current));
  assert.equal(decision.kind, "unsatisfied");
  const entries = decision.diagnostic.unsatisfied;
  assert.equal(entries.length, placementDiagnosticLimit);
  const identities = entries.map((entry) => JSON.stringify([entry.nodeId ?? "", entry.agentId ?? "", entry.kind, entry.requirement, entry.detail]));
  for (let index = 1; index < identities.length; index += 1) {
    assert.ok(identities[index - 1] <= identities[index], `entry ${index - 1} must not sort after entry ${index}`);
  }
  assert.equal(new Set(identities).size, identities.length);
});

test("a task in a completed thread is never scheduled", () => {
  const current = fixture([agent("alpha")], [node("node-alpha")], [task("one")]);
  current.state.threads = [thread("thread-one", { status: "completed" })];
  const result = runSchedulingPass(current.state, context(current), at);
  assert.equal(result.changed, false);
  assert.deepEqual(result.attempts, []);
  assert.equal(current.state.runs.length, 0);
  assert.equal(taskById(current, "one").placement, undefined);
  assert.equal(taskById(current, "one").status, "ready");
});

test("a ready task waits while its dependency is still running", () => {
  const current = fixture([agent("alpha")], [node("node-alpha")], [
    task("one", {}, { dependencies: [{ taskId: "two", policy: "require-success" }] }),
    task("two", {}, {
      status: "running",
      assignment: { runId: "run-two", agentId: "alpha", nodeId: "node-alpha", harnessId: "codex-cli", transport: "native-cli", model: "default", assignedAt: at }
    })
  ]);
  current.state.runs.push(run("run-two", { taskId: "two", attempt: 1, status: "running" }));
  const result = runSchedulingPass(current.state, context(current), at);
  assert.equal(result.changed, false);
  assert.deepEqual(result.attempts, []);
  assert.equal(current.state.runs.length, 1);
  assert.equal(taskById(current, "one").placement, undefined);
  assert.equal(taskById(current, "one").status, "ready");
});

test("repeated passes do not rewrite an unchanged unsatisfiable placement", () => {
  const current = fixture([agent("alpha")], [node("node-alpha")], [task("one", { skills: ["rust"] })]);
  assert.equal(runSchedulingPass(current.state, context(current), at).changed, true);
  assert.equal(runSchedulingPass(current.state, context(current), futureObservedAt).changed, false);
  assert.equal(taskById(current, "one").placement?.evaluatedAt, at);
  assert.equal(taskById(current, "one").status, "ready");
});
