TICKET: m1-i
NEXT: 4ca40d2d89c0c0825b7fe654aabb3e28bdf2ef85
## Merged
- go/k10-eventlog -> c6d5483
- go/k10-fair -> 1a8510c
- go/k10-infra-classify -> fe3f496
- go/k10-judge-cache -> 095b5fd
- go/k10-migration-packs -> 298a03e
## Skipped
- none
## Review notes
- go/k10-eventlog: clean. Log files are keyed by url.PathEscape of the ticket id, so no path traversal; torn or tampered lines are truncated and kept in a .bad file.
- go/k10-fair: clean.
- go/k10-infra-classify: the `rate_limited` and `Failed to launch` signatures are broad. A test log that merely prints "rate limit" classes as an environment failure and sets GatesGreen to nil, which hides a real red gate. Advisory only; not fixed.
- go/k10-judge-cache: a failed cache write drops a verdict that was already paid for (the error is returned instead of the verdict). Entries are not written atomically, but a torn entry reads as a miss. Not fixed.
- go/k10-migration-packs: the pack is checked against the factory.lock sha256 before it runs, and commands run with no shell. Two risks: `{files}` expands file names that start with `-` into flags (argument injection into the pack's own command), and the default `ExecRunner.Prompt` only prints the prompt and reports the step as "ran". Not fixed.
- Conflicts: THIRD_PARTY_NOTICES.md for k10-fair and k10-infra-classify (kept both sections). docs/cli-reference.md and internal/packs/command.go for k10-migration-packs (both sides kept; the doc was regenerated with UPDATE_GOLDEN=1 go test ./cmd/factory).
## Gate evidence
`just` is not installed, so I ran the justfile's `check` recipe body by hand (gofmt, vet, golangci-lint v2.13.2 via go run under go1.26.7, go test -race, the same with -tags ee, static build, ratchet). The last run was green:
0 issues.
go_lines 29011 (baseline 29011), deadcode 215 (baseline 215)
## Learnings
- `just` is missing in the cloud environment. The preinstalled golangci-lint is built with go1.25 and fails on `go 1.26.0`; use `go run ...golangci-lint@v2.13.2` with GOTOOLCHAIN=go1.26.7.
- A full check takes about 3-4 minutes, and the other sessions push faster than that. migration-packs needed 6 attempts, so the push race, not the gate, set the time.
- `git rebase --rebase-merges` re-conflicts on a merge commit that had conflicts. Redoing the merge on a fresh origin/next was easier, and it was scripted.
- Each merge needed .ratchet.json raised; use the measured values, not the larger of the two sides.
- The commit trailer is `Co-Authored-By: Claude <noreply@anthropic.com>`, with no model name, because the model-name rule overrode the brief's trailer.
