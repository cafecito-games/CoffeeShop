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
  /** Version-4 inventory: transports this harness can be driven through; absent means `native-cli` only. */
  transports?: HarnessTransport[];
  /** Version-4 inventory: capabilities negotiated with an explicitly installed ACP adapter. */
  acp?: AcpAgentCapabilities;
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
  /** Version-4: the task this run is an execution attempt for. */
  taskId?: string;
  /** Version-4: one-based attempt number within the owning task. */
  attempt?: number;
  /** Version-4: how Barista drives the harness; absent means `native-cli`. */
  transport?: HarnessTransport;
  sessionBindingId?: string;
  workspaceLeaseId?: string;
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
  tasks?: Task[];
  taskMessages?: TaskMessage[];
  taskMessageAcknowledgements?: TaskMessageAcknowledgement[];
  sessionBindings?: HarnessSessionBinding[];
  approvals?: ApprovalRequest[];
  workspaceLeases?: WorkspaceLease[];
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
  | { type: "dispatch"; run: Run; agent: Agent; execution?: DispatchExecution }
  | { type: "cancel"; runId: string }
  | { type: "hub.rpc.response"; requestId: string; runId: string; result?: unknown; error?: HubRpcError }
  | { type: "approval.decision"; decision: ApprovalDecision }
  | { type: "ping" };

export type ControlAgentToHub =
  | { type: "register"; protocolVersion?: ControlProtocolVersion; node: ComputeNode }
  | { type: "sync.complete"; nodeId: string; activeRunIds?: string[]; at: string }
  | { type: "heartbeat"; nodeId: string; activeRuns: number; at: string }
  | { type: "run.started"; runId: string; at: string }
  | { type: "run.output"; runId: string; chunk: string; at: string }
  | { type: "run.completed"; runId: string; output: string; at: string }
  | { type: "run.failed"; runId: string; error: string; at: string }
  | { type: "run.cancelled"; runId: string; at: string }
  | { type: "hub.rpc.request"; requestId: string; runId: string; operation: HubToolName; arguments: unknown; at: string }
  | { type: "harness.event"; event: HarnessEvent }
  | { type: "session.binding"; runId: string; binding: HarnessSessionBindingUpdate; at: string }
  | { type: "workspace.lease"; runId: string; lease: WorkspaceLeaseUpdate; at: string };

/** @deprecated Use HubToControlAgent. */
export type HubToWorker = HubToControlAgent;
/** @deprecated Use ControlAgentToHub. */
export type WorkerToHub = ControlAgentToHub;

/*
 * Control protocol versions.
 *
 * Each socket registers exactly one version. The hub accepts every listed version during rolling
 * upgrades, but a message may only be sent to a peer whose version supports the capability that
 * message requires. Unknown versions are rejected before any dispatch.
 */
export const controlProtocolVersions = ["1", "2", "3", "4"] as const;
export type ControlProtocolVersion = typeof controlProtocolVersions[number];
export const latestControlProtocolVersion: ControlProtocolVersion = "4";

export const controlProtocolCapabilities = ["replay-barrier", "hub-rpc", "orchestration"] as const;
export type ControlProtocolCapability = typeof controlProtocolCapabilities[number];

const capabilityIntroducedIn: Readonly<Record<ControlProtocolCapability, ControlProtocolVersion>> = {
  "replay-barrier": "2",
  "hub-rpc": "3",
  orchestration: "4"
};

const isOneOf = <T extends string>(values: readonly T[]) => (value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);

export const isControlProtocolVersion = isOneOf(controlProtocolVersions);

export const supportsControlCapability = (version: ControlProtocolVersion, capability: ControlProtocolCapability) =>
  isControlProtocolVersion(version)
  && Object.hasOwn(capabilityIntroducedIn, capability)
  && controlProtocolVersions.indexOf(version) >= controlProtocolVersions.indexOf(capabilityIntroducedIn[capability]);

