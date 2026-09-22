import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpAgentCapabilities, HarnessSessionBinding, HarnessSessionBindingUpdate, OrchestratorInbox, OrchestratorWake, OrchestratorWakeStatus, Run } from "@coffee-shop/protocol";
import { fixtureAgent, fixtureRun, fixtureTime, orchestrationStore, rootRunId } from "./hubToolsTestSupport.js";
import { applyRunLifecycle, cancelRunInState } from "./lifecycle.js";
import { dispatchMessageFor } from "./scheduler.js";
import { acceptSessionBinding, retainedTerminalSessionBindings, sessionDispatchFor, settleSessionBindingsForTerminalRun, type SessionBindingOutcome } from "./sessionBindings.js";
import { Store, type State } from "./store.js";

const later = (minutes: number) => new Date(Date.parse(fixtureTime) + minutes * 60_000).toISOString();

const resumable: AcpAgentCapabilities = {
  protocolVersion: 1, loadSession: false, resumeSession: true,
  prompt: { image: false, audio: false, embeddedContext: false }, mcp: { http: true, sse: false }
};

const runId = "run-binding";

function acpRun(overrides: Partial<Run> = {}): Run {
  return fixtureRun(runId, "thread-one", "orchestrator", {
    status: "queued", startedAt: undefined, transport: "acp-v1", dispatchedAt: fixtureTime, ...overrides
  });
}

function binding(overrides: Partial<HarnessSessionBinding> = {}): HarnessSessionBinding {
  return {
    id: "session-one", threadId: "thread-one", agentId: "orchestrator", nodeId: "node-orchestrator", harnessId: "codex-cli",
    transport: "acp-v1", workspace: "/workspace/orchestrator", providerSessionId: "provider-one", status: "idle",
    createdByRunId: rootRunId, lastRunId: rootRunId, capabilities: resumable, createdAt: fixtureTime, updatedAt: fixtureTime, ...overrides
  };
}

const activeReport = (providerSessionId: string, overrides: Partial<HarnessSessionBindingUpdate> = {}): HarnessSessionBindingUpdate => ({
  providerSessionId, harnessId: "codex-cli", transport: "acp-v1", status: "active", ...overrides
});

interface AttemptResult {
  outcome: SessionBindingOutcome;
  before: string;
  after: string;
}

/**
 * Runs one scenario inside a transaction that is not committed, so a battery of rejections can
 * reuse the same fixture store and any mutation the scenario needs stays local to it.
 */
async function attempt(store: Store, setup: (state: State) => void, action: (state: State) => SessionBindingOutcome): Promise<AttemptResult> {
  let captured: AttemptResult | undefined;
  await store.transact((state) => {
    setup(state);
    const footprint = (current: State) => JSON.stringify({ runs: current.runs, sessionBindings: current.sessionBindings ?? [] });
    const before = footprint(state);
    const outcome = action(state);
    captured = { outcome, before, after: footprint(state) };
    return false;
  });
  return captured!;
}

