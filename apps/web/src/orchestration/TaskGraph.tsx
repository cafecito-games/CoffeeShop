import { useMemo, useState } from "react";
import { CaretDown, CaretRight, Envelope, TerminalWindow } from "@phosphor-icons/react";
import { dependencyOutcome, isTerminalTaskStatus, type Agent, type ComputeNode, type Run, type Task, type TaskDependency, type TaskMessage, type TaskMessageAcknowledgement } from "@coffee-shop/protocol";
import { participantLabel, placementRequirementLabels, taskMessageKindLabels, taskStatusLabels, timeAgo } from "./orchestrationLabels.js";
import { ReadinessPanel } from "./ReadinessPanel.js";

const dependencyOutcomeLabels: Record<ReturnType<typeof dependencyOutcome>, string> = {
  waiting: "Waiting",
  satisfied: "Satisfied",
  blocking: "Blocking"
};

interface DependencyDetail {
  dependency: TaskDependency;
  dependencyTask: Task | undefined;
  outcome: ReturnType<typeof dependencyOutcome>;
}

function dependencyDetailsFor(task: Task, byId: Map<string, Task>): DependencyDetail[] {
  return task.dependencies.map((dependency) => {
    const dependencyTask = byId.get(dependency.taskId);
    const outcome = dependencyTask ? dependencyOutcome(dependency.policy, dependencyTask.status) : "waiting";
    return { dependency, dependencyTask, outcome };
  });
}

/**
 * What to show in place of the assignment block for a task with no assignment. A terminal task
 * never says "Not yet placed" — that label only ever applies while placement could still happen.
 */
function unplacedOutcomeText(task: Task, dependencyDetails: DependencyDetail[]): string {
  if (!isTerminalTaskStatus(task.status)) {
    return `Not yet placed${task.attemptRunIds.length > 0 ? ` · ${task.attemptRunIds.length} previous attempt(s)` : ""}.`;
  }
  if (task.status === "blocked") {
    const blocking = dependencyDetails.find((detail) => detail.outcome === "blocking");
    const label = blocking ? blocking.dependencyTask?.title ?? `task ${blocking.dependency.taskId} (unavailable)` : "an unmet dependency";
    return `Blocked by ${label}.`;
  }
  return task.attemptRunIds.length > 0
    ? `${taskStatusLabels[task.status]} · ${task.attemptRunIds.length} attempt(s).`
    : `${taskStatusLabels[task.status]} · no attempts were made.`;
}

function taskDepth(task: Task, byId: Map<string, Task>, seen: Set<string> = new Set()): number {
  if (seen.has(task.id) || task.dependencies.length === 0) return 0;
  const nextSeen = new Set(seen).add(task.id);
  let depth = 0;
  for (const dependency of task.dependencies) {
    const dependencyTask = byId.get(dependency.taskId);
    if (!dependencyTask) continue;
    depth = Math.max(depth, 1 + taskDepth(dependencyTask, byId, nextSeen));
  }
  return depth;
}

