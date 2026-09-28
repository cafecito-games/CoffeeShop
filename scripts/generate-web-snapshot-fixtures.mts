/*
 * Regenerates the hub-snapshot fixtures the PWA tests load.
 *
 *   pnpm --filter @coffee-shop/hub exec tsx ../../scripts/generate-web-snapshot-fixtures.mts
 *
 * The current fixture is whatever `Store.snapshot()` publishes from a real SQLite-backed Store
 * after the hub's own orchestration services build active, released, and lost instance history, so
 * the PWA is tested against bytes the hub actually emits. The legacy fixture is the same snapshot reduced to the fields the protocol
 * declared at commit 7334091 — the last commit before external orchestrators — which is what a hub
 * of that vintage publishes to a newer PWA.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent, AgentTemplate, ComputeNode, Run, Snapshot, Thread } from "../packages/protocol/src/index.js";
import { openApproval, resolveApprovalInState } from "../apps/hub/src/approvals.js";
import { applyComponentInventory } from "../apps/hub/src/componentInventories.js";
import { createArtifact } from "../apps/hub/src/coordination.js";
import { attachThreadInState, createExternalThreadInState, postOperatorMessageInState } from "../apps/hub/src/externalOrchestrators.js";
import { acceptInstanceWorkInState, applyInstanceLifecycle, applyNodeHeartbeatInState, flushPendingInstanceDeliveries, receiveInstanceLifecycleReport, reconcileNodeInstancesInState, reserveInstanceAllocation } from "../apps/hub/src/instances.js";
import { applyRunLifecycle } from "../apps/hub/src/lifecycle.js";
import { externalSource } from "../apps/hub/src/mailbox.js";
import { Store, type StoredOrchestratorClient } from "../apps/hub/src/store.js";
import { assignTaskAttempt, submitTaskBatchForSource } from "../apps/hub/src/tasks.js";
import { newThread } from "../apps/hub/src/threads.js";

const legacyProtocolCommit = "7334091";
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDirectory = join(repositoryRoot, "apps/web/src/test/fixtures");

// Hub identities intentionally include wall time and entropy in production. Pin both inputs only in
// this offline generator so a checked-in producer fixture has a stable byte-for-byte regeneration.
const fixtureEpoch = Date.parse("2026-09-28T12:00:00.000Z");
let fixtureIdentity = 0;
const RealDate = Date;
class ProducerFixtureDate extends RealDate {
  constructor(value?: string | number) {
    if (arguments.length === 0) super(fixtureEpoch + fixtureIdentity);
    else super(value as string);
  }

  static now() {
    return fixtureEpoch + fixtureIdentity;
  }
}
globalThis.Date = ProducerFixtureDate as DateConstructor;
Math.random = () => {
  fixtureIdentity += 1;
  return fixtureIdentity / 1_000_000;
};

const node: ComputeNode = {
  id: "node-workshop", name: "Workshop", kind: "home-server", platform: "darwin · arm64", status: "online",
  lastSeen: "2026-09-22T12:00:00.000Z", activeRuns: 1, concurrency: 2, instanceCapacity: 2, activeInstances: 0,
  workspaceRoots: ["/srv/workspaces"],
  harnesses: [{ id: "claude-cli", label: "Claude", description: "Claude Code", available: true, authMode: "local-subscription", models: ["sonnet"], transports: ["native-cli", "acp-v1"] }],
  version: "0.1.0+fixture"
};

const template: AgentTemplate = {
  id: "template-reviewer", name: "Reviewer", purpose: { title: "Reviewer", summary: "Reviews exact instance work" },
  avatarShape: "bean", avatarColor: "sky", instructions: "Review carefully", skills: ["coffeeshop-preview"], tags: ["quality"],
  requirements: { harnessIds: ["claude-cli"], models: ["sonnet"], transports: ["native-cli"] },
  delegation: { canDelegate: false }
};

const agent: Agent = {
  id: "milo", name: "Milo", title: "Builder", summary: "Builds things", glyph: "M", avatarShape: "cup",
  avatarColor: "amber", state: "working", currentAction: "Editing the login path", harnessId: "claude-cli",
  model: "sonnet", computeNodeId: node.id, workspace: "/srv/workspaces/login", systemPrompt: "Build",
  unread: 0, updatedAt: "2026-09-22T12:00:00.000Z"
};

const run: Run = {
  id: "run-login", agentId: agent.id, nodeId: node.id, harnessId: "claude-cli", model: "sonnet",
  workspace: "/srv/workspaces/login", prompt: "Ship the login path", status: "running", output: "", depth: 0,
  threadId: "", createdAt: "2026-09-22T12:00:00.000Z"
};

/** The keys an interface declared at a given commit, read from the protocol source at that commit. */
function declaredKeys(name: string): Set<string> {
  const source = execFileSync("git", ["show", `${legacyProtocolCommit}:packages/protocol/src/index.ts`], { cwd: repositoryRoot, encoding: "utf8" });
  const body = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(source);
  if (body === null) throw new Error(`interface ${name} is not declared at ${legacyProtocolCommit}`);
  return new Set([...body[1].matchAll(/^\s{2}(\w+)\??:/gm)].map((match) => match[1]));
}

