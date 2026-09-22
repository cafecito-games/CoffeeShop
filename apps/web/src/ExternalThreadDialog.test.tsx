import type { TaskMessage, Thread } from "@coffee-shop/protocol";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ExternalThreadDialog } from "./ExternalThreadDialog.js";
import type { ThreadOrchestratorDescription } from "./orchestratorPresentation.js";

const attached: ThreadOrchestratorDescription = {
  kind: "external", name: "Christian's laptop", detail: "Attached", attached: true, clientId: "orchestrator-client-1"
};

const thread: Thread = {
  id: "thread-1", title: "Ship the login path", objective: "Ship it", summary: "Working through it", status: "active",
  orchestrator: { kind: "external", clientId: "orchestrator-client-1" },
  createdBy: "user", createdAt: "2026-09-22T09:00:00Z", updatedAt: "2026-09-22T10:00:00Z"
};

const messages: TaskMessage[] = [
  {
    id: "taskmsg-1", threadId: "thread-1", sender: { type: "operator" }, recipient: { type: "orchestrator" },
    sequence: 1, kind: "instruction", body: "Please prioritize the login path", artifactIds: [],
    idempotencyKey: "opmsg-1", createdAt: "2026-09-22T09:50:00Z"
  },
  {
    id: "taskmsg-other", threadId: "thread-other", sender: { type: "operator" }, recipient: { type: "orchestrator" },
    sequence: 1, kind: "instruction", body: "Belongs to another thread", artifactIds: [],
    idempotencyKey: "opmsg-2", createdAt: "2026-09-22T09:55:00Z"
  }
];

function renderDialog(overrides: {
  thread?: Thread;
  description?: ThreadOrchestratorDescription;
  canMutate?: boolean;
  apiFetch?: (path: string, init?: RequestInit) => Promise<Response>;
} = {}) {
  const apiFetch = overrides.apiFetch ?? vi.fn(async () => new Response("{}", { status: 202 }));
  render(<ExternalThreadDialog
    thread={overrides.thread ?? thread}
    description={overrides.description ?? attached}
    taskMessages={messages}
    canMutate={overrides.canMutate ?? true}
    apiFetch={apiFetch}
    onClose={vi.fn()}
  />);
  return apiFetch;
}

describe("external thread messaging", () => {
  it("shows only this thread's orchestrator conversation", () => {
    renderDialog();
    expect(screen.getByText("Please prioritize the login path")).toBeInTheDocument();
    expect(screen.queryByText("Belongs to another thread")).not.toBeInTheDocument();
  });

  it("explains that an attached Claude Code session receives the message and starts no run", async () => {
    const apiFetch = vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify({ created: true, threadId: "thread-1" }), { status: 202 }));
    renderDialog({ apiFetch });
    expect(screen.getByText(/is attached; this message reaches that Claude Code session as a thread event/)).toBeInTheDocument();
    expect(screen.getByText(/never starts a run in Coffee Shop/)).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox"), "Check the redirect");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(apiFetch).toHaveBeenCalledWith("/api/threads/thread-1/messages", expect.objectContaining({ method: "POST" }));
    const body = JSON.parse((apiFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.body).toBe("Check the redirect");
    expect(typeof body.idempotencyKey).toBe("string");
    expect(body.idempotencyKey.length).toBeGreaterThan(0);
    expect(await screen.findByText(/Delivered to Christian's laptop's inbox/)).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("says a detached orchestrator will receive the message when it reconnects", () => {
    renderDialog({ description: { ...attached, detail: "Detached since 2h ago", attached: false } });
    expect(screen.getByText(/is not attached right now/)).toBeInTheDocument();
  });

  it("reports a refusal from the hub without clearing the draft", async () => {
    const apiFetch = vi.fn(async () => new Response(JSON.stringify({ error: "The thread's message limit has been reached" }), { status: 409 }));
    renderDialog({ apiFetch });
    await userEvent.type(screen.getByRole("textbox"), "One more");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The thread's message limit has been reached");
    expect(screen.getByRole("textbox")).toHaveValue("One more");
  });

  it("refuses to message a thread that is not active", () => {
    renderDialog({ thread: { ...thread, status: "completed" } });
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByText(/A completed thread takes no new messages/)).toBeInTheDocument();
  });

  it("refuses to message while the snapshot is stale", () => {
    renderDialog({ canMutate: false });
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByText(/Reconnect to the hub before messaging this thread/)).toBeInTheDocument();
  });
});
