import { useCallback, useEffect, useRef, useState } from "react";
import {
  approvalDeliveryStatuses, approvalOptionKinds, approvalStatuses, harnessEventStreamStatuses, harnessIds,
  harnessTransports, placementRequirementKinds, planEntryPriorities, planEntryStatuses, runStatuses,
  sessionBindingStatuses, taskDependencyPolicies, taskMessageKinds, taskStatuses, toolCallKinds,
  toolCallStatuses, workspaceCleanupPolicies, workspaceIsolationPolicies, workspaceLeaseStatuses,
  workspaceRetentionReasons, orchestratorAttachmentStatuses, orchestratorClientScopes, validateAgentInstance,
  validateAgentTemplate, validateArtifact, validateArtifactPreview, validateInstanceAllocation, validateProjectProfile,
  validateComponentInventoryReport, validateEffectiveCapabilityPack, sameArtifactSource,
  type ArtifactPreview, type Snapshot
} from "@coffee-shop/protocol";

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected" | "authentication-required";

export interface ConnectionView {
  status: ConnectionStatus;
  snapshot: Snapshot;
  canMutate: boolean;
}

interface SocketLike {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  close(): void;
}

export interface ConnectionEnvironment {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  createWebSocket(url: string): SocketLike;
  isOnline(): boolean;
  addEventListener(type: "online" | "offline", listener: () => void): void;
  removeEventListener(type: "online" | "offline", listener: () => void): void;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(id: number): void;
  random(): number;
  socketUrl(token: string): string;
}

