import { describe, expect, it } from "vitest";
import { buildSessionsReadModel, emptySessionFilters } from "./sessionReadModel.js";
import { sessionFixture, sessionsSnapshot } from "./sessionTestFixtures.js";

describe("sessions read model", () => {
  it("sorts deterministically and applies every authoritative filter", () => {
    const older = sessionFixture({ hostHarnessSessionId: "host-session-b", updatedAt: "2026-10-06T10:00:00Z", status: "offline" });
    const newer = sessionFixture({ hostHarnessSessionId: "host-session-a", updatedAt: "2026-10-06T12:00:00Z", controlMode: "observe", operations: ["read-history"] });
    const model = buildSessionsReadModel({ snapshot: sessionsSnapshot([older, newer]), connection: "connected", selectedId: undefined,
      filters: { ...emptySessionFilters(), status: "offline", nodeId: "node-one", harnessId: "codex-cli", workspace: "/srv/coffee", source: "provider-history", controlMode: "resume" } });
    expect(model.sessions.map((session) => session.hostHarnessSessionId)).toEqual(["host-session-b"]);
  });

  it("keeps reconnect evidence explicitly stale and exposes empty control slots", () => {
    const model = buildSessionsReadModel({ snapshot: sessionsSnapshot(), connection: "reconnecting", filters: emptySessionFilters() });
    expect(model.stale).toBe(true);
    expect(model.controls).toEqual({});
  });

  it("never merges detail or history from a different immutable identity or revision", () => {
    const session = sessionFixture();
    const mismatched = sessionFixture({ revision: session.revision + 1 });
    const model = buildSessionsReadModel({ snapshot: sessionsSnapshot([session]), connection: "connected", filters: emptySessionFilters(),
      selectedId: session.hostHarnessSessionId, detail: { session: mismatched, links: {} }, history: {
        hostHarnessSessionId: session.hostHarnessSessionId, nodeId: session.nodeId, harnessId: session.harnessId,
        providerSessionId: session.providerSessionId, workspace: session.workspace, revision: mismatched.revision,
        items: [], stale: false, truncated: false, omitted: false
      } });
    expect(model.detail).toBeUndefined();
    expect(model.history).toBeUndefined();

    const stale = buildSessionsReadModel({ snapshot: sessionsSnapshot([session]), connection: "connected", filters: emptySessionFilters(),
      selectedId: session.hostHarnessSessionId, history: {
        hostHarnessSessionId: session.hostHarnessSessionId, nodeId: session.nodeId, harnessId: session.harnessId,
        providerSessionId: session.providerSessionId, workspace: session.workspace, revision: session.revision - 1,
        items: [{ id: "stale-item", kind: "summary", text: "Earlier history", truncated: false }],
        stale: true, truncated: false, omitted: false
      } });
    expect(stale.historyItems).toHaveLength(1);
    expect(stale.history?.stale).toBe(true);

    const ordered = buildSessionsReadModel({ snapshot: sessionsSnapshot([session]), connection: "connected", filters: emptySessionFilters(),
      selectedId: session.hostHarnessSessionId, history: {
        hostHarnessSessionId: session.hostHarnessSessionId, nodeId: session.nodeId, harnessId: session.harnessId,
        providerSessionId: session.providerSessionId, workspace: session.workspace, revision: session.revision,
        items: [
          { id: "newest-item", kind: "assistant", text: "Newest", truncated: false },
          { id: "older-item", kind: "user", text: "Older", truncated: false }
        ],
        stale: false, truncated: false, omitted: false
      } });
    expect(ordered.historyItems.map((item) => item.id)).toEqual(["older-item", "newest-item"]);
  });
});
