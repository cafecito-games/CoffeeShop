import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentAvatarColors,
  agentAvatarShapes,
  isTaskDependencyPolicy,
  isTaskStatus,
  orchestrationCollections,
  withOrchestrationDefaults,
  type ChatMessage,
  type Snapshot,
  type Thread,
  type TimelineEvent
} from "@coffee-shop/protocol";

/** The hub's durable record of one accepted task batch, used to answer idempotent replays. */
export interface TaskSubmission {
  id: string;
  threadId: string;
  sourceRunId: string;
  creatorAgentId: string;
  idempotencyKey: string;
  /** SHA-256 of the normalized batch; see `taskBatchDigest`. */
  digest: string;
  tasks: Array<{ key: string; taskId: string }>;
  createdAt: string;
}

/** Hub-internal collections that are persisted but never published in snapshots. */
interface HubOnlyState {
  taskSubmissions?: TaskSubmission[];
}

export type State = Omit<Snapshot, "generatedAt"> & HubOnlyState;

const emptyState = (): State => withOrchestrationDefaults({
  agents: [],
  nodes: [],
  runs: [],
  events: [],
  messages: [],
  threads: [],
  delegations: [],
  artifacts: [],
  taskSubmissions: []
});

export function addOrchestrationDefaults(state: State) {
  const changed = orchestrationCollections.some((collection) => state[collection] == null) || state.taskSubmissions == null;
  withOrchestrationDefaults(state);
  state.taskSubmissions ??= [];
  return changed;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * Rejects persisted orchestration records the hub cannot interpret. Loading fails rather than
 * defaulting an unknown status, because a guessed `pending` or `ready` could release work.
 */
export function assertPersistedTaskState(state: State) {
  const taskIds = new Set<string>();
  for (const [index, task] of (state.tasks ?? []).entries()) {
    const context = `Persisted task ${index}`;
    if (!isRecord(task) || !isNonEmptyString(task.id) || !isNonEmptyString(task.threadId)) throw new Error(`${context} is missing its identity`);
    if (taskIds.has(task.id)) throw new Error(`${context} repeats task id ${task.id}`);
    taskIds.add(task.id);
    if (!isTaskStatus(task.status)) throw new Error(`${context} has an unknown status`);
    if (!Array.isArray(task.dependencies) || !task.dependencies.every((dependency) => isRecord(dependency) && isNonEmptyString(dependency.taskId) && isTaskDependencyPolicy(dependency.policy))) {
      throw new Error(`${context} has malformed dependencies`);
    }
    if (!Array.isArray(task.attemptRunIds) || !task.attemptRunIds.every(isNonEmptyString)) throw new Error(`${context} has malformed attempts`);
    if (!isRecord(task.requirements) || typeof task.idempotencyKey !== "string") throw new Error(`${context} is missing requirements or its idempotency key`);
  }
  for (const [index, submission] of (state.taskSubmissions ?? []).entries()) {
    if (!isRecord(submission) || !isNonEmptyString(submission.id) || !isNonEmptyString(submission.threadId) || !isNonEmptyString(submission.idempotencyKey)
      || !isNonEmptyString(submission.digest) || !Array.isArray(submission.tasks)
      || !submission.tasks.every((entry) => isRecord(entry) && isNonEmptyString(entry.key) && isNonEmptyString(entry.taskId))) {
      throw new Error(`Persisted task submission ${index} is malformed`);
    }
  }
}

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

function addCoordinationDefaults(state: State) {
  let changed = false;
  if (!state.delegations) { state.delegations = []; changed = true; }
  if (!state.artifacts) { state.artifacts = []; changed = true; }
  if (!state.threads) { state.threads = []; changed = true; }
  for (const agent of state.agents) {
    if (agent.canDelegate === undefined) { agent.canDelegate = false; changed = true; }
  }
  return changed;
}

function addThreadDefaults(state: State) {
  let changed = false;
  state.threads ??= [];
  const runs = new Map(state.runs.map((run) => [run.id, run]));
  const threadIdsByRootRun = new Map<string, string>();
  const generatedThreadIds = new Set<string>();
  for (const run of state.runs) {
    if (run.threadId) {
      let cursor = run;
      const seen = new Set<string>();
      while (cursor.parentRunId && runs.has(cursor.parentRunId) && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        cursor = runs.get(cursor.parentRunId)!;
      }
      threadIdsByRootRun.set(cursor.id, run.threadId);
    }
  }
  for (const run of state.runs) {
    let root = run;
    const seen = new Set<string>();
    while (root.parentRunId && runs.has(root.parentRunId) && !seen.has(root.id)) {
      seen.add(root.id);
      root = runs.get(root.parentRunId)!;
    }
    let threadId = root.threadId ?? threadIdsByRootRun.get(root.id);
    if (!threadId) {
      const objective = typeof root.prompt === "string" && root.prompt.trim() ? root.prompt.trim() : `Recovered run ${root.id}`;
      const firstLine = objective.split(/\r?\n/, 1)[0].replace(/\s+/g, " ");
      const createdAt = typeof root.createdAt === "string" ? root.createdAt : new Date().toISOString();
      const thread: Thread = {
        id: newId("thread"), title: firstLine.length <= 120 ? firstLine : `${firstLine.slice(0, 119).trimEnd()}…`,
        objective, summary: "", status: "completed", ownerAgentId: root.agentId, createdBy: "user",
        createdAt, updatedAt: root.finishedAt ?? createdAt, completedAt: root.finishedAt ?? createdAt
      };
      state.threads.push(thread);
      generatedThreadIds.add(thread.id);
      threadId = thread.id;
      threadIdsByRootRun.set(root.id, threadId);
      changed = true;
    }
    if (!run.threadId) { run.threadId = threadId; changed = true; }
  }
  for (const thread of state.threads.filter((item) => generatedThreadIds.has(item.id))) {
    if (state.runs.some((run) => run.threadId === thread.id && (run.status === "queued" || run.status === "running"))) {
      thread.status = "active";
      thread.completedAt = undefined;
    }
  }
  const threadIdForRun = new Map(state.runs.map((run) => [run.id, run.threadId]));
  for (const delegation of state.delegations ?? []) {
    const threadId = threadIdForRun.get(delegation.parentRunId);
    if (!delegation.threadId && threadId) { delegation.threadId = threadId; changed = true; }
  }
  for (const artifact of state.artifacts ?? []) {
    const threadId = threadIdForRun.get(artifact.runId);
    if (!artifact.threadId && threadId) { artifact.threadId = threadId; changed = true; }
  }
  for (const event of state.events) {
    const threadId = event.runId && threadIdForRun.get(event.runId);
    if (!event.threadId && threadId) { event.threadId = threadId; changed = true; }
  }
  for (const message of state.messages) {
    const threadId = message.runId && threadIdForRun.get(message.runId);
    if (!message.threadId && threadId) { message.threadId = threadId; changed = true; }
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
    let loaded: State;
    try {
      loaded = JSON.parse(await readFile(this.path, "utf8")) as State;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.save();
      return;
    }
    const removedDemoRecords = removeLegacyDemoRecords(loaded);
    const addedAgentAvatars = addMissingAgentAvatars(loaded);
    const addedCoordination = addCoordinationDefaults(loaded);
    const addedThreads = addThreadDefaults(loaded);
    const addedOrchestration = addOrchestrationDefaults(loaded);
    assertPersistedTaskState(loaded);
    if (removedDemoRecords || addedAgentAvatars || addedCoordination || addedThreads || addedOrchestration) await this.save(loaded);
    this.state = loaded;
  }

  snapshot(): Snapshot {
    const { taskSubmissions: _taskSubmissions, ...published } = this.state;
    return structuredClone({ ...published, generatedAt: new Date().toISOString() });
  }

  /** Synchronous read of committed state; the view must not retain or mutate what it receives. */
  read<T>(view: (state: Readonly<State>) => T): T {
    return view(this.state);
  }

  getAgent(id: string) { return this.state.agents.find((agent) => agent.id === id); }
  getRun(id: string) { return this.state.runs.find((run) => run.id === id); }
  getThread(id: string) { return this.state.threads?.find((thread) => thread.id === id); }

  async writeArtifactContent(id: string, content: Buffer) {
    const directory = resolve(dirname(this.path), "artifacts");
    await mkdir(directory, { recursive: true });
    const destination = resolve(directory, id);
    const temporary = `${destination}.${process.pid}.tmp`;
    await writeFile(temporary, content);
    await rename(temporary, destination);
  }

  async readArtifactContent(id: string) {
    return readFile(resolve(dirname(this.path), "artifacts", id));
  }

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
