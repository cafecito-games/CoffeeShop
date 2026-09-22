import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { FolderOpen } from "@phosphor-icons/react";
import type {
  Agent, ApprovalRequest, ComputeNode, OrchestratorClient, Run, Task, TaskMessage, TaskMessageAcknowledgement,
  Thread, WorkspaceLease
} from "@coffee-shop/protocol";
import { ApprovalsView } from "./ApprovalsView.js";
import { TaskGraph } from "./TaskGraph.js";
import { WorkspaceLeasesPanel } from "./WorkspaceLeasesPanel.js";

type OrchestrationTab = "tasks" | "approvals" | "leases";

const orchestrationTabs: readonly { key: OrchestrationTab; label: string }[] = [
  { key: "tasks", label: "Tasks" },
  { key: "approvals", label: "Approvals" },
  { key: "leases", label: "Leases" }
];

export function OrchestrationView({
  threads, tasks, taskMessages, taskMessageAcknowledgements, approvals, workspaceLeases,
  agents, nodes, runs, orchestratorClients, canMutate, apiFetch, onInspectRun
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
  orchestratorClients: OrchestratorClient[];
  canMutate: boolean;
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onInspectRun: (runId: string) => void;
}) {
  const [tab, setTab] = useState<OrchestrationTab>("tasks");
  const threadsWithTasks = useMemo(() => threads.filter((thread) => tasks.some((task) => task.threadId === thread.id)), [threads, tasks]);
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const activeThreadId = selectedThreadId || threadsWithTasks[0]?.id || "";
  const pendingApprovalCount = approvals.filter((approval) => approval.status === "pending").length;
  const tabRefs = useRef<Partial<Record<OrchestrationTab, HTMLButtonElement>>>({});

  function activateTab(key: OrchestrationTab) {
    setTab(key);
    tabRefs.current[key]?.focus();
  }

  // WAI-ARIA tabs pattern (automatic activation): Left/Right move and select among tabs, Home/End
  // jump to the first/last tab, and only the active tab is in the page's tab order.
  function onTabsKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = orchestrationTabs.findIndex((item) => item.key === tab);
    if (event.key === "ArrowRight") { event.preventDefault(); activateTab(orchestrationTabs[(index + 1) % orchestrationTabs.length].key); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); activateTab(orchestrationTabs[(index - 1 + orchestrationTabs.length) % orchestrationTabs.length].key); }
    else if (event.key === "Home") { event.preventDefault(); activateTab(orchestrationTabs[0].key); }
    else if (event.key === "End") { event.preventDefault(); activateTab(orchestrationTabs[orchestrationTabs.length - 1].key); }
  }

  return (
    <main className="utility-view orchestration-view">
      <header className="utility-header">
        <div><small>Task graph, approvals, and workspace leases</small><h1>Orchestration</h1></div>
      </header>
      <div className="orchestration-tabs" role="tablist" aria-label="Orchestration surfaces" onKeyDown={onTabsKeyDown}>
        {orchestrationTabs.map(({ key, label }) => (
          <button
            key={key}
            ref={(element) => { if (element) tabRefs.current[key] = element; }}
            id={`orchestration-tab-${key}`}
            role="tab"
            aria-selected={tab === key}
            aria-controls={`orchestration-panel-${key}`}
            tabIndex={tab === key ? 0 : -1}
            onClick={() => setTab(key)}
          >
            {label}{key === "approvals" && pendingApprovalCount > 0 && <span className="tab-badge">{pendingApprovalCount}</span>}
          </button>
        ))}
      </div>

      <div id={`orchestration-panel-${tab}`} role="tabpanel" aria-labelledby={`orchestration-tab-${tab}`} tabIndex={0}>
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
          <ApprovalsView approvals={approvals} agents={agents} nodes={nodes} runs={runs} tasks={tasks} orchestratorClients={orchestratorClients} canMutate={canMutate} apiFetch={apiFetch} />
        )}
        {tab === "leases" && <WorkspaceLeasesPanel leases={workspaceLeases} nodes={nodes} />}
      </div>
    </main>
  );
}
