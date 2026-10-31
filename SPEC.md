<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: E2 Reliability
Milestone: Phase 1 reliability
Runner: operator

## Risk: low

## Why
PR #339 merged with "Verify verdict: Pending CI" and no gate evidence, and the PR-body check accepted it because it only tests that sections are non-empty. Issue #352.

## Today
- `scripts/check-pr-body.ts` exports `problems(body, template)`; it requires every template heading to be present and non-empty, and skips all checks for the factory-shaped body. `tests/check-pr-body.test.ts` covers it.

## Change
### T1: reject empty verdicts
Files: `scripts/check-pr-body.ts`, `tests/check-pr-body.test.ts`
Model: sonnet
1. In `problems`, after the heading loop (human-shaped bodies only), read the "Verify verdict" section. Push `section "Verify verdict" is a placeholder` when its text, trimmed and lowercased with punctuation stripped, starts with `pending`, `tbd`, `todo`, `n/a`, `na`, or equals `pass`, `passed`, `ok` or `none`.
2. Read the "Gate evidence" section. Push `section "Gate evidence" has no output` unless it contains a fenced code block or at least one digit.
3. Tests: each placeholder is rejected; "Pending CI" is rejected; a real verdict ("Pass: 412 tests, 0 failures, mutations 3/3 red") is accepted; a gate section with only prose and no digit is rejected; a fenced block is accepted; the factory-shaped body is still exempt.

## Tests
- `tests/check-pr-body.test.ts`: [permanent] the cases above.

## Mutation
```json
{"name":"pr-body: accept pending verdict","file":"scripts/check-pr-body.ts","find":"is a placeholder","replace":"is a placeholder_","test":"tests/check-pr-body.test.ts"}
```
Add one entry per new rule, each `find` matching once in the file as you wrote it.

## Acceptance
- A body with `Verify verdict: Pending CI` fails `check-pr-body` with the placeholder message.
- This PR's own body passes the check.

## Non-goals
Do not touch .github/workflows. No new dependencies. No em dashes, no filler words. Nothing outside Files.

## Files
`scripts/check-pr-body.ts`, `tests/check-pr-body.test.ts`, `tests/mutations.json`

## How to ship
One PR from branch feat/q-verdict. Commits use `git commit -s`. PR body uses every section of .github/pull_request_template.md, filled with real evidence (the gate output, not "pending"). Run `python3 scripts/kaas/check-affected.py --run` before pushing. Each new mutation entry in tests/mutations.json is {name,file,find,replace,test}; its `find` must match exactly once in its file, and the test must fail under the replacement. Never put a session link in a commit or PR.
