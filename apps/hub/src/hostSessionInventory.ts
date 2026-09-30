import { createHash } from "node:crypto";
import {
  hostHarnessSessionLimits,
  validateHostHarnessSessionInventoryGeneration,
  validateHostHarnessSessionObservation,
  validateHostHarnessSessionObservationTransition,
  validateHostSessionControlMessage,
  type HostHarnessSession,
  type HostHarnessSessionInventoryGeneration,
  type HostHarnessSessionInventoryComplete,
  type HostHarnessSessionInventoryPage,
  type HostHarnessSessionObservation,
  type HostSessionControlMessage
} from "@coffee-shop/protocol";
import { isWorkspaceWithinRoot } from "./agentConfiguration.js";
import type { State, Store } from "./store.js";

type InventoryMessage = HostHarnessSessionInventoryPage | HostHarnessSessionInventoryComplete
  | Extract<HostSessionControlMessage, { type: "host-session.update" }>;

export interface HostSessionInventoryConnection {
  nodeId: string;
  connectionGeneration: number;
  supportsCapability: boolean;
  barrierPassed: boolean;
  isCurrent: () => boolean;
}

export type HostSessionInventoryOutcome =
  | { kind: "accepted"; changed: true }
  | { kind: "staged" | "replayed" | "older" | "ignored"; changed: false }
  | { kind: "rejected"; changed: false; reason?: string };

interface StagedGeneration {
  generation: number;
  pages: Map<number, HostHarnessSessionInventoryPage>;
  pageDigests: Map<number, string>;
}

const staging = new WeakMap<Store, Map<string, StagedGeneration>>();
const reconciled = new WeakMap<Store, Map<string, number>>();
const terminalOrOffline = new Set(["offline", "closed", "failed"]);

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]));
};

const semanticDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
const observationDigest = (observation: HostHarnessSessionObservation) => semanticDigest(observation);
const pageDigest = (page: HostHarnessSessionInventoryPage) => semanticDigest({
  nodeId: page.nodeId, generation: page.generation, pageIndex: page.pageIndex,
  sessions: [...page.sessions].sort((left, right) => left.hostHarnessSessionId.localeCompare(right.hostHarnessSessionId))
});
const generationDigest = (generation: HostHarnessSessionInventoryGeneration) => semanticDigest({
  nodeId: generation.nodeId,
  generation: generation.generation,
  pageCount: generation.complete.pageCount,
  sessionCount: generation.complete.sessionCount,
  pages: generation.pages.map((page) => ({
    pageIndex: page.pageIndex,
    sessions: [...page.sessions].sort((left, right) => left.hostHarnessSessionId.localeCompare(right.hostHarnessSessionId))
  }))
});
const providerKey = (session: Pick<HostHarnessSessionObservation, "nodeId" | "harnessId" | "workspace" | "providerSessionId">) =>
  [session.nodeId, session.harnessId, session.workspace, session.providerSessionId].join("\u0000");
const connectionKey = (connection: HostSessionInventoryConnection) => `${connection.nodeId}\u0000${connection.connectionGeneration}`;

function stagesFor(store: Store) {
  let stages = staging.get(store);
  if (!stages) {
    stages = new Map();
    staging.set(store, stages);
  }
  return stages;
}

function reconciledFor(store: Store) {
  let generations = reconciled.get(store);
  if (!generations) {
    generations = new Map();
    reconciled.set(store, generations);
  }
  return generations;
}

export function discardHostSessionConnection(store: Store, connection: HostSessionInventoryConnection) {
  const key = connectionKey(connection);
  staging.get(store)?.delete(key);
  reconciled.get(store)?.delete(key);
}

export function hasReconciledHostSessionInventory(store: Store, connection: HostSessionInventoryConnection) {
  return reconciled.get(store)?.get(connectionKey(connection)) !== undefined;
}

export function findHostHarnessSession(state: Readonly<State>, hostHarnessSessionId: string) {
  return state.hostHarnessSessions?.find((session) => session.hostHarnessSessionId === hostHarnessSessionId);
}

export type HostSessionObservationOutcome =
  | { kind: "accepted"; changed: true; session: HostHarnessSession }
  | { kind: "replayed"; changed: false; session: HostHarnessSession }
  | { kind: "rejected"; changed: false; reason: string };

