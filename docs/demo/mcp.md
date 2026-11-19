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
Claude calls `plan` with the goal, `approve_plan` with the same goal once you agree (the factory keeps no plan id between calls, so the tool takes the goal), `list_tickets` to find the ready ticket, then `dispatch`.

## Tools

Read: `status`, `list_tickets`, `queue`, `list_events`, `list_repos`, `explain_config`, `first_run`, `report`.
Write: `plan`, `approve_plan`, `dispatch`, `steer`, `cancel`, `retry`, `create_task`, `hand_off_task`, `queue_followup`.

Resources: `factory://board`, `factory://ticket/{id}`.

## A stdio session by hand

Run it from the splitbill fixture with a tracker set (`FACTORY_TRACKER=github`, `FACTORY_REPO`, a
token). Type one JSON line per request:

```
cd tests/fixtures/splitbill
factory mcp
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"demo","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"explain_config","arguments":{"key":"tracker"}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"approve_plan","arguments":{"goal":"add rate limiting"}}}
```

`explain_config` runs `factory config explain <key>` in process. Its text for `tracker` is the
same as the command prints:

```
tracker = github (env), overrode builtin
  builtin	github	-
  env	github	-
```

`approve_plan` runs `factory plan --approve -- <goal>` and files the tickets. A goal or key that
starts with `-` is refused before any command runs.

Not captured here: the cloud session that wrote this page cannot reach GitHub, and `factory mcp`
lists tickets at start, so the live session above was not run there. The handlers are tested in
process (`TestMCPApproveAndExplainRefuseFlags`, `TestMCPHandlersWired`).
