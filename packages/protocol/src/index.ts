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
  | { type: "workspace.lease"; runId: string; lease: WorkspaceLeaseUpdate; at: string }
  | { type: "capability.report"; report: NodeCapabilityReport };

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
    case "capability.report":
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

/*
 * Project execution profiles and node capability evidence.
 *
 * A project profile is a hub-authoritative, non-secret, versioned description of what a project
 * needs from a node. A node proves what it actually has via bounded capability evidence it reports
 * itself; readiness is decided by pure evaluation of a profile against that evidence. Everything in
 * this section is pure data and pure functions — no filesystem, process, or clock access — so it is
 * safe to bundle into both the hub and the web app.
 */
export const projectProfileSchemaVersion = 1;

export const versionComparators = ["=", ">=", ">", "<=", "<"] as const;
export type VersionComparator = typeof versionComparators[number];

export interface VersionConstraint {
  comparator: VersionComparator;
  version: string;
}

const normalizedVersionPattern = /^\d{1,4}(\.\d{1,4}){0,3}$/;
const versionComparatorPrefixes = [">=", "<=", ">", "<", "="] as const satisfies readonly VersionComparator[];

export function isNormalizedVersion(value: unknown): value is string {
  if (typeof value !== "string" || byteLength(value) > 32 || !normalizedVersionPattern.test(value)) return false;
  return value.split(".").every((segment) => segment === "0" || !segment.startsWith("0"));
}

// Rejection reasons here never interpolate `raw`: a version constraint is untrusted profile
// input, and its rejection reason can be surfaced in a startup error or log line, so a secret
// mistakenly placed in this field must never appear in that text.
export function parseVersionConstraint(raw: unknown): Validation<VersionConstraint> {
  if (!isBoundedString(raw, 40)) return reject("version constraint must be a bounded string");
  for (const comparator of versionComparatorPrefixes) {
    if (raw.startsWith(comparator)) {
      const version = raw.slice(comparator.length);
      if (!isNormalizedVersion(version)) return reject("version constraint has an invalid version");
      return accept({ comparator, version });
    }
  }
  if (!isNormalizedVersion(raw)) return reject("version constraint has an invalid version");
  return accept({ comparator: "=", version: raw });
}

const versionComparatorPredicates: Readonly<Record<VersionComparator, (compared: number) => boolean>> = {
  "=": (compared) => compared === 0,
  ">=": (compared) => compared >= 0,
  ">": (compared) => compared > 0,
  "<=": (compared) => compared <= 0,
  "<": (compared) => compared < 0
};

/**
 * Compares two dotted-integer versions. Both arguments must already satisfy `isNormalizedVersion`;
 * callers validate first because this function is also used on trusted internal data.
 */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((segment) => Number.parseInt(segment, 10));
  const right = b.split(".").map((segment) => Number.parseInt(segment, 10));
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const compared = (left[index] ?? 0) - (right[index] ?? 0);
    if (compared !== 0) return compared < 0 ? -1 : 1;
  }
  return 0;
}

export function satisfiesVersionConstraint(normalizedVersion: string, constraint: VersionConstraint): boolean {
  if (!isNormalizedVersion(normalizedVersion)) return false;
  return versionComparatorPredicates[constraint.comparator](compareVersions(normalizedVersion, constraint.version));
}

/*
 * Non-negative integer quantities (logical CPU count, configured memory in megabytes) are plain
 * counts, not dotted versions: `isNormalizedVersion`'s per-segment 4-digit bound rejects an
 * ordinary value like "16384" megabytes outright, so quantities use their own grammar and a
 * BigInt comparison that never loses precision for a large but plausible count.
 */
const nonNegativeIntegerQuantityPattern = /^\d{1,15}$/;

export function isNonNegativeIntegerQuantity(value: unknown): value is string {
  return typeof value === "string" && nonNegativeIntegerQuantityPattern.test(value) && (value === "0" || !value.startsWith("0"));
}

export function satisfiesMinimumQuantity(reportedValue: string, minimum: number): boolean {
  if (!isNonNegativeIntegerQuantity(reportedValue)) return false;
  return BigInt(reportedValue) >= BigInt(minimum);
}

const projectIdPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const capabilityIdPattern = /^[a-z0-9]+(-[a-z0-9]+)*(:[a-z0-9]+(-[a-z0-9]+)*)?$/;

/**
 * Grammar and byte bound shared by a node-admin configured label or accelerator value and its
 * embedding into a capability id (`label:<value>`/`accelerator:<value>`). This is the single
 * TypeScript-side definition: `capabilityEvidenceLimits.normalizedValueBytes` below mirrors this
 * exact bound (rather than choosing its own), Barista's Go config validation mirrors both this
 * pattern and this bound as `protocol.LabelOrAcceleratorPattern`/
 * `protocol.LabelOrAcceleratorMaximumBytes`, and `validateRequirementSet` reuses this pattern for
 * a profile's `labels`/`accelerators` requirements so a profile can never demand a value that
 * could never actually satisfy readiness once embedded in a capability id.
 */
export const labelOrAcceleratorPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const labelOrAcceleratorMaximumBytes = 64;

export interface ToolchainRequirement {
  capabilityId: string;
  label: string;
  versionConstraint?: string;
}

export interface WorkspacePolicy {
  requireWritable: boolean;
  allowedRepositories?: string[];
}

export interface RequirementSet {
  operatingSystems?: string[];
  architectures?: string[];
  minimumLogicalCpuCount?: number;
  minimumConfiguredMemoryMegabytes?: number;
  accelerators?: string[];
  labels?: string[];
  toolchains?: ToolchainRequirement[];
  harnessIds?: HarnessId[];
  transports?: HarnessTransport[];
}

export interface ProjectRequirements {
  hard: RequirementSet;
  preferred?: RequirementSet;
}

export interface ProjectRepositoryIdentity {
  url: string;
  defaultBranch: string;
}

export interface ProjectProfile {
  schemaVersion: number;
  id: string;
  name: string;
  repository?: ProjectRepositoryIdentity;
  workspacePolicy: WorkspacePolicy;
  requirements: ProjectRequirements;
}

const isBoundedNonEmptyString = (value: unknown, limit: number): value is string =>
  isBoundedString(value, limit) && value.length > 0;

const isUniqueBoundedStringArray = (value: unknown, limit: number): value is string[] =>
  Array.isArray(value)
  && value.length > 0
  && value.every((entry) => isBoundedNonEmptyString(entry, limit))
  && new Set(value as string[]).size === value.length;

/**
 * `labels`/`accelerators` requirements are matched by embedding each value into a capability id
 * (`label:<value>`/`accelerator:<value>`) and looking up evidence for it, so a requirement value
 * that does not satisfy `labelOrAcceleratorPattern` and `labelOrAcceleratorMaximumBytes` could
 * never be satisfied by any evidence Barista is able to report — such a profile is rejected here
 * rather than silently loaded as permanently unreadiable.
 */
const isUniqueLabelOrAcceleratorArray = (value: unknown): value is string[] =>
  Array.isArray(value)
  && value.length > 0
  && value.every((entry) => isBoundedNonEmptyString(entry, labelOrAcceleratorMaximumBytes) && labelOrAcceleratorPattern.test(entry as string))
  && new Set(value as string[]).size === value.length;

const requirementSetKeys = [
  "operatingSystems", "architectures", "minimumLogicalCpuCount", "minimumConfiguredMemoryMegabytes",
  "accelerators", "labels", "toolchains", "harnessIds", "transports"
] as const;

const requirementStringArrayFields = ["operatingSystems", "architectures"] as const;
const requirementLabelOrAcceleratorFields = ["accelerators", "labels"] as const;
const requirementPositiveIntegerFields = ["minimumLogicalCpuCount", "minimumConfiguredMemoryMegabytes"] as const;

