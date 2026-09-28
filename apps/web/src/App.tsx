import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Pulse as Activity, ArrowLeft, ArrowRight, Broadcast, Check, CircleNotch, Command,
  Coffee, Cpu, FolderOpen, Gear, GitBranch, MagnifyingGlass, PaperPlaneTilt, Plus, ShieldWarning,
  Robot, SlidersHorizontal, TerminalWindow, UsersThree, WarningCircle, X, LockKey, Stack, Copy
} from "@phosphor-icons/react";
import {
  isActiveRunStatus, threadOwnerAgentId, type Agent, type AgentState, type ApprovalRequest, type Artifact, type ChatMessage,
  type ComputeNode, type HarnessSessionBinding, type Run, type RunActivity, type RunStatus, type Snapshot, type Thread, type ThreadStatus
} from "@coffee-shop/protocol";
import { AccessibleDialog } from "./AccessibleDialog.js";
import { useViewportMetrics } from "./useViewportMetrics.js";
import { ActivityView } from "./ActivityView.js";
import { AgentConfigurationForm, type AgentConfigurationPayload } from "./AgentConfiguration.js";
import { CoffeeAvatar } from "./CoffeeAvatar.js";
import { ComputeView } from "./compute/ComputeView.js";
import { ExternalThreadDialog } from "./ExternalThreadDialog.js";
import { actorLabel, describeThreadOrchestrator } from "./orchestratorPresentation.js";
import { useHubConnection, type ConnectionStatus } from "./hubConnection.js";
import { AgentTimelineItem, buildAgentTimeline, type AgentTimelineEntry } from "./orchestration/AgentWorkTimeline.js";
import { ApprovalDialog } from "./orchestration/ApprovalsView.js";
import { ProviderSessionCard, providerSessionForRun, providerSessionsForAgent, type ProviderSessionReference } from "./orchestration/ProviderSessions.js";
import { OrchestrationView } from "./orchestration/OrchestrationView.js";
import { RunActivityPanel } from "./orchestration/RunActivityPanel.js";
import { SettingsView } from "./settings/SettingsView.js";
import { ProjectsView } from "./ProjectsView.js";
import { ThreadsView } from "./ThreadsView.js";
import { PwaInstallProvider } from "./settings/PwaInstall.js";
import {
  CreateInstanceDialog, InstanceDetail, InstanceSidebar, MobileInstanceIndex, ReleaseInstanceDialog,
  type CreateInstancePayload
} from "./instances/InstancesView.js";
import {
  DeleteTemplateDialog, MobileTemplateIndex, TemplateDetail, TemplateEditorDialog, TemplateSidebar,
  type TemplateChanges
} from "./templates/TemplatesView.js";
import { StableActions, type StableActionResponse } from "./stableActions.js";

type View = "instances" | "templates" | "agents" | "threads" | "activity" | "orchestration" | "projects" | "compute" | "settings";

const statusLabels: Record<AgentState, string> = { idle: "Idle", thinking: "Thinking", working: "Working", waiting: "Waiting", blocked: "Blocked", done: "Done" };
const connectionLabels: Record<ConnectionStatus, string> = {
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting · stale",
  disconnected: "Disconnected · stale",
  "authentication-required": "Authentication required"
};
const queryToken = new URLSearchParams(location.search).get("token");
if (queryToken) { localStorage.setItem("coffee-shop-token", queryToken); history.replaceState({}, "", location.pathname); }
const accessToken = localStorage.getItem("coffee-shop-token") ?? "";
const apiFetch = (path: string, init: RequestInit = {}) => fetch(path, { ...init, headers: { ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}), ...init.headers } });

