# Claude Code subscription usage

This note is architectural guidance, not legal advice. It records the conservative boundary used by this project as of September 11, 2026.

## Why this design can use a Claude subscription

Anthropic documents all of the pieces Coffee Shop uses:

- Claude Pro and Max include Claude Code terminal access when the CLI is authenticated with the Claude account.
- `claude -p` is the documented non-interactive interface and supports JSON/streaming output for programmatic use.
- Recent CLI versions support `--permission-mode auto` and `--permission-prompts none` for unattended work without blanket permission bypass.

Coffee Shop therefore starts the installed, official CLI as a child process on the subscriber's own compute machine. It does not imitate Anthropic's private network calls, extract OAuth credentials, use a Claude subscription token against the API, or set an API key.

## The ACP adapter is an alternate transport for the same local CLI, not a new account

Barista can also drive Claude through `claude-agent-acp`, the official Agent Client Protocol adapter built on the Claude Agent SDK (see `docs/control-agent.md#claude-over-acp`). This is a transport change only:

- **Authentication never moves.** The adapter authenticates through the same locally owned CLI credential storage the native path already uses (or, if an operator has independently configured that node for API billing outside Coffee Shop, whatever credential that install already resolves). Barista never sets, reads, exports, or forwards a credential to or from the adapter, never copies OAuth or session state, and never provisions or accepts a credential through the hub or PWA on the operator's behalf.
- **Billing mode is never inferred or switched.** Barista does not attempt to determine, from process success or output, whether a node is on a subscription or API billing, and never changes that classification to make an adapter run. An adapter that reports authentication is required fails the run with that reason; Barista does not fall back to a possibly-differently-authenticated native run to paper over it, so a fallback can never quietly cross a billing boundary.
- **Permissions do not loosen.** The adapter session is forced into its `default` ("Manual") permission preset before every prompt — the same fail-closed behavior as the native CLI's `--permission-mode auto` with unanswered prompts denied — and every tool call is routed to Coffee Shop as an approval. `acceptEdits`, `auto`, and `bypassPermissions` are never selected.
- **Native remains the default and the recommended path.** ACP is opt-in per node/adapter installation (see `barista setup`), reported and advertised separately from the native transport, and native execution is unaffected and unremoved when ACP is unavailable, unauthenticated, or not installed.
- **Adapter provenance is not a subscription-equivalence proof.** A verified, correctly-versioned adapter proves Barista is driving the intended local software, not that Anthropic's terms treat ACP-mediated automation identically to interactive CLI use. Treat ACP as the same conservative single-account, own-compute-node use case described below, re-verify against current Anthropic documentation before relying on it, and prefer the native CLI path when in doubt.

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
