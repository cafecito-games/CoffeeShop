import type {
  AgentInstance, ApprovalRequest, Run, RunActivity, RunTranscript, Snapshot, Task, TaskMessage, Thread
} from "@coffee-shop/protocol";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildThreadConversation, transcriptBlocks } from "./threadConversation.js";
import { ThreadConversation } from "./ThreadConversation.js";

const at = (minute: number) => `2026-09-29T12:${String(minute).padStart(2, "0")}:00.000Z`;

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1", title: "Ship billing export", objective: "Ship it", summary: "", status: "active",
    orchestrator: { kind: "instance", instanceId: "instance-lead" }, createdBy: "user", createdAt: at(0), updatedAt: at(0), ...overrides
  };
}

const instance = { id: "instance-lead", purpose: { name: "Lead" }, status: "active" } as unknown as AgentInstance;

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-lead", threadId: "thread-1", instanceId: "instance-lead", nodeId: "node-1", harnessId: "claude-cli", model: "sonnet",
    workspace: "/w", prompt: "context", status: "running", output: "", depth: 0, createdAt: at(1), startedAt: at(1), transport: "acp-v1", ...overrides
  };
}

function activity(runId: string, lastSequence: number): RunActivity {
  return {
    runId, threadId: "thread-1", nodeId: "node-1", streamStatus: "open", lastSequence, acceptedEvents: lastSequence,
    message: { text: "", truncatedBytes: 0 }, thought: { text: "", truncatedBytes: 0 }, plan: [], toolCalls: [], diffs: [], terminals: [],
    warnings: [], unknownEvents: 0, omitted: { toolCalls: 0, diffs: 0, terminals: 0, warnings: 0 }, summary: "", updatedAt: at(2)
  };
}

const operatorMessage = (id: string, body: string, minute: number): TaskMessage => ({
  id, threadId: "thread-1", sender: { type: "operator" }, recipient: { type: "orchestrator" }, sequence: minute, kind: "instruction",
  body, idempotencyKey: id, createdAt: at(minute)
});

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    agents: [], nodes: [], runs: [run()], events: [], messages: [], threads: [thread()], instances: [instance],
    taskMessages: [operatorMessage("m1", "Ship it", 0)], runActivity: [activity("run-lead", 3)], generatedAt: at(3), ...overrides
  };
}

function transcriptResponse(runId: string, entries: RunTranscript["entries"], lastSequence = 3) {
  return new Response(JSON.stringify({ runId, transcript: { runId, lastSequence, entries, omittedEntries: 0, updatedAt: at(2) } }), { status: 200 });
}

function renderConversation(current: Snapshot, apiFetch: ReturnType<typeof vi.fn>, handlers: { onReviewApproval?: (id: string) => void } = {}) {
  const props = {
    snapshot: current, canMutate: true, apiFetch, onBack: vi.fn(), onInspectRun: vi.fn(),
    onReviewApproval: handlers.onReviewApproval ?? vi.fn(), onSetStatus: vi.fn()
  };
  const view = render(<ThreadConversation thread={current.threads![0]!} {...props} />);
  return { ...view, rerenderWith: (next: Snapshot) => view.rerender(<ThreadConversation thread={next.threads![0]!} {...props} snapshot={next} />) };
}

describe("buildThreadConversation", () => {
  it("orders operator messages, orchestrator turns, worker tasks, and lifecycle dividers", () => {
    const task = { id: "task-1", threadId: "thread-1", title: "Write exporter", instructions: "Do it", status: "running", attemptRunIds: ["run-worker"], createdAt: at(2) } as Task;
    const items = buildThreadConversation({
      thread: thread(),
      runs: [run(), run({ id: "run-worker", taskId: "task-1", createdAt: at(3) }), run({ id: "run-other", threadId: "thread-2" })],
      tasks: [task],
      messages: [],
      taskMessages: [operatorMessage("m1", "Ship it", 0), operatorMessage("m2", "Also CSV", 5),
        { ...operatorMessage("m3", "Done", 6), sender: { type: "orchestrator" }, recipient: { type: "operator" }, kind: "result" }],
      events: [{ id: "e1", type: "status", title: "Thread completed", detail: "", threadId: "thread-1", createdAt: at(4) }]
    });
    expect(items.map((item) => item.kind)).toEqual(["operator", "turn", "task", "divider", "operator", "reply"]);
    const taskItem = items[2]!;
    expect(taskItem.kind === "task" && taskItem.attempts.map((attempt) => attempt.id)).toEqual(["run-worker"]);
  });

  it("merges consecutive message entries into one reply block", () => {
    const blocks = transcriptBlocks([
      { kind: "message", id: 1, at: at(1), updatedAt: at(1), text: "Hello ", truncatedBytes: 0 },
      { kind: "message", id: 2, at: at(1), updatedAt: at(1), text: "world", truncatedBytes: 0 },
      { kind: "warning", id: 3, at: at(1), updatedAt: at(1), code: "w", message: "careful" },
      { kind: "message", id: 4, at: at(1), updatedAt: at(1), text: "Again", truncatedBytes: 0 }
    ]);
    expect(blocks.map((block) => block.kind === "text" ? block.text : block.entry.kind)).toEqual(["Hello world", "warning", "Again"]);
  });
});

