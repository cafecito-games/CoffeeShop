# Codex App Server fixture provenance

These scrubbed fixtures describe the exact interactive contract supported by the Coffee Shop Codex driver.

- Codex CLI: `0.162.1`
- upstream tag: `rust-v0.162.1`
- upstream commit: `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`
- retrieved: 2026-10-14
- source: the pinned executable's `codex app-server generate-json-schema --experimental --out <dir>` output (the subcommand now requires an output directory and writes the v1 and v2 schema sets into it), cross-checked with the pinned App Server README and the account-free two-process rollout fixture in `driver_test.go`
- transport: private newline-delimited JSON over stdio

All identities, paths, prompts, and history text in tests are synthetic. The fixtures contain no endpoint, credential, environment capture, provider configuration, or raw user transcript.

`driver_test.go` uses a deterministic fake process for request/response and failure-shape coverage. `TestRealPinnedAppServerWriterContention` writes a minimal synthetic paginated rollout to an isolated temporary Codex home, assigns each real 0.162.1 App Server its own temporary SQLite runtime home, and proves the exact cross-process writer conflict and release behavior without authentication or network access.
