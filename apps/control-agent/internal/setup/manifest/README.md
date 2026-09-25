`components.json` is the managed component manifest compiled into the Barista binary (schema generation `2`). Each entry declares a `kind` from the closed vocabulary `harness` or `acp-adapter`. Four entries ship: the ACP adapters `claude-acp` and `codex-acp`, and the provider harnesses `claude-cli` and `codex-cli`. An `acp-adapter` installs under `<data-root>/adapters/<harnessId>/<id>/<version>/`, a `harness` under `<data-root>/harnesses/<harnessId>/<id>/<version>/`.

The previous adapter-only schema (generation `1`: an `adapters` array with no `kind`) is still accepted by `barista setup --manifest <path>` for the transition. Every entry migrates to `acp-adapter` and resolves to exactly the same install path, so an administrator who kept their old manifest file installs the same thing. A document that mixes the two generations, or declares a generation nobody supports, is rejected whole rather than resolved in either generation's favour. `../testdata/manifest-legacy-generation-1.json` is the exact generation-1 bytes this manifest replaced, kept as the migration fixture.

Every shipped entry currently uses the distribution `kind: "manual"` (`platforms.<GOOS-GOARCH>.kind`, distinct from the component `kind`) because no pinned vendor artifact clears the archive test below; the operator places the executable themselves and asserts its SHA-256 at apply time. When a vendor publishes a pinned release, switch the entry to `kind: "archive"` with the real HTTPS URL, `sha256`, and `sizeBytes` — automated verified download then works with no code change anywhere else.

## How a platform's distribution kind is decided

Applied per component per platform, in order. No step is skipped to produce a nicer-looking entry.

1. `kind: "archive"` **only if all** of these are verifiably true from vendor documentation: the URL is versioned and immutable; a SHA-256 for exactly those bytes is obtainable and reviewable; the exact byte size is known; the artifact is a `.tar.gz` or `.zip`; the executable sits at one stable relative path inside it; the vendor's terms permit automated download by an operator's own tooling; and the vendor's version string is a normalized dotted version.
2. Otherwise, if an administrator can deterministically produce a single executable file from a documented, tagged source or published package and assert its SHA-256 out of band: `kind: "manual"`, with the exact packaging commands recorded below. A distribution whose only offered mechanism is a package manager or a bootstrap script lands here, never in step 1 — Barista never runs `npm`, `npx`, `brew`, `pipx`, or `curl … | sh` at any point.
3. Otherwise the platform key is omitted entirely and the platform is **unsupported**, with the vendor fact that made it so recorded below.

A URL, digest, size, or version string is never synthesized. An unverifiable pin would fail on a real operator's machine or, worse, appear to verify something it did not.

## Supported platform keys

Barista honours exactly four: `darwin-amd64`, `darwin-arm64`, `linux-amd64`, `linux-arm64`. Every other platform — **`windows-amd64` and `windows-arm64` included — is unsupported by omission of the platform key**, for every component, harness and adapter alike. That omission is Barista's own supported-platform set, not a vendor gap: both vendors do publish `win32-x64` and `win32-arm64` artifacts. There is no fallback platform and no substitute download; `barista doctor` reports `no platform distribution for <platform>` and planning emits no operation.

## Harness entries

`version` is the harness version Barista supports, and it is enforced twice over: `barista setup activate` refuses a managed harness whose own `--version` output does not report exactly this version (`ProbeHarnessVersion` in `../activation.go`), so a node can never be running a version its records claim it is not. Bump the entry and re-run plan/apply/activate to move a node to a new version; the previous version's files stay installed as the rollback target until an explicit `barista setup prune`.

Authentication is a **separate operator action after installation**, never part of it. Both harnesses keep their login in their own vendor-owned local storage on the compute machine. Barista installs, copies, exports, and forwards no credential, the hub never receives one, and `barista doctor` reports only a coarse `authReadiness` derived from an exit code.

### `claude-cli` — Claude Code

* Pin: `@anthropic-ai/claude-code` **2.1.231**, provider `anthropic`.
* Source consulted: the vendor package's own `package.json` and `README.md` as installed on the implementation machine, plus <https://code.claude.com/docs/en/overview>. Retrieved 2026-09-25.
* Decision: **`manual` on all four platforms.** Step 1 fails on two independent clauses. The only installation mechanism the vendor documents is `npm install -g @anthropic-ai/claude-code`, a package manager, which step 2 sends here by rule; and the package's licence is "SEE LICENSE IN README.md" (Anthropic's Commercial Terms of Service), which does not grant redistribution, so no digest of a re-hosted artifact could be pinned either. No standalone checksummed release archive is documented.
* What the operator packages: the vendor's per-platform package, which contains a **single self-contained native executable**. `@anthropic-ai/claude-code`'s `optionalDependencies` declare one package per platform at the same version, and each one ships that executable at `package/claude`:

  | Barista platform key | vendor platform package |
  | --- | --- |
  | `darwin-amd64` | `@anthropic-ai/claude-code-darwin-x64@2.1.231` |
  | `darwin-arm64` | `@anthropic-ai/claude-code-darwin-arm64@2.1.231` |
  | `linux-amd64` | `@anthropic-ai/claude-code-linux-x64@2.1.231` (musl hosts: `@anthropic-ai/claude-code-linux-x64-musl@2.1.231`) |
  | `linux-arm64` | `@anthropic-ai/claude-code-linux-arm64@2.1.231` (musl hosts: `@anthropic-ai/claude-code-linux-arm64-musl@2.1.231`) |

  ```bash
  # On an operator workstation, for the node's platform. `npm pack` only downloads and writes a
  # tarball; it runs no install script and Barista never runs it.
  npm pack @anthropic-ai/claude-code-linux-x64@2.1.231
  tar -xzf anthropic-ai-claude-code-linux-x64-2.1.231.tgz   # extracts package/claude
  sha256sum package/claude                                  # the digest asserted below

  barista setup plan --data-root <path> --out plan.json
  barista setup apply --plan plan.json \
    --manual-artifact claude-cli=$PWD/package/claude \
    --manual-checksum claude-cli=<sha256>
  barista setup activate --component harness/claude-cli --version 2.1.231
  ```

  Verify before asserting the digest: `./package/claude --version` must print `2.1.231`, or activation will refuse the candidate.
