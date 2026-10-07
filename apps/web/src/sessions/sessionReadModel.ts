import type {
  ApprovalRequest, ComputeNode, HostHarnessSession, HostHarnessSessionHistoryItem, Run, RunActivity, Snapshot, Thread
} from "@coffee-shop/protocol";
import type { ConnectionStatus } from "../hubConnection.js";
import type { HostSessionDetailResponse, HostSessionHistoryResponse } from "./sessionReadApi.js";

export interface SessionFilters {
  query: string;
  nodeId: string;
  harnessId: string;
  workspace: string;
  source: string;
  status: string;
  controlMode: string;
}

export interface SessionsReadModel {
  available: boolean;
  stale: boolean;
  sessions: HostHarnessSession[];
  selected?: HostHarnessSession;
  detail?: HostSessionDetailResponse;
  history?: HostSessionHistoryResponse;
  thread?: Thread;
  run?: Run;
  activity: RunActivity[];
  approvals: ApprovalRequest[];
  nodes: ComputeNode[];
  historyItems: HostHarnessSessionHistoryItem[];
  controls: { adopt?: never; selected?: never };
}

export const emptySessionFilters = (): SessionFilters => ({ query: "", nodeId: "", harnessId: "", workspace: "", source: "", status: "", controlMode: "" });

function detailMatches(session: HostHarnessSession, detail?: HostSessionDetailResponse) {
  const candidate = detail?.session;
  return candidate !== undefined && candidate.hostHarnessSessionId === session.hostHarnessSessionId
    && candidate.nodeId === session.nodeId && candidate.harnessId === session.harnessId
    && candidate.providerSessionId === session.providerSessionId && candidate.workspace === session.workspace
    && candidate.revision === session.revision;
}

function historyMatches(session: HostHarnessSession, history?: HostSessionHistoryResponse) {
  return history !== undefined && history.hostHarnessSessionId === session.hostHarnessSessionId
    && history.nodeId === session.nodeId && history.harnessId === session.harnessId
    && history.providerSessionId === session.providerSessionId && history.workspace === session.workspace
    && history.revision <= session.revision && history.stale === (history.revision !== session.revision);
}

export function buildSessionsReadModel(input: {
  snapshot: Snapshot;
  connection: ConnectionStatus;
  filters: SessionFilters;
  selectedId?: string;
  detail?: HostSessionDetailResponse;
  history?: HostSessionHistoryResponse;
}): SessionsReadModel {
  const source = input.snapshot.hostHarnessSessions;
  if (source === undefined) return { available: false, stale: input.connection !== "connected", sessions: [], activity: [], approvals: [], nodes: input.snapshot.nodes, historyItems: [], controls: {} };
  const needle = input.filters.query.trim().toLocaleLowerCase();
  const sessions = [...source].filter((session) => !needle || [session.summary, session.hostHarnessSessionId, session.nodeId, session.workspace].some((value) => value?.toLocaleLowerCase().includes(needle)))
    .filter((session) => !input.filters.nodeId || session.nodeId === input.filters.nodeId)
    .filter((session) => !input.filters.harnessId || session.harnessId === input.filters.harnessId)
    .filter((session) => !input.filters.workspace || session.workspace === input.filters.workspace)
    .filter((session) => !input.filters.source || session.source === input.filters.source)
    .filter((session) => !input.filters.status || session.status === input.filters.status)
    .filter((session) => !input.filters.controlMode || session.controlMode === input.filters.controlMode)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.hostHarnessSessionId.localeCompare(right.hostHarnessSessionId));
  const selected = source.find((session) => session.hostHarnessSessionId === input.selectedId);
  const detail = selected && detailMatches(selected, input.detail) ? input.detail : undefined;
  const history = selected && historyMatches(selected, input.history) ? input.history : undefined;
  const thread = detail?.links.threadId ? input.snapshot.threads?.find((item) => item.id === detail.links.threadId) : undefined;
  const run = detail?.links.runId ? input.snapshot.runs.find((item) => item.id === detail.links.runId) : undefined;
  return {
    available: true, stale: input.connection !== "connected", sessions, selected, detail, history, thread, run,
    activity: run ? (input.snapshot.runActivity ?? []).filter((item) => item.runId === run.id) : [],
    approvals: run ? (input.snapshot.approvals ?? []).filter((item) => item.runId === run.id) : [],
    nodes: input.snapshot.nodes, historyItems: history ? [...history.items].reverse() : [], controls: {}
  };
}