export const emptySnapshot: Snapshot = {
  agents: [],
  nodes: [],
  runs: [],
  events: [],
  messages: [],
  threads: [],
  generatedAt: ""
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isOptionalString = (value: unknown) => value === undefined || isString(value);
const isOneOf = <T extends string>(value: unknown, options: readonly T[]): value is T => isString(value) && options.includes(value as T);
const isArrayOf = (value: unknown, validator: (item: unknown) => boolean) => Array.isArray(value) && value.every(validator);

const agentStates = ["idle", "thinking", "working", "waiting", "blocked", "done"] as const;
const avatarShapes = ["cup", "bean", "moka", "kettle", "grinder", "pour-over"] as const;
const avatarColors = ["amber", "sage", "clay", "sky", "plum", "rose"] as const;

function isHarness(value: unknown): boolean {
  return isObject(value)
    && isString(value.id)
    && isString(value.label)
    && isString(value.description)
    && isOptionalString(value.binary)
    && typeof value.available === "boolean"
    && isString(value.authMode)
    && isArrayOf(value.models, isString);
}

function isAgent(value: unknown): boolean {
  return isObject(value)
    && isString(value.id)
    && isString(value.name)
    && isString(value.title)
    && isString(value.summary)
    && isString(value.glyph)
    && isOneOf(value.avatarShape, avatarShapes)
    && isOneOf(value.avatarColor, avatarColors)
    && isOneOf(value.state, agentStates)
    && isString(value.currentAction)
    && isOneOf(value.harnessId, harnessIds)
    && isString(value.model)
    && isString(value.computeNodeId)
    && isString(value.workspace)
    && isString(value.systemPrompt)
    && (value.canDelegate === undefined || typeof value.canDelegate === "boolean")
    && (value.skills === undefined || isArrayOf(value.skills, isString))
    && isNumber(value.unread)
    && isString(value.updatedAt);
}

function isDelegation(value: unknown): boolean {
  return isObject(value)
    && isString(value.id)
    && isOptionalString(value.threadId)
    && isString(value.parentRunId)
    && isString(value.childRunId)
    && isString(value.fromAgentId)
    && isString(value.toAgentId)
    && isString(value.task)
    && isString(value.idempotencyKey)
    && (value.artifactIds === undefined || isArrayOf(value.artifactIds, isString))
    && isString(value.createdAt);
}

function isArtifact(value: unknown): boolean {
  return validateArtifact(value).ok;
}

function isNode(value: unknown): boolean {
  return isObject(value)
    && isString(value.id)
    && isString(value.name)
    && isOneOf(value.kind, ["local", "home-server", "cloud"])
    && isString(value.platform)
    && isOneOf(value.status, ["online", "offline", "busy"])
    && isString(value.lastSeen)
    && isNumber(value.activeRuns)
    && isNumber(value.concurrency)
    && isOptionalNumber(value.instanceCapacity)
    && isOptionalNumber(value.activeInstances)
    && !(typeof value.instanceCapacity === "number" && typeof value.activeInstances === "number" && value.activeInstances > value.instanceCapacity)
    && isArrayOf(value.workspaceRoots, isString)
    && isArrayOf(value.harnesses, isHarness)
    && isString(value.version);
}

const isOptionalNumber = (value: unknown) => value === undefined || isNumber(value);
const isOptionalOneOf = <T extends string>(value: unknown, options: readonly T[]) => value === undefined || isOneOf(value, options);

function isRunTransportSelection(value: unknown): boolean {
  return isObject(value)
    && isOneOf(value.requestedTransport, harnessTransports)
    && isOneOf(value.selectedTransport, harnessTransports)
    && (value.fallbackReason === undefined || isString(value.fallbackReason))
    && isOptionalString(value.harnessVersion)
    && (value.adapter === undefined || (isObject(value.adapter) && isString(value.adapter.id) && isString(value.adapter.version) && isString(value.adapter.source)))
    && (value.acp === undefined || isObject(value.acp))
    && (value.effectiveCapabilityPack === undefined || validateEffectiveCapabilityPack(value.effectiveCapabilityPack).ok);
}

function isRun(value: unknown): boolean {
  return isObject(value)
    && isString(value.id)
    && isOptionalString(value.threadId)
    && isOptionalString(value.agentId)
    && isOptionalString(value.instanceId)
    && isOptionalString(value.allocationId)
    && isString(value.nodeId)
    && isOneOf(value.harnessId, harnessIds)
    && isString(value.model)
    && isString(value.workspace)
    && isString(value.prompt)
    && isOneOf(value.status, runStatuses)
    && isString(value.output)
    && isOptionalString(value.error)
    && isNumber(value.depth)
    && isOptionalString(value.parentRunId)
    && isOptionalString(value.dispatchedAt)
    && isOptionalString(value.startedAt)
    && isOptionalString(value.finishedAt)
    && isString(value.createdAt)
    && isOptionalString(value.taskId)
    && isOptionalNumber(value.attempt)
    && isOptionalOneOf(value.transport, harnessTransports)
    && isOptionalOneOf(value.fallbackTransport, harnessTransports)
    && (value.transportSelection === undefined || isRunTransportSelection(value.transportSelection))
    && isOptionalString(value.sessionBindingId)
    && isOptionalString(value.workspaceLeaseId);
}

/* Version-4 orchestration projections (#20/#22/#23/#24/#25/#29): every field is validated
 * structurally and every enum against the shared protocol vocabulary, so a malformed or unknown
 * value on any of these fails the whole snapshot closed rather than rendering a partial/garbled
 * orchestration surface. */

function isTaskDependency(value: unknown): boolean {
  return isObject(value) && isString(value.taskId) && isOneOf(value.policy, taskDependencyPolicies);
}

function isExecutionRequirements(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.skills !== undefined && !isArrayOf(value.skills, isString)) return false;
  if (value.harnessIds !== undefined && !isArrayOf(value.harnessIds, (item) => isOneOf(item, harnessIds))) return false;
  if (value.models !== undefined && !isArrayOf(value.models, isString)) return false;
  if (value.transports !== undefined && !isArrayOf(value.transports, (item) => isOneOf(item, harnessTransports))) return false;
  if (value.operatingSystems !== undefined && !isArrayOf(value.operatingSystems, isString)) return false;
  if (value.architectures !== undefined && !isArrayOf(value.architectures, isString)) return false;
  if (value.labels !== undefined && !isArrayOf(value.labels, isString)) return false;
  if (!isOptionalNumber(value.minimumConcurrency)) return false;
  if (!isOptionalNumber(value.minimumMemoryMegabytes)) return false;
  if (!isOptionalString(value.projectProfileId)) return false;
  if (value.workspace !== undefined && !(isObject(value.workspace) && isOptionalString(value.workspace.repository) && isOptionalString(value.workspace.path) && typeof value.workspace.writable === "boolean")) return false;
  if (value.preferences !== undefined && !isObject(value.preferences)) return false;
  return true;
}

