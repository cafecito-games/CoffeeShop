import type { Agent, ComputeNode, Task } from "@coffee-shop/protocol";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TaskGraph } from "./TaskGraph.js";

const nodes: ComputeNode[] = [
  { id: "node-1", name: "Workshop", kind: "local", platform: "linux", status: "online", lastSeen: "now", activeRuns: 0, concurrency: 2, workspaceRoots: ["/srv"], harnesses: [], version: "4" }
];

const agents: Agent[] = [
  { id: "agent-1", name: "Milo", title: "Builder", summary: "", glyph: "M", avatarShape: "cup", avatarColor: "amber", state: "working", currentAction: "Building", harnessId: "claude-cli", model: "sonnet", computeNodeId: "node-1", workspace: "/workspace", systemPrompt: "", unread: 0, updatedAt: "2026-01-01T00:00:00Z" }
];

function task(overrides: Partial<Task>): Task {
  return {
    id: "task-1", threadId: "thread-1", title: "Write tests", instructions: "…", status: "ready",
    requirements: {}, dependencies: [], idempotencyKey: "key-1", attemptRunIds: [],
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...overrides
  };
}

const noopFetch = vi.fn(async () => new Response(JSON.stringify({ profile: { id: "p", name: "p" }, readiness: [] }), { status: 200 }));

describe("TaskGraph", () => {
  it("shows an empty state when the thread has no tasks", () => {
    render(<TaskGraph tasks={[]} threadId="thread-1" agents={agents} nodes={nodes} taskMessages={[]} taskMessageAcknowledgements={[]} apiFetch={noopFetch} onInspectRun={vi.fn()} />);
    expect(screen.getByText("No tasks yet")).toBeInTheDocument();
  });

  it("renders dependency outcomes and assignment detail", () => {
    const dependency = task({ id: "task-dep", title: "Set up repository", status: "completed" });
    const dependent = task({
      id: "task-main", title: "Ship feature", status: "assigned",
      dependencies: [{ taskId: "task-dep", policy: "require-success" }],
      assignment: { runId: "run-1", agentId: "agent-1", nodeId: "node-1", harnessId: "claude-cli", transport: "native-cli", model: "sonnet", assignedAt: "2026-01-01T00:00:00Z" },
      attemptRunIds: ["run-1"]
    });
    render(<TaskGraph tasks={[dependency, dependent]} threadId="thread-1" agents={agents} nodes={nodes} taskMessages={[]} taskMessageAcknowledgements={[]} apiFetch={noopFetch} onInspectRun={vi.fn()} />);
    expect(screen.getAllByText("Set up repository")).toHaveLength(2);
    expect(screen.getByText("Satisfied · requires success")).toBeInTheDocument();
    expect(screen.getByText("Milo")).toBeInTheDocument();
    expect(screen.getByText("Workshop")).toBeInTheDocument();
  });

  it("only filters tasks by the active thread", () => {
    const here = task({ id: "task-here", threadId: "thread-1", title: "In this thread" });
    const elsewhere = task({ id: "task-elsewhere", threadId: "thread-2", title: "In another thread" });
    render(<TaskGraph tasks={[here, elsewhere]} threadId="thread-1" agents={agents} nodes={nodes} taskMessages={[]} taskMessageAcknowledgements={[]} apiFetch={noopFetch} onInspectRun={vi.fn()} />);
    expect(screen.getByText("In this thread")).toBeInTheDocument();
    expect(screen.queryByText("In another thread")).not.toBeInTheDocument();
  });

  it("renders placement diagnostics for an unplaced task", () => {
    const pending = task({
      status: "pending",
      placement: {
        evaluatedAt: "2026-01-01T00:00:00Z",
        eligibleNodeIds: [],
        unsatisfied: [{ kind: "skill", requirement: "rust", detail: "no agent advertises this skill" }]
      }
    });
    render(<TaskGraph tasks={[pending]} threadId="thread-1" agents={agents} nodes={nodes} taskMessages={[]} taskMessageAcknowledgements={[]} apiFetch={noopFetch} onInspectRun={vi.fn()} />);
    expect(screen.getByText(/rust — no agent advertises this skill/)).toBeInTheDocument();
  });

  it("shows a reference to an assigned agent that is missing from the snapshot rather than attaching it elsewhere", () => {
    const orphaned = task({
      status: "assigned",
      assignment: { runId: "run-1", agentId: "ghost-agent", nodeId: "ghost-node", harnessId: "claude-cli", transport: "native-cli", model: "sonnet", assignedAt: "2026-01-01T00:00:00Z" }
    });
    render(<TaskGraph tasks={[orphaned]} threadId="thread-1" agents={agents} nodes={nodes} taskMessages={[]} taskMessageAcknowledgements={[]} apiFetch={noopFetch} onInspectRun={vi.fn()} />);
    expect(screen.getByText("ghost-agent (unavailable)")).toBeInTheDocument();
    expect(screen.getByText("ghost-node (unavailable)")).toBeInTheDocument();
  });

  it("never labels a terminal task without an assignment as 'Not yet placed'", () => {
    const completed = task({ id: "task-completed", title: "Design the contract", status: "completed", attemptRunIds: ["run-design"] });
    const cancelled = task({ id: "task-cancelled", title: "Abandoned idea", status: "cancelled", attemptRunIds: [] });
    render(<TaskGraph tasks={[completed, cancelled]} threadId="thread-1" agents={agents} nodes={nodes} taskMessages={[]} taskMessageAcknowledgements={[]} apiFetch={noopFetch} onInspectRun={vi.fn()} />);
    expect(screen.queryByText(/Not yet placed/)).not.toBeInTheDocument();
    expect(screen.getByText("Completed · 1 attempt(s).")).toBeInTheDocument();
    expect(screen.getByText("Cancelled · no attempts were made.")).toBeInTheDocument();
  });

  it("names the blocking dependency for a blocked task instead of saying it is unplaced", () => {
    const dependency = task({ id: "task-dep", title: "Provision the database", status: "failed" });
    const blocked = task({
      id: "task-blocked", title: "Run the migration", status: "blocked",
      dependencies: [{ taskId: "task-dep", policy: "require-success" }]
    });
    render(<TaskGraph tasks={[dependency, blocked]} threadId="thread-1" agents={agents} nodes={nodes} taskMessages={[]} taskMessageAcknowledgements={[]} apiFetch={noopFetch} onInspectRun={vi.fn()} />);
    expect(screen.getByText("Blocked by Provision the database.")).toBeInTheDocument();
  });

  it("renders placement diagnostics for an assigned or running task, not only pending/ready/blocked", () => {
    const running = task({
      status: "running",
      assignment: { runId: "run-1", agentId: "agent-1", nodeId: "node-1", harnessId: "claude-cli", transport: "native-cli", model: "sonnet", assignedAt: "2026-01-01T00:00:00Z" },
      attemptRunIds: ["run-1"],
      placement: {
        evaluatedAt: "2026-01-01T00:00:00Z",
        eligibleNodeIds: ["node-1"],
        unsatisfied: [{ kind: "capacity", requirement: "1 slot", detail: "the assigned node is now at capacity" }]
      }
    });
    render(<TaskGraph tasks={[running]} threadId="thread-1" agents={agents} nodes={nodes} taskMessages={[]} taskMessageAcknowledgements={[]} apiFetch={noopFetch} onInspectRun={vi.fn()} />);
    expect(screen.getByText(/1 slot — the assigned node is now at capacity/)).toBeInTheDocument();
  });
});