function timeAgo(date: string) {
  const seconds = Math.max(1, Math.round((Date.now() - new Date(date).getTime()) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function Avatar({ agent, size = "md" }: { agent: Agent; size?: "sm" | "md" | "lg" }) {
  return <CoffeeAvatar shape={agent.avatarShape} color={agent.avatarColor} size={size} state={agent.state} label={`${agent.name}: ${statusLabels[agent.state]}`} />;
}

function StateMark({ state }: { state: AgentState }) {
  return <span className={`state-mark state-${state}`}><i />{statusLabels[state]}</span>;
}

function Roster({ agents, selectedId, onSelect, onCreate, connection, canMutate }: { agents: Agent[]; selectedId?: string; onSelect: (id: string) => void; onCreate: () => void; connection: ConnectionStatus; canMutate: boolean }) {
  const [query, setQuery] = useState("");
  const filtered = agents.filter((agent) => `${agent.name} ${agent.title}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <aside className="roster">
      <div className="brand-row"><strong>Agent roster</strong><button className="icon-btn" onClick={onCreate} aria-label="Create agent" disabled={!canMutate}><Plus size={17} /></button></div>
      <label className="search"><MagnifyingGlass size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find an agent" /></label>
      <div className="section-label"><span>Agents</span><small>{agents.filter((a) => ["working", "thinking"].includes(a.state)).length} active</small></div>
      <div className="agent-list">
        {filtered.map((agent) => (
          <button key={agent.id} className={`agent-row ${selectedId === agent.id ? "selected" : ""}`} onClick={() => onSelect(agent.id)}>
            <Avatar agent={agent} />
            <span className="agent-copy"><span><strong>{agent.name}</strong><time>{timeAgo(agent.updatedAt)}</time></span><em>{agent.currentAction}</em></span>
            {agent.unread > 0 && <span className="unread">{agent.unread}</span>}
          </button>
        ))}
      </div>
      <div className="roster-foot"><span><i className={connection === "connected" ? "online-dot" : "offline-dot"} /> {connectionLabels[connection]}</span><small>Local-first</small></div>
    </aside>
  );
}

function EmptyAgents({ agents, onSelect, onCreate, canMutate }: { agents: Agent[]; onSelect: (id: string) => void; onCreate: () => void; canMutate: boolean }) {
  const active = agents.filter((agent) => ["working", "thinking", "waiting"].includes(agent.state));
  return (
    <main className="mobile-list-view">
      <header className="mobile-header"><div className="brand-mark"><span /><span /></div><strong>Coffee Shop</strong><button className="icon-btn" onClick={onCreate} aria-label="Create agent" disabled={!canMutate}><Plus size={18} /></button></header>
      <section className="mobile-overview">
        <div><small>Today</small><h1>Your agents</h1></div>
        <div className="signal"><Broadcast size={16} weight="fill" />{active.length} in motion</div>
      </section>
      <div className="mobile-agent-list">
        {agents.map((agent) => (
          <button key={agent.id} className="mobile-agent" onClick={() => onSelect(agent.id)}>
            <Avatar agent={agent} size="lg" />
            <span><span className="mobile-agent-heading"><strong>{agent.name}</strong><StateMark state={agent.state} /></span><em>{agent.title}</em><p>{agent.currentAction}</p></span>
            <ArrowRight size={18} />
          </button>
        ))}
      </div>
    </main>
  );
}

function Chat({ agent, timeline, nodes, threads, viewableThreads, threadFilter, selectedThreadId, orchestratorName, sending, inspectorOpen, onBack, onSend, onThreadChange, onThreadFilterChange, onInspector, onInspectRun, onReviewApproval, canMutate }: {
  agent: Agent; timeline: AgentTimelineEntry[]; nodes: ComputeNode[];
  /** Threads this agent owns, which operator messages can continue. */
  threads: Thread[];
  /** Threads this agent owns or worked in, which the chat can be filtered to. */
  viewableThreads: Thread[];
  threadFilter: string; selectedThreadId: string;
  /** Set for a worker whose task work belongs to another agent's thread. */
  orchestratorName?: string;
  sending: boolean; inspectorOpen: boolean;
  onBack: () => void; onSend: (body: string) => Promise<void>; onThreadChange: (id: string) => void; onThreadFilterChange: (id: string) => void;
  onInspector: () => void; onInspectRun: (id: string) => void; onReviewApproval: (id: string) => void; canMutate: boolean;
}) {
  const [body, setBody] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const node = nodes.find((item) => item.id === agent.computeNodeId);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [timeline.length]);
  // Keep the newest entry visible when the on-screen keyboard opens and shrinks the viewport.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const pinToLatest = () => endRef.current?.scrollIntoView({ block: "end" });
    viewport.addEventListener("resize", pinToLatest);
    return () => viewport.removeEventListener("resize", pinToLatest);
  }, []);
  async function submit(event: FormEvent) { event.preventDefault(); const value = body.trim(); if (!value || sending || !canMutate) return; setBody(""); await onSend(value); }
  return (
    <main className="chat">
      <header className="chat-header">
        <button className="back-btn" onClick={onBack}><ArrowLeft size={19} /></button>
        <Avatar agent={agent} />
        <div className="chat-identity"><strong>{agent.name}</strong><span><StateMark state={agent.state} /> · {node?.name ?? "Unassigned"}</span></div>
        <button className="context-btn" onClick={onInspector} aria-expanded={inspectorOpen} aria-haspopup="dialog"><SlidersHorizontal size={18} /><span>Context</span></button>
      </header>
      <div className="chat-scroll">
        <div className="agent-intro"><Avatar agent={agent} size="lg" /><h1>{agent.name}</h1><p>{agent.title}</p><small>{agent.summary}</small></div>
        {viewableThreads.length > 0 && (
          <div className="thread-filter" role="group" aria-label="Show activity from">
            <span>Show</span>
            <button aria-pressed={threadFilter === ""} onClick={() => onThreadFilterChange("")}>All</button>
            {viewableThreads.map((thread) => <button key={thread.id} aria-pressed={threadFilter === thread.id} onClick={() => onThreadFilterChange(thread.id)}>{thread.title}</button>)}
          </div>
        )}
        <div className="messages">
          {timeline.map((entry) => entry.kind === "chat"
            ? <Message key={entry.id} message={entry.message} agent={agent} onInspectRun={onInspectRun} />
            : <AgentTimelineItem key={entry.id} entry={entry} onInspectRun={onInspectRun} onReviewApproval={onReviewApproval} />)}
          {sending && <div className="message agent-message pending"><div className="message-meta"><strong>{agent.name}</strong><span>now</span></div><p><CircleNotch className="spin" size={14} /> Dispatching to {node?.name ?? agent.computeNodeId}…</p></div>}
          <div ref={endRef} />
        </div>
      </div>
      <form className="composer" onSubmit={submit}>
        <label className="thread-picker">Send to<select aria-label="Send to" value={selectedThreadId} onChange={(event) => onThreadChange(event.target.value)} disabled={!canMutate || sending}><option value="">New thread</option>{threads.filter((thread) => thread.status !== "archived").map((thread) => <option key={thread.id} value={thread.id}>Continue: {thread.title}{thread.status === "completed" ? " · completed" : ""}</option>)}</select></label>
        {orchestratorName && <p className="composer-hint">Messages here start a separate direct run for {agent.name}, outside its tasks. To steer task work, message {orchestratorName}.</p>}
        <div className="composer-box"><textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder={canMutate ? `Message ${agent.name}` : `Reconnect to message ${agent.name}`} rows={1} disabled={!canMutate} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><button aria-label="Send" disabled={!canMutate || !body.trim() || sending}><PaperPlaneTilt size={17} weight="fill" /></button></div>
        <small>{agent.harnessId === "claude-cli" ? "Claude Code" : "Codex"} · {agent.model} · runs on {node?.name ?? "unassigned compute"}</small>
      </form>
    </main>
  );
}

function Message({ message, agent, onInspectRun }: { message: ChatMessage; agent: Agent; onInspectRun: (id: string) => void }) {
  if (message.kind === "handoff") return <div className="handoff-message"><UsersThree size={17} /><div><strong>Agent handoff</strong><p>{message.body}</p></div><time>{timeAgo(message.createdAt)}</time></div>;
  if (message.author === "system") return <div className="system-message"><WarningCircle size={15} />{message.body}</div>;
  return (
    <article className={`message ${message.author === "you" ? "user-message" : "agent-message"}`}>
      <div className="message-meta"><strong>{message.author === "you" ? "You" : agent.name}</strong><span>{timeAgo(message.createdAt)}</span></div>
      <p>{message.body}</p>
      {message.runId && <button className="run-link" onClick={() => onInspectRun(message.runId!)}><TerminalWindow size={14} /> Inspect run</button>}
    </article>
  );
}

function Inspector({ agent, nodes, sessions, onClose, onSave, onReconcile, canMutate }: {
  agent: Agent;
  nodes: ComputeNode[];
  sessions: ProviderSessionReference[];
  onClose: () => void;
  onSave: (payload: AgentConfigurationPayload) => Promise<Agent>;
  onReconcile: () => void;
  canMutate: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const node = nodes.find((item) => item.id === agent.computeNodeId);
  const harness = node?.harnesses.find((item) => item.id === agent.harnessId);
  return (
    <AccessibleDialog labelledBy="agent-context-title" onClose={onClose} className="inspector-dialog">
      <aside className="inspector">
        <header>
          <span id="agent-context-title">{editing ? "Edit agent" : "Agent context"}</span>
          <div className="inspector-actions">
            {!editing && <button className="edit-agent-button" onClick={() => setEditing(true)} disabled={!canMutate}>Edit</button>}
            <button className="icon-btn" onClick={onClose} aria-label="Close agent context" data-dialog-initial-focus><X size={17} /></button>
          </div>
        </header>
        {editing ? (
          <AgentConfigurationForm mode="edit" agent={agent} nodes={nodes} canMutate={canMutate} onSave={onSave} onCancel={() => setEditing(false)} onReconcile={onReconcile} onSuccess={() => setEditing(false)} />
        ) : (
          <>
            <section className="avatar-editor"><div className="section-label"><span>Identity mark</span></div><CoffeeAvatar shape={agent.avatarShape} color={agent.avatarColor} size="xl" /></section>
            <section className="identity-block"><div><h2>{agent.name}</h2><p>{agent.title}</p><small>{agent.summary || "No summary"}</small></div></section>
            <section className="status-block"><span>Current state</span><StateMark state={agent.state} /><p>{agent.currentAction}</p></section>
            <section className="config-section">
              <div className="section-label"><span>Runtime</span></div>
              <dl className="context-details">
                <div><dt>Compute</dt><dd>{node?.name ?? `${agent.computeNodeId} (unavailable)`}</dd></div>
                <div><dt>Harness</dt><dd>{harness?.label ?? agent.harnessId}</dd></div>
                <div><dt>Model</dt><dd>{agent.model}</dd></div>
                <div><dt>Workspace</dt><dd><code>{agent.workspace}</code></dd></div>
                <div><dt>Coordination</dt><dd>{agent.canDelegate ? "May delegate bounded tasks" : "Worker only"}</dd></div>
              </dl>
            </section>
            <section className="config-section">
              <div className="section-label"><span>Sessions</span><small>resume outside Coffee Shop</small></div>
              {sessions.length === 0
                ? <p className="provider-session-empty">No provider sessions recorded yet.</p>
                : sessions.map((reference) => <ProviderSessionCard key={reference.key} reference={reference} nodeName={nodes.find((item) => item.id === reference.nodeId)?.name ?? reference.nodeId} />)}
            </section>
            <section className="prompt-section"><div className="section-label"><span>Purpose</span><small>system prompt</small></div><p>{agent.systemPrompt}</p></section>
            <footer><div><i className={node?.status === "online" || node?.status === "busy" ? "online-dot" : "offline-dot"} /><span>{node?.status ?? "offline"}</span></div><small>Credentials stay on {node?.name ?? "the compute node"}</small></footer>
          </>
        )}
      </aside>
    </AccessibleDialog>
  );
}

const runStatusLabels: Record<RunStatus, string> = {
  queued: "Queued", running: "Running", completed: "Completed", failed: "Failed", cancelled: "Cancelled"
};

function RunInspector({ selectedRunId, run, runs, threads, artifacts, agents, nodes, runActivity, approvals, sessionBindings, onClose, onInspectRun, canMutate }: {
  selectedRunId: string;
  run?: Run;
  runs: Run[];
  threads: Thread[];
  artifacts: Artifact[];
  agents: Agent[];
  nodes: ComputeNode[];
  runActivity: RunActivity[];
  approvals: ApprovalRequest[];
  sessionBindings: HarnessSessionBinding[];
  onClose: () => void;
  onInspectRun: (id: string) => void;
  canMutate: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [notice, setNotice] = useState("");
  const titleId = "run-inspector-title";
  const agent = run ? agents.find((item) => item.id === run.agentId) : undefined;
  const node = run ? nodes.find((item) => item.id === run.nodeId) : undefined;
  const thread = run?.threadId ? threads.find((item) => item.id === run.threadId) : undefined;
  const children = run ? runs.filter((item) => item.parentRunId === run.id) : [];
  const runArtifacts = run ? artifacts.filter((item) => item.runId === run.id && item.uploaded) : [];
  const activity = run ? runActivity.find((item) => item.runId === run.id) : undefined;
  const runApprovals = run ? approvals.filter((item) => item.runId === run.id) : [];
  const sessionBinding = run?.sessionBindingId ? sessionBindings.find((item) => item.id === run.sessionBindingId) : undefined;
  const providerSession = run ? providerSessionForRun(run, sessionBindings) : undefined;

  async function cancelRun() {
    if (!run || !canMutate) return;
    setCancelling(true);
    setNotice("");
    try {
      const response = await apiFetch(`/api/runs/${encodeURIComponent(run.id)}/cancel`, { method: "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Cancellation failed (${response.status})`);
      }
      setConfirming(false);
      setNotice("Cancellation accepted. Waiting for the live run update.");
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Could not cancel this run");
    } finally {
      setCancelling(false);
    }
  }

  async function downloadArtifact(artifact: Artifact) {
    setNotice("");
    try {
      const response = await apiFetch(artifact.downloadPath);
      if (!response.ok) throw new Error(`Artifact download failed (${response.status})`);
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = artifact.relativePath.split("/").at(-1) || artifact.title;
      link.click();
      URL.revokeObjectURL(objectUrl);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Could not download the artifact");
    }
  }

  return (
    <AccessibleDialog labelledBy={titleId} onClose={onClose} className="run-dialog">
      <header>
        <div><small>Execution record</small><h2 id={titleId}>Run {selectedRunId}</h2></div>
        <button className="icon-btn" onClick={onClose} aria-label="Close run inspector" data-dialog-initial-focus><X size={17} /></button>
      </header>
      {!run ? (
        <div className="run-unavailable" role="status"><WarningCircle size={20} /><strong>Run unavailable</strong><p>No run named <code>{selectedRunId}</code> exists in the latest snapshot.</p></div>
      ) : (
        <>
          <div className="run-summary"><span className={`run-status run-status-${run.status}`}>{runStatusLabels[run.status]}</span><code>{run.id}</code></div>
          <dl className="run-details">
            <div><dt>Actor</dt><dd>{agent ? `${agent.name} · ${agent.id}` : run.instanceId ? `${actorLabel(run, agents)} · ${run.instanceId}` : `${run.agentId ?? "Unattributed"} · unavailable`}</dd></div>
            <div><dt>Compute</dt><dd>{node ? `${node.name} · ${node.id}` : `${run.nodeId} · unavailable`}</dd></div>
            <div><dt>Harness / model</dt><dd>{run.harnessId} · {run.model || "Model unavailable"}</dd></div>
            <div><dt>Workspace</dt><dd><code>{run.workspace || "Workspace unavailable"}</code></dd></div>
            <div><dt>Thread</dt><dd>{thread ? `${thread.title} · ${thread.id}` : run.threadId ?? "Legacy run"}</dd></div>
            <div><dt>Parent run</dt><dd>{run.parentRunId ?? "No parent run"}</dd></div>
            <div><dt>Handoff depth</dt><dd>{run.depth}</dd></div>
            <div><dt>Created</dt><dd><time>{run.createdAt || "Timestamp unavailable"}</time></dd></div>
            <div><dt>Dispatched</dt><dd><time>{run.dispatchedAt ?? "Not dispatched yet"}</time></dd></div>
            <div><dt>Started</dt><dd><time>{run.startedAt ?? "Not started yet"}</time></dd></div>
            <div><dt>Finished</dt><dd><time>{run.finishedAt ?? "Not finished yet"}</time></dd></div>
          </dl>
          <section className="run-text"><h3>Prompt</h3><pre>{run.prompt || "Prompt unavailable"}</pre></section>
          <section className="run-text" aria-live="polite"><h3>Output</h3><pre>{run.output || (isActiveRunStatus(run.status) ? "Output is not available yet." : "No output was produced.")}</pre></section>
          <section className="run-text"><h3>Error</h3><pre>{run.error ?? "No error reported."}</pre></section>
          <RunActivityPanel activity={activity} transportSelection={run.transportSelection} sessionBinding={sessionBinding} approvals={runApprovals} />
          {providerSession && <section className="run-text"><h3>Provider session</h3><ProviderSessionCard reference={providerSession} nodeName={node?.name ?? run.nodeId} /></section>}
          {children.length > 0 && <section className="run-related"><h3>Delegated tasks</h3>{children.map((child) => <button key={child.id} onClick={() => onInspectRun(child.id)}><span>{actorLabel(child, agents)}</span><small>{runStatusLabels[child.status]}</small></button>)}</section>}
          {runArtifacts.length > 0 && <section className="run-related"><h3>Artifacts</h3>{runArtifacts.map((artifact) => <button key={artifact.id} onClick={() => void downloadArtifact(artifact)}><span>{artifact.title}</span><small>{artifact.kind} · {artifact.size} bytes</small></button>)}</section>}
          {notice && <p className="run-notice" role="alert">{notice}</p>}
          {isActiveRunStatus(run.status) && (
            <footer className="run-actions">
              {!confirming ? <button className="danger-button" disabled={!canMutate} onClick={() => setConfirming(true)}>Cancel run</button> : <div className="cancel-confirm"><span>Cancel this run?</span><button onClick={() => setConfirming(false)} disabled={cancelling}>Keep run</button><button className="danger-button" onClick={cancelRun} disabled={cancelling || !canMutate}>{cancelling ? "Cancelling…" : "Confirm cancellation"}</button></div>}
            </footer>
          )}
        </>
      )}
    </AccessibleDialog>
  );
}

