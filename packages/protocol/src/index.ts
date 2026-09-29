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
  /** The node administrator's approval policy for this harness; absent means `manual`. Read-only to the hub. */
  approvalPolicy?: ApprovalPolicy;
  /**
   * Set by the hub, never by Barista, when the reported approval policy is one this hub does not
   * recognize; the harness may be running with relaxed approvals and must not be shown as `manual`.
   */
  approvalPolicyUnrecognized?: boolean;
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
  /** Version-5 resident capacity, independent of active-run concurrency; absent means incapable. */
  instanceCapacity?: number;
  /** Absent is unknown, whereas zero is explicit resident evidence. */
  activeInstances?: number;
  workspaceRoots: string[];
  harnesses: HarnessProfile[];
  version: string;
}

export const componentKinds = ["harness", "acp-adapter", "capability-pack"] as const;
export type ComponentKind = typeof componentKinds[number];
export const componentProvenances = ["managed", "external", "none", "rejected"] as const;
export type ComponentProvenance = typeof componentProvenances[number];
export const componentReadinesses = ["ready", "inactive", "unavailable", "rejected", "unhealthy", "not-applicable"] as const;
export type ComponentReadiness = typeof componentReadinesses[number];
export const componentDiagnosticCodes = [
  "activation-rejected", "not-activated", "active-unverified", "harness-unavailable",
  "auth-unavailable", "auth-unhealthy", "platform-unsupported", "update-available", "rollback-available"
] as const;
export type ComponentDiagnosticCode = typeof componentDiagnosticCodes[number];
export const componentInventoryLimits = {
  components: 64,
  installedVersions: 32,
  diagnosticCodes: 16,
  identifierBytes: 128,
  versionBytes: 32
} as const;

/** Bounded, path-free facts reported by one Barista for one manifest component identity. */
export interface ComponentInventoryEntry {
  kind: ComponentKind;
  id: string;
  harnessId?: string;
  declaredVersion: string;
  installedVersions: string[];
  activeVersion?: string;
  rollbackVersion?: string;
  provenance: ComponentProvenance;
  readiness: ComponentReadiness;
  updateVersion?: string;
  rollbackAvailable: boolean;
  diagnosticCodes: ComponentDiagnosticCode[];
}

/** A complete inventory snapshot for one registered Barista, never scheduler authority. */
export interface ComponentInventoryReport {
  nodeId: string;
  observedAt: string;
  components: ComponentInventoryEntry[];
}

export const capabilityPackReadinessStatuses = ["available", "unavailable"] as const;
export type CapabilityPackReadinessStatus = typeof capabilityPackReadinessStatuses[number];
export const capabilityPackReadinessReasonCodes = ["not-selected", "activation-rejected", "active-unverified", "no-supported-surface"] as const;
export type CapabilityPackReadinessReasonCode = typeof capabilityPackReadinessReasonCodes[number];
export const capabilityPackReadinessLimits = { skills: 64, surfaces: 16 } as const;
export interface CapabilityPackIdentity { id: string; version: string; skills: string[] }
export interface CapabilityPackSurface { harnessId: HarnessId; transport: HarnessTransport }
export interface CapabilityPackReadinessReport {
  nodeId: string;
  observedAt: string;
  status: CapabilityPackReadinessStatus;
  pack?: CapabilityPackIdentity;
  surfaces: CapabilityPackSurface[];
  reasonCode?: CapabilityPackReadinessReasonCode;
}
export interface ExpectedCapabilityPack { id: string; version: string; requiredSkills: string[] }
export interface EffectiveCapabilityPack { id: string; version: string; skills: string[] }

/** Compatibility-only persisted agent. New reusable defaults use AgentTemplate. */
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
  /** Normalized descriptive compatibility metadata; never runtime capability-pack evidence. */
  skills?: string[];
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

export const previewBundleArtifactKind = "preview-bundle" as const;
export const previewBundleMediaType = "application/vnd.coffee-shop.preview-bundle+tar+gzip" as const;
export const previewBundleAllowedEntryTypes = ["regular-file", "directory"] as const;

/**
 * The language-neutral v1 bundle contract. The checked-in JSON fixture is generated byte-for-byte
 * from this object so Barista can consume the same limits without maintaining a second policy.
 */
export const previewBundleContract = {
  schemaVersion: 1,
  artifactKind: previewBundleArtifactKind,
  mediaType: previewBundleMediaType,
  allowedEntryTypes: previewBundleAllowedEntryTypes,
  maximumCompressedBytes: 10 * 1024 * 1024,
  maximumExpandedBytes: 100 * 1024 * 1024,
  maximumRegularFiles: 2_000,
  maximumFileBytes: 10 * 1024 * 1024,
  maximumPathBytes: 1_024,
  maximumExpansionRatio: 20,
  minimumTtlSeconds: 5 * 60,
  defaultTtlSeconds: 24 * 60 * 60,
  maximumLifetimeSeconds: 7 * 24 * 60 * 60
} as const;

export const previewBundleLimits = {
  maximumCompressedBytes: previewBundleContract.maximumCompressedBytes,
  maximumExpandedBytes: previewBundleContract.maximumExpandedBytes,
  maximumRegularFiles: previewBundleContract.maximumRegularFiles,
  maximumFileBytes: previewBundleContract.maximumFileBytes,
  maximumPathBytes: previewBundleContract.maximumPathBytes,
  maximumExpansionRatio: previewBundleContract.maximumExpansionRatio
} as const;

export const artifactPreviewTtlPolicy = {
  minimumSeconds: previewBundleContract.minimumTtlSeconds,
  defaultSeconds: previewBundleContract.defaultTtlSeconds,
  maximumLifetimeSeconds: previewBundleContract.maximumLifetimeSeconds
} as const;

export const artifactPreviewStatuses = ["upload-pending", "processing", "ready", "failed", "expired"] as const;
export type ArtifactPreviewStatus = typeof artifactPreviewStatuses[number];
export const artifactPreviewFailureCodes = [
  "upload-failed",
  "bundle-invalid",
  "path-invalid",
  "entrypoint-invalid",
  "limit-exceeded",
  "storage-conflict",
  "processing-cancelled",
  "processing-failed"
] as const;
export type ArtifactPreviewFailureCode = typeof artifactPreviewFailureCodes[number];
export const artifactPreviewAccessStates = ["eligible", "unavailable"] as const;
export type ArtifactPreviewAccessState = typeof artifactPreviewAccessStates[number];

export const artifactPreviewTransitions: Readonly<Record<ArtifactPreviewStatus, readonly ArtifactPreviewStatus[]>> = {
  "upload-pending": ["processing", "failed", "expired"],
  processing: ["ready", "failed", "expired"],
  ready: ["expired"],
  failed: ["processing", "expired"],
  expired: []
};

export const isArtifactPreviewStatus = (value: unknown): value is ArtifactPreviewStatus =>
  typeof value === "string" && (artifactPreviewStatuses as readonly string[]).includes(value);
export const isArtifactPreviewFailureCode = (value: unknown): value is ArtifactPreviewFailureCode =>
  typeof value === "string" && (artifactPreviewFailureCodes as readonly string[]).includes(value);
export const canTransitionArtifactPreview = (from: unknown, to: unknown) =>
  isArtifactPreviewStatus(from) && isArtifactPreviewStatus(to) && artifactPreviewTransitions[from].includes(to);

export const ordinaryArtifactKinds = ["patch", "report", "test-results", "log", "image", "other"] as const;
export const artifactKinds = [...ordinaryArtifactKinds, previewBundleArtifactKind] as const;
export type ArtifactKind = typeof artifactKinds[number];
export type OrdinaryArtifactKind = typeof ordinaryArtifactKinds[number];
export const artifactMaximumBytes = 10 * 1024 * 1024;

export type ArtifactSource =
  | { kind: "run"; sourceKey: string; runId: string; agentId: string }
  | { kind: "run"; sourceKey: string; runId: string; instanceId: string; allocationId: string }
  | { kind: "external"; sourceKey: string; clientId: string };

