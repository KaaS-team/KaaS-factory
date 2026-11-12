BRANCH: go/k10-migration-packs
HEAD: 9252a426bd2060ad5711612d407fc486c251c45e
## Summary
Tickets #1 and #2 are in `internal/packs/migration`: a YAML migration pack loader with strict schema, and and/or/not file predicates (glob, content regex, manifest dependency with version range) that gate which files each step sees. A new `factory packs migrate <owner/repo#path>` command runs a pack pinned in factory.lock, so the package is reachable from `cmd/factory`. Ticket #3 (scan then edit, per-file deadline, CSV) belongs to another session and is not done here.
## Acceptance
- Loader validates schema; unknown fields rejected -> TestLoadRejects (18 rows, incl. unknown top, step and dependency fields) -> done
- Sample pack (one framework bump) runs end to end -> TestSamplePackRunsEndToEnd (testdata/react-bump.yaml) -> done
- Schema documented -> doc.go, TestSchemaDocumentsEveryField fails if a yaml key is missing from doc.go -> done
- Pack pinned in the lock file -> TestVerify, TestMigrateRefusesUnpinnedOrChangedPack, TestMigrateRunsPinnedPack (workflow entry, sha256 checked) -> done
- Step with no matching files spends zero tokens and logs "skipped: precondition" -> TestStepWithNoMatchingFilesSpendsNothing -> done
- A unit test per predicate -> TestPredicates (28 rows: glob, contains, dependency for package.json and go.mod, version ranges, and, or, not), TestMalformedManifestIsAnError, TestMissingManifestIsFalse, TestVersionParsing -> done
- Meter records files skipped -> TestStepWithNoMatchingFilesSpendsNothing through the `Recorder` interface -> done at the package level. Nothing passes the real meter in yet (see API change requests).
- Ticket #3 -> not started, belongs to another session.
Bite-check: reverted each fix once and watched a test go red: KnownFields in pack and in dependency, the zero-match skip, the meter count, not, or, `**/` glob, contains, version range, the sha256 comparison, the exactly-one-action rule, parent predicate inheritance, and the Verify call in `packs migrate`. All 13 killed.
## API change requests
- A real `meter` recorder for `migration.Recorder` (`Skipped(step string, files int)`) so skipped files reach the ledger. I did not touch internal/meter or internal/api.
- Prompt steps have no agent port. `ExecRunner.Prompt` prints the prompt and file list and succeeds. An `Executor` backed by a dispatcher is the follow-up.
## Files outside my area
- internal/packs/command.go: one line adding `newMigrateCommand()` to `packs`, plus the doc comment, so the code is reachable from cmd/factory.
- internal/packs/migrate.go and migrate_test.go: the `migrate` subcommand. It is in `packs` because `migration` cannot import `packs` back.
- docs/cli-reference.md: regenerated with `UPDATE_GOLDEN=1 go test ./cmd/factory` (TestCLIReferenceFresh failed after the new command).
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand: `gofmt -l` (clean for Go), `go vet ./...` (clean), golangci-lint v2.13.2 (`0 issues.`), `go test -race ./...` (all ok after the docs regeneration; `cmd/factory` ok), `CGO_ENABLED=0 go build ./cmd/factory` (`BUILD OK`). I did not run `just check` as such.
Measures: non-test Go lines 21276 before, 21952 after (+676 including internal/packs wiring; the repo is already over budget and nothing was deleted, because the new package replaces nothing). Deadcode 75 lines before, 70 after (the two counts were taken at different points and the count is noisy because the output includes "go: downloading" lines); 0 entries mention migration.
## Learnings
- `just` missing in the cloud image: the recipes had to be run by hand.
- Adding any cobra command changes docs/cli-reference.md, which is outside every session's area. The brief should name it.
- `go test -race ./...` exceeds the 120s foreground tool timeout; run it in the background.
- The "unreachable from cmd/factory" rule and the "only your package" rule conflict; the brief should say who owns the wiring edit.
