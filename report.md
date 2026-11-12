BRANCH: go/cloud-worker
HEAD: 0010f7898492f92dee447a4f6ecee8250aced360
## Summary
Added the factory-cloud-worker skill (branch naming, test-first order, checkpoints, workflow-file ban, report format, plumbing push, final message) and a Go test package that checks every template skill's frontmatter and the report headings.
## Acceptance
- The skill exists and the template test passes on it -> TestCloudWorkerReportHeadings, TestCloudWorkerTextIsClean, TestEverySkillHasFrontmatter/factory-cloud-worker -> done
- The test fails if a heading is removed from the report format in the skill -> TestCloudWorkerReportHeadings (deleted "## Gate evidence" from SKILL.md: "report format is missing [\"## Gate evidence\"]", then restored); TestMissingHeadingsDetectsRemoval covers every heading -> done
- Every existing template skill passes the frontmatter test -> TestEverySkillHasFrontmatter (all 11 skills pass, no failures to list) -> done
- No em dash, model name or claude.ai URL in the skill text -> TestCloudWorkerTextIsClean -> done
## API change requests
none
## Files outside my area
none
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand: gofmt -l (clean), go vet ./... (clean), golangci-lint v2.13.2 ("0 issues."), go test -race ./... (all ok, last lines: ok internal/tracker/vendorkit, ok internal/tracker/jira), CGO_ENABLED=0 go build ./cmd/factory (BUILD_OK).
## Learnings
- No `just` in the cloud image; the brief's by-hand recipe list worked. The image should ship `just`.
- The first golangci-lint run downloads many modules and exceeds the 120s tool timeout; warm the module cache in the image.
- The brief's commit-trailer reminder (session trailer) conflicts with the "no session link or trailer" rule; I followed the brief and added no trailer.
