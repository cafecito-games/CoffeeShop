import type { Agent, ComputeNode, Run, RunStatus, Snapshot } from "@coffee-shop/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionStatus } from "./hubConnection.js";

const mocks = vi.hoisted(() => ({
  status: "disconnected" as ConnectionStatus,
  retry: vi.fn()
}));

vi.mock("./hubConnection.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./hubConnection.js")>();
  return {
    ...original,
    useHubConnection: () => ({
      status: mocks.status,
      snapshot: currentSnapshot,
      canMutate: mocks.status === "connected",
      retry: mocks.retry
    })
  };
});

const agent: Agent = {
  id: "agent-one",
  name: "Milo",
  title: "Builder",
  summary: "Builds things",
  glyph: "M",
  avatarShape: "cup",
  avatarColor: "amber",
  state: "idle",
  currentAction: "Waiting",
  harnessId: "codex-cli",
  model: "gpt-5",
  computeNodeId: "node-one",
  workspace: "/workspace",
  systemPrompt: "Build",
  unread: 0,
  updatedAt: "2026-01-01T00:00:00Z"
};

const node: ComputeNode = {
  id: "node-one",
  name: "Desk",
  kind: "local",
  platform: "darwin",
  status: "online",
  lastSeen: "2026-01-01T00:00:00Z",
  activeRuns: 0,
  concurrency: 1,
  workspaceRoots: ["/workspace"],
  harnesses: [{ id: "codex-cli", label: "Codex", description: "Codex", available: true, authMode: "local-account", models: ["gpt-5"] }],
  version: "test"
};

const testSnapshot: Snapshot = {
  agents: [agent],
  nodes: [node],
  runs: [],
  events: [],
  messages: [],
  generatedAt: "2026-01-01T00:00:00Z"
};
let currentSnapshot = testSnapshot;

function testRun(status: RunStatus = "running", id = "run-one"): Run {
  return {
    id, agentId: agent.id, nodeId: node.id, harnessId: "codex-cli", model: "gpt-5",
    workspace: "/workspace", prompt: "Ship the inspector", status, output: "",
    depth: 1, parentRunId: "run-parent", createdAt: "2026-01-01T00:00:00Z",
    startedAt: status === "queued" ? undefined : "2026-01-01T00:01:00Z",
    finishedAt: ["completed", "failed", "cancelled"].includes(status) ? "2026-01-01T00:02:00Z" : undefined,
    error: status === "failed" ? "Harness failed" : undefined
  };
}

function prepareBrowser(status: ConnectionStatus = "connected") {
  mocks.status = status;
  mocks.retry.mockReset();
  currentSnapshot = structuredClone(testSnapshot);
  vi.stubGlobal("fetch", vi.fn());
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() { return storage.size; }
  });
}

describe("connection freshness UI", () => {
  beforeEach(() => {
    prepareBrowser("disconnected");
  });

  it("shows stale state, retries manually, and disables guarded mutations", async () => {
    const { default: App } = await import("./App.js");
    render(<App />);

    expect(screen.getByRole("status")).toHaveTextContent("Disconnected");
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    expect(mocks.retry).toHaveBeenCalledOnce();
    expect(screen.getAllByRole("button", { name: "Create agent" })).toSatisfy((buttons: HTMLElement[]) => buttons.every((button) => button.hasAttribute("disabled")));

    fireEvent.click(screen.getAllByRole("button", { name: /Milo/ })[0]);
    const composer = screen.getByPlaceholderText("Reconnect to message Milo");
    expect(composer).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Context" }));
    expect(screen.getByRole("button", { name: /Codex/ })).toBeDisabled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("renders truthful connection state in Settings", async () => {
    mocks.status = "reconnecting";
    const { default: App } = await import("./App.js");
    render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: "Settings" })[0]);
    expect(document.querySelector(".stale-label")).toHaveTextContent("reconnecting · stale");
    expect(document.querySelector(".ok-label")).toBeNull();
  });

  it("disables an open creation dialog when the connection becomes stale", async () => {
    mocks.status = "connected";
    const { default: App } = await import("./App.js");
    const rendered = render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: "Create agent" })[0]);
    const dialog = screen.getByRole("heading", { name: "Create an agent" }).closest("form");
    fireEvent.change(screen.getByPlaceholderText("Agent name"), { target: { value: "Scout" } });
    fireEvent.change(screen.getByPlaceholderText("Agent role"), { target: { value: "Researcher" } });
    expect(dialog?.querySelector(".create-button")).toBeEnabled();

    mocks.status = "reconnecting";
    rendered.rerender(<App />);
    expect(dialog?.querySelector(".create-button")).toBeDisabled();
    expect(dialog?.querySelector("input[placeholder='Agent name']")).toBeDisabled();
  });
});

