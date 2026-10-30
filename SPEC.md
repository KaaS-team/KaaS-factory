<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: E4 Supervisor
Milestone: Phase 2 modular core
Runner: factory

## Risk: low

## Why
Two cloud runs in the first wave started against repos that lacked the files their plan edits, and one was refused at push because the run's token could not write what the plan created. Each sat unreported for hours. This issue adds the pure core of the supervisor in a new `src/supervisor/` module: a preflight that says, before launch, why a run would fail, and a heartbeat that says, from push time and session age, whether a launched run is on track, stale or finished. Every verdict is a plain sentence with the next step. All I/O is injected, so the tests need no network. Nothing calls the module yet.

## Today
- `src/engine/import-plan.ts` (237 lines): `parsePlannedIssue(body)` (`:143`) returns a `PlannedIssue` (`:32`) whose `files` (`:39`) is `{ path: string; isNew: boolean }[]` and whose `meta` (`:42`) is an `IssueMeta` with `deps: number[]` (`src/core/schedule.ts:6`).
- `src/blockers.ts:31` `blockerIsClear` treats an issue as done when `state === "CLOSED"` and `stateReason !== "NOT_PLANNED"`; it is not exported, and an issue it cannot fetch counts as open.
- `template/.claude/settings.json` denies `Bash(git push*)`, which also blocks the plain `git push origin factory/issue-N` a cloud session needs; a repo that keeps that rule rejects every cloud run at push.
- `src/stale-pr.ts` is the one place that turns a quiet time into an inbox sentence; it works in days and on pull requests, not on running sessions.
- Nothing checks a plan against its target repo before a run starts, and nothing watches a launched cloud session. There is no `src/supervisor/` directory.
- `tests/quality.test.ts` keeps new files under 400 lines with comment runs of 3 lines or fewer.

## Change
### T1: preflight
Files: `src/supervisor/preflight.ts`, `tests/supervisor-preflight.test.ts`
Model: sonnet
1. `src/supervisor/preflight.ts` exports `interface PreflightIo { fileExists(path: string): Promise<boolean>; issueDone(issue: number): Promise<boolean>; branchExists(branch: string): Promise<boolean>; readFile(path: string): Promise<string | null> }`. Every method reads the target repo's default branch. `issueDone` follows the `blockerIsClear` rule: closed and not `NOT_PLANNED`, and an issue it cannot fetch is not done.
2. It exports `interface PreflightFacts { missing: string[]; openDeps: number[]; branchTaken: boolean; settings: string | null }` and `gatherFacts(plan: PlannedIssue, branch: string, io: PreflightIo): Promise<PreflightFacts>`, which asks `io.fileExists` for every `plan.files` entry with `isNew: false`, `io.issueDone` for every `plan.meta.deps` entry, `io.branchExists(branch)` once and `io.readFile(".claude/settings.json")` once. A rejected `io` call counts as the failing answer (file missing, dep open, branch taken), never as a pass.
3. It exports the pure `preflightProblems(plan: PlannedIssue, facts: PreflightFacts, branch: string): string[]`, one plain sentence per problem with the next step, and `preflight(plan, branch, io): Promise<{ ok: boolean; problems: string[] }>` that chains the two. `ok` is `problems.length === 0`.
4. The five checks, each its own sentence: a missing file ("The plan edits `<path>`, which the repo does not have: fix the Files list or land that file first."); an open dep ("Dep #<n> is not merged yet: wait for it or drop it from Deps."); a taken branch ("Branch `<branch>` already exists: close or delete it before a new run."); a deny rule that blocks plain push ("`.claude/settings.json` denies `<rule>`, which blocks `git push origin <branch>`: narrow it to force pushes only."); a workflow path ("The plan writes `<path>`, which the run's token cannot push: stage it under `ci/` and move it by hand."). Settings that are not valid JSON give one sentence naming the file; a missing settings file is no problem.
5. The workflow check must be written as exactly this line: `export const isWorkflowPath = (path: string): boolean => path.startsWith(".github/workflows/");` It applies to every `plan.files` entry, new or edited, since the token cannot push either.
6. The dep check must hold exactly this line: `const blocked = facts.openDeps.includes(dep);`
7. The push rule check reads `permissions.deny` as strings, keeps each `Bash(<pattern>)` entry (and a bare `Bash`, which denies everything), turns `*` into "any text" and the legacy `:*` suffix into `*`, escapes every other character, and anchors the pattern. It must be written as exactly this line: `` export const deniesPush = (rule: string, branch: string): boolean => bashRule(rule)?.test(`git push origin ${branch}`) ?? false; `` where `bashRule(rule): RegExp | undefined` returns `undefined` for a rule that is not a Bash rule. So `Bash(git push*)` and `Bash(git *)` deny; `Bash(git push --force*)` and `Bash(git push -f*)` do not.
8. The module imports only types from `src/engine/import-plan.ts` and does no I/O of its own.

