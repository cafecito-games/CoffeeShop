import { createHash } from "node:crypto";
import {
  containsSecretLikeValue,
  hostHarnessSessionLimits,
  validateHostSessionControlMessage,
  type HostSessionControlMessage
} from "@coffee-shop/protocol";
import {
  hostSessionHistoryReceiptLimit,
  hostSessionHistoryStorageLimits,
  type State,
  type StoredHostSessionHistory,
  type Store
} from "./store.js";
import type { HostSessionInventoryConnection, HostSessionInventoryOutcome } from "./hostSessionInventory.js";

interface ExpectedHistoryPage {
  hostHarnessSessionId: string;
  requestId: string;
  cursor?: string;
  nodeId: string;
  harnessId: string;
  providerSessionId: string;
  workspace: string;
  revision: number;
  limit: number;
}

const storedHistoryBytes = (history: StoredHostSessionHistory) => Buffer.byteLength(JSON.stringify(history), "utf8");
const compareCodeUnits = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

export function enforceHostSessionHistoryRetention(state: State, preservedHostHarnessSessionId: string) {
  const histories = state.hostSessionHistories!;
  let records = histories.length;
  let bytes = records === 0 ? 2 : histories.reduce((total, history) => total + storedHistoryBytes(history), 0) + records + 1;
  const attached = new Set(state.hostHarnessSessions!.filter((session) => session.attachedThreadId !== undefined)
    .map((session) => session.hostHarnessSessionId));
  const removable = histories.filter((history) => history.hostHarnessSessionId !== preservedHostHarnessSessionId)
    .sort((left, right) => Number(attached.has(left.hostHarnessSessionId)) - Number(attached.has(right.hostHarnessSessionId))
      || Date.parse(left.observedAt) - Date.parse(right.observedAt)
      || compareCodeUnits(left.hostHarnessSessionId, right.hostHarnessSessionId));
  const remove = new Set<string>();
  for (const history of removable) {
    if (records <= hostSessionHistoryStorageLimits.records && bytes <= hostSessionHistoryStorageLimits.bytes) break;
    remove.add(history.hostHarnessSessionId);
    records -= 1;
    bytes -= storedHistoryBytes(history) + (records >= 1 ? 1 : 0);
  }
  if (records > hostSessionHistoryStorageLimits.records || bytes > hostSessionHistoryStorageLimits.bytes) return false;
  state.hostSessionHistories = histories.filter((history) => !remove.has(history.hostHarnessSessionId));
  return true;
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, item]) => [key, canonical(item)]));
};

const digestPage = (page: Extract<HostSessionControlMessage, { type: "host-session.history.page" }>) => createHash("sha256")
  .update(JSON.stringify(canonical({
    nodeId: page.nodeId, hostHarnessSessionId: page.hostHarnessSessionId, requestId: page.requestId,
    items: page.items, nextCursor: page.nextCursor, truncated: page.truncated
  }))).digest("hex");

const validCorrelation = (value: string, maximum: number = hostHarnessSessionLimits.identifierBytes) =>
  value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum
  && !containsSecretLikeValue(value);

export class HostSessionHistoryAuthority {
  private readonly expected = new Map<string, Map<string, ExpectedHistoryPage>>();
  private readonly inFlight = new Map<string, Map<string, ExpectedHistoryPage>>();
  private readonly retired = new Map<string, Map<string, number>>();

  constructor(private readonly store: Store, private readonly now: () => number = Date.now) {}

  private key(connection: HostSessionInventoryConnection) {
    return `${connection.nodeId}\u0000${connection.generation}`;
  }

  discard(connection: HostSessionInventoryConnection) {
    const key = this.key(connection);
    const requests = this.expected.get(key);
    if (requests && requests.size > 0) {
      const retired = this.pruneRetired(connection.nodeId);
      const expiresAt = this.now() + hostHarnessSessionLimits.historyResponseWaitMilliseconds;
      for (const requestId of requests.keys()) retired.set(requestId, expiresAt);
      this.retired.set(connection.nodeId, retired);
    }
    this.expected.delete(key);
    this.inFlight.delete(key);
  }

