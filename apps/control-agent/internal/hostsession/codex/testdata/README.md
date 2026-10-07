# Codex App Server fixture provenance

These scrubbed fixtures describe the exact interactive contract supported by the Coffee Shop Codex driver.

- Codex CLI: `0.147.0`
- upstream tag: `rust-v0.147.0`
- upstream commit: `be6e8eac029b183056b7e4402879f15d2c85f61b`
- retrieved: 2026-10-06
- source: the pinned executable's `codex app-server generate-json-schema --experimental` output, cross-checked with the pinned App Server README and the account-free two-process rollout fixture in `driver_test.go`
- transport: private newline-delimited JSON over stdio

All identities, paths, prompts, and history text in tests are synthetic. The fixtures contain no endpoint, credential, environment capture, provider configuration, or raw user transcript.

`driver_test.go` uses a deterministic fake process for request/response and failure-shape coverage. `TestRealPinnedAppServerWriterContention` writes a minimal synthetic paginated rollout to an isolated temporary Codex home, assigns each real 0.147.0 App Server its own temporary SQLite runtime home, and proves the exact cross-process writer conflict and release behavior without authentication or network access.
