# Barista control agent

Barista is the machine-local half of Coffee Shop. It is installed once on every computer that contributes compute and connects outbound to the control plane. It does not expose an inbound listener.

## Startup

At startup Barista:

1. parses flags and environment configuration;
2. canonicalizes every workspace root and refuses missing roots;
3. locates `claude` and `codex` on `PATH` and runs each binary's `--version` check;
4. exits if no supported harness passes discovery;
5. opens an authenticated WebSocket to `/control-agent`;
6. registers the node, its platform, capacity, workspace roots, Barista version, and discovered harnesses;
7. maintains heartbeats and reconnects with bounded exponential backoff.

The minimal invocation is:

```bash
barista --control-endpoint coffeeshop.rednaskela.io --name "Worker 1"
```

That command authorizes the directory in which Barista starts. Production services should always set explicit roots:

```bash
COFFEE_SHOP_TOKEN=… barista \
  --control-endpoint coffeeshop.rednaskela.io \
  --name "Worker 1" \
  --id worker-1 \
  --kind home-server \
  --workspace-root /srv/workspaces \
  --concurrency 4
```

Repeat `--workspace-root` to enroll multiple trees. `WORKSPACE_ROOTS` accepts comma-separated values or an OS path-list (colon-separated on Unix and semicolon-separated on Windows).
Every explicitly configured root must be absolute and must exist so Barista can resolve it before opening a WebSocket. Invalid roots and invalid `BARISTA_CONCURRENCY` values stop startup without a partial registration.

The web app’s **Compute → Add compute** flow generates a shell-quoted equivalent using every supported environment variable:

| Environment variable | Meaning |
|---|---|
| `CONTROL_ENDPOINT` | HTTP(S) Coffee Shop URL; Barista converts it to the outbound WebSocket endpoint |
| `BARISTA_NAME` | Human-readable compute name |
| `BARISTA_ID` | Stable lowercase kebab-case node identity |
| `BARISTA_KIND` | `local`, `home-server`, or `cloud` |
| `BARISTA_CONCURRENCY` | Positive maximum simultaneous run count |
| `WORKSPACE_ROOTS` | Absolute allowlisted roots |
| `COFFEE_SHOP_TOKEN` | Coffee Shop hub secret, never a provider credential |

The UI deliberately emits `COFFEE_SHOP_TOKEN='replace-with-hub-token'`; it never reads the browser’s stored hub token into setup guidance. Replace the placeholder locally on the compute machine, or use a protected environment file when installing Barista as a service.

## Control API

The control plane sends these JSON messages:

- `dispatch`: immutable run snapshot plus the assigned agent;
- `cancel`: run ID to terminate;
- `ping`: request an immediate heartbeat.

Barista sends:

- `register`: protocol version and compute-node inventory;
- `sync.complete`: version 2 reconnect barrier sent after queued lifecycle messages;
- `heartbeat`: node ID, active run count, and timestamp;
- `run.started`, `run.output`, `run.completed`, and `run.failed`: run lifecycle;
- `run.cancelled`: acknowledgement that Barista recorded a cancellation tombstone and, for active work, terminated the harness process tree.

Cancellation commands are idempotent from Barista's perspective. A cancel received before its matching dispatch prevents the process from starting and is acknowledged immediately; a cancel received during execution terminates the process tree and is acknowledged after cleanup without translating that intentional termination into `run.failed`. Tombstones survive control-plane reconnects for the lifetime of the Barista process, so a replayed dispatch cannot resurrect cancelled work. The hub persists cancellation before sending the command and remains authoritative if Barista is offline.

On reconnect, protocol version 2 sends `register`, flushes its lifecycle outbox, and then sends `sync.complete` with any run IDs still active on Barista. The hub processes those messages in socket order and waits for the barrier before redispatching queued runs, excluding work Barista reports as active. Version 1 remains accepted during rolling upgrades so existing lifecycle events can settle, but queued-run redispatch is disabled for v1; upgrade that Barista to resume queued work safely.

The TypeScript source of truth is `packages/protocol/src/index.ts`; Go wire structs are deliberately isolated in `apps/control-agent/internal/protocol`. Changes to the wire contract must update both and should retain compatibility across rolling deployments.

`/worker` remains accepted by the hub as a temporary compatibility endpoint for older Node workers, but new agents use `/control-agent`.

## Credentials and enrollment

`COFFEE_SHOP_TOKEN` authenticates the WebSocket through an `Authorization: Bearer` header. Do not pass durable secrets with `--token` in production because process listings and shell history may expose them.

The token authenticates a Barista to the current single-user control plane; it is not a vendor credential. Claude and Codex authentication stays on the compute node in the vendors' own CLI storage.

## Service installation

Copy the binary to a stable location and run it under the platform service manager with a dedicated environment file. The service account must be able to read/write the enrolled workspaces and access the locally authenticated CLI state. It should not have broader filesystem permissions than the agents need.

Barista logs discovery, connection state, enrolled roots, and failures to stdout/stderr so systemd, launchd, or the Windows Service wrapper can collect them.

## Reviewing reported policy

The web app’s **Settings → Execution policy → Review** view is read-only. It classifies node and harness inventory as worker-reported, connection/freshness as hub-observed, and workspace/harness behavior as documentation for the Barista release built alongside the UI. Task builds stamp Barista with the Coffee Shop release plus Git description; container builds embed the package release in the UI so compatible release builds can be identified. A matching release is still not runtime attestation. Older, custom, unavailable, protocol-only, or unknown harness/auth values remain explicitly unverified.

For this release, Claude is documented with `--permission-mode auto` and `--permission-prompts none`; Codex is documented with `--sandbox workspace-write`. The actual invocation remains owned by the Barista binary on the compute machine.
