# Operations runbook

This runbook is for the operator of a Coffee Shop deployment: the person who deploys the hub, installs Barista on compute machines, and answers when something stops working. Three kinds of process are involved:

- the **hub** (`apps/hub`): REST API, WebSocket gateway, scheduler, and durable JSON store;
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
| `COFFEE_SHOP_DATA` | Absolute path of the JSON state file. | `<repo>/data/state.json` (the container sets `/data/state.json`) |
| `PROJECT_PROFILES_PATH` | Path to the project profiles JSON file. | `<repo>/config/project-profiles.json`; when that file does not exist and the variable is unset, the hub logs `no project profiles configured; set PROJECT_PROFILES_PATH to enable project readiness` and runs without profiles |

Durable state is the JSON state file plus an `artifacts` directory created **next to** the state file (`<dirname>/artifacts/`). Both must be on a persistent volume. Writes are atomic (temporary file plus rename), and the hub reloads full state from the file at startup.

Build and run the container with `task container:build` and `docker compose up`; `compose.yaml` requires `COFFEE_SHOP_TOKEN` and mounts the `coffee-shop-data` volume at `/data`. Terminate TLS in front of the hub. The startup log line is `Coffee Shop hub listening on http://localhost:<port>`.

Health check: `GET /api/health` returns `{ ok, service, controlAgents }` and is never token-gated. Back up the state file and the artifacts directory before every upgrade; never commit `data/*.json` or a real token.

## Bootstrapping a compute node

1. Build and copy the binary: `task control-agent:build` (or `task control-agent:build:all` for cross-compiled release binaries under `dist/barista`). Copy it to a stable location on the node.
2. Create a dedicated service account that can read/write the enrolled workspaces and read the locally authenticated CLI state, and nothing broader. Run Barista under the platform service manager (systemd, launchd, Windows service wrapper) with a protected environment file.
3. Provide the enrollment token through the environment, `COFFEE_SHOP_TOKEN`, never `--token` — process listings and shell history expose flag values.
4. Enroll workspace roots with repeated `--workspace-root` flags or `WORKSPACE_ROOTS` (comma-separated). Every root must be absolute and must exist; with no root configured Barista authorizes only its working directory.
5. Declare node inventory as needed: `--label`, `--accelerator`, `--toolchain <id>[@<version>]`, `--memory-megabytes`, `--project` (project allowlist; empty means unrestricted). These are administrator declarations, not proofs; ids are lowercase kebab-case, values are screened for secrets, and conflicting duplicate toolchain versions stop startup.

Core flags and environment equivalents: `--control-endpoint` (`CONTROL_ENDPOINT`, default `http://localhost:8787`; bare hostnames become `wss://<host>/control-agent`), `--name` (`BARISTA_NAME`), `--id` (`BARISTA_ID`, derived from the hostname), `--kind` (`BARISTA_KIND`: `local`, `home-server`, `cloud`), `--concurrency` (`BARISTA_CONCURRENCY`, default 2), `--data-root` (`BARISTA_DATA_ROOT`), `--version` to print the binary version. Run `barista --help` for the full list.

Node setup workflow:

