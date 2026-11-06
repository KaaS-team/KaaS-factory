# Stage harness design

The X0b research note (harness-design) behind this record was lost with its session scratchpad.
This record is written from the code as it stands on release/v6.4.0, so it states what was
decided, not the evidence weighed at the time.

## Failure

An agent stage that can push, merge or call `gh` can ship work no gate has seen. Every tool
definition a stage loads also rides every turn's input, so unused tools cost tokens on each call.

## Decision

1. The agent edits the worktree and writes its artifact. The runner alone commits, pushes and
   talks to GitHub. `template/.claude/settings.json` denies `gh`, `git push`, `git merge`, a hard
   reset and reads of `~/.config/gh`, `~/.ssh` and `.env` files.
2. `template/.claude/hooks/guard-paths.sh` runs before every edit, read, shell, agent and search
   call. It refuses writes to protected paths, merges, force-pushes, the shell shapes the stage's
   permission mode refuses and reads of paths the runner hides. Writes to `.factory/runs/**`
   always pass, since that is where a stage hands back its output.
3. Each stage loads only the tools it uses (`STAGE_TOOLS` in `src/stage-permissions.ts`): Bash,
   Read, Write and Skill for all, Edit for build and verify, Agent for plan and verify. Scheduling,
   messaging, worktree and workflow tools are never loaded (`STAGE_DISALLOWED_TOOLS`).
4. Each stage's shell commands come from an allow-list (`stageAllowRules`), and the repo's own
   commands come from `agentCommands` in its config, so nothing assumes bun or make.
5. Stop and post-edit hooks check the artifact and the verifier's evidence; see
   [stage-stop-hooks.md](stage-stop-hooks.md).

## Where in the code

- `template/.claude/settings.json`, `template/.claude/hooks/guard-paths.sh`.
- `src/stage-permissions.ts`: `STAGE_TOOLS`, `STAGE_DISALLOWED_TOOLS`, `stageAllowRules`.
- `tests/guard-hook.test.ts`, `tests/stage-permissions.test.ts`.