function isUnsatisfiedRequirement(value: unknown): boolean {
  return isObject(value)
    && isOneOf(value.kind, placementRequirementKinds)
    && isString(value.requirement)
    && isOptionalString(value.nodeId)
    && isOptionalString(value.agentId)
    && isString(value.detail);
}

function isPlacementDiagnostic(value: unknown): boolean {
  return isObject(value)
    && isString(value.evaluatedAt)
    && isArrayOf(value.eligibleNodeIds, isString)
    && isArrayOf(value.unsatisfied, isUnsatisfiedRequirement);
}

function isTaskAssignment(value: unknown): boolean {
  return isObject(value)
    && isString(value.runId)
    && isOptionalString(value.agentId)
    && isOptionalString(value.instanceId)
    && isOptionalString(value.allocationId)
    && isString(value.nodeId)
    && isOneOf(value.harnessId, harnessIds)
    && isOneOf(value.transport, harnessTransports)
    && isString(value.model)
    && isOptionalString(value.workspaceLeaseId)
    && isString(value.assignedAt);
}

function isTaskProgress(value: unknown): boolean {
  return isObject(value)
    && isOptionalString(value.summary)
    && isOptionalString(value.blockedReason)
    && (value.completion === undefined || (isObject(value.completion) && isString(value.completion.summary) && isArrayOf(value.completion.artifactIds, isString)))
    && isString(value.runId)
    && isString(value.updatedAt);
}

function isTask(value: unknown): boolean {
  return isObject(value)
    && isString(value.id)
    && isString(value.threadId)
    && isString(value.title)
    && isString(value.instructions)
    && isOneOf(value.status, taskStatuses)
    && isExecutionRequirements(value.requirements)
    && isArrayOf(value.dependencies, isTaskDependency)
    && (value.placementOverride === undefined || (isObject(value.placementOverride) && isOptionalString(value.placementOverride.agentId) && isOptionalString(value.placementOverride.nodeId) && isOneOf(value.placementOverride.authorizedBy, ["operator", "policy"])))
    && isOptionalString(value.sourceRunId)
    && isString(value.idempotencyKey)
    && (value.assignment === undefined || isTaskAssignment(value.assignment))
    && (value.placement === undefined || isPlacementDiagnostic(value.placement))
    && isArrayOf(value.attemptRunIds, isString)
    && isOptionalString(value.result)
    && isOptionalString(value.error)
    && (value.progress === undefined || isTaskProgress(value.progress))
    && isString(value.createdAt)
    && isString(value.updatedAt)
    && isOptionalString(value.finishedAt);
}

function isTaskMessageParticipant(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.type === "task") return isString(value.taskId);
  return value.type === "orchestrator" || value.type === "operator";
}

function isTaskMessage(value: unknown): boolean {
  return isObject(value)
    && isString(value.id)
    && isString(value.threadId)
    && isTaskMessageParticipant(value.sender)
    && isTaskMessageParticipant(value.recipient)
    && isNumber(value.sequence)
    && isOneOf(value.kind, taskMessageKinds)
    && isString(value.body)
    && isOptionalString(value.correlationId)
    && isOptionalString(value.inReplyToMessageId)
    && (value.artifactIds === undefined || isArrayOf(value.artifactIds, isString))
    && isOptionalString(value.sourceRunId)
    && isString(value.idempotencyKey)
    && isString(value.createdAt);
}

function isTaskMessageAcknowledgement(value: unknown): boolean {
  return isObject(value)
    && isString(value.messageId)
    && isString(value.threadId)
    && isTaskMessageParticipant(value.recipient)
    && isString(value.runId)
    && isString(value.acknowledgedAt);
}

