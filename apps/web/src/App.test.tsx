import type { Agent, AgentInstance, AgentTemplate, ComputeNode, InstanceAllocation, Run, RunStatus, Snapshot, Thread } from "@coffee-shop/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionStatus } from "./hubConnection.js";

const mocks = vi.hoisted(() => ({
  status: "disconnected" as ConnectionStatus,
  retry: vi.fn()
}));

vi.mock("./hubConnection.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./hubConnection.js")>();
  return {
    ...original,
    useHubConnection: () => ({
      status: mocks.status,
      snapshot: currentSnapshot,
      canMutate: mocks.status === "connected",
      retry: mocks.retry
    })
  };
});

const agent: Agent = {
  id: "agent-one",
  name: "Milo",
  title: "Builder",
  summary: "Builds things",
  glyph: "M",
  avatarShape: "cup",
  avatarColor: "amber",
  state: "idle",
  currentAction: "Waiting",
  harnessId: "codex-cli",
  model: "gpt-5",
  computeNodeId: "node-one",
  workspace: "/workspace",
  systemPrompt: "Build",
  unread: 0,
  updatedAt: "2026-01-01T00:00:00Z"
};

const node: ComputeNode = {
  id: "node-one",
  name: "Desk",
  kind: "local",
  platform: "darwin",
  status: "online",
  lastSeen: "2026-01-01T00:00:00Z",
  activeRuns: 0,
  concurrency: 1,
  workspaceRoots: ["/workspace"],
  harnesses: [{ id: "codex-cli", label: "Codex", description: "Codex", available: true, authMode: "local-account", models: ["gpt-5"] }],
  version: "test"
};

const testSnapshot: Snapshot = {
  agents: [agent],
  nodes: [node],
  runs: [],
  events: [],
  messages: [],
  generatedAt: "2026-01-01T00:00:00Z"
};
let currentSnapshot = testSnapshot;

function testRun(status: RunStatus = "running", id = "run-one"): Run {
  return {
    id, agentId: agent.id, nodeId: node.id, harnessId: "codex-cli", model: "gpt-5",
    workspace: "/workspace", prompt: "Ship the inspector", status, output: "",
    depth: 1, parentRunId: "run-parent", createdAt: "2026-01-01T00:00:00Z",
    startedAt: status === "queued" ? undefined : "2026-01-01T00:01:00Z",
    finishedAt: ["completed", "failed", "cancelled"].includes(status) ? "2026-01-01T00:02:00Z" : undefined,
    error: status === "failed" ? "Harness failed" : undefined
  };
}

function prepareBrowser(status: ConnectionStatus = "connected") {
  mocks.status = status;
  mocks.retry.mockReset();
  currentSnapshot = structuredClone(testSnapshot);
  vi.stubGlobal("fetch", vi.fn());
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() { return storage.size; }
  });
}

const thread: Thread = {
  id: "thread-one", title: "User contact information form", objective: "Create a contact form", summary: "Ready for follow-up",
  status: "completed", ownerAgentId: agent.id, createdBy: "user", createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:02:00Z", completedAt: "2026-01-01T00:02:00Z"
};

describe("durable threads", () => {
  beforeEach(() => prepareBrowser());

  it("shows linked runs and artifacts while legacy continuation stays read-only", async () => {
    currentSnapshot.threads = [thread];
    currentSnapshot.runs = [{ ...testRun("completed"), threadId: thread.id, parentRunId: undefined }];
    currentSnapshot.artifacts = [{
      id: "artifact-one", threadId: thread.id, runId: "run-one", agentId: agent.id, relativePath: "report.md",
      title: "Form report", kind: "report", mediaType: "text/markdown", summary: "Ready", size: 12,
      sha256: "a".repeat(64), downloadPath: "/api/artifacts/artifact-one/content", uploaded: true,
      idempotencyKey: "report", createdAt: "2026-01-01T00:01:00Z"
    }];
    currentSnapshot.messages = [{
      id: "message-one", threadId: thread.id, agentId: agent.id, author: "agent", body: "Initial work complete",
      kind: "message", runId: "run-one", createdAt: "2026-01-01T00:02:00Z"
    }];
    const fetchMock = vi.mocked(fetch);
    const { default: App } = await import("./App.js");
    render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: "Threads" })[0]);
    expect(screen.getByRole("heading", { name: thread.title })).toBeInTheDocument();
    expect(screen.getAllByText("1", { selector: ".thread-card dd" })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Continue thread" }));
    expect(screen.getByLabelText("Send to")).toHaveValue(thread.id);
    expect(screen.getByText("Initial work complete")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Reconnect to message Milo")).toBeDisabled();
    expect(screen.getByText("Read-only legacy agents")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  }, 15_000);

  it("keeps the chat filter in step with the send target and drops a filter whose thread was archived", async () => {
    currentSnapshot.threads = [thread];
    currentSnapshot.runs = [{ ...testRun("completed"), threadId: thread.id, parentRunId: undefined }];
    const { default: App } = await import("./App.js");
    const { rerender } = render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: "Threads" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Continue thread" }));
    expect(screen.getByRole("button", { name: thread.title, pressed: true })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Send to"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "All", pressed: true })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: thread.title }));
    expect(screen.getByRole("button", { name: thread.title, pressed: true })).toBeInTheDocument();
    currentSnapshot.threads = [{ ...thread, status: "archived" }];
    rerender(<App />);
    expect(screen.queryByRole("button", { name: thread.title })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Show activity from" })).not.toBeInTheDocument();
  });

  it("archives through the operator endpoint", async () => {
    currentSnapshot.threads = [thread];
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...thread, status: "archived" }), { status: 200, headers: { "content-type": "application/json" } }));
    const { default: App } = await import("./App.js");
    render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: "Threads" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/threads/thread-one", expect.objectContaining({ method: "PATCH" })));
  });
});

