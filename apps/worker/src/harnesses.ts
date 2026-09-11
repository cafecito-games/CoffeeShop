import { spawn, type ChildProcess } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Agent, HarnessId, Run } from "@coffee-shop/protocol";

export interface HarnessCallbacks {
  output(chunk: string): void;
}

export interface RunningHarness {
  process: ChildProcess;
  result: Promise<string>;
}

export async function assertWorkspaceAllowed(workspace: string, roots: string[]) {
  if (!isAbsolute(workspace)) throw new Error("Workspace must be an absolute path");
  const actual = await realpath(workspace);
  const allowed = await Promise.all(roots.map(async (root) => realpath(resolve(root))));
  if (!allowed.some((root) => { const rel = relative(root, actual); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); })) {
    throw new Error(`Workspace ${actual} is outside this worker's allowed roots`);
  }
  return actual;
}

const handoffContract = `\n\nYou are running inside Coffee Shop. If another specialist should continue a bounded task, end your response with exactly <handoff to="agent-id">task and context</handoff>. Use only an agent id you were given. Handoffs are visible and capped; do not delegate reflexively.`;

function commandFor(run: Run, agent: Agent) {
  const prompt = `${agent.systemPrompt}${handoffContract}\n\nAvailable teammate ids may be listed by the control plane.\n\nUser task:\n${run.prompt}`;
  if (run.harnessId === "claude-cli") {
    return { binary: "claude", args: ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "auto", "--permission-prompts", "none", "--model", run.model] };
  }
  if (run.harnessId === "codex-cli") {
    const model = run.model && run.model !== "default" ? ["--model", run.model] : [];
    return { binary: "codex", args: ["exec", "--json", "--sandbox", "workspace-write", ...model, prompt] };
  }
  throw new Error(`Harness ${run.harnessId satisfies HarnessId} is not executable by this worker yet`);
}

function readableEvent(harness: HarnessId, line: string) {
  try {
    const event = JSON.parse(line) as Record<string, any>;
    if (harness === "claude-cli") {
      if (event.type === "assistant") {
        return (event.message?.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("");
      }
      if (event.type === "result" && typeof event.result === "string") return event.result;
    }
    if (harness === "codex-cli" && event.type === "item.completed") {
      if (event.item?.type === "agent_message") return event.item.text ?? "";
      if (event.item?.type === "command_execution") return `Ran ${event.item.command ?? "command"}\n`;
    }
  } catch { /* retain raw stderr only */ }
  return "";
}

export function startHarness(run: Run, agent: Agent, cwd: string, callbacks: HarnessCallbacks): RunningHarness {
  const command = commandFor(run, agent);
  const child = spawn(command.binary, command.args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let final = "";
  let stderr = "";
  let buffer = "";

  child.stdout!.on("data", (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const readable = readableEvent(run.harnessId, line);
      if (readable) { final = readable; callbacks.output(readable); }
    }
  });
  child.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });

  const result = new Promise<string>((resolveResult, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (buffer) { const readable = readableEvent(run.harnessId, buffer); if (readable) final = readable; }
      if (code === 0) resolveResult(final.trim() || "Run completed without a text response.");
      else reject(new Error(stderr.trim() || `${command.binary} exited with ${code ?? signal}`));
    });
  });
  return { process: child, result };
}
