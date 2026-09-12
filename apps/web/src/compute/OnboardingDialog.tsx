import { nodeKinds, type NodeKind } from "@coffee-shop/protocol";
import { Check, Copy, WarningCircle, X } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { AccessibleDialog } from "../AccessibleDialog.js";
import { buildBaristaCommand, defaultControlEndpoint, validateOnboarding, type OnboardingValues } from "./onboarding.js";

const kindLabels: Record<NodeKind, string> = { local: "Local computer", "home-server": "Home server", cloud: "Cloud machine" };

export function OnboardingDialog({ onClose }: { onClose: () => void }) {
  const [values, setValues] = useState<OnboardingValues>({
    controlEndpoint: defaultControlEndpoint(import.meta.env.VITE_HUB_URL, import.meta.env.DEV, location.origin),
    name: "My Barista",
    nodeId: "my-barista",
    kind: "local",
    concurrency: "2",
    workspaceRoots: ""
  });
  const [copyState, setCopyState] = useState<"idle" | "success" | "failure">("idle");
  const errors = useMemo(() => validateOnboarding(values), [values]);
  const command = errors.length ? "Complete the valid configuration fields to generate a command." : buildBaristaCommand(values);
  const update = <K extends keyof OnboardingValues>(key: K, value: OnboardingValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    setCopyState("idle");
  };
  async function copy() {
    if (errors.length) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(command);
      setCopyState("success");
    } catch {
      setCopyState("failure");
    }
  }
  return (
    <AccessibleDialog labelledBy="onboarding-title" onClose={onClose} className="experience-dialog onboarding-dialog">
      <header className="experience-header">
        <div><small>Outbound connection</small><h2 id="onboarding-title">Add a Barista</h2></div>
        <button className="icon-btn" onClick={onClose} aria-label="Close Barista setup" data-dialog-initial-focus><X size={17} /></button>
      </header>
      <p className="experience-lede">Install Barista on the machine that will run agents. Coffee Shop does not provision it remotely, and provider credentials stay on that machine.</p>
      <ol className="setup-steps">
        <li><strong>Build Barista</strong><code>git clone https://github.com/cafecito-games/CoffeeShop.git</code><code>cd CoffeeShop &amp;&amp; task control-agent:build</code></li>
        <li><strong>Authenticate local harnesses</strong><span>Install Claude Code and/or Codex, then complete the vendor CLI’s local sign-in flow (<code>claude</code> or <code>codex login</code>). Never paste those credentials here.</span></li>
        <li><strong>Configure and start</strong><span>Replace only the hub token placeholder in the generated command.</span></li>
      </ol>
      <div className="onboarding-fields">
        <label>Hub URL<input value={values.controlEndpoint} onChange={(event) => update("controlEndpoint", event.target.value)} inputMode="url" /></label>
        <label>Barista name<input value={values.name} onChange={(event) => update("name", event.target.value)} /></label>
        <label>Barista ID<input value={values.nodeId} onChange={(event) => update("nodeId", event.target.value)} /></label>
        <label>Concurrency<input value={values.concurrency} onChange={(event) => update("concurrency", event.target.value)} inputMode="numeric" /></label>
        <fieldset className="kind-picker"><legend>Machine kind</legend><div>{nodeKinds.map((kind) => <button type="button" key={kind} aria-pressed={values.kind === kind} onClick={() => update("kind", kind)}>{kindLabels[kind]}</button>)}</div></fieldset>
        <label className="field-wide">Workspace roots <small>One absolute path per line</small><textarea rows={3} value={values.workspaceRoots} onChange={(event) => update("workspaceRoots", event.target.value)} placeholder="/absolute/path/to/workspace" /></label>
      </div>
      {errors.length > 0 && <ul className="validation-list" aria-label="Configuration errors">{errors.map((error) => <li key={error}>{error}</li>)}</ul>}
      <div className="command-preview"><pre tabIndex={0}>{command}</pre><button type="button" onClick={copy} disabled={errors.length > 0}><Copy size={15} /> Copy command</button></div>
      <div className="copy-result" aria-live="polite">{copyState === "success" && <span className="copy-success"><Check size={14} /> Copied safe setup command.</span>}{copyState === "failure" && <span className="copy-failure"><WarningCircle size={14} /> Clipboard access failed. Select the command text and copy it manually.</span>}</div>
    </AccessibleDialog>
  );
}
