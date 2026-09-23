import { useState } from "react";
import { Copy, Plug, ShieldWarning, WarningCircle, X } from "@phosphor-icons/react";
import { orchestratorClientScopes, type OrchestratorClient, type OrchestratorClientScope } from "@coffee-shop/protocol";
import { AccessibleDialog } from "../AccessibleDialog.js";
import { orchestratorClientScopeLabels, resolveApprovalsWarning, sinceLabel } from "../orchestratorPresentation.js";

type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** The endpoint an orchestrator bridge dials, derived from the origin this app was served from. */
function bridgeHubUrl(): string {
  const origin = typeof location === "undefined" ? "" : location.origin;
  return `${origin.replace(/^http/, "ws")}/orchestrator-client`;
}

const pluginInstallCommands = [
  "claude plugin marketplace add cafecito-games/CoffeeShop --sparse .claude-plugin plugins/coffeeshop-orchestrator",
  "claude plugin install coffeeshop-orchestrator@cafecito-games",
  "claude plugin enable coffeeshop-orchestrator@cafecito-games"
].join("\n");

const pluginConfigureCommand = "/plugin configure coffeeshop-orchestrator@cafecito-games";
const launchCommand = "claude --dangerously-load-development-channels plugin:coffeeshop-orchestrator@cafecito-games";

function CopyableBlock({ label, value, description }: { label: string; value: string; description?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  }
  return (
    <div className="secret-block">
      <div className="secret-block-heading"><strong>{label}</strong><button type="button" onClick={() => void copy()} aria-label={`Copy ${label}`}><Copy size={13} /> {state === "copied" ? "Copied" : state === "failed" ? "Copy failed — select the text" : "Copy"}</button></div>
      {description && <p>{description}</p>}
      <pre tabIndex={0}>{value}</pre>
    </div>
  );
}

/**
 * Mints one credential. The secret exists only in this component's state: it is never persisted,
 * logged, or put in a URL, and closing the dialog unmounts the only copy the browser holds.
 */
function ConnectOrchestratorDialog({ canMutate, apiFetch, onClose }: { canMutate: boolean; apiFetch: ApiFetch; onClose: () => void }) {
  const [name, setName] = useState("");
  const [resolveApprovals, setResolveApprovals] = useState(false);
  const [minting, setMinting] = useState(false);
  const [error, setError] = useState("");
  const [minted, setMinted] = useState<{ client: OrchestratorClient; secret: string } | undefined>(undefined);
  const titleId = "connect-orchestrator-title";

  async function mint() {
    const trimmed = name.trim();
    if (!trimmed || minting || !canMutate) return;
    setMinting(true);
    setError("");
    try {
      const scopes: OrchestratorClientScope[] = resolveApprovals ? ["orchestrate", "resolve-approvals"] : ["orchestrate"];
      const response = await apiFetch("/api/orchestrator-clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed, scopes })
      });
      const payload = await response.json().catch(() => ({})) as { client?: OrchestratorClient; secret?: string; error?: string };
      if (!response.ok || !payload.client || typeof payload.secret !== "string") {
        throw new Error(payload.error ?? `The credential could not be minted (${response.status})`);
      }
      setMinted({ client: payload.client, secret: payload.secret });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The credential could not be minted");
    } finally {
      setMinting(false);
    }
  }

  return (
    <AccessibleDialog labelledBy={titleId} onClose={onClose} className="experience-dialog connect-client-dialog">
      <header className="experience-header">
        <div><small>Orchestrator credential</small><h2 id={titleId}>{minted ? "Finish connecting" : "Connect a Claude Code orchestrator"}</h2></div>
        <button className="icon-btn" onClick={onClose} aria-label="Close orchestrator setup"><X size={17} /></button>
      </header>
      {minted ? (
        <>
          <p className="experience-lede">This secret is shown once. Coffee Shop keeps only a hash of it, so if you lose it you revoke this credential and connect again.</p>
          <CopyableBlock label="Client secret" value={minted.secret} description={`Credential ${minted.client.name} · ${minted.client.id}`} />
          <CopyableBlock label="Hub URL" value={bridgeHubUrl()} description="Paste this into the plugin's Coffee Shop hub URL field." />
          <CopyableBlock label="Client ID" value={minted.client.id} description="Paste this and the secret above into the remaining plugin fields." />
          <CopyableBlock label="Install plugin" value={pluginInstallCommands} description="Run these once in a terminal. Claude Code reports that the three required options still need to be configured." />
          <CopyableBlock label="Configure plugin" value={pluginConfigureCommand} description="Start a normal Claude Code session, run this slash command, and paste the hub URL, client ID, and secret shown above into the secure prompt." />
          <CopyableBlock label="Launch with doorbells" value={launchCommand} description="Start Claude Code with this custom channel selected. The tools still work without this flag, but worker events must then be polled." />
          <footer className="connect-client-footer">
            <button className="create-button" onClick={onClose} data-dialog-initial-focus>Done — I have copied the secret</button>
          </footer>
        </>
      ) : (
        <>
          <p className="experience-lede">Your own Claude Code session drives a thread through a local bridge. The bridge authenticates with this credential; provider credentials never reach the hub.</p>
          <form
            onSubmit={(event) => { event.preventDefault(); void mint(); }}
            className="connect-client-form"
          >
            <label>Name this machine or session<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Christian's laptop" data-dialog-initial-focus /></label>
            <label className="scope-choice">
              <input type="checkbox" checked={resolveApprovals} onChange={(event) => setResolveApprovals(event.target.checked)} />
              <span><strong>Let this orchestrator approve worker actions</strong><small>{resolveApprovalsWarning}</small></span>
            </label>
            {resolveApprovals && <p className="scope-warning" role="status"><ShieldWarning size={14} /> You are letting one AI approve what another AI asks to do.</p>}
            {error && <p className="dialog-error" role="alert">{error}</p>}
            <footer className="connect-client-footer">
              <button type="button" onClick={onClose}>Cancel</button>
              <button className="create-button" disabled={!canMutate || minting || !name.trim()}>{minting ? "Minting…" : "Mint credential"}</button>
            </footer>
          </form>
        </>
      )}
    </AccessibleDialog>
  );
}

