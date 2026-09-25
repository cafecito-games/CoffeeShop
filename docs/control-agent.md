# Barista control agent

Barista is the machine-local half of Coffee Shop. It is installed once on every computer that contributes compute and connects outbound to the control plane. It has no network-reachable listener; its MCP bridge binds only to loopback.

## Startup

At startup Barista:

1. parses flags and environment configuration;
2. canonicalizes every workspace root and refuses missing roots;
3. locates `claude` and `codex` on `PATH` and runs each binary's `--version` check;
4. loads ACP adapters (see [ACP adapters](#acp-adapters)) and probes each with an ACP `initialize` handshake;
5. exits if no supported harness passes discovery through either transport;
6. starts an authenticated MCP endpoint on an ephemeral loopback-only port;
7. opens an authenticated WebSocket to `/control-agent`;
8. registers the node, its platform, capacity, workspace roots, Barista version, and discovered harnesses with their transports;
9. maintains heartbeats and reconnects with bounded exponential backoff.

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

Repeat `--workspace-root` to enroll multiple trees. `WORKSPACE_ROOTS` accepts comma-separated values. Commas cannot be represented inside an environment-configured root; use repeated `--workspace-root` flags when a path contains one.
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
| `BARISTA_PROJECT_ALLOWLIST` | Comma-separated project IDs this node accepts work for; empty means unrestricted |
| `BARISTA_LABELS` | Comma-separated operator-assigned capability labels (lowercase letters, numbers, and hyphens) |
| `BARISTA_ACCELERATORS` | Comma-separated hardware accelerators available on this node (lowercase letters, numbers, and hyphens) |
| `BARISTA_TOOLCHAINS` | Comma-separated toolchains available on this node, each `<id>` or `<id>@<version>` |
| `BARISTA_MEMORY_MEGABYTES` | Configured system memory in megabytes; absent or `0` means not configured |
| `BARISTA_DATA_ROOT` | Absolute Barista-owned data root holding setup-installed ACP adapters (`--data-root`; defaults to the same root `barista setup` uses) |
| `BARISTA_ADAPTER_MANIFEST` | Absolute path of the adapter manifest `barista setup` was run with (`--adapter-manifest`; defaults to the embedded manifest) |
| `BARISTA_ACP_ADAPTERS` | Comma-separated administrator adapter overrides, each `<harness-id>=sha256:<digest>:<absolute path>` (`--acp-adapter`) |
| `BARISTA_ACP_NATIVE_FALLBACK` | Comma-separated harness IDs whose ACP runs may fall back to the native CLI (`--acp-native-fallback`) |
| `BARISTA_CLAUDE_ACP_AUTH_MODE` | `local-subscription` or `api`; required before the Claude ACP adapter is loaded (`--claude-acp-auth-mode`, see [Claude over ACP](#claude-over-acp)) |

The UI deliberately emits `COFFEE_SHOP_TOKEN='replace-with-hub-token'`; it never reads the browser’s stored hub token into setup guidance. Replace the placeholder locally on the compute machine, or use a protected environment file when installing Barista as a service.

## Control API

The control plane sends these JSON messages:

- `dispatch`: immutable run snapshot plus the assigned agent;
- `cancel`: run ID to terminate;
- `ping`: request an immediate heartbeat;
- `approval.decision` (version 4): the operator or policy resolution of a pending harness permission request;
- `workspace.lease.confirmed` (version 4): the hub has persisted a lease as `active` for that run; only then may Barista start its harness;
- `workspace.cleanup` (version 4): a request to reconcile (`mode: "reconcile"`) or explicitly clean up (`mode: "operator"`) a workspace lease no live run owns.

Version 4 also adds an optional `execution` object to `dispatch` carrying the harness transport, the permitted fallback transport, task attempt, a provider session to resume, and the granted workspace lease.

Barista sends:

- `register`: protocol version and compute-node inventory;
- `sync.complete`: version 2 reconnect barrier sent after queued lifecycle messages;
- `heartbeat`: node ID, active run count, and timestamp;
- `run.started`, `run.output`, `run.completed`, and `run.failed`: run lifecycle. `run.started` is sent when the harness is about to receive its prompt and carries the run's transport selection (version 4);
- `run.cancelled`: acknowledgement that Barista recorded a cancellation tombstone and, for active work, terminated the harness process tree.
- `hub.rpc.request`: a correlated, active-run-bound request made through Barista's MCP bridge;
- `harness.event` (version 4): one normalized, bounded harness event;
- `session.binding` (version 4): the provider session an ACP run's prompt is about to reach, reported once per run before `run.started`. It names the dispatch's binding only when that session actually resumed; a new session carries no binding identity, and the hub records it as a replacement;
- `workspace.lease` (version 4): provisioning, release, cleanup, or retention of a workspace lease.
- `capability.report` (version 4): bounded runtime, configured, and probed node capability evidence sent once per connection and refreshed periodically.
- `approval.undeliverable` (version 4): an approval decision Barista could not apply because no live permission request matched it, the option was not offered, or a different decision was already applied.

The hub sends `hub.rpc.response` with either a structured result or a typed error. Protocol version 3 adds these RPC messages. They are not placed in the reconnect lifecycle outbox: a disconnected call fails promptly, while mutation idempotency makes an explicit retry safe.

## Harness MCP bridge

Barista exposes a Streamable HTTP MCP server on `127.0.0.1` only. Each run receives an opaque bearer capability in its generated harness configuration. The capability is mapped in memory to the active run and authorized workspace, and is revoked during completion, failure, or cancellation. The long-lived `COFFEE_SHOP_TOKEN` is never passed to the harness.

The MCP server is named `coffee_shop_hub`. Its tools are the shared `hubToolNames` vocabulary; delegation tools are listed and served only when the agent's **Allow delegation** setting is enabled, and the hub re-checks that permission:

- `get_task_context`: read the durable thread, the caller's task or a visible related task, dependencies, attempts, child tasks, thread artifacts, the mailbox summary and cursor, limits, and available teammates;
- `send_task_message`: send an immutable, idempotent message to the thread orchestrator or a task in the caller's lineage;
- `wait_for_task_events`: long-poll, for at most 20 seconds, for messages to the caller and changes to visible tasks after an opaque cursor, optionally acknowledging handled messages;
- `update_task`: report progress, an advisory blocked reason, or completion fields as the task's current assignee;
- `post_artifact`: validate and publish a regular file beneath the active workspace, capped at 10 MiB;
- `update_thread`: let the owner agent refine the current thread's title, objective, or summary, or mark it active/completed. Archival remains an operator action;
- `get_execution_inventory` (delegation): list agents, skills, nodes, harnesses, capacity, and worker-reported capability freshness;
- `submit_tasks` (delegation): submit an atomic, idempotent task batch with capability requirements, preferences, dependencies, and optional pins;
- `delegate_task` (delegation): submit one task pinned to a named agent through the same task and scheduler path.

Barista rejects unknown tools and non-object arguments before calling the hub. Tool failures are returned as `{"error":{"code","message","retryable"}}`; a lost control connection or an RPC timeout is `retryable`, and repeating the call with the same idempotency key is safe. Claude Code's allowed-tool list is generated from the same tool list.

The capability determines `threadId`, the sender, and the lineage; the harness never supplies them to any tool. This prevents accidental or adversarial cross-thread attachment.

Claude Code receives the server through `--mcp-config`; Codex receives run-local `mcp_servers` configuration overrides. Both use an environment reference for the ephemeral bearer token, so its value is not placed in process arguments. The older final-response handoff directive remains available when MCP cannot be loaded by an older harness.

Cancellation commands are idempotent from Barista's perspective. A cancel received before its matching dispatch prevents the process from starting and is acknowledged immediately; a cancel received during execution terminates the process tree and is acknowledged after cleanup without translating that intentional termination into `run.failed`. Tombstones survive control-plane reconnects for the lifetime of the Barista process, so a replayed dispatch cannot resurrect cancelled work. The hub persists cancellation before sending the command and remains authoritative if Barista is offline.

A node has at most one live connection. The hub refuses a `register` (closing the socket with code 1008) while another connection for the same node ID is still open, rather than letting it supersede the live one: a second Barista process registered under the same node would report only its own active runs, and lost-attempt reconciliation or workspace cleanup computed from that list would act on work the first process is still running. The hub pings every control socket every 15 seconds and terminates one that misses a pong, so a half-open connection blocks a reconnecting Barista only briefly. The hub acknowledges an admitted registration with `ping`, and Barista waits for that acknowledgement before replaying its outbox, so nothing queued is ever written to a refused socket.

On reconnect, protocol versions 2 and 3 send `register`, flush the lifecycle outbox, and then send `sync.complete` with any run IDs still active on Barista. The hub processes those messages in socket order and waits for the barrier before redispatching queued runs, excluding work Barista reports as active. Version 4 always carries `activeRunIds` on `sync.complete`, even when empty (`"activeRunIds":[]`), so the hub can distinguish a reported-empty active set from an absent one. Version 1 remains accepted during rolling upgrades so existing lifecycle events can settle, but queued-run redispatch is disabled for v1; upgrade that Barista to resume queued work safely.

## Protocol versions

Barista registers exactly one control protocol version per connection. The Go package defines every version the hub accepts and the capability each introduced: `replay-barrier` in 2, `hub-rpc` in 3, and `orchestration` in 4. Barista registers version 4 and rejects version-4 dispatch execution it cannot honor rather than degrading it. Before any process starts, the dispatch guard fails with an explicit `run.failed` error a dispatch whose run and execution name different transports, an unknown transport, an `acp-v1` run for which no verified adapter is available (unless native fallback is permitted, below), a fallback transport other than `native-cli` on an `acp-v1` run, a `sessionBinding` that does not match the run's `sessionBindingId`, is malformed, is on a run that is not `acp-v1`, or names a harness whose adapter did not negotiate session resume or load in its startup probe, or a `workspaceLease` that is malformed, names a policy this Barista cannot provision, does not match the run's `workspaceLeaseId` and `workspace`, or (for a worktree) lacks the run's task identity; a run naming a lease without its grant is rejected the same way. Lease acceptance is the guard's final check. The hub rejects unknown versions before dispatch and never sends a message whose capability the registered version lacks.

Barista sends each normalized harness event in an exact `{ type: "harness.event", event }` envelope and assigns its own per-run sequence starting at 1. While disconnected it queues at most 2,048 events or 8 MiB of them; further ordinary events are dropped and reported by one `barista-events-dropped` warning once forwarding resumes, while permission events and lifecycle messages are always queued. A permission callback waits only for a decision on a request that was actually forwarded to the hub, and only for the run and approval that raised it. Structured events and permission forwarding are enabled because Barista registers version 4; a build registering an older version refuses every permission request. Both are wired only after the dispatch guard accepts the execution, so a rejected dispatch never starts a harness.

ACP runs only between Barista and a locally installed harness adapter. Barista translates ACP updates into the normalized `harness.event` vocabulary; ACP frames and schema names never reach the hub, and MCP remains the model-facing tool protocol.

The TypeScript source of truth is `packages/protocol/src/index.ts`; Go wire structs are deliberately isolated in `apps/control-agent/internal/protocol`. Changes to the wire contract must update both and should retain compatibility across rolling deployments.

`/worker` remains accepted by the hub as a temporary compatibility endpoint for older Node workers, but new agents use `/control-agent`.

## Workspace leases

`internal/workspace` provisions hub-granted leases; it owns canonicalization, Git inventory parsing, and cleanup decisions. Barista advertises `workspace-lease:git-worktree` (when a `git` executable is resolvable) and `workspace-lease:exclusive-existing` as runtime capability evidence. Leases use POSIX paths, so a Windows Barista advertises neither policy.

Git is always invoked directly as one resolved executable with separate arguments — never through a shell — with repository hooks and filesystem monitors disabled, inherited `GIT_*` variables removed, a two-minute timeout, and a 1 MiB output bound. Git output never appears in diagnostics.

Before any mutation Barista verifies that the grant's root is exactly one of its canonical `WORKSPACE_ROOTS`; that the source checkout is beneath it, contains no symbolic link, and is the top level of a non-bare repository whose common directory is its own `.git`; that one of its remotes has the lease's repository identity (userinfo removed by splitting at the last `@` before the host, for both `scheme://` and scp-style `user@host:path` remotes, and a trailing `.git` ignored; a remote with no credential-free identity never matches); that the branch is `coffee-shop/<taskId>/<runId>` for the dispatched task and run; that the worktree path is `<root>/.coffee-shop/worktrees/<leaseId>`, each managed directory being a real directory rather than a link; and that the base ref resolves to exactly one commit, equal to the lease's recorded base when the hub already has one. It then creates the managed directories component by component with mode 0700, refusing any symbolic link or non-directory at every level, creates the worktree directory itself with an exclusive `Mkdir` (so anything already at the path fails the lease), records the lease identity and base commit in the repository's configuration (`branch.<branch>.coffeeShopLease` and `coffeeShopBase`), re-verifies the directory chain, and runs `git worktree add -b <branch> -- <path> <base>` into that directory. Afterwards it re-verifies that the worktree's directory chain is still real directories inside the root, that its canonical path is exactly the lease path, that its `.git` is a regular file pointing at an administrative directory of the source repository which points back at it, and that `git worktree list --porcelain -z` lists it exactly; any mismatch retains the lease as `identity-mismatch` or `ambiguous`. If the checkout fails, Barista withdraws the identity it recorded and removes only the empty directory it created; it never deletes anything outside the root, and never a branch it cannot prove it created. `git worktree list --porcelain -z` is the authoritative inventory: an exact existing worktree — registered at the path, on the lease branch and nowhere else, not locked or prunable, recorded for this lease, and descending from its recorded base — is adopted, so a replayed dispatch or a reconnect provisions exactly once. Anything else at the path or branch is retained, never reset, reused, or deleted. Provisioning runs to completion even if the run is cancelled meanwhile, then converges by re-reading Git state; a failed mutation leaves `failed` only when nothing of the lease remains. The harness starts only after Barista has verified the exact `active` lease and the hub has answered with `workspace.lease.confirmed` for that exact run and lease, which the hub sends only after persisting the transition. A report that was merely sent or queued never counts: if no confirmation arrives within one minute Barista fails the run with `workspace lease was not confirmed by the hub` and settles the lease locally, and a cancellation while waiting settles it without starting anything. A replayed dispatch of an already-active lease re-reports `active` so the hub can confirm it again.

When a leased run ends, Barista releases the lease and, when the profile's cleanup policy is `when-unchanged`, removes the workspace only if every identity check still passes, `git status --ignored=matching --untracked-files=all` shows no modified, staged, untracked, or ignored files — an ignored file such as a harness-written `secrets.env` is never deleted — and the branch still points at its base commit. Removal is `git worktree remove` without `--force`, then a compare-and-delete of the branch at its base commit, then the recorded identity. Anything else is retained with a reason: `dirty`, `untracked` (including ignored files), `diverged`, `locked`, `unregistered` (a directory at the path that Git does not list), `identity-mismatch`, `ambiguous` (for example a prunable or detached worktree), or `policy` under the `retain` policy. A cleaned or never-provisioned lease leaves a tombstone under `<root>/.coffee-shop/tombstones/`, so a replayed grant cannot recreate it. Nothing is ever committed, pushed, force-removed, or reset. Operations for one repository are serialized. A git-worktree lease is owned for the whole life of its run, through its settlement, by a non-blocking exclusive `flock` on `<root>/.coffee-shop/leases/<leaseId>.lock` (created beneath 0700 directories, never through a link); provisioning and every cleanup or reconcile request take that lock first, so even another Barista process started under the same node can never provision or remove a worktree a live run still uses. A request for a lease locked elsewhere is skipped without a report, leaving the lease as the hub last recorded it. Exclusive-existing leases are owned only within one Barista process; the hub's one-lease-per-path rule and its one-connection-per-node rule keep them exclusive.

Residual risk: these checks are made by path, and a process running as the same account as Barista with write access to the root can still replace a verified directory between Barista's last check and Git's own writes. Barista narrows that window, confines what it creates to 0700 directories, and re-verifies the result before trusting or removing it, but it cannot make Git's pathname-based operations atomic; do not grant other same-account processes write access to `<root>/.coffee-shop`.

Operator recovery for a retained lease: inspect the worktree at `<root>/.coffee-shop/worktrees/<leaseId>` (its branch is `coffee-shop/<taskId>/<runId>`). Keep the work by merging or pushing the branch yourself, or discard it by running `git worktree remove --force <path>` and `git branch -D <branch>` from the source checkout. Then request cleanup through `POST /api/workspace-leases/:id/cleanup`: Barista removes what is provably unchanged, and records the lease as `cleaned` once nothing of it remains. Barista never deletes a branch or worktree it did not create for that lease.

## Harness drivers

`internal/harness` selects a driver from the run's transport. `native-cli` (the default) runs the Claude or Codex CLI directly. `acp-v1` runs the generic ACP driver, which is available only for a harness with both a verified adapter (see [ACP adapters](#acp-adapters)) and a compiled-in provider policy: an absolute path to an executable file, re-verified before every launch and started without a shell or `PATH` lookup. A missing, changed, or non-executable adapter reports the driver as unavailable; Barista substitutes the native CLI only as the explicit, recorded fallback described below.

The ACP driver starts one adapter process and one session per run, in its own process group, with `COFFEE_SHOP_TOKEN` and `COFFEE_SHOP_MCP_TOKEN` removed from the inherited environment. The client in `internal/acp` implements the ACP v1 subset Barista needs using only the standard library:

- newline-delimited UTF-8 JSON-RPC 2.0 on stdio; any stdout line that is not one JSON-RPC object, a frame larger than 4 MiB, or output ending mid-frame fails the run and terminates the adapter;
- connection-scoped integer request IDs that are never reused, at most 32 pending client requests, 16 concurrent agent requests, and a 64-frame outbound queue; an unknown or duplicated response ID fails the session rather than guessing a correlation;
- `initialize` offering protocol version 1 with no file-system or terminal capabilities; any other selected version is an incompatibility, as is an adapter reporting a version other than its manifest pin, and an adapter that requires authentication is reported rather than authenticated;
- `session/new` with the canonical workspace path and, only when the adapter advertises HTTP MCP support, the run-scoped `coffee_shop_hub` server. A dispatch that asks to resume a session instead sends `session/resume` (or `session/load`, whose replayed history is discarded, when only that was negotiated) with the same workspace and MCP server; when the adapter negotiated neither or refuses with a JSON-RPC error, Barista emits an `acp-session-not-resumed` warning and creates a new session, which receives the run prompt with its durable context, while a transport failure or an authentication refusal fails the run before any prompt. A resumed session receives the dispatch's delivery-only `resumePrompt`. The bearer header crosses local stdin only; it is never placed in arguments or the environment and is redacted from every event, result, and error;
- the provider policy's session configuration, applied with `session/set_config_option` only to values the adapter offers in `configOptions` and confirmed before the prompt. An unavailable policy option (such as the sandbox preset) is a missing capability; an unavailable requested value (such as a model) is a rejected request. When the provider policy requires it, the prompt also waits, for at most 30 seconds, until the adapter has listed the run's Coffee Shop MCP tools through the loopback bridge;
- `session/prompt` with streamed `session/update` notifications normalized into `harness.event` values. Unknown update variants and notifications become bounded `unknown` diagnostics; a malformed known variant fails the run; updates after the prompt response are ignored with a single warning;
- `session/request_permission` resolved through a supplied callback. Absent, failed, timed-out, or invalid decisions never allow: Barista answers with the adapter's `reject_once` option when offered and `cancelled` otherwise. Malformed option lists are cancelled;
- cancellation sends `session/cancel`, waits a bounded grace period for the prompt to end, and then kills the process tree with the same platform helpers as the native driver. `session/close` is sent after a successful turn when advertised.

Adapter stderr is retained only as a bounded, redacted tail attached to failures. Tests exercise the client against a deterministic fake adapter (`internal/acp/acptest`) that the test binary re-executes over real pipes; its `codex-*` and `claude-*` scenarios reproduce codex-acp's and claude-agent-acp's configuration options and agent identity and connect to the real MCP bridge. The end-to-end system suite (`task system:test`, `internal/systemtest`) goes further: it installs `internal/systemtest/fakeharness` as the pinned `--acp-adapter` for both harnesses and as the native `codex` and `claude` CLIs, and runs real Barista processes against a real hub (see [Operations runbook](operations.md#verifying-a-release)).

### ACP adapters

Barista launches only adapters it has verified, and never runs `npx`, downloads, or installs anything at runtime:

- **Setup-installed.** An adapter installed by `barista setup apply` is loaded from `--data-root` when the ownership ledger records it for exactly the manifest adapter ID and version at the manifest's target path, every directory from the data root to it is a real directory, and its SHA-256 still matches the ledger. A drifted or ambiguous install is skipped with a logged reason and the harness keeps its native transport.
- **Administrator override.** `--acp-adapter codex-cli=sha256:<digest>:/opt/codex-acp/bin/codex-acp` names an executable pinned by digest. It replaces the setup-installed adapter for that harness, must be a regular executable file (not a symlink), and must match its digest, or Barista refuses to start.

Either kind is re-verified before every launch. At startup Barista runs each loaded adapter's `initialize` handshake, requiring protocol version 1, the manifest's pinned version, and HTTP MCP support. A harness whose adapter passes advertises `acp-v1` in its `transports` together with the capabilities that handshake negotiated (`acp`), so the hub sees what the installed build actually supports rather than what a manifest claims. It advertises `native-cli` only when its native CLI passed discovery. When the provider policy names a model option, the probe also opens a throwaway session (in an empty temporary directory, without MCP servers or a prompt, closed afterwards) to read the models the adapter offers; at most 32 well-formed, non-secret-like identifiers are merged into the harness's `models` after the native list, with `default` kept, so a node with only the adapter can still accept agents that name a concrete model. An adapter that cannot open that session, for example before Codex is signed in, is still advertised with only `default`. An adapter that fails the probe is disabled until restart and its reason is logged, withheld when it looks secret-like.

### Transport selection and native fallback

The hub prefers `acp-v1` for a task attempt whose harness advertises it and whose requirements allow it; otherwise it dispatches `native-cli`. When the attempt's requirements also allow `native-cli` and the harness advertises it, the dispatch carries `execution.fallbackTransport: "native-cli"`.

Barista falls back from ACP to the native CLI only when the dispatch carries that permission, the operator listed the harness in `--acp-native-fallback`, the native CLI passed discovery, and ACP failed before the prompt was sent for one of these reasons:

| Reason | Condition |
|---|---|
| `acp-adapter-unavailable` | No verified adapter at dispatch time, or it could not be started |
| `acp-protocol-incompatible` | Protocol or pinned-version mismatch, protocol violation, or adapter exit before the prompt |
| `acp-capability-missing` | No HTTP MCP support, or a required policy option is not offered or not applied |
| `acp-mcp-unavailable` | The adapter did not list the run's Coffee Shop MCP tools before the prompt |

Missing provider authentication, a rejected model or configuration request, cancellation, and every failure after the prompt was sent fail the run instead: the attempt is never replayed through another transport, and a task retry is a new attempt that selects its transport anew. A fallback emits a `transport-native-fallback` warning event and is reported in `run.started`'s transport selection with its reason; the hub records it on the run and adds a timeline event. The native fallback keeps the native CLI's `workspace-write` sandbox and required Coffee Shop MCP server.

### Codex over ACP

The manifest pins `codex-acp` (`@agentclientprotocol/codex-acp`) 1.12.0. The project publishes no standalone release artifact, so install a single-file executable built from the tagged source with `npm run bundle:all` using `barista setup plan` and `barista setup apply --manual-artifact codex-acp=<file> --manual-checksum codex-acp=<digest>`, or pin one with `--acp-adapter`. A global npm install is a script that loads unpinned `node_modules` and is not supported. `barista doctor` reports whether the adapter is installed and ready.

Barista's compiled-in Codex policy, not the manifest, controls how a run maps onto the adapter:

- the canonical workspace is the session `cwd`, and the run's composed prompt is sent as one text block;
- under the default `manual` [approval policy](#approval-policy), the session `mode` is set to codex-acp's `read-only` preset ("Ask for approval"), which runs Codex with the same `workspace-write` sandbox without network access as the native `--sandbox workspace-write`, and routes every escalation to Barista as an ACP permission request, which becomes a Coffee Shop approval. The adapter's "Approve for me" (`agent`) preset, which lets Codex's own reviewer approve escalations, is used only under the administrator's `auto` policy, and "Full access" (`agent-full-access`) only under `bypass`. The mode is also requested through `INITIAL_AGENT_MODE`, but it is always confirmed through session configuration before the prompt, and a mode the adapter does not offer or apply fails the run rather than running under another;
- the `default` model keeps Codex's own configured model, exactly like the native CLI without `--model`; any other model must be offered and applied by the adapter or the run fails;
- the Coffee Shop MCP server is offered as an HTTP server with the run-scoped bearer header on stdin, and the prompt waits until codex-acp has listed its tools. Unlike the native CLI, Coffee Shop tool calls are not pre-approved; Codex may ask for approval, which goes through the hub;
- the adapter is given the discovered native Codex CLI as `CODEX_PATH`, so it never resolves Codex through `PATH`.

Codex keeps its own authentication: ChatGPT login state in Codex's storage or an API key the operator already exports to Barista's environment. Barista never sets, reads, or forwards a provider credential, and the hub never receives one. An adapter that reports that authentication is required fails the run with that reason; sign in to Codex on the compute node and retry.

### Claude over ACP

**Experimental.** Unlike Codex over ACP, Claude ACP does not load merely because a verified adapter is installed: it also requires an explicit `--claude-acp-auth-mode` (or `BARISTA_CLAUDE_ACP_AUTH_MODE`) of `local-subscription` or `api`, checked once when Barista loads its adapters. Leaving it unset — the default — keeps Claude ACP unavailable regardless of what is installed; `barista doctor` and the daemon log both name the reason. In `local-subscription` mode, Barista also refuses to load the adapter if its own launch environment carries any of claude-agent-acp's own provider-routing variables (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `ANTHROPIC_BASE_URL`, and the rest of `harness.ClaudeACPBillingSwitchingVariables` in `internal/harness/claude_acp.go`, sourced from the adapter's own compiled `PROVIDER_ROUTING_ENV_VARS`) — any one of them present would silently move a subscription node onto API or cloud billing. `api` mode is an explicit administrator acknowledgement that this node's Claude ACP is intentionally API/cloud-billed; it skips that screen and reports the harness `authMode` as `api` instead of `local-subscription` once the adapter has actually advertised `acp-v1`. See `docs/anthropic-usage.md` for the full experimental/subscription-safety boundary.

The manifest pins `claude-acp` (`@agentclientprotocol/claude-agent-acp`) 0.79.0, the official ACP agent built on the Claude Agent SDK. Like codex-acp, it publishes no standalone signed release artifact, so package its `claude-agent-acp` CLI entry point and install it with `barista setup apply --manual-artifact claude-acp=<file> --manual-checksum claude-acp=<digest>`, or pin one with `--acp-adapter`. `barista doctor` reports whether the adapter is installed and ready.

Barista's compiled-in Claude policy, not the manifest, controls how a run maps onto the adapter, and under the default `manual` approval policy it never widens the native CLI's safety posture:

- the canonical workspace is the session `cwd`, and the run's composed prompt is sent as one text block;
- under the default `manual` [approval policy](#approval-policy), the session `mode` is set to `default`, claude-agent-acp's wire ID for its "Manual" permission preset: every tool call is sent to Barista as an ACP permission request rather than auto-approved. This is the same fail-closed posture as the native CLI's `--permission-mode auto` with unanswered prompts denied. Barista selects `auto` only under the administrator's `auto` policy and `bypassPermissions` only under `bypass`, and never selects `acceptEdits` or `plan`. The mode is confirmed through session configuration before the prompt is sent, so neither the adapter's own default nor an inherited operator environment can change it; claude-agent-acp offers `bypassPermissions` only conditionally, and when it is not offered a `bypass` run fails rather than running under another mode;
- the `default` model keeps Claude's own configured model, exactly like the native CLI without `--model`; any other model must be offered and applied by the adapter or the run fails;
- the Coffee Shop MCP server is offered as an HTTP server with the run-scoped bearer header on stdin, and the prompt waits until the adapter has listed its tools. Unlike the native CLI, Coffee Shop tool calls are not pre-approved; Claude may ask for approval, which goes through the hub;
- the adapter is given the discovered native `claude` CLI as `CLAUDE_CODE_EXECUTABLE`, so it never resolves Claude through `PATH`.

Claude keeps its own authentication: the CLI's locally owned subscription login (or, for an operator who has instead configured API billing outside Coffee Shop, whatever credential that CLI install already resolves on its own). Barista never sets, reads, exports, or forwards a provider credential for either transport, never copies OAuth or session state between accounts or nodes, and never switches a subscription-authenticated node onto API billing to make ACP work — an adapter that reports authentication is required fails the run with that reason instead of falling back, so a fallback can never silently run under a different credential or billing mode than the one the operator configured for that node. Sign in to Claude on the compute node and retry. See `docs/anthropic-usage.md` for the subscription usage boundary this preserves, and re-check current Anthropic terms before broadening deployment.

### Approval policy

`--approval-policy` (or the comma-separated `BARISTA_APPROVAL_POLICY`) is the node administrator's choice of how each harness's permission requests are decided. It is either node-wide (`--approval-policy auto`) or per harness (`--approval-policy claude-cli=bypass`, repeatable); a per-harness value overrides the node-wide one regardless of order, and two different values for the same scope stop startup. Only `claude-cli` and `codex-cli` accept a policy. The default is `manual`:

| Policy | Claude ACP `mode` | Codex ACP `mode` (and `INITIAL_AGENT_MODE`) | Native Claude CLI | Native Codex CLI |
|---|---|---|---|---|
| `manual` | `default` | `read-only` | `--permission-mode auto --permission-prompts none` | `exec --sandbox workspace-write` |
| `auto` | `auto` | `agent` | unchanged | unchanged |
| `bypass` | `bypassPermissions` | `agent-full-access` | `--permission-mode bypassPermissions --permission-prompts none` | `exec --dangerously-bypass-approvals-and-sandbox` |

The native CLIs never prompt, so `auto` leaves them unchanged. Each ACP mode stays a compiled-in policy selection: it must be offered and confirmed by the adapter before the prompt, and a mode that is not is a missing capability that fails the run (or, only when fallback is permitted, runs the native CLI under the same policy), never a silent switch to another mode. The Claude auth-mode gate is independent of the approval policy. The policy is read only from Barista's own configuration: the Runner applies it to every run of the harness, and nothing in a dispatch, task, run, or other hub message can set or change it. Barista advertises a non-`manual` policy as `approvalPolicy` on the harness inventory entry and on each run's `run.started` transport selection, logs `approval policy for <harness> is <policy>: ...` at startup, and `barista doctor` prints the effective policy for each harness. An absent `approvalPolicy` means `manual`, so older Baristas and hubs stay correct.

## Credentials and enrollment

`COFFEE_SHOP_TOKEN` authenticates the WebSocket through an `Authorization: Bearer` header. Do not pass durable secrets with `--token` in production because process listings and shell history may expose them.

The token authenticates a Barista to the current single-user control plane; it is not a vendor credential. Claude and Codex authentication stays on the compute node in the vendors' own CLI storage.

## Service installation

Copy the binary to a stable location and run it under the platform service manager with a dedicated environment file. The service account must be able to read/write the enrolled workspaces and access the locally authenticated CLI state. It should not have broader filesystem permissions than the agents need.

Barista logs discovery, connection state, enrolled roots, and failures to stdout/stderr so systemd, launchd, or the Windows Service wrapper can collect them.

## Project capability evidence

Barista reports what the node actually has as bounded capability evidence tagged with a provenance source. `runtime` facts (operating system, architecture, logical CPU count, workspace-root writability) and `probe` results (toolchain versions) come from direct observation; `configured` declarations (labels, accelerators, toolchains, memory) are the node administrator's word. Every entry carries bounded diagnostics so a failed observation is explainable without leaking process output.

The allowlisted probes are fixed at compile time in `apps/control-agent/internal/readiness`: a known set of `{binary, args}` pairs for Go, Git, Node, pnpm, GCC, Clang, and Xcode, plus a generic "first reported version" parser. Barista never accepts a command, executable name, or argument list from the hub, a task, or any network message, so a compromise of the control plane cannot turn a version check into arbitrary execution. `--project`, `--label`, `--accelerator`, `--toolchain`, and `--memory-megabytes` (and their `BARISTA_*` environment equivalents) are node-admin declarations, never trusted as proof.

`--toolchain <id>[@<version>]` (or an entry in the comma-separated `BARISTA_TOOLCHAINS`) declares a toolchain that is not covered by the probes — for example `--toolchain 'rust@1.80'` or `--toolchain zig`. It is reported as `configured` evidence with capability id `toolchain:<id>` and, when a version was given, that version as its normalized value; a toolchain declared without a version is reported as present but unversioned. A project profile toolchain requirement names `toolchain:<id>` as its `capabilityId` to match it, while probed toolchains keep their bare ids such as `go`.

Validation for labels, accelerators, and toolchains:

- ids are lowercase kebab-case (letters, numbers, hyphens) of at most 64 bytes; versions are normalized dotted numbers such as `1.80` or `22.9.0`, and an `@` with nothing after it is malformed;
- two entries for the same toolchain id with different versions — including one with a version and one without — are a conflict and stop startup;
- an empty entry is an error, whether it comes from an empty flag value or an empty comma segment in `BARISTA_LABELS`, `BARISTA_ACCELERATORS`, or `BARISTA_TOOLCHAINS` (for example `a,,b` or a trailing `a,`); a wholly empty or unset variable still means "none";
- at most 32 labels, 32 accelerators, and 32 toolchains may be configured (exact duplicates are collapsed first);
- secret-looking values are rejected, and no rejection error ever echoes the rejected value — it names the field and its index instead, since configuration errors are commonly logged.

Environment lists are comma-separated, so a value can never contain a comma; prefer repeated flags when in doubt, and single-quote values in shells, for example `--toolchain 'rust@1.80'`.

All of this inventory — labels, accelerators, toolchains, and configured memory — is worker-reported and never attested: the hub treats it as the node administrator's claim.

The hub evaluates readiness by combining this evidence with a hub-loaded project profile; Barista does not decide whether it is ready for any project itself. A node administrator can additionally restrict the node to specific project IDs through the project allowlist, which the hub enforces independently of any profile's requirements.

## Reviewing reported policy

The web app’s **Settings → Execution policy → Review** view is read-only. It classifies node and harness inventory as worker-reported, connection/freshness as hub-observed, and workspace/harness behavior as documentation for the Barista release built alongside the UI. Task builds stamp Barista with the Coffee Shop release plus Git description. Use `task container:build` to stamp the container UI with that exact same version; direct Docker/Compose builds default to `dev` and deliberately withhold release qualification unless `BARISTA_VERSION` is supplied. A matching clean release is still not runtime attestation. Development, dirty, older, custom, unavailable, protocol-only, or unknown harness/auth values remain explicitly unverified.

For this release, Claude is documented with `--permission-mode auto` and `--permission-prompts none`; Codex is documented with `--sandbox workspace-write`. The actual invocation remains owned by the Barista binary on the compute machine.

## Node setup and readiness doctor

`barista setup plan` renders the exact operations one apply would perform as a digest-sealed JSON plan. It is read-only: it observes current filesystem state, writes nothing under the data root, and creates no ledger. `barista setup apply` requires the operator's local invocation with a `--plan` file whose digest and manifest digest still match — a hand-edited plan, a changed manifest, or a target that changed state since planning is refused before any mutation. Apply is also the only command that creates the data root, because it stages every download and extraction under that prefix. `barista doctor` is entirely read-only: it re-verifies installed adapters against the ownership ledger (a ledger record whose file no longer matches is reported as not installed, never trusted over reality), runs the manifest's coarse exit-code auth probes, and makes one bounded, unauthenticated TCP connection attempt to the control endpoint. Doctor exits 0 whenever it could build a report; the report itself is where problems show up.

The managed component manifest lives at `apps/control-agent/internal/setup/manifest/components.json` and is compiled into the binary. It is version-controlled and non-secret, and `internal/setup` owns the one component manifest, plan, and ownership schema every installer, doctor, and discovery consumer uses: a component is identified everywhere by the same `{kind, id, version}` triple, where `kind` is the closed vocabulary `harness` or `acp-adapter`. The previous adapter-only manifest and ownership-ledger generations still load and migrate deterministically to `acp-adapter` (see [operations](operations.md)); an unknown or mixed generation is rejected before planning. Four entries ship: the ACP adapters `claude-acp` and `codex-acp`, and the provider harnesses `claude-cli` (`@anthropic-ai/claude-code` 2.1.231) and `codex-cli` (`@openai/codex` 0.147.0). `codex-cli` uses `archive` distribution on all four platforms — OpenAI publishes per-platform release archives with an obtainable SHA-256 and exact byte size, so the manifest pins them and Barista downloads and verifies the bytes itself; because the download redirects to `release-assets.githubusercontent.com`, that apply needs `--allowed-host github.com --allowed-host release-assets.githubusercontent.com`, since an empty redirect allowlist fails closed. The other three entries use manual distribution — the operator places and checksums the artifact themselves via `setup apply --manual-artifact`/`--manual-checksum` — because their vendors publish no artifact with a reviewable digest and exact size. The decision procedure, the source consulted and retrieval date behind each pin, the full pinned values, and the exact packaging commands per platform are recorded in `apps/control-agent/internal/setup/manifest/README.md`. Barista supports exactly the platform keys `darwin-amd64`, `darwin-arm64`, `linux-amd64`, and `linux-arm64`; any other platform, Windows included, is unsupported by omission of the platform key and gets no fallback installation. Barista-owned files live under the data root (`--data-root`, defaulting to the OS per-user configuration directory plus `coffee-shop/barista`, never `$HOME` itself), recorded in an ownership ledger so rollback only ever deletes files this tool verifiably created.

Managing a provider harness is optional and follows the same plan/apply/activate/rollback flow an adapter does (`barista setup activate --component harness/claude-cli --version <version>`); see [operations](operations.md#installing-and-activating-managed-harnesses) for the full walkthrough. Two rules are specific to it. A harness entry's `launch` template must be empty, because native execution builds its own arguments and environment in `internal/harness/runner.go` and reads no manifest template — accepting arguments there would be a promise the daemon does not keep, so the manifest is rejected rather than the field silently ignored. And activation refuses any candidate whose own `--version` output does not report exactly the pinned version: a managed version Barista cannot confirm is never selected, while an *external* PATH binary that reports no parsable version stays accepted, because a harness an operator installed before managed components existed must keep working. A failed activation keeps the prior version active and changes no file; a selection whose bytes later drift falls back to the external PATH installation with the demotion reported, never silently.

No workflow here writes provider credentials or edits global harness configuration. Apply prints a display-only `ACP_ADAPTER_<HARNESS_ID>` snippet for each verified adapter; nothing needs to be copied from it, because the daemon loads every setup-installed adapter the ownership ledger still verifies from `--data-root` at startup (see [ACP adapters](#acp-adapters)). Restart Barista after `setup apply` so the new adapter is probed and advertised. For macOS, Linux, and Windows there is no OS-specific behavior difference in this release beyond how the default data root resolves through `os.UserConfigDir()`. Xcode or compiler toolchain gaps that doctor's existing `internal/readiness` probes report are informational only: installing them is always a manual operator step, never automated by this tool.
