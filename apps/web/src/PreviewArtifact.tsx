import { ArrowSquareOut, DownloadSimple } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  artifactSource,
  artifactPreviewTtlPolicy,
  isTimestamp,
  sameArtifactSource,
  validateArtifactPreview,
  type Artifact,
  type ArtifactPreview,
  type ArtifactPreviewFailureCode,
  type OrchestratorClient
} from "@coffee-shop/protocol";
import { externalArtifactProducerLabel } from "./orchestratorPresentation.js";

export type AuthenticatedFetch = (path: string, init?: RequestInit) => Promise<Response>;

const failureLabels: Record<ArtifactPreviewFailureCode, string> = {
  "upload-failed": "Bundle upload failed",
  "bundle-invalid": "Bundle format is invalid",
  "path-invalid": "Bundle contains an unsafe path",
  "entrypoint-invalid": "Preview entrypoint is invalid",
  "limit-exceeded": "Bundle exceeds preview limits",
  "storage-conflict": "Preview storage is unavailable",
  "processing-cancelled": "Preview preparation was superseded",
  "processing-failed": "Preview preparation failed"
};

const exactKeys = (value: Record<string, unknown>, keys: string[]) => {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && keys.slice().sort().every((key, index) => actual[index] === key);
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function renewalTtlSeconds(preview: ArtifactPreview, nowMilliseconds: number) {
  const maximum = Date.parse(preview.createdAt) + artifactPreviewTtlPolicy.maximumLifetimeSeconds * 1_000;
  const target = Math.min(nowMilliseconds + artifactPreviewTtlPolicy.defaultSeconds * 1_000, maximum);
  if (target - Date.parse(preview.expiresAt) < artifactPreviewTtlPolicy.minimumSeconds * 1_000) return undefined;
  const ttl = Math.floor((target - nowMilliseconds) / 1_000);
  return ttl >= artifactPreviewTtlPolicy.minimumSeconds ? ttl : undefined;
}

function identityOf(artifact: Artifact, preview: ArtifactPreview) {
  return JSON.stringify([preview.id, artifact.id, artifact.sha256, artifact.uploaded,
    preview.artifactSha256, preview.threadId, preview.runId ?? "", preview.sourceKey ?? "",
    artifact.runId ?? "", artifact.sourceKey ?? "",
    preview.agentId ?? "", preview.instanceId ?? "", preview.allocationId ?? "",
    preview.entrypoint, preview.processingGeneration, preview.status, preview.accessState,
    preview.createdAt, preview.updatedAt, preview.expiresAt, preview.readyAt ?? "",
    preview.failedAt ?? "", preview.failureCode ?? "", preview.expiredAt ?? ""]);
}

function validAccess(value: unknown, preview: ArtifactPreview, nowMilliseconds: number) {
  if (!record(value) || !exactKeys(value, ["previewId", "url", "expiresAt"])
    || value.previewId !== preview.id || typeof value.url !== "string" || !isTimestamp(value.expiresAt)) return undefined;
  const expires = Date.parse(value.expiresAt);
  if (!Number.isFinite(expires) || expires <= nowMilliseconds || expires > Date.parse(preview.expiresAt)) return undefined;
  try {
    const url = new URL(value.url);
    const capabilitySegments = url.pathname.slice("/_coffee-shop/preview/v1/".length).split("/");
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password
      || url.origin === window.location.origin || url.search || url.hash || url.href !== value.url
      || !url.pathname.startsWith("/_coffee-shop/preview/v1/")
      || capabilitySegments.length < 2 || capabilitySegments.some((segment) => segment === "")) return undefined;
    return { url: value.url, expiresAt: value.expiresAt };
  } catch {
    return undefined;
  }
}

function samePreviewIdentity(value: ArtifactPreview, preview: ArtifactPreview) {
  return value.id === preview.id && value.artifactId === preview.artifactId
    && value.artifactSha256 === preview.artifactSha256 && value.threadId === preview.threadId
    && sameArtifactSource(value, preview);
}

function actorName(preview: ArtifactPreview) {
  return preview.instanceId
    ? `Instance ${preview.instanceId} · allocation ${preview.allocationId}`
    : `Agent ${preview.agentId}`;
}

function statusCopy(preview: ArtifactPreview, lifecycleLive: boolean) {
  switch (preview.status) {
    case "upload-pending": return "Waiting for bundle upload";
    case "processing": return `Preparing preview · generation ${preview.processingGeneration}`;
    case "ready": return preview.accessState === "eligible" && lifecycleLive ? "Ready for isolated access" : "Access expired/unavailable";
    case "failed": return failureLabels[preview.failureCode!];
    case "expired": return "Preview expired";
  }
}

