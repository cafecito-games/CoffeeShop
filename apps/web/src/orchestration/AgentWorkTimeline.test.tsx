import type { Agent, ApprovalRequest, ChatMessage, Run, RunActivity, Task, TaskMessage, Thread } from "@coffee-shop/protocol";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentTimelineItem, buildAgentTimeline, type AgentTimelineSources } from "./AgentWorkTimeline.js";

function agent(id: string, name: string): Agent {
  return { id, name, title: "", summary: "", glyph: name[0], avatarShape: "cup", avatarColor: "amber", state: "working", currentAction: "", harnessId: "claude-cli", model: "sonnet", computeNodeId: "node-1", workspace: "/workspace", systemPrompt: "", unread: 0, updatedAt: "2026-01-01T00:00:00Z" };
}

function run(overrides: Partial<Run>): Run {
  return { id: "run-1", agentId: "worker", nodeId: "node-1", harnessId: "claude-cli", model: "sonnet", workspace: "/workspace", prompt: "", status: "completed", output: "", depth: 1, createdAt: "2026-01-01T00:01:00Z", threadId: "thread-1", ...overrides };
}

function task(overrides: Partial<Task>): Task {
  return { id: "task-1", threadId: "thread-1", title: "Add presets", instructions: "Write src/presets.ts", status: "running", requirements: {}, dependencies: [], idempotencyKey: "key", attemptRunIds: [], createdAt: "2026-01-01T00:00:30Z", updatedAt: "2026-01-01T00:00:30Z", ...overrides };
}

function taskMessage(overrides: Partial<TaskMessage>): TaskMessage {
  return { id: "message-1", threadId: "thread-1", sender: { type: "task", taskId: "task-1" }, recipient: { type: "orchestrator" }, sequence: 1, kind: "question", body: "Which ratio?", idempotencyKey: "key", createdAt: "2026-01-01T00:02:00Z", ...overrides };
}

function activity(overrides: Partial<RunActivity>): RunActivity {
  return {
    runId: "run-1", nodeId: "node-1", streamStatus: "open", lastSequence: 3, acceptedEvents: 3,
    message: { text: "Writing the presets now", truncatedBytes: 0 }, thought: { text: "", truncatedBytes: 0 },
    plan: [], toolCalls: [], diffs: [], terminals: [], warnings: [], unknownEvents: 0,
    omitted: { toolCalls: 0, diffs: 0, terminals: 0, warnings: 0 }, summary: "Writing the presets now", updatedAt: "2026-01-01T00:04:00Z",
    ...overrides
  };
}

