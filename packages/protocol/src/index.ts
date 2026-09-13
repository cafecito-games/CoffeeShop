export const harnessIds = ["claude-cli", "codex-cli", "shell", "ag-ui"] as const;
export type HarnessId = typeof harnessIds[number];
export type AgentState = "idle" | "thinking" | "working" | "waiting" | "blocked" | "done";
export const runStatuses = ["queued", "running", "completed", "failed", "cancelled"] as const;
export type RunStatus = typeof runStatuses[number];
export const activeRunStatuses: readonly RunStatus[] = ["queued", "running"];
export const terminalRunStatuses: readonly RunStatus[] = ["completed", "failed", "cancelled"];

const runTransitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["running", "failed", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: []
};

export const isActiveRunStatus = (status: RunStatus) => activeRunStatuses.includes(status);
export const isTerminalRunStatus = (status: RunStatus) => terminalRunStatuses.includes(status);
export const canTransitionRun = (from: RunStatus, to: RunStatus) => runTransitions[from].includes(to);
export const nodeKinds = ["local", "home-server", "cloud"] as const;
export type NodeKind = typeof nodeKinds[number];
export const agentAvatarShapes = ["cup", "bean", "moka", "kettle", "grinder", "pour-over"] as const;
export const agentAvatarColors = ["amber", "sage", "clay", "sky", "plum", "rose"] as const;
export type AgentAvatarShape = typeof agentAvatarShapes[number];
export type AgentAvatarColor = typeof agentAvatarColors[number];

export interface HarnessProfile {
  id: HarnessId;
  label: string;
  description: string;
  binary?: string;
  available: boolean;
  authMode: "local-subscription" | "local-account" | "api" | "none";
  models: string[];
}

export interface ComputeNode {
  id: string;
  name: string;
  kind: NodeKind;
  platform: string;
  status: "online" | "offline" | "busy";
  lastSeen: string;
  activeRuns: number;
  concurrency: number;
  workspaceRoots: string[];
  harnesses: HarnessProfile[];
  version: string;
}

export interface Agent {
  id: string;
  name: string;
  title: string;
  summary: string;
  glyph: string;
  avatarShape: AgentAvatarShape;
  avatarColor: AgentAvatarColor;
  state: AgentState;
  currentAction: string;
  harnessId: HarnessId;
  model: string;
  computeNodeId: string;
  workspace: string;
  systemPrompt: string;
  canDelegate?: boolean;
  unread: number;
  updatedAt: string;
}

export interface Delegation {
  id: string;
  threadId?: string;
  parentRunId: string;
  childRunId: string;
  fromAgentId: string;
  toAgentId: string;
  task: string;
  idempotencyKey: string;
  artifactIds?: string[];
  createdAt: string;
}

export const artifactKinds = ["patch", "report", "test-results", "log", "image", "other"] as const;
export type ArtifactKind = typeof artifactKinds[number];

export interface Artifact {
  id: string;
  threadId?: string;
  runId: string;
  agentId: string;
  relativePath: string;
  title: string;
  kind: ArtifactKind;
  mediaType: string;
  summary: string;
  size: number;
  sha256: string;
  downloadPath: string;
  uploaded: boolean;
  idempotencyKey: string;
  createdAt: string;
}

export interface Run {
  id: string;
  threadId?: string;
  agentId: string;
  nodeId: string;
  harnessId: HarnessId;
  model: string;
  workspace: string;
  prompt: string;
  status: RunStatus;
  output: string;
  error?: string;
  depth: number;
  parentRunId?: string;
  dispatchedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
}

export const timelineEventTypes = ["run", "status", "handoff", "node", "message"] as const;
export type TimelineEventType = typeof timelineEventTypes[number];

export interface TimelineEvent {
  id: string;
  threadId?: string;
  type: TimelineEventType;
  title: string;
  detail: string;
  agentId?: string;
  runId?: string;
  fromAgentId?: string;
  toAgentId?: string;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  threadId?: string;
  agentId: string;
  author: "you" | "agent" | "system";
  body: string;
  kind: "message" | "handoff" | "status";
  runId?: string;
  createdAt: string;
}

export const threadStatuses = ["active", "completed", "archived"] as const;
export type ThreadStatus = typeof threadStatuses[number];

export interface Thread {
  id: string;
  title: string;
  objective: string;
  summary: string;
  status: ThreadStatus;
  ownerAgentId: string;
  createdBy: "user" | "agent";
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  archivedAt?: string;
}

export interface Snapshot {
  agents: Agent[];
  nodes: ComputeNode[];
  runs: Run[];
  events: TimelineEvent[];
  messages: ChatMessage[];
  threads?: Thread[];
  delegations?: Delegation[];
  artifacts?: Artifact[];
  generatedAt: string;
}

export const hubToolNames = ["get_task_context", "delegate_task", "post_artifact", "update_thread"] as const;
export type HubToolName = typeof hubToolNames[number];

export interface HubRpcError {
  code: string;
  message: string;
  retryable: boolean;
}

export type HubToControlAgent =
  | { type: "dispatch"; run: Run; agent: Agent }
  | { type: "cancel"; runId: string }
  | { type: "hub.rpc.response"; requestId: string; runId: string; result?: unknown; error?: HubRpcError }
  | { type: "ping" };

export type ControlAgentToHub =
  | { type: "register"; protocolVersion?: "1" | "2" | "3"; node: ComputeNode }
  | { type: "sync.complete"; nodeId: string; activeRunIds?: string[]; at: string }
  | { type: "heartbeat"; nodeId: string; activeRuns: number; at: string }
  | { type: "run.started"; runId: string; at: string }
  | { type: "run.output"; runId: string; chunk: string; at: string }
  | { type: "run.completed"; runId: string; output: string; at: string }
  | { type: "run.failed"; runId: string; error: string; at: string }
  | { type: "run.cancelled"; runId: string; at: string }
  | { type: "hub.rpc.request"; requestId: string; runId: string; operation: HubToolName; arguments: unknown; at: string };

/** @deprecated Use HubToControlAgent. */
export type HubToWorker = HubToControlAgent;
/** @deprecated Use ControlAgentToHub. */
export type WorkerToHub = ControlAgentToHub;
