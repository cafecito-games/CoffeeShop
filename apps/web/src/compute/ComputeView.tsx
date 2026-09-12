import type { ComputeNode } from "@coffee-shop/protocol";
import { ArrowRight, Cloud, Command, HouseLine, Laptop, Plus, TerminalWindow } from "@phosphor-icons/react";
import { useState } from "react";
import { NodeDetailDialog } from "./NodeDetailDialog.js";
import { OnboardingDialog } from "./OnboardingDialog.js";

function KindIcon({ kind }: { kind: ComputeNode["kind"] }) {
  return kind === "local" ? <Laptop size={20} /> : kind === "home-server" ? <HouseLine size={20} /> : <Cloud size={20} />;
}

export function ComputeView({ nodes }: { nodes: ComputeNode[] }) {
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [onboarding, setOnboarding] = useState(false);
  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  return (
    <main className="utility-view">
      <header className="utility-header"><div><small>Execution fabric</small><h1>Compute</h1></div><button className="primary-btn" onClick={() => setOnboarding(true)}><Plus size={16} /> Add compute</button></header>
      <div className="node-list">
        {nodes.length === 0 && <div className="compute-empty"><Laptop size={22} /><strong>No Baristas registered</strong><p>Add a local, home-server, or cloud machine to make compute available.</p></div>}
        {nodes.map((node) => (
          <button key={node.id} className="node-row" onClick={() => setSelectedNodeId(node.id)} aria-label={`View ${node.name} compute details`}>
            <span className="node-icon"><KindIcon kind={node.kind} /></span>
            <span className="node-main"><span><strong>{node.name}</strong><span className={`node-status ${node.status}`}><i />{node.status}</span></span><span className="node-summary">{node.platform} · {node.activeRuns} of {node.concurrency} slots active</span><span className="capacity"><i style={{ width: `${Math.max(3, (node.activeRuns / Math.max(node.concurrency, 1)) * 100)}%` }} /></span><span className="harness-tags">{node.harnesses.map((harness) => <span key={harness.id} className={harness.available ? "" : "unavailable"}><Command size={13} />{harness.label}<small>{harness.available ? "ready" : "missing"}</small></span>)}</span></span>
            <ArrowRight className="node-arrow" size={17} aria-hidden="true" />
          </button>
        ))}
      </div>
      <section className="worker-callout"><TerminalWindow size={19} /><div><strong>Bring another machine online</strong><p>Barista connects outbound; model credentials never leave the compute machine. Use Add compute for validated setup.</p></div></section>
      {selectedNodeId && <NodeDetailDialog selectedNodeId={selectedNodeId} node={selectedNode} onClose={() => setSelectedNodeId(undefined)} />}
      {onboarding && <OnboardingDialog onClose={() => setOnboarding(false)} />}
    </main>
  );
}
