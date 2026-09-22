# External Claude Code orchestrator

## Goal

Let an operator's own interactive Claude Code session create a Coffee Shop thread and act as that thread's orchestrator, while the hub keeps distributing the work across Barista nodes, harnesses, and providers exactly as it does for hub-hosted orchestrators. Worker events wake the idle Claude Code session through Claude Code channels.

Having Claude Code launch a hub-hosted orchestrator on a node is a separate feature and is not part of this design.

## Decisions

| Question | Decision |
|---|---|
| Where do workers run? | Hub-dispatched to Barista nodes, unchanged. The external session only orchestrates. |
| How do worker events reach an idle session? | Push through a Claude Code channel ("doorbell"), with durable pull as the source of truth. |
| Thread ↔ session binding | Thread-bound. Any session with the bridge may `attach_thread`; one attachment per thread; a new attach replaces the old one. |
| Worker approvals | The orchestrator may resolve them, only when its client credential holds the `resolve-approvals` scope. The model can never grant itself that scope. |
| Authentication | Paired client credentials minted and revoked in the PWA, with explicit scopes. |
| Identity model | First-class `OrchestratorClient` and `OrchestratorAttachment` entities, not a synthetic Run. |
| Transport | A local stdio MCP bridge launched by Claude Code, holding one outbound WebSocket to the hub. |

## Claude Code channel facts this design relies on

Source: https://code.claude.com/docs/en/channels and https://code.claude.com/docs/en/channels-reference (research preview).

- A local MCP server declares `capabilities.experimental["claude/channel"] = {}` and emits `notifications/claude/channel` with `{ content: string, meta: Record<string, string> }`. The model receives `<channel source="…" key="value">content</channel>`.
- Events wake an idle session; events that arrive mid-turn queue and are delivered together on the next turn.
- Delivery is fire-and-forget. If the server is not enabled as a channel, Claude Code silently drops events. `meta` keys must be identifiers (letters, digits, underscore); others are dropped.
- The same server may expose ordinary MCP tools.
- A channel must be named at launch. During the preview, a server that is not on the Anthropic plugin allowlist needs `claude --dangerously-load-development-channels server:coffeeshop`. Pro and Max users without an organization need nothing else; claude.ai Team and Enterprise owners must enable `channelsEnabled`.
- Claude Code does not register a channel server that negotiates MCP protocol revision `2026-07-28`, so the bridge must negotiate an earlier revision.
- Channels require Anthropic authentication (claude.ai or Console API key); they are unavailable on Bedrock, Google Cloud Agent Platform, and Microsoft Foundry.

Without channels, every tool still works and the model falls back to long-polling `get_thread_events`.

## Architecture

```text
Claude Code (operator's machine)
   │ stdio MCP: tools + claude/channel notifications
   ▼
apps/orchestrator-bridge  (stateless apart from live attachment ids)
   │ authenticated outbound WebSocket  /orchestrator-client
   ▼
Coffee Shop hub  — thread/task DAG, mailbox, scheduler, approvals, attachments, doorbell policy
   │ existing control WebSocket
   ▼
Barista nodes → ACP / native harness workers (unchanged)
```

## Domain model

