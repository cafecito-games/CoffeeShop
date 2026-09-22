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

  it("wires each tab to its panel per the WAI-ARIA tabs pattern", () => {
    render(
      <OrchestrationView
        threads={threads} tasks={tasks} taskMessages={[]} taskMessageAcknowledgements={[]}
        approvals={approvals} workspaceLeases={[]} agents={agents} nodes={nodes} runs={[]}
        canMutate apiFetch={vi.fn(async () => new Response(JSON.stringify({ profile: { id: "p", name: "p" }, readiness: [] }), { status: 200 }))}
        onInspectRun={vi.fn()}
      />
    );
    const tasksTab = screen.getByRole("tab", { name: /^Tasks/ });
    const approvalsTab = screen.getByRole("tab", { name: /Approvals/ });
    const leasesTab = screen.getByRole("tab", { name: "Leases" });
    const panel = screen.getByRole("tabpanel");

    expect(tasksTab).toHaveAttribute("aria-controls", panel.id);
    expect(panel).toHaveAttribute("aria-labelledby", tasksTab.id);
    expect(tasksTab).toHaveAttribute("tabindex", "0");
    expect(approvalsTab).toHaveAttribute("tabindex", "-1");
    expect(leasesTab).toHaveAttribute("tabindex", "-1");
  });

  it("moves and activates tabs with arrow keys, and jumps with Home/End", async () => {
    const user = userEvent.setup();
    render(
      <OrchestrationView
        threads={threads} tasks={tasks} taskMessages={[]} taskMessageAcknowledgements={[]}
        approvals={approvals} workspaceLeases={[]} agents={agents} nodes={nodes} runs={[]}
        canMutate apiFetch={vi.fn(async () => new Response(JSON.stringify({ profile: { id: "p", name: "p" }, readiness: [] }), { status: 200 }))}
        onInspectRun={vi.fn()}
      />
    );
    const tasksTab = screen.getByRole("tab", { name: /^Tasks/ });
    tasksTab.focus();

    await user.keyboard("{ArrowRight}");
    const approvalsTab = screen.getByRole("tab", { name: /Approvals/ });
    expect(approvalsTab).toHaveFocus();
    expect(approvalsTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Approve write")).toBeInTheDocument();

    await user.keyboard("{End}");
    const leasesTab = screen.getByRole("tab", { name: "Leases" });
    expect(leasesTab).toHaveFocus();
    expect(leasesTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("No workspace leases")).toBeInTheDocument();

    await user.keyboard("{Home}");
    expect(tasksTab).toHaveFocus();
    expect(tasksTab).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{ArrowLeft}");
    expect(leasesTab).toHaveFocus();
    expect(leasesTab).toHaveAttribute("aria-selected", "true");
  });
});
