import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { CircleNotch, X } from "@phosphor-icons/react";
import type { Agent, AgentAvatarColor, AgentAvatarShape, ComputeNode, HarnessId } from "@coffee-shop/protocol";
import { AccessibleDialog } from "./AccessibleDialog.js";
import { AvatarPicker } from "./CoffeeAvatar.js";
import "./AgentConfiguration.css";

export interface AgentConfigurationPayload {
  name: string;
  title: string;
  summary: string;
  harnessId: string;
  model: string;
  computeNodeId: string;
  workspace: string;
  systemPrompt: string;
  avatarShape: string;
  avatarColor: string;
}

interface Draft extends AgentConfigurationPayload {
  harnessId: HarnessId | "";
  avatarShape: AgentAvatarShape;
  avatarColor: AgentAvatarColor;
}

function availableHarnesses(node?: ComputeNode) {
  return node && node.status !== "offline" ? node.harnesses.filter((harness) => harness.available) : [];
}

function initialDraft(nodes: readonly ComputeNode[], agent?: Agent): Draft {
  if (agent) {
    return {
      name: agent.name,
      title: agent.title,
      summary: agent.summary,
      harnessId: agent.harnessId,
      model: agent.model,
      computeNodeId: agent.computeNodeId,
      workspace: agent.workspace,
      systemPrompt: agent.systemPrompt,
      avatarShape: agent.avatarShape,
      avatarColor: agent.avatarColor
    };
  }
  const node = nodes.find((item) => availableHarnesses(item).length > 0);
  const harness = availableHarnesses(node)[0];
  return {
    name: "",
    title: "",
    summary: "",
    computeNodeId: node?.id ?? "",
    harnessId: harness?.id ?? "",
    model: harness ? harness.models[0] ?? "default" : "",
    workspace: node?.workspaceRoots[0] ?? "",
    systemPrompt: "",
    avatarShape: "cup",
    avatarColor: "amber"
  };
}

function confirmedAgentSignature(agent?: Agent) {
  return JSON.stringify(agent && {
    name: agent.name,
    title: agent.title,
    summary: agent.summary,
    harnessId: agent.harnessId,
    model: agent.model,
    computeNodeId: agent.computeNodeId,
    workspace: agent.workspace,
    systemPrompt: agent.systemPrompt,
    avatarShape: agent.avatarShape,
    avatarColor: agent.avatarColor
  });
}

function runtimeSignature(node: ComputeNode | undefined, selectedId: string, nodes: readonly ComputeNode[]) {
  if (!node) {
    return JSON.stringify({ selectedId, eligibleNodes: selectedId ? [] : nodes.filter((item) => item.status !== "offline").map((item) => item.id) });
  }
  return JSON.stringify({
    id: node.id,
    eligible: node.status !== "offline",
    roots: node.workspaceRoots,
    harnesses: node.harnesses.map((harness) => ({ id: harness.id, available: harness.available, models: harness.models }))
  });
}

