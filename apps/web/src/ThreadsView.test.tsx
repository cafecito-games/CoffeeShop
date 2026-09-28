import type { Agent, OrchestratorAttachment, OrchestratorClient, Thread } from "@coffee-shop/protocol";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThreadsView } from "./ThreadsView.js";

const agents: Agent[] = [
  {
    id: "agent-one", name: "Milo", title: "Builder", summary: "", glyph: "M", avatarShape: "cup", avatarColor: "amber",
    state: "idle", currentAction: "Waiting", harnessId: "claude-cli", model: "sonnet", computeNodeId: "node-one",
    workspace: "/workspace", systemPrompt: "", unread: 0, updatedAt: "2026-09-22T10:00:00Z"
  }
];

const clients: OrchestratorClient[] = [
  { id: "orchestrator-client-1", name: "Christian's laptop", scopes: ["orchestrate"], createdAt: "2026-09-22T08:00:00Z" }
];

function thread(overrides: Partial<Thread>): Thread {
  return {
    id: "thread-1", title: "Ship the login path", objective: "Ship it", summary: "Working through it",
    status: "active", createdBy: "user", createdAt: "2026-09-22T09:00:00Z", updatedAt: "2026-09-22T10:00:00Z", ...overrides
  };
}

function attachment(overrides: Partial<OrchestratorAttachment> = {}): OrchestratorAttachment {
  return {
    id: "attachment-1", threadId: "thread-1", clientId: "orchestrator-client-1", connectionId: "connection-1",
    attachedAt: "2026-09-22T09:30:00Z", lastHeartbeatAt: "2026-09-22T09:40:00Z", status: "attached", ...overrides
  };
}

function renderThreads(threads: Thread[], attachments: OrchestratorAttachment[] = [], onContinue = vi.fn()) {
  render(<ThreadsView
    threads={threads}
    runs={[]}
    artifacts={[]}
    agents={agents}
    orchestratorClients={clients}
    orchestratorAttachments={attachments}
    canMutate
    apiFetch={vi.fn()}
    onContinue={onContinue}
    onInspectRun={vi.fn()}
    onSetStatus={vi.fn()}
  />);
  return onContinue;
}

describe("ThreadsView orchestrator badge", () => {
  it("names the orchestrating agent for an agent thread", () => {
    renderThreads([thread({ orchestrator: { kind: "agent", agentId: "agent-one" } })]);
    expect(screen.getAllByText("Milo").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Continue thread/ })).toBeInTheDocument();
  });

  it("shows an attached external orchestrator by client name", () => {
    renderThreads([thread({ orchestrator: { kind: "external", clientId: "orchestrator-client-1" } })], [attachment()]);
    expect(screen.getAllByText("Christian's laptop").length).toBeGreaterThan(0);
    expect(screen.getByText("Attached")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Message orchestrator/ })).toBeInTheDocument();
  });

  it("reports how long a detached external orchestrator has been away", () => {
    renderThreads(
      [thread({ orchestrator: { kind: "external", clientId: "orchestrator-client-1" } })],
      [attachment({ status: "detached", detachedAt: new Date(Date.now() - 3_600_000).toISOString() })]
    );
    expect(screen.getByText("Detached since 1h ago")).toBeInTheDocument();
  });

  it("renders a thread from a hub that publishes neither an orchestrator nor an owner agent", () => {
    renderThreads([thread({})]);
    expect(screen.getAllByText("Unassigned").length).toBeGreaterThan(0);
    expect(screen.getByText("Ship the login path")).toBeInTheDocument();
  });

  it("renders a pre-migration thread that carries only ownerAgentId", () => {
    renderThreads([thread({ ownerAgentId: "agent-one" })]);
    expect(screen.getAllByText("Milo").length).toBeGreaterThan(0);
  });
});
