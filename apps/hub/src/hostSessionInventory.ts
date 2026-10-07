import { createHash } from "node:crypto";
import {
  canTransitionHostHarnessSession,
  hostHarnessSessionLimits,
  validateHostHarnessSession,
  validateHostHarnessSessionInventoryGeneration,
  validateHostHarnessSessionObservationTransition,
  validateHostSessionControlMessage,
  type HostHarnessSession,
  type HostHarnessSessionInventoryPage,
  type HostHarnessSessionObservation,
  type HostSessionControlMessage
} from "@coffee-shop/protocol";
import { hostSessionInventoryStorageLimits, type HostSessionInventoryGenerationRecord, type State, type Store } from "./store.js";

export type HostSessionInventoryOutcome =
  | { kind: "staged" | "replayed" | "older"; changed: false }
  | { kind: "accepted"; changed: true }
  | { kind: "capacity"; changed: false; reason: string; need?: CapacityNeed }
  | { kind: "rejected"; changed: false; reason: string }
  | { kind: "ignored"; changed: false };

export const hostSessionOutcomeChangesClientSnapshot = (
  message: HostSessionControlMessage,
  outcome: HostSessionInventoryOutcome
) => outcome.changed && message.type !== "host-session.history.page";

export const hostSessionOutcomeRequiresResync = (
  message: HostSessionControlMessage,
  outcome: HostSessionInventoryOutcome
) => outcome.kind === "rejected" && message.type !== "host-session.history.page";

export interface HostSessionInventoryConnection {
  supportsCapability: boolean;
  isCurrent: () => boolean;
  nodeId: string;
  generation: number;
}

interface StagedGeneration {
  generation: number;
  pages: HostHarnessSessionInventoryPage[];
  pageDigests: string[];
}

interface PendingUpdate {
  connection: HostSessionInventoryConnection;
  message: Extract<HostSessionControlMessage, { type: "host-session.update" }>;
  resolve: (outcome: HostSessionInventoryOutcome) => void;
  reject: (error: unknown) => void;
}

interface HostSessionInventoryAuthorityOptions {
  onUpdateBatchCommitted?: () => void;
  onDeferredCapacityMayFit?: (nodeId: string) => void;
  onPostCommitError?: (error: unknown) => void;
}

interface CapacityOpportunity {
  records: number;
  bytes: number;
  removableRecords: number;
  removableBytes: number;
  nodeRecords: number;
  nodeRemovableRecords: number;
}

interface CapacityNeed {
  records: number;
  bytes: number;
  nodeRecords: number;
}

interface CapacityDeferral {
  lastAttemptRevision: number;
  baseline: CapacityOpportunity;
  need?: CapacityNeed;
}

export const hostSessionUpdateBatchMilliseconds = 25;
export const hostSessionUpdatesPerConnection = 64;
export const hostSessionUpdatesGlobal = 512;

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, item]) => [key, canonical(item)]));
};

const semanticDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const compareCodeUnits = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

const pageDigest = (page: HostHarnessSessionInventoryPage) => semanticDigest({
  nodeId: page.nodeId, generation: page.generation, pageIndex: page.pageIndex, sessions: page.sessions
});

const generationDigest = (pages: readonly HostHarnessSessionInventoryPage[], pageCount: number, sessionCount: number) => semanticDigest({
  pages: pages.map((page) => ({ nodeId: page.nodeId, generation: page.generation, pageIndex: page.pageIndex, sessions: page.sessions })),
  pageCount, sessionCount
});

const markerFor = (state: Readonly<State>, nodeId: string) =>
  state.hostSessionInventoryGenerations?.find((marker) => marker.nodeId === nodeId);

const providerIdentity = (session: Pick<HostHarnessSessionObservation, "nodeId" | "harnessId" | "workspace" | "providerSessionId">) =>
  [session.nodeId, session.harnessId, session.workspace, session.providerSessionId].join("\u0000");

const exactObservation = (left: HostHarnessSessionObservation, right: HostHarnessSessionObservation) =>
  semanticDigest(left) === semanticDigest(right);

const sameImmutableObservationIdentity = (left: HostHarnessSessionObservation, right: HostHarnessSessionObservation) =>
  left.hostHarnessSessionId === right.hostHarnessSessionId && left.nodeId === right.nodeId
  && left.harnessId === right.harnessId && left.providerSessionId === right.providerSessionId
  && left.workspace === right.workspace && left.source === right.source && left.createdAt === right.createdAt;

const observationOf = (session: HostHarnessSession): HostHarnessSessionObservation => {
  const { attachedThreadId: _attachedThreadId, activeRunId: _activeRunId, attachmentEpoch: _attachmentEpoch, ...observation } = session;
  return observation;
};

const measuredInventoryBytes = (sessions: readonly HostHarnessSession[]) =>
  Buffer.byteLength(JSON.stringify(sessions), "utf8");

