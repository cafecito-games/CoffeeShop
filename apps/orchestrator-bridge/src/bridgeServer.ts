import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type InitializeResult,
  type Request,
  type Result
} from "@modelcontextprotocol/sdk/types.js";
import {
  isExternalOrchestratorToolName,
  requiredScopeForExternalOrchestratorTool,
  type ExternalOrchestratorToolName,
  type OrchestratorClientError,
  type OrchestratorClientScope
} from "@coffee-shop/protocol";
import { negotiateProtocolRevision } from "./protocolRevision.js";
import { orderedToolDefinitions, toolDefinitions } from "./toolDefinitions.js";
import type { HubAttachmentReplaced, HubCallOutcome, HubDoorbell } from "./hubConnection.js";

export const channelSourceName = "coffeeshop";
export const channelNotificationMethod = "notifications/claude/channel";

/**
 * A Claude Code channel event. `meta` keys must be identifiers or Claude Code drops them, so the
 * bridge only ever sends the four fixed keys below, always with string values.
 */
export type ChannelNotification = {
  method: typeof channelNotificationMethod;
  params: { content: string; meta: Record<string, string> };
};

/** The scope every credential must hold; assumed before the first welcome proves the real set. */
const assumedScopes: readonly OrchestratorClientScope[] = ["orchestrate"];

export const channelMetaKeys = ["thread_id", "pending", "approvals", "urgent"] as const;
export type ChannelMetaKey = typeof channelMetaKeys[number];

export type ChannelsState = "active" | "unknown";

/** The hub side of the bridge, narrowed to what the MCP surface needs. */
export interface HubGateway {
  call: (tool: ExternalOrchestratorToolName, toolArguments: Record<string, unknown>, extraWaitMilliseconds?: number) => Promise<HubCallOutcome>;
  grantedScopes: () => readonly OrchestratorClientScope[];
  isReady: () => boolean;
  isRevoked: () => boolean;
  rememberAttachment: (threadId: string) => void;
  forgetAttachment: (threadId: string) => void;
}

export interface BridgeServerOptions {
  hub: HubGateway;
  serverVersion: string;
  logError: (message: string) => void;
}

const unrememberedAttachmentInstruction =
  "Coffee Shop could not tell which thread was created, so this session will not re-attach it automatically. "
  + "Call attach_thread with the new thread id before relying on doorbells.";

const channelFallbackInstruction =
  "If Coffee Shop channel events never arrive, poll get_thread_events with waitMilliseconds instead of waiting for a doorbell.";

/**
 * Declared both at construction and in the pinned `initialize` reply, which replaces the SDK's own
 * handler and therefore cannot read the SDK's private copy of these values.
 */
export const bridgeCapabilities = {
  tools: { listChanged: true },
  experimental: { "claude/channel": {} }
} as const;

export const bridgeInstructions =
  "Coffee Shop orchestration. Create or attach to a thread, submit tasks, and read thread events. "
  + "Coffee Shop pushes doorbell events into this session as channel events; "
  + channelFallbackInstruction;

/**
 * Builds the doorbell meta map. Numbers and booleans are coerced to strings because Claude Code
 * requires string values, and no key outside the fixed set is ever produced.
 */
export function doorbellMeta(doorbell: HubDoorbell): Record<ChannelMetaKey, string> {
  return {
    thread_id: String(doorbell.threadId),
    pending: String(doorbell.pending),
    approvals: String(doorbell.approvals),
    urgent: String(doorbell.urgent)
  };
}

const toolError = (error: OrchestratorClientError): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error }) }],
  structuredContent: { error: { code: error.code, message: error.message } },
  isError: true
});

const toolSuccess = (result: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(result) }],
  ...(isPlainObject(result) ? { structuredContent: result } : {})
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-negative integer long-poll wait, or zero when the caller did not ask for one. */
function requestedWaitMilliseconds(toolArguments: Record<string, unknown>): number {
  const wait = toolArguments.waitMilliseconds;
  if (typeof wait !== "number" || !Number.isSafeInteger(wait) || wait < 0) return 0;
  return wait;
}

const nonEmptyString = (value: unknown): string | undefined =>
  (typeof value === "string" && value !== "" ? value : undefined);

