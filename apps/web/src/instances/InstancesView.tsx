import { useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, CaretDown, Check, ClockCounterClockwise, Info, MagnifyingGlass, Plus, WarningCircle, X } from "@phosphor-icons/react";
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
        {group.instances.map((instance) => <button key={instance.id} aria-pressed={selectedId === instance.id} className={`instance-row ${selectedId === instance.id ? "selected" : ""}`} onClick={() => onSelect(instance.id)}>
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
          {current.allocation.expectedCapabilityPack && <Definition label="Capability pack">
            {current.allocation.expectedCapabilityPack.id}@{current.allocation.expectedCapabilityPack.version}
            <small> · {current.allocation.expectedCapabilityPack.requiredSkills.join(", ")}</small>
          </Definition>}
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

export interface PickerOption {
  value: string;
  label: string;
  description?: string;
}

function TextField({ label, value, onChange, placeholder, required, multiline, helper }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  multiline?: boolean;
  helper?: string;
}) {
  return <label className="instance-field"><span>{label}{required && <em>Required</em>}</span>{multiline
    ? <textarea aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} rows={3} required={required} />
    : <input aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} required={required} />}{helper && <small>{helper}</small>}</label>;
}

export function ChoicePicker({ label, value, onChange, options, placeholder, helper, initialFocus }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: PickerOption[];
  placeholder: string;
  helper?: string;
  initialFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  return <div className="instance-picker" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }}>
    <span className="picker-label">{label}</span>
    <button
      type="button"
      className="picker-trigger"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label={`${label}: ${selected?.label ?? placeholder}`}
      onClick={() => setOpen((current) => !current)}
      data-dialog-initial-focus={initialFocus || undefined}
    >
      <span><strong>{selected?.label ?? placeholder}</strong>{selected?.description && <small>{selected.description}</small>}</span>
      <CaretDown size={15} aria-hidden="true" />
    </button>
    {open && <div className="picker-menu" role="listbox" aria-label={label}>
      {options.map((option) => <button
        type="button"
        role="option"
        aria-selected={option.value === value}
        key={option.value}
        onClick={() => { onChange(option.value); setOpen(false); }}
      >
        <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
        {option.value === value && <Check size={15} weight="bold" aria-hidden="true" />}
      </button>)}
    </div>}
    {helper && <small className="picker-helper">{helper}</small>}
  </div>;
}

function MultiChoicePicker({ label, values, onChange, options, placeholder, helper }: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  options: PickerOption[];
  placeholder: string;
  helper?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.filter((option) => values.includes(option.value));
  const summary = selected.length === 0 ? placeholder : selected.length === 1 ? selected[0].label : `${selected.length} selected`;
  return <div className="instance-picker" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }}>
    <span className="picker-label">{label}</span>
    <button type="button" className="picker-trigger" aria-haspopup="listbox" aria-expanded={open} aria-label={`${label}: ${summary}`} onClick={() => setOpen((current) => !current)}>
      <span><strong>{summary}</strong>{selected.length > 1 && <small>{selected.map((option) => option.label).join(", ")}</small>}</span>
      <CaretDown size={15} aria-hidden="true" />
    </button>
    {open && <div className="picker-menu" role="listbox" aria-label={label} aria-multiselectable="true">
      {options.length > 0 ? options.map((option) => {
        const checked = values.includes(option.value);
        return <button type="button" role="option" aria-selected={checked} key={option.value} onClick={() => onChange(checked ? values.filter((item) => item !== option.value) : [...values, option.value])}>
          <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
          <span className={`picker-check ${checked ? "checked" : ""}`}>{checked && <Check size={13} weight="bold" aria-hidden="true" />}</span>
        </button>;
      }) : <p>No available options are currently advertised.</p>}
    </div>}
    {helper && <small className="picker-helper">{helper}</small>}
  </div>;
}

function FieldsetHeading({ title, description }: { title: string; description: string }) {
  return <legend className="fieldset-heading"><span>{title}</span><small>{description}</small></legend>;
}

