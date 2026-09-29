import { useRef, useState, type FormEvent } from "react";
import { PaperPlaneTilt, X } from "@phosphor-icons/react";
import type { TaskMessage, TaskMessageParticipant, Thread } from "@coffee-shop/protocol";
import { AccessibleDialog } from "./AccessibleDialog.js";
import { OrchestratorBadge } from "./OrchestratorBadge.js";
import { timeAgo } from "./orchestration/orchestrationLabels.js";
import type { ThreadOrchestratorDescription } from "./orchestratorPresentation.js";

function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `operator-message-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const participantLabels: Record<TaskMessageParticipant["type"], string> = {
  operator: "You",
  orchestrator: "Orchestrator",
  task: "Worker task"
};

function participantLabel(participant: TaskMessageParticipant): string {
  return participantLabels[participant.type] ?? "Unknown participant";
}

/**
 * A thread without a legacy owner agent is steered through its durable orchestrator inbox. External
 * sessions receive a doorbell; resident orchestrators are woken on their assigned Barista node.
 */
export function OrchestratorThreadDialog({ thread, description, taskMessages, canMutate, apiFetch, onClose }: {
  thread: Thread;
  description: ThreadOrchestratorDescription;
  taskMessages: TaskMessage[];
  canMutate: boolean;
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onClose: () => void;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  // A send whose response is lost leaves the draft in place. Retrying it reuses the key the hub
  // already saw, so its replay answers instead of appending the message a second time; only a
  // different message, or one the hub accepted, earns a new key.
  const attempt = useRef<{ body: string; idempotencyKey: string } | undefined>(undefined);
  const [notice, setNotice] = useState<{ tone: "info" | "error"; text: string } | undefined>(undefined);
  const titleId = "external-thread-title";
  const conversation = taskMessages
    .filter((message) => message.threadId === thread.id)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const active = thread.status === "active";
  const hosted = description.kind === "instance";

  async function send(event: FormEvent) {
    event.preventDefault();
    const value = body.trim();
    if (!value || sending || !canMutate || !active) return;
    setSending(true);
    setNotice(undefined);
    if (attempt.current?.body !== value) attempt.current = { body: value, idempotencyKey: newIdempotencyKey() };
    try {
      const response = await apiFetch(`/api/threads/${encodeURIComponent(thread.id)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: value, idempotencyKey: attempt.current.idempotencyKey })
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (response.status === 202) {
        attempt.current = undefined;
        setBody("");
        setNotice({ tone: "info", text: `Delivered to ${description.name}'s inbox.` });
        return;
      }
      if (response.status === 404) throw new Error("This thread no longer has a messageable orchestrator.");
      throw new Error(payload.error ?? `The message could not be delivered (${response.status})`);
    } catch (cause) {
      setNotice({ tone: "error", text: cause instanceof Error ? cause.message : "The message could not be delivered" });
    } finally {
      setSending(false);
    }
  }

  return (
    <AccessibleDialog labelledBy={titleId} onClose={onClose} className="experience-dialog external-thread-dialog">
      <header className="experience-header external-thread-header">
        <div><small>{hosted ? "Resident orchestrator" : "External orchestrator"}</small><h2 id={titleId}>{thread.title}</h2><OrchestratorBadge description={description} /></div>
        <button className="icon-btn" onClick={onClose} aria-label="Close thread" data-dialog-initial-focus><X size={17} /></button>
      </header>
      <p className="experience-lede">{thread.summary || thread.objective}</p>
      <section className="external-thread-messages" aria-label="Messages with the orchestrator">
        {conversation.length === 0
          ? <p className="external-thread-empty">No messages have passed between you and this orchestrator yet.</p>
          : conversation.map((message) => (
            <article key={message.id} className="external-thread-message">
              <div className="external-thread-message-meta"><strong>{participantLabel(message.sender)}</strong><span>to {participantLabel(message.recipient)}</span><time>{timeAgo(message.createdAt)}</time></div>
              <p>{message.body}</p>
            </article>
          ))}
      </section>
      <form className="external-thread-composer" onSubmit={send}>
        <p className="composer-hint">
          {hosted
            ? `${description.name} is ${description.detail || "assigned"}. This message enters its durable inbox and wakes it on its resident compute when ready.`
            : description.attached
              ? `${description.name} is attached; this message reaches that Claude Code session as a thread event. Messaging here never starts a run in Coffee Shop.`
              : `${description.name} is not attached right now. The message waits in its inbox and is delivered when the session reconnects.`}
        </p>
        <div className="composer-box">
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={2}
            aria-label={`Message ${description.name}`}
            placeholder={active ? `Message ${description.name}` : "This thread is not active"}
            disabled={!canMutate || !active}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}
          />
          <button aria-label="Send" disabled={!canMutate || !active || !body.trim() || sending}><PaperPlaneTilt size={17} weight="fill" /></button>
        </div>
        {!active && <p className="external-thread-note" role="status">A {thread.status} thread takes no new messages. Reopen it first.</p>}
        {!canMutate && <p className="external-thread-note" role="status">Reconnect to the hub before messaging this thread.</p>}
        {notice && <p className={notice.tone === "error" ? "dialog-error" : "external-thread-note"} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>}
      </form>
    </AccessibleDialog>
  );
}

/** Compatibility name for callers that still describe only the external variant. */
export const ExternalThreadDialog = OrchestratorThreadDialog;
