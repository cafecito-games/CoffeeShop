import {
  artifactPreviewAccessState,
  artifactPreviewTtlPolicy,
  artifactSourceKey,
  isArtifactPreviewFailureCode,
  isTimestamp,
  previewBundleArtifactKind,
  previewBundleLimits,
  previewBundleMediaType,
  sameArtifactSource,
  validatePreviewBundlePath,
  type Artifact,
  type ArtifactPreview,
  type ArtifactPreviewFailureCode,
  type ArtifactPreviewRecord
} from "@coffee-shop/protocol";
import { issueArtifactUploadGrantInState, type ArtifactUploadGrant } from "./artifactUploadGrants.js";
import { CoordinationError } from "./coordinationError.js";
import {
  callerAttribution,
  resolveCallerFor,
  runSource,
  type CallerSource
} from "./mailbox.js";
import {
  newId,
  previewProcessingDigest,
  previewRegistrationDigest,
  type PreviewProcessingReceipt,
  type PreviewRegistrationReceipt,
  type State,
  type Store
} from "./store.js";

interface NormalizedPreviewRegistration {
  relativePath: string;
  title: string;
  kind: typeof previewBundleArtifactKind;
  mediaType: typeof previewBundleMediaType;
  summary: string;
  size: number;
  sha256: string;
  entrypoint: string;
  ttlSeconds: number;
  idempotencyKey: string;
}

interface NormalizedProcessingSettlement {
  previewId: string;
  artifactId: string;
  artifactSha256: string;
  processingGeneration: number;
  outcome: "ready" | "failed";
  failureCode?: ArtifactPreviewFailureCode;
  at: string;
}

