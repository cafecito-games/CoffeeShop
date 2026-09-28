import type { ComponentDiagnosticCode, ComponentInventoryReport, ComputeNode } from "@coffee-shop/protocol";
import { WarningCircle, X } from "@phosphor-icons/react";
import { AccessibleDialog } from "../AccessibleDialog.js";
import type { ConnectionStatus } from "../hubConnection.js";
import { HarnessList, NodeFacts, Provenance } from "./ComputeFacts.js";

const diagnosticExplanations = {
  "activation-rejected": "The activation record was rejected.",
  "not-activated": "Installed, but no version is active.",
  "active-unverified": "The selected component no longer verifies.",
  "harness-unavailable": "The associated harness is unavailable.",
  "auth-unavailable": "Authentication readiness could not be verified.",
  "auth-unhealthy": "The authentication readiness probe failed.",
  "platform-unsupported": "No distribution is declared for this platform.",
  "update-available": "The declared version is installed and differs from the active version.",
  "rollback-available": "The retained rollback version still verifies."
} satisfies Record<ComponentDiagnosticCode, string>;

function ComponentInventory({ report }: { report: ComponentInventoryReport }) {
  return <div className="component-inventory" aria-label="Worker-reported component inventory">
    {report.components.map((component) => <article key={`${component.kind}:${component.id}`} className="component-card">
      <header><strong>{component.id}</strong><span className={`component-readiness ${component.readiness}`}>{component.readiness}</span></header>
      <dl>
        <div><dt>Kind</dt><dd>{component.kind}</dd></div>
        {component.harnessId && <div><dt>Harness</dt><dd>{component.harnessId}</dd></div>}
        <div><dt>Provenance</dt><dd>{component.provenance}</dd></div>
        <div><dt>Declared</dt><dd>{component.declaredVersion}</dd></div>
        <div><dt>Installed</dt><dd>{component.installedVersions.join(" · ") || "None verified"}</dd></div>
        <div><dt>Active</dt><dd>{component.activeVersion ?? "None"}</dd></div>
        {component.updateVersion && <div><dt>Update</dt><dd>{component.updateVersion}</dd></div>}
        <div><dt>Rollback</dt><dd>{component.rollbackAvailable ? component.rollbackVersion : "Unavailable"}</dd></div>
      </dl>
      {component.diagnosticCodes.length > 0 && <ul className="component-diagnostics">{component.diagnosticCodes.map((code) => <li key={code}>{diagnosticExplanations[code]}</li>)}</ul>}
    </article>)}
  </div>;
}

export function NodeDetailDialog({ selectedNodeId, node, inventory, connectionStatus = "connected", onClose, fallbackFocus }: {
  selectedNodeId: string;
  node?: ComputeNode;
  inventory?: ComponentInventoryReport;
  connectionStatus?: ConnectionStatus;
  onClose: () => void;
  fallbackFocus: () => HTMLElement | null;
}) {
  const title = node && typeof node.name === "string" && node.name.trim() ? node.name : node ? "Unnamed compute" : "Compute unavailable";
  return (
    <AccessibleDialog labelledBy="node-detail-title" onClose={onClose} fallbackFocus={fallbackFocus} className="experience-dialog node-detail-dialog">
      <header className="experience-header">
        <div><small>Compute inventory</small><h2 id="node-detail-title">{title}</h2></div>
        <button className="icon-btn" onClick={onClose} aria-label="Close compute details" data-dialog-initial-focus><X size={17} /></button>
      </header>
      {!node ? (
        <div className="experience-empty" role="status"><WarningCircle size={22} /><strong>Node unavailable</strong><p><code>{selectedNodeId}</code> is no longer present in the latest snapshot. No other node was substituted.</p></div>
      ) : (
        <>
          {connectionStatus !== "connected" && inventory && <p className="qualification"><WarningCircle size={15} /> App snapshot stale. Component facts are from the last valid app snapshot.</p>}
          {connectionStatus === "connected" && node.status === "offline" && inventory && <p className="qualification"><WarningCircle size={15} /> Node offline. This component report is retained by the hub and is not live evidence.</p>}
          <section className="experience-section"><div className="experience-section-heading"><h3>Node fields</h3><Provenance kind="reported" /></div><NodeFacts node={node} /></section>
          <section className="experience-section"><div className="experience-section-heading"><h3>Harness profiles</h3><Provenance kind="reported" /></div><HarnessList harnesses={node.harnesses} /></section>
          <section className="experience-section"><div className="experience-section-heading"><h3>Managed components</h3>{inventory && <Provenance kind="reported" />}</div>
            {!inventory ? <div className="experience-empty" role="status"><strong>Not reported</strong><p>This Barista has not published a component inventory for its current connection.</p></div> : <><p className="inventory-observed">Worker-reported · observed <time dateTime={inventory.observedAt}>{inventory.observedAt}</time></p><ComponentInventory report={inventory} /></>}
          </section>
        </>
      )}
    </AccessibleDialog>
  );
}
