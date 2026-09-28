# Claude Code subscription usage

This note is architectural guidance, not legal advice. It records the conservative boundary used by this project as of September 11, 2026.

## Why this design can use a Claude subscription

Anthropic documents all of the pieces Coffee Shop uses:

- Claude Pro and Max include Claude Code terminal access when the CLI is authenticated with the Claude account.
- `claude -p` is the documented non-interactive interface and supports JSON/streaming output for programmatic use.
- Recent CLI versions support `--permission-mode auto` and `--permission-prompts none` for unattended work without blanket permission bypass.

Coffee Shop therefore starts the installed, official CLI as a child process on the subscriber's own compute machine. It does not imitate Anthropic's private network calls, extract OAuth credentials, use a Claude subscription token against the API, or set an API key.

## Barista may install the CLI, but never its credential

Barista can optionally manage the Claude Code CLI itself as a `harness` component (`claude-cli`, pinned to `@anthropic-ai/claude-code` 2.1.231; see `docs/operations.md#installing-and-activating-managed-harnesses`). That changes nothing about the boundary this document describes, and it deliberately changes nothing about authentication. Note that unlike Codex, Claude Code is pinned as a **manual** distribution precisely because Anthropic grants no redistribution and publishes no standalone checksummed artifact: Barista downloads nothing from Anthropic and re-hosts nothing.

- **Only the software moves, never the account.** A node administrator packages the vendor's own per-platform executable, asserts its SHA-256, and Barista installs and activates exactly those bytes under its own data root. It downloads nothing from Anthropic, runs no installer or bootstrap script, and re-hosts and re-distributes nothing — the operator obtains the artifact from Anthropic themselves under Anthropic's own terms.
- **Authentication stays a separate, later, human action.** After installing, the operator runs `claude` once on that compute node and signs in. The login lives in Claude Code's own locally owned credential storage, exactly as it does for a hand-installed CLI. Barista never creates, reads, copies, exports, migrates, or forwards it, does not carry it across a version bump or a rollback, and never substitutes an API key to approximate a subscription. The hub never receives it.
- **Installing proves nothing about authentication.** `barista doctor` reports installation and activation separately from a coarse `authReadiness` derived only from an exit code, where `unknown` means "absent or timed out" and never "not authenticated". No scheduling path claims a node is runnable on the strength of an install alone.
- **The version a node runs is the version its records claim.** Activation refuses a managed candidate whose own `--version` output does not report the pinned version, so this document's "official CLI, known version" assumption is enforced rather than assumed. Raw `--version` output is never logged or reported, because process output can carry credentials.
- **Activation does not move a live process or its login.** A running Barista keeps the Claude executable and sanitized component report it verified at startup, even if another local setup process selects a new version. Finish work and restart Barista to adopt it. Rollback and the next restart return to the one retained verified executable; neither operation copies, converts, or uploads Claude's vendor-owned authentication state.

## The ACP adapter is experimental, and is an alternate transport for the same local CLI, not a new account

Barista can also drive Claude through `claude-agent-acp`, the official Agent Client Protocol adapter built on the Claude Agent SDK (see `docs/control-agent.md#claude-over-acp`). **This transport is experimental.** Treat it as API-mode-capable infrastructure rather than a proven subscription-equivalent path, and keep native `claude -p` as the recommended default until you have re-verified the current boundary below for your own deployment.

