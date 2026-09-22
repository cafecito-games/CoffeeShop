import {
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
  type OrchestratorHubToClient
} from "@coffee-shop/protocol";
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

export function createOrchestratorClientGateway({ store, broadcast, now = () => new Date().toISOString(), timers = defaultTimers }: OrchestratorClientGatewayDependencies): OrchestratorClientGateway {
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
       * Every tool name the protocol declares is named here, so adding one to `packages/protocol`
       * without serving it answers `invalid_arguments` instead of reaching an undefined handler.
       * The tools left unserved belong to the orchestration, doorbell, and approval work.
       */
      const handlers: Readonly<Record<ExternalOrchestratorToolName, ((client: OrchestratorClient, argumentsValue: unknown) => ToolOutcome | Promise<ToolOutcome>) | undefined>> = {
        create_thread: createThread,
        list_threads: listThreads,
        attach_thread: attachThread,
        detach_thread: detachThread,
        get_thread_context: undefined,
        get_thread_events: undefined,
        submit_tasks: undefined,
        update_task: undefined,
        send_task_message: undefined,
        update_thread: undefined,
        get_execution_inventory: undefined,
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
          console.error(`orchestrator-client tool ${tool} failed`, error);
          outcome = failure("hub_unavailable", "The hub could not complete this call");
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
export const servedExternalOrchestratorTools: readonly ExternalOrchestratorToolName[] = ["create_thread", "list_threads", "attach_thread", "detach_thread"];