/** The capability a hub→Barista message needs, or undefined when every version accepts it. */
export function requiredCapabilityForHubMessage(message: HubToControlAgent): ControlProtocolCapability | undefined {
  switch (message.type) {
    case "dispatch":
      return message.execution !== undefined || hasVersion4RunFields(message.run) ? "orchestration" : undefined;
    case "approval.decision":
      return "orchestration";
    case "hub.rpc.response":
      return "hub-rpc";
    case "cancel":
    case "ping":
      return undefined;
  }
}

/** The capability a Barista→hub message needs, or undefined when every version may send it. */
export function requiredCapabilityForControlAgentMessage(message: ControlAgentToHub): ControlProtocolCapability | undefined {
  switch (message.type) {
    case "sync.complete":
      return "replay-barrier";
    case "hub.rpc.request":
      return "hub-rpc";
    case "harness.event":
    case "session.binding":
    case "workspace.lease":
      return "orchestration";
    case "register":
    case "heartbeat":
    case "run.started":
    case "run.output":
    case "run.completed":
    case "run.failed":
    case "run.cancelled":
      return undefined;
  }
}

export const canSendToControlAgent = (message: HubToControlAgent, version: ControlProtocolVersion) => {
  const capability = requiredCapabilityForHubMessage(message);
  return capability === undefined || supportsControlCapability(version, capability);
};

export const canAcceptFromControlAgent = (message: ControlAgentToHub, version: ControlProtocolVersion) => {
  const capability = requiredCapabilityForControlAgentMessage(message);
  return capability === undefined || supportsControlCapability(version, capability);
};

const version4RunFields = ["taskId", "attempt", "transport", "sessionBindingId", "workspaceLeaseId"] as const;
const hasVersion4RunFields = (run: Run) => version4RunFields.some((field) => run[field] !== undefined);

/*
 * Harness transports.
 *
 * ACP is the local protocol between Barista and a harness adapter. These types describe what Coffee
 * Shop needs from a negotiated ACP session; ACP schema names are translated only inside Barista.
 */
export const harnessTransports = ["native-cli", "acp-v1"] as const;
export type HarnessTransport = typeof harnessTransports[number];
export const isHarnessTransport = isOneOf(harnessTransports);

export interface AcpAgentCapabilities {
  /** The ACP protocol version agreed during `initialize`. */
  protocolVersion: 1;
  loadSession: boolean;
  resumeSession: boolean;
  prompt: { image: boolean; audio: boolean; embeddedContext: boolean };
  mcp: { http: boolean; sse: boolean };
  adapterName?: string;
  adapterVersion?: string;
}

/*
 * Tasks.
 *
 * A task is a durable, schedulable unit in a thread-owned dependency graph. A run is one immutable
 * execution attempt of a task on a concrete agent, harness, node, and workspace. A task may own many
 * runs; a run belongs to at most one task. Task identity is generated by the hub.
 *
 * `pending` waits on dependencies, `ready` waits for placement, `assigned` has a persisted placement
 * and an attempt run, and `running` has a started attempt. An assigned or running task returns to
 * `ready` only when its attempt ended retryably (for example, lost compute) and a new attempt is
 * allowed. `blocked` records that a required dependency ended unsuccessfully.
 */
export const taskStatuses = ["pending", "ready", "assigned", "running", "completed", "failed", "cancelled", "blocked"] as const;
export type TaskStatus = typeof taskStatuses[number];
export const terminalTaskStatuses: readonly TaskStatus[] = ["completed", "failed", "cancelled", "blocked"];
export const isTaskStatus = isOneOf(taskStatuses);

const taskTransitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ["ready", "blocked", "cancelled"],
  ready: ["assigned", "cancelled"],
  assigned: ["running", "ready", "failed", "cancelled"],
  running: ["completed", "failed", "ready", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
  blocked: []
};

export const isTerminalTaskStatus = (status: TaskStatus) => terminalTaskStatuses.includes(status);
export const canTransitionTask = (from: TaskStatus, to: TaskStatus) => taskTransitions[from].includes(to);

/** `require-success` blocks the dependent unless the dependency completes; `allow-failure` only waits for it to settle. */
export const taskDependencyPolicies = ["require-success", "allow-failure"] as const;
export type TaskDependencyPolicy = typeof taskDependencyPolicies[number];
export const isTaskDependencyPolicy = isOneOf(taskDependencyPolicies);

