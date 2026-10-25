# OpenCode 1.18.32: facts the preset relies on

Source: sst/opencode tag v1.18.32, read 2026-09-24 (no install, no token spend).

- Prompt: `packages/opencode/src/cli/cmd/run.ts` reads piped stdin: `const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()`, then merges it with the positional message.
- Events (`--format json`): `tool_use`, `step_start`, `step_finish`, `text`, `reasoning`, `error`, each with a `part`.
- Read-only: `packages/opencode/src/agent/agent.ts` defines a primary agent `plan` whose edit permission is `"*": "deny"` (only `.opencode/plans/*.md` allowed). `--agent plan` is how read-only stages run.
- Skills: `.opencode/skills`. Context file: `AGENTS.md`.
