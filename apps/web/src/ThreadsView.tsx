import { Archive, ArrowCounterClockwise, ChatCircle, FolderOpen, TerminalWindow } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import {
  isActiveRunStatus, type Agent, type Artifact, type OrchestratorAttachment, type OrchestratorClient,
  type Run, type Thread, type ThreadStatus
} from "@coffee-shop/protocol";
import { OrchestratorBadge } from "./OrchestratorBadge.js";
import { describeThreadOrchestrator } from "./orchestratorPresentation.js";

const statusLabels: Record<ThreadStatus, string> = { active: "Active", completed: "Completed", archived: "Archived" };

function timeAgo(date: string) {
  const seconds = Math.max(1, Math.round((Date.now() - new Date(date).getTime()) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function ThreadsView({ threads, runs, artifacts, agents, orchestratorClients, orchestratorAttachments, canMutate, onContinue, onInspectRun, onSetStatus }: {
  threads: Thread[];
  runs: Run[];
  artifacts: Artifact[];
  agents: Agent[];
  orchestratorClients: OrchestratorClient[];
  orchestratorAttachments: OrchestratorAttachment[];
  canMutate: boolean;
  onContinue: (thread: Thread) => void;
  onInspectRun: (runId: string) => void;
  onSetStatus: (thread: Thread, status: ThreadStatus) => Promise<void>;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [updatingId, setUpdatingId] = useState("");
  const [notice, setNotice] = useState("");
  const visible = useMemo(() => threads
    .filter((thread) => showArchived || thread.status !== "archived")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)), [showArchived, threads]);

  async function setStatus(thread: Thread, status: ThreadStatus) {
    setUpdatingId(thread.id);
    setNotice("");
    try {
      await onSetStatus(thread, status);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Could not update the thread");
    } finally {
      setUpdatingId("");
    }
  }

  return (
    <main className="utility-view threads-view">
      <header className="utility-header">
        <div><small>Durable work across agents and runs</small><h1>Threads</h1></div>
        <label className="archive-toggle"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Show archived</label>
      </header>
      <div className="thread-summary">{visible.length} {visible.length === 1 ? "thread" : "threads"}</div>
      {notice && <p className="thread-notice" role="alert">{notice}</p>}
      {visible.length ? <div className="thread-list">{visible.map((thread) => {
        const threadRuns = runs.filter((run) => run.threadId === thread.id);
        const threadArtifacts = artifacts.filter((artifact) => artifact.threadId === thread.id && artifact.uploaded);
        const participantIds = new Set(threadRuns.map((run) => run.agentId));
        const participants = agents.filter((agent) => participantIds.has(agent.id));
        const activeRuns = threadRuns.filter((run) => isActiveRunStatus(run.status));
        const orchestrator = describeThreadOrchestrator(thread, { agents, clients: orchestratorClients, attachments: orchestratorAttachments });
        return <article key={thread.id} className="thread-card">
          <header>
            <div><span className={`thread-status thread-status-${thread.status}`}>{statusLabels[thread.status]}</span><h2>{thread.title}</h2></div>
            <time>{timeAgo(thread.updatedAt)}</time>
          </header>
          <OrchestratorBadge description={orchestrator} />
          <p>{thread.summary || thread.objective}</p>
          <dl>
            <div><dt>Orchestrator</dt><dd>{orchestrator.name}</dd></div>
            <div><dt>Agents</dt><dd>{participants.map((agent) => agent.name).join(", ") || "None yet"}</dd></div>
            <div><dt>Runs</dt><dd>{threadRuns.length}{activeRuns.length ? ` · ${activeRuns.length} active` : ""}</dd></div>
            <div><dt>Artifacts</dt><dd>{threadArtifacts.length}</dd></div>
          </dl>
          {threadRuns.length > 0 && <div className="thread-runs">{threadRuns.slice(0, 5).map((run) => <button key={run.id} onClick={() => onInspectRun(run.id)}><TerminalWindow size={14} /><span>{agents.find((agent) => agent.id === run.agentId)?.name ?? run.agentId}</span><small>{run.status}</small></button>)}</div>}
          <footer>
            {thread.status !== "archived" && <button onClick={() => onContinue(thread)}><ChatCircle size={15} /> {orchestrator.kind === "external" ? "Message orchestrator" : "Continue thread"}</button>}
            {thread.status !== "archived"
              ? <button disabled={!canMutate || updatingId === thread.id || activeRuns.length > 0} onClick={() => void setStatus(thread, "archived")} title={activeRuns.length ? "Finish or cancel active runs before archiving" : undefined}><Archive size={15} /> Archive</button>
              : <button disabled={!canMutate || updatingId === thread.id} onClick={() => void setStatus(thread, "active")}><ArrowCounterClockwise size={15} /> Reopen</button>}
          </footer>
        </article>;
      })}</div> : <div className="threads-empty"><FolderOpen size={24} /><strong>No threads yet</strong><p>Message an agent to start a durable body of work.</p></div>}
    </main>
  );
}
