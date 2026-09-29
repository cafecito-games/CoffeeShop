import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Archive, ArrowCounterClockwise, ArrowLeft, Brain, CaretRight, CircleNotch, ClipboardText, FileCode, ListChecks,
  PaperPlaneTilt, ShieldWarning, TerminalWindow, Warning, Wrench
} from "@phosphor-icons/react";
import {
  isActiveRunStatus, threadOwnerAgentId, type ApprovalRequest, type Run, type RunActivity, type Snapshot,
  type Thread, type ThreadStatus
} from "@coffee-shop/protocol";
import { OrchestratorBadge } from "../OrchestratorBadge.js";
import { actorLabel, describeThreadOrchestrator, type ThreadOrchestratorDescription } from "../orchestratorPresentation.js";
import {
  approvalStatusLabels, runStatusLabels, taskMessageKindLabels, taskStatusLabels, timeAgo, toolCallKindLabels, toolCallStatusLabels
} from "../orchestration/orchestrationLabels.js";
import { buildThreadConversation, transcriptBlocks, type ConversationItem, type TranscriptBlock } from "./threadConversation.js";
import { useRunTranscripts, type TranscriptState } from "./useRunTranscripts.js";
import "./threadConversation.css";

type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

const threadStatusLabels: Record<ThreadStatus, string> = { active: "Active", completed: "Completed", archived: "Archived" };