function validateRequirementSet(value: unknown, path: string): Validation<RequirementSet> {
  if (!isRecord(value) || !hasOnlyKeys(value, requirementSetKeys)) {
    return reject(`${path} requirements must contain only declared fields`);
  }
  for (const field of requirementStringArrayFields) {
    if (value[field] !== undefined && !isUniqueBoundedStringArray(value[field], 128)) {
      return reject(`${path} ${field} must be a non-empty array of unique non-empty strings`);
    }
  }
  for (const field of requirementLabelOrAcceleratorFields) {
    if (value[field] !== undefined && !isUniqueLabelOrAcceleratorArray(value[field])) {
      return reject(`${path} ${field} must be a non-empty array of unique kebab-case values of at most ${labelOrAcceleratorMaximumBytes} bytes`);
    }
  }
  for (const field of requirementPositiveIntegerFields) {
    const entry = value[field];
    if (entry !== undefined && !(isNonNegativeInteger(entry) && entry > 0)) {
      return reject(`${path} ${field} must be a positive integer`);
    }
  }
  if (value.harnessIds !== undefined) {
    const harnessIdRequirements = value.harnessIds;
    if (!Array.isArray(harnessIdRequirements) || harnessIdRequirements.length === 0
      || !harnessIdRequirements.every((entry) => isHarnessId(entry))
      || new Set(harnessIdRequirements as string[]).size !== harnessIdRequirements.length) {
      return reject(`${path} harnessIds must be a non-empty array of known harness ids without duplicates`);
    }
  }
  if (value.transports !== undefined) {
    const transportRequirements = value.transports;
    if (!Array.isArray(transportRequirements) || transportRequirements.length === 0
      || !transportRequirements.every((entry) => isHarnessTransport(entry))
      || new Set(transportRequirements as string[]).size !== transportRequirements.length) {
      return reject(`${path} transports must be a non-empty array of known transports without duplicates`);
    }
  }
  if (value.toolchains !== undefined) {
    const toolchains = value.toolchains;
    if (!Array.isArray(toolchains) || toolchains.length === 0) {
      return reject(`${path} toolchains must be a non-empty array`);
    }
    const seenCapabilityIds = new Set<string>();
    for (const [index, toolchain] of toolchains.entries()) {
      if (!isRecord(toolchain) || !hasOnlyKeys(toolchain, ["capabilityId", "label", "versionConstraint"])) {
        return reject(`${path} toolchain at index ${index} must contain only declared fields`);
      }
      if (!isBoundedNonEmptyString(toolchain.capabilityId, 64) || !capabilityIdPattern.test(toolchain.capabilityId)) {
        return reject(`${path} toolchain at index ${index} has a malformed capabilityId`);
      }
      if (!isBoundedNonEmptyString(toolchain.label, 128)) {
        return reject(`${path} toolchain at index ${index} has a malformed label`);
      }
      if (toolchain.versionConstraint !== undefined) {
        const constraint = parseVersionConstraint(toolchain.versionConstraint);
        if (!constraint.ok) return reject(`${path} toolchain at index ${index} has an invalid versionConstraint`);
      }
      if (seenCapabilityIds.has(toolchain.capabilityId)) {
        return reject(`${path} toolchain at index ${index} has a capabilityId duplicated from an earlier entry`);
      }
      seenCapabilityIds.add(toolchain.capabilityId);
    }
  }
  return accept(value as unknown as RequirementSet);
}

/*
 * Secret-like value detection. This is intentionally a narrow denylist of well-known vendor token
 * shapes rather than a generic entropy heuristic: repository URLs, branch names, and revision
 * hashes routinely look high-entropy to heuristics, and a false positive would block a legitimate
 * profile outright.
 */
/*
 * Unanchored (with word boundaries) rather than a whole-string match: this same detection also
 * scans free-form evidence diagnostics and raw probe output, where a token can appear embedded in
 * a longer line rather than as the entire string.
 */
const secretLikeTokenPattern = /\b(sk|pk|ghp|gho|ghu|ghs|ghr|xox[abp]|AKIA|glpat)-?[A-Za-z0-9_-]{10,}\b/i;
const bearerHeaderPattern = /\bBearer\s+\S{10,}/i;

export function containsSecretLikeValue(value: unknown): boolean {
  if (typeof value === "string") {
    return secretLikeTokenPattern.test(value)
      || bearerHeaderPattern.test(value)
      || (value.includes("-----BEGIN") && value.includes("PRIVATE KEY"));
  }
  if (Array.isArray(value)) return value.some((entry) => containsSecretLikeValue(entry));
  if (isRecord(value)) return Object.values(value).some((entry) => containsSecretLikeValue(entry));
  return false;
}

