import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SessionsView } from "./SessionsView.js";
import { sessionFixture, sessionsSnapshot } from "./sessionTestFixtures.js";

describe("SessionsView", () => {
  it("renders provider-neutral status, stale evidence, filters, and keyboard-selectable rows", () => {
    const onSelect = vi.fn();
    render(<SessionsView snapshot={sessionsSnapshot([
      sessionFixture(),
      sessionFixture({ hostHarnessSessionId: "host-session-two", harnessId: "shell", providerSessionId: "opaque-two", status: "active-elsewhere", controlMode: "observe", operations: ["read-history"], summary: "Unknown harness work" })
    ])} connection="reconnecting" apiFetch={vi.fn()} onSelect={onSelect} />);
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent("Last known inventory");
    expect(screen.getByText("Unknown harness work")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Repair the grinder"));
    expect(onSelect).toHaveBeenCalledWith("host-session-one");
    expect(screen.queryByText(/adopt|interrupt|close session/i)).not.toBeInTheDocument();
  });

  it("shows feature unavailable when the validated snapshot omits the collection", () => {
    const snapshot = sessionsSnapshot(); delete snapshot.hostHarnessSessions;
    render(<SessionsView snapshot={snapshot} connection="connected" apiFetch={vi.fn()} onSelect={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Sessions unavailable" })).toBeInTheDocument();
  });

  it("loads the paginated inventory when the network snapshot carries only the v6 signal", async () => {
    const session = sessionFixture();
    const apiFetch = vi.fn(async (path: string) => {
      expect(path).toBe("/api/host-sessions?limit=64&revision=1");
      return jsonResponse({ sessions: [session], total: 1, revision: 1 });
    });
    const { rerender } = render(<SessionsView snapshot={sessionsSnapshot([])} connection="connected" apiFetch={apiFetch} onSelect={vi.fn()} />);
    expect(await screen.findByText("Repair the grinder")).toBeInTheDocument();
    expect(screen.getByText("of 1")).toBeInTheDocument();
    rerender(<SessionsView snapshot={{ ...sessionsSnapshot([]), generatedAt: "2026-10-06T11:01:00Z" }}
      connection="connected" apiFetch={apiFetch} onSelect={vi.fn()} />);
    await Promise.resolve();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("accepts one newer HTTP revision without looping on a stale snapshot revision", async () => {
    const session = sessionFixture();
    const apiFetch = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 409 }))
      .mockResolvedValueOnce(jsonResponse({ sessions: [session], total: 1, revision: 2 }));
    render(<SessionsView snapshot={sessionsSnapshot([])} connection="connected" apiFetch={apiFetch} onSelect={vi.fn()} />);
    expect(await screen.findByText("Repair the grinder")).toBeInTheDocument();
    await new Promise((resolve) => { setTimeout(resolve, 25); });
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("normalizes a stale Coffee Shop selection without adding browser history", () => {
    const onSelect = vi.fn();
    render(<SessionsView snapshot={sessionsSnapshot()} connection="connected" apiFetch={vi.fn()} selectedId="host-session-missing" onSelect={onSelect} />);
    expect(onSelect).toHaveBeenCalledWith(undefined, { replace: true });
  });

  it("ignores superseded detail and history responses", async () => {
    const one = sessionFixture();
    const two = sessionFixture({ hostHarnessSessionId: "host-session-two", providerSessionId: "provider-two", summary: "Second session" });
    const pending = new Map<string, (response: Response) => void>();
    const apiFetch = vi.fn((path: string) => new Promise<Response>((resolve) => pending.set(path, resolve)));
    const { rerender } = render(<SessionsView snapshot={sessionsSnapshot([one, two])} connection="connected" apiFetch={apiFetch} selectedId={one.hostHarnessSessionId} onSelect={vi.fn()} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    rerender(<SessionsView snapshot={sessionsSnapshot([one, two])} connection="connected" apiFetch={apiFetch} selectedId={two.hostHarnessSessionId} onSelect={vi.fn()} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(4));

    pending.get("/api/host-sessions/host-session-two")?.(jsonResponse({ session: two, links: {} }));
    pending.get("/api/host-sessions/host-session-two/history")?.(jsonResponse(historyResponse(two, "Newer evidence")));
    expect(await screen.findByText("Newer evidence")).toBeInTheDocument();
    pending.get("/api/host-sessions/host-session-one")?.(jsonResponse({ session: one, links: {} }));
    pending.get("/api/host-sessions/host-session-one/history")?.(jsonResponse(historyResponse(one, "Superseded evidence")));
    await Promise.resolve();
    expect(screen.queryByText("Superseded evidence")).not.toBeInTheDocument();
  });

  it("restores keyboard focus and keeps future adopt controls outside the row button", async () => {
    function Harness() {
      const [selectedId, setSelectedId] = useState<string>();
      return <SessionsView snapshot={sessionsSnapshot()} connection="connected" apiFetch={async () => new Response("{}", { status: 403 })}
        selectedId={selectedId} onSelect={setSelectedId} adoptSlot={() => <button>Adopt seam</button>} />;
    }
    render(<Harness />);
    const row = screen.getByRole("button", { name: /Repair the grinder/ });
    expect(screen.getByRole("button", { name: "Adopt seam" }).closest(".session-row")).toBeNull();
    fireEvent.click(row);
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Repair the grinder/ })).toHaveFocus());
  });
});

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function historyResponse(session: ReturnType<typeof sessionFixture>, text: string) {
  return {
    hostHarnessSessionId: session.hostHarnessSessionId, nodeId: session.nodeId, harnessId: session.harnessId,
    providerSessionId: session.providerSessionId, workspace: session.workspace, revision: session.revision,
    items: [{ id: `item-${session.hostHarnessSessionId}`, kind: "assistant", text, truncated: false }],
    stale: false, truncated: false, omitted: false
  };
}
