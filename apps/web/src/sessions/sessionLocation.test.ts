import { describe, expect, it } from "vitest";
import { nonSessionsLocationSearch, parseSessionsLocation, removeOneTimeToken, sessionsLocationSearch } from "./sessionLocation.js";

describe("session location", () => {
  it("round-trips only a Coffee Shop session identity and preserves safe unrelated state", () => {
    expect(parseSessionsLocation("?theme=dark&view=sessions&session=host-session-one")).toEqual({ view: "sessions", sessionId: "host-session-one" });
    expect(sessionsLocationSearch("?theme=dark&providerSessionId=leak&cursor=opaque", "host-session-two")).toBe("?theme=dark&view=sessions&session=host-session-two");
    expect(nonSessionsLocationSearch("?theme=dark&view=sessions&session=host-session-two")).toBe("?theme=dark");
  });

  it("drops malformed, secret-like, and one-time credential values", () => {
    expect(parseSessionsLocation("?view=sessions&session=Authorization%3A+Bearer+canary")).toEqual({ view: "sessions" });
    expect(removeOneTimeToken("?theme=dark&token=SECRET&note=Bearer+SECRET&workspace=%2Fprivate")).toBe("?theme=dark");
  });
});
