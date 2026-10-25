# Stage shell shapes under dontAsk

## Failure

Every splitbill-demo issue that reached verify (#46, #47, #48, #73, #74, #75, #76) lost
rounds to refused Bash calls: 16 verify runs for 7 builds. The verifier wrote reverts as
`git show main:f > f` or `git checkout main -- f && git status && bun test`, and saved gate
output with `make check > /tmp/x.log 2>&1; echo exit=$?`. The CLI answered "Permission to use
Bash has been denied because Claude Code is running in don't ask mode", and agents read that
as "Bash is denied", not "this command is denied".

`STAGE_GUIDANCE` reached only the main agent through `--append-system-prompt`. Subagents never
saw it, and claude 2.1.289 has no `--append-subagent-system-prompt`.

## Measurement

claude 2.1.289, `--permission-mode dontAsk`, verify-stage settings, a scratch clone, main
agent and a subagent each running the commands below. Cost: $0.17 for both runs.

| Shape | Result |
|---|---|
| `a && b`, `a; b`, `a \| b` with every part allowed | allowed |
| `2>&1`, `> /dev/null` | allowed |
| `git restore --source=main -- f`, `git checkout main -- f` | allowed |
| `> file`, `>> file`, `2>file` | refused |
| `$(...)`, backticks, `$?` | refused |
| brace expansion `{a,b}` | refused |
| leading `cd` | refused |
| leading `VAR=value` | refused |

Subagents ran simple allowed commands, so the #73 "denied entirely" line came from one refused
command, not a subagent-wide denial.

Two other findings from the same runs:
- Without `--strict-mcp-config`, stages loaded the operator's claude.ai connectors (Gmail,
  Drive, Calendar). With it, `mcp_servers` is empty.
- A PreToolUse hook that exits 2 lands in the result's `permission_denials` like a dontAsk
  refusal, so the runner's `denied` transcript lines count both ($0.02 run).
- `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` leaves ScheduleWakeup, Cron and Monitor in the tool
  list. `--disallowedTools` removes them (29 tools down to 22).

## Decision

1. `STAGE_GUIDANCE` states the measured shapes and the fix for each.
2. Every template agent body carries it verbatim; `tests/skills.test.ts` pins that.
3. `guard-paths.sh` refuses the same shapes when `FACTORY_STAGE` is set, with a message that
   says Bash still works. Subagents see hook feedback. It masks quoted text first, and checks
   `cd` and `VAR=` at the start of every part split by `&&`, `||`, `;`, `|`, `&` or a newline,
   inside `(...)` and `{ ...; }` and after `env`, `if` or `!`, since each part is its own
   command. Comments and heredoc bodies are masked like quotes. Left as is, unmeasured: a quoted
   `"/dev/null"` target and `$((...))` are refused; `<(...)`, `<<` inside `((...))`, `cd` after a
   `case` pattern and a quoted command word such as `"cd"` pass. dontAsk still refuses those.
   Contrived forms no transcript shows also pass the hook, unmeasured against dontAsk: an
   escaped space before `#`, backslash-newline inside `$(` or `cd`, a redirect before the
   command word, `eval`, functions, array assignments and heredoc delimiters with spaces.
   The merge and force-push check runs in every session. Four review rounds each found a new
   way past an argv parser (wrappers, `sh -lc`, heredocs fed to a shell, `$(...)`), so it
   reads the text instead: quotes, backslashes, continuations and redirects removed, split at
   separators, parentheses and backticks, and read from every `git` or `gh` word to the next
   (one that is the value of `-C` or `-R` is not a start). `push --mirror` counts as a force. So
   `git merge-base` and `--grep='git merge'` pass, while `grep "git merge" f` and
   `echo git push -f` are refused. `gh api .../merge` passes the hook; settings deny `Bash(gh *)`.
   A hidden git word (`$(which git) merge`, `${GIT:-git} merge`) and `git pull` also pass; inside
   a stage dontAsk refuses the first two, and `git pull` is not on any stage allow-list.
   The verifier also stays on the verify allow-list: it reads `gate.json`, never runs the gates.
4. `factory-verify` re-dispatches the verifier once after a refused command.
5. The claude preset passes `--strict-mcp-config` and `--disallowedTools STAGE_DISALLOWED_TOOLS`.
6. `git checkout <ref> -- f` stages the file, so a later worktree-only restore leaves the index
   dirty. The verifier uses `git restore --source=<base>` to revert and `--source=HEAD` to
   restore, which leaves the index alone.

## Dropped

- The background-tasks env var: measured not to remove the tools.
- Failing a stage on init `plugin_errors` or `mcp_server_errors`: the 2.1.289 init event has
  neither field.
- A separate `guard-bash-shape.sh`: the check lives in `guard-paths.sh`, which already reads
  every Bash call.
