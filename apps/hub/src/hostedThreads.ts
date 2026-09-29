import { createHash, randomUUID } from "node:crypto";
import {
  defaultInstanceIdleTimeoutSeconds,
  instanceLimits,
  maximumInstanceIdleTimeoutSeconds,
  minimumInstanceIdleTimeoutSeconds,
  validateInstanceRequirements,
  type CreateHostedThreadRequest,
  type CreateHostedThreadResult,
  type ExecutionRequirements,
  type InstancePurpose,
  type Task,
  type Thread
} from "@coffee-shop/protocol";
import { CoordinationError } from "./coordinationError.js";
import { postOperatorMessageInState } from "./externalOrchestrators.js";
import { operatorInstanceCreator, placeInstanceInState } from "./instances.js";
import { placementEnvironmentFor } from "./legacyPromotion.js";
import { placeTask, type SchedulingContext } from "./scheduler.js";
import { newEvent, newId, type HostedThreadCreationReceipt, type State, type Store } from "./store.js";
import { threadObjectiveLimit, threadTitleLimit } from "./threads.js";

const defaultOrchestratorInstructions = [
  "You are the orchestrator for this Coffee Shop thread.",
  "Break the objective into bounded tasks, create or reuse compatible worker instances, monitor their progress, and answer their questions.",
  "Synthesize the workers' results and mark the thread complete only when the objective is satisfied."
].join(" ");

const invalid = (message: string) => new CoordinationError("invalid_arguments", message);
const record = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
};
const byteLength = (value: string) => Buffer.byteLength(value, "utf8");

function boundedString(value: unknown, field: string, maximum: number) {
  if (typeof value !== "string") throw invalid(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw invalid(`${field} cannot be empty`);
  if (normalized.length > maximum) throw invalid(`${field} must be at most ${maximum} characters`);
  return normalized;
}

function normalizePurpose(value: unknown): InstancePurpose | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "orchestrator.purpose");
  const unknown = Object.keys(input).find((key) => !["name", "title", "summary", "instructions"].includes(key));
  if (unknown) throw invalid(`orchestrator.purpose contains unknown field ${unknown}`);
  const purpose: InstancePurpose = {};
  for (const key of ["name", "title", "summary", "instructions"] as const) {
    const raw = input[key];
    if (raw === undefined) continue;
    if (typeof raw !== "string") throw invalid(`orchestrator.purpose.${key} must be a string`);
    const text = raw.trim();
    const maximum = key === "summary" ? instanceLimits.summaryBytes
      : key === "instructions" ? instanceLimits.instructionsBytes : instanceLimits.nameBytes;
    if (byteLength(text) > maximum) throw invalid(`orchestrator.purpose.${key} is too long`);
    if (text) purpose[key] = text;
  }
  return Object.keys(purpose).length ? purpose : undefined;
}

function normalizeRequest(value: unknown): CreateHostedThreadRequest {
  const input = record(value, "Hosted thread request");
  const unknown = Object.keys(input).find((key) => !["idempotencyKey", "title", "objective", "orchestrator"].includes(key));
  if (unknown) throw invalid(`Hosted thread request contains unknown field ${unknown}`);
  const idempotencyKey = boundedString(input.idempotencyKey, "idempotencyKey", instanceLimits.idempotencyKeyBytes);
  if (byteLength(idempotencyKey) > instanceLimits.idempotencyKeyBytes) throw invalid("idempotencyKey is too long");
  const title = boundedString(input.title, "title", threadTitleLimit);
  const objective = boundedString(input.objective, "objective", threadObjectiveLimit);
  const orchestrator = record(input.orchestrator, "orchestrator");
  const orchestratorUnknown = Object.keys(orchestrator).find((key) => !["purpose", "requirements", "idleTimeoutSeconds"].includes(key));
  if (orchestratorUnknown) throw invalid(`orchestrator contains unknown field ${orchestratorUnknown}`);
  const requirements = validateInstanceRequirements(orchestrator.requirements);
  if (!requirements.ok) throw invalid(`orchestrator requirements are invalid: ${requirements.reason}`);
  const purpose = normalizePurpose(orchestrator.purpose);
  const idleTimeoutSeconds = orchestrator.idleTimeoutSeconds;
  if (idleTimeoutSeconds !== undefined && (typeof idleTimeoutSeconds !== "number" || !Number.isInteger(idleTimeoutSeconds)
    || idleTimeoutSeconds < minimumInstanceIdleTimeoutSeconds || idleTimeoutSeconds > maximumInstanceIdleTimeoutSeconds)) {
    throw invalid(`orchestrator.idleTimeoutSeconds must be from ${minimumInstanceIdleTimeoutSeconds} to ${maximumInstanceIdleTimeoutSeconds}`);
  }
  return {
    idempotencyKey,
    title,
    objective,
    orchestrator: {
      requirements: requirements.value,
      ...(purpose ? { purpose } : {}),
      ...(idleTimeoutSeconds === undefined ? {} : { idleTimeoutSeconds: idleTimeoutSeconds as number })
    }
  };
}

const requestDigest = (operatorId: string, request: CreateHostedThreadRequest) => createHash("sha256")
  .update(JSON.stringify(["hosted-thread-v1", operatorId, request])).digest("hex");

