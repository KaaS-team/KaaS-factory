<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: E1 Finish reliability
Milestone: Phase 1 reliability
Runner: operator

## Risk: medium

## Why
Two verify-stage slices of the reliability runner. R2d: the verdict heading and its round count are written by the model today, so a comment can say "pass" over a JSON that says "reject", or name the wrong round; and a rebuilt change is verified with no memory of what the last reject asked for, so a pass can quietly drop an open finding. The runner should own the heading and track the last reject's findings until verify marks each resolved. R5b (#116, folded into #190): the three most common reject causes are fixed in the runner: a proof that fails only to compile is never a pass (21 rejects), a reject whose only findings are `should` goes to a human instead of a rebuild (19), and files changed outside a planned issue's plan trigger one rebuild that lists them (17).

## Today
- `src/engine/steps.ts` verify step (305-461), frozen at 593 lines in `quality-baseline.json` (comments baseline 2). After `runStage` (411) it validates `verdict.json` (413), sets `let json = checked?.ok ? { ...checked.verdict, rounds: ctx.rejectRound + 1 } : undefined;` (414), runs `recheckFindings` (415-420, which drops findings not on changed lines and turns a reject with no blocking finding into uncertain), then `if (json) deps.state.setVerifyVerdict(config.repo, issueNumber, json.result);` (421). It posts `` `${art.comment}${recheckNote}` `` with `{ stage: "verify", json }` at 431-432 (uncertain or no verdict) and 445-446, and on reject sets `ctx.failure = failureTail(art.comment ?? JSON.stringify(json.findings, null, 2));` (449). `readRunJson` (463-469) is the only user of `import { readFileSync } from "node:fs";` (line 7). `StepCtx` is exported at line 81. `sc.issue` is the issue as read when the run started; comments posted during the run are not in it.
- `template/.claude/skills/factory-comment/assets/verdict.md` starts `<!-- factory:verdict v1 -->` then `## Verdict: {{pass|reject|uncertain}}`, and ends with a `{{#if reject}}` block "Sending back to build (round {{round}} of 2) with the findings above." Nothing in `src/` parses `## Verdict`. `tests/agents.test.ts:518` requires the template to contain `{{pass|fail|unverified}}`.
- `src/rehydrate.ts` (50 lines) writes each stage's JSON and visible comment into the run dir from the thread's markers before a stage runs. It writes nothing about earlier verdicts' findings or operator answers.
- `src/artifacts.ts:102` `VERDICT_KEY_LIST = ["result", "rounds", "findings", "criteria", "outcome", "summary"]`; `validateVerdict` (~186-231) refuses any other top-level key. `src/schemas.ts` builds the verify schema from that list with types from `typesOf.verify` (62-67).
- `src/proof.ts`: `ProofStatus` (line 14) is `"bites" | "passes-without" | "no-tests" | "skipped" | "unavailable"`; `runProof` returns `{ status: result.code === 0 ? "passes-without" : "bites", reverted: [...existing, ...added], tests, cmd, exitCode: result.code, tail }`, where `added` are files the change added and `existing` files it modified. `src/run-summary.ts:18` has `PROOF_LINE: Record<ProofStatus, string>`.
- `template/.claude/skills/factory-verify/SKILL.md` body is 89 lines; `tests/skills.test.ts` fails at 90. Its line "- `passes-without`: the tests pass without the change, so prove nothing: reject." and "and (on reject) which round this is." are the places to edit.
- `tests/mutations.json` entries whose `find` must keep matching exactly once: in `steps.ts` `if (deps.proofGit) {`, `    clearRunFiles(worktree, runDir(issueNumber));\n`, `if (ownAcceptance && !acceptanceProven(ownAcceptance)) {`, `planAcceptance(acceptance, readRunJson<PlanArtifact>(worktree, issueNumber, "plan.json"))`, `deps.state.setSetting(sealKey(`, `import { ShellSetupRunner } from "../setup";`; in `src/proof.ts` `status: result.code === 0 ? "passes-without" : "bites"`; in the verify SKILL.md `diff did not introduce (the base`, `[enforced: stop-artifact.sh]`, `` `.claude/skills/factory-verify/references/ui-route.md` and ``.
- `tests/scenarios.test.ts` sets `git.changed` to files a planner plan lists; the off-plan rule must not fire on planner plans.

