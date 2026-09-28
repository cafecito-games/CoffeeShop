import { useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, ClockCounterClockwise, MagnifyingGlass, Plus, WarningCircle, X } from "@phosphor-icons/react";
import {
  defaultInstanceIdleTimeoutSeconds,
  instanceStatuses,
  isTerminalInstanceStatus,
  maximumInstanceIdleTimeoutSeconds,
  minimumInstanceIdleTimeoutSeconds,
  type AgentInstance,
  type AgentTemplate,
  type ComputeNode,
  type ExecutionPreferences,
  type ExecutionRequirements,
  type InstanceAllocation,
  type InstanceInitialTask,
  type InstancePurpose,
  type InstanceReleaseMode,
  type Run,
  type Task,
  type Thread
} from "@coffee-shop/protocol";
import { AccessibleDialog } from "../AccessibleDialog.js";
import {
  allocationHistory,
  capacityFor,
  currentAllocationFor,
  exactCurrentRuns,
  exactCurrentTasks,
  visibleInstances
} from "./instancePresentation.js";
import "./instances.css";

const commaList = (value: string) => [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
const instanceName = (instance: AgentInstance) => instance.purpose?.name ?? instance.purpose?.title ?? instance.id;

export interface CreateInstancePayload {
  threadId: string;
  purpose?: InstancePurpose;
  requirements: ExecutionRequirements;
  idleTimeoutSeconds?: number;
  initialTask?: InstanceInitialTask;
}

export function InstanceSidebar({ instances, threads, selectedId, connectionLabel, canMutate, onSelect, onCreate }: {
  instances: AgentInstance[];
  threads: Thread[];
  selectedId?: string;
  connectionLabel: string;
  canMutate: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<AgentInstance["status"] | "all">("all");
  const [includeHistory, setIncludeHistory] = useState(false);
  const filtered = visibleInstances(instances, includeHistory).filter((instance) => {
    const thread = threads.find((candidate) => candidate.id === instance.threadId);
    return (status === "all" || instance.status === status)
      && `${instanceName(instance)} ${instance.id} ${thread?.title ?? instance.threadId}`.toLowerCase().includes(query.toLowerCase());
  });
  const groups = threads.map((thread) => ({ thread, instances: filtered.filter((instance) => instance.threadId === thread.id) }))
    .filter((group) => group.instances.length > 0);
  const missingThread = filtered.filter((instance) => !threads.some((thread) => thread.id === instance.threadId));
  return <aside className="roster instance-roster">
    <div className="brand-row"><strong>Instances</strong><button className="icon-btn" aria-label="Start instance" onClick={onCreate} disabled={!canMutate}><Plus size={17} /></button></div>
    <label className="search"><MagnifyingGlass size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find an instance" /></label>
    <div className="instance-filter" role="group" aria-label="Filter instance status">
      <button aria-pressed={status === "all"} onClick={() => setStatus("all")}>All</button>
      {instanceStatuses.filter((candidate) => includeHistory || !isTerminalInstanceStatus(candidate)).map((candidate) =>
        <button key={candidate} aria-pressed={status === candidate} onClick={() => setStatus(candidate)}>{candidate}</button>)}
    </div>
    <button className="history-toggle" aria-pressed={includeHistory} onClick={() => { setIncludeHistory((shown) => !shown); setStatus("all"); }}>
      <ClockCounterClockwise size={14} />{includeHistory ? "Hide released history" : "Show released history"}
    </button>
    <div className="instance-list">
      {[...groups, ...(missingThread.length ? [{ thread: undefined, instances: missingThread }] : [])].map((group) => <section key={group.thread?.id ?? "missing"}>
        <div className="section-label"><span>{group.thread?.title ?? "Thread unavailable"}</span><small>{group.instances.length}</small></div>
        {group.instances.map((instance) => <button key={instance.id} className={`instance-row ${selectedId === instance.id ? "selected" : ""}`} onClick={() => onSelect(instance.id)}>
          <span className={`instance-state instance-state-${instance.status}`} aria-hidden="true" />
          <span><strong>{instanceName(instance)}</strong><small>{instance.status} · {instance.id}</small></span><ArrowRight size={14} />
        </button>)}
      </section>)}
      {filtered.length === 0 && <p className="instance-empty">No instances match this view.</p>}
    </div>
    <div className="roster-foot"><span><i className={canMutate ? "online-dot" : "offline-dot"} />{connectionLabel}</span><small>{instances.filter((item) => !isTerminalInstanceStatus(item.status)).length} live</small></div>
  </aside>;
}

function Definition({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

const json = (value: unknown) => Object.keys(value as object).length ? JSON.stringify(value, null, 2) : "No constraints";

export function InstanceDetail({ instance, allocations, nodes, runs, tasks, threads, canMutate, busy, onRenew, onRelease, onInspectRun, onBack }: {
  instance?: AgentInstance;
  allocations: InstanceAllocation[];
  nodes: ComputeNode[];
  runs: Run[];
  tasks: Task[];
  threads: Thread[];
  canMutate: boolean;
  busy: boolean;
  onRenew: (instance: AgentInstance) => Promise<void>;
  onRelease: (instance: AgentInstance) => void;
  onInspectRun: (id: string) => void;
  onBack?: () => void;
}) {
  const [notice, setNotice] = useState("");
  if (!instance) return <main className="instance-detail instance-welcome"><div><small>Runtime identities</small><h1>Choose an instance</h1><p>Inspect exact work, placement, desired constraints, and lease state without treating reusable metadata as capacity.</p></div></main>;
  const current = currentAllocationFor(instance.id, allocations);
  const history = allocationHistory(instance.id, allocations);
  const activeRuns = exactCurrentRuns(instance.id, current, runs);
  const activeTasks = exactCurrentTasks(instance.id, current, tasks);
  const capacity = capacityFor(current, nodes);
  const thread = threads.find((candidate) => candidate.id === instance.threadId);
  const terminal = isTerminalInstanceStatus(instance.status);
  return <main className="instance-detail">
    <header className="instance-detail-header">
      <div className="instance-heading"><button className="mobile-detail-back" onClick={onBack} aria-label="Back to instances"><ArrowLeft size={19} /></button><div><small>Instance · {instance.status}</small><h1>{instanceName(instance)}</h1><code>{instance.id}</code></div></div>
      {!terminal && <div className="instance-actions"><button onClick={() => { setNotice(""); void onRenew(instance).then(() => setNotice("Lease renewed.")).catch((cause) => setNotice(cause instanceof Error ? cause.message : "Renewal failed")); }} disabled={!canMutate || busy}>Renew lease</button><button className="danger-button" onClick={() => onRelease(instance)} disabled={!canMutate || busy}>Release</button></div>}
    </header>
    {notice && <p className="instance-notice" role="status">{notice}</p>}
    <div className="instance-detail-grid">
      <section className="instance-panel">
        <div className="section-label"><span>Identity & lease</span></div>
        <dl className="instance-facts">
          <Definition label="Thread">{thread ? `${thread.title} · ${thread.id}` : `${instance.threadId} · unavailable`}</Definition>
          <Definition label="Purpose">{instance.purpose?.summary ?? instance.purpose?.title ?? "Purpose unavailable"}</Definition>
          <Definition label="Delegation">{instance.delegation.canDelegate ? "May delegate" : "Worker only"}</Definition>
          <Definition label="Idle timeout">{instance.lease.idleTimeoutSeconds}s</Definition>
          <Definition label="Lease expires"><time>{instance.lease.expiresAt}</time></Definition>
        </dl>
      </section>
      <section className="instance-panel">
        <div className="section-label"><span>Current placement</span></div>
        {current.kind === "unavailable" && <p className="instance-callout"><WarningCircle size={16} />Allocation unavailable. No placement is inferred.</p>}
        {current.kind === "inconsistent" && <p className="instance-callout danger"><WarningCircle size={16} />Inconsistent: {current.allocations.length} current allocations.</p>}
        {current.kind === "current" && <dl className="instance-facts">
          <Definition label="Allocation"><code>{current.allocation.id}</code></Definition>
          <Definition label="Node">{nodes.find((node) => node.id === current.allocation.nodeId)?.name ?? current.allocation.nodeId}</Definition>
          <Definition label="Harness / model">{current.allocation.harnessId} · {current.allocation.model}</Definition>
          <Definition label="Transport">{current.allocation.transport}</Definition>
          <Definition label="Workspace"><code>{current.allocation.workspace}</code></Definition>
        </dl>}
      </section>
      <section className="instance-panel">
        <div className="section-label"><span>Desired requirements</span><small>immutable</small></div>
        <pre className="requirements-view">{json(instance.requirements)}</pre>
      </section>
      <section className="instance-panel">
        <div className="section-label"><span>Capacity & freshness</span></div>
        {capacity.kind === "unavailable" && <p className="instance-callout">Node capacity unavailable.</p>}
        {capacity.kind === "incapable" && <p className="instance-callout">{capacity.node.name} does not report instance capacity.</p>}
        {capacity.kind === "unknown" && <p className="instance-callout">{capacity.node.name}: usage unknown of {capacity.capacity} slots · last seen {capacity.node.lastSeen}</p>}
        {capacity.kind === "reported" && <p className="capacity-reading"><strong>{capacity.active}</strong><span>resident of {capacity.capacity}</span><small>{capacity.node.name} · {capacity.node.status} · {capacity.node.lastSeen}</small></p>}
      </section>
      <section className="instance-panel instance-span">
        <div className="section-label"><span>Exact current work</span><small>{activeRuns.length} runs · {activeTasks.length} tasks</small></div>
        {activeRuns.length === 0 && activeTasks.length === 0 && <p className="instance-callout">No exact instance/allocation work is active.</p>}
        <div className="work-list">{activeRuns.map((run) => <button key={run.id} onClick={() => onInspectRun(run.id)}><span><strong>{run.prompt || run.id}</strong><small>{run.status} · {run.id}</small></span><ArrowRight size={15} /></button>)}</div>
        {activeTasks.map((task) => <div className="task-evidence" key={task.id}><strong>{task.title}</strong><small>{task.status} · {task.id}</small></div>)}
      </section>
      <section className="instance-panel instance-span">
        <div className="section-label"><span>Allocation history</span><small>{history.length}</small></div>
        {history.length === 0 ? <p className="instance-callout">No allocation history.</p> : <div className="allocation-history">{history.map((allocation) => <div key={allocation.id}><span className={`instance-state instance-state-${allocation.status}`} /><code>{allocation.id}</code><span>{allocation.nodeId}</span><small>{allocation.status} · {allocation.createdAt}</small></div>)}</div>}
      </section>
    </div>
  </main>;
}

export function MobileInstanceIndex({ instances, threads, canMutate, onSelect, onCreate }: { instances: AgentInstance[]; threads: Thread[]; canMutate: boolean; onSelect: (id: string) => void; onCreate: () => void }) {
  const active = visibleInstances(instances, false);
  return <main className="mobile-instance-index"><header><div><small>Runtime identities</small><h1>Instances</h1></div><button aria-label="Start instance" onClick={onCreate} disabled={!canMutate}><Plus size={18} /></button></header><div>{active.map((instance) => <button key={instance.id} onClick={() => onSelect(instance.id)}><span className={`instance-state instance-state-${instance.status}`} /><span><strong>{instanceName(instance)}</strong><small>{threads.find((thread) => thread.id === instance.threadId)?.title ?? instance.threadId} · {instance.status}</small></span><ArrowRight size={17} /></button>)}{active.length === 0 && <p>No active instances.</p>}</div></main>;
}

function TextField({ label, value, onChange, placeholder, required, multiline }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; required?: boolean; multiline?: boolean }) {
  return <label className="instance-field"><span>{label}</span>{multiline
    ? <textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} rows={3} required={required} />
    : <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} required={required} />}</label>;
}

export function CreateInstanceDialog({ threads, templates, canMutate, onClose, onCreate }: {
  threads: Thread[];
  templates: AgentTemplate[];
  canMutate: boolean;
  onClose: () => void;
  onCreate: (payload: CreateInstancePayload) => Promise<void>;
}) {
  const activeThreads = threads.filter((thread) => thread.status === "active");
  const [threadId, setThreadId] = useState(activeThreads[0]?.id ?? "");
  const [templateId, setTemplateId] = useState("");
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [instructions, setInstructions] = useState("");
  const [skills, setSkills] = useState("");
  const [harnesses, setHarnesses] = useState("");
  const [models, setModels] = useState("");
  const [labels, setLabels] = useState("");
  const [preferredNodes, setPreferredNodes] = useState("");
  const [idleTimeout, setIdleTimeout] = useState(String(defaultInstanceIdleTimeoutSeconds));
  const [taskTitle, setTaskTitle] = useState("");
  const [taskInstructions, setTaskInstructions] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canMutate || !threadId) return;
    const idleTimeoutSeconds = Number(idleTimeout);
    if (!Number.isInteger(idleTimeoutSeconds) || idleTimeoutSeconds < minimumInstanceIdleTimeoutSeconds || idleTimeoutSeconds > maximumInstanceIdleTimeoutSeconds) {
      setError(`Idle timeout must be a whole number from ${minimumInstanceIdleTimeoutSeconds} to ${maximumInstanceIdleTimeoutSeconds} seconds`);
      return;
    }
    if ((taskTitle.trim().length === 0) !== (taskInstructions.trim().length === 0)) {
      setError("Initial task title and instructions must be provided together");
      return;
    }
    const purpose = { ...(name.trim() ? { name: name.trim() } : {}), ...(title.trim() ? { title: title.trim() } : {}), ...(summary.trim() ? { summary: summary.trim() } : {}), ...(instructions.trim() ? { instructions: instructions.trim() } : {}) };
    const preferences: ExecutionPreferences = { ...(commaList(preferredNodes).length ? { nodeIds: commaList(preferredNodes) } : {}) };
    const requirements: ExecutionRequirements = {
      ...(templateId ? { templateId } : {}), ...(commaList(skills).length ? { skills: commaList(skills) } : {}),
      ...(commaList(harnesses).length ? { harnessIds: commaList(harnesses) as ExecutionRequirements["harnessIds"] } : {}),
      ...(commaList(models).length ? { models: commaList(models) } : {}), ...(commaList(labels).length ? { labels: commaList(labels) } : {}),
      ...(preferences.nodeIds?.length ? { preferences } : {})
    };
    setSaving(true); setError("");
    try {
      await onCreate({
        threadId, ...(Object.keys(purpose).length ? { purpose } : {}), requirements,
        idleTimeoutSeconds,
        ...(taskTitle.trim() && taskInstructions.trim() ? { initialTask: { title: taskTitle.trim(), instructions: taskInstructions.trim() } } : {})
      });
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start instance"); }
    finally { setSaving(false); }
  }
  return <AccessibleDialog labelledBy="create-instance-title" onClose={onClose} className="instance-dialog">
    <form onSubmit={submit}>
      <header><div><small>Operator lifecycle</small><h2 id="create-instance-title">Start an instance</h2></div><button type="button" className="icon-btn" aria-label="Close instance form" onClick={onClose}><X size={17} /></button></header>
      <div className="instance-form-scroll">
        {activeThreads.length === 0 ? <p className="instance-callout danger">An active thread is required.</p> : <fieldset><legend>Active thread</legend><div className="choice-grid">{activeThreads.map((thread) => <button type="button" key={thread.id} aria-pressed={threadId === thread.id} className={threadId === thread.id ? "selected" : ""} onClick={() => setThreadId(thread.id)}>{thread.title}</button>)}</div></fieldset>}
        <fieldset><legend>Reusable template</legend><div className="choice-grid"><button type="button" aria-pressed={!templateId} className={!templateId ? "selected" : ""} onClick={() => setTemplateId("")}>No template</button>{templates.map((template) => <button type="button" key={template.id} aria-pressed={templateId === template.id} className={templateId === template.id ? "selected" : ""} onClick={() => setTemplateId(template.id)}>{template.name}</button>)}</div></fieldset>
        <fieldset><legend>Purpose</legend><div className="form-grid"><TextField label="Name" value={name} onChange={setName} placeholder="Review worker" /><TextField label="Title" value={title} onChange={setTitle} placeholder="Quality review" /></div><TextField label="Summary" value={summary} onChange={setSummary} /><TextField label="Private instructions" value={instructions} onChange={setInstructions} multiline /></fieldset>
        <fieldset><legend>Hard requirements</legend><div className="form-grid"><TextField label="Skills" value={skills} onChange={setSkills} placeholder="typescript, review" /><TextField label="Harnesses" value={harnesses} onChange={setHarnesses} placeholder="codex-cli" /><TextField label="Models" value={models} onChange={setModels} placeholder="default" /><TextField label="Labels" value={labels} onChange={setLabels} placeholder="linux, trusted" /></div></fieldset>
        <fieldset><legend>Preferences & lease</legend><div className="form-grid"><TextField label="Preferred nodes" value={preferredNodes} onChange={setPreferredNodes} placeholder="node-one, node-two" /><TextField label="Idle timeout (seconds)" value={idleTimeout} onChange={setIdleTimeout} /></div></fieldset>
        <fieldset><legend>Optional initial task</legend><TextField label="Task title" value={taskTitle} onChange={setTaskTitle} /><TextField label="Task instructions" value={taskInstructions} onChange={setTaskInstructions} multiline /></fieldset>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <footer><button type="button" onClick={onClose}>Cancel</button><button className="primary-action" disabled={!canMutate || !threadId || saving}>{saving ? "Starting…" : "Start instance"}</button></footer>
    </form>
  </AccessibleDialog>;
}