function inventoryExtent(state: State) {
  const records = state.hostHarnessSessions!.length;
  if (state.hostSessionInventoryRecords === records && Number.isSafeInteger(state.hostSessionInventoryBytes)
    && state.hostSessionInventoryBytes! >= 2) {
    return { records, bytes: state.hostSessionInventoryBytes! };
  }
  const bytes = measuredInventoryBytes(state.hostHarnessSessions!);
  state.hostSessionInventoryRecords = records;
  state.hostSessionInventoryBytes = bytes;
  return { records, bytes };
}

function measureInventory(state: State) {
  state.hostSessionInventoryRecords = state.hostHarnessSessions!.length;
  state.hostSessionInventoryBytes = measuredInventoryBytes(state.hostHarnessSessions!);
}

const removableSession = (session: HostHarnessSession, protectedSessionIds: ReadonlySet<string> = new Set()) =>
  session.attachedThreadId === undefined
  && session.activeRunId === undefined
  && !protectedSessionIds.has(session.hostHarnessSessionId)
  && (session.status === "offline" || session.status === "closed" || session.status === "failed");

function capacityOpportunity(state: State, nodeId: string): CapacityOpportunity {
  const extent = inventoryExtent(state);
  const removable = state.hostHarnessSessions!.filter((session) => removableSession(session));
  return {
    ...extent,
    removableRecords: removable.length,
    removableBytes: removable.reduce((total, session) =>
      total + Buffer.byteLength(JSON.stringify(session), "utf8") + 1, 0),
    nodeRecords: state.hostHarnessSessions!.filter((session) => session.nodeId === nodeId).length,
    nodeRemovableRecords: removable.filter((session) => session.nodeId === nodeId).length
  };
}

function globalCapacityNeed(state: State, protectedSessionIds: ReadonlySet<string>): CapacityNeed {
  let { records, bytes } = inventoryExtent(state);
  for (const session of state.hostHarnessSessions!) {
    if (!removableSession(session, protectedSessionIds)) continue;
    records -= 1;
    bytes -= Buffer.byteLength(JSON.stringify(session), "utf8") + (records >= 1 ? 1 : 0);
  }
  return {
    records: Math.max(0, records - hostHarnessSessionLimits.sessionsGlobal),
    bytes: Math.max(0, bytes - hostSessionInventoryStorageLimits.bytes),
    nodeRecords: 0
  };
}

function nodeCapacityNeed(state: State, nodeId: string, protectedSessionIds: ReadonlySet<string>): CapacityNeed {
  const sessions = state.hostHarnessSessions!.filter((session) => session.nodeId === nodeId);
  const retained = sessions.filter((session) => !removableSession(session, protectedSessionIds)).length;
  return {
    records: 0,
    bytes: 0,
    nodeRecords: Math.max(0, retained - hostHarnessSessionLimits.sessionsPerGeneration)
  };
}

const capacityNeedMet = (deferral: CapacityDeferral, current: CapacityOpportunity) => {
  if (!deferral.need) return false;
  const recordHeadroom = deferral.baseline.records - current.records
    + current.removableRecords - deferral.baseline.removableRecords;
  const byteHeadroom = deferral.baseline.bytes - current.bytes
    + current.removableBytes - deferral.baseline.removableBytes;
  const nodeHeadroom = deferral.baseline.nodeRecords - current.nodeRecords
    + current.nodeRemovableRecords - deferral.baseline.nodeRemovableRecords;
  return recordHeadroom >= deferral.need.records
    && byteHeadroom >= deferral.need.bytes
    && nodeHeadroom >= deferral.need.nodeRecords;
};

function offlineObservation(session: HostHarnessSession): HostHarnessSession | undefined {
  if (session.status === "closed" || session.status === "failed" || session.status === "offline") return session;
  if (!canTransitionHostHarnessSession(session.status, "offline")) return undefined;
  const candidate: HostHarnessSession = {
    ...session,
    status: "offline"
  };
  const validated = validateHostHarnessSession(candidate);
  return validated.ok ? validated.value : undefined;
}

export function projectNodeHostSessionsOffline(state: State, nodeId: string) {
  const marker = markerFor(state, nodeId);
  if (!marker) return false;
  const candidates = state.hostHarnessSessions!.filter((session) => session.nodeId === nodeId
    && session.status !== "offline" && session.status !== "closed" && session.status !== "failed");
  if (candidates.length === 0) return false;
  const revision = state.hostSessionInventoryRevision ?? 0;
  if (!Number.isSafeInteger(revision) || revision >= Number.MAX_SAFE_INTEGER) return false;
  const projections = new Map(marker.offlineProjections?.map((projection) =>
    [projection.hostHarnessSessionId, projection]) ?? []);
  const candidateIds = new Set(candidates.map((session) => session.hostHarnessSessionId));
  state.hostHarnessSessions = state.hostHarnessSessions!.map((session) => {
    if (!candidateIds.has(session.hostHarnessSessionId)) return session;
    const offline = offlineObservation(session);
    if (!offline) return session;
    if (!projections.has(session.hostHarnessSessionId)) {
      projections.set(session.hostHarnessSessionId, {
        hostHarnessSessionId: session.hostHarnessSessionId,
        revision: session.revision,
        originalStatus: session.status,
        originalUpdatedAt: session.updatedAt
      });
    }
    return offline;
  });
  marker.offlineProjections = [...projections.values()]
    .sort((left, right) => compareCodeUnits(left.hostHarnessSessionId, right.hostHarnessSessionId));
  state.hostSessionInventoryRevision = revision + 1;
  measureInventory(state);
  return true;
}

