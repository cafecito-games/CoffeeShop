import { createHash, randomBytes } from "node:crypto";
import {
  artifactSource,
  isTimestamp,
  orchestratorClientSourceKey,
  type Artifact
} from "@coffee-shop/protocol";
import type { State, Store } from "./store.js";

export const artifactUploadGrantLifetimeMilliseconds = 5 * 60 * 1_000;
export const artifactUploadGrantEntropyBytes = 32;

export interface ArtifactUploadGrantRecord {
  tokenDigest: string;
  artifactId: string;
  clientId: string;
  threadId: string;
  sourceKey: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
  revokedAt?: string;
}

export interface ArtifactUploadGrant {
  path: string;
  token: string;
  expiresAt: string;
}

type EntropySource = (size: number) => Buffer;
const tokenDigest = (token: string) => createHash("sha256").update(token).digest("hex");
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

/** Mints or refreshes one transport capability inside the registration transaction. */
export function issueArtifactUploadGrantInState(
  state: State,
  artifact: Artifact,
  clientId: string,
  at: string,
  entropy: EntropySource = randomBytes
): ArtifactUploadGrant {
  const source = artifactSource(artifact);
  if (!source.ok || source.value.kind !== "external" || source.value.clientId !== clientId
    || artifact.threadId === undefined || artifact.uploaded) {
    throw new Error("An upload grant requires one unuploaded external artifact");
  }
  state.artifactUploadGrants ??= [];
  for (const grant of state.artifactUploadGrants) {
    if (grant.artifactId === artifact.id && grant.consumedAt === undefined && grant.revokedAt === undefined) grant.revokedAt = at;
  }
  const bytes = entropy(artifactUploadGrantEntropyBytes);
  if (!Buffer.isBuffer(bytes) || bytes.length !== artifactUploadGrantEntropyBytes) {
    throw new Error("Artifact upload grant entropy must be exactly 32 bytes");
  }
  const token = bytes.toString("base64url");
  const digest = tokenDigest(token);
  if (state.artifactUploadGrants.some((grant) => grant.tokenDigest === digest)) {
    throw new Error("Artifact upload grant entropy was reused");
  }
  const expiresAt = new Date(Date.parse(at) + artifactUploadGrantLifetimeMilliseconds).toISOString();
  state.artifactUploadGrants.push({
    tokenDigest: digest,
    artifactId: artifact.id,
    clientId,
    threadId: artifact.threadId,
    sourceKey: source.value.sourceKey,
    createdAt: at,
    expiresAt
  });
  return { path: artifact.downloadPath, token, expiresAt };
}

/** Marks every still-usable capability for a revoked credential without ever recovering a token. */
export function revokeArtifactUploadGrantsForClientInState(state: State, clientId: string, at: string) {
  let changed = false;
  for (const grant of state.artifactUploadGrants ?? []) {
    if (grant.clientId !== clientId || grant.consumedAt !== undefined || grant.revokedAt !== undefined) continue;
    grant.revokedAt = at;
    changed = true;
  }
  return changed;
}

/**
 * Claims before request-body ingestion. Store serialization makes concurrent attempts single-winner;
 * every invalid identity returns the same `false` and changes nothing.
 */
export async function claimArtifactUploadGrant(store: Store, artifactId: string, token: string, at = new Date().toISOString()) {
  if (!tokenPattern.test(token) || !isTimestamp(at)) return false;
  const digest = tokenDigest(token);
  let claimed = false;
  await store.transact((state) => {
    const grant = state.artifactUploadGrants?.find((candidate) =>
      candidate.artifactId === artifactId && candidate.tokenDigest === digest);
    if (!grant || grant.consumedAt !== undefined || grant.revokedAt !== undefined
      || Date.parse(at) < Date.parse(grant.createdAt) || Date.parse(at) >= Date.parse(grant.expiresAt)) return false;
    const client = state.orchestratorClients?.find((candidate) => candidate.id === grant.clientId && candidate.revokedAt === undefined);
    const artifacts = (state.artifacts ?? []).filter((candidate) => candidate.id === artifactId);
    const artifact = artifacts.length === 1 ? artifacts[0] : undefined;
    const source = artifact === undefined ? undefined : artifactSource(artifact);
    if (!client || !artifact || artifact.uploaded || artifact.threadId !== grant.threadId
      || !source?.ok || source.value.kind !== "external" || source.value.clientId !== grant.clientId
      || source.value.sourceKey !== grant.sourceKey || grant.sourceKey !== orchestratorClientSourceKey(grant.clientId)) return false;
    grant.consumedAt = at;
    claimed = true;
  });
  return claimed;
}

