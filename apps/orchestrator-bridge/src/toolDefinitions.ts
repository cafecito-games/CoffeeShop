import { externalOrchestratorToolNames, type ExternalOrchestratorToolName } from "@coffee-shop/protocol";

export interface ToolSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: boolean;
}

export interface ToolDefinition {
  name: ExternalOrchestratorToolName;
  title: string;
  description: string;
  inputSchema: ToolSchema;
}

const threadIdProperty = { type: "string", description: "Coffee Shop thread id." } as const;

/**
 * Only the tools the bridge itself interprets constrain their arguments here. The pass-through
 * tools keep an open schema on purpose: the hub owns their semantics and validates them, and a
 * second copy of those rules in the bridge would drift from the hub's.
 */
const passThroughSchema = (properties: Record<string, unknown>, required: string[]): ToolSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: true
});

const closedSchema = (properties: Record<string, unknown>, required: string[]): ToolSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false
});

export const toolDefinitions: Readonly<Record<ExternalOrchestratorToolName, ToolDefinition>> = {
  create_thread: {
    name: "create_thread",
    title: "Create thread",
    description: "Creates a Coffee Shop thread orchestrated by this session and attaches to it.",
    inputSchema: closedSchema({
      title: { type: "string", description: "Short human-readable thread title." },
      objective: { type: "string", description: "What the thread should accomplish." }
    }, ["title", "objective"])
  },
  list_threads: {
    name: "list_threads",
    title: "List threads",
    description: "Lists the threads orchestrated by this credential with attachment status and unread counts.",
    inputSchema: closedSchema({}, [])
  },
  attach_thread: {
    name: "attach_thread",
    title: "Attach thread",
    description: "Attaches this session to a thread, replacing any other session's attachment.",
    inputSchema: closedSchema({ threadId: threadIdProperty }, ["threadId"])
  },
  detach_thread: {
    name: "detach_thread",
    title: "Detach thread",
    description: "Releases this session's attachment on a thread. Workers keep running.",
    inputSchema: closedSchema({ threadId: threadIdProperty }, ["threadId"])
  },
  get_thread_context: {
    name: "get_thread_context",
    title: "Get thread context",
    description: "Returns the bounded durable context of a thread: summary, task graph, open approvals, event cursor, and whether Coffee Shop doorbells are reaching this session.",
    inputSchema: closedSchema({ threadId: threadIdProperty }, ["threadId"])
  },
  get_thread_events: {
    name: "get_thread_events",
    title: "Get thread events",
    description: "Reads orchestrator events for a thread. Passing a cursor acknowledges everything up to it. Set waitMilliseconds to long-poll when doorbells are not arriving.",
    inputSchema: closedSchema({
      threadId: threadIdProperty,
      cursor: { type: "string", description: "Acknowledge every event up to this cursor." },
      waitMilliseconds: { type: "integer", minimum: 0, description: "How long the hub may hold the call open waiting for new events." }
    }, ["threadId"])
  },
  submit_tasks: {
    name: "submit_tasks",
    title: "Submit tasks",
    description: "Submits tasks to a thread for the hub to dispatch to Barista nodes.",
    inputSchema: passThroughSchema({
      threadId: threadIdProperty,
      tasks: { type: "array", description: "Task definitions, as accepted by the hub." },
      idempotencyKey: { type: "string", description: "Makes a retry after a reconnect safe." }
    }, ["threadId", "tasks"])
  },
  update_task: {
    name: "update_task",
    title: "Update task",
    description: "Updates one task in a thread.",
    inputSchema: passThroughSchema({
      threadId: threadIdProperty,
      taskId: { type: "string", description: "Task id." }
    }, ["threadId", "taskId"])
  },
  send_task_message: {
    name: "send_task_message",
    title: "Send task message",
    description: "Sends a message to the worker running a task.",
    inputSchema: passThroughSchema({
      threadId: threadIdProperty,
      taskId: { type: "string", description: "Task id." },
      message: { type: "string", description: "Message for the worker." }
    }, ["threadId", "taskId", "message"])
  },
  update_thread: {
    name: "update_thread",
    title: "Update thread",
    description: "Updates thread-level fields such as title, objective, or status.",
    inputSchema: passThroughSchema({ threadId: threadIdProperty }, ["threadId"])
  },
  get_execution_inventory: {
    name: "get_execution_inventory",
    title: "Get execution inventory",
    description: "Reports the compute nodes, harnesses, providers, and projects available for dispatch.",
    inputSchema: passThroughSchema({}, [])
  },
  list_approvals: {
    name: "list_approvals",
    title: "List approvals",
    description: "Lists the open worker approvals on a thread. Requires the resolve-approvals scope.",
    inputSchema: passThroughSchema({ threadId: threadIdProperty }, ["threadId"])
  },
  resolve_approval: {
    name: "resolve_approval",
    title: "Resolve approval",
    description: "Answers or cancels one worker approval. Requires the resolve-approvals scope.",
    inputSchema: passThroughSchema({
      approvalId: { type: "string", description: "Approval id." },
      optionId: { type: "string", description: "The option to choose; omit when cancelling." },
      cancel: { type: "boolean", description: "Cancel the approval instead of choosing an option." },
      idempotencyKey: { type: "string", description: "Makes a retry after a reconnect safe." }
    }, ["approvalId", "idempotencyKey"])
  }
};

/** Definitions in the protocol's declared order, so the listed surface is stable across runs. */
export const orderedToolDefinitions: readonly ToolDefinition[] = externalOrchestratorToolNames.map((name) => toolDefinitions[name]);