test("a session report that does not match its run is rejected without changing state", async () => {
  const store = await orchestrationStore();
  const secretSessionId = `sk-ant-api03-${"A".repeat(40)}`;
  const secretBindingId = `ghp_${"a1".repeat(18)}`;
  const cases: Array<{ name: string; run: Run; update: HarnessSessionBindingUpdate; nodeId?: string; bindings?: HarnessSessionBinding[]; omitRun?: boolean }> = [
    { name: "unknown run", run: acpRun(), update: activeReport("provider-new"), omitRun: true },
    { name: "run on another node", run: acpRun(), update: activeReport("provider-new"), nodeId: "node-worker-a" },
    { name: "run without a thread", run: acpRun({ threadId: undefined }), update: activeReport("provider-new") },
    { name: "run on the native transport", run: acpRun({ transport: undefined }), update: activeReport("provider-new") },
    { name: "report on the native transport", run: acpRun(), update: activeReport("provider-new", { transport: "native-cli" }) },
    { name: "report naming a different harness", run: acpRun(), update: activeReport("provider-new", { harnessId: "claude-cli" }) },
    { name: "report of a session that is not established", run: acpRun(), update: activeReport("provider-new", { status: "idle" }) },
    { name: "run queued without a dispatch", run: acpRun({ dispatchedAt: undefined }), update: activeReport("provider-new") },
    { name: "run already completed", run: acpRun({ status: "completed" }), update: activeReport("provider-new") },
    { name: "run already failed", run: acpRun({ status: "failed" }), update: activeReport("provider-new") },
    { name: "run already cancelled", run: acpRun({ status: "cancelled" }), update: activeReport("provider-new") },
    {
      name: "new session for a run that already started", run: acpRun({ status: "running", startedAt: fixtureTime }),
      update: activeReport("provider-new")
    },
    {
      name: "binding id the run does not name", run: acpRun({ sessionBindingId: "session-missing" }),
      update: activeReport("provider-one", { bindingId: "session-missing" })
    },
    {
      name: "binding id while the run names none", run: acpRun(),
      update: activeReport("provider-one", { bindingId: "session-one" })
    },
    {
      name: "binding id with a different provider session", run: acpRun({ sessionBindingId: "session-one" }),
      update: activeReport("provider-two", { bindingId: "session-one" }),
      bindings: [binding()]
    },
    {
      name: "resume of a replaced binding", run: acpRun({ sessionBindingId: "session-one" }),
      update: activeReport("provider-one", { bindingId: "session-one" }),
      bindings: [binding({ status: "replaced" })]
    },
    {
      name: "resume of a failed binding", run: acpRun({ sessionBindingId: "session-one" }),
      update: activeReport("provider-one", { bindingId: "session-one" }),
      bindings: [binding({ status: "failed" })]
    },
    {
      name: "new session owned by another binding", run: acpRun(),
      update: activeReport("provider-taken"),
      bindings: [binding({ id: "session-other", providerSessionId: "provider-taken", status: "active", createdByRunId: rootRunId, lastRunId: "run-elsewhere" })]
    },
    {
      name: "provider session id that looks like a credential", run: acpRun(),
      update: activeReport(secretSessionId)
    },
    {
      name: "binding id that looks like a credential", run: acpRun(),
      update: activeReport("provider-new", { bindingId: secretBindingId })
    }
  ];
  for (const scenario of cases) {
    const result = await attempt(store, (state) => {
      if (!scenario.omitRun) state.runs.unshift(scenario.run);
      if (scenario.bindings) state.sessionBindings = [...scenario.bindings];
    }, (state) => acceptSessionBinding(state, scenario.nodeId ?? "node-orchestrator", scenario.run.id, scenario.update, later(1)));
    assert.equal(result.outcome.kind, "rejected", scenario.name);
    assert.equal(result.after, result.before, scenario.name);
    if (result.outcome.kind === "rejected") {
      assert.ok(!result.outcome.reason.includes(scenario.update.providerSessionId), `${scenario.name}: ${result.outcome.reason}`);
      if (scenario.update.bindingId !== undefined) assert.ok(!result.outcome.reason.includes(scenario.update.bindingId), scenario.name);
    }
  }
});

test("a resumed report activates an idle binding and exact replays are duplicates", async () => {
  const store = await orchestrationStore();
  const report = activeReport("provider-one", { bindingId: "session-one" });
  const first = await attempt(store, (state) => {
    state.runs.unshift(acpRun({ sessionBindingId: "session-one" }));
    state.sessionBindings = [binding()];
  }, (state) => acceptSessionBinding(state, "node-orchestrator", runId, report, later(1)));
  assert.equal(first.outcome.kind, "resumed");
  const resumed = JSON.parse(first.after).sessionBindings[0] as HarnessSessionBinding;
  assert.equal(resumed.status, "active");
  assert.equal(resumed.lastRunId, runId);

  const running = await attempt(store, (state) => {
    state.runs.unshift(acpRun({ status: "running", startedAt: later(1), sessionBindingId: "session-one" }));
    state.sessionBindings = [binding({ status: "active", lastRunId: runId, updatedAt: later(1) })];
  }, (state) => acceptSessionBinding(state, "node-orchestrator", runId, report, later(2)));
  assert.equal(running.outcome.kind, "duplicate");
  assert.equal(running.after, running.before, "a replay while the run is running changes nothing");
});

