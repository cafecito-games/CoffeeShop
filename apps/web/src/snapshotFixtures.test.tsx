import { readFileSync } from "node:fs";
import { join } from "node:path";
import { threadOrchestrator, type Snapshot } from "@coffee-shop/protocol";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { isSnapshot } from "./hubConnection.js";
import { ApprovalsView } from "./orchestration/ApprovalsView.js";
import { SettingsView } from "./settings/SettingsView.js";
import { ThreadsView } from "./ThreadsView.js";
import { currentAllocationFor } from "./instances/instancePresentation.js";

/*
 * Both fixtures are bytes the hub itself publishes. `hubSnapshot.json` is what `Store.snapshot()`
 * (apps/hub/src/store.ts:499) emits for a state built with the hub's own orchestration functions;
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

function renderViews(snapshot: Snapshot) {
  render(<>
    <ThreadsView
      threads={snapshot.threads ?? []}
      runs={snapshot.runs}
      artifacts={snapshot.artifacts ?? []}
      agents={snapshot.agents}
      orchestratorClients={snapshot.orchestratorClients ?? []}
      orchestratorAttachments={snapshot.orchestratorAttachments ?? []}
      canMutate
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
  it.each([["current", current], ["legacy", legacy], ["preview", preview]])("accepts the %s hub snapshot byte-for-byte", (_name, snapshot) => {
    expect(isSnapshot(snapshot)).toBe(true);
  });

  it("never publishes a secret or its hash", () => {
    expect(JSON.stringify(current)).not.toContain("secretHash");
    expect(JSON.stringify(current)).not.toContain("csoc_");
    expect(JSON.stringify(preview)).not.toContain("previewRegistrationReceipts");
    expect(JSON.stringify(preview)).not.toContain("previewProcessingReceipts");
    expect(JSON.stringify(preview)).not.toMatch(/signedUrl|bearer|token/i);
  });

  it("carries the Hub producer's exact v5 instance triplet and inert template defaults", () => {
    const snapshot = current as Snapshot;
    expect(snapshot.instances).toHaveLength(1);
    expect(snapshot.allocations).toHaveLength(1);
    expect(snapshot.templates).toHaveLength(1);
    const instance = snapshot.instances![0];
    expect(currentAllocationFor(instance.id, snapshot.allocations!)).toMatchObject({
      kind: "current",
      allocation: { instanceId: instance.id, status: "active" }
    });
    expect(snapshot.templates![0]).not.toHaveProperty("nodeId");
    expect(snapshot.templates![0]).not.toHaveProperty("status");
    expect(snapshot.templates![0]).not.toHaveProperty("sessionBindingId");
  });

  it("accepts ready preview metadata exactly as the Hub projects it", () => {
    const snapshot = preview as Snapshot;
    expect(snapshot.artifactPreviews).toHaveLength(1);
    expect(snapshot.artifactPreviews?.[0]).toMatchObject({ status: "ready", accessState: "eligible" });
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
