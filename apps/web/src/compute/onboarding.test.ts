import { nodeKinds } from "@coffee-shop/protocol";
import { describe, expect, it } from "vitest";
import { BARISTA_ENVIRONMENT_FIELDS, buildBaristaCommand, defaultControlEndpoint, validateOnboarding, type OnboardingValues } from "./onboarding.js";

const valid: OnboardingValues = {
  controlEndpoint: "https://coffee.example.com",
  name: "Desk Barista",
  nodeId: "desk-one",
  kind: "local",
  concurrency: "2",
  workspaceRoots: "/Users/me/Code\n/Users/me/Notes"
};

describe("Barista onboarding configuration", () => {
  it("uses configured, development, and production endpoint precedence", () => {
    expect(defaultControlEndpoint("https://configured.example", true, "http://localhost:5173")).toBe("https://configured.example");
    expect(defaultControlEndpoint("", true, "http://localhost:5173")).toBe("http://localhost:8787");
    expect(defaultControlEndpoint(undefined, false, "https://coffee.example")).toBe("https://coffee.example");
  });

  it("defines every current Barista environment field and every protocol kind", () => {
    expect(BARISTA_ENVIRONMENT_FIELDS).toEqual([
      "CONTROL_ENDPOINT", "BARISTA_NAME", "BARISTA_ID", "BARISTA_KIND",
      "BARISTA_CONCURRENCY", "WORKSPACE_ROOTS", "COFFEE_SHOP_TOKEN"
    ]);
    expect(nodeKinds).toEqual(["local", "home-server", "cloud"]);
  });

  it("quotes operator input and always uses the literal safe token placeholder", () => {
    const command = buildBaristaCommand({ ...valid, name: "Desk'; touch /tmp/nope; echo '" });
    expect(command).toContain("BARISTA_NAME='Desk'\"'\"'; touch /tmp/nope; echo '\"'\"'' \\");
    expect(command).toContain("COFFEE_SHOP_TOKEN='replace-with-hub-token' \\");
    expect(command).toContain("WORKSPACE_ROOTS='/Users/me/Code,/Users/me/Notes' \\");
    expect(command.endsWith("./bin/barista")).toBe(true);
    expect(buildBaristaCommand(valid)).toBe(buildBaristaCommand(valid));
  });

  it.each([
    [{ ...valid, controlEndpoint: "ws://coffee.example" }, "Use an HTTP or HTTPS hub URL."],
    [{ ...valid, controlEndpoint: "not a url" }, "Use an HTTP or HTTPS hub URL."],
    [{ ...valid, name: "  " }, "Enter a Barista name."],
    [{ ...valid, nodeId: "Bad ID" }, "Use a lowercase ID containing only letters, numbers, and hyphens."],
    [{ ...valid, kind: "edge" as OnboardingValues["kind"] }, "Choose a supported compute kind."],
    [{ ...valid, concurrency: "0" }, "Concurrency must be a positive integer."],
    [{ ...valid, concurrency: "1.5" }, "Concurrency must be a positive integer."],
    [{ ...valid, workspaceRoots: "relative/path" }, "Every workspace root must be absolute."],
    [{ ...valid, workspaceRoots: "/srv/intended,/" }, "Workspace roots cannot contain commas."],
    [{ ...valid, workspaceRoots: "" }, "Enter at least one absolute workspace root."]
  ])("fails closed for invalid configuration", (values, message) => {
    expect(validateOnboarding(values)).toContain(message);
  });
});