export interface Artifact {
  id: string;
  threadId?: string;
  /** Present only for a hub-hosted producer. Older records derive their source key from this id. */
  runId?: string;
  /** Stable producer identity. Required for external artifacts; optional only for legacy run state. */
  sourceKey?: string;
  /** Compatibility attribution: the configured agent that produced it. Absent on an instance run. */
  agentId?: string;
  /** Version-5: the resident instance that produced it, and the allocation it ran under. */
  instanceId?: string;
  allocationId?: string;
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

/** Persisted lifecycle metadata; bundle bytes remain owned by the linked Artifact. */
export interface ArtifactPreviewRecord {
  id: string;
  readonly artifactId: string;
  readonly artifactSha256: string;
  readonly threadId: string;
  /** Present only for a hub-hosted producer. Older records derive their source key from this id. */
  readonly runId?: string;
  /** Stable producer identity. Required for external previews; optional only for legacy run state. */
  readonly sourceKey?: string;
  /** Compatibility attribution; mutually exclusive with the instance/allocation pair. */
  readonly agentId?: string;
  readonly instanceId?: string;
  readonly allocationId?: string;
  readonly entrypoint: string;
  status: ArtifactPreviewStatus;
  processingGeneration: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  readyAt?: string;
  failedAt?: string;
  failureCode?: ArtifactPreviewFailureCode;
  expiredAt?: string;
}

/** Public preview projection. Eligibility is derived for the snapshot time and is never authority. */
export interface ArtifactPreview extends ArtifactPreviewRecord {
  accessState: ArtifactPreviewAccessState;
}

/** Compatibility-only agent run. New output uses InstanceRun. */
export interface Run {
  id: string;
  threadId?: string;
  /**
   * Compatibility attribution: the configured agent this run executes as. Absent on a version-5
   * instance run, which names `instanceId`/`allocationId` instead. An instance identity is never
   * written here: the field is typed as an agent id and every agent-keyed lookup reads it.
   */
  agentId?: string;
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
  /** Version-5: the resident instance this run executes as; absent on a legacy agent run. */
  instanceId?: string;
  /** Version-5: the exact allocation this run was dispatched against. */
  allocationId?: string;
  /** Version-4: the task this run is an execution attempt for. */
  taskId?: string;
  /** Version-4: one-based attempt number within the owning task. */
  attempt?: number;
  /** Version-4: how Barista drives the harness; absent means `native-cli`. */
  transport?: HarnessTransport;
  /**
   * Version-4: set to `native-cli` on an `acp-v1` run whose requirements also accept the native
   * CLI, permitting Barista to fall back to it before the prompt when its operator enabled that.
   */
  fallbackTransport?: HarnessTransport;
  /** Version-4: the transport Barista actually selected, recorded from `run.started`. */
  transportSelection?: RunTransportSelection;
  sessionBindingId?: string;
  workspaceLeaseId?: string;
  /**
   * Native CLI runs: the vendor's own session identity, recorded for operator reference only.
   * Coffee Shop never resumes it; ACP sessions are identified by their session binding instead.
   */
  providerSessionId?: string;
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
  /** Version-5 attribution: the resident instance and allocation behind the event. */
  instanceId?: string;
  allocationId?: string;
  runId?: string;
  fromAgentId?: string;
  toAgentId?: string;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  threadId?: string;
  /** Compatibility attribution; absent on a message an instance run authored. */
  agentId?: string;
  /** Version-5 attribution: the resident instance and allocation behind the message. */
  instanceId?: string;
  allocationId?: string;
  author: "you" | "agent" | "system";
  body: string;
  kind: "message" | "handoff" | "status";
  runId?: string;
  createdAt: string;
}

export const threadStatuses = ["active", "completed", "archived"] as const;
export type ThreadStatus = typeof threadStatuses[number];

/**
 * Who drives a thread. An `agent` thread is orchestrated by a hub-hosted agent run, the behaviour
 * `ownerAgentId` has always described. An `external` thread is orchestrated by an operator's own
 * Claude Code session through an orchestrator client, and has no owner agent.
 */
export const threadOrchestratorKinds = ["agent", "external", "instance"] as const;
export type ThreadOrchestratorKind = typeof threadOrchestratorKinds[number];

export type ThreadOrchestrator =
  | { kind: "instance"; instanceId: string }
  /** Compatibility-only persisted input. */
  | { kind: "agent"; agentId: string }
  | { kind: "external"; clientId: string };

/** Existing consumers remain explicitly legacy until their instance migration. */
export type LegacyThreadOrchestrator = Exclude<ThreadOrchestrator, { kind: "instance" }>;
export interface Thread<Orchestrator extends ThreadOrchestrator = ThreadOrchestrator> {
  id: string;
  title: string;
  objective: string;
  summary: string;
  status: ThreadStatus;
  /**
   * The orchestrating agent, absent for an externally orchestrated thread. Threads persisted before
   * `orchestrator` existed carry only this field; the hub derives `orchestrator` from it on load.
   */
  ownerAgentId?: string;
  /** Absent only in a snapshot persisted before external orchestrators existed. */
  orchestrator?: Orchestrator;
  createdBy: "user" | "agent";
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  archivedAt?: string;
}

export interface Snapshot {
  instances?: AgentInstance[];
  allocations?: InstanceAllocation[];
  templates?: AgentTemplate[];
  agents: Agent[];
  nodes: ComputeNode[];
  runs: Run[];
  events: TimelineEvent[];
  messages: ChatMessage[];
  threads?: Thread[];
  delegations?: Delegation[];
  artifacts?: Artifact[];
  artifactPreviews?: ArtifactPreview[];
  tasks?: Task[];
  taskMessages?: TaskMessage[];
  taskMessageAcknowledgements?: TaskMessageAcknowledgement[];
  sessionBindings?: HarnessSessionBinding[];
  /** Per-thread orchestrator inbox delivery state; see `OrchestratorInbox`. */
  orchestratorInboxes?: OrchestratorInbox[];
  /** Public view of the minted orchestrator credentials; never carries a secret or its hash. */
  orchestratorClients?: OrchestratorClient[];
  orchestratorAttachments?: OrchestratorAttachment[];
  approvals?: ApprovalRequest[];
  workspaceLeases?: WorkspaceLease[];
  /** Hub-managed project definitions used for readiness checks and isolated workspace leases. */
  projectProfiles?: ProjectProfile[];
  /** Last accepted informational component reports, retained when their nodes disconnect. */
  componentInventories?: ComponentInventoryReport[];
  /** Version-4: bounded projections of accepted structured harness events, one per run. */
  runActivity?: RunActivity[];
  generatedAt: string;
}

/*
 * Run-scoped hub tools. Barista's MCP bridge (apps/control-agent/internal/protocol/hubtools.go)
 * lists exactly these names; a Go test reads this declaration to keep the two in sync. Tools in
 * `delegationHubToolNames` are listed and served only to agents allowed to delegate.
 */
export const hubToolNames = [
  "get_task_context",
  "delegate_task",
  "post_artifact",
  "publish_preview",
  "update_thread",
  "get_execution_inventory",
  "spawn_instance",
  "get_instance",
  "renew_instance",
  "release_instance",
  "submit_tasks",
  "send_task_message",
  "wait_for_task_events",
  "update_task"
] as const;
export type HubToolName = typeof hubToolNames[number];
export const delegationHubToolNames: readonly HubToolName[] = [
  "delegate_task",
  "get_execution_inventory",
  "spawn_instance",
  "get_instance",
  "renew_instance",
  "release_instance",
  "submit_tasks"
];
export const isHubToolName = (value: unknown): value is HubToolName => typeof value === "string" && (hubToolNames as readonly string[]).includes(value);

/**
 * Bounds of the orchestration tools. `maximumWaitMilliseconds` is mirrored by Barista's
 * `protocol.MaximumWaitMilliseconds`, which must stay below its hub RPC timeout.
 */
export const orchestrationToolLimits = {
  idempotencyKeyLength: 128,
  correlationIdLength: 128,
  messageBodyLength: 4_000,
  messageArtifacts: 8,
  messagesPerThread: 1_000,
  messagesPerSender: 250,
  acknowledgementsPerCall: 50,
  progressSummaryLength: 2_000,
  blockedReasonLength: 1_000,
  completionSummaryLength: 8_000,
  completionArtifacts: 16,
  updatesPerTask: 200,
  cursorLength: 512,
  defaultWaitMilliseconds: 15_000,
  maximumWaitMilliseconds: 20_000,
  maximumEventsPerWait: 50,
  concurrentWaitsPerRun: 2,
  retainedEventsPerThread: 2_000,
  contextTasks: 100,
  contextMessages: 20,
  tasksPerSourceRun: 128,
  inventoryAgents: 64,
  inventoryNodes: 32,
  inventoryCapabilitiesPerNode: 64,
  inventoryModelsPerHarness: 16
} as const;

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
  | { type: "workspace.cleanup"; runId: string; lease: WorkspaceLeaseGrant; mode: WorkspaceCleanupMode }
  | { type: "workspace.lease.confirmed"; runId: string; leaseId: string; status: WorkspaceLeaseStatus }
  | { type: "ping" };

export type ControlAgentToHub =
  | { type: "register"; protocolVersion?: ControlProtocolVersion; node: ComputeNode }
  | { type: "sync.complete"; nodeId: string; activeRunIds?: string[]; activeInstanceIds?: string[]; at: string }
  | { type: "heartbeat"; nodeId: string; activeRuns: number; activeInstances?: number; activeInstanceIds?: string[]; at: string }
  | { type: "run.started"; runId: string; at: string; transport?: RunTransportSelection }
  /**
   * Carries a text `chunk`, a `providerSessionId`, or both. `providerSessionId` is sent at most once,
   * by a native CLI run, with the vendor's own session identity so an operator can resume the
   * conversation outside Coffee Shop.
   */
  | { type: "run.output"; runId: string; chunk?: string; at: string; providerSessionId?: string }
  | { type: "run.completed"; runId: string; output: string; at: string }
  | { type: "run.failed"; runId: string; error: string; at: string }
  | { type: "run.cancelled"; runId: string; at: string }
  | { type: "hub.rpc.request"; requestId: string; runId: string; operation: HubToolName; arguments: unknown; at: string }
  | { type: "harness.event"; event: HarnessEvent }
  | { type: "session.binding"; runId: string; binding: HarnessSessionBindingUpdate; at: string }
  | { type: "workspace.lease"; runId: string; lease: WorkspaceLeaseUpdate; at: string }
  | { type: "capability.report"; report: NodeCapabilityReport }
  | { type: "component.inventory"; report: ComponentInventoryReport }
  | { type: "capability-pack.readiness"; report: CapabilityPackReadinessReport }
  | { type: "approval.undeliverable"; runId: string; approvalId: string; reason: string; at: string };

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
export const controlProtocolVersions = ["1", "2", "3", "4", "5"] as const;
export type ControlProtocolVersion = typeof controlProtocolVersions[number];
export const latestControlProtocolVersion: ControlProtocolVersion = "5";

export const controlProtocolCapabilities = ["replay-barrier", "hub-rpc", "orchestration", "instances", "component-inventory", "capability-pack-readiness"] as const;
export type ControlProtocolCapability = typeof controlProtocolCapabilities[number];

const capabilityIntroducedIn: Readonly<Record<ControlProtocolCapability, ControlProtocolVersion>> = {
  "replay-barrier": "2",
  "hub-rpc": "3",
  orchestration: "4",
  instances: "5",
  "component-inventory": "5",
  "capability-pack-readiness": "5"
};

const isOneOf = <T extends string>(values: readonly T[]) => (value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);

export const isControlProtocolVersion = isOneOf(controlProtocolVersions);

export const supportsControlCapability = (version: ControlProtocolVersion, capability: ControlProtocolCapability) =>
  isControlProtocolVersion(version)
  && Object.hasOwn(capabilityIntroducedIn, capability)
  && controlProtocolVersions.indexOf(version) >= controlProtocolVersions.indexOf(capabilityIntroducedIn[capability]);

/** The capability a hub→Barista message needs, or undefined when every version accepts it. */
export function requiredCapabilityForHubMessage(message: HubToControlAgent | InstanceHubMessage): ControlProtocolCapability | undefined {
  switch (message.type) {
    case "instance.provision":
    case "instance.release":
      return "instances";
    case "dispatch":
      if ("instance" in message || "instanceId" in message.run || "allocationId" in message.run) return "instances";
      return message.execution !== undefined || hasVersion4RunFields(message.run) ? "orchestration" : undefined;
    case "approval.decision":
    case "workspace.cleanup":
    case "workspace.lease.confirmed":
      return "orchestration";
    case "hub.rpc.response":
      return "hub-rpc";
    case "cancel":
    case "ping":
      return undefined;
  }
}

/** The capability a Barista→hub message needs, or undefined when every version may send it. */
export function requiredCapabilityForControlAgentMessage(message: ControlAgentToHub | InstanceControlMessage): ControlProtocolCapability | undefined {
  switch (message.type) {
    case "instance.ready":
    case "instance.failed":
    case "instance.released":
      return "instances";
    case "sync.complete":
      return message.activeInstanceIds !== undefined ? "instances" : "replay-barrier";
    case "hub.rpc.request":
      return "hub-rpc";
    case "harness.event":
    case "session.binding":
    case "workspace.lease":
    case "capability.report":
    case "approval.undeliverable":
      return "orchestration";
    case "component.inventory":
      return "component-inventory";
    case "capability-pack.readiness":
      return "capability-pack-readiness";
    case "register":
      return message.node.instanceCapacity !== undefined || message.node.activeInstances !== undefined ? "instances" : undefined;
    case "heartbeat":
      return message.activeInstances !== undefined || message.activeInstanceIds !== undefined ? "instances" : undefined;
    case "run.started":
    case "run.output":
    case "run.completed":
    case "run.failed":
    case "run.cancelled":
      return undefined;
  }
}

/*
 * The transport only ever carries a type named by one of these unions. An unknown discriminator is
 * refused before any capability is resolved, so a message shape this build does not know is never
 * forwarded on the strength of its remaining fields.
 */
const hubToControlAgentMessageTypes = ["dispatch", "cancel", "hub.rpc.response", "approval.decision", "workspace.cleanup", "workspace.lease.confirmed", "ping"] as const;
const controlAgentToHubMessageTypes = ["register", "sync.complete", "heartbeat", "run.started", "run.output", "run.completed", "run.failed", "run.cancelled", "hub.rpc.request", "harness.event", "session.binding", "workspace.lease", "capability.report", "component.inventory", "capability-pack.readiness", "approval.undeliverable"] as const;
const knownMessageType = (type: string, legacy: readonly string[], instance: readonly string[]) =>
  legacy.includes(type) || instance.includes(type);

export const canSendToControlAgent = (message: HubToControlAgent | InstanceHubMessage, version: ControlProtocolVersion) => {
  if (!knownMessageType(message.type, hubToControlAgentMessageTypes, instanceHubMessageTypes)) return false;
  const capability = requiredCapabilityForHubMessage(message);
  if (capability === "instances") return validateInstanceHubMessage(message, version).ok;
  return isControlProtocolVersion(version) && (capability === undefined || supportsControlCapability(version, capability));
};

export const canAcceptFromControlAgent = (message: ControlAgentToHub | InstanceControlMessage, version: ControlProtocolVersion) => {
  if (!knownMessageType(message.type, controlAgentToHubMessageTypes, instanceControlMessageTypes)) return false;
  const capability = requiredCapabilityForControlAgentMessage(message);
  if (capability === "instances") return validateInstanceControlMessage(message, version).ok;
  if (capability === "component-inventory") return supportsControlCapability(version, capability)
    && message.type === "component.inventory" && validateComponentInventoryReport(message.report).ok;
  if (capability === "capability-pack-readiness") return supportsControlCapability(version, capability)
    && message.type === "capability-pack.readiness" && validateCapabilityPackReadinessReport(message.report).ok;
  return isControlProtocolVersion(version) && (capability === undefined || supportsControlCapability(version, capability));
};

const version4RunFields = ["taskId", "attempt", "transport", "fallbackTransport", "sessionBindingId", "workspaceLeaseId"] as const;
const hasVersion4RunFields = (run: Run | InstanceRun) => version4RunFields.some((field) => run[field] !== undefined);

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

/** Bound on the adapter name Barista reports from an ACP initialize handshake. */
export const acpAdapterNameMaximumBytes = 128;

/**
 * Why an `acp-v1` run fell back to the native CLI. Each is detected before the ACP prompt was sent;
 * a failure after that point fails the attempt and is never replayed through another transport.
 */
export const transportFallbackReasons = ["acp-adapter-unavailable", "acp-protocol-incompatible", "acp-capability-missing", "acp-mcp-unavailable"] as const;
export type TransportFallbackReason = typeof transportFallbackReasons[number];
export const isTransportFallbackReason = isOneOf(transportFallbackReasons);

/** How Barista verified an ACP adapter executable. */
export const acpAdapterSources = ["setup-ledger", "administrator-override"] as const;
export type AcpAdapterSource = typeof acpAdapterSources[number];

/**
 * How a harness's permission requests are decided, as declared by the compute node's administrator
 * in Barista's own configuration. `manual` sends every ACP permission request to Coffee Shop
 * approvals; `auto` lets the harness decide them itself and escalate only what it still asks about;
 * `bypass` disables approvals (and, for Codex, its sandbox). The hub and PWA only display it: no
 * dispatch, task, or run instruction can set or change it.
 */
export const approvalPolicies = ["manual", "auto", "bypass"] as const;
export type ApprovalPolicy = typeof approvalPolicies[number];
export const isApprovalPolicy = isOneOf(approvalPolicies);
/** The harnesses a node approval policy governs; mirrored by Barista's `harness.ApprovalPolicyHarnessIDs`. */
export const approvalPolicyHarnessIds: readonly HarnessId[] = ["claude-cli", "codex-cli"];

/** The harness warning code Barista emits when a run falls back to the native CLI. */
export const transportNativeFallbackWarning = "transport-native-fallback";

/** The transport decision Barista reports once, on `run.started`. */
export interface RunTransportSelection {
  requestedTransport: HarnessTransport;
  selectedTransport: HarnessTransport;
  /** Present exactly when `selectedTransport` differs from `requestedTransport`. */
  fallbackReason?: TransportFallbackReason;
  /** Normalized version of the native CLI, when the native CLI was selected and reports one. */
  harnessVersion?: string;
  /** The verified adapter an ACP run used or attempted. */
  adapter?: { id: string; version: string; source: AcpAdapterSource };
  /** Capabilities negotiated for this run, when ACP was selected. */
  acp?: AcpAgentCapabilities;
  /** The node approval policy the run executed under; absent means `manual`. */
  approvalPolicy?: ApprovalPolicy;
  /** Verified pack and full skill set projected and confirmed before the prompt. */
  effectiveCapabilityPack?: EffectiveCapabilityPack;
  /** Set by the hub, never by Barista, when the run reported an approval policy this hub does not recognize. */
  approvalPolicyUnrecognized?: boolean;
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
  /**
   * Version-5: the `AgentTemplate` whose role defaults this workload requires. It is discovery
   * metadata and a hard admission gate at once: a task naming a template may be placed only through
   * that template, and a task naming none needs no configured template at all. It never relaxes a
   * hard requirement — the template's own requirements are added to the task's.
   */
  templateId?: string;
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
  /**
   * Version-5: the exact resident instance this task must run on. A pinned task is never placed on
   * another instance and never falls back to an offering; an unauthorized, foreign-thread,
   * draining, or incompatible pin fails with its own diagnostic.
   */
  instanceId?: string;
  /** Compatibility-only agent pin. New overrides name an `instanceId` instead; #78 removes this. */
  agentId?: string;
  nodeId?: string;
  authorizedBy: "operator" | "policy";
}

export interface TaskAssignment {
  runId: string;
  /** Compatibility attribution; absent when the attempt is instance-keyed. */
  agentId?: string;
  /** Version-5: the resident instance executing this attempt, when the attempt is instance-keyed. */
  instanceId?: string;
  /** Version-5: the exact allocation the attempt was dispatched against. */
  allocationId?: string;
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
  "inventory-stale",
  "agent",
  "capacity",
  "protocol-version",
  "assignment",
  /** Version-5: no live harness offering satisfied the workload. */
  "offering",
  /** Version-5: the named or required `AgentTemplate` cannot serve the workload. */
  "template",
  /** Version-5: a pinned or reusable instance cannot serve the workload. */
  "instance",
  /** Version-5: the node's resident-instance capacity, which is independent of run concurrency. */
  "resident-capacity"
] as const;
export type PlacementRequirementKind = typeof placementRequirementKinds[number];

export interface UnsatisfiedRequirement {
  kind: PlacementRequirementKind;
  /** The requested value, rendered for operators. */
  requirement: string;
  /** Present when the explanation applies to one node rather than to every candidate. */
  nodeId?: string;
  /** Present when the explanation applies to one candidate agent. */
  agentId?: string;
  /** Present when the explanation applies to one resident instance. */
  instanceId?: string;
  detail: string;
}

export interface PlacementDiagnostic {
  evaluatedAt: string;
  eligibleNodeIds: string[];
  unsatisfied: UnsatisfiedRequirement[];
}

/*
 * Source keys.
 *
 * Lineage and idempotency name the principal that produced a record, not the session it used. A
 * hub-hosted orchestrator or worker is named by its run and an external orchestrator by its
 * credential, so a retry that arrives over a new bridge connection — and therefore a new
 * attachment — replays the original result instead of duplicating work. The two namespaces are
 * disjoint because a hub identifier never contains a colon.
 */
export const runSourceKey = (runId: string) => `run:${runId}`;
export const orchestratorClientSourceKey = (clientId: string) => `orchestrator-client:${clientId}`;

/**
 * The source key of a record that may predate the field. A record written before external
 * orchestrators existed carries only `sourceRunId`, and its key is derived from it, so an existing
 * persisted record keeps the identity it was written with.
 */
export const recordSourceKey = (record: { sourceKey?: string; sourceRunId?: string }): string | undefined =>
  record.sourceKey ?? (record.sourceRunId === undefined ? undefined : runSourceKey(record.sourceRunId));

export interface Task {
  id: string;
  threadId: string;
  title: string;
  instructions: string;
  status: TaskStatus;
  requirements: ExecutionRequirements;
  dependencies: TaskDependency[];
  placementOverride?: PlacementOverride;
  /** The run that submitted this task; absent for operator-created and externally submitted tasks. */
  sourceRunId?: string;
  /** The submitting principal; written only when it is not the run named by `sourceRunId`. */
  sourceKey?: string;
  idempotencyKey: string;
  /**
   * Version-5: the instance this task is waiting on. It is written in the same transaction that
   * requests the instance and reserves its allocation, which is what stops a second scheduling pass
   * from creating a duplicate instance, and it is cleared when the instance settles terminally so
   * the retry policy can place the task afresh.
   */
  placementInstanceId?: string;
  assignment?: TaskAssignment;
  placement?: PlacementDiagnostic;
  attemptRunIds: string[];
  result?: string;
  error?: string;
  /** The latest report from the task's current assignee; it never changes the task's status. */
  progress?: TaskProgress;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface TaskProgress {
  summary?: string;
  /** Advisory: the assignee is waiting on something. Distinct from the terminal `blocked` status. */
  blockedReason?: string;
  completion?: { summary: string; artifactIds: string[] };
  runId: string;
  updatedAt: string;
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
  /** The sending principal; written only when it is not the run named by `sourceRunId`. */
  sourceKey?: string;
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

/** A message as its recipient sees it; acknowledgement state comes from the separate records. */
export interface TaskMessageView {
  id: string;
  sender: TaskMessageParticipant;
  recipient: TaskMessageParticipant;
  sequence: number;
  kind: TaskMessageKind;
  body: string;
  correlationId?: string;
  inReplyToMessageId?: string;
  artifactIds: string[];
  acknowledged: boolean;
  createdAt: string;
}

export const taskEventChanges = ["status", "attempt", "progress"] as const;
export type TaskEventChange = typeof taskEventChanges[number];

/** One committed change visible to a caller, ordered by a thread-scoped `sequence`. */
export type TaskMailboxEvent =
  | { type: "message"; sequence: number; at: string; message: TaskMessageView }
  | {
    type: "task";
    sequence: number;
    at: string;
    taskId: string;
    status: TaskStatus;
    previousStatus?: TaskStatus;
    changes: TaskEventChange[];
    attempt?: { runId: string; number: number };
  };

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
  /** Compatibility context: the configured agent the session was created for. */
  agentId?: string;
  /**
   * Version-5 context: the resident instance and the exact allocation the session was created
   * under. A binding is resumable only in exactly the context it records, allocation included.
   */
  instanceId?: string;
  allocationId?: string;
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
  /** The ACP capabilities negotiated by the run that last used the session, once it started. */
  capabilities?: AcpAgentCapabilities;
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

/**
 * Bound on the delivery-only prompt a dispatch sends for a resumed session; mirrored by Barista's
 * `protocol.SessionResumePromptMaximumBytes`.
 */
export const sessionResumePromptMaximumBytes = 64 * 1024;

/*
 * Orchestrator inboxes.
 *
 * The hub owns what a thread's orchestrator has been told. Journal sequences at or below
 * `deliveredThrough` reached an orchestrator session (a continuation prompt that started, or a
 * `wait_for_task_events` page); sequences at or below `processedThrough` were acknowledged by the
 * orchestrator passing a cursor back. Only an explicit cursor advances `processedThrough`; provider
 * session history never does. A wake is one continuation run created for a contiguous range of
 * unprocessed sequences `(fromSequence, throughSequence]` when no orchestrator run is active.
 */
export const orchestratorWakeStatuses = ["scheduled", "delivered", "completed", "failed"] as const;
export type OrchestratorWakeStatus = typeof orchestratorWakeStatuses[number];
export const isOrchestratorWakeStatus = isOneOf(orchestratorWakeStatuses);

/** How a continuation reached its orchestrator session. */
export const orchestratorSessionOutcomes = ["resumed", "replaced", "new", "native"] as const;
export type OrchestratorSessionOutcome = typeof orchestratorSessionOutcomes[number];

export interface OrchestratorWake {
  /** Derived from the thread, the sequence range, and the generation. */
  id: string;
  generation: number;
  runId: string;
  fromSequence: number;
  throughSequence: number;
  /** Relevant journal sequences within the range, in order. */
  eventSequences: number[];
  /** Whether every relevant event in the range had already reached an earlier session. */
  redelivery: boolean;
  /** The binding the continuation asked Barista to resume, when one was compatible. */
  requestedSessionBindingId?: string;
  sessionOutcome?: OrchestratorSessionOutcome;
  /** The delivery-only prompt for a resumed session; kept only while the wake is `scheduled`. */
  resumePrompt?: string;
  status: OrchestratorWakeStatus;
  /** For a failed wake: whether its prompt may have reached the orchestrator. */
  failedAfterDelivery?: boolean;
  /**
   * Barista refused the dispatch only because its adapter cannot resume sessions; the binding stays
   * idle, is never requested again, and the range is retried at once with a new session.
   */
  resumeRefused?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OrchestratorInbox {
  threadId: string;
  deliveredThrough: number;
  processedThrough: number;
  generation: number;
  /** Wakes whose ranges were already delivered without being processed, since the last progress. */
  redeliveries: number;
  consecutiveFailures: number;
  /** No new wake is created before this time after a failure. */
  retryAfter?: string;
  /** The most recent wakes, newest last and bounded by `orchestratorContinuationLimits.retainedWakes`. */
  wakes: OrchestratorWake[];
  updatedAt: string;
}

export const orchestratorContinuationLimits = {
  eventsPerWake: 50,
  maximumRedeliveries: 2,
  retainedWakes: 20,
  contextTasks: 50,
  contextArtifacts: 20,
  contextFieldBytes: 600,
  contextBytes: 24 * 1024,
  eventBodyBytes: 1_200,
  deliveryBytes: 48 * 1024,
  /** A continuation never dispatched within this time is cancelled so its claim can be retaken. */
  undispatchedClaimMilliseconds: 10 * 60 * 1000,
  retryBaseMilliseconds: 5_000,
  retryMaximumMilliseconds: 10 * 60 * 1000
} as const;

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

/*
 * Decision delivery is tracked separately from the resolution: `pending` is persisted but not yet
 * written to Barista, `sent` was written to the owning socket, `applied` was confirmed by the
 * harness's own `permission.resolved` event, and `not-applied` means the harness never received or
 * never honored the decision (offline past expiry, replaced session, run ended, or refused).
 */
export const approvalDeliveryStatuses = ["pending", "sent", "applied", "not-applied"] as const;
export type ApprovalDeliveryStatus = typeof approvalDeliveryStatuses[number];
export const isApprovalDeliveryStatus = isOneOf(approvalDeliveryStatuses);

export interface ApprovalDelivery {
  status: ApprovalDeliveryStatus;
  attempts: number;
  updatedAt: string;
  reason?: string;
}

/**
 * Who resolved an approval. `policy` records a resolution made by a configured approval policy and
 * `system` one caused by expiry, run termination, or the harness itself. `orchestrator` names the
 * external orchestrator client and the attachment that carried the decision, so a decision can be
 * attributed after the attachment ends.
 */
export const approvalResolverKinds = ["operator", "policy", "system", "orchestrator"] as const;
export type ApprovalResolverKind = typeof approvalResolverKinds[number];

export type ApprovalResolvedBy =
  | { kind: "operator" }
  | { kind: "policy" }
  | { kind: "system" }
  | { kind: "orchestrator"; clientId: string; attachmentId: string };

export interface ApprovalRequest {
  /** Hub-generated identity used by REST clients. */
  id: string;
  /** The run-scoped identity Barista raised in `permission.requested`; only Barista interprets it. */
  harnessApprovalId: string;
  threadId: string;
  taskId?: string;
  runId: string;
  nodeId: string;
  /** Version-5 attribution: the resident instance and allocation of the run that raised it. */
  instanceId?: string;
  allocationId?: string;
  sessionBindingId?: string;
  toolCallId?: string;
  title: string;
  detail?: string;
  options: ApprovalOption[];
  status: ApprovalStatus;
  requestedAt: string;
  expiresAt?: string;
  resolvedAt?: string;
  resolvedBy?: ApprovalResolvedBy;
  selectedOptionId?: string;
  /** The operator idempotency key that produced the resolution; an exact replay returns it unchanged. */
  resolutionIdempotencyKey?: string;
  /** Absent when no decision needs to reach Barista, such as a harness-side timeout. */
  delivery?: ApprovalDelivery;
}

/**
 * Sent to Barista; `approved` and `rejected` carry the selected option. `approvalId` is the
 * harness approval identity from `permission.requested`, never the hub's REST identity.
 */
export interface ApprovalDecision {
  approvalId: string;
  runId: string;
  status: Exclude<ApprovalStatus, "pending">;
  selectedOptionId?: string;
}

/*
 * Run activity.
 *
 * The hub's bounded, materialized projection of one run's accepted harness events, updated in the
 * same transaction that accepts each event. Accumulated text keeps its most recent bytes: a
 * positive `truncatedBytes` counts the leading bytes that were dropped. A diff marked `truncated`
 * lost trailing text or, past the run's diff budget, all of its text. `omitted` counts items not
 * projected because a per-run count limit was reached.
 */
export const harnessEventStreamStatuses = ["open", "closed", "failed"] as const;
export type HarnessEventStreamStatus = typeof harnessEventStreamStatuses[number];

export interface BoundedText {
  text: string;
  truncatedBytes: number;
}

export interface RunActivityToolCall {
  toolCallId: string;
  status: ToolCallStatus;
  kind: ToolCallKind;
  title: string;
  detail?: string;
  updatedAt: string;
}

export interface RunActivityDiff {
  toolCallId?: string;
  path: string;
  oldText?: string;
  newText: string;
  truncated: boolean;
  sequence: number;
  at: string;
}

export interface RunActivityTerminal {
  terminalId: string;
  stdout: BoundedText;
  stderr: BoundedText;
  updatedAt: string;
}

export interface RunActivityWarning {
  code: string;
  message: string;
  sequence: number;
  at: string;
}

export interface RunActivityUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
  updatedAt: string;
}

export interface RunActivity {
  runId: string;
  threadId?: string;
  nodeId: string;
  streamStatus: HarnessEventStreamStatus;
  streamFailure?: string;
  lastSequence: number;
  acceptedEvents: number;
  message: BoundedText;
  thought: BoundedText;
  plan: PlanEntry[];
  toolCalls: RunActivityToolCall[];
  diffs: RunActivityDiff[];
  terminals: RunActivityTerminal[];
  usage?: RunActivityUsage;
  warnings: RunActivityWarning[];
  unknownEvents: number;
  omitted: { toolCalls: number; diffs: number; terminals: number; warnings: number };
  /** The most recent agent message text, bounded for list views. */
  summary: string;
  updatedAt: string;
}

/*
 * Run transcripts.
 *
 * The hub's bounded, chronological projection of one run's accepted harness events, for
 * conversation views. `RunActivity` groups a run by kind; a transcript keeps the order the harness
 * produced it in. Consecutive message, thought, and same-terminal deltas are coalesced into one
 * entry; a tool call or approval is one entry updated in place; the latest plan moves to where it
 * last changed. `id` is the sequence of the event that opened the entry and never changes. Past its
 * budget the transcript drops its oldest entries and counts them in `omittedEntries`. Transcripts
 * are served by `GET /api/runs/:id/transcript`, never published in snapshots.
 */
interface RunTranscriptEntryBase {
  id: number;
  at: string;
  updatedAt: string;
}

export type RunTranscriptEntry =
  | RunTranscriptEntryBase & { kind: "message"; text: string; truncatedBytes: number }
  | RunTranscriptEntryBase & { kind: "thought"; text: string; truncatedBytes: number }
  | RunTranscriptEntryBase & { kind: "plan"; entries: PlanEntry[] }
  | RunTranscriptEntryBase & { kind: "tool"; toolCallId: string; status: ToolCallStatus; toolKind: ToolCallKind; title: string; detail?: string }
  | RunTranscriptEntryBase & { kind: "diff"; toolCallId?: string; path: string; oldText?: string; newText: string; truncated: boolean }
  | RunTranscriptEntryBase & { kind: "terminal"; terminalId: string; stream: "stdout" | "stderr"; text: string; truncatedBytes: number }
  /** `approvalId` is the harness identity, matching `ApprovalRequest.harnessApprovalId` of the same run. */
  | RunTranscriptEntryBase & { kind: "approval"; approvalId: string; toolCallId?: string; title: string; detail?: string; status: ApprovalStatus }
  | RunTranscriptEntryBase & { kind: "warning"; code: string; message: string };

export type RunTranscriptEntryKind = RunTranscriptEntry["kind"];

export interface RunTranscript {
  runId: string;
  threadId?: string;
  lastSequence: number;
  entries: RunTranscriptEntry[];
  omittedEntries: number;
  updatedAt: string;
}

/** `transcript` is absent when the hub holds no structured events for the run. */
export interface RunTranscriptResponse {
  runId: string;
  transcript?: RunTranscript;
}

/*
 * Workspace leases grant one run exclusive use of an isolated workspace. The hub owns lease identity
 * and desired lifecycle; Barista owns what actually exists on disk and enforces containment. A
 * `git-worktree` lease is a dedicated Git worktree and branch beneath a Barista-managed directory of
 * an authorized root; an `exclusive-existing` lease is exclusive use of an existing checkout.
 * `retained` keeps data for operator attention and is left only through an explicit cleanup.
 */
export const workspaceLeaseStatuses = ["requested", "provisioning", "active", "released", "cleaning", "retained", "cleaned", "failed"] as const;
export type WorkspaceLeaseStatus = typeof workspaceLeaseStatuses[number];
export const terminalWorkspaceLeaseStatuses: readonly WorkspaceLeaseStatus[] = ["cleaned", "failed"];
export const isWorkspaceLeaseStatus = isOneOf(workspaceLeaseStatuses);

const workspaceLeaseTransitions: Readonly<Record<WorkspaceLeaseStatus, readonly WorkspaceLeaseStatus[]>> = {
  requested: ["provisioning", "failed"],
  provisioning: ["active", "released", "retained", "failed"],
  active: ["released", "retained"],
  released: ["cleaning", "retained"],
  cleaning: ["cleaned", "retained", "failed"],
  retained: ["cleaning"],
  cleaned: [],
  failed: []
};

export const isTerminalWorkspaceLeaseStatus = (status: WorkspaceLeaseStatus) => terminalWorkspaceLeaseStatuses.includes(status);
export const canTransitionWorkspaceLease = (from: WorkspaceLeaseStatus, to: WorkspaceLeaseStatus) => workspaceLeaseTransitions[from].includes(to);

export const workspaceRetentionReasons = [
  "dirty",
  "untracked",
  "diverged",
  "locked",
  "unregistered",
  "identity-mismatch",
  "ambiguous",
  "operator-hold",
  "policy"
] as const;
export type WorkspaceRetentionReason = typeof workspaceRetentionReasons[number];

export const workspaceIsolationPolicies = ["git-worktree", "exclusive-existing"] as const;
export type WorkspaceIsolationPolicy = typeof workspaceIsolationPolicies[number];
export const isWorkspaceIsolationPolicy = isOneOf(workspaceIsolationPolicies);

/** `retain` keeps every finished workspace; `when-unchanged` removes one only when nothing would be lost. */
export const workspaceCleanupPolicies = ["retain", "when-unchanged"] as const;
export type WorkspaceCleanupPolicy = typeof workspaceCleanupPolicies[number];
export const isWorkspaceCleanupPolicy = isOneOf(workspaceCleanupPolicies);

/*
 * Lease naming grammar, mirrored exactly by Barista's `internal/workspace` package. Every value is
 * derived from hub-issued identities, never from task text, so a model cannot choose a path,
 * branch, or repository.
 */
export const workspaceLeaseIdentityPattern = /^[a-z0-9][a-z0-9_-]{0,95}$/;
export const workspaceLeaseManagedDirectory = ".coffee-shop/worktrees";
export const workspaceLeaseBranchPrefix = "coffee-shop/";
export const workspaceLeaseBaseBranchPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
export const workspaceLeaseBaseBranchMaximumBytes = 200;
export const resolvedRevisionPattern = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

export const isWorkspaceLeaseIdentity = (value: unknown): value is string =>
  typeof value === "string" && workspaceLeaseIdentityPattern.test(value);

/** A default branch Barista can resolve as `refs/heads/<name>`; Git's own ref rules are applied again on the node. */
export const isWorkspaceLeaseBaseBranch = (value: unknown): value is string =>
  typeof value === "string"
  && byteLength(value) <= workspaceLeaseBaseBranchMaximumBytes
  && workspaceLeaseBaseBranchPattern.test(value)
  && !value.includes("..")
  && !value.split("/").some((component) => component.endsWith(".") || component.endsWith(".lock"));

export const workspaceLeaseBaseRef = (defaultBranch: string) => `refs/heads/${defaultBranch}`;
export const workspaceLeaseBranch = (taskId: string, runId: string) => `${workspaceLeaseBranchPrefix}${taskId}/${runId}`;
export const workspaceLeaseWorktreePath = (root: string, leaseId: string) =>
  `${root.endsWith("/") ? root : `${root}/`}${workspaceLeaseManagedDirectory}/${leaseId}`;

const schemeRepositoryUrlPattern = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/]*)([\s\S]*)$/;

/**
 * The credential-free identity of a repository URL, or undefined when none can be proven. Userinfo
 * is removed by splitting at the last `@`, exactly as URL parsers do, so a password containing a
 * raw `@` never survives: for a `scheme://` URL within its authority (the text before the next
 * `/`), and for an scp-style `user@host:path` or other scheme-less location within the text
 * before the first `/`. One trailing `/` and `.git` are ignored. A result whose authority still
 * contains `@`, that lacks a host, or that looks like it carries a secret anywhere is rejected
 * rather than repaired. Barista applies the identical rules (`protocol.NormalizeRepositoryIdentity`),
 * so the hub never stores or displays a credential embedded in a configured URL.
 */
export function normalizeRepositoryIdentity(url: string): string | undefined {
  let authority: string;
  let identity: string;
  let requiresHost: boolean;
  const scheme = schemeRepositoryUrlPattern.exec(url);
  if (scheme) {
    authority = scheme[2].slice(scheme[2].lastIndexOf("@") + 1);
    identity = `${scheme[1]}${authority}${scheme[3]}`;
    requiresHost = !scheme[1].toLowerCase().startsWith("file:");
  } else {
    const slash = url.indexOf("/");
    const prefix = slash < 0 ? url : url.slice(0, slash);
    identity = url.slice(prefix.lastIndexOf("@") + 1);
    authority = identity.split(/[/:]/, 1)[0];
    requiresHost = !url.startsWith("/");
  }
  if (identity.endsWith("/")) identity = identity.slice(0, -1);
  if (identity.endsWith(".git")) identity = identity.slice(0, -4);
  if (identity.length === 0 || authority.includes("@") || (requiresHost && authority.length === 0) || containsSecretLikeValue(identity)) return undefined;
  return identity;
}

export interface WorkspaceLease {
  id: string;
  threadId: string;
  taskId: string;
  runId: string;
  nodeId: string;
  projectProfileId: string;
  policy: WorkspaceIsolationPolicy;
  cleanup: WorkspaceCleanupPolicy;
  /** Credential-free repository identity Barista must find among the checkout's remotes (`git-worktree` only). */
  repository?: string;
  /** Canonical authorized workspace root containing the checkout and the worktree. */
  root: string;
  /** The operator-configured checkout the lease is provisioned from. */
  sourcePath: string;
  /** The requested base ref, always `refs/heads/<default branch>` (`git-worktree` only). */
  baseRevision?: string;
  /** The commit Barista resolved the base ref to; fixed once reported. */
  resolvedBaseRevision?: string;
  branch?: string;
  /** The isolated cwd; equal to `sourcePath` for `exclusive-existing`. */
  worktreePath: string;
  status: WorkspaceLeaseStatus;
  retentionReason?: WorkspaceRetentionReason;
  /** Bounded, credential-free diagnostic from the most recent Barista report. */
  detail?: string;
  /** When an operator last asked Barista to clean up this lease; the request alone changes no status. */
  cleanupRequestedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** The lease identity the hub grants in a version-4 dispatch or cleanup request. */
export type WorkspaceLeaseGrant = Pick<WorkspaceLease,
  "id" | "status" | "policy" | "cleanup" | "repository" | "root" | "sourcePath" | "baseRevision" | "resolvedBaseRevision" | "branch" | "worktreePath">;

export function workspaceLeaseGrant(lease: WorkspaceLease): WorkspaceLeaseGrant {
  const grant: WorkspaceLeaseGrant = {
    id: lease.id,
    status: lease.status,
    policy: lease.policy,
    cleanup: lease.cleanup,
    root: lease.root,
    sourcePath: lease.sourcePath,
    worktreePath: lease.worktreePath
  };
  if (lease.repository !== undefined) grant.repository = lease.repository;
  if (lease.baseRevision !== undefined) grant.baseRevision = lease.baseRevision;
  if (lease.resolvedBaseRevision !== undefined) grant.resolvedBaseRevision = lease.resolvedBaseRevision;
  if (lease.branch !== undefined) grant.branch = lease.branch;
  return grant;
}

/*
 * Harness launch waits for the hub: Barista starts a leased run only after the hub has persisted
 * the lease as `active` and answered with `workspace.lease.confirmed` for that exact run and lease.
 * A send or queued report alone never counts as persisted.
 */

/** What Barista reports while provisioning, releasing, or cleaning a lease. */
export interface WorkspaceLeaseUpdate {
  leaseId: string;
  status: WorkspaceLeaseStatus;
  retentionReason?: WorkspaceRetentionReason;
  /** The commit the base ref resolved to, reported once the worktree exists. */
  resolvedBaseRevision?: string;
  detail?: string;
}

/**
 * Why the hub asks Barista to reconcile a lease: `reconcile` after its run ended without Barista
 * settling the lease, `operator` for an explicit cleanup of a retained lease.
 */
export const workspaceCleanupModes = ["reconcile", "operator"] as const;
export type WorkspaceCleanupMode = typeof workspaceCleanupModes[number];

/** Version-4 dispatch fields; never sent to peers that registered an older version. */
export interface DispatchExecution {
  transport: HarnessTransport;
  taskId?: string;
  attempt?: number;
  /** `native-cli` permits an `acp-v1` run to fall back before its prompt; see `Run.fallbackTransport`. */
  fallbackTransport?: HarnessTransport;
  /**
   * Present when Barista should resume an existing provider session. When the session resumes,
   * Barista sends `resumePrompt` (if given) instead of the run prompt; when it cannot, it starts a
   * new session with the run prompt, which always carries the bounded durable context.
   */
  sessionBinding?: { id: string; providerSessionId: string; resumePrompt?: string };
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
const isCharacterBoundedString = (value: unknown, limit: number): value is string => typeof value === "string" && value.length <= limit;
const isIdentifier = (value: unknown): value is string => isBoundedString(value, harnessEventLimits.identifierBytes) && value.length > 0;
const isOptional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);
const isNonNegativeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isNonNegativeNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const rfc3339Timestamp = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d{1,9})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;
/** Strict RFC 3339 with a mandatory offset, matching Barista's Go `time.RFC3339Nano` check. */
export const isTimestamp = (value: unknown): value is string =>
  isIdentifier(value) && rfc3339Timestamp.test(value) && !Number.isNaN(Date.parse(value));
const isText = (value: unknown) => isBoundedString(value, harnessEventLimits.textBytes);
const isDiagnostic = (value: unknown) => isBoundedString(value, harnessEventLimits.diagnosticBytes);

const accept = <T>(value: T): Validation<T> => ({ ok: true, value });
const reject = <T>(reason: string): Validation<T> => ({ ok: false, reason });

const artifactKeys = [
  "id", "threadId", "runId", "sourceKey", "agentId", "instanceId", "allocationId", "relativePath", "title", "kind",
  "mediaType", "summary", "size", "sha256", "downloadPath", "uploaded", "idempotencyKey", "createdAt"
] as const;

/** Resolves and validates the one producer identity every artifact must carry. */
export function artifactSource(value: unknown): Validation<ArtifactSource> {
  if (!isRecord(value)) return reject("artifact source must be an object");
  const runId = value.runId;
  const sourceKey = value.sourceKey;
  const agentId = value.agentId;
  const instanceId = value.instanceId;
  const allocationId = value.allocationId;
  if (runId !== undefined) {
    if (!isIdentifier(runId)) return reject("run artifact has an invalid run id");
    const canonical = runSourceKey(runId);
    if (sourceKey !== undefined && sourceKey !== canonical) return reject("run artifact has a conflicting source key");
    const agentActor = isIdentifier(agentId) && instanceId === undefined && allocationId === undefined;
    const instanceActor = agentId === undefined && isIdentifier(instanceId) && isIdentifier(allocationId);
    if (agentActor === instanceActor) return reject("run artifact has an invalid or ambiguous actor");
    return agentActor
      ? accept({ kind: "run", sourceKey: canonical, runId, agentId })
      : accept({ kind: "run", sourceKey: canonical, runId, instanceId: instanceId as string, allocationId: allocationId as string });
  }
  if (agentId !== undefined || instanceId !== undefined || allocationId !== undefined) {
    return reject("external artifact carries run actor attribution");
  }
  if (typeof sourceKey !== "string" || !sourceKey.startsWith("orchestrator-client:")) {
    return reject("external artifact has no canonical orchestrator source key");
  }
  const clientId = sourceKey.slice("orchestrator-client:".length);
  if (!isIdentifier(clientId) || clientId.includes(":")) return reject("external artifact has a malformed client identity");
  return accept({ kind: "external", sourceKey, clientId });
}

/** Returns a canonical source key only when the complete producer identity is valid. */
export const artifactSourceKey = (value: unknown): string | undefined => {
  const source = artifactSource(value);
  return source.ok ? source.value.sourceKey : undefined;
};

/** Exact producer comparison shared by artifact/preview persistence and every read authority. */
export const sameArtifactSource = (left: unknown, right: unknown): boolean => {
  const leftSource = artifactSource(left);
  const rightSource = artifactSource(right);
  if (!leftSource.ok || !rightSource.ok || leftSource.value.kind !== rightSource.value.kind
    || leftSource.value.sourceKey !== rightSource.value.sourceKey) return false;
  if (leftSource.value.kind === "external" || rightSource.value.kind === "external") return true;
  if (leftSource.value.runId !== rightSource.value.runId) return false;
  if ("agentId" in leftSource.value) {
    return "agentId" in rightSource.value && leftSource.value.agentId === rightSource.value.agentId;
  }
  return !("agentId" in rightSource.value)
    && leftSource.value.instanceId === rightSource.value.instanceId
    && leftSource.value.allocationId === rightSource.value.allocationId;
};

/** Strict validator shared by persisted state and public snapshot consumers. */
export function validateArtifact(value: unknown): Validation<Artifact> {
  if (!isRecord(value) || !hasOnlyKeys(value, artifactKeys)) return reject("artifact contains undeclared fields");
  if (!isIdentifier(value.id) || (value.threadId !== undefined && !isIdentifier(value.threadId))) {
    return reject("artifact is missing identity");
  }
  const source = artifactSource(value);
  if (!source.ok) return reject(source.reason);
  if (source.value.kind === "external" && !isIdentifier(value.threadId)) return reject("external artifact has no thread");
  const external = source.value.kind === "external";
  const bounded = (candidate: unknown, limit: number) =>
    external ? isBoundedString(candidate, limit) : isCharacterBoundedString(candidate, limit);
  const relativePath = value.relativePath;
  if (typeof relativePath !== "string") return reject("artifact has an invalid relative path");
  const invalidExternalPath = relativePath.startsWith("/") || /^[A-Za-z]:/.test(relativePath)
    || relativePath.includes("\\") || /[\u0000-\u001f\u007f]/.test(relativePath)
    || relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
  const invalidRunPath = /^(?:[A-Za-z]:[\\/]|[\\/])/.test(relativePath)
    || relativePath.split(/[\\/]+/).includes("..");
  if (!bounded(relativePath, 1_024) || relativePath.length === 0
    || (external ? invalidExternalPath : invalidRunPath)) {
    return reject("artifact has an invalid relative path");
  }
  if (typeof value.title !== "string" || !bounded(value.title, 256) || value.title.length === 0
    || typeof value.mediaType !== "string" || !bounded(value.mediaType, 128) || value.mediaType.length === 0
    || !bounded(value.summary, 2_000)) return reject("artifact display metadata is invalid");
  if (!(artifactKinds as readonly unknown[]).includes(value.kind)) return reject("artifact has an unknown kind");
  if (!isNonNegativeInteger(value.size) || value.size > artifactMaximumBytes) return reject("artifact size is invalid");
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) return reject("artifact digest is invalid");
  if (value.downloadPath !== `/api/artifacts/${encodeURIComponent(value.id)}/content`) return reject("artifact download path is invalid");
  if (typeof value.uploaded !== "boolean" || typeof value.idempotencyKey !== "string"
    || !bounded(value.idempotencyKey, 128) || value.idempotencyKey.length === 0
    || !isTimestamp(value.createdAt)) return reject("artifact lifecycle metadata is invalid");
  return accept(value as unknown as Artifact);
}

const componentIdentifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const componentString = (value: unknown): value is string => typeof value === "string"
  && byteLength(value) <= componentInventoryLimits.identifierBytes && componentIdentifierPattern.test(value);
const componentVersion = (value: unknown): value is string => isNormalizedVersion(value)
  && byteLength(value) <= componentInventoryLimits.versionBytes;
const sortedUnique = <T extends string>(value: unknown, limit: number, check: (item: unknown) => item is T): value is T[] =>
  Array.isArray(value) && value.length <= limit && value.every(check)
  && value.every((item, index) => index === 0 || value[index - 1] < item);

export function validateComponentInventoryEntry(value: unknown): Validation<ComponentInventoryEntry> {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "kind", "id", "harnessId", "declaredVersion", "installedVersions", "activeVersion", "rollbackVersion",
    "provenance", "readiness", "updateVersion", "rollbackAvailable", "diagnosticCodes"
  ])) return reject("component inventory entry must contain only declared fields");
  if (!isOneOf(componentKinds)(value.kind) || !componentString(value.id)
    || !isOptional(value.harnessId, componentString) || !componentVersion(value.declaredVersion)) {
    return reject("component inventory entry identity is malformed");
  }
  if (value.kind === "capability-pack" ? value.harnessId !== undefined : value.harnessId === undefined) {
    return reject("component inventory harness identity does not match its kind");
  }
  if (!sortedUnique(value.installedVersions, componentInventoryLimits.installedVersions, componentVersion)
    || !isOptional(value.activeVersion, componentVersion) || !isOptional(value.rollbackVersion, componentVersion)
    || !isOptional(value.updateVersion, componentVersion)) return reject("component inventory versions are malformed");
  if (!isOneOf(componentProvenances)(value.provenance) || !isOneOf(componentReadinesses)(value.readiness)
    || typeof value.rollbackAvailable !== "boolean"
    || !sortedUnique(value.diagnosticCodes, componentInventoryLimits.diagnosticCodes, isOneOf(componentDiagnosticCodes))) {
    return reject("component inventory status is malformed");
  }
  const installedVersions = value.installedVersions as string[];
  const rollbackVersion = value.rollbackVersion as string | undefined;
  if (value.rollbackAvailable !== (rollbackVersion !== undefined && installedVersions.includes(rollbackVersion))) {
    return reject("component inventory rollback facts conflict");
  }
  if (value.kind === "capability-pack" && value.readiness !== "not-applicable") {
    return reject("capability pack executable readiness must be not-applicable");
  }
  return accept(value as unknown as ComponentInventoryEntry);
}