export function CreateInstanceDialog({ threads, templates, nodes, canMutate, onClose, onOpenThreads, onCreate }: {
  threads: Thread[];
  templates: AgentTemplate[];
  nodes: ComputeNode[];
  canMutate: boolean;
  onClose: () => void;
  onOpenThreads?: () => void;
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
  const [harnesses, setHarnesses] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [labels, setLabels] = useState("");
  const [preferredNodes, setPreferredNodes] = useState<string[]>([]);
  const [idleTimeout, setIdleTimeout] = useState(String(defaultInstanceIdleTimeoutSeconds));
  const [includeInitialTask, setIncludeInitialTask] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskInstructions, setTaskInstructions] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const selectedTemplate = templates.find((template) => template.id === templateId);
  const templateHarnesses = selectedTemplate?.requirements?.harnessIds;
  const templateModels = selectedTemplate?.requirements?.models;
  const onlineNodes = nodes.filter((node) => node.status !== "offline");
  const availableHarnesses = [...new Map(onlineNodes.flatMap((node) => node.harnesses)
    .filter((harness) => harness.available && (!templateHarnesses || templateHarnesses.includes(harness.id)))
    .map((harness) => [harness.id, harness])).values()];
  const effectiveHarnessIds = harnesses.length > 0 ? harnesses : templateHarnesses ?? [];
  const availableModels = [...new Set(onlineNodes.flatMap((node) => node.harnesses)
    .filter((harness) => harness.available && (effectiveHarnessIds.length === 0 || effectiveHarnessIds.includes(harness.id)))
    .flatMap((harness) => harness.models.length > 0 ? harness.models : ["default"]))]
    .filter((model) => !templateModels || templateModels.includes(model)).sort();
  const threadOptions = activeThreads.map((thread) => ({ value: thread.id, label: thread.title, description: thread.summary || thread.objective || thread.id }));
  const templateOptions = [
    { value: "", label: "No template", description: "Configure this instance from scratch" },
    ...templates.map((template) => ({ value: template.id, label: template.name, description: template.purpose?.summary ?? template.purpose?.title ?? "Reusable role and placement defaults" }))
  ];
  const harnessOptions = availableHarnesses.map((harness) => {
    const count = onlineNodes.filter((node) => node.harnesses.some((candidate) => candidate.id === harness.id && candidate.available)).length;
    return { value: harness.id, label: harness.label, description: `${harness.description} · ${count} ${count === 1 ? "node" : "nodes"}` };
  });
  const modelOptions = availableModels.map((model) => ({ value: model, label: model }));
  const nodeOptions = onlineNodes.map((node) => ({ value: node.id, label: node.name, description: `${node.platform} · ${node.status}` }));
  const timeoutOptions = [
    ["300", "5 minutes"], ["900", "15 minutes"], ["1800", "30 minutes"], ["3600", "1 hour"],
    ["14400", "4 hours"], ["28800", "8 hours"], ["86400", "24 hours"]
  ].map(([value, label]) => ({ value, label, description: value === String(defaultInstanceIdleTimeoutSeconds) ? "Default" : undefined }));

  function selectTemplate(nextTemplateId: string) {
    setTemplateId(nextTemplateId);
    const template = templates.find((candidate) => candidate.id === nextTemplateId);
    if (template) {
      setName((current) => current || template.purpose?.name || template.name);
      setTitle((current) => current || template.purpose?.title || "");
      setSummary((current) => current || template.purpose?.summary || "");
      setInstructions((current) => current || template.purpose?.instructions || template.instructions || "");
      const allowedHarnesses = template.requirements?.harnessIds;
      if (allowedHarnesses) setHarnesses((current) => current.filter((harness) => (allowedHarnesses as readonly string[]).includes(harness)));
      const allowedModels = template.requirements?.models;
      if (allowedModels) setModels((current) => current.filter((model) => allowedModels.includes(model)));
    }
    setError("");
  }

  function selectHarnesses(nextHarnesses: string[]) {
    setHarnesses(nextHarnesses);
    const nextModels = new Set(onlineNodes.flatMap((node) => node.harnesses)
      .filter((harness) => harness.available && (nextHarnesses.length === 0 || nextHarnesses.includes(harness.id)))
      .flatMap((harness) => harness.models.length > 0 ? harness.models : ["default"]));
    setModels((current) => current.filter((model) => nextModels.has(model)));
    setError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canMutate || !threadId) return;
    const idleTimeoutSeconds = Number(idleTimeout);
    if (!Number.isInteger(idleTimeoutSeconds) || idleTimeoutSeconds < minimumInstanceIdleTimeoutSeconds || idleTimeoutSeconds > maximumInstanceIdleTimeoutSeconds) {
      setError(`Idle timeout must be a whole number from ${minimumInstanceIdleTimeoutSeconds} to ${maximumInstanceIdleTimeoutSeconds} seconds`);
      return;
    }
    if (includeInitialTask && (!taskTitle.trim() || !taskInstructions.trim())) {
      setError("Enter both a title and instructions for the initial task");
      return;
    }
    const selectedHarnessIds = harnesses.filter((harness) => harnessOptions.some((option) => option.value === harness));
    const selectedModels = models.filter((model) => modelOptions.some((option) => option.value === model));
    const selectedNodeIds = preferredNodes.filter((nodeId) => nodeOptions.some((option) => option.value === nodeId));
    const purpose = { ...(name.trim() ? { name: name.trim() } : {}), ...(title.trim() ? { title: title.trim() } : {}), ...(summary.trim() ? { summary: summary.trim() } : {}), ...(instructions.trim() ? { instructions: instructions.trim() } : {}) };
    const preferences: ExecutionPreferences = { ...(selectedNodeIds.length ? { nodeIds: selectedNodeIds } : {}) };
    const requirements: ExecutionRequirements = {
      ...(templateId ? { templateId } : {}), ...(commaList(skills).length ? { skills: commaList(skills) } : {}),
      ...(selectedHarnessIds.length ? { harnessIds: selectedHarnessIds as ExecutionRequirements["harnessIds"] } : {}),
      ...(selectedModels.length ? { models: selectedModels } : {}), ...(commaList(labels).length ? { labels: commaList(labels) } : {}),
      ...(preferences.nodeIds?.length ? { preferences } : {})
    };
    setSaving(true); setError("");
    try {
      await onCreate({
        threadId, ...(Object.keys(purpose).length ? { purpose } : {}), requirements,
        idleTimeoutSeconds,
        ...(includeInitialTask ? { initialTask: { title: taskTitle.trim(), instructions: taskInstructions.trim() } } : {})
      });
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start instance"); }
    finally { setSaving(false); }
  }
  return <AccessibleDialog labelledBy="create-instance-title" onClose={onClose} className="instance-dialog">
    <form onSubmit={submit} noValidate>
      <header><div><small>New runtime identity</small><h2 id="create-instance-title">Start an instance</h2><p>Choose where it belongs, what it can run, and whether it should begin with assigned work.</p></div><button type="button" className="icon-btn" aria-label="Close instance form" onClick={onClose}><X size={17} /></button></header>
      <div className="instance-form-scroll">
        {activeThreads.length === 0 ? <div className="instance-prerequisite" role="status">
          <span><Info size={18} /></span>
          <div><strong>Start with an active thread</strong><p>Every instance belongs to a thread so its work, messages, and artifacts stay together. Continue an existing thread or create one through your orchestrator, then return here.</p></div>
          {onOpenThreads && <button type="button" onClick={() => { onClose(); onOpenThreads(); }} data-dialog-initial-focus>Open threads <ArrowRight size={15} /></button>}
        </div> : <>
          <fieldset>
            <FieldsetHeading title="Context" description="An instance is scoped to one active thread. A template adds reusable role and placement defaults." />
            <div className="form-grid">
              <ChoicePicker label="Active thread" value={threadId} onChange={setThreadId} options={threadOptions} placeholder="Choose a thread" initialFocus />
              <ChoicePicker label="Template" value={templateId} onChange={selectTemplate} options={templateOptions} placeholder="No template" helper={selectedTemplate ? "Template requirements are combined with the choices below." : "Optional. Start without reusable defaults."} />
            </div>
          </fieldset>
          <fieldset>
            <FieldsetHeading title="Identity & purpose" description="Give operators a clear name and tell the instance how to behave." />
            <div className="form-grid"><TextField label="Name" value={name} onChange={setName} placeholder="Review worker" helper="A short display name for lists and activity." /><TextField label="Role title" value={title} onChange={setTitle} placeholder="Quality reviewer" helper="The responsibility this instance owns." /></div>
            <TextField label="Summary" value={summary} onChange={setSummary} placeholder="Reviews release changes for correctness and risk." helper="Visible to operators as a quick description of this instance." />
            <TextField label="Private instructions" value={instructions} onChange={setInstructions} multiline placeholder="Review carefully. Report blocking issues first…" helper="Used as this instance's system prompt. Other agents and instance tools do not receive it." />
          </fieldset>
          <fieldset>
            <FieldsetHeading title="Runtime & lease" description="Leave runtime choices open to let the Hub place the instance on any compatible capacity." />
            <div className="form-grid">
              <MultiChoicePicker label="Allowed harnesses" values={harnesses} onChange={selectHarnesses} options={harnessOptions} placeholder="Any available harness" helper={harnessOptions.length ? "Options come from live, non-offline compute nodes." : "No compatible harness is currently advertised."} />
              <MultiChoicePicker label="Allowed models" values={models} onChange={setModels} options={modelOptions} placeholder="Any available model" helper="Filtered by the selected harnesses and template." />
              <MultiChoicePicker label="Preferred nodes" values={preferredNodes} onChange={setPreferredNodes} options={nodeOptions} placeholder="Automatic placement" helper="A preference, not a hard requirement. Offline nodes are excluded." />
              <ChoicePicker label="Release after idle" value={idleTimeout} onChange={setIdleTimeout} options={timeoutOptions} placeholder="30 minutes" helper="Accepted work renews the lease. Idle instances drain after this period." />
            </div>
            <details className="instance-advanced">
              <summary><span>Advanced placement constraints</span><small>Only use identifiers advertised by your capability packs and node configuration.</small></summary>
              <div className="form-grid">
                <TextField label="Required skills" value={skills} onChange={setSkills} placeholder="typescript, review" helper="Comma-separated capability IDs. Every skill must be available." />
                <TextField label="Required node labels" value={labels} onChange={setLabels} placeholder="linux, trusted" helper="Comma-separated labels. Every label must match." />
              </div>
            </details>
          </fieldset>
          <fieldset>
            <FieldsetHeading title="First assignment" description="You can start the instance idle or queue work for it immediately." />
            <button type="button" role="switch" aria-checked={includeInitialTask} className="initial-task-toggle" onClick={() => { setIncludeInitialTask((current) => !current); setError(""); }}>
              <span className={includeInitialTask ? "checked" : ""}>{includeInitialTask && <Check size={13} weight="bold" />}</span>
              <span><strong>Queue an initial task</strong><small>Creates a task in this thread, pins it to the new instance, and runs it when placement is ready.</small></span>
            </button>
            {includeInitialTask && <div className="initial-task-fields"><TextField label="Task title" value={taskTitle} onChange={setTaskTitle} placeholder="Review the release candidate" required /><TextField label="Task instructions" value={taskInstructions} onChange={setTaskInstructions} placeholder="Inspect the current changes and report…" multiline required /></div>}
          </fieldset>
          {error && <p className="form-error" role="alert">{error}</p>}
        </>}
      </div>
      <footer><button type="button" onClick={onClose}>Cancel</button>{activeThreads.length > 0 && <button className="primary-action" disabled={!canMutate || !threadId || saving}>{saving ? "Starting…" : "Start instance"}</button>}</footer>
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
