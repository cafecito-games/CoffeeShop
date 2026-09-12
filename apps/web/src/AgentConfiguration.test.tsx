import type { Agent, ComputeNode } from "@coffee-shop/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentConfigurationForm } from "./AgentConfiguration.js";

const nodes: ComputeNode[] = [{
  id: "node-one",
  name: "Desk",
  kind: "local",
  platform: "darwin",
  status: "online",
  lastSeen: "now",
  activeRuns: 0,
  concurrency: 2,
  workspaceRoots: ["/workspace"],
  harnesses: [
    { id: "codex-cli", label: "Codex", description: "Codex", available: true, authMode: "local-account", models: ["gpt-5", "gpt-5-mini"] },
    { id: "claude-cli", label: "Claude", description: "Claude", available: false, authMode: "local-subscription", models: ["sonnet"] }
  ],
  version: "test"
}, {
  id: "node-two",
  name: "Server",
  kind: "home-server",
  platform: "linux",
  status: "online",
  lastSeen: "now",
  activeRuns: 0,
  concurrency: 4,
  workspaceRoots: ["/srv/projects"],
  harnesses: [{ id: "shell", label: "Shell", description: "Shell", available: true, authMode: "none", models: [] }],
  version: "test"
}];

const agent: Agent = {
  id: "milo",
  name: "Milo",
  title: "Builder",
  summary: "Builds things",
  glyph: "M",
  avatarShape: "cup",
  avatarColor: "amber",
  state: "idle",
  currentAction: "Available",
  harnessId: "codex-cli",
  model: "gpt-5",
  computeNodeId: "node-one",
  workspace: "/workspace/project",
  systemPrompt: "Build carefully.",
  unread: 0,
  updatedAt: "now"
};

describe("AgentConfigurationForm", () => {
  it("derives harness, model, and workspace choices from the selected node", () => {
    render(<AgentConfigurationForm mode="create" nodes={nodes} canMutate onSave={vi.fn()} onCancel={vi.fn()} onReconcile={vi.fn()} />);
    expect(screen.getByLabelText("Harness")).toHaveValue("codex-cli");
    expect(screen.getByRole("option", { name: "Claude" })).toBeDisabled();
    expect(screen.getByLabelText("Model")).toHaveValue("gpt-5");
    expect(screen.getByLabelText("Workspace")).toHaveValue("/workspace");

    fireEvent.change(screen.getByLabelText("Compute node"), { target: { value: "node-two" } });
    expect(screen.getByLabelText("Harness")).toHaveValue("shell");
    expect(screen.getByLabelText("Model")).toHaveValue("default");
    expect(screen.getByLabelText("Workspace")).toHaveValue("/srv/projects");
  });

  it("saves the complete normalized draft, reports progress, and retains server errors", async () => {
    let reject!: (reason: Error) => void;
    const pending = new Promise<Agent>((_resolve, rejectPromise) => { reject = rejectPromise; });
    const onSave = vi.fn(() => pending);
    const onReconcile = vi.fn();
    render(<AgentConfigurationForm mode="edit" agent={agent} nodes={nodes} canMutate onSave={onSave} onCancel={vi.fn()} onReconcile={onReconcile} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Nova" } });
    fireEvent.change(screen.getByLabelText("Summary (optional)"), { target: { value: "Coordinates work" } });
    fireEvent.submit(screen.getByRole("button", { name: "Save changes" }).closest("form")!);
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      name: "Nova",
      summary: "Coordinates work",
      harnessId: "codex-cli",
      model: "gpt-5",
      computeNodeId: "node-one",
      workspace: "/workspace/project",
      systemPrompt: "Build carefully."
    }));
    reject(new Error("Node disappeared; choose another compute node"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Node disappeared");
    expect(onReconcile).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Name")).toHaveValue("Milo");
  });

  it("discards edits on cancel and reconciles when a confirmed snapshot replaces the agent", () => {
    const onCancel = vi.fn();
    const rendered = render(<AgentConfigurationForm mode="edit" agent={agent} nodes={nodes} canMutate onSave={vi.fn()} onCancel={onCancel} onReconcile={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Draft title" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();

    rendered.rerender(<AgentConfigurationForm mode="edit" agent={{ ...agent, title: "Confirmed title", updatedAt: "later" }} nodes={nodes.slice(1)} canMutate onSave={vi.fn()} onCancel={onCancel} onReconcile={vi.fn()} />);
    expect(screen.getByLabelText("Title")).toHaveValue("Confirmed title");
    expect(screen.getByRole("status")).toHaveTextContent("latest hub snapshot");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("requires all required draft fields and disables the entire form while stale", async () => {
    const rendered = render(<AgentConfigurationForm mode="create" nodes={nodes} canMutate onSave={vi.fn()} onCancel={vi.fn()} onReconcile={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Create agent" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Scout" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Researcher" } });
    fireEvent.change(screen.getByLabelText("System prompt"), { target: { value: "Research carefully." } });
    expect(screen.getByRole("button", { name: "Create agent" })).toBeEnabled();

    rendered.rerender(<AgentConfigurationForm mode="create" nodes={nodes} canMutate={false} onSave={vi.fn()} onCancel={vi.fn()} onReconcile={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Create agent" })).toBeDisabled());
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Reconnect before saving");
  });
});