function ScopeEditor({ client, canMutate, busy, onCancel, onSave }: {
  client: OrchestratorClient;
  canMutate: boolean;
  busy: boolean;
  onCancel: () => void;
  onSave: (scopes: OrchestratorClientScope[]) => void;
}) {
  const [scopes, setScopes] = useState<OrchestratorClientScope[]>(client.scopes);
  function toggle(scope: OrchestratorClientScope, granted: boolean) {
    setScopes((current) => granted ? [...current.filter((item) => item !== scope), scope] : current.filter((item) => item !== scope));
  }
  return (
    <div className="client-scope-editor">
      {orchestratorClientScopes.map((scope) => (
        <label key={scope}>
          <input type="checkbox" checked={scopes.includes(scope)} onChange={(event) => toggle(scope, event.target.checked)} />
          <span>{orchestratorClientScopeLabels[scope]}</span>
        </label>
      ))}
      {scopes.includes("resolve-approvals") && !client.scopes.includes("resolve-approvals") && (
        <p className="scope-warning" role="status"><ShieldWarning size={14} /> {resolveApprovalsWarning}</p>
      )}
      <div className="client-actions">
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="create-button" onClick={() => onSave(scopes)} disabled={busy || !canMutate}>{busy ? "Saving…" : "Save scopes"}</button>
      </div>
    </div>
  );
}

/**
 * The orchestrator credentials an operator has minted. The list is rendered from the hub snapshot,
 * so a hub that does not publish `orchestratorClients` simply shows none.
 */