/** Shared committed lookup/transition seam for #160; callers must already hold Store.transact. */
export function applyCommittedHostSessionObservation(
  state: State,
  candidate: unknown,
  options: { allowCreate?: boolean } = {}
): HostSessionObservationOutcome {
  const validated = validateHostHarnessSessionObservation(candidate);
  if (!validated.ok) return { kind: "rejected", changed: false, reason: validated.reason };
  const observation = validated.value;
  const node = state.nodes.find((item) => item.id === observation.nodeId);
  if (!node) {
    return { kind: "rejected", changed: false, reason: "host session names an unknown node" };
  }
  if (!node.workspaceRoots.some((root) => isWorkspaceWithinRoot(observation.workspace, root))) {
    return { kind: "rejected", changed: false, reason: "host session workspace is not authorized" };
  }
  const sessions = state.hostHarnessSessions ??= [];
  const observations = state.hostSessionLastObservations ??= [];
  const currentIndex = sessions.findIndex((session) => session.hostHarnessSessionId === observation.hostHarnessSessionId);
  if (currentIndex < 0) {
    if (!options.allowCreate) return { kind: "rejected", changed: false, reason: "host session is unknown" };
    if (sessions.some((session) => providerKey(session) === providerKey(observation))) {
      return { kind: "rejected", changed: false, reason: "provider identity belongs to another host session" };
    }
    const session: HostHarnessSession = { ...observation, operations: [...observation.operations], attachmentEpoch: 0 };
    sessions.push(session);
    sessions.sort((left, right) => left.hostHarnessSessionId.localeCompare(right.hostHarnessSessionId));
    observations.push(structuredClone(observation));
    observations.sort((left, right) => left.hostHarnessSessionId.localeCompare(right.hostHarnessSessionId));
    return { kind: "accepted", changed: true, session };
  }
  const current = sessions[currentIndex]!;
  const prior = observations.find((item) => item.hostHarnessSessionId === observation.hostHarnessSessionId);
  if (!prior) return { kind: "rejected", changed: false, reason: "host session has no prior observation" };
  if (observation.revision < prior.revision) return { kind: "rejected", changed: false, reason: "host session revision is stale" };
  if (observation.revision === prior.revision) {
    return observationDigest(observation) === observationDigest(prior)
      ? { kind: "replayed", changed: false, session: current }
      : { kind: "rejected", changed: false, reason: "host session revision replay changed payload" };
  }
  if (observation.revision !== prior.revision + 1) {
    return { kind: "rejected", changed: false, reason: "host session revision has a gap" };
  }
  const transition = validateHostHarnessSessionObservationTransition(prior, observation);
  if (!transition.ok) return { kind: "rejected", changed: false, reason: transition.reason };
  const next: HostHarnessSession = {
    ...observation,
    operations: [...observation.operations],
    ...(current.attachedThreadId === undefined ? {} : { attachedThreadId: current.attachedThreadId }),
    ...(current.activeRunId === undefined ? {} : { activeRunId: current.activeRunId }),
    attachmentEpoch: current.attachmentEpoch
  };
  sessions[currentIndex] = next;
  observations[observations.indexOf(prior)] = structuredClone(observation);
  return { kind: "accepted", changed: true, session: next };
}

function stagePage(store: Store, connection: HostSessionInventoryConnection, page: HostHarnessSessionInventoryPage): HostSessionInventoryOutcome {
  const currentGeneration = store.read((state) => state.hostSessionInventoryGenerations
    ?.find((record) => record.nodeId === connection.nodeId)?.generation);
  if (currentGeneration !== undefined && page.generation < currentGeneration) return { kind: "older", changed: false };
  if (currentGeneration !== undefined && page.generation > currentGeneration + 1) {
    return { kind: "rejected", changed: false, reason: "host session inventory generation has a gap" };
  }
  const key = connectionKey(connection);
  const stages = stagesFor(store);
  let stage = stages.get(key);
  if (!stage || stage.generation !== page.generation) {
    if (page.pageIndex !== 0) return { kind: "rejected", changed: false, reason: "host session inventory must start at page zero" };
    stage = { generation: page.generation, pages: new Map(), pageDigests: new Map() };
    stages.set(key, stage);
  }
  const digest = pageDigest(page);
  const priorDigest = stage.pageDigests.get(page.pageIndex);
  if (priorDigest !== undefined) {
    if (priorDigest === digest) return { kind: "staged", changed: false };
    stages.delete(key);
    return { kind: "rejected", changed: false, reason: "host session inventory page replay changed payload" };
  }
  if (page.pageIndex !== stage.pages.size) {
    stages.delete(key);
    return { kind: "rejected", changed: false, reason: "host session inventory pages are out of order" };
  }
  stage.pages.set(page.pageIndex, structuredClone(page));
  stage.pageDigests.set(page.pageIndex, digest);
  return { kind: "staged", changed: false };
}