function probe(threadId: string, requirements: ExecutionRequirements, at: string): Task {
  return {
    id: `hosted-thread-probe:${threadId}`,
    threadId,
    title: "Place hosted orchestrator",
    instructions: "",
    status: "ready",
    requirements,
    dependencies: [],
    idempotencyKey: "",
    attemptRunIds: [],
    createdAt: at,
    updatedAt: at
  };
}

function replayResult(state: Readonly<State>, receipt: HostedThreadCreationReceipt): CreateHostedThreadResult {
  const thread = (state.threads ?? []).find((item) => item.id === receipt.threadId);
  const instance = (state.instances ?? []).find((item) => item.id === receipt.instanceId);
  const allocation = (state.allocations ?? []).find((item) => item.id === receipt.allocationId);
  if (!thread || !instance || !allocation || thread.orchestrator?.kind !== "instance" || thread.orchestrator.instanceId !== instance.id) {
    throw new CoordinationError("persistence_failed", "The hosted thread receipt no longer resolves to its original records", true);
  }
  return {
    thread: structuredClone(thread) as CreateHostedThreadResult["thread"],
    instance: structuredClone(instance),
    allocation: structuredClone(allocation),
    replayed: true
  };
}

function orchestratorPurpose(state: Readonly<State>, request: CreateHostedThreadRequest): InstancePurpose {
  const templateId = request.orchestrator.requirements.templateId;
  const template = templateId === undefined ? undefined : (state.templates ?? []).find((item) => item.id === templateId);
  if (templateId !== undefined && !template) throw invalid("The selected orchestrator template does not exist");
  if (template && template.delegation?.canDelegate !== true) {
    throw invalid("The selected template is worker-only; an orchestrator template must be allowed to delegate");
  }
  const requested = request.orchestrator.purpose;
  return {
    name: requested?.name ?? template?.purpose?.name ?? template?.name ?? "Orchestrator",
    title: requested?.title ?? template?.purpose?.title ?? "Thread orchestrator",
    summary: requested?.summary ?? template?.purpose?.summary ?? "Plans work, coordinates worker instances, and synthesizes their results.",
    instructions: requested?.instructions ?? template?.purpose?.instructions ?? template?.instructions ?? defaultOrchestratorInstructions
  };
}

export async function createHostedThread(
  store: Store,
  operatorId: string,
  value: unknown,
  context: SchedulingContext,
  at = new Date().toISOString()
): Promise<CreateHostedThreadResult> {
  const request = normalizeRequest(value);
  const digest = requestDigest(operatorId, request);
  let result: CreateHostedThreadResult | undefined;
  await store.transact((state) => {
    const prior = (state.hostedThreadCreationReceipts ?? []).find(
      (receipt) => receipt.operatorId === operatorId && receipt.idempotencyKey === request.idempotencyKey
    );
    if (prior) {
      if (prior.digest !== digest) throw new CoordinationError("idempotency_conflict", "The idempotency key was already used for a different hosted thread");
      result = replayResult(state, prior);
      return false;
    }

    const thread: Thread = {
      id: newId("thread"),
      title: request.title,
      objective: request.objective,
      summary: "",
      status: "active",
      createdBy: "user",
      createdAt: at,
      updatedAt: at
    };
    state.threads ??= [];
    state.threads.unshift(thread);

    const purpose = orchestratorPurpose(state, request);
    const decision = placeTask(probe(thread.id, request.orchestrator.requirements, at), placementEnvironmentFor(state, context, at));
    if (decision.kind !== "offering") {
      const reasons = decision.diagnostic.unsatisfied.slice(0, 3)
        .map((item) => `${item.kind} ${item.requirement}: ${item.detail}`)
        .join("; ");
      throw new CoordinationError("unavailable", `No live compute offering can host the requested orchestrator${reasons ? `: ${reasons}` : ""}`);
    }
    const placed = placeInstanceInState(state, {
      threadId: thread.id,
      purpose,
      requirements: request.orchestrator.requirements,
      creator: operatorInstanceCreator,
      delegation: { canDelegate: true },
      idleTimeoutSeconds: request.orchestrator.idleTimeoutSeconds ?? defaultInstanceIdleTimeoutSeconds
    }, decision.offering, at);
    if (placed.kind !== "placed") {
      throw new CoordinationError("unavailable", `The orchestrator could not be placed: ${placed.reason}`);
    }

    thread.orchestrator = { kind: "instance", instanceId: placed.instance.id };
    postOperatorMessageInState(state, {
      threadId: thread.id,
      body: request.objective,
      idempotencyKey: `hosted-${digest.slice(0, 24)}`
    }, at);
    state.events.unshift(newEvent({
      type: "status",
      title: "Hosted thread started",
      detail: `${thread.title} · ${placed.instance.purpose?.name ?? placed.instance.id}`,
      threadId: thread.id,
      instanceId: placed.instance.id,
      allocationId: placed.allocation.id
    }));
    state.hostedThreadCreationReceipts ??= [];
    state.hostedThreadCreationReceipts.push({
      id: `hosted_thread_receipt_${randomUUID()}`,
      operatorId,
      idempotencyKey: request.idempotencyKey,
      digest,
      threadId: thread.id,
      instanceId: placed.instance.id,
      allocationId: placed.allocation.id,
      createdAt: at
    });
    result = {
      thread: structuredClone(thread) as CreateHostedThreadResult["thread"],
      instance: structuredClone(placed.instance),
      allocation: structuredClone(placed.allocation),
      replayed: false
    };
  });
  if (!result) throw new CoordinationError("persistence_failed", "The hosted thread was not created", true);
  return result;
}
