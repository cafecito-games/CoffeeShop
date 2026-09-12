import { describe, expect, it } from "vitest";
import { authModePolicy, harnessPolicy, releaseMatch } from "./executionPolicy.js";

describe("execution policy copy", () => {
  it("maps every protocol harness deliberately", () => {
    expect(Object.keys(harnessPolicy).sort()).toEqual(["ag-ui", "claude-cli", "codex-cli", "shell"]);
    expect(harnessPolicy["claude-cli"].documentedFlags).toContain("--permission-mode auto");
    expect(harnessPolicy["codex-cli"].documentedFlags).toContain("--sandbox workspace-write");
    expect(harnessPolicy.shell.verified).toBe(false);
    expect(harnessPolicy["ag-ui"].verified).toBe(false);
  });

  it("maps every auth mode without reassuring fallbacks", () => {
    expect(Object.keys(authModePolicy).sort()).toEqual(["api", "local-account", "local-subscription", "none"]);
    expect(authModePolicy.api.verified).toBe(false);
    expect(authModePolicy.none.verified).toBe(false);
  });

  it("fails closed for unknown runtime values and version mismatches", () => {
    expect(harnessPolicy["future-harness" as keyof typeof harnessPolicy]).toBeUndefined();
    expect(authModePolicy["future-auth" as keyof typeof authModePolicy]).toBeUndefined();
    expect(releaseMatch("abc123", "abc123")).toEqual({ matches: true, label: "Matches this documented Barista release" });
    expect(releaseMatch("older", "abc123")).toEqual({ matches: false, label: "Version differs; effective policy is not verified" });
    expect(releaseMatch("", "abc123")).toEqual({ matches: false, label: "Version unavailable; effective policy is not verified" });
  });
});
