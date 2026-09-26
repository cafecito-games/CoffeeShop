import {
  validateAgentTemplate,
  type Agent,
  type AgentTemplate,
  type ExecutionRequirements
} from "@coffee-shop/protocol";
import { newEvent, type State } from "./store.js";

/*
 * Legacy agent to template import.
 *
 * A configured `Agent` is two things at once: a reusable role — name, presentation, instructions,
 * skills — and a fixed binding to one node, harness, model, and workspace. A v5 `AgentTemplate` is
 * only the first of those, so the import keeps the role verbatim and translates the binding into
 * requirements and preferences: the harness, model and workspace a legacy agent was configured with
 * are hard requirements of any instance created from it, while its node becomes a *preference*,
 * because a template never fixes a node binding.
 *
 * The import creates no capacity. A template is inert: no instance, no allocation, no node slot.
 *
 * A successful import runs once per agent, ever. The marker is the deterministic `legacyAgentId` on
 * the template plus a persisted import record, never a timestamp, so a restart finds the previous
 * decision and writes nothing. A refusal is recorded with its reason and surfaced as an event rather
 * than silently coercing an agent whose configuration cannot be represented.
 *
 * A refusal is not permanent, though: it describes one configuration, not the agent for ever. An
 * operator who fixes the configuration would otherwise find the agent barred from ever importing, so
 * `reconsiderLegacyAgentImport` drops the refusal when the configuration changes, and the next import
 * pass decides afresh. A recorded *success* is never reconsidered — that is what keeps the import
 * single-shot.
 */

/** The deterministic identity of the template imported from one legacy agent. */
export const legacyTemplateId = (agentId: string) => `legacy-${agentId}`;

/** One recorded import decision. Its presence is what makes the import happen exactly once. */
export interface LegacyTemplateImport {
  agentId: string;
  /** The template written, or absent when the agent could not be represented. */
  templateId?: string;
  /** Why the agent was not imported; absent on success. */
  reason?: string;
  at: string;
}

const normalizedSkills = (skills: readonly string[] | undefined) => {
  const normalized = [...new Set((skills ?? []).map((skill) => skill.trim().toLowerCase()).filter((skill) => skill.length > 0))];
  return normalized.length ? normalized : undefined;
};

const trimmed = (value: string | undefined) => {
  const text = value?.trim();
  return text ? text : undefined;
};

/**
 * Builds the template one legacy agent imports to, without writing it. Returns a reason instead when
 * the result is not a valid template: a configuration this hub cannot represent must surface for an
 * operator, never be coerced into a template that would place work differently from the agent.
 */
export function templateFromLegacyAgent(agent: Agent): { ok: true; template: AgentTemplate } | { ok: false; reason: string } {
  const requirements: ExecutionRequirements = {
    harnessIds: [agent.harnessId],
    models: [agent.model],
    /*
     * The path is a hard requirement; writability is not. A configured agent's workspace was never
     * checked for writability, and `writable: true` is a capability requirement that needs
     * worker-reported evidence — asserting it would make every imported template unplaceable on a
     * fleet that reports none, which is not the behaviour the agent had.
     */
    workspace: { path: agent.workspace, writable: false },
    ...(normalizedSkills(agent.skills) ? { skills: normalizedSkills(agent.skills) } : {})
  };
  const template: AgentTemplate = {
    id: legacyTemplateId(agent.id),
    name: agent.name,
    purpose: {
      name: agent.name,
      ...(trimmed(agent.title) ? { title: agent.title } : {}),
      ...(trimmed(agent.summary) ? { summary: agent.summary } : {}),
      ...(trimmed(agent.systemPrompt) ? { instructions: agent.systemPrompt } : {})
    },
    ...(trimmed(agent.glyph) ? { glyph: agent.glyph } : {}),
    avatarShape: agent.avatarShape,
    avatarColor: agent.avatarColor,
    ...(trimmed(agent.systemPrompt) ? { instructions: agent.systemPrompt } : {}),
    ...(normalizedSkills(agent.skills) ? { skills: normalizedSkills(agent.skills) } : {}),
    requirements,
    // The node the agent was pinned to ranks offerings; it never excludes one.
    preferences: { nodeIds: [agent.computeNodeId] },
    delegation: { canDelegate: agent.canDelegate === true },
    legacyAgentId: agent.id
  };
  const validated = validateAgentTemplate(template);
  return validated.ok ? { ok: true, template } : { ok: false, reason: validated.reason };
}

/** The template a legacy agent was imported to, found by its deterministic source marker. */
export const templateForLegacyAgent = (state: Readonly<State>, agentId: string): AgentTemplate | undefined =>
  (state.templates ?? []).find((template) => template.legacyAgentId === agentId);

