import type { Agent, ApprovalRequest, ComputeNode, Run, Task } from "@coffee-shop/protocol";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApprovalsView } from "./ApprovalsView.js";

const agents: Agent[] = [
  { id: "agent-1", name: "Milo", title: "Builder", summary: "", glyph: "M", avatarShape: "cup", avatarColor: "amber", state: "working", currentAction: "Building", harnessId: "claude-cli", model: "sonnet", computeNodeId: "node-1", workspace: "/workspace", systemPrompt: "", unread: 0, updatedAt: "2026-01-01T00:00:00Z" }
];
const nodes: ComputeNode[] = [
  { id: "node-1", name: "Workshop", kind: "local", platform: "linux", status: "online", lastSeen: "now", activeRuns: 0, concurrency: 2, workspaceRoots: ["/srv"], harnesses: [], version: "4" }
];
const runs: Run[] = [
  { id: "run-1", agentId: "agent-1", nodeId: "node-1", harnessId: "claude-cli", model: "sonnet", workspace: "/workspace", prompt: "go", status: "running", output: "", depth: 0, createdAt: "2026-01-01T00:00:00Z" }
];
const tasks: Task[] = [];

function approval(overrides: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    id: "approval-1", harnessApprovalId: "acp-permission-1", threadId: "thread-1", runId: "run-1", nodeId: "node-1",
    title: "Write to config.json",
    options: [
      { id: "opt-once", label: "Allow once", kind: "allow-once" },
      { id: "opt-always", label: "Always allow writes", kind: "allow-always" }
    ],
    status: "pending", requestedAt: "2026-01-01T00:00:00Z", ...overrides
  };
}

describe("ApprovalsView", () => {
  it("shows an empty state when there is nothing to review", () => {
    render(<ApprovalsView approvals={[]} agents={agents} nodes={nodes} runs={runs} tasks={tasks} canMutate apiFetch={vi.fn()} />);
    expect(screen.getByText("No approvals yet")).toBeInTheDocument();
  });

  it("lists a pending approval and resolves an allow-once option without confirmation", async () => {
    const apiFetch = vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify({ approval: { ...approval({}), status: "approved", selectedOptionId: "opt-once" } }), { status: 200 }));
    render(<ApprovalsView approvals={[approval({})]} agents={agents} nodes={nodes} runs={runs} tasks={tasks} canMutate apiFetch={apiFetch} />);
    await userEvent.click(screen.getByRole("button", { name: /Write to config.json/ }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Allow once/ }));
    expect(apiFetch).toHaveBeenCalledWith("/api/approvals/approval-1/resolution", expect.objectContaining({ method: "POST" }));
    const body = JSON.parse((apiFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ expectedStatus: "pending", optionId: "opt-once" });
    expect(typeof body.idempotencyKey).toBe("string");
    expect(body.idempotencyKey.length).toBeGreaterThan(0);
    expect(await screen.findByText(/Resolved: Allow once/)).toBeInTheDocument();
  });

  it("requires explicit confirmation before sending an allow-always resolution", async () => {
    const apiFetch = vi.fn(async () => new Response(JSON.stringify({ approval: approval({ status: "approved" }) }), { status: 200 }));
    render(<ApprovalsView approvals={[approval({})]} agents={agents} nodes={nodes} runs={runs} tasks={tasks} canMutate apiFetch={apiFetch} />);
    await userEvent.click(screen.getByRole("button", { name: /Write to config.json/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Always allow writes/ }));
    expect(apiFetch).not.toHaveBeenCalled();
    expect(screen.getByText(/Confirm "Always allow writes"/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Confirm Always allow writes/ }));
    expect(apiFetch).toHaveBeenCalledOnce();
  });

  it("shows the authoritative state on a 409 conflict instead of claiming success", async () => {
    const conflicted = approval({ status: "approved", selectedOptionId: "opt-once" });
    const apiFetch = vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify({ error: "already resolved", approval: conflicted }), { status: 409 }));
    render(<ApprovalsView approvals={[approval({})]} agents={agents} nodes={nodes} runs={runs} tasks={tasks} canMutate apiFetch={apiFetch} />);
    await userEvent.click(screen.getByRole("button", { name: /Write to config.json/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Allow once/ }));
    expect(await screen.findByText(/already changed/)).toBeInTheDocument();
    expect(screen.getByText(/already approved/)).toBeInTheDocument();
  });

  it("disables resolution controls while disconnected", async () => {
    render(<ApprovalsView approvals={[approval({})]} agents={agents} nodes={nodes} runs={runs} tasks={tasks} canMutate={false} apiFetch={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Write to config.json/ }));
    expect(screen.getByRole("button", { name: /^Allow once/ })).toBeDisabled();
    expect(screen.getByText(/Reconnect to the hub/)).toBeInTheDocument();
  });

  it("sends a cancel resolution distinct from any option", async () => {
    const apiFetch = vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify({ approval: approval({ status: "cancelled" }) }), { status: 200 }));
    render(<ApprovalsView approvals={[approval({})]} agents={agents} nodes={nodes} runs={runs} tasks={tasks} canMutate apiFetch={apiFetch} />);
    await userEvent.click(screen.getByRole("button", { name: /Write to config.json/ }));
    await userEvent.click(screen.getByRole("button", { name: /Cancel this approval/ }));
    const body = JSON.parse((apiFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ expectedStatus: "pending", cancel: true });
    expect(body.optionId).toBeUndefined();
  });
});