function FreshnessNotice({ connection, onRetry }: { connection: ConnectionStatus; onRetry: () => void }) {
  if (connection === "connected") return null;
  const waiting = connection === "connecting";
  return <div className="freshness-notice" role="status"><WarningCircle size={15} /><span><strong>{connectionLabels[connection]}</strong>{waiting ? "Waiting for a validated live snapshot." : "Showing last known data. Changes are disabled until the live snapshot is restored."}</span>{!waiting && <button onClick={onRetry} aria-label="Retry connection">Retry</button>}</div>;
}

function BottomNav({ view, onView, pendingApprovalCount, legacy }: { view: View; onView: (view: View) => void; pendingApprovalCount: number; legacy: boolean }) {
  const items: [View, typeof Robot, string][] = legacy ? [
    ["agents", Robot, "Legacy"], ["threads", FolderOpen, "Threads"], ["activity", Activity, "Activity"],
    ["orchestration", ShieldWarning, "Orchestrate"], ["projects", GitBranch, "Projects"], ["compute", Cpu, "Compute"], ["settings", Gear, "Settings"]
  ] : [
    ["instances", Stack, "Instances"], ["templates", Copy, "Templates"], ["threads", FolderOpen, "Threads"],
    ["activity", Activity, "Activity"], ["orchestration", ShieldWarning, "Orchestrate"], ["projects", GitBranch, "Projects"], ["compute", Cpu, "Compute"], ["settings", Gear, "Settings"]
  ];
  return <nav className="bottom-nav">{items.map(([key, Icon, label]) => (
    <button key={key} aria-label={label} className={view === key ? "active" : ""} onClick={() => onView(key)}>
      <Icon size={21} weight={view === key ? "fill" : "regular"} />
      <span aria-hidden="true">{label}</span>
      {key === "orchestration" && pendingApprovalCount > 0 && <span className="unread">{pendingApprovalCount}</span>}
    </button>
  ))}</nav>;
}

