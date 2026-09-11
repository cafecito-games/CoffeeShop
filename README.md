# Coffee Shop

Coffee Shop is a local-first control plane for persistent, purpose-built agents. An agent has a stable identity and purpose; a harness decides how it works; a compute worker decides where it works. The PWA makes that system visible from one place.

This repository is an executable MVP. It ships with:

- a mobile-first installable React PWA;
- a TypeScript hub with a durable JSON event store and live WebSocket updates;
- outbound-connecting workers for a laptop, home server, or cloud host;
- first-party CLI adapters for Claude Code and Codex;
- explicit, visible agent-to-agent handoffs with depth limits;
- workspace allowlists, per-worker concurrency, cancellation, and no credential forwarding.

## Start locally

Requires Node 22+ and pnpm.

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Open <http://localhost:5173>. A new hub starts with an empty roster. Start a worker to register a compute node, then create an agent in the app:

```bash
COFFEE_SHOP_TOKEN=dev-coffee \
NODE_ID=local-macbook \
NODE_NAME="This laptop" \
WORKSPACE_ROOTS=/Users/you/Projects \
pnpm worker
```

For a single production process:

```bash
pnpm build
NODE_ENV=production COFFEE_SHOP_TOKEN="$(openssl rand -hex 24)" pnpm start
```

The hub serves the built PWA from port `8787`. Put it behind HTTPS (Tailscale Serve, Caddy, or your existing reverse proxy) before installing it on a phone.

## Connect a second machine

Clone the repository on that machine, install dependencies, install and authenticate the harnesses you want there, then run:

```bash
HUB_URL=https://coffee-shop.your-tailnet.ts.net \
COFFEE_SHOP_TOKEN=the-same-hub-secret \
NODE_ID=home-linux \
NODE_NAME="Home server" \
NODE_KIND=home-server \
WORKSPACE_ROOTS=/srv/workspaces,/opt/sandboxes \
WORKER_CONCURRENCY=4 \
pnpm worker
```

Workers initiate the connection, so the compute host does not need an inbound public port. `WORKSPACE_ROOTS` is an enforced comma-separated allowlist; a run outside it is rejected before a harness starts.

## Claude without API token billing

Coffee Shop invokes the official `claude` binary in documented print/streaming mode. On each worker machine:

```bash
claude
# choose Claude App / Pro or Max during login, or run /login if already authenticated
```

The worker never reads Claude's stored OAuth credentials and the hub never receives them. It spawns `claude -p` with structured streaming, `--permission-mode auto`, and unattended prompts set to deny. This uses the limits included in the signed-in Claude plan, not an `ANTHROPIC_API_KEY`.

Important boundary: keep a subscription-backed worker private to the person who owns that Claude account. Do not expose it as a service to other users, share credentials, resell access, scrape private endpoints, or attempt to bypass rate limits. Anthropic's terms and product behavior can change; see [the detailed note](docs/anthropic-usage.md) and re-check it before a public or multi-user deployment.

## Agent handoffs

Coffee Shop makes coordination a first-class, inspectable event. A harness can return:

```xml
<handoff to="release-sentinel">Review the batching fix and run the focused release checks.</handoff>
```

The hub records the sender, receiver, task, parent run, and time, then dispatches the receiving agent on its configured harness and compute node. Automatic chains are capped at three hops. You can also create a handoff with `POST /api/handoffs`.

## Project map

```text
apps/web       React PWA and responsive operator interface
apps/hub       REST API, WebSocket gateway, scheduler, persistence
apps/worker    Machine daemon and harness adapters
packages/protocol  Shared wire and domain types
docs           Architecture, security, and provider notes
```

Read [docs/architecture.md](docs/architecture.md) for the runtime design and the production roadmap.