/**
 * The thread a `create_thread` result refers to. The hub owns the result shape, so every spelling
 * it plausibly uses is accepted and an unrecognised shape yields no attachment rather than a wrong
 * one. The caller tells the model when nothing was recognised, because a silently unremembered
 * attachment would stop being re-attached after a reconnect.
 */
export function threadIdFromCreateResult(result: unknown): string | undefined {
  if (!isPlainObject(result)) return undefined;
  const direct = nonEmptyString(result.threadId) ?? nonEmptyString(result.id);
  if (direct !== undefined) return direct;
  const thread = result.thread;
  if (!isPlainObject(thread)) return undefined;
  return nonEmptyString(thread.id) ?? nonEmptyString(thread.threadId);
}

const threadIdArgument = (toolArguments: Record<string, unknown>): string | undefined => {
  const threadId = toolArguments.threadId;
  return typeof threadId === "string" && threadId !== "" ? threadId : undefined;
};

/**
 * The MCP surface Claude Code talks to: tools plus the `claude/channel` capability. Every tool call
 * becomes one `rpc.request`; nothing is interpreted here except attachment bookkeeping and the
 * channel-health field the bridge alone knows about.
 */
export class BridgeServer {
  readonly server: Server<Request, ChannelNotification, Result>;
  private readonly hub: HubGateway;
  private readonly logError: (message: string) => void;
  private channelDeliveryObserved = false;
  private listedScopes: readonly OrchestratorClientScope[] = assumedScopes;

