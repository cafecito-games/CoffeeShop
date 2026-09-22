import type { OrchestratorClient } from "@coffee-shop/protocol";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectedClients } from "./ConnectedClients.js";

const secret = "orchestrator-secret-4f2a9c";

function client(overrides: Partial<OrchestratorClient> = {}): OrchestratorClient {
  return {
    id: "orchestrator-client-1",
    name: "Christian's laptop",
    scopes: ["orchestrate"],
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    ...overrides
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Everything a browser storage holds, tolerant of environments with a partial Storage shim. */
function storedText(storage: Storage): string {
  try {
    return JSON.stringify(Object.entries(storage));
  } catch {
    return "";
  }
}

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe("connected clients", () => {
  it("shows an empty state when the hub publishes no clients", () => {
    render(<ConnectedClients clients={[]} canMutate apiFetch={vi.fn()} />);
    expect(screen.getByText("No orchestrator clients")).toBeInTheDocument();
  });

  it("lists a client with its scopes, timestamps, and revoked state", () => {
    render(<ConnectedClients
      clients={[
        client({ scopes: ["orchestrate", "resolve-approvals"], lastSeenAt: new Date(Date.now() - 120_000).toISOString() }),
        client({ id: "orchestrator-client-2", name: "Retired laptop", createdAt: "2026-09-01T00:00:00Z", revokedAt: "2026-09-02T00:00:00Z" })
      ]}
      canMutate
      apiFetch={vi.fn()}
    />);
    expect(screen.getByText("Orchestrate threads · Approve worker actions")).toBeInTheDocument();
    expect(screen.getByText("2m ago")).toBeInTheDocument();
    expect(screen.getByText("Never connected")).toBeInTheDocument();
    expect(screen.getByText("Revoked")).toBeInTheDocument();
    expect(screen.getByText(/may approve worker actions on your behalf/)).toBeInTheDocument();
    // A revoked credential offers no scope edit or revoke action.
    expect(screen.getAllByRole("button", { name: "Edit scopes" })).toHaveLength(1);
  });

  it("warns plainly before granting approval authority and mints with the chosen scopes", async () => {
    const apiFetch = vi.fn(async (_path: string, _init?: RequestInit) => jsonResponse({ client: client({ scopes: ["orchestrate", "resolve-approvals"] }), secret }, 201));
    render(<ConnectedClients clients={[]} canMutate apiFetch={apiFetch} />);
    await userEvent.click(screen.getByRole("button", { name: /Connect a Claude Code orchestrator/ }));
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Connect a Claude Code orchestrator");
    await userEvent.type(screen.getByRole("textbox"), "Christian's laptop");
    await userEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByText(/approve or reject what your workers ask to do/)).toBeInTheDocument();
    expect(screen.getByText(/one AI approve what another AI asks to do/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Mint credential" }));
    expect(apiFetch).toHaveBeenCalledWith("/api/orchestrator-clients", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse((apiFetch.mock.calls[0][1] as RequestInit).body as string))
      .toEqual({ name: "Christian's laptop", scopes: ["orchestrate", "resolve-approvals"] });
  });

  it("shows the secret exactly once and keeps no copy of it anywhere", async () => {
    const apiFetch = vi.fn(async (_path: string, _init?: RequestInit) => jsonResponse({ client: client(), secret }, 201));
    const logged: unknown[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args) => { logged.push(...args); });
    const warn = vi.spyOn(console, "warn").mockImplementation((...args) => { logged.push(...args); });
    const error = vi.spyOn(console, "error").mockImplementation((...args) => { logged.push(...args); });
    try {
      render(<ConnectedClients clients={[client()]} canMutate apiFetch={apiFetch} />);
      await userEvent.click(screen.getByRole("button", { name: /Connect a Claude Code orchestrator/ }));
      await userEvent.type(screen.getByRole("textbox"), "Christian's laptop");
      await userEvent.click(screen.getByRole("button", { name: "Mint credential" }));

      expect(await screen.findByText(secret)).toBeInTheDocument();
      expect(screen.getByText(/This secret is shown once/)).toBeInTheDocument();
      const configuration = screen.getByText(/mcpServers/).textContent ?? "";
      expect(JSON.parse(configuration).mcpServers.coffeeshop.env).toMatchObject({
        COFFEE_SHOP_CLIENT_ID: "orchestrator-client-1",
        COFFEE_SHOP_CLIENT_SECRET: secret
      });
      expect(screen.getByText("claude --dangerously-load-development-channels server:coffeeshop")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: /Copy Client secret/ }));
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(secret);

      await userEvent.click(screen.getByRole("button", { name: /Done — I have copied the secret/ }));

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(document.body.textContent).not.toContain(secret);
      expect(storedText(localStorage)).not.toContain(secret);
      expect(storedText(sessionStorage)).not.toContain(secret);
      expect(location.href).not.toContain(secret);
      expect(JSON.stringify(logged)).not.toContain(secret);

      // Reopening starts a fresh mint rather than replaying what was shown.
      await userEvent.click(screen.getByRole("button", { name: /Connect a Claude Code orchestrator/ }));
      expect(screen.getByRole("dialog")).toHaveAccessibleName("Connect a Claude Code orchestrator");
      expect(screen.queryByText(secret)).not.toBeInTheDocument();
      expect(screen.getByRole("textbox")).toHaveValue("");
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("shows no partial client and reports the failure inline when minting fails", async () => {
    const apiFetch = vi.fn(async () => jsonResponse({ error: "The orchestrator client could not be persisted" }, 500));
    render(<ConnectedClients clients={[]} canMutate apiFetch={apiFetch} />);
    await userEvent.click(screen.getByRole("button", { name: /Connect a Claude Code orchestrator/ }));
    await userEvent.type(screen.getByRole("textbox"), "Laptop");
    await userEvent.click(screen.getByRole("button", { name: "Mint credential" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The orchestrator client could not be persisted");
    expect(screen.queryByText(/This secret is shown once/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mint credential" })).toBeInTheDocument();
  });

  it("edits scopes through the hub and warns before adding approval authority", async () => {
    const apiFetch = vi.fn(async (_path: string, _init?: RequestInit) => jsonResponse({ client: client({ scopes: ["orchestrate", "resolve-approvals"] }) }));
    render(<ConnectedClients clients={[client()]} canMutate apiFetch={apiFetch} />);
    await userEvent.click(screen.getByRole("button", { name: "Edit scopes" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Approve worker actions" }));
    expect(screen.getByText(/approve or reject what your workers ask to do/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save scopes" }));
    expect(apiFetch).toHaveBeenCalledWith("/api/orchestrator-clients/orchestrator-client-1", expect.objectContaining({ method: "PATCH" }));
    expect(JSON.parse((apiFetch.mock.calls[0][1] as RequestInit).body as string)).toEqual({ scopes: ["orchestrate", "resolve-approvals"] });
  });

  it("explains a scope change refused because the credential is revoked", async () => {
    const apiFetch = vi.fn(async () => jsonResponse({ error: "The orchestrator client is revoked" }, 409));
    render(<ConnectedClients clients={[client()]} canMutate apiFetch={apiFetch} />);
    await userEvent.click(screen.getByRole("button", { name: "Edit scopes" }));
    await userEvent.click(screen.getByRole("button", { name: "Save scopes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This credential is revoked");
  });

  it("requires confirmation before revoking", async () => {
    const apiFetch = vi.fn(async () => jsonResponse({ client: client({ revokedAt: new Date().toISOString() }) }));
    render(<ConnectedClients clients={[client()]} canMutate apiFetch={apiFetch} />);
    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(apiFetch).not.toHaveBeenCalled();
    expect(screen.getByText(/Its session is disconnected immediately/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Confirm revocation" }));
    expect(apiFetch).toHaveBeenCalledWith("/api/orchestrator-clients/orchestrator-client-1/revoke", expect.objectContaining({ method: "POST" }));
  });

  it("disables every mutation while the snapshot is stale", () => {
    render(<ConnectedClients clients={[client()]} canMutate={false} apiFetch={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Connect a Claude Code orchestrator/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit scopes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Revoke" })).toBeDisabled();
    expect(screen.getByText(/Reconnect to the hub before changing credentials/)).toBeInTheDocument();
  });
});
