import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Check, GitBranch, PencilSimple, Plus, Trash, WarningCircle, X } from "@phosphor-icons/react";
import {
  harnessIds,
  type HarnessId,
  type ProjectProfile,
  type ProjectReadiness,
  type ToolchainRequirement,
  type WorkspaceCleanupPolicy,
  type WorkspaceIsolationPolicy
} from "@coffee-shop/protocol";

type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

interface Draft {
  id: string;
  name: string;
  repositoryUrl: string;
  defaultBranch: string;
  isolation: WorkspaceIsolationPolicy;
  cleanup: WorkspaceCleanupPolicy;
  requireWritable: boolean;
  operatingSystems: string;
  architectures: string;
  labels: string;
  toolchains: string;
  harnessIds: HarnessId[];
}

const emptyDraft = (): Draft => ({
  id: "",
  name: "",
  repositoryUrl: "",
  defaultBranch: "main",
  isolation: "git-worktree",
  cleanup: "when-unchanged",
  requireWritable: true,
  operatingSystems: "linux",
  architectures: "",
  labels: "",
  toolchains: "",
  harnessIds: ["claude-cli", "codex-cli"]
});

const splitValues = (value: string) => value.split(",").map((entry) => entry.trim()).filter(Boolean);
const optionalValues = (value: string) => {
  const values = splitValues(value);
  return values.length > 0 ? values : undefined;
};
const slug = (value: string) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);

function toolchainsFromText(value: string): ToolchainRequirement[] | undefined {
  const result = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [capabilityId, label, versionConstraint] = line.split("|").map((entry) => entry.trim());
    return { capabilityId, label: label || capabilityId, ...(versionConstraint ? { versionConstraint } : {}) };
  });
  return result.length > 0 ? result : undefined;
}

function draftFromProfile(profile: ProjectProfile): Draft {
  const hard = profile.requirements.hard;
  return {
    id: profile.id,
    name: profile.name,
    repositoryUrl: profile.repository?.url ?? "",
    defaultBranch: profile.repository?.defaultBranch ?? "main",
    isolation: profile.workspacePolicy.isolation ?? "exclusive-existing",
    cleanup: profile.workspacePolicy.cleanup ?? "retain",
    requireWritable: profile.workspacePolicy.requireWritable,
    operatingSystems: hard.operatingSystems?.join(", ") ?? "",
    architectures: hard.architectures?.join(", ") ?? "",
    labels: hard.labels?.join(", ") ?? "",
    toolchains: hard.toolchains?.map((toolchain) => [toolchain.capabilityId, toolchain.label, toolchain.versionConstraint].filter(Boolean).join("|")).join("\n") ?? "",
    harnessIds: hard.harnessIds ?? []
  };
}

function profileFromDraft(draft: Draft, existing?: ProjectProfile): ProjectProfile {
  const repository = draft.repositoryUrl.trim()
    ? { url: draft.repositoryUrl.trim(), defaultBranch: draft.defaultBranch.trim() }
    : undefined;
  const {
    operatingSystems: _operatingSystems,
    architectures: _architectures,
    labels: _labels,
    toolchains: _toolchains,
    harnessIds: _harnessIds,
    ...advancedHardRequirements
  } = existing?.requirements.hard ?? {};
  return {
    schemaVersion: 1,
    id: draft.id.trim(),
    name: draft.name.trim(),
    ...(repository ? { repository } : {}),
    workspacePolicy: {
      ...existing?.workspacePolicy,
      requireWritable: draft.requireWritable,
      ...(repository ? { allowedRepositories: [repository.url] } : { allowedRepositories: undefined }),
      isolation: draft.isolation,
      cleanup: draft.cleanup
    },
    requirements: {
      hard: {
        ...advancedHardRequirements,
        ...(optionalValues(draft.operatingSystems) ? { operatingSystems: optionalValues(draft.operatingSystems) } : {}),
        ...(optionalValues(draft.architectures) ? { architectures: optionalValues(draft.architectures) } : {}),
        ...(optionalValues(draft.labels) ? { labels: optionalValues(draft.labels) } : {}),
        ...(toolchainsFromText(draft.toolchains) ? { toolchains: toolchainsFromText(draft.toolchains) } : {}),
        ...(draft.harnessIds.length > 0 ? { harnessIds: draft.harnessIds } : {})
      },
      ...(existing?.requirements.preferred ? { preferred: existing.requirements.preferred } : {})
    }
  };
}