  constructor(options: BridgeServerOptions) {
    this.hub = options.hub;
    this.logError = options.logError;
    const serverInfo = { name: channelSourceName, version: options.serverVersion };
    this.server = new Server<Request, ChannelNotification, Result>(serverInfo, {
      capabilities: bridgeCapabilities,
      instructions: bridgeInstructions
    });

    // Replaces the SDK's negotiation, which would otherwise settle on its own latest revision.
    this.server.setRequestHandler(InitializeRequestSchema, (request): InitializeResult => ({
      protocolVersion: negotiateProtocolRevision(request.params.protocolVersion),
      capabilities: bridgeCapabilities,
      serverInfo,
      instructions: bridgeInstructions
    }));

    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      this.listedScopes = this.effectiveScopes();
      return { tools: this.listedTools().map(toListedTool) };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => await this.callTool(request.params.name, request.params.arguments ?? {}));
  }

  channelsState(): ChannelsState {
    return this.channelDeliveryObserved ? "active" : "unknown";
  }

  /**
   * The scopes the tool surface is built from. Claude Code lists tools as soon as it starts the
   * bridge, which can precede the first `client.welcome`; until then only the base scope is
   * assumed, so the approval tools stay hidden rather than being offered on trust.
   */
  private effectiveScopes(): readonly OrchestratorClientScope[] {
    const granted = this.hub.grantedScopes();
    return granted.length > 0 ? granted : assumedScopes;
  }

  /** The tools offered for the scopes the hub granted this credential. */
  listedTools(): readonly (typeof orderedToolDefinitions)[number][] {
    const scopes = this.effectiveScopes();
    return orderedToolDefinitions.filter((definition) => scopes.includes(requiredScopeForExternalOrchestratorTool(definition.name)));
  }

  /**
   * Tells Claude Code the tool list changed when a reconnect granted or withdrew a scope. Delivery
   * is best effort: an unusable transport must never take the bridge down.
   */
  async refreshToolListForScopes(scopes: readonly OrchestratorClientScope[]): Promise<void> {
    const changed = [...this.listedScopes].sort().join() !== [...scopes].sort().join();
    this.listedScopes = [...scopes];
    if (!changed) return;
    try {
      await this.server.sendToolListChanged();
    } catch (error) {
      this.logError(`could not announce the tool list change: ${describe(error)}`);
    }
  }

  /**
   * Emits one channel event. A transport failure is logged and swallowed: channel delivery is
   * fire-and-forget, and the acknowledged cursor behind `get_thread_events` remains the truth.
   */
  async emitChannelEvent(content: string, meta: Partial<Record<ChannelMetaKey, string>>): Promise<boolean> {
    const filtered: Record<string, string> = {};
    for (const key of channelMetaKeys) {
      const value = meta[key];
      if (value !== undefined) filtered[key] = value;
    }
    try {
      await this.server.notification({ method: channelNotificationMethod, params: { content, meta: filtered } });
    } catch (error) {
      this.logError(`could not deliver a channel event: ${describe(error)}`);
      return false;
    }
    this.channelDeliveryObserved = true;
    return true;
  }

  async announceDoorbell(doorbell: HubDoorbell): Promise<boolean> {
    return await this.emitChannelEvent(doorbell.summary, doorbellMeta(doorbell));
  }

  async announceAttachmentReplaced(replaced: HubAttachmentReplaced): Promise<boolean> {
    return await this.emitChannelEvent(
      `Thread ${replaced.threadId} was taken over by another session`,
      { thread_id: replaced.threadId }
    );
  }

  async announceRevocation(): Promise<boolean> {
    return await this.emitChannelEvent(
      "This Coffee Shop orchestrator credential was revoked. Every Coffee Shop tool will fail until a new credential is configured.",
      {}
    );
  }

  private async callTool(name: string, toolArguments: Record<string, unknown>): Promise<CallToolResult> {
    if (!isExternalOrchestratorToolName(name)) {
      return toolError({ code: "not_found", message: `${name} is not a Coffee Shop orchestrator tool` });
    }
    if (this.hub.isRevoked()) {
      return toolError({ code: "revoked", message: "this orchestrator credential was revoked by an operator; mint a new one in the Coffee Shop app" });
    }
    const requiredScope = requiredScopeForExternalOrchestratorTool(name);
    // Only a welcome proves the granted scopes; while disconnected the call fails fast below
    // instead of being reported as a scope problem it may not have.
    if (this.hub.isReady() && !this.hub.grantedScopes().includes(requiredScope)) {
      return toolError({ code: "forbidden", message: `${name} requires the ${requiredScope} scope, which this Coffee Shop credential does not hold` });
    }

    const extraWait = name === "get_thread_events" ? requestedWaitMilliseconds(toolArguments) : 0;
    const outcome = await this.hub.call(name, toolArguments, extraWait);
    if (!outcome.ok) {
      if (name === "attach_thread" && outcome.error.code !== "hub_unavailable") {
        const threadId = threadIdArgument(toolArguments);
        if (threadId !== undefined) this.hub.forgetAttachment(threadId);
      }
      return toolError(outcome.error);
    }
    return toolSuccess(this.decorate(name, toolArguments, outcome.result));
  }

  /** Applies the bookkeeping and the one result field the bridge owns rather than the hub. */
  private decorate(name: ExternalOrchestratorToolName, toolArguments: Record<string, unknown>, result: unknown): unknown {
    switch (name) {
      case "create_thread": {
        const threadId = threadIdFromCreateResult(result);
        if (threadId !== undefined) {
          this.hub.rememberAttachment(threadId);
          return result;
        }
        this.logError("create_thread returned no recognisable thread id; the attachment will not survive a reconnect");
        const unremembered = { attachmentRemembered: false, attachmentInstruction: unrememberedAttachmentInstruction };
        return isPlainObject(result) ? { ...result, ...unremembered } : { context: result, ...unremembered };
      }
      case "attach_thread": {
        const threadId = threadIdArgument(toolArguments);
        if (threadId !== undefined) this.hub.rememberAttachment(threadId);
        return result;
      }
      case "detach_thread": {
        const threadId = threadIdArgument(toolArguments);
        if (threadId !== undefined) this.hub.forgetAttachment(threadId);
        return result;
      }
      case "get_thread_context": {
        const channels = this.channelsState();
        if (isPlainObject(result)) return { ...result, channels, channelsInstruction: channelFallbackInstruction };
        return { context: result, channels, channelsInstruction: channelFallbackInstruction };
      }
      default:
        return result;
    }
  }
}

const toListedTool = (definition: (typeof orderedToolDefinitions)[number]) => ({
  name: definition.name,
  title: definition.title,
  description: definition.description,
  inputSchema: definition.inputSchema
});

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export { toolDefinitions };
