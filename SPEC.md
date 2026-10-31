<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: E10.2 Commit and QA quality
Milestone: Phase 10 self-improvement
Runner: operator

## Risk: medium

## Why
A review finding blocks a verdict today on a file and a line alone. #332 asks that a probabilistic finding may block only with evidence a deterministic step can check: the `file:line` it already needs, plus a reproduction (a failing command, input or scenario). It also asks that the model review is never the only pass for auth, security or money paths. #333 asks that the deterministic recheck that filters findings has a labelled calibration set in CI with pinned precision and recall floors, that the PR template states what each layer proved, and that the factory publishes its own monthly numbers: revert rate, escaped-defect rate, judge veto rate, time to green and cost per verified change.

## Today
- `src/artifacts.ts`: `Finding` is `{ severity, confidence, what, where?, why?, fix? }`; `FINDING_KEYS` lists those six and `validateVerdict` refuses any other key. There is no evidence field.
- `src/recheck.ts`: `DiffAnchorRechecker.supported` keeps a finding when its `where` overlaps a changed hunk, with the line `return hunks?.some(([a, b]) => at!.from <= b && at!.to >= a) ? [i] : [];`. `keepSupported` then drops each unsupported must or should finding, and `src/engine/common.ts` line 238 writes the note `The diff does not support N finding(s): none points at a line it changed, so they were dropped:`. `tests/scenarios.test.ts` checks only the text `does not support 1 finding(s)`. `src/engine/common.ts` must stay at exactly 646 lines (`quality-baseline.json`).
- A deterministic red already wins: the runner refuses a `pass` verdict that lists a blocking finding, and a red gate or a proof that does not bite stops the run before any review is read. Nothing in this plan changes that order.
- `src/risk.ts`: `ratedRisk` rates high for migrations, SQL, schema, workflows, lockfiles and Dockerfiles, protected paths and owned packages; `merge-autonomy.ts` never merges a high-risk change on its own. An `auth/`, `security/`, `payments/` or `billing/` path that is not listed in `protectedPaths` rates low. No repo file and no test fixture that expects a low or medium rating matches those names.
- `template/.claude/agents/factory-reviewer.md` (How to report) and `template/.claude/skills/factory-verify/SKILL.md` (the finding JSON shape) list severity, confidence, what, where, why and fix.
- `.github/pull_request_template.md` has Summary, Plan, Gate evidence, Verify verdict, and Risk and rollback; `scripts/check-pr-body.ts` requires every template section; `tests/check-pr-body.test.ts` builds `filled()` from those five and expects five missing sections for a bare body; `CONTRIBUTING.md` lines 11 and 12 name the five.
- `dashboard/ledger-public.ts` exports `mergesIn(state)` and `shippedEntry(merge, run, attempts)` (cycle hours and whole dollars, null when any attempt's cost is unknown). `StageRun.verdict` holds a verify attempt's pass, reject or uncertain. Nothing reports a month.

## Change
### T1: findings carry evidence
Files: `src/artifacts.ts`, `src/recheck.ts`, `tests/recheck.test.ts`, `src/engine/common.ts`, `tests/finding-evidence.test.ts`, `template/.claude/agents/factory-reviewer.md`, `template/.claude/skills/factory-verify/SKILL.md`
Model: sonnet
1. `src/artifacts.ts`: `Finding` gains `readonly evidence?: string;` after `fix`, with the comment above `Finding` extended by one line: `evidence` is the reproduction, a failing command, input or scenario. `FINDING_KEYS` becomes `new Set(["severity", "confidence", "what", "where", "why", "fix", "evidence"])`. In `validateVerdict`, after the `what` check, add exactly `if (o.evidence !== undefined && (typeof o.evidence !== "string" || !o.evidence.trim())) return bad('a finding\'s "evidence" must be a non-empty string');`. A finding with no evidence stays valid: the recheck drops it, the schema does not refuse it.
2. `src/recheck.ts`: the comment above `DiffAnchorRechecker` becomes: supported means `where` names a file in the diff and a line range that overlaps one of its hunks, and `evidence` holds a reproduction; anything else is dropped. In `supported`, before `return`, add `const reproduced = Boolean(f.evidence?.trim());` and the return becomes exactly `return reproduced && hunks?.some(([a, b]) => at!.from <= b && at!.to >= a) ? [i] : [];`.
3. `tests/recheck.test.ts`: the `at` helper gains a second parameter `evidence = "bun test tests/a.test.ts fails"` and spreads `...(evidence ? { evidence } : {})`. The existing test keeps `[0, 1, 2]`. Add a test: `at("src/a.ts:12", "")` and `at("src/a.ts:12", "   ")` are both dropped while `at("src/a.ts:12")` is kept.
4. `src/engine/common.ts` line 238: the note text becomes `` `\n\nThe diff does not support ${dropped.length} finding(s): none points at a changed line with a reproduction, so they were dropped:\n${list}` ``. Same line, no other change; the file stays at 646 lines.
5. `template/.claude/agents/factory-reviewer.md`, How to report: the field list becomes severity, confidence, what, where (file and line), why it matters, the fix, and evidence: the command, input or scenario that shows the failure. Add one sentence after it: a `must` or `should` with no evidence or no changed `file:line` is dropped before the verdict counts, so leave it out. Keep the existing phrases `an issue the diff did not introduce` and `` `CODING_STANDARDS.md` `` word for word.
6. `template/.claude/skills/factory-verify/SKILL.md`: the finding shape becomes `{ "severity": "must|should|could", "confidence": 0-5, "what": "...", "where": "file:line", "why": "...", "fix": "...", "evidence": "..." }`, and the sentence after it adds: a must or should needs `where` on a changed line and `evidence`, or the runner drops it.
7. `tests/finding-evidence.test.ts` asserts the schema and both template files.

### T2: auth, security and money paths rate high
Files: `src/risk.ts`, `tests/risk.test.ts`
Model: haiku
1. `src/risk.ts`: below `HIGH_RISK`, add a two-line comment (a model review is never the only pass for auth, security or money code, so these paths need a human merge) and `const SENSITIVE = /(^|\/)(auth|authn|authz|oauth|security|payments?|billing)(\/|\.[a-z]+$)/;`.
2. In `ratedRisk`, directly after the `risky` reason line, add `const sensitive = paths.filter((p) => SENSITIVE.test(p));` and `if (sensitive.length) reasons.push(\`auth, security or money path: ${sensitive.join(", ")}\`);`. The level rule `reasons.length ? "high" : "low"` already makes it high.
3. `tests/risk.test.ts` gains one test over `ratedRisk` imported from `../src/risk`.

### T3: the calibration set for the recheck
Files: `src/calibration.ts`, `tests/fixtures/judge-calibration/cases.json`, `tests/judge-calibration.test.ts`
Model: sonnet
1. `src/calibration.ts` opens with a three-line comment: a labelled set of review findings scores the step that decides which findings may block; precision and recall below the pinned floors fail CI; a live model judge is not scored here. It exports `PRECISION_FLOOR = 0.9`, `RECALL_FLOOR = 0.9`, `interface CalibrationCase { name: string; finding: Finding; diff: string; real: boolean }`, `interface Score { tp: number; fp: number; fn: number; tn: number; precision: number; recall: number; wrong: string[] }` and `scoreRechecker(cases, rechecker = new DiffAnchorRechecker()): Promise<Score>`.
2. `scoreRechecker` asks the rechecker about one finding per case, with exactly `const kept = (await rechecker.supported([c.finding], c.diff)).includes(0);`, counts the four cells against `c.real`, lists the names of the wrong cases, and computes `precision = tp / (tp + fp)` and `recall = tp / (tp + fn)`, each 1 when its denominator is 0.
3. `tests/fixtures/judge-calibration/cases.json` is a JSON array of at least 12 cases, each `diff` a small unified diff as one string. Label as real (6 or more): a finding inside an added hunk with evidence; one on a range overlapping a hunk; one in a new file; one with a `./` prefix and trailing prose in `where`; two more in varied files. Label as not real (6 or more): outside every hunk; a file the diff never touched; no line in `where`; no `where`; inside a hunk but with no evidence; on a deleted file. Every case's label is what a human reviewer would say, not what the rechecker happens to return.
4. `tests/judge-calibration.test.ts` loads the cases, scores them, and asserts the floors.

### T4: the confidence block in the PR template
Files: `.github/pull_request_template.md`, `tests/check-pr-body.test.ts`, `CONTRIBUTING.md`
Model: haiku
1. `.github/pull_request_template.md` gains, between `## Verify verdict` and `## Risk and rollback`, a `## Confidence` section whose comment says: one row per layer, what it proved for this change, or `not run` and why. Under the comment, a Markdown table with the header `| Layer | What it proved |` and five rows whose first cells are `Gate`, `Proof (fails on base)`, `Changed-line mutants`, `Review findings with evidence` and `UI preview and smoke`, the second cell empty.
2. `tests/check-pr-body.test.ts`: `filled()` gains `Confidence: "| Gate | make check green |"` between `Verify verdict` and `Risk and rollback`, and the bare-body test expects six missing sections.
3. `CONTRIBUTING.md` line 11 and 12: the list becomes Summary, Plan, Gate evidence, Verify verdict, Confidence, Risk and rollback.

### T5: the monthly metrics page
Files: `dashboard/metrics-month.ts`, `scripts/metrics-month.ts`, `tests/metrics-month.test.ts`
Model: sonnet
1. `dashboard/metrics-month.ts` opens with a two-line comment: the factory's own numbers for one calendar month (UTC), from the state DB plus two counts read from GitHub; a rate with no denominator is `null`, never 0. It exports `interface MonthCounts { reverts: number; escaped: number }`, `interface MonthMetrics { month: string; merged: number; medianCycleHours: number | null; costPerVerifiedChange: number | null; judgeVetoRate: number | null; revertRate: number | null; escapedDefectRate: number | null }`, `monthMetrics(sources, month, counts)` and `metricsMarkdown(m)`.
2. `sources` is `readonly { state: FactoryState; repo: string }[]`; `month` is `YYYY-MM`. `merged` is the merges from `mergesIn(state)` whose `at` starts with the month, across sources. Each merge's entry comes from `shippedEntry(merge, state.getRun(merge.repo, merge.issue), state.listStageRuns(merge.repo, { issue: merge.issue, limit: 10_000 }))`. `medianCycleHours` is the median of their `cycleHours`. `costPerVerifiedChange` is the sum of the non-null `dollars` divided by the number of merges with non-null `dollars`, rounded to 2 places. `judgeVetoRate` is, over every stage run of `repo` (`listStageRuns(repo, { limit: 100_000 })`) with `stage === "verify"`, a non-null `verdict` and `started_at` in the month, the share whose verdict is `reject`, written exactly as `const vetoes = verdicts.filter((r) => r.verdict === "reject").length;`. `revertRate` is `counts.reverts / merged` and `escapedDefectRate` is `counts.escaped / merged`. Rates are rounded to 3 places.
3. `metricsMarkdown(m)` writes `# Factory metrics, <month>` and a two-column table with one row per field, `n/a` for null, and a closing line saying the escaped-defect count is issues titled `Escaped defect:` and the revert count is merged PRs titled `Revert`.
4. `scripts/metrics-month.ts`: `bun scripts/metrics-month.ts --repo owner/name [--repo ...] --month YYYY-MM [--out metrics.md]`, opened by a three-line comment in the style of `scripts/ledger-public.ts`. Exit 2 with a usage line when no repo or a month not matching `/^\d{4}-\d{2}$/`. For each repo it reads `new FactoryState(defaultStatePath(process.env, repo))` and the two counts with `gh search prs --repo <repo> --merged "<month>-01..<last day>" "Revert in:title" --json number --limit 1000` and `gh search issues --repo <repo> --created "<month>-01..<last day>" "\"Escaped defect:\" in:title" --json number --limit 1000`, summing the array lengths. It writes `metricsMarkdown` to `--out` or stdout. No workflow runs it: the state DB lives on the operator's machine.
5. `tests/metrics-month.test.ts` seeds `new FactoryState(":memory:")` the way `tests/ledger-public.test.ts` does (runs, `factory.pr.merged` bus events, stage runs and `setVerifyVerdict`).

### T6: wire and deliver
Files: `tests/mutations.json`
Model: haiku
Deps: T1, T2, T3, T4, T5
1. `tests/mutations.json` gains the entries from ## Mutation, one per line in the file's existing style, inserted directly after the line whose name is `recheck: a range overlaps a hunk`. Append nothing at the end.
2. Run `make check` and `make check-mutations MUTATION_ARGS="--base origin/main"`; both pass.
3. Delivery: one PR for this plan. The PR body fills every section of the template as this PR changes it, the new `## Confidence` section included. Every commit carries a `Signed-off-by:` line (`git commit -s`). No em dashes in code, comments, docs or the PR body. No file outside ## Files changes. New tests use no `toBeTruthy`, `toBeFalsy`, `toBeDefined`, `toBeUndefined` or `expect.anything()`.

## Tests
- `tests/finding-evidence.test.ts`: [permanent] `validateVerdict` accepts a finding with `evidence: "bun test x fails"` and one with no evidence, and refuses `evidence: ""`, `evidence: "  "` and `evidence: 3` with the reason `a finding's "evidence" must be a non-empty string`; the reviewer agent file and the verify skill each contain the word `evidence` in their finding description.
- `tests/recheck.test.ts`: [permanent] the existing anchor cases still give `[0, 1, 2]`; a finding on a changed line with empty or blank evidence is dropped.
- `tests/risk.test.ts`: [permanent] `ratedRisk` rates `src/auth/session.ts`, `lib/payments.ts`, `billing/invoice.go` and `app/security/csp.ts` high, each with a reason starting `auth, security or money path:`, and rates `src/author.ts` and `docs/billing-faq.md` low.
- `tests/judge-calibration.test.ts`: [permanent] the set has at least 6 real and 6 not-real cases, every case is scored right (`wrong` is `[]`), precision and recall are at least `PRECISION_FLOOR` and `RECALL_FLOOR`, and a rechecker that keeps every finding scores below `PRECISION_FLOOR`.
- `tests/check-pr-body.test.ts`: [permanent] a body with all six sections passes, a bare body names six missing sections, and the template has a `## Confidence` section holding the five layer rows.
- `tests/metrics-month.test.ts`: [permanent] two merges in October and one in September give `merged: 2` for `2026-10`; median, cost per verified change (a merge with an unknown cost is left out of both sum and count), a veto rate of 1 reject out of 4 October verdicts (a September reject is ignored), revert and escaped rates from the counts; a month with no merges gives `null` rates; the Markdown shows `n/a` for null.

## Mutation
```json
{"name":"recheck: a finding needs a reproduction","file":"src/recheck.ts","find":"const reproduced = Boolean(f.evidence?.trim());","replace":"const reproduced = true;","test":"tests/recheck.test.ts"}
```
```json
{"name":"evidence: an empty reproduction is refused","file":"src/artifacts.ts","find":"if (o.evidence !== undefined && (typeof o.evidence !== \"string\" || !o.evidence.trim()))","replace":"if (false)","test":"tests/finding-evidence.test.ts"}
```
```json
{"name":"risk: auth, security and money paths rate high","file":"src/risk.ts","find":"if (sensitive.length) reasons.push(","replace":"if (false) reasons.push(","test":"tests/risk.test.ts"}
```
```json
{"name":"calibration: the score asks the rechecker","file":"src/calibration.ts","find":"const kept = (await rechecker.supported([c.finding], c.diff)).includes(0);","replace":"const kept = true;","test":"tests/judge-calibration.test.ts"}
```
```json
{"name":"metrics: only rejects count as vetoes","file":"dashboard/metrics-month.ts","find":"const vetoes = verdicts.filter((r) => r.verdict === \"reject\").length;","replace":"const vetoes = verdicts.length;","test":"tests/metrics-month.test.ts"}
```

## Acceptance
- AC-1: a review finding has an `evidence` field the schema checks, and a must or should finding with no reproduction is dropped by the recheck before the verdict counts it: checked by `tests/recheck.test.ts` (T1)
- AC-2: the review output schema and both reviewer instructions require file:line plus evidence: checked by `tests/finding-evidence.test.ts` (T1)
- AC-3: a change to an auth, security or money path rates high, so the model review is never its only pass before a merge: checked by `tests/risk.test.ts` (T2)
- AC-4: a labelled calibration set runs in CI and fails when precision or recall drops below the pinned floors: checked by `tests/judge-calibration.test.ts` (T3)
- AC-5: the PR template has a per-layer confidence block that the PR body check requires: checked by `tests/check-pr-body.test.ts` (T4)
- AC-6: a monthly metrics page is generated from run data with merges, time to green, cost per verified change, judge veto rate, revert rate and escaped-defect rate: checked by `tests/metrics-month.test.ts` (T5)

## Non-goals
- NG-1: no live model judge in CI: scoring a model's own findings costs tokens per run and stays manual.
- NG-2: the factory's own PR body (written from `src/engine/steps.ts`, frozen at 593 lines) does not gain a confidence block here; `check-pr-body` already accepts its What changed and Acceptance sections.
- NG-3: no workflow publishes the metrics page; the operator runs the script.
- NG-4: no change to how a red gate or a proof that does not bite stops a run.
- NG-5: no change to `protectedPaths` handling or to `src/merge-autonomy.ts`.

## Files
- `tests/finding-evidence.test.ts` (new)
- `src/calibration.ts` (new)
- `tests/fixtures/judge-calibration/cases.json` (new)
- `tests/judge-calibration.test.ts` (new)
- `dashboard/metrics-month.ts` (new)
- `scripts/metrics-month.ts` (new)
- `tests/metrics-month.test.ts` (new)
- `src/artifacts.ts` (edit: `evidence` on a finding)
- `src/recheck.ts` (edit: a kept finding needs evidence)
- `tests/recheck.test.ts` (edit: evidence cases)
- `src/engine/common.ts` (edit: the dropped-findings note text)
- `template/.claude/agents/factory-reviewer.md` (edit: evidence in How to report)
- `template/.claude/skills/factory-verify/SKILL.md` (edit: evidence in the finding shape)
- `src/risk.ts` (edit: sensitive paths rate high)
- `tests/risk.test.ts` (edit: sensitive path cases)
- `.github/pull_request_template.md` (edit: the Confidence section)
- `tests/check-pr-body.test.ts` (edit: six sections)
- `CONTRIBUTING.md` (edit: the section list)
- `tests/mutations.json` (edit: add the five entries after the recheck entries)