function isHarnessSessionBinding(value: unknown): boolean {
  return isObject(value)
    && isString(value.id)
    && isString(value.threadId)
    && isOptionalString(value.agentId)
    && isOptionalString(value.instanceId)
    && isOptionalString(value.allocationId)
    && isString(value.nodeId)
    && isOneOf(value.harnessId, harnessIds)
    && isOneOf(value.transport, harnessTransports)
    && isString(value.workspace)
    && isOptionalString(value.workspaceLeaseId)
    && isString(value.providerSessionId)
    && isOneOf(value.status, sessionBindingStatuses)
    && isString(value.createdByRunId)
    && isString(value.lastRunId)
    && isOptionalString(value.replacedByBindingId)
    && isString(value.createdAt)
    && isString(value.updatedAt);
}

function isApprovalOption(value: unknown): boolean {
  return isObject(value) && isString(value.id) && isString(value.label) && isOneOf(value.kind, approvalOptionKinds);
}

function isApprovalDelivery(value: unknown): boolean {
  return isObject(value)
    && isOneOf(value.status, approvalDeliveryStatuses)
    && isNumber(value.attempts)
    && isString(value.updatedAt)
    && isOptionalString(value.reason);
}

function isApprovalResolvedBy(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.kind === "orchestrator") return isString(value.clientId) && isString(value.attachmentId);
  return isOneOf(value.kind, ["operator", "policy", "system"]);
}

function isApprovalRequest(value: unknown): boolean {
  return isObject(value)
    && isString(value.id)
    && isString(value.harnessApprovalId)
    && isString(value.threadId)
    && isOptionalString(value.taskId)
    && isString(value.runId)
    && isString(value.nodeId)
    && isOptionalString(value.sessionBindingId)
    && isOptionalString(value.toolCallId)
    && isString(value.title)
    && isOptionalString(value.detail)
    && isArrayOf(value.options, isApprovalOption)
    && isOneOf(value.status, approvalStatuses)
    && isString(value.requestedAt)
    && isOptionalString(value.expiresAt)
    && isOptionalString(value.resolvedAt)
    && (value.resolvedBy === undefined || isApprovalResolvedBy(value.resolvedBy))
    && isOptionalString(value.selectedOptionId)
    && isOptionalString(value.resolutionIdempotencyKey)
    && (value.delivery === undefined || isApprovalDelivery(value.delivery));
}

function isWorkspaceLease(value: unknown): boolean {
  return isObject(value)
    && isString(value.id)
    && isString(value.threadId)
    && isString(value.taskId)
    && isString(value.runId)
    && isString(value.nodeId)
    && isString(value.projectProfileId)
    && isOneOf(value.policy, workspaceIsolationPolicies)
    && isOneOf(value.cleanup, workspaceCleanupPolicies)
    && isOptionalString(value.repository)
    && isString(value.root)
    && isString(value.sourcePath)
    && isOptionalString(value.baseRevision)
    && isOptionalString(value.resolvedBaseRevision)
    && isOptionalString(value.branch)
    && isString(value.worktreePath)
    && isOneOf(value.status, workspaceLeaseStatuses)
    && (value.retentionReason === undefined || isOneOf(value.retentionReason, workspaceRetentionReasons))
    && isOptionalString(value.detail)
    && isOptionalString(value.cleanupRequestedAt)
    && isString(value.createdAt)
    && isString(value.updatedAt);
}

function isBoundedText(value: unknown): boolean {
  return isObject(value) && isString(value.text) && isNumber(value.truncatedBytes);
}

function isPlanEntryForActivity(value: unknown): boolean {
  return isObject(value) && isString(value.content) && isOneOf(value.status, planEntryStatuses) && isOneOf(value.priority, planEntryPriorities);
}

function isRunActivityToolCall(value: unknown): boolean {
  return isObject(value)
    && isString(value.toolCallId)
    && isOneOf(value.status, toolCallStatuses)
    && isOneOf(value.kind, toolCallKinds)
    && isString(value.title)
    && isOptionalString(value.detail)
    && isString(value.updatedAt);
}