const registrationKeys = [
  "relativePath", "title", "kind", "mediaType", "summary", "size", "sha256", "entrypoint", "ttlSeconds", "idempotencyKey"
] as const;
const settlementKeys = [
  "previewId", "artifactId", "artifactSha256", "processingGeneration", "outcome", "failureCode", "at"
] as const;

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CoordinationError("invalid_arguments", `${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], context: string) {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new CoordinationError("invalid_arguments", `${context} contains an unknown field`);
  }
}

function boundedString(value: unknown, key: string, maximum: number, trim = true, byteBounded = false) {
  if (typeof value !== "string") throw new CoordinationError("invalid_arguments", `${key} is required`);
  const normalized = trim ? value.trim() : value;
  if (normalized.length === 0) throw new CoordinationError("invalid_arguments", `${key} is required`);
  if ((byteBounded ? Buffer.byteLength(normalized) : normalized.length) > maximum) {
    throw new CoordinationError("invalid_arguments", `${key} exceeds its limit`);
  }
  return normalized;
}

function operationTime(value: unknown) {
  if (!isTimestamp(value)) throw new CoordinationError("invalid_arguments", "at must be an RFC 3339 timestamp");
  return value;
}

function requestedTtl(value: unknown, allowDefault: boolean) {
  if (value === undefined && allowDefault) return artifactPreviewTtlPolicy.defaultSeconds;
  if (typeof value !== "number" || !Number.isSafeInteger(value)
    || value < artifactPreviewTtlPolicy.minimumSeconds || value > artifactPreviewTtlPolicy.maximumLifetimeSeconds) {
    throw new CoordinationError("invalid_arguments", "ttlSeconds is outside the preview TTL policy");
  }
  return value;
}

function normalizeRegistration(value: unknown, external: boolean): NormalizedPreviewRegistration {
  const input = record(value, "preview registration");
  onlyKeys(input, registrationKeys, "preview registration");
  const relativePath = boundedString(input.relativePath, "relativePath", previewBundleLimits.maximumPathBytes, false);
  const entrypoint = boundedString(input.entrypoint, "entrypoint", previewBundleLimits.maximumPathBytes, false);
  if (!validatePreviewBundlePath(relativePath).ok) {
    throw new CoordinationError("invalid_arguments", "relativePath is not a normalized relative preview path");
  }
  if (!validatePreviewBundlePath(entrypoint, { entrypoint: true }).ok) {
    throw new CoordinationError("invalid_arguments", "entrypoint is not a normalized relative HTML path");
  }
  if (input.kind !== previewBundleArtifactKind) {
    throw new CoordinationError("invalid_arguments", "kind must be preview-bundle");
  }
  if (input.mediaType !== previewBundleMediaType) {
    throw new CoordinationError("invalid_arguments", "mediaType must be the preview bundle media type");
  }
  if (typeof input.size !== "number" || !Number.isSafeInteger(input.size)
    || input.size <= 0 || input.size > previewBundleLimits.maximumCompressedBytes) {
    throw new CoordinationError("invalid_arguments", "size is outside the preview bundle limit");
  }
  if (typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256)) {
    throw new CoordinationError("invalid_arguments", "sha256 must be a lowercase SHA-256 digest");
  }
  if (input.summary !== undefined && typeof input.summary !== "string") {
    throw new CoordinationError("invalid_arguments", "summary must be a string");
  }
  const summary = typeof input.summary === "string" ? input.summary.trim() : "";
  if (external && Buffer.byteLength(summary) > 2_000) {
    throw new CoordinationError("invalid_arguments", "summary exceeds its limit");
  }
  return {
    relativePath,
    title: boundedString(input.title, "title", 256, true, external),
    kind: previewBundleArtifactKind,
    mediaType: previewBundleMediaType,
    summary: external ? summary : summary.slice(0, 2_000),
    size: input.size,
    sha256: input.sha256,
    entrypoint,
    ttlSeconds: requestedTtl(input.ttlSeconds, true),
    idempotencyKey: boundedString(input.idempotencyKey, "idempotencyKey", 128, true, external)
  };
}

function normalizeSettlement(value: unknown): NormalizedProcessingSettlement {
  const input = record(value, "preview processing result");
  onlyKeys(input, settlementKeys, "preview processing result");
  const outcome = input.outcome;
  if (outcome !== "ready" && outcome !== "failed") {
    throw new CoordinationError("invalid_arguments", "outcome must be ready or failed");
  }
  if (outcome === "ready" && input.failureCode !== undefined) {
    throw new CoordinationError("invalid_arguments", "a ready result cannot carry a failure code");
  }
  if (outcome === "failed" && !isArtifactPreviewFailureCode(input.failureCode)) {
    throw new CoordinationError("invalid_arguments", "a failed result requires a known failure code");
  }
  if (typeof input.artifactSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.artifactSha256)) {
    throw new CoordinationError("invalid_arguments", "artifactSha256 must be a lowercase SHA-256 digest");
  }
  if (typeof input.processingGeneration !== "number" || !Number.isSafeInteger(input.processingGeneration)
    || input.processingGeneration < 1) {
    throw new CoordinationError("invalid_arguments", "processingGeneration must be a positive integer");
  }
  return {
    previewId: boundedString(input.previewId, "previewId", 256),
    artifactId: boundedString(input.artifactId, "artifactId", 256),
    artifactSha256: input.artifactSha256,
    processingGeneration: input.processingGeneration,
    outcome,
    ...(outcome === "failed" ? { failureCode: input.failureCode as ArtifactPreviewFailureCode } : {}),
    at: operationTime(input.at)
  };
}

function publicPreview(preview: ArtifactPreviewRecord, now: string): ArtifactPreview {
  return structuredClone({ ...preview, accessState: artifactPreviewAccessState(preview, now) });
}

function settledPreview(
  preview: ArtifactPreviewRecord,
  receipt: PreviewProcessingReceipt,
  now: string
): ArtifactPreview {
  const settled: ArtifactPreviewRecord = {
    id: preview.id,
    artifactId: preview.artifactId,
    artifactSha256: preview.artifactSha256,
    threadId: preview.threadId,
    ...(preview.runId === undefined ? { sourceKey: preview.sourceKey! } : { runId: preview.runId }),
    ...(preview.agentId === undefined ? {} : { agentId: preview.agentId }),
    ...(preview.instanceId === undefined ? {} : { instanceId: preview.instanceId }),
    ...(preview.allocationId === undefined ? {} : { allocationId: preview.allocationId }),
    entrypoint: preview.entrypoint,
    status: receipt.outcome,
    processingGeneration: receipt.processingGeneration,
    createdAt: preview.createdAt,
    updatedAt: receipt.settledAt,
    expiresAt: receipt.expiresAt,
    ...(receipt.outcome === "ready"
      ? { readyAt: receipt.settledAt }
      : { failedAt: receipt.settledAt, failureCode: receipt.failureCode! })
  };
  return publicPreview(settled, now);
}

function previewIn(state: State, previewId: string) {
  const preview = state.artifactPreviews?.find((item) => item.id === previewId);
  if (!preview) throw new CoordinationError("not_found", "Preview not found");
  return preview;
}

function artifactFor(state: State, preview: ArtifactPreviewRecord) {
  const artifact = state.artifacts?.find((item) => item.id === preview.artifactId);
  if (!artifact || artifact.kind !== previewBundleArtifactKind || artifact.mediaType !== previewBundleMediaType
    || artifact.sha256 !== preview.artifactSha256 || artifact.threadId !== preview.threadId
    || !sameArtifactSource(artifact, preview)) {
    throw new CoordinationError("inconsistent_state", "The preview artifact identity is unavailable", true);
  }
  return artifact;
}

function assertMonotonicTime(preview: ArtifactPreviewRecord, atValue: string) {
  if (Date.parse(atValue) < Date.parse(preview.updatedAt)) {
    throw new CoordinationError("invalid_arguments", "The operation timestamp predates committed preview state");
  }
}

function expirePreviewInState(preview: ArtifactPreviewRecord, atValue: string) {
  if (preview.status === "expired" || Date.parse(atValue) < Date.parse(preview.expiresAt)) return false;
  preview.status = "expired";
  preview.updatedAt = atValue;
  preview.expiredAt = atValue;
  delete preview.readyAt;
  delete preview.failedAt;
  delete preview.failureCode;
  return true;
}

/**
 * The only creation authority for preview-bundle artifacts. Artifact, lifecycle record, audit
 * event, and source-scoped receipt commit in one Store transaction.
 */
export async function registerPreviewForSource(
  store: Store,
  source: CallerSource,
  argumentsValue: unknown,
  atValue = new Date().toISOString()
) {
  const input = normalizeRegistration(argumentsValue, source.kind === "external");
  const at = operationTime(atValue);
  let result: {
    artifact: Artifact;
    preview: ArtifactPreview;
    uploadPath: string;
    created: boolean;
    uploadGrant?: ArtifactUploadGrant;
  } | undefined;
  await store.transact((state) => {
    state.artifacts ??= [];
    state.artifactPreviews ??= [];
    state.previewRegistrationReceipts ??= [];
    state.previewProcessingReceipts ??= [];
    const caller = resolveCallerFor(state, source);
    if (caller.thread.status !== "active") throw new CoordinationError("thread_inactive", "Previews require an active thread");
    if (Date.parse(at) < Date.parse(caller.thread.createdAt)) {
      throw new CoordinationError("invalid_arguments", "The registration timestamp predates its thread");
    }
    const run = caller.principal.kind === "run" ? caller.principal.run : undefined;
    if (run !== undefined && Date.parse(at) < Date.parse(run.createdAt)) {
      throw new CoordinationError("invalid_arguments", "The registration timestamp predates its source run");
    }
    if (caller.principal.kind === "external"
      && (Date.parse(at) < Date.parse(caller.principal.client.createdAt)
        || Date.parse(at) < Date.parse(caller.principal.attachment.attachedAt)
        || Date.parse(at) < Date.parse(caller.principal.attachment.lastHeartbeatAt))) {
      throw new CoordinationError("invalid_arguments", "The registration timestamp predates its external caller authority");
    }
    const attribution = callerAttribution(caller);
    const digest = previewRegistrationDigest({
      sourceKey: caller.sourceKey, threadId: caller.thread.id, ...(run === undefined ? {} : { runId: run.id, ...attribution }),
      idempotencyKey: input.idempotencyKey, relativePath: input.relativePath, title: input.title,
      kind: input.kind, mediaType: input.mediaType, summary: input.summary, size: input.size,
      sha256: input.sha256, entrypoint: input.entrypoint, ttlSeconds: input.ttlSeconds
    });
    const existingReceipt = state.previewRegistrationReceipts
      .find((receipt) => receipt.sourceKey === caller.sourceKey && receipt.idempotencyKey === input.idempotencyKey);
    if (existingReceipt) {
      if (existingReceipt.digest !== digest) {
        throw new CoordinationError("idempotency_conflict", "The idempotency key was already used with a different preview request");
      }
      const preview = state.artifactPreviews.find((item) => item.id === existingReceipt.previewId);
      if (!preview || preview.artifactId !== existingReceipt.artifactId) {
        throw new CoordinationError("inconsistent_state", "The prior preview registration is unavailable", true);
      }
      const artifact = artifactFor(state, preview);
      const uploadGrant = caller.principal.kind === "external" && !artifact.uploaded
        ? issueArtifactUploadGrantInState(state, artifact, caller.principal.client.id, at)
        : undefined;
      result = {
        artifact: structuredClone(artifact), preview: publicPreview(preview, at), uploadPath: artifact.downloadPath, created: false,
        ...(uploadGrant === undefined ? {} : { uploadGrant })
      };
      return uploadGrant !== undefined;
    }
    if (state.artifacts.some((artifact) => artifactSourceKey(artifact) === caller.sourceKey
      && artifact.idempotencyKey === input.idempotencyKey)) {
      throw new CoordinationError("idempotency_conflict", "The idempotency key was already used by another artifact registration");
    }

    const artifact: Artifact = {
      id: newId("artifact"), threadId: caller.thread.id,
      ...(run === undefined ? { sourceKey: caller.sourceKey } : { runId: run.id, ...attribution }),
      relativePath: input.relativePath, title: input.title, kind: previewBundleArtifactKind,
      mediaType: previewBundleMediaType, summary: input.summary, size: input.size, sha256: input.sha256,
      downloadPath: "", uploaded: false, idempotencyKey: input.idempotencyKey, createdAt: at
    };
    artifact.downloadPath = `/api/artifacts/${encodeURIComponent(artifact.id)}/content`;
    const preview: ArtifactPreviewRecord = {
      id: newId("preview"), artifactId: artifact.id, artifactSha256: artifact.sha256,
      threadId: caller.thread.id,
      ...(run === undefined ? { sourceKey: caller.sourceKey } : { runId: run.id, ...attribution }),
      entrypoint: input.entrypoint,
      status: "upload-pending", processingGeneration: 0, createdAt: at, updatedAt: at,
      expiresAt: new Date(Date.parse(at) + input.ttlSeconds * 1_000).toISOString()
    };
    const receipt: PreviewRegistrationReceipt = {
      id: newId("previewreg"), sourceKey: caller.sourceKey, idempotencyKey: input.idempotencyKey,
      digest, ttlSeconds: input.ttlSeconds, artifactId: artifact.id, previewId: preview.id, createdAt: at
    };
    state.artifacts.unshift(artifact);
    // State is Snapshot-compatible for read-only consumers; persisted records intentionally omit
    // the projection-only accessState that Store.snapshot() derives.
    state.artifactPreviews.unshift(preview as ArtifactPreview);
    state.previewRegistrationReceipts.push(receipt);
    const uploadGrant = caller.principal.kind === "external"
      ? issueArtifactUploadGrantInState(state, artifact, caller.principal.client.id, at)
      : undefined;
    caller.thread.updatedAt = at;
    state.events.unshift({
      id: newId("evt"), type: "status", title: "Preview registered",
      detail: `${input.title} · ${input.size} bytes`, threadId: caller.thread.id,
      ...(run === undefined ? {} : { ...attribution, runId: run.id }), createdAt: at
    });
    result = {
      artifact: structuredClone(artifact), preview: publicPreview(preview, at), uploadPath: artifact.downloadPath, created: true,
      ...(uploadGrant === undefined ? {} : { uploadGrant })
    };
  });
  if (!result) throw new CoordinationError("persistence_failed", "The preview was not registered", true);
  return result;
}

/** Run-scoped compatibility wrapper; its digest and public result remain byte-for-byte unchanged. */
export async function registerPreview(
  store: Store,
  sourceRunId: string,
  argumentsValue: unknown,
  atValue = new Date().toISOString()
) {
  return await registerPreviewForSource(store, runSource(sourceRunId), argumentsValue, atValue);
}

/** Starts generation one or explicitly retries a failed preview with a fresh generation. */
export async function beginProcessing(store: Store, previewIdValue: string, atValue = new Date().toISOString()) {
  const previewId = boundedString(previewIdValue, "previewId", 256);
  const at = operationTime(atValue);
  let result: { preview: ArtifactPreview; generation: number; replayed: boolean } | undefined;
  let expired = false;
  await store.transact((state) => {
    const preview = previewIn(state, previewId);
    assertMonotonicTime(preview, at);
    if (preview.status === "expired") throw new CoordinationError("preview_expired", "The preview has expired");
    if (expirePreviewInState(preview, at)) { expired = true; return; }
    const artifact = artifactFor(state, preview);
    if (!artifact.uploaded) throw new CoordinationError("artifact_not_uploaded", "The preview bundle has not been uploaded");
    if (preview.status === "processing") {
      result = { preview: publicPreview(preview, at), generation: preview.processingGeneration, replayed: true };
      return false;
    }
    if (preview.status !== "upload-pending" && preview.status !== "failed") {
      throw new CoordinationError("invalid_transition", "The preview cannot begin processing from its current status");
    }
    preview.status = "processing";
    preview.processingGeneration += 1;
    preview.updatedAt = at;
    delete preview.readyAt;
    delete preview.failedAt;
    delete preview.failureCode;
    delete preview.expiredAt;
    result = { preview: publicPreview(preview, at), generation: preview.processingGeneration, replayed: false };
  });
  if (expired) throw new CoordinationError("preview_expired", "The preview expired before processing began");
  if (!result) throw new CoordinationError("persistence_failed", "Preview processing did not begin", true);
  return result;
}

/** Records an explicit failure before processing (for example, an upload that cannot complete). */
export async function failPreview(
  store: Store,
  previewIdValue: string,
  failureCodeValue: ArtifactPreviewFailureCode,
  atValue = new Date().toISOString()
) {
  const previewId = boundedString(previewIdValue, "previewId", 256);
  if (!isArtifactPreviewFailureCode(failureCodeValue)) {
    throw new CoordinationError("invalid_arguments", "failureCode is not recognized");
  }
  const at = operationTime(atValue);
  let result: { preview: ArtifactPreview; replayed: boolean } | undefined;
  let expired = false;
  await store.transact((state) => {
    const preview = previewIn(state, previewId);
    assertMonotonicTime(preview, at);
    if (preview.status === "expired") throw new CoordinationError("preview_expired", "The preview has expired");
    if (expirePreviewInState(preview, at)) { expired = true; return; }
    if (preview.status === "failed" && preview.processingGeneration === 0) {
      if (preview.failureCode !== failureCodeValue) {
        throw new CoordinationError("idempotency_conflict", "The preview already failed with another code");
      }
      result = { preview: publicPreview(preview, at), replayed: true };
      return false;
    }
    if (preview.status !== "upload-pending") {
      throw new CoordinationError("invalid_transition", "Only an upload-pending preview accepts an explicit pre-processing failure");
    }
    preview.status = "failed";
    preview.failedAt = at;
    preview.failureCode = failureCodeValue;
    preview.updatedAt = at;
    result = { preview: publicPreview(preview, at), replayed: false };
  });
  if (expired) throw new CoordinationError("preview_expired", "The preview expired before the failure was recorded");
  if (!result) throw new CoordinationError("persistence_failed", "The preview failure was not recorded", true);
  return result;
}

/** Settles only the exact current processing generation and records one durable normalized receipt. */
export async function settleProcessing(store: Store, value: unknown) {
  const input = normalizeSettlement(value);
  const digest = previewProcessingDigest(input);
  let result: { preview: ArtifactPreview; replayed: boolean } | undefined;
  let expired = false;
  await store.transact((state) => {
    state.previewProcessingReceipts ??= [];
    const receipt = state.previewProcessingReceipts.find((item) =>
      item.previewId === input.previewId && item.processingGeneration === input.processingGeneration);
    if (receipt) {
      if (receipt.digest !== digest) {
        throw new CoordinationError("idempotency_conflict", "This preview generation already settled with another result");
      }
      const preview = previewIn(state, input.previewId);
      artifactFor(state, preview);
      result = { preview: settledPreview(preview, receipt, input.at), replayed: true };
      return false;
    }

    const preview = previewIn(state, input.previewId);
    assertMonotonicTime(preview, input.at);
    if (preview.status === "expired") throw new CoordinationError("preview_expired", "The preview has expired");
    if (expirePreviewInState(preview, input.at)) { expired = true; return; }
    if (preview.artifactId !== input.artifactId || preview.artifactSha256 !== input.artifactSha256) {
      throw new CoordinationError("artifact_mismatch", "The processing result names another artifact");
    }
    if (input.processingGeneration !== preview.processingGeneration) {
      throw new CoordinationError("generation_mismatch", "The processing result is stale or from a future generation");
    }
    if (preview.status !== "processing") {
      throw new CoordinationError("invalid_transition", "The preview is not processing");
    }
    const artifact = artifactFor(state, preview);
    if (!artifact.uploaded) throw new CoordinationError("artifact_not_uploaded", "The preview artifact is no longer uploaded");

    preview.status = input.outcome;
    preview.updatedAt = input.at;
    if (input.outcome === "ready") {
      preview.readyAt = input.at;
      delete preview.failedAt;
      delete preview.failureCode;
    } else {
      preview.failedAt = input.at;
      preview.failureCode = input.failureCode!;
      delete preview.readyAt;
    }
    const processingReceipt: PreviewProcessingReceipt = {
      id: newId("previewproc"), previewId: preview.id, artifactId: artifact.id,
      artifactSha256: artifact.sha256, processingGeneration: preview.processingGeneration,
      outcome: input.outcome, ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
      digest, settledAt: input.at, expiresAt: preview.expiresAt
    };
    state.previewProcessingReceipts.push(processingReceipt);
    result = { preview: publicPreview(preview, input.at), replayed: false };
  });
  if (expired) throw new CoordinationError("preview_expired", "The preview expired before the processing result arrived");
  if (!result) throw new CoordinationError("persistence_failed", "The processing result was not recorded", true);
  return result;
}

/** Operator-facing renewal service. It returns lifecycle metadata and never issues access authority. */
export async function renewPreview(
  store: Store,
  previewIdValue: string,
  ttlSecondsValue: unknown,
  atValue = new Date().toISOString()
) {
  const previewId = boundedString(previewIdValue, "previewId", 256);
  const ttlSeconds = requestedTtl(ttlSecondsValue, true);
  const at = operationTime(atValue);
  let result: ArtifactPreview | undefined;
  let expired = false;
  await store.transact((state) => {
    const preview = previewIn(state, previewId);
    assertMonotonicTime(preview, at);
    if (preview.status === "expired") throw new CoordinationError("preview_expired", "The preview has expired");
    if (expirePreviewInState(preview, at)) { expired = true; return; }
    if (preview.status === "failed") throw new CoordinationError("invalid_transition", "A failed preview cannot be renewed");
    if (preview.status !== "upload-pending" && preview.status !== "processing" && preview.status !== "ready") {
      throw new CoordinationError("invalid_transition", "The preview cannot be renewed from its current status");
    }
    const requestedExpiry = Date.parse(at) + ttlSeconds * 1_000;
    const maximumExpiry = Date.parse(preview.createdAt) + artifactPreviewTtlPolicy.maximumLifetimeSeconds * 1_000;
    if (requestedExpiry > maximumExpiry) {
      throw new CoordinationError("ttl_out_of_bounds", "The renewal exceeds the preview's maximum absolute lifetime");
    }
    if (requestedExpiry <= Date.parse(preview.expiresAt)) {
      throw new CoordinationError("expiry_not_extended", "The renewal must extend the preview expiry");
    }
    preview.expiresAt = new Date(requestedExpiry).toISOString();
    preview.updatedAt = at;
    result = publicPreview(preview, at);
  });
  if (expired) throw new CoordinationError("preview_expired", "The preview expired before it could be renewed");
  if (!result) throw new CoordinationError("persistence_failed", "The preview was not renewed", true);
  return result;
}

/** Expires every due non-terminal preview inside one serialized transaction. */
export async function expireDuePreviews(store: Store, atValue = new Date().toISOString()) {
  const at = operationTime(atValue);
  let expired = 0;
  await store.transact((state) => {
    for (const preview of state.artifactPreviews ?? []) {
      if (expirePreviewInState(preview, at)) expired += 1;
    }
    if (expired === 0) return false;
  });
  return expired;
}
