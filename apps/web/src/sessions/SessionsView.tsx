import { CaretDown, MagnifyingGlass, Monitor, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { HostHarnessSession, Snapshot } from "@coffee-shop/protocol";
import type { ConnectionStatus } from "../hubConnection.js";
import { listAllHostSessions, readHostSession, SessionReadError, type HostSessionDetailResponse, type HostSessionHistoryResponse } from "./sessionReadApi.js";
import { buildSessionsReadModel, emptySessionFilters, type SessionFilters, type SessionsReadModel } from "./sessionReadModel.js";
import { SessionDetail } from "./SessionDetail.js";
import "./sessions.css";

type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;
type Slot = (model: SessionsReadModel) => ReactNode;

const title = (value: string) => value.replaceAll("-", " ");

function FilterMenu({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return <details className="session-filter"><summary>{value ? title(value) : label}<CaretDown size={12} /></summary><div role="menu"><button role="menuitem" onClick={() => onChange("")}>All {label.toLowerCase()}</button>{options.map((option) => <button role="menuitem" key={option} onClick={() => onChange(option)}>{title(option)}</button>)}</div></details>;
}

export function SessionsView({ snapshot, connection, apiFetch, selectedId, onSelect, onOpenThread, onInspectRun, adoptSlot, selectedControlsSlot }: {
  snapshot: Snapshot;
  connection: ConnectionStatus;
  apiFetch: ApiFetch;
  selectedId?: string;
  onSelect: (id?: string, options?: { replace?: boolean }) => void;
  onOpenThread?: (id: string) => void;
  onInspectRun?: (id: string) => void;
  adoptSlot?: Slot;
  selectedControlsSlot?: Slot;
}) {
  const [filters, setFilters] = useState<SessionFilters>(emptySessionFilters);
  const [detail, setDetail] = useState<HostSessionDetailResponse>();
  const [history, setHistory] = useState<HostSessionHistoryResponse>();
  const [readState, setReadState] = useState<"idle" | "loading" | "unavailable">("idle");
  const [listedSessions, setListedSessions] = useState<HostHarnessSession[] | undefined>(snapshot.hostHarnessSessions);
  const [listTotal, setListTotal] = useState(snapshot.hostHarnessSessions?.length ?? 0);
  const [listState, setListState] = useState<"idle" | "loading" | "unavailable">(
    snapshot.hostHarnessSessions === undefined || snapshot.hostHarnessSessions.length > 0 ? "idle" : "loading"
  );
  const requestGeneration = useRef(0);
  const previousSelected = useRef<string | undefined>(undefined);
  const listController = useRef<AbortController | undefined>(undefined);
  const listTimer = useRef<number | undefined>(undefined);
  const listRefreshWindowStarted = useRef<number | undefined>(undefined);
  const latestInventoryRevision = useRef(snapshot.hostSessionInventoryRevision);
  const loadedInventoryRevision = useRef<number | undefined>(undefined);
  const snapshotSource = snapshot.hostHarnessSessions;
  const source = listedSessions;
  const selectedSummary = source?.find((session) => session.hostHarnessSessionId === selectedId);
  const embeddedInventory = snapshotSource !== undefined && snapshotSource.length > 0;
  const inventoryRefreshKey = embeddedInventory ? snapshot.generatedAt : snapshot.hostSessionInventoryRevision;
  latestInventoryRevision.current = snapshot.hostSessionInventoryRevision;

  useEffect(() => {
    if (listTimer.current !== undefined) window.clearTimeout(listTimer.current);
    if (snapshotSource === undefined || connection === "authentication-required") {
      listController.current?.abort(); listController.current = undefined;
      setListedSessions(snapshotSource); setListTotal(0); setListState("idle");
      return;
    }
    if (snapshotSource.length > 0) {
      listController.current?.abort(); listController.current = undefined;
      setListedSessions(snapshotSource); setListTotal(snapshotSource.length); setListState("idle");
      return;
    }
    if (connection !== "connected") {
      setListState("idle");
      return;
    }
    if (listedSessions !== undefined && loadedInventoryRevision.current === snapshot.hostSessionInventoryRevision) return;
    if (listController.current) return;
    listRefreshWindowStarted.current ??= Date.now();
    const elapsed = Date.now() - listRefreshWindowStarted.current;
    const delay = Math.min(150, Math.max(0, 1_000 - elapsed));
    listTimer.current = window.setTimeout(() => {
      listTimer.current = undefined;
      listRefreshWindowStarted.current = undefined;
      const controller = new AbortController();
      listController.current = controller;
      const refresh = async (revision?: number): Promise<void> => {
        setListState("loading");
        try {
          const result = await listAllHostSessions(apiFetch, revision, controller.signal);
          if (controller.signal.aborted) return;
          loadedInventoryRevision.current = result.revision;
          setListedSessions(result.sessions); setListTotal(result.total); setListState("idle");
        } catch {
          if (!controller.signal.aborted) setListState("unavailable");
        }
      };
      void refresh(latestInventoryRevision.current).finally(() => {
        if (listController.current === controller) listController.current = undefined;
      });
    }, delay);
    return () => {
      if (listTimer.current !== undefined) window.clearTimeout(listTimer.current);
    };
  }, [apiFetch, connection, inventoryRefreshKey, embeddedInventory, snapshotSource === undefined]);

  useEffect(() => () => {
    listController.current?.abort();
    if (listTimer.current !== undefined) window.clearTimeout(listTimer.current);
  }, [apiFetch, connection, embeddedInventory, snapshotSource === undefined]);

  useEffect(() => {
    if (selectedId && source && !selectedSummary && listState !== "loading") onSelect(undefined, { replace: true });
  }, [selectedId, source, selectedSummary, listState, onSelect]);

  useEffect(() => {
    const generation = ++requestGeneration.current;
    const controller = new AbortController();
    setDetail(undefined);
    setHistory(undefined);
    if (!selectedSummary || connection === "authentication-required") { setReadState("idle"); return () => controller.abort(); }
    setReadState("loading");
    void readHostSession(apiFetch, selectedSummary, controller.signal).then((result) => {
      if (requestGeneration.current !== generation) return;
      setDetail(result.detail); setHistory(result.history); setReadState("idle");
    }).catch((error: unknown) => {
      if (controller.signal.aborted || requestGeneration.current !== generation) return;
      if (error instanceof SessionReadError && error.kind === "unauthorized") { setDetail(undefined); setHistory(undefined); }
      setReadState("unavailable");
    });
    return () => controller.abort();
  }, [apiFetch, connection, selectedSummary?.hostHarnessSessionId, selectedSummary?.revision]);

  const displaySnapshot = useMemo(() => ({ ...snapshot, hostHarnessSessions: source }), [snapshot, source]);
  const model = useMemo(() => buildSessionsReadModel({ snapshot: displaySnapshot, connection, filters, selectedId, detail, history }), [displaySnapshot, connection, filters, selectedId, detail, history]);
  const values = <K extends keyof Pick<HostHarnessSession, "nodeId" | "harnessId" | "workspace" | "source" | "status" | "controlMode">>(key: K) => [...new Set((source ?? []).map((session) => session[key]))].sort();
  function select(id: string) { previousSelected.current = id; onSelect(id); }
  function back() {
    const target = previousSelected.current;
    onSelect(undefined);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-session-id="${CSS.escape(target ?? "")}"]`)?.focus());
  }

  if (!model.available) return <main className="sessions-unavailable"><Monitor size={24} /><h1>Sessions unavailable</h1><p>This Hub has not published the validated host-session inventory.</p></main>;
  if (model.selected) return <main className="sessions-view session-selected"><SessionDetail model={model} loading={readState === "loading"} unavailable={readState === "unavailable"} onBack={back} onOpenThread={onOpenThread} onInspectRun={onInspectRun} controls={selectedControlsSlot?.(model)} /></main>;

  return (
    <main className="sessions-view">
      <header className="sessions-header">
        <div><span className="session-eyebrow">Provider-neutral inventory</span><h1>Sessions</h1><p>Existing harness threads visible through registered Barista hosts.</p></div>
        <div className="sessions-count"><strong>{model.sessions.length}</strong><span>of {listTotal}</span></div>
      </header>
      <div className="sessions-live-region" aria-live="polite">{model.stale ? "Showing last known session inventory." : "Session inventory is current."}</div>
      {model.stale && <div className="sessions-stale" role="status"><WarningCircle size={15} /><span><strong>Last known inventory</strong> Reconnect to refresh host evidence.</span></div>}
      <section className="sessions-toolbar" aria-label="Session filters">
        <label className="sessions-search"><MagnifyingGlass size={15} /><input value={filters.query} onChange={(event) => setFilters({ ...filters, query: event.target.value })} placeholder="Search sessions" /></label>
        <div className="sessions-filters">
          <FilterMenu label="Nodes" value={filters.nodeId} options={values("nodeId")} onChange={(nodeId) => setFilters({ ...filters, nodeId })} />
          <FilterMenu label="Harnesses" value={filters.harnessId} options={values("harnessId")} onChange={(harnessId) => setFilters({ ...filters, harnessId })} />
          <FilterMenu label="Workspaces" value={filters.workspace} options={values("workspace")} onChange={(workspace) => setFilters({ ...filters, workspace })} />
          <FilterMenu label="Sources" value={filters.source} options={values("source")} onChange={(sourceValue) => setFilters({ ...filters, source: sourceValue })} />
          <FilterMenu label="Statuses" value={filters.status} options={values("status")} onChange={(status) => setFilters({ ...filters, status })} />
          <FilterMenu label="Control" value={filters.controlMode} options={values("controlMode")} onChange={(controlMode) => setFilters({ ...filters, controlMode })} />
        </div>
      </section>
      {listState === "unavailable" && model.sessions.length === 0
        ? <section className="sessions-empty"><h2>Session inventory unavailable</h2><p>The bounded inventory route could not be read. Reconnect and try again.</p></section>
        : model.sessions.length === 0 ? <section className="sessions-empty"><h2>{listState === "loading" ? "Loading sessions" : "No matching sessions"}</h2><p>{listState === "loading" ? "Reading the validated host inventory." : "Adjust the inventory filters or wait for a protocol-v6 Barista report."}</p></section> : (
        <section className="sessions-list" aria-label="Host sessions">
          <div className="sessions-list-head"><span>Session</span><span>Host</span><span>Authority</span><span>Updated</span></div>
          {model.sessions.map((session) => (
            <div className="session-row-shell" key={session.hostHarnessSessionId}>
              <button className="session-row" data-session-id={session.hostHarnessSessionId} onClick={() => select(session.hostHarnessSessionId)}>
                <span className="session-row-primary"><strong>{session.summary || "Untitled provider session"}</strong><code>{session.workspace}</code></span>
                <span><strong>{snapshot.nodes.find((node) => node.id === session.nodeId)?.name ?? session.nodeId}</strong><small>{session.harnessId} · {title(session.source)}</small></span>
                <span><span className={`session-status status-${session.status}`}><i />{title(session.status)}</span><small>{title(session.controlMode)} · {session.operations.length} operations</small></span>
                <time>{new Date(session.updatedAt).toLocaleString()}</time>
              </button>
              {adoptSlot && <div className="session-row-slot">{adoptSlot(buildSessionsReadModel({ snapshot, connection, filters, selectedId: session.hostHarnessSessionId }))}</div>}
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
