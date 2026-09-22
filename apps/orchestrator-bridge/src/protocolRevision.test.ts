import assert from "node:assert/strict";
import { test } from "node:test";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import {
  channelCompatibleProtocolRevisions,
  channelIncompatibleProtocolRevision,
  negotiateProtocolRevision,
  pinnedProtocolRevision
} from "./protocolRevision.js";

test("the pin stays below the revision Claude Code will not register as a channel", () => {
  assert.ok(pinnedProtocolRevision < channelIncompatibleProtocolRevision);
  for (const revision of channelCompatibleProtocolRevisions) {
    assert.ok(revision < channelIncompatibleProtocolRevision, `${revision} is not channel compatible`);
  }
});

test("the pin is the newest channel-compatible revision the SDK supports", () => {
  const expected = [...SUPPORTED_PROTOCOL_VERSIONS].filter((revision) => revision < channelIncompatibleProtocolRevision).sort().at(-1);
  assert.equal(pinnedProtocolRevision, expected);
});

test("an SDK revision at or above the cutoff is never offered", () => {
  assert.ok(!channelCompatibleProtocolRevisions.includes(channelIncompatibleProtocolRevision));
  if (LATEST_PROTOCOL_VERSION >= channelIncompatibleProtocolRevision) {
    assert.notEqual(pinnedProtocolRevision, LATEST_PROTOCOL_VERSION);
  }
});

test("a supported channel-compatible request is honoured", () => {
  for (const revision of channelCompatibleProtocolRevisions) {
    assert.equal(negotiateProtocolRevision(revision), revision);
  }
});

test("an incompatible, unknown, or non-string request falls back to the pin", () => {
  for (const requested of [channelIncompatibleProtocolRevision, "2099-01-01", "nonsense", "", undefined, null, 20260728, {}]) {
    assert.equal(negotiateProtocolRevision(requested), pinnedProtocolRevision);
  }
});
