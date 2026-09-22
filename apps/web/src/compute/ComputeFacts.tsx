import type { ComputeNode, HarnessProfile } from "@coffee-shop/protocol";
import { ApprovalPolicyBadge, approvalPolicyHarnessIds, isRelaxedOrUnrecognizedPolicy } from "./ApprovalPolicyBadge.js";

function text(value: unknown, fallback = "Unavailable"): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function number(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "Unavailable";
}

function list(value: unknown, fallback: string): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") && value.length ? value : [fallback];
}

export function Provenance({ kind }: { kind: "reported" | "observed" | "documented" }) {
  const labels = { reported: "Worker-reported", observed: "Hub-observed", documented: "Release documentation" };
  return <span className={`provenance provenance-${kind}`}>{labels[kind]}</span>;
}

export function NodeFacts({ node, statusProvenance = "reported" }: { node: ComputeNode; statusProvenance?: "reported" | "observed" }) {
  return (
    <dl className="fact-grid">
      <div><dt>ID</dt><dd><code>{text(node.id)}</code></dd></div>
      <div><dt>Name</dt><dd>{text(node.name)}</dd></div>
      <div><dt>Kind</dt><dd>{text(node.kind, "Unrecognized")}</dd></div>
      <div><dt>Platform</dt><dd>{text(node.platform)}</dd></div>
      <div><dt>Status <Provenance kind={statusProvenance} /></dt><dd>{text(node.status, "Unrecognized")}</dd></div>
      <div><dt>Last seen</dt><dd><time>{text(node.lastSeen)}</time></dd></div>
      <div><dt>Active runs</dt><dd>{number(node.activeRuns)}</dd></div>
      <div><dt>Concurrency</dt><dd>{number(node.concurrency)}</dd></div>
      <div className="fact-wide"><dt>Workspace roots</dt><dd>{list(node.workspaceRoots, "No roots reported").map((root) => <code key={root}>{root}</code>)}</dd></div>
      <div className="fact-wide"><dt>Barista version</dt><dd><code>{text(node.version)}</code></dd></div>
    </dl>
  );
}

export function HarnessFacts({ harness, children }: { harness: HarnessProfile; children?: React.ReactNode }) {
  return (
    <article className="harness-report">
      <header><div><strong>{text(harness.label, "Unnamed harness")}</strong><code>{text(harness.id, "Unrecognized")}</code></div><span className={harness.available === true ? "availability-ready" : "availability-unavailable"}>{harness.available === true ? "Available" : "Unavailable"}</span></header>
      <p>{text(harness.description, "No description reported")}</p>
      <dl>
        <div><dt>Binary</dt><dd><code>{text(harness.binary, "Not reported")}</code></dd></div>
        <div><dt>Authentication</dt><dd>{text(harness.authMode, "Unrecognized")}</dd></div>
        <div><dt>Models</dt><dd>{list(harness.models, "No models reported").join(" · ")}</dd></div>
        {approvalPolicyHarnessIds.includes(harness.id) && <div><dt>Approval policy</dt><dd>{isRelaxedOrUnrecognizedPolicy(harness.approvalPolicy, harness.approvalPolicyUnrecognized) ? <ApprovalPolicyBadge policy={harness.approvalPolicy} unrecognized={harness.approvalPolicyUnrecognized} /> : "Manual"}</dd></div>}
      </dl>
      {children}
    </article>
  );
}

export function HarnessList({ harnesses, children }: {
  harnesses: ComputeNode["harnesses"];
  children?: (harness: HarnessProfile) => React.ReactNode;
}) {
  if (!Array.isArray(harnesses) || harnesses.length === 0) return <p className="empty-inline">No harnesses reported.</p>;
  return <div className="harness-reports">{harnesses.map((harness, index) => <HarnessFacts key={`${String(harness?.id)}-${index}`} harness={harness}>{children?.(harness)}</HarnessFacts>)}</div>;
}
