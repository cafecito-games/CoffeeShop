import { useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, MagnifyingGlass, Plus, SealCheck, X } from "@phosphor-icons/react";
import {
  agentAvatarColors,
  agentAvatarShapes,
  type AgentTemplate,
  type ExecutionPreferences,
  type ExecutionRequirements,
  type InstancePurpose
} from "@coffee-shop/protocol";
import { AccessibleDialog } from "../AccessibleDialog.js";
import { CoffeeAvatar } from "../CoffeeAvatar.js";
import "./templates.css";

const commaList = (value: string) => [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
const commaText = (value?: string[]) => value?.join(", ") ?? "";

export type TemplateChanges = Omit<AgentTemplate, "id" | "legacyAgentId">;

export function TemplateSidebar({ templates, selectedId, canMutate, connectionLabel, onSelect, onCreate }: {
  templates: AgentTemplate[];
  selectedId?: string;
  canMutate: boolean;
  connectionLabel: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = templates.filter((template) => `${template.name} ${template.tags?.join(" ") ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  return <aside className="roster template-roster">
    <div className="brand-row"><strong>Templates</strong><button className="icon-btn" aria-label="Create template" onClick={onCreate} disabled={!canMutate}><Plus size={17} /></button></div>
    <label className="search"><MagnifyingGlass size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a template" /></label>
    <div className="section-label"><span>Reusable defaults</span><small>{templates.length}</small></div>
    <div className="template-list">{filtered.map((template) => <button key={template.id} className={selectedId === template.id ? "selected" : ""} onClick={() => onSelect(template.id)}>
      <CoffeeAvatar shape={template.avatarShape ?? "cup"} color={template.avatarColor ?? "amber"} size="sm" label={template.name} />
      <span><strong>{template.name}</strong><small>{template.purpose?.title ?? template.id}</small></span>
      {template.legacyAgentId && <SealCheck size={15} aria-label="Imported template" />}
    </button>)}</div>
    <div className="roster-foot"><span><i className={canMutate ? "online-dot" : "offline-dot"} />{connectionLabel}</span><small>defaults only</small></div>
  </aside>;
}

export function TemplateDetail({ template, canMutate, onEdit, onDelete, onBack }: {
  template?: AgentTemplate;
  canMutate: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onBack?: () => void;
}) {
  if (!template) return <main className="template-detail template-welcome"><div><small>Reusable defaults</small><h1>Choose a template</h1><p>Templates describe intent. They do not prove that an instance is online or that capacity exists.</p></div></main>;
  return <main className="template-detail">
    <header className="template-detail-header"><div className="template-title"><button className="mobile-detail-back" onClick={onBack} aria-label="Back to templates"><ArrowLeft size={19} /></button>
      <CoffeeAvatar shape={template.avatarShape ?? "cup"} color={template.avatarColor ?? "amber"} size="lg" label={template.name} />
      <div><small>Template</small><h1>{template.name}</h1><code>{template.id}</code></div>
    </div><div className="template-actions"><button onClick={onEdit} disabled={!canMutate}>Edit</button><button className="danger-button" onClick={onDelete} disabled={!canMutate}>Delete</button></div></header>
    {template.legacyAgentId && <div className="imported-banner"><SealCheck size={17} /><span><strong>Imported template</strong>Provenance from <code>{template.legacyAgentId}</code> is preserved by every edit.</span></div>}
    <div className="template-grid">
      <section><div className="section-label"><span>Purpose</span></div><h2>{template.purpose?.title ?? template.name}</h2><p>{template.purpose?.summary ?? "Summary unavailable"}</p><pre>{template.instructions ?? template.purpose?.instructions ?? "No instructions"}</pre></section>
      <section><div className="section-label"><span>Metadata</span></div><dl><div><dt>Skills</dt><dd>{template.skills?.join(", ") || "None"}</dd></div><div><dt>Tags</dt><dd>{template.tags?.join(", ") || "None"}</dd></div><div><dt>Delegation</dt><dd>{template.delegation?.canDelegate ? "May delegate" : "Worker only"}</dd></div></dl></section>
      <section><div className="section-label"><span>Hard requirements</span></div><pre>{template.requirements ? JSON.stringify(template.requirements, null, 2) : "No hard requirements"}</pre></section>
      <section><div className="section-label"><span>Placement preferences</span></div><pre>{template.preferences ? JSON.stringify(template.preferences, null, 2) : "No placement preferences"}</pre></section>
    </div>
  </main>;
}

export function MobileTemplateIndex({ templates, canMutate, onSelect, onCreate }: { templates: AgentTemplate[]; canMutate: boolean; onSelect: (id: string) => void; onCreate: () => void }) {
  return <main className="mobile-template-index"><header><div><small>Reusable defaults</small><h1>Templates</h1></div><button aria-label="Create template" onClick={onCreate} disabled={!canMutate}><Plus size={18} /></button></header><div>{templates.map((template) => <button key={template.id} onClick={() => onSelect(template.id)}><CoffeeAvatar shape={template.avatarShape ?? "cup"} color={template.avatarColor ?? "amber"} size="sm" label={template.name} /><span><strong>{template.name}</strong><small>{template.purpose?.title ?? template.id}</small></span>{template.legacyAgentId ? <SealCheck size={16} /> : <ArrowRight size={16} />}</button>)}{templates.length === 0 && <p>No templates yet.</p>}</div></main>;
}

function Field({ label, value, onChange, multiline, required, placeholder }: { label: string; value: string; onChange: (value: string) => void; multiline?: boolean; required?: boolean; placeholder?: string }) {
  return <label className="template-field"><span>{label}</span>{multiline
    ? <textarea rows={3} value={value} onChange={(event) => onChange(event.target.value)} required={required} placeholder={placeholder} />
    : <input value={value} onChange={(event) => onChange(event.target.value)} required={required} placeholder={placeholder} />}</label>;
}

const parseObject = <T extends object>(value: string, label: string): T | undefined => {
  if (!value.trim()) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed as T;
};

export function TemplateEditorDialog({ template, canMutate, onClose, onSave }: {
  template?: AgentTemplate;
  canMutate: boolean;
  onClose: () => void;
  onSave: (changes: TemplateChanges) => Promise<void>;
}) {
  const [name, setName] = useState(template?.name ?? "");
  const [purposeName, setPurposeName] = useState(template?.purpose?.name ?? "");
  const [title, setTitle] = useState(template?.purpose?.title ?? "");
  const [summary, setSummary] = useState(template?.purpose?.summary ?? "");
  const [purposeInstructions, setPurposeInstructions] = useState(template?.purpose?.instructions ?? "");
  const [glyph, setGlyph] = useState(template?.glyph ?? "");
  const [avatarShape, setAvatarShape] = useState(template?.avatarShape ?? "cup");
  const [avatarColor, setAvatarColor] = useState(template?.avatarColor ?? "amber");
  const [instructions, setInstructions] = useState(template?.instructions ?? "");
  const [skills, setSkills] = useState(commaText(template?.skills));
  const [tags, setTags] = useState(commaText(template?.tags));
  const [requirements, setRequirements] = useState(template?.requirements ? JSON.stringify(template.requirements, null, 2) : "");
  const [preferences, setPreferences] = useState(template?.preferences ? JSON.stringify(template.preferences, null, 2) : "");
  const [canDelegate, setCanDelegate] = useState(template?.delegation?.canDelegate ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!canMutate) return;
    setSaving(true); setError("");
    try {
      const purpose: InstancePurpose = {
        ...(purposeName.trim() ? { name: purposeName.trim() } : {}), ...(title.trim() ? { title: title.trim() } : {}),
        ...(summary.trim() ? { summary: summary.trim() } : {}), ...(purposeInstructions.trim() ? { instructions: purposeInstructions.trim() } : {})
      };
      const hard = parseObject<ExecutionRequirements>(requirements, "Requirements");
      const preferred = parseObject<ExecutionPreferences>(preferences, "Preferences");
      await onSave({
        name: name.trim(),
        ...(template ? { purpose, glyph: glyph.trim(), instructions: instructions.trim(), skills: commaList(skills), tags: commaList(tags), requirements: hard ?? {}, preferences: preferred ?? {} }
          : { ...(Object.keys(purpose).length ? { purpose } : {}), ...(glyph.trim() ? { glyph: glyph.trim() } : {}), ...(instructions.trim() ? { instructions: instructions.trim() } : {}), ...(commaList(skills).length ? { skills: commaList(skills) } : {}), ...(commaList(tags).length ? { tags: commaList(tags) } : {}), ...(hard ? { requirements: hard } : {}), ...(preferred ? { preferences: preferred } : {}) }),
        avatarShape, avatarColor, delegation: { canDelegate }
      });
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save template"); }
    finally { setSaving(false); }
  }
  return <AccessibleDialog labelledBy="template-editor-title" onClose={onClose} className="template-dialog"><form onSubmit={submit}>
    <header><div><small>{template ? "Edit reusable defaults" : "New reusable defaults"}</small><h2 id="template-editor-title">{template ? template.name : "Create template"}</h2></div><button type="button" className="icon-btn" aria-label="Close template editor" onClick={onClose}><X size={17} /></button></header>
    <div className="template-form-scroll">
      <fieldset><legend>Identity</legend><div className="template-form-grid"><Field label="Name" value={name} onChange={setName} required /><Field label="Glyph" value={glyph} onChange={setGlyph} /></div><div className="avatar-choice"><CoffeeAvatar shape={avatarShape} color={avatarColor} size="lg" label={name || "Template preview"} /><div><span>Shape</span>{agentAvatarShapes.map((shape) => <button type="button" key={shape} className={avatarShape === shape ? "selected" : ""} onClick={() => setAvatarShape(shape)}>{shape}</button>)}</div><div><span>Color</span>{agentAvatarColors.map((color) => <button type="button" key={color} className={avatarColor === color ? "selected" : ""} onClick={() => setAvatarColor(color)}>{color}</button>)}</div></div></fieldset>
      <fieldset><legend>Purpose</legend><div className="template-form-grid"><Field label="Purpose name" value={purposeName} onChange={setPurposeName} /><Field label="Title" value={title} onChange={setTitle} /></div><Field label="Summary" value={summary} onChange={setSummary} /><Field label="Purpose instructions" value={purposeInstructions} onChange={setPurposeInstructions} multiline /><Field label="Default instructions" value={instructions} onChange={setInstructions} multiline /></fieldset>
      <fieldset><legend>Discovery</legend><div className="template-form-grid"><Field label="Skills" value={skills} onChange={setSkills} placeholder="typescript, review" /><Field label="Tags" value={tags} onChange={setTags} placeholder="quality, backend" /></div><label className="template-check"><input type="checkbox" checked={canDelegate} onChange={(event) => setCanDelegate(event.target.checked)} /><span><strong>May delegate</strong><small>Instances inherit this Hub-granted default.</small></span></label></fieldset>
      <fieldset><legend>Placement</legend><Field label="Hard requirements (JSON)" value={requirements} onChange={setRequirements} multiline placeholder={'{"models":["default"],"labels":["linux"]}'} /><Field label="Preferences (JSON, ordered)" value={preferences} onChange={setPreferences} multiline placeholder={'{"nodeIds":["node-one"]}'} /></fieldset>
      {error && <p className="template-error" role="alert">{error}</p>}
    </div>
    <footer><button type="button" onClick={onClose}>Cancel</button><button className="primary-action" disabled={!canMutate || !name.trim() || saving}>{saving ? "Saving…" : "Save template"}</button></footer>
  </form></AccessibleDialog>;
}

export function DeleteTemplateDialog({ template, canMutate, onClose, onDelete }: { template: AgentTemplate; canMutate: boolean; onClose: () => void; onDelete: () => Promise<void> }) {
  const [saving, setSaving] = useState(false); const [error, setError] = useState("");
  async function submit(event: FormEvent) { event.preventDefault(); setSaving(true); setError(""); try { await onDelete(); onClose(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not delete template"); } finally { setSaving(false); } }
  return <AccessibleDialog labelledBy="delete-template-title" onClose={onClose} className="template-dialog delete-template-dialog"><form onSubmit={submit}><header><div><small>Reference-safe delete</small><h2 id="delete-template-title">Delete {template.name}?</h2></div><button type="button" className="icon-btn" aria-label="Close delete confirmation" onClick={onClose}><X size={17} /></button></header><p>The Hub will refuse this change while active tasks or instances still reference the template.</p>{template.legacyAgentId && <p className="import-note">Its legacy import decision remains recorded, so it will not reappear after restart.</p>}{error && <p className="template-error" role="alert">{error}</p>}<footer><button type="button" onClick={onClose} data-dialog-initial-focus>Keep template</button><button className="danger-button" disabled={!canMutate || saving}>{saving ? "Deleting…" : "Delete template"}</button></footer></form></AccessibleDialog>;
}
