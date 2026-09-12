import { describe, expect, it } from "vitest";
import { authModePolicy, harnessPolicy, isDocumentedHarnessAuthPair, isFreshNodeReport, NODE_REPORT_FRESHNESS_MS, releaseMatch } from "./executionPolicy.js";

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
    expect(releaseMatch("0.1.0+abc123", "0.1.0")).toEqual({ matches: false, label: "Version differs; effective policy is not verified" });
    expect(releaseMatch("0.1.0+abc123", "0.1.0+abc123")).toEqual({ matches: true, label: "Matches this documented Barista release" });
    expect(releaseMatch("0.1.0+abc123-dirty", "0.1.0+abc123-dirty")).toEqual({ matches: false, label: "Development version; effective policy is not verified" });
    expect(releaseMatch("dev", "dev")).toEqual({ matches: false, label: "Development version; effective policy is not verified" });
    expect(releaseMatch("dev+custom", "dev")).toEqual({ matches: false, label: "Development version; effective policy is not verified" });
    expect(releaseMatch("0.1.0+dev.snapshot", "0.1.0+dev.snapshot")).toEqual({ matches: false, label: "Development version; effective policy is not verified" });
    expect(releaseMatch("older", "abc123")).toEqual({ matches: false, label: "Version differs; effective policy is not verified" });
    expect(releaseMatch("", "abc123")).toEqual({ matches: false, label: "Version unavailable; effective policy is not verified" });
  });

  it("accepts only recent, parseable heartbeat timestamps", () => {
    const observedAt = Date.parse("2026-09-12T06:00:00Z");
    expect(isFreshNodeReport("2026-09-12T05:59:31Z", observedAt)).toBe(true);
    expect(isFreshNodeReport("2026-09-12T05:59:29Z", observedAt)).toBe(false);
    expect(isFreshNodeReport("2026-09-12T06:00:31Z", observedAt)).toBe(false);
    expect(isFreshNodeReport("not-a-date", observedAt)).toBe(false);
    expect(NODE_REPORT_FRESHNESS_MS).toBe(30_000);
  });
});
