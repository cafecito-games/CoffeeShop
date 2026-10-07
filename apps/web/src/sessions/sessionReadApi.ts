import {
  hostHarnessSessionLimits, isHostHarnessSessionId, validateHostHarnessSession,
  validateHostHarnessSessionHistoryItem, type HostHarnessSession, type HostHarnessSessionHistoryItem
} from "@coffee-shop/protocol";

export interface HostSessionDetailResponse {
  session: HostHarnessSession;
  links: { threadId?: string; runId?: string };
}

export interface HostSessionListResponse {
  sessions: HostHarnessSession[];
  total: number;
  revision: number;
  nextCursor?: string;
}

export interface HostSessionHistoryResponse {
  hostHarnessSessionId: string;
  nodeId: string;
  harnessId: string;
  providerSessionId: string;
  workspace: string;
  revision: number;
  stale: boolean;
  items: HostHarnessSessionHistoryItem[];
  nextCursor?: string;
  truncated: boolean;
  omitted: boolean;
  observedAt?: string;
}

export class SessionReadError extends Error {
  constructor(readonly kind: "unauthorized" | "unavailable" | "conflict" | "invalid") { super("Session data is unavailable"); }
}

type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every((key) => keys.includes(key));
const timestamp = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value));
const optionalID = (value: unknown) => value === undefined || isHostHarnessSessionId(value);

function sameIdentity(left: HostHarnessSession, right: HostHarnessSession) {
  return left.hostHarnessSessionId === right.hostHarnessSessionId && left.nodeId === right.nodeId
    && left.harnessId === right.harnessId && left.providerSessionId === right.providerSessionId
    && left.workspace === right.workspace && right.revision === left.revision;
}

async function body(response: Response) {
  if (response.status === 401 || response.status === 403) throw new SessionReadError("unauthorized");
  if (response.status === 409) throw new SessionReadError("conflict");
  if (!response.ok) throw new SessionReadError("unavailable");
  try { return await response.json() as unknown; } catch { throw new SessionReadError("invalid"); }
}

export function parseHostSessionList(value: unknown, afterCursor?: string): HostSessionListResponse {
  if (!record(value) || !onlyKeys(value, ["sessions", "total", "revision", "nextCursor"]) || !Array.isArray(value.sessions)
    || value.sessions.length > hostHarnessSessionLimits.sessionsPerInventoryPage || !Number.isSafeInteger(value.total)
    || (value.total as number) < value.sessions.length || (value.total as number) > hostHarnessSessionLimits.sessionsGlobal
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || (value.nextCursor !== undefined && !isHostHarnessSessionId(value.nextCursor))) {
    throw new SessionReadError("invalid");
  }
  const sessions: HostHarnessSession[] = [];
  const identities = new Set<string>();
  for (const candidate of value.sessions) {
    const validated = validateHostHarnessSession(candidate);
    if (!validated.ok || identities.has(validated.value.hostHarnessSessionId)) throw new SessionReadError("invalid");
    identities.add(validated.value.hostHarnessSessionId);
    sessions.push(validated.value);
  }
  for (let index = 0; index < sessions.length; index += 1) {
    const previous = index === 0 ? afterCursor : sessions[index - 1]!.hostHarnessSessionId;
    if (previous !== undefined && sessions[index]!.hostHarnessSessionId <= previous) throw new SessionReadError("invalid");
  }
  if (value.nextCursor !== undefined
    && (sessions.length === 0 || value.nextCursor !== sessions.at(-1)!.hostHarnessSessionId)) throw new SessionReadError("invalid");
  return { sessions, total: value.total as number, revision: value.revision as number,
    ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor as string }) };
}

export async function listHostSessions(apiFetch: ApiFetch, revision?: number, cursor?: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: String(hostHarnessSessionLimits.sessionsPerInventoryPage) });
  if (revision !== undefined) query.set("revision", String(revision));
  if (cursor !== undefined) query.set("cursor", cursor);
  return parseHostSessionList(await apiFetch(`/api/host-sessions?${query}`, { signal }).then(body), cursor);
}

