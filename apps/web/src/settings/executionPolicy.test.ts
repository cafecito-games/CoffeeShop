import { describe, expect, it } from "vitest";
import { authModePolicy, harnessPolicy, isDocumentedHarnessAuthPair, releaseMatch } from "./executionPolicy.js";

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

  it("accepts only the auth mode documented for each executable harness", () => {
    expect(isDocumentedHarnessAuthPair("claude-cli", "local-subscription")).toBe(true);
    expect(isDocumentedHarnessAuthPair("codex-cli", "local-account")).toBe(true);
    expect(isDocumentedHarnessAuthPair("claude-cli", "local-account")).toBe(false);
    expect(isDocumentedHarnessAuthPair("codex-cli", "local-subscription")).toBe(false);
    expect(isDocumentedHarnessAuthPair("future-harness", "local-account")).toBe(false);
  });

  it("fails closed for unknown runtime values and version mismatches", () => {
    expect(harnessPolicy["future-harness" as keyof typeof harnessPolicy]).toBeUndefined();
    expect(authModePolicy["future-auth" as keyof typeof authModePolicy]).toBeUndefined();
    expect(releaseMatch("abc123", "abc123")).toEqual({ matches: true, label: "Matches this documented Barista release" });
    expect(releaseMatch("0.1.0+abc123", "0.1.0")).toEqual({ matches: true, label: "Matches this documented Barista release" });
    expect(releaseMatch("dev+custom", "dev")).toEqual({ matches: false, label: "Version differs; effective policy is not verified" });
    expect(releaseMatch("older", "abc123")).toEqual({ matches: false, label: "Version differs; effective policy is not verified" });
    expect(releaseMatch("", "abc123")).toEqual({ matches: false, label: "Version unavailable; effective policy is not verified" });
  });
});
