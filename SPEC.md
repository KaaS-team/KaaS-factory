<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: E1 Finish reliability
Milestone: Phase 1 reliability
Runner: operator

## Risk: medium

## Why
Two plan-stage slices of the reliability runner. R1b: when the plan step runs again for an issue whose body has not changed since the last plan (a retry, a resumed run, a wiped workspace), the runner pays for a whole new plan and can post a different one; it should reuse the plan already on the thread. R4b (#156): after the model-free plan checks pass, one rubric pass should grade the plan for intent coverage, scope creep, a verify step per task, a risk and an estimate, send it back for at most one revision, and keep the rubric's reasons as pending lessons.

## Today
- `src/engine/plan-critic.ts` (216 lines). `attempt()` (171-190) runs the plan stage through `runStage`, reads the artifacts, floors the JSON with `flooredPlan` and collects `mustFix` from `planMustFix` and `critiquePlan`. `checkedPlan()` (194-216) runs `attempt` once, and when `mustFix` is non-empty runs it once more on a fork of the plan session (`deps.state.lastSession(config.repo, issue.number, "plan")?.session_id`), then posts what is still open with `autoApproveEligible: false`.
- `src/engine/steps.ts:155-177` (the `plan` step) calls `checkedPlan(deps, config, issue, worktree, stepOpts(step))` and posts `art.comment` with `{ stage: "plan", json }`, so the thread's latest plan data marker is the JSON `checkedPlan` returned. This spec does not touch `steps.ts`.
- `planOf(issue)` (`src/engine/common.ts:314`) returns the latest trusted plan data marker's JSON. `sha256(text)` is exported from `src/engine/import-plan.ts:49`, and `planFromIssue` already stamps `bodyHash: sha256(issue.body)` on plans imported from a planned issue (`import-plan.ts:232`); the plan schema in `src/schemas.ts` already allows `bodyHash`. A plan written by the planner carries no `bodyHash`, and the `PlanArtifact` TypeScript type has no `bodyHash` field.
- `isHumanComment` and `parseChatOps` (`src/chatops.ts`) tell a trusted human comment from a runner comment and parse `/factory approve|revise|retry|cancel`.
- `runStage(deps, config, issue, stage, worktree, extra)` rehydrates the run dir, then clears the stage's own artifacts (`plan-comment.md`, `plan.json`, `question-comment.md` for `plan`) before the agent runs, and records a stage run and its spend. `extra.prompt` replaces the stage's skill command. `src/engine/minion.ts` strips SKILL.md frontmatter with `skillBody.replace(/^---\n[\s\S]*?\n---\n/, "").trim()`.
- `resolveSkill(cwd, name)` (`src/harness-defaults.ts:48`) returns `source: "repo"` only for a SKILL.md that is committed and unchanged in the worktree; otherwise it returns the template copy with `source: "default"`. `provideDefaults` copies template skills into a worktree uncommitted, so they stay `"default"`.
- Pending lessons are `retros` rows with `status = 'done'`, a `lesson` and no `learned_at` (`FactoryState.pendingLessons`, `src/state.ts:582`). `queueRetro(repo, issue, outcome: RetroTrigger)` and `completeRetro(id, { lesson })` write them. `RetroTrigger` (`src/state.ts:15`) is `"merged" | "rejected" | "gave-up"`. `src/state.ts` is frozen at 746 lines in `quality-baseline.json`.
- `tests/mutations.json` has entries whose `find` text in `plan-critic.ts` must keep matching exactly once: `  if (!run.mustFix.length) return run;`, `json: { ...run.parsed.json, autoApproveEligible: false } },`, `  const problems = deterministicCritique(input);`, `    if (!spans.length) {`, `        if (!bashAllowed(allow, part))`, ``tests !== undefined && !/`[^`]+`/.test(tests))``.
- `tests/plan-critic.test.ts` "a revision that is still wrong posts with the open items and waits for a human" queues exactly two plan outputs; `MultiStageExecutor` (`tests/harness.ts:459`) throws when a stage runs with no queued output.

## Change
### T1: reuse the plan when the issue body is unchanged
Files: `src/engine/plan-reuse.ts`, `src/engine/plan-critic.ts`, `tests/plan-reuse.test.ts`, `tests/mutations.json`
Model: sonnet
1. Create `src/engine/plan-reuse.ts`. It exports `type HashedPlan = PlanArtifact & { readonly bodyHash?: string }` and these functions:
   - `reusablePlan(issue: GhIssue): { json: HashedPlan; comment: string } | undefined`. Walk `issue.comments` from the newest, considering only `isTrusted` comments, and take the first whose `parseDataMarkers([c])` has a `plan` marker. Return undefined when there is none, when `stepStop(json)` is set, when `json.status === "needs-info"`, or when any comment after it is an `isHumanComment` whose `parseChatOps(body).type` is not `"approve"` (a revise, a retry, a cancel or an answer asks for a new plan). The hash check is this exact line: `if (json.bodyHash !== sha256(issue.body)) return undefined;`. `comment` is the plan comment's body with its trailing data marker removed (`body.replace(/\n*<!-- factory:data \{.*?\} -->\s*$/s, "").trimEnd()`).
   - `stampBodyHash<T extends { json?: PlanArtifact }>(parsed: T, issue: GhIssue): T` returns `parsed` unchanged when it has no `json`, else `{ ...parsed, json: { ...parsed.json, bodyHash: sha256(issue.body) } as HashedPlan }`.
   - `reusedPlan(worktree: string, issueNumber: number, prior: { json: HashedPlan; comment: string })`: writes `plan.json` (pretty JSON) and `plan-comment.md` (the prior comment) into `<worktree>/<runDir(issueNumber)>/`, creating the dir, and returns a `CheckedPlan` with `result` a zero run (`{ exitCode: 0, events: [], toolCalls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, costReported: true, permissionDenials: [] }`, typed as `CheckedPlan["result"]`), `comment` the prior comment followed by `\n\n_Plan reused: the issue body is unchanged since this plan was written._`, and `parsed: { json: prior.json }`.
   Import `CheckedPlan` as a type from `./plan-critic`.
2. In `src/engine/plan-critic.ts`:
   - At the top of `checkedPlan`, before the first `attempt`, add: `const prior = opts.resume ? undefined : reusablePlan(issue);` and `if (prior) return reusedPlan(worktree, issue.number, prior);`.
   - In `attempt`, return `parsed: stampBodyHash(parsed, issue)` instead of `parsed`, so every plan the runner posts carries the hash of the body it was planned from. Leave the `mustFix` computation reading the unstamped `json`.
   - Keep every `find` text listed under Today unchanged.
3. Create `tests/plan-reuse.test.ts` using `engine()` from `tests/engine-harness.ts` and the `feature-to-pr.yml` workflow the way `tests/plan-critic.test.ts:92-102` loads it. Seed the issue's comments with a trusted (`OWNER`) runner plan comment built with `withDataMarker` from `src/engine/common.ts`. Tests:
   - a plan marker whose `bodyHash` equals `sha256(issue.body)`: the run makes no plan stage run (`executor.pinned` has no `plan` entry), and the posted plan comment contains "Plan reused" and the prior plan's text;
   - the same marker after the issue body changes: one plan stage run;
   - the same marker followed by a trusted `/factory revise tighten AC-1` comment: one plan stage run;
   - a planner run with no prior marker: the posted plan data marker has `bodyHash` equal to `sha256(issue.body)`;
   - unit tests of `reusablePlan` for an untrusted marker (ignored) and a `needs-info` plan (not reused).
4. Add the T1 entries under Mutation to `tests/mutations.json`, directly after the entry named "plan critic: skip the deterministic step".

### T2: one rubric pass, at most one revision, reasons kept as lessons
Files: `src/engine/plan-rubric.ts`, `src/engine/plan-critic.ts`, `src/state.ts`, `tests/plan-rubric.test.ts`, `tests/mutations.json`
Model: sonnet
Deps: T1
1. `src/state.ts:15`: add `"plan-rubric"` to `RetroTrigger` on the same line, so the file stays 746 lines.
2. Create `src/engine/plan-rubric.ts`. It exports `const RUBRIC_SKILL = "factory-plan-rubric"`, `interface RubricVerdict { verdict: "pass" | "revise"; reasons: string[] }`, and:
   - `parseRubric(raw: unknown): RubricVerdict | undefined`: an object whose `verdict` is `"pass"` or `"revise"` and whose `reasons` is an array of strings, else undefined.
   - `rubricPrompt(skill: string, issueNumber: number, comment: string, plan: object): string`: the skill body with its frontmatter stripped (the `minion.ts` regex), then `## Plan comment` with the comment, then `## plan.json` with the JSON in a json code block, then one line telling the agent to write only `.factory/runs/issue-<N>/plan-rubric.json` as `{"verdict": "pass" | "revise", "reasons": [...]}` (use `runDir(issueNumber)`).
   - `async planRubric(deps, config, issue, worktree, run: CheckedPlan & { mustFix: string[] }, opts): Promise<string[]>`. Return `[]` unless `run.result.exitCode === 0`, `run.parsed.json` is set, `!stepStop(run.parsed.json)`, `run.parsed.json.status !== "needs-info"`, `run.comment` is set and `run.mustFix` is empty. Then this exact line: `if (resolveSkill(worktree, RUBRIC_SKILL)?.source !== "repo") return [];`. Run `runStage(deps, config, issue, "plan", worktree, { ...opts, prompt: rubricPrompt(...) })` once. Because `runStage` cleared the plan's own files, write `plan.json` and `plan-comment.md` back from `run.parsed.json` and `run.comment` straight after it, whatever the rubric did. Read and parse `plan-rubric.json`; on a missing file, invalid JSON, a non-zero exit, or `pass`, return `[]` (the rubric fails open). On `revise` with at least one reason, store the reasons with this exact line: `deps.state.completeRetro(deps.state.queueRetro(config.repo, issue.number, "plan-rubric"), { lesson });` where `lesson` is the reasons joined as `- <reason>` lines under `Plan rubric for #<N>:`, then return the reasons prefixed `Plan rubric: `.