describe("connection freshness UI", () => {
  beforeEach(() => {
    prepareBrowser("disconnected");
  });

  it("shows stale state, retries manually, and disables guarded mutations", async () => {
    const { default: App } = await import("./App.js");
    render(<App />);

    expect(screen.getAllByRole("status")[0]).toHaveTextContent("Disconnected");
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    expect(mocks.retry).toHaveBeenCalledOnce();
    expect(screen.getAllByRole("button", { name: "Create agent" })).toSatisfy((buttons: HTMLElement[]) => buttons.every((button) => button.hasAttribute("disabled")));

    fireEvent.click(screen.getAllByRole("button", { name: /Milo/ })[0]);
    const composer = screen.getByPlaceholderText("Reconnect to message Milo");
    expect(composer).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Context" }));
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("renders truthful connection state in Settings", async () => {
    mocks.status = "reconnecting";
    const { default: App } = await import("./App.js");
    render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: "Settings" })[0]);
    expect(document.querySelector(".stale-label")).toHaveTextContent("reconnecting · stale");
    expect(document.querySelector(".ok-label")).toBeNull();
  });

  it("keeps the fully absent v5 compatibility view explicitly read-only even while connected", async () => {
    mocks.status = "connected";
    const { default: App } = await import("./App.js");
    render(<App />);
    expect(screen.getByText("Read-only legacy agents")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Create agent" })).toSatisfy((buttons: HTMLElement[]) => buttons.every((button) => button.hasAttribute("disabled")));
  });
});

