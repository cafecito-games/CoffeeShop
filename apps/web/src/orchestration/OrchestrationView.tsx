import { useMemo, useState } from "react";
import { FolderOpen } from "@phosphor-icons/react";
import type {
  Agent, ApprovalRequest, ComputeNode, Run, Task, TaskMessage, TaskMessageAcknowledgement, Thread, WorkspaceLease
} from "@coffee-shop/protocol";
import { ApprovalsView } from "./ApprovalsView.js";
import { TaskGraph } from "./TaskGraph.js";
import { WorkspaceLeasesPanel } from "./WorkspaceLeasesPanel.js";

type OrchestrationTab = "tasks" | "approvals" | "leases";

export function OrchestrationView({
  threads, tasks, taskMessages, taskMessageAcknowledgements, approvals, workspaceLeases,
  agents, nodes, runs, canMutate, apiFetch, onInspectRun
}: {
  threads: Thread[];
  tasks: Task[];
  taskMessages: TaskMessage[];
  taskMessageAcknowledgements: TaskMessageAcknowledgement[];
  approvals: ApprovalRequest[];
  workspaceLeases: WorkspaceLease[];
  agents: Agent[];
  nodes: ComputeNode[];
  runs: Run[];
  canMutate: boolean;
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onInspectRun: (runId: string) => void;
}) {
  const [tab, setTab] = useState<OrchestrationTab>("tasks");
  const threadsWithTasks = useMemo(() => threads.filter((thread) => tasks.some((task) => task.threadId === thread.id)), [threads, tasks]);
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const activeThreadId = selectedThreadId || threadsWithTasks[0]?.id || "";
  const pendingApprovalCount = approvals.filter((approval) => approval.status === "pending").length;

  return (
    <main className="utility-view orchestration-view">
      <header className="utility-header">
        <div><small>Task graph, approvals, and workspace leases</small><h1>Orchestration</h1></div>
      </header>
      <div className="orchestration-tabs" role="tablist" aria-label="Orchestration surfaces">
        <button role="tab" aria-selected={tab === "tasks"} onClick={() => setTab("tasks")}>Tasks</button>
        <button role="tab" aria-selected={tab === "approvals"} onClick={() => setTab("approvals")}>
          Approvals{pendingApprovalCount > 0 && <span className="tab-badge">{pendingApprovalCount}</span>}
        </button>
        <button role="tab" aria-selected={tab === "leases"} onClick={() => setTab("leases")}>Leases</button>
      </div>

      {tab === "tasks" && (
        threadsWithTasks.length === 0 ? (
          <div className="task-graph-empty"><FolderOpen size={22} /><strong>No orchestrated threads yet</strong><p>Task graphs appear here once an agent submits a batch of tasks to a thread.</p></div>
        ) : (
          <>
            <label className="thread-picker orchestration-thread-picker">Thread
              <select aria-label="Thread" value={activeThreadId} onChange={(event) => setSelectedThreadId(event.target.value)}>
                {threadsWithTasks.map((thread) => <option key={thread.id} value={thread.id}>{thread.title}</option>)}
              </select>
            </label>
            <TaskGraph
              tasks={tasks}
              threadId={activeThreadId}
              agents={agents}
              nodes={nodes}
              taskMessages={taskMessages}
              taskMessageAcknowledgements={taskMessageAcknowledgements}
              apiFetch={apiFetch}
              onInspectRun={onInspectRun}
            />
          </>
        )
      )}
      {tab === "approvals" && (
        <ApprovalsView approvals={approvals} agents={agents} nodes={nodes} runs={runs} tasks={tasks} canMutate={canMutate} apiFetch={apiFetch} />
      )}
      {tab === "leases" && <WorkspaceLeasesPanel leases={workspaceLeases} nodes={nodes} />}
    </main>
  );
}
