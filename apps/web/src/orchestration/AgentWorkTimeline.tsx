import { ArrowBendDownRight, ArrowBendUpRight, ClipboardText, ShieldWarning, TerminalWindow } from "@phosphor-icons/react";
import { isActiveRunStatus, type Agent, type ApprovalRequest, type ChatMessage, type Run, type RunActivity, type Task, type TaskMessage, type Thread } from "@coffee-shop/protocol";
import { taskMessageKindLabels, taskStatusLabels, timeAgo, toolCallKindLabels, toolCallStatusLabels } from "./orchestrationLabels.js";

/**
 * One item in an agent's chat. Task work reaches an agent through the task graph rather than
 * through chat messages, so the timeline merges the agent's chat with the tasks it was assigned,
 * the mailbox traffic it sent or received, and live activity for its runs still in progress.
 */
export type AgentTimelineEntry =
  | { kind: "chat"; id: string; at: string; message: ChatMessage }
  | { kind: "assignment"; id: string; at: string; task: Task; run: Run; assignedBy: string; attempts: number }
  | { kind: "mailbox"; id: string; at: string; message: TaskMessage; direction: "incoming" | "outgoing"; counterpart: string }
  | { kind: "live"; id: string; at: string; run: Run; task?: Task; activity?: RunActivity; pendingApprovals: ApprovalRequest[]; linkedFromChat: boolean };

export interface AgentTimelineSources {
  agentId: string;
  threadId?: string;
  agents: Agent[];
  messages: ChatMessage[];
  runs: Run[];
  tasks: Task[];
  threads: Thread[];
  taskMessages: TaskMessage[];
  runActivity: RunActivity[];
  approvals: ApprovalRequest[];
}

export function buildAgentTimeline(sources: AgentTimelineSources): AgentTimelineEntry[] {
  const { agentId, threadId, agents, runs, tasks, threads } = sources;
  const agentName = (id: string | undefined) => agents.find((agent) => agent.id === id)?.name ?? id ?? "Operator";
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const inScope = (entryThreadId: string | undefined) => !threadId || entryThreadId === threadId;
  const entries: AgentTimelineEntry[] = [];

  const runsLinkedFromChat = new Set<string>();
  for (const message of sources.messages) {
    if (message.agentId !== agentId || !inScope(message.threadId)) continue;
    entries.push({ kind: "chat", id: `chat:${message.id}`, at: message.createdAt, message });
    if (message.runId) runsLinkedFromChat.add(message.runId);
  }

  const ownTaskRuns = runs.filter((run) => run.agentId === agentId && run.taskId && inScope(run.threadId));
  const ownTaskIds = new Set(ownTaskRuns.map((run) => run.taskId!));
  // One card per task: a retried task keeps its first assignment's place and counts its attempts.
  const attemptsByTask = new Map<string, Run[]>();
  for (const run of ownTaskRuns) attemptsByTask.set(run.taskId!, [...(attemptsByTask.get(run.taskId!) ?? []), run]);
  for (const [taskId, attempts] of attemptsByTask) {
    const task = tasksById.get(taskId);
    if (!task) continue;
    const first = attempts.reduce((earliest, run) => run.createdAt < earliest.createdAt ? run : earliest);
    const source = task.sourceRunId ? runsById.get(task.sourceRunId) : undefined;
    entries.push({ kind: "assignment", id: `assignment:${taskId}`, at: first.createdAt, task, run: first, assignedBy: source ? agentName(source.agentId) : "Operator", attempts: attempts.length });
  }

  for (const run of runs) {
    if (run.agentId !== agentId || !isActiveRunStatus(run.status) || !inScope(run.threadId)) continue;
    const activity = sources.runActivity.find((item) => item.runId === run.id);
    const pendingApprovals = sources.approvals.filter((approval) => approval.runId === run.id && approval.status === "pending");
    entries.push({ kind: "live", id: `live:${run.id}`, at: activity?.updatedAt ?? run.createdAt, run, task: run.taskId ? tasksById.get(run.taskId) : undefined, activity, pendingApprovals, linkedFromChat: runsLinkedFromChat.has(run.id) });
  }

  const orchestratedThreadIds = new Set(threads.filter((thread) => thread.ownerAgentId === agentId).map((thread) => thread.id));
  const taskOwner = (taskId: string) => {
    const task = tasksById.get(taskId);
    const assignee = task?.assignment?.agentId ?? (task?.attemptRunIds.length ? runsById.get(task.attemptRunIds[task.attemptRunIds.length - 1])?.agentId : undefined);
    return task ? `${agentName(assignee)} · ${task.title}` : taskId;
  };
  const describe = (participant: TaskMessage["sender"], threadOwnerId: string | undefined) =>
    participant.type === "task" ? taskOwner(participant.taskId) : participant.type === "orchestrator" ? agentName(threadOwnerId) : "Operator";

  for (const message of sources.taskMessages) {
    if (!inScope(message.threadId)) continue;
    const threadOwnerId = threads.find((thread) => thread.id === message.threadId)?.ownerAgentId;
    const isMine = (participant: TaskMessage["sender"]) =>
      (participant.type === "task" && ownTaskIds.has(participant.taskId)) ||
      (participant.type === "orchestrator" && orchestratedThreadIds.has(message.threadId));
    const direction = isMine(message.sender) ? "outgoing" : isMine(message.recipient) ? "incoming" : undefined;
    if (!direction) continue;
    const counterpart = describe(direction === "outgoing" ? message.recipient : message.sender, threadOwnerId);
    entries.push({ kind: "mailbox", id: `mailbox:${message.id}`, at: message.createdAt, message, direction, counterpart });
  }

  return entries.sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
}