function isRunActivityDiff(value: unknown): boolean {
  return isObject(value)
    && isOptionalString(value.toolCallId)
    && isString(value.path)
    && isOptionalString(value.oldText)
    && isString(value.newText)
    && typeof value.truncated === "boolean"
    && isNumber(value.sequence)
    && isString(value.at);
}

function isRunActivityTerminal(value: unknown): boolean {
  return isObject(value)
    && isString(value.terminalId)
    && isBoundedText(value.stdout)
    && isBoundedText(value.stderr)
    && isString(value.updatedAt);
}

function isRunActivityWarning(value: unknown): boolean {
  return isObject(value) && isString(value.code) && isString(value.message) && isNumber(value.sequence) && isString(value.at);
}

function isRunActivityUsage(value: unknown): boolean {
  return isObject(value)
    && isOptionalNumber(value.inputTokens)
    && isOptionalNumber(value.outputTokens)
    && isOptionalNumber(value.cachedInputTokens)
    && isOptionalNumber(value.costUsd)
    && isString(value.updatedAt);
}

function isRunActivity(value: unknown): boolean {
  return isObject(value)
    && isString(value.runId)
    && isOptionalString(value.threadId)
    && isString(value.nodeId)
    && isOneOf(value.streamStatus, harnessEventStreamStatuses)
    && isOptionalString(value.streamFailure)
    && isNumber(value.lastSequence)
    && isNumber(value.acceptedEvents)
    && isBoundedText(value.message)
    && isBoundedText(value.thought)
    && isArrayOf(value.plan, isPlanEntryForActivity)
    && isArrayOf(value.toolCalls, isRunActivityToolCall)
    && isArrayOf(value.diffs, isRunActivityDiff)
    && isArrayOf(value.terminals, isRunActivityTerminal)
    && (value.usage === undefined || isRunActivityUsage(value.usage))
    && isArrayOf(value.warnings, isRunActivityWarning)
    && isNumber(value.unknownEvents)
    && (isObject(value.omitted) && isNumber(value.omitted.toolCalls) && isNumber(value.omitted.diffs) && isNumber(value.omitted.terminals) && isNumber(value.omitted.warnings))
    && isString(value.summary)
    && isString(value.updatedAt);
}

function isEvent(value: unknown): boolean {
  return isObject(value)
    && isString(value.id)
    && isOptionalString(value.threadId)
    && isOneOf(value.type, ["run", "status", "handoff", "node", "message"])
    && isString(value.title)
    && isString(value.detail)
    && isOptionalString(value.agentId)
    && isOptionalString(value.instanceId)
    && isOptionalString(value.allocationId)
    && isOptionalString(value.runId)
    && isOptionalString(value.fromAgentId)
    && isOptionalString(value.toAgentId)
    && isString(value.createdAt);
}

function isMessage(value: unknown): boolean {
  return isObject(value)
    && isString(value.id)
    && isOptionalString(value.threadId)
    && isOptionalString(value.agentId)
    && isOptionalString(value.instanceId)
    && isOptionalString(value.allocationId)
    && isOneOf(value.author, ["you", "agent", "system"])
    && isString(value.body)
    && isOneOf(value.kind, ["message", "handoff", "status"])
    && isOptionalString(value.runId)
    && isString(value.createdAt);
}

function isThreadOrchestrator(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.kind === "agent") return isString(value.agentId);
  if (value.kind === "instance") return isString(value.instanceId);
  return value.kind === "external" && isString(value.clientId);
}

function isOrchestratorClient(value: unknown): boolean {
  return isObject(value)
    && isString(value.id)
    && isString(value.name)
    && Array.isArray(value.scopes)
    && value.scopes.every((scope) => isOneOf(scope, orchestratorClientScopes))
    && isString(value.createdAt)
    && isOptionalString(value.lastSeenAt)
    && isOptionalString(value.revokedAt)
    && (value as { secretHash?: unknown }).secretHash === undefined;
}

