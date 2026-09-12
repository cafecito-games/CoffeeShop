import { timelineEventTypes, type Agent, type TimelineEvent, type TimelineEventType } from "@coffee-shop/protocol";
import { Cpu, Pulse as Activity, SlidersHorizontal, TerminalWindow, UsersThree, X } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { AccessibleDialog } from "./AccessibleDialog.js";

const eventTypeLabels: Record<TimelineEventType, string> = {
  run: "Run",
  status: "Status",
  handoff: "Handoff",
  node: "Node",
  message: "Message"
};

function timeAgo(date: string) {
  const seconds = Math.max(1, Math.round((Date.now() - new Date(date).getTime()) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function isAssociatedWith(event: TimelineEvent, agentId: string) {
  return event.agentId === agentId || event.fromAgentId === agentId || event.toAgentId === agentId;
}

function TimelineEmpty({ filtered }: { filtered: boolean }) {
  return (
    <div className="timeline-empty" role="status">
      <Activity size={22} />
      <strong>{filtered ? "No activity matches these filters" : "No activity yet"}</strong>
      <p>{filtered ? "Try another event type or agent, or clear all filters." : "Events will appear here as agents and compute nodes begin working."}</p>
    </div>
  );
}

export function ActivityView({ events, agents, onInspectRun }: { events: TimelineEvent[]; agents: Agent[]; onInspectRun: (id: string) => void }) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedTypes, setSelectedTypes] = useState<Set<TimelineEventType>>(() => new Set());
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const activeCount = selectedTypes.size + (selectedAgentId ? 1 : 0);
  const filteredEvents = useMemo(() => events.filter((event) => {
    const typeMatches = selectedTypes.size === 0 || selectedTypes.has(event.type);
    const agentMatches = !selectedAgentId || isAssociatedWith(event, selectedAgentId);
    return typeMatches && agentMatches;
  }), [events, selectedAgentId, selectedTypes]);
  const names = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents]);

  function toggleType(type: TimelineEventType) {
    setSelectedTypes((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  function clearFilters() {
    setSelectedTypes(new Set());
    setSelectedAgentId("");
  }

  return (
    <main className="utility-view">
      <header className="utility-header">
        <div><small>Across every harness and machine</small><h1>Activity</h1></div>
        <button
          className={`filter-btn ${activeCount ? "active" : ""}`}
          aria-label={`Filter activity${activeCount ? `, ${activeCount} active` : ""}`}
          aria-haspopup="dialog"
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen(true)}
        >
          <SlidersHorizontal size={16} /> Filter {activeCount > 0 && <span className="filter-count">{activeCount}</span>}
        </button>
      </header>
      <div className="timeline-summary" aria-live="polite">{activeCount ? `${filteredEvents.length} of ${events.length} events` : `${events.length} ${events.length === 1 ? "event" : "events"}`}</div>
      {filteredEvents.length > 0 ? (
        <div className="timeline">
          {filteredEvents.map((event, index) => (
            <article key={event.id} data-testid="timeline-event" className={`timeline-event event-${event.type}`}>
              <div className="timeline-rail"><span>{event.type === "handoff" ? <UsersThree size={15} /> : event.type === "node" ? <Cpu size={15} /> : <Activity size={15} />}</span>{index < filteredEvents.length - 1 && <i />}</div>
              <div>
                <div className="event-heading"><strong>{event.title}</strong><time>{timeAgo(event.createdAt)}</time></div>
                <p>{event.detail}</p>
                {event.fromAgentId && <small>{names.get(event.fromAgentId) ?? event.fromAgentId} handed work to {names.get(event.toAgentId ?? "") ?? event.toAgentId}</small>}
                {event.runId && <button className="run-link" onClick={() => onInspectRun(event.runId!)}><TerminalWindow size={14} /> Inspect run</button>}
              </div>
            </article>
          ))}
        </div>
      ) : <TimelineEmpty filtered={activeCount > 0} />}
      {filtersOpen && (
        <AccessibleDialog labelledBy="activity-filter-title" onClose={() => setFiltersOpen(false)} className="activity-filter-dialog">
          <header>
            <div><small>Timeline controls</small><h2 id="activity-filter-title">Filter activity</h2></div>
            <button className="icon-btn" aria-label="Close activity filters" onClick={() => setFiltersOpen(false)} data-dialog-initial-focus><X size={17} /></button>
          </header>
          <fieldset>
            <legend>Event types <small>Select any that apply</small></legend>
            <div className="activity-type-options">
              {timelineEventTypes.map((type) => (
                <label key={type}><input type="checkbox" checked={selectedTypes.has(type)} onChange={() => toggleType(type)} /><span>{eventTypeLabels[type]}</span></label>
              ))}
            </div>
          </fieldset>
          <label className="activity-agent-filter">Agent<select aria-label="Agent" value={selectedAgentId} onChange={(event) => setSelectedAgentId(event.target.value)}><option value="">All agents</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
          <footer><span>{activeCount ? `${activeCount} active` : "Showing everything"}</span><button onClick={clearFilters} disabled={!activeCount} aria-label="Clear all filters">Clear all</button></footer>
        </AccessibleDialog>
      )}
    </main>
  );
}
