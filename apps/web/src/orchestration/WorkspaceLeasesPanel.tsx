import { WarningCircle } from "@phosphor-icons/react";
import type { ComputeNode, WorkspaceLease } from "@coffee-shop/protocol";
import { timeAgo, workspaceLeaseStatusLabels, workspaceRetentionReasonLabels } from "./orchestrationLabels.js";

const attentionStatuses: readonly WorkspaceLease["status"][] = ["retained", "failed"];

/**
 * Read-only workspace lease status. Retained/dirty/ambiguous leases surface as an operator-attention
 * state; this issue never offers a destructive cleanup control from here.
 */
export function WorkspaceLeasesPanel({ leases, nodes }: { leases: WorkspaceLease[]; nodes: ComputeNode[] }) {
  const nodeNames = new Map(nodes.map((node) => [node.id, node.name]));
  if (leases.length === 0) return <div className="leases-empty"><strong>No workspace leases</strong><p>Isolated workspaces will appear here once a task is placed on git-worktree or exclusive-existing isolation.</p></div>;
  return (
    <ul className="lease-list" role="list">
      {leases.map((lease) => {
        const needsAttention = attentionStatuses.includes(lease.status);
        return (
          <li key={lease.id} className={`lease-card ${needsAttention ? "lease-attention" : ""}`}>
            <header>
              <span className={`lease-status lease-status-${lease.status}`}>{workspaceLeaseStatusLabels[lease.status]}</span>
              <span>{nodeNames.get(lease.nodeId) ?? lease.nodeId}</span>
              <time>{timeAgo(lease.updatedAt)}</time>
            </header>
            <dl>
              <div><dt>Policy</dt><dd>{lease.policy}</dd></div>
              <div><dt>Cleanup</dt><dd>{lease.cleanup === "retain" ? "Always retained" : "Removed when unchanged"}</dd></div>
              <div><dt>Worktree</dt><dd><code>{lease.worktreePath}</code></dd></div>
              {lease.branch && <div><dt>Branch</dt><dd><code>{lease.branch}</code></dd></div>}
            </dl>
            {needsAttention && (
              <p className="lease-notice" role="status">
                <WarningCircle size={14} />
                {lease.retentionReason ? workspaceRetentionReasonLabels[lease.retentionReason] : "Needs operator attention"}
                {lease.detail ? ` — ${lease.detail}` : ""}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