function isOrchestratorAttachment(value: unknown): boolean {
  return isObject(value)
    && isString(value.id)
    && isString(value.threadId)
    && isString(value.clientId)
    && isString(value.connectionId)
    && isString(value.attachedAt)
    && isString(value.lastHeartbeatAt)
    && isOptionalString(value.detachedAt)
    && isOneOf(value.status, orchestratorAttachmentStatuses);
}

function isThread(value: unknown): boolean {
  return isObject(value)
    && isString(value.id)
    && isString(value.title)
    && isString(value.objective)
    && isString(value.summary)
    && isOneOf(value.status, ["active", "completed", "archived"])
    && isOptionalString(value.ownerAgentId)
    && (value.orchestrator === undefined || isThreadOrchestrator(value.orchestrator))
    && isOneOf(value.createdBy, ["user", "agent"])
    && isString(value.createdAt)
    && isString(value.updatedAt)
    && isOptionalString(value.completedAt)
    && isOptionalString(value.archivedAt);
}

function previewCollectionCorrelates(value: Record<string, unknown>) {
  if (value.artifactPreviews === undefined) return true;
  if (!Array.isArray(value.artifactPreviews)) return false;
  if (value.artifactPreviews.length === 0) return true;
  if (!Array.isArray(value.artifacts)) return false;
  const previewIds = new Set<string>();
  const artifactIds = new Set<string>();
  for (const unknownPreview of value.artifactPreviews) {
    if (!validateArtifactPreview(unknownPreview, value.generatedAt).ok) return false;
    const preview = unknownPreview as ArtifactPreview;
    if (previewIds.has(preview.id) || artifactIds.has(preview.artifactId)) return false;
    previewIds.add(preview.id);
    artifactIds.add(preview.artifactId);
    const artifacts = value.artifacts.filter((candidate) => isObject(candidate) && candidate.id === preview.artifactId);
    if (artifacts.length !== 1) return false;
    const artifact = artifacts[0]!;
    const permitsUnuploadedArtifact = preview.processingGeneration === 0
      && (preview.status === "upload-pending" || preview.status === "failed" || preview.status === "expired");
    if ((artifact.uploaded !== true && !permitsUnuploadedArtifact) || artifact.kind !== "preview-bundle"
      || artifact.mediaType !== "application/vnd.coffee-shop.preview-bundle+tar+gzip"
      || artifact.sha256 !== preview.artifactSha256 || artifact.threadId !== preview.threadId
      || !sameArtifactSource(artifact, preview)) return false;
  }
  return true;
}

function componentInventoryCollectionCorrelates(value: Record<string, unknown>) {
  if (value.componentInventories === undefined) return true;
  if (!Array.isArray(value.componentInventories) || !Array.isArray(value.nodes)) return false;
  const nodeIds = new Set(value.nodes.filter(isObject).map((node) => node.id));
  const reported = new Set<string>();
  for (const report of value.componentInventories) {
    const validated = validateComponentInventoryReport(report);
    if (!validated.ok || !nodeIds.has(validated.value.nodeId) || reported.has(validated.value.nodeId)) return false;
    reported.add(validated.value.nodeId);
  }
  return true;
}

