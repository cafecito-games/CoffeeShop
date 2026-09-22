# Repository Guidelines

## Project Structure & Module Organization

Coffee Shop is a polyglot monorepo driven by Task. `apps/web` contains the React/Vite PWA; UI code lives in `src/`, while icons and installable-app assets live in `public/`. `apps/hub` owns the Express REST API, WebSocket gateway, dispatch logic, and JSON persistence. `apps/control-agent` is the Go 1.26 Barista binary installed on compute machines. `apps/orchestrator-bridge` is the local stdio MCP server an operator's own Claude Code session launches to orchestrate a thread over the hub's `/orchestrator-client` endpoint. Shared TypeScript domain and wire types belong in `packages/protocol/src`; matching Go wire structs live in the control agent's internal protocol package.

Keep functionality within its boundary: presentation in `web`, orchestration in `hub`, machine-local execution in `control-agent`, and cross-package contracts in `protocol`. Architecture and provider constraints are documented in `docs/`.

## Build, Test, and Development Commands

- `task install` installs all JavaScript workspace dependencies.
- `task dev` starts the hub and web app with reload; open `http://localhost:5173`.
- `task dev:full` also starts a local Barista using environment configuration.
- `task frontend:dev`, `task control-plane:dev`, and `task control-agent:run` run individual applications.
- `task typecheck` checks every TypeScript workspace.
- `task test` runs TypeScript and Go tests.
- `task build` creates all production bundles and the `bin/barista` executable.

Run `task ci` before opening a pull request.

## Coding Style & Naming Conventions

Use strict TypeScript, two-space indentation, double quotes, and semicolons. Prefer small typed functions and `import type` for type-only dependencies. React components use PascalCase; variables and functions use camelCase; agent and node IDs use kebab-case. Keep protocol messages discriminated by a `type` field. Use standard `gofmt` formatting and conventional short, lowercase Go package names. No TypeScript formatter or linter is configured, so match adjacent code and use `git diff --check` before committing.

## Testing Guidelines

Hub tests use Node's test runner through `tsx`; web tests use Vitest; Barista uses Go's standard test package. Place tests beside source as `*.test.ts`, `*.test.tsx`, or `*_test.go`. Add focused tests for path authorization, persistence, dispatch state transitions, discovery, and event normalization. There is no coverage threshold yet; new behavior should include regression tests.

## Commit & Pull Request Guidelines

Use short, imperative commit subjects, following the existing style: `Bootstrap Coffee Shop agent control plane`. Keep commits scoped to one coherent change. Pull requests should explain intent, architecture or security impact, verification commands, and linked issues. Include desktop and mobile screenshots for UI changes.

## Security & Configuration

Never commit `.env`, vendor credentials, OAuth tokens, or generated `data/*.json`. Barista must enforce absolute `WORKSPACE_ROOTS`. Keep Claude and Codex authentication on the compute machine; the hub must never receive provider credentials. Preserve sandbox and permission defaults when changing harness commands.
