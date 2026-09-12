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

## Control API

The control plane sends these JSON messages:

- `dispatch`: immutable run snapshot plus the assigned agent;
- `cancel`: run ID to terminate;
- `ping`: request an immediate heartbeat.

Barista sends:

- `register`: protocol version and compute-node inventory;
- `heartbeat`: node ID, active run count, and timestamp;
- `run.started`, `run.output`, `run.completed`, and `run.failed`: run lifecycle.

The TypeScript source of truth is `packages/protocol/src/index.ts`; Go wire structs are deliberately isolated in `apps/control-agent/internal/protocol`. Changes to the wire contract must update both and should retain compatibility across rolling deployments.

`/worker` remains accepted by the hub as a temporary compatibility endpoint for older Node workers, but new agents use `/control-agent`.

## Credentials and enrollment

`COFFEE_SHOP_TOKEN` authenticates the WebSocket through an `Authorization: Bearer` header. Do not pass durable secrets with `--token` in production because process listings and shell history may expose them.

The token authenticates a Barista to the current single-user control plane; it is not a vendor credential. Claude and Codex authentication stays on the compute node in the vendors' own CLI storage.

## Service installation

Copy the binary to a stable location and run it under the platform service manager with a dedicated environment file. The service account must be able to read/write the enrolled workspaces and access the locally authenticated CLI state. It should not have broader filesystem permissions than the agents need.

Barista logs discovery, connection state, enrolled roots, and failures to stdout/stderr so systemd, launchd, or the Windows Service wrapper can collect them.
