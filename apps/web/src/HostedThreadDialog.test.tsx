import type { AgentTemplate, ComputeNode } from "@coffee-shop/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HostedThreadDialog } from "./HostedThreadDialog.js";

const node: ComputeNode = {
  id: "node-one",
  name: "Bunker",
  kind: "local",
  platform: "linux · amd64",
  status: "online",
  lastSeen: "2026-09-29T12:00:00.000Z",
  activeRuns: 0,
  concurrency: 2,
  instanceCapacity: 2,
  activeInstances: 0,
  workspaceRoots: ["/workspace"],
  harnesses: [
    { id: "claude-cli", label: "Claude Code", description: "Claude runtime", available: true, authMode: "local-subscription", models: ["sonnet", "opus"] },
    { id: "codex-cli", label: "Codex", description: "Codex runtime", available: true, authMode: "local-account", models: [] }
  ],
  version: "test"
};

const templates: AgentTemplate[] = [
  { id: "template-lead", name: "Engineering lead", purpose: { name: "Lead", instructions: "Delegate and verify." }, delegation: { canDelegate: true } },
  { id: "template-worker", name: "Implementer", delegation: { canDelegate: false } }
];

function renderDialog(overrides: { nodes?: ComputeNode[]; onCreate?: ReturnType<typeof vi.fn> } = {}) {
  const onCreate = overrides.onCreate ?? vi.fn(async () => undefined);
  render(<HostedThreadDialog
    nodes={overrides.nodes ?? [node]}
    templates={templates}
    projectProfiles={[]}
    canMutate
    onClose={vi.fn()}
    onCreate={onCreate}
  />);
  return onCreate;
}

describe("hosted orchestrator thread creation", () => {
  it("shows only delegating templates and submits live runtime choices", async () => {
    const user = userEvent.setup();
    const onCreate = renderDialog();
    await user.click(screen.getByRole("button", { name: "Orchestrator template: Built-in orchestrator" }));
    expect(screen.getByRole("option", { name: /Engineering lead/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Implementer/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /Engineering lead/ }));

    fireEvent.change(screen.getByLabelText("Thread title"), { target: { value: "Ship billing export" } });
    fireEvent.change(screen.getByLabelText("What should the orchestrator accomplish?"), { target: { value: "Delegate implementation and independent review." } });
    await user.click(screen.getByRole("button", { name: "Harness: Automatic" }));
    await user.click(screen.getByRole("option", { name: /Claude Code/ }));
    await user.click(screen.getByRole("button", { name: "Model: Automatic" }));
    await user.click(screen.getByRole("option", { name: "sonnet" }));
    await user.click(screen.getByRole("button", { name: "Preferred machine: Automatic placement" }));
    await user.click(screen.getByRole("option", { name: /Bunker/ }));
    await user.click(screen.getByRole("button", { name: /Start thread/ }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    expect(onCreate.mock.calls[0][0]).toMatchObject({
      title: "Ship billing export",
      objective: "Delegate implementation and independent review.",
      orchestrator: {
        purpose: { name: "Lead", instructions: "Delegate and verify." },
        requirements: {
          templateId: "template-lead",
          harnessIds: ["claude-cli"],
          models: ["sonnet"],
          preferences: { nodeIds: ["node-one"] }
        }
      }
    });
  });

  it("explains and disables creation when no resident slot is available", () => {
    renderDialog({ nodes: [{ ...node, activeInstances: 2 }] });
    expect(screen.getByRole("status")).toHaveTextContent("No resident capacity is available");
    expect(screen.getByRole("button", { name: /Start thread/ })).toBeDisabled();
  });

  it("keeps the form open and reports a placement refusal", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => { throw new Error("No live compute offering can host the requested orchestrator"); });
    renderDialog({ onCreate });
    fireEvent.change(screen.getByLabelText("Thread title"), { target: { value: "Release" } });
    fireEvent.change(screen.getByLabelText("What should the orchestrator accomplish?"), { target: { value: "Coordinate the release." } });
    await user.click(screen.getByRole("button", { name: /Start thread/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No live compute offering");
    expect(within(screen.getByRole("dialog")).getByLabelText("Thread title")).toHaveValue("Release");
  });
});