const offlineProjectionFor = (state: Readonly<State>, session: Pick<HostHarnessSession, "nodeId" | "hostHarnessSessionId" | "revision">) =>
  markerFor(state, session.nodeId)?.offlineProjections?.find((projection) =>
    projection.hostHarnessSessionId === session.hostHarnessSessionId && projection.revision === session.revision);

const baristaObservationBeforeProjection = (
  session: HostHarnessSession,
  projection: NonNullable<HostSessionInventoryGenerationRecord["offlineProjections"]>[number]
) => observationOf({ ...session, status: projection.originalStatus, updatedAt: projection.originalUpdatedAt });

function clearOfflineProjection(state: State, nodeId: string, hostHarnessSessionId: string) {
  const marker = markerFor(state, nodeId);
  if (!marker?.offlineProjections) return;
  marker.offlineProjections = marker.offlineProjections.filter((projection) =>
    projection.hostHarnessSessionId !== hostHarnessSessionId);
  if (marker.offlineProjections.length === 0) delete marker.offlineProjections;
}

export function enforceNodeHostSessionRetention(
  state: State,
  nodeId: string,
  protectedSessionIds: ReadonlySet<string> = new Set()
) {
  const nodeSessions = state.hostHarnessSessions!.filter((session) => session.nodeId === nodeId);
  if (nodeSessions.length <= hostHarnessSessionLimits.sessionsPerGeneration) return true;
  const removable = nodeSessions.filter((session) => session.attachedThreadId === undefined
    && session.activeRunId === undefined
    && !protectedSessionIds.has(session.hostHarnessSessionId)
    && (session.status === "offline" || session.status === "closed" || session.status === "failed"))
    .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt)
      || compareCodeUnits(left.hostHarnessSessionId, right.hostHarnessSessionId));
  const remove = new Set<string>();
  for (const session of removable) {
    if (nodeSessions.length - remove.size <= hostHarnessSessionLimits.sessionsPerGeneration) break;
    remove.add(session.hostHarnessSessionId);
  }
  if (nodeSessions.length - remove.size > hostHarnessSessionLimits.sessionsPerGeneration) return false;
  state.hostHarnessSessions = state.hostHarnessSessions!.filter((session) =>
    session.nodeId !== nodeId || !remove.has(session.hostHarnessSessionId));
  state.hostSessionHistories = state.hostSessionHistories!.filter((history) =>
    history.nodeId !== nodeId || !remove.has(history.hostHarnessSessionId));
  measureInventory(state);
  return true;
}

export function enforceGlobalHostSessionRetention(
  state: State,
  options: { protectedSessionIds?: ReadonlySet<string>; replacingNodeId?: string } = {}
) {
  const sessions = state.hostHarnessSessions!;
  let { records, bytes } = inventoryExtent(state);
  if (records <= hostHarnessSessionLimits.sessionsGlobal && bytes <= hostSessionInventoryStorageLimits.bytes) return true;
  const removable = sessions.filter((session) => session.attachedThreadId === undefined
    && session.activeRunId === undefined
    && !(options.protectedSessionIds?.has(session.hostHarnessSessionId) ?? false)
    && (session.status === "offline" || session.status === "closed" || session.status === "failed"))
    .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt)
      || compareCodeUnits(left.hostHarnessSessionId, right.hostHarnessSessionId));
  const remove = new Set<string>();
  for (const session of removable) {
    if (records <= hostHarnessSessionLimits.sessionsGlobal && bytes <= hostSessionInventoryStorageLimits.bytes) break;
    remove.add(session.hostHarnessSessionId);
    records -= 1;
    bytes -= Buffer.byteLength(JSON.stringify(session), "utf8") + (records >= 1 ? 1 : 0);
  }
  if (records > hostHarnessSessionLimits.sessionsGlobal || bytes > hostSessionInventoryStorageLimits.bytes) return false;
  const invalidatedNodes = new Set(sessions.filter((session) => remove.has(session.hostHarnessSessionId)
    && session.nodeId !== options.replacingNodeId).map((session) => session.nodeId));
  state.hostHarnessSessions = sessions.filter((session) => !remove.has(session.hostHarnessSessionId));
  state.hostSessionInventoryRecords = records;
  state.hostSessionInventoryBytes = bytes;
  state.hostSessionHistories = state.hostSessionHistories!.filter((history) => !remove.has(history.hostHarnessSessionId));
  for (const marker of state.hostSessionInventoryGenerations!) {
    if (!marker.offlineProjections) continue;
    marker.offlineProjections = marker.offlineProjections.filter((projection) =>
      !remove.has(projection.hostHarnessSessionId));
    if (marker.offlineProjections.length === 0) delete marker.offlineProjections;
  }
  for (const marker of state.hostSessionInventoryGenerations!) {
    if (invalidatedNodes.has(marker.nodeId)) marker.invalidated = true;
  }
  return true;
}

