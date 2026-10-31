# 0003. One merge at a time per repo

## Status

accepted

## Context

Two pull requests can each pass their gates alone and still break the base branch together. A merge
decision made against the old base is not valid after another merge lands.

## Decision

`serialMerge` in `src/merge-queue.ts` takes a lease for the repo before it does anything else.
`DirLease` takes the lease with `mkdir`, which is atomic, so two runner processes on one host cannot
both hold it. The default lease is a directory named `<owner>__<repo>.merge-lock` under `factory-merge` in the
system temp directory (`src/merge-autonomy.ts`).

Under the lease the queue:

1. Rebases the pull request onto the latest base and gets the new head.
2. If the head moved, returns `rebased` without merging. The next poll runs the gates on the new head.
3. Calls `gated(head)`. In `src/merge-autonomy.ts` this is a check that the head is the one the merge
   decision was made for. If not, returns `not-gated`.
4. Merges that head with `deps.github.mergePr`, which takes the head SHA.

The lease is released in a `finally`, so a failed step does not leave the repo locked.

## Consequences

- At most one pull request for a repo is rebased and merged at a time. A second one gets `busy`.
- A pull request that the rebase moved waits one poll before it can merge. The gates run again on the
  new head during that poll; the queue does not run them itself.
- The lease is local to one host. Two hosts running the runner on the same repo are not covered by
  the directory lease.

## Alternatives considered

- Merge in arrival order without a lease. Rejected: two rebases on the same base can race.
- Merge without rebasing. Rejected: the gates would then have passed on a base that no longer
  matches the one the merge lands on.