const thread: Thread = { id: "thread-1", title: "Ship brew-kit", objective: "", summary: "", status: "active", ownerAgentId: "lead", createdBy: "user", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
const agents = [agent("lead", "Head Barista"), agent("worker", "Claude Builder"), agent("other", "Codex Builder")];
const orchestratorRun = run({ id: "run-lead", agentId: "lead", depth: 0, createdAt: "2026-01-01T00:00:00Z" });

function sources(overrides: Partial<AgentTimelineSources>): AgentTimelineSources {
  return { agentId: "worker", agents, messages: [], runs: [], tasks: [], threads: [thread], taskMessages: [], runActivity: [], approvals: [], ...overrides };
}

describe("buildAgentTimeline", () => {
  it("shows a worker its assignment, its mailbox traffic, and its result in order", () => {
    const workerRun = run({ id: "run-1", taskId: "task-1" });
    const result: ChatMessage = { id: "chat-1", agentId: "worker", author: "agent", body: "Presets committed", kind: "message", runId: "run-1", threadId: "thread-1", createdAt: "2026-01-01T00:05:00Z" };
    const timeline = buildAgentTimeline(sources({
      runs: [orchestratorRun, workerRun],
      tasks: [task({ sourceRunId: "run-lead", assignment: { runId: "run-1", agentId: "worker", nodeId: "node-1", harnessId: "claude-cli", transport: "acp-v1", model: "sonnet", assignedAt: "2026-01-01T00:01:00Z" } })],
      messages: [result],
      taskMessages: [
        taskMessage({}),
        taskMessage({ id: "message-2", sender: { type: "orchestrator" }, recipient: { type: "task", taskId: "task-1" }, kind: "answer", body: "1:8 concentrate", createdAt: "2026-01-01T00:03:00Z" }),
        taskMessage({ id: "message-3", sender: { type: "task", taskId: "task-other" }, body: "Not mine", createdAt: "2026-01-01T00:03:30Z" })
      ]
    }));

    expect(timeline.map((entry) => entry.kind)).toEqual(["assignment", "mailbox", "mailbox", "chat"]);
    expect(timeline[0]).toMatchObject({ kind: "assignment", assignedBy: "Head Barista" });
    expect(timeline[1]).toMatchObject({ kind: "mailbox", direction: "outgoing", counterpart: "Head Barista" });
    expect(timeline[2]).toMatchObject({ kind: "mailbox", direction: "incoming", counterpart: "Head Barista" });
  });

  it("shows the orchestrator each worker's messages labelled by agent and task", () => {
    const timeline = buildAgentTimeline(sources({
      agentId: "lead",
      runs: [orchestratorRun, run({ id: "run-1", taskId: "task-1" })],
      tasks: [task({ attemptRunIds: ["run-1"] })],
      taskMessages: [taskMessage({})]
    }));

    expect(timeline).toEqual([expect.objectContaining({ kind: "mailbox", direction: "incoming", counterpart: "Claude Builder · Add presets" })]);
  });

  it("adds live activity with pending approvals only for runs still in progress", () => {
    const pending: ApprovalRequest = { id: "approval-1", harnessApprovalId: "h-1", threadId: "thread-1", runId: "run-1", nodeId: "node-1", title: "Write src/presets.ts", options: [], status: "pending", requestedAt: "2026-01-01T00:03:00Z" };
    const resolved: ApprovalRequest = { ...pending, id: "approval-2", status: "approved" };
    const timeline = buildAgentTimeline(sources({
      runs: [run({ id: "run-1", taskId: "task-1", status: "running" }), run({ id: "run-2", taskId: "task-1", status: "completed" })],
      tasks: [task({})],
      runActivity: [activity({}), activity({ runId: "run-2" })],
      approvals: [pending, resolved]
    }));

    const live = timeline.filter((entry) => entry.kind === "live");
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ run: { id: "run-1" }, pendingApprovals: [{ id: "approval-1" }], linkedFromChat: false });
  });

  it("marks live activity whose run a chat message already links", () => {
    const message: ChatMessage = { id: "chat-1", agentId: "worker", author: "agent", body: "Working", kind: "message", runId: "run-1", threadId: "thread-1", createdAt: "2026-01-01T00:02:00Z" };
    const timeline = buildAgentTimeline(sources({ runs: [run({ id: "run-1", status: "running" })], messages: [message] }));

    expect(timeline.find((entry) => entry.kind === "live")).toMatchObject({ linkedFromChat: true });
  });

  it("limits every entry to the selected thread", () => {
    const timeline = buildAgentTimeline(sources({
      threadId: "thread-2",
      runs: [run({ id: "run-1", taskId: "task-1" })],
      tasks: [task({})],
      taskMessages: [taskMessage({})]
    }));

    expect(timeline).toEqual([]);
  });
});

describe("AgentTimelineItem", () => {
  it("renders recent tool calls and opens a pending approval for review", () => {
    const onReviewApproval = vi.fn();
    const pending: ApprovalRequest = { id: "approval-1", harnessApprovalId: "h-1", threadId: "thread-1", runId: "run-1", nodeId: "node-1", title: "git commit", options: [], status: "pending", requestedAt: "2026-01-01T00:03:00Z" };
    render(<AgentTimelineItem
      entry={{
        kind: "live", id: "live:run-1", at: "2026-01-01T00:04:00Z", run: run({ status: "running" }), task: task({}), pendingApprovals: [pending], linkedFromChat: false,
        activity: activity({ toolCalls: [{ toolCallId: "call-1", status: "completed", kind: "execute", title: "node --test", updatedAt: "2026-01-01T00:03:30Z" }] })
      }}
      onInspectRun={vi.fn()}
      onReviewApproval={onReviewApproval}
    />);

    expect(screen.getByText("Working on Add presets")).toBeInTheDocument();
    expect(screen.getByText("node --test")).toBeInTheDocument();
    expect(screen.getByText("Writing the presets now")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Approval needed: git commit/ }));
    expect(onReviewApproval).toHaveBeenCalledWith("approval-1");
  });
});