- **Authentication never moves, and billing mode is administrator-declared, never inferred.** The adapter authenticates through the same locally owned CLI credential storage the native path already uses. Barista never sets, reads, exports, or forwards a credential to or from the adapter, never copies OAuth or session state, and never provisions or accepts a credential through the hub or PWA. Barista also does not attempt to determine, from process success or output, whether a node is on subscription or API billing: the operator must set `--claude-acp-auth-mode` (or `BARISTA_CLAUDE_ACP_AUTH_MODE`) to exactly `local-subscription` or `api` before Barista will load the adapter at all; leaving it unset keeps Claude ACP unavailable (`barista doctor` and the daemon log both show why). In `local-subscription` mode Barista additionally refuses to launch the adapter if its own environment carries `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `ANTHROPIC_BASE_URL`, or any of the adapter's other own provider-routing variables (the full, single-sourced list is `harness.ClaudeACPBillingSwitchingVariables` in `apps/control-agent/internal/harness/claude_acp.go`) — one of those present would silently move a subscription session onto API or cloud billing. `api` mode is an explicit administrator acknowledgement that the node is intentionally API/cloud-billed, and is reported as such (`authMode: "api"`) rather than folded into the subscription classification. An adapter that reports authentication is required fails the run with that reason; Barista does not fall back to a possibly-differently-authenticated native run to paper over it, so a fallback can never quietly cross a billing boundary.
- **Permissions do not loosen unless the node administrator says so.** Under the default `manual` approval policy the adapter session is forced into its `default` ("Manual") permission preset before every prompt — the same fail-closed behavior as the native CLI's `--permission-mode auto` with unanswered prompts denied — and every tool call is routed to Coffee Shop as an approval. `auto` and `bypassPermissions` are selected only when that node's administrator sets `--approval-policy` to `auto` or `bypass` in Barista's own configuration (see `docs/operations.md#approval-policy`); the hub cannot select them, and `acceptEdits` is never selected.
- **Native remains the default and the recommended path.** ACP is opt-in per node/adapter installation (see `barista setup`) and per the auth-mode flag above, reported and advertised separately from the native transport, and native execution is unaffected and unremoved when ACP is unavailable, unauthenticated, or not installed.
- **The credential boundary is tested end to end.** The system suite (`task system:test`) starts real Barista processes with fake provider tokens (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, and others) in their environment, confirms the adapters inherit them locally and never receive the Coffee Shop enrollment token, and fails if any of them appears in the hub's persisted state, snapshots, run events, approvals, leases, or logs. The suite uses fake adapters, so it proves Coffee Shop's handling of credentials, not any provider's.
- **Adapter provenance is not a subscription-equivalence proof.** A verified, correctly-versioned adapter proves Barista is driving the intended local software, not that Anthropic's terms treat ACP-mediated automation identically to interactive CLI use. Treat ACP as the same conservative single-account, own-compute-node use case described below, re-verify against current Anthropic documentation before relying on it, and prefer the native CLI path when in doubt.

### Deployment boundary by scale

| Scale | Guidance |
|---|---|
| Private, single-owner subscription use | The conservative use case below (native or `local-subscription` ACP), on the owner's own compute node(s), is what this document documents evidence for. |
| Team or commercial deployment | Use a Claude Team/Enterprise offering that includes Claude Code, or obtain written confirmation from Anthropic; do not extend a personal-subscription `local-subscription` ACP or native configuration to serve other users. |
| Claude ACP adapter specifically | Experimental regardless of scale: re-verify `claude-agent-acp`'s current behavior, version, and Anthropic's current terms before broadening its use beyond what you have personally validated. |
| Native fallback | Always available as the non-experimental, longer-documented path; prefer it when ACP's status for your deployment is uncertain. |

## The important limitation

Anthropic's Consumer Terms prohibit automated/non-human access except through an API key **or where Anthropic otherwise explicitly permits it**. The official Claude Code CLI documentation explicitly documents scripting and programmatic print mode, which is the permission this project relies on. The same terms also prohibit credential/account sharing, resale/competitive services, scraping, and bypassing protective measures.

The conservative use case is therefore:

- one account owner;
- their own private compute nodes;
- official CLI authentication on each compute node;
- normal plan rate limits;
- no downstream users consuming the account;
- no credential extraction or forwarding;
- no rate-limit evasion.

For a shared company deployment, use a Claude Team/Enterprise offering that includes Claude Code or obtain written confirmation from Anthropic. For a public product or service, use the Anthropic API, Bedrock, Vertex AI, or another provider's commercial interface even though that introduces usage-based cost.

## Supported alternatives

1. **Private Claude Code through Barista (implemented):** subscription limits, official CLI, best fit for personal use.
2. **Claude Code routines API:** subscription-billed and designed to be triggered programmatically, but applies to saved cloud routines rather than arbitrary local interactive chats.
3. **Anthropic API / Agent SDK:** clear commercial integration path and metered usage.
4. **Bedrock or Vertex AI:** commercial cloud billing, IAM, and organizational controls.
5. **Local/open-weight models:** no Anthropic cost; add an Ollama, llama.cpp, or OpenCode harness adapter.

Re-read the current [Anthropic Consumer Terms](https://www.anthropic.com/legal/consumer-terms), [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference), and [Pro/Max Claude Code guidance](https://support.anthropic.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan) before expanding the deployment boundary.