export interface TaskDependency {
  taskId: string;
  policy: TaskDependencyPolicy;
}

/** How a dependency's current status affects its dependent. */
export type DependencyOutcome = "waiting" | "satisfied" | "blocking";

export function dependencyOutcome(policy: TaskDependencyPolicy, status: TaskStatus): DependencyOutcome {
  if (!isTerminalTaskStatus(status)) return "waiting";
  if (status === "completed" || policy === "allow-failure") return "satisfied";
  return "blocking";
}

/** Hard requirements must all match; `preferences` only rank nodes that already satisfy them. */
export interface ExecutionRequirements {
  skills?: string[];
  harnessIds?: HarnessId[];
  models?: string[];
  transports?: HarnessTransport[];
  operatingSystems?: string[];
  architectures?: string[];
  labels?: string[];
  minimumConcurrency?: number;
  minimumMemoryMegabytes?: number;
  projectProfileId?: string;
  workspace?: { repository?: string; path?: string; writable: boolean };
  preferences?: ExecutionPreferences;
}

export interface ExecutionPreferences {
  nodeIds?: string[];
  harnessIds?: HarnessId[];
  models?: string[];
  labels?: string[];
}

/** A separately authorized placement override; ordinary delegation is declarative. */
export interface PlacementOverride {
  agentId?: string;
  nodeId?: string;
  authorizedBy: "operator" | "policy";
}

export interface TaskAssignment {
  runId: string;
  agentId: string;
  nodeId: string;
  harnessId: HarnessId;
  transport: HarnessTransport;
  model: string;
  workspaceLeaseId?: string;
  assignedAt: string;
}

export const placementRequirementKinds = [
  "skill",
  "harness",
  "model",
  "transport",
  "operating-system",
  "architecture",
  "label",
  "concurrency",
  "memory",
  "project-profile",
  "workspace",
  "node-offline",
  "inventory-stale"
] as const;
export type PlacementRequirementKind = typeof placementRequirementKinds[number];

export interface UnsatisfiedRequirement {
  kind: PlacementRequirementKind;
  /** The requested value, rendered for operators. */
  requirement: string;
  /** Present when the explanation applies to one node rather than to every candidate. */
  nodeId?: string;
  detail: string;
}

export interface PlacementDiagnostic {
  evaluatedAt: string;
  eligibleNodeIds: string[];
  unsatisfied: UnsatisfiedRequirement[];
}

