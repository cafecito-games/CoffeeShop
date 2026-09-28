# Operations runbook

This runbook is for the operator of a Coffee Shop deployment: the person who deploys the hub, installs Barista on compute machines, and answers when something stops working. Three kinds of process are involved:

- the **hub** (`apps/hub`): REST API, WebSocket gateway, scheduler, and durable SQLite store;
- **Barista** (`apps/control-agent`): one Go binary per compute node, connecting outbound to the hub;
- **provider harnesses**: the Claude Code and Codex CLIs and their ACP adapters, installed and authenticated on each compute node.

Design detail, threat model, and protocol semantics live in [architecture.md](architecture.md) and [control-agent.md](control-agent.md); this document covers operational procedure only.

## Deploying the hub

Environment variables:

| Variable | Meaning | Default |
|---|---|---|
| `COFFEE_SHOP_TOKEN` | Shared bearer secret. Required when `NODE_ENV=production` (the hub refuses to start without it); authenticates every `/api/*` route except `/api/health`, the `/control-agent` WebSocket, and (as `?token=`) the `/events` WebSocket. | unset (development accepts unauthenticated traffic) |
| `PORT` | HTTP listen port. `0` asks the OS for a free port; the startup log names the port actually bound. | `8787` |
| `NODE_ENV` | Set to `production` to enforce token authentication. | unset |
| `COFFEE_SHOP_DATABASE` | Absolute path of the SQLite database. | Next to `COFFEE_SHOP_DATA` as `coffee-shop.sqlite` (the container sets `/data/coffee-shop.sqlite`) |
| `COFFEE_SHOP_DATA` | Legacy JSON snapshot to import when a new SQLite database has no state. It is never rewritten after import. | `<repo>/data/state.json` (the container keeps `/data/state.json` as the migration source) |
| `PROJECT_PROFILES_PATH` | Legacy project-profile JSON to import once when the database has no profiles. New deployments should manage projects in the PWA. | `<repo>/config/project-profiles.json` |
| `COFFEE_SHOP_PUBLIC_ORIGIN` | Canonical public `http`/`https` origin of the PWA/API. Required with preview delivery. | unset |
| `PREVIEW_PUBLIC_ORIGIN` | Canonical isolated preview origin. Its hostname must differ from the Hub hostname; plain HTTP is local-loopback only. | unset |
| `PREVIEW_BIND_HOST` / `PREVIEW_PORT` | Preview-only socket bind address and port (`1..65535`). The bind address is never public authority. | unset |
| `PREVIEW_SIGNING_KEYS` | One to four comma-separated `kid:<64 lowercase hex>` HMAC keys. Protect as a deployment secret. | unset |
| `PREVIEW_ACTIVE_SIGNING_KEY_ID` | One configured key ID used for new issuance. Retained non-active keys verify only their own existing grants. | unset |
| `PREVIEW_ACCESS_DEFAULT_TTL_SECONDS` / `PREVIEW_ACCESS_MAX_TTL_SECONDS` | Access capability default and ceiling, each `60..3600`; the default cannot exceed the maximum. | `900` / `3600` when delivery is enabled |

Durable state is the SQLite database plus the `artifacts` and `prepared-previews` directories created **next to** it. All must be on one persistent volume and backed up together; a database backup without its immutable artifact and prepared trees cannot serve or recover a ready preview. SQLite runs in WAL mode with full synchronous commits; Coffee Shop supports one active hub process per database. On first startup with an empty database, the hub imports `COFFEE_SHOP_DATA` if it exists. The old JSON file remains untouched as a rollback artifact.

Build and run the container with `task container:build` and `docker compose up`; `compose.yaml` requires `COFFEE_SHOP_TOKEN` and `PREVIEW_SIGNING_KEYS`, publishes both ports, and mounts the `coffee-shop-data` volume at `/data`. Terminate TLS in front of both production hostnames. Startup logs name both bound listeners but never a key or capability URL.

Health check: `GET /api/health` returns `{ ok, service, controlAgents }` and is never token-gated. Before an upgrade, stop the hub and back up `coffee-shop.sqlite` together with `artifacts/` and `prepared-previews/` (or snapshot the whole persistent volume); never commit the database, `data/*.json`, or a real token.

## Serving isolated artifact previews

Preview delivery is disabled only when all eight preview-related variables in the table above are absent. If any one is present, the Hub validates the complete configuration before storage recovery or either listen call; missing, duplicate, malformed, same-host, or unsafe values stop startup and the error names only the variable. Disabled mode starts no preview listener and `POST /api/previews/:id/access` returns `503`; artifact registration, upload, preparation, recovery, snapshots, and ordinary downloads remain available.

For local Compose use `http://hub.localhost:8787` for the PWA/API and `http://preview.localhost:8788` for previews. Both `.localhost` names resolve to loopback in modern browsers, but they remain distinct browser origins. Generate a key without placing it in the repository:

```sh
openssl rand -hex 32
```

Set `PREVIEW_SIGNING_KEYS=current:<output>` and `PREVIEW_ACTIVE_SIGNING_KEY_ID=current` in the protected deployment environment, then start Compose. Never put the output in `.env.example`, Compose, a support ticket, or a shell command committed to history.

In production, publish two TLS virtual hosts, for example `https://coffee.example.com` and `https://preview.example.com`. Route the former to Hub port 8787 and the latter to preview port 8788. Preserve the original raw `Host` header; do not rewrite it to the upstream address, and do not expect `Forwarded` or `X-Forwarded-Host` to authorize a request. Route `/events`, `/control-agent`, `/orchestrator-client`, and every `/api/*` path only to the Hub host. Route only `/_coffee-shop/preview/v1/...` to the preview host. A swapped route returns `421`, which is the intended topology alarm. Production `PREVIEW_PUBLIC_ORIGIN` must be HTTPS; HTTP is accepted only for `localhost`, a `.localhost` name, `127.0.0.1`, or `[::1]`.

Capabilities are response-only bearer secrets in URL paths. Configure proxy, ingress, CDN, browser-observability, and application logs to redact the complete segment after `/_coffee-shop/preview/v1/`; do not log request targets, query strings, `Referer`, cookies, or authorization headers on the preview virtual host. Do not persist an access response in snapshots, analytics, browser storage, chat, or control messages. `HEAD` performs the same authorization and integrity work as `GET`; `Range`, cookies, Hub bearer headers, and `?token=` never add authority.

The run-scoped `publish_preview` tool returns durable artifact/preview metadata and the lifecycle state observed by that call; it never returns a signed access URL. In particular, an uploaded artifact does not by itself mean the preview is ready. Coffee Shop agents attach the artifact ID to their task and report the returned preview ID/status. Only an authenticated operator uses `POST /api/previews/:id/access` (normally through the preview UI) after the preview is ready. The publication lifecycle TTL and the shorter access-capability TTL are separate policies.

