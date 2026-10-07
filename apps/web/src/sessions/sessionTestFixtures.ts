import type { HostHarnessSession, Snapshot } from "@coffee-shop/protocol";

export const sessionFixture = (overrides: Partial<HostHarnessSession> = {}): HostHarnessSession => ({
  hostHarnessSessionId: "host-session-one", nodeId: "node-one", harnessId: "codex-cli",
  providerSessionId: "provider-one", workspace: "/srv/coffee", source: "provider-history",
  status: "idle", controlMode: "resume", operations: ["attach", "read-history"], revision: 2,
  attachmentEpoch: 0, summary: "Repair the grinder", createdAt: "2026-10-06T10:00:00Z",
  updatedAt: "2026-10-06T11:00:00Z", ...overrides
});

export const sessionsSnapshot = (sessions: HostHarnessSession[] = [sessionFixture()]): Snapshot => ({
  agents: [], nodes: [{
    id: "node-one", name: "Roastery", kind: "local", platform: "linux", status: "online",
    lastSeen: "2026-10-06T11:00:00Z", activeRuns: 0, concurrency: 2, workspaceRoots: ["/srv"],
    harnesses: [], version: "test"
  }], runs: [], events: [], messages: [], threads: [], hostHarnessSessions: sessions,
  hostSessionInventoryRevision: 1,
  generatedAt: "2026-10-06T11:00:00Z"
});
