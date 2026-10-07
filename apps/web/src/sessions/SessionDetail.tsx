import { ArrowLeft, ArrowSquareOut, ClockCounterClockwise, LinkSimple, WarningCircle } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { RunActivityPanel } from "../orchestration/RunActivityPanel.js";
import type { SessionsReadModel } from "./sessionReadModel.js";

const label = (value: string) => value.replaceAll("-", " ");
const timestamp = (value?: string) => value ? new Date(value).toLocaleString() : "Not reported";

export function SessionDetail({ model, loading, unavailable, onBack, onOpenThread, onInspectRun, controls }: {
  model: SessionsReadModel;
  loading: boolean;
  unavailable: boolean;
  onBack: () => void;
  onOpenThread?: (id: string) => void;
  onInspectRun?: (id: string) => void;
  controls?: ReactNode;
}) {
  const session = model.selected;
  if (!session) return null;
  const nodeName = model.nodes.find((node) => node.id === session.nodeId)?.name ?? session.nodeId;
  return (
    <article className="session-detail" aria-labelledby="session-detail-title">
      <header className="session-detail-header">
        <button className="session-back" onClick={onBack}><ArrowLeft size={16} /> Sessions</button>
        <div>
          <span className="session-eyebrow">{session.harnessId} · {nodeName}</span>
          <h1 id="session-detail-title">{session.summary || "Untitled provider session"}</h1>
          <p>Read-only provider history and Coffee Shop activity remain separate.</p>
        </div>
        {controls}
      </header>

      <div className="session-state-strip" role="status">
        <span className={`session-status status-${session.status}`}><i />{label(session.status)}</span>
        <span>{label(session.controlMode)} control</span>
        {model.stale && <span className="session-stale"><WarningCircle size={14} /> Last known evidence</span>}
      </div>

      <section className="session-facts" aria-label="Session identity">
        <dl>
          <div><dt>Coffee Shop ID</dt><dd><code>{session.hostHarnessSessionId}</code></dd></div>
          <div><dt>Provider ID</dt><dd><code>{session.providerSessionId}</code></dd></div>
          <div><dt>Workspace</dt><dd><code>{session.workspace}</code></dd></div>
          <div><dt>Provenance</dt><dd>{label(session.source)}</dd></div>
          <div><dt>Attachment epoch</dt><dd className="tabular">{session.attachmentEpoch}</dd></div>
          <div><dt>Revision</dt><dd className="tabular">{session.revision}</dd></div>
          <div><dt>Observed</dt><dd>{timestamp(session.updatedAt)}</dd></div>
          <div><dt>Created</dt><dd>{timestamp(session.createdAt)}</dd></div>
        </dl>
      </section>

      <section className="session-section" aria-labelledby="session-capabilities-title">
        <div className="session-section-heading"><div><span>Authority</span><h2 id="session-capabilities-title">Advertised operations</h2></div></div>
        <div className="session-operation-list">{session.operations.length > 0 ? session.operations.map((operation) => <span key={operation}>{label(operation)}</span>) : <em>No operations reported</em>}</div>
        <p className="session-caption">Displayed as host evidence only. This view does not issue session commands.</p>
      </section>

      <section className="session-section" aria-labelledby="session-links-title">
        <div className="session-section-heading"><div><span>Coffee Shop</span><h2 id="session-links-title">Current activity</h2></div></div>
        <div className="session-linked-records">
          {model.thread && <button onClick={() => onOpenThread?.(model.thread!.id)}><LinkSimple size={15} /><span><small>Thread</small>{model.thread.title}</span><ArrowSquareOut size={14} /></button>}
          {model.run && <button onClick={() => onInspectRun?.(model.run!.id)}><LinkSimple size={15} /><span><small>Run</small>{model.run.id} · {model.run.status}</span><ArrowSquareOut size={14} /></button>}
          {!model.thread && !model.run && <p className="session-empty-inline">No canonical Coffee Shop Thread or Run is linked.</p>}
        </div>
        {(model.activity[0] || model.approvals.length > 0) && <RunActivityPanel activity={model.activity[0]} approvals={model.approvals} />}
      </section>

      <section className="session-section session-history" aria-labelledby="session-history-title">
        <div className="session-section-heading"><div><span>Imported evidence</span><h2 id="session-history-title">Provider history</h2></div><ClockCounterClockwise size={18} /></div>
        {loading && <p className="session-loading" role="status">Loading bounded history…</p>}
        {unavailable && <p className="session-unavailable" role="status">Session detail is unavailable. Inventory evidence is still shown above.</p>}
        {!loading && !unavailable && model.history?.stale && <p className="session-unavailable">Showing history from an earlier session revision while the host refreshes it.</p>}
        {!loading && !unavailable && model.history?.omitted && <p className="session-unavailable">History was omitted by the host.</p>}
        {!loading && !unavailable && model.historyItems.length === 0 && !model.history?.omitted && <p className="session-empty-inline">No imported history is available.</p>}
        {!loading && !unavailable && model.historyItems.map((item) => (
          <article className={`session-history-item history-${item.kind}`} key={item.id}>
            <header><strong>{item.kind}</strong>{item.at && <time>{timestamp(item.at)}</time>}</header>
            <p>{item.text}</p>
            {item.truncated && <small>Item truncated by the host</small>}
          </article>
        ))}
        {!loading && !unavailable && (model.history?.truncated || model.history?.nextCursor) && <div className="session-truncation"><WarningCircle size={14} /> Showing a bounded history extent; additional provider history is not displayed.</div>}
      </section>
    </article>
  );
}