export function validateProjectProfile(value: unknown): Validation<ProjectProfile> {
  // Scanned first, before any structural check: every other rejection reason below is a fixed,
  // field-name-only string (never interpolated input), but scanning first means a secret can
  // never leak through a structural-validation error even if a future edit reintroduces
  // interpolation by mistake. containsSecretLikeValue tolerates arbitrary, even malformed, input.
  if (containsSecretLikeValue(value)) {
    return reject("project profile contains a secret-like value");
  }
  if (!isRecord(value) || !hasOnlyKeys(value, ["schemaVersion", "id", "name", "repository", "workspacePolicy", "requirements"])) {
    return reject("project profile must contain only declared fields");
  }
  if (value.schemaVersion !== projectProfileSchemaVersion) {
    return reject("project profile schema version is missing or unknown");
  }
  if (!isBoundedNonEmptyString(value.id, 64) || !projectIdPattern.test(value.id)) {
    return reject("project profile id is malformed");
  }
  if (!isBoundedNonEmptyString(value.name, 128)) {
    return reject("project profile name is malformed");
  }
  if (value.repository !== undefined) {
    const repository = value.repository;
    if (!isRecord(repository) || !hasOnlyKeys(repository, ["url", "defaultBranch"])) {
      return reject("project profile repository must contain only declared fields");
    }
    if (!isBoundedNonEmptyString(repository.url, 512) || !isBoundedNonEmptyString(repository.defaultBranch, 256)) {
      return reject("project profile repository url or default branch is malformed");
    }
  }
  const workspacePolicy = value.workspacePolicy;
  if (!isRecord(workspacePolicy) || !hasOnlyKeys(workspacePolicy, ["requireWritable", "allowedRepositories"])) {
    return reject("project profile workspace policy must contain only declared fields");
  }
  if (typeof workspacePolicy.requireWritable !== "boolean") {
    return reject("project profile workspace policy requireWritable must be a boolean");
  }
  if (workspacePolicy.allowedRepositories !== undefined && !isUniqueBoundedStringArray(workspacePolicy.allowedRepositories, 512)) {
    return reject("project profile allowedRepositories must be a non-empty array of unique non-empty strings");
  }
  const requirements = value.requirements;
  if (!isRecord(requirements) || !hasOnlyKeys(requirements, ["hard", "preferred"])) {
    return reject("project profile requirements must contain only declared fields");
  }
  const hard = validateRequirementSet(requirements.hard, "hard");
  if (!hard.ok) return reject(hard.reason);
  if (requirements.preferred !== undefined) {
    const preferred = validateRequirementSet(requirements.preferred, "preferred");
    if (!preferred.ok) return reject(preferred.reason);
  }
  return accept(value as unknown as ProjectProfile);
}

/** Deterministic fingerprint input: object keys are sorted and array elements are order-insensitive. */
function canonicalizeForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) {
    const canonicalized = value.map((entry) => canonicalizeForFingerprint(entry));
    canonicalized.sort((left, right) => {
      const leftText = JSON.stringify(left);
      const rightText = JSON.stringify(right);
      return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
    });
    return canonicalized;
  }
  if (isRecord(value)) {
    const canonical: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      canonical[key] = canonicalizeForFingerprint(value[key]);
    }
    return canonical;
  }
  return value;
}

/** FNV-1a over the UTF-8 bytes: a change-detection fingerprint, not a cryptographic hash. */
function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of encoder.encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function computeProjectProfileFingerprint(
  profile: Pick<ProjectProfile, "id" | "repository" | "workspacePolicy" | "requirements">
): string {
  const canonical = canonicalizeForFingerprint({
    id: profile.id,
    repository: profile.repository ?? null,
    workspacePolicy: profile.workspacePolicy,
    requirements: profile.requirements
  });
  return fnv1aHex(JSON.stringify(canonical));
}

export const capabilityEvidenceSources = ["runtime", "configured", "probe"] as const;
export type CapabilityEvidenceSource = typeof capabilityEvidenceSources[number];
const isCapabilityEvidenceSource = isOneOf(capabilityEvidenceSources);