function ProfileEditor({ profile, canMutate, apiFetch, onDone }: {
  profile?: ProjectProfile;
  canMutate: boolean;
  apiFetch: ApiFetch;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(() => profile ? draftFromProfile(profile) : emptyDraft());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const update = <K extends keyof Draft>(field: K, value: Draft[K]) => setDraft((current) => ({ ...current, [field]: value }));
  const toggleHarness = (id: HarnessId) => update("harnessIds", draft.harnessIds.includes(id)
    ? draft.harnessIds.filter((entry) => entry !== id)
    : [...draft.harnessIds, id]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canMutate) return;
    setSaving(true);
    setError("");
    try {
      const payload = profileFromDraft(draft, profile);
      const response = await apiFetch(profile ? `/api/project-profiles/${encodeURIComponent(profile.id)}` : "/api/project-profiles", {
        method: profile ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(failure.error ?? `Could not save project (${response.status})`);
      }
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save project");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="project-editor" onSubmit={submit}>
      <header><div><small>{profile ? "Edit profile" : "New profile"}</small><h2>{profile?.name ?? "Define a project"}</h2></div><button type="button" className="icon-btn" onClick={onDone} aria-label="Close project editor"><X size={17} /></button></header>
      <div className="project-fields two-columns">
        <label>Name<input required value={draft.name} onChange={(event) => { update("name", event.target.value); if (!profile) update("id", slug(event.target.value)); }} placeholder="Uzir" /></label>
        <label>Project ID<input required disabled={Boolean(profile)} pattern="[a-z0-9][a-z0-9-]{0,63}" value={draft.id} onChange={(event) => update("id", event.target.value)} placeholder="uzir" /></label>
      </div>
      <div className="project-fields two-columns">
        <label>Repository URL<input required={draft.isolation === "git-worktree"} value={draft.repositoryUrl} onChange={(event) => update("repositoryUrl", event.target.value)} placeholder="https://github.com/cafecito-games/uzir" /></label>
        <label>Default branch<input required={Boolean(draft.repositoryUrl)} value={draft.defaultBranch} onChange={(event) => update("defaultBranch", event.target.value)} placeholder="main" /></label>
      </div>
      <fieldset><legend>Workspace isolation</legend><div className="choice-row">
        {(["git-worktree", "exclusive-existing"] as const).map((value) => <button type="button" key={value} className={draft.isolation === value ? "selected" : ""} onClick={() => update("isolation", value)}><GitBranch size={15} />{value === "git-worktree" ? "New worktree per task" : "Lock existing checkout"}</button>)}
      </div></fieldset>
      <fieldset><legend>Cleanup policy</legend><div className="choice-row">
        {(["when-unchanged", "retain"] as const).map((value) => <button type="button" key={value} className={draft.cleanup === value ? "selected" : ""} onClick={() => update("cleanup", value)}>{value === "when-unchanged" ? "Clean unchanged worktrees" : "Always retain"}</button>)}
      </div></fieldset>
      <label className="check-row"><input type="checkbox" checked={draft.requireWritable} onChange={(event) => update("requireWritable", event.target.checked)} /><span><strong>Writable workspace required</strong><small>Read-only checkouts will not be eligible.</small></span></label>
      <div className="project-fields two-columns">
        <label>Operating systems<input value={draft.operatingSystems} onChange={(event) => update("operatingSystems", event.target.value)} placeholder="linux, darwin" /><small>Comma separated; leave empty for any OS.</small></label>
        <label>Architectures<input value={draft.architectures} onChange={(event) => update("architectures", event.target.value)} placeholder="amd64, arm64" /><small>Comma separated; leave empty for any architecture.</small></label>
      </div>
      <fieldset><legend>Allowed harnesses</legend><div className="choice-row compact">
        {harnessIds.filter((id) => id === "claude-cli" || id === "codex-cli").map((id) => <button type="button" key={id} className={draft.harnessIds.includes(id) ? "selected" : ""} onClick={() => toggleHarness(id)}>{draft.harnessIds.includes(id) && <Check size={14} />}{id === "claude-cli" ? "Claude" : "Codex"}</button>)}
      </div></fieldset>
      <label className="project-field">Required labels<input value={draft.labels} onChange={(event) => update("labels", event.target.value)} placeholder="godot, gpu" /><small>Optional node labels, comma separated.</small></label>
      <label className="project-field">Required toolchains<textarea rows={3} value={draft.toolchains} onChange={(event) => update("toolchains", event.target.value)} placeholder={"godot|Godot|>=4.4.0\nnode|Node.js|>=24.0.0"} /><small>One per line: capability id | display name | optional version constraint.</small></label>
      {error && <p className="project-error"><WarningCircle size={15} />{error}</p>}
      <footer><button type="button" onClick={onDone}>Cancel</button><button className="save-project" disabled={!canMutate || saving}>{saving ? "Saving…" : profile ? "Save changes" : "Create project"}</button></footer>
    </form>
  );
}

export function ProjectsView({ profiles, canMutate, apiFetch }: { profiles: ProjectProfile[]; canMutate: boolean; apiFetch: ApiFetch }) {
  const [editingId, setEditingId] = useState<string | null>();
  const [deletingId, setDeletingId] = useState<string>();
  const [error, setError] = useState("");
  const [readiness, setReadiness] = useState<Record<string, ProjectReadiness[]>>({});
  const editing = profiles.find((profile) => profile.id === editingId);
  const sorted = useMemo(() => [...profiles].sort((left, right) => left.name.localeCompare(right.name)), [profiles]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(profiles.map(async (profile) => {
      const response = await apiFetch(`/api/project-readiness?projectId=${encodeURIComponent(profile.id)}`);
      if (!response.ok) return [profile.id, []] as const;
      const body = await response.json() as { readiness: ProjectReadiness[] };
      return [profile.id, body.readiness] as const;
    })).then((entries) => { if (!cancelled) setReadiness(Object.fromEntries(entries)); });
    return () => { cancelled = true; };
  }, [profiles, apiFetch]);

  async function remove(id: string) {
    setError("");
    const response = await apiFetch(`/api/project-profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({})) as { error?: string };
      setError(failure.error ?? `Could not delete project (${response.status})`);
      return;
    }
    setDeletingId(undefined);
  }

  return (
    <main className="utility-view projects-view">
      <header className="utility-header"><div><small>Scheduling catalog</small><h1>Projects</h1></div><button className="primary-btn" onClick={() => setEditingId(null)} disabled={!canMutate}><Plus size={16} /> Add project</button></header>
      <p className="projects-lede">Profiles tell the scheduler which machines can run a project and how each task gets an isolated workspace. Changes take effect immediately.</p>
      {profiles.length === 0 && editingId === undefined && <div className="projects-empty"><GitBranch size={23} /><strong>No projects configured</strong><p>Add a project to enable readiness checks and worktree-isolated task execution.</p><button className="primary-btn" onClick={() => setEditingId(null)} disabled={!canMutate}><Plus size={15} /> Add your first project</button></div>}
      <div className="project-list">
        {sorted.map((profile) => {
          const nodes = readiness[profile.id] ?? [];
          const ready = nodes.filter((node) => node.ready).length;
          return <article key={profile.id} className="project-row">
            <span className="project-icon"><GitBranch size={18} /></span>
            <div className="project-main"><div><strong>{profile.name}</strong><code>{profile.id}</code></div><p>{profile.repository?.url ?? "Existing workspace"}</p><div className="project-tags"><span>{profile.workspacePolicy.isolation ?? "shared"}</span><span>{profile.workspacePolicy.cleanup ?? "retain"}</span><span className={ready > 0 ? "ready" : ""}>{ready}/{nodes.length} nodes ready</span></div></div>
            <div className="project-actions"><button onClick={() => setEditingId(profile.id)} disabled={!canMutate} aria-label={`Edit ${profile.name}`}><PencilSimple size={15} /></button><button className="danger" onClick={() => setDeletingId(profile.id)} disabled={!canMutate} aria-label={`Delete ${profile.name}`}><Trash size={15} /></button></div>
            {deletingId === profile.id && <div className="project-confirm"><span>Delete {profile.name}? Active tasks or workspaces will prevent removal.</span><button onClick={() => setDeletingId(undefined)}>Cancel</button><button className="danger" onClick={() => void remove(profile.id)}>Delete</button></div>}
          </article>;
        })}
      </div>
      {error && <p className="project-error"><WarningCircle size={15} />{error}</p>}
      {editingId !== undefined && <div className="project-editor-shell"><ProfileEditor key={editing?.id ?? "new"} profile={editing} canMutate={canMutate} apiFetch={apiFetch} onDone={() => setEditingId(undefined)} /></div>}
    </main>
  );
}
