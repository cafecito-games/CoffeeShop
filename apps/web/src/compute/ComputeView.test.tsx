import type { ComputeNode } from "@coffee-shop/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComputeView } from "./ComputeView.js";

const node: ComputeNode = {
  id: "node-one",
  name: "Desk",
  kind: "local",
  platform: "darwin · arm64",
  status: "online",
  lastSeen: "2026-09-11T20:00:00Z",
  activeRuns: 1,
  concurrency: 3,
  workspaceRoots: ["/Users/me/Code", "/Users/me/Notes"],
  harnesses: [
    { id: "codex-cli", label: "Codex", description: "OpenAI Codex CLI", binary: "/opt/bin/codex", available: true, authMode: "local-account", models: ["gpt-5", "gpt-5-mini"] },
    { id: "claude-cli", label: "Claude", description: "Claude Code CLI", available: false, authMode: "local-subscription", models: [] }
  ],
  version: "barista-123"
};

describe("compute experience", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it("opens the exact node, renders all node and harness fields, and follows replacement snapshots", async () => {
    const other = { ...node, id: "node-two", name: "Cloud", kind: "cloud" as const, platform: "linux · amd64" };
    const rendered = render(<ComputeView nodes={[node, other]} />);
    fireEvent.click(screen.getByRole("button", { name: "View Cloud compute details" }));

    expect(screen.getByRole("dialog")).toHaveAccessibleName("Cloud");
    expect(screen.getByText("node-two")).toBeInTheDocument();
    expect(screen.getByText("linux · amd64")).toBeInTheDocument();
    expect(screen.getByText("/Users/me/Notes")).toBeInTheDocument();
    expect(screen.getByText("/opt/bin/codex")).toBeInTheDocument();
    expect(screen.getByText("local-account")).toBeInTheDocument();
    expect(screen.getByText("gpt-5 · gpt-5-mini")).toBeInTheDocument();
    expect(screen.getByText("Not reported")).toBeInTheDocument();
    expect(screen.getByText("No models reported")).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText("node-one")).not.toBeInTheDocument();

    rendered.rerender(<ComputeView nodes={[node, { ...other, name: "Cloud refreshed", activeRuns: 2 }]} />);
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Cloud refreshed");
    expect(screen.getByText("2")).toBeInTheDocument();

    rendered.rerender(<ComputeView nodes={[node]} />);
    expect(screen.getByText("Node unavailable")).toBeInTheDocument();
    expect(screen.getByText(/No other node was substituted/)).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Add compute" })).toHaveFocus());
  });

  it("shows explicit empty and offline states and restores focus after Escape", async () => {
    const rendered = render(<ComputeView nodes={[]} />);
    expect(screen.getByText("No Baristas registered")).toBeInTheDocument();
    rendered.rerender(<ComputeView nodes={[{ ...node, status: "offline" }]} />);
    const trigger = screen.getByRole("button", { name: "View Desk compute details" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByText(/inventory is the last report/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close compute details" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await userEvent.tab();
  });

  it("keeps an accessible dialog name when a structurally valid node name is empty", () => {
    render(<ComputeView nodes={[{ ...node, name: "" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "View unnamed compute details" }));
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Unnamed compute");
  });

  it("generates and copies a safe complete command without exposing browser secrets", async () => {
    render(<ComputeView nodes={[node]} />);
    const trigger = screen.getByRole("button", { name: "Add compute" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Add a Barista");
    expect(screen.getByRole("button", { name: "Close Barista setup" })).toHaveFocus();
    expect(screen.getByLabelText("Hub URL")).toHaveValue("http://localhost:8787");
    expect(screen.getByText("Local computer")).toBeInTheDocument();
    expect(screen.getByText("Home server")).toBeInTheDocument();
    expect(screen.getByText("Cloud machine")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Workspace roots/), { target: { value: "/Users/me/Code" } });
    fireEvent.change(screen.getByLabelText("Barista name"), { target: { value: "Desk'; echo unsafe" } });
    fireEvent.click(screen.getByText("Cloud machine"));
    const copy = screen.getByRole("button", { name: "Copy command" });
    expect(copy).toBeEnabled();
    fireEvent.click(copy);
    expect(await screen.findByText("Copied safe setup command.")).toBeInTheDocument();
    const copied = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
    expect(copied).toContain("BARISTA_KIND='cloud'");
    expect(copied).toContain("BARISTA_NAME='Desk'\"'\"'; echo unsafe'");
    expect(copied).toContain("COFFEE_SHOP_TOKEN='replace-with-hub-token'");
    expect(copied).not.toContain("browser-secret-that-must-not-copy");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("disables copy for invalid fields and keeps selectable text after clipboard failure", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    render(<ComputeView nodes={[node]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add compute" }));
    expect(screen.getByRole("button", { name: "Copy command" })).toBeDisabled();
    expect(screen.getByText("Enter at least one absolute workspace root.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Workspace roots/), { target: { value: "relative/path" } });
    expect(screen.getByText("Every workspace root must be absolute.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Workspace roots/), { target: { value: "C:\\workspaces\\coffee" } });
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    expect(await screen.findByText(/Clipboard access failed/)).toBeInTheDocument();
    expect(screen.getByText(/CONTROL_ENDPOINT=/)).toHaveAttribute("tabindex", "0");
  });
});
