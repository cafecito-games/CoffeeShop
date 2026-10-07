Implement the existing-Codex-sessions MVP for Coffee Shop end to end, covering GitHub issues #161, #159, #162, #155, and #163, so an authorized operator can see real existing Codex threads from a registered Barista host in a provider-neutral Sessions inventory and read-only detail experience. Continue until the implementation and verification evidence meet every in-scope acceptance criterion, or until a genuine blocker remains that cannot be resolved safely within this repository.

Work from `/home/coder/workspace/CoffeeShop`. Read and obey the repository `AGENTS.md`, then fetch the current bodies and state of the five issues before changing code:

- https://github.com/cafecito-games/CoffeeShop/issues/161 — durable provider-neutral Barista host-session core
- https://github.com/cafecito-games/CoffeeShop/issues/159 — Hub inventory and read authority
- https://github.com/cafecito-games/CoffeeShop/issues/162 — protocol-v6 Barista control transport
- https://github.com/cafecito-games/CoffeeShop/issues/155 — Codex App Server driver
- https://github.com/cafecito-games/CoffeeShop/issues/163 — Sessions inventory and detail PWA

Treat each current issue body, its fail-closed contract, and its acceptance criteria as authoritative. Confirm that protocol foundation #152 is present on the working branch. Inspect the current branch, open PRs, and working tree before beginning; preserve unrelated user changes and do not duplicate work that has already landed.

Implement in dependency order:

1. Build #161's durable provider-neutral Barista core and deterministic fake-driver coverage.
2. Build #159's durable Hub inventory, reconciliation, authorized list/detail/history surfaces, and snapshot projection. This is independent of #161 and may be progressed while the Barista core is being developed, but keep changes reviewable and respect the issue boundaries.
3. After #161 is complete, implement #162's protocol-v6 transport, inventory/update publication, reconnect behavior, and daemon wiring.
4. After the #154 split prerequisites represented by #161 and #162 are satisfied, implement #155's pinned Codex App Server integration. Discover existing threads through bounded `thread/list`, read them through `thread/read`, validate workspace and history mode, preserve the provider's writer-lock semantics, and accurately distinguish writable adoption eligibility from observe-only or `active-elsewhere`. Never use PID/TTY injection, direct rollout-file mutation, or status preflight as ownership proof.
5. After #159 is complete, implement #163's top-level responsive Sessions inventory and read-only detail UI using only validated Hub state. Show bounded history, provenance, status, control mode, capabilities, stale/offline/truncated evidence, and canonical Coffee Shop activity links without implying write access. Preserve legacy provider-session resume commands and add host-session links only when a real host-session mapping exists.

The first release target is visibility and inspection. Do not expand scope into #160 or #164's mutation/control surfaces, Claude work (#166/#169), or the upstream-blocked Claude adoption work (#168), except for a minimal compatibility change strictly required by one of the five in-scope issues. Do not close issues, open or merge PRs, push branches, or otherwise mutate GitHub state unless the user separately asks.

Preserve these invariants throughout:

- Existing protocol-v1-v5 behavior, one-shot dispatch, and run-scoped `HarnessSessionBinding` behavior must not regress.
- Provider credentials, tokens, endpoints, raw configuration, launch environment, and unbounded/raw provider transcripts must remain on the compute host and must not enter Hub state, snapshots, logs, fixtures, or browser state.
- Every workspace exposed or acted on must be canonical, exist, and remain beneath configured `WORKSPACE_ROOTS`.
- Inventory generations commit only when complete and valid; stale, mixed, malformed, or incomplete evidence must not replace the last authoritative projection.
- Codex support must use the exact setup-verified pinned executable and pinned App Server contract required by #155. Legacy or incompatible threads may be readable only when the issue contract permits and must never be presented as safely writable.
- Keep provider-neutral authority in the shared host-session layers and provider-specific RPC knowledge inside the Codex driver.
- Follow cgroup-derived CPU and memory limits from `AGENTS.md`; never size work from raw `nproc` or `free` output.

After each issue-sized change, run its focused verification commands from the issue body and fix all failures before continuing. Add regression tests for persistence migration, malformed/replayed inventory, reconnect/restart, workspace authorization, Codex protocol skew and writer contention, redaction, PWA validation, accessibility, responsive behavior, and legacy compatibility as required by the issue specifications. Use hermetic, account-free, network-free fixtures for automated provider tests. If local authenticated Codex state is available, perform a non-destructive live smoke test; lack of local credentials must not be worked around by inspecting or exporting secrets.

Before declaring the Goal complete:

- Demonstrate with automated integration/system coverage that existing Codex threads discovered by a protocol-v6 Barista reach the Hub and render in the Sessions inventory and detail UI with bounded history and accurate read-only/control status.
- Run every focused suite named by #161, #159, #162, #155, and #163.
- Run `task ci`, `git diff --check`, and `task system:test` if that task exists.
- Review the final diff for issue-boundary violations, secret/path leakage, optimistic UI state, duplicate authority, unsafe ownership assumptions, and protocol-v5 regressions.
- Produce a concise completion report mapping each of the five issues and its acceptance criteria to changed files and passing evidence, plus any live smoke test that was or was not run.

Between iterations, use the latest failing test, contract mismatch, or missing acceptance criterion to choose the next smallest useful change. Do not mark the Goal complete merely because code compiles or individual unit tests pass. If progress becomes genuinely blocked, stop only after exhausting safe in-scope alternatives and report the exact blocker, commands and evidence gathered, the affected acceptance criteria, current repository state, and the smallest external decision or dependency needed to continue.
