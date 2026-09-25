---
id: coffeeshop-artifacts
name: Coffee Shop durable artifacts
description: Use when a Coffee Shop run produces a file another agent, a later attempt, or the operator will need — a patch, a report, test results, a log, an image — and it must survive this run and be attached to what you report. Not for scratch files, and not for text that belongs in a message.
---

# Publish and retain durable Coffee Shop artifacts

A file left in the run workspace disappears with the run. A published artifact is durable: it gets an
id, it is listed in the thread's record, and anything you report afterwards can point at it.

Publish through the Coffee Shop MCP server, which is the only layer that authorizes a publication and
the only thing that decides what your run is allowed to read.

## Decide what deserves to be an artifact

Publish a file when a reader outside this run needs the bytes: the patch you produced, the report
someone asked for, the failing test output that justifies your conclusion, the log that explains a
crash, the image that shows the result.

Do not publish scratch state, a whole dependency tree, or something whose entire content would fit
comfortably in a message. A short finding belongs in what you report, not in a file nobody will open.

## Publish it

1. Write the file inside the current run workspace first. Only a regular file already in the
   workspace can be published, and the path you give is relative to it — never an escaping path.
2. Call `post_artifact` with that relative path, a title a human can scan, the kind that matches what
   it is, its media type, a one-line summary of why it matters, and a stable idempotency key.
3. Keep the returned artifact id. It is the handle everything downstream uses, and it cannot be
   recovered by guessing.

Publish the same file once. On a retryable error, retry with the **same** idempotency key and the same
arguments; a fresh key publishes a second copy rather than completing the first attempt.

## Attach it to what you report

An artifact nobody is pointed at is nearly as lost as one that was never published.

- Reference the artifact id in the progress you report with `update_task`, in the same step that
  explains what the artifact shows. Do not save every artifact reference for a final summary.
- Read the record back with `get_task_context` when you need to know which artifacts a task or thread
  already carries — for example before publishing what may be a duplicate of an earlier attempt's
  output. Never infer the artifact list from your own memory of this run.

## When something is missing

- **The file is not there, or the request named no file.** Ask which file to publish. Never publish a
  file you invented, an empty placeholder, or a near approximation of what was asked for.
- **Publishing is not available to this run.** Report the unsupported capability and stop. Do not
  paste the file's contents into a message as a substitute and do not claim it was published.
- **The result refuses on authorization grounds** — the path is outside what your run may read, or the
  publication is not permitted. Report the refusal as the outcome and stop. Do not retry with a
  different path to get around it, and never report a successful publication.
