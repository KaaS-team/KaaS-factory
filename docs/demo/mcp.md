# Drive the factory from Claude Code

Add the factory once:

```
claude mcp add factory -- factory mcp
```

For a view-only session, add `--read-only` at the end. Write tools are then hidden and refused.

Remote use: `FACTORY_MCP_TOKEN=... factory mcp --http 8765` serves `/mcp` on loopback with a bearer token.

## Three prompts

**1. "What is the factory doing right now?"**
Claude calls `status` (the board), then reads the `factory://board` resource if it wants the raw view.

**2. "Show me ticket 7 and tell the session to add a test for the empty case."**
Claude calls `status` with `ticket: "7"` (detail and history), then `steer` with the ticket and the message.

**3. "Plan this goal, then run the first ticket: add rate limiting to the API."**
Claude calls `plan` with the goal, `approve_plan` once you agree, `list_tickets` to find the ready ticket, then `dispatch`.

## Tools

Read: `status`, `list_tickets`, `queue`, `list_events`, `list_repos`, `explain_config`, `first_run`, `report`.
Write: `plan`, `approve_plan`, `dispatch`, `steer`, `cancel`, `retry`, `create_task`, `hand_off_task`, `queue_followup`.

Resources: `factory://board`, `factory://ticket/{id}`.
