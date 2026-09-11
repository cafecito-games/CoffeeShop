export type HarnessId = "claude-cli" | "codex-cli" | "shell" | "ag-ui";
export type AgentState = "idle" | "thinking" | "working" | "waiting" | "blocked" | "done";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type NodeKind = "local" | "home-server" | "cloud";

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
  state: AgentState;
  currentAction: string;
  harnessId: HarnessId;
  model: string;
  computeNodeId: string;
  workspace: string;
  systemPrompt: string;
  unread: number;
  updatedAt: string;
}

export interface Run {
  id: string;
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
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
}

export interface TimelineEvent {
  id: string;
  type: "run" | "status" | "handoff" | "node" | "message";
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
  agentId: string;
  author: "you" | "agent" | "system";
  body: string;
  kind: "message" | "handoff" | "status";
  runId?: string;
  createdAt: string;
}

export interface Snapshot {
  agents: Agent[];
  nodes: ComputeNode[];
  runs: Run[];
  events: TimelineEvent[];
  messages: ChatMessage[];
  generatedAt: string;
}

export type HubToWorker =
  | { type: "dispatch"; run: Run; agent: Agent }
  | { type: "cancel"; runId: string }
  | { type: "ping" };

export type WorkerToHub =
  | { type: "register"; node: ComputeNode }
  | { type: "heartbeat"; nodeId: string; activeRuns: number; at: string }
  | { type: "run.started"; runId: string; at: string }
  | { type: "run.output"; runId: string; chunk: string; at: string }
  | { type: "run.completed"; runId: string; output: string; at: string }
  | { type: "run.failed"; runId: string; error: string; at: string };
