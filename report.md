BRANCH: go/k4-template-worker
HEAD: 30fecef00354d35b9c29f3d0a5fe74a7dfa2bdf0
## Summary
The factory-cloud-worker skill and its Go test already existed on next; this adds the draft PR step, a test that pins the work and report branch formats the observer reads, and removes the one template skill that duplicates a blueprint skill.
## Acceptance
- Go test in internal/template checks every skill has name and description front matter, and the worker skill names the report branch format -> TestEverySkillHasFrontmatter, TestCloudWorkerNamesObserverBranches (failed first, then passed) -> done
- Duplicates of blueprint skills deleted, each listed -> deleted template/.claude/skills/factory-plan-rubric (duplicates blueprint plan-critic, per plan.md 1a); nothing else in template/ duplicates the other 7 blueprint skills -> done
## API change requests
none
## Files outside my area
none
## Gate evidence
just is missing, so I ran the recipe bodies by hand: gofmt -l, go vet, golangci-lint v2.13.2 (go1.26.7), go test -race ./..., CGO_ENABLED=0 go build ./cmd/factory. All passed (last lines: ok github.com/KaaS-team/factory/pkg/sandbox 1.319s).
Measures: non-test Go lines 20357 before and after; deadcode lines 73 before, unchanged after (no non-test Go changed).
## Learnings
- just is not installed in the cloud image; the factory default image should include it.
- The ticket's skill and test were partly shipped already; briefs should say what exists on next.
- The TS tree under src/ and tests/ still mentions factory-plan-rubric; it is frozen, so I left it.