export function ReleaseInstanceDialog({ instance, canMutate, onClose, onRelease }: { instance: AgentInstance; canMutate: boolean; onClose: () => void; onRelease: (mode: InstanceReleaseMode) => Promise<void> }) {
  const [mode, setMode] = useState<InstanceReleaseMode>("drain");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) { event.preventDefault(); setSaving(true); setError(""); try { await onRelease(mode); onClose(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not release instance"); } finally { setSaving(false); } }
  return <AccessibleDialog labelledBy="release-instance-title" onClose={onClose} className="instance-dialog release-dialog"><form onSubmit={submit}>
    <header><div><small>Confirm lifecycle change</small><h2 id="release-instance-title">Release {instanceName(instance)}</h2></div><button type="button" className="icon-btn" aria-label="Close release confirmation" onClick={onClose}><X size={17} /></button></header>
    <p>Drain lets current work finish. Cancel stops active work before the resident is released.</p>
    <div className="release-choices"><button type="button" aria-pressed={mode === "drain"} className={mode === "drain" ? "selected" : ""} onClick={() => setMode("drain")} data-dialog-initial-focus><strong>Drain</strong><small>Finish current work</small></button><button type="button" aria-pressed={mode === "cancel"} className={mode === "cancel" ? "selected danger" : "danger"} onClick={() => setMode("cancel")}><strong>Cancel</strong><small>Stop active work</small></button></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <footer><button type="button" onClick={onClose}>Keep instance</button><button className="danger-button" disabled={!canMutate || saving}>{saving ? "Releasing…" : `Confirm ${mode}`}</button></footer>
  </form></AccessibleDialog>;
}
