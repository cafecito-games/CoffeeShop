import {
  orchestrationToolLimits,
  orchestratorClientHeartbeatSeconds,
  orchestratorClientLimits,
  orchestratorClientProtocolVersion,
  requiredScopeForExternalOrchestratorTool,
  validateOrchestratorClientMessage,
  validateOrchestratorHubMessage,
  type ExternalOrchestratorToolName,
  type OrchestratorClient,
  type OrchestratorClientCloseReason,
  type OrchestratorClientError,
  type OrchestratorClientErrorCode,
  type OrchestratorHubToClient,
  type Validation
} from "@coffee-shop/protocol";
import {
  orchestratorApprovalAuthority,
  orchestratorApprovalView,
  orchestratorApprovalViews,
  parseOrchestratorApprovalResolution,
  resolveApprovalForOrchestrator,
  type OrchestratorApprovalAuthority,
  type OrchestratorApprovalResolutionResult
} from "./approvals.js";
import { CoordinationError } from "./coordinationError.js";
import { submitTasksForSource, updateTaskForSource } from "./coordination.js";
import { deliverApprovalResolution, type ControlAgentSender } from "./harnessGateway.js";
import { executionInventoryForSource, type InventoryEnvironment } from "./executionInventory.js";
import { applyInstanceToolForSource, getInstanceForSource, type InstanceToolName } from "./instanceTools.js";
import { maintainInstanceLifecycle } from "./instances.js";
import {
  externalSource,
  resolveExternalCaller,
  sendTaskMessageForSource,
  TaskEventWaiters
} from "./mailbox.js";
import { submittedTask } from "./hubTools.js";
import { externalThreadContext } from "./orchestratorContext.js";
import { persistExternalOrchestratorCursor } from "./orchestratorInbox.js";
import { updateThreadForExternalOrchestrator } from "./threads.js";
import {
  attachedAttachmentForThread,
  attachThreadInState,
  createExternalThreadInState,
  decideDoorbell,
  doorbellFactsFor,
  detachClientInState,
  detachConnectionInState,
  detachThreadInState,
  expireOrchestratorAttachments,
  externalThreadView,
  externalThreadViewsForClient,
  parseExternalThreadInput,
  parseThreadReference,
  recordHeartbeatInState,
  type AttachOutcome,
  type DetachOutcome,
  type DoorbellRingRecord,
  type DoorbellTrigger,
  type ExternalThreadCreation
} from "./externalOrchestrators.js";
import { touchOrchestratorClient, verifyOrchestratorClient } from "./orchestratorClients.js";
import { newId, publicOrchestratorClient, type State, type Store } from "./store.js";

/*
 * The hub's `/orchestrator-client` endpoint.
 *
 * One socket carries one credential. The credential arrives in the first frame and never in the
 * URL, and nothing but `client.hello` is accepted before the hub has welcomed the connection. Every
 * later frame is validated by `@coffee-shop/protocol`, so an unknown type, an undeclared field, an
 * unknown tool, or an oversized payload is refused by the same parser the bridge validates against.
 *
 * Nothing here trusts a frame to name its own authority: the tool dispatcher reads the credential's
 * current scopes out of committed state on every call, and thread authority is decided by
 * `externalOrchestrators.ts` inside the store transaction that applies it.
 */

/** A connection that has not said hello by this deadline is closed. */
export const orchestratorClientHelloTimeoutMilliseconds = 10_000;
/** Concurrent `rpc.request` frames one connection may have outstanding. */
export const orchestratorClientMaximumInFlightRequests = 16;
/** The largest frame the hub will parse; anything larger is refused without being decoded. */
export const orchestratorClientMaximumFrameBytes = orchestratorClientLimits.argumentsBytes + 8 * 1024;
/** The WebSocket close code every refusal uses; the reason names which refusal it was. */
export const orchestratorClientCloseCode = 1008;

export interface OrchestratorClientTransport {
  send(payload: string): void;
  close(reason: OrchestratorClientCloseReason): void;
}

export interface OrchestratorClientConnection {
  /** Feeds one inbound frame; resolves once the frame has been fully handled. */
  receive(raw: string): Promise<void>;
  /** Reports that the socket closed, releasing every attachment it held. */
  closed(): Promise<void>;
}