function TaskMailbox({ task, taskMessages, taskMessageAcknowledgements, byId }: {
  task: Task;
  taskMessages: TaskMessage[];
  taskMessageAcknowledgements: TaskMessageAcknowledgement[];
  byId: Map<string, Task>;
}) {
  const [open, setOpen] = useState(false);
  const isThisTask = (participant: TaskMessage["sender"]) => participant.type === "task" && participant.taskId === task.id;
  const messages = useMemo(() => taskMessages
    .filter((message) => isThisTask(message.sender) || isThisTask(message.recipient))
    .sort((left, right) => left.sequence - right.sequence), [taskMessages, task.id]);
  const acknowledgedIds = useMemo(() => new Set(taskMessageAcknowledgements.map((ack) => ack.messageId)), [taskMessageAcknowledgements]);
  if (messages.length === 0) return null;
  return (
    <div className="task-mailbox">
      <button type="button" className="task-disclosure" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? <CaretDown size={12} /> : <CaretRight size={12} />}<Envelope size={13} /> Messages ({messages.length})
      </button>
      {open && (
        <ul className="task-message-list">
          {messages.map((message) => (
            <li key={message.id} className={`task-message-kind-${message.kind}`}>
              <div className="task-message-heading">
                <span>{participantLabel(message.sender, byId.get(message.sender.type === "task" ? message.sender.taskId : "")?.title)}</span>
                <span className="task-message-arrow">→</span>
                <span>{participantLabel(message.recipient, byId.get(message.recipient.type === "task" ? message.recipient.taskId : "")?.title)}</span>
                <span className="task-message-kind-label">{taskMessageKindLabels[message.kind]}</span>
                <time>{timeAgo(message.createdAt)}</time>
              </div>
              <p>{message.body}</p>
              <small>{acknowledgedIds.has(message.id) ? "Acknowledged" : "Awaiting acknowledgement"}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function TaskGraph({ tasks, threadId, agents, nodes, taskMessages, taskMessageAcknowledgements, apiFetch, onInspectRun }: {
  tasks: Task[];
  threadId: string;
  agents: Agent[];
  nodes: ComputeNode[];
  taskMessages: TaskMessage[];
  taskMessageAcknowledgements: TaskMessageAcknowledgement[];
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onInspectRun: (runId: string) => void;
}) {
  const threadTasks = useMemo(() => tasks.filter((task) => task.threadId === threadId), [tasks, threadId]);
  const byId = useMemo(() => new Map(threadTasks.map((task) => [task.id, task])), [threadTasks]);
  const nodeNames = useMemo(() => new Map(nodes.map((node) => [node.id, node.name])), [nodes]);
  const ordered = useMemo(() => [...threadTasks].sort((left, right) => {
    const depthDelta = taskDepth(left, byId) - taskDepth(right, byId);
    return depthDelta !== 0 ? depthDelta : left.createdAt.localeCompare(right.createdAt);
  }), [threadTasks, byId]);

  if (ordered.length === 0) return <div className="task-graph-empty"><strong>No tasks yet</strong><p>Tasks appear here once an agent submits a batch for this thread.</p></div>;

  return (
    <ul className="task-graph" role="list">
      {ordered.map((task) => {
        const depth = taskDepth(task, byId);
        const agent = task.assignment ? agents.find((item) => item.id === task.assignment!.agentId) : undefined;
        const dependencyDetails = dependencyDetailsFor(task, byId);
        const showPlacement = task.placement !== undefined && task.placement.unsatisfied.length > 0;
        return (
          <li key={task.id} className="task-card" style={{ "--task-depth": depth } as { [key: string]: number }}>
            <header className="task-card-heading">
              <span className={`task-status task-status-${task.status}`}>{taskStatusLabels[task.status]}</span>
              <h3>{task.title}</h3>
            </header>
            {dependencyDetails.length > 0 && (
              <ul className="task-dependencies">
                {dependencyDetails.map(({ dependency, dependencyTask, outcome }) => (
                  <li key={dependency.taskId} className={`dependency-outcome-${outcome}`}>
                    {dependencyTask?.title ?? `Task ${dependency.taskId} (unavailable)`}
                    <small>{dependencyOutcomeLabels[outcome]} · {dependency.policy === "require-success" ? "requires success" : "allows failure"}</small>
                  </li>
                ))}
              </ul>
            )}
            {task.assignment ? (
              <dl className="task-assignment">
                <div><dt>Assignee</dt><dd>{agent?.name ?? `${task.assignment.agentId} (unavailable)`}</dd></div>
                <div><dt>Compute</dt><dd>{nodeNames.get(task.assignment.nodeId) ?? `${task.assignment.nodeId} (unavailable)`}</dd></div>
                <div><dt>Harness / transport</dt><dd>{task.assignment.harnessId} · {task.assignment.transport}</dd></div>
                <div><dt>Attempts</dt><dd>{task.attemptRunIds.length}</dd></div>
              </dl>
            ) : (
              <p className="task-unassigned">{unplacedOutcomeText(task, dependencyDetails)}</p>
            )}
            {task.attemptRunIds.length > 0 && (
              <div className="task-attempts">
                {task.attemptRunIds.map((runId, index) => (
                  <button key={runId} onClick={() => onInspectRun(runId)}><TerminalWindow size={13} /> Attempt {index + 1}</button>
                ))}
              </div>
            )}
            {task.progress?.summary && <p className="task-progress">{task.progress.summary}</p>}
            {task.progress?.blockedReason && <p className="task-progress task-progress-blocked">Waiting: {task.progress.blockedReason}</p>}
            {task.error && <p className="task-error" role="alert">{task.error}</p>}
            {showPlacement && task.placement && (
              <div className="task-placement">
                <div className="task-placement-heading">Placement · {task.placement.eligibleNodeIds.length} eligible node(s) · evaluated {timeAgo(task.placement.evaluatedAt)}</div>
                {task.placement.unsatisfied.length > 0 && (
                  <ul className="task-placement-reasons">
                    {task.placement.unsatisfied.map((reason, index) => (
                      <li key={index}><strong>{placementRequirementLabels[reason.kind]}</strong> {reason.requirement} — {reason.detail}{reason.nodeId ? ` (${nodeNames.get(reason.nodeId) ?? reason.nodeId})` : ""}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {task.requirements.projectProfileId && <ReadinessPanel projectId={task.requirements.projectProfileId} nodeNames={nodeNames} apiFetch={apiFetch} />}
            <TaskMailbox task={task} taskMessages={taskMessages} taskMessageAcknowledgements={taskMessageAcknowledgements} byId={byId} />
          </li>
        );
      })}
    </ul>
  );
}