describe("run inspector", () => {
  beforeEach(() => prepareBrowser());

  it("opens the exact run from a response and stays synchronized with replacement snapshots", async () => {
    currentSnapshot.runs = [testRun("running"), testRun("completed", "run-other")];
    currentSnapshot.messages = [{
      id: "message-one", agentId: agent.id, author: "agent", body: "Working on it",
      kind: "message", runId: "run-one", createdAt: "2026-01-01T00:01:00Z"
    }];
    const { default: App } = await import("./App.js");
    const rendered = render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: /Milo/ })[0]);
    const trigger = screen.getByRole("button", { name: "Inspect run" });
    fireEvent.click(trigger);

    expect(screen.getByRole("dialog")).toHaveAccessibleName("Run run-one");
    expect(document.querySelector(".run-status-running")).toHaveTextContent("Running");
    expect(screen.getByText("Output is not available yet.")).toBeInTheDocument();
    expect(screen.queryByText("run-other")).not.toBeInTheDocument();

    currentSnapshot = { ...currentSnapshot, runs: [{ ...currentSnapshot.runs[0], output: "streamed chunk" }, currentSnapshot.runs[1]] };
    rendered.rerender(<App />);
    expect(screen.getByText("streamed chunk")).toBeInTheDocument();

    currentSnapshot = { ...currentSnapshot, runs: [currentSnapshot.runs[1]] };
    rendered.rerender(<App />);
    expect(screen.getByText("Run unavailable")).toBeInTheDocument();
    expect(screen.getByText(/No run named/)).toHaveTextContent("run-one");
  });

  it("opens run-bearing activity and renders every status plus unavailable relations and fields", async () => {
    currentSnapshot.runs = [{ ...testRun("queued"), agentId: "missing-agent", nodeId: "missing-node", model: "", workspace: "", prompt: "", parentRunId: undefined }];
    currentSnapshot.events = [{ id: "event-one", type: "run", title: "Queued", detail: "Waiting", runId: "run-one", createdAt: "2026-01-01T00:00:00Z" }];
    const { default: App } = await import("./App.js");
    const rendered = render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: "Activity" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Inspect run" }));
    expect(screen.getByText("missing-agent · unavailable")).toBeInTheDocument();
    expect(screen.getByText("missing-node · unavailable")).toBeInTheDocument();
    expect(screen.getByText("Model unavailable", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Workspace unavailable")).toBeInTheDocument();
    expect(screen.getByText("Prompt unavailable")).toBeInTheDocument();
    expect(screen.getByText("Not started yet")).toBeInTheDocument();
    expect(screen.getByText("Not finished yet")).toBeInTheDocument();

    for (const status of ["running", "completed", "failed", "cancelled"] as const) {
      currentSnapshot = { ...currentSnapshot, runs: [testRun(status)] };
      rendered.rerender(<App />);
      expect(screen.getByText(status[0].toUpperCase() + status.slice(1))).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Cancel run" })).not.toBeInTheDocument();
  });

  it("traps focus, closes with Escape, and restores the triggering control", async () => {
    currentSnapshot.runs = [testRun("completed")];
    currentSnapshot.messages = [{ id: "message-one", agentId: agent.id, author: "agent", body: "Done", kind: "message", runId: "run-one", createdAt: "2026-01-01T00:01:00Z" }];
    const { default: App } = await import("./App.js");
    render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: /Milo/ })[0]);
    const trigger = screen.getByRole("button", { name: "Inspect run" });
    trigger.focus();
    fireEvent.click(trigger);
    const close = screen.getByRole("button", { name: "Close run inspector" });
    expect(close).toHaveFocus();
    await userEvent.tab();
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("confirms active cancellation, waits for success, and surfaces server or network failures", async () => {
    currentSnapshot.runs = [testRun("running")];
    currentSnapshot.messages = [{ id: "message-one", agentId: agent.id, author: "agent", body: "Running", kind: "message", runId: "run-one", createdAt: "2026-01-01T00:01:00Z" }];
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(testRun("cancelled")), { status: 200, headers: { "content-type": "application/json" } }));
    const { default: App } = await import("./App.js");
    render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: /Milo/ })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Inspect run" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(screen.getByText("Cancel this run?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/runs/run-one/cancel", expect.objectContaining({ method: "POST" })));
    expect(await screen.findByRole("alert")).toHaveTextContent("Cancellation accepted");
    expect(document.querySelector(".run-status-running")).toHaveTextContent("Running");

    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Run not found" }), { status: 404, headers: { "content-type": "application/json" } }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Run not found");

    fireEvent.click(screen.getByRole("button", { name: "Keep run" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "A completed run cannot be cancelled" }), { status: 409, headers: { "content-type": "application/json" } }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("A completed run cannot be cancelled"));

    fireEvent.click(screen.getByRole("button", { name: "Keep run" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    fetchMock.mockRejectedValueOnce(new Error("Network unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Network unavailable"));
  });
});
