# Coffee Shop orchestrator for Claude Code

This Claude Code plugin starts the local Coffee Shop orchestrator bridge, exposes its orchestration
tools, and registers it as a channel so worker events can wake the session.

The plugin requires Node.js 18 or newer. It connects only to the Coffee Shop hub URL configured by
the operator. Claude provider credentials remain in Claude Code and are never sent to Coffee Shop.

## Install

```sh
claude plugin marketplace add cafecito-games/CoffeeShop --sparse .claude-plugin plugins/coffeeshop-orchestrator
claude plugin install coffeeshop-orchestrator@cafecito-games
claude plugin enable coffeeshop-orchestrator@cafecito-games
```

Start a normal Claude Code session and configure the plugin:

```text
/plugin configure coffeeshop-orchestrator@cafecito-games
```

The prompt asks for the hub URL, client ID, and one-time client secret shown by Coffee Shop. Claude
Code treats the secret as sensitive plugin configuration; do not pass it through the shell with
`--config`.

During the Claude Code channels research preview, a custom marketplace channel must be selected at
launch:

```sh
claude --dangerously-load-development-channels plugin:coffeeshop-orchestrator@cafecito-games
```

An organization administrator can allowlist this marketplace/plugin pair. An allowlisted install
uses `--channels` instead. Without either channel flag, the MCP tools still work and the session can
poll `get_thread_events` for updates.
