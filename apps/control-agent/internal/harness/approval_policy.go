package harness

import "github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"

// ApprovalPolicies is the node administrator's approval policy for each harness ID, one of
// protocol.ApprovalPolicies. It comes only from Barista's own configuration; a harness without an
// entry runs under protocol.ApprovalPolicyManual, so no run, dispatch, or hub message can relax it.
type ApprovalPolicies map[string]string

// ApprovalPolicyHarnessIDs are the harnesses whose approval behavior an approval policy controls:
// the ones Barista executes, over either transport.
var ApprovalPolicyHarnessIDs = []string{"claude-cli", "codex-cli"}

// For returns the effective policy for the harness. Anything other than a recognized relaxed
// policy, including an absent entry, is manual.
func (policies ApprovalPolicies) For(harnessID string) string {
	switch policy := policies[harnessID]; policy {
	case protocol.ApprovalPolicyAuto, protocol.ApprovalPolicyBypass:
		return policy
	default:
		return protocol.ApprovalPolicyManual
	}
}

// ApprovalPolicyEffect describes, for operators, what a policy means for Coffee Shop approvals.
func ApprovalPolicyEffect(policy string) string {
	switch policy {
	case protocol.ApprovalPolicyAuto:
		return "the harness decides permission requests itself, and only requests it still escalates are sent to Coffee Shop"
	case protocol.ApprovalPolicyBypass:
		return "permission requests are not sent to Coffee Shop"
	default:
		return "every ACP permission request is sent to Coffee Shop"
	}
}

// reportedApprovalPolicy is the wire form of a policy: manual is reported by omission so that a
// manual node's inventory and run selections are unchanged for hubs that predate the field.
func reportedApprovalPolicy(policy string) string {
	if policy != protocol.ApprovalPolicyAuto && policy != protocol.ApprovalPolicyBypass {
		return ""
	}
	return policy
}

// AdvertiseApprovalPolicies records the effective approval policy on each profile in place, so the
// advertised inventory states the level every harness actually runs under.
func AdvertiseApprovalPolicies(profiles []protocol.HarnessProfile, policies ApprovalPolicies) []protocol.HarnessProfile {
	for index := range profiles {
		profiles[index].ApprovalPolicy = reportedApprovalPolicy(policies.For(profiles[index].ID))
	}
	return profiles
}
