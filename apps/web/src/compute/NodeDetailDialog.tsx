import type { ComputeNode } from "@coffee-shop/protocol";
import { WarningCircle, X } from "@phosphor-icons/react";
import { AccessibleDialog } from "../AccessibleDialog.js";
import { HarnessList, NodeFacts, Provenance } from "./ComputeFacts.js";

export function NodeDetailDialog({ selectedNodeId, node, onClose }: { selectedNodeId: string; node?: ComputeNode; onClose: () => void }) {
  const title = node && typeof node.name === "string" && node.name.trim() ? node.name : node ? "Unnamed compute" : "Compute unavailable";
  return (
    <AccessibleDialog labelledBy="node-detail-title" onClose={onClose} className="experience-dialog node-detail-dialog">
      <header className="experience-header">
        <div><small>Compute inventory</small><h2 id="node-detail-title">{title}</h2></div>
        <button className="icon-btn" onClick={onClose} aria-label="Close compute details" data-dialog-initial-focus><X size={17} /></button>
      </header>
      {!node ? (
        <div className="experience-empty" role="status"><WarningCircle size={22} /><strong>Node unavailable</strong><p><code>{selectedNodeId}</code> is no longer present in the latest snapshot. No other node was substituted.</p></div>
      ) : (
        <>
          {node.status === "offline" && <p className="qualification"><WarningCircle size={15} /> This node is offline. Its inventory is the last report retained by the hub.</p>}
          <section className="experience-section"><div className="experience-section-heading"><h3>Node fields</h3><Provenance kind="reported" /></div><NodeFacts node={node} /></section>
          <section className="experience-section"><div className="experience-section-heading"><h3>Harness profiles</h3><Provenance kind="reported" /></div><HarnessList harnesses={node.harnesses} /></section>
        </>
      )}
    </AccessibleDialog>
  );
}