  private pruneRetired(nodeId: string) {
    const retired = this.retired.get(nodeId) ?? new Map<string, number>();
    const now = this.now();
    for (const [requestId, expiresAt] of retired) if (expiresAt <= now) retired.delete(requestId);
    if (retired.size === 0) this.retired.delete(nodeId);
    return retired;
  }

  private nodeReadCount(nodeId: string) {
    const prefix = `${nodeId}\u0000`;
    let count = this.pruneRetired(nodeId).size;
    for (const [key, requests] of this.expected) if (key.startsWith(prefix)) count += requests.size;
    for (const [key, requests] of this.inFlight) if (key.startsWith(prefix)) count += requests.size;
    return count;
  }

  retiredSlotCount(nodeId: string) {
    return this.pruneRetired(nodeId).size;
  }

  connectionStateSize() {
    return new Set([...this.expected.keys(), ...this.inFlight.keys()]).size;
  }

  expect(
    connection: HostSessionInventoryConnection,
    hostHarnessSessionId: string,
    requestId: string,
    cursor?: string,
    limit: number = hostHarnessSessionLimits.historyItemsPerPage
  ) {
    if (!connection.supportsCapability || !connection.isCurrent() || !validCorrelation(requestId)
      || (cursor !== undefined && !validCorrelation(cursor, hostHarnessSessionLimits.historyCursorBytes))
      || !Number.isSafeInteger(limit) || limit < 1 || limit > hostHarnessSessionLimits.historyItemsPerPage) return false;
    const session = this.store.read((state) => state.hostHarnessSessions?.find((item) =>
      item.hostHarnessSessionId === hostHarnessSessionId && item.nodeId === connection.nodeId));
    if (!session) return false;
    const history = this.store.read((state) => state.hostSessionHistories?.find((item) =>
      item.hostHarnessSessionId === hostHarnessSessionId && item.revision === session.revision));
    if (cursor !== history?.nextCursor) return false;
    const connectionKey = this.key(connection);
    const requests = this.expected.get(connectionKey) ?? new Map<string, ExpectedHistoryPage>();
    const active = this.inFlight.get(connectionKey);
    if (this.nodeReadCount(connection.nodeId) >= hostHarnessSessionLimits.historyReadsPerNode
      || requests.has(requestId) || active?.has(requestId)
      || this.pruneRetired(connection.nodeId).has(requestId)
      || [...requests.values(), ...(active?.values() ?? [])]
        .some((request) => request.hostHarnessSessionId === hostHarnessSessionId)) return false;
    requests.set(requestId, {
      hostHarnessSessionId, requestId, cursor, nodeId: session.nodeId, harnessId: session.harnessId,
      providerSessionId: session.providerSessionId, workspace: session.workspace, revision: session.revision, limit
    });
    this.expected.set(connectionKey, requests);
    return true;
  }

  cancel(connection: HostSessionInventoryConnection, requestId: string) {
    const requests = this.expected.get(this.key(connection));
    requests?.delete(requestId);
    if (requests?.size === 0) this.expected.delete(this.key(connection));
  }

  rejectMalformed(connection: HostSessionInventoryConnection, candidate: unknown) {
    if (!connection.supportsCapability || !connection.isCurrent() || typeof candidate !== "object"
      || candidate === null || Array.isArray(candidate)) return false;
    const value = candidate as Record<string, unknown>;
    if (value.type !== "host-session.history.page" || value.nodeId !== connection.nodeId
      || typeof value.requestId !== "string" || !validCorrelation(value.requestId)
      || typeof value.hostHarnessSessionId !== "string" || !validCorrelation(value.hostHarnessSessionId)) return false;
    const expected = this.expected.get(this.key(connection))?.get(value.requestId);
    if (!expected || expected.hostHarnessSessionId !== value.hostHarnessSessionId) return false;
    this.expire(connection, value.requestId);
    return true;
  }

