import type { ProjectReadiness } from "@coffee-shop/protocol";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReadinessPanel } from "./ReadinessPanel.js";

const nodeNames = new Map([["node-1", "Workshop"]]);

function readiness(overrides: Partial<ProjectReadiness>): ProjectReadiness {
  return {
    nodeId: "node-1", projectId: "project-1", profileFingerprint: "fp", evidenceFingerprint: "ef",
    ready: true, unmetHardRequirements: [], unmetPreferences: [], evaluatedAt: "2026-01-01T00:00:00Z", ...overrides
  };
}

describe("ReadinessPanel", () => {
  it("labels readiness as worker-reported and shows a ready node", async () => {
    const apiFetch = vi.fn(async () => new Response(JSON.stringify({ profile: { id: "project-1", name: "Coffee Shop" }, readiness: [readiness({})] }), { status: 200 }));
    render(<ReadinessPanel projectId="project-1" nodeNames={nodeNames} apiFetch={apiFetch} />);
    expect(await screen.findByText("Worker-reported")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith("/api/project-readiness?projectId=project-1");
  });

  it("lists unmet hard requirements for a node that is not ready", async () => {
    const apiFetch = vi.fn(async () => new Response(JSON.stringify({
      profile: { id: "project-1", name: "Coffee Shop" },
      readiness: [readiness({ ready: false, unmetHardRequirements: [{ kind: "toolchain", requirement: "go 1.26", detail: "missing evidence" }] })]
    }), { status: 200 }));
    render(<ReadinessPanel projectId="project-1" nodeNames={nodeNames} apiFetch={apiFetch} />);
    expect(await screen.findByText("Not ready")).toBeInTheDocument();
    expect(screen.getByText(/go 1.26 — missing evidence/)).toBeInTheDocument();
  });

  it("fails closed with an error state rather than an empty readiness claim", async () => {
    const apiFetch = vi.fn(async () => new Response(JSON.stringify({ error: "Project profile not found" }), { status: 404 }));
    render(<ReadinessPanel projectId="unknown" nodeNames={nodeNames} apiFetch={apiFetch} />);
    expect(await screen.findByText("Project profile not found")).toBeInTheDocument();
  });
});
