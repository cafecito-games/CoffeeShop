import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent, ChatMessage, ComputeNode, Run, Snapshot, TimelineEvent } from "@coffee-shop/protocol";

type State = Omit<Snapshot, "generatedAt">;

const now = Date.now();
const iso = (minutesAgo = 0) => new Date(now - minutesAgo * 60_000).toISOString();

const seed = (): State => ({
  agents: [
    {
      id: "cpp-steward", name: "Ada", title: "C++ systems engineer",
      summary: "Owns native performance, toolchains, and low-level debugging.", glyph: "A",
      state: "waiting", currentAction: "Waiting for Home server", harnessId: "claude-cli", model: "sonnet",
      computeNodeId: "home-linux", workspace: "/srv/workspaces/game", unread: 2, updatedAt: iso(2),
      systemPrompt: "You are Ada, a senior C++ systems engineer. Prefer measured, portable fixes. Test every claim."
    },
    {
      id: "product-engineer", name: "Lin", title: "Product engineer",
      summary: "Ships end-to-end product work and keeps the interaction coherent.", glyph: "L",
      state: "waiting", currentAction: "Waiting on Ada's benchmark", harnessId: "codex-cli", model: "gpt-5.6-sol",
      computeNodeId: "local-macbook", workspace: "/Users/you/Projects/app", unread: 0, updatedAt: iso(8),
      systemPrompt: "You are Lin, a pragmatic product engineer. Optimize for small, coherent, tested changes."
    },
    {
      id: "release-sentinel", name: "Sable", title: "Release sentinel",
      summary: "Reviews changes, watches CI, and protects the release boundary.", glyph: "S",
      state: "done", currentAction: "Release candidate is clear", harnessId: "codex-cli", model: "gpt-5.6-sol",
      computeNodeId: "cloud-runner", workspace: "/workspace/release", unread: 1, updatedAt: iso(34),
      systemPrompt: "You are Sable, an adversarial release reviewer. Report evidence, severity, and exact remediation."
    },
    {
      id: "research-scout", name: "Mira", title: "Research scout",
      summary: "Builds source-backed briefs and tracks unresolved questions.", glyph: "M",
      state: "idle", currentAction: "Available", harnessId: "claude-cli", model: "opus",
      computeNodeId: "local-macbook", workspace: "/Users/you/Research", unread: 0, updatedAt: iso(96),
      systemPrompt: "You are Mira, a rigorous research analyst. Separate evidence, inference, and open questions."
    }
  ],
  nodes: [
    {
      id: "local-macbook", name: "This laptop", kind: "local", platform: "macOS · arm64", status: "offline",
      lastSeen: iso(68), activeRuns: 0, concurrency: 2, workspaceRoots: ["/Users/you/Projects"], version: "0.1.0",
      harnesses: [
        { id: "claude-cli", label: "Claude Code", description: "Official local CLI", binary: "claude", available: true, authMode: "local-subscription", models: ["sonnet", "opus"] },
        { id: "codex-cli", label: "Codex", description: "Official local CLI", binary: "codex", available: true, authMode: "local-account", models: ["gpt-5.6-sol"] }
      ]
    },
    {
      id: "home-linux", name: "Home server", kind: "home-server", platform: "Ubuntu · x64", status: "offline",
      lastSeen: iso(14), activeRuns: 0, concurrency: 4, workspaceRoots: ["/srv/workspaces"], version: "0.1.0",
      harnesses: [{ id: "claude-cli", label: "Claude Code", description: "Official local CLI", binary: "claude", available: true, authMode: "local-subscription", models: ["sonnet"] }]
    },
    {
      id: "cloud-runner", name: "Cloud runner", kind: "cloud", platform: "Debian · x64", status: "offline",
      lastSeen: iso(240), activeRuns: 0, concurrency: 8, workspaceRoots: ["/workspace"], version: "0.1.0",
      harnesses: [{ id: "codex-cli", label: "Codex", description: "Official local CLI", binary: "codex", available: true, authMode: "local-account", models: ["gpt-5.6-sol"] }]
    }
  ],
  runs: [
    { id: "run-benchmark", agentId: "cpp-steward", nodeId: "home-linux", harnessId: "claude-cli", model: "sonnet", workspace: "/srv/workspaces/game", prompt: "Profile the render loop and identify the regression.", status: "queued", output: "", depth: 0, createdAt: iso(19) },
    { id: "run-release", agentId: "release-sentinel", nodeId: "cloud-runner", harnessId: "codex-cli", model: "gpt-5.6-sol", workspace: "/workspace/release", prompt: "Review the release candidate.", status: "completed", output: "All required checks passed.", depth: 0, createdAt: iso(51), startedAt: iso(50), finishedAt: iso(34) }
  ],
  events: [
    { id: "evt-1", type: "run", title: "Ada queued a run", detail: "Waiting for Home server to reconnect", agentId: "cpp-steward", runId: "run-benchmark", createdAt: iso(18) },
    { id: "evt-2", type: "handoff", title: "Lin → Ada", detail: "Measure the frame-time regression before I change the interaction layer.", fromAgentId: "product-engineer", toAgentId: "cpp-steward", createdAt: iso(22) },
    { id: "evt-3", type: "status", title: "Sable cleared the release", detail: "126 checks passed · no blocking findings", agentId: "release-sentinel", runId: "run-release", createdAt: iso(34) }
  ],
  messages: [
    { id: "msg-1", agentId: "cpp-steward", author: "you", body: "The renderer picked up a 9 ms regression after the batching change. Find the cause and give Lin a safe fix path.", kind: "message", createdAt: iso(24) },
    { id: "msg-2", agentId: "cpp-steward", author: "agent", body: "I have a reproducible capture. The new material sort is invalidating the instance buffer twice per frame; I’m measuring the smallest correction now.", kind: "message", runId: "run-benchmark", createdAt: iso(5) },
    { id: "msg-3", agentId: "release-sentinel", author: "agent", body: "Release candidate is clear. All 126 required checks passed and I found no blocking diff-level risks.", kind: "message", runId: "run-release", createdAt: iso(34) }
  ]
});

export class Store {
  private state: State = seed();
  private readonly path: string;

  constructor(path = process.env.COFFEE_SHOP_DATA ?? fileURLToPath(new URL("../../../data/state.json", import.meta.url))) {
    this.path = resolve(path);
  }

  async load() {
    try {
      this.state = JSON.parse(await readFile(this.path, "utf8")) as State;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.save();
    }
  }

  snapshot(): Snapshot {
    return structuredClone({ ...this.state, generatedAt: new Date().toISOString() });
  }

  getAgent(id: string) { return this.state.agents.find((agent) => agent.id === id); }
  getRun(id: string) { return this.state.runs.find((run) => run.id === id); }

  async transact(change: (state: State) => void) {
    change(this.state);
    await this.save();
  }

  private async save() {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state, null, 2));
    await rename(temporary, this.path);
  }
}

export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
export const newMessage = (message: Omit<ChatMessage, "id" | "createdAt">): ChatMessage => ({ ...message, id: newId("msg"), createdAt: new Date().toISOString() });
export const newEvent = (event: Omit<TimelineEvent, "id" | "createdAt">): TimelineEvent => ({ ...event, id: newId("evt"), createdAt: new Date().toISOString() });
