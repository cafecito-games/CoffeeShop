import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Pulse as Activity, ArrowLeft, ArrowRight, Broadcast, CaretDown, Check, CircleNotch, Cloud, Command,
  Coffee, Cpu, Desktop, Gear, HouseLine, Laptop, MagnifyingGlass, PaperPlaneTilt, Plus,
  Robot, SlidersHorizontal, TerminalWindow, UsersThree, WarningCircle, X, LockKey
} from "@phosphor-icons/react";
import { isActiveRunStatus, type Agent, type AgentAvatarColor, type AgentAvatarShape, type AgentState, type ChatMessage, type ComputeNode, type Run, type RunStatus, type TimelineEvent } from "@coffee-shop/protocol";
import { AccessibleDialog } from "./AccessibleDialog.js";
import { AvatarPicker, CoffeeAvatar } from "./CoffeeAvatar.js";
import { useHubConnection, type ConnectionStatus } from "./hubConnection.js";

type View = "agents" | "activity" | "compute" | "settings";

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

function Chat({ agent, messages, nodes, sending, onBack, onSend, onInspector, onInspectRun, canMutate }: {
  agent: Agent; messages: ChatMessage[]; nodes: ComputeNode[]; sending: boolean;
  onBack: () => void; onSend: (body: string) => Promise<void>; onInspector: () => void; onInspectRun: (id: string) => void; canMutate: boolean;
}) {
  const [body, setBody] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const node = nodes.find((item) => item.id === agent.computeNodeId);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length]);
  async function submit(event: FormEvent) { event.preventDefault(); const value = body.trim(); if (!value || sending || !canMutate) return; setBody(""); await onSend(value); }
  return (
    <main className="chat">
      <header className="chat-header">
        <button className="back-btn" onClick={onBack}><ArrowLeft size={19} /></button>
        <Avatar agent={agent} />
        <div className="chat-identity"><strong>{agent.name}</strong><span><StateMark state={agent.state} /> · {node?.name ?? "Unassigned"}</span></div>
        <button className="context-btn" onClick={onInspector}><SlidersHorizontal size={18} /><span>Context</span></button>
      </header>
      <div className="chat-scroll">
        <div className="agent-intro"><Avatar agent={agent} size="lg" /><h1>{agent.name}</h1><p>{agent.title}</p><small>{agent.summary}</small></div>
        <div className="messages">
          {messages.map((message) => <Message key={message.id} message={message} agent={agent} onInspectRun={onInspectRun} />)}
          {sending && <div className="message agent-message pending"><div className="message-meta"><strong>{agent.name}</strong><span>now</span></div><p><CircleNotch className="spin" size={14} /> Dispatching to {node?.name ?? agent.computeNodeId}…</p></div>}
          <div ref={endRef} />
        </div>
      </div>
      <form className="composer" onSubmit={submit}>
        <div className="composer-box"><textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder={canMutate ? `Message ${agent.name}` : `Reconnect to message ${agent.name}`} rows={1} disabled={!canMutate} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><button disabled={!canMutate || !body.trim() || sending}><PaperPlaneTilt size={17} weight="fill" /></button></div>
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

function Inspector({ agent, nodes, open, onClose, onUpdate, canMutate }: { agent: Agent; nodes: ComputeNode[]; open: boolean; onClose: () => void; onUpdate: (patch: Partial<Agent>) => void; canMutate: boolean }) {
  const [menu, setMenu] = useState<"harness" | "node" | null>(null);
  const node = nodes.find((item) => item.id === agent.computeNodeId);
  const harnesses = Array.from(new Map(nodes.flatMap((item) => item.harnesses).map((h) => [h.id, h])).values());
  return (
    <aside className={`inspector ${open ? "open" : ""}`}>
      <header><span>Agent context</span><button className="icon-btn" onClick={onClose}><X size={17} /></button></header>
      <fieldset className="inspector-fields" disabled={!canMutate}>
      <section className="avatar-editor">
        <div className="section-label"><span>Identity mark</span><small>editable</small></div>
        <CoffeeAvatar shape={agent.avatarShape} color={agent.avatarColor} size="xl" />
        <AvatarPicker compact shape={agent.avatarShape} color={agent.avatarColor} onShape={(avatarShape) => onUpdate({ avatarShape })} onColor={(avatarColor) => onUpdate({ avatarColor })} />
      </section>
      <section className="identity-block"><div><h2>{agent.name}</h2><p>{agent.title}</p></div></section>
      <section className="status-block"><span>Current state</span><StateMark state={agent.state} /><p>{agent.currentAction}</p></section>
      <section className="config-section">
        <div className="section-label"><span>Runtime</span></div>
        <div className="config-field"><label>Harness</label><button onClick={() => setMenu(menu === "harness" ? null : "harness")}><Command size={17} /><span><strong>{harnesses.find((h) => h.id === agent.harnessId)?.label ?? agent.harnessId}</strong><small>{agent.model}</small></span><CaretDown size={14} /></button>
          {menu === "harness" && <div className="select-menu">{harnesses.map((h) => <button key={h.id} onClick={() => { onUpdate({ harnessId: h.id, model: h.models[0] || agent.model }); setMenu(null); }}><span>{h.label}<small>{h.authMode.replaceAll("-", " ")}</small></span>{agent.harnessId === h.id && <Check size={15} />}</button>)}</div>}
        </div>
        <div className="config-field"><label>Compute</label><button onClick={() => setMenu(menu === "node" ? null : "node")}><Cpu size={17} /><span><strong>{node?.name ?? "Unassigned"}</strong><small>{node?.platform ?? "No Barista"}</small></span><CaretDown size={14} /></button>
          {menu === "node" && <div className="select-menu">{nodes.map((item) => <button key={item.id} onClick={() => { onUpdate({ computeNodeId: item.id }); setMenu(null); }}><span>{item.name}<small>{item.status} · {item.activeRuns}/{item.concurrency} runs</small></span>{agent.computeNodeId === item.id && <Check size={15} />}</button>)}</div>}
        </div>
        <div className="config-line"><label>Workspace</label><code>{agent.workspace}</code></div>
      </section>
      <section className="prompt-section"><div className="section-label"><span>Purpose</span><small>system prompt</small></div><p>{agent.systemPrompt}</p></section>
      </fieldset>
      <footer><div><i className={node?.status === "online" || node?.status === "busy" ? "online-dot" : "offline-dot"} /><span>{node?.status ?? "offline"}</span></div><small>Credentials stay on {node?.name ?? "the compute node"}</small></footer>
    </aside>
  );
}

function ActivityView({ events, agents, onInspectRun }: { events: TimelineEvent[]; agents: Agent[]; onInspectRun: (id: string) => void }) {
  const name = (id?: string) => agents.find((agent) => agent.id === id)?.name;
  return <main className="utility-view"><header className="utility-header"><div><small>Across every harness and machine</small><h1>Activity</h1></div><button className="filter-btn"><SlidersHorizontal size={16} /> Filter</button></header><div className="timeline">{events.map((event, index) => <article key={event.id} className={`timeline-event event-${event.type}`}><div className="timeline-rail"><span>{event.type === "handoff" ? <UsersThree size={15} /> : event.type === "node" ? <Cpu size={15} /> : <Activity size={15} />}</span>{index < events.length - 1 && <i />}</div><div><div className="event-heading"><strong>{event.title}</strong><time>{timeAgo(event.createdAt)}</time></div><p>{event.detail}</p>{event.fromAgentId && <small>{name(event.fromAgentId)} handed work to {name(event.toAgentId)}</small>}{event.runId && <button className="run-link" onClick={() => onInspectRun(event.runId!)}><TerminalWindow size={14} /> Inspect run</button>}</div></article>)}</div></main>;
}

const runStatusLabels: Record<RunStatus, string> = {
  queued: "Queued", running: "Running", completed: "Completed", failed: "Failed", cancelled: "Cancelled"
};

function RunInspector({ selectedRunId, run, agents, nodes, onClose, canMutate }: {
  selectedRunId: string;
  run?: Run;
  agents: Agent[];
  nodes: ComputeNode[];
  onClose: () => void;
  canMutate: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [notice, setNotice] = useState("");
  const titleId = "run-inspector-title";
  const agent = run ? agents.find((item) => item.id === run.agentId) : undefined;
  const node = run ? nodes.find((item) => item.id === run.nodeId) : undefined;

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
            <div><dt>Agent</dt><dd>{agent ? `${agent.name} · ${agent.id}` : `${run.agentId} · unavailable`}</dd></div>
            <div><dt>Compute</dt><dd>{node ? `${node.name} · ${node.id}` : `${run.nodeId} · unavailable`}</dd></div>
            <div><dt>Harness / model</dt><dd>{run.harnessId} · {run.model || "Model unavailable"}</dd></div>
            <div><dt>Workspace</dt><dd><code>{run.workspace || "Workspace unavailable"}</code></dd></div>
            <div><dt>Parent run</dt><dd>{run.parentRunId ?? "No parent run"}</dd></div>
            <div><dt>Handoff depth</dt><dd>{run.depth}</dd></div>
            <div><dt>Created</dt><dd><time>{run.createdAt || "Timestamp unavailable"}</time></dd></div>
            <div><dt>Started</dt><dd><time>{run.startedAt ?? "Not started yet"}</time></dd></div>
            <div><dt>Finished</dt><dd><time>{run.finishedAt ?? "Not finished yet"}</time></dd></div>
          </dl>
          <section className="run-text"><h3>Prompt</h3><pre>{run.prompt || "Prompt unavailable"}</pre></section>
          <section className="run-text" aria-live="polite"><h3>Output</h3><pre>{run.output || (isActiveRunStatus(run.status) ? "Output is not available yet." : "No output was produced.")}</pre></section>
          <section className="run-text"><h3>Error</h3><pre>{run.error ?? "No error reported."}</pre></section>
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

function ComputeView({ nodes }: { nodes: ComputeNode[] }) {
  const kindIcon = (kind: ComputeNode["kind"]) => kind === "local" ? <Laptop size={20} /> : kind === "home-server" ? <HouseLine size={20} /> : <Cloud size={20} />;
  return <main className="utility-view"><header className="utility-header"><div><small>Execution fabric</small><h1>Compute</h1></div><button className="primary-btn"><Plus size={16} /> Add compute</button></header><div className="node-list">{nodes.map((node) => <article key={node.id} className="node-row"><div className="node-icon">{kindIcon(node.kind)}</div><div className="node-main"><div><strong>{node.name}</strong><span className={`node-status ${node.status}`}><i />{node.status}</span></div><p>{node.platform} · {node.activeRuns} of {node.concurrency} slots active</p><div className="capacity"><i style={{ width: `${Math.max(3, (node.activeRuns / node.concurrency) * 100)}%` }} /></div><div className="harness-tags">{node.harnesses.map((h) => <span key={h.id} className={h.available ? "" : "unavailable"}><Command size={13} />{h.label}<small>{h.available ? "ready" : "missing"}</small></span>)}</div></div><button className="icon-btn"><ArrowRight size={17} /></button></article>)}</div><section className="worker-callout"><TerminalWindow size={19} /><div><strong>Bring another machine online</strong><code>barista --control-endpoint {window.location.host}</code><p>Barista connects outbound; model credentials never leave the compute machine.</p></div></section></main>;
}

function SettingsView({ connection }: { connection: ConnectionStatus }) {
  return <main className="utility-view"><header className="utility-header"><div><small>Control plane</small><h1>Settings</h1></div></header><div className="settings-list"><section><div><Broadcast size={18} /><span><strong>Hub connection</strong><small>WebSocket events and Barista dispatch</small></span></div><em className={connection === "connected" ? "ok-label" : "stale-label"}>{connection === "connected" ? <Check size={13} /> : <WarningCircle size={13} />} {connectionLabels[connection].toLowerCase()}</em></section><section><div><Desktop size={18} /><span><strong>Installable app</strong><small>Add Coffee Shop to your home screen</small></span></div><button>Install PWA</button></section><section><div><WarningCircle size={18} /><span><strong>Execution policy</strong><small>Barista enforces workspace allowlists and safe harness modes</small></span></div><button>Review</button></section></div><div className="terms-note"><strong>Claude subscription boundary</strong><p>Coffee Shop invokes Anthropic’s official Claude Code CLI through Barista. It never reads, copies, or proxies Claude credentials. Keep a subscription-backed compute node private to its account owner.</p></div></main>;
}

function FreshnessNotice({ connection, onRetry }: { connection: ConnectionStatus; onRetry: () => void }) {
  if (connection === "connected") return null;
  const waiting = connection === "connecting";
  return <div className="freshness-notice" role="status"><WarningCircle size={15} /><span><strong>{connectionLabels[connection]}</strong>{waiting ? "Waiting for a validated live snapshot." : "Showing last known data. Changes are disabled until the live snapshot is restored."}</span>{!waiting && <button onClick={onRetry} aria-label="Retry connection">Retry</button>}</div>;
}

function BottomNav({ view, onView }: { view: View; onView: (view: View) => void }) {
  const items: [View, typeof Robot, string][] = [["agents", Robot, "Agents"], ["activity", Activity, "Activity"], ["compute", Cpu, "Compute"], ["settings", Gear, "Settings"]];
  return <nav className="bottom-nav">{items.map(([key, Icon, label]) => <button key={key} className={view === key ? "active" : ""} onClick={() => onView(key)}><Icon size={21} weight={view === key ? "fill" : "regular"} /><span>{label}</span></button>)}</nav>;
}

function LockScreen() {
  const [value, setValue] = useState("");
  return <main className="lock-screen"><div className="brand-mark"><span /><span /></div><LockKey size={20} /><h1>Connect to your control plane</h1><p>Enter the hub token configured on this deployment. It stays in this browser.</p><form onSubmit={(event) => { event.preventDefault(); if (!value.trim()) return; localStorage.setItem("coffee-shop-token", value.trim()); location.reload(); }}><input type="password" value={value} onChange={(event) => setValue(event.target.value)} placeholder="Hub access token" autoFocus /><button>Connect</button></form></main>;
}

function CreateAgentDialog({ nodes, onClose, onCreate, canMutate }: { nodes: ComputeNode[]; onClose: () => void; onCreate: (fields: Record<string, string>) => Promise<void>; canMutate: boolean }) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [harnessId, setHarnessId] = useState("claude-cli");
  const [computeNodeId, setComputeNodeId] = useState(nodes[0]?.id ?? "");
  const [workspace, setWorkspace] = useState(nodes[0]?.workspaceRoots[0] ?? "");
  const [avatarShape, setAvatarShape] = useState<AgentAvatarShape>("cup");
  const [avatarColor, setAvatarColor] = useState<AgentAvatarColor>("amber");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canMutate) return;
    setBusy(true); setError("");
    try { await onCreate({ name, title, harnessId, computeNodeId, workspace, avatarShape, avatarColor }); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create agent"); }
    finally { setBusy(false); }
  }
  return <AccessibleDialog labelledBy="create-agent-title" onClose={onClose} className="dialog-content-reset">
    <form className="create-dialog" onSubmit={submit}>
      <header><div><small>New teammate</small><h2 id="create-agent-title">Create an agent</h2></div><button type="button" className="icon-btn" onClick={onClose} aria-label="Close create agent dialog"><X size={17} /></button></header>
      <p>Give the agent a stable purpose. You can move it between harnesses and machines later without changing who it is.</p>
      <fieldset className="create-fields" disabled={!canMutate}>
      <AvatarPicker shape={avatarShape} color={avatarColor} onShape={setAvatarShape} onColor={setAvatarColor} />
      <label>Name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Agent name" autoFocus required /></label>
      <label>Role<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Agent role" required /></label>
      <fieldset><legend>Harness</legend><div className="choice-row"><button type="button" className={harnessId === "claude-cli" ? "selected" : ""} onClick={() => setHarnessId("claude-cli")}><Command size={15} />Claude Code</button><button type="button" className={harnessId === "codex-cli" ? "selected" : ""} onClick={() => setHarnessId("codex-cli")}><Command size={15} />Codex</button></div></fieldset>
      <fieldset><legend>Compute</legend><div className="node-choices">{nodes.map((node) => <button type="button" key={node.id} className={computeNodeId === node.id ? "selected" : ""} onClick={() => { setComputeNodeId(node.id); setWorkspace(node.workspaceRoots[0] ?? ""); }}><span><strong>{node.name}</strong><small>{node.status} · {node.platform}</small></span>{computeNodeId === node.id && <Check size={14} />}</button>)}</div></fieldset>
      <label>Workspace<input value={workspace} onChange={(event) => setWorkspace(event.target.value)} placeholder="/absolute/project/path" required /></label>
      </fieldset>
      {!canMutate && <div className="dialog-error">Reconnect before creating an agent.</div>}
      {error && <div className="dialog-error">{error}</div>}
      <footer><button type="button" onClick={onClose}>Cancel</button><button className="create-button" disabled={!canMutate || busy || !name || !title || !computeNodeId}>{busy ? "Creating…" : "Create agent"}</button></footer>
    </form>
  </AccessibleDialog>;
}

export default function App() {
  const { snapshot, status: connection, canMutate, retry } = useHubConnection(accessToken);
  const [view, setView] = useState<View>("agents");
  const [selectedId, setSelectedId] = useState<string>();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [sending, setSending] = useState(false);
  const [creating, setCreating] = useState(false);
  const selected = snapshot.agents.find((agent) => agent.id === selectedId);
  const selectedMessages = useMemo(() => snapshot.messages.filter((message) => message.agentId === selectedId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [snapshot.messages, selectedId]);

  async function send(body: string) {
    if (!selected || !canMutate) return;
    setSending(true);
    try { await apiFetch(`/api/agents/${selected.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body }) }); }
    finally { setSending(false); }
  }

  async function updateAgent(patch: Partial<Agent>) {
    if (!selected || !canMutate) return;
    await apiFetch(`/api/agents/${selected.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
  }

  function selectAgent(id: string) { setSelectedId(id); setView("agents"); setInspectorOpen(false); setSelectedRunId(undefined); }
  function switchView(next: View) { setView(next); if (next !== "agents") setSelectedId(undefined); }
  async function createAgent(fields: Record<string, string>) {
    if (!canMutate) throw new Error("Reconnect before creating an agent");
    const response = await apiFetch("/api/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fields) });
    if (!response.ok) throw new Error((await response.json()).error ?? "Could not create agent");
    const agent = await response.json() as Agent;
    setSelectedId(agent.id); setView("agents");
  }

  if (connection === "authentication-required") return <LockScreen />;

  return (
    <div className="app-shell">
      <Roster agents={snapshot.agents} selectedId={selectedId} onSelect={selectAgent} onCreate={() => { if (canMutate) setCreating(true); }} connection={connection} canMutate={canMutate} />
      <div className="workspace">
        <FreshnessNotice connection={connection} onRetry={retry} />
        {view === "agents" && !selected && <EmptyAgents agents={snapshot.agents} onSelect={selectAgent} onCreate={() => { if (canMutate) setCreating(true); }} canMutate={canMutate} />}
        {view === "agents" && selected && <Chat agent={selected} nodes={snapshot.nodes} messages={selectedMessages} sending={sending} onBack={() => setSelectedId(undefined)} onSend={send} onInspector={() => setInspectorOpen(true)} onInspectRun={setSelectedRunId} canMutate={canMutate} />}
        {view === "activity" && <ActivityView events={snapshot.events} agents={snapshot.agents} onInspectRun={setSelectedRunId} />}
        {view === "compute" && <ComputeView nodes={snapshot.nodes} />}
        {view === "settings" && <SettingsView connection={connection} />}
      </div>
      {selected && <Inspector agent={selected} nodes={snapshot.nodes} open={inspectorOpen} onClose={() => setInspectorOpen(false)} onUpdate={updateAgent} canMutate={canMutate} />}
      {selectedRunId && <RunInspector selectedRunId={selectedRunId} run={snapshot.runs.find((run) => run.id === selectedRunId)} agents={snapshot.agents} nodes={snapshot.nodes} onClose={() => setSelectedRunId(undefined)} canMutate={canMutate} />}
      <nav className="desktop-nav" aria-label="Primary">
        <div className="rail-brand" aria-label="Coffee Shop"><Coffee size={21} /></div>
        <button aria-label="Agents" className={view === "agents" ? "active" : ""} onClick={() => switchView("agents")}><Robot size={18} /><span>Agents</span></button>
        <button aria-label="Activity" className={view === "activity" ? "active" : ""} onClick={() => switchView("activity")}><Activity size={18} /><span>Activity</span></button>
        <button aria-label="Compute" className={view === "compute" ? "active" : ""} onClick={() => switchView("compute")}><Cpu size={18} /><span>Compute</span></button>
        <button aria-label="Settings" className={view === "settings" ? "active" : ""} onClick={() => switchView("settings")}><Gear size={18} /><span>Settings</span></button>
        <div className="rail-user">CS</div>
      </nav>
      <BottomNav view={view} onView={switchView} />
      {creating && <CreateAgentDialog nodes={snapshot.nodes} onClose={() => setCreating(false)} onCreate={createAgent} canMutate={canMutate} />}
    </div>
  );
}