function applyCompletedGeneration(
  state: State,
  generation: HostHarnessSessionInventoryGeneration,
  digest: string
): HostSessionInventoryOutcome {
  const node = state.nodes.find((item) => item.id === generation.nodeId);
  if (!node) {
    return { kind: "rejected", changed: false, reason: "host session inventory names an unknown node" };
  }
  const records = state.hostSessionInventoryGenerations ??= [];
  const recordIndex = records.findIndex((record) => record.nodeId === generation.nodeId);
  const currentRecord = recordIndex < 0 ? undefined : records[recordIndex];
  if (currentRecord) {
    if (generation.generation < currentRecord.generation) return { kind: "older", changed: false };
    if (generation.generation === currentRecord.generation) {
      return currentRecord.digest === digest
        ? { kind: "replayed", changed: false }
        : { kind: "rejected", changed: false, reason: "host session inventory generation replay changed payload" };
    }
    if (generation.generation !== currentRecord.generation + 1) {
      return { kind: "rejected", changed: false, reason: "host session inventory generation has a gap" };
    }
  }
  const sessions = state.hostHarnessSessions ??= [];
  const observations = state.hostSessionLastObservations ??= [];
  const currentById = new Map(sessions.map((session) => [session.hostHarnessSessionId, session]));
  const priorById = new Map(observations.map((observation) => [observation.hostHarnessSessionId, observation]));
  const currentProviderIds = new Map(sessions.map((session) => [providerKey(session), session.hostHarnessSessionId]));
  for (const observation of generation.sessions) {
    if (!node.workspaceRoots.some((root) => isWorkspaceWithinRoot(observation.workspace, root))) {
      return { kind: "rejected", changed: false, reason: "host session inventory workspace is not authorized" };
    }
    const current = currentById.get(observation.hostHarnessSessionId);
    if (current && current.nodeId !== generation.nodeId) {
      return { kind: "rejected", changed: false, reason: "host session identity belongs to another node" };
    }
    const providerOwner = currentProviderIds.get(providerKey(observation));
    if (providerOwner !== undefined && providerOwner !== observation.hostHarnessSessionId) {
      return { kind: "rejected", changed: false, reason: "provider identity belongs to another host session" };
    }
    const prior = priorById.get(observation.hostHarnessSessionId);
    if (prior && !validateHostHarnessSessionObservationTransition(prior, observation).ok) {
      return { kind: "rejected", changed: false, reason: "host session inventory contains an invalid observation transition" };
    }
  }

  const reportedIds = new Set(generation.sessions.map((session) => session.hostHarnessSessionId));
  const outside = sessions.filter((session) => session.nodeId !== generation.nodeId);
  const retained = sessions.filter((session) => session.nodeId === generation.nodeId && !reportedIds.has(session.hostHarnessSessionId))
    .map((session): HostHarnessSession => terminalOrOffline.has(session.status) ? session : {
      ...session,
      status: "offline",
      updatedAt: Date.parse(generation.complete.at) > Date.parse(session.updatedAt) ? generation.complete.at : session.updatedAt
    });
  const reported = generation.sessions.map((observation): HostHarnessSession => {
    const current = currentById.get(observation.hostHarnessSessionId);
    return {
      ...observation,
      operations: [...observation.operations],
      ...(current?.attachedThreadId === undefined ? {} : { attachedThreadId: current.attachedThreadId }),
      ...(current?.activeRunId === undefined ? {} : { activeRunId: current.activeRunId }),
      attachmentEpoch: current?.attachmentEpoch ?? 0
    };
  });
  let nodeSessions = [...reported, ...retained];
  if (nodeSessions.length > hostHarnessSessionLimits.sessionsPerGeneration) {
    const removable = retained.filter((session) => session.attachedThreadId === undefined
      && session.activeRunId === undefined && terminalOrOffline.has(session.status))
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)
        || left.hostHarnessSessionId.localeCompare(right.hostHarnessSessionId));
    const remove = new Set(removable.slice(0, nodeSessions.length - hostHarnessSessionLimits.sessionsPerGeneration)
      .map((session) => session.hostHarnessSessionId));
    nodeSessions = nodeSessions.filter((session) => !remove.has(session.hostHarnessSessionId));
  }
  if (nodeSessions.length > hostHarnessSessionLimits.sessionsPerGeneration) {
    return { kind: "rejected", changed: false, reason: "host session inventory exceeds protected retention capacity" };
  }
  const retainedIds = new Set([...outside, ...nodeSessions].map((session) => session.hostHarnessSessionId));
  state.hostHarnessSessions = [...outside, ...nodeSessions]
    .sort((left, right) => left.hostHarnessSessionId.localeCompare(right.hostHarnessSessionId));
  const reportedById = new Map(generation.sessions.map((observation) => [observation.hostHarnessSessionId, observation]));
  state.hostSessionLastObservations = [
    ...observations.filter((observation) => observation.nodeId !== generation.nodeId && retainedIds.has(observation.hostHarnessSessionId)),
    ...nodeSessions.map((session) => reportedById.get(session.hostHarnessSessionId) ?? priorById.get(session.hostHarnessSessionId)!)
  ].sort((left, right) => left.hostHarnessSessionId.localeCompare(right.hostHarnessSessionId));
  state.hostSessionHistories = (state.hostSessionHistories ?? []).filter((history) => retainedIds.has(history.hostHarnessSessionId));
  const record = { nodeId: generation.nodeId, generation: generation.generation, digest, completedAt: generation.complete.at };
  if (recordIndex < 0) records.push(record); else records[recordIndex] = record;
  records.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  return { kind: "accepted", changed: true };
}

