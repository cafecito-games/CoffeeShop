import { posix, win32 } from "node:path";
import {
  agentAvatarColors,
  agentAvatarShapes,
  harnessIds,
  type Agent,
  type AgentAvatarColor,
  type AgentAvatarShape,
  type ComputeNode,
  type HarnessId,
  type Run
} from "@coffee-shop/protocol";

export interface AgentConfigurationState {
  agents: Agent[];
  nodes: ComputeNode[];
  runs: Run[];
}

interface ConnectedNodeLookup {
  has(id: string): boolean;
}

export function openConnectionLookup<T extends { readyState: number }>(
  connections: { get(id: string): T | undefined },
  openReadyState: number
): ConnectedNodeLookup {
  return { has: (id) => connections.get(id)?.readyState === openReadyState };
}

type EditableAgentConfiguration = Pick<Agent,
  "name" | "title" | "summary" | "harnessId" | "model" | "computeNodeId" |
  "workspace" | "systemPrompt" | "avatarShape" | "avatarColor" | "glyph" | "canDelegate" | "skills">;

type ConfigurationFailure = { ok: false; kind: "invalid" | "not-found"; error: string };
type CreateResult = { ok: true; agent: Agent; node: ComputeNode } | ConfigurationFailure;
type UpdateResult = { ok: true; agent: Agent; node: ComputeNode; changed: boolean } | ConfigurationFailure;

const stringEditableKeys = [
  "name", "title", "summary", "harnessId", "model", "computeNodeId", "workspace",
  "systemPrompt", "avatarShape", "avatarColor"
] as const;
const editableKeys = [...stringEditableKeys, "canDelegate", "skills"] as const;
const editableKeySet = new Set<string>(editableKeys);

function invalid(error: string): ConfigurationFailure {
  return { ok: false, kind: "invalid", error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const agentSkillLimits = { entries: 32, bytes: 64 } as const;
const agentSkillPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const encoder = new TextEncoder();

/**
 * Skills are lowercase kebab-case identifiers so a task requirement matches them exactly after
 * lowercasing. Rejections name the position only, never the submitted value.
 */
function normalizeSkills(value: unknown): { ok: true; skills: string[] } | ConfigurationFailure {
  if (!Array.isArray(value)) return invalid("skills must be an array of strings");
  if (value.length > agentSkillLimits.entries) return invalid(`skills must have at most ${agentSkillLimits.entries} entries`);
  const skills = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") return invalid(`skills[${index}] must be a string`);
    const skill = entry.trim().toLowerCase();
    if (encoder.encode(skill).length > agentSkillLimits.bytes || !agentSkillPattern.test(skill)) {
      return invalid(`skills[${index}] must be lowercase letters, numbers, and single hyphens, at most ${agentSkillLimits.bytes} bytes`);
    }
    skills.add(skill);
  }
  return { ok: true, skills: [...skills].sort() };
}

export function isWorkspaceWithinRoot(workspace: string, root: string) {
  const paths = /^[A-Za-z]:[\\/]|^\\\\/.test(workspace) ? win32 : posix;
  if (!paths.isAbsolute(workspace) || !paths.isAbsolute(root)) return false;
  const relative = paths.relative(paths.normalize(root), paths.normalize(workspace));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative));
}