function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `operator-message-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const transcriptVersion = (run: Run, activity: RunActivity | undefined) => `${activity?.lastSequence ?? 0}:${run.status}`;

/**
 * A thread as a conversation: the operator's messages, each orchestrator turn streamed live from its
 * run transcript, worker tasks where they were created, and a composer that follows up on the
 * thread. Following up on a completed thread reopens it.
 */
export function ThreadConversation({ thread, snapshot, canMutate, apiFetch, onBack, onInspectRun, onReviewApproval, onSetStatus }: {
  thread: Thread;
  snapshot: Snapshot;
  canMutate: boolean;
  apiFetch: ApiFetch;
  onBack: () => void;
  onInspectRun: (runId: string) => void;
  onReviewApproval: (approvalId: string) => void;
  onSetStatus: (thread: Thread, status: ThreadStatus) => Promise<void>;
}) {
  const { runs, messages, events, agents, instances } = snapshot;
  const tasks = useMemo(() => snapshot.tasks ?? [], [snapshot.tasks]);
  const taskMessages = useMemo(() => snapshot.taskMessages ?? [], [snapshot.taskMessages]);
  const approvals = snapshot.approvals ?? [];
  const activityByRun = useMemo(() => new Map((snapshot.runActivity ?? []).map((activity) => [activity.runId, activity])), [snapshot.runActivity]);
  const description = describeThreadOrchestrator(thread, {
    agents, clients: snapshot.orchestratorClients ?? [], attachments: snapshot.orchestratorAttachments ?? [], instances
  });
  const items = useMemo(() => buildThreadConversation({ thread, runs, tasks, messages, taskMessages, events }),
    [thread, runs, tasks, messages, taskMessages, events]);
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());

  // Orchestrator turns always stream; a worker's transcript is fetched only while its card is open.
  const transcriptRuns = useMemo(() => items.flatMap((item) => {
    if (item.kind === "turn") return [item.run];
    if (item.kind === "task" && expandedTasks.has(item.task.id)) return item.attempts.slice(-1);
    return [];
  }), [items, expandedTasks]);
  // The hub records a transcript in the same transaction as the run's activity, so a run without
  // activity has no transcript to fetch.
  const requests = transcriptRuns.filter((run) => activityByRun.has(run.id))
    .map((run) => ({ runId: run.id, version: transcriptVersion(run, activityByRun.get(run.id)) }));
  const transcripts = useRunTranscripts(apiFetch, requests);

  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const contentKey = `${items.length}|${requests.map((request) => request.version).join(",")}|${Object.values(transcripts).map((state) => state.transcript?.lastSequence ?? 0).join(",")}`;
  // Follow the stream while the reader is at the bottom; leave them where they are once they scroll up.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [contentKey]);
  useEffect(() => { pinned.current = true; }, [thread.id]);

  const activeRuns = runs.filter((run) => run.threadId === thread.id && isActiveRunStatus(run.status));
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState("");
  async function changeStatus(status: ThreadStatus) {
    setStatusBusy(true);
    setStatusError("");
    try {
      await onSetStatus(thread, status);
    } catch (cause) {
      setStatusError(cause instanceof Error ? cause.message : "Could not update the thread");
    } finally {
      setStatusBusy(false);
    }
  }

  function toggleTask(taskId: string) {
    setExpandedTasks((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId); else next.add(taskId);
      return next;
    });
  }

  return (
    <main className="chat thread-conversation">
      <header className="chat-header thread-conversation-header">
        <button className="thread-back" onClick={onBack} aria-label="Back to threads"><ArrowLeft size={18} /></button>
        <div className="chat-identity">
          <strong>{thread.title}</strong>
          <span><span className={`thread-status thread-status-${thread.status}`}>{threadStatusLabels[thread.status]}</span> · {description.name}</span>
        </div>
        <div className="thread-conversation-actions">
          {thread.status === "active"
            ? <button className="context-btn" disabled={!canMutate || statusBusy || activeRuns.length > 0} onClick={() => void changeStatus("archived")}
              title={activeRuns.length ? "Finish or cancel active runs before archiving" : undefined}><Archive size={16} /><span>Archive</span></button>
            : <button className="context-btn" disabled={!canMutate || statusBusy} onClick={() => void changeStatus("active")}><ArrowCounterClockwise size={16} /><span>Reopen</span></button>}
        </div>
      </header>
      <div className="chat-scroll" ref={scroller} onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }}>
        <div className="agent-intro thread-intro">
          <OrchestratorBadge description={description} />
          <h1>{thread.title}</h1>
          {thread.summary && thread.summary !== thread.objective && <p>{thread.summary}</p>}
          {statusError && <p className="dialog-error" role="alert">{statusError}</p>}
        </div>
        <div className="messages thread-messages" aria-live="polite">
          {items.length === 0 && <p className="thread-conversation-empty">Nothing has happened in this thread yet.</p>}
          {items.map((item) => <ConversationEntry key={item.id} item={item} snapshot={snapshot} activityByRun={activityByRun}
            transcripts={transcripts} approvals={approvals} description={description} expanded={item.kind === "task" && expandedTasks.has(item.task.id)}
            onToggleTask={toggleTask} onInspectRun={onInspectRun} onReviewApproval={onReviewApproval} />)}
        </div>
      </div>
      <ThreadComposer thread={thread} description={description} canMutate={canMutate} apiFetch={apiFetch} onSent={() => { pinned.current = true; }} />
    </main>
  );
}

function ConversationEntry({ item, snapshot, activityByRun, transcripts, approvals, description, expanded, onToggleTask, onInspectRun, onReviewApproval }: {
  item: ConversationItem;
  snapshot: Snapshot;
  activityByRun: Map<string, RunActivity>;
  transcripts: Record<string, TranscriptState>;
  approvals: ApprovalRequest[];
  description: ThreadOrchestratorDescription;
  expanded: boolean;
  onToggleTask: (taskId: string) => void;
  onInspectRun: (runId: string) => void;
  onReviewApproval: (approvalId: string) => void;
}) {
  switch (item.kind) {
    case "operator":
      return <article className="message user-message"><div className="message-meta"><strong>You</strong><span>{timeAgo(item.at)}</span></div><p>{item.body}</p></article>;
    case "reply":
      return <article className="message agent-message thread-reply">
        <div className="message-meta"><strong>{description.name}</strong>{item.messageKind && <span className="task-message-kind-label">{taskMessageKindLabels[item.messageKind]}</span>}<span>{timeAgo(item.at)}</span></div>
        <p>{item.body}</p>
      </article>;
    case "divider":
      return <div className="thread-divider" role="separator"><span>{item.text}</span><time>{timeAgo(item.at)}</time></div>;
    case "turn":
      return <RunTurn run={item.run} name={actorLabel(item.run, snapshot.agents, snapshot.instances)} activity={activityByRun.get(item.run.id)}
        transcript={transcripts[item.run.id]} reply={item.reply} approvals={approvals} onInspectRun={onInspectRun} onReviewApproval={onReviewApproval} />;
    case "task": {
      const latest = item.attempts.at(-1);
      const activity = latest ? activityByRun.get(latest.id) : undefined;
      const summary = item.task.progress?.completion?.summary ?? item.task.result ?? item.task.progress?.summary ?? activity?.summary;
      const pending = approvals.filter((approval) => approval.taskId === item.task.id && approval.status === "pending");
      return <article className={`thread-task thread-task-${item.task.status}`}>
        <button className="thread-task-toggle" aria-expanded={expanded} onClick={() => onToggleTask(item.task.id)}>
          <CaretRight size={13} className="thread-task-caret" />
          <ClipboardText size={14} />
          <span className="thread-task-title">{item.task.title}</span>
          <span className="thread-task-status">{latest ? actorLabel(latest, snapshot.agents, snapshot.instances) : "Unassigned"} · {taskStatusLabels[item.task.status]}{item.attempts.length > 1 ? ` · ${item.attempts.length} attempts` : ""}</span>
        </button>
        {!expanded && summary && <p className="thread-task-summary">{summary}</p>}
        {item.task.error && <p className="thread-turn-error">{item.task.error}</p>}
        {!expanded && pending.map((approval) => <button key={approval.id} className="timeline-approval" onClick={() => onReviewApproval(approval.id)}><ShieldWarning size={14} weight="fill" /> Approval needed: {approval.title}</button>)}
        {expanded && <div className="thread-task-body">
          <details className="thread-task-instructions"><summary>Instructions</summary><p>{item.task.instructions}</p></details>
          {latest
            ? <RunTurn run={latest} name={actorLabel(latest, snapshot.agents, snapshot.instances)} activity={activity} transcript={transcripts[latest.id]}
              approvals={approvals} onInspectRun={onInspectRun} onReviewApproval={onReviewApproval} nested />
            : <p className="thread-turn-waiting">Waiting for placement…</p>}
        </div>}
      </article>;
    }
  }
}

function RunTurn({ run, name, activity, transcript, reply, approvals, onInspectRun, onReviewApproval, nested = false }: {
  run: Run;
  name: string;
  reply?: string;
  activity?: RunActivity;
  transcript?: TranscriptState;
  approvals: ApprovalRequest[];
  onInspectRun: (runId: string) => void;
  onReviewApproval: (approvalId: string) => void;
  nested?: boolean;
}) {
  const streaming = isActiveRunStatus(run.status);
  const runApprovals = approvals.filter((approval) => approval.runId === run.id);
  const transcriptEntries = transcript?.transcript?.entries ?? [];
  const blocks = transcriptBlocks(transcriptEntries);
  const shownApprovals = new Set(transcriptEntries.flatMap((entry) => entry.kind === "approval" ? [entry.approvalId] : []));
  const unshownPending = runApprovals.filter((approval) => approval.status === "pending" && !shownApprovals.has(approval.harnessApprovalId));
  const fallbackText = activity?.message.text || run.output || reply;
  const transport = run.transportSelection?.selectedTransport ?? run.transport;
  return (
    <article className={`message agent-message thread-turn${streaming ? " thread-turn-streaming" : ""}${nested ? " thread-turn-nested" : ""}`}>
      {!nested && <div className="message-meta">
        {streaming && <span className="timeline-live-pulse" aria-hidden="true" />}
        <strong>{name}</strong>
        <span className={`thread-turn-status thread-turn-status-${run.status}`}>{runStatusLabels[run.status]}</span>
        <span>{timeAgo(run.startedAt ?? run.createdAt)}</span>
      </div>}
      {transcript?.transcript && transcript.transcript.omittedEntries > 0 && <p className="thread-turn-note">{transcript.transcript.omittedEntries} earlier {transcript.transcript.omittedEntries === 1 ? "step was" : "steps were"} trimmed from this turn.</p>}
      {blocks.length > 0
        ? blocks.map((block) => <TranscriptBlockView key={block.key} block={block} run={run} approvals={runApprovals} live={streaming && block === blocks.at(-1)} onReviewApproval={onReviewApproval} />)
        : fallbackText
          ? <p className="thread-turn-text">{fallbackText}</p>
          : streaming
            ? <p className="thread-turn-waiting"><CircleNotch className="spin" size={14} /> {run.status === "queued" ? "Waiting for compute…" : "Working…"}</p>
            : run.status === "completed" ? <p className="thread-turn-note">No reply was recorded for this turn.</p> : null}
      {unshownPending.map((approval) => <button key={approval.id} className="timeline-approval" onClick={() => onReviewApproval(approval.id)}><ShieldWarning size={14} weight="fill" /> Approval needed: {approval.title}</button>)}
      {run.error && <p className="thread-turn-error">{run.error}</p>}
      <div className="thread-turn-footer">
        <button className="run-link" onClick={() => onInspectRun(run.id)}><TerminalWindow size={14} /> Inspect run</button>
        {transport && <span>{transport}{run.transportSelection?.fallbackReason ? " · fell back" : ""}</span>}
        {activity?.usage?.outputTokens !== undefined && <span>{activity.usage.outputTokens} output tokens</span>}
      </div>
    </article>
  );
}

function TranscriptBlockView({ block, run, approvals, live, onReviewApproval }: {
  block: TranscriptBlock;
  run: Run;
  approvals: ApprovalRequest[];
  live: boolean;
  onReviewApproval: (approvalId: string) => void;
}) {
  if (block.kind === "text") {
    return <p className="thread-turn-text">{block.text}{live && <span className="thread-caret" aria-hidden="true" />}</p>;
  }
  const { entry } = block;
  switch (entry.kind) {
    case "thought":
      return <details className="thread-step thread-thought" open={live}>
        <summary><Brain size={13} /> Thinking</summary>
        <p>{entry.text}</p>
      </details>;
    case "tool":
      return <details className={`thread-step thread-tool tool-call-status-${entry.status}`}>
        <summary>
          <Wrench size={13} />
          <span className="tool-call-kind">{toolCallKindLabels[entry.toolKind]}</span>
          <code>{entry.title}</code>
          <span className="thread-tool-status">{entry.status === "in-progress" || entry.status === "pending" ? <CircleNotch className="spin" size={12} /> : null}{toolCallStatusLabels[entry.status]}</span>
        </summary>
        {entry.detail ? <pre>{entry.detail}</pre> : <p className="thread-turn-note">No details were reported.</p>}
      </details>;
    case "terminal":
      return <details className="thread-step thread-terminal" open={live}>
        <summary><TerminalWindow size={13} /> {entry.stream === "stderr" ? "stderr" : "Output"}</summary>
        <pre>{entry.text}</pre>
      </details>;
    case "diff":
      return <details className="thread-step thread-diff">
        <summary><FileCode size={13} /> <code>{entry.path}</code>{entry.truncated && <span className="truncation-note">truncated</span>}</summary>
        <pre>{entry.newText || "(no content)"}</pre>
      </details>;
    case "plan":
      return <div className="thread-step thread-plan">
        <div className="thread-step-heading"><ListChecks size={13} /> Plan</div>
        <ul className="run-plan">{entry.entries.map((item, index) => <li key={`${index}:${item.content}`} className={`plan-status-${item.status} plan-priority-${item.priority}`}>{item.content}</li>)}</ul>
      </div>;
    case "approval": {
      const request = approvals.find((approval) => approval.harnessApprovalId === entry.approvalId && approval.runId === run.id);
      const status = request?.status ?? entry.status;
      return <div className={`thread-step thread-approval approval-status-${status}`}>
        <div className="thread-step-heading"><ShieldWarning size={13} weight="fill" /> {entry.title}<span className={`approval-status approval-status-${status}`}>{approvalStatusLabels[status]}</span></div>
        {entry.detail && <pre>{entry.detail}</pre>}
        {request && status === "pending" && <button className="timeline-approval" onClick={() => onReviewApproval(request.id)}>Review approval</button>}
      </div>;
    }
    case "warning":
      return <p className="thread-step thread-warning"><Warning size={13} /> <code>{entry.code}</code> {entry.message}</p>;
  }
}

function ThreadComposer({ thread, description, canMutate, apiFetch, onSent }: {
  thread: Thread;
  description: ThreadOrchestratorDescription;
  canMutate: boolean;
  apiFetch: ApiFetch;
  onSent: () => void;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  // A send whose response is lost leaves the draft in place. Retrying it reuses the key the hub
  // already saw, so its replay answers instead of appending the message a second time.
  const attempt = useRef<{ body: string; idempotencyKey: string } | undefined>(undefined);
  const archived = thread.status === "archived";
  const ownerAgentId = threadOwnerAgentId(thread);
  const messageable = description.kind === "instance" || description.kind === "external" || (description.kind === "agent" && ownerAgentId !== undefined);
  const disabled = !canMutate || archived || !messageable;

  async function send(event: FormEvent) {
    event.preventDefault();
    const value = body.trim();
    if (!value || sending || disabled) return;
    setSending(true);
    setError("");
    if (attempt.current?.body !== value) attempt.current = { body: value, idempotencyKey: newIdempotencyKey() };
    try {
      const response = description.kind === "agent"
        ? await apiFetch(`/api/agents/${encodeURIComponent(ownerAgentId!)}/messages`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: value, threadId: thread.id })
        })
        : await apiFetch(`/api/threads/${encodeURIComponent(thread.id)}/messages`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: value, idempotencyKey: attempt.current.idempotencyKey })
        });
      if (response.ok) {
        attempt.current = undefined;
        setBody("");
        onSent();
        return;
      }
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (response.status === 404) throw new Error("This thread no longer has a messageable orchestrator.");
      throw new Error(payload.error ?? `The message could not be delivered (${response.status})`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The message could not be delivered");
    } finally {
      setSending(false);
    }
  }

  const hint = archived ? "This thread is archived. Reopen it to continue the conversation."
    : !messageable ? "This thread has no orchestrator that can take messages."
      : thread.status === "completed" ? `Sending reopens this thread and wakes ${description.name}.`
        : description.kind === "external"
          ? description.attached ? `${description.name} is attached and receives this as a thread event.` : `${description.name} is not attached; the message waits in its inbox until it reconnects.`
          : description.kind === "instance" ? `${description.name} is woken on its resident compute to answer.` : `${description.name} answers in a new turn.`;

  return (
    <form className="composer thread-composer" onSubmit={send}>
      <p className="composer-hint">{hint}</p>
      <div className="composer-box">
        <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={1} aria-label={`Message ${description.name}`}
          placeholder={disabled ? (canMutate ? "This thread takes no messages" : "Messaging is unavailable") : `Message ${description.name}`}
          disabled={disabled}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        <button aria-label="Send" disabled={disabled || !body.trim() || sending}>{sending ? <CircleNotch className="spin" size={16} /> : <PaperPlaneTilt size={17} weight="fill" />}</button>
      </div>
      {error && <p className="dialog-error" role="alert">{error}</p>}
    </form>
  );
}