Rotate keys with add/activate/drain/remove:

1. Generate a new 32-byte key under a new unique `kid`; add it to `PREVIEW_SIGNING_KEYS` while retaining the old entry.
2. Set `PREVIEW_ACTIVE_SIGNING_KEY_ID` to the new ID, restart, and verify new issuance.
3. Wait `PREVIEW_ACCESS_MAX_TTL_SECONDS + 30` seconds, then remove the old entry and restart. Removal immediately revokes any remaining old grant.

Never reuse a `kid` with different bytes while an old grant can exist. To roll back during the drain window, retain both exact keys and restore the former active ID; no persisted URL migration is needed. A restart with the same ring validates unexpired grants, while a removed/unknown key never falls back to the active or first entry.

Lifecycle expiry and signed expiry are both closed boundaries: access is denied when the clock equals either one. The 15-second expiry sweep persists due lifecycle transitions and broadcasts only on change, but access checks the wall clock independently, so delayed maintenance never extends a grant. Expiry does not delete prepared content. Include `prepared-previews/` in volume snapshots; restore it with the matching database and `artifacts/` directory, then restart so recovery can fail closed on any mismatch.

Preview troubleshooting:

| Symptom | Cause and action |
|---|---|
| Hub stops before listening and names a preview variable | Configuration is partial or malformed. Supply the complete set, or remove every preview-related variable to disable the feature. Generate a new key if its shape is wrong; never paste the rejected value into logs. |
| `421 Misdirected Request` | The reverse proxy sent a public hostname to the wrong listener, rewrote `Host`, or combined Host headers. Preserve exactly one original Host and correct the virtual-host upstream. |
| Operator access endpoint returns `503` | Preview delivery is deliberately disabled. Configure the complete two-host topology and restart. |
| Access issuance returns `409` | The preview is not ready/unexpired or its uploaded artifact/prepared target is not exact. Inspect lifecycle state and bounded Hub storage code; do not regenerate bytes in the delivery path. |
| A signed URL returns the generic `404` | The grant, key, lifecycle, generation, path, manifest, or bytes are no longer valid. Request a new URL after confirming readiness; never infer which condition from the public response. |
| Relative assets work but `/asset.js` does not | Root-relative references intentionally drop the capability prefix. Produce bundle-relative URLs; the server does not rewrite HTML or add a `<base>`. |
| Old URLs stop immediately after rotation | The old `kid` was removed before the drain interval. Restore both exact keys, restart, then repeat the drain procedure. |

## Bootstrapping a compute node

1. Build and copy the binary: `task control-agent:build` (or `task control-agent:build:all` for cross-compiled release binaries under `dist/barista`). Copy it to a stable location on the node.
2. Create a dedicated service account that can read/write the enrolled workspaces and read the locally authenticated CLI state, and nothing broader. Run Barista under the platform service manager (systemd, launchd, Windows service wrapper) with a protected environment file.
3. Provide the enrollment token through the environment, `COFFEE_SHOP_TOKEN`, never `--token` — process listings and shell history expose flag values.
4. Enroll workspace roots with repeated `--workspace-root` flags or `WORKSPACE_ROOTS` (comma-separated). Every root must be absolute and must exist; with no root configured Barista authorizes only its working directory.
5. Declare node inventory as needed: `--label`, `--accelerator`, `--toolchain <id>[@<version>]`, `--memory-megabytes`, `--project` (project allowlist; empty means unrestricted). These are administrator declarations, not proofs; ids are lowercase kebab-case, values are screened for secrets, and conflicting duplicate toolchain versions stop startup.

Core flags and environment equivalents: `--control-endpoint` (`CONTROL_ENDPOINT`, default `http://localhost:8787`; bare hostnames become `wss://<host>/control-agent`), `--name` (`BARISTA_NAME`), `--id` (`BARISTA_ID`, derived from the hostname), `--kind` (`BARISTA_KIND`: `local`, `home-server`, `cloud`), `--concurrency` (`BARISTA_CONCURRENCY`, default 2), `--data-root` (`BARISTA_DATA_ROOT`), `--version` to print the binary version. Run `barista --help` for the full list.

Node setup workflow:

