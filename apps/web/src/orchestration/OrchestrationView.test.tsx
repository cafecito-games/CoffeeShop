import type { Agent, ApprovalRequest, ComputeNode, Task, Thread } from "@coffee-shop/protocol";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OrchestrationView } from "./OrchestrationView.js";

const threads: Thread[] = [
  { id: "thread-1", title: "Ship the feature", objective: "", summary: "", status: "active", ownerAgentId: "agent-1", createdBy: "user", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }
];
const tasks: Task[] = [
  { id: "task-1", threadId: "thread-1", title: "Write tests", instructions: "…", status: "ready", requirements: {}, dependencies: [], idempotencyKey: "key-1", attemptRunIds: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }
];
const agents: Agent[] = [];
const nodes: ComputeNode[] = [];
const approvals: ApprovalRequest[] = [
  { id: "approval-1", harnessApprovalId: "acp-permission-1", threadId: "thread-1", runId: "run-1", nodeId: "node-1", title: "Approve write", options: [{ id: "opt-1", label: "Allow", kind: "allow-once" }], status: "pending", requestedAt: "2026-01-01T00:00:00Z" }
];

describe("OrchestrationView", () => {
  it("defaults to the tasks tab and switches to approvals and leases", async () => {
    render(
      <OrchestrationView
        threads={threads} tasks={tasks} taskMessages={[]} taskMessageAcknowledgements={[]}
        approvals={approvals} workspaceLeases={[]} agents={agents} nodes={nodes} runs={[]}
        canMutate apiFetch={vi.fn(async () => new Response(JSON.stringify({ profile: { id: "p", name: "p" }, readiness: [] }), { status: 200 }))}
        onInspectRun={vi.fn()}
      />
    );
    expect(screen.getByText("Write tests")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: /Approvals/ }));
    expect(screen.getByText("Approve write")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Leases" }));
    expect(screen.getByText("No workspace leases")).toBeInTheDocument();
  });

  it("shows an empty state when no thread has any tasks", () => {
    render(
      <OrchestrationView
        threads={threads} tasks={[]} taskMessages={[]} taskMessageAcknowledgements={[]}
        approvals={[]} workspaceLeases={[]} agents={agents} nodes={nodes} runs={[]}
        canMutate apiFetch={vi.fn()} onInspectRun={vi.fn()}
      />
    );
    expect(screen.getByText("No orchestrated threads yet")).toBeInTheDocument();
  });
});
