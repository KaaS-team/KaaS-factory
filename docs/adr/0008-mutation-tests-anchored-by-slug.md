# 0008. Mutation tests are anchored to a file and a slug

## Status

accepted

## Context

`make check-mutations` checks that each check bites: it breaks one line of source and the named test
must go red. A mutation entry that stops matching its source line would silently guard nothing. The
list also grew too large for one file, so it had to be split.

## Decision

Each mutation is one JSON object with `name`, `file`, `find`, `replace` and `test`, stored in its own
file `tests/mutations/<slug>.json`. The slug comes from `mutationSlug` in `scripts/mutation-list.ts`:
lower-case the name, turn each run of characters outside `a-z0-9` into one dash, trim dashes at both
ends, cap the result at 80 characters, and trim a trailing dash. `shardPath` builds the path.

The old `tests/mutations.json` is still read, so entries can move one at a time.

`loadMutations` refuses:

- a shard file that is not a mutation object,
- a shard whose file name is not `shardPath` of its own `name`,
- a name listed twice across the old file and the shards.

Each entry is checked twice:

- `anchorProblems` in `scripts/check-mutation-anchors.ts` (run by `make check-anchors`) requires that
  `find` occurs exactly once in `file`, and that `find` is not empty.
- `check` in `scripts/check-mutations.ts` requires the same count, then runs the test on a clean copy
  first. If that run fails, the entry is reported. Next it writes `replace` in place of `find`, runs
  the test with `--bail`, and requires a non-zero exit. A zero exit means the test guards nothing.
  The file is restored afterwards.

With `--base`, `selectMutations` in `scripts/mutation-select.ts` runs only the entries a diff reaches:
entries whose shard, source file, test or inputs changed, plus every entry when the old list changed
and no base list exists to compare against.

## Consequences

- A mutation whose anchor drifts fails the cheap anchor check before any test runs.
- Renaming an entry moves its file, and `loadMutations` fails until the file is renamed to match.
- `.github/workflows/mutations.yml` runs `make check-mutations` on pull requests (with a base), on
  pushes to `main` that touch `tests/`, `src/`, the check script or the workflow, and nightly at
  03:17 UTC.
- Every run prints, and writes to the job's step summary, one result: how many mutations ran, how many
  held and which did not. A pull request runs only the entries its diff reaches, so the job fails when
  a mutation it touches no longer turns its test red.
- Owner step: the job blocks a merge only once it is required. In the repository settings, add the
  `check-mutations` check of the `mutations` workflow under Branch protection, Require status checks.

## Alternatives considered

- Keep one `tests/mutations.json`. Rejected: the list grew too large for one file.
- Match an entry by position or free-form name only. Rejected: a drifted anchor would then guard
  nothing without any check failing.

## Where in the code

- `scripts/mutation-list.ts`: `mutationSlug`, `shardPath`, `loadMutations`, `shardText`.
- `scripts/check-mutations.ts`: `check`, `runTest`, `cleanRun`.
- `scripts/check-mutation-anchors.ts`: `anchorProblems`, `readRepoFile`.
- `scripts/mutation-select.ts`: `selectMutations`.
- `scripts/split-mutations.ts`: moves the old list into one file per entry (an operator step, run once).
- `tests/mutations/*.json`: one entry per file (139 files on origin/main).
- `tests/mutations.json`: the old list, still read.
- `Makefile`: the `check-mutations` and `check-anchors` targets.
- `.github/workflows/mutations.yml`: the pull request, push and nightly triggers.