export function validateComponentInventoryReport(value: unknown): Validation<ComponentInventoryReport> {
  if (!isRecord(value) || !hasOnlyKeys(value, ["nodeId", "observedAt", "components"])
    || !componentString(value.nodeId) || !isTimestamp(value.observedAt)
    || !Array.isArray(value.components) || value.components.length > componentInventoryLimits.components) {
    return reject("component inventory report is malformed");
  }
  let previousKey: string | undefined;
  for (const [index, component] of value.components.entries()) {
    const validated = validateComponentInventoryEntry(component);
    if (!validated.ok) return reject(`component inventory entry ${index} is invalid: ${validated.reason}`);
    const key = `${validated.value.kind}\u0000${validated.value.id}`;
    if (previousKey !== undefined && previousKey >= key) return reject("component inventory keys must be sorted and unique");
    previousKey = key;
  }
  return accept(value as unknown as ComponentInventoryReport);
}

const capabilityPackString = (value: unknown): value is string => typeof value === "string"
  && byteLength(value) <= labelOrAcceleratorMaximumBytes && labelOrAcceleratorPattern.test(value);
const capabilityPackSkills = (value: unknown): value is string[] => sortedUnique(
  value, capabilityPackReadinessLimits.skills, capabilityPackString
) && (value as string[]).length > 0;
const capabilityPackIdentity = (value: unknown): value is CapabilityPackIdentity => isRecord(value)
  && hasOnlyKeys(value, ["id", "version", "skills"])
  && capabilityPackString(value.id) && componentVersion(value.version) && capabilityPackSkills(value.skills);
