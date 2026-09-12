import type { Agent, TimelineEvent } from "@coffee-shop/protocol";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ActivityView } from "./ActivityView.js";

const agents: Agent[] = [
  { id: "milo", name: "Milo", title: "Builder", summary: "", glyph: "M", avatarShape: "cup", avatarColor: "amber", state: "idle", currentAction: "Waiting", harnessId: "codex-cli", model: "gpt-5", computeNodeId: "desk", workspace: "/workspace", systemPrompt: "Build", unread: 0, updatedAt: "2026-01-01T00:00:00Z" },
  { id: "nova", name: "Nova", title: "Reviewer", summary: "", glyph: "N", avatarShape: "bean", avatarColor: "sage", state: "working", currentAction: "Reviewing", harnessId: "claude-cli", model: "sonnet", computeNodeId: "desk", workspace: "/workspace", systemPrompt: "Review", unread: 0, updatedAt: "2026-01-01T00:00:00Z" },
  { id: "iris", name: "Iris", title: "Researcher", summary: "", glyph: "I", avatarShape: "moka", avatarColor: "sky", state: "idle", currentAction: "Waiting", harnessId: "codex-cli", model: "gpt-5", computeNodeId: "desk", workspace: "/workspace", systemPrompt: "Research", unread: 0, updatedAt: "2026-01-01T00:00:00Z" }
];

const events: TimelineEvent[] = [
  { id: "message-milo", type: "message", title: "Milo replied", detail: "First", agentId: "milo", createdAt: "2026-01-04T00:00:00Z" },
  { id: "handoff", type: "handoff", title: "Milo handed off", detail: "Second", fromAgentId: "milo", toAgentId: "nova", createdAt: "2026-01-03T00:00:00Z" },
  { id: "run-nova", type: "run", title: "Nova ran", detail: "Third", agentId: "nova", runId: "run-one", createdAt: "2026-01-02T00:00:00Z" },
  { id: "node", type: "node", title: "Node joined", detail: "Fourth", createdAt: "2026-01-01T00:00:00Z" }
];

function openFilters() {
  const trigger = screen.getByRole("button", { name: /Filter activity/ });
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
}

describe("activity timeline filters", () => {
  it("shows every event in snapshot order with no filters and distinguishes an empty timeline", () => {
    const rendered = render(<ActivityView events={events} agents={agents} onInspectRun={vi.fn()} />);
    expect(screen.getAllByTestId("timeline-event").map((item) => item.textContent)).toEqual([
      expect.stringContaining("Milo replied"),
      expect.stringContaining("Milo handed off"),
      expect.stringContaining("Nova ran"),
      expect.stringContaining("Node joined")
    ]);
    expect(screen.getByText("4 events")).toBeInTheDocument();
    rendered.rerender(<ActivityView events={[]} agents={agents} onInspectRun={vi.fn()} />);
    expect(screen.getByText("No activity yet")).toBeInTheDocument();
    expect(screen.getByText(/Events will appear here/)).toBeInTheDocument();
  });

  it("ORs event types, ORs agent relationships, and ANDs the two groups", async () => {
    render(<ActivityView events={events} agents={agents} onInspectRun={vi.fn()} />);
    openFilters();
    await userEvent.click(screen.getByRole("checkbox", { name: "Run" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Handoff" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Agent" }), "nova");
    expect(screen.getAllByTestId("timeline-event")).toHaveLength(2);
    expect(screen.getByText("2 of 4 events")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Filter activity, 3 active/ })).toBeInTheDocument();
    expect(screen.queryByText("Milo replied")).not.toBeInTheDocument();
    expect(screen.getByText("Milo handed off")).toBeInTheDocument();
    expect(screen.getByText("Nova ran")).toBeInTheDocument();
  });

  it.each(["milo", "nova"])("matches the %s side of a handoff without matching unrelated agents", async (agentId) => {
    render(<ActivityView events={events} agents={agents} onInspectRun={vi.fn()} />);
    openFilters();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Agent" }), agentId);
    expect(screen.getByText("Milo handed off")).toBeInTheDocument();
    expect(screen.queryByText("Node joined")).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Agent" }), "iris");
    expect(screen.queryByTestId("timeline-event")).not.toBeInTheDocument();
    expect(screen.getByText("No activity matches these filters")).toBeInTheDocument();
  });

  it("keeps filters across replacement snapshots and clear restores the complete timeline", async () => {
    const rendered = render(<ActivityView events={events} agents={agents} onInspectRun={vi.fn()} />);
    openFilters();
    await userEvent.click(screen.getByRole("checkbox", { name: "Message" }));
    fireEvent.keyDown(document, { key: "Escape" });
    const incoming = [
      { ...events[0], id: "new-message", title: "Incoming match" },
      { ...events[2], id: "new-run", title: "Incoming miss" }
    ];
    rendered.rerender(<ActivityView events={incoming} agents={agents} onInspectRun={vi.fn()} />);
    expect(screen.getByText("Incoming match")).toBeInTheDocument();
    expect(screen.queryByText("Incoming miss")).not.toBeInTheDocument();
    openFilters();
    await userEvent.click(screen.getByRole("button", { name: "Clear all filters" }));
    expect(screen.getByText("Incoming match")).toBeInTheDocument();
    expect(screen.getByText("Incoming miss")).toBeInTheDocument();
    expect(screen.getByText("2 events")).toBeInTheDocument();
  });

  it.each(["escape", "outside", "close"])("closes by %s and restores focus", (method) => {
    render(<ActivityView events={events} agents={agents} onInspectRun={vi.fn()} />);
    const trigger = openFilters();
    expect(screen.getByRole("dialog", { name: "Filter activity" })).toBeInTheDocument();
    if (method === "escape") fireEvent.keyDown(document, { key: "Escape" });
    if (method === "outside") fireEvent.mouseDown(screen.getByRole("dialog", { name: "Filter activity" }));
    if (method === "close") fireEvent.click(screen.getByRole("button", { name: "Close activity filters" }));
    expect(screen.queryByRole("dialog", { name: "Filter activity" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
