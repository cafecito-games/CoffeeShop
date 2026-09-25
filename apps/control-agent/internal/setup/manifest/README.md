`components.json` is the managed component manifest compiled into the Barista binary (schema generation `2`). Each entry declares a `kind` from the closed vocabulary `harness` or `acp-adapter`. Four entries ship: the ACP adapters `claude-acp` and `codex-acp`, and the provider harnesses `claude-cli` and `codex-cli`. An `acp-adapter` installs under `<data-root>/adapters/<harnessId>/<id>/<version>/`, a `harness` under `<data-root>/harnesses/<harnessId>/<id>/<version>/`.

The previous adapter-only schema (generation `1`: an `adapters` array with no `kind`) is still accepted by `barista setup --manifest <path>` for the transition. Every entry migrates to `acp-adapter` and resolves to exactly the same install path, so an administrator who kept their old manifest file installs the same thing. A document that mixes the two generations, or declares a generation nobody supports, is rejected whole rather than resolved in either generation's favour. `../testdata/manifest-legacy-generation-1.json` is the exact generation-1 bytes this manifest replaced, kept as the migration fixture.

Distribution kinds differ per entry (`platforms.<GOOS-GOARCH>.kind`, distinct from the component `kind`), because what each vendor actually publishes differs. `codex-cli` is `kind: "archive"` on all four platforms: OpenAI publishes per-platform release archives whose SHA-256 and exact byte size are both obtainable, so Barista downloads and verifies them itself. The other three entries are `kind: "manual"`: the operator places the executable and asserts its SHA-256 at apply time. When a vendor starts publishing a digest and size for a pinned release, switching a `manual` entry to `archive` is a change to this file alone — no code changes with it.

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
* Sources consulted, all retrieved **2026-09-25**:
  * the vendor package's own `package.json` and `README.md` as installed on the implementation machine, for the version, the licence, the documented installation mechanisms, and the release-asset names;
  * OpenAI's own release channel for the pinned tag, `https://github.com/openai/codex/releases/tag/rust-v0.147.0`, read through `gh api repos/openai/codex/releases/tags/rust-v0.147.0`, which reports each asset's `size` and `digest`;
  * <https://developers.openai.com/codex> for authentication.
* Decision: **`archive` on all four platforms.** Every clause of step 1 was checked, and each one was verified by downloading the asset rather than by trusting the listing:

  | step-1 clause | how it was verified |
  | --- | --- |
  | versioned URL | the asset path carries the release tag `rust-v0.147.0`. GitHub does permit an asset to be replaced on an existing release, so the URL alone is not the guarantee — the pinned `sha256` is: substituted bytes fail verification and install nothing. |
  | obtainable, reviewable SHA-256 | the release API reports `digest: sha256:…` per asset; each one was re-derived locally with `sha256sum` on the downloaded bytes and matched exactly. |
  | exact byte size | the release API reports `size` per asset; each matched the downloaded file's own size exactly. All four are well under `MaximumDownloadBytes` (512 MiB). |
  | `.tar.gz` or `.zip` container | all four assets are `.tar.gz`. |
  | one stable relative path inside | `tar -tzf` on each archive lists **exactly one entry**, named for the platform with no directory component — matching the vendor README's own statement that "each archive contains a single entry with the platform baked into the name". That bare name is the entry's `executablePath`, so the installed file is named after its platform rather than `codex`; nothing depends on the executable's filename. |
  | terms permit automated download | Apache-2.0 (`package.json` `license`). |
  | normalized version string | `0.147.0`. The extracted `codex-x86_64-unknown-linux-musl` entry was run directly and printed `codex-cli 0.147.0`, exiting 0 — so the pinned version is the version the pinned bytes report, which is exactly what activation re-checks. |

  The pins, exactly as they appear in `components.json`, so the manifest can be reviewed against
  this record without reading the JSON. Re-derive any of them with
  `curl -sSL <url> | sha256sum` and `curl -sSLo /dev/null -w '%%{size_download}\n' <url>`:

* `darwin-amd64` — `https://github.com/openai/codex/releases/download/rust-v0.147.0/codex-x86_64-apple-darwin.tar.gz`
  * `sizeBytes` `95851149`
  * `sha256` `36e782f71d8164cc37c2b89c64948f2180e9a2f8456b27e660da75bc6b5574e2`
