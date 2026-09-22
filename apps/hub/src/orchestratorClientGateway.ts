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
import { CoordinationError } from "./coordinationError.js";
import { submitTasksForSource, updateTaskForSource } from "./coordination.js";
import { executionInventoryForSource, type InventoryEnvironment } from "./executionInventory.js";
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
  attachThreadInState,
  createExternalThreadInState,
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
}

export interface OrchestratorClientGateway {
  accept(transport: OrchestratorClientTransport): OrchestratorClientConnection;
  /** Closes every live socket of a revoked credential and releases its attachments. */
  revokeClient(clientId: string): Promise<void>;
  /** Detaches connections silent past the heartbeat expiry; returns whether anything changed. */
  expireAttachments(): Promise<boolean>;
  /** Live, welcomed connections; used by tests and diagnostics. */
  connectionCount(): number;
}

type ToolOutcome = { result: unknown } | { error: OrchestratorClientError };

const failure = (code: OrchestratorClientErrorCode, message: string): ToolOutcome => ({ error: { code, message } });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * How a hub tool failure is reported to a bridge. Every code the orchestration handlers raise is
 * either named here or is an argument the caller got wrong, so a code this hub does not know is
 * reported as a bad call rather than as a hub fault the bridge would retry.
 */
const externalOrchestratorErrorCodes: Readonly<Record<string, OrchestratorClientErrorCode>> = {
  not_attached: "not_attached",
  forbidden: "forbidden",
  not_found: "not_found",
  idempotency_conflict: "conflict",
  duplicate_task_key: "conflict",
  thread_in_use: "conflict",
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
  send(message: OrchestratorHubToClient): void;
  close(reason: OrchestratorClientCloseReason): void;
}

export function createOrchestratorClientGateway({
  store,
  broadcast,
  now = () => new Date().toISOString(),
  timers = defaultTimers,
  waiters = new TaskEventWaiters(store),
  inventory = () => unwiredInventory,
  schedule
}: OrchestratorClientGatewayDependencies): OrchestratorClientGateway {
  const connections = new Map<string, LiveConnection>();

  const gateway: OrchestratorClientGateway = {
    accept(transport) {
      let connectionId: string | undefined;
      let clientId: string | undefined;
      let finished = false;
      const inFlight = new Set<string>();

      const send = (message: OrchestratorHubToClient) => {
        if (finished) return;
        const validated = validateOrchestratorHubMessage(message);
        if (!validated.ok) {
          // The hub never puts a frame the bridge would reject on the wire. A result too large for
          // the protocol becomes a failure the caller can act on instead of a dropped response.
          console.error(`orchestrator-client frame refused by its own contract: ${validated.reason}`);
          if (message.type !== "rpc.response") return;
          send({ type: "rpc.response", requestId: message.requestId, error: { code: "hub_unavailable", message: "The hub could not encode a result for this call" } });
          return;
        }
        try {
          transport.send(JSON.stringify(validated.value));
        } catch (error) {
          console.error("orchestrator-client frame could not be sent", error);
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
       * Every tool name the protocol declares is named here, so adding one to `packages/protocol`
       * without serving it answers `invalid_arguments` instead of reaching an undefined handler.
       * The tools left unserved belong to the doorbell and approval work.
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
        list_approvals: undefined,
        resolve_approval: undefined
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

      const refuseUndecodable = (decoded: unknown, reason: string) => {
        if (connectionId === undefined) return close("unauthorized");
        // After the welcome a bad frame is answered, not fatal, so one malformed call never costs a
        // bridge its attachments. Only a frame that names its own request can be answered.
        if (isRecord(decoded) && decoded.type === "rpc.request" && typeof decoded.requestId === "string" && decoded.requestId.length > 0) {
          return send({ type: "rpc.response", requestId: decoded.requestId, error: { code: "invalid_arguments", message: reason } });
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
  "get_execution_inventory"
];
