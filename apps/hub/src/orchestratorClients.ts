import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Express, RequestHandler } from "express";
import {
  isOrchestratorClientScope,
  orchestratorClientScopes,
  type OrchestratorClient,
  type OrchestratorClientCloseReason,
  type OrchestratorClientScope,
  type Validation
} from "@coffee-shop/protocol";
import { publicOrchestratorClient, type State, type Store, type StoredOrchestratorClient } from "./store.js";

/*
 * Orchestrator client credentials.
 *
 * An operator mints a credential in the PWA, hands it to one external orchestrator bridge, and
 * revokes it when that machine should no longer drive threads. The hub shows the secret exactly
 * once, at mint time, and keeps only its SHA-256 digest: a leaked state file therefore cannot be
 * replayed as a credential. Every verification failure reports the same `unauthorized` result over
 * the same comparison path, so a caller learns nothing about which part of the credential was
 * wrong. Revocation is permanent; there is no call that clears `revokedAt`.
 *
 * The `resolve-approvals` scope lives on the credential rather than on anything the orchestrator
 * says, so a model driving the bridge can never grant itself approval authority.
 */

/** `csoc_<clientId>_<43 base64url characters>`. The client id never contains `_`, so the parse is unambiguous. */
export const orchestratorClientSecretPrefix = "csoc";
export const orchestratorClientSecretBytes = 32;
export const orchestratorClientNameLimit = 64;
const secretRandomLength = Math.ceil((orchestratorClientSecretBytes * 4) / 3);
const secretPattern = new RegExp(`^${orchestratorClientSecretPrefix}_([A-Za-z0-9-]{1,128})_([A-Za-z0-9_-]{${secretRandomLength}})$`);
const clientIdPrefix = "orchestrator-client";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const hashSecret = (secret: string) => `sha256:${createHash("sha256").update(secret).digest("hex")}`;

/**
 * A stand-in digest used when no client answers to the presented id, so an unknown client costs the
 * same digest and comparison as a wrong secret. It can never match: it hashes bytes no minted
 * secret contains, and is the same length as every hash this module writes.
 */
const decoyHash = hashSecret(`${orchestratorClientSecretPrefix}::absent-client`);

/**
 * Compares two digests without revealing where they first differ. Differing lengths still run a
 * comparison so a stored digest written by an older or hand-edited state file is not a timing
 * oracle, and `timingSafeEqual` is never handed buffers it would reject.
 */
export function constantTimeEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    timingSafeEqual(rightBuffer, rightBuffer);
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

/** Scopes in their declared order, without repeats. `orchestrate` is what every credential is for. */
const normalizeScopes = (scopes: readonly OrchestratorClientScope[]): OrchestratorClientScope[] => {
  const requested = new Set<OrchestratorClientScope>([...scopes, "orchestrate"]);
  return orchestratorClientScopes.filter((scope) => requested.has(scope));
};

const clients = (state: State) => state.orchestratorClients ?? (state.orchestratorClients = []);
const findClient = (state: State, clientId: string) => clients(state).find((client) => client.id === clientId);

export interface OrchestratorClientInput {
  name: string;
  scopes: OrchestratorClientScope[];
}

const parseName = (value: unknown): Validation<string> => {
  if (typeof value !== "string") return { ok: false, reason: "name must be a string" };
  if (value.trim().length === 0) return { ok: false, reason: "name must not be blank" };
  if ([...value].length > orchestratorClientNameLimit) return { ok: false, reason: `name must be at most ${orchestratorClientNameLimit} characters` };
  if (/\p{C}/u.test(value)) return { ok: false, reason: "name must contain only printable characters" };
  return { ok: true, value };
};

/**
 * Parses a requested scope list. An absent list grants the least authority the hub can grant rather
 * than a default the operator did not ask for; an unrecognized scope is refused outright, because a
 * guessed scope could hand out approval authority.
 */
const parseScopes = (value: unknown): Validation<OrchestratorClientScope[]> => {
  if (value === undefined) return { ok: true, value: normalizeScopes([]) };
  if (!Array.isArray(value)) return { ok: false, reason: "scopes must be an array" };
  if (!value.every(isOrchestratorClientScope)) return { ok: false, reason: `scopes must be drawn from ${orchestratorClientScopes.join(", ")}` };
  return { ok: true, value: normalizeScopes(value) };
};

/** Parses a mint request body. */
export function parseOrchestratorClientInput(value: unknown): Validation<OrchestratorClientInput> {
  const allowed = ["name", "scopes"];
  if (!isRecord(value) || !Object.keys(value).every((key) => allowed.includes(key))) {
    return { ok: false, reason: "The credential must contain only name and scopes" };
  }
  const name = parseName(value.name);
  if (!name.ok) return name;
  const scopes = parseScopes(value.scopes);
  if (!scopes.ok) return scopes;
  return { ok: true, value: { name: name.value, scopes: scopes.value } };
}