export async function listAllHostSessions(apiFetch: ApiFetch, expectedRevision?: number, signal?: AbortSignal) {
  let requestedRevision = expectedRevision;
  for (let restart = 0; restart < 3; restart += 1) {
    const sessions: HostHarnessSession[] = [];
    let cursor: string | undefined;
    let revision = requestedRevision;
    const maximumPages = Math.ceil(hostHarnessSessionLimits.sessionsGlobal / hostHarnessSessionLimits.sessionsPerInventoryPage);
    try {
      for (let pageIndex = 0; pageIndex < maximumPages; pageIndex += 1) {
        const page = await listHostSessions(apiFetch, revision, cursor, signal);
        revision = Math.max(revision ?? 0, page.revision);
        sessions.push(...page.sessions);
        if (page.nextCursor === undefined) {
          return { sessions, total: sessions.length, revision };
        }
        cursor = page.nextCursor;
      }
      throw new SessionReadError("invalid");
    } catch (error) {
      if (!(error instanceof SessionReadError) || error.kind !== "conflict" || restart === 2) throw error;
      requestedRevision = undefined;
    }
  }
  throw new SessionReadError("invalid");
}

export function parseHostSessionDetail(value: unknown, expected: HostHarnessSession): HostSessionDetailResponse {
  if (!record(value) || !onlyKeys(value, ["session", "links"]) || !record(value.links) || !onlyKeys(value.links, ["threadId", "runId"])) {
    throw new SessionReadError("invalid");
  }
  const session = validateHostHarnessSession(value.session);
  if (!session.ok || !sameIdentity(expected, session.value) || !optionalID(value.links.threadId) || !optionalID(value.links.runId)
    || value.links.threadId !== session.value.attachedThreadId || value.links.runId !== session.value.activeRunId) throw new SessionReadError("invalid");
  return { session: session.value, links: value.links as HostSessionDetailResponse["links"] };
}

export function parseHostSessionHistory(value: unknown, expected: HostHarnessSession): HostSessionHistoryResponse {
  const keys = ["hostHarnessSessionId", "nodeId", "harnessId", "providerSessionId", "workspace", "revision", "stale", "items", "nextCursor", "truncated", "omitted", "observedAt"];
  if (!record(value) || !onlyKeys(value, keys) || !Array.isArray(value.items)
    || value.items.length > hostHarnessSessionLimits.historyItemsPerPage || !value.items.every(validateHostHarnessSessionHistoryItem)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || (value.revision as number) > expected.revision
    || typeof value.stale !== "boolean" || value.stale !== (value.revision !== expected.revision)
    || typeof value.truncated !== "boolean" || typeof value.omitted !== "boolean"
    || (value.nextCursor !== undefined && (typeof value.nextCursor !== "string" || value.nextCursor.length > hostHarnessSessionLimits.historyCursorBytes))
    || (value.observedAt !== undefined && !timestamp(value.observedAt))) throw new SessionReadError("invalid");
  if (value.hostHarnessSessionId !== expected.hostHarnessSessionId || value.nodeId !== expected.nodeId
    || value.harnessId !== expected.harnessId || value.providerSessionId !== expected.providerSessionId
    || value.workspace !== expected.workspace) throw new SessionReadError("invalid");
  return value as unknown as HostSessionHistoryResponse;
}

export async function readHostSession(apiFetch: ApiFetch, expected: HostHarnessSession, signal?: AbortSignal) {
  const id = encodeURIComponent(expected.hostHarnessSessionId);
  const [detailValue, historyValue] = await Promise.all([
    apiFetch(`/api/host-sessions/${id}`, { signal }).then(body),
    apiFetch(`/api/host-sessions/${id}/history`, { signal }).then(body)
  ]);
  return { detail: parseHostSessionDetail(detailValue, expected), history: parseHostSessionHistory(historyValue, expected) };
}
