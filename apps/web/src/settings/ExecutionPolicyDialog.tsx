import type { ComputeNode, HarnessProfile } from "@coffee-shop/protocol";
import { ShieldCheck, WarningCircle, X } from "@phosphor-icons/react";
import { AccessibleDialog } from "../AccessibleDialog.js";
import { HarnessList, NodeFacts, Provenance } from "../compute/ComputeFacts.js";
import type { ConnectionStatus } from "../hubConnection.js";
import { isDocumentedHarnessAuthPair, releaseMatch, runtimeAuthModePolicy, runtimeHarnessPolicy } from "./executionPolicy.js";

const bundledDocumentedVersion = import.meta.env.VITE_BARISTA_VERSION?.trim() || "dev";

function PolicyQualification({ harness, versionMatches, reportFresh }: { harness: HarnessProfile; versionMatches: boolean; reportFresh: boolean }) {
  const harnessCopy = runtimeHarnessPolicy(harness?.id);
  const authCopy = runtimeAuthModePolicy(harness?.authMode);
  const verified = reportFresh
    && versionMatches
    && harness?.available === true
    && harnessCopy.verified
    && authCopy.verified
    && isDocumentedHarnessAuthPair(harness?.id, harness?.authMode);
  return (
    <div className={`policy-qualification ${verified ? "verified" : "not-verified"}`}>
      <strong>{verified ? <ShieldCheck size={14} /> : <WarningCircle size={14} />}{verified ? "Documented for matching release" : "Unrecognized / not verified"}</strong>
      <p>{harnessCopy.detail}</p>
      <p>{authCopy.detail}</p>
      {verified && harnessCopy.documentedFlags && <div><Provenance kind="documented" /><code>{harnessCopy.documentedFlags}</code></div>}
      {!verified && harnessCopy.documentedFlags && <p>Current-release flags are withheld because this report is unavailable, stale, mismatched, or unrecognized.</p>}
    </div>
  );
}

export function ExecutionPolicyDialog({ nodes, connection, generatedAt, documentedVersion = bundledDocumentedVersion, onClose }: {
  nodes: ComputeNode[];
  connection: ConnectionStatus;
  generatedAt: string;
  documentedVersion?: string;
  onClose: () => void;
}) {
  const stale = connection !== "connected";
  return (
    <AccessibleDialog labelledBy="execution-policy-title" onClose={onClose} className="experience-dialog policy-dialog">
      <header className="experience-header">
        <div><small>Read-only review</small><h2 id="execution-policy-title">Execution policy</h2></div>
        <button className="icon-btn" onClick={onClose} aria-label="Close execution policy" data-dialog-initial-focus><X size={17} /></button>
      </header>
      <p className="experience-lede">Reported configuration is inventory, not attestation. This view separates what Barista reports, what the hub observes, and what this source release documents.</p>
      <section className={`observation-banner ${stale ? "stale" : ""}`}>
        <Provenance kind="observed" />
        <strong>{stale ? "Connection is stale" : "Live snapshot connection"}</strong>
        <p>{stale ? "Preserved node values may be stale or offline and are not verified as current." : "The hub currently receives validated snapshots. Node fields remain self-reported."}</p>
        <time>Snapshot generated {generatedAt || "at an unavailable time"}</time>
      </section>
      <section className="release-policy">
        <div className="experience-section-heading"><h3>This release’s documented enforcement</h3><Provenance kind="documented" /></div>
        <p>Barista requires absolute configured roots, resolves symlinks at startup, resolves each requested workspace again, and permits it only when contained by a canonical root. Harnesses are spawned directly without shell interpolation.</p>
        <code>Documented Barista version: {documentedVersion}</code>
      </section>
      {nodes.length === 0 ? (
        <div className="experience-empty"><ShieldCheck size={22} /><strong>No Baristas registered</strong><p>Reported policy details appear after a Barista connects. No effective execution policy can be verified yet.</p></div>
      ) : nodes.map((node, index) => {
        const match = releaseMatch(node?.version, documentedVersion);
        return (
          <section className="policy-node" key={typeof node?.id === "string" ? node.id : `node-${index}`}>
            <div className="policy-node-heading"><div><small>Barista {index + 1}</small><h3>{typeof node?.name === "string" && node.name ? node.name : "Unnamed Barista"}</h3></div><span className={match.matches ? "match-label" : "mismatch-label"}>{match.label}</span></div>
            {node.status === "offline" && <p className="qualification"><WarningCircle size={15} /> Offline node: reported values are retained history, not current proof.</p>}
            <div className="experience-section-heading"><h4>Node configuration</h4><Provenance kind="reported" /></div>
            <NodeFacts node={node} statusProvenance="observed" />
            <div className="experience-section-heading"><h4>Harness configuration</h4><Provenance kind="reported" /></div>
            <HarnessList harnesses={node.harnesses}>{(harness) => <PolicyQualification harness={harness} versionMatches={match.matches} reportFresh={!stale && node.status !== "offline"} />}</HarnessList>
          </section>
        );
      })}
      <section className="security-guidance">
        <h3>Security and provider boundary</h3>
        <p>Keep Claude and Codex authentication in vendor-owned CLI storage on the compute machine. The hub receives neither provider token. Subscription-backed Claude use is intended for the account owner’s private nodes; shared or public service deployments need an appropriate commercial provider agreement.</p>
        <p>The shared Coffee Shop token fits a private single-user tailnet, not an internet-facing multi-user deployment. Use TLS and scoped machine identities before expanding that boundary.</p>
      </section>
    </AccessibleDialog>
  );
}