export interface OrchestratorClientTimers {
  setTimeout(handler: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface OrchestratorClientGatewayDependencies {
  store: Store;
  broadcast: () => void;
  now?: () => string;
  timers?: OrchestratorClientTimers;
  /** Shared with the Barista tool handler so one registry bounds every pending long poll. */
  waiters?: TaskEventWaiters;
  /** What `get_execution_inventory` may report about node connectivity; empty when unwired. */
  inventory?: () => Omit<InventoryEnvironment, "now">;
  /** Runs a scheduling pass after a submission commits; it never rejects. */
  schedule?: () => Promise<void>;
  /**
   * Writes an approval decision to the run's Barista. When unwired, a resolution still commits and
   * its decision stays pending for the reconnect barrier to deliver.
   */
  sendToControlAgent?: ControlAgentSender;
}

export interface OrchestratorClientGateway {
  accept(transport: OrchestratorClientTransport): OrchestratorClientConnection;
  /** Closes every live socket of a revoked credential and releases its attachments. */
  revokeClient(clientId: string): Promise<void>;
  /** Detaches connections silent past the heartbeat expiry; returns whether anything changed. */
  expireAttachments(): Promise<boolean>;
  /**
   * Re-evaluates the doorbell policy for every attached thread and rings the ones it says to ring.
   * Safe to call from a commit listener and from a timer: it never throws, never writes, and never
   * blocks.
   */
  ringAttachedThreads(): void;
  /** Live, welcomed connections; used by tests and diagnostics. */
  connectionCount(): number;
}

type ToolOutcome = { result: unknown } | { error: OrchestratorClientError };

const failure = (code: OrchestratorClientErrorCode, message: string): ToolOutcome => ({ error: { code, message } });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * How a hub tool failure is reported to a bridge. Every code the orchestration handlers raise is
 * either named here or is an argument the caller got wrong, so a code this hub does not know is
 * reported as a bad call rather than as a hub fault the bridge would retry. A refusal the caller
 * cannot fix by changing its arguments — a thread already settled, or a capacity the hub itself
 * bounds — is a conflict, so a model is not sent hunting through a well-formed call for a mistake
 * it did not make.
 */
const externalOrchestratorErrorCodes: Readonly<Record<string, OrchestratorClientErrorCode>> = {
  not_attached: "not_attached",
  forbidden: "forbidden",
  not_found: "not_found",
  idempotency_conflict: "conflict",
  conflict: "conflict",
  thread_in_use: "conflict",
  thread_inactive: "conflict",
  thread_archived: "conflict",
  task_not_ready: "conflict",
  invalid_transition: "conflict",
  mailbox_full: "conflict",
  update_limit: "conflict",
  persistence_failed: "hub_unavailable",
  inconsistent_state: "hub_unavailable",
  internal_error: "hub_unavailable"
};

export const externalOrchestratorErrorFor = (error: unknown): OrchestratorClientError =>
  error instanceof CoordinationError
    ? { code: externalOrchestratorErrorCodes[error.code] ?? "invalid_arguments", message: error.message }
    : { code: "hub_unavailable", message: "The hub could not complete this call" };

/** The thread every orchestration tool acts on, and the arguments the hub tool itself interprets. */
function parseThreadScopedArguments(value: unknown): Validation<{ threadId: string; rest: Record<string, unknown> }> {
  if (!isRecord(value)) return { ok: false, reason: "Arguments must be an object" };
  const { threadId, ...rest } = value;
  if (typeof threadId !== "string" || !threadId.trim()) return { ok: false, reason: "threadId is required" };
  if (threadId.length > 200) return { ok: false, reason: "threadId must be at most 200 characters" };
  return { ok: true, value: { threadId: threadId.trim(), rest } };
}

export interface ThreadEventsRequest {
  cursor?: string;
  /** Already capped at the hub's maximum wait. */
  waitMilliseconds: number;
}

/**
 * Parses what `get_thread_events` adds to its thread. A wait longer than the hub's maximum is
 * capped rather than refused, because the caller asked for a long poll and the hub decides how long
 * it is willing to hold one open. Omitting it polls without waiting.
 */
export function parseThreadEventsRequest(value: Record<string, unknown>): Validation<ThreadEventsRequest> {
  if (Object.keys(value).some((key) => key !== "cursor" && key !== "waitMilliseconds")) {
    return { ok: false, reason: "get_thread_events accepts only threadId, cursor, and waitMilliseconds" };
  }
  if (value.cursor !== undefined && (typeof value.cursor !== "string" || !value.cursor)) return { ok: false, reason: "cursor must be a cursor string" };
  const requested = value.waitMilliseconds;
  if (requested !== undefined && (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested < 0)) {
    return { ok: false, reason: "waitMilliseconds must be a whole number of milliseconds" };
  }
  return {
    ok: true,
    value: {
      ...(value.cursor === undefined ? {} : { cursor: value.cursor as string }),
      waitMilliseconds: Math.min(requested ?? 0, orchestrationToolLimits.maximumWaitMilliseconds)
    }
  };
}

const unwiredInventory: Omit<InventoryEnvironment, "now"> = { connection: () => undefined, capabilityReport: () => undefined };

const defaultTimers: OrchestratorClientTimers = {
  setTimeout(handler, milliseconds) {
    const handle = setTimeout(handler, milliseconds);
    handle.unref?.();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
};

/** The committed record of a credential, or `undefined` once it is gone or revoked. */
const liveClient = (state: Readonly<State>, clientId: string): OrchestratorClient | undefined => {
  const stored = (state.orchestratorClients ?? []).find((client) => client.id === clientId);
  return stored === undefined || stored.revokedAt !== undefined ? undefined : publicOrchestratorClient(stored);
};

interface LiveConnection {
  connectionId: string;
  clientId: string;
  /** Returns whether the frame reached the socket. */
  send(message: OrchestratorHubToClient): boolean;
  close(reason: OrchestratorClientCloseReason): void;
}

export function createOrchestratorClientGateway({
  store,
  broadcast,
  now = () => new Date().toISOString(),
  timers = defaultTimers,
  waiters = new TaskEventWaiters(store),
  inventory = () => unwiredInventory,
  schedule,
  sendToControlAgent = () => false
}: OrchestratorClientGatewayDependencies): OrchestratorClientGateway {
  const connections = new Map<string, LiveConnection>();
  /*
   * Doorbells, keyed by attachment: a replaced attachment starts with no history, so the connection
   * that takes a thread over is rung for the whole backlog, and the one it replaced is never rung
   * again. Nothing here is persisted, because a ring is not a delivery — only the acknowledged
   * cursor is.
   */
  const ringRecords = new Map<string, DoorbellRingRecord>();
  const pendingRings = new Map<string, unknown>();

  /** Re-evaluates one thread and rings its attached connection if the policy says to. */
  const ringThread = (threadId: string, trigger: DoorbellTrigger) => {
    const scheduled = pendingRings.get(threadId);
    if (scheduled !== undefined) {
      pendingRings.delete(threadId);
      timers.clearTimeout(scheduled);
    }
    const attachment = store.read((state) => attachedAttachmentForThread(state, threadId));
    if (attachment === undefined) return;
    const connection = connections.get(attachment.connectionId);
    if (connection === undefined) return;
    const facts = store.read((state) => doorbellFactsFor(state, threadId));
    if (facts === undefined) return;
    const decision = decideDoorbell(facts, ringRecords.get(attachment.id), trigger, now());
    if (decision.kind === "wait") {
      // The burst is coalesced: one re-evaluation at the end of the window rings with the counts
      // as they stand then, rather than once per event.
      pendingRings.set(threadId, timers.setTimeout(() => {
        pendingRings.delete(threadId);
        ringThread(threadId, "change");
      }, decision.retryAfterMilliseconds));
      return;
    }
    if (decision.kind !== "ring") return;
    // A ring that never reached the socket is not recorded, so the same backlog rings again.
    if (connection.send(decision.doorbell)) ringRecords.set(attachment.id, decision.record);
  };

  const gateway: OrchestratorClientGateway = {
    accept(transport) {
      let connectionId: string | undefined;
      let clientId: string | undefined;
      let finished = false;
      const inFlight = new Set<string>();

      /** Puts one frame on the socket; the result reports whether it actually got there. */
      const send = (message: OrchestratorHubToClient): boolean => {
        if (finished) return false;
        const validated = validateOrchestratorHubMessage(message);
        if (!validated.ok) {
          // The hub never puts a frame the bridge would reject on the wire. A result too large for
          // the protocol becomes a failure the caller can act on instead of a dropped response.
          console.error(`orchestrator-client frame refused by its own contract: ${validated.reason}`);
          if (message.type !== "rpc.response") return false;
          send({ type: "rpc.response", requestId: message.requestId, error: { code: "hub_unavailable", message: "The hub could not encode a result for this call" } });
          return false;
        }
        try {
          transport.send(JSON.stringify(validated.value));
          return true;
        } catch (error) {
          console.error("orchestrator-client frame could not be sent", error);
          return false;
        }
      };

      const close = (reason: OrchestratorClientCloseReason) => {
        if (finished) return;
        finished = true;
        if (connectionId !== undefined) connections.delete(connectionId);
        timers.clearTimeout(helloDeadline);
        try {
          transport.close(reason);
        } catch (error) {
          console.error("orchestrator-client socket could not be closed", error);
        }
      };

      const helloDeadline = timers.setTimeout(() => {
        if (connectionId === undefined) close("unauthorized");
      }, orchestratorClientHelloTimeoutMilliseconds);

      const welcome = async (hello: { clientId: string; secret: string }) => {
        const at = now();
        const verification = store.read((state) => verifyOrchestratorClient(state, hello.clientId, hello.secret));
        if (!verification.ok) return close(verification.reason);
        timers.clearTimeout(helloDeadline);
        connectionId = newId("connection");
        clientId = verification.client.id;
        const live: LiveConnection = { connectionId, clientId, send, close };
        connections.set(connectionId, live);
        try {
          await store.transact((state) => touchOrchestratorClient(state, live.clientId, at));
          broadcast();
        } catch (error) {
          // `lastSeenAt` is a diagnostic, never an authority decision: a failed write must not cost
          // a verified bridge its connection.
          console.error("orchestrator client last-seen time could not be persisted", error);
        }
        if (finished) return;
        send({ type: "client.welcome", connectionId, heartbeatSeconds: orchestratorClientHeartbeatSeconds, scopes: verification.client.scopes });
      };

      const heartbeat = async () => {
        if (connectionId === undefined || clientId === undefined) return;
        const at = now();
        const connection = connectionId;
        const client = clientId;
        let changed = false;
        try {
          await store.transact((state) => {
            // Both halves always run: a heartbeat refreshes the attachments and the last-seen time.
            const refreshed = recordHeartbeatInState(state, connection, at);
            changed = touchOrchestratorClient(state, client, at) || refreshed;
            return changed;
          });
        } catch (error) {
          console.error("orchestrator client heartbeat could not be persisted", error);
          return;
        }
        if (changed) broadcast();
      };

      const notifyReplaced = (replaced: { threadId: string; id: string; connectionId: string }) => {
        connections.get(replaced.connectionId)?.send({ type: "attachment.replaced", threadId: replaced.threadId, attachmentId: replaced.id });
      };

      const createThread = async (client: OrchestratorClient, argumentsValue: unknown): Promise<ToolOutcome> => {
        const input = parseExternalThreadInput(argumentsValue);
        if (!input.ok) return failure("invalid_arguments", input.reason);
        let creation: ExternalThreadCreation | undefined;
        await store.transact((state) => {
          creation = createExternalThreadInState(state, { clientId: client.id, connectionId: connectionId!, ...input.value }, now());
        });
        broadcast();
        const view = store.read((state) => structuredClone(externalThreadView(state, state.threads!.find((thread) => thread.id === creation!.thread.id)!)));
        return { result: { thread: view } };
      };

      const listThreads = (client: OrchestratorClient, argumentsValue: unknown): ToolOutcome => {
        if (!isRecord(argumentsValue) || Object.keys(argumentsValue).length > 0) return failure("invalid_arguments", "list_threads takes no arguments");
        return { result: { threads: store.read((state) => structuredClone(externalThreadViewsForClient(state, client.id))) } };
      };

      const attachThread = async (client: OrchestratorClient, argumentsValue: unknown): Promise<ToolOutcome> => {
        const threadId = parseThreadReference(argumentsValue);
        if (!threadId.ok) return failure("invalid_arguments", threadId.reason);
        let outcome: AttachOutcome = { kind: "forbidden" };
        await store.transact((state) => {
          outcome = attachThreadInState(state, { threadId: threadId.value, clientId: client.id, connectionId: connectionId! }, now());
          return outcome.kind === "attached";
        });
        const attached = outcome as AttachOutcome;
        if (attached.kind !== "attached") return failure("forbidden", "The thread is not orchestrated by this client");
        broadcast();
        if (attached.replaced !== undefined) notifyReplaced(attached.replaced);
        // Attaching rings whatever is already waiting, which is why no ring is ever persisted.
        ringThread(threadId.value, "attach");
        const view = store.read((state) => {
          const thread = (state.threads ?? []).find((item) => item.id === threadId.value);
          return thread === undefined ? undefined : structuredClone(externalThreadView(state, thread));
        });
        return view === undefined ? failure("not_found", "The thread is no longer present") : { result: { thread: view } };
      };

      const detachThread = async (_client: OrchestratorClient, argumentsValue: unknown): Promise<ToolOutcome> => {
        const threadId = parseThreadReference(argumentsValue);
        if (!threadId.ok) return failure("invalid_arguments", threadId.reason);
        let outcome: DetachOutcome = { kind: "not-attached" };
        await store.transact((state) => {
          outcome = detachThreadInState(state, { threadId: threadId.value, connectionId: connectionId! }, now());
          return outcome.kind === "detached";
        });
        const detached = outcome as DetachOutcome;
        if (detached.kind !== "detached") return failure("not_attached", "This connection holds no attachment on that thread");
        broadcast();
        return { result: { threadId: threadId.value, attachmentId: detached.attachment.id, detachedAt: detached.attachment.detachedAt } };
      };


      /*
       * Orchestration tools.
       *
       * Every one of them names its thread, and that thread is authorized by the connection's live
       * attachment rather than by anything in the frame. The check is repeated inside the store
       * transaction that commits a change, so an attachment replaced or detached while a call was
       * in flight cannot have its change land.
       */
      const threadScoped = (
        run: (threadId: string, rest: Record<string, unknown>) => ToolOutcome | Promise<ToolOutcome>
      ) => async (_client: OrchestratorClient, argumentsValue: unknown): Promise<ToolOutcome> => {
        const parsed = parseThreadScopedArguments(argumentsValue);
        if (!parsed.ok) return failure("invalid_arguments", parsed.reason);
        return run(parsed.value.threadId, parsed.value.rest);
      };

      const settleScheduling = async () => {
        if (!schedule) return;
        try {
          await schedule();
        } catch (error) {
          // Placement is never part of a submission's success; the pass reports its own failures.
          console.error("scheduling after an external submission failed", error);
        }
      };

      const getThreadContext = threadScoped((threadId, rest) => {
        if (Object.keys(rest).length) return failure("invalid_arguments", "get_thread_context accepts only threadId");
        return {
          result: store.read((state) => structuredClone(externalThreadContext(state, resolveExternalCaller(state, connectionId!, threadId).thread)))
        };
      });

      const getThreadEvents = threadScoped(async (threadId, rest) => {
        const request = parseThreadEventsRequest(rest);
        if (!request.ok) return failure("invalid_arguments", request.reason);
        const { cursor, waitMilliseconds } = request.value;
        const connection = connectionId!;
        // The cursor acknowledges only once the whole call has been validated against the live
        // attachment, so a rejected call never advances the thread's acknowledged position.
        const acknowledge = cursor === undefined ? undefined : () =>
          persistExternalOrchestratorCursor(store, connection, threadId, cursor, "processed").then((changed) => { if (changed) broadcast(); });
        const page = await waiters.wait(externalSource(connection, threadId), {
          ...(cursor === undefined ? {} : { cursor }),
          timeoutMilliseconds: waitMilliseconds,
          maximumEvents: orchestrationToolLimits.maximumEventsPerWait
        }, undefined, acknowledge);
        if (page.events.length && await persistExternalOrchestratorCursor(store, connection, threadId, page.cursor, "delivered")) broadcast();
        return { result: { threadId, events: page.events, cursor: page.cursor, hasMore: page.hasMore, timedOut: page.timedOut } };
      });

      const submitTasks = threadScoped(async (threadId, rest) => {
        const result = await submitTasksForSource(store, externalSource(connectionId!, threadId), rest, now());
        if (result.created) {
          broadcast();
          await settleScheduling();
        }
        return {
          result: store.read((state) => ({
            created: result.created,
            submissionId: result.submissionId,
            taskIdsByKey: { ...result.taskIdsByKey },
            tasks: result.tasks.map((task) => structuredClone(submittedTask(state, task)))
          }))
        };
      });

      const getInstance = threadScoped((threadId, rest) => ({
        result: getInstanceForSource(store, externalSource(connectionId!, threadId), rest)
      }));

      const lifecycleMutation = (operation: Exclude<InstanceToolName, "get_instance">) => threadScoped(async (threadId, rest) => {
        const at = now();
        const result = await applyInstanceToolForSource(store, externalSource(connectionId!, threadId), operation, rest, at);
        if (result.replayed === false) {
          if (operation === "release_instance") await maintainInstanceLifecycle(store, at);
          broadcast();
          if (operation === "spawn_instance" || operation === "release_instance") await settleScheduling();
        }
        return { result };
      });

      const spawnInstance = lifecycleMutation("spawn_instance");
      const renewInstance = lifecycleMutation("renew_instance");
      const releaseInstance = lifecycleMutation("release_instance");

      const updateTask = threadScoped(async (threadId, rest) => {
        const result = await updateTaskForSource(store, externalSource(connectionId!, threadId), rest, now());
        if (result.created) broadcast();
        return { result: structuredClone(result) };
      });

      const sendTaskMessage = threadScoped(async (threadId, rest) => {
        const sent = await sendTaskMessageForSource(store, externalSource(connectionId!, threadId), rest, now());
        if (sent.created) broadcast();
        return {
          result: {
            created: sent.created,
            messageId: sent.message.id,
            sequence: sent.message.sequence,
            recipient: { ...sent.message.recipient },
            createdAt: sent.message.createdAt
          }
        };
      });

      const updateThread = threadScoped(async (threadId, rest) => {
        const thread = await updateThreadForExternalOrchestrator(store, connectionId!, threadId, rest, now());
        broadcast();
        return { result: { thread: structuredClone(thread) } };
      });

      /**
       * The inventory describes the whole fleet rather than one thread, so it only has to prove that
       * this connection is a live orchestrator. A named thread must still be one this connection
       * holds; with none named, any thread it holds proves the same thing.
       */
      const getExecutionInventory = (_client: OrchestratorClient, argumentsValue: unknown): ToolOutcome => {
        if (!isRecord(argumentsValue)) return failure("invalid_arguments", "Arguments must be an object");
        const { threadId, ...rest } = argumentsValue;
        if (Object.keys(rest).length) return failure("invalid_arguments", "get_execution_inventory accepts only an optional threadId");
        if (threadId !== undefined && (typeof threadId !== "string" || !threadId.trim())) return failure("invalid_arguments", "threadId must be a thread id");
        const connection = connectionId!;
        const scoped = typeof threadId === "string"
          ? threadId.trim()
          : store.read((state) => (state.orchestratorAttachments ?? [])
            .find((attachment) => attachment.connectionId === connection && attachment.status === "attached")?.threadId);
        if (scoped === undefined) return failure("not_attached", "This connection holds no attachment");
        return {
          result: store.read((state) => structuredClone(
            executionInventoryForSource(state, externalSource(connection, scoped), {}, { ...inventory(), now: now() })
          ))
        };
      };

      /*
       * Approval tools.
       *
       * The dispatcher already refused a credential whose committed scopes lack `resolve-approvals`,
       * but that read happened before the handler ran. Both handlers decide the authority again from
       * committed state, and `resolve_approval` does so inside the transaction that commits the
       * resolution, so a scope removed or a credential revoked while the call was in flight can
       * never resolve a worker's approval.
       */
      const refuseApprovalAuthority = (authority: Exclude<OrchestratorApprovalAuthority, { kind: "authorized" }>): ToolOutcome =>
        authority.kind === "not-attached"
          ? failure("not_attached", "This connection holds no attachment on that thread")
          : failure("forbidden", "This credential may not resolve approvals");

      const listApprovals = threadScoped((threadId, rest) => {
        if (Object.keys(rest).length) return failure("invalid_arguments", "list_approvals accepts only threadId");
        return store.read((state) => {
          const authority = orchestratorApprovalAuthority(state, connectionId!, threadId);
          if (authority.kind !== "authorized") return refuseApprovalAuthority(authority);
          return { result: { threadId, approvals: structuredClone(orchestratorApprovalViews(state, threadId)) } };
        });
      });

      const resolveApproval = async (_client: OrchestratorClient, argumentsValue: unknown): Promise<ToolOutcome> => {
        const request = parseOrchestratorApprovalResolution(argumentsValue);
        if (!request.ok) return failure("invalid_arguments", request.reason);
        const at = now();
        let outcome: OrchestratorApprovalResolutionResult = { kind: "not-attached" };
        await store.transact((state) => {
          outcome = resolveApprovalForOrchestrator(state, connectionId!, request.value, at);
          return outcome.kind === "resolved" || (outcome.kind === "conflict" && outcome.changed);
        });
        const resolution = outcome as OrchestratorApprovalResolutionResult;
        if (resolution.kind === "not-attached" || resolution.kind === "forbidden") return refuseApprovalAuthority(resolution);
        // An approval on another thread and an approval that never existed answer identically.
        if (resolution.kind === "not-found") return failure("not_found", "No such approval is open on a thread this connection holds");
        if (resolution.kind === "option-not-offered") return failure("invalid_arguments", "The selected option was not offered by this approval");
        if (resolution.kind === "resolved" || (resolution.kind === "conflict" && resolution.changed)) broadcast();
        if (await deliverApprovalResolution(store, request.value.approvalId, resolution, sendToControlAgent, at)) broadcast();
        if (resolution.kind === "conflict") return failure("conflict", resolution.reason);
        const approval = store.read((state) => (state.approvals ?? []).find((item) => item.id === request.value.approvalId));
        if (approval === undefined) return failure("not_found", "No such approval is open on a thread this connection holds");
        return { result: { approval: orchestratorApprovalView(approval, approval.taskId!) } };
      };

      /*
       * Every tool name the protocol declares is named here, so adding one to `packages/protocol`
       * without serving it answers `invalid_arguments` instead of reaching an undefined handler.
       */
      const handlers: Readonly<Record<ExternalOrchestratorToolName, ((client: OrchestratorClient, argumentsValue: unknown) => ToolOutcome | Promise<ToolOutcome>) | undefined>> = {
        create_thread: createThread,
        list_threads: listThreads,
        attach_thread: attachThread,
        detach_thread: detachThread,
        get_thread_context: getThreadContext,
        get_thread_events: getThreadEvents,
        submit_tasks: submitTasks,
        update_task: updateTask,
        send_task_message: sendTaskMessage,
        update_thread: updateThread,
        get_execution_inventory: getExecutionInventory,
        spawn_instance: spawnInstance,
        get_instance: getInstance,
        renew_instance: renewInstance,
        release_instance: releaseInstance,
        list_approvals: listApprovals,
        resolve_approval: resolveApproval
      };

      const dispatch = async (requestId: string, tool: ExternalOrchestratorToolName, argumentsValue: Record<string, unknown>) => {
        if (inFlight.size >= orchestratorClientMaximumInFlightRequests) {
          return send({ type: "rpc.response", requestId, error: { code: "hub_unavailable", message: "Too many calls are already in flight on this connection" } });
        }
        if (inFlight.has(requestId)) {
          return send({ type: "rpc.response", requestId, error: { code: "conflict", message: "A call with this requestId is already in flight" } });
        }
        const client = store.read((state) => (clientId === undefined ? undefined : liveClient(state, clientId)));
        if (client === undefined) {
          send({ type: "rpc.response", requestId, error: { code: "revoked", message: "This credential is no longer valid" } });
          return close("revoked");
        }
        if (!client.scopes.includes(requiredScopeForExternalOrchestratorTool(tool))) {
          return send({ type: "rpc.response", requestId, error: { code: "forbidden", message: `This credential may not call ${tool}` } });
        }
        const handler = handlers[tool];
        if (handler === undefined) {
          return send({ type: "rpc.response", requestId, error: { code: "invalid_arguments", message: `${tool} is not served by this hub` } });
        }
        inFlight.add(requestId);
        let outcome: ToolOutcome;
        try {
          outcome = await handler(client, argumentsValue);
        } catch (error) {
          if (!(error instanceof CoordinationError)) console.error(`orchestrator-client tool ${tool} failed`, error);
          outcome = { error: externalOrchestratorErrorFor(error) };
        } finally {
          inFlight.delete(requestId);
        }
        send({ type: "rpc.response", requestId, ...outcome });
      };

      const refuseUndecodable = (decoded: unknown, reason: string): void => {
        if (connectionId === undefined) return close("unauthorized");
        // After the welcome a bad frame is answered, not fatal, so one malformed call never costs a
        // bridge its attachments. Only a frame that names its own request can be answered.
        if (isRecord(decoded) && decoded.type === "rpc.request" && typeof decoded.requestId === "string" && decoded.requestId.length > 0) {
          send({ type: "rpc.response", requestId: decoded.requestId, error: { code: "invalid_arguments", message: reason } });
          return;
        }
        console.warn(`ignored an orchestrator-client frame: ${reason}`);
      };

      return {
        async receive(raw) {
          if (finished) return;
          if (Buffer.byteLength(raw, "utf8") > orchestratorClientMaximumFrameBytes) return refuseUndecodable(undefined, "the frame exceeds the hub's size limit");
          let decoded: unknown;
          try {
            decoded = JSON.parse(raw);
          } catch {
            return refuseUndecodable(undefined, "the frame is not JSON");
          }
          // A hello for another protocol revision is refused by revision rather than by credential,
          // so a bridge learns to upgrade instead of re-checking its secret.
          if (isRecord(decoded) && decoded.type === "client.hello" && decoded.protocolVersion !== orchestratorClientProtocolVersion) return close("unsupported_version");
          const validated = validateOrchestratorClientMessage(decoded);
          if (!validated.ok) return refuseUndecodable(decoded, validated.reason);
          const message = validated.value;
          if (connectionId === undefined) {
            if (message.type !== "client.hello") return close("unauthorized");
            return welcome(message);
          }
          if (message.type === "client.hello") return close("unauthorized");
          if (message.type === "client.heartbeat") return heartbeat();
          await dispatch(message.requestId, message.tool, message.arguments);
        },
        async closed() {
          finished = true;
          timers.clearTimeout(helloDeadline);
          if (connectionId === undefined) return;
          connections.delete(connectionId);
          const connection = connectionId;
          let detached = 0;
          try {
            await store.transact((state) => {
              detached = detachConnectionInState(state, connection, now()).length;
              return detached > 0;
            });
          } catch (error) {
            console.error("orchestrator client attachments could not be released", error);
            return;
          }
          if (detached > 0) broadcast();
        }
      };
    },

    async revokeClient(clientId) {
      for (const connection of [...connections.values()]) {
        if (connection.clientId !== clientId) continue;
        connection.send({ type: "client.revoked" });
        connection.close("revoked");
      }
      let detached = 0;
      try {
        await store.transact((state) => {
          detached = detachClientInState(state, clientId, now()).length;
          return detached > 0;
        });
      } catch (error) {
        console.error("revoked orchestrator client attachments could not be released", error);
        return;
      }
      if (detached > 0) broadcast();
    },

    async expireAttachments() {
      let expired: string[] = [];
      await store.transact((state) => {
        expired = expireOrchestratorAttachments(state, now()).map((attachment) => attachment.connectionId);
        return expired.length > 0;
      });
      if (expired.length === 0) return false;
      broadcast();
      return true;
    },

    ringAttachedThreads() {
      try {
        const attached = store.read((state) => (state.orchestratorAttachments ?? [])
          .filter((attachment) => attachment.status === "attached")
          .map((attachment) => ({ id: attachment.id, threadId: attachment.threadId })));
        const live = new Set(attached.map((attachment) => attachment.id));
        for (const attachmentId of [...ringRecords.keys()]) if (!live.has(attachmentId)) ringRecords.delete(attachmentId);
        for (const attachment of attached) ringThread(attachment.threadId, "change");
      } catch (error) {
        // A doorbell is a convenience; a thread whose ring failed is still pulled by its cursor.
        console.error("orchestrator doorbells could not be evaluated", error);
      }
    },

    connectionCount() {
      return connections.size;
    }
  };

  return gateway;
}

/** The tools this hub serves; every other declared tool is answered `invalid_arguments`. */
export const servedExternalOrchestratorTools: readonly ExternalOrchestratorToolName[] = [
  "create_thread",
  "list_threads",
  "attach_thread",
  "detach_thread",
  "get_thread_context",
  "get_thread_events",
  "submit_tasks",
  "update_task",
  "send_task_message",
  "update_thread",
  "get_execution_inventory",
  "spawn_instance",
  "get_instance",
  "renew_instance",
  "release_instance",
  "list_approvals",
  "resolve_approval"
];
