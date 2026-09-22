import type { ApprovalRequest, HarnessSessionBinding, RunActivity, RunTransportSelection } from "@coffee-shop/protocol";
import { approvalStatusLabels, timeAgo, toolCallKindLabels, toolCallStatusLabels } from "./orchestrationLabels.js";

function BoundedBlock({ label, text, truncatedBytes }: { label: string; text: string; truncatedBytes: number }) {
  if (!text && truncatedBytes === 0) return null;
  return (
    <section className="run-text">
      <h3>{label}{truncatedBytes > 0 && <span className="truncation-note"> · {truncatedBytes} earlier bytes truncated</span>}</h3>
      <pre>{text || "(empty)"}</pre>
    </section>
  );
}

const streamStatusLabels: Record<RunActivity["streamStatus"], string> = { open: "Streaming", closed: "Closed", failed: "Failed" };

export function RunActivityPanel({ activity, transportSelection, sessionBinding, approvals }: {
  activity?: RunActivity;
  transportSelection?: RunTransportSelection;
  sessionBinding?: HarnessSessionBinding;
  approvals: ApprovalRequest[];
}) {
  if (!activity && !transportSelection && approvals.length === 0) return null;
  return (
    <section className="run-activity">
      {(transportSelection || sessionBinding) && (
        <div className="run-activity-transport">
          <h3>Transport</h3>
          <dl className="run-details">
            {transportSelection && <div><dt>Requested / selected</dt><dd>{transportSelection.requestedTransport} → {transportSelection.selectedTransport}</dd></div>}
            {transportSelection?.fallbackReason && <div><dt>Fallback reason</dt><dd>{transportSelection.fallbackReason}</dd></div>}
            {transportSelection?.adapter && <div><dt>Adapter</dt><dd>{transportSelection.adapter.id} {transportSelection.adapter.version} · {transportSelection.adapter.source}</dd></div>}
            {transportSelection?.harnessVersion && <div><dt>Harness version</dt><dd>{transportSelection.harnessVersion}</dd></div>}
            {sessionBinding && <div><dt>Session</dt><dd>{sessionBinding.status} · {sessionBinding.transport}</dd></div>}
          </dl>
        </div>
      )}
      {activity && (
        <>
          <div className={`run-activity-stream stream-${activity.streamStatus}`}>
            <span>{streamStatusLabels[activity.streamStatus]}</span>
            <small>{activity.acceptedEvents} accepted events · updated {timeAgo(activity.updatedAt)}</small>
          </div>
          {activity.streamFailure && <p className="run-notice" role="alert">{activity.streamFailure}</p>}
          <BoundedBlock label="Agent message" text={activity.message.text} truncatedBytes={activity.message.truncatedBytes} />
          <BoundedBlock label="Thinking" text={activity.thought.text} truncatedBytes={activity.thought.truncatedBytes} />
          {activity.plan.length > 0 && (
            <section className="run-text">
              <h3>Plan</h3>
              <ul className="run-plan">
                {activity.plan.map((entry, index) => <li key={index} className={`plan-status-${entry.status} plan-priority-${entry.priority}`}>{entry.content}</li>)}
              </ul>
            </section>
          )}
          {activity.toolCalls.length > 0 && (
            <section className="run-text">
              <h3>Tool calls {activity.omitted.toolCalls > 0 && <small>({activity.omitted.toolCalls} omitted)</small>}</h3>
              <ul className="run-tool-calls">
                {activity.toolCalls.map((call) => (
                  <li key={call.toolCallId} className={`tool-call-status-${call.status}`}>
                    <span className="tool-call-kind">{toolCallKindLabels[call.kind]}</span>
                    <strong>{call.title}</strong>
                    <span>{toolCallStatusLabels[call.status]}</span>
                    {call.detail && <p>{call.detail}</p>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {activity.diffs.length > 0 && (
            <section className="run-text">
              <h3>Diffs {activity.omitted.diffs > 0 && <small>({activity.omitted.diffs} omitted)</small>}</h3>
              {activity.diffs.map((diff, index) => (
                <div key={index} className="run-diff">
                  <div className="run-diff-heading"><code>{diff.path}</code>{diff.truncated && <span className="truncation-note">truncated</span>}</div>
                  <pre>{diff.newText || "(no content)"}</pre>
                </div>
              ))}
            </section>
          )}
          {activity.terminals.length > 0 && (
            <section className="run-text">
              <h3>Terminals {activity.omitted.terminals > 0 && <small>({activity.omitted.terminals} omitted)</small>}</h3>
              {activity.terminals.map((terminal) => (
                <div key={terminal.terminalId} className="run-terminal">
                  <BoundedBlock label="stdout" text={terminal.stdout.text} truncatedBytes={terminal.stdout.truncatedBytes} />
                  <BoundedBlock label="stderr" text={terminal.stderr.text} truncatedBytes={terminal.stderr.truncatedBytes} />
                </div>
              ))}
            </section>
          )}
          {activity.usage && (
            <section className="run-text">
              <h3>Usage</h3>
              <dl className="run-details">
                {activity.usage.inputTokens !== undefined && <div><dt>Input tokens</dt><dd>{activity.usage.inputTokens}</dd></div>}
                {activity.usage.outputTokens !== undefined && <div><dt>Output tokens</dt><dd>{activity.usage.outputTokens}</dd></div>}
                {activity.usage.cachedInputTokens !== undefined && <div><dt>Cached input tokens</dt><dd>{activity.usage.cachedInputTokens}</dd></div>}
                {activity.usage.costUsd !== undefined && <div><dt>Cost</dt><dd>${activity.usage.costUsd.toFixed(4)}</dd></div>}
              </dl>
            </section>
          )}
          {activity.warnings.length > 0 && (
            <section className="run-text">
              <h3>Warnings {activity.omitted.warnings > 0 && <small>({activity.omitted.warnings} omitted)</small>}</h3>
              <ul className="run-warnings">{activity.warnings.map((warning, index) => <li key={index}><code>{warning.code}</code> {warning.message}</li>)}</ul>
            </section>
          )}
          {activity.unknownEvents > 0 && <p className="run-unknown-events">{activity.unknownEvents} event(s) had no known mapping and were not projected.</p>}
        </>
      )}
      {approvals.length > 0 && (
        <section className="run-text">
          <h3>Approval history</h3>
          <ul className="run-approval-history">
            {approvals.map((approval) => (
              <li key={approval.id}><span className={`approval-status approval-status-${approval.status}`}>{approvalStatusLabels[approval.status]}</span> {approval.title}</li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
