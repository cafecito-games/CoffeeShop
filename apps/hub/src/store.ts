import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatMessage, Snapshot, TimelineEvent } from "@coffee-shop/protocol";

type State = Omit<Snapshot, "generatedAt">;

const emptyState = (): State => ({
  agents: [],
  nodes: [],
  runs: [],
  events: [],
  messages: []
});

export class Store {
  private state: State = emptyState();
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
