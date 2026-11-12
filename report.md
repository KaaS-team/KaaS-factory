BRANCH: go/k2f-tutor
HEAD: ba57569b2ad7012a5f690c81f38fffb4f550bf2c
## Summary
Added `internal/tutor/`: `Policy.Next` picks the tier per attempt (student within budget, teacher after, teacher review when enabled, lesson flag on a teacher reject) and `Lesson.Render` writes the retro-format lessons line, tier names only.
## Acceptance
- Next table: every branch -> TestNext (10 rows) -> done
- Lesson render golden; no model-name pattern -> TestLessonGolden, TestLessonHasNoModelName -> done
## API change requests
none
## Files outside my area
none
## Gate evidence
`just` is not installed; I ran the recipe bodies by hand: gofmt clean, go vet clean, golangci-lint v2.13.2 "0 issues.", go test -race ./... all ok, CGO_ENABLED=0 go build ok (BUILD_OK).
## Learnings
- `just` missing in the cloud image; baking it in would save the manual recipe run.
- The brief's `tutor.Next(history)` has no policy argument, so I made it a method `Policy.Next(history)`.
- The brief says teacher verifies and the author never grades its own work; I resolved it as: teacher-built attempts get no teacher review.
- I did not run `just fast`/mutation checks as separate steps; test-first red was a build failure (package absent), not a per-branch mutation.
- Lint run takes over 2 minutes cold (module downloads); the 120s foreground timeout needs a background run.
