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
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Execution policy");
    expect(screen.getAllByText("Worker-reported").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Hub-observed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Release documentation").length).toBeGreaterThan(0);
    expect(screen.getByText("Connection is stale")).toBeInTheDocument();
    expect(screen.getByText(/Offline node/)).toBeInTheDocument();
    expect(screen.getByText("Matches this documented Barista release")).toBeInTheDocument();
    expect(screen.getByText(/--permission-mode auto/)).toBeInTheDocument();
    expect(screen.getByText(/protocol identity is not executable/)).toBeInTheDocument();
    expect(screen.getByText("Unrecognized / not verified")).toBeInTheDocument();
    expect(screen.getByText("/srv/workspaces")).toBeInTheDocument();
    expect(screen.getByText(/neither provider token/)).toBeInTheDocument();
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
});
