import type { ComputeNode, OrchestratorClient } from "@coffee-shop/protocol";
import { Broadcast, Check, Desktop, WarningCircle } from "@phosphor-icons/react";
import { useState } from "react";
import type { ConnectionStatus } from "../hubConnection.js";
import { ConnectedClients } from "./ConnectedClients.js";
import { ExecutionPolicyDialog } from "./ExecutionPolicyDialog.js";
import { PwaInstallControl } from "./PwaInstall.js";

const connectionLabels: Record<ConnectionStatus, string> = {
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting · stale",
  disconnected: "Disconnected · stale",
  "authentication-required": "Authentication required"
};

export function SettingsView({ connection, nodes, generatedAt, documentedVersion, orchestratorClients, canMutate, apiFetch }: {
  connection: ConnectionStatus;
  nodes: ComputeNode[];
  generatedAt: string;
  documentedVersion?: string;
  orchestratorClients: OrchestratorClient[];
  canMutate: boolean;
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
}) {
  const [reviewingPolicy, setReviewingPolicy] = useState(false);
  return (
    <main className="utility-view">
      <header className="utility-header"><div><small>Control plane</small><h1>Settings</h1></div></header>
      <div className="settings-list">
        <section><div><Broadcast size={18} /><span><strong>Hub connection</strong><small>WebSocket events and Barista dispatch</small></span></div><em className={connection === "connected" ? "ok-label" : "stale-label"}>{connection === "connected" ? <Check size={13} /> : <WarningCircle size={13} />} {connectionLabels[connection].toLowerCase()}</em></section>
        <section className="install-setting"><div><Desktop size={18} /><span><strong>Installable app</strong><small>Add Coffee Shop to your home screen</small></span></div><PwaInstallControl /></section>
        <section><div><WarningCircle size={18} /><span><strong>Execution policy</strong><small>Compare reported configuration with this release’s documented defaults</small></span></div><button onClick={() => setReviewingPolicy(true)}>Review</button></section>
      </div>
      <ConnectedClients clients={orchestratorClients} canMutate={canMutate} apiFetch={apiFetch} />
      <div className="terms-note"><strong>Claude subscription boundary</strong><p>Coffee Shop invokes Anthropic’s official Claude Code CLI through Barista. It never reads, copies, or proxies Claude credentials. Keep a subscription-backed compute node private to its account owner.</p></div>
      {reviewingPolicy && <ExecutionPolicyDialog nodes={nodes} connection={connection} generatedAt={generatedAt} documentedVersion={documentedVersion} onClose={() => setReviewingPolicy(false)} />}
    </main>
  );
}