export function isSnapshot(value: unknown): value is Snapshot {
  const v5Absent = isObject(value) && value.instances === undefined && value.allocations === undefined && value.templates === undefined;
  const v5Present = isObject(value)
    && isArrayOf(value.instances, (instance) => validateAgentInstance(instance).ok)
    && isArrayOf(value.allocations, (allocation) => validateInstanceAllocation(allocation).ok)
    && isArrayOf(value.templates, (template) => validateAgentTemplate(template).ok);
  return isObject(value)
    && (v5Absent || v5Present)
    && isArrayOf(value.agents, isAgent)
    && isArrayOf(value.nodes, isNode)
    && isArrayOf(value.runs, isRun)
    && isArrayOf(value.events, isEvent)
    && isArrayOf(value.messages, isMessage)
    && (value.threads === undefined || isArrayOf(value.threads, isThread))
    && (value.delegations === undefined || isArrayOf(value.delegations, isDelegation))
    && (value.artifacts === undefined || isArrayOf(value.artifacts, isArtifact))
    && (value.artifactPreviews === undefined
      || isArrayOf(value.artifactPreviews, (preview) => validateArtifactPreview(preview, value.generatedAt).ok))
    && previewCollectionCorrelates(value)
    && componentInventoryCollectionCorrelates(value)
    && (value.tasks === undefined || isArrayOf(value.tasks, isTask))
    && (value.taskMessages === undefined || isArrayOf(value.taskMessages, isTaskMessage))
    && (value.taskMessageAcknowledgements === undefined || isArrayOf(value.taskMessageAcknowledgements, isTaskMessageAcknowledgement))
    && (value.sessionBindings === undefined || isArrayOf(value.sessionBindings, isHarnessSessionBinding))
    && (value.orchestratorClients === undefined || isArrayOf(value.orchestratorClients, isOrchestratorClient))
    && (value.orchestratorAttachments === undefined || isArrayOf(value.orchestratorAttachments, isOrchestratorAttachment))
    && (value.approvals === undefined || isArrayOf(value.approvals, isApprovalRequest))
    && (value.workspaceLeases === undefined || isArrayOf(value.workspaceLeases, isWorkspaceLease))
    && (value.projectProfiles === undefined || isArrayOf(value.projectProfiles, (profile) => validateProjectProfile(profile).ok))
    && (value.runActivity === undefined || isArrayOf(value.runActivity, isRunActivity))
    && isString(value.generatedAt);
}

function parseSnapshotEnvelope(data: unknown): Snapshot | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const message: unknown = JSON.parse(data);
    if (!isObject(message) || message.type !== "snapshot" || !isSnapshot(message.data)) return undefined;
    return message.data;
  } catch {
    return undefined;
  }
}

function browserEnvironment(): ConnectionEnvironment {
  return {
    fetch: (input, init) => window.fetch(input, init),
    createWebSocket: (url) => new WebSocket(url),
    isOnline: () => navigator.onLine,
    addEventListener: (type, listener) => window.addEventListener(type, listener),
    removeEventListener: (type, listener) => window.removeEventListener(type, listener),
    setTimeout: (callback, delay) => window.setTimeout(callback, delay),
    clearTimeout: (id) => window.clearTimeout(id),
    random: () => Math.random(),
    socketUrl: (token) => {
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      const query = token ? `?token=${encodeURIComponent(token)}` : "";
      return `${protocol}://${location.host}/events${query}`;
    }
  };
}

export class HubConnection {
  private snapshot = emptySnapshot;
  private status: ConnectionStatus = "connecting";
  private hasSnapshot = false;
  private generation = 0;
  private retryCount = 0;
  private timer: number | undefined;
  private socket: SocketLike | undefined;
  private abortController: AbortController | undefined;
  private started = false;

  constructor(
    private readonly token: string,
    private readonly environment: ConnectionEnvironment,
    private readonly onChange: (view: ConnectionView) => void
  ) {}

  private readonly onOffline = () => {
    if (!this.started) return;
    if (this.status === "authentication-required") return;
    this.generation += 1;
    this.clearResources();
    this.status = "disconnected";
    this.emit();
  };

  private readonly onOnline = () => {
    if (!this.started) return;
    if (this.status === "authentication-required") return;
    this.attempt();
  };

  start() {
    if (this.started) return;
    this.started = true;
    this.environment.addEventListener("online", this.onOnline);
    this.environment.addEventListener("offline", this.onOffline);
    this.emit();
    this.attempt();
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.generation += 1;
    this.clearResources();
    this.environment.removeEventListener("online", this.onOnline);
    this.environment.removeEventListener("offline", this.onOffline);
  }

  retry() {
    if (!this.started) return;
    if (!this.environment.isOnline()) {
      this.generation += 1;
      this.clearResources();
      this.status = "disconnected";
      this.emit();
      return;
    }
    this.attempt();
  }

