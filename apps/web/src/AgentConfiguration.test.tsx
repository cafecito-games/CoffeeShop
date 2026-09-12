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

  it("never offers a structurally valid unknown runtime harness for mutation", () => {
    const unknownHarnessNode = {
      ...nodes[0],
      harnesses: [
        { ...nodes[0].harnesses[0], id: "future-harness", label: "Future harness" },
        nodes[0].harnesses[0]
      ]
    } as unknown as ComputeNode;
    render(<AgentConfigurationForm mode="create" nodes={[unknownHarnessNode]} canMutate onSave={vi.fn()} onCancel={vi.fn()} onReconcile={vi.fn()} />);
    expect(screen.queryByRole("option", { name: "Future harness" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Harness")).toHaveValue("codex-cli");
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

  it("retains an actionable save error after rolling back a changed compute selection", async () => {
    const onSave = vi.fn(async () => { throw new Error("Node disappeared; choose another compute node"); });
    render(<AgentConfigurationForm mode="edit" agent={agent} nodes={nodes} canMutate onSave={onSave} onCancel={vi.fn()} onReconcile={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Compute node"), { target: { value: "node-two" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Node disappeared; choose another compute node");
    await waitFor(() => expect(screen.getByLabelText("Compute node")).toHaveValue("node-one"));
    expect(screen.getByRole("alert")).toHaveTextContent("Node disappeared; choose another compute node");
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

  it("does not discard a draft when only operational activity updates the agent timestamp", () => {
    const rendered = render(<AgentConfigurationForm mode="edit" agent={agent} nodes={nodes} canMutate onSave={vi.fn()} onCancel={vi.fn()} onReconcile={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Unsaved name" } });
    rendered.rerender(<AgentConfigurationForm mode="edit" agent={{ ...agent, updatedAt: "later" }} nodes={nodes} canMutate onSave={vi.fn()} onCancel={vi.fn()} onReconcile={vi.fn()} />);
    expect(screen.getByLabelText("Name")).toHaveValue("Unsaved name");
    expect(screen.queryByText(/latest hub snapshot/)).not.toBeInTheDocument();
  });

  it("does not discard a draft when an unrelated node profile changes", () => {
    const rendered = render(<AgentConfigurationForm mode="edit" agent={agent} nodes={nodes} canMutate onSave={vi.fn()} onCancel={vi.fn()} onReconcile={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Unsaved name" } });
    rendered.rerender(<AgentConfigurationForm mode="edit" agent={agent} nodes={[nodes[0], { ...nodes[1], workspaceRoots: ["/srv/new-root"] }]} canMutate onSave={vi.fn()} onCancel={vi.fn()} onReconcile={vi.fn()} />);
    expect(screen.getByLabelText("Name")).toHaveValue("Unsaved name");
    expect(screen.queryByText(/latest hub snapshot/)).not.toBeInTheDocument();
  });

  it("fails closed when the selected node goes offline", () => {
    render(<AgentConfigurationForm mode="edit" agent={agent} nodes={[{ ...nodes[0], status: "offline" }, nodes[1]]} canMutate onSave={vi.fn()} onCancel={vi.fn()} onReconcile={vi.fn()} />);
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