export interface Task {
  id: string;
  threadId: string;
  title: string;
  instructions: string;
  status: TaskStatus;
  requirements: ExecutionRequirements;
  dependencies: TaskDependency[];
  placementOverride?: PlacementOverride;
  /** The run that submitted this task; absent for operator-created tasks. */
  sourceRunId?: string;
  idempotencyKey: string;
  assignment?: TaskAssignment;
  placement?: PlacementDiagnostic;
  attemptRunIds: string[];
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

/*
 * Task mailboxes.
 *
 * Messages are immutable and ordered by `sequence` within the recipient's mailbox. Sender identity is
 * derived from the authenticated source run, never from message content. Acknowledgements are
 * separate records so the message itself never changes.
 */
export type TaskMessageParticipant =
  | { type: "task"; taskId: string }
  | { type: "orchestrator" }
  | { type: "operator" };

export const taskMessageKinds = ["question", "answer", "instruction", "progress", "result", "note"] as const;
export type TaskMessageKind = typeof taskMessageKinds[number];
export const isTaskMessageKind = isOneOf(taskMessageKinds);

export interface TaskMessage {
  id: string;
  threadId: string;
  sender: TaskMessageParticipant;
  recipient: TaskMessageParticipant;
  sequence: number;
  kind: TaskMessageKind;
  body: string;
  correlationId?: string;
  inReplyToMessageId?: string;
  artifactIds?: string[];
  sourceRunId?: string;
  idempotencyKey: string;
  createdAt: string;
}

export interface TaskMessageAcknowledgement {
  messageId: string;
  threadId: string;
  recipient: TaskMessageParticipant;
  runId: string;
  acknowledgedAt: string;
}

/** Opaque to models; only the hub interprets its contents. */
export type MailboxCursor = string;

/*
 * Harness session bindings associate an opaque provider session with the Coffee Shop agent, node,
 * harness, workspace, and thread it was created for. `replaced` records that a resume was
 * unsupported or stale and a new bounded-context session took over.
 */
export const sessionBindingStatuses = ["active", "idle", "closed", "replaced", "failed"] as const;
export type SessionBindingStatus = typeof sessionBindingStatuses[number];
export const terminalSessionBindingStatuses: readonly SessionBindingStatus[] = ["closed", "replaced", "failed"];
export const isSessionBindingStatus = isOneOf(sessionBindingStatuses);

const sessionBindingTransitions: Readonly<Record<SessionBindingStatus, readonly SessionBindingStatus[]>> = {
  active: ["idle", "closed", "replaced", "failed"],
  idle: ["active", "closed", "replaced", "failed"],
  closed: [],
  replaced: [],
  failed: []
};

export const isTerminalSessionBindingStatus = (status: SessionBindingStatus) => terminalSessionBindingStatuses.includes(status);
export const canTransitionSessionBinding = (from: SessionBindingStatus, to: SessionBindingStatus) => sessionBindingTransitions[from].includes(to);

export interface HarnessSessionBinding {
  id: string;
  threadId: string;
  agentId: string;
  nodeId: string;
  harnessId: HarnessId;
  transport: HarnessTransport;
  workspace: string;
  workspaceLeaseId?: string;
  /** Opaque provider session identity; never used as Coffee Shop identity. */
  providerSessionId: string;
  status: SessionBindingStatus;
  createdByRunId: string;
  lastRunId: string;
  replacedByBindingId?: string;
  createdAt: string;
  updatedAt: string;
}

/** What Barista reports about a session; the hub owns binding identity and lineage. */
export interface HarnessSessionBindingUpdate {
  bindingId?: string;
  providerSessionId: string;
  harnessId: HarnessId;
  transport: HarnessTransport;
  status: SessionBindingStatus;
}

/*
 * Normalized harness events.
 *
 * Coffee Shop owns this vocabulary; ACP and native CLI streams are translated into it by Barista.
 * `sequence` is scoped to the run. A provider event with no mapping becomes the bounded `unknown`
 * diagnostic, which never advances run or task state.
 */
export const harnessEventTypes = [
  "message.delta",
  "thought.delta",
  "plan.updated",
  "tool.call",
  "diff",
  "terminal.output",
  "usage",
  "permission.requested",
  "permission.resolved",
  "warning",
  "unknown"
] as const;
export type HarnessEventType = typeof harnessEventTypes[number];

export const planEntryStatuses = ["pending", "in-progress", "completed"] as const;
export type PlanEntryStatus = typeof planEntryStatuses[number];
export const planEntryPriorities = ["high", "medium", "low"] as const;
export type PlanEntryPriority = typeof planEntryPriorities[number];

export const toolCallStatuses = ["pending", "in-progress", "completed", "failed"] as const;
export type ToolCallStatus = typeof toolCallStatuses[number];
export const toolCallKinds = ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"] as const;
export type ToolCallKind = typeof toolCallKinds[number];

export const harnessEventLimits = {
  textBytes: 64 * 1024,
  diffBytes: 256 * 1024,
  planEntries: 200,
  approvalOptions: 8,
  diagnosticBytes: 2 * 1024,
  identifierBytes: 256
} as const;

interface HarnessEventBase {
  runId: string;
  sequence: number;
  at: string;
}

export interface PlanEntry {
  content: string;
  status: PlanEntryStatus;
  priority: PlanEntryPriority;
}

export type HarnessEvent =
  | HarnessEventBase & { type: "message.delta"; text: string }
  | HarnessEventBase & { type: "thought.delta"; text: string }
  | HarnessEventBase & { type: "plan.updated"; entries: PlanEntry[] }
  | HarnessEventBase & { type: "tool.call"; toolCallId: string; status: ToolCallStatus; kind: ToolCallKind; title: string; detail?: string }
  | HarnessEventBase & { type: "diff"; toolCallId?: string; path: string; oldText?: string; newText: string }
  | HarnessEventBase & { type: "terminal.output"; terminalId: string; stream: "stdout" | "stderr"; text: string }
  | HarnessEventBase & { type: "usage"; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; costUsd?: number }
  | HarnessEventBase & { type: "permission.requested"; approvalId: string; toolCallId?: string; title: string; detail?: string; options: ApprovalOption[] }
  | HarnessEventBase & { type: "permission.resolved"; approvalId: string; status: ApprovalStatus; selectedOptionId?: string }
  | HarnessEventBase & { type: "warning"; code: string; message: string }
  | HarnessEventBase & { type: "unknown"; sourceType: string; detail?: string };

/*
 * Approvals.
 *
 * A harness permission request becomes an approval owned by the hub. Only a pending approval can be
 * resolved, and a decision applies only to the run and session that raised it.
 */
export const approvalStatuses = ["pending", "approved", "rejected", "cancelled", "expired"] as const;
export type ApprovalStatus = typeof approvalStatuses[number];
export const terminalApprovalStatuses: readonly ApprovalStatus[] = ["approved", "rejected", "cancelled", "expired"];
export const isApprovalStatus = isOneOf(approvalStatuses);
export const isTerminalApprovalStatus = (status: ApprovalStatus) => terminalApprovalStatuses.includes(status);
export const canTransitionApproval = (from: ApprovalStatus, to: ApprovalStatus) => from === "pending" && to !== "pending";

export const approvalOptionKinds = ["allow-once", "allow-always", "reject-once", "reject-always"] as const;
export type ApprovalOptionKind = typeof approvalOptionKinds[number];

export interface ApprovalOption {
  id: string;
  label: string;
  kind: ApprovalOptionKind;
}

export interface ApprovalRequest {
  id: string;
  threadId: string;
  taskId?: string;
  runId: string;
  sessionBindingId?: string;
  toolCallId?: string;
  title: string;
  detail?: string;
  options: ApprovalOption[];
  status: ApprovalStatus;
  requestedAt: string;
  expiresAt?: string;
  resolvedAt?: string;
  resolvedBy?: "operator" | "policy";
  selectedOptionId?: string;
}

/** Sent to Barista; `approved` and `rejected` carry the selected option. */
export interface ApprovalDecision {
  approvalId: string;
  runId: string;
  status: Exclude<ApprovalStatus, "pending">;
  selectedOptionId?: string;
}

/*
 * Workspace leases grant one run exclusive use of an isolated worktree and branch. Barista enforces
 * containment; the hub records identity. `retained` keeps data for operator attention and is left
 * only through an explicit cleanup.
 */
export const workspaceLeaseStatuses = ["requested", "provisioning", "active", "released", "cleaning", "retained", "cleaned", "failed"] as const;
export type WorkspaceLeaseStatus = typeof workspaceLeaseStatuses[number];
export const terminalWorkspaceLeaseStatuses: readonly WorkspaceLeaseStatus[] = ["cleaned", "failed"];
export const isWorkspaceLeaseStatus = isOneOf(workspaceLeaseStatuses);

const workspaceLeaseTransitions: Readonly<Record<WorkspaceLeaseStatus, readonly WorkspaceLeaseStatus[]>> = {
  requested: ["provisioning", "failed"],
  provisioning: ["active", "retained", "failed"],
  active: ["released", "retained"],
  released: ["cleaning", "retained"],
  cleaning: ["cleaned", "retained", "failed"],
  retained: ["cleaning"],
  cleaned: [],
  failed: []
};

export const isTerminalWorkspaceLeaseStatus = (status: WorkspaceLeaseStatus) => terminalWorkspaceLeaseStatuses.includes(status);
export const canTransitionWorkspaceLease = (from: WorkspaceLeaseStatus, to: WorkspaceLeaseStatus) => workspaceLeaseTransitions[from].includes(to);

export const workspaceRetentionReasons = ["dirty", "identity-mismatch", "ambiguous", "operator-hold"] as const;
export type WorkspaceRetentionReason = typeof workspaceRetentionReasons[number];

export interface WorkspaceLease {
  id: string;
  threadId: string;
  taskId: string;
  runId: string;
  nodeId: string;
  repository: string;
  /** Canonical authorized workspace root containing the worktree. */
  root: string;
  baseRevision: string;
  branch: string;
  worktreePath: string;
  status: WorkspaceLeaseStatus;
  retentionReason?: WorkspaceRetentionReason;
  createdAt: string;
  updatedAt: string;
}

/** The lease identity the hub grants in a version-4 dispatch. */
export type WorkspaceLeaseGrant = Pick<WorkspaceLease, "id" | "repository" | "root" | "baseRevision" | "branch" | "worktreePath">;

/** What Barista reports while provisioning, releasing, or cleaning a lease. */
export interface WorkspaceLeaseUpdate {
  leaseId: string;
  status: WorkspaceLeaseStatus;
  retentionReason?: WorkspaceRetentionReason;
  detail?: string;
}

/** Version-4 dispatch fields; never sent to peers that registered an older version. */
export interface DispatchExecution {
  transport: HarnessTransport;
  taskId?: string;
  attempt?: number;
  /** Present when Barista should resume an existing provider session. */
  sessionBinding?: { id: string; providerSessionId: string };
  workspaceLease?: WorkspaceLeaseGrant;
}

export const orchestrationCollections = ["tasks", "taskMessages", "taskMessageAcknowledgements", "sessionBindings", "approvals", "workspaceLeases"] as const;
export type OrchestrationCollection = typeof orchestrationCollections[number];

/** Deterministic empty orchestration state for snapshots persisted before version 4. */
export function withOrchestrationDefaults<T extends Omit<Snapshot, "generatedAt">>(state: T): T & Required<Pick<Snapshot, OrchestrationCollection>> {
  const target = state as T & Required<Pick<Snapshot, OrchestrationCollection>>;
  for (const collection of orchestrationCollections) target[collection] ??= [];
  return target;
}

/*
 * Runtime validation of untrusted version-4 input. Validators never supply defaults for status or
 * discriminator fields: an unknown or missing value is rejected with a reason for diagnostics.
 */
export type Validation<T> = { ok: true; value: T } | { ok: false; reason: string };

const encoder = new TextEncoder();
const byteLength = (value: string) => encoder.encode(value).length;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));
const isBoundedString = (value: unknown, limit: number): value is string => typeof value === "string" && byteLength(value) <= limit;
const isIdentifier = (value: unknown): value is string => isBoundedString(value, harnessEventLimits.identifierBytes) && value.length > 0;
const isOptional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);
const isNonNegativeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isNonNegativeNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isTimestamp = (value: unknown): value is string => isIdentifier(value) && !Number.isNaN(Date.parse(value));
const isText = (value: unknown) => isBoundedString(value, harnessEventLimits.textBytes);
const isDiagnostic = (value: unknown) => isBoundedString(value, harnessEventLimits.diagnosticBytes);