/** Parses a scope-change request body. A scope change carries scopes and nothing else. */
export function parseOrchestratorClientScopes(value: unknown): Validation<OrchestratorClientScope[]> {
  if (!isRecord(value) || !Object.keys(value).every((key) => key === "scopes")) {
    return { ok: false, reason: "The scope change must contain only scopes" };
  }
  return parseScopes(value.scopes);
}

export interface MintedOrchestratorClient {
  client: OrchestratorClient;
  /** Shown to the operator exactly once; the hub keeps only its digest. */
  secret: string;
}

export function mintOrchestratorClient(state: State, input: OrchestratorClientInput, at: string): MintedOrchestratorClient {
  const id = `${clientIdPrefix}-${randomBytes(8).toString("hex")}`;
  const secret = `${orchestratorClientSecretPrefix}_${id}_${randomBytes(orchestratorClientSecretBytes).toString("base64url")}`;
  const stored: StoredOrchestratorClient = {
    id,
    name: input.name,
    scopes: normalizeScopes(input.scopes),
    secretHash: hashSecret(secret),
    createdAt: at
  };
  clients(state).push(stored);
  return { client: publicOrchestratorClient(stored), secret };
}

export type OrchestratorClientVerificationFailure = Extract<OrchestratorClientCloseReason, "unauthorized" | "revoked">;

export type OrchestratorClientVerification =
  | { ok: true; client: OrchestratorClient }
  | { ok: false; reason: OrchestratorClientVerificationFailure };

/**
 * Verifies a presented credential. A wrong secret, an unknown client, and a malformed secret all
 * take the same digest-and-compare path and return the same `unauthorized` result. Revocation is
 * reported only once the secret itself matched, so the status of a credential is never disclosed to
 * a caller that does not already hold it.
 */
export function verifyOrchestratorClient(state: State, clientId: string, secret: string): OrchestratorClientVerification {
  const parsed = secretPattern.exec(secret);
  const client = findClient(state, clientId);
  const matches = constantTimeEquals(client?.secretHash ?? decoyHash, hashSecret(secret));
  const identifies = parsed !== null && parsed[1] === clientId;
  if (client === undefined || !matches || !identifies) return { ok: false, reason: "unauthorized" };
  if (client.revokedAt !== undefined) return { ok: false, reason: "revoked" };
  return { ok: true, client: publicOrchestratorClient(client) };
}

export type OrchestratorClientScopeChange =
  | { kind: "updated"; client: OrchestratorClient }
  | { kind: "revoked"; client: OrchestratorClient }
  | { kind: "not-found" };

/** Replaces a live credential's scopes. A revoked credential keeps the scopes it had. */
export function updateOrchestratorClientScopes(state: State, clientId: string, scopes: readonly OrchestratorClientScope[]): OrchestratorClientScopeChange {
  const client = findClient(state, clientId);
  if (client === undefined) return { kind: "not-found" };
  if (client.revokedAt !== undefined) return { kind: "revoked", client: publicOrchestratorClient(client) };
  client.scopes = normalizeScopes(scopes);
  return { kind: "updated", client: publicOrchestratorClient(client) };
}

export type OrchestratorClientRevocation =
  | { kind: "revoked"; client: OrchestratorClient }
  | { kind: "already-revoked"; client: OrchestratorClient }
  | { kind: "not-found" };

/** Revokes a credential permanently. Replaying the call keeps the first revocation's timestamp. */
export function revokeOrchestratorClient(state: State, clientId: string, at: string): OrchestratorClientRevocation {
  const client = findClient(state, clientId);
  if (client === undefined) return { kind: "not-found" };
  if (client.revokedAt !== undefined) return { kind: "already-revoked", client: publicOrchestratorClient(client) };
  client.revokedAt = at;
  return { kind: "revoked", client: publicOrchestratorClient(client) };
}

/** Records that a live credential was used. Returns whether the stored record changed. */
export function touchOrchestratorClient(state: State, clientId: string, lastSeenAt: string) {
  const client = findClient(state, clientId);
  if (client === undefined || client.revokedAt !== undefined || client.lastSeenAt === lastSeenAt) return false;
  client.lastSeenAt = lastSeenAt;
  return true;
}

/** The public view of every credential, newest last, as minted. */
export function listOrchestratorClients(state: State): OrchestratorClient[] {
  return clients(state).map(publicOrchestratorClient);
}