function reduceToLegacyShape(snapshot: Snapshot): Record<string, unknown> {
  const snapshotKeys = declaredKeys("Snapshot");
  const threadKeys = declaredKeys("Thread");
  const nodeKeys = declaredKeys("ComputeNode");
  const harnessKeys = declaredKeys("HarnessProfile");
  const legacy = Object.fromEntries(Object.entries(snapshot).filter(([key]) => snapshotKeys.has(key)));
  legacy.threads = (snapshot.threads ?? [])
    // A hub of that vintage has no external threads: every thread it publishes has an owner agent.
    .filter((thread) => thread.ownerAgentId !== undefined)
    .map((thread) => Object.fromEntries(Object.entries(thread).filter(([key]) => threadKeys.has(key))));
  legacy.nodes = snapshot.nodes.map((node) => {
    const reduced = Object.fromEntries(Object.entries(node).filter(([key]) => nodeKeys.has(key)));
    reduced.harnesses = node.harnesses.map((harness) => Object.fromEntries(Object.entries(harness).filter(([key]) => harnessKeys.has(key))));
    return reduced;
  });
  return legacy;
}

const directory = await mkdtemp(join(tmpdir(), "coffee-shop-fixture-"));
const store = new Store({
  databasePath: join(directory, "coffee-shop.sqlite"),
  legacyJsonPath: join(directory, "state.json")
});
await store.load();
let externalThreadId = "";

await store.transact((state) => {
  state.agents = [agent];
  state.nodes = [node];
  state.events = [];
  state.messages = [];
  state.templates = [template];
  const inventory = applyComponentInventory(state, {
    nodeId: node.id, observedAt: "2026-09-22T12:00:00.000Z", components: [{
      kind: "acp-adapter", id: "claude-acp", harnessId: "claude-cli", declaredVersion: "2.0.0",
      installedVersions: ["1.0.0", "2.0.0"], activeVersion: "1.0.0", rollbackVersion: "2.0.0",
      updateVersion: "2.0.0", rollbackAvailable: true, provenance: "managed", readiness: "ready",
      diagnosticCodes: ["rollback-available", "update-available"]
    }, {
      kind: "capability-pack", id: "coffee-shop-default", declaredVersion: "1.0.0", installedVersions: [],
      rollbackAvailable: false, provenance: "none", readiness: "not-applicable", diagnosticCodes: []
    }]
  });
  if (!inventory.changed) throw new Error(`the fixture component inventory was not accepted: ${inventory.kind}`);

  const agentThread: Thread = newThread(agent.id, "Ship the login path", "user", "2026-09-22T12:00:00.000Z");
  (state.threads ??= []).push(agentThread);
  state.runs = [{ ...run, threadId: agentThread.id }];

  const orchestrating: StoredOrchestratorClient = {
    id: "orchestrator-client-fixture-active", name: "Christian's laptop", scopes: ["orchestrate", "resolve-approvals"],
    secretHash: `sha256:${"1".repeat(64)}`, createdAt: "2026-09-22T12:01:00.000Z"
  };
  const retired: StoredOrchestratorClient = {
    id: "orchestrator-client-fixture-retired", name: "Retired laptop", scopes: ["orchestrate"],
    secretHash: `sha256:${"2".repeat(64)}`, createdAt: "2026-09-22T11:00:00.000Z", revokedAt: "2026-09-22T11:30:00.000Z"
  };
  state.orchestratorClients = [orchestrating, retired];

  const created = createExternalThreadInState(state, {
    clientId: orchestrating.id,
    connectionId: "connection-1",
    objective: "Rework the checkout funnel",
    title: "Checkout funnel"
  }, "2026-09-22T12:02:00.000Z");
  externalThreadId = created.thread.id;
  attachThreadInState(state, { threadId: created.thread.id, clientId: orchestrating.id, connectionId: "connection-2" }, "2026-09-22T12:03:00.000Z");
  postOperatorMessageInState(state, { threadId: created.thread.id, body: "Please prioritize the login path" }, "2026-09-22T12:04:00.000Z");

  const conflict = openApproval(state, state.runs[0], {
    type: "permission.requested",
    approvalId: "acp-permission-1",
    title: "Write to config.json",
    detail: "The harness wants to edit config.json",
    options: [
      { id: "opt-once", label: "Allow once", kind: "allow-once" },
      { id: "opt-reject", label: "Reject", kind: "reject-once" }
    ],
    at: "2026-09-22T12:05:00.000Z"
  }, "2026-09-22T12:05:00.000Z");
  if (conflict !== undefined) throw new Error(conflict);
  const approvalId = state.approvals![0].id;
  const resolution = resolveApprovalInState(
    state,
    approvalId,
    { idempotencyKey: "fixture-resolution", expectedStatus: "pending", optionId: "opt-once" },
    "2026-09-22T12:06:00.000Z",
    { kind: "orchestrator", clientId: orchestrating.id, attachmentId: created.attachment.id }
  );
  if (resolution.kind !== "resolved") throw new Error(`the fixture approval was not resolved: ${resolution.kind}`);
});