test("a report without a binding id creates a binding, replaces the one the run named, and treats replays as duplicates", async () => {
  const store = await orchestrationStore();
  const created = await attempt(store, (state) => {
    state.runs.unshift(acpRun({ workspaceLeaseId: "lease-one" }));
  }, (state) => acceptSessionBinding(state, "node-orchestrator", runId, activeReport("provider-new"), later(1)));
  assert.equal(created.outcome.kind, "created");
  if (created.outcome.kind !== "created") return;
  const createdBinding = created.outcome.binding;
  assert.equal(createdBinding.status, "active");
  assert.equal(createdBinding.createdByRunId, runId);
  assert.equal(createdBinding.lastRunId, runId);
  assert.equal(createdBinding.workspace, "/workspace/orchestrator");
  assert.equal(createdBinding.workspaceLeaseId, "lease-one");
  const runAfterCreate = JSON.parse(created.after).runs.find((item: Run) => item.id === runId);
  assert.equal(runAfterCreate.sessionBindingId, createdBinding.id);

  const replay = await attempt(store, (state) => {
    state.runs.unshift(acpRun({ sessionBindingId: createdBinding.id }));
    state.sessionBindings = [structuredClone(createdBinding)];
  }, (state) => acceptSessionBinding(state, "node-orchestrator", runId, activeReport("provider-new"), later(2)));
  assert.equal(replay.outcome.kind, "duplicate");
  assert.equal(replay.after, replay.before);

  const replacing = await attempt(store, (state) => {
    state.runs.unshift(acpRun({ sessionBindingId: "session-one" }));
    state.sessionBindings = [binding()];
  }, (state) => acceptSessionBinding(state, "node-orchestrator", runId, activeReport("provider-replacement"), later(3)));
  assert.equal(replacing.outcome.kind, "created");
  if (replacing.outcome.kind === "created") {
    assert.equal(replacing.outcome.replacedBindingId, "session-one");
    const bindings = JSON.parse(replacing.after).sessionBindings as HarnessSessionBinding[];
    const previous = bindings.find((item) => item.id === "session-one")!;
    assert.equal(previous.status, "replaced");
    assert.equal(previous.replacedByBindingId, replacing.outcome.binding.id);
  }

  const redispatch = await attempt(store, (state) => {
    state.runs.unshift(acpRun());
  }, (state) => {
    const firstOutcome = acceptSessionBinding(state, "node-orchestrator", runId, activeReport("provider-first"), later(4));
    assert.equal(firstOutcome.kind, "created");
    return acceptSessionBinding(state, "node-orchestrator", runId, activeReport("provider-second"), later(5));
  });
  assert.equal(redispatch.outcome.kind, "created");
  if (redispatch.outcome.kind === "created") {
    assert.equal(redispatch.outcome.replacedBindingId !== undefined, true);
    const bindings = JSON.parse(redispatch.after).sessionBindings as HarnessSessionBinding[];
    const earlier = bindings.find((item) => item.providerSessionId === "provider-first")!;
    assert.equal(earlier.status, "replaced");
    assert.equal(earlier.replacedByBindingId, redispatch.outcome.binding.id);
  }
});

test("a terminal run settles its bindings: idle with capabilities only after a completed ACP turn", async () => {
  const store = await orchestrationStore();
  const scenarios: Array<{
    name: string;
    lifecycle: Array<Parameters<typeof applyRunLifecycle>[1]>;
    cancel?: boolean;
    expected: "idle" | "failed" | "unchanged";
  }> = [
    {
      name: "completed ACP turn",
      lifecycle: [
        { type: "run.started", runId, at: later(1), transport: { requestedTransport: "acp-v1", selectedTransport: "acp-v1", acp: resumable } },
        { type: "run.completed", runId, output: "Done", at: later(2) }
      ],
      expected: "idle"
    },
    {
      name: "completed native turn",
      lifecycle: [
        { type: "run.started", runId, at: later(1) },
        { type: "run.completed", runId, output: "Done", at: later(2) }
      ],
      expected: "failed"
    },
    {
      name: "failed ACP turn",
      lifecycle: [
        { type: "run.started", runId, at: later(1), transport: { requestedTransport: "acp-v1", selectedTransport: "acp-v1", acp: resumable } },
        { type: "run.failed", runId, error: "Crashed", at: later(2) }
      ],
      expected: "failed"
    }
  ];
  for (const scenario of scenarios) {
    await store.transact((state) => {
      state.runs.unshift(acpRun({ sessionBindingId: "session-one" }));
      state.sessionBindings = [binding({ status: "active", lastRunId: runId, capabilities: undefined })];
      for (const message of scenario.lifecycle) applyRunLifecycle(state, message);
      const settled = state.sessionBindings![0];
      if (scenario.expected === "idle") {
        assert.equal(settled.status, "idle", scenario.name);
        assert.deepEqual(settled.capabilities, resumable, scenario.name);
      } else {
        assert.equal(settled.status, "failed", scenario.name);
      }
      return true;
    });
  }

  await store.transact((state) => {
    state.runs.unshift(acpRun({ sessionBindingId: "session-one" }));
    state.sessionBindings = [binding()];
    applyRunLifecycle(state, { type: "run.failed", runId, error: "Never started", at: later(1) });
    assert.equal(state.sessionBindings![0].status, "failed", "a run that failed before its prompt fails the binding it asked to resume");
    return true;
  });

  await store.transact((state) => {
    state.runs.unshift(acpRun({ sessionBindingId: "session-one" }));
    state.sessionBindings = [binding()];
    cancelRunInState(state, runId, later(1));
    assert.equal(state.sessionBindings![0].status, "idle", "a cancelled run leaves the binding it named idle");
    return true;
  });

  await store.transact((state) => {
    state.runs.unshift(acpRun({ status: "running", startedAt: later(1) }));
    state.sessionBindings = [binding()];
    settleSessionBindingsForTerminalRun(state, "run-unknown", later(2));
    assert.equal(state.sessionBindings![0].status, "idle", "an unrelated terminal run settles nothing");
    return true;
  });
});

