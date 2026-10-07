import type { Express, Request } from "express";
import {
  containsSecretLikeValue,
  harnessIds,
  hostHarnessSessionControlModes,
  hostHarnessSessionLimits,
  hostHarnessSessionSources,
  hostHarnessSessionStatuses,
  type HostHarnessSession
} from "@coffee-shop/protocol";
import { publicHostHarnessSession, type State, type Store, type StoredHostSessionHistory } from "./store.js";

// `token` is consumed by the production operator guard before this route and is deliberately
// ignored here. Query authentication remains supported for clients that cannot set headers.
const listQueryKeys = new Set(["token", "limit", "cursor", "revision", "nodeId", "harnessId", "workspace", "source", "status", "controlMode"]);
const compareCodeUnits = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

type ListFilters = {
  limit: number;
  cursor?: string;
  revision?: number;
  nodeId?: string;
  harnessId?: string;
  workspace?: string;
  source?: string;
  status?: string;
  controlMode?: string;
};

const safeString = (value: unknown, maximum: number) => typeof value === "string" && value.length > 0
  && Buffer.byteLength(value, "utf8") <= maximum
  && !containsSecretLikeValue(value);

function parseListFilters(request: Request): ListFilters | undefined {
  if (Object.keys(request.query).some((key) => !listQueryKeys.has(key))) return undefined;
  if (Object.values(request.query).some((value) => typeof value !== "string")) return undefined;
  const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > hostHarnessSessionLimits.sessionsPerInventoryPage) return undefined;
  const filters: ListFilters = { limit };
  if (request.query.cursor !== undefined) filters.cursor = request.query.cursor as string;
  if (request.query.revision !== undefined) {
    if (!/^(0|[1-9]\d*)$/.test(request.query.revision as string)) return undefined;
    const revision = Number(request.query.revision);
    if (!Number.isSafeInteger(revision) || revision < 0) return undefined;
    filters.revision = revision;
  }
  for (const key of ["nodeId", "harnessId", "workspace", "source", "status", "controlMode"] as const) {
    const value = request.query[key];
    if (value !== undefined) filters[key] = value as string;
  }
  if (filters.nodeId !== undefined && !safeString(filters.nodeId, hostHarnessSessionLimits.identifierBytes)) return undefined;
  if (filters.cursor !== undefined && !safeString(filters.cursor, hostHarnessSessionLimits.identifierBytes)) return undefined;
  if (filters.harnessId !== undefined && !harnessIds.includes(filters.harnessId as typeof harnessIds[number])) return undefined;
  if (filters.workspace !== undefined && !safeString(filters.workspace, hostHarnessSessionLimits.workspaceBytes)) return undefined;
  if (filters.source !== undefined && !hostHarnessSessionSources.includes(filters.source as typeof hostHarnessSessionSources[number])) return undefined;
  if (filters.status !== undefined && !hostHarnessSessionStatuses.includes(filters.status as typeof hostHarnessSessionStatuses[number])) return undefined;
  if (filters.controlMode !== undefined && !hostHarnessSessionControlModes.includes(filters.controlMode as typeof hostHarnessSessionControlModes[number])) return undefined;
  return filters;
}

const hasListFilters = (filters: ListFilters) => filters.nodeId !== undefined || filters.harnessId !== undefined
  || filters.workspace !== undefined || filters.source !== undefined || filters.status !== undefined
  || filters.controlMode !== undefined;

const filteredSessions = (state: Readonly<State>, filters: ListFilters) => {
  const sessions = state.hostHarnessSessions ?? [];
  if (!hasListFilters(filters)) return sessions;
  return sessions.filter((session) => (filters.nodeId === undefined || session.nodeId === filters.nodeId)
    && (filters.harnessId === undefined || session.harnessId === filters.harnessId)
    && (filters.workspace === undefined || session.workspace === filters.workspace)
    && (filters.source === undefined || session.source === filters.source)
    && (filters.status === undefined || session.status === filters.status)
    && (filters.controlMode === undefined || session.controlMode === filters.controlMode));
};

const firstAfter = (sessions: readonly HostHarnessSession[], cursor?: string) => {
  if (cursor === undefined) return 0;
  let low = 0;
  let high = sessions.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (compareCodeUnits(sessions[middle]!.hostHarnessSessionId, cursor) <= 0) low = middle + 1;
    else high = middle;
  }
  return low;
};

