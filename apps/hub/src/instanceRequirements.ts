import type { AgentTemplate, ExecutionRequirements } from "@coffee-shop/protocol";

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** Canonical skill identity used by storage, template admission, readiness, and allocation proof. */
export const normalizeSkillIdentifiers = (skills: readonly string[] | undefined): string[] =>
  [...new Set((skills ?? []).map((skill) => skill.trim().toLowerCase()).filter(Boolean))].sort(compareText);

export function normalizeInstanceRequirements(requirements: ExecutionRequirements): ExecutionRequirements {
  const normalized: ExecutionRequirements = structuredClone(requirements);
  const skills = normalizeSkillIdentifiers(requirements.skills);
  if (skills.length === 0) delete normalized.skills;
  else normalized.skills = skills;
  return normalized;
}

const intersect = (left: readonly string[] | undefined, right: readonly string[] | undefined): string[] | undefined => {
  if (left === undefined) return right === undefined ? undefined : [...right];
  if (right === undefined) return [...left];
  return left.filter((value) => right.includes(value));
};

const union = (left: readonly string[] | undefined, right: readonly string[] | undefined): string[] | undefined => {
  if (left === undefined && right === undefined) return undefined;
  return [...new Set([...(left ?? []), ...(right ?? [])])];
};

/**
 * Snapshots the hard requirements of a template into an instance request. Descriptive top-level
 * template skills are intentionally absent: only `template.requirements.skills` is authority.
 */
export function requirementsThroughTemplate(requirements: ExecutionRequirements, template: AgentTemplate | undefined): ExecutionRequirements {
  const normalizedRequirements = normalizeInstanceRequirements(requirements);
  if (!template) return normalizedRequirements;
  const extra = template.requirements ?? {};
  const merged: ExecutionRequirements = { ...normalizedRequirements };
  const narrow = <K extends "harnessIds" | "models" | "transports" | "operatingSystems" | "architectures">(key: K) => {
    const value = intersect(normalizedRequirements[key], extra[key]);
    if (value === undefined) delete merged[key];
    else merged[key] = value as ExecutionRequirements[K];
  };
  narrow("harnessIds");
  narrow("models");
  narrow("transports");
  narrow("operatingSystems");
  narrow("architectures");
  const labels = union(normalizedRequirements.labels, extra.labels);
  if (labels === undefined) delete merged.labels;
  else merged.labels = labels;
  const skills = normalizeSkillIdentifiers(union(normalizedRequirements.skills, extra.skills));
  if (skills.length === 0) delete merged.skills;
  else merged.skills = skills;
  for (const key of ["minimumConcurrency", "minimumMemoryMegabytes"] as const) {
    const values = [normalizedRequirements[key], extra[key]].filter((value): value is number => value !== undefined);
    if (values.length) merged[key] = Math.max(...values);
  }
  if (merged.projectProfileId === undefined && extra.projectProfileId !== undefined) merged.projectProfileId = extra.projectProfileId;
  if (merged.workspace === undefined && extra.workspace !== undefined) merged.workspace = { ...extra.workspace };
  const preferences = { ...(template.preferences ?? {}), ...(extra.preferences ?? {}), ...(normalizedRequirements.preferences ?? {}) };
  if (Object.keys(preferences).length) merged.preferences = preferences;
  merged.templateId = template.id;
  return merged;
}

export function effectiveInstanceRequirements(requirements: ExecutionRequirements, templates: readonly AgentTemplate[]): ExecutionRequirements {
  const template = requirements.templateId === undefined ? undefined : templates.find((item) => item.id === requirements.templateId);
  return requirementsThroughTemplate(requirements, template);
}