export const capabilityEvidenceLimits = {
  capabilityIdBytes: 128,
  rawValueBytes: 256,
  // Mirrors labelOrAcceleratorMaximumBytes exactly: a configured label/accelerator becomes a
  // NodeCapabilityEvidence.normalizedValue, so the two bounds must never drift apart.
  normalizedValueBytes: labelOrAcceleratorMaximumBytes,
  diagnosticBytes: 512,
  maxEvidenceEntries: 256
} as const;

export interface NodeCapabilityEvidence {
  capabilityId: string;
  source: CapabilityEvidenceSource;
  success: boolean;
  rawValue?: string;
  normalizedValue?: string;
  probeDefinitionVersion?: string;
  observedAt: string;
  diagnostic?: string;
}

export interface NodeCapabilityReport {
  nodeId: string;
  projectAllowlist?: string[];
  evidence: NodeCapabilityEvidence[];
  at: string;
}

export function validateNodeCapabilityEvidence(value: unknown): Validation<NodeCapabilityEvidence> {
  // Scanned first, before any structural check, for the same reason validateProjectProfile scans
  // first: no rejection reason below interpolates the field's content, but this removes the class
  // of leak entirely rather than relying on that staying true. isRecord guards the property
  // access so a non-object `value` (rejected generically just below) never throws here.
  if (isRecord(value) && containsSecretLikeValue({ rawValue: value.rawValue, normalizedValue: value.normalizedValue, diagnostic: value.diagnostic })) {
    return reject("node capability evidence contains a secret-like value");
  }
  if (!isRecord(value) || !hasOnlyKeys(value, ["capabilityId", "source", "success", "rawValue", "normalizedValue", "probeDefinitionVersion", "observedAt", "diagnostic"])) {
    return reject("node capability evidence must contain only declared fields");
  }
  if (!isBoundedNonEmptyString(value.capabilityId, capabilityEvidenceLimits.capabilityIdBytes) || !capabilityIdPattern.test(value.capabilityId)) {
    return reject("node capability evidence capabilityId is malformed");
  }
  if (!isCapabilityEvidenceSource(value.source)) {
    return reject("node capability evidence source is missing or unknown");
  }
  if (typeof value.success !== "boolean") {
    return reject("node capability evidence success must be a boolean");
  }
  if (!isOptional(value.rawValue, (entry) => isBoundedString(entry, capabilityEvidenceLimits.rawValueBytes))) {
    return reject("node capability evidence rawValue exceeds its bound");
  }
  if (!isOptional(value.normalizedValue, (entry) => isBoundedNonEmptyString(entry, capabilityEvidenceLimits.normalizedValueBytes))) {
    return reject("node capability evidence normalizedValue is malformed");
  }
  const isProbe = value.source === "probe";
  if (isProbe ? !isBoundedNonEmptyString(value.probeDefinitionVersion, 64) : value.probeDefinitionVersion !== undefined) {
    return reject("probe definition version does not match its source");
  }
  if (!isOptional(value.diagnostic, (entry) => isBoundedString(entry, capabilityEvidenceLimits.diagnosticBytes))) {
    return reject("node capability evidence diagnostic exceeds its bound");
  }
  if (!isTimestamp(value.observedAt)) {
    return reject("node capability evidence observedAt is malformed");
  }
  return accept(value as unknown as NodeCapabilityEvidence);
}

export function validateNodeCapabilityReport(value: unknown): Validation<NodeCapabilityReport> {
  if (!isRecord(value) || !hasOnlyKeys(value, ["nodeId", "projectAllowlist", "evidence", "at"])) {
    return reject("node capability report must contain only declared fields");
  }
  if (!isIdentifier(value.nodeId)) {
    return reject("node capability report is missing node identity");
  }
  if (value.projectAllowlist !== undefined) {
    const projectAllowlist = value.projectAllowlist;
    if (!Array.isArray(projectAllowlist) || projectAllowlist.length === 0
      || !projectAllowlist.every((entry) => typeof entry === "string" && projectIdPattern.test(entry))
      || new Set(projectAllowlist as string[]).size !== projectAllowlist.length) {
      return reject("node capability report projectAllowlist is malformed");
    }
  }
  const evidence = value.evidence;
  if (!Array.isArray(evidence) || evidence.length > capabilityEvidenceLimits.maxEvidenceEntries) {
    return reject("node capability report evidence is missing or exceeds its bound");
  }
  const seenEvidence = new Set<string>();
  for (const [index, entry] of evidence.entries()) {
    const validated = validateNodeCapabilityEvidence(entry);
    if (!validated.ok) return reject(`node capability report evidence at index ${index} is invalid`);
    const pair = `${validated.value.capabilityId}\u0000${validated.value.source}`;
    if (seenEvidence.has(pair)) {
      return reject(`node capability report evidence at index ${index} duplicates an earlier capabilityId/source pair`);
    }
    seenEvidence.add(pair);
  }
  if (!isTimestamp(value.at)) {
    return reject("node capability report timestamp is malformed");
  }
  return accept(value as unknown as NodeCapabilityReport);
}

