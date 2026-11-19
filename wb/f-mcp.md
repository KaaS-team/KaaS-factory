You are one of 9 cloud sessions in Wave B: making the KaaS-team suite stable and simple to read before its first stable releases (factory v9.0.0, kaasbot, blueprint and solutions v1.0.0). Three products: **blueprint** (skills and rules for coding agents and software teams), **kaasbot** (24/7 AI teammates) and **factory** (the AI SDLC software factory). CLI and MCP matter most; a web UI is out of scope.

## Hard limits
- **75 minutes.** At minute 65, stop new work, make what you have green, push and write the report. A smaller thing that works beats a bigger thing that half works.
- Stay inside **Your area**. Another session owns everything else. If you must touch a file outside it, make the smallest edit and list it in the report.
- Never push to `main`, `next` or any branch but your own. Never edit `.github/workflows/` (cloud tokens cannot push it): put the needed change in the report.

## Research first (at most 12 minutes), then copy, don't invent
Before writing code, read the source of the upstreams named in your ticket (`git clone --depth 1`, or WebFetch the raw files) and note the behaviour you will copy: command names, flags, output shape, tool names. Popular, proven shapes beat new ones. Copy code only from MIT or Apache-2.0 sources, with a `Ported from <repo>@<sha> <path>` header and a `THIRD_PARTY_NOTICES.md` entry. AGPL, non-commercial and unlicensed repos are ideas only. Name every upstream you used in the report.

## How to work
- For each acceptance line: write the test, watch it fail, write the code, watch it pass.
- No network, real token or model call in any test; fakes and `httptest` only.
- No provider API key anywhere. No model name, token count or cost in any customer-facing text (README, demo docs, PR body).
- Plain English in docs and output: short sentences, no em dashes, no filler.
- Commit with `git commit -s`. Push after each green step: `git push -u origin <your branch>`. Run the repo's gate (named below) before the last push; it must pass with zero errors and zero warnings.

## Report (required)
Write `.factory/reports/<ticket>.md` on your branch and push it last:
1. **Demo commands:** the exact commands a presenter types, in order, with the real output you got (trimmed).
2. **Acceptance:** each line, done or blocked with the reason.
3. **Upstreams copied:** repo@sha and what you took.
4. **Files outside my area** and **workflow changes needed**, if any.

## Repo and gate
Repo `KaaS-team/KaaS-factory` (Go), branch from `origin/next`. Gate: `just check`. Read `AGENTS.md` first.
Your branch: `wb/f-mcp`. Ticket id for the report: `f-mcp`.

## Your area
internal/mcp/, cmd/factory/ (only the mcpHandlers function and its tests), docs/demo/mcp.md

## Ticket: finish the MCP tool set
`factory mcp` lists `approve_plan` and `explain_config`, but `mcpHandlers()` in cmd/factory/main.go leaves them nil, so they answer "not available in this build". `first_run`, `report` and `plan` already run their CLI command in process through `runSub`; copy that shape.
- `explain_config`: take a `key` argument (add it to the tool's input schema) and run `config explain <key>`; refuse a key that starts with `-`.
- `approve_plan`: find how `factory plan --approve` files tickets and give the tool the same path; refuse a plan id that starts with `-`. If a plan id cannot be kept between calls, make the tool take the goal and approve it in one call, and say so in the tool description.
- Remove the names from the `unwired` map in `TestMCPHandlersWired`.
Upstreams to read: `github/github-mcp-server` (tool naming, read-only split), `modelcontextprotocol/go-sdk` examples.
## Acceptance
- [ ] Every MCP tool answers; `TestMCPHandlersWired` has an empty exemption list.
- [ ] A test per tool: a flag-shaped argument is refused.
- [ ] `docs/demo/mcp.md` shows a real stdio session (initialize, tools/list, one call per new tool) against `tests/fixtures/splitbill`.
