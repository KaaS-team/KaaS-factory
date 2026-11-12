TICKET: m3-fixes-i
NEXT: 24d606fe4507a279e1ed36ca81f9caad31d302b7
## Fixed
- infra-classify hides a red gate -> 562d91f; TestPRBodySeparatesEnvironmentFromTestFailure (rate-limit rows), TestClassifyTable (new rows), TestHasTestFailure. Signatures now anchored to line starts; a red gate whose log has a test-runner failure line is never nulled and gets no environment wording.
- judge-cache drops a paid verdict -> c5b7027; TestUnwritableCacheStillReturnsVerdict, TestWriteLeavesNoTempFiles. Write failure is logged (slog.Warn), verdict returned; temp file + rename in the same dir.
- migration-packs argument injection -> 0f0e197; TestFilesStartingWithDashAreNotFlags, TestDashFileSurvivesRealCommand. Chose the `./` prefix (only for names starting with `-`), since `--` is not accepted by every command.
- migration-packs prompt step reports success -> 12ac6cd; TestDefaultRunnerPromptStepIsNotReportedAsRan, TestExecRunnerPromptHandsOff, TestMigratePromptStepWithoutAgentFails. Default Prompt returns ErrNoAgent ("no agent configured for prompt steps"); the run fails and the step is not Ran.
- Extra commit 24d606f: staticcheck QF1001 fix in firstrun and the .ratchet.json raise (conflicts with other sessions resolved three times, larger values taken).
## Bite checks
- TestUnwritableCacheStillReturnsVerdict -> cache_test.go:114: want verdict despite write failure: {... Pass:false} err=mkdir .../file: not a directory calls=1
- TestPRBodySeparatesEnvironmentFromTestFailure/rate_limit_in_a_failing_test_name_stays_red -> execute_test.go:208: body lacks "Tests failed"
- TestClassifyTable/test_name_mentioning_rate_limit_is_not_rate_limited -> infra_test.go:37: got {Reason:rate_limited Tier:environment} true, want   false
- TestFilesStartingWithDashAreNotFlags -> run_test.go:173: got [rm -rf --force -x/y.go normal.go d/-n] want [rm ./-rf ./--force ./-x/y.go normal.go d/-n]
- TestDefaultRunnerPromptStepIsNotReportedAsRan -> run_test.go:205: want ErrNoAgent, got <nil>
## Not fixed
- None. Left out: signature wording for agent CLIs beyond the strings the existing tests name; `{files}` in docs/doc.go untouched.
## Gate evidence
`just` is not installed, so the check recipe was run by hand on the pushed tree (24d606f): gofmt clean; go vet ./... and -tags ee ok; go test -race ./... and -tags ee: every package ok; build ok; golangci-lint v2.13.2: "0 issues."; ratchet: "go_lines 31068 (baseline 31068), deadcode 233 (baseline 233)". Touched packages also ran with -race -count=3 before the first push.
## Learnings
- Running as root, a chmod read-only cache dir does not fail writes; the test uses a path under a regular file.
- The origin/next ratchet moves on nearly every push; resolve .ratchet.json, push at once, then run the full gate on the pushed tree.
- Do not break a retry loop on `git push | tail`; the pipe hides the exit status.
- Tests leave an untracked internal/a2a/a2a-audit.jsonl that blocks rebases; delete it.
