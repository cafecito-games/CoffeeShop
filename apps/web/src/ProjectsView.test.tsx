import type { ProjectProfile } from "@coffee-shop/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectsView } from "./ProjectsView.js";

const profile: ProjectProfile = {
  schemaVersion: 1,
  id: "uzir",
  name: "Uzir",
  repository: { url: "https://github.com/cafecito-games/uzir", defaultBranch: "main" },
  workspacePolicy: {
    requireWritable: true,
    allowedRepositories: ["https://github.com/cafecito-games/uzir"],
    isolation: "git-worktree",
    cleanup: "when-unchanged"
  },
  requirements: { hard: { operatingSystems: ["linux"], harnessIds: ["claude-cli", "codex-cli"] } }
};

const jsonResponse = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" }
}));

describe("project profiles", () => {
  it("creates a worktree-isolated project without editing JSON", async () => {
    const apiFetch = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>((path) => path.startsWith("/api/project-readiness")
      ? jsonResponse({ readiness: [] })
      : jsonResponse(profile, 201));
    render(<ProjectsView profiles={[]} canMutate apiFetch={apiFetch} />);

    fireEvent.click(screen.getByRole("button", { name: "Add your first project" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Uzir" } });
    expect(screen.getByLabelText("Project ID")).toHaveValue("uzir");
    fireEvent.change(screen.getByLabelText("Repository URL"), { target: { value: profile.repository!.url } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/project-profiles", expect.objectContaining({ method: "POST" })));
    const request = apiFetch.mock.calls.find(([path]) => path === "/api/project-profiles")![1] as RequestInit;
    const body = JSON.parse(String(request.body)) as ProjectProfile;
    expect(body).toMatchObject({
      id: "uzir",
      workspacePolicy: { isolation: "git-worktree", cleanup: "when-unchanged", requireWritable: true },
      requirements: { hard: { operatingSystems: ["linux"], harnessIds: ["claude-cli", "codex-cli"] } }
    });
  });

  it("shows readiness and requires an inline confirmation before deletion", async () => {
    const apiFetch = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>((path, init) => {
      if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
      return jsonResponse({ readiness: [{ nodeId: "bunker", ready: true, unmetHardRequirements: [], unmetPreferences: [], evaluatedAt: "2026-09-23T00:00:00Z" }] });
    });
    render(<ProjectsView profiles={[profile]} canMutate apiFetch={apiFetch} />);

    expect(await screen.findByText("1/1 nodes ready")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete Uzir" }));
    expect(screen.getByText(/Active tasks or workspaces will prevent removal/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/project-profiles/uzir", { method: "DELETE" }));
  });
});
