import { ShieldSlash, ShieldWarning } from "@phosphor-icons/react";

const badges = {
  auto: {
    label: "Auto approvals",
    description: "The node administrator lets this harness decide its own permission requests; only requests it still escalates reach Coffee Shop approvals.",
    Icon: ShieldWarning
  },
  bypass: {
    label: "Approvals bypassed",
    description: "The node administrator disabled approval prompts for this harness; its permission requests never reach Coffee Shop approvals.",
    Icon: ShieldSlash
  },
  unrecognized: {
    label: "Unrecognized approval policy",
    description: "The node reported an approval policy this hub does not recognize; treat its permission requests as possibly never reaching Coffee Shop approvals.",
    Icon: ShieldWarning
  }
} as const;

/** The harnesses a node approval policy governs; others never show a policy. */
export const approvalPolicyHarnessIds: readonly string[] = ["claude-cli", "codex-cli"];

/** Whether a reported policy should be shown instead of the silent `manual` default. */
export function isRelaxedOrUnrecognizedPolicy(policy: unknown, unrecognized?: boolean) {
  return unrecognized === true || policy === "auto" || policy === "bypass";
}

/**
 * Marks a harness or run whose node administrator relaxed the approval policy, or whose policy the
 * hub could not recognize. The policy is set only in Barista's own configuration, so this is
 * display-only; manual or absent values render nothing.
 */
export function ApprovalPolicyBadge({ policy, unrecognized }: { policy: unknown; unrecognized?: boolean }) {
  const variant = unrecognized === true ? "unrecognized" : policy === "auto" || policy === "bypass" ? policy : undefined;
  if (!variant) return null;
  const { label, description, Icon } = badges[variant];
  return (
    <span className={`approval-policy-badge approval-policy-${variant}`} title={description}>
      <Icon size={11} aria-hidden="true" />{label}
    </span>
  );
}
