BRANCH: go/k5-browsercheck-lean
HEAD: 6aa189eb12ecb2fc505d53d22f6eb9bcec38b54a
## Summary
browsercheck now waits on events (ready, quiet, network, with a cap) instead of returning right after an action, copies a Chrome profile without caches into a locked temp dir that is swept when stale, and has a `type_secret` step whose value is redacted from every result. Only the browser-use ticket #3 was done; the playwright-mcp ticket #3 was not (see Acceptance).
## Acceptance
- browser-use #3: `settle` with ready/quiet/network conditions and a cap, no fixed sleeps in checks -> TestSettleConditions, TestSettleSinceCountsActionTime, TestNetTracker, TestSettleReplacesFixedSleep (real Chrome), TestNoFixedSleeps -> done. Bite: dropping the Network condition from the step settle turned TestSettleReplacesFixedSleep red.
- browser-use #3: temp profile copy skips the SKIP_COPY dirs; stale dirs swept at start -> TestSkipCopy, TestCopyProfile, TestSweepStale (section 8.6 style startup cleanup), TestRunSweepsAndCleansUp, TestRunProfileCopyIsRemoved -> done. Bite: removing the sweep call in Run, removing "Cache" from the list, and forcing the lock check true each turned their test red.
- browser-use #3: `type_secret(name, id)` never prints the value; redaction before output; domain-scoped -> TestRedactForms, TestRedactBoundaries, TestSecretLookup, TestLoadSecrets, TestParseTypeSecret, TestTypeSecretNeverPrinted (real Chrome) -> done in part. The step is `type_secret: {name, selector}` (selector, not an AX id, since browsercheck has no AX list). Bite: removing Redact on the failure message, removing the domain check, and removing the word-boundary rule each turned their test red. Left out: base64 "cores" (a secret inside a longer base64 string); redaction of memory FTS and screenshots, because browsercheck has no transcript, memory or image path (only the step failure message and the command error carry text); the tool-output path of kaasbot gate belongs to another area.
- playwright-mcp #3 (snapshot mode, verify tools, token counts on 5 fixtures, idle close and RSS) -> blocked: it needs the `@playwright/mcp` child from playwright-mcp ticket #1, which is another session's work, and a token measurement would need a model call, which tests may not make. Not started.
## API change requests
none
## Files outside my area
- `docs/cli-reference.md`: generated; regenerated with `UPDATE_GOLDEN=1 go test ./cmd/factory` because browsercheck gained `--profile` and `--secrets` (TestCLIReferenceFresh).
- `THIRD_PARTY_NOTICES.md`: one `## browser-use/browser-use@dfb6a73` section, as the provenance test requires. Other sessions porting from the same SHA will touch the same section, so expect a merge conflict there.
## Measures
- Non-test Go lines (excluding src/): 20357 before, 20933 after (+576, of which about 450 are the three new files and the rest wiring). Nothing in my area was redundant to delete: `WaitReady("body")` was the only line removed.
- Deadcode: 68 before, 68 after. Everything added is reached from `cmd/factory` through `NewCommand`.
## Gate evidence
`just` is not installed here, so I ran the recipe bodies by hand, chained with `&&`: `gofmt -l`, `go vet ./...`, `GOTOOLCHAIN=go1.26.7 go run .../golangci-lint/v2/cmd/golangci-lint@v2.13.2 run ./...`, `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory`. All five passed with no output from gofmt, vet or lint. Last lines of the race run:
ok  	github.com/KaaS-team/factory/internal/upgrade	1.046s
ok  	github.com/KaaS-team/factory/internal/tutor	1.014s
ok  	github.com/KaaS-team/factory/packs	1.150s
ok  	github.com/KaaS-team/factory/pkg/agentrun	1.043s
ok  	github.com/KaaS-team/factory/pkg/sandbox	1.257s
Chrome tests ran against /usr/bin/google-chrome via a PATH symlink; they skip where Chrome is missing.
## Learnings
- A `git checkout <file>` to undo a bite-check mutation also wiped my uncommitted edits to that file; copy the file aside first.
- Upstream settle does not track timers, so a bare setTimeout render is not waited on; the realistic fixture is a fetch, which the network condition covers.
- `just` is missing in the cloud image; install it, or the brief should say to run the recipe bodies.
- `docs/cli-reference.md` is a generated file that any new flag breaks; the brief should list it as an allowed edit.
