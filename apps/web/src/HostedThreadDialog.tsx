import { useMemo, useState, type FormEvent } from "react";
import { ArrowRight, Cpu, Info, X } from "@phosphor-icons/react";
import {
  defaultInstanceIdleTimeoutSeconds,
  type AgentTemplate,
  type ComputeNode,
  type CreateHostedThreadRequest,
  type HarnessId,
  type ProjectProfile
} from "@coffee-shop/protocol";
import { AccessibleDialog } from "./AccessibleDialog.js";
import { ChoicePicker, type PickerOption } from "./instances/InstancesView.js";
import "./hostedThread.css";

export type HostedThreadPayload = Omit<CreateHostedThreadRequest, "idempotencyKey">;

const defaultInstructions = "Plan the objective, delegate bounded work to compatible instances, monitor progress, resolve questions, and synthesize the final result.";

function Field({ label, value, onChange, placeholder, helper, multiline = false, required = false }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  helper?: string;
  multiline?: boolean;
  required?: boolean;
}) {
  return <label className="hosted-field"><span>{label}{required && <em>Required</em>}</span>{multiline
    ? <textarea aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} rows={multiline ? 5 : 2} required={required} />
    : <input aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} required={required} />}{helper && <small>{helper}</small>}</label>;
}

export function HostedThreadDialog({ nodes, templates, projectProfiles, canMutate, onClose, onCreate }: {
  nodes: ComputeNode[];
  templates: AgentTemplate[];
  projectProfiles: ProjectProfile[];
  canMutate: boolean;
  onClose: () => void;
  onCreate: (payload: HostedThreadPayload) => Promise<void>;
}) {
  const eligibleNodes = useMemo(() => nodes.filter((node) => node.status !== "offline"
    && (node.instanceCapacity ?? 0) > (node.activeInstances ?? 0)
    && node.harnesses.some((harness) => harness.available)), [nodes]);
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [projectProfileId, setProjectProfileId] = useState("");
  const [name, setName] = useState("Orchestrator");
  const [instructions, setInstructions] = useState(defaultInstructions);
  const [harnessId, setHarnessId] = useState<HarnessId | "">("");
  const [model, setModel] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [idleTimeoutSeconds, setIdleTimeoutSeconds] = useState(String(defaultInstanceIdleTimeoutSeconds));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const delegatingTemplates = templates.filter((template) => template.delegation?.canDelegate === true);
  const harnesses = [...new Map(eligibleNodes.flatMap((node) => node.harnesses)
    .filter((harness) => harness.available)
    .map((harness) => [harness.id, harness])).values()];
  const models = [...new Set(eligibleNodes.flatMap((node) => node.harnesses)
    .filter((harness) => harness.available && (!harnessId || harness.id === harnessId))
    .flatMap((harness) => harness.models.length ? harness.models : ["default"]))].sort();
  const templateOptions: PickerOption[] = [
    { value: "", label: "Built-in orchestrator", description: "Use the instructions in this form" },
    ...delegatingTemplates.map((template) => ({
      value: template.id,
      label: template.name,
      description: template.purpose?.summary ?? "Reusable delegating role"
    }))
  ];
  const projectOptions: PickerOption[] = [
    { value: "", label: "No project profile", description: "Use the selected node's default workspace" },
    ...projectProfiles.map((profile) => ({ value: profile.id, label: profile.name, description: profile.repository?.url ?? profile.id }))
  ];
  const harnessOptions = [{ value: "", label: "Automatic", description: "Use any compatible harness" },
    ...harnesses.map((harness) => ({ value: harness.id, label: harness.label, description: harness.description }))];
  const modelOptions = [{ value: "", label: "Automatic", description: "Use any compatible model" },
    ...models.map((candidate) => ({ value: candidate, label: candidate }))];
  const nodeOptions = [{ value: "", label: "Automatic placement", description: "Prefer the best live capacity" },
    ...eligibleNodes.map((node) => ({
      value: node.id,
      label: node.name,
      description: `${node.platform} · ${node.activeInstances ?? 0}/${node.instanceCapacity ?? 0} resident slots`
    }))];
  const timeoutOptions = [
    ["900", "15 minutes"], ["1800", "30 minutes"], ["3600", "1 hour"], ["14400", "4 hours"], ["28800", "8 hours"], ["86400", "24 hours"]
  ].map(([value, label]) => ({ value, label, description: value === String(defaultInstanceIdleTimeoutSeconds) ? "Default" : undefined }));

  function chooseTemplate(nextTemplateId: string) {
    setTemplateId(nextTemplateId);
    const template = delegatingTemplates.find((candidate) => candidate.id === nextTemplateId);
    if (template) {
      setName(template.purpose?.name ?? template.name);
      setInstructions(template.purpose?.instructions ?? template.instructions ?? defaultInstructions);
      const requiredHarnesses = template.requirements?.harnessIds;
      if (requiredHarnesses?.length === 1) setHarnessId(requiredHarnesses[0]);
      const requiredModels = template.requirements?.models;
      if (requiredModels?.length === 1) setModel(requiredModels[0]);
    }
    setError("");
  }

  function chooseHarness(nextHarnessId: string) {
    setHarnessId(nextHarnessId as HarnessId | "");
    const availableModels = new Set(eligibleNodes.flatMap((node) => node.harnesses)
      .filter((harness) => harness.available && (!nextHarnessId || harness.id === nextHarnessId))
      .flatMap((harness) => harness.models.length ? harness.models : ["default"]));
    if (model && !availableModels.has(model)) setModel("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canMutate || saving) return;
    if (!title.trim() || !objective.trim()) {
      setError("Enter a thread title and objective");
      return;
    }
    if (eligibleNodes.length === 0) {
      setError("No live compute node currently has resident instance capacity");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const preferences = nodeId ? { nodeIds: [nodeId] } : undefined;
      await onCreate({
        title: title.trim(),
        objective: objective.trim(),
        orchestrator: {
          purpose: {
            name: name.trim() || "Orchestrator",
            title: "Thread orchestrator",
            summary: "Plans work, coordinates worker instances, and synthesizes their results.",
            instructions: instructions.trim() || defaultInstructions
          },
          requirements: {
            ...(templateId ? { templateId } : {}),
            ...(projectProfileId ? { projectProfileId } : {}),
            ...(harnessId ? { harnessIds: [harnessId] } : {}),
            ...(model ? { models: [model] } : {}),
            ...(preferences ? { preferences } : {})
          },
          idleTimeoutSeconds: Number(idleTimeoutSeconds)
        }
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the thread");
    } finally {
      setSaving(false);
    }
  }

  return <AccessibleDialog labelledBy="hosted-thread-title" onClose={onClose} className="hosted-thread-dialog">
    <form onSubmit={submit} noValidate>
      <header>
        <div><small>Resident orchestration</small><h2 id="hosted-thread-title">Start an orchestrated thread</h2><p>Coffee Shop places a lead agent on live compute. It can create workers, assign tasks, and report back here.</p></div>
        <button type="button" className="icon-btn" aria-label="Close orchestrated thread dialog" onClick={onClose}><X size={17} /></button>
      </header>
      <div className="hosted-thread-scroll">
        {eligibleNodes.length === 0 && <div className="hosted-capacity" role="status"><Info size={18} /><span><strong>No resident capacity is available</strong><small>Bring a protocol-v5 Barista online with an available harness and a free instance slot.</small></span></div>}
        <section className="hosted-objective">
          <div className="hosted-section-heading"><span>Objective</span><small>This becomes the orchestrator's first inbox instruction.</small></div>
          <Field label="Thread title" value={title} onChange={setTitle} placeholder="Ship billing export" required />
          <Field label="What should the orchestrator accomplish?" value={objective} onChange={setObjective} placeholder="Plan and deliver the feature, delegate implementation and review, then summarize the result…" multiline required />
        </section>
        <section>
          <div className="hosted-section-heading"><span>Lead agent</span><small>Choose its operating instructions and the project context it should coordinate.</small></div>
          <div className="hosted-grid">
            <ChoicePicker label="Orchestrator template" value={templateId} onChange={chooseTemplate} options={templateOptions} placeholder="Built-in orchestrator" helper={delegatingTemplates.length ? "Only templates allowed to delegate are shown." : "No delegating templates exist; the built-in role is ready to use."} />
            <ChoicePicker label="Project" value={projectProfileId} onChange={setProjectProfileId} options={projectOptions} placeholder="No project profile" helper="Constrains where the lead starts. It can apply the same profile to delegated tasks." />
          </div>
          <Field label="Display name" value={name} onChange={setName} placeholder="Orchestrator" helper="The resident identity shown on the thread and instance screens." />
          <Field label="Private instructions" value={instructions} onChange={setInstructions} multiline helper="The lead agent's system prompt. Put the actual deliverable in the objective above." />
        </section>
        <section>
          <div className="hosted-section-heading"><span>Runtime</span><small>Leave choices automatic or narrow placement to a live offering.</small></div>
          <div className="hosted-grid">
            <ChoicePicker label="Harness" value={harnessId} onChange={chooseHarness} options={harnessOptions} placeholder="Automatic" />
            <ChoicePicker label="Model" value={model} onChange={setModel} options={modelOptions} placeholder="Automatic" />
            <ChoicePicker label="Preferred machine" value={nodeId} onChange={setNodeId} options={nodeOptions} placeholder="Automatic placement" helper="A preference; the Hub still enforces compatibility and capacity." />
            <ChoicePicker label="Release after idle" value={idleTimeoutSeconds} onChange={setIdleTimeoutSeconds} options={timeoutOptions} placeholder="30 minutes" helper="New inbox work refreshes this resident lease." />
          </div>
          <div className="hosted-placement-preview"><Cpu size={18} /><span><strong>{harnessId ? harnessOptions.find((option) => option.value === harnessId)?.label : "Any harness"} · {model || "automatic model"}</strong><small>{nodeId ? nodeOptions.find((option) => option.value === nodeId)?.label : `${eligibleNodes.length} compatible ${eligibleNodes.length === 1 ? "machine" : "machines"}`} available now</small></span></div>
        </section>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <footer><button type="button" onClick={onClose}>Cancel</button><button className="primary-action" disabled={!canMutate || saving || eligibleNodes.length === 0}>{saving ? "Starting…" : <>Start thread <ArrowRight size={15} /></>}</button></footer>
    </form>
  </AccessibleDialog>;
}
