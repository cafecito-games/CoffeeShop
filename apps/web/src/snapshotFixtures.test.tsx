import { readFileSync } from "node:fs";
import { join } from "node:path";
import { threadOrchestrator, type Snapshot } from "@coffee-shop/protocol";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isSnapshot } from "./hubConnection.js";
import { ApprovalsView } from "./orchestration/ApprovalsView.js";
import { SettingsView } from "./settings/SettingsView.js";
import { ThreadsView } from "./ThreadsView.js";
import { allocationHistory, currentAllocationFor, exactCurrentRuns, exactCurrentTasks, visibleInstances } from "./instances/instancePresentation.js";

/*
 * Both fixtures are bytes the hub itself publishes. `hubSnapshot.json` is what `Store.snapshot()`
 * emits from SQLite state built with the hub's own orchestration functions;
 * `legacyHubSnapshot.json` is that snapshot reduced to the fields `packages/protocol/src/index.ts`
 * declared at commit 7334091, the last commit before external orchestrators, which is what an
 * older hub publishes to this PWA. Regenerate both with
 * `scripts/generate-web-snapshot-fixtures.mts`.
 */
function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(process.cwd(), "src/test/fixtures", name), "utf8"));
}

const current = readFixture("hubSnapshot.json");
const legacy = readFixture("legacyHubSnapshot.json");
// Produced by apps/hub/test-fixtures/generate-artifact-preview-fixtures.mts through Store.snapshot().
const preview = readFixture("hubPreviewSnapshot.json");
// Produced from the Bridge packager through external Hub registration, upload claim and preparation.
const externalPreview = readFixture("hubExternalPreviewSnapshot.json");

afterEach(() => vi.useRealTimers());

function renderViews(snapshot: Snapshot) {
  render(<>
    <ThreadsView
      threads={snapshot.threads ?? []}
      runs={snapshot.runs}
      artifacts={snapshot.artifacts ?? []}
      artifactPreviews={snapshot.artifactPreviews}
      agents={snapshot.agents}
      orchestratorClients={snapshot.orchestratorClients ?? []}
      orchestratorAttachments={snapshot.orchestratorAttachments ?? []}
      canMutate
      apiFetch={vi.fn()}
      onCreate={vi.fn()}
      onContinue={vi.fn()}
      onInspectRun={vi.fn()}
      onSetStatus={vi.fn()}
    />
    <SettingsView
      connection="connected"
      nodes={snapshot.nodes}
      generatedAt={snapshot.generatedAt}
      documentedVersion="0.1.0+fixture"
      orchestratorClients={snapshot.orchestratorClients ?? []}
      canMutate
      apiFetch={vi.fn()}
    />
    <ApprovalsView
      approvals={snapshot.approvals ?? []}
      agents={snapshot.agents}
      nodes={snapshot.nodes}
      runs={snapshot.runs}
      tasks={snapshot.tasks ?? []}
      orchestratorClients={snapshot.orchestratorClients ?? []}
      canMutate
      apiFetch={vi.fn()}
    />
  </>);
}

