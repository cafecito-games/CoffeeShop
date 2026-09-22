import type { ComputeNode, WorkspaceLease } from "@coffee-shop/protocol";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkspaceLeasesPanel } from "./WorkspaceLeasesPanel.js";

const nodes: ComputeNode[] = [
  { id: "node-1", name: "Workshop", kind: "local", platform: "linux", status: "online", lastSeen: "now", activeRuns: 0, concurrency: 2, workspaceRoots: ["/srv"], harnesses: [], version: "4" }
];

function lease(overrides: Partial<WorkspaceLease>): WorkspaceLease {
  return {
    id: "lease-1", threadId: "thread-1", taskId: "task-1", runId: "run-1", nodeId: "node-1",
    projectProfileId: "profile-1", policy: "git-worktree", cleanup: "when-unchanged", root: "/srv/repos",
    sourcePath: "/srv/repos/app", worktreePath: "/srv/repos/.coffee-shop/worktrees/lease-1", status: "active",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...overrides
  };
}

describe("WorkspaceLeasesPanel", () => {
  it("shows an empty state when no leases exist", () => {
    render(<WorkspaceLeasesPanel leases={[]} nodes={nodes} />);
    expect(screen.getByText("No workspace leases")).toBeInTheDocument();
  });

  it("flags a retained lease for operator attention without offering a cleanup control", () => {
    render(<WorkspaceLeasesPanel leases={[lease({ status: "retained", retentionReason: "dirty", detail: "uncommitted changes in src/" })]} nodes={nodes} />);
    expect(screen.getByText("Retained")).toBeInTheDocument();
    expect(screen.getByText(/Uncommitted changes/)).toBeInTheDocument();
    expect(screen.getByText(/uncommitted changes in src\//)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders an active lease without an attention notice", () => {
    render(<WorkspaceLeasesPanel leases={[lease({})]} nodes={nodes} />);
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.queryByText(/attention/)).not.toBeInTheDocument();
  });
});