export function AgentConfigurationForm({
  mode,
  agent,
  nodes,
  canMutate,
  onSave,
  onCancel,
  onReconcile,
  onSuccess
}: {
  mode: "create" | "edit";
  agent?: Agent;
  nodes: readonly ComputeNode[];
  canMutate: boolean;
  onSave: (payload: AgentConfigurationPayload) => Promise<Agent>;
  onCancel: () => void;
  onReconcile: () => void;
  onSuccess?: (agent: Agent) => void;
}) {
  const agentSignature = confirmedAgentSignature(agent);
  const previousAgentSignature = useRef(agentSignature);
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState(() => initialDraft(nodes, agent));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const selectedNode = nodes.find((node) => node.id === draft.computeNodeId);
  const harnesses = selectedNode?.harnesses ?? [];
  const selectedHarness = availableHarnesses(selectedNode).find((harness) => harness.id === draft.harnessId);
  const models = selectedHarness ? selectedHarness.models.length ? selectedHarness.models : ["default"] : [];
  const selectedRuntimeSignature = runtimeSignature(selectedNode, draft.computeNodeId, nodes);
  const previousRuntimeSignature = useRef(selectedRuntimeSignature);
  const valid = Boolean(
    draft.name.trim()
    && draft.title.trim()
    && draft.systemPrompt.trim()
    && draft.workspace.trim()
    && selectedNode
    && selectedHarness
    && models.includes(draft.model)
  );

  useEffect(() => {
    if (agentSignature === previousAgentSignature.current) return;
    previousAgentSignature.current = agentSignature;
    const confirmed = initialDraft(nodes, agent);
    previousRuntimeSignature.current = runtimeSignature(nodes.find((node) => node.id === confirmed.computeNodeId), confirmed.computeNodeId, nodes);
    setDraft(confirmed);
    setError("");
    setNotice("Draft reconciled to the latest hub snapshot. Review the available configuration before saving.");
  }, [agent, agentSignature, nodes]);

  useEffect(() => {
    if (selectedRuntimeSignature === previousRuntimeSignature.current) return;
    previousRuntimeSignature.current = selectedRuntimeSignature;
    const confirmed = initialDraft(nodes, agent);
    previousRuntimeSignature.current = runtimeSignature(nodes.find((node) => node.id === confirmed.computeNodeId), confirmed.computeNodeId, nodes);
    setDraft(confirmed);
    setError("");
    setNotice("Draft reconciled to the latest hub snapshot. Review the available configuration before saving.");
  }, [agent, nodes, selectedRuntimeSignature]);

  useEffect(() => {
    formRef.current?.querySelector<HTMLElement>("[data-dialog-initial-focus]")?.focus();
  }, []);

  const rootHint = useMemo(() => selectedNode?.workspaceRoots.join(", ") || "No workspace roots advertised", [selectedNode]);

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setError("");
    setNotice("");
  }

  function selectNode(computeNodeId: string) {
    const node = nodes.find((item) => item.id === computeNodeId);
    const harness = availableHarnesses(node)[0];
    previousRuntimeSignature.current = runtimeSignature(node, computeNodeId, nodes);
    setDraft((current) => ({
      ...current,
      computeNodeId,
      harnessId: harness?.id ?? "",
      model: harness ? harness.models[0] ?? "default" : "",
      workspace: node?.workspaceRoots[0] ?? ""
    }));
    setError("");
    setNotice("");
  }

  function selectHarness(harnessId: string) {
    const harness = availableHarnesses(selectedNode).find((item) => item.id === harnessId);
    setDraft((current) => ({
      ...current,
      harnessId: harness?.id ?? "",
      model: harness ? harness.models[0] ?? "default" : ""
    }));
    setError("");
    setNotice("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canMutate || busy || !valid) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await onSave(draft);
      onSuccess?.(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save agent configuration");
      setDraft(initialDraft(nodes, agent));
      onReconcile();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form ref={formRef} className={`agent-configuration-form mode-${mode}`} onSubmit={submit}>
      <fieldset disabled={!canMutate || busy}>
        <AvatarPicker shape={draft.avatarShape} color={draft.avatarColor} onShape={(avatarShape) => update("avatarShape", avatarShape)} onColor={(avatarColor) => update("avatarColor", avatarColor)} />
        <div className="configuration-grid">
          <label>Name<input data-dialog-initial-focus value={draft.name} onChange={(event) => update("name", event.target.value)} required /></label>
          <label>Title<input value={draft.title} onChange={(event) => update("title", event.target.value)} required /></label>
        </div>
        <label>Summary (optional)<textarea value={draft.summary} onChange={(event) => update("summary", event.target.value)} rows={2} /></label>
        <label>System prompt<textarea value={draft.systemPrompt} onChange={(event) => update("systemPrompt", event.target.value)} rows={5} required /></label>
        <div className="configuration-grid">
          <label>Compute node<select value={draft.computeNodeId} onChange={(event) => selectNode(event.target.value)}>
            {!selectedNode && draft.computeNodeId && <option value={draft.computeNodeId}>Unavailable node</option>}
            {nodes.map((node) => <option key={node.id} value={node.id} disabled={node.status === "offline"}>{node.name}{node.status === "offline" ? " (offline)" : ""}</option>)}
          </select></label>
          <label>Harness<select value={draft.harnessId} onChange={(event) => selectHarness(event.target.value)}>
            {!draft.harnessId && <option value="">No available harness</option>}
            {harnesses.map((harness) => <option key={harness.id} value={harness.id} disabled={!harness.available}>{harness.label}</option>)}
          </select></label>
          <label>Model<select value={draft.model} onChange={(event) => update("model", event.target.value)} disabled={!selectedHarness}>
            {!models.includes(draft.model) && draft.model && <option value={draft.model}>Unavailable model</option>}
            {models.map((model) => <option key={model} value={model}>{model}</option>)}
          </select></label>
          <label>Workspace<input value={draft.workspace} onChange={(event) => update("workspace", event.target.value)} required aria-describedby="workspace-roots" /></label>
        </div>
        <small id="workspace-roots" className="workspace-hint">Advertised roots: {rootHint}</small>
      </fieldset>
      {!canMutate && <p className="configuration-error" role="alert">Reconnect before saving agent configuration.</p>}
      {selectedNode?.status === "offline" && <p className="configuration-error" role="alert">The selected compute node is offline. Choose an online node before saving.</p>}
      {error && <p className="configuration-error" role="alert">{error}</p>}
      {notice && <p className="configuration-notice" role="status">{notice}</p>}
      <footer>
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="save-configuration" disabled={!canMutate || busy || !valid}>{busy ? mode === "create" ? "Creating…" : "Saving…" : mode === "create" ? "Create agent" : "Save changes"}</button>
      </footer>
    </form>
  );
}

export function CreateAgentDialog({ nodes, canMutate, onSave, onClose, onReconcile }: {
  nodes: readonly ComputeNode[];
  canMutate: boolean;
  onSave: (payload: AgentConfigurationPayload) => Promise<Agent>;
  onClose: () => void;
  onReconcile: () => void;
}) {
  return (
    <AccessibleDialog labelledBy="create-agent-title" onClose={onClose} className="agent-configuration-dialog">
      <header>
        <div><small>New teammate</small><h2 id="create-agent-title">Create an agent</h2></div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close create agent dialog"><X size={17} /></button>
      </header>
      <p>Choose a purpose and a runtime that the selected compute node currently advertises.</p>
      <AgentConfigurationForm mode="create" nodes={nodes} canMutate={canMutate} onSave={onSave} onCancel={onClose} onReconcile={onReconcile} onSuccess={onClose} />
    </AccessibleDialog>
  );
}
