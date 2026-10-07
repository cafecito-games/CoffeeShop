import type { HarnessSessionBinding, Run } from "@coffee-shop/protocol";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProviderSessionCard, providerSessionForRun, providerSessionsForAgent, resumeCommand } from "./ProviderSessions.js";

function run(overrides: Partial<Run>): Run {
  return { id: "run-1", agentId: "worker", nodeId: "node-1", harnessId: "claude-cli", model: "sonnet", workspace: "/srv/brew-kit", prompt: "", status: "completed", output: "", depth: 0, createdAt: "2026-01-01T00:00:00Z", ...overrides };
}

function binding(overrides: Partial<HarnessSessionBinding>): HarnessSessionBinding {
  return {
    id: "binding-1", threadId: "thread-1", agentId: "worker", nodeId: "node-1", harnessId: "codex-cli", transport: "acp-v1",
    workspace: "/srv/worktrees/lease-1", providerSessionId: "01a0c870-cc2d", status: "closed", createdByRunId: "run-2", lastRunId: "run-2",
    createdAt: "2026-01-01T00:01:00Z", updatedAt: "2026-01-01T00:02:00Z", ...overrides
  };
}

describe("provider sessions", () => {
  it("prefers the run's ACP session binding and falls back to a native run's own session", () => {
    const acp = providerSessionForRun(run({ id: "run-2", sessionBindingId: "binding-1" }), [binding({})]);
    expect(acp).toMatchObject({ transport: "acp-v1", providerSessionId: "01a0c870-cc2d", workspace: "/srv/worktrees/lease-1", bindingStatus: "closed" });

    const native = providerSessionForRun(run({ providerSessionId: "3b729b65" }), []);
    expect(native).toMatchObject({ transport: "native-cli", providerSessionId: "3b729b65", workspace: "/srv/brew-kit" });

    expect(providerSessionForRun(run({}), [])).toBeUndefined();
  });

  it("lists an agent's distinct sessions newest first", () => {
    const sessions = providerSessionsForAgent("worker", [
      run({ id: "run-1", providerSessionId: "native-old", finishedAt: "2026-01-01T00:00:30Z" }),
      run({ id: "run-3", providerSessionId: "native-new", finishedAt: "2026-01-01T00:05:00Z" }),
      run({ id: "run-4", agentId: "other", providerSessionId: "not-mine" })
    ], [binding({}), binding({ id: "binding-2", agentId: "other", providerSessionId: "also-not-mine" })]);

    expect(sessions.map((session) => session.providerSessionId)).toEqual(["native-new", "01a0c870-cc2d", "native-old"]);
  });

  it("quotes the workspace and uses each vendor's resume command", () => {
    const claude = providerSessionForRun(run({ providerSessionId: "3b729b65", workspace: "/srv/it's here" }), [])!;
    expect(resumeCommand(claude)).toBe(`cd '/srv/it'\\''s here' && claude --resume 3b729b65`);

    const codex = providerSessionForRun(run({ id: "run-2", sessionBindingId: "binding-1" }), [binding({})])!;
    expect(resumeCommand(codex)).toBe("cd '/srv/worktrees/lease-1' && codex resume 01a0c870-cc2d");

    expect(resumeCommand({ ...codex, harnessId: "shell" })).toBeUndefined();
  });

  it("warns that Coffee Shop may still resume an idle session", () => {
    const reference = providerSessionForRun(run({ id: "run-2", sessionBindingId: "binding-1" }), [binding({ status: "idle" })])!;
    render(<ProviderSessionCard reference={reference} nodeName="Espresso" />);

    expect(screen.getByText("Resume on Espresso")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy resume command for 01a0c870-cc2d" })).toBeInTheDocument();
    expect(screen.getByText(/Coffee Shop may still resume this session/)).toBeInTheDocument();
  });

  it("shows a Sessions link only for an explicit host-session correlation", async () => {
    const user = userEvent.setup();
    const onOpenHostSession = vi.fn();
    const explicit = providerSessionForRun(run({ providerSessionId: "native-one", hostHarnessSessionId: "host-session-one" }), [])!;
    const { rerender } = render(<ProviderSessionCard reference={explicit} nodeName="Espresso" onOpenHostSession={onOpenHostSession} />);
    await user.click(screen.getByRole("button", { name: "View in Sessions" }));
    expect(onOpenHostSession).toHaveBeenCalledWith("host-session-one");

    rerender(<ProviderSessionCard reference={{ ...explicit, hostHarnessSessionId: undefined }} nodeName="Espresso" onOpenHostSession={onOpenHostSession} />);
    expect(screen.queryByRole("button", { name: "View in Sessions" })).not.toBeInTheDocument();
    expect(resumeCommand(explicit)).toBe("cd '/srv/brew-kit' && claude --resume native-one");
  });
});
