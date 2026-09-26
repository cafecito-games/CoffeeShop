import type {
  ApprovalOptionKind, ApprovalStatus, PlacementRequirementKind, TaskMessageKind, TaskStatus,
  ToolCallKind, ToolCallStatus, WorkspaceLeaseStatus, WorkspaceRetentionReason
} from "@coffee-shop/protocol";

export const taskStatusLabels: Record<TaskStatus, string> = {
  pending: "Pending",
  ready: "Ready",
  assigned: "Assigned",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  blocked: "Blocked"
};

export const placementRequirementLabels: Record<PlacementRequirementKind, string> = {
  skill: "Skill",
  harness: "Harness",
  model: "Model",
  transport: "Transport",
  "operating-system": "Operating system",
  architecture: "Architecture",
  label: "Label",
  concurrency: "Concurrency",
  memory: "Memory",
  "project-profile": "Project profile",
  workspace: "Workspace",
  "node-offline": "Node offline",
  "inventory-stale": "Inventory stale",
  agent: "Agent",
  capacity: "Capacity",
  "protocol-version": "Protocol version",
  assignment: "Assignment",
  offering: "Offering",
  template: "Template",
  instance: "Instance",
  "resident-capacity": "Resident capacity"
};

export const approvalStatusLabels: Record<ApprovalStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  cancelled: "Cancelled",
  expired: "Expired"
};

export const approvalOptionKindLabels: Record<ApprovalOptionKind, string> = {
  "allow-once": "Allow once",
  "allow-always": "Allow always",
  "reject-once": "Reject once",
  "reject-always": "Reject always"
};

export const workspaceLeaseStatusLabels: Record<WorkspaceLeaseStatus, string> = {
  requested: "Requested",
  provisioning: "Provisioning",
  active: "Active",
  released: "Released",
  cleaning: "Cleaning",
  retained: "Retained",
  cleaned: "Cleaned",
  failed: "Failed"
};

export const workspaceRetentionReasonLabels: Record<WorkspaceRetentionReason, string> = {
  dirty: "Uncommitted changes",
  untracked: "Untracked files",
  diverged: "Diverged from base",
  locked: "Locked",
  unregistered: "Unregistered checkout",
  "identity-mismatch": "Repository identity mismatch",
  ambiguous: "Ambiguous state",
  "operator-hold": "Held by operator",
  policy: "Retained by policy"
};

export const taskMessageKindLabels: Record<TaskMessageKind, string> = {
  question: "Question",
  answer: "Answer",
  instruction: "Instruction",
  progress: "Progress",
  result: "Result",
  note: "Note"
};

export const toolCallStatusLabels: Record<ToolCallStatus, string> = {
  pending: "Pending",
  "in-progress": "In progress",
  completed: "Completed",
  failed: "Failed"
};

export const toolCallKindLabels: Record<ToolCallKind, string> = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  execute: "Execute",
  think: "Think",
  fetch: "Fetch",
  other: "Other"
};

export function timeAgo(date: string) {
  const seconds = Math.max(1, Math.round((Date.now() - new Date(date).getTime()) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Formats a future timestamp such as an approval's expiry, distinct from `timeAgo`'s past-only wording. */
export function timeUntil(date: string) {
  const seconds = Math.max(1, Math.round((new Date(date).getTime() - Date.now()) / 1000));
  if (seconds < 60) return "less than a minute";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function participantLabel(participant: { type: "task"; taskId: string } | { type: "orchestrator" } | { type: "operator" }, taskTitle?: string): string {
  if (participant.type === "task") return taskTitle ?? `Task ${participant.taskId}`;
  if (participant.type === "orchestrator") return "Orchestrator";
  return "Operator";
}