  private emit() {
    if (!this.started) return;
    this.onChange({
      status: this.status,
      snapshot: this.snapshot,
      canMutate: this.status === "connected"
    });
  }

  private clearTimer() {
    if (this.timer === undefined) return;
    this.environment.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private clearResources() {
    this.clearTimer();
    this.abortController?.abort();
    this.abortController = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  private attempt() {
    this.generation += 1;
    const generation = this.generation;
    this.clearResources();
    if (!this.environment.isOnline()) {
      this.status = "disconnected";
      this.emit();
      return;
    }
    this.status = this.hasSnapshot ? "reconnecting" : "connecting";
    this.emit();
    const abortController = new AbortController();
    this.abortController = abortController;
    void this.environment.fetch("/api/snapshot", {
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
      signal: abortController.signal
    }).then(async (response) => {
      if (!this.isCurrent(generation)) return;
      if (response.status === 401) {
        this.abortController = undefined;
        this.status = "authentication-required";
        this.emit();
        return;
      }
      if (!response.ok) throw new Error("Snapshot request failed");
      const data: unknown = await response.json();
      if (!this.isCurrent(generation)) return;
      if (!isSnapshot(data)) throw new Error("Invalid snapshot");
      this.abortController = undefined;
      this.snapshot = data;
      this.hasSnapshot = true;
      this.emit();
      this.openSocket(generation);
    }).catch(() => {
      if (!this.isCurrent(generation)) return;
      this.abortController = undefined;
      this.status = "disconnected";
      this.emit();
      this.scheduleRetry(generation);
    });
  }

  private openSocket(generation: number) {
    if (!this.isCurrent(generation)) return;
    let socket: SocketLike;
    try {
      socket = this.environment.createWebSocket(this.environment.socketUrl(this.token));
    } catch {
      this.status = "reconnecting";
      this.emit();
      this.scheduleRetry(generation);
      return;
    }
    this.socket = socket;
    let disconnected = false;
    const disconnect = () => {
      if (disconnected || !this.isCurrent(generation) || this.socket !== socket) return;
      disconnected = true;
      this.socket = undefined;
      socket.close();
      this.status = "reconnecting";
      this.emit();
      this.scheduleRetry(generation);
    };
    socket.onopen = () => undefined;
    socket.onmessage = (event) => {
      if (!this.isCurrent(generation) || this.socket !== socket) return;
      const next = parseSnapshotEnvelope(event.data);
      if (!next) {
        disconnect();
        return;
      }
      this.snapshot = next;
      this.hasSnapshot = true;
      this.status = "connected";
      this.retryCount = 0;
      this.clearTimer();
      this.emit();
    };
    socket.onerror = disconnect;
    socket.onclose = disconnect;
  }

  private scheduleRetry(generation: number) {
    if (!this.isCurrent(generation) || !this.environment.isOnline() || this.timer !== undefined) return;
    const baseDelay = Math.min(1000 * (2 ** this.retryCount), 30000);
    const delay = Math.round(baseDelay * (0.8 + (this.environment.random() * 0.4)));
    this.retryCount += 1;
    this.timer = this.environment.setTimeout(() => {
      this.timer = undefined;
      if (this.isCurrent(generation)) this.attempt();
    }, delay);
  }

  private isCurrent(generation: number) {
    return this.started && generation === this.generation;
  }
}

export function useHubConnection(token: string): ConnectionView & { retry: () => void } {
  const [view, setView] = useState<ConnectionView>({ status: "connecting", snapshot: emptySnapshot, canMutate: false });
  const connectionRef = useRef<HubConnection | undefined>(undefined);

  useEffect(() => {
    const connection = new HubConnection(token, browserEnvironment(), setView);
    connectionRef.current = connection;
    connection.start();
    return () => {
      connection.stop();
      if (connectionRef.current === connection) connectionRef.current = undefined;
    };
  }, [token]);

  const retry = useCallback(() => connectionRef.current?.retry(), []);
  return { ...view, retry };
}