export function validateExpectedCapabilityPack(value: unknown): Validation<ExpectedCapabilityPack> {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "version", "requiredSkills"])
    || !capabilityPackString(value.id) || !componentVersion(value.version) || !capabilityPackSkills(value.requiredSkills)) {
    return reject("expected capability pack is malformed");
  }
  return accept(value as unknown as ExpectedCapabilityPack);
}
export function validateEffectiveCapabilityPack(value: unknown): Validation<EffectiveCapabilityPack> {
  if (!capabilityPackIdentity(value)) return reject("effective capability pack is malformed");
  return accept(value);
}
export function validateCapabilityPackReadinessReport(value: unknown): Validation<CapabilityPackReadinessReport> {
  if (!isRecord(value) || !hasOnlyKeys(value, ["nodeId", "observedAt", "status", "pack", "surfaces", "reasonCode"])
    || !componentString(value.nodeId) || !isTimestamp(value.observedAt)
    || !isOneOf(capabilityPackReadinessStatuses)(value.status) || !Array.isArray(value.surfaces)
    || value.surfaces.length > capabilityPackReadinessLimits.surfaces) return reject("capability pack readiness report is malformed");
  let previous = "";
  for (const surface of value.surfaces) {
    if (!isRecord(surface) || !hasOnlyKeys(surface, ["harnessId", "transport"])
      || !isHarnessId(surface.harnessId) || !isHarnessTransport(surface.transport)) return reject("capability pack readiness surface is malformed");
    const key = `${surface.harnessId}\u0000${surface.transport}`;
    if (previous >= key) return reject("capability pack readiness surfaces must be sorted and unique");
    previous = key;
  }
  if (value.status === "available") {
    if (!capabilityPackIdentity(value.pack) || value.surfaces.length === 0 || value.reasonCode !== undefined) return reject("available capability pack readiness is incomplete");
  } else if (value.pack !== undefined || value.surfaces.length !== 0 || !isOneOf(capabilityPackReadinessReasonCodes)(value.reasonCode)) {
    return reject("unavailable capability pack readiness is inconsistent");
  }
  return accept(value as unknown as CapabilityPackReadinessReport);
}

export interface PreviewBundlePathOptions {
  /** Entrypoints are regular HTML files, never directories or extensionless aliases. */
  entrypoint?: boolean;
}

/** Validates one already-normalized archive path without rewriting ambiguous input. */
export function validatePreviewBundlePath(value: unknown, options: PreviewBundlePathOptions = {}): Validation<string> {
  if (typeof value !== "string" || value.length === 0) return reject("preview path must be a non-empty string");
  if (value.normalize("NFC") !== value) return reject("preview path must use NFC normalization");
  if (value.startsWith("/") || /^[A-Za-z]:\//.test(value)) return reject("preview path must be relative");
  if (value.includes("\\") || /\p{Cc}/u.test(value)) return reject("preview path contains an unsupported character");
  if (byteLength(value) > previewBundleLimits.maximumPathBytes) return reject("preview path exceeds its byte limit");
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return reject("preview path contains an empty or traversal segment");
  }
  if (options.entrypoint === true && !value.endsWith(".html")) return reject("preview entrypoint must end in .html");
  return accept(value);
}

/** The collision key ingestion uses in addition to exact normalized-path equality. */
export const previewBundlePathCollisionKey = (value: string) =>
  value.replace(/[A-Z]/g, (character) => character.toLowerCase());

export const artifactPreviewAccessState = (
  preview: Pick<ArtifactPreviewRecord, "status" | "expiresAt">,
  now: string
): ArtifactPreviewAccessState => preview.status === "ready" && Date.parse(now) < Date.parse(preview.expiresAt)
  ? "eligible"
  : "unavailable";

const artifactPreviewRecordKeys = [
  "id", "artifactId", "artifactSha256", "threadId", "runId", "sourceKey", "agentId", "instanceId", "allocationId",
  "entrypoint", "status", "processingGeneration", "createdAt", "updatedAt", "expiresAt", "readyAt",
  "failedAt", "failureCode", "expiredAt"
] as const;

/** Strict validator shared by persistence and public snapshot guards. */
export function validateArtifactPreviewRecord(value: unknown): Validation<ArtifactPreviewRecord> {
  if (!isRecord(value) || !hasOnlyKeys(value, artifactPreviewRecordKeys)) return reject("artifact preview contains undeclared fields");
  if (!["id", "artifactId", "threadId"].every((key) => isIdentifier(value[key]))) {
    return reject("artifact preview is missing identity");
  }
  if (typeof value.artifactSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.artifactSha256)) {
    return reject("artifact preview has an invalid artifact digest");
  }
  const source = artifactSource(value);
  if (!source.ok) return reject(source.reason);
  if (!validatePreviewBundlePath(value.entrypoint, { entrypoint: true }).ok) return reject("artifact preview has an invalid entrypoint");
  if (!isArtifactPreviewStatus(value.status)) return reject("artifact preview has an unknown status");
  if (!isNonNegativeInteger(value.processingGeneration)) return reject("artifact preview has an invalid processing generation");
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) || !isTimestamp(value.expiresAt)) {
    return reject("artifact preview has an invalid timestamp");
  }

  const created = Date.parse(value.createdAt);
  const updated = Date.parse(value.updatedAt);
  const expires = Date.parse(value.expiresAt);
  const minimumExpiry = created + artifactPreviewTtlPolicy.minimumSeconds * 1_000;
  const maximumExpiry = created + artifactPreviewTtlPolicy.maximumLifetimeSeconds * 1_000;
  if (updated < created || expires < minimumExpiry || expires > maximumExpiry) {
    return reject("artifact preview timestamps are out of order or policy bounds");
  }

  const noReady = value.readyAt === undefined;
  const noFailure = value.failedAt === undefined && value.failureCode === undefined;
  const noExpiry = value.expiredAt === undefined;
  switch (value.status) {
    case "upload-pending":
      if (value.processingGeneration !== 0 || !noReady || !noFailure || !noExpiry || updated >= expires) {
        return reject("upload-pending preview carries incompatible fields");
      }
      break;
    case "processing":
      if (value.processingGeneration < 1 || !noReady || !noFailure || !noExpiry || updated >= expires) {
        return reject("processing preview carries incompatible fields");
      }
      break;
    case "ready": {
      const ready = Date.parse(typeof value.readyAt === "string" ? value.readyAt : "");
      if (value.processingGeneration < 1 || !isTimestamp(value.readyAt) || !noFailure || !noExpiry
        || ready < created || ready > updated || updated >= expires) {
        return reject("ready preview carries incompatible fields");
      }
      break;
    }
    case "failed": {
      const failed = Date.parse(typeof value.failedAt === "string" ? value.failedAt : "");
      if (!noReady || !isTimestamp(value.failedAt) || !isArtifactPreviewFailureCode(value.failureCode) || !noExpiry
        || failed < created || failed > updated || updated >= expires) {
        return reject("failed preview carries incompatible fields");
      }
      break;
    }
    case "expired": {
      const expired = Date.parse(typeof value.expiredAt === "string" ? value.expiredAt : "");
      if (!noReady || !noFailure || !isTimestamp(value.expiredAt) || expired < expires || expired > updated || updated < expires) {
        return reject("expired preview carries incompatible fields");
      }
      break;
    }
  }
  return accept(value as unknown as ArtifactPreviewRecord);
}

/** Validates a public projection and proves its derived access state matches the snapshot clock. */
export function validateArtifactPreview(value: unknown, now: unknown): Validation<ArtifactPreview> {
  if (!isRecord(value) || !hasOnlyKeys(value, [...artifactPreviewRecordKeys, "accessState"])) {
    return reject("public artifact preview contains undeclared fields");
  }
  if (!isTimestamp(now)) return reject("artifact preview snapshot time is invalid");
  const { accessState, ...record } = value;
  const validated = validateArtifactPreviewRecord(record);
  if (!validated.ok) return reject(validated.reason);
  if (!(artifactPreviewAccessStates as readonly unknown[]).includes(accessState)
    || accessState !== artifactPreviewAccessState(validated.value, now)) {
    return reject("artifact preview access state is invalid");
  }
  return accept(value as unknown as ArtifactPreview);
}

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
  if (!isRecord(value) || !hasOnlyKeys(value, ["approvalId", "runId", "status", "selectedOptionId"])) return reject("approval decision must contain only declared fields");
  if (!isIdentifier(value.approvalId) || !isIdentifier(value.runId)) return reject("approval decision is missing identity");
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

const isAcpAdapterSource = isOneOf(acpAdapterSources);

export const isAcpAgentCapabilities = (value: unknown): value is AcpAgentCapabilities =>
  isRecord(value)
  && hasOnlyKeys(value, ["protocolVersion", "loadSession", "resumeSession", "prompt", "mcp", "adapterName", "adapterVersion"])
  && value.protocolVersion === 1
  && typeof value.loadSession === "boolean"
  && typeof value.resumeSession === "boolean"
  && isRecord(value.prompt) && hasOnlyKeys(value.prompt, ["image", "audio", "embeddedContext"])
  && typeof value.prompt.image === "boolean" && typeof value.prompt.audio === "boolean" && typeof value.prompt.embeddedContext === "boolean"
  && isRecord(value.mcp) && hasOnlyKeys(value.mcp, ["http", "sse"]) && typeof value.mcp.http === "boolean" && typeof value.mcp.sse === "boolean"
  && isOptional(value.adapterName, (name) => isBoundedString(name, acpAdapterNameMaximumBytes) && !containsSecretLikeValue(name))
  && isOptional(value.adapterVersion, isNormalizedVersion);

const isAdapterProvenance = (value: unknown) =>
  isRecord(value) && hasOnlyKeys(value, ["id", "version", "source"])
  && typeof value.id === "string" && byteLength(value.id) <= labelOrAcceleratorMaximumBytes && labelOrAcceleratorPattern.test(value.id)
  && isNormalizedVersion(value.version) && isAcpAdapterSource(value.source);

/** Validates a Barista-reported transport selection; mirrors Go `RunTransportSelection.Validate`. */
export function validateRunTransportSelection(value: unknown): Validation<RunTransportSelection> {
  if (!isRecord(value) || !hasOnlyKeys(value, ["requestedTransport", "selectedTransport", "fallbackReason", "harnessVersion", "adapter", "acp", "approvalPolicy", "effectiveCapabilityPack"])) return reject("transport selection must contain only declared fields");
  if (!isHarnessTransport(value.requestedTransport) || !isHarnessTransport(value.selectedTransport)) return reject("transport selection names an unknown transport");
  if (value.selectedTransport === value.requestedTransport) {
    if (value.fallbackReason !== undefined) return reject("transport selection has a fallback reason without a fallback");
  } else if (value.requestedTransport !== "acp-v1" || value.selectedTransport !== "native-cli" || !isTransportFallbackReason(value.fallbackReason)) {
    return reject("transport selection falls back other than from acp-v1 to native-cli for a known reason");
  }
  if (!isOptional(value.harnessVersion, isNormalizedVersion)) return reject("transport selection harness version is not a normalized version");
  if (!isOptional(value.adapter, isAdapterProvenance)) return reject("transport selection adapter provenance is malformed");
  if (!isOptional(value.approvalPolicy, isApprovalPolicy)) return reject("transport selection names an unknown approval policy");
  if (!isOptional(value.effectiveCapabilityPack, (item) => validateEffectiveCapabilityPack(item).ok)) return reject("transport selection capability pack proof is malformed");
  if (value.acp !== undefined && (value.selectedTransport !== "acp-v1" || !isAcpAgentCapabilities(value.acp))) return reject("transport selection ACP capabilities are malformed or belong to a native run");
  return accept(value as unknown as RunTransportSelection);
}

export function validateWorkspaceLeaseUpdate(value: unknown): Validation<WorkspaceLeaseUpdate> {
  if (!isRecord(value) || !hasOnlyKeys(value, ["leaseId", "status", "retentionReason", "resolvedBaseRevision", "detail"])) return reject("workspace lease update must contain only declared fields");
  if (!isIdentifier(value.leaseId)) return reject("workspace lease update is missing identity");
  if (!isWorkspaceLeaseStatus(value.status)) return reject("workspace lease status is missing or unknown");
  if (value.status === "retained" ? !isWorkspaceRetentionReason(value.retentionReason) : value.retentionReason !== undefined) return reject("workspace lease retention reason does not match its status");
  if (!isOptional(value.resolvedBaseRevision, (revision) => typeof revision === "string" && resolvedRevisionPattern.test(revision))) return reject("workspace lease resolved base revision is malformed");
  if (!isOptional(value.detail, isDiagnostic)) return reject("workspace lease detail exceeds its bound");
  return accept(value as unknown as WorkspaceLeaseUpdate);
}

/**
 * Validates a version-4 Barista→hub message on a connection that registered `version`. Messages
 * that need a newer version than the connection negotiated are rejected, never reinterpreted.
 */
export type OrchestrationControlAgentMessage = Extract<ControlAgentToHub, { type: "harness.event" | "session.binding" | "workspace.lease" | "approval.undeliverable" }>;
const orchestrationControlAgentMessageTypes = ["harness.event", "session.binding", "workspace.lease", "approval.undeliverable"] as const;
export const isOrchestrationControlAgentMessageType = isOneOf(orchestrationControlAgentMessageTypes);

