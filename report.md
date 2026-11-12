TICKET: m1-b2
NEXT: d25139f06221d82673ea8656affb3870d9688dd0
## Merged
- go/k7-assert-kit -> 8f59ed9 (local merge; landed in d25139f)
- go/k7-astgrep-transform, go/k7-autosubmit, go/k8-plan-preset, go/k8-policy-combiner, go/k8-policy-signed: merged on branch m1-b2 and landed in d25139f (all six are ancestors of next)
## Skipped
- none
## Bite checks
- TestCombine/erroring_forbid_fails_closed_and_is_reported -> combiner_test.go:47: Allow = true, want false (forbid-on-error line disabled)
- TestCombine/rule_with_no_matcher_fails_closed -> combiner_test.go:47: Allow = true, want false
- TestExpiredPolicyDenies -> policy_test.go:104: dispatch: {Allow:false RuleID:default-deny ...}, want a denial by expired
- TestLoadSigned/expired -> signed_test.go:58: want a failure and no engine, got &{...}, <nil>
- TestTransformRefusesPathEscape -> transform_test.go:150: id "../../etc/passwd": want ErrRulePath, got ...needs a tests file...: passwd-test.yml (id check disabled); symlinked tests file: want ErrRulePath, got <nil>
- TestTransformRulesDirStaysInTheRepo -> transform_test.go:176: rules "/etc": want an error
- TestAutosubmitGuardFiresWhileLoopGuardIsActive / TestCallCapBreach... -> autosubmit_test.go:81: prs: [] (autosubmit guard feed disabled)
## Review notes
- k7-assert-kit: clean.
- k7-astgrep-transform: rule id was joined into tests/snapshot paths unchecked (path escape, files listed to land); symlinked rule/tests/snapshot files were followed; `rules:` could be absolute or "..". Fixed. No shell use: the AstGrep port is an interface, no implementation in this branch, so real invocation is not yet reviewable.
- k7-autosubmit: conflict resolved as briefed; next had renamed the stuck guard to `loop`, and then next's untrusted `guard` collided with autosubmit's `guard`, so autosubmit's is now `capGuard`. Submit uses `git add -A` in the agent worktree (left as is).
- k8-plan-preset: denylist; FindFileEditingCommand doc now says defence in depth only, sandbox is the boundary.
- k8-policy-combiner: an erroring forbid, a rule with an unknown effect or nil Match was a non-match, so a permit could win (fail-open). Now fails closed.
- k8-policy-signed: ed25519.Verify against a caller-pinned key, key not read from the policy; missing key, sig or mismatch refused. Hole: no expiry. Added optional `expires_at`; LoadSigned refuses an expired policy and Check denies after expiry. A signed policy without expires_at never expires (left as is).
## Gate evidence
0 issues.
go_lines 39077 (baseline 39077), deadcode 380 (baseline 380)
(./gate.sh exit 0 on the landed tree; no `just` on this host, gate.sh used. -race -count=3 passed on every touched package.)
## Learnings
- Four push rejections; ratchet and THIRD_PARTY_NOTICES conflict each time (scripted the ratchet resolution).
- A committed a2a-audit.jsonl on next blocked the merge as an untracked file; removed the local copy.
- Notices "ours" resolution left a stray sanitize line under the wrong section; the provenance test caught it.
- Local go was 1.24; GOTOOLCHAIN=auto fetched 1.26.
