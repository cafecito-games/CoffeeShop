/*
 * Regenerates the hub-snapshot fixtures the PWA tests load.
 *
 *   pnpm exec tsx scripts/generate-web-snapshot-fixtures.mts
 *
 * The current fixture is whatever `Store.snapshot()` (apps/hub/src/store.ts) publishes for a state
 * built with the hub's own orchestration functions, so the PWA is tested against bytes the hub
 * actually emits. The legacy fixture is the same snapshot reduced to the fields the protocol
 * declared at commit 7334091 — the last commit before external orchestrators — which is what a hub
 * of that vintage publishes to a newer PWA.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent, ComputeNode, Run, Snapshot, Thread } from "../packages/protocol/src/index.js";
import { openApproval, resolveApprovalInState } from "../apps/hub/src/approvals.js";
import { attachThreadInState, createExternalThreadInState, postOperatorMessageInState } from "../apps/hub/src/externalOrchestrators.js";
import { mintOrchestratorClient } from "../apps/hub/src/orchestratorClients.js";
import { Store } from "../apps/hub/src/store.js";
import { newThread } from "../apps/hub/src/threads.js";

const legacyProtocolCommit = "7334091";
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDirectory = join(repositoryRoot, "apps/web/src/test/fixtures");

const node: ComputeNode = {
  id: "node-workshop", name: "Workshop", kind: "home-server", platform: "darwin · arm64", status: "online",
  lastSeen: "2026-09-22T12:00:00.000Z", activeRuns: 1, concurrency: 2, workspaceRoots: ["/srv/workspaces"],
  harnesses: [{ id: "claude-cli", label: "Claude", description: "Claude Code", available: true, authMode: "local-subscription", models: ["sonnet"] }],
  version: "0.1.0+fixture"
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
  const legacy = Object.fromEntries(Object.entries(snapshot).filter(([key]) => snapshotKeys.has(key)));
  legacy.threads = (snapshot.threads ?? [])
    // A hub of that vintage has no external threads: every thread it publishes has an owner agent.
    .filter((thread) => thread.ownerAgentId !== undefined)
    .map((thread) => Object.fromEntries(Object.entries(thread).filter(([key]) => threadKeys.has(key))));
  return legacy;
}

const directory = await mkdtemp(join(tmpdir(), "coffee-shop-fixture-"));
const store = new Store(join(directory, "state.json"));
await store.load();

await store.transact((state) => {
  state.agents = [agent];
  state.nodes = [node];
  state.events = [];
  state.messages = [];

  const agentThread: Thread = newThread(agent.id, "Ship the login path", "user", "2026-09-22T12:00:00.000Z");
  (state.threads ??= []).push(agentThread);
  state.runs = [{ ...run, threadId: agentThread.id }];

  const orchestrating = mintOrchestratorClient(state, { name: "Christian's laptop", scopes: ["orchestrate", "resolve-approvals"] }, "2026-09-22T12:01:00.000Z");
  const retired = mintOrchestratorClient(state, { name: "Retired laptop", scopes: ["orchestrate"] }, "2026-09-22T11:00:00.000Z");
  const retiredRecord = state.orchestratorClients!.find((item) => item.id === retired.client.id)!;
  retiredRecord.revokedAt = "2026-09-22T11:30:00.000Z";

  const created = createExternalThreadInState(state, {
    clientId: orchestrating.client.id,
    connectionId: "connection-1",
    objective: "Rework the checkout funnel",
    title: "Checkout funnel"
  }, "2026-09-22T12:02:00.000Z");
  attachThreadInState(state, { threadId: created.thread.id, clientId: orchestrating.client.id, connectionId: "connection-2" }, "2026-09-22T12:03:00.000Z");
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
    { kind: "orchestrator", clientId: orchestrating.client.id, attachmentId: created.attachment.id }
  );
  if (resolution.kind !== "resolved") throw new Error(`the fixture approval was not resolved: ${resolution.kind}`);
});

const snapshot = store.snapshot();
await mkdir(fixtureDirectory, { recursive: true });
await writeFile(join(fixtureDirectory, "hubSnapshot.json"), `${JSON.stringify(snapshot, undefined, 2)}\n`);
await writeFile(join(fixtureDirectory, "legacyHubSnapshot.json"), `${JSON.stringify(reduceToLegacyShape(snapshot), undefined, 2)}\n`);
console.log(`wrote fixtures to ${fixtureDirectory}`);
