import { useEffect, useReducer, useState } from "react";
import { Prohibit, ShieldWarning, WarningCircle, X } from "@phosphor-icons/react";
import type { Agent, ApprovalOption, ApprovalRequest, ComputeNode, OrchestratorClient, Run, Task } from "@coffee-shop/protocol";
import { AccessibleDialog } from "../AccessibleDialog.js";
import { actorLabel, approvalResolverLabel, isOrchestratorResolution } from "../orchestratorPresentation.js";
import { approvalOptionKindLabels, approvalStatusLabels, timeAgo, timeUntil } from "./orchestrationLabels.js";

function randomIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `approval-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const alwaysConfirmedKinds: readonly ApprovalOption["kind"][] = ["allow-always", "reject-always"];

interface ResolutionOutcome {
  approval?: ApprovalRequest;
  error?: string;
}

export function ApprovalDialog({ approval, agents, nodes, runs, tasks, orchestratorClients, canMutate, onClose, apiFetch }: {
  approval: ApprovalRequest;
  agents: Agent[];
  nodes: ComputeNode[];
  runs: Run[];
  tasks: Task[];
  orchestratorClients: OrchestratorClient[];
  canMutate: boolean;
  onClose: () => void;
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
}) {
  const [pendingOptionId, setPendingOptionId] = useState("");
  const [confirmingOptionId, setConfirmingOptionId] = useState("");
  const [notice, setNotice] = useState<{ tone: "info" | "error"; text: string } | undefined>(undefined);
  // Only the local resolution response is ever held in state: the displayed approval itself is
  // always derived from the live snapshot prop, so a resolution or expiry recorded elsewhere (a
  // reconnect, another operator, or the hub's own expiry sweep) is reflected as soon as the next
  // snapshot arrives, rather than staying frozen at whatever this dialog first opened with.
  const [overlay, setOverlay] = useState<ApprovalRequest | undefined>(undefined);
  useEffect(() => { setOverlay(undefined); }, [approval]);
  const latest = overlay ?? approval;
  const run = runs.find((item) => item.id === latest.runId);
  const node = nodes.find((item) => item.id === latest.nodeId);
  const agent = run ? agents.find((item) => item.id === run.agentId) : undefined;
  const task = latest.taskId ? tasks.find((item) => item.id === latest.taskId) : undefined;
  const titleId = "approval-dialog-title";
  const busy = pendingOptionId !== "";

  // Nothing else re-renders this dialog at the exact moment `expiresAt` passes, so a timer forces
  // one: otherwise a dialog left open across an expiry would keep offering "pending" actions on a
  // decision the hub has already stopped honoring.
  const [, forceExpiryCheck] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (!latest.expiresAt) return;
    const delay = Date.parse(latest.expiresAt) - Date.now();
    if (delay <= 0) return;
    const timer = setTimeout(forceExpiryCheck, delay + 50);
    return () => clearTimeout(timer);
  }, [latest.expiresAt]);
  const expired = latest.expiresAt !== undefined && Date.parse(latest.expiresAt) <= Date.now();

  async function resolve(body: Record<string, unknown>, optionKey: string): Promise<ResolutionOutcome> {
    setPendingOptionId(optionKey);
    setNotice(undefined);
    try {
      const response = await apiFetch(`/api/approvals/${encodeURIComponent(latest.id)}/resolution`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: randomIdempotencyKey(), expectedStatus: "pending", ...body })
      });
      const payload = await response.json().catch(() => ({})) as { approval?: ApprovalRequest; error?: string };
      if (payload.approval) setOverlay(payload.approval);
      if (response.status === 200) return { approval: payload.approval };
      if (response.status === 409) return { error: "This approval already changed. Showing the current state instead." };
      if (response.status === 422) return { error: "That option is no longer offered. Showing the current state instead." };
      if (response.status === 404) return { error: "This approval no longer exists." };
      return { error: payload.error ?? `Resolution failed (${response.status})` };
    } catch {
      return { error: "Could not reach the hub to resolve this approval." };
    } finally {
      setPendingOptionId("");
      setConfirmingOptionId("");
    }
  }

  async function selectOption(option: ApprovalOption) {
    if (!canMutate || busy) return;
    if (alwaysConfirmedKinds.includes(option.kind) && confirmingOptionId !== option.id) {
      setConfirmingOptionId(option.id);
      return;
    }
    const outcome = await resolve({ optionId: option.id }, option.id);
    setNotice(outcome.error ? { tone: "error", text: outcome.error } : { tone: "info", text: `Resolved: ${option.label}` });
  }

  async function cancelApproval() {
    if (!canMutate || busy) return;
    const outcome = await resolve({ cancel: true }, "__cancel__");
    setNotice(outcome.error ? { tone: "error", text: outcome.error } : { tone: "info", text: "Approval cancelled." });
  }

  const isPending = latest.status === "pending" && !expired;
  const resolvedByLabel = approvalResolverLabel(latest.resolvedBy, orchestratorClients);

  return (
    <AccessibleDialog labelledBy={titleId} onClose={onClose} className="approval-dialog">
      <header>
        <div><small>Approval</small><h2 id={titleId}>{latest.title}</h2></div>
        <button className="icon-btn" onClick={onClose} aria-label="Close approval" data-dialog-initial-focus><X size={17} /></button>
      </header>
      <div className="approval-summary"><span className={`approval-status approval-status-${latest.status}`}>{approvalStatusLabels[latest.status]}</span><code>{latest.id}</code></div>
      {latest.detail && <p className="approval-detail">{latest.detail}</p>}
      <dl className="approval-details">
        <div><dt>Run</dt><dd>{run ? `${agent?.name ?? actorLabel(run, agents)} · ${run.id}` : `${latest.runId} (unavailable)`}</dd></div>
        <div><dt>Node</dt><dd>{node?.name ?? `${latest.nodeId} (unavailable)`}</dd></div>
        {task && <div><dt>Task</dt><dd>{task.title}</dd></div>}
        {latest.toolCallId && <div><dt>Tool call</dt><dd><code>{latest.toolCallId}</code></dd></div>}
        <div><dt>Requested</dt><dd><time>{timeAgo(latest.requestedAt)}</time></dd></div>
        <div><dt>Expires</dt><dd>{latest.expiresAt ? (expired ? "Expired" : <>in <time>{timeUntil(latest.expiresAt)}</time></>) : "No expiry reported"}</dd></div>
        {resolvedByLabel && <div><dt>Resolved by</dt><dd className={isOrchestratorResolution(latest.resolvedBy) ? "approval-orchestrator-resolution" : undefined}>{resolvedByLabel}</dd></div>}
      </dl>
      {!isPending && (
        <p className="approval-resolved-notice" role="status">
          {expired ? "This approval expired before it was resolved." : `This approval is already ${approvalStatusLabels[latest.status].toLowerCase()}; no further action can be taken here.`}
        </p>
      )}
      {notice && <p className={notice.tone === "error" ? "approval-notice-error" : "approval-notice"} role="alert">{notice.text}</p>}
      {isPending && (
        <div className="approval-options">
          {latest.options.map((option) => (
            <div key={option.id} className="approval-option">
              {confirmingOptionId === option.id ? (
                <div className="approval-confirm">
                  <span>Confirm "{option.label}"? This choice cannot be undone.</span>
                  <button onClick={() => setConfirmingOptionId("")} disabled={busy}>Keep waiting</button>
                  <button className={option.kind.startsWith("reject") ? "danger-button" : "primary-button"} onClick={() => void selectOption(option)} disabled={busy || !canMutate}>
                    {busy && pendingOptionId === option.id ? "Sending…" : `Confirm ${option.label}`}
                  </button>
                </div>
              ) : (
                <button
                  className={option.kind.startsWith("reject") ? "danger-button" : "primary-button"}
                  onClick={() => void selectOption(option)}
                  disabled={busy || !canMutate}
                >
                  {busy && pendingOptionId === option.id ? "Sending…" : option.label}
                  <small>{approvalOptionKindLabels[option.kind]}</small>
                </button>
              )}
            </div>
          ))}
          <button className="approval-cancel-button" onClick={() => void cancelApproval()} disabled={busy || !canMutate}>
            <Prohibit size={14} /> Cancel this approval
          </button>
        </div>
      )}
      {!canMutate && isPending && <p className="approval-offline-notice" role="status"><WarningCircle size={14} /> Reconnect to the hub before resolving this approval.</p>}
    </AccessibleDialog>
  );
}

export function ApprovalsView({ approvals, agents, nodes, runs, tasks, orchestratorClients, canMutate, apiFetch }: {
  approvals: ApprovalRequest[];
  agents: Agent[];
  nodes: ComputeNode[];
  runs: Run[];
  tasks: Task[];
  orchestratorClients: OrchestratorClient[];
  canMutate: boolean;
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
}) {
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const pending = approvals.filter((approval) => approval.status === "pending");
  const resolved = approvals.filter((approval) => approval.status !== "pending").sort((left, right) => (right.resolvedAt ?? "").localeCompare(left.resolvedAt ?? ""));
  const open = approvals.find((approval) => approval.id === openId);

  return (
    <section className="approvals-section">
      <div className="approvals-summary" aria-live="polite">
        {pending.length > 0 ? <span className="approvals-pending-badge"><ShieldWarning size={14} weight="fill" /> {pending.length} awaiting a decision</span> : <span>No approvals are waiting</span>}
      </div>
      {pending.length > 0 && (
        <ul className="approval-list" role="list">
          {pending.map((approval) => {
            const run = runs.find((item) => item.id === approval.runId);
            const agent = run ? agents.find((item) => item.id === run.agentId) : undefined;
            const expired = approval.expiresAt !== undefined && Date.parse(approval.expiresAt) <= Date.now();
            return (
              <li key={approval.id}>
                <button className="approval-row" onClick={() => setOpenId(approval.id)}>
                  <span className={`approval-status approval-status-${approval.status}`}>{expired ? "Expiring" : approvalStatusLabels[approval.status]}</span>
                  <span className="approval-row-title">{approval.title}</span>
                  <span className="approval-row-meta">{agent?.name ?? approval.runId}</span>
                  <time>{timeAgo(approval.requestedAt)}</time>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {resolved.length > 0 && (
        <details className="approval-history">
          <summary>Resolved approvals ({resolved.length})</summary>
          <ul className="approval-list approval-list-resolved" role="list">
            {resolved.slice(0, 25).map((approval) => (
              <li key={approval.id}>
                <button className="approval-row" onClick={() => setOpenId(approval.id)}>
                  <span className={`approval-status approval-status-${approval.status}`}>{approvalStatusLabels[approval.status]}</span>
                  <span className="approval-row-title">{approval.title}</span>
                  <span className={isOrchestratorResolution(approval.resolvedBy) ? "approval-row-meta approval-orchestrator-resolution" : "approval-row-meta"}>
                    {approvalResolverLabel(approval.resolvedBy, orchestratorClients) ?? "Resolver unreported"}
                  </span>
                  <time>{approval.resolvedAt ? timeAgo(approval.resolvedAt) : "—"}</time>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {pending.length === 0 && resolved.length === 0 && <div className="approvals-empty"><strong>No approvals yet</strong><p>Permission requests raised by a running harness will appear here.</p></div>}
      {open && <ApprovalDialog approval={open} agents={agents} nodes={nodes} runs={runs} tasks={tasks} orchestratorClients={orchestratorClients} canMutate={canMutate} onClose={() => setOpenId(undefined)} apiFetch={apiFetch} />}
    </section>
  );
}