export const readinessRequirementKinds = [
  "operating-system", "architecture", "cpu", "memory", "accelerator", "label",
  "toolchain", "harness", "transport", "harness-transport", "workspace", "project-allowlist"
] as const;
export type ReadinessRequirementKind = typeof readinessRequirementKinds[number];

export interface UnmetReadinessRequirement {
  kind: ReadinessRequirementKind;
  requirement: string;
  detail: string;
}

export interface ProjectReadiness {
  nodeId: string;
  projectId: string;
  profileFingerprint: string;
  evidenceFingerprint: string;
  ready: boolean;
  unmetHardRequirements: UnmetReadinessRequirement[];
  unmetPreferences: UnmetReadinessRequirement[];
  evaluatedAt: string;
}

export interface ProjectReadinessNodeContext {
  nodeId: string;
  harnesses: HarnessProfile[];
  projectAllowlist?: string[];
  evidence: NodeCapabilityEvidence[];
  workspaceAuthorized: boolean;
}

export function computeEvidenceFingerprint(evidence: readonly NodeCapabilityEvidence[]): string {
  const tuples = evidence.map((entry) => ({
    capabilityId: entry.capabilityId,
    source: entry.source,
    normalizedValue: entry.normalizedValue ?? null,
    success: entry.success,
    probeDefinitionVersion: entry.probeDefinitionVersion ?? null
  }));
  return fnv1aHex(JSON.stringify(canonicalizeForFingerprint(tuples)));
}

export type ResolvedNodeCapabilityState = "ok" | "missing" | "ambiguous" | "stale" | "failed";

export interface ResolvedNodeCapability {
  state: ResolvedNodeCapabilityState;
  value?: string;
}

const resolveStateDetails: Readonly<Record<Exclude<ResolvedNodeCapabilityState, "ok">, string>> = {
  missing: "missing evidence",
  failed: "evidence failed",
  stale: "evidence is stale",
  ambiguous: "ambiguous evidence"
};

const effectiveEvidenceValue = (entry: NodeCapabilityEvidence) => entry.normalizedValue ?? entry.rawValue ?? "";

/**
 * Evidence timestamped further in the future than this allowance relative to evaluation time is
 * never trusted as fresh: without this bound a future-dated `observedAt` would produce a negative
 * age and be accepted regardless of how implausible the timestamp is.
 */
export const evidenceClockSkewAllowanceMilliseconds = 60_000;

/**
 * Resolves the freshest, mutually agreeing evidence for one capability id: `missing` when no
 * entry exists, `ambiguous` when entries disagree on success or effective value, `stale` when the
 * freshest entry is older than `evidenceTTLMilliseconds` or timestamped further in the future than
 * `evidenceClockSkewAllowanceMilliseconds`, `failed` when it is fresh but unsuccessful, and `ok`
 * otherwise. This is the single evidence-resolution path every hard/preferred requirement check in
 * `evaluateProjectReadiness` uses, and any other caller that needs to gate on one capability (for
 * example, the hub's workspace-writable check) must use this instead of hand-rolling its own scan,
 * so freshness, clock-skew, and ambiguity handling can never be bypassed or reimplemented. Pure:
 * every timestamp comparison uses `nowIso`, never the system clock. Resolution is order-insensitive
 * — every entry is compared for agreement and freshness regardless of array order.
 */