async function completeGeneration(
  store: Store,
  connection: HostSessionInventoryConnection,
  complete: HostHarnessSessionInventoryComplete
): Promise<HostSessionInventoryOutcome> {
  const key = connectionKey(connection);
  const stages = stagesFor(store);
  let stage = stages.get(key);
  if (!stage && complete.pageCount === 0) {
    stage = { generation: complete.generation, pages: new Map(), pageDigests: new Map() };
  }
  if (!stage || stage.generation !== complete.generation) {
    return { kind: "rejected", changed: false, reason: "host session inventory completion has no matching staged generation" };
  }
  const assembled = validateHostHarnessSessionInventoryGeneration([...stage.pages.values()], complete);
  if (!assembled.ok) {
    stages.delete(key);
    return { kind: "rejected", changed: false, reason: assembled.reason };
  }
  const digest = generationDigest(assembled.value);
  let outcome!: HostSessionInventoryOutcome;
  await store.transact((state) => {
    if (!connection.isCurrent() || !connection.barrierPassed) {
      outcome = { kind: "ignored", changed: false };
      return false;
    }
    outcome = applyCompletedGeneration(state, assembled.value, digest);
    return outcome.changed;
  });
  stages.delete(key);
  if (outcome.kind === "accepted" || outcome.kind === "replayed") {
    reconciledFor(store).set(key, assembled.value.generation);
  }
  return outcome;
}

async function applyUpdate(
  store: Store,
  connection: HostSessionInventoryConnection,
  message: Extract<HostSessionControlMessage, { type: "host-session.update" }>
): Promise<HostSessionInventoryOutcome> {
  let outcome: HostSessionInventoryOutcome = { kind: "ignored", changed: false };
  await store.transact((state) => {
    if (!connection.isCurrent() || !connection.barrierPassed) {
      outcome = { kind: "ignored", changed: false };
      return false;
    }
    const applied = applyCommittedHostSessionObservation(state, message.session);
    outcome = applied.kind === "accepted" ? { kind: "accepted", changed: true }
      : applied.kind === "replayed" ? { kind: "replayed", changed: false }
        : { kind: "rejected", changed: false, reason: applied.reason };
    return outcome.changed;
  });
  return outcome;
}

/** Current-socket gateway for inventory pages/completion and committed session observations. */
export async function receiveHostSessionInventory(
  store: Store,
  connection: HostSessionInventoryConnection,
  candidate: unknown
): Promise<HostSessionInventoryOutcome> {
  if (!connection.supportsCapability || !connection.barrierPassed || !connection.isCurrent() || connection.nodeId === "") {
    return { kind: "ignored", changed: false };
  }
  const validated = validateHostSessionControlMessage(candidate, "6");
  if (!validated.ok || !["host-session.inventory.page", "host-session.inventory.complete", "host-session.update"].includes(validated.value.type)) {
    return { kind: "rejected", changed: false, reason: validated.ok ? "unsupported host session inventory message" : validated.reason };
  }
  const message = validated.value as InventoryMessage;
  if (message.nodeId !== connection.nodeId) {
    return { kind: "rejected", changed: false, reason: "host session message does not match the registered node" };
  }
  if (message.type === "host-session.inventory.page") return stagePage(store, connection, message);
  if (message.type === "host-session.inventory.complete") return completeGeneration(store, connection, message);
  if (!hasReconciledHostSessionInventory(store, connection)) return { kind: "ignored", changed: false };
  return applyUpdate(store, connection, message);
}
