import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  acpAdapterNameMaximumBytes,
  acpAdapterSources,
  canSendToControlAgent,
  requiredCapabilityForHubMessage,
  transportFallbackReasons,
  transportNativeFallbackWarning,
  validateRunTransportSelection
} from "../dist/index.js";

const at = "2026-09-21T12:00:00Z";
const fixtureDirectory = new URL("./fixtures/control-v4/", import.meta.url);
const readFixture = (name) => JSON.parse(readFileSync(new URL(name, fixtureDirectory), "utf8"));

const acpCapabilities = () => ({
  protocolVersion: 1,
  loadSession: true,
  resumeSession: true,
  prompt: { image: true, audio: false, embeddedContext: true },
  mcp: { http: true, sse: false }
});

const acpSelection = () => ({
  requestedTransport: "acp-v1",
  selectedTransport: "acp-v1",
  adapter: { id: "codex-acp", version: "1.12.0", source: "setup-ledger" },
  acp: acpCapabilities()
});

const nativeSelection = () => ({ requestedTransport: "native-cli", selectedTransport: "native-cli" });

const fallbackSelection = (reason) => ({
  requestedTransport: "acp-v1",
  selectedTransport: "native-cli",
  fallbackReason: reason,
  adapter: { id: "codex-acp", version: "1.12.0", source: "administrator-override" }
});

test("transport vocabularies keep their exact contents", () => {
  assert.deepEqual(transportFallbackReasons, [
    "acp-adapter-unavailable",
    "acp-protocol-incompatible",
    "acp-capability-missing",
    "acp-mcp-unavailable"
  ]);
  assert.deepEqual(acpAdapterSources, ["setup-ledger", "administrator-override"]);
  assert.equal(transportNativeFallbackWarning, "transport-native-fallback");
  assert.equal(acpAdapterNameMaximumBytes, 128);
});

test("the run-started fixtures' transport selections validate and round-trip unchanged", () => {
  for (const name of ["run-started-acp.json", "run-started-native-fallback.json"]) {
    const fixture = readFixture(name);
    const result = validateRunTransportSelection(fixture.transport);
    assert.equal(result.ok, true, `${name} transport must validate: ${result.ok ? "" : result.reason}`);
    assert.deepEqual(result.value, fixture.transport, `${name} transport round-trips unchanged`);
  }
});

test("well-formed selections validate", () => {
  const accepted = [
    ["native selection without extras", nativeSelection()],
    ["native selection with harness version", { ...nativeSelection(), harnessVersion: "0.154.0" }],
    ...transportFallbackReasons.map((reason) => [`fallback for ${reason}`, fallbackSelection(reason)])
  ];
  for (const [label, value] of accepted) {
    const result = validateRunTransportSelection(value);
    assert.equal(result.ok, true, `${label} must validate: ${result.ok ? "" : result.reason}`);
    assert.deepEqual(result.value, value, label);
  }
});

test("malformed selections are rejected", () => {
  const negatives = [
    ["null", null],
    ["string", "acp-v1"],
    ["array", [nativeSelection()]],
    ["undeclared key", { ...nativeSelection(), surprise: "nope" }],
    ["unknown transport", { ...nativeSelection(), requestedTransport: "grpc" }],
    ["missing selected transport", { requestedTransport: "native-cli" }],
    ["fallback reason with equal transports", { ...nativeSelection(), fallbackReason: "acp-adapter-unavailable" }],
    ["native to acp", { requestedTransport: "native-cli", selectedTransport: "acp-v1", fallbackReason: "acp-adapter-unavailable" }],
    ["acp to native without a reason", { requestedTransport: "acp-v1", selectedTransport: "native-cli" }],
    ["acp to native with an unknown reason", { ...fallbackSelection("acp-adapter-unavailable"), fallbackReason: "adapter-crashed" }],
    ["non-normalized harness version", { ...nativeSelection(), harnessVersion: "1.02" }],
    ["adapter with an uppercase id", { ...acpSelection(), adapter: { id: "Codex-ACP", version: "1.12.0", source: "setup-ledger" } }],
    ["adapter id over 64 bytes", { ...acpSelection(), adapter: { id: "a".repeat(65), version: "1.12.0", source: "setup-ledger" } }],
    ["adapter with a pre-release version", { ...acpSelection(), adapter: { id: "codex-acp", version: "1.2.3-beta", source: "setup-ledger" } }],
    ["adapter with an unknown source", { ...acpSelection(), adapter: { id: "codex-acp", version: "1.12.0", source: "vendor" } }],
    ["adapter with an extra key", { ...acpSelection(), adapter: { id: "codex-acp", version: "1.12.0", source: "setup-ledger", checksum: "abc" } }],
    ["acp capabilities on a native selection", { ...nativeSelection(), acp: acpCapabilities() }],
    ["acp with protocolVersion 2", { ...acpSelection(), acp: { ...acpCapabilities(), protocolVersion: 2 } }],
    ["acp missing loadSession", { ...acpSelection(), acp: (({ loadSession: _loadSession, ...rest }) => rest)(acpCapabilities()) }],
    ["acp with an extra key", { ...acpSelection(), acp: { ...acpCapabilities(), streaming: true } }],
    ["acp with a non-boolean mcp.http", { ...acpSelection(), acp: { ...acpCapabilities(), mcp: { http: "yes", sse: false } } }],
    ["acp with a secret-like adapterName", { ...acpSelection(), acp: { ...acpCapabilities(), adapterName: "sk-abcdefghijklmnop123456" } }],
    ["acp with an adapterName over the byte bound counted in UTF-8", {
      ...acpSelection(),
      acp: { ...acpCapabilities(), adapterName: "é".repeat(65) }
    }],
    ["acp with a non-normalized adapterVersion", { ...acpSelection(), acp: { ...acpCapabilities(), adapterVersion: "latest" } }]
  ];
  for (const [label, value] of negatives) {
    const result = validateRunTransportSelection(value);
    assert.equal(result.ok, false, `${label} must be rejected`);
    assert.equal(typeof result.reason, "string", `${label} must report a reason`);
  }
});

test("dispatch carrying a fallback transport requires orchestration even without task or transport fields", () => {
  const plainRun = {
    id: "run-one", agentId: "agent-one", nodeId: "node-one", harnessId: "codex-cli", model: "default",
    workspace: "/workspace", prompt: "Build it", status: "queued", output: "", depth: 0, createdAt: at
  };
  const agent = {
    id: "agent-one", name: "Milo", title: "Builder", summary: "Builds", glyph: "M",
    avatarShape: "cup", avatarColor: "amber", state: "working", currentAction: "Working",
    harnessId: "codex-cli", model: "gpt-5", computeNodeId: "node-one", workspace: "/workspace",
    systemPrompt: "Build", unread: 0, updatedAt: at
  };
  const dispatch = { type: "dispatch", run: { ...plainRun, fallbackTransport: "native-cli" }, agent };
  assert.equal(requiredCapabilityForHubMessage(dispatch), "orchestration");

  const fixture = readFixture("dispatch-acp-fallback.json");
  assert.equal(canSendToControlAgent(fixture, "4"), true, "fixture must be sendable to version 4");
  assert.equal(canSendToControlAgent(fixture, "3"), false, "fixture must not be sendable to version 3");
});