export function resolveNodeCapability(
  evidence: readonly NodeCapabilityEvidence[],
  capabilityId: string,
  nowIso: string,
  evidenceTTLMilliseconds: number
): ResolvedNodeCapability {
  const entries = evidence.filter((entry) => entry.capabilityId === capabilityId);
  if (entries.length === 0) return { state: "missing" };
  const nowMilliseconds = Date.parse(nowIso);
  const [first, ...rest] = entries;
  let freshest = first;
  for (const entry of rest) {
    const disagrees = entry.success !== first.success
      || (entry.success && first.success && effectiveEvidenceValue(entry) !== effectiveEvidenceValue(first));
    if (disagrees) return { state: "ambiguous" };
    if (Date.parse(entry.observedAt) > Date.parse(freshest.observedAt)) freshest = entry;
  }
  const ageMilliseconds = nowMilliseconds - Date.parse(freshest.observedAt);
  if (ageMilliseconds > evidenceTTLMilliseconds || ageMilliseconds < -evidenceClockSkewAllowanceMilliseconds) {
    return { state: "stale", value: effectiveEvidenceValue(freshest) };
  }
  if (!freshest.success) return { state: "failed" };
  return { state: "ok", value: effectiveEvidenceValue(freshest) };
}

/**
 * Decides whether a node is ready for a project. Pure: every timestamp comparison uses `nowIso`,
 * never the system clock, and neither `profile` nor `context` is mutated.
 */