function ControlSidebar({ connection, canMutate }: { connection: ConnectionStatus; canMutate: boolean }) {
  return <aside className="roster control-sidebar"><div className="brand-row"><strong>Control plane</strong></div><div className="control-sidebar-copy"><Coffee size={24} /><h2>Coffee Shop</h2><p>Instances carry live identity. Templates stay inert until the Hub places one.</p></div><div className="roster-foot"><span><i className={canMutate ? "online-dot" : "offline-dot"} />{connectionLabels[connection]}</span></div></aside>;
}

function LockScreen() {
  const [value, setValue] = useState("");
  return <main className="lock-screen"><div className="brand-mark"><span /><span /></div><LockKey size={20} /><h1>Connect to your control plane</h1><p>Enter the hub token configured on this deployment. It stays in this browser.</p><form onSubmit={(event) => { event.preventDefault(); if (!value.trim()) return; localStorage.setItem("coffee-shop-token", value.trim()); location.reload(); }}><input type="password" value={value} onChange={(event) => setValue(event.target.value)} placeholder="Hub access token" autoFocus /><button>Connect</button></form></main>;
}

function CoffeeShopApp() {
  useViewportMetrics();
  const { snapshot, status: connection, canMutate, retry } = useHubConnection(accessToken);
  const legacySnapshot = snapshot.instances === undefined;
  const [view, setView] = useState<View>("instances");
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedInstanceId, setSelectedInstanceId] = useState<string>();
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [threadFilter, setThreadFilter] = useState("");
  const [sending, setSending] = useState(false);
  const [creatingInstance, setCreatingInstance] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<"create" | "edit">();
  const [deletingTemplate, setDeletingTemplate] = useState(false);
  const [releasingInstanceId, setReleasingInstanceId] = useState<string>();
  const [instanceMutationBusy, setInstanceMutationBusy] = useState(false);
  const stableActions = useRef(new StableActions());
  const snapshotSettlements = useRef(new Map<string, (snapshot: Snapshot) => boolean>());
  const effectiveView: View = legacySnapshot && (view === "instances" || view === "templates") ? "agents" : view;
  const selected = snapshot.agents.find((agent) => agent.id === selectedId);
  const selectedInstance = snapshot.instances?.find((instance) => instance.id === selectedInstanceId);
  const selectedTemplate = snapshot.templates?.find((template) => template.id === selectedTemplateId);
  const [reviewingApprovalId, setReviewingApprovalId] = useState<string>();
  const [externalThreadId, setExternalThreadId] = useState<string>();
  const orchestratorClients = useMemo(() => snapshot.orchestratorClients ?? [], [snapshot.orchestratorClients]);
  const orchestratorAttachments = useMemo(() => snapshot.orchestratorAttachments ?? [], [snapshot.orchestratorAttachments]);
  const selectedThreads = useMemo(() => (snapshot.threads ?? []).filter((thread) => threadOwnerAgentId(thread) === selectedId), [snapshot.threads, selectedId]);
  const viewableThreads = useMemo(() => {
    const workedIn = new Set(snapshot.runs.filter((run) => run.agentId === selectedId && run.threadId).map((run) => run.threadId!));
    return (snapshot.threads ?? [])
      .filter((thread) => thread.status !== "archived" && (threadOwnerAgentId(thread) === selectedId || workedIn.has(thread.id)))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }, [snapshot.threads, snapshot.runs, selectedId]);
  // A filtered thread that was archived or otherwise left the list falls back to showing everything.
  const effectiveThreadFilter = viewableThreads.some((thread) => thread.id === threadFilter) ? threadFilter : "";
  const { agents, messages, runs, tasks, threads, taskMessages, runActivity, approvals } = snapshot;
  const selectedTimeline = useMemo(() => selectedId ? buildAgentTimeline({
    agentId: selectedId,
    threadId: effectiveThreadFilter || undefined,
    agents,
    messages,
    runs,
    tasks: tasks ?? [],
    threads: threads ?? [],
    taskMessages: taskMessages ?? [],
    runActivity: runActivity ?? [],
    approvals: approvals ?? []
  }) : [], [selectedId, effectiveThreadFilter, agents, messages, runs, tasks, threads, taskMessages, runActivity, approvals]);
  const reviewingApproval = (snapshot.approvals ?? []).find((approval) => approval.id === reviewingApprovalId);
  const externalThread = (snapshot.threads ?? []).find((thread) => thread.id === externalThreadId);
  const orchestratorName = useMemo(() => {
    const ownerId = viewableThreads.map(threadOwnerAgentId).find((owner) => owner !== undefined && owner !== selectedId);
    return ownerId ? snapshot.agents.find((agent) => agent.id === ownerId)?.name ?? ownerId : undefined;
  }, [viewableThreads, selectedId, snapshot.agents]);
  function chooseSendTarget(threadId: string) {
    setSelectedThreadId(threadId);
    setThreadFilter(threadId);
  }
  function chooseThreadFilter(threadId: string) {
    setThreadFilter(threadId);
    if (selectedThreads.some((thread) => thread.id === threadId)) setSelectedThreadId(threadId);
  }
  const pendingApprovalCount = useMemo(() => (snapshot.approvals ?? []).filter((approval) => approval.status === "pending").length, [snapshot.approvals]);

  async function mutationResponse<T>(response: Response): Promise<StableActionResponse<T>> {
    const body = await response.json().catch(() => ({})) as T & { error?: string };
    return { ok: response.ok, status: response.status, ...(response.ok ? { value: body } : { error: body.error ?? `Request failed (${response.status})` }) };
  }

  async function performMutation<T>(action: string, argumentsValue: unknown, request: (key: string) => Promise<Response>) {
    const result = await stableActions.current.submit(action, argumentsValue, async (key) => mutationResponse<T>(await request(key)));
    if (!result.ok) throw new Error(result.error ?? `Request failed (${result.status})`);
    return result.value as T;
  }

  async function send(body: string) {
    if (!selected || !canMutate) return;
    setSending(true);
    try {
      const response = await apiFetch(`/api/agents/${selected.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body, threadId: selectedThreadId || undefined }) });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(failure.error ?? `Could not send message (${response.status})`);
      }
      const run = await response.json() as Run;
      if (run.threadId) { setSelectedThreadId(run.threadId); setThreadFilter(run.threadId); }
    }
    finally { setSending(false); }
  }

  async function setThreadStatus(thread: Thread, status: ThreadStatus) {
    if (!canMutate) throw new Error("Reconnect before updating a thread");
    const response = await apiFetch(`/api/threads/${encodeURIComponent(thread.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(failure.error ?? `Could not update thread (${response.status})`);
    }
  }

  async function updateAgent(payload: AgentConfigurationPayload) {
    if (!selected || !canMutate) throw new Error("Reconnect before saving agent configuration");
    const response = await apiFetch(`/api/agents/${encodeURIComponent(selected.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Could not save agent (${response.status})`);
    }
    return response.json() as Promise<Agent>;
  }

  function selectAgent(id: string) { setSelectedId(id); setSelectedThreadId(""); setThreadFilter(""); setView("agents"); setInspectorOpen(false); setSelectedRunId(undefined); }
  /** An externally orchestrated thread has no agent chat: it is messaged through its orchestrator. */
  function continueThread(thread: Thread) {
    if (describeThreadOrchestrator(thread, { agents: snapshot.agents, clients: orchestratorClients, attachments: orchestratorAttachments }).kind === "external") {
      setExternalThreadId(thread.id);
      return;
    }
    if (!legacySnapshot) {
      setView("orchestration");
      return;
    }
    setSelectedId(threadOwnerAgentId(thread));
    setSelectedThreadId(thread.id);
    setThreadFilter(thread.id);
    setView("agents");
    setInspectorOpen(false);
  }
  function switchView(next: View) { setView(next); if (next !== "agents") setSelectedId(undefined); }
  async function createInstance(payload: CreateInstancePayload) {
    setInstanceMutationBusy(true);
    try {
      const { threadId, ...argumentsValue } = payload;
      const action = `instance:create:${threadId}`;
      const before = new Set((snapshot.instances ?? []).map((instance) => instance.id));
      snapshotSettlements.current.set(action, (next) => (next.instances ?? []).some((instance) => !before.has(instance.id)
        && instance.threadId === threadId && instance.creator.kind === "operator"
        && instance.requirements.templateId === argumentsValue.requirements.templateId
        && instance.purpose?.name === argumentsValue.purpose?.name));
      const result = await performMutation<{ instance: { id: string } }>(action, argumentsValue, (idempotencyKey) => apiFetch(`/api/threads/${encodeURIComponent(threadId)}/instances`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...argumentsValue, idempotencyKey })
      }));
      setSelectedInstanceId(result.instance.id);
    } finally {
      if (!stableActions.current.pendingKey(`instance:create:${payload.threadId}`)) snapshotSettlements.current.delete(`instance:create:${payload.threadId}`);
      setInstanceMutationBusy(false);
    }
  }

  async function renewInstance(instance: NonNullable<typeof selectedInstance>) {
    setInstanceMutationBusy(true);
    const argumentsValue = { idleTimeoutSeconds: instance.lease.idleTimeoutSeconds };
    const action = `instance:renew:${instance.id}`;
    snapshotSettlements.current.set(action, (next) => next.instances?.some((candidate) => candidate.id === instance.id && candidate.lease.expiresAt !== instance.lease.expiresAt) ?? false);
    try {
      await performMutation(action, argumentsValue, (idempotencyKey) => apiFetch(`/api/threads/${encodeURIComponent(instance.threadId)}/instances/${encodeURIComponent(instance.id)}/renew`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...argumentsValue, idempotencyKey })
      }));
    } finally { if (!stableActions.current.pendingKey(action)) snapshotSettlements.current.delete(action); setInstanceMutationBusy(false); }
  }

  async function releaseInstance(instance: NonNullable<typeof selectedInstance>, mode: "drain" | "cancel") {
    setInstanceMutationBusy(true);
    const action = `instance:release:${instance.id}`;
    snapshotSettlements.current.set(action, (next) => next.instances?.some((candidate) => candidate.id === instance.id && ["draining", "released", "failed"].includes(candidate.status)) ?? false);
    try {
      await performMutation(action, { mode }, (idempotencyKey) => apiFetch(`/api/threads/${encodeURIComponent(instance.threadId)}/instances/${encodeURIComponent(instance.id)}/release`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, idempotencyKey })
      }));
    } finally { if (!stableActions.current.pendingKey(action)) snapshotSettlements.current.delete(action); setInstanceMutationBusy(false); }
  }

  async function saveTemplate(changes: TemplateChanges) {
    const target = editingTemplate === "edit" ? selectedTemplate : undefined;
    const action = target ? `template:update:${target.id}` : "template:create";
    const path = target ? `/api/agent-templates/${encodeURIComponent(target.id)}` : "/api/agent-templates";
    const before = new Set((snapshot.templates ?? []).map((template) => template.id));
    snapshotSettlements.current.set(action, (next) => (next.templates ?? []).some((template) =>
      (target ? template.id === target.id : !before.has(template.id))
      && template.name === changes.name
      && Object.entries(changes).every(([key, value]) => JSON.stringify(template[key as keyof typeof template]) === JSON.stringify(value))));
    try {
      const result = await performMutation<{ template: { id: string } }>(action, changes, (idempotencyKey) => apiFetch(path, {
        method: target ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...changes, idempotencyKey })
      }));
      setSelectedTemplateId(result.template.id);
    } finally { if (!stableActions.current.pendingKey(action)) snapshotSettlements.current.delete(action); }
  }

  async function deleteTemplate() {
    if (!selectedTemplate) return;
    const action = `template:delete:${selectedTemplate.id}`;
    snapshotSettlements.current.set(action, (next) => !(next.templates ?? []).some((template) => template.id === selectedTemplate.id));
    try {
      await performMutation(action, {}, (idempotencyKey) => apiFetch(`/api/agent-templates/${encodeURIComponent(selectedTemplate.id)}`, {
        method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey })
      }));
      setSelectedTemplateId(undefined);
    } finally { if (!stableActions.current.pendingKey(action)) snapshotSettlements.current.delete(action); }
  }

  useEffect(() => {
    for (const [action, settled] of snapshotSettlements.current) {
      if (settled(snapshot)) {
        stableActions.current.settle(action);
        snapshotSettlements.current.delete(action);
      }
    }
  }, [snapshot]);

  if (connection === "authentication-required") return <LockScreen />;

  return (
    <div className="app-shell">
      {legacySnapshot
        ? <Roster agents={snapshot.agents} selectedId={selectedId} onSelect={selectAgent} onCreate={() => undefined} connection={connection} canMutate={false} />
        : effectiveView === "instances"
          ? <InstanceSidebar instances={snapshot.instances ?? []} threads={snapshot.threads ?? []} selectedId={selectedInstanceId} connectionLabel={connectionLabels[connection]} canMutate={canMutate} onSelect={setSelectedInstanceId} onCreate={() => setCreatingInstance(true)} />
          : effectiveView === "templates"
            ? <TemplateSidebar templates={snapshot.templates ?? []} selectedId={selectedTemplateId} canMutate={canMutate} connectionLabel={connectionLabels[connection]} onSelect={setSelectedTemplateId} onCreate={() => setEditingTemplate("create")} />
            : <ControlSidebar connection={connection} canMutate={canMutate} />}
      <div className="workspace">
        <FreshnessNotice connection={connection} onRetry={retry} />
        {legacySnapshot && <div className="legacy-agent-notice" role="status"><WarningCircle size={15} /><span><strong>Read-only legacy agents</strong>This Hub has not published the complete instance, allocation, and template contract.</span></div>}
        {effectiveView === "agents" && !selected && <EmptyAgents agents={snapshot.agents} onSelect={selectAgent} onCreate={() => undefined} canMutate={false} />}
        {effectiveView === "agents" && selected && <Chat agent={selected} nodes={snapshot.nodes} threads={selectedThreads} viewableThreads={viewableThreads} threadFilter={effectiveThreadFilter} orchestratorName={orchestratorName} selectedThreadId={selectedThreadId} timeline={selectedTimeline} sending={sending} inspectorOpen={inspectorOpen} onBack={() => setSelectedId(undefined)} onSend={send} onThreadChange={chooseSendTarget} onThreadFilterChange={chooseThreadFilter} onInspector={() => setInspectorOpen((open) => !open)} onInspectRun={setSelectedRunId} onReviewApproval={setReviewingApprovalId} canMutate={false} />}
        {effectiveView === "instances" && !selectedInstance && <MobileInstanceIndex instances={snapshot.instances ?? []} threads={snapshot.threads ?? []} canMutate={canMutate} onSelect={setSelectedInstanceId} onCreate={() => setCreatingInstance(true)} />}
        {effectiveView === "instances" && <InstanceDetail instance={selectedInstance} allocations={snapshot.allocations ?? []} nodes={snapshot.nodes} runs={snapshot.runs} tasks={snapshot.tasks ?? []} threads={snapshot.threads ?? []} canMutate={canMutate} busy={instanceMutationBusy} onRenew={renewInstance} onRelease={(instance) => setReleasingInstanceId(instance.id)} onInspectRun={setSelectedRunId} onBack={() => setSelectedInstanceId(undefined)} />}
        {effectiveView === "templates" && !selectedTemplate && <MobileTemplateIndex templates={snapshot.templates ?? []} canMutate={canMutate} onSelect={setSelectedTemplateId} onCreate={() => setEditingTemplate("create")} />}
        {effectiveView === "templates" && <TemplateDetail template={selectedTemplate} canMutate={canMutate} onEdit={() => setEditingTemplate("edit")} onDelete={() => setDeletingTemplate(true)} onBack={() => setSelectedTemplateId(undefined)} />}
        {effectiveView === "threads" && <ThreadsView threads={snapshot.threads ?? []} runs={snapshot.runs} artifacts={snapshot.artifacts ?? []} agents={snapshot.agents} orchestratorClients={orchestratorClients} orchestratorAttachments={orchestratorAttachments} canMutate={canMutate} onContinue={continueThread} onInspectRun={setSelectedRunId} onSetStatus={setThreadStatus} />}
        {effectiveView === "activity" && <ActivityView events={snapshot.events} agents={snapshot.agents} onInspectRun={setSelectedRunId} />}
        {effectiveView === "orchestration" && (
          <OrchestrationView
            threads={snapshot.threads ?? []}
            tasks={snapshot.tasks ?? []}
            taskMessages={snapshot.taskMessages ?? []}
            taskMessageAcknowledgements={snapshot.taskMessageAcknowledgements ?? []}
            approvals={snapshot.approvals ?? []}
            workspaceLeases={snapshot.workspaceLeases ?? []}
            agents={snapshot.agents}
            nodes={snapshot.nodes}
            runs={snapshot.runs}
            orchestratorClients={orchestratorClients}
            canMutate={canMutate}
            apiFetch={apiFetch}
            onInspectRun={setSelectedRunId}
          />
        )}
        {effectiveView === "compute" && <ComputeView nodes={snapshot.nodes} />}
        {effectiveView === "projects" && <ProjectsView profiles={snapshot.projectProfiles ?? []} canMutate={canMutate} apiFetch={apiFetch} />}
        {effectiveView === "settings" && <SettingsView connection={connection} nodes={snapshot.nodes} generatedAt={snapshot.generatedAt} orchestratorClients={orchestratorClients} canMutate={canMutate} apiFetch={apiFetch} />}
      </div>
      {legacySnapshot && selected && inspectorOpen && <Inspector agent={selected} nodes={snapshot.nodes} sessions={providerSessionsForAgent(selected.id, snapshot.runs, snapshot.sessionBindings ?? [])} onClose={() => setInspectorOpen(false)} onSave={updateAgent} onReconcile={retry} canMutate={false} />}
      {externalThread && <ExternalThreadDialog thread={externalThread} description={describeThreadOrchestrator(externalThread, { agents: snapshot.agents, clients: orchestratorClients, attachments: orchestratorAttachments })} taskMessages={snapshot.taskMessages ?? []} canMutate={canMutate} apiFetch={apiFetch} onClose={() => setExternalThreadId(undefined)} />}
      {reviewingApproval && <ApprovalDialog approval={reviewingApproval} agents={snapshot.agents} nodes={snapshot.nodes} runs={snapshot.runs} tasks={snapshot.tasks ?? []} orchestratorClients={orchestratorClients} canMutate={canMutate} onClose={() => setReviewingApprovalId(undefined)} apiFetch={apiFetch} />}
      {selectedRunId && <RunInspector selectedRunId={selectedRunId} run={snapshot.runs.find((run) => run.id === selectedRunId)} runs={snapshot.runs} threads={snapshot.threads ?? []} artifacts={snapshot.artifacts ?? []} agents={snapshot.agents} nodes={snapshot.nodes} runActivity={snapshot.runActivity ?? []} approvals={snapshot.approvals ?? []} sessionBindings={snapshot.sessionBindings ?? []} onClose={() => setSelectedRunId(undefined)} onInspectRun={setSelectedRunId} canMutate={canMutate} />}
      <nav className="desktop-nav" aria-label="Primary">
        <div className="rail-brand" aria-label="Coffee Shop"><Coffee size={21} /></div>
        {legacySnapshot
          ? <button aria-label="Legacy agents" className={effectiveView === "agents" ? "active" : ""} onClick={() => switchView("agents")}><Robot size={18} /><span>Legacy agents</span></button>
          : <><button aria-label="Instances" className={effectiveView === "instances" ? "active" : ""} onClick={() => switchView("instances")}><Stack size={18} /><span>Instances</span></button><button aria-label="Templates" className={effectiveView === "templates" ? "active" : ""} onClick={() => switchView("templates")}><Copy size={18} /><span>Templates</span></button></>}
        <button aria-label="Threads" className={effectiveView === "threads" ? "active" : ""} onClick={() => switchView("threads")}><FolderOpen size={18} /><span>Threads</span></button>
        <button aria-label="Activity" className={effectiveView === "activity" ? "active" : ""} onClick={() => switchView("activity")}><Activity size={18} /><span>Activity</span></button>
        <button aria-label="Orchestration" className={effectiveView === "orchestration" ? "active" : ""} onClick={() => switchView("orchestration")}><ShieldWarning size={18} /><span>Orchestrate</span>{pendingApprovalCount > 0 && <span className="unread">{pendingApprovalCount}</span>}</button>
        <button aria-label="Compute" className={effectiveView === "compute" ? "active" : ""} onClick={() => switchView("compute")}><Cpu size={18} /><span>Compute</span></button>
        <button aria-label="Projects" className={effectiveView === "projects" ? "active" : ""} onClick={() => switchView("projects")}><GitBranch size={18} /><span>Projects</span></button>
        <button aria-label="Settings" className={effectiveView === "settings" ? "active" : ""} onClick={() => switchView("settings")}><Gear size={18} /><span>Settings</span></button>
        <div className="rail-user">CS</div>
      </nav>
      <BottomNav view={effectiveView} onView={switchView} pendingApprovalCount={pendingApprovalCount} legacy={legacySnapshot} />
      {creatingInstance && <CreateInstanceDialog threads={snapshot.threads ?? []} templates={snapshot.templates ?? []} canMutate={canMutate} onClose={() => setCreatingInstance(false)} onCreate={createInstance} />}
      {releasingInstanceId && selectedInstance?.id === releasingInstanceId && <ReleaseInstanceDialog instance={selectedInstance} canMutate={canMutate} onClose={() => setReleasingInstanceId(undefined)} onRelease={(mode) => releaseInstance(selectedInstance, mode)} />}
      {editingTemplate && <TemplateEditorDialog template={editingTemplate === "edit" ? selectedTemplate : undefined} canMutate={canMutate} onClose={() => setEditingTemplate(undefined)} onSave={saveTemplate} />}
      {deletingTemplate && selectedTemplate && <DeleteTemplateDialog template={selectedTemplate} canMutate={canMutate} onClose={() => setDeletingTemplate(false)} onDelete={deleteTemplate} />}
    </div>
  );
}

export default function App() {
  return <PwaInstallProvider><CoffeeShopApp /></PwaInstallProvider>;
}
