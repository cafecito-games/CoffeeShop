import { approvalResolverKinds, type Agent, type ApprovalResolvedBy, type Artifact, type OrchestratorAttachment, type OrchestratorClient, type Thread } from "@coffee-shop/protocol";
import { describe, expect, it } from "vitest";
import { approvalResolverLabel, describeThreadOrchestrator, externalArtifactProducerLabel, sinceLabel } from "./orchestratorPresentation.js";

const agents: Agent[] = [
  {
    id: "agent-one", name: "Milo", title: "Builder", summary: "", glyph: "M", avatarShape: "cup", avatarColor: "amber",
    state: "idle", currentAction: "Waiting", harnessId: "claude-cli", model: "sonnet", computeNodeId: "node-one",
    workspace: "/workspace", systemPrompt: "", unread: 0, updatedAt: "2026-09-22T10:00:00Z"
  }
];

const clients: OrchestratorClient[] = [
  { id: "orchestrator-client-1", name: "Christian's laptop", scopes: ["orchestrate"], createdAt: "2026-09-22T09:00:00Z" }
];

function thread(overrides: Partial<Thread>): Thread {
  return {
    id: "thread-1", title: "Ship the login path", objective: "Ship it", summary: "", status: "active",
    createdBy: "user", createdAt: "2026-09-22T09:00:00Z", updatedAt: "2026-09-22T10:00:00Z", ...overrides
  };
}

function attachment(overrides: Partial<OrchestratorAttachment>): OrchestratorAttachment {
  return {
    id: "attachment-1", threadId: "thread-1", clientId: "orchestrator-client-1", connectionId: "connection-1",
    attachedAt: "2026-09-22T09:30:00Z", lastHeartbeatAt: "2026-09-22T09:40:00Z", status: "attached", ...overrides
  };
}

const now = Date.parse("2026-09-22T10:00:00Z");

describe("externalArtifactProducerLabel", () => {
  const artifact = {
    id: "artifact-one", threadId: "thread-1", sourceKey: "orchestrator-client:orchestrator-client-1",
    relativePath: "result.txt", title: "Result", kind: "report", mediaType: "text/plain", summary: "", size: 1,
    sha256: "a".repeat(64), downloadPath: "/api/artifacts/artifact-one/content", uploaded: true,
    idempotencyKey: "result", createdAt: "2026-09-22T10:00:00Z"
  } satisfies Artifact;

  it("uses the current client name", () => {
    expect(externalArtifactProducerLabel(artifact, clients)).toBe("Christian's laptop");
  });

  it("bounds the fallback identity for a historical client", () => {
    const historical = { ...artifact, sourceKey: `orchestrator-client:${"x".repeat(80)}` };
    const label = externalArtifactProducerLabel(historical, []);
    expect(label).toMatch(/^Unknown orchestrator x+…$/);
    expect(label!.length).toBeLessThan(60);
  });
});