export function evaluateProjectReadiness(
  profile: ProjectProfile,
  context: ProjectReadinessNodeContext,
  evidenceTTLMilliseconds: number,
  nowIso: string
): ProjectReadiness {
  const unmetHardRequirements: UnmetReadinessRequirement[] = [];
  const unmetPreferences: UnmetReadinessRequirement[] = [];

  const resolveCapability = (capabilityId: string): ResolvedNodeCapability =>
    resolveNodeCapability(context.evidence, capabilityId, nowIso, evidenceTTLMilliseconds);

  const detailFor = (resolved: ResolvedNodeCapability) =>
    resolved.state === "ok" ? "reported value does not match" : resolveStateDetails[resolved.state];

  const evaluateRequirementSet = (requirementSet: RequirementSet, unmet: UnmetReadinessRequirement[]) => {
    if (requirementSet.operatingSystems !== undefined) {
      const resolved = resolveCapability("os");
      const matched = resolved.state === "ok"
        && requirementSet.operatingSystems.some((operatingSystem) => (resolved.value ?? "").toLowerCase() === operatingSystem.toLowerCase());
      if (!matched) {
        unmet.push({ kind: "operating-system", requirement: requirementSet.operatingSystems.join(", "), detail: detailFor(resolved) });
      }
    }
    if (requirementSet.architectures !== undefined) {
      const resolved = resolveCapability("architecture");
      const matched = resolved.state === "ok"
        && requirementSet.architectures.some((architecture) => (resolved.value ?? "").toLowerCase() === architecture.toLowerCase());
      if (!matched) {
        unmet.push({ kind: "architecture", requirement: requirementSet.architectures.join(", "), detail: detailFor(resolved) });
      }
    }
    for (const [field, capabilityId, kind] of [
      ["minimumLogicalCpuCount", "logical-cpu-count", "cpu"],
      ["minimumConfiguredMemoryMegabytes", "configured-memory-megabytes", "memory"]
    ] as const) {
      const requiredCount = requirementSet[field];
      if (requiredCount === undefined) continue;
      const resolved = resolveCapability(capabilityId);
      const matched = resolved.state === "ok"
        && isNonNegativeIntegerQuantity(resolved.value)
        && satisfiesMinimumQuantity(resolved.value as string, requiredCount);
      if (!matched) {
        unmet.push({ kind, requirement: String(requiredCount), detail: detailFor(resolved) });
      }
    }
    for (const name of requirementSet.accelerators ?? []) {
      const resolved = resolveCapability(`accelerator:${name}`);
      if (resolved.state !== "ok") {
        unmet.push({ kind: "accelerator", requirement: name, detail: resolveStateDetails[resolved.state] });
      }
    }
    for (const name of requirementSet.labels ?? []) {
      const resolved = resolveCapability(`label:${name}`);
      if (resolved.state !== "ok") {
        unmet.push({ kind: "label", requirement: name, detail: resolveStateDetails[resolved.state] });
      }
    }
    for (const toolchain of requirementSet.toolchains ?? []) {
      const resolved = resolveCapability(toolchain.capabilityId);
      const requirement = `${toolchain.label} ${toolchain.versionConstraint ?? ""}`.trim();
      if (resolved.state !== "ok") {
        unmet.push({ kind: "toolchain", requirement, detail: resolveStateDetails[resolved.state] });
        continue;
      }
      if (toolchain.versionConstraint === undefined) continue;
      const constraint = parseVersionConstraint(toolchain.versionConstraint);
      if (!constraint.ok) {
        unmet.push({ kind: "toolchain", requirement, detail: "version constraint is invalid" });
        continue;
      }
      const value = resolved.value ?? "";
      if (!isNormalizedVersion(value) || !satisfiesVersionConstraint(value, constraint.value)) {
        unmet.push({ kind: "toolchain", requirement, detail: "version is unparseable or unreported" });
      }
    }
    const harnessMatches = (harness: HarnessProfile, harnessIds: HarnessId[]) => harnessIds.includes(harness.id);
    const transportMatches = (harness: HarnessProfile, transports: HarnessTransport[]) =>
      (harness.transports ?? ["native-cli"]).some((transport) => transports.includes(transport));

    if (requirementSet.harnessIds !== undefined && requirementSet.transports !== undefined) {
      // harnessIds and transports must be evaluated together, per harness, rather than as two
      // independent existence checks: independent checks can each be satisfied by a *different*
      // harness (one that matches the id but not the transport, and another that matches the
      // transport but not the id), reporting the node ready when no single available harness
      // actually offers the required id-and-transport combination.
      const requiredHarnessIds = requirementSet.harnessIds;
      const requiredTransports = requirementSet.transports;
      const matched = context.harnesses.some((harness) =>
        harness.available && harnessMatches(harness, requiredHarnessIds) && transportMatches(harness, requiredTransports));
      if (!matched) {
        unmet.push({
          kind: "harness-transport",
          requirement: `harness in [${requiredHarnessIds.join(", ")}] with transport in [${requiredTransports.join(", ")}]`,
          detail: "no single available harness satisfies both the harness and transport requirement together"
        });
      }
    } else {
      if (requirementSet.harnessIds !== undefined) {
        const requiredHarnessIds = requirementSet.harnessIds;
        const matched = context.harnesses.some((harness) => harness.available && harnessMatches(harness, requiredHarnessIds));
        if (!matched) {
          unmet.push({ kind: "harness", requirement: requiredHarnessIds.join(", "), detail: "no available harness matches" });
        }
      }
      if (requirementSet.transports !== undefined) {
        const requiredTransports = requirementSet.transports;
        const matched = context.harnesses.some((harness) => harness.available && transportMatches(harness, requiredTransports));
        if (!matched) {
          unmet.push({ kind: "transport", requirement: requiredTransports.join(", "), detail: "no available harness supports a matching transport" });
        }
      }
    }
  };

  evaluateRequirementSet(profile.requirements.hard, unmetHardRequirements);
  if (profile.requirements.preferred !== undefined) {
    evaluateRequirementSet(profile.requirements.preferred, unmetPreferences);
  }

  if (context.projectAllowlist !== undefined && context.projectAllowlist.length > 0 && !context.projectAllowlist.includes(profile.id)) {
    unmetHardRequirements.push({
      kind: "project-allowlist",
      requirement: profile.id,
      detail: "node does not authorize this project"
    });
  }
  if (!context.workspaceAuthorized) {
    unmetHardRequirements.push({
      kind: "workspace",
      requirement: profile.workspacePolicy.requireWritable ? "writable workspace root" : "workspace root",
      detail: "no authorized workspace root supports this project's workspace policy"
    });
  }

  return {
    nodeId: context.nodeId,
    projectId: profile.id,
    profileFingerprint: computeProjectProfileFingerprint(profile),
    evidenceFingerprint: computeEvidenceFingerprint(context.evidence),
    ready: unmetHardRequirements.length === 0,
    unmetHardRequirements,
    unmetPreferences,
    evaluatedAt: nowIso
  };
}
