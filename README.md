# Coffee Shop

Coffee Shop is a local-first control plane for persistent, purpose-built coding agents. An agent has a stable identity and purpose; a harness decides how it works; a compute node decides where it works. The PWA makes that system visible from one place.

This repository contains four deployable applications:

- `apps/web`: the React/Vite operator PWA;
- `apps/hub`: the TypeScript control plane, REST API, WebSocket gateway, and durable JSON store;
- `apps/control-agent`: **Barista**, a Go 1.26 system agent for every compute machine;
- `apps/orchestrator-bridge`: the local stdio MCP server that lets your own Claude Code session orchestrate a thread.

Operators install the orchestrator bridge from the repository's Claude Code marketplace with
`claude plugin marketplace add cafecito-games/CoffeeShop --sparse .claude-plugin plugins/coffeeshop-orchestrator`.

Barista is a single binary. It discovers installed Claude Code and Codex CLIs, keeps their credentials on the compute machine, connects outbound to Coffee Shop, enforces workspace allowlists, and runs dispatched work. A compute host does not need Node, pnpm, a repository clone, or an inbound port.

## Develop locally

Requirements:

- Node 24+ and pnpm for the frontend and control plane;
- Go 1.26 for Barista;
- [Task](https://taskfile.dev/) for repository commands.

```bash
task install
cp .env.example .env
task dev
```

Open <http://localhost:5173>. In another terminal, authenticate at least one supported harness and start a local Barista:

```bash
claude # complete /login if needed; alternatively run: codex login
task control-agent:run -- \
  --name "This laptop" \
  --workspace-root /Users/you/Projects
```

`task dev:full` starts all three applications. By default, Barista allows only the directory it was started from; pass one or more `--workspace-root` flags for other locations.
The PWA’s **Compute → Add compute** dialog also walks through build/authentication prerequisites and creates a validated, shell-quoted environment command. In development it correctly targets the hub on port 8787 rather than the Vite origin on port 5173.

## Install Barista on a compute machine

Build the binary for the current platform:

```bash
task control-agent:build
```

Copy `bin/barista` to the compute machine and run it:

```bash
barista \
  --control-endpoint coffeeshop.rednaskela.io \
  --name "Worker 1" \
  --workspace-root /srv/workspaces
```

Bare hostnames are normalized to `wss://<host>/control-agent`; local `http://` endpoints become `ws://`. Barista derives a stable kebab-case node ID from the machine hostname unless `--id` is provided, inspects `claude --version` and `codex --version`, registers the available harnesses, and reconnects with exponential backoff.

For a secured control plane, provide the Coffee Shop secret through the environment rather than shell history:

```bash
COFFEE_SHOP_TOKEN="$(cat /secure/path/coffee-shop-token)" \
  barista --control-endpoint coffeeshop.rednaskela.io --name "Worker 1" \
  --workspace-root /srv/workspaces
```

An unconfigured development hub accepts local enrollment without a token. Production mode requires `COFFEE_SHOP_TOKEN` and rejects unauthenticated enrollment; Barista sends no implicit production credential.

Run `barista --help` for the full command line. Environment equivalents are `CONTROL_ENDPOINT`, `BARISTA_NAME`, `BARISTA_ID`, `BARISTA_KIND`, `BARISTA_CONCURRENCY`, `WORKSPACE_ROOTS`, and `COFFEE_SHOP_TOKEN`.

Barista may also install verified, versioned provider harnesses under its own data root. Upgrades follow `setup plan` → `setup apply` → `setup activate` → service restart; a live daemon never hot-adopts a changed selection. Rollback also requires a restart, and prune removes only verified inactive owned bytes. Provider login remains local and separate throughout. See the [tested managed-harness procedure](docs/operations.md#upgrading-restarting-rolling-back-and-pruning-a-managed-harness).

## Task catalog

```text
task dev                    control plane + frontend with reload
task dev:full               control plane + frontend + local Barista
task frontend:dev           frontend only
task frontend:build         production frontend bundle
task container:build        hub image with exact Barista version provenance
task control-plane:dev      hub only
task control-plane:build    production hub bundle
task control-agent:run -- … run Barista from source
task control-agent:build    write the current-platform binary to bin/barista
task control-agent:build:all cross-compile release binaries to dist/barista
task test                   TypeScript, Go, and end-to-end system tests
task system:test            multi-node end-to-end suite (real hub + Baristas, fake harnesses)
task typecheck              all TypeScript workspaces
task ci                     format checks, tests, types, vet, and builds
```

The pnpm workspace contains only JavaScript/TypeScript packages. Barista owns its Go module under `apps/control-agent`, and the root `go.work` makes Go tooling work from the repository root. Task is the shared interface across both ecosystems.

## Runtime and security model

Control agents initiate the connection, so compute hosts do not need a public inbound port. The hub sends typed dispatch/cancel messages over the authenticated WebSocket; Barista returns lifecycle and normalized output messages. Every top-level request starts a durable thread that links its messages, execution trees, artifacts, and follow-ups. Barista gives each harness an authenticated, run-scoped MCP endpoint on loopback for typed thread/task context, thread refinement, artifact publication, and authorized delegation; those calls are relayed over the same outbound control connection.

Before starting a harness, Barista canonicalizes the requested absolute workspace and confirms it remains within an enrolled root, including through symlinks. Claude Code runs in auto permission mode with unanswered prompts denied. Codex runs with `workspace-write` sandboxing. Vendor credentials remain in vendor-owned CLI storage and are never sent to the hub.

Compute rows expose the latest reported node and harness inventory. The Settings policy review distinguishes that self-report from hub-observed freshness and release documentation; it does not claim that a worker’s runtime or flags have been attested.

Keep a subscription-backed compute node private to the account owner. Do not expose it as a resale or credential-sharing service. See [the provider note](docs/anthropic-usage.md), [the Barista operational guide](docs/control-agent.md), and [the architecture](docs/architecture.md).

## Repository map

```text
apps/web                  React PWA and responsive operator interface
apps/hub                  REST API, WebSocket gateway, scheduler, persistence
apps/control-agent        Go Barista daemon and harness adapters
apps/orchestrator-bridge  Stdio MCP bridge for an external Claude Code orchestrator
plugins/coffeeshop-orchestrator Installable Claude Code plugin carrying the bundled bridge
packages/protocol         Shared TypeScript domain and wire contracts
docs                      Architecture, operations, security, and provider notes
Taskfile.yml              Language-neutral development and CI entry points
go.work                   Go workspace for Go applications in the monorepo
```

## Production control plane

Build the web/hub container with `task container:build`, set a strong `COFFEE_SHOP_TOKEN`, and terminate TLS in front of the hub. This injects the same clean source-derived version used by `task control-agent:build`, allowing exact release-policy comparison. Direct `docker compose build` defaults the UI provenance to `dev` and therefore fails closed unless `BARISTA_VERSION` is supplied explicitly. The shared token remains appropriate only for a private, single-user deployment. Per-node enrollment grants, rotation, and revocation are the next security boundary before a public or multi-user rollout. Day-to-day node bootstrap, adapter, upgrade, and recovery procedures are in [docs/operations.md](docs/operations.md).