export function applyHostSessionGeneration(
  state: State,
  pages: HostHarnessSessionInventoryPage[],
  complete: Extract<HostSessionControlMessage, { type: "host-session.inventory.complete" }>,
  options: { allowGenerationReset?: boolean } = {}
): HostSessionInventoryOutcome {
  const assembled = validateHostHarnessSessionInventoryGeneration(pages, complete);
  if (!assembled.ok) return { kind: "rejected", changed: false, reason: assembled.reason };
  if (!state.nodes.some((node) => node.id === complete.nodeId)) {
    return { kind: "rejected", changed: false, reason: "host-session inventory names an unknown node" };
  }
  const digest = generationDigest(pages, complete.pageCount, complete.sessionCount);
  const currentMarker = markerFor(state, complete.nodeId);
  const repairingInvalidatedReplay = currentMarker?.generation === complete.generation
    && currentMarker.digest === digest && currentMarker.invalidated === true;
  const currentOfflineProjections = new Map(currentMarker?.offlineProjections?.map((projection) =>
    [projection.hostHarnessSessionId, projection]) ?? []);
  if (currentMarker) {
    if (complete.generation < currentMarker.generation && !options.allowGenerationReset) return { kind: "older", changed: false };
    if (complete.generation === currentMarker.generation) {
      if (currentMarker.digest === digest && currentMarker.invalidated !== true) {
        return { kind: "replayed", changed: false };
      }
      if (currentMarker.digest !== digest && !options.allowGenerationReset) {
        return { kind: "rejected", changed: false, reason: "host-session generation replay conflicts with committed evidence" };
      }
    }
  }

  const current = new Map(state.hostHarnessSessions!.filter((session) => session.nodeId === complete.nodeId)
    .map((session) => [session.hostHarnessSessionId, session]));
  const sessionOwners = new Map(state.hostHarnessSessions!.map((session) =>
    [session.hostHarnessSessionId, session.nodeId]));
  const nextNode = new Map<string, HostHarnessSession>();
  const providerIdentities = new Map<string, string>();
  const retiredSessionIds = new Set<string>();
  const reportedSessionIds = new Set(assembled.value.sessions.map((session) => session.hostHarnessSessionId));
  for (const observed of assembled.value.sessions) {
    const owner = sessionOwners.get(observed.hostHarnessSessionId);
    if (owner !== undefined && owner !== complete.nodeId) {
      return { kind: "rejected", changed: false, reason: "host-session inventory conflicts with another node's session identity" };
    }
    const existing = current.get(observed.hostHarnessSessionId);
    let authoritativeObservation = observed;
    if (existing) {
      if (repairingInvalidatedReplay && existing.revision > observed.revision) {
        // A previously accepted delta may be newer than the exact generation being replayed to
        // repair retention. Preserve it while restoring records evicted from that generation.
        nextNode.set(observed.hostHarnessSessionId, existing);
        authoritativeObservation = observationOf(existing);
      } else {
        const projection = currentOfflineProjections.get(existing.hostHarnessSessionId);
        const transition = validateHostHarnessSessionObservationTransition(
          projection ? baristaObservationBeforeProjection(existing, projection) : observationOf(existing), observed);
        if (!transition.ok) return { kind: "rejected", changed: false, reason: transition.reason };
        nextNode.set(observed.hostHarnessSessionId, {
          ...observed,
          ...(existing.attachedThreadId === undefined ? {} : { attachedThreadId: existing.attachedThreadId }),
          ...(existing.activeRunId === undefined ? {} : { activeRunId: existing.activeRunId }),
          attachmentEpoch: existing.attachmentEpoch
        });
      }
    } else {
      nextNode.set(observed.hostHarnessSessionId, { ...observed, attachmentEpoch: 0 });
    }
    const identity = providerIdentity(authoritativeObservation);
    const duplicate = providerIdentities.get(identity);
    if (duplicate && duplicate !== observed.hostHarnessSessionId) {
      return { kind: "rejected", changed: false, reason: "host-session inventory repeats provider identity" };
    }
    providerIdentities.set(identity, observed.hostHarnessSessionId);
  }
  for (const existing of current.values()) {
    if (nextNode.has(existing.hostHarnessSessionId)) continue;
    const offline = offlineObservation(existing);
    if (!offline) return { kind: "rejected", changed: false, reason: "host-session offline reconciliation is illegal" };
    const identity = providerIdentity(offline);
    const duplicate = providerIdentities.get(identity);
    if (duplicate && duplicate !== offline.hostHarnessSessionId) {
      const replaceable = existing.attachedThreadId === undefined && existing.activeRunId === undefined;
      if (!replaceable) {
        return { kind: "rejected", changed: false, reason: "host-session inventory conflicts with retained provider identity" };
      }
      retiredSessionIds.add(existing.hostHarnessSessionId);
      continue;
    }
    providerIdentities.set(identity, offline.hostHarnessSessionId);
    nextNode.set(offline.hostHarnessSessionId, offline);
  }

  state.hostHarnessSessions = [
    ...state.hostHarnessSessions!.filter((session) => session.nodeId !== complete.nodeId),
    ...nextNode.values()
  ].sort((left, right) => compareCodeUnits(left.hostHarnessSessionId, right.hostHarnessSessionId));
  measureInventory(state);
  if (retiredSessionIds.size > 0) {
    state.hostSessionHistories = state.hostSessionHistories!.filter((history) =>
      history.nodeId !== complete.nodeId || !retiredSessionIds.has(history.hostHarnessSessionId));
  }
  if (!enforceNodeHostSessionRetention(state, complete.nodeId, reportedSessionIds)) {
    return {
      kind: "capacity",
      changed: false,
      reason: "host-session inventory capacity conflict",
      need: nodeCapacityNeed(state, complete.nodeId, reportedSessionIds)
    };
  }
  if (!enforceGlobalHostSessionRetention(state, {
    protectedSessionIds: reportedSessionIds,
    replacingNodeId: complete.nodeId
  })) {
    return {
      kind: "capacity",
      changed: false,
      reason: "global host-session inventory capacity conflict",
      need: globalCapacityNeed(state, reportedSessionIds)
    };
  }
  const retainedIds = new Set(state.hostHarnessSessions!.filter((session) => session.nodeId === complete.nodeId)
    .map((session) => session.hostHarnessSessionId));
  const offlineProjections = [...current.values()]
    .filter((session) => !reportedSessionIds.has(session.hostHarnessSessionId))
    .filter((session) => currentOfflineProjections.has(session.hostHarnessSessionId)
      || (session.status !== "offline" && session.status !== "closed" && session.status !== "failed"))
    .filter((session) => retainedIds.has(session.hostHarnessSessionId))
    .map((session) => currentOfflineProjections.get(session.hostHarnessSessionId) ?? {
      hostHarnessSessionId: session.hostHarnessSessionId,
      revision: session.revision,
      originalStatus: session.status,
      originalUpdatedAt: session.updatedAt
    })
    .sort((left, right) => compareCodeUnits(left.hostHarnessSessionId, right.hostHarnessSessionId));
  const marker: HostSessionInventoryGenerationRecord = {
    nodeId: complete.nodeId, generation: complete.generation, digest, completedAt: complete.at,
    ...(offlineProjections.length === 0 ? {} : { offlineProjections })
  };
  state.hostSessionInventoryGenerations = [
    ...state.hostSessionInventoryGenerations!.filter((item) => item.nodeId !== complete.nodeId), marker
  ].sort((left, right) => compareCodeUnits(left.nodeId, right.nodeId));
  return { kind: "accepted", changed: true };
}

