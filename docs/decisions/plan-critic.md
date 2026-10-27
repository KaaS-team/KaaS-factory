# Plan critic (#89)

## Failure

On 26 Oct 2026 most extra rounds came from plans build could not carry out. kaas.team#5, #6 and
lwp-academy#7 named `node --test` as an AC's check; `node` is refused as an agentCommand (it runs
other code), so build was denied, stopped, and every retry re-ran plan. englishmaa#4 pinned a
version inside the repo's release-age cooldown, then kept a version the operator had replaced.
kaas.team#7 parked for an edit the repo's SAST gate required.

## Decision

Two halves, the cheapest that covers each checklist item.

- **Mechanical, in the runner** (`src/engine/plan-critic.ts`): before a plan posts, every AC must
  end with "checked by" and a backticked test or command, a test-proof plan names a test first,
  and every command after "checked by" must match the build or verify allow-list, part by part
  (`bashAllowed`, the matcher `tests/stage-permissions.test.ts` uses). A leading `cd` or `VAR=`
  fails because no rule starts with one. Must-fix items send the plan back once, on a fork of its
  session, so the second pass reads from cache. Still wrong after that, the plan posts with the
  open items and waits for `/factory approve`, never auto-approved. No model call.
- **Judgment, inside the plan skill**: `factory-plan-critic`, one Sonnet subagent with Read, Grep
  and Glob, checks three items only: each AC traces to the newest word on the issue, pinned
  versions respect the repo's cooldown and advisory floors, and edits a repo gate needs are named.
  The plan skill dispatches it once and fixes what it returns. A cooldown has no common place a
  runner could read (npm, pnpm, bun and repo scripts each keep their own), so item 2 stays here.

Left out: checking publish dates against a registry (needs network in the runner), and the shell
shapes `guard-paths.sh` refuses beyond a leading `cd` or `VAR=` (one definition, the hook).

## Measure

Rounds per issue from `stage_runs`, before and after. needs-human and question rounds are not in
`stage_runs`; a question shows as a rebuild or a plan revision.

```sql
select issue, sum(stage='plan')-1 as plan_revisions, sum(stage='build')-1 as rebuilds,
  coalesce(sum(verdict='reject'),0) as rejects,
  sum(stage='plan')-1 + sum(stage='build')-1 + coalesce(sum(verdict='reject'),0) as rounds
from stage_runs where stage in ('plan','build','verify')
group by issue having sum(stage='plan') > 0 order by issue;
```

Before, 26 Oct 2026: englishmaa #4 5, #5 1, #6 8; kaas.team #5 9, #6 6, #7 1, #8 4;
lwp-academy #7 3, #8 2.