const fixtureOperator = { kind: "operator" as const, operatorId: "fixture-generator" };
const lifecycle = await applyInstanceLifecycle(store, fixtureOperator, {
  operation: "create",
  threadId: externalThreadId,
  idempotency: { caller: fixtureOperator, key: "fixture-instance" },
  purpose: { name: "Checkout Reviewer", title: "Reviewer", summary: "Reviews the checkout funnel", instructions: "private fixture instructions" },
  requirements: { templateId: template.id, skills: ["coffeeshop-preview"], harnessIds: ["claude-cli"], models: ["sonnet"], transports: ["native-cli"] },
  idleTimeoutSeconds: 1800
}, "2026-09-22T12:07:00.000Z");
const reservation = await reserveInstanceAllocation(store, lifecycle.instance.id, {
  nodeId: node.id, harnessId: "claude-cli", model: "sonnet", transport: "native-cli", workspace: "/srv/workspaces",
  expectedCapabilityPack: { id: "coffeeshop-capability-pack", version: "1.2.0", requiredSkills: ["coffeeshop-preview"] }
}, "2026-09-22T12:07:01.000Z");
if (reservation.kind !== "reserved") throw new Error(`fixture instance was not reserved: ${reservation.kind}`);
await flushPendingInstanceDeliveries(store, () => true);
const ready = await receiveInstanceLifecycleReport(store, node.id, {
  type: "instance.ready", instanceId: lifecycle.instance.id, allocationId: reservation.allocation.id,
  at: "2026-09-22T12:07:02.000Z"
}, "2026-09-22T12:07:02.000Z");
if (ready.kind !== "accepted") throw new Error(`fixture instance was not ready: ${ready.reason}`);

const taskBatch = await submitTaskBatchForSource(store, externalSource("connection-2", externalThreadId), {
  idempotencyKey: "fixture-exact-task",
  tasks: [{ key: "review", title: "Review checkout", instructions: "Review the exact active allocation", requirements: lifecycle.instance.requirements }]
}, "2026-09-22T12:07:03.000Z", {
  placementOverrides: { review: { instanceId: lifecycle.instance.id, authorizedBy: "operator" } }
});
await store.transact((state) => {
  if (acceptInstanceWorkInState(state, lifecycle.instance.id, "2026-09-22T12:07:04.000Z") === undefined) {
    throw new Error("the fixture instance refused exact work");
  }
  const exactRun: Run = {
    id: "run-instance-review", instanceId: lifecycle.instance.id, allocationId: reservation.allocation.id,
    nodeId: node.id, harnessId: reservation.allocation.harnessId, model: reservation.allocation.model,
    transport: reservation.allocation.transport, workspace: reservation.allocation.workspace,
    prompt: "Review the exact active allocation", status: "queued", output: "", depth: 0,
    threadId: externalThreadId, taskId: taskBatch.tasks[0].id, createdAt: "2026-09-22T12:07:04.000Z"
  };
  assignTaskAttempt(state, taskBatch.tasks[0].id, exactRun, "2026-09-22T12:07:04.000Z");
  applyRunLifecycle(state, { type: "run.started", runId: exactRun.id, at: "2026-09-22T12:07:05.000Z", transport: {
    requestedTransport: "native-cli", selectedTransport: "native-cli",
    effectiveCapabilityPack: {
      id: "coffeeshop-capability-pack",
      version: "1.2.0",
      skills: ["coffeeshop-artifacts", "coffeeshop-coordination", "coffeeshop-preview", "coffeeshop-task-reporting"]
    }
  } });
});