## Change
### T1: verdict rules module and the proof's compile-only status
Files: `src/engine/verdict-rules.ts`, `src/proof.ts`, `src/run-summary.ts`, `src/artifacts.ts`, `src/schemas.ts`, `tests/verdict-rules.test.ts`
Model: opus
1. `src/proof.ts`: add `"compile-only"` to `ProofStatus`. Add `const COMPILE_ERROR = /Cannot find module|Could not resolve|error TS\d+|SyntaxError|ModuleNotFoundError|ImportError/;` and an exported `classifyProof(proof: ProofResult, added: number): ProofResult` whose body is this exact line: `return proof.status === "bites" && added === 0 && COMPILE_ERROR.test(proof.tail) ? { ...proof, status: "compile-only" } : proof;` with a comment that a revert that fails only to compile shows the code exists, not what it does (#116). Wrap the `runProof` return object in `classifyProof({ ... }, added.length)`, leaving the `status: result.code === 0 ? "passes-without" : "bites",` line as it is.
2. `src/run-summary.ts`: add `"compile-only": "compile-only: the new test failed without the change only because the tree did not compile"` to `PROOF_LINE`.
3. `src/artifacts.ts`: add `"prior"` to `VERDICT_KEY_LIST`; add `readonly prior?: readonly { what: string; status: "resolved" | "open" }[]` to `VerdictArtifact`; in `validateVerdict`, when `v.prior` is present it must be an array of objects with only `what` (non-empty string) and `status` (`resolved` or `open`), else `bad(...)` with a message naming `prior`. `src/schemas.ts` `typesOf.verify` gains `prior: { type: "array", items: { type: "object" } },`.
4. Create `src/engine/verdict-rules.ts`. It imports `type StepCtx` from `./steps` (type only) and exports:
   - `readRunJson<T>(worktree, issueNumber, name)`, moved unchanged from `steps.ts` with its `readFileSync` import.
   - `verdictHeading(result: string, round: number, limit: number): string`, with this exact line: `const suffix = result === "reject" ? \` (round ${round} of ${limit})\` : "";` returning `` `## Verdict: ${result}${suffix}` ``.
   - `withVerdictHeading(comment: string, heading: string): string`: drop every line that starts with `<!-- factory:verdict` or with `## Verdict`, trim leading blank lines, and return `<!-- factory:verdict v1 -->`, the heading, a blank line, then the rest.
   - `verdictPost(comment: string, verdict: VerdictArtifact | undefined, round: number, limit: number): string`: the comment unchanged when `verdict` is undefined or has no `result`; else `withVerdictHeading` with `verdictHeading(verdict.result, round, limit)`, followed, when any object finding has `where === "runner"`, by `### Runner findings` and one `- <what>` line each.
   - `applyVerdictRules(verdict, facts: { proof?: ProofStatus; plan?: { files?: string[]; source?: string }; changed: string[]; offPlanSent: boolean }): VerdictArtifact`, three rules in this order, each runner finding being `{ severity: "must", confidence: 5, what, where: "runner" }`:
     a. compile-only: `if (facts.proof === "compile-only" && verdict.result === "pass")` the result becomes `reject` with the finding "The proof failed only because the reverted tree does not compile; add a test that fails on the change's behaviour without it."
     b. off-plan: only when `facts.plan?.source === "issue"`; `off` is `facts.changed` minus `.factory/` paths minus `facts.plan.files`. `if (off.length > 0 && !facts.offPlanSent)` the result becomes `reject` with the finding `` `Files changed outside the plan: ${off.join(", ")}` `` (keep that prefix exactly; a later round detects it).
     c. should-only: this exact line: `if (verdict.result === "reject" && verdict.findings.length > 0 && verdict.findings.every((f) => typeof f !== "string" && f.severity !== "must")) return { ...verdict, result: "uncertain" };` (biome may wrap it; keep the text so the mutation below still finds `verdict.findings.every((f) => typeof f !== "string" && f.severity !== "must")`).
   - `applyPriorFindings(verdict: VerdictArtifact, prior: readonly string[]): VerdictArtifact`: `open` is each prior `what` whose entry in `verdict.prior` is missing or not `resolved`; this exact line: `if (open.length > 0 && verdict.result === "pass") return { ...verdict, result: "uncertain" };`, adding a `could` finding with `where: "runner"` naming the open items.
   - `async settleVerdict(sc: StepCtx, verdict: VerdictArtifact): Promise<VerdictArtifact>`: return `verdict` unchanged when `verdict.outcome` is `blocked` or `failed`. Read `proof.json`, `plan.json` and `prior-findings.json` with `readRunJson`; `changed` from `sc.deps.git.changedFiles(sc.worktree, sc.config.base)`; `offPlanSent` is true when a module `WeakSet<RunCtx>` has `sc.ctx`, or a trusted `verify` data marker in `sc.issue.comments` has a finding starting "Files changed outside the plan:". Apply `applyVerdictRules` then `applyPriorFindings`. If the result has an off-plan finding, add `sc.ctx` to the set. Then keep `prior-findings.json` in the run dir: on `reject`, write the `what` of every string finding and every `must` finding; on `pass`, remove the file; otherwise leave it.
5. Create `tests/verdict-rules.test.ts` with unit tests for every export above and for `classifyProof` (a compile error tail with `added` 0 is `compile-only`; with `added` 1, or a behavioural failure tail, stays `bites`), and for `validateVerdict` accepting a valid `prior` and refusing a bad `status`.

### T2: the verify step posts the runner's verdict, and verify reads prior findings
Files: `src/engine/steps.ts`, `quality-baseline.json`, `src/rehydrate.ts`, `tests/rehydrate.test.ts`, `tests/verdict-rules.test.ts`, `tests/mutations.json`
Model: sonnet
Deps: T1
1. `src/engine/steps.ts`: delete `import { readFileSync } from "node:fs";` and the `readRunJson` function at the end of the file; add `import { readRunJson, settleVerdict, verdictPost } from "./verdict-rules";`. Keep line 414 as it is. Directly after the recheck block and before `setVerifyVerdict`, add `if (json) json = await settleVerdict(sc, json);`, then `const posted = art.comment && \`${verdictPost(art.comment, json, ctx.rejectRound + 1, maxRejects)}${recheckNote}\`;`. Replace both two-line `if (art.comment)` / `await postComment(... \`${art.comment}${recheckNote}\` ...)` statements with `if (posted) await postComment(deps, config, issueNumber, posted, { stage: "verify", json });`, and change the reject line to `ctx.failure = failureTail(posted || JSON.stringify(json.findings, null, 2));`.
2. Run `wc -l src/engine/steps.ts` and set its line baseline in `quality-baseline.json` to that exact number (it shrinks, about 585); leave its comments baseline at 2 unless `tests/quality.test.ts` reports otherwise.
3. `src/rehydrate.ts`: after the stage loop, find the newest verify data marker whose JSON has a `result`. If that result is `reject`, let `prior` be the `what` of each string finding and each `must` finding, and write it with this exact line, where `priorPath` is `${dir}/prior-findings.json`: `if (prior.length > 0 && !existsSync(priorPath)) await Bun.write(priorPath, JSON.stringify(prior, null, 2));` (an existing file was written by `settleVerdict` in this run and is newer than the issue snapshot). Then collect every trusted human comment (`isHumanComment`) whose `parseChatOps(body).type === "answer"`, oldest first, and when there is at least one write `operator-answers.md` with each answer's text separated by a blank line and a `---` line. Write neither file when there is nothing to write.
4. `tests/rehydrate.test.ts`: tests that a thread whose last verdict is a reject writes `prior-findings.json` with its must findings only; a last verdict of pass, or a holdout-only verify marker after a pass, writes none; an existing `prior-findings.json` is left alone; trusted plain comments become `operator-answers.md` and `/factory` commands, runner comments and untrusted comments do not.
5. `tests/verdict-rules.test.ts`: add engine tests with `engine()` from `tests/engine-harness.ts`: a verify output whose comment carries a model `## Verdict: pass` heading and whose JSON is a reject with only `should` findings ends at `needs-human`, and the posted verify comment starts with `<!-- factory:verdict v1 -->` then `## Verdict: uncertain`, with no model heading left; a plain reject posts `## Verdict: reject (round 1 of <limit>)`, the next build's resume failure text contains that heading, and the second verify run finds `prior-findings.json` in its run dir.
6. Add the entries under Mutation to `tests/mutations.json`, directly after the entry named "proof: no test gate is unavailable, not skipped".

### T3: templates the verifier reads
Files: `template/.claude/skills/factory-comment/assets/verdict.md`, `template/.claude/skills/factory-verify/SKILL.md`, `tests/verdict-rules.test.ts`
Model: sonnet
Deps: T2
1. `verdict.md`: remove the `## Verdict: {{pass|reject|uncertain}}` line and the three-line `{{#if reject}}` block; keep the first line `<!-- factory:verdict v1 -->` and everything else, `{{pass|fail|unverified}}` included.
2. Verify `SKILL.md`, without growing the body past 89 lines and keeping the three `find` texts listed under Today: in step 1, name `prior-findings.json` (the last reject's findings) and `operator-answers.md` (what a human answered) as inputs; tell the verifier to list each prior finding in `verdict.json` as `"prior": [{ "what": "...", "status": "resolved" }]` with `resolved` or `open`; change the `passes-without` line to cover `compile-only` too ("`passes-without` or `compile-only`: no test shows what the change does: reject."); and replace "and (on reject) which round this is." with a sentence saying to leave out the `## Verdict` heading and the round, because the runner writes both. Merge or shorten existing lines to stay within the limit.
3. `tests/verdict-rules.test.ts`: a test that the verify SKILL.md contains `prior-findings.json`, `operator-answers.md`, `"prior"` and `compile-only`, and that `verdict.md` contains no `## Verdict` and no `round {{round}}`.

## Tests
- `tests/verdict-rules.test.ts`: [permanent] the heading and its round come from the runner; compile-only proofs never pass; a should-only reject goes to a human; off-plan files on a planned-issue plan reject once; an open prior finding stops a pass; the verify step posts the settled verdict; the templates match.
- `tests/rehydrate.test.ts`: [permanent] prior findings and operator answers are rebuilt from the thread.
- `tests/quality.test.ts`: [permanent] existing; `src/engine/steps.ts` shrinks to its new baseline.
- `tests/skills.test.ts`, `tests/agents.test.ts`: [permanent] existing; the verify skill stays under 90 lines and the verdict template keeps its per-criterion status.
- `tests/scenarios.test.ts`, `tests/proof.test.ts`: [permanent] existing; planner plans and the proof's other statuses are unchanged.

## Mutation
```json
{"name": "verdict: the runner drops the reject round", "file": "src/engine/verdict-rules.ts", "find": "const suffix = result === \"reject\" ? ` (round ${round} of ${limit})` : \"\";", "replace": "const suffix = \"\";", "test": "tests/verdict-rules.test.ts"}
```
```json
{"name": "verdict: an open prior finding still passes", "file": "src/engine/verdict-rules.ts", "find": "if (open.length > 0 && verdict.result === \"pass\") return { ...verdict, result: \"uncertain\" };", "replace": "", "test": "tests/verdict-rules.test.ts"}
```
```json
{"name": "verdict: a should-only reject rebuilds", "file": "src/engine/verdict-rules.ts", "find": "verdict.findings.every((f) => typeof f !== \"string\" && f.severity !== \"must\")", "replace": "false", "test": "tests/verdict-rules.test.ts"}
```
```json
{"name": "verdict: a compile-only proof passes", "file": "src/engine/verdict-rules.ts", "find": "if (facts.proof === \"compile-only\" && verdict.result === \"pass\")", "replace": "if (false)", "test": "tests/verdict-rules.test.ts"}
```
```json
{"name": "verdict: off-plan files never rebuild", "file": "src/engine/verdict-rules.ts", "find": "if (off.length > 0 && !facts.offPlanSent)", "replace": "if (false)", "test": "tests/verdict-rules.test.ts"}
```
```json
{"name": "proof: a compile error counts as a bite", "file": "src/proof.ts", "find": "proof.status === \"bites\" && added === 0 && COMPILE_ERROR.test(proof.tail)", "replace": "false", "test": "tests/verdict-rules.test.ts"}
```
```json
{"name": "verify: the step posts the model's verdict unsettled", "file": "src/engine/steps.ts", "find": "if (json) json = await settleVerdict(sc, json);", "replace": "", "test": "tests/verdict-rules.test.ts"}
```
```json
{"name": "rehydrate: prior findings are not rebuilt", "file": "src/rehydrate.ts", "find": "if (prior.length > 0 && !existsSync(priorPath)) await Bun.write(priorPath, JSON.stringify(prior, null, 2));", "replace": "", "test": "tests/rehydrate.test.ts"}
```

## Acceptance
- AC-1: the posted verdict heading and round come from the runner, and the three reject-cause rules and the prior-finding rule hold: checked by `make test FILES=tests/verdict-rules.test.ts` (T1)
- AC-2: the proof's other statuses are unchanged: checked by `make test FILES=tests/proof.test.ts` (T1)
- AC-3: the verify step posts the settled verdict, and `steps.ts` shrinks to its baseline: checked by `make test FILES="tests/verdict-rules.test.ts tests/quality.test.ts"` (T2)
- AC-4: prior findings and operator answers are rebuilt from the thread: checked by `make test FILES=tests/rehydrate.test.ts` (T2)
- AC-5: planner-plan scenarios still ship: checked by `make test FILES=tests/scenarios.test.ts` (T2)
- AC-6: the verify skill and verdict template pass the skill rules and say the runner writes the heading: checked by `make test FILES="tests/skills.test.ts tests/agents.test.ts tests/verdict-rules.test.ts"` (T3)
- AC-7: the types still check: checked by `make typecheck` (T2)

## Non-goals
- NG-1: no change to `src/engine/recheck` logic, `src/engine/common.ts`, `src/config.ts` or `src/state.ts`; the rules run after the recheck.
- NG-2: the off-plan rule applies only to plans imported from a planned issue (`source: "issue"`); planner plans are unchanged.
- NG-3: the repo's own `.claude/skills/factory-verify/SKILL.md` copy is not updated here.
- NG-4: no change to how many rejects a workflow allows (`workflow.limits.rejects`).
- NG-5: do not touch `.github/workflows`. Keep the PR body to the repo's PR template with its sign-off lines; one PR for this spec; no em dashes in code, comments, templates or the PR; no file outside Files below.

## Files
- `src/engine/verdict-rules.ts` (new)
- `tests/verdict-rules.test.ts` (new)
- `src/engine/steps.ts` (edit: settle and post the runner's verdict; `readRunJson` moved out)
- `quality-baseline.json` (edit: `src/engine/steps.ts` to its new size)
- `src/proof.ts` (edit: `compile-only` status, `classifyProof`)
- `src/run-summary.ts` (edit: `compile-only` proof line)
- `src/artifacts.ts` (edit: `prior` in the verdict)
- `src/schemas.ts` (edit: `prior` type)
- `src/rehydrate.ts` (edit: `prior-findings.json`, `operator-answers.md`)
- `tests/rehydrate.test.ts` (edit: prior findings and operator answers)
- `template/.claude/skills/factory-comment/assets/verdict.md` (edit: heading and round removed)
- `template/.claude/skills/factory-verify/SKILL.md` (edit: prior findings, operator answers, compile-only, runner heading)
- `tests/mutations.json` (edit: add the eight entries)