export type OrchestratorClientRevocationListener = (clientId: string) => void;

export interface OrchestratorClientRevocations {
  /** Subscribes to revocations; the returned function unsubscribes. */
  onOrchestratorClientRevoked(listener: OrchestratorClientRevocationListener): () => void;
  notifyOrchestratorClientRevoked(clientId: string): void;
}

/**
 * The hub-internal revocation hook. The orchestrator-client gateway subscribes to close the live
 * sockets of a revoked credential; a failing listener never fails the revocation, which is already
 * persisted by the time listeners run.
 */
export function createOrchestratorClientRevocations(): OrchestratorClientRevocations {
  const listeners = new Set<OrchestratorClientRevocationListener>();
  return {
    onOrchestratorClientRevoked(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notifyOrchestratorClientRevoked(clientId) {
      for (const listener of [...listeners]) {
        try {
          listener(clientId);
        } catch (error) {
          console.error("orchestrator client revocation listener failed", error);
        }
      }
    }
  };
}

/**
 * The hub's operator authentication: a shared bearer token on every `/api/` route but health, and
 * only when the hub runs in production. A hub started in production without a configured token
 * refuses every API request rather than serving them unauthenticated.
 */
export function operatorCredentialGuard(token: string | undefined): RequestHandler {
  return (request, response, next) => {
    if (!request.path.startsWith("/api/") || request.path === "/api/health" || process.env.NODE_ENV !== "production") return next();
    const supplied = request.header("authorization")?.replace(/^Bearer\s+/i, "") ?? request.query.token;
    if (!token || supplied !== token) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };
}

export interface OrchestratorClientRouteDependencies {
  store: Store;
  broadcast: () => void;
  revocations: OrchestratorClientRevocations;
}

/** Operator endpoints for the credential lifecycle, behind the hub's existing bearer auth. */
export function registerOrchestratorClientRoutes(app: Express, { store, broadcast, revocations }: OrchestratorClientRouteDependencies) {
  app.post("/api/orchestrator-clients", async (request, response) => {
    const input = parseOrchestratorClientInput(request.body);
    if (!input.ok) return response.status(422).json({ error: input.reason });
    let minted: MintedOrchestratorClient | undefined;
    try {
      await store.transact((state) => {
        minted = mintOrchestratorClient(state, input.value, new Date().toISOString());
      });
    } catch (error) {
      console.error("orchestrator client could not be minted", error);
      return response.status(500).json({ error: "The orchestrator client could not be persisted" });
    }
    broadcast();
    // The only time the secret leaves the hub: it is not persisted, logged, or published again.
    response.status(201).json({ client: minted!.client, secret: minted!.secret });
  });

  app.get("/api/orchestrator-clients", (_request, response) => {
    response.json({ clients: store.read((state) => structuredClone(listOrchestratorClients(state))) });
  });

  app.patch("/api/orchestrator-clients/:id", async (request, response) => {
    const scopes = parseOrchestratorClientScopes(request.body);
    if (!scopes.ok) return response.status(422).json({ error: scopes.reason });
    let result: OrchestratorClientScopeChange = { kind: "not-found" };
    try {
      await store.transact((state) => {
        result = updateOrchestratorClientScopes(state, request.params.id, scopes.value);
        return result.kind === "updated";
      });
    } catch (error) {
      console.error("orchestrator client scopes could not be changed", error);
      return response.status(500).json({ error: "The orchestrator client scopes could not be persisted" });
    }
    const change = result as OrchestratorClientScopeChange;
    if (change.kind === "not-found") return response.status(404).json({ error: "Orchestrator client not found" });
    if (change.kind === "revoked") return response.status(409).json({ error: "The orchestrator client is revoked", client: change.client });
    broadcast();
    response.json({ client: change.client });
  });

  app.post("/api/orchestrator-clients/:id/revoke", async (request, response) => {
    let result: OrchestratorClientRevocation = { kind: "not-found" };
    try {
      await store.transact((state) => {
        result = revokeOrchestratorClient(state, request.params.id, new Date().toISOString());
        return result.kind === "revoked";
      });
    } catch (error) {
      console.error("orchestrator client could not be revoked", error);
      return response.status(500).json({ error: "The orchestrator client revocation could not be persisted" });
    }
    const revocation = result as OrchestratorClientRevocation;
    if (revocation.kind === "not-found") return response.status(404).json({ error: "Orchestrator client not found" });
    if (revocation.kind === "revoked") {
      broadcast();
      // Revocation is persisted before live sockets are told, so a listener never races the record.
      revocations.notifyOrchestratorClientRevoked(revocation.client.id);
    }
    response.json({ client: revocation.client });
  });
}