describe("ThreadConversation", () => {
  it("streams the orchestrator's turn and refetches as its activity advances", async () => {
    const apiFetch = vi.fn()
      .mockResolvedValueOnce(transcriptResponse("run-lead", [
        { kind: "thought", id: 1, at: at(1), updatedAt: at(1), text: "Planning", truncatedBytes: 0 },
        { kind: "message", id: 2, at: at(1), updatedAt: at(1), text: "Looking at the exporter", truncatedBytes: 0 }
      ]))
      .mockResolvedValueOnce(transcriptResponse("run-lead", [
        { kind: "thought", id: 1, at: at(1), updatedAt: at(1), text: "Planning", truncatedBytes: 0 },
        { kind: "message", id: 2, at: at(1), updatedAt: at(1), text: "Looking at the exporter", truncatedBytes: 0 },
        { kind: "tool", id: 3, at: at(1), updatedAt: at(1), toolCallId: "c1", status: "completed", toolKind: "execute", title: "pnpm test" },
        { kind: "message", id: 4, at: at(1), updatedAt: at(1), text: "Tests pass.", truncatedBytes: 0 }
      ], 4));
    const { rerenderWith } = renderConversation(snapshot(), apiFetch);
    expect(screen.getByText("Ship it")).toBeInTheDocument();
    expect(await screen.findByText("Looking at the exporter")).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith("/api/runs/run-lead/transcript");

    rerenderWith(snapshot({ runActivity: [activity("run-lead", 4)] }));
    expect(await screen.findByText("Tests pass.", {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByText("pnpm test")).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("offers inline review of a pending approval raised in the turn", async () => {
    const approval = { id: "approval-hub-1", harnessApprovalId: "acp-1", runId: "run-lead", threadId: "thread-1", status: "pending", title: "Run rm" } as ApprovalRequest;
    const apiFetch = vi.fn().mockResolvedValue(transcriptResponse("run-lead", [
      { kind: "approval", id: 1, at: at(1), updatedAt: at(1), approvalId: "acp-1", title: "Run rm", status: "pending" }
    ]));
    const onReviewApproval = vi.fn();
    renderConversation(snapshot({ approvals: [approval] }), apiFetch, { onReviewApproval });
    fireEvent.click(await screen.findByRole("button", { name: "Review approval" }));
    expect(onReviewApproval).toHaveBeenCalledWith("approval-hub-1");
  });

  it("falls back to streamed native output for a run without structured events", () => {
    const apiFetch = vi.fn();
    renderConversation(snapshot({ runs: [run({ output: "Native partial output", transport: "native-cli" })], runActivity: [] }), apiFetch);
    expect(screen.getByText("Native partial output")).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("follows up on a completed thread through its inbox and reuses the idempotency key on retry", async () => {
    const completed = thread({ status: "completed" });
    const apiFetch = vi.fn()
      .mockResolvedValueOnce(transcriptResponse("run-lead", []))
      .mockRejectedValueOnce(new Error("network lost"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ created: false }), { status: 202 }));
    renderConversation(snapshot({ threads: [completed], runs: [run({ status: "completed" })] }), apiFetch);
    expect(screen.getByText("Sending reopens this thread and wakes Lead.")).toBeInTheDocument();
    const input = screen.getByLabelText("Message Lead");
    fireEvent.change(input, { target: { value: "Add CSV too" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send" })); });
    expect(await screen.findByRole("alert")).toHaveTextContent("network lost");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send" })); });
    await waitFor(() => expect(input).toHaveValue(""));
    const sends = apiFetch.mock.calls.filter(([path]) => path === "/api/threads/thread-1/messages");
    expect(sends).toHaveLength(2);
    const keys = sends.map(([, init]) => JSON.parse((init as RequestInit).body as string).idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
  });

  it("keeps an archived thread read-only until it is reopened", () => {
    renderConversation(snapshot({ threads: [thread({ status: "archived" })], runs: [run({ status: "completed" })], runActivity: [] }), vi.fn());
    expect(screen.getByLabelText("Message Lead")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reopen" })).toBeInTheDocument();
  });
});

describe("buildThreadConversation ordering", () => {
  it("puts an operator message before the turn it woke when both share an instant", () => {
    const items = buildThreadConversation({
      thread: thread(), runs: [run({ createdAt: at(5) })], tasks: [], messages: [],
      taskMessages: [operatorMessage("m2", "Follow up", 5)],
      events: [{ id: "e2", type: "status", title: "Thread reopened", detail: "", threadId: "thread-1", createdAt: at(5) }]
    });
    expect(items.map((item) => item.kind)).toEqual(["divider", "operator", "turn"]);
  });
});
