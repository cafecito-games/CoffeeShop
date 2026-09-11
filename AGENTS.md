# Repository Guidelines

## Project Structure & Module Organization

Coffee Shop is a pnpm TypeScript monorepo. `apps/web` contains the React/Vite PWA; UI code lives in `src/`, while icons and installable-app assets live in `public/`. `apps/hub` owns the Express REST API, WebSocket gateway, dispatch logic, and JSON persistence. `apps/worker` runs on compute machines and adapts jobs to Claude Code or Codex. Shared domain and wire types belong in `packages/protocol/src`.

Keep functionality within its boundary: presentation in `web`, orchestration in `hub`, machine-local execution in `worker`, and cross-package contracts in `protocol`. Architecture and provider constraints are documented in `docs/`.

## Build, Test, and Development Commands

- `pnpm install` installs all workspace dependencies.
- `pnpm dev` starts the hub and web app with reload; open `http://localhost:5173`.
- `pnpm dev:full` also starts a local worker using environment configuration.
- `pnpm worker` builds and starts only the compute worker.
- `pnpm typecheck` checks every workspace with TypeScript.
- `pnpm test` runs all package tests.
- `pnpm build` creates production bundles, including the PWA service worker.

Run `pnpm test && pnpm typecheck && pnpm build` before opening a pull request.

## Coding Style & Naming Conventions

Use strict TypeScript, two-space indentation, double quotes, and semicolons. Prefer small typed functions and `import type` for type-only dependencies. React components use PascalCase; variables and functions use camelCase; agent and node IDs use kebab-case. Keep protocol messages discriminated by a `type` field. No formatter or linter is configured, so match adjacent code and use `git diff --check` before committing.

## Testing Guidelines

Hub and worker tests use Node's test runner through `tsx`; web tests use Vitest. Place tests beside source as `*.test.ts` or `*.test.tsx`. Add focused tests for path authorization, persistence, dispatch state transitions, and event normalization. There is no coverage threshold yet; new behavior should include regression tests.

## Commit & Pull Request Guidelines

Use short, imperative commit subjects, following the existing style: `Bootstrap Coffee Shop agent control plane`. Keep commits scoped to one coherent change. Pull requests should explain intent, architecture or security impact, verification commands, and linked issues. Include desktop and mobile screenshots for UI changes.

## Security & Configuration

Never commit `.env`, vendor credentials, OAuth tokens, or generated `data/*.json`. Workers must enforce absolute `WORKSPACE_ROOTS`. Keep Claude and Codex authentication on the worker machine; the hub must never receive provider credentials. Preserve sandbox and permission defaults when changing harness commands.