export function validateOrchestrationControlAgentMessage(value: unknown, version: ControlProtocolVersion): Validation<OrchestrationControlAgentMessage> {
  if (!isRecord(value)) return reject("control message must be an object");
  if (!isOrchestrationControlAgentMessageType(value.type)) return reject("control message type is not an orchestration message");
  if (!supportsControlCapability(version, "orchestration")) return reject(`${value.type} requires control protocol version 4`);
  if (value.type === "approval.undeliverable") {
    if (!hasOnlyKeys(value, ["type", "runId", "approvalId", "reason", "at"])) return reject("approval.undeliverable envelope contains undeclared fields");
    if (!isIdentifier(value.runId) || !isIdentifier(value.approvalId) || !isTimestamp(value.at)) return reject("approval.undeliverable is missing identity or timestamp");
    if (!isDiagnostic(value.reason)) return reject("approval.undeliverable reason exceeds its bound");
    return accept({ type: value.type, runId: value.runId, approvalId: value.approvalId, reason: value.reason, at: value.at });
  }
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
  /** When present, every task attempt for the project runs in an exclusive workspace lease. */
  isolation?: WorkspaceIsolationPolicy;
  /** What happens to a finished lease's workspace; defaults to `retain`. Requires `isolation`. */
  cleanup?: WorkspaceCleanupPolicy;
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
  if (!isRecord(workspacePolicy) || !hasOnlyKeys(workspacePolicy, ["requireWritable", "allowedRepositories", "isolation", "cleanup"])) {
    return reject("project profile workspace policy must contain only declared fields");
  }
  if (typeof workspacePolicy.requireWritable !== "boolean") {
    return reject("project profile workspace policy requireWritable must be a boolean");
  }
  if (workspacePolicy.allowedRepositories !== undefined && !isUniqueBoundedStringArray(workspacePolicy.allowedRepositories, 512)) {
    return reject("project profile allowedRepositories must be a non-empty array of unique non-empty strings");
  }
  if (workspacePolicy.isolation !== undefined && !isWorkspaceIsolationPolicy(workspacePolicy.isolation)) {
    return reject("project profile workspace isolation is unknown");
  }
  if (workspacePolicy.cleanup !== undefined && (workspacePolicy.isolation === undefined || !isWorkspaceCleanupPolicy(workspacePolicy.cleanup))) {
    return reject("project profile workspace cleanup is unknown or has no isolation policy");
  }
  if (workspacePolicy.isolation === "git-worktree") {
    const repository = value.repository as Record<string, unknown> | undefined;
    if (repository === undefined) return reject("project profile git-worktree isolation requires a repository");
    if (!isWorkspaceLeaseBaseBranch(repository.defaultBranch)) return reject("project profile repository default branch is not a valid branch name");
    if (normalizeRepositoryIdentity(repository.url as string) === undefined) return reject("project profile repository url has no credential-free identity");
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

/*
 * External orchestrators.
 *
 * An operator's own Claude Code session drives a thread through a local bridge that holds one
 * outbound WebSocket to the hub. The bridge authenticates as an `OrchestratorClient` credential and
 * attaches to the threads it orchestrates; the hub owns every identity and decision below.
 */
export const orchestratorClientScopes = ["orchestrate", "resolve-approvals"] as const;
export type OrchestratorClientScope = typeof orchestratorClientScopes[number];
export const isOrchestratorClientScope = isOneOf(orchestratorClientScopes);

export const isThreadOrchestratorKind = isOneOf(threadOrchestratorKinds);

/**
 * The public view of a minted credential. The secret is shown once at creation and kept only as a
 * hash in the hub's own stored record, which is never part of a `Snapshot`.
 */
export interface OrchestratorClient {
  id: string;
  name: string;
  scopes: OrchestratorClientScope[];
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}

/**
 * One bridge connection's claim on one thread. At most one attachment per thread is `attached`; a
 * newer attach marks the previous one `replaced`, and losing the socket marks it `detached`. The
 * acknowledged event cursor lives on the thread's orchestrator inbox, so it outlives attachments.
 */
export const orchestratorAttachmentStatuses = ["attached", "detached", "replaced"] as const;
export type OrchestratorAttachmentStatus = typeof orchestratorAttachmentStatuses[number];
export const isOrchestratorAttachmentStatus = isOneOf(orchestratorAttachmentStatuses);

export interface OrchestratorAttachment {
  id: string;
  threadId: string;
  clientId: string;
  /** The hub-assigned identity of the bridge connection that holds this attachment. */
  connectionId: string;
  attachedAt: string;
  lastHeartbeatAt: string;
  detachedAt?: string;
  status: OrchestratorAttachmentStatus;
}

/** Resolves a thread's orchestrator, deriving it from `ownerAgentId` for a pre-migration thread. */
export function threadOrchestrator<T extends ThreadOrchestrator = LegacyThreadOrchestrator>(thread: { orchestrator?: T; ownerAgentId?: string }): T | { kind: "agent"; agentId: string } | undefined {
  if (thread.orchestrator !== undefined) return thread.orchestrator;
  return thread.ownerAgentId === undefined ? undefined : { kind: "agent", agentId: thread.ownerAgentId };
}

/** The orchestrating agent, or `undefined` when the thread is not agent-orchestrated. */
export function threadOwnerAgentId(thread: Pick<Thread, "orchestrator" | "ownerAgentId">): string | undefined {
  const orchestrator = threadOrchestrator(thread);
  return orchestrator?.kind === "agent" ? orchestrator.agentId : undefined;
}

/*
 * Orchestrator-client wire protocol, version 1, spoken on the hub's `/orchestrator-client`
 * WebSocket. Every frame is a JSON object discriminated by `type`. The credential travels in the
 * first frame, never in the URL.
 */
export const orchestratorClientProtocolVersion = 1;

/** The bridge sends a heartbeat this often; the hub detaches a connection silent for the expiry. */
export const orchestratorClientHeartbeatSeconds = 15;
export const orchestratorClientHeartbeatExpirySeconds = 45;

/** Why the hub closed an orchestrator-client socket. The bridge never retries `revoked`. */
export const orchestratorClientCloseReasons = ["unauthorized", "revoked", "unsupported_version"] as const;
export type OrchestratorClientCloseReason = typeof orchestratorClientCloseReasons[number];
export const isOrchestratorClientCloseReason = isOneOf(orchestratorClientCloseReasons);

/**
 * The MCP tools the bridge offers a session. `list_approvals` and `resolve_approval` are offered
 * only to a client holding the `resolve-approvals` scope.
 */
export const externalOrchestratorToolNames = [
  "create_thread",
  "list_threads",
  "attach_thread",
  "detach_thread",
  "get_thread_context",
  "get_thread_events",
  "submit_tasks",
  "update_task",
  "send_task_message",
  "post_artifact",
  "publish_preview",
  "update_thread",
  "get_execution_inventory",
  "spawn_instance",
  "get_instance",
  "renew_instance",
  "release_instance",
  "list_approvals",
  "resolve_approval"
] as const;
export type ExternalOrchestratorToolName = typeof externalOrchestratorToolNames[number];
export const isExternalOrchestratorToolName = isOneOf(externalOrchestratorToolNames);

/** Tools reachable only with the `resolve-approvals` scope; every other tool needs `orchestrate`. */
export const approvalScopedExternalOrchestratorToolNames: readonly ExternalOrchestratorToolName[] = ["list_approvals", "resolve_approval"];

export const requiredScopeForExternalOrchestratorTool = (tool: ExternalOrchestratorToolName): OrchestratorClientScope =>
  approvalScopedExternalOrchestratorToolNames.includes(tool) ? "resolve-approvals" : "orchestrate";

/**
 * Failure codes an `rpc.response` may carry. `not_attached` means this connection holds no
 * attachment on the named thread, `forbidden` that the thread belongs to another orchestrator,
 * `revoked` that the credential no longer exists, and `hub_unavailable` that the hub could not
 * serve the call at all.
 */
export const orchestratorClientErrorCodes = [
  "not_attached",
  "forbidden",
  "revoked",
  "hub_unavailable",
  "conflict",
  "invalid_arguments",
  "not_found"
] as const;
export type OrchestratorClientErrorCode = typeof orchestratorClientErrorCodes[number];
export const isOrchestratorClientErrorCode = isOneOf(orchestratorClientErrorCodes);

export interface OrchestratorClientError {
  code: OrchestratorClientErrorCode;
  message: string;
}

/** Bounds every orchestrator-client frame is validated against, in bytes unless named otherwise. */
export const orchestratorClientLimits = {
  clientNameBytes: 200,
  secretBytes: 512,
  argumentsBytes: 256 * 1024,
  resultBytes: 1024 * 1024,
  errorMessageBytes: 2 * 1024,
  doorbellSummaryBytes: 2 * 1024,
  maximumHeartbeatSeconds: 3_600
} as const;

export type OrchestratorClientToHub =
  | { type: "client.hello"; protocolVersion: number; clientId: string; secret: string }
  | { type: "client.heartbeat" }
  | { type: "rpc.request"; requestId: string; tool: ExternalOrchestratorToolName; arguments: Record<string, unknown> };

export type OrchestratorHubToClient =
  | { type: "client.welcome"; connectionId: string; heartbeatSeconds: number; scopes: OrchestratorClientScope[] }
  | { type: "rpc.response"; requestId: string; result: unknown }
  | { type: "rpc.response"; requestId: string; error: OrchestratorClientError }
  | { type: "doorbell"; threadId: string; pending: number; approvals: number; urgent: boolean; summary: string }
  | { type: "attachment.replaced"; threadId: string; attachmentId: string }
  | { type: "client.revoked" };

export type OrchestratorClientMessageType = OrchestratorClientToHub["type"];
export type OrchestratorHubMessageType = OrchestratorHubToClient["type"];
export const orchestratorClientMessageTypes = ["client.hello", "client.heartbeat", "rpc.request"] as const;
export const orchestratorHubMessageTypes = ["client.welcome", "rpc.response", "doorbell", "attachment.replaced", "client.revoked"] as const;
const isOrchestratorClientMessageType = isOneOf(orchestratorClientMessageTypes);
const isOrchestratorHubMessageType = isOneOf(orchestratorHubMessageTypes);

/** A tool result or argument payload must round-trip as JSON and stay within its bound. */
const isBoundedJson = (value: unknown, limit: number) => {
  if (value === undefined) return false;
  let encoded: string;
  try {
    encoded = JSON.stringify(value) ?? "";
  } catch {
    return false;
  }
  return encoded !== "" && byteLength(encoded) <= limit;
};

const isScopeList = (value: unknown): value is OrchestratorClientScope[] =>
  Array.isArray(value)
  && value.length > 0
  && value.length <= orchestratorClientScopes.length
  && value.every(isOrchestratorClientScope)
  && new Set(value as string[]).size === value.length;

const isOrchestratorClientErrorPayload = (value: unknown): value is OrchestratorClientError =>
  isRecord(value) && hasOnlyKeys(value, ["code", "message"])
  && isOrchestratorClientErrorCode(value.code) && isBoundedString(value.message, orchestratorClientLimits.errorMessageBytes);

const orchestratorClientPayloadKeys: Readonly<Record<OrchestratorClientMessageType, readonly string[]>> = {
  "client.hello": ["protocolVersion", "clientId", "secret"],
  "client.heartbeat": [],
  "rpc.request": ["requestId", "tool", "arguments"]
};

const orchestratorClientPayloadValidators: Readonly<Record<OrchestratorClientMessageType, (message: Record<string, unknown>) => boolean>> = {
  "client.hello": (message) => message.protocolVersion === orchestratorClientProtocolVersion
    && isIdentifier(message.clientId)
    && isBoundedString(message.secret, orchestratorClientLimits.secretBytes) && message.secret.length > 0,
  "client.heartbeat": () => true,
  "rpc.request": (message) => isIdentifier(message.requestId)
    && isExternalOrchestratorToolName(message.tool)
    && isRecord(message.arguments)
    && isBoundedJson(message.arguments, orchestratorClientLimits.argumentsBytes)
};

/**
 * Validates one bridge→hub frame. An unknown `type`, an undeclared field, a wrong field type, or an
 * oversize string is rejected with a reason; a partial message is never returned.
 */
export function validateOrchestratorClientMessage(value: unknown): Validation<OrchestratorClientToHub> {
  if (!isRecord(value)) return reject("orchestrator client message must be an object");
  if (!isOrchestratorClientMessageType(value.type)) return reject("orchestrator client message type is missing or unknown");
  if (!hasOnlyKeys(value, ["type", ...orchestratorClientPayloadKeys[value.type]])) return reject(`${value.type} contains undeclared fields`);
  if (!orchestratorClientPayloadValidators[value.type](value)) return reject(`${value.type} payload is malformed or exceeds its bounds`);
  return accept(value as unknown as OrchestratorClientToHub);
}

const orchestratorHubPayloadKeys: Readonly<Record<OrchestratorHubMessageType, readonly string[]>> = {
  "client.welcome": ["connectionId", "heartbeatSeconds", "scopes"],
  "rpc.response": ["requestId", "result", "error"],
  doorbell: ["threadId", "pending", "approvals", "urgent", "summary"],
  "attachment.replaced": ["threadId", "attachmentId"],
  "client.revoked": []
};

const orchestratorHubPayloadValidators: Readonly<Record<OrchestratorHubMessageType, (message: Record<string, unknown>) => boolean>> = {
  "client.welcome": (message) => isIdentifier(message.connectionId)
    && typeof message.heartbeatSeconds === "number" && Number.isSafeInteger(message.heartbeatSeconds)
    && message.heartbeatSeconds > 0 && message.heartbeatSeconds <= orchestratorClientLimits.maximumHeartbeatSeconds
    && isScopeList(message.scopes),
  "rpc.response": (message) => {
    if (!isIdentifier(message.requestId)) return false;
    const carriesResult = Object.hasOwn(message, "result");
    const carriesError = Object.hasOwn(message, "error");
    if (carriesResult === carriesError) return false;
    return carriesError
      ? isOrchestratorClientErrorPayload(message.error)
      : isBoundedJson(message.result, orchestratorClientLimits.resultBytes);
  },
  doorbell: (message) => isIdentifier(message.threadId)
    && isNonNegativeInteger(message.pending) && isNonNegativeInteger(message.approvals)
    && typeof message.urgent === "boolean"
    && isBoundedString(message.summary, orchestratorClientLimits.doorbellSummaryBytes),
  "attachment.replaced": (message) => isIdentifier(message.threadId) && isIdentifier(message.attachmentId),
  "client.revoked": () => true
};

/** Validates one hub→bridge frame under the same fail-closed rules as the bridge→hub direction. */
export function validateOrchestratorHubMessage(value: unknown): Validation<OrchestratorHubToClient> {
  if (!isRecord(value)) return reject("orchestrator hub message must be an object");
  if (!isOrchestratorHubMessageType(value.type)) return reject("orchestrator hub message type is missing or unknown");
  if (!hasOnlyKeys(value, ["type", ...orchestratorHubPayloadKeys[value.type]])) return reject(`${value.type} contains undeclared fields`);
  if (!orchestratorHubPayloadValidators[value.type](value)) return reject(`${value.type} payload is malformed or exceeds its bounds`);
  return accept(value as unknown as OrchestratorHubToClient);
}

/*
 * Ephemeral instances (v5). These exports are contracts only: no legacy record is silently
 * migrated and a deployed v4 Barista must not advertise v5 until it implements supervision.
 * Instance identity survives allocation loss; a replacement always has a new allocation ID.
 */
export const instanceStatuses = ["requested", "provisioning", "ready", "busy", "idle", "draining", "released", "failed"] as const;
export type InstanceStatus = typeof instanceStatuses[number];
export const allocationStatuses = ["reserved", "provisioning", "active", "lost", "released", "failed"] as const;
export type AllocationStatus = typeof allocationStatuses[number];
export const terminalInstanceStatuses: readonly InstanceStatus[] = ["released", "failed"];
export const occupyingAllocationStatuses: readonly AllocationStatus[] = ["reserved", "provisioning", "active"];
export const instanceReleaseModes = ["drain", "cancel"] as const;
export type InstanceReleaseMode = typeof instanceReleaseModes[number];
export const instanceCreatorKinds = ["operator", "run", "orchestrator-client"] as const;
export const isInstanceStatus = isOneOf(instanceStatuses);
export const isAllocationStatus = isOneOf(allocationStatuses);
export const isTerminalInstanceStatus = isOneOf(terminalInstanceStatuses);
export const isOccupyingAllocationStatus = isOneOf(occupyingAllocationStatuses);
export const isInstanceReleaseMode = isOneOf(instanceReleaseModes);
export const instanceTransitions: Readonly<Record<InstanceStatus, readonly InstanceStatus[]>> = {
  requested: ["provisioning", "draining", "failed"],
  provisioning: ["ready", "draining", "failed"],
  ready: ["busy", "idle", "provisioning", "draining", "failed"],
  busy: ["idle", "provisioning", "draining", "failed"],
  idle: ["busy", "provisioning", "draining", "failed"],
  draining: ["released", "failed"],
  released: [],
  failed: []
};
export const allocationTransitions: Readonly<Record<AllocationStatus, readonly AllocationStatus[]>> = {
  reserved: ["provisioning", "released", "failed"],
  provisioning: ["active", "lost", "released", "failed"],
  active: ["lost", "released", "failed"],
  lost: ["released", "failed"],
  released: [],
  failed: []
};
export const canTransitionInstance = (from: InstanceStatus, to: InstanceStatus) =>
  isInstanceStatus(from) && isInstanceStatus(to) && instanceTransitions[from].includes(to);
export const canTransitionAllocation = (from: AllocationStatus, to: AllocationStatus) =>
  isAllocationStatus(from) && isAllocationStatus(to) && allocationTransitions[from].includes(to);

/** All string limits are UTF-8 bytes; counts are bounded integers, never floating point. */
export const instanceLimits = {
  identifierBytes: 256, nameBytes: 256, summaryBytes: 2_000, instructionsBytes: 65_536,
  idempotencyKeyBytes: 128, workspaceBytes: 4_096, collectionEntries: 1_024,
  requirementEntries: 64, count: 65_535, minimumIdleTimeoutSeconds: 60,
  defaultIdleTimeoutSeconds: 1_800, maximumIdleTimeoutSeconds: 86_400
} as const;
export const minimumInstanceIdleTimeoutSeconds = instanceLimits.minimumIdleTimeoutSeconds;
export const defaultInstanceIdleTimeoutSeconds = instanceLimits.defaultIdleTimeoutSeconds;
export const maximumInstanceIdleTimeoutSeconds = instanceLimits.maximumIdleTimeoutSeconds;

/** Display and instructions only. Purpose never supplies implicit placement requirements. */
export interface InstancePurpose { name?: string; title?: string; summary?: string; instructions?: string }
/** Derived from authenticated caller context, never accepted as an authority claim by a route. */
export type InstanceCreator =
  | { kind: "operator"; operatorId: string }
  | { kind: "run"; runId: string; instanceId: string }
  | { kind: "orchestrator-client"; clientId: string };
/** Hub-granted policy; models cannot self-elevate this field. */
export interface InstanceDelegationPolicy { canDelegate: boolean }
/** Accepted work or an authorized renewal refreshes expiry; expiry initiates drain. */
export interface InstanceLease { idleTimeoutSeconds: number; expiresAt: string }
export interface AgentInstance {
  readonly id: string;
  readonly threadId: string;
  readonly creator: InstanceCreator;
  purpose?: InstancePurpose;
  delegation: InstanceDelegationPolicy;
  /** Original hard requirements, retained unchanged when replacing a lost allocation. */
  readonly requirements: ExecutionRequirements;
  lease: InstanceLease;
  status: InstanceStatus;
  createdAt: string;
  updatedAt: string;
}
export interface InstanceAllocation {
  readonly id: string;
  readonly instanceId: string;
  readonly nodeId: string;
  readonly harnessId: HarnessId;
  readonly model: string;
  readonly transport: HarnessTransport;
  /** Canonical absolute path authorized by Barista against WORKSPACE_ROOTS. */
  readonly workspace: string;
  /** Immutable pack evidence admitted with this allocation generation. */
  readonly expectedCapabilityPack?: ExpectedCapabilityPack;
  lease: InstanceLease;
  status: AllocationStatus;
  createdAt: string;
  updatedAt: string;
}
/** Reusable defaults only: no runtime identity, node binding, session, inbox, or capacity. */
export interface AgentTemplate {
  id: string;
  name: string;
  purpose?: InstancePurpose;
  glyph?: string;
  avatarShape?: AgentAvatarShape;
  avatarColor?: AgentAvatarColor;
  instructions?: string;
  skills?: string[];
  tags?: string[];
  requirements?: ExecutionRequirements;
  preferences?: ExecutionPreferences;
  /** Hub-granted delegation default for instances created from this template. */
  delegation?: InstanceDelegationPolicy;
  /**
   * The configured agent this template was imported from. It is the deterministic marker that makes
   * the one-shot legacy import idempotent: a restart finds the template by this field rather than by
   * a timestamp, so no second template is ever written.
   */
  legacyAgentId?: string;
}

/**
 * Operator intent for a thread whose orchestrator is a resident instance. The Hub chooses and
 * persists the exact allocation; callers describe only the thread and placement requirements.
 */
export interface CreateHostedThreadRequest {
  idempotencyKey: string;
  title: string;
  objective: string;
  orchestrator: {
    purpose?: InstancePurpose;
    requirements: ExecutionRequirements;
    idleTimeoutSeconds?: number;
  };
}

export interface CreateHostedThreadResult {
  thread: Thread<{ kind: "instance"; instanceId: string }>;
  instance: AgentInstance;
  allocation: InstanceAllocation;
  replayed: boolean;
}
/** New actor attribution always names both logical identity and the exact allocation. */
export interface InstanceActor { instanceId: string; allocationId: string }
export type RuntimeActor = ({ kind: "instance" } & InstanceActor) | { kind: "agent"; agentId: string };
type InstanceRecord<T> = Omit<T, "agentId" | "fromAgentId" | "toAgentId"> & InstanceActor & { agentId?: never };
export type InstanceRun = InstanceRecord<Run> & { threadId: string; transport: HarnessTransport };
export type InstanceTaskAssignment = InstanceRecord<TaskAssignment>;
export type InstanceSessionBinding = InstanceRecord<HarnessSessionBinding>;
export type InstanceChatMessage = InstanceRecord<ChatMessage>;
export type InstanceTimelineEvent = InstanceRecord<TimelineEvent> & { from?: InstanceActor; to?: InstanceActor };
export type InstanceArtifact = InstanceRecord<Artifact>;
export type InstanceApprovalRequest = ApprovalRequest & InstanceActor;
export type InstanceHarnessEvent = HarnessEvent & InstanceActor;
export type InstanceDelegation = Omit<Delegation, "fromAgentId" | "toAgentId"> & { from: InstanceActor; to: InstanceActor };
export type InstanceSessionBindingUpdate = HarnessSessionBindingUpdate & InstanceActor;
export type InstanceTaskMessage = TaskMessage & { actor: InstanceActor };
/** Decoding unions are compatibility inputs, never permission to emit legacy data as v5. */
export type RuntimeRun = Run | InstanceRun;
export type RuntimeThread = Thread<ThreadOrchestrator>;
export type RuntimeSnapshot = Omit<Snapshot, "runs" | "artifacts" | "messages" | "events" | "sessionBindings" | "approvals" | "tasks" | "threads"> & {
  threads?: RuntimeThread[];
  runs: RuntimeRun[];
  artifacts?: (Artifact | InstanceArtifact)[];
  messages: (ChatMessage | InstanceChatMessage)[];
  events: (TimelineEvent | InstanceTimelineEvent)[];
  sessionBindings?: (HarnessSessionBinding | InstanceSessionBinding)[];
  approvals?: (ApprovalRequest | InstanceApprovalRequest)[];
  tasks?: (Omit<Task, "assignment"> & { assignment?: TaskAssignment | InstanceTaskAssignment })[];
};

export const instanceHubMessageTypes = ["instance.provision", "instance.release", "dispatch"] as const;
export const instanceControlMessageTypes = ["instance.ready", "instance.failed", "instance.released", "register", "heartbeat", "sync.complete"] as const;
export type InstanceHubMessage =
  | { type: "instance.provision"; instance: AgentInstance; allocation: InstanceAllocation }
  | ({ type: "instance.release"; mode: InstanceReleaseMode } & InstanceActor)
  | { type: "dispatch"; instance: AgentInstance; allocation: InstanceAllocation; run: InstanceRun;
      sessionBinding?: DispatchExecution["sessionBinding"] };
export type InstanceControlMessage =
  | ({ type: "instance.ready" | "instance.released"; nodeId: string; at: string } & InstanceActor)
  | ({ type: "instance.failed"; nodeId: string; at: string; error: string } & InstanceActor)
  | Extract<ControlAgentToHub, { type: "register" | "heartbeat" | "sync.complete" }>;
/** Use these unions at migrated transport boundaries; old handlers retain their v1-v4 shapes. */
export type VersionedHubToControlAgent = HubToControlAgent | InstanceHubMessage;
export type VersionedControlAgentToHub = ControlAgentToHub | InstanceControlMessage;

/** Caller scope comes from authentication. The key identifies one semantic operation in that scope. */
export interface InstanceIdempotency { caller: InstanceCreator; key: string }
export interface InstanceInitialTask { title: string; instructions: string }
export const instanceLifecycleOperations = ["create", "release", "renew"] as const;
export type InstanceLifecycleRequest =
  | { operation: "create"; threadId: string; idempotency: InstanceIdempotency; purpose?: InstancePurpose;
      requirements: ExecutionRequirements; idleTimeoutSeconds?: number; initialTask?: InstanceInitialTask }
  | { operation: "release"; threadId: string; instanceId: string; idempotency: InstanceIdempotency; mode: InstanceReleaseMode }
  | { operation: "renew"; threadId: string; instanceId: string; idempotency: InstanceIdempotency; idleTimeoutSeconds?: number };
/** Same shapes for REST, run-scoped MCP, and the external orchestrator bridge. */
export interface InstanceLifecycleResult {
  instance: AgentInstance;
  allocation?: InstanceAllocation;
  initialTaskId?: string;
  replayed: boolean;
}
export interface ListInstancesRequest { threadId: string; includeTerminal?: boolean }
export interface ListInstancesResult { instances: AgentInstance[]; allocations: InstanceAllocation[] }
export interface GetInstanceRequest { threadId: string; instanceId: string }

/** Closed public arguments accepted by the run-scoped and external instance-tool adapters. */
export interface SpawnInstanceArguments {
  idempotencyKey: string;
  requirements: ExecutionRequirements;
  purpose?: InstancePurpose;
  idleTimeoutSeconds?: number;
  initialTask?: InstanceInitialTask;
}
export interface GetInstanceArguments { instanceId: string }
export interface RenewInstanceArguments { instanceId: string; idempotencyKey: string; idleTimeoutSeconds?: number }
export interface ReleaseInstanceArguments { instanceId: string; idempotencyKey: string; mode: InstanceReleaseMode }
export type InstanceToolArguments =
  | SpawnInstanceArguments
  | GetInstanceArguments
  | RenewInstanceArguments
  | ReleaseInstanceArguments;

/** Public lifecycle views omit authority, workspace, provider-session, and historical allocation data. */
export type ToolSafeInstance = Omit<AgentInstance, "creator" | "purpose"> & {
  purpose?: Omit<InstancePurpose, "instructions">;
};
export type ToolSafeInstanceAllocation = Omit<InstanceAllocation, "workspace">;
export interface InstanceToolResult {
  instance: ToolSafeInstance;
  allocation?: ToolSafeInstanceAllocation;
  initialTaskId?: string;
  replayed?: boolean;
}

const instanceID = (value: unknown): value is string =>
  isBoundedString(value, instanceLimits.identifierBytes) && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
const instanceCount = (value: unknown): value is number => isNonNegativeInteger(value) && value <= instanceLimits.count;
const instanceText = (value: unknown) => isBoundedString(value, instanceLimits.instructionsBytes);
const instanceIDs = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= instanceLimits.collectionEntries && value.every(instanceID) && new Set(value).size === value.length;
const instanceStrings = (value: unknown, check: (value: unknown) => boolean = (item) => isIdentifier(item)): value is string[] =>
  Array.isArray(value) && value.length <= instanceLimits.requirementEntries && value.every(check) && new Set(value).size === value.length;
const idleTimeout = (value: unknown) => isNonNegativeInteger(value)
  && value >= minimumInstanceIdleTimeoutSeconds && value <= maximumInstanceIdleTimeoutSeconds;
const instanceLease = (value: unknown): value is InstanceLease => isRecord(value)
  && hasOnlyKeys(value, ["idleTimeoutSeconds", "expiresAt"]) && idleTimeout(value.idleTimeoutSeconds) && isTimestamp(value.expiresAt);
const instancePurpose = (value: unknown): value is InstancePurpose => isRecord(value)
  && hasOnlyKeys(value, ["name", "title", "summary", "instructions"])
  && ["name", "title"].every((key) => isOptional(value[key], (item) => isBoundedString(item, instanceLimits.nameBytes)))
  && isOptional(value.summary, (item) => isBoundedString(item, instanceLimits.summaryBytes))
  && isOptional(value.instructions, instanceText);
const instanceCreator = (value: unknown): value is InstanceCreator => {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "operator": return hasOnlyKeys(value, ["kind", "operatorId"]) && instanceID(value.operatorId);
    case "run": return hasOnlyKeys(value, ["kind", "runId", "instanceId"]) && instanceID(value.runId) && instanceID(value.instanceId);
    case "orchestrator-client": return hasOnlyKeys(value, ["kind", "clientId"]) && instanceID(value.clientId);
    default: return false;
  }
};
const executionPreferences = (value: unknown): value is ExecutionPreferences => isRecord(value)
  && hasOnlyKeys(value, ["nodeIds", "harnessIds", "models", "labels"])
  && ["nodeIds", "models", "labels"].every((key) => isOptional(value[key], instanceStrings))
  && isOptional(value.harnessIds, (items) => instanceStrings(items, isHarnessId));
const absoluteInstancePath = (value: unknown): value is string => isBoundedString(value, instanceLimits.workspaceBytes)
  && !/[\u0000-\u001f]/.test(value) && (/^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value));
