# Authoring the Coffee Shop capability pack

`pack.json` is the authority for pack identity, the four shipped skills, their evaluation paths, and required tool vocabulary. Each skill lives at its declared `skills/<id>/SKILL.md`; each evaluation is a strict generation-1 fixture under `evaluations/`. Add or change a workflow by editing those producer files, not the generated `references/hub-tools.md`.

Every evaluation suite must retain the closed direct, indirect, incomplete, unrelated, edge, and authorization-boundary coverage and explicit outcome. The real system matrix enumerates the installed archive's manifest and evaluation fixtures, so a new skill or case cannot be silently skipped: it needs an exhaustive executable-state mapping and must run once on Claude native and once on Codex native. Preview is one of the four canonical skills, but isolated-origin delivery/signing/browser security remains its own feature suite.

After editing:

```bash
task capability-pack:seal
task capability-pack:test
task capability-pack:build
task system:test:capability-pack
```

Sealing regenerates the tool-name reference and every file digest. When releasing a new pack, bump both `pack.json` and the `coffeeshop-capability-pack` entry in `apps/control-agent/internal/setup/manifest/components.json`; plan/apply/activate the resulting archive and restart Barista. Rollback also takes effect only after restart. The rationale and exact component grammar are in [`apps/control-agent/internal/setup/manifest/README.md`](../apps/control-agent/internal/setup/manifest/README.md#coffeeshop-capability-pack--the-canonical-coffee-shop-workflows).

The deterministic fake provider proves exact installed bytes were projected, the vendor discovery surface found them, the real run-scoped MCP vocabulary and authority were used, and durable effects matched the fixture. It is not a model-quality oracle and uses no provider account. Never put credentials, endpoint capabilities, access URLs, absolute machine paths, or setup authority into this tree.