* Authentication: run `claude` once on the node and sign in. Claude Code stores its own subscription login locally; see <https://code.claude.com/docs/en/overview>. Barista neither sets nor reads `ANTHROPIC_API_KEY` for a managed harness.

### `codex-cli` — Codex

* Pin: `@openai/codex` **0.147.0**, provider `openai`, licence Apache-2.0.
* Source consulted: the vendor package's own `package.json` and `README.md` as installed on the implementation machine, plus <https://developers.openai.com/codex>. Retrieved 2026-09-25.
* Decision: **`manual` on all four platforms.** This one comes closest to clearing step 1: the vendor's README documents GitHub Release archives per platform, states that "each archive contains a single entry with the platform baked into the name", and the licence is Apache-2.0, so container, internal layout, and terms are all satisfied. Step 1 still fails because **no SHA-256 and no exact byte size is published for those archives** in any vendor source, and an archive pin without a reviewable digest and size is not a pin. The vendor's other documented mechanisms — `curl -fsSL https://chatgpt.com/codex/install.sh | sh`, `npm install -g @openai/codex`, `brew install --cask codex` — are a bootstrap script and package managers, which step 2 sends here by rule. **If OpenAI publishes per-asset digests and sizes for a tagged release, this entry is the one to promote to `kind: "archive"`;** that is the only change needed, and no code changes with it.
* What the operator packages, preferred route — the vendor's own standalone release archive, whose single entry is the executable:

  | Barista platform key | GitHub Release asset |
  | --- | --- |
  | `darwin-amd64` | `codex-x86_64-apple-darwin.tar.gz` |
  | `darwin-arm64` | `codex-aarch64-apple-darwin.tar.gz` |
  | `linux-amd64` | `codex-x86_64-unknown-linux-musl.tar.gz` |
  | `linux-arm64` | `codex-aarch64-unknown-linux-musl.tar.gz` |

  ```bash
  # Download the asset for version 0.147.0 from the vendor's own releases page
  # (https://github.com/openai/codex/releases) with a browser or the operator's own tooling.
  tar -xzf codex-x86_64-unknown-linux-musl.tar.gz
  mv codex-x86_64-unknown-linux-musl codex
  ./codex --version            # must print 0.147.0
  sha256sum codex

  barista setup plan --data-root <path> --out plan.json
  barista setup apply --plan plan.json \
    --manual-artifact codex-cli=$PWD/codex \
    --manual-checksum codex-cli=<sha256>
  barista setup activate --component harness/codex-cli --version 0.147.0
  ```

  Alternative route via `npm pack @openai/codex@0.147.0-linux-x64` works the same way, but note that the npm platform package lays the binary out as `package/vendor/<target-triple>/bin/codex` **beside auxiliary sandbox resources** (`codex-resources/bwrap`, `codex-resources/zsh`) that a Barista-managed install does not carry, because a managed install is exactly one executable file. Prefer the release archive entry, which the vendor publishes as a single self-contained file.
* Authentication: run `codex` once on the node and choose "Sign in with ChatGPT", or configure an API key per <https://developers.openai.com/codex>. The credential stays in Codex's own local storage.

## ACP adapter entries

`version` is the adapter version Barista supports. The daemon launches an adapter only when it reports exactly this version in its ACP `initialize` response, so bump it together with the adapter the operator installs.

- `codex-acp` pins `@agentclientprotocol/codex-acp` 1.12.0. Its release publishes no standalone artifact; build the single-file executable with `npm run bundle:all` from the tagged source (the `dist/bin` output for the node's platform) and install it with `barista setup plan` and `barista setup apply --plan <plan> --manual-artifact codex-acp=<file> --manual-checksum codex-acp=<digest>`. A global npm install is a script that loads unpinned `node_modules`, so it cannot be verified by one digest and is not supported. Never point Barista at `npx`.
- `claude-acp` pins `@agentclientprotocol/claude-agent-acp` 0.79.0, the official ACP agent built on the Claude Agent SDK (`bin: claude-agent-acp`). It also publishes no standalone signed artifact; package the CLI's `bin/claude-agent-acp` entry point (with its bundled `node_modules`, or a single-file bundle built the same way as codex-acp) and install it the same way, with `--manual-artifact claude-acp=<file> --manual-checksum claude-acp=<digest>`. The adapter authenticates through Claude's own locally owned CLI credential storage (or an operator-inherited provider environment) exactly like the native `claude` binary; Barista never installs, exports, or forwards a credential for it, and never points it at an API key to approximate a subscription.

## Harness launch templates are empty and stay empty

A `harness` entry's `launch` must be `{}`, and `Manifest.Validate` rejects one that is not. Native harness execution builds its own arguments and environment in `../../harness/runner.go` and reads no manifest launch template, so accepting operator-supplied arguments there would be a promise Barista does not keep — including, dangerously, a sandbox or permission flag an administrator believed had been applied. An `acp-adapter` entry's `launch` is consumed and stays allowed.