- **`OrchestratorClient`** — a credential minted in the PWA: `id`, `name`, `scopes: ("orchestrate" | "resolve-approvals")[]`, `secretHash`, `createdAt`, `lastSeenAt?`, `revokedAt?`. The secret is shown once at creation and stored only as a hash.
- **`Thread.orchestrator`** — `{ kind: "agent"; agentId }` (today's `ownerAgentId` behaviour) or `{ kind: "external"; clientId }`. Existing threads load as `{ kind: "agent", agentId: ownerAgentId }`.
- **`OrchestratorAttachment`** — `id`, `threadId`, `clientId`, `connectionId`, `attachedAt`, `lastHeartbeatAt`, `detachedAt?`, `status: "attached" | "detached" | "replaced"`. At most one `attached` attachment per thread. The acknowledged event cursor stays on the thread's orchestrator inbox so it survives attachments.
- **Approval resolution** gains `resolvedBy: { kind: "operator" } | { kind: "orchestrator"; clientId; attachmentId }`.

Snapshots persisted before this change load with empty client and attachment collections and never invent either.

## Hub ↔ bridge protocol

A versioned JSON protocol on `/orchestrator-client`, discriminated by `type`:

- `client.hello { protocolVersion, clientId, secret }` → `client.welcome { connectionId, heartbeatSeconds, scopes }` or close with a reason (`unauthorized`, `revoked`, `unsupported_version`).
- `client.heartbeat {}` every 15 s. No heartbeat for 45 s detaches the connection's attachments.
- `rpc.request { requestId, tool, arguments }` → `rpc.response { requestId, result | error: { code, message } }`.
- `doorbell { threadId, pending, approvals, urgent, summary }` from hub to bridge.
- `attachment.replaced { threadId, attachmentId }` and `client.revoked {}` from hub to bridge.

The credential travels in the first frame, not in the URL.

## MCP tool surface (bridge)

| Tool | Behaviour |
|---|---|
| `create_thread(title, objective)` | Creates a thread with `orchestrator.kind = "external"` for this client and attaches it. |
| `list_threads()` | Threads owned by this client, with attachment status and unread counts. |
| `attach_thread(threadId)` / `detach_thread(threadId)` | Attach replaces any current attachment for that thread. |
| `get_thread_context(threadId)` | Bounded durable context from `orchestratorContext.ts`: summary, task DAG, open approvals, cursor, and whether channels are active. |
| `get_thread_events(threadId, cursor?, waitMilliseconds?)` | Generalizes `wait_for_task_events`. Passing a valid cursor acknowledges everything up to it. `waitMilliseconds` gives the no-channel long-poll fallback. |
| `submit_tasks`, `update_task`, `send_task_message`, `update_thread`, `get_execution_inventory` | Existing handlers, reached through the external caller route. |
| `list_approvals(threadId)` / `resolve_approval(approvalId, optionId \| cancel, idempotencyKey)` | Offered only when the client holds `resolve-approvals`. |

Not offered in this version: `post_artifact`, `delegate_task`, `get_task_context`. Uploading local files as artifacts is a follow-up.

A session may attach to several threads at once; every tool call and doorbell names its `threadId`.

## Doorbell policy

- The hub decides when to ring; the bridge relays each `doorbell` as one `notifications/claude/channel`.
- Content is generated only from hub-owned structured fields, e.g. `Thread "Auth refactor": 2 tasks completed, 1 approval pending (expires 08:41). Call get_thread_events.` Worker-authored text never appears in channel content or meta; it reaches the model only through tool results.
- `meta` keys: `thread_id`, `pending`, `approvals`, `urgent`.
- Ring at most once per 2 s per thread; ring again only for events newer than the last ring, or when an unacknowledged pending approval is within 3 minutes of expiry.
- On attach or reconnect with an unacknowledged backlog, ring immediately.
- The acknowledged cursor is the only delivery truth; a lost ring costs latency, never events.

## Lifecycle

- The WebSocket is the lease. On close or heartbeat expiry, the connection's attachments become `detached`.
- The bridge re-attaches its threads after reconnect. If another session attached meanwhile, it receives `attachment.replaced` and emits a channel notice that the thread was taken over.
- While detached, workers continue, events accumulate, approvals remain answerable in the PWA and expire after nine minutes as today, and the PWA shows "Orchestrator detached since …".
- A thread with an external orchestrator never falls back to a hub-hosted node orchestrator; the continuation pass skips it.
- A message posted to an external thread from the PWA becomes an orchestrator inbox event instead of being refused.

## Errors

| Condition | Behaviour |
|---|---|
| Tool call on a thread not attached by this connection | `not_attached`, suggesting `attach_thread` |
| Thread owned by another client or by an agent | `forbidden` |
| Revoked credential | Hub sends `client.revoked` and closes; bridge tells the model through a channel notice and fails tool calls with `revoked` |
| Hub unreachable | Bridge reconnects with capped exponential backoff; tool calls fail fast with `hub_unavailable` and are never queued in the bridge |
| `resolve_approval` without scope | `forbidden`, and the tool is not listed |
| Approval already resolved | Existing 409 semantics surface as `conflict` |
| Retries after reconnect | Existing idempotency keys on `submit_tasks` and approval resolution make them safe |

## Security

- Client secrets are random, at least 256 bits, compared in constant time, stored only as hashes, and redacted from logs and events.
- Scopes are set by an operator in the PWA; no tool argument can widen them.
- Approval resolutions by an orchestrator are auditable and visually distinct in the PWA.
- The hub never receives provider credentials; the bridge carries only the Coffee Shop client credential.
- Barista's loopback-only run-scoped MCP server is unchanged.

## Testing

- Hub (`node:test`): credential hashing and revocation; scope enforcement; single attachment and replacement; heartbeat expiry; external caller route and cross-thread isolation; cursor acknowledgement; doorbell debounce, approval re-ring, and backlog ring; continuation skip for external threads; `resolvedBy` recording and human/orchestrator races; persistence migration.
- Bridge (`node:test`): channel capability declared; doorbell to notification mapping with identifier-safe meta; reconnect and re-attach; replacement and revocation notices; fail-fast tool calls while disconnected; negotiated MCP protocol revision.
- PWA (Vitest): connected-clients page, thread orchestrator status, orchestrator-resolved approval label.
- End to end: hub plus a simulated Barista plus the bridge driven by an MCP test client, covering create, submit, doorbell, events acknowledgement, approval resolution, disconnect, and reattach.

## Follow-ups

- `post_artifact` from the operator's machine, restricted to the Claude Code working directory, reusing the 10 MiB cap and existing artifact kinds — for shipping specs and similar files to workers.
- Packaging the bridge as a Claude Code plugin so it can be allowlisted for `--channels plugin:…`.
- Launching a hub-hosted orchestrator from Claude Code.
