TICKET: m1-j2
NEXT: 85a0c170475d5dec3bc0dc42478deb5d3a7e576e
## Merged
- go/k10-retry -> 4d5e7d9
- go/k10-scan-edit -> 4d0abbb
- go/k10-traces -> d5f76b4
- go/k11-graph-checkpoint -> 41e2fb1
- go/k11-graph-interrupt -> 7da304b
- go/k11-store-crypt -> 3778cd0
- go/k9-scim -> 65667f9
- go/k7-trajectory -> 93d8cf0
- Two merges of origin/next after push rejections: f2b18fd (a real conflict, see Review notes) and 85a0c17 (pushed).
All eight branches are ancestors of origin/next.
## Skipped
- none
## Bite checks
- provenance `TestNoticeNamingMissingFileOrHeaderIsReported` -> with the reverse check removed: `no problem reported for pkg/gone.go: ["pkg/wrong.go: ported from c/d@7654321 but THIRD_PARTY_NOTICES.md has no ..."]` (also none for pkg/bare.go)
- interrupt `TestConcurrentResumeAnswersOnce` -> with `AND response IS NULL` removed: `round 0: want one success and one ErrNothingPending, got <nil> and <nil>`
- scim `TestPatchRefusesEmptyDisplayName` -> with the empty check disabled: `patch displayName "": status 200, want 400`
## Review notes
- k10-retry: stale `pkg/retry/jitter.go` notice line removed. New reverse check in internal/provenance (every file a notice bullet names exists, and a Go file carries the matching `Ported from repo@sha` header). It found two existing misfilings on next, both fixed in THIRD_PARTY_NOTICES.md: the three internal/eval/grade files sat under coder/agentapi instead of SWE-bench, and internal/tracker/sanitize/prompt.go sat under dagger instead of claude-code-action. Retry's `Jitter` field is gone from vendorkit.Client; nothing else used it.
- k10-scan-edit: clean. Not fixed: Config.Files joined to Root without a containment check (operator input, so low risk).
- k10-traces: conflicts resolved as briefed (eval check + replay, both imports); cli-reference regenerated, diff is only the new command. Not fixed: exported `eval.Replay` dereferences `Triggered` without a nil check (safe only for lines from trace.Read, which validates); trace file is created with default 0666-under-umask permissions.
- k11-graph-checkpoint: clean. Note: it and the thread-position restore that landed on next (d14b2dc) are two restart mechanisms; stageOf now tries memory, then the checkpoint store (when Stages.Checkpoints is set), then the thread position, then the graph start. No test covers both set at once.
- k11-graph-interrupt: BUG fixed. Resume read the pending row and updated it without checking it was still unanswered, so two racing answers both succeeded and the second replaced the first. The update now requires `response IS NULL` and returns ErrNothingPending otherwise. Not fixed: core.answer swallows ErrNothingPending, so a resume with no stored interrupt skips schema validation.
- k11-store-crypt: AES-256-GCM, fresh random 12 byte nonce per Put, AAD binds thread, id and type, key file must be 0600 and never comes from argv, decrypt errors carry no plaintext. No nonce reuse and no hand-rolled compare. Risk, left alone because it is the documented design: a row whose Type lacks the `+aesgcm` tag is returned as plaintext, so anyone with write access to the database can swap in an unauthenticated row. A strict mode that refuses untagged rows would close it.
- k9-scim: BUG fixed. PATCH replace of displayName accepted "" and whitespace, which Create and Replace reject; it now returns 400 and leaves the group unchanged. Tenant ownership checks and constant-time token compare are fine. New dependency elimity-com/scim is pinned to a pseudo-version dated 2026-11-12, so it is brand new.
- k7-trajectory (never reviewed before): conflicts resolved, eval check kept next to replay, stats and compare. Not fixed: FileName maps "a/b" and "a-b" to the same file, so one trajectory silently overwrites the other; Load's Replay compares the last step diff to the checksum but never the `submission` field, so editing `submission` alone is not detected, and a file with a submission but no step diff fails to load.
## Gate evidence
./gate.sh on 85a0c17 (fmt, vet, lint, test with and without ee, build, ratchet), exit 0:
ok  	github.com/KaaS-team/factory/tools/gate	1.036s
ok  	github.com/KaaS-team/factory/tools/ratchet	(cached)
go_lines 37327 (baseline 37327), deadcode 340 (baseline 340)
## Learnings
- `just` was missing; used ./gate.sh. Go 1.24 host needed GOTOOLCHAIN=auto, which downloaded 1.26 fine.
- The gate takes about 4.5 minutes, and next moved twice during it, so I pushed straight after a merge plus build, vet and race tests on core, and ran the full gate again on the pushed tree.
- Parallel sessions put bullets under the wrong notice heading when git keeps both sides; the new reverse check now catches that.
- The test suite creates internal/a2a/a2a-audit.jsonl; it is tracked (empty) on next, so I left it as is.
- The commit trailer in the brief names a model; I used a neutral `Co-Authored-By: Claude <noreply@anthropic.com>` because the rules also forbid model names in commits. The two clean merges git auto-committed (k11-store-crypt) carry no trailer.
