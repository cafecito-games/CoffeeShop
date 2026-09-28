import { describe, expect, it, vi } from "vitest";
import { StableActions } from "./stableActions.js";

describe("StableActions", () => {
  it("reuses the exact key and arguments through transport and server uncertainty", async () => {
    const keys = ["one", "two"];
    const actions = new StableActions(() => keys.shift()!);
    const first = actions.idempotencyKey("renew:instance-one", { idleTimeoutSeconds: 1800 });
    expect(actions.idempotencyKey("renew:instance-one", { idleTimeoutSeconds: 1800 })).toBe(first);
    await expect(actions.submit("renew:instance-one", { idleTimeoutSeconds: 1800 }, async (key) => {
      expect(key).toBe(first);
      throw new TypeError("network failed");
    })).rejects.toThrow("network failed");
    expect(actions.pendingKey("renew:instance-one")).toBe(first);
  });

  it("settles on authoritative success/refusal or snapshot convergence, but retains a 5xx", async () => {
    const makeKey = vi.fn().mockReturnValueOnce("one").mockReturnValueOnce("two").mockReturnValueOnce("three");
    const actions = new StableActions(makeKey);
    await actions.submit("release:i", { mode: "drain" }, async () => ({ ok: false, status: 503 }));
    expect(actions.pendingKey("release:i")).toBe("web-one");
    await actions.submit("release:i", { mode: "drain" }, async () => ({ ok: true, status: 202 }));
    expect(actions.pendingKey("release:i")).toBeUndefined();
    await actions.submit("renew:i", {}, async () => ({ ok: false, status: 409 }));
    expect(actions.pendingKey("renew:i")).toBeUndefined();
    actions.idempotencyKey("create", { name: "one" });
    actions.settle("create");
    expect(actions.pendingKey("create")).toBeUndefined();
  });
});
