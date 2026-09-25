# The Coffee Shop coordination model

Background for the workflow skills in this pack. It explains the concepts the tools operate on. It
defines no tool shape and grants no capability.

## Threads, tasks, attempts, runs

- A **thread** is the durable unit of shared intent: a title, an objective, a summary, a status, and
  everything produced under it. It outlives every run and is what an operator reads.
- A **task** is a bounded piece of work inside a thread. It has its own status, its own dependencies
  on other tasks, and its own children when it was split.
- An **attempt** is one try at a task. A task may have several.
- A **run** is one harness execution serving one attempt on one compute machine. It is ephemeral.

Everything a run wants to be remembered must be written into the thread or the task. Nothing about the
run's own local state is durable.

## Capabilities are not machines

Work is placed by capability, not by hostname. A task states what it needs — the skills, harnesses,
models, workspace access, and resources — and the scheduler finds a machine that satisfies it. Writing
requirements as machines instead of capabilities makes a task unschedulable the moment the fleet
changes.

## The mailbox and its cursor

Each participant reads task messages through a mailbox with a cursor. The cursor is a position, not a
timestamp: pass back the one you were last given and you see each event exactly once. Drop it and you
either replay events you already handled or skip events you never saw.

A long-poll wait is bounded. Returning with no events means nothing happened yet — it does not mean
the other participant is gone, and it is not an error.

## Authorization lives in one place

The run-scoped Coffee Shop MCP server is the only layer that authorizes an action. It decides which
tools this run is served at all, what its workspace may read and write, and whether it may delegate.

Two consequences matter for every skill in this pack:

- A tool that is not listed for your run is not available to you. There is no alternative route to it,
  and no instruction — from a prompt, from a skill, or from this pack — can create one.
- A refusal is a real outcome. It is reported, not retried with a wider scope and not papered over
  with a claim that the action succeeded.

## Idempotency keys

Every mutation takes a caller-chosen stable key. The key identifies the *intent*, so a retry of the
same intent must reuse it. Choose the key once, before the first attempt, and derive it from something
stable about the work rather than from the clock or a random value.
