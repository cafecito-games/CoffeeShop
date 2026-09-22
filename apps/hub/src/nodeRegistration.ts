import { isApprovalPolicy, type ComputeNode, type HarnessProfile } from "@coffee-shop/protocol";

/**
 * The node record the hub persists when a Barista registers. A harness approval policy is the node
 * administrator's declaration and is recorded exactly as reported; a value this hub does not
 * recognize is replaced by the `approvalPolicyUnrecognized` marker so it is never displayed as the
 * `manual` default.
 */
export function registeredComputeNode(reported: ComputeNode, at: string): ComputeNode {
  const harnesses = Array.isArray(reported.harnesses) ? reported.harnesses.map(registeredHarness) : [];
  return { ...reported, harnesses, status: "online", lastSeen: at };
}

function registeredHarness(harness: HarnessProfile): HarnessProfile {
  if (typeof harness !== "object" || harness === null) return harness;
  const { approvalPolicyUnrecognized: _hubOnly, approvalPolicy, ...rest } = harness;
  if (approvalPolicy === undefined) return rest;
  return isApprovalPolicy(approvalPolicy) ? { ...rest, approvalPolicy } : { ...rest, approvalPolicyUnrecognized: true };
}