describe("install prompt integration", () => {
  beforeEach(() => prepareBrowser());

  it("captures the browser prompt before Settings is opened", async () => {
    const prompt = vi.fn(async () => undefined);
    const installEvent = new Event("beforeinstallprompt", { cancelable: true }) as Event & {
      prompt: () => Promise<void>;
      userChoice: Promise<{ outcome: "accepted"; platform: string }>;
    };
    installEvent.prompt = prompt;
    installEvent.userChoice = Promise.resolve({ outcome: "accepted", platform: "web" });
    const { default: App } = await import("./App.js");
    render(<App />);
    fireEvent(window, installEvent);
    fireEvent.click(screen.getAllByRole("button", { name: "Settings" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Install PWA" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
  });
});

const v5Instance: AgentInstance = {
  id: "instance-review", threadId: thread.id, creator: { kind: "operator", operatorId: "operator" },
  purpose: { name: "Reviewer", title: "Quality review", summary: "Checks the release" }, delegation: { canDelegate: false },
  requirements: { templateId: "template-review", skills: ["review"] }, lease: { idleTimeoutSeconds: 1800, expiresAt: "2026-01-01T01:00:00Z" },
  status: "busy", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:02:00Z"
};
const v5Allocation: InstanceAllocation = {
  id: "allocation-review", instanceId: v5Instance.id, nodeId: node.id, harnessId: "codex-cli", model: "gpt-5", transport: "native-cli",
  expectedCapabilityPack: { id: "coffee-shop-core", version: "1.0.0", requiredSkills: ["review"] },
  workspace: "/workspace/review", lease: v5Instance.lease, status: "active", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:02:00Z"
};
const v5Template: AgentTemplate = {
  id: "template-review", name: "Review", purpose: { title: "Quality reviewer", summary: "Finds release risks" },
  avatarShape: "cup", avatarColor: "sage", skills: ["review"], requirements: { models: ["gpt-5"] }, delegation: { canDelegate: false }, legacyAgentId: agent.id
};

function prepareV5(status: ConnectionStatus = "connected") {
  prepareBrowser(status);
  currentSnapshot = {
    ...currentSnapshot,
    threads: [{ ...thread, status: "active", completedAt: undefined }],
    instances: [v5Instance], allocations: [v5Allocation], templates: [v5Template],
    nodes: [{ ...node, instanceCapacity: 2, activeInstances: 0 }],
    runs: [{ ...testRun("running"), id: "run-instance", agentId: undefined, instanceId: v5Instance.id, allocationId: v5Allocation.id, threadId: thread.id, prompt: "Review the release",
      transportSelection: { requestedTransport: "native-cli", selectedTransport: "native-cli", effectiveCapabilityPack: { id: "coffee-shop-core", version: "1.0.0", skills: ["review"] } } }]
  };
}

describe("version-5 instance and template operator experience", () => {
  beforeEach(() => prepareV5());

  it("starts a thread with a resident delegating orchestrator", async () => {
    const leadTemplate: AgentTemplate = {
      ...v5Template,
      id: "template-lead",
      name: "Engineering lead",
      purpose: { name: "Lead", instructions: "Delegate and verify." },
      delegation: { canDelegate: true }
    };
    currentSnapshot.templates = [leadTemplate, v5Template];
    const hostedThread: Thread = {
      ...thread,
      id: "thread-hosted",
      title: "Ship billing export",
      objective: "Delegate implementation and independent review.",
      status: "active",
      completedAt: undefined,
      orchestrator: { kind: "instance", instanceId: "instance-lead" }
    };
    const leadInstance: AgentInstance = {
      ...v5Instance,
      id: "instance-lead",
      threadId: hostedThread.id,
      purpose: leadTemplate.purpose,
      delegation: { canDelegate: true },
      requirements: { templateId: leadTemplate.id, harnessIds: ["codex-cli"], models: ["gpt-5"] },
      status: "provisioning"
    };
    const leadAllocation: InstanceAllocation = {
      ...v5Allocation,
      id: "allocation-lead",
      instanceId: leadInstance.id,
      status: "reserved"
    };
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      thread: hostedThread,
      instance: leadInstance,
      allocation: leadAllocation,
      replayed: false
    }), { status: 201, headers: { "content-type": "application/json" } }));

    const { default: App } = await import("./App.js");
    render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: "Threads" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    const dialog = screen.getByRole("dialog", { name: "Start an orchestrated thread" });
    fireEvent.change(within(dialog).getByLabelText("Thread title"), { target: { value: hostedThread.title } });
    fireEvent.change(within(dialog).getByLabelText("What should the orchestrator accomplish?"), { target: { value: hostedThread.objective } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Orchestrator template: Built-in orchestrator" }));
    fireEvent.click(within(dialog).getByRole("option", { name: /Engineering lead/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Harness: Automatic" }));
    fireEvent.click(within(dialog).getByRole("option", { name: /^Codex/ }));
    expect(within(dialog).getByRole("button", { name: "Model: gpt-5" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /Start thread/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/threads");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      idempotencyKey: expect.stringMatching(/^web-/),
      title: hostedThread.title,
      objective: hostedThread.objective,
      orchestrator: {
        purpose: { name: "Lead", instructions: "Delegate and verify." },
        requirements: { templateId: "template-lead", harnessIds: ["codex-cli"], models: ["gpt-5"] }
      }
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Start an orchestrated thread" })).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Threads" })).toBeInTheDocument();
  });

  it("opens on instances, keeps desired constraints separate, and shows exact capacity/work", async () => {
    const { default: App } = await import("./App.js");
    render(<App />);
    expect(screen.queryByRole("button", { name: "Agents" })).not.toBeInTheDocument();
    const bottomNavigation = document.querySelector(".bottom-nav") as HTMLElement;
    expect(within(bottomNavigation).getByRole("button", { name: "Instances" })).toHaveAttribute("aria-label", "Instances");
    expect(within(bottomNavigation).getByText("Instances")).toHaveAttribute("aria-hidden", "true");
    const instanceRow = screen.getAllByRole("button", { name: /Reviewer/ })[0];
    fireEvent.click(instanceRow);
    expect(instanceRow).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Desired requirements")).toBeInTheDocument();
    expect(screen.getByText("Current placement")).toBeInTheDocument();
    expect(screen.getByText("coffee-shop-core@1.0.0")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getByText("Review the release")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Templates" })[0]);
    const templateRow = screen.getAllByRole("button", { name: /Review/ })[0];
    fireEvent.click(templateRow);
    expect(templateRow).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Imported template")).toBeInTheDocument();
    expect(screen.getByText("defaults only")).toBeInTheDocument();
  });

  it("calls the shared renew and release routes without accepting creator authority", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ instance: v5Instance, allocation: v5Allocation, replayed: false }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ instance: { ...v5Instance, status: "draining" }, allocation: v5Allocation, replayed: false }), { status: 202, headers: { "content-type": "application/json" } }));
    const { default: App } = await import("./App.js");
    render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: /Reviewer/ })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Renew lease" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    expect(screen.getByRole("button", { name: /^Drain/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Cancel/ })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Confirm drain" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/threads/thread-one/instances/instance-review/renew",
      "/api/threads/thread-one/instances/instance-review/release"
    ]);
    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse(String((call[1] as RequestInit).body));
      expect(body.idempotencyKey).toMatch(/^web-/);
      expect(body.creator).toBeUndefined();
    }
  });

  it("reuses the create idempotency key after an uncertain transport failure", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValueOnce(new TypeError("network uncertain")).mockResolvedValueOnce(new Response(JSON.stringify({ instance: { ...v5Instance, id: "instance-new" }, replayed: true }), { status: 200, headers: { "content-type": "application/json" } }));
    const { default: App } = await import("./App.js");
    render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: "Start instance" })[0]);
    const dialog = screen.getByRole("dialog", { name: "Start an instance" });
    expect(within(dialog).getByRole("button", { name: `Active thread: ${thread.title}` })).toHaveAttribute("aria-expanded", "false");
    const templatePicker = within(dialog).getByRole("button", { name: "Template: No template" });
    fireEvent.click(templatePicker);
    expect(within(dialog).getByRole("option", { name: /No template/ })).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).getByRole("option", { name: /Review/ })).toHaveAttribute("aria-selected", "false");
    fireEvent.click(templatePicker);
    fireEvent.click(within(dialog).getByRole("button", { name: "Allowed harnesses: Any available harness" }));
    fireEvent.click(within(dialog).getByRole("option", { name: /^Codex/ }));
    expect(within(dialog).getByRole("button", { name: "Allowed harnesses: Codex" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Allowed models: Any available model" }));
    fireEvent.click(within(dialog).getByRole("option", { name: "gpt-5" }));
    expect(within(dialog).getByRole("button", { name: "Allowed models: gpt-5" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Fresh worker" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Start instance" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("network uncertain");
    fireEvent.click(within(dialog).getByRole("button", { name: "Start instance" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
    expect(bodies[0].idempotencyKey).toBe(bodies[1].idempotencyKey);
    expect(bodies[0].creator).toBeUndefined();
    expect(bodies[0].requirements).toEqual({ harnessIds: ["codex-cli"], models: ["gpt-5"] });
  });

  it("explains and validates the optional initial task before sending", async () => {
    const fetchMock = vi.mocked(fetch);
    const { default: App } = await import("./App.js");
    render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: "Start instance" })[0]);
    const dialog = screen.getByRole("dialog", { name: "Start an instance" });
    const initialTask = within(dialog).getByRole("switch", { name: /Queue an initial task/ });
    expect(initialTask).toHaveTextContent("pins it to the new instance");
    fireEvent.click(initialTask);
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Only a title" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Start instance" }));
    expect(screen.getByRole("alert")).toHaveTextContent("both a title and instructions");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns the missing active-thread failure into a guided prerequisite", async () => {
    currentSnapshot.threads = [thread];
    const { default: App } = await import("./App.js");
    render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: "Start instance" })[0]);
    const dialog = screen.getByRole("dialog", { name: "Start an instance" });
    expect(within(dialog).getByRole("status")).toHaveTextContent("Start with an active thread");
    expect(within(dialog).queryByText("An active thread is required.")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Start instance" })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /Open threads/ }));
    expect(screen.queryByRole("dialog", { name: "Start an instance" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Threads" })).toBeInTheDocument();
  });

  it("creates, updates, and reference-safely deletes templates through dedicated routes", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ template: { ...v5Template, id: "template-new", name: "Builder" }, replayed: false }), { status: 201, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ template: { ...v5Template, name: "Review revised" }, replayed: false }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ template: v5Template, replayed: false }), { status: 200, headers: { "content-type": "application/json" } }));
    const { default: App } = await import("./App.js");
    const rendered = render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: "Templates" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Create template" })[0]);
    expect(screen.getByRole("button", { name: "cup" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "amber" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Builder" } });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    currentSnapshot = { ...currentSnapshot, templates: [v5Template] };
    rendered.rerender(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: /Review/ })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Review revised" } });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete template" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls.map((call) => [call[0], (call[1] as RequestInit).method])).toEqual([
      ["/api/agent-templates", "POST"], ["/api/agent-templates/template-review", "PATCH"], ["/api/agent-templates/template-review", "DELETE"]
    ]);
  });

  it("disables every v5 mutation while stale", async () => {
    prepareV5("reconnecting");
    const { default: App } = await import("./App.js");
    render(<App />);
    expect(screen.getAllByRole("button", { name: "Start instance" })).toSatisfy((buttons: HTMLElement[]) => buttons.every((button) => button.hasAttribute("disabled")));
    fireEvent.click(screen.getAllByRole("button", { name: /Reviewer/ })[0]);
    expect(screen.getByRole("button", { name: "Renew lease" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Release" })).toBeDisabled();
    fireEvent.click(screen.getAllByRole("button", { name: "Templates" })[0]);
    expect(screen.getAllByRole("button", { name: "Create template" })).toSatisfy((buttons: HTMLElement[]) => buttons.every((button) => button.hasAttribute("disabled")));
  });
});

describe("run inspector", () => {
  beforeEach(() => prepareBrowser());

  it("opens the exact run from a response and stays synchronized with replacement snapshots", async () => {
    currentSnapshot.runs = [testRun("running"), testRun("completed", "run-other")];
    currentSnapshot.messages = [{
      id: "message-one", agentId: agent.id, author: "agent", body: "Working on it",
      kind: "message", runId: "run-one", createdAt: "2026-01-01T00:01:00Z"
    }];
    const { default: App } = await import("./App.js");
    const rendered = render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: /Milo/ })[0]);
    const trigger = screen.getByRole("button", { name: "Inspect run" });
    fireEvent.click(trigger);

    expect(screen.getByRole("dialog")).toHaveAccessibleName("Run run-one");
    expect(document.querySelector(".run-status-running")).toHaveTextContent("Running");
    expect(screen.getByText("Output is not available yet.")).toBeInTheDocument();
    expect(screen.queryByText("run-other")).not.toBeInTheDocument();

    currentSnapshot = { ...currentSnapshot, runs: [{ ...currentSnapshot.runs[0], output: "streamed chunk" }, currentSnapshot.runs[1]] };
    rendered.rerender(<App />);
    expect(screen.getByText("streamed chunk")).toBeInTheDocument();

    currentSnapshot = { ...currentSnapshot, runs: [currentSnapshot.runs[1]] };
    rendered.rerender(<App />);
    expect(screen.getByText("Run unavailable")).toBeInTheDocument();
    expect(screen.getByText(/No run named/)).toHaveTextContent("run-one");
  });

  it("opens run-bearing activity and renders every status plus unavailable relations and fields", async () => {
    currentSnapshot.runs = [{ ...testRun("queued"), agentId: "missing-agent", nodeId: "missing-node", model: "", workspace: "", prompt: "", parentRunId: undefined }];
    currentSnapshot.events = [{ id: "event-one", type: "run", title: "Queued", detail: "Waiting", runId: "run-one", createdAt: "2026-01-01T00:00:00Z" }];
    const { default: App } = await import("./App.js");
    const rendered = render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: "Activity" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Inspect run" }));
    expect(screen.getByText("missing-agent · unavailable")).toBeInTheDocument();
    expect(screen.getByText("missing-node · unavailable")).toBeInTheDocument();
    expect(screen.getByText("Model unavailable", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Workspace unavailable")).toBeInTheDocument();
    expect(screen.getByText("Prompt unavailable")).toBeInTheDocument();
    expect(screen.getByText("Not started yet")).toBeInTheDocument();
    expect(screen.getByText("Not finished yet")).toBeInTheDocument();

    for (const status of ["running", "completed", "failed", "cancelled"] as const) {
      currentSnapshot = { ...currentSnapshot, runs: [testRun(status)] };
      rendered.rerender(<App />);
      expect(screen.getByText(status[0].toUpperCase() + status.slice(1))).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Cancel run" })).not.toBeInTheDocument();
  });

  it("shows delegated children and uploaded artifacts", async () => {
    const parent = testRun("running");
    const child = { ...testRun("completed", "run-child"), parentRunId: parent.id };
    const previewCreatedAt = new Date(Date.now() - 60_000).toISOString();
    const previewReadyAt = new Date(Date.now() - 30_000).toISOString();
    const previewExpiresAt = new Date(Date.now() + 86_340_000).toISOString();
    currentSnapshot.runs = [parent, child];
    currentSnapshot.events = [{ id: "event-one", type: "run", title: "Running", detail: "Working", runId: parent.id, createdAt: "2026-01-01T00:00:00Z" }];
    currentSnapshot.artifacts = [{
      id: "artifact-one", runId: parent.id, agentId: agent.id, relativePath: "reports/result.json",
      title: "Test results", kind: "test-results", mediaType: "application/json", summary: "Passed",
      size: 42, sha256: "a".repeat(64), downloadPath: "/api/artifacts/artifact-one/content",
      uploaded: true, idempotencyKey: "results", createdAt: "2026-01-01T00:01:00Z"
    }, {
      id: "artifact-preview", threadId: "thread-one", runId: parent.id, agentId: agent.id,
      relativePath: ".coffee-shop/previews/site.tar.gz", title: "Release preview", kind: "preview-bundle",
      mediaType: "application/vnd.coffee-shop.preview-bundle+tar+gzip", summary: "Review release", size: 239,
      sha256: "b".repeat(64), downloadPath: "/api/artifacts/artifact-preview/content",
      uploaded: true, idempotencyKey: "preview", createdAt: previewCreatedAt
    }];
    currentSnapshot.artifactPreviews = [{
      id: "preview-one", artifactId: "artifact-preview", artifactSha256: "b".repeat(64),
      threadId: "thread-one", runId: parent.id, agentId: agent.id, entrypoint: "site/index.html",
      status: "ready", processingGeneration: 1, createdAt: previewCreatedAt,
      updatedAt: previewReadyAt, expiresAt: previewExpiresAt,
      readyAt: previewReadyAt, accessState: "eligible"
    }];
    const { default: App } = await import("./App.js");
    render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: "Activity" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Inspect run" }));
    expect(screen.getByRole("button", { name: /Test results/ })).toBeInTheDocument();
    expect(screen.getByText("Ready for isolated access")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request access to preview Release preview" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Milo.*Completed/ }));
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Run run-child");
  });

  it("traps focus, closes with Escape, and restores the triggering control", async () => {
    currentSnapshot.runs = [testRun("completed")];
    currentSnapshot.messages = [{ id: "message-one", agentId: agent.id, author: "agent", body: "Done", kind: "message", runId: "run-one", createdAt: "2026-01-01T00:01:00Z" }];
    const { default: App } = await import("./App.js");
    render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: /Milo/ })[0]);
    const trigger = screen.getByRole("button", { name: "Inspect run" });
    trigger.focus();
    fireEvent.click(trigger);
    const close = screen.getByRole("button", { name: "Close run inspector" });
    expect(close).toHaveFocus();
    await userEvent.tab();
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("confirms active cancellation, waits for success, and surfaces server or network failures", async () => {
    currentSnapshot.runs = [testRun("running")];
    currentSnapshot.messages = [{ id: "message-one", agentId: agent.id, author: "agent", body: "Running", kind: "message", runId: "run-one", createdAt: "2026-01-01T00:01:00Z" }];
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(testRun("cancelled")), { status: 200, headers: { "content-type": "application/json" } }));
    const { default: App } = await import("./App.js");
    render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: /Milo/ })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Inspect run" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(screen.getByText("Cancel this run?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/runs/run-one/cancel", expect.objectContaining({ method: "POST" })));
    expect(await screen.findByRole("alert")).toHaveTextContent("Cancellation accepted");
    expect(document.querySelector(".run-status-running")).toHaveTextContent("Running");

    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Run not found" }), { status: 404, headers: { "content-type": "application/json" } }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Run not found");

    fireEvent.click(screen.getByRole("button", { name: "Keep run" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "A completed run cannot be cancelled" }), { status: 409, headers: { "content-type": "application/json" } }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("A completed run cannot be cancelled"));

    fireEvent.click(screen.getByRole("button", { name: "Keep run" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    fetchMock.mockRejectedValueOnce(new Error("Network unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Network unavailable"));
  });
});