export function applyHostSessionUpdate(
  state: State,
  message: Extract<HostSessionControlMessage, { type: "host-session.update" }>
): HostSessionInventoryOutcome {
  const index = state.hostHarnessSessions!.findIndex((session) => session.hostHarnessSessionId === message.session.hostHarnessSessionId);
  if (index < 0) return { kind: "rejected", changed: false, reason: "host-session update names an unknown session" };
  const current = state.hostHarnessSessions![index]!;
  if (current.nodeId !== message.nodeId) return { kind: "rejected", changed: false, reason: "host-session update names the wrong node" };
  const projection = offlineProjectionFor(state, current);
  const returningFromProjection = projection !== undefined;
  const previous = projection ? baristaObservationBeforeProjection(current, projection) : observationOf(current);
  if (message.session.revision < previous.revision) {
    return sameImmutableObservationIdentity(previous, message.session)
      ? { kind: "older", changed: false }
      : { kind: "rejected", changed: false, reason: "host-session update names conflicting immutable identity" };
  }
  const transition = validateHostHarnessSessionObservationTransition(
    previous, message.session);
  if (!transition.ok) return { kind: "rejected", changed: false, reason: transition.reason };
  if (message.session.revision === current.revision && !returningFromProjection) {
    return exactObservation(observationOf(current), message.session)
      ? { kind: "replayed", changed: false }
      : { kind: "rejected", changed: false, reason: "host-session update replay conflicts with committed evidence" };
  }
  if ((!returningFromProjection && message.session.revision !== current.revision + 1)
    || (projection && message.session.revision !== projection.revision && message.session.revision !== projection.revision + 1)) {
    return { kind: "rejected", changed: false, reason: "host-session update revision has a gap" };
  }
  const replacement: HostHarnessSession = {
    ...message.session,
    ...(current.attachedThreadId === undefined ? {} : { attachedThreadId: current.attachedThreadId }),
    ...(current.activeRunId === undefined ? {} : { activeRunId: current.activeRunId }),
    attachmentEpoch: current.attachmentEpoch
  };
  const extent = inventoryExtent(state);
  const replacementBytes = extent.bytes
    - Buffer.byteLength(JSON.stringify(current), "utf8")
    + Buffer.byteLength(JSON.stringify(replacement), "utf8");
  if (extent.records <= hostHarnessSessionLimits.sessionsGlobal
    && replacementBytes <= hostSessionInventoryStorageLimits.bytes) {
    state.hostHarnessSessions![index] = replacement;
    state.hostSessionInventoryBytes = replacementBytes;
    state.hostSessionInventoryRecords = extent.records;
    clearOfflineProjection(state, message.nodeId, message.session.hostHarnessSessionId);
    return { kind: "accepted", changed: true };
  }
  const candidate: State = {
    ...state,
    hostHarnessSessions: [...state.hostHarnessSessions!],
    hostSessionInventoryGenerations: state.hostSessionInventoryGenerations!.map((entry) => ({
      ...entry,
      ...(entry.offlineProjections === undefined ? {} : {
        offlineProjections: entry.offlineProjections.map((projection) => ({ ...projection }))
      })
    })),
    hostSessionHistories: state.hostSessionHistories!
  };
  candidate.hostHarnessSessions![index] = replacement;
  candidate.hostSessionInventoryBytes = replacementBytes;
  candidate.hostSessionInventoryRecords = extent.records;
  clearOfflineProjection(candidate, message.nodeId, message.session.hostHarnessSessionId);
  const protectedSessionIds = new Set([message.session.hostHarnessSessionId]);
  if (!enforceGlobalHostSessionRetention(candidate, { protectedSessionIds })) {
    return {
      kind: "capacity",
      changed: false,
      reason: "global host-session inventory byte capacity conflict",
      need: globalCapacityNeed(candidate, protectedSessionIds)
    };
  }
  state.hostHarnessSessions = candidate.hostHarnessSessions;
  state.hostSessionInventoryGenerations = candidate.hostSessionInventoryGenerations;
  state.hostSessionHistories = candidate.hostSessionHistories;
  state.hostSessionInventoryBytes = candidate.hostSessionInventoryBytes;
  state.hostSessionInventoryRecords = candidate.hostSessionInventoryRecords;
  return { kind: "accepted", changed: true };
}

