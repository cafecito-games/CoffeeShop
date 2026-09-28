import { describe, expect, it } from "vitest";
import type { AgentInstance, ComputeNode, InstanceAllocation, Run, Task } from "@coffee-shop/protocol";
import { allocationHistory, capacityFor, currentAllocationFor, exactCurrentRuns, exactCurrentTasks, visibleInstances } from "./instancePresentation.js";

const at = "2026-09-28T12:00:00.000Z";
const instance = (status: AgentInstance["status"] = "ready"): AgentInstance => ({
  id: "instance-one", threadId: "thread-one", creator: { kind: "operator", operatorId: "operator" },
  delegation: { canDelegate: false }, requirements: {}, lease: { idleTimeoutSeconds: 1800, expiresAt: at },
  status, createdAt: at, updatedAt: at
});
const allocation = (id: string, status: InstanceAllocation["status"], instanceId = "instance-one"): InstanceAllocation => ({
  id, instanceId, nodeId: "node-one", harnessId: "codex-cli", model: "default", transport: "native-cli",
  workspace: "/workspace", lease: { idleTimeoutSeconds: 1800, expiresAt: at }, status, createdAt: at, updatedAt: at
});

describe("instance presentation is identity-exact and fail closed", () => {
  it("distinguishes missing, one, and multiple occupying allocations without guessing", () => {
    expect(currentAllocationFor(instance().id, [allocation("old", "released")])).toEqual({ kind: "unavailable" });
    expect(currentAllocationFor(instance().id, [allocation("current", "active")])).toMatchObject({ kind: "current", allocation: { id: "current" } });
    expect(currentAllocationFor(instance().id, [allocation("a", "reserved"), allocation("b", "active")])).toMatchObject({ kind: "inconsistent" });
  });

  it("correlates work only by exact instance and, when carried, current allocation", () => {
    const current = currentAllocationFor(instance().id, [allocation("allocation-one", "active")]);
    const run = (id: string, instanceId?: string, allocationId?: string): Run => ({
      id, threadId: "thread-one", instanceId, allocationId, nodeId: "node-one", harnessId: "codex-cli", model: "default",
      workspace: "/workspace", prompt: id, status: "running", output: "", depth: 0, createdAt: at
    });
    expect(exactCurrentRuns(instance().id, current, [
      run("exact", "instance-one", "allocation-one"), run("instance-only", "instance-one"),
      run("wrong-instance", "instance-two", "allocation-one"), run("old-allocation", "instance-one", "allocation-old")
    ]).map((item) => item.id)).toEqual(["exact", "instance-only"]);
    const task = (id: string, instanceId: string, allocationId: string): Task => ({
      id, threadId: "thread-one", title: id, instructions: id, status: "running", requirements: {}, dependencies: [],
      assignment: { runId: `run-${id}`, instanceId, allocationId, nodeId: "node-one", harnessId: "codex-cli", transport: "native-cli", model: "default", assignedAt: at }, idempotencyKey: id, attemptRunIds: [], createdAt: at, updatedAt: at
    });
    const waiting = { ...task("waiting", "instance-two", "allocation-old"), assignment: undefined, placementInstanceId: "instance-one" };
    expect(exactCurrentTasks(instance().id, current, [task("exact", "instance-one", "allocation-one"), task("other", "instance-one", "allocation-old"), waiting]).map((item) => item.id)).toEqual(["exact", "waiting"]);
  });

  it("keeps allocation history exact and terminals behind an intentional history choice", () => {
    expect(allocationHistory("instance-one", [allocation("own", "released"), allocation("foreign", "active", "instance-two")]).map((item) => item.id)).toEqual(["own"]);
    expect(visibleInstances([instance("draining"), { ...instance("released"), id: "released" }], false).map((item) => item.status)).toEqual(["draining"]);
    expect(visibleInstances([instance("draining"), { ...instance("released"), id: "released" }], true)).toHaveLength(2);
  });

  it("renders absent capacity, explicit zero, and unknown usage as distinct evidence", () => {
    const current = currentAllocationFor(instance().id, [allocation("current", "active")]);
    const node = (extra: Partial<ComputeNode>): ComputeNode => ({
      id: "node-one", name: "Desk", kind: "local", platform: "linux", status: "online", lastSeen: at,
      activeRuns: 0, concurrency: 1, workspaceRoots: ["/workspace"], harnesses: [], version: "test", ...extra
    });
    expect(capacityFor(current, [node({})]).kind).toBe("incapable");
    expect(capacityFor(current, [node({ instanceCapacity: 2 })]).kind).toBe("unknown");
    expect(capacityFor(current, [node({ instanceCapacity: 2, activeInstances: 0 })])).toMatchObject({ kind: "reported", active: 0 });
  });
});
