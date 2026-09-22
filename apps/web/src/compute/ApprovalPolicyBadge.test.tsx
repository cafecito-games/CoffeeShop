import type { ComputeNode, HarnessProfile, RunTransportSelection } from "@coffee-shop/protocol";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunActivityPanel } from "../orchestration/RunActivityPanel.js";
import { ApprovalPolicyBadge } from "./ApprovalPolicyBadge.js";
import { ComputeView } from "./ComputeView.js";

function harness(id: HarnessProfile["id"], label: string, approvalPolicy?: HarnessProfile["approvalPolicy"]): HarnessProfile {
  return { id, label, description: "", available: true, authMode: "local-account", models: ["default"], ...(approvalPolicy ? { approvalPolicy } : {}) };
}

function node(harnesses: HarnessProfile[]): ComputeNode {
  return {
    id: "node-one", name: "Desk", kind: "local", platform: "darwin · arm64", status: "online", lastSeen: "2026-09-22T12:00:00Z",
    activeRuns: 0, concurrency: 2, workspaceRoots: ["/Users/me/Code"], harnesses, version: "barista-123"
  };
}

describe("approval policy badge", () => {
  it("renders only for relaxed policies", () => {
    const { container, rerender } = render(<ApprovalPolicyBadge policy="auto" />);
    expect(screen.getByText("Auto approvals")).toHaveClass("approval-policy-auto");
    rerender(<ApprovalPolicyBadge policy="bypass" />);
    expect(screen.getByText("Approvals bypassed")).toHaveClass("approval-policy-bypass");
    for (const policy of ["manual", undefined, "yolo", 3]) {
      rerender(<ApprovalPolicyBadge policy={policy} />);
      expect(container).toBeEmptyDOMElement();
    }
  });

  it("marks relaxed harnesses in the compute view and leaves manual ones unmarked", () => {
    render(<ComputeView nodes={[node([harness("claude-cli", "Claude", "bypass"), harness("codex-cli", "Codex", "auto"), harness("shell", "Shell", "manual")])]} />);
    expect(screen.getByText("Approvals bypassed").closest(".harness-tags > span")).toHaveTextContent("Claude");
    expect(screen.getByText("Auto approvals").closest(".harness-tags > span")).toHaveTextContent("Codex");
    expect(screen.getAllByText(/Approvals bypassed|Auto approvals/)).toHaveLength(2);
  });

  it("renders no badge for a node whose harnesses report no policy", () => {
    render(<ComputeView nodes={[node([harness("claude-cli", "Claude"), harness("codex-cli", "Codex")])]} />);
    expect(screen.queryByText(/Approvals bypassed|Auto approvals/)).not.toBeInTheDocument();
  });

  it("shows the policy a run executed under in the run inspector transport section", () => {
    const selection: RunTransportSelection = { requestedTransport: "acp-v1", selectedTransport: "acp-v1", approvalPolicy: "bypass" };
    const { rerender } = render(<RunActivityPanel transportSelection={selection} approvals={[]} />);
    expect(screen.getByText("Approval policy")).toBeInTheDocument();
    expect(screen.getByText("Approvals bypassed")).toBeInTheDocument();

    rerender(<RunActivityPanel transportSelection={{ ...selection, approvalPolicy: "auto" }} approvals={[]} />);
    expect(screen.getByText("Auto approvals")).toBeInTheDocument();

    for (const approvalPolicy of ["manual", undefined] as const) {
      rerender(<RunActivityPanel transportSelection={{ requestedTransport: "acp-v1", selectedTransport: "acp-v1", ...(approvalPolicy ? { approvalPolicy } : {}) }} approvals={[]} />);
      expect(screen.queryByText("Approval policy")).not.toBeInTheDocument();
      expect(screen.queryByText(/Approvals bypassed|Auto approvals/)).not.toBeInTheDocument();
    }
  });
});
