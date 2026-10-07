import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ComputeNode,
  HostHarnessSessionInventoryComplete,
  HostHarnessSessionInventoryPage,
  HostHarnessSessionObservation
} from "@coffee-shop/protocol";
import { HostSessionInventoryAuthority } from "./hostSessionInventory.js";
import { Store } from "./store.js";

export const hostSessionTestNode: ComputeNode = {
  id: "node-one", name: "Node", kind: "local", platform: "linux-amd64", status: "online",
  lastSeen: "2026-10-06T12:00:00Z", activeRuns: 0, concurrency: 1, workspaceRoots: ["/workspace"],
  harnesses: [], version: "test"
};

export const hostSessionTestObservation = (overrides: Partial<HostHarnessSessionObservation> = {}): HostHarnessSessionObservation => ({
  hostHarnessSessionId: "host-session-one", nodeId: hostSessionTestNode.id, harnessId: "codex-cli",
  providerSessionId: "provider-thread-one", workspace: "/workspace/project", source: "provider-history",
  status: "idle", controlMode: "resume", operations: ["attach", "read-history"], revision: 1,
  summary: "Existing thread", createdAt: "2026-10-06T10:00:00Z", updatedAt: "2026-10-06T10:00:00Z",
  ...overrides
});

export const hostSessionTestPage = (
  generation = 1,
  sessions = [hostSessionTestObservation()]
): HostHarnessSessionInventoryPage => ({
  type: "host-session.inventory.page", nodeId: hostSessionTestNode.id, generation, pageIndex: 0, sessions,
  at: "2026-10-06T12:00:00Z"
});

export const hostSessionTestComplete = (generation = 1, sessionCount = 1): HostHarnessSessionInventoryComplete => ({
  type: "host-session.inventory.complete", nodeId: hostSessionTestNode.id, generation, pageCount: 1, sessionCount,
  at: "2026-10-06T12:00:01Z"
});

export async function hostSessionTestFixture() {
  const path = join(await mkdtemp(join(tmpdir(), "coffee-shop-host-sessions-")), "state.json");
  const store = new Store(path);
  await store.load();
  await store.transact((state) => { state.nodes.push(hostSessionTestNode); });
  const authority = new HostSessionInventoryAuthority(store);
  let current = true;
  const connection = {
    supportsCapability: true, isCurrent: () => current, nodeId: hostSessionTestNode.id, generation: 1
  };
  return { store, authority, connection, setCurrent: (value: boolean) => { current = value; }, path };
}

