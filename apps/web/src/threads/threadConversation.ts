import type { ChatMessage, Run, RunTranscriptEntry, Task, TaskMessage, TaskMessageKind, Thread, TimelineEvent } from "@coffee-shop/protocol";

/**
 * One item in a thread's conversation. The operator's messages and the orchestrator's turns read as
 * a chat; each orchestrator run is one turn, streamed from its transcript. Worker tasks are shown in
 * the conversation where they were created, grouped with their attempts, and lifecycle changes of
 * the thread itself become dividers.
 */
export type ConversationItem =
  | { kind: "operator"; id: string; at: string; body: string }
  | { kind: "reply"; id: string; at: string; body: string; messageKind?: TaskMessageKind; runId?: string }
  /** `reply` is a chat reply the run posted, shown when the run left no transcript or output. */
  | { kind: "turn"; id: string; at: string; run: Run; reply?: string }
  | { kind: "task"; id: string; at: string; task: Task; attempts: Run[] }
  | { kind: "divider"; id: string; at: string; text: string };

export interface ConversationSources {
  thread: Thread;
  runs: Run[];
  tasks: Task[];
  messages: ChatMessage[];
  taskMessages: TaskMessage[];
  events: TimelineEvent[];
}

const dividerTitles = new Set(["Thread completed", "Thread reopened", "Thread archived"]);

export function buildThreadConversation({ thread, runs, tasks, messages, taskMessages, events }: ConversationSources): ConversationItem[] {
  const items: ConversationItem[] = [];
  const threadRuns = runs.filter((run) => run.threadId === thread.id);
  const runIds = new Set(threadRuns.map((run) => run.id));
  const replies = new Map<string, string>();

  for (const message of taskMessages) {
    if (message.threadId !== thread.id) continue;
    if (message.sender.type === "operator") {
      items.push({ kind: "operator", id: `taskmsg:${message.id}`, at: message.createdAt, body: message.body });
    } else if (message.sender.type === "orchestrator" && message.recipient.type === "operator") {
      items.push({ kind: "reply", id: `taskmsg:${message.id}`, at: message.createdAt, body: message.body, messageKind: message.kind, runId: message.sourceRunId });
    }
  }

  for (const message of messages) {
    if (message.threadId !== thread.id) continue;
    if (message.author === "you") {
      items.push({ kind: "operator", id: `chat:${message.id}`, at: message.createdAt, body: message.body });
    } else if (message.kind === "handoff" || message.author === "system") {
      items.push({ kind: "divider", id: `chat:${message.id}`, at: message.createdAt, text: message.body });
    } else if (message.runId && runIds.has(message.runId)) {
      replies.set(message.runId, replies.has(message.runId) ? `${replies.get(message.runId)}\n\n${message.body}` : message.body);
    } else {
      // A reply that names one of the thread's runs is already that run's turn.
      items.push({ kind: "reply", id: `chat:${message.id}`, at: message.createdAt, body: message.body, runId: message.runId });
    }
  }

  for (const run of threadRuns) {
    if (run.taskId === undefined) items.push({ kind: "turn", id: `run:${run.id}`, at: run.createdAt, run, ...(replies.has(run.id) ? { reply: replies.get(run.id) } : {}) });
  }

  const runsById = new Map(threadRuns.map((run) => [run.id, run]));
  for (const task of tasks) {
    if (task.threadId !== thread.id) continue;
    const attempts = task.attemptRunIds.map((id) => runsById.get(id)).filter((run): run is Run => run !== undefined);
    items.push({ kind: "task", id: `task:${task.id}`, at: task.createdAt, task, attempts });
  }

  for (const event of events) {
    if (event.threadId === thread.id && event.type === "status" && dividerTitles.has(event.title)) {
      items.push({ kind: "divider", id: `event:${event.id}`, at: event.createdAt, text: event.title });
    }
  }

  return items.sort((left, right) => left.at.localeCompare(right.at) || kindOrder[left.kind] - kindOrder[right.kind] || left.id.localeCompare(right.id));
}

/** Within one instant, a reopen precedes the message that caused it, and a message the run it wakes. */
const kindOrder: Record<ConversationItem["kind"], number> = { divider: 0, operator: 1, reply: 2, task: 3, turn: 4 };

/** A rendered transcript block: consecutive message entries read as one reply. */
export type TranscriptBlock =
  | { kind: "text"; key: string; text: string; truncatedBytes: number }
  | { kind: "entry"; key: string; entry: Exclude<RunTranscriptEntry, { kind: "message" }> };

export function transcriptBlocks(entries: RunTranscriptEntry[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  for (const entry of entries) {
    if (entry.kind === "message") {
      const last = blocks.at(-1);
      if (last?.kind === "text") {
        last.text += entry.text;
        last.truncatedBytes += entry.truncatedBytes;
      } else {
        blocks.push({ kind: "text", key: `text:${entry.id}`, text: entry.text, truncatedBytes: entry.truncatedBytes });
      }
      continue;
    }
    blocks.push({ kind: "entry", key: `${entry.kind}:${entry.id}`, entry });
  }
  return blocks;
}
