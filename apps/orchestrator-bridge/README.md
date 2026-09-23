# Coffee Shop orchestrator bridge

A local stdio MCP server, named `coffeeshop`, that lets your own Claude Code session orchestrate a
Coffee Shop thread. It holds one authenticated outbound WebSocket to the hub's
`/orchestrator-client` endpoint, exposes the orchestration tools, and pushes hub doorbells into the
session as Claude Code channel events.

The bridge is stateless apart from the threads this process has attached. The hub owns every
identity and decision; the bridge never receives provider credentials.

## Install as a Claude Code plugin

The supported operator installation is the bundled plugin in
`plugins/coffeeshop-orchestrator`. From a published Coffee Shop checkout:

```sh
claude plugin marketplace add cafecito-games/CoffeeShop --sparse .claude-plugin plugins/coffeeshop-orchestrator
claude plugin install coffeeshop-orchestrator@cafecito-games
claude plugin enable coffeeshop-orchestrator@cafecito-games
```

Start a normal Claude Code session and enter:

```text
/plugin configure coffeeshop-orchestrator@cafecito-games
```

The prompt asks for the hub URL, client id, and secret. The plugin marks the secret as sensitive
Claude Code configuration. It requires Node.js 18 or newer.

Start Claude Code with the custom channel selected:

```sh
claude --dangerously-load-development-channels plugin:coffeeshop-orchestrator@cafecito-games
```

## Build from source

```sh
task orchestrator-bridge:build
```

The task produces `apps/orchestrator-bridge/dist/index.js` for repository development and the
self-contained `plugins/coffeeshop-orchestrator/server/index.mjs` distributed by the marketplace.

## Configure

| Variable | Meaning |
|---|---|
| `COFFEE_SHOP_HUB_URL` | `ws://` or `wss://` URL of the hub's `/orchestrator-client` endpoint |
| `COFFEE_SHOP_CLIENT_ID` | The orchestrator client id minted in the Coffee Shop app |
| `COFFEE_SHOP_CLIENT_SECRET` | The secret shown once when the credential was minted |

The bridge refuses to start, with a message on stderr and a non-zero exit code, if any of these is
missing or malformed. The secret never appears in its output.

Add it to `.mcp.json` in the repository you orchestrate from:

```json
{
  "mcpServers": {
    "coffeeshop": {
      "command": "node",
      "args": ["/absolute/path/to/CoffeeShop/apps/orchestrator-bridge/dist/index.js"],
      "env": {
        "COFFEE_SHOP_HUB_URL": "wss://hub.example.com/orchestrator-client",
        "COFFEE_SHOP_CLIENT_ID": "client-abc123",
        "COFFEE_SHOP_CLIENT_SECRET": "…"
      }
    }
  }
}
```

## Launch a source checkout with channels

Channels are a research preview. A server that is not on the Anthropic plugin allowlist has to be
loaded explicitly:

```sh
claude --dangerously-load-development-channels server:coffeeshop
```

Channel events wake an idle session; events that arrive mid-turn are queued and delivered on the
next turn. Delivery is fire-and-forget, so the acknowledged event cursor behind `get_thread_events`
is the only delivery truth — a lost doorbell costs latency, never events.

Requirements and limits:

- Channels require Anthropic authentication (claude.ai or a Console API key). They are unavailable
  on Bedrock, Google Cloud Agent Platform, and Microsoft Foundry.
- Pro and Max users without an organization need nothing beyond the launch flag. claude.ai Team and
  Enterprise owners must enable `channelsEnabled` for the organization first.
- Claude Code does not register a channel server that negotiates MCP protocol revision `2026-07-28`,
  so the bridge pins an earlier revision.

### Without channels

Every tool still works when channels are unavailable. `get_thread_context` then reports
`"channels": "unknown"`; poll `get_thread_events` with `waitMilliseconds` instead of waiting for a
doorbell. Once a channel event has been delivered without transport error the field reads
`"channels": "active"`.

## Tools

`create_thread`, `list_threads`, `attach_thread`, `detach_thread`, `get_thread_context`,
`get_thread_events`, `submit_tasks`, `update_task`, `send_task_message`, `update_thread`,
`get_execution_inventory`, and — only when the credential holds the `resolve-approvals` scope —
`list_approvals` and `resolve_approval`. A scope change observed on reconnect triggers
`notifications/tools/list_changed`.

While the bridge is disconnected, tool calls fail immediately with `hub_unavailable`; they are never
queued. After a revocation every tool fails with `revoked` and the bridge stops reconnecting.

## Test

```sh
pnpm --filter @coffee-shop/orchestrator-bridge test
```