function advanceInventoryRevision(state: State) {
  const revision = state.hostSessionInventoryRevision ?? 0;
  if (!Number.isSafeInteger(revision) || revision >= Number.MAX_SAFE_INTEGER) return false;
  state.hostSessionInventoryRevision = revision + 1;
  return true;
}

export class HostSessionInventoryAuthority {
  private readonly staged = new Map<string, StagedGeneration>();
  private readonly committedConnections = new Set<string>();
  private readonly capacityDeferredNodes = new Map<string, CapacityDeferral>();
  private readonly inFlightUpdatesByConnection = new Map<string, number>();
  private inFlightUpdates = 0;
  private pendingUpdates: PendingUpdate[] = [];
  private updateTimer: ReturnType<typeof setTimeout> | undefined;
  private updateFlush: Promise<void> | undefined;

  constructor(
    private readonly store: Store,
    private readonly options: HostSessionInventoryAuthorityOptions = {}
  ) {}

  private key(connection: HostSessionInventoryConnection) {
    return `${connection.nodeId}\u0000${connection.generation}`;
  }

  discard(connection: HostSessionInventoryConnection) {
    const key = this.key(connection);
    this.staged.delete(key);
    this.committedConnections.delete(key);
  }

  private discardStaging(connection: HostSessionInventoryConnection) {
    this.staged.delete(this.key(connection));
  }

  connectionStateSize() {
    return new Set([...this.staged.keys(), ...this.committedConnections]).size;
  }

  isCapacityDeferred(nodeId: string) {
    return this.capacityDeferredNodes.has(nodeId);
  }

  deferUpdate(
    connection: HostSessionInventoryConnection,
    message: Extract<HostSessionControlMessage, { type: "host-session.update" }>,
    resolve: (outcome: HostSessionInventoryOutcome) => void,
    reject: (error: unknown) => void
  ): HostSessionInventoryOutcome {
    if (!connection.supportsCapability || !connection.isCurrent() || connection.nodeId === "") {
      this.discardStaging(connection);
      return { kind: "ignored", changed: false };
    }
    if (message.nodeId !== connection.nodeId) {
      this.discardStaging(connection);
      return { kind: "rejected", changed: false, reason: "host-session frame does not match the registered node" };
    }
    const connectionKey = this.key(connection);
    const connectionUpdates = this.inFlightUpdatesByConnection.get(connectionKey) ?? 0;
    if (connectionUpdates >= hostSessionUpdatesPerConnection || this.inFlightUpdates >= hostSessionUpdatesGlobal) {
      return { kind: "rejected", changed: false, reason: "host-session update queue capacity exceeded" };
    }
    this.inFlightUpdatesByConnection.set(connectionKey, connectionUpdates + 1);
    this.inFlightUpdates += 1;
    this.pendingUpdates.push({ connection, message, resolve, reject });
    this.scheduleUpdateFlush();
    return { kind: "staged", changed: false };
  }