test("terminal bindings are pruned oldest first beyond the retained count and active ones are kept", async () => {
  const store = await orchestrationStore();
  const terminalCount = retainedTerminalSessionBindings + 1;
  await store.transact((state) => {
    state.runs.unshift(acpRun());
    state.sessionBindings = [
      binding({ id: "session-active", status: "active", lastRunId: runId, providerSessionId: "provider-active" }),
      ...Array.from({ length: terminalCount }, (_, index) => binding({
        id: `session-old-${index}`, status: "failed", providerSessionId: `provider-old-${index}`,
        createdAt: new Date(Date.parse(fixtureTime) + index * 1000).toISOString()
      }))
    ];
    const outcome = acceptSessionBinding(state, "node-orchestrator", runId, activeReport("provider-new"), later(1));
    assert.equal(outcome.kind, "created");
    const bindings = state.sessionBindings!;
    const terminal = bindings.filter((item) => item.status === "closed" || item.status === "replaced" || item.status === "failed");
    assert.equal(terminal.length, retainedTerminalSessionBindings);
    assert.equal(bindings.some((item) => item.id === "session-old-0"), false, "the oldest terminal binding is pruned first");
    assert.equal(bindings.some((item) => item.id === "session-old-1"), true);
    assert.equal(bindings.some((item) => item.id === "session-active"), true, "a non-terminal binding is never pruned");
    assert.equal(bindings.some((item) => item.providerSessionId === "provider-new"), true);
    return true;
  });
});

test("a dispatch carries the session binding only while the named binding is resumable", () => {
  const agent = fixtureAgent("orchestrator");
  const plainRun = acpRun();
  const withoutBinding = sessionDispatchFor(plainRun, { sessionBindings: [binding()], orchestratorInboxes: [] });
  assert.equal(withoutBinding.run, plainRun);
  assert.equal(withoutBinding.sessionBinding, undefined);

  const nonResumable: Partial<HarnessSessionBinding>[] = [
    { nodeId: "node-worker-a" },
    { agentId: "worker-a" },
    { harnessId: "claude-cli" },
    { workspace: "/workspace/elsewhere" },
    { threadId: "thread-two" },
    { workspaceLeaseId: "lease-one" },
    { capabilities: undefined },
    { capabilities: { ...resumable, resumeSession: false, loadSession: false } },
    { status: "replaced" },
    { status: "failed" },
    { status: "closed" },
    { status: "active", lastRunId: "run-elsewhere" }
  ];
  for (const overrides of nonResumable) {
    const run = acpRun({ sessionBindingId: "session-one" });
    const result = sessionDispatchFor(run, { sessionBindings: [binding(overrides)], orchestratorInboxes: [] });
    assert.equal("sessionBindingId" in result.run, false, JSON.stringify(overrides));
    assert.equal(result.sessionBinding, undefined, JSON.stringify(overrides));
    const message = dispatchMessageFor(run, agent, [agent], [], { sessionBindings: [binding(overrides)], orchestratorInboxes: [] });
    assert.equal(message.execution?.sessionBinding, undefined, JSON.stringify(overrides));
    assert.equal("sessionBindingId" in message.run, false, JSON.stringify(overrides));
  }

  const run = acpRun({ sessionBindingId: "session-one" });
  const wake = (status: OrchestratorWakeStatus): OrchestratorInbox => ({
    threadId: "thread-one", deliveredThrough: 0, processedThrough: 0, generation: 1, redeliveries: 0, consecutiveFailures: 0, updatedAt: fixtureTime,
    wakes: [{
      id: "wake-one", generation: 1, runId, fromSequence: 0, throughSequence: 1, eventSequences: [1], redelivery: false,
      requestedSessionBindingId: "session-one", ...(status === "scheduled" ? { resumePrompt: "resume prompt" } : {}),
      status, createdAt: fixtureTime, updatedAt: fixtureTime
    }]
  });
  const scheduled = sessionDispatchFor(run, { sessionBindings: [binding()], orchestratorInboxes: [wake("scheduled")] });
  assert.deepEqual(scheduled.sessionBinding, { id: "session-one", providerSessionId: "provider-one", resumePrompt: "resume prompt" });
  const delivered = sessionDispatchFor(run, { sessionBindings: [binding()], orchestratorInboxes: [wake("delivered")] });
  assert.deepEqual(delivered.sessionBinding, { id: "session-one", providerSessionId: "provider-one" });
  assert.equal("sessionBindingId" in delivered.run, true);
  assert.equal(dispatchMessageFor(run, agent, [agent], [], { sessionBindings: [binding()], orchestratorInboxes: [wake("scheduled")] }).execution?.sessionBinding?.resumePrompt, "resume prompt");

  const redispatched = sessionDispatchFor(acpRun({ sessionBindingId: "session-one" }), {
    sessionBindings: [binding({ status: "active", lastRunId: runId })], orchestratorInboxes: []
  });
  assert.equal(redispatched.sessionBinding?.id, "session-one");

  const nativeRun = fixtureRun("run-plain", "thread-one", "orchestrator", { transport: undefined });
  const plainMessage = dispatchMessageFor(nativeRun, agent, [agent], [], {});
  assert.equal("execution" in plainMessage, false, "a plain non-task run carries no execution block");
});