async function fixtureAllocation(
  key: string,
  at: string
) {
  const created = await applyInstanceLifecycle(store, fixtureOperator, {
    operation: "create", threadId: externalThreadId,
    idempotency: { caller: fixtureOperator, key },
    purpose: { name: `${key} fixture` }, requirements: { harnessIds: ["claude-cli"], models: ["sonnet"], transports: ["acp-v1"] },
    idleTimeoutSeconds: 1800
  }, at);
  const allocated = await reserveInstanceAllocation(store, created.instance.id, {
    nodeId: node.id, harnessId: "claude-cli", model: "sonnet", transport: "acp-v1", workspace: "/srv/workspaces"
  }, new Date(Date.parse(at) + 1_000).toISOString());
  if (allocated.kind !== "reserved") throw new Error(`${key} fixture was not reserved: ${allocated.kind}`);
  await flushPendingInstanceDeliveries(store, () => true);
  const outcome = await receiveInstanceLifecycleReport(store, node.id, {
    type: "instance.ready", instanceId: created.instance.id, allocationId: allocated.allocation.id,
    at: new Date(Date.parse(at) + 2_000).toISOString()
  }, new Date(Date.parse(at) + 2_000).toISOString());
  if (outcome.kind !== "accepted") throw new Error(`${key} fixture was not ready: ${outcome.reason}`);
  return { lifecycle: created, allocation: allocated.allocation };
}

const releasedFixture = await fixtureAllocation("released-instance", "2026-09-22T12:08:00.000Z");
await applyInstanceLifecycle(store, fixtureOperator, {
  operation: "release", threadId: externalThreadId, instanceId: releasedFixture.lifecycle.instance.id,
  idempotency: { caller: fixtureOperator, key: "released-instance-command" }, mode: "drain"
}, "2026-09-22T12:08:03.000Z");
await flushPendingInstanceDeliveries(store, () => true);
const released = await receiveInstanceLifecycleReport(store, node.id, {
  type: "instance.released", instanceId: releasedFixture.lifecycle.instance.id, allocationId: releasedFixture.allocation.id,
  at: "2026-09-22T12:08:04.000Z"
}, "2026-09-22T12:08:04.000Z");
if (released.kind !== "accepted") throw new Error(`released fixture did not settle: ${released.reason}`);

const lostFixture = await fixtureAllocation("lost-instance", "2026-09-22T12:09:00.000Z");
await store.transact((state) => {
  const reconciled = reconcileNodeInstancesInState(state, node.id, [lifecycle.instance.id], "2026-09-22T12:09:03.000Z");
  const heartbeat = applyNodeHeartbeatInState(state, node.id, 1, 1, "2026-09-22T12:09:04.000Z");
  return reconciled || heartbeat.capacityChanged;
});

// This fixture crosses every historical character-vs-byte boundary that Barista can send. Barista
// canonicalizes the opened path at apps/control-agent/internal/mcpserver/server.go:355 and forwards
// the remaining model-provided strings verbatim at server.go:290-292; createArtifact is the real Hub
// producer that trims, bounds, truncates, attributes, and persists the record.
const compatibilitySegment = "é".repeat(90);
const compatibilityArtifactArguments = {
  relativePath: [`${compatibilitySegment}\\literal`, ...Array.from({ length: 5 }, () => compatibilitySegment)].join("/"),
  title: "界".repeat(100),
  kind: "report",
  mediaType: `x/${"é".repeat(64)}`,
  summary: "é".repeat(2_001),
  size: 2,
  sha256: "a".repeat(64),
  idempotencyKey: "鍵".repeat(64)
};
const compatibilityArtifact = await createArtifact(store, run.id, compatibilityArtifactArguments, "2026-09-22T12:09:30.000Z");
const compatibilityReplay = await createArtifact(store, run.id, {
  ...compatibilityArtifactArguments,
  summary: "A changed retry summary"
}, "2026-09-22T12:09:31.000Z");
if (compatibilityReplay.artifact.id !== compatibilityArtifact.artifact.id
  || compatibilityReplay.artifact.summary !== "é".repeat(2_000)) {
  throw new Error("the legacy run artifact producer did not preserve its historical replay contract");
}

const snapshot = store.snapshot("2026-09-28T12:10:00.000Z");
if (snapshot.allocations?.find((item) => item.id === releasedFixture.allocation.id)?.status !== "released"
  || snapshot.allocations?.find((item) => item.id === lostFixture.allocation.id)?.status !== "lost") {
  throw new Error("the producer fixture did not retain released and lost allocation history");
}
if (snapshot.componentInventories?.length !== 1) throw new Error("the producer fixture did not publish component inventory");
await mkdir(fixtureDirectory, { recursive: true });
await writeFile(join(fixtureDirectory, "hubSnapshot.json"), `${JSON.stringify(snapshot, undefined, 2)}\n`);
await writeFile(join(fixtureDirectory, "legacyHubSnapshot.json"), `${JSON.stringify(reduceToLegacyShape(snapshot), undefined, 2)}\n`);
console.log(`wrote fixtures to ${fixtureDirectory}`);