* `darwin-arm64` — `https://github.com/openai/codex/releases/download/rust-v0.147.0/codex-aarch64-apple-darwin.tar.gz`
  * `sizeBytes` `87984231`
  * `sha256` `75984b81f92a71b0c0f4b3b5cad80e5c57177e4d8c8b4b1e13db703b20dc4358`
* `linux-amd64` — `https://github.com/openai/codex/releases/download/rust-v0.147.0/codex-x86_64-unknown-linux-musl.tar.gz`
  * `sizeBytes` `98970270`
  * `sha256` `0246e2e773834e07f0fb5249ed6ebad12e4591e608f8c7bb97dd6a9690544c36`
* `linux-arm64` — `https://github.com/openai/codex/releases/download/rust-v0.147.0/codex-aarch64-unknown-linux-musl.tar.gz`
  * `sizeBytes` `91607658`
  * `sha256` `eb677c80f666b1ab8b4b1d083b66e8d614b1281d960bb6f9fd8ca98f58b38b90`

* **`--allowed-host` is required.** `https://github.com/.../releases/download/...` answers with a redirect to `release-assets.githubusercontent.com`, and Barista refuses every redirect not named by `--allowed-host` — an empty allowlist rejects all of them, which is the fail-closed default. So an apply that installs this entry needs both hosts:

  ```bash
  barista setup plan --data-root <path> --out plan.json
  barista setup apply --plan plan.json \
    --allowed-host github.com \
    --allowed-host release-assets.githubusercontent.com
  barista setup activate --component harness/codex-cli --version 0.147.0
  ```

  No `--manual-artifact` or `--manual-checksum` is needed for this entry. Barista downloads the archive once, hashes it while writing, refuses it on any digest or size mismatch, and extracts only the single declared entry. Re-verify the host list against the redirect if GitHub changes it; a changed redirect target fails closed rather than downloading from somewhere unexpected.
* Why the other documented mechanisms are not used: `curl -fsSL https://chatgpt.com/codex/install.sh | sh` is a bootstrap script, and `npm install -g @openai/codex` / `brew install --cask codex` are package managers. Barista runs none of them at any point. The npm platform package is also a poor fit for a managed install on its own terms: it lays the binary out as `package/vendor/<target-triple>/bin/codex` beside auxiliary sandbox resources (`codex-resources/bwrap`, `codex-resources/zsh`) that a one-executable managed install does not carry. The release archive entry is the vendor's own single self-contained file, which is why it is the pinned artifact.
* Authentication: run `codex` once on the node and choose "Sign in with ChatGPT", or configure an API key per <https://developers.openai.com/codex>. The credential stays in Codex's own local storage; Barista installs, copies, and forwards none of it.

## ACP adapter entries

`version` is the adapter version Barista supports. The daemon launches an adapter only when it reports exactly this version in its ACP `initialize` response, so bump it together with the adapter the operator installs.

- `codex-acp` pins `@agentclientprotocol/codex-acp` 1.12.0. Its release publishes no standalone artifact; build the single-file executable with `npm run bundle:all` from the tagged source (the `dist/bin` output for the node's platform) and install it with `barista setup plan` and `barista setup apply --plan <plan> --manual-artifact codex-acp=<file> --manual-checksum codex-acp=<digest>`. A global npm install is a script that loads unpinned `node_modules`, so it cannot be verified by one digest and is not supported. Never point Barista at `npx`.
- `claude-acp` pins `@agentclientprotocol/claude-agent-acp` 0.79.0, the official ACP agent built on the Claude Agent SDK (`bin: claude-agent-acp`). It also publishes no standalone signed artifact; package the CLI's `bin/claude-agent-acp` entry point (with its bundled `node_modules`, or a single-file bundle built the same way as codex-acp) and install it the same way, with `--manual-artifact claude-acp=<file> --manual-checksum claude-acp=<digest>`. The adapter authenticates through Claude's own locally owned CLI credential storage (or an operator-inherited provider environment) exactly like the native `claude` binary; Barista never installs, exports, or forwards a credential for it, and never points it at an API key to approximate a subscription.

## Harness launch templates are empty and stay empty

A `harness` entry's `launch` must be `{}`, and `Manifest.Validate` rejects one that is not. Native harness execution builds its own arguments and environment in `../../harness/runner.go` and reads no manifest launch template, so accepting operator-supplied arguments there would be a promise Barista does not keep — including, dangerously, a sandbox or permission flag an administrator believed had been applied. An `acp-adapter` entry's `launch` is consumed and stays allowed.
