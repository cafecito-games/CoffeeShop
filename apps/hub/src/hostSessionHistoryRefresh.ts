import {
  hostHarnessSessionCommandDigest,
  hostHarnessSessionLimits,
  type HostSessionHubMessage
} from "@coffee-shop/protocol";
import { HostSessionHistoryAuthority } from "./hostSessionHistory.js";
import type { HostSessionInventoryConnection } from "./hostSessionInventory.js";
import { hostSessionHistoryReceiptLimit, type Store } from "./store.js";

export type HostSessionHistoryRefreshResult = "received" | "deferred" | "skipped" | "superseded";

export interface HostSessionHistoryRefreshOptions {
  store: Store;
  authority: HostSessionHistoryAuthority;
  connectionFor: (nodeId: string) => HostSessionInventoryConnection | undefined;
  send: (nodeId: string, message: HostSessionHubMessage) => boolean;
  newId: (prefix: string) => string;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  pollAttempts?: number;
  pollMilliseconds?: number;
  retryMilliseconds?: number;
  revisionRetries?: number;
}

const sameProviderIdentity = (
  left: { nodeId: string; harnessId: string; providerSessionId: string; workspace: string },
  right: { nodeId: string; harnessId: string; providerSessionId: string; workspace: string }
) => left.nodeId === right.nodeId && left.harnessId === right.harnessId
  && left.providerSessionId === right.providerSessionId && left.workspace === right.workspace;

/** Coordinates one bounded, correlated refresh without making provider history authoritative. */
export class HostSessionHistoryRefresher {
  private readonly retryAfter = new Map<string, number>();
  private readonly now: () => number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly pollAttempts: number;
  private readonly pollMilliseconds: number;
  private readonly retryMilliseconds: number;
  private readonly revisionRetries: number;

  constructor(private readonly options: HostSessionHistoryRefreshOptions) {
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? ((milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); }));
    this.pollMilliseconds = options.pollMilliseconds ?? 25;
    this.pollAttempts = options.pollAttempts
      ?? Math.ceil(hostHarnessSessionLimits.historyResponseWaitMilliseconds / this.pollMilliseconds);
    this.retryMilliseconds = options.retryMilliseconds ?? 30_000;
    this.revisionRetries = options.revisionRetries ?? 2;
  }

  private defer(hostHarnessSessionId: string) {
    this.retryAfter.delete(hostHarnessSessionId);
    this.retryAfter.set(hostHarnessSessionId, this.now() + this.retryMilliseconds);
    if (this.retryAfter.size > hostHarnessSessionLimits.sessionsGlobal) {
      const oldest = this.retryAfter.keys().next().value as string | undefined;
      if (oldest !== undefined) this.retryAfter.delete(oldest);
    }
  }

  retryStateSize() {
    return this.retryAfter.size;
  }

  async refresh(hostHarnessSessionId: string): Promise<HostSessionHistoryRefreshResult> {
    const retryAfter = this.retryAfter.get(hostHarnessSessionId);
    if (retryAfter !== undefined && retryAfter > this.now()) return "deferred";
    this.retryAfter.delete(hostHarnessSessionId);
    const budget = { remainingAttempts: this.pollAttempts };
    for (let revisionAttempt = 0; revisionAttempt <= this.revisionRetries; revisionAttempt += 1) {
      const result = await this.refreshRevision(hostHarnessSessionId, budget);
      if (result !== "superseded") return result;
    }
    return "superseded";
  }

  private async refreshRevision(
    hostHarnessSessionId: string,
    budget: { remainingAttempts: number }
  ): Promise<HostSessionHistoryRefreshResult> {
    if (budget.remainingAttempts <= 0) {
      this.defer(hostHarnessSessionId);
      return "deferred";
    }
    const session = this.options.store.read((state) => {
      const current = state.hostHarnessSessions?.find((item) => item.hostHarnessSessionId === hostHarnessSessionId);
      return current === undefined ? undefined : structuredClone(current);
    });
    if (!session || session.status === "offline" || !session.operations.includes("read-history")) return "skipped";
    const connection = this.options.connectionFor(session.nodeId);
    if (!connection) return "skipped";
    const storedHistory = this.options.store.read((state) => {
      const history = state.hostSessionHistories?.find((item) =>
        item.hostHarnessSessionId === hostHarnessSessionId && item.revision === session.revision);
      return history === undefined ? undefined : {
        nextCursor: history.nextCursor, itemCount: history.items.length, receiptCount: history.receipts.length
      };
    });
    const cursor = storedHistory?.nextCursor;
    const remaining = hostHarnessSessionLimits.historyItemsPerPage - (storedHistory?.itemCount ?? 0);
    if (cursor !== undefined && (remaining <= 0 || (storedHistory?.receiptCount ?? 0) >= hostSessionHistoryReceiptLimit)) {
      await this.options.store.transact((state) => {
        const history = state.hostSessionHistories?.find((item) =>
          item.hostHarnessSessionId === hostHarnessSessionId && item.revision === session.revision);
        if (!history || history.nextCursor === undefined) return false;
        delete history.nextCursor;
        history.truncated = true;
        history.omitted = true;
        return true;
      });
      return "skipped";
    }
    const requestId = this.options.newId("host_history_request");
    const commandId = this.options.newId("host_history_command");
    const commandWithoutDigest = {
      type: "host-session.history.read", nodeId: session.nodeId, hostHarnessSessionId,
      attachmentEpoch: session.attachmentEpoch, requestId, commandId,
      ...(cursor === undefined ? {} : { cursor }),
      limit: remaining
    } as Omit<Extract<HostSessionHubMessage, { type: "host-session.history.read" }>, "commandDigest">;
    const digest = hostHarnessSessionCommandDigest(commandWithoutDigest);
    if (!digest.ok) return "skipped";
    const command: HostSessionHubMessage = { ...commandWithoutDigest, commandDigest: digest.value };
    if (!this.options.authority.expect(connection, hostHarnessSessionId, requestId, cursor, remaining)) return "skipped";
    if (!this.options.send(session.nodeId, command)) {
      this.options.authority.cancel(connection, requestId);
      this.defer(hostHarnessSessionId);
      return "deferred";
    }
    while (true) {
      const received = this.options.store.read((state) => state.hostSessionHistories?.some((history) =>
        history.hostHarnessSessionId === hostHarnessSessionId
        && history.receipts.some((receipt) => receipt.requestId === requestId)) ?? false);
      if (received) {
        this.retryAfter.delete(hostHarnessSessionId);
        return "received";
      }
      if (!this.options.authority.isExpected(connection, requestId)) {
        if (!connection.isCurrent()) return "superseded";
        const current = this.options.store.read((state) => {
          const latest = state.hostHarnessSessions?.find((item) => item.hostHarnessSessionId === hostHarnessSessionId);
          return latest === undefined ? undefined : structuredClone(latest);
        });
        if (current && sameProviderIdentity(current, session) && current.revision !== session.revision) return "superseded";
        this.defer(hostHarnessSessionId);
        return "deferred";
      }
      if (budget.remainingAttempts <= 0) break;
      budget.remainingAttempts -= 1;
      await this.wait(this.pollMilliseconds);
    }
    this.options.authority.expire(connection, requestId);
    this.defer(hostHarnessSessionId);
    return "deferred";
  }
}