/**
 * Imports every configured agent that has not been decided yet, inside the caller's transaction.
 * Idempotent across restarts: an agent with a recorded decision — success or refusal — is skipped,
 * and so is one whose template already exists under another record. Returns whether anything changed.
 */
export function importLegacyAgentTemplates(state: State, at: string): boolean {
  let changed = false;
  state.templates ??= [];
  state.legacyTemplateImports ??= [];
  const decided = new Set(state.legacyTemplateImports.map((record) => record.agentId));
  for (const agent of state.agents) {
    if (decided.has(agent.id)) continue;
    if (templateForLegacyAgent(state, agent.id) !== undefined) {
      // A template already carries this marker: record the decision so the scan is stable, but never
      // write a second template for the same agent.
      state.legacyTemplateImports.push({ agentId: agent.id, templateId: legacyTemplateId(agent.id), at });
      changed = true;
      continue;
    }
    const built = templateFromLegacyAgent(agent);
    if (!built.ok) {
      state.legacyTemplateImports.push({ agentId: agent.id, reason: built.reason, at });
      state.events.unshift(newEvent({
        type: "status",
        title: "Legacy agent could not be imported",
        detail: `${agent.name} (${agent.id}) has no representable template: ${built.reason}`,
        agentId: agent.id
      }));
      changed = true;
      continue;
    }
    if (state.templates.some((template) => template.id === built.template.id)) {
      state.legacyTemplateImports.push({ agentId: agent.id, reason: `template ${built.template.id} already exists`, at });
      changed = true;
      continue;
    }
    /*
     * A successful import is recorded in `legacyTemplateImports`, not in the operator's timeline: it
     * creates no capacity and changes no behaviour on its own, so it is audit history rather than
     * something an operator must react to. Only a refusal asks for attention.
     */
    state.templates.push(built.template);
    state.legacyTemplateImports.push({ agentId: agent.id, templateId: built.template.id, at });
    changed = true;
  }
  return changed;
}

/**
 * Forgets a recorded *refusal* for one agent, so its next import pass re-decides. Called when an
 * operator changes the agent's configuration: the refusal described the configuration that existed
 * then, and keeping it would bar a now-representable agent for ever. A recorded success is left
 * untouched, so this can never cause a second import.
 */
export function reconsiderLegacyAgentImport(state: State, agentId: string) {
  const records = state.legacyTemplateImports ?? [];
  const refused = records.filter((record) => record.agentId === agentId && record.templateId === undefined);
  if (refused.length === 0) return false;
  state.legacyTemplateImports = records.filter((record) => !refused.includes(record));
  return true;
}

/** Rejects persisted templates and import records the hub cannot interpret. */
export function assertPersistedTemplateState(state: State) {
  const ids = new Set<string>();
  const legacySources = new Set<string>();
  for (const [index, template] of (state.templates ?? []).entries()) {
    const context = `Persisted agent template ${index}`;
    const validated = validateAgentTemplate(template);
    if (!validated.ok) throw new Error(`${context} is malformed: ${validated.reason}`);
    if (ids.has(validated.value.id)) throw new Error(`${context} repeats template id ${validated.value.id}`);
    ids.add(validated.value.id);
    const source = validated.value.legacyAgentId;
    if (source === undefined) continue;
    // Two templates claiming the same legacy agent would make the import non-deterministic.
    if (legacySources.has(source)) throw new Error(`${context} repeats legacy agent source ${source}`);
    legacySources.add(source);
  }
  const decided = new Set<string>();
  for (const [index, record] of (state.legacyTemplateImports ?? []).entries()) {
    const context = `Persisted legacy template import ${index}`;
    if (typeof record !== "object" || record === null || Array.isArray(record)) throw new Error(`${context} is not an object`);
    const entry = record as unknown as Record<string, unknown>;
    if (typeof entry.agentId !== "string" || entry.agentId.length === 0) throw new Error(`${context} is missing its agent id`);
    if (typeof entry.at !== "string" || entry.at.length === 0) throw new Error(`${context} is missing its decision time`);
    if (entry.templateId !== undefined && typeof entry.templateId !== "string") throw new Error(`${context} has a malformed template id`);
    if (entry.reason !== undefined && typeof entry.reason !== "string") throw new Error(`${context} has a malformed reason`);
    if (entry.templateId !== undefined && entry.reason !== undefined) throw new Error(`${context} records both a template and a refusal`);
    if (decided.has(entry.agentId)) throw new Error(`${context} repeats agent ${entry.agentId}`);
    decided.add(entry.agentId);
  }
}
