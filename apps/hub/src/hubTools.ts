import { isHubToolName, type HubRpcError, type Task } from "@coffee-shop/protocol";
import { createArtifact, delegateTask, submitTasks, taskContext, updateTask } from "./coordination.js";
import { CoordinationError } from "./coordinationError.js";
import { executionInventory, type InventoryEnvironment } from "./executionInventory.js";
import { sendTaskMessage, TaskEventWaiters } from "./mailbox.js";
import { orchestratorCursorAdvances, persistOrchestratorCursor } from "./orchestratorInbox.js";
import type { State, Store } from "./store.js";
import { updateThreadForRun } from "./threads.js";

export interface HubToolEnvironment {
  store: Store;
  waiters: TaskEventWaiters;
  inventory(): Omit<InventoryEnvironment, "now">;
  /** Runs a scheduling pass and resolves when it has finished; it never rejects. */
  schedule(): Promise<void>;
  /** Publishes a new snapshot after a mutation. */
  broadcast(): void;
  /** How long a submission waits for its first scheduling pass before answering. */
  schedulingWaitMilliseconds?: number;
}

const defaultSchedulingWaitMilliseconds = 2_000;

async function boundedWait(operation: Promise<void>, milliseconds: number) {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([operation, new Promise<void>((resolve) => { timer = setTimeout(resolve, milliseconds); })]);
  clearTimeout(timer);
}

/** The latest committed view of submitted tasks, including any placement the first pass recorded. */
export function submittedTask(state: Readonly<State>, task: Task) {
  const current = state.tasks?.find((item) => item.id === task.id) ?? task;
  return {
    id: current.id,
    title: current.title,
    status: current.status,
    dependencies: current.dependencies.map((dependency) => ({ ...dependency })),
    ...(current.placementOverride ? { placementOverride: { ...current.placementOverride } } : {}),
    ...(current.assignment ? { assignment: { ...current.assignment } } : {}),
    ...(current.placement ? { placement: structuredClone(current.placement) } : {})
  };
}

/** Maps any failure to the typed error returned to Barista; unexpected errors never leak detail. */
export function hubToolError(error: unknown): HubRpcError {
  const failure = error instanceof CoordinationError ? error : new CoordinationError("internal_error", "The hub could not complete the tool call", true);
  return { code: failure.code, message: failure.message, retryable: failure.retryable };
}

/**
 * Serves one correlated hub RPC for an authenticated source run. Every operation derives its
 * thread, sender, lineage, and workspace from `sourceRunId`; arguments are untrusted model input.
 * Submissions request scheduling after they commit, and their success never depends on placement.
 */
export function createHubToolHandler(environment: HubToolEnvironment) {
  const { store } = environment;
  const settleScheduling = () => boundedWait(environment.schedule(), environment.schedulingWaitMilliseconds ?? defaultSchedulingWaitMilliseconds);
  return async (operation: unknown, sourceRunId: string, argumentsValue: unknown, signal?: AbortSignal): Promise<unknown> => {
    if (!isHubToolName(operation)) throw new CoordinationError("unknown_tool", "The requested hub tool is not supported");
    const values = argumentsValue === undefined ? {} : argumentsValue;
    switch (operation) {
      case "get_task_context":
        return store.read((state) => structuredClone(taskContext(state, sourceRunId, values)));
      case "get_execution_inventory":
        return store.read((state) => structuredClone(executionInventory(state, sourceRunId, values, { ...environment.inventory(), now: new Date().toISOString() })));
      case "submit_tasks": {
        const result = await submitTasks(store, sourceRunId, values);
        if (result.created) {
          environment.broadcast();
          await settleScheduling();
        }
        return store.read((state) => ({
          created: result.created,
          submissionId: result.submissionId,
          taskIdsByKey: { ...result.taskIdsByKey },
          tasks: result.tasks.map((task) => submittedTask(state, task))
        }));
      }
      case "delegate_task": {
        const result = await delegateTask(store, sourceRunId, values);
        if (result.task && result.created) {
          environment.broadcast();
          await settleScheduling();
        }
        return store.read((state) => {
          const task = result.task && submittedTask(state, result.task);
          return {
            taskId: result.taskId,
            status: task?.status ?? result.status,
            agentId: result.agentId,
            created: result.created,
            ...(task?.assignment ? { assignment: task.assignment } : {}),
            ...(task?.placement ? { placement: task.placement } : {})
          };
        });
      }
      case "send_task_message": {
        const result = await sendTaskMessage(store, sourceRunId, values);
        if (result.created) environment.broadcast();
        return { created: result.created, messageId: result.message.id, sequence: result.message.sequence, recipient: result.message.recipient, createdAt: result.message.createdAt };
      }
      case "wait_for_task_events": {
        const cursor = typeof values === "object" && values !== null ? (values as { cursor?: unknown }).cursor : undefined;
        // The cursor acknowledges processing only once the whole call is valid; checking first keeps a
        // wait that proves nothing from yielding before it registers.
        const acknowledgeCursor = () => store.read((state) => orchestratorCursorAdvances(state, sourceRunId, cursor, "processed"))
          ? persistOrchestratorCursor(store, sourceRunId, cursor, "processed").then((changed) => { if (changed) environment.broadcast(); })
          : undefined;
        const result = await environment.waiters.wait(sourceRunId, values, signal, acknowledgeCursor);
        if (result.events.length && await persistOrchestratorCursor(store, sourceRunId, result.cursor, "delivered")) environment.broadcast();
        return result;
      }
      case "update_task": {
        const result = await updateTask(store, sourceRunId, values);
        if (result.created) environment.broadcast();
        return result;
      }
      case "post_artifact": {
        const result = await createArtifact(store, sourceRunId, values);
        environment.broadcast();
        return result;
      }
      case "update_thread": {
        const thread = await updateThreadForRun(store, sourceRunId, values);
        environment.broadcast();
        return { thread };
      }
    }
  };
}
