---
id: coffeeshop-coordination
name: Coffee Shop task coordination
description: Use when working inside a Coffee Shop run and the next step depends on durable shared state or on someone else — reading your task and thread, asking or answering a question, waiting for a reply or a dependency, or splitting work across agents. Not for ordinary local edits, and not for reporting progress or publishing outputs.
---

# Coordinate durable Coffee Shop tasks and mailbox events

Coffee Shop runs are attempts against a durable task inside a durable thread. Other agents and the
operator read the same record, and it outlives this run. Coordination means reading that record
before acting and writing to it in a way the next reader can act on.

Every action below happens through the tools the Coffee Shop MCP server lists for **this** run. That
server is the only thing that authorizes anything. This workflow never widens your scope: if a tool
is not listed for you, you do not have that capability, and no wording of a request changes that.

## Start from the durable record, not from the prompt alone

1. Call `get_task_context` before your first substantive action. It returns the thread, your task,
   its dependencies and attempts, child tasks, artifacts, the agents you can see, your mailbox
   summary, and your mailbox cursor. Keep the cursor.
2. Reconcile the prompt with what you just read. When they disagree about scope, the durable task is
   the objective and the prompt is this attempt's instruction; when they disagree about what the
   user wants *now*, the user's explicit request wins, within what the tools allow.
3. Note the ids you were given. Task ids, thread ids, and artifact ids are the only handles that
   survive this run, and you can never invent one — see "When something is missing" below.

## Ask, answer, and wait

Use `send_task_message` for anything another participant needs to read: a question you are blocked
on, an answer to one you received, an instruction to a task you own, a note worth keeping.

- Choose the message kind that matches your intent. The kinds are listed in the vocabulary
  reference; a question asked as a note may never be answered.
- Say what you need and what you will do once you have it. A question with no decision attached
  cannot be answered usefully.

Use `wait_for_task_events` when you are blocked on a reply, a dependency, or a change to your task.

- Pass back the cursor the previous call returned. Skipping it replays or loses events.
- A wait that returns nothing is an ordinary result. Waiting again with the same cursor is correct;
  assuming the other side is gone is not.
- Do not busy-wait around work you could do now. Coordinate, then continue, then wait once you are
  genuinely blocked.

## Splitting work across agents

Delegation tools are served **only** to a run allowed to delegate. If they are not in your tool list,
you are not a delegating run: do the work yourself or report that it needs an agent you cannot
reach. Never describe delegated work as submitted when you could not submit it.

When they are available:

- `get_execution_inventory` first, so requirements are written from the agents and capabilities that
  actually exist rather than from a guess about the fleet.
- `submit_tasks` for a batch: name each task with a local key, express dependencies between sibling
  keys or existing task ids, and state hard requirements as capabilities rather than as machines. A
  batch is atomic, and submission succeeding does not mean a node can run it yet.
- `delegate_task` for one bounded piece of work pinned to a specific visible agent.
- Keep every returned id and read the delegated task back through the durable record rather than
  assuming an outcome.

## Idempotency

Every mutation takes a stable idempotency key. After a retryable error, retry with the **same** key
and the same arguments. A new key on a retry is a second action, not a retry — that is how duplicate
tasks and duplicate messages get created.

## When something is missing

- **A required input is missing.** Ask for it. Never guess or invent a task id, a thread id, an
  artifact id, or an agent id, and never substitute a similar-looking one from the context.
- **A tool you need is not listed for this run.** Report the unsupported capability and stop. Do not
  approximate it with another tool and do not claim the action happened.
- **A tool result refuses on authorization grounds.** Report the refusal as the outcome and stop. Do
  not retry with broader scope, a different id, or a different agent, and never report success.