/** The latest agent text, trimmed to its most recent paragraph-sized tail for the chat card. */
function latestText(activity: RunActivity | undefined, limit = 600): string {
  const text = activity?.summary || activity?.message.text || "";
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}

export function AgentTimelineItem({ entry, onInspectRun, onReviewApproval }: {
  entry: Exclude<AgentTimelineEntry, { kind: "chat" }>;
  onInspectRun: (runId: string) => void;
  onReviewApproval: (approvalId: string) => void;
}) {
  if (entry.kind === "assignment") {
    return (
      <article className="timeline-assignment">
        <div className="message-meta"><ClipboardText size={13} /><strong>Task from {entry.assignedBy}</strong><span>{timeAgo(entry.at)}</span></div>
        <h3>{entry.task.title}</h3>
        <details><summary>Instructions</summary><p>{entry.task.instructions}</p></details>
        <small>{taskStatusLabels[entry.task.status]}{entry.attempts > 1 ? ` · ${entry.attempts} attempts` : ""}</small>
      </article>
    );
  }
  if (entry.kind === "mailbox") {
    const Arrow = entry.direction === "outgoing" ? ArrowBendUpRight : ArrowBendDownRight;
    return (
      <article className={`timeline-mailbox timeline-mailbox-${entry.direction}`}>
        <div className="message-meta">
          <Arrow size={13} />
          <strong>{entry.direction === "outgoing" ? `To ${entry.counterpart}` : `From ${entry.counterpart}`}</strong>
          <span className="task-message-kind-label">{taskMessageKindLabels[entry.message.kind]}</span>
          <span>{timeAgo(entry.at)}</span>
        </div>
        <p>{entry.message.body}</p>
      </article>
    );
  }
  const recentToolCalls = entry.activity?.toolCalls.slice(-5) ?? [];
  const text = latestText(entry.activity);
  return (
    <article className="timeline-live" aria-live="polite">
      <div className="message-meta"><span className="timeline-live-pulse" aria-hidden="true" /><strong>{entry.run.status === "queued" ? "Queued" : "Working"}{entry.task ? ` on ${entry.task.title}` : ""}</strong><span>updated {timeAgo(entry.at)}</span></div>
      {entry.activity && entry.activity.plan.length > 0 && (
        <ul className="run-plan">{entry.activity.plan.map((item, index) => <li key={`${index}:${item.content}`} className={`plan-status-${item.status}`}>{item.content}</li>)}</ul>
      )}
      {recentToolCalls.length > 0 && (
        <ul className="timeline-tool-calls">
          {recentToolCalls.map((call) => (
            <li key={call.toolCallId} className={`tool-call-status-${call.status}`}>
              <span className="tool-call-kind">{toolCallKindLabels[call.kind]}</span>
              <code>{call.title}</code>
              <span>{toolCallStatusLabels[call.status]}</span>
            </li>
          ))}
        </ul>
      )}
      {text && <p>{text}</p>}
      {entry.pendingApprovals.map((approval) => (
        <button key={approval.id} className="timeline-approval" onClick={() => onReviewApproval(approval.id)}>
          <ShieldWarning size={14} weight="fill" /> Approval needed: {approval.title}
        </button>
      ))}
      {!entry.linkedFromChat && <button className="run-link" onClick={() => onInspectRun(entry.run.id)}><TerminalWindow size={14} /> Inspect run</button>}
    </article>
  );
}