  async receive(connection: HostSessionInventoryConnection, candidate: unknown): Promise<HostSessionInventoryOutcome> {
    if (!connection.supportsCapability || !connection.isCurrent() || connection.nodeId === "") {
      this.discardStaging(connection);
      return { kind: "ignored", changed: false };
    }
    const validated = validateHostSessionControlMessage(candidate, "6");
    if (!validated.ok) return { kind: "rejected", changed: false, reason: validated.reason };
    const message = validated.value;
    if (message.nodeId !== connection.nodeId) {
      this.discardStaging(connection);
      return { kind: "rejected", changed: false, reason: "host-session frame does not match the registered node" };
    }
    if (message.type === "host-session.inventory.page") {
      await this.flushPendingUpdatesFor(connection);
      return this.stagePage(connection, message);
    }
    if (message.type === "host-session.inventory.complete") {
      await this.flushPendingUpdatesFor(connection);
      return this.commit(connection, message);
    }
    if (message.type !== "host-session.update") {
      return { kind: "rejected", changed: false, reason: "host-session frame is not inventory evidence" };
    }
    return new Promise<HostSessionInventoryOutcome>((resolve, reject) => {
      const immediate = this.deferUpdate(connection, message, resolve, reject);
      if (immediate.kind !== "staged") resolve(immediate);
    });
  }

