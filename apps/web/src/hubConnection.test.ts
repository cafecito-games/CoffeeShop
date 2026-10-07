import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Snapshot } from "@coffee-shop/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  HubConnection,
  isSnapshot,
  type ConnectionEnvironment,
  type ConnectionView
} from "./hubConnection.js";

const snapshot = (generatedAt: string): Snapshot => ({
  agents: [],
  nodes: [],
  runs: [],
  events: [],
  messages: [],
  generatedAt
});

const v5Triplet = {
  instances: [{
    id: "instance-one", threadId: "thread-one", creator: { kind: "operator" as const, operatorId: "operator" },
    purpose: { name: "Reviewer" }, delegation: { canDelegate: false }, requirements: {},
    lease: { idleTimeoutSeconds: 1800, expiresAt: "2026-01-01T00:30:00Z" }, status: "ready" as const,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z"
  }],
  allocations: [{
    id: "allocation-one", instanceId: "instance-one", nodeId: "node-one", harnessId: "codex-cli" as const,
    model: "default", transport: "native-cli" as const, workspace: "/workspace",
    lease: { idleTimeoutSeconds: 1800, expiresAt: "2026-01-01T00:30:00Z" }, status: "active" as const,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z"
  }],
  templates: [{ id: "template-reviewer", name: "Reviewer", delegation: { canDelegate: false } }]
};

const inventoryNode = {
  id: "node-one", name: "Node", kind: "local", platform: "linux-amd64", status: "online",
  lastSeen: "2026-09-28T12:00:00Z", activeRuns: 0, concurrency: 1, workspaceRoots: ["/workspace"],
  harnesses: [], version: "test"
};
const componentInventory = {
  nodeId: "node-one", observedAt: "2026-09-28T12:00:00Z", components: [{
    kind: "harness", id: "codex-cli", harnessId: "codex-cli", declaredVersion: "1.2.3",
    installedVersions: [], provenance: "external", readiness: "ready", rollbackAvailable: false, diagnosticCodes: []
  }]
};

class FakeSocket {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  close = vi.fn();

