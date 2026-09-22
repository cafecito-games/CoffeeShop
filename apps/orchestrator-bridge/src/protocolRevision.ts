import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";

/**
 * Claude Code does not register a channel server that negotiates this MCP protocol revision, so the
 * bridge must never settle on it or anything newer. Revisions are ISO dates, which order correctly
 * as strings.
 */
export const channelIncompatibleProtocolRevision = "2026-07-28";

const isChannelCompatible = (revision: string) => revision < channelIncompatibleProtocolRevision;

/** Every revision the installed SDK supports that Claude Code will still accept as a channel. */
export const channelCompatibleProtocolRevisions: readonly string[] =
  [...SUPPORTED_PROTOCOL_VERSIONS].filter(isChannelCompatible).sort().reverse();

/**
 * The revision the bridge offers when the client asks for one it cannot use: the newest revision
 * that is both supported by the SDK and accepted by Claude Code's channel registration.
 */
export const pinnedProtocolRevision: string = (() => {
  const newest = channelCompatibleProtocolRevisions[0];
  if (newest === undefined) {
    throw new Error(`no MCP protocol revision older than ${channelIncompatibleProtocolRevision} is supported by the installed SDK`);
  }
  return newest;
})();

/**
 * Negotiates the revision for one `initialize` request. A requested revision is honoured only when
 * the SDK supports it and it stays below the channel-incompatible cutoff; anything else falls back
 * to the pin rather than to the SDK's latest revision.
 */
export function negotiateProtocolRevision(requestedRevision: unknown): string {
  if (typeof requestedRevision !== "string") return pinnedProtocolRevision;
  if (!channelCompatibleProtocolRevisions.includes(requestedRevision)) return pinnedProtocolRevision;
  return requestedRevision;
}
