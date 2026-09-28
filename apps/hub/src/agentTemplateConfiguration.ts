import { createHash, randomUUID } from "node:crypto";
import {
  agentAvatarColors,
  agentAvatarShapes,
  instanceLimits,
  isTimestamp,
  isTerminalInstanceStatus,
  isTerminalTaskStatus,
  validateAgentTemplate,
  type AgentTemplate,
  type ExecutionPreferences,
  type ExecutionRequirements,
  type InstancePurpose
} from "@coffee-shop/protocol";
import { CoordinationError } from "./coordinationError.js";
import type { State, Store } from "./store.js";

const editableFields = [
  "name", "purpose", "glyph", "avatarShape", "avatarColor", "instructions", "skills", "tags",
  "requirements", "preferences", "delegation"
] as const;
type EditableField = typeof editableFields[number];
type NormalizedInput = Partial<Record<EditableField, unknown>>;

export interface AgentTemplateConfigurationReceipt {
  id: string;
  operatorId: string;
  idempotencyKey: string;
  operation: "create" | "update" | "delete";
  targetId?: string;
  input: NormalizedInput;
  digest: string;
  result: AgentTemplate;
  createdAt: string;
}

export interface AgentTemplateConfigurationResult {
  template: AgentTemplate;
  replayed: boolean;
}

const invalid = (message: string) => new CoordinationError("invalid_arguments", message);
const record = (value: unknown, description: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(`${description} must be an object`);
  return value as Record<string, unknown>;
};
const byteLength = (value: string) => Buffer.byteLength(value, "utf8");
const bounded = (value: unknown, field: string, maximum: number, required = false) => {
  if (typeof value !== "string") throw invalid(`${field} must be a string`);
  const normalized = value.trim();
  if (required && normalized.length === 0) throw invalid(`${field} cannot be empty`);
  if (byteLength(normalized) > maximum) throw invalid(`${field} is too long`);
  return normalized;
};

const setStrings = (value: unknown, field: string, lower = false) => {
  if (!Array.isArray(value)) throw invalid(`${field} must be an array`);
  if (value.length > instanceLimits.requirementEntries) throw invalid(`${field} has too many entries`);
  const items = value.map((item) => bounded(item, field, instanceLimits.nameBytes, true));
  return [...new Set(items.map((item) => lower ? item.toLowerCase() : item))].sort();
};

