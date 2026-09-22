import {
  evaluateProjectReadiness,
  type ComputeNode,
  type NodeCapabilityReport,
  type ProjectProfile,
  type ProjectReadiness,
  type ProjectReadinessNodeContext
} from "@coffee-shop/protocol";

export const defaultEvidenceTTLMilliseconds = 30 * 60 * 1000;

/**
 * A deliberately coarse placeholder for the mandatory lower-level workspace-root authorization
 * check this issue requires. It confirms the node has at least one canonical authorized
 * workspace root at all, and — when the profile requires a writable workspace — that the node's
 * most recent capability report includes successful "workspace-writable" runtime evidence. It
 * does NOT bind a specific repository identity to a specific root; that binding is dispatch-time
 * work owned by sibling issues (workspace leases). It never expands authorization: a node with
 * zero configured workspace roots is never authorized for any project, regardless of profile
 * content, and a missing capability report with a requireWritable profile is never authorized.
 */
export function workspaceAuthorizedForProject(
  node: ComputeNode,
  report: NodeCapabilityReport | undefined,
  profile: ProjectProfile
): boolean {
  if (node.workspaceRoots.length === 0) return false;
  if (!profile.workspacePolicy.requireWritable) return true;
  return (report?.evidence ?? []).some(
    (entry) => entry.capabilityId === "workspace-writable" && entry.success === true
  );
}

export function computeNodeProjectReadiness(
  node: ComputeNode,
  report: NodeCapabilityReport | undefined,
  profile: ProjectProfile,
  nowIso: string,
  evidenceTTLMilliseconds: number = defaultEvidenceTTLMilliseconds
): ProjectReadiness {
  const context: ProjectReadinessNodeContext = {
    nodeId: node.id,
    harnesses: node.harnesses,
    projectAllowlist: report?.projectAllowlist,
    evidence: report?.evidence ?? [],
    workspaceAuthorized: workspaceAuthorizedForProject(node, report, profile)
  };
  return evaluateProjectReadiness(profile, context, evidenceTTLMilliseconds, nowIso);
}
