import { isHostHarnessSessionId, type HostHarnessSessionId } from "@coffee-shop/protocol";

export interface SessionsLocation {
  view?: "sessions";
  sessionId?: HostHarnessSessionId;
}

const forbiddenKeys = /^(token|access_token|authorization|provider(session)?id|workspace|prompt|endpoint|cursor|filter)$/i;
const secretLike = /(authorization|bearer|api[_-]?key|secret|token|password)/i;

function safePreservedEntries(search: string) {
  return [...new URLSearchParams(search).entries()].filter(([key, value]) =>
    key !== "view" && key !== "session" && !forbiddenKeys.test(key) && !secretLike.test(value)
    && key.length <= 64 && value.length <= 256
  );
}

export function parseSessionsLocation(search: string): SessionsLocation {
  const params = new URLSearchParams(search);
  if (params.get("view") !== "sessions") return {};
  const candidate = params.get("session");
  return { view: "sessions", ...(isHostHarnessSessionId(candidate) && !secretLike.test(candidate) ? { sessionId: candidate } : {}) };
}

export function sessionsLocationSearch(currentSearch: string, sessionId?: HostHarnessSessionId) {
  const params = new URLSearchParams(safePreservedEntries(currentSearch));
  params.set("view", "sessions");
  if (sessionId !== undefined && isHostHarnessSessionId(sessionId)) params.set("session", sessionId);
  return `?${params.toString()}`;
}

export function nonSessionsLocationSearch(currentSearch: string) {
  const params = new URLSearchParams(safePreservedEntries(currentSearch));
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

export function removeOneTimeToken(currentSearch: string) {
  const params = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(currentSearch)) {
    if (key.toLowerCase() !== "token" && !forbiddenKeys.test(key) && !secretLike.test(value) && key.length <= 64 && value.length <= 256) {
      params.append(key, value);
    }
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}