const accept = <T>(value: T): Validation<T> => ({ ok: true, value });
const reject = <T>(reason: string): Validation<T> => ({ ok: false, reason });

const isHarnessEventType = isOneOf(harnessEventTypes);
const isPlanEntryStatus = isOneOf(planEntryStatuses);
const isPlanEntryPriority = isOneOf(planEntryPriorities);
const isToolCallStatus = isOneOf(toolCallStatuses);
const isToolCallKind = isOneOf(toolCallKinds);
const isApprovalOptionKind = isOneOf(approvalOptionKinds);
const isWorkspaceRetentionReason = isOneOf(workspaceRetentionReasons);
const isHarnessId = isOneOf(harnessIds);

const isApprovalOption = (value: unknown): value is ApprovalOption =>
  isRecord(value) && hasOnlyKeys(value, ["id", "label", "kind"]) && isIdentifier(value.id) && isDiagnostic(value.label) && isApprovalOptionKind(value.kind);

const isApprovalOptions = (value: unknown): value is ApprovalOption[] =>
  Array.isArray(value)
  && value.length > 0
  && value.length <= harnessEventLimits.approvalOptions
  && value.every(isApprovalOption)
  && new Set(value.map((option: ApprovalOption) => option.id)).size === value.length;

const isPlanEntry = (value: unknown): value is PlanEntry =>
  isRecord(value) && hasOnlyKeys(value, ["content", "status", "priority"]) && isText(value.content) && isPlanEntryStatus(value.status) && isPlanEntryPriority(value.priority);

