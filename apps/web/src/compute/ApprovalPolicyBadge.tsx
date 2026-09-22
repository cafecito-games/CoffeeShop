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
  }
} as const;

/**
 * Marks a harness or run whose node administrator relaxed the approval policy. The policy is set
 * only in Barista's own configuration, so this is display-only; manual, absent, or unrecognized
 * values render nothing.
 */
export function ApprovalPolicyBadge({ policy }: { policy: unknown }) {
  if (policy !== "auto" && policy !== "bypass") return null;
  const { label, description, Icon } = badges[policy];
  return (
    <span className={`approval-policy-badge approval-policy-${policy}`} title={description}>
      <Icon size={11} aria-hidden="true" />{label}
    </span>
  );
}