  message(value: unknown) {
    this.onmessage?.({ data: typeof value === "string" ? value : JSON.stringify(value) } as MessageEvent);
  }
}

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(fetchImpl: ConnectionEnvironment["fetch"], random = () => 0.5) {
  const sockets: FakeSocket[] = [];
  const socketUrls: string[] = [];
  const timers = new Map<number, () => void>();
  const delays: number[] = [];
  const listeners = new Map<string, Set<() => void>>();
  let timerId = 0;
  let online = true;
  const environment: ConnectionEnvironment = {
    fetch: fetchImpl,
    createWebSocket: (url) => {
      const socket = new FakeSocket();
      sockets.push(socket);
      socketUrls.push(url);
      return socket;
    },
    isOnline: () => online,
    addEventListener: (type, listener) => {
      const group = listeners.get(type) ?? new Set();
      group.add(listener);
      listeners.set(type, group);
    },
    removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
    setTimeout: (callback, delay) => {
      const id = ++timerId;
      timers.set(id, callback);
      delays.push(delay);
      return id;
    },
    clearTimeout: (id) => { timers.delete(id); },
    random,
    socketUrl: (token) => `ws://example.test/events?token=${encodeURIComponent(token)}`
  };
  return {
    environment,
    sockets,
    socketUrls,
    timers,
    delays,
    setOnline(value: boolean) { online = value; },
    dispatch(type: "online" | "offline") { for (const listener of listeners.get(type) ?? []) listener(); },
    runTimer() {
      const entry = timers.entries().next().value as [number, () => void] | undefined;
      if (!entry) throw new Error("No pending timer");
      timers.delete(entry[0]);
      entry[1]();
    }
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("snapshot validation", () => {
  it("accepts a complete snapshot and rejects malformed nested records", () => {
    expect(isSnapshot(snapshot("rest"))).toBe(true);
    expect(isSnapshot({ ...snapshot("bad"), agents: [{}] })).toBe(false);
    expect(isSnapshot({ ...snapshot("bad"), nodes: [{ id: "node" }] })).toBe(false);
    expect(isSnapshot({ ...snapshot("bad"), messages: [{ author: "intruder" }] })).toBe(false);
    expect(isSnapshot({ ...snapshot("bad"), generatedAt: 42 })).toBe(false);
  });

  it("preserves well-formed unknown harness and authentication strings for fail-closed presentation", () => {
    const node = {
      id: "future-node", name: "Future", kind: "local", platform: "linux", status: "online",
      lastSeen: "now", activeRuns: 0, concurrency: 1, workspaceRoots: ["/srv/workspaces"], version: "custom",
      harnesses: [{ id: "future-harness", label: "Future", description: "External adapter", available: true, authMode: "future-auth", models: [] }]
    };
    expect(isSnapshot({ ...snapshot("future"), nodes: [node] })).toBe(true);
    expect(isSnapshot({ ...snapshot("bad"), nodes: [{ ...node, harnesses: [{ ...node.harnesses[0], authMode: 42 }] }] })).toBe(false);
  });

  it("accepts every preview status and rejects a malformed present preview collection as a whole", () => {
    const generatedAt = "2026-09-27T12:04:00.000Z";
    const base = {
      id: "preview-one", artifactId: "artifact-one", artifactSha256: "a".repeat(64),
      threadId: "thread-one", runId: "run-one", agentId: "agent-one", entrypoint: "site/index.html",
      processingGeneration: 1, createdAt: "2026-09-27T12:00:00.000Z",
      updatedAt: "2026-09-27T12:02:00.000Z", expiresAt: "2026-09-28T12:00:00.000Z",
      accessState: "unavailable"
    };
    const byStatus = {
      "upload-pending": { ...base, processingGeneration: 0, updatedAt: base.createdAt },
      processing: { ...base },
      ready: { ...base, readyAt: base.updatedAt, accessState: "eligible" },
      failed: { ...base, failedAt: base.updatedAt, failureCode: "bundle-invalid" },
      expired: {
        ...base, updatedAt: base.expiresAt, expiredAt: base.expiresAt
      }
    };
    const artifact = {
      id: "artifact-one", threadId: "thread-one", runId: "run-one", agentId: "agent-one",
      relativePath: ".coffee-shop/previews/site.tar.gz", title: "Preview", kind: "preview-bundle",
      mediaType: "application/vnd.coffee-shop.preview-bundle+tar+gzip", summary: "", size: 512,
      sha256: "a".repeat(64), downloadPath: "/api/artifacts/artifact-one/content", uploaded: true,
      idempotencyKey: "preview-one", createdAt: base.createdAt
    };
    for (const [status, preview] of Object.entries(byStatus)) {
      const correlatedArtifact = status === "upload-pending" ? { ...artifact, uploaded: false } : artifact;
      expect(isSnapshot({ ...snapshot(generatedAt), artifacts: [correlatedArtifact], artifactPreviews: [{ ...preview, status }] })).toBe(true);
    }

    const ready = { ...byStatus.ready, status: "ready" };
    for (const collection of [
      null,
      {},
      [{ ...ready, status: "published" }],
      [{ ...ready, accessState: "unavailable" }],
      [{ ...ready, processingGeneration: 0 }],
      [{ ...ready, readyAt: undefined }],
      [{ ...ready, agentId: undefined }],
      [{ ...ready, entrypoint: "../index.html" }],
      [{ ...ready, signedUrl: "https://preview.invalid/secret" }],
      [{ ...ready, token: "secret" }]
    ]) {
      expect(isSnapshot({ ...snapshot(generatedAt), artifacts: [artifact], artifactPreviews: collection })).toBe(false);
    }
    expect(isSnapshot({ ...snapshot(generatedAt), artifactPreviews: undefined })).toBe(true);
  });

  it("accepts the Hub producer's unuploaded registration and generation-zero terminal projections only", () => {
    // These exact artifact/preview bytes are regenerated and byte-checked by apps/hub/src/hubTools.test.ts.
    const produced = JSON.parse(readFileSync(join(process.cwd(), "../../packages/protocol/test/fixtures/hub-tools/publish-preview-created.json"), "utf8")) as {
      artifact: Record<string, unknown>;
      preview: Record<string, unknown>;
    };
    const registered = {
      ...snapshot("2026-09-27T12:01:00.000Z"),
      artifacts: [produced.artifact],
      artifactPreviews: [produced.preview]
    };
    expect(isSnapshot(registered)).toBe(true);

    const failed = {
      ...produced.preview,
      status: "failed",
      updatedAt: "2026-09-27T12:01:00.000Z",
      failedAt: "2026-09-27T12:01:00.000Z",
      failureCode: "upload-failed"
    };
    expect(isSnapshot({ ...registered, artifactPreviews: [failed] })).toBe(true);
    expect(isSnapshot({ ...registered, artifactPreviews: [{ ...failed, failureCode: "bundle-invalid" }] })).toBe(true);

    const expired = {
      ...produced.preview,
      status: "expired",
      updatedAt: produced.preview.expiresAt,
      expiredAt: produced.preview.expiresAt
    };
    expect(isSnapshot({
      ...registered,
      generatedAt: produced.preview.expiresAt,
      artifactPreviews: [expired]
    })).toBe(true);

    for (const invalid of [
      { ...produced.preview, status: "processing", processingGeneration: 1, updatedAt: "2026-09-27T12:01:00.000Z" },
      { ...failed, processingGeneration: 1 },
      { ...expired, processingGeneration: 1 },
      { ...produced.preview, artifactSha256: "b".repeat(64) }
    ]) expect(isSnapshot({ ...registered, artifactPreviews: [invalid] })).toBe(false);
  });

  it("rejects duplicate and cross-linked preview records as one snapshot update", () => {
    const generatedAt = "2026-09-27T12:04:00.000Z";
    const artifact = {
      id: "artifact-one", threadId: "thread-one", runId: "run-one", agentId: "agent-one",
      relativePath: ".coffee-shop/previews/site.tar.gz", title: "Preview", kind: "preview-bundle",
      mediaType: "application/vnd.coffee-shop.preview-bundle+tar+gzip", summary: "", size: 512,
      sha256: "a".repeat(64), downloadPath: "/api/artifacts/artifact-one/content", uploaded: true,
      idempotencyKey: "preview-one", createdAt: "2026-09-27T12:00:00.000Z"
    };
    const preview = {
      id: "preview-one", artifactId: artifact.id, artifactSha256: artifact.sha256,
      threadId: artifact.threadId, runId: artifact.runId, agentId: artifact.agentId,
      entrypoint: "site/index.html", status: "ready", processingGeneration: 1,
      createdAt: artifact.createdAt, updatedAt: "2026-09-27T12:02:00.000Z",
      expiresAt: "2026-09-28T12:00:00.000Z", readyAt: "2026-09-27T12:02:00.000Z",
      accessState: "eligible"
    };
    const value = { ...snapshot(generatedAt), artifacts: [artifact], artifactPreviews: [preview] };
    expect(isSnapshot(value)).toBe(true);
    expect(isSnapshot({ ...value, artifactPreviews: [preview, preview] })).toBe(false);
    expect(isSnapshot({ ...value, artifactPreviews: [preview, { ...preview, id: "preview-two" }] })).toBe(false);
    for (const changed of [
      { artifacts: [] },
      { artifacts: [{ ...artifact, uploaded: false }] },
      { artifacts: [{ ...artifact, sha256: "b".repeat(64) }] },
      { artifacts: [{ ...artifact, threadId: "thread-two" }] },
      { artifacts: [{ ...artifact, runId: "run-two" }] },
      { artifacts: [{ ...artifact, agentId: undefined, instanceId: "instance-one", allocationId: "allocation-one" }] }
    ]) expect(isSnapshot({ ...value, ...changed })).toBe(false);

    const instanceArtifact = { ...artifact, agentId: undefined, instanceId: "instance-one", allocationId: "allocation-one" };
    const instancePreview = { ...preview, agentId: undefined, instanceId: "instance-one", allocationId: "allocation-one" };
    expect(isSnapshot({ ...value, artifacts: [instanceArtifact], artifactPreviews: [instancePreview] })).toBe(true);
  });

  it("accepts one exact external preview source and rejects cross-client or mixed attribution", () => {
    const generatedAt = "2026-09-27T12:04:00.000Z";
    const sourceKey = "orchestrator-client:client-one";
    const artifact = {
      id: "artifact-external", threadId: "thread-external", sourceKey,
      relativePath: "dist", title: "External preview", kind: "preview-bundle",
      mediaType: "application/vnd.coffee-shop.preview-bundle+tar+gzip", summary: "", size: 512,
      sha256: "c".repeat(64), downloadPath: "/api/artifacts/artifact-external/content", uploaded: true,
      idempotencyKey: "external-preview", createdAt: "2026-09-27T12:00:00.000Z"
    };
    const preview = {
      id: "preview-external", artifactId: artifact.id, artifactSha256: artifact.sha256,
      threadId: artifact.threadId, sourceKey, entrypoint: "index.html", status: "ready",
      processingGeneration: 1, createdAt: artifact.createdAt, updatedAt: "2026-09-27T12:02:00.000Z",
      expiresAt: "2026-09-28T12:00:00.000Z", readyAt: "2026-09-27T12:02:00.000Z", accessState: "eligible"
    };
    const value = { ...snapshot(generatedAt), artifacts: [artifact], artifactPreviews: [preview] };
    expect(isSnapshot(value)).toBe(true);
    expect(isSnapshot({ ...value, artifactPreviews: [{ ...preview, sourceKey: "orchestrator-client:client-two" }] })).toBe(false);
    expect(isSnapshot({ ...value, artifactPreviews: [{ ...preview, runId: "run-one", agentId: "agent-one" }] })).toBe(false);
  });

  it("accepts preview-bundle artifact metadata in the shared artifact vocabulary", () => {
    const artifact = {
      id: "artifact-one", threadId: "thread-one", runId: "run-one", agentId: "agent-one",
      relativePath: ".coffee-shop/previews/site.tar.gz", title: "Preview", kind: "preview-bundle",
      mediaType: "application/vnd.coffee-shop.preview-bundle+tar+gzip", summary: "", size: 512,
      sha256: "a".repeat(64), downloadPath: "/api/artifacts/artifact-one/content", uploaded: true,
      idempotencyKey: "preview-one", createdAt: "2026-09-27T12:00:00.000Z"
    };
    expect(isSnapshot({ ...snapshot("2026-09-27T12:04:00.000Z"), artifacts: [artifact] })).toBe(true);
    expect(isSnapshot({ ...snapshot("2026-09-27T12:04:00.000Z"), artifacts: [{ ...artifact, kind: "preview-site" }] })).toBe(false);
  });

  it("accepts exactly one canonical artifact producer and rejects mixed or missing identities", () => {
    const base = {
      id: "artifact-one", threadId: "thread-one", relativePath: "report.txt", title: "Report", kind: "report",
      mediaType: "text/plain", summary: "Ready", size: 5, sha256: "a".repeat(64),
      downloadPath: "/api/artifacts/artifact-one/content", uploaded: true, idempotencyKey: "report-one",
      createdAt: "2026-09-28T12:00:00.000Z"
    };
    const runArtifact = { ...base, runId: "run-one", agentId: "agent-one" };
    const externalArtifact = { ...base, sourceKey: "orchestrator-client:client-one" };
    expect(isSnapshot({ ...snapshot("now"), artifacts: [runArtifact] })).toBe(true);
    expect(isSnapshot({ ...snapshot("now"), artifacts: [{ ...runArtifact, sourceKey: "run:run-one" }] })).toBe(true);
    expect(isSnapshot({ ...snapshot("now"), artifacts: [externalArtifact] })).toBe(true);
    for (const artifact of [
      base,
      { ...externalArtifact, runId: "run-one" },
      { ...externalArtifact, agentId: "agent-one" },
      { ...runArtifact, sourceKey: "orchestrator-client:client-one" },
      { ...runArtifact, sourceKey: "run:another" },
      { ...runArtifact, agentId: undefined },
      { ...runArtifact, instanceId: "instance-one", allocationId: "allocation-one" }
    ]) expect(isSnapshot({ ...snapshot("now"), artifacts: [artifact] })).toBe(false);
  });

  it("accepts the v5 triplet only when every collection is present and every entry is valid", () => {
    expect(isSnapshot({ ...snapshot("v5"), ...v5Triplet })).toBe(true);
    expect(isSnapshot(snapshot("legacy"))).toBe(true);
    for (const partial of [
      { instances: v5Triplet.instances },
      { allocations: v5Triplet.allocations },
      { templates: v5Triplet.templates },
      { instances: v5Triplet.instances, allocations: v5Triplet.allocations },
      { instances: v5Triplet.instances, templates: v5Triplet.templates },
      { allocations: v5Triplet.allocations, templates: v5Triplet.templates }
    ]) expect(isSnapshot({ ...snapshot("partial"), ...partial })).toBe(false);
    expect(isSnapshot({ ...snapshot("bad-instance"), ...v5Triplet, instances: [{ ...v5Triplet.instances[0], creator: undefined }] })).toBe(false);
    expect(isSnapshot({ ...snapshot("bad-allocation"), ...v5Triplet, allocations: [{ ...v5Triplet.allocations[0], workspace: "relative" }] })).toBe(false);
    expect(isSnapshot({ ...snapshot("bad-template"), ...v5Triplet, templates: [{ ...v5Triplet.templates[0], legacyAgentId: 42 }] })).toBe(false);
  });

  it("validates component inventories independently from the v5 triplet", () => {
    const base = { ...snapshot("inventory"), nodes: [inventoryNode] };
    expect(isSnapshot(base)).toBe(true);
    expect(isSnapshot({ ...base, ...v5Triplet })).toBe(true);
    expect(isSnapshot({ ...base, componentInventories: [componentInventory] })).toBe(true);
    expect(isSnapshot({ ...base, ...v5Triplet, componentInventories: [componentInventory] })).toBe(true);
    expect(isSnapshot({ ...base, instances: [], componentInventories: [componentInventory] })).toBe(false);
    expect(isSnapshot({ ...base, ...v5Triplet, componentInventories: [componentInventory, componentInventory] })).toBe(false);
    expect(isSnapshot({ ...base, ...v5Triplet, componentInventories: [{ ...componentInventory, nodeId: "missing-node" }] })).toBe(false);
    expect(isSnapshot({ ...base, ...v5Triplet, componentInventories: [{ ...componentInventory, components: [{ ...componentInventory.components[0], diagnosticCodes: ["raw-error"] }] }] })).toBe(false);
  });
});

describe("version-4 orchestration snapshot validation", () => {
  const task = {
    id: "task-1", threadId: "thread-1", title: "Build", instructions: "Build the thing",
    status: "ready", requirements: {}, dependencies: [], idempotencyKey: "key-1",
    attemptRunIds: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z"
  };

  const approval = {
    id: "approval-1", harnessApprovalId: "acp-permission-1", threadId: "thread-1", runId: "run-1",
    nodeId: "node-1", title: "Write file", options: [{ id: "opt-1", label: "Allow once", kind: "allow-once" }],
    status: "pending", requestedAt: "2026-01-01T00:00:00Z"
  };

  const lease = {
    id: "lease-1", threadId: "thread-1", taskId: "task-1", runId: "run-1", nodeId: "node-1",
    projectProfileId: "profile-1", policy: "git-worktree", cleanup: "retain", root: "/srv/repos",
    sourcePath: "/srv/repos/app", worktreePath: "/srv/repos/.coffee-shop/worktrees/lease-1", status: "active",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z"
  };

  const runActivity = {
    runId: "run-1", nodeId: "node-1", streamStatus: "open", lastSequence: 1, acceptedEvents: 1,
    message: { text: "hello", truncatedBytes: 0 }, thought: { text: "", truncatedBytes: 0 },
    plan: [], toolCalls: [], diffs: [], terminals: [], warnings: [], unknownEvents: 0,
    omitted: { toolCalls: 0, diffs: 0, terminals: 0, warnings: 0 }, summary: "hello", updatedAt: "2026-01-01T00:00:00Z"
  };

  const taskMessage = {
    id: "message-1", threadId: "thread-1", sender: { type: "task", taskId: "task-1" },
    recipient: { type: "orchestrator" }, sequence: 1, kind: "question", body: "Need input",
    idempotencyKey: "key-2", createdAt: "2026-01-01T00:00:00Z"
  };

  const acknowledgement = {
    messageId: "message-1", threadId: "thread-1", recipient: { type: "orchestrator" },
    runId: "run-1", acknowledgedAt: "2026-01-01T00:00:00Z"
  };

  const sessionBinding = {
    id: "binding-1", threadId: "thread-1", agentId: "agent-1", nodeId: "node-1", harnessId: "claude-cli",
    transport: "acp-v1", workspace: "/workspace", providerSessionId: "provider-session", status: "active",
    createdByRunId: "run-1", lastRunId: "run-1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z"
  };

  it("accepts a fully populated version-4 snapshot", () => {
    expect(isSnapshot({
      ...snapshot("v4"),
      tasks: [task],
      taskMessages: [taskMessage],
      taskMessageAcknowledgements: [acknowledgement],
      sessionBindings: [sessionBinding],
      approvals: [approval],
      workspaceLeases: [lease],
      runActivity: [runActivity]
    })).toBe(true);
  });

  it("accepts a legacy snapshot with every orchestration collection absent", () => {
    expect(isSnapshot(snapshot("legacy"))).toBe(true);
  });

  it("rejects an unknown task status rather than coercing it", () => {
    expect(isSnapshot({ ...snapshot("bad"), tasks: [{ ...task, status: "in-limbo" }] })).toBe(false);
  });

  it("rejects an approval with an option of an unknown kind", () => {
    expect(isSnapshot({ ...snapshot("bad"), approvals: [{ ...approval, options: [{ id: "opt-1", label: "?", kind: "maybe" }] }] })).toBe(false);
  });

  it("rejects a workspace lease with an unknown status", () => {
    expect(isSnapshot({ ...snapshot("bad"), workspaceLeases: [{ ...lease, status: "vanished" }] })).toBe(false);
  });

  it("rejects run activity missing its bounded text fields", () => {
    expect(isSnapshot({ ...snapshot("bad"), runActivity: [{ ...runActivity, message: "hello" }] })).toBe(false);
  });

  it("rejects a task message with a malformed participant", () => {
    expect(isSnapshot({ ...snapshot("bad"), taskMessages: [{ ...taskMessage, sender: { type: "task" } }] })).toBe(false);
  });

  it("accepts a run carrying version-4 task attempt and transport fields", () => {
    const run = {
      id: "run-1", agentId: "agent-1", nodeId: "node-1", harnessId: "claude-cli", model: "sonnet",
      workspace: "/workspace", prompt: "go", status: "running", output: "", depth: 0, createdAt: "2026-01-01T00:00:00Z",
      taskId: "task-1", attempt: 1, transport: "acp-v1", fallbackTransport: "native-cli",
      transportSelection: { requestedTransport: "acp-v1", selectedTransport: "native-cli", fallbackReason: "acp-adapter-unavailable" },
      sessionBindingId: "binding-1", workspaceLeaseId: "lease-1"
    };
    expect(isSnapshot({ ...snapshot("v4"), runs: [run] })).toBe(true);
    expect(isSnapshot({ ...snapshot("bad"), runs: [{ ...run, transport: "carrier-pigeon" }] })).toBe(false);
    expect(isSnapshot({ ...snapshot("v5"), runs: [{ ...run, transportSelection: {
      requestedTransport: "native-cli", selectedTransport: "native-cli",
      effectiveCapabilityPack: { id: "coffee-shop-core", version: "1.0.0", skills: ["review"] }
    } }] })).toBe(true);
    expect(isSnapshot({ ...snapshot("bad-proof"), runs: [{ ...run, transportSelection: {
      requestedTransport: "native-cli", selectedTransport: "native-cli",
      effectiveCapabilityPack: { id: "coffee-shop-core", version: "1.0.0", skills: [] }
    } }] })).toBe(false);
  });
});

describe("HubConnection", () => {
  it("loads REST before opening a socket and only a valid socket snapshot becomes current", async () => {
    const pending = deferred<Response>();
    const test = harness(() => pending.promise);
    const states: ConnectionView[] = [];
    const connection = new HubConnection("secret", test.environment, (state) => states.push(state));

    connection.start();
    expect(test.sockets).toHaveLength(0);
    pending.resolve(response(200, snapshot("rest")));
    await flush();
    expect(test.sockets).toHaveLength(1);
    expect(test.socketUrls).toEqual(["ws://example.test/events?token=secret"]);
    expect(states.at(-1)).toMatchObject({ status: "connecting", snapshot: { generatedAt: "rest" }, canMutate: false });
    test.sockets[0].onopen?.(new Event("open"));
    expect(states.at(-1)?.status).toBe("connecting");
    test.sockets[0].message({ type: "snapshot", data: snapshot("socket") });
    expect(states.at(-1)).toMatchObject({ status: "connected", snapshot: { generatedAt: "socket" }, canMutate: true });
  });

  it("distinguishes a REST 401 from a transient fetch failure", async () => {
    const unauthorizedFetch = vi.fn(async () => response(401, {}));
    const unauthorized = harness(unauthorizedFetch);
    const unauthorizedStates: ConnectionView[] = [];
    const unauthorizedConnection = new HubConnection("bad", unauthorized.environment, (state) => unauthorizedStates.push(state));
    unauthorizedConnection.start();
    await flush();
    expect(unauthorizedStates.at(-1)?.status).toBe("authentication-required");
    expect(unauthorized.timers.size).toBe(0);
    unauthorized.setOnline(false);
    unauthorized.dispatch("offline");
    unauthorized.setOnline(true);
    unauthorized.dispatch("online");
    await flush();
    expect(unauthorizedStates.at(-1)?.status).toBe("authentication-required");
    expect(unauthorizedFetch).toHaveBeenCalledOnce();

    const unavailable = harness(async () => { throw new TypeError("network"); });
    const unavailableStates: ConnectionView[] = [];
    const unavailableConnection = new HubConnection("good", unavailable.environment, (state) => unavailableStates.push(state));
    unavailableConnection.start();
    await flush();
    expect(unavailableStates.at(-1)?.status).toBe("disconnected");
    expect(unavailable.timers.size).toBe(1);
  });

  it("deduplicates socket error and close into one retry", async () => {
    const test = harness(async () => response(200, snapshot("rest")));
    const states: ConnectionView[] = [];
    const connection = new HubConnection("secret", test.environment, (state) => states.push(state));
    connection.start();
    await flush();
    test.sockets[0].message({ type: "snapshot", data: snapshot("live") });

    test.sockets[0].onerror?.(new Event("error"));
    test.sockets[0].onclose?.(new CloseEvent("close"));
    expect(states.at(-1)).toMatchObject({ status: "reconnecting", snapshot: { generatedAt: "live" }, canMutate: false });
    expect(test.timers.size).toBe(1);
    expect(test.delays).toEqual([1000]);
  });

  it("uses capped exponential backoff with bounded jitter and resets after resync", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("network"); });
    const low = harness(fetchImpl, () => 0);
    const connection = new HubConnection("secret", low.environment, () => undefined);
    connection.start();
    await flush();
    for (let index = 0; index < 6; index += 1) { low.runTimer(); await flush(); }
    expect(low.delays).toEqual([800, 1600, 3200, 6400, 12800, 24000, 24000]);

    const high = harness(async () => response(200, snapshot("rest")), () => 1);
    const recovered = new HubConnection("secret", high.environment, () => undefined);
    recovered.start();
    await flush();
    high.sockets[0].onclose?.(new CloseEvent("close"));
    expect(high.delays).toEqual([1200]);
    high.runTimer();
    await flush();
    high.sockets[1].message({ type: "snapshot", data: snapshot("live") });
    high.sockets[1].onclose?.(new CloseEvent("close"));
    expect(high.delays).toEqual([1200, 1200]);
  });

  it("pauses offline and retries immediately on online or manual retry", async () => {
    const test = harness(async () => response(200, snapshot("rest")));
    const connection = new HubConnection("secret", test.environment, () => undefined);
    connection.start();
    await flush();
    test.sockets[0].onclose?.(new CloseEvent("close"));
    expect(test.timers.size).toBe(1);

    test.setOnline(false);
    connection.retry();
    expect(test.timers.size).toBe(0);
    test.dispatch("offline");
    expect(test.timers.size).toBe(0);
    test.setOnline(true);
    test.dispatch("online");
    await flush();
    expect(test.sockets).toHaveLength(2);

    test.sockets[1].onclose?.(new CloseEvent("close"));
    expect(test.timers.size).toBe(1);
    connection.retry();
    await flush();
    expect(test.timers.size).toBe(0);
    expect(test.sockets).toHaveLength(3);
  });

  it.each([
    ["non-JSON", "not-json"],
    ["wrong envelope", { type: "update", data: snapshot("bad") }],
    ["malformed snapshot", { type: "snapshot", data: { ...snapshot("bad"), runs: [{}] } }]
  ])("fails closed for %s messages", async (_label, payload) => {
    const test = harness(async () => response(200, snapshot("rest")));
    const states: ConnectionView[] = [];
    const connection = new HubConnection("secret", test.environment, (state) => states.push(state));
    connection.start();
    await flush();
    test.sockets[0].message({ type: "snapshot", data: snapshot("live") });
    test.sockets[0].message(payload);
    expect(states.at(-1)).toMatchObject({ status: "reconnecting", snapshot: { generatedAt: "live" }, canMutate: false });
    expect(test.timers.size).toBe(1);
  });

  it("retains the last valid v5 snapshot and reconnects when a partial triplet arrives", async () => {
    const live = { ...snapshot("live-v5"), ...v5Triplet };
    const test = harness(async () => response(200, live));
    const states: ConnectionView[] = [];
    const connection = new HubConnection("secret", test.environment, (state) => states.push(state));
    connection.start();
    await flush();
    test.sockets[0].message({ type: "snapshot", data: live });
    test.sockets[0].message({ type: "snapshot", data: { ...snapshot("partial"), instances: [] } });
    expect(states.at(-1)).toMatchObject({ status: "reconnecting", snapshot: { generatedAt: "live-v5" }, canMutate: false });
    expect(test.timers.size).toBe(1);
  });

  it("retains the whole last-good snapshot and disables mutation for malformed inventory", async () => {
    const live = { ...snapshot("live-inventory"), nodes: [inventoryNode], ...v5Triplet, componentInventories: [componentInventory] };
    const test = harness(async () => response(200, live as Snapshot));
    const states: ConnectionView[] = [];
    const connection = new HubConnection("secret", test.environment, (state) => states.push(state));
    connection.start();
    await flush();
    test.sockets[0].message({ type: "snapshot", data: live });
    test.sockets[0].message({ type: "snapshot", data: { ...live, generatedAt: "bad", componentInventories: [{ ...componentInventory, components: [{ ...componentInventory.components[0], readiness: "guessed" }] }] } });
    expect(states.at(-1)).toMatchObject({ status: "reconnecting", snapshot: { generatedAt: "live-inventory", componentInventories: [componentInventory] }, canMutate: false });
  });

  it("retains the whole last-good snapshot when a retry REST response has malformed inventory", async () => {
    const live = { ...snapshot("live-inventory"), nodes: [inventoryNode], ...v5Triplet, componentInventories: [componentInventory] };
    const malformed = { ...live, generatedAt: "bad-rest", componentInventories: [{ ...componentInventory, componentPath: "/private/node/path" }] };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(200, live))
      .mockResolvedValueOnce(response(200, malformed));
    const test = harness(fetchImpl);
    const states: ConnectionView[] = [];
    const connection = new HubConnection("secret", test.environment, (state) => states.push(state));
    connection.start();
    await flush();
    test.sockets[0].message({ type: "snapshot", data: live });
    test.sockets[0].onclose?.(new CloseEvent("close"));
    test.runTimer();
    await flush();
    await flush();
    expect(states.at(-1)).toMatchObject({ status: "disconnected", snapshot: { generatedAt: "live-inventory", componentInventories: [componentInventory] }, canMutate: false });
    expect(test.timers.size).toBe(1);
  });

  it("validates host sessions as one correlated snapshot collection", () => {
    const session = {
      hostHarnessSessionId: "host-session-one", nodeId: "node-one", harnessId: "codex-cli",
      providerSessionId: "provider-one", workspace: "/workspace", source: "provider-history",
      status: "idle", controlMode: "resume", operations: ["attach", "read-history"], revision: 1,
      attachmentEpoch: 0, createdAt: "2026-10-06T10:00:00Z", updatedAt: "2026-10-06T10:00:00Z"
    };
    const valid = { ...snapshot("2026-10-06T10:00:00Z"), nodes: [inventoryNode], hostHarnessSessions: [session] };
    expect(isSnapshot(valid)).toBe(true);
    expect(isSnapshot({ ...valid, hostHarnessSessions: [session, session] })).toBe(false);
    expect(isSnapshot({ ...valid, hostHarnessSessions: [{ ...session, endpoint: "stdio://private" }] })).toBe(false);
    expect(isSnapshot({ ...valid, hostHarnessSessions: [{ ...session, workspace: "/workspace", summary: "Authorization: Bearer SECRET_CANARY" }] })).toBe(false);
  });

  it("ignores superseded fetches and callbacks and cleans up on stop", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const test = harness(fetchImpl);
    const states: ConnectionView[] = [];
    const connection = new HubConnection("secret", test.environment, (state) => states.push(state));
    connection.start();
    connection.retry();
    first.resolve(response(200, snapshot("obsolete")));
    second.resolve(response(200, snapshot("current-rest")));
    await flush();
    expect(test.sockets).toHaveLength(1);
    expect(states.at(-1)?.snapshot.generatedAt).toBe("current-rest");

    connection.stop();
    test.sockets[0].message({ type: "snapshot", data: snapshot("late") });
    test.sockets[0].onclose?.(new CloseEvent("close"));
    expect(states.at(-1)?.snapshot.generatedAt).toBe("current-rest");
    expect(test.timers.size).toBe(0);
  });
});
