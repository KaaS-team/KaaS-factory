BRANCH: go/k8-policy-signed
HEAD: 816a5d26c2299b8428664b9c80d8f743f6d73f13
## Summary
Policy rules files (ee) and factory.lock (packs) now load only when a detached ed25519 signature verifies against a configured key; a bad, missing or keyless load fails closed. Policy load now reports every bad rule in one error. The CEL type-check and cost-limit line is blocked: the tree has no CEL engine and the brief allows no new dependency.
## Acceptance
- Policy files load only when signature verifies against a configured key -> TestLoadSigned/valid, TestReadLockSigned/valid -> done
- Bad or missing signature fails closed with a clear error -> TestLoadSigned/{missing signature,wrong key,edited after signing,no key}, TestReadLockSigned/{missing signature,wrong key,signature of other content,not base64,no key configured}, TestParsePublicKey -> done
- Load fails listing all bad rules -> TestLoadSigned/all bad rules listed (4 problems across 3 rules in one error) -> done, for the existing YAML rule checks only
- Every CEL rule type-checks against a declared env and has a cost limit at load -> blocked. `ee/policy` has YAML rules (effect, roles, repos, actions, max_usd) and no CEL; ticket 1 (the CEL combiner) belongs to another session, and cel-go is not named as a dependency. Nothing was written for it.
Bite-checks (each fix reverted, test went red): skipping ed25519.Verify (wrong key, other content, no key rows fail); tolerating a missing .sig file (missing signature row fails); dropping the empty-key guard (panics in ed25519.Verify); Parse stopping at the first bad rule (all bad rules listed fails).
Wire format: signature file is `<path>.sig`, base64 of an ed25519 signature over the file's exact bytes. Public key is base64 of the 32 raw bytes.
## API change requests
None to internal/api. Wiring request for `cmd/factory/ee.go` (outside my area, not edited): read the key from an env var such as FACTORY_POLICY_KEY via `policy.ParsePublicKey`, and make `loadPolicy` call `policy.LoadSigned(path, key)` when it is set. For packs, the lock readers in `internal/packs/command.go` should call `ReadLockSigned` when a key is configured. Until then the new exports are unreachable from `cmd/factory`.
## Files outside my area
- ee/policy/policy.go: `Parse` now collects every bad rule through a new `Rule.problems` instead of returning the first. Needed for "lists all bad rules"; the existing tests still pass.
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand: gofmt -l, go vet (plain and -tags ee), golangci-lint v2.13.2 under go1.26.7 (plain and ee tags), go test -race (plain and -tags ee), CGO_ENABLED=0 go build. All exited zero; the tail of the test run:
ok  	github.com/KaaS-team/factory/pkg/agentrun	1.017s
ok  	github.com/KaaS-team/factory/pkg/sandbox	1.252s
Measures:
- Non-test Go lines, before 21276, after 21372 (+96: signed.go 42 in packs, 24 in ee, tests excluded, plus the Parse refactor).
- Deadcode lines, before 70, after 72 (default build); before 86, after 90 (-tags ee). The increase is the new exports waiting on the cmd wiring above.
No code was ported from upstream, so no THIRD_PARTY_NOTICES entry. The ticket's copy list (OPA sign.go, verify.go, keys.go) was not used because the stdlib ed25519 check is about 15 lines.
## Learnings
- The brief assumed a CEL policy engine on `next`; it is YAML. Check the tree before accepting a ticket that names a type the tree lacks.
- A "smallest hook" that lives in `internal/packs` and a loader in `cmd/` cannot both be out of bounds and reachable; the brief should name the cmd edit or allow it.
- `just` is absent in cloud sessions; the gate needs a script fallback.
