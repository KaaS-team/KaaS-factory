BRANCH: go/k8-policy-combiner
HEAD: 9793ef4662d29a3bdd6a2ca8bba834cfe2aabde7
## Summary
Added a generic deny-overrides combiner (`Combine`) in ee/policy/combiner.go with table tests. Nothing in cmd/factory calls it yet, so it is unreachable until the existing Engine.Check is wired to it.
## Acceptance
- any matching forbid denies -> TestCombine/"forbid beats permit" -> done
- no match denies -> TestCombine/"no match denies" -> done
- erroring rule is a non-match and reported -> TestCombine/"erroring forbid...", "erroring permit...", "error beside matching forbid still denies" -> done
- response lists deciding rule ids -> Combined.Determining, asserted in every row -> done
- table tests cover permit, forbid, error, empty set -> done
Bite-checks (reverted each fix, tests went red): forbid branch disabled (2 rows fail), error recording removed (3 rows fail), permit ids dropped (2 rows fail).
Found already there: ee/policy/policy.go Engine.Check (YAML rules, deny before allow, default-deny) and guard.go audit. They have no per-rule errors or determining-rule list, so I added the combiner beside them and did not change them.
## API change requests
none
## Files outside my area
none
## Gate evidence
just is not installed; ran its recipes by hand: gofmt clean, go vet (with and without ee), go test -race ./... and -tags ee ./... all ok, CGO_ENABLED=0 go build rc=0. golangci-lint and deadcode were not confirmed (not run to completion); the combiner is unreachable from cmd/factory so deadcode will list it. Non-test Go lines before: 21276, after: about 21335 (+68).
## Learnings
- just was missing; the gate recipes should be runnable without it.
- Wiring Combine into Engine.Check needs an edit to policy.go, outside this ticket's area; the brief's "reachable from cmd/factory" and "only combiner.go" conflict.