- `barista setup plan --data-root <path> [--manifest <path>] [--out <file>]` — read-only; renders the exact operations an apply would perform as a digest-sealed JSON plan. It writes nothing under the data root and creates no ledger.
- `barista setup apply --plan <file> [--manual-artifact <componentId>=<path>] [--manual-checksum <componentId>=<sha256>] [--manifest <path>] [--allowed-host <host>]` — the only mutating command, and the only one that creates the data root. A hand-edited plan, a changed manifest, or a target that changed since planning is refused before any mutation.
- `barista doctor [--data-root] [--manifest] [--control-endpoint] [--claude-acp-auth-mode] [--approval-policy] [--json]` — entirely read-only (it also prints the effective [approval policy](#approval-policy) per harness): re-verifies installed adapters against the ownership ledger, runs coarse exit-code auth probes, and makes one unauthenticated TCP connection attempt to the control endpoint. Doctor exits 0 whenever it could build a report; problems show up in the report itself.

The default data root resolves through `os.UserConfigDir()` to `<user config>/coffee-shop/barista`, never `$HOME` itself. The adapter manifest is compiled into the binary; `--adapter-manifest` (`BARISTA_ADAPTER_MANIFEST`) overrides it for both the daemon and setup.

## Installing and verifying ACP adapters

The compiled-in managed component manifest (`apps/control-agent/internal/setup/manifest/components.json`, schema generation `2`) pins four components — two ACP adapters and two provider harnesses:

- `codex-acp` (`@agentclientprotocol/codex-acp`) **1.12.0**, harness `codex-cli`, `"kind": "acp-adapter"`;
- `claude-acp` (`@agentclientprotocol/claude-agent-acp`) **0.79.0**, harness `claude-cli`, `"kind": "acp-adapter"`;
- `claude-cli` (`@anthropic-ai/claude-code`) **2.1.231**, `"kind": "harness"` (see [managed harnesses](#installing-and-activating-managed-harnesses));
- `codex-cli` (`@openai/codex`) **0.147.0**, `"kind": "harness"`, and the one entry with a real pinned `archive` distribution.

An ACP adapter installs at `<data-root>/adapters/<harnessId>/<componentId>/<version>/<executablePath>` — unchanged from the adapter-only schema, so an existing install is never relocated — and a harness component at `<data-root>/harnesses/<harnessId>/<componentId>/<version>/<executablePath>`.

The previous adapter-only manifest (schema generation `1`, an `adapters` array with no component kind) is still accepted verbatim by `--manifest` for the transition: every entry migrates to `acp-adapter` and installs at exactly the same path. A document that mixes the two generations, or declares a generation nobody supports, is rejected whole. The ownership ledger migrates the same way: a legacy `ownership.json` is rewritten in generation `2` by `barista setup apply`, atomically and only once every legacy record has been proven to name exactly one ACP adapter at its own recorded install path. A record that cannot be mapped leaves the ledger and every installed file untouched, and the command reports the offending record index rather than claiming ownership.

Neither project publishes a standalone signed release artifact. For `codex-acp`, build a single-file executable from the tagged source (`npm run bundle:all`), then install it manually:

```bash
barista setup plan --out plan.json
barista setup apply --plan plan.json \
  --manual-artifact codex-acp=/opt/codex-acp/bin/codex-acp \
  --manual-checksum codex-acp=<sha256>
```

The same `--manual-artifact`/`--manual-checksum` pattern applies to `claude-acp` (its `claude-agent-acp` CLI entry point). A global npm install is a script over unpinned `node_modules` and is not supported. Alternatively, skip setup entirely and pin an executable directly:

```bash
--acp-adapter codex-cli=sha256:<64 lowercase hex>:/opt/codex-acp/bin/codex-acp
```

The override must be a regular executable file (not a symlink) matching its digest, or Barista refuses to start. Barista never runs `npx`, downloads, or installs anything at runtime; every adapter is re-verified before each launch.

Verification, in order:

1. At startup Barista probes each loaded adapter with an ACP `initialize` handshake (15 s bound) requiring protocol version 1, the manifest's pinned version, and HTTP MCP support. The daemon logs either `ACP adapter for <harness-id> passed its startup probe` or `ACP adapter for <harness-id> is disabled: <reason>`.
2. Confirm the harness now advertises the transport: `nodes[].harnesses[].transports` contains `acp-v1` in `GET /api/snapshot` (or the PWA compute view). A harness shows `native-cli` only when its native CLI passed discovery.
3. Run `barista doctor`: each adapter entry prints `harness=installed/missing`, `adapter=installed/missing`, `auth=<readiness>`, `launch=ready/not-ready`, plus notes.

Claude ACP additionally requires the auth-mode gate described in the next section before it loads at all.

## Installing and activating managed harnesses

Barista can also manage the provider CLIs themselves. This is entirely optional: a node that installed `claude` and `codex` by hand keeps working exactly as before, and a PATH-discovered harness stays the fallback whenever no managed version is selected or a selected one stops verifying. Only a node administrator running `barista setup` can install or select one, and the Hub can display the inventory but never apply an update.

The two harnesses are distributed differently, because what their vendors publish differs. **Barista never runs `npm`, `npx`, `brew`, `pipx`, or `curl … | sh`, at any point** — neither vendor's own installer or package manager is ever invoked.

- **`codex-cli` is `kind: "archive"` on all four platforms.** OpenAI publishes per-platform release archives whose SHA-256 and exact byte size are both obtainable, so the manifest pins them and Barista downloads and verifies the bytes itself — no operator artifact needed. Because `github.com` redirects release downloads to `release-assets.githubusercontent.com`, and Barista refuses any redirect not named by `--allowed-host` (an empty allowlist rejects all of them), an apply that installs it needs `--allowed-host github.com --allowed-host release-assets.githubusercontent.com`.
- **`claude-cli` is `kind: "manual"` on all four platforms.** The only mechanism Anthropic documents is `npm install -g`, and the package grants no redistribution, so there is nothing Barista could honestly pin. The administrator produces the single executable file themselves, asserts its digest out of band, and hands both to apply.

`apps/control-agent/internal/setup/manifest/README.md` records, per harness and per platform, the chosen kind and why, the vendor source consulted, the retrieval date, the full pinned values for every archive platform, the exact packaging commands for every manual platform, and which platforms are omitted and why.

Barista supports exactly four platform keys: `darwin-amd64`, `darwin-arm64`, `linux-amd64`, `linux-arm64`. **Windows is unsupported by omission of the platform key**, for harnesses and adapters alike. There is no fallback platform: `barista doctor` reports `no platform distribution for <platform>` and planning emits no operation.

The archive flow, using Codex — nothing to package, because the manifest already pins the bytes:

```bash
barista setup plan --data-root <path> --out plan.json
barista setup apply --plan plan.json \
  --allowed-host github.com \
  --allowed-host release-assets.githubusercontent.com
barista setup activate --kind harness --id codex-cli --version 0.147.0
barista doctor            # activeVersion, rollbackVersion, provenance, authReadiness
```

The manual flow, using Claude Code on `linux-amd64` (see the manifest README for each platform's package):

```bash
# 1. Produce the executable on an operator workstation
npm pack @anthropic-ai/claude-code-linux-x64@2.1.231
tar -xzf anthropic-ai-claude-code-linux-x64-2.1.231.tgz    # extracts package/claude
./package/claude --version                                  # must print 2.1.231
sha256sum package/claude

# 2. Install it side by side with any existing version, verified on the single read that stages it
barista setup apply --plan plan.json \
  --manual-artifact claude-cli=$PWD/package/claude \
  --manual-checksum claude-cli=<sha256>

# 3. Select it atomically. The previously active version is retained as the rollback target.
barista setup activate --kind harness --id claude-cli --version 2.1.231
```

Activation is verified-then-recorded, and the verification now includes the candidate's own claim about itself: **Barista refuses to activate a managed harness whose `--version` output does not report exactly the pinned version.** An output that names another version, carries no parsable version at all, looks secret-like, exits non-zero, cannot start, or exceeds the bounded timeout all refuse the selection — each with a distinct fixed reason naming only the component identity, because raw probe output may carry credentials and is never logged, reported, or surfaced. A refused activation leaves the activation ledger, the ownership ledger, and every installed file byte-identical, so the previously active version stays active and `barista setup rollback --kind harness --id claude-cli` still returns to the retained one.

Bumping a version is never an in-place mutation: the new version installs at its own path, and the old one stays until an explicit `barista setup prune`. Replaying a completed apply or re-activating the current, still-verifying version writes nothing. If the activated bytes later drift from the ownership ledger, the harness is not launched from them — it falls back to the external PATH installation and `barista doctor` reports the demotion (`provenance: external` with a note) rather than hiding it.

### Upgrading, restarting, rolling back, and pruning a managed harness

Use this order on each node. The version and artifact come from the manifest being deployed; do not copy a version from this example or infer one from a directory name.

```bash
# Prepare the next version while the current daemon may still be working.
barista setup plan --data-root <path> --manifest components-next.json --out next-plan.json
barista setup apply --data-root <path> --manifest components-next.json --plan next-plan.json \
  --manual-artifact <component-id>=<artifact> \
  --manual-checksum <component-id>=<sha256>
barista setup activate --data-root <path> --manifest components-next.json \
  --kind harness --id <component-id> --version <version>
barista doctor --json --data-root <path> --manifest components-next.json

# Finish or cancel work according to local policy, then restart the Barista service.
# After restart, doctor and Compute must show the version the new process actually selected.
barista doctor --json --data-root <path> --manifest components-next.json

# If the new version must be backed out, consume the one retained target, then restart again.
barista setup rollback --data-root <path> --manifest components-next.json \
  --kind harness --id <component-id>
barista doctor --json --data-root <path> --manifest components-next.json

# Only after the selected version is healthy and no rollback target is needed:
barista setup prune --data-root <path> --manifest components-next.json \
  --kind harness --id <component-id>
```

Apply and activate do not signal or reconfigure another Barista process. A running daemon keeps the manifest, ledgers, executable, and component report it verified at startup; changing `activation.json` produces one bounded restart-required log notice and neither interrupts an in-flight run nor changes a later pre-restart run. Restart is the sole adoption boundary. A version-5 resident keeps its `instance.id`, but its process-local allocation is marked `lost` and one replacement gets a new `allocation.id` before pinned work resumes. Never infer continuity from the node counters or from a component report.

Rollback verifies the retained bytes again and consumes the retained target; it does not swap the failed version into a new rollback slot, so a second rollback refuses instead of oscillating. Prune removes only inactive, digest-matching files recorded in the ownership ledger. It retains the active and rollback versions, drifted files, unowned files, directories, and symlinks, and never follows a symlink. Investigate a retention before changing bytes or ledgers by hand.

### Installing and verifying the canonical capability pack

Build from the tagged checkout, retain the printed checksum, and use the same manifest for every setup command:

```bash
task capability-pack:build
sha256sum dist/capability-pack/coffeeshop-capability-pack.tar.gz
barista setup plan --data-root <path> --manifest components.json --out pack-plan.json
barista setup apply --data-root <path> --manifest components.json --plan pack-plan.json \
  --manual-artifact coffeeshop-capability-pack=$PWD/dist/capability-pack/coffeeshop-capability-pack.tar.gz \
  --manual-checksum coffeeshop-capability-pack=<sha256>
barista setup activate --data-root <path> --manifest components.json \
  --kind capability-pack --id coffeeshop-capability-pack --version 1.1.0
barista doctor --json --data-root <path> --manifest components.json
```

Activation does not hot-adopt. Restart Barista, then require a fresh current-socket readiness report and a new run whose allocation expectation and effective-pack proof agree. For an upgrade, repeat plan/apply/activate with the next manifest, restart, and verify. To back out, run the following with the manifest that selected the current version, then restart again:

```bash
barista setup rollback --data-root <path> --manifest components-next.json \
  --kind capability-pack --id coffeeshop-capability-pack
barista setup prune --data-root <path> --manifest components-next.json \
  --kind capability-pack --id coffeeshop-capability-pack
```

`not-reported` means the current peer supplied no inventory; `not-applicable` means the pack has no harness executable. Neither means execution-ready. A missing/stale readiness report, absent skill, unsupported ACP surface, projection collision, archive drift, or mismatched effective proof must leave skill work waiting or fail it before the prompt. Inspect fixed diagnostic codes and restart/reconnect state; never repair the symptom by copying a projection, widening a requirement, or moving a provider credential to the Hub.

Run `task system:test:capability-pack` for the named pack slice, `task system:test` for all real-process scenarios, and `GOMAXPROCS=8 task ci` before release.

Component inventory is informational. While the node is connected, its report describes the selection that process verified. A disconnect retains the last report for diagnosis but the node is offline, so the evidence is not live. A fresh registration clears that old report before accepting the new process's post-ack report; a Hub restart preserves the last accepted report with the node's offline state. Absence on a version-4 peer means “not reported,” never “none installed.” None of these states qualifies a node, allocation, or run for scheduling.

Installation and authentication are separate steps, and installing proves nothing about the second. See the next section.

## Provider authentication and the subscription boundary

Codex and Claude authentication stays on the compute node, in the vendors' own CLI storage (ChatGPT login state or an exported API key for Codex; the CLI's locally owned subscription login for Claude). Barista never sets, reads, or forwards a provider credential, and the hub never receives one. This holds identically for a Barista-managed harness: installing and activating one installs no credential and copies none from an existing installation, and it solicits none. Authentication is a separate operator action afterwards — run `claude` or `codex` once on the node and sign in — and `barista doctor` reports it only as a coarse `authReadiness` derived from an exit code, where `unknown` means "absent or timed out" and never "not authenticated". An adapter that reports authentication is required fails the run with that reason; the fix is to sign in on the node and retry — never to move a credential to the hub.

Claude ACP is experimental and gated: it loads only when `--claude-acp-auth-mode` (or `BARISTA_CLAUDE_ACP_AUTH_MODE`) is set to exactly `local-subscription` or `api`. Leaving it unset keeps Claude ACP unavailable regardless of what is installed; `barista doctor` and the daemon log both name the reason.

In `local-subscription` mode, Barista refuses to launch the adapter if its own environment carries any of claude-agent-acp's provider-routing variables: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_VERTEX_BASE_URL`, `ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION`, `AWS_REGION`, `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_OAUTH_TOKEN` (the full list is `ClaudeACPBillingSwitchingVariables` in `apps/control-agent/internal/harness/claude_acp.go`). Any one of them present would silently move a subscription session onto API or cloud billing; the error names the variable, never its value. `api` mode is an explicit administrator acknowledgement that the node is intentionally API/cloud-billed.

Read [anthropic-usage.md](anthropic-usage.md) before broadening Claude use; keep subscription-backed nodes private to the account owner.

## Choosing ACP or the native CLI

The scheduler prefers `acp-v1` for a task attempt when the harness advertises it and the task's requirements allow it; otherwise it dispatches `native-cli`. When both transports are advertised and allowed, the dispatch carries `execution.fallbackTransport: "native-cli"`.

To control the choice per task or per project:

- a task's `requirements.transports` restricts which transports may satisfy the attempt;
- a project profile's hard `transports` list is enforced in addition to the task's.

Native fallback is enabled only when all three hold: the dispatch carries the fallback permission (both transports allowed and advertised), the operator listed the harness in `--acp-native-fallback` (or `BARISTA_ACP_NATIVE_FALLBACK`), and the native CLI passed discovery. Fallback happens only for an enumerated pre-prompt failure:

| Reason | Condition |
|---|---|
| `acp-adapter-unavailable` | No verified adapter at dispatch time, or it could not be started |
| `acp-protocol-incompatible` | Protocol or pinned-version mismatch, protocol violation, or adapter exit before the prompt |
| `acp-capability-missing` | No HTTP MCP support, or a required policy option is not offered or not applied |
| `acp-mcp-unavailable` | The adapter did not list the run's Coffee Shop MCP tools before the prompt |

Missing authentication, a rejected model or configuration request, cancellation, and any failure after the prompt fail the run instead — the attempt is never replayed through another transport. A fallback is visible as a `transport-native-fallback` warning event and in `run.started`'s transport selection (`run.transportSelection` on the run, with the reason). Direct operator-to-agent runs (messages, handoffs) are always native CLI.

To disable ACP on a node: remove the `--acp-adapter` override (`BARISTA_ACP_ADAPTERS`) and, for a setup-installed adapter, delete its executable under the data root (a ledger entry whose file is gone is treated as not installed), then restart Barista. The log then reads `no ACP adapter loaded for <harness-id>: ...`, the harness advertises only `native-cli`, and new task attempts are dispatched natively; nothing else needs to change or migrate. For Claude alone, unsetting `--claude-acp-auth-mode` has the same effect. Task attempts in flight when Barista stops are reconciled as lost at its next reconnect and retried against its new advertisement.

## Project profiles and readiness

Manage projects from the PWA's **Projects** view. Profiles are validated by the hub and stored in SQLite, so adding or changing a project takes effect immediately and does not require editing a deployment file. A profile defines its repository, workspace isolation and cleanup policy, and hard/preferred compute requirements. A profile that looks like it contains a secret is rejected. Editing or deleting a profile that has an active task or unsettled workspace lease is refused with `409`.

The authenticated API is `GET /api/project-profiles`, `POST /api/project-profiles`, `PUT /api/project-profiles/:id`, and `DELETE /api/project-profiles/:id`. `config/project-profiles.example.json` remains a schema example and migration source: `PROJECT_PROFILES_PATH` imports it only when the database has never managed a project catalog.

Check readiness with `GET /api/project-readiness?projectId=<id>` (400 without `projectId`, 404 for an unknown profile). It evaluates the profile against every known node using the same path the scheduler uses, and reports per-node unmet hard requirements and unmet preferences.

Node capability evidence has a TTL of 30 minutes (`defaultEvidenceTTLMilliseconds`), with a small clock-skew allowance for future-dated timestamps. Evidence resolves to `ok`, `missing`, `failed`, `stale`, or `ambiguous`; stale or ambiguous evidence never satisfies a requirement. Evidence refreshes when Barista reconnects and reports periodically, so a node that has been offline longer than the TTL shows as unready until its next report lands. Unmet requirements appear exactly as the scheduler's placement diagnostics (next section).

## Scheduling diagnostics

When a `ready` task cannot be placed, `task.placement.unsatisfied` records every unmet requirement as `{ kind, requirement, nodeId?, agentId?, detail }` (sorted, deduplicated, capped at 200 entries). A task with no eligible compute stays `ready` and is placed automatically on the next scheduling pass once a qualifying node registers — no operator action is required to start it later.

| Kind | Meaning | Action |
|---|---|---|
| `skill` | Agent does not declare a required skill | Adjust the agent's configured skills or the task requirement |
| `harness` | Agent's harness differs, or not reported available on the node | Fix the agent's harness configuration, or make the harness available on the node |
| `model` | Agent's model not advertised by the node's harness | Change the agent's model or make it available |
| `transport` | No advertised transport satisfies the requirement | Install/repair an adapter or relax `requirements.transports` |
| `operating-system` / `architecture` | Worker-reported value does not match | Point the task at a matching node |
| `label` / `memory` | Evidence missing, stale, ambiguous, or below minimum | Declare labels (`--label`) or memory (`--memory-megabytes`) on the node; wait for fresh evidence |
| `concurrency` | Node reports lower concurrency than required | Raise `--concurrency` on the node |
| `project-profile` | Profile not configured, or an unmet hard profile requirement | Update the project in the Projects view or fix the node's evidence |
| `workspace` | Workspace not beneath an advertised root, not writable, lease not provisionable, or repository not authorized | Enroll the root, check writability evidence, or authorize the repository in the profile |
| `node-offline` | Node never registered, not connected, or not past its reconnect barrier | Restore the Barista connection |
| `inventory-stale` | Evidence is older than the TTL or future-dated | Wait for the node's periodic capability report, or check node clock skew |
| `agent` | No configured agent is a candidate, or a placement override is malformed/unauthorized | Configure an agent on a qualifying node, or fix/authorize the override |
| `capacity` | Node slots full, or an `exclusive-existing` lease already holds the workspace | Wait for capacity, or let the existing lease settle |
| `protocol-version` | Node registered a protocol version without the required capability | Upgrade to version 5 for instance placement; versions 1–4 remain compatibility-only |
| `resident-capacity` | All qualifying nodes hold their configured resident slots | Release/drain an instance or raise `BARISTA_INSTANCE_CAPACITY`; this is separate from run concurrency |
| `instance` | An exact pin is missing, foreign, draining, unallocated, or incompatible | Inspect the named thread instance and allocation; an exact pin never falls back |
| `assignment` | A persisted assignment cannot be interpreted | Operator attention required; inspect the task |

Placement overrides (from task pins or policy) only narrow candidates; they never bypass a hard requirement.

## Workspace leases and retained work

A project profile opts into isolation with `workspacePolicy.isolation`: `git-worktree` (requires the profile's `repository`; the worktree lives at `<root>/.coffee-shop/worktrees/<leaseId>` on branch `coffee-shop/<taskId>/<runId>`) or `exclusive-existing` (the agent's checkout, at most one unsettled lease per node and path). `workspacePolicy.cleanup` is `retain` (the default — every finished workspace is kept) or `when-unchanged` (removed only when nothing would be lost).

Lease statuses: `requested → provisioning → active → released → cleaning → cleaned`, plus `retained` (needs an operator) and `failed` (never produced a workspace). Retention reasons: `dirty`, `untracked` (including ignored files such as a harness-written `secrets.env`), `diverged`, `locked`, `unregistered`, `identity-mismatch`, `ambiguous`, `operator-hold`, `policy`. Barista never commits, pushes, force-removes, or resets anything.

Operational endpoints:

- `GET /api/workspace-leases?status=&nodeId=&runId=&taskId=` — list and filter leases.
- `POST /api/workspace-leases/:id/cleanup` — ask Barista to clean a retained lease. Responses: `202` sent; `404` unknown lease; `409` unless the lease is `retained` and its run inactive; `503` when the node is not connected past its barrier (retry after reconnect). The request only records `cleanupRequestedAt`; the lease stays `retained` until Barista reports `cleaning`, and Barista re-verifies that nothing would be lost.

Operator recovery for a retained worktree: inspect it at `<root>/.coffee-shop/worktrees/<leaseId>` (its branch is `coffee-shop/<taskId>/<runId>`). Keep the work by merging or pushing the branch yourself, or discard it by running `git worktree remove --force <path>` and `git branch -D <branch>` from the source checkout. Then request cleanup via `POST /api/workspace-leases/:id/cleanup`: Barista removes what is provably unchanged and records the lease as `cleaned` once nothing of it remains. Do not grant other same-account processes write access to `<root>/.coffee-shop`.

## Approvals

- List: `GET /api/approvals?status=&runId=&threadId=`; one: `GET /api/approvals/:id`.
- Resolve: `POST /api/approvals/:id/resolution` with `{ idempotencyKey, expectedStatus: "pending", optionId }` or `{ idempotencyKey, expectedStatus: "pending", cancel: true }`, optionally `runId` to guard against resolving the wrong run. `idempotencyKey` is at most 256 bytes; replaying the same key with the same choice returns the stored resolution, and a different choice under the same key is a 409.

A pending approval expires nine minutes after the hub received it — deliberately shorter than Barista's ten-minute permission callback timeout, so the hub never approves after Barista gave up. A 15-second sweep in the hub expires due approvals. Status codes: `200` resolved or replayed; `400` malformed input; `404` unknown approval; `409` conflict — the approval is no longer pending, expired, its run ended, or its session was replaced; `422` the selected `optionId` was not offered.

Delivery is tracked separately from the decision: `pending` → `sent` → `applied` (only the harness's own `permission.resolved` event confirms it) or `not-applied`. `not-applied` means the decision stands but never reached the harness session that raised it — the run ended, the session was replaced, the approval expired first, or Barista refused it (`approval.undeliverable`). Decisions are never retargeted to another session; re-answer the new permission request instead. Settled approvals are pruned beyond 50 per run and 500 total; pending and undelivered ones are always kept.

### Approval policy

Each compute node's administrator decides how many permission requests reach these approvals, with `--approval-policy` on Barista (environment `BARISTA_APPROVAL_POLICY`, comma-separated). It is a node-administrator declaration only: the hub and PWA display it read-only, and no dispatch, task requirement, run instruction, or API call can set or change it.

| Setting | Effect |
|---|---|
| `--approval-policy manual` (default) | Every ACP permission request becomes a Coffee Shop approval: Claude ACP runs in `default` ("Manual") mode, Codex ACP in `read-only` ("Ask for approval"). Native CLI runs are unchanged (`--permission-mode auto`, `--sandbox workspace-write`) and never prompt. |
| `--approval-policy auto` | The harness decides permission requests itself: Claude ACP `auto`, Codex ACP `agent` ("Approve for me", same workspace-write sandbox). Only what the harness still escalates reaches Coffee Shop. Native runs are unchanged. |
| `--approval-policy bypass` | No approvals and, for Codex, no sandbox: Claude ACP `bypassPermissions`, Codex ACP `agent-full-access`, native Claude `--permission-mode bypassPermissions`, native Codex `--dangerously-bypass-approvals-and-sandbox`. Use only on an externally sandboxed node. |
| `--approval-policy <harness-id>=<policy>` | Sets one harness (`claude-cli` or `codex-cli`); repeatable, and overrides the node-wide value. Example: `--approval-policy auto --approval-policy claude-cli=manual`. |

Two different values for the same scope (node-wide, or the same harness), an unknown policy, or an unknown harness stop Barista at startup. A mode the adapter does not offer — claude-agent-acp offers `bypassPermissions` only conditionally — fails the run instead of running under another mode. At startup Barista logs one line per relaxed harness, for example `approval policy for claude-cli is bypass: permission requests are not sent to Coffee Shop`; `barista doctor` prints the effective policy for every harness. The Compute view marks a relaxed harness with an "Auto approvals" or "Approvals bypassed" badge, the run inspector's Transport section shows the policy each run actually executed under, and the snapshot carries it as `nodes[].harnesses[].approvalPolicy` and `runs[].transportSelection.approvalPolicy` (absent means `manual`). A policy value the hub does not recognize — reported by a Barista newer than the hub — is never shown as `manual`: the hub records `approvalPolicyUnrecognized: true` instead and the PWA shows an "Unrecognized approval policy" badge. Upgrade the hub first to avoid it.

## Orchestrator sessions and mailbox recovery

Each thread's orchestrator has a durable inbox (`snapshot.orchestratorInboxes`): `deliveredThrough` and `processedThrough` journal sequences, the `redeliveries` and `consecutiveFailures` counters, `retryAfter`, and the most recent 20 wakes with their statuses (`scheduled`, `delivered`, `completed`, `failed`) and `sessionOutcome`. Only the orchestrator's own `wait_for_task_events` cursor advances processing; nothing is lost while the orchestrator is not running, because events wait in the mailbox.

Every scheduling pass reconciles open wakes and, for an active thread whose owner has no active non-task run, creates at most one continuation run covering the oldest 50 unacknowledged relevant events. An idle, compatible session binding whose node still advertises resume is resumed (outcome `resumed`); a failed or refused resume records `replaced`; a first-time ACP session records `new`; a native CLI continuation records `native`.

Failure handling: a range already delivered but never acknowledged is redelivered at most twice until new events arrive (`maximumRedeliveries: 2`). Failed continuations back off exponentially from 5 seconds to a maximum of 10 minutes (`retryBaseMilliseconds`/`retryMaximumMilliseconds`), visible as `consecutiveFailures` and `retryAfter` on the inbox. A continuation not dispatched within ten minutes is cancelled so the claim can be retaken. When a wake keeps failing: check the wake's run failure, the node's placement diagnostics, and the session binding's state; the backoff caps retry pressure on its own, so the usual fix is repairing the underlying cause (node offline, adapter broken, model rejected) rather than intervening in the inbox.

## Connecting Claude Code as an orchestrator

A Claude Code session on your own machine can orchestrate a thread while the hub keeps dispatching the workers. Install the Coffee Shop plugin, which carries a bundled copy of `apps/orchestrator-bridge` and registers it as both an MCP server and a channel. Node.js 18 or newer is required on the machine running Claude Code.

Add the Coffee Shop marketplace, install the plugin, and enable it:

```sh
claude plugin marketplace add cafecito-games/CoffeeShop --sparse .claude-plugin plugins/coffeeshop-orchestrator
claude plugin install coffeeshop-orchestrator@cafecito-games
claude plugin enable coffeeshop-orchestrator@cafecito-games
```

The sparse checkout downloads only the marketplace catalog and plugin rather than the Coffee Shop monorepo. The plugin installs disabled because it connects to an external service. After enabling it, start a normal Claude Code session and configure it interactively:

```text
/plugin configure coffeeshop-orchestrator@cafecito-games
```

Mint a credential in the PWA: **Settings → Connected clients → Connect a Claude Code orchestrator**. Name the machine or session, and tick **Let this orchestrator approve worker actions** only if that session should be allowed to answer worker permission requests on your behalf — that grants the `resolve-approvals` scope, and without it the approval tools are not even offered. The dialog shows the hub URL, client id, one-time secret, install commands, configuration slash command, and launch command. Paste the three connection values into the plugin prompt. Run the same slash command again whenever an existing installation needs a new credential.

**The secret is shown once.** Coffee Shop keeps only a hash of it, and the plugin declares it as sensitive configuration so Claude Code masks the prompt and keeps it out of ordinary settings. Do not pass it with `claude plugin install --config`; that would expose it through shell history and process arguments. If you lose it, revoke the credential and connect again.

The PWA derives the hub URL from the origin it was served from, so a hub reached over `https://` yields `wss://…/orchestrator-client`. All three values are required, and the bridge refuses to start — with a message on stderr, a non-zero exit code, and nothing written to the MCP stream — when one is missing, when the URL is not `ws://` or `wss://`, or when the credential does not satisfy the handshake contract. The secret never appears in the bridge's output.

Start Claude Code with the bridge loaded as a channel, which is what lets Coffee Shop wake an idle session:

```sh
claude --dangerously-load-development-channels plugin:coffeeshop-orchestrator@cafecito-games
```

Channels are a research preview, so a custom marketplace plugin that is not on the effective channel allowlist has to be named at launch like this. They require Anthropic authentication (claude.ai or a Console API key) and are unavailable on Bedrock, Google Cloud Agent Platform, and Microsoft Foundry. Pro and Max users without an organization need nothing beyond the flag. **Claude.ai Team and Enterprise owners must enable `channelsEnabled` and add `{ "marketplace": "cafecito-games", "plugin": "coffeeshop-orchestrator" }` to `allowedChannelPlugins`**; an allowlisted installation can launch with `--channels plugin:coffeeshop-orchestrator@cafecito-games` instead.

### Without channels

Every tool still works. `get_thread_context` reports `"channels": "unknown"` until a channel event has actually been delivered, after which it reads `"channels": "active"`. With channels unavailable, poll instead of waiting: `get_thread_events` accepts `waitMilliseconds` and the hub holds the call open for up to 20 seconds. The acknowledged cursor is the only delivery truth either way — a lost doorbell costs latency, never events.

### Revoking a laptop

**Settings → Connected clients → Revoke**, then confirm. The hub persists the revocation, closes every live socket holding that credential, and releases its attachments; the session's tools start failing with `revoked` and the bridge stops reconnecting. Revocation is permanent — connect the machine again with a freshly minted credential. To narrow a credential instead of ending it, use **Edit scopes**; a revoked credential's scopes can no longer change (the hub answers 409).

Threads are unaffected: workers keep running, events accumulate, and approvals stay answerable in the PWA.

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| No doorbells reach the session | The plugin was not selected as a channel (`--dangerously-load-development-channels plugin:coffeeshop-orchestrator@cafecito-games`), or the Team/Enterprise channel policy does not allow it. Confirm with `get_thread_context`: `"channels": "unknown"` means none has been delivered yet. Meanwhile poll `get_thread_events` with `waitMilliseconds`. |
| Doorbells stop after a while | At most one ring per thread per 2 seconds, and only for events newer than the last ring; an already-rung backlog is not rung again. Acknowledge with a cursor and the next event rings again. |
| `not_attached` | This connection holds no attachment on that thread — it was replaced by another session, released when the socket dropped, or expired after 45 seconds without a heartbeat. Call `attach_thread` with the thread id. |
| A "taken over by another session" notice, or `attachment.replaced` | Another session attached the same thread; a thread has exactly one attachment. Stop the other session, or re-attach here to take it back. |
| `hub_unavailable` | The bridge is not connected; it reconnects on its own with capped backoff (1 s to 30 s) and never queues calls. Check the hub URL, TLS termination, and the hub's reachability, then retry the call. |
| `revoked` | The credential was revoked in the PWA. Mint a new one, reconfigure the plugin through `/plugin`, and restart the bridge; it will not reconnect with the revoked credential. |
| `forbidden` on `resolve_approval` | The credential lacks `resolve-approvals`. Grant it with **Edit scopes**; the bridge re-lists its tools when the scope change is observed on reconnect. |
| The thread shows "Detached since …" in the PWA | No session is attached. Workers continue; attach again to resume orchestrating. |
| The bridge exits immediately | A missing or malformed `COFFEE_SHOP_HUB_URL`, `COFFEE_SHOP_CLIENT_ID`, or `COFFEE_SHOP_CLIENT_SECRET`. The reason is on stderr and names the variable, never its value. |

Approvals an orchestrator resolves are labelled "Resolved by orchestrator (<credential name>)" in the PWA, so a decision a model made on your behalf is never mistaken for one you made yourself.

## Monitoring and diagnostics

- `GET /api/health` — liveness plus the number of connected control agents.
- `GET /api/snapshot` — full published state. Watch `nodes[].activeRuns`/`concurrency` separately from `activeInstances`/`instanceCapacity`; correlate work only by exact `runs[].instanceId` plus `allocationId`; inspect `instances`, `allocations`, `tasks[].placement.unsatisfied`, approvals, leases, and inbox failures.
- `GET /api/threads/:threadId/instances?includeTerminal=true` and `GET /api/threads/:threadId/instances/:instanceId` — thread-scoped lifecycle and retained allocation history. Create with `POST /api/threads/:threadId/instances`; renew and release through the corresponding instance routes using stable idempotency keys. Use `mode: "drain"` to wait for active work and `mode: "cancel"` to terminate it.
- Instance leases expire at the closed `expiresAt` boundary. Renew before that timestamp with one stable key; the Hub serializes renewal and expiry, so the first committed state wins and an exact renewal replay cannot extend the lease twice. The 15-second maintenance pass begins drain for an idle expired resident and keeps its slot occupied until exact release acknowledgement.
- `GET /api/runs/:id/events?after=N` — retained harness events plus the `runActivity` projection for a run.
- Barista logs (stdout/stderr, collected by the service manager): discovery, connection state, enrolled roots, `ACP adapter for <id> passed its startup probe` / `is disabled: ...`, and `no ACP adapter loaded for <id>: <reason>`.
- `barista doctor --json` — machine-readable node readiness.
- Hub log lines: startup listen line, `loaded N project profile(s)`, rejected-message warnings (`rejected harness.event from <node>`, `rejected workspace.lease from <node>`), and errors from the scheduler, approval expiry, and scheduling passes.

The hub pings every control socket every 15 seconds and terminates a socket that misses its pong, so `nodes[].status` reflects liveness, not just the last message.

## Upgrades and rollback

Ship the hub and Barista from the same release and upgrade the hub first. A version-4 Barista may reconnect and settle compatible legacy work, but it is excluded from new instances until upgraded to version 5:

1. Stop the Baristas, or leave them running and accept their reconnect loop until restarted.
2. Upgrade and restart the hub; it reloads authoritative SQLite state and marks disconnected nodes offline.
3. Upgrade and restart each Barista; each re-registers (the hub refuses a second live connection for a node ID with close code 1008, so stop the old process first) and passes its reconnect barrier.

Older Baristas registering protocol versions 1–4 keep only their advertised compatibility behavior and never receive a new instance provision or instance dispatch. Version-1 nodes additionally have queued-run redispatch disabled.

Rollback caveats: persisted state written by a newer hub may contain values an older hub cannot interpret—loading fails rather than guessing. Back up the SQLite database (including WAL/SHM while live, preferably with SQLite's backup mechanism), artifact tree, and prepared previews together before upgrade. `COFFEE_SHOP_DATA` is a one-time legacy JSON import source only: once the database contains state, SQLite is authoritative and later JSON changes are ignored. Rolling back across the v5 schema boundary requires restoring that pre-upgrade backup; an older hub must not be pointed at v5 state and expected to discard it.

Managed-component upgrades ship as a new manifest pin in a new Barista build. Follow the tested plan/apply/activate/restart procedure above for harnesses and adapters; an adapter supplied with `--acp-adapter` remains an explicit digest-pinned alternative. Barista always refuses an adapter whose pinned version does not match its manifest, and a running process never hot-adopts a changed activation ledger.

## Failure recovery

| Symptom | Cause | Action |
|---|---|---|
| Node shows offline; runs stay queued | Barista process down or network partition | Restart Barista or restore connectivity; queued runs are dispatched after its reconnect barrier. Nothing else to do. |
| Task attempt failed, task returned to `ready` | Node reconnected without reporting the run as active (lost compute) | Automatic: a new attempt is created, up to 3 attempts per task (`maximumTaskAttempts`), after which the task fails. Inspect the earlier attempts' runs if it keeps recurring. |
| Run fails with an ACP protocol/framing error | Adapter crashed or emitted a malformed frame | The run fails and is not retried through another transport; a task retry is a new attempt. Fix or re-pin the adapter, verify with `barista doctor`, and let the task retry. |
| Approval stuck pending | Operator has not answered, or delivery is blocked | Answer within the 9-minute lifetime. If delivery shows `not-applied`, the harness session is gone; handle the new permission request instead. |
| Lease stuck `retained` | Dirty, diverged, or ambiguous worktree | Follow the recovery procedure above: merge/push to keep, or `git worktree remove --force` + `git branch -D` to discard, then `POST /api/workspace-leases/:id/cleanup`. |
| Orchestrator wake keeps failing | Continuation run failing repeatedly | Backoff (5 s → 10 min) caps pressure automatically; fix the underlying placement or harness failure and watch `consecutiveFailures` reset. |
| Hub restarted | Process or host restart | State reloads from SQLite, Baristas reconnect, replay outboxes, and reconcile exact resident inventories before scheduling resumes. |
| Instance remains draining/failed | Release cleanup failed or no exact acknowledgement arrived | Keep it visible; do not edit SQLite or infer a free slot. Restore the Barista and retry the same release key/mode. Unknown remote residents are released, never adopted. |
| Barista restarted | Process or node restart | It re-registers with a fresh inventory and capability report; running task attempts it no longer reports fail like lost attempts and retry. Cancelled runs stay cancelled because the hub, not Barista, is authoritative for run state. |
| Setup apply refuses an edited/stale plan, changed target, checksum, digest, size, redirect, archive, or platform | The immutable plan no longer proves the exact operation, or the platform has no declared distribution | Leave the existing ledgers and selection alone. Correct the manifest/source/allowed host, create a fresh plan, and apply it. An unsupported platform has no fallback operation. |
| Activate or rollback refuses a version | The candidate is absent, drifted, mismatched, unowned, or failed its bounded version probe | Keep running the previously selected process. Restore the exact owned bytes from the reviewed source or choose a new declared version, then rerun doctor and the operation. Never edit the ledgers to force it. |
| Compute still reports the old version after activation | The daemon correctly kept its startup selection | Finish or cancel work, restart that Barista once, then wait for its fresh post-registration component report. Do not expect reconnecting the same process to adopt it. |
| Prune reports retained files | The version is active/rollback-protected, or the path is drifted, unowned, a directory, or a symlink | Treat the report as a refusal, inspect locally, and correct ownership intentionally. Prune never deletes or follows evidence it cannot prove. |

## Security invariants

These must remain true in any deployment; do not weaken them:

- Provider credentials never reach the hub; they stay in vendor CLI storage on the compute node.
- `COFFEE_SHOP_TOKEN` and the run-scoped `COFFEE_SHOP_MCP_TOKEN` are stripped from the environment handed to ACP adapter processes.
- MCP is served only on `127.0.0.1` with run-scoped bearer capabilities, revoked when the run terminates; the long-lived enrollment token is never passed to a harness.
- `WORKSPACE_ROOTS` must stay absolute and are enforced after canonicalization, including through symlinks.
- Adapters are never downloaded at runtime; only verified setup-installed or digest-pinned administrator executables are launched.
- The hub never supplies commands, executable names, or argument lists to Barista; toolchain probes are fixed at compile time.
- Approvals fail closed under the default `manual` approval policy: unanswered, timed-out, or invalid permission requests are never allowed, and a harness can never approve or reject on its own. `auto` and `bypass` are explicit node-administrator opt-ins, set only in that node's Barista configuration, that let the harness decide or skip its own permission requests and so bypass Coffee Shop approvals for that harness; nothing the hub sends can enable them.
- Dirty or ambiguous worktrees are retained, never reset or force-removed.
- Secrets are redacted: accepted events are screened for common credential shapes before retention, configuration rejections never echo the rejected value, and secret-looking probe output is withheld from logs.

## Verifying a release

Run `task ci` (format checks, TypeScript, Go, and system tests, typechecks, vet, and builds) before releasing. `task test` includes `task system:test`, which can also be run on its own: a deterministic multi-node end-to-end suite (`apps/control-agent/internal/systemtest`) that starts a real hub and real Barista processes, installs `fakeharness` as the pinned ACP adapters and native CLIs, and proves the orchestration workflow and its failure handling — parallel placement across two nodes and harnesses, dependency blocking, durable messages, approvals (accept, reject, expiry), cancellation, adapter crash, malformed frames, native fallback, partition and crash recovery, hub restart, session resume and replacement, workspace collision and dirty retention, cross-thread isolation, mixed protocol versions, credential canaries, and the version-5 instance lifecycle (replay, exact pins, independent capacities, expiry, drain/cancel, reconnect replacement, migration, and v4 exclusion). `task system:test:instances` runs that focused instance slice. The suite needs Node.js with workspace dependencies (`task install`), Go, and Git, uses no provider account or network, and keeps a failing scenario's temporary directory (logged) for diagnosis. It does not exercise real adapter builds; verify those on each node with the startup probe and `barista doctor`.