export function validateInstanceRequirements(value: unknown): Validation<ExecutionRequirements> {
  if (!isRecord(value) || !hasOnlyKeys(value, ["skills", "harnessIds", "models", "transports", "operatingSystems", "architectures", "labels", "minimumConcurrency", "minimumMemoryMegabytes", "projectProfileId", "templateId", "workspace", "preferences"])
    || !["skills", "models", "operatingSystems", "architectures", "labels"].every((key) => isOptional(value[key], instanceStrings))
    || !isOptional(value.harnessIds, (items) => instanceStrings(items, isHarnessId))
    || !isOptional(value.transports, (items) => instanceStrings(items, isHarnessTransport))
    || !isOptional(value.minimumConcurrency, instanceCount) || !isOptional(value.minimumMemoryMegabytes, (megabytes) => isNonNegativeInteger(megabytes) && megabytes <= 2 ** 32 - 1)
    || !isOptional(value.projectProfileId, instanceID) || !isOptional(value.templateId, instanceID)
    || !isOptional(value.preferences, executionPreferences)) return reject("invalid instance requirements");
  if (value.workspace !== undefined && (!isRecord(value.workspace) || !hasOnlyKeys(value.workspace, ["repository", "path", "writable"])
    || typeof value.workspace.writable !== "boolean" || !isOptional(value.workspace.path, absoluteInstancePath)
    || !isOptional(value.workspace.repository, (item) => isBoundedString(item, instanceLimits.workspaceBytes)))) return reject("invalid instance workspace requirements");
  return accept(value as ExecutionRequirements);
}
export function validateAgentInstance(value: unknown): Validation<AgentInstance> {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "threadId", "creator", "purpose", "delegation", "requirements", "lease", "status", "createdAt", "updatedAt"])
    || !instanceID(value.id) || !instanceID(value.threadId) || !instanceCreator(value.creator) || !isOptional(value.purpose, instancePurpose)
    || !isRecord(value.delegation) || !hasOnlyKeys(value.delegation, ["canDelegate"]) || typeof value.delegation.canDelegate !== "boolean"
    || !validateInstanceRequirements(value.requirements).ok || !instanceLease(value.lease) || !isInstanceStatus(value.status)
    || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) return reject("invalid agent instance");
  return accept(value as unknown as AgentInstance);
}
export function validateInstanceAllocation(value: unknown): Validation<InstanceAllocation> {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "instanceId", "nodeId", "harnessId", "model", "transport", "workspace", "expectedCapabilityPack", "lease", "status", "createdAt", "updatedAt"])
    || !["id", "instanceId", "nodeId"].every((key) => instanceID(value[key])) || !isHarnessId(value.harnessId)
    || !isIdentifier(value.model) || !isHarnessTransport(value.transport) || !absoluteInstancePath(value.workspace)
    || !isOptional(value.expectedCapabilityPack, (item) => validateExpectedCapabilityPack(item).ok)
    || !instanceLease(value.lease) || !isAllocationStatus(value.status) || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) return reject("invalid instance allocation");
  return accept(value as unknown as InstanceAllocation);
}
export function validateAgentTemplate(value: unknown): Validation<AgentTemplate> {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "name", "purpose", "glyph", "avatarShape", "avatarColor", "instructions", "skills", "tags", "requirements", "preferences", "delegation", "legacyAgentId"])
    || !instanceID(value.id) || !isIdentifier(value.name) || !isOptional(value.purpose, instancePurpose) || !isOptional(value.glyph, isIdentifier)
    || !isOptional(value.avatarShape, isOneOf(agentAvatarShapes)) || !isOptional(value.avatarColor, isOneOf(agentAvatarColors))
    || !isOptional(value.instructions, instanceText) || !isOptional(value.skills, instanceStrings) || !isOptional(value.tags, instanceStrings)
    || !isOptional(value.requirements, (item) => validateInstanceRequirements(item).ok) || !isOptional(value.preferences, executionPreferences)
    || !isOptional(value.delegation, (item) => isRecord(item) && hasOnlyKeys(item, ["canDelegate"]) && typeof item.canDelegate === "boolean")
    || !isOptional(value.legacyAgentId, instanceID)) return reject("invalid agent template");
  // Preferences may rank concrete nodes; a template never fixes a node binding.
  return accept(value as unknown as AgentTemplate);
}
export function validateRuntimeActor(value: unknown): Validation<RuntimeActor> {
  if (!isRecord(value)) return reject("invalid actor");
  if (value.kind === "agent" && hasOnlyKeys(value, ["kind", "agentId"]) && instanceID(value.agentId)) return accept(value as unknown as RuntimeActor);
  if (value.kind === "instance" && hasOnlyKeys(value, ["kind", "instanceId", "allocationId"]) && instanceID(value.instanceId) && instanceID(value.allocationId)) return accept(value as unknown as RuntimeActor);
  return reject("invalid or ambiguous actor");
}
export function validateInstanceHarnessEvent(value: unknown): Validation<InstanceHarnessEvent> {
  if (!isRecord(value) || !instanceID(value.instanceId) || !instanceID(value.allocationId)) return reject("missing instance event identity");
  const { instanceId, allocationId, ...event } = value;
  if (!validateHarnessEvent(event).ok) return reject("invalid instance event");
  return accept(value as unknown as InstanceHarnessEvent);
}
export function validateInstanceRun(value: unknown): Validation<InstanceRun> {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "threadId", "instanceId", "allocationId", "nodeId", "harnessId", "model", "workspace", "prompt", "status", "output", "error", "depth", "parentRunId", "dispatchedAt", "startedAt", "finishedAt", "createdAt", "taskId", "attempt", "transport", "fallbackTransport", "transportSelection", "sessionBindingId", "workspaceLeaseId", "providerSessionId"])
    || !["id", "threadId", "instanceId", "allocationId", "nodeId"].every((key) => instanceID(value[key]))
    || !isHarnessId(value.harnessId) || !isIdentifier(value.model) || !absoluteInstancePath(value.workspace)
    || !instanceText(value.prompt) || !instanceText(value.output) || !isOptional(value.error, isDiagnostic)
    || !isOneOf(runStatuses)(value.status) || !instanceCount(value.depth) || !isTimestamp(value.createdAt) || !isHarnessTransport(value.transport)
    || !["parentRunId", "taskId", "sessionBindingId", "workspaceLeaseId", "providerSessionId"].every((key) => isOptional(value[key], instanceID))
    || !["dispatchedAt", "startedAt", "finishedAt"].every((key) => isOptional(value[key], isTimestamp))
    || !isOptional(value.attempt, (attempt) => instanceCount(attempt) && attempt > 0)
    || !isOptional(value.fallbackTransport, (item) => value.transport === "acp-v1" && item === "native-cli")
    || !isOptional(value.transportSelection, (item) => validateRunTransportSelection(item).ok)) return reject("invalid instance run");
  return accept(value as unknown as InstanceRun);
}
function instanceDispatchSessionBinding(value: unknown): value is NonNullable<DispatchExecution["sessionBinding"]> {
  return isRecord(value) && hasOnlyKeys(value, ["id", "providerSessionId", "resumePrompt"])
    && isIdentifier(value.id) && isIdentifier(value.providerSessionId)
    && !containsSecretLikeValue({ id: value.id, providerSessionId: value.providerSessionId })
    && isOptional(value.resumePrompt, (prompt) => isBoundedString(prompt, sessionResumePromptMaximumBytes));
}
export function validateInstanceHubMessage(value: unknown, version: ControlProtocolVersion): Validation<InstanceHubMessage> {
  if (!supportsControlCapability(version, "instances") || !isRecord(value)) return reject("instances require protocol v5");
  if (value.type === "instance.release") {
    if (!hasOnlyKeys(value, ["type", "instanceId", "allocationId", "mode"]) || !instanceID(value.instanceId) || !instanceID(value.allocationId) || !isInstanceReleaseMode(value.mode)) return reject("invalid instance release");
    return accept(value as unknown as InstanceHubMessage);
  }
  if ((value.type !== "instance.provision" && value.type !== "dispatch") || !hasOnlyKeys(value, value.type === "dispatch" ? ["type", "instance", "allocation", "run", "sessionBinding"] : ["type", "instance", "allocation"])) return reject("unknown instance message or field");
  const instance = validateAgentInstance(value.instance);
  const allocation = validateInstanceAllocation(value.allocation);
  if (!instance.ok || !allocation.ok || instance.value.id !== allocation.value.instanceId
    || instance.value.lease.idleTimeoutSeconds !== allocation.value.lease.idleTimeoutSeconds
    || instance.value.lease.expiresAt !== allocation.value.lease.expiresAt) return reject("instance and allocation identity or lease mismatch");
  const requiredSkills = [...new Set(instance.value.requirements.skills ?? [])].sort();
  const expectedSkills = allocation.value.expectedCapabilityPack?.requiredSkills;
  if ((requiredSkills.length === 0) !== (expectedSkills === undefined)
    || (expectedSkills !== undefined && requiredSkills.some((skill) => !expectedSkills.includes(skill)))) {
    return reject("instance skill requirements and allocation capability pack expectation mismatch");
  }
  if (value.type === "instance.provision") {
    if (instance.value.status !== "provisioning" || !["reserved", "provisioning"].includes(allocation.value.status)) return reject("invalid provision state");
  } else {
    const run = validateInstanceRun(value.run);
    if (!run.ok || run.value.instanceId !== instance.value.id || run.value.allocationId !== allocation.value.id
      || run.value.threadId !== instance.value.threadId || run.value.status !== "queued"
      || !["ready", "busy", "idle"].includes(instance.value.status) || allocation.value.status !== "active"
      || !(["nodeId", "harnessId", "model", "transport", "workspace"] as const).every((key) => run.value[key] === allocation.value[key])
      || (run.value.sessionBindingId === undefined) !== (value.sessionBinding === undefined)
      || (value.sessionBinding !== undefined && (run.value.transport !== "acp-v1" || !instanceDispatchSessionBinding(value.sessionBinding) || value.sessionBinding.id !== run.value.sessionBindingId))) return reject("invalid dispatch identity, state, resolved placement, or session binding");
  }
  return accept(value as unknown as InstanceHubMessage);
}
/** Missing evidence is non-authoritative even on v5. Null/malformed is rejected, never empty. */
export const hasAuthoritativeInstanceEvidence = (value: unknown): value is { activeInstanceIds: string[] } =>
  isRecord(value) && instanceIDs(value.activeInstanceIds);