const rankedStrings = (value: unknown, field: string) => {
  if (!Array.isArray(value)) throw invalid(`${field} must be an array`);
  if (value.length > instanceLimits.requirementEntries) throw invalid(`${field} has too many entries`);
  const result: string[] = [];
  for (const item of value) {
    const normalized = bounded(item, field, instanceLimits.nameBytes, true);
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result;
};

function normalizePurpose(value: unknown): InstancePurpose | null {
  const input = record(value, "purpose");
  const unknown = Object.keys(input).find((key) => !["name", "title", "summary", "instructions"].includes(key));
  if (unknown) throw invalid(`purpose contains unknown field ${unknown}`);
  const output: InstancePurpose = {};
  for (const field of ["name", "title"] as const) {
    if (input[field] !== undefined) {
      const text = bounded(input[field], `purpose.${field}`, instanceLimits.nameBytes);
      if (text) output[field] = text;
    }
  }
  if (input.summary !== undefined) {
    const text = bounded(input.summary, "purpose.summary", instanceLimits.summaryBytes);
    if (text) output.summary = text;
  }
  if (input.instructions !== undefined) {
    const text = bounded(input.instructions, "purpose.instructions", instanceLimits.instructionsBytes);
    if (text) output.instructions = text;
  }
  return Object.keys(output).length ? output : null;
}

function normalizePreferences(value: unknown, field = "preferences"): ExecutionPreferences {
  const input = record(value, field);
  const unknown = Object.keys(input).find((key) => !["nodeIds", "harnessIds", "models", "labels"].includes(key));
  if (unknown) throw invalid(`${field} contains unknown field ${unknown}`);
  const output: ExecutionPreferences = {};
  for (const key of ["nodeIds", "harnessIds", "models", "labels"] as const) {
    if (input[key] !== undefined) output[key] = rankedStrings(input[key], `${field}.${key}`) as never;
  }
  return output;
}

function normalizeRequirements(value: unknown): ExecutionRequirements {
  const input = record(value, "requirements");
  const allowed = [
    "skills", "harnessIds", "models", "transports", "operatingSystems", "architectures", "labels",
    "minimumConcurrency", "minimumMemoryMegabytes", "projectProfileId", "templateId", "workspace", "preferences"
  ];
  const unknown = Object.keys(input).find((key) => !allowed.includes(key));
  if (unknown) throw invalid(`requirements contains unknown field ${unknown}`);
  const output: Record<string, unknown> = {};
  for (const key of ["skills", "harnessIds", "models", "transports", "operatingSystems", "architectures", "labels"] as const) {
    if (input[key] !== undefined) output[key] = setStrings(input[key], `requirements.${key}`, key === "skills");
  }
  for (const key of ["minimumConcurrency", "minimumMemoryMegabytes"] as const) {
    if (input[key] !== undefined) output[key] = input[key];
  }
  for (const key of ["projectProfileId", "templateId"] as const) {
    if (input[key] !== undefined) output[key] = bounded(input[key], `requirements.${key}`, instanceLimits.identifierBytes, true);
  }
  if (input.workspace !== undefined) {
    const workspace = record(input.workspace, "requirements.workspace");
    const workspaceUnknown = Object.keys(workspace).find((key) => !["repository", "path", "writable"].includes(key));
    if (workspaceUnknown) throw invalid(`requirements.workspace contains unknown field ${workspaceUnknown}`);
    output.workspace = {
      ...(workspace.repository === undefined ? {} : { repository: bounded(workspace.repository, "requirements.workspace.repository", instanceLimits.workspaceBytes, true) }),
      ...(workspace.path === undefined ? {} : { path: bounded(workspace.path, "requirements.workspace.path", instanceLimits.workspaceBytes, true) }),
      writable: workspace.writable
    };
  }
  if (input.preferences !== undefined) output.preferences = normalizePreferences(input.preferences, "requirements.preferences");
  return output as ExecutionRequirements;
}

function normalizeInput(value: unknown, operation: "create" | "update"): NormalizedInput {
  const input = record(value, "Template changes");
  const unknown = Object.keys(input).find((key) => !editableFields.includes(key as EditableField));
  if (unknown) throw invalid(`Template changes contain unknown field ${unknown}`);
  if (operation === "update" && Object.keys(input).length === 0) throw invalid("Provide at least one template change");
  if (operation === "create" && input.name === undefined) throw invalid("name is required");
  const output: NormalizedInput = {};
  if (input.name !== undefined) output.name = bounded(input.name, "name", instanceLimits.nameBytes, true);
  if (input.purpose !== undefined) {
    const purpose = normalizePurpose(input.purpose);
    if (purpose !== null || operation === "update") output.purpose = purpose;
  }
  for (const field of ["glyph", "instructions"] as const) {
    if (input[field] !== undefined) {
      const maximum = field === "glyph" ? instanceLimits.nameBytes : instanceLimits.instructionsBytes;
      const text = bounded(input[field], field, maximum);
      if (text || operation === "update") output[field] = text || null;
    }
  }
  if (input.avatarShape !== undefined) {
    if (!agentAvatarShapes.includes(input.avatarShape as never)) throw invalid("avatarShape is invalid");
    output.avatarShape = input.avatarShape;
  }
  if (input.avatarColor !== undefined) {
    if (!agentAvatarColors.includes(input.avatarColor as never)) throw invalid("avatarColor is invalid");
    output.avatarColor = input.avatarColor;
  }
  for (const field of ["skills", "tags"] as const) {
    if (input[field] !== undefined) output[field] = setStrings(input[field], field, true);
  }
  if (input.requirements !== undefined) output.requirements = normalizeRequirements(input.requirements);
  if (input.preferences !== undefined) output.preferences = normalizePreferences(input.preferences);
  if (input.delegation !== undefined) {
    const delegation = record(input.delegation, "delegation");
    if (Object.keys(delegation).length !== 1 || typeof delegation.canDelegate !== "boolean") {
      throw invalid("delegation must contain only canDelegate");
    }
    output.delegation = { canDelegate: delegation.canDelegate };
  }
  return output;
}

function applyInput(template: AgentTemplate, input: NormalizedInput): AgentTemplate {
  const next = structuredClone(template);
  const writable = next as unknown as Record<string, unknown>;
  for (const field of editableFields) {
    if (!Object.hasOwn(input, field)) continue;
    const value = input[field];
    if (value === null) delete writable[field];
    else writable[field] = structuredClone(value);
  }
  const validated = validateAgentTemplate(next);
  if (!validated.ok) throw invalid(`Template is invalid: ${validated.reason}`);
  return validated.value;
}

export const agentTemplateConfigurationDigest = (
  operatorId: string,
  idempotencyKey: string,
  operation: AgentTemplateConfigurationReceipt["operation"],
  targetId: string | undefined,
  input: NormalizedInput
) => createHash("sha256").update(JSON.stringify([
  "agent-template-configuration-v1", operatorId, idempotencyKey, operation, targetId ?? null, input
])).digest("hex");

function identity(operatorId: unknown, idempotencyKey: unknown) {
  const operator = bounded(operatorId, "operatorId", instanceLimits.identifierBytes, true);
  const key = bounded(idempotencyKey, "idempotencyKey", instanceLimits.idempotencyKeyBytes, true);
  return { operator, key };
}

function priorReceipt(state: State, operatorId: string, idempotencyKey: string, digest: string) {
  const prior = (state.agentTemplateConfigurationReceipts ?? []).find(
    (receipt) => receipt.operatorId === operatorId && receipt.idempotencyKey === idempotencyKey
  );
  if (!prior) return undefined;
  if (prior.digest !== digest) throw new CoordinationError("idempotency_conflict", "The idempotency key was already used for a different template operation");
  return structuredClone(prior.result);
}

function addReceipt(
  state: State,
  operatorId: string,
  idempotencyKey: string,
  operation: AgentTemplateConfigurationReceipt["operation"],
  targetId: string | undefined,
  input: NormalizedInput,
  digest: string,
  result: AgentTemplate,
  at: string
) {
  state.agentTemplateConfigurationReceipts ??= [];
  state.agentTemplateConfigurationReceipts.push({
    id: `template_receipt_${randomUUID()}`, operatorId, idempotencyKey, operation,
    ...(targetId === undefined ? {} : { targetId }), input: structuredClone(input), digest,
    result: structuredClone(result), createdAt: at
  });
}

export async function createAgentTemplate(
  store: Store,
  operatorId: string,
  idempotencyKey: string,
  value: unknown,
  at = new Date().toISOString()
): Promise<AgentTemplateConfigurationResult> {
  const caller = identity(operatorId, idempotencyKey);
  const input = normalizeInput(value, "create");
  const digest = agentTemplateConfigurationDigest(caller.operator, caller.key, "create", undefined, input);
  let result: AgentTemplateConfigurationResult | undefined;
  await store.transact((state) => {
    const prior = priorReceipt(state, caller.operator, caller.key, digest);
    if (prior) { result = { template: prior, replayed: true }; return; }
    const template = applyInput({ id: `template_${randomUUID()}`, name: input.name as string }, input);
    state.templates ??= [];
    state.templates.push(template);
    addReceipt(state, caller.operator, caller.key, "create", undefined, input, digest, template, at);
    result = { template: structuredClone(template), replayed: false };
  });
  if (!result) throw new CoordinationError("persistence_failed", "The template was not created", true);
  return result;
}

export async function updateAgentTemplate(
  store: Store,
  operatorId: string,
  idempotencyKey: string,
  templateId: string,
  value: unknown,
  at = new Date().toISOString()
): Promise<AgentTemplateConfigurationResult> {
  const caller = identity(operatorId, idempotencyKey);
  const targetId = bounded(templateId, "templateId", instanceLimits.identifierBytes, true);
  const input = normalizeInput(value, "update");
  const digest = agentTemplateConfigurationDigest(caller.operator, caller.key, "update", targetId, input);
  let result: AgentTemplateConfigurationResult | undefined;
  await store.transact((state) => {
    const prior = priorReceipt(state, caller.operator, caller.key, digest);
    if (prior) { result = { template: prior, replayed: true }; return; }
    const index = (state.templates ?? []).findIndex((template) => template.id === targetId);
    if (index < 0) throw new CoordinationError("not_found", "Template not found");
    const current = state.templates![index];
    const updated = applyInput(current, input);
    updated.id = current.id;
    if (current.legacyAgentId === undefined) delete updated.legacyAgentId;
    else updated.legacyAgentId = current.legacyAgentId;
    state.templates![index] = updated;
    addReceipt(state, caller.operator, caller.key, "update", targetId, input, digest, updated, at);
    result = { template: structuredClone(updated), replayed: false };
  });
  if (!result) throw new CoordinationError("persistence_failed", "The template was not updated", true);
  return result;
}

export async function deleteAgentTemplate(
  store: Store,
  operatorId: string,
  idempotencyKey: string,
  templateId: string,
  at = new Date().toISOString()
): Promise<AgentTemplateConfigurationResult> {
  const caller = identity(operatorId, idempotencyKey);
  const targetId = bounded(templateId, "templateId", instanceLimits.identifierBytes, true);
  const input: NormalizedInput = {};
  const digest = agentTemplateConfigurationDigest(caller.operator, caller.key, "delete", targetId, input);
  let result: AgentTemplateConfigurationResult | undefined;
  await store.transact((state) => {
    const prior = priorReceipt(state, caller.operator, caller.key, digest);
    if (prior) { result = { template: prior, replayed: true }; return; }
    const index = (state.templates ?? []).findIndex((template) => template.id === targetId);
    if (index < 0) throw new CoordinationError("not_found", "Template not found");
    const liveTask = (state.tasks ?? []).some((task) => !isTerminalTaskStatus(task.status) && task.requirements.templateId === targetId);
    const liveInstance = (state.instances ?? []).some((instance) => !isTerminalInstanceStatus(instance.status) && instance.requirements.templateId === targetId);
    if (liveTask || liveInstance) throw new CoordinationError("conflict", "Template is referenced by active work");
    const [removed] = state.templates!.splice(index, 1);
    addReceipt(state, caller.operator, caller.key, "delete", targetId, input, digest, removed, at);
    result = { template: structuredClone(removed), replayed: false };
  });
  if (!result) throw new CoordinationError("persistence_failed", "The template was not deleted", true);
  return result;
}

/** Rejects private receipts that could not have been produced by this service. */
export function assertPersistedAgentTemplateConfigurationState(state: State) {
  if (!Array.isArray(state.agentTemplateConfigurationReceipts)) throw new Error("Persisted template receipts are not an array");
  const identities = new Set<string>();
  for (const [index, raw] of state.agentTemplateConfigurationReceipts.entries()) {
    const context = `Persisted template receipt ${index}`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${context} is not an object`);
    const receipt = raw as AgentTemplateConfigurationReceipt;
    const keys = Object.keys(receipt);
    const allowed = ["id", "operatorId", "idempotencyKey", "operation", "targetId", "input", "digest", "result", "createdAt"];
    if (keys.some((key) => !allowed.includes(key)) || allowed.filter((key) => key !== "targetId").some((key) => !keys.includes(key))) {
      throw new Error(`${context} has an invalid shape`);
    }
    if (typeof receipt.id !== "string" || byteLength(receipt.id) > instanceLimits.identifierBytes
      || typeof receipt.operatorId !== "string" || receipt.operatorId.length === 0 || byteLength(receipt.operatorId) > instanceLimits.identifierBytes
      || typeof receipt.idempotencyKey !== "string" || receipt.idempotencyKey.length === 0 || byteLength(receipt.idempotencyKey) > instanceLimits.idempotencyKeyBytes
      || !["create", "update", "delete"].includes(receipt.operation) || typeof receipt.digest !== "string"
      || !/^[a-f0-9]{64}$/.test(receipt.digest) || !isTimestamp(receipt.createdAt)) throw new Error(`${context} has invalid identity fields`);
    if ((receipt.operation === "create") !== (receipt.targetId === undefined)) throw new Error(`${context} has an invalid target`);
    if (receipt.targetId !== undefined && (typeof receipt.targetId !== "string" || receipt.result.id !== receipt.targetId)) throw new Error(`${context} target does not match its result`);
    if (typeof receipt.input !== "object" || receipt.input === null || Array.isArray(receipt.input)) throw new Error(`${context} has invalid input`);
    try {
      if (receipt.operation === "delete") {
        if (Object.keys(receipt.input).length !== 0) throw new Error("delete input is not empty");
      } else {
        const rawInput: Record<string, unknown> = { ...receipt.input };
        for (const field of ["purpose", "glyph", "instructions"] as const) {
          if (rawInput[field] === null) rawInput[field] = field === "purpose" ? {} : "";
        }
        const normalized = normalizeInput(rawInput, receipt.operation);
        if (JSON.stringify(normalized) !== JSON.stringify(receipt.input)) throw new Error("input is not canonical");
      }
    } catch {
      throw new Error(`${context} has invalid normalized input`);
    }
    const validated = validateAgentTemplate(receipt.result);
    if (!validated.ok) throw new Error(`${context} has an invalid result: ${validated.reason}`);
    const identityKey = JSON.stringify([receipt.operatorId, receipt.idempotencyKey]);
    if (identities.has(identityKey)) throw new Error(`${context} repeats an operator key`);
    identities.add(identityKey);
    const digest = agentTemplateConfigurationDigest(receipt.operatorId, receipt.idempotencyKey, receipt.operation, receipt.targetId, receipt.input);
    if (digest !== receipt.digest) throw new Error(`${context} has an invalid digest`);
  }
}