test("loading persisted session state rejects bindings and inboxes the hub cannot interpret", async () => {
  const template = await orchestrationStore();
  const baseState = template.read((state) => JSON.parse(JSON.stringify(state)) as State);
  const validBinding = binding({ status: "active", lastRunId: rootRunId, capabilities: undefined });
  const validWake: OrchestratorWake = {
    id: "wake-one", generation: 1, runId, fromSequence: 0, throughSequence: 1, eventSequences: [1], redelivery: false,
    status: "scheduled", createdAt: fixtureTime, updatedAt: fixtureTime
  };
  const validInbox: OrchestratorInbox = {
    threadId: "thread-one", deliveredThrough: 0, processedThrough: 0, generation: 1, redeliveries: 0, consecutiveFailures: 0,
    wakes: [validWake], updatedAt: fixtureTime
  };
  const directory = await mkdtemp(join(tmpdir(), "coffee-shop-session-bindings-"));
  const loadWith = async (mutate: (state: State) => void) => {
    const state = structuredClone(baseState);
    mutate(state);
    const path = join(directory, `state-${Math.random().toString(36).slice(2, 8)}.json`);
    await writeFile(path, JSON.stringify(state));
    await new Store(path).load();
  };
  await assert.rejects(loadWith((state) => { state.sessionBindings = [{ ...validBinding, status: "paused" } as unknown as HarnessSessionBinding]; }));
  await assert.rejects(loadWith((state) => { state.sessionBindings = [{ ...validBinding, transport: "carrier-pigeon" } as unknown as HarnessSessionBinding]; }));
  await assert.rejects(loadWith((state) => { state.sessionBindings = [validBinding, { ...validBinding, providerSessionId: "provider-two" }]; }));
  await assert.rejects(loadWith((state) => { state.orchestratorInboxes = [{ ...validInbox, processedThrough: -1 } as unknown as OrchestratorInbox]; }));
  await assert.rejects(loadWith((state) => { state.orchestratorInboxes = [{ ...validInbox, processedThrough: 1.5 } as unknown as OrchestratorInbox]; }));
  await assert.rejects(loadWith((state) => { state.orchestratorInboxes = [validInbox, { ...validInbox }]; }));
  await assert.rejects(loadWith((state) => { state.orchestratorInboxes = [{ ...validInbox, wakes: [{ ...validWake, status: "sleeping" } as unknown as OrchestratorWake] }]; }));
  await assert.rejects(loadWith((state) => { state.orchestratorInboxes = [{ ...validInbox, wakes: [{ ...validWake, fromSequence: 5, throughSequence: 2 }] }]; }));

  const wellFormed = join(directory, "state-well-formed.json");
  await writeFile(wellFormed, JSON.stringify({ ...structuredClone(baseState), sessionBindings: [validBinding], orchestratorInboxes: [validInbox] }));
  const loaded = new Store(wellFormed);
  await loaded.load();
  assert.equal(loaded.read((state) => state.sessionBindings?.length), 1);

  const withoutInboxes = join(directory, "state-without-inboxes.json");
  const trimmed = structuredClone(baseState);
  delete trimmed.orchestratorInboxes;
  await writeFile(withoutInboxes, JSON.stringify(trimmed));
  const defaulted = new Store(withoutInboxes);
  await defaulted.load();
  assert.deepEqual(defaulted.read((state) => state.orchestratorInboxes), []);
});