describe("describeThreadOrchestrator", () => {
  it("names the orchestrating agent for an agent thread", () => {
    const described = describeThreadOrchestrator(thread({ orchestrator: { kind: "agent", agentId: "agent-one" } }), { agents, clients, attachments: [], now });
    expect(described).toMatchObject({ kind: "agent", name: "Milo", detail: "", attached: false });
  });

  it("derives the agent from ownerAgentId when a pre-migration snapshot has no orchestrator", () => {
    const described = describeThreadOrchestrator(thread({ ownerAgentId: "agent-one" }), { agents, clients, attachments: [], now });
    expect(described).toMatchObject({ kind: "agent", name: "Milo" });
  });

  it("falls back to the agent id when the agent is not in the snapshot", () => {
    const described = describeThreadOrchestrator(thread({ ownerAgentId: "agent-gone" }), { agents, clients, attachments: [], now });
    expect(described).toMatchObject({ kind: "agent", name: "agent-gone" });
  });

  it("reports a thread with neither an orchestrator nor an owner agent as unassigned", () => {
    const described = describeThreadOrchestrator(thread({}), { agents, clients, attachments: [], now });
    expect(described).toMatchObject({ kind: "unknown", name: "Unassigned", attached: false });
  });

  it("names the client and reports an attached external orchestrator", () => {
    const described = describeThreadOrchestrator(
      thread({ orchestrator: { kind: "external", clientId: "orchestrator-client-1" } }),
      { agents, clients, attachments: [attachment({})], now }
    );
    expect(described).toMatchObject({ kind: "external", name: "Christian's laptop", detail: "Attached", attached: true, clientId: "orchestrator-client-1" });
  });

  it("names a host session by a bounded opaque identity without inferring attachment state", () => {
    const described = describeThreadOrchestrator(
      thread({ orchestrator: { kind: "host-session", hostHarnessSessionId: "h".repeat(80) } }),
      { agents, clients, attachments: [attachment({})], now }
    );
    expect(described).toEqual({
      kind: "host-session",
      name: `Host session ${"h".repeat(31)}…`,
      detail: "",
      attached: false
    });
  });

  it.each([
    ["detached" as const, "2026-09-22T09:45:00Z", "Detached since 15m ago"],
    ["replaced" as const, "2026-09-21T10:00:00Z", "Detached since 1d ago"]
  ])("reports how long a %s external orchestrator has been away", (status, detachedAt, expected) => {
    const described = describeThreadOrchestrator(
      thread({ orchestrator: { kind: "external", clientId: "orchestrator-client-1" } }),
      { agents, clients, attachments: [attachment({ status, detachedAt })], now }
    );
    expect(described).toMatchObject({ detail: expected, attached: false });
  });

  it("prefers a live attachment over an older ended one", () => {
    const described = describeThreadOrchestrator(
      thread({ orchestrator: { kind: "external", clientId: "orchestrator-client-1" } }),
      {
        agents,
        clients,
        attachments: [
          attachment({ id: "attachment-0", status: "replaced", detachedAt: "2026-09-22T09:20:00Z" }),
          attachment({ id: "attachment-1", status: "attached" })
        ],
        now
      }
    );
    expect(described).toMatchObject({ detail: "Attached", attached: true });
  });

  it("says an external thread was never attached when no attachment exists", () => {
    const described = describeThreadOrchestrator(
      thread({ orchestrator: { kind: "external", clientId: "orchestrator-client-1" } }),
      { agents, clients, attachments: [], now }
    );
    expect(described).toMatchObject({ detail: "Never attached", attached: false });
  });

  it("names an external client that is missing from the snapshot without crashing", () => {
    const described = describeThreadOrchestrator(
      thread({ orchestrator: { kind: "external", clientId: "orchestrator-client-gone" } }),
      { agents, clients: [], attachments: [], now }
    );
    expect(described).toMatchObject({ kind: "external", name: "Unknown client orchestrator-client-gone" });
  });

  it("ignores attachments that belong to another thread", () => {
    const described = describeThreadOrchestrator(
      thread({ orchestrator: { kind: "external", clientId: "orchestrator-client-1" } }),
      { agents, clients, attachments: [attachment({ threadId: "thread-other" })], now }
    );
    expect(described).toMatchObject({ detail: "Never attached", attached: false });
  });
});

describe("sinceLabel", () => {
  it.each([
    ["2026-09-22T09:59:30Z", "moments ago"],
    ["2026-09-22T09:30:00Z", "30m ago"],
    ["2026-09-22T07:00:00Z", "3h ago"],
    ["2026-09-20T10:00:00Z", "2d ago"],
    ["not a timestamp", "an unreported time"]
  ])("renders %s as %s", (timestamp, expected) => {
    expect(sinceLabel(timestamp, now)).toBe(expected);
  });
});

describe("approvalResolverLabel", () => {
  it("renders nothing for an unresolved approval", () => {
    expect(approvalResolverLabel(undefined, clients)).toBeUndefined();
  });

  // Every resolver kind the protocol declares has exactly one operator-facing label, and no label
  // may leave an operator thinking a model's decision was their own.
  it.each(approvalResolverKinds)("labels the %s resolver kind", (kind) => {
    const resolvedBy = kind === "orchestrator"
      ? { kind, clientId: "orchestrator-client-1", attachmentId: "attachment-1" } as ApprovalResolvedBy
      : { kind } as ApprovalResolvedBy;
    const label = approvalResolverLabel(resolvedBy, clients);
    expect(label).toBeTypeOf("string");
    expect(label).toMatch(/^Resolved by /);
    if (kind === "orchestrator") expect(label).toBe("Resolved by orchestrator (Christian's laptop)");
    else expect(label).not.toMatch(/orchestrator/);
    if (kind !== "operator") expect(label).not.toBe("Resolved by you");
  });

  it("falls back to the client id when the client is no longer listed", () => {
    const label = approvalResolverLabel({ kind: "orchestrator", clientId: "orchestrator-client-gone", attachmentId: "attachment-1" }, clients);
    expect(label).toBe("Resolved by orchestrator (orchestrator-client-gone)");
  });

  it("names an unrecognized resolver kind rather than treating it as the operator", () => {
    const label = approvalResolverLabel({ kind: "future-resolver" } as unknown as ApprovalResolvedBy, clients);
    expect(label).toBe("Resolved by an unrecognized party");
  });
});
