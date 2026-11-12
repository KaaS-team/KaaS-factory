BRANCH: go/k8-sanitize
HEAD: 84b7ac024796e2070a3b6c26723652ac01d56c4d
## Summary
New `internal/tracker/sanitize` with `Prompt` (claude-code-action steps plus five token formats) and `Publication` (gh-aw slices: URL allowlist, mentions, bot triggers, XML and template delimiters, homoglyphs, truncation). Prompt is applied where briefs are built (reconcile, core Dispatch and start); Publication on github, linear and jira `Comment` unless the ctx came from `marker.Allow`.
## Acceptance
- gh-aw #1 URL allowlist redaction with userinfo stripping -> TestPublication url rows, TestCustomAllowedDomains -> done
- @mention and bot-trigger neutralization, cap configurable -> TestPublication mention rows, TestBotTriggerCap -> done
- XML comment/tag and template delimiter neutralization -> TestPublication xml/template rows -> done
- homoglyph hardening -> TestPublication (entity, zero width, fullwidth, homoglyph, tag chars, bidi) -> done (no NFC/NFKC, see below)
- length and line truncation -> TestTruncation -> done
- Go fuzz target never panics -> FuzzPublication (seeds run in `go test`; a local 40s fuzz run found no crash, but the worker stalled at 0 execs/s after a few seconds; 200k random inputs ran clean under a 500ms-each timer) -> done, with that caveat
- MIT notice in file headers -> headers plus THIRD_PARTY_NOTICES.md, provenance test passes -> done
- Tests "derived from upstream sanitize_content*.test.cjs" -> rows written from the upstream behaviour I read, not a mechanical conversion of the .test.cjs files -> partial
- claude-code-action #1: hidden comment, zero-width, bidi, alt text, link title, data-attr, numeric entity, five token formats -> TestPromptSteps -> done
- Applied at the single prompt-building entry point -> TestBriefTextIsSanitized (Tick path via reconcile, manual Dispatch via core) -> done, but there are three builders, not one (see Learnings)
- kaasbot channel send -> blocked: that repo is not reachable here. `Publication` is exported for it.
- Bite-check: each fix reverted once; every listed rule and each hook (reconcile, core control, github, linear, jira) turned a test red. Two mutants first survived or only failed to compile, and I strengthened TestNestedEncodingFailsClosed and re-ran them.
## API change requests
none
## Files outside my area
- internal/reconcile/run.go, internal/core/control.go: one `sanitize.Prompt` call each at the brief builders.
- internal/core/sanitize_test.go: new test for those two hooks.
- internal/marker/marker.go and marker_test.go: removed `Neutralise` and its test; the github hook replaced its only caller (deadcode).
- internal/tracker/github/tracker_test.go, loop_test.go: expectations changed from the visible `&lt;!--` text to the marker being dropped. Deliberate behaviour change: hidden comments are removed rather than shown.
- internal/tracker/linear and jira tests: the marker-carrying test now uses `marker.Allow`. `PutSpendComment` in both also uses `marker.Allow` so ledger markers survive.
- THIRD_PARTY_NOTICES.md: two sections.
## Gate evidence
`just` is not installed; I ran the recipe bodies by hand, with `go vet ./...`, golangci-lint v2.13.2 on `./...`, `go test -race ./...`, the same with `-tags ee`, and `CGO_ENABLED=0 go build ./cmd/factory`. Last lines of the run:
ok  	github.com/KaaS-team/factory/pkg/agentrun	(cached)
ok  	github.com/KaaS-team/factory/pkg/sandbox	(cached)
GATE-OK
Measures: non-test Go lines 21276 before, 22148 after (+872). Deadcode 70 before, 70 after (it was 71 until `marker.Neutralise` was removed).
## Learnings
- The brief assumes one prompt entry; there are three (reconcile/run.go, core/control.go, core/stage.go). One shared brief constructor would be better.
- core/stage.go passes `ticket` to `RenderPrompt` but `graph.KnownVars` only allows `issue`, so stage prompts can never render ticket text today. I left stage.go untouched; whoever fixes the variable name must call `sanitize.Prompt` there.
- Not ported: NFC/NFKC (golang.org/x/text is only an indirect dependency and the ticket does not name it), command and cross-repo reference neutralization, code-region balancing, the scheme-less www tag-aware scanner (replaced by a simple regex), and the full link-title state machine (regex version).
- Go regexp has no lookaround, so the https, AWS and ANSI boundary rules are hand-coded; the JWT segment bound of 2000 is unbounded because RE2 caps repeats at 1000.
- The line budget is 8000 and the repo is over it; this port adds about 870 lines.
- The file viewer turns `\uXXXX` escapes into raw characters, which broke compilation and lint; check with grep for raw invisibles.
- A mutation run in the same tree as a test run gives false failures; do not run them concurrently.
