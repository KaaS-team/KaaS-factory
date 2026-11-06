# Default skills harness

The X0a research note (skills-harness) behind this record was lost with its session scratchpad.
This record is written from the code as it stands on release/v6.4.0, so it states what was
decided, not the evidence weighed at the time.

## Failure

A repo with no `.claude` config had no stage skills, so a stage had nothing to follow. A stage
that edited a skill in its worktree could also change what the next stage read, and that edit
could ride into the PR.

## Decision

1. The factory ships one skill per stage and two subagents in `template/.claude/`:
   `factory-triage`, `factory-plan`, `factory-plan-rubric`, `factory-build`, `factory-verify`,
   `factory-pr`, `factory-retro`, `factory-comment`, `factory-operator`, `factory-architecture`,
   and the `factory-reviewer` and `factory-plan-critic` subagents.
2. Before every stage, `provideDefaults` in `src/harness-defaults.ts` copies each of them to
   where the agent reads it. The repo's copy under `.claude/` or `.agents/` wins, but only when git
   tracks it and it is unchanged since `HEAD`. A file a stage wrote is the agent's, never the
   repo's.
3. What is provided replaces whatever was there, so an edit one stage made never reaches the
   next. Each provided path goes into `.git/info/exclude`, so no PR carries it.
4. The copy must resolve inside the worktree. A link at the target is removed, not followed, and
   links inside the source are not copied.

## Where in the code

- `src/harness-defaults.ts`: `resolveSkill`, `resolveSubagent`, `provideDefaults`.
- `tests/harness-defaults.test.ts`: a repo with no config ships an issue on the defaults, the
  repo's committed copy wins, a stage's edit never reaches the next stage, a planted link never
  sends a copy outside the worktree.