### T2: heartbeat
Files: `src/supervisor/heartbeat.ts`, `tests/supervisor-heartbeat.test.ts`
Model: sonnet
1. `src/supervisor/heartbeat.ts` exports `STALE_AFTER_MIN = 20`, `type Verdict = "on-track" | "stale" | "finished"`, `interface SessionSnapshot { issue: number; branch: string; startedAt: string; lastPushAt?: string; endedAt?: string; prNumber?: number }` (ISO times) and `heartbeat(s: SessionSnapshot, now: number, staleAfterMin = STALE_AFTER_MIN): { verdict: Verdict; sentence: string }`. It is pure: no clock, no I/O.
2. Finished: `endedAt` is set or `prNumber` is set. With a pull request the sentence names it and says to review it; ended with a push and no pull request says to open one from the branch; ended with no push says to read the session log and relaunch.
3. Stale: no push yet and the session is at least `staleAfterMin` minutes old. The check must be written as exactly this line: `const stale = !s.lastPushAt && now - started >= staleAfterMin * MINUTE;` where `started` is `Date.parse(s.startedAt)` and `MINUTE` is `60_000`. The sentence gives the minutes since start and says to open the session and either nudge it or stop it and relaunch.
4. On track: everything else. The sentence gives the minutes since start and since the last push, or says no push is due yet.
5. A `startedAt` that does not parse gives verdict `stale` with a sentence saying the start time is unreadable, never a throw and never `on-track`.
6. Every sentence starts with `Issue #<issue> (`<branch>`)`, uses whole minutes and holds no model name, token or host.

## Tests
- `tests/supervisor-preflight.test.ts`: [permanent] a fake `PreflightIo` built from in-memory sets; a clean plan passes; each of the five checks fails alone with its sentence; a rejected `io` call fails the check it serves; `Bash(git push*)`, `Bash(git *)`, `Bash(git push:*)` and bare `Bash` deny while `Bash(git push --force*)` and `Bash(git push -f*)` do not; a new `.github/workflows/x.yml` and an edited one both fail; invalid settings JSON gives one problem; a missing settings file gives none.
- `tests/supervisor-heartbeat.test.ts`: [permanent] with a fixed `now`: 5 minutes and no push is on track; 21 minutes and no push is stale; 21 minutes with a push at minute 8 is on track; `prNumber` set is finished and names the pull request; `endedAt` with no push is finished and says relaunch; an unreadable `startedAt` is stale; every sentence starts with the issue and branch.

## Mutation
```json
{"name":"supervisor preflight: workflow path never flagged","file":"src/supervisor/preflight.ts","find":"export const isWorkflowPath = (path: string): boolean => path.startsWith(\".github/workflows/\");","replace":"export const isWorkflowPath = (path: string): boolean => false;","test":"tests/supervisor-preflight.test.ts"}
```
```json
{"name":"supervisor preflight: open dep passes","file":"src/supervisor/preflight.ts","find":"const blocked = facts.openDeps.includes(dep);","replace":"const blocked = false;","test":"tests/supervisor-preflight.test.ts"}
```
```json
{"name":"supervisor preflight: push deny rule ignored","file":"src/supervisor/preflight.ts","find":"export const deniesPush = (rule: string, branch: string): boolean => bashRule(rule)?.test(`git push origin ${branch}`) ?? false;","replace":"export const deniesPush = (rule: string, branch: string): boolean => false;","test":"tests/supervisor-preflight.test.ts"}
```
```json
{"name":"supervisor heartbeat: silent session on track","file":"src/supervisor/heartbeat.ts","find":"const stale = !s.lastPushAt && now - started >= staleAfterMin * MINUTE;","replace":"const stale = false;","test":"tests/supervisor-heartbeat.test.ts"}
```

## Acceptance
- AC-1: preflight names a missing file, an open dep, a taken branch, a push deny rule and a workflow path, each in a plain sentence, and passes a clean plan: checked by `tests/supervisor-preflight.test.ts` (T1)
- AC-2: heartbeat calls a silent session stale after 20 minutes, a pushing one on track and an ended one finished, each in a plain sentence: checked by `tests/supervisor-heartbeat.test.ts` (T2)

## Non-goals
- NG-1: no CLI command, no runner, watcher, dispatch or config change; wiring preflight before dispatch and the heartbeat on an interval is a later issue.
- NG-2: no GitHub-backed `PreflightIo` and no session poller; both land with the wiring.
- NG-3: no owner digest (item 3 of #324) and no blocker filing; the verdict sentences are what those will send.
- NG-4: no edit to `src/blockers.ts`, `src/config.ts`, `src/state.ts`, `src/engine/common.ts`, `scripts/check-mutations.ts` or `scripts/mutation-select.ts`.
- NG-5: no new dependency.

## Files
- `src/supervisor/preflight.ts` (new)
- `src/supervisor/heartbeat.ts` (new)
- `tests/supervisor-preflight.test.ts` (new)
- `tests/supervisor-heartbeat.test.ts` (new)
- `tests/mutations.json` (edit: append the four entries)
