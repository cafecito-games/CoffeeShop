import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentAvatarColors, agentAvatarShapes, type ChatMessage, type Snapshot, type TimelineEvent } from "@coffee-shop/protocol";

export type State = Omit<Snapshot, "generatedAt">;

const emptyState = (): State => ({
  agents: [],
  nodes: [],
  runs: [],
  events: [],
  messages: []
});

const legacyDemoAgents = new Map([
  ["cpp-steward", "Ada"],
  ["product-engineer", "Lin"],
  ["release-sentinel", "Sable"],
  ["research-scout", "Mira"]
]);
const legacyDemoRunIds = new Set(["run-benchmark", "run-release"]);

function removeLegacyDemoRecords(state: State) {
  const agentIds = new Set(state.agents
    .filter((agent) => legacyDemoAgents.get(agent.id) === agent.name)
    .map((agent) => agent.id));
  const runIds = new Set(state.runs
    .filter((run) => legacyDemoRunIds.has(run.id) || agentIds.has(run.agentId))
    .map((run) => run.id));
  const before = [state.agents.length, state.nodes.length, state.runs.length, state.events.length, state.messages.length];

  state.agents = state.agents.filter((agent) => !agentIds.has(agent.id));
  state.runs = state.runs.filter((run) => !runIds.has(run.id));
  state.events = state.events.filter((event) =>
    !agentIds.has(event.agentId ?? "")
    && !agentIds.has(event.fromAgentId ?? "")
    && !agentIds.has(event.toAgentId ?? "")
    && !runIds.has(event.runId ?? ""));
  state.messages = state.messages.filter((message) =>
    !agentIds.has(message.agentId)
    && !runIds.has(message.runId ?? ""));

  const referencedNodeIds = new Set([
    ...state.agents.map((agent) => agent.computeNodeId),
    ...state.runs.map((run) => run.nodeId)
  ]);
  state.nodes = state.nodes.filter((node) => {
    const isDemoNode = (node.id === "local-macbook" && node.name === "This laptop" && node.workspaceRoots.includes("/Users/you/Projects"))
      || (node.id === "home-linux" && node.name === "Home server" && node.workspaceRoots.includes("/srv/workspaces"))
      || (node.id === "cloud-runner" && node.name === "Cloud runner" && node.workspaceRoots.includes("/workspace"));
    return !isDemoNode || referencedNodeIds.has(node.id);
  });

  const after = [state.agents.length, state.nodes.length, state.runs.length, state.events.length, state.messages.length];
  return before.some((length, index) => length !== after[index]);
}

function addMissingAgentAvatars(state: State) {
  let changed = false;
  for (const agent of state.agents) {
    if (!agentAvatarShapes.includes(agent.avatarShape)) {
      agent.avatarShape = "cup";
      changed = true;
    }
    if (!agentAvatarColors.includes(agent.avatarColor)) {
      agent.avatarColor = "amber";
      changed = true;
    }
  }
  return changed;
}

export class Store {
  private state: State = emptyState();
  private readonly path: string;
  private transactionQueue: Promise<void> = Promise.resolve();

  constructor(path = process.env.COFFEE_SHOP_DATA ?? fileURLToPath(new URL("../../../data/state.json", import.meta.url))) {
    this.path = resolve(path);
  }

  async load() {
    try {
      this.state = JSON.parse(await readFile(this.path, "utf8")) as State;
      const removedDemoRecords = removeLegacyDemoRecords(this.state);
      const addedAgentAvatars = addMissingAgentAvatars(this.state);
      if (removedDemoRecords || addedAgentAvatars) await this.save();
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

  async transact(change: (state: State) => unknown) {
    const transaction = this.transactionQueue.then(async () => {
      const next = structuredClone(this.state);
      if (change(next) === false) return;
      await this.save(next);
      this.state = next;
    });
    this.transactionQueue = transaction.catch(() => undefined);
    return transaction;
  }

  private async save(state = this.state) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2));
    await rename(temporary, this.path);
  }
}

export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
export const newMessage = (message: Omit<ChatMessage, "id" | "createdAt">): ChatMessage => ({ ...message, id: newId("msg"), createdAt: new Date().toISOString() });
export const newEvent = (event: Omit<TimelineEvent, "id" | "createdAt">): TimelineEvent => ({ ...event, id: newId("evt"), createdAt: new Date().toISOString() });