3. In `src/engine/plan-critic.ts` `checkedPlan`, after the first `attempt` and before `  if (!run.mustFix.length) return run;`:
   - capture `const sessionId = deps.state.lastSession(config.repo, issue.number, "plan")?.session_id;` here (move the existing line up; the rubric's own stage run must not become the session the revision forks);
   - `run = { ...run, mustFix: [...run.mustFix, ...(await planRubric(deps, config, issue, worktree, run, opts))] };`.
   Then replace the single revision with a bounded loop, keeping `  if (!run.mustFix.length) return run;` before it and the "still open" return after it unchanged: add module constant `const MAX_REVISIONS = 1;` with a comment that the plan is sent back at most once (#156), and loop `for (let round = 0; round < MAX_REVISIONS && run.mustFix.length; round += 1)` around the existing `sendBack` and `attempt(... resume: { ...(sessionId ? { sessionId } : {}), failure })` lines. The rubric never runs inside the loop.
4. Create `tests/plan-rubric.test.ts`. Use a `FakeGit` subclass whose `ensureWorktree` calls `super`, then writes `.claude/skills/factory-plan-rubric/SKILL.md` and commits it with `git init -q`, `git add -A` and `git -c user.name=t -c user.email=t@t commit -qm seed` in the worktree, and pass it as `engine(..., { git }, ...)`. The rubric's output is the plan stage's next queued output, with `plan-rubric.json` as the file. Tests:
   - rubric `pass`: two plan stage runs in all (plan, rubric), the plan posts, no pending lesson;
   - rubric `revise` with two reasons, revision clean: three plan stage runs (plan, rubric, revision), the revision's resume failure text contains both reasons and forks the first plan run's session, and `deps.state.pendingLessons("acme/repo")` (use the config's repo) has one row whose lesson names both reasons;
   - rubric `revise` and a revision that still fails a model-free check: exactly three plan stage runs, the issue ends at `awaiting-approval`, and the comment has "### Plan check: still open" (a second revision would need a fourth queued output, and `MultiStageExecutor` throws);
   - rubric output missing or invalid: the plan posts unchanged with no revision;
   - skill present but not committed: no rubric run.
5. Add the T2 entries under Mutation to `tests/mutations.json`, after the T1 entries.

### T3: the rubric skill
Files: `template/.claude/skills/factory-plan-rubric/SKILL.md`
Model: haiku
Deps: T2
1. Create `template/.claude/skills/factory-plan-rubric/SKILL.md` with exactly this text (the frontmatter has only `name` and `description`; the description is a plain scalar under 300 characters with no `: ` and no angle brackets; the skill names no stack tool):
```
---
name: factory-plan-rubric
description: Grades a written plan comment and plan.json against five checks before the plan posts, and writes a pass or revise verdict with one reason per failed check. The runner runs it once per plan.
---

# factory-plan-rubric

You read one plan that is already written and grade it. Change no file except the verdict file the prompt names.

## The five checks

1. Intent: every outcome the issue asks for is covered by a task or an acceptance criterion.
2. Scope: no task or file goes beyond what the issue asks for.
3. Verify step: every task has an acceptance criterion whose check names a test or a command.
4. Risk: the plan sets a risk level.
5. Estimate: the plan states its size or its cost estimate.

## Output

Write the verdict file as one JSON object: `{"verdict": "pass", "reasons": []}`.

- `pass`, with an empty `reasons` list, when all five checks hold.
- `revise`, with one reason per failed check, each one sentence naming the check and what to change.

Grade only what the plan says. Do not rewrite the plan.
```

## Tests
- `tests/plan-reuse.test.ts`: [permanent] an unchanged body reuses the thread's plan with no plan run; a changed body, a revise or retry after the plan, or no prior plan runs the planner; every new plan carries `bodyHash`.
- `tests/plan-rubric.test.ts`: [permanent] the rubric runs once only when the repo commits its skill, a revise sends the plan back at most once on the original plan session, reasons become one pending lesson, and a missing or invalid rubric output fails open.
- `tests/plan-critic.test.ts`: [permanent] existing; the deterministic send-back still happens once.
- `tests/skills.test.ts`, `tests/app-agnostic.test.ts`: [permanent] existing; the new template skill passes the frontmatter, length and stack-tool rules.
- `tests/quality.test.ts`: [permanent] existing; `src/state.ts` stays at its baseline.

## Mutation
```json
{"name": "plan reuse: a changed body still reuses the plan", "file": "src/engine/plan-reuse.ts", "find": "if (json.bodyHash !== sha256(issue.body)) return undefined;", "replace": "", "test": "tests/plan-reuse.test.ts"}
```
```json
{"name": "plan reuse: a revise after the plan is ignored", "file": "src/engine/plan-reuse.ts", "find": "parseChatOps(c.body).type !== \"approve\"", "replace": "false", "test": "tests/plan-reuse.test.ts"}
```
```json
{"name": "plan rubric: allow two revise rounds", "file": "src/engine/plan-critic.ts", "find": "const MAX_REVISIONS = 1;", "replace": "const MAX_REVISIONS = 2;", "test": "tests/plan-rubric.test.ts"}
```
```json
{"name": "plan rubric: reasons are not kept as lessons", "file": "src/engine/plan-rubric.ts", "find": "deps.state.completeRetro(deps.state.queueRetro(config.repo, issue.number, \"plan-rubric\"), { lesson });", "replace": "", "test": "tests/plan-rubric.test.ts"}
```
```json
{"name": "plan rubric: runs without a committed skill", "file": "src/engine/plan-rubric.ts", "find": "if (resolveSkill(worktree, RUBRIC_SKILL)?.source !== \"repo\") return [];", "replace": "", "test": "tests/plan-rubric.test.ts"}
```
The second entry's `find` assumes `reusablePlan` writes the comment check as `parseChatOps(c.body).type !== "approve"` with the loop variable named `c`; write it that way.

## Acceptance
- AC-1: a plan step on an issue whose body is unchanged since its last plan reuses that plan with no plan run, and any other case plans afresh: checked by `make test FILES=tests/plan-reuse.test.ts` (T1)
- AC-2: the model-free send-back still happens once: checked by `make test FILES=tests/plan-critic.test.ts` (T1)
- AC-3: the rubric runs once, sends a plan back at most once, and keeps its reasons as pending lessons: checked by `make test FILES=tests/plan-rubric.test.ts` (T2)
- AC-4: `src/state.ts` keeps its frozen size: checked by `make test FILES=tests/quality.test.ts` (T2)
- AC-5: the rubric skill passes the template skill rules: checked by `make test FILES="tests/skills.test.ts tests/app-agnostic.test.ts"` (T3)
- AC-6: the types still check: checked by `make typecheck` (T2)

## Non-goals
- NG-1: no change to `src/engine/steps.ts`, `src/artifacts.ts`, `src/schemas.ts` or `src/rehydrate.ts`; reuse and the rubric live behind `checkedPlan`.
- NG-2: no config toggle for the rubric; a repo opts in by committing `.claude/skills/factory-plan-rubric/SKILL.md`, which `factory install` does with the rest of the template.
- NG-3: the rubric never runs on a revision, and never on a reused plan.
- NG-4: imported planned-issue plans (`import-plan-step.ts`) are unchanged.
- NG-5: do not touch `.github/workflows`. Keep the PR body to the repo's PR template with its sign-off lines; one PR for this spec; no em dashes in code, comments, the skill or the PR; no file outside Files below.

## Files
- `src/engine/plan-reuse.ts` (new)
- `src/engine/plan-rubric.ts` (new)
- `template/.claude/skills/factory-plan-rubric/SKILL.md` (new)
- `tests/plan-reuse.test.ts` (new)
- `tests/plan-rubric.test.ts` (new)
- `src/engine/plan-critic.ts` (edit: reuse first, `bodyHash` stamp, rubric once, `MAX_REVISIONS` loop)
- `src/state.ts` (edit: `"plan-rubric"` in `RetroTrigger`, same line)
- `tests/mutations.json` (edit: add the five entries)
