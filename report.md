BRANCH: go/transform-checks
HEAD: d9ae587f2b91c5eed23c343259e0c454d9f2e15f
## Summary
Added packs/checks/ast-grep-residue (check.sh) that scans each rule file in the configured rules dir and prints a FACTORY_GATES line with residue=<n>. migration, framework-upgrade and dep-upgrade now run a residue check node after the gate check and before verify.
## Acceptance
- Fake ast-grep printing two matches fails, none passes, missing binary fails with install hint -> TestResidueCheck (plus TestResidueRequiresRulesDir) -> done
- Three workflows load and have the residue check before verify -> TestTransformWorkflowsCheckResidueBeforeVerify -> done
## API change requests
none
## Files outside my area
none (new files: packs/residue_test.go, packs/checks/ast-grep-residue/check.sh)
## Gate evidence
just is not installed; ran recipe bodies by hand: gofmt clean, go vet ok, golangci-lint v2.13.2 "0 issues.", go test -race ./... all ok, CGO_ENABLED=0 build ok (binary not left in tree).
Bite proof: changed the failure threshold in check.sh, the tests went red; restored.
## Learnings
- Rules dir is read from .factory/config.json residue.rules (needs jq) or RESIDUE_RULES; the brief did not name the key. Gate line appends residue=<n> after failed_gates so gate.Parse still reads it.
- Match counting assumes ast-grep --json=stream, one non-empty line per match; the fake binary in tests does the same.
- git checkout of a half-edited workflow file discarded my edit; redo cost a step.