  expire(connection: HostSessionInventoryConnection, requestId: string) {
    const requests = this.expected.get(this.key(connection));
    if (!requests?.delete(requestId)) return;
    if (requests.size === 0) this.expected.delete(this.key(connection));
    const retired = this.pruneRetired(connection.nodeId);
    retired.set(requestId, this.now() + hostHarnessSessionLimits.historyResponseWaitMilliseconds);
    this.retired.set(connection.nodeId, retired);
  }

  isExpected(connection: HostSessionInventoryConnection, requestId: string) {
    const key = this.key(connection);
    return (this.expected.get(key)?.has(requestId) ?? false) || (this.inFlight.get(key)?.has(requestId) ?? false);
  }

  async receive(connection: HostSessionInventoryConnection, candidate: unknown): Promise<HostSessionInventoryOutcome> {
    if (!connection.supportsCapability || !connection.isCurrent() || connection.nodeId === "") {
      this.discard(connection);
      return { kind: "ignored", changed: false };
    }
    const validated = validateHostSessionControlMessage(candidate, "6");
    if (!validated.ok) {
      this.rejectMalformed(connection, candidate);
      return { kind: "rejected", changed: false, reason: validated.reason };
    }
    const message = validated.value;
    if (message.type !== "host-session.history.page") {
      return { kind: "rejected", changed: false, reason: "host-session frame is not history evidence" };
    }
    if (message.nodeId !== connection.nodeId) {
      const connectionKey = this.key(connection);
      const requests = this.expected.get(connectionKey);
      requests?.delete(message.requestId);
      if (requests?.size === 0) this.expected.delete(connectionKey);
      return { kind: "rejected", changed: false, reason: "host-session history names the wrong node" };
    }
    const digest = digestPage(message);
    const existingReceipt = this.store.read((state) => state.hostSessionHistories
      ?.find((history) => history.hostHarnessSessionId === message.hostHarnessSessionId
        && history.nodeId === connection.nodeId)
      ?.receipts.find((receipt) => receipt.requestId === message.requestId));
    if (existingReceipt) {
      return existingReceipt.digest === digest
        ? { kind: "replayed", changed: false }
        : { kind: "rejected", changed: false, reason: "host-session history replay conflicts with committed evidence" };
    }
    const retired = this.pruneRetired(connection.nodeId);
    if (retired.delete(message.requestId)) {
      if (retired.size === 0) this.retired.delete(connection.nodeId);
      return { kind: "ignored", changed: false };
    }
    const expected = this.expected.get(this.key(connection))?.get(message.requestId);
    if (!expected || expected.hostHarnessSessionId !== message.hostHarnessSessionId) {
      return { kind: "rejected", changed: false, reason: "host-session history has no matching request" };
    }
    if (message.items.length > expected.limit) {
      this.cancel(connection, message.requestId);
      return { kind: "rejected", changed: false, reason: "host-session history exceeds the requested item limit" };
    }
    const connectionKey = this.key(connection);
    const requests = this.expected.get(connectionKey)!;
    requests.delete(message.requestId);
    if (requests.size === 0) this.expected.delete(connectionKey);
    const active = this.inFlight.get(connectionKey) ?? new Map<string, ExpectedHistoryPage>();
    active.set(message.requestId, expected);
    this.inFlight.set(connectionKey, active);
    let outcome: HostSessionInventoryOutcome = { kind: "ignored", changed: false };
    try {
      await this.store.transact((state) => {
        if (!connection.isCurrent()) {
          outcome = { kind: "ignored", changed: false };
          return false;
        }
        const session = state.hostHarnessSessions!.find((item) => item.hostHarnessSessionId === message.hostHarnessSessionId);
        if (!session || session.nodeId !== expected.nodeId || session.harnessId !== expected.harnessId
          || session.providerSessionId !== expected.providerSessionId || session.workspace !== expected.workspace
          || session.revision !== expected.revision) {
          outcome = { kind: "rejected", changed: false, reason: "host-session history request identity is stale" };
          return false;
        }
        const index = state.hostSessionHistories!.findIndex((history) => history.hostHarnessSessionId === session.hostHarnessSessionId);
        const current = index < 0 ? undefined : state.hostSessionHistories![index]!;
        if (current && (current.nodeId !== session.nodeId || current.harnessId !== session.harnessId
          || current.providerSessionId !== session.providerSessionId || current.workspace !== session.workspace)) {
          outcome = { kind: "rejected", changed: false, reason: "host-session history immutable identity conflicts" };
          return false;
        }
        const currentRevision = current?.revision === session.revision ? current : undefined;
        if (expected.cursor !== currentRevision?.nextCursor) {
          outcome = { kind: "rejected", changed: false, reason: "host-session history cursor has a gap" };
          return false;
        }
        if (currentRevision && currentRevision.receipts.length >= hostSessionHistoryReceiptLimit) {
          if (currentRevision.nextCursor === undefined) {
            outcome = { kind: "rejected", changed: false, reason: "host-session history receipt capacity conflict" };
            return false;
          }
          delete currentRevision.nextCursor;
          currentRevision.truncated = true;
          currentRevision.omitted = true;
          currentRevision.receipts = [
            ...currentRevision.receipts.slice(1),
            { requestId: message.requestId, ...(expected.cursor === undefined ? {} : { cursor: expected.cursor }), digest }
          ];
          outcome = { kind: "accepted", changed: true };
          return true;
        }
        const priorItems = currentRevision?.items ?? [];
        const seenItems = new Set(priorItems.map((item) => item.id));
        if (message.items.some((item) => seenItems.has(item.id))) {
          outcome = { kind: "rejected", changed: false, reason: "host-session history repeats an item identity" };
          return false;
        }
        const combined = [...priorItems, ...message.items];
        const receipts = [
          ...(currentRevision?.receipts ?? []),
          { requestId: message.requestId, ...(expected.cursor === undefined ? {} : { cursor: expected.cursor }), digest }
        ];
        const omitted = combined.length > hostHarnessSessionLimits.historyItemsPerPage
          || (combined.length >= hostHarnessSessionLimits.historyItemsPerPage && message.nextCursor !== undefined)
          || (receipts.length >= hostSessionHistoryReceiptLimit && message.nextCursor !== undefined);
        const items = combined.slice(0, hostHarnessSessionLimits.historyItemsPerPage);
        const history: StoredHostSessionHistory = {
          hostHarnessSessionId: session.hostHarnessSessionId,
          nodeId: session.nodeId,
          harnessId: session.harnessId,
          providerSessionId: session.providerSessionId,
          workspace: session.workspace,
          revision: session.revision,
          items,
          ...(!omitted && message.nextCursor !== undefined ? { nextCursor: message.nextCursor } : {}),
          truncated: (currentRevision?.nextCursor === undefined && (currentRevision?.truncated ?? false))
            || (message.nextCursor === undefined && message.truncated) || omitted,
          omitted: (currentRevision?.omitted ?? false) || omitted,
          observedAt: new Date().toISOString(),
          receipts
        };
        let historyBytes = storedHistoryBytes(history) + 2;
        if (historyBytes > hostSessionHistoryStorageLimits.bytes) {
          delete history.nextCursor;
          history.truncated = true;
          history.omitted = true;
          historyBytes = storedHistoryBytes(history) + 2;
          const itemBytes = history.items.map((item) => Buffer.byteLength(JSON.stringify(item), "utf8"));
          while (historyBytes > hostSessionHistoryStorageLimits.bytes && history.items.length > 0) {
            const removedIndex = history.items.length - 1;
            history.items.pop();
            historyBytes -= itemBytes[removedIndex]! + (history.items.length > 0 ? 1 : 0);
          }
        }
        if (index < 0) state.hostSessionHistories!.push(history); else state.hostSessionHistories![index] = history;
        state.hostSessionHistories!.sort((left, right) => compareCodeUnits(left.hostHarnessSessionId, right.hostHarnessSessionId));
        if (!enforceHostSessionHistoryRetention(state, session.hostHarnessSessionId)) {
          outcome = { kind: "rejected", changed: false, reason: "host-session history storage capacity conflict" };
          return false;
        }
        outcome = { kind: "accepted", changed: true };
        return true;
      });
    } finally {
      active.delete(message.requestId);
      if (active.size === 0) this.inFlight.delete(connectionKey);
    }
    return outcome;
  }
}