export function PreviewArtifact({ artifact, preview, orchestratorClients = [], canMutate, apiFetch, compact = false }: {
  artifact: Artifact;
  preview: ArtifactPreview;
  orchestratorClients?: OrchestratorClient[];
  canMutate: boolean;
  apiFetch: AuthenticatedFetch;
  compact?: boolean;
}) {
  const source = artifactSource(preview);
  const sourceLabel = source.ok
    ? (source.value.kind === "run" ? source.value.runId : "External orchestrator")
    : "Unavailable";
  const producerLabel = source.ok && source.value.kind === "external"
    ? externalArtifactProducerLabel(artifact, orchestratorClients) ?? "Unknown orchestrator"
    : actorName(preview);
  const identity = identityOf(artifact, preview);
  const [grant, setGrant] = useState<{ url: string; expiresAt: string }>();
  const [pending, setPending] = useState<"access" | "renew" | "retry" | "download">();
  const [notice, setNotice] = useState("");
  const [nowMilliseconds, setNowMilliseconds] = useState(Date.now());
  const authority = useRef({ identity, canMutate });
  authority.current = { identity, canMutate };
  const lifecycleLive = nowMilliseconds < Date.parse(preview.expiresAt);
  const renewalTtl = useMemo(() => renewalTtlSeconds(preview, nowMilliseconds), [preview, nowMilliseconds]);
  const available = canMutate && pending === undefined;

  useEffect(() => { setGrant(undefined); setPending(undefined); setNotice(""); }, [identity, canMutate]);
  useEffect(() => {
    setNowMilliseconds(Date.now());
    const delay = Math.max(0, Date.parse(preview.expiresAt) - Date.now());
    const expiryTimer = window.setTimeout(() => setNowMilliseconds(Date.now()), delay);
    const clockTimer = preview.status === "ready" && delay > 0
      ? window.setInterval(() => setNowMilliseconds(Date.now()), 30_000)
      : undefined;
    return () => {
      window.clearTimeout(expiryTimer);
      if (clockTimer !== undefined) window.clearInterval(clockTimer);
    };
  }, [preview.expiresAt, preview.status, identity]);
  useEffect(() => {
    if (!grant) return;
    const delay = Math.max(0, Date.parse(grant.expiresAt) - Date.now());
    const timer = window.setTimeout(() => setGrant(undefined), delay);
    return () => window.clearTimeout(timer);
  }, [grant]);

  async function requestAccess() {
    if (!available || preview.status !== "ready" || preview.accessState !== "eligible" || !lifecycleLive) return;
    const requestedIdentity = identity;
    setPending("access"); setNotice(""); setGrant(undefined);
    try {
      const response = await apiFetch(`/api/previews/${encodeURIComponent(preview.id)}/access`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}"
      });
      if (!response.ok) throw new Error();
      const validated = validAccess(await response.json(), preview, Date.now());
      if (!validated) throw new Error();
      if (authority.current.identity !== requestedIdentity || !authority.current.canMutate) return;
      setGrant(validated);
    } catch {
      if (authority.current.identity === requestedIdentity && authority.current.canMutate) setNotice("Preview access unavailable");
    } finally { setPending(undefined); }
  }

  async function renew() {
    if (!available || preview.status !== "ready" || preview.accessState !== "eligible" || !lifecycleLive || renewalTtl === undefined) return;
    const requestedIdentity = identity;
    setPending("renew"); setNotice(""); setGrant(undefined);
    try {
      const response = await apiFetch(`/api/previews/${encodeURIComponent(preview.id)}/renew`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ttlSeconds: renewalTtl })
      });
      const body: unknown = response.ok ? await response.json() : undefined;
      if (!record(body) || !exactKeys(body, ["preview"]) || !validateArtifactPreview(body.preview, preview.updatedAt).ok) throw new Error();
      const returned = body.preview as ArtifactPreview;
      if (!samePreviewIdentity(returned, preview) || returned.processingGeneration !== preview.processingGeneration
        || Date.parse(returned.expiresAt) <= Date.parse(preview.expiresAt)) throw new Error();
      if (authority.current.identity !== requestedIdentity || !authority.current.canMutate) return;
      setNotice("Renewal accepted. Waiting for the live preview update.");
    } catch {
      if (authority.current.identity === requestedIdentity && authority.current.canMutate) setNotice("Preview renewal unavailable");
    }
    finally { setPending(undefined); }
  }

  async function retry() {
    if (!available || preview.status !== "failed" || preview.accessState !== "unavailable" || !lifecycleLive) return;
    const requestedIdentity = identity;
    setPending("retry"); setNotice(""); setGrant(undefined);
    try {
      const response = await apiFetch(`/api/previews/${encodeURIComponent(preview.id)}/retry`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}"
      });
      const body: unknown = response.ok ? await response.json() : undefined;
      if (!record(body) || !exactKeys(body, ["preview", "replayed"]) || typeof body.replayed !== "boolean"
        || !validateArtifactPreview(body.preview, (body.preview as { updatedAt?: unknown }).updatedAt).ok) throw new Error();
      const returned = body.preview as ArtifactPreview;
      if (!samePreviewIdentity(returned, preview) || returned.processingGeneration !== preview.processingGeneration + 1
        || !["processing", "ready", "failed"].includes(returned.status)) throw new Error();
      if (authority.current.identity !== requestedIdentity || !authority.current.canMutate) return;
      setNotice("Retry accepted. Waiting for the live preview update.");
    } catch {
      if (authority.current.identity === requestedIdentity && authority.current.canMutate) setNotice("Preview retry unavailable");
    }
    finally { setPending(undefined); }
  }

  async function download() {
    if (pending) return;
    setPending("download"); setNotice("");
    try {
      const response = await apiFetch(artifact.downloadPath);
      if (!response.ok) throw new Error();
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = artifact.relativePath.split("/").at(-1) || artifact.title;
      link.click();
      URL.revokeObjectURL(objectUrl);
    } catch { setNotice("Artifact download unavailable"); }
    finally { setPending(undefined); }
  }

  return <article className={`preview-artifact preview-${preview.status}${compact ? " preview-compact" : ""}`} aria-busy={pending !== undefined}>
    <header><div><span className="preview-kicker">Isolated preview</span><h4>{artifact.title}</h4></div><span className="preview-state">{statusCopy(preview, lifecycleLive)}</span></header>
    {artifact.summary && <p>{artifact.summary}</p>}
    <dl>
      <div><dt>Source</dt><dd>{sourceLabel}</dd></div>
      <div><dt>Producer</dt><dd>{producerLabel}</dd></div>
      <div><dt>Generation</dt><dd>{preview.processingGeneration}</dd></div>
      {preview.status === "ready" && <><div><dt>Entrypoint</dt><dd>{preview.entrypoint}</dd></div><div><dt>Ready</dt><dd>{preview.readyAt}</dd></div></>}
      {preview.status === "failed" && <div><dt>Failed</dt><dd>{preview.failedAt}</dd></div>}
      <div><dt>{preview.status === "expired" ? "Expired" : "Lifecycle expiry"}</dt><dd>{preview.expiredAt ?? preview.expiresAt}</dd></div>
    </dl>
    <div className="preview-controls">
      <button onClick={() => void download()} disabled={pending !== undefined} aria-label={`Download preview bundle ${artifact.title}`}><DownloadSimple size={15} /> Download bundle</button>
      {preview.status === "ready" && preview.accessState === "eligible" && lifecycleLive && <button onClick={() => void requestAccess()} disabled={!available} aria-label={`Request access to preview ${artifact.title}`}>{pending === "access" ? "Requesting…" : "Request access"}</button>}
      {preview.status === "ready" && preview.accessState === "eligible" && lifecycleLive && renewalTtl !== undefined && <button onClick={() => void renew()} disabled={!available} aria-label={`Renew lifecycle for preview ${artifact.title}`}>{pending === "renew" ? "Renewing…" : "Renew lifecycle"}</button>}
      {preview.status === "failed" && lifecycleLive && <button onClick={() => void retry()} disabled={!available} aria-label={`Retry preview ${artifact.title}`}>{pending === "retry" ? "Retrying…" : "Retry preview"}</button>}
    </div>
    {!canMutate && <p className="preview-stale">Reconnect to use preview actions.</p>}
    {grant && <div className="preview-grant"><a href={grant.url} target="_blank" rel="noopener noreferrer" aria-label={`Open isolated preview ${artifact.title} in a new tab`}><ArrowSquareOut size={15} /> Open isolated preview</a><small>Access expires {grant.expiresAt}</small></div>}
    {notice && <p className="preview-notice" role="status" aria-live="polite">{notice}</p>}
  </article>;
}
