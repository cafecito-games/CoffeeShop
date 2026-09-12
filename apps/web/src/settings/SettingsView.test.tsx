import type { ComputeNode } from "@coffee-shop/protocol";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SettingsView } from "./SettingsView.js";

const node: ComputeNode = {
  id: "policy-node",
  name: "Policy desk",
  kind: "home-server",
  platform: "linux · arm64",
  status: "offline",
  lastSeen: "2026-09-11T20:00:00Z",
  activeRuns: 0,
  concurrency: 4,
  workspaceRoots: ["/srv/workspaces"],
  harnesses: [
    { id: "claude-cli", label: "Claude", description: "Claude Code", available: true, authMode: "local-subscription", models: ["sonnet"] },
    { id: "shell", label: "Shell", description: "Protocol only", available: false, authMode: "none", models: [] }
  ],
  version: "dev"
};

describe("execution policy review", () => {
  it("separates provenance and renders current, offline, unsupported, and stale policy truthfully", () => {
    render(<SettingsView connection="reconnecting" nodes={[node]} generatedAt="2026-09-11T20:01:00Z" />);
    const trigger = screen.getByRole("button", { name: "Review" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Execution policy");
    expect(screen.getByRole("button", { name: "Close execution policy" })).toHaveFocus();
    expect(screen.getAllByText("Worker-reported").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Hub-observed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Release documentation").length).toBeGreaterThan(0);
    expect(screen.getByText("Connection is stale")).toBeInTheDocument();
    expect(screen.getByText(/Offline node/)).toBeInTheDocument();
    expect(screen.getByText("Matches this documented Barista release")).toBeInTheDocument();
    expect(screen.queryByText(/--permission-mode auto/)).not.toBeInTheDocument();
    expect(screen.getByText(/protocol identity is not executable/)).toBeInTheDocument();
    expect(screen.getAllByText("Unrecognized / not verified")).toHaveLength(2);
    expect(screen.getByText("/srv/workspaces")).toBeInTheDocument();
    expect(screen.getByText(/neither provider token/)).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("fails closed for structurally valid unknown runtime values and keeps the open review fresh", () => {
    const unknownNode = {
      ...node,
      status: "online",
      version: "custom-build",
      harnesses: [{ ...node.harnesses[0], id: "future-harness", authMode: "future-auth" }]
    } as unknown as ComputeNode;
    const rendered = render(<SettingsView connection="connected" nodes={[unknownNode]} generatedAt="first" />);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText("Live snapshot connection")).toBeInTheDocument();
    expect(screen.getByText("Version differs; effective policy is not verified")).toBeInTheDocument();
    expect(screen.getByText(/No execution behavior is documented/)).toBeInTheDocument();
    expect(screen.getByText(/No credential handling behavior is documented/)).toBeInTheDocument();

    rendered.rerender(<SettingsView connection="disconnected" nodes={[]} generatedAt="second" />);
    expect(screen.getByText("No Baristas registered")).toBeInTheDocument();
    expect(screen.getByText(/Snapshot generated second/)).toBeInTheDocument();
  });

  it("withholds positive qualification and current flags for unavailable or mismatched harnesses", () => {
    const unavailable = { ...node, status: "online" as const, harnesses: [{ ...node.harnesses[0], available: false }] };
    const first = render(<SettingsView connection="connected" nodes={[unavailable]} generatedAt="now" />);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText("Unrecognized / not verified")).toBeInTheDocument();
    expect(screen.queryByText("Documented for matching release")).not.toBeInTheDocument();
    first.unmount();

    render(<SettingsView connection="connected" nodes={[{ ...node, status: "online", version: "0.0.9" }]} generatedAt="now" />);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText(/Current-release flags are withheld/)).toBeInTheDocument();
    expect(screen.queryByText(/--permission-mode auto/)).not.toBeInTheDocument();
  });

  it.each([
    ["stale connection", "reconnecting" as const, "online" as const],
    ["offline node", "connected" as const, "offline" as const]
  ])("withholds positive qualification for a %s", (_scenario, connection, status) => {
    render(<SettingsView connection={connection} nodes={[{ ...node, status, harnesses: [node.harnesses[0]] }]} generatedAt="now" />);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText("Unrecognized / not verified")).toBeInTheDocument();
    expect(screen.queryByText("Documented for matching release")).not.toBeInTheDocument();
    expect(screen.queryByText(/--permission-mode auto/)).not.toBeInTheDocument();
  });

  it("shows documented flags only for a fresh available matching report", () => {
    render(<SettingsView connection="connected" nodes={[{ ...node, status: "online", harnesses: [node.harnesses[0]] }]} generatedAt="now" />);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText("Documented for matching release")).toBeInTheDocument();
    expect(screen.getByText(/--permission-mode auto/)).toBeInTheDocument();
  });

  it("fails closed for cross-paired Claude and Codex authentication reports", () => {
    const mismatched = {
      ...node,
      status: "online" as const,
      harnesses: [
        { ...node.harnesses[0], authMode: "local-account" as const },
        { ...node.harnesses[0], id: "codex-cli" as const, label: "Codex", authMode: "local-subscription" as const }
      ]
    };
    render(<SettingsView connection="connected" nodes={[mismatched]} generatedAt="now" />);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getAllByText("Unrecognized / not verified")).toHaveLength(2);
    expect(screen.queryByText("Documented for matching release")).not.toBeInTheDocument();
    expect(screen.queryByText(/--permission-mode auto/)).not.toBeInTheDocument();
    expect(screen.queryByText(/--sandbox workspace-write/)).not.toBeInTheDocument();
  });
});