  private scheduleUpdateFlush() {
    if (this.updateTimer !== undefined || this.updateFlush !== undefined) return;
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      void this.flushUpdates();
    }, hostSessionUpdateBatchMilliseconds);
  }

  private flushUpdates() {
    if (this.updateFlush) return this.updateFlush;
    if (this.updateTimer !== undefined) {
      clearTimeout(this.updateTimer);
      this.updateTimer = undefined;
    }
    const flush = this.flushUpdateBatch();
    this.updateFlush = flush;
    const finish = () => {
      if (this.updateFlush === flush) this.updateFlush = undefined;
      if (this.pendingUpdates.length > 0) this.scheduleUpdateFlush();
    };
    void flush.then(finish, finish);
    return flush;
  }

  private async flushPendingUpdatesFor(connection: HostSessionInventoryConnection) {
    const connectionKey = this.key(connection);
    for (;;) {
      if (this.updateFlush) await this.updateFlush;
      const hasPending = this.pendingUpdates.some((item) => this.key(item.connection) === connectionKey);
      if (!hasPending) return;
      await this.flushUpdates();
    }
  }

  private async flushUpdateBatch() {
    const pending = this.pendingUpdates;
    this.pendingUpdates = [];
    if (pending.length === 0) return;
    const outcomes = pending.map<HostSessionInventoryOutcome>(() => ({ kind: "ignored", changed: false }));
    const deferred = new Set<string>();
    let committed = false;
    let committedRevision = 0;
    try {
      await this.store.transact((state) => {
        let changed = false;
        for (const [index, item] of pending.entries()) {
          if (!item.connection.isCurrent()) continue;
          if (deferred.has(item.connection.nodeId)) {
            outcomes[index] = { kind: "capacity", changed: false, reason: "host-session inventory remains deferred by capacity" };
            continue;
          }
          let outcome = applyHostSessionUpdate(state, item.message);
          const deferral = this.capacityDeferredNodes.get(item.connection.nodeId);
          const current = state.hostHarnessSessions!.find((session) =>
            session.hostHarnessSessionId === item.message.session.hostHarnessSessionId);
          const canRemainDeferred = current === undefined
            || (current.nodeId === item.connection.nodeId
              && sameImmutableObservationIdentity(observationOf(current), item.message.session));
          if (outcome.kind === "rejected" && deferral && canRemainDeferred) {
            outcome = { kind: "capacity", changed: false, reason: "host-session inventory remains deferred by capacity" };
          }
          outcomes[index] = outcome;
          if (outcome.kind === "capacity") deferred.add(item.connection.nodeId);
          if (outcome.changed) changed = true;
        }
        if (changed && !advanceInventoryRevision(state)) {
          for (let index = 0; index < outcomes.length; index += 1) {
            if (outcomes[index]!.changed) {
              outcomes[index] = { kind: "capacity", changed: false, reason: "host-session inventory revision is exhausted" };
              deferred.add(pending[index]!.connection.nodeId);
            }
          }
          return false;
        }
        if (changed) {
          committed = true;
          committedRevision = state.hostSessionInventoryRevision!;
        }
        return changed;
      });
    } catch (error) {
      this.releaseUpdateSlots(pending);
      pending.forEach((item) => item.reject(error));
      return;
    }
    for (const nodeId of deferred) {
      const outcome = outcomes.find((candidate, index) =>
        pending[index]!.connection.nodeId === nodeId && candidate.kind === "capacity");
      try {
        this.recordCapacityDeferral(nodeId, outcome?.kind === "capacity" ? outcome.need : undefined);
      } catch (error) {
        this.options.onPostCommitError?.(error);
      }
    }
    this.releaseUpdateSlots(pending);
    pending.forEach((item, index) => {
      try {
        item.resolve(outcomes[index]!);
      } catch (error) {
        this.options.onPostCommitError?.(error);
      }
    });
    if (committed) {
      try {
        this.options.onUpdateBatchCommitted?.();
      } catch (error) {
        this.options.onPostCommitError?.(error);
      }
      try {
        this.notifyDeferredCapacityMayFit(committedRevision);
      } catch (error) {
        this.options.onPostCommitError?.(error);
      }
    }
  }

  private releaseUpdateSlots(pending: readonly PendingUpdate[]) {
    for (const item of pending) {
      const connectionKey = this.key(item.connection);
      const remaining = (this.inFlightUpdatesByConnection.get(connectionKey) ?? 1) - 1;
      if (remaining <= 0) this.inFlightUpdatesByConnection.delete(connectionKey);
      else this.inFlightUpdatesByConnection.set(connectionKey, remaining);
      this.inFlightUpdates -= 1;
    }
  }

  private recordCapacityDeferral(nodeId: string, need?: CapacityNeed) {
    const retainedNeed = need ?? this.capacityDeferredNodes.get(nodeId)?.need;
    this.capacityDeferredNodes.set(nodeId, this.store.read((state) => ({
      lastAttemptRevision: state.hostSessionInventoryRevision ?? 0,
      baseline: capacityOpportunity(state, nodeId),
      need: retainedNeed
    })));
  }

  private notifyDeferredCapacityMayFit(revision: number) {
    for (const [nodeId, deferral] of this.capacityDeferredNodes) {
      if (deferral.lastAttemptRevision >= revision) continue;
      const canFit = this.store.read((state) => capacityNeedMet(deferral, capacityOpportunity(state, nodeId)));
      if (!canFit) continue;
      deferral.lastAttemptRevision = revision;
      this.options.onDeferredCapacityMayFit?.(nodeId);
    }
  }

  private stagePage(connection: HostSessionInventoryConnection, page: HostHarnessSessionInventoryPage): HostSessionInventoryOutcome {
    const marker = this.store.read((state) => markerFor(state, connection.nodeId));
    if (marker && page.generation < marker.generation && this.committedConnections.has(this.key(connection))) {
      return { kind: "older", changed: false };
    }
    const connectionKey = this.key(connection);
    let staged = this.staged.get(connectionKey);
    if (!staged || staged.generation !== page.generation) {
      staged = { generation: page.generation, pages: [], pageDigests: [] };
      this.staged.set(connectionKey, staged);
    }
    const digest = pageDigest(page);
    if (page.pageIndex < staged.pages.length) {
      if (staged.pageDigests[page.pageIndex] === digest) return { kind: "staged", changed: false };
      this.discardStaging(connection);
      return { kind: "rejected", changed: false, reason: "host-session inventory page replay conflicts" };
    }
    if (page.pageIndex !== staged.pages.length) {
      this.discardStaging(connection);
      return { kind: "rejected", changed: false, reason: "host-session inventory pages are out of order" };
    }
    staged.pages.push(page);
    staged.pageDigests.push(digest);
    return { kind: "staged", changed: false };
  }

  private async commit(
    connection: HostSessionInventoryConnection,
    complete: Extract<HostSessionControlMessage, { type: "host-session.inventory.complete" }>
  ): Promise<HostSessionInventoryOutcome> {
    const connectionKey = this.key(connection);
    const staged = this.staged.get(connectionKey);
    const emptyGeneration = complete.pageCount === 0 && complete.sessionCount === 0;
    if ((!staged && !emptyGeneration) || (staged && staged.generation !== complete.generation)) {
      this.discardStaging(connection);
      return { kind: "rejected", changed: false, reason: "host-session inventory completion has no matching pages" };
    }
    let outcome: HostSessionInventoryOutcome = { kind: "ignored", changed: false };
    let committedRevision = 0;
    await this.store.transact((state) => {
      if (!connection.isCurrent()) {
        outcome = { kind: "ignored", changed: false };
        return false;
      }
      outcome = applyHostSessionGeneration(state, staged?.pages ?? [], complete, {
        allowGenerationReset: !this.committedConnections.has(this.key(connection))
      });
      if (outcome.changed && !advanceInventoryRevision(state)) {
        outcome = { kind: "capacity", changed: false, reason: "host-session inventory revision is exhausted" };
      }
      if (outcome.changed) {
        committedRevision = state.hostSessionInventoryRevision!;
      }
      return outcome.changed;
    });
    if (this.staged.get(connectionKey) === staged) this.staged.delete(connectionKey);
    const completedOutcome = outcome as HostSessionInventoryOutcome;
    const completedKind = completedOutcome.kind;
    if (completedOutcome.kind === "capacity") {
      this.recordCapacityDeferral(connection.nodeId, completedOutcome.need);
    }
    if (completedKind === "accepted" || completedKind === "replayed" || completedKind === "older") {
      this.capacityDeferredNodes.delete(connection.nodeId);
    }
    if (committedRevision > 0) this.notifyDeferredCapacityMayFit(committedRevision);
    if (connection.isCurrent()
      && (completedKind === "accepted" || completedKind === "replayed" || completedKind === "older")) {
      this.committedConnections.add(this.key(connection));
    }
    return outcome;
  }
}