describe("hub snapshot fixtures", () => {
  it.each([["current", current], ["legacy", legacy], ["preview", preview], ["external preview", externalPreview]])("accepts the %s hub snapshot byte-for-byte", (_name, snapshot) => {
    expect(isSnapshot(snapshot)).toBe(true);
  });

  it("never publishes a secret or its hash", () => {
    expect(JSON.stringify(current)).not.toContain("secretHash");
    expect(JSON.stringify(current)).not.toContain("csoc_");
    expect(JSON.stringify(preview)).not.toContain("previewRegistrationReceipts");
    expect(JSON.stringify(preview)).not.toContain("previewProcessingReceipts");
    expect(JSON.stringify(preview)).not.toMatch(/signedUrl|bearer|token/i);
    expect(JSON.stringify(externalPreview)).not.toMatch(/secretHash|csoc_|signedUrl|bearer|token/i);
  });

  it("carries the Hub producer's exact v5 instance triplet and inert template defaults", () => {
    const snapshot = current as Snapshot;
    expect(snapshot.instances).toHaveLength(3);
    expect(snapshot.allocations).toHaveLength(3);
    expect(snapshot.templates).toHaveLength(1);
    const active = snapshot.instances!.find((instance) => instance.status === "busy");
    const released = snapshot.instances!.find((instance) => instance.status === "released");
    const replacementPending = snapshot.instances!.find((instance) => instance.status === "requested");
    expect(active).toBeDefined();
    expect(released).toBeDefined();
    expect(replacementPending).toBeDefined();
    const activeAllocation = currentAllocationFor(active!.id, snapshot.allocations!);
    expect(activeAllocation).toMatchObject({
      kind: "current",
      allocation: { instanceId: active!.id, status: "active" }
    });
    expect(activeAllocation.kind === "current" ? activeAllocation.allocation.expectedCapabilityPack : undefined).toEqual({
      id: "coffeeshop-capability-pack", version: "1.2.0", requiredSkills: ["coffeeshop-preview"]
    });
    expect(snapshot.runs.find((run) => run.id === "run-instance-review")?.transportSelection?.effectiveCapabilityPack).toEqual({
      id: "coffeeshop-capability-pack", version: "1.2.0",
      skills: ["coffeeshop-artifacts", "coffeeshop-coordination", "coffeeshop-preview", "coffeeshop-task-reporting"]
    });
    expect(currentAllocationFor(released!.id, snapshot.allocations!)).toEqual({ kind: "unavailable" });
    expect(currentAllocationFor(replacementPending!.id, snapshot.allocations!)).toEqual({ kind: "unavailable" });
    expect(allocationHistory(released!.id, snapshot.allocations!)).toMatchObject([{ status: "released" }]);
    expect(allocationHistory(replacementPending!.id, snapshot.allocations!)).toMatchObject([{ status: "lost" }]);
    expect(visibleInstances(snapshot.instances!, false).map((instance) => instance.id)).not.toContain(released!.id);
    expect(visibleInstances(snapshot.instances!, true).map((instance) => instance.id)).toContain(released!.id);
    expect(exactCurrentRuns(active!.id, activeAllocation, snapshot.runs).map((run) => run.id)).toEqual(["run-instance-review"]);
    expect(exactCurrentTasks(active!.id, activeAllocation, snapshot.tasks ?? []).map((task) => task.title)).toEqual(["Review checkout"]);
    expect(snapshot.templates![0]).not.toHaveProperty("nodeId");
    expect(snapshot.templates![0]).not.toHaveProperty("status");
    expect(snapshot.templates![0]).not.toHaveProperty("sessionBindingId");
  });

  it("accepts the real run artifact producer's historical character-bounded metadata", () => {
    // Produced by scripts/generate-web-snapshot-fixtures.mts through Barista's canonical path shape
    // (apps/control-agent/internal/mcpserver/server.go:290-292,355), Hub createArtifact, and Store.snapshot().
    const artifact = (current as Snapshot).artifacts?.find((candidate) => candidate.idempotencyKey === "鍵".repeat(64));
    expect(artifact).toBeDefined();
    expect(artifact?.title).toBe("界".repeat(100));
    expect(artifact?.summary).toBe("é".repeat(2_000));
    expect(artifact?.mediaType).toBe(`x/${"é".repeat(64)}`);
    expect(Buffer.byteLength(artifact!.relativePath, "utf8")).toBeGreaterThan(1_024);
    expect(artifact?.relativePath).toContain("\\literal/");
    expect(Buffer.byteLength(artifact!.idempotencyKey, "utf8")).toBeGreaterThan(128);
    expect(isSnapshot(current)).toBe(true);
  });

  it("carries the Hub producer's path-free component inventory without changing legacy shape", () => {
    const snapshot = current as Snapshot;
    expect(snapshot.componentInventories).toHaveLength(1);
    expect(snapshot.componentInventories?.[0]).toMatchObject({ nodeId: "node-workshop", components: [
      { id: "claude-acp", provenance: "managed", readiness: "ready", updateVersion: "2.0.0", rollbackAvailable: true },
      { id: "coffee-shop-default", readiness: "not-applicable" }
    ] });
    expect(snapshot.componentInventories?.[0]).not.toHaveProperty("dataRoot");
    expect(JSON.stringify(snapshot.componentInventories)).not.toMatch(/componentPath|sha256|digest|url|command/i);
    expect((legacy as Snapshot).componentInventories).toBeUndefined();
  });

  it("accepts ready preview metadata exactly as the Hub projects it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T12:04:00.000Z"));
    const snapshot = preview as Snapshot;
    expect(snapshot.artifactPreviews).toHaveLength(1);
    expect(snapshot.artifactPreviews?.[0]).toMatchObject({ status: "ready", accessState: "eligible" });
    renderViews(snapshot);
    expect(screen.getByText("Ready for isolated access")).toBeInTheDocument();
    expect(screen.getByText("Site preview")).toBeInTheDocument();
  });

  it("renders externally attributed preview metadata from the real Bridge-to-Hub producer chain", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T12:04:00.000Z"));
    const snapshot = externalPreview as Snapshot;
    expect(snapshot.artifactPreviews?.[0]).toMatchObject({
      status: "ready",
      accessState: "eligible",
      sourceKey: expect.stringMatching(/^orchestrator-client:/)
    });
    renderViews(snapshot);
    expect(screen.getByText("Ready for isolated access")).toBeInTheDocument();
    expect(screen.getAllByText("Christian's laptop").length).toBeGreaterThan(0);
    expect(screen.queryByText("Agent undefined")).not.toBeInTheDocument();
  });

  it("renders external orchestration from a snapshot the hub produced", () => {
    const snapshot = current as Snapshot;
    renderViews(snapshot);
    const externalThread = (snapshot.threads ?? []).find((thread) => threadOrchestrator(thread)?.kind === "external");
    expect(externalThread).toBeDefined();
    expect(screen.getAllByText("Christian's laptop").length).toBeGreaterThan(0);
    expect(screen.getByText("Attached")).toBeInTheDocument();
    expect(screen.getByText("Retired laptop")).toBeInTheDocument();
    expect(screen.getByText("Revoked")).toBeInTheDocument();
  });

  it("renders every view from an older hub that publishes no orchestrator collections", () => {
    const snapshot = legacy as Snapshot;
    expect(snapshot.orchestratorClients).toBeUndefined();
    expect(snapshot.orchestratorAttachments).toBeUndefined();
    expect((snapshot.threads ?? []).every((thread) => thread.orchestrator === undefined)).toBe(true);

    renderViews(snapshot);

    expect(screen.getAllByText("Ship the login path").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Milo").length).toBeGreaterThan(0);
    expect(screen.getByText("No orchestrator clients")).toBeInTheDocument();
    expect(screen.queryByText("Attached")).not.toBeInTheDocument();
  });

  it("renders a thread that carries no owner agent and no orchestrator", () => {
    const snapshot = legacy as Snapshot;
    const [first] = snapshot.threads ?? [];
    renderViews({ ...snapshot, threads: [{ ...first, ownerAgentId: undefined }] });
    expect(screen.getAllByText("Unassigned").length).toBeGreaterThan(0);
  });
});
