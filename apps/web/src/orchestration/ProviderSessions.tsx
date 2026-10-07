import { useState } from "react";
import { ArrowSquareOut, Copy } from "@phosphor-icons/react";
import type { HarnessId, HarnessSessionBinding, HarnessTransport, Run, SessionBindingStatus } from "@coffee-shop/protocol";

/** A vendor session an operator can continue outside Coffee Shop, on the node that owns it. */
export interface ProviderSessionReference {
  key: string;
  harnessId: HarnessId;
  transport: HarnessTransport;
  providerSessionId: string;
  workspace: string;
  nodeId: string;
  runId: string;
  /** Explicit Hub-authored correlation only; never derived from provider identity. */
  hostHarnessSessionId?: string;
  /** Present for ACP sessions, which Coffee Shop may itself resume while idle. */
  bindingStatus?: SessionBindingStatus;
  updatedAt: string;
}

export function providerSessionForRun(run: Run, sessionBindings: HarnessSessionBinding[]): ProviderSessionReference | undefined {
  const binding = run.sessionBindingId ? sessionBindings.find((item) => item.id === run.sessionBindingId) : undefined;
  if (binding) return fromBinding(binding, run.hostHarnessSessionId);
  if (!run.providerSessionId) return undefined;
  return {
    key: `run:${run.id}`, harnessId: run.harnessId, transport: "native-cli", providerSessionId: run.providerSessionId,
    workspace: run.workspace, nodeId: run.nodeId, runId: run.id, hostHarnessSessionId: run.hostHarnessSessionId,
    updatedAt: run.finishedAt ?? run.startedAt ?? run.createdAt
  };
}

/** The agent's most recent distinct provider sessions, newest first. */
export function providerSessionsForAgent(agentId: string, runs: Run[], sessionBindings: HarnessSessionBinding[], limit = 5): ProviderSessionReference[] {
  const references = new Map<string, ProviderSessionReference>();
  for (const binding of sessionBindings) {
    if (binding.agentId === agentId) {
      const correlated = runs.find((run) => run.sessionBindingId === binding.id && run.hostHarnessSessionId !== undefined);
      references.set(binding.providerSessionId, fromBinding(binding, correlated?.hostHarnessSessionId));
    }
  }
  for (const run of runs) {
    if (run.agentId !== agentId || !run.providerSessionId || references.has(run.providerSessionId)) continue;
    const reference = providerSessionForRun(run, sessionBindings);
    if (reference) references.set(reference.providerSessionId, reference);
  }
  return [...references.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, limit);
}

function fromBinding(binding: HarnessSessionBinding, hostHarnessSessionId?: string): ProviderSessionReference {
  return {
    key: `binding:${binding.id}`, harnessId: binding.harnessId, transport: binding.transport, providerSessionId: binding.providerSessionId,
    workspace: binding.workspace, nodeId: binding.nodeId, runId: binding.lastRunId, bindingStatus: binding.status,
    hostHarnessSessionId, updatedAt: binding.updatedAt
  };
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const resumeInvocations: Partial<Record<HarnessId, (sessionId: string) => string>> = {
  "claude-cli": (sessionId) => `claude --resume ${sessionId}`,
  "codex-cli": (sessionId) => `codex resume ${sessionId}`
};

/**
 * Both CLIs scope sessions to the directory they ran in, so the command starts there. Harnesses
 * without a resumable CLI have no command.
 */
export function resumeCommand(reference: ProviderSessionReference): string | undefined {
  const invocation = resumeInvocations[reference.harnessId];
  return invocation ? `cd ${shellQuote(reference.workspace)} && ${invocation(reference.providerSessionId)}` : undefined;
}

const harnessLabels: Record<HarnessId, string> = { "claude-cli": "Claude Code", "codex-cli": "Codex", shell: "Shell", "ag-ui": "AG-UI" };

export function ProviderSessionCard({ reference, nodeName, onOpenHostSession }: { reference: ProviderSessionReference; nodeName: string; onOpenHostSession?: (id: string) => void }) {
  const [copied, setCopied] = useState<"" | "copied" | "failed">("");
  const command = resumeCommand(reference);
  const resumableByCoffeeShop = reference.bindingStatus === "active" || reference.bindingStatus === "idle";

  async function copy() {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <div className="provider-session">
      <div className="provider-session-heading">
        <strong>{harnessLabels[reference.harnessId]}</strong>
        <span>{reference.transport}{reference.bindingStatus ? ` · ${reference.bindingStatus}` : ""}</span>
      </div>
      <dl className="run-details">
        <div><dt>Session</dt><dd><code>{reference.providerSessionId}</code></dd></div>
        {command && <div><dt>Resume on {nodeName}</dt><dd><code className="provider-session-command">{command}</code></dd></div>}
      </dl>
      {command && (
        <button className="provider-session-copy" onClick={() => void copy()} aria-label={`Copy resume command for ${reference.providerSessionId}`}>
          <Copy size={13} /> {copied === "copied" ? "Copied" : copied === "failed" ? "Copy failed — select the command" : "Copy command"}
        </button>
      )}
      {reference.hostHarnessSessionId && onOpenHostSession && <button className="provider-session-copy" onClick={() => onOpenHostSession(reference.hostHarnessSessionId!)}><ArrowSquareOut size={13} /> View in Sessions</button>}
      {resumableByCoffeeShop && <p className="provider-session-note">Coffee Shop may still resume this session. Stop the hub or finish the thread before continuing it yourself.</p>}
    </div>
  );
}
