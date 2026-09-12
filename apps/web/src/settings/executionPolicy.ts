import type { HarnessId, HarnessProfile } from "@coffee-shop/protocol";

type AuthMode = HarnessProfile["authMode"];

interface PolicyCopy {
  label: string;
  detail: string;
  verified: boolean;
  documentedAuthMode?: AuthMode;
  documentedFlags?: string;
}

export const harnessPolicy = {
  "claude-cli": {
    label: "Claude Code",
    detail: "Barista starts the official Claude CLI directly. Prompts are not answered interactively.",
    verified: true,
    documentedAuthMode: "local-subscription",
    documentedFlags: "-p … --output-format stream-json --verbose --permission-mode auto --permission-prompts none --model …"
  },
  "codex-cli": {
    label: "Codex",
    detail: "Barista starts Codex directly with workspace-scoped writes.",
    verified: true,
    documentedAuthMode: "local-account",
    documentedFlags: "exec --json --sandbox workspace-write [--model …] …"
  },
  shell: {
    label: "Shell",
    detail: "This protocol identity is not executable by this Barista release.",
    verified: false
  },
  "ag-ui": {
    label: "AG-UI",
    detail: "This protocol identity is reserved for a future adapter and is not executable by this Barista release.",
    verified: false
  }
} satisfies Record<HarnessId, PolicyCopy>;

export const authModePolicy = {
  "local-subscription": {
    label: "Local subscription",
    detail: "Authentication is held by the vendor CLI on the compute node.",
    verified: true
  },
  "local-account": {
    label: "Local account",
    detail: "Authentication is held by the vendor CLI on the compute node.",
    verified: true
  },
  api: {
    label: "API",
    detail: "No API credential flow is implemented or verified by this Barista release.",
    verified: false
  },
  none: {
    label: "None",
    detail: "Unauthenticated execution is not verified by this Barista release.",
    verified: false
  }
} satisfies Record<AuthMode, PolicyCopy>;

export function releaseMatch(reportedVersion: unknown, documentedVersion: string): { matches: boolean; label: string } {
  if (typeof reportedVersion !== "string" || !reportedVersion.trim()) {
    return { matches: false, label: "Version unavailable; effective policy is not verified" };
  }
  if (reportedVersion === documentedVersion || documentedVersion !== "dev" && reportedVersion.startsWith(`${documentedVersion}+`)) {
    return { matches: true, label: "Matches this documented Barista release" };
  }
  return { matches: false, label: "Version differs; effective policy is not verified" };
}

export function runtimeHarnessPolicy(id: unknown): PolicyCopy {
  if (typeof id === "string" && Object.hasOwn(harnessPolicy, id)) return harnessPolicy[id as HarnessId];
  return { label: "Unrecognized harness", detail: "No execution behavior is documented or verified for this reported identity.", verified: false };
}

export function runtimeAuthModePolicy(mode: unknown): PolicyCopy {
  if (typeof mode === "string" && Object.hasOwn(authModePolicy, mode)) return authModePolicy[mode as AuthMode];
  return { label: "Unrecognized authentication", detail: "No credential handling behavior is documented or verified for this reported mode.", verified: false };
}

export function isDocumentedHarnessAuthPair(harnessId: unknown, authMode: unknown): boolean {
  return runtimeHarnessPolicy(harnessId).documentedAuthMode === authMode;
}
