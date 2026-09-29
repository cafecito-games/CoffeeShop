import { Archive, ArrowCounterClockwise, ChatCircle, DownloadSimple, FolderOpen, Plus, TerminalWindow } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import {
  artifactSource, isActiveRunStatus, type Agent, type AgentInstance, type Artifact, type ArtifactPreview, type OrchestratorAttachment, type OrchestratorClient,
  type Run, type Thread, type ThreadStatus
} from "@coffee-shop/protocol";
import { OrchestratorBadge } from "./OrchestratorBadge.js";
import { actorLabel, describeThreadOrchestrator, externalArtifactProducerLabel } from "./orchestratorPresentation.js";
import { PreviewArtifact, type AuthenticatedFetch } from "./PreviewArtifact.js";

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

export function ThreadsView({ threads, runs, artifacts, artifactPreviews, agents, instances, orchestratorClients, orchestratorAttachments, canMutate, apiFetch, onCreate, onOpen, onInspectRun, onSetStatus }: {
  threads: Thread[];
  runs: Run[];
  artifacts: Artifact[];
  artifactPreviews?: ArtifactPreview[];
  agents: Agent[];
  instances?: AgentInstance[];
  orchestratorClients: OrchestratorClient[];
  orchestratorAttachments: OrchestratorAttachment[];
  canMutate: boolean;
  apiFetch: AuthenticatedFetch;
  onCreate: () => void;
  /** Opens the thread's conversation, where it is followed and continued. */
  onOpen: (thread: Thread) => void;
  onInspectRun: (runId: string) => void;
  onSetStatus: (thread: Thread, status: ThreadStatus) => Promise<void>;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [updatingId, setUpdatingId] = useState("");
  const [downloadingId, setDownloadingId] = useState("");
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

  async function downloadArtifact(artifact: Artifact) {
    if (downloadingId) return;
    setDownloadingId(artifact.id);
    setNotice("");
    try {
      const response = await apiFetch(artifact.downloadPath);
      if (!response.ok) throw new Error();
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = artifact.relativePath.split("/").at(-1) || artifact.title;
      link.click();
      URL.revokeObjectURL(objectUrl);
    } catch {
      setNotice("Artifact download unavailable");
    } finally {
      setDownloadingId("");
    }
  }

  return (
    <main className="utility-view threads-view">
      <header className="utility-header">
        <div><small>Durable work across agents and runs</small><h1>Threads</h1></div>
        <div className="thread-header-actions"><label className="archive-toggle"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Show archived</label><button className="thread-create" onClick={onCreate} disabled={!canMutate}><Plus size={15} /> Start thread</button></div>
      </header>
      <div className="thread-summary">{visible.length} {visible.length === 1 ? "thread" : "threads"}</div>
      {notice && <p className="thread-notice" role="alert">{notice}</p>}
      {visible.length ? <div className="thread-list">{visible.map((thread) => {
        const threadRuns = runs.filter((run) => run.threadId === thread.id);
        const threadArtifacts = artifacts.filter((artifact) => artifact.threadId === thread.id && artifact.uploaded);
        const previewByArtifact = new Map((artifactPreviews ?? []).filter((preview) => preview.threadId === thread.id)
          .map((preview) => [preview.artifactId, preview]));
        const externalArtifacts = threadArtifacts.filter((artifact) => {
          const source = artifactSource(artifact);
          return source.ok && source.value.kind === "external" && !previewByArtifact.has(artifact.id);
        });
        const participantIds = new Set(threadRuns.map((run) => run.agentId));
        const participants = agents.filter((agent) => participantIds.has(agent.id));
        const activeRuns = threadRuns.filter((run) => isActiveRunStatus(run.status));
        const orchestrator = describeThreadOrchestrator(thread, { agents, clients: orchestratorClients, attachments: orchestratorAttachments, instances });
        return <article key={thread.id} className="thread-card">
          <header>
            <div><span className={`thread-status thread-status-${thread.status}`}>{statusLabels[thread.status]}</span><h2><button className="thread-title-link" onClick={() => onOpen(thread)}>{thread.title}</button></h2></div>
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
          {threadRuns.length > 0 && <div className="thread-runs">{threadRuns.slice(0, 5).map((run) => <button key={run.id} onClick={() => onInspectRun(run.id)}><TerminalWindow size={14} /><span>{actorLabel(run, agents)}</span><small>{run.status}</small></button>)}</div>}
          {threadArtifacts.some((artifact) => previewByArtifact.has(artifact.id)) && <section className="thread-previews" aria-label={`Previews for ${thread.title}`}>{threadArtifacts.map((artifact) => {
            const preview = previewByArtifact.get(artifact.id);
            return preview ? <PreviewArtifact key={artifact.id} artifact={artifact} preview={preview}
              orchestratorClients={orchestratorClients} canMutate={canMutate} apiFetch={apiFetch} compact /> : null;
          })}</section>}
          {externalArtifacts.length > 0 && <section className="thread-artifacts" aria-label={`External artifacts for ${thread.title}`}>
            {externalArtifacts.map((artifact) => <article key={artifact.id} className="external-artifact">
              <div><span>External artifact · {artifact.kind}</span><h4>{artifact.title}</h4>{artifact.summary && <p>{artifact.summary}</p>}<small>Published by {externalArtifactProducerLabel(artifact, orchestratorClients)}</small></div>
              <button disabled={downloadingId !== ""} onClick={() => void downloadArtifact(artifact)} aria-label={`Download external artifact ${artifact.title}`}><DownloadSimple size={15} /> Download</button>
            </article>)}
          </section>}
          <footer>
            <button onClick={() => onOpen(thread)}><ChatCircle size={15} /> {activeRuns.length ? "Follow live" : thread.status === "archived" ? "View conversation" : "Open conversation"}</button>
            {thread.status !== "active" && <button disabled={!canMutate || updatingId === thread.id} onClick={() => void setStatus(thread, "active")}><ArrowCounterClockwise size={15} /> Reopen</button>}
            {thread.status !== "archived" && <button disabled={!canMutate || updatingId === thread.id || activeRuns.length > 0} onClick={() => void setStatus(thread, "archived")} title={activeRuns.length ? "Finish or cancel active runs before archiving" : undefined}><Archive size={15} /> Archive</button>}
          </footer>
        </article>;
      })}</div> : <div className="threads-empty"><FolderOpen size={24} /><strong>No threads yet</strong><p>Start with an objective. Coffee Shop will place a resident orchestrator to plan and coordinate the work.</p><button className="thread-create" onClick={onCreate} disabled={!canMutate}><Plus size={15} /> Start orchestrated thread</button></div>}
    </main>
  );
}
