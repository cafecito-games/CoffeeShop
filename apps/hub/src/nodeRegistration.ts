import { isApprovalPolicy, type ComputeNode, type HarnessProfile } from "@coffee-shop/protocol";

/**
 * The node record the hub persists when a Barista registers. A harness approval policy is the node
 * administrator's declaration and is recorded exactly as reported; a value this hub does not
 * recognize is dropped so it can never be displayed as anything other than the `manual` default.
 */
export function registeredComputeNode(reported: ComputeNode, at: string): ComputeNode {
  const harnesses = Array.isArray(reported.harnesses) ? reported.harnesses.map(registeredHarness) : [];
  return { ...reported, harnesses, status: "online", lastSeen: at };
}

function registeredHarness(harness: HarnessProfile): HarnessProfile {
  if (typeof harness !== "object" || harness === null || harness.approvalPolicy === undefined || isApprovalPolicy(harness.approvalPolicy)) return harness;
  const { approvalPolicy: _unrecognized, ...rest } = harness;
  return rest;
}
