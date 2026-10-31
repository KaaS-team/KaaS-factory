# 0005. Issues that plan the same files wait for each other

## Status

accepted

## Context

Two issues that each plan a change to the same file can both build and open pull requests. The
second pull request then conflicts with the first and is built again.

## Decision

`holdForOverlap` in `src/overlap.ts` compares an issue's planned files with those of every issue that
is in flight. An issue is in flight when it carries one of `factory:building`, `factory:verifying`,
`factory:in-review` or `factory:overlap`. The planned files come from the newest trusted plan's data
marker.

The check runs where a plan becomes a build. `src/engine/runner.ts` calls it on the edge from `plan`
to `build`. `src/watch.ts` calls it when a human approves a resume into a `build` step from
`factory:awaiting-approval`. When an
issue overlaps, it moves to `factory:overlap`, gets one comment that names the shared files and the
issue they share with, and waits.

Only a lower-numbered issue can block. Two overlapping issues therefore never wait on each other.

## Consequences

- A later issue waits until the earlier one leaves flight, which happens when its pull request merges
  or closes.
- The check reads the planned files, so a plan that names too few files lets an overlap through.
- Each held issue is counted once, with the first blocker named and a count of the rest.

## Alternatives considered

- Compare the diffs after the build. Rejected: the build cost has already been paid.
- Block on any open issue with the same label. Rejected: unrelated files would wait.
