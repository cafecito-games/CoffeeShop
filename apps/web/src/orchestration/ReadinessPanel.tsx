import { useEffect, useState } from "react";
import { CheckCircle, CircleNotch, WarningCircle, XCircle } from "@phosphor-icons/react";
import type { ProjectReadiness } from "@coffee-shop/protocol";

interface ReadinessResponse {
  profile: { id: string; name: string };
  readiness: ProjectReadiness[];
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; data: ReadinessResponse };

/**
 * Project readiness for one task's `requirements.projectProfileId`, fetched from the hub's
 * read-only readiness endpoint. Every field the endpoint returns is fixed vocabulary or profile
 * content the hub already screened for secrets, but it is still worker-reported evidence, never an
 * attested guarantee, so it is always labelled that way.
 */
export function ReadinessPanel({ projectId, nodeNames, apiFetch }: {
  projectId: string;
  nodeNames: Map<string, string>;
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    apiFetch(`/api/project-readiness?projectId=${encodeURIComponent(projectId)}`)
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          const body = await response.json().catch(() => ({})) as { error?: string };
          setState({ kind: "error", message: body.error ?? `Readiness request failed (${response.status})` });
          return;
        }
        const data = await response.json() as ReadinessResponse;
        setState({ kind: "loaded", data });
      })
      .catch(() => { if (!cancelled) setState({ kind: "error", message: "Could not reach the hub for readiness" }); });
    return () => { cancelled = true; };
  }, [projectId, apiFetch]);

  if (state.kind === "loading") return <div className="readiness-panel readiness-loading" role="status"><CircleNotch className="spin" size={14} /> Checking readiness…</div>;
  if (state.kind === "error") return <div className="readiness-panel readiness-error" role="alert"><WarningCircle size={14} /> {state.message}</div>;
  if (state.data.readiness.length === 0) return <div className="readiness-panel readiness-empty"><WarningCircle size={14} /> No compute nodes are known to the hub yet.</div>;

  return (
    <div className="readiness-panel">
      <div className="readiness-heading"><span className="provenance provenance-observed">Worker-reported</span><strong>{state.data.profile.name}</strong></div>
      <ul className="readiness-nodes">
        {state.data.readiness.map((entry) => (
          <li key={entry.nodeId} className={entry.ready ? "readiness-ready" : "readiness-not-ready"}>
            <div className="readiness-node-heading">
              {entry.ready ? <CheckCircle size={15} weight="fill" /> : <XCircle size={15} weight="fill" />}
              <strong>{nodeNames.get(entry.nodeId) ?? entry.nodeId}</strong>
              <span>{entry.ready ? "Ready" : "Not ready"}</span>
            </div>
            {entry.unmetHardRequirements.length > 0 && (
              <ul className="readiness-requirements">
                {entry.unmetHardRequirements.map((requirement, index) => (
                  <li key={`${entry.nodeId}-hard-${index}`}><strong>{requirement.kind}</strong> {requirement.requirement} — {requirement.detail}</li>
                ))}
              </ul>
            )}
            {entry.unmetPreferences.length > 0 && (
              <ul className="readiness-requirements readiness-preferences">
                {entry.unmetPreferences.map((requirement, index) => (
                  <li key={`${entry.nodeId}-pref-${index}`}><strong>{requirement.kind}</strong> {requirement.requirement} — {requirement.detail} <em>(preferred)</em></li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
