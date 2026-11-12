TICKET: m4-ci-tools
NEXT: 7991cba1a68bc498a0909ef58384a1ef7367da08
## Ported
- dco -> f97896ed; TestUnsigned, TestDCO (5 sub-cases), TestDCOSkipsMergeCommitsAndNamesEveryBadCommit, TestDCOUsageAndBadRange; TS cases 1 of 1 (`a commit needs a sign-off from its own author`, 5 commits) plus the pre-push hook's refusal path (exit 1, "has no Signed-off-by"). The TS has no dco test file, only that case in tests/licensing.test.ts.
- body -> 3dc9116f; TestBodyProblems (11), TestBodyOneParagraphNamesEverySection, TestBodyPlaceholderVerdicts (11 values), TestTemplateHasConfidenceLayerRows, TestBodyCommand (7); TS cases 11 of 11 in check-pr-body.test.ts plus the 3 `--file`/PR_BODY cases, and the lint case of pr-body-lint.test.ts that exercises the check. 
- tests-only -> 272659e2; TestEveryKindHasAFixtureThatYieldsIt, TestEveryFixtureButCleanFailsWithoutAReasonAndPassesWithOne, TestAFixtureTripsOnlyItsOwnKind, TestCleanYieldsNothing, TestARewrittenAssertionIsNotARemoval, TestAReasonShorterThanTenCharactersIsRefused, TestADeletedTestFileTakesItsPathFromTheASide, TestIsTestFile, TestProblemLines, TestTestsOnlyCommand (6 git-repo cases); TS cases 8 of 8 in check-tests-only.test.ts (the six fixtures are inlined, since tests/ is deleted at cutover).
- 2ecd4d12: errcheck/errorlint fixes, shared helpers in main.go, ratchet raise. Merge 7991cba1 resolved `.ratchet.json` (larger go_lines 41414 after re-measuring, deadcode 404).
## Bite checks
- TestDCO/no_trailer_fails -> `code 0, output "dco: every commit in base..HEAD is signed off\n"; want code 1 containing "has no Signed-off-by for dev@x.io"` (check broken to accept an unsigned commit); TestUnsigned: `unsigned = [], want [b c d]`.
- TestUnsigned with the address compare forced true -> someone-else trailer accepted, test red.
- TestBodyOneParagraph... with the missing-section check disabled -> `got [... "section \"Summary\" is empty" ...], want 6 problems starting with the Summary section`.
- TestBodyCommand/the_sections_come_from_the_template_file with a hard-coded section list -> `stderr "... missing section \"Summary\"..."` (and it no longer names Beta).
- TestBodyPlaceholderVerdicts with the pending/tbd/todo/na branch removed -> `got [], want ["section \"Verify verdict\" is a placeholder"]`.
- TestAReasonShorterThanTenCharactersIsRefused with {9,} loosened to {2,} -> `a 5 character reason was accepted`.
- Removed-assertion check disabled -> `fixture removed-assertion.diff yields [], want it to contain removed-assertion`.
- Skip/loose-matcher check disabled -> `loose-matcher.diff without a reason: [], want more than one line` (same for new-skip.diff).
- Deleted-file path taken from the b side -> `parseDiff = [{Path:tests/b-side.test.ts ...}], want [{Path:tests/gone.test.ts ...}]` (the test's header now uses differing a/b paths, since the TS test could not tell them apart).
- `+++` header lines not skipped -> `Added:[++ /dev/null]` in TestADeletedTestFileTakesItsPathFromTheASide.
- Two-dot instead of three-dot diff -> `TestTestsOnlyCommand/the_diff_is_against_the_merge_base ... code 1, deleted-test: tests/b.test.ts`.
## Workflow lines
- dco: `go run ./tools/prcheck dco "${{ github.event.pull_request.base.sha }}" "${{ github.event.pull_request.head.sha }}"` (needs `fetch-depth: 0`)
- body: `go run ./tools/prcheck body` with `env: PR_BODY: ${{ github.event.pull_request.body }}` (a body file works too: `go run ./tools/prcheck body --file <path>`)
- tests-only: `go run ./tools/prcheck tests-only "${{ github.event.pull_request.base.sha }}" "${{ github.event.pull_request.head.sha }}"` with `env: PR_BODY: ${{ github.event.pull_request.body }}` (needs `fetch-depth: 0`)
- Exit codes: 0 pass, 1 check failed, 2 usage or git error. Needs Go 1.26 (`go-version-file: go.mod`).
## Left out
- No new rules; messages and regexes are the TS ones. `dco` still takes an optional head (default HEAD), as in TS.
- src/engine/pr-body.ts (`prBody`, run-details, receipts) and tests/pr-body.test.ts: runner code, not a PR check; the Go runner owns it.
- tests/hooks.test.ts and tests/licensing.test.ts workflow-text assertions (`bun scripts/dco.ts` in ci.yml, the pre-push hook): `.github/` and the hook scripts are off limits; the local session rewrites them.
- JS-versus-RE2 edges: `.` and `\S` over non-ASCII or CR in the reason line; unchanged otherwise.
- A git failure is exit 2 with a message (TS threw an uncaught error, exit 1).
## Gate evidence
ok  	github.com/KaaS-team/factory/tools/gate	(cached)
ok  	github.com/KaaS-team/factory/tools/prcheck	(cached)
ok  	github.com/KaaS-team/factory/tools/ratchet	(cached)
go_lines 41414 (baseline 41414), deadcode 404 (baseline 404)
rc=0
## Learnings
- The container had Go 1.24; GOTOOLCHAIN=auto fetched 1.26 (first run slow).
- gate.sh takes about 4 min, over the foreground tool limit; run it in the background.
- golangci-lint errcheck and errorlint fail on bare fmt.Fprintf and `err.(*exec.ExitError)`; use helpers and errors.As.
- My retry loop did not stop on a merge conflict; resolve `.ratchet.json` before looping.
- A test helper named like a command function (runBody, runTestsOnly) fails vet with "redeclared".
