# Coffee Shop hub tool vocabulary

Generated from the Coffee Shop protocol vocabulary. Do not edit by hand: reseal the pack instead.

This reference lists **names only**. Every tool's input and output shape comes from the run-scoped
Coffee Shop MCP server that lists it, which is also the only layer that authorizes an action. Read the
served tool description in the run; never assume a shape from this file.

| Tool | Availability |
| --- | --- |
| `get_task_context` | every run |
| `delegate_task` | only a run allowed to delegate |
| `post_artifact` | every run |
| `publish_preview` | every run |
| `update_thread` | every run |
| `get_execution_inventory` | only a run allowed to delegate |
| `submit_tasks` | only a run allowed to delegate |
| `send_task_message` | every run |
| `wait_for_task_events` | every run |
| `update_task` | every run |

A tool that is not listed for your run is not available to you. Report the unsupported capability and
stop; never substitute another tool and never describe an action you did not complete.

## Task message kinds

- question
- answer
- instruction
- progress
- result
- note

## Waiting bounds

- Longest wait accepted, in milliseconds: 20000
- Most events returned by one wait: 50

A wait that returns no event is an ordinary result, not a failure. Pass the cursor it returns back into
the next wait so no event is skipped or replayed.