export interface HostSessionListResponse {
  sessions: HostHarnessSession[];
  total: number;
  revision: number;
  nextCursor?: string;
}

export interface HostSessionDetailResponse {
  session: HostHarnessSession;
  links: {
    threadId?: string;
    runId?: string;
  };
}

export interface HostSessionHistoryResponse {
  hostHarnessSessionId: string;
  nodeId: string;
  harnessId: string;
  providerSessionId: string;
  workspace: string;
  revision: number;
  stale: boolean;
  items: StoredHostSessionHistory["items"];
  nextCursor?: string;
  truncated: boolean;
  omitted: boolean;
  observedAt?: string;
}

export function hostSessionList(state: Readonly<State>, filters: ListFilters): HostSessionListResponse {
  const sessions = filteredSessions(state, filters);
  const start = firstAfter(sessions, filters.cursor);
  const page = sessions.slice(start, start + filters.limit).map(publicHostHarnessSession);
  return {
    sessions: page,
    total: sessions.length,
    revision: state.hostSessionInventoryRevision ?? 0,
    ...(start + page.length < sessions.length ? { nextCursor: page.at(-1)!.hostHarnessSessionId } : {})
  };
}

export function hostSessionDetail(state: Readonly<State>, id: string): HostSessionDetailResponse | undefined {
  const session = state.hostHarnessSessions?.find((item) => item.hostHarnessSessionId === id);
  if (!session) return undefined;
  return {
    session: publicHostHarnessSession(session),
    links: {
      ...(session.attachedThreadId === undefined ? {} : { threadId: session.attachedThreadId }),
      ...(session.activeRunId === undefined ? {} : { runId: session.activeRunId })
    }
  };
}

export function hostSessionHistory(state: Readonly<State>, id: string): HostSessionHistoryResponse | undefined {
  const session = state.hostHarnessSessions?.find((item) => item.hostHarnessSessionId === id);
  if (!session) return undefined;
  const history = state.hostSessionHistories?.find((item) => item.hostHarnessSessionId === id
    && item.nodeId === session.nodeId && item.harnessId === session.harnessId
    && item.providerSessionId === session.providerSessionId && item.workspace === session.workspace);
  return {
    hostHarnessSessionId: session.hostHarnessSessionId,
    nodeId: session.nodeId,
    harnessId: session.harnessId,
    providerSessionId: session.providerSessionId,
    workspace: session.workspace,
    revision: history?.revision ?? session.revision,
    stale: history !== undefined && history.revision !== session.revision,
    items: history?.items.map((item) => ({ ...item })) ?? [],
    ...(history?.nextCursor === undefined ? {} : { nextCursor: history.nextCursor }),
    truncated: history?.truncated ?? false,
    omitted: history?.omitted ?? false,
    ...(history === undefined ? {} : { observedAt: history.observedAt })
  };
}

export function registerHostSessionReadRoutes(
  app: Express,
  store: Store,
  options: { refreshHistory?: (hostHarnessSessionId: string) => Promise<void> } = {}
) {
  app.get("/api/host-sessions", (request, response) => {
    const filters = parseListFilters(request);
    if (!filters) return response.status(400).json({ error: "Invalid host-session query" });
    // The keyset is ordered by immutable Coffee Shop identity. A revision is diagnostic rather
    // than a hard fence so status churn on any node cannot starve a multi-page reader.
    const result = store.read((state) => hostSessionList(state, filters));
    response.json(result);
  });
  app.get("/api/host-sessions/:id", (request, response) => {
    const id = String(request.params.id);
    if (!safeString(id, hostHarnessSessionLimits.identifierBytes)) return response.status(404).json({ error: "Host session not found" });
    const detail = store.read((state) => hostSessionDetail(state, id));
    if (!detail) return response.status(404).json({ error: "Host session not found" });
    response.json(detail);
  });
  app.get("/api/host-sessions/:id/history", async (request, response) => {
    const id = String(request.params.id);
    if (!safeString(id, hostHarnessSessionLimits.identifierBytes)) return response.status(404).json({ error: "Host session not found" });
    let history = store.read((state) => hostSessionHistory(state, id));
    if (!history) return response.status(404).json({ error: "Host session not found" });
    if (options.refreshHistory && (history.observedAt === undefined || history.nextCursor !== undefined || history.stale)) {
      await options.refreshHistory(id);
      history = store.read((state) => hostSessionHistory(state, id));
      if (!history) return response.status(404).json({ error: "Host session not found" });
    }
    response.json(history);
  });
}