function validateConfiguration(body: unknown, nodes: readonly ComputeNode[], connectedNodeIds: ConnectedNodeLookup, existing?: Agent):
  { ok: true; configuration: EditableAgentConfiguration; node: ComputeNode } | ConfigurationFailure {
  if (!isRecord(body)) return invalid("Request body must be an object");
  const unknown = Object.keys(body).find((key) => !editableKeySet.has(key));
  if (unknown) return invalid(`Unknown agent field: ${unknown}`);
  const nonString = Object.keys(body).find((key) => key !== "canDelegate" && key !== "skills" && typeof body[key] !== "string");
  if (nonString) return invalid(`${nonString} must be a string`);
  if (Object.hasOwn(body, "canDelegate") && typeof body.canDelegate !== "boolean") return invalid("canDelegate must be a boolean");
  const skills = Object.hasOwn(body, "skills") ? normalizeSkills(body.skills) : { ok: true as const, skills: existing?.skills ?? [] };
  if (!skills.ok) return skills;

  const values: Record<string, string | undefined> = existing ? {
    name: existing.name,
    title: existing.title,
    summary: existing.summary,
    harnessId: existing.harnessId,
    model: existing.model,
    computeNodeId: existing.computeNodeId,
    workspace: existing.workspace,
    systemPrompt: existing.systemPrompt,
    avatarShape: existing.avatarShape,
    avatarColor: existing.avatarColor
  } : {
    summary: "",
    avatarShape: "cup",
    avatarColor: "amber"
  };
  for (const key of stringEditableKeys) {
    if (Object.hasOwn(body, key)) values[key] = body[key] as string;
  }

  const name = values.name?.trim() ?? "";
  const title = values.title?.trim() ?? "";
  const summary = values.summary?.trim() ?? "";
  const systemPrompt = values.systemPrompt?.trim() ?? "";
  const computeNodeId = values.computeNodeId?.trim() ?? "";
  const harnessId = values.harnessId?.trim() ?? "";
  const model = values.model?.trim() ?? "";
  const workspace = values.workspace?.trim() ?? "";
  if (!name) return invalid("Name is required");
  if (!title) return invalid("Title is required");
  if (!systemPrompt) return invalid("System prompt is required");

  const node = nodes.find((item) => item.id === computeNodeId);
  if (!node) return invalid("Select a compute node that is still available");
  if (node.status === "offline" || !connectedNodeIds.has(node.id)) return invalid("Select a compute node that is online and not stale");
  if (!(harnessIds as readonly string[]).includes(harnessId)) return invalid("Select a recognized harness identity");
  const harness = node.harnesses.find((item) => item.id === harnessId && item.available);
  if (!harness) return invalid("Select a harness advertised as available by the compute node");
  if (harness.models.length ? !harness.models.includes(model) : model !== "default") {
    return invalid(harness.models.length
      ? "Select a model advertised by the selected harness"
      : "This harness only permits its provider default model");
  }
  if (!workspace || !node.workspaceRoots.some((root) => isWorkspaceWithinRoot(workspace, root))) {
    return invalid("Workspace must be an absolute path within a root advertised by the compute node");
  }
  if (!agentAvatarShapes.includes(values.avatarShape as AgentAvatarShape)) return invalid("Select a valid avatar shape");
  if (!agentAvatarColors.includes(values.avatarColor as AgentAvatarColor)) return invalid("Select a valid avatar color");

  return {
    ok: true,
    node,
    configuration: {
      name,
      title,
      summary,
      glyph: [...name][0].toUpperCase(),
      harnessId: harness.id as HarnessId,
      model,
      computeNodeId: node.id,
      workspace,
      systemPrompt,
      avatarShape: values.avatarShape as AgentAvatarShape,
      avatarColor: values.avatarColor as AgentAvatarColor,
      canDelegate: Object.hasOwn(body, "canDelegate") ? body.canDelegate as boolean : existing?.canDelegate ?? false,
      skills: skills.skills
    }
  };
}

function configurationChanged(agent: Agent, configuration: EditableAgentConfiguration) {
  return Object.entries(configuration).some(([key, value]) => key === "skills"
    ? JSON.stringify(agent.skills ?? []) !== JSON.stringify(value)
    : agent[key as keyof Agent] !== value);
}

export function createConfiguredAgent(
  state: AgentConfigurationState,
  body: unknown,
  now: string,
  connectedNodeIds: ConnectedNodeLookup,
  createId: (name: string) => string
): CreateResult {
  const validated = validateConfiguration(body, state.nodes, connectedNodeIds);
  if (!validated.ok) return validated;
  const agent: Agent = {
    id: createId(validated.configuration.name),
    ...validated.configuration,
    state: "idle",
    currentAction: "Available",
    unread: 0,
    updatedAt: now
  };
  state.agents.push(agent);
  return { ok: true, agent, node: validated.node };
}

export function updateConfiguredAgent(
  state: AgentConfigurationState,
  id: string,
  body: unknown,
  now: string,
  connectedNodeIds: ConnectedNodeLookup
): UpdateResult {
  const agent = state.agents.find((item) => item.id === id);
  if (!agent) return { ok: false, kind: "not-found", error: "Agent not found" };
  const validated = validateConfiguration(body, state.nodes, connectedNodeIds, agent);
  if (!validated.ok) return validated;
  if (!configurationChanged(agent, validated.configuration)) {
    return { ok: true, agent, node: validated.node, changed: false };
  }
  Object.assign(agent, validated.configuration, { updatedAt: now });
  return { ok: true, agent, node: validated.node, changed: true };
}

export function markDisconnectedNodesOffline(state: Pick<AgentConfigurationState, "nodes">, connectedNodeIds: ConnectedNodeLookup) {
  let changed = false;
  for (const node of state.nodes) {
    if (connectedNodeIds.has(node.id)) continue;
    if (node.status !== "offline" || node.activeRuns !== 0) changed = true;
    node.status = "offline";
    node.activeRuns = 0;
  }
  return changed;
}