const recordKeys = [
  "tokenDigest", "artifactId", "clientId", "threadId", "sourceKey", "createdAt", "expiresAt", "consumedAt", "revokedAt"
] as const;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Rejects persisted capabilities that the Hub's own mint/claim paths could not have written. */
export function assertPersistedArtifactUploadGrantState(state: State) {
  if (!Array.isArray(state.artifactUploadGrants)) throw new Error("Persisted artifact upload grant collection is malformed");
  const digests = new Set<string>();
  const activeArtifacts = new Set<string>();
  for (const [index, value] of state.artifactUploadGrants.entries()) {
    const context = `Persisted artifact upload grant ${index}`;
    if (!isRecord(value) || Object.keys(value).some((key) => !recordKeys.includes(key as typeof recordKeys[number]))
      || typeof value.tokenDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.tokenDigest)
      || !["artifactId", "clientId", "threadId", "sourceKey"].every((key) => typeof value[key] === "string" && value[key] !== "")
      || !isTimestamp(value.createdAt) || !isTimestamp(value.expiresAt)
      || (value.consumedAt !== undefined && !isTimestamp(value.consumedAt))
      || (value.revokedAt !== undefined && !isTimestamp(value.revokedAt))) {
      throw new Error(`${context} is malformed`);
    }
    const grant = value as unknown as ArtifactUploadGrantRecord;
    if (digests.has(grant.tokenDigest)) throw new Error(`${context} repeats a token digest`);
    digests.add(grant.tokenDigest);
    const created = Date.parse(grant.createdAt);
    if (Date.parse(grant.expiresAt) !== created + artifactUploadGrantLifetimeMilliseconds
      || (grant.consumedAt !== undefined && Date.parse(grant.consumedAt) < created)
      || (grant.consumedAt !== undefined && Date.parse(grant.consumedAt) >= Date.parse(grant.expiresAt))
      || (grant.revokedAt !== undefined && Date.parse(grant.revokedAt) < created)
      || (grant.consumedAt !== undefined && grant.revokedAt !== undefined)) {
      throw new Error(`${context} has an invalid lifecycle`);
    }
    const client = state.orchestratorClients?.find((candidate) => candidate.id === grant.clientId);
    if (grant.sourceKey !== orchestratorClientSourceKey(grant.clientId) || !client
      || (client.revokedAt !== undefined && grant.consumedAt === undefined && grant.revokedAt === undefined)) {
      throw new Error(`${context} has an invalid client identity`);
    }
    const artifacts = (state.artifacts ?? []).filter((artifact) => artifact.id === grant.artifactId);
    const source = artifacts.length === 1 ? artifactSource(artifacts[0]) : undefined;
    if (!source?.ok || source.value.kind !== "external" || source.value.clientId !== grant.clientId
      || artifacts[0]!.threadId !== grant.threadId) {
      throw new Error(`${context} has an invalid artifact identity`);
    }
    if (Date.parse(grant.createdAt) < Date.parse(artifacts[0]!.createdAt)) {
      throw new Error(`${context} predates its artifact`);
    }
    if (grant.consumedAt === undefined && grant.revokedAt === undefined) {
      if (activeArtifacts.has(grant.artifactId)) throw new Error(`${context} repeats active artifact authority`);
      activeArtifacts.add(grant.artifactId);
    }
  }
}
