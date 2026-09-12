import type { Agent, ComputeNode, Snapshot } from "@coffee-shop/protocol";
import { fireEvent, render, screen } from "@testing-library/react";
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
      snapshot: testSnapshot,
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

describe("connection freshness UI", () => {
  beforeEach(() => {
    mocks.status = "disconnected";
    mocks.retry.mockReset();
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
});