const harnessEventBaseKeys = ["type", "runId", "sequence", "at"] as const;
const harnessEventPayloadKeys: Readonly<Record<HarnessEventType, readonly string[]>> = {
  "message.delta": ["text"],
  "thought.delta": ["text"],
  "plan.updated": ["entries"],
  "tool.call": ["toolCallId", "status", "kind", "title", "detail"],
  diff: ["toolCallId", "path", "oldText", "newText"],
  "terminal.output": ["terminalId", "stream", "text"],
  usage: ["inputTokens", "outputTokens", "cachedInputTokens", "costUsd"],
  "permission.requested": ["approvalId", "toolCallId", "title", "detail", "options"],
  "permission.resolved": ["approvalId", "status", "selectedOptionId"],
  warning: ["code", "message"],
  unknown: ["sourceType", "detail"]
};


const harnessEventPayloadValidators: Readonly<Record<HarnessEventType, (event: Record<string, unknown>) => boolean>> = {
  "message.delta": (event) => isText(event.text),
  "thought.delta": (event) => isText(event.text),
  "plan.updated": (event) => Array.isArray(event.entries) && event.entries.length <= harnessEventLimits.planEntries && event.entries.every(isPlanEntry),
  "tool.call": (event) => isIdentifier(event.toolCallId) && isToolCallStatus(event.status) && isToolCallKind(event.kind)
    && isDiagnostic(event.title) && isOptional(event.detail, isText),
  diff: (event) => isOptional(event.toolCallId, isIdentifier) && isText(event.path)
    && isOptional(event.oldText, (text) => isBoundedString(text, harnessEventLimits.diffBytes))
    && isBoundedString(event.newText, harnessEventLimits.diffBytes),
  "terminal.output": (event) => isIdentifier(event.terminalId) && (event.stream === "stdout" || event.stream === "stderr") && isText(event.text),
  usage: (event) => isOptional(event.inputTokens, isNonNegativeInteger) && isOptional(event.outputTokens, isNonNegativeInteger)
    && isOptional(event.cachedInputTokens, isNonNegativeInteger) && isOptional(event.costUsd, isNonNegativeNumber),
  "permission.requested": (event) => isIdentifier(event.approvalId) && isOptional(event.toolCallId, isIdentifier)
    && isDiagnostic(event.title) && isOptional(event.detail, isText) && isApprovalOptions(event.options),
  "permission.resolved": (event) => isIdentifier(event.approvalId) && isApprovalStatus(event.status) && event.status !== "pending"
    && isOptional(event.selectedOptionId, isIdentifier),
  warning: (event) => isIdentifier(event.code) && isDiagnostic(event.message),
  unknown: (event) => isIdentifier(event.sourceType) && isOptional(event.detail, isDiagnostic)
};

