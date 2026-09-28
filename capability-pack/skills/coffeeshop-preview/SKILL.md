---
id: coffeeshop-preview
name: Coffee Shop static previews
description: Use when a Coffee Shop task asks you to build, publish, host, or share a static or interactive preview through the run-scoped preview publisher. Not for a normal file attachment, a server application, or obtaining an access URL.
---

# Publish a truthful static preview

A preview is a static directory published as one immutable Coffee Shop artifact. The Hub never runs
the build, and the model never receives the signed access URL. Build inside the authorized workspace,
publish through `publish_preview`, and report only the lifecycle state the tool actually returned.

## Establish the durable context

1. Call `get_task_context` before building or publishing. Use only the current task, run, thread, and
   workspace. Never guess a neighboring id or publish from another workspace.
2. Inspect the repository's checked-in instructions, scripts, and configuration for its build command
   and static output directory. Use an existing safe, non-destructive command. If there is no
   authoritative command or output, ask a bounded question or report the blocker instead of guessing
   a package manager, deleting a directory, or changing deployment configuration.
3. If the request is for one downloadable file rather than a site directory, stop and use the durable
   artifact workflow instead. Do not turn a normal attachment into a preview.

## Check that the output can be served

The path passed to the tool is workspace-relative and names a directory. The entrypoint is relative
to that directory, ends in `.html`, and already exists in the built output.

Before publishing, require all of these properties:

- The result is static files, with no application server, server-side rendering, directory-index, or
  SPA-fallback requirement.
- Asset and navigation references are relative. Root-relative references lose the capability path
  that authorizes the preview and therefore are not supported.
- The site does not depend on API calls, WebSockets, or external fetches: delivery enforces
  `connect-src 'none'`.
- Scripts, styles, images, fonts, media, and workers are same-origin. Inline scripts are not allowed.
  Inline styles are allowed, but an external stylesheet is easier to audit.
- No Hub token, preview capability, credential, or environment secret is embedded in the output.

Unknown file extensions download rather than execute under `nosniff`. If the output violates a rule,
report the incompatibility or rebuild only when the repository already authorizes the necessary
change. Do not weaken or work around delivery policy.

## Publish one logical revision

Choose one stable idempotency key from the current task or run id, the logical preview name, and an
explicit revision. Do not put an absolute path, timestamp, random value, credential, or secret in the
key. Keep the key and every argument with the work record while the call is unresolved.

Call `publish_preview` with the output directory, entrypoint, a human-readable title and summary, the
lifecycle duration when the request needs one, and that stable key. The tool owns path containment,
file-type and symlink checks, limits, deterministic packaging, hashing, registration, and upload.

For a retryable or uncertain result, retry with the same idempotency key and byte-for-byte equivalent
arguments. A new key is a new publication, not a retry. Reuse the existing key for unchanged output
intent; use an explicit next revision only after the content or publication metadata intentionally
changes. Never resolve a key conflict by silently inventing another key.

## Report exactly what returned

Keep the returned artifact id and preview id. Treat the returned `preview.status`, `preview.expiresAt`,
`preview.accessState`, `created`, and `artifact.uploaded` as separate facts:

- `artifact.uploaded` proves only that the exact archive upload completed. It does not prove the
  preview is ready.
- Say the preview is ready only when the returned `preview.status` is `ready`.
- For `upload-pending` or `processing`, report that exact state, both durable ids, and the lifecycle
  expiry. Do not call it ready.
- For `failed`, report the returned bounded failure code when present. For `expired`, report expiry.
  Do not publish the same unchanged intent under a fresh key as a recovery shortcut.

Never invent, reconstruct, request, store, or print an access URL. Ready preview access is issued only
to the authenticated operator through the preview UI; the agent has neither that authority nor its
credential. The lifecycle duration supplied to publication is not a signed-access duration.

## Attach the durable result

When `get_task_context` returned a current task, call `update_task` with the returned artifact id and a
stable update key. Include the preview id and exact returned status in the progress or completion
summary. Retry that update with the same key and arguments. If it fails, report that publication is
durable but task attachment did not land; never claim the task record was updated.

Do not mark a task complete merely because publication succeeded. Complete it only when the full task
objective holds. When there is no current task, report the artifact id, preview id, and exact status in
the run response; the producer has already linked them to the run and thread.

## Stop at the authority boundary

- If `publish_preview` is not listed, report the unsupported capability. Do not substitute the
  ordinary artifact publisher or claim a preview exists.
- If the tool refuses authorization or validation, report the refusal and stop. Do not retry with a
  broader path, another task, another tool, or another key.
- If the result is malformed or lacks either durable id, report failure and attach nothing invented.
- If asked to mint or reveal preview access, explain that access URL issuance is operator-only and
  stop at the durable preview id and returned lifecycle state.