- `barista setup plan --data-root <path> [--manifest <path>] [--out <file>]` — read-only; renders the exact operations an apply would perform as a digest-sealed JSON plan. It writes nothing under the data root and creates no ledger.
- `barista setup apply --plan <file> [--manual-artifact <adapterId>=<path>] [--manual-checksum <adapterId>=<sha256>] [--manifest <path>] [--allowed-host <host>]` — the only mutating command, and the only one that creates the data root. A hand-edited plan, a changed manifest, or a target that changed since planning is refused before any mutation.
- `barista doctor [--data-root] [--manifest] [--control-endpoint] [--claude-acp-auth-mode] [--approval-policy] [--json]` — entirely read-only (it also prints the effective [approval policy](#approval-policy) per harness): re-verifies installed adapters against the ownership ledger, runs coarse exit-code auth probes, and makes one unauthenticated TCP connection attempt to the control endpoint. Doctor exits 0 whenever it could build a report; problems show up in the report itself.

The default data root resolves through `os.UserConfigDir()` to `<user config>/coffee-shop/barista`, never `$HOME` itself. The adapter manifest is compiled into the binary; `--adapter-manifest` (`BARISTA_ADAPTER_MANIFEST`) overrides it for both the daemon and setup.

## Installing and verifying ACP adapters

The compiled-in manifest (`apps/control-agent/internal/setup/manifest/adapters.json`) pins:

- `codex-acp` (`@agentclientprotocol/codex-acp`) **1.12.0**, harness `codex-cli`;
- `claude-acp` (`@agentclientprotocol/claude-agent-acp`) **0.79.0**, harness `claude-cli`.

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

## Provider authentication and the subscription boundary

Codex and Claude authentication stays on the compute node, in the vendors' own CLI storage (ChatGPT login state or an exported API key for Codex; the CLI's locally owned subscription login for Claude). Barista never sets, reads, or forwards a provider credential, and the hub never receives one. An adapter that reports authentication is required fails the run with that reason; the fix is to sign in on the node and retry — never to move a credential to the hub.

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

Set `PROJECT_PROFILES_PATH` to a non-secret JSON file describing what each project needs from a node. Schema fields follow `config/project-profiles.example.json`: `schemaVersion`, `id`, `name`, `repository` (`url`, `defaultBranch`), `workspacePolicy` (`requireWritable`, `allowedRepositories`, `isolation`, `cleanup`), and `requirements.hard` / `requirements.preferred` (operating systems, architectures, labels, accelerators, toolchains with `versionConstraint`, harness ids, transports, memory, CPU minimums). A profile that looks like it contains a secret is rejected at load time. The hub logs `loaded N project profile(s) from <path>` on success; a malformed configured file stops startup.

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
| `project-profile` | Profile not loaded, or an unmet hard profile requirement | Fix `PROJECT_PROFILES_PATH` or the node's evidence |
| `workspace` | Workspace not beneath an advertised root, not writable, lease not provisionable, or repository not authorized | Enroll the root, check writability evidence, or authorize the repository in the profile |
| `node-offline` | Node never registered, not connected, or not past its reconnect barrier | Restore the Barista connection |
| `inventory-stale` | Evidence is older than the TTL or future-dated | Wait for the node's periodic capability report, or check node clock skew |
| `agent` | No configured agent is a candidate, or a placement override is malformed/unauthorized | Configure an agent on a qualifying node, or fix/authorize the override |
| `capacity` | Node slots full, or an `exclusive-existing` lease already holds the workspace | Wait for capacity, or let the existing lease settle |
| `protocol-version` | Node registered a protocol version without orchestration | Upgrade that Barista to version 4 |
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

Two different values for the same scope (node-wide, or the same harness), an unknown policy, or an unknown harness stop Barista at startup. A mode the adapter does not offer — claude-agent-acp offers `bypassPermissions` only conditionally — fails the run instead of running under another mode. At startup Barista logs one line per relaxed harness, for example `approval policy for claude-cli is bypass: permission requests are not sent to Coffee Shop`; `barista doctor` prints the effective policy for every harness. The Compute view marks a relaxed harness with an "Auto approvals" or "Approvals bypassed" badge, the run inspector's Transport section shows the policy each run actually executed under, and the snapshot carries it as `nodes[].harnesses[].approvalPolicy` and `runs[].transportSelection.approvalPolicy` (absent means `manual`).

## Orchestrator sessions and mailbox recovery

Each thread's orchestrator has a durable inbox (`snapshot.orchestratorInboxes`): `deliveredThrough` and `processedThrough` journal sequences, the `redeliveries` and `consecutiveFailures` counters, `retryAfter`, and the most recent 20 wakes with their statuses (`scheduled`, `delivered`, `completed`, `failed`) and `sessionOutcome`. Only the orchestrator's own `wait_for_task_events` cursor advances processing; nothing is lost while the orchestrator is not running, because events wait in the mailbox.

Every scheduling pass reconciles open wakes and, for an active thread whose owner has no active non-task run, creates at most one continuation run covering the oldest 50 unacknowledged relevant events. An idle, compatible session binding whose node still advertises resume is resumed (outcome `resumed`); a failed or refused resume records `replaced`; a first-time ACP session records `new`; a native CLI continuation records `native`.

Failure handling: a range already delivered but never acknowledged is redelivered at most twice until new events arrive (`maximumRedeliveries: 2`). Failed continuations back off exponentially from 5 seconds to a maximum of 10 minutes (`retryBaseMilliseconds`/`retryMaximumMilliseconds`), visible as `consecutiveFailures` and `retryAfter` on the inbox. A continuation not dispatched within ten minutes is cancelled so the claim can be retaken. When a wake keeps failing: check the wake's run failure, the node's placement diagnostics, and the session binding's state; the backoff caps retry pressure on its own, so the usual fix is repairing the underlying cause (node offline, adapter broken, model rejected) rather than intervening in the inbox.

## Monitoring and diagnostics

- `GET /api/health` — liveness plus the number of connected control agents.
- `GET /api/snapshot` — full published state. Fields worth watching: `nodes[].status`/`activeRuns`/`lastSeen`/`harnesses[].transports`; `runs[].status` and `runs[].transportSelection`; `tasks[].placement.unsatisfied`; `approvals[]` pending count; `workspaceLeases[]` non-settled statuses; `orchestratorInboxes[]` `consecutiveFailures`.
- `GET /api/runs/:id/events?after=N` — retained harness events plus the `runActivity` projection for a run.
- Barista logs (stdout/stderr, collected by the service manager): discovery, connection state, enrolled roots, `ACP adapter for <id> passed its startup probe` / `is disabled: ...`, and `no ACP adapter loaded for <id>: <reason>`.
- `barista doctor --json` — machine-readable node readiness.
- Hub log lines: startup listen line, `loaded N project profile(s)`, rejected-message warnings (`rejected harness.event from <node>`, `rejected workspace.lease from <node>`), and errors from the scheduler, approval expiry, and scheduling passes.

The hub pings every control socket every 15 seconds and terminates a socket that misses its pong, so `nodes[].status` reflects liveness, not just the last message.

## Upgrades and rollback

Ship the hub and Barista from the same release. The hub acknowledges an admitted registration with a `ping`, and Barista waits up to ten seconds for that acknowledgement before replaying its outbox; a current Barista connected to a hub that predates the acknowledgement never completes registration and stays in its reconnect loop. Upgrade the hub first:

1. Stop the Baristas, or leave them running and accept their reconnect loop until restarted.
2. Upgrade and restart the hub; it reloads state from the JSON file and marks disconnected nodes offline.
3. Upgrade and restart each Barista; each re-registers (the hub refuses a second live connection for a node ID with close code 1008, so stop the old process first) and passes its reconnect barrier.

Older Baristas registering protocol versions 1–3 keep their legacy direct runs but never receive task attempts (a `protocol-version` diagnostic excludes them). Version-1 nodes additionally have queued-run redispatch disabled.

Rollback caveats: persisted state written by a newer hub may contain values an older hub cannot interpret — loading fails rather than guessing — so keep a backup of the state file (and artifacts directory) from before the upgrade and restore it when rolling the hub back. Roll the Baristas back together with the hub, for the registration acknowledgement reason above. A Barista rolled back to an older protocol version keeps legacy direct runs only; its running task attempts are reconciled as lost at its next reconnect barrier.

Adapter upgrades ship as a new manifest pin in a new Barista build: build the new adapter artifact, `barista setup plan` / `setup apply --manual-artifact` / `--manual-checksum` (or update the `--acp-adapter` digest), and restart Barista. Barista always refuses an adapter whose pinned version does not match its manifest.

## Failure recovery

| Symptom | Cause | Action |
|---|---|---|
| Node shows offline; runs stay queued | Barista process down or network partition | Restart Barista or restore connectivity; queued runs are dispatched after its reconnect barrier. Nothing else to do. |
| Task attempt failed, task returned to `ready` | Node reconnected without reporting the run as active (lost compute) | Automatic: a new attempt is created, up to 3 attempts per task (`maximumTaskAttempts`), after which the task fails. Inspect the earlier attempts' runs if it keeps recurring. |
| Run fails with an ACP protocol/framing error | Adapter crashed or emitted a malformed frame | The run fails and is not retried through another transport; a task retry is a new attempt. Fix or re-pin the adapter, verify with `barista doctor`, and let the task retry. |
| Approval stuck pending | Operator has not answered, or delivery is blocked | Answer within the 9-minute lifetime. If delivery shows `not-applied`, the harness session is gone; handle the new permission request instead. |
| Lease stuck `retained` | Dirty, diverged, or ambiguous worktree | Follow the recovery procedure above: merge/push to keep, or `git worktree remove --force` + `git branch -D` to discard, then `POST /api/workspace-leases/:id/cleanup`. |
| Orchestrator wake keeps failing | Continuation run failing repeatedly | Backoff (5 s → 10 min) caps pressure automatically; fix the underlying placement or harness failure and watch `consecutiveFailures` reset. |
| Hub restarted | Process or host restart | State reloads from the JSON file, Baristas reconnect and replay their outboxes, offline nodes are marked, and scheduling resumes. Nothing to do. |
| Barista restarted | Process or node restart | It re-registers with a fresh inventory and capability report; running task attempts it no longer reports fail like lost attempts and retry. Cancelled runs stay cancelled because the hub, not Barista, is authoritative for run state. |

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

Run `task ci` (format checks, TypeScript, Go, and system tests, typechecks, vet, and builds) before releasing. `task test` includes `task system:test`, which can also be run on its own: a deterministic multi-node end-to-end suite (`apps/control-agent/internal/systemtest`) that starts a real hub and real Barista processes, installs `fakeharness` as the pinned ACP adapters and native CLIs, and proves the orchestration workflow and its failure handling — parallel placement across two nodes and harnesses, dependency blocking, durable messages, approvals (accept, reject, expiry), cancellation, adapter crash, malformed frames, native fallback, partition and crash recovery, hub restart, session resume and replacement, workspace collision and dirty retention, cross-thread isolation, mixed protocol versions, and a credential canary. It needs Node.js with workspace dependencies (`task install`), Go, and Git, uses no provider account or network, and keeps a failing scenario's temporary directory (logged) for diagnosis. It does not exercise real adapter builds; verify those on each node with the startup probe and `barista doctor`.