export function validateInstanceControlMessage(value: unknown, version: ControlProtocolVersion): Validation<InstanceControlMessage> {
  if (!supportsControlCapability(version, "instances") || !isRecord(value)) return reject("instances require protocol v5");
  if (value.type === "register") {
    const node = value.node;
    if (!hasOnlyKeys(value, ["type", "protocolVersion", "node"]) || value.protocolVersion !== version || !isRecord(node)
      || !hasOnlyKeys(node, ["id", "name", "kind", "platform", "status", "lastSeen", "activeRuns", "concurrency", "instanceCapacity", "activeInstances", "workspaceRoots", "harnesses", "version"])
      || !instanceID(node.id) || !isIdentifier(node.name) || !isOneOf(nodeKinds)(node.kind) || !isIdentifier(node.platform)
      || !isOneOf(["online", "offline", "busy"])(node.status) || !isTimestamp(node.lastSeen) || !isIdentifier(node.version)
      || !instanceCount(node.activeRuns) || !instanceCount(node.concurrency) || !isOptional(node.instanceCapacity, instanceCount) || !isOptional(node.activeInstances, instanceCount)
      || (typeof node.activeInstances === "number" && typeof node.instanceCapacity === "number" && node.activeInstances > node.instanceCapacity)
      || !instanceStrings(node.workspaceRoots, absoluteInstancePath) || !Array.isArray(node.harnesses) || node.harnesses.length > instanceLimits.requirementEntries
      || !node.harnesses.every(instanceHarnessProfile) || new Set(node.harnesses.map((harness) => harness.id)).size !== node.harnesses.length) return reject("invalid v5 registration");
  } else if (value.type === "heartbeat") {
    if (!hasOnlyKeys(value, ["type", "nodeId", "activeRuns", "activeInstances", "activeInstanceIds", "at"]) || !instanceID(value.nodeId) || !isTimestamp(value.at)
      || !instanceCount(value.activeRuns) || !isOptional(value.activeInstances, instanceCount) || !isOptional(value.activeInstanceIds, instanceIDs)) return reject("invalid v5 heartbeat");
  } else if (value.type === "sync.complete") {
    if (!hasOnlyKeys(value, ["type", "nodeId", "activeRuns", "activeRunIds", "activeInstanceIds", "at"]) || !instanceID(value.nodeId) || !isTimestamp(value.at)
      || !isOptional(value.activeRuns, instanceCount) || !isOptional(value.activeRunIds, instanceIDs) || !isOptional(value.activeInstanceIds, instanceIDs)) return reject("invalid v5 reconciliation evidence");
  } else {
    if (!["instance.ready", "instance.failed", "instance.released"].includes(value.type as string)
      || !hasOnlyKeys(value, value.type === "instance.failed" ? ["type", "nodeId", "instanceId", "allocationId", "at", "error"] : ["type", "nodeId", "instanceId", "allocationId", "at"])
      || !["nodeId", "instanceId", "allocationId"].every((key) => instanceID(value[key])) || !isTimestamp(value.at)
      || (value.type === "instance.failed" && !isDiagnostic(value.error))) return reject("invalid instance lifecycle evidence");
  }
  return accept(value as unknown as InstanceControlMessage);
}
const instanceHarnessProfile = (value: unknown): value is HarnessProfile => isRecord(value)
  && hasOnlyKeys(value, ["id", "label", "description", "binary", "available", "authMode", "models", "transports", "acp", "approvalPolicy"])
  && isHarnessId(value.id) && isIdentifier(value.label) && isDiagnostic(value.description) && typeof value.available === "boolean"
  && isOneOf(["local-subscription", "local-account", "api", "none"])(value.authMode)
  && instanceStrings(value.models) && isOptional(value.binary, (item) => isBoundedString(item, instanceLimits.workspaceBytes))
  && isOptional(value.transports, (items) => instanceStrings(items, isHarnessTransport)) && isOptional(value.approvalPolicy, isApprovalPolicy)
  && isOptional(value.acp, (item) => isAcpAgentCapabilities(item));
export function validateInstanceLifecycleRequest(value: unknown): Validation<InstanceLifecycleRequest> {
  if (!isRecord(value) || !instanceID(value.threadId) || !isRecord(value.idempotency)
    || !hasOnlyKeys(value.idempotency, ["caller", "key"]) || !instanceCreator(value.idempotency.caller)
    || !isBoundedString(value.idempotency.key, instanceLimits.idempotencyKeyBytes) || value.idempotency.key.length === 0) return reject("invalid lifecycle identity");
  if (value.operation === "create") {
    if (!hasOnlyKeys(value, ["operation", "threadId", "idempotency", "purpose", "requirements", "idleTimeoutSeconds", "initialTask"])
      || !isOptional(value.purpose, instancePurpose) || !validateInstanceRequirements(value.requirements).ok || !isOptional(value.idleTimeoutSeconds, idleTimeout)
      || !isOptional(value.initialTask, (task) => isRecord(task) && hasOnlyKeys(task, ["title", "instructions"]) && isIdentifier(task.title) && instanceText(task.instructions))) return reject("invalid create instance request");
  } else if (value.operation === "release") {
    if (!hasOnlyKeys(value, ["operation", "threadId", "instanceId", "idempotency", "mode"]) || !instanceID(value.instanceId) || !isInstanceReleaseMode(value.mode)) return reject("invalid release instance request");
  } else if (value.operation === "renew") {
    if (!hasOnlyKeys(value, ["operation", "threadId", "instanceId", "idempotency", "idleTimeoutSeconds"]) || !instanceID(value.instanceId) || !isOptional(value.idleTimeoutSeconds, idleTimeout)) return reject("invalid renew instance request");
  } else return reject("unknown instance lifecycle operation");
  return accept(value as unknown as InstanceLifecycleRequest);
}
export function validateGetInstanceRequest(value: unknown): Validation<GetInstanceRequest> {
  if (!isRecord(value) || !hasOnlyKeys(value, ["threadId", "instanceId"])
    || !instanceID(value.threadId) || !instanceID(value.instanceId)) return reject("invalid get instance request");
  return accept(value as unknown as GetInstanceRequest);
}
/** Stable semantic digest input; caller and target identities participate, timestamps do not.
 * Requirement arrays are sets; preference arrays preserve ranking. Hashing/storage belongs to hub.
 */
export function instanceLifecycleDigestInput(request: InstanceLifecycleRequest): Validation<string> {
  const valid = validateInstanceLifecycleRequest(request);
  if (!valid.ok) return valid;
  /*
   * Only `create` coalesces an omitted idle timeout into the default, because creation applies that
   * default, so the two requests are semantically identical. A renewal's omission preserves the
   * instance's existing timeout instead, so it must digest differently from any explicit value.
   */
  const normalized = { ...request, idempotency: { caller: request.idempotency.caller },
    ...(request.operation === "create" ? { idleTimeoutSeconds: request.idleTimeoutSeconds ?? defaultInstanceIdleTimeoutSeconds } : {}) };
  const canonical = (item: unknown, key = ""): unknown => {
    if (Array.isArray(item)) return key === "preferences" ? item : [...item];
    if (!isRecord(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().filter((field) => item[field] !== undefined).map((field) => {
      const child = item[field];
      return [field, Array.isArray(child) && key === "requirements" ? [...child].sort() : canonical(child, field)];
    }));
  };
  return accept(JSON.stringify(canonical(normalized)));
}
