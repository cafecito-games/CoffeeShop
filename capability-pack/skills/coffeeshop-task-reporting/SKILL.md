---
id: coffeeshop-task-reporting
name: Coffee Shop task and thread reporting
description: Use when reporting progress on a Coffee Shop task, or when deciding whether a task or thread is finished — recording what changed, refining the shared record, and marking completion only once the objective actually holds. Not for asking questions and not for publishing files.
---

# Report progress and complete or refine a thread

A Coffee Shop task's status is what the operator and every other agent act on. Reporting is therefore
part of the work, not a courtesy afterwards — and a premature terminal status is worse than no update,
because it tells everyone the objective is met when it is not.

Status changes go through the Coffee Shop MCP server, which is the only layer that authorizes them.

## Report progress while you work

Call `update_task` at the points where a reader's understanding would change: you learned what the
real problem is, you finished a meaningful step, you hit something that changes the plan, you are
blocked.

- Report what is now true, not what you intend to do next paragraph.
- Name the durable handles you produced — task ids and artifact ids — so the next reader can find
  them without re-deriving them.
- Say plainly when you are blocked and on what. A silent blocked task looks identical to a slow one.

## Refine the shared thread record

Call `update_thread` when the thread's own record no longer matches reality: a title that describes
the wrong problem, an objective that has been superseded by what was actually asked, a summary that
would not tell a newcomer where things stand.

- Refine only what improves the shared record. Rewriting an objective to match what you happened to
  do is not refinement.
- Archival is the operator's decision, never yours.

## Complete only when the objective holds

Before any terminal update, read the record back with `get_task_context` and check the objective, the
dependencies, and the child tasks you are responsible for.

Mark a task complete when its own work is done and verified. Mark the **thread** completed only when
the overall objective is satisfied — not when your own task is done, not when you ran out of ideas,
and not because the run is ending.

When the objective is not satisfied, do not mark it completed. Report the remaining gap instead: an
honest incomplete status is actionable, and a false completion stops everyone else from acting.

Every update takes a stable idempotency key. Retry with the **same** key and arguments after a
retryable error; a new key records a second update rather than completing the first.

## When something is missing

- **You do not know which task or thread to report against.** Ask. Never guess a task id or a thread
  id, and never report against a neighbouring one because it looks close.
- **A status change is not available to this run.** Report the unsupported capability and stop. Saying
  in prose that something is "marked complete" when no update landed is a false report.
- **The result refuses on authorization grounds.** Report the refusal as the outcome and stop. Do not
  retry against a different task, a broader scope, or the thread instead of the task, and never
  describe the status as changed.