export function ConnectedClients({ clients, canMutate, apiFetch }: { clients: OrchestratorClient[]; canMutate: boolean; apiFetch: ApiFetch }) {
  const [connecting, setConnecting] = useState(false);
  const [editingId, setEditingId] = useState("");
  const [revokingId, setRevokingId] = useState("");
  const [busyId, setBusyId] = useState("");
  const [notice, setNotice] = useState("");
  const ordered = [...clients].sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  async function saveScopes(client: OrchestratorClient, scopes: OrchestratorClientScope[]) {
    setBusyId(client.id);
    setNotice("");
    try {
      const response = await apiFetch(`/api/orchestrator-clients/${encodeURIComponent(client.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scopes })
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(response.status === 409 ? "This credential is revoked; its scopes can no longer change." : payload.error ?? `Scopes could not be saved (${response.status})`);
      }
      setEditingId("");
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Scopes could not be saved");
    } finally {
      setBusyId("");
    }
  }

  async function revoke(client: OrchestratorClient) {
    setBusyId(client.id);
    setNotice("");
    try {
      const response = await apiFetch(`/api/orchestrator-clients/${encodeURIComponent(client.id)}/revoke`, { method: "POST" });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error ?? `The credential could not be revoked (${response.status})`);
      }
      setRevokingId("");
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "The credential could not be revoked");
    } finally {
      setBusyId("");
    }
  }

  return (
    <section className="connected-clients">
      <div className="connected-clients-heading">
        <div><small>External orchestration</small><h2>Connected clients</h2></div>
        <button onClick={() => setConnecting(true)} disabled={!canMutate}><Plug size={14} /> Connect a Claude Code orchestrator</button>
      </div>
      <p className="connected-clients-lede">Each credential lets one Claude Code session drive Coffee Shop threads from your own machine.</p>
      {notice && <p className="dialog-error" role="alert">{notice}</p>}
      {ordered.length === 0 ? (
        <div className="connected-clients-empty"><Plug size={20} /><strong>No orchestrator clients</strong><p>Connect one to orchestrate a thread from a Claude Code session you run yourself.</p></div>
      ) : (
        <ul className="client-list" role="list">
          {ordered.map((client) => {
            const revoked = client.revokedAt !== undefined;
            return (
              <li key={client.id} className={revoked ? "client-card revoked" : "client-card"}>
                <div className="client-heading">
                  <div><strong>{client.name}</strong><code>{client.id}</code></div>
                  <span className={revoked ? "client-state revoked" : "client-state"}>{revoked ? "Revoked" : "Active"}</span>
                </div>
                <dl className="client-facts">
                  <div><dt>Scopes</dt><dd>{client.scopes.length ? client.scopes.map((scope) => orchestratorClientScopeLabels[scope]).join(" · ") : "No scopes"}</dd></div>
                  <div><dt>Created</dt><dd>{sinceLabel(client.createdAt)}</dd></div>
                  <div><dt>Last seen</dt><dd>{client.lastSeenAt ? sinceLabel(client.lastSeenAt) : "Never connected"}</dd></div>
                </dl>
                {client.revokedAt && <p className="client-revoked-note">Revoked {sinceLabel(client.revokedAt)}; this secret no longer authenticates.</p>}
                {client.scopes.includes("resolve-approvals") && !revoked && (
                  <p className="client-approval-note"><ShieldWarning size={13} /> This orchestrator may approve worker actions on your behalf.</p>
                )}
                {!revoked && editingId === client.id && (
                  <ScopeEditor client={client} canMutate={canMutate} busy={busyId === client.id} onCancel={() => setEditingId("")} onSave={(scopes) => void saveScopes(client, scopes)} />
                )}
                {!revoked && revokingId === client.id && (
                  <div className="client-confirm">
                    <span>Revoke {client.name}? Its session is disconnected immediately and the secret stops working.</span>
                    <button type="button" onClick={() => setRevokingId("")} disabled={busyId === client.id}>Keep credential</button>
                    <button type="button" className="danger-button" onClick={() => void revoke(client)} disabled={busyId === client.id || !canMutate}>{busyId === client.id ? "Revoking…" : "Confirm revocation"}</button>
                  </div>
                )}
                {!revoked && editingId !== client.id && revokingId !== client.id && (
                  <div className="client-actions">
                    <button type="button" onClick={() => { setEditingId(client.id); setRevokingId(""); }} disabled={!canMutate}>Edit scopes</button>
                    <button type="button" className="danger-button" onClick={() => { setRevokingId(client.id); setEditingId(""); }} disabled={!canMutate}>Revoke</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!canMutate && <p className="connected-clients-offline" role="status"><WarningCircle size={13} /> Reconnect to the hub before changing credentials.</p>}
      {connecting && <ConnectOrchestratorDialog canMutate={canMutate} apiFetch={apiFetch} onClose={() => setConnecting(false)} />}
    </section>
  );
}