export function validateHarnessEvent(value: unknown): Validation<HarnessEvent> {
  if (!isRecord(value)) return reject("harness event must be an object");
  if (!isHarnessEventType(value.type)) return reject("harness event type is missing or unknown");
  if (!isIdentifier(value.runId) || !isNonNegativeInteger(value.sequence) || !isTimestamp(value.at)) return reject(`${value.type} is missing run identity, sequence, or timestamp`);
  if (!hasOnlyKeys(value, [...harnessEventBaseKeys, ...harnessEventPayloadKeys[value.type]])) return reject(`${value.type} contains undeclared fields`);
  if (!harnessEventPayloadValidators[value.type](value)) return reject(`${value.type} payload is malformed or exceeds its bounds`);
  return accept(value as unknown as HarnessEvent);
}

export function validateApprovalDecision(value: unknown): Validation<ApprovalDecision> {
  if (!isRecord(value) || !isIdentifier(value.approvalId) || !isIdentifier(value.runId)) return reject("approval decision is missing identity");
  if (!isApprovalStatus(value.status) || value.status === "pending") return reject("approval decision status must be terminal");
  const selects = value.status === "approved" || value.status === "rejected";
  if (selects ? !isIdentifier(value.selectedOptionId) : value.selectedOptionId !== undefined) return reject("approval decision option does not match its status");
  return accept(value as unknown as ApprovalDecision);
}

