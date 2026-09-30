import {
  hostHarnessSessionLimits,
  hostHarnessSessionSources,
  hostHarnessSessionStatuses,
  type HostHarnessSession
} from "@coffee-shop/protocol";
import type { Express, Request, Response } from "express";
import { hostSessionHistoryFor } from "./hostSessionHistory.js";
import { publicHostHarnessSession, type Store } from "./store.js";

const maximumPageSize = 100;
const defaultPageSize = 50;

export interface HostSessionReadRouteDependencies {
  store: Store;
}

const singleQuery = (request: Request, name: string): string | undefined | null => {
  const value = request.query[name];
  return value === undefined ? undefined : typeof value === "string" ? value : null;
};

const boundedQuery = (request: Request, name: string): string | undefined | null => {
  const value = singleQuery(request, name);
  return value === undefined || value === null ? value
    : value.length > 0 && Buffer.byteLength(value, "utf8") <= hostHarnessSessionLimits.identifierBytes ? value : null;
};

const pageLimit = (request: Request): number | undefined => {
  const raw = singleQuery(request, "limit");
  if (raw === null) return undefined;
  if (raw === undefined) return defaultPageSize;
  if (!/^[1-9]\d*$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed <= maximumPageSize ? parsed : undefined;
};

/** Snapshot/list projection deliberately omits provider identity and the machine-local workspace. */
export const publicHostSessionSummary = (session: HostHarnessSession) => ({
  hostHarnessSessionId: session.hostHarnessSessionId,
  nodeId: session.nodeId,
  harnessId: session.harnessId,
  source: session.source,
  status: session.status,
  controlMode: session.controlMode,
  operations: [...session.operations],
  revision: session.revision,
  ...(session.providerTurnId === undefined ? {} : { providerTurnId: session.providerTurnId }),
  ...(session.summary === undefined ? {} : { summary: session.summary }),
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  ...(session.attachedThreadId === undefined ? {} : { attachedThreadId: session.attachedThreadId }),
  ...(session.activeRunId === undefined ? {} : { activeRunId: session.activeRunId }),
  attachmentEpoch: session.attachmentEpoch
});

const invalidQuery = (response: Response) => response.status(400).json({ error: "Invalid host session query" });

/** Registers read-only routes behind the caller's existing operator bearer middleware. */
export function registerHostSessionReadRoutes(app: Express, { store }: HostSessionReadRouteDependencies) {
  app.get("/api/host-sessions", (request, response) => {
    const limit = pageLimit(request);
    const cursor = boundedQuery(request, "cursor");
    const nodeId = boundedQuery(request, "nodeId");
    const harnessId = boundedQuery(request, "harnessId");
    const status = singleQuery(request, "status");
    const source = singleQuery(request, "source");
    if (limit === undefined || cursor === null || nodeId === null || harnessId === null || status === null || source === null
      || (status !== undefined && !(hostHarnessSessionStatuses as readonly string[]).includes(status))
      || (source !== undefined && !(hostHarnessSessionSources as readonly string[]).includes(source))) return invalidQuery(response);
    const sessions = store.read((state) => [...(state.hostHarnessSessions ?? [])]
      .filter((session) => nodeId === undefined || session.nodeId === nodeId)
      .filter((session) => harnessId === undefined || session.harnessId === harnessId)
      .filter((session) => status === undefined || session.status === status)
      .filter((session) => source === undefined || session.source === source)
      .sort((left, right) => left.hostHarnessSessionId.localeCompare(right.hostHarnessSessionId)));
    const start = cursor === undefined ? 0 : sessions.findIndex((session) => session.hostHarnessSessionId === cursor) + 1;
    if (cursor !== undefined && start === 0) return invalidQuery(response);
    const page = sessions.slice(start, start + limit);
    const hasMore = start + page.length < sessions.length;
    response.json({
      sessions: page.map(publicHostSessionSummary),
      ...(hasMore ? { nextCursor: page.at(-1)!.hostHarnessSessionId } : {})
    });
  });

  app.get("/api/host-sessions/:id/history", (request, response) => {
    const limit = pageLimit(request);
    const cursor = boundedQuery(request, "cursor");
    if (limit === undefined || cursor === null) return invalidQuery(response);
    const result = store.read((state) => {
      const session = state.hostHarnessSessions?.find((item) => item.hostHarnessSessionId === request.params.id);
      if (!session) return undefined;
      const history = hostSessionHistoryFor(state, session.hostHarnessSessionId);
      const items = history?.items ?? [];
      const start = cursor === undefined ? 0 : items.findIndex((item) => item.id === cursor) + 1;
      if (cursor !== undefined && start === 0) return { invalid: true as const };
      const page = items.slice(start, start + limit);
      const hasMore = start + page.length < items.length;
      return {
        invalid: false as const,
        response: {
          hostHarnessSessionId: session.hostHarnessSessionId,
          items: structuredClone(page),
          ...(hasMore ? { nextCursor: page.at(-1)!.id } : {}),
          ...(history?.cursor === undefined ? {} : { providerCursor: history.cursor }),
          truncated: history?.truncated ?? false,
          omittedItems: history?.omittedItems ?? 0
        }
      };
    });
    if (!result) return response.status(404).json({ error: "Host session not found" });
    if (result.invalid) return invalidQuery(response);
    response.json(result.response);
  });

  app.get("/api/host-sessions/:id", (request, response) => {
    const session = store.read((state) => state.hostHarnessSessions
      ?.find((item) => item.hostHarnessSessionId === request.params.id));
    if (!session) return response.status(404).json({ error: "Host session not found" });
    response.json({ session: publicHostHarnessSession(session) });
  });
}
