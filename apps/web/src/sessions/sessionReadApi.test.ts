import { describe, expect, it } from "vitest";
import { listAllHostSessions, parseHostSessionDetail, parseHostSessionHistory, parseHostSessionList, SessionReadError } from "./sessionReadApi.js";
import { sessionFixture } from "./sessionTestFixtures.js";

describe("session read API validation", () => {
  it("accepts correlated detail and bounded history", () => {
    const session = sessionFixture({ attachedThreadId: "thread-one", activeRunId: "run-one" });
    expect(parseHostSessionList({ sessions: [session], total: 1, revision: 1 }).sessions).toEqual([session]);
    expect(parseHostSessionDetail({ session, links: { threadId: "thread-one", runId: "run-one" } }, session).session).toEqual(session);
    expect(parseHostSessionHistory({
      hostHarnessSessionId: session.hostHarnessSessionId, nodeId: session.nodeId, harnessId: session.harnessId,
      providerSessionId: session.providerSessionId, workspace: session.workspace, revision: session.revision,
      items: [{ id: "item-one", kind: "assistant", text: "bounded", truncated: false }],
      stale: false, truncated: false, omitted: false, observedAt: "2026-10-06T11:00:00Z"
    }, session).items).toHaveLength(1);
    expect(parseHostSessionHistory({
      hostHarnessSessionId: session.hostHarnessSessionId, nodeId: session.nodeId, harnessId: session.harnessId,
      providerSessionId: session.providerSessionId, workspace: session.workspace, revision: session.revision - 1,
      items: [{ id: "item-stale", kind: "summary", text: "earlier", truncated: false }],
      stale: true, truncated: false, omitted: false, observedAt: "2026-10-06T10:00:00Z"
    }, session).stale).toBe(true);
  });

  it("rejects stale identity, undeclared fields, and secret canaries", () => {
    const session = sessionFixture();
    expect(() => parseHostSessionDetail({ session: { ...session, revision: 1 }, links: {} }, session)).toThrow(SessionReadError);
    expect(() => parseHostSessionDetail({ session: { ...session, revision: session.revision + 1 }, links: {} }, session)).toThrow(SessionReadError);
    expect(() => parseHostSessionDetail({ session, links: {}, rawConfig: {} }, session)).toThrow(SessionReadError);
    expect(() => parseHostSessionHistory({
      hostHarnessSessionId: session.hostHarnessSessionId, nodeId: session.nodeId, harnessId: session.harnessId,
      providerSessionId: session.providerSessionId, workspace: session.workspace, revision: session.revision,
      items: [{ id: "item-one", kind: "assistant", text: "Authorization: Bearer SECRET_CANARY", truncated: false }],
      stale: false, truncated: false, omitted: false
    }, session)).toThrow(SessionReadError);
  });

  it("reads ordered inventory pages to their declared total", async () => {
    const first = sessionFixture({ hostHarnessSessionId: "host-session-a", providerSessionId: "provider-a" });
    const second = sessionFixture({ hostHarnessSessionId: "host-session-b", providerSessionId: "provider-b" });
    const apiFetch = async (path: string) => new Response(JSON.stringify(path.includes("cursor=")
      ? { sessions: [second], total: 2, revision: 7 }
      : { sessions: [first], total: 2, revision: 7, nextCursor: first.hostHarnessSessionId }), { status: 200 });
    await expect(listAllHostSessions(apiFetch)).resolves.toEqual({ sessions: [first, second], total: 2, revision: 7 });
    expect(() => parseHostSessionList({ sessions: [second, first], total: 2, revision: 7 })).toThrow(SessionReadError);
  });

  it("finishes a moving inventory walk without requiring one global revision", async () => {
    const first = sessionFixture({ hostHarnessSessionId: "host-session-a", providerSessionId: "provider-a" });
    const second = sessionFixture({ hostHarnessSessionId: "host-session-b", providerSessionId: "provider-b" });
    let calls = 0;
    const apiFetch = async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({
        sessions: [first], total: 2, revision: 7, nextCursor: first.hostHarnessSessionId
      }), { status: 200 });
      return new Response(JSON.stringify({ sessions: [second], total: 2, revision: 8 }), { status: 200 });
    };
    await expect(listAllHostSessions(apiFetch, 7)).resolves.toEqual({ sessions: [first, second], total: 2, revision: 8 });
    expect(calls).toBe(2);
  });
});