export function validateSessionBindingUpdate(value: unknown): Validation<HarnessSessionBindingUpdate> {
  if (!isRecord(value) || !hasOnlyKeys(value, ["bindingId", "providerSessionId", "harnessId", "transport", "status"])) return reject("session binding must contain only declared fields");
  if (!isOptional(value.bindingId, isIdentifier) || !isIdentifier(value.providerSessionId)) return reject("session binding is missing identity");
  if (!isHarnessId(value.harnessId) || !isHarnessTransport(value.transport) || !isSessionBindingStatus(value.status)) return reject("session binding has an unknown harness, transport, or status");
  return accept(value as unknown as HarnessSessionBindingUpdate);
}

export function validateWorkspaceLeaseUpdate(value: unknown): Validation<WorkspaceLeaseUpdate> {
  if (!isRecord(value) || !hasOnlyKeys(value, ["leaseId", "status", "retentionReason", "detail"])) return reject("workspace lease update must contain only declared fields");
  if (!isIdentifier(value.leaseId)) return reject("workspace lease update is missing identity");
  if (!isWorkspaceLeaseStatus(value.status)) return reject("workspace lease status is missing or unknown");
  if (value.status === "retained" ? !isWorkspaceRetentionReason(value.retentionReason) : value.retentionReason !== undefined) return reject("workspace lease retention reason does not match its status");
  if (!isOptional(value.detail, isDiagnostic)) return reject("workspace lease detail exceeds its bound");
  return accept(value as unknown as WorkspaceLeaseUpdate);
}

/**
 * Validates a version-4 Barista→hub message on a connection that registered `version`. Messages
 * that need a newer version than the connection negotiated are rejected, never reinterpreted.
 */
export function validateOrchestrationControlAgentMessage(value: unknown, version: ControlProtocolVersion): Validation<Extract<ControlAgentToHub, { type: "harness.event" | "session.binding" | "workspace.lease" }>> {
  if (!isRecord(value)) return reject("control message must be an object");
  if (value.type !== "harness.event" && value.type !== "session.binding" && value.type !== "workspace.lease") return reject("control message type is not an orchestration message");
  if (!supportsControlCapability(version, "orchestration")) return reject(`${value.type} requires control protocol version 4`);
  const envelopeKeys = value.type === "harness.event" ? ["type", "event"] : ["type", "runId", value.type === "session.binding" ? "binding" : "lease", "at"];
  if (!hasOnlyKeys(value, envelopeKeys)) return reject(`${value.type} envelope contains undeclared fields`);
  if (value.type === "harness.event") {
    const event = validateHarnessEvent(value.event);
    return event.ok ? accept({ type: value.type, event: event.value }) : reject(event.reason);
  }
  if (!isIdentifier(value.runId) || !isTimestamp(value.at)) return reject(`${value.type} is missing run identity or timestamp`);
  if (value.type === "session.binding") {
    const binding = validateSessionBindingUpdate(value.binding);
    return binding.ok ? accept({ type: value.type, runId: value.runId, binding: binding.value, at: value.at }) : reject(binding.reason);
  }
  const lease = validateWorkspaceLeaseUpdate(value.lease);
  return lease.ok ? accept({ type: value.type, runId: value.runId, lease: lease.value, at: value.at }) : reject(lease.reason);
}
